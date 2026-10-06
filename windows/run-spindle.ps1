Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Set-Location $PSScriptRoot

if (-not (Test-Path ".env")) {
    throw "Missing .env. Copy spindle.env.example to .env and configure it first."
}
if (-not (Test-Path "node.exe")) {
    throw "Missing node.exe. Use the official Spindle Windows bundle."
}

New-Item -ItemType Directory -Force -Path "data" | Out-Null
$logPath = Join-Path $PSScriptRoot "data\spindle.log"

& (Join-Path $PSScriptRoot "node.exe") --env-file=.env (Join-Path $PSScriptRoot "dist\server.js") *>> $logPath
exit $LASTEXITCODE
