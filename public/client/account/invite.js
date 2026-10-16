// Invites. capture() keeps a ?ref= code this browser arrived with
// (localStorage plus a 30-day first-party cookie) so the next sign-up can
// send it; any login drops it, since only a brand-new account can be
// referred. Also the Invite button beside the account chip and its panel.
import * as api from './api.js';
import * as store from './state.js';
import { h, icon, clear, modal, toast, copyText, fmtDust, humanError, avatar, animate, T_MID } from './ui.js';
import * as pv from './previews.js';

const KEY = 'dwRef';
const COOKIE = 'dw_ref';
const TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CODE_RE = /^[0-9A-HJKMNP-TV-Z]{7}$/;
const DISCORD_URL = 'https://discord.gg/bx5FK3CMwp';
const STYLE_ID = (window.DWCosmetics && window.DWCosmetics.INVITE_STYLE_ID) || 'ns_ringleader';
const GAP = 10;

const ls = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* */ } },
};

// Same folding as the server: case, dashes, and Crockford look-alikes.
export function normalize(raw) {
    const s = String(raw == null ? '' : raw).slice(0, 32).toUpperCase().replace(/[\s\-_]+/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
    return CODE_RE.test(s) ? s : '';
}

function setCookie(value, maxAge) {
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    try { document.cookie = COOKIE + '=' + value + '; Max-Age=' + maxAge + '; Path=/; SameSite=Lax' + secure; } catch (e) { /* */ }
}
function cookieCode() {
    const m = /(?:^|;\s*)dw_ref=([^;]*)/.exec(document.cookie || '');
    return m ? normalize(decodeURIComponent(m[1])) : '';
}

export function capture() {
    const p = new URLSearchParams(location.search);
    if (!p.has('ref')) return;
    const code = normalize(p.get('ref'));
    p.delete('ref');
    const q = p.toString();
    try { history.replaceState(history.state, '', location.pathname + (q ? '?' + q : '') + location.hash); } catch (e) { /* */ }
    if (!code) return;
    ls.set(KEY, JSON.stringify({ code, at: Date.now() }));
    setCookie(code, Math.floor(TTL_MS / 1000));
}

export function storedCode() {
    let v = null;
    try { v = JSON.parse(ls.get(KEY) || 'null'); } catch (e) { v = null; }
    if (v && typeof v.code === 'string' && Date.now() - (+v.at || 0) < TTL_MS) {
        const c = normalize(v.code);
        if (c) return c;
    }
    if (v) ls.del(KEY);
    return cookieCode();
}

export function forget() {
    ls.del(KEY);
    if (cookieCode()) setCookie('', 0);
}

/* ── the button ─────────────────────────────────────────────────────── */
let btn = null;
function place() {
    const chip = document.getElementById('accountChip');
    const nav = document.getElementById('menuNav');
    if (!btn || !chip) return;
    const r = chip.getBoundingClientRect();
    if (!r.width) return;
    btn.classList.remove('stacked');
    if (r.left < window.innerWidth - r.right) {
        btn.style.left = Math.round(r.right + 8) + 'px';
        btn.style.right = 'auto';
        return;
    }
    btn.style.left = '';
    btn.style.right = Math.round(window.innerWidth - r.left + GAP) + 'px';
    const n = nav ? nav.getBoundingClientRect() : null;
    const b = btn.getBoundingClientRect();
    // no room between the nav and the chip: tuck it under the theme toggle
    if (n && n.width && b.left < n.right + GAP) {
        btn.classList.add('stacked');
        btn.style.right = '';
    }
}

function mountButton() {
    const chip = document.getElementById('accountChip');
    if (!chip || document.getElementById('inviteBtn')) return;
    btn = h('button', { type: 'button', id: 'inviteBtn', title: 'Invite friends', 'aria-label': 'Invite friends', onclick: () => open() },
        icon('invite'), h('span', { class: 'ib-label', text: 'Invite' }));
    chip.after(btn);
    if (typeof ResizeObserver === 'function') new ResizeObserver(place).observe(chip);
    window.addEventListener('resize', place);
    requestAnimationFrame(place);
}

/* ── the panel ──────────────────────────────────────────────────────── */
let panel = null;   // { m, body, data }

function styleItem() {
    const C = window.DWCosmetics;
    return C ? C.byId(STYLE_ID) : null;
}

function pips(count) {
    const row = h('div', { class: 'iv-pips', role: 'img', 'aria-label': Math.min(count, 5) + ' of 5 friends' });
    for (let i = 1; i <= 5; i++) {
        row.appendChild(h('span', { class: 'iv-pip' + (i <= count ? ' on' : '') + (i === 3 || i === 5 ? ' goal' : '') },
            i === 3 || i === 5 ? h('span', { class: 'iv-pip-n', text: String(i) }) : null));
    }
    return row;
}

function status(on, need, count) {
    if (on) return h('span', { class: 'iv-state on' }, icon('check'), h('span', { text: 'Unlocked' }));
    const left = Math.max(0, need - count);
    return h('span', { class: 'iv-state' }, icon('lock'), h('span', { text: left === 1 ? '1 more' : left + ' more' }));
}

function rewardRow(opts) {
    return h('div', { class: 'iv-reward' + (opts.on ? ' on' : '') },
        h('div', { class: 'iv-rw-art' }, opts.art),
        h('div', { class: 'iv-rw-text' },
            h('div', { class: 'iv-rw-tag', text: opts.tag }),
            h('div', { class: 'iv-rw-name', text: opts.name }),
            opts.sub ? h('div', { class: 'iv-rw-sub' }, opts.sub) : null),
        opts.state || null);
}

function rewards(d, name) {
    const r = d ? d.rewards : null;
    const count = d ? d.count | 0 : 0;
    const perFriend = r ? r.perFriendMilli / 1000 : 3;
    const earned = r ? r.dustEarnedMilli / 1000 : 0;
    const it = styleItem();
    const styleOn = !!(r && r.nameStyle.unlocked);
    const skinOn = !!(r && r.customSkin.unlocked);
    const dustArt = h('span', { class: 'iv-dust' }, icon('dust'), h('span', { text: '+' + fmtDust(perFriend).replace(/\.00$/, '') }));
    return h('div', { class: 'iv-rewards' },
        rewardRow({
            art: dustArt, tag: 'Every friend', name: fmtDust(perFriend).replace(/\.00$/, '') + ' gemdust',
            sub: d ? (earned > 0 ? fmtDust(earned).replace(/\.00$/, '') + ' earned so far' : 'Up to ' + ((r && r.paidMax) || 25) + ' friends') : 'Up to 25 friends',
            on: earned > 0,
            state: earned > 0 ? h('span', { class: 'iv-state on' }, icon('check'), h('span', { text: count + 'x' })) : null,
        }),
        rewardRow({
            art: pv.nameCanvas(name, it, { px: 15, stroke: true, h: 40, maxW: 116, cls: 'dw-name-cv iv-style-cv' }),
            tag: '3 friends', name: (it ? it.name : 'Exclusive') + ' name style',
            sub: styleOn ? 'In your locker' : 'Never in the shop',
            on: styleOn, state: status(styleOn, 3, count),
        }),
        rewardRow({
            art: h('span', { class: 'iv-skin-art' }, pv.tankPreview({ w: 124, h: 48, size: 14, color: pv.TEAM_COLORS[0].col }), h('span', { class: 'iv-skin-q', text: '?' })),
            tag: '5 friends', name: 'Your own custom skin',
            sub: skinOn
                ? h('span', null, 'DM ', h('b', { text: 'ZyroX' }), ' on ', h('a', { href: DISCORD_URL, target: '_blank', rel: 'noopener', text: 'Discord' }), ' and we’ll make it for you')
                : 'Made just for you',
            on: skinOn, state: status(skinOn, 5, count),
        }));
}

const STATUS_TEXT = { qualified: 'Counted', pending: 'Playing first game', expired: 'Never played', not_eligible: 'Didn’t count' };
function friendsList(d) {
    if (!d || !d.recent || !d.recent.length) return null;
    return h('div', { class: 'iv-sec' },
        h('div', { class: 'iv-sec-h', text: 'Your invites' }),
        h('div', { class: 'iv-list' }, d.recent.map((f) => {
            const key = f.status === 'rejected' ? (f.reason || 'not_eligible') : f.status;
            const nm = f.username || 'Deleted account';
            return h('div', { class: 'iv-friend' },
                avatar(nm, null, 26),
                h('span', { class: 'iv-f-name', text: nm }),
                h('span', { class: 'iv-f-st ' + (f.status === 'qualified' ? 'ok' : f.status === 'pending' ? 'wait' : 'no'), text: STATUS_TEXT[key] || 'Didn’t count' }));
        })));
}

function linkBox(d) {
    const link = d && d.link ? d.link : '';
    const shown = link.replace(/^https?:\/\//, '');
    const copy = h('button', { type: 'button', class: 'dw-btn accent-fill iv-copy', text: 'Copy' });
    copy.addEventListener('click', async () => {
        const ok = await copyText(link);
        if (!ok) { toast('Couldn’t copy it. Please select the link and copy it yourself.', { kind: 'error' }); return; }
        copy.textContent = 'Copied';
        copy.classList.add('copied');
        clearTimeout(copy._t);
        copy._t = setTimeout(() => { copy.textContent = 'Copy'; copy.classList.remove('copied'); }, 1600);
    });
    return h('div', { class: 'iv-link' },
        h('input', { class: 'iv-link-in', type: 'text', readonly: true, value: shown, 'aria-label': 'Your invite link', onfocus: (e) => e.target.select() }),
        copy);
}

function userBody(d, name) {
    const count = d ? d.count | 0 : 0;
    const head = h('div', { class: 'iv-progress' },
        h('div', { class: 'iv-count' },
            h('span', { class: 'iv-count-n', text: String(count) }),
            h('span', { class: 'iv-count-t', text: count === 1 ? 'friend joined' : 'friends joined' })),
        d && d.pending ? h('div', { class: 'iv-count-sub', text: d.pending + ' still playing their first game' }) : null,
        pips(count));
    return [
        linkBox(d),
        head,
        rewards(d, name),
        friendsList(d),
        h('div', { class: 'iv-fine', text: 'A friend counts once they sign up with your link and finish a game. Alt accounts don’t count.' }),
    ];
}

function guestBody(onSignup) {
    return [
        h('div', { class: 'iv-guest' },
            h('div', { class: 'iv-guest-t', text: 'Make an account to get your invite link.' }),
            h('div', { class: 'iv-guest-p', text: 'You’ll earn rewards for every friend who joins.' })),
        rewards(null, 'You'),
        h('div', { class: 'dw-modal-actions' },
            h('button', { type: 'button', class: 'dw-btn', text: 'Later', onclick: () => close() }),
            h('button', { type: 'button', class: 'dw-btn primary', 'data-autofocus': '', text: 'Make an account', onclick: () => { close(); onSignup(); } })),
    ];
}

let hooks = { onSignup() {}, refreshMe() {} };

function close() {
    if (panel) panel.m.close();
}

function paint() {
    if (!panel) return;
    const u = store.get('user');
    pv.stopUnder(panel.body);
    clear(panel.body);
    if (!u) {
        panel.body.append(...guestBody(hooks.onSignup));
        return;
    }
    panel.body.append(...userBody(panel.data, u.username).filter(Boolean));
}

async function load() {
    if (!panel || !store.get('user')) return;
    const mine = panel;
    const r = await api.invite();
    if (panel !== mine) return;
    if (!r.ok) {
        if (!mine.data) {
            pv.stopUnder(mine.body);
            clear(mine.body);
            mine.body.appendChild(h('div', { class: 'iv-err', text: humanError(r) }));
        }
        return;
    }
    const first = !mine.data;
    mine.data = r.data;
    paint();
    if (first) animate(mine.body, [{ opacity: 0.4 }, { opacity: 1 }], { duration: T_MID });
}

export function open() {
    if (panel) return;
    if (store.get('offline')) { toast('Accounts are down right now. Please try again soon.'); return; }
    const body = h('div', { class: 'iv-body' });
    const u = store.get('user');
    if (u) body.appendChild(h('div', { class: 'iv-loading', text: 'Getting your link...' }));
    const m = modal({
        title: 'Invite friends', cls: 'dw-invite',
        message: u ? 'Share your link and earn rewards for every friend who joins.' : null,
        body,
        onClose: () => { if (panel && panel.m === m) { pv.stopUnder(body); panel = null; } if (btn) btn.classList.remove('active'); },
    });
    panel = { m, body, data: null };
    if (btn) btn.classList.add('active');
    if (u) load(); else paint();
}

// SSE `invite`: a friend counted (social.js shows the toast).
export function onEvent() {
    hooks.refreshMe();
    if (panel) load();
}

export function init(hs) {
    Object.assign(hooks, hs);
    api.setRefSource(storedCode);
    mountButton();
    store.on((s, changed) => {
        if (changed.indexOf('user') >= 0 && s.user) forget();
        if (changed.some((k) => k === 'user' || k === 'mode')) requestAnimationFrame(place);
        if (changed.indexOf('user') >= 0 && panel) { panel.data = null; if (s.user) load(); else paint(); }
    });
}
