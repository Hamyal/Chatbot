# Starts the Stone REST API + Next.js chat locally (no MCP).
# Prerequisites: Node.js LTS, and `npm install` run once in stone-api and in the web app folder.
#
# Usage (PowerShell):
#   cd path\to\restapi
#   .\run-local.ps1
#
# Optional: set which frontend to open (default: stone-ai-chat)
#   .\run-local.ps1 -WebApp stone-ai-chat
#   .\run-local.ps1 -WebApp AI-Assistant

param(
  [ValidateSet("stone-ai-chat", "AI-Assistant")]
  [string]$WebApp = "stone-ai-chat"
)

$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
$ApiDir = Join-Path $Root "stone-api"
$WebDir = Join-Path $Root $WebApp

if (-not (Test-Path (Join-Path $ApiDir "server.js"))) {
  Write-Error "stone-api not found at: $ApiDir"
}
if (-not (Test-Path (Join-Path $WebDir "package.json"))) {
  Write-Error "Web app not found at: $WebDir"
}

$apiCmd = @"
Set-Location '$ApiDir'
Write-Host '=== Stone API (default http://localhost:3001) ===' -ForegroundColor Green
Write-Host 'Health: http://localhost:3001/api/health' -ForegroundColor DarkGray
npm run dev
"@

$webCmd = @"
Set-Location '$WebDir'
Write-Host '=== Next.js chat (default http://localhost:3000) ===' -ForegroundColor Green
Write-Host 'Copy .env.example to .env.local if you have not already.' -ForegroundColor DarkYellow
npm run dev
"@

Start-Process pwsh -ArgumentList @("-NoExit", "-Command", $apiCmd)
Start-Sleep -Milliseconds 800
Start-Process pwsh -ArgumentList @("-NoExit", "-Command", $webCmd)

Write-Host ""
Write-Host "Started two windows: Stone API + $WebApp" -ForegroundColor Cyan
Write-Host "  Chat UI:  http://localhost:3000"
Write-Host "  API:      http://localhost:3001/api/health"
Write-Host ""
