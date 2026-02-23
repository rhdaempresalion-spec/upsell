# ⚡ DHR Lead Capture System

Sistema completo para capturar leads pagos do **DHR Gateway** em tempo real e enviar automaticamente para o **CRM DataCrazy** via webhook.

---

## 🚀 Instalação Rápida

### Pré-requisitos
- **Node.js** 18+ instalado ([baixar aqui](https://nodejs.org))

### Passo a passo

```bash
# 1. Entre na pasta do projeto
cd dhr-lead-system

# 2. Instale as dependências
npm install

# 3. Configure o .env (já vem preenchido com suas chaves)
# Edite se necessário: nano .env

# 4. Inicie o servidor
npm start
```

### Acesse o dashboard
```
http://localhost:3000
```

---

## 📁 Estrutura do Projeto

```
dhr-lead-system/
├── server.js          # Backend completo (Express + WebSocket + SQLite)
├── public/
│   └── index.html     # Dashboard frontend (SPA)
├── .env               # Configurações e chaves API
├── package.json       # Dependências
├── leads.db           # Banco SQLite (criado automaticamente)
└── README.md          # Este arquivo
```

---

## ⚙️ Como Funciona

### Fluxo Principal

```
DHR Gateway → [Webhook/Polling] → Backend Node.js → [POST] → CRM DataCrazy → WhatsApp
```

1. **Recebimento**: O backend recebe transações da DHR de duas formas:
   - **Webhook** (recomendado): DHR envia POST para `/webhook/dhr` a cada evento
   - **Polling**: O sistema consulta a API da DHR periodicamente

2. **Processamento**: Cada transação é normalizada, salva no SQLite e filtrada

3. **Envio ao CRM**: Transações com status `paid` são enviadas automaticamente via POST para o webhook do CRM DataCrazy

4. **Dashboard**: Interface web com atualizações em tempo real via WebSocket

---

## 🔗 Endpoints da API

### Webhook (DHR → Servidor)
| Método | Rota | Descrição |
|--------|------|-----------|
| POST | `/webhook/dhr` | Recebe notificações da DHR |
| POST | `/webhook/callback` | Rota alternativa |

### API Interna (Frontend → Backend)
| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/api/stats` | Estatísticas do dashboard |
| GET | `/api/transactions` | Listar todas transações |
| GET | `/api/transactions/pending` | Listar pendentes de envio |
| POST | `/api/transactions/:id/send-crm` | Enviar lead individual |
| POST | `/api/transactions/:id/resend-crm` | Reenviar lead |
| POST | `/api/transactions/send-all` | Enviar todos pendentes |
| POST | `/api/polling/start` | Iniciar polling |
| POST | `/api/polling/stop` | Parar polling |
| POST | `/api/polling/trigger` | Buscar agora |
| POST | `/api/settings/auto-send` | Toggle auto-envio |
| POST | `/api/settings/poll-interval` | Alterar intervalo |
| GET | `/api/logs` | Logs do sistema |
| POST | `/api/test-crm` | Testar conexão CRM |
| POST | `/api/test-dhr` | Testar conexão DHR |
| POST | `/api/reset` | Limpar banco de dados |

### WebSocket
```
ws://localhost:3000/ws
```

---

## 📋 Payload Enviado ao CRM

Cada lead pago gera um POST com este formato:

```json
{
  "event": "venda_paga",
  "timestamp": "2026-02-23T10:30:00.000Z",
  "lead": {
    "nome": "João Silva",
    "email": "joao@email.com",
    "telefone": "5511999887766",
    "documento": "12345678900"
  },
  "transacao": {
    "id": "txn_abc123",
    "produto": "Curso Premium",
    "valor": 297.00,
    "metodo_pagamento": "pix",
    "data_pagamento": "2026-02-23T10:30:00Z",
    "status": "paid"
  },
  "metadata": {
    "source": "dhr_gateway_integration",
    "gateway": "dhr_tecnologia",
    "server": "dhr-lead-capture",
    "auto_sent": true,
    "sent_at": "2026-02-23T10:30:05.000Z"
  }
}
```

---

## 🌐 Deploy em Produção

### Opção 1: VPS (DigitalOcean, Contabo, etc.)

```bash
# No servidor
git clone <seu-repo> && cd dhr-lead-system
npm install --production
# Usar PM2 para manter rodando
npm install -g pm2
pm2 start server.js --name "dhr-leads"
pm2 save
pm2 startup
```

### Opção 2: Railway / Render

1. Faça push do projeto para o GitHub
2. Conecte no Railway/Render
3. Configure as variáveis de ambiente do `.env`
4. Deploy automático

### Configurar HTTPS (Nginx reverse proxy)

```nginx
server {
    listen 443 ssl;
    server_name seudominio.com;

    ssl_certificate /etc/letsencrypt/live/seudominio.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/seudominio.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

### Configurar Webhook na DHR

Após o deploy, configure no painel da DHR:
```
URL: https://seudominio.com/webhook/dhr
Método: POST
Eventos: transaction.paid, payment.approved, charge.paid
```

---

## 🔧 Configuração do CRM (DataCrazy)

No CRM DataCrazy, configure um fluxo de automação:

1. **Trigger**: Webhook recebido (o sistema já envia automaticamente)
2. **Condição**: `event == "venda_paga"`
3. **Ação**: Enviar mensagem WhatsApp para `lead.telefone`
4. **Template**: Mensagem de boas-vindas com `lead.nome` e `transacao.produto`

---

## 📝 Notas Importantes

- O banco SQLite é local e persistente (arquivo `leads.db`)
- O sistema faz deduplicação automática (mesmo ID não é processado duas vezes)
- O backend tenta múltiplos formatos de endpoint da DHR automaticamente
- WebSocket reconecta automaticamente se a conexão cair
- Os logs ficam salvos no banco para consulta posterior
