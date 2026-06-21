import asyncio
import json
import os
import platform
import re
import time
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

@app.on_event("startup")
async def startup_event():
    # Start the non-blocking background ping sweep
    asyncio.create_task(ping_background_loop())

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

@app.get("/api/stream")
async def message_stream(request: Request):
    queue = asyncio.Queue()
    listeners.append(queue)
    
    current_time = time.time()
    initial_state = [
        get_device_status(info, current_time)
        for info in devices.values()
    ]
    
    async def event_generator():
        try:
            yield f"event: init\ndata: {json.dumps(initial_state)}\n\n"
            
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
