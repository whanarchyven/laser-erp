#!/usr/bin/env bash
# Starts the whole server with one command: Convex backend, dashboard and the web UI.
# The first run builds the web UI and pushes the Convex functions, later runs just start it.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/.." && pwd)
cd "$here"

# Running as administrator (needed for the firewall) drops the user's Node from PATH.
if ! command -v npx >/dev/null 2>&1; then
  for d in "$root/node_modules/.bin" /usr/local/bin "$HOME/.nvm/current/bin" /opt/homebrew/bin; do
    [ -x "$d/npx" ] && export PATH="$d:$PATH" && break
  done
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker не найден. Установите Docker Desktop (Windows/macOS) или пакет docker.io (Linux)." >&2
  exit 1
fi
compose=(docker compose)
if ! docker compose version >/dev/null 2>&1; then
  if command -v docker-compose >/dev/null 2>&1; then compose=(docker-compose); else
    echo "Не найден ни 'docker compose', ни docker-compose." >&2
    exit 1
  fi
fi

# The address other computers (the machines) use to reach this one.
# A real network address of this computer, skipping loopback, link-local and container bridges.
ip=""
candidates=""
if command -v hostname >/dev/null 2>&1; then candidates=$(hostname -I 2>/dev/null); fi
if [ -z "$candidates" ] && command -v ipconfig >/dev/null 2>&1; then
  candidates=$(ipconfig | tr -d '\r' | awk '/IPv4/{print $NF}')
fi
for c in $candidates; do
  case "$c" in
    127.*|169.254.*|172.1[6-9].*|172.2[0-9].*|172.3[0-1].*) continue ;;
  esac
  echo "$c" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' || continue
  ip=$c; break
done
[ -n "$ip" ] || ip=127.0.0.1

port=3210
site=3211
web=5173
dashboard=6791

envfile="$here/.env"
if [ ! -f "$envfile" ]; then
  secret=$(openssl rand -hex 32)
  cat > "$envfile" <<EOF
PORT=$port
SITE_PROXY_PORT=$site
WEB_PORT=$web
DASHBOARD_PORT=$dashboard
CONVEX_CLOUD_ORIGIN=http://$ip:$port
CONVEX_SITE_ORIGIN=http://$ip:$site
INSTANCE_NAME=laser-erp
INSTANCE_SECRET=$secret
AGENT_TOKEN=laser-stand-dev
API_TOKEN=laser-stand-dev
EOF
  echo "Создан $envfile"
fi
set -a; source "$envfile"; set +a

echo "Запускаю сервер..."
"${compose[@]}" up -d --build

# On Windows and macOS the firewall container cannot touch the host firewall.
if [ "$(uname -s)" = "Linux" ] && command -v firewall-cmd >/dev/null 2>&1; then
  for p in "$PORT" "$SITE_PROXY_PORT" "$WEB_PORT" "$DASHBOARD_PORT"; do
    sudo firewall-cmd --permanent --add-port="$p/tcp" >/dev/null 2>&1 || true
  done
  sudo firewall-cmd --reload >/dev/null 2>&1 || true
fi

echo "Жду готовности Convex..."
for _ in $(seq 1 60); do
  curl -fs "http://127.0.0.1:$PORT/version" >/dev/null 2>&1 && break
  sleep 2
done
curl -fs "http://127.0.0.1:$PORT/version" >/dev/null 2>&1 || { echo "Convex не ответил за две минуты." >&2; exit 1; }

# Admin key from the instance secret, the same way the backend image does it.
admin=$(docker run --rm -e INSTANCE_NAME="$INSTANCE_NAME" -e INSTANCE_SECRET="$INSTANCE_SECRET" \
  --entrypoint /convex/generate_admin_key.sh ghcr.io/convex/convex-backend:latest | tr -d '\r' | tail -1)

echo "Загружаю функции..."
( cd "$root" && npx convex deploy --yes \
    --admin-key "$admin" \
    --url "http://127.0.0.1:$PORT" \
    --env-file /dev/null )
api_token=${API_TOKEN:-$AGENT_TOKEN}
( cd "$root" && npx convex env set AGENT_TOKEN "$AGENT_TOKEN" --admin-key "$admin" --url "http://127.0.0.1:$PORT" ) >/dev/null
( cd "$root" && npx convex env set API_TOKEN "$api_token" --admin-key "$admin" --url "http://127.0.0.1:$PORT" ) >/dev/null

host=${CONVEX_SITE_ORIGIN#*://}; host=${host%%:*}
cat <<EOF

Готово.
  Веб:            http://$host:$WEB_PORT
  BaseUrl агента: $CONVEX_SITE_ORIGIN   (его вводить при установке агента на станке)
  Ключ агента:    $AGENT_TOKEN
  Ключ API:       $api_token   (внешнее приложение, контракт docs/API.md)
  Панель Convex:  http://$host:$DASHBOARD_PORT
Остановка:  ${compose[*]} -f "$here/docker-compose.yml" down
Журналы:    ${compose[*]} -f "$here/docker-compose.yml" logs -f
EOF
