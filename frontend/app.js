// Local state of devices
const devices = {};

// SSE Connection
let eventSource = null;

// Pinned / Favorites devices (persisted in localStorage)
let pinnedDevices = JSON.parse(localStorage.getItem('pinnedDevices') || '[]');

function togglePin(hostname) {
    if (pinnedDevices.includes(hostname)) {
        pinnedDevices = pinnedDevices.filter(name => name !== hostname);
    } else {
        pinnedDevices.push(hostname);
    }
    localStorage.setItem('pinnedDevices', JSON.stringify(pinnedDevices));
    
    // Re-sort and re-render dashboard cards
    renderDashboard();
}
// Expose togglePin globally so HTML onclick can call it
window.togglePin = togglePin;

// Audio Context for alerts
let audioCtx = null;
let lastAlertPlayTime = 0;

// DOM Elements
const dashboardGrid = document.getElementById('dashboard-grid');
const noDevicesEl = document.getElementById('no-devices');
const totalNodesEl = document.getElementById('total-nodes');
const activeNodesEl = document.getElementById('active-nodes');
const toastContainer = document.getElementById('toast-container');

// Thresholds for Critical Alerts
const CPU_ALERT_THRESHOLD = 85.0;     // %
const TEMP_ALERT_THRESHOLD = 80.0;    // °C
const GPU_UTIL_ALERT_THRESHOLD = 85.0; // %
const GPU_TEMP_ALERT_THRESHOLD = 80.0; // °C

// Connect to Server-Sent Events stream
function connectSSE() {
    const streamUrl = `${window.location.origin}/api/stream`;
    console.log(`Connecting to SSE stream at: ${streamUrl}`);
    
    eventSource = new EventSource(streamUrl);
    
    eventSource.addEventListener('init', (event) => {
        try {
            const data = JSON.parse(event.data);
            console.log('Received initial state:', data);
            
            // Clear existing state
            for (const key in devices) delete devices[key];
            
            data.forEach(device => {
                device.cpuHistory = [device.cpu_usage];
                if (device.gpu) {
                    device.gpuHistory = [device.gpu.utilization];
                }
                devices[device.hostname] = device;
            });
            
            renderDashboard();
        } catch (err) {
            console.error('Failed to parse init event:', err);
        }
    });
    
    eventSource.addEventListener('metrics', (event) => {
        try {
            const device = JSON.parse(event.data);
            
            // Maintain history for graphs
            if (devices[device.hostname]) {
                const oldHistory = devices[device.hostname].cpuHistory || [];
                device.cpuHistory = [...oldHistory, device.cpu_usage].slice(-30);
                
                if (device.gpu) {
                    const oldGpuHistory = devices[device.hostname].gpuHistory || [];
                    device.gpuHistory = [...oldGpuHistory, device.gpu.utilization].slice(-30);
                }
            } else {
                device.cpuHistory = [device.cpu_usage];
                if (device.gpu) {
                    device.gpuHistory = [device.gpu.utilization];
                }
            }
            
            devices[device.hostname] = device;
            renderDeviceCard(device);
            checkAlerts(device);
            updateSummary();
        } catch (err) {
            console.error('Failed to parse metrics event:', err);
        }
    });
    
    eventSource.onerror = (err) => {
        console.error('SSE connection error, attempting reconnect...', err);
        eventSource.close();
        setTimeout(connectSSE, 3000);
    };
}

// Synthesize a sci-fi alarm chime using the Web Audio API (zero audio files needed!)
function playAlertChime() {
    try {
        const nowTime = Date.now();
        // Throttle alert sounds to play at most once every 20 seconds
        if (nowTime - lastAlertPlayTime < 20000) return;
        lastAlertPlayTime = nowTime;

        if (!audioCtx) {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        
        if (audioCtx.state === 'suspended') {
            audioCtx.resume();
        }

        const osc1 = audioCtx.createOscillator();
        const osc2 = audioCtx.createOscillator();
        const gainNode = audioCtx.createGain();

        osc1.connect(gainNode);
        osc2.connect(gainNode);
        gainNode.connect(audioCtx.destination);

        // Tech chime profile
        osc1.type = 'sine';
        osc1.frequency.setValueAtTime(880, audioCtx.currentTime); // A5 note
        osc1.frequency.exponentialRampToValueAtTime(587.33, audioCtx.currentTime + 0.15); // D5 note
        osc1.frequency.exponentialRampToValueAtTime(440, audioCtx.currentTime + 0.4); // A4 note

        osc2.type = 'triangle';
        osc2.frequency.setValueAtTime(440, audioCtx.currentTime);
        osc2.frequency.setValueAtTime(220, audioCtx.currentTime + 0.15);

        gainNode.gain.setValueAtTime(0.0, audioCtx.currentTime);
        gainNode.gain.linearRampToValueAtTime(0.12, audioCtx.currentTime + 0.05); // Fade in
        gainNode.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.65); // Exp decay

        osc1.start(audioCtx.currentTime);
        osc2.start(audioCtx.currentTime);
        osc1.stop(audioCtx.currentTime + 0.7);
        osc2.stop(audioCtx.currentTime + 0.7);
    } catch (e) {
        console.warn("Failed to play Web Audio chime (waiting for user interaction):", e);
    }
}

// Display alert notifications
function triggerToast(message, type = 'error') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    
    const icon = type === 'success' ? 'fa-circle-check' : 'fa-triangle-exclamation';
    
    toast.innerHTML = `
        <i class="fa-solid ${icon}"></i>
        <span>${message}</span>
    `;
    toastContainer.appendChild(toast);
    
    // Trigger slide-in animation
    setTimeout(() => toast.classList.add('show'), 100);
    
    // Dismiss toast after 5 seconds
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 400);
    }, 5000);
}

// Check device metrics against threshold limits (using hysteresis to avoid flappiness)
function checkAlerts(device) {
    if (!device.alerts) {
        device.alerts = {
            cpu: false,
            temp: false,
            gpuUtil: false,
            gpuTemp: false
        };
    }
    
    const alertMsgs = [];
    const recoveryMsgs = [];
    
    // CPU thresholds: Trigger 85%, Recover 75%
    if (!device.alerts.cpu && device.cpu_usage > 85.0) {
        device.alerts.cpu = true;
        alertMsgs.push(`CPU Load critical: ${device.cpu_usage.toFixed(0)}%`);
    } else if (device.alerts.cpu && device.cpu_usage < 75.0) {
        device.alerts.cpu = false;
        recoveryMsgs.push(`CPU Load recovered: ${device.cpu_usage.toFixed(0)}%`);
    }
    
    // CPU Temp thresholds: Trigger 80°C, Recover 72°C
    if (device.temp !== undefined && device.temp !== null) {
        if (!device.alerts.temp && device.temp > 80.0) {
            device.alerts.temp = true;
            alertMsgs.push(`CPU Temperature hot: ${device.temp.toFixed(1)}°C`);
        } else if (device.alerts.temp && device.temp < 72.0) {
            device.alerts.temp = false;
            recoveryMsgs.push(`CPU Temperature recovered: ${device.temp.toFixed(1)}°C`);
        }
    }
    
    // GPU thresholds: Trigger 85% utilization / 80°C temp, Recover 75% utilization / 72°C temp
    if (device.gpu) {
        if (!device.alerts.gpuUtil && device.gpu.utilization > 85.0) {
            device.alerts.gpuUtil = true;
            alertMsgs.push(`GPU Load critical: ${device.gpu.utilization.toFixed(0)}%`);
        } else if (device.alerts.gpuUtil && device.gpu.utilization < 75.0) {
            device.alerts.gpuUtil = false;
            recoveryMsgs.push(`GPU Load recovered: ${device.gpu.utilization.toFixed(0)}%`);
        }
        
        if (!device.alerts.gpuTemp && device.gpu.temp > 80.0) {
            device.alerts.gpuTemp = true;
            alertMsgs.push(`GPU Temperature hot: ${device.gpu.temp.toFixed(0)}°C`);
        } else if (device.alerts.gpuTemp && device.gpu.temp < 72.0) {
            device.alerts.gpuTemp = false;
            recoveryMsgs.push(`GPU Temperature recovered: ${device.gpu.temp.toFixed(0)}°C`);
        }
    } else {
        device.alerts.gpuUtil = false;
        device.alerts.gpuTemp = false;
    }
    
    const cardId = `device-${device.hostname.replace(/[^a-zA-Z0-9]/g, '-')}`;
    const card = document.getElementById(cardId);
    if (!card) return;
    
    const hasAlert = Object.values(device.alerts).some(v => v === true);
    
    if (hasAlert) {
        card.classList.add('critical-alert');
    } else {
        card.classList.remove('critical-alert');
    }
    
    // Show alerts and play sound if new alerts triggered
    if (alertMsgs.length > 0) {
        playAlertChime();
        alertMsgs.forEach(msg => triggerToast(`[${device.hostname}] ${msg}`, 'error'));
    }
    
    // Show recovery messages quietly in green
    if (recoveryMsgs.length > 0) {
        recoveryMsgs.forEach(msg => triggerToast(`[${device.hostname}] ${msg}`, 'success'));
    }
}

// Render dynamic HTML5 canvas sparklines (neon glowing telemetry)
function drawSparkline(canvas, history, color) {
    if (!canvas || !history || history.length < 2) return;
    
    // Set internal size to match CSS size
    canvas.width = canvas.clientWidth;
    canvas.height = canvas.clientHeight;
    
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    
    ctx.beginPath();
    ctx.strokeStyle = color || '#00f2fe';
    ctx.lineWidth = 1.8;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    
    // Neon shadow glow
    ctx.shadowColor = color || '#00f2fe';
    ctx.shadowBlur = 5;
    
    const maxPoints = 30;
    const xStep = w / (maxPoints - 1);
    const offset = maxPoints - history.length;
    
    history.forEach((val, idx) => {
        const x = (idx + offset) * xStep;
        // Invert Y axis, leave 2px padding top and bottom
        const y = h - (val / 100 * (h - 4)) - 2;
        if (idx === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    });
    ctx.stroke();
    
    // Remove shadow blur for filling area underneath
    ctx.shadowBlur = 0;
    
    // Close the shape to fill the area under the sparkline
    ctx.lineTo((history.length - 1 + offset) * xStep, h);
    ctx.lineTo(offset * xStep, h);
    ctx.closePath();
    
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    // Convert hex color to rgba for smooth alpha gradient
    const fillCol = color === '#f43f5e' ? 'rgba(244, 63, 94, 0.12)' : 'rgba(0, 242, 254, 0.12)';
    grad.addColorStop(0, fillCol);
    grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = grad;
    ctx.fill();
}

// Map hostnames to FontAwesome icons
function getDeviceIcon(hostname) {
    const name = hostname.toLowerCase();
    if (name.includes('gaming') || name.includes('pc') || name.includes('desktop')) {
        return 'fa-solid fa-desktop';
    }
    if (name.includes('nas') || name.includes('storage') || name.includes('vault')) {
        return 'fa-solid fa-database';
    }
    if (name.includes('router') || name.includes('switch') || name.includes('network') || name.includes('hub')) {
        return 'fa-solid fa-network-wired';
    }
    return 'fa-solid fa-server';
}

// Format bytes to human readable format (MB/GB)
function formatBytes(bytes, decimals = 1) {
    if (bytes === undefined || bytes === null || bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// Format network speed (Bytes/s to MB/s, KB/s, etc.)
function formatSpeed(bytesPerSec) {
    if (bytesPerSec === undefined || bytesPerSec === null || bytesPerSec < 0) return '0 B/s';
    if (bytesPerSec >= 1024 * 1024) {
        return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
    }
    if (bytesPerSec >= 1024) {
        return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
    }
    return `${bytesPerSec.toFixed(0)} B/s`;
}

// Update the summary counter in header
function updateSummary() {
    const allDevices = Object.values(devices);
    const total = allDevices.length;
    
    const now = Date.now() / 1000;
    const activeDevices = allDevices.filter(d => (now - d.last_seen) < 15);
    const active = activeDevices.length;
    
    totalNodesEl.textContent = total;
    activeNodesEl.textContent = active;
    
    // Sum active device powers (CPU + GPU draw)
    let sumPower = 0;
    activeDevices.forEach(d => {
        const cpuP = d.cpu_power || 0;
        const gpuP = (d.gpu && d.gpu.power) ? d.gpu.power : 0;
        sumPower += (cpuP + gpuP);
    });
    
    const totalPowerEl = document.getElementById('total-power');
    const totalPowerContainer = document.getElementById('total-power-container');
    if (totalPowerEl) {
        totalPowerEl.textContent = `${sumPower.toFixed(0)}W`;
    }
    if (totalPowerContainer) {
        totalPowerContainer.title = `Estimated monthly cost: $${(sumPower * 0.2088).toFixed(2)} at $0.29/kWh`;
    }
}

// Render the entire dashboard grid
function renderDashboard() {
    const allDevices = Object.values(devices);
    
    if (allDevices.length === 0) {
        noDevicesEl.style.display = 'flex';
        const cards = dashboardGrid.querySelectorAll('.device-card');
        cards.forEach(card => card.remove());
        updateSummary();
        return;
    }
    
    // Sort: Pinned first, then alphabetically by hostname
    allDevices.sort((a, b) => {
        const aPinned = pinnedDevices.includes(a.hostname);
        const bPinned = pinnedDevices.includes(b.hostname);
        if (aPinned && !bPinned) return -1;
        if (!aPinned && bPinned) return 1;
        return a.hostname.localeCompare(b.hostname);
    });
    
    noDevicesEl.style.display = 'none';
    allDevices.forEach(device => {
        renderDeviceCard(device);
        
        // Append child moves it to the end of parent in sorted order
        const cardId = `device-${device.hostname.replace(/[^a-zA-Z0-9]/g, '-')}`;
        const card = document.getElementById(cardId);
        if (card) {
            dashboardGrid.appendChild(card);
        }
    });
    
    // Remove stale nodes
    const activeCardIds = new Set(allDevices.map(d => `device-${d.hostname.replace(/[^a-zA-Z0-9]/g, '-')}`));
    dashboardGrid.querySelectorAll('.device-card').forEach(card => {
        if (!activeCardIds.has(card.id)) {
            card.remove();
        }
    });
    
    updateSummary();
}

// Create or update a single device card in the DOM
function renderDeviceCard(device) {
    const cardId = `device-${device.hostname.replace(/[^a-zA-Z0-9]/g, '-')}`;
    let card = document.getElementById(cardId);
    
    if (!card) {
        card = document.createElement('div');
        card.id = cardId;
        card.className = 'device-card';
        dashboardGrid.appendChild(card);
    }
    
    const now = Date.now() / 1000;
    const isOnline = (now - device.last_seen) < 15;
    const isPinned = pinnedDevices.includes(device.hostname);
    card.className = `device-card ${isOnline ? 'online' : 'offline'} ${isPinned ? 'pinned' : ''}`;
    
    // CPU Temp rendering
    let tempHtml = '';
    if (device.temp !== undefined && device.temp !== null) {
        const tempVal = parseFloat(device.temp);
        let tempClass = 'success';
        if (tempVal > 75) tempClass = 'danger';
        else if (tempVal > 60) tempClass = 'warning';
        
        tempHtml = `
            <div class="meta-box ${tempClass}">
                <i class="fa-solid fa-thermometer"></i>
                <div class="meta-box-text">
                    <span class="lbl">CPU Temp</span>
                    <span class="val">${tempVal.toFixed(1)}°C</span>
                </div>
            </div>
        `;
    } else {
        tempHtml = `
            <div class="meta-box">
                <i class="fa-solid fa-thermometer"></i>
                <div class="meta-box-text">
                    <span class="lbl">CPU Temp</span>
                    <span class="val">--</span>
                </div>
            </div>
        `;
    }
    
    // Docker Containers rendering
    let dockerHtml = '';
    if (device.docker_containers && device.docker_containers.length > 0) {
        const itemsHtml = device.docker_containers.map(c => `
            <div class="docker-item ${c.state.toLowerCase()}">
                <div class="docker-item-left">
                    <i class="fa-brands fa-docker"></i>
                    <span>${c.name}</span>
                </div>
                <span class="docker-status">${c.state}</span>
            </div>
        `).join('');
        
        dockerHtml = `
            <div class="docker-container">
                <div class="section-title">
                    <i class="fa-brands fa-docker"></i>
                    <span>Docker Containers (${device.docker_containers.length})</span>
                </div>
                <div class="docker-list">
                    ${itemsHtml}
                </div>
            </div>
        `;
    }
    
    // VPN Badges rendering
    let vpnHtml = '';
    if (device.vpns) {
        const tailscaleActive = device.vpns.tailscale === true;
        const openvpnActive = device.vpns.openvpn === true;
        
        vpnHtml = `
            <div class="vpn-container">
                <div class="section-title">
                    <i class="fa-solid fa-shield-halved"></i>
                    <span>VPN Connections</span>
                </div>
                <div class="vpn-badge-list">
                    <div class="vpn-badge ${tailscaleActive ? 'active tailscale' : ''}">
                        <i class="fa-solid fa-circle-nodes"></i>
                        <span>Tailscale</span>
                    </div>
                    <div class="vpn-badge ${openvpnActive ? 'active' : ''}">
                        <i class="fa-solid fa-lock"></i>
                        <span>OpenVPN</span>
                    </div>
                </div>
            </div>
        `;
    }
    
    // GPU Widget rendering (RTX/Nvidia details)
    let gpuHtml = '';
    if (device.gpu) {
        const gpu = device.gpu;
        const gpuVramPct = gpu.mem_total ? ((gpu.mem_used / gpu.mem_total) * 100).toFixed(0) : 0;
        
        let gpuTempClass = 'success';
        if (gpu.temp > 80) gpuTempClass = 'danger';
        else if (gpu.temp > 68) gpuTempClass = 'warning';
        
        gpuHtml = `
            <div class="gpu-container">
                <div class="gpu-header">
                    <div class="gpu-title">
                        <i class="fa-solid fa-microchip"></i>
                        <span>GPU Stats</span>
                    </div>
                    <span class="gpu-model-name">${gpu.name}</span>
                </div>
                
                <div class="gpu-grid">
                    <!-- GPU load -->
                    <div class="stat-row gpu-util">
                        <div class="stat-label-container">
                            <span class="stat-label"><i class="fa-solid fa-chart-line"></i> GPU Load</span>
                            <span class="stat-value">${gpu.utilization.toFixed(0)}%</span>
                        </div>
                        <div class="progress-bar-bg">
                            <div class="progress-bar-fill" style="width: ${gpu.utilization}%"></div>
                        </div>
                        <div class="sparkline-container">
                            <canvas class="sparkline-canvas" id="canvas-gpu-${device.hostname.replace(/[^a-zA-Z0-9]/g, '-')}" height="38"></canvas>
                        </div>
                    </div>
                    
                    <!-- VRAM load -->
                    <div class="stat-row gpu-vram">
                        <div class="stat-label-container">
                            <span class="stat-label"><i class="fa-solid fa-memory"></i> VRAM</span>
                            <span class="stat-value">${gpuVramPct}%</span>
                        </div>
                        <div class="progress-bar-bg">
                            <div class="progress-bar-fill" style="width: ${gpuVramPct}%"></div>
                        </div>
                        <span style="font-size: 0.72rem; color: var(--text-muted); text-align: right; display: block; margin-top: -0.2rem;">
                            ${formatBytes(gpu.mem_used)} / ${formatBytes(gpu.mem_total)}
                        </span>
                    </div>
                    
                    <!-- GPU temperature -->
                    <div class="meta-box ${gpuTempClass}" style="margin-top: 0.2rem;">
                        <i class="fa-solid fa-temperature-three-quarters"></i>
                        <div class="meta-box-text">
                            <span class="lbl">GPU Temp</span>
                            <span class="val">${gpu.temp.toFixed(0)}°C</span>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }
    
    // Multi-Disk storage list and speeds
    let diskSpeedHtml = '';
    if (device.disk_speeds) {
        diskSpeedHtml = `
            <span class="section-speed-meta" style="font-size: 0.72rem; color: var(--text-secondary); display: flex; align-items: center; gap: 0.25rem;">
                <i class="fa-solid fa-arrow-down" style="color: var(--accent-teal);"></i> R: ${formatSpeed(device.disk_speeds.read_speed)}
                <i class="fa-solid fa-arrow-up" style="color: var(--accent-purple); margin-left: 0.4rem;"></i> W: ${formatSpeed(device.disk_speeds.write_speed)}
            </span>
        `;
    }

    let disksHtml = '';
    if (device.disks && device.disks.length > 0) {
        const diskItems = device.disks.map(disk => `
            <div class="stat-row disk-item">
                <div class="stat-label-container">
                    <span class="stat-label">
                        <i class="fa-solid fa-hard-drive"></i>
                        <strong>${disk.mount}</strong> (${disk.device})
                    </span>
                    <span class="stat-value">${disk.percent.toFixed(0)}%</span>
                </div>
                <div class="progress-bar-bg">
                    <div class="progress-bar-fill" style="width: ${disk.percent}%"></div>
                </div>
                <span style="font-size: 0.72rem; color: var(--text-muted); text-align: right; display: block; margin-top: -0.2rem;">
                    ${formatBytes(disk.used)} used / ${formatBytes(disk.total)} total
                </span>
            </div>
        `).join('');
        
        disksHtml = `
            <div class="disks-list">
                <div class="section-title-container" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.4rem;">
                    <span class="section-title" style="padding-top: 0; margin-bottom: 0;">
                        <i class="fa-solid fa-hdd"></i> Storage Devices
                    </span>
                    ${diskSpeedHtml}
                </div>
                ${diskItems}
            </div>
        `;
    } else if (device.disk) {
        const diskPct = ((device.disk.used / device.disk.total) * 100).toFixed(0);
        disksHtml = `
            <div class="disks-list">
                <div class="section-title-container" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.4rem;">
                    <span class="section-title" style="padding-top: 0; margin-bottom: 0;">
                        <i class="fa-solid fa-hdd"></i> Storage Devices
                    </span>
                    ${diskSpeedHtml}
                </div>
                <div class="stat-row disk-item">
                    <div class="stat-label-container">
                        <span class="stat-label"><i class="fa-solid fa-hard-drive"></i> Disk</span>
                        <span class="stat-value">${diskPct}%</span>
                    </div>
                    <div class="progress-bar-bg">
                        <div class="progress-bar-fill" style="width: ${diskPct}%"></div>
                    </div>
                    <span style="font-size: 0.72rem; color: var(--text-muted); text-align: right; display: block; margin-top: -0.2rem;">
                        ${formatBytes(device.disk.used)} / ${formatBytes(device.disk.total)}
                    </span>
                </div>
            </div>
        `;
    }
    
    // Memory calculation
    const ramPct = device.memory ? ((device.memory.used / device.memory.total) * 100).toFixed(0) : 0;
    const ramText = device.memory ? `${formatBytes(device.memory.used)} / ${formatBytes(device.memory.total)}` : 'N/A';
    const cpuVal = device.cpu_usage !== undefined ? device.cpu_usage.toFixed(0) : 0;
    
    // Core count metadata string
    let cpuCoresText = '';
    if (device.cpu_cores) {
        cpuCoresText = ` &bull; ${device.cpu_cores.physical}P/${device.cpu_cores.logical}L Cores`;
    }
    
    // Build Power Draw metadata
    let powerHtml = '';
    const cpuPower = device.cpu_power || 0;
    const gpuPower = (device.gpu && device.gpu.power) ? device.gpu.power : 0;
    const totalPower = cpuPower + gpuPower;
    
    if (totalPower > 0) {
        powerHtml = `
            <div class="meta-box success" title="Estimated monthly cost: $${(totalPower * 0.2088).toFixed(2)} at $0.29/kWh">
                <i class="fa-solid fa-bolt" style="color: #fbbf24; text-shadow: 0 0 8px rgba(251, 191, 36, 0.4);"></i>
                <div class="meta-box-text">
                    <span class="lbl">Power Draw</span>
                    <span class="val">${totalPower.toFixed(0)}W</span>
                </div>
            </div>
        `;
    }

    // Network speeds box
    let netHtml = '';
    if (device.network) {
        netHtml = `
            <div class="net-speed-container">
                <div class="net-speed-item down">
                    <i class="fa-solid fa-arrow-down"></i>
                    <span>Download</span>
                    <span class="val">${formatSpeed(device.network.down_speed)}</span>
                </div>
                <div class="net-speed-item up">
                    <i class="fa-solid fa-arrow-up"></i>
                    <span>Upload</span>
                    <span class="val">${formatSpeed(device.network.up_speed)}</span>
                </div>
            </div>
        `;
    }
    
    // Build metadata subtitle
    const osInfo = device.os_info || 'Unknown OS';
    const cpuModel = device.cpu_model || 'Unknown CPU';
    
    // Build latency indicator
    let latencyText = '';
    if (device.latency !== undefined && device.latency !== null) {
        let latColor = 'var(--accent-teal)';
        if (device.latency > 150) latColor = 'var(--danger)';
        else if (device.latency > 60) latColor = 'var(--warning)';
        
        latencyText = ` &bull; <span class="latency-val" style="color: ${latColor}; font-weight: 550;"><i class="fa-solid fa-signal" style="font-size: 0.75rem; margin-right: 0.15rem;"></i>${device.latency.toFixed(0)}ms</span>`;
    }
    
    card.innerHTML = `
        <div class="device-card-header">
            <div class="device-title-wrapper">
                <div class="device-icon-box">
                    <i class="${getDeviceIcon(device.hostname)}"></i>
                </div>
                <div class="device-info">
                    <h3>${device.hostname}</h3>
                    <span class="ip-addr">${device.ip || 'Unknown IP'}${latencyText}</span>
                </div>
            </div>
            <div class="header-right-controls">
                <div class="status-badge">
                    <span class="dot"></span>
                    <span>${isOnline ? 'Online' : 'Offline'}</span>
                </div>
                <button class="pin-btn" onclick="togglePin('${device.hostname.replace(/'/g, "\\'")}')" title="Pin to top">
                    <i class="${isPinned ? 'fa-solid' : 'fa-regular'} fa-star"></i>
                </button>
            </div>
        </div>

        <div class="device-meta-subtitle">
            <div class="meta-line">
                <span class="os-details"><i class="fa-solid fa-gears"></i> ${osInfo}</span>
            </div>
            <div class="meta-line" style="color: var(--text-muted); font-size: 0.72rem; margin-top: 0.1rem;">
                <span><i class="fa-solid fa-microchip"></i> ${cpuModel}${cpuCoresText}</span>
            </div>
        </div>

        <div class="device-stats">
            <!-- CPU usage -->
            <div class="stat-row cpu">
                <div class="stat-label-container">
                    <span class="stat-label"><i class="fa-solid fa-microchip"></i> CPU Usage</span>
                    <span class="stat-value">${cpuVal}%</span>
                </div>
                <div class="progress-bar-bg">
                    <div class="progress-bar-fill" style="width: ${cpuVal}%"></div>
                </div>
                <!-- Sparkline Canvas for CPU -->
                <div class="sparkline-container">
                    <canvas class="sparkline-canvas" id="canvas-cpu-${device.hostname.replace(/[^a-zA-Z0-9]/g, '-')}" height="38"></canvas>
                </div>
            </div>

            <!-- RAM usage -->
            <div class="stat-row ram">
                <div class="stat-label-container">
                    <span class="stat-label"><i class="fa-solid fa-memory"></i> RAM</span>
                    <span class="stat-value">${ramPct}%</span>
                </div>
                <div class="progress-bar-bg">
                    <div class="progress-bar-fill" style="width: ${ramPct}%"></div>
                </div>
                <span style="font-size: 0.72rem; color: var(--text-muted); text-align: right; display: block; margin-top: -0.2rem;">
                    ${ramText}
                </span>
            </div>

            <!-- Multi disks storage list -->
            ${disksHtml}

            <!-- Extra stats (Temp, uptime, power) -->
            <div class="stat-meta-grid">
                ${tempHtml}
                <div class="meta-box">
                    <i class="fa-solid fa-clock"></i>
                    <div class="meta-box-text">
                        <span class="lbl">Uptime</span>
                        <span class="val">${device.uptime ? formatUptime(device.uptime) : '--'}</span>
                    </div>
                </div>
                ${powerHtml}
                
                <!-- Live network speeds -->
                ${netHtml}
            </div>
        </div>

        ${gpuHtml}
        ${vpnHtml}
        ${dockerHtml}
    `;
    
    // Draw sparklines after DOM content update has finished
    requestAnimationFrame(() => {
        const cpuCanvas = document.getElementById(`canvas-cpu-${device.hostname.replace(/[^a-zA-Z0-9]/g, '-')}`);
        if (cpuCanvas && device.cpuHistory) {
            // Draw CPU sparkline in cyan
            drawSparkline(cpuCanvas, device.cpuHistory, '#00f2fe');
        }
        
        if (device.gpu) {
            const gpuCanvas = document.getElementById(`canvas-gpu-${device.hostname.replace(/[^a-zA-Z0-9]/g, '-')}`);
            if (gpuCanvas && device.gpuHistory) {
                // Draw GPU sparkline in pink
                drawSparkline(gpuCanvas, device.gpuHistory, '#f43f5e');
            }
        }
    });
}

// Format uptime in seconds to human readable format
function formatUptime(seconds) {
    if (!seconds) return '--';
    const d = Math.floor(seconds / (3600 * 24));
    const h = Math.floor((seconds % (3600 * 24)) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
}

// Periodically check for stale offline devices (every 5 seconds)
setInterval(() => {
    const allDevices = Object.values(devices);
    if (allDevices.length === 0) return;
    
    let stateChanged = false;
    const now = Date.now() / 1000;
    
    allDevices.forEach(device => {
        const cardId = `device-${device.hostname.replace(/[^a-zA-Z0-9]/g, '-')}`;
        const card = document.getElementById(cardId);
        if (card) {
            const isOnline = (now - device.last_seen) < 15;
            const wasOnline = card.classList.contains('online');
            
            if (isOnline !== wasOnline) {
                card.className = `device-card ${isOnline ? 'online' : 'offline'}`;
                const dot = card.querySelector('.status-badge .dot');
                const text = card.querySelector('.status-badge span:last-child');
                
                if (text) text.textContent = isOnline ? 'Online' : 'Offline';
                stateChanged = true;
            }
        }
    });
    
    if (stateChanged) {
        updateSummary();
    }
}, 5000);

window.addEventListener('DOMContentLoaded', connectSSE);
window.addEventListener('click', () => {
    // Resume audio context on user interaction if blocked by browser autoplay policy
    if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume();
    }
});
