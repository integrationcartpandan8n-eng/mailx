# Changelog 12-06 — MailX

Sessão de evolução do pipeline e do dashboard. Cobre: SMS marketing (SlickText), novo gateway (ClickBank), documentação do Buygoods, abas Email/SMS, e métricas reais de email marketing vindas do ActiveCampaign.

---

## 1. Integração SlickText (SMS Marketing)

### O que foi feito

- Novo client TypeScript completo da API V2 do SlickText (`src/services/slicktext.ts`):
  - Contatos: criar, buscar por telefone, adicionar/remover de listas
  - Listas: listar, criar, buscar por nome, contagem de contatos
  - Analytics: contatos, mensagens, uso de créditos
  - Helper estático `formatPhone()` (E.164 `+1XXXXXXXXXX`)
- Helper de sync (`src/webhooks/slicktext-sync.ts`):
  - Auto-criação de duas listas por produto: `[Produto] — Compra Aprovada` e `[Produto] — Abandono de Carrinho`
  - Salva os IDs das listas em `kits.st_list_compra_id` / `kits.st_list_abandono_id`
  - Extrai endereço de payloads CartPanda e Digistore24
- 4 handlers de webhook passaram a disparar SMS sync (sempre não-bloqueante):
  - `order-paid.handler.ts` — adiciona à lista de compra + remove da de abandono
  - `abandoned-cart.handler.ts` — adiciona à lista de abandono
  - `card-declined.handler.ts` — adiciona à lista de abandono
  - `digistore24-payment.handler.ts` — adiciona à lista de compra
- Onboarding: campos "API Token" e "Brand ID" do SlickText
- Painel admin: seção de credenciais SlickText + aba SMS no detalhe do cliente
- DB: 4 colunas novas (`clients.st_api_token`, `clients.st_brand_id`, `kits.st_list_compra_id`, `kits.st_list_abandono_id`)

### Bugs encontrados e corrigidos

1. **Brand ID malformado** — UI do SlickText mostra `b26136`, mas a API espera `26136` (numérico). O construtor agora sanitiza com `replace(/\D/g, '')`.
2. **`getListContactCount` sempre retornando 0** — o endpoint retorna número puro (`228`), não objeto `{count: 228}`. Corrigido para tratar resposta escalar.
3. **`/analytics/message/credits` retorna 404** — o endpoint não existe na V1; método mantido como stub (`return null`). Créditos vêm de `getBrandUsage()`.
4. **Total Contatos exibindo 0** — o frontend somava apenas contatos de kits com listas linkadas. Agora usa o total global do brand SlickText como fallback.

---

## 2. Integração ClickBank (Gateway de Pagamento)

### O que foi feito

- `src/services/clickbank.ts`:
  - `decryptINS(secretKey, body)` usando Node crypto: `key = SHA1(secretKey)[0:32]`, `aes-256-cbc` com IV do payload
  - `normalizePayload`, helpers `isPurchase` / `isRefund` / `isAbandonedOrder`
- Handlers:
  - `clickbank-payment.handler.ts` — SALE / BILL / ABANDONED_ORDER
  - `clickbank-refund.handler.ts` — RFND / CGBK / INSF
- **Decryption strategy**: como o payload é criptografado e não tem identificador de loja em texto claro, o handler **tenta todas as `secretKey` configuradas em `store_integrations` com `platform='clickbank'`** até alguma descriptografar com sucesso. Funciona porque AES com chave errada falha em padding.
- Tracking: `tid` (legacy) + `affiliateTrackingParameters` (v8)
- Integração completa com AC (tags, listas, automações) + SlickText (SMS)
- Rotas: `POST /webhook/clickbank/payment` e `POST /webhook/clickbank/refund`
- Onboarding: opção ClickBank no select de plataforma + campos `cb_vendor_nickname` e `cb_ins_secret`

---

## 3. Buygoods — Documentado mas BLOQUEADO

### Por que não foi integrado

Buygoods foi a única plataforma das quatro avaliadas que **não pode ser integrada ao pipeline** no estado atual. Isso não é uma escolha técnica nossa — é limitação da plataforma para quem está no lado afiliado (que é o caso do cliente MailX).

### A dificuldade técnica em detalhe

O MailX precisa de três dados para uma integração ser viável:

| Dado | Por que é necessário |
|---|---|
| **Email plaintext** | Criar contato no ActiveCampaign para receber emails |
| **Telefone** | Criar contato no SlickText para receber SMS |
| **Nome** | Personalizar mensagens (`{first_name}`, salutations) |

O postback de afiliado do Buygoods entrega:

```json
{
  "ORDERID": "678463",
  "SUBID": "dGzcYls3mRnetyw62qTieJ11wgtvFIg2rZ",
  "SUBID2": null,
  "SUBID3": null,
  "SUBID4": "p17",
  "SUBID5": "e_vsl_ml1",
  "COMMISSION_AMOUNT": "390.00",
  "PRODUCT_CODENAME": "atgc6TSSC",
  "email": "80ED0FCB080F9CEF4391806920A7E7F076G9243661C"
}
```

**Problemas críticos:**

1. **Email vem como hash SHA1/MD5/proprietário irreversível.** Um hash é uma operação one-way: dado o email, gera o hash; mas dado o hash, é matematicamente inviável recuperar o email. Sem o email plaintext, não há como `POST /contacts` no AC ou no SlickText — esses serviços precisam do email real para enviar mensagens. Não existe API de "lookup por hash" porque nenhum dos lados (AC ou SlickText) armazena hash dos próprios contatos.

2. **Sem nome e sem telefone.** Os SubIDs 1–5 são strings de tracking (passados pelo afiliado, não pelo cliente final). Sem `first_name`, `last_name`, `phone`, não há como criar perfil de contato funcional.

3. **Sem eventos de refund / chargeback / cancelamento.** O ecossistema de postback do Buygoods cobre apenas Purchase, Upsell, InitiateCheckout e ViewContent. Eventos de churn (refund, chargeback, cancelamento de assinatura, rebill) não disparam postback. Isso quebra a parte do pipeline que aplica tags `Reembolso` / `Chargeback` no AC para retirar o contato de automações.

4. **Sem mecanismo de autenticação.** Não há HMAC, signature, ou secret. Qualquer requisição com path correto seria aceita. Mitigável com URL contendo path secreto (`/webhook/buygoods/a8f3k2x9m1`) + validação de `PRODUCT_CODENAME` contra produtos conhecidos, mas é frágil.

5. **Sem API REST pública.** Não há endpoint para consultar pedidos, produtos ou contatos. O "Request API Access" no dashboard existe mas é gated por aprovação manual e não fornece o que precisamos.

6. **Plataforma foi desenhada para proteger o cliente final do afiliado.** Buygoods é orientado a performance — o afiliado precisa saber "vendi X e ganhei Y", não "quem comprou foi a pessoa Z". Esconder o email do cliente final do afiliado é uma decisão deliberada da plataforma para prevenir que afiliados façam marketing direto fora da Buygoods, contornando comissões. O hashing do email é justamente para permitir alguma forma de matching pelo afiliado (ex: rodar o hash contra a sua própria base) sem revelar identidades.

### Comparativo com as três plataformas integradas

| Recurso | CartPanda | Digistore24 | ClickBank | **Buygoods** |
|---|---|---|---|---|
| Email plaintext | sim | sim | sim | **hash** |
| Nome / Telefone | sim | sim | sim | **não** |
| Refund / Chargeback | sim | sim | sim | **não** |
| Verificação de auth | API Key | SHA512 sig | AES-256-CBC | **nenhuma** |
| REST API | sim | sim | sim | **não** |
| Tracking | UTM | UTM | tid + v8 | SubID 1–5 |

### Caminho para desbloquear (no futuro)

Existe a chamada **"New Order URL"** do lado vendor (Backoffice → Setup → Products → Settings). Em teoria, esse webhook pode entregar dados completos do cliente (email plaintext, nome, telefone) porque é o vendor que está vendendo, não um afiliado intermediário. Mas:

- Documentação não é pública
- Requer acesso de vendor (o cliente MailX está como afiliado, não vendor)
- Mesmo conseguindo, não há garantia de que vem refund/chargeback

**Plano para destrava futura** (documentado em `BUYGOODS_INTEGRATION.md`):

1. Cliente conseguir acesso de vendor na conta Buygoods (gated por aprovação da plataforma)
2. Configurar uma URL de teste e verificar payload da "New Order URL"
3. Se vier email plaintext + nome + telefone → implementar handler espelhando padrão CartPanda
4. Se não vier → integração viável apenas para tracking de comissão, não para automação de email/SMS

Enquanto isso, criamos `BUYGOODS_INTEGRATION.md` com spec completa (11 seções) para o dia que destravar.

---

## 4. Dashboard — Aba Email/SMS por cliente

### O que foi feito

Reestruturação do `client-detail.html` em **3 sub-abas**:

| Aba | Conteúdo |
|---|---|
| **Visão Geral** | KPIs consolidados (Email + SMS), gráficos, top 5 produtos, atividade recente |
| **Email** | KPIs de email marketing (Entrada Contatos, CTR, Taxa Abertura, CTOR, RPM, EPC) + Métricas MailX UTM (Faturamento, Vendas, Recuperações) |
| **SMS** | Contatos por lista (Compradores vs Abandonos), Créditos disponíveis/usados, Listas por produto, dados em tempo real da API SlickText |

Plus duas métricas novas na Visão Geral:

- **Representatividade MailX**: `(Faturamento MailX ÷ Faturamento Total) × 100` — mede quanto da receita total veio de tráfego atribuído ao MailX
- **Conversão por Segmento**: tabela comparando taxa de conversão entre Carrinho Abandonado vs Compradores

---

## 5. Dashboard — Aba Email/SMS global

### O que foi feito

Mesma lógica do client-detail aplicada ao dashboard principal. Duas novas abas top-level:

- **Email** — agregado de todos os clientes com AC configurado
  - Faturamento Email, Vendas Email, Recuperações Email
  - 6 KPIs do AC: Entrada Contatos, CTR, Taxa Abertura, CTOR, RPM, EPC
  - Filtro UTM: `mailx` AND NOT `mailxsms`
- **SMS** — agregado de todos os clientes com SlickText configurado
  - Faturamento SMS, Vendas SMS, Recuperações SMS
  - 5 KPIs SlickText: Total Contatos, Créditos Disponíveis, Créditos Usados, Total Créditos, Listas SMS
  - Filtro UTM: contém `mailxsms`

Endpoints novos: `GET /admin/dashboard/email` e `GET /admin/dashboard/sms`. Ambos com **lazy load** — só chamam a API externa quando a aba é clicada (não impacta a tela inicial).

---

## 6. ActiveCampaign — Reporting integrado

### O que foi feito

Os KPIs de email marketing (CTR, Taxa de Abertura, CTOR, RPM, EPC, Entrada de Contatos) que antes apareciam como `--` agora puxam dados reais do AC.

Dois métodos novos em `src/services/activecampaign.ts`:

- `getCampaignsAggregate(daysBack)` — itera campanhas em ordem DESC de envio, soma `send_amt / opens / uniqueopens / linkclicks / uniquelinkclicks` para todas com status `5` (enviada) dentro da janela. Para a iteração assim que encontra campanha mais antiga que a janela.
- `getNewContactsCount(daysBack)` — usa filtro `created_after` do endpoint `/contacts`. Falls back para total geral se o filtro for rejeitado.

Cálculos (janela: últimos 30 dias):

| Métrica | Fórmula |
|---|---|
| Taxa de Abertura | `uniqueopens ÷ send_amt × 100` |
| CTR | `uniquelinkclicks ÷ send_amt × 100` |
| CTOR | `uniquelinkclicks ÷ uniqueopens × 100` |
| RPM | `(faturamento_mailx_email ÷ send_amt) × 1000` |
| EPC | `faturamento_mailx_email ÷ uniquelinkclicks` |

Se o cliente não tem AC configurado ou a API falha, mantém `--` (não quebra o dashboard).

### Validação em produção

Cliente "Iron Group" (ID #2) ao vivo:

- Entrada de Contatos: 371
- Taxa de Abertura: 23.49%
- CTR: 2.47%
- CTOR: 10.50%
- RPM: R$ 312,23
- EPC: R$ 12,66

Cliente "Caleb" (ID #3), aba SMS após fix:

- Total Contatos: 1.263 (do SlickText brand)
- Créditos: 477 usados, 5.665 disponíveis, 6.142 total
- Listas SMS: 5

---

## 7. Sincronização Local ↔ GitHub ↔ VPS

VPS estava desatualizada por edições direto via SSH sem commit. Resolvido na primeira parte da sessão:
- VPS adicionado como remote git (`vps`) com `receive.denyCurrentBranch=ignore`
- Force push do local → VPS reset hard → build → PM2 restart
- Todos os 3 ambientes (local, GitHub origin, VPS) agora compartilham o mesmo HEAD

Padrão de deploy adotado para o resto da sessão:
```bash
git push origin main
GIT_SSH_COMMAND="sshpass -p '@Cartpanda123' ssh -o StrictHostKeyChecking=no" git push vps main
ssh root@app.mailxgroup.com 'cd /var/www/mailx && git reset --hard HEAD && npm run build && pm2 restart mailx-api'
```

---

## 8. Status de gateways após sessão

| Gateway | Status | Tracking | Email | Phone | Refund |
|---|---|---|---|---|---|
| CartPanda | INTEGRADO | UTM | sim | sim | sim |
| Digistore24 | INTEGRADO | UTM | sim | sim | sim |
| ClickBank | INTEGRADO | tid / v8 | sim | sim | sim |
| **Buygoods** | **BLOQUEADO** | SubID | **hash** | **não** | **não** |

---

## 9. Endpoints HTTP — estado final

### Webhooks (api.mailxgroup.com)
- `POST /webhook/cartpanda/order-paid`
- `POST /webhook/cartpanda/abandoned-cart`
- `POST /webhook/cartpanda/card-declined`
- `POST /webhook/digistore24/payment`
- `POST /webhook/digistore24/refund`
- `POST /webhook/clickbank/payment` — SALE / BILL / ABANDONED
- `POST /webhook/clickbank/refund` — RFND / CGBK / INSF
- `GET /webhook/health`

### Admin (app.mailxgroup.com)
- `GET /admin/dashboard/overview` — KPIs consolidados
- `GET /admin/dashboard/email` — KPIs agregados de email (novo)
- `GET /admin/dashboard/sms` — KPIs agregados de SMS (novo)
- `GET /admin/dashboard/history` — Histórico importado
- `GET /admin/dashboard/pipeline-kpis` — KPIs por cliente
- `GET /admin/clientes/:id/stats` — Stats do cliente (com email reporting do AC)
- `GET /admin/clientes/:id/sms-stats` — SMS stats do cliente (SlickText API)
- `PATCH /admin/clientes/:id/st-credentials` — Atualizar credenciais SlickText

---

## 10. Commits da sessão (ordenados)

| Hash | Descrição |
|---|---|
| `085c3b1` | feat: integrate SlickText SMS platform into MailX pipeline |
| `35b5b80` | feat: integrate ClickBank INS gateway into MailX pipeline |
| `1c9d6cb` | docs: add Buygoods integration spec and session roadmap |
| `0972ddf` | feat: wire ActiveCampaign reporting into Email tab metrics |
| `76b4003` | fix: SlickText brand_id sanitize and broken endpoints |
| `44b2e7e` | fix: show SlickText brand-wide contact total when kits not yet linked |
| `54d5f8f` | feat: add Email/SMS tabs to main dashboard |

---

*Documento gerado em 2026-05-12. VPS em produção: app.mailxgroup.com (PM2 `mailx-api` online).*
