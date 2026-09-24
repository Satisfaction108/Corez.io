// The Locker pane: a stage with your tank and nameplate, Skin / Name Style
// tabs of what you own (plus Default), Equip / Unequip / Revert, and the
// Custom Color editor. Equipping takes effect on the next spawn.
import * as api from './api.js';
import * as state from './state.js';
import { h, clear, toast, setBusy, humanError, animate, T_MID } from './ui.js';
import * as pv from './previews.js';
import * as cos from './cosmetics.js';
import { full, rarityName, catName, isAnimated, colorEditor, storeError } from './shop.js';

let handlers = { refreshMe() {}, openShop() {} };
export function init(hs) { Object.assign(handlers, hs); }

const ORDER = ['legendary', 'epic', 'rare', 'uncommon', 'common'];
let paneEl = null, loadSeq = 0;
let owned = [], equipped = { nameStyle: null, skin: null, customColor: null };
let tab = 'skin', sel = { skin: null, nameStyle: null }, colorIdx = 0, draftColor = null;

const myName = () => (state.get('user') && state.get('user').username) || 'Player';

export function render(el) {
    paneEl = el;
    pv.stopUnder(el);
    clear(el);
    el.appendChild(h('div', { class: 'shop-loading', text: 'Opening your Locker…' }));
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
            h('div', { class: 'shop-empty-h', text: 'Couldn’t open your Locker' }),
            h('div', { class: 'shop-empty-p', text: humanError(r) }),
            h('button', { type: 'button', class: 'dw-btn sm', text: 'Try again', onclick: () => render(el) })));
        return;
    }
    owned = (r.data.owned || []).map((x) => full(typeof x === 'string' ? { id: x } : x)).filter((x) => x && x.cat);
    owned.sort((a, b) => ORDER.indexOf(a.rarity) - ORDER.indexOf(b.rarity) || a.name.localeCompare(b.name));
    equipped = Object.assign({ nameStyle: null, skin: null, customColor: null }, r.data.equipped || {});
    sel = { skin: equipped.skin, nameStyle: equipped.nameStyle };
    draftColor = equipped.customColor;
    paint(el);
}

function itemById(id) { return id ? owned.find((x) => x.id === id) || full({ id }) : null; }

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
        h('div', { class: 'lk-note', text: 'You’ll see changes next time you spawn.' }));

    function drawStage() {
        pv.stopUnder(stage);
        clear(stage);
        const sk = itemById(sel.skin), ns = itemById(sel.nameStyle);
        const custom = ns && ns.id === cos.CUSTOM_ID ? (draftColor || '#7ad3ff') : null;
        stage.appendChild(pv.namePreview({ w: 700, h: 200, name: myName(), style: ns, custom, skin: sk, color: pv.TEAM_COLORS[colorIdx].col, px: 26, r: 40, cls: 'dw-prev lk-canvas' }));
    }
    function paintTabs() {
        clear(tabs);
        for (const [k, label] of [['skin', 'Skins'], ['nameStyle', 'Name Styles']]) {
            const n = owned.filter((x) => x.cat === k).length;
            tabs.appendChild(h('button', {
                type: 'button', class: 'lk-tab' + (tab === k ? ' on' : ''), role: 'tab', 'aria-selected': tab === k ? 'true' : 'false',
                onclick: () => { if (tab === k) return; tab = k; paintTabs(); paintGrid(true); paintBar(); },
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
            grid.appendChild(h('div', { class: 'lk-empty' },
                h('div', { class: 'lk-empty-h', text: tab === 'skin' ? 'No skins yet' : 'No name styles yet' }),
                h('div', { class: 'lk-empty-p', text: 'Grab some in the Item Shop. New stuff every day!' }),
                h('button', { type: 'button', class: 'dw-btn sm accent-fill', text: 'Go to the Item Shop', onclick: () => handlers.openShop() })));
        }
        if (fade) animate(grid, [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: T_MID });
    }
    function tile(it) {
        const id = it ? it.id : null;
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
            isEq ? h('span', { class: 'lk-ribbon', text: 'EQUIPPED' }) : null,
            h('span', { class: 'lk-tprev' }, prev),
            h('span', { class: 'lk-tname', text: it ? it.name : 'Default' }),
            h('span', { class: 'lk-tsub', text: it ? rarityName(it.rarity) : (tab === 'skin' ? 'No skin' : 'No style') }));
    }
    function paintBar() {
        clear(bar);
        const id = sel[tab] || null;
        const it = itemById(id);
        const isEq = (equipped[tab] || null) === id;
        const custom = it && it.id === cos.CUSTOM_ID;
        const colorChanged = custom && isEq && draftColor && draftColor !== equipped.customColor;
        const left = h('div', { class: 'lk-bar-l' },
            h('div', { class: 'lk-bar-name', text: it ? it.name : 'Default' }),
            h('div', { class: 'lk-bar-sub', text: it ? rarityName(it.rarity) + ' ' + catName(it.cat) + (isAnimated(it) ? ' · Animated' : '') : (tab === 'skin' ? 'No skin' : 'No name style') }));
        const right = h('div', { class: 'lk-bar-r' });
        let editor = null;
        if (custom) {
            editor = colorEditor(draftColor || equipped.customColor || '#7ad3ff', (c, ok) => {
                if (!ok) { if (go) go.disabled = true; return; }
                const was = draftColor;
                draftColor = c;
                if (was !== c) { drawStage(); refreshCustomTile(); }
                const changed = isEq && c !== equipped.customColor;
                if (go) { go.disabled = false; go.textContent = isEq ? 'Save color' : 'Equip'; go.hidden = isEq && !changed; }
                if (eqLabel) eqLabel.hidden = !(isEq && !changed);
            });
        }
        let go = null, eqLabel = null;
        if (!isEq || colorChanged || custom) {
            go = h('button', { type: 'button', class: 'dw-btn primary', text: isEq ? 'Save color' : 'Equip', onclick: () => doEquip(go, id, editor) });
            if (isEq && !colorChanged) go.hidden = true;
            right.appendChild(go);
        }
        if (!isEq) right.appendChild(h('button', { type: 'button', class: 'dw-btn', text: 'Undo', title: 'Go back to what you have on', onclick: () => { sel[tab] = equipped[tab] || null; draftColor = equipped.customColor; paintGrid(); paintBar(); drawStage(); } }));
        if (isEq) {
            eqLabel = h('span', { class: 'lk-eqlabel', text: 'Equipped' });
            if (colorChanged) eqLabel.hidden = true;
            right.appendChild(eqLabel);
            if (id) right.appendChild(h('button', { type: 'button', class: 'dw-btn', text: 'Unequip', onclick: (e) => doEquip(e.currentTarget, null) }));
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
        setBusy(btn, true, id ? 'Equipping…' : 'Unequipping…');
        const r = await api.equip(tab, id, id === cos.CUSTOM_ID ? (editor ? editor.value() : draftColor) : null);
        setBusy(btn, false);
        if (!r.ok) { toast(storeError(r), { kind: 'error' }); return; }
        equipped = Object.assign(equipped, (r.data && r.data.equipped) || {});
        if (!r.data || !r.data.equipped) equipped[tab] = id;
        draftColor = equipped.customColor || draftColor;
        sel[tab] = equipped[tab] || null;
        const it = itemById(id);
        toast(id ? (it ? it.name : 'Item') + ' equipped! You’ll see it next time you spawn.' : 'Unequipped!', { kind: 'ok' });
        handlers.refreshMe();
        paintGrid();
        paintBar();
        drawStage();
        const eq = grid.querySelector('.lk-tile.eq .lk-ribbon');
        if (eq) animate(eq, [{ transform: 'scale(.6)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: T_MID });
    }

    drawStage();
    paintTabs();
    paintGrid();
    paintBar();
}
