// ═══════════════════════════════════════════════════════════════
//  DHR Lead Capture System - Backend Server
//  Shield Tecnologia API → CRM DataCrazy
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
    baseUrl: process.env.DHR_BASE_URL || 'https://api.shieldtecnologia.com/v1',
    publicKey: process.env.DHR_PUBLIC_KEY || '',
    secretKey: process.env.DHR_SECRET_KEY || '',
  },
  crm: { webhookUrl: process.env.CRM_WEBHOOK_URL || '' },
  pollInterval: (parseInt(process.env.POLL_INTERVAL) || 30) * 1000,
  autoSendCRM: process.env.AUTO_SEND_CRM !== 'false',
};

// ═══════════════════════════════════════════════════
//  Shield Tecnologia - Assinatura HMAC-SHA512
//  Formato: HMAC-SHA512(secretKey, pubKey + body + pubKey)
//  Resultado: hex → base64
// ═══════════════════════════════════════════════════
function generateSignature(body = '') {
  const pk = CONFIG.dhr.publicKey;
  const sk = CONFIG.dhr.secretKey;
  const data = body ? (pk + body + pk) : (pk + pk);
  const hmac = crypto.createHmac('sha512', sk).update(data).digest('hex');
  return Buffer.from(hmac).toString('base64');
}

function shieldHeaders(body = '') {
  const jsonStr = typeof body === 'string' ? body : JSON.stringify(body);
  const signature = generateSignature(body ? jsonStr : '');
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'public-key': CONFIG.dhr.publicKey,
    'signature': signature,
    // Variações comuns de header
    'x-public-key': CONFIG.dhr.publicKey,
    'x-signature': signature,
    'merchant': CONFIG.dhr.publicKey,
    'Authorization': `Bearer ${CONFIG.dhr.secretKey}`,
  };
}

// ─── Find index.html ───
function findIndexHtml() {
  for (const p of [
    path.join(__dirname, 'public', 'index.html'),
    path.join(process.cwd(), 'public', 'index.html'),
    '/app/public/index.html',
    path.join(__dirname, 'index.html'),
  ]) {
    try { if (fs.existsSync(p)) { console.log(`[HTML] ${p}`); return fs.readFileSync(p, 'utf-8'); } } catch(e) {}
  }
  return null;
}
let INDEX_HTML = findIndexHtml();

// ─── Database ───
const db = new Database(path.join(__dirname, 'leads.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY, customer_name TEXT, customer_email TEXT,
    customer_phone TEXT, customer_document TEXT, product TEXT,
    amount REAL, payment_method TEXT, status TEXT, dhr_status TEXT,
    created_at TEXT, received_at TEXT DEFAULT (datetime('now')),
    sent_to_crm INTEGER DEFAULT 0, sent_at TEXT, crm_response TEXT, raw_data TEXT
  );
  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, message TEXT, data TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
  CREATE INDEX IF NOT EXISTS idx_tx_st ON transactions(status);
  CREATE INDEX IF NOT EXISTS idx_tx_crm ON transactions(sent_to_crm);
`);

const Q = {
  ins: db.prepare(`INSERT OR IGNORE INTO transactions (id,customer_name,customer_email,customer_phone,customer_document,product,amount,payment_method,status,dhr_status,created_at,raw_data) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`),
  upCrm: db.prepare(`UPDATE transactions SET sent_to_crm=1, sent_at=datetime('now'), crm_response=? WHERE id=?`),
  get: db.prepare('SELECT * FROM transactions WHERE id=?'),
  all: db.prepare('SELECT * FROM transactions ORDER BY created_at DESC LIMIT ?'),
  pending: db.prepare("SELECT * FROM transactions WHERE status='paid' AND sent_to_crm=0"),
  stats: db.prepare(`SELECT COUNT(*) as total, SUM(CASE WHEN status='paid' THEN 1 ELSE 0 END) as paid, SUM(CASE WHEN sent_to_crm=1 THEN 1 ELSE 0 END) as sent, SUM(CASE WHEN status='paid' THEN amount ELSE 0 END) as revenue FROM transactions`),
  log: db.prepare('INSERT INTO logs (type,message,data) VALUES (?,?,?)'),
  logs: db.prepare('SELECT * FROM logs ORDER BY created_at DESC LIMIT ?'),
  getS: db.prepare('SELECT value FROM settings WHERE key=?'),
  setS: db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)'),
};

// ─── Logger + WS ───
let wss; const clients = new Set();
function broadcast(d) { const m = JSON.stringify(d); clients.forEach(ws => { if (ws.readyState === 1) ws.send(m); }); }
function log(type, msg, data = null) {
  console.log(`[${new Date().toISOString()}] [${type.toUpperCase()}] ${msg}`);
  try { Q.log.run(type, msg, data ? JSON.stringify(data) : null); } catch(e) {}
  broadcast({ type: 'log', payload: { type, message: msg, time: new Date().toISOString() } });
}

// ═══════════════════════════════════════════════════
//  Shield API - Buscar Transações
// ═══════════════════════════════════════════════════
const SHIELD = {
  async request(method, endpoint, body = null) {
    const url = `${CONFIG.dhr.baseUrl}${endpoint}`;
    const jsonBody = body ? JSON.stringify(body) : '';
    const headers = shieldHeaders(jsonBody || '');
    const opts = { method, headers, timeout: 15000 };
    if (body && method !== 'GET') opts.body = jsonBody;

    try {
      const res = await fetch(url, opts);
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch(e) { data = text; }

      if (res.ok) {
        log('success', `Shield ${method} ${endpoint} → ${res.status}`);
        return { ok: true, status: res.status, data };
      } else {
        log('info', `Shield ${method} ${endpoint} → ${res.status}: ${text.substring(0, 200)}`);
        return { ok: false, status: res.status, data };
      }
    } catch (e) {
      log('error', `Shield ${endpoint} erro: ${e.message}`);
      return { ok: false, error: e.message };
    }
  },

  async fetchTransactions(page = 1) {
    // Tenta endpoint salvo
    const saved = Q.getS.get('working_endpoint');
    if (saved) {
      const r = await this.request('GET', `${saved.value}?page=${page}`);
      if (r.ok) return r.data;
    }

    // Tenta endpoints comuns de gateways Shield/white-label
    const endpoints = [
      '/transactions', '/transaction', '/charges', '/charge',
      '/payments', '/payment', '/orders', '/order',
      '/sales', '/sale', '/invoices',
    ];

    for (const ep of endpoints) {
      // GET com query params
      const r1 = await this.request('GET', `${ep}?page=${page}&status=paid`);
      if (r1.ok) { Q.setS.run('working_endpoint', ep); return r1.data; }

      // GET sem filtro
      if (r1.status === 400 || r1.status === 422) {
        const r2 = await this.request('GET', `${ep}?page=${page}`);
        if (r2.ok) { Q.setS.run('working_endpoint', ep); return r2.data; }
      }

      // POST body (alguns gateways usam POST para listar)
      if (r1.status === 404 || r1.status === 405) {
        const r3 = await this.request('POST', ep, { page, status: 'paid', per_page: 50 });
        if (r3.ok) { Q.setS.run('working_endpoint', ep); return r3.data; }

        const r4 = await this.request('POST', `${ep}/list`, { page, filters: { status: 'paid' } });
        if (r4.ok) { Q.setS.run('working_endpoint', `${ep}/list`); return r4.data; }
      }

      // Se recebeu 401/403, auth está errada - para de tentar
      if (r1.status === 401 || r1.status === 403) {
        log('error', `Shield: Autenticação falhou (${r1.status}). Verifique pk/sk.`);
        return null;
      }
    }

    log('info', 'Shield: nenhum endpoint respondeu. Use o modo Webhook.');
    return null;
  },

  normalize(raw) {
    const tx = raw.data || raw.transaction || raw.charge || raw.payment || raw;
    return {
      id: tx.id || tx.transaction_id || tx.charge_id || tx.code || `sh_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
      customer_name: tx.customer?.name || tx.buyer?.name || tx.payer?.name || tx.name || '',
      customer_email: tx.customer?.email || tx.buyer?.email || tx.payer?.email || tx.email || '',
      customer_phone: tx.customer?.phone || tx.customer?.phone_number || tx.customer?.cellphone || tx.buyer?.phone || tx.phone || tx.cellphone || '',
      customer_document: tx.customer?.document || tx.customer?.cpf || tx.customer?.document_number || tx.buyer?.cpf || tx.cpf || tx.document || '',
      product: tx.product?.name || tx.items?.[0]?.name || tx.description || tx.product_name || tx.offer?.name || tx.plan?.name || '',
      amount: this.parseAmount(tx.amount || tx.value || tx.total || tx.price || 0),
      payment_method: tx.payment_method || tx.method || tx.type || tx.payment?.method || 'unknown',
      status: this.normStatus(tx.status || tx.payment_status || tx.payment?.status || ''),
      dhr_status: tx.status || '',
      created_at: tx.created_at || tx.paid_at || tx.date || tx.createdAt || tx.updated_at || new Date().toISOString(),
    };
  },

  parseAmount(v) {
    if (typeof v === 'string') v = parseFloat(v.replace(/[^\d.,]/g, '').replace(',', '.'));
    if (isNaN(v)) return 0;
    return v > 10000 ? v / 100 : v;
  },

  normStatus(s) {
    const str = String(s).toLowerCase();
    if (['paid','approved','confirmed','completed','captured','autorizado','pago','aprovado','active','succeeded'].some(k => str.includes(k))) return 'paid';
    if (['refund','reversed','estornado','reembolsado'].some(k => str.includes(k))) return 'refunded';
    if (['pending','waiting','pendente','aguardando','processing','created'].some(k => str.includes(k))) return 'pending';
    if (['failed','denied','declined','negado','recusado','refused'].some(k => str.includes(k))) return 'failed';
    if (['cancelled','canceled','cancelado','expired'].some(k => str.includes(k))) return 'cancelled';
    return 'unknown';
  },
};

// ─── CRM ───
const CRM = {
  payload(tx) {
    return {
      event: 'venda_paga', timestamp: new Date().toISOString(),
      lead: { nome: tx.customer_name, email: tx.customer_email, telefone: tx.customer_phone, documento: tx.customer_document },
      transacao: { id: tx.id, produto: tx.product, valor: tx.amount, metodo_pagamento: tx.payment_method, data_pagamento: tx.created_at, status: tx.status },
      metadata: { source: 'dhr_shield_integration', gateway: 'shield_tecnologia', auto_sent: true, sent_at: new Date().toISOString() },
    };
  },
  async send(tx) {
    try {
      log('info', `CRM ← ${tx.customer_name} (${tx.id})`);
      const res = await fetch(CONFIG.crm.webhookUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this.payload(tx)), timeout: 15000,
      });
      const text = await res.text().catch(() => '');
      if (res.ok) {
        Q.upCrm.run(text || 'ok', tx.id);
        log('success', `✓ CRM: ${tx.customer_name} - R$ ${tx.amount}`);
        broadcast({ type: 'lead_sent', payload: { id: tx.id } });
        return true;
      }
      log('error', `CRM ${res.status}: ${text.substring(0, 200)}`);
      return false;
    } catch (e) { log('error', `CRM: ${e.message}`); return false; }
  },
  async batch(txs) { let n = 0; for (const tx of txs) { if (await this.send(tx)) n++; await new Promise(r => setTimeout(r, 500)); } return n; },
};

// ─── Process ───
function processTx(raw) {
  const tx = SHIELD.normalize(raw);
  const r = Q.ins.run(tx.id, tx.customer_name, tx.customer_email, tx.customer_phone, tx.customer_document, tx.product, tx.amount, tx.payment_method, tx.status, tx.dhr_status, tx.created_at, JSON.stringify(raw));
  if (r.changes > 0) { log('success', `Nova: ${tx.customer_name} R$ ${tx.amount} [${tx.status}]`); broadcast({ type: 'new_transaction', payload: tx }); return tx; }
  return null;
}
async function processAndSend(raw) {
  const tx = processTx(raw);
  if (tx && tx.status === 'paid' && CONFIG.autoSendCRM) await CRM.send(tx);
  return tx;
}

// ─── Polling ───
let pollTimer = null, polling = false;
async function doPoll() {
  if (polling) return; polling = true;
  try {
    log('info', 'Consultando Shield API...');
    const data = await SHIELD.fetchTransactions();
    if (data) {
      const txs = data.data || data.transactions || data.charges || data.payments || data.items || data.results || (Array.isArray(data) ? data : []);
      if (Array.isArray(txs) && txs.length > 0) {
        let n = 0;
        for (const raw of txs) { if (await processAndSend(raw)) n++; }
        log('info', `Poll: ${n} nova(s) de ${txs.length}`);
      } else log('info', 'Nenhuma transação nova');
    }
  } catch (e) { log('error', `Poll: ${e.message}`); }
  polling = false;
  broadcast({ type: 'poll_complete' });
}
function startPoll() { if (pollTimer) return; doPoll(); pollTimer = setInterval(doPoll, CONFIG.pollInterval); log('info', `🟢 Polling ON (${CONFIG.pollInterval/1000}s)`); broadcast({ type: 'polling_status', payload: { active: true } }); }
function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } log('info', '🔴 Polling OFF'); broadcast({ type: 'polling_status', payload: { active: false } }); }

// ═══════════════════════════════════════
//  Express
// ═══════════════════════════════════════
const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => { res.header('Access-Control-Allow-Origin', '*'); res.header('Access-Control-Allow-Methods', '*'); res.header('Access-Control-Allow-Headers', '*'); if (req.method === 'OPTIONS') return res.sendStatus(200); next(); });

// Static
for (const sp of [path.join(__dirname,'public'), path.join(process.cwd(),'public'), __dirname]) {
  try { if (fs.existsSync(sp)) app.use(express.static(sp)); } catch(e) {}
}

// ─── WEBHOOK ───
app.post('/webhook/dhr', async (req, res) => {
  try {
    const ev = req.body;
    log('info', `Webhook: ${JSON.stringify(ev).substring(0, 300)}`);
    const evType = (ev.type || ev.event || ev.action || '').toLowerCase();
    const paidKW = ['paid','approved','completed','confirmed','captured','pago','aprovado','succeeded'];
    if (paidKW.some(k => evType.includes(k)) || paidKW.some(k => String(ev.status||ev.data?.status||'').toLowerCase().includes(k))) {
      await processAndSend(ev.data || ev);
    } else {
      const raw = ev.data || ev;
      if (raw.customer || raw.buyer || raw.amount || raw.value || raw.status) await processAndSend(raw);
      else log('info', `Evento ignorado: ${evType}`);
    }
    res.json({ received: true });
  } catch (e) { log('error', `Webhook: ${e.message}`); res.json({ received: true }); }
});
app.post('/webhook/callback', (req, res) => { req.url = '/webhook/dhr'; app.handle(req, res); });
app.post('/webhook/shield', (req, res) => { req.url = '/webhook/dhr'; app.handle(req, res); });

// ─── API ───
app.get('/api/stats', (req, res) => {
  const s = Q.stats.get();
  res.json({ total: s.total||0, paid: s.paid||0, sent: s.sent||0, pending_send: (s.paid||0)-(s.sent||0), revenue: s.revenue||0, polling: !!pollTimer, auto_send: CONFIG.autoSendCRM });
});
app.get('/api/transactions', (req, res) => { res.json({ data: Q.all.all(Math.min(parseInt(req.query.limit)||200, 1000)) }); });
app.get('/api/transactions/pending', (req, res) => { res.json({ data: Q.pending.all() }); });
app.post('/api/transactions/:id/send-crm', async (req, res) => {
  const tx = Q.get.get(req.params.id); if (!tx) return res.status(404).json({ error: '404' });
  if (tx.sent_to_crm) return res.json({ success: true, message: 'Já enviado' });
  res.json({ success: await CRM.send(tx) });
});
app.post('/api/transactions/:id/resend-crm', async (req, res) => {
  const tx = Q.get.get(req.params.id); if (!tx) return res.status(404).json({ error: '404' });
  db.prepare('UPDATE transactions SET sent_to_crm=0, sent_at=NULL WHERE id=?').run(req.params.id);
  res.json({ success: await CRM.send(tx) });
});
app.post('/api/transactions/send-all', async (req, res) => {
  const p = Q.pending.all(); if (!p.length) return res.json({ success: true, sent: 0, total: 0 });
  log('info', `Lote: ${p.length} leads...`);
  res.json({ success: true, sent: await CRM.batch(p), total: p.length });
});
app.post('/api/polling/start', (req, res) => { startPoll(); res.json({ success: true }); });
app.post('/api/polling/stop', (req, res) => { stopPoll(); res.json({ success: true }); });
app.post('/api/polling/trigger', async (req, res) => { await doPoll(); res.json({ success: true }); });
app.post('/api/settings/auto-send', (req, res) => { CONFIG.autoSendCRM = req.body.enabled !== false; Q.setS.run('auto_send', String(CONFIG.autoSendCRM)); res.json({ success: true, auto_send: CONFIG.autoSendCRM }); });
app.post('/api/settings/poll-interval', (req, res) => {
  const s = Math.max(10, Math.min(300, parseInt(req.body.seconds)||30)); CONFIG.pollInterval = s*1000;
  Q.setS.run('poll_interval', String(s)); if (pollTimer) { stopPoll(); startPoll(); }
  res.json({ success: true, interval: s });
});
app.get('/api/logs', (req, res) => { res.json({ data: Q.logs.all(Math.min(parseInt(req.query.limit)||100, 500)) }); });
app.post('/api/reset', (req, res) => { db.exec('DELETE FROM transactions; DELETE FROM logs;'); log('info', 'DB limpo'); res.json({ success: true }); });

app.post('/api/test-crm', async (req, res) => {
  try {
    const r = await fetch(CONFIG.crm.webhookUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'test', lead: { nome: 'Teste' }, transacao: { id: 'test_'+Date.now(), valor: 0 } }),
    });
    res.json({ success: r.ok, status: r.status });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.post('/api/test-dhr', async (req, res) => {
  try {
    const data = await SHIELD.fetchTransactions(1);
    res.json({ success: !!data, data: data ? 'Conectado' : 'Sem resposta' });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ─── SPA Fallback ───
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/webhook/')) return res.status(404).json({ error: 'Not found' });
  if (!INDEX_HTML) INDEX_HTML = findIndexHtml();
  if (INDEX_HTML) return res.type('html').send(INDEX_HTML);
  res.type('html').send(`<!DOCTYPE html><html><body style="background:#0a0a12;color:#ccc;font-family:sans-serif;display:grid;place-items:center;min-height:100vh;margin:0">
    <div style="text-align:center"><h1 style="color:#10b981">⚡ DHR Lead Capture</h1>
    <p>Servidor rodando. <code>public/index.html</code> não encontrado.</p>
    <p><a href="/api/stats" style="color:#3b82f6">/api/stats</a> · Webhook: POST /webhook/dhr</p></div></body></html>`);
});

// ─── Server ───
const server = http.createServer(app);
wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', ws => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'init', payload: { polling: !!pollTimer, auto_send: CONFIG.autoSendCRM, stats: Q.stats.get() } }));
  ws.on('close', () => clients.delete(ws));
});

server.listen(CONFIG.port, () => {
  console.log(`
  ╔═══════════════════════════════════════════════════════╗
  ║   ⚡ DHR Lead Capture System (Shield API)            ║
  ╠═══════════════════════════════════════════════════════╣
  ║   Dashboard:  http://localhost:${CONFIG.port}
  ║   Webhook:    POST /webhook/dhr
  ║   API:        ${CONFIG.dhr.baseUrl}
  ║   HTML:       ${INDEX_HTML ? '✓ OK' : '✗ NOT FOUND'}
  ║   __dirname:  ${__dirname}
  ╚═══════════════════════════════════════════════════════╝
  `);
  log('info', 'Servidor iniciado');
  try { const s = Q.getS.get('auto_send'); if (s) CONFIG.autoSendCRM = s.value === 'true'; } catch(e) {}
});

process.on('SIGINT', () => { stopPoll(); db.close(); server.close(); process.exit(0); });
process.on('SIGTERM', () => { stopPoll(); db.close(); server.close(); process.exit(0); });
