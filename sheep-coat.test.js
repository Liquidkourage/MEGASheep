'use strict';

const assert = require('assert');
const { nameHash, coatOf } = require('./public/sheep-coat');

assert.strictEqual(coatOf('Nibble'), (nameHash('Nibble') % 2) + 1);
assert.strictEqual(coatOf({ name: 'Nibble' }), coatOf('Nibble'));
assert.strictEqual(coatOf({ name: 'Nibble', id: 'socket-1' }), coatOf('Nibble'));
assert.strictEqual(coatOf({ id: 'socket-only' }), coatOf('socket-only'));

['Nibble', 'Jay', 'orange', 'A', 'Bandit', 'MEGASheep'].forEach((name) => {
    const coat = coatOf(name);
    assert.ok(coat === 1 || coat === 2, `${name} coat ${coat}`);
    assert.strictEqual(coatOf(name), coatOf(name));
});

assert.notStrictEqual(coatOf('Nibble'), 3);

console.log('sheep-coat tests passed');
