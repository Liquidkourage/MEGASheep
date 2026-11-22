(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.MEGASheepAnswerMatch = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    const STRONG_MIN = 90;
    const WORD_MIN = 4;

    function normalizeAnswer(text) {
        return String(text || '')
            .toLowerCase()
            .replace(/[^\w\s]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function tokens(text) {
        return normalizeAnswer(text).split(' ').filter(Boolean);
    }

    function isPluralPair(a, b) {
        const short = a.length <= b.length ? a : b;
        const long = a.length <= b.length ? b : a;
        if (short.length < 3) return false;
        return long === `${short}s` || long === `${short}es`;
    }

    function hasWholeWord(haystack, needle) {
        if (!needle || needle.length < WORD_MIN) return false;
        return tokens(haystack).indexOf(needle) !== -1;
    }

    function answerConfidence(answer, official) {
        const a = normalizeAnswer(answer);
        const b = normalizeAnswer(official);
        if (!a || !b) return 0;
        if (a === b) return 100;
        if (isPluralPair(a, b)) return 96;
        if (hasWholeWord(a, b) || hasWholeWord(b, a)) return 92;
        return 0;
    }

    function isStrongMatch(answer, official) {
        return answerConfidence(answer, official) >= STRONG_MIN;
    }

    return {
        STRONG_MIN,
        normalizeAnswer,
        answerConfidence,
        isStrongMatch
    };
}));
