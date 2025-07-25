const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Game state
const activeGames = new Map();
const players = new Map();

// Generate a unique 4-digit game code
function generateGameCode() {
  let code;
  do {
    code = Math.floor(1000 + Math.random() * 9000).toString();
  } while (activeGames.has(code));
  return code;
}

// Game class
class Game {
  constructor(hostId) {
    this.hostId = hostId;
    this.gameCode = generateGameCode();
    this.players = new Map();
    this.gameState = 'waiting';
    this.createdAt = Date.now();
  }

  addPlayer(playerId, playerName) {
    this.players.set(playerId, {
      id: playerId,
      name: playerName,
      score: 0
    });
  }

  getGameState() {
    return {
      gameCode: this.gameCode,
      hostId: this.hostId,
      players: Array.from(this.players.values()),
      gameState: this.gameState,
      playerCount: this.players.size
    };
  }
}

// API endpoints
app.post('/api/create-game', (req, res) => {
  const { hostName } = req.body;
  
  if (!hostName || hostName.trim() === '') {
    return res.status(400).json({ 
      status: 'error', 
      message: 'Host name is required' 
    });
  }
  
  const game = new Game(hostName);
  activeGames.set(game.gameCode, game);
  
  console.log(`🎮 Created new game: ${game.gameCode} by ${hostName}`);
  
  res.json({
    status: 'success',
    gameCode: game.gameCode,
    hostName: hostName,
    message: `Game created with code: ${game.gameCode}`
  });
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log(`🔌 New socket connection: ${socket.id}`);
  
  // Store player connection
  players.set(socket.id, {
    id: socket.id,
    connectedAt: Date.now()
  });
  
  socket.on('disconnect', () => {
    console.log(`🔌 Socket disconnected: ${socket.id}`);
    players.delete(socket.id);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Debug server running on port ${PORT}`);
}); 