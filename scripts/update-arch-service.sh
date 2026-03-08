#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${1:-/opt/wsagenta}"
SERVICE_NAME="wsagenta"
BRANCH="${2:-main}"
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
  echo "Please run as root: sudo bash scripts/update-arch-service.sh [app_dir] [branch]"
  exit 1
fi

if [[ ! -d "${APP_DIR}/.git" ]]; then
  echo "ERROR: ${APP_DIR} is not a git repository."
  exit 1
fi

echo "[1/7] Updating package index and ensuring runtime deps..."
pacman -Sy --noconfirm --needed nodejs npm git

echo "[2/7] Fetching latest code from origin/${BRANCH}..."
cd "${APP_DIR}"
git fetch origin

echo "[3/7] Switching to ${BRANCH} and resetting to remote state..."
git checkout "${BRANCH}"
git reset --hard "origin/${BRANCH}"

echo "[4/7] Installing production dependencies..."
npm ci --omit=dev

echo "[5/8] Fixing ownership..."
chown -R wsagenta:wsagenta "${APP_DIR}"

echo "[6/8] Syncing missing env defaults from .env.example..."
ensure_env_defaults_from_example

echo "[7/8] Reloading systemd and restarting service..."
systemctl daemon-reload
systemctl restart "${SERVICE_NAME}.service"

echo "[8/8] Done. Current status:"
systemctl --no-pager --full status "${SERVICE_NAME}.service" || true

echo "Live logs: journalctl -u ${SERVICE_NAME}.service -f"
