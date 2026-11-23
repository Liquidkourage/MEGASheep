(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.MEGASheepAnswerMatch = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    const STRONG_MIN = 90;
    const WORD_MIN = 4;
    const FUZZY_MIN = 6;
    const FUZZY_MAX_LEN_DIFF = 2;
    const FUZZY_MAX_EDITS = 2;
    const FUZZY_SHOW_MIN = 75;

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

    function editDistance(a, b) {
        const n = a.length;
        const m = b.length;
        const d = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));
        for (let i = 0; i <= n; i += 1) d[i][0] = i;
        for (let j = 0; j <= m; j += 1) d[0][j] = j;
        for (let i = 1; i <= n; i += 1) {
            for (let j = 1; j <= m; j += 1) {
                const cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
                d[i][j] = Math.min(
                    d[i - 1][j] + 1,
                    d[i][j - 1] + 1,
                    d[i - 1][j - 1] + cost
                );
                if (i > 1 && j > 1
                    && a.charAt(i - 1) === b.charAt(j - 2)
                    && a.charAt(i - 2) === b.charAt(j - 1)) {
                    d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
                }
            }
        }
        return d[n][m];
    }

    function fuzzyConfidence(a, b) {
        if (Math.min(a.length, b.length) < FUZZY_MIN) return 0;
        if (Math.abs(a.length - b.length) > FUZZY_MAX_LEN_DIFF) return 0;
        const dist = editDistance(a, b);
        if (dist === 0 || dist > FUZZY_MAX_EDITS) return 0;
        const score = Math.round((1 - dist / Math.max(a.length, b.length)) * 100);
        return score >= FUZZY_SHOW_MIN ? score : 0;
    }

    function answerConfidence(answer, official) {
        const a = normalizeAnswer(answer);
        const b = normalizeAnswer(official);
        if (!a || !b) return 0;
        if (a === b) return 100;
        if (isPluralPair(a, b)) return 96;
        if (hasWholeWord(a, b) || hasWholeWord(b, a)) return 92;
        return fuzzyConfidence(a, b);
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
