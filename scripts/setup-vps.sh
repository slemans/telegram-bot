#!/usr/bin/env bash
# Развёртывание на Linux VPS: Node 20, клон из GitHub, PM2.
# Использование:
#   curl -fsSL ... | bash   # или скопируйте репозиторий и запустите:
#   chmod +x scripts/setup-vps.sh && ./scripts/setup-vps.sh
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/slemans/telegram-bot.git}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/telegram-bot}"

need_cmd() { command -v "$1" >/dev/null 2>&1 || { echo "Нужна команда: $1"; exit 1; }; }

if ! command -v node >/dev/null 2>&1; then
  echo "Установите Node.js 20.x (например: https://github.com/nvm-sh/nvm или пакет node из дистрибутива)."
  exit 1
fi

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [ "${NODE_MAJOR}" -lt 20 ]; then
  echo "Нужен Node.js >= 20, сейчас: $(node --version)"
  exit 1
fi

need_cmd git
need_cmd npm

if [ -d "${INSTALL_DIR}/.git" ]; then
  echo "Обновление ${INSTALL_DIR}..."
  git -C "${INSTALL_DIR}" pull --ff-only
else
  echo "Клонирование в ${INSTALL_DIR}..."
  git clone "${REPO_URL}" "${INSTALL_DIR}"
fi

cd "${INSTALL_DIR}"
npm install --omit=dev

if [ ! -f .env ]; then
  if [ -f .env.example ]; then
    cp .env.example .env
    echo ""
    echo "Создан файл .env из шаблона. Отредактируйте его (Supabase, BOT_TOKEN, MoyKlass), затем:"
    echo "  pm2 start ecosystem.config.cjs && pm2 save && pm2 startup"
    echo ""
  else
    echo "Создайте файл .env с переменными из .env.example"
  fi
  exit 0
fi

if ! command -v pm2 >/dev/null 2>&1; then
  echo "Установка PM2 глобально..."
  npm install -g pm2
fi

pm2 start ecosystem.config.cjs || pm2 reload ecosystem.config.cjs
pm2 save

echo ""
echo "Дальше:"
echo "  1) Убедитесь, что HTTPS проксирует на 127.0.0.1:\$PORT (см. scripts/nginx-webhook.example.conf)."
echo "  2) Зарегистрируйте webhook в Telegram (подставьте свой домен и токен):"
echo "     curl -sS \"https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<ВАШ-ДОМЕН>/webhook\""
echo ""
