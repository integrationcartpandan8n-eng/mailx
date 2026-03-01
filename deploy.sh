#!/bin/bash

# MailX - Deploy Script 🚀
# Run this on your VPS as root
# Usage: ./deploy.sh

set -e

# Fix line endings (if uploaded from Windows)
sed -i 's/\r$//' "$0"

echo "📦 Starting MailX Deployment..."

# 1. Update System
echo "🔄 Updating system packages..."
apt update && apt upgrade -y
apt install -y curl git unzip nginx certbot python3-certbot-nginx

# 2. Install Node.js 20
if ! command -v node &> /dev/null; then
    echo "🟢 Installing Node.js 20..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt install -y nodejs
fi

# 3. Install Docker
if ! command -v docker &> /dev/null; then
    echo "🐳 Installing Docker..."
    curl -fsSL https://get.docker.com | sh
    usermod -aG docker $USER
fi

# 4. Install PM2
if ! command -v pm2 &> /dev/null; then
    echo "processes Installing PM2..."
    npm install -g pm2
fi

# 5. Project Setup
APP_DIR="/var/www/mailx"
if [ ! -d "$APP_DIR" ]; then
    echo "📂 Creating app directory at $APP_DIR..."
    mkdir -p $APP_DIR
else
    echo "📂 App directory exists, proceeding..."
fi

# Sync files (assumes script is run from inside the uploaded folder or you move files there)
# If script is run from /root/mailx, we copy to /var/www/mailx
if [ "$PWD" != "$APP_DIR" ]; then
    echo "📂 Moving files to $APP_DIR..."
    cp -r * $APP_DIR/
    cd $APP_DIR
fi

# 6. Database
echo "🐘 Starting PostgreSQL..."
# Ensure docker-compose is running
docker compose up -d

# 7. Environment Variables
if [ ! -f .env ]; then
    echo "⚠️ .env file not found!"
    if [ -f .env.example ]; then
        echo "📄 Copying .env.example to .env..."
        cp .env.example .env
        echo "❗ PLEASE EDIT .env NOW with your real credentials!"
        echo "   nano .env"
        echo "   Then run ./deploy.sh again."
        exit 1
    else
        echo "❌ .env.example not found. Please upload .env file."
        exit 1
    fi
fi

# 8. Build & Start App
echo "🔨 Building application..."
npm install
npm run build

echo "🚀 Starting PM2..."
# Kill old process if exists
pm2 delete mailx-api 2>/dev/null || true
pm2 start dist/index.js --name mailx-api --update-env
pm2 save
pm2 startup | bash || true

# 9. Nginx Setup
echo "globe Configuring Nginx..."
cp nginx.conf /etc/nginx/sites-available/mailx
ln -sf /etc/nginx/sites-available/mailx /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

# 10. SSL
echo "🔒 Setting up SSL..."
# Only run certbot if domains are pointing to this IP. 
# Uncomment below if DNS is ready.
# certbot --nginx -d api.mailxgroup.com -d app.mailxgroup.com --non-interactive --agree-tos -m admin@mailxgroup.com

echo "✅ Deployment Complete!"
echo "   - API: https://api.mailxgroup.com (or http://<IP>)"
echo "   - App: https://app.mailxgroup.com (or http://<IP>/admin)"
