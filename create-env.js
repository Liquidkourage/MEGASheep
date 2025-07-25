// Create .env file with your Supabase credentials
const fs = require('fs');
const path = require('path');

console.log('🔧 Creating .env file with your Supabase credentials...');

// Your actual Supabase credentials (from what you showed earlier)
const supabaseUrl = 'https://vyypmqkngcltf.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ5eXBtcWtuZ2NsdGYiLCJyb2xlIjoiYW5vbiIsImlhdCI6MTc1MzAxOTQxNCwiZXhwIjoyMDY4NTk1NDE0fQ.lI0KgtQ4MLkAFnzYe72sLMoLcR9v1rVsBzppMtD2qOg';

// Create the .env content
const envContent = `# Supabase Configuration
SUPABASE_URL=${supabaseUrl}
SUPABASE_ANON_KEY=${supabaseKey}

# Server Configuration
PORT=3001

# Created by create-env.js script
# Your Supabase project: vyypmqkngcltf
`;

const envPath = path.join(__dirname, '.env');

try {
    // Write the file with UTF-8 encoding
    fs.writeFileSync(envPath, envContent, 'utf8');
    console.log('✅ .env file created successfully!');
    console.log('📄 File location:', envPath);
    
    // Verify the file was created
    if (fs.existsSync(envPath)) {
        console.log('✅ File exists and is readable');
        
        // Test loading the environment variables
        console.log('\n🧪 Testing environment variable loading...');
        require('dotenv').config();
        
        console.log('SUPABASE_URL:', process.env.SUPABASE_URL ? 'SET' : 'NOT SET');
        console.log('SUPABASE_ANON_KEY:', process.env.SUPABASE_ANON_KEY ? 'SET (length: ' + process.env.SUPABASE_ANON_KEY.length + ')' : 'NOT SET');
        console.log('PORT:', process.env.PORT);
        
        if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
            console.log('🎉 Environment variables loaded successfully!');
        } else {
            console.log('❌ Environment variables not loading properly');
        }
    } else {
        console.log('❌ File was not created');
    }
    
} catch (error) {
    console.error('❌ Error creating .env file:', error.message);
}

console.log('\n🚀 Next steps:');
console.log('1. Run: node start-server.js');
console.log('2. Or run: node server.js');
console.log('3. Open: http://localhost:3001'); 