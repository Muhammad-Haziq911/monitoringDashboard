import asyncio
import json
import os
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
    # Create a copy of the list to avoid modification during iteration
    for queue in list(listeners):
        try:
            await queue.put(payload)
        except Exception:
            # If putting in queue fails, we remove it in finally block of stream anyway
            pass

@app.post("/api/report")
async def report_metrics(data: dict):
    hostname = data.get("hostname")
    if not hostname:
        return {"status": "error", "message": "Missing hostname"}
    
    current_time = time.time()
    data["last_seen"] = current_time
    devices[hostname] = data
    
    # Enrich the data with online status and broadcast
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
            # Yield initial state immediately on connect
            yield f"event: init\ndata: {json.dumps(initial_state)}\n\n"
            
            while True:
                if await request.is_disconnected():
                    break
                try:
                    # 10s keepalive timeout
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
# We look for index.html in c:/Dashboard/frontend
backend_dir = os.path.dirname(os.path.abspath(__file__))
frontend_dir = os.path.abspath(os.path.join(backend_dir, "../frontend"))

if os.path.exists(frontend_dir):
    app.mount("/", StaticFiles(directory=frontend_dir, html=True), name="static")
else:
    print(f"Warning: Static files directory '{frontend_dir}' not found.")
