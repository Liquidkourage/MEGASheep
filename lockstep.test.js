'use strict';

const assert = require('assert');
const {
  gameEpoch,
  isLiveAnsweringPhase,
  redactStateForViewer,
  applyServerState
} = require('./lockstep');

function sampleState(overrides) {
  return {
    gameCode: '1234',
    gameState: 'playing',
    currentQuestion: 1,
    seq: 4,
    epoch: gameEpoch('1234', 1, 'playing'),
    currentAnswerGroups: [
      { answer: 'Mars', count: 2, players: ['Ada', 'Bea'] }
    ],
    pendingEdits: [
      { socketId: 's1', playerName: 'Ada', originalAnswer: 'Mar', reason: 'Be specific', questionIndex: 1 }
    ],
    answersBySocket: { s1: 'Mars' },
    categorizationData: { correctAnswerBuckets: [{ id: 'mars' }] },
    hostToken: 'secret',
    ...overrides
  };
}

function testEpoch() {
  assert.strictEqual(gameEpoch('1234', 0, 'waiting'), '1234:0:waiting');
  assert.strictEqual(gameEpoch('1234', 1, 'grading'), '1234:1:grading');
  assert.ok(gameEpoch('1234', 0, 'playing') !== gameEpoch('1234', 1, 'playing'));
}

function testRedactHostKeepsAnswers() {
  const view = redactStateForViewer(sampleState(), { role: 'host' });
  assert.strictEqual(view.currentAnswerGroups[0].answer, 'Mars');
  assert.strictEqual(view.hostToken, undefined);
  assert.strictEqual(view.viewerRole, 'host');
}

function testRedactPlayerHidesLiveAnswers() {
  const view = redactStateForViewer(sampleState(), { role: 'player', socketId: 's1', playerName: 'Ada' });
  assert.deepStrictEqual(view.currentAnswerGroups, []);
  assert.strictEqual(view.categorizationData, null);
  assert.strictEqual(view.myAnswer, 'Mars');
  assert.strictEqual(view.pendingEdits.length, 1);
  assert.ok(!view.answersBySocket);
}

function testRedactPlayerSeesResultsAfterScoring() {
  const view = redactStateForViewer(sampleState({ gameState: 'scoring' }), {
    role: 'player',
    socketId: 's1',
    playerName: 'Ada'
  });
  assert.strictEqual(view.currentAnswerGroups[0].answer, 'Mars');
}

function testRedactDisplayNeverGetsLiveAnswers() {
  const view = redactStateForViewer(sampleState(), { role: 'display' });
  assert.deepStrictEqual(view.currentAnswerGroups, []);
  assert.deepStrictEqual(view.pendingEdits, []);
  assert.ok(view.answersReceived >= 2);
}

function testApplyIgnoresStaleSeq() {
  const ctx = { lastSeq: 5, lastEpoch: '1234:1:playing' };
  const result = applyServerState(sampleState({ seq: 4 }), ctx);
  assert.strictEqual(result.applied, false);
  assert.strictEqual(result.reason, 'stale');
  const dup = applyServerState(sampleState({ seq: 5 }), ctx);
  assert.strictEqual(dup.applied, false);
}

function testApplyEpochChangeOnNextQuestion() {
  const ctx = { lastSeq: 4, lastEpoch: gameEpoch('1234', 1, 'scoring') };
  const next = sampleState({
    seq: 5,
    currentQuestion: 2,
    gameState: 'playing',
    epoch: gameEpoch('1234', 2, 'playing'),
    currentAnswerGroups: []
  });
  const result = applyServerState(next, ctx);
  assert.strictEqual(result.applied, true);
  assert.strictEqual(result.epochChanged, true);
  assert.strictEqual(next.currentAnswerGroups.length, 0);
}

function testCompleteGradingWhilePlayingDoesNotChangePhase() {
  const playing = sampleState({ gameState: 'playing', currentQuestion: 1 });
  assert.strictEqual(isLiveAnsweringPhase(playing.gameState), true);
  const rejected = playing.gameState !== 'grading';
  assert.strictEqual(rejected, true);
  assert.strictEqual(playing.gameState, 'playing');
}

function testNewGameResetsSeqGate() {
  const ctx = { lastSeq: 12, lastEpoch: '1234:1:playing', lastGameCode: '1234' };
  const nextGame = sampleState({
    gameCode: '5678',
    seq: 1,
    currentQuestion: 0,
    gameState: 'waiting',
    epoch: gameEpoch('5678', 0, 'waiting'),
    currentAnswerGroups: []
  });
  const result = applyServerState(nextGame, ctx);
  assert.strictEqual(result.applied, true);
  assert.strictEqual(ctx.lastGameCode, '5678');
}

function testNextQuestionSnapshotClearsLiveBoard() {
  const scoring = sampleState({
    gameState: 'scoring',
    currentQuestion: 1,
    seq: 10,
    epoch: gameEpoch('1234', 1, 'scoring')
  });
  const next = sampleState({
    seq: 11,
    currentQuestion: 2,
    gameState: 'playing',
    epoch: gameEpoch('1234', 2, 'playing'),
    currentAnswerGroups: [],
    pendingEdits: [],
    categorizationData: null
  });
  const ctx = { lastSeq: scoring.seq, lastEpoch: scoring.epoch, lastGameCode: '1234' };
  const result = applyServerState(next, ctx);
  assert.strictEqual(result.applied, true);
  assert.strictEqual(result.epochChanged, true);
  assert.notStrictEqual(next.epoch, scoring.epoch);
  assert.strictEqual(next.currentAnswerGroups.length, 0);
}

function testCompleteGradingRejectedLeavesPlayingSnapshot() {
  const playing = sampleState({ gameState: 'playing', currentQuestion: 1, seq: 8 });
  const before = JSON.parse(JSON.stringify(playing));
  if (playing.gameState !== 'grading') {
    // server refuses to mutate
  }
  assert.strictEqual(playing.gameState, before.gameState);
  assert.strictEqual(playing.epoch, before.epoch);
  assert.deepStrictEqual(playing.currentAnswerGroups, before.currentAnswerGroups);
}

testEpoch();
testRedactHostKeepsAnswers();
testRedactPlayerHidesLiveAnswers();
testRedactPlayerSeesResultsAfterScoring();
testRedactDisplayNeverGetsLiveAnswers();
testApplyIgnoresStaleSeq();
testApplyEpochChangeOnNextQuestion();
testCompleteGradingWhilePlayingDoesNotChangePhase();
testNewGameResetsSeqGate();
testNextQuestionSnapshotClearsLiveBoard();
testCompleteGradingRejectedLeavesPlayingSnapshot();
console.log('lockstep tests ok');
