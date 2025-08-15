const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');


require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');

const fs = require('fs');
// Prefer Node 18+ global fetch; fallback to dynamic import for older runtimes
const fetch = (globalThis && globalThis.fetch)
  ? globalThis.fetch.bind(globalThis)
  : (async (...args) => {
      const { default: nodeFetch } = await import('node-fetch');
      return nodeFetch(...args);
    });

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  transports: ['websocket', 'polling'],
  allowEIO3: true,
  pingTimeout: 30000,   // 30s before timeout (was 120s - too long)
  pingInterval: 5000,   // Ping every 5s (was 10s - more frequent)
  upgradeTimeout: 30000,
  maxHttpBufferSize: 1e6,
  connectionStateRecovery: {
    maxDisconnectionDuration: 30000,  // 30s recovery window (was 60s)
    skipMiddlewares: true
  }
});

// Simple log level control
const LOG_LEVEL = process.env.LOG_LEVEL || 'warn'; // 'silent'|'error'|'warn'|'info'|'debug'
const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
const CUR_LVL = LEVELS[LOG_LEVEL] ?? 3;
const logger = {
  error: (...a) => { if (CUR_LVL >= 1) console.error(...a); },
  warn:  (...a) => { if (CUR_LVL >= 2) console.warn(...a); },
  info:  (...a) => { if (CUR_LVL >= 3) console.log(...a); },
  debug: (...a) => { if (CUR_LVL >= 4) console.log(...a); },
};

// Keepalive handler for display clients
io.on('connection', (socket) => {
  // Player → Host: ask a private question (top-level)
  socket.on('playerQuestion', (data) => {
    try {
  // console.log('💬 playerQuestion received from', socket.id);
      if (!data || typeof data.question !== 'string') {
        try { socket.emit('playerQuestionAck', { ok: false, reason: 'bad-payload' }); } catch (_) {}
        return;
      }
      const question = data.question.trim();
      if (question.length === 0) {
        try { socket.emit('playerQuestionAck', { ok: false, reason: 'empty' }); } catch (_) {}
        return;
      }

      const playerInfo = connectedPlayers.get(socket.id) || {};
      // Prefer socket-associated gameCode; fall back to client-provided gameCode
      const gameCode = playerInfo.gameCode || data.gameCode;
      const playerName = playerInfo.playerName || data.playerName || 'Unknown';

      if (!gameCode) {
        console.log('💬 playerQuestion missing gameCode for socket', socket.id);
        try { socket.emit('playerQuestionAck', { ok: false, reason: 'not-in-game' }); } catch (_) {}
        return;
      }

      const hostEntry = Array.from(connectedPlayers.entries()).find(([_, info]) => info.gameCode === gameCode && info.isHost);
      if (!hostEntry) {
        console.log('💬 No host socket found for Q&A in game', gameCode);
        try { socket.emit('playerQuestionAck', { ok: false, reason: 'no-host' }); } catch (_) {}
        return;
      }
      const hostSocketId = hostEntry[0];
      // console.log('💬 Forwarding question to host', hostSocketId, 'player:', playerName, 'game:', gameCode);
      const at = Date.now();
      io.to(hostSocketId).emit('playerQuestion', { gameCode, playerName, playerSocketId: socket.id, question, at });
      sbInsert(SB_TABLES.qa, { game_code: gameCode, player_name: playerName, player_socket_id: socket.id, question, at: new Date(at).toISOString() });
      sbLogEvent(gameCode, 'player_question', { playerName });
      try { socket.emit('playerQuestionAck', { ok: true }); } catch (_) {}
    } catch (e) {
      console.warn('playerQuestion handling failed', e);
      try { socket.emit('playerQuestionAck', { ok: false, reason: 'error' }); } catch (_) {}
    }
  });

  // Host → Player: answer a private question (top-level)
  socket.on('hostAnswer', (data) => {
    try {
  // console.log('💬 hostAnswer received from', socket.id);
      if (!data || typeof data.answer !== 'string') return;
      const answer = data.answer.trim();
      const { gameCode, targetSocketId, targetPlayerName } = data;
      if (!gameCode || answer.length === 0) return;
      const hostInfo = connectedPlayers.get(socket.id);
      if (!hostInfo || !hostInfo.isHost || hostInfo.gameCode !== gameCode) return;
      const game = activeGames.get(gameCode);
      if (!game) return;
      let targetSid = targetSocketId;
      if (!targetSid && targetPlayerName) {
        const lower = String(targetPlayerName).toLowerCase();
        for (const [sid, p] of game.players.entries()) {
          if (String(p.name || '').toLowerCase() === lower) { targetSid = sid; break; }
        }
      }
      if (!targetSid) return;
      console.log('💬 Forwarding host answer to', targetSid);
      io.to(targetSid).emit('hostAnswer', { gameCode, answer, at: Date.now() });
      try { socket.emit('hostAnswerAck', { ok: true }); } catch (_) {}
    } catch (e) {
      console.warn('hostAnswer handling failed', e);
    }
  });
  socket.on('displayPing', (data) => {
    // no-op; presence keeps transport warm
  });
});

// Cleanup on server shutdown
process.on('SIGINT', () => {
    logger.info('\n🛑 Shutting down server...');
    process.exit(0);
});

process.on('SIGTERM', () => {
    logger.info('\n🛑 Shutting down server...');
    process.exit(0);
});

// Middleware
app.use(cors());
app.use(express.json());
// Note: express.static moved after routes to allow custom routing

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
    logger.info('✅ Supabase configured successfully (table will be created when needed)');
                    supabaseConfigured = true;
                } else if (error) {
                    logger.warn('⚠️  Supabase connection issue:', error.message);
                    logger.warn('🔄 Falling back to demo mode');
                    supabase = null;
                    supabaseConfigured = false;
                } else {
                    logger.info('✅ Supabase configured and connected successfully');
                    supabaseConfigured = true;
                }
            })
            .catch(err => {
                logger.warn('⚠️  Supabase connection failed:', err.message);
                if (err.message.includes('fetch failed') || err.message.includes('network') || err.message.includes('ENOTFOUND')) {
                    logger.warn('🌐 Network issue detected - this is common on public WiFi');
                    logger.warn('🔄 Falling back to demo mode due to network restrictions');
                } else {
                    logger.warn('🔄 Falling back to demo mode');
                }
                supabase = null;
                supabaseConfigured = false;
            });
    } catch (error) {
        logger.warn('⚠️  Supabase configuration error:', error.message);
        logger.warn('🔄 Falling back to demo mode');
        supabase = null;
        supabaseConfigured = false;
    }
} else {
    logger.info('⚠️  Supabase not configured - running in demo mode with sample questions');
}

// Supabase logging helpers (best-effort, never block game flow)
const SB_TABLES = {
  games: 'games',
  players: 'game_players',
  answers: 'answers',
  grading: 'grading_results',
  rounds: 'rounds',
  gameResults: 'game_results',
  qa: 'qa_messages',
  events: 'events',
  attempts: 'attempts',
  snapshots: 'snapshots'
};

function sbNow() { return new Date().toISOString(); }

async function sbInsert(table, row) {
  try {
    if (!supabase || !supabaseConfigured) return;
    await supabase.from(table).insert(row);
  } catch (e) {
    console.log(`⚠️  Supabase insert to ${table} failed:`, e.message);
  }
}

function sbLogEvent(gameCode, type, data) {
  return sbInsert(SB_TABLES.events, { game_code: gameCode, type, data, at: sbNow() });
}

// Game state management
const activeGames = new Map(); // Map of gameCode -> Game
const connectedPlayers = new Map(); // Map of socketId -> PlayerInfo
const activeGameCodes = new Set(); // Track active 4-digit codes
// Defer cleanup of empty games to allow brief reconnects
const emptyGameCleanupTimers = new Map(); // gameCode -> timeoutId
// Temporary display pairing codes: code -> { socketId, createdAt }
const displayPairings = new Map();

// Generate unique 4-digit game code
function generateGameCode() {
    let code;
    do {
        code = Math.floor(1000 + Math.random() * 9000).toString();
    } while (activeGameCodes.has(code));
    
    activeGameCodes.add(code);
    logger.debug(`🎮 Generated new game code: ${code}`);
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
        this.scoresByStableId = new Map(); // stableId -> cumulative score
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
        this.answersNeedingEdit = new Map(); // socketId -> { reason, requestedAt, originalAnswer }
        this.roundAnswerGroups = []; // CRITICAL FIX: Initialize roundAnswerGroups array
        // SIMPLIFIED: Removed answersByStableId, socketByStableId, attemptsByQuestion
        // ONE source of truth: this.answers (socketId -> answer)
        this.seenPlayerNames = new Set(); // Track any name that has ever joined this game
        this.expectedResponders = new Set(); // socketIds expected to answer current question
        this.processedEventIds = new Set(); // de-duplication of critical events
    }

    addPlayer(socketId, playerName, stablePlayerId = null) {
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
            logger.debug(`👤 Player ${playerName} already in game ${this.gameCode}, updating connection`);
            return;
        }
        
        const playerIdentity = stablePlayerId || socketId;
        this.players.set(socketId, {
            id: socketId,
            stableId: playerIdentity,
      name: playerName,
            score: this.scoresByStableId.get(playerIdentity) || 0,
            answers: []
    });
        this.scores.set(socketId, this.scoresByStableId.get(playerIdentity) || 0);
        this.seenPlayerNames.add(playerName);
        
        console.log(`👤 Player ${playerName} added to game ${this.gameCode}`);
    }

    removePlayer(socketId) {
        const player = this.players.get(socketId);
        if (player) {
            this.players.delete(socketId);
            this.scores.delete(socketId);
            this.answers.delete(socketId);
        logger.info(`👤 Player ${player.name} removed from game ${this.gameCode}`);
        }
    }



    // Replace an existing player's socket with a new one for the same stable identity
    replacePlayerSocket(stableId, oldSocketId, newSocketId, playerName) {
        try {
            // Capture any carried answer BEFORE removing old mappings
            let carriedAnswer = null;
            try {
                if (oldSocketId && this.answers.has(oldSocketId)) {
                    carriedAnswer = this.answers.get(oldSocketId);
                } else if (this.answersByStableId.has(stableId)) {
                    carriedAnswer = this.answersByStableId.get(stableId);
                }
            } catch (_) {}

            // Remove old player's entry
            if (oldSocketId && this.players.has(oldSocketId)) {
                this.players.delete(oldSocketId);
                this.scores.delete(oldSocketId);
            }

          // Clean any prior answer for this stableId on current question (old socket only)
          if (oldSocketId && this.answers.has(oldSocketId)) {
              this.answers.delete(oldSocketId);
          }
          // IMPORTANT: Do NOT strip the player's name from currentAnswerGroups here.
          // The groups reflect who answered this question; reconnects should not erase that membership.

            // Rebind mapping to new socket
            const cumulative = this.scoresByStableId.get(stableId) || 0;
            this.players.set(newSocketId, { id: newSocketId, stableId, name: playerName, score: cumulative, answers: [] });
            this.scores.set(newSocketId, cumulative);
            this.socketByStableId.set(stableId, newSocketId);

            // Transfer any pending edit flag to the new socket id
            try {
                if (oldSocketId && this.answersNeedingEdit.has(oldSocketId)) {
                    const payload = this.answersNeedingEdit.get(oldSocketId);
                    this.answersNeedingEdit.delete(oldSocketId);
                    this.answersNeedingEdit.set(newSocketId, payload);
                }
            } catch (_) {}

            // Restore the player's answer for the current question to the new socket, if one existed
            try {
                if (carriedAnswer) {
                    this.answers.set(newSocketId, String(carriedAnswer));
                    // Keep the per-stableId record intact
                    this.answersByStableId.set(stableId, String(carriedAnswer));
                }
            } catch (_) {}

            // Ensure expected responders includes the new socket during playing
            try {
                if (this.gameState === 'playing' && this.expectedResponders instanceof Set) {
                    this.expectedResponders.add(newSocketId);
                }
            } catch (_) {}
        } catch (_) {}
    }

    submitAnswer(socketId, answer) {
        try {
            // SIMPLIFIED: Basic answer submission with edit permission check
            if (!socketId || !this.players || !this.answers || !this.answersNeedingEdit) {
                logger.warn('submitAnswer called with invalid game state');
                return false;
            }
            
        if (this.gameState !== 'playing' && !this.answersNeedingEdit.has(socketId)) return false;
        
            const trimmed = String(answer || '').trim();
        const player = this.players.get(socketId);
            if (!player || !player.name) {
                logger.warn(`submitAnswer: Player not found for socket ${socketId}`);
                return false;
            }

            // Simple rule: one answer per socket during playing (unless edit requested)
            if (this.gameState === 'playing' && this.answers.has(socketId) && !this.answersNeedingEdit.has(socketId)) {
                return false; // Already submitted, locked
            }

            // Set the answer - simple and direct
            this.answers.set(socketId, trimmed);
            logger.info(`📝 ${player.name} submitted: "${trimmed}"`);
            
        return true;
        } catch (e) {
            logger.error('Error in submitAnswer:', e?.message);
            return false;
        }
  }

  calculateScores() {
    const totalResponses = this.answers.size;
        logger.debug(`📊 calculateScores called with ${totalResponses} answers`);
    if (totalResponses === 0) {
      logger.debug('⚠️ No answers to calculate scores for');
      return;
    }
    
    // If we have categorization data from grading, use that for scoring
    if (this.categorizationData && (this.categorizationData.correctAnswerBuckets || this.categorizationData.wrong || this.categorizationData.uncategorized)) {
      logger.debug(`📊 Using categorization data for scoring`);
      this.calculateScoresFromCategorization();
      return;
    }
    
    // Otherwise, use simple text normalization (fallback)
    logger.debug(`📊 Using simple text normalization for scoring (no categorization data)`);
    
    // Group answers by normalized text
    const answerGroups = new Map();
    
    for (const [socketId, answer] of this.answers) {
      const normalizedAnswer = answer.toLowerCase().trim();
      logger.debug(`📝 Processing answer: "${answer}" (normalized: "${normalizedAnswer}") from socket ${socketId}`);
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
    
    logger.debug(`📊 Calculating scores from categorization data`);
    logger.debug(`📊 Categorization data:`, categorizationData);
    
    // Create a map of answer groups based on categorization
    const answerGroups = new Map();
    
    // Process correct answer buckets
    if (categorizationData.correctAnswerBuckets && Array.isArray(categorizationData.correctAnswerBuckets)) {
      for (const bucket of categorizationData.correctAnswerBuckets) {
        if (bucket.answers && Array.isArray(bucket.answers)) {
          // Group all answers in this bucket together
          const socketIdSet = new Set();
          for (const answerData of bucket.answers) {
            // Find the original answer group to get player names (case-insensitive)
            const originalGroup = this.currentAnswerGroups.find(group => 
              group.answer.toLowerCase().trim() === answerData.answer.toLowerCase().trim()
            );
            if (originalGroup && originalGroup.players) {
              // Find socket IDs for these players
              for (const playerName of originalGroup.players) {
                for (const [socketId, player] of this.players) {
                  if (String(player.name).toLowerCase() === String(playerName).toLowerCase()) {
                    socketIdSet.add(socketId);
                    break;
                  }
                }
              }
            }
            // Fallback: if we couldn't resolve via players, include anyone whose live answer matches this text
            const normalizedTarget = String(answerData.answer || '').toLowerCase().trim();
            for (const [sid, ans] of this.answers.entries()) {
              try {
                if (String(ans).toLowerCase().trim() === normalizedTarget) {
                  socketIdSet.add(sid);
                }
              } catch (_) {}
            }
          }
          
          const socketIds = Array.from(socketIdSet);
          if (socketIds.length > 0) {
            // Use the bucket ID as the group key for scoring purposes
            answerGroups.set(bucket.id, socketIds);
            logger.debug(`📊 Grouped bucket "${bucket.id}" with ${socketIds.length} players from answers: ${bucket.answers.map(a => a.answer).join(', ')}`);
          }
        }
      }
    }
    
    // Process wrong answers (each gets their own group)
    if (categorizationData.wrong && Array.isArray(categorizationData.wrong)) {
      for (const answerData of categorizationData.wrong) {
        const normalizedTarget = String(answerData.answer || '').toLowerCase().trim();
        const socketIdSet = new Set();
        // Prefer original group players if available
        const originalGroup = this.currentAnswerGroups.find(group => 
          group.answer.toLowerCase().trim() === normalizedTarget
        );
        if (originalGroup && originalGroup.players) {
          for (const playerName of originalGroup.players) {
            for (const [socketId, player] of this.players) {
              if (String(player.name).toLowerCase() === String(playerName).toLowerCase()) {
                socketIdSet.add(socketId);
                break;
              }
            }
          }
        }
        // Fallback: include any live sockets whose answer text matches
        for (const [sid, ans] of this.answers.entries()) {
          try { if (String(ans).toLowerCase().trim() === normalizedTarget) socketIdSet.add(sid); } catch (_) {}
        }
        const socketIds = Array.from(socketIdSet);
          if (socketIds.length > 0) {
            answerGroups.set(answerData.answer, socketIds);
          logger.debug(`📊 Wrong answer "${answerData.answer}" with ${socketIds.length} players`);
        }
      }
    }
    
    // Process uncategorized answers (each gets their own group)
    if (categorizationData.uncategorized && Array.isArray(categorizationData.uncategorized)) {
      for (const answerData of categorizationData.uncategorized) {
        const normalizedTarget = String(answerData.answer || '').toLowerCase().trim();
        const socketIdSet = new Set();
        // Prefer original group players if available
        const originalGroup = this.currentAnswerGroups.find(group => 
          group.answer.toLowerCase().trim() === normalizedTarget
        );
        if (originalGroup && originalGroup.players) {
          for (const playerName of originalGroup.players) {
            for (const [socketId, player] of this.players) {
              if (String(player.name).toLowerCase() === String(playerName).toLowerCase()) {
                socketIdSet.add(socketId);
                break;
              }
            }
          }
        }
        // Fallback: include any live sockets whose answer text matches
        for (const [sid, ans] of this.answers.entries()) {
          try { if (String(ans).toLowerCase().trim() === normalizedTarget) socketIdSet.add(sid); } catch (_) {}
        }
        const socketIds = Array.from(socketIdSet);
          if (socketIds.length > 0) {
            answerGroups.set(answerData.answer, socketIds);
          logger.debug(`📊 Uncategorized answer "${answerData.answer}" with ${socketIds.length} players`);
        }
      }
    }
    
    this.calculateScoresFromGroups(answerGroups, totalResponses);
  }

  updateAnswerGroupsWithCategorization(categorizationData) {
    logger.debug(`📊 updateAnswerGroupsWithCategorization called with:`, categorizationData);
    
    if (!this.currentAnswerGroups) {
      console.log(`⚠️ No currentAnswerGroups to update`);
      return;
    }
    
    logger.debug(`📊 Starting with ${this.currentAnswerGroups.length} answer groups`);
    
    // Create a map to track which answers have been categorized
    const categorizedAnswers = new Set();
    
    // Process correct answer buckets
    if (categorizationData.correctAnswerBuckets && Array.isArray(categorizationData.correctAnswerBuckets)) {
      logger.debug(`📊 Processing ${categorizationData.correctAnswerBuckets.length} correct answer buckets`);
      for (const bucket of categorizationData.correctAnswerBuckets) {
        logger.debug(`📊 Processing bucket: ${bucket.id} with ${bucket.answers?.length || 0} answers`);
        if (bucket.answers && Array.isArray(bucket.answers)) {
          for (const answerData of bucket.answers) {
            logger.debug(`📊 Looking for answer: "${answerData.answer}"`);
            // Find and update the corresponding answer group
            const answerGroup = this.currentAnswerGroups.find(group => 
              group.answer.toLowerCase().trim() === answerData.answer.toLowerCase().trim()
            );
            if (answerGroup) {
              answerGroup.category = 'correct';
              answerGroup.correctAnswer = bucket.correctAnswer || bucket.name;
              categorizedAnswers.add(answerData.answer.toLowerCase().trim());
              logger.debug(`✅ Categorized "${answerData.answer}" as correct (bucket: "${bucket.correctAnswer || bucket.name}")`);
            } else {
              logger.debug(`⚠️ Could not find answer group for "${answerData.answer}"`);
            }
          }
        }
      }
    }
    
    // Process wrong answers
    if (categorizationData.wrong && Array.isArray(categorizationData.wrong)) {
      logger.debug(`📊 Processing ${categorizationData.wrong.length} wrong answers`);
      for (const answerData of categorizationData.wrong) {
        logger.debug(`📊 Looking for wrong answer: "${answerData.answer}"`);
        const answerGroup = this.currentAnswerGroups.find(group => 
          group.answer.toLowerCase().trim() === answerData.answer.toLowerCase().trim()
        );
        if (answerGroup) {
          answerGroup.category = 'wrong';
          categorizedAnswers.add(answerData.answer.toLowerCase().trim());
          logger.debug(`❌ Categorized "${answerData.answer}" as wrong`);
        } else {
          logger.debug(`⚠️ Could not find answer group for wrong answer "${answerData.answer}"`);
        }
      }
    }
    
    // Mark remaining answers as uncategorized
    logger.debug(`📊 Marking remaining answers as uncategorized`);
    this.currentAnswerGroups.forEach(group => {
      if (!categorizedAnswers.has(group.answer.toLowerCase().trim())) {
        group.category = 'uncategorized';
        logger.debug(`📦 Marked "${group.answer}" as uncategorized`);
      }
    });
    
    logger.debug(`📊 Final result - Updated ${this.currentAnswerGroups.length} answer groups with categorization`);
    logger.debug(`📊 Categorized answers set:`, Array.from(categorizedAnswers));
  }

  calculateScoresFromGroups(answerGroups, totalResponses) {
    // Clear previous question points
    this.pointsForCurrentQuestion.clear();
    
    // Calculate points using Google Sheets formula: Z = Y/X rounded up
    for (const [answer, socketIds] of answerGroups) {
      const X = socketIds.length; // Number of responses matching this answer
      const Y = totalResponses;   // Total number of responses
      
      // Determine if this is a correct answer (bucket ID) or wrong/uncategorized
      // Check if this answer exists in the correctAnswerBuckets
      logger.debug(`🔍 Checking if answer "${answer}" is correct...`);
      if (this.categorizationData && this.categorizationData.correctAnswerBuckets) {
        logger.debug(`🔍 Available buckets: ${this.categorizationData.correctAnswerBuckets.map(b => `"${b.id}"`).join(', ')}`);
        const matchingBucket = this.categorizationData.correctAnswerBuckets.find(bucket => bucket.id === answer);
        logger.debug(`🔍 Matching bucket for "${answer}": ${matchingBucket ? `"${matchingBucket.id}"` : 'none'}`);
      }
      const isCorrectAnswer = this.categorizationData && 
        this.categorizationData.correctAnswerBuckets && 
        this.categorizationData.correctAnswerBuckets.some(bucket => bucket.id === answer);
      const Z = isCorrectAnswer ? Math.ceil(Y / X) : 0; // 0 points for wrong/uncategorized answers
      
      logger.debug(`📊 Answer "${answer}": ${X} players, ${Y} total responses, ${Z} points each (${isCorrectAnswer ? 'correct' : 'wrong/uncategorized'})`);
      
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
      
      // Use the same scoring logic as above
      const isCorrectAnswer = this.categorizationData && 
        this.categorizationData.correctAnswerBuckets && 
        this.categorizationData.correctAnswerBuckets.some(bucket => bucket.id === groupKey);
      const Z = isCorrectAnswer ? Math.ceil(Y / X) : 0;
      
      // If this is a bucket ID (starts with 'correct_'), consolidate under the correct answer name
      if (groupKey.startsWith('correct_') && this.categorizationData) {
        const bucket = this.categorizationData.correctAnswerBuckets.find(b => b.id === groupKey);
        if (bucket) {
          // Extract the correct answer name from the bucket ID (remove 'correct_' prefix and replace underscores and hyphens with spaces)
          const correctAnswerName = groupKey.replace('correct_', '').replace(/[_-]/g, ' ');
          
          this.currentAnswerGroups.push({
            bucketId: groupKey,
            answer: correctAnswerName, // Use the correct answer name, not individual variations
            count: X,
            points: Z,
            totalResponses: Y,
            category: 'correct',
            players: socketIds.map(id => {
              const player = this.players.get(id);
              return player ? player.name : 'Unknown';
            })
          });
        }
      } else {
        // For direct bucket IDs or wrong/uncategorized answers, use the group key as the answer
        // Use the calculated points Z (which is 0 for wrong answers, correct points for bucket IDs)
        
        // Determine the category based on the group key
        let category = 'uncategorized';
        if (this.categorizationData && this.categorizationData.correctAnswerBuckets) {
          const isCorrect = this.categorizationData.correctAnswerBuckets.some(bucket => bucket.id === groupKey);
          if (isCorrect) {
            category = 'correct';
          } else if (this.categorizationData.wrong && this.categorizationData.wrong.some(wrong => wrong.answer === groupKey)) {
            category = 'wrong';
          }
        }
        
        this.currentAnswerGroups.push({
          bucketId: groupKey,
          answer: groupKey.replace(/[_-]/g, ' '), // Convert hyphens and underscores to spaces for display
          count: X,
          points: Z, // Use calculated points (0 for wrong, correct points for valid buckets)
          totalResponses: Y,
          category: category, // Add the category
          players: socketIds.map(id => {
            const player = this.players.get(id);
            return player ? player.name : 'Unknown';
          })
        });
      }
    }
    
    // Sort by points (highest first)
    this.currentAnswerGroups.sort((a, b) => b.points - a.points);
    
    logger.debug(`📊 Calculated scores for ${totalResponses} answers in ${answerGroups.size} groups`);
  }

  applyCurrentQuestionPoints() {
    if (this.currentQuestionScored) {
    logger.debug(`⚠️ Current question already scored, skipping duplicate scoring`);
      return;
    }
    
    logger.debug(`📊 Applying current question points to cumulative scores`);
    
    // Add current question points to cumulative scores
        // Migrate scoring from socket IDs to stable IDs if available
        const stableScores = new Map();
    for (const [socketId, points] of this.pointsForCurrentQuestion) {
      const player = this.players.get(socketId);
            const stableId = player?.stableId || socketId;
            const currentScore = stableScores.get(stableId) ?? 0;
            stableScores.set(stableId, currentScore + points);
        }

        // Apply to cumulative scores and reflect on live players sharing that stableId
        for (const [stableId, addPoints] of stableScores) {
            // Find any live socket for this stableId
            for (const [sid, p] of this.players.entries()) {
                if ((p.stableId || p.id) === stableId) {
                    const currentScore = this.scores.get(sid) || 0;
                    const newScore = currentScore + addPoints;
                    this.scores.set(sid, newScore);
                    p.score = newScore;
        logger.debug(`📊 Player ${p.name} [stable=${stableId}]: ${currentScore} + ${addPoints} = ${newScore}`);
                }
            }
            // Always persist cumulative score per stableId
            const cur = this.scoresByStableId.get(stableId) || 0;
            this.scoresByStableId.set(stableId, cur + addPoints);
    }
    
    this.currentQuestionScored = true;
    logger.debug(`✅ Current question points applied to cumulative scores`);
  }

  resetQuestionScoring() {
    try {
        if (this.pointsForCurrentQuestion && typeof this.pointsForCurrentQuestion.clear === 'function') {
    this.pointsForCurrentQuestion.clear();
        }
    this.currentQuestionScored = false;
    this.currentAnswerGroups = [];
    this.categorizationData = null;
        
        if (this.answers && typeof this.answers.clear === 'function') {
            this.answers.clear();
        }
        if (this.answersNeedingEdit && typeof this.answersNeedingEdit.clear === 'function') {
            this.answersNeedingEdit.clear();
        }
        
        logger.debug(`🔄 Reset for new question`);
    } catch (e) {
        logger.error('Error in resetQuestionScoring:', e?.message);
        // Initialize safe defaults if something went wrong
        this.currentAnswerGroups = [];
        this.categorizationData = null;
        this.currentQuestionScored = false;
    }
  }

  // CRITICAL FIX: Rebuild answer groups from current live answers
  // This ensures grading interface always shows the latest answer state
  rebuildCurrentAnswerGroups() {
    try {
        // Safety checks
        if (!this.answers || !this.players) {
            logger.warn('rebuildCurrentAnswerGroups: Missing required data structures');
            this.currentAnswerGroups = [];
            return;
        }
        
        const groupMap = new Map();
        
        // Group current live answers by normalized text
        // EXCLUDE answers that are pending edits (they should not appear in grading)
        for (const [socketId, answer] of this.answers.entries()) {
            if (!socketId || answer === undefined || answer === null) continue;
            
            // Skip answers that are flagged for editing
            if (this.answersNeedingEdit && this.answersNeedingEdit.has(socketId)) {
                logger.debug(`🚫 Excluding pending edit answer from ${socketId}`);
                continue;
            }
            
            const player = this.players.get(socketId);
            if (!player || !player.name) continue;
            
            const normalizedAnswer = String(answer || '').toLowerCase().trim();
            if (!normalizedAnswer) continue; // Skip empty answers
            
            if (!groupMap.has(normalizedAnswer)) {
                groupMap.set(normalizedAnswer, {
                    answer: String(answer), // Use original case, ensure string
                    players: [],
                    count: 0,
                    points: 0,
                    index: groupMap.size
                });
            }
            
            const group = groupMap.get(normalizedAnswer);
            if (group && group.players && !group.players.includes(player.name)) {
                group.players.push(String(player.name)); // Ensure string
                group.count = group.players.length;
            }
        }
        
        this.currentAnswerGroups = Array.from(groupMap.values());
        logger.debug(`🔄 Rebuilt ${this.currentAnswerGroups.length} answer groups from ${this.answers.size} live answers`);
        
        // DEBUG: Log detailed rebuild info
        console.log(`🔄 REBUILD DEBUG: Created ${this.currentAnswerGroups.length} groups from ${this.answers.size} answers`);
        console.log(`🔄 REBUILD DEBUG: Answer groups:`, this.currentAnswerGroups.map(g => `"${g.answer}" (${g.count} players: ${g.players.join(', ')})`));
        console.log(`🔄 REBUILD DEBUG: Raw answers:`, Array.from(this.answers.entries()).map(([sid, ans]) => `${sid}: "${ans}"`));
        console.log(`🔄 REBUILD DEBUG: Excluded pending edits:`, Array.from(this.answersNeedingEdit.keys()));
    } catch (e) {
        logger.error('Failed to rebuild answer groups:', e?.message);
        // Ensure we don't leave undefined state
        this.currentAnswerGroups = this.currentAnswerGroups || [];
    }
  }

  getGameState() {
    try {
      return {
              gameCode: this.gameCode,
              hostId: this.hostId,
        players: Array.from(this.players?.values() || []),
        currentRound: this.currentRound || 0,
        currentQuestion: this.currentQuestion || 0,
        currentQuestionData: (this.questions && this.questions[this.currentQuestion]) ? this.questions[this.currentQuestion] : null,
        gameState: this.gameState || 'waiting',
        scores: this.scores ? Object.fromEntries(this.scores) : {},
        questions: this.questions || [],
              currentAnswerGroups: this.currentAnswerGroups || [],
              categorizationData: this.categorizationData || null,
        timeLeft: this.timeLeft || 0,
        roundHistory: this.roundHistory || [],
              questionsPerRound: this.settings?.questionsPerRound || 5,
              createdAt: this.createdAt || new Date().toISOString(),
              playerCount: this.players ? this.players.size : 0,
              isTestMode: this.isTestMode || false,
              pendingEdits: (() => {
                try {
                  if (!this.answersNeedingEdit || this.answersNeedingEdit.size === 0) return [];
                  return Array.from(this.answersNeedingEdit.entries()).map(([sid, info]) => {
                    const player = this.players ? this.players.get(sid) : null;
                    return {
                      socketId: sid,
                      playerName: player?.name || 'Unknown',
                      originalAnswer: info?.originalAnswer || '',
                      reason: info?.reason || 'Please be more specific'
                    };
                  });
                } catch (error) {
                  console.error('❌ Error processing pendingEdits in getGameState:', error);
                  return [];
                }
              })()
          };
    } catch (error) {
      console.error('❌ CRITICAL ERROR in getGameState():', error);
      console.error('❌ Error stack:', error.stack);
      
      // Return a minimal safe game state
      return {
        gameCode: this.gameCode || 'UNKNOWN',
        hostId: this.hostId || 'UNKNOWN',
        players: [],
        currentRound: 0,
        currentQuestion: 0,
        currentQuestionData: null,
        gameState: 'error',
        scores: {},
        questions: [],
        currentAnswerGroups: [],
        categorizationData: null,
        timeLeft: 0,
        roundHistory: [],
        questionsPerRound: 5,
        createdAt: new Date().toISOString(),
        playerCount: 0,
        isTestMode: false,
        pendingEdits: []
      };
    }
    }

  startTimer() {
    this.timeLeft = this.settings.timerDuration || 30;
        logger.info(`⏰ Starting timer with ${this.timeLeft} seconds for game ${this.gameCode}`);
        
        // Clear any existing timer
        this.stopTimer();
    
    // Emit initial timer value and establish expected responders for this question
        io.to(this.gameCode).emit('timerUpdate', { timeLeft: this.timeLeft });
    try {
      this.expectedResponders = new Set(Array.from(this.players.keys()));
    } catch(_) {}
    
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
        logger.info(`⏰ Time up for game ${this.gameCode}`);
        
        if (this.gameState === 'playing') {
            logger.debug(`📊 Calculating scores for game ${this.gameCode} with ${this.answers.size} answers`);
            this.calculateScores();
            this.gameState = 'grading'; // Changed from 'scoring' to 'grading'
            
            logger.info(`🎯 Game ${this.gameCode} moved to grading state with ${this.currentAnswerGroups?.length || 0} answer groups`);
            
            // Emit results requiring grading
            const gameStateToSend = this.getGameState();
            logger.debug('📤 Sending questionComplete from handleTimeUp');
            
            // Debug: Check who's in the room
            const roomSockets = await io.in(this.gameCode).fetchSockets();
            logger.debug(`🔍 Room ${this.gameCode} has ${roomSockets.length} sockets`);
            
            try { await persistSnapshot(this, 'question_complete'); } catch(_) {}
            io.to(this.gameCode).emit('questionComplete', gameStateToSend);
        }
    }

    nextQuestion() {
        // Before moving to next question, save current answer groups to round history
        if (this.currentAnswerGroups && this.currentAnswerGroups.length > 0) {
            this.roundAnswerGroups.push(...this.currentAnswerGroups);
            console.log(`📊 Added ${this.currentAnswerGroups.length} answer groups to round history. Total: ${this.roundAnswerGroups.length}`);
        }
        // Ensure we applied points for the current question before changing state
        if (!this.currentQuestionScored) {
            try { this.applyCurrentQuestionPoints(); } catch (_) {}
        }
        
        // Check if we're starting a new round
        const currentRound = Math.ceil((this.currentQuestion + 1) / this.settings.questionsPerRound);
        const nextQuestionInRound = ((this.currentQuestion) % this.settings.questionsPerRound) + 1;
        
        // DEVELOPMENT: For testing, trigger round complete after 2 questions instead of 5
        const questionsForRoundComplete = process.env.NODE_ENV === 'development' ? 2 : this.settings.questionsPerRound;
        
        console.log(`🔍 Round logic debug: currentQuestion=${this.currentQuestion}, currentRound=${currentRound}, nextQuestionInRound=${nextQuestionInRound}, questionsForRoundComplete=${questionsForRoundComplete}, NODE_ENV=${process.env.NODE_ENV}`);
        console.log(`🔍 Round complete condition check: nextQuestionInRound (${nextQuestionInRound}) === questionsForRoundComplete (${questionsForRoundComplete}) = ${nextQuestionInRound === questionsForRoundComplete}`);
        
        // If the next question would be the last question of the current round, complete the round instead
        if (nextQuestionInRound === questionsForRoundComplete) {
        logger.debug(`🎯 Triggering round complete: nextQuestionInRound (${nextQuestionInRound}) === questionsForRoundComplete (${questionsForRoundComplete})`);
            this.completeRound();
        } else if (this.currentQuestion >= this.questions.length) {
            logger.info(`🎯 Game finished: currentQuestion (${this.currentQuestion}) >= questions.length (${this.questions.length})`);
            this.gameState = 'finished';
            io.to(this.gameCode).emit('gameFinished', this.getGameState());
        } else {
            // Increment to next question
            this.currentQuestion++;
            this.answers.clear();
            
            // Reset question scoring state for the new question (also mark previous question as not scored)
            this.resetQuestionScoring();
            this.currentQuestionScored = false;

            // Clear any pending clarification flags for the new question
            if (this.answersNeedingEdit) {
                this.answersNeedingEdit.clear();
            }
            
            logger.info(`🎯 Continuing to next question: currentQuestion=${this.currentQuestion}, gameState=playing`);
            this.gameState = 'playing';
            
            // CRITICAL FIX: Add safety checks and error handling for question progression
            try {
                this.startTimer();
            } catch (error) {
                console.error(`❌ Error starting timer for question ${this.currentQuestion}:`, error);
            }
            
            try { 
                persistSnapshot(this, 'question_started'); 
            } catch (error) {
                console.error(`❌ Error persisting snapshot:`, error);
            }
            
            try {
                sbLogEvent(this.gameCode, 'next_question', { q: this.currentQuestion });
            } catch (error) {
                console.error(`❌ Error logging next_question event:`, error);
            }
            
            // CRITICAL: Add comprehensive error handling for socket emission
            try {
                const gameState = this.getGameState();
                console.log(`🎯 Emitting nextQuestion for game ${this.gameCode}, question ${this.currentQuestion}`);
                console.log(`🎯 GameState valid:`, !!gameState);
                console.log(`🎯 Current question data:`, !!gameState.currentQuestionData);
                
                io.to(this.gameCode).emit('nextQuestion', gameState);
                console.log(`✅ Successfully emitted nextQuestion event`);
            } catch (error) {
                console.error(`❌ CRITICAL ERROR emitting nextQuestion:`, error);
                console.error(`❌ Error stack:`, error.stack);
                
                // Try a simpler emission as fallback
                try {
                    io.to(this.gameCode).emit('gameError', { 
                        message: 'Error starting next question', 
                        error: error.message 
                    });
                } catch (fallbackError) {
                    console.error(`❌ Even fallback emission failed:`, fallbackError);
                }
            }
        }
    }

    completeRound() {
        console.log(`🎯 completeRound() called for game ${this.gameCode}`);
        // Ensure latest question points are applied to cumulative totals
        if (!this.currentQuestionScored) {
            try { this.applyCurrentQuestionPoints(); } catch (_) {}
        }
        
        // Derive round from the just-finished question index (0-based -> +1)
        const currentRound = Math.ceil((this.currentQuestion + 1) / this.settings.questionsPerRound);
        const roundStartQuestion = (currentRound - 1) * this.settings.questionsPerRound + 1;
        const roundEndQuestion = Math.min(currentRound * this.settings.questionsPerRound, this.questions.length);
        
        // Calculate round-specific scores by summing points from this round's answer groups
        const roundSpecificScores = new Map();
        
        // Initialize all players with 0 points for this round
        Array.from(this.players.values()).forEach(player => {
            roundSpecificScores.set(player.name, 0);
        });
        
        // Sum up points from this round's answer groups
        if (this.roundAnswerGroups && this.roundAnswerGroups.length > 0) {
            this.roundAnswerGroups.forEach(group => {
                if (group.players && group.players.length > 0) {
                    // Points are already calculated per player during question scoring
                    const pointsPerPlayer = group.points;
                    group.players.forEach(playerName => {
                        const currentScore = roundSpecificScores.get(playerName) || 0;
                        roundSpecificScores.set(playerName, currentScore + pointsPerPlayer);
                    });
                }
            });
        }
        
        // Create round summary data using accumulated answer groups
        const roundData = {
            roundNumber: currentRound,
            questionStart: roundStartQuestion,
            questionEnd: roundEndQuestion,
            players: Array.from(this.players.values()).map(player => ({
                name: player.name,
                score: roundSpecificScores.get(player.name) || 0
            })),
            answerGroups: this.roundAnswerGroups || []
        };

        // Build per-player answers for the round using the accumulated roundAnswerGroups
        try {
            const playerAnswersByName = {};
            (this.roundAnswerGroups || []).forEach(group => {
                const entry = {
                    answer: group.answer,
                    points: group.points || 0,
                    bucketId: group.bucketId || null
                };
                (group.players || []).forEach(playerName => {
                    if (!playerAnswersByName[playerName]) playerAnswersByName[playerName] = [];
                    playerAnswersByName[playerName].push(entry);
                });
            });
            roundData.playerAnswersByName = playerAnswersByName;
        } catch (_) {}
        
        console.log(`🎯 Round ${currentRound} completed for game ${this.gameCode}. Answer groups in round: ${this.roundAnswerGroups.length}`);
        console.log(`📊 Round data:`, JSON.stringify(roundData, null, 2));
        
        this.roundHistory.push(roundData);
        // Persist round summary
        sbInsert(SB_TABLES.rounds, { game_code: this.gameCode, round_number: currentRound, data: roundData, at: sbNow() });
        sbLogEvent(this.gameCode, 'round_complete', { round: currentRound });
        
        // Check if this is the final round (hard stop at 5 rounds)
        const totalRounds = Math.min(5, Math.ceil(this.questions.length / this.settings.questionsPerRound));
        
        if (currentRound >= totalRounds) {
            // This is the final round, show overall leaderboard
            console.log(`🏆 Final round (${currentRound}) completed. Showing overall leaderboard.`);
            this.gameState = 'overallLeaderboard';
            
            // Emit to display
            io.to(this.gameCode).emit('showOverallLeaderboard', this.getGameState());
            
            // Emit to host to update button state
            const hostSocket = Array.from(io.sockets.sockets.values()).find(socket => 
                socket.gameCode === this.gameCode && socket.isHost
            );
            if (hostSocket) {
                hostSocket.emit('gameStateUpdate', { gameState: this.getGameState() });
            }
        } else {
            // Not the final round, proceed normally
            this.gameState = 'roundComplete';
            
            console.log(`🎯 Game state set to 'roundComplete' for game ${this.gameCode}`);
            
            // Reset round answer groups for next round
            this.roundAnswerGroups = [];
            
            console.log(`🎯 Emitting 'roundComplete' event to game ${this.gameCode}`);
            try { persistSnapshot(this, 'round_complete'); } catch(_) {}
            io.to(this.gameCode).emit('roundComplete', this.getGameState());
            console.log(`🎯 'roundComplete' event emitted successfully`);
        }
    }

    continueToNextRound() {
        const totalRounds = Math.min(5, Math.ceil(this.questions.length / this.settings.questionsPerRound));
        const currentRound = Math.ceil((this.currentQuestion + 1) / this.settings.questionsPerRound);
        if (currentRound >= totalRounds) {
            // Do not advance past final round
            this.gameState = 'overallLeaderboard';
            io.to(this.gameCode).emit('showOverallLeaderboard', this.getGameState());
            return;
        }
        if (this.currentQuestion >= this.questions.length) {
            this.gameState = 'finished';
            io.to(this.gameCode).emit('gameFinished', this.getGameState());
        } else {
            // Start the next round without triggering round completion logic
            this.startNextRound();
        }
    }

    startNextRound() {
        // Increment to next question
        this.currentQuestion++;
        
        // Check if the next question exists
        if (this.currentQuestion >= this.questions.length) {
            console.log(`🎯 Game finished: currentQuestion (${this.currentQuestion}) >= questions.length (${this.questions.length})`);
            this.gameState = 'finished';
            io.to(this.gameCode).emit('gameFinished', this.getGameState());
            return;
        }
        
        this.answers.clear();
        
        // Reset question scoring state for the new question
        this.resetQuestionScoring();
        
        console.log(`🎯 Starting next round: currentQuestion=${this.currentQuestion}, gameState=playing`);
        this.gameState = 'playing';
        this.startTimer();
        io.to(this.gameCode).emit('nextQuestion', this.getGameState());
    }

    cleanup() {
        this.stopTimer();
        activeGameCodes.delete(this.gameCode);
        console.log(`🧹 Cleaned up game ${this.gameCode}`);
    }


}

// Simple text normalization utility
function normalizeText(text) {
    return text.toLowerCase().trim();
}



// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/host', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'host.html'));
});

app.get('/welcome', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
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

// Static file middleware AFTER custom routes
app.use(express.static(path.join(__dirname, 'public')));

app.get('/upload', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'upload.html'));
});



// List snapshots (Supabase-first, then disk)
app.get('/api/snapshots/:gameCode', async (req, res) => {
  const gameCode = String(req.params.gameCode || '').trim();
  if (!gameCode) return res.json({ status: 'error', message: 'Missing game code' });
  const results = { status: 'success', gameCode, supabase: [], disk: [] };
  try {
    if (supabase && supabaseConfigured) {
      const { data, error } = await supabase
        .from(SB_TABLES.snapshots)
        .select('game_code, phase, at')
        .eq('game_code', gameCode)
        .order('at', { ascending: false })
        .limit(50);
      if (!error && data) results.supabase = data;
    }
  } catch(_) {}
  try {
    const files = fs.readdirSync(snapshotsDir)
      .filter(f => f.startsWith(`${gameCode}__`) && f.endsWith('.json'))
      .sort()
      .reverse()
      .slice(0, 50);
    results.disk = files;
  } catch(_) {}
  res.json(results);
});

// Recover game from latest snapshot
app.post('/api/recover-game', async (req, res) => {
  try {
    const { gameCode } = req.body || {};
    if (!gameCode) return res.status(400).json({ status: 'error', message: 'gameCode required' });
    // If game already exists, return its state
    const existing = activeGames.get(gameCode);
    if (existing) {
      return res.json({ status: 'success', recovered: false, gameState: existing.getGameState() });
    }
    const snap = await loadLatestSnapshot(String(gameCode));
    if (!snap) return res.status(404).json({ status: 'error', message: 'No snapshot found for gameCode' });
    const game = restoreGameFromSnapshot(snap);
    if (!game) return res.status(500).json({ status: 'error', message: 'Failed to restore game' });
    // Announce recovery in events log
    sbLogEvent(game.gameCode, 'game_recovered', { phase: snap?.phase, at: snap?.at });
    // Return state; clients will rebind via join/reconnect
    return res.json({ status: 'success', recovered: true, gameState: game.getGameState() });
  } catch (e) {
    console.error('❌ recover-game failed:', e?.message);
    return res.status(500).json({ status: 'error', message: 'recover failed' });
  }
});

// Snapshot persistence helpers
function serializeGame(game) {
  try {
                return {
      gameCode: game.gameCode,
      hostId: game.hostId,
      players: Array.from(game.players.entries()).map(([sid, p]) => ({ socketId: sid, stableId: p.stableId || p.id, name: p.name, score: p.score })),
      scoresByStableId: Object.fromEntries(game.scoresByStableId),
      currentRound: game.currentRound,
      currentQuestion: game.currentQuestion,
      questions: game.questions,
      gameState: game.gameState,
      timeLeft: game.timeLeft,
      currentAnswerGroups: game.currentAnswerGroups,
      categorizationData: game.categorizationData,
      roundHistory: game.roundHistory,
      settings: game.settings,
      createdAt: game.createdAt
    };
  } catch (e) {
    return { error: 'serialize_failed', message: e?.message };
  }
}

async function persistSnapshot(game, phase) {
  try {
    const payload = {
      game_code: game.gameCode,
      phase,
      at: sbNow(),
      snapshot: serializeGame(game)
    };
    sbInsert(SB_TABLES.snapshots, payload);
    try { await writeSnapshotToDisk(payload); } catch(_) {}
  } catch (_) {}
}

// Disk snapshot storage (redundancy when Supabase is unavailable)
const snapshotsDir = path.join(__dirname, 'snapshots');
try { if (!fs.existsSync(snapshotsDir)) fs.mkdirSync(snapshotsDir, { recursive: true }); } catch(_) {}

async function writeSnapshotToDisk(payload) {
  try {
    const safeCode = String(payload.game_code || 'unknown');
    const ts = new Date(payload.at || Date.now()).toISOString().replace(/[:.]/g, '-');
    const filename = `${safeCode}__${payload.phase || 'snapshot'}__${ts}.json`;
    const filepath = path.join(snapshotsDir, filename);
    fs.writeFileSync(filepath, JSON.stringify(payload, null, 2), 'utf-8');
  } catch (e) {
    console.warn('⚠️ Failed to write disk snapshot', e?.message);
  }
}

async function loadLatestSnapshot(gameCode) {
  // Prefer Supabase when configured
  if (supabase && supabaseConfigured) {
    try {
      const { data, error } = await supabase
        .from(SB_TABLES.snapshots)
        .select('*')
        .eq('game_code', gameCode)
        .order('at', { ascending: false })
        .limit(1);
      if (error) throw error;
      if (data && data.length > 0) return data[0];
    } catch (e) {
      console.warn('⚠️ Supabase loadLatestSnapshot failed:', e?.message);
    }
  }
  // Fallback to disk: pick most recent by filename timestamp
  try {
    const files = fs.readdirSync(snapshotsDir)
      .filter(f => f.startsWith(`${gameCode}__`) && f.endsWith('.json'))
      .sort() // ISO-ish timestamp in name ensures lexicographic order
      .reverse();
    if (files.length === 0) return null;
    const filepath = path.join(snapshotsDir, files[0]);
    const content = fs.readFileSync(filepath, 'utf-8');
    return JSON.parse(content);
  } catch (e) {
    console.warn('⚠️ Disk loadLatestSnapshot failed:', e?.message);
    return null;
  }
}

function restoreGameFromSnapshot(snap) {
  try {
    const s = snap?.snapshot || snap; // accept raw snapshot
    if (!s || !s.gameCode || !s.hostId) throw new Error('Invalid snapshot');
    const game = new Game(s.hostId, s.gameCode);
    // Assign core fields
    game.questions = Array.isArray(s.questions) ? s.questions : [];
    game.currentRound = Number(s.currentRound) || 0;
    game.currentQuestion = Number(s.currentQuestion) || 0;
    game.gameState = s.gameState || 'waiting';
    game.timeLeft = Number(s.timeLeft) || game.timeLeft;
    game.currentAnswerGroups = Array.isArray(s.currentAnswerGroups) ? s.currentAnswerGroups : [];
    game.categorizationData = s.categorizationData || null;
    game.roundHistory = Array.isArray(s.roundHistory) ? s.roundHistory : [];
    game.settings = s.settings || game.settings;
    game.createdAt = s.createdAt || Date.now();
    // Scores by stable ID
    if (s.scoresByStableId) {
      try { game.scoresByStableId = new Map(Object.entries(s.scoresByStableId)); } catch(_) {}
    }
    // Do not repopulate live players (no sockets). Players will rebind; cumulative scores persist by stableId.
    
    activeGames.set(game.gameCode, game);
    activeGameCodes.add(game.gameCode);
    console.log(`✅ Restored game ${game.gameCode} from snapshot (state=${game.gameState})`);
    return game;
  } catch (e) {
    console.error('❌ Failed to restore game from snapshot:', e?.message);
    return null;
  }
}



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
    
    // CRITICAL FIX: Allow joining during any game state for reconnections and mid-game joins
    // Remove restriction that prevented joining after game started
    
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
    // console.log('🔌 User connected:', socket.id);
    
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
        // Prefer explicit gameCode from client (same request cycle as REST creation)
        const requestedCode = data && data.gameCode ? String(data.gameCode) : null;
        let hostGame = null;
        if (requestedCode && activeGames.has(requestedCode)) {
            hostGame = activeGames.get(requestedCode);
        } else {
            // Fallback: most recently created game
            let latestGame = null;
            let latestTime = 0;
            for (const [, game] of activeGames) {
                if (game.createdAt > latestTime) {
                    latestTime = game.createdAt;
                    latestGame = game;
                }
            }
            hostGame = latestGame;
        }
        if (!hostGame) {
            socket.emit('gameError', { message: 'No game found. Please create a game first.' });
            return;
        }
        // Update connection info securely for this host socket
        const playerInfo = connectedPlayers.get(socket.id);
        if (playerInfo) {
            playerInfo.gameCode = hostGame.gameCode;
            playerInfo.playerName = hostGame.hostId;
            playerInfo.isHost = true;
        }
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

    // Join game (allow mid-game joins; returning names can rebind)
    socket.on('joinGame', (data) => {
        // Reduced verbose logging in production for joinGame
        const { gameCode, playerName, playerId } = data;
        
        if (!gameCode || !playerName) {
            console.log('❌ joinGame: Missing gameCode or playerName');
            socket.emit('gameError', { message: 'Game code and player name are required' });
            return;
        }
        
        // console.log(`🔍 joinGame: Looking for game ${gameCode}`);
        const game = activeGames.get(gameCode);
        if (!game) {
            console.log(`❌ joinGame: Game ${gameCode} not found`);
            socket.emit('gameError', { message: 'Game not found. Please check the game code.' });
            return;
        }
        
        // Reduced verbose logging for player lists
        
        // Mid-game join policy: allow new players to join anytime; they simply won't be counted for the current question
        
        try {
            // console.log(`🔍 joinGame: Processing join for ${playerName} to game ${gameCode}`);
            
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
                const alreadyInGame = Array.from(game.players.values()).some(p => p.name === playerName);
                if (!alreadyInGame) {
                    // console.log(`🔍 joinGame: Adding ${playerName} to game ${gameCode}`);
                    game.addPlayer(socket.id, playerName, playerId || null);
                    // Log player join
                    sbInsert(SB_TABLES.players, { game_code: gameCode, socket_id: socket.id, player_name: playerName, joined_at: sbNow() });
                    sbLogEvent(gameCode, 'player_joined', { playerName });
                    // If a question is currently active, INCLUDE late joiner as expected responder per preference
                    if (game.gameState === 'playing' && game.expectedResponders instanceof Set) {
                        try { game.expectedResponders.add(socket.id); } catch(_) {}
                    }
                    // If game already started, do not disturb state; just update clients
                    io.to(gameCode).emit('playerJoined', game.getGameState());
                } else {
                    // Rebind returning player to new socket: replace prior socket for this stable identity
                    const prior = Array.from(game.players.entries()).find(([sid, p]) => p.name === playerName && sid !== socket.id);
                    const stable = (playerId || prior?.[1]?.stableId || socket.id);
                    if (prior) {
                        game.replacePlayerSocket(stable, prior[0], socket.id, playerName);
                    } else {
                        const cumulative = game.scoresByStableId.get(stable) || 0;
                        game.players.set(socket.id, { id: socket.id, stableId: (playerId || null), name: playerName, score: cumulative, answers: [] });
                        if (!game.scores.has(socket.id)) game.scores.set(socket.id, cumulative);
                    }
                    // Include rebinder in expected responders during playing
                    if (game.gameState === 'playing' && game.expectedResponders instanceof Set) {
                        try { game.expectedResponders.add(socket.id); } catch(_) {}
                    }
                    io.to(gameCode).emit('playerJoined', game.getGameState());
                    sbLogEvent(gameCode, 'player_rebound', { playerName });
                }

                // Simple: Check if returning player has pending edit
                if (game.answersNeedingEdit.has(socket.id)) {
                    const editInfo = game.answersNeedingEdit.get(socket.id);
                    io.to(socket.id).emit('requireAnswerEdit', { reason: editInfo.reason, originalAnswer: editInfo.originalAnswer });
                    logger.info(`✏️ Re-sent edit request to reconnecting ${playerName}`);
                }
            } else {
            // console.log('🏠 Host joined room', gameCode);
            }
            
            // console.log(`🔍 joinGame: Adding socket to room ${gameCode}`);
            socket.join(gameCode);
            
            // Confirm to player
            // console.log(`🔍 joinGame: Sending gameJoined response`);
            const gameStateToSend = game.getGameState();
            // Reduced extra joinGame logging
            
            // Test JSON serialization
            // Serialization test removed
            
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

  // SIMPLIFIED: Host requests a player's answer edit ("Send Back")
    socket.on('hostRequestEdit', (data) => {
        const { gameCode, playerSocketId, playerName, reason } = data || {};
        const hostInfo = connectedPlayers.get(socket.id);
        if (!hostInfo || !hostInfo.isHost || hostInfo.gameCode !== gameCode) {
            return;
        }
        
        const game = activeGames.get(gameCode);
    if (!game) return;
    
    // Find target player by socketId or name
    let targetSocketId = playerSocketId;
    if (!targetSocketId && playerName) {
      for (const [sid, p] of game.players.entries()) {
        if (p.name.toLowerCase() === playerName.toLowerCase()) {
          targetSocketId = sid;
          break;
        }
      }
    }
    
    if (!targetSocketId || !game.players.has(targetSocketId)) return;
    
    const original = game.answers.get(targetSocketId) || '';
    game.answersNeedingEdit.set(targetSocketId, { reason: reason || 'Please be more specific', originalAnswer: original });
    
    // DEBUG: Log clarification request
    console.log(`🚨 HOST REQUESTED EDIT: targetSocketId=${targetSocketId}, playerName=${playerName}`);
    console.log(`🚨 Original answer: "${original}"`);
    console.log(`🚨 answersNeedingEdit now has ${game.answersNeedingEdit.size} entries`);
    console.log(`🚨 answersNeedingEdit contains targetSocketId: ${game.answersNeedingEdit.has(targetSocketId)}`);
    
    // Rebuild answer groups to exclude the pending edit from grading
    try {
        game.rebuildCurrentAnswerGroups();
    } catch (e) {
        logger.error('Failed to rebuild answer groups after edit request:', e?.message);
    }
    
    // Send edit request to player if connected
    if (connectedPlayers.has(targetSocketId)) {
    io.to(targetSocketId).emit('requireAnswerEdit', { reason: reason || 'Please be more specific', originalAnswer: original });
        logger.info(`✏️ Clarification sent to ${game.players.get(targetSocketId)?.name}`);
    }
    
    // Broadcast updated game state to grading interface (shows pending edits banner)
    const gameStateToSend = game.getGameState();
    io.to(gameCode).emit('gameStateUpdate', gameStateToSend);
    logger.debug('📤 Sent gameStateUpdate after edit request');
  });



    // Test room membership
    socket.on('testRoomMembership', (data) => {
        const { gameCode } = data;
        // console.log(`🔍 Player ${socket.id} testing room membership for game ${gameCode}`);
        
        // Check if player is in the room
        const rooms = socket.rooms;
        // console.log(`🔍 Player ${socket.id} is in rooms:`, Array.from(rooms));
        
        if (rooms.has(gameCode)) {
                // console.log(`✅ Player ${socket.id} is correctly in room ${gameCode}`);
        } else {
                // console.log(`❌ Player ${socket.id} is NOT in room ${gameCode}`);
        }
    });

    // Ping test
    socket.on('ping', (data) => {
        // Minimal ping logging
        socket.emit('pong', { message: 'Server pong', timestamp: Date.now() });
    });

    // Start game
    socket.on('startGame', async (data) => {
        // console.log('🎮 startGame event received from socket:', socket.id);
        
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

            // Prefer any preloaded question set (e.g., from host Question Picker)
            if (Array.isArray(game.questions) && game.questions.length > 0) {
                questions = game.questions;
                console.log(`🗂️ Using preloaded question set for game ${gameCode}: ${questions.length} questions`);
            } else if (supabase && supabaseConfigured) {
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
                    
            // Reduced verbose debug logging in production
                    
                    // Map database fields to expected format
                    questions = dbQuestions.map(q => ({
                        id: q.id,
                        prompt: q.prompt,  // Database field is already called 'prompt'
                        round: q.round,
                        question_order: q.question_order,
                        correct_answers: Array.isArray(q.correct_answers) ? q.correct_answers : [q.correct_answers].filter(Boolean)
                    }));
                    
                    // Reduced verbose debug logging in production
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
            
            // EMERGENCY DEBUG: Log room membership when starting game
            const roomSockets = io.sockets.adapter.rooms.get(gameCode);
            const roomSocketArray = roomSockets ? Array.from(roomSockets) : [];
            console.log(`🚨 EMERGENCY DEBUG: Starting game ${gameCode}`);
            console.log(`🚨 Room ${gameCode} has ${roomSocketArray.length} sockets: ${roomSocketArray.join(', ')}`);
            console.log(`🚨 Game has ${game.players.size} players: ${Array.from(game.players.values()).map(p => `${p.name}(${p.id})`).join(', ')}`);
            console.log(`🚨 Emitting gameStarted to room ${gameCode}`);
            
            io.to(gameCode).emit('gameStarted', gameStateToSend);
            
            // Also emit directly to each player socket as backup
            for (const [socketId, player] of game.players.entries()) {
                try {
                    console.log(`🚨 BACKUP: Sending gameStarted directly to ${player.name} (${socketId})`);
                    io.to(socketId).emit('gameStarted', gameStateToSend);
                } catch (e) {
                    console.log(`🚨 BACKUP FAILED for ${player.name}: ${e.message}`);
                }
            }
            
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
        try {
        if (!data) {
            logger.warn('submitAnswer event received with no data');
            return;
        }
        
        const { gameCode, answer } = data;
        
            if (!gameCode || answer === undefined || answer === null) {
                logger.warn('submitAnswer event received with missing gameCode or answer');
            return;
        }
        
        const playerInfo = connectedPlayers.get(socket.id);
        if (!playerInfo || playerInfo.gameCode !== gameCode) return;
        
        const game = activeGames.get(gameCode);
        if (!game) return;
        
        // CRITICAL FIX: Check for clarification BEFORE submitAnswer to ensure proper rebuild
        const wasClarity = game.answersNeedingEdit.has(socket.id);
        
        // DEBUG: Log clarification detection
        console.log(`🔍 CLARIFICATION DEBUG: socketId=${socket.id}, wasClarity=${wasClarity}`);
        console.log(`🔍 answersNeedingEdit size before clear: ${game.answersNeedingEdit.size}`);
        console.log(`🔍 answersNeedingEdit has socketId: ${game.answersNeedingEdit.has(socket.id)}`);
        console.log(`🔍 ALL answersNeedingEdit socketIds:`, Array.from(game.answersNeedingEdit.keys()));
        console.log(`🔍 Current submitAnswer socketId: ${socket.id}`);
        console.log(`🔍 Game state: ${game.gameState}`);
        
        if (game.submitAnswer(socket.id, answer)) {
            // CRITICAL: Clear edit flag AFTER successful submitAnswer but BEFORE rebuild
            if (wasClarity) {
                game.answersNeedingEdit.delete(socket.id);
                console.log(`🔍 Cleared clarification flag for ${socket.id} AFTER successful submit but BEFORE rebuild`);
            }
            
            // ENHANCED DEBUG: Log current answer state before rebuild
            console.log(`🔍 BEFORE REBUILD - Answer in game.answers: "${game.answers.get(socket.id)}"`);
            console.log(`🔍 BEFORE REBUILD - answersNeedingEdit has socketId: ${game.answersNeedingEdit.has(socket.id)}`);
            console.log(`🔍 BEFORE REBUILD - Total answers in game: ${game.answers.size}`);
            
            socket.emit('answerSubmitted');
            const playerName = playerInfo.playerName;
            
            logger.info(`🎯 ${playerName} submitted: "${answer}"${wasClarity ? ' (clarification)' : ''}`);
            
            // Simple answer groups rebuild - now clarified answers will be included
            try {
                game.rebuildCurrentAnswerGroups();
                console.log(`🔍 AFTER REBUILD - Created ${game.currentAnswerGroups.length} answer groups`);
                console.log(`🔍 AFTER REBUILD - Groups:`, game.currentAnswerGroups.map(g => `"${g.answer}" (${g.players.join(', ')})`));
                
                // FORCE IMMEDIATE UPDATE: Ensure grading interfaces get the latest state
                const gameStateToSend = game.getGameState();
                console.log(`🔍 Sending immediate gameStateUpdate for clarification - groups: ${gameStateToSend.currentAnswerGroups?.length || 0}`);
                io.to(gameCode).emit('gameStateUpdate', gameStateToSend);
                
            } catch (e) {
                logger.error('Failed to rebuild answer groups after submission:', e?.message);
                // Continue without crashing - grading interface will still work with existing groups
            }
            
            // Notify host of the specific answer
            const hostSocket = Array.from(connectedPlayers.entries())
                .find(([id, info]) => info.gameCode === gameCode && info.isHost);
            
            // Send gameStateUpdate for ALL submissions to keep grading interface in sync
            const gameStateToSend = game.getGameState();
            console.log(`📤 SENDING gameStateUpdate for ${wasClarity ? 'CLARIFICATION' : 'REGULAR'} submission by ${playerName}`);
            console.log(`📤 gameState contains ${gameStateToSend.currentAnswerGroups?.length || 0} answer groups`);
            
            // Send to host and grading interface
            if (hostSocket) {
                io.to(hostSocket[0]).emit('gameStateUpdate', gameStateToSend);
                console.log('📤 Sent gameStateUpdate to host');
            }
            
            // Also broadcast to room for any other connected grading interfaces
            io.to(gameCode).emit('gameStateUpdate', gameStateToSend);
            console.log('📤 Sent gameStateUpdate to room');
            
            if (hostSocket) {
                console.log(`📤 [server] Emitting answerSubmitted to host socket ${hostSocket[0]} for player ${playerName}`);
                io.to(hostSocket[0]).emit('answerSubmitted', {
                    playerName: playerName,
                    answer: answer
                });

      // Q&A handlers are registered at top-level (outside submitAnswer)
            } else {
                console.log(`❌ [server] No host socket found for game ${gameCode}`);
            }
            
            // Notify grading interface of new answer (real-time updates)
            console.log(`📡 [server] Broadcasting newAnswerSubmitted to room ${gameCode} for ${playerName}: "${answer}"`);
            console.log(`📤 Room ${gameCode} sockets:`, Array.from(io.sockets.adapter.rooms.get(gameCode) || []));
            
            io.to(gameCode).emit('newAnswerSubmitted', {
                playerName: playerName,
                answer: answer,
                gameCode: gameCode,
                at: Date.now()
            });
            
            console.log(`✅ newAnswerSubmitted event emitted to room ${gameCode}`);
            
            // Notify others of answer count (unique by stableId); also include a raw answers snapshot for UIs that need it
            const totalExpected = (game.gameState === 'playing' && game.expectedResponders instanceof Set)
                ? game.expectedResponders.size
                : game.players.size;
            const stableAnswered = new Set();
            const rawAnswers = {};
            for (const [sid, ans] of game.answers.entries()) {
                const p = game.players.get(sid);
                const st = p?.stableId || sid;
                stableAnswered.add(st);
                rawAnswers[sid] = ans;
            }
            io.to(gameCode).emit('answerUpdate', {
                answersReceived: stableAnswered.size,
                totalPlayers: totalExpected,
                answers: rawAnswers
            });
            
            // Do not auto-end when all have answered; host or timer ends the question now
            if (game.answersNeedingEdit.size > 0) {
                console.log(`⏳ Not auto-ending: ${game.answers.size}/${game.players.size} answers, ${game.answersNeedingEdit.size} pending clarifications`);
            }
        } else {
            logger.info(`🚫 ${playerInfo.playerName} answer rejected`);
        }
        } catch (e) {
            logger.error('Error in submitAnswer event handler:', e?.message);
            // Send error to client so they know submission failed
            try {
                socket.emit('answerError', { message: 'Failed to submit answer' });
            } catch (_) {}
        }
    });



    // Complete grading (mandatory before next question)
    socket.on('completeGrading', async (data) => {
        console.log('🎯 completeGrading event received:', data);
        
        if (!data) {
            console.log('⚠️ completeGrading event received with no data');
            return;
        }
        
        // CRITICAL FIX: Validate data structure to prevent issues
        if (!data.gameCode) {
            console.error('❌ completeGrading missing gameCode');
            socket.emit('gameError', { message: 'Missing game code in grading data' });
            return;
        }
        
        if (!data.categorizedAnswers) {
            console.error('❌ completeGrading missing categorizedAnswers');
            socket.emit('gameError', { message: 'Missing categorized answers in grading data' });
            return;
        }
        
        console.log('🎯 Grading data validation passed');
        
        const { gameCode, categorizedAnswers } = data;
        
        if (!gameCode) {
            console.log('⚠️ completeGrading event received with no gameCode');
            return;
        }
        
        const playerInfo = connectedPlayers.get(socket.id);
        if (!playerInfo || !playerInfo.isHost) return;
        
        const game = activeGames.get(gameCode);
        if (!game) return;
        
        // Allow host to complete grading even if the question hasn't been explicitly ended yet.
        // If currently playing, finalize answers and enter grading implicitly.
        if (game.gameState === 'playing') {
            try {
                game.calculateScores();
                game.stopTimer();
                game.gameState = 'grading';
            } catch (_) {}
        } else if (game.gameState !== 'grading') {
            // For any other state, proceed conservatively by transitioning to grading
            // if we have answer data; otherwise reject.
            if (game.answers && game.answers.size >= 0) {
                try {
                    game.calculateScores();
                    game.stopTimer();
                    game.gameState = 'grading';
                } catch (_) {}
            } else {
                socket.emit('gameError', { message: 'Not in grading phase' });
                return;
            }
        }
        
        try {
            // Normalize categorized answers structure defensively
            const normalized = {
                correctAnswerBuckets: Array.isArray(categorizedAnswers?.correctAnswerBuckets) ? [...categorizedAnswers.correctAnswerBuckets] : [],
                wrong: Array.isArray(categorizedAnswers?.wrong) ? [...categorizedAnswers.wrong] : [],
                uncategorized: Array.isArray(categorizedAnswers?.uncategorized) ? [...categorizedAnswers.uncategorized] : []
            };

            // Sort correct buckets for stable order
            if (normalized.correctAnswerBuckets) {
                normalized.correctAnswerBuckets.sort((a, b) => {
                    const nameA = a.name || a.id || '';
                    const nameB = b.name || b.id || '';
                    return nameA.localeCompare(nameB);
                });
            }

            game.categorizationData = normalized;

            // Update current groups with categories if any groups exist
            console.log(`📊 Updating currentAnswerGroups with categorization data`);
            console.log(`📊 Before update - currentAnswerGroups length:`, game.currentAnswerGroups?.length || 0);
            if (game.currentAnswerGroups && game.currentAnswerGroups.length > 0) {
                game.updateAnswerGroupsWithCategorization(normalized);
                console.log(`📊 After update - currentAnswerGroups length:`, game.currentAnswerGroups?.length || 0);
            }

            // Reset points and recalc scores from answers with categorization applied
            game.pointsForCurrentQuestion.clear();
            console.log(`📊 Recalculating scores based on categorization data`);
            game.calculateScores();

            // Apply points once
            game.applyCurrentQuestionPoints();

            // Move to scoring phase
            game.gameState = 'scoring';

            const gameStateToSend = game.getGameState();
            // Persist authoritative snapshot BEFORE notifying clients
            try { 
                await persistSnapshot(game, 'grading_complete'); 
            } catch(error) {
                console.error('❌ Error persisting grading_complete snapshot:', error);
            }
            
            // CRITICAL FIX: Add comprehensive error handling for gradingComplete emission
            try {
                console.log(`🎯 Emitting gradingComplete for game ${gameCode}`);
                console.log(`🎯 GameState data valid:`, !!gameStateToSend);
                console.log(`🎯 Room exists:`, io.sockets.adapter.rooms.has(gameCode));
                
                io.to(gameCode).emit('gradingComplete', gameStateToSend);
                console.log(`✅ Successfully emitted gradingComplete event`);
                console.log(`📝 Host completed grading for game ${gameCode}`);
            } catch (emitError) {
                console.error(`❌ CRITICAL ERROR emitting gradingComplete:`, emitError);
                console.error(`❌ Error stack:`, emitError.stack);
                
                // Try a fallback emission
                try {
                    io.to(gameCode).emit('gameError', { 
                        message: 'Error completing grading', 
                        error: emitError.message 
                    });
                } catch (fallbackError) {
                    console.error(`❌ Even fallback emission failed:`, fallbackError);
                }
            }
            // Persist grading results snapshot
            try {
              const payload = {
                game_code: gameCode,
                question_index: game.currentQuestion,
                results: game.currentAnswerGroups,
                at: sbNow()
              };
              sbInsert(SB_TABLES.grading, payload);
              sbLogEvent(gameCode, 'grading_complete', { q: game.currentQuestion });
            } catch(_) {}
        } catch (err) {
            console.error('❌ completeGrading failed, forcing transition to scoring:', err);
            try {
                // Best-effort fallback: ensure state progresses
                game.applyCurrentQuestionPoints();
                game.gameState = 'scoring';
                io.to(gameCode).emit('gradingComplete', game.getGameState());
            } catch (_) {}
        }
    });

    // Next question (only after grading is complete)
    socket.on('nextQuestion', (data) => {
        try {
            console.log('🎯 nextQuestion event received:', data);
            
            if (!data) {
                console.log('⚠️ nextQuestion event received with no data');
                return;
            }
            
            const { gameCode } = data;
            
            if (!gameCode) {
                console.log('⚠️ nextQuestion event received with no gameCode');
                return;
            }
            
            console.log(`🎯 Processing nextQuestion for game: ${gameCode}`);
            
            const playerInfo = connectedPlayers.get(socket.id);
            if (!playerInfo || !playerInfo.isHost) {
                console.log(`⚠️ nextQuestion rejected - not host. PlayerInfo:`, playerInfo);
                return;
            }
            
            const game = activeGames.get(gameCode);
            if (!game) {
                console.log(`⚠️ nextQuestion rejected - game not found: ${gameCode}`);
                return;
            }
            
            console.log(`🎯 Game state check: ${game.gameState}, currentQuestion: ${game.currentQuestion}`);
            
            if (game.gameState !== 'scoring' && game.gameState !== 'roundComplete') {
                console.log(`⚠️ nextQuestion rejected - invalid state: ${game.gameState}`);
                socket.emit('gameError', { message: 'Must complete grading before proceeding' });
                return;
            }
            
            // Server-side hard stop: do not advance beyond 5 rounds
            const totalRounds = Math.min(5, Math.ceil(game.questions.length / game.settings.questionsPerRound));
            const currentRound = Math.ceil((game.currentQuestion + 1) / game.settings.questionsPerRound);
            console.log(`🎯 Round check: currentRound=${currentRound}, totalRounds=${totalRounds}`);
            
            if (currentRound >= totalRounds && game.gameState === 'roundComplete') {
                console.log(`🏆 Final round reached, showing overall leaderboard`);
                try {
                    game.gameState = 'overallLeaderboard';
                    io.to(gameCode).emit('showOverallLeaderboard', game.getGameState());
                } catch (leaderboardError) {
                    console.error(`❌ Error showing leaderboard:`, leaderboardError);
                    socket.emit('gameError', { message: 'Error showing final leaderboard' });
                }
                return;
            }
            
            console.log(`🎯 About to call game.nextQuestion() for game ${gameCode}`);
            
            // CRITICAL: Wrap the nextQuestion call in comprehensive error handling
            try {
                game.nextQuestion();
                console.log(`✅ Successfully called game.nextQuestion() for game ${gameCode}`);
            } catch (nextQuestionError) {
                console.error(`❌ CRITICAL ERROR in game.nextQuestion():`, nextQuestionError);
                console.error(`❌ Error stack:`, nextQuestionError.stack);
                
                // Try to recover gracefully
                try {
                    socket.emit('gameError', { 
                        message: 'Error starting next question', 
                        error: nextQuestionError.message 
                    });
                } catch (recoveryError) {
                    console.error(`❌ Even error recovery failed:`, recoveryError);
                }
            }
            
        } catch (overallError) {
            console.error(`❌ CRITICAL ERROR in nextQuestion handler:`, overallError);
            console.error(`❌ Error stack:`, overallError.stack);
            
            try {
                socket.emit('gameError', { 
                    message: 'Server error processing next question', 
                    error: overallError.message 
                });
            } catch (finalError) {
                console.error(`❌ Final error handling failed:`, finalError);
            }
        }
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
        
        if (game.gameState !== 'roundComplete' && game.gameState !== 'overallLeaderboard') {
            socket.emit('gameError', { message: 'Game is not in round complete or overall leaderboard state' });
            return;
        }
        
        console.log(`🎯 Host continuing to next round for game ${gameCode}`);
        game.continueToNextRound();
    });

  // Explicitly show current round leaderboard on public display
  socket.on('showRoundLeaderboard', (data) => {
    if (!data) return;
    const { gameCode } = data;
    if (!gameCode) return;
    const playerInfo = connectedPlayers.get(socket.id);
    if (!playerInfo || !playerInfo.isHost) return;
    const game = activeGames.get(gameCode);
    if (!game) return;
    // Ensure state is at least roundComplete for display context
    if (game.gameState !== 'roundComplete') {
      game.gameState = 'roundComplete';
    }
    const state = game.getGameState();
    // Public display
    io.to(gameCode).emit('roundComplete', state);
    // Players: request them to show their round results screen as well
    io.to(gameCode).emit('playerShowRoundResults', state);
            sbLogEvent(gameCode, 'show_round_leaderboard', {});
  });

    // Show overall leaderboard (from round complete screen after round 2+)
    socket.on('showOverallLeaderboard', (data) => {
        if (!data) {
            console.log('⚠️ showOverallLeaderboard event received with no data');
            return;
        }
        
        const { gameCode } = data;
        
        if (!gameCode) {
            console.log('⚠️ showOverallLeaderboard event received with no gameCode');
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
        
        console.log(`📊 Host showing overall leaderboard for game ${gameCode}`);
        game.gameState = 'overallLeaderboard'; // Set new state instead of 'finished'
        
        // Emit to display and players
        const state = game.getGameState();
        io.to(gameCode).emit('showOverallLeaderboard', state);
        io.to(gameCode).emit('playerShowOverallLeaderboard', state);
        
        // Emit to host to update button state
        socket.emit('gameStateUpdate', { gameState: state });
    });

    // TEMP: Show End Game demo on display with synthetic data
    socket.on('showEndGameDemo', (data) => {
        if (!data) return;
        const { gameCode } = data;
        if (!gameCode) return;
        const playerInfo = connectedPlayers.get(socket.id);
        if (!playerInfo || !playerInfo.isHost) return;
        const game = activeGames.get(gameCode);
        if (!game) return;

        // Build a synthetic state based on current players with mock scores if needed
        const players = Array.from(game.players.values());
        let samplePlayers;
        if (players.length >= 50) {
            samplePlayers = players;
        } else if (players.length > 0) {
            // Use current players then fill to 50 with mock players
            samplePlayers = [...players];
            const needed = 50 - players.length;
            for (let i = 0; i < needed; i++) {
                const idx = i + 1;
                samplePlayers.push({ name: `Fuzzy Friend ${idx}`, score: Math.max(0, 85 - i) + Math.floor(Math.random()*40) });
            }
        } else {
            // Full mock set of 50 players
            samplePlayers = Array.from({ length: 50 }, (_, i) => ({
                name: `Fuzzy Friend ${i+1}`,
                score: 150 - i - Math.floor(Math.random() * 10)
            }));
            // Replace top three with themed names
            samplePlayers[0].name = 'Ewe-nited'; samplePlayers[0].score = 180;
            samplePlayers[1].name = 'Baa-Raiser'; samplePlayers[1].score = 165;
            samplePlayers[2].name = 'Shear Genius'; samplePlayers[2].score = 160;
        }

        // Ensure descending scores
        samplePlayers.sort((a,b)=> (b.score||0)-(a.score||0));

        const state = {
            ...game.getGameState(),
            gameState: 'overallLeaderboard',
            players: samplePlayers
        };

        // Emit explicit overall leaderboard event to render podium/message
        io.to(gameCode).emit('showOverallLeaderboard', state);
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
        
        try { await persistSnapshot(game, 'question_complete'); } catch(_) {}
        io.to(gameCode).emit('questionComplete', gameStateToSend);
    });

    // End game
    socket.on('endGame', (data) => {
        console.log('🎮 endGame event received from socket:', socket.id);
        console.log('🎮 endGame data:', data);
        
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
        if (!playerInfo || !playerInfo.isHost) {
            console.log('⚠️ endGame event received from non-host player');
            return;
        }
        
        const game = activeGames.get(gameCode);
        if (!game) {
            console.log('⚠️ endGame event received for non-existent game:', gameCode);
            return;
        }
        
        console.log(`🎮 Ending game ${gameCode} - emitting gameFinished event`);
        
        // Set game state to finished before getting the state
        game.gameState = 'finished';
        
        // Get game state after setting to finished
        const gameState = game.getGameState();
        console.log(`🎮 Game state before cleanup:`, gameState.gameState);
        
        game.cleanup();
        activeGames.delete(gameCode);
        
        // Emit to all clients in the game room
        io.to(gameCode).emit('gameFinished', gameState);
        
        console.log(`🎮 Game ${gameCode} ended by host - gameFinished event emitted`);
        // Persist game final snapshot
        sbInsert(SB_TABLES.gameResults, { game_code: gameCode, final_state: gameState, ended_at: sbNow() });
        try { persistSnapshot(game, 'game_finished'); } catch(_) {}
        sbLogEvent(gameCode, 'game_finished', {});
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

    // Generate a short pairing code for a display screen
    socket.on('requestDisplayPairingCode', () => {
        // Generate unique 4-letter code (A-Z)
        function generateCode() {
            const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
            let code = '';
            for (let i = 0; i < 4; i++) code += letters[Math.floor(Math.random() * letters.length)];
            return code;
        }
        let code;
        do { code = generateCode(); } while (displayPairings.has(code));
        displayPairings.set(code, { socketId: socket.id, createdAt: Date.now() });
        socket.emit('displayPairingCode', { code });
        console.log(`📺 Issued display pairing code ${code} for socket ${socket.id}`);
    });

    // Host pairs a display (identified by pairing code) to a game
    socket.on('pairDisplayToGame', (data) => {
        const { pairingCode, gameCode } = data || {};
        if (!pairingCode || !gameCode) return;
        const hostInfo = connectedPlayers.get(socket.id);
        if (!hostInfo || !hostInfo.isHost) return;
        const pairing = displayPairings.get((pairingCode || '').toUpperCase());
        const game = activeGames.get(gameCode);
        if (!pairing || !game) {
            io.to(socket.id).emit('pairDisplayResult', { ok: false, message: 'Invalid code or game not found' });
            return;
        }
        const displaySocketId = pairing.socketId;
        const displaySocket = io.sockets.sockets.get(displaySocketId);
        if (!displaySocket) {
            displayPairings.delete((pairingCode || '').toUpperCase());
            io.to(socket.id).emit('pairDisplayResult', { ok: false, message: 'Display disconnected' });
            return;
        }
        // Update display connection info
        const info = connectedPlayers.get(displaySocketId) || { id: displaySocketId };
        info.gameCode = gameCode;
        info.isDisplay = true;
        connectedPlayers.set(displaySocketId, info);
        // Join room and send current game state to display
        displaySocket.join(gameCode);
        displaySocket.emit('displayGameState', game.getGameState());
        // Clear the pairing code (one-time use)
        displayPairings.delete((pairingCode || '').toUpperCase());
        // Ack host
        io.to(socket.id).emit('pairDisplayResult', { ok: true, message: `Display paired to game ${gameCode}` });
        console.log(`🔗 Paired display ${displaySocketId} -> game ${gameCode} via code ${pairingCode}`);
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

    // Join grading session for collaborative grading interfaces
    socket.on('joinGradingSession', (data) => {
        const { gameCode, questionIndex, graderId } = data;
        
        if (!gameCode) {
            console.log('⚠️ joinGradingSession event received with no gameCode');
            socket.emit('gradingError', { message: 'Game code is required' });
            return;
        }
        
        const game = activeGames.get(gameCode);
        if (!game) {
            console.log(`❌ Game ${gameCode} not found for joinGradingSession`);
            socket.emit('gradingError', { message: 'Game not found' });
            return;
        }
        
        // Update connection info for grading interface
        const playerInfo = connectedPlayers.get(socket.id);
        if (playerInfo) {
            playerInfo.gameCode = gameCode;
            playerInfo.isGradingInterface = true;
            playerInfo.graderId = graderId;
            playerInfo.questionIndex = questionIndex;
        }
        
        // Join the game room to receive real-time updates
        socket.join(gameCode);
        
        // Count current graders in this game room
        const roomSockets = io.sockets.adapter.rooms.get(gameCode) || new Set();
        let graderCount = 0;
        roomSockets.forEach(socketId => {
            const info = connectedPlayers.get(socketId);
            if (info && info.isGradingInterface) {
                graderCount++;
            }
        });
        
        // Confirm successful join
        socket.emit('gradingSessionJoined', {
            gameCode: gameCode,
            questionIndex: questionIndex,
            graderCount: graderCount
        });
        
        // Notify other graders that someone joined
        socket.to(gameCode).emit('graderJoined', {
            graderId: graderId,
            graderCount: graderCount
        });
        
        console.log(`📝 Grading interface joined session ${gameCode} for question ${questionIndex} (grader: ${graderId})`);
        console.log(`📝 Room ${gameCode} now has ${graderCount} graders out of ${roomSockets.size} total sockets`);
        console.log(`📝 Socket ${socket.id} grading session info:`, {
            gameCode: playerInfo?.gameCode,
            isGradingInterface: playerInfo?.isGradingInterface,
            graderId: playerInfo?.graderId,
            questionIndex: playerInfo?.questionIndex
        });
    });

    // Leave grading session
    socket.on('leaveGradingSession', (data) => {
        const { gameCode, graderId } = data;
        
        const playerInfo = connectedPlayers.get(socket.id);
        if (playerInfo && playerInfo.gameCode === gameCode) {
            // Leave the game room
            socket.leave(gameCode);
            
            // Count remaining graders
            const roomSockets = io.sockets.adapter.rooms.get(gameCode) || new Set();
            let graderCount = 0;
            roomSockets.forEach(socketId => {
                const info = connectedPlayers.get(socketId);
                if (info && info.isGradingInterface) {
                    graderCount++;
                }
            });
            
            // Notify other graders that someone left
            socket.to(gameCode).emit('graderLeft', {
                graderId: graderId,
                graderCount: graderCount
            });
            
            console.log(`📝 Grading interface left session ${gameCode} (grader: ${graderId})`);
            console.log(`📝 Room ${gameCode} now has ${graderCount} graders remaining`);
        }
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

    // Player leave game handler for manual disconnect
    socket.on('leaveGame', (data) => {
        const { gameCode, playerName } = data;
        console.log(`🚪 Player ${playerName} manually leaving game ${gameCode}`);
        
        const playerInfo = connectedPlayers.get(socket.id);
        if (playerInfo && playerInfo.gameCode === gameCode) {
            const game = activeGames.get(gameCode);
            if (game) {
                // Remove player immediately (no grace period for manual leave)
                game.removePlayer(socket.id);
                console.log(`👋 Removed player ${playerName} from game ${gameCode}`);
                
                // Notify host about player leaving
                const hostSocket = Array.from(connectedPlayers.entries())
                    .find(([id, info]) => info.gameCode === gameCode && info.isHost);
                
                if (hostSocket) {
                    hostSocket[1].socket?.emit('playerLeft', {
                        playerName: playerName,
                        gameCode: gameCode,
                        totalPlayers: game.players.size
                    });
                }
            }
            
            // Remove from connected players
            connectedPlayers.delete(socket.id);
            console.log(`🧹 Cleaned up socket ${socket.id} for manual leave`);
        }
    });

    // Disconnect
    socket.on('disconnect', () => {
        const playerInfo = connectedPlayers.get(socket.id);
        
        if (playerInfo && playerInfo.gameCode) {
            const game = activeGames.get(playerInfo.gameCode);
            if (game) {
                if (!playerInfo.isDisplay) {
                    // Delay removal to tolerate brief reconnects; defer deletion check until after grace
                    setTimeout(() => {
                        // If the same socket id has re-appeared, skip removal
                        const stillConnected = connectedPlayers.has(socket.id);
                        if (stillConnected) return;
                        // Remove from players and expected responders
                        try { if (game.expectedResponders instanceof Set) game.expectedResponders.delete(socket.id); } catch(_) {}
                        game.removePlayer(socket.id);
                        io.to(playerInfo.gameCode).emit('playerLeft', game.getGameState());
                        if (game.players.size === 0) {
                            const code = playerInfo.gameCode;
                            setTimeout(() => {
                                const g = activeGames.get(code);
                                if (g && g.players.size === 0) {
                                    g.cleanup();
                                    activeGames.delete(code);
                                    console.log(`🏠 Removed empty game: ${code}`);
                                }
                            }, 5000);
                        }
                    }, 3000);
                } else {
                    console.log(`📺 Display disconnected from game ${playerInfo.gameCode}`);
                }
            }
        }
        
        // Defer deletion until after grace: mark a timestamp so rebind can be detected
        setTimeout(() => {
            connectedPlayers.delete(socket.id);
        }, 3000);
        // Cleanup any pairing codes issued to this socket
        for (const [code, entry] of displayPairings.entries()) {
            if (entry.socketId === socket.id) displayPairings.delete(code);
        }
        console.log('🔌 User disconnected:', socket.id);
    });
});

function tryAutoAnswer(sock, state, gameCode) {
  try {
    if (!state || state.gameState !== 'playing') return;
    const q = state.currentQuestionData || (Array.isArray(state.questions) ? state.questions[state.currentQuestion] : null);
    const correct = Array.isArray(q?.correct_answers) ? q.correct_answers : [];
    // 60% chance answer from correct list, 40% random wrong
    const pickCorrect = Math.random() < 0.6 && correct.length > 0;
    let answer;
    if (pickCorrect) {
      answer = correct[Math.floor(Math.random() * correct.length)];
    } else {
      const wrongs = ['banana', 'sheep', 'mars', 'blue', 'caterpillar', '42', 'october'];
      answer = wrongs[Math.floor(Math.random() * wrongs.length)];
    }
    // Random delay 0.5s–8s to simulate human typing
    setTimeout(()=>{
      try { sock.emit('submitAnswer', { gameCode, answer }); } catch(_) {}
    }, 500 + Math.floor(Math.random()*7500));
  } catch(_) {}
}

// API Endpoints
app.post('/api/create-game', (req, res) => {
    const { hostName } = req.body;
    
    // Use default host name if not provided
    const finalHostName = hostName || 'Host';
    
    try {
        const game = new Game(finalHostName);
        activeGames.set(game.gameCode, game);
        // Persist game created
        sbInsert(SB_TABLES.games, { game_code: game.gameCode, host_name: finalHostName, created_at: sbNow() });
        try { persistSnapshot(game, 'game_created'); } catch(_) {}
        sbLogEvent(game.gameCode, 'game_created', { host: finalHostName });
        
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
    
    // Use authoritative gameState instead of non-existent game.status
    if (game.gameState !== 'waiting') {
        return res.status(400).json({ 
            status: 'error', 
            message: 'Game has already started' });
    }
    
    // Check if game is full
    if (game.settings.maxPlayers > 0 && game.players.size >= game.settings.maxPlayers) {
        return res.status(400).json({ status: 'error', message: 'Game is full' });
    }
    
    // Check for duplicate names (only among connected players)
    const existingPlayer = Array.from(game.players.values()).find(p => p.name === playerName);
    if (existingPlayer) {
        // Check if this player is still connected
        const existingPlayerInfo = connectedPlayers.get(existingPlayer.id);
        if (existingPlayerInfo && existingPlayerInfo.playerName === playerName) {
            return res.status(400).json({ status: 'error', message: 'Player name already taken' });
        }
    }
    
    res.json({ 
        status: 'success', 
        message: 'Ready to join game',
        // Include gameCode so clients can reliably emit join over sockets
        gameCode: game.gameCode,
        gameState: game.getGameState()
    });
});

app.get('/api/game/:gameCode', (req, res) => {
    const { gameCode } = req.params;
    
    const game = activeGames.get(gameCode);
    if (!game) {
        return res.status(404).json({ status: 'error', message: 'Game not found' });
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