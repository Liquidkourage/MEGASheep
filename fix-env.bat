@echo off
echo 🔧 Fixing .env file and starting server...

REM Change to the correct directory
cd /d "C:\Users\liqui\MEGASheep"

REM Create the .env file with your Supabase credentials
echo # Supabase Configuration > .env
echo SUPABASE_URL=https://vyypmqkngcltf.supabase.co >> .env
echo SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ5eXBtcWtuZ2NsdGYiLCJyb2xlIjoiYW5vbiIsImlhdCI6MTc1MzAxOTQxNCwiZXhwIjoyMDY4NTk1NDE0fQ.lI0KgtQ4MLkAFnzYe72sLMoLcR9v1rVsBzppMtD2qOg >> .env
echo. >> .env
echo # Server Configuration >> .env
echo PORT=3001 >> .env

echo ✅ .env file created!

REM Test the environment variables
echo 🧪 Testing environment variables...
node -e "require('dotenv').config(); console.log('SUPABASE_URL:', process.env.SUPABASE_URL ? 'SET' : 'NOT SET'); console.log('SUPABASE_ANON_KEY:', process.env.SUPABASE_ANON_KEY ? 'SET' : 'NOT SET');"

REM Start the server
echo 🚀 Starting server...
node server.js

pause 