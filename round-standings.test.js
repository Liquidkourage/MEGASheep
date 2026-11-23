'use strict';

const assert = require('assert');
const {
    mergeRoundGroups,
    scoresFromAnswerGroups,
    historyWithLiveRound,
    pickCurrentRoundStandings
} = require('./round-standings');

function testIncludesCurrentQuestionBeforeRoundEnds() {
    const rolled = [{ answer: 'Mars', points: 4, players: ['Ada'] }];
    const current = [{ answer: 'Venus', points: 3, players: ['Ada', 'Bea'] }];
    const groups = mergeRoundGroups(rolled, current);
    const scores = scoresFromAnswerGroups(
        [{ name: 'Ada' }, { name: 'Bea' }, { name: 'Cal' }],
        groups
    );
    assert.strictEqual(scores.get('Ada'), 7);
    assert.strictEqual(scores.get('Bea'), 3);
    assert.strictEqual(scores.get('Cal'), 0);
}

function testDoesNotDoubleCountRolledCurrentGroups() {
    const current = [{ answer: 'Mars', points: 5, players: ['Ada'] }];
    const rolled = current.slice();
    const groups = mergeRoundGroups(rolled, current);
    assert.strictEqual(groups.length, 1);
    assert.strictEqual(scoresFromAnswerGroups([{ name: 'Ada' }], groups).get('Ada'), 5);
}

function testRoundOneRunningTrackUsesLiveScores() {
    const live = {
        roundNumber: 1,
        players: [{ name: 'Ada', score: 4 }, { name: 'Bea', score: 0 }]
    };
    const picked = pickCurrentRoundStandings([], live, [{ name: 'Ada', score: 0 }], 1);
    assert.strictEqual(picked.players[0].score, 4);
    const history = historyWithLiveRound([], live);
    assert.strictEqual(history.length, 1);
    assert.strictEqual(history[0].players[0].score, 4);
}

function testCompletedRoundKeepsFinalSnapshot() {
    const last = {
        roundNumber: 1,
        players: [{ name: 'Ada', score: 12 }]
    };
    const live = {
        roundNumber: 1,
        players: [{ name: 'Ada', score: 0 }]
    };
    const picked = pickCurrentRoundStandings([last], live, [], 1);
    assert.strictEqual(picked.players[0].score, 12);
    const history = historyWithLiveRound([last], live);
    assert.strictEqual(history.length, 1);
    assert.strictEqual(history[0].players[0].score, 12);
}

function testLaterRoundUsesLiveNotPreviousRound() {
    const last = {
        roundNumber: 1,
        players: [{ name: 'Ada', score: 12 }]
    };
    const live = {
        roundNumber: 2,
        players: [{ name: 'Ada', score: 3 }]
    };
    const picked = pickCurrentRoundStandings([last], live, [], 2);
    assert.strictEqual(picked.roundNumber, 2);
    assert.strictEqual(picked.players[0].score, 3);
}

testIncludesCurrentQuestionBeforeRoundEnds();
testDoesNotDoubleCountRolledCurrentGroups();
testRoundOneRunningTrackUsesLiveScores();
testCompletedRoundKeepsFinalSnapshot();
testLaterRoundUsesLiveNotPreviousRound();
console.log('round-standings tests ok');
