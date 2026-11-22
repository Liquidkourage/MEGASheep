const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');
const dns = require('dns');
try { dns.setDefaultResultOrder('ipv4first'); } catch (_) {}

require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');
const { loadQuestionsFromFile } = require('./loadQuestions');
const lockstep = require('./lockstep');
const {
    postgresEnabled,
    initPostgres,
    fetchPostgresQuestions,
    appendPostgresQuestions,
    replacePostgresQuestions,
    insertPostgresSnapshot,
    loadLatestPostgresSnapshot,
    listPostgresSnapshots
} = require('./db');

const fs = require('fs');
const crypto = require('crypto');
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
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());
// Note: express.static moved after routes to allow custom routing

// Supabase configuration — keep the client even if the first probe fails
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
        supabaseConfigured = true;
        logger.info('🔑 Supabase keys present — will use the database when reachable');
    } catch (error) {
        logger.warn('⚠️  Supabase configuration error:', error.message);
        supabase = null;
        supabaseConfigured = false;
    }
} else {
    logger.info('⚠️  Supabase not configured — using the on-disk show bank, then demo questions');
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

const QUESTIONS_FILE = path.join(__dirname, 'sample-questions.txt');
const DEMO_QUESTIONS = [
    { id: 1, prompt: "Name a food that starts with the letter 'P'", correct_answers: ["pizza", "pasta", "potato", "pear", "peach", "pineapple", "pancake", "popcorn"], round: 1, question_order: 1 },
    { id: 2, prompt: "Name a movie that won an Oscar", correct_answers: ["titanic", "forrest gump", "the godfather", "schindler's list", "casablanca", "gone with the wind"], round: 1, question_order: 2 },
    { id: 3, prompt: "Name a country in Europe", correct_answers: ["france", "germany", "italy", "spain", "england", "netherlands", "belgium", "switzerland"], round: 1, question_order: 3 },
    { id: 4, prompt: "Name a famous scientist", correct_answers: ["einstein", "newton", "darwin", "curie", "tesla", "galileo", "hawking", "edison"], round: 1, question_order: 4 },
    { id: 5, prompt: "Name a type of music genre", correct_answers: ["rock", "jazz", "pop", "classical", "hip hop", "country", "blues", "electronic"], round: 1, question_order: 5 },
    { id: 6, prompt: "A 4-letter word found in the title of a play by William Shakespeare (including contractions, common titles only, no Roman numerals)", correct_answers: ["all's", "ends", "john", "king", "lear", "like", "lost", "much", "part", "tale", "that", "tyre", "well"], round: 2, question_order: 1 },
    { id: 7, prompt: "A \"G\"-starting film that grossed at least $300 million worldwide (not counting leading articles, be specific)", correct_answers: ["guardians of the galaxy", "gravity", "ghost", "gladiator", "grease", "gone with the wind", "gone girl", "goldeneye"], round: 2, question_order: 2 },
    { id: 8, prompt: "A US state that borders another US state for over 400 miles (land or river borders only)", correct_answers: ["oklahoma", "texas", "california", "nevada", "idaho", "montana", "new mexico", "louisiana", "mississippi", "kansas"], round: 2, question_order: 3 },
    { id: 9, prompt: "A person/place/thing/event in the first 4 lines of \"We Didn't Start The Fire\" (before the mini-instrumental)", correct_answers: ["harry truman", "doris day", "red china", "johnnie ray", "south pacific", "walter winchell", "joe dimaggio", "marilyn monroe"], round: 2, question_order: 4 },
    { id: 10, prompt: "A musical credited to the duo of Rodgers and Hammerstein", correct_answers: ["oklahoma!", "carousel", "state fair", "allegro", "south pacific", "the king and i", "cinderella", "the sound of music"], round: 2, question_order: 5 }
];

function currentGameQuestion(game) {
    if (!game) return null;
    if (Array.isArray(game.questions) && game.questions[game.currentQuestion]) {
        return game.questions[game.currentQuestion];
    }
    return game.currentQuestionData || null;
}

function isOfficialCorrectAnswer(name, question) {
    const wanted = String(name || '').toLowerCase().trim();
    if (!wanted) return false;
    const list = (question && Array.isArray(question.correct_answers)) ? question.correct_answers : [];
    return list.some((answer) => String(answer).toLowerCase().trim() === wanted);
}

function goldTrimForCorrectBucket(bucket, question) {
    if (!bucket || !bucket.hostCreated) return false;
    return !isOfficialCorrectAnswer(bucket.name || bucket.correctAnswer, question);
}

function normalizeQuestions(list) {
    return (Array.isArray(list) ? list : []).map((q, i) => ({
        id: q.id != null ? q.id : i + 1,
        prompt: q.prompt,
        round: q.round || 1,
        question_order: q.question_order || i + 1,
        correct_answers: Array.isArray(q.correct_answers)
            ? q.correct_answers.map(String)
            : [q.correct_answers].filter(Boolean).map(String)
    })).filter(q => q.prompt);
}

async function fetchDatabaseQuestions() {
    const fromPg = await fetchPostgresQuestions();
    if (fromPg.length) return fromPg;
    if (!supabase || !supabaseConfigured) return [];
    try {
        const { data, error } = await supabase
            .from('questions')
            .select('*')
            .order('round', { ascending: true })
            .order('question_order', { ascending: true });
        if (error) {
            logger.warn('Supabase questions query failed:', error.message);
            return [];
        }
        return normalizeQuestions(data);
    } catch (e) {
        logger.warn('Supabase questions fetch failed:', e.message);
        return [];
    }
}

async function seedPostgresFromFileBank() {
    if (!postgresEnabled()) return;
    const fromFile = await loadFileQuestionBank();
    if (!fromFile.length) return;
    const existing = await fetchPostgresQuestions();
    if (!existing.length) {
        await replacePostgresQuestions(fromFile);
        liveQuestionBankCache = { at: 0, value: null };
        logger.info(`🌱 Seeded Railway Postgres with ${fromFile.length} show questions`);
        return;
    }
    const result = await appendPostgresQuestions(fromFile);
    if (result.added) {
        liveQuestionBankCache = { at: 0, value: null };
        logger.info(`🌱 Appended ${result.added} show questions (${result.total} in bank)`);
    }
}

async function loadFileQuestionBank() {
    try {
        if (!fs.existsSync(QUESTIONS_FILE)) return [];
        const parsed = await loadQuestionsFromFile(QUESTIONS_FILE);
        return normalizeQuestions(parsed);
    } catch (e) {
        logger.warn('Failed to read show question bank:', e.message);
        return [];
    }
}

let liveQuestionBankCache = { at: 0, value: null };

async function getQuestionBank(preferDemo = false) {
    if (preferDemo) {
        return { questions: DEMO_QUESTIONS, source: 'demo', count: DEMO_QUESTIONS.length };
    }
    if (liveQuestionBankCache.value && Date.now() - liveQuestionBankCache.at < 30000) {
        return liveQuestionBankCache.value;
    }
    const fromDb = await fetchDatabaseQuestions();
    let result;
    if (fromDb.length) {
        result = { questions: fromDb, source: 'database', count: fromDb.length };
    } else {
        const fromFile = await loadFileQuestionBank();
        result = fromFile.length
            ? { questions: fromFile, source: 'file', count: fromFile.length }
            : { questions: DEMO_QUESTIONS, source: 'demo', count: DEMO_QUESTIONS.length };
    }
    liveQuestionBankCache = { at: Date.now(), value: result };
    return result;
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

function viewerRoleForSocket(socketId) {
    return lockstep.viewerRoleFromInfo(connectedPlayers.get(socketId));
}

function emitLockstepToSocket(socketId, full, aliasEvent, extra) {
    const sock = io.sockets.sockets.get(socketId);
    if (!sock) return;
    const info = connectedPlayers.get(socketId) || {};
    const view = lockstep.redactStateForViewer(full, {
        role: viewerRoleForSocket(socketId),
        socketId,
        playerName: info.playerName
    });
    const payload = extra && typeof extra === 'object' ? { ...view, ...extra } : view;
    sock.emit('state', payload);
    if (aliasEvent) sock.emit(aliasEvent, payload);
}

function snapshotWithSeq(game) {
    game.seq = (Number(game.seq) || 0) + 1;
    return game.getGameState();
}

function broadcastState(game, aliasEvent, patch) {
    if (!game || !game.gameCode) return null;
    const full = snapshotWithSeq(game);
    const payload = patch && typeof patch === 'object' ? { ...full, ...patch } : full;
    const room = io.sockets.adapter.rooms.get(game.gameCode);
    if (room) {
        for (const sid of room) emitLockstepToSocket(sid, payload, aliasEvent);
    }
    return payload;
}

function leaderboardToolBlock(game) {
    const phase = game && game.gameState;
    if (!phase || phase === 'waiting') {
        return 'Start the game before showing a leaderboard';
    }
    if (phase === 'playing') {
        return 'Finish this question first, then show a leaderboard';
    }
    return '';
}

function sendStateToSocket(socket, game, aliasEvent, extra) {
    if (!socket || !game) return;
    emitLockstepToSocket(socket.id, game.getGameState(), aliasEvent, extra);
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
      questionsPerRound: 5,
      banditAt: 30
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
        // ONE source of truth: this.answers (socketId -> answer)
        this.socketByStableId = new Map();
        this.hostToken = null;
        this.questionBankSource = null;
        this.seenPlayerNames = new Set(); // Track any name that has ever joined this game
        this.expectedResponders = new Set(); // socketIds expected to answer current question
        this.processedEventIds = new Set(); // de-duplication of critical events
        this.answeredStableIds = new Set();
        this.seq = 0;
    }

    addPlayer(socketId, playerName, stablePlayerId = null, options = {}) {
        if (this.settings.maxPlayers > 0 && this.players.size >= this.settings.maxPlayers) {
            throw new Error('Game is full');
        }
        
        const nameKey = String(playerName).toLowerCase();
        const existingSameName = Array.from(this.players.entries()).find(([, p]) => p && String(p.name).toLowerCase() === nameKey);
        if (existingSameName) {
            const existingPlayer = existingSameName[1];
            if (stablePlayerId && existingPlayer.stableId && existingPlayer.stableId === stablePlayerId) {
                return;
            }
            throw new Error('Player name already taken');
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
            answers: [],
            isVirtual: !!options.isVirtual
    });
        this.scores.set(socketId, this.scoresByStableId.get(playerIdentity) || 0);
        this.seenPlayerNames.add(playerName);
        this.socketByStableId = this.socketByStableId || new Map();
        this.socketByStableId.set(playerIdentity, socketId);

        // Track who has answered per question (by stable identity)
        this.answeredStableIds = this.answeredStableIds || new Set();
        
        console.log(`👤 Player ${playerName} added to game ${this.gameCode}`);
    }

    removePlayer(socketId, { keepAnswers = false } = {}) {
        const player = this.players.get(socketId);
        if (player) {
            this.players.delete(socketId);
            this.scores.delete(socketId);
            if (!keepAnswers) this.answers.delete(socketId);
            try {
                if (this.socketByStableId && player.stableId) this.socketByStableId.delete(player.stableId);
            } catch (_) {}
            logger.info(`👤 Player ${player.name} removed from game ${this.gameCode}`);
        }
    }



    // Replace an existing player's socket with a new one for the same stable identity
    replacePlayerSocket(stableId, oldSocketId, newSocketId, playerName) {
        try {
            const oldPlayer = oldSocketId ? this.players.get(oldSocketId) : null;
            const wasVirtual = isVirtualPlayer(oldPlayer, oldSocketId)
                || isVirtualPlayer(null, newSocketId)
                || isVirtualPlayer(null, stableId);

            // Capture any carried answer BEFORE removing old mappings
            let carriedAnswer = null;
            try {
                if (oldSocketId && this.answers && this.answers.has(oldSocketId)) {
                    carriedAnswer = this.answers.get(oldSocketId);
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
            this.players.set(newSocketId, { id: newSocketId, stableId, name: playerName, score: cumulative, answers: [], isVirtual: wasVirtual });
            this.scores.set(newSocketId, cumulative);
            this.socketByStableId = this.socketByStableId || new Map();
            this.socketByStableId.set(stableId, newSocketId);
            if (this.gameState === 'playing' && this.expectedResponders instanceof Set && oldSocketId) {
                this.expectedResponders.delete(oldSocketId);
            }

            // Transfer any pending edit flag to the new socket id
            try {
                if (oldSocketId && this.answersNeedingEdit.has(oldSocketId)) {
                    const payload = this.answersNeedingEdit.get(oldSocketId);
                    this.answersNeedingEdit.delete(oldSocketId);
                    this.answersNeedingEdit.set(newSocketId, payload);
                }
            } catch (_) {}

            // Restore/move the player's answer for the current question to the new socket, if one existed
            try {
                if (carriedAnswer !== null && carriedAnswer !== undefined) {
                    this.answers.set(newSocketId, String(carriedAnswer));
                    if (oldSocketId && this.answers.has(oldSocketId)) {
                        this.answers.delete(oldSocketId);
                    }
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
            
            // Allow submission during playing OR if player has pending edit
            if (this.gameState !== 'playing' && !this.answersNeedingEdit.has(socketId)) {
                logger.warn(`submitAnswer: Invalid game state ${this.gameState} for socket ${socketId}`);
                return false;
            }
        
            const trimmed = String(answer || '').trim();
            const player = this.players.get(socketId);
            if (!player || !player.name) {
                logger.warn(`submitAnswer: Player not found for socket ${socketId}`);
                return false;
            }

            // Check if this is a clarification submission
            const isClarification = this.answersNeedingEdit.has(socketId);

            // HARD SERVER-SIDE LOCK by stable identity
            const stableId = player.stableId || socketId;
            if (!isClarification) {
                // First use the per-question set if available
                if (this.answeredStableIds && this.answeredStableIds.has(stableId)) {
                    logger.warn(`submitAnswer: Blocked duplicate submission for stableId ${stableId} (${player.name}) via answeredStableIds set`);
                    return false;
                }
                // Fallback scan of current answers map
                let priorAnswered = false;
                try {
                    for (const [existingSid] of this.answers.entries()) {
                        const existingPlayer = this.players.get(existingSid);
                        if (existingPlayer && (existingPlayer.stableId || existingSid) === stableId) {
                            priorAnswered = true;
                            break;
                        }
                    }
                } catch(_) {}
                if (priorAnswered) {
                    logger.warn(`submitAnswer: Blocked duplicate submission for stableId ${stableId} (${player.name})`);
                    return false;
                }
            }

            // Set the answer - this replaces any existing answer
            this.answers.set(socketId, trimmed);
            // Mark this stableId as answered for this question
            try { this.answeredStableIds = this.answeredStableIds || new Set(); this.answeredStableIds.add(stableId); } catch(_) {}
            logger.info(`📝 ${player.name} submitted: "${trimmed}"${isClarification ? ' (clarification)' : ''}`);
            
            // If this was a clarification, clear the edit flag
            if (isClarification) {
                this.answersNeedingEdit.delete(socketId);
                logger.info(`✅ Cleared clarification flag for ${player.name}`);
            }
            
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

  resolveSocketsForCategorizedAnswer(answerData) {
    const socketIdSet = new Set();
    const names = [];
    if (Array.isArray(answerData?.players)) names.push(...answerData.players);
    if (typeof answerData?.playerNames === 'string') names.push(...answerData.playerNames.split(','));
    const nameSet = new Set(names.map(n => String(n || '').trim().toLowerCase()).filter(Boolean));
    if (nameSet.size) {
      for (const [sid, player] of this.players.entries()) {
        if (player && nameSet.has(String(player.name).toLowerCase())) socketIdSet.add(sid);
      }
    }
    if (socketIdSet.size === 0 && Array.isArray(this.currentAnswerGroups)) {
      const normalizedTarget = String(answerData?.answer || '').toLowerCase().trim();
      const originalGroup = this.currentAnswerGroups.find(group =>
        String(group.answer || '').toLowerCase().trim() === normalizedTarget
      );
      if (originalGroup && Array.isArray(originalGroup.players)) {
        for (const playerName of originalGroup.players) {
          for (const [sid, player] of this.players.entries()) {
            if (player && String(player.name).toLowerCase() === String(playerName).toLowerCase()) {
              socketIdSet.add(sid);
              break;
            }
          }
        }
      }
      if (originalGroup && Array.isArray(originalGroup.stableIds)) {
        for (const stableId of originalGroup.stableIds) {
          const live = this.socketByStableId && this.socketByStableId.get(stableId);
          if (live) socketIdSet.add(live);
        }
      }
    }
    return Array.from(socketIdSet);
  }

  calculateScoresFromCategorization() {
    const totalResponses = this.answers.size;
    const categorizationData = this.categorizationData;
    
    logger.debug(`📊 Calculating scores from categorization data`);
    logger.debug(`📊 Categorization data:`, categorizationData);
    
    const answerGroups = new Map();
    
    if (categorizationData.correctAnswerBuckets && Array.isArray(categorizationData.correctAnswerBuckets)) {
      for (const bucket of categorizationData.correctAnswerBuckets) {
        if (bucket.answers && Array.isArray(bucket.answers)) {
          const socketIdSet = new Set();
          for (const answerData of bucket.answers) {
            for (const sid of this.resolveSocketsForCategorizedAnswer(answerData)) socketIdSet.add(sid);
          }
          const socketIds = Array.from(socketIdSet);
          if (socketIds.length > 0) {
            answerGroups.set(bucket.id, socketIds);
            logger.debug(`📊 Grouped bucket "${bucket.id}" with ${socketIds.length} players from answers: ${bucket.answers.map(a => a.answer).join(', ')}`);
          }
        }
      }
    }
    
    if (categorizationData.wrong && Array.isArray(categorizationData.wrong)) {
      for (const answerData of categorizationData.wrong) {
        const socketIds = this.resolveSocketsForCategorizedAnswer(answerData);
        if (socketIds.length > 0) {
          answerGroups.set(answerData.answer, socketIds);
          logger.debug(`📊 Wrong answer "${answerData.answer}" with ${socketIds.length} players`);
        }
      }
    }
    
    if (categorizationData.uncategorized && Array.isArray(categorizationData.uncategorized)) {
      for (const answerData of categorizationData.uncategorized) {
        const socketIds = this.resolveSocketsForCategorizedAnswer(answerData);
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
              const gold = goldTrimForCorrectBucket(bucket, currentGameQuestion(this));
              answerGroup.hostCreated = !!bucket.hostCreated;
              answerGroup.goldTrim = gold;
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
          const correctAnswerName = (bucket.name || bucket.correctAnswer || groupKey.replace('correct_', '').replace(/[_-]/g, ' ')).trim();
          const gold = goldTrimForCorrectBucket(bucket, currentGameQuestion(this));
          
          this.currentAnswerGroups.push({
            bucketId: groupKey,
            answer: correctAnswerName, // Use the correct answer name, not individual variations
            count: X,
            points: Z,
            totalResponses: Y,
            category: 'correct',
            hostCreated: !!bucket.hostCreated,
            goldTrim: gold,
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
        
        const matchingBucket = this.categorizationData && this.categorizationData.correctAnswerBuckets
          ? this.categorizationData.correctAnswerBuckets.find(bucket => bucket.id === groupKey)
          : null;
        const displayName = (matchingBucket && (matchingBucket.name || matchingBucket.correctAnswer)) || groupKey.replace(/[_-]/g, ' ');
        const gold = category === 'correct' ? goldTrimForCorrectBucket(matchingBucket, currentGameQuestion(this)) : false;
        this.currentAnswerGroups.push({
          bucketId: groupKey,
          answer: displayName,
          count: X,
          points: Z, // Use calculated points (0 for wrong, correct points for valid buckets)
          totalResponses: Y,
          category: category, // Add the category
          hostCreated: !!(matchingBucket && matchingBucket.hostCreated),
          goldTrim: gold,
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
        this.answeredStableIds = new Set();
        this.expectedResponders = new Set();
        try {
            for (const sid of this.players.keys()) this.expectedResponders.add(sid);
        } catch (_) {}
        try { clearVirtualAnswerJobs(this.gameCode); } catch (_) {}
        try { clearVirtualClarifyJobs(this.gameCode); } catch (_) {}
        
        logger.debug(`🔄 Reset for new question`);
    } catch (e) {
        logger.error('Error in resetQuestionScoring:', e?.message);
        // Initialize safe defaults if something went wrong
        this.currentAnswerGroups = [];
        this.categorizationData = null;
        this.currentQuestionScored = false;
        this.answeredStableIds = new Set();
        this.expectedResponders = new Set();
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
                const player = this.players.get(socketId);
                logger.debug(`🚫 Excluding pending edit answer from ${player?.name || socketId}: "${answer}"`);
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
                    stableIds: [],
                    count: 0,
                    points: 0,
                    index: groupMap.size
                });
            }
            
            const group = groupMap.get(normalizedAnswer);
            if (group && group.players && !group.players.includes(player.name)) {
                group.players.push(String(player.name)); // Ensure string
                if (Array.isArray(group.stableIds) && player.stableId && !group.stableIds.includes(player.stableId)) {
                    group.stableIds.push(player.stableId);
                } else if (!Array.isArray(group.stableIds)) {
                    group.stableIds = player.stableId ? [player.stableId] : [];
                }
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
        
        // CRITICAL: Ensure answer groups are sorted by player count (most popular first)
        this.currentAnswerGroups.sort((a, b) => b.count - a.count);
        
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
        currentQuestion: this.currentQuestion ?? 0,
        currentQuestionIndex: this.currentQuestion ?? 0,
        currentQuestionData: (this.questions && this.questions[this.currentQuestion]) ? this.questions[this.currentQuestion] : null,
        gameState: this.gameState || 'waiting',
        scores: this.scores ? Object.fromEntries(this.scores) : {},
        questions: this.questions || [],
              currentAnswerGroups: this.currentAnswerGroups || [],
              categorizationData: this.categorizationData || null,
        timeLeft: this.timeLeft || 0,
        roundHistory: this.roundHistory || [],
              questionsPerRound: this.settings?.questionsPerRound || 5,
              settings: {
                questionSet: this.settings?.questionSet || 'supabase',
                timerDuration: this.settings?.timerDuration || 180,
                maxPlayers: this.settings?.maxPlayers || 0,
                questionsPerRound: this.settings?.questionsPerRound || 5,
                banditAt: Number.isFinite(Number(this.settings?.banditAt)) ? Number(this.settings.banditAt) : 30
              },
              createdAt: this.createdAt || new Date().toISOString(),
              playerCount: this.players ? this.players.size : 0,
              isTestMode: this.isTestMode || false,
              questionBankSource: this.questionBankSource || null,
        seq: this.seq || 0,
        epoch: lockstep.gameEpoch(this.gameCode, this.currentQuestion, this.gameState),
        answersReceived: this.answers ? this.answers.size : 0,
        answersBySocket: this.answers ? Object.fromEntries(this.answers) : {},
              pendingEdits: (() => {
                try {
                  if (!this.answersNeedingEdit || this.answersNeedingEdit.size === 0) return [];
                  return Array.from(this.answersNeedingEdit.entries()).map(([sid, info]) => {
                    const player = this.players ? this.players.get(sid) : null;
                    return {
                      socketId: sid,
                      playerName: player?.name || 'Unknown',
                      originalAnswer: info?.originalAnswer || '',
                      reason: info?.reason || 'Please be more specific',
                      questionIndex: this.currentQuestion ?? 0
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
        seq: this.seq || 0,
        epoch: lockstep.gameEpoch(this.gameCode, this.currentQuestion, this.gameState || 'error'),
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

  startTimer(opts = {}) {
    const resume = opts === true || opts?.resume === true;
    if (!resume || !Number.isFinite(this.timeLeft) || this.timeLeft <= 0) {
      this.timeLeft = this.settings.timerDuration || 30;
    }
        logger.info(`⏰ Starting timer with ${this.timeLeft} seconds for game ${this.gameCode}${resume ? ' (resume)' : ''}`);
        
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
            this.stopTimer();
            try { this.rebuildCurrentAnswerGroups(); } catch (_) {}
            this.gameState = 'grading';
            
            logger.info(`🎯 Game ${this.gameCode} moved to grading state with ${this.currentAnswerGroups?.length || 0} answer groups`);
            
            // Emit results requiring grading
            logger.debug('📤 Sending questionComplete from handleTimeUp');
            
            // Debug: Check who's in the room
            const roomSockets = await io.in(this.gameCode).fetchSockets();
            logger.debug(`🔍 Room ${this.gameCode} has ${roomSockets.length} sockets`);
            
            try { await persistSnapshot(this, 'question_complete'); } catch(_) {}
            broadcastState(this, 'questionComplete');
        }
    }

    nextQuestion() {
        if (!Array.isArray(this.roundAnswerGroups)) this.roundAnswerGroups = [];
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
        const questionsPerRound = this.settings?.questionsPerRound || 5;
        const currentRound = Math.ceil((this.currentQuestion + 1) / questionsPerRound);
        const questionJustFinished = ((this.currentQuestion) % questionsPerRound) + 1;
        
        console.log(`🔍 Round logic debug: currentQuestion=${this.currentQuestion}, currentRound=${currentRound}, questionJustFinished=${questionJustFinished}, questionsPerRound=${questionsPerRound}`);
        
        // After the last question of the round (or the last question in the set), complete the round
        const noMoreQuestions = this.currentQuestion + 1 >= (this.questions?.length || 0);
        if (questionJustFinished === questionsPerRound || noMoreQuestions) {
            logger.debug(`🎯 Triggering round complete after question ${questionJustFinished} of ${questionsPerRound}`);
            this.completeRound();
        } else if (this.currentQuestion >= this.questions.length) {
            logger.info(`🎯 Game finished: currentQuestion (${this.currentQuestion}) >= questions.length (${this.questions.length})`);
            this.gameState = 'finished';
            broadcastState(this, 'gameFinished');
        } else {
            // Increment to next question
            this.currentQuestion++;
            this.resetQuestionScoring();
            this.currentQuestionScored = false;
            
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
                const gameState = broadcastState(this, 'nextQuestion');
                console.log(`🎯 Emitting nextQuestion for game ${this.gameCode}, question ${this.currentQuestion}`);
                console.log(`🎯 GameState valid:`, !!gameState);
                console.log(`🎯 Current question data:`, !!gameState && !!gameState.currentQuestionData);
                console.log(`✅ Successfully emitted nextQuestion event`);
                try { scheduleVirtualAnswersForGame(this); } catch (_) {}
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

    liveRoundData() {
        const perRound = Math.max(1, Number(this.settings.questionsPerRound) || 5);
        const currentRound = Math.max(1, Math.ceil((this.currentQuestion + 1) / perRound));
        const roundStartQuestion = (currentRound - 1) * perRound + 1;
        const roundEndQuestion = Math.min(currentRound * perRound, this.questions.length);
        const roundSpecificScores = new Map();
        Array.from(this.players.values()).forEach((player) => {
            roundSpecificScores.set(player.name, 0);
        });
        (this.roundAnswerGroups || []).forEach((group) => {
            if (!group.players || !group.players.length) return;
            const pointsPerPlayer = group.points;
            group.players.forEach((playerName) => {
                const currentScore = roundSpecificScores.get(playerName) || 0;
                roundSpecificScores.set(playerName, currentScore + pointsPerPlayer);
            });
        });
        const roundData = {
            roundNumber: currentRound,
            questionStart: roundStartQuestion,
            questionEnd: roundEndQuestion,
            players: Array.from(this.players.values()).map((player) => ({
                name: player.name,
                score: roundSpecificScores.get(player.name) || 0
            })),
            answerGroups: this.roundAnswerGroups || []
        };
        try {
            const playerAnswersByName = {};
            (this.roundAnswerGroups || []).forEach((group) => {
                const entry = {
                    answer: group.answer,
                    points: group.points || 0,
                    bucketId: group.bucketId || null
                };
                (group.players || []).forEach((playerName) => {
                    if (!playerAnswersByName[playerName]) playerAnswersByName[playerName] = [];
                    playerAnswersByName[playerName].push(entry);
                });
            });
            roundData.playerAnswersByName = playerAnswersByName;
        } catch (_) {}
        return roundData;
    }

    completeRound() {
        console.log(`🎯 completeRound() called for game ${this.gameCode}`);
        // Ensure latest question points are applied to cumulative totals
        if (!this.currentQuestionScored) {
            try { this.applyCurrentQuestionPoints(); } catch (_) {}
        }

        const roundData = this.liveRoundData();
        const currentRound = roundData.roundNumber;
        
        console.log(`🎯 Round ${currentRound} completed for game ${this.gameCode}. Answer groups in round: ${this.roundAnswerGroups.length}`);
        console.log(`📊 Round data:`, JSON.stringify(roundData, null, 2));
        
        this.roundHistory.push(roundData);
        // Persist round summary
        sbInsert(SB_TABLES.rounds, { game_code: this.gameCode, round_number: currentRound, data: roundData, at: sbNow() });
        sbLogEvent(this.gameCode, 'round_complete', { round: currentRound });
        try { this.resetQuestionScoring(); } catch (_) {}
        
        // Check if this is the final round (hard stop at 5 rounds)
        const totalRounds = Math.min(5, Math.ceil(this.questions.length / this.settings.questionsPerRound));
        
        if (currentRound >= totalRounds) {
            // This is the final round, show overall leaderboard
            console.log(`🏆 Final round (${currentRound}) completed. Showing overall leaderboard.`);
            this.gameState = 'overallLeaderboard';
            broadcastState(this, 'showOverallLeaderboard');
        } else {
            // Not the final round, proceed normally
            this.gameState = 'roundComplete';
            
            console.log(`🎯 Game state set to 'roundComplete' for game ${this.gameCode}`);
            
            // Reset round answer groups for next round
            this.roundAnswerGroups = [];
            
            console.log(`🎯 Emitting 'roundComplete' event to game ${this.gameCode}`);
            try { persistSnapshot(this, 'round_complete'); } catch(_) {}
            broadcastState(this, 'roundComplete');
            console.log(`🎯 'roundComplete' event emitted successfully`);
        }
    }

    continueToNextRound() {
        const totalRounds = Math.min(5, Math.ceil(this.questions.length / this.settings.questionsPerRound));
        const currentRound = Math.ceil((this.currentQuestion + 1) / this.settings.questionsPerRound);
        if (currentRound >= totalRounds) {
            // Do not advance past final round
            this.gameState = 'overallLeaderboard';
            broadcastState(this, 'showOverallLeaderboard');
            return;
        }
        if (this.currentQuestion >= this.questions.length) {
            this.gameState = 'finished';
            broadcastState(this, 'gameFinished');
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
            broadcastState(this, 'gameFinished');
            return;
        }
        
        this.resetQuestionScoring();
        this.currentQuestionScored = false;
        
        console.log(`🎯 Starting next round: currentQuestion=${this.currentQuestion}, gameState=playing`);
        this.gameState = 'playing';
        this.startTimer();
        broadcastState(this, 'nextQuestion');
        try { scheduleVirtualAnswersForGame(this); } catch (_) {}
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
app.get('/health', async (req, res) => {
    const bank = await getQuestionBank(false);
    res.status(200).json({
        ok: true,
        uptime: process.uptime(),
        questions: {
            source: bank.source,
            count: bank.count,
            supabase: !!supabaseConfigured,
            postgres: postgresEnabled()
        }
    });
});

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

app.get(['/grading', '/grading.html'], (req, res) => {
    res.redirect(302, '/grading-single');
});

app.get('/grading-single', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'grading-single.html'));
});

app.get(['/game', '/game.html'], (req, res) => {
    res.redirect(302, '/');
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
  const results = { status: 'success', gameCode, supabase: [], postgres: [], disk: [] };
  try {
    results.postgres = await listPostgresSnapshots(gameCode);
  } catch (_) {}
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
      if (!existing.hostToken) existing.hostToken = crypto.randomBytes(24).toString('hex');
      return res.json({ status: 'success', recovered: false, hostToken: existing.hostToken, gameState: existing.getGameState() });
    }
    const snap = await loadLatestSnapshot(String(gameCode));
    if (!snap) return res.status(404).json({ status: 'error', message: 'No snapshot found for gameCode' });
    const game = restoreGameFromSnapshot(snap);
    if (!game) return res.status(500).json({ status: 'error', message: 'Failed to restore game' });
    if (!game.hostToken) game.hostToken = crypto.randomBytes(24).toString('hex');
    // Announce recovery in events log
    sbLogEvent(game.gameCode, 'game_recovered', { phase: snap?.phase, at: snap?.at });
    // Return state; clients will rebind via join/reconnect
    return res.json({ status: 'success', recovered: true, hostToken: game.hostToken, gameState: game.getGameState() });
  } catch (e) {
    console.error('❌ recover-game failed:', e?.message);
    return res.status(500).json({ status: 'error', message: 'recover failed' });
  }
});

// Snapshot persistence helpers
function serializeGame(game) {
  try {
    const answersByStableId = {};
    const pendingEditsByStableId = {};
    for (const [sid, answer] of (game.answers || new Map()).entries()) {
      const p = game.players.get(sid);
      const stable = p?.stableId || sid;
      answersByStableId[stable] = answer;
    }
    for (const [sid, info] of (game.answersNeedingEdit || new Map()).entries()) {
      const p = game.players.get(sid);
      const stable = p?.stableId || sid;
      pendingEditsByStableId[stable] = info;
    }
    return {
      gameCode: game.gameCode,
      hostId: game.hostId,
      hostToken: game.hostToken || null,
      questionBankSource: game.questionBankSource || null,
      players: Array.from(game.players.entries()).map(([sid, p]) => ({ socketId: sid, stableId: p.stableId || p.id, name: p.name, score: p.score, isVirtual: !!p.isVirtual })),
      scoresByStableId: Object.fromEntries(game.scoresByStableId),
      answersByStableId,
      pendingEditsByStableId,
      answeredStableIds: Array.from(game.answeredStableIds || []),
      currentQuestionScored: !!game.currentQuestionScored,
      currentRound: game.currentRound,
      currentQuestion: game.currentQuestion,
      questions: game.questions,
      gameState: game.gameState,
      timeLeft: game.timeLeft,
      currentAnswerGroups: game.currentAnswerGroups,
      categorizationData: game.categorizationData,
      roundAnswerGroups: Array.isArray(game.roundAnswerGroups) ? game.roundAnswerGroups : [],
      pointsByStableId: (() => {
        const out = {};
        try {
          for (const [sid, pts] of (game.pointsForCurrentQuestion || new Map()).entries()) {
            const p = game.players.get(sid);
            out[p?.stableId || sid] = pts;
          }
        } catch (_) {}
        return out;
      })(),
      isTestMode: !!game.isTestMode,
      seq: game.seq || 0,
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
    try { await insertPostgresSnapshot(payload); } catch (_) {}
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
  try {
    const pgSnap = await loadLatestPostgresSnapshot(gameCode);
    if (pgSnap) return pgSnap;
  } catch (_) {}
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
    game.roundAnswerGroups = Array.isArray(s.roundAnswerGroups) ? s.roundAnswerGroups : [];
    game.isTestMode = !!s.isTestMode;
    game.seq = Number(s.seq) || 0;
    game.roundHistory = Array.isArray(s.roundHistory) ? s.roundHistory : [];
    game.settings = s.settings || game.settings;
    game.createdAt = s.createdAt || Date.now();
    game.hostToken = s.hostToken || game.hostToken;
    game.questionBankSource = s.questionBankSource || game.questionBankSource;
    // Scores by stable ID
    if (s.scoresByStableId) {
      try { game.scoresByStableId = new Map(Object.entries(s.scoresByStableId)); } catch(_) {}
    }
    game.currentQuestionScored = !!s.currentQuestionScored;
    if (Array.isArray(s.answeredStableIds)) {
      game.answeredStableIds = new Set(s.answeredStableIds);
    }
    if (Array.isArray(s.players)) {
      for (const p of s.players) {
        const stable = p.stableId || p.id || p.socketId;
        if (!stable || !p.name) continue;
        const ghostId = `ghost_${stable}`;
        const score = Number(p.score) || Number(game.scoresByStableId.get(stable)) || 0;
        game.players.set(ghostId, { id: ghostId, stableId: stable, name: p.name, score, answers: [], isVirtual: !!p.isVirtual });
        game.scores.set(ghostId, score);
        game.socketByStableId.set(stable, ghostId);
      }
    }
    if (s.answersByStableId && typeof s.answersByStableId === 'object') {
      for (const [stable, answer] of Object.entries(s.answersByStableId)) {
        const sid = game.socketByStableId.get(stable);
        if (sid) game.answers.set(sid, answer);
      }
    }
    if (s.pendingEditsByStableId && typeof s.pendingEditsByStableId === 'object') {
      for (const [stable, info] of Object.entries(s.pendingEditsByStableId)) {
        const sid = game.socketByStableId.get(stable);
        if (sid) game.answersNeedingEdit.set(sid, info);
      }
    }
    if (s.pointsByStableId && typeof s.pointsByStableId === 'object') {
      for (const [stable, pts] of Object.entries(s.pointsByStableId)) {
        const sid = game.socketByStableId.get(stable);
        if (sid) game.pointsForCurrentQuestion.set(sid, Number(pts) || 0);
      }
    }
    
    activeGames.set(game.gameCode, game);
    activeGameCodes.add(game.gameCode);
    console.log(`✅ Restored game ${game.gameCode} from snapshot (state=${game.gameState})`);
    try {
      if (game.gameState === 'playing') {
        if (Number(game.timeLeft) > 0) game.startTimer({ resume: true });
        else game.handleTimeUp();
      }
      try { ensurePendingVirtualClarifications(game); } catch (_) {}
    } catch (timerErr) {
      console.warn('⚠️ Could not resume timer after snapshot restore:', timerErr?.message);
    }
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
    game.hostToken = crypto.randomBytes(24).toString('hex');
    activeGames.set(gameCode, game);
    try { activeGameCodes.add(gameCode); } catch (_) {}
    try { persistSnapshot(game, 'game_created'); } catch (_) {}
    try { sbInsert(SB_TABLES.games, { game_code: gameCode, host_name: finalHostName, created_at: sbNow() }); } catch (_) {}
    
    console.log(`🎮 New game created: ${gameCode} by ${finalHostName}`);
    
    res.json({ 
        status: 'success', 
        gameCode: gameCode,
        hostToken: game.hostToken,
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

async function startHostGame(socket, gameCode) {
    if (!gameCode) return false;

    const requestKey = `${socket.id}-${gameCode}`;
    const now = Date.now();
    const lastRequest = recentStartGameRequests.get(requestKey);
    if (lastRequest && (now - lastRequest) < 2000) {
        console.log('🚫 Duplicate startGame request ignored for game:', gameCode);
        return false;
    }
    recentStartGameRequests.set(requestKey, now);
    if (recentStartGameRequests.size > 100) {
        const cutoff = now - 10000;
        for (const [key, timestamp] of recentStartGameRequests.entries()) {
            if (timestamp < cutoff) recentStartGameRequests.delete(key);
        }
    }

    const game = activeGames.get(gameCode);
    if (!game) return false;

    const playerInfo = connectedPlayers.get(socket.id);
    if (!playerInfo || !playerInfo.isHost || playerInfo.playerName !== game.hostId) {
        socket.emit('gameError', { message: 'Only the host can start the game.' });
        return false;
    }

    if (game.gameState !== 'waiting') {
        console.log(`⚠️ startGame ignored for ${gameCode} — already ${game.gameState}`);
        return false;
    }

    try {
        let questions = [];
        if (Array.isArray(game.questions) && game.questions.length > 0) {
            questions = game.questions;
            console.log(`🗂️ Using preloaded question set for game ${gameCode}: ${questions.length} questions`);
        } else {
            const preferDemo = game.settings && game.settings.questionSet === 'demo';
            const bank = await getQuestionBank(preferDemo);
            questions = bank.questions;
            game.questionBankSource = bank.source;
            console.log(`📚 Using ${bank.source} question bank for game ${gameCode}: ${questions.length} questions`);
        }

        game.questions = questions;
        game.gameState = 'playing';
        game.currentRound = 1;
        game.currentQuestion = 0;
        game.resetQuestionScoring();
        game.startTimer();

        broadcastState(game, 'gameStarted');
        try { scheduleVirtualAnswersForGame(game); } catch (_) {}
        return true;
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
        return false;
    }
}

const VIRTUAL_PLAYER_NAMES = [
    'Emma Thompson', 'James Wilson', 'Sophia Rodriguez', 'Michael Chen', 'Olivia Davis',
    'David Martinez', 'Ava Johnson', 'Christopher Lee', 'Isabella Brown', 'Daniel Garcia',
    'Mia Anderson', 'Matthew Taylor', 'Charlotte White', 'Andrew Clark', 'Amelia Hall',
    'Joshua Lewis', 'Harper Walker', 'Ryan Allen', 'Evelyn Young', 'Nathan King',
    'Abigail Wright', 'Tyler Green', 'Emily Baker', 'Kevin Adams', 'Sofia Nelson',
    'Justin Carter', 'Avery Mitchell', 'Brandon Perez', 'Ella Roberts', 'Steven Turner',
    'Madison Phillips', 'Jonathan Campbell', 'Scarlett Parker', 'Robert Evans', 'Grace Edwards',
    'Thomas Collins', 'Chloe Stewart', 'Samuel Morris', 'Lily Rogers', 'Benjamin Cook',
    'Hannah Morgan', 'Christian Reed', 'Layla Bell', 'Isaac Murphy', 'Riley Bailey',
    'Jack Cooper', 'Zoe Richardson', 'Owen Cox', 'Nora Howard', 'Gavin Ward',
    'Luna Torres', 'Caleb Peterson', 'Violet Gray', 'Isaac Ramirez', 'Penelope James',
    'Mason Watson', 'Hazel Brooks', 'Ethan Kelly', 'Aurora Sanders', 'Logan Price'
];
const VIRTUAL_WRONG_ANSWERS = ['banana', 'sheep', 'mars', 'idk', 'no idea', 'pass', 'maybe', '42', 'october', 'caterpillar'];
const virtualJoinJobs = new Map();
const virtualAnswerJobs = new Map();
let virtualPlayerSeq = 0;

function nextVirtualPlayerName(game) {
    const used = new Set(Array.from(game.players.values()).map(p => p.name));
    for (let n = 0; n < VIRTUAL_PLAYER_NAMES.length * 4; n++) {
        const base = VIRTUAL_PLAYER_NAMES[n % VIRTUAL_PLAYER_NAMES.length];
        const suffix = Math.floor(n / VIRTUAL_PLAYER_NAMES.length) + 1;
        const name = suffix > 1 ? `${base} ${suffix}` : base;
        if (!used.has(name)) return name;
    }
    return `Virtual ${Date.now()}`;
}

function stopVirtualJoinJob(gameCode) {
    const job = virtualJoinJobs.get(gameCode);
    if (job) {
        clearTimeout(job);
        clearInterval(job);
        virtualJoinJobs.delete(gameCode);
    }
}

function isVirtualPlayer(player, playerId) {
    if (player && player.isVirtual) return true;
    const id = String(playerId || player?.id || player?.stableId || '');
    return id.startsWith('virtual_') || id.startsWith('ghost_virtual_');
}

function clearVirtualAnswerJobs(gameCode) {
    const jobs = virtualAnswerJobs.get(gameCode);
    if (jobs) {
        jobs.forEach((id) => clearTimeout(id));
        virtualAnswerJobs.delete(gameCode);
    }
}

const virtualClarifyJobs = new Map();
const virtualClarifyScheduled = new Map();

function clearVirtualClarifyJobs(gameCode) {
    const jobs = virtualClarifyJobs.get(gameCode);
    if (jobs) {
        jobs.forEach((id) => clearTimeout(id));
        virtualClarifyJobs.delete(gameCode);
    }
    virtualClarifyScheduled.delete(gameCode);
}

function trackVirtualTimeout(gameCode, timeoutId) {
    const existing = virtualAnswerJobs.get(gameCode) || [];
    existing.push(timeoutId);
    virtualAnswerJobs.set(gameCode, existing);
}

function trackVirtualClarifyTimeout(gameCode, timeoutId) {
    const existing = virtualClarifyJobs.get(gameCode) || [];
    existing.push(timeoutId);
    virtualClarifyJobs.set(gameCode, existing);
}

function pickVirtualAnswer(question) {
    const correct = Array.isArray(question?.correct_answers)
        ? question.correct_answers.filter(Boolean).map(String)
        : [];
    const roll = Math.random();
    if (correct.length && roll < 0.7) {
        let answer = correct[Math.floor(Math.random() * correct.length)];
        if (Math.random() < 0.2) {
            answer = Math.random() < 0.5 ? `${answer}!` : `${answer}s`;
        }
        return answer;
    }
    if (correct.length && roll < 0.85) {
        const answer = correct[Math.floor(Math.random() * correct.length)];
        return answer.charAt(0).toUpperCase() + answer.slice(1);
    }
    return VIRTUAL_WRONG_ANSWERS[Math.floor(Math.random() * VIRTUAL_WRONG_ANSWERS.length)];
}

function answerUpdatePayload(game) {
    const totalExpected = (game.gameState === 'playing' && game.expectedResponders instanceof Set)
        ? game.expectedResponders.size
        : game.players.size;
    const stableAnswered = new Set();
    const rawAnswers = {};
    for (const [sid, ans] of game.answers.entries()) {
        const p = game.players.get(sid);
        stableAnswered.add(p?.stableId || sid);
        rawAnswers[sid] = ans;
    }
    return {
        answersReceived: stableAnswered.size,
        totalPlayers: totalExpected,
        answers: rawAnswers,
        answeredPlayers: lockstep.answeredPlayersFromState({
            players: Array.from(game.players.values()),
            answersBySocket: rawAnswers,
            currentAnswerGroups: game.currentAnswerGroups || []
        }),
        sentBackPlayers: lockstep.sentBackPlayersFromState({
            pendingEdits: Array.from((game.answersNeedingEdit || new Map()).entries()).map(([sid, info]) => {
                const p = game.players.get(sid);
                return {
                    socketId: sid,
                    stableId: p && p.stableId,
                    playerName: p && p.name
                };
            })
        })
    };
}

function broadcastAcceptedAnswer(game, playerSocketId, answer, playerName, wasClarity) {
    try { game.rebuildCurrentAnswerGroups(); } catch (e) {
        logger.error('Failed to rebuild answer groups after virtual answer:', e?.message);
    }
    const hostSocket = Array.from(connectedPlayers.entries())
        .find(([, info]) => info.gameCode === game.gameCode && info.isHost);
    if (hostSocket) {
        io.to(hostSocket[0]).emit('answerSubmitted', { playerName, answer });
    }
    broadcastState(game, 'gameStateUpdate');
    io.to(game.gameCode).emit('newAnswerSubmitted', {
        playerName,
        answer,
        gameCode: game.gameCode,
        at: Date.now(),
        isClarification: !!wasClarity
    });
    io.to(game.gameCode).emit('answerUpdate', answerUpdatePayload(game));
}

function acceptVirtualAnswer(game, playerId, answer, playerName) {
    const player = game.players.get(playerId);
    if (!player || !isVirtualPlayer(player, playerId)) return false;
    const wasClarity = game.answersNeedingEdit.has(playerId);
    if (!game.submitAnswer(playerId, answer)) return false;
    if (wasClarity && game.answersNeedingEdit.has(playerId)) {
        game.answersNeedingEdit.delete(playerId);
    }
    broadcastAcceptedAnswer(game, playerId, String(answer).trim(), playerName || player.name, wasClarity);
    return true;
}

function addOneVirtualPlayer(game) {
    virtualPlayerSeq += 1;
    const playerName = nextVirtualPlayerName(game);
    const playerId = `virtual_${game.gameCode}_${virtualPlayerSeq}`;
    game.addPlayer(playerId, playerName, playerId, { isVirtual: true });
    if (game.gameState === 'playing' && game.expectedResponders instanceof Set) {
        try { game.expectedResponders.add(playerId); } catch (_) {}
    }
    io.to(game.gameCode).emit('virtualPlayerJoined', {
        playerId,
        playerName,
        gameCode: game.gameCode
    });
    broadcastState(game, 'playerJoined');
    if (game.gameState === 'playing') {
        scheduleOneVirtualAnswer(game, playerId);
    }
    return { playerId, playerName };
}

function submitVirtualAnswerNow(game, playerId) {
    const live = activeGames.get(game.gameCode);
    if (!live || live.gameState !== 'playing') return;
    const player = live.players.get(playerId);
    if (!player || !isVirtualPlayer(player, playerId) || live.answers.has(playerId)) return;
    const question = Array.isArray(live.questions) ? live.questions[live.currentQuestion] : null;
    try { acceptVirtualAnswer(live, playerId, pickVirtualAnswer(question), player.name); } catch (_) {}
}

function scheduleOneVirtualAnswer(game, playerId) {
    const player = game.players.get(playerId);
    if (!player || !isVirtualPlayer(player, playerId)) return;
    const questionIndex = game.currentQuestion;
    const delay = Math.floor(Math.random() * 5001);
    const timeoutId = setTimeout(() => {
        const live = activeGames.get(game.gameCode);
        if (!live || live.gameState !== 'playing' || live.currentQuestion !== questionIndex) return;
        submitVirtualAnswerNow(live, playerId);
    }, delay);
    trackVirtualTimeout(game.gameCode, timeoutId);
}

function clarifyVirtualAnswer(original, game) {
    const question = Array.isArray(game.questions) ? game.questions[game.currentQuestion] : null;
    const correct = Array.isArray(question?.correct_answers)
        ? question.correct_answers.filter(Boolean).map(String)
        : [];
    const orig = String(original || '').trim();
    const others = correct.filter(a => a.toLowerCase() !== orig.toLowerCase());
    if (others.length && Math.random() < 0.75) {
        return others[Math.floor(Math.random() * others.length)];
    }
    if (orig) return `${orig} (more specific)`;
    return pickVirtualAnswer(question);
}

function scheduleVirtualClarification(game, playerId) {
    const player = game.players.get(playerId);
    if (!player || !isVirtualPlayer(player, playerId)) {
        logger.warn(`✏️ Not scheduling virtual clarification for ${player?.name || playerId} (not virtual)`);
        return;
    }
    const gameCode = game.gameCode;
    const scheduled = virtualClarifyScheduled.get(gameCode) || new Set();
    if (scheduled.has(playerId)) return;
    scheduled.add(playerId);
    virtualClarifyScheduled.set(gameCode, scheduled);
    const original = game.answers.get(playerId) || '';
    const playerName = player.name;
    const delay = 400 + Math.floor(Math.random() * 1600);
    const timeoutId = setTimeout(() => {
        scheduled.delete(playerId);
        const live = activeGames.get(gameCode);
        if (!live) return;
        let sid = playerId;
        if (!live.answersNeedingEdit.has(sid)) {
            for (const [id, p] of live.players.entries()) {
                if (p && String(p.name || '').toLowerCase() === String(playerName || '').toLowerCase() && live.answersNeedingEdit.has(id)) {
                    sid = id;
                    break;
                }
            }
        }
        if (!live.answersNeedingEdit.has(sid)) {
            logger.warn(`✏️ Virtual clarification skipped; ${playerName} is no longer pending`);
            return;
        }
        const clarified = clarifyVirtualAnswer(original, live);
        const ok = acceptVirtualAnswer(live, sid, clarified, playerName);
        if (!ok) logger.warn(`✏️ Virtual clarification failed for ${playerName} (${sid})`);
        else logger.info(`🎭 Virtual ${playerName} resubmitted clarification: "${clarified}"`);
    }, delay);
    trackVirtualClarifyTimeout(gameCode, timeoutId);
    logger.info(`🎭 Virtual ${playerName} will resubmit a clarification in ${delay}ms`);
}

function ensurePendingVirtualClarifications(game) {
    if (!game || !game.answersNeedingEdit || game.answersNeedingEdit.size === 0) return;
    if (game.gameState !== 'playing' && game.gameState !== 'grading') return;
    for (const sid of game.answersNeedingEdit.keys()) {
        const player = game.players.get(sid);
        if (!isVirtualPlayer(player, sid)) continue;
        try { scheduleVirtualClarification(game, sid); } catch (e) {
            logger.warn('Failed to resume virtual clarification:', e?.message);
        }
    }
}

function scheduleVirtualAnswersForGame(game) {
    if (!game || !game.gameCode) return;
    clearVirtualAnswerJobs(game.gameCode);
    if (game.gameState !== 'playing') return;
    const ids = [];
    for (const [playerId, player] of game.players.entries()) {
        if (player && isVirtualPlayer(player, playerId) && !game.answers.has(playerId)) ids.push(playerId);
    }
    for (let i = ids.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        const swap = ids[i];
        ids[i] = ids[j];
        ids[j] = swap;
    }
    const questionIndex = game.currentQuestion;
    const step = (index) => {
        const live = activeGames.get(game.gameCode);
        if (!live || live.gameState !== 'playing' || live.currentQuestion !== questionIndex) return;
        if (index < ids.length) submitVirtualAnswerNow(live, ids[index]);
        if (index + 1 >= ids.length) return;
        const delay = Math.floor(Math.random() * 5001);
        trackVirtualTimeout(game.gameCode, setTimeout(() => step(index + 1), delay));
    };
    if (ids.length) step(0);
}

function startAddingVirtualPlayers(game, playerCount) {
    stopVirtualJoinJob(game.gameCode);
    game.isTestMode = true;
    let added = 0;
    const addNext = () => {
        virtualJoinJobs.delete(game.gameCode);
        if (!activeGames.has(game.gameCode) || added >= playerCount) return;
        try { addOneVirtualPlayer(game); } catch (e) {
            logger.warn('Failed to add virtual player:', e?.message);
        }
        added += 1;
        if (added >= playerCount || !activeGames.has(game.gameCode)) return;
        const delay = Math.floor(Math.random() * 5001);
        virtualJoinJobs.set(game.gameCode, setTimeout(addNext, delay));
    };
    addNext();
}

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

    function canControlGame(gameCode) {
        const info = connectedPlayers.get(socket.id);
        if (!info || info.gameCode !== gameCode) return false;
        return !!(info.isHost || info.isGradingInterface);
    }

    socket.on('playerQuestion', (data) => {
        try {
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
            const gameCode = playerInfo.gameCode || data.gameCode;
            const playerName = playerInfo.playerName || data.playerName || 'Unknown';
            if (!gameCode) {
                try { socket.emit('playerQuestionAck', { ok: false, reason: 'not-in-game' }); } catch (_) {}
                return;
            }
            const hostEntry = Array.from(connectedPlayers.entries()).find(([_, info]) => info.gameCode === gameCode && info.isHost);
            if (!hostEntry) {
                try { socket.emit('playerQuestionAck', { ok: false, reason: 'no-host' }); } catch (_) {}
                return;
            }
            const at = Date.now();
            io.to(hostEntry[0]).emit('playerQuestion', { gameCode, playerName, playerSocketId: socket.id, question, at });
            sbInsert(SB_TABLES.qa, { game_code: gameCode, player_name: playerName, player_socket_id: socket.id, question, at: new Date(at).toISOString() });
            sbLogEvent(gameCode, 'player_question', { playerName });
            try { socket.emit('playerQuestionAck', { ok: true }); } catch (_) {}
        } catch (e) {
            console.warn('playerQuestion handling failed', e);
            try { socket.emit('playerQuestionAck', { ok: false, reason: 'error' }); } catch (_) {}
        }
    });

    socket.on('hostAnswer', (data) => {
        try {
            if (!data || typeof data.answer !== 'string') return;
            const answer = data.answer.trim();
            const { gameCode, targetSocketId, targetPlayerName } = data;
            if (!gameCode || answer.length === 0) return;
            const hostInfo = connectedPlayers.get(socket.id);
            if (!hostInfo || !hostInfo.isHost || hostInfo.gameCode !== gameCode) return;
            const game = activeGames.get(gameCode);
            if (!game) return;
            let targetSid = targetSocketId;
            if (targetSid && game.socketByStableId) {
                const p = game.players.get(targetSid);
                const live = p && p.stableId && game.socketByStableId.get(p.stableId);
                if (live) targetSid = live;
            }
            if (!targetSid && targetPlayerName) {
                const lower = String(targetPlayerName).toLowerCase();
                for (const [sid, p] of game.players.entries()) {
                    if (String(p.name || '').toLowerCase() === lower) { targetSid = sid; break; }
                }
            }
            if (!targetSid) return;
            io.to(targetSid).emit('hostAnswer', { gameCode, answer, at: Date.now() });
            try { socket.emit('hostAnswerAck', { ok: true }); } catch (_) {}
        } catch (e) {
            console.warn('hostAnswer handling failed', e);
        }
    });

    socket.on('displayPing', () => {});

    // Host reconnection
    socket.on('reconnectHost', (data) => {
        const { gameCode, hostName, hostToken } = data || {};
        
        if (!gameCode || !hostName) {
            socket.emit('error', { message: 'Game code and host name are required' });
      return;
    }

        const game = activeGames.get(gameCode);
        if (!game) {
            socket.emit('error', { message: 'Game not found. Please check the game code.' });
            return;
        }

        if (game.hostToken && hostToken !== game.hostToken) {
            socket.emit('error', { message: 'Host credentials do not match this game.' });
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
        try { ensurePendingVirtualClarifications(game); } catch (_) {}
        sendStateToSocket(socket, game, 'hostReconnected');
        
        console.log(`🔄 Host ${hostName} reconnected to game ${gameCode} and joined room`);
    });

    // Create game (legacy socket event for host joining room)
    socket.on('createGame', (data) => {
        // Prefer explicit gameCode from client (same request cycle as REST creation)
        const requestedCode = data && data.gameCode ? String(data.gameCode) : null;
        if (!requestedCode || !activeGames.has(requestedCode)) {
            socket.emit('gameError', { message: 'No game found. Create a game first, then join with that code.' });
            return;
        }
        const hostGame = activeGames.get(requestedCode);
        // Update connection info securely for this host socket
        const playerInfo = connectedPlayers.get(socket.id);
        if (playerInfo) {
            playerInfo.gameCode = hostGame.gameCode;
            playerInfo.playerName = hostGame.hostId;
            playerInfo.isHost = true;
        }
        socket.join(hostGame.gameCode);
        sendStateToSocket(socket, hostGame, 'gameCreated', { hostToken: hostGame.hostToken });
        console.log(`🏠 Host ${hostGame.hostId} joined room for game ${hostGame.gameCode}`);
    });

    // Host reconnect
    socket.on('host-reconnect', (data) => {
        const { gameCode, hostToken } = data || {};
        
        if (!gameCode) {
            socket.emit('gameError', { message: 'Game code is required for reconnection' });
            return;
        }
        
        const game = activeGames.get(gameCode);
        if (!game) {
            socket.emit('gameError', { message: 'Game not found. Please check the game code.' });
            return;
        }

        if (game.hostToken) {
            if (!hostToken || hostToken !== game.hostToken) {
                socket.emit('gameError', { message: 'Host credentials do not match this game.' });
                return;
            }
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
        
        sendStateToSocket(socket, game, 'gameCreated', { hostToken: game.hostToken });
        
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
                playerInfo.isHost = false;
            }
            
            const nameKey = String(playerName).toLowerCase();
            const priorByStable = playerId
                ? Array.from(game.players.entries()).find(([, p]) => p && p.stableId === playerId)
                : null;
            const priorByName = Array.from(game.players.entries()).find(([, p]) => p && String(p.name).toLowerCase() === nameKey);
            if (priorByName && playerId && priorByName[1].stableId && priorByName[1].stableId !== playerId) {
                socket.emit('gameError', { message: 'That name is already in this game.' });
                return;
            }
            const alreadyInGame = !!(priorByStable || priorByName);
            if (!alreadyInGame) {
                game.addPlayer(socket.id, playerName, playerId || null);
                sbInsert(SB_TABLES.players, { game_code: gameCode, socket_id: socket.id, player_name: playerName, joined_at: sbNow() });
                sbLogEvent(gameCode, 'player_joined', { playerName });
                if (game.gameState === 'playing' && game.expectedResponders instanceof Set) {
                    try { game.expectedResponders.add(socket.id); } catch(_) {}
                }
                broadcastState(game, 'playerJoined');
            } else {
                const prior = priorByStable || priorByName;
                const stable = (playerId || prior?.[1]?.stableId || socket.id);
                if (prior) {
                    game.replacePlayerSocket(stable, prior[0], socket.id, playerName);
                } else {
                    const cumulative = game.scoresByStableId.get(stable) || 0;
                    game.players.set(socket.id, { id: socket.id, stableId: (playerId || null), name: playerName, score: cumulative, answers: [] });
                    if (!game.scores.has(socket.id)) game.scores.set(socket.id, cumulative);
                }
                if (game.gameState === 'playing' && game.expectedResponders instanceof Set) {
                    try { game.expectedResponders.add(socket.id); } catch(_) {}
                }
                broadcastState(game, 'playerJoined');
                sbLogEvent(gameCode, 'player_rebound', { playerName });
            }

            let editInfo = game.answersNeedingEdit.get(socket.id);
            if (!editInfo) {
                for (const [sid, info] of game.answersNeedingEdit.entries()) {
                    const p = game.players.get(sid);
                    if (p && String(p.name).toLowerCase() === String(playerName).toLowerCase()) {
                        if (sid !== socket.id) {
                            game.answersNeedingEdit.delete(sid);
                            game.answersNeedingEdit.set(socket.id, info);
                        }
                        editInfo = info;
                        break;
                    }
                }
            }
            if (editInfo) {
                io.to(socket.id).emit('requireAnswerEdit', { reason: editInfo.reason, originalAnswer: editInfo.originalAnswer });
                logger.info(`✏️ Re-sent edit request to reconnecting ${playerName}`);
            }
            
            // console.log(`🔍 joinGame: Adding socket to room ${gameCode}`);
            socket.join(gameCode);
            
            // Confirm to player
            // console.log(`🔍 joinGame: Sending gameJoined response`);
            sendStateToSocket(socket, game, 'gameJoined');
        } catch (error) {
            console.error('❌ joinGame error:', error);
            socket.emit('gameError', { message: error.message });
        }
    });

  // SIMPLIFIED: Host requests a player's answer edit ("Send Back")
    socket.on('hostRequestEdit', (data) => {
        const { gameCode, playerSocketId, playerName, reason } = data || {};
        if (!canControlGame(gameCode)) {
            socket.emit('hostRequestEditResult', { ok: false, playerName, reason: 'no-permission' });
            return;
        }
        
        const game = activeGames.get(gameCode);
    if (!game) {
        socket.emit('hostRequestEditResult', { ok: false, playerName, reason: 'no-game' });
        return;
    }
    if (game.gameState !== 'grading' && game.gameState !== 'playing') {
        socket.emit('gameError', { message: 'Send-back is only available while a question is live or being graded' });
        socket.emit('hostRequestEditResult', { ok: false, playerName, reason: 'bad-phase' });
        return;
    }
    
    let targetSocketId = playerSocketId && game.players.has(playerSocketId) ? playerSocketId : null;
    if (!targetSocketId && playerName) {
      for (const [sid, p] of game.players.entries()) {
        if (p.name && p.name.toLowerCase() === String(playerName).toLowerCase()) {
          targetSocketId = sid;
          break;
        }
      }
    }
    if (targetSocketId) {
        const p = game.players.get(targetSocketId);
        const live = p && p.stableId && game.socketByStableId && game.socketByStableId.get(p.stableId);
        if (live && game.players.has(live)) targetSocketId = live;
    }
    
    if (!targetSocketId || !game.players.has(targetSocketId)) {
        socket.emit('hostRequestEditResult', { ok: false, playerName, reason: 'not-found' });
        return;
    }
    
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
    
    io.to(targetSocketId).emit('requireAnswerEdit', { reason: reason || 'Please be more specific', originalAnswer: original });
    logger.info(`✏️ Clarification sent to ${game.players.get(targetSocketId)?.name}`);

    const targetPlayer = game.players.get(targetSocketId);
    const virtual = isVirtualPlayer(targetPlayer, targetSocketId);
    if (virtual) {
        scheduleVirtualClarification(game, targetSocketId);
    }
    
    socket.emit('hostRequestEditResult', {
        ok: true,
        playerName: targetPlayer?.name || playerName,
        isVirtual: virtual
    });
    broadcastState(game, 'gameStateUpdate');
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

    socket.on('startVirtualPlayerSimulation', (data) => {
        const gameCode = data && data.gameCode;
        const requested = Number(data && data.playerCount);
        if (!gameCode) {
            socket.emit('gameError', { message: 'Game code is required for virtual players' });
            return;
        }
        if (!canControlGame(gameCode)) {
            socket.emit('gameError', { message: 'Only the host can start a virtual player test' });
            return;
        }
        const game = activeGames.get(gameCode);
        if (!game) {
            socket.emit('gameError', { message: 'Game not found. Create a game first.' });
            return;
        }
        const playerCount = Math.max(1, Math.min(100, Math.floor(requested) || 10));
        startAddingVirtualPlayers(game, playerCount);
        socket.emit('virtualSimulationStarted', { gameCode, playerCount });
        logger.info(`🎭 Virtual simulation: adding ${playerCount} players to ${gameCode}`);
    });

    socket.on('virtualAnswerSubmitted', (data) => {
        try {
            if (!data || !data.gameCode || !data.playerId || data.answer === undefined || data.answer === null) return;
            const game = activeGames.get(data.gameCode);
            if (!game || !game.isTestMode) return;
            const player = game.players.get(data.playerId);
            if (!player || !isVirtualPlayer(player, data.playerId)) return;
            acceptVirtualAnswer(game, data.playerId, data.answer, data.playerName || player.name);
        } catch (e) {
            logger.warn('virtualAnswerSubmitted failed:', e?.message);
        }
    });

    socket.on('virtualPlayerJoined', (data) => {
        try {
            if (!data || !data.gameCode || !data.playerName) return;
            if (!canControlGame(data.gameCode)) return;
            const game = activeGames.get(data.gameCode);
            if (!game) return;
            const playerName = String(data.playerName).trim();
            if (!playerName) return;
            const already = Array.from(game.players.values()).some(p => p.name === playerName);
            if (already) return;
            const playerId = data.playerId || `virtual_${game.gameCode}_${++virtualPlayerSeq}`;
            game.addPlayer(playerId, playerName, playerId, { isVirtual: true });
            game.isTestMode = true;
            if (game.gameState === 'playing' && game.expectedResponders instanceof Set) {
                try { game.expectedResponders.add(playerId); } catch (_) {}
            }
            io.to(game.gameCode).emit('virtualPlayerJoined', {
                playerId,
                playerName,
                gameCode: game.gameCode
            });
            broadcastState(game, 'playerJoined');
            if (game.gameState === 'playing') scheduleOneVirtualAnswer(game, playerId);
        } catch (e) {
            logger.warn('virtualPlayerJoined failed:', e?.message);
        }
    });

    // Start game
    socket.on('updateGameSettings', (data) => {
        const gameCode = data && data.gameCode;
        if (!gameCode || !canControlGame(gameCode)) return;
        const game = activeGames.get(gameCode);
        if (!game) return;
        game.settings = game.settings || {};
        if (data.questionSet) game.settings.questionSet = String(data.questionSet);
        if (data.timerDuration != null) {
            const n = Number(data.timerDuration);
            if (Number.isFinite(n) && n >= 10) game.settings.timerDuration = n;
        }
        if (data.maxPlayers != null) {
            const n = Number(data.maxPlayers);
            if (Number.isFinite(n) && n >= 0) game.settings.maxPlayers = n;
        }
        if (data.questionsPerRound != null) {
            const n = Number(data.questionsPerRound);
            if (Number.isFinite(n) && n >= 1) game.settings.questionsPerRound = n;
        }
        if (data.banditAt != null) {
            const n = Number(data.banditAt);
            if (Number.isFinite(n) && n >= 0) game.settings.banditAt = Math.min(600, Math.round(n));
        }
        broadcastState(game, 'gameSettingsUpdated');
        io.to(game.gameCode).emit('gameSettingsUpdated', game.settings);
    });

    socket.on('startGame', async (data) => {
        if (!data || !data.gameCode) {
            console.log('⚠️ startGame event received with no gameCode');
            return;
        }
        await startHostGame(socket, data.gameCode);
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
                socket.emit('answerError', { message: 'Missing game code or answer' });
                return;
            }
            
            const playerInfo = connectedPlayers.get(socket.id);
            if (!playerInfo || playerInfo.gameCode !== gameCode) {
                socket.emit('answerError', { message: 'Not connected to this game. Refresh and rejoin.' });
                return;
            }
            
            const game = activeGames.get(gameCode);
            if (!game) {
                socket.emit('answerError', { message: 'Game not found.' });
                return;
            }
            
            // Check if this is a clarification submission BEFORE calling submitAnswer
            const wasClarity = game.answersNeedingEdit.has(socket.id);
            const playerName = playerInfo.playerName;
            
            logger.info(`🔍 Processing answer submission: ${playerName} → "${answer}"${wasClarity ? ' (clarification)' : ''}`);
            
            if (game.submitAnswer(socket.id, answer)) {
                // Answer was accepted - send confirmation to player
                socket.emit('answerSubmitted');
                logger.info(`✅ ${playerName} answer accepted${wasClarity ? ' (clarification)' : ''}`);
                
                // CRITICAL: Rebuild answer groups immediately after submission
                // This ensures grading interface gets updated in real-time
                // For clarifications, ensure the flag is cleared before rebuilding
                if (wasClarity) {
                    // Double-check that the clarification flag is cleared
                    if (game.answersNeedingEdit.has(socket.id)) {
                        game.answersNeedingEdit.delete(socket.id);
                        logger.info(`🔧 Force-cleared clarification flag for ${playerName}`);
                    }
                }
                
                try {
                    game.rebuildCurrentAnswerGroups();
                    logger.info(`🔄 Rebuilt answer groups after ${playerName}'s submission`);
                    logger.debug(`📊 Current answer groups: ${game.currentAnswerGroups.length}`);
                } catch (e) {
                    logger.error('Failed to rebuild answer groups after submission:', e?.message);
                }
                
                // Notify host of the specific answer
                const hostSocket = Array.from(connectedPlayers.entries())
                    .find(([id, info]) => info.gameCode === gameCode && info.isHost);
                
                if (hostSocket) {
                    io.to(hostSocket[0]).emit('answerSubmitted', {
                        playerName: playerName,
                        answer: answer
                    });
                    logger.debug(`📤 Sent answerSubmitted to host for ${playerName}`);
                }
                
                // Broadcast game state update to ALL connected clients (including grading interface)
                broadcastState(game, 'gameStateUpdate');
                logger.debug(`📤 Broadcasted gameStateUpdate to room ${gameCode}`);
                
                // Send specific newAnswerSubmitted event for real-time grading updates
                const newAnswerEvent = {
                    playerName: playerName,
                    answer: answer,
                    gameCode: gameCode,
                    at: Date.now(),
                    isClarification: wasClarity
                };
                io.to(gameCode).emit('newAnswerSubmitted', newAnswerEvent);
                logger.debug(`📤 Sent newAnswerSubmitted event for ${playerName} (clarification: ${wasClarity})`);
                logger.debug(`📤 Event data:`, newAnswerEvent);
                
                io.to(gameCode).emit('answerUpdate', answerUpdatePayload(game));
                
                // Don't auto-end when there are pending clarifications
                if (game.answersNeedingEdit.size > 0) {
                    logger.debug(`⏳ Not auto-ending: ${game.answers.size}/${game.players.size} answers, ${game.answersNeedingEdit.size} pending clarifications`);
                }
            } else {
                logger.info(`🚫 ${playerName} answer rejected`);
                socket.emit('answerError', { message: 'Answer submission failed' });
            }
        } catch (e) {
            logger.error('Error in submitAnswer event handler:', e?.message);
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
        
        if (!canControlGame(gameCode)) {
            console.log('⚠️ completeGrading rejected - not host or grader');
            return;
        }
        
        const game = activeGames.get(gameCode);
        if (!game) {
            console.log('⚠️ completeGrading rejected - game not found');
            return;
        }
        
        if (game.gameState !== 'grading') {
            console.log(`⚠️ completeGrading rejected - invalid state: ${game.gameState}`);
            socket.emit('gameError', { message: 'Finish the question before grading. Players are still answering.' });
            return;
        }
        if (typeof data.questionIndex === 'number' && data.questionIndex !== game.currentQuestion) {
            socket.emit('gameError', {
                message: `This grading board is for question ${data.questionIndex + 1}, but the game is on question ${game.currentQuestion + 1}. Re-open grading.`
            });
            return;
        }
        const liveEpoch = lockstep.gameEpoch(game.gameCode, game.currentQuestion, game.gameState);
        if (typeof data.epoch === 'string' && data.epoch && data.epoch !== liveEpoch) {
            socket.emit('gameError', { message: 'This grading board is out of date. Re-open grading.' });
            return;
        }

        const pendingEditCount = game.answersNeedingEdit ? game.answersNeedingEdit.size : 0;
        if (pendingEditCount > 0 && !data.forceComplete) {
            socket.emit('gameError', {
                message: `${pendingEditCount} player${pendingEditCount === 1 ? ' is' : 's are'} still rewriting a sent-back answer. Wait or send forceComplete.`
            });
            return;
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
            console.log('🎯 Applied categorization data to game');

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
            console.log('🎯 Applied current question points');

            // Move to scoring phase
            game.gameState = 'scoring';
            console.log('🎯 Moved to scoring phase');

            // Persist authoritative snapshot BEFORE notifying clients
            try { 
                await persistSnapshot(game, 'grading_complete'); 
                console.log('🎯 Persisted grading complete snapshot');
            } catch(error) {
                console.error('❌ Error persisting grading_complete snapshot:', error);
            }
            
            // CRITICAL FIX: Add comprehensive error handling for gradingComplete emission
            try {
                console.log(`🎯 Emitting gradingComplete for game ${gameCode}`);
                console.log(`🎯 Room exists:`, io.sockets.adapter.rooms.has(gameCode));
                
                // Send to all clients in the room
                broadcastState(game, 'gradingComplete');
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
                    console.log(`✅ Sent fallback error message`);
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
              console.log('🎯 Persisted grading results to database');
            } catch(dbError) {
                console.error('❌ Error persisting to database:', dbError);
            }
            
        } catch (err) {
            console.error('❌ completeGrading failed, forcing transition to scoring:', err);
            try {
                // Best-effort fallback: ensure state progresses
                game.applyCurrentQuestionPoints();
                game.gameState = 'scoring';
                broadcastState(game, 'gradingComplete');
                console.log('✅ Applied fallback grading completion');
            } catch (fallbackError) {
                console.error('❌ Even fallback failed:', fallbackError);
            }
        }
    });

    // Next question (only after grading is complete)
    socket.on('nextQuestion', async (data) => {
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
            
            if (!canControlGame(gameCode)) {
                console.log(`⚠️ nextQuestion rejected - not host or grader`);
                return;
            }
            
            const game = activeGames.get(gameCode);
            if (!game) {
                console.log(`⚠️ nextQuestion rejected - game not found: ${gameCode}`);
                return;
            }
            
            console.log(`🎯 Game state check: ${game.gameState}, currentQuestion: ${game.currentQuestion}`);
            
            if (game.gameState === 'waiting') {
                console.log(`🎯 nextQuestion on waiting lobby ${gameCode}; starting the game instead`);
                await startHostGame(socket, gameCode);
                return;
            }
            if (game.gameState !== 'scoring') {
                console.log(`⚠️ nextQuestion rejected - invalid state: ${game.gameState}`);
                socket.emit('gameError', { message: `Cannot go to the next question yet (${game.gameState})` });
                return;
            }
            if (game.answersNeedingEdit && game.answersNeedingEdit.size > 0) {
                socket.emit('gameError', { message: 'Players still have unanswered send-backs' });
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
                    broadcastState(game, 'showOverallLeaderboard');
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
    const blocked = leaderboardToolBlock(game);
    if (blocked) {
      socket.emit('gameError', { message: blocked });
      return;
    }
    game.gameState = 'roundComplete';
    const history = Array.isArray(game.roundHistory) ? game.roundHistory : [];
    const patch = history.length ? null : { roundHistory: [game.liveRoundData()] };
    const state = broadcastState(game, 'roundComplete', patch);
    io.to(gameCode).emit('playerShowRoundResults', state);
            sbLogEvent(gameCode, 'show_round_leaderboard', {});
  });

    // Show overall / championship leaderboard on the public display
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

        const blocked = leaderboardToolBlock(game);
        if (blocked) {
            socket.emit('gameError', { message: blocked });
            return;
        }
        
        console.log(`📊 Host showing overall leaderboard for game ${gameCode}`);
        game.gameState = 'overallLeaderboard';
        
        const state = broadcastState(game, 'showOverallLeaderboard');
        io.to(gameCode).emit('playerShowOverallLeaderboard', state);
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
        
        game.stopTimer();
        try { game.rebuildCurrentAnswerGroups(); } catch (_) {}
        game.gameState = 'grading';
        
        console.log('📤 Sending questionComplete from endQuestion');
        
        // Debug: Check who's in the room
        const roomSockets = await io.in(gameCode).fetchSockets();
        console.log(`🔍 Room ${gameCode} has ${roomSockets.length} sockets:`, roomSockets.map(s => s.id));
        
        try { await persistSnapshot(game, 'question_complete'); } catch(_) {}
        broadcastState(game, 'questionComplete');
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
        
        game.gameState = 'finished';
        const gameState = broadcastState(game, 'gameFinished');
        console.log(`🎮 Game state before cleanup:`, gameState && gameState.gameState);
        
        game.cleanup();
        activeGames.delete(gameCode);
        
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
        sendStateToSocket(socket, game, 'displayGameState');
        
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
        sendStateToSocket(displaySocket, game, 'displayGameState');
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
        sendStateToSocket(socket, game, 'gameStateResponse');

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
        console.log(`�� Sent ${gamesArray.length} active games to grading interface`);
    });

    // Get specific game state by game code
    socket.on('getGameState', (data) => {
        if (data === undefined || data === null) {
            console.log('⚠️ getGameState event received with no data');
            return;
        }
        
        // Support both legacy string payloads and object payloads
        const gameCode = (typeof data === 'string') ? data : data.gameCode;
        
        if (!gameCode) {
            console.log('⚠️ getGameState event received with no gameCode');
            return;
        }
        
        console.log('🔍 Requesting specific game state for:', gameCode);
        
        const game = activeGames.get(gameCode);
        if (game) {
            const liveAnswering = game.gameState === 'playing'
                || (game.gameState === 'grading' && !game.currentQuestionScored);
            if (liveAnswering) {
                try {
                    game.rebuildCurrentAnswerGroups();
                } catch (_) {}
            }
            sendStateToSocket(socket, game, 'gameStateResponse');
            console.log(`📤 Sent lockstep state for ${gameCode}: ${game.gameState}`);
        } else {
            console.log(`❌ Game ${gameCode} not found`);
            socket.emit('gameStateResponse', null);
        }
    });

    socket.on('requestState', (data) => {
        const gameCode = (typeof data === 'string') ? data : data && data.gameCode;
        if (!gameCode) return;
        const game = activeGames.get(gameCode);
        if (game) sendStateToSocket(socket, game);
    });

    socket.on('loadQuestions', async (data) => {
        if (!data || !data.gameCode) return;
        if (!canControlGame(data.gameCode)) return;
        const game = activeGames.get(data.gameCode);
        if (!game) {
            socket.emit('gameError', { message: 'Game not found' });
            return;
        }
        let questionsToLoad = Array.isArray(data.questions) ? normalizeQuestions(data.questions) : [];
        if (data.loadFromDatabase || questionsToLoad.length === 0) {
            const bank = await getQuestionBank(game.settings && game.settings.questionSet === 'demo');
            questionsToLoad = bank.questions;
        }
        game.questions = questionsToLoad;
        io.to(data.gameCode).emit('questionsLoaded', {
            gameCode: data.gameCode,
            questionsCount: questionsToLoad.length,
            questions: questionsToLoad
        });
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
                try { if (game.expectedResponders instanceof Set) game.expectedResponders.delete(socket.id); } catch (_) {}
                game.removePlayer(socket.id);
                console.log(`👋 Removed player ${playerName} from game ${gameCode}`);
                broadcastState(game, 'playerLeft');
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
                if (playerInfo.isDisplay || playerInfo.isGradingInterface) {
                    console.log(`${playerInfo.isDisplay ? '📺 Display' : '📝 Grading'} disconnected from game ${playerInfo.gameCode}`);
                } else {
                    // Delay removal to tolerate hall Wi-Fi reconnects
                    setTimeout(() => {
                        const stillConnected = connectedPlayers.has(socket.id);
                        if (stillConnected) return;
                        const player = game.players.get(socket.id);
                        const keepSeat = !!(player && (
                            game.answers.has(socket.id) ||
                            game.answersNeedingEdit.has(socket.id) ||
                            (player.stableId && game.answeredStableIds && game.answeredStableIds.has(player.stableId))
                        ));
                        if (keepSeat) {
                            console.log(`⏳ Keeping seat for ${player?.name || socket.id} after disconnect`);
                            return;
                        }
                        try { if (game.expectedResponders instanceof Set) game.expectedResponders.delete(socket.id); } catch(_) {}
                        game.removePlayer(socket.id);
                        broadcastState(game, 'playerLeft');
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
                    }, 20000);
                }
            }
        }
        
        // Defer deletion until after grace: mark a timestamp so rebind can be detected
        setTimeout(() => {
            connectedPlayers.delete(socket.id);
        }, 20000);
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

app.get('/api/load-questions', async (req, res) => {
    try {
        const preferDemo = String(req.query.source || '') === 'demo';
        const bank = await getQuestionBank(preferDemo);
        res.json({
            status: 'success',
            questions: bank.questions,
            count: bank.count,
            source: bank.source
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

// Start server — bind 0.0.0.0 so Railway (and LAN) can reach it
const PORT = Number(process.env.PORT) || 3001;
const HOST = process.env.HOST || '0.0.0.0';
server.listen(PORT, HOST, () => {
    console.log(`🚀 MEGASheep listening on ${HOST}:${PORT}`);
    console.log(`🌐 Local: http://localhost:${PORT}`);
    initPostgres()
        .then(() => seedPostgresFromFileBank())
        .then(() => {
            if (postgresEnabled()) console.log('🗄️  Railway Postgres ready');
        })
        .catch((e) => console.warn('⚠️  Postgres init skipped:', e.message));
}); 