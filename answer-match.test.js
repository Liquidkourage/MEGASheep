'use strict';

const assert = require('assert');
const match = require('./public/answer-match.js');

function testExactAndClose() {
    assert.strictEqual(match.answerConfidence('Pizza', 'pizza'), 100);
    assert.strictEqual(match.answerConfidence('pizzas', 'pizza'), 96);
    assert.strictEqual(match.answerConfidence('movie', 'movies'), 96);
}

function testWholeWordNotSubstring() {
    assert.strictEqual(match.answerConfidence('billy goat', 'goat'), 92);
    assert.strictEqual(match.answerConfidence('the godfather', 'godfather'), 92);
    assert.strictEqual(match.answerConfidence('pop', 'popcorn'), 0);
    assert.strictEqual(match.answerConfidence('pine', 'pineapple'), 0);
    assert.strictEqual(match.answerConfidence('cat', 'catch'), 0);
    assert.strictEqual(match.answerConfidence('cat', 'category'), 0);
    assert.strictEqual(match.answerConfidence('it', 'italy'), 0);
    assert.strictEqual(match.answerConfidence('a', 'pasta'), 0);
    assert.strictEqual(match.answerConfidence('crack', 'quack'), 0);
    assert.strictEqual(match.answerConfidence('pie', 'pizza'), 0);
}

function testStrongGate() {
    assert.ok(match.isStrongMatch('goat', 'goat'));
    assert.ok(match.isStrongMatch('goats', 'goat'));
    assert.ok(match.isStrongMatch('billy goat', 'goat'));
    assert.ok(!match.isStrongMatch('italy', 'it'));
    assert.ok(!match.isStrongMatch('popcorn', 'pop'));
}

function testFuzzyTypos() {
    const connecticut = match.answerConfidence('conneticut', 'Connecticut');
    assert.ok(connecticut >= 85, `conneticut should be a close match, got ${connecticut}`);
    assert.ok(match.isStrongMatch('conneticut', 'Connecticut'));

    const receive = match.answerConfidence('recieve', 'receive');
    assert.ok(receive >= 80, `recieve should be a close match, got ${receive}`);

    const colorado = match.answerConfidence('colorodo', 'colorado');
    assert.ok(colorado >= 75 && colorado < 90, `colorodo should hint, not auto-file, got ${colorado}`);
}

function testFuzzyDoesNotReviveShortMisses() {
    assert.strictEqual(match.answerConfidence('crack', 'quack'), 0);
    assert.strictEqual(match.answerConfidence('night', 'might'), 0);
}

testExactAndClose();
testWholeWordNotSubstring();
testStrongGate();
testFuzzyTypos();
testFuzzyDoesNotReviveShortMisses();
console.log('answer-match tests ok');
