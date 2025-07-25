# MEGASheep File Protection System (PowerShell)
# Automatically restores critical files if they go missing

param(
    [switch]$ForceBackup,
    [switch]$CheckOnly
)

# Critical files that must never be lost
$CriticalFiles = @(
    "public\host.html",
    "public\grading-single.html"
)

# Backup directory
$BackupDir = "backups"

Write-Host "🛡️  MEGASheep File Protection System" -ForegroundColor Cyan
Write-Host "=" * 50 -ForegroundColor Cyan

# Ensure backup directory exists
if (!(Test-Path $BackupDir)) {
    New-Item -ItemType Directory -Path $BackupDir | Out-Null
    Write-Host "📁 Created backup directory: $BackupDir" -ForegroundColor Green
}

$RestoredCount = 0

foreach ($file in $CriticalFiles) {
    if (!(Test-Path $file)) {
        Write-Host "🚨 CRITICAL: $file is missing!" -ForegroundColor Red
        
        $restored = $false
        
        # Try to restore from git first
        try {
            Write-Host "🔄 Attempting to restore $file from git..." -ForegroundColor Yellow
            git checkout HEAD -- $file
            if (Test-Path $file) {
                Write-Host "✅ Successfully restored $file from git" -ForegroundColor Green
                $restored = $true
                $RestoredCount++
            }
        }
        catch {
            Write-Host "❌ Git restore failed: $($_.Exception.Message)" -ForegroundColor Red
        }
        
        # If git failed, try backup files
        if (!$restored) {
            $backupFile = "$BackupDir\$($(Split-Path $file -Leaf)).backup"
            if (Test-Path $backupFile) {
                try {
                    Write-Host "🔄 Attempting to restore $file from backup..." -ForegroundColor Yellow
                    Copy-Item $backupFile $file -Force
                    Write-Host "✅ Successfully restored $file from backup" -ForegroundColor Green
                    $restored = $true
                    $RestoredCount++
                }
                catch {
                    Write-Host "❌ Backup restore failed: $($_.Exception.Message)" -ForegroundColor Red
                }
            }
        }
        
        if (!$restored) {
            Write-Host "💀 CRITICAL ERROR: Could not restore $file" -ForegroundColor Red
            exit 1
        }
    }
    else {
        Write-Host "✅ $file exists" -ForegroundColor Green
    }
}

if ($RestoredCount -gt 0) {
    Write-Host "🎉 Restored $RestoredCount critical files" -ForegroundColor Green
}

# Create fresh backups (unless CheckOnly is specified)
if (!$CheckOnly -or $ForceBackup) {
    Write-Host "📦 Creating fresh backups..." -ForegroundColor Cyan
    
    foreach ($file in $CriticalFiles) {
        if (Test-Path $file) {
            $backupFile = "$BackupDir\$($(Split-Path $file -Leaf)).backup"
            try {
                Copy-Item $file $backupFile -Force
                Write-Host "✅ Backed up $file" -ForegroundColor Green
            }
            catch {
                Write-Host "❌ Failed to backup $file : $($_.Exception.Message)" -ForegroundColor Red
            }
        }
        else {
            Write-Host "⚠️  Warning: $file doesn't exist, can't backup" -ForegroundColor Yellow
        }
    }
}

Write-Host "🛡️  Protection system complete" -ForegroundColor Cyan 