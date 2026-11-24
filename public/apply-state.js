(function (root) {
  'use strict';

  function gameEpoch(gameCode, currentQuestion, gameState) {
    var q = (typeof currentQuestion === 'number' && !isNaN(currentQuestion)) ? currentQuestion : 0;
    return (gameCode || '') + ':' + q + ':' + (gameState || 'waiting');
  }

  function applyServerState(packet, ctx) {
    var box = ctx || {};
    if (!packet || typeof packet !== 'object') {
      return { applied: false, epochChanged: false, reason: 'empty', state: null };
    }
    if (packet.gameCode && box.lastGameCode && packet.gameCode !== box.lastGameCode) {
      box.lastSeq = -1;
      box.lastEpoch = '';
    }
    if (packet.gameCode) box.lastGameCode = packet.gameCode;

    var seq = Number(packet.seq);
    var lastSeq = Number(box.lastSeq);
    var resync = packet.resync === true;
    if (!resync && isFinite(seq) && isFinite(lastSeq) && seq <= lastSeq) {
      return { applied: false, epochChanged: false, reason: 'stale', state: packet };
    }
    var epoch = typeof packet.epoch === 'string' ? packet.epoch : '';
    var epochChanged = !!(epoch && epoch !== box.lastEpoch);
    if (isFinite(seq)) box.lastSeq = seq;
    if (epoch) box.lastEpoch = epoch;
    return { applied: true, epochChanged: epochChanged, reason: resync ? 'resync' : 'ok', state: packet };
  }

  function unwrapGameState(data) {
    if (!data || typeof data !== 'object') return null;
    if (typeof data.gameCode === 'string' && /^\d{4}$/.test(data.gameCode)) return data;
    if (data.gameState && typeof data.gameState === 'object' && data.gameState.gameCode) return data.gameState;
    return null;
  }

  root.MEGASheepLockstep = {
    gameEpoch: gameEpoch,
    applyServerState: applyServerState,
    unwrapGameState: unwrapGameState
  };
})(typeof window !== 'undefined' ? window : globalThis);
