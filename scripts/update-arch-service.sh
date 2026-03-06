#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${1:-/opt/wsagenta}"
SERVICE_NAME="wsagenta"
BRANCH="${2:-main}"

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

echo "[5/7] Fixing ownership..."
chown -R wsagenta:wsagenta "${APP_DIR}"

echo "[6/7] Reloading systemd and restarting service..."
systemctl daemon-reload
systemctl restart "${SERVICE_NAME}.service"

echo "[7/7] Done. Current status:"
systemctl --no-pager --full status "${SERVICE_NAME}.service" || true

echo "Live logs: journalctl -u ${SERVICE_NAME}.service -f"
