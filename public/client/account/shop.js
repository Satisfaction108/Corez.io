// The Item Shop pane, two tabs. Shop: today's Featured (2), then the day's
// skins and name styles (Daily, 8 between them), then the always-on Custom
// Color. Sidekicks: the Basic sidekick plus the day's sidekicks, sidekick
// skins and sidekick name styles (store.js generateSidekicks). Also the
// countdown to the 00:00 UTC reset, the item modal (big live preview,
// team-colour swatches, tank picker, Buy / Equip / Gift), purchase history
// with refunds, and the gift flow. Whatever you buy goes on straight away.
// A third tab, View all, is a look-only gallery of the whole catalog
import * as api from './api.js';
import * as state from './state.js';
import { h, icon, clear, modal, confirm, toast, humanError, setBusy, animate, T_MID, fmtDateTime, fmtDust } from './ui.js';
import * as pv from './previews.js';
import * as cos from './cosmetics.js';
import * as gallery from './shopGallery.js';

const RAR = () => (window.DWCosmetics && window.DWCosmetics.RARITIES) || {};
export const GIFT_MESSAGES = ['Enjoy!', 'GG, well played!', 'For you!', 'Happy birthday!'];

let handlers = { refreshMe() {}, openLocker() {}, onBalance() {}, onLogin() {} };
let paneEl = null, data = null, timer = 0, loadSeq = 0, fetchedAt = 0;
let tab = 'shop';   // 'shop' | 'sidekicks' | 'all'

export function init(hs) { Object.assign(handlers, hs); }

/* ── small bits ─────────────────────────────────────────────────────── */
export function fmtPrice(milli) {
    const v = (+milli || 0) / 1000;
    return Number.isInteger(v) ? String(v) : fmtDust(v);
}
export function rarityName(r) { return (RAR()[r] && RAR()[r].name) || 'Common'; }
const CAT_NAMES = { skin: 'skin', nameStyle: 'name', sidekick: 'sidekick', sdSkin: 'sidekick skin', sdName: 'sidekick name' };
export function catName(cat) { return CAT_NAMES[cat] || 'name'; }
// on the Sidekicks tab, where "sidekick" goes without saying
const SIDE_CAT = { sidekick: 'tank', sdSkin: 'skin', sdName: 'name' };
export const isSidekickCat = (cat) => cat === 'sidekick' || cat === 'sdSkin' || cat === 'sdName';
export function isAnimated(it) {
    if (isSidekickCat(it.cat)) return false;
    return it.cat === 'skin' ? !!(it.skin && it.skin.emissive) : cos.isAnimatedStyle(it);
}
export function priceTag(milli, cls) {
    return h('span', { class: 'shop-price' + (cls ? ' ' + cls : '') }, icon('dust'), h('span', { text: fmtPrice(milli) }));
}
// the catalog entry merged over what the server sent (render params live in the catalog)
export function full(it) {
    const c = it && cos.byId(it.id || it.itemId);
    return c ? Object.assign({}, c, it, { style: c.style, skin: c.skin }) : it;
}
const me = () => state.get('user');
const myName = () => (me() && me().username) || 'Player';
function fmtLeft(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const hr = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    if (hr > 0) return hr + 'h ' + String(m).padStart(2, '0') + 'm';
    return m + 'm ' + String(sec).padStart(2, '0') + 's';
}
const clockSkew = () => (data && data.now ? data.now - fetchedAt : 0);
const serverNow = () => Date.now() + clockSkew();

// Your sidekick as the shop shows it (Buddy until you have one).
function myKick() {
    const u = me(), eq = u && u.equipped;
    const id = eq && eq.sidekick && cos.byId(eq.sidekick) ? eq.sidekick : 'sd_buddy';
    const c = (eq && eq.sidekickColor) || null;
    return { kick: id, name: (eq && eq.sidekickName) || null, col: c === 'own' ? null : c || '#00b2e1' };
}
// A preview for an item at w x h: a skin on a tank, a name style on a
// nameplate, a sidekick, or a sidekick face / name style on your sidekick.
export function itemPreview(it, w, h, opts) {
    opts = opts || {};
    if (opts.stage && isSidekickCat(it.cat)) {
        const k = myKick();
        const kick = it.cat === 'sidekick' ? it.id : k.kick;
        return pv.sidekickStage({ w, h, tank: opts.tank, color: opts.color, kick, col: it.cat === 'sidekick' ? null : k.col,
            look: it.cat === 'sdSkin' ? it : null, style: it.cat === 'sdName' ? it : null, name: it.cat === 'sidekick' ? it.name : (k.name || cos.byId(kick).name) });
    }
    // the cards: a little stage each, bobbing and popping shots while on screen
    if (it.cat === 'sidekick') return pv.sidekickPreview({ w, h, kick: it, r: Math.min(w, h) * 0.2 });
    if (it.cat === 'sdSkin') { const k = myKick(); return pv.sidekickPreview({ w, h, kick: k.kick, look: it, col: k.col, r: Math.min(w, h) * 0.21 }); }
    if (it.cat === 'sdName') {
        const k = myKick();
        return pv.sidekickPreview({ w, h, kick: k.kick, col: k.col, style: it, name: k.name || cos.byId(k.kick).name, r: Math.min(w, h) * 0.13, px: opts.px ? Math.round(opts.px * 0.85) : 16 });
    }
    if (it.cat === 'skin') return pv.tankPreview({ w, h, skin: it, color: opts.color, tank: opts.tank, cls: opts.cls, size: opts.size });
    return pv.namePreview({ w, h, name: myName(), style: it, custom: opts.custom || (it.id === cos.CUSTOM_ID ? (opts.custom || '#7ad3ff') : null), color: opts.color, tank: opts.tank, cls: opts.cls, px: opts.px });
}

/* ── the pane ───────────────────────────────────────────────────────── */
export function render(el) {
    paneEl = el;
    stopTimer();
    pv.stopUnder(el);
    clear(el);
    if (!me()) { paintGuest(el); return; }
    if (data && Date.now() - fetchedAt < 30000) paint(el);
    else {
        el.appendChild(h('div', { class: 'shop-loading', text: 'Opening the shop...' }));
    }
    load(el);
}
export function onClose() { stopTimer(); if (paneEl) pv.stopUnder(paneEl); }
// The shop changed under us (an admin re-roll): refetch, and repaint if the pane is up.
export function refresh() {
    fetchedAt = 0;
    if (paneEl && paneEl.isConnected) load(paneEl);
}

async function load(el) {
    const seq = ++loadSeq;
    const r = await api.store();
    if (seq !== loadSeq || el !== paneEl) return;
    if (!r.ok || !r.data || !Array.isArray(r.data.featured)) {
        if (data) return; // keep what is on screen
        clear(el);
        el.appendChild(h('div', { class: 'shop-empty' },
            h('div', { class: 'shop-empty-h', text: 'Shop didn’t load' }),
            h('div', { class: 'shop-empty-p', text: humanError(r) }),
            h('button', { type: 'button', class: 'dw-btn sm', text: 'Retry', onclick: () => render(el) })));
        return;
    }
    const sig = JSON.stringify([r.data.day, r.data.balanceMilli, r.data.featured.map((x) => x.id + x.owned), r.data.daily.map((x) => x.id + x.owned), (r.data.sidekicks || []).map((x) => x.id + x.owned), (r.data.permanent || []).map((x) => x.owned)]);
    const had = data && data._sig === sig;
    data = r.data;
    data._sig = sig;
    fetchedAt = Date.now();
    markSeen(data.day);
    handlers.onBalance(data.balance);
    if (!had || !el.querySelector('.shop-grid')) { stopTimer(); pv.stopUnder(el); clear(el); paint(el); }
}

function paint(el) {
    const bal = h('span', { class: 'shop-bal', title: 'Your gemdust' }, icon('dust'), h('span', { text: fmtDust(data.balance) }));
    const count = h('span', { class: 'shop-count' });
    // purchases + refunds are a quiet link, not a button
    const top = h('div', { class: 'shop-top' },
        h('div', { class: 'shop-reset' }, h('span', { class: 'shop-reset-l', text: 'New items in' }), count),
        h('div', { class: 'shop-top-r' },
            h('button', { type: 'button', class: 'dw-link', text: 'My purchases', onclick: openHistory }), bal));
    el.appendChild(top);
    const perm = data.permanent || [];
    const shelf = data.sidekicks || [];
    const tabs = h('div', { class: 'lk-tabs shop-tabs', role: 'tablist' });
    const body = h('div', { class: 'shop-tabbody', role: 'tabpanel' });
    const paintTabs = () => {
        clear(tabs);
        for (const [k, label] of [['shop', 'Shop'], ['sidekicks', 'Sidekicks'], ['all', 'View all']]) {
            tabs.appendChild(h('button', {
                type: 'button', class: 'lk-tab' + (tab === k ? ' on' : ''), role: 'tab', 'aria-selected': tab === k ? 'true' : 'false',
                onclick: () => { if (tab === k) return; tab = k; paintTabs(); paintBody(); },
            }, h('span', { text: label })));
        }
    };
    const paintBody = () => {
        pv.stopUnder(body);
        clear(body);
        const of = (list, cat) => list.filter((it) => it.cat === cat);
        if (tab === 'all') { gallery.render(body, galleryDeps()); return; }
        if (tab === 'sidekicks') {
            // Buddy (the Basic one) is always first on the shelf
            body.appendChild(section('Sidekicks', perm.filter((it) => it.cat === 'sidekick').concat(of(shelf, 'sidekick')).map((it) => card(it, 'side')), 'side'));
            body.appendChild(section('Sidekick skins', of(shelf, 'sdSkin').map((it) => card(it, 'side')), 'side'));
            return;
        }
        body.appendChild(section('Today’s featured items', data.featured.map((it) => card(it, 'feat')), 'feat'));
        const daily = data.daily.filter((it) => !isSidekickCat(it.cat));
        if (of(daily, 'skin').length) body.appendChild(section('Skins', of(daily, 'skin').map((it) => card(it, 'daily')), 'daily'));
        if (of(daily, 'nameStyle').length) body.appendChild(section('Name styles', of(daily, 'nameStyle').map((it) => card(it, 'daily')), 'daily'));
        const always = perm.filter((it) => !isSidekickCat(it.cat));
        if (always.length) body.appendChild(section('Always here', always.map((it) => card(it, 'perm')), 'perm'));
    };
    paintTabs();
    paintBody();
    el.append(tabs, body);
    const tick = () => {
        const left = (+data.resetsAt || 0) - serverNow();
        count.textContent = fmtLeft(left);
        count.classList.toggle('soon', left < 10 * 60000);
        if (left <= 0) { stopTimer(); setTimeout(() => { if (paneEl === el && el.isConnected) { data = null; render(el); } }, 1500); }
    };
    tick();
    timer = setInterval(tick, 1000);
}
function stopTimer() { if (timer) { clearInterval(timer); timer = 0; } }

/* ── View all (look only) ───────────────────────────────────────────── */
// What the gallery gets: drawing helpers and what you own, never a way to buy
function galleryDeps() {
    return {
        h, icon, clear, rarityName,
        items: (window.DWCosmetics && window.DWCosmetics.ITEMS) || [],
        preview: (it, w, hh) => itemPreview(it, w, hh, { custom: it.id === cos.CUSTOM_ID ? customNow() : null, px: 18 }),
        stop: pv.stopUnder,
        owned: ownedIds(),
    };
}
// The ids you own (the Locker's list, kept for 30 s), or null for a guest
let ownedCache = null;   // { at, user, set | promise }
function ownedIds() {
    const u = me();
    if (!u) return null;
    if (ownedCache && ownedCache.user === u.userId && Date.now() - ownedCache.at < 30000) return ownedCache.set;
    const seen = new Set();
    if (data) for (const list of [data.featured || [], data.daily || [], data.sidekicks || [], data.permanent || []]) for (const x of list) if (x.owned) seen.add(x.id);
    const c = { at: Date.now(), user: u.userId, set: null };
    c.set = api.locker().then((r) => {
        const out = new Set(seen);
        for (const x of (r.ok && r.data && r.data.owned) || []) out.add(typeof x === 'string' ? x : x && (x.id || x.itemId));
        if (ownedCache === c) c.set = out;
        return out;
    });
    ownedCache = c;
    return c.set;
}
// A guest: the gallery, and a way to log in to buy
function paintGuest(el) {
    el.appendChild(h('div', { class: 'shop-top gal-guest' },
        h('div', { class: 'gal-guest-p', text: 'You’re playing as a guest. Log in to buy items.' }),
        h('button', { type: 'button', class: 'dw-btn sm primary', text: 'Log in', onclick: () => handlers.onLogin() })));
    const body = h('div', { class: 'shop-tabbody', role: 'region', 'aria-label': 'View all' });
    el.appendChild(body);
    gallery.render(body, galleryDeps());
}

function section(title, cards, kind) {
    return h('div', { class: 'shop-sec ' + kind },
        h('div', { class: 'shop-h', text: title }),
        h('div', { class: 'shop-grid ' + kind }, cards));
}

function card(raw, kind) {
    const it = full(raw);
    const tags = [];
    const big = kind === 'feat';
    // side cards sit five to a row, so their stage is a bit smaller
    const [w, hh] = big ? [340, 172] : kind === 'perm' ? [220, 100] : kind === 'side' ? [136, 104] : [164, 112];
    if (it.permanent && isSidekickCat(it.cat)) tags.push(h('span', { class: 'shop-tag', text: 'always' }));
    const prev = itemPreview(it, w, hh, { custom: it.id === cos.CUSTOM_ID ? customNow() : null, px: big ? 26 : 18 });
    if (isAnimated(it)) tags.push(h('span', { class: 'shop-tag', text: 'moves' }));
    return h('button', { type: 'button', class: 'shop-card r-' + (it.rarity || 'common') + (it.owned ? ' owned' : ''), 'data-id': it.id, onclick: () => openItem(it) },
        h('span', { class: 'shop-band' }),
        h('span', { class: 'shop-prev' }, prev),
        h('span', { class: 'shop-meta' },
            h('span', { class: 'shop-name', text: it.name }),
            h('span', { class: 'shop-sub' }, h('span', { class: 'shop-rar', text: rarityName(it.rarity) }), h('span', { text: '\u00a0· ' + (kind === 'side' ? SIDE_CAT[it.cat] : catName(it.cat)) }), tags),
            h('span', { class: 'shop-foot' }, it.owned ? h('span', { class: 'shop-owned', text: 'Got it' }) : priceTag(it.price))));
}
function customNow() {
    const u = me();
    return (u && u.equipped && u.equipped.customColor) || '#7ad3ff';
}

/* ── "NEW" dot on the nav ───────────────────────────────────────────── */
const SEEN = 'dwShopSeenDay';
export const utcDay = () => Math.floor(Date.now() / 86400000);
function markSeen(day) {
    try { localStorage.setItem(SEEN, String(day)); } catch (e) { /* */ }
    const b = document.querySelector('.dw-nav-btn[data-pane="shop"]');
    if (b) b.classList.remove('has-new');
}
export function hasNew() {
    let seen = null;
    try { seen = localStorage.getItem(SEEN); } catch (e) { /* */ }
    return String(utcDay()) !== String(seen);
}

/* ── colour editor (shop + locker) ──────────────────────────────────── */
export const PRESET_COLORS = ['#ff6b6b', '#ff9f43', '#ffd84d', '#a3e635', '#4ade80', '#2dd4bf', '#38bdf8', '#7ad3ff', '#818cf8', '#c084fc', '#f472b6', '#f2f2f2'];
// -> { el, value(), valid() }
export function colorEditor(initial, onChange) {
    const C = window.DWCosmetics;
    let val = (initial && /^#[0-9a-f]{6}$/i.test(initial) ? initial : '#7ad3ff').toLowerCase();
    const picker = h('input', { type: 'color', class: 'lk-picker', value: val, 'aria-label': 'Pick a colour' });
    const hex = h('input', { type: 'text', class: 'dw-input lk-hex', value: val, maxlength: 7, spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Hex colour' });
    const msg = h('div', { class: 'lk-cmsg', role: 'status' });
    const presets = h('div', { class: 'lk-presets' }, PRESET_COLORS.map((c) => h('button', {
        type: 'button', class: 'lk-preset', title: c, 'aria-label': 'Use ' + c, style: { background: c }, onclick: () => set(c, 'preset'),
    })));
    const ok = (c) => !!(C && C.isColorAllowed(c));
    function set(c, from) {
        c = String(c || '').trim().toLowerCase();
        if (c && c[0] !== '#') c = '#' + c;
        const good = /^#[0-9a-f]{6}$/.test(c);
        if (good) { val = c; if (from !== 'picker') picker.value = c; }
        if (from !== 'hex') hex.value = good ? c : hex.value;
        const allowed = good && ok(c);
        hex.classList.toggle('bad', !allowed);
        msg.textContent = !good ? 'Please enter a hex colour, like #7ad3ff.' : allowed ? '' : 'That’s too dark to see in the caves.';
        msg.classList.toggle('show', !allowed);
        presets.querySelectorAll('.lk-preset').forEach((b) => b.classList.toggle('on', b.title === val));
        if (onChange) onChange(val, allowed && good);
    }
    picker.addEventListener('input', () => set(picker.value, 'picker'));
    hex.addEventListener('input', () => set(hex.value, 'hex'));
    const el = h('div', { class: 'lk-color' },
        h('div', { class: 'lk-crow' }, picker, hex),
        presets, msg);
    setTimeout(() => set(val, 'init'), 0);
    return { el, value: () => val, valid: () => /^#[0-9a-f]{6}$/.test(val) && ok(val) };
}

/* ── the item modal ─────────────────────────────────────────────────── */
const ERR = {
    insufficient_dust: 'You don’t have enough gemdust.',
    already_owned: 'You already have this.',
    not_in_shop: 'That item isn’t in the shop anymore.',
    shop_rotated: 'The shop just changed, so there are new items up.',
    bad_color: 'That’s too dark to see in the caves.',
    color_required: 'Please pick a colour first.',
    not_owned: 'You don’t own that item.',
    not_friends: 'You can only send gifts to friends.',
    friends_too_new: 'You can send a gift 2 days after you become friends.',
    recipient_owns: 'They already have it.',
    gift_limit: 'You can send up to 5 gifts a day. Try again tomorrow.',
    no_refund_tokens: 'You don’t have any refunds left.',
    refund_expired: 'Refunds only work for 24h after you buy, so it’s too late for this one.',
    already_refunded: 'That was already refunded.',
    gift_not_refundable: 'Gifts can’t be refunded.',
};
export function storeError(res) {
    const code = res && res.data && res.data.error && res.data.error.code;
    return (code && ERR[code]) || humanError(res);
}
const staleDay = (res) => { const c = res && res.data && res.data.error && res.data.error.code; return c === 'shop_rotated' || c === 'not_in_shop'; };

function tankOptions(list) {
    const tiers = new Map();
    for (const [k, label, tier] of list) {
        if (!tiers.has(tier)) tiers.set(tier, []);
        tiers.get(tier).push([k, label]);
    }
    return [...tiers.keys()].sort((a, b) => a - b).map((tier) => h('optgroup', { label: 'Tier ' + tier },
        tiers.get(tier).sort((a, b) => (a[0] === 'basic' ? -1 : b[0] === 'basic' ? 1 : a[1].localeCompare(b[1])))
            .map(([k, label]) => h('option', { value: k, text: label }))));
}

export function openItem(raw) {
    const it = full(raw);
    let colorIdx = 0, tank = 'basic';
    let custom = customNow();
    const stage = h('div', { class: 'shop-mprev' });
    const drawStage = () => {
        pv.stopUnder(stage);
        clear(stage);
        stage.appendChild(itemPreview(it, 300, 300, { color: pv.TEAM_COLORS[colorIdx].col, tank, custom, px: 28, size: 70, stage: true }));
    };
    const sw = h('div', { class: 'shop-swatches', role: 'radiogroup', 'aria-label': 'Team colour' },
        pv.TEAM_COLORS.map((tc, i) => h('button', {
            type: 'button', class: 'shop-sw' + (i === 0 ? ' on' : ''), role: 'radio', 'aria-checked': i === 0 ? 'true' : 'false',
            title: tc.name, 'aria-label': tc.name, style: { background: pv.teamHex(tc.col) },
            onclick: (e) => {
                colorIdx = i;
                sw.querySelectorAll('.shop-sw').forEach((b, j) => { b.classList.toggle('on', j === i); b.setAttribute('aria-checked', j === i ? 'true' : 'false'); });
                drawStage();
            },
        })));
    const tankSel = h('select', { class: 'dw-input shop-tanksel', 'aria-label': 'Tank', onchange: (e) => { tank = e.target.value; drawStage(); } },
        tankOptions(pv.tankList()));
    pv.ready().then(() => {
        const list = pv.tankList();
        if (list.length <= tankSel.options.length) return;
        clear(tankSel);
        tankSel.append(...tankOptions(list));
        tankSel.value = tank;
    });
    const alert = h('div', { class: 'dw-alert', role: 'alert' });
    const actions = h('div', { class: 'shop-mact' });
    const note = h('div', { class: 'shop-mnote' });
    let editor = null;
    if (it.id === cos.CUSTOM_ID) {
        editor = colorEditor(custom, (c, ok) => { if (ok) { custom = c; drawStage(); } paintActions(); });
    }
    const info = h('div', { class: 'shop-minfo' },
        h('div', { class: 'shop-mrar r-' + (it.rarity || 'common'), text: rarityName(it.rarity) + ' ' + catName(it.cat) }),
        h('div', { class: 'shop-mname', text: it.name }),
        h('div', { class: 'shop-mdesc', text: describe(it) }),
        editor ? editor.el : null,
        h('div', { class: 'shop-mprice' }, it.owned ? h('span', { class: 'shop-owned', text: 'Got it' }) : priceTag(it.price, 'big')),
        actions, note, alert);
    const m = modal({
        title: '', cls: 'shop-modal r-' + (it.rarity || 'common'),
        body: h('div', { class: 'shop-mbody' },
            h('button', { type: 'button', class: 'hub-close shop-mx', title: 'Close', 'aria-label': 'Close', onclick: () => m.close() }, icon('close')),
            h('div', { class: 'shop-mleft' }, stage, sw, h('label', { class: 'shop-tankrow' }, h('span', { text: 'Try on' }), tankSel)),
            info),
        onClose: () => pv.stopUnder(stage),
    });
    m.card.setAttribute('aria-label', it.name);
    drawStage();

    function paintActions() {
        clear(actions);
        note.textContent = '';
        const bal = data ? +data.balanceMilli || Math.round((+data.balance || 0) * 1000) : 0;
        if (it.owned) {
            const u = me();
            if (it.wornNow || (u && u.equipped && u.equipped[it.cat] === it.id)) {
                actions.append(
                    h('span', { class: 'lk-eqlabel', text: 'Wearing it' }),
                    h('button', { type: 'button', class: 'dw-link', text: 'or gift one', onclick: () => openGift(it) }));
                note.textContent = it.cat === 'sidekick' ? 'It’s on. You can give it a name in your Locker.' : 'It’s on. You’ll see it next time you spawn.';
                return;
            }
            actions.append(
                h('button', { type: 'button', class: 'dw-btn primary', 'data-autofocus': '', text: 'Wear it', onclick: (e) => doEquip(e.currentTarget) }),
                h('button', { type: 'button', class: 'dw-link', text: 'or gift one', onclick: () => openGift(it) }));
            note.textContent = 'It’s in your locker, ready to wear.';
            return;
        }
        const short = Math.max(0, it.price - bal);
        const buy = h('button', { type: 'button', class: 'dw-btn primary', 'data-autofocus': '', text: 'Buy', onclick: (e) => doBuy(e.currentTarget) });
        if (short > 0 || (editor && !editor.valid())) buy.disabled = true;
        actions.append(buy, h('button', { type: 'button', class: 'dw-link', text: 'or gift it', onclick: () => openGift(it) }));
        if (short > 0) note.textContent = 'You need ' + fmtPrice(short) + ' more gemdust.';
    }
    paintActions();

    async function doBuy(btn) {
        const yes = await confirm({
            title: 'Buy ' + it.name + '?',
            message: 'It costs ' + fmtPrice(it.price) + ' gemdust, and you have ' + fmtDust(data ? data.balance : 0) + '.',
            confirmLabel: 'Buy', cancelLabel: 'Cancel',
        });
        if (!yes) return;
        setBusy(btn, true, 'Buying...');
        alert.className = 'dw-alert';
        const r = await api.purchase(it.id, data ? data.day : 0, api.idemKey(), editor ? editor.value() : null);
        setBusy(btn, false);
        if (!r.ok) {
            alert.textContent = storeError(r);
            alert.className = 'dw-alert show';
            if (staleDay(r)) reload();
            return;
        }
        it.owned = true;
        // bought means worn (the server put it on)
        it.wornNow = !!(r.data && r.data.equipped && r.data.equipped[it.cat] === it.id);
        markOwned(it.id, r.data);
        paintActions();
        swapPrice();
        const t = it.wornNow
            ? toast('You got ' + it.name + ', and it’s on!', { kind: 'ok', actions: it.cat === 'sidekick' ? [{ label: 'Name it', onClick: () => handlers.openLocker('sidekick') }] : [] })
            : toast('You got ' + it.name + '!', { kind: 'ok', actions: [{ label: 'Wear it', onClick: () => equipItem(it, editor ? editor.value() : null) }] });
        pop(m.card.querySelector('.shop-mprice'));
        return t;
    }
    async function doEquip(btn) {
        setBusy(btn, true, 'Putting on...');
        const ok = await equipItem(it, editor ? editor.value() : null, alert);
        setBusy(btn, false);
        if (ok) m.close();
    }
    function swapPrice() {
        const p = m.card.querySelector('.shop-mprice');
        if (p) { clear(p); p.appendChild(h('span', { class: 'shop-owned', text: 'Got it' })); }
    }
    function reload() { if (paneEl && paneEl.isConnected) { data = null; render(paneEl); } }
}

function pop(el) {
    animate(el, [{ transform: 'scale(1)' }, { transform: 'scale(1.08)' }, { transform: 'scale(1)' }], { duration: T_MID + 80 });
}

// sidekicks help you mine (server/game/terrain/sidekickDig.js)
const digLine = () => (typeof window !== 'undefined' && window.DWCosmetics && window.DWCosmetics.SIDEKICK_DIG_LINE) || 'It helps you mine, but it only shoots rocks.';
function describe(it) {
    if (it.blurb) return it.cat === 'sidekick' ? it.blurb + ' ' + digLine() : it.blurb;
    if (it.id === cos.CUSTOM_ID) return 'Any colour you want for your name, and you can change it whenever you like.';
    if (it.cat === 'skin') return isAnimated(it) ? 'A moving pattern for your tank that keeps your team colour.' : 'A pattern for your tank that keeps your team colour.';
    const s = it.style || {};
    if (s.kind === 'prism') return 'A rainbow name that sparkles.';
    if (s.kind === 'scroll') return s.glint ? 'A name with colours that flow and sparkle.' : 'A name with colours that flow.';
    return 'A name that fades between colours.';
}

// After a buy: mark it owned in the cached store, update the balance.
function markOwned(id, res) {
    ownedCache = null;
    if (!data) return;
    for (const list of [data.featured, data.daily, data.sidekicks || [], data.permanent || []]) for (const x of list) if (x.id === id) x.owned = true;
    if (res && res.balance != null) { data.balance = res.balance; data.balanceMilli = res.balanceMilli; }
    data._sig = null;
    handlers.onBalance(data.balance);
    handlers.refreshMe();
    if (paneEl && paneEl.isConnected) { stopTimer(); pv.stopUnder(paneEl); clear(paneEl); paint(paneEl); }
}

// Equip from anywhere in the shop. Resolves true on success.
export async function equipItem(it, color, alertEl) {
    const r = await api.equip(it.cat, it.id, it.id === cos.CUSTOM_ID ? color : null);
    if (!r.ok) {
        const msg = storeError(r);
        if (alertEl) { alertEl.textContent = msg; alertEl.className = 'dw-alert show'; } else toast(msg, { kind: 'error' });
        return false;
    }
    toast(it.name + ' is on. You’ll see it next time you spawn.', { kind: 'ok' });
    handlers.refreshMe();
    return true;
}

/* ── gifting ────────────────────────────────────────────────────────── */
async function openGift(it) {
    const list = h('div', { class: 'shop-glist' }, h('div', { class: 'shop-loading', text: 'Finding friends...' }));
    const alert = h('div', { class: 'dw-alert', role: 'alert' });
    const send = h('button', { type: 'button', class: 'dw-btn primary', text: 'Send', disabled: true });
    let to = null, preset = 0;
    const msgs = h('div', { class: 'shop-gmsgs', role: 'radiogroup', 'aria-label': 'Message' },
        GIFT_MESSAGES.map((t, i) => h('button', {
            type: 'button', class: 'shop-gmsg' + (i === 0 ? ' on' : ''), role: 'radio', 'aria-checked': i === 0 ? 'true' : 'false', text: t,
            onclick: (e) => { preset = i; msgs.querySelectorAll('.shop-gmsg').forEach((b, j) => { b.classList.toggle('on', j === i); b.setAttribute('aria-checked', j === i ? 'true' : 'false'); }); },
        })));
    const body = h('div', { class: 'shop-gift' },
        h('div', { class: 'shop-gline' }, h('span', { text: 'Costs you' }), priceTag(it.price)),
        list, h('div', { class: 'shop-glabel', text: 'Note' }), msgs, alert,
        h('div', { class: 'dw-modal-actions' }, h('button', { type: 'button', class: 'dw-btn', text: 'Back', onclick: () => m.close() }), send));
    const m = modal({ title: 'Gift ' + it.name, cls: 'shop-giftm', body });
    const r = await api.friends();
    const friends = (r.ok && r.data && (r.data.friends || r.data.list)) || [];
    clear(list);
    if (!friends.length) {
        msgs.hidden = true;
        body.querySelector('.shop-glabel').hidden = true;
        list.appendChild(h('div', { class: 'shop-gnone' },
            icon('friends'),
            h('div', { class: 'shop-gnone-h', text: 'No friends to gift yet' }),
            h('div', { class: 'shop-gnone-p', text: 'Add some friends first. After 2 days, you can gift them anything here.' })));
        send.hidden = true;
        return;
    }
    friends.forEach((f) => {
        const b = h('button', { type: 'button', class: 'shop-gfriend', role: 'radio', 'aria-checked': 'false', onclick: () => {
            to = f;
            list.querySelectorAll('.shop-gfriend').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', x === b ? 'true' : 'false'); });
            send.disabled = false;
        } }, h('span', { class: 'shop-gname', text: f.username || f.name || 'Friend' }));
        list.appendChild(b);
    });
    send.addEventListener('click', async () => {
        if (!to) return;
        const yes = await confirm({ title: 'Send ' + it.name + '?', message: 'This sends it to ' + (to.username || 'your friend') + ' for ' + fmtPrice(it.price) + ' gemdust. Gifts can’t be refunded.', confirmLabel: 'Send' });
        if (!yes) return;
        setBusy(send, true, 'Sending...');
        const g = await api.gift(it.id, data ? data.day : 0, to.userId || to.id, api.idemKey(), preset);
        setBusy(send, false);
        if (!g.ok) { alert.textContent = storeError(g); alert.className = 'dw-alert show'; return; }
        if (data && g.data && g.data.balance != null) { data.balance = g.data.balance; data.balanceMilli = g.data.balanceMilli; handlers.onBalance(data.balance); }
        handlers.refreshMe();
        m.close();
        toast('Gift sent to ' + (to.username || 'your friend') + '!', { kind: 'ok' });
    });
}

/* ── purchase history + refunds ─────────────────────────────────────── */
async function openHistory() {
    const list = h('div', { class: 'shop-hist' }, h('div', { class: 'shop-loading', text: 'Loading...' }));
    const pips = h('span', { class: 'shop-pips', title: 'Refunds left' });
    const m = modal({
        title: 'My purchases', cls: 'shop-histm',
        body: h('div', {},
            h('div', { class: 'shop-tokens' }, h('span', { text: 'Refunds left' }), pips),
            h('div', { class: 'shop-tokens-p', text: 'You can refund an item for 24h after you buy it. You get 3 refunds in total.' }),
            list,
            h('div', { class: 'dw-modal-actions' }, h('button', { type: 'button', class: 'dw-btn', text: 'Done', onclick: () => m.close() }))),
    });
    async function fill() {
        const r = await api.storeHistory();
        clear(list);
        if (!r.ok || !r.data) { list.appendChild(h('div', { class: 'shop-hnone', text: humanError(r) })); return; }
        const tokens = r.data.refundTokens | 0;
        clear(pips);
        for (let i = 0; i < 3; i++) pips.appendChild(h('span', { class: 'shop-pip' + (i < tokens ? ' on' : '') }));
        pips.setAttribute('aria-label', tokens + ' of 3 refunds left');
        const rows = r.data.entries || [];
        if (!rows.length) { list.appendChild(h('div', { class: 'shop-hnone', text: 'Nothing here yet.' })); return; }
        for (const e of rows) list.appendChild(histRow(e, tokens, fill));
    }
    fill();
}

function histRow(e, tokens, refill) {
    const what = e.direction === 'sent' ? 'Gift to ' + ((e.to && e.to.username) || 'a friend')
        : e.direction === 'received' ? 'Gift from ' + ((e.from && e.from.username) || 'a friend') : 'Bought';
    const right = [];
    if (e.refundedAt) right.push(h('span', { class: 'shop-htag', text: 'Refunded' }));
    else if (e.refundable) {
        right.push(h('button', { type: 'button', class: 'dw-btn sm', text: 'Refund', onclick: async (ev) => {
            const btn = ev.currentTarget;
            const yes = await confirm({
                title: 'Refund ' + e.name + '?',
                message: 'You’ll get ' + fmtPrice(e.priceMilli) + ' gemdust back, and it leaves your locker. This uses 1 of your ' + tokens + ' refund' + (tokens === 1 ? '' : 's') + '.',
                confirmLabel: 'Refund', danger: true,
            });
            if (!yes) return;
            setBusy(btn, true, 'Refunding...');
            const r = await api.refund(e.purchaseId);
            setBusy(btn, false);
            if (!r.ok) { toast(storeError(r), { kind: 'error' }); return; }
            toast(e.name + ' refunded', { kind: 'ok' });
            ownedCache = null;
            if (data) { data.balance = r.data.balance; data.balanceMilli = r.data.balanceMilli; for (const l of [data.featured, data.daily, data.permanent || []]) for (const x of l) if (x.id === e.itemId) x.owned = false; data._sig = null; handlers.onBalance(data.balance); }
            handlers.refreshMe();
            if (paneEl && paneEl.isConnected) { stopTimer(); pv.stopUnder(paneEl); clear(paneEl); paint(paneEl); }
            refill();
        } }));
    }
    return h('div', { class: 'shop-hrow r-' + (e.rarity || 'common') },
        h('span', { class: 'shop-hdot' }),
        h('span', { class: 'shop-hmain' },
            h('span', { class: 'shop-hname', text: e.name }),
            h('span', { class: 'shop-hsub', text: what + ' · ' + fmtDateTime(e.createdAt) })),
        e.priceMilli ? priceTag(e.priceMilli, 'sm') : null,
        right);
}
