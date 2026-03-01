# Guia de Configuração e Domínios

Este guia consolida todas as configurações externas necessárias para colocar o MailX em produção.

## 1. Domínios e DNS (Hostinger/Cloudflare)

Você precisará criar **2 registros A** apontando para o IP da sua VPS Hostinger KVm2.

| Tipo  | Nome (Host) | Valor (Destino)   | Finalidade                                        |
| ----- | ----------- | ----------------- | ------------------------------------------------- |
| **A** | `api`       | `[IP_DA_SUA_VPS]` | Recebe webhooks da CartPanda                      |
| **A** | `app`       | `[IP_DA_SUA_VPS]` | Painel Admin e Onboarding                         |
| **A** | `envio`     | `[IP_DA_SUA_VPS]` | Domínio "técnico" de envio (opcional, ver abaixo) |

### Autenticação de Email (DKIM, SPF, DMARC)

No ActiveCampaign, você configurará o domínio de envio (ex: `envio.mailxgroup.com` ou o próprio domínio raiz). O ActiveCampaign fornecerá os valores exatos, mas a estrutura será:

| Tipo      | Nome (Host)     | Valor (Exemplo)                          |
| --------- | --------------- | ---------------------------------------- |
| **CNAME** | `em.envio`      | `return.acems1.com`                      |
| **CNAME** | `s1._domainkey` | `dkim.acems1.com`                        |
| **CNAME** | `s2._domainkey` | `dkim2.acems1.com`                       |
| **TXT**   | `envio`         | `v=spf1 include:emsd1.com ~all`          |
| **TXT**   | `_dmarc.envio`  | `v=DMARC1; p=none; rua=mailto:dmarc@...` |

> ⚠️ **Nota:** Estes registros de email você pega dentro do painel do ActiveCampaign em _Configurações > Avançado > Gerenciar Domínios_.

---

## 2. ActiveCampaign

1. Acesse **Configurações > Desenvolvedor**.
2. Copie a **URL da API** e a **Chave da API**.
3. No servidor, ao rodar `./deploy.sh`, ele pedirá para editar o `.env`. Cole esses valores:
   ```env
   AC_API_URL=https://sua-conta.api-us1.com
   AC_API_KEY=sua-chave-gigante-aqui...
   ```

---

## 3. CartPanda (Webhooks)

Na CartPanda da loja, vá em **Configurações > Webhooks** e crie dois webhooks:

### Webhook 1: Compra Aprovada

- **Evento:** `order.paid` (Pedido Pago)
- **URL:** `https://api.mailxgroup.com/webhook/cartpanda/order-paid`
- **Versão:** Mais recente

### Webhook 2: Carrinho Abandonado

- **Evento:** `abandoned_checkout` (Carrinho Abandonado)
- **URL:** `https://api.mailxgroup.com/webhook/cartpanda/abandoned-cart`

> Se pedir "Token de Autenticação" ou Secret, você pode gerar um aleatório e colocar no `.env` do servidor como `WEBHOOK_SECRET` (opcional por enquanto).

---

## 4. Google Drive (Opcional)

Se quiser que o sistema crie pastas no Drive automaticamente para cada cliente:

1. Crie um projeto no **Google Cloud Console**.
2. Ative a **Google Drive API**.
3. Crie uma **Service Account** e baixe o JSON (`credentials.json`).
4. Coloque esse JSON na pasta do projeto na VPS (ex: `/root/mailx/google-credentials.json`).
5. No `.env`, aponte o caminho:
   ```env
   GOOGLE_SERVICE_ACCOUNT_PATH=/root/mailx/google-credentials.json
   ```
