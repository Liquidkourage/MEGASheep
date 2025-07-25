const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');
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
        supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
        
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
                console.log('🔄 Falling back to demo mode');
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
        
        // Calculate points using Google Sheets formula: Z = Y/X rounded up
        for (const [answer, socketIds] of answerGroups) {
            const X = socketIds.length; // Number of responses matching this answer
      const Y = totalResponses;   // Total number of responses
      const Z = Math.ceil(Y / X); // Points earned (rounded up)
      
      // Award points to all players with this answer
            for (const socketId of socketIds) {
                const currentScore = this.scores.get(socketId) || 0;
                this.scores.set(socketId, currentScore + Z);
                
                const player = this.players.get(socketId);
        if (player) {
                    player.score = this.scores.get(socketId);
                }
            }
        }
        
        // Store answer groups for display
        this.currentAnswerGroups = Array.from(answerGroups.entries()).map(([answer, socketIds]) => {
            const X = socketIds.length;
      const Y = totalResponses;
      const Z = Math.ceil(Y / X);
      
      return {
        answer,
        count: X,
        points: Z,
        totalResponses: Y,
                players: socketIds.map(id => {
                    const player = this.players.get(id);
                    return player ? player.name : 'Unknown';
                })
      };
    });
    
        // Sort by points (highest first)
    this.currentAnswerGroups.sort((a, b) => b.points - a.points);
        
        console.log(`📊 Calculated scores for ${totalResponses} answers in ${answerGroups.size} groups`);
        console.log(`📊 Final answer groups:`, this.currentAnswerGroups.map(g => ({ answer: g.answer, count: g.count, points: g.points })));
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
}

// Utility function to call the semantic matcher service
async function getSemanticMatches(question, correctAnswers, responses) {
    try {
        const res = await fetch('http://localhost:5005/semantic-match', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                question,
                correct_answers: correctAnswers,
                responses
            })
        });
        if (!res.ok) throw new Error('Semantic matcher service error');
        const data = await res.json();
        return data.results;
    } catch (err) {
        console.error('Semantic matcher error:', err);
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
    res.sendFile(path.join(__dirname, 'public', 'game.html'));
});

app.get('/upload', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'upload.html'));
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
        const { gameCode, playerName } = data;
        
        if (!gameCode || !playerName) {
            socket.emit('gameError', { message: 'Game code and player name are required' });
            return;
        }
        
        const game = activeGames.get(gameCode);
        if (!game) {
            socket.emit('gameError', { message: 'Game not found. Please check the game code.' });
            return;
        }
        
        if (game.gameState !== 'waiting') {
            socket.emit('gameError', { message: 'Game has already started. Cannot join.' });
            return;
  }
  
          try {
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
                game.addPlayer(socket.id, playerName);
                
                // Notify everyone in the game room about the new player
                io.to(gameCode).emit('playerJoined', game.getGameState());
            } else {
                console.log('🏠 Host', playerName, 'joined room for game', gameCode);
            }
            
            socket.join(gameCode);
            
            // Confirm to player
            socket.emit('gameJoined', {
                gameCode: gameCode,
                gameState: game.getGameState(),
                playerCount: game.players.size
            });
    
  } catch (error) {
            socket.emit('gameError', { message: error.message });
        }
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
            game.startTimer();
            
            const gameStateToSend = game.getGameState();
            io.to(gameCode).emit('gameStarted', gameStateToSend);
            
        } catch (error) {
            console.error('Error starting game:', error);
            socket.emit('gameError', { message: error.message || 'Failed to start game' });
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
            game.currentAnswerGroups = categorizedAnswers;
        }
        
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

// Serve static files
app.use(express.static('public'));

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

// Route handlers
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/host', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'host.html'));
});

app.get('/game', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'game.html'));
});

app.get('/grading', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'grading.html'));
});

app.get('/display', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'display.html'));
});

// Start server
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`🚀 MEGASheep server running on port ${PORT}`);
    console.log(`🌐 Visit http://localhost:${PORT} to play!`);
}); 