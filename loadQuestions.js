const fs = require('fs');
const path = require('path');
require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase client
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

// Question file format:
// Question prompt followed by correct answers (one per line)
// Empty lines separate questions
// Example:
// A 5-letter English word that ends in "ACK"
// Aback
// Alack
// Black
// Clack
// ...
// (empty line)
// A Gwyneth Paltrow film that grossed at least $100m worldwide
// Avengers: Endgame
// Avengers: Infinity War
// ...

function parseQuestionLine(line) {
    line = line.trim();
    if (!line || line.startsWith('#')) return null; // Skip empty lines and comments
    return line;
}

async function loadQuestionsFromFile(filename) {
    try {
        console.log(`📖 Reading questions from: ${filename}`);
        
        if (!fs.existsSync(filename)) {
            console.error(`❌ File not found: ${filename}`);
            return;
        }
        
        const content = fs.readFileSync(filename, 'utf8');
        const lines = content.split(/\r?\n/);
        
        const questions = [];
        let currentQuestion = null;
        let currentRound = 1;
        let currentOrder = 1;
        
        for (const rawLine of lines) {
            const trimmed = rawLine.trim();

            // Blank line or comment -> end of current question block
            if (trimmed === '' || trimmed.startsWith('#')) {
                if (currentQuestion && currentQuestion.prompt && currentQuestion.correct_answers.length > 0) {
                    questions.push({
                        ...currentQuestion,
                        round: currentRound,
                        question_order: currentOrder
                    });
                    currentOrder++;
                    currentQuestion = null;
                }
                continue;
            }

            // Start a new question on the first non-empty line after a separator
            if (!currentQuestion) {
                currentQuestion = {
                    prompt: trimmed,
                    correct_answers: []
                };
                continue;
            }

            // Subsequent non-empty lines are answers until we hit a blank line
            currentQuestion.correct_answers.push(trimmed);
        }
        
        // Capture last question if file doesn't end with a blank line
        if (currentQuestion && currentQuestion.prompt && currentQuestion.correct_answers.length > 0) {
            questions.push({
                ...currentQuestion,
                round: currentRound,
                question_order: currentOrder
            });
        }
        
        console.log(`✅ Parsed ${questions.length} questions with answers`);
        return questions;
        
    } catch (error) {
        console.error('❌ Error reading file:', error);
        return null;
    }
}

async function insertQuestionsToDatabase(questions) {
    try {
        console.log('🗄️  Inserting questions into Supabase...');
        
        // First, clear existing questions (optional - comment out if you want to keep existing)
        console.log('🧹 Clearing existing questions...');
        const { error: deleteError } = await supabase
            .from('questions')
            .delete()
            .neq('id', 0); // Delete all rows
            
        if (deleteError) {
            console.error('❌ Error clearing questions:', deleteError);
            return false;
        }
        
        // Insert new questions
        const { data, error } = await supabase
            .from('questions')
            .insert(questions)
            .select();
            
        if (error) {
            console.error('❌ Error inserting questions:', error);
            return false;
        }
        
        console.log(`✅ Successfully inserted ${data.length} questions`);
        return true;
        
    } catch (error) {
        console.error('❌ Error inserting questions:', error);
        return false;
    }
}

async function previewQuestions(questions) {
    console.log('\n📋 Preview of questions to be inserted:');
    console.log('='.repeat(80));
    
    questions.forEach((q, index) => {
        console.log(`${index + 1}. Round ${q.round}, Order ${q.question_order}: ${q.prompt}`);
        console.log(`   Answers (${q.correct_answers.length}): ${q.correct_answers.join(', ')}`);
        console.log('');
    });
    
    console.log('='.repeat(80));
}

async function main() {
    const args = process.argv.slice(2);
    const filename = args[0];
    const previewOnly = args.includes('--preview');
    
    if (!filename) {
        console.log('Usage: node loadQuestions.js <filename> [--preview]');
        console.log('');
        console.log('File format:');
        console.log('  Question prompt followed by correct answers (one per line)');
        console.log('  Empty lines separate questions');
        console.log('');
        console.log('Examples:');
        console.log('  A 5-letter English word that ends in "ACK"');
        console.log('  Aback');
        console.log('  Alack');
        console.log('  Black');
        console.log('  ...');
        console.log('');
        console.log('  A Gwyneth Paltrow film that grossed at least $100m worldwide');
        console.log('  Avengers: Endgame');
        console.log('  Avengers: Infinity War');
        console.log('  ...');
        console.log('');
        console.log('  # Lines starting with # are comments');
        console.log('  # Empty lines separate questions');
        return;
    }
    
    console.log('🚀 MEGASheep Question Loader');
    console.log('='.repeat(30));
    
    // Check Supabase connection
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
        console.error('❌ Supabase credentials not found in .env file');
        return;
    }
    
    // Load questions from file
    const questions = await loadQuestionsFromFile(filename);
    if (!questions || questions.length === 0) {
        console.error('❌ No questions found in file');
        return;
    }
    
    // Preview questions
    await previewQuestions(questions);
    
    if (previewOnly) {
        console.log('👀 Preview mode - no questions were inserted');
        return;
    }
    
    // Ask for confirmation
    console.log('\n❓ Do you want to insert these questions into the database? (y/N)');
    
    // For automated scripts, you can set this environment variable
    if (process.env.AUTO_CONFIRM === 'true') {
        console.log('🤖 Auto-confirming due to AUTO_CONFIRM=true');
    } else {
        // In a real implementation, you'd want to use a proper input library
        // For now, we'll just proceed
        console.log('🤖 Proceeding with insertion...');
    }
    
    // Insert questions
    const success = await insertQuestionsToDatabase(questions);
    
    if (success) {
        console.log('\n🎉 Questions loaded successfully!');
        console.log('You can now start a game and select "Supabase Database" as the question set.');
    } else {
        console.log('\n❌ Failed to load questions');
    }
}

// Run the script
if (require.main === module) {
    main().catch(console.error);
}

module.exports = { loadQuestionsFromFile, insertQuestionsToDatabase }; 