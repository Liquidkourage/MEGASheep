Set-Location "C:\Users\liqui\MEGASheep"
Write-Host "Starting MEGASheep server in: $(Get-Location)" -ForegroundColor Green
nodemon server.js 