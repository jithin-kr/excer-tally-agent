# Installs excer-tally-agent as a Windows Service on the Tally machine.
#
# Run from an ELEVATED PowerShell prompt, from the repo root:
#     .\install\install-agent.ps1
#
# Two service backends are supported:
#   NSSM            - preferred. Proper service lifecycle, log rotation, auto-restart.
#   ScheduledTask   - fallback when NSSM cannot be downloaded on a locked-down machine.
#                     Runs at boot, restarts on failure. Slightly less observable.
#
# The script is idempotent: running it again upgrades the installed service in place.

[CmdletBinding()]
param(
    [ValidateSet("nssm", "task")]
    [string]$Backend = "nssm",
    [string]$ServiceName = "ExcerTallyAgent",
    [string]$NssmPath = ""
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot

function Assert-Admin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw "This script must be run from an elevated (Administrator) PowerShell prompt."
    }
}

function Assert-Node {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) {
        throw "Node.js is not installed or not on PATH. Install the current LTS from https://nodejs.org and reopen PowerShell."
    }
    $version = (& node --version).TrimStart("v")
    $major = [int]($version.Split(".")[0])
    if ($major -lt 20) {
        throw "Node $version found, but this agent needs Node 20 or newer (it uses --env-file-if-exists)."
    }
    Write-Host "  Node $version at $($node.Source)" -ForegroundColor DarkGray
}

function Assert-EnvFile {
    $envPath = Join-Path $repoRoot ".env"
    if (-not (Test-Path $envPath)) {
        Copy-Item (Join-Path $repoRoot ".env.example") $envPath
        Write-Host ""
        Write-Host "  Created .env from .env.example." -ForegroundColor Yellow
        Write-Host "  EDIT IT NOW before continuing - AGENT_API_KEY is 'change-me'," -ForegroundColor Yellow
        Write-Host "  and every Tally voucher/ledger name still holds a default guess." -ForegroundColor Yellow
        Write-Host ""
        throw "Edit .env, then run this script again."
    }
    $content = Get-Content $envPath -Raw
    if ($content -match "AGENT_API_KEY\s*=\s*change-me") {
        throw "AGENT_API_KEY is still 'change-me' in .env. Set a long random secret first."
    }
    Write-Host "  .env present, API key set" -ForegroundColor DarkGray
}

function Build-Agent {
    Push-Location $repoRoot
    try {
        Write-Host "  Installing dependencies..." -ForegroundColor DarkGray
        & npm ci --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw "npm ci failed." }
        Write-Host "  Building..." -ForegroundColor DarkGray
        & npm run build
        if ($LASTEXITCODE -ne 0) { throw "Build failed." }
    } finally {
        Pop-Location
    }
}

function Install-WithNssm {
    $nssm = $NssmPath
    if (-not $nssm) {
        $found = Get-Command nssm -ErrorAction SilentlyContinue
        if ($found) { $nssm = $found.Source }
    }
    if (-not $nssm -or -not (Test-Path $nssm)) {
        throw @"
NSSM was not found.

Download it from https://nssm.cc/download, unzip, and either:
  - put nssm.exe on PATH, or
  - re-run with:  .\install\install-agent.ps1 -NssmPath C:\path\to\nssm.exe

Or, if this machine cannot download tools, use the no-download fallback:
  .\install\install-agent.ps1 -Backend task
"@
    }

    $nodeExe = (Get-Command node).Source
    $logDir = Join-Path $repoRoot "logs"
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null

    $existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($existing) {
        Write-Host "  Service exists - stopping for upgrade..." -ForegroundColor DarkGray
        & $nssm stop $ServiceName | Out-Null
        Start-Sleep -Seconds 2
    } else {
        & $nssm install $ServiceName $nodeExe | Out-Null
    }

    & $nssm set $ServiceName Application $nodeExe                                        | Out-Null
    & $nssm set $ServiceName AppParameters "--env-file-if-exists=.env dist\index.js"     | Out-Null
    & $nssm set $ServiceName AppDirectory $repoRoot                                      | Out-Null
    & $nssm set $ServiceName DisplayName "Excer Tally Agent"                             | Out-Null
    & $nssm set $ServiceName Description "Bridges Excer Global's web app to TallyPrime's XML gateway." | Out-Null
    & $nssm set $ServiceName Start SERVICE_AUTO_START                                    | Out-Null
    # Restart on crash, but back off so a misconfigured agent does not spin.
    & $nssm set $ServiceName AppExit Default Restart                                     | Out-Null
    & $nssm set $ServiceName AppRestartDelay 5000                                        | Out-Null
    # Rotate logs at 10MB so an overnight failure loop cannot fill the disk.
    & $nssm set $ServiceName AppStdout (Join-Path $logDir "agent.out.log")               | Out-Null
    & $nssm set $ServiceName AppStderr (Join-Path $logDir "agent.err.log")               | Out-Null
    & $nssm set $ServiceName AppRotateFiles 1                                            | Out-Null
    & $nssm set $ServiceName AppRotateBytes 10485760                                     | Out-Null

    & $nssm start $ServiceName | Out-Null
    Write-Host "  Service '$ServiceName' installed and started (NSSM)" -ForegroundColor Green
    Write-Host "  Logs: $logDir" -ForegroundColor DarkGray
}

function Install-WithScheduledTask {
    $nodeExe = (Get-Command node).Source
    $action = New-ScheduledTaskAction -Execute $nodeExe `
        -Argument "--env-file-if-exists=.env dist\index.js" -WorkingDirectory $repoRoot
    $trigger = New-ScheduledTaskTrigger -AtStartup
    # SYSTEM so it runs with no one logged in - the machine may sit at a lock screen.
    $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
        -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -MultipleInstances IgnoreNew

    Register-ScheduledTask -TaskName $ServiceName -Action $action -Trigger $trigger `
        -Principal $principal -Settings $settings -Force | Out-Null
    Start-ScheduledTask -TaskName $ServiceName
    Write-Host "  Scheduled task '$ServiceName' installed and started" -ForegroundColor Green
    Write-Host "  NOTE: no log rotation with this backend - check Event Viewer." -ForegroundColor Yellow
}

# ─────────────────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "Excer Tally Agent - install" -ForegroundColor Cyan
Write-Host "Repo: $repoRoot"
Write-Host ""

Assert-Admin
Assert-Node
Assert-EnvFile
Build-Agent

Write-Host ""
Write-Host "Checking Tally before installing the service..." -ForegroundColor Cyan
Push-Location $repoRoot
try {
    & npm run doctor
    if ($LASTEXITCODE -ne 0) {
        Write-Host ""
        Write-Host "  Tally checks did not pass." -ForegroundColor Yellow
        $answer = Read-Host "  Install the service anyway? (y/N)"
        if ($answer -ne "y") { throw "Aborted. Fix the Tally connection, then re-run." }
    }
} finally {
    Pop-Location
}

Write-Host ""
if ($Backend -eq "nssm") { Install-WithNssm } else { Install-WithScheduledTask }

Write-Host ""
Write-Host "Done. Verify with:" -ForegroundColor Cyan
Write-Host "  curl http://127.0.0.1:7010/health"
Write-Host ""
Write-Host "Next: set up the Cloudflare Tunnel - see install\TUNNEL.md" -ForegroundColor Cyan
Write-Host ""
