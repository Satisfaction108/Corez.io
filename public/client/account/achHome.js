// Back on the home screen: the achievements finished in that raid play one
// after another. A card ("Achievement completed", the name, its icon), then
// "+N gemdust", then the number breaks into dust that flies to the gemdust
// counter on the account chip, which ticks up as it lands. A guest's dust
// flies into a "waiting for you" spot instead, with "Sign up to keep it" and
// the Keep my stuff button. A click skips to the next card.
//
// The rules (what is waiting, once only, folding, timings, words) are
// ../achHomeLogic.js; main.js calls maybePlay() when the menu comes back.
import * as HL from '../achHomeLogic.js';
import * as store from './state.js';
import { h, icon, fmtDust, reducedMotion } from './ui.js';
import { glyphIcon } from './achievements.js';

let run = null;     // the moment playing now: {cancelled, skip()}
const lsOk = () => { try { return window.localStorage; } catch (e) { return null; } };

export const isPlaying = () => !!run;
// QA (headless): is a moment up, how many cards wait
window.dwAchHome = () => ({ playing: !!run, waiting: waiting() });
export const waiting = () => HL.waiting(lsOk());

// Stop at once (the game started, logged out): nothing left on screen.
export function stop() {
    if (!run) return;
    run.cancelled = true;
    run.skip();
    run.root.remove();
    run = null;
}

// Plays whatever is waiting. opts: { onKeep() } (a guest's Keep my stuff)
// -> true when something started
export function play(opts) {
    if (run) return false;
    // a logged-in browser whose /api/me has not answered yet, or accounts
    // down: later (the cards keep waiting)
    if (store.get('offline') || (store.get('mode') === 'user' && !store.get('user'))) return false;
    const cards = HL.take(lsOk());
    if (!cards.length) return false;
    start(cards, opts || {});
    return true;
}

// The account chip's number: the element, and the value it should start from.
function counterEl() { return document.querySelector('#accountChip .ac-dust > span:last-child'); }
function dustTarget(guestSpot) {
    const el = guestSpot || document.querySelector('#accountChip .ac-dust .dw-ic') || document.querySelector('#accountChip .ac-dust');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (!r.width || r.bottom < 0 || r.top > window.innerHeight) return null;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, el };
}

function start(cards, opts) {
    const user = store.get('user');
    const guest = !user;
    const list = HL.plan(cards);
    const total = HL.totalMilli(cards);
    const calm = reducedMotion();
    // QA (headless frame captures): window.dwAchHomeSlow = 4 plays it 4x slower
    const slow = Math.max(1, Math.min(20, +window.dwAchHomeSlow || 1));
    const per = HL.cardMs(list.length) * slow;

    const root = h('div', { id: 'dwAchHome', class: guest ? 'guest' : '', role: 'status', 'aria-live': 'polite' });
    const stage = h('div', { class: 'ah-stage' });
    root.appendChild(stage);
    // a guest's dust waits here, under the card, for the whole moment
    let waitNum = null, waitBox = null;
    if (guest) {
        waitNum = h('b', { text: '0' });
        const keep = h('button', { type: 'button', class: 'ah-keep', text: 'Keep my stuff' });
        keep.addEventListener('click', (e) => { e.stopPropagation(); stop(); if (opts.onKeep) opts.onKeep(); });
        waitBox = h('div', { class: 'ah-wait' },
            h('span', { class: 'ah-jar' }, icon('dust'), h('span', null, 'Waiting for you: ', waitNum, ' gemdust')),
            h('div', { class: 'ah-foot' }, h('span', { text: 'Sign up to keep it' }), keep));
        root.appendChild(waitBox);
    }
    document.body.appendChild(root);

    // where the counter starts: today's balance less what these cards paid
    const final = user ? Math.max(0, +user.dust || 0) : 0;
    let shown = guest ? 0 : Math.max(0, final - total / 1000);
    const setCounter = (v) => {
        shown = v;
        if (guest) { waitNum.textContent = HL.fmtDust(Math.round(v * 1000)); return; }
        const el = counterEl();
        if (el) el.textContent = fmtDust(v);
    };
    setCounter(shown);

    const timers = new Set();
    const anims = new Set();
    let next = null;          // resolves the current card's wait early
    const me = {
        root, cancelled: false,
        skip() {
            for (const t of timers) clearTimeout(t);
            timers.clear();
            for (const a of anims) { try { a.cancel(); } catch (e) { /* */ } }
            anims.clear();
            root.querySelectorAll('.ah-p').forEach((p) => p.remove());
            document.querySelectorAll('body > .ah-p').forEach((p) => p.remove());
            if (next) { const n = next; next = null; n(); }
        },
    };
    run = me;
    // a click anywhere (but the guest's button) goes to the next card
    root.addEventListener('click', () => me.skip());

    const wait = (ms) => new Promise((res) => {
        next = res;
        const t = setTimeout(() => { timers.delete(t); if (next === res) next = null; res(); }, ms);
        timers.add(t);
    });

    (async () => {
        let paid = 0;
        for (let i = 0; i < list.length && !me.cancelled; i++) {
            const d = list[i];
            const w = HL.words(d, guest);
            const target = paid + (d.rewardMilli | 0);
            const card = buildCard(d, w);
            stage.textContent = '';
            stage.appendChild(card);
            if (!calm) card.animate([{ opacity: 0, transform: 'translateY(10px) scale(.94)' }, { opacity: 1, transform: 'none' }], { duration: 240 * slow, easing: 'cubic-bezier(.2,.8,.2,1)' });
            const from = guest ? paid / 1000 : shown;
            const to = guest ? target / 1000 : Math.min(final, shown + (d.rewardMilli | 0) / 1000);
            const land = from !== to ? flyDust(me, card.querySelector('.ah-reward'), d, guest ? waitBox && waitBox.querySelector('.ah-jar') : null, (k) => setCounter(HL.tick(from, to, k, 1)), calm, per, slow, timers, anims) : null;
            await wait(per);
            // skipped or done: this card's dust is all in
            if (from !== to) setCounter(to);
            if (land) land.done = true;
            paid = target;
        }
        if (!me.cancelled && guest && waitBox) {
            // the last card leaves; the waiting spot and its button stay a moment
            stage.textContent = '';
            await wait(Math.max(1200, HL.GUEST_LAST_MS - HL.cardMs(list.length)) * slow);
        }
        if (me.cancelled) return;
        if (!guest) setCounter(final);
        if (!calm) {
            const a = root.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 220 });
            await new Promise((r) => { a.onfinish = r; a.oncancel = r; });
        }
        root.remove();
        if (run === me) run = null;
    })();
}

function buildCard(d, w) {
    const badge = h('span', { class: 'ah-icon' });
    if (d.more) badge.appendChild(icon('trophy'));
    else {
        badge.appendChild(glyphIcon(d.icon || 'star'));
        if (d.color) badge.style.color = d.color;
    }
    const reward = w.reward ? h('div', { class: 'ah-reward' + ((d.rewardMilli | 0) > 0 ? '' : ' item'), text: w.reward }) : null;
    return h('div', { class: 'ah-card' },
        badge,
        h('div', { class: 'ah-txt' },
            h('div', { class: 'ah-label', text: w.label }),
            h('div', { class: 'ah-title', text: w.title }),
            reward));
}

// The reward line breaks into specks that fly to the counter (or the
// guest's waiting spot). progress(k) runs as they land, k from 0 to 1.
function flyDust(me, from, d, guestSpot, progress, calm, per, slow, timers, anims) {
    const state = { done: false };
    if (!from) return state;
    const burstAt = Math.min(820 * slow, per * 0.42);
    const t0 = setTimeout(() => {
        timers.delete(t0);
        if (me.cancelled || state.done) return;
        const tgt = dustTarget(guestSpot);
        const r = from.getBoundingClientRect();
        const sx = r.left + r.width / 2, sy = r.top + r.height / 2;
        // the number pops and is gone: it became the specks
        const pop = from.animate([{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(1.25)', opacity: 1, offset: 0.35 }, { transform: 'scale(.6)', opacity: 0 }], { duration: 260 * slow, fill: 'forwards' });
        anims.add(pop);
        if (calm || !tgt) { progress(1); return; }
        const n = Math.max(8, Math.min(18, Math.round(((d.rewardMilli | 0) / 1000) * 6)));
        let landed = 0;
        const flight = Math.min(700 * slow, per * 0.36);
        for (let i = 0; i < n; i++) {
            const p = document.createElement('span');
            p.className = 'ah-p' + (i % 3 === 0 ? ' big' : '');
            p.style.left = sx + 'px';
            p.style.top = sy + 'px';
            document.body.appendChild(p);
            const ang = (i / n) * Math.PI * 2 + Math.random() * 0.6;
            const rad = 26 + Math.random() * 46;
            const mx = Math.cos(ang) * rad, my = Math.sin(ang) * rad * 0.7 - 10;
            const dx = tgt.x - sx, dy = tgt.y - sy;
            const a = p.animate([
                { transform: 'translate(-50%,-50%) translate(0px,0px) rotate(45deg) scale(.4)', opacity: 0 },
                { transform: `translate(-50%,-50%) translate(${mx}px,${my}px) rotate(45deg) scale(1.1)`, opacity: 1, offset: 0.3, easing: 'cubic-bezier(.5,0,.8,.4)' },
                { transform: `translate(-50%,-50%) translate(${dx}px,${dy}px) rotate(225deg) scale(.45)`, opacity: 0.9 },
            ], { duration: flight, delay: i * Math.min(16, 220 / n) * slow, easing: 'linear', fill: 'forwards' });
            anims.add(a);
            a.onfinish = () => {
                anims.delete(a);
                p.remove();
                if (state.done || me.cancelled) return;
                landed++;
                progress(landed / n);
                bump(tgt.el, anims);
            };
        }
    }, burstAt);
    timers.add(t0);
    return state;
}

// the counter jumps a little as dust lands in it
let bumping = false;
function bump(el, anims) {
    if (!el || bumping || !el.animate) return;
    bumping = true;
    const a = el.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.18)' }, { transform: 'scale(1)' }], { duration: 140 });
    anims.add(a);
    a.onfinish = a.oncancel = () => { bumping = false; anims.delete(a); };
}
