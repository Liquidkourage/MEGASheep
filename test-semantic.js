import fetch from 'node-fetch';

async function testSemanticMatch() {
    console.log('🧪 Testing Semantic Matcher Service...\n');
    
    const testData = {
        question: "What is your Chinese zodiac sign?",
        correct_answers: ["rat", "ox", "tiger", "rabbit", "dragon", "snake", "horse", "goat", "monkey", "rooster", "dog", "pig"],
        responses: ["mouse", "bull", "feline", "cat", "horse", "sheep", "chicken", "canine"]
    };

    console.log('📝 Question:', testData.question);
    console.log('✅ Correct Answers:', testData.correct_answers);
    console.log('📋 Student Responses:', testData.responses);
    console.log('\n🔄 Calling semantic matcher service...\n');

    try {
        const res = await fetch('http://localhost:5005/semantic-match', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(testData)
        });

        if (!res.ok) {
            throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        }

        const data = await res.json();
        
        console.log('📊 Results:');
        console.log('==========');
        
        data.results.forEach((result, index) => {
            const confidence = result.confidence;
            const match = result.best_match;
            const response = result.response;
            
            let status = '❌ No Match';
            if (confidence >= 80) {
                status = '✅ High Confidence';
            } else if (confidence >= 50) {
                status = '⚠️  Medium Confidence';
            } else if (confidence > 0) {
                status = '❓ Low Confidence';
            }
            
            console.log(`${index + 1}. "${response}"`);
            console.log(`   Match: ${match || 'None'}`);
            console.log(`   Confidence: ${confidence}%`);
            console.log(`   Status: ${status}\n`);
        });

        // Auto-categorization simulation
        console.log('🎯 Auto-Categorization Simulation:');
        console.log('================================');
        
        const categorized = {
            correct: [],
            uncategorized: []
        };

        data.results.forEach(result => {
            if (result.confidence >= 80 && result.best_match) {
                categorized.correct.push({
                    response: result.response,
                    matchedTo: result.best_match,
                    confidence: result.confidence
                });
            } else {
                categorized.uncategorized.push({
                    response: result.response,
                    confidence: result.confidence
                });
            }
        });

        console.log('✅ Auto-Categorized (≥80% confidence):');
        categorized.correct.forEach(item => {
            console.log(`   - "${item.response}" → "${item.matchedTo}" (${item.confidence}%)`);
        });

        console.log('\n📦 Uncategorized (<80% confidence):');
        categorized.uncategorized.forEach(item => {
            console.log(`   - "${item.response}" (${item.confidence}%)`);
        });

    } catch (error) {
        console.error('❌ Error:', error.message);
        console.log('\n💡 Make sure the Python semantic matcher service is running:');
        console.log('   python semantic_matcher.py');
    }
}

testSemanticMatch(); 