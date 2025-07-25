@echo off
echo Starting MEGASheep Server...
echo.
echo Installing dependencies if needed...
call npm install
echo.
echo Starting server on port 3001...
echo Visit http://localhost:3001 to play!
echo.
node server.js
pause 