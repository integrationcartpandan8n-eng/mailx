# MailX — Changelog

## [2025-04-13] — UTM Metrics, Top 5, Pipeline Store, Data Isolation

### ✨ Features

- **UTM MailX Attribution**: Métricas de vendas/faturamento filtradas por `utm_campaign` ou `utm_source` contendo "mailx" (via `payload.order.checkout_params`)
- **Recuperação de Carrinho**: Métrica de vendas onde `utm_source` contém "CarrinhoAbandonado" (case-insensitive)
- **Top 5 Produtos**: Bar chart horizontal no client-detail mostrando os 5 produtos mais vendidos (nome + vendas + faturamento no tooltip)
- **Pipeline — Nova Loja**: Modal inline no pipeline para criar nova loja diretamente no card do cliente (plataforma + slug + token)
- **Métricas no Dashboard Global**: KPIs de Recuperações e Faturamento de Recuperações adicionados ao overview

### 🐛 Fixes

- **Isolamento client_id**: TODAS as queries de stats do client-detail agora filtram por `AND client_id = $1` — elimina contaminação cruzada entre clientes
- **Repair Webhooks**: Endpoint melhorado para usar `payload.order.shop.name` para matching mais preciso, limite de 5000 webhooks, normalização de payload wrapper

### 🗑️ Removidos

- **Onboarding — Kits/Produtos**: Seção "Kits/Produtos" removida do formulário de onboarding (HTML + CSS + JS). Produtos agora são auto-discovered via webhooks
- **parseKits()**: Função removida do `onboarding/router.ts`

### 📊 Dados de Produção (snapshot)

| Métrica | Valor |
|---------|-------|
| Total de webhooks | 882 |
| order.paid | 246 |
| abandoned_cart | 165 |
| card.declined | 471 |
| Webhooks com UTM | 272 (129 order.paid + 129 abandoned + 14 card.declined) |
| utm_source values | facebook, Google, mailx, TikTok |
| Produtos distintos | 10 (HorsePeak líder com 107 vendas) |

### 📁 Arquivos Alterados

- `src/admin/router.ts` — Backend queries + UTM + Top 5 + client_id fix
- `src/admin/client-detail.html` — MailX KPIs + Top 5 chart
- `src/admin/dashboard.html` — Recovery KPIs + Store modal
- `src/onboarding/form.html` — Kits removidos
- `src/onboarding/router.ts` — parseKits removido

---

## [2025-04-13] — VPS Sync (commit 0247481)

### 🔄 Sync

- Sincronização de 4 arquivos com alterações feitas diretamente na VPS
- **Payload Normalization**: `const data = payload.order || payload` em todos os webhook handlers
- **Revenue Parsing**: `REPLACE(..., ',', '')` para handling de vírgulas nos valores monetários
- **KPI Logic**: Taxa de sucesso redefinida como conversão (Vendas / (Vendas + Abandonados + Recusados))
