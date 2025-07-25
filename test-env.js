// Simple .env test script
console.log('🔍 Testing .env file reading...');

// Load dotenv
require('dotenv').config();

console.log('\n📄 Raw environment variables:');
console.log('SUPABASE_URL:', JSON.stringify(process.env.SUPABASE_URL));
console.log('SUPABASE_ANON_KEY:', process.env.SUPABASE_ANON_KEY ? 'SET (length: ' + process.env.SUPABASE_ANON_KEY.length + ')' : 'NOT SET');
console.log('PORT:', process.env.PORT);

// Check if the values look like real Supabase credentials
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_ANON_KEY;

if (url && key) {
    console.log('\n✅ Environment variables found!');
    console.log('URL format looks correct:', url.includes('supabase.co'));
    console.log('Key format looks correct:', key.startsWith('eyJ'));
    
    if (url.includes('supabase.co') && key.startsWith('eyJ')) {
        console.log('🎉 Supabase credentials appear valid!');
        
        // Test the connection
        console.log('\n🧪 Testing Supabase connection...');
        const { createClient } = require('@supabase/supabase-js');
        const supabase = createClient(url, key);
        
        supabase
            .from('questions')
            .select('count')
            .limit(1)
            .then(({ data, error }) => {
                if (error) {
                    console.log('❌ Database error:', error.message);
                    if (error.message.includes('relation "questions" does not exist')) {
                        console.log('💡 The questions table doesn\'t exist. You need to create it.');
                    }
                } else {
                    console.log('✅ Database connection successful!');
                }
            })
            .catch(err => {
                console.log('❌ Connection error:', err.message);
            });
    } else {
        console.log('⚠️  Credentials format looks incorrect');
    }
} else {
    console.log('\n❌ Environment variables not loaded properly');
    console.log('💡 This might be a file encoding issue');
} 