// ═══════════════════════════════════════════════════════════════
//  DHR Lead Capture → CRM DataCrazy
//  - Busca transações da Shield API (Basic Auth)
//  - Extrai leads com nome + telefone
//  - Valida números de telefone BR
//  - NÃO envia ao CRM automaticamente (só manual)
// ═══════════════════════════════════════════════════════════════

import express from 'express';
import fetch from 'node-fetch';
import fs from 'fs/promises';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { decodePIX } from './pix-decoder.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFIG = {
  PORT: process.env.PORT || 3005,
  DHR_PUBLIC_KEY: process.env.DHR_PUBLIC_KEY || 'pk_WNNg2i_r8_iqeG3XrdJFI_q1I8ihd1yLoUa08Ip0LKaqxXxE',
  DHR_SECRET_KEY: process.env.DHR_SECRET_KEY || 'sk_jz1yyIaa0Dw2OWhMH0r16gUgWZ7N2PCpb6aK1crKPIFq02aD',
  DHR_API_URL: process.env.DHR_API_URL || 'https://api.shieldtecnologia.com/v1',
  CRM_WEBHOOK_URL: process.env.CRM_WEBHOOK_URL || 'https://api.datacrazy.io/v1/crm/api/crm/flows/webhooks/a3161e6d-6f4d-4b16-a1b5-16bcb9641994/76e41ac2-564a-4ff6-9e28-ceee490c6544',
  POLL_INTERVAL: 30000,
  AUTO_SEND_CRM: false,
  MAX_RETRIES: 5,
  BATCH_SIZE: 3,
  BATCH_DELAY: 1500,
};

const FILES = {
  cache: path.join(__dirname, 'transactions_cache.json'),
  leads: path.join(__dirname, 'leads_sent.json'),
  progress: path.join(__dirname, 'fetch_progress.json'),
};

let txCache = { data: [], lastUpdate: 0, isLoading: false };
let leadsSent = {};
let systemLogs = [];
const wsClients = new Set();

// ═══════════════════════════════════════
//  UTILITÁRIOS
// ═══════════════════════════════════════

async function loadJSON(filepath, fallback) {
  try { return JSON.parse(await fs.readFile(filepath, 'utf-8')); }
  catch { return fallback; }
}

async function saveJSON(filepath, data) {
  try { await fs.writeFile(filepath, JSON.stringify(data)); }
  catch (e) { console.error(`Erro salvando ${filepath}:`, e.message); }
}

function broadcast(msg) {
  const str = JSON.stringify(msg);
  wsClients.forEach(ws => { if (ws.readyState === 1) ws.send(str); });
}

function addLog(type, message) {
  const entry = { type, message, time: new Date().toISOString() };
  const icon = type === 'success' ? '✅' : type === 'error' ? '❌' : 'ℹ️';
  console.log(`${icon} ${message}`);
  systemLogs.unshift(entry);
  if (systemLogs.length > 500) systemLogs.length = 500;
  broadcast({ type: 'log', payload: entry });
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ═══════════════════════════════════════
//  VALIDAÇÃO DE TELEFONE BR
// ═══════════════════════════════════════

function validatePhoneBR(raw) {
  if (!raw) return { valid: false, reason: 'vazio', formatted: '', digits: '', whatsapp: null };

  let digits = String(raw).replace(/\D/g, '');
  if (!digits) return { valid: false, reason: 'vazio', formatted: '', digits: '', whatsapp: null };

  // Remover +55 se tiver
  if (digits.startsWith('55') && digits.length >= 12) digits = digits.substring(2);

  if (digits.length < 10 || digits.length > 11) {
    return { valid: false, reason: `${digits.length} dígitos`, formatted: '', digits, whatsapp: null };
  }

  const ddd = digits.substring(0, 2);
  const dddNum = parseInt(ddd);
  const dddsInvalidos = [0,1,2,3,4,5,6,7,8,9,10,20,23,25,26,29,30,36,39,40,50,52,56,57,58,59,60,70,72,76,78,80,90];
  if (dddsInvalidos.includes(dddNum)) {
    return { valid: false, reason: `DDD ${ddd} inválido`, formatted: '', digits, whatsapp: null };
  }

  const rest = digits.substring(2);

  // Número com dígitos todos iguais = falso
  if (/^(\d)\1+$/.test(rest)) {
    return { valid: false, reason: 'número falso', formatted: '', digits, whatsapp: null };
  }

  // Celular: 11 dígitos, começa com 9
  if (digits.length === 11) {
    if (rest[0] !== '9') {
      return { valid: false, reason: 'celular deve começar com 9', formatted: '', digits, whatsapp: null };
    }
    const formatted = `(${ddd}) ${rest[0]}${rest.substring(1,5)}-${rest.substring(5)}`;
    return { valid: true, reason: 'celular', formatted, digits, whatsapp: `55${digits}` };
  }

  // Fixo: 10 dígitos
  if (digits.length === 10) {
    const f = parseInt(rest[0]);
    if (f < 2 || f > 5) {
      return { valid: false, reason: 'fixo deve começar com 2-5', formatted: '', digits, whatsapp: null };
    }
    const formatted = `(${ddd}) ${rest.substring(0,4)}-${rest.substring(4)}`;
    return { valid: true, reason: 'fixo', formatted, digits, whatsapp: null };
  }

  return { valid: false, reason: 'formato inválido', formatted: '', digits, whatsapp: null };
}

// ═══════════════════════════════════════
//  SHIELD API — COM PROTEÇÃO RATE LIMIT
// ═══════════════════════════════════════

function getAuth() {
  return 'Basic ' + Buffer.from(`${CONFIG.DHR_PUBLIC_KEY}:${CONFIG.DHR_SECRET_KEY}`).toString('base64');
}

async function fetchDHR(endpoint, retries = CONFIG.MAX_RETRIES) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(`${CONFIG.DHR_API_URL}${endpoint}`, {
        headers: { 'Authorization': getAuth(), 'Connection': 'keep-alive' },
        timeout: 30000,
      });

      if (response.status === 429) {
        const waitSec = Math.pow(2, attempt) * 5;
        addLog('info', `⏳ Rate limit (429) — aguardando ${waitSec}s`);
        await delay(waitSec * 1000);
        continue;
      }

      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      if (attempt === retries) throw error;
      await delay(Math.min(CONFIG.BATCH_DELAY * attempt, 10000));
    }
  }
}

// Buscar TODAS (com resume + rate limit)
async function fetchAllTransactions() {
  if (txCache.isLoading) { addLog('info', 'Busca em andamento...'); return txCache.data; }

  txCache.isLoading = true;
  addLog('info', 'Buscando TODAS as transações da API Shield...');
  broadcast({ type: 'loading', payload: true });

  const pageSize = 500;

  try {
    const saved = await loadJSON(FILES.progress, null);
    let all = [];
    let startPage = 2;
    let totalPages = 0;
    let totalRecords = 0;

    if (saved?.transactions?.length > 0 && saved?.nextPage > 2) {
      all = saved.transactions;
      startPage = saved.nextPage;
      totalPages = saved.totalPages;
      totalRecords = saved.totalRecords;
      addLog('success', `♻️ Retomando: ${all.length} tx, página ${startPage}/${totalPages}`);
    } else {
      const first = await fetchDHR(`/transactions?page=1&pageSize=${pageSize}`);
      all = first.data || [];
      const pag = first.pagination || {};
      totalPages = pag.totalPages || 1;
      totalRecords = pag.totalRecords || 0;
      addLog('info', `Total: ${totalRecords} transações em ${totalPages} páginas`);
    }

    if (totalPages > 1) {
      const pages = [];
      for (let p = startPage; p <= totalPages; p++) pages.push(p);

      let errCount = 0;

      for (let i = 0; i < pages.length; i += CONFIG.BATCH_SIZE) {
        const batch = pages.slice(i, i + CONFIG.BATCH_SIZE);

        try {
          const results = await Promise.all(batch.map(p => fetchDHR(`/transactions?page=${p}&pageSize=${pageSize}`)));
          results.forEach(d => { if (d?.data) all = all.concat(d.data); });
          errCount = 0;
        } catch (err) {
          errCount++;
          if (errCount >= 3) {
            addLog('info', `💾 Salvando progresso: ${all.length} transações`);
            await saveJSON(FILES.progress, { transactions: all, nextPage: batch[0], totalPages, totalRecords, savedAt: Date.now() });

            if (all.length > 0) {
              all.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
              txCache.data = all;
              txCache.lastUpdate = Date.now();
              await saveJSON(FILES.cache, { data: all, lastUpdate: txCache.lastUpdate });
              broadcast({ type: 'new_transactions', payload: { count: all.length } });
              addLog('success', `📦 Cache parcial: ${all.length} transações`);
            }

            addLog('info', '⏳ Aguardando 60s...');
            await delay(60000);
            errCount = 0;
            i -= CONFIG.BATCH_SIZE;
            continue;
          }
          addLog('error', `Erro lote: ${err.message}`);
        }

        const pct = Math.min(100, Math.round((i + CONFIG.BATCH_SIZE) / pages.length * 100));
        addLog('info', `Progresso: ${pct}% (${all.length} transações)`);

        if ((i + CONFIG.BATCH_SIZE) % 150 === 0) {
          await saveJSON(FILES.progress, { transactions: all, nextPage: batch[batch.length-1]+1, totalPages, totalRecords, savedAt: Date.now() });
          addLog('info', `💾 Checkpoint: ${all.length}`);
        }

        await delay(CONFIG.BATCH_DELAY);
      }
    }

    all.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    txCache.data = all;
    txCache.lastUpdate = Date.now();
    txCache.isLoading = false;

    await saveJSON(FILES.cache, { data: all, lastUpdate: txCache.lastUpdate });
    await saveJSON(FILES.progress, null);

    addLog('success', `✅ Cache COMPLETO: ${all.length} transações`);
    broadcast({ type: 'loading', payload: false });
    broadcast({ type: 'new_transactions', payload: { count: all.length } });
    return all;

  } catch (err) {
    txCache.isLoading = false;
    addLog('error', `Erro: ${err.message}`);
    broadcast({ type: 'loading', payload: false });
    return txCache.data;
  }
}

async function fetchNewTransactions() {
  if (txCache.isLoading) return;
  if (txCache.data.length === 0) return await fetchAllTransactions();

  txCache.isLoading = true;
  try {
    const data = await fetchDHR('/transactions?page=1&pageSize=100');
    const newTxs = data.data || [];
    if (!newTxs.length) { txCache.isLoading = false; return; }

    const existingIds = new Set(txCache.data.map(t => t.id));
    const brandNew = newTxs.filter(t => !existingIds.has(t.id));

    if (brandNew.length > 0) {
      addLog('success', `🆕 ${brandNew.length} novas transações!`);
      txCache.data = [...brandNew, ...txCache.data];
      txCache.lastUpdate = Date.now();
      await saveJSON(FILES.cache, { data: txCache.data, lastUpdate: txCache.lastUpdate });
      broadcast({ type: 'new_transactions', payload: { count: brandNew.length } });
    }

    let updated = 0;
    for (const nt of newTxs) {
      const ex = txCache.data.find(t => t.id === nt.id);
      if (ex && ex.status !== nt.status) { Object.assign(ex, nt); updated++; }
    }
    if (updated > 0) {
      addLog('info', `${updated} transações atualizadas`);
      await saveJSON(FILES.cache, { data: txCache.data, lastUpdate: txCache.lastUpdate });
    }
  } catch (err) { addLog('error', `Erro incremental: ${err.message}`); }
  txCache.isLoading = false;
}

// ═══════════════════════════════════════
//  CRM (SÓ MANUAL)
// ═══════════════════════════════════════

function buildCRMPayload(tx) {
  const phone = validatePhoneBR(tx.customer?.phone);
  return {
    event: 'venda_paga', timestamp: new Date().toISOString(),
    lead: {
      nome: tx.customer?.name || '', email: tx.customer?.email || '',
      telefone: phone.formatted || tx.customer?.phone || '',
      telefone_valido: phone.valid, telefone_whatsapp: phone.whatsapp || '',
      documento: tx.customer?.document?.number || '',
    },
    transacao: {
      id: tx.id, produto: tx.items?.[0]?.title || '',
      valor: (tx.amount||0)/100, valor_liquido: (tx.fee?.netAmount||0)/100,
      metodo_pagamento: tx.paymentMethod || '', parcelas: tx.installments || 1,
      data_pagamento: tx.createdAt, status: tx.status,
    },
  };
}

async function sendLeadToCRM(tx) {
  if (!CONFIG.CRM_WEBHOOK_URL) return false;
  if (leadsSent[tx.id]) return true;
  const name = tx.customer?.name || 'Desconhecido';
  const amount = ((tx.amount||0)/100).toFixed(2);
  try {
    addLog('info', `CRM ← ${name} R$ ${amount}`);
    const res = await fetch(CONFIG.CRM_WEBHOOK_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildCRMPayload(tx)), timeout: 15000,
    });
    const text = await res.text().catch(() => '');
    if (res.ok) {
      leadsSent[tx.id] = { sentAt: new Date().toISOString(), ok: true };
      await saveJSON(FILES.leads, leadsSent);
      addLog('success', `CRM ✓ ${name} - R$ ${amount}`);
      broadcast({ type: 'lead_sent', payload: { id: tx.id, name, amount } });
      return true;
    } else {
      leadsSent[tx.id] = { sentAt: new Date().toISOString(), ok: false, error: `${res.status}` };
      await saveJSON(FILES.leads, leadsSent);
      addLog('error', `CRM erro ${res.status}: ${text.substring(0,100)}`);
      return false;
    }
  } catch (e) { addLog('error', `CRM falhou: ${e.message}`); return false; }
}

// ═══════════════════════════════════════
//  LEADS — EXTRAÇÃO
// ═══════════════════════════════════════

function getLeads(txs, phoneFilter) {
  const map = {};
  txs.forEach(t => {
    const key = t.customer?.document?.number || t.customer?.email || t.customer?.name;
    if (!key) return;
    if (!map[key]) {
      const phone = validatePhoneBR(t.customer?.phone);
      map[key] = {
        document: t.customer?.document?.number || '', name: t.customer?.name || '',
        email: t.customer?.email || '', phoneRaw: t.customer?.phone || '',
        phoneFormatted: phone.formatted, phoneValid: phone.valid,
        phoneType: phone.reason, whatsapp: phone.whatsapp || '',
        firstPurchase: t.createdAt, lastPurchase: t.createdAt,
        totalPurchases: 0, paidPurchases: 0, totalSpent: 0,
        products: new Set(), crmStatus: 'pending',
      };
    }
    const l = map[key];
    l.totalPurchases++;
    if (t.status === 'paid') {
      l.paidPurchases++; l.totalSpent += (t.amount||0)/100;
      if (leadsSent[t.id]) l.crmStatus = 'sent';
    }
    if (new Date(t.createdAt) < new Date(l.firstPurchase)) l.firstPurchase = t.createdAt;
    if (new Date(t.createdAt) > new Date(l.lastPurchase)) l.lastPurchase = t.createdAt;
    if (t.items?.[0]?.title) l.products.add(t.items[0].title.split(' - ')[0].trim());
  });

  let leads = Object.values(map).map(l => ({ ...l, products: Array.from(l.products).join(', ') }));
  if (phoneFilter === 'valid') leads = leads.filter(l => l.phoneValid);
  else if (phoneFilter === 'invalid') leads = leads.filter(l => !l.phoneValid && l.phoneRaw);
  else if (phoneFilter === 'whatsapp') leads = leads.filter(l => l.whatsapp);
  else if (phoneFilter === 'no_phone') leads = leads.filter(l => !l.phoneRaw);
  return leads.sort((a, b) => new Date(b.lastPurchase) - new Date(a.lastPurchase));
}

function applyFilters(txs, filters) {
  let r = [...txs];
  if (filters.startDate) { const s = new Date(filters.startDate+'T00:00:00-03:00').getTime(); r = r.filter(t => new Date(t.createdAt).getTime() >= s); }
  if (filters.endDate) { const e = new Date(filters.endDate+'T23:59:59-03:00').getTime(); r = r.filter(t => new Date(t.createdAt).getTime() <= e); }
  if (filters.status === 'paid') r = r.filter(t => t.status === 'paid');
  else if (filters.status === 'pending') r = r.filter(t => ['waiting_payment','pending'].includes(t.status));
  if (filters.paymentMethod && filters.paymentMethod !== 'all') r = r.filter(t => t.paymentMethod === filters.paymentMethod);
  if (filters.search) {
    const q = filters.search.toLowerCase();
    r = r.filter(t => (t.customer?.name||'').toLowerCase().includes(q) || (t.customer?.email||'').toLowerCase().includes(q) || (t.customer?.document?.number||'').includes(q) || (t.customer?.phone||'').includes(q) || (t.id||'').toLowerCase().includes(q));
  }
  return r;
}

function getStats(txs) {
  const paid = txs.filter(t => t.status === 'paid');
  const pending = txs.filter(t => ['waiting_payment','pending'].includes(t.status));
  const sentCount = paid.filter(t => leadsSent[t.id]).length;
  const phoneStats = { valid: 0, invalid: 0, empty: 0, whatsapp: 0 };
  const seen = new Set();
  txs.forEach(t => {
    const key = t.customer?.document?.number || t.customer?.email;
    if (!key || seen.has(key)) return; seen.add(key);
    if (!t.customer?.phone) { phoneStats.empty++; return; }
    const v = validatePhoneBR(t.customer.phone);
    if (v.valid) { phoneStats.valid++; if (v.whatsapp) phoneStats.whatsapp++; }
    else phoneStats.invalid++;
  });
  return {
    total: txs.length, paid: paid.length, pending: pending.length,
    revenue: paid.reduce((s,t) => s+(t.amount||0),0)/100,
    netRevenue: paid.reduce((s,t) => s+(t.fee?.netAmount||0),0)/100,
    avgTicket: paid.length ? paid.reduce((s,t) => s+(t.amount||0),0)/paid.length/100 : 0,
    conversion: txs.length ? (paid.length/txs.length*100).toFixed(1) : 0,
    sentToCRM: sentCount, pendingCRM: paid.length - sentCount,
    auto_send: CONFIG.AUTO_SEND_CRM, cacheAge: Date.now()-txCache.lastUpdate,
    isLoading: txCache.isLoading, uniqueLeads: seen.size, phoneStats,
  };
}

// ═══════════════════════════════════════
//  EXPRESS
// ═══════════════════════════════════════

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/stats', (req, res) => res.json(getStats(applyFilters(txCache.data, req.query))));

app.get('/api/transactions', (req, res) => {
  const txs = applyFilters(txCache.data, req.query);
  const page = parseInt(req.query.page)||1;
  const pageSize = parseInt(req.query.pageSize)||50;
  const start = (page-1)*pageSize;
  res.json({
    data: txs.slice(start, start+pageSize).map(t => ({
      ...t, crmStatus: leadsSent[t.id] ? 'sent' : (t.status==='paid'?'pending':'n/a'),
      crmSentAt: leadsSent[t.id]?.sentAt || null,
    })),
    pagination: { page, pageSize, totalRecords: txs.length, totalPages: Math.ceil(txs.length/pageSize) },
  });
});

app.get('/api/leads', (req, res) => {
  const txs = applyFilters(txCache.data, req.query);
  res.json(getLeads(txs, req.query.phoneFilter || ''));
});

app.get('/api/sales', (req, res) => {
  const txs = applyFilters(txCache.data, req.query);
  res.json(txs.filter(t => t.status === 'paid').map(t => {
    const ph = validatePhoneBR(t.customer?.phone);
    return {
      id: t.id, date: t.createdAt, customer: t.customer?.name||'N/A',
      email: t.customer?.email||'N/A', phone: ph.formatted || t.customer?.phone||'N/A',
      phoneValid: ph.valid, whatsapp: ph.whatsapp||'',
      document: t.customer?.document?.number||'N/A', product: t.items?.[0]?.title||'N/A',
      amount: (t.amount||0)/100, netAmount: (t.fee?.netAmount||0)/100,
      method: t.paymentMethod||'N/A', installments: t.installments||1,
      crmStatus: leadsSent[t.id] ? 'sent' : 'pending', crmSentAt: leadsSent[t.id]?.sentAt||null,
    };
  }));
});

app.get('/api/products', (req, res) => {
  const p = new Set();
  txCache.data.forEach(t => { if (t.items?.[0]?.title) p.add(t.items[0].title.split(' - ')[0].trim()); });
  res.json(Array.from(p).sort());
});

app.get('/api/logs', (req, res) => res.json(systemLogs.slice(0, parseInt(req.query.limit)||100)));
app.get('/api/validate-phone/:phone', (req, res) => res.json(validatePhoneBR(req.params.phone)));

// CRM — SÓ MANUAL
app.post('/api/crm/send/:id', async (req, res) => {
  const tx = txCache.data.find(t => t.id === req.params.id);
  if (!tx) return res.status(404).json({ error: 'Não encontrada' });
  res.json({ success: await sendLeadToCRM(tx) });
});
app.post('/api/crm/resend/:id', async (req, res) => {
  const tx = txCache.data.find(t => t.id === req.params.id);
  if (!tx) return res.status(404).json({ error: 'Não encontrada' });
  delete leadsSent[tx.id];
  res.json({ success: await sendLeadToCRM(tx) });
});
app.post('/api/crm/send-all', async (req, res) => {
  const paid = txCache.data.filter(t => t.status === 'paid' && !leadsSent[t.id]);
  if (!paid.length) return res.json({ success: true, sent: 0, total: 0 });
  addLog('info', `Enviando ${paid.length} leads em lote...`);
  let sent = 0;
  for (const tx of paid) { if (await sendLeadToCRM(tx)) sent++; await delay(300); }
  res.json({ success: true, sent, total: paid.length });
});
app.post('/api/crm/send-valid', async (req, res) => {
  const paid = txCache.data.filter(t => {
    if (t.status !== 'paid' || leadsSent[t.id]) return false;
    return validatePhoneBR(t.customer?.phone).valid;
  });
  if (!paid.length) return res.json({ success: true, sent: 0, total: 0 });
  addLog('info', `Enviando ${paid.length} leads com telefone válido...`);
  let sent = 0;
  for (const tx of paid) { if (await sendLeadToCRM(tx)) sent++; await delay(300); }
  res.json({ success: true, sent, total: paid.length });
});
app.post('/api/crm/test', async (req, res) => {
  try {
    const r = await fetch(CONFIG.CRM_WEBHOOK_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'test', lead: { nome: 'Teste' }, transacao: { id: 'test_'+Date.now(), valor: 0 } }),
    });
    res.json({ success: r.ok, status: r.status });
  } catch (e) { res.json({ success: false, error: e.message }); }
});
app.post('/api/settings/auto-send', (req, res) => {
  CONFIG.AUTO_SEND_CRM = req.body.enabled === true;
  addLog('info', `Auto-send CRM: ${CONFIG.AUTO_SEND_CRM ? 'LIGADO' : 'DESLIGADO'}`);
  res.json({ success: true, auto_send: CONFIG.AUTO_SEND_CRM });
});
app.post('/api/refresh', async (req, res) => {
  await fetchNewTransactions();
  res.json({ success: true, transactions: txCache.data.length });
});
app.post('/api/rebuild-cache', async (req, res) => {
  txCache.data = [];
  await saveJSON(FILES.progress, null);
  await fetchAllTransactions();
  res.json({ success: true, transactions: txCache.data.length });
});
app.post('/webhook/dhr', async (req, res) => {
  addLog('info', 'Webhook recebido');
  const raw = req.body?.data || req.body;
  if (raw?.id) {
    const ids = new Set(txCache.data.map(t => t.id));
    if (!ids.has(raw.id)) {
      txCache.data.unshift(raw); txCache.lastUpdate = Date.now();
      broadcast({ type: 'new_transactions', payload: { count: 1 } });
    }
  }
  res.json({ received: true });
});
app.get('/health', (req, res) => res.json({ status: 'ok', transactions: txCache.data.length, leadsSent: Object.keys(leadsSent).length }));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/webhook/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ═══════════════════════════════════════
//  SERVER + WEBSOCKET
// ═══════════════════════════════════════

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', ws => {
  wsClients.add(ws);
  ws.send(JSON.stringify({ type: 'init', payload: getStats(txCache.data) }));
  ws.on('close', () => wsClients.delete(ws));
});

let pollInterval = null;
function startPolling() {
  if (pollInterval) return;
  addLog('info', `🟢 Polling iniciado (${CONFIG.POLL_INTERVAL/1000}s)`);
  pollInterval = setInterval(fetchNewTransactions, CONFIG.POLL_INTERVAL);
}

async function init() {
  const cached = await loadJSON(FILES.cache, null);
  if (cached?.data?.length) {
    txCache.data = cached.data;
    txCache.lastUpdate = cached.lastUpdate || Date.now();
    addLog('info', `Cache carregado: ${txCache.data.length} transações`);
  }
  const saved = await loadJSON(FILES.leads, {});
  leadsSent = saved || {};
  addLog('info', `Leads enviados: ${Object.keys(leadsSent).length}`);

  server.listen(CONFIG.PORT, () => {
    console.log(`\n⚡ DHR Lead Capture → CRM DataCrazy`);
    console.log(`📍 http://localhost:${CONFIG.PORT}`);
    console.log(`📤 CRM auto-send: DESLIGADO (só manual)`);
    console.log(`📦 Cache: ${txCache.data.length} transações\n`);
  });

  if (txCache.data.length === 0) {
    addLog('info', 'Sem cache, buscando tudo da API...');
    fetchAllTransactions().then(() => startPolling()).catch(() => startPolling());
  } else {
    setTimeout(() => fetchNewTransactions().catch(() => {}), 2000);
    startPolling();
  }
}

init();
process.on('SIGINT', () => { clearInterval(pollInterval); process.exit(0); });
process.on('SIGTERM', () => { clearInterval(pollInterval); process.exit(0); });
