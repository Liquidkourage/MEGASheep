@echo off
echo 🔍 MEGASheep Database Debug & Startup
echo ======================================

cd /d "C:\Users\liqui\MEGASheep"

echo.
echo 📁 Current directory: %CD%
echo.

echo 🔧 Running database debug script...
node debug-db.js

echo.
echo 🚀 Starting server...
echo.
node server.js

pause 