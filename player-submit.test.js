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

console.log('player-submit tests passed');
