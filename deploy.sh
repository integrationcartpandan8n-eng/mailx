#!/bin/bash

# MailX - Deploy Script 🚀
# Run this on your VPS as root
# Usage: ./deploy.sh

set -e

# Fix line endings (if uploaded from Windows)
sed -i 's/\r$//' "$0"

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║         MailX — Deploy Script 🚀         ║"
echo "╚══════════════════════════════════════════╝"
echo ""

APP_DIR="/var/www/mailx"

# ═══════════════════════════════════════════
# 1. System packages
# ═══════════════════════════════════════════
echo "🔄 [1/8] Atualizando sistema..."
apt update -qq && apt upgrade -y -qq
apt install -y -qq curl git unzip nginx certbot python3-certbot-nginx > /dev/null 2>&1
echo "   ✅ Pacotes instalados"

# ═══════════════════════════════════════════
# 2. Node.js 20
# ═══════════════════════════════════════════
if ! command -v node &> /dev/null; then
    echo "🟢 [2/8] Instalando Node.js 20..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - > /dev/null 2>&1
    apt install -y -qq nodejs > /dev/null 2>&1
else
    echo "🟢 [2/8] Node.js já instalado: $(node -v)"
fi

# ═══════════════════════════════════════════
# 3. Docker
# ═══════════════════════════════════════════
if ! command -v docker &> /dev/null; then
    echo "🐳 [3/8] Instalando Docker..."
    curl -fsSL https://get.docker.com | sh > /dev/null 2>&1
    usermod -aG docker $USER
else
    echo "🐳 [3/8] Docker já instalado"
fi

# ═══════════════════════════════════════════
# 4. PM2
# ═══════════════════════════════════════════
if ! command -v pm2 &> /dev/null; then
    echo "⚙️  [4/8] Instalando PM2..."
    npm install -g pm2 > /dev/null 2>&1
else
    echo "⚙️  [4/8] PM2 já instalado"
fi

# ═══════════════════════════════════════════
# 5. Copy project files
# ═══════════════════════════════════════════
echo "📂 [5/8] Configurando diretório do app..."
mkdir -p $APP_DIR

if [ "$PWD" != "$APP_DIR" ]; then
    # Copy everything including hidden files
    cp -r . $APP_DIR/ 2>/dev/null || cp -r * $APP_DIR/
    # Also copy hidden files explicitly
    cp .env* $APP_DIR/ 2>/dev/null || true
    cp .gitignore $APP_DIR/ 2>/dev/null || true
    cd $APP_DIR
fi
echo "   ✅ Arquivos em $APP_DIR"

# ═══════════════════════════════════════════
# 6. Environment Variables (Interactive)
# ═══════════════════════════════════════════
echo ""
echo "═══════════════════════════════════════════"
echo "🔑 [6/8] Configuração do .env"
echo "═══════════════════════════════════════════"

if [ -f .env ]; then
    echo ""
    echo "   ⚠️  Arquivo .env já existe!"
    read -p "   Deseja reconfigurar? (s/N): " RECONFIG
    if [ "$RECONFIG" != "s" ] && [ "$RECONFIG" != "S" ]; then
        echo "   ✅ Mantendo .env existente"
        SKIP_ENV=true
    fi
fi

if [ "$SKIP_ENV" != "true" ]; then
    echo ""
    echo "   Preencha as credenciais abaixo."
    echo "   (Pressione Enter para manter o padrão entre colchetes)"
    echo ""

    # Database (use default for docker-compose setup)
    DB_URL_DEFAULT="postgresql://mailx:mailx_secret@localhost:5432/mailx"
    read -p "   DATABASE_URL [$DB_URL_DEFAULT]: " DB_URL
    DB_URL=${DB_URL:-$DB_URL_DEFAULT}

    # ActiveCampaign
    echo ""
    echo "   ── ActiveCampaign ──"
    read -p "   AC_API_URL (ex: https://conta.api-us1.com): " AC_URL
    read -p "   AC_API_KEY: " AC_KEY

    # CartPanda
    echo ""
    echo "   ── CartPanda ──"
    read -p "   CARTPANDA_STORE_SLUG (ex: minhaloja): " CP_SLUG
    read -p "   CARTPANDA_API_TOKEN: " CP_TOKEN

    # Domains
    echo ""
    echo "   ── Domínios ──"
    API_DOMAIN_DEFAULT="api.mailxgroup.com"
    APP_DOMAIN_DEFAULT="app.mailxgroup.com"
    SEND_DOMAIN_DEFAULT="envio.mailxgroup.com"
    read -p "   API_DOMAIN [$API_DOMAIN_DEFAULT]: " API_DOM
    API_DOM=${API_DOM:-$API_DOMAIN_DEFAULT}
    read -p "   APP_DOMAIN [$APP_DOMAIN_DEFAULT]: " APP_DOM
    APP_DOM=${APP_DOM:-$APP_DOMAIN_DEFAULT}
    read -p "   SENDING_DOMAIN [$SEND_DOMAIN_DEFAULT]: " SEND_DOM
    SEND_DOM=${SEND_DOM:-$SEND_DOMAIN_DEFAULT}

    # Write .env
    cat > .env << ENVEOF
# MailX - Gerado por deploy.sh em $(date)
PORT=3000
NODE_ENV=production
WEBHOOK_SECRET=

# PostgreSQL
DATABASE_URL=$DB_URL

# CartPanda
CARTPANDA_API_TOKEN=$CP_TOKEN
CARTPANDA_STORE_SLUG=$CP_SLUG

# ActiveCampaign
AC_API_URL=$AC_URL
AC_API_KEY=$AC_KEY
AC_AUTOMATION_COMPRA_APROVADA=
AC_AUTOMATION_CARRINHO_ABANDONADO=

# Google Drive (opcional)
GOOGLE_SERVICE_ACCOUNT_PATH=
GOOGLE_DRIVE_ROOT_FOLDER_ID=

# Domínios
API_DOMAIN=$API_DOM
APP_DOMAIN=$APP_DOM
SENDING_DOMAIN=$SEND_DOM
ENVEOF

    echo ""
    echo "   ✅ .env criado com sucesso"
fi

# Read domains from .env for nginx config
API_DOMAIN=$(grep -E "^API_DOMAIN=" .env | cut -d= -f2)
APP_DOMAIN=$(grep -E "^APP_DOMAIN=" .env | cut -d= -f2)
API_DOMAIN=${API_DOMAIN:-api.mailxgroup.com}
APP_DOMAIN=${APP_DOMAIN:-app.mailxgroup.com}

# ═══════════════════════════════════════════
# 7. Database + Build + Start
# ═══════════════════════════════════════════
echo ""
echo "🐘 [7/8] Subindo PostgreSQL..."
docker compose up -d 2>/dev/null || docker-compose up -d
echo "   ✅ PostgreSQL rodando"

echo ""
echo "🔨 Instalando dependências..."
npm install --omit=dev 2>&1 | tail -1

echo "🔨 Compilando TypeScript..."
npm run build 2>&1
echo "   ✅ Build concluído"

echo ""
echo "🚀 Iniciando aplicação com PM2..."
pm2 delete mailx-api 2>/dev/null || true
pm2 start dist/index.js --name mailx-api --update-env
pm2 save
pm2 startup 2>/dev/null | tail -1 | bash 2>/dev/null || true
echo "   ✅ PM2 rodando"

# Quick health check
sleep 2
if curl -s http://localhost:3000/health > /dev/null 2>&1; then
    echo "   ✅ App respondendo na porta 3000!"
else
    echo "   ⚠️  App pode demorar alguns segundos para iniciar"
    echo "   Verifique com: pm2 logs mailx-api"
fi

# ═══════════════════════════════════════════
# 8. Nginx
# ═══════════════════════════════════════════
echo ""
echo "🌐 [8/8] Configurando Nginx..."

# Generate nginx config with correct domains
cat > /etc/nginx/sites-available/mailx << NGINXEOF
server {
    listen 80;
    server_name $API_DOMAIN $APP_DOMAIN;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_cache_bypass \$http_upgrade;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
NGINXEOF

# Enable the site, remove default
ln -sf /etc/nginx/sites-available/mailx /etc/nginx/sites-enabled/mailx
rm -f /etc/nginx/sites-enabled/default

# Test and reload
if nginx -t 2>/dev/null; then
    systemctl reload nginx
    echo "   ✅ Nginx configurado e rodando"
else
    echo "   ❌ Erro na config do Nginx!"
    nginx -t
    exit 1
fi

# ═══════════════════════════════════════════
# Done!
# ═══════════════════════════════════════════
echo ""
echo "╔══════════════════════════════════════════╗"
echo "║        ✅ Deploy Completo!               ║"
echo "╠══════════════════════════════════════════╣"
echo "║                                          ║"
echo "║  Dashboard:  http://$APP_DOMAIN/admin"
echo "║  Onboarding: http://$APP_DOMAIN/onboarding"
echo "║  Health:     http://$API_DOMAIN/health"
echo "║  Webhooks:   http://$API_DOMAIN/webhook/health"
echo "║                                          ║"
echo "║  📌 Próximos passos:                     ║"
echo "║  1. Ativar SSL: certbot --nginx          ║"
echo "║  2. Configurar webhooks na CartPanda     ║"
echo "║  3. Configurar DNS de email (DKIM/SPF)   ║"
echo "║                                          ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "Para SSL, rode:"
echo "  certbot --nginx -d $API_DOMAIN -d $APP_DOMAIN --non-interactive --agree-tos -m admin@mailxgroup.com"
echo ""
