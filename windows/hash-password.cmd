@echo off
setlocal
cd /d "%~dp0"

if "%~1"=="" (
  echo Usage: hash-password.cmd "your long passphrase"
  exit /b 1
)

node.exe dist\auth\hash-cli.js "%~1"
