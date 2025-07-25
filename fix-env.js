// Fix .env file encoding and recreate it
const fs = require('fs');
const path = require('path');

console.log('🔧 Fixing .env file...');

// Your actual Supabase credentials (from what you showed)
const supabaseUrl = 'https://vyypmqkngcltf.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ5eXBtcWtuZ2NsdGYiLCJyb2xlIjoiYW5vbiIsImlhdCI6MTc1MzAxOTQxNCwiZXhwIjoyMDY4NTk1NDE0fQ.lI0KgtQ4MLkAFnzYe72sLMoLcR9v1rVsBzppMtD2qOg';

// Create new .env file with proper encoding
const envContent = `# Supabase Configuration
SUPABASE_URL=${supabaseUrl}
SUPABASE_ANON_KEY=${supabaseKey}

# Server Configuration
PORT=3001

# Created by fix-env.js script
`;

const envPath = path.join(__dirname, '.env');

try {
    // Write the file with UTF-8 encoding
    fs.writeFileSync(envPath, envContent, 'utf8');
    console.log('✅ .env file recreated successfully');
    console.log('📄 New .env contents:');
    console.log(fs.readFileSync(envPath, 'utf8'));
    
    // Test if it loads properly
    console.log('\n🧪 Testing .env loading...');
    require('dotenv').config();
    
    console.log('SUPABASE_URL:', process.env.SUPABASE_URL ? 'SET' : 'NOT SET');
    console.log('SUPABASE_ANON_KEY:', process.env.SUPABASE_ANON_KEY ? 'SET' : 'NOT SET');
    
    if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
        console.log('🎉 Environment variables loaded successfully!');
    } else {
        console.log('❌ Environment variables still not loading');
    }
    
} catch (error) {
    console.error('❌ Error creating .env file:', error.message);
} 