@echo off
echo 🔍 MEGASheep Database Debug and Fix
echo ====================================

cd /d "C:\Users\liqui\MEGASheep"

echo.
echo 📁 Current directory: %CD%
echo.

echo 🔧 Step 1: Testing current .env file...
node test-env.js

echo.
echo 🔧 Step 2: Fixing .env file encoding...
node fix-env.js

echo.
echo 🔧 Step 3: Testing fixed .env file...
node test-env.js

echo.
echo 🚀 Step 4: Starting server...
echo.
node server.js

pause 