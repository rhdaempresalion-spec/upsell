#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
//  DIAGNÓSTICO - Shield Tecnologia API
//  Roda: node diagnostico.js
//  Testa TODAS as combinações de auth + endpoints
// ═══════════════════════════════════════════════════════════════

const crypto = require('crypto');
const https = require('https');
const http = require('http');

const PK = 'pk_WNNg2i_r8_iqeG3XrdJFI_q1I8ihd1yLoUa08Ip0LKaqxXxE';
const SK = 'sk_jz1yyIaa0Dw2OWhMH0r16gUgWZ7N2PCpb6aK1crKPIFq02aD';
const BASE = 'https://api.shieldtecnologia.com';

// ─── Auth Generators ───
function hmac512Hex(data) {
  return crypto.createHmac('sha512', SK).update(data).digest('hex');
}
function hmac512Base64(data) {
  return Buffer.from(hmac512Hex(data)).toString('base64');
}
function hmac256Hex(data) {
  return crypto.createHmac('sha256', SK).update(data).digest('hex');
}
function basicAuth() {
  return 'Basic ' + Buffer.from(PK + ':' + SK).toString('base64');
}

const AUTH_METHODS = {
  // 1) Bearer com secret key
  'Bearer SK': { 'Authorization': `Bearer ${SK}` },
  // 2) Bearer com public key
  'Bearer PK': { 'Authorization': `Bearer ${PK}` },
  // 3) Basic auth pk:sk
  'Basic PK:SK': { 'Authorization': basicAuth() },
  // 4) HMAC-SHA512 (Solidgate style)
  'HMAC512 signature+public-key': (body = '') => ({
    'public-key': PK,
    'signature': hmac512Base64(body ? (PK + body + PK) : (PK + PK)),
  }),
  // 5) HMAC-SHA512 variação X-headers
  'HMAC512 x-signature+x-public-key': (body = '') => ({
    'x-public-key': PK,
    'x-signature': hmac512Base64(body ? (PK + body + PK) : (PK + PK)),
  }),
  // 6) Merchant + Signature
  'Merchant+Signature': (body = '') => ({
    'merchant': PK,
    'signature': hmac512Base64(body ? (PK + body + PK) : (PK + PK)),
  }),
  // 7) API-Key header
  'X-Api-Key SK': { 'X-Api-Key': SK },
  // 8) API-Key com PK
  'X-Api-Key PK': { 'X-Api-Key': PK },
  // 9) Token header
  'Token SK': { 'Token': SK },
  // 10) Custom: Authorization + Merchant
  'Bearer+Merchant': { 'Authorization': `Bearer ${SK}`, 'merchant-id': PK },
  // 11) HMAC-SHA256
  'HMAC256 signature': (body = '') => ({
    'public-key': PK,
    'signature': hmac256Hex(body ? (PK + body + PK) : (PK + PK)),
  }),
  // 12) PK + SK as separate headers
  'PK+SK headers': { 'public-key': PK, 'secret-key': SK },
  // 13) Access token style
  'access-token': { 'access-token': SK },
};

const ENDPOINTS = [
  // v1 prefixed
  '/v1/transactions',
  '/v1/transaction',
  '/v1/charges',
  '/v1/charge',
  '/v1/payments',
  '/v1/payment',
  '/v1/orders',
  '/v1/order',
  '/v1/sales',
  '/v1/invoices',
  '/v1/subscriptions',
  '/v1/customers',
  '/v1/merchants',
  '/v1/me',
  '/v1/account',
  '/v1/status',
  '/v1/health',
  '/v1/ping',
  // sem v1
  '/transactions',
  '/charges',
  '/payments',
  '/orders',
  '/sales',
  '/health',
  '/status',
  '/ping',
  '/me',
  '/account',
  // Documentação
  '/docs',
  '/swagger',
  '/swagger.json',
  '/openapi.json',
  '/v1/docs',
  '/v1/swagger.json',
  '/api-docs',
];

function makeRequest(url, headers, method = 'GET', body = null) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve({ status: 'TIMEOUT', body: '' }), 8000);
    try {
      const urlObj = new URL(url);
      const opts = {
        hostname: urlObj.hostname,
        port: urlObj.port || 443,
        path: urlObj.pathname + urlObj.search,
        method,
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', ...headers },
      };
      if (body) opts.headers['Content-Length'] = Buffer.byteLength(body);

      const req = https.request(opts, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          clearTimeout(timeout);
          resolve({ status: res.statusCode, body: data.substring(0, 500), headers: res.headers });
        });
      });
      req.on('error', (e) => { clearTimeout(timeout); resolve({ status: 'ERROR', body: e.message }); });
      if (body) req.write(body);
      req.end();
    } catch (e) { clearTimeout(timeout); resolve({ status: 'ERROR', body: e.message }); }
  });
}

async function main() {
  console.log('');
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║   🔍 Diagnóstico Shield Tecnologia API                  ║');
  console.log('╠═══════════════════════════════════════════════════════════╣');
  console.log(`║   Base: ${BASE}`);
  console.log(`║   PK: ${PK.substring(0, 20)}...`);
  console.log(`║   SK: ${SK.substring(0, 20)}...`);
  console.log('╚═══════════════════════════════════════════════════════════╝');
  console.log('');

  // FASE 1: Descobrir endpoints que existem (qualquer status != connection error)
  console.log('━━━ FASE 1: Descobrindo endpoints que existem ━━━');
  console.log('');

  const found = [];
  const firstAuth = { 'Authorization': `Bearer ${SK}` };

  for (const ep of ENDPOINTS) {
    const url = `${BASE}${ep}`;
    const r = await makeRequest(url, firstAuth);
    const icon = r.status === 200 ? '✅' : r.status === 401 || r.status === 403 ? '🔐' : r.status === 405 ? '⚠️' : r.status === 404 ? '  ' : '❓';
    if (r.status !== 404 && r.status !== 'ERROR' && r.status !== 'TIMEOUT') {
      found.push({ ep, status: r.status, body: r.body });
      console.log(`  ${icon} ${r.status} ${ep} → ${r.body.substring(0, 120)}`);
    } else if (r.status === 404) {
      // silencio
    } else {
      console.log(`  ❌ ${r.status} ${ep} → ${r.body.substring(0, 80)}`);
    }
  }

  if (found.length === 0) {
    console.log('');
    console.log('  ⚠️  Nenhum endpoint respondeu (exceto 404).');
    console.log('  Tentando com POST e auth variados...');
    console.log('');
  }

  // FASE 2: Testar autenticações nos endpoints encontrados (ou em todos se nenhum encontrado)
  console.log('');
  console.log('━━━ FASE 2: Testando autenticações ━━━');
  console.log('');

  const targetEPs = found.length > 0
    ? found.map(f => f.ep)
    : ['/v1/transactions', '/v1/charges', '/v1/payments', '/v1/orders', '/v1/sales', '/v1/me', '/v1/account', '/v1/merchants'];

  const successes = [];

  for (const ep of targetEPs) {
    console.log(`  📡 ${ep}:`);

    for (const [name, auth] of Object.entries(AUTH_METHODS)) {
      const headers = typeof auth === 'function' ? auth('') : auth;
      const url = `${BASE}${ep}`;

      // GET
      const rg = await makeRequest(url, headers, 'GET');
      if (rg.status === 200 || rg.status === 201) {
        console.log(`    ✅ GET ${name} → ${rg.status}: ${rg.body.substring(0, 150)}`);
        successes.push({ method: 'GET', ep, auth: name, status: rg.status, body: rg.body });
      } else if (rg.status !== 404 && rg.status !== 401 && rg.status !== 403) {
        console.log(`    ❓ GET ${name} → ${rg.status}: ${rg.body.substring(0, 80)}`);
      }

      // POST (para endpoints de listagem que podem exigir POST)
      const postBody = JSON.stringify({ page: 1, per_page: 10 });
      const postHeaders = typeof auth === 'function' ? auth(postBody) : auth;
      const rp = await makeRequest(url, postHeaders, 'POST', postBody);
      if (rp.status === 200 || rp.status === 201) {
        console.log(`    ✅ POST ${name} → ${rp.status}: ${rp.body.substring(0, 150)}`);
        successes.push({ method: 'POST', ep, auth: name, status: rp.status, body: rp.body });
      } else if (rp.status !== 404 && rp.status !== 401 && rp.status !== 403 && rp.status !== 405) {
        console.log(`    ❓ POST ${name} → ${rp.status}: ${rp.body.substring(0, 80)}`);
      }
    }
    console.log('');
  }

  // FASE 3: Testar some extra endpoints
  console.log('━━━ FASE 3: Testando endpoints extras ━━━');
  console.log('');

  const extraEPs = [
    '/v1/transactions/list',
    '/v1/transactions/search',
    '/v1/charge/list',
    '/v1/payments/list',
    '/v1/order/list',
    '/v1/merchant/transactions',
    '/v1/merchant/charges',
    '/v1/merchant/payments',
    '/v1/reports/transactions',
    '/v1/webhook',
    '/v1/webhooks',
    '/v1/callback',
  ];

  for (const ep of extraEPs) {
    const url = `${BASE}${ep}`;
    for (const [name, auth] of Object.entries(AUTH_METHODS)) {
      const headers = typeof auth === 'function' ? auth('') : auth;
      const r = await makeRequest(url, headers, 'GET');
      if (r.status === 200 || r.status === 201) {
        console.log(`  ✅ GET ${ep} [${name}] → ${r.status}: ${r.body.substring(0, 150)}`);
        successes.push({ method: 'GET', ep, auth: name, status: r.status, body: r.body });
      }
      const postBody = JSON.stringify({ page: 1 });
      const ph = typeof auth === 'function' ? auth(postBody) : auth;
      const rp = await makeRequest(url, ph, 'POST', postBody);
      if (rp.status === 200 || rp.status === 201) {
        console.log(`  ✅ POST ${ep} [${name}] → ${rp.status}: ${rp.body.substring(0, 150)}`);
        successes.push({ method: 'POST', ep, auth: name, status: rp.status, body: rp.body });
      }
    }
  }

  // RESULTADO
  console.log('');
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║   📊 RESULTADO                                          ║');
  console.log('╚═══════════════════════════════════════════════════════════╝');
  console.log('');

  if (successes.length > 0) {
    console.log(`  🎉 ${successes.length} endpoint(s) funcionando:`);
    console.log('');
    for (const s of successes) {
      console.log(`  ✅ ${s.method} ${s.ep}`);
      console.log(`     Auth: ${s.auth}`);
      console.log(`     Status: ${s.status}`);
      console.log(`     Response: ${s.body.substring(0, 200)}`);
      console.log('');
    }
  } else {
    console.log('  ❌ Nenhum endpoint retornou 200.');
    console.log('');
    console.log('  Possíveis causas:');
    console.log('  1. A URL base pode ser diferente (talvez tenha um path customizado)');
    console.log('  2. As chaves pk_/sk_ podem ser para o painel DHR, não para a Shield API');
    console.log('  3. A API pode exigir um IP liberado (whitelist)');
    console.log('  4. O merchant pode precisar de um ID adicional');
    console.log('');
    console.log('  📋 Cole o log completo acima e me envie para eu analisar.');
    console.log('  💡 Também verifique no painel DHR se há documentação da API.');
  }

  // Log dos endpoints encontrados (mesmo com erro) para referência
  if (found.length > 0) {
    console.log('');
    console.log('  📡 Endpoints que responderam (não 404):');
    for (const f of found) {
      console.log(`     ${f.status} ${f.ep} → ${f.body.substring(0, 100)}`);
    }
  }

  console.log('');
  console.log('  ⏱️  Diagnóstico completo!');
  console.log('  📋 Copie TUDO acima e me envie.');
  console.log('');
}

main().catch(console.error);
