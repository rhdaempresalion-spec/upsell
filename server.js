// ═══════════════════════════════════════════════════════════════
//  DHR Lead Capture System - Backend Server
//  Captura leads pagos da DHR e envia para CRM via webhook
// ═══════════════════════════════════════════════════════════════

require('dotenv').config();
const express = require('express');
const Database = require('better-sqlite3');
const fetch = require('node-fetch');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const path = require('path');
const http = require('http');

// ─── Config ───
const CONFIG = {
  port: process.env.PORT || 3000,
  dhr: {
    baseUrl: process.env.DHR_BASE_URL || 'https://app.dhrtecnologialtda.com/api/v1',
    publicKey: process.env.DHR_PUBLIC_KEY,
    secretKey: process.env.DHR_SECRET_KEY,
  },
  crm: {
    webhookUrl: process.env.CRM_WEBHOOK_URL,
  },
  pollInterval: (parseInt(process.env.POLL_INTERVAL) || 30) * 1000,
  autoSendCRM: process.env.AUTO_SEND_CRM !== 'false',
  webhookSecret: process.env.WEBHOOK_SECRET || '',
};

// ─── Database Setup ───
const db = new Database(path.join(__dirname, 'leads.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    customer_name TEXT,
    customer_email TEXT,
    customer_phone TEXT,
    customer_document TEXT,
    product TEXT,
    amount REAL,
    payment_method TEXT,
    status TEXT,
    dhr_status TEXT,
    created_at TEXT,
    received_at TEXT DEFAULT (datetime('now')),
    sent_to_crm INTEGER DEFAULT 0,
    sent_at TEXT,
    crm_response TEXT,
    raw_data TEXT
  );

  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT,
    message TEXT,
    data TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
  CREATE INDEX IF NOT EXISTS idx_transactions_sent ON transactions(sent_to_crm);
  CREATE INDEX IF NOT EXISTS idx_transactions_created ON transactions(created_at DESC);
`);

// Prepared statements
const stmts = {
  insertTx: db.prepare(`
    INSERT OR IGNORE INTO transactions 
    (id, customer_name, customer_email, customer_phone, customer_document, 
     product, amount, payment_method, status, dhr_status, created_at, raw_data)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  updateTxCRM: db.prepare(`
    UPDATE transactions SET sent_to_crm = 1, sent_at = datetime('now'), crm_response = ? WHERE id = ?
  `),
  getTx: db.prepare('SELECT * FROM transactions WHERE id = ?'),
  getAllTx: db.prepare('SELECT * FROM transactions ORDER BY created_at DESC LIMIT ?'),
  getPaidNotSent: db.prepare("SELECT * FROM transactions WHERE status = 'paid' AND sent_to_crm = 0"),
  getStats: db.prepare(`
    SELECT 
      COUNT(*) as total,
      SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) as paid,
      SUM(CASE WHEN sent_to_crm = 1 THEN 1 ELSE 0 END) as sent,
      SUM(CASE WHEN status = 'paid' THEN amount ELSE 0 END) as revenue
    FROM transactions
  `),
  insertLog: db.prepare('INSERT INTO logs (type, message, data) VALUES (?, ?, ?)'),
  getLogs: db.prepare('SELECT * FROM logs ORDER BY created_at DESC LIMIT ?'),
  getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
  setSetting: db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)'),
};

// ─── Logger ───
function log(type, message, data = null) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${type.toUpperCase()}] ${message}`);
  try { stmts.insertLog.run(type, message, data ? JSON.stringify(data) : null); } catch(e) {}
  broadcast({ type: 'log', payload: { type, message, time: timestamp, data } });
}

// ─── WebSocket ───
let wss;
const clients = new Set();

function broadcast(data) {
  const msg = JSON.stringify(data);
  clients.forEach(ws => {
    if (ws.readyState === 1) ws.send(msg);
  });
}

// ─── DHR API Service ───
const DHR = {
  headers() {
    return {
      'Authorization': `Bearer ${CONFIG.dhr.secretKey}`,
      'X-Public-Key': CONFIG.dhr.publicKey,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
  },

  // Tenta múltiplos formatos de endpoint comuns em gateways BR
  async fetchTransactions(page = 1, status = 'paid') {
    const endpoints = [
      `/transactions?page=${page}&status=${status}`,
      `/transactions?page=${page}&filter[status]=${status}`,
      `/charges?page=${page}&status=${status}`,
      `/payments?page=${page}&status=${status}`,
      `/orders?page=${page}&status=${status}`,
      `/sales?page=${page}&status=${status}`,
    ];

    for (const endpoint of endpoints) {
      try {
        const url = `${CONFIG.dhr.baseUrl}${endpoint}`;
        log('info', `Tentando: ${url}`);

        const res = await fetch(url, {
          method: 'GET',
          headers: this.headers(),
          timeout: 15000,
        });

        if (res.ok) {
          const data = await res.json();
          log('success', `API respondeu com sucesso: ${endpoint}`, { status: res.status });

          // Salva endpoint que funcionou
          stmts.setSetting.run('working_endpoint', endpoint.split('?')[0]);
          return data;
        }

        if (res.status === 401) {
          log('error', 'Autenticação falhou - verifique as chaves API');
          return null;
        }

        log('info', `Endpoint ${endpoint} retornou ${res.status}, tentando próximo...`);
      } catch (e) {
        log('info', `Endpoint ${endpoint} falhou: ${e.message}`);
      }
    }

    log('error', 'Nenhum endpoint da DHR respondeu. Verifique a documentação da API.');
    return null;
  },

  // Buscar transação individual
  async fetchTransaction(txId) {
    try {
      const res = await fetch(`${CONFIG.dhr.baseUrl}/transactions/${txId}`, {
        headers: this.headers(),
      });
      if (res.ok) return await res.json();
    } catch(e) {}
    return null;
  },

  // Normaliza dados da transação (adapta diferentes formatos de API)
  normalizeTransaction(raw) {
    // Tenta adaptar diferentes formatos de payload
    const tx = raw.data || raw.transaction || raw.charge || raw.payment || raw;

    return {
      id: tx.id || tx.transaction_id || tx.charge_id || tx.payment_id || `dhr_${Date.now()}`,
      customer_name: tx.customer?.name || tx.buyer?.name || tx.payer?.name || tx.name || '',
      customer_email: tx.customer?.email || tx.buyer?.email || tx.payer?.email || tx.email || '',
      customer_phone: tx.customer?.phone || tx.customer?.phone_number || tx.buyer?.phone || tx.phone || tx.customer?.cellphone || '',
      customer_document: tx.customer?.document || tx.customer?.cpf || tx.customer?.document_number || tx.buyer?.cpf || '',
      product: tx.product?.name || tx.items?.[0]?.name || tx.description || tx.product_name || '',
      amount: (tx.amount || tx.value || tx.total || tx.price || 0) / (tx.amount > 1000 ? 100 : 1), // detecta centavos
      payment_method: tx.payment_method || tx.method || tx.type || 'unknown',
      status: this.normalizeStatus(tx.status || tx.payment_status || ''),
      dhr_status: tx.status || '',
      created_at: tx.created_at || tx.paid_at || tx.date || tx.createdAt || new Date().toISOString(),
    };
  },

  normalizeStatus(s) {
    const str = String(s).toLowerCase();
    if (['paid', 'approved', 'confirmed', 'completed', 'captured', 'autorizado', 'pago', 'aprovado'].some(k => str.includes(k))) return 'paid';
    if (['refund', 'reversed', 'estornado', 'reembolsado'].some(k => str.includes(k))) return 'refunded';
    if (['pending', 'waiting', 'pendente', 'aguardando', 'processing'].some(k => str.includes(k))) return 'pending';
    if (['failed', 'denied', 'declined', 'negado', 'recusado', 'falhou'].some(k => str.includes(k))) return 'failed';
    if (['cancelled', 'canceled', 'cancelado'].some(k => str.includes(k))) return 'cancelled';
    return 'unknown';
  },
};

// ─── CRM Service ───
const CRM = {
  buildPayload(tx) {
    return {
      event: 'venda_paga',
      timestamp: new Date().toISOString(),
      lead: {
        nome: tx.customer_name,
        email: tx.customer_email,
        telefone: tx.customer_phone,
        documento: tx.customer_document,
      },
      transacao: {
        id: tx.id,
        produto: tx.product,
        valor: tx.amount,
        metodo_pagamento: tx.payment_method,
        data_pagamento: tx.created_at,
        status: tx.status,
      },
      metadata: {
        source: 'dhr_gateway_integration',
        gateway: 'dhr_tecnologia',
        server: 'dhr-lead-capture',
        auto_sent: true,
        sent_at: new Date().toISOString(),
      },
    };
  },

  async send(tx) {
    try {
      const payload = this.buildPayload(tx);
      log('info', `Enviando lead para CRM: ${tx.customer_name} (${tx.id})`);

      const res = await fetch(CONFIG.crm.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        timeout: 15000,
      });

      const responseText = await res.text().catch(() => '');

      if (res.ok) {
        stmts.updateTxCRM.run(responseText || 'ok', tx.id);
        log('success', `✓ Lead enviado ao CRM: ${tx.customer_name} - R$ ${tx.amount}`);
        broadcast({ type: 'lead_sent', payload: { id: tx.id } });
        return true;
      } else {
        log('error', `CRM respondeu ${res.status}: ${responseText.substring(0, 200)}`);
        return false;
      }
    } catch (e) {
      log('error', `Erro ao enviar para CRM: ${e.message}`);
      return false;
    }
  },

  async sendBatch(transactions) {
    let sent = 0;
    for (const tx of transactions) {
      const ok = await this.send(tx);
      if (ok) sent++;
      await new Promise(r => setTimeout(r, 500)); // rate limit
    }
    return sent;
  },
};

// ─── Transaction Processor ───
function processTransaction(raw) {
  const tx = DHR.normalizeTransaction(raw);

  // Salva no banco
  const result = stmts.insertTx.run(
    tx.id, tx.customer_name, tx.customer_email, tx.customer_phone,
    tx.customer_document, tx.product, tx.amount, tx.payment_method,
    tx.status, tx.dhr_status, tx.created_at, JSON.stringify(raw)
  );

  if (result.changes > 0) {
    log('success', `Nova transação: ${tx.customer_name} - R$ ${tx.amount} [${tx.status}]`);
    broadcast({ type: 'new_transaction', payload: tx });
    return tx;
  }

  return null; // já existia
}

async function processAndSend(raw) {
  const tx = processTransaction(raw);
  if (tx && tx.status === 'paid' && CONFIG.autoSendCRM) {
    await CRM.send(tx);
  }
  return tx;
}

// ─── Polling Engine ───
let pollTimer = null;
let isPolling = false;

async function doPoll() {
  if (isPolling) return;
  isPolling = true;

  try {
    log('info', 'Consultando DHR Gateway...');
    const data = await DHR.fetchTransactions();

    if (data) {
      // Tenta extrair array de transações de diferentes formatos de resposta
      const transactions = data.data || data.transactions || data.charges ||
        data.payments || data.items || data.results ||
        (Array.isArray(data) ? data : []);

      if (Array.isArray(transactions) && transactions.length > 0) {
        let newCount = 0;
        for (const raw of transactions) {
          const tx = await processAndSend(raw);
          if (tx) newCount++;
        }
        log('info', `Poll completo: ${newCount} nova(s) de ${transactions.length} transação(ões)`);

        // Verifica paginação
        const totalPages = data.meta?.last_page || data.pagination?.total_pages || data.total_pages || 1;
        const currentPage = data.meta?.current_page || data.pagination?.current_page || 1;
        if (currentPage < totalPages && currentPage < 5) {
          log('info', `Buscando página ${currentPage + 1} de ${totalPages}...`);
          // Recursive poll for next page
          const nextData = await DHR.fetchTransactions(currentPage + 1);
          if (nextData) {
            const nextTxs = nextData.data || nextData.transactions || [];
            for (const raw of nextTxs) await processAndSend(raw);
          }
        }
      } else {
        log('info', 'Nenhuma transação na resposta');
      }
    }
  } catch (e) {
    log('error', `Erro no polling: ${e.message}`);
  }

  isPolling = false;
  broadcast({ type: 'poll_complete' });
}

function startPolling() {
  if (pollTimer) return;
  doPoll();
  pollTimer = setInterval(doPoll, CONFIG.pollInterval);
  log('info', `🟢 Polling iniciado (intervalo: ${CONFIG.pollInterval / 1000}s)`);
  broadcast({ type: 'polling_status', payload: { active: true } });
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  log('info', '🔴 Polling parado');
  broadcast({ type: 'polling_status', payload: { active: false } });
}

// ─── Express App ───
const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ──────────────────────────────────
// WEBHOOK ENDPOINTS (DHR → Server)
// ──────────────────────────────────

// Webhook principal - recebe notificações da DHR
app.post('/webhook/dhr', async (req, res) => {
  try {
    const event = req.body;
    log('info', `Webhook recebido: ${event.type || event.event || 'unknown'}`, event);

    // Validação de assinatura (se configurado)
    if (CONFIG.webhookSecret) {
      const signature = req.headers['x-webhook-signature'] ||
        req.headers['x-signature'] ||
        req.headers['authorization'];
      // Implementar validação conforme documentação da DHR
    }

    // Extrai tipo do evento
    const eventType = (event.type || event.event || '').toLowerCase();

    // Eventos de pagamento aprovado
    const paidEvents = [
      'transaction.paid', 'transaction.approved', 'transaction.completed',
      'payment.paid', 'payment.approved', 'payment.confirmed',
      'charge.paid', 'charge.completed',
      'order.paid', 'order.completed',
      'sale.completed', 'sale.approved',
      'invoice.paid',
    ];

    if (paidEvents.some(e => eventType.includes(e.split('.')[1]) || eventType === e)) {
      const tx = await processAndSend(event.data || event);
      if (tx) {
        log('success', `✓ Webhook processado: ${tx.customer_name} - R$ ${tx.amount}`);
      }
    } else if (eventType.includes('refund') || eventType.includes('chargeback')) {
      const tx = processTransaction(event.data || event);
      log('info', `Reembolso/chargeback recebido: ${tx?.id}`);
    } else {
      // Tenta processar mesmo sem tipo reconhecido
      const raw = event.data || event;
      if (raw.status || raw.payment_status) {
        await processAndSend(raw);
      }
      log('info', `Evento não mapeado processado: ${eventType}`);
    }

    res.status(200).json({ received: true, processed: true });
  } catch (e) {
    log('error', `Erro no webhook: ${e.message}`);
    res.status(200).json({ received: true, error: e.message });
  }
});

// Webhook alternativo (alguns gateways usam /callback)
app.post('/webhook/callback', (req, res) => {
  req.url = '/webhook/dhr';
  app.handle(req, res);
});

// ──────────────────────────────────
// API ENDPOINTS (Frontend → Server)
// ──────────────────────────────────

// Dashboard stats
app.get('/api/stats', (req, res) => {
  const stats = stmts.getStats.get();
  res.json({
    total: stats.total || 0,
    paid: stats.paid || 0,
    sent: stats.sent || 0,
    pending_send: (stats.paid || 0) - (stats.sent || 0),
    revenue: stats.revenue || 0,
    polling: !!pollTimer,
    auto_send: CONFIG.autoSendCRM,
  });
});

// Listar transações
app.get('/api/transactions', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 200, 1000);
  const rows = stmts.getAllTx.all(limit);
  res.json({ data: rows, total: rows.length });
});

// Listar pendentes de envio
app.get('/api/transactions/pending', (req, res) => {
  const rows = stmts.getPaidNotSent.all();
  res.json({ data: rows, total: rows.length });
});

// Enviar lead individual para CRM
app.post('/api/transactions/:id/send-crm', async (req, res) => {
  const tx = stmts.getTx.get(req.params.id);
  if (!tx) return res.status(404).json({ error: 'Transação não encontrada' });
  if (tx.sent_to_crm) return res.json({ success: true, message: 'Já enviado' });

  const ok = await CRM.send(tx);
  res.json({ success: ok, message: ok ? 'Enviado com sucesso' : 'Falha no envio' });
});

// Enviar todos pendentes para CRM
app.post('/api/transactions/send-all', async (req, res) => {
  const pending = stmts.getPaidNotSent.all();
  if (pending.length === 0) return res.json({ success: true, sent: 0, message: 'Nenhum pendente' });

  log('info', `Enviando ${pending.length} leads em lote para CRM...`);
  const sent = await CRM.sendBatch(pending);
  res.json({ success: true, sent, total: pending.length });
});

// Reenviar para CRM
app.post('/api/transactions/:id/resend-crm', async (req, res) => {
  const tx = stmts.getTx.get(req.params.id);
  if (!tx) return res.status(404).json({ error: 'Transação não encontrada' });

  // Reset status
  db.prepare('UPDATE transactions SET sent_to_crm = 0, sent_at = NULL WHERE id = ?').run(req.params.id);
  const ok = await CRM.send(tx);
  res.json({ success: ok });
});

// Controle do polling
app.post('/api/polling/start', (req, res) => {
  startPolling();
  res.json({ success: true, active: true });
});

app.post('/api/polling/stop', (req, res) => {
  stopPolling();
  res.json({ success: true, active: false });
});

app.post('/api/polling/trigger', async (req, res) => {
  await doPoll();
  res.json({ success: true });
});

// Toggle auto-send
app.post('/api/settings/auto-send', (req, res) => {
  CONFIG.autoSendCRM = req.body.enabled !== false;
  stmts.setSetting.run('auto_send', String(CONFIG.autoSendCRM));
  log('info', `Auto-envio CRM: ${CONFIG.autoSendCRM ? 'ATIVADO' : 'DESATIVADO'}`);
  res.json({ success: true, auto_send: CONFIG.autoSendCRM });
});

// Atualizar intervalo de polling
app.post('/api/settings/poll-interval', (req, res) => {
  const seconds = Math.max(10, Math.min(300, parseInt(req.body.seconds) || 30));
  CONFIG.pollInterval = seconds * 1000;
  stmts.setSetting.run('poll_interval', String(seconds));
  if (pollTimer) {
    stopPolling();
    startPolling();
  }
  log('info', `Intervalo de polling atualizado: ${seconds}s`);
  res.json({ success: true, interval: seconds });
});

// Logs
app.get('/api/logs', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const rows = stmts.getLogs.all(limit);
  res.json({ data: rows });
});

// Limpar dados (dev)
app.post('/api/reset', (req, res) => {
  db.exec('DELETE FROM transactions; DELETE FROM logs;');
  log('info', 'Banco de dados limpo');
  res.json({ success: true });
});

// Testar conexão com CRM
app.post('/api/test-crm', async (req, res) => {
  try {
    const testPayload = {
      event: 'test',
      timestamp: new Date().toISOString(),
      lead: { nome: 'Teste Sistema', email: 'teste@sistema.com', telefone: '5511999999999' },
      transacao: { id: 'test_' + Date.now(), produto: 'Teste', valor: 0, status: 'test' },
      metadata: { source: 'dhr_lead_capture_test' },
    };

    const r = await fetch(CONFIG.crm.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(testPayload),
      timeout: 10000,
    });

    const text = await r.text().catch(() => '');
    res.json({ success: r.ok, status: r.status, response: text.substring(0, 500) });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Testar conexão com DHR
app.post('/api/test-dhr', async (req, res) => {
  try {
    const data = await DHR.fetchTransactions(1);
    res.json({ success: !!data, data: data ? 'Conectado' : 'Sem resposta' });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── HTTP + WebSocket Server ───
const server = http.createServer(app);
wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  clients.add(ws);
  log('info', `WebSocket conectado (${clients.size} clientes)`);

  // Envia estado atual
  const stats = stmts.getStats.get();
  ws.send(JSON.stringify({
    type: 'init',
    payload: {
      polling: !!pollTimer,
      auto_send: CONFIG.autoSendCRM,
      stats: stats,
    },
  }));

  ws.on('close', () => {
    clients.delete(ws);
  });
});

// ─── Start ───
server.listen(CONFIG.port, () => {
  console.log('');
  console.log('  ╔═══════════════════════════════════════════════════╗');
  console.log('  ║   ⚡ DHR Lead Capture System                     ║');
  console.log('  ╠═══════════════════════════════════════════════════╣');
  console.log(`  ║   Dashboard:  http://localhost:${CONFIG.port}              ║`);
  console.log(`  ║   Webhook:    http://localhost:${CONFIG.port}/webhook/dhr   ║`);
  console.log(`  ║   API:        http://localhost:${CONFIG.port}/api/stats     ║`);
  console.log(`  ║   WebSocket:  ws://localhost:${CONFIG.port}/ws             ║`);
  console.log('  ╠═══════════════════════════════════════════════════╣');
  console.log(`  ║   DHR URL:    ${CONFIG.dhr.baseUrl.substring(0,40).padEnd(40)}║`);
  console.log(`  ║   Auto CRM:   ${String(CONFIG.autoSendCRM).padEnd(40)}║`);
  console.log(`  ║   Poll:       ${(CONFIG.pollInterval/1000 + 's').padEnd(40)}║`);
  console.log('  ╚═══════════════════════════════════════════════════╝');
  console.log('');

  log('info', 'Servidor iniciado');

  // Restaura configurações salvas
  const savedAutoSend = stmts.getSetting.get('auto_send');
  if (savedAutoSend) CONFIG.autoSendCRM = savedAutoSend.value === 'true';

  // Inicia polling automaticamente
  if (CONFIG.autoSendCRM) {
    startPolling();
  }
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nEncerrando...');
  stopPolling();
  db.close();
  server.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  stopPolling();
  db.close();
  server.close();
  process.exit(0);
});
