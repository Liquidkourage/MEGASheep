# 🛡️ MEGASheep File Protection System

## Overview
This system prevents the loss of critical files (`host.html` and `grading-single.html`) that have been accidentally deleted multiple times, costing days of work.

## Protection Layers

### 1. **Automatic Backup System**
- Critical files are automatically backed up to `backups/` directory
- Backups are updated whenever protection scripts run

### 2. **Git Pre-commit Hook**
- Prevents commits that would delete critical files
- Located at `.git/hooks/pre-commit`
- **BYPASS**: Use `git commit --no-verify` if you really need to delete

### 3. **Automatic Restoration Scripts**
- **Python**: `protect_files.py`
- **PowerShell**: `protect_files.ps1`

## Usage

### Quick Check & Restore
```bash
# Python (works on all platforms)
python protect_files.py

# PowerShell (Windows)
.\protect_files.ps1
```

### Check Only (no backup creation)
```bash
# PowerShell
.\protect_files.ps1 -CheckOnly
```

### Force Fresh Backups
```bash
# PowerShell
.\protect_files.ps1 -ForceBackup
```

## What Happens When Files Go Missing

1. **Detection**: Script detects missing critical files
2. **Git Restore**: Attempts to restore from git history
3. **Backup Restore**: If git fails, restores from local backups
4. **Error**: If both fail, shows critical error and exits

## Critical Files Protected
- `public/host.html` - Main host interface
- `public/grading-single.html` - Single-user grading interface

## Manual Recovery Commands

If files go missing, you can manually restore them:

```bash
# From git
git checkout HEAD -- public/host.html public/grading-single.html

# From backups
copy backups\host.html.backup public\host.html
copy backups\grading-single.html.backup public\grading-single.html
```

## Prevention Tips

1. **Run protection script before commits**: `python protect_files.py`
2. **Never use `git add .` blindly** - check what you're adding
3. **Use the pre-commit hook** - it will warn you about deletions
4. **Keep backups updated** - run protection script regularly

## Emergency Recovery

If all else fails:
1. Check git history: `git log --oneline --follow public/host.html`
2. Restore from specific commit: `git checkout <commit-hash> -- public/host.html`
3. Check remote repository for the files

## File Status Check

To quickly check if critical files exist:
```bash
ls public/host.html public/grading-single.html
```

## Automatic Integration

Consider adding protection script to your workflow:
- Before commits
- After pulls
- As a scheduled task
- In your IDE's pre-save hooks

---

**Remember**: This system is here because these files have been lost multiple times. Use it regularly to prevent future losses! 