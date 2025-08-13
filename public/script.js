// Read-only History modal logic (host only)
function openHistoryModal() {
    if (!isHost) return;
    const modal = document.getElementById('historyModal');
    if (!modal) return;
    try {
        populateHistorySelectors();
    } catch (_) {}
    modal.style.display = 'block';
    setTimeout(() => { modal.style.opacity = '1'; }, 10);
}

function closeHistoryModal() {
    const modal = document.getElementById('historyModal');
    if (!modal) return;
    modal.style.opacity = '0';
    setTimeout(() => { modal.style.display = 'none'; }, 200);
}

function switchHistoryTab(which) {
    const byPlayer = document.getElementById('historyByPlayer');
    const byQuestion = document.getElementById('historyByQuestion');
    const tabP = document.getElementById('tabByPlayer');
    const tabQ = document.getElementById('tabByQuestion');
    if (!byPlayer || !byQuestion || !tabP || !tabQ) return;
    if (which === 'player') {
        byPlayer.style.display = 'block';
        byQuestion.style.display = 'none';
        tabP.classList.add('active');
        tabQ.classList.remove('active');
    } else {
        byPlayer.style.display = 'none';
        byQuestion.style.display = 'block';
        tabQ.classList.add('active');
        tabP.classList.remove('active');
    }
}

function populateHistorySelectors() {
    // Players selector
    const selPlayer = document.getElementById('historyPlayerSelect');
    if (selPlayer) {
        selPlayer.innerHTML = '';
        const players = Array.isArray(gameState.players) ? gameState.players : [];
        players.forEach(p => {
            const opt = document.createElement('option');
            opt.value = String(p.name);
            opt.textContent = p.name;
            selPlayer.appendChild(opt);
        });
        selPlayer.onchange = renderHistoryByPlayer;
        renderHistoryByPlayer();
    }

    // Questions selector (use server-sent questions)
    const selQuestion = document.getElementById('historyQuestionSelect');
    if (selQuestion) {
        selQuestion.innerHTML = '';
        const qs = Array.isArray(gameState.questions) ? gameState.questions : [];
        qs.forEach((q, idx) => {
            const opt = document.createElement('option');
            opt.value = String(idx);
            opt.textContent = `Q${idx + 1}: ${q?.question?.slice(0, 50) || 'Question'}`;
            selQuestion.appendChild(opt);
        });
        selQuestion.onchange = renderHistoryByQuestion;
        renderHistoryByQuestion();
    }
}

function renderHistoryByPlayer() {
    const selPlayer = document.getElementById('historyPlayerSelect');
    const list = document.getElementById('historyPlayerList');
    if (!selPlayer || !list) return;
    const name = selPlayer.value || '';

    // Build from window._questionHistory snapshots and server roundHistory
    const qHist = Array.isArray(window._questionHistory) ? window._questionHistory : [];
    const rows = [];
    qHist.forEach(snap => {
        // Find this player's group
        const group = (snap.answerGroups || []).find(g => Array.isArray(g.players) && g.players.some(p => String(p).toLowerCase() === name.toLowerCase()));
        if (group) {
            rows.push({
                questionIndex: snap.questionIndex,
                roundNumber: snap.roundNumber,
                answer: group.answer,
                points: group.points
            });
        }
    });
    rows.sort((a,b) => a.questionIndex - b.questionIndex);

    list.innerHTML = rows.length === 0 ? '<div class="score-item">No history yet</div>' : rows.map(r => `
        <div class="score-item">
            <span class="player-name">Q${(r.questionIndex + 1)} (R${r.roundNumber}) — ${r.answer}</span>
            <span class="player-score">${r.points} pts</span>
        </div>
    `).join('');
}

function renderHistoryByQuestion() {
    const selQuestion = document.getElementById('historyQuestionSelect');
    const list = document.getElementById('historyQuestionList');
    if (!selQuestion || !list) return;
    const qIndex = Number(selQuestion.value || 0);
    const qHist = Array.isArray(window._questionHistory) ? window._questionHistory : [];
    const snap = qHist.find(s => Number(s.questionIndex) === qIndex);
    if (!snap) {
        list.innerHTML = '<div class="score-item">No data captured for this question yet</div>';
        return;
    }
    const groups = Array.isArray(snap.answerGroups) ? snap.answerGroups : [];
    // Flatten into rows: answer, points, players (count)
    const rows = groups.map(g => ({ answer: g.answer, points: g.points, count: (Array.isArray(g.players) ? g.players.length : (g.count || 0)) }));
    rows.sort((a,b) => b.points - a.points || b.count - a.count);
    list.innerHTML = rows.map(r => `
        <div class="score-item">
            <span class="player-name">${r.answer} (${r.count})</span>
            <span class="player-score">${r.points} pts</span>
        </div>
    `).join('');
}
// Global variables
let socket;
let isHost = false;
let currentPlayerName;
let gameState = {};
let questions = [];
let currentQuestionIndex = 0;
let timer = null;
let timeLeft = 30;
let gameStartTime = null;
let gameDurationTimer = null;
let autoResumeAttempted = false;
let autoResumeInProgress = false;

// Lightweight identity persistence for player auto-resume
function savePlayerIdentity(gameCode, playerName) {
    try {
        if (gameCode) localStorage.setItem('player.gameCode', String(gameCode));
        if (playerName) {
            localStorage.setItem('player.name', String(playerName));
            sessionStorage.setItem('playerName', String(playerName));
        }
    } catch (_) {}
}

function getSavedIdentity() {
    try {
        const savedGameCode = localStorage.getItem('player.gameCode');
        const savedPlayerName = localStorage.getItem('player.name');
        // Validate format: gameCode must be 4 digits, playerName non-empty
        const isValidCode = typeof savedGameCode === 'string' && /^\d{4}$/.test(savedGameCode);
        const isValidName = typeof savedPlayerName === 'string' && savedPlayerName.trim().length > 0;
        if (isValidCode && isValidName) {
            return { gameCode: savedGameCode, playerName: savedPlayerName };
        }
    } catch (_) {}
    return null;
}

function attemptAutoResume() {
    if (autoResumeAttempted) return false;
    const ident = getSavedIdentity();
    if (!ident) return false;
    autoResumeAttempted = true;
    autoResumeInProgress = true;

    // Emit join when connected (or immediately if already connected)
    const emitJoin = () => {
        try {
            console.log('🔄 Auto-resume: attempting silent rejoin', ident);
            socket.emit('joinGame', { gameCode: ident.gameCode, playerName: ident.playerName });
        } catch (e) {
            console.warn('Auto-resume emit failed:', e);
        }
    };
    if (socket && socket.connected) {
        emitJoin();
    } else if (socket) {
        socket.once('connect', emitJoin);
    }
    return true;
}

// Answer categorization state
let answerCategorization = {
    buckets: {
        uncategorized: [],
        correct: [],
        wrong: []
    },
    customBuckets: [],
    categorizedAnswers: {},
    isCategorizationMode: false
};

// Drag and drop state
let draggedElement = null;
let dragSource = null;

// DOM elements
const screens = {
    welcome: document.getElementById('welcomeScreen'),
    createGame: document.getElementById('createGameScreen'),
    joinGame: document.getElementById('joinGameScreen'),
    lobby: document.getElementById('lobbyScreen'),
    game: document.getElementById('gameScreen'),
    scoring: document.getElementById('scoringScreen'),
    gameOver: document.getElementById('gameOverScreen')
};

// Initialize the application
document.addEventListener('DOMContentLoaded', () => {
    const IS_HOST_ROUTE = window.location.pathname === '/host';
    initializeSocket();
    setupEventListeners();
    
    // Only on main player page
    if (typeof screens !== 'undefined' && screens.joinGame) {
        // If a game code is present in the URL, ALWAYS prefer it over auto-resume
        try {
            const params = new URLSearchParams(window.location.search);
            const codeParam = params.get('game') || params.get('code') || params.get('gameCode') || params.get('room');
            showScreen('joinGame');
            const gameCodeInput = document.getElementById('gameCode');
            if (codeParam && /^\d{4}$/.test(codeParam)) {
                if (gameCodeInput) {
                    gameCodeInput.value = codeParam;
                    gameCodeInput.readOnly = true;
                    gameCodeInput.setAttribute('aria-readonly', 'true');
                    gameCodeInput.style.opacity = '0.7';
                    gameCodeInput.style.pointerEvents = 'none';
                    gameCodeInput.title = 'Game code provided by link';
                    // Hide the code field entirely when provided via URL
                    try { gameCodeInput.required = false; } catch(_) {}
                    try { const grp = gameCodeInput.closest('.form-group'); if (grp) grp.style.display = 'none'; } catch(_) {}
                    // Override any saved identity code with the URL code
                    try { sessionStorage.setItem('gameCode', codeParam); localStorage.setItem('player.gameCode', codeParam); } catch(_) {}
                }
                const playerNameInput = document.getElementById('playerName');
                if (playerNameInput) playerNameInput.focus();
            } else {
                // No URL code -> attempt auto-resume
                const resumed = attemptAutoResume();
                if (!resumed) {
                    showScreen('joinGame');
                }
            }
        } catch (_) {
            showScreen('joinGame');
        }
        
        // Auto-focus game code input when join game screen is shown
        setTimeout(() => {
            const gameCodeInput2 = document.getElementById('gameCode');
            if (gameCodeInput2) {
                gameCodeInput2.focus();
                
                // Auto-format game code input (numbers only, uppercase)
                gameCodeInput2.addEventListener('input', (e) => {
                    e.target.value = e.target.value.replace(/[^0-9]/g, '').toUpperCase();
                });
                
                // Auto-advance to name field when 4 digits entered
                gameCodeInput2.addEventListener('input', (e) => {
                    if (e.target.value.length === 4) {
                        const playerNameInput = document.getElementById('playerName');
                        if (playerNameInput) {
                            playerNameInput.focus();
                        } else {
                            joinGame();
                        }
                    }
                });
            }
        }, 100);
    }
    
    // Add debug function to global scope for testing
    window.debugCategorization = function() {
        console.log('🔧 Debug: Testing categorization interface');
        isHost = true; // Force host mode for testing
        testCategorization();
    };
    
    console.log('🎮 MEGASheep initialized. Use debugCategorization() in console to test categorization.');
});

// Resolve game code from URL params, session, or input
function resolveGameCodeValue() {
    // PRIORITY: typed input > URL param > session
    const input = document.getElementById('gameCode');
    const typed = input && typeof input.value === 'string' ? input.value.trim() : '';
    if (/^\d{4}$/.test(typed)) return typed;
    try {
        const params = new URLSearchParams(window.location.search);
        const fromUrl = params.get('game') || params.get('code') || params.get('gameCode') || params.get('room');
        if (fromUrl && /^\d{4}$/.test(fromUrl)) return fromUrl;
    } catch(_) {}
    try {
        const fromSession = sessionStorage.getItem('gameCode');
        if (fromSession && /^\d{4}$/.test(fromSession)) return fromSession;
    } catch(_) {}
    return '';
}

// Socket.IO initialization
function initializeSocket() {
    console.log('🎮 Script.js: Initializing socket connection...');
    
    socket = io();
    
    // Add error handling
    socket.on('connect_error', (error) => {
        console.error('🎮 Script.js: Socket connection error:', error);
    });
    
    socket.on('error', (error) => {
        console.error('🎮 Script.js: Socket error:', error);
    });
    
    socket.on('disconnect', (reason) => {
        console.log('🎮 Script.js: Socket disconnected:', reason);
    });
    
    socket.on('connect', () => {
        console.log('✅ Connected to server with ID:', socket.id);
        console.log('🎮 Script.js: Socket connection established successfully');
    });
    
    // Connection debugging
    socket.on('connect', () => {
        console.log('✅ Connected to server with ID:', socket.id);
    });
    
    socket.on('disconnect', () => {
        console.log('❌ Disconnected from server');
    });
    
    socket.on('connect_error', (error) => {
        console.error('❌ Connection error:', error);
        showError('Failed to connect to server');
    });

    // Host-triggered: show round results on player UI
    socket.on('playerShowRoundResults', (state) => {
        try {
            if (!state) return;
            gameState = state;
            showScreen('scoring');
            displayRoundResults();
        } catch (_) {}
    });

    socket.on('playerShowOverallLeaderboard', (state) => {
        try {
            if (!state) return;
            gameState = state;
            showScreen('gameOver');
            displayFinalResults();
        } catch (_) {}
    });
    
    // Socket event listeners
    socket.on('gameCreated', handleGameCreated);
    socket.on('gameJoined', handleGameJoined);
    socket.on('playerJoined', handlePlayerJoined);
    socket.on('virtualPlayerJoined', handlePlayerJoined); // Add virtual player support
    socket.on('playerLeft', handlePlayerJoined);
    socket.on('gameStarted', handleGameStarted);
    socket.on('testGameStarted', handleTestGameStarted);
    socket.on('nextQuestion', handleNextQuestion);
    socket.on('questionComplete', handleQuestionComplete);
    socket.on('roundComplete', handleRoundComplete);
    socket.on('gameFinished', handleGameFinished);
    socket.on('error', handleError);
    socket.on('answerSubmitted', handleAnswerSubmitted);
    socket.on('answerUpdate', handleAnswerUpdate);
    socket.on('timerUpdate', handleTimerUpdate);
    socket.on('gradingComplete', handleGradingComplete);
    socket.on('gameStateUpdate', handleGameStateUpdate);

    // Private host answer for this player
    socket.on('hostAnswer', (data) => {
        try {
            const msg = data && data.answer ? data.answer : '';
            if (!msg) return;
            const statusEl = document.getElementById('answerStatus');
            if (statusEl) {
                statusEl.textContent = `💬 Host: ${msg}`;
            }
        } catch (_) {}
    });

    // Host requested a more specific answer (Send Back)
    socket.on('requireAnswerEdit', (data) => {
        try {
            const reason = (data && data.reason) ? data.reason : 'Please be more specific';
            console.log('✏️ Script.js: requireAnswerEdit received:', data);

            // Ensure player UI is visible
            if (typeof screens !== 'undefined' && screens.game) {
                showScreen('game');
            }

            // Ensure the player answer form is visible for players
            const form = document.getElementById('playerAnswerForm');
            if (form) form.style.display = isHost ? 'none' : 'block';

            const input = document.getElementById('answerInput');
            const btn = document.getElementById('submitAnswerBtn');
            if (input) input.disabled = false;
            if (btn) btn.disabled = false;

            // Prefill with original answer if provided
            if (input && data && data.originalAnswer && !input.value) {
                input.value = data.originalAnswer;
            }

            // Show a toast notification for edit request
            showToast(`✏️ Edit requested by host: ${reason}`, 'warning');

            // Focus input
            if (input) input.focus();

            // Haptic feedback (mobile)
            if (navigator && navigator.vibrate) {
                navigator.vibrate(120);
            }
        } catch (e) {
            console.warn('Script.js: Failed to present edit request', e);
        }
    });
}

// Stable player identity across reconnects
function getOrCreatePlayerId() {
    try {
        let pid = localStorage.getItem('player.id');
        if (!pid) {
            pid = 'p_' + Math.random().toString(36).slice(2) + '_' + Date.now().toString(36);
            localStorage.setItem('player.id', pid);
        }
        return pid;
    } catch (_) {
        // Fallback to ephemeral if storage unavailable
        return 'p_' + Math.random().toString(36).slice(2);
    }
}

// Event listeners setup
function setupEventListeners() {
    // Welcome screen
    const createGameBtn = document.getElementById('createGameBtn');
    if (createGameBtn) createGameBtn.addEventListener('click', () => showScreen('createGame'));
    
    const joinGameBtn = document.getElementById('joinGameBtn');
    if (joinGameBtn) joinGameBtn.addEventListener('click', () => showScreen('joinGame'));
    
    // Join game screen (default)
    const joinGameSubmitBtn = document.getElementById('joinGameSubmitBtn');
    if (joinGameSubmitBtn) joinGameSubmitBtn.addEventListener('click', joinGame);
    
    // Create game screen
    const createGameSubmitBtn = document.getElementById('createGameSubmitBtn');
    if (createGameSubmitBtn) createGameSubmitBtn.addEventListener('click', createGame);
    
    const backToJoinBtn = document.getElementById('backToJoinBtn');
    if (backToJoinBtn) backToJoinBtn.addEventListener('click', () => showScreen('joinGame'));
    
    // Lobby screen
    const startGameBtn = document.getElementById('startGameBtn');
    if (startGameBtn) startGameBtn.addEventListener('click', startGame);
    
    const leaveGameBtn = document.getElementById('leaveGameBtn');
    if (leaveGameBtn) leaveGameBtn.addEventListener('click', leaveGame);
    
    // Host game management
    const refreshQuestionsBtn = document.getElementById('refreshQuestionsBtn');
    if (refreshQuestionsBtn) refreshQuestionsBtn.addEventListener('click', refreshQuestions);
    
    const testGameBtn = document.getElementById('testGameBtn');
    if (testGameBtn) testGameBtn.addEventListener('click', testGame);
    
    const testCategorizationBtn = document.getElementById('testCategorizationBtn');
    if (testCategorizationBtn) testCategorizationBtn.addEventListener('click', testCategorization);
    
    const uploadSampleQuestionsBtn = document.getElementById('uploadSampleQuestionsBtn');
    if (uploadSampleQuestionsBtn) uploadSampleQuestionsBtn.addEventListener('click', uploadSampleQuestions);
    
    const questionSet = document.getElementById('questionSet');
    if (questionSet) questionSet.addEventListener('change', updateGameSettings);
    
    const timerDuration = document.getElementById('timerDuration');
    if (timerDuration) timerDuration.addEventListener('change', updateGameSettings);
    
    const maxPlayers = document.getElementById('maxPlayers');
    if (maxPlayers) maxPlayers.addEventListener('change', updateGameSettings);
    
    const roundsPerGame = document.getElementById('roundsPerGame');
    if (roundsPerGame) roundsPerGame.addEventListener('change', updateGameSettings);
    
    // Enhanced host controls
    const pauseGameBtn = document.getElementById('pauseGameBtn');
    if (pauseGameBtn) pauseGameBtn.addEventListener('click', pauseGame);
    
    const resumeGameBtn = document.getElementById('resumeGameBtn');
    if (resumeGameBtn) resumeGameBtn.addEventListener('click', resumeGame);
    
    const copyGameLinkBtn = document.getElementById('copyGameLinkBtn');
    if (copyGameLinkBtn) copyGameLinkBtn.addEventListener('click', copyGameLink);
    
    const showQRCodeBtn = document.getElementById('showQRCodeBtn');
    if (showQRCodeBtn) showQRCodeBtn.addEventListener('click', showQRCode);
    
    const exportResultsBtn = document.getElementById('exportResultsBtn');
    if (exportResultsBtn) exportResultsBtn.addEventListener('click', exportResults);
    
    // Question file upload
    const questionFile = document.getElementById('questionFile');
    if (questionFile) questionFile.addEventListener('change', handleFileSelect);
    
    const uploadQuestionsBtn = document.getElementById('uploadQuestionsBtn');
    if (uploadQuestionsBtn) uploadQuestionsBtn.addEventListener('click', uploadQuestions);
    
    // Player management
    const kickPlayerBtn = document.getElementById('kickPlayerBtn');
    if (kickPlayerBtn) kickPlayerBtn.addEventListener('click', kickSelectedPlayer);
    
    const kickPlayerModalBtn = document.getElementById('kickPlayerModalBtn');
    if (kickPlayerModalBtn) kickPlayerModalBtn.addEventListener('click', kickPlayerFromModal);
    
    const mutePlayerBtn = document.getElementById('mutePlayerBtn');
    if (mutePlayerBtn) mutePlayerBtn.addEventListener('click', mutePlayer);
    
    // Modal controls
    const closeBtn = document.querySelector('.close');
    if (closeBtn) closeBtn.addEventListener('click', closePlayerModal);
    window.addEventListener('click', (event) => {
        const modal = document.getElementById('playerModal');
        if (event.target === modal) {
            closePlayerModal();
        }
    });
    
    // Game screen
    const submitAnswerBtn = document.getElementById('submitAnswerBtn');
    if (submitAnswerBtn) submitAnswerBtn.addEventListener('click', submitAnswer);
    const askHostBtn = document.getElementById('askHostBtn');
    // Use answerStatus as the multi-purpose input/display if contenteditable
    let multiBox = document.getElementById('answerStatus');
    const isMultiBoxEditable = !!(multiBox && multiBox.getAttribute && multiBox.getAttribute('contenteditable') === 'true');
    const askHostInput = isMultiBoxEditable ? multiBox : document.getElementById('askHostInput');
    if (askHostBtn) {
        console.log('💬 [player] Send to Host button found; attaching handler');
        const getText = () => {
            if (!askHostInput) return '';
            if (isMultiBoxEditable) return (askHostInput.innerText || '').trim();
            return (askHostInput.value || '').trim();
        };
        const setText = (val) => {
            if (!askHostInput) return;
            if (isMultiBoxEditable) askHostInput.innerText = val;
            else askHostInput.value = val;
        };
        const appendDmHistory = (who, text, suffix) => {
            // Disabled chat history to prevent screen overflow
            // try {
            //     const box = document.getElementById('dmHistory');
            //     if (!box) return;
            //     const line = document.createElement('div');
            //     line.textContent = `${who}: ${text}${suffix || ''}`;
            //     box.appendChild(line);
            //     while (box.children.length > 3) box.removeChild(box.firstChild);
            // } catch (_) {}
        };
        const setPlaceholderIfEmpty = () => {
            if (!askHostInput) return;
            if (isMultiBoxEditable && !(askHostInput.innerText || '').trim()) {
                askHostInput.setAttribute('data-empty', 'true');
            } else if (isMultiBoxEditable) {
                askHostInput.removeAttribute('data-empty');
            }
        };
        const sendMessage = () => {
            const q = getText();
            if (!q) return;
            console.log('💬 [player] Send-to-host clicked, text:', q);
            try {
                window.lastAskedQuestion = q;
                sessionStorage.setItem('lastAskedQuestion', q);
            } catch (_) {}
            try {
                socket.once('playerQuestionAck', (ack) => {
                    console.log('💬 [player] playerQuestionAck (once):', ack);
                    const statusEl = document.getElementById('answerStatus');
                    if (statusEl) {
                        statusEl.textContent = ack && ack.ok ? `💬 You: ${q} ✓` : `⚠️ Not delivered: ${q} (${(ack && (ack.reason||ack.message))||'unknown'})`;
                    }
                    appendDmHistory('You', q, ack && ack.ok ? ' ✓' : ' (not delivered)');
                });
            } catch (_) {}
            try {
                const payload = { question: q };
                try {
                    let resolvedGameCode = sessionStorage.getItem('gameCode') || null;
                    let resolvedPlayerName = sessionStorage.getItem('playerName') || null;
                    const gcInput = document.getElementById('gameCode');
                    if (!resolvedGameCode && gcInput && typeof gcInput.value === 'string' && gcInput.value.trim()) resolvedGameCode = gcInput.value.trim();
                    const pnInput = document.getElementById('playerName');
                    if (!resolvedPlayerName && pnInput && typeof pnInput.value === 'string' && pnInput.value.trim()) resolvedPlayerName = pnInput.value.trim();
                    if (!resolvedGameCode && typeof window.gameCode === 'string') resolvedGameCode = window.gameCode.trim();
                    if (!resolvedPlayerName && typeof window.playerName === 'string') resolvedPlayerName = window.playerName.trim();
                    if (resolvedGameCode) payload.gameCode = resolvedGameCode;
                    if (resolvedPlayerName) payload.playerName = resolvedPlayerName;
                } catch (_) {}
                console.log('💬 [player] playerQuestion payload:', payload);
                socket.emit('playerQuestion', payload);
            } catch (e) {
                console.warn('💬 [player] Failed to emit playerQuestion', e);
            }
            const statusEl = document.getElementById('answerStatus');
            if (statusEl) {
                if (isMultiBoxEditable) statusEl.innerText = `💬 You: ${q} …`;
                else statusEl.textContent = `💬 You: ${q} …`;
            }
            setText('');
            setPlaceholderIfEmpty();
        };
        askHostBtn.addEventListener('click', sendMessage);
        if (askHostInput) askHostInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendMessage(); }});
        
        // Clear messaging box when clicked
        if (askHostInput) {
            askHostInput.addEventListener('click', () => {
                askHostInput.innerText = '';
                setPlaceholderIfEmpty();
            });
        }
        
        // Ensure comm row visible for players
        const commRow = document.getElementById('playerCommRow');
        if (commRow && !isHost) commRow.style.display = 'flex';
        // Placeholder styling for contenteditable
        if (isMultiBoxEditable) {
            multiBox.addEventListener('input', setPlaceholderIfEmpty);
            setPlaceholderIfEmpty();
        }
    }

    // Delivery confirmation / failure
    if (typeof socket !== 'undefined') {
        try {
            socket.on('playerQuestionAck', (ack) => {
                console.log('💬 [player] playerQuestionAck received:', ack);
                const statusEl = document.getElementById('answerStatus');
                if (!statusEl) return;
                if (ack && ack.ok) {
                    statusEl.textContent = `${statusEl.textContent || '💬 Sent to host'} ✓`;
                } else {
                    const reason = (ack && ack.reason) || (ack && ack.message) || 'unknown';
                    statusEl.textContent = `⚠️ Not delivered (${reason}).`;
                }
            });
            socket.on('hostAnswer', (data) => {
                console.log('💬 [player] hostAnswer received:', data);
                try {
                    const msg = data && data.answer ? data.answer : '';
                    if (!msg) return;
                    
                    // Show toast notification for host response
                    showToast(`💬 Host responded: ${msg}`, 'info');
                    
                    const statusEl = document.getElementById('answerStatus');
                    if (statusEl && statusEl.getAttribute('contenteditable') === 'true') {
                        statusEl.innerText = `💬 Host: ${msg}`;
                    } else if (statusEl) {
                        statusEl.textContent = `💬 Host: ${msg}`;
                    }
                    appendDmHistory('Host', msg);
                } catch (_) {}
            });
        } catch (_) {}
    }
    
    const answerInput = document.getElementById('answerInput');
    if (answerInput) answerInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') submitAnswer();
    });
    
    // Add Enter key support for join game form
    const gameCodeInput = document.getElementById('gameCode');
    if (gameCodeInput) gameCodeInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            if (e.target.value.length === 4) {
                const playerNameInput = document.getElementById('playerName');
                if (playerNameInput) {
                    playerNameInput.focus();
                } else {
                    joinGame();
                }
            }
        }
    });
    
    const playerNameInput = document.getElementById('playerName');
    if (playerNameInput) playerNameInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') joinGame();
    });
    
    // Host controls
    const showAnswersBtn = document.getElementById('showAnswersBtn');
    if (showAnswersBtn) showAnswersBtn.addEventListener('click', showAllAnswers);
    
    const endQuestionBtn = document.getElementById('endQuestionBtn');
    if (endQuestionBtn) endQuestionBtn.addEventListener('click', endQuestion);
    
    const forceNextBtn = document.getElementById('forceNextBtn');
    if (forceNextBtn) forceNextBtn.addEventListener('click', forceNextQuestion);
    
    // Scoring screen
    // View scores button removed
    
    const nextQuestionBtn = document.getElementById('nextQuestionBtn');
    if (nextQuestionBtn) nextQuestionBtn.addEventListener('click', nextQuestion);
    
    const endGameBtn = document.getElementById('endGameBtn');
    if (endGameBtn) endGameBtn.addEventListener('click', endGame);
    
    // Answer categorization
    const addBucketBtn = document.getElementById('addBucketBtn');
    if (addBucketBtn) addBucketBtn.addEventListener('click', addCustomBucket);
    
    const mergeBucketsBtn = document.getElementById('mergeBucketsBtn');
    if (mergeBucketsBtn) mergeBucketsBtn.addEventListener('click', mergeSelectedBuckets);
    
    const previewScoringBtn = document.getElementById('previewScoringBtn');
    if (previewScoringBtn) previewScoringBtn.addEventListener('click', previewScoring);
    
    const applyCategorizationBtn = document.getElementById('applyCategorizationBtn');
    if (applyCategorizationBtn) applyCategorizationBtn.addEventListener('click', applyCategorization);
    
    const autoCategorizeBtn = document.getElementById('autoCategorizeBtn');
    if (autoCategorizeBtn) autoCategorizeBtn.addEventListener('click', autoCategorizeAnswers);
    
    // Grading modal
    const openGradingModalBtn = document.getElementById('openGradingModalBtn');
    if (openGradingModalBtn) openGradingModalBtn.addEventListener('click', openGradingModal);
    
    const closeGradingModalBtn = document.getElementById('closeGradingModal');
    if (closeGradingModalBtn) closeGradingModalBtn.addEventListener('click', closeGradingModal);
    
    const gradingQuestionSelect = document.getElementById('gradingQuestionSelect');
    if (gradingQuestionSelect) gradingQuestionSelect.addEventListener('change', onGradingQuestionSelect);
    
    const toggleFullscreenBtn = document.getElementById('toggleFullscreenBtn');
    if (toggleFullscreenBtn) toggleFullscreenBtn.addEventListener('click', toggleGradingModalFullscreen);
    
    // Close grading modal when clicking outside
    window.addEventListener('click', (event) => {
        const modal = document.getElementById('gradingModal');
        if (event.target === modal) {
            closeGradingModal();
        }
    });
    
    // Grading modal categorization
    const gradingAddBucketBtn = document.getElementById('gradingAddBucketBtn');
    if (gradingAddBucketBtn) gradingAddBucketBtn.addEventListener('click', () => addCustomBucket('grading'));
    
    const gradingMergeBucketsBtn = document.getElementById('gradingMergeBucketsBtn');
    if (gradingMergeBucketsBtn) gradingMergeBucketsBtn.addEventListener('click', () => mergeSelectedBuckets('grading'));
    
    const gradingPreviewScoringBtn = document.getElementById('gradingPreviewScoringBtn');
    if (gradingPreviewScoringBtn) gradingPreviewScoringBtn.addEventListener('click', () => previewScoring('grading'));
    
    const gradingApplyCategorizationBtn = document.getElementById('gradingApplyCategorizationBtn');
    if (gradingApplyCategorizationBtn) gradingApplyCategorizationBtn.addEventListener('click', () => applyCategorization('grading'));
    
    const gradingAutoCategorizeBtn = document.getElementById('gradingAutoCategorizeBtn');
    if (gradingAutoCategorizeBtn) gradingAutoCategorizeBtn.addEventListener('click', () => autoCategorizeAnswers('grading'));
    
    // Scores modal
    // Ensure the FAB opens the modal even if results render binding hasn't run yet
    const scoresFabInit = document.getElementById('scoresFab');
    if (scoresFabInit) {
        try { scoresFabInit.removeEventListener('click', showScoresModal); } catch(_) {}
        scoresFabInit.addEventListener('click', showScoresModal);
    }
    const closeScoresModalBtn = document.getElementById('closeScoresModal');
    if (closeScoresModalBtn) closeScoresModalBtn.addEventListener('click', closeScoresModal);
    window.addEventListener('click', (event) => {
        const modal = document.getElementById('scoresModal');
        if (event.target === modal) {
            closeScoresModal();
        }
    });
    
    // Game over screen
    const playAgainBtn = document.getElementById('playAgainBtn');
    if (playAgainBtn) playAgainBtn.addEventListener('click', playAgain);
    
    const newGameBtn = document.getElementById('newGameBtn');
    if (newGameBtn) newGameBtn.addEventListener('click', () => showScreen('joinGame'));
    
    // Virtual test button
    const virtualTestBtn = document.getElementById('virtualTestBtn');
    if (virtualTestBtn) {
        virtualTestBtn.addEventListener('click', () => {
            console.log('🎭 Virtual test button clicked');
            startFullGameSimulation();
        });
    }
}

// Screen management
function showScreen(screenName) {
    // Check if screens object exists (only on main page)
    if (typeof screens === 'undefined' || !screens) {
        console.log('Screens object not available (likely on grading page)');
        return;
    }
    
    // Hide all screens
    Object.values(screens).forEach(screen => {
        if (screen && screen.classList) {
            screen.classList.remove('active');
        }
    });
    
    // Show the requested screen
    if (screens[screenName] && screens[screenName].classList) {
        screens[screenName].classList.add('active');
    }
}

// Create a new game
async function createGame() {
    const IS_HOST_ROUTE = window.location.pathname === '/host';
    if (!IS_HOST_ROUTE) {
        // Enforce: hosting happens on /host only
        try { showError('Hosting is available on the Host Console. Redirecting…'); } catch(_) {}
        setTimeout(() => { window.location.href = '/host'; }, 250);
        return;
    }
    const hostName = document.getElementById('hostName').value.trim();
    if (!hostName) {
        showError('Please enter your name');
        return;
    }
    
    try {
        const response = await fetch('/api/create-game', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ hostName })
        });
        
        const result = await response.json();
        
        if (result.status === 'success') {
            currentPlayerName = hostName;
            isHost = true;
            gameState.gameCode = result.gameCode;
            gameState.hostName = hostName;
            
            // Show the game code
            document.getElementById('gameCodeText').textContent = result.gameCode;
            document.getElementById('gameCodeDisplay').style.display = 'block';
            
            showScreen('lobby');
            updateLobbyDisplay();
            
            console.log(`🎮 Created game with code: ${result.gameCode}`);
            // IMPORTANT: bind this socket as the host for this game
            try { socket.emit('createGame', { gameCode: result.gameCode }); } catch(_) {}
        } else {
            showError(result.message);
        }
    } catch (error) {
        console.error('Failed to create game:', error);
        showError('Failed to create game. Please try again.');
    }
}

// Join an existing game
async function joinGame() {
    const gameCode = resolveGameCodeValue();
    const playerName = document.getElementById('playerName').value.trim();
    
    console.log('🎮 Script.js: joinGame called with gameCode:', gameCode, 'playerName:', playerName);
    console.log('🎮 Script.js: Socket connected state:', socket.connected);
    console.log('🎮 Script.js: Socket ID:', socket.id);
    
    if (!gameCode || !playerName) {
        if (!gameCode) {
            showError('Missing or invalid game code in link.');
        } else {
            showError('Please enter your name');
        }
        return;
    }
    
    try {
        const response = await fetch('/api/join-game', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ gameCode, playerName })
        });
        
        const result = await response.json();
        
        if (result.status === 'success') {
            console.log('🎮 Script.js: API call successful, result:', result);
            currentPlayerName = playerName;
            isHost = false;
            // Prefer API-provided code; fallback to entered value
            const resolvedCode = result.gameCode || gameCode;
            gameState.gameCode = resolvedCode;
            gameState.playerName = playerName;
            // Persist identity for auto-resume
            savePlayerIdentity(resolvedCode, playerName);
            
            console.log('🎮 Script.js: API call successful, emitting joinGame socket event');
            console.log('🎮 Script.js: Socket connected before emit:', socket.connected);
            console.log('🎮 Script.js: Socket object:', socket);
            
            try {
                // Wait a moment to ensure socket is ready
                if (!socket.connected) {
                    console.log('🎮 Script.js: Socket not connected, waiting...');
                    await new Promise(resolve => {
                        socket.on('connect', () => {
                            console.log('🎮 Script.js: Socket connected, now emitting joinGame');
                            resolve();
                        });
                        // If already connected, resolve immediately
                        if (socket.connected) {
                            resolve();
                        }
                    });
                }
                
                // Join the game via socket (include stable playerId)
                console.log('🎮 Script.js: About to emit joinGame event with data:', { 
                    gameCode: resolvedCode, 
                    playerName: playerName,
                    playerId: getOrCreatePlayerId()
                });
                
                socket.emit('joinGame', { 
                    gameCode: resolvedCode, 
                    playerName: playerName,
                    playerId: getOrCreatePlayerId()
                });
                
                console.log(`🎮 Script.js: joinGame event emitted for game: ${result.gameCode}`);
                
                // Add a timeout to check if we receive a response
                setTimeout(() => {
                    console.log('🎮 Script.js: 5 seconds after joinGame emit - checking if we received gameJoined response');
                    if (!gameState.gameCode) {
                        console.log('🎮 Script.js: WARNING - No gameJoined response received after 5 seconds');
                    }
                }, 5000);
                
                console.log(`🎮 Script.js: Joining game with code: ${resolvedCode}`);
            } catch (socketError) {
                console.error('🎮 Script.js: Error during socket emit:', socketError);
                throw socketError;
            }
        } else {
            showError(result.message);
        }
    } catch (error) {
        console.error('❌ Error joining game:', error);
        showError('Failed to join game. Please try again.');
    }
}

// Start the game (host only)
function startGame() {
    if (!isHost) return;
    socket.emit('startGame', { gameCode: gameState.gameCode });
    // If virtual test mode is enabled (via Virtual Test button), ask server to add CPU players
    if (typeof isVirtualTestingMode !== 'undefined' && isVirtualTestingMode) {
        // Default to 50 CPU players joining over time
        startVirtualPlayerSimulation(50);
    }
}

// Leave the current game
function leaveGame() {
    socket.disconnect();
    socket.connect();
    resetGameState();
    stopGameDurationTimer();
    
    // Remove test mode indicator if it exists
    const testModeIndicator = document.getElementById('testModeIndicator');
    if (testModeIndicator) {
        testModeIndicator.remove();
    }
    
    // Only show join game screen if screens object exists
    if (typeof screens !== 'undefined' && screens.joinGame) {
        showScreen('joinGame');
    }
}

// Submit an answer
function submitAnswer() {
    const answerInput = document.getElementById('answerInput');
    if (!answerInput) {
        console.log('Answer input not found (likely on grading page)');
        return;
    }
    
    const answer = answerInput.value.trim();
    
    if (!answer) {
        showError('Please enter an answer');
        return;
    }
    
    // Store the submitted answer for later display
    window.lastSubmittedAnswer = answer;
    localStorage.setItem('lastSubmittedAnswer', answer);
    console.log('💾 Stored submitted answer:', answer);
    
    socket.emit('submitAnswer', { gameCode: gameState.gameCode, answer });
    
    // Populate the answer textbox with the submitted answer instead of clearing it
    answerInput.value = answer;
    
    const submitAnswerBtn = document.getElementById('submitAnswerBtn');
    if (submitAnswerBtn) {
        submitAnswerBtn.disabled = true;
    }
    answerInput.disabled = true;
}

// Move to next question (host only)
function nextQuestion() {
    if (!isHost) return;
    socket.emit('nextQuestion', { gameCode: gameState.gameCode });
}

// End the game (host only)
function endGame() {
    if (!isHost) return;
    socket.emit('endGame', { gameCode: gameState.gameCode });
}

function endQuestion() {
    if (!gameState.gameCode) {
        showError('No active game');
        return;
    }
    
    if (gameState.gameState !== 'playing') {
        showError('Question is not currently active');
        return;
    }
    
    console.log('🎯 Host ending current question');
    socket.emit('endQuestion', { gameCode: gameState.gameCode });
}

// Host control functions
function showAllAnswers() {
    if (!isHost) return;
    // This will trigger the scoring screen even if not all players have answered
    socket.emit('forceNextQuestion', { gameCode: gameState.gameCode });
}

function forceNextQuestion() {
    if (!isHost) return;
    socket.emit('nextQuestion', { gameCode: gameState.gameCode });
}

// Host game management functions
async function refreshQuestions() {
    if (!isHost) return;
    
    console.log('🔄 Refresh questions button clicked');
    
    try {
        // Load questions from database without starting a game
        const response = await fetch('/api/load-questions');
        const data = await response.json();
        
        if (data.status === 'success' && data.questions.length > 0) {
            // Store questions for grading interface
            window.databaseQuestions = data.questions;
            console.log('🗄️ Loaded', data.questions.length, 'questions from database for grading interface');
            showSuccess(`Loaded ${data.questions.length} questions from database!`);
        } else {
            showError('No questions found in database. Please upload sample questions first.');
        }
    } catch (error) {
        console.error('❌ Error loading questions:', error);
        showError('Failed to load questions from database');
    }
}

async function testGame() {
    if (!isHost) return;
    
    console.log('🧪 Test game button clicked');
    
    try {
        // Check if we have questions in the database
        const questionsResponse = await fetch('/api/load-test-questions');
        const questionsData = await questionsResponse.json();
        
        if (questionsData.status !== 'success' || questionsData.questions.length === 0) {
            showError('No questions found in database. Please upload sample questions first.');
            return;
        }
        
        // Show confirmation dialog
        if (!confirm(`Start test game? This will simulate a game with ${questionsData.questions.length} questions from the database to preview the experience.`)) {
            return;
        }
        
        console.log('🧪 Confirmed, emitting testGame event');
        
        // Start test game
        socket.emit('testGame', { gameCode: gameState.gameCode });
        showSuccess('Starting test game with database questions...');
        
        console.log('🧪 testGame event emitted');
        
    } catch (error) {
        console.error('❌ Error checking database for test game:', error);
        showError('Failed to check database. Please ensure questions are uploaded.');
    }
}

async function testCategorization() {
    if (!isHost) return;
    
    console.log('📝 Test categorization button clicked');
    
    try {
        // Load questions from database
        const response = await fetch('/api/test-db');
        const dbStatus = await response.json();
        
        if (dbStatus.status === 'success') {
            console.log('✅ Database connection successful, loading questions...');
            
            // Load questions from the database
            const questionsResponse = await fetch('/api/load-test-questions');
            const questionsData = await questionsResponse.json();
            
            if (questionsData.status === 'success' && questionsData.questions.length > 0) {
                gameState.questions = questionsData.questions;
                currentQuestionIndex = 0;
                
                console.log('✅ Loaded', questionsData.questions.length, 'questions from database');
                
                // Use real player data instead of test data
                const firstQuestion = questionsData.questions[0];
                gameState.currentAnswerGroups = [];
                
                // Switch to scoring screen and show categorization
                showScreen('scoring');
                initializeAnswerCategorization();
                
                showSuccess(`Test categorization loaded with "${firstQuestion.prompt}"`);
            } else {
                throw new Error('No questions found in database. Please upload sample questions first.');
            }
        } else {
            throw new Error('Database connection failed. Please check your Supabase configuration.');
        }
    } catch (error) {
        console.error('❌ Error loading test data:', error);
        showError(`Failed to load test data: ${error.message}`);
    }
}

// Test answer generation removed - only real player data will be used

// Fuzzy matching function for automatic bucket categorization
function findBestMatchingBucket(answer, buckets) {
    // Normalize: lowercase, remove ALL punctuation, normalize spacing
    const normalizedAnswer = answer.toLowerCase()
        .replace(/[.,!?;:'"()\[\]{}@#$%^&*+=|\\/<>~`]/g, '') // Remove all punctuation
        .replace(/\s+/g, '') // Remove ALL spaces
        .trim();
    
    let bestMatch = null;
    let bestScore = 0;
    
    for (let i = 0; i < buckets.length; i++) {
        const bucket = buckets[i];
        const normalizedCorrect = bucket.correctAnswer.toLowerCase()
            .replace(/[.,!?;:'"()\[\]{}@#$%^&*+=|\\/<>~`]/g, '') // Remove all punctuation
            .replace(/\s+/g, '') // Remove ALL spaces
            .trim();
        
        // Exact match after normalization (highest priority)
        if (normalizedAnswer === normalizedCorrect) {
            return bucket;
        }
        
        // Calculate similarity score
        const score = calculateSimilarity(normalizedAnswer, normalizedCorrect);
        
        // Debug logging for specific cases
        if (normalizedAnswer === 'rats' || normalizedCorrect === 'ratt') {
            console.log(`🔍 Debug: "${normalizedAnswer}" vs "${normalizedCorrect}" = ${score}`);
        }
        
        if (score > bestScore && score >= 0.6) { // 60% similarity threshold (lowered for better matching)
            bestScore = score;
            bestMatch = bucket;
        }
    }
    
    return bestMatch;
}

// Calculate similarity between two strings
function calculateSimilarity(str1, str2) {
    // Handle exact matches first (strings are already normalized)
    if (str1 === str2) return 1.0;
    
    // Debug logging for specific cases
    if (str1 === 'rats' || str2 === 'ratt' || str1 === 'ratt' || str2 === 'rats') {
        console.log(`🔍 calculateSimilarity: "${str1}" vs "${str2}"`);
    }
    
    // Handle common variations
    const variations = [
        // Leetspeak variations
        { from: /[0-9]/g, to: { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '9': 'g' } },
        // Common typos
        { from: /ph/g, to: 'f' },
        { from: /ck/g, to: 'k' },
        { from: /th/g, to: 't' },
        { from: /qu/g, to: 'kw' }
    ];
    
    let normalized1 = str1;
    let normalized2 = str2;
    
    // Apply normalizations
    variations.forEach(variation => {
        if (typeof variation.to === 'object') {
            // Handle leetspeak
            Object.entries(variation.to).forEach(([num, letter]) => {
                normalized1 = normalized1.replace(new RegExp(num, 'g'), letter);
                normalized2 = normalized2.replace(new RegExp(num, 'g'), letter);
            });
        } else {
            normalized1 = normalized1.replace(variation.from, variation.to);
            normalized2 = normalized2.replace(variation.from, variation.to);
        }
    });
    
    // Check normalized versions
    if (normalized1 === normalized2) return 0.95;
    
    // Check if one contains the other (partial match)
    if (normalized1.includes(normalized2) || normalized2.includes(normalized1)) {
        const shorter = normalized1.length < normalized2.length ? normalized1 : normalized2;
        const longer = normalized1.length < normalized2.length ? normalized2 : normalized1;
        return shorter.length / longer.length * 0.9;
    }
    
    // Calculate Levenshtein distance for final similarity
    const distance = levenshteinDistance(normalized1, normalized2);
    const maxLength = Math.max(normalized1.length, normalized2.length);
    const similarity = Math.max(0, 1 - (distance / maxLength));
    
    // Debug logging for specific cases
    if (normalized1 === 'rats' || normalized2 === 'ratt' || normalized1 === 'ratt' || normalized2 === 'rats') {
        console.log(`🔍 Levenshtein: "${normalized1}" vs "${normalized2}" = distance ${distance}, maxLength ${maxLength}, similarity ${similarity}`);
    }
    
    return similarity;
}

// Levenshtein distance calculation
function levenshteinDistance(str1, str2) {
    const matrix = [];
    
    for (let i = 0; i <= str2.length; i++) {
        matrix[i] = [i];
    }
    
    for (let j = 0; j <= str1.length; j++) {
        matrix[0][j] = j;
    }
    
    for (let i = 1; i <= str2.length; i++) {
        for (let j = 1; j <= str1.length; j++) {
            if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1, // substitution
                    matrix[i][j - 1] + 1,     // insertion
                    matrix[i - 1][j] + 1      // deletion
                );
            }
        }
    }
    
    return matrix[str2.length][str1.length];
}

// Toggle bucket collapse/expand functionality
function toggleBucketCollapse(bucketElement) {
    if (!bucketElement) return;
    
    const isCollapsed = bucketElement.classList.contains('collapsed');
    const toggleElement = bucketElement.querySelector('.bucket-toggle');
    const contentElement = bucketElement.querySelector('.bucket-content');
    
    if (isCollapsed) {
        // Expand
        bucketElement.classList.remove('collapsed');
        bucketElement.classList.add('expanded');
        if (toggleElement) toggleElement.textContent = '▲';
        if (contentElement) contentElement.style.display = 'block';
    } else {
        // Collapse
        bucketElement.classList.remove('expanded');
        bucketElement.classList.add('collapsed');
        if (toggleElement) toggleElement.textContent = '▼';
        if (contentElement) contentElement.style.display = 'none';
    }
}

// Update bucket count display
function updateBucketCount(bucketId, count) {
    const bucketElement = document.querySelector(`[data-bucket="${bucketId}"]`);
    if (bucketElement) {
        const countElement = bucketElement.querySelector('.bucket-count');
        if (countElement) {
            countElement.textContent = `(${count})`;
        }
    }
}

// Update all bucket counts
function updateAllBucketCounts() {
    const categorization = window.gradingCategorization;
    if (!categorization) return;
    
    // Update correct answer buckets
    categorization.correctAnswerBuckets.forEach(bucket => {
        const count = bucket.answers.length;
        updateBucketCount(bucket.id, count);
    });
    
    // Update wrong answers bucket
    const wrongAnswersContainer = document.getElementById('gradingWrongAnswers');
    const wrongCount = wrongAnswersContainer ? wrongAnswersContainer.children.length : 0;
    updateBucketCount('wrong', wrongCount);
    
    // Update uncategorized bucket
    const uncategorizedContainer = document.getElementById('gradingUncategorizedAnswers');
    const uncategorizedCount = uncategorizedContainer ? uncategorizedContainer.children.length : 0;
    updateBucketCount('uncategorized', uncategorizedCount);
}

// Expand all buckets
function expandAllBuckets() {
    const buckets = document.querySelectorAll('#gradingAnswerCategorization .answer-bucket');
    buckets.forEach(bucket => {
        if (bucket.classList.contains('collapsed')) {
            toggleBucketCollapse(bucket);
        }
    });
}

// Real-time grading collaboration functions
function joinGradingRoom() {
    // Use grading socket if available, otherwise fall back to main socket
    const socketToUse = window.gradingSocket || socket;
    if (!socketToUse) return;
    
    const currentQuestion = getCurrentGradingQuestion();
    if (currentQuestion && window.currentGameCode) {
        socketToUse.emit('joinGradingSession', {
            gameCode: window.currentGameCode,
            questionIndex: currentQuestion.index,
            graderId: generateGraderId()
        });
        console.log('🎯 Joined grading session for real-time collaboration');
        console.log('🔧 Debug - Game Code:', window.currentGameCode);
        console.log('🔧 Debug - Question Index:', currentQuestion.index);
        console.log('🔧 Debug - Grader ID:', generateGraderId());
    }
}

function leaveGradingRoom() {
    // Use grading socket if available, otherwise fall back to main socket
    const socketToUse = window.gradingSocket || socket;
    if (!socketToUse) return;
    
    if (window.currentGameCode) {
        socketToUse.emit('leaveGradingSession', {
            gameCode: window.currentGameCode,
            graderId: getGraderId()
        });
        console.log('🎯 Left grading session');
    }
}

function getCurrentGradingQuestion() {
    const questionSelector = document.getElementById('gradingQuestionSelector');
    if (!questionSelector || questionSelector.value === '') return null;
    
    const questionIndex = parseInt(questionSelector.value);
    const questions = window.gradingQuestions || [];
    return questions[questionIndex] ? { ...questions[questionIndex], index: questionIndex } : null;
}

function generateGraderId() {
    if (!window.graderId) {
        window.graderId = 'grader_' + Math.random().toString(36).substr(2, 9);
    }
    return window.graderId;
}

function getGraderId() {
    return window.graderId || generateGraderId();
}

// Real-time answer categorization
function categorizeAnswerRealTime(answerText, targetBucket, graderId = null) {
    // Use grading socket if available, otherwise fall back to main socket
    const socketToUse = window.gradingSocket || socket;
    if (!socketToUse) return;
    
    const currentQuestion = getCurrentGradingQuestion();
    if (!currentQuestion || !window.currentGameCode) return;
    
    socketToUse.emit('categorizeAnswer', {
        gameCode: window.currentGameCode,
        questionIndex: currentQuestion.index,
        answerText: answerText,
        targetBucket: targetBucket,
        graderId: graderId || getGraderId(),
        timestamp: Date.now()
    });
    
    console.log(`🎯 Real-time categorization: "${answerText}" → ${targetBucket}`);
}

// Handle real-time updates from other graders
function handleRealTimeGradingUpdate(data) {
    const { answerText, targetBucket, graderId, timestamp } = data;
    
    // Don't process our own updates
    if (graderId === getGraderId()) return;
    
    console.log(`👥 Other grader moved "${answerText}" to ${targetBucket}`);
    
    // Update the UI to reflect the change
    updateGradingUIFromRemoteChange(answerText, targetBucket);
}

function updateGradingUIFromRemoteChange(answerText, targetBucket) {
    // Find the answer item
    const answerItem = document.querySelector(`[data-answer="${answerText}"]`);
    if (!answerItem) return;
    
    // Find the target bucket container
    let targetContainer;
    if (targetBucket === 'wrong') {
        targetContainer = document.getElementById('gradingWrongAnswers');
    } else if (targetBucket === 'uncategorized') {
        targetContainer = document.getElementById('gradingUncategorizedAnswers');
    } else {
        targetContainer = document.querySelector(`[data-bucket="${targetBucket}"] .answer-items`);
    }
    
    if (targetContainer) {
        // Move the answer item with visual feedback
        answerItem.style.background = 'rgba(76, 175, 80, 0.3)';
        setTimeout(() => {
            answerItem.style.background = '';
        }, 1000);
        
        targetContainer.appendChild(answerItem);
        updateAllBucketCounts();
    }
}

// Handle new answers coming in real-time
function handleNewAnswerForGrading(data) {
    const { answerText, count, questionIndex } = data;
    
    // Only process if we're grading this question
    const currentQuestion = getCurrentGradingQuestion();
    if (!currentQuestion || currentQuestion.index !== questionIndex) return;
    
    console.log(`🆕 New answer received: "${answerText}" (${count} responses)`);
    
    // Add to uncategorized answers
    addNewAnswerToGrading(answerText, count);
}

function addNewAnswerToGrading(answerText, count) {
    const uncategorizedContainer = document.getElementById('gradingUncategorizedAnswers');
    if (!uncategorizedContainer) return;
    
    // Calculate confidence for the new answer
    const categorization = window.gradingCategorization;
    if (!categorization) return;
    
    let bestConfidence = 0;
    categorization.correctAnswerBuckets.forEach(bucket => {
        const confidence = calculateAnswerConfidence(answerText, bucket.id);
        if (confidence > bestConfidence) {
            bestConfidence = confidence;
        }
    });
    
    const confidenceClass = getConfidenceColorClass(bestConfidence);
    
    // Create new answer item
    const answerItem = document.createElement('div');
    answerItem.className = `answer-item ${confidenceClass}`;
    answerItem.draggable = true;
    answerItem.dataset.answer = answerText;
    answerItem.oncontextmenu = (e) => handleGradingRightClick(e);
    
    answerItem.innerHTML = `
        <span class="answer-text">"${answerText}"</span>
        <span class="answer-count">(${count} responses)</span>
        <span class="confidence-indicator">${bestConfidence}%</span>
    `;
    
    // Add drag event listeners
    answerItem.addEventListener('dragstart', handleGradingDragStart);
    answerItem.addEventListener('dragend', handleGradingDragEnd);
    
    // Insert at the top (highest confidence first)
    uncategorizedContainer.insertBefore(answerItem, uncategorizedContainer.firstChild);
    
    // Update counts
    updateAllBucketCounts();
    
    // Visual feedback for new answer
    answerItem.style.background = 'rgba(76, 175, 80, 0.2)';
    setTimeout(() => {
        answerItem.style.background = '';
    }, 2000);
}

// Handle other graders joining/leaving
function handleGraderJoined(data) {
    const { graderId, graderCount } = data;
    console.log(`👥 Grader joined (${graderCount} total graders)`);
    showInfo(`Another grader joined the session (${graderCount} total)`);
    updateGraderCountDisplay(graderCount);
}

function handleGraderLeft(data) {
    const { graderId, graderCount } = data;
    console.log(`👥 Grader left (${graderCount} total graders)`);
    showInfo(`A grader left the session (${graderCount} remaining)`);
    updateGraderCountDisplay(graderCount);
}

function updateGraderCountDisplay(count) {
    const graderCountElement = document.querySelector('.grader-count');
    if (graderCountElement) {
        graderCountElement.textContent = `(${count} grader${count !== 1 ? 's' : ''})`;
    }
}

// Setup real-time grading listeners
function setupRealTimeGradingListeners() {
    if (!socket) return;
    
    socket.on('gradingUpdate', handleRealTimeGradingUpdate);
    socket.on('newAnswerSubmitted', handleNewAnswerForGrading);
    socket.on('graderJoined', handleGraderJoined);
    socket.on('graderLeft', handleGraderLeft);
    
    console.log('✅ Real-time grading listeners set up');
}

// Calculate confidence for an answer in a bucket
function calculateAnswerConfidence(answerText, bucketId) {
    const categorization = window.gradingCategorization;
    if (!categorization) return 0;
    
    if (bucketId === 'wrong') {
        // Wrong answers have 0% confidence (they're manually placed)
        return 0;
    }
    
    if (bucketId === 'uncategorized') {
        // Uncategorized answers have 0% confidence
        return 0;
    }
    
    // Find the correct answer bucket
    const bucket = categorization.correctAnswerBuckets.find(b => b.id === bucketId);
    if (!bucket) return 0;
    
    // Calculate similarity to the correct answer
    const confidence = calculateSimilarity(
        answerText.toLowerCase().replace(/[.,!?;:'"()\[\]{}@#$%^&*+=|\\/<>~`]/g, '').replace(/\s+/g, ''),
        bucket.correctAnswer.toLowerCase().replace(/[.,!?;:'"()\[\]{}@#$%^&*+=|\\/<>~`]/g, '').replace(/\s+/g, '')
    );
    
    return Math.round(confidence * 100);
}

// Get confidence color class
function getConfidenceColorClass(confidence) {
    if (confidence >= 90) return 'confidence-high';
    if (confidence >= 60) return 'confidence-medium';
    if (confidence > 0) return 'confidence-low';
    return 'confidence-none';
}

async function uploadSampleQuestions() {
    if (!isHost) return;
    
    console.log('📚 Upload sample questions button clicked');
    
    try {
        const response = await fetch('/api/upload-sample-questions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        const result = await response.json();
        
        if (result.status === 'success') {
            showSuccess(`✅ Successfully uploaded ${result.count} sample questions to database!`);
            console.log('✅ Sample questions uploaded successfully');
        } else {
            throw new Error(result.message || 'Failed to upload sample questions');
        }
    } catch (error) {
        console.error('❌ Error uploading sample questions:', error);
        showError(`Failed to upload sample questions: ${error.message}`);
    }
}

function updateGameSettings() {
    if (!isHost) return;
    
    const settings = {
        questionSet: document.getElementById('questionSet').value,
        timerDuration: parseInt(document.getElementById('timerDuration').value),
        maxPlayers: parseInt(document.getElementById('maxPlayers').value),
        roundsPerGame: parseInt(document.getElementById('roundsPerGame').value)
    };
    
    socket.emit('updateGameSettings', settings);
    showSuccess('Game settings updated!');
}

// Enhanced host functions
function pauseGame() {
    if (!isHost) return;
    socket.emit('pauseGame', { gameCode: gameState.gameCode });
    showSuccess('Game paused');
}

function resumeGame() {
    if (!isHost) return;
    socket.emit('resumeGame', { gameCode: gameState.gameCode });
    showSuccess('Game resumed');
}

function copyGameLink() {
    const gameUrl = getJoinUrl(gameState?.gameCode);
    navigator.clipboard.writeText(gameUrl).then(() => {
        showSuccess('Game link copied to clipboard!');
    }).catch(() => {
        showError('Failed to copy link');
    });
}

function showQRCode() {
    const gameUrl = getJoinUrl(gameState?.gameCode);
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(gameUrl)}`;
    
    // Create modal for QR code
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.innerHTML = `
        <div class="modal-content">
            <div class="modal-header">
                <h4>📱 QR Code for Game</h4>
                <span class="close" onclick="this.parentElement.parentElement.parentElement.remove()">&times;</span>
            </div>
            <div class="modal-body" style="text-align: center;">
                <img src="${qrUrl}" alt="QR Code" style="max-width: 200px; margin: 20px;">
                <p style="color: rgba(255,255,255,0.8); margin-top: 15px;">Scan this QR code to join the game</p>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    modal.style.display = 'block';
}

// Build a join URL that lands players directly on the join screen with game code prefilled
function getJoinUrl(code) {
    const base = window.location.origin;
    if (code && /^\d{4}$/.test(String(code))) {
        return `${base}/?game=${code}`;
    }
    return `${base}/`;
}

function exportResults() {
    if (!gameState || !gameState.players) {
        showError('No game data to export');
        return;
    }
    
    const results = {
        gameId: gameState.id || 'unknown',
        timestamp: new Date().toISOString(),
        players: gameState.players.map(player => ({
            name: player.name,
            score: gameState.scores[player.id] || 0
        })),
        totalQuestions: questions.length,
        gameDuration: document.getElementById('gameDuration').textContent
    };
    
    const dataStr = JSON.stringify(results, null, 2);
    const dataBlob = new Blob([dataStr], {type: 'application/json'});
    const url = URL.createObjectURL(dataBlob);
    
    const link = document.createElement('a');
    link.href = url;
    link.download = `megasheep-results-${Date.now()}.json`;
    link.click();
    
    URL.revokeObjectURL(url);
    showSuccess('Results exported!');
}

// Player management functions
let selectedPlayerId = null;

function kickSelectedPlayer() {
    if (!selectedPlayerId) {
        showError('Please select a player first');
        return;
    }
    
    if (confirm('Are you sure you want to kick this player?')) {
        socket.emit('kickPlayer', { gameCode: gameState.gameCode, playerId: selectedPlayerId });
        selectedPlayerId = null;
    }
}

function kickPlayerFromModal() {
    const playerName = document.getElementById('modalPlayerName').textContent;
    if (confirm(`Are you sure you want to kick ${playerName}?`)) {
        socket.emit('kickPlayer', { gameCode: gameState.gameCode, playerId: selectedPlayerId });
        closePlayerModal();
    }
}

function mutePlayer() {
    if (!selectedPlayerId) {
        showError('Please select a player first');
        return;
    }
    
    socket.emit('mutePlayer', { gameCode: gameState.gameCode, playerId: selectedPlayerId });
    showSuccess('Player muted');
}

function closePlayerModal() {
    const modal = document.getElementById('playerModal');
    modal.style.display = 'none';
    selectedPlayerId = null;
}

function openPlayerModal(playerId, playerName, playerScore) {
    selectedPlayerId = playerId;
    document.getElementById('modalPlayerName').textContent = playerName;
    document.getElementById('modalPlayerScore').textContent = `Score: ${playerScore || 0}`;
    document.getElementById('playerModal').style.display = 'block';
}

// Question file upload functions
let selectedFile = null;
let parsedQuestions = [];

function handleFileSelect(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    if (file.type !== 'text/plain' && !file.name.endsWith('.txt')) {
        showError('Please select a .txt file');
        return;
    }
    
    selectedFile = file;
    const reader = new FileReader();
    
    reader.onload = function(e) {
        try {
            const content = e.target.result;
            parsedQuestions = parseQuestionFile(content);
            
            if (parsedQuestions.length > 0) {
                document.getElementById('uploadQuestionsBtn').disabled = false;
                showSuccess(`Parsed ${parsedQuestions.length} questions from file`);
            } else {
                document.getElementById('uploadQuestionsBtn').disabled = true;
                showError('No valid questions found in file');
            }
        } catch (error) {
            showError('Error reading file: ' + error.message);
        }
    };
    
    reader.readAsText(file);
}

function parseQuestionFile(content) {
    const lines = content.split('\n');
    const questions = [];
    let currentQuestion = null;
    let currentRound = 1;
    let currentOrder = 1;
    
    for (const line of lines) {
        const trimmedLine = line.trim();
        if (!trimmedLine || trimmedLine.startsWith('#')) continue;
        
        // Check if this looks like a question (longer, contains question words, or ends with punctuation)
        const isLikelyQuestion = trimmedLine.length > 30 || 
                               trimmedLine.includes('?') ||
                               trimmedLine.includes('that') ||
                               trimmedLine.includes('which') ||
                               trimmedLine.includes('what') ||
                               trimmedLine.includes('name') ||
                               trimmedLine.includes('word') ||
                               trimmedLine.includes('film') ||
                               trimmedLine.includes('movie') ||
                               trimmedLine.includes('poem') ||
                               trimmedLine.includes('letter');
        
        // Check if this looks like an answer (shorter, single word or phrase, no question words)
        const isLikelyAnswer = trimmedLine.length < 30 && 
                             !trimmedLine.includes('?') &&
                             !trimmedLine.includes('that') &&
                             !trimmedLine.includes('which') &&
                             !trimmedLine.includes('what') &&
                             !trimmedLine.includes('name') &&
                             !trimmedLine.includes('word') &&
                             !trimmedLine.includes('film') &&
                             !trimmedLine.includes('movie') &&
                             !trimmedLine.includes('poem') &&
                             !trimmedLine.includes('letter');
        
        if (isLikelyQuestion && currentQuestion) {
            // This is a new question, save the previous one
            if (currentQuestion.prompt && currentQuestion.correct_answers.length > 0) {
                questions.push({
                    ...currentQuestion,
                    round: currentRound,
                    question_order: currentOrder
                });
                currentOrder++;
            }
            
            // Start new question
            currentQuestion = {
                prompt: trimmedLine,
                correct_answers: []
            };
        } else if (currentQuestion && isLikelyAnswer) {
            // This is an answer for the current question
            currentQuestion.correct_answers.push(trimmedLine);
        } else if (!currentQuestion) {
            // First question
            currentQuestion = {
                prompt: trimmedLine,
                correct_answers: []
            };
        }
    }
    
    // Don't forget the last question
    if (currentQuestion && currentQuestion.prompt && currentQuestion.correct_answers.length > 0) {
        questions.push({
            ...currentQuestion,
            round: currentRound,
            question_order: currentOrder
        });
    }
    
    return questions;
}

async function uploadQuestions() {
    if (!parsedQuestions || parsedQuestions.length === 0) {
        showError('No questions to upload');
        return;
    }
    
    const uploadBtn = document.getElementById('uploadQuestionsBtn');
    const uploadStatus = document.getElementById('uploadStatus');
    
    uploadBtn.disabled = true;
    uploadStatus.style.display = 'block';
    uploadStatus.className = 'upload-status loading';
    uploadStatus.textContent = `Uploading ${parsedQuestions.length} questions...`;
    
    try {
        const response = await fetch('/api/upload-questions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ questions: parsedQuestions })
        });
        
        const result = await response.json();
        
        if (result.status === 'success') {
            uploadStatus.className = 'upload-status success';
            uploadStatus.textContent = `✅ ${result.message}`;
            showSuccess(`Successfully uploaded ${result.count} questions!`);
            
            // Reset file input
            document.getElementById('questionFile').value = '';
            selectedFile = null;
            parsedQuestions = [];
            uploadBtn.disabled = true;
        } else {
            uploadStatus.className = 'upload-status error';
            uploadStatus.textContent = `❌ ${result.message}`;
            showError(result.message);
        }
    } catch (error) {
        uploadStatus.className = 'upload-status error';
        uploadStatus.textContent = '❌ Upload failed';
        showError('Upload failed: ' + error.message);
    }
    
    uploadBtn.disabled = false;
}

// Play again
function playAgain() {
    if (isHost) {
        showScreen('lobby');
        // Reset game state for new game
        resetGameState();
    } else {
        showScreen('joinGame');
    }
}

// Socket event handlers
function handleGameCreated(data) {
    console.log('🎮 Game created:', data);
    gameState = data;
    isHost = true;
    showScreen('lobby');
    
    // Show host panel
    const hostPanel = document.getElementById('hostGamePanel');
    if (hostPanel) {
        hostPanel.style.display = 'block';
    }
    
    // Start game duration timer
    gameStartTime = Date.now();
    startGameDurationTimer();
    updateLobbyDisplay();
}

function handleGameJoined(data) {
    console.log('🎮 Script.js: handleGameJoined called with data:', data);
    console.log('🎮 Script.js: Received game state with', data.gameState?.players?.length || 0, 'players');
    console.log('🎮 Script.js: Full received data:', JSON.stringify(data, null, 2));
    console.log('🎮 Script.js: gameState.players type:', typeof data.gameState?.players);
    console.log('🎮 Script.js: gameState.players value:', data.gameState?.players);
    
    // Test JSON serialization on client side
    const testSerialization = JSON.stringify(data);
    const testDeserialization = JSON.parse(testSerialization);
    console.log('🎮 Script.js: Client-side serialization test - players after JSON roundtrip:', testDeserialization.gameState?.players?.length || 0);
    
    gameState = data.gameState;
    // Joining succeeded; any reconnect toast should only be shown now if we actually resumed
    if (autoResumeInProgress) {
        try { showToast('Rejoined your game', 'success'); } catch (_) {}
        autoResumeInProgress = false;
    }
    // Persist identity in case server normalized code/name
    try { savePlayerIdentity(data.gameCode || gameState.gameCode, currentPlayerName || localStorage.getItem('player.name')); } catch (_) {}

    // Route player to appropriate screen based on server state
    const phase = gameState.gameState;
    if (phase === 'waiting') {
    showScreen('lobby');
    updateLobbyDisplay();
        return;
    }
    if (phase === 'playing') {
        // Ensure questions and index are set before rendering
        questions = gameState.questions || questions || [];
        currentQuestionIndex = gameState.currentQuestion || 0;
        
        // Ensure player form is properly set up
        const playerForm = document.getElementById('playerAnswerForm');
        const answerInput = document.getElementById('answerInput');
        const submitBtn = document.getElementById('submitAnswerBtn');
        
        if (playerForm) playerForm.style.display = 'flex';
        if (answerInput) {
            answerInput.value = '';
            answerInput.disabled = false;
        }
        if (submitBtn) submitBtn.disabled = false;
        
        showScreen('game');
        displayCurrentQuestion();
        startTimer(); // Start timer if game is active
        return;
    }
    if (phase === 'grading') {
        showScreen('scoring');
        showWaitingForGrading();
        return;
    }
    if (phase === 'finished') {
        clearTimer();
        showScreen('gameOver');
        return;
    }
    // Fallback: lobby
    showScreen('lobby');
    updateLobbyDisplay();
}

function handlePlayerJoined(gameStateData) {
    console.log('🎮 Script.js: handlePlayerJoined called with gameStateData:', gameStateData);
    console.log('🎮 Script.js: Players count:', gameStateData.players?.length || 0);
    console.log('🎮 Script.js: Event type: virtualPlayerJoined or playerJoined');
    console.log('🎮 Script.js: Latest players:', gameStateData.players?.slice(-3)?.map(p => p.name) || []);
    console.log('🎮 Script.js: Full gameStateData structure:', Object.keys(gameStateData));
    console.log('🎮 Script.js: gameStateData.gameState:', gameStateData.gameState);
    console.log('🎮 Script.js: gameStateData.gameCode:', gameStateData.gameCode);
    
    // Check if this is a virtualPlayerJoined event (different structure)
    if (gameStateData.playerId && gameStateData.playerName) {
        console.log('🎮 Script.js: This appears to be a virtualPlayerJoined event with playerId:', gameStateData.playerId);
        console.log('🎮 Script.js: Virtual player name:', gameStateData.playerName);
        // For virtualPlayerJoined, we need to use the gameState property
        if (gameStateData.gameState) {
            console.log('🎮 Script.js: Using gameState from virtualPlayerJoined event');
            gameState = gameStateData.gameState;
        } else {
            console.log('🎮 Script.js: No gameState in virtualPlayerJoined event, keeping current gameState');
            // Don't update gameState if no gameState provided
            return;
        }
    } else {
        console.log('🎮 Script.js: This appears to be a regular playerJoined event');
        gameState = gameStateData;
    }
    
    console.log('🎮 Script.js: Updated gameState.players count:', gameState.players?.length || 0);
    updateLobbyDisplay();
}

function handleGameStarted(gameStateData) {
    console.log('🎮 handleGameStarted called with data:', gameStateData);
    gameState = gameStateData;
    questions = gameStateData.questions || [];
    currentQuestionIndex = 0;
    
    console.log('🔍 Debug: handleGameStarted received questions:', questions.length);
    console.log('🔍 Debug: First question:', questions[0]);
    console.log('🔍 Debug: First question prompt:', questions[0]?.prompt);
    
    // Store questions for grading interface
    if (questions.length > 0) {
        window.databaseQuestions = questions;
        console.log('🗄️ Stored', questions.length, 'questions from database for grading interface');
    }
    
    console.log('🎮 About to show game screen');
    showScreen('game');
    console.log('🎮 About to display current question');
    displayCurrentQuestion();
    console.log('🎮 About to start timer');
    startTimer();
    console.log('🎮 handleGameStarted completed');
    // Auto-generate virtual responses if testing
    scheduleVirtualQuestionFlow();
}

function handleTestGameStarted(gameStateData) {
    gameState = gameStateData;
    questions = gameStateData.questions || [];
    currentQuestionIndex = 0;
    
    // Store questions for grading interface
    if (questions.length > 0) {
        window.testGameQuestions = questions;
        console.log('🧪 Stored', questions.length, 'questions from test game for grading interface');
    }
    
    // Ensure test mode flag is set
    gameState.isTestMode = true;
    
    // Show test mode indicator
    const testModeIndicator = document.createElement('div');
    testModeIndicator.id = 'testModeIndicator';
    testModeIndicator.className = 'test-mode-indicator';
    testModeIndicator.innerHTML = '🧪 TEST MODE - Demo Game';
    document.body.appendChild(testModeIndicator);
    
    // Start the test game properly - show the first question
    showScreen('game');
    displayCurrentQuestion();
    startTimer();
    
    console.log('🧪 Test game started with', gameState.players?.length || 0, 'players');
}

function handleNextQuestion(gameStateData) {
    gameState = gameStateData;
    currentQuestionIndex = gameState.currentQuestion || 0;
    
    if (gameState.gameState === 'finished') {
        handleGameFinished(gameStateData);
        return;
    }
    
    showScreen('game');
    displayCurrentQuestion();
    startTimer();
    // Auto-generate virtual responses for next question if testing
    scheduleVirtualQuestionFlow();
    // Clear any lingering clarification prompt/state from previous question
    try {
        // Remove inline edit notice banner if present
        const editNotice = document.getElementById('editRequestNotice');
        if (editNotice && editNotice.parentNode) {
            editNotice.parentNode.removeChild(editNotice);
        }
        const status = document.getElementById('answerStatus');
        if (status) { status.innerHTML = ''; status.className = 'answer-status'; }
        const input = document.getElementById('answerInput');
        const btn = document.getElementById('submitAnswerBtn');
        if (input) { input.disabled = false; input.value = ''; }
        if (btn) { btn.disabled = false; }
        // Only clear the answer if we're actually moving to a new question, not during grading
        if (gameState.gameState === 'playing') {
            window.lastSubmittedAnswer = '';
            localStorage.removeItem('lastSubmittedAnswer');
        }
    } catch (_) {}
    
    // Show End Question button for new question
    const endQuestionBtn = document.getElementById('endQuestionBtn');
    if (endQuestionBtn && isHost) {
        endQuestionBtn.style.display = 'inline-block';
    }
}

function handleQuestionComplete(gameStateData) {
    console.log('📝 Question complete event received:', new Date().toISOString());
    console.log('📝 Game state data:', gameStateData);
    console.log('📝 Current answer groups:', gameStateData.currentAnswerGroups);
    gameState = gameStateData;
    clearTimer();
    
    // Hide End Question button since question is complete
    const endQuestionBtn = document.getElementById('endQuestionBtn');
    if (endQuestionBtn) {
        endQuestionBtn.style.display = 'none';
    }
    
    showScreen('scoring');
    
    // For host, MANDATORY grading phase
    if (isHost) {
        if (gameStateData.gameState === 'grading') {
            console.log('🎯 Host must complete grading before proceeding');
            forceMandatoryGrading();
        } else {
            displayQuestionResults();
        }
    } else {
        // Players wait for host to complete grading
        showWaitingForGrading();
    }

    // Capture read-only per-question snapshot on the host
    try {
        if (isHost) {
            window._questionHistory = window._questionHistory || [];
            const snapshot = {
                questionIndex: gameStateData.currentQuestion,
                roundNumber: Math.ceil((gameStateData.currentQuestion + 1) / (gameStateData.questionsPerRound || 5)),
                timestamp: Date.now(),
                answerGroups: Array.isArray(gameStateData.currentAnswerGroups) ? JSON.parse(JSON.stringify(gameStateData.currentAnswerGroups)) : []
            };
            window._questionHistory.push(snapshot);
        }
    } catch (_) {}
}

function handleRoundComplete(gameStateData) {
    console.log('🔄 Round complete event received:', new Date().toISOString());
    gameState = gameStateData;
    clearTimer();
    showScreen('scoring');
    displayRoundResults();

    // Capture end-of-round rollup for host (read-only)
    try {
        if (isHost) {
            window._roundHistoryClient = window._roundHistoryClient || [];
            const roundSummary = {
                roundNumber: Math.ceil((gameStateData.currentQuestion || 0) / (gameStateData.questionsPerRound || 5)),
                timestamp: Date.now(),
                serverRoundData: gameStateData.roundHistory?.[gameStateData.roundHistory.length - 1] || null
            };
            window._roundHistoryClient.push(roundSummary);
        }
    } catch (_) {}
}

function handleGradingComplete(gameStateData) {
    console.log('✅ Grading complete event received:', new Date().toISOString());
    console.log('✅ Game state data:', gameStateData);
    console.log('✅ Current game state:', gameStateData?.gameState);
    gameState = gameStateData;
    
    // Show the scoring screen first
    console.log('✅ Showing scoring screen');
    showScreen('scoring');
    
    // Show results to everyone now that grading is complete
    console.log('✅ Calling displayQuestionResults()');
    displayQuestionResults();
    console.log('✅ displayQuestionResults() completed');
}

function handleGameFinished(gameStateData) {
    gameState = gameStateData;
    clearTimer();
    showScreen('gameOver');
    displayFinalResults();
}

function handleAnswerSubmitted() {
    showToast('✅ Answer submitted! (Locked)', 'success');
}

function handleAnswerUpdate(data) {
    if (isHost) {
        // Only update the host dashboard, don't trigger any screen refreshes
        const answersReceivedElement = document.getElementById('answersReceived');
        const totalPlayersElement = document.getElementById('totalPlayers');
        
        if (answersReceivedElement) {
            let count = data.answersReceived;
            try {
                if (data.answers && typeof data.answers === 'object') {
                    const stableSet = new Set();
                    const playersArr = Array.isArray(gameState?.players) ? gameState.players : [];
                    Object.keys(data.answers).forEach(sid => {
                        const p = playersArr.find(pl => pl.id === sid);
                        const stable = p?.stableId || sid;
                        stableSet.add(stable);
                    });
                    if (stableSet.size > 0) count = stableSet.size;
                }
            } catch (_) {}
            answersReceivedElement.textContent = count;
        }
        if (totalPlayersElement) {
            totalPlayersElement.textContent = data.totalPlayers;
        }
        
        console.log('📊 Answer update received:', answersReceivedElement?.textContent || data.answersReceived, 'answers from', data.totalPlayers, 'players');
    }
}

function handleTimerUpdate(data) {
    // Update timer immediately for responsive display
    timeLeft = data.timeLeft;
    updateTimerDisplay();
            // console.log(`⏰ Client received timer update: ${timeLeft} seconds`);
}

function handleError(data) {
    // Only show generic error; if it is a join failure during auto-resume, clear in-progress flag
    try {
        const msg = data && data.message ? data.message : 'An error occurred';
        if (autoResumeInProgress && /already started|not found|cannot join|invalid|missing/i.test(msg)) {
            autoResumeInProgress = false;
        }
        showError(msg);
    } catch (_) {
        showError('An error occurred');
    }
}

function handleGameStateUpdate(data) {
    console.log('🔄 Game state update received:', data);
    if (data && data.gameState) {
        gameState = data.gameState;
        
        // Update questions if provided
        if (data.gameState.questions) {
            questions = data.gameState.questions;
        }
        
        // Update current question index if provided
        if (typeof data.gameState.currentQuestion === 'number') {
            currentQuestionIndex = data.gameState.currentQuestion;
        }
        
        // Route to appropriate screen based on new state
        const phase = gameState.gameState;
        if (phase === 'playing') {
            showScreen('game');
            displayCurrentQuestion();
            startTimer();
        } else if (phase === 'grading') {
            showScreen('scoring');
            showWaitingForGrading();
        } else if (phase === 'finished') {
            clearTimer();
            showScreen('gameOver');
        }
    }
}

// Display functions
function updateLobbyDisplay() {
    console.log('🎮 Script.js: updateLobbyDisplay called');
    console.log('🎮 Script.js: gameState.players:', gameState.players);
    console.log('🎮 Script.js: gameState.players.length:', gameState.players?.length || 0);
    
    const playerCountElement = document.getElementById('playerCount');
    if (playerCountElement) {
        playerCountElement.textContent = gameState.players?.length || 0;
        console.log('🎮 Script.js: Updated playerCount element to:', gameState.players?.length || 0);
    } else {
        console.log('🎮 Script.js: playerCount element not found');
    }
    
    // Update game code display (no copy button on player screen)
    const gameCodeElement = document.getElementById('gameCode');
    if (gameCodeElement && gameState.gameCode) {
        gameCodeElement.textContent = gameState.gameCode;
        console.log('🎮 Script.js: Updated gameCode element to:', gameState.gameCode);
        const existingCopy = document.getElementById('copyGameCodeBtn');
        if (existingCopy && existingCopy.parentNode) existingCopy.parentNode.removeChild(existingCopy);
    }
    
    // Update host dashboard statistics
    if (isHost) {
        console.log('🎮 Script.js: Updating host dashboard');
        const totalPlayersStatElement = document.getElementById('totalPlayersStat');
        if (totalPlayersStatElement) {
            totalPlayersStatElement.textContent = gameState.players?.length || 0;
            console.log('🎮 Script.js: Updated totalPlayersStat to:', gameState.players?.length || 0);
        } else {
            console.log('🎮 Script.js: totalPlayersStat element not found');
        }
        
        const questionsLoadedElement = document.getElementById('questionsLoaded');
        if (questionsLoadedElement) {
            questionsLoadedElement.textContent = questions.length;
            console.log('🎮 Script.js: Updated questionsLoaded to:', questions.length);
        } else {
            console.log('🎮 Script.js: questionsLoaded element not found');
        }
        
        // Show/hide host game management panel
        const hostGamePanel = document.getElementById('hostGamePanel');
        if (hostGamePanel) {
            hostGamePanel.style.display = 'block';
            console.log('🎮 Script.js: Showed hostGamePanel');
        } else {
            console.log('🎮 Script.js: hostGamePanel element not found');
        }
        
        // Show/hide player actions for host
        const playersActions = document.getElementById('playersActions');
        if (playersActions) {
            playersActions.style.display = 'block';
            console.log('🎮 Script.js: Showed playersActions');
        } else {
            console.log('🎮 Script.js: playersActions element not found');
        }
    } else {
        console.log('🎮 Script.js: Not host, hiding host elements');
        const hostGamePanel = document.getElementById('hostGamePanel');
        if (hostGamePanel) {
            hostGamePanel.style.display = 'none';
        }
        
        const playersActions = document.getElementById('playersActions');
        if (playersActions) {
            playersActions.style.display = 'none';
        }
    }
    
    const playersList = document.getElementById('playersList');
    if (playersList) {
        console.log('🎮 Script.js: Found playersList element, updating with', gameState.players?.length || 0, 'players');
        
        // Only clear and rebuild if we have no players or if this is the initial load
        if (!gameState.players || gameState.players.length === 0) {
            playersList.innerHTML = '';
            
            // Show waiting message when no players
            const waitingMessage = document.createElement('div');
            waitingMessage.className = 'waiting-message';
            waitingMessage.innerHTML = `
                <div class="waiting-icon">👥</div>
                <div class="waiting-text">Waiting for players to join...</div>
            `;
            playersList.appendChild(waitingMessage);
        } else {
            // Clear existing players and rebuild with new logic
            playersList.innerHTML = '';
            
            // Separate host from other players
            const host = gameState.players.find(player => player.id === socket.id);
            const otherPlayers = gameState.players.filter(player => player.id !== socket.id);
            
            // Always show host card first (with crown)
            if (host) {
                const hostCard = document.createElement('div');
                hostCard.className = 'player-card host';
                hostCard.dataset.playerId = host.id;
                hostCard.innerHTML = `
                    <div class="player-name">${host.name}</div>
                    <div class="player-crown">👑</div>
                `;
                playersList.appendChild(hostCard);
                console.log('🎮 Script.js: Added host card for:', host.name);
            }
            
            // Add VS badge between cards
            if (host && otherPlayers.length > 0) {
                const vsBadge = document.createElement('div');
                vsBadge.className = 'vs-badge';
                vsBadge.innerHTML = 'VS.';
                playersList.appendChild(vsBadge);
                console.log('🎮 Script.js: Added VS badge');
            }
            
            // Show summary card for other players
            if (otherPlayers.length > 0) {
                const summaryCard = document.createElement('div');
                summaryCard.className = 'player-card summary';
                summaryCard.innerHTML = `
                    <div class="player-label">The Flock</div>
                    <div class="player-name">${otherPlayers.length} Players</div>
                    <div class="player-count">👥</div>
                `;
                playersList.appendChild(summaryCard);
                console.log('🎮 Script.js: Added summary card for', otherPlayers.length, 'other players');
            }
        }
    } else {
        console.log('🎮 Script.js: playersList element not found');
    }
    
    // Show/hide start button for host
    const startGameBtn = document.getElementById('startGameBtn');
    if (startGameBtn) {
        if (isHost && gameState.players && gameState.players.length > 0) {
            startGameBtn.style.display = 'inline-block';
            console.log('🎮 Script.js: Showed startGameBtn');
        } else {
            startGameBtn.style.display = 'none';
            console.log('🎮 Script.js: Hid startGameBtn');
        }
    } else {
        console.log('🎮 Script.js: startGameBtn element not found');
    }
    
    // Add quick actions for host
    if (isHost) {
        const quickActionsContainer = document.getElementById('quickActions');
        if (quickActionsContainer && !quickActionsContainer.children.length) {
            quickActionsContainer.innerHTML = `
                <div class="quick-actions-section">
                    <h4>Quick Actions</h4>
                    <div class="quick-actions-grid">
                        <button class="btn btn-small btn-secondary" onclick="startVirtualPlayerSimulation()">
                            🎭 Start Virtual Test
                        </button>
                        <button class="btn btn-small btn-secondary" onclick="window.open('/display', '_blank')">
                            📺 Open Display
                        </button>
                    </div>
                </div>
            `;
        }
    }
    
    console.log('🎮 Script.js: updateLobbyDisplay completed');
}



function displayCurrentQuestion() {
    console.log('🔍 Debug: displayCurrentQuestion called');
    console.log('🔍 Debug: questions array length:', questions.length);
    console.log('🔍 Debug: currentQuestionIndex:', currentQuestionIndex);
    console.log('🔍 Debug: questions array:', questions);
    
    if (questions.length === 0 || currentQuestionIndex >= questions.length) {
        console.log('🔍 Debug: No questions available or index out of bounds');
        showError('No questions available');
        return;
    }
    
    const question = questions[currentQuestionIndex];
    console.log('🔍 Debug: Current question object:', question);
    console.log('🔍 Debug: Question prompt:', question?.prompt);
    
    document.getElementById('questionText').textContent = question.prompt;
    
    // Calculate round and question within round
    const questionNumber = currentQuestionIndex + 1;
    const roundNumber = Math.ceil(questionNumber / (gameState.questionsPerRound || 5));
    const questionInRound = ((questionNumber - 1) % (gameState.questionsPerRound || 5)) + 1;
    
    document.getElementById('roundNumber').textContent = roundNumber;
    document.getElementById('questionNumber').textContent = questionInRound;
    document.getElementById('totalQuestions').textContent = gameState.questionsPerRound || 5;
    

    
    // Show different interfaces for host vs players
    if (isHost) {
        // Host view
        document.getElementById('playerAnswerForm').style.display = 'none';
        document.getElementById('hostControls').style.display = 'block';
        document.getElementById('totalPlayers').textContent = gameState.players?.length || 0;
        document.getElementById('answersReceived').textContent = gameState.answers ? Object.keys(gameState.answers).length : '0';
        
        // Ensure host controls are visible in test mode
        if (gameState.isTestMode) {
            console.log('🧪 Test mode: Host controls should be visible');
        }
        
        // Show/hide End Question button based on game state
        const endQuestionBtn = document.getElementById('endQuestionBtn');
        if (endQuestionBtn) {
            endQuestionBtn.style.display = (gameState.gameState === 'playing') ? 'inline-block' : 'none';
        }
    } else {
        // Player view
        document.getElementById('playerAnswerForm').style.display = 'flex';
        document.getElementById('hostControls').style.display = 'none';
        
        // Reset answer form
        document.getElementById('answerInput').value = '';
        document.getElementById('answerInput').disabled = false;
        document.getElementById('submitAnswerBtn').disabled = false;
    }
    
    // Update players list
    updateGamePlayersList();
}

function displayQuestionResults() {
    console.log('📊 displayQuestionResults() called');
    console.log('📊 Current game state:', gameState);
    console.log('📊 Current answer groups:', gameState?.currentAnswerGroups);
    
    // Update the scoring title to show "Question Results"
    const scoringTitle = document.getElementById('scoringTitle');
    if (scoringTitle) {
        scoringTitle.textContent = 'Question Results';
        console.log('📊 Updated scoring title');
    } else {
        console.log('📊 Scoring title element not found');
    }
    
    // Get player's submitted answer
    const playerAnswer = window.lastSubmittedAnswer || localStorage.getItem('lastSubmittedAnswer') || '';
    const currentPlayerName = sessionStorage.getItem('playerName') || '';
    
    // Find player's answer group and ranking
    let playerAnswerGroup = null;
    let playerRank = 0;
    let totalPlayers = 0;
    let playerPoints = 0;
    
    if (gameState.currentAnswerGroups && gameState.currentAnswerGroups.length > 0) {
        // Calculate total players (fallback to players list length if count missing)
        totalPlayers = gameState.currentAnswerGroups.reduce((sum, group) => {
            const cnt = (typeof group.count === 'number')
                ? group.count
                : (Array.isArray(group.players) ? group.players.length : 0);
            return sum + cnt;
        }, 0);

        // Prefer matching by membership (player name) to support categorized buckets
        const lowerName = (currentPlayerName || '').toLowerCase();
        playerAnswerGroup = gameState.currentAnswerGroups.find(group => 
            Array.isArray(group.players) && group.players.some(p => String(p).toLowerCase() === lowerName)
        );

        // Fallback: match by submitted answer text
        if (!playerAnswerGroup && playerAnswer) {
            playerAnswerGroup = gameState.currentAnswerGroups.find(group => 
                (group.answer || '').toLowerCase() === playerAnswer.toLowerCase()
            );
        }
        
        // Calculate player's ranking for this question
        if (playerAnswerGroup) {
            playerPoints = playerAnswerGroup.points || 0;
            // Count how many players scored higher than this player
            const higherScoringGroups = gameState.currentAnswerGroups.filter(group => 
                (group.points || 0) > (playerAnswerGroup.points || 0)
            );
            playerRank = higherScoringGroups.reduce((sum, group) => {
                const cnt = (typeof group.count === 'number')
                    ? group.count
                    : (Array.isArray(group.players) ? group.players.length : 0);
                return sum + cnt;
            }, 0) + 1;
        }
    }
    
    // Display answers with enhanced layout
    const answersList = document.getElementById('answersList');
    const scoresList = document.getElementById('scoresList');
    
    // Clear previous content
    answersList.innerHTML = '';
    
    // Compute missed-correct for players
    const question = gameState.currentQuestionData || (Array.isArray(gameState.questions) ? gameState.questions[gameState.currentQuestion] : null);
    const correctAnswersList = Array.isArray(question?.correct_answers) ? question.correct_answers : [];
    const normalize = (s) => String(s||'').toLowerCase().trim();
    const correctGivenSet = new Set((gameState.currentAnswerGroups||[]).filter(g => (g.points||0) > 0).map(g => normalize(g.answer)));
    const missedCorrect = correctAnswersList.filter(ans => !correctGivenSet.has(normalize(ans)));

    // Create two-column layout for desktop, single column for mobile
    const isMobile = window.innerWidth <= 768;
    
    if (isMobile) {
        // Mobile: Single column layout
        answersList.style.display = 'block';
        answersList.innerHTML = `
            <div class="question-results-mobile">
                ${createPersonalResultSection(playerAnswer, playerAnswerGroup, playerRank, totalPlayers, playerPoints)}
                ${createAllAnswersSection(gameState.currentAnswerGroups, playerAnswerGroup, playerAnswer)}
            </div>
        `;
    } else {
        // Desktop: Two-column layout
        answersList.style.display = 'grid';
        answersList.style.gridTemplateColumns = '1fr 1fr';
        answersList.style.gap = '20px';
        answersList.innerHTML = `
            <div class="personal-result-section">
                ${createPersonalResultSection(playerAnswer, playerAnswerGroup, playerRank, totalPlayers, playerPoints)}
                ${missedCorrect.length > 0 ? renderMissedCorrectSection(missedCorrect) : ''}
            </div>
            <div class="all-answers-section">
                ${createAllAnswersSection(gameState.currentAnswerGroups, playerAnswerGroup, playerAnswer)}
            </div>
        `;
    }
    
    // Display scores (unchanged)
    scoresList.innerHTML = '';
    if (gameState.players) {
        gameState.players
            .sort((a, b) => (gameState.scores[b.id] || 0) - (gameState.scores[a.id] || 0))
            .forEach(player => {
                const scoreItem = document.createElement('div');
                scoreItem.className = 'score-item';
                scoreItem.innerHTML = `
                    <span>${player.name}</span>
                    <span>${gameState.scores[player.id] || 0} points</span>
                `;
                scoresList.appendChild(scoreItem);
            });
    }
    
    // Show/hide buttons for host (only show after grading is complete)
    const nextQuestionBtn = document.getElementById('nextQuestionBtn');
    const endGameBtn = document.getElementById('endGameBtn');
    
    if (isHost && gameState.gameState === 'scoring') {
        // Only show buttons after grading is complete
        if (currentQuestionIndex < questions.length - 1) {
            nextQuestionBtn.style.display = 'inline-block';
            endGameBtn.style.display = 'none';
            // Rename Next Question -> End Round on every 5th question
            try {
                const questionsPerRound = gameState.questionsPerRound || 5;
                // We are viewing results for question at currentQuestionIndex; moving next will start next question.
                // If this one completes the round, label should be End Round.
                const questionNumberJustFinished = currentQuestionIndex + 1;
                const isEndOfRound = (questionNumberJustFinished % questionsPerRound === 0);
                nextQuestionBtn.textContent = isEndOfRound ? 'End Round' : 'Next Question';
            } catch (_) {}
        } else {
            nextQuestionBtn.style.display = 'none';
            endGameBtn.style.display = 'inline-block';
        }
    } else {
        // Hide buttons during grading or for players
        nextQuestionBtn.style.display = 'none';
        endGameBtn.style.display = 'none';
    }
}
function renderMissedCorrectSection(missed) {
    const items = missed.map(a => `<div class="compact-answer"><span class="text">"${a}"</span><span class="points-pill">—</span></div>`).join('');
    return `
      <div class="answers-display" style="margin-top:14px;">
        <h3 style="display:flex; align-items:center; gap:8px;">⚠️ Correct Answers Not Given <span class="category-count">${missed.length}</span></h3>
        <div class="answers-results-grid">${items}</div>
      </div>
    `;
}

// Helper function to create personal result section
function createPersonalResultSection(playerAnswer, playerAnswerGroup, playerRank, totalPlayers, playerPoints) {
    const sanitize = (s) => String(s || '').replace(/[&<>"']/g, (c)=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
    const displayAnswerRaw = playerAnswer && playerAnswer.trim() !== '' ? playerAnswer : 'No Answer Submitted';
    const displayAnswer = sanitize(displayAnswerRaw);
    const isCorrect = playerAnswerGroup && playerAnswerGroup.points > 0;
    const statusIcon = isCorrect ? '✅' : '❌';
    const statusClass = isCorrect ? 'correct' : 'incorrect';
    const statusText = isCorrect ? 'Correct!' : 'Incorrect';
    
    let rankText = '';
    if (playerRank > 0 && totalPlayers > 0) {
        rankText = `You ranked #${playerRank} out of ${totalPlayers} players`;
    }
    
    const pointsNumber = Math.max(0, Number(playerPoints || 0));
    
    // Like-minded Sheep list (players who gave the same answer)
    const selfNameLower = (sessionStorage.getItem('playerName') || '').toLowerCase();
    const likeMindedPeers = Array.isArray(playerAnswerGroup?.players)
        ? playerAnswerGroup.players.filter(p => String(p).toLowerCase() !== selfNameLower)
        : [];
    const likeMindedSheep = likeMindedPeers.length > 0 ? likeMindedPeers.join(', ') : 'Only ewe!';
    
    const youBadge = '';
    return `
        <div class="personal-result-card ${statusClass}">
            <div class="personal-result-header">
                <h3>Your Result</h3>
                <div class="result-status ${statusClass}">
                    <span class="status-icon">${statusIcon}</span>
                    <span class="status-text">${statusText}</span>
                </div>
            </div>
            
            <div class="personal-answer" style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
                <div class="answer-label" style="margin:0;">Your Answer:</div>
                <div class="answer-text my-answer">${displayAnswer}</div>
            </div>
            
            <div class="personal-stats">
                ${rankText ? `<div class="stat-item"><span class="stat-label">Rank:</span> <span class="stat-value">${rankText}</span></div>` : ''}
                <div class="stat-item points-inline"><span class="stat-label">Points:</span><span class="points-chip">${pointsNumber}</span></div>
                <div class="stat-item"><span class="stat-label">Like-minded Sheep:</span> <span class="stat-value">${likeMindedSheep}</span></div>
            </div>
        </div>
    `;
}

// Helper function to create all answers section
    function createAllAnswersSection(answerGroups, playerAnswerGroup, playerAnswer) {
    if (!answerGroups || answerGroups.length === 0) {
        return '<div class="no-answers">No answers available</div>';
    }
    
    // Categorize answers
    const correctAnswers = answerGroups.filter(group => group.points > 0);
    const incorrectAnswers = answerGroups.filter(group => group.points === 0);
    
    let html = '<div class="all-answers-container">';
    
    const myNameLower = (sessionStorage.getItem('playerName') || '').toLowerCase();
    const playerAnswerLower = (playerAnswer || '').toLowerCase();
    const isGroupMine = (group) => {
        const hasPlayerList = Array.isArray(group.players) && group.players.length > 0;
        if (hasPlayerList) {
            if (group.players.some(p => String(p).toLowerCase() === myNameLower)) return true;
        }
        if (playerAnswerLower && typeof group.answer === 'string') {
            if (String(group.answer).toLowerCase() === playerAnswerLower) return true;
        }
        return false;
    };

    // Correct answers section with ultra-compact layout (mobile-friendly)
    if (correctAnswers.length > 0) {
        const sortedCorrectAnswers = [...correctAnswers].sort((a, b) => b.points - a.points);
        html += `<div class="answer-category correct"><div class="category-header"><h4>🏆 Correct Answers</h4><span class="category-count">${correctAnswers.length}</span></div><div class="answer-category-content compact-grid">`;
        sortedCorrectAnswers.forEach((group, index) => { const mine = isGroupMine(group); html += createCompactResultItem(group, true, index + 1, mine); });
        html += '</div></div>';
    }
    
    // Other answers section, also compact
    if (incorrectAnswers.length > 0) {
        const sortedIncorrectAnswers = [...incorrectAnswers].sort((a, b) => {
            const countA = (typeof a.count === 'number') ? a.count : (Array.isArray(a.players) ? a.players.length : 0);
            const countB = (typeof b.count === 'number') ? b.count : (Array.isArray(b.players) ? b.players.length : 0);
            return countB - countA;
        });
        html += `<div class="answer-category incorrect"><div class="category-header"><h4>❌ Incorrect Answers</h4><span class="category-count">${incorrectAnswers.length}</span></div><div class="answer-category-content compact-grid">`;
        sortedIncorrectAnswers.forEach((group, index) => { const mine = isGroupMine(group); html += createCompactResultItem(group, false, index + 1, mine); });
        html += '</div></div>';
    }
    
    html += '</div>';
    return html;
}

    // Ultra-compact item for mobile
    function createCompactResultItem(group, isCorrect, rank = null, isMine = false) {
        const pointsChip = isCorrect ? `<span class="points-pill">${group.points} pts</span>` : '';
        const mineClass = isMine ? ' mine' : '';
        const correctnessClass = isCorrect ? ' correct' : ' incorrect';
        return `<div class="compact-answer${mineClass}${correctnessClass}"><span class="rank">${rank ? '#'+rank : ''}</span><span class="text">${group.answer}</span>${pointsChip}</div>`;
}

// Function to show answer details (for click interaction)
function showAnswerDetails(answer, count, points, totalResponses) {
    const uniquenessText = count === 1 ? 'This was a unique answer!' : `${count} players gave this answer`;
    const pointsText = points > 0 ? `Each player earned ${points} points` : 'No points awarded';
    
    showToast(`${answer}: ${uniquenessText}. ${pointsText}`, 'info');
}

function displayRoundResults() {
    // Round summary (no per-question breakdown)
    const scoringTitle = document.getElementById('scoringTitle');
    const roundHistory = Array.isArray(gameState.roundHistory) ? gameState.roundHistory : [];
    const lastRound = roundHistory.length > 0 ? roundHistory[roundHistory.length - 1] : null;
    if (scoringTitle) {
        const roundNum = lastRound?.roundNumber || Math.ceil(((gameState.currentQuestion || 0) + 1) / (gameState.questionsPerRound || 5));
        scoringTitle.textContent = `Round ${roundNum} Results`;
    }
    
    const answersList = document.getElementById('answersList');
    // ensure FAB works for players
    try {
        const fab = document.getElementById('scoresFab');
        if (fab && !isHost) {
            fab.style.display = 'inline-flex';
            try { fab.removeEventListener('click', showScoresModal); } catch(_) {}
            fab.addEventListener('click', showScoresModal);
            fab.dataset.bound = '1';
        } else if (fab && isHost) {
            fab.style.display = 'none';
        }
    } catch(_) {}

    answersList.innerHTML = '';
    try {
        answersList.removeAttribute('style');
        answersList.style.setProperty('min-height', '0', 'important');
        answersList.style.setProperty('max-height', 'none', 'important');
        answersList.style.setProperty('height', 'auto', 'important');
        answersList.style.setProperty('overflow', 'visible', 'important');
        answersList.style.setProperty('display', 'block', 'important');
    } catch (_) {}

    const myName = (sessionStorage.getItem('playerName') || '').trim();
    const totalPlayers = Array.isArray(gameState.players) ? gameState.players.length : 0;

    // Build round delta map
    const roundScoresByName = new Map();
    if (lastRound && Array.isArray(lastRound.players)) {
        lastRound.players.forEach(p => roundScoresByName.set(String(p.name), Number(p.score || 0)));
    }

    const playersAfter = Array.isArray(gameState.players) ? gameState.players.map(p => ({
        id: p.id,
        name: p.name,
        totalAfter: Number((gameState.scores && gameState.scores[p.id]) || 0),
        roundDelta: Number(roundScoresByName.get(String(p.name)) || 0)
    })) : [];

    const playersBefore = playersAfter.map(p => ({ name: p.name, totalBefore: Math.max(0, p.totalAfter - p.roundDelta) }));
    const rankAfterList = [...playersAfter].sort((a,b) => b.totalAfter - a.totalAfter).map((p, idx) => ({ name: p.name, id: p.id, rank: idx + 1, total: p.totalAfter }));
    const rankBeforeList = [...playersBefore].sort((a,b) => b.totalBefore - a.totalBefore).map((p, idx) => ({ name: p.name, rank: idx + 1, total: p.totalBefore }));

    const myAfter = rankAfterList.find(p => p.name.toLowerCase() === myName.toLowerCase());
    const myBefore = rankBeforeList.find(p => p.name.toLowerCase() === myName.toLowerCase());
    const myRoundDelta = Number(roundScoresByName.get(myName) || 0);
    const myRankAfter = myAfter?.rank || 0;
    const myRankBefore = myBefore?.rank || 0;
    const rankChange = (myRankBefore && myRankAfter) ? (myRankBefore - myRankAfter) : 0; // positive = improved

    const upDown = rankChange > 0 ? `⬆️ +${rankChange}` : (rankChange < 0 ? `⬇️ ${rankChange}` : '—');
    const rankLine = (myRankAfter && totalPlayers) ? `You are now #${myRankAfter} of ${totalPlayers} (${upDown})` : '';
    const totalAfterText = myAfter ? myAfter.total : 0;
    const personalSummaryHtml = `
        <div class="personal-result-card correct">
            <div class="personal-result-header">
                <h3>Round Summary</h3>
            </div>
            <div class="personal-stats">
                <div class="stat-item points-inline"><span class="stat-label">Points this round:</span><span class="points-chip">${myRoundDelta}</span></div>
                <div class="stat-item"><span class="stat-label">Total score:</span> <span class="stat-value">${totalAfterText}</span></div>
                ${rankLine ? `<div class="stat-item"><span class="stat-label">Rank:</span> <span class="stat-value">${rankLine}</span></div>` : ''}
            </div>
        </div>`;

    // Leaderboard top 5
    const leaderboardRows = rankAfterList.map((p, index) => {
        const rank = index + 1;
        const mineClass = p.name.toLowerCase() === myName.toLowerCase() ? ' mine' : '';
        return `
            <div class="score-item single-line${mineClass}">
                <span class="rank-badge">#${rank}</span>
                <span class="player-name center-name">${p.name}</span>
                <span class="score-chip">${p.total} pts</span>
            </div>
        `;
    }).join('');
    const leaderboardHtml = `<div class="scores-display"><h3>Leaderboard</h3><div class="scores-list">${leaderboardRows}</div></div>`;

    const isMobile = window.innerWidth <= 768;
    if (isMobile) {
        answersList.style.display = 'block';
        answersList.innerHTML = `<div class="question-results-mobile">${personalSummaryHtml}${leaderboardHtml}</div>`;
        } else {
        answersList.style.display = 'grid';
        answersList.style.gridTemplateColumns = '1fr 1fr';
        answersList.style.gap = '20px';
        answersList.innerHTML = `<div class="personal-result-section">${personalSummaryHtml}</div><div class="all-answers-section">${leaderboardHtml}</div>`;
    }
}

function displayFinalResults() {
    const finalScoresList = document.getElementById('finalScoresList');
    const winnerText = document.getElementById('winnerText');
    const overallTitle = document.getElementById('overallTitle');
    const overallSubtitle = document.getElementById('overallSubtitle');
    const overallCount = document.getElementById('overallQuestionsCount');
    
    // Set titles for overall leaderboard
    if (overallTitle) overallTitle.textContent = 'Overall Leaderboard';
    if (overallSubtitle && overallCount) {
        try {
            const perRound = Number(gameState.questionsPerRound || 5);
            const roundsCompleted = Array.isArray(gameState.roundHistory) ? gameState.roundHistory.length : 0;
            const asked = Math.max(0, roundsCompleted * perRound);
            overallCount.textContent = String(asked || 0);
        } catch (_) { overallCount.textContent = '0'; }
    }

    // Display scores
    finalScoresList.innerHTML = '';
    if (gameState.players) {
        const sortedPlayers = gameState.players
            .sort((a, b) => (gameState.scores[b.id] || 0) - (gameState.scores[a.id] || 0));
        
        sortedPlayers.forEach((player, index) => {
            const scoreItem = document.createElement('div');
            scoreItem.className = 'score-item';
            scoreItem.innerHTML = `
                <span>#${index + 1} ${player.name}</span>
                <span>${gameState.scores[player.id] || 0} pts</span>
            `;
            finalScoresList.appendChild(scoreItem);
        });
    }
    

}

function updateGamePlayersList() {
    const gamePlayersList = document.getElementById('gamePlayersList');
    gamePlayersList.innerHTML = '';
    
    if (gameState.players) {
        // Separate current player from others
        const currentPlayer = gameState.players.find(player => player.id === socket.id);
        const otherPlayers = gameState.players.filter(player => player.id !== socket.id);
        
        // Always show current player card first
        if (currentPlayer) {
            const currentPlayerCard = document.createElement('div');
            currentPlayerCard.className = 'player-card host';
            
            // Calculate rank for current player
            const sortedPlayers = [...gameState.players].sort((a, b) => 
                (gameState.scores[b.id] || 0) - (gameState.scores[a.id] || 0)
            );
            const rank = sortedPlayers.findIndex(p => p.id === currentPlayer.id) + 1;
            
            currentPlayerCard.innerHTML = `
                <div class="player-name">${currentPlayer.name}</div>
                <div class="player-score">Score: ${gameState.scores[currentPlayer.id] || 0}</div>
                <div class="player-rank">Rank: ${rank}</div>
            `;
            gamePlayersList.appendChild(currentPlayerCard);
        }
        
        // Add VS badge between cards
        if (currentPlayer && otherPlayers.length > 0) {
            const vsBadge = document.createElement('div');
            vsBadge.className = 'vs-badge';
            vsBadge.innerHTML = 'VS.';
            gamePlayersList.appendChild(vsBadge);
        }
        
        // Show summary card for other players
        if (otherPlayers.length > 0) {
            const summaryCard = document.createElement('div');
            summaryCard.className = 'player-card summary';
            
            // Calculate flock statistics
            const otherScores = otherPlayers.map(p => gameState.scores[p.id] || 0);
            const averageScore = Math.round(otherScores.reduce((sum, score) => sum + score, 0) / otherScores.length);
            const highScore = Math.max(...otherScores);
            
            summaryCard.innerHTML = `
                <div class="player-label">The Flock</div>
                <div class="player-name">${otherPlayers.length} Players</div>
                <div class="player-score">Avg: ${averageScore} | High: ${highScore}</div>
                <div class="player-count">👥</div>
            `;
            gamePlayersList.appendChild(summaryCard);
        }
    }
}

// Timer functions
function startTimer() {
    // Server manages the timer, client just displays it
    timeLeft = 30;
    updateTimerDisplay();
}

function clearTimer() {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
}

function startGameDurationTimer() {
    if (gameDurationTimer) {
        clearInterval(gameDurationTimer);
    }
    
    gameDurationTimer = setInterval(() => {
        if (gameStartTime && isHost) {
            const elapsed = Date.now() - gameStartTime;
            const minutes = Math.floor(elapsed / 60000);
            const seconds = Math.floor((elapsed % 60000) / 1000);
            const durationText = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
            document.getElementById('gameDuration').textContent = durationText;
        }
    }, 1000);
}

function stopGameDurationTimer() {
    if (gameDurationTimer) {
        clearInterval(gameDurationTimer);
        gameDurationTimer = null;
    }
}

function updateTimerDisplay() {
    const timerElement = document.getElementById('timer');
    if (timerElement) {
        timerElement.textContent = timeLeft;
        
        // Change color when time is running low
        if (timeLeft <= 10) {
            timerElement.style.background = 'rgba(245, 87, 108, 0.8)';
        } else if (timeLeft <= 20) {
            timerElement.style.background = 'rgba(255, 193, 7, 0.8)';
        } else {
            timerElement.style.background = 'rgba(255, 255, 255, 0.2)';
        }
    }
    

}

// Utility functions
function groupAnswers(answers) {
    const groups = {};
    
    Object.values(answers).forEach(answer => {
        const normalized = answer.toLowerCase().trim();
        if (!groups[normalized]) {
            groups[normalized] = { answer: answer, count: 0 };
        }
        groups[normalized].count++;
    });
    
    return Object.values(groups).sort((a, b) => b.count - a.count);
}

function resetGameState() {
    gameState = {};
    questions = [];
    currentQuestionIndex = 0;
    clearTimer();
    isHost = false;
    currentPlayerName = null;
}

function showError(message) {
    // Remove existing error messages
    const existingError = document.querySelector('.error-message');
    if (existingError) {
        existingError.remove();
    }
    
    const errorDiv = document.createElement('div');
    errorDiv.className = 'error-message';
    errorDiv.textContent = message;
    
    const activeScreen = document.querySelector('.screen.active');
    if (activeScreen) {
        activeScreen.insertBefore(errorDiv, activeScreen.firstChild);
        
        // Auto-remove after 5 seconds
        setTimeout(() => {
            if (errorDiv.parentNode) {
                errorDiv.remove();
            }
        }, 5000);
    }
}

function showSuccess(message) {
    // Remove existing success messages
    const existingSuccess = document.querySelector('.success-message');
    if (existingSuccess) {
        existingSuccess.remove();
    }
    
    const successDiv = document.createElement('div');
    successDiv.className = 'success-message';
    successDiv.textContent = message;
    
    const activeScreen = document.querySelector('.screen.active');
    if (activeScreen) {
        activeScreen.insertBefore(successDiv, activeScreen.firstChild);
        
        // Auto-remove after 3 seconds
        setTimeout(() => {
            if (successDiv.parentNode) {
                successDiv.remove();
            }
        }, 3000);
    }
}

function showToast(message, type = 'info') {
    // Remove existing toasts
    const existingToasts = document.querySelectorAll('.toast-notification');
    existingToasts.forEach(toast => toast.remove());
    
    const toast = document.createElement('div');
    toast.className = `toast-notification toast-${type}`;
    toast.innerHTML = `
        <div class="toast-content">
            <span class="toast-message">${message}</span>
            <button class="toast-close" onclick="this.parentElement.parentElement.remove()">×</button>
        </div>
    `;
    
    // Add to body for overlay positioning
    document.body.appendChild(toast);
    
    // Trigger animation
    setTimeout(() => {
        toast.classList.add('show');
    }, 10);
    
    // Auto-remove after 4 seconds
    setTimeout(() => {
        if (toast.parentNode) {
            toast.classList.remove('show');
            setTimeout(() => {
                if (toast.parentNode) {
                    toast.remove();
                }
            }, 300);
        }
    }, 4000);
}

// Scores modal functions
function showScoresModal() {
    const scoresModal = document.getElementById('scoresModal');
    const scoresList = document.getElementById('scoresList');
    if (!scoresModal || !scoresList) return;
    
    // Populate scores list
    scoresList.innerHTML = '';
    if (gameState.players) {
        const myNameLower = (sessionStorage.getItem('playerName') || '').toLowerCase();
        gameState.players
            .sort((a, b) => (gameState.scores[b.id] || 0) - (gameState.scores[a.id] || 0))
            .forEach((player, index) => {
                const scoreItem = document.createElement('div');
                const isMe = String(player.name || '').toLowerCase() === myNameLower;
                scoreItem.className = 'score-item' + (isMe ? ' mine' : '');
                
                // Add rank indicator for top 3
                let rankIcon = '';
                if (index === 0) rankIcon = '🥇 ';
                else if (index === 1) rankIcon = '🥈 ';
                else if (index === 2) rankIcon = '🥉 ';
                
                scoreItem.innerHTML = `
                    <span class="player-name">${rankIcon}${player.name}</span>
                    <span class="player-score">${gameState.scores[player.id] || 0} points</span>
                `;
                scoresList.appendChild(scoreItem);
            });
    }
    
    // Show modal with animation
    scoresModal.style.display = 'block';
    setTimeout(() => {
        scoresModal.style.opacity = '1';
    }, 10);
}

function closeScoresModal() {
    const scoresModal = document.getElementById('scoresModal');
    scoresModal.style.opacity = '0';
    setTimeout(() => {
        scoresModal.style.display = 'none';
    }, 300);
}

// Answer Categorization Functions
function initializeAnswerCategorization() {
    if (!isHost) return;
    
    console.log('🎯 Initializing answer categorization...');
    
    answerCategorization.isCategorizationMode = true;
    answerCategorization.buckets = { uncategorized: [], wrong: [] };
    answerCategorization.correctAnswerBuckets = [];
    answerCategorization.customBuckets = [];
    answerCategorization.categorizedAnswers = {};
    
    // Show categorization interface
    const categorizationElement = document.getElementById('hostAnswerCategorization');
    const standardDisplay = document.getElementById('standardAnswersDisplay');
    
    if (categorizationElement) {
        categorizationElement.style.display = 'block';
        console.log('✅ Categorization interface shown');
    } else {
        console.error('❌ Could not find hostAnswerCategorization element');
    }
    
    if (standardDisplay) {
        standardDisplay.style.display = 'none';
    }
    
    // Create buckets based on pre-listed correct answers
    createCorrectAnswerBuckets();
    
    // Auto-categorize matching answers
    autoCategorizeMatchingAnswers();
    
    // Populate remaining uncategorized answers
    populateUncategorizedAnswers();
    setupDragAndDrop();
    
    console.log('🎯 Answer categorization initialized');
}

function createCorrectAnswerBuckets() {
    if (!gameState.questions || !gameState.questions[currentQuestionIndex]) {
        console.warn('⚠️ No current question found');
        return;
    }
    
    const currentQuestion = gameState.questions[currentQuestionIndex];
    const correctAnswers = currentQuestion.correct_answers || [];
    
    console.log('🎯 Creating buckets for correct answers:', correctAnswers);
    
    // Clear existing correct answer buckets
    answerCategorization.correctAnswerBuckets = [];
    
    // Create a bucket for each correct answer
    correctAnswers.forEach((correctAnswer, index) => {
        const bucketId = `correct_${index}`;
        const bucket = {
            id: bucketId,
            name: correctAnswer,
            correctAnswer: correctAnswer,
            answers: []
        };
        
        answerCategorization.correctAnswerBuckets.push(bucket);
    });
    
    // Sort buckets alphabetically by name
    answerCategorization.correctAnswerBuckets.sort((a, b) => a.name.localeCompare(b.name));
    
    // Render the correct answer buckets
    renderCorrectAnswerBuckets();
}

function renderCorrectAnswerBuckets() {
    const container = document.getElementById('correctAnswerBuckets');
    if (!container) {
        console.error('❌ Could not find correctAnswerBuckets container');
        return;
    }
    
    container.innerHTML = '';
    
    // Sort buckets alphabetically before rendering
    const sortedBuckets = [...answerCategorization.correctAnswerBuckets].sort((a, b) => a.name.localeCompare(b.name));
    sortedBuckets.forEach(bucket => {
        const bucketElement = document.createElement('div');
        bucketElement.className = 'answer-bucket correct-answer-bucket';
        bucketElement.dataset.bucket = bucket.id;
        
        bucketElement.innerHTML = `
            <h4>✅ ${bucket.name}</h4>
            <div class="answer-items" data-bucket="${bucket.id}">
                <!-- Answers will be dropped here -->
            </div>
        `;
        
        container.appendChild(bucketElement);

        // Populate any pre-categorized answers for this bucket
        try {
            if (Array.isArray(bucket.answers) && bucket.answers.length > 0) {
                const itemsContainer = bucketElement.querySelector('.answer-items');
                bucket.answers.forEach(group => {
                    const item = createAnswerItem({
                        answer: group.answer,
                        count: typeof group.count === 'number' ? group.count : (Array.isArray(group.players) ? group.players.length : 1),
                        points: group.points || 0,
                        players: group.players || []
                    });
                    itemsContainer.appendChild(item);
                });
            }
        } catch (e) { console.warn('Failed to populate pre-categorized answers', e); }
    });
    
    console.log('✅ Rendered', answerCategorization.correctAnswerBuckets.length, 'correct answer buckets');
}

function autoCategorizeMatchingAnswers() {
    if (!gameState.currentAnswerGroups || !answerCategorization.correctAnswerBuckets.length) {
        return;
    }
    
    console.log('🤖 Auto-categorizing matching answers...');
    
    const answersToRemove = [];
    
    gameState.currentAnswerGroups.forEach(answerGroup => {
        // Check if this answer matches any correct answer
        const matchingBucket = answerCategorization.correctAnswerBuckets.find(bucket => {
            const normalizedAnswer = answerGroup.answer.toLowerCase().trim();
            const normalizedCorrect = bucket.correctAnswer.toLowerCase().trim();
            
            return normalizedAnswer === normalizedCorrect;
        });
        
        if (matchingBucket) {
            // Move to the matching bucket
            matchingBucket.answers.push(answerGroup);
            answerCategorization.categorizedAnswers[answerGroup.answer] = matchingBucket.id;
            answersToRemove.push(answerGroup.answer);
            
            console.log(`✅ Auto-categorized "${answerGroup.answer}" to "${matchingBucket.name}" bucket`);
        }
    });
    
    // Remove auto-categorized answers from the main list
    // IMPORTANT: Do not remove from currentAnswerGroups yet; the host UI depends on it to render uncategorized list
    // We'll keep the group present so it can still be shown in Uncategorized until the host applies categorization.
}

function populateUncategorizedAnswers() {
    const uncategorizedContainer = document.getElementById('uncategorizedAnswers');
    if (!uncategorizedContainer) {
        console.error('❌ Could not find uncategorizedAnswers container');
        return;
    }
    
    uncategorizedContainer.innerHTML = '';
    
    console.log('📝 Populating uncategorized answers...');
    console.log('📝 Game state:', gameState);
    console.log('📝 Current answer groups:', gameState.currentAnswerGroups);
    console.log('📝 Answer groups length:', gameState.currentAnswerGroups?.length || 0);
    
    if (gameState.currentAnswerGroups && gameState.currentAnswerGroups.length > 0) {
        // Determine which answers are already in a correct bucket to avoid duplicating them in Uncategorized
        const categorizedSet = new Set();
        try {
            (answerCategorization.correctAnswerBuckets || []).forEach(b => (b.answers || []).forEach(a => categorizedSet.add((a.answer || '').toLowerCase().trim())));
        } catch (_) {}
        const isCategorized = (ans) => categorizedSet.has(String(ans || '').toLowerCase().trim());

        gameState.currentAnswerGroups.forEach(group => {
            if (isCategorized(group.answer)) return;
            const answerItem = createAnswerItem(group);
            answerCategorization.buckets.uncategorized.push(group);
            uncategorizedContainer.appendChild(answerItem);
            console.log('✅ Added answer item:', group.answer);
        });
        console.log('✅ Populated', gameState.currentAnswerGroups.length, 'uncategorized answers');
    } else {
        console.warn('⚠️ No uncategorized answers to populate');
    }
}

function createAnswerItem(answerGroup) {
    const answerItem = document.createElement('div');
    answerItem.className = 'answer-item';
    answerItem.draggable = true;
    answerItem.dataset.answer = answerGroup.answer;
    answerItem.dataset.count = answerGroup.count;
    answerItem.dataset.points = answerGroup.points;
    
    answerItem.innerHTML = `
        <div class="answer-content">
            <span class="answer-text">"${answerGroup.answer}"</span>
            <span class="answer-count">${answerGroup.count} player${answerGroup.count > 1 ? 's' : ''}</span>
            ${Array.isArray(answerGroup.players) && answerGroup.players.length > 0 ? `<div class="answer-players" style="color:#ccc; font-size:12px; margin-top:4px;">${answerGroup.players.join(', ')}</div>` : ''}
        </div>
        <div class="answer-actions">
            <button class="answer-action-btn correct" title="Mark as correct">✅</button>
            <button class="answer-action-btn incorrect" title="Mark as wrong">❌</button>
        </div>
    `;
    
    // Add event listeners
    answerItem.addEventListener('dragstart', handleGradingDragStart);
    answerItem.addEventListener('dragend', handleGradingDragEnd);
    
    const correctBtn = answerItem.querySelector('.answer-action-btn.correct');
    const incorrectBtn = answerItem.querySelector('.answer-action-btn.incorrect');
    
    correctBtn.addEventListener('click', () => markAnswerAs(answerGroup, 'correct'));
    incorrectBtn.addEventListener('click', () => markAnswerAs(answerGroup, 'wrong'));
    
    return answerItem;
}

function setupDragAndDrop() {
    // Setup drop zones
    const dropZones = document.querySelectorAll('#hostAnswerCategorization .answer-items, #gradingAnswerCategorization .answer-items, .custom-bucket');
    
    dropZones.forEach(zone => {
        zone.addEventListener('dragover', handleDragOver);
        zone.addEventListener('drop', handleDrop);
        zone.addEventListener('dragenter', handleDragEnter);
        zone.addEventListener('dragleave', handleDragLeave);
    });
    
    console.log('🎯 Drag and drop setup complete for', dropZones.length, 'zones');
}

function handleDragStart(e) {
    draggedElement = e.target;
    dragSource = e.target.parentElement;
    e.target.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/html', e.target.outerHTML);
}

function handleDragEnd(e) {
    e.target.classList.remove('dragging');
    draggedElement = null;
    dragSource = null;
}

function handleDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
}

function handleDragEnter(e) {
    e.preventDefault();
    e.currentTarget.classList.add('drag-over');
}

function handleDragLeave(e) {
    e.currentTarget.classList.remove('drag-over');
}

function handleDrop(e) {
    e.preventDefault();
    e.currentTarget.classList.remove('drag-over');
    
    if (!draggedElement) return;
    
    const targetBucket = e.currentTarget;
    const bucketType = targetBucket.dataset.bucket || targetBucket.dataset.customBucket;
    
    // Move the answer item
    targetBucket.appendChild(draggedElement);
    
    // Update categorization state
    const answerText = draggedElement.dataset.answer;
    const answerGroup = findAnswerGroup(answerText);
    
    if (answerGroup) {
        moveAnswerToBucket(answerGroup, bucketType);
    }
}

function findAnswerGroup(answerText) {
    return gameState.currentAnswerGroups.find(group => group.answer === answerText);
}

function moveAnswerToBucket(answerGroup, bucketType) {
    // Remove from current bucket
    Object.keys(answerCategorization.buckets).forEach(bucket => {
        const index = answerCategorization.buckets[bucket].findIndex(item => item.answer === answerGroup.answer);
        if (index !== -1) {
            answerCategorization.buckets[bucket].splice(index, 1);
        }
    });
    
    // Remove from correct answer buckets
    answerCategorization.correctAnswerBuckets.forEach(bucket => {
        const index = bucket.answers.findIndex(item => item.answer === answerGroup.answer);
        if (index !== -1) {
            bucket.answers.splice(index, 1);
        }
    });
    
    // Add to new bucket
    if (bucketType === 'uncategorized' || bucketType === 'wrong') {
        answerCategorization.buckets[bucketType].push(answerGroup);
    } else if (bucketType.startsWith('correct_')) {
        // Correct answer bucket
        const correctBucket = answerCategorization.correctAnswerBuckets.find(bucket => bucket.id === bucketType);
        if (correctBucket) {
            correctBucket.answers.push(answerGroup);
        }
    } else {
        // Custom bucket
        const customBucket = answerCategorization.customBuckets.find(bucket => bucket.id === bucketType);
        if (customBucket) {
            customBucket.answers.push(answerGroup);
        }
    }
    
    answerCategorization.categorizedAnswers[answerGroup.answer] = bucketType;
}

function markAnswerAs(answerGroup, type) {
    const answerItem = document.querySelector(`[data-answer="${answerGroup.answer}"]`);
    if (!answerItem) return;
    
    // Remove existing classes
    answerItem.classList.remove('correct', 'incorrect');
    
    // Add new class
    answerItem.classList.add(type);
    
    // Move to appropriate bucket
    if (type === 'wrong') {
        moveAnswerToBucket(answerGroup, 'wrong');
        
        // Move DOM element
        const targetContainer = document.getElementById('wrongAnswers');
        targetContainer.appendChild(answerItem);
    } else {
        // For correct answers, we need to show a modal to choose which correct answer bucket
        showCorrectAnswerSelector(answerGroup, answerItem);
    }
}

function showCorrectAnswerSelector(answerGroup, answerItem) {
    if (answerCategorization.correctAnswerBuckets.length === 0) {
        // No correct answer buckets, just mark as wrong
        moveAnswerToBucket(answerGroup, 'wrong');
        const targetContainer = document.getElementById('wrongAnswers');
        targetContainer.appendChild(answerItem);
        return;
    }
    
    // Create a simple modal to select which correct answer bucket
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.style.display = 'block';
    
    const content = document.createElement('div');
    content.className = 'modal-content scores-modal';
    
    const bucketOptions = answerCategorization.correctAnswerBuckets.map(bucket => 
        `<button class="btn btn-primary bucket-option" data-bucket="${bucket.id}">${bucket.name}</button>`
    ).join('');
    
    content.innerHTML = `
        <div class="modal-header">
            <h4>🎯 Choose Correct Answer Bucket</h4>
            <span class="close" onclick="this.parentElement.parentElement.parentElement.remove()">&times;</span>
        </div>
        <div class="modal-body">
            <p>Which correct answer does "${answerGroup.answer}" match?</p>
            <div class="bucket-options">
                ${bucketOptions}
            </div>
        </div>
    `;
    
    modal.appendChild(content);
    document.body.appendChild(modal);
    
    // Add event listeners to bucket options
    modal.querySelectorAll('.bucket-option').forEach(button => {
        button.addEventListener('click', () => {
            const bucketId = button.dataset.bucket;
            const bucket = answerCategorization.correctAnswerBuckets.find(b => b.id === bucketId);
            
            if (bucket) {
                moveAnswerToBucket(answerGroup, bucketId);
                
                // Move DOM element to the correct bucket
                const targetContainer = document.querySelector(`[data-bucket="${bucketId}"]`);
                if (targetContainer) {
                    targetContainer.appendChild(answerItem);
                }
            }
            
            modal.remove();
        });
    });
}

function addCustomBucket() {
    const bucketId = 'bucket_' + Date.now();
    const newBucket = {
        id: bucketId,
        name: 'New Group',
        answers: []
    };
    
    answerCategorization.customBuckets.push(newBucket);
    renderCustomBuckets();
}

function renderCustomBuckets() {
    const container = document.getElementById('customBuckets');
    container.innerHTML = '';
    
    answerCategorization.customBuckets.forEach(bucket => {
        const bucketElement = document.createElement('div');
        bucketElement.className = 'custom-bucket';
        bucketElement.dataset.customBucket = bucket.id;
        
        bucketElement.innerHTML = `
            <h5>
                <input type="text" class="bucket-name-input" value="${bucket.name}" 
                       onchange="updateBucketName('${bucket.id}', this.value)">
                <button class="remove-bucket-btn" onclick="removeCustomBucket('${bucket.id}')">×</button>
            </h5>
            <div class="answer-items" data-bucket="${bucket.id}">
                <!-- Answers will be dropped here -->
            </div>
        `;
        
        container.appendChild(bucketElement);
    });
    
    // Re-setup drag and drop for new buckets
    setupDragAndDrop();
}

function updateBucketName(bucketId, newName) {
    const bucket = answerCategorization.customBuckets.find(b => b.id === bucketId);
    if (bucket) {
        bucket.name = newName;
    }
}

function removeCustomBucket(bucketId) {
    const bucket = answerCategorization.customBuckets.find(b => b.id === bucketId);
    if (bucket) {
        // Move answers back to uncategorized
        bucket.answers.forEach(answer => {
            moveAnswerToBucket(answer, 'uncategorized');
        });
        
        // Remove bucket
        answerCategorization.customBuckets = answerCategorization.customBuckets.filter(b => b.id !== bucketId);
        renderCustomBuckets();
    }
}

function mergeSelectedBuckets() {
    // Implementation for merging selected buckets
    // This could be enhanced with checkboxes for selection
    console.log('Merge buckets functionality - to be implemented');
}

function previewScoring() {
    // Calculate scoring based on current categorization
    const categorizedGroups = calculateCategorizedScoring();
    
    // Show preview modal with scoring
    showScoringPreview(categorizedGroups);
}

function calculateCategorizedScoring() {
    const allAnswers = [];
    
    // Collect all answers from standard buckets
    Object.keys(answerCategorization.buckets).forEach(bucketType => {
        answerCategorization.buckets[bucketType].forEach(answer => {
            allAnswers.push({
                ...answer,
                bucketType: bucketType,
                isCorrect: false // Only uncategorized and wrong buckets
            });
        });
    });
    
    // Collect all answers from correct answer buckets
    answerCategorization.correctAnswerBuckets.forEach(bucket => {
        bucket.answers.forEach(answer => {
            allAnswers.push({
                ...answer,
                bucketType: bucket.id,
                bucketName: bucket.name,
                isCorrect: true
            });
        });
    });
    
    // Collect all answers from custom buckets
    answerCategorization.customBuckets.forEach(bucket => {
        bucket.answers.forEach(answer => {
            allAnswers.push({
                ...answer,
                bucketType: bucket.id,
                bucketName: bucket.name,
                isCorrect: false // Custom buckets are not automatically correct
            });
        });
    });
    
    // Group by bucket type for scoring
    const bucketGroups = {};
    allAnswers.forEach(answer => {
        const key = answer.bucketType;
        if (!bucketGroups[key]) {
            bucketGroups[key] = [];
        }
        bucketGroups[key].push(answer);
    });
    
    // Calculate points for each bucket
    const totalResponses = allAnswers.reduce((sum, answer) => sum + answer.count, 0);
    
    Object.keys(bucketGroups).forEach(bucketKey => {
        const bucketAnswers = bucketGroups[bucketKey];
        const bucketTotalCount = bucketAnswers.reduce((sum, answer) => sum + answer.count, 0);
        const points = Math.ceil(totalResponses / bucketTotalCount);
        
        bucketAnswers.forEach(answer => {
            answer.points = points;
        });
    });
    
    return allAnswers;
}

function showScoringPreview(categorizedGroups) {
    // Create a modal to show the scoring preview
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.style.display = 'block';
    
    const content = document.createElement('div');
    content.className = 'modal-content scores-modal';
    
    content.innerHTML = `
        <div class="modal-header">
            <h4>📊 Scoring Preview</h4>
            <span class="close" onclick="this.parentElement.parentElement.parentElement.remove()">&times;</span>
        </div>
        <div class="modal-body">
            <div class="scoring-preview">
                ${generateScoringPreviewHTML(categorizedGroups)}
            </div>
        </div>
    `;
    
    modal.appendChild(content);
    document.body.appendChild(modal);
}

function generateScoringPreviewHTML(categorizedGroups) {
    let html = '';
    
    // Group by bucket type
    const bucketGroups = {};
    categorizedGroups.forEach(answer => {
        const key = answer.bucketType;
        if (!bucketGroups[key]) {
            bucketGroups[key] = [];
        }
        bucketGroups[key].push(answer);
    });
    
    Object.keys(bucketGroups).forEach(bucketKey => {
        const bucketAnswers = bucketGroups[bucketKey];
        const bucketName = getBucketDisplayName(bucketKey);
        const totalPoints = bucketAnswers[0]?.points || 0;
        
        html += `
            <div class="bucket-preview">
                <h5>${bucketName} (${totalPoints} points each)</h5>
                <div class="bucket-answers">
                    ${bucketAnswers.map(answer => `
                        <div class="preview-answer">
                            <span>"${answer.answer}"</span>
                            <span>${answer.count} player${answer.count > 1 ? 's' : ''}</span>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
    });
    
    return html;
}

function getBucketDisplayName(bucketKey) {
    switch (bucketKey) {
        case 'wrong': return '❌ Wrong Answers';
        case 'uncategorized': return '📝 Uncategorized';
        default:
            if (bucketKey.startsWith('correct_')) {
                const correctBucket = answerCategorization.correctAnswerBuckets.find(b => b.id === bucketKey);
                return correctBucket ? `✅ ${correctBucket.name}` : '✅ Correct Answer';
            }
            const customBucket = answerCategorization.customBuckets.find(b => b.id === bucketKey);
            return customBucket ? customBucket.name : 'Custom Group';
    }
}

function applyCategorization() {
    // Build server-expected structure for reliable scoring
    const payload = { correctAnswerBuckets: [], wrong: [], uncategorized: [] };
    try {
        // Correct buckets
        (answerCategorization.correctAnswerBuckets || []).forEach(bucket => {
            const entry = {
                id: bucket.id,
                name: bucket.name,
                correctAnswer: bucket.correctAnswer || bucket.name,
                answers: (bucket.answers || []).map(a => ({ answer: a.answer }))
            };
            payload.correctAnswerBuckets.push(entry);
        });
        // Wrong
        (answerCategorization.buckets?.wrong || []).forEach(a => payload.wrong.push({ answer: a.answer }));
        // Uncategorized
        (answerCategorization.buckets?.uncategorized || []).forEach(a => payload.uncategorized.push({ answer: a.answer }));
    } catch (e) { console.warn('Failed to build categorization payload', e); }

    socket.emit('completeGrading', {
        gameCode: gameState.gameCode,
        categorizedAnswers: payload
    });
    
    // Locally update with a preview (non-authoritative), will be replaced by server state
    const preview = calculateCategorizedScoring();
    gameState.currentAnswerGroups = preview;
    
    // Hide categorization interface
    document.getElementById('hostAnswerCategorization').style.display = 'none';
    document.getElementById('standardAnswersDisplay').style.display = 'block';
    
    answerCategorization.isCategorizationMode = false;
    
    console.log('📝 Grading completed and sent to server');
}

function forceMandatoryGrading() {
    console.log('🎯 Starting mandatory grading phase');
    
    // Hide standard next question button
    const nextQuestionBtn = document.getElementById('nextQuestionBtn');
    if (nextQuestionBtn) {
        nextQuestionBtn.style.display = 'none';
    }
    
    // Show mandatory grading interface
    initializeAnswerCategorization();
    
    // Update UI to indicate grading is required
    const scoringTitle = document.getElementById('scoringTitle');
    if (scoringTitle) {
        scoringTitle.textContent = '📝 Host Grading Required';
    }
    
    // Add warning message
    const scoringScreen = document.getElementById('scoringScreen');
    if (scoringScreen) {
        let warningMessage = document.getElementById('gradingWarning');
        if (!warningMessage) {
            warningMessage = document.createElement('div');
            warningMessage.id = 'gradingWarning';
            warningMessage.className = 'grading-warning';
            warningMessage.innerHTML = `
                <p><strong>⚠️ Grading Required:</strong> You must categorize answers before proceeding to the next question.</p>
                <p>Drag similar answers together and click "Apply Categorization" when done.</p>
            `;
            warningMessage.style.cssText = `
                background: rgba(255, 193, 7, 0.2);
                border: 2px solid #ffc107;
                border-radius: 8px;
                padding: 15px;
                margin: 20px 0;
                color: #ffffff;
            `;
            scoringScreen.insertBefore(warningMessage, scoringScreen.firstChild.nextSibling);
        }
    }
}

function showWaitingForGrading() {
    console.log('⏳ Players waiting for host grading');
    
    // Update title for players
    const scoringTitle = document.getElementById('scoringTitle');
    if (scoringTitle) {
        scoringTitle.textContent = '⏳ Waiting for Host Grading';
    }
    
    // Hide answer results until grading is complete
    const answersList = document.getElementById('answersList');
    if (answersList) {
        // Get the submitted answer from window storage (only use window, not localStorage for current question)
        const submittedAnswer = window.lastSubmittedAnswer || '';
        const displayAnswer = submittedAnswer && submittedAnswer.trim() !== '' ? submittedAnswer : 'No Answer Received';
        console.log('🎯 Retrieved submitted answer:', submittedAnswer);
        console.log('🎯 Display answer:', displayAnswer);
        
        // Override grid layout for centering
        answersList.style.display = 'flex';
        answersList.style.flexDirection = 'column';
        answersList.style.alignItems = 'center';
        answersList.style.justifyContent = 'center';
        answersList.style.minHeight = '400px';
        
        answersList.innerHTML = `
            <!-- My Submitted Answer -->
            <div style="background: rgba(0, 123, 255, 0.1); border: 1px solid rgba(0, 123, 255, 0.3); border-radius: 10px; padding: 15px; margin-bottom: 20px; text-align: center; width: 100%; max-width: 500px;">
                <div style="background: rgba(255, 255, 255, 0.1); padding: 15px; border-radius: 5px; color: #ffffff; font-size: 18px; font-weight: bold;">${displayAnswer}</div>
            </div>
            
            <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; width: 100%; max-width: 500px; background: rgba(0, 123, 255, 0.1); border: 1px solid rgba(0, 123, 255, 0.3); border-radius: 10px; padding: 30px;">
                <div class="loading-spinner"></div>
                <p style="text-align: center; margin: 15px 0; color: #ffffff; font-size: 16px; line-height: 1.4;">Host is reviewing and<br>grading answers...<br>Results will appear shortly!</p>
            </div>
        `;
    }
    
    // Hide scores until grading is complete
    const scoresList = document.getElementById('scoresList');
    if (scoresList) {
        scoresList.innerHTML = `
            <div class="waiting-message">
                <p>Scores will be updated after grading is complete</p>
            </div>
        `;
    }
}

function autoCategorizeAnswers() {
    // Simple auto-categorization based on pre-defined correct answers
    if (!gameState.questions || !gameState.questions[currentQuestionIndex]) return;
    
    const currentQuestion = gameState.questions[currentQuestionIndex];
    const correctAnswers = currentQuestion.correct_answers || [];
    
    // Move all answers to uncategorized first
    answerCategorization.buckets.uncategorized = [...answerCategorization.buckets.correct, ...answerCategorization.buckets.wrong];
    answerCategorization.buckets.correct = [];
    answerCategorization.buckets.wrong = [];
    
    // Auto-categorize based on correct answers
    answerCategorization.buckets.uncategorized.forEach(answerGroup => {
        const isCorrect = correctAnswers.some(correct => 
            answerGroup.answer.toLowerCase().includes(correct.toLowerCase()) ||
            correct.toLowerCase().includes(answerGroup.answer.toLowerCase())
        );
        
        if (isCorrect) {
            answerCategorization.buckets.correct.push(answerGroup);
        } else {
            answerCategorization.buckets.wrong.push(answerGroup);
        }
    });
    
    // Clear uncategorized
    answerCategorization.buckets.uncategorized = [];
    
    // Re-render the interface
    populateUncategorizedAnswers();
    renderCustomBuckets();
    
    showSuccess('Answers auto-categorized!');
}

// Grading Modal Functions
function openGradingModal() {
    if (!isHost) return;
    
    console.log('🎯 Opening grading modal...');
    
    try {
        // Check if questions are available - try multiple sources
        let questions = [];
        
        // Check gameState.questions first
        if (gameState.questions && gameState.questions.length > 0) {
            questions = gameState.questions;
            console.log('📚 Found questions in gameState:', questions.length);
        }
        // Check if we have questions from a test game
        else if (window.testGameQuestions && window.testGameQuestions.length > 0) {
            questions = window.testGameQuestions;
            console.log('🧪 Found questions from test game:', questions.length);
        }
        // Check if we have questions from database loading
        else if (window.databaseQuestions && window.databaseQuestions.length > 0) {
            questions = window.databaseQuestions;
            console.log('🗄️ Found questions from database:', questions.length);
        }
        
        if (questions.length === 0) {
            console.log('⚠️ No questions available - showing help message');
            showInfo('Please load questions first before using the grading interface. Click "Upload Sample Questions" or start a game with "Supabase Database" selected.');
            return;
        }
        
        const modal = document.getElementById('gradingModal');
        if (!modal) {
            console.error('❌ Grading modal not found');
            showError('Grading interface not available');
            return;
        }
        
        // Force modal to be visible and prevent any interference
        modal.style.display = 'block';
        modal.style.visibility = 'visible';
        modal.style.opacity = '1';
        modal.style.zIndex = '10000';
        
        // Store questions for the grading interface
        window.gradingQuestions = questions;
        
        // Populate question selector
        populateGradingQuestionSelector();
        
        // Reset modal state
        resetGradingModal();
        
        // Ensure modal stays visible
        setTimeout(() => {
            const modal = document.getElementById('gradingModal');
            if (modal && modal.style.display !== 'block') {
                console.log('🔄 Re-showing modal...');
                modal.style.display = 'block';
            }
        }, 100);
        
        console.log('✅ Grading modal opened successfully with', questions.length, 'questions');
    } catch (error) {
        console.error('❌ Error opening grading modal:', error);
        showError('Failed to open grading interface');
    }
}

function closeGradingModal() {
    console.log('🎯 Closing grading modal...');
    
    const modal = document.getElementById('gradingModal');
    modal.style.display = 'none';
    
    // Reset modal state
    resetGradingModal();
}

function toggleGradingModalFullscreen() {
    const modalContent = document.querySelector('#gradingModal .modal-content');
    const toggleBtn = document.getElementById('toggleFullscreenBtn');
    const btnIcon = toggleBtn.querySelector('.btn-icon');
    
    if (modalContent.classList.contains('fullscreen')) {
        // Exit fullscreen
        modalContent.classList.remove('fullscreen');
        btnIcon.textContent = '⛶';
        toggleBtn.title = 'Enter Full Screen';
        console.log('🖥️ Exited fullscreen mode');
    } else {
        // Enter fullscreen
        modalContent.classList.add('fullscreen');
        btnIcon.textContent = '⛶';
        toggleBtn.title = 'Exit Full Screen';
        console.log('🖥️ Entered fullscreen mode');
    }
}

function resetGradingModal() {
    try {
        // Hide question display and categorization
        const questionDisplay = document.getElementById('gradingQuestionDisplay');
        const answerCategorization = document.getElementById('gradingAnswerCategorization');
        const noQuestionMessage = document.getElementById('gradingNoQuestionMessage');
        
        if (questionDisplay) questionDisplay.style.display = 'none';
        if (answerCategorization) answerCategorization.style.display = 'none';
        
        // Only show no-question message if we actually have no questions
        if (noQuestionMessage) {
            const questions = window.gradingQuestions || [];
            if (questions.length === 0) {
                noQuestionMessage.style.display = 'block';
            } else {
                noQuestionMessage.style.display = 'none';
            }
        }
        
        // Reset question selector
        const selector = document.getElementById('gradingQuestionSelect');
        if (selector) selector.value = '';
    } catch (error) {
        console.error('❌ Error resetting grading modal:', error);
    }
}

function populateGradingQuestionSelector() {
    try {
        const selector = document.getElementById('gradingQuestionSelect');
        if (!selector) {
            console.error('❌ Grading question selector not found');
            return;
        }
        
        selector.innerHTML = '<option value="">Choose a question...</option>';
        
        // Use the questions stored for grading (check both variable names)
        const questions = window.currentGradingQuestions || window.gradingQuestions || [];
        
        if (questions.length === 0) {
            console.log('⚠️ No questions available for grading');
            
            // Show a message in the modal instead of freezing
            const noQuestionMessage = document.getElementById('gradingNoQuestionMessage');
            if (noQuestionMessage) {
                noQuestionMessage.innerHTML = `
                    <div class="grading-no-questions">
                        <h4>📚 No Questions Available</h4>
                        <p>Please load questions first:</p>
                        <ul>
                            <li>Click "Upload Sample Questions" to load demo questions</li>
                            <li>Or start a game with "Supabase Database" selected</li>
                            <li>Or upload custom questions</li>
                        </ul>
                        <button onclick="closeGradingModal()" class="btn btn-secondary">Close</button>
                    </div>
                `;
                noQuestionMessage.style.display = 'block';
            }
            return;
        }
        
        questions.forEach((question, index) => {
            const option = document.createElement('option');
            option.value = index;
            option.textContent = `Question ${index + 1}: ${question.prompt.substring(0, 50)}${question.prompt.length > 50 ? '...' : ''}`;
            selector.appendChild(option);
        });
        
        console.log('✅ Populated grading question selector with', questions.length, 'questions');
    } catch (error) {
        console.error('❌ Error populating question selector:', error);
    }
}

function onGradingQuestionSelect(event) {
    try {
        const questionIndex = parseInt(event.target.value);
        
        if (isNaN(questionIndex)) {
            resetGradingModal();
            return;
        }
        
        console.log('🎯 Selected question for grading:', questionIndex);
        
        // Show question display
        const questionDisplay = document.getElementById('gradingQuestionDisplay');
        const questionText = document.getElementById('gradingQuestionText');
        const questionNumber = document.getElementById('gradingQuestionNumber');
        const answerCount = document.getElementById('gradingAnswerCount');
        
        if (!questionDisplay || !questionText || !questionNumber || !answerCount) {
            console.error('❌ Required grading modal elements not found');
            return;
        }
        
        // Use the questions stored for grading (check both variable names)
        const questions = window.currentGradingQuestions || window.gradingQuestions || [];
        
        
        const question = questions[questionIndex];
        if (!question) {
            console.error('❌ Question not found at index:', questionIndex);
            return;
        }
        
        questionText.textContent = question.prompt;
        questionNumber.textContent = `Question ${questionIndex + 1}`;
        
        // Use real player data instead of test data
        answerCount.textContent = '0 answers (waiting for player submissions)';
        
        questionDisplay.style.display = 'block';
        
        const noQuestionMessage = document.getElementById('gradingNoQuestionMessage');
        if (noQuestionMessage) noQuestionMessage.style.display = 'none';
        
        // Show message that real player data is required
        showSimpleGradingInterface(questionIndex, []);
        
    } catch (error) {
        console.error('❌ Error selecting grading question:', error);
        showError('Failed to load question for grading');
    }
}

function showSimpleGradingInterface(questionIndex, testAnswers) {
    try {
        const categorizationElement = document.getElementById('gradingAnswerCategorization');
        if (!categorizationElement) {
            console.error('❌ Grading categorization element not found');
            return;
        }
        
        // Get the selected question (check both variable names)
        const questions = window.currentGradingQuestions || window.gradingQuestions || [];
        const selectedQuestion = questions[questionIndex];
        
        if (!selectedQuestion) {
            console.error('❌ Selected question not found');
            return;
        }
        
        console.log('🎯 Setting up grading interface for question:', selectedQuestion.prompt);
        
        // Initialize grading categorization state
        window.gradingCategorization = {
            correctAnswerBuckets: [],
            uncategorizedAnswers: [],
            wrongAnswers: [],
            categorizedAnswers: {},
            customBuckets: []
        };
        
        // Create buckets for each correct answer
        const correctAnswers = selectedQuestion.correct_answers || [];
        correctAnswers.forEach((correctAnswer, index) => {
            const bucketId = `grading_correct_${index}`;
            const bucket = {
                id: bucketId,
                name: correctAnswer,
                correctAnswer: correctAnswer,
                answers: []
            };
            window.gradingCategorization.correctAnswerBuckets.push(bucket);
        });
        
        // Sort buckets alphabetically by name
        window.gradingCategorization.correctAnswerBuckets.sort((a, b) => a.name.localeCompare(b.name));
        
        // Handle real player data vs test data
        if (testAnswers.length === 0) {
            // Show message that real player data is required
            categorizationElement.innerHTML = `
                <div style="text-align: center; padding: 40px; background: rgba(255, 193, 7, 0.1); border: 2px solid #ffc107; border-radius: 8px; margin: 20px 0;">
                    <h3>🎯 Ready for Grading</h3>
                    <p><strong>Question:</strong> ${selectedQuestion.prompt}</p>
                    <p><strong>Correct Answers:</strong> ${correctAnswers.join(', ')}</p>
                    <p><strong>Status:</strong> Waiting for player submissions...</p>
                    <p>Players need to submit answers to this question before grading can begin.</p>
                </div>
            `;
        } else {
            // Auto-categorize test answers with fuzzy matching
            const uncategorized = [];
            testAnswers.forEach(answerGroup => {
                const matchingBucket = findBestMatchingBucket(answerGroup.answer, window.gradingCategorization.correctAnswerBuckets);
                
                if (matchingBucket) {
                    matchingBucket.answers.push(answerGroup);
                    window.gradingCategorization.categorizedAnswers[answerGroup.answer] = matchingBucket.id;
                    console.log(`🎯 Auto-categorized "${answerGroup.answer}" → "${matchingBucket.correctAnswer}" (normalized: "${answerGroup.answer.toLowerCase().replace(/[.,!?;:'"()\[\]{}@#$%^&*+=|\\/<>~`]/g, '').replace(/\s+/g, '')}" → "${matchingBucket.correctAnswer.toLowerCase().replace(/[.,!?;:'"()\[\]{}@#$%^&*+=|\\/<>~`]/g, '').replace(/\s+/g, '')}")`);
                } else {
                    uncategorized.push(answerGroup);
                    console.log(`❓ Left uncategorized: "${answerGroup.answer}"`);
                }
            });
            
            window.gradingCategorization.uncategorizedAnswers = uncategorized;
            
            // Render the full categorization interface
            renderGradingCategorizationInterface();
            
            // Setup drag and drop for grading
            setupGradingDragAndDrop();
        }
        
        categorizationElement.style.display = 'block';
        
    } catch (error) {
        console.error('❌ Error showing grading interface:', error);
    }
}

function renderGradingCategorizationInterface() {
    const container = document.getElementById('gradingAnswerCategorization');
    if (!container) return;
    
    const categorization = window.gradingCategorization;
    if (!categorization) return;
    
    container.innerHTML = `
        <div class="grading-categorization-interface">
            <h4>📝 Answer Categorization</h4>
            <p class="categorization-instructions">Drag answers to the correct buckets. Auto-matched answers are already categorized.</p>
            
            <div class="categorization-container">
                <!-- Correct Answer Buckets -->
                <div class="correct-answer-buckets-section">
                    <h4>✅ Correct Answer Buckets</h4>
                    <div id="gradingCorrectAnswerBuckets" class="correct-answer-buckets">
                        ${categorization.correctAnswerBuckets
                            .sort((a, b) => a.name.localeCompare(b.name))
                            .map(bucket => `
                            <div class="answer-bucket correct-answer-bucket collapsed" data-bucket="${bucket.id}">
                                <h5 class="bucket-header" onclick="toggleBucketCollapse(this.parentElement)">
                                    <span class="bucket-toggle">▼</span>
                                    ✅ ${bucket.name}
                                    <span class="bucket-count">(${bucket.answers.length})</span>
                                </h5>
                                <div class="answer-items bucket-content" data-bucket="${bucket.id}">
                                    ${bucket.answers
                                        .map(answer => {
                                            const confidence = calculateAnswerConfidence(answer.answer, bucket.id);
                                            return { ...answer, confidence };
                                        })
                                        .sort((a, b) => b.confidence - a.confidence)
                                        .map(answer => {
                                            const confidenceClass = getConfidenceColorClass(answer.confidence);
                                            return `
                                                <div class="answer-item ${confidenceClass}" draggable="true" data-answer="${answer.answer}" oncontextmenu="handleGradingRightClick(event)">
                                                    <span class="answer-text">"${answer.answer}"</span>
                                                    <span class="answer-count">(${answer.count} responses)</span>
                                                    <span class="confidence-indicator">${answer.confidence}%</span>
                                                </div>
                                            `;
                                        }).join('')}
                                </div>
                            </div>
                        `).join('')}
                    </div>
                </div>
                
                <!-- Uncategorized Answers -->
                <div class="answer-bucket uncategorized-bucket">
                    <h4>📝 Uncategorized Answers <span class="bucket-count">(${categorization.uncategorizedAnswers.length})</span></h4>
                    <div id="gradingUncategorizedAnswers" class="answer-items" data-bucket="uncategorized">
                        ${categorization.uncategorizedAnswers
                            .map(answer => {
                                // Find best matching bucket for confidence calculation
                                let bestConfidence = 0;
                                let bestBucketId = null;
                                
                                categorization.correctAnswerBuckets.forEach(bucket => {
                                    const confidence = calculateAnswerConfidence(answer.answer, bucket.id);
                                    if (confidence > bestConfidence) {
                                        bestConfidence = confidence;
                                        bestBucketId = bucket.id;
                                    }
                                });
                                
                                return { ...answer, confidence: bestConfidence };
                            })
                            .sort((a, b) => b.confidence - a.confidence)
                            .map(answer => {
                                const confidenceClass = getConfidenceColorClass(answer.confidence);
                                return `
                                    <div class="answer-item ${confidenceClass}" draggable="true" data-answer="${answer.answer}" oncontextmenu="handleGradingRightClick(event)">
                                        <span class="answer-text">"${answer.answer}"</span>
                                        <span class="answer-count">(${answer.count} responses)</span>
                                        <span class="confidence-indicator">${answer.confidence}%</span>
                                    </div>
                                `;
                            }).join('')}
                    </div>
                </div>
                
                <!-- Wrong Answers Bucket -->
                <div class="answer-bucket wrong-bucket collapsed" data-bucket="wrong">
                    <h4 class="bucket-header" onclick="toggleBucketCollapse(this.parentElement)">
                        <span class="bucket-toggle">▼</span>
                        ❌ Wrong Answers
                        <span class="bucket-count">(0)</span>
                    </h4>
                    <div id="gradingWrongAnswers" class="answer-items bucket-content" data-bucket="wrong">
                        <!-- Wrong answers will be dropped here -->
                    </div>
                </div>
            </div>
            
            <div class="grading-actions-footer">
                <div class="real-time-status">
                    <span class="real-time-indicator">🟢 Real-time collaboration enabled</span>
                    <span class="grader-count">(1 grader)</span>
                </div>
                <div class="grading-buttons">
                    <button onclick="expandAllBuckets()" class="btn btn-info">Expand All Buckets</button>
                    <button onclick="closeGradingModal()" class="btn btn-secondary">Close</button>
                    <button onclick="saveGradingResults()" class="btn btn-primary">Save Results</button>
                </div>
            </div>
        </div>
    `;
}

function setupGradingDragAndDrop() {
    const answerItems = document.querySelectorAll('#gradingAnswerCategorization .answer-item');
    const dropZones = document.querySelectorAll('#gradingAnswerCategorization .answer-bucket');
    
    answerItems.forEach(item => {
        item.addEventListener('dragstart', handleGradingDragStart);
        item.addEventListener('dragend', handleGradingDragEnd);
        item.addEventListener('contextmenu', handleGradingRightClick);
    });
    
    dropZones.forEach(zone => {
        zone.addEventListener('dragover', handleGradingDragOver);
        zone.addEventListener('drop', handleGradingDrop);
    });
}

function handleGradingDragStart(e) {
    e.dataTransfer.setData('text/plain', e.target.dataset.answer);
    e.target.classList.add('dragging');
}

function handleGradingDragEnd(e) {
    e.target.classList.remove('dragging');
}

function handleGradingRightClick(e) {
    e.preventDefault(); // Prevent default context menu
    
    const answerText = e.target.closest('.answer-item').dataset.answer;
    console.log(`🖱️ Right-clicked "${answerText}" - moving to wrong answers`);
    
    // Find the wrong answers bucket
    const wrongAnswersContainer = document.getElementById('gradingWrongAnswers');
    if (wrongAnswersContainer) {
        // Move the answer item to wrong answers
        const answerItem = e.target.closest('.answer-item');
        wrongAnswersContainer.appendChild(answerItem);
        
        // Update the categorization state
        updateGradingCategorization(answerText, 'wrong');
        
        // Send real-time update to other graders
        categorizeAnswerRealTime(answerText, 'wrong');
        
        // Update bucket counts
        updateAllBucketCounts();
        
        // Visual feedback
        answerItem.style.background = 'rgba(244, 67, 54, 0.2)';
        setTimeout(() => {
            answerItem.style.background = '';
        }, 500);
    }
}

function handleGradingDragOver(e) {
    e.preventDefault();
    e.currentTarget.classList.add('drag-over');
}

function handleGradingDrop(e) {
    e.preventDefault();
    e.currentTarget.classList.remove('drag-over');
    
    const answerText = e.dataTransfer.getData('text/plain');
    const targetBucket = e.currentTarget.dataset.bucket;
    
    console.log(`🎯 Moving "${answerText}" to bucket: ${targetBucket}`);
    
    // Move the answer item to the new bucket's content area
    const answerItem = document.querySelector(`[data-answer="${answerText}"]`);
    if (answerItem) {
        // Find the content area within this bucket
        const contentArea = e.currentTarget.querySelector('.answer-items');
        if (contentArea) {
            contentArea.appendChild(answerItem);
        } else {
            // Fallback to the bucket itself
            e.currentTarget.appendChild(answerItem);
        }
        
        // Update the categorization state
        updateGradingCategorization(answerText, targetBucket);
        
        // Send real-time update to other graders
        categorizeAnswerRealTime(answerText, targetBucket);
        
        // Update bucket counts
        updateAllBucketCounts();
    }
}

function updateGradingCategorization(answerText, targetBucket) {
    const categorization = window.gradingCategorization;
    if (!categorization) return;
    
    // Remove from previous bucket
    Object.keys(categorization.categorizedAnswers).forEach(key => {
        if (key === answerText) {
            delete categorization.categorizedAnswers[key];
        }
    });
    
    // Add to new bucket
    if (targetBucket === 'wrong') {
        categorization.wrongAnswers.push({ answer: answerText, count: 1 });
    } else if (targetBucket.startsWith('grading_correct_')) {
        categorization.categorizedAnswers[answerText] = targetBucket;
        const bucketIndex = parseInt(targetBucket.split('_')[2]);
        if (categorization.correctAnswerBuckets[bucketIndex]) {
            categorization.correctAnswerBuckets[bucketIndex].answers.push({ answer: answerText, count: 1 });
        }
    }
}

// Simplified grading functions - removed complex categorization to prevent freezing

// Removed complex grading functions to prevent freezing

function markGradingAnswerAs(answerText, type) {
    try {
        console.log('✅ Marked answer as', type, ':', answerText);
        
        // Store the grading result
        if (!answerCategorization.gradingResults) {
            answerCategorization.gradingResults = {};
        }
        
        const questionIndex = answerCategorization.currentQuestionIndex;
        if (questionIndex !== undefined) {
            if (!answerCategorization.gradingResults[questionIndex]) {
                answerCategorization.gradingResults[questionIndex] = {};
            }
            answerCategorization.gradingResults[questionIndex][answerText] = type;
        }
        
        // Visual feedback
        const button = event.target;
        const answerItem = button.closest('.grading-answer-item');
        if (answerItem) {
            answerItem.classList.remove('correct', 'incorrect');
            answerItem.classList.add(type);
            
            // Disable both buttons
            const buttons = answerItem.querySelectorAll('button');
            buttons.forEach(btn => btn.disabled = true);
            
            // Show checkmark
            const checkmark = document.createElement('span');
            checkmark.className = 'grading-checkmark';
            checkmark.textContent = type === 'correct' ? '✅' : '❌';
            answerItem.appendChild(checkmark);
        }
        
    } catch (error) {
        console.error('❌ Error marking answer:', error);
    }
}

function saveGradingResults() {
    try {
        console.log('💾 Saving grading results...');
        
        if (answerCategorization.gradingResults) {
            // Here you would save the results to your database
            console.log('📊 Grading results:', answerCategorization.gradingResults);
            showSuccess('Grading results saved successfully!');
        } else {
            showError('No grading results to save');
        }
        
        // Close the modal
        closeGradingModal();
        
    } catch (error) {
        console.error('❌ Error saving grading results:', error);
        showError('Failed to save grading results');
    }
}

function showInfo(message) {
    const infoDiv = document.createElement('div');
    infoDiv.className = 'info-message';
    infoDiv.innerHTML = `
        <div class="message-content">
            <span class="message-icon">ℹ️</span>
            <span class="message-text">${message}</span>
            <button class="message-close" onclick="this.parentElement.parentElement.remove()">×</button>
        </div>
    `;
    
    document.body.appendChild(infoDiv);
    
    // Auto-remove after 8 seconds
    setTimeout(() => {
        if (infoDiv.parentElement) {
            infoDiv.remove();
        }
    }, 8000);
}

function copyGameCode() {
    const gameCode = document.getElementById('gameCodeText').textContent;
    navigator.clipboard.writeText(gameCode).then(() => {
        showSuccess(`Game code ${gameCode} copied to clipboard!`);
    }).catch(() => {
        showError('Failed to copy game code. Please copy it manually.');
    });
}

// Virtual player testing system
const virtualPlayerNames = [
    "Emma Thompson", "James Wilson", "Sophia Rodriguez", "Michael Chen", "Olivia Davis",
    "David Martinez", "Ava Johnson", "Christopher Lee", "Isabella Brown", "Daniel Garcia",
    "Mia Anderson", "Matthew Taylor", "Charlotte White", "Andrew Clark", "Amelia Hall",
    "Joshua Lewis", "Harper Walker", "Ryan Allen", "Evelyn Young", "Nathan King",
    "Abigail Wright", "Tyler Green", "Emily Baker", "Kevin Adams", "Sofia Nelson",
    "Justin Carter", "Avery Mitchell", "Brandon Perez", "Ella Roberts", "Steven Turner",
    "Madison Phillips", "Jonathan Campbell", "Scarlett Parker", "Robert Evans", "Grace Edwards",
    "Thomas Collins", "Chloe Stewart", "Samuel Morris", "Lily Rogers", "Benjamin Cook",
    "Hannah Morgan", "Christian Reed", "Layla Bell", "Isaac Murphy", "Riley Bailey",
    "Jack Cooper", "Zoe Richardson", "Owen Cox", "Nora Howard", "Gavin Ward",
    "Luna Torres", "Caleb Peterson", "Violet Gray", "Isaac Ramirez", "Penelope James",
    "Mason Watson", "Hazel Brooks", "Ethan Kelly", "Aurora Sanders", "Logan Price"
];

let virtualPlayers = [];
let virtualPlayerInterval = null;
let virtualResponseInterval = null;
let questionCount = 0;
let isVirtualTestingMode = false;

// Normalize a question object from server/demo formats
function getAnswerSetsFromQuestion(question) {
    const correct = (question?.correct_answers) || (question?.correctAnswers) || [];
    const fallbackWrong = ['idk', 'unknown', 'pass', 'no idea'];
    const wrong = (question?.incorrect_answers) || (question?.incorrectAnswers) || fallbackWrong;
    return { correctAnswers: correct, incorrectAnswers: wrong };
}

function scheduleVirtualQuestionFlow() {
    if (!isVirtualTestingMode || !isHost) return;
    try {
        const q = (questions && questions.length)
            ? (questions[currentQuestionIndex] || questions[0])
            : (gameState?.questions?.[gameState.currentQuestion] || gameState?.currentQuestion || null);
        if (!q) return;
        setTimeout(() => { try { generateVirtualResponses(q); } catch (_) {} }, 1000);
        setTimeout(() => {
            try {
                if (gameState?.gameCode && socket) {
                    socket.emit('endQuestion', { gameCode: gameState.gameCode });
                }
            } catch (_) {}
        }, 6500);
    } catch (e) { console.warn('Virtual question flow error', e); }
}

function startVirtualPlayerSimulation(playerCount = 50) {
    console.log('🎭 Starting virtual player simulation via server...', { playerCount });
    isVirtualTestingMode = true;
    virtualPlayers = [];
    questionCount = 0;
    if (!socket || !gameState?.gameCode) {
        console.warn('⚠️ Cannot start virtual simulation: missing socket or gameCode');
        return;
    }
    // Ask the server to add virtual players to the real game
    socket.emit('startVirtualPlayerSimulation', { gameCode: gameState.gameCode, playerCount });
    // Also stream joins individually to ensure visible increments even if batch add is fast
    const joinPerSecond = 2; // visible join cadence
    const total = playerCount;
    let added = 0;
    const joinTimer = setInterval(() => {
        if (added >= total) return clearInterval(joinTimer);
        const idx = added % virtualPlayerNames.length;
        const full = virtualPlayerNames[idx];
        const suffix = (Math.floor(added/virtualPlayerNames.length)+1);
        const playerName = suffix > 1 ? `${full} ${suffix}` : full; // First Last [+ cohort]
        const playerId = `virtual_${Date.now()}_${added}`;
        socket.emit('virtualPlayerJoined', { gameCode: gameState.gameCode, playerId, playerName });
        added += 1;
    }, 1000 / joinPerSecond);
}

function generateVirtualResponses(question) {
    console.log('🤖 Generating virtual responses...');
    
    if (!gameState || !gameState.players) return;
    
    const virtualPlayers = (gameState.players || []).filter(p => p.isVirtual);
    const responses = [];
    
    // Define response patterns for this question (normalized)
    const sets = getAnswerSetsFromQuestion(question);
    const correctAnswers = sets.correctAnswers.length ? sets.correctAnswers : ['correct answer'];
    const incorrectAnswers = sets.incorrectAnswers.length ? sets.incorrectAnswers : ['wrong answer'];
    
    virtualPlayers.forEach((player, index) => {
        // Determine response type based on player index
        let response;
        let isCorrect = false;
        
        if (index < 45) { // 75% give correct answers
            response = correctAnswers[Math.floor(Math.random() * correctAnswers.length)];
            isCorrect = true;
            
            // 20% of correct answers get slight modifications for manual grading practice
            if (index < 9 && Math.random() < 0.8) {
                response = modifyAnswerForGrading(response);
            }
        } else { // 25% give incorrect answers
            response = incorrectAnswers[Math.floor(Math.random() * incorrectAnswers.length)];
            isCorrect = false;
        }
        
        responses.push({
            playerId: player.id,
            playerName: player.name,
            answer: response,
            isCorrect: isCorrect,
            timestamp: Date.now() + Math.random() * 5000 // Spread over 5 seconds
        });
    });
    
    // Simulate responses coming in over time
    responses.forEach((response, index) => {
        setTimeout(() => {
            if (gameState && gameState.currentQuestion) {
                // Add to gameState responses
                if (!gameState.responses) gameState.responses = [];
                gameState.responses.push(response);
                
                // Emit to server as virtual answer (server handles mapping by playerId)
                if (socket && gameState?.gameCode) {
                    socket.emit('virtualAnswerSubmitted', {
                        gameCode: gameState.gameCode,
                        playerId: response.playerId,
                        playerName: response.playerName,
                        answer: response.answer,
                        isCorrect: response.isCorrect
                    });
                }
            }
        }, response.timestamp - Date.now());
    });
    
    console.log(`📝 Generated ${responses.length} virtual responses`);
    return responses;
}

function modifyAnswerForGrading(answer) {
    const modifications = [
        answer + ' (slight variation)',
        answer.toLowerCase(),
        answer.toUpperCase(),
        answer + '!',
        answer + '?',
        answer.replace(/[aeiou]/g, 'x'), // Replace vowels with x
        answer.split('').reverse().join(''), // Reverse the answer
        answer + ' with extra text',
        answer.replace(/\s+/g, ' ').trim(), // Normalize spacing
        answer + ' - modified'
    ];
    
    return modifications[Math.floor(Math.random() * modifications.length)];
}

function simulateQuestionCycle() {
    if (!gameState) return;
    
    questionCount++;
    console.log(`🎯 Starting question ${questionCount}`);
    
    // Generate virtual responses
    const responses = generateVirtualResponses(gameState.currentQuestion);
    
    // After 5 seconds, move to grading phase
    setTimeout(() => {
        if (gameState && gameState.gameState === 'waiting') {
            gameState.gameState = 'grading';
            showGradingScreen();
        }
    }, 5000);
}

// Enhanced question cycle with 5-question rounds
// REMOVED: Duplicate handleQuestionComplete function that was overriding the main event handler

// Enhanced grading completion
function finishGrading() {
    if (gameState && gameState.gameState === 'grading') {
        gameState.gameState = 'waiting';
        showWaitingScreen();
        console.log('✅ Grading completed');
        
        // Automatically move to next question or round
        setTimeout(() => {
            // Use the main handleQuestionComplete function instead of the duplicate
            if (questionCount >= 5) {
                // Show round leaderboard after 5 questions
                showRoundLeaderboard();
            } else {
                // Continue to next question
                setTimeout(() => {
                    if (gameState && gameState.gameState === 'waiting') {
                        simulateQuestionCycle();
                    }
                }, 3000); // 3 second delay between questions
            }
        }, 2000); // 2 second delay before next question
    }
}

// Test function to start the full simulation from host interface
function startFullGameSimulation() {
    console.log('🎮 Starting full game simulation from host interface...');
    
    // Only work if we're the host
    if (!isHost) {
        console.error('❌ Only the host can start virtual testing');
        return;
    }
    
    // Flag testing mode
    isVirtualTestingMode = true;
    
    // Start virtual player simulation
    startVirtualPlayerSimulation();
    
    // Update the lobby display
    updateLobbyDisplay();
    
    console.log('✅ Full game simulation started. Use these commands:');
    console.log('  startGame() - Start the game');
    console.log('  nextQuestion() - Move to next question');
    console.log('  finishGrading() - Complete grading phase');
}

// Enhanced virtual response generation that works with socket
function generateVirtualResponses(question) {
    console.log('🤖 Generating virtual responses...');
    
    if (!gameState || !gameState.players) return;
    
    const virtualPlayers = gameState.players.filter(p => p.isVirtual);
    const responses = [];
    
    // Define response patterns for this question
    const correctAnswers = question.correctAnswers || ['correct answer'];
    const incorrectAnswers = question.incorrectAnswers || ['wrong answer', 'incorrect response'];
    
    virtualPlayers.forEach((player, index) => {
        // Determine response type based on player index
        let response;
        let isCorrect = false;
        
        if (index < 45) { // 75% give correct answers
            response = correctAnswers[Math.floor(Math.random() * correctAnswers.length)];
            isCorrect = true;
            
            // 20% of correct answers get slight modifications for manual grading practice
            if (index < 9 && Math.random() < 0.8) {
                response = modifyAnswerForGrading(response);
            }
        } else { // 25% give incorrect answers
            response = incorrectAnswers[Math.floor(Math.random() * incorrectAnswers.length)];
            isCorrect = false;
        }
        
        responses.push({
            playerId: player.id,
            playerName: player.name,
            answer: response,
            isCorrect: isCorrect,
            timestamp: Date.now() + Math.random() * 5000 // Spread over 5 seconds
        });
    });
    
    // Simulate responses coming in over time
    responses.forEach((response, index) => {
        setTimeout(() => {
            if (gameState && gameState.currentQuestion) {
                // Add to gameState responses
                if (!gameState.responses) gameState.responses = [];
                gameState.responses.push(response);
                
                // Emit to server if socket is available
                if (socket) {
                    socket.emit('submitAnswer', {
                        answer: response.answer,
                        playerId: response.playerId,
                        playerName: response.playerName,
                        isVirtual: true
                    });
                }
                
                // Update display if we're showing responses
                if (gameState.gameState === 'waiting') {
                    updateLobbyDisplay();
                }
            }
        }, response.timestamp - Date.now());
    });
    
    console.log(`📝 Generated ${responses.length} virtual responses`);
    return responses;
}

// REMOVED: Duplicate helper functions that conflict with main game logic

// REMOVED: Duplicate finishGrading function that conflicts with main game logic

// Add virtual testing button to host interface
function addVirtualTestingButton() {
    const hostActions = document.querySelector('.host-actions');
    if (hostActions && !document.getElementById('virtualTestBtn')) {
        const virtualTestBtn = document.createElement('button');
        virtualTestBtn.id = 'virtualTestBtn';
        virtualTestBtn.className = 'btn btn-warning';
        virtualTestBtn.textContent = '🎭 Virtual Test';
        virtualTestBtn.onclick = startFullGameSimulation;
        hostActions.appendChild(virtualTestBtn);
    }
}

// Make functions globally available
window.startFullGameSimulation = startFullGameSimulation;
    