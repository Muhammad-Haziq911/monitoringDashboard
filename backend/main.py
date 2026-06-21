import asyncio
import json
import os
import platform
import re
import time
import urllib.error
import urllib.request
from typing import Dict, List
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles

app = FastAPI(title="Home Lab Dashboard API")

# Enable CORS for development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-memory store for device metrics
# Key: hostname, Value: device metrics dict
devices: Dict[str, dict] = {}

# In-memory store for historical power draw (Last 6 hours)
power_history: List[dict] = []
MAX_POWER_HISTORY = 360  # 6 hours of 1-minute intervals

# Services monitoring list
services_list: List[dict] = []

def load_services_config():
    """Load services to monitor from services.json."""
    global services_list
    config_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "services.json")
    if os.path.exists(config_path):
        try:
            with open(config_path, "r") as f:
                services_list = json.load(f)
                # Initialize status keys
                for s in services_list:
                    s["online"] = False
                    s["latency"] = 0.0
        except Exception as e:
            print(f"Error reading services.json: {e}")

def get_sanitized_services() -> List[dict]:
    """Return services list with URLs stripped out for security."""
    return [
        {
            "name": s["name"],
            "icon": s["icon"],
            "category": s.get("category", "General"),
            "online": s.get("online", False),
            "latency": s.get("latency", 0.0)
        }
        for s in services_list
    ]

async def ping_service(service: dict):
    """Check if an HTTP service is online internally (APU backend side) and record response time."""
    url = service.get("url")
    if not url:
        return
    
    start_time = time.time()
    try:
        def run():
            req = urllib.request.Request(url, headers={"User-Agent": "HomeLab-Dashboard-Monitor"})
            with urllib.request.urlopen(req, timeout=2.0) as response:
                response.read(1)
                return True
        await asyncio.to_thread(run)
        latency = (time.time() - start_time) * 1000.0
        service["online"] = True
        service["latency"] = round(latency, 1)
    except urllib.error.HTTPError as e:
        latency = (time.time() - start_time) * 1000.0
        service["online"] = True
        service["latency"] = round(latency, 1)
    except Exception:
        service["online"] = False
        service["latency"] = 0.0

# Active SSE listener queues
listeners: List[asyncio.Queue] = []

# Offline threshold in seconds
OFFLINE_THRESHOLD = 15

def get_device_status(device_info: dict, current_time: float) -> dict:
    """Helper to enrich device info with live online/offline status."""
    info = device_info.copy()
    last_seen = info.get("last_seen", 0)
    info["online"] = (current_time - last_seen) < OFFLINE_THRESHOLD
    return info

async def broadcast(event_type: str, data: dict):
    """Broadcast an event to all connected SSE clients."""
    payload = f"event: {event_type}\ndata: {json.dumps(data)}\n\n"
    for queue in list(listeners):
        try:
            await queue.put(payload)
        except Exception:
            pass

async def ping_host(ip: str) -> float:
    """Ping a host and return round-trip latency in ms, or None if unreachable."""
    try:
        is_win = platform.system() == "Windows"
        # 1 packet, 1 second timeout (Linux -W, Windows -w 1000)
        cmd = ["ping", "-n", "1", "-w", "1000", ip] if is_win else ["ping", "-c", "1", "-W", "1", ip]
        
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        stdout, _ = await proc.communicate()
        
        if proc.returncode == 0:
            output = stdout.decode(errors='ignore')
            # Look for "time=Xms" or "time=X.Y ms"
            match = re.search(r'time[=<]([\d\.]+)\s*ms', output, re.IGNORECASE)
            if match:
                return float(match.group(1))
            match = re.search(r'time=([\d\.]+)', output, re.IGNORECASE)
            if match:
                return float(match.group(1))
    except Exception:
        pass
    return None

async def ping_background_loop():
    """Background task to periodically ping registered nodes and update latency."""
    while True:
        try:
            current_time = time.time()
            hostnames = list(devices.keys())
            for hostname in hostnames:
                device = devices.get(hostname)
                if device:
                    # Check if device is active before pinging
                    is_active = (current_time - device.get("last_seen", 0)) < OFFLINE_THRESHOLD
                    if is_active and device.get("ip"):
                        latency = await ping_host(device["ip"])
                        device["latency"] = latency
                    else:
                        device["latency"] = None
                    
                    # Broadcast latency update
                    enriched = get_device_status(device, current_time)
                    await broadcast("metrics", enriched)
        except Exception as e:
            print(f"Error in ping loop: {e}")
        # Sleep for 10 seconds before next ping sweep
        await asyncio.sleep(10.0)

async def record_power_history_loop():
    """Background task to periodically record the total power draw of the lab."""
    while True:
        try:
            current_time = time.time()
            total_power = 0.0
            for device in list(devices.values()):
                is_active = (current_time - device.get("last_seen", 0)) < OFFLINE_THRESHOLD
                if is_active:
                    cpu_p = device.get("cpu_power")
                    gpu_info = device.get("gpu")
                    gpu_p = gpu_info.get("power") if gpu_info else None
                    
                    device_power = 0.0
                    if isinstance(cpu_p, (int, float)):
                        device_power += cpu_p
                    if isinstance(gpu_p, (int, float)):
                        device_power += gpu_p
                    total_power += device_power
            
            power_history.append({
                "time": current_time,
                "power": total_power
            })
            
            if len(power_history) > MAX_POWER_HISTORY:
                power_history.pop(0)
        except Exception as e:
            print(f"Error in power history loop: {e}")
        await asyncio.sleep(60.0)

async def check_services_loop():
    """Background task to query services status every 30 seconds."""
    while True:
        try:
            tasks = [ping_service(s) for s in services_list]
            if tasks:
                await asyncio.gather(*tasks)
            
            sanitized = get_sanitized_services()
            await broadcast("services", sanitized)
        except Exception as e:
            print(f"Error in services loop: {e}")
        await asyncio.sleep(30.0)

@app.on_event("startup")
async def startup_event():
    load_services_config()
    # Start the non-blocking background ping sweep
    asyncio.create_task(ping_background_loop())
    # Start the power history loop
    asyncio.create_task(record_power_history_loop())
    # Start the services loop
    asyncio.create_task(check_services_loop())

@app.post("/api/report")
async def report_metrics(data: dict):
    hostname = data.get("hostname")
    if not hostname:
        return {"status": "error", "message": "Missing hostname"}
    
    current_time = time.time()
    # Preserving latency from background ping loop if already present
    if hostname in devices and "latency" in devices[hostname]:
        data["latency"] = devices[hostname]["latency"]
    else:
        data["latency"] = None
        
    data["last_seen"] = current_time
    devices[hostname] = data
    
    enriched = get_device_status(data, current_time)
    await broadcast("metrics", enriched)
    return {"status": "ok"}

@app.get("/api/devices")
async def get_devices():
    current_time = time.time()
    return {
        name: get_device_status(info, current_time)
        for name, info in devices.items()
    }

@app.get("/api/power-history")
async def get_power_history():
    return power_history

@app.get("/api/services")
async def get_services_endpoint():
    return get_sanitized_services()

@app.get("/api/stream")
async def message_stream(request: Request):
    queue = asyncio.Queue()
    listeners.append(queue)
    
    current_time = time.time()
    initial_state = [
        get_device_status(info, current_time)
        for info in devices.values()
    ]
    initial_services = get_sanitized_services()
    
    async def event_generator():
        try:
            yield f"event: init\ndata: {json.dumps(initial_state)}\n\n"
            yield f"event: services_init\ndata: {json.dumps(initial_services)}\n\n"
            
            while True:
                if await request.is_disconnected():
                    break
                try:
                    data = await asyncio.wait_for(queue.get(), timeout=10.0)
                    yield data
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
        except asyncio.CancelledError:
            pass
        finally:
            if queue in listeners:
                listeners.remove(queue)

    return StreamingResponse(event_generator(), media_type="text/event-stream")

# Mount frontend static files
backend_dir = os.path.dirname(os.path.abspath(__file__))
frontend_dir = os.path.abspath(os.path.join(backend_dir, "../frontend"))

if os.path.exists(frontend_dir):
    app.mount("/", StaticFiles(directory=frontend_dir, html=True), name="static")
else:
    print(f"Warning: Static files directory '{frontend_dir}' not found.")
