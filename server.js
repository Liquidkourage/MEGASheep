const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');
const { spawn } = require('child_process');
require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const fs = require('fs');
const fetch = require('node-fetch'); // Add at the top if not present

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  transports: ['websocket', 'polling'],
  allowEIO3: true,
  pingTimeout: 60000,
  pingInterval: 25000
});

// Python semantic matcher service management
let pythonSemanticService = null;
let semanticServiceReady = false;

function startPythonSemanticService() {
    console.log('🚀 Starting Python semantic matcher service...');
    
    // Check if semantic_matcher.py exists
    const semanticMatcherPath = path.join(__dirname, 'semantic_matcher.py');
    if (!fs.existsSync(semanticMatcherPath)) {
        console.log('⚠️  semantic_matcher.py not found - semantic matching will use fallback');
        return;
    }
    
    try {
        // Start the Python service
        pythonSemanticService = spawn('python', [semanticMatcherPath], {
            stdio: ['pipe', 'pipe', 'pipe'],
            detached: false
        });
        
        // Handle stdout
        pythonSemanticService.stdout.on('data', (data) => {
            const output = data.toString();
            console.log(`🐍 Python Service: ${output.trim()}`);
            
            // Check if service is ready
            if (output.includes('Running on http://127.0.0.1:5005')) {
                console.log('✅ Python semantic matcher service is ready!');
                semanticServiceReady = true;
            }
        });
        
        // Handle stderr
        pythonSemanticService.stderr.on('data', (data) => {
            const error = data.toString();
            console.log(`🐍 Python Service Error: ${error.trim()}`);
        });
        
        // Handle process exit
        pythonSemanticService.on('close', (code) => {
            console.log(`🐍 Python semantic service exited with code ${code}`);
            semanticServiceReady = false;
            
            // Restart after a delay if it wasn't intentionally stopped
            if (code !== 0) {
                console.log('🔄 Restarting Python semantic service in 5 seconds...');
                setTimeout(startPythonSemanticService, 5000);
            }
        });
        
        // Handle process errors
        pythonSemanticService.on('error', (error) => {
            console.error('❌ Failed to start Python semantic service:', error);
            semanticServiceReady = false;
        });
        
    } catch (error) {
        console.error('❌ Error starting Python semantic service:', error);
        semanticServiceReady = false;
    }
}

function stopPythonSemanticService() {
    if (pythonSemanticService) {
        console.log('🛑 Stopping Python semantic matcher service...');
        pythonSemanticService.kill('SIGTERM');
        semanticServiceReady = false;
    }
}

// Start Python service when server starts
startPythonSemanticService();

// Cleanup on server shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down server...');
    stopPythonSemanticService();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n🛑 Shutting down server...');
    stopPythonSemanticService();
    process.exit(0);
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Supabase configuration
let supabase = null;
let supabaseConfigured = false;

if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY && 
    process.env.SUPABASE_URL !== 'your_supabase_url_here' && 
    process.env.SUPABASE_ANON_KEY !== 'your_supabase_anon_key_here') {
    
    try {
        supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
            auth: {
                autoRefreshToken: true,
                persistSession: false
            },
            global: {
                headers: {
                    'X-Client-Info': 'megasheep-game'
                }
            }
        });
        
        supabase.from('questions').select('count').limit(1)
            .then(({ data, error }) => {
                if (error && error.message.includes('relation "questions" does not exist')) {
                    console.log('✅ Supabase configured successfully (table will be created when needed)');
                    supabaseConfigured = true;
                } else if (error) {
                    console.log('⚠️  Supabase connection issue:', error.message);
                    console.log('🔄 Falling back to demo mode');
                    supabase = null;
                    supabaseConfigured = false;
                } else {
                    console.log('✅ Supabase configured and connected successfully');
                    supabaseConfigured = true;
                }
            })
            .catch(err => {
                console.log('⚠️  Supabase connection failed:', err.message);
                if (err.message.includes('fetch failed') || err.message.includes('network') || err.message.includes('ENOTFOUND')) {
                    console.log('🌐 Network issue detected - this is common on public WiFi');
                    console.log('🔄 Falling back to demo mode due to network restrictions');
                } else {
                    console.log('🔄 Falling back to demo mode');
                }
                supabase = null;
                supabaseConfigured = false;
            });
    } catch (error) {
        console.log('⚠️  Supabase configuration error:', error.message);
        console.log('🔄 Falling back to demo mode');
        supabase = null;
        supabaseConfigured = false;
    }
} else {
    console.log('⚠️  Supabase not configured - running in demo mode with sample questions');
}

// Game state management
const activeGames = new Map(); // Map of gameCode -> Game
const connectedPlayers = new Map(); // Map of socketId -> PlayerInfo
const activeGameCodes = new Set(); // Track active 4-digit codes

// Generate unique 4-digit game code
function generateGameCode() {
    let code;
    do {
        code = Math.floor(1000 + Math.random() * 9000).toString();
    } while (activeGameCodes.has(code));
    
    activeGameCodes.add(code);
    console.log(`🎮 Generated new game code: ${code}`);
    return code;
}

// Game management class
class Game {
  constructor(hostId, gameCode = null) {
    this.hostId = hostId;
        this.gameCode = gameCode || generateGameCode();
        this.players = new Map(); // socketId -> playerData
    this.currentRound = 0;
    this.currentQuestion = 0;
    this.questions = [];
        this.gameState = 'waiting'; // waiting, playing, scoring, grading, roundComplete, finished
        this.answers = new Map(); // socketId -> answer
        this.scores = new Map(); // socketId -> score
        this.roundHistory = [];
        this.createdAt = Date.now();
    this.settings = {
      questionSet: 'supabase',
      timerDuration: 180,
              maxPlayers: 0,
      questionsPerRound: 5
    };
    this.timeLeft = 180;
    this.timerInterval = null;
    this.isTestMode = false;
        this.currentAnswerGroups = [];
        this.categorizationData = null;
        this.pointsForCurrentQuestion = new Map(); // socketId -> points for current question only
        this.currentQuestionScored = false; // Track if current question has been scored
    }

    addPlayer(socketId, playerName) {
        if (this.settings.maxPlayers > 0 && this.players.size >= this.settings.maxPlayers) {
            throw new Error('Game is full');
        }
        
        // Check for duplicate names (but allow same player to reconnect)
        const existingPlayer = Array.from(this.players.values()).find(p => p.name === playerName);
        if (existingPlayer && existingPlayer.id !== socketId) {
            // Check if the existing player is still connected
            const existingPlayerInfo = connectedPlayers.get(existingPlayer.id);
            if (existingPlayerInfo && existingPlayerInfo.playerName === playerName) {
                throw new Error('Player name already taken');
            } else {
                // Remove the disconnected player with same name
                this.removePlayer(existingPlayer.id);
            }
        }
        
        // If player already exists with same socket ID, just update
        if (this.players.has(socketId)) {
            console.log(`👤 Player ${playerName} already in game ${this.gameCode}, updating connection`);
            return;
        }
        
        this.players.set(socketId, {
            id: socketId,
      name: playerName,
      score: 0,
      answers: []
    });
        this.scores.set(socketId, 0);
        
        console.log(`👤 Player ${playerName} added to game ${this.gameCode}`);
    }

    removePlayer(socketId) {
        const player = this.players.get(socketId);
        if (player) {
            this.players.delete(socketId);
            this.scores.delete(socketId);
            this.answers.delete(socketId);
            console.log(`👤 Player ${player.name} removed from game ${this.gameCode}`);
        }
    }

    addVirtualPlayer(playerId, playerName) {
        if (this.settings.maxPlayers > 0 && this.players.size >= this.settings.maxPlayers) {
            throw new Error('Game is full');
        }
        
        // Check for duplicate names (but allow same player to reconnect)
        const existingPlayer = Array.from(this.players.values()).find(p => p.name === playerName);
        if (existingPlayer && existingPlayer.id !== playerId) {
            // Check if the existing player is still connected
            const existingPlayerInfo = connectedPlayers.get(existingPlayer.id);
            if (existingPlayerInfo && existingPlayerInfo.playerName === playerName) {
                throw new Error('Player name already taken');
            } else {
                // Remove the disconnected player with same name
                this.removePlayer(existingPlayer.id);
            }
        }
        
        // If player already exists with same ID, just update
        if (this.players.has(playerId)) {
            console.log(`🎭 Virtual player ${playerName} already in game ${this.gameCode}, updating connection`);
            return;
        }
        
        this.players.set(playerId, {
            id: playerId,
            name: playerName,
            score: 0,
            answers: [],
            isVirtual: true
        });
        this.scores.set(playerId, 0);
        
        console.log(`🎭 Virtual player ${playerName} added to game ${this.gameCode}`);
    }

    submitAnswer(socketId, answer) {
        if (this.gameState !== 'playing') return false;
        
        this.answers.set(socketId, answer.trim());
        const player = this.players.get(socketId);
        if (player) {
            console.log(`📝 ${player.name} submitted answer: ${answer}`);
        }
        return true;
  }

  calculateScores() {
    const totalResponses = this.answers.size;
    console.log(`📊 calculateScores called with ${totalResponses} answers`);
    if (totalResponses === 0) {
      console.log('⚠️ No answers to calculate scores for');
      return;
    }
    
    // If we have categorization data from grading, use that for scoring
    if (this.categorizationData && (this.categorizationData.correctAnswerBuckets || this.categorizationData.wrong || this.categorizationData.uncategorized)) {
      console.log(`📊 Using categorization data for scoring`);
      this.calculateScoresFromCategorization();
      return;
    }
    
    // Otherwise, use simple text normalization (fallback)
    console.log(`📊 Using simple text normalization for scoring (no categorization data)`);
    
    // Group answers by normalized text
    const answerGroups = new Map();
    
    for (const [socketId, answer] of this.answers) {
      const normalizedAnswer = answer.toLowerCase().trim();
      console.log(`📝 Processing answer: "${answer}" (normalized: "${normalizedAnswer}") from socket ${socketId}`);
      if (!answerGroups.has(normalizedAnswer)) {
        answerGroups.set(normalizedAnswer, []);
      }
      answerGroups.get(normalizedAnswer).push(socketId);
    }
    
    this.calculateScoresFromGroups(answerGroups, totalResponses);
  }

  calculateScoresFromCategorization() {
    const totalResponses = this.answers.size;
    const categorizationData = this.categorizationData;
    
    console.log(`📊 Calculating scores from categorization data`);
    console.log(`📊 Categorization data:`, categorizationData);
    
    // Create a map of answer groups based on categorization
    const answerGroups = new Map();
    
    // Process correct answer buckets
    if (categorizationData.correctAnswerBuckets && Array.isArray(categorizationData.correctAnswerBuckets)) {
      for (const bucket of categorizationData.correctAnswerBuckets) {
        if (bucket.answers && Array.isArray(bucket.answers)) {
          // Group all answers in this bucket together
          const socketIds = [];
          for (const answerData of bucket.answers) {
            // Find the original answer group to get player names (case-insensitive)
            const originalGroup = this.currentAnswerGroups.find(group => 
              group.answer.toLowerCase().trim() === answerData.answer.toLowerCase().trim()
            );
            if (originalGroup && originalGroup.players) {
              // Find socket IDs for these players
              for (const playerName of originalGroup.players) {
                for (const [socketId, player] of this.players) {
                  if (player.name === playerName) {
                    socketIds.push(socketId);
                    break;
                  }
                }
              }
            }
          }
          
          if (socketIds.length > 0) {
            // Use the bucket ID as the group key for scoring purposes
            answerGroups.set(bucket.id, socketIds);
            console.log(`📊 Grouped bucket "${bucket.id}" with ${socketIds.length} players from answers: ${bucket.answers.map(a => a.answer).join(', ')}`);
          }
        }
      }
    }
    
    // Process wrong answers (each gets their own group)
    if (categorizationData.wrong && Array.isArray(categorizationData.wrong)) {
      for (const answerData of categorizationData.wrong) {
        const originalGroup = this.currentAnswerGroups.find(group => 
          group.answer.toLowerCase().trim() === answerData.answer.toLowerCase().trim()
        );
        if (originalGroup && originalGroup.players) {
          const socketIds = [];
          for (const playerName of originalGroup.players) {
            for (const [socketId, player] of this.players) {
              if (player.name === playerName) {
                socketIds.push(socketId);
                break;
              }
            }
          }
          if (socketIds.length > 0) {
            answerGroups.set(answerData.answer, socketIds);
            console.log(`📊 Wrong answer "${answerData.answer}" with ${socketIds.length} players`);
          }
        }
      }
    }
    
    // Process uncategorized answers (each gets their own group)
    if (categorizationData.uncategorized && Array.isArray(categorizationData.uncategorized)) {
      for (const answerData of categorizationData.uncategorized) {
        const originalGroup = this.currentAnswerGroups.find(group => 
          group.answer.toLowerCase().trim() === answerData.answer.toLowerCase().trim()
        );
        if (originalGroup && originalGroup.players) {
          const socketIds = [];
          for (const playerName of originalGroup.players) {
            for (const [socketId, player] of this.players) {
              if (player.name === playerName) {
                socketIds.push(socketId);
                break;
              }
            }
          }
          if (socketIds.length > 0) {
            answerGroups.set(answerData.answer, socketIds);
            console.log(`📊 Uncategorized answer "${answerData.answer}" with ${socketIds.length} players`);
          }
        }
      }
    }
    
    this.calculateScoresFromGroups(answerGroups, totalResponses);
  }

  calculateScoresFromGroups(answerGroups, totalResponses) {
    // Clear previous question points
    this.pointsForCurrentQuestion.clear();
    
    // Calculate points using Google Sheets formula: Z = Y/X rounded up
    for (const [answer, socketIds] of answerGroups) {
      const X = socketIds.length; // Number of responses matching this answer
      const Y = totalResponses;   // Total number of responses
      
      // Determine if this is a correct answer (bucket ID) or wrong/uncategorized
      const isCorrectAnswer = answer.startsWith('correct_');
      const Z = isCorrectAnswer ? Math.ceil(Y / X) : 0; // 0 points for wrong/uncategorized answers
      
      console.log(`📊 Answer "${answer}": ${X} players, ${Y} total responses, ${Z} points each (${isCorrectAnswer ? 'correct' : 'wrong/uncategorized'})`);
      
      // Store points for this question (but don't add to cumulative score yet)
      for (const socketId of socketIds) {
        this.pointsForCurrentQuestion.set(socketId, Z);
      }
    }
    
    // Store answer groups for display with original answer text
    this.currentAnswerGroups = [];
    
    // For each group, create entries with the original answer text for each player
    for (const [groupKey, socketIds] of answerGroups.entries()) {
      const X = socketIds.length;
      const Y = totalResponses;
      const Z = Math.ceil(Y / X);
      
      // If this is a bucket ID (starts with 'correct_'), find the original answers
      if (groupKey.startsWith('correct_') && this.categorizationData) {
        const bucket = this.categorizationData.correctAnswerBuckets.find(b => b.id === groupKey);
        if (bucket && bucket.answers) {
          // Create a separate entry for each original answer in this bucket
          for (const answerData of bucket.answers) {
            // Find which players had this specific answer
            const playersWithThisAnswer = socketIds.filter(socketId => {
              const player = this.players.get(socketId);
              if (!player) return false;
              
              // Check if this player's original answer matches
              const originalAnswer = this.answers.get(socketId);
              return originalAnswer && originalAnswer.toLowerCase().trim() === answerData.answer.toLowerCase().trim();
            });
            
            if (playersWithThisAnswer.length > 0) {
              this.currentAnswerGroups.push({
                answer: answerData.answer, // Use the original answer text
                count: playersWithThisAnswer.length,
                points: Z,
                totalResponses: Y,
                players: playersWithThisAnswer.map(id => {
                  const player = this.players.get(id);
                  return player ? player.name : 'Unknown';
                })
              });
            }
          }
        }
      } else {
        // For wrong/uncategorized answers, use the group key as the answer
        // Wrong and uncategorized answers always get 0 points
        this.currentAnswerGroups.push({
          answer: groupKey,
          count: X,
          points: 0, // Always 0 points for wrong/uncategorized answers
          totalResponses: Y,
          players: socketIds.map(id => {
            const player = this.players.get(id);
            return player ? player.name : 'Unknown';
          })
        });
      }
    }
    
    // Sort by points (highest first)
    this.currentAnswerGroups.sort((a, b) => b.points - a.points);
    
    console.log(`📊 Calculated scores for ${totalResponses} answers in ${answerGroups.size} groups`);
  }

  applyCurrentQuestionPoints() {
    if (this.currentQuestionScored) {
      console.log(`⚠️ Current question already scored, skipping duplicate scoring`);
      return;
    }
    
    console.log(`📊 Applying current question points to cumulative scores`);
    
    // Add current question points to cumulative scores
    for (const [socketId, points] of this.pointsForCurrentQuestion) {
      const currentScore = this.scores.get(socketId) || 0;
      const newScore = currentScore + points;
      this.scores.set(socketId, newScore);
      
      const player = this.players.get(socketId);
      if (player) {
        player.score = newScore;
        console.log(`📊 Player ${player.name}: ${currentScore} + ${points} = ${newScore}`);
      }
    }
    
    this.currentQuestionScored = true;
    console.log(`✅ Current question points applied to cumulative scores`);
  }

  resetQuestionScoring() {
    this.pointsForCurrentQuestion.clear();
    this.currentQuestionScored = false;
    this.currentAnswerGroups = [];
    this.categorizationData = null;
    console.log(`🔄 Reset question scoring state`);
  }

  getGameState() {
    return {
            gameCode: this.gameCode,
            hostId: this.hostId,
      players: Array.from(this.players.values()),
      currentRound: this.currentRound,
      currentQuestion: this.currentQuestion,
      currentQuestionData: this.questions[this.currentQuestion] || null,
      gameState: this.gameState,
      scores: Object.fromEntries(this.scores),
      questions: this.questions,
            currentAnswerGroups: this.currentAnswerGroups,
            categorizationData: this.categorizationData || null,
      timeLeft: this.timeLeft,
      roundHistory: this.roundHistory,
            questionsPerRound: this.settings.questionsPerRound,
            createdAt: this.createdAt,
            playerCount: this.players.size,
            isTestMode: this.isTestMode
        };
    }

  startTimer() {
    this.timeLeft = this.settings.timerDuration || 30;
        console.log(`⏰ Starting timer with ${this.timeLeft} seconds for game ${this.gameCode}`);
        
        // Clear any existing timer
        this.stopTimer();
    
    // Emit initial timer value
        io.to(this.gameCode).emit('timerUpdate', { timeLeft: this.timeLeft });
    
    this.timerInterval = setInterval(() => {
      this.timeLeft--;
      
            // Emit timer update
            io.to(this.gameCode).emit('timerUpdate', { timeLeft: this.timeLeft });
      
      if (this.timeLeft <= 0) {
        this.stopTimer();
                this.handleTimeUp();
      }
    }, 1000);
  }

  stopTimer() {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  }

    async handleTimeUp() {
        console.log(`⏰ Time up for game ${this.gameCode}`);
        
        if (this.gameState === 'playing') {
            console.log(`📊 Calculating scores for game ${this.gameCode} with ${this.answers.size} answers`);
            this.calculateScores();
            this.gameState = 'grading'; // Changed from 'scoring' to 'grading'
            
            console.log(`🎯 Game ${this.gameCode} moved to grading state with ${this.currentAnswerGroups?.length || 0} answer groups`);
            
            // Emit results requiring grading
            const gameStateToSend = this.getGameState();
            console.log('📤 Sending questionComplete from handleTimeUp with answer groups:', gameStateToSend.currentAnswerGroups);
            console.log('📤 Total game state keys:', Object.keys(gameStateToSend));
            
            // Debug: Check who's in the room
            const roomSockets = await io.in(this.gameCode).fetchSockets();
            console.log(`🔍 Room ${this.gameCode} has ${roomSockets.length} sockets:`, roomSockets.map(s => s.id));
            
            io.to(this.gameCode).emit('questionComplete', gameStateToSend);
        }
    }

    nextQuestion() {
        this.currentQuestion++;
        this.answers.clear();
        
        // Reset question scoring state for the new question
        this.resetQuestionScoring();
        
        // Check if we've completed a round (5 questions per round)
        const currentRound = Math.ceil(this.currentQuestion / this.settings.questionsPerRound);
        const questionInRound = ((this.currentQuestion - 1) % this.settings.questionsPerRound) + 1;
        
        // DEVELOPMENT: For testing, trigger round complete after 2 questions instead of 5
        const questionsForRoundComplete = process.env.NODE_ENV === 'development' ? 2 : this.settings.questionsPerRound;
        
        // If we just finished the last question of a round, show round results
        if (questionInRound === questionsForRoundComplete) {
            this.completeRound();
        } else if (this.currentQuestion >= this.questions.length) {
            this.gameState = 'finished';
            io.to(this.gameCode).emit('gameFinished', this.getGameState());
        } else {
            this.gameState = 'playing';
            this.startTimer();
            io.to(this.gameCode).emit('nextQuestion', this.getGameState());
        }
    }

    completeRound() {
        const currentRound = Math.ceil(this.currentQuestion / this.settings.questionsPerRound);
        const roundStartQuestion = (currentRound - 1) * this.settings.questionsPerRound + 1;
        const roundEndQuestion = Math.min(currentRound * this.settings.questionsPerRound, this.questions.length);
        
        // Create round summary data
        const roundData = {
            roundNumber: currentRound,
            questionStart: roundStartQuestion,
            questionEnd: roundEndQuestion,
            players: Array.from(this.players.values()).map(player => ({
                name: player.name,
                score: this.scores.get(player.id) || 0
            })),
            answerGroups: this.currentAnswerGroups || []
        };
        
        this.roundHistory.push(roundData);
        this.gameState = 'roundComplete';
        
        console.log(`🎯 Round ${currentRound} completed for game ${this.gameCode}`);
        io.to(this.gameCode).emit('roundComplete', this.getGameState());
    }

    continueToNextRound() {
        if (this.currentQuestion >= this.questions.length) {
            this.gameState = 'finished';
            io.to(this.gameCode).emit('gameFinished', this.getGameState());
        } else {
            this.gameState = 'playing';
            this.startTimer();
            io.to(this.gameCode).emit('nextQuestion', this.getGameState());
        }
    }

    cleanup() {
        this.stopTimer();
        activeGameCodes.delete(this.gameCode);
        console.log(`🧹 Cleaned up game ${this.gameCode}`);
    }

    submitVirtualAnswer(playerId, answer) {
        if (this.gameState !== 'playing') return false;
        
        this.answers.set(playerId, answer.trim());
        const player = this.players.get(playerId);
        if (player) {
            console.log(`📝 Virtual player ${player.name} submitted answer: "${answer}"`);
        }
        return true;
    }
}

// Utility function to call the semantic matcher service
// Integrated JavaScript semantic matcher (no external Python service needed)
function normalizeText(text) {
    return text.toLowerCase().trim();
}

function computeFuzzySimilarity(text1, text2) {
    const normalized1 = normalizeText(text1);
    const normalized2 = normalizeText(text2);
    
    if (normalized1 === normalized2) return 1.0;
    
    // Simple Levenshtein-like similarity
    const longer = normalized1.length > normalized2.length ? normalized1 : normalized2;
    const shorter = normalized1.length > normalized2.length ? normalized2 : normalized1;
    
    if (longer.length === 0) return 1.0;
    
    // Check for substring matches
    if (longer.includes(shorter)) {
        return shorter.length / longer.length;
    }
    
    // Simple character-by-character similarity
    let matches = 0;
    const minLength = Math.min(normalized1.length, normalized2.length);
    
    for (let i = 0; i < minLength; i++) {
        if (normalized1[i] === normalized2[i]) {
            matches++;
        }
    }
    
    return matches / Math.max(normalized1.length, normalized2.length);
}

// Synonym dictionary for common cases
const SYNONYM_DICT = {
    'cock': ['rooster', 'chicken', 'hen'],
    'rooster': ['cock', 'chicken', 'hen'],
    'chicken': ['cock', 'rooster', 'hen'],
    'hen': ['cock', 'rooster', 'chicken'],
    'dragon': ['draggon', 'dragun', 'dragonn', 'drgon'],
    'draggon': ['dragon'],
    'dragun': ['dragon'],
    'dragonn': ['dragon'],
    'drgon': ['dragon'],
    'pig': ['piggy', 'hog', 'swine'],
    'piggy': ['pig', 'hog', 'swine'],
    'hog': ['pig', 'piggy', 'swine'],
    'swine': ['pig', 'piggy', 'hog'],
    'rat': ['mouse', 'rodent'],
    'mouse': ['rat', 'rodent'],
    'rodent': ['rat', 'mouse'],
    'ox': ['bull', 'cow', 'cattle'],
    'bull': ['ox', 'cow', 'cattle'],
    'cow': ['ox', 'bull', 'cattle'],
    'cattle': ['ox', 'bull', 'cow'],
    'tiger': ['cat', 'feline'],
    'cat': ['tiger', 'feline'],
    'feline': ['tiger', 'cat'],
    'rabbit': ['bunny', 'hare'],
    'bunny': ['rabbit', 'hare'],
    'hare': ['rabbit', 'bunny'],
    'snake': ['serpent', 'reptile'],
    'serpent': ['snake', 'reptile'],
    'reptile': ['snake', 'serpent'],
    'horse': ['steed', 'mare', 'stallion'],
    'steed': ['horse', 'mare', 'stallion'],
    'mare': ['horse', 'steed', 'stallion'],
    'stallion': ['horse', 'steed', 'mare'],
    'goat': ['billy', 'nanny'],
    'billy': ['goat', 'nanny'],
    'nanny': ['goat', 'billy'],
    'monkey': ['ape', 'primate'],
    'ape': ['monkey', 'primate'],
    'primate': ['monkey', 'ape'],
    'dog': ['canine', 'hound', 'puppy'],
    'canine': ['dog', 'hound', 'puppy'],
    'hound': ['dog', 'canine', 'puppy'],
    'puppy': ['dog', 'canine', 'hound']
};

function computeHybridSimilarity(text1, text2) {
    const normalized1 = normalizeText(text1);
    const normalized2 = normalizeText(text2);
    
    // Check synonym dictionary first
    if (normalized1 in SYNONYM_DICT && SYNONYM_DICT[normalized1].includes(normalized2)) {
        return 0.95; // 95% confidence for known synonyms
    }
    if (normalized2 in SYNONYM_DICT && SYNONYM_DICT[normalized2].includes(normalized1)) {
        return 0.95; // 95% confidence for known synonyms
    }
    
    // Use fuzzy similarity
    return computeFuzzySimilarity(text1, text2);
}

function computeConfidence(similarity) {
    // Map similarity (0-1) to confidence (0-100)
    return Math.min(100.0, Math.max(0.0, similarity * 100));
}

async function getSemanticMatches(question, correctAnswers, responses) {
    try {
        console.log('🧠 Processing semantic matches...');
        console.log(`Question: ${question}`);
        console.log(`Correct answers: ${correctAnswers.join(', ')}`);
        console.log(`Responses: ${responses.join(', ')}`);
        
        // Try Python service first if available
        if (semanticServiceReady) {
            try {
                console.log('🐍 Using Python Sentence Transformers service...');
                const res = await fetch('http://127.0.0.1:5005/semantic-match', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        question,
                        correct_answers: correctAnswers,
                        responses
                    }),
                    timeout: 10000 // 10 second timeout for public WiFi
                });
                
                if (res.ok) {
                    const data = await res.json();
                    console.log('✅ Python semantic matching completed');
                    return data.results;
                } else {
                    console.log('⚠️ Python service returned error, falling back to JavaScript');
                }
            } catch (error) {
                console.log('⚠️ Python service unavailable, falling back to JavaScript:', error.message);
                if (error.message.includes('fetch failed') || error.message.includes('network')) {
                    console.log('🌐 Network issue detected - this is common on public WiFi');
                }
                // Don't re-throw the error, just continue with JavaScript fallback
            }
        } else {
            console.log('⚠️ Python service not ready, using JavaScript fallback');
        }
        
        // Fallback to JavaScript implementation
        console.log('🔄 Using JavaScript fuzzy matching fallback...');
        const results = [];
        
        for (const response of responses) {
            let bestMatch = null;
            let bestSimilarity = 0.0;
            
            // Find the best matching correct answer
            for (const correctAnswer of correctAnswers) {
                const similarity = computeHybridSimilarity(response, correctAnswer);
                if (similarity > bestSimilarity) {
                    bestSimilarity = similarity;
                    bestMatch = correctAnswer;
                }
            }
            
            const confidence = computeConfidence(bestSimilarity);
            
            const result = {
                response: response,
                best_match: bestMatch,
                similarity: Math.round(bestSimilarity * 100) / 100,
                confidence: Math.round(confidence * 100) / 100
            };
            
            results.push(result);
            console.log(`'${response}' -> '${bestMatch}' (confidence: ${confidence.toFixed(1)}%)`);
        }
        
        console.log('✅ JavaScript semantic matching completed');
        return results;
        
    } catch (error) {
        console.error('❌ Error in semantic matching:', error);
        return null;
    }
}

// Example integration in grading logic (replace with your actual grading handler):
// Assume you have: question, correctAnswers, responses (array of answer strings)
//
// async function autoCategorizeAnswers(question, correctAnswers, responses) {
//     const matches = await getSemanticMatches(question, correctAnswers, responses);
//     const categorized = { correct: [], wrong: [], uncategorized: [] };
//     matches.forEach((match, i) => {
//         if (match.confidence >= 80 && match.best_match) {
//             categorized.correct.push({
//                 response: match.response,
//                 matchedTo: match.best_match,
//                 confidence: match.confidence
//             });
//         } else {
//             categorized.uncategorized.push({
//                 response: match.response,
//                 confidence: match.confidence
//             });
//         }
//     });
//     return categorized;
// }
//
// You should call this function during grading and use the result to populate the correct, wrong, and uncategorized buckets. Pass the confidence scores to the frontend as needed.

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'uploads/');
    },
    filename: function (req, file, cb) {
        // Keep original filename with timestamp prefix
        const timestamp = Date.now();
        const originalName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
        cb(null, `sheep_${timestamp}_${originalName}`);
    }
});

const upload = multer({
    storage: storage,
    limits: {
        fileSize: 10 * 1024 * 1024 // 10MB limit
    },
    fileFilter: function (req, file, cb) {
        // Only allow image files
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Only image files are allowed!'), false);
        }
    }
});

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/host', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'host.html'));
});

app.get('/display', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'display.html'));
});

app.get('/grading', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'grading.html'));
});

app.get('/grading-single', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'grading-single.html'));
});

app.get('/game', (req, res) => {
    console.log('🎯 /game route hit - serving game.html');
    res.sendFile(path.join(__dirname, 'public', 'game.html'));
});

app.get('/upload', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'upload.html'));
});

// API endpoint for semantic matching
app.post('/api/semantic-match', async (req, res) => {
    try {
        const { question, correct_answers, responses } = req.body;
        
        if (!question || !correct_answers || !responses) {
            return res.status(400).json({
                success: false,
                error: 'Missing required parameters: question, correct_answers, responses'
            });
        }
        
        const results = await getSemanticMatches(question, correct_answers, responses);
        
        if (results === null) {
            return res.status(500).json({
                success: false,
                error: 'Semantic matching failed'
            });
        }
        
        res.json({
            success: true,
            results: results
        });
        
    } catch (error) {
        console.error('API semantic match error:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error'
        });
    }
});

// Health check endpoint for semantic service
app.get('/api/semantic-status', (req, res) => {
    res.json({
        pythonServiceReady: semanticServiceReady,
        pythonServiceRunning: pythonSemanticService !== null && !pythonSemanticService.killed,
        message: semanticServiceReady ? 
            'Python Sentence Transformers service is ready' : 
            'Using JavaScript fallback semantic matching'
    });
});

// Serve uploaded images
app.use('/uploads', express.static('uploads'));

// Sheep upload API endpoints
app.post('/api/upload-sheep', upload.array('sheep-photos', 20), (req, res) => {
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: 'No files uploaded' });
        }

        const uploadedFiles = req.files.map(file => ({
            filename: file.filename,
            originalName: file.originalname,
            size: file.size,
            path: `/uploads/${file.filename}`
        }));

        console.log(`🐑 Uploaded ${uploadedFiles.length} sheep photos:`, uploadedFiles.map(f => f.originalName));

        res.json({ 
            success: true, 
            message: `Successfully uploaded ${uploadedFiles.length} sheep photo(s)`,
            files: uploadedFiles 
        });
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ error: 'Upload failed' });
    }
});

app.get('/api/sheep-photos', (req, res) => {
    try {
        const uploadsPath = path.join(__dirname, 'uploads');
        
        if (!fs.existsSync(uploadsPath)) {
            return res.json({ photos: [] });
        }

        const files = fs.readdirSync(uploadsPath)
            .filter(file => file.startsWith('sheep_') && /\.(jpg|jpeg|png|gif|webp|avif)$/i.test(file))
            .map(file => {
                const filePath = path.join(uploadsPath, file);
                const stats = fs.statSync(filePath);
                return {
                    filename: file,
                    path: `/uploads/${file}`,
                    size: stats.size,
                    uploaded: stats.mtime
                };
            })
            .sort((a, b) => new Date(b.uploaded) - new Date(a.uploaded));

        res.json({ photos: files });
    } catch (error) {
        console.error('Error listing sheep photos:', error);
        res.status(500).json({ error: 'Failed to list photos' });
    }
});

app.delete('/api/sheep-photos/:filename', (req, res) => {
    try {
        const filename = req.params.filename;
        const filePath = path.join(__dirname, 'uploads', filename);
        
        if (!filename.startsWith('sheep_')) {
            return res.status(400).json({ error: 'Invalid filename' });
        }

        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            console.log(`🗑️ Deleted sheep photo: ${filename}`);
            res.json({ success: true, message: 'Photo deleted successfully' });
        } else {
            res.status(404).json({ error: 'Photo not found' });
        }
    } catch (error) {
        console.error('Delete error:', error);
        res.status(500).json({ error: 'Failed to delete photo' });
    }
});

app.get('/api/sheep-urls', (req, res) => {
    try {
        const uploadsPath = path.join(__dirname, 'uploads');
        
        if (!fs.existsSync(uploadsPath)) {
            return res.json({ urls: [] });
        }

        const files = fs.readdirSync(uploadsPath)
            .filter(file => file.startsWith('sheep_') && /\.(jpg|jpeg|png|gif|webp|avif)$/i.test(file))
            .map(file => `/uploads/${file}`)
            .sort();

        res.json({ urls: files });
    } catch (error) {
        console.error('Error getting sheep URLs:', error);
        res.status(500).json({ error: 'Failed to get photo URLs' });
    }
});

app.post('/api/remove-duplicates', (req, res) => {
    try {
        const uploadsPath = path.join(__dirname, 'uploads');
        
        if (!fs.existsSync(uploadsPath)) {
            return res.json({ removed: [], message: 'No uploads directory found' });
        }

        const files = fs.readdirSync(uploadsPath)
            .filter(file => file.startsWith('sheep_') && /\.(jpg|jpeg|png|gif|webp|avif)$/i.test(file))
            .map(file => {
                const filePath = path.join(uploadsPath, file);
                const stats = fs.statSync(filePath);
                // Extract the original photo ID from filename (after the timestamp)
                const originalName = file.replace(/^sheep_\d+_/, '');
                return {
                    filename: file,
                    originalName: originalName,
                    size: stats.size,
                    uploaded: stats.mtime,
                    path: filePath
                };
            });

        // Group files by their original name to find duplicates
        const grouped = {};
        files.forEach(file => {
            if (!grouped[file.originalName]) {
                grouped[file.originalName] = [];
            }
            grouped[file.originalName].push(file);
        });

        // Find duplicates and keep only the newest (latest timestamp)
        const toRemove = [];
        Object.values(grouped).forEach(group => {
            if (group.length > 1) {
                // Sort by upload time, keep the newest
                group.sort((a, b) => new Date(b.uploaded) - new Date(a.uploaded));
                // Mark older duplicates for removal
                toRemove.push(...group.slice(1));
            }
        });

        // Remove duplicate files
        const removedFiles = [];
        toRemove.forEach(file => {
            try {
                fs.unlinkSync(file.path);
                removedFiles.push(file.filename);
                console.log(`🗑️ Removed duplicate: ${file.filename}`);
            } catch (error) {
                console.error(`Failed to remove ${file.filename}:`, error);
            }
        });

        res.json({ 
            success: true,
            removed: removedFiles,
            count: removedFiles.length,
            message: `Removed ${removedFiles.length} duplicate photo(s)`
        });
    } catch (error) {
        console.error('Error removing duplicates:', error);
        res.status(500).json({ error: 'Failed to remove duplicates' });
    }
});

// API Endpoints
app.post('/api/create-game', (req, res) => {
    const { hostName } = req.body;
    
    // Use default host name if not provided
    const finalHostName = hostName || 'Host';
    
    try {
        const game = new Game(finalHostName);
        activeGames.set(game.gameCode, game);
        
        console.log(`🎮 Created new game: ${game.gameCode} by ${finalHostName}`);
        
        res.json({
            status: 'success',
            gameCode: game.gameCode,
            hostName: finalHostName,
            message: `Game created with code: ${game.gameCode}`
        });
    } catch (error) {
        console.error('Error creating game:', error);
        res.status(500).json({
            status: 'error',
            message: 'Failed to create game'
        });
    }
});

app.post('/api/join-game', (req, res) => {
    const { gameCode, playerName } = req.body;
    
    if (!gameCode || !playerName || playerName.trim() === '') {
        return res.status(400).json({ 
            status: 'error', 
            message: 'Game code and player name are required' 
        });
    }
    
    const game = activeGames.get(gameCode);
    
    if (!game) {
        return res.status(404).json({ 
            status: 'error', 
            message: 'Game not found. Please check the game code.' 
        });
    }
    
    if (game.gameState !== 'waiting') {
        return res.status(400).json({ 
            status: 'error', 
            message: 'Game has already started. Cannot join.' 
        });
    }
    
    res.json({
        status: 'success',
        gameCode: gameCode,
        playerName: playerName,
        playerCount: game.players.size,
        message: `Ready to join game ${gameCode}`
    });
});

app.get('/api/game/:gameCode', (req, res) => {
    const { gameCode } = req.params;
    const game = activeGames.get(gameCode);
    
    if (!game) {
        return res.status(404).json({ 
            status: 'error', 
            message: 'Game not found' 
        });
    }
    
    res.json({
        status: 'success',
        gameCode: game.gameCode,
        hostName: game.hostId,
        playerCount: game.players.size,
        gameState: game.gameState,
        createdAt: game.createdAt
    });
});

// Global tracking for duplicate startGame requests
const recentStartGameRequests = new Map();

// Socket.IO Connection Handler
io.on('connection', (socket) => {
    console.log('🔌 User connected:', socket.id);
    
    // Store connection info
    connectedPlayers.set(socket.id, {
        id: socket.id,
        connectedAt: Date.now(),
        gameCode: null,
        playerName: null,
        isHost: false
    });

    // Host reconnection
    socket.on('reconnectHost', (data) => {
        const { gameCode, hostName } = data;
        
        if (!gameCode || !hostName) {
            socket.emit('error', { message: 'Game code and host name are required' });
      return;
    }

        const game = activeGames.get(gameCode);
        if (!game) {
            socket.emit('error', { message: 'Game not found. Please check the game code.' });
            return;
        }
        
        if (game.hostId !== hostName) {
            socket.emit('error', { message: 'You are not the host of this game.' });
            return;
        }
        
        // Update connection info
        const playerInfo = connectedPlayers.get(socket.id);
        if (playerInfo) {
            playerInfo.gameCode = gameCode;
            playerInfo.playerName = hostName;
            playerInfo.isHost = true;
        }
        
        socket.join(gameCode);
        socket.emit('hostReconnected', { 
            gameCode: gameCode,
            gameState: game.getGameState()
        });
        
        console.log(`🔄 Host ${hostName} reconnected to game ${gameCode} and joined room`);
    });

    // Create game (legacy socket event for host joining room)
    socket.on('createGame', (data) => {
        // Find the most recently created game (assuming this socket just created one)
        let hostGame = null;
        let latestGame = null;
        let latestTime = 0;
        
        for (const [gameCode, game] of activeGames) {
            if (game.createdAt > latestTime) {
                latestTime = game.createdAt;
                latestGame = game;
            }
        }
        
        if (latestGame) {
            hostGame = latestGame;
        }
        
        if (!hostGame) {
            socket.emit('gameError', { message: 'No game found. Please create a game first.' });
            return;
        }
        
        // Update connection info
        const playerInfo = connectedPlayers.get(socket.id);
        if (playerInfo) {
            playerInfo.gameCode = hostGame.gameCode;
            playerInfo.playerName = hostGame.hostId;
            playerInfo.isHost = true;
        }
        
        // Host joins the Socket.IO room
        socket.join(hostGame.gameCode);
        
        socket.emit('gameCreated', {
            gameCode: hostGame.gameCode,
            gameState: hostGame.getGameState()
        });
        
        console.log(`🏠 Host ${hostGame.hostId} joined room for game ${hostGame.gameCode}`);
    });

    // Host reconnect
    socket.on('host-reconnect', (data) => {
        const { gameCode } = data;
        
        if (!gameCode) {
            socket.emit('gameError', { message: 'Game code is required for reconnection' });
            return;
        }
        
        const game = activeGames.get(gameCode);
        if (!game) {
            socket.emit('gameError', { message: 'Game not found. Please check the game code.' });
            return;
        }
        
        // Update connection info
        const playerInfo = connectedPlayers.get(socket.id);
        if (playerInfo) {
            playerInfo.gameCode = gameCode;
            playerInfo.playerName = game.hostId;
            playerInfo.isHost = true;
        }
        
        // Host joins the Socket.IO room
        socket.join(gameCode);
        
        socket.emit('gameCreated', {
            gameCode: gameCode,
            gameState: game.getGameState()
        });
        
        console.log(`🏠 Host ${game.hostId} reconnected to game ${gameCode}`);
    });

    // Join game
    socket.on('joinGame', (data) => {
        console.log('🔍 joinGame event received:', data);
        console.log('🔍 joinGame: socket.id:', socket.id);
        const { gameCode, playerName } = data;
        
        if (!gameCode || !playerName) {
            console.log('❌ joinGame: Missing gameCode or playerName');
            socket.emit('gameError', { message: 'Game code and player name are required' });
            return;
        }
        
        console.log(`🔍 joinGame: Looking for game ${gameCode}`);
        const game = activeGames.get(gameCode);
        if (!game) {
            console.log(`❌ joinGame: Game ${gameCode} not found`);
            socket.emit('gameError', { message: 'Game not found. Please check the game code.' });
            return;
        }
        
        console.log(`🔍 joinGame: Game ${gameCode} found, state: ${game.gameState}`);
        console.log(`🔍 joinGame: Game has ${game.players.size} players`);
        console.log(`🔍 joinGame: Game players:`, Array.from(game.players.values()));
        
        if (game.gameState !== 'waiting') {
            console.log(`❌ joinGame: Game ${gameCode} has already started`);
            socket.emit('gameError', { message: 'Game has already started. Cannot join.' });
            return;
        }
        
        try {
            console.log(`🔍 joinGame: Processing join for ${playerName} to game ${gameCode}`);
            
            // Update connection info first
            const playerInfo = connectedPlayers.get(socket.id);
            if (playerInfo) {
                playerInfo.gameCode = gameCode;
                playerInfo.playerName = playerName;
                // Check if this player is the host of the game
                playerInfo.isHost = (playerName === game.hostId);
            }
            
            // Only add to player list if not the host
            if (playerName !== game.hostId) {
                console.log(`🔍 joinGame: Adding ${playerName} to game ${gameCode}`);
                game.addPlayer(socket.id, playerName);
                
                // Notify everyone in the game room about the new player
                io.to(gameCode).emit('playerJoined', game.getGameState());
            } else {
                console.log('🏠 Host', playerName, 'joined room for game', gameCode);
            }
            
            console.log(`🔍 joinGame: Adding socket ${socket.id} to room ${gameCode}`);
            socket.join(gameCode);
            
            // Confirm to player
            console.log(`🔍 joinGame: Sending gameJoined response to ${playerName}`);
            const gameStateToSend = game.getGameState();
            console.log(`🔍 joinGame: gameState.players:`, gameStateToSend.players);
            console.log(`🔍 joinGame: gameState.players.length:`, gameStateToSend.players?.length || 0);
            console.log(`🔍 joinGame: Full gameState keys:`, Object.keys(gameStateToSend));
            console.log(`🔍 joinGame: Full gameState:`, JSON.stringify(gameStateToSend, null, 2));
            
            // Test JSON serialization
            const testSerialization = JSON.stringify(gameStateToSend);
            const testDeserialization = JSON.parse(testSerialization);
            console.log(`🔍 joinGame: Serialization test - players after JSON roundtrip:`, testDeserialization.players?.length || 0);
            
            const responseData = {
                gameCode: gameCode,
                gameState: gameStateToSend,
                playerCount: game.players.size
            };
            
            console.log(`🔍 joinGame: Final response data:`, JSON.stringify(responseData, null, 2));
            
            socket.emit('gameJoined', responseData);
            
            // Send a test event to the room to verify event delivery
            setTimeout(() => {
                console.log(`🧪 Sending test event to room ${gameCode} to verify event delivery`);
                io.to(gameCode).emit('testEvent', { 
                    message: 'Test event from server',
                    timestamp: Date.now(),
                    gameCode: gameCode
                });
            }, 2000); // Send test event 2 seconds after player joins
    
        } catch (error) {
            console.error('❌ joinGame error:', error);
            socket.emit('gameError', { message: error.message });
        }
    });

    // Virtual player join (for testing)
    socket.on('virtualPlayerJoined', (data) => {
        console.log('🎭 virtualPlayerJoined event received:', data);
        const { gameCode, playerId, playerName } = data;
        
        if (!gameCode || !playerId || !playerName) {
            console.log('⚠️ virtualPlayerJoined event received with incomplete data');
            return;
        }
        
        const game = activeGames.get(gameCode);
        if (!game) {
            console.log(`❌ Game ${gameCode} not found for virtualPlayerJoined`);
            return;
        }
        
        if (game.gameState !== 'waiting') {
            console.log('⚠️ Cannot add virtual player to game that has already started');
            return;
        }
        
        try {
            // Add virtual player directly to game without socket ID
            game.addVirtualPlayer(playerId, playerName);
            
            // Notify everyone in the game room about the new virtual player
            console.log(`🎭 Emitting virtualPlayerJoined to room ${gameCode} for player ${playerName}`);
            io.to(gameCode).emit('virtualPlayerJoined', {
                playerId: playerId,
                playerName: playerName,
                gameState: game.getGameState()
            });
            
            console.log(`🎭 Virtual player ${playerName} (${playerId}) added to game ${gameCode}`);
            
        } catch (error) {
            console.error('❌ Error adding virtual player:', error.message);
        }
    });

    // Test room membership
    socket.on('testRoomMembership', (data) => {
        const { gameCode } = data;
        console.log(`🔍 Player ${socket.id} testing room membership for game ${gameCode}`);
        
        // Check if player is in the room
        const rooms = socket.rooms;
        console.log(`🔍 Player ${socket.id} is in rooms:`, Array.from(rooms));
        
        if (rooms.has(gameCode)) {
            console.log(`✅ Player ${socket.id} is correctly in room ${gameCode}`);
        } else {
            console.log(`❌ Player ${socket.id} is NOT in room ${gameCode}`);
        }
    });

    // Ping test
    socket.on('ping', (data) => {
        console.log(`🏓 Ping received from ${socket.id}:`, data);
        console.log(`🏓 Socket connected state:`, socket.connected);
        console.log(`🏓 Socket rooms:`, Array.from(socket.rooms));
        socket.emit('pong', { message: 'Server pong', timestamp: Date.now() });
    });

    // Start game
    socket.on('startGame', async (data) => {
        console.log('🎮 startGame event received from socket:', socket.id);
        
        if (!data) {
            console.log('⚠️ startGame event received with no data');
            return;
        }
        
        const { gameCode } = data;
        
        if (!gameCode) {
            console.log('⚠️ startGame event received with no gameCode');
            return;
        }
        
        // Check for duplicate request within last 2 seconds
        const requestKey = `${socket.id}-${gameCode}`;
        const now = Date.now();
        const lastRequest = recentStartGameRequests.get(requestKey);
        
        if (lastRequest && (now - lastRequest) < 2000) {
            console.log('🚫 Duplicate startGame request ignored for game:', gameCode);
            return;
        }
        
        recentStartGameRequests.set(requestKey, now);
        
        // Clean up old entries every 10 seconds
        if (recentStartGameRequests.size > 100) {
            const cutoff = now - 10000;
            for (const [key, timestamp] of recentStartGameRequests.entries()) {
                if (timestamp < cutoff) {
                    recentStartGameRequests.delete(key);
                }
            }
        }
        
        const game = activeGames.get(gameCode);
        if (!game) return;
        
        const playerInfo = connectedPlayers.get(socket.id);
        if (!playerInfo || !playerInfo.isHost || playerInfo.playerName !== game.hostId) {
            socket.emit('gameError', { message: 'Only the host can start the game.' });
    return;
  }
  
        try {
            let questions = [];
            
            if (supabase && supabaseConfigured) {
                try {
                    const { data: dbQuestions, error } = await supabase
                        .from('questions')
                        .select('*')
                        .order('round', { ascending: true })
                        .order('question_order', { ascending: true });

                    if (error) throw error;
                    if (!dbQuestions || dbQuestions.length === 0) {
                        throw new Error('No questions found in database. Please upload sample questions first.');
                    }
                    
                    console.log('🔍 Debug: Raw database question structure:', dbQuestions[0]);
                    console.log('🔍 Debug: Database field names:', Object.keys(dbQuestions[0]));
                    
                    // Map database fields to expected format
                    questions = dbQuestions.map(q => ({
                        id: q.id,
                        prompt: q.prompt,  // Database field is already called 'prompt'
                        round: q.round,
                        question_order: q.question_order,
                        correct_answers: Array.isArray(q.correct_answers) ? q.correct_answers : [q.correct_answers].filter(Boolean)
                    }));
                    
                    console.log('🔍 Debug: Mapped question structure:', questions[0]);
                    console.log('🔍 Debug: Mapped prompt field:', questions[0]?.prompt);
                } catch (dbError) {
                    console.log('⚠️ Database query failed:', dbError.message);
                    if (dbError.message.includes('fetch failed') || dbError.message.includes('network') || dbError.message.includes('ENOTFOUND')) {
                        console.log('🌐 Network issue detected with database - falling back to demo questions');
                    }
                    // Fall back to demo questions
                    console.log('📚 Falling back to demo questions due to database error');
                    supabaseConfigured = false;
                }
            } else {
                // Demo questions
                questions = [
      { 
        id: 1, 
        prompt: "Name a food that starts with the letter 'P'", 
        correct_answers: ["pizza", "pasta", "potato", "pear", "peach", "pineapple", "pancake", "popcorn"],
        round: 1, 
        question_order: 1 
      },
      { 
        id: 2, 
        prompt: "Name a movie that won an Oscar", 
        correct_answers: ["titanic", "forrest gump", "the godfather", "schindler's list", "casablanca", "gone with the wind"],
        round: 1, 
        question_order: 2 
      },
      { 
        id: 3, 
        prompt: "Name a country in Europe", 
        correct_answers: ["france", "germany", "italy", "spain", "england", "netherlands", "belgium", "switzerland"],
        round: 1, 
        question_order: 3 
      },
      { 
        id: 4, 
        prompt: "Name a famous scientist", 
        correct_answers: ["einstein", "newton", "darwin", "curie", "tesla", "galileo", "hawking", "edison"],
        round: 2, 
        question_order: 1 
      },
      { 
        id: 5, 
        prompt: "Name a type of music genre", 
        correct_answers: ["rock", "jazz", "pop", "classical", "hip hop", "country", "blues", "electronic"],
        round: 2, 
        question_order: 2 
      }
    ];
            }
            
            game.questions = questions;
            game.gameState = 'playing';
            game.currentRound = 1;
            game.currentQuestion = 0;
            game.resetQuestionScoring(); // Reset scoring state for new game
            game.startTimer();
            
            const gameStateToSend = game.getGameState();
            io.to(gameCode).emit('gameStarted', gameStateToSend);
            
        } catch (error) {
            console.error('Error starting game:', {
                message: error.message,
                details: error.stack,
                hint: 'Check if all required services are running',
                code: error.code || ''
            });
            socket.emit('gameError', { 
                message: error.message || 'Failed to start game',
                details: error.stack,
                hint: 'Check if all required services are running',
                code: error.code || ''
            });
        }
    });



    // Submit answer
    socket.on('submitAnswer', async (data) => {
        if (!data) {
            console.log('⚠️ submitAnswer event received with no data');
            return;
        }
        
        const { gameCode, answer } = data;
        
        if (!gameCode || !answer) {
            console.log('⚠️ submitAnswer event received with missing gameCode or answer');
            return;
        }
        
        const playerInfo = connectedPlayers.get(socket.id);
        if (!playerInfo || playerInfo.gameCode !== gameCode) return;
        
        const game = activeGames.get(gameCode);
        if (!game) return;
        
        if (game.submitAnswer(socket.id, answer)) {
            socket.emit('answerSubmitted');
            
            // Get player name for the answer
            const playerName = playerInfo.playerName;
            
            console.log(`🎯 Player ${playerName} submitted answer: "${answer}"`);
            
            // Notify host of the specific answer
            const hostSocket = Array.from(connectedPlayers.entries())
                .find(([id, info]) => info.gameCode === gameCode && info.isHost);
            
            if (hostSocket) {
                console.log(`📤 Emitting answerSubmitted to host socket ${hostSocket[0]} for player ${playerName}`);
                io.to(hostSocket[0]).emit('answerSubmitted', {
                    playerName: playerName,
                    answer: answer
                });
            } else {
                console.log(`❌ No host socket found for game ${gameCode}`);
            }
            
            // Notify grading interface of new answer (real-time updates)
            console.log(`📤 Emitting newAnswerSubmitted to room ${gameCode} for player ${playerName}`);
            console.log(`📤 Room ${gameCode} sockets:`, Array.from(io.sockets.adapter.rooms.get(gameCode) || []));
            
            io.to(gameCode).emit('newAnswerSubmitted', {
                playerName: playerName,
                answer: answer,
                gameCode: gameCode
            });
            
            console.log(`✅ newAnswerSubmitted event emitted to room ${gameCode}`);
            
            // Notify others of answer count
            io.to(gameCode).emit('answerUpdate', {
                answersReceived: game.answers.size,
                totalPlayers: game.players.size
            });
            
            // Check if all answered
            if (game.answers.size === game.players.size) {
                console.log(`🎯 All players (${game.players.size}) have submitted answers, ending question automatically`);
                game.calculateScores();
                game.gameState = 'grading'; // Changed from 'scoring' to 'grading'
                game.stopTimer();
                
                const gameStateToSend = game.getGameState();
                console.log('📤 Sending questionComplete with answer groups:', gameStateToSend.currentAnswerGroups);
                console.log('📤 Total game state keys:', Object.keys(gameStateToSend));
                
                // Debug: Check who's in the room
                const roomSockets = await io.in(gameCode).fetchSockets();
                console.log(`🔍 Room ${gameCode} has ${roomSockets.length} sockets:`, roomSockets.map(s => s.id));
                
                io.to(gameCode).emit('questionComplete', gameStateToSend);
            }
        }
    });

    // Virtual answer submission (for testing)
    socket.on('virtualAnswerSubmitted', async (data) => {
        if (!data) {
            console.log('⚠️ virtualAnswerSubmitted event received with no data');
            return;
        }
        
        const { gameCode, playerId, playerName, answer, isCorrect } = data;
        
        if (!gameCode || !playerId || !playerName || !answer) {
            console.log('⚠️ virtualAnswerSubmitted event received with incomplete data');
            return;
        }
        
        const game = activeGames.get(gameCode);
        if (!game) {
            console.log(`❌ Game ${gameCode} not found for virtualAnswerSubmitted`);
            return;
        }
        
        if (game.gameState !== 'playing') {
            console.log('⚠️ Cannot submit virtual answer when game is not playing');
            return;
        }
        
        try {
            // Submit answer for virtual player
            game.submitVirtualAnswer(playerId, answer);
            
            console.log(`🎭 Virtual player ${playerName} submitted answer: "${answer}" (${isCorrect ? 'correct' : 'incorrect'})`);
            
            // Notify host of the specific answer
            const hostSocket = Array.from(connectedPlayers.entries())
                .find(([id, info]) => info.gameCode === gameCode && info.isHost);
            
            if (hostSocket) {
                io.to(hostSocket[0]).emit('answerSubmitted', {
                    playerName: playerName,
                    answer: answer
                });
            }
            
            // Notify grading interface of new answer
            io.to(gameCode).emit('newAnswerSubmitted', {
                playerName: playerName,
                answer: answer,
                gameCode: gameCode
            });
            
            // Notify others of answer count
            io.to(gameCode).emit('answerUpdate', {
                answersReceived: game.answers.size,
                totalPlayers: game.players.size
            });
            
            // Check if all answered
            if (game.answers.size === game.players.size) {
                console.log(`🎯 All players (${game.players.size}) have submitted answers, ending question automatically`);
                game.calculateScores();
                game.gameState = 'grading';
                game.stopTimer();
                
                const gameStateToSend = game.getGameState();
                io.to(gameCode).emit('questionComplete', gameStateToSend);
            }
            
        } catch (error) {
            console.error('❌ Error submitting virtual answer:', error.message);
        }
    });

    // Complete grading (mandatory before next question)
    socket.on('completeGrading', async (data) => {
        if (!data) {
            console.log('⚠️ completeGrading event received with no data');
            return;
        }
        
        const { gameCode, categorizedAnswers } = data;
        
        if (!gameCode) {
            console.log('⚠️ completeGrading event received with no gameCode');
            return;
        }
        
        const playerInfo = connectedPlayers.get(socket.id);
        if (!playerInfo || !playerInfo.isHost) return;
        
        const game = activeGames.get(gameCode);
        if (!game) return;
        
        if (game.gameState !== 'grading') {
            socket.emit('gameError', { message: 'Not in grading phase' });
            return;
        }
        
        // Store categorized answers if provided
        if (categorizedAnswers) {
            game.categorizationData = categorizedAnswers;
            
            // Recalculate scores based on the categorization data
            console.log(`📊 Recalculating scores based on categorization data`);
            game.calculateScores();
        }
        
        // Apply the current question points to cumulative scores (only once)
        game.applyCurrentQuestionPoints();
        
        // Move to scoring phase to show results
        game.gameState = 'scoring';
        io.to(gameCode).emit('gradingComplete', game.getGameState());
        
        console.log(`📝 Host completed grading for game ${gameCode}`);
    });

    // Next question (only after grading is complete)
    socket.on('nextQuestion', (data) => {
        if (!data) {
            console.log('⚠️ nextQuestion event received with no data');
            return;
        }
        
        const { gameCode } = data;
        
        if (!gameCode) {
            console.log('⚠️ nextQuestion event received with no gameCode');
            return;
        }
        
        const playerInfo = connectedPlayers.get(socket.id);
        if (!playerInfo || !playerInfo.isHost) return;
        
        const game = activeGames.get(gameCode);
        if (!game) return;
        
        if (game.gameState !== 'scoring') {
            socket.emit('gameError', { message: 'Must complete grading before proceeding' });
            return;
        }
        
        game.nextQuestion();
    });

    // Continue to next round (from round complete screen)
    socket.on('continueToNextRound', (data) => {
        if (!data) {
            console.log('⚠️ continueToNextRound event received with no data');
            return;
        }
        
        const { gameCode } = data;
        
        if (!gameCode) {
            console.log('⚠️ continueToNextRound event received with no gameCode');
            return;
        }
        
        const playerInfo = connectedPlayers.get(socket.id);
        if (!playerInfo || !playerInfo.isHost) return;
        
        const game = activeGames.get(gameCode);
        if (!game) return;
        
        if (game.gameState !== 'roundComplete') {
            socket.emit('gameError', { message: 'Game is not in round complete state' });
            return;
        }
        
        console.log(`🎯 Host continuing to next round for game ${gameCode}`);
        game.continueToNextRound();
    });

    // End question (host can end current question early)
    socket.on('endQuestion', async (data) => {
        if (!data) {
            console.log('⚠️ endQuestion event received with no data');
            return;
        }
        
        const { gameCode } = data;
        
        if (!gameCode) {
            console.log('⚠️ endQuestion event received with no gameCode');
            return;
        }
        
        const playerInfo = connectedPlayers.get(socket.id);
        if (!playerInfo || !playerInfo.isHost) return;
        
        const game = activeGames.get(gameCode);
        if (!game) return;
        
        if (game.gameState !== 'playing') {
            socket.emit('gameError', { message: 'Question is not currently active' });
            return;
        }
        
        console.log(`🎯 Host ending question for game ${gameCode}`);
        
        // Calculate scores for any submitted answers
        if (game.answers.size > 0) {
            game.calculateScores();
        }
        
        game.gameState = 'grading';
        game.stopTimer();
        
        const gameStateToSend = game.getGameState();
        console.log('📤 Sending questionComplete from endQuestion with answer groups:', gameStateToSend.currentAnswerGroups);
        console.log('📤 Total game state keys:', Object.keys(gameStateToSend));
        
        // Debug: Check who's in the room
        const roomSockets = await io.in(gameCode).fetchSockets();
        console.log(`🔍 Room ${gameCode} has ${roomSockets.length} sockets:`, roomSockets.map(s => s.id));
        
        io.to(gameCode).emit('questionComplete', gameStateToSend);
    });

    // End game
    socket.on('endGame', (data) => {
        if (!data) {
            console.log('⚠️ endGame event received with no data');
            return;
        }
        
        const { gameCode } = data;
        
        if (!gameCode) {
            console.log('⚠️ endGame event received with no gameCode');
            return;
        }
        
        const playerInfo = connectedPlayers.get(socket.id);
        if (!playerInfo || !playerInfo.isHost) return;
        
        const game = activeGames.get(gameCode);
        if (!game) return;
        
        game.cleanup();
        activeGames.delete(gameCode);
        
        io.to(gameCode).emit('gameEnded', { 
            gameCode: gameCode,
            message: 'Game has been ended by the host.'
        });
        
        console.log(`🎮 Game ${gameCode} ended by host`);
    });

    // Join display room for specific game
    socket.on('joinDisplayRoom', (data) => {
        const { gameCode } = data;
        
        if (!gameCode) {
            socket.emit('displayError', { message: 'Game code is required' });
            return;
        }
        
        const game = activeGames.get(gameCode);
        if (!game) {
            socket.emit('displayError', { message: 'Game not found' });
            return;
        }
        
        // Update connection info for display
        const playerInfo = connectedPlayers.get(socket.id);
        if (playerInfo) {
            playerInfo.gameCode = gameCode;
            playerInfo.isDisplay = true;
        }
        
        // Join the game room to receive updates
        socket.join(gameCode);
        
        // Send current game state to display
        socket.emit('displayGameState', game.getGameState());
        
        console.log(`📺 Display connected to game ${gameCode}`);
    });

    // Join game room for grading interface
    socket.on('joinGameRoom', (data) => {
        const { gameCode } = data;
        
        if (!gameCode) {
            console.log('⚠️ joinGameRoom event received with no gameCode');
            return;
        }
        
        const game = activeGames.get(gameCode);
        if (!game) {
            console.log(`❌ Game ${gameCode} not found for joinGameRoom`);
            return;
        }
        
        // Update connection info for grading interface
        const playerInfo = connectedPlayers.get(socket.id);
        if (playerInfo) {
            playerInfo.gameCode = gameCode;
            playerInfo.isGradingInterface = true;
        }
        
        // Join the game room to receive real-time updates
        socket.join(gameCode);
        
        console.log(`📝 Grading interface joined game room ${gameCode}`);
        console.log(`📝 Room ${gameCode} now has sockets:`, Array.from(io.sockets.adapter.rooms.get(gameCode) || []));
        console.log(`📝 Socket ${socket.id} connection info:`, {
            gameCode: playerInfo?.gameCode,
            isGradingInterface: playerInfo?.isGradingInterface,
            isHost: playerInfo?.isHost
        });
    });

    // Get active game state for host interface
    socket.on('getActiveGameState', () => {
        console.log('🔍 Host interface requesting active game state');
        console.log('🔍 Total active games:', activeGames.size);
        
        // Look for any active games (prioritize games in grading state with answers)
        let activeGameWithAnswers = null;
        let anyActiveGame = null;
        
        for (const [gameCode, game] of activeGames) {
            console.log(`🔍 Checking game ${gameCode}: state=${game.gameState}, answers=${game.answers ? game.answers.size : 0}, players=${game.players.size}`);
            
            anyActiveGame = game; // Always set this to the current game
            
            // Prioritize games that have answers (in grading phase)
            if (game.answers && game.answers.size > 0) {
                activeGameWithAnswers = game;
                console.log(`🎯 Found active game with answers: ${gameCode} (${game.answers.size} answers)`);
                break;
            }
        }
        
        const gameToSend = activeGameWithAnswers || anyActiveGame;
        
        if (gameToSend) {
            const gameState = gameToSend.getGameState();
            socket.emit('activeGameState', gameState);
            console.log(`📤 Sent active game state: ${gameState.gameCode} (state: ${gameState.gameState})`);
        } else {
            console.log('📭 No active games found');
            socket.emit('activeGameState', null);
        }
    });

    // Get all active games for grading interface
    socket.on('getActiveGames', () => {
        console.log('🔍 Grading interface requesting all active games');
        console.log('🔍 Total active games:', activeGames.size);
        
        const gamesArray = [];
        for (const [gameCode, game] of activeGames) {
            const gameState = game.getGameState();
            gamesArray.push(gameState);
            console.log(`📋 Game ${gameCode}: state=${game.gameState}, players=${game.players.size}`);
        }
        
        socket.emit('activeGamesUpdate', gamesArray);
        console.log(`📤 Sent ${gamesArray.length} active games to grading interface`);
    });

    // Get specific game state by game code
    socket.on('getGameState', (data) => {
        if (!data) {
            console.log('⚠️ getGameState event received with no data');
            return;
        }
        
        const { gameCode } = data;
        
        if (!gameCode) {
            console.log('⚠️ getGameState event received with no gameCode');
            return;
        }
        
        console.log('🔍 Requesting specific game state for:', gameCode);
        
        const game = activeGames.get(gameCode);
        if (game) {
            const gameState = game.getGameState();
            socket.emit('gameStateResponse', gameState);
            console.log(`📤 Sent game state for ${gameCode}: ${gameState.gameState}, answers=${gameState.answers ? Object.keys(gameState.answers).length : 0}`);
        } else {
            console.log(`❌ Game ${gameCode} not found`);
            socket.emit('gameStateResponse', null);
        }
    });

    // Load questions into a game
    socket.on('loadQuestions', async (data) => {
        if (!data) {
            console.log('⚠️ loadQuestions event received with no data');
            return;
        }
        
        const { gameCode, questions, loadFromDatabase } = data;
        
        if (!gameCode) {
            console.log('⚠️ loadQuestions event received with no gameCode');
            return;
        }
        
        console.log('📚 Socket request to load questions into game:', gameCode, 'loadFromDatabase:', loadFromDatabase);
        
        const game = activeGames.get(gameCode);
        if (!game) {
            console.log(`❌ Game ${gameCode} not found for loading questions`);
            socket.emit('error', { message: 'Game not found' });
            return;
        }
        
        let questionsToLoad = questions;
        
        // If loadFromDatabase flag is set, load from database
        if (loadFromDatabase || !questionsToLoad || questionsToLoad.length === 0) {
            console.log('📚 No questions provided, loading from database...');
            try {
                if (supabase && supabaseConfigured) {
                    console.log('📚 Loading questions from Supabase database...');
                    const { data: dbQuestions, error } = await supabase
                        .from('questions')
                        .select('*')
                        .order('round', { ascending: true })
                        .order('question_order', { ascending: true });

                    if (error) {
                        console.error('❌ Supabase error:', error);
                        throw error;
                    }

                    if (dbQuestions && dbQuestions.length > 0) {
                                        questionsToLoad = dbQuestions.map(q => ({
                    id: q.id,
                    prompt: q.prompt,  // Database field is already called 'prompt'
                    round: q.round,
                    question_order: q.question_order,
                    correct_answers: Array.isArray(q.correct_answers) ? q.correct_answers : [q.correct_answers].filter(Boolean)
                }));
                        console.log(`✅ Loaded ${questionsToLoad.length} questions from database`);
                    } else {
                        console.log('📭 No questions found in database, using demo questions');
                        questionsToLoad = [
                            { id: 1, prompt: "Name an animal in the Chinese zodiac", correct_answers: ["rat", "ox", "tiger", "rabbit", "dragon", "snake", "horse", "goat", "monkey", "rooster", "dog", "pig"] },
                            { id: 2, prompt: "Name a primary color", correct_answers: ["red", "blue", "yellow"] },
                            { id: 3, prompt: "Name a planet in our solar system", correct_answers: ["mercury", "venus", "earth", "mars", "jupiter", "saturn", "uranus", "neptune"] },
                            { id: 4, prompt: "Name a day of the week", correct_answers: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] },
                            { id: 5, prompt: "Name a season", correct_answers: ["spring", "summer", "fall", "autumn", "winter"] }
                        ];
                    }
                } else {
                    console.log('📭 Database not configured, using demo questions');
                    questionsToLoad = [
                        { id: 1, prompt: "Name an animal in the Chinese zodiac", correct_answers: ["rat", "ox", "tiger", "rabbit", "dragon", "snake", "horse", "goat", "monkey", "rooster", "dog", "pig"] },
                        { id: 2, prompt: "Name a primary color", correct_answers: ["red", "blue", "yellow"] },
                        { id: 3, prompt: "Name a planet in our solar system", correct_answers: ["mercury", "venus", "earth", "mars", "jupiter", "saturn", "uranus", "neptune"] },
                        { id: 4, prompt: "Name a day of the week", correct_answers: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] },
                        { id: 5, prompt: "Name a season", correct_answers: ["spring", "summer", "fall", "autumn", "winter"] }
                    ];
                }
            } catch (error) {
                console.error('❌ Error loading questions from database:', error);
                socket.emit('error', { message: 'Failed to load questions from database' });
                return;
            }
        }
        
        // Store questions in the game
        game.questions = questionsToLoad;
        console.log(`✅ Loaded ${questionsToLoad.length} questions into game ${gameCode}`);
        
        // Notify all players in the game
        io.to(gameCode).emit('questionsLoaded', {
            gameCode: gameCode,
            questionsCount: questionsToLoad.length,
            questions: questionsToLoad
        });
        
        console.log(`📤 Emitted questionsLoaded event for game ${gameCode}`);
    });

    // Disconnect
    socket.on('disconnect', () => {
        const playerInfo = connectedPlayers.get(socket.id);
        
        if (playerInfo && playerInfo.gameCode) {
            const game = activeGames.get(playerInfo.gameCode);
            if (game) {
                // Only remove as player if it's not a display
                if (!playerInfo.isDisplay) {
                game.removePlayer(socket.id);
                
                // Notify everyone in the game room (including host)
                    io.to(playerInfo.gameCode).emit('playerLeft', game.getGameState());
                
                // Clean up empty games
                if (game.players.size === 0) {
                    game.cleanup();
                    activeGames.delete(playerInfo.gameCode);
                    console.log(`🏠 Removed empty game: ${playerInfo.gameCode}`);
                    }
                } else {
                    console.log(`📺 Display disconnected from game ${playerInfo.gameCode}`);
                }
            }
        }
        
        connectedPlayers.delete(socket.id);
        console.log('🔌 User disconnected:', socket.id);
    });
});

// API Endpoints
app.post('/api/create-game', (req, res) => {
    const { hostName } = req.body;
    
    // Use default host name if not provided
    const finalHostName = hostName || 'Host';
    
    // Generate unique 4-digit game code
    let gameCode;
    do {
        gameCode = Math.floor(1000 + Math.random() * 9000).toString();
    } while (activeGames.has(gameCode));
    
    // Create new game
    const game = new Game(finalHostName, gameCode);
    activeGames.set(gameCode, game);
    
    console.log(`🎮 New game created: ${gameCode} by ${finalHostName}`);
    
    res.json({ 
        status: 'success', 
        gameCode: gameCode,
        gameState: game.getGameState()
    });
});

app.post('/api/join-game', (req, res) => {
    const { gameCode, playerName } = req.body;
    
    if (!gameCode || !playerName) {
        return res.json({ status: 'error', message: 'Game code and player name are required' });
    }
    
    const game = activeGames.get(gameCode);
    if (!game) {
        return res.json({ status: 'error', message: 'Game not found' });
    }
    
    if (game.status !== 'waiting') {
        return res.json({ status: 'error', message: 'Game has already started' });
    }
    
    // Check if game is full
    if (game.settings.maxPlayers > 0 && game.players.size >= game.settings.maxPlayers) {
        return res.json({ status: 'error', message: 'Game is full' });
    }
    
    // Check for duplicate names (only among connected players)
    const existingPlayer = Array.from(game.players.values()).find(p => p.name === playerName);
    if (existingPlayer) {
        // Check if this player is still connected
        const existingPlayerInfo = connectedPlayers.get(existingPlayer.id);
        if (existingPlayerInfo && existingPlayerInfo.playerName === playerName) {
            return res.json({ status: 'error', message: 'Player name already taken' });
        }
    }
    
    res.json({ 
        status: 'success', 
        message: 'Ready to join game',
        gameState: game.getGameState()
    });
});

app.get('/api/game/:gameCode', (req, res) => {
    const { gameCode } = req.params;
    
    const game = activeGames.get(gameCode);
    if (!game) {
        return res.json({ status: 'error', message: 'Game not found' });
    }
    
    res.json({ 
        status: 'success', 
        gameState: game.getGameState()
    });
});

// Static files are already served above

// Load questions API endpoint
app.get('/api/load-questions', async (req, res) => {
    try {
        let questions = [];
        
        if (supabase && supabaseConfigured) {
            console.log('📚 Loading questions from Supabase database...');
            const { data: dbQuestions, error } = await supabase
                .from('questions')
                .select('*')
                .order('round', { ascending: true })
                .order('question_order', { ascending: true });

            if (error) {
                console.error('❌ Database error:', error);
                throw error;
            }
            
            if (!dbQuestions || dbQuestions.length === 0) {
                console.log('⚠️ No questions found in database, using demo questions');
                // Fall through to demo questions
            } else {
                questions = dbQuestions;
                console.log(`✅ Loaded ${questions.length} questions from database`);
            }
        }
        
        // If no database questions, use demo questions
        if (questions.length === 0) {
            console.log('📚 Using demo questions...');
            questions = [
                { 
                    id: 1, 
                    prompt: "Name a food that starts with the letter 'P'", 
                    correct_answers: ["pizza", "pasta", "potato", "pear", "peach", "pineapple", "pancake", "popcorn"],
                    round: 1, 
                    question_order: 1 
                },
                { 
                    id: 2, 
                    prompt: "Name a movie that won an Oscar", 
                    correct_answers: ["titanic", "forrest gump", "the godfather", "schindler's list", "casablanca", "gone with the wind"],
                    round: 1, 
                    question_order: 2 
                },
                { 
                    id: 3, 
                    prompt: "Name a country in Europe", 
                    correct_answers: ["france", "germany", "italy", "spain", "england", "netherlands", "belgium", "switzerland"],
                    round: 1, 
                    question_order: 3 
                },
                { 
                    id: 4, 
                    prompt: "Name a famous scientist", 
                    correct_answers: ["einstein", "newton", "darwin", "curie", "tesla", "galileo", "hawking", "edison"],
                    round: 2, 
                    question_order: 1 
                },
                { 
                    id: 5, 
                    prompt: "Name a type of music genre", 
                    correct_answers: ["rock", "jazz", "pop", "classical", "hip hop", "country", "blues", "electronic"],
                    round: 2, 
                    question_order: 2 
                }
            ];
        }
        
        res.json({
            status: 'success',
            questions: questions,
            count: questions.length,
            source: supabase && supabaseConfigured && questions.length > 0 ? 'database' : 'demo'
        });
        
    } catch (error) {
        console.error('❌ Error loading questions:', error);
        res.status(500).json({
            status: 'error',
            message: 'Failed to load questions',
            error: error.message
        });
    }
});

// Route handlers (duplicate routes removed - they're defined above)

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 MEGASheep server running on port ${PORT}`);
    console.log(`🌐 Visit http://localhost:${PORT} to play!`);
}); 