// ═══════════════════════════════════════════════════════════════
//  DHR Lead Capture System - Backend Server
//  Busca transações na API Shield + Recebe Webhooks → CRM
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
    baseUrl: (process.env.DHR_BASE_URL || 'https://api.shieldtecnologia.com/v1').replace(/\/+$/, ''),
    pk: process.env.DHR_PUBLIC_KEY || '',
    sk: process.env.DHR_SECRET_KEY || '',
  },
  crm: { url: process.env.CRM_WEBHOOK_URL || '' },
  pollInterval: (parseInt(process.env.POLL_INTERVAL) || 30) * 1000,
  autoSendCRM: process.env.AUTO_SEND_CRM !== 'false',
};

// ═══════════════════════════════════════
//  Assinatura HMAC-SHA512 (Shield/Solidgate pattern)
// ═══════════════════════════════════════
function makeSignature(body = '') {
  const data = body ? (CONFIG.dhr.pk + body + CONFIG.dhr.pk) : (CONFIG.dhr.pk + CONFIG.dhr.pk);
  const hex = crypto.createHmac('sha512', CONFIG.dhr.sk).update(data).digest('hex');
  return Buffer.from(hex).toString('base64');
}

// Gera headers em vários formatos de auth pra tentar
function authSets(bodyStr = '') {
  const sig = makeSignature(bodyStr);
  return [
    // 1) Bearer com secret key (mais comum)
    { name: 'Bearer-SK', headers: { 'Authorization': `Bearer ${CONFIG.dhr.sk}` } },
    // 2) HMAC signature (Solidgate/Shield style)
    { name: 'HMAC-Sig', headers: { 'public-key': CONFIG.dhr.pk, 'signature': sig } },
    // 3) Basic auth pk:sk
    { name: 'Basic', headers: { 'Authorization': 'Basic ' + Buffer.from(CONFIG.dhr.pk + ':' + CONFIG.dhr.sk).toString('base64') } },
    // 4) X-Api-Key
    { name: 'X-Api-Key', headers: { 'X-Api-Key': CONFIG.dhr.sk } },
    // 5) Bearer com public key
    { name: 'Bearer-PK', headers: { 'Authorization': `Bearer ${CONFIG.dhr.pk}` } },
    // 6) Public + Secret headers
    { name: 'PK+SK', headers: { 'public-key': CONFIG.dhr.pk, 'secret-key': CONFIG.dhr.sk } },
    // 7) Token header
    { name: 'Token', headers: { 'Token': CONFIG.dhr.sk } },
    // 8) Merchant style
    { name: 'Merchant', headers: { 'merchant-id': CONFIG.dhr.pk, 'Authorization': `Bearer ${CONFIG.dhr.sk}` } },
  ];
}

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
  CREATE INDEX IF NOT EXISTS idx_st ON transactions(status);
  CREATE INDEX IF NOT EXISTS idx_crm ON transactions(sent_to_crm);
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
  const t = new Date().toISOString();
  console.log(`[${t}] [${type.toUpperCase()}] ${msg}`);
  try { Q.log.run(type, msg, data ? JSON.stringify(data) : null); } catch(e) {}
  broadcast({ type: 'log', payload: { type, message: msg, time: t } });
}

// ═══════════════════════════════════════
//  SHIELD API - Buscar Transações (POLLING)
// ═══════════════════════════════════════

// Endpoints pra tentar (do mais comum ao menos)
const API_ENDPOINTS = [
  '/transactions', '/transaction',
  '/charges', '/charge',
  '/payments', '/payment',
  '/orders', '/order',
  '/sales', '/sale',
  '/invoices', '/invoice',
  '/subscriptions',
];

// Query params pra tentar
const QUERY_PATTERNS = [
  '?page=1&status=paid',
  '?page=1&filter[status]=paid',
  '?page=1',
  '?status=paid&limit=50',
  '?limit=50',
  '',
];

async function tryRequest(url, headers, method = 'GET', body = null) {
  try {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', ...headers },
      timeout: 10000,
    };
    if (body) opts.body = typeof body === 'string' ? body : JSON.stringify(body);
    const res = await fetch(url, opts);
    const text = await res.text();

    // Se retorna HTML é 404 page, ignora
    if (text.includes('<!DOCTYPE') || text.includes('<html')) {
      return { ok: false, status: res.status, html: true };
    }

    let data;
    try { data = JSON.parse(text); } catch(e) { data = text; }

    return { ok: res.ok, status: res.status, data, text: text.substring(0, 300) };
  } catch (e) {
    return { ok: false, status: 'ERR', error: e.message };
  }
}

// Endpoint que já sabemos que funciona (salvo em settings)
let workingConfig = null; // { endpoint, query, auth, method }

async function fetchTransactions() {
  const base = CONFIG.dhr.baseUrl;

  // 1) Se já temos endpoint que funciona, usa direto
  if (workingConfig) {
    const url = `${base}${workingConfig.endpoint}${workingConfig.query}`;
    const auths = authSets();
    const auth = auths.find(a => a.name === workingConfig.auth) || auths[0];
    const body = workingConfig.method === 'POST' ? JSON.stringify({ page: 1, status: 'paid', per_page: 50 }) : null;
    const r = await tryRequest(url, auth.headers, workingConfig.method, body);

    if (r.ok) {
      log('success', `Endpoint ${workingConfig.method} ${workingConfig.endpoint} [${workingConfig.auth}] → ${r.status}`);
      return r.data;
    }
    // Se parou de funcionar, reseta
    log('info', `Endpoint salvo parou de funcionar (${r.status}), redescobring...`);
    workingConfig = null;
  }

  // 2) Tenta restaurar de settings
  try {
    const saved = Q.getS.get('working_config');
    if (saved && !workingConfig) {
      workingConfig = JSON.parse(saved.value);
      return await fetchTransactions(); // recursão 1x
    }
  } catch(e) {}

  // 3) Descobre endpoint — testa tudo
  log('info', 'Descobrindo endpoints da API Shield...');

  for (const authSet of authSets()) {
    for (const ep of API_ENDPOINTS) {
      // GET com vários query patterns
      for (const qp of QUERY_PATTERNS) {
        const url = `${base}${ep}${qp}`;
        const r = await tryRequest(url, authSet.headers, 'GET');

        if (r.ok) {
          log('success', `✓ ENCONTRADO: GET ${ep}${qp} [${authSet.name}] → ${r.status}`);
          workingConfig = { endpoint: ep, query: qp, auth: authSet.name, method: 'GET' };
          Q.setS.run('working_config', JSON.stringify(workingConfig));
          return r.data;
        }

        if (r.status === 401 || r.status === 403) {
          log('info', `${ep} [${authSet.name}] → ${r.status} (auth rejeitada)`);
          break; // pula pra próxima auth nesse endpoint
        }

        if (!r.html && r.status !== 404 && r.status !== 'ERR') {
          log('info', `${ep}${qp} [${authSet.name}] → ${r.status}: ${r.text || r.error || ''}`);
        }
      }

      // POST (alguns gateways usam POST pra listar)
      const postBody = JSON.stringify({ page: 1, status: 'paid', per_page: 50, limit: 50 });
      const rp = await tryRequest(`${base}${ep}`, authSet.headers, 'POST', postBody);
      if (rp.ok) {
        log('success', `✓ ENCONTRADO: POST ${ep} [${authSet.name}] → ${rp.status}`);
        workingConfig = { endpoint: ep, query: '', auth: authSet.name, method: 'POST' };
        Q.setS.run('working_config', JSON.stringify(workingConfig));
        return rp.data;
      }

      // POST /list pattern
      const rl = await tryRequest(`${base}${ep}/list`, authSet.headers, 'POST', postBody);
      if (rl.ok) {
        log('success', `✓ ENCONTRADO: POST ${ep}/list [${authSet.name}] → ${rl.status}`);
        workingConfig = { endpoint: `${ep}/list`, query: '', auth: authSet.name, method: 'POST' };
        Q.setS.run('working_config', JSON.stringify(workingConfig));
        return rl.data;
      }
    }
  }

  log('error', 'Nenhum endpoint da API Shield respondeu. Verifique a documentação ou use webhooks.');
  return null;
}

// ─── Normalizar transação ───
function normalize(raw) {
  const tx = raw.data || raw.transaction || raw.charge || raw.payment || raw;
  return {
    id: tx.id || tx.transaction_id || tx.charge_id || tx.code || `dhr_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
    customer_name: tx.customer?.name || tx.buyer?.name || tx.payer?.name || tx.name || '',
    customer_email: tx.customer?.email || tx.buyer?.email || tx.payer?.email || tx.email || '',
    customer_phone: tx.customer?.phone || tx.customer?.phone_number || tx.customer?.cellphone || tx.buyer?.phone || tx.phone || tx.cellphone || '',
    customer_document: tx.customer?.document || tx.customer?.cpf || tx.customer?.document_number || tx.buyer?.cpf || tx.cpf || tx.document || '',
    product: tx.product?.name || tx.items?.[0]?.name || tx.description || tx.product_name || tx.offer?.name || tx.plan?.name || '',
    amount: parseAmount(tx.amount || tx.value || tx.total || tx.price || 0),
    payment_method: tx.payment_method || tx.method || tx.type || tx.payment?.method || 'unknown',
    status: normStatus(tx.status || tx.payment_status || tx.payment?.status || ''),
    dhr_status: tx.status || '',
    created_at: tx.created_at || tx.paid_at || tx.date || tx.createdAt || tx.updated_at || new Date().toISOString(),
  };
}

function parseAmount(v) {
  if (typeof v === 'string') v = parseFloat(v.replace(/[^\d.,]/g, '').replace(',', '.'));
  if (isNaN(v)) return 0;
  return v > 10000 ? v / 100 : v;
}

function normStatus(s) {
  const str = String(s).toLowerCase();
  if (['paid','approved','confirmed','completed','captured','autorizado','pago','aprovado','active','succeeded'].some(k => str.includes(k))) return 'paid';
  if (['refund','reversed','estornado','reembolsado'].some(k => str.includes(k))) return 'refunded';
  if (['pending','waiting','pendente','aguardando','processing','created'].some(k => str.includes(k))) return 'pending';
  if (['failed','denied','declined','negado','recusado','refused'].some(k => str.includes(k))) return 'failed';
  if (['cancelled','canceled','cancelado','expired'].some(k => str.includes(k))) return 'cancelled';
  return 'unknown';
}

// ─── CRM ───
async function sendToCRM(tx) {
  try {
    const payload = {
      event: 'venda_paga', timestamp: new Date().toISOString(),
      lead: { nome: tx.customer_name, email: tx.customer_email, telefone: tx.customer_phone, documento: tx.customer_document },
      transacao: { id: tx.id, produto: tx.product, valor: tx.amount, metodo_pagamento: tx.payment_method, data_pagamento: tx.created_at, status: tx.status },
      metadata: { source: 'dhr_shield_integration', gateway: 'shield_tecnologia', auto_sent: true, sent_at: new Date().toISOString() },
    };
    log('info', `CRM ← ${tx.customer_name} (${tx.id})`);
    const res = await fetch(CONFIG.crm.url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), timeout: 15000,
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
}

// ─── Processar transação ───
function processTx(raw) {
  const tx = normalize(raw);
  const r = Q.ins.run(tx.id, tx.customer_name, tx.customer_email, tx.customer_phone, tx.customer_document, tx.product, tx.amount, tx.payment_method, tx.status, tx.dhr_status, tx.created_at, JSON.stringify(raw));
  if (r.changes > 0) {
    log('success', `Nova transação: ${tx.customer_name} R$ ${tx.amount} [${tx.status}]`);
    broadcast({ type: 'new_transaction', payload: tx });
    return tx;
  }
  return null;
}

async function processAndSend(raw) {
  const tx = processTx(raw);
  if (tx && tx.status === 'paid' && CONFIG.autoSendCRM) await sendToCRM(tx);
  return tx;
}

// ═══════════════════════════════════════
//  POLLING ENGINE
// ═══════════════════════════════════════
let pollTimer = null;
let isPolling = false;

async function doPoll() {
  if (isPolling) return;
  isPolling = true;
  try {
    log('info', 'Consultando API Shield/DHR...');
    const data = await fetchTransactions();

    if (data) {
      // Extrair array de transações da resposta (vários formatos possíveis)
      const txs = data.data || data.transactions || data.charges || data.payments ||
        data.orders || data.sales || data.items || data.results ||
        data.records || data.content || (Array.isArray(data) ? data : []);

      if (Array.isArray(txs) && txs.length > 0) {
        let newCount = 0;
        for (const raw of txs) {
          const tx = await processAndSend(raw);
          if (tx) newCount++;
        }
        log('info', `Poll concluído: ${newCount} nova(s) de ${txs.length} transações`);
      } else {
        log('info', 'API respondeu mas sem transações novas');
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
  doPoll(); // executa imediatamente
  pollTimer = setInterval(doPoll, CONFIG.pollInterval);
  log('info', `🟢 Polling iniciado (intervalo: ${CONFIG.pollInterval / 1000}s)`);
  broadcast({ type: 'polling_status', payload: { active: true } });
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  log('info', '🔴 Polling parado');
  broadcast({ type: 'polling_status', payload: { active: false } });
}

// ═══════════════════════════════════════
//  EXPRESS APP
// ═══════════════════════════════════════
const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', '*');
  res.header('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Static files
for (const sp of [path.join(__dirname, 'public'), path.join(process.cwd(), 'public'), __dirname]) {
  try { if (fs.existsSync(sp)) app.use(express.static(sp)); } catch(e) {}
}

// ─── WEBHOOK (recebe eventos da DHR/Shield) ───
app.post('/webhook/dhr', async (req, res) => {
  try {
    const ev = req.body;
    log('info', `Webhook recebido: ${JSON.stringify(ev).substring(0, 300)}`);
    const evType = (ev.type || ev.event || ev.action || '').toLowerCase();
    const paidKW = ['paid','approved','completed','confirmed','captured','pago','aprovado','succeeded'];

    if (paidKW.some(k => evType.includes(k)) || paidKW.some(k => String(ev.status || ev.data?.status || '').toLowerCase().includes(k))) {
      await processAndSend(ev.data || ev);
    } else {
      const raw = ev.data || ev;
      if (raw.customer || raw.buyer || raw.amount || raw.value || raw.status) {
        await processAndSend(raw);
      } else {
        log('info', `Evento ignorado: ${evType || 'desconhecido'}`);
      }
    }
    res.json({ received: true });
  } catch (e) { log('error', `Webhook: ${e.message}`); res.json({ received: true }); }
});
app.post('/webhook/callback', (req, res) => { req.url = '/webhook/dhr'; app.handle(req, res); });
app.post('/webhook/shield', (req, res) => { req.url = '/webhook/dhr'; app.handle(req, res); });

// ─── API ENDPOINTS ───
app.get('/api/stats', (req, res) => {
  const s = Q.stats.get();
  res.json({
    total: s.total || 0, paid: s.paid || 0, sent: s.sent || 0,
    pending_send: (s.paid || 0) - (s.sent || 0),
    revenue: s.revenue || 0, polling: !!pollTimer, auto_send: CONFIG.autoSendCRM,
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
  if (!tx) return res.status(404).json({ error: 'Não encontrada' });
  if (tx.sent_to_crm) return res.json({ success: true, message: 'Já enviado' });
  res.json({ success: await sendToCRM(tx) });
});

app.post('/api/transactions/:id/resend-crm', async (req, res) => {
  const tx = Q.get.get(req.params.id);
  if (!tx) return res.status(404).json({ error: 'Não encontrada' });
  db.prepare('UPDATE transactions SET sent_to_crm=0, sent_at=NULL WHERE id=?').run(req.params.id);
  res.json({ success: await sendToCRM(tx) });
});

app.post('/api/transactions/send-all', async (req, res) => {
  const p = Q.pending.all();
  if (!p.length) return res.json({ success: true, sent: 0, total: 0 });
  log('info', `Enviando ${p.length} leads em lote...`);
  let sent = 0;
  for (const tx of p) { if (await sendToCRM(tx)) sent++; await new Promise(r => setTimeout(r, 500)); }
  res.json({ success: true, sent, total: p.length });
});

// ─── POLLING CONTROLS ───
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

// ─── SETTINGS ───
app.post('/api/settings/auto-send', (req, res) => {
  CONFIG.autoSendCRM = req.body.enabled !== false;
  Q.setS.run('auto_send', String(CONFIG.autoSendCRM));
  res.json({ success: true, auto_send: CONFIG.autoSendCRM });
});

app.post('/api/settings/poll-interval', (req, res) => {
  const s = Math.max(10, Math.min(300, parseInt(req.body.seconds) || 30));
  CONFIG.pollInterval = s * 1000;
  Q.setS.run('poll_interval', String(s));
  if (pollTimer) { stopPolling(); startPolling(); }
  res.json({ success: true, interval: s });
});

app.get('/api/logs', (req, res) => {
  res.json({ data: Q.logs.all(Math.min(parseInt(req.query.limit) || 100, 500)) });
});

app.post('/api/reset', (req, res) => {
  db.exec('DELETE FROM transactions; DELETE FROM logs;');
  workingConfig = null;
  try { Q.setS.run('working_config', ''); } catch(e) {}
  log('info', 'Banco limpo');
  res.json({ success: true });
});

app.post('/api/test-crm', async (req, res) => {
  try {
    const r = await fetch(CONFIG.crm.url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'test', lead: { nome: 'Teste' }, transacao: { id: 'test_' + Date.now(), valor: 0 } }),
    });
    res.json({ success: r.ok, status: r.status });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.post('/api/test-dhr', async (req, res) => {
  try {
    workingConfig = null; // força redescoberta
    const data = await fetchTransactions();
    res.json({ success: !!data, data: data ? 'Conectado' : 'Sem resposta' });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ─── SPA fallback ───
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/webhook/')) return res.status(404).json({ error: 'Not found' });
  if (!HTML) HTML = findHtml();
  if (HTML) return res.type('html').send(HTML);
  res.type('html').send(`<!DOCTYPE html><html><body style="background:#0a0a12;color:#ccc;font-family:sans-serif;display:grid;place-items:center;min-height:100vh;margin:0">
    <div style="text-align:center"><h1 style="color:#10b981">⚡ DHR Lead Capture</h1>
    <p>Servidor rodando. <code>public/index.html</code> não encontrado.</p>
    <p><a href="/api/stats" style="color:#3b82f6">/api/stats</a></p></div></body></html>`);
});

// ═══════════════════════════════════════
//  SERVER + WEBSOCKET
// ═══════════════════════════════════════
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
  ║   ⚡ DHR Lead Capture System                         ║
  ╠═══════════════════════════════════════════════════════╣
  ║   Dashboard:  http://localhost:${CONFIG.port}
  ║   Webhook:    http://localhost:${CONFIG.port}/webhook/dhr
  ║   API:        http://localhost:${CONFIG.port}/api/stats
  ║   WebSocket:  ws://localhost:${CONFIG.port}/ws
  ╠═══════════════════════════════════════════════════════╣
  ║   DHR API:    ${CONFIG.dhr.baseUrl}
  ║   Auto CRM:   ${CONFIG.autoSendCRM}
  ║   Poll:       ${CONFIG.pollInterval / 1000}s
  ║   HTML:       ${HTML ? '✓ OK' : '✗ NOT FOUND'}
  ╚═══════════════════════════════════════════════════════╝
  `);

  log('info', 'Servidor iniciado');

  // Restaura configurações
  try { const s = Q.getS.get('auto_send'); if (s) CONFIG.autoSendCRM = s.value === 'true'; } catch(e) {}
  try { const s = Q.getS.get('poll_interval'); if (s) CONFIG.pollInterval = parseInt(s.value) * 1000; } catch(e) {}

  // ═══ AUTO-START POLLING ═══
  startPolling();
});

process.on('SIGINT', () => { stopPolling(); db.close(); server.close(); process.exit(0); });
process.on('SIGTERM', () => { stopPolling(); db.close(); server.close(); process.exit(0); });
