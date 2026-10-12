// The Locker pane: a stage with your tank and nameplate, Skin / Name Style
// / Sidekick tabs of what you own (plus Default), Equip / Unequip / Revert,
// and the Custom Color editor. The Sidekick tab picks the sidekick (or
// none), then its name, colour, skin and name style, saved together.
// Everything takes effect on the next spawn.
import * as api from './api.js';
import * as state from './state.js';
import { h, clear, toast, setBusy, humanError, animate, T_MID } from './ui.js';
import * as pv from './previews.js';
import * as cos from './cosmetics.js';
import { full, rarityName, catName, isAnimated, colorEditor, storeError } from './shop.js';

let handlers = { refreshMe() {}, openShop() {} };
export function init(hs) { Object.assign(handlers, hs); }

const ORDER = ['legendary', 'epic', 'rare', 'uncommon', 'common'];
const SK_KEYS = ['sidekick', 'sdSkin', 'sdName', 'sidekickName', 'sidekickColor'];
let paneEl = null, loadSeq = 0;
let owned = [], equipped = { nameStyle: null, skin: null, customColor: null };
let tab = 'skin', sel = { skin: null, nameStyle: null }, colorIdx = 0, draftColor = null;
// the Sidekick tab's unsaved choices
let sk = { sidekick: null, sdSkin: null, sdName: null, name: '', color: null };
const MATCH_PREVIEW = '#00b2e1';
const skCol = (c) => c === null || c === undefined || c === '' ? MATCH_PREVIEW : c === 'own' ? null : c;

const myName = () => (state.get('user') && state.get('user').username) || 'Player';
const CAT = () => window.DWCosmetics;

// open on a given tab next time (the shop's "Name it" after buying a sidekick)
export function setTab(t) { if (t === 'skin' || t === 'nameStyle' || t === 'sidekick') tab = t; }

export function render(el) {
    paneEl = el;
    pv.stopUnder(el);
    clear(el);
    el.appendChild(h('div', { class: 'shop-loading', text: 'Opening your locker...' }));
    load(el);
}
export function onClose() { if (paneEl) pv.stopUnder(paneEl); }

async function load(el) {
    const seq = ++loadSeq;
    const r = await api.locker();
    if (seq !== loadSeq || el !== paneEl) return;
    pv.stopUnder(el);
    clear(el);
    if (!r.ok || !r.data) {
        el.appendChild(h('div', { class: 'shop-empty' },
            h('div', { class: 'shop-empty-h', text: 'Your locker didn’t open' }),
            h('div', { class: 'shop-empty-p', text: humanError(r) }),
            h('button', { type: 'button', class: 'dw-btn sm', text: 'Retry', onclick: () => render(el) })));
        return;
    }
    owned = (r.data.owned || []).map((x) => full(typeof x === 'string' ? { id: x } : x)).filter((x) => x && x.cat);
    owned.sort((a, b) => ORDER.indexOf(a.rarity) - ORDER.indexOf(b.rarity) || a.name.localeCompare(b.name));
    equipped = Object.assign({ nameStyle: null, skin: null, customColor: null }, r.data.equipped || {});
    sel = { skin: equipped.skin, nameStyle: equipped.nameStyle };
    draftColor = equipped.customColor;
    skReset();
    paint(el);
}

function itemById(id) { return id ? owned.find((x) => x.id === id) || full({ id }) : null; }
function skReset() {
    sk = { sidekick: equipped.sidekick || null, sdSkin: equipped.sdSkin || null, sdName: equipped.sdName || null, name: equipped.sidekickName || '', color: equipped.sidekickColor || null };
}
function skSaved() {
    return (sk.sidekick || null) === (equipped.sidekick || null) && (sk.sdSkin || null) === (equipped.sdSkin || null) &&
        (sk.sdName || null) === (equipped.sdName || null) && (sk.color || null) === (equipped.sidekickColor || null) &&
        cleanName(sk.name) === (equipped.sidekickName || '');
}
function cleanName(raw) { const C = CAT(); return C ? C.cleanSidekickName(raw) : String(raw || '').trim().slice(0, 16); }
// '' when the typed name is fine, else what's wrong with it
function nameProblem(raw) {
    const n = cleanName(raw);
    if (String(raw || '').trim() && !n) return 'Please use only letters and numbers.';
    const P = window.DWProfanity;
    if (n && P && P.hasProfanity(n)) return 'Please pick a nicer name for it.';
    return '';
}

function paint(el) {
    const stage = h('div', { class: 'lk-stage' });
    const swatches = h('div', { class: 'lk-swatches', role: 'radiogroup', 'aria-label': 'Team colour' },
        pv.TEAM_COLORS.map((tc, i) => h('button', {
            type: 'button', class: 'shop-sw sm' + (i === colorIdx ? ' on' : ''), role: 'radio', 'aria-checked': i === colorIdx ? 'true' : 'false',
            title: tc.name, 'aria-label': tc.name, style: { background: pv.teamHex(tc.col) },
            onclick: () => { colorIdx = i; swatches.querySelectorAll('.shop-sw').forEach((b, j) => { b.classList.toggle('on', j === i); b.setAttribute('aria-checked', j === i ? 'true' : 'false'); }); drawStage(); },
        })));
    const tabs = h('div', { class: 'lk-tabs', role: 'tablist' });
    const grid = h('div', { class: 'lk-grid', role: 'tabpanel' });
    const bar = h('div', { class: 'lk-bar' });
    el.append(
        h('div', { class: 'lk-stagewrap' }, stage, swatches),
        tabs, grid, bar,
        h('div', { class: 'lk-note', text: 'Changes show up the next time you spawn.' }));

    function drawStage() {
        pv.stopUnder(stage);
        clear(stage);
        const sk0 = itemById(sel.skin), ns = itemById(sel.nameStyle);
        if (tab === 'sidekick') {
            const kick = sk.sidekick ? itemById(sk.sidekick) : null;
            stage.appendChild(pv.sidekickStage({
                w: 700, h: 200, color: pv.TEAM_COLORS[colorIdx].col, r: 40, cls: 'dw-prev lk-canvas',
                kick: kick ? kick.id : null, look: sk.sdSkin, style: sk.sdName, col: (sk.color || null) === null ? pv.TEAM_COLORS[colorIdx].col : skCol(sk.color),
                name: cleanName(sk.name) || (kick ? kick.name : ''),
            }));
            return;
        }
        const custom = ns && ns.id === cos.CUSTOM_ID ? (draftColor || '#7ad3ff') : null;
        stage.appendChild(pv.namePreview({ w: 700, h: 200, name: myName(), style: ns, custom, skin: sk0, color: pv.TEAM_COLORS[colorIdx].col, px: 26, r: 40, cls: 'dw-prev lk-canvas' }));
    }
    function paintTabs() {
        clear(tabs);
        for (const [k, label] of [['skin', 'Skins'], ['nameStyle', 'Names'], ['sidekick', 'Sidekick']]) {
            const n = owned.filter((x) => x.cat === k).length;
            tabs.appendChild(h('button', {
                type: 'button', class: 'lk-tab' + (tab === k ? ' on' : ''), role: 'tab', 'aria-selected': tab === k ? 'true' : 'false',
                onclick: () => { if (tab === k) return; tab = k; paintTabs(); paintGrid(true); paintBar(); drawStage(); },
            }, h('span', { text: label }), h('span', { class: 'lk-count', text: String(n) })));
        }
    }
    function paintGrid(fade) {
        pv.stopUnder(grid);
        clear(grid);
        const mine = owned.filter((x) => x.cat === tab);
        grid.appendChild(tile(null));
        for (const it of mine) grid.appendChild(tile(it));
        if (!mine.length) {
            const what = tab === 'skin' ? 'No skins yet' : tab === 'sidekick' ? 'No sidekicks yet' : 'No name styles yet';
            grid.appendChild(h('div', { class: 'lk-empty' },
                h('div', { class: 'lk-empty-h', text: what }),
                h('div', { class: 'lk-empty-p', text: tab === 'sidekick' ? 'Buddy is always in the shop, and the other sidekicks change every day.' : 'The shop changes every day.' }),
                h('button', { type: 'button', class: 'dw-btn sm accent-fill', text: 'Go to the shop', onclick: () => handlers.openShop() })));
        }
        if (fade) animate(grid, [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: T_MID });
    }
    function tile(it) {
        const id = it ? it.id : null;
        if (tab === 'sidekick') return skTile(it);
        const isEq = (equipped[tab] || null) === id;
        const isSel = (sel[tab] || null) === id;
        let prev;
        if (!it) {
            prev = tab === 'skin'
                ? pv.tankPreview({ w: 132, h: 92, color: pv.TEAM_COLORS[colorIdx].col })
                : pv.nameCanvas(myName(), null, { px: 17, stroke: true, h: 92, maxW: 132, cls: 'dw-name-cv lk-plain' });
        } else if (it.cat === 'skin') {
            prev = pv.tankPreview({ w: 132, h: 92, skin: it, color: pv.TEAM_COLORS[colorIdx].col });
        } else {
            prev = pv.nameCanvas(myName(), it, { px: 17, stroke: true, h: 92, maxW: 132, custom: it.id === cos.CUSTOM_ID ? (draftColor || '#7ad3ff') : null });
        }
        return h('button', {
            type: 'button', class: 'lk-tile r-' + (it ? it.rarity : 'none') + (isSel ? ' sel' : '') + (isEq ? ' eq' : ''), 'aria-pressed': isSel ? 'true' : 'false',
            title: it ? it.name : 'Default',
            onclick: () => { sel[tab] = id; paintGrid(); paintBar(); drawStage(); },
        },
            isEq ? h('span', { class: 'lk-ribbon', text: 'On' }) : null,
            h('span', { class: 'lk-tprev' }, prev),
            h('span', { class: 'lk-tname', text: it ? it.name : 'Default' }),
            h('span', { class: 'lk-tsub', text: it ? (it.exclusive ? (it.earn ? 'Achievement reward' : 'Invite reward') : rarityName(it.rarity)) : (tab === 'skin' ? 'plain' : 'plain') }));
    }
    function paintBar() {
        clear(bar);
        if (tab === 'sidekick') { skBar(); return; }
        const id = sel[tab] || null;
        const it = itemById(id);
        const isEq = (equipped[tab] || null) === id;
        const custom = it && it.id === cos.CUSTOM_ID;
        const colorChanged = custom && isEq && draftColor && draftColor !== equipped.customColor;
        const left = h('div', { class: 'lk-bar-l' },
            h('div', { class: 'lk-bar-name', text: it ? it.name : 'Default' }),
            h('div', { class: 'lk-bar-sub', text: it ? (it.exclusive ? (it.earn ? 'Achievement reward' : 'Invite reward') : rarityName(it.rarity)) + ' ' + catName(it.cat) + (isAnimated(it) ? ' · animated' : '') : (tab === 'skin' ? 'No skin' : 'No name style') }));
        const right = h('div', { class: 'lk-bar-r' });
        let editor = null;
        if (custom) {
            editor = colorEditor(draftColor || equipped.customColor || '#7ad3ff', (c, ok) => {
                if (!ok) { if (go) go.disabled = true; return; }
                const was = draftColor;
                draftColor = c;
                if (was !== c) { drawStage(); refreshCustomTile(); }
                const changed = isEq && c !== equipped.customColor;
                if (go) { go.disabled = false; go.textContent = isEq ? 'Save colour' : 'Wear it'; go.hidden = isEq && !changed; }
                if (eqLabel) eqLabel.hidden = !(isEq && !changed);
            });
        }
        let go = null, eqLabel = null;
        if (!isEq || colorChanged || custom) {
            go = h('button', { type: 'button', class: 'dw-btn primary', text: isEq ? 'Save colour' : 'Wear it', onclick: () => doEquip(go, id, editor) });
            if (isEq && !colorChanged) go.hidden = true;
            right.appendChild(go);
        }
        if (!isEq) right.appendChild(h('button', { type: 'button', class: 'dw-btn', text: 'Undo', title: 'Go back to what you’re wearing', onclick: () => { sel[tab] = equipped[tab] || null; draftColor = equipped.customColor; paintGrid(); paintBar(); drawStage(); } }));
        if (isEq) {
            eqLabel = h('span', { class: 'lk-eqlabel', text: 'Wearing it' });
            if (colorChanged) eqLabel.hidden = true;
            right.appendChild(eqLabel);
            if (id) right.appendChild(h('button', { type: 'button', class: 'dw-btn', text: 'Take off', onclick: (e) => doEquip(e.currentTarget, null) }));
        }
        bar.append(h('div', { class: 'lk-bar-row' }, left, right));
        if (editor) bar.appendChild(editor.el);
    }
    function refreshCustomTile() {
        const t = grid.querySelector('.lk-tile.sel .lk-tprev');
        if (!t) return;
        const it = itemById(cos.CUSTOM_ID);
        pv.stopUnder(t);
        clear(t);
        t.appendChild(pv.nameCanvas(myName(), it, { px: 17, stroke: true, h: 92, maxW: 132, custom: draftColor }));
    }
    async function doEquip(btn, id, editor) {
        if (editor && !editor.valid()) return;
        setBusy(btn, true, id ? 'Putting on...' : 'Taking off...');
        const r = await api.equip(tab, id, id === cos.CUSTOM_ID ? (editor ? editor.value() : draftColor) : null);
        setBusy(btn, false);
        if (!r.ok) { toast(storeError(r), { kind: 'error' }); return; }
        equipped = Object.assign(equipped, (r.data && r.data.equipped) || {});
        if (!r.data || !r.data.equipped) equipped[tab] = id;
        draftColor = equipped.customColor || draftColor;
        sel[tab] = equipped[tab] || null;
        const it = itemById(id);
        toast(id ? (it ? it.name : 'Item') + ' is on. You’ll see it next time you spawn.' : 'You took it off.', { kind: 'ok' });
        handlers.refreshMe();
        paintGrid();
        paintBar();
        drawStage();
        const eq = grid.querySelector('.lk-tile.eq .lk-ribbon');
        if (eq) animate(eq, [{ transform: 'scale(.6)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: T_MID });
    }

    /* ── the Sidekick tab ───────────────────────────────────────────── */
    function skTile(it) {
        const id = it ? it.id : null;
        const isEq = (equipped.sidekick || null) === id;
        const isSel = (sk.sidekick || null) === id;
        const prev = it
            ? pv.sidekickPreview({ w: 132, h: 92, kick: it, r: 20, col: isSel ? skCol(sk.color) : MATCH_PREVIEW, look: isSel ? sk.sdSkin : null, still: true })
            : h('span', { class: 'lk-sk-none', text: 'None' });
        return h('button', {
            type: 'button', class: 'lk-tile r-' + (it ? it.rarity : 'none') + (isSel ? ' sel' : '') + (isEq ? ' eq' : ''), 'aria-pressed': isSel ? 'true' : 'false',
            title: it ? it.name : 'No sidekick',
            onclick: () => { if (sk.sidekick === id) return; sk.sidekick = id; paintGrid(); paintBar(); drawStage(); },
        },
            isEq ? h('span', { class: 'lk-ribbon', text: 'On' }) : null,
            h('span', { class: 'lk-tprev' }, prev),
            h('span', { class: 'lk-tname', text: it ? it.name : 'None' }),
            h('span', { class: 'lk-tsub', text: it ? rarityName(it.rarity) : 'Just you' }));
    }
    // a row of small choices; items: [{id, label, el}]
    function chips(label, items, current, onPick) {
        return h('div', { class: 'lk-sk-row' },
            h('div', { class: 'lk-sk-label', text: label }),
            h('div', { class: 'lk-sk-chips', role: 'radiogroup', 'aria-label': label }, items.map((c) => h('button', {
                type: 'button', class: 'lk-sk-chip' + ((current || null) === c.id ? ' on' : ''), role: 'radio', 'aria-checked': (current || null) === c.id ? 'true' : 'false',
                title: c.label, onclick: () => onPick(c.id),
            }, c.el, h('span', { class: 'lk-sk-cname', text: c.label })))));
    }
    function skBar() {
        const C = CAT();
        const kick = sk.sidekick ? itemById(sk.sidekick) : null;
        const saved = skSaved();
        const problem = nameProblem(sk.name);
        const left = h('div', { class: 'lk-bar-l' },
            h('div', { class: 'lk-bar-name', text: kick ? (cleanName(sk.name) || kick.name) : 'No sidekick' }),
            h('div', { class: 'lk-bar-sub', text: kick ? rarityName(kick.rarity) + ' sidekick · ' + (kick.blurb || '') + ' ' + ((C && C.SIDEKICK_DIG_LINE) || 'It helps you mine, but it only shoots rocks.') : 'Nobody comes along with you.' }));
        const right = h('div', { class: 'lk-bar-r' });
        const go = h('button', { type: 'button', class: 'dw-btn primary', text: 'Save', onclick: () => skSave(go) });
        go.disabled = saved || !!problem;
        // .dw-btn sets its own display, so [hidden] alone doesn't hide it
        go.hidden = saved; go.style.display = saved ? 'none' : '';
        right.appendChild(go);
        if (!saved) right.appendChild(h('button', { type: 'button', class: 'dw-btn', text: 'Undo', title: 'Go back to what you have', onclick: () => { skReset(); paintGrid(); paintBar(); drawStage(); } }));
        else right.appendChild(h('span', { class: 'lk-eqlabel', text: kick ? 'With you' : 'Saved' }));
        bar.append(h('div', { class: 'lk-bar-row' }, left, right));
        if (!kick) return;

        // name
        const input = h('input', {
            type: 'text', class: 'dw-input lk-sk-input', value: sk.name || '', maxlength: C ? C.SIDEKICK_NAME_MAX : 16, spellcheck: 'false', autocomplete: 'off',
            placeholder: kick.name, 'aria-label': 'Sidekick name',
        });
        const msg = h('div', { class: 'lk-cmsg' + (problem ? ' show' : ''), role: 'status', text: problem });
        input.addEventListener('input', () => {
            sk.name = input.value;
            const p = nameProblem(sk.name);
            msg.textContent = p;
            msg.classList.toggle('show', !!p);
            input.classList.toggle('bad', !!p);
            const s2 = skSaved();
            go.hidden = s2; go.style.display = s2 ? 'none' : ''; go.disabled = s2 || !!p;
            const nm = bar.querySelector('.lk-bar-name');
            if (nm) nm.textContent = cleanName(sk.name) || kick.name;
            clearTimeout(skBar._t);
            skBar._t = setTimeout(drawStage, 250);
        });
        if (problem) input.classList.add('bad');
        bar.appendChild(h('div', { class: 'lk-sk-row' },
            h('div', { class: 'lk-sk-label', text: 'Name' }),
            h('div', { class: 'lk-sk-namebox' }, input, h('div', { class: 'lk-sk-hint', text: 'Up to 16 letters. Leave it empty to keep its own name.' }), msg)));

        // colour
        const OWN = C ? C.SIDEKICK_OWN : 'own';
        const cols = [null, OWN].concat(C ? C.SIDEKICK_COLORS : []);
        const swTitle = (c) => c === null ? 'Match my tank' : c === OWN ? 'Its own colour' : c;
        bar.appendChild(h('div', { class: 'lk-sk-row' },
            h('div', { class: 'lk-sk-label', text: 'Colour' }),
            h('div', { class: 'lk-sk-swatches', role: 'radiogroup', 'aria-label': 'Sidekick colour' }, cols.map((c) => h('button', {
                type: 'button', class: 'lk-sk-sw' + ((sk.color || null) === c ? ' on' : '') + (c === OWN ? ' own' : c === null ? ' match' : ''), role: 'radio',
                'aria-checked': (sk.color || null) === c ? 'true' : 'false', title: swTitle(c), 'aria-label': swTitle(c),
                style: { background: c === null ? MATCH_PREVIEW : c === OWN ? kick.kick.col : c },
                onclick: () => { sk.color = c; paintBar(); drawStage(); },
            }))),
            h('div', { class: 'lk-sk-hint', text: (sk.color || null) === null ? 'Matches your tank colour in each raid.' : (sk.color === OWN ? 'Uses the sidekick\'s own colour.' : '') })));

        // skin and name style: what you own, plus the default
        const skins = owned.filter((x) => x.cat === 'sdSkin');
        bar.appendChild(chips('Skin', [{ id: null, label: 'Plain', el: pv.sidekickPreview({ w: 60, h: 54, kick, col: skCol(sk.color), r: 12, still: true }) }]
            .concat(skins.map((f) => ({ id: f.id, label: f.name, el: pv.sidekickPreview({ w: 60, h: 54, kick, look: f, col: skCol(sk.color), r: 12, still: true }) }))),
        sk.sdSkin, (id) => { sk.sdSkin = id; paintBar(); drawStage(); }));
        const styles = owned.filter((x) => x.cat === 'sdName');
        const shown = cleanName(sk.name) || kick.name;
        const tag = (s) => pv.sidekickName(shown, s, { px: 14, h: 30, maxW: 120, kick, col: skCol(sk.color), look: sk.sdSkin });
        bar.appendChild(chips('Name style', [{ id: null, label: 'Plain', el: tag(null) }]
            .concat(styles.map((s) => ({ id: s.id, label: s.name, el: tag(s) }))),
        sk.sdName, (id) => { sk.sdName = id; paintBar(); drawStage(); }));
        if (!skins.length || !styles.length) {
            bar.appendChild(h('div', { class: 'lk-sk-more' },
                h('span', { text: 'You can find more skins and name styles in the shop’s Sidekicks tab.' }),
                h('button', { type: 'button', class: 'dw-link', text: 'Go to the shop', onclick: () => handlers.openShop() })));
        }
    }
    async function skSave(btn) {
        if (nameProblem(sk.name)) return;
        setBusy(btn, true, 'Saving...');
        const r = await api.saveSidekick({ sidekick: sk.sidekick, sdSkin: sk.sdSkin, sdName: sk.sdName, name: cleanName(sk.name), color: sk.color });
        setBusy(btn, false);
        if (!r.ok) {
            const code = r.data && r.data.error && r.data.error.code;
            toast(code === 'bad_name' ? 'Please pick a nicer name for it.' : storeError(r), { kind: 'error' });
            return;
        }
        const eq = (r.data && r.data.equipped) || {};
        for (const k of SK_KEYS) equipped[k] = eq[k] == null ? null : eq[k];
        skReset();
        const kick = sk.sidekick ? itemById(sk.sidekick) : null;
        toast(kick ? (equipped.sidekickName || kick.name) + ' is coming along! You’ll see it next time you spawn.' : 'You won’t have a sidekick next time you spawn.', { kind: 'ok' });
        handlers.refreshMe();
        paintGrid();
        paintBar();
        drawStage();
    }

    drawStage();
    paintTabs();
    paintGrid();
    paintBar();
}
