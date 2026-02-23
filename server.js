// ═══════════════════════════════════════════════════════════════
//  DHR Lead Capture System — Webhook Mode
//  Recebe eventos da DHR/Shield → Envia para CRM DataCrazy
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
const CFG = {
  port: process.env.PORT || 3000,
  dhr: {
    baseUrl: process.env.DHR_BASE_URL || 'https://api.shieldtecnologia.com/v1',
    pk: process.env.DHR_PUBLIC_KEY || '',
    sk: process.env.DHR_SECRET_KEY || '',
  },
  crm: { url: process.env.CRM_WEBHOOK_URL || '' },
  autoSend: process.env.AUTO_SEND_CRM !== 'false',
};

// ─── Find HTML ───
function findHtml() {
  for (const p of [
    path.join(__dirname, 'public', 'index.html'),
    path.join(process.cwd(), 'public', 'index.html'),
    '/app/public/index.html',
    path.join(__dirname, 'index.html'),
  ]) { try { if (fs.existsSync(p)) return fs.readFileSync(p, 'utf-8'); } catch(e) {} }
  return null;
}
let HTML = findHtml();

// ─── Database ───
const db = new Database(process.env.DB_PATH || path.join(__dirname, 'leads.db'));
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
    id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, message TEXT,
    data TEXT, created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
  CREATE INDEX IF NOT EXISTS idx_st ON transactions(status);
  CREATE INDEX IF NOT EXISTS idx_crm ON transactions(sent_to_crm);
`);

const Q = {
  ins: db.prepare(`INSERT OR IGNORE INTO transactions (id,customer_name,customer_email,customer_phone,customer_document,product,amount,payment_method,status,dhr_status,created_at,raw_data) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`),
  upCrm: db.prepare(`UPDATE transactions SET sent_to_crm=1,sent_at=datetime('now'),crm_response=? WHERE id=?`),
  get: db.prepare('SELECT * FROM transactions WHERE id=?'),
  all: db.prepare('SELECT * FROM transactions ORDER BY received_at DESC LIMIT ?'),
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
  const t = new Date().toISOString();
  console.log(`[${t}] [${type.toUpperCase()}] ${msg}`);
  try { Q.log.run(type, msg, data ? JSON.stringify(data) : null); } catch(e) {}
  broadcast({ type: 'log', payload: { type, message: msg, time: t } });
}

// ═══════════════════════════════════════
//  Normalizar transação (qualquer formato)
// ═══════════════════════════════════════
function normalize(raw) {
  // Desembala: event pode ter data, transaction, charge, etc
  const tx = raw.data?.transaction || raw.data?.charge || raw.data?.payment ||
             raw.data?.order || raw.data || raw.transaction || raw.charge ||
             raw.payment || raw.order || raw;

  // Nome: busca em vários caminhos
  const name = tx.customer?.name || tx.buyer?.name || tx.payer?.name ||
               tx.client?.name || tx.subscriber?.name ||
               tx.name || tx.customer_name || tx.buyer_name || '';

  const email = tx.customer?.email || tx.buyer?.email || tx.payer?.email ||
                tx.client?.email || tx.subscriber?.email ||
                tx.email || tx.customer_email || tx.buyer_email || '';

  const phone = tx.customer?.phone || tx.customer?.phone_number || tx.customer?.cellphone ||
                tx.customer?.mobile || tx.buyer?.phone || tx.payer?.phone ||
                tx.client?.phone || tx.subscriber?.phone ||
                tx.phone || tx.cellphone || tx.phone_number || tx.mobile || '';

  const doc = tx.customer?.document || tx.customer?.cpf || tx.customer?.document_number ||
              tx.customer?.tax_id || tx.buyer?.cpf || tx.buyer?.document ||
              tx.client?.document || tx.subscriber?.document ||
              tx.cpf || tx.document || tx.document_number || tx.tax_id || '';

  const product = tx.product?.name || tx.plan?.name || tx.offer?.name ||
                  tx.items?.[0]?.name || tx.items?.[0]?.title ||
                  tx.description || tx.product_name || tx.plan_name ||
                  tx.subscription?.plan?.name || '';

  let amount = tx.amount || tx.value || tx.total || tx.price ||
               tx.payment?.amount || tx.subscription?.price || 0;
  if (typeof amount === 'string') amount = parseFloat(amount.replace(/[^\d.,]/g, '').replace(',', '.'));
  if (isNaN(amount)) amount = 0;
  if (amount > 10000) amount = amount / 100; // centavos → reais

  const method = tx.payment_method || tx.method || tx.type ||
                 tx.payment?.method || tx.payment?.type ||
                 tx.payment_type || 'desconhecido';

  const rawStatus = String(tx.status || tx.payment_status || tx.payment?.status ||
                           tx.subscription?.status || raw.event || raw.type || '').toLowerCase();

  let status = 'unknown';
  if (['paid','approved','confirmed','completed','captured','autorizado','pago','aprovado','active','succeeded','accepted'].some(k => rawStatus.includes(k))) status = 'paid';
  else if (['refund','reversed','estornado','reembolsado','chargeback'].some(k => rawStatus.includes(k))) status = 'refunded';
  else if (['pending','waiting','pendente','aguardando','processing','created','generated'].some(k => rawStatus.includes(k))) status = 'pending';
  else if (['failed','denied','declined','negado','recusado','refused','rejected'].some(k => rawStatus.includes(k))) status = 'failed';
  else if (['cancelled','canceled','cancelado','expired','expirado','voided'].some(k => rawStatus.includes(k))) status = 'cancelled';

  const id = tx.id || tx.transaction_id || tx.charge_id || tx.payment_id ||
             tx.order_id || tx.code || tx.reference ||
             `wh_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;

  const created = tx.created_at || tx.paid_at || tx.date || tx.createdAt ||
                  tx.updated_at || tx.confirmed_at || new Date().toISOString();

  return { id: String(id), customer_name: name, customer_email: email, customer_phone: phone,
           customer_document: doc, product, amount, payment_method: method,
           status, dhr_status: rawStatus, created_at: created };
}

// ═══════════════════════════════════════
//  CRM
// ═══════════════════════════════════════
async function sendToCRM(tx) {
  try {
    const payload = {
      event: 'venda_paga', timestamp: new Date().toISOString(),
      lead: { nome: tx.customer_name, email: tx.customer_email, telefone: tx.customer_phone, documento: tx.customer_document },
      transacao: { id: tx.id, produto: tx.product, valor: tx.amount, metodo_pagamento: tx.payment_method, data_pagamento: tx.created_at, status: tx.status },
      metadata: { source: 'dhr_shield_integration', gateway: 'shield_tecnologia', sent_at: new Date().toISOString() },
    };
    log('info', `CRM ← ${tx.customer_name || tx.id}`);
    const res = await fetch(CFG.crm.url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), timeout: 15000,
    });
    const text = await res.text().catch(() => '');
    if (res.ok) {
      Q.upCrm.run(text || 'ok', tx.id);
      log('success', `✓ CRM: ${tx.customer_name} R$ ${tx.amount}`);
      broadcast({ type: 'lead_sent', payload: { id: tx.id } });
      return true;
    }
    log('error', `CRM ${res.status}: ${text.substring(0, 200)}`);
    return false;
  } catch (e) { log('error', `CRM: ${e.message}`); return false; }
}

// ─── Process incoming transaction ───
async function processIncoming(raw) {
  const tx = normalize(raw);
  const r = Q.ins.run(tx.id, tx.customer_name, tx.customer_email, tx.customer_phone,
    tx.customer_document, tx.product, tx.amount, tx.payment_method,
    tx.status, tx.dhr_status, tx.created_at, JSON.stringify(raw));

  if (r.changes > 0) {
    log('success', `Nova transação: ${tx.customer_name || '(sem nome)'} R$ ${tx.amount} [${tx.status}]`);
    broadcast({ type: 'new_transaction', payload: tx });
    if (tx.status === 'paid' && CFG.autoSend) {
      await sendToCRM(tx);
    }
    return tx;
  }
  return null; // duplicada
}

// ═══════════════════════════════════════
//  Express
// ═══════════════════════════════════════
const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', '*');
  res.header('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Static files
for (const sp of [path.join(__dirname,'public'), path.join(process.cwd(),'public'), __dirname]) {
  try { if (fs.existsSync(sp)) app.use(express.static(sp)); } catch(e) {}
}

// ═══════════════════════════════════════
//  WEBHOOK — Aceita QUALQUER formato
//  Configure no painel DHR: POST /webhook/dhr
// ═══════════════════════════════════════
function webhookHandler(req, res) {
  try {
    const body = req.body;

    if (!body || (typeof body === 'object' && Object.keys(body).length === 0)) {
      log('info', 'Webhook vazio recebido');
      return res.json({ received: true });
    }

    log('info', `⚡ Webhook recebido [${req.path}]: ${JSON.stringify(body).substring(0, 400)}`);

    // Se for array de transações
    if (Array.isArray(body)) {
      body.forEach(item => processIncoming(item));
    }
    // Se tiver lista dentro
    else if (Array.isArray(body.data)) {
      body.data.forEach(item => processIncoming(item));
    }
    else if (Array.isArray(body.transactions)) {
      body.transactions.forEach(item => processIncoming(item));
    }
    // Evento único
    else {
      processIncoming(body);
    }

    res.json({ received: true, status: 'ok' });
  } catch (e) {
    log('error', `Webhook erro: ${e.message}`);
    res.json({ received: true, error: e.message });
  }
}

// Aceita em TODAS as rotas possíveis de webhook
app.post('/webhook/dhr', webhookHandler);
app.post('/webhook/shield', webhookHandler);
app.post('/webhook/callback', webhookHandler);
app.post('/webhook', webhookHandler);
app.post('/callback', webhookHandler);
app.post('/notification', webhookHandler);
app.post('/notify', webhookHandler);
app.post('/postback', webhookHandler);
app.post('/ipn', webhookHandler);

// ═══════════════════════════════════════
//  API (Dashboard → Server)
// ═══════════════════════════════════════
app.get('/api/stats', (req, res) => {
  const s = Q.stats.get();
  res.json({
    total: s.total || 0, paid: s.paid || 0, sent: s.sent || 0,
    pending_send: (s.paid || 0) - (s.sent || 0),
    revenue: s.revenue || 0, polling: false, auto_send: CFG.autoSend,
  });
});

app.get('/api/transactions', (req, res) => {
  res.json({ data: Q.all.all(Math.min(parseInt(req.query.limit) || 200, 1000)) });
});

app.get('/api/transactions/pending', (req, res) => {
  res.json({ data: Q.pending.all() });
});

app.post('/api/transactions/:id/send-crm', async (req, res) => {
  const tx = Q.get.get(req.params.id);
  if (!tx) return res.status(404).json({ error: '404' });
  if (tx.sent_to_crm) return res.json({ success: true, message: 'Já enviado' });
  res.json({ success: await sendToCRM(tx) });
});

app.post('/api/transactions/:id/resend-crm', async (req, res) => {
  const tx = Q.get.get(req.params.id);
  if (!tx) return res.status(404).json({ error: '404' });
  db.prepare('UPDATE transactions SET sent_to_crm=0,sent_at=NULL WHERE id=?').run(req.params.id);
  res.json({ success: await sendToCRM(tx) });
});

app.post('/api/transactions/send-all', async (req, res) => {
  const p = Q.pending.all();
  if (!p.length) return res.json({ success: true, sent: 0, total: 0 });
  let sent = 0;
  for (const tx of p) {
    if (await sendToCRM(tx)) sent++;
    await new Promise(r => setTimeout(r, 300));
  }
  res.json({ success: true, sent, total: p.length });
});

// ─── Adicionar lead manualmente ───
app.post('/api/transactions/add', async (req, res) => {
  try {
    const b = req.body;
    const tx = {
      id: `manual_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`,
      customer_name: b.name || '',
      customer_email: b.email || '',
      customer_phone: b.phone || '',
      customer_document: b.document || '',
      product: b.product || '',
      amount: parseFloat(b.amount) || 0,
      payment_method: b.method || 'manual',
      status: 'paid',
      dhr_status: 'manual',
      created_at: new Date().toISOString(),
    };
    Q.ins.run(tx.id, tx.customer_name, tx.customer_email, tx.customer_phone,
      tx.customer_document, tx.product, tx.amount, tx.payment_method,
      tx.status, tx.dhr_status, tx.created_at, JSON.stringify(b));
    log('success', `Lead manual: ${tx.customer_name} R$ ${tx.amount}`);
    broadcast({ type: 'new_transaction', payload: tx });
    if (CFG.autoSend) await sendToCRM(tx);
    res.json({ success: true, id: tx.id });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ─── Polling stubs (para compatibilidade com dashboard) ───
app.post('/api/polling/start', (req, res) => { log('info', 'Polling não disponível — use Webhook'); res.json({ success: false, message: 'API Shield não suporta listagem. Use webhook.' }); });
app.post('/api/polling/stop', (req, res) => { res.json({ success: true }); });
app.post('/api/polling/trigger', (req, res) => { log('info', 'Polling não disponível — use Webhook'); res.json({ success: false, message: 'Use webhook' }); });

app.post('/api/settings/auto-send', (req, res) => {
  CFG.autoSend = req.body.enabled !== false;
  Q.setS.run('auto_send', String(CFG.autoSend));
  res.json({ success: true, auto_send: CFG.autoSend });
});

app.get('/api/logs', (req, res) => {
  res.json({ data: Q.logs.all(Math.min(parseInt(req.query.limit) || 100, 500)) });
});

app.post('/api/reset', (req, res) => {
  db.exec('DELETE FROM transactions; DELETE FROM logs;');
  log('info', 'DB limpo');
  res.json({ success: true });
});

app.post('/api/test-crm', async (req, res) => {
  try {
    const r = await fetch(CFG.crm.url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'test', lead: { nome: 'Teste' }, transacao: { id: 'test_' + Date.now(), valor: 0 } }),
    });
    res.json({ success: r.ok, status: r.status });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ─── Webhook test (simula uma venda) ───
app.post('/api/test-webhook', async (req, res) => {
  const fake = {
    type: 'transaction.paid',
    data: {
      id: 'test_' + Date.now(),
      status: 'paid',
      amount: 97.00,
      payment_method: 'pix',
      customer: { name: 'Lead Teste', email: 'teste@exemplo.com', phone: '5511999999999', document: '12345678900' },
      product: { name: 'Produto Teste' },
      created_at: new Date().toISOString(),
    },
  };
  const tx = await processIncoming(fake);
  res.json({ success: !!tx, transaction: tx });
});

// ─── SPA Fallback ───
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/webhook')) return res.status(404).json({ error: 'Not found' });
  if (!HTML) HTML = findHtml();
  if (HTML) return res.type('html').send(HTML);
  res.type('html').send(`<!DOCTYPE html><html><body style="background:#0a0a12;color:#ccc;font-family:sans-serif;display:grid;place-items:center;min-height:100vh;margin:0">
    <div style="text-align:center"><h1 style="color:#10b981">⚡ DHR Lead Capture</h1>
    <p>Servidor rodando. <code>public/index.html</code> não encontrado.</p>
    <p><a href="/api/stats" style="color:#3b82f6">/api/stats</a></p></div></body></html>`);
});

// ═══════════════════════════════════════
//  Server + WebSocket
// ═══════════════════════════════════════
const server = http.createServer(app);
wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', ws => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'init', payload: { polling: false, auto_send: CFG.autoSend, stats: Q.stats.get() } }));
  ws.on('close', () => clients.delete(ws));
});

server.listen(CFG.port, () => {
  const webhookUrl = `http://localhost:${CFG.port}/webhook/dhr`;
  console.log(`
  ╔═══════════════════════════════════════════════════════════╗
  ║   ⚡ DHR Lead Capture — Modo Webhook                     ║
  ╠═══════════════════════════════════════════════════════════╣
  ║   Dashboard:    http://localhost:${CFG.port}
  ║   Webhook URL:  POST /webhook/dhr
  ║   Test Webhook: POST /api/test-webhook
  ║   HTML:         ${HTML ? '✓ OK' : '✗ NOT FOUND'}
  ╠═══════════════════════════════════════════════════════════╣
  ║                                                           ║
  ║   Configure no painel DHR/Shield:                         ║
  ║   URL: https://SEU-DOMINIO/webhook/dhr                    ║
  ║   Método: POST                                            ║
  ║   Eventos: transaction.paid, payment.approved             ║
  ║                                                           ║
  ╚═══════════════════════════════════════════════════════════╝
  `);
  log('info', 'Servidor iniciado (modo webhook)');
  try { const s = Q.getS.get('auto_send'); if (s) CFG.autoSend = s.value === 'true'; } catch(e) {}
});

process.on('SIGINT', () => { db.close(); server.close(); process.exit(0); });
process.on('SIGTERM', () => { db.close(); server.close(); process.exit(0); });
