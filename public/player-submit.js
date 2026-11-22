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

const api = { syncPlayerSubmitButton };

if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
}
if (typeof window !== 'undefined') {
    window.MEGASheepSubmit = api;
}
