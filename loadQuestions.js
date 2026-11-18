const fs = require('fs');
const path = require('path');
require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');
const { postgresEnabled, initPostgres, replacePostgresQuestions } = require('./db');

const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY)
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
    : null;

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
        if (postgresEnabled()) {
            console.log('🗄️  Inserting questions into Railway Postgres...');
            await initPostgres();
            await replacePostgresQuestions(questions);
            console.log(`✅ Successfully inserted ${questions.length} questions`);
            return true;
        }
        if (!supabase) {
            console.error('❌ No DATABASE_URL or Supabase credentials');
            return false;
        }
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
    const confirmReplace = args.includes('--confirm') || process.env.AUTO_CONFIRM === 'true';
    
    if (!filename) {
        console.log('Usage: node loadQuestions.js <filename> [--preview|--confirm]');
        console.log('  --preview  Parse and print only');
        console.log('  --confirm  REPLACE the entire question bank with this file');
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
    
    if (!postgresEnabled() && (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY)) {
        console.error('❌ Set DATABASE_URL (Railway Postgres) or Supabase credentials in .env');
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
    
    if (previewOnly || !confirmReplace) {
        console.log(previewOnly
            ? '👀 Preview mode - no questions were inserted'
            : '👀 Preview only. Re-run with --confirm to REPLACE the entire question bank.');
        return;
    }

    console.log('\n⚠️  This replaces EVERY question in the database.');
    if (process.env.AUTO_CONFIRM === 'true') {
        console.log('🤖 Auto-confirming due to AUTO_CONFIRM=true');
    }
    
    // Insert questions
    const success = await insertQuestionsToDatabase(questions);
    
    if (success) {
        console.log('\n🎉 Questions loaded successfully!');
        console.log('You can now start a game with the show question set.');
    } else {
        console.log('\n❌ Failed to load questions');
    }
}

// Run the script
if (require.main === module) {
    main().catch(console.error);
}

module.exports = { loadQuestionsFromFile, insertQuestionsToDatabase }; 