// Local state
const devices = {};
let services = [];

// DOM Elements
const servicesGrid = document.getElementById('services-grid');
const noServicesEl = document.getElementById('no-services');
const totalNodesEl = document.getElementById('total-nodes');
const activeNodesEl = document.getElementById('active-nodes');

let eventSource = null;

// Connect to Server-Sent Events stream
function connectSSE() {
    const streamUrl = `${window.location.origin}/api/stream`;
    console.log(`Services Page: Connecting to SSE stream at: ${streamUrl}`);
    
    eventSource = new EventSource(streamUrl);
    
    // Devices Init (for Header stats)
    eventSource.addEventListener('init', (event) => {
        try {
            const data = JSON.parse(event.data);
            for (const key in devices) delete devices[key];
            data.forEach(device => {
                devices[device.hostname] = device;
            });
            updateSummary();
        } catch (err) {
            console.error('Failed to parse init event:', err);
        }
    });
    
    // Devices Metrics (for Header stats)
    eventSource.addEventListener('metrics', (event) => {
        try {
            const device = JSON.parse(event.data);
            devices[device.hostname] = device;
            updateSummary();
        } catch (err) {
            console.error('Failed to parse metrics event:', err);
        }
    });

    // Services Init
    eventSource.addEventListener('services_init', (event) => {
        try {
            const data = JSON.parse(event.data);
            console.log('Received initial services state:', data);
            services = data;
            renderServices();
        } catch (err) {
            console.error('Failed to parse services_init event:', err);
        }
    });

    // Services Updates
    eventSource.addEventListener('services', (event) => {
        try {
            const data = JSON.parse(event.data);
            services = data;
            renderServices();
        } catch (err) {
            console.error('Failed to parse services event:', err);
        }
    });
    
    eventSource.onerror = (err) => {
        console.error('SSE connection error, attempting reconnect...', err);
        eventSource.close();
        setTimeout(connectSSE, 3000);
    };
}

// Update the summary counter in header
function updateSummary() {
    const allDevices = Object.values(devices);
    const total = allDevices.length;
    
    const now = Date.now() / 1000;
    const activeDevices = allDevices.filter(d => (now - d.last_seen) < 15);
    const active = activeDevices.length;
    
    if (totalNodesEl) totalNodesEl.textContent = total;
    if (activeNodesEl) activeNodesEl.textContent = active;
    
    // Sum active device powers (CPU + GPU draw)
    let sumPower = 0;
    activeDevices.forEach(d => {
        const cpuP = d.cpu_power || 0;
        const gpuP = (d.gpu && d.gpu.power) ? d.gpu.power : 0;
        sumPower += (cpuP + gpuP);
    });
    
    const totalPowerEl = document.getElementById('total-power');
    const totalPowerContainer = document.getElementById('total-power-container');
    const totalCostEl = document.getElementById('total-cost');
    
    if (totalPowerEl) {
        totalPowerEl.textContent = `${sumPower.toFixed(0)}W`;
    }
    if (totalPowerContainer) {
        totalPowerContainer.title = `Estimated monthly cost: $${(sumPower * 0.2088).toFixed(2)} at $0.29/kWh`;
    }
    if (totalCostEl) {
        totalCostEl.textContent = `$${(sumPower * 0.2088).toFixed(2)}/mo`;
    }
}

// Fetch initial services list from api
async function loadServices() {
    try {
        const res = await fetch(`${window.location.origin}/api/services`);
        if (res.ok) {
            services = await res.json();
            renderServices();
        }
    } catch (err) {
        console.error('Failed to load initial services:', err);
    }
}

// Render services cards in the grid
function renderServices() {
    if (services.length === 0) {
        if (noServicesEl) noServicesEl.style.display = 'flex';
        return;
    }
    
    if (noServicesEl) noServicesEl.style.display = 'none';
    
    // Clear and build cards
    const existingCards = servicesGrid.querySelectorAll('.service-card');
    
    services.forEach(srv => {
        const cardId = `service-${srv.name.replace(/[^a-zA-Z0-9]/g, '-')}`;
        let card = document.getElementById(cardId);
        
        const latencyText = srv.online ? `${srv.latency}ms` : 'Offline';
        const cardClass = srv.online ? 'service-card online' : 'service-card offline';
        
        const cardHtml = `
            <div class="service-icon-wrapper">
                <i class="fa-solid ${srv.icon || 'fa-globe'}"></i>
            </div>
            <div class="service-info">
                <div style="display: flex; justify-content: space-between; align-items: baseline;">
                    <span class="service-name">${srv.name}</span>
                    <span class="service-category">${srv.category || 'General'}</span>
                </div>
                <div class="service-status-row">
                    <span class="service-status-dot"></span>
                    <span class="service-latency">${latencyText}</span>
                </div>
            </div>
        `;
        
        if (card) {
            // Update existing card classes & content if changed to prevent rebuilding nodes
            if (card.className !== cardClass) {
                card.className = cardClass;
            }
            card.innerHTML = cardHtml;
        } else {
            // Create new card
            const newCard = document.createElement('div');
            newCard.id = cardId;
            newCard.className = cardClass;
            newCard.innerHTML = cardHtml;
            servicesGrid.appendChild(newCard);
        }
    });
    
    // Remove any stale cards that aren't in config anymore
    const activeNames = services.map(s => `service-${s.name.replace(/[^a-zA-Z0-9]/g, '-')}`);
    existingCards.forEach(card => {
        if (!activeNames.includes(card.id)) {
            card.remove();
        }
    });
}

// Initialize
window.addEventListener('DOMContentLoaded', () => {
    loadServices();
    connectSSE();
});
