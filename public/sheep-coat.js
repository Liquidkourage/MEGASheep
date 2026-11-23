'use strict';

/**
 * One coat for one sheep, on the phone and on the TV.
 * Matches the public meadow: FNV-1a of the name, then sheep-01 or sheep-02.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.MEGASheepCoat = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    const COAT_COUNT = 2;

    function nameHash(value) {
        let hash = 2166136261;
        const text = String(value || '');
        for (let i = 0; i < text.length; i += 1) {
            hash ^= text.charCodeAt(i);
            hash = Math.imul(hash, 16777619);
        }
        return Math.abs(hash);
    }

    function coatKey(playerOrName) {
        if (playerOrName && typeof playerOrName === 'object') {
            return String(playerOrName.name || playerOrName.id || playerOrName.stableId || '');
        }
        return String(playerOrName || '');
    }

    function coatOf(playerOrName) {
        return (nameHash(coatKey(playerOrName)) % COAT_COUNT) + 1;
    }

    return { nameHash, coatOf };
}));
