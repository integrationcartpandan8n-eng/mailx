# Buygoods — Documentação de Integração

> **Status: BLOQUEADO** — Faltam dados críticos (email em texto plano, nome, telefone).
> A integração só é viável pelo lado **vendor** (New Order URL), não pelo lado affiliate (postback).

---

## 1. Visão Geral da Plataforma

Buygoods (buygoods.com) é um marketplace de performance e rede de afiliados com checkout otimizado para conversão. Processa $3B+ em comissões e hospeda ~250 produtos em 16 categorias.

- **Dashboard:** `backoffice.buygoods.com`
- **API (limitada):** `api.buygoods.com` → redireciona para lookup de pedidos (não é API REST)
- **Admin interno:** `admin3.buygoods.com/public/v2/subscribe` (newsletter, não API dev)

---

## 2. Sistema de Notificações

### 2.1 Postback do Afiliado (S2S)

**Localização:** BuyGoods Backoffice → AffOverview → Postback Pixels → Add New

**Formato:** GET request com query parameters (macros substituídas por valores reais)

**Eventos disponíveis:**

| Evento | Descrição |
|---|---|
| Purchase (frontend) | Venda padrão |
| Upsell Purchase | Upsell durante checkout |
| InitiateCheckout | Visitante chega no checkout (JS) |
| View Content | Visitante na landing (pixel client-side) |

**Eventos NÃO disponíveis via postback:**
- Refund
- Chargeback
- Cancelamento de assinatura
- Rebill de assinatura

### 2.2 New Order URL do Vendor

**Localização:** BuyGoods Backoffice → Setup → Products → Settings → "NEW ORDER URL"

Este é o webhook do lado vendor — potencialmente contém dados completos do cliente (email, nome, telefone), mas **não está documentado publicamente**. Requer acesso de vendor para verificar.

---

## 3. Macros de Postback (Lista Completa)

| Macro | Descrição | Exemplo |
|---|---|---|
| `{SUBID}` | SubID principal (tracking) | `dGzcYls3mRnetyw62qTieJ11wgtvFIg2rZ` |
| `{SUBID2}` | SubID secundário | `campaign1` |
| `{SUBID3}` | SubID terciário | `adgroup1` |
| `{SUBID4}` | SubID quaternário | `p17` |
| `{SUBID5}` | SubID quinário | `e_vsl_ml1` |
| `{ORDERID}` | ID do pedido | `678463` |
| `{PRODUCT_CODENAME}` | Código do produto | `atgc6TSSC` |
| `{COMMISSION_AMOUNT}` | Valor da comissão | `390.00` |
| `{CONV_TYPE}` | Tipo de conversão | `purchase` / `upsell` |
| `{EMAILHASH}` | Email hasheado | `80ED0FCB080F9CEF...` |

### Exemplo de URL de Postback Configurada:
```
https://api.mailxgroup.com/webhook/buygoods?subid={SUBID}&orderid={ORDERID}&amount={COMMISSION_AMOUNT}&product={PRODUCT_CODENAME}&type={CONV_TYPE}&email={EMAILHASH}
```

---

## 4. Payload Real de Exemplo

```json
{
  "affiliates_conversion_pixel_id": "12386",
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

**Observações críticas:**
- `email` é um **hash**, não texto plano — impossível reverter
- **Sem `first_name`, `last_name`, `phone`** — não há dados pessoais
- `PRODUCT_CODENAME` é um código alfanumérico, não o nome legível do produto
- `COMMISSION_AMOUNT` é string com decimal
- SubIDs podem ser `null` quando não passados

---

## 5. Autenticação / Verificação

**NÃO EXISTE mecanismo documentado de verificação:**
- Sem HMAC/signature
- Sem secret key
- Sem IP whitelist documentada

**Mitigações possíveis:**
1. URL com path secreto: `/webhook/buygoods/a8f3k2x9m1`
2. Validar `PRODUCT_CODENAME` contra produtos conhecidos
3. Verificar presença de `ORDERID` e `COMMISSION_AMOUNT`
4. Solicitar IP whitelist ao suporte da Buygoods

---

## 6. Tracking via SubID

Buygoods usa SubIDs em vez de UTMs. O doc de UTMs define o padrão:

### Para Email Automação:
```
subid=Mailx_AutoEmail_CarrinhoAbandonado1_2ALeanzene_2Frascos_LeanzeneCaminhoC
```

### Para Email Campanhas:
```
subid=Mailx_CampaignEditorial_26_10_25_18h00_GlucoBurnDiabetes27A
```

### Para SMS Automação:
```
subid=MailxSMS_AutoSMS_CarrinhoAbandonadoMS0001ASoulDetoxDrops_Buy6Get1Free20OFF_SoulDetoxDropsCaminhoA
```

### Scripts de Captura de Click ID:
```html
<!-- Facebook -->
<script src="https://buygoods.com/js/facebook_link_manager.js"></script>
<!-- + &fb=1 nos links -->

<!-- Google -->
<script src="https://buygoods.com/js/google_link_manager.js"></script>
<!-- + &ga=1 nos links -->

<!-- TikTok -->
<script src="https://buygoods.com/js/tiktok_link_manager.js"></script>
<!-- + &tt=1 nos links -->
```

---

## 7. API REST

**NÃO EXISTE API REST pública.** Não há:
- Portal de developer
- Documentação de API
- Endpoints de consulta de pedidos
- Endpoints de consulta de produtos

O botão "Request API Access" existe no dashboard de vendor, mas o acesso é gated por aprovação manual.

---

## 8. Limitações Críticas para o Pipeline MailX

| Dado | Disponível? | Impacto |
|---|---|---|
| Email (plaintext) | **NÃO** (só hash) | Impossível criar contato no AC/SlickText |
| Nome | **NÃO** | Impossível personalizar emails/SMS |
| Telefone | **NÃO** | Impossível criar contato no SlickText |
| Refund/Chargeback | **NÃO** | Impossível rastrear reembolsos |
| Nome do produto | **NÃO** (só codename) | Precisa mapear codename → nome |
| Valor total da venda | **NÃO** (só comissão) | Faturamento real não disponível |

---

## 9. Comparativo com Gateways Já Integrados

| Feature | CartPanda | Digistore24 | ClickBank | Buygoods |
|---|---|---|---|---|
| Método | JSON POST | JSON POST | JSON Encrypted POST | GET query params |
| Email plaintext | SIM | SIM | SIM | **HASH** |
| Nome/Telefone | SIM | SIM | SIM | **NÃO** |
| Refund/Chargeback | SIM | SIM | SIM | **NÃO** |
| Verificação auth | API Key | SHA512 sig | AES-256-CBC decrypt | **Nenhuma** |
| REST API | SIM | SIM | SIM | **NÃO** |
| Tracking | UTM | UTM | tid + v8 params | SubID |

---

## 10. Roadmap para Integração Futura

### Fase 1: Investigação (BLOQUEANTE)
- [ ] Conseguir acesso de vendor no Buygoods
- [ ] Verificar payload da "New Order URL" (vendor-side) — pode ter email/nome/phone
- [ ] Contatar `affiliates@buygoods.com` pedindo:
  - Documentação da New Order URL
  - Se email plaintext está disponível
  - Se há webhook de refund/chargeback
  - IP whitelist para verificação

### Fase 2: Implementação Mínima (se New Order URL tiver dados completos)
- [ ] Criar `src/services/buygoods.ts` — normalizador de payload GET
- [ ] Criar `src/webhooks/buygoods-payment.handler.ts`
- [ ] Adicionar rotas `/webhook/buygoods/payment`
- [ ] Adicionar Buygoods no onboarding (product codename + vendor ID)
- [ ] Mapear `PRODUCT_CODENAME` → nome do produto no banco

### Fase 3: Implementação Completa (se tudo disponível)
- [ ] Integração com AC (tags, listas)
- [ ] Integração com SlickText (SMS)
- [ ] Métricas no dashboard
- [ ] Suporte a refund/chargeback (se disponível)

### Se New Order URL NÃO tiver dados completos:
A integração via Buygoods só serviria para tracking de conversão (faturamento/comissão), mas **não** para automação de email/SMS. Nesse caso, o fluxo de automação teria que vir de outra fonte (ex: formulário de captura separado + UTM matching).

---

## 11. Credenciais Necessárias do Cliente

| Credencial | Onde encontrar | Para que serve |
|---|---|---|
| Affiliate ID (`aff_id`) | Dashboard Buygoods | Identificador do afiliado |
| Product Codenames | Dashboard de produtos | Mapear para nomes de produtos |
| New Order URL (vendor) | Product Settings | Webhook do lado vendor |
| Conversions API Token | Developer section | Facebook/Meta CAPI (opcional) |

---

*Documento gerado em 2026-05-04. Atualizar quando houver mais informações do vendor-side.*
