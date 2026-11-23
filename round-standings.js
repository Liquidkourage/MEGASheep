'use strict';

function mergeRoundGroups(rolled, current) {
    const base = Array.isArray(rolled) ? rolled : [];
    const live = Array.isArray(current) ? current : [];
    if (!live.length) return base;
    if (live.every((group) => base.includes(group))) return base;
    return base.concat(live);
}

function scoresFromAnswerGroups(players, groups) {
    const scores = new Map();
    (players || []).forEach((player) => {
        if (player && player.name) scores.set(player.name, 0);
    });
    (groups || []).forEach((group) => {
        if (!group || !Array.isArray(group.players) || !group.players.length) return;
        const points = Number(group.points) || 0;
        group.players.forEach((name) => {
            scores.set(name, (scores.get(name) || 0) + points);
        });
    });
    return scores;
}

function historyWithLiveRound(history, live) {
    const next = Array.isArray(history) ? history.slice() : [];
    if (!live) return next;
    const last = next[next.length - 1];
    if (last && last.roundNumber === live.roundNumber) return next;
    next.push(live);
    return next;
}

function pickCurrentRoundStandings(history, live, fallbackPlayers, roundNumber) {
    const last = Array.isArray(history) && history.length ? history[history.length - 1] : null;
    if (last && live && last.roundNumber === live.roundNumber) return last;
    if (live && Array.isArray(live.players) && live.players.length) return live;
    if (last && Array.isArray(last.players) && last.players.length) return last;
    return {
        roundNumber: Math.max(1, Number(roundNumber) || 1),
        players: fallbackPlayers || []
    };
}

module.exports = {
    mergeRoundGroups,
    scoresFromAnswerGroups,
    historyWithLiveRound,
    pickCurrentRoundStandings
};
