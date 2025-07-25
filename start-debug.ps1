Write-Host "🔍 MEGASheep Database Debug & Startup" -ForegroundColor Cyan
Write-Host "=====================================" -ForegroundColor Cyan

# Change to the correct directory
Set-Location "C:\Users\liqui\MEGASheep"

Write-Host ""
Write-Host "📁 Current directory: $(Get-Location)" -ForegroundColor Green
Write-Host ""

Write-Host "🔧 Running database debug script..." -ForegroundColor Yellow
node debug-db.js

Write-Host ""
Write-Host "🚀 Starting server..." -ForegroundColor Green
Write-Host ""
node server.js 