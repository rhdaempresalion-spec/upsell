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
const fs = require('fs');

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

// ─── Find index.html (multiple paths for different deploy envs) ───
function findIndexHtml() {
  const candidates = [
    path.join(__dirname, 'public', 'index.html'),
    path.join(process.cwd(), 'public', 'index.html'),
    path.join(__dirname, 'index.html'),
    path.join(process.cwd(), 'index.html'),
    '/app/public/index.html',
    '/app/index.html',
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        console.log(`[INDEX] Found at: ${p}`);
        return fs.readFileSync(p, 'utf-8');
      }
    } catch (e) {}
  }
  console.log('[INDEX] Not found in any path, using embedded fallback');
  return null;
}

let INDEX_HTML = findIndexHtml();

// ─── Database Setup ───
const dbPath = process.env.DB_PATH || path.join(__dirname, 'leads.db');
const db = new Database(dbPath);
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
  CREATE INDEX IF NOT EXISTS idx_tx_status ON transactions(status);
  CREATE INDEX IF NOT EXISTS idx_tx_sent ON transactions(sent_to_crm);
  CREATE INDEX IF NOT EXISTS idx_tx_created ON transactions(created_at DESC);
`);

const stmts = {
  insertTx: db.prepare(`INSERT OR IGNORE INTO transactions (id, customer_name, customer_email, customer_phone, customer_document, product, amount, payment_method, status, dhr_status, created_at, raw_data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  updateTxCRM: db.prepare(`UPDATE transactions SET sent_to_crm = 1, sent_at = datetime('now'), crm_response = ? WHERE id = ?`),
  getTx: db.prepare('SELECT * FROM transactions WHERE id = ?'),
  getAllTx: db.prepare('SELECT * FROM transactions ORDER BY created_at DESC LIMIT ?'),
  getPaidNotSent: db.prepare("SELECT * FROM transactions WHERE status = 'paid' AND sent_to_crm = 0"),
  getStats: db.prepare(`SELECT COUNT(*) as total, SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) as paid, SUM(CASE WHEN sent_to_crm = 1 THEN 1 ELSE 0 END) as sent, SUM(CASE WHEN status = 'paid' THEN amount ELSE 0 END) as revenue FROM transactions`),
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
  clients.forEach(ws => { if (ws.readyState === 1) ws.send(msg); });
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

  async fetchTransactions(page = 1, status = 'paid') {
    // Tenta endpoint salvo primeiro
    const saved = stmts.getSetting.get('working_endpoint');
    const savedEndpoint = saved ? saved.value : null;

    const endpoints = [
      ...(savedEndpoint ? [`${savedEndpoint}?page=${page}&status=${status}`] : []),
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
        const res = await fetch(url, { method: 'GET', headers: this.headers(), timeout: 10000 });

        if (res.ok) {
          const data = await res.json();
          log('success', `DHR respondeu: ${endpoint}`);
          stmts.setSetting.run('working_endpoint', endpoint.split('?')[0]);
          return data;
        }

        if (res.status === 401) {
          log('error', 'DHR: Autenticação falhou (401). Verifique as chaves API.');
          return null;
        }
      } catch (e) {}
    }

    log('info', 'DHR API: nenhum endpoint respondeu. Use o modo Webhook (recomendado).');
    return null;
  },

  normalizeTransaction(raw) {
    const tx = raw.data || raw.transaction || raw.charge || raw.payment || raw;
    return {
      id: tx.id || tx.transaction_id || tx.charge_id || tx.payment_id || tx.code || `dhr_${Date.now()}_${Math.random().toString(36).slice(2,8)}`,
      customer_name: tx.customer?.name || tx.buyer?.name || tx.payer?.name || tx.name || '',
      customer_email: tx.customer?.email || tx.buyer?.email || tx.payer?.email || tx.email || '',
      customer_phone: tx.customer?.phone || tx.customer?.phone_number || tx.customer?.cellphone || tx.buyer?.phone || tx.phone || tx.cellphone || '',
      customer_document: tx.customer?.document || tx.customer?.cpf || tx.customer?.document_number || tx.buyer?.cpf || tx.cpf || tx.document || '',
      product: tx.product?.name || tx.items?.[0]?.name || tx.description || tx.product_name || tx.offer?.name || '',
      amount: this.parseAmount(tx.amount || tx.value || tx.total || tx.price || 0),
      payment_method: tx.payment_method || tx.method || tx.type || tx.payment?.method || 'unknown',
      status: this.normalizeStatus(tx.status || tx.payment_status || tx.payment?.status || ''),
      dhr_status: tx.status || '',
      created_at: tx.created_at || tx.paid_at || tx.date || tx.createdAt || tx.updated_at || new Date().toISOString(),
    };
  },

  parseAmount(val) {
    if (typeof val === 'string') val = parseFloat(val.replace(/[^\d.,]/g, '').replace(',', '.'));
    if (isNaN(val)) return 0;
    // Se > 10000 provavelmente está em centavos
    return val > 10000 ? val / 100 : val;
  },

  normalizeStatus(s) {
    const str = String(s).toLowerCase();
    if (['paid','approved','confirmed','completed','captured','autorizado','pago','aprovado','active'].some(k => str.includes(k))) return 'paid';
    if (['refund','reversed','estornado','reembolsado'].some(k => str.includes(k))) return 'refunded';
    if (['pending','waiting','pendente','aguardando','processing','created'].some(k => str.includes(k))) return 'pending';
    if (['failed','denied','declined','negado','recusado','falhou','refused'].some(k => str.includes(k))) return 'failed';
    if (['cancelled','canceled','cancelado','expired','expirado'].some(k => str.includes(k))) return 'cancelled';
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
      log('info', `Enviando para CRM: ${tx.customer_name} (${tx.id})`);
      const res = await fetch(CONFIG.crm.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        timeout: 15000,
      });
      const responseText = await res.text().catch(() => '');
      if (res.ok) {
        stmts.updateTxCRM.run(responseText || 'ok', tx.id);
        log('success', `✓ CRM: ${tx.customer_name} - R$ ${tx.amount}`);
        broadcast({ type: 'lead_sent', payload: { id: tx.id } });
        return true;
      } else {
        log('error', `CRM ${res.status}: ${responseText.substring(0, 200)}`);
        return false;
      }
    } catch (e) {
      log('error', `CRM erro: ${e.message}`);
      return false;
    }
  },

  async sendBatch(transactions) {
    let sent = 0;
    for (const tx of transactions) {
      if (await this.send(tx)) sent++;
      await new Promise(r => setTimeout(r, 500));
    }
    return sent;
  },
};

// ─── Transaction Processor ───
function processTransaction(raw) {
  const tx = DHR.normalizeTransaction(raw);
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
  return null;
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
      const transactions = data.data || data.transactions || data.charges ||
        data.payments || data.items || data.results ||
        (Array.isArray(data) ? data : []);
      if (Array.isArray(transactions) && transactions.length > 0) {
        let newCount = 0;
        for (const raw of transactions) {
          const tx = await processAndSend(raw);
          if (tx) newCount++;
        }
        log('info', `Poll: ${newCount} nova(s) de ${transactions.length}`);
      } else {
        log('info', 'Nenhuma transação na resposta');
      }
    }
  } catch (e) {
    log('error', `Polling erro: ${e.message}`);
  }
  isPolling = false;
  broadcast({ type: 'poll_complete' });
}

function startPolling() {
  if (pollTimer) return;
  doPoll();
  pollTimer = setInterval(doPoll, CONFIG.pollInterval);
  log('info', `🟢 Polling iniciado (${CONFIG.pollInterval / 1000}s)`);
  broadcast({ type: 'polling_status', payload: { active: true } });
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  log('info', '🔴 Polling parado');
  broadcast({ type: 'polling_status', payload: { active: false } });
}

// ─── Express App ───
const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ─── Static files (try multiple paths) ───
const staticPaths = [
  path.join(__dirname, 'public'),
  path.join(process.cwd(), 'public'),
  __dirname,
  process.cwd(),
];
for (const sp of staticPaths) {
  try { if (fs.existsSync(sp)) app.use(express.static(sp)); } catch(e) {}
}

// ═══════════════════════════════════════
// WEBHOOK ENDPOINTS (DHR → Server)
// ═══════════════════════════════════════

app.post('/webhook/dhr', async (req, res) => {
  try {
    const event = req.body;
    log('info', `Webhook recebido: ${JSON.stringify(event).substring(0, 200)}`);

    const eventType = (event.type || event.event || event.action || '').toLowerCase();

    const paidEvents = [
      'transaction.paid','transaction.approved','transaction.completed',
      'payment.paid','payment.approved','payment.confirmed',
      'charge.paid','charge.completed',
      'order.paid','order.completed',
      'sale.completed','sale.approved',
      'invoice.paid','purchase.approved','purchase.completed',
    ];

    if (paidEvents.some(e => eventType.includes(e.split('.')[1]) || eventType === e)) {
      const tx = await processAndSend(event.data || event);
      if (tx) log('success', `✓ Webhook: ${tx.customer_name} - R$ ${tx.amount}`);
    } else if (eventType.includes('refund') || eventType.includes('chargeback')) {
      processTransaction(event.data || event);
    } else {
      // Processa qualquer payload que pareça uma transação
      const raw = event.data || event;
      if (raw.customer || raw.buyer || raw.payer || raw.amount || raw.value || raw.status) {
        await processAndSend(raw);
        log('info', `Evento processado: ${eventType || 'sem tipo'}`);
      } else {
        log('info', `Evento ignorado: ${eventType || 'desconhecido'}`);
      }
    }

    res.status(200).json({ received: true });
  } catch (e) {
    log('error', `Webhook erro: ${e.message}`);
    res.status(200).json({ received: true, error: e.message });
  }
});

app.post('/webhook/callback', (req, res) => {
  req.url = '/webhook/dhr';
  app.handle(req, res);
});

// ═══════════════════════════════════════
// API ENDPOINTS (Frontend → Server)
// ═══════════════════════════════════════

app.get('/api/stats', (req, res) => {
  const stats = stmts.getStats.get();
  res.json({
    total: stats.total || 0, paid: stats.paid || 0, sent: stats.sent || 0,
    pending_send: (stats.paid || 0) - (stats.sent || 0),
    revenue: stats.revenue || 0, polling: !!pollTimer, auto_send: CONFIG.autoSendCRM,
  });
});

app.get('/api/transactions', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 200, 1000);
  res.json({ data: stmts.getAllTx.all(limit) });
});

app.get('/api/transactions/pending', (req, res) => {
  res.json({ data: stmts.getPaidNotSent.all() });
});

app.post('/api/transactions/:id/send-crm', async (req, res) => {
  const tx = stmts.getTx.get(req.params.id);
  if (!tx) return res.status(404).json({ error: 'Não encontrada' });
  if (tx.sent_to_crm) return res.json({ success: true, message: 'Já enviado' });
  const ok = await CRM.send(tx);
  res.json({ success: ok });
});

app.post('/api/transactions/:id/resend-crm', async (req, res) => {
  const tx = stmts.getTx.get(req.params.id);
  if (!tx) return res.status(404).json({ error: 'Não encontrada' });
  db.prepare('UPDATE transactions SET sent_to_crm = 0, sent_at = NULL WHERE id = ?').run(req.params.id);
  const ok = await CRM.send(tx);
  res.json({ success: ok });
});

app.post('/api/transactions/send-all', async (req, res) => {
  const pending = stmts.getPaidNotSent.all();
  if (!pending.length) return res.json({ success: true, sent: 0, total: 0 });
  log('info', `Enviando ${pending.length} leads em lote...`);
  const sent = await CRM.sendBatch(pending);
  res.json({ success: true, sent, total: pending.length });
});

app.post('/api/polling/start', (req, res) => { startPolling(); res.json({ success: true, active: true }); });
app.post('/api/polling/stop', (req, res) => { stopPolling(); res.json({ success: true, active: false }); });
app.post('/api/polling/trigger', async (req, res) => { await doPoll(); res.json({ success: true }); });

app.post('/api/settings/auto-send', (req, res) => {
  CONFIG.autoSendCRM = req.body.enabled !== false;
  stmts.setSetting.run('auto_send', String(CONFIG.autoSendCRM));
  res.json({ success: true, auto_send: CONFIG.autoSendCRM });
});

app.post('/api/settings/poll-interval', (req, res) => {
  const seconds = Math.max(10, Math.min(300, parseInt(req.body.seconds) || 30));
  CONFIG.pollInterval = seconds * 1000;
  stmts.setSetting.run('poll_interval', String(seconds));
  if (pollTimer) { stopPolling(); startPolling(); }
  res.json({ success: true, interval: seconds });
});

app.get('/api/logs', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  res.json({ data: stmts.getLogs.all(limit) });
});

app.post('/api/reset', (req, res) => {
  db.exec('DELETE FROM transactions; DELETE FROM logs;');
  log('info', 'Banco limpo');
  res.json({ success: true });
});

app.post('/api/test-crm', async (req, res) => {
  try {
    const testPayload = {
      event: 'test', timestamp: new Date().toISOString(),
      lead: { nome: 'Teste Sistema', email: 'teste@sistema.com', telefone: '5511999999999' },
      transacao: { id: 'test_' + Date.now(), produto: 'Teste', valor: 0, status: 'test' },
    };
    const r = await fetch(CONFIG.crm.webhookUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(testPayload), timeout: 10000,
    });
    const text = await r.text().catch(() => '');
    res.json({ success: r.ok, status: r.status, response: text.substring(0, 500) });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.post('/api/test-dhr', async (req, res) => {
  try {
    const data = await DHR.fetchTransactions(1);
    res.json({ success: !!data, data: data ? 'Conectado' : 'Sem resposta' });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ─── SPA fallback: serve index.html from memory or file ───
app.get('*', (req, res) => {
  // Skip API and webhook routes
  if (req.path.startsWith('/api/') || req.path.startsWith('/webhook/')) {
    return res.status(404).json({ error: 'Not found' });
  }

  // Try to serve from memory
  if (INDEX_HTML) {
    return res.type('html').send(INDEX_HTML);
  }

  // Try to find it again (maybe it was created after startup)
  INDEX_HTML = findIndexHtml();
  if (INDEX_HTML) {
    return res.type('html').send(INDEX_HTML);
  }

  // Last resort: send minimal fallback
  res.type('html').send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>DHR Lead Capture</title></head>
<body style="background:#0a0a12;color:#ccc;font-family:sans-serif;display:grid;place-items:center;min-height:100vh;margin:0">
<div style="text-align:center;max-width:500px;padding:40px">
<h1 style="color:#10b981">⚡ DHR Lead Capture</h1>
<p>O servidor está rodando, mas o arquivo <code>public/index.html</code> não foi encontrado.</p>
<p>Certifique-se que o arquivo está na pasta <code>public/</code> junto ao <code>server.js</code>.</p>
<h3 style="margin-top:30px;color:#10b981">API Status</h3>
<p>Webhook: <code>POST /webhook/dhr</code> ✓</p>
<p>Stats: <a href="/api/stats" style="color:#3b82f6">/api/stats</a></p>
<p>Transações: <a href="/api/transactions" style="color:#3b82f6">/api/transactions</a></p>
</div></body></html>`);
});

// ─── HTTP + WebSocket Server ───
const server = http.createServer(app);
wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  clients.add(ws);
  const stats = stmts.getStats.get();
  ws.send(JSON.stringify({
    type: 'init',
    payload: { polling: !!pollTimer, auto_send: CONFIG.autoSendCRM, stats },
  }));
  ws.on('close', () => clients.delete(ws));
});

// ─── Start ───
server.listen(CONFIG.port, () => {
  console.log('');
  console.log('  ╔═══════════════════════════════════════════════════╗');
  console.log('  ║   ⚡ DHR Lead Capture System                     ║');
  console.log('  ╠═══════════════════════════════════════════════════╣');
  console.log(`  ║   Dashboard:  http://localhost:${CONFIG.port}`);
  console.log(`  ║   Webhook:    http://localhost:${CONFIG.port}/webhook/dhr`);
  console.log(`  ║   API:        http://localhost:${CONFIG.port}/api/stats`);
  console.log(`  ║   WebSocket:  ws://localhost:${CONFIG.port}/ws`);
  console.log('  ╠═══════════════════════════════════════════════════╣');
  console.log(`  ║   index.html: ${INDEX_HTML ? '✓ Encontrado' : '✗ NÃO ENCONTRADO'}`);
  console.log(`  ║   __dirname:  ${__dirname}`);
  console.log(`  ║   cwd:        ${process.cwd()}`);
  console.log('  ╚═══════════════════════════════════════════════════╝');
  console.log('');

  log('info', 'Servidor iniciado');

  // Restaura configurações
  try {
    const savedAutoSend = stmts.getSetting.get('auto_send');
    if (savedAutoSend) CONFIG.autoSendCRM = savedAutoSend.value === 'true';
  } catch(e) {}
});

process.on('SIGINT', () => { stopPolling(); db.close(); server.close(); process.exit(0); });
process.on('SIGTERM', () => { stopPolling(); db.close(); server.close(); process.exit(0); });
