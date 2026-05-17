#Requires -Version 5.1
<#
.SYNOPSIS
    Scheduled 12hr snapshot — captures raw TradingView chart state via CDP.
    Runs at 09:03 and 21:03 via Windows Scheduled Tasks.
    Generates raw data only; bias analysis requires an in-session Claude request.

.NOTES
    Paths are derived at runtime from this script's location and $env:USERPROFILE
    so the script works on any machine regardless of username or install path.
#>

$ErrorActionPreference = 'Stop'

# Resolve paths relative to the repo root (script lives in <repo>\scripts\)
$RepoRoot  = Split-Path -Parent $PSScriptRoot
$NodeExe   = (Get-Command node -ErrorAction SilentlyContinue)?.Source ?? 'node'
$CliJs     = Join-Path $RepoRoot 'src\cli\index.js'
$RulesFile = Join-Path $RepoRoot 'rules.json'
$OutDir    = Join-Path $env:USERPROFILE '.tradingview-mcp\sessions'

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$timestamp = Get-Date -Format 'yyyy-MM-dd_HHmm'
$outFile   = Join-Path $OutDir "snapshot_$timestamp.json"

# Verify CDP is reachable
try {
    $health = Invoke-RestMethod 'http://localhost:9222/json/version' -TimeoutSec 5
} catch {
    @{
        error     = 'CDP not reachable — TradingView not running with --remote-debugging-port=9222'
        timestamp = $timestamp
    } | ConvertTo-Json | Out-File $outFile -Encoding UTF8
    Write-Warning "CDP unreachable. Snapshot written with error: $outFile"
    exit 1
}

# Load rules
$rules = Get-Content $RulesFile -Raw | ConvertFrom-Json

# Run CLI status check
$cliRaw    = & $NodeExe $CliJs status 2>&1
$cliStatus = $cliRaw | ConvertFrom-Json -ErrorAction SilentlyContinue

$snapshot = [ordered]@{
    timestamp  = $timestamp
    cdp_ok     = $true
    cdp_target = $health.webSocketDebuggerUrl
    cli_status = $cliStatus
    watchlist  = $rules.watchlist
    timeframes = $rules.timeframes
    note       = 'Raw snapshot only. Open Claude Code and ask for a 12 Hr Update for bias analysis.'
}

$snapshot | ConvertTo-Json -Depth 10 | Out-File $outFile -Encoding UTF8
Write-Host "Snapshot saved: $outFile"
