<#
.SYNOPSIS
  Installs KoduDB on a Windows server: completes .env (generating the console sign-in), builds the API
  and the console, runs both with PM2 and starts them again after a reboot.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\windows\install.ps1 -DatabaseUrl "postgres://postgres:secret@127.0.0.1:5432/kodudb"

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\windows\install.ps1 -Uninstall

.NOTES
  Needs Node.js 22+, Rust (rustup, MSVC toolchain) and a PostgreSQL 15+ server whose user may create
  databases and roles. Run from an elevated PowerShell so the start-up task can be registered.
#>
[CmdletBinding()]
param(
  # Written to .env only when .env has no DATABASE_URL yet.
  [string]$DatabaseUrl,
  [int]$ApiPort = 8787,
  [int]$ConsolePort = 3100,
  [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'
$Root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$EnvFile = Join-Path $Root '.env'
$TaskName = 'KoduDB'

function Need($cmd, $hint) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { throw "$cmd not found. $hint" }
}

if ($Uninstall) {
  if (Get-Command pm2 -ErrorAction SilentlyContinue) {
    & pm2 delete kodudb-api kodudb-console 2>$null
    & pm2 save --force | Out-Null
  }
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
  Write-Host 'KoduDB stopped and removed from start-up. .env and data were kept.'
  return
}

Need node 'Install Node.js 22 or newer from https://nodejs.org.'
Need cargo 'Install Rust from https://rustup.rs (default MSVC toolchain).'
$nodeMajor = [int]((& node --version).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 22) { throw "Node.js 22+ is needed; found $(& node --version)." }

# 1. .env: the database URL first (if given), then everything else that is missing.
if ($DatabaseUrl) {
  $hasDb = (Test-Path $EnvFile) -and (Select-String -Path $EnvFile -Pattern '^DATABASE_URL=' -Quiet)
  if (-not $hasDb) { Add-Content -Path $EnvFile -Value "DATABASE_URL=$DatabaseUrl" -Encoding utf8 }
}
foreach ($pair in @(@('API_PORT', $ApiPort), @('CONSOLE_PORT', $ConsolePort))) {
  if (-not ((Test-Path $EnvFile) -and (Select-String -Path $EnvFile -Pattern "^$($pair[0])=" -Quiet))) {
    Add-Content -Path $EnvFile -Value "$($pair[0])=$($pair[1])" -Encoding utf8
  }
}
& node (Join-Path $Root 'scripts\gen-env.mjs')
if ($LASTEXITCODE -ne 0) { throw 'gen-env.mjs failed' }

# 2. Build.
Push-Location (Join-Path $Root 'api')
try { & cargo build --release; if ($LASTEXITCODE -ne 0) { throw 'API build failed' } } finally { Pop-Location }
Push-Location (Join-Path $Root 'console')
try {
  & npm ci --no-audit --no-fund; if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
  & npm run build; if ($LASTEXITCODE -ne 0) { throw 'console build failed' }
} finally { Pop-Location }

# 3. Run with PM2 and keep the process list for restarts.
if (-not (Get-Command pm2 -ErrorAction SilentlyContinue)) { & npm install -g pm2; if ($LASTEXITCODE -ne 0) { throw 'installing pm2 failed' } }
& pm2 startOrReload (Join-Path $Root 'ecosystem.config.cjs') --update-env
& pm2 save --force | Out-Null

# 4. Start again after a reboot: a task that resurrects the saved PM2 list for this user.
$pm2 = (Get-Command pm2).Source
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$pm2`" resurrect" -WorkingDirectory $Root
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U -RunLevel Highest
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Force | Out-Null

$user = (Select-String -Path $EnvFile -Pattern '^DASHBOARD_USERNAME=(.*)$').Matches[0].Groups[1].Value
Write-Host ''
Write-Host "KoduDB is running. Console: http://localhost:$ConsolePort  API: http://localhost:$ApiPort"
Write-Host "Sign in as '$user' with DASHBOARD_PASSWORD from $EnvFile"
Write-Host "Logs: pm2 logs kodudb-api   Stop: pm2 stop all   Remove: install.ps1 -Uninstall"
