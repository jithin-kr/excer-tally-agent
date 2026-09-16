# Removes the excer-tally-agent service. Run from an ELEVATED PowerShell prompt.
#
#     .\install\uninstall-agent.ps1
#
# Leaves the repo, .env and logs in place — this stops the agent, it does not erase anything.

[CmdletBinding()]
param(
    [string]$ServiceName = "ExcerTallyAgent",
    [string]$NssmPath = ""
)

$ErrorActionPreference = "Stop"

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "This script must be run from an elevated (Administrator) PowerShell prompt."
}

$removed = $false

# NSSM-installed service
$service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($service) {
    $nssm = $NssmPath
    if (-not $nssm) {
        $found = Get-Command nssm -ErrorAction SilentlyContinue
        if ($found) { $nssm = $found.Source }
    }
    if ($nssm -and (Test-Path $nssm)) {
        & $nssm stop $ServiceName | Out-Null
        & $nssm remove $ServiceName confirm | Out-Null
    } else {
        Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
        & sc.exe delete $ServiceName | Out-Null
    }
    Write-Host "Removed service '$ServiceName'." -ForegroundColor Green
    $removed = $true
}

# Scheduled-task fallback
$task = Get-ScheduledTask -TaskName $ServiceName -ErrorAction SilentlyContinue
if ($task) {
    Stop-ScheduledTask -TaskName $ServiceName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $ServiceName -Confirm:$false
    Write-Host "Removed scheduled task '$ServiceName'." -ForegroundColor Green
    $removed = $true
}

if (-not $removed) {
    Write-Host "Nothing named '$ServiceName' was installed." -ForegroundColor Yellow
}

Write-Host "The repo, .env and logs were left in place." -ForegroundColor DarkGray
