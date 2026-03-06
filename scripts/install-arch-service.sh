#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${1:-/opt/wsagenta}"
SERVICE_NAME="wsagenta"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
ENV_FILE="/etc/wsagenta.env"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Please run as root: sudo bash scripts/install-arch-service.sh [app_dir]"
  exit 1
fi

if [[ ! -f "${APP_DIR}/package.json" ]]; then
  echo "ERROR: ${APP_DIR}/package.json not found."
  echo "Clone or copy project to ${APP_DIR} first."
  exit 1
fi

echo "[1/8] Installing system packages..."
pacman -Sy --noconfirm --needed nodejs npm git

echo "[2/8] Creating system user..."
if ! id -u wsagenta >/dev/null 2>&1; then
  useradd --system --create-home --home-dir /var/lib/wsagenta --shell /usr/bin/nologin wsagenta
fi

echo "[3/8] Installing npm dependencies..."
cd "${APP_DIR}"
npm ci --omit=dev

echo "[4/8] Setting directory permissions..."
chown -R wsagenta:wsagenta "${APP_DIR}"

echo "[5/8] Creating env file template if missing..."
if [[ ! -f "${ENV_FILE}" ]]; then
  cat >"${ENV_FILE}" <<'EOF'
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4.1-mini
MAX_TURNS=20
AUTO_CONTINUE_ON_MAX_TURNS=true
MAX_RUN_SEGMENTS=3
WORKSPACE_DIR=.
ENABLE_SHELL_TOOL=false
TELEGRAM_BOT_TOKEN=
ENABLE_TAVILY_SEARCH_TOOL=true
TAVILY_API_KEY=
ENABLE_ZYTE_WEB_TOOL=true
ZYTE_API_KEY=
VERBOSE_AGENT_LOG=true
EOF
  chmod 600 "${ENV_FILE}"
  chown root:root "${ENV_FILE}"
  echo "Created ${ENV_FILE}. Fill API keys/tokens before starting service."
fi

echo "[6/8] Installing systemd service..."
sed "s|^WorkingDirectory=.*$|WorkingDirectory=${APP_DIR}|" \
  "${APP_DIR}/deploy/systemd/wsagenta.service" > "${SERVICE_FILE}"

systemctl daemon-reload
systemctl enable "${SERVICE_NAME}.service"

echo "[7/8] Validating env config..."
missing=0
for key in OPENAI_API_KEY TELEGRAM_BOT_TOKEN TAVILY_API_KEY ZYTE_API_KEY; do
  if ! grep -E "^${key}=.+" "${ENV_FILE}" >/dev/null 2>&1; then
    echo "Missing ${key} in ${ENV_FILE}"
    missing=1
  fi
done

echo "[8/8] Starting service..."
if [[ "${missing}" -eq 1 ]]; then
  echo "Service not started because required keys are missing."
  echo "Edit ${ENV_FILE}, then run:"
  echo "  sudo systemctl restart ${SERVICE_NAME}.service"
  exit 0
fi

systemctl restart "${SERVICE_NAME}.service"
echo "Service status:"
systemctl --no-pager --full status "${SERVICE_NAME}.service" || true

echo "Done. Logs: journalctl -u ${SERVICE_NAME}.service -f"
