# MailX — Guia de Deploy

## Infraestrutura

| Item | Valor |
|------|-------|
| **VPS** | `app.mailxgroup.com` (root) |
| **Diretório** | `/var/www/mailx` |
| **Processo** | PM2 → `mailx-api` (porta 3000) |
| **Build** | TypeScript → `dist/` via `npm run build` |
| **Banco** | Docker → `mailx-postgres` (PostgreSQL) |
| **Node.js** | v20.20.0 |

## Fluxo de Deploy

```
Local → GitHub (push) → VPS (pull + build + restart)
```

### 1. Commit e Push Local

```bash
git add -A
git commit -m "feat: descrição da mudança"
git push origin main
```

### 2. Na VPS (SSH)

```bash
ssh root@app.mailxgroup.com
cd /var/www/mailx
git pull origin main
npm run build
pm2 restart mailx-api
```

### 3. Verificação

```bash
pm2 status                    # Deve mostrar "online"
pm2 logs mailx-api --lines 5  # Verificar se não há erros
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/admin  # Esperado: 302
```

## ⚠️ Git Pull na VPS

O `git pull` requer autenticação HTTPS. Opções para resolver:

### Opção A: GitHub Personal Access Token (recomendado)

```bash
# Na VPS:
git remote set-url origin https://<TOKEN>@github.com/integrationcartpandan8n-eng/mailx.git
```

### Opção B: Deploy Key SSH

```bash
# Na VPS, gerar chave:
ssh-keygen -t ed25519 -C "mailx-deploy"
cat ~/.ssh/id_ed25519.pub
# Adicionar como Deploy Key no GitHub Settings → Deploy Keys

# Mudar remote para SSH:
git remote set-url origin git@github.com:integrationcartpandan8n-eng/mailx.git
```

### Opção C: SFTP Direto (fallback)

Caso o git não funcione, copiar arquivos via SFTP e rebuild:

```bash
# Do local (PowerShell com scp):
scp src/admin/router.ts root@app.mailxgroup.com:/var/www/mailx/src/admin/router.ts
# Na VPS:
cd /var/www/mailx && npm run build && pm2 restart mailx-api
```

## Comandos Úteis

```bash
# Logs em tempo real
pm2 logs mailx-api

# Status do banco
docker exec mailx-postgres psql -U mailx -d mailx -c "SELECT COUNT(*) FROM webhook_logs"

# Verificar webhooks órfãos
docker exec mailx-postgres psql -U mailx -d mailx -c "SELECT COUNT(*) FROM webhook_logs WHERE client_id IS NULL"

# Reparar webhooks órfãos (via API)
curl -X POST http://localhost:3000/admin/clientes/2/repair-webhooks -H "Cookie: <session>"
```
