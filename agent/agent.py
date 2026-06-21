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
SERVER_URL = "http://192.168.1.106:8000/api/report"  # Adjust to your dashboard server IP in production
INTERVAL = 5  # Reporting interval in seconds

# Prevent console window popping up/stealing focus when spawning subprocesses on Windows
creationflags = 0x08000000 if os.name == 'nt' else 0

class AgentState:
    def __init__(self):
        self.last_net_bytes_sent = None
        self.last_net_bytes_recv = None
        self.last_net_time = None
        self.last_disk_read = None
        self.last_disk_write = None
        self.last_disk_time = None
        self.last_rapl_energy = None
        self.last_rapl_time = None
        self.pending_updates = 0
        self.last_update_check = 0.0

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

def query_pending_updates():
    """Retrieve the number of pending OS updates."""
    sys_name = platform.system()
    if sys_name == "Windows":
        try:
            # Native COM call to query pending Windows updates
            cmd = ['powershell', '-Command', "(New-Object -ComObject Microsoft.Update.Session).CreateUpdateSearcher().Search(\"IsInstalled=0 and Type='Software' and IsHidden=0\").Updates.Count"]
            res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=10, creationflags=creationflags)
            if res.returncode == 0 and res.stdout.strip():
                return int(res.stdout.strip().split('\n')[0])
        except Exception:
            pass
    elif sys_name == "Linux":
        try:
            # 1. On Ubuntu/Debian, try update-notifier cache first
            path = "/var/lib/update-notifier/updates-available"
            if os.path.exists(path):
                with open(path, "r") as f:
                    content = f.read()
                match = re.search(r'(\d+)\s+updates?\s+can\s+be\s+applied', content, re.IGNORECASE)
                if match:
                    return int(match.group(1))
            
            # 2. Try the faster apt-check executable on Ubuntu
            apt_check = "/usr/lib/update-notifier/apt-check"
            if os.path.exists(apt_check):
                res = subprocess.run([apt_check], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=5)
                if res.returncode == 0 and res.stderr.strip():
                    parts = res.stderr.strip().split(';')
                    if len(parts) >= 1:
                        return int(parts[0])
        except Exception:
            pass
    return 0

def get_temperature():
    """Retrieve CPU temperature in Celsius (Linux/macOS native, Windows WMI fallback)."""
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

        # 3. Try WMI LibreHardwareMonitor/OpenHardwareMonitor on Windows
        if platform.system() == "Windows":
            # Query LibreHardwareMonitor
            cmd = ['powershell', '-Command', "Get-CimInstance -Namespace root/LibreHardwareMonitor -ClassName Sensor | Where-Object { $_.SensorType -eq 'Temperature' -and ($_.Name -like '*CPU Package*' -or $_.Name -like '*CPU Core*') } | Select-Object -ExpandProperty Value"]
            res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=2, creationflags=creationflags)
            if res.returncode == 0 and res.stdout.strip():
                return float(res.stdout.strip().split('\n')[0])
            
            # Query OpenHardwareMonitor
            cmd = ['powershell', '-Command', "Get-CimInstance -Namespace root/OpenHardwareMonitor -ClassName Sensor | Where-Object { $_.SensorType -eq 'Temperature' -and ($_.Name -like '*CPU Package*' -or $_.Name -like '*CPU Core*') } | Select-Object -ExpandProperty Value"]
            res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=2, creationflags=creationflags)
            if res.returncode == 0 and res.stdout.strip():
                return float(res.stdout.strip().split('\n')[0])
    except Exception:
        pass
    return None

def get_gpu_status():
    """Query NVIDIA GPU usage and stats using nvidia-smi if available."""
    try:
        # Added power.draw to the nvidia-smi query
        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,utilization.gpu,utilization.memory,memory.total,memory.used,temperature.gpu,power.draw", "--format=csv,noheader,nounits"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=3,
            creationflags=creationflags
        )
        if result.returncode == 0 and result.stdout.strip():
            parts = result.stdout.strip().split(", ")
            if len(parts) == 7:
                return {
                    "name": parts[0],
                    "utilization": float(parts[1]),
                    "mem_utilization": float(parts[2]),
                    "mem_total": float(parts[3]) * 1024 * 1024,  # Convert MB to Bytes
                    "mem_used": float(parts[4]) * 1024 * 1024,
                    "temp": float(parts[5]),
                    "power": float(parts[6])  # Power draw in Watts
                }
    except Exception:
        pass
    return None

def get_cpu_power():
    """Retrieve the real-time CPU package power draw in Watts."""
    sys_name = platform.system()
    if sys_name == "Windows":
        try:
            # Query the CPU RAPL package power counter in milliwatts
            cmd = ['powershell', '-Command', '(Get-Counter -Counter \'\\Energy Meter(*_pkg)\\Power\' -ErrorAction SilentlyContinue).CounterSamples.CookedValue']
            res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=2, creationflags=creationflags)
            if res.returncode == 0 and res.stdout.strip():
                # Value is in milliwatts, return as Watts
                return float(res.stdout.strip().split('\n')[0]) / 1000.0
        except Exception:
            pass
    elif sys_name == "Linux":
        # Query Linux RAPL package 0 energy counter (Intel/AMD)
        try:
            path = "/sys/class/powercap/intel-rapl/intel-rapl:0/energy_uj"
            if os.path.exists(path):
                with open(path, "r") as f:
                    energy = float(f.read().strip())
                now = time.time()
                
                if state.last_rapl_energy is None:
                    state.last_rapl_energy = energy
                    state.last_rapl_time = now
                    return None
                    
                dt = now - state.last_rapl_time
                power = 0.0
                if dt > 0:
                    # energy difference (microjoules) / time difference (seconds) = microwatts
                    # Divide by 1e6 to convert microwatts to Watts
                    power = (energy - state.last_rapl_energy) / (dt * 1000000.0)
                    
                state.last_rapl_energy = energy
                state.last_rapl_time = now
                
                # Sanity limit check (0 to 500W)
                if 0.0 <= power <= 500.0:
                    return power
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
            # Skip virtual file systems and loop devices on Linux
            if os.name != 'nt':
                if part.mountpoint.startswith(('/proc', '/sys', '/dev', '/run', '/boot')):
                    continue
                if 'loop' in part.device or part.device.startswith('/dev/loop'):
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

def get_disk_speeds():
    """Calculate average disk read and write speeds in Bytes/sec."""
    try:
        # Check if disk IO counters is supported on this system
        counters = psutil.disk_io_counters()
        now = time.time()
        
        if state.last_disk_read is None:
            state.last_disk_read = counters.read_bytes
            state.last_disk_write = counters.write_bytes
            state.last_disk_time = now
            return {"read_speed": 0.0, "write_speed": 0.0}
            
        dt = now - state.last_disk_time
        if dt <= 0:
            return {"read_speed": 0.0, "write_speed": 0.0}
            
        read_speed = (counters.read_bytes - state.last_disk_read) / dt
        write_speed = (counters.write_bytes - state.last_disk_write) / dt
        
        state.last_disk_read = counters.read_bytes
        state.last_disk_write = counters.write_bytes
        state.last_disk_time = now
        
        return {
            "read_speed": read_speed,
            "write_speed": write_speed
        }
    except Exception:
        return {"read_speed": 0.0, "write_speed": 0.0}

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
            timeout=3,
            creationflags=creationflags
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
    
    # Disks (Multiple) and speeds
    disks = get_disk_status()
    disk_speeds = get_disk_speeds()
    
    # Network bandwidth
    network = get_network_speeds()
    
    # Uptime
    uptime = time.time() - psutil.boot_time()
    
    # Temp and power
    temp = get_temperature()
    cpu_power = get_cpu_power()
    
    # GPU (RTX / Nvidia)
    gpu = get_gpu_status()
    
    # VPN
    vpns = get_vpn_status()
    
    # Docker
    docker_containers = get_docker_containers()
    
    # Check for pending OS updates asynchronously every 4 hours (14400s)
    now = time.time()
    if now - state.last_update_check >= 14400:
        state.last_update_check = now
        import threading
        def run_check():
            try:
                state.pending_updates = query_pending_updates()
            except Exception:
                pass
        threading.Thread(target=run_check, daemon=True).start()

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
        "disk_speeds": disk_speeds,
        "network": network,
        "uptime": uptime,
        "temp": temp,
        "cpu_power": cpu_power,
        "gpu": gpu,
        "vpns": vpns,
        "docker_containers": docker_containers,
        "pending_updates": state.pending_updates
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
