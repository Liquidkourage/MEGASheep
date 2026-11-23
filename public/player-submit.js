'use strict';

/**
 * Question 1 adds the disabled class when an answer locks in.
 * A later question must take that class off again, or the button
 * stays gray and ignores taps even though this question is still open.
 */
function syncPlayerSubmitButton(btn, submitted) {
    if (!btn) return;
    const locked = !!submitted;
    btn.disabled = locked;
    if (btn.classList) btn.classList.toggle('disabled', locked);
    if (locked) btn.setAttribute('aria-disabled', 'true');
    else btn.removeAttribute('aria-disabled');
}

function currentLockedAnswer({ pending, lastSubmitted, lastQ, currentQ, myAnswer, stored } = {}) {
    if (pending) return '';
    const q = currentQ;
    const submitted = String(lastSubmitted || '').trim();
    if (typeof lastQ === 'number' && lastQ === q && submitted) return submitted;
    if (myAnswer) return String(myAnswer).trim();
    return String(stored || '').trim();
}

function lockedAnswerReadout(answer) {
    const text = String(answer || '').trim();
    return text ? `Locked in — ${text}` : 'Locked in';
}

const api = { syncPlayerSubmitButton, currentLockedAnswer, lockedAnswerReadout };

if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
}
if (typeof window !== 'undefined') {
    window.MEGASheepSubmit = api;
}
