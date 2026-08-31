# 🩺 Troubleshooting & Diagnostics Guide

This document provides resolutions for common operational issues, hardware sensor detection failures, networking problems, and browser behaviors in the **HomeLab Dashboard**.

---

## 1. Connection & Streaming Issues

### Symptom: Topbar says "Reconnecting" or stream freezes
- **Cause 1: Reverse Proxy Buffering**: Nginx or Traefik is buffering SSE packets.
  - **Resolution**: In your Nginx configuration block, ensure `proxy_buffering off;`, `proxy_cache off;`, `proxy_http_version 1.1;`, and `proxy_read_timeout 86400s;` are set.
- **Cause 2: Invalid or Expired Session**: The browser session token expired.
  - **Resolution**: Click the Logout button in the top right to clear the local token and log in again.
- **Cause 3: Backend Process Crashed**:
  - **Resolution**: Check backend service logs:
    ```bash
    sudo journalctl -u homelab-dashboard.service -f -n 50
    ```

---

### Symptom: Node appears "Offline" on Dashboard
- **Explanation**: A node is marked offline if the dashboard has not received an HTTP report within **15 seconds** (`OFFLINE_AFTER = 15`).
- **Diagnosis Checklist**:
  1. Check if `agent.py` is actively running on the client machine:
     ```bash
     sudo systemctl status homelab-agent.service
     ```
  2. Verify that the agent can reach the server URL:
     ```bash
     curl -I http://<DASHBOARD-IP>:8000/api/auth/status
     ```
  3. Ensure the server firewall allows inbound connections on the dashboard port (default: 8000 or 443).

---

## 2. Authentication & Security Issues

### Symptom: Agent reports `401 Unauthorized agent key`
- **Cause**: The `AGENT_KEY` string in `agent/agent.py` does not match the `agent_auth_key` generated on the dashboard server.
- **Resolution**:
  1. Log in to the Web UI as administrator.
  2. Click the **Key** badge in the top right header to copy the master Agent Key.
  3. Update `AGENT_KEY = "<COPIED_KEY>"` in `agent.py` on the client host.
  4. Restart the agent: `sudo systemctl restart homelab-agent.service`.

---

### Symptom: Locked out of Admin Account / Need to Reset Credentials
If you forget your administrator password or need to re-run the first-run setup wizard:
1. Stop the backend server:
   ```bash
   sudo systemctl stop homelab-dashboard.service
   ```
2. Delete the existing users from the SQLite database:
   ```bash
   sqlite3 /opt/homelab-dashboard/backend/history.db "DELETE FROM users; DELETE FROM sessions;"
   ```
3. Restart the backend server:
   ```bash
   sudo systemctl start homelab-dashboard.service
   ```
4. Open the Web UI in your browser. The **Create Admin Account** registration overlay will automatically appear.

---

## 3. Hardware Sensors & Telemetry

### Symptom: CPU Wattage shows `—` or 0W on Linux
- **Cause 1: Linux RAPL Access**: Some Linux distributions restrict read access to the Intel/AMD RAPL sysfs directory (`/sys/class/powercap/intel-rapl/`).
  - **Resolution**: Ensure the agent is run as `root` (via systemd service `User=root`) or set read permissions:
    ```bash
    sudo chmod -R a+r /sys/class/powercap/intel-rapl/
    ```
- **Cause 2: Virtual Machine / Unsupported CPU**: Virtual machines and older hypervisors do not expose energy counters.
  - **Behavior**: The agent will automatically evaluate its internal TDP model lookup table (e.g. AMD APU2 GX-412TC or RX-421BD) or return `null`.

---

### Symptom: NVIDIA GPU metrics do not show up
- **Cause 1: Missing NVIDIA drivers or CLI**: `nvidia-smi` is not installed or not present in the system `$PATH`.
  - **Verification**: Run `nvidia-smi` in your terminal to confirm standard output.
- **Cause 2: Non-NVIDIA GPU**: The dashboard's dedicated GPU monitor parses NVIDIA SMI. Integrated Intel / AMD Radeon iGPUs report thermal and power metrics under the CPU metrics panel instead.

---

### Symptom: Windows Agent pops up console windows / Steals focus from games
- **Cause**: The agent is launched using `python.exe` instead of `pythonw.exe`, or child subprocesses are not using `CREATE_NO_WINDOW`.
- **Resolution**:
  1. In Task Scheduler, configure the executable to point to `pythonw.exe` (found inside your virtual environment `\.venv\Scripts\pythonw.exe`).
  2. The agent script natively uses `creationflags = 0x08000000` on Windows subprocess calls, ensuring zero focus interruption.

---

## 4. Audio & Browser Notifications

### Symptom: Alarm chime does not sound when thresholds trip
- **Cause: Browser Autoplay Policy**: Modern web browsers (Chrome, Firefox, Safari, Edge) block the Web Audio API from outputting audio until the user interacts with the webpage (clicks anywhere on the document).
- **Resolution**: The frontend includes `unlockAudioOnInteraction()` which unlocks audio on the first click. Simply click anywhere inside the dashboard after loading the page.
