# MailX — Roadmap da Sessão (29 Abr – 04 Mai 2026)

## Resumo Executivo

Sessão de desenvolvimento que integrou a plataforma de SMS **SlickText**, o gateway de pagamento **ClickBank**, reestruturou o dashboard com abas Email/SMS, adicionou novas métricas de performance, e documentou a integração futura do **Buygoods**.

---

## 1. Sincronização VPS ↔ Local ↔ GitHub

| Status | Tarefa |
|---|---|
| FEITO | Comparação MD5 de todos os arquivos fonte (local vs VPS) |
| FEITO | Identificação de divergência: VPS com edições diretas via SSH sem git commit |
| FEITO | Reset da VPS para alinhar com GitHub (`f4006c1`) |
| FEITO | Três repos sincronizados: local, GitHub, VPS |

---

## 2. Integração SlickText (SMS) — COMPLETO

### Arquivos Novos
| Arquivo | Descrição |
|---|---|
| `src/services/slicktext.ts` | Client API V2 (contatos, listas, analytics, créditos) |
| `src/webhooks/slicktext-sync.ts` | Helper: auto-criar listas, sync contatos, formatação de telefone/endereço |

### Arquivos Modificados
| Arquivo | Mudança |
|---|---|
| `src/db/database.ts` | +4 colunas: `st_api_token`, `st_brand_id` (clients), `st_list_compra_id`, `st_list_abandono_id` (kits) |
| `src/webhooks/store-lookup.ts` | `StoreContext` com `stApiToken` e `stBrandId` |
| `src/webhooks/product-upsert.ts` | `KitRecord` com IDs de listas SlickText |
| `src/webhooks/order-paid.handler.ts` | +SlickText sync (compra → lista compra + remove abandono) |
| `src/webhooks/abandoned-cart.handler.ts` | +SlickText sync (abandono → lista abandono) + extrai phone/lastName |
| `src/webhooks/card-declined.handler.ts` | +SlickText sync (cartão recusado → lista abandono) |
| `src/webhooks/digistore24-payment.handler.ts` | +SlickText sync (DS24 pagamento) |
| `src/onboarding/form.html` | Seção "SlickText (SMS)" com campos API Token + Brand ID |
| `src/onboarding/router.ts` | Salva `st_api_token` e `st_brand_id` na tabela clients |
| `src/admin/router.ts` | +`PATCH /clientes/:id/st-credentials` + `GET /clientes/:id/sms-stats` |
| `src/admin/client-detail.html` | Seção credenciais SlickText + aba SMS + sistema de 3 abas |

### Fluxo Implementado
```
Webhook (CartPanda/DS24/ClickBank)
  → Extrai phone, nome, email, endereço
  → Valida telefone (10 dígitos → +1XXXXXXXXXX)
  → Cria contato no SlickText
  → Auto-cria listas "[Produto] — Compra Aprovada" / "[Produto] — Abandono de Carrinho"
  → Adiciona contato à lista correta
  → Se compra: remove da lista de abandono
```

---

## 3. Reestruturação do Dashboard — COMPLETO

### Abas Implementadas (client-detail)
| Aba | Conteúdo |
|---|---|
| **Visão Geral** | KPIs consolidados (Email + SMS), gráficos, top 5 produtos, atividade |
| **Email** | KPIs de email marketing, métricas MailX UTM |
| **SMS** | Contatos por lista, créditos/envios (API SlickText), listas por produto |

### Novas Métricas
| Métrica | Descrição | Localização |
|---|---|---|
| **Representatividade MailX** | `Fat. MailX / Fat. Total × 100` | Aba Visão Geral |
| **Conversão por Segmento** | Taxa de conversão: Carrinho Abandonado vs Compradores | Aba Visão Geral |
| **Contatos SMS por lista** | Compradores vs Abandonos (SlickText API) | Aba SMS |
| **Créditos SMS** | Disponíveis / Usados / Total (SlickText API) | Aba SMS |

---

## 4. Integração ClickBank — COMPLETO

### Arquivos Novos
| Arquivo | Descrição |
|---|---|
| `src/services/clickbank.ts` | Decrypt AES-256-CBC do INS, normalização, helpers de tipo de transação |
| `src/webhooks/clickbank-payment.handler.ts` | Handler para SALE/BILL/ABANDONED_ORDER |
| `src/webhooks/clickbank-refund.handler.ts` | Handler para RFND/CGBK/INSF |

### Características Técnicas
- **Autenticação**: Payload AES-256-CBC criptografado. Key = `SHA1(secretKey)[0:32]`
- **Eventos**: SALE, BILL, RFND, CGBK, INSF, ABANDONED_ORDER, TEST
- **Tracking**: `tid` (legacy) + `affiliateTrackingParameters` (v8)
- **Integração completa**: AC (tags, listas, automações) + SlickText (SMS)
- **Decryption strategy**: Tenta todas as secret keys de `store_integrations` com `platform='clickbank'`

### Rotas Adicionadas
```
POST /webhook/clickbank/payment  → handleClickBankPayment
POST /webhook/clickbank/refund   → handleClickBankRefund
```

### Mudanças em Arquivos Existentes
- `src/webhooks/router.ts` — rotas ClickBank
- `src/webhooks/store-lookup.ts` — plataforma 'clickbank'
- `src/webhooks/product-upsert.ts` — plataforma 'clickbank'
- `src/onboarding/form.html` — opção ClickBank (vendor nickname + INS secret)
- `src/onboarding/router.ts` — salva `store_integrations` para ClickBank
- `src/admin/client-detail.html` — URLs de webhook ClickBank + opção na "Nova Loja"

---

## 5. Buygoods — DOCUMENTADO (Integração Bloqueada)

### Documento: `BUYGOODS_INTEGRATION.md`

**Por que está bloqueado:**
1. Email chega como **hash** (não plaintext) → impossível criar contato no AC/SlickText
2. **Sem nome/telefone** nos postbacks
3. **Sem eventos de refund/chargeback**
4. **Sem verificação de autenticidade** (nenhuma signature)
5. **Sem API REST** pública

**Próximos passos para desbloquear:**
1. Conseguir acesso de vendor no Buygoods
2. Verificar payload da "New Order URL" (vendor-side)
3. Contatar `affiliates@buygoods.com` para documentação do vendor webhook

---

## 6. Gateways — Status Atual

| Gateway | Status | Tracking | Email | Phone | Refund |
|---|---|---|---|---|---|
| **CartPanda** | Integrado | UTM | SIM | SIM | SIM |
| **Digistore24** | Integrado | UTM | SIM | SIM | SIM |
| **ClickBank** | Integrado | tid/v8 params | SIM | SIM | SIM |
| **Buygoods** | Bloqueado | SubID | HASH | NÃO | NÃO |

---

## 7. Commits da Sessão

| Hash | Descrição |
|---|---|
| `085c3b1` | feat: integrate SlickText SMS platform into MailX pipeline |
| `35b5b80` | feat: integrate ClickBank INS gateway into MailX pipeline |

---

## 8. Estrutura Final do Projeto

```
mailx/
├── src/
│   ├── index.ts                              ← Express server
│   ├── config/env.ts                         ← Environment config
│   ├── db/database.ts                        ← PostgreSQL + auto-migration
│   ├── middleware/auth.ts                     ← Session auth
│   ├── admin/
│   │   ├── dashboard.html                    ← Dashboard principal
│   │   ├── client-detail.html                ← Detalhe do cliente (3 abas)
│   │   ├── integration.html                  ← Página de integração
│   │   ├── login.html                        ← Login
│   │   └── router.ts                         ← API admin (stats, CRUD, SMS stats)
│   ├── onboarding/
│   │   ├── form.html                         ← Formulário (CP/DS24/CB/SlickText)
│   │   ├── success.html                      ← Sucesso
│   │   └── router.ts                         ← Processa onboarding
│   ├── services/
│   │   ├── activecampaign.ts                 ← AC API client
│   │   ├── cartpanda.ts                      ← CartPanda API client
│   │   ├── clickbank.ts                      ← ClickBank INS decrypt + normalize  [NOVO]
│   │   ├── digistore24.ts                    ← DS24 IPN validate + normalize
│   │   ├── google-drive.ts                   ← Google Drive API
│   │   └── slicktext.ts                      ← SlickText SMS API V2 client  [NOVO]
│   ├── webhooks/
│   │   ├── router.ts                         ← Rotas (CP, DS24, CB)
│   │   ├── store-lookup.ts                   ← Multi-tenant store resolution
│   │   ├── product-upsert.ts                 ← Auto-discovery de produtos
│   │   ├── slicktext-sync.ts                 ← Helper SlickText SMS sync  [NOVO]
│   │   ├── order-paid.handler.ts             ← CartPanda compra + AC + ST
│   │   ├── abandoned-cart.handler.ts         ← CartPanda abandono + AC + ST
│   │   ├── card-declined.handler.ts          ← CartPanda cartão + AC + ST
│   │   ├── digistore24-payment.handler.ts    ← DS24 payment + AC + ST
│   │   ├── digistore24-refund.handler.ts     ← DS24 refund/chargeback
│   │   ├── clickbank-payment.handler.ts      ← CB SALE/BILL/ABANDONED + AC + ST  [NOVO]
│   │   └── clickbank-refund.handler.ts       ← CB RFND/CGBK  [NOVO]
│   ├── setup/
│   │   ├── bootstrap.ts                      ← CLI wrapper
│   │   ├── bootstrap-service.ts              ← AC setup logic
│   │   └── resync-webhooks.ts                ← Resync contacts
│   └── utils/logger.ts                       ← Logger
├── BUYGOODS_INTEGRATION.md                   ← Documentação Buygoods  [NOVO]
├── SESSION_ROADMAP.md                        ← Este documento  [NOVO]
├── CHANGELOG.md
├── DEPLOY.md
├── README.md
├── package.json
├── tsconfig.json
├── docker-compose.yml
├── nginx.conf
└── deploy.sh
```

---

## 9. Endpoints de Webhook (Completo)

| Endpoint | Gateway | Evento |
|---|---|---|
| `POST /webhook/cartpanda/order-paid` | CartPanda | Compra aprovada |
| `POST /webhook/cartpanda/abandoned-cart` | CartPanda | Carrinho abandonado |
| `POST /webhook/cartpanda/card-declined` | CartPanda | Cartão recusado |
| `POST /webhook/digistore24/payment` | Digistore24 | Pagamento |
| `POST /webhook/digistore24/refund` | Digistore24 | Reembolso/chargeback |
| `POST /webhook/clickbank/payment` | ClickBank | SALE/BILL/ABANDONED |
| `POST /webhook/clickbank/refund` | ClickBank | RFND/CGBK/INSF |
| `GET /webhook/health` | — | Health check |

---

*Sessão: 29 Abr – 04 Mai 2026*
