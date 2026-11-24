'use strict';

const PLAYER_DISCONNECT_GRACE_MS = 45000;
const EMPTY_GAME_TTL_MS = 2 * 60 * 1000;
const PAIRING_TTL_MS = 30 * 60 * 1000;
const DISPLAY_CODE_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function generateDisplayPairingCode() {
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += DISPLAY_CODE_LETTERS[Math.floor(Math.random() * DISPLAY_CODE_LETTERS.length)];
  }
  return code;
}

function prunePairings(pairings, now = Date.now()) {
  if (!pairings) return;
  for (const [code, entry] of pairings.entries()) {
    const stamp = (entry && (entry.lastSeen || entry.createdAt)) || 0;
    if (!entry || (now - stamp) > PAIRING_TTL_MS) pairings.delete(code);
  }
}

function findPairingByDisplayId(pairings, displayId) {
  if (!pairings || !displayId) return null;
  for (const [code, entry] of pairings.entries()) {
    if (entry && entry.displayId === displayId) return { code, entry };
  }
  return null;
}

function issueOrReusePairing(pairings, {
  socketId,
  displayId,
  now = Date.now(),
  generateCode = generateDisplayPairingCode
} = {}) {
  prunePairings(pairings, now);
  if (displayId) {
    const existing = findPairingByDisplayId(pairings, displayId);
    if (existing) {
      existing.entry.socketId = socketId;
      existing.entry.lastSeen = now;
      return {
        code: existing.code,
        reused: true,
        paired: !!existing.entry.gameCode,
        gameCode: existing.entry.gameCode || null,
        entry: existing.entry
      };
    }
  }
  let code;
  do { code = generateCode(); } while (pairings.has(code));
  const entry = {
    socketId,
    displayId: displayId || null,
    createdAt: now,
    lastSeen: now,
    gameCode: null
  };
  pairings.set(code, entry);
  return { code, reused: false, paired: false, gameCode: null, entry };
}

function bindPairingToGame(pairings, pairingCode, gameCode, socketId, now = Date.now()) {
  const code = String(pairingCode || '').toUpperCase();
  const entry = pairings.get(code);
  if (!entry) return null;
  entry.gameCode = gameCode;
  if (socketId) entry.socketId = socketId;
  entry.lastSeen = now;
  return entry;
}

function rebindPairingSocket(pairings, { socketId, displayId, now = Date.now() } = {}) {
  const found = findPairingByDisplayId(pairings, displayId);
  if (!found) return null;
  found.entry.socketId = socketId;
  found.entry.lastSeen = now;
  return found;
}

function forgetSocketPairings(pairings, socketId) {
  if (!pairings || !socketId) return;
  for (const [code, entry] of pairings.entries()) {
    if (!entry || entry.socketId !== socketId) continue;
    if (entry.gameCode || entry.displayId) continue;
    pairings.delete(code);
  }
}

function shouldKeepGameAlive({ hostConnected, displayConnected, seatedPlayers }) {
  if (hostConnected || displayConnected) return true;
  return Number(seatedPlayers) > 0;
}

function bindConnectionInfo(connectedPlayers, socketId, patch) {
  const info = connectedPlayers.get(socketId) || { id: socketId, connectedAt: Date.now() };
  Object.assign(info, patch || {});
  connectedPlayers.set(socketId, info);
  return info;
}

function isSocketLive(io, socketId) {
  return !!(io && io.sockets && io.sockets.sockets && io.sockets.sockets.get(socketId));
}

function liveRoleConnected(connectedPlayers, io, gameCode, predicate) {
  for (const [sid, info] of connectedPlayers.entries()) {
    if (!info || info.gameCode !== gameCode) continue;
    if (!isSocketLive(io, sid)) continue;
    if (typeof predicate === 'function' ? predicate(info) : true) return true;
  }
  return false;
}

module.exports = {
  PLAYER_DISCONNECT_GRACE_MS,
  EMPTY_GAME_TTL_MS,
  PAIRING_TTL_MS,
  generateDisplayPairingCode,
  prunePairings,
  findPairingByDisplayId,
  issueOrReusePairing,
  bindPairingToGame,
  rebindPairingSocket,
  forgetSocketPairings,
  shouldKeepGameAlive,
  bindConnectionInfo,
  isSocketLive,
  liveRoleConnected
};
