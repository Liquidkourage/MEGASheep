// Database Connection Debug Script
require('dotenv').config();

console.log('🔍 Database Connection Debug Script');
console.log('=====================================');

// Check if .env file exists
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
    console.log('✅ .env file found');
    console.log('📄 .env contents:');
    console.log(fs.readFileSync(envPath, 'utf8'));
} else {
    console.log('❌ .env file not found');
    console.log('💡 Creating .env file with template...');
    
    const envTemplate = `# Supabase Configuration
# Replace these placeholder values with your actual Supabase credentials
# Get these from: https://supabase.com/dashboard/project/[YOUR-PROJECT]/settings/api

SUPABASE_URL=https://your-project-id.supabase.co
SUPABASE_ANON_KEY=your_actual_anon_key_here

# Server Configuration
PORT=3001

# Instructions:
# 1. Go to https://supabase.com
# 2. Create a new project or use existing one
# 3. Go to Settings → API
# 4. Copy "Project URL" to SUPABASE_URL
# 5. Copy "anon public" key to SUPABASE_ANON_KEY
# 6. Save this file
# 7. Run: node server.js`;
    
    fs.writeFileSync(envPath, envTemplate);
    console.log('✅ .env file created with template');
}

console.log('\n🔧 Environment Variables:');
console.log('SUPABASE_URL:', process.env.SUPABASE_URL || 'NOT SET');
console.log('SUPABASE_ANON_KEY:', process.env.SUPABASE_ANON_KEY ? 'SET (hidden)' : 'NOT SET');
console.log('PORT:', process.env.PORT || '3001 (default)');

// Test Supabase connection if credentials are set
if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY && 
    process.env.SUPABASE_URL !== 'https://your-project-id.supabase.co' &&
    process.env.SUPABASE_ANON_KEY !== 'your_actual_anon_key_here') {
    
    console.log('\n🧪 Testing Supabase connection...');
    
    const { createClient } = require('@supabase/supabase-js');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
    
    // Test connection by trying to access the questions table
    supabase
        .from('questions')
        .select('count')
        .limit(1)
        .then(({ data, error }) => {
            if (error) {
                console.log('❌ Supabase connection failed:', error.message);
                console.log('💡 Make sure your credentials are correct and the questions table exists');
            } else {
                console.log('✅ Supabase connection successful!');
                console.log('📊 Questions table accessible');
            }
        })
        .catch(err => {
            console.log('❌ Supabase connection error:', err.message);
        });
} else {
    console.log('\n⚠️  Supabase credentials not properly configured');
    console.log('💡 Update your .env file with real Supabase credentials');
    console.log('🎮 Demo mode will be used instead');
}

console.log('\n🚀 Next steps:');
console.log('1. If you want to use Supabase: Update .env with real credentials');
console.log('2. If you want to use demo mode: Run "node server.js"');
console.log('3. Test the system: Open http://localhost:3001'); 