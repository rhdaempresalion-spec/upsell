import express from 'express';
import fetch from 'node-fetch';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PK = 'pk_WNNg2i_r8_iqeG3XrdJFI_q1I8ihd1yLoUa08Ip0LKaqxXxE';
const SK = 'sk_jz1yyIaa0Dw2OWhMH0r16gUgWZ7N2PCpb6aK1crKPIFq02aD';
const API = 'https://api.shieldtecnologia.com/v1';
const CRM = 'https://api.datacrazy.io/v1/crm/api/crm/flows/webhooks/a3161e6d-6f4d-4b16-a1b5-16bcb9641994/560e62f9-9a1c-4e95-8afe-99794f66f1a8';
const AUTH = 'Basic ' + Buffer.from(`${PK}:${SK}`).toString('base64');
const PORT = process.env.PORT || 3005;

let transactions = [];
let logs = [];

function log(msg) {
  const entry = { msg, time: new Date().toISOString() };
  console.log(msg);
  logs.unshift(entry);
  if (logs.length > 200) logs.length = 200;
}

// ══════ VALIDAR TELEFONE BR ══════
function validarTelefone(raw) {
  if (!raw) return { valido: false, motivo: 'vazio', formatado: '', whatsapp: '' };
  let d = String(raw).replace(/\D/g, '');
  if (d.startsWith('55') && d.length >= 12) d = d.substring(2);
  if (d.length === 11 && d[2] === '9') {
    const ddd = d.substring(0, 2);
    const rest = d.substring(2);
    if (/^(\d)\1+$/.test(rest)) return { valido: false, motivo: 'falso', formatado: '', whatsapp: '' };
    return { valido: true, motivo: 'celular', formatado: `(${ddd}) ${rest[0]}${rest.substring(1,5)}-${rest.substring(5)}`, whatsapp: `55${d}` };
  }
  if (d.length === 10) {
    const ddd = d.substring(0, 2);
    const rest = d.substring(2);
    if (/^(\d)\1+$/.test(rest)) return { valido: false, motivo: 'falso', formatado: '', whatsapp: '' };
    return { valido: true, motivo: 'fixo', formatado: `(${ddd}) ${rest.substring(0,4)}-${rest.substring(4)}`, whatsapp: '' };
  }
  return { valido: false, motivo: `${d.length} digitos`, formatado: '', whatsapp: '' };
}

// ══════ BUSCAR TRANSAÇÕES (SÓ NOVAS) ══════
async function fetchPage(page, size) {
  const r = await fetch(`${API}/transactions?page=${page}&pageSize=${size}`, {
    headers: { 'Authorization': AUTH, 'Connection': 'keep-alive' },
    timeout: 30000,
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.json();
}

async function fetchLatest() {
  try {
    log('🔄 Buscando transações novas...');
    const data = await fetchPage(1, 500);
    const newTxs = data.data || [];
    
    if (transactions.length === 0) {
      // Primeira vez — pegar as últimas 500
      transactions = newTxs;
      log(`✅ ${transactions.length} transações carregadas`);
    } else {
      // Só adicionar as novas
      const ids = new Set(transactions.map(t => t.id));
      const brand = newTxs.filter(t => !ids.has(t.id));
      if (brand.length > 0) {
        transactions = [...brand, ...transactions];
        log(`🆕 ${brand.length} novas transações`);
      }
      // Atualizar status das existentes
      for (const nt of newTxs) {
        const ex = transactions.find(t => t.id === nt.id);
        if (ex && ex.status !== nt.status) Object.assign(ex, nt);
      }
    }
  } catch (e) {
    log(`❌ Erro: ${e.message}`);
  }
}

// ══════ EXPRESS ══════
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// DEBUG — ver estrutura real dos dados
app.get('/api/debug', (req, res) => {
  const sample = transactions.find(t => t.status === 'paid') || transactions[0];
  if (!sample) return res.json({ error: 'Sem dados ainda' });
  res.json({
    _msg: 'ESTRUTURA REAL DA TRANSAÇÃO',
    keys: Object.keys(sample),
    customer: sample.customer,
    customerKeys: sample.customer ? Object.keys(sample.customer) : 'N/A',
    id: sample.id,
    status: sample.status,
    amount: sample.amount,
    paymentMethod: sample.paymentMethod,
    items: sample.items,
    full: sample,
  });
});

// Stats
app.get('/api/stats', (req, res) => {
  const paid = transactions.filter(t => t.status === 'paid');
  const leads = new Map();
  transactions.forEach(t => {
    const key = t.customer?.document?.number || t.customer?.email;
    if (key && !leads.has(key)) leads.set(key, t.customer);
  });
  let telValid = 0, telInvalid = 0, telEmpty = 0, telWa = 0;
  leads.forEach(c => {
    const ph = c?.phone;
    if (!ph) { telEmpty++; return; }
    const v = validarTelefone(ph);
    if (v.valido) { telValid++; if (v.whatsapp) telWa++; } else telInvalid++;
  });
  res.json({
    total: transactions.length,
    paid: paid.length,
    revenue: paid.reduce((s, t) => s + (t.amount || 0), 0) / 100,
    leads: leads.size,
    telValid, telInvalid, telEmpty, telWa,
  });
});

// Leads
app.get('/api/leads', (req, res) => {
  const map = {};
  const filter = req.query.phoneFilter || '';
  const search = (req.query.search || '').toLowerCase();
  
  transactions.forEach(t => {
    const c = t.customer;
    if (!c) return;
    const key = c.document?.number || c.email || c.name;
    if (!key) return;
    
    if (!map[key]) {
      const tel = validarTelefone(c.phone);
      map[key] = {
        nome: c.name || '',
        email: c.email || '',
        telefoneRaw: c.phone || '',
        telefone: tel.formatado || c.phone || '',
        telValido: tel.valido,
        telMotivo: tel.motivo,
        whatsapp: tel.whatsapp || '',
        documento: c.document?.number || '',
        compras: 0,
        comprasPagas: 0,
        totalGasto: 0,
        ultimaCompra: t.createdAt,
        produtos: new Set(),
      };
    }
    const l = map[key];
    l.compras++;
    if (t.status === 'paid') {
      l.comprasPagas++;
      l.totalGasto += (t.amount || 0) / 100;
    }
    if (new Date(t.createdAt) > new Date(l.ultimaCompra)) l.ultimaCompra = t.createdAt;
    if (t.items?.[0]?.title) l.produtos.add(t.items[0].title.split(' - ')[0].trim());
  });

  let leads = Object.values(map).map(l => ({ ...l, produtos: Array.from(l.produtos).join(', ') }));

  // Filtro telefone
  if (filter === 'valid') leads = leads.filter(l => l.telValido);
  else if (filter === 'whatsapp') leads = leads.filter(l => l.whatsapp);
  else if (filter === 'invalid') leads = leads.filter(l => !l.telValido && l.telefoneRaw);
  else if (filter === 'no_phone') leads = leads.filter(l => !l.telefoneRaw);

  // Busca
  if (search) {
    leads = leads.filter(l =>
      l.nome.toLowerCase().includes(search) ||
      l.email.toLowerCase().includes(search) ||
      l.documento.includes(search) ||
      l.telefoneRaw.includes(search)
    );
  }

  leads.sort((a, b) => new Date(b.ultimaCompra) - new Date(a.ultimaCompra));
  res.json(leads);
});

// Transações
app.get('/api/transactions', (req, res) => {
  let txs = [...transactions];
  const search = (req.query.search || '').toLowerCase();
  const status = req.query.status || '';
  if (status === 'paid') txs = txs.filter(t => t.status === 'paid');
  else if (status === 'pending') txs = txs.filter(t => ['waiting_payment', 'pending'].includes(t.status));
  if (search) txs = txs.filter(t => (t.customer?.name || '').toLowerCase().includes(search) || (t.customer?.email || '').toLowerCase().includes(search) || (t.id || '').toString().includes(search));
  
  const page = parseInt(req.query.page) || 1;
  const size = 50;
  const start = (page - 1) * size;
  res.json({
    data: txs.slice(start, start + size),
    pagination: { page, totalRecords: txs.length, totalPages: Math.ceil(txs.length / size) },
  });
});

// CRM — enviar um lead
app.post('/api/crm/send/:id', async (req, res) => {
  const tx = transactions.find(t => String(t.id) === req.params.id);
  if (!tx) return res.status(404).json({ error: 'Transação não encontrada' });
  
  const c = tx.customer || {};
  const tel = validarTelefone(c.phone);
  const payload = {
    event: 'venda_paga',
    lead: {
      nome: c.name || '',
      email: c.email || '',
      telefone: tel.formatado || c.phone || '',
      telefone_valido: tel.valido,
      whatsapp: tel.whatsapp || '',
      documento: c.document?.number || '',
    },
    transacao: {
      id: tx.id,
      valor: (tx.amount || 0) / 100,
      produto: tx.items?.[0]?.title || '',
      metodo: tx.paymentMethod || '',
      status: tx.status,
      data: tx.createdAt,
    },
  };

  try {
    log(`📤 CRM ← ${c.name || 'N/A'} | Tel: ${tel.formatado || c.phone || 'sem'} | R$ ${((tx.amount||0)/100).toFixed(2)}`);
    const r = await fetch(CRM, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await r.text().catch(() => '');
    log(`CRM resposta: ${r.status} ${text.substring(0, 200)}`);
    res.json({ success: r.ok, status: r.status, response: text.substring(0, 200) });
  } catch (e) {
    log(`❌ CRM erro: ${e.message}`);
    res.json({ success: false, error: e.message });
  }
});

// Alias rota antiga
app.post('/api/transactions/:id/send-crm', async (req, res) => {
  // Redirecionar pra rota nova
  req.params.id = req.params.id;
  const tx = transactions.find(t => String(t.id) === req.params.id);
  if (!tx) return res.status(404).json({ error: 'Não encontrada' });
  
  const c = tx.customer || {};
  const tel = validarTelefone(c.phone);
  try {
    const r = await fetch(CRM, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'venda_paga',
        lead: { nome: c.name||'', email: c.email||'', telefone: tel.formatado||c.phone||'', documento: c.document?.number||'' },
        transacao: { id: tx.id, valor: (tx.amount||0)/100, produto: tx.items?.[0]?.title||'', status: tx.status },
      }),
    });
    const text = await r.text().catch(() => '');
    log(`CRM: ${r.status} — ${c.name} R$ ${((tx.amount||0)/100).toFixed(2)}`);
    res.json({ success: r.ok, status: r.status });
  } catch (e) {
    log(`❌ CRM: ${e.message}`);
    res.json({ success: false, error: e.message });
  }
});

app.post('/api/test-crm', async (req, res) => {
  try {
    const r = await fetch(CRM, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: 'test', lead: { nome: 'Teste' } }) });
    res.json({ success: r.ok, status: r.status });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.post('/api/refresh', async (req, res) => { await fetchLatest(); res.json({ ok: true, total: transactions.length }); });
app.get('/api/logs', (req, res) => res.json(logs));
app.get('/health', (req, res) => res.json({ ok: true, transactions: transactions.length }));

app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ══════ START ══════
app.listen(PORT, () => {
  console.log(`⚡ DHR Leads → http://localhost:${PORT}`);
  console.log(`📍 Debug: http://localhost:${PORT}/api/debug`);
});

// Buscar imediatamente + poll a cada 30s
fetchLatest();
setInterval(fetchLatest, 30000);
