'use strict';

function gameEpoch(gameCode, currentQuestion, gameState) {
  const q = (typeof currentQuestion === 'number' && !Number.isNaN(currentQuestion)) ? currentQuestion : 0;
  return `${gameCode || ''}:${q}:${gameState || 'waiting'}`;
}

function isLiveAnsweringPhase(phase) {
  return phase === 'playing' || phase === 'grading';
}

function answersReceivedFromState(state) {
  if (typeof state.answersReceived === 'number') return state.answersReceived;
  const groups = Array.isArray(state.currentAnswerGroups) ? state.currentAnswerGroups : [];
  return groups.reduce((sum, g) => {
    if (Array.isArray(g.players)) return sum + g.players.length;
    if (typeof g.count === 'number') return sum + g.count;
    return sum;
  }, 0);
}

function answeredPlayersFromState(state) {
  const seen = new Set();
  const out = [];
  function add(id, name) {
    const n = String(name || '').trim();
    if (!n) return;
    const key = n.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ id: String(id || n), name: n });
  }

  const players = Array.isArray(state && state.players) ? state.players : [];
  const byId = new Map();
  players.forEach((p) => {
    if (!p) return;
    if (p.id) byId.set(String(p.id), p);
    if (p.stableId) byId.set(String(p.stableId), p);
  });

  const bySocket = state && state.answersBySocket && typeof state.answersBySocket === 'object'
    ? state.answersBySocket
    : null;
  if (bySocket) {
    Object.keys(bySocket).forEach((sid) => {
      const p = byId.get(String(sid));
      add(p && (p.stableId || p.id) ? (p.stableId || p.id) : sid, p && p.name);
    });
  }

  const groups = Array.isArray(state && state.currentAnswerGroups) ? state.currentAnswerGroups : [];
  groups.forEach((group) => {
    const names = Array.isArray(group && group.players) ? group.players : [];
    names.forEach((name) => add(name, name));
  });

  return out;
}

function publicPlayersFromState(state) {
  const players = Array.isArray(state && state.players) ? state.players : [];
  return players.map((p) => ({
    id: p && p.id,
    stableId: p && p.stableId,
    name: p && p.name,
    score: p && p.score,
    isVirtual: !!(p && p.isVirtual)
  }));
}

function findMyAnswer(state, viewer) {
  if (!state || !viewer) return null;
  if (state.answersBySocket && viewer.socketId && state.answersBySocket[viewer.socketId] != null) {
    return String(state.answersBySocket[viewer.socketId]);
  }
  const name = String(viewer.playerName || '').toLowerCase();
  if (!name) return null;
  const groups = Array.isArray(state.currentAnswerGroups) ? state.currentAnswerGroups : [];
  for (const group of groups) {
    const players = Array.isArray(group.players) ? group.players : [];
    if (players.some((p) => String(p || '').toLowerCase() === name)) {
      return group.answer != null ? String(group.answer) : null;
    }
  }
  return null;
}

function viewerRoleFromInfo(info) {
  if (!info) return 'player';
  if (info.isHost) return 'host';
  if (info.isGradingInterface) return 'grading';
  if (info.isDisplay) return 'display';
  return 'player';
}

/**
 * Role-redacted copy of a full getGameState() snapshot.
 * Host/grading keep everything. Player/display never see live answers during play/grading.
 */
function redactStateForViewer(state, viewer) {
  if (!state || typeof state !== 'object') return state;
  const role = (viewer && viewer.role) || 'player';
  const view = { ...state, viewerRole: role };
  delete view.hostToken;
  delete view.answersBySocket;

  if (role === 'host' || role === 'grading') {
    view.answersReceived = answersReceivedFromState(state);
    return view;
  }

  const live = isLiveAnsweringPhase(state.gameState);
  view.answersReceived = answersReceivedFromState(state);

  if (role === 'display') {
    view.pendingEdits = [];
    view.myAnswer = null;
    view.myPendingEdit = null;
    view.players = publicPlayersFromState(state);
    view.answeredPlayers = answeredPlayersFromState(state);
    if (live) {
      view.currentAnswerGroups = [];
      view.categorizationData = null;
    }
    return view;
  }

  const name = String((viewer && viewer.playerName) || '').toLowerCase();
  const sid = viewer && viewer.socketId;
  const pending = Array.isArray(state.pendingEdits) ? state.pendingEdits : [];
  const mine = pending.filter((p) => {
    if (!p) return false;
    if (sid && p.socketId === sid) return true;
    if (name && String(p.playerName || '').toLowerCase() === name) return true;
    return false;
  });
  view.pendingEdits = mine;
  view.myPendingEdit = mine[0] || null;
  view.myAnswer = findMyAnswer(state, viewer);

  if (live) {
    view.currentAnswerGroups = [];
    view.categorizationData = null;
  }
  return view;
}

function applyServerState(packet, ctx) {
  const box = ctx || {};
  if (!packet || typeof packet !== 'object') {
    return { applied: false, epochChanged: false, reason: 'empty', state: null };
  }
  if (packet.gameCode && box.lastGameCode && packet.gameCode !== box.lastGameCode) {
    box.lastSeq = -1;
    box.lastEpoch = '';
  }
  if (packet.gameCode) box.lastGameCode = packet.gameCode;

  const seq = Number(packet.seq);
  const lastSeq = Number(box.lastSeq);
  if (Number.isFinite(seq) && Number.isFinite(lastSeq) && seq <= lastSeq) {
    return { applied: false, epochChanged: false, reason: 'stale', state: packet };
  }
  const epoch = typeof packet.epoch === 'string' ? packet.epoch : '';
  const epochChanged = !!(epoch && epoch !== box.lastEpoch);
  if (Number.isFinite(seq)) box.lastSeq = seq;
  if (epoch) box.lastEpoch = epoch;
  return { applied: true, epochChanged, reason: 'ok', state: packet };
}

module.exports = {
  gameEpoch,
  isLiveAnsweringPhase,
  answersReceivedFromState,
  answeredPlayersFromState,
  findMyAnswer,
  viewerRoleFromInfo,
  redactStateForViewer,
  applyServerState
};
