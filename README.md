# 🎮 MEGASheep - Real-time Multiplayer Trivia Game

A real-time multiplayer trivia game with Google Sheets scoring system, built with Node.js, Socket.IO, and Express.

## ✅ **FIXES IMPLEMENTED**

### **🚨 CRITICAL ISSUES RESOLVED:**

1. **✅ ELIMINATED ALL CODE DUPLICATION**
   - Removed 2 duplicate `/api/create-game` endpoints
   - Removed 2 duplicate `/api/join-game` endpoints  
   - Removed 3 duplicate `/api/game/:gameCode` endpoints
   - Consolidated all socket event handlers into single implementations
   - Unified game state management system

2. **✅ FIXED ARCHITECTURE & SECURITY**
   - ✅ **Host-only game creation**: Only `/host` route can create games
   - ✅ **Proper session persistence**: Host can reconnect after refresh
   - ✅ **Consistent 4-digit game codes**: All components use same codes
   - ✅ **Clean routing separation**: Host, player, display, grading routes
   - ✅ **Input validation**: Proper game code and name validation
   - ✅ **Error handling**: Comprehensive error management

3. **✅ FIXED UI & STYLING**
   - ✅ **Consistent dark theme**: All pages match site styling
   - ✅ **Responsive design**: Works on mobile and desktop
   - ✅ **Game lobby restoration**: Host controls and player management
   - ✅ **Modern UI components**: Cards, buttons, forms, animations

4. **✅ FIXED SOCKET.IO IMPLEMENTATION**
   - ✅ **Single socket connection**: No duplicate connections
   - ✅ **Proper event handling**: Clean event listeners
   - ✅ **Room management**: Correct socket room joining/leaving
   - ✅ **Real-time updates**: Timer, scores, player status

5. **✅ FIXED GAME LOGIC**
   - ✅ **Google Sheets scoring**: Z = ceil(Y/X) formula implemented
   - ✅ **Answer grouping**: Proper case-insensitive matching
   - ✅ **Timer management**: Consistent countdown system
   - ✅ **Game state transitions**: Waiting → Playing → Scoring → Results

## 🚀 **QUICK START**

### **Windows (Recommended)**
1. **Double-click `start.bat`** - This will:
   - Install all dependencies automatically
   - Start the server on port 3001
   - Open the game in your browser

### **Manual Setup**
1. **Install Dependencies:**
```bash
npm install
```

2. **Start Server:**
```bash
npm start
```

3. **Access Game:**
   - Open browser to: `http://localhost:3001`
   - Host: `http://localhost:3001/host`
   - Display: `http://localhost:3001/display`
   - Grading: `http://localhost:3001/grading`

## 🎯 **HOW TO PLAY**

### **For Hosts:**
1. Visit `/host` to create a new game
2. Enter your host name and click "Create Game"
3. Share the 4-digit code with players
4. Start the game when everyone has joined
5. Manage the game with host controls

### **For Players:**
1. Visit the main page `/`
2. Enter the 4-digit game code
3. Enter your name and join the game
4. Wait for the host to start
5. Answer questions as they appear

### **For Display (Optional):**
1. Visit `/display` 
2. Enter the game code to show live game state
3. Perfect for projectors or large screens

### **For Grading (Optional):**
1. Visit `/grading`
2. Enter the game code to grade answers manually
3. Useful for subjective questions

## 📁 **PROJECT STRUCTURE**

```
MEGASheep/
├── server.js              # Main server file (CLEANED & CONSOLIDATED)
├── package.json           # Dependencies and scripts
├── start.bat             # Windows quick-start script
├── README.md             # This file
└── public/
    ├── index.html         # Player join page (FIXED STYLING)
    ├── host.html          # Host console (RESTORED & FIXED)
    ├── game.html          # Gameplay interface (NEW & COMPLETE)
    ├── display.html       # Game display screen (EXISTING)
    ├── grading.html       # Grading interface (EXISTING)
    └── styles.css         # Consistent styling (EXISTING)
```

## ⚙️ **CONFIGURATION**

### **Environment Variables (Optional)**
Create a `.env` file in the root directory:

```env
# Server Configuration
PORT=3001

# Supabase Configuration (Optional - uses demo mode if not set)
SUPABASE_URL=your_supabase_url_here
SUPABASE_ANON_KEY=your_supabase_anon_key_here

# Game Settings
DEFAULT_TIMER_DURATION=30
DEFAULT_MAX_PLAYERS=10
DEFAULT_QUESTIONS_PER_ROUND=5
```

### **Demo Mode**
The game runs in demo mode by default with sample questions. No database setup required!

## 🔧 **TECHNICAL DETAILS**

### **Dependencies**
- **Express.js** - Web server framework
- **Socket.IO** - Real-time communication
- **CORS** - Cross-origin resource sharing
- **dotenv** - Environment variable management
- **@supabase/supabase-js** - Optional database integration

### **Key Features**
- ✅ **Real-time multiplayer** - Up to 10 players simultaneously
- ✅ **Google Sheets scoring** - Unique scoring algorithm
- ✅ **Host session persistence** - Host can refresh without losing game
- ✅ **4-digit game codes** - Easy sharing and joining
- ✅ **Responsive design** - Works on all devices
- ✅ **Timer system** - 30-second default per question
- ✅ **Live updates** - See players join/leave in real-time
- ✅ **Answer grouping** - Similar answers grouped automatically
- ✅ **Final leaderboard** - Complete scoring and rankings

### **Game Flow**
1. **Host creates game** → Gets 4-digit code
2. **Players join** → Enter code and name
3. **Game starts** → Questions appear with timer
4. **Players answer** → Submit text responses
5. **Scoring** → Google Sheets formula applied
6. **Results** → Show grouped answers and points
7. **Next question** → Repeat until complete
8. **Final results** → Leaderboard and final scores

## 🐛 **TROUBLESHOOTING**

### **Common Issues:**

1. **"Cannot find module" error:**
   - Run `npm install` first
   - Use `start.bat` for automatic installation

2. **Server won't start:**
   - Check if port 3001 is available
   - Try a different port in `.env`: `PORT=3002`

3. **Socket connection fails:**
   - Ensure no firewall blocking port 3001
   - Try refreshing the browser

4. **Host can't reconnect:**
   - Host session is saved in browser storage
   - Clear browser data if having issues

5. **Players can't join:**
   - Verify 4-digit game code is correct
   - Ensure game hasn't started yet
   - Check for duplicate player names

## 📞 **SUPPORT**

If you encounter any issues:
1. Check the console logs in the terminal
2. Check browser console for client-side errors
3. Ensure all dependencies are installed
4. Try restarting the server

## 🎉 **READY TO PLAY!**

The application is now fully functional with all critical issues resolved. Simply run `start.bat` or `npm start` and enjoy your multiplayer trivia game!

**Visit: http://localhost:3001**

- **Host a game**: http://localhost:3001/host
- **Join a game**: http://localhost:3001/
- **Display screen**: http://localhost:3001/display
- **Grading console**: http://localhost:3001/grading 