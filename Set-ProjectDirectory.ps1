# MEGASheep Project Directory Setter
# Run this script to ensure you're in the correct project directory

$projectPath = "C:\Users\liqui\MEGASheep"

if (Test-Path $projectPath) {
    Set-Location $projectPath
    Write-Host "✅ Now in MEGASheep project directory: $(Get-Location)" -ForegroundColor Green
    Write-Host "🚀 Ready to run: nodemon server.js" -ForegroundColor Cyan
} else {
    Write-Host "❌ Project directory not found: $projectPath" -ForegroundColor Red
} 