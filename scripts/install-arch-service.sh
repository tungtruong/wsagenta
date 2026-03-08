#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${1:-/opt/wsagenta}"
SERVICE_NAME="wsagenta"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
ENV_FILE="/etc/wsagenta.env"
EXAMPLE_ENV_FILE="${APP_DIR}/.env.example"

ensure_env_defaults_from_example() {
  if [[ ! -f "${EXAMPLE_ENV_FILE}" ]]; then
    echo "WARN: ${EXAMPLE_ENV_FILE} not found; skip env default sync."
    return
  fi

  if [[ ! -f "${ENV_FILE}" ]]; then
    cp "${EXAMPLE_ENV_FILE}" "${ENV_FILE}"
    chmod 600 "${ENV_FILE}"
    chown root:root "${ENV_FILE}"
    echo "Created ${ENV_FILE} from ${EXAMPLE_ENV_FILE}."
    return
  fi

  local added=0
  while IFS= read -r line || [[ -n "${line}" ]]; do
    [[ -z "${line}" ]] && continue
    [[ "${line}" =~ ^[[:space:]]*# ]] && continue

    local key="${line%%=*}"
    key="${key//[[:space:]]/}"
    [[ -z "${key}" ]] && continue

    if ! grep -Eq "^${key}=" "${ENV_FILE}"; then
      echo "${line}" >> "${ENV_FILE}"
      added=$((added + 1))
    fi
  done < "${EXAMPLE_ENV_FILE}"

  if [[ "${added}" -gt 0 ]]; then
    echo "Added ${added} missing env key(s) from .env.example to ${ENV_FILE}."
  else
    echo "No missing env keys. ${ENV_FILE} is up to date with .env.example."
  fi
}

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
ensure_env_defaults_from_example
if [[ -f "${ENV_FILE}" ]]; then
  echo "Ensure API keys/tokens are filled in ${ENV_FILE} before starting service."
fi

echo "[6/8] Installing systemd service..."
sed "s|^WorkingDirectory=.*$|WorkingDirectory=${APP_DIR}|" \
  "${APP_DIR}/deploy/systemd/wsagenta.service" > "${SERVICE_FILE}"

systemctl daemon-reload
systemctl enable "${SERVICE_NAME}.service"

echo "[7/8] Validating env config..."
missing=0
set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

required_keys=(OPENAI_API_KEY TELEGRAM_BOT_TOKEN)
if [[ "${ENABLE_TAVILY_SEARCH_TOOL:-true}" == "true" ]]; then
  required_keys+=(TAVILY_API_KEY)
fi
if [[ "${ENABLE_ZYTE_WEB_TOOL:-false}" == "true" ]]; then
  required_keys+=(ZYTE_API_KEY)
fi

for key in "${required_keys[@]}"; do
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
