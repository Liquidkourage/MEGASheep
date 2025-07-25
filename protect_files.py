#!/usr/bin/env python3
"""
MEGASheep File Protection System
Automatically restores critical files if they go missing
"""

import os
import shutil
import sys
from pathlib import Path

# Critical files that must never be lost
CRITICAL_FILES = [
    'public/host.html',
    'public/grading-single.html'
]

# Backup locations (in order of preference)
BACKUP_LOCATIONS = [
    'backups/host.html.backup',
    'backups/grading-single.html.backup'
]

def check_and_restore_files():
    """Check if critical files exist and restore them if missing"""
    restored_count = 0
    
    for critical_file in CRITICAL_FILES:
        if not os.path.exists(critical_file):
            print(f"🚨 CRITICAL: {critical_file} is missing!")
            
            # Try to restore from backups
            restored = False
            
            # Try git first
            try:
                print(f"🔄 Attempting to restore {critical_file} from git...")
                os.system(f'git checkout HEAD -- {critical_file}')
                if os.path.exists(critical_file):
                    print(f"✅ Successfully restored {critical_file} from git")
                    restored = True
                    restored_count += 1
            except Exception as e:
                print(f"❌ Git restore failed: {e}")
            
            # If git failed, try backup files
            if not restored:
                backup_file = f"backups/{os.path.basename(critical_file)}.backup"
                if os.path.exists(backup_file):
                    try:
                        print(f"🔄 Attempting to restore {critical_file} from backup...")
                        shutil.copy2(backup_file, critical_file)
                        print(f"✅ Successfully restored {critical_file} from backup")
                        restored = True
                        restored_count += 1
                    except Exception as e:
                        print(f"❌ Backup restore failed: {e}")
            
            if not restored:
                print(f"💀 CRITICAL ERROR: Could not restore {critical_file}")
                return False
    
    if restored_count > 0:
        print(f"🎉 Restored {restored_count} critical files")
    
    return True

def create_backups():
    """Create fresh backups of critical files"""
    print("📦 Creating fresh backups...")
    
    for critical_file in CRITICAL_FILES:
        if os.path.exists(critical_file):
            backup_file = f"backups/{os.path.basename(critical_file)}.backup"
            try:
                shutil.copy2(critical_file, backup_file)
                print(f"✅ Backed up {critical_file}")
            except Exception as e:
                print(f"❌ Failed to backup {critical_file}: {e}")
        else:
            print(f"⚠️  Warning: {critical_file} doesn't exist, can't backup")

def main():
    """Main protection routine"""
    print("🛡️  MEGASheep File Protection System")
    print("=" * 50)
    
    # Ensure backups directory exists
    os.makedirs('backups', exist_ok=True)
    
    # Check and restore files
    if check_and_restore_files():
        print("✅ All critical files are present")
        
        # Create fresh backups
        create_backups()
        
        print("🛡️  Protection system complete")
        return True
    else:
        print("💀 CRITICAL ERROR: Some files could not be restored")
        return False

if __name__ == "__main__":
    success = main()
    sys.exit(0 if success else 1) 