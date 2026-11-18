/* Shared MEGASheep grading board. Standalone page owns the socket; host Grade tab reuses the host socket. */
(function (global) {
    'use strict';

    function isEmbedded() {
        return !!global.MEGASHEEP_GRADING_EMBEDDED;
    }

        let socket = null;
        let currentGame = null;
        let activeGames = [];
        let draggedElement = null;
        let lastRenderedQuestionIndex = null;
        let gradingDraftEpoch = '';
        const lockstepCtx = { lastSeq: -1, lastEpoch: '' };

        function getCurrentQuestionIndex() {
            const g = currentGame;
            if (!g) return 0;
            if (typeof g.currentQuestion === 'number' && !Number.isNaN(g.currentQuestion)) return g.currentQuestion;
            if (typeof g.currentQuestionIndex === 'number' && !Number.isNaN(g.currentQuestionIndex)) return g.currentQuestionIndex;
            return 0;
        }

        function applyQuestionIndex(data) {
            if (!currentGame || !data) return getCurrentQuestionIndex();
            const incoming = (typeof data.currentQuestion === 'number' && !Number.isNaN(data.currentQuestion))
                ? data.currentQuestion
                : ((typeof data.currentQuestionIndex === 'number' && !Number.isNaN(data.currentQuestionIndex))
                    ? data.currentQuestionIndex
                    : getCurrentQuestionIndex());
            currentGame.currentQuestion = incoming;
            currentGame.currentQuestionIndex = incoming;
            return incoming;
        }

        function discardGradingDraft() {
            gradingDraftEpoch = '';
            lastRenderedQuestionIndex = null;
            try { clearGradingBuckets(); } catch (_) {}
        }

        function closeGradingAfterCommit() {
            if (isEmbedded()) return;
            try {
                if (window.opener && !window.opener.closed) {
                    window.opener.focus();
                    window.close();
                } else if (window.parent && window.parent !== window) {
                    window.parent.postMessage('closeGradingInterface', '*');
                    try { window.close(); } catch (_) {}
                } else {
                    window.location.href = '/host';
                }
            } catch (error) {
                console.error('Error closing grading interface:', error);
                window.location.href = '/host';
            }
        }

        function updatePendingEditsBanner(data) {
            try {
                const pending = Array.isArray(data && data.pendingEdits) ? data.pendingEdits : [];
                if (pending.length > 0) {
                    let notice = document.getElementById('pendingEditsNotice');
                    if (!notice) {
                        notice = document.createElement('div');
                        notice.id = 'pendingEditsNotice';
                        notice.style.cssText = 'margin:8px 0;padding:8px 12px;border:1px solid rgba(241,196,15,.4);background:rgba(241,196,15,.12);border-radius:8px;color:#b9770e;';
                        notice.innerHTML = '<strong>⏳ Pending clarifications:</strong> <span id="pendingEditsList"></span>';
                        document.querySelector('#gradingInterface')?.prepend(notice);
                    }
                    const listEl = document.getElementById('pendingEditsList');
                    if (listEl) {
                        listEl.textContent = pending.map(p => `${p.playerName} ("${p.originalAnswer}")`).join(', ');
                    }
                } else {
                    const notice = document.getElementById('pendingEditsNotice');
                    if (notice && notice.parentNode) notice.parentNode.removeChild(notice);
                }
            } catch (_) {}
        }

        function applyGradingState(packet, source) {
            try {
                const LS = window.MEGASheepLockstep;
                const state = (LS && LS.unwrapGameState) ? LS.unwrapGameState(packet) : packet;
                if (!state || !state.gameCode) return;
                if (currentGame && currentGame.gameCode && state.gameCode !== currentGame.gameCode) return;

                const result = (LS && LS.applyServerState)
                    ? LS.applyServerState(state, lockstepCtx)
                    : { applied: true, epochChanged: true, state };
                if (!result.applied) return;

                currentGame = state;
                applyQuestionIndex(state);
                if (Array.isArray(currentGame.currentAnswerGroups)) {
                    currentGame.currentAnswerGroups = coalesceAnswerGroups(currentGame.currentAnswerGroups);
                } else {
                    currentGame.currentAnswerGroups = [];
                }

                const phase = state.gameState;
                if (phase === 'scoring' || phase === 'roundComplete' || phase === 'overallLeaderboard' || phase === 'finished') {
                    discardGradingDraft();
                    if (!isEmbedded()) closeGradingAfterCommit();
                    return;
                }

                showGradingWorkspace();
                updatePendingEditsBanner(state);

                const incomingEpoch = state.epoch || (LS && LS.gameEpoch
                    ? LS.gameEpoch(state.gameCode, getCurrentQuestionIndex(), phase)
                    : '');
                if (result.epochChanged || (incomingEpoch && incomingEpoch !== gradingDraftEpoch)) {
                    gradingDraftEpoch = incomingEpoch;
                    lastRenderedQuestionIndex = null;
                    clearGradingBuckets();
                    try { updateGradingInterface(true); } catch (e) {
                        console.warn('grading epoch render failed', source, e);
                    }
                    return;
                }

                try { syncMissingAnswerCards(); } catch (_) {}
            } catch (e) {
                console.warn('applyGradingState failed', source, e);
            }
        }

        function clearGradingBuckets() {
            const correctRoot = document.getElementById('correctAnswers');
            const wrongRoot = document.getElementById('wrongAnswers');
            const uncatRoot = document.getElementById('uncategorizedAnswers');
            const sendBackRoot = document.getElementById('sendBackAnswers');
            if (correctRoot) {
                correctRoot.innerHTML = '';
                delete correctRoot.dataset.questionIndex;
            }
            if (wrongRoot) wrongRoot.innerHTML = '';
            if (uncatRoot) uncatRoot.innerHTML = '';
            if (sendBackRoot) sendBackRoot.innerHTML = '';
            const wrongCount = document.getElementById('wrongAnswersCount');
            const uncatCount = document.getElementById('uncategorizedAnswersCount');
            if (wrongCount) wrongCount.textContent = '0';
            if (uncatCount) uncatCount.textContent = '0';
            window.smoothUpdateInitialized = false;
            window.recentCardUpdateAt = 0;
        }

        function markCorrectAnswersQuestion(qIndex) {
            const root = document.getElementById('correctAnswers');
            if (root) root.dataset.questionIndex = String(qIndex);
        }

        function initializeConnection() {
            socket = io({
                transports: ['websocket', 'polling'],
                timeout: 20000,
                forceNew: false,
                reconnection: true,
                reconnectionAttempts: 25,
                reconnectionDelay: 500,
                reconnectionDelayMax: 3000,
                maxReconnectionAttempts: 25,
                autoConnect: true
            });

            // Lightweight Q&A toast for grader
            (function ensureQaToast(){
                if (document.getElementById('graderQaToast')) return;
                const toast = document.createElement('div');
                toast.id = 'graderQaToast';
                toast.style.cssText = 'position:fixed;top:16px;right:16px;max-width:360px;background:rgba(0,0,0,0.85);color:#fff;padding:10px 12px;border-radius:8px;border:1px solid rgba(255,255,255,.15);box-shadow:0 4px 14px rgba(0,0,0,.35);z-index:9999;display:none;font-size:14px;line-height:1.35;';
                toast.innerHTML = '<strong>New player question</strong><div id="graderQaToastText" style="margin-top:4px;opacity:.9;"></div>';
                document.body.appendChild(toast);
            })();

            const showQaToast = (msg) => {
                const toast = document.getElementById('graderQaToast');
                const text = document.getElementById('graderQaToastText');
                if (!toast || !text) return;
                text.textContent = msg;
                toast.style.display = 'block';
                clearTimeout(window.__qaToastTimer);
                window.__qaToastTimer = setTimeout(()=>{ toast.style.display = 'none'; }, 3000);
            };
            
            socket.on('connect', () => {
                updateConnectionStatus(true);
                console.log('🔌 Socket connected, attempting to connect to game');
                
                // Get the game code from the parent window (host.html)
                const gameCode = window.parent.getCurrentGameCode ? window.parent.getCurrentGameCode() : null;
                if (gameCode) {
                    console.log('🎮 Game code from parent window:', gameCode);
                    connectToHostGame(gameCode);
                } else {
                    // Fallback: try to get from URL parameters
                    const urlParams = new URLSearchParams(window.location.search);
                    const gameCodeFromUrl = urlParams.get('gameCode');
                    if (gameCodeFromUrl) {
                        console.log('🎮 Game code from URL:', gameCodeFromUrl);
                        connectToHostGame(gameCodeFromUrl);
                    } else {
                        console.log('⚠️ No game code found, loading active games');
                        loadActiveGames();
                    }
                }
            });
            
            socket.on('disconnect', () => {
                updateConnectionStatus(false);
            });
            
            socket.on('activeGamesUpdate', (games) => {
                activeGames = games;
                updateGameList();
            });
            
            socket.on('state', (data) => applyGradingState(data, 'state'));
            socket.on('gameStateUpdate', (data) => applyGradingState(data, 'gameStateUpdate'));
            socket.on('gameStateResponse', (data) => {
                if (!data || !data.gameCode) {
                    loadActiveGames();
                    return;
                }
                applyGradingState(data, 'gameStateResponse');
            });
            
            socket.on('error', (error) => {
                console.error('Socket error:', error);
                alert('Error: ' + error.message);
            });
            
            socket.on('gradingComplete', (data) => applyGradingState(data, 'gradingComplete'));

            // Q&A: notify grader when a player question arrives
            socket.on('playerQuestion', (payload) => {
                try {
                    if (!payload || !payload.playerName || !payload.question) return;
                    showQaToast(`${payload.playerName}: ${payload.question}`);
                } catch (_) {}
            });

            // Real-time answer updates - Auto-match clarified answers to groups
            socket.on('newAnswerSubmitted', (data) => {
                console.log('📝 New answer submitted:', data);
                console.log('📝 Is clarification:', data.isClarification);
                
                if (!currentGame || data.gameCode !== currentGame.gameCode) {
                    console.log('📝 Ignoring answer for different game');
                    return;
                }
                
                if (currentGame.currentAnswerGroups) {
                    const normalizedNew = String(data.answer || '').toLowerCase().trim();
                    
                    // Locate the group this player currently belongs to (if any)
                    let fromGroupIndex = -1;
                    for (let i = 0; i < currentGame.currentAnswerGroups.length; i++) {
                        const grp = currentGame.currentAnswerGroups[i];
                        if (Array.isArray(grp.players) && grp.players.includes(data.playerName)) {
                            fromGroupIndex = i;
                            break;
                        }
                    }
                    
                    if (fromGroupIndex !== -1) {
                        const fromGroup = currentGame.currentAnswerGroups[fromGroupIndex];
                        const normalizedOld = String(fromGroup.answer || '').toLowerCase().trim();
                        
                        if (normalizedNew !== normalizedOld) {
                            // Move player from old group to the appropriate target group
                            fromGroup.players = fromGroup.players.filter(n => n !== data.playerName);
                            fromGroup.count = fromGroup.players.length;
                            if (fromGroup.count === 0) {
                                currentGame.currentAnswerGroups.splice(fromGroupIndex, 1);
                            }
                            
                            let targetGroup = currentGame.currentAnswerGroups.find(g => String(g.answer || '').toLowerCase().trim() === normalizedNew);
                            if (targetGroup) {
                                if (!targetGroup.players.includes(data.playerName)) {
                                    targetGroup.players.push(data.playerName);
                                    targetGroup.count = targetGroup.players.length;
                                }
                            } else {
                                currentGame.currentAnswerGroups.push({
                                    answer: data.answer,
                                    players: [data.playerName],
                                    count: 1,
                                    points: 0,
                                    index: currentGame.currentAnswerGroups.length
                                });
                            }
                        } else {
                            // Same normalized answer; nothing structural to change
                        }
                    } else {
                        // Player not in any group yet; add to existing matching group or create new
                        let targetGroup = currentGame.currentAnswerGroups.find(g => String(g.answer || '').toLowerCase().trim() === normalizedNew);
                        if (targetGroup) {
                            if (!targetGroup.players.includes(data.playerName)) {
                                targetGroup.players.push(data.playerName);
                                targetGroup.count = targetGroup.players.length;
                            }
                        } else {
                            currentGame.currentAnswerGroups.push({
                                answer: data.answer,
                                players: [data.playerName],
                                count: 1,
                                points: 0,
                                index: currentGame.currentAnswerGroups.length
                            });
                        }
                    }
                    
                    // Sort by player count (most popular first)
                    currentGame.currentAnswerGroups.sort((a, b) => b.count - a.count);
                    
                    // Update the interface immediately (moves card between groups as needed)
                    handleAnswerDirectly(data.playerName, data.answer, data.isClarification === true);
                }
            });

            socket.on('nextQuestion', (data) => applyGradingState(data, 'nextQuestion'));
            socket.on('questionComplete', (data) => applyGradingState(data, 'questionComplete'));
            socket.on('gameStarted', (data) => applyGradingState(data, 'gameStarted'));

            window.addEventListener('message', (event) => {
                const msg = event && event.data;
                if (!msg || msg.type !== 'megasheep-refresh-grading') return;
                const gameCode = msg.gameCode || currentGame?.gameCode;
                if (!gameCode) return;
                if (currentGame && currentGame.gameCode && msg.gameCode && msg.gameCode !== currentGame.gameCode) return;
                if (typeof msg.questionIndex === 'number' && msg.questionIndex !== getCurrentQuestionIndex()) {
                    discardGradingDraft();
                }
                socket.emit('requestState', { gameCode });
                socket.emit('getGameState', { gameCode });
            });
        }

        function showGradingWorkspace() {
            const gradingInterface = document.getElementById('gradingInterface');
            const gameSelection = document.getElementById('gameSelection');
            const noGamesMessage = document.getElementById('noGamesMessage');
            if (gradingInterface) gradingInterface.style.display = 'block';
            if (gameSelection) gameSelection.style.display = 'none';
            if (noGamesMessage) noGamesMessage.style.display = 'none';
        }

        function connectToHostGame(gameCode) {
            if (!gameCode) return;
            console.log('🔗 Connecting to host game:', gameCode);
            socket.emit('joinGameRoom', { gameCode: gameCode });
            socket.emit('requestState', { gameCode: gameCode });
            socket.emit('getGameState', { gameCode: gameCode });
            showGradingWorkspace();
        }

        function updateConnectionStatus(connected) {
            if (isEmbedded()) return;
            const indicator = document.getElementById('connectionIndicator');
            const status = document.getElementById('connectionStatus');
            if (!indicator || !status) return;
            
            if (connected) {
                indicator.className = 'status-indicator status-connected';
                status.textContent = 'Connected to server';
            } else {
                indicator.className = 'status-indicator status-disconnected';
                status.textContent = 'Disconnected from server';
            }
        }

        function loadActiveGames() {
            socket.emit('getActiveGames');
        }

        function updateGameList() {
            const noGamesMessage = document.getElementById('noGamesMessage');
            const gameSelection = document.getElementById('gameSelection');
            const gameList = document.getElementById('gameList');
            
            const gradingGames = activeGames.filter(game => game.gameState === 'grading');
            
            if (gradingGames.length === 0) {
                noGamesMessage.style.display = 'block';
                gameSelection.style.display = 'none';
                return;
            }
            
            noGamesMessage.style.display = 'none';
            gameSelection.style.display = 'block';
            
            gameList.innerHTML = '';
            
            gradingGames.forEach(game => {
                const gameItem = document.createElement('div');
                gameItem.className = 'game-item';
                gameItem.onclick = () => selectGame(game);
                gameItem.innerHTML = `
                    <h4>Game ${game.gameCode}</h4>
                    <p>Host: ${game.hostId}</p>
                    <p>Players: ${game.playerCount || game.players.length}</p>
                    <p>Status: ${game.gameState}</p>
                `;
                gameList.appendChild(gameItem);
            });
        }

        function updateQuestionDisplay() {
            const questionDisplay = document.getElementById('questionDisplay');
            const questionText = document.getElementById('questionText');
            const questionNumber = document.getElementById('questionNumber');
            const answerCount = document.getElementById('answerCount');
            
            if (currentGame && currentGame.currentQuestionData) {
                const questionData = currentGame.currentQuestionData;
                
                // Show question display
                questionDisplay.style.display = 'block';
                
                // Update question text
                questionText.textContent = questionData.prompt || 'No question text available';
                
                // Update question number
                questionNumber.textContent = `Question ${getCurrentQuestionIndex() + 1}`;
                
                // Update answer count (total responses, not unique answer texts)
                const totalResponses = Array.isArray(currentGame.currentAnswerGroups)
                    ? currentGame.currentAnswerGroups.reduce((sum, g) => {
                        if (Array.isArray(g.players)) return sum + g.players.length;
                        if (typeof g.count === 'number') return sum + g.count;
                        return sum;
                    }, 0)
                    : 0;
                answerCount.textContent = `${totalResponses} response${totalResponses !== 1 ? 's' : ''}`;
            } else {
                // Hide question display if no question data
                questionDisplay.style.display = 'none';
            }
        }

        function manualOpenGrading() {
            console.log('🔧 Manual grading interface open requested');
            const urlParams = new URLSearchParams(window.location.search);
            const gameCode = urlParams.get('gameCode');
            if (gameCode) {
                autoOpenGradingInterface(gameCode);
            } else {
                alert('No game code found in URL. Please ensure you accessed this page with a game code.');
            }
        }
        
        function connectToManualGame() {
            const gameCode = document.getElementById('manualGameCode').value.trim();
            if (gameCode) {
                console.log('🔧 Manual game connection requested for:', gameCode);
                connectToHostGame(gameCode);
            } else {
                alert('Please enter a game code');
            }
        }

        function autoOpenGradingInterface(gameCode) {
            console.log('🔄 Auto-opening grading interface for game:', gameCode);
            connectToHostGame(gameCode);
            showGradingWorkspace();
            
            // Focus the window to bring attention to the grading interface
            if (window.focus) {
                window.focus();
            }
            
            // Show a notification if the window is not focused
            if (!document.hasFocus()) {
                // Create a notification sound or visual indicator
                const notification = document.createElement('div');
                notification.style.cssText = `
                    position: fixed;
                    top: 20px;
                    right: 20px;
                    background: #007bff;
                    color: white;
                    padding: 15px 20px;
                    border-radius: 8px;
                    z-index: 10000;
                    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
                    animation: slideIn 0.3s ease-out;
                `;
                notification.innerHTML = `
                    <strong>📝 Grading Required!</strong><br>
                    Question started for Game ${gameCode}
                `;
                document.body.appendChild(notification);
                
                // Remove notification after 5 seconds
                setTimeout(() => {
                    if (notification.parentNode) {
                        notification.parentNode.removeChild(notification);
                    }
                }, 5000);
            }
        }

        function selectGame(game) {
            currentGame = game;
            document.getElementById('gameSelection').style.display = 'none';
            document.getElementById('gradingInterface').style.display = 'block';
            updateGradingInterface().catch(error => {
                console.error('Error updating grading interface:', error);
            });
        }

        // Debounce mechanism to prevent rapid rebuilds
        let updateGradingInterfaceTimeout = null;
        
        async function updateGradingInterface(forceImmediate = false) {
            // CRITICAL DEBUG: Log why function might exit early
            console.log('🔄 updateGradingInterface called - currentGame exists:', !!currentGame);
            console.log('🔄 updateGradingInterface called - currentGame.currentAnswerGroups exists:', !!currentGame?.currentAnswerGroups);
            console.log('🔄 updateGradingInterface called - currentGame.currentAnswerGroups length:', currentGame?.currentAnswerGroups?.length || 0);
            console.log('🔄 updateGradingInterface called - currentGame.currentAnswerGroups value:', currentGame?.currentAnswerGroups);
            
            if (!currentGame) {
                console.log('❌ updateGradingInterface EXITING: No currentGame');
                return;
            }
            
            if (!currentGame.currentAnswerGroups) {
                console.log('❌ updateGradingInterface EXITING: No currentGame.currentAnswerGroups');
                console.log('❌ currentGame properties:', Object.keys(currentGame || {}));
                return;
            }
            
            // If not forcing immediate update, debounce the call
            if (!forceImmediate) {
                if (updateGradingInterfaceTimeout) {
                    console.log('🔄 Debouncing updateGradingInterface call');
                    clearTimeout(updateGradingInterfaceTimeout);
                }
                
                updateGradingInterfaceTimeout = setTimeout(() => {
                    updateGradingInterface(true);
                }, 100); // 100ms debounce
                return;
            }
            
            const qIndex = getCurrentQuestionIndex();
            const questionChanged = lastRenderedQuestionIndex !== qIndex;
            console.log('✅ updateGradingInterface PROCEEDING - question:', qIndex, 'changed:', questionChanged);
            console.log('✅ Current answer groups available:', currentGame.currentAnswerGroups?.length || 0);
            
            clearPreviousGradingStates();
            updateQuestionDisplay();

            if (questionChanged) {
                console.log('🧹 Question changed — wiping leftover buckets before building Q' + (qIndex + 1));
                clearGradingBuckets();
                window.recentCardUpdateAt = 0;
            }

            try { ensureCorrectBucketsExist(); } catch (_) {}

            if (!questionChanged && window.recentCardUpdateAt && Date.now() - window.recentCardUpdateAt < 800) {
                console.log('⏭️ Skipping full rebuild due to recent direct DOM update');
                return;
            }

            // Same question: keep existing cards; fill in any the live event missed.
            if (!questionChanged && lastRenderedQuestionIndex !== null) {
                console.log('⏭️ Same question — not wiping buckets');
                try { syncMissingAnswerCards(); } catch (_) {}
                return;
            }

            lastRenderedQuestionIndex = qIndex;
            markCorrectAnswersQuestion(qIndex);

            if (currentGame.currentAnswerGroups && currentGame.currentAnswerGroups.length > 0) {
                console.log('🔄 Clearing and repopulating interface with', currentGame.currentAnswerGroups.length, 'answer groups');
                clearGradingBuckets();
                markCorrectAnswersQuestion(qIndex);
                await populateGradingInterface();
            } else {
                console.log('🔄 No answer groups yet — current-question buckets only');
                try { ensureCorrectBucketsExist(); } catch (_) {}
            }
        }

        async function updateGradingInterfaceSmoothly() {
            if (!currentGame || !currentGame.currentAnswerGroups) return;
            
            console.log('🔄 Smooth update: updating grading interface for question:', getCurrentQuestionIndex());
            
            // Clear previous question states in case this is triggered by question transition
            clearPreviousGradingStates();
            if (lastRenderedQuestionIndex !== getCurrentQuestionIndex()) {
                clearGradingBuckets();
                lastRenderedQuestionIndex = getCurrentQuestionIndex();
            }
            
            // Update question display
            updateQuestionDisplay();
            
            try { ensureCorrectBucketsExist(); } catch (_) {}
            // Smoothly update only the buckets that need changes
            await updateAnswerBucketsSmoothly();
            
            // Update count badges
            updateCountBadges();
        }
        
        async function updateAnswerBucketsSmoothly() {
            console.log('🔄 updateAnswerBucketsSmoothly called');
            console.log('🔄 currentGame:', currentGame);
            console.log('🔄 currentQuestionData:', currentGame?.currentQuestionData);
            
            if (!currentGame || !currentGame.currentQuestionData) {
                console.log('🔄 Skipping update - no current game or question data');
                return;
            }
            
            const correctAnswers = (currentGame.currentQuestionData.correct_answers || []).slice().sort();
            const correctAnswersContainer = document.getElementById('correctAnswers');
            const uncategorizedContainer = document.getElementById('uncategorizedAnswers');
            
            console.log('🔄 correctAnswers:', correctAnswers);
            console.log('🔄 correctAnswersContainer:', correctAnswersContainer);
            console.log('🔄 uncategorizedContainer:', uncategorizedContainer);
            
            if (!correctAnswersContainer || !uncategorizedContainer) {
                console.log('🔄 Skipping update - missing containers');
                return;
            }
            
            // Check if this is the first real-time update (clear initial buckets)
            if (!window.smoothUpdateInitialized) {
                const hasExistingItems = !!correctAnswersContainer.querySelector('.answer-item');
                console.log('🔄 First real-time update - initial clear?', !hasExistingItems);
                // Only clear if there aren't already answer items (avoid wiping just-added cards)
                if (!hasExistingItems) {
                    correctAnswersContainer.innerHTML = '';
                }
                window.smoothUpdateInitialized = true;
            }
            
            // Get current answer groups
            const answerGroups = currentGame.currentAnswerGroups || [];
            
            // Create a map of answers that should be in correct buckets
            const correctAnswerMap = new Map();
            console.log('🔍 Creating correct answer map:', {
                answerGroups: answerGroups,
                correctAnswers: correctAnswers
            });
            
            // Automatic grouping with proper display - exact matches go into correct buckets
            console.log('✅ Automatic exact matching enabled - exact matches go to correct buckets');
            
            answerGroups.forEach(group => {
                const normalizedAnswer = String(group.answer || '').toLowerCase().trim();
                // Only do exact matching - no semantic matching complexity
                const matchingCorrectAnswer = correctAnswers.find(correct => 
                    String(correct || '').toLowerCase().trim() === normalizedAnswer
                );
                
                console.log(`🔍 Checking answer "${group.answer}":`, {
                    normalizedAnswer,
                    matchingCorrectAnswer,
                    players: group.players,
                    count: group.count,
                    totalResponses: group.totalResponses
                });
                
                if (matchingCorrectAnswer) {
                    // Merge into map (handle potential multiple groups defensively)
                    const existing = correctAnswerMap.get(matchingCorrectAnswer);
                    if (!existing) {
                        correctAnswerMap.set(matchingCorrectAnswer, {
                            answer: group.answer,
                            players: Array.isArray(group.players) ? [...group.players] : [],
                            count: Array.isArray(group.players) ? group.players.length : (group.count || 0),
                            points: group.points || 0
                        });
                    } else {
                        const mergedPlayers = new Set([...(existing.players || []), ...((group.players) || [])]);
                        correctAnswerMap.set(matchingCorrectAnswer, {
                            answer: group.answer,
                            players: Array.from(mergedPlayers),
                            count: Array.from(mergedPlayers).length,
                            points: Math.max(existing.points || 0, group.points || 0)
                        });
                    }
                }
            });
            
            console.log('🔍 Final correct answer map:', Array.from(correctAnswerMap.entries()).map(([key, value]) => ({
                correctAnswer: key,
                answerGroup: JSON.stringify(value)
            })));
            console.log('🔍 All answer groups being processed:', answerGroups);
            
            // Update each correct answer bucket smoothly
            correctAnswers.forEach(correctAnswer => {
                const bucketDomId = `bucket-${correctAnswer.toLowerCase().replace(/\s+/g, '-')}`;
                let bucket = document.getElementById(bucketDomId);
                const answerGroup = correctAnswerMap.get(correctAnswer);
                
                if (answerGroup) {
                    // Answer exists - update or create bucket
                    if (!bucket) {
                        // Create new bucket with smooth animation
                        bucket = createAnswerBucket(correctAnswer, answerGroup);
                        bucket.id = bucketDomId;
                        bucket.style.opacity = '0';
                        bucket.style.transform = 'scale(0.8)';
                        correctAnswersContainer.appendChild(bucket);
                        
                        // Animate in
                        setTimeout(() => {
                            bucket.style.transition = 'all 0.3s ease';
                            bucket.style.opacity = '1';
                            bucket.style.transform = 'scale(1)';
                        }, 10);
                    } else {
                        // Update existing bucket count smoothly and update list
                        const countElement = bucket.querySelector('.answer-count-badge');
                        if (countElement) {
                            const oldCount = parseInt(countElement.textContent) || 0;
                            const newCount = answerGroup.players ? answerGroup.players.length : (answerGroup.count || 0);
                            if (oldCount !== newCount) {
                                countElement.style.transform = 'scale(1.2)';
                                countElement.style.color = '#4CAF50';
                                setTimeout(() => {
                                    countElement.textContent = String(newCount);
                                    countElement.style.transform = 'scale(1)';
                                    countElement.style.color = '';
                                }, 150);
                            }
                        }
                        updateBucketAnswerList(bucket, answerGroup);
                    }
                } else {
                    // No answers for this bucket - ensure it exists with count 0
                    if (!bucket) {
                        bucket = createAnswerBucket(correctAnswer, { count: 0, players: [] });
                        bucket.id = bucketDomId;
                        bucket.style.opacity = '0';
                        bucket.style.transform = 'scale(0.8)';
                        correctAnswersContainer.appendChild(bucket);
                        
                        setTimeout(() => {
                            bucket.style.transition = 'all 0.3s ease';
                            bucket.style.opacity = '1';
                            bucket.style.transform = 'scale(1)';
                        }, 10);
                    }
                }
            });
            
            // Update uncategorized answers
            const uncategorizedAnswers = answerGroups.filter(group => {
                const normalizedAnswer = group.answer.toLowerCase().trim();
                return !correctAnswers.some(correct => 
                    correct.toLowerCase().trim() === normalizedAnswer
                );
            });
            
            // Calculate confidence scores for uncategorized answers in real-time updates
            uncategorizedAnswers.forEach(answerGroup => {
                if (!answerGroup.semanticConfidence) {
                    // Find the best matching correct answer for confidence calculation
                    let bestConfidence = 0;
                    let bestMatch = null;
                    
                    correctAnswers.forEach(correctAnswer => {
                        const confidence = calculateSemanticConfidence(answerGroup.answer, correctAnswer);
                        if (confidence > bestConfidence) {
                            bestConfidence = confidence;
                            bestMatch = correctAnswer;
                        }
                    });
                    
                    // Set confidence data for uncategorized answers
                    answerGroup.semanticConfidence = bestConfidence;
                    answerGroup.semanticMatch = bestMatch;
                    
                    console.log(`🧠 Real-time confidence for uncategorized "${answerGroup.answer}": ${bestConfidence}% → "${bestMatch}"`);
                }
            });
            
            // Clear and repopulate uncategorized (guard against duplicate fills)
            uncategorizedContainer.innerHTML = '';
            window.skipPopulateUncategorized = false;
            await populateUncategorizedAnswers();
            
            // Re-setup drag and drop for all new elements
            setupDragAndDrop();
        }
        
        function createAnswerBucket(correctAnswer, answerGroup) {
            const bucket = document.createElement('div');
            
            // Calculate the correct player count
            let playerCount = 0;
            let playerNames = [];
            
            if (answerGroup.players && Array.isArray(answerGroup.players)) {
                playerCount = answerGroup.players.length;
                playerNames = answerGroup.players;
            } else if (answerGroup.count && typeof answerGroup.count === 'number') {
                // Fallback to count field if players array is not available
                playerCount = answerGroup.count;
                playerNames = answerGroup.players || [];
            } else if (answerGroup.totalResponses && typeof answerGroup.totalResponses === 'number') {
                // Fallback to totalResponses if count is not available
                playerCount = answerGroup.totalResponses;
                playerNames = answerGroup.players || [];
            }
            
            const isEmpty = playerCount === 0;
            
            console.log(`🔢 Creating bucket for ${correctAnswer}:`, {
                players: answerGroup.players,
                playersLength: answerGroup.players ? answerGroup.players.length : 0,
                count: answerGroup.count,
                totalResponses: answerGroup.totalResponses,
                finalPlayerCount: playerCount,
                playerNames: playerNames,
                answerGroup: JSON.stringify(answerGroup)
            });
            
            bucket.className = `answer-bucket correct-bucket${isEmpty ? ' empty' : ''}`;
            bucket.setAttribute('data-bucket-id', `correct_${correctAnswer.toLowerCase().replace(/\s+/g, '_')}`);
            bucket.innerHTML = `
                <h4 onclick="toggleBucket(this)">
                    <span class="bucket-toggle collapsed">▶</span>
                    ${correctAnswer} <span class="answer-count-badge">${playerCount}</span>
                </h4>
                <div class="answer-items collapsed" data-bucket="${correctAnswer.toLowerCase().replace(/\s+/g, '-')}">
                    ${playerCount > 0 ? 
                        createAnswerItemHTML(correctAnswer, playerCount, 100, playerNames.join(', ')) : ''
                    }
                </div>
            `;
            return bucket;
        }
        
        function updateBucketAnswerList(bucket, answerGroup) {
            const answersContainer = bucket.querySelector('.answer-items');
            if (!answersContainer) return;
            
            // Calculate the correct player count (same logic as createAnswerBucket)
            let playerCount = 0;
            let playerNames = [];
            
            if (answerGroup.players && Array.isArray(answerGroup.players)) {
                playerCount = answerGroup.players.length;
                playerNames = answerGroup.players;
            } else if (answerGroup.count && typeof answerGroup.count === 'number') {
                playerCount = answerGroup.count;
                playerNames = answerGroup.players || [];
            } else if (answerGroup.totalResponses && typeof answerGroup.totalResponses === 'number') {
                playerCount = answerGroup.totalResponses;
                playerNames = answerGroup.players || [];
            }
            
            const currentAnswers = Array.from(answersContainer.children).map(item => 
                item.querySelector('.answer-players')?.textContent.trim()
            ).filter(Boolean);
            const newAnswers = playerNames;
            
            // Only update if answers changed
            if (JSON.stringify(currentAnswers) !== JSON.stringify(newAnswers)) {
                answersContainer.innerHTML = playerCount > 0 ? 
                    createAnswerItemHTML(answerGroup.answer, playerCount, answerGroup.semanticConfidence || 100, playerNames.join(', ')) : '';
                
                // Re-setup drag and drop for the updated bucket
                setupDragAndDrop();
            }
        }

        async function populateGradingInterface() {
            
            // Get the current question to access correct answers
            const questionData = currentGame.currentQuestionData;
            const correctAnswerList = questionData?.correct_answers || [];
            
            console.log('🔍 Current question data:', questionData);
            console.log('✅ Correct answers from DB:', correctAnswerList);
            console.log('📊 Current answer groups from server:', currentGame.currentAnswerGroups);
            console.log('🎯 Current question index:', currentGame.currentQuestionIndex);
            
            ensureCorrectBucketsExist();
            
            // CRITICAL DEBUG: Check if answer groups contain old data
            if (currentGame.currentAnswerGroups && currentGame.currentAnswerGroups.length > 0) {
                console.log('⚠️ DEBUGGING ANSWER SOURCE:');
                currentGame.currentAnswerGroups.forEach((group, index) => {
                    console.log(`  Answer ${index + 1}: "${group.answer}" - Players: ${group.players?.join(', ') || 'unknown'} - Count: ${group.count}`);
                });
            }
            
                // Create correct answer buckets and sort alphabetically
            const correctAnswerBuckets = correctAnswerList.map((correctAnswer, index) => ({
                id: `correct_${correctAnswer.toLowerCase().replace(/\s+/g, '_')}`,
                name: correctAnswer,
                correctAnswer: correctAnswer,
                answers: []
            })).sort((a, b) => a.name.localeCompare(b.name));
            
            console.log('📝 Sorted bucket order:', correctAnswerBuckets.map(b => b.name));
            
            // Get responses for semantic matching
                // De-duplicate identical responses so we don't double-create buckets during refresh churn
                const responses = Array.from(new Set((currentGame.currentAnswerGroups || []).map(group => group.answer)));
            const answersToRemove = [];
            
            try {
                // DISABLED: Semantic matching to prevent player name overwrites
                console.log('🚫 Semantic matching disabled');
                throw new Error('Semantic matching disabled');
                
                // Process semantic matches
                semanticMatches.forEach(match => {
                    const answerGroup = (currentGame.currentAnswerGroups || []).find(group => group.answer === match.response);
                    if (!answerGroup) return;
                    
                    if (match.confidence >= 90 && match.best_match) {
                        // Auto-categorize high confidence matches
                        const matchingBucket = correctAnswerBuckets.find(bucket => 
                            bucket.correctAnswer === match.best_match
                        );
                        
                        if (matchingBucket) {
                            // Add semantic confidence info to the answer group
                            answerGroup.semanticConfidence = match.confidence;
                            answerGroup.semanticMatch = match.best_match;
                            
                            matchingBucket.answers.push(answerGroup);
                            answersToRemove.push(answerGroup.answer);
                            console.log(`✅ Auto-categorized "${answerGroup.answer}" to "${matchingBucket.name}" (${match.confidence}% confidence)`);
                        }
                    } else if (match.confidence >= 50) {
                        // Add confidence info for medium confidence matches
                        answerGroup.semanticConfidence = match.confidence;
                        answerGroup.semanticMatch = match.best_match;
                        console.log(`⚠️ Medium confidence: "${answerGroup.answer}" -> "${match.best_match}" (${match.confidence}%)`);
                    }
                });
                
            } catch (error) {
                console.log('🚫 Semantic matching disabled to prevent player name overwrites');
                console.log('🔧 Using simple exact matching only');
                
                // Fallback to local semantic matching
                (currentGame.currentAnswerGroups || []).forEach(answerGroup => {
                    let bestMatch = null;
                    let bestConfidence = 0;
                    
                    // Try each correct answer
                    // Sort buckets alphabetically before rendering
            correctAnswerBuckets.sort((a, b) => a.name.localeCompare(b.name));
            correctAnswerBuckets.forEach(bucket => {
                        const confidence = calculateSemanticConfidence(answerGroup.answer, bucket.correctAnswer);
                        if (confidence > bestConfidence) {
                            bestConfidence = confidence;
                            bestMatch = bucket;
                        }
                    });
                    
                    // SURGICAL FIX: Disable all auto-categorization to prevent rendering issues
                    // Keep confidence calculation for informational purposes only
                    if (bestMatch && bestConfidence >= 90) {
                        answerGroup.semanticConfidence = bestConfidence;
                        answerGroup.semanticMatch = bestMatch.correctAnswer;
                        console.log(`🧠 High confidence detected: "${answerGroup.answer}" → "${bestMatch.correctAnswer}" (${bestConfidence}%) - manual categorization required`);
                    } else if (bestMatch && bestConfidence >= 70) {
                        // Medium confidence - just add confidence info but don't auto-categorize
                        answerGroup.semanticConfidence = bestConfidence;
                        answerGroup.semanticMatch = bestMatch.correctAnswer;
                        console.log(`⚠️ Medium confidence: "${answerGroup.answer}" → "${bestMatch.correctAnswer}" (${bestConfidence}%) - manual review needed`);
                    }
                });
            }
            
            // CRITICAL FIX: Update existing buckets instead of clearing and rebuilding
            // This prevents answers from disappearing when buckets already exist
            const correctAnswersRoot = document.getElementById('correctAnswers');
            if (!correctAnswersRoot) {
                console.error('❌ Correct answers container not found');
                return;
            }
            
            // Sort buckets alphabetically before rendering  
            correctAnswerBuckets.sort((a, b) => a.name.localeCompare(b.name));
            
            // Check if we already have buckets created (to avoid clearing them)
            const existingBuckets = correctAnswersRoot.children.length > 0
                && correctAnswersRoot.dataset.questionIndex === String(getCurrentQuestionIndex());
            console.log('🎯 Existing buckets found:', existingBuckets);
            console.log('🎯 Processing', correctAnswerBuckets.length, 'correct answer buckets');
            
            if (!existingBuckets) {
                // Only clear if we don't have existing buckets
                correctAnswersRoot.innerHTML = '';
                console.log('🎯 Creating new buckets from scratch');
            } else {
                console.log('🎯 Updating existing buckets with new answers');
                // Use the smooth update function instead of rebuilding everything
                updateAnswerBucketsSmoothly(correctAnswerBuckets);
                return; // Exit early to avoid recreating buckets
            }
            correctAnswerBuckets.forEach(bucket => {
                const bucketDiv = document.createElement('div');
                const bucketId = `bucket-${bucket.name.toLowerCase().replace(/\s+/g, '-')}`;
                
                // Calculate total player count for this bucket
                let totalPlayerCount = 0;
                bucket.answers.forEach(answerGroup => {
                    if (answerGroup.players && Array.isArray(answerGroup.players)) {
                        totalPlayerCount += answerGroup.players.length;
                    } else if (answerGroup.count && typeof answerGroup.count === 'number') {
                        totalPlayerCount += answerGroup.count;
                    } else if (answerGroup.totalResponses && typeof answerGroup.totalResponses === 'number') {
                        totalPlayerCount += answerGroup.totalResponses;
                    }
                });
                
                const isEmpty = totalPlayerCount === 0;
                bucketDiv.className = `answer-bucket correct-bucket${isEmpty ? ' empty' : ''}`;
                bucketDiv.id = bucketId; // align with updateAnswerBucketsSmoothly to avoid duplicates
                bucketDiv.dataset.bucketId = bucket.id;
                bucketDiv.innerHTML = `
                    <h4 onclick="toggleBucket(this)">
                        <span class="bucket-toggle collapsed">▶</span>
                        ${bucket.name}
                        <span class="answer-count-badge">${totalPlayerCount}</span>
                    </h4>
                    <div class="answer-items collapsed" data-bucket="${bucket.id}">
                        ${bucket.answers.map(group => {
                            const playerCount = group.players ? group.players.length : group.count || 1;
                            const playerNames = group.players ? group.players.join(', ') : '';
                            return createAnswerItemHTML(group.answer, playerCount, group.semanticConfidence, playerNames);
                        }).join('')}
                    </div>
                `;
                document.getElementById('correctAnswers').appendChild(bucketDiv);
            });
            
            // Populate uncategorized answers (non-matching)
            await populateUncategorizedAnswers(answersToRemove);
            
            // Update count badges
            updateCountBadges();
            
            // Setup drag and drop for all elements (rebind once)
            setupDragAndDrop();
            
                    // Restore saved grading state if available
        setTimeout(() => {
            console.log('🔄 setTimeout triggered for state restoration after 100ms');
            console.log('🔄 Current question:', currentGame?.currentQuestionIndex);
            console.log('🔄 Skip restoration flag:', window.skipStateRestoration);
            
            const restored = restoreGradingState();
            if (restored) {
                // State was restored - clear any duplicates and skip repopulation
                console.log('💾 State restored - cleaning up duplicates');
                removeDuplicateAnswers();
                window.skipPopulateUncategorized = true;
                setTimeout(() => {
                    window.skipPopulateUncategorized = false;
                }, 1000);
            } else {
                // No saved state - save the initial auto-categorized state
                console.log('💾 No state restored - will save fresh state in 500ms');
                setTimeout(() => {
                    console.log('💾 Saving fresh grading state');
                    saveGradingState();
                }, 500);
            }
        }, 100);
        }

        function ensureCorrectBucketsExist() {
            const questionData = currentGame?.currentQuestionData;
            const correctAnswerList = questionData?.correct_answers || [];
            const correctAnswersRoot = document.getElementById('correctAnswers');
            if (!correctAnswersRoot) return;
            const qIndex = getCurrentQuestionIndex();
            if (correctAnswersRoot.dataset.questionIndex && correctAnswersRoot.dataset.questionIndex !== String(qIndex)) {
                correctAnswersRoot.innerHTML = '';
            }
            markCorrectAnswersQuestion(qIndex);
            if (correctAnswerList.length === 0) return;
            // Create any missing buckets
            const wantedIds = new Set(correctAnswerList.map(a => `bucket-${a.toLowerCase().replace(/\s+/g, '-')}`));
            Array.from(correctAnswersRoot.querySelectorAll('.answer-bucket')).forEach(bucket => {
                if (!bucket.id || !wantedIds.has(bucket.id)) bucket.remove();
            });
            // Look for existing OUTER buckets by id
            const existingIds = new Set(Array.from(correctAnswersRoot.querySelectorAll('.answer-bucket[id]')).map(d => d.id));
            const toCreate = [...wantedIds].filter(id => !existingIds.has(id));
            if (toCreate.length > 0) {
                console.log('🧩 Ensuring buckets exist, creating:', toCreate);
                // Sort by label to keep stable order
                const sorted = [...correctAnswerList].sort((a,b)=>a.localeCompare(b));
                sorted.forEach(name => {
                    const bucketId = `bucket-${name.toLowerCase().replace(/\s+/g, '-')}`;
                    if (existingIds.has(bucketId)) return;
                    const bucketDiv = document.createElement('div');
                    bucketDiv.className = 'answer-bucket correct-bucket empty';
                    bucketDiv.id = bucketId;
                    bucketDiv.innerHTML = `
                        <h4 onclick="toggleBucket(this)">
                            <span class="bucket-toggle collapsed">▶</span>
                            ${name} <span class="answer-count-badge">0</span>
                        </h4>
                        <div class="answer-items collapsed" data-bucket="correct_${name.toLowerCase().replace(/\s+/g, '_')}"></div>
                    `;
                    correctAnswersRoot.appendChild(bucketDiv);
                });
                setupDragAndDrop();
            }
        }

                async function populateUncategorizedAnswers(answersToRemove = []) {
            console.log('🔄 populateUncategorizedAnswers called');
            
            // SIMPLE FIX: Just show all answers that aren't exact matches to correct answers
            const questionData = currentGame.currentQuestionData;
            const correctAnswerList = questionData?.correct_answers || [];
            
            // Only do exact matching - no semantic matching complexity
            const uncategorizedAnswers = (currentGame.currentAnswerGroups || []).filter(group => {
                const isExactMatch = correctAnswerList.some(correctAnswer => 
                    group.answer.toLowerCase().trim() === correctAnswer.toLowerCase().trim()
                );
                return !isExactMatch;
            });
            
            console.log('🔄 Uncategorized answers (exact match only):', uncategorizedAnswers);
            
            // Calculate confidence scores for uncategorized answers
            
            uncategorizedAnswers.forEach(answerGroup => {
                if (!answerGroup.semanticConfidence) {
                    // Find the best matching correct answer for confidence calculation
                    let bestConfidence = 0;
                    let bestMatch = null;
                    
                    correctAnswerList.forEach(correctAnswer => {
                        const confidence = calculateSemanticConfidence(answerGroup.answer, correctAnswer);
                        if (confidence > bestConfidence) {
                            bestConfidence = confidence;
                            bestMatch = correctAnswer;
                        }
                    });
                    
                    // Set confidence data for uncategorized answers
                    answerGroup.semanticConfidence = bestConfidence;
                    answerGroup.semanticMatch = bestMatch;
                    
                    console.log(`🧠 Calculated confidence for uncategorized "${answerGroup.answer}": ${bestConfidence}% → "${bestMatch}"`);
                }
            });

            const alreadyPlaced = answerTextsPlacedOutsideUncategorized();
            const coalescedUncategorized = coalesceAnswerGroups(uncategorizedAnswers).filter(group => {
                const key = normalizeAnswerText(group.answer);
                return key && !alreadyPlaced.has(key);
            });
            
            const uncategorizedContainer = document.getElementById('uncategorizedAnswers');
            
            if (uncategorizedContainer) {
                console.log('🔄 Populating', coalescedUncategorized.length, 'uncategorized answers');
                if (coalescedUncategorized.length > 0) {
                    // Replace with newly computed uncategorized set
                    uncategorizedContainer.innerHTML = '';
                    coalescedUncategorized.forEach((group, index) => {
                        try {
                            const answerItem = createAnswerItem(group, index);
                            uncategorizedContainer.appendChild(answerItem);
                            console.log('✅ Added uncategorized answer:', group.answer);
                        } catch (error) {
                            console.error('❌ Failed to create answer item:', error, group);
                        }
                    });
                } else {
                    console.log('🔄 No uncategorized answers to display - preserving existing content');
                    // Do not clear; keep any manually placed items
                }
                mergeIdenticalAnswerChipsIn(uncategorizedContainer);
            }
            
            // Setup drag and drop after populating
            setupDragAndDrop();
            updateCountBadges();
        }

        function createAnswerItemHTML(answerText, playerCount, semanticConfidence, playerNames) {
            let confidenceDisplay = '';
            if (semanticConfidence !== undefined) {
                const confidenceColor = semanticConfidence >= 80 ? '#27ae60' : 
                                      semanticConfidence >= 50 ? '#f39c12' : '#e74c3c';
                confidenceDisplay = `
                    <div class="answer-confidence" style="color: ${confidenceColor}; font-size: 11px; margin-top: 3px;">
                        🧠 ${semanticConfidence}%
                    </div>
                `;
            }
            
            return `
                <div class="answer-item" draggable="true" data-answer-text="${answerText}" data-player-names="${playerNames || ''}">
                    <div class="answer-text">"${answerText}" <span class="answer-count-badge">${playerCount}</span></div>
                    <div class="answer-players">${playerNames || ''}</div>
                    ${confidenceDisplay}
                </div>
            `;
        }

        function createAnswerItem(group, index) {
            const item = document.createElement('div');
            item.className = 'answer-item';
            item.draggable = true;
            item.dataset.answerIndex = index;
            item.dataset.answerText = group.answer;
            item.dataset.playerNames = Array.isArray(group.players) ? group.players.join(', ') : '';
            
            let confidenceDisplay = '';
            if (group.semanticConfidence !== undefined) {
                const confidenceColor = group.semanticConfidence >= 80 ? '#27ae60' : 
                                      group.semanticConfidence >= 50 ? '#f39c12' : '#e74c3c';
                confidenceDisplay = `
                    <div class="answer-confidence" style="color: ${confidenceColor}; font-size: 11px; margin-top: 3px;">
                        🧠 ${group.semanticConfidence}%${group.semanticMatch ? ` → "${group.semanticMatch}"` : ''}
                    </div>
                `;
            }
            
            item.innerHTML = `
                <div class="answer-text">"${group.answer}" <span class="answer-count-badge">${group.players ? group.players.length : group.count}</span></div>
                <div class="answer-players">${group.players ? group.players.join(', ') : ''}</div>
                ${confidenceDisplay}
            `;
            applyGuessToChip(item, group.answer, group.semanticMatch, group.semanticConfidence);
            
            return item;
        }

        const GUESS_ACCEPT_MIN = 50;

        function guessForAnswer(answerText) {
            const correctAnswerList = currentGame?.currentQuestionData?.correct_answers || [];
            let bestConfidence = 0;
            let bestMatch = null;
            correctAnswerList.forEach((correctAnswer) => {
                const confidence = calculateSemanticConfidence(answerText, correctAnswer);
                if (confidence > bestConfidence) {
                    bestConfidence = confidence;
                    bestMatch = correctAnswer;
                }
            });
            return { bestMatch, bestConfidence };
        }

        function applyGuessToChip(chip, answerText, knownMatch, knownConfidence) {
            if (!chip) return null;
            let bestMatch = knownMatch || chip.dataset.semanticMatch || '';
            let bestConfidence = knownConfidence != null && knownConfidence !== ''
                ? Number(knownConfidence)
                : (chip.dataset.semanticConfidence ? Number(chip.dataset.semanticConfidence) : NaN);
            if (!bestMatch || !Number.isFinite(bestConfidence)) {
                const guessed = guessForAnswer(answerText || chipAnswerText(chip));
                bestMatch = guessed.bestMatch;
                bestConfidence = guessed.bestConfidence;
            }
            if (!bestMatch || !Number.isFinite(bestConfidence) || bestConfidence <= 0) {
                delete chip.dataset.semanticMatch;
                delete chip.dataset.semanticConfidence;
                chip.removeAttribute('title');
                return null;
            }
            chip.dataset.semanticMatch = bestMatch;
            chip.dataset.semanticConfidence = String(bestConfidence);
            chip.title = bestConfidence >= GUESS_ACCEPT_MIN
                ? `Double-click to file as "${bestMatch}"`
                : `Guess "${bestMatch}" is too weak to auto-file`;
            const confidenceEl = chip.querySelector('.answer-confidence');
            if (confidenceEl) {
                const color = bestConfidence >= 80 ? '#27ae60' : bestConfidence >= 50 ? '#f39c12' : '#e74c3c';
                confidenceEl.style.color = color;
                confidenceEl.textContent = `🧠 ${bestConfidence}% → "${bestMatch}"`;
            }
            return { bestMatch, bestConfidence };
        }

        function correctBucketDropZoneFor(name) {
            if (!name) return null;
            try { ensureCorrectBucketsExist(); } catch (_) {}
            const slug = String(name).toLowerCase().replace(/\s+/g, '-');
            const bucket = document.getElementById(`bucket-${slug}`);
            if (bucket) return bucket.querySelector('.answer-items');
            const dataBucket = `correct_${String(name).toLowerCase().replace(/\s+/g, '_')}`;
            const zone = document.querySelector(`#correctAnswers .answer-items[data-bucket="${dataBucket}"]`);
            if (zone) return zone;
            const wanted = normalizeAnswerText(name);
            for (const itemZone of document.querySelectorAll('#correctAnswers .answer-items')) {
                const id = itemZone.dataset.bucket || '';
                if (normalizeAnswerText(id.replace(/^correct_/, '').replace(/_/g, ' ')) === wanted) {
                    return itemZone;
                }
            }
            return null;
        }

        function acceptUncategorizedGuess(chip) {
            if (!chip || !chip.closest('#uncategorizedAnswers')) return false;
            const guess = applyGuessToChip(chip, chipAnswerText(chip));
            if (!guess || guess.bestConfidence < GUESS_ACCEPT_MIN) {
                chip.style.outline = '2px solid #e74c3c';
                setTimeout(() => { chip.style.outline = ''; }, 500);
                showToast('No strong guessed bucket for this answer', 'info');
                return false;
            }
            const dropZone = correctBucketDropZoneFor(guess.bestMatch);
            if (!dropZone) {
                showToast(`No bucket for "${guess.bestMatch}"`, 'info');
                return false;
            }
            dropZone.appendChild(chip);
            const bucket = dropZone.closest('.answer-bucket');
            if (!keepInboxCorrectCollapsed(bucket, dropZone) && dropZone.classList.contains('collapsed')) {
                dropZone.classList.remove('collapsed');
                const toggle = bucket?.querySelector('.bucket-toggle');
                if (toggle) toggle.classList.remove('collapsed');
                if (bucket) bucket.classList.add('is-open');
            }
            updateConfidenceForMovedElement(chip, dropZone);
            mergeIdenticalAnswerChipsIn(dropZone);
            mergeIdenticalAnswerChipsEverywhere();
            updateCountBadges();
            autoSave();
            chip.style.background = 'rgba(76, 175, 80, 0.35)';
            setTimeout(() => { chip.style.background = ''; }, 700);
            console.log(`✅ Double-click filed "${chipAnswerText(chip)}" as "${guess.bestMatch}"`);
            return true;
        }

        function setupDragAndDrop() {
            // Use event delegation instead of individual listeners to prevent memory leaks
            document.removeEventListener('dragstart', globalDragHandler);
            document.removeEventListener('dragend', globalDragHandler);
            document.removeEventListener('dragover', globalDragHandler);
            document.removeEventListener('dragenter', globalDragHandler);
            document.removeEventListener('dragleave', globalDragHandler);
            document.removeEventListener('drop', globalDragHandler);
            
            // Set up global event delegation
            document.addEventListener('dragstart', globalDragHandler);
            document.addEventListener('dragend', globalDragHandler);
            document.addEventListener('dragover', globalDragHandler);
            document.addEventListener('dragenter', globalDragHandler);
            document.addEventListener('dragleave', globalDragHandler);
            document.addEventListener('drop', globalDragHandler);
        }

        // Global drag handler using event delegation (prevents memory leaks)
        function globalDragHandler(e) {
            const answerItem = e.target.closest('.answer-item');
            const dropZone = e.target.closest('.answer-items');
            const bucket = e.target.closest('.answer-bucket');
            
            switch(e.type) {
                case 'dragstart':
                    if (answerItem) handleDragStart(e);
                    break;
                case 'dragend':
                    if (answerItem) handleDragEnd(e);
                    break;
                case 'dragover':
                    if (dropZone || bucket) handleDragOver(e);
                    break;
                case 'dragenter':
                    if (dropZone || bucket) handleDragEnter(e);
                    break;
                case 'dragleave':
                    if (dropZone || bucket) handleDragLeave(e);
                    break;
                case 'drop':
                    if (bucket) handleDropOnBucket(e);
                    else if (dropZone) handleDrop(e);
                    break;
            }
        }

        function handleDragStart(e) {
            const item = e.target.closest('.answer-item');
            if (!item) return;
            console.log('🎯 Drag start:', item);
            draggedElement = item;
            item.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/html', item.outerHTML);
        }

        function handleDragEnd(e) {
            e.target.classList.remove('dragging');
            draggedElement = null;
        }

        function handleDragOver(e) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
        }

        function handleDragEnter(e) {
            e.preventDefault();
            const target = e.target.closest('.answer-items') || e.target.closest('.answer-bucket');
            if (target) {
                target.classList.add('drag-over');
            }
        }

        function handleDragLeave(e) {
            const target = e.target.closest('.answer-items') || e.target.closest('.answer-bucket');
            if (target) {
                target.classList.remove('drag-over');
            }
        }

        function handleDrop(e) {
            e.preventDefault();
            console.log('🎯 Drop event:', e.target);
            const dropZone = e.target.closest('.answer-items');
            console.log('🎯 Drop zone found:', dropZone);
            dropZone.classList.remove('drag-over');
            
            if (draggedElement && dropZone) {
                console.log('🎯 Moving element to drop zone');
                dropZone.appendChild(draggedElement);
                
                // Update confidence display for moved element
                updateConfidenceForMovedElement(draggedElement, dropZone);
                mergeIdenticalAnswerChipsIn(dropZone);
                
                updateCountBadges();
                
                // Auto-save after drop
                autoSave();
            } else {
                console.log('🎯 Drop failed:', { draggedElement: !!draggedElement, dropZone: !!dropZone });
            }
        }

        function handleDropOnBucket(e) {
            e.preventDefault();
            const bucket = e.target.closest('.answer-bucket');
            document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
            if (draggedElement && bucket) moveChipToBucket(draggedElement, bucket);
        }

        let selectedGradeChip = null;

        function selectGradeChip(chip) {
            document.querySelectorAll('.answer-item.is-selected').forEach((el) => el.classList.remove('is-selected'));
            document.querySelectorAll('.answer-bucket.is-drop-ready').forEach((el) => el.classList.remove('is-drop-ready'));
            selectedGradeChip = chip || null;
            if (!chip) return;
            chip.classList.add('is-selected');
            document.querySelectorAll('.grading-board .answer-bucket').forEach((bucket) => {
                if (!chip.closest('.answer-bucket') || bucket !== chip.closest('.answer-bucket')) {
                    bucket.classList.add('is-drop-ready');
                }
            });
        }

        function isSendBackBucket(bucket) {
            if (!bucket) return false;
            const zone = bucket.querySelector('.answer-items');
            return bucket.classList.contains('sendback-bucket') || (zone && zone.dataset.bucket === 'sendBack');
        }

        function requestSendBackForChip(chip) {
            try {
                let names = (chip.dataset.playerNames || '').split(',').map((n) => n.trim()).filter(Boolean);
                const reason = prompt('Reason to send back (optional):', 'Please be more specific');
                if (!names.length) {
                    const draggedText = chip?.dataset?.answerText || '';
                    const group = (currentGame?.currentAnswerGroups || []).find((g) => (g.answer || '').toLowerCase().trim() === draggedText.toLowerCase().trim());
                    if (group && Array.isArray(group.players) && group.players.length > 0) names = group.players.slice();
                }
                try {
                    const draggedText = (chip?.dataset?.answerText || '').toLowerCase().trim();
                    if (currentGame && Array.isArray(currentGame.currentAnswerGroups)) {
                        currentGame.currentAnswerGroups = currentGame.currentAnswerGroups.map((g) => {
                            if ((g.answer || '').toLowerCase().trim() !== draggedText) return g;
                            const remaining = (g.players || []).filter((p) => !names.includes(p));
                            return { ...g, players: remaining, count: remaining.length };
                        }).filter((g) => Array.isArray(g.players) ? g.players.length > 0 : (g.count || 0) > 0);
                    }
                } catch (_) {}
                if (!names.length || !currentGame?.gameCode) return;
                names.forEach((name) => {
                    socket.emit('hostRequestEdit', { gameCode: currentGame.gameCode, playerName: name, reason });
                });
            } catch (err) {
                console.warn('Failed to send back request', err);
            }
        }

        function isInboxLayout() {
            return document.getElementById('gradingInterface')?.classList.contains('is-inbox');
        }

        function keepInboxCorrectCollapsed(bucket, dropZone) {
            if (!isInboxLayout() || !bucket?.classList.contains('correct-bucket')) return false;
            dropZone.classList.add('collapsed');
            const toggle = bucket.querySelector('.bucket-toggle');
            if (toggle) toggle.classList.add('collapsed');
            bucket.classList.remove('is-open');
            return true;
        }

        function moveChipToBucket(chip, bucket) {
            if (!chip || !bucket) return false;
            const dropZone = bucket.querySelector('.answer-items');
            if (!dropZone) return false;
            if (chip.parentElement === dropZone) {
                selectGradeChip(null);
                return false;
            }
            if (!keepInboxCorrectCollapsed(bucket, dropZone)) {
                dropZone.classList.remove('collapsed');
                const toggle = bucket.querySelector('.bucket-toggle');
                if (toggle) toggle.classList.remove('collapsed');
                bucket.classList.add('is-open');
            }
            dropZone.appendChild(chip);
            try { updateConfidenceForMovedElement(chip, dropZone); } catch (_) {}
            try { mergeIdenticalAnswerChipsIn(dropZone); } catch (_) {}
            if (isSendBackBucket(bucket)) requestSendBackForChip(chip);
            updateCountBadges();
            try { autoSave(); } catch (_) {}
            selectGradeChip(null);
            return true;
        }

        function bindInboxClicks() {
            const root = document.getElementById('gradingInterface');
            if (!root || root.dataset.inboxClicks === '1') return;
            root.dataset.inboxClicks = '1';
            root.addEventListener('click', (e) => {
                if (e.target.closest('button, input, select, textarea, a')) return;
                const chip = e.target.closest('.answer-item');
                const bucket = e.target.closest('.answer-bucket');
                if (chip) {
                    e.preventDefault();
                    selectGradeChip(chip);
                    return;
                }
                if (bucket && selectedGradeChip) {
                    e.preventDefault();
                    moveChipToBucket(selectedGradeChip, bucket);
                }
            });
            document.addEventListener('keydown', (e) => {
                if (!selectedGradeChip) return;
                if (e.target && e.target.closest && e.target.closest('input, textarea, select')) return;
                if (e.key === 'Escape') {
                    selectGradeChip(null);
                    return;
                }
                if (e.key === '1') {
                    acceptUncategorizedGuess(selectedGradeChip);
                    selectGradeChip(null);
                } else if (e.key === '2') {
                    const wrong = document.querySelector('.wrong-bucket');
                    if (wrong) moveChipToBucket(selectedGradeChip, wrong);
                } else if (e.key === '3') {
                    const sendBack = document.querySelector('.sendback-bucket');
                    if (sendBack) moveChipToBucket(selectedGradeChip, sendBack);
                }
            });
        }

        function consolidateBucketAnswers(dropZone, bucketName) {
            console.log(`🎯 Consolidating answers in bucket: "${bucketName}"`);
            
            // Get all answer items in this bucket
            const answerItems = Array.from(dropZone.querySelectorAll('.answer-item'));
            console.log(`🎯 Found ${answerItems.length} answer items to consolidate`);
            
            if (answerItems.length <= 1) {
                console.log('🎯 Only one answer item, no consolidation needed');
                return;
            }
            
            // Calculate total player count
            let totalPlayers = 0;
            const allPlayerNames = [];
            const individualAnswers = [];
            
            answerItems.forEach(item => {
                const playerCount = parseInt(item.querySelector('.answer-count-badge')?.textContent || '1');
                const answerText = item.dataset.answerText;
                totalPlayers += playerCount;
                
                // Collect player names if available
                const playerNames = item.querySelector('.answer-players')?.textContent;
                if (playerNames) {
                    allPlayerNames.push(playerNames);
                }
                
                // Store individual answer for display
                individualAnswers.push({
                    text: answerText,
                    count: playerCount,
                    players: playerNames
                });
            });
            
            console.log(`🎯 Total players across all answers: ${totalPlayers}`);
            console.log(`🎯 Individual answers:`, individualAnswers);
            
            // Clear the drop zone
            dropZone.innerHTML = '';
            
            // Create individual answer items
            individualAnswers.forEach(answer => {
                const answerItem = document.createElement('div');
                answerItem.className = 'answer-item';
                answerItem.draggable = true;
                answerItem.dataset.answerText = answer.text;
                answerItem.dataset.playerNames = answer.players || '';
                
                // Style for individual answers within bucket
                answerItem.style.cssText = `
                    background: rgba(46, 204, 113, 0.1);
                    border: 1px solid rgba(46, 204, 113, 0.3);
                    margin: 4px 0;
                    padding: 6px 10px;
                    border-radius: 4px;
                    font-size: 12px;
                `;
                
                answerItem.innerHTML = `
                    <div class="answer-text">"${answer.text}" <span class="answer-count-badge">${answer.count}</span></div>
                    <div class="answer-players" style="font-size: 10px; color: #666;">${answer.players || ''}</div>
                `;
                
                dropZone.appendChild(answerItem);
            });
            
            console.log(`🎯 Created bucket header: "${bucketName}" with ${totalPlayers} total players`);
            console.log(`🎯 Added ${individualAnswers.length} individual answer items`);
        }

        function showGradingConfirmation(categorization) {
            const totalCorrect = categorization.correctAnswerBuckets.reduce((sum, bucket) => sum + bucket.answers.length, 0);
            const totalWrong = categorization.wrong.length;
            const totalUncategorized = categorization.uncategorized.length;
            const totalAnswers = totalCorrect + totalWrong + totalUncategorized;
            
            // Create summary text
            let summaryText = `Grading Complete!\n\n`;
            summaryText += `📊 Summary:\n`;
            summaryText += `✅ Correct: ${totalCorrect}\n`;
            summaryText += `❌ Wrong: ${totalWrong}\n`;
            summaryText += `📦 Uncategorized: ${totalUncategorized}\n`;
            summaryText += `📋 Total: ${totalAnswers}\n\n`;
            
            // Add details for correct answers
            if (totalCorrect > 0) {
                summaryText += `✅ Correct Answers:\n`;
                // Sort buckets alphabetically before processing
                categorization.correctAnswerBuckets.sort((a, b) => {
                    const nameA = a.name || a.id || '';
                    const nameB = b.name || b.id || '';
                    return nameA.localeCompare(nameB);
                });
                categorization.correctAnswerBuckets.forEach(bucket => {
                    if (bucket.answers.length > 0) {
                        // Get bucket name from DOM
                        const bucketElement = document.querySelector(`[data-bucket="${bucket.id}"]`)?.closest('.answer-bucket');
                        const bucketName = bucketElement?.querySelector('h4')?.textContent?.replace(/[▼▶]\s*/, '').trim() || bucket.id;
                        summaryText += `  ${bucketName}: ${bucket.answers.map(a => `"${a.answer}"`).join(', ')}\n`;
                    }
                });
                summaryText += `\n`;
            }
            
            // Add details for wrong answers
            if (totalWrong > 0) {
                summaryText += `❌ Wrong Answers:\n`;
                summaryText += `  ${categorization.wrong.map(a => `"${a.answer}"`).join(', ')}\n\n`;
            }
            
            // Add details for uncategorized answers
            if (totalUncategorized > 0) {
                summaryText += `📦 Uncategorized Answers:\n`;
                summaryText += `  ${categorization.uncategorized.map(a => `"${a.answer}"`).join(', ')}\n\n`;
            }
            
            summaryText += `Click OK to continue to scoring phase.`;
            
            // Show the confirmation
            // alert(summaryText); // Removed alert box
        }

        function applyCategorization() {
            if (!currentGame) return;
            const phase = currentGame.gameState;
            if (phase && phase !== 'grading') {
                showToast('Wait until the question ends before completing grading', 'error');
                return;
            }
            
            // Collect categorization data
            const categorization = {
                gameCode: currentGame.gameCode,
                correctAnswerBuckets: [],
                wrong: [],
                uncategorized: []
            };
            
            // Get correct answer buckets
            document.querySelectorAll('#correctAnswers .answer-bucket').forEach(bucket => {
                const bucketId = bucket.querySelector('.answer-items').dataset.bucket;
                const answers = Array.from(bucket.querySelectorAll('.answer-item')).map(item => ({
                    answer: item.dataset.answerText,
                    index: parseInt(item.dataset.answerIndex),
                    players: (item.dataset.playerNames || item.querySelector('.answer-players')?.textContent || '')
                        .split(',').map(n => n.trim()).filter(Boolean)
                }));
                
                categorization.correctAnswerBuckets.push({
                    id: bucketId,
                    answers: answers
                });
            });
            
            // Get wrong answers
            const namesFromItem = (item) => (item.dataset.playerNames || item.querySelector('.answer-players')?.textContent || '')
                .split(',').map(n => n.trim()).filter(Boolean);
            const wrongAnswers = Array.from(document.querySelectorAll('#wrongAnswers .answer-item')).map(item => ({
                answer: item.dataset.answerText,
                index: parseInt(item.dataset.answerIndex),
                players: namesFromItem(item)
            }));
            categorization.wrong = wrongAnswers;
            
            // Get uncategorized answers
            const uncategorizedAnswers = Array.from(document.querySelectorAll('#uncategorizedAnswers .answer-item')).map(item => ({
                answer: item.dataset.answerText,
                index: parseInt(item.dataset.answerIndex),
                players: namesFromItem(item)
            }));
            categorization.uncategorized = uncategorizedAnswers;
            
            console.log('Submitting categorization:', categorization);
            
            // Show confirmation dialog with results
            showGradingConfirmation(categorization);
            
            // Send categorization to server with enhanced debugging
            console.log('🎯 About to emit completeGrading with data:', {
                gameCode: currentGame.gameCode,
                categorizedAnswers: categorization
            });
            
            const pendingCount = Array.isArray(currentGame.pendingEdits) ? currentGame.pendingEdits.length : 0;
            let forceComplete = false;
            if (pendingCount > 0) {
                const names = currentGame.pendingEdits.map(p => p.playerName).join(', ');
                const ok = window.confirm(`${pendingCount} player${pendingCount === 1 ? ' is' : 's are'} still rewriting a sent-back answer (${names}). Score without them?`);
                if (!ok) return;
                forceComplete = true;
            }

            try {
                const LS = window.MEGASheepLockstep;
                const epoch = currentGame.epoch || (LS && LS.gameEpoch
                    ? LS.gameEpoch(currentGame.gameCode, getCurrentQuestionIndex(), currentGame.gameState)
                    : gradingDraftEpoch);
                socket.emit('completeGrading', {
                    gameCode: currentGame.gameCode,
                    categorizedAnswers: categorization,
                    questionIndex: getCurrentQuestionIndex(),
                    epoch,
                    forceComplete
                });
                console.log('✅ Successfully emitted completeGrading');
            } catch (error) {
                console.error('❌ Error emitting completeGrading:', error);
                alert('Error submitting grading: ' + error.message);
            }

            // Optimistically close modal and signal completion in UI
            try {
                showTemporaryMessage('✅ Grading submitted. Waiting for results…', 'success');
            } catch (_) {}
            try {
                if (window.parent && window.parent !== window) {
                    window.parent.postMessage({ type: 'megasheep-grading-complete', gameCode: currentGame.gameCode }, '*');
                }
            } catch (_) {}
            if (!isEmbedded()) {
                try { window.close(); } catch (_) {}
            }
        }

        function backToGames() {
            currentGame = null;
            document.getElementById('gradingInterface').style.display = 'none';
            document.getElementById('gameSelection').style.display = 'block';
            updateGameList();
            
            // Close this grading interface window and focus back on main host window
            if (window.opener) {
                // If opened as popup, close this window and focus opener
                window.opener.focus();
                window.close();
            } else {
                // If opened in same tab, navigate to host
                window.location.href = '/host';
            }
        }

        function nextQuestion() {
            if (!currentGame) {
                console.error('❌ No current game to proceed to next question');
                return;
            }
            if (currentGame.gameState && currentGame.gameState !== 'scoring') {
                alert('Finish grading this question before going to the next one.');
                return;
            }

            console.log('▶️ Proceeding to next question for game:', currentGame.gameCode);
            
            // Check if this is the last question in the round/game
            const isLastQuestion = currentGame.currentQuestion >= currentGame.questionsPerRound;
            
            if (isLastQuestion) {
                console.log('🏁 This was the last question in the game');
                showTemporaryMessage('🏁 Game completed! Final scores will be displayed.', 'success');
            }
            
            // Emit nextQuestion event to server
            socket.emit('nextQuestion', {
                gameCode: currentGame.gameCode
            });

            // Hide the Next Question button after clicking
            document.getElementById('nextQuestionBtn').style.display = 'none';
        }

        function normalizeAnswer(answer) {
            return answer
                .toLowerCase()                    // Convert to lowercase
                .trim()                          // Remove leading/trailing spaces
                .replace(/\s+/g, ' ')            // Replace multiple spaces with single space
                .replace(/[^\w\s]/g, '')         // Remove all punctuation except spaces
                .trim();                         // Trim again after punctuation removal
        }
        
        // Calculate semantic confidence between two answers
        function calculateSemanticConfidence(answerText, correctAnswer) {
            const normalizedAnswer = normalizeAnswer(answerText);
            const normalizedCorrect = normalizeAnswer(correctAnswer);
            
            // Exact match gets 100% confidence
            if (normalizedAnswer === normalizedCorrect) {
                return 100;
            }
            
            // Check for high-confidence substring matches (e.g., "billy goat" contains "goat")
            if (normalizedAnswer.includes(normalizedCorrect)) {
                // If the correct answer is contained in the response, high confidence
                return 95; // Very high confidence for containing the exact animal name
            }
            
            if (normalizedCorrect.includes(normalizedAnswer)) {
                // If the response is contained in the correct answer
                return 90;
            }
            
            // Calculate similarity using simple string comparison
            let similarity = 0;
            const maxLength = Math.max(normalizedAnswer.length, normalizedCorrect.length);
            
            if (maxLength === 0) return 0;
            
            // Calculate character-by-character similarity for fuzzy matches
            let matches = 0;
            const minLength = Math.min(normalizedAnswer.length, normalizedCorrect.length);
            
            for (let i = 0; i < minLength; i++) {
                if (normalizedAnswer[i] === normalizedCorrect[i]) {
                    matches++;
                }
            }
            
            similarity = matches / maxLength;
            
            // Convert to percentage and round
            return Math.round(similarity * 100);
        }

        async function getSemanticMatches(question, correctAnswers, responses) {
            try {
                // Use the server's integrated semantic matcher
                const response = await fetch('/api/semantic-match', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        question: question, 
                        correct_answers: correctAnswers, 
                        responses: responses 
                    })
                });
                if (!response.ok) { 
                    throw new Error(`HTTP error! status: ${response.status}`); 
                }
                const data = await response.json();
                return data.results;
            } catch (error) {
                console.error('Error calling semantic matcher:', error);
                throw error;
            }
        }

        function updateCountBadges() {
            // Update wrong answers count
            const wrongAnswersCount = document.querySelectorAll('#wrongAnswers .answer-item').length;
            document.getElementById('wrongAnswersCount').textContent = wrongAnswersCount;
            
            // Update uncategorized answers count
            const uncategorizedAnswersCount = document.querySelectorAll('#uncategorizedAnswers .answer-item').length;
            document.getElementById('uncategorizedAnswersCount').textContent = uncategorizedAnswersCount;
            
            // Update correct answer bucket counts by unique players across all items
            document.querySelectorAll('#correctAnswers .answer-bucket').forEach(bucket => {
                const countBadge = bucket.querySelector('.answer-count-badge');
                const uniquePlayers = new Set();
                const playerEls = bucket.querySelectorAll('.answer-players');
                playerEls.forEach(el => {
                    const names = (el.textContent || '').split(',').map(s=>s.trim()).filter(Boolean);
                    names.forEach(n => uniquePlayers.add(n));
                });
                const chipCount = bucket.querySelectorAll('.answer-item').length;
                if (countBadge) countBadge.textContent = uniquePlayers.size || chipCount;
                bucket.classList.toggle('empty', chipCount === 0);
            });
            try {
                if (typeof window.updateGradeCommandStrip === 'function') {
                    window.updateGradeCommandStrip();
                }
            } catch (_) {}
        }

        function toggleBucket(headerElement) {
            if (selectedGradeChip) return;
            const bucket = headerElement.parentElement;
            const answerItems = bucket.querySelector('.answer-items');
            const toggle = headerElement.querySelector('.bucket-toggle');
            if (!answerItems) return;

            if (answerItems.classList.contains('collapsed')) {
                answerItems.classList.remove('collapsed');
                if (toggle) toggle.classList.remove('collapsed');
                bucket.classList.add('is-open');
            } else {
                answerItems.classList.add('collapsed');
                if (toggle) toggle.classList.add('collapsed');
                bucket.classList.remove('is-open');
            }
        }

        // Event listeners
        document.getElementById('applyCategorizationBtn')?.addEventListener('click', applyCategorization);
        document.getElementById('nextQuestionBtn')?.addEventListener('click', nextQuestion);

        // Update confidence display for moved elements
        function updateConfidenceForMovedElement(draggedElement, dropZone) {
            const answerText = draggedElement.dataset.answerText;
            if (!answerText) return;
            
            // Determine if this is a correct answer bucket or uncategorized
            const bucketId = dropZone.dataset.bucket;
            const isCorrectBucket = bucketId && bucketId.startsWith('correct_');
            
            if (isCorrectBucket) {
                // If moved to a correct answer bucket, set confidence to 100%
                const confidenceDisplay = draggedElement.querySelector('.answer-confidence');
                if (confidenceDisplay) {
                    confidenceDisplay.innerHTML = `🧠 100% → "${answerText}"`;
                    confidenceDisplay.style.color = '#27ae60';
                } else {
                    // Create confidence display if it doesn't exist
                    const newConfidenceDisplay = document.createElement('div');
                    newConfidenceDisplay.className = 'answer-confidence';
                    newConfidenceDisplay.style.cssText = 'color: #27ae60; font-size: 11px; margin-top: 3px;';
                    newConfidenceDisplay.innerHTML = `🧠 100% → "${answerText}"`;
                    draggedElement.appendChild(newConfidenceDisplay);
                }
            } else {
                // If moved to uncategorized, calculate confidence against all correct answers
                const questionData = currentGame.currentQuestionData;
                const correctAnswerList = questionData?.correct_answers || [];
                
                let bestConfidence = 0;
                let bestMatch = null;
                
                correctAnswerList.forEach(correctAnswer => {
                    const confidence = calculateSemanticConfidence(answerText, correctAnswer);
                    if (confidence > bestConfidence) {
                        bestConfidence = confidence;
                        bestMatch = correctAnswer;
                    }
                });
                
                // Update or create confidence display
                let confidenceDisplay = draggedElement.querySelector('.answer-confidence');
                if (!confidenceDisplay) {
                    confidenceDisplay = document.createElement('div');
                    confidenceDisplay.className = 'answer-confidence';
                    confidenceDisplay.style.cssText = 'font-size: 11px; margin-top: 3px;';
                    draggedElement.appendChild(confidenceDisplay);
                }
                
                const confidenceColor = bestConfidence >= 80 ? '#27ae60' : 
                                      bestConfidence >= 50 ? '#f39c12' : '#e74c3c';
                confidenceDisplay.style.color = confidenceColor;
                confidenceDisplay.innerHTML = `🧠 ${bestConfidence}%${bestMatch ? ` → "${bestMatch}"` : ''}`;
                
                console.log(`🧠 Updated confidence for moved "${answerText}": ${bestConfidence}% → "${bestMatch}"`);
            }
        }

        // ===== GRADING STATE PERSISTENCE =====
        
        // Save current grading state to localStorage
        function saveGradingState() {
            if (!currentGame || !currentGame.currentQuestionData) return;
            
            const state = {
                gameCode: currentGame.gameCode,
                questionIndex: getCurrentQuestionIndex(),
                timestamp: Date.now(),
                buckets: {}
            };
            
            // Save state for each bucket
            const allBuckets = document.querySelectorAll('.answer-bucket');
            
            allBuckets.forEach(bucket => {
                const bucketId = bucket.dataset.bucketId;
                if (!bucketId) return;
                
                const answerItems = bucket.querySelectorAll('.answer-item');
                const items = [];
                
                answerItems.forEach(item => {
                    const answerText = item.dataset.answerText;
                    const playerCount = parseInt(item.querySelector('.answer-count-badge')?.textContent || '1');
                    const confidence = item.querySelector('.answer-confidence')?.textContent || '';
                    const playerNames = item.dataset.playerNames || item.querySelector('.answer-players')?.textContent || '';
                    
                    items.push({
                        answerText: answerText,
                        playerCount: playerCount,
                        confidence: confidence,
                        playerNames: playerNames
                    });
                });
                
                state.buckets[bucketId] = items;
            });
            
            // Save state for uncategorized and wrong answer containers
            const uncategorizedContainer = document.getElementById('uncategorizedAnswers');
            if (uncategorizedContainer) {
                const uncategorizedItems = uncategorizedContainer.querySelectorAll('.answer-item');
                const items = [];
                
                uncategorizedItems.forEach(item => {
                    items.push({
                        answerText: item.dataset.answerText,
                        playerCount: parseInt(item.querySelector('.answer-count-badge')?.textContent || '1'),
                        confidence: item.querySelector('.answer-confidence')?.textContent || '',
                        playerNames: item.dataset.playerNames || item.querySelector('.answer-players')?.textContent || ''
                    });
                });
                
                state.buckets['uncategorized'] = items;
            }
            
            const wrongContainer = document.getElementById('wrongAnswers');
            if (wrongContainer) {
                const wrongItems = wrongContainer.querySelectorAll('.answer-item');
                const items = [];
                
                wrongItems.forEach(item => {
                    items.push({
                        answerText: item.dataset.answerText,
                        playerCount: parseInt(item.querySelector('.answer-count-badge')?.textContent || '1'),
                        confidence: item.querySelector('.answer-confidence')?.textContent || '',
                        playerNames: item.dataset.playerNames || item.querySelector('.answer-players')?.textContent || ''
                    });
                });
                
                state.buckets['wrong'] = items;
            }
            
            state.questionIndex = getCurrentQuestionIndex();
            const stateKey = `grading_state_${currentGame.gameCode}_${getCurrentQuestionIndex()}`;
            localStorage.setItem(stateKey, JSON.stringify(state));
            
            // Show save indicator
            showSaveIndicator();
        }

        // Clear grading state for previous questions to prevent wrong answers from persisting
        function clearPreviousGradingStates() {
            if (!currentGame) return;
            
            console.log('🧹 Clearing previous grading states for game:', currentGame.gameCode);
            
            // Get all localStorage keys that match our grading state pattern
            const gradingStatePrefix = `grading_state_${currentGame.gameCode}_`;
            const keysToRemove = [];
            
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key && key.startsWith(gradingStatePrefix)) {
                    // Extract the question index from the key
                    const questionIndex = parseInt(key.replace(gradingStatePrefix, ''));
                    
                    // Remove states from previous questions (not current)
                    if (!isNaN(questionIndex) && questionIndex !== getCurrentQuestionIndex()) {
                        keysToRemove.push(key);
                        console.log(`🗑️ Marking for removal: ${key} (Q${questionIndex} != current Q${currentGame.currentQuestionIndex})`);
                    }
                }
            }
            
            // Remove the identified keys
            keysToRemove.forEach(key => {
                localStorage.removeItem(key);
                console.log(`🗑️ Removed old grading state: ${key}`);
            });
            
            console.log(`🧹 Cleared ${keysToRemove.length} previous grading states`);
            
            // Do NOT clear current question's state; we want to preserve manual placements across clarify/reloads
            // Also avoid blocking restoration so the UI can rebuild from saved state quickly
        }
        
        // Restore grading state from localStorage
        function restoreGradingState() {
            if (!currentGame || !currentGame.currentQuestionData) return false;
            if (currentGame.gameState && currentGame.gameState !== 'grading') return false;
            const marked = document.getElementById('correctAnswers')?.dataset.questionIndex;
            if (marked && marked !== String(getCurrentQuestionIndex())) return false;
            
            // Check if state restoration should be skipped (after clearing previous states)
            if (window.skipStateRestoration) {
                console.log('⏭️ Skipping state restoration due to fresh question load');
                return false;
            }
            
            const stateKey = `grading_state_${currentGame.gameCode}_${getCurrentQuestionIndex()}`;
            const savedState = localStorage.getItem(stateKey);
            
            console.log('💾 Attempting to restore state for key:', stateKey);
            console.log('💾 Found saved state:', !!savedState);
            
            if (!savedState) {
                console.log('💾 No saved state found for current question');
                return false;
            }
            
            try {
                const state = JSON.parse(savedState);
                
                // Check if state is still valid (same game and question)
                if (state.gameCode !== currentGame.gameCode || 
                    state.questionIndex !== getCurrentQuestionIndex()) {
                    localStorage.removeItem(stateKey);
                    return false;
                }
                
                // Clear ALL buckets first to prevent duplicates
                document.querySelectorAll('.answer-items').forEach(container => {
                    container.innerHTML = '';
                });
                
                // Apply saved state
                let restoredAny = false;
                Object.keys(state.buckets).forEach(bucketId => {
                    let bucket, dropZone;
                    
                    // Handle different bucket types
                    if (bucketId === 'uncategorized') {
                        dropZone = document.getElementById('uncategorizedAnswers');
                    } else if (bucketId === 'wrong') {
                        dropZone = document.getElementById('wrongAnswers');
                    } else {
                        bucket = document.querySelector(`[data-bucket-id="${bucketId}"]`);
                        dropZone = bucket?.querySelector('.answer-items');
                    }
                    
                    if (!dropZone) return;
                    
                    // Restore items if there are any
                    if (state.buckets[bucketId].length > 0) {
                        restoredAny = true;
                        
                        // Add saved items
                        state.buckets[bucketId].forEach(item => {
                        // Extract confidence percentage from the saved confidence text
                        let confidence = 0;
                        if (item.confidence) {
                            const match = item.confidence.match(/🧠 (\d+)%/);
                            if (match) {
                                confidence = parseInt(match[1]);
                            }
                        }
                        
                        const answerItemHTML = createAnswerItemHTML(
                            item.answerText,
                            item.playerCount,
                            confidence,
                            item.playerNames
                        );
                        // Convert HTML string to DOM element
                        const tempDiv = document.createElement('div');
                        tempDiv.innerHTML = answerItemHTML;
                        const answerItem = tempDiv.firstElementChild;
                        dropZone.appendChild(answerItem);
                    });
                    }
                });
                
                // Re-setup drag and drop
                setupDragAndDrop();
                updateCountBadges();
                
                console.log('✅ Grading state restored successfully');
                showRestoreIndicator();
                return restoredAny;
                
            } catch (error) {
                console.error('❌ Error restoring grading state:', error);
                localStorage.removeItem(stateKey);
                return false;
            }
        }
        
        // Show save indicator
        function showSaveIndicator() {
            const indicator = document.createElement('div');
            indicator.id = 'save-indicator';
            indicator.style.cssText = `
                position: fixed;
                top: 20px;
                right: 20px;
                background: #27ae60;
                color: white;
                padding: 10px 15px;
                border-radius: 8px;
                font-size: 14px;
                z-index: 1000;
                animation: slideInRight 0.3s ease;
            `;
            indicator.textContent = '💾 State Saved';
            
            document.body.appendChild(indicator);
            
            setTimeout(() => {
                indicator.style.animation = 'slideOutRight 0.3s ease';
                setTimeout(() => {
                    if (indicator.parentNode) {
                        indicator.parentNode.removeChild(indicator);
                    }
                }, 300);
            }, 2000);
        }
        
        // Show restore indicator
        function showRestoreIndicator() {
            const indicator = document.createElement('div');
            indicator.id = 'restore-indicator';
            indicator.style.cssText = `
                position: fixed;
                top: 20px;
                right: 20px;
                background: #007bff;
                color: white;
                padding: 10px 15px;
                border-radius: 8px;
                font-size: 14px;
                z-index: 1000;
                animation: slideInRight 0.3s ease;
            `;
            indicator.textContent = '📂 State Restored';
            
            document.body.appendChild(indicator);
            
            setTimeout(() => {
                indicator.style.animation = 'slideOutRight 0.3s ease';
                setTimeout(() => {
                    if (indicator.parentNode) {
                        indicator.parentNode.removeChild(indicator);
                    }
                }, 300);
            }, 2000);
        }
        
        // Add CSS animations for indicators
        const style = document.createElement('style');
        style.textContent = `
            @keyframes slideInRight {
                from { transform: translateX(100%); opacity: 0; }
                to { transform: translateX(0); opacity: 1; }
            }
            @keyframes slideOutRight {
                from { transform: translateX(0); opacity: 1; }
                to { transform: translateX(100%); opacity: 0; }
            }
        `;
        document.head.appendChild(style);
        
        // Collapse identical answer chips (keep players, do not drop them)
        function removeDuplicateAnswers() {
            mergeIdenticalAnswerChipsEverywhere();
            updateCountBadges();
        }

        // Auto-save on drag and drop
        function autoSave() {
            setTimeout(() => {
                try {
                    saveGradingState();
                } catch (error) {
                    console.error('Auto-save failed:', error);
                }
            }, 100); // Small delay to ensure DOM is updated
        }
        
        // Initialize when page loads
        document.addEventListener('DOMContentLoaded', () => {
            if (!isEmbedded()) initializeConnection();
            else setupDragAndDrop();
            bindInboxClicks();

            document.addEventListener('dblclick', (e) => {
                const chip = e.target.closest('#uncategorizedAnswers .answer-item');
                if (!chip) return;
                e.preventDefault();
                acceptUncategorizedGuess(chip);
            });
            
            // Auto-save on page unload
            window.addEventListener('beforeunload', () => {
                saveGradingState();
            });
            
            // Auto-save on page hide (for mobile browsers and some popup scenarios)
            window.addEventListener('pagehide', () => {
                saveGradingState();
            });
            
            // Auto-save on visibility change (when tab becomes hidden)
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'hidden') {
                    saveGradingState();
                }
            });
            
            // Auto-save every 10 seconds as backup (more frequent to catch changes)
            setTimeout(() => {
                setInterval(() => {
                    if (currentGame && currentGame.currentQuestionData) {
                        try {
                            saveGradingState();
                        } catch (error) {
                            console.error('Periodic auto-save failed:', error);
                        }
                    }
                }, 10000);
            }, 10000);
        });

        // Simple toast notification function
        function showToast(message, type = 'info') {
            console.log(`🔔 Toast (${type}):`, message);
            // For now, just log to console. Could be enhanced with actual UI toast later.
        }
        
        function normalizeAnswerText(text) {
            return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
        }

        function uniquePlayerNames(names) {
            const unique = [];
            const seen = new Set();
            (names || []).forEach((name) => {
                const trimmed = String(name || '').trim();
                if (!trimmed) return;
                const key = trimmed.toLowerCase();
                if (seen.has(key)) return;
                seen.add(key);
                unique.push(trimmed);
            });
            return unique;
        }

        function chipAnswerText(chip) {
            return chip?.dataset?.answerText || '';
        }

        function playerNamesFromChip(chip) {
            if (!chip) return [];
            const fromData = String(chip.dataset.playerNames || '').split(',').map((s) => s.trim()).filter(Boolean);
            if (fromData.length) return uniquePlayerNames(fromData);
            const el = chip.querySelector('.answer-players');
            if (!el) return [];
            return uniquePlayerNames(String(el.textContent || '').split(','));
        }

        function setChipPlayers(chip, names) {
            if (!chip) return;
            const unique = uniquePlayerNames(names);
            chip.dataset.playerNames = unique.join(', ');
            const playersEl = chip.querySelector('.answer-players');
            if (playersEl) playersEl.textContent = unique.join(', ');
            const badge = chip.querySelector('.answer-count-badge');
            if (badge) badge.textContent = String(unique.length);
        }

        function playerNameMatches(list, playerName) {
            const target = String(playerName || '').trim().toLowerCase();
            if (!target) return false;
            return (list || []).some((name) => String(name).trim().toLowerCase() === target);
        }

        function coalesceAnswerGroups(groups) {
            const map = new Map();
            (groups || []).forEach((group) => {
                const key = normalizeAnswerText(group?.answer);
                if (!key) return;
                if (!map.has(key)) {
                    const players = uniquePlayerNames(group.players || []);
                    map.set(key, {
                        ...group,
                        answer: group.answer,
                        players,
                        count: players.length || group.count || 0
                    });
                    return;
                }
                const keeper = map.get(key);
                keeper.players = uniquePlayerNames([...(keeper.players || []), ...(group.players || [])]);
                keeper.count = keeper.players.length;
            });
            return Array.from(map.values());
        }

        function answerItemContainers() {
            return [
                document.getElementById('correctAnswers'),
                document.getElementById('wrongAnswers'),
                document.getElementById('uncategorizedAnswers'),
                document.getElementById('sendBackAnswers')
            ].filter(Boolean);
        }

        function answerTextsPlacedOutsideUncategorized() {
            const keys = new Set();
            ['wrongAnswers', 'correctAnswers', 'sendBackAnswers'].forEach((id) => {
                const root = document.getElementById(id);
                if (!root) return;
                root.querySelectorAll('.answer-item').forEach((item) => {
                    const key = normalizeAnswerText(chipAnswerText(item));
                    if (key) keys.add(key);
                });
            });
            return keys;
        }

        function mergeIdenticalAnswerChipsIn(container) {
            if (!container) return;
            const byKey = new Map();
            Array.from(container.querySelectorAll('.answer-item')).forEach((item) => {
                const key = normalizeAnswerText(chipAnswerText(item));
                if (!key) return;
                if (!byKey.has(key)) {
                    byKey.set(key, item);
                    return;
                }
                const keeper = byKey.get(key);
                setChipPlayers(keeper, [...playerNamesFromChip(keeper), ...playerNamesFromChip(item)]);
                item.remove();
            });
        }

        function mergeIdenticalAnswerChipsEverywhere() {
            mergeIdenticalAnswerChipsIn(document.getElementById('uncategorizedAnswers'));
            mergeIdenticalAnswerChipsIn(document.getElementById('wrongAnswers'));
            mergeIdenticalAnswerChipsIn(document.getElementById('sendBackAnswers'));
            document.querySelectorAll('#correctAnswers .answer-items').forEach((zone) => mergeIdenticalAnswerChipsIn(zone));
            absorbIdenticalChipsIntoJudgedBuckets();
        }

        function absorbIdenticalChipsIntoJudgedBuckets() {
            const uncategorized = document.getElementById('uncategorizedAnswers');
            const wrong = document.getElementById('wrongAnswers');
            const correctRoot = document.getElementById('correctAnswers');
            if (!uncategorized) return;

            const absorbFrom = (source, targetChip, key) => {
                if (!source || !targetChip) return;
                Array.from(source.querySelectorAll('.answer-item')).forEach((item) => {
                    if (item === targetChip) return;
                    if (normalizeAnswerText(chipAnswerText(item)) !== key) return;
                    setChipPlayers(targetChip, [...playerNamesFromChip(targetChip), ...playerNamesFromChip(item)]);
                    item.remove();
                });
            };

            if (correctRoot) {
                correctRoot.querySelectorAll('.answer-item').forEach((chip) => {
                    const key = normalizeAnswerText(chipAnswerText(chip));
                    if (!key) return;
                    absorbFrom(uncategorized, chip, key);
                    absorbFrom(wrong, chip, key);
                });
            }
            if (wrong) {
                wrong.querySelectorAll('.answer-item').forEach((chip) => {
                    const key = normalizeAnswerText(chipAnswerText(chip));
                    if (!key) return;
                    absorbFrom(uncategorized, chip, key);
                });
            }
        }

        function findChipWithAnswer(normalized) {
            const key = normalizeAnswerText(normalized);
            if (!key) return null;
            const preferred = [
                document.getElementById('correctAnswers'),
                document.getElementById('wrongAnswers'),
                document.getElementById('uncategorizedAnswers')
            ].filter(Boolean);
            for (const root of preferred) {
                for (const item of root.querySelectorAll('.answer-item')) {
                    if (normalizeAnswerText(chipAnswerText(item)) === key) return item;
                }
            }
            return null;
        }

        function findPlayerAnswerCard(playerName) {
            for (const root of answerItemContainers()) {
                for (const item of root.querySelectorAll('.answer-item')) {
                    if (playerNameMatches(playerNamesFromChip(item), playerName)) return item;
                }
            }
            return null;
        }

        function playerCardExists(playerName) {
            return !!findPlayerAnswerCard(playerName);
        }

        function removePlayerFromChip(chip, playerName) {
            if (!chip) return;
            const remaining = playerNamesFromChip(chip).filter((name) => !playerNameMatches([name], playerName));
            if (remaining.length === 0) {
                chip.remove();
                return;
            }
            setChipPlayers(chip, remaining);
        }

        function syncMissingAnswerCards() {
            if (!currentGame || !Array.isArray(currentGame.currentAnswerGroups)) return;
            currentGame.currentAnswerGroups = coalesceAnswerGroups(currentGame.currentAnswerGroups);
            currentGame.currentAnswerGroups.forEach((group) => {
                const answer = group.answer;
                (group.players || []).forEach((playerName) => {
                    if (!playerCardExists(playerName)) {
                        handleAnswerDirectly(playerName, answer, false);
                    }
                });
            });
            mergeIdenticalAnswerChipsEverywhere();
            updateCountBadges();
        }

        function handleAnswerDirectly(playerName, answerText, isClarification = false) {
            console.log(`📝 Direct answer handling: ${playerName} → "${answerText}"`);
            window.recentCardUpdateAt = Date.now();
            const normalized = normalizeAnswerText(answerText);
            removeFromSendBack(playerName);

            const existingForPlayer = findPlayerAnswerCard(playerName);
            if (existingForPlayer) {
                const oldNorm = normalizeAnswerText(chipAnswerText(existingForPlayer));
                if (oldNorm === normalized) {
                    mergeIdenticalAnswerChipsEverywhere();
                    updateCountBadges();
                    window.recentCardUpdateAt = Date.now();
                    return;
                }
                removePlayerFromChip(existingForPlayer, playerName);
            }

            const existingSameText = findChipWithAnswer(normalized);
            if (existingSameText) {
                setChipPlayers(existingSameText, [...playerNamesFromChip(existingSameText), playerName]);
                autoPlaceCardIfCorrect(existingSameText, answerText);
                mergeIdenticalAnswerChipsEverywhere();
                updateCountBadges();
                window.recentCardUpdateAt = Date.now();
                console.log(`✅ Merged "${answerText}" from ${playerName} into existing chip`);
                return;
            }

            const newCard = addAnswerCardToUncategorized(playerName, answerText);
            autoPlaceCardIfCorrect(newCard, answerText);
            mergeIdenticalAnswerChipsEverywhere();
            updateCountBadges();
            window.recentCardUpdateAt = Date.now();
            console.log(`✅ Answer added directly: ${playerName} → "${answerText}"`);
        }

        function removeFromSendBack(playerName) {
            try {
                const sendBack = document.getElementById('sendBackAnswers');
                if (!sendBack) return;
                Array.from(sendBack.querySelectorAll('.answer-item')).forEach((item) => {
                    if (playerNameMatches(playerNamesFromChip(item), playerName)) {
                        removePlayerFromChip(item, playerName);
                        console.log('🧹 Removed old send-back card for', playerName);
                    }
                });
            } catch (e) {
                console.warn('removeFromSendBack failed:', e);
            }
        }

        function updatePlayerAnswerCard(answerCard, newAnswerText) {
            const answerTextElement = answerCard.querySelector('.answer-text');
            if (answerTextElement) {
                const countBadge = answerTextElement.querySelector('.answer-count-badge');
                const countText = countBadge ? countBadge.textContent : '1';
                answerTextElement.innerHTML = `"${newAnswerText}" <span class="answer-count-badge">${countText}</span>`;
            }
            answerCard.dataset.answerText = newAnswerText;
        }

        function addAnswerCardToUncategorized(playerName, answerText) {
            const uncategorizedContainer = document.getElementById('uncategorizedAnswers');
            if (!uncategorizedContainer) {
                console.error('❌ Uncategorized container not found');
                return null;
            }

            const existing = Array.from(uncategorizedContainer.querySelectorAll('.answer-item'))
                .find((item) => normalizeAnswerText(chipAnswerText(item)) === normalizeAnswerText(answerText));
            if (existing) {
                setChipPlayers(existing, [...playerNamesFromChip(existing), playerName]);
                return existing;
            }

            const answerCard = document.createElement('div');
            answerCard.className = 'answer-item';
            answerCard.draggable = true;
            answerCard.dataset.answerText = answerText;
            answerCard.dataset.playerNames = playerName;

            const guess = guessForAnswer(answerText);
            const confidenceColor = (guess.bestConfidence || 0) >= 80 ? '#27ae60' :
                (guess.bestConfidence || 0) >= 50 ? '#f39c12' : '#e74c3c';
            const confidenceDisplay = guess.bestMatch
                ? `<div class="answer-confidence" style="color: ${confidenceColor}; font-size: 11px; margin-top: 3px;">🧠 ${guess.bestConfidence}% → "${guess.bestMatch}"</div>`
                : '';

            answerCard.innerHTML = `
                <div class="answer-text">"${answerText}" <span class="answer-count-badge">1</span></div>
                <div class="answer-players">${playerName}</div>
                ${confidenceDisplay}
            `;
            applyGuessToChip(answerCard, answerText, guess.bestMatch, guess.bestConfidence);

            uncategorizedContainer.appendChild(answerCard);
            setupDragAndDrop();
            console.log(`📝 Added answer card: "${answerText}" by ${playerName}`);
            return answerCard;
        }

        function autoPlaceCardIfCorrect(answerCard, answerText) {
            try {
                const correctAnswers = (currentGame && currentGame.currentQuestionData && Array.isArray(currentGame.currentQuestionData.correct_answers))
                    ? currentGame.currentQuestionData.correct_answers
                    : [];
                const normalized = String(answerText || '').toLowerCase().trim();
                const match = correctAnswers.find(c => String(c || '').toLowerCase().trim() === normalized);
                if (!match) {
                    console.log('ℹ️ No exact correct-answer match for', answerText);
                    return false;
                }
                const bucketDomId = `bucket-${match.toLowerCase().replace(/\s+/g, '-')}`;
                let bucket = document.getElementById(bucketDomId);
                let dropZone = bucket ? bucket.querySelector('.answer-items') : null;
                if (!dropZone) {
                    // Create the bucket on-the-fly if missing
                    const correctAnswersRoot = document.getElementById('correctAnswers');
                    if (correctAnswersRoot) {
                        bucket = document.createElement('div');
                        bucket.className = 'answer-bucket correct-bucket empty';
                        bucket.id = bucketDomId;
                        bucket.innerHTML = `
                            <h4 onclick="toggleBucket(this)">
                                <span class="bucket-toggle collapsed">▶</span>
                                ${match} <span class="answer-count-badge">0</span>
                            </h4>
                            <div class="answer-items collapsed" data-bucket="correct_${match.toLowerCase().replace(/\s+/g, '_')}"></div>
                        `;
                        correctAnswersRoot.appendChild(bucket);
                        dropZone = bucket.querySelector('.answer-items');
                    }
                }
                if (!dropZone) {
                    console.log('⚠️ Target bucket drop zone still not found for', bucketDomId);
                    return false;
                }
                if (answerCard.parentElement !== dropZone) {
                    dropZone.appendChild(answerCard);
                    if (!keepInboxCorrectCollapsed(bucket, dropZone)) {
                        const header = bucket.querySelector('h4');
                        const toggle = header ? header.querySelector('.bucket-toggle') : null;
                        dropZone.classList.remove('collapsed');
                        if (toggle) toggle.classList.remove('collapsed');
                        bucket.classList.add('is-open');
                    }
                    mergeIdenticalAnswerChipsIn(dropZone);
                    updateCountBadges();
                    console.log(`✅ Auto-matched "${answerText}" to correct bucket "${match}"`);
                }
                return true;
            } catch (e) {
                console.error('❌ autoPlaceCardIfCorrect failed:', e);
                return false;
            }
        }

        // Re-sync function to refresh game data
        async function resyncGameData() {
            console.log('🔄 Re-syncing game data...');
            
            if (!currentGame || !currentGame.gameCode) {
                console.error('❌ No current game to re-sync');
                showToast('No active game to re-sync', 'error');
                return;
            }

            try {
                // Show loading state
                const resyncBtn = document.getElementById('resyncBtn');
                const originalText = resyncBtn.textContent;
                resyncBtn.textContent = '🔄 Syncing...';
                resyncBtn.disabled = true;

                discardGradingDraft();
                if (isEmbedded()) {
                    applyEmbeddedState(currentGame, { applied: true, epochChanged: true });
                }
                socket.emit('requestState', { gameCode: currentGame.gameCode });
                socket.emit('getGameState', { gameCode: currentGame.gameCode });
                
                // Also try to get active games as a fallback
                socket.emit('getActiveGames');
                
                console.log('🔗 Emitting getActiveGames as fallback');
                
                // Wait a bit for server response; gameStateResponse rebuilds the board
                await new Promise(resolve => setTimeout(resolve, 1000));
                
                if (currentGame && currentGame.currentQuestionData) {
                    await updateGradingInterface(true);
                    showToast('Game data re-synced successfully!', 'success');
                } else {
                    showToast('Failed to re-sync game data', 'error');
                }

            } catch (error) {
                console.error('❌ Re-sync failed:', error);
                showToast('Re-sync failed: ' + error.message, 'error');
            } finally {
                // Restore button state
                const resyncBtn = document.getElementById('resyncBtn');
                resyncBtn.textContent = originalText;
                resyncBtn.disabled = false;
            }
        }

        // Enhanced fallback logic for missing data
        function applyFallbackLogic() {
            console.log('🛡️ Applying fallback logic for missing data...');
            
            if (!currentGame) {
                console.warn('⚠️ No current game, cannot apply fallbacks');
                return;
            }

            // Do not reconstruct answer groups from localStorage — that rehydrates the wrong question.

            // Fallback 2: If question data is missing, try to get from URL or localStorage
            if (!currentGame.currentQuestionData) {
                console.log('🔄 Fallback: Reconstructing question data...');
                
                const urlParams = new URLSearchParams(window.location.search);
                const questionIndex = urlParams.get('question') || currentGame.currentQuestionIndex || 0;
                
                // Try to get from localStorage
                const savedState = localStorage.getItem(`gradingState_${currentGame.gameCode}_${questionIndex}`);
                if (savedState) {
                    try {
                        const parsed = JSON.parse(savedState);
                        if (parsed.questionData) {
                            currentGame.currentQuestionData = parsed.questionData;
                            console.log('✅ Restored question data from localStorage');
                        }
                    } catch (e) {
                        console.error('❌ Failed to parse saved question data:', e);
                    }
                }
            }

            // Fallback 3: If game state is completely missing, try to reconnect
            if (!currentGame.gameCode) {
                console.log('🔄 Fallback: Attempting to reconnect...');
                socket.emit('getActiveGames');
            }
        }

        // Enhanced error handling for missing data
        function handleMissingData() {
            console.log('🔍 Checking for missing data...');
            
            const hasAnswerGroups = currentGame && currentGame.currentAnswerGroups && currentGame.currentAnswerGroups.length > 0;
            const hasQuestionData = currentGame && currentGame.currentQuestionData;
            
            if (!hasAnswerGroups || !hasQuestionData) {
                console.warn('⚠️ Missing critical data, applying fallbacks...');
                applyFallbackLogic();
                
                // Show user-friendly message
                const message = !hasAnswerGroups && !hasQuestionData ? 
                    'Missing game data. Click Re-sync to refresh.' :
                    !hasAnswerGroups ? 'Missing answer data. Click Re-sync to refresh.' :
                    'Missing question data. Click Re-sync to refresh.';
                
                showToast(message, 'warning');
            }
        }

        // Enhanced populateGradingInterface with fallback support
        const originalPopulateGradingInterface = populateGradingInterface;
        populateGradingInterface = async function() {
            try {
                // Check for missing data before proceeding
                handleMissingData();
                
                // Call original function
                await originalPopulateGradingInterface();
                
            } catch (error) {
                console.error('❌ populateGradingInterface failed:', error);
                
                // Apply fallback logic
                applyFallbackLogic();
                
                // Try again with fallback data
                try {
                    await originalPopulateGradingInterface();
                } catch (fallbackError) {
                    console.error('❌ Even fallback failed:', fallbackError);
                    showToast('Failed to load grading interface. Please re-sync.', 'error');
                }
            }
        };


    function applyEmbeddedState(state, result) {
        if (!state || !state.gameCode) return;
        currentGame = state;
        try { applyQuestionIndex(state); } catch (_) {}
        if (Array.isArray(currentGame.currentAnswerGroups)) {
            currentGame.currentAnswerGroups = coalesceAnswerGroups(currentGame.currentAnswerGroups);
        } else {
            currentGame.currentAnswerGroups = [];
        }

        const phase = state.gameState;
        if (phase === 'scoring' || phase === 'roundComplete' || phase === 'overallLeaderboard' || phase === 'finished') {
            discardGradingDraft();
            return;
        }
        if (phase !== 'playing' && phase !== 'grading') return;

        showGradingWorkspace();
        updatePendingEditsBanner(state);

        const draftKey = state.gameCode + ':' + getCurrentQuestionIndex();
        if (draftKey !== gradingDraftEpoch) {
            gradingDraftEpoch = draftKey;
            lastRenderedQuestionIndex = null;
            clearGradingBuckets();
            try { updateGradingInterface(true); } catch (e) {
                console.warn('grading epoch render failed', e);
            }
            return;
        }
        try { syncMissingAnswerCards(); } catch (_) {}
    }

    global.toggleBucket = toggleBucket;
    if (typeof resyncGameData === 'function') global.resyncGameData = resyncGameData;
    if (typeof manualOpenGrading === 'function') global.manualOpenGrading = manualOpenGrading;
    if (typeof connectToManualGame === 'function') global.connectToManualGame = connectToManualGame;

    global.MEGASheepGrading = {
        attach: function (opts) {
            if (opts && opts.socket) socket = opts.socket;
            try { setupDragAndDrop(); } catch (_) {}
            try { bindInboxClicks(); } catch (_) {}
        },
        apply: function (state, result) {
            applyEmbeddedState(state, result || { applied: true, epochChanged: true });
        },
        discard: function () {
            try { discardGradingDraft(); } catch (_) {}
        }
    };
})(window);
