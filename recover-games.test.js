'use strict';

const assert = require('assert');
const {
    parseDiskSnapshotName,
    groupDiskSnapshotFiles,
    summarizeSnapshot,
    summarizeLiveGame,
    mergeRecoverableGames,
    RECOVERABLE_MAX_AGE_MS
} = require('./recover-games');

function testParseDiskSnapshotName() {
    const parsed = parseDiskSnapshotName('5865__question_complete__2026-11-23T17-05-01-123Z.json');
    assert.ok(parsed);
    assert.strictEqual(parsed.gameCode, '5865');
    assert.strictEqual(parsed.phase, 'question_complete');
    assert.strictEqual(parsed.atMs, Date.parse('2026-11-23T17:05:01.123Z'));
}

function testGroupKeepsLatestPerCode() {
    const grouped = groupDiskSnapshotFiles([
        '1111__game_created__2026-11-23T10-00-00-000Z.json',
        '1111__question_started__2026-11-23T10-20-00-000Z.json',
        '2222__waiting__2026-11-23T09-00-00-000Z.json',
        'notes.txt'
    ]);
    const byCode = Object.fromEntries(grouped.map((row) => [row.gameCode, row]));
    assert.strictEqual(byCode['1111'].phase, 'question_started');
    assert.strictEqual(byCode['2222'].gameCode, '2222');
    assert.strictEqual(grouped.length, 2);
}

function testSummarizeSnapshotReadsPlayers() {
    const summary = summarizeSnapshot({
        game_code: '4242',
        phase: 'playing',
        at: '2026-11-23T18:00:00.000Z',
        snapshot: {
            gameCode: '4242',
            gameState: 'playing',
            currentRound: 2,
            currentQuestion: 7,
            players: [{ name: 'Ada' }, { name: 'Bess' }, { name: 'Cal' }]
        }
    });
    assert.strictEqual(summary.gameCode, '4242');
    assert.strictEqual(summary.playerCount, 3);
    assert.strictEqual(summary.currentRound, 2);
    assert.strictEqual(summary.gameState, 'playing');
}

function testMergePrefersLiveAndDropsStale() {
    const now = Date.parse('2026-11-23T18:00:00.000Z');
    const merged = mergeRecoverableGames({
        now,
        live: [
            summarizeLiveGame({
                gameCode: '1001',
                gameState: 'waiting',
                playerCount: 4,
                createdAt: now - (RECOVERABLE_MAX_AGE_MS * 2)
            })
        ],
        snapshots: [
            {
                gameCode: '1001',
                gameState: 'playing',
                playerCount: 2,
                savedAtMs: now - 1000,
                savedAt: new Date(now - 1000).toISOString()
            },
            {
                gameCode: '2002',
                gameState: 'grading',
                playerCount: 8,
                savedAtMs: now - 60 * 1000,
                savedAt: new Date(now - 60 * 1000).toISOString()
            },
            {
                gameCode: '3003',
                gameState: 'finished',
                playerCount: 12,
                savedAtMs: now - RECOVERABLE_MAX_AGE_MS - 1000,
                savedAt: new Date(now - RECOVERABLE_MAX_AGE_MS - 1000).toISOString()
            }
        ]
    });
    assert.strictEqual(merged.length, 2);
    assert.strictEqual(merged[0].gameCode, '1001');
    assert.strictEqual(merged[0].live, true);
    assert.strictEqual(merged[0].playerCount, 4);
    assert.strictEqual(merged[1].gameCode, '2002');
    assert.strictEqual(merged[1].live, false);
}

testParseDiskSnapshotName();
testGroupKeepsLatestPerCode();
testSummarizeSnapshotReadsPlayers();
testMergePrefersLiveAndDropsStale();
console.log('recover-games tests passed');
