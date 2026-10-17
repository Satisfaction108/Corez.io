import * as api from './api.js';
import * as store from './state.js';
import * as pv from './previews.js';
import { h, icon, clear, modal, toast, animate, reducedMotion } from './ui.js';

const LV = window.DWLevels, C = window.DWCosmetics;
const ls = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { void e; } },
};
const SEEN_KEY = 'dwLvSeen';
const LAST_KEY = 'dwLvLast';

let hooks = { onSignup() {}, refreshMe() {} };
let row = null, bar = null, fill = null, lvTxt = null, xpTxt = null, chip = null, saved = null, gainEl = null, startXp = null;
const GAIN_KEY = 'dwLvGain', XP_KEY = 'dwLvXp', GAIN_MS = 3 * 86400000;
let st = null, booted = false, loadSeq = 0, ownerSig = '', panel = null, pre = null, preKey = '', preAt = 0, lateAdopt = null;
const PRE_MS = 5000;

const inGame = () => document.body.classList.contains('in-game');
const fmt = (n) => (n | 0).toLocaleString('en-US');
const dustTxt = (milli) => { const v = (+milli || 0) / 1000; return Number.isInteger(v) ? String(v) : String(+v.toFixed(2)); };

function guestId() {
    let g = ls.get('dwGuestId');
    if (!/^[a-f0-9]{32}$/.test(g || '')) {
        try {
            g = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
            ls.set('dwGuestId', g);
        } catch (e) { g = ''; }
    }
    return g || '';
}

function ownerKey() {
    const s = store.get();
    return s.user ? 'a:' + s.user.userId : 'g:' + guestId();
}

function readCache() {
    try {
        const c = JSON.parse(ls.get(LAST_KEY) || 'null');
        if (c && c.v === 2 && c.by && typeof c.by === 'object') return c;
    } catch (e) { void e; }
    return { v: 2, last: '', by: {} };
}

function guessKey() {
    const s = store.get();
    if (s.user) return 'a:' + s.user.userId;
    if (s.mode === 'user' || ls.get('dwAcctHint') === 'user') {
        const last = readCache().last;
        return /^a:/.test(last) ? last : '';
    }
    return 'g:' + guestId();
}

function adopt() {
    const el = document.getElementById('lvRow');
    if (!el) return false;
    row = el;
    bar = el.querySelector('.lv-bar'); fill = el.querySelector('.lv-fill'); lvTxt = el.querySelector('.lv-lv'); xpTxt = el.querySelector('.lv-xp');
    chip = el.querySelector('.lv-chip'); saved = el.querySelector('.lv-saved');
    if (!bar || !fill || !lvTxt || !xpTxt || !chip || !saved) { row = null; return false; }
    bar.onclick = () => openPanel();
    chip.onclick = () => openPanel();
    return true;
}

function build() {
    if (row) return true;
    if (adopt()) return true;
    const nameRow = document.querySelector('.menu-row.name-row');
    if (!nameRow || !LV) return false;
    fill = h('span', { class: 'lv-fill' });
    lvTxt = h('span', { class: 'lv-lv' });
    xpTxt = h('span', { class: 'lv-xp' });
    bar = h('button', { type: 'button', class: 'lv-bar', title: 'See every level and what it unlocks', onclick: () => openPanel() }, fill, h('span', { class: 'lv-txt' }, lvTxt, xpTxt));
    chip = h('button', { type: 'button', class: 'lv-chip', onclick: () => openPanel() });
    saved = h('div', { class: 'lv-saved', hidden: true });
    row = h('div', { class: 'lv-wrap', id: 'lvRow', hidden: true }, h('div', { class: 'lv-row' }, bar, chip), saved);
    nameRow.insertAdjacentElement('afterend', row);
    return true;
}

function defaultState() {
    return { level: 1, into: 0, need: LV.NEED[1], max: false, next: LV.nextUnlock(1), owner: 'guest', title: LV.titleFor(1), dayXp: 0, dayCap: LV.DAY_CAP, early: true };
}
function cachedState(key) {
    if (!key) return null;
    const v = readCache().by[key];
    if (v && v.level >= 1 && v.need >= 0) return Object.assign({}, v, { early: true, key, next: LV.nextUnlock(v.level) });
    if (ls.get(LAST_KEY) == null && /^g:/.test(key)) return Object.assign(defaultState(), { key });
    return null;
}
function remember(v, key) {
    if (!key || !v) return;
    const c = readCache();
    delete c.by[key];
    c.by[key] = { level: v.level, into: v.into, need: v.need, max: !!v.max, owner: v.owner, title: v.title, dayXp: v.dayXp | 0, dayCap: v.dayCap | 0 };
    c.last = key;
    const keys = Object.keys(c.by);
    while (keys.length > 4) delete c.by[keys.shift()];
    ls.set(LAST_KEY, JSON.stringify(c));
}
function forget(key) {
    const c = readCache();
    if (!(key in c.by)) return;
    delete c.by[key];
    ls.set(LAST_KEY, JSON.stringify(c));
}
export function prefetch() {
    if (!LV || pre) return;
    const key = guessKey();
    if (!key) return;
    try { pre = api.levels(guestId()); preKey = key; preAt = Date.now(); } catch (e) { pre = null; }
}

export function init(hs) {
    Object.assign(hooks, hs || {});
    prefetch();
    if (LV && !inGame() && build()) { st = cachedState(guessKey()); paint(); }
    window.dwLevelsReady = true;
    if (window.__dwLvOpen) { window.__dwLvOpen = false; setTimeout(() => { if (!inGame()) openPanel(); }, 0); }
    store.on((s) => {
        const sig = (s.user ? s.user.userId : '') + '|' + (s.offline ? 1 : 0);
        if (sig === ownerSig) return;
        ownerSig = sig;
        if (booted) refresh();
    });
    let was = inGame();
    new MutationObserver(() => {
        const now = inGame();
        if (now === was) return;
        was = now;
        if (now) { pre = null; startXp = st && !st.early && typeof st.xp === 'number' ? st.xp : null; if (panel) panel.close(); return; }
        setTimeout(refresh, 600);
    }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
}

export function start() { booted = true; refresh(); }

export async function refresh() {
    if (!booted || inGame() || !LV || !build()) return;
    const s = store.get();
    if (s.offline) { st = null; paint(); return; }
    const key = ownerKey();
    if (!st || st.key !== key) { st = cachedState(key); paint(); }
    const seq = ++loadSeq;
    const p = preKey === key && Date.now() - preAt < PRE_MS ? pre : null;
    pre = null;
    preKey = '';
    const r = await (p || api.levels(guestId()));
    if (r && r.ok && r.data && r.data.adoptedNow) lateAdopt = r.data.adoptedNow;
    if (seq !== loadSeq || inGame()) return;
    if (!r.ok || !r.data || !r.data.on) { if (!r.ok && st && st.early) return; st = null; paint(); return; }
    st = Object.assign({}, r.data, { key });
    if (typeof st.xp === 'number') {
        let seen = null;
        try { const v = JSON.parse(ls.get(XP_KEY) || 'null'); if (v && v.key === key) seen = v.xp; } catch (e) { void e; }
        const base = startXp != null ? startXp : seen;
        if (base != null && st.xp > base) ls.set(GAIN_KEY, JSON.stringify({ key, xp: st.xp - base, at: Date.now() }));
        ls.set(XP_KEY, JSON.stringify({ key, xp: st.xp }));
    }
    startXp = null;
    const adopted = st.adoptedNow || lateAdopt;
    lateAdopt = null;
    remember(st, key);
    paint();
    if (adopted) {
        forget('g:' + guestId());
        markSeen(key, st.level);
        toast(adoptedText(adopted), { kind: 'ok', duration: 7000 });
        if ((adopted.dustMilli > 0 || (adopted.ups || []).length) && hooks.refreshMe) hooks.refreshMe();
        popBar();
        return;
    }
    noteLevelUp();
}

function itemWords(items) {
    if (!items.length) return '';
    if (items.length > 3) return items.length + ' new items are';
    return listText(items.map(i => 'the ' + i.name + ' ' + catWord(i.cat))) + (items.length === 1 ? ' is' : ' are');
}

function adoptedText(a) {
    const items = (a.ups || []).filter(u => u.item).map(u => u.item);
    const words = itemWords(items);
    const left = a.left > 0 ? ' The rest of your guest XP joins over the next few days.' : '';
    if (a.from && a.level <= a.from) return 'Your guest XP came with you: +' + fmt(a.xp) + ' XP.' + left;
    return 'Your levels came with you! You are Level ' + a.level + (words ? ', and ' + words + ' in your Locker now.' : '.') + left;
}

function carriedText(c) {
    let out = 'Your guest progress came with you!';
    const words = itemWords(c.items || []);
    if (c.level > 1 && (c.levelFrom == null || c.level > c.levelFrom)) out += ' You are Level ' + c.level + (words ? ', and ' + words + ' in your Locker now.' : '.');
    else if (words) out += ' ' + words.charAt(0).toUpperCase() + words.slice(1) + ' in your Locker now.';
    const kept = [];
    if (c.level && c.levelFrom != null && c.level <= c.levelFrom && c.levelXp > 0) kept.push(fmt(c.levelXp) + ' XP');
    if (c.achievements > 0) kept.push(c.achievements + (c.achievements === 1 ? ' achievement' : ' achievements'));
    if (c.bankGems > 0) kept.push(fmt(c.bankGems) + ' banked gems');
    if (c.daily) kept.push('your daily rewards streak');
    if (c.dustMilli > 0) kept.push(dustTxt(c.dustMilli) + ' gemdust');
    if (kept.length) out += ' You also kept ' + listText(kept) + '.';
    if (c.levelLeft > 0) out += ' The rest of your guest XP joins over the next few days.';
    return out;
}

export function carried(user, data) {
    if (!LV || !user || !user.userId || !data) return;
    const key = 'a:' + user.userId;
    const v = data.level;
    if (data.carried) forget('g:' + guestId());
    if (v && v.on) {
        remember(v, key);
        markSeen(key, v.level);
        if (!inGame() && build()) { st = Object.assign({}, v, { key }); paint(); }
    }
    const c = data.carried;
    if (!c) return;
    toast(carriedText(c), { kind: 'ok', duration: 8000 });
    if (hooks.refreshMe) setTimeout(() => hooks.refreshMe(), 0);
    popBar();
}

function popBar() {
    if (!bar || reducedMotion()) return;
    bar.classList.remove('lv-pop');
    void bar.offsetWidth;
    bar.classList.add('lv-pop');
}

function listText(a) {
    if (a.length <= 1) return a[0] || '';
    return a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1];
}

function seenLevel() {
    try { const m = JSON.parse(ls.get(SEEN_KEY) || '{}'); return m && typeof m === 'object' ? m : {}; } catch (e) { return {}; }
}

function markSeen(key, level) {
    const all = seenLevel();
    delete all[key];
    all[key] = level | 0;
    const keys = Object.keys(all);
    while (keys.length > 6) delete all[keys.shift()];
    ls.set(SEEN_KEY, JSON.stringify(all));
}

function noteLevelUp() {
    if (!st) return;
    const key = ownerKey();
    const all = seenLevel();
    const fresh = !(key in all);
    const was = fresh ? (st.owner === 'guest' ? 1 : 0) : all[key] | 0;
    all[key] = st.level;
    const keys = Object.keys(all);
    if (keys.length > 6) delete all[keys[0]];
    ls.set(SEEN_KEY, JSON.stringify(all));
    if (!was || st.level <= was || st.adoptedNow) return;
    const guest = st.owner === 'guest';
    const got = LV.rewardsBetween(was, st.level);
    const best = got.slice().reverse().find(r => r.item) || got.slice().reverse().find(r => r.title) || got[got.length - 1];
    if (!best) return;
    let line = LV.upLine(Object.assign({}, best, { level: st.level }), C, guest);
    if (got.length > 1 && (best.item || best.title)) line = line.replace(/\.$/, got.some(r => r !== best && (r.item || r.title)) ? ', and more.' : '.');
    toast(line, { kind: 'ok', duration: 6500, actions: guest ? [{ label: 'Sign up', onClick: () => hooks.onSignup() }] : [{ label: 'See levels', onClick: () => openPanel() }] });
    popBar();
}

function lastGain(key) {
    try {
        const g = JSON.parse(ls.get(GAIN_KEY) || 'null');
        if (g && g.key === key && g.xp > 0 && Date.now() - g.at < GAIN_MS) return g.xp | 0;
    } catch (e) { void e; }
    return 0;
}
function paintGain() {
    const xp = st && !st.early ? lastGain(st.key) : 0;
    if (!xp) { if (gainEl) gainEl.hidden = true; return; }
    if (!gainEl) { gainEl = h('div', { class: 'lv-gain' }); row.insertBefore(gainEl, saved); }
    gainEl.hidden = false;
    const togo = st.max ? 0 : st.need - st.into, left = togo > 0 ? ' ' + fmt(togo) + ' XP to Lvl ' + (st.level + 1) + '.' : '';
    gainEl.textContent = '+' + fmt(xp) + ' XP last game.' + left;
}
function paint() {
    if (!row) return;
    if (!st) { row.hidden = true; return; }
    row.hidden = false;
    const k = st.max ? 1 : st.need > 0 ? Math.max(0, Math.min(1, st.into / st.need)) : 0;
    fill.style.width = (k * 100).toFixed(1) + '%';
    lvTxt.textContent = 'Lvl ' + st.level;
    xpTxt.textContent = st.max ? 'Max level' : fmt(st.into) + ' / ' + fmt(st.need) + ' XP';
    bar.setAttribute('aria-label', 'Level ' + st.level + ', ' + xpTxt.textContent + '. Open the levels list.');
    const next = st.next;
    chip.hidden = !next;
    if (next) chip.textContent = 'Next: ' + LV.shortText(next, C) + ' at Lvl ' + next.level;
    const sv = st.saved;
    const n = sv ? sv.items.length + sv.titles.length : 0;
    if (st.owner === 'guest' && sv && (n > 0 || sv.dustMilli > 0)) {
        clear(saved);
        saved.hidden = false;
        const what = [];
        if (sv.items.length) what.push(sv.items.length === 1 ? sv.items[0].name + ' ' + catWord(sv.items[0].cat) : sv.items.length + ' items');
        if (sv.titles.length) what.push(sv.titles.length === 1 ? 'a title' : sv.titles.length + ' titles');
        if (sv.dustMilli > 0) what.push(dustTxt(sv.dustMilli) + ' gemdust');
        saved.append(h('span', { text: 'Saved for when you sign up: ' + listText(what) + '. ' }),
            h('button', { type: 'button', class: 'lv-link', text: 'Sign up to keep them', onclick: () => hooks.onSignup() }));
    } else if (st.owner === 'guest') {
        clear(saved);
        saved.hidden = false;
        saved.append(h('span', { text: 'A free account keeps your level, gemdust and skins. ' }),
            h('button', { type: 'button', class: 'lv-link', text: 'Make an account', onclick: () => hooks.onSignup() }));
    } else saved.hidden = true;
    paintGain();
}

function catWord(cat) {
    return { skin: 'skin', nameStyle: 'name style', sidekick: 'sidekick', sdSkin: 'sidekick skin', sdName: 'sidekick name style' }[cat] || '';
}

function art(r) {
    const it = r.item && C ? C.byId(r.item) : null;
    try {
        if (it && it.cat === 'skin') return pv.tankPreview({ w: 44, h: 44, skin: it, color: pv.TEAM_COLORS[0].col, size: 12.5, rot: -0.55, cls: 'dw-prev lvd-cv' });
        if (it && it.cat === 'nameStyle') return pv.nameCanvas('Aa', it, { px: 19, stroke: true, h: 44, maxW: 42, cls: 'dw-name-cv lvd-cv' });
        if (it && it.cat === 'sidekick') return pv.sidekickPreview({ w: 44, h: 44, kick: it, r: 12, still: true, cls: 'dw-prev lvd-cv' });
        if (it && (it.cat === 'sdSkin' || it.cat === 'sdName')) return pv.sidekickPreview({ w: 44, h: 44, kick: C.BASIC_SIDEKICK_ID, look: it.cat === 'sdSkin' ? it : null, r: 12, still: true, cls: 'dw-prev lvd-cv' });
    } catch (e) { void e; }
    if (r.title) return icon('trophy', 'lvd-ic lvd-title-ic');
    return icon('dust', 'lvd-ic lvd-dust-ic');
}

function capital(t) { return t ? t.charAt(0).toUpperCase() + t.slice(1) : ''; }

function rowText(r) {
    const it = r.item && C ? C.byId(r.item) : null;
    const main = r.item ? LV.itemName(r.item, C).replace(/ (skin|name style|sidekick skin|sidekick name style|sidekick)$/i, '') : r.title ? r.title : LV.dustText(r.dustMilli);
    const extra = [];
    if (r.item) extra.push(capital(catWord(it ? it.cat : '')) || 'Item');
    else if (r.title) extra.push('Title');
    else extra.push('Gemdust');
    if (r.item && r.title) extra.push('Title: ' + r.title);
    if ((r.item || r.title) && r.dustMilli > 0) extra.push(LV.dustText(r.dustMilli));
    return { main, sub: extra.join(' · ') };
}

export function openPanel() {
    if (!LV || panel || inGame()) return null;
    const v = st || { level: 1, into: 0, need: LV.NEED[1], max: false, title: LV.titleFor(1), dayXp: 0, dayCap: LV.DAY_CAP, owner: store.get('user') ? 'account' : 'guest' };
    const guest = v.owner === 'guest';
    const list = h('ol', { class: 'lvd-list' });
    let nextEl = null;
    list.appendChild(h('li', { class: 'lvd-row done title' },
        h('span', { class: 'lvd-lv', text: '1' }),
        h('span', { class: 'lvd-art' }, icon('trophy', 'lvd-ic lvd-title-ic')),
        h('span', { class: 'lvd-txt' }, h('b', { text: LV.titleFor(1) }), h('small', { text: 'Title · Where everyone starts' })),
        h('span', { class: 'lvd-tag done', 'aria-label': 'Unlocked' }, icon('check'))));
    for (const r of LV.REWARDS) {
        const state = r.level <= v.level ? 'done' : r.level === v.level + 1 ? 'next' : 'locked';
        const t = rowText(r);
        const tag = state === 'done' ? h('span', { class: 'lvd-tag done', 'aria-label': guest && r.level > 1 ? 'Reached, saved for sign up' : 'Unlocked' }, icon('check'))
            : state === 'next' ? h('span', { class: 'lvd-tag', text: 'Next' })
                : h('span', { class: 'lvd-tag lock', 'aria-label': 'Locked' }, icon('lock'));
        const li = h('li', { class: 'lvd-row ' + state + (r.milestone ? ' ms' : '') + (r.item ? ' item' : r.title ? ' title' : ' dust') },
            h('span', { class: 'lvd-lv', text: String(r.level) }),
            h('span', { class: 'lvd-art' }, art(r)),
            h('span', { class: 'lvd-txt' }, h('b', { text: t.main }), t.sub ? h('small', { text: t.sub }) : null),
            tag);
        if (state === 'next') nextEl = li;
        list.appendChild(li);
    }
    const k = v.max ? 1 : v.need > 0 ? Math.max(0, Math.min(1, v.into / v.need)) : 0;
    const head = h('div', { class: 'lvd-top' },
        h('div', { class: 'lvd-h' }, h('span', { text: 'Levels' }), h('span', { class: 'lvd-you', text: 'Lvl ' + v.level + ' ' + (v.title || '') })),
        h('div', { class: 'lv-bar lvd-bar', role: 'img', 'aria-label': 'Level ' + v.level + ' progress' },
            h('span', { class: 'lv-fill', style: 'width:' + (k * 100).toFixed(1) + '%' }),
            h('span', { class: 'lv-txt' }, h('span', { class: 'lv-lv', text: 'Lvl ' + v.level }), h('span', { class: 'lv-xp', text: v.max ? 'Max level' : fmt(v.into) + ' / ' + fmt(v.need) + ' XP' }))),
        h('p', { class: 'lvd-rule', text: 'You get XP for banking gems, knocking out tanks, placing well and playing. Up to ' + fmt(v.dayCap || LV.DAY_CAP) + ' XP a day, and today you have ' + fmt(v.dayXp) + '.' }));
    const foot = guest
        ? h('p', { class: 'lvd-su' }, h('span', { text: 'Your levels count now, and the unlocks are saved for when you sign up. ' }),
            h('button', { type: 'button', class: 'lv-link', text: 'Sign up to keep them', onclick: () => { m.close(); hooks.onSignup(); } }))
        : h('p', { class: 'lvd-su', text: 'Unlocked items go straight to your Locker.' });
    const body = h('div', { class: 'lvd' }, head, list, foot);
    const m = modal({ cls: 'lvd-modal', title: null, body, dismissable: true, onClose: () => { pv.stopUnder(list); panel = null; } });
    m.card.setAttribute('aria-label', 'Levels 1 to ' + LV.MAX_LEVEL + ' and what each one unlocks');
    m.card.prepend(h('button', { type: 'button', class: 'wl-x lvd-x', 'aria-label': 'Close', 'data-autofocus': '', onclick: () => m.close() }, icon('close')));
    panel = m;
    if (nextEl) requestAnimationFrame(() => { try { list.scrollTop = Math.max(0, nextEl.offsetTop - list.offsetTop - 90); } catch (e) { void e; } });
    if (!reducedMotion()) animate(list, [{ opacity: 0 }, { opacity: 1 }], { duration: 160 });
    return m;
}

window.dwLevels = { refresh, openPanel, carried, state: () => st };
