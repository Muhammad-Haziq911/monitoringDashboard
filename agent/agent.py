import json
import os
import platform
import socket
import subprocess
import time
import urllib.request
import urllib.error
import psutil

# Configuration
SERVER_URL = "http://localhost:8000/api/report"  # Adjust to your APU server IP in production
INTERVAL = 5  # Reporting interval in seconds

class AgentState:
    def __init__(self):
        self.last_net_bytes_sent = None
        self.last_net_bytes_recv = None
        self.last_net_time = None

state = AgentState()

def get_ip():
    """Get the primary local IP address of this machine."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        # Doesn't need to be reachable
        s.connect(('10.255.255.255', 1))
        ip = s.getsockname()[0]
    except Exception:
        ip = '127.0.0.1'
    finally:
        s.close()
    return ip

def get_cpu_model():
    """Retrieve the marketing name of the CPU."""
    try:
        sys_name = platform.system()
        if sys_name == "Windows":
            import winreg
            key = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"HARDWARE\DESCRIPTION\System\CentralProcessor\0")
            name, _ = winreg.QueryValueEx(key, "ProcessorNameString")
            return name.strip()
        elif sys_name == "Linux":
            with open("/proc/cpuinfo", "r") as f:
                for line in f:
                    if "model name" in line:
                        return line.split(":")[1].strip()
        elif sys_name == "Darwin":
            return subprocess.check_output(["sysctl", "-n", "machdep.cpu.brand_string"]).decode().strip()
    except Exception:
        pass
    return platform.processor()

def get_os_info():
    """Retrieve detailed Operating System release and build info."""
    try:
        sys_name = platform.system()
        if sys_name == "Windows":
            release = platform.release()
            version = platform.version()
            return f"Windows {release} (Build {version.split('.')[-1]})"
        elif sys_name == "Linux":
            if os.path.exists("/etc/os-release"):
                with open("/etc/os-release") as f:
                    for line in f:
                        if line.startswith("PRETTY_NAME="):
                            return line.split("=")[1].replace('"', '').strip()
            return f"Linux {platform.release()}"
        elif sys_name == "Darwin":
            return f"macOS {platform.mac_ver()[0]}"
    except Exception:
        pass
    return f"{platform.system()} {platform.release()}"

def get_temperature():
    """Retrieve CPU temperature in Celsius (Linux fallback, None on Windows)."""
    try:
        # 1. Try psutil sensors
        if hasattr(psutil, "sensors_temperatures"):
            temps = psutil.sensors_temperatures()
            if temps:
                for key in ['coretemp', 'cpu_thermal', 'cpu-thermal', 'acpitz']:
                    if key in temps and temps[key]:
                        return temps[key][0].current
                for entries in temps.values():
                    if entries and entries[0].current:
                        return entries[0].current

        # 2. Try sysfs on Linux
        if os.path.exists("/sys/class/thermal/thermal_zone0/temp"):
            with open("/sys/class/thermal/thermal_zone0/temp", "r") as f:
                return float(f.read().strip()) / 1000.0
    except Exception:
        pass
    return None

def get_gpu_status():
    """Query NVIDIA GPU usage and stats using nvidia-smi if available."""
    try:
        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,utilization.gpu,utilization.memory,memory.total,memory.used,temperature.gpu", "--format=csv,noheader,nounits"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=3
        )
        if result.returncode == 0 and result.stdout.strip():
            parts = result.stdout.strip().split(", ")
            if len(parts) == 6:
                return {
                    "name": parts[0],
                    "utilization": float(parts[1]),
                    "mem_utilization": float(parts[2]),
                    "mem_total": float(parts[3]) * 1024 * 1024,  # Convert MB to Bytes
                    "mem_used": float(parts[4]) * 1024 * 1024,
                    "temp": float(parts[5])
                }
    except Exception:
        pass
    return None

def get_disk_status():
    """Retrieve status for all local disk partitions."""
    disks = []
    try:
        for part in psutil.disk_partitions(all=False):
            if 'cdrom' in part.opts or part.fstype == '':
                continue
            # Skip virtual file systems on Linux
            if os.name != 'nt' and part.mountpoint.startswith(('/proc', '/sys', '/dev', '/run', '/boot')):
                continue
            
            try:
                usage = psutil.disk_usage(part.mountpoint)
                if usage.total == 0:
                    continue
                disks.append({
                    "device": part.device,
                    "mount": part.mountpoint,
                    "total": usage.total,
                    "used": usage.used,
                    "free": usage.free,
                    "percent": usage.percent
                })
            except PermissionError:
                continue
            except Exception:
                continue
    except Exception:
        pass
    return disks

def get_network_speeds():
    """Calculate average network download and upload speeds in Bytes/sec."""
    try:
        counters = psutil.net_io_counters()
        now = time.time()
        
        if state.last_net_bytes_sent is None:
            state.last_net_bytes_sent = counters.bytes_sent
            state.last_net_bytes_recv = counters.bytes_recv
            state.last_net_time = now
            return {"down_speed": 0.0, "up_speed": 0.0}
            
        dt = now - state.last_net_time
        if dt <= 0:
            return {"down_speed": 0.0, "up_speed": 0.0}
            
        down_speed = (counters.bytes_recv - state.last_net_bytes_recv) / dt
        up_speed = (counters.bytes_sent - state.last_net_bytes_sent) / dt
        
        state.last_net_bytes_sent = counters.bytes_sent
        state.last_net_bytes_recv = counters.bytes_recv
        state.last_net_time = now
        
        return {
            "down_speed": down_speed,
            "up_speed": up_speed
        }
    except Exception:
        return {"down_speed": 0.0, "up_speed": 0.0}

def get_vpn_status():
    """Check for active Tailscale and OpenVPN interfaces."""
    vpns = {
        "tailscale": False,
        "openvpn": False
    }
    try:
        interfaces = psutil.net_if_addrs().keys()
        for iface in interfaces:
            iface_lower = iface.lower()
            
            # Tailscale check
            if "tailscale" in iface_lower or iface_lower.startswith("utun") or iface_lower == "ts0":
                vpns["tailscale"] = True
                
            # OpenVPN check
            if "tun" in iface_lower or "tap" in iface_lower or "openvpn" in iface_lower:
                vpns["openvpn"] = True
    except Exception:
        pass
    return vpns

def get_docker_containers():
    """Retrieve Docker container list using CLI subprocess call."""
    containers = []
    try:
        result = subprocess.run(
            ["docker", "ps", "-a", "--format", "{{.Names}}\t{{.State}}"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=3
        )
        if result.returncode == 0 and result.stdout.strip():
            lines = result.stdout.strip().split("\n")
            for line in lines:
                parts = line.split("\t")
                if len(parts) == 2:
                    name, state = parts
                    containers.append({
                        "name": name,
                        "state": state.capitalize()
                    })
    except Exception:
        pass
    return containers

def gather_metrics():
    """Gather all detailed system, GPU, storage, VPN, and Docker metrics."""
    hostname = socket.gethostname()
    ip = get_ip()
    os_info = get_os_info()
    cpu_model = get_cpu_model()
    
    # Core counts
    cpu_cores_logical = psutil.cpu_count(logical=True)
    cpu_cores_physical = psutil.cpu_count(logical=False)
    
    # CPU Usage (blocks for 0.5s)
    cpu_usage = psutil.cpu_percent(interval=0.5)
    
    # Virtual Memory
    mem = psutil.virtual_memory()
    memory_info = {
        "total": mem.total,
        "used": mem.used,
        "free": mem.available
    }
    
    # Disks (Multiple)
    disks = get_disk_status()
    
    # Network bandwidth
    network = get_network_speeds()
    
    # Uptime
    uptime = time.time() - psutil.boot_time()
    
    # Temp
    temp = get_temperature()
    
    # GPU (RTX / Nvidia)
    gpu = get_gpu_status()
    
    # VPN
    vpns = get_vpn_status()
    
    # Docker
    docker_containers = get_docker_containers()
    
    return {
        "hostname": hostname,
        "ip": ip,
        "os_info": os_info,
        "cpu_model": cpu_model,
        "cpu_cores": {
            "physical": cpu_cores_physical,
            "logical": cpu_cores_logical
        },
        "cpu_usage": cpu_usage,
        "memory": memory_info,
        "disks": disks,
        "network": network,
        "uptime": uptime,
        "temp": temp,
        "gpu": gpu,
        "vpns": vpns,
        "docker_containers": docker_containers
    }

def send_metrics(data):
    """POST JSON payload to server."""
    payload = json.dumps(data).encode("utf-8")
    req = urllib.request.Request(
        SERVER_URL,
        data=payload,
        headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=3) as response:
            response.read()
            return True
    except urllib.error.URLError as e:
        print(f"Failed to connect to dashboard server: {e.reason}")
    except Exception as e:
        print(f"Error sending metrics: {e}")
    return False

def main():
    print(f"Starting Enhanced Home Lab Dashboard Agent...")
    print(f"Target Server: {SERVER_URL}")
    print(f"Press Ctrl+C to exit.")
    
    while True:
        try:
            start_time = time.time()
            
            # Gather and push
            metrics = gather_metrics()
            success = send_metrics(metrics)
            
            if success:
                print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] Metrics sent successfully.")
            
            # Account for processing time
            elapsed = time.time() - start_time
            sleep_time = max(0.1, INTERVAL - elapsed)
            time.sleep(sleep_time)
            
        except KeyboardInterrupt:
            print("\nAgent stopped.")
            break
        except Exception as e:
            print(f"Unexpected error: {e}")
            time.sleep(INTERVAL)

if __name__ == "__main__":
    main()
