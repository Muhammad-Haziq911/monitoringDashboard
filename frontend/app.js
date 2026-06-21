// Local state of devices
const devices = {};

// SSE Connection
let eventSource = null;

// DOM Elements
const dashboardGrid = document.getElementById('dashboard-grid');
const noDevicesEl = document.getElementById('no-devices');
const totalNodesEl = document.getElementById('total-nodes');
const activeNodesEl = document.getElementById('active-nodes');

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
            console.log('Received metrics update:', device);
            
            devices[device.hostname] = device;
            renderDeviceCard(device);
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

// Map hostnames to FontAwesome icons
function getDeviceIcon(hostname) {
    const name = hostname.toLowerCase();
    if (name.includes('gaming') || name.includes('pc') || name.includes('desktop')) {
        return 'fa-solid fa-desktop';
    }
    if (name.includes('nas') || name.includes('storage') || name.includes('vault')) {
        return 'fa-solid fa-database';
    }
    if (name.includes('apu') || name.includes('router') || name.includes('switch') || name.includes('engine')) {
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
    const active = allDevices.filter(d => (now - d.last_seen) < 15).length;
    
    totalNodesEl.textContent = total;
    activeNodesEl.textContent = active;
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
    
    noDevicesEl.style.display = 'none';
    allDevices.forEach(device => {
        renderDeviceCard(device);
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
    
    card.className = `device-card ${isOnline ? 'online' : 'offline'}`;
    
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
    
    // Multi-Disk storage list
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
                <span class="section-title" style="margin-bottom: 0.4rem; padding-top: 0;">
                    <i class="fa-solid fa-hdd"></i> Storage Devices
                </span>
                ${diskItems}
            </div>
        `;
    } else if (device.disk) {
        // Fallback for older agents only sending a single disk object
        const diskPct = ((device.disk.used / device.disk.total) * 100).toFixed(0);
        disksHtml = `
            <div class="disks-list">
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
    
    // Build metadata subtitle (OS & CPU details)
    const osInfo = device.os_info || 'Unknown OS';
    const cpuModel = device.cpu_model || 'Unknown CPU';
    
    card.innerHTML = `
        <div class="device-card-header">
            <div class="device-title-wrapper">
                <div class="device-icon-box">
                    <i class="${getDeviceIcon(device.hostname)}"></i>
                </div>
                <div class="device-info">
                    <h3>${device.hostname}</h3>
                    <span class="ip-addr">${device.ip || 'Unknown IP'}</span>
                </div>
            </div>
            <div class="status-badge">
                <span class="dot"></span>
                <span>${isOnline ? 'Online' : 'Offline'}</span>
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

            <!-- Extra stats (Temp, uptime) -->
            <div class="stat-meta-grid">
                ${tempHtml}
                <div class="meta-box">
                    <i class="fa-solid fa-clock"></i>
                    <div class="meta-box-text">
                        <span class="lbl">Uptime</span>
                        <span class="val">${device.uptime ? formatUptime(device.uptime) : '--'}</span>
                    </div>
                </div>
                
                <!-- Live network speeds -->
                ${netHtml}
            </div>
        </div>

        ${gpuHtml}
        ${vpnHtml}
        ${dockerHtml}
    `;
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
