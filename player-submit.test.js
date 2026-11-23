'use strict';

const assert = require('assert');
const { syncPlayerSubmitButton } = require('./public/player-submit');

function fakeButton() {
    const classes = new Set(['btn', 'btn-primary', 'disabled']);
    return {
        disabled: true,
        attributes: { 'aria-disabled': 'true' },
        classList: {
            toggle(name, on) {
                if (on) classes.add(name);
                else classes.delete(name);
            },
            contains(name) {
                return classes.has(name);
            }
        },
        setAttribute(name, value) {
            this.attributes[name] = value;
        },
        removeAttribute(name) {
            delete this.attributes[name];
        }
    };
}

const open = fakeButton();
syncPlayerSubmitButton(open, false);
assert.strictEqual(open.disabled, false);
assert.strictEqual(open.classList.contains('disabled'), false);
assert.strictEqual(open.attributes['aria-disabled'], undefined);

const locked = fakeButton();
syncPlayerSubmitButton(locked, true);
assert.strictEqual(locked.disabled, true);
assert.strictEqual(locked.classList.contains('disabled'), true);
assert.strictEqual(locked.attributes['aria-disabled'], 'true');

syncPlayerSubmitButton(null, false);

const { currentLockedAnswer, lockedAnswerReadout } = require('./public/player-submit');
assert.strictEqual(
    currentLockedAnswer({
        pending: false,
        lastSubmitted: 'North Dakota',
        lastQ: 2,
        currentQ: 2,
        myAnswer: 'ND',
        stored: 'ND'
    }),
    'North Dakota'
);
assert.strictEqual(
    currentLockedAnswer({
        pending: true,
        lastSubmitted: 'ND',
        lastQ: 2,
        currentQ: 2,
        myAnswer: 'ND',
        stored: 'ND'
    }),
    ''
);
assert.strictEqual(lockedAnswerReadout('North Dakota'), 'Locked in — North Dakota');

console.log('player-submit tests passed');
