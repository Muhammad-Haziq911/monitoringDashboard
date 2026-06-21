// Local state
const devices = {};
let services = [];
let isFirstRun = false;

// DOM Elements
const servicesGrid = document.getElementById('services-grid');
const noServicesEl = document.getElementById('no-services');
const totalNodesEl = document.getElementById('total-nodes');
const activeNodesEl = document.getElementById('active-nodes');

let eventSource = null;

// Authenticated fetch helper
async function fetchWithAuth(url, options = {}) {
    const token = localStorage.getItem('auth_token');
    if (token) {
        options.headers = {
            ...options.headers,
            'Authorization': `Bearer ${token}`
        };
    }
    const response = await fetch(url, options);
    if (response.status === 401) {
        handleLogout();
        throw new Error("Unauthorized");
    }
    return response;
}

// Check authentication status on load
async function checkAuth() {
    const token = localStorage.getItem('auth_token');
    const authOverlay = document.getElementById('auth-overlay');
    
    if (token) {
        authOverlay.style.display = 'none';
        
        // Show agent key if saved
        const savedAgentKey = localStorage.getItem('agent_auth_key');
        if (savedAgentKey) {
            displayAgentKey(savedAgentKey);
        } else {
            // Fetch key from backend
            try {
                const res = await fetchWithAuth(`${window.location.origin}/api/auth/agent-key`);
                if (res.ok) {
                    const data = await res.json();
                    if (data.agent_auth_key) {
                        localStorage.setItem('agent_auth_key', data.agent_auth_key);
                        displayAgentKey(data.agent_auth_key);
                    }
                }
            } catch (e) {
                console.error("Failed to load agent key:", e);
            }
        }
        
        // Setup logout button listener
        const logoutBtn = document.getElementById('logout-btn');
        if (logoutBtn) {
            logoutBtn.onclick = handleLogout;
        }
        
        return true;
    }
    
    // Show overlay and check user existence
    authOverlay.style.display = 'flex';
    try {
        const response = await fetch(`${window.location.origin}/api/auth/status`);
        if (response.ok) {
            const data = await response.json();
            isFirstRun = !data.users_exist;
            
            const titleEl = document.getElementById('auth-title');
            const subtitleEl = document.getElementById('auth-subtitle');
            const submitBtn = document.getElementById('auth-submit-btn');
            
            if (isFirstRun) {
                titleEl.textContent = 'Create Admin Account';
                subtitleEl.textContent = 'Create your administrator username and password to secure the dashboard.';
                submitBtn.innerHTML = '<span>Register & Login</span> <i class="fa-solid fa-user-plus"></i>';
            } else {
                titleEl.textContent = 'Dashboard Login';
                subtitleEl.textContent = 'Please enter your credentials to access the lab monitor.';
                submitBtn.innerHTML = '<span>Sign In</span> <i class="fa-solid fa-arrow-right-to-bracket"></i>';
            }
        }
    } catch (e) {
        console.error("Auth status check failed:", e);
    }
    
    // Bind form submit handler
    const authForm = document.getElementById('auth-form');
    if (authForm) {
        authForm.onsubmit = handleAuthSubmit;
    }
    
    return false;
}

// Display and setup agent key clipboard copying
function displayAgentKey(key) {
    const keyContainer = document.getElementById('agent-key-container');
    const keyValEl = document.getElementById('agent-key-val');
    if (keyContainer && keyValEl) {
        keyContainer.style.display = 'flex';
        keyValEl.textContent = key;
        keyContainer.onclick = () => {
            navigator.clipboard.writeText(key);
            keyValEl.textContent = 'Copied!';
            keyValEl.style.color = 'var(--success)';
            setTimeout(() => {
                keyValEl.textContent = key;
                keyValEl.style.color = 'var(--accent-teal)';
            }, 2000);
        };
    }
}

// Handle login or registration submission
async function handleAuthSubmit(e) {
    e.preventDefault();
    const usernameEl = document.getElementById('auth-username');
    const passwordEl = document.getElementById('auth-password');
    const errorMsgEl = document.getElementById('auth-error-msg');
    
    errorMsgEl.textContent = '';
    
    const payload = {
        username: usernameEl.value,
        password: passwordEl.value
    };
    
    const endpoint = isFirstRun ? '/api/auth/register' : '/api/auth/login';
    
    try {
        const response = await fetch(`${window.location.origin}${endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        
        if (response.ok) {
            const data = await response.json();
            localStorage.setItem('auth_token', data.token);
            if (data.agent_auth_key) {
                localStorage.setItem('agent_auth_key', data.agent_auth_key);
            }
            
            // Success: clear inputs, hide overlay and trigger SSE load
            usernameEl.value = '';
            passwordEl.value = '';
            document.getElementById('auth-overlay').style.display = 'none';
            
            if (data.agent_auth_key) {
                displayAgentKey(data.agent_auth_key);
            }
            
            // Connect to real-time stream
            loadServices();
            connectSSE();
        } else {
            const errData = await response.json();
            errorMsgEl.textContent = errData.detail || 'Authentication failed.';
        }
    } catch (err) {
        errorMsgEl.textContent = 'Server connection error.';
        console.error("Auth submission error:", err);
    }
}

// Log out and clear tokens
async function handleLogout() {
    const token = localStorage.getItem('auth_token');
    if (token) {
        try {
            await fetch(`${window.location.origin}/api/auth/logout`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token })
            });
        } catch (e) {
            console.error("Logout request failed:", e);
        }
    }
    localStorage.removeItem('auth_token');
    localStorage.removeItem('agent_auth_key');
    
    // Close SSE if active
    if (eventSource) {
        eventSource.close();
    }
    
    // Reload page to re-trigger login overlay check
    window.location.reload();
}

// Connect to Server-Sent Events stream
function connectSSE() {
    const token = localStorage.getItem('auth_token');
    if (!token) return;

    const streamUrl = `${window.location.origin}/api/stream?token=${token}`;
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
        console.error('SSE connection error, verifying auth...', err);
        eventSource.close();
        // Check if token has expired before reconnecting
        checkAuth().then(isAuth => {
            if (isAuth) {
                setTimeout(connectSSE, 3000);
            }
        });
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
        const res = await fetchWithAuth(`${window.location.origin}/api/services`);
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
    checkAuth().then(isAuth => {
        if (isAuth) {
            loadServices();
            connectSSE();
        }
    });
});
