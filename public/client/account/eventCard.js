// The Raid Night card in the come-back card left of the menu (#eventCard)
// shared/events.js (window.DWEvents): its start in the viewer's own time,
// a live countdown, the blurb, a Discord link and an .ics "Add to calendar".
// While the event runs it says so and Play pulses. Hidden in game, when
// nothing is coming up within DWEvents.MENU_LEAD_MS, and after it ends.
//
// One timer, once a second, and only while the menu is on screen. Text
// nodes are only written when their string changes.
import { h, icon, clear } from './ui.js';

const E = window.DWEvents;
let card = null, play = null, timer = 0;
let key = '', cdEl = null, whenEl = null, lastCd = '', lastWhen = '', whenAt = 0;
const icsCache = new Map();

const inGame = () => document.body.classList.contains('in-game');

export function init() {
    card = document.getElementById('eventCard');
    play = document.getElementById('startButton');
    if (!card || !E) return;
    document.addEventListener('visibilitychange', schedule);
    new MutationObserver(schedule).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    schedule();
}

let running = false;
function schedule() {
    const want = !document.hidden && !inGame();
    if (want === running) return;
    running = want;
    clearInterval(timer);
    timer = 0;
    if (!want) return;
    tick();
    // line the ticks up with the clock's seconds so the countdown steps evenly
    timer = setTimeout(() => { tick(); timer = setInterval(tick, 1000); }, 1000 - (E.now() % 1000));
}

function icsHref(ev) {
    let v = icsCache.get(ev.id);
    if (!v) { v = 'data:text/calendar;charset=utf-8,' + encodeURIComponent(E.ics(ev)); icsCache.set(ev.id, v); }
    return v;
}

function build(c) {
    const ev = c.ev;
    clear(card);
    card.classList.toggle('live', c.live);
    cdEl = h('span', { class: 'ev-cd' });
    whenEl = h('b', { class: 'ev-when', title: E.localFull(ev) });
    lastCd = lastWhen = '';
    whenAt = 0;
    card.append(
        h('div', { class: 'ev-head' },
            c.live ? h('span', { class: 'ev-dot', 'aria-hidden': 'true' }) : null,
            h('span', { class: 'ev-title', text: c.live ? ev.name + ' is live' : ev.name }),
            cdEl),
        h('p', { class: 'ev-blurb' },
            c.live ? null : whenEl,
            c.live ? null : ' · ',
            c.live ? (ev.liveBlurb || ev.blurb) : ev.blurb),
        h('div', { class: 'ev-links' },
            h('a', { class: 'ev-link ev-discord', href: E.DISCORD, target: '_blank', rel: 'noopener' }, icon('discord', 'dc'), h('span', { text: 'Join our Discord' })),
            c.live ? null : h('a', { class: 'ev-link', href: icsHref(ev), download: ev.id + '.ics', title: 'Save it to your calendar' }, h('span', { text: 'Add to calendar' }))));
    card.setAttribute('aria-label', ev.name);
    card.hidden = false;
    if (play) play.classList.toggle('ev-live', c.live);
}

function hide() {
    key = '';
    card.hidden = true;
    clear(card);
    card.classList.remove('live');
    if (play) play.classList.remove('ev-live');
}

function tick() {
    const t = E.now();
    const c = E.current(t);
    if (!c || (!c.live && c.ms > E.MENU_LEAD_MS)) { if (key) hide(); return; }
    const k = c.ev.id + (c.live ? ':live' : ':soon');
    if (k !== key) { key = k; build(c); }
    const cd = (c.live ? 'ends in ' : 'in ') + E.countdown(c.ms);
    if (cd !== lastCd) { lastCd = cd; cdEl.textContent = cd; }
    // "Tomorrow" turns into "Tonight" at midnight: check once a minute
    if (!c.live && t - whenAt > 60000) {
        whenAt = t;
        const w = E.localWhen(c.ev, t);
        if (w !== lastWhen) { lastWhen = w; whenEl.textContent = w; }
    }
}
