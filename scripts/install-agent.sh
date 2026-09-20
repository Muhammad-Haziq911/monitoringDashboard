#!/usr/bin/env bash
#
# Installs the HomeLab Dashboard agent as a systemd service on a monitored
# node. Run this on every machine you want on the dashboard, including the
# server box itself (otherwise it never reports its own metrics):
#
#   sudo ./scripts/install-agent.sh --server http://192.168.1.50:8000 --key <agent-key>
#
# Options:
#   --server <url>    dashboard base URL, or the full /api/report URL
#   --key <key>       agent key from the server (printed by install-server.sh)
#   --interval <sec>  reporting interval (default: 5)
#   --user <name>     user to run the agent as (default: root)
#
# Config is written to /etc/homelab-agent.env, so agent.py itself is never
# edited and stays in sync with git.
#
set -euo pipefail

SERVICE_NAME="homelab-agent"
ENV_FILE="/etc/homelab-agent.env"
SERVER=""
KEY=""
INTERVAL=5
RUN_USER="root"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --server)   SERVER="$2";   shift 2 ;;
        --key)      KEY="$2";      shift 2 ;;
        --interval) INTERVAL="$2"; shift 2 ;;
        --user)     RUN_USER="$2"; shift 2 ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

if [[ $EUID -ne 0 ]]; then
    echo "This script needs root to install the systemd unit. Re-run with sudo." >&2
    exit 1
fi

# Fall back to whatever a previous install used, so re-running to pick up a
# new agent.py does not require passing the arguments again.
if [[ -f "$ENV_FILE" ]]; then
    # shellcheck disable=SC1090
    source "$ENV_FILE"
    [[ -z "$SERVER" ]] && SERVER="${HOMELAB_SERVER_URL:-}"
    [[ -z "$KEY" ]] && KEY="${HOMELAB_AGENT_KEY:-}"
fi

if [[ -z "$SERVER" || -z "$KEY" ]]; then
    echo "Both --server and --key are required on first install." >&2
    echo "The key is printed by install-server.sh, or shown in the dashboard UI." >&2
    exit 1
fi

# Accept either a base URL or the full endpoint.
case "$SERVER" in
    */api/report) REPORT_URL="$SERVER" ;;
    */)           REPORT_URL="${SERVER}api/report" ;;
    *)            REPORT_URL="$SERVER/api/report" ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
AGENT_DIR="$REPO_ROOT/agent"
VENV_DIR="$AGENT_DIR/.venv"

if [[ ! -f "$AGENT_DIR/agent.py" ]]; then
    echo "Could not find agent/agent.py under $REPO_ROOT." >&2
    exit 1
fi

if ! id -u "$RUN_USER" >/dev/null 2>&1; then
    echo "User '$RUN_USER' does not exist." >&2
    exit 1
fi

echo "==> Installing agent from $AGENT_DIR (reporting to $REPORT_URL)"

if ! command -v python3 >/dev/null 2>&1; then
    echo "python3 not found. Install Python 3.10+ and re-run." >&2
    exit 1
fi

# A Windows .venv is committed to this repo; it cannot run here.
if [[ -d "$VENV_DIR" && ! -x "$VENV_DIR/bin/python" ]]; then
    echo "==> Removing non-Linux virtualenv at $VENV_DIR"
    rm -rf "$VENV_DIR"
fi

echo "==> Creating virtualenv at $VENV_DIR"
python3 -m venv "$VENV_DIR"
"$VENV_DIR/bin/pip" install --quiet --upgrade pip
"$VENV_DIR/bin/pip" install --quiet -r "$AGENT_DIR/requirements.txt"

echo "==> Writing $ENV_FILE"
cat > "$ENV_FILE" <<ENV
HOMELAB_SERVER_URL=$REPORT_URL
HOMELAB_AGENT_KEY=$KEY
HOMELAB_INTERVAL=$INTERVAL
ENV
# Contains the shared agent key.
chmod 600 "$ENV_FILE"
chown "$RUN_USER" "$ENV_FILE"

echo "==> Writing /etc/systemd/system/$SERVICE_NAME.service"
cat > "/etc/systemd/system/$SERVICE_NAME.service" <<UNIT
[Unit]
Description=HomeLab Dashboard Agent Service
After=network.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$AGENT_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$VENV_DIR/bin/python agent.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME.service"

sleep 3
if systemctl is-active --quiet "$SERVICE_NAME.service"; then
    echo
    echo "Agent running. This node should appear on the dashboard within a few seconds."
    echo "Follow its log with: journalctl -u $SERVICE_NAME -f"
else
    echo
    echo "Agent failed to start. Recent log:" >&2
    journalctl -u "$SERVICE_NAME" -n 20 --no-pager >&2
    exit 1
fi
