<#
.SYNOPSIS
    Installs the HomeLab Dashboard agent on a Windows node as a scheduled task.

.DESCRIPTION
    Creates a virtualenv, installs psutil, writes a launcher that carries the
    agent configuration, and registers a Scheduled Task that runs the agent
    silently via pythonw. Run from an elevated PowerShell prompt inside a
    checkout of this repository:

        .\scripts\install-agent.ps1 -Server http://192.168.1.50:8000 -Key <agent-key>

    Configuration lives in the generated launcher, so agent.py is never edited
    and stays in sync with git.

.PARAMETER AtLogon
    Run the agent when the current user logs on, instead of at system startup
    as SYSTEM. Use this if the agent needs the interactive desktop session.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Server,
    [Parameter(Mandatory = $true)][string]$Key,
    [int]$Interval = 5,
    [switch]$AtLogon
)

$ErrorActionPreference = 'Stop'
$TaskName = 'HomeLab Dashboard Agent'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not (New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'This script must be run from an elevated PowerShell prompt.'
}

# Accept either a base URL or the full endpoint.
$reportUrl = $Server.TrimEnd('/')
if (-not $reportUrl.EndsWith('/api/report')) { $reportUrl = "$reportUrl/api/report" }

$repoRoot  = Split-Path -Parent $PSScriptRoot
$agentDir  = Join-Path $repoRoot 'agent'
$venvDir   = Join-Path $agentDir '.venv'
$launcher  = Join-Path $agentDir 'run-agent.cmd'

if (-not (Test-Path (Join-Path $agentDir 'agent.py'))) {
    throw "Could not find agent\agent.py under $repoRoot."
}

$python = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $python) { throw 'python not found on PATH. Install Python 3.10+ and re-run.' }

Write-Host "==> Installing agent from $agentDir (reporting to $reportUrl)"

$pythonw = Join-Path $venvDir 'Scripts\pythonw.exe'
if ((Test-Path $venvDir) -and -not (Test-Path $pythonw)) {
    Write-Host "==> Removing incompatible virtualenv at $venvDir"
    Remove-Item -Recurse -Force $venvDir
}

Write-Host "==> Creating virtualenv at $venvDir"
& $python -m venv $venvDir
& (Join-Path $venvDir 'Scripts\pip.exe') install --quiet --upgrade pip
& (Join-Path $venvDir 'Scripts\pip.exe') install --quiet -r (Join-Path $agentDir 'requirements.txt')

# The launcher carries the config, since Scheduled Tasks have no equivalent
# of systemd's EnvironmentFile.
Write-Host "==> Writing $launcher"
@"
@echo off
set HOMELAB_SERVER_URL=$reportUrl
set HOMELAB_AGENT_KEY=$Key
set HOMELAB_INTERVAL=$Interval
start "" "$pythonw" "$(Join-Path $agentDir 'agent.py')"
"@ | Set-Content -Path $launcher -Encoding ASCII

# The launcher holds the shared agent key: restrict it to admins and SYSTEM.
icacls $launcher /inheritance:r /grant:r 'BUILTIN\Administrators:(F)' 'NT AUTHORITY\SYSTEM:(F)' | Out-Null

Write-Host "==> Registering scheduled task '$TaskName'"
$action = New-ScheduledTaskAction -Execute $launcher -WorkingDirectory $agentDir

if ($AtLogon) {
    $trigger   = New-ScheduledTaskTrigger -AtLogOn
    $principal = New-ScheduledTaskPrincipal -UserId $identity.Name -RunLevel Highest
} else {
    $trigger   = New-ScheduledTaskTrigger -AtStartup
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
}

# Restart on failure, and never stop a long-running agent.
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings -Force | Out-Null

Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 3

$state = (Get-ScheduledTask -TaskName $TaskName).State
Write-Host ''
Write-Host "Scheduled task state: $state"
Write-Host 'This node should appear on the dashboard within a few seconds.'
Write-Host "To stop it:   Stop-ScheduledTask -TaskName '$TaskName'"
Write-Host "To remove it: Unregister-ScheduledTask -TaskName '$TaskName'"
