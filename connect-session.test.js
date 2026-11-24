'use strict';

const assert = require('assert');
const {
  shouldKeepGameAlive,
  issueOrReusePairing,
  bindPairingToGame,
  rebindPairingSocket,
  PAIRING_TTL_MS
} = require('./connect-session');

function testKeepGameWhileHostIsLive() {
  assert.strictEqual(shouldKeepGameAlive({
    hostConnected: true,
    displayConnected: false,
    seatedPlayers: 0
  }), true);
}

function testKeepGameWhileDisplayIsLive() {
  assert.strictEqual(shouldKeepGameAlive({
    hostConnected: false,
    displayConnected: true,
    seatedPlayers: 0
  }), true);
}

function testKeepGameWhilePlayersSeated() {
  assert.strictEqual(shouldKeepGameAlive({
    hostConnected: false,
    displayConnected: false,
    seatedPlayers: 1
  }), true);
}

function testDropAbandonedGame() {
  assert.strictEqual(shouldKeepGameAlive({
    hostConnected: false,
    displayConnected: false,
    seatedPlayers: 0
  }), false);
}

function testReuseUnpairedDisplayCode() {
  const pairings = new Map();
  const first = issueOrReusePairing(pairings, { socketId: 's1', displayId: 'd1', generateCode: () => 'ABCD' });
  assert.strictEqual(first.code, 'ABCD');
  const second = issueOrReusePairing(pairings, { socketId: 's2', displayId: 'd1', generateCode: () => 'WXYZ' });
  assert.strictEqual(second.code, 'ABCD');
  assert.strictEqual(second.reused, true);
  assert.strictEqual(second.entry.socketId, 's2');
}

function testPairedDisplayKeepsGameCodeAcrossSocketChange() {
  const pairings = new Map();
  const issued = issueOrReusePairing(pairings, { socketId: 's1', displayId: 'tv1', generateCode: () => 'QWER' });
  bindPairingToGame(pairings, issued.code, '1234', 's1');
  const rebound = rebindPairingSocket(pairings, { socketId: 's9', displayId: 'tv1' });
  assert.ok(rebound);
  assert.strictEqual(rebound.entry.gameCode, '1234');
  assert.strictEqual(rebound.entry.socketId, 's9');
  const again = issueOrReusePairing(pairings, { socketId: 's9', displayId: 'tv1', generateCode: () => 'ZZZZ' });
  assert.strictEqual(again.paired, true);
  assert.strictEqual(again.gameCode, '1234');
  assert.strictEqual(again.code, 'QWER');
}

function testExpiredPairingIsReissued() {
  const pairings = new Map();
  const stale = Date.now() - PAIRING_TTL_MS - 1000;
  pairings.set('OLDX', { socketId: 's1', displayId: 'd1', createdAt: stale, lastSeen: stale, gameCode: null });
  const next = issueOrReusePairing(pairings, { socketId: 's2', displayId: 'd1', generateCode: () => 'NEWX' });
  assert.strictEqual(next.code, 'NEWX');
  assert.strictEqual(next.reused, false);
  assert.ok(!pairings.has('OLDX'));
}

testKeepGameWhileHostIsLive();
testKeepGameWhileDisplayIsLive();
testKeepGameWhilePlayersSeated();
testDropAbandonedGame();
testReuseUnpairedDisplayCode();
testPairedDisplayKeepsGameCodeAcrossSocketChange();
testExpiredPairingIsReissued();
console.log('connect-session tests ok');
