// Comprehensive connection test script
console.log('🌐 Testing network connectivity to Supabase...');

// Load environment variables
require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_ANON_KEY;

console.log('📡 Supabase URL:', url);
console.log('🔑 Key length:', key ? key.length : 'NOT SET');

if (!url || !key) {
    console.log('❌ Missing credentials');
    process.exit(1);
}

// Test 1: Basic network connectivity
console.log('\n🔍 Test 1: Basic network connectivity...');
const https = require('https');

const testBasicConnectivity = () => {
    return new Promise((resolve, reject) => {
        const req = https.request(url, { method: 'GET' }, (res) => {
            console.log('✅ Basic connectivity: HTTP', res.statusCode);
            resolve(true);
        });
        
        req.on('error', (err) => {
            console.log('❌ Basic connectivity failed:', err.message);
            reject(err);
        });
        
        req.setTimeout(10000, () => {
            console.log('❌ Basic connectivity timeout');
            req.destroy();
            reject(new Error('Timeout'));
        });
        
        req.end();
    });
};

// Test 2: Supabase client connection
console.log('\n🔍 Test 2: Supabase client connection...');
const testSupabaseConnection = async () => {
    try {
        const supabase = createClient(url, key);
        
        // Test with a simple query
        const { data, error } = await supabase
            .from('questions')
            .select('count')
            .limit(1);
            
        if (error) {
            if (error.message.includes('relation "questions" does not exist')) {
                console.log('✅ Supabase connection successful!');
                console.log('💡 The questions table doesn\'t exist yet - this is normal');
                return true;
            } else {
                console.log('❌ Supabase query error:', error.message);
                return false;
            }
        } else {
            console.log('✅ Supabase connection and query successful!');
            return true;
        }
    } catch (err) {
        console.log('❌ Supabase connection error:', err.message);
        
        // Check for specific error types
        if (err.message.includes('fetch failed')) {
            console.log('💡 This is a network connectivity issue');
            console.log('🔧 Possible solutions:');
            console.log('   1. Check your internet connection');
            console.log('   2. Check if your firewall is blocking the connection');
            console.log('   3. Try using a different network');
            console.log('   4. Check if Supabase is accessible from your location');
        }
        
        return false;
    }
};

// Test 3: Alternative connection method
console.log('\n🔍 Test 3: Alternative connection method...');
const testAlternativeConnection = async () => {
    try {
        const supabase = createClient(url, key, {
            auth: {
                autoRefreshToken: false,
                persistSession: false
            }
        });
        
        // Try a different endpoint
        const { data, error } = await supabase
            .rpc('version');
            
        if (error) {
            console.log('❌ Alternative connection failed:', error.message);
            return false;
        } else {
            console.log('✅ Alternative connection successful!');
            return true;
        }
    } catch (err) {
        console.log('❌ Alternative connection error:', err.message);
        return false;
    }
};

// Run all tests
async function runTests() {
    try {
        console.log('🚀 Starting connection tests...\n');
        
        // Test 1
        await testBasicConnectivity();
        
        // Test 2
        const supabaseWorks = await testSupabaseConnection();
        
        // Test 3 (only if Test 2 failed)
        if (!supabaseWorks) {
            await testAlternativeConnection();
        }
        
        console.log('\n📋 Summary:');
        if (supabaseWorks) {
            console.log('✅ Supabase connection is working!');
            console.log('🎉 You can now use the database features');
        } else {
            console.log('❌ Supabase connection issues detected');
            console.log('💡 Try the demo mode for now: node server.js');
        }
        
    } catch (error) {
        console.log('\n❌ Test failed:', error.message);
    }
}

runTests(); 