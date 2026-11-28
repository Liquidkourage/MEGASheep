'use strict';

const RECOVERABLE_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const DISK_SNAPSHOT_NAME = /^(\d{4})__(.+)__(.+)\.json$/i;

function diskTimestampToMs(raw) {
    const text = String(raw || '');
    const withMs = text.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/);
    if (withMs) {
        return Date.parse(`${withMs[1]}T${withMs[2]}:${withMs[3]}:${withMs[4]}.${withMs[5]}Z`) || 0;
    }
    const noMs = text.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z$/);
    if (noMs) {
        return Date.parse(`${noMs[1]}T${noMs[2]}:${noMs[3]}:${noMs[4]}.000Z`) || 0;
    }
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) ? parsed : 0;
}

function parseDiskSnapshotName(filename) {
    const match = String(filename || '').match(DISK_SNAPSHOT_NAME);
    if (!match) return null;
    const atMs = diskTimestampToMs(match[3]);
    return {
        filename: String(filename),
        gameCode: match[1],
        phase: match[2],
        atRaw: match[3],
        atMs
    };
}

function groupDiskSnapshotFiles(filenames) {
    const latest = new Map();
    for (const name of filenames || []) {
        const parsed = parseDiskSnapshotName(name);
        if (!parsed) continue;
        const prev = latest.get(parsed.gameCode);
        if (!prev || parsed.atMs > prev.atMs) latest.set(parsed.gameCode, parsed);
    }
    return Array.from(latest.values());
}

function stampMs(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function stampIso(value) {
    const ms = stampMs(value);
    return ms ? new Date(ms).toISOString() : null;
}

function summarizeSnapshot(payload, extras = {}) {
    const snap = payload && (payload.snapshot || payload);
    const gameCode = extras.gameCode || snap.gameCode || payload.game_code;
    const at = extras.at || payload.at || snap.createdAt;
    const phase = extras.phase || payload.phase || snap.gameState || 'waiting';
    const players = Array.isArray(snap.players) ? snap.players : [];
    const savedAtMs = stampMs(at);
    return {
        gameCode: String(gameCode || ''),
        live: false,
        recovered: false,
        gameState: snap.gameState || phase,
        phase,
        playerCount: Number(extras.playerCount != null ? extras.playerCount : players.length) || 0,
        currentRound: Number(extras.currentRound != null ? extras.currentRound : snap.currentRound) || 0,
        currentQuestion: Number(extras.currentQuestion != null ? extras.currentQuestion : snap.currentQuestion) || 0,
        savedAt: stampIso(at),
        savedAtMs
    };
}

function summarizeStoreRow(row) {
    if (!row) return null;
    const gameCode = row.game_code || row.gameCode;
    if (!gameCode) return null;
    const at = row.at || row.savedAt;
    return {
        gameCode: String(gameCode),
        live: false,
        recovered: false,
        gameState: row.game_state || row.gameState || row.phase || 'waiting',
        phase: row.phase || row.game_state || row.gameState || 'waiting',
        playerCount: Number(row.player_count || row.playerCount) || 0,
        currentRound: Number(row.current_round || row.currentRound) || 0,
        currentQuestion: Number(row.current_question || row.currentQuestion) || 0,
        savedAt: stampIso(at),
        savedAtMs: stampMs(at)
    };
}

function summarizeLiveGame(game) {
    const savedAtMs = stampMs(game.recoveredAt || game.createdAt) || Date.now();
    return {
        gameCode: String(game.gameCode),
        live: true,
        recovered: !!game.recoveredAt,
        gameState: game.gameState || 'waiting',
        phase: game.gameState || 'waiting',
        playerCount: Number(game.playerCount) || 0,
        currentRound: Number(game.currentRound) || 0,
        currentQuestion: Number(game.currentQuestion) || 0,
        savedAt: new Date(savedAtMs).toISOString(),
        savedAtMs
    };
}

function mergeRecoverableGames({
    live = [],
    snapshots = [],
    now = Date.now(),
    maxAgeMs = RECOVERABLE_MAX_AGE_MS
} = {}) {
    const byCode = new Map();
    for (const snap of snapshots) {
        if (!snap || !snap.gameCode) continue;
        if (maxAgeMs && snap.savedAtMs && (now - snap.savedAtMs) > maxAgeMs) continue;
        const prev = byCode.get(snap.gameCode);
        if (!prev || (snap.savedAtMs || 0) > (prev.savedAtMs || 0)) {
            byCode.set(snap.gameCode, { ...snap, live: false });
        }
    }
    for (const liveGame of live) {
        if (!liveGame || !liveGame.gameCode) continue;
        byCode.set(liveGame.gameCode, { ...liveGame, live: true });
    }
    return Array.from(byCode.values()).sort((a, b) => {
        if (a.live !== b.live) return a.live ? -1 : 1;
        return (b.savedAtMs || 0) - (a.savedAtMs || 0);
    });
}

module.exports = {
    RECOVERABLE_MAX_AGE_MS,
    diskTimestampToMs,
    parseDiskSnapshotName,
    groupDiskSnapshotFiles,
    summarizeSnapshot,
    summarizeStoreRow,
    summarizeLiveGame,
    mergeRecoverableGames
};
