// POST /api/feedback: a message from the menu's Feedback button.
//
// Body: {text, category?, guestId?, context?}
//   text      3 to 1000 characters once trimmed
//   category  'bug' | 'idea' | 'balance' | 'other', or left out
//   guestId   the browser's guest id (32 hex), only used when not logged in
//   context   {version, browser, screen, region, server, embed, inGame}, all
//             optional; anything else is dropped (feedback.cleanContext)
// -> 201 {ok:true, id}
//
// Works for guests and accounts. 3 per 10 minutes per IP, and per account
// or guest id on top. Validation runs first so a rejected message costs
// nothing.
'use strict';

const feedback = require('../feedback');
const guests = require('../guests');
const { HttpError } = require('../http');

function postFeedback(ctx) {
    const b = ctx.body || {};
    if (b.text != null && typeof b.text !== 'string') throw new HttpError(400, 'bad_text', 'Something went wrong. Refresh and try again.');
    const text = feedback.cleanText(b.text);
    if (text.length < feedback.MIN_TEXT) throw new HttpError(400, 'too_short', 'Write a few words first!');
    if (text.length > feedback.MAX_TEXT) throw new HttpError(400, 'too_long', `That's a lot! Keep it under ${feedback.MAX_TEXT} characters.`);
    let category = null;
    if (b.category != null && b.category !== '') {
        if (!feedback.CATEGORIES.includes(b.category)) throw new HttpError(400, 'bad_category', 'Something went wrong. Refresh and try again.');
        category = b.category;
    }

    const a = ctx.auth();
    const userId = a ? a.user.id : null;
    const guestId = !userId && guests.valid(b.guestId) ? b.guestId : null;
    ctx.charge(['feedback', 'ip:' + ctx.ipKey], userId ? ['feedback', 'u:' + userId] : guestId ? ['feedback', 'g:' + guestId] : null);

    const context = feedback.cleanContext(b.context);
    const id = feedback.add({ userId, guestId, category, text, context }, ctx.now);
    feedback.forward({ id, at: ctx.now, user_id: userId, guest_id: guestId, category, text, context }, a ? a.user.username : null)
        .catch(() => { /* logged inside */ });
    ctx.json(201, { ok: true, id });
}

function register(router) {
    router.add('POST', '/api/feedback', postFeedback);
}

module.exports = { register };
