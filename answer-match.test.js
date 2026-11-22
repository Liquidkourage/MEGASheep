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

testExactAndClose();
testWholeWordNotSubstring();
testStrongGate();
console.log('answer-match tests ok');
