@echo off
setlocal
cd /d "%~dp0"

if not exist ".env" (
  copy /y "spindle.env.example" ".env" >nul
  echo Created .env from spindle.env.example.
  echo Edit .env, then run start-spindle.cmd again.
  exit /b 1
)

if not exist "node.exe" (
  echo node.exe is missing. Use the official Spindle Windows bundle.
  exit /b 1
)

if not exist "data" mkdir "data"

echo Starting Spindle on Windows...
node.exe --env-file=.env dist\server.js
