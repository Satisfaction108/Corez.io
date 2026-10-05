// Achievement art: one small line glyph per icon key (24-unit grid, drawn
// with currentColor over a wider ink stroke, so they carry the same outline
// as the rest of the art). The catalog itself is shared/achievements.js
// (window.DWAchievements); it is loaded on demand by loadCatalog(), so the
// first paint never waits for it. The in-raid card gets everything it needs
// in the ACH packet and only uses GLYPHS from here.
const NS = 'http://www.w3.org/2000/svg';

// path data, or 'circle:cx,cy,r' / 'rect:x,y,w,h,rx'
export const GLYPHS = {
    crosshair: ['M12 3v4M12 17v4M3 12h4M17 12h4', 'circle:12,12,6', 'circle:12,12,1.6'],
    bot: ['M12 3v3', 'circle:12,2.6,1', 'rect:5,6,14,12,3', 'M9 11v1.5M15 11v1.5', 'M9.5 15h5', 'M3 11v3M21 11v3'],
    vault: ['M3.5 9 12 4l8.5 5z', 'M5.5 10.5v6M9.8 10.5v6M14.2 10.5v6M18.5 10.5v6', 'M3.5 19.5h17'],
    tycoon: ['M4 8.5 7.5 12 12 6l4.5 6L20 8.5l-1.6 9.5H5.6z', 'M5.6 20.5h12.8'],
    podium: ['M8.5 20.5v-10h7v10', 'M3 20.5v-6h5.5M15.5 16.5H21v4', 'M2 20.5h20', 'M12 4.5v3'],
    cup: ['M8 20h8M12 15.5V20', 'M7 4h10v5a5 5 0 0 1-10 0z', 'M17 5.5h2.5V7a3 3 0 0 1-3 3M7 5.5H4.5V7a3 3 0 0 0 3 3'],
    sword: ['M14.5 3.5H20.5V9.5L10 20 4 14z', 'M7.5 12.5l4 4', 'M4 20l2.5-2.5'],
    shield: ['M12 21s-7.5-3.2-7.5-9.5V5.5L12 3l7.5 2.5v6C19.5 17.8 12 21 12 21z', 'M8.5 12l2.4 2.4 4.6-4.8'],
    fire: ['M12 21c-4 0-6.5-2.7-6.5-6.2 0-3.3 2.4-5 3.6-8.3.2-.6 1-.7 1.3-.1.9 1.6 1.2 3 1.1 4.6 1.2-.8 2-2.1 2.3-3.4.1-.5.8-.7 1.1-.2 1.5 2.2 2.6 4.6 2.6 7.4 0 3.5-2.5 6.2-5.5 6.2z'],
    sack: ['M9 4.5h6l-1.6 3h-2.8z', 'M10.6 7.5C6.5 9 4.5 12.5 4.5 15.5c0 3 2.5 5 7.5 5s7.5-2 7.5-5c0-3-2-6.5-6.1-8'],
    eye: ['M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z', 'M12 8.6 15 11.2 13.9 15H10.1L9 11.2z'],
    chevron: ['M5 4.5h14v8.5L12 20l-7-7z', 'M8.5 9 12 11.5 15.5 9', 'M8.5 12.8 12 15.3l3.5-2.5'],
    rock: ['M4 15 6.5 7.5 12.5 4l6 3.5 1.5 8-6 4.5-8-.5z', 'M11.5 8.5 13 12.5l-2.5 3'],
    gem: ['M7 5h10l4 5-9 10L3 10z', 'M3 10h18', 'M9.5 5 8.5 10 12 20l3.5-10-1-5'],
    stat: ['M5 20v-6M10 20V9M15 20v-4', 'M19 3.5v6M16 6.5h6'],
    tank: ['circle:10,14,6', 'M13.4 9.2 18 4.6l2.6 2.6-4.6 4.6'],
    bonk: ['M12 3l1.8 4.6L18 5l-1.6 4.4L21 12l-4.6 1.6L18 19l-4.2-2.4L12 21l-1.8-4.4L6 19l1.6-5.4L3 12l4.6-2.6L6 5l4.2 2.6z'],
    grow: ['M12 20V6', 'M6.5 11.5 12 6l5.5 5.5', 'M4 20.5h16'],
    bolt: ['M13 2.5 5 13.5h6l-1 8 8-11h-6z'],
    swords: ['M4 4l10.5 10.5M20 4 9.5 14.5', 'M6.5 14.5l3 3M17.5 14.5l-3 3', 'M4.5 19.5l3-3M19.5 19.5l-3-3'],
    revenge: ['M19.5 13a7.5 7.5 0 1 1-2.2-6.3', 'M19.5 4v4.5H15'],
    crown: ['M4 18 3 7l5 4 4-6 4 6 5-4-1 11z', 'M5 21h14'],
    crownhand: ['M5 13 4 5.5l3.5 2.7L11 3.5l3.5 4.7L18 5.5 17 13z', 'M4 17.5h9.5', 'M11 15l3 2.5-3 2.5'],
    core: ['M12 3l8 4.5v9L12 21l-8-4.5v-9z', 'M12 8l4 2.3v4.4L12 17l-4-2.3v-4.4z'],
    pick: ['M4 9.5c3.5-4.5 12.5-4.5 16 0', 'M12 6.5 6.5 20.5'],
    biome: ['M2 20 9 8l4 6 3-4 6 10z', 'M7.6 10.4 9 8l1.4 2.4'],
    blast: ['circle:12,12,3.2', 'M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4M5.3 5.3l2.8 2.8M15.9 15.9l2.8 2.8M18.7 5.3l-2.8 2.8M8.1 15.9l-2.8 2.8'],
    heart: ['M12 20s-8-4.5-8-10a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 20 10c0 5.5-8 10-8 10z', 'M6.5 12h3l1.5-3 2 5.5 1.5-2.5h3'],
    flash: ['rect:3.5,6,17,13,2.5', 'M13 8.5 9.5 13h4l-2.5 4'],
    garage: ['circle:7.5,8,3.5', 'circle:16.5,8,3.5', 'circle:7.5,17,3.5', 'circle:16.5,17,3.5'],
    hook: ['M12 2.5v10', 'M6 9.5c0 5 2.8 8 6 8s6-3 6-8', 'M3.8 11.5 6 9.5l2.2 2M15.8 11.5 18 9.5l2.2 2'],
    drill: ['M6.5 4h11L12 21z', 'M8.2 8.5h7.6M9.8 13h4.4'],
    wave: ['circle:12,12,2.4', 'M7.2 7.2a6.8 6.8 0 0 0 0 9.6M16.8 7.2a6.8 6.8 0 0 1 0 9.6', 'M4 4a11.3 11.3 0 0 0 0 16M20 4a11.3 11.3 0 0 1 0 16'],
    radar: ['circle:12,12,8.8', 'circle:12,12,4.4', 'M12 12l6-6'],
    wall: ['rect:3,6,18,13,1.5', 'M3 12.5h18M9 6v6.5M15 12.5V19'],
    smoke: ['M7 18a4 4 0 0 1-.5-8 5.5 5.5 0 0 1 10.6-1.2A4 4 0 1 1 18 18z'],
    rush: ['M10 6l6 6-6 6', 'M15 6l6 6-6 6', 'M2.5 9h4.5M2.5 15h4.5'],
    pad: ['M3.5 19.5h17', 'M6.5 19.5l2-4h7l2 4', 'M12 12.5V3.5', 'M8.5 7l3.5-3.5L15.5 7'],
    star: ['M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z'],
    ring: ['circle:12,12,8.8', 'circle:12,12,4.6', 'circle:12,12,1.4'],
    chest: ['rect:3,9.5,18,10.5,2', 'M3 10a9 4.5 0 0 1 18 0', 'M3 13.5h18', 'M10.5 12h3v3.5h-3z'],
    rockdown: ['M4 9.5 6.5 4h8l4 4-2 5.5H6.5z', 'M11.5 15.5v6M8.5 18.5l3 3 3-3'],
    dove: ['M3 13.5c4 0 6-2 7-6.5 1 3.5 3.5 5 7 5l4-2-2 4c-1.5 3-4.5 5-8.5 5H6.5z', 'M9 19l-1.5 2.5'],
    pin: ['M12 21s-6-6.5-6-11a6 6 0 0 1 12 0c0 4.5-6 11-6 11z', 'circle:12,10,2.2'],
    drop: ['M8 2.5l3 3.5L8 9.5 5 6z', 'M16.5 8.5l3 3.5-3 3.5-3-3.5z', 'M9 14.5l3 3.5-3 3.5-3-3.5z'],
    jar: ['M8 3.5h8', 'M7 6.5h10v12.5a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2z', 'M10 12.5a2 2 0 1 0 4 0'],
    cloud: ['M7 15a4 4 0 0 1-.5-8 5.5 5.5 0 0 1 10.6-1.2A4 4 0 1 1 18 15z', 'M12.5 14.5 10.5 18h3l-2 4'],
    sun: ['circle:12,12,4', 'M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2 2M16.7 16.7l2 2M18.7 5.3l-2 2M7.3 16.7l-2 2'],
    secret: ['M8.8 8.6a3.3 3.3 0 1 1 4.9 2.9c-1.1.6-1.7 1.4-1.7 2.6v.6', 'circle:12,18.4,.5'],
};

// The first twelve, from before the shared catalog (their ids still mean
// the same thing). Used until window.DWAchievements is loaded.
export const ACHIEVEMENTS = [
    { id: 'first_blood', name: 'First Blood', desc: 'Knock out another player', color: '#ff7a6b', icon: 'crosshair' },
    { id: 'bot_buster', name: 'Bot Buster', desc: 'Knock out 50 bots', color: '#ff7a6b', icon: 'bot' },
    { id: 'banker', name: 'Piggy Bank', desc: 'Bank 10,000 gems', color: '#4fe08f', icon: 'vault' },
    { id: 'tycoon', name: 'Tycoon', desc: 'Bank 250,000 gems', color: '#ffc665', icon: 'tycoon' },
    { id: 'podium', name: 'Podium', desc: 'Finish a raid in the top 3', color: '#d8dfea', icon: 'podium' },
    { id: 'champion', name: 'Champion', desc: 'Win a raid', color: '#ffb23d', icon: 'cup' },
    { id: 'boss_slayer', name: 'Boss Slayer', desc: 'Land the final hit on a boss', color: '#c3a6ff', icon: 'sword' },
    { id: 'survivor', name: 'Survivor', desc: 'Survive 15 minutes without dying', color: '#6ee0d6', icon: 'shield' },
    { id: 'streaker', name: 'Streaker', desc: 'Get a 5 knockout streak', color: '#ff9f43', icon: 'fire' },
    { id: 'hoarder', name: 'Hoarder', desc: 'Carry 3,000 gems at once', color: '#e0a060', icon: 'sack' },
    { id: 'emerald_eye', name: 'Emerald Eye', desc: 'Grab 25 emeralds', color: '#1fbf6b', icon: 'eye' },
    { id: 'veteran', name: 'Veteran', desc: 'Play 250 games', color: '#b4b8bd', icon: 'chevron' },
];
// id -> {id, name, desc, color, icon, d (glyph parts), ...catalog fields}
export const BY_ID = new Map();
function addDefs(list) {
    for (const a of list) BY_ID.set(a.id, Object.assign({}, BY_ID.get(a.id), a, { d: GLYPHS[a.icon] || GLYPHS.star }));
}
addDefs(ACHIEVEMENTS);
const cat = () => (typeof window !== 'undefined' && window.DWAchievements) || null;
if (cat()) addDefs(cat().DEFS);

// The full catalog (shared/achievements.js), loaded once as a plain script.
let loading = null;
export function loadCatalog() {
    if (cat()) { addDefs(cat().DEFS); return Promise.resolve(cat()); }
    if (loading) return loading;
    loading = new Promise((resolve) => {
        const s = document.createElement('script');
        s.src = '/shared/achievements.js';
        s.async = true;
        s.onload = () => { if (cat()) addDefs(cat().DEFS); resolve(cat()); };
        s.onerror = () => { loading = null; resolve(null); };
        document.head.appendChild(s);
    });
    return loading;
}

// <svg> for a glyph key: the glyph in ink, then again in currentColor.
export function glyphIcon(key, cls) {
    const s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('class', 'dw-ic' + (cls ? ' ' + cls : ''));
    s.setAttribute('aria-hidden', 'true');
    s.setAttribute('focusable', 'false');
    s.setAttribute('fill', 'none');
    s.setAttribute('stroke-linecap', 'round');
    s.setAttribute('stroke-linejoin', 'round');
    const ink = document.createElementNS(NS, 'g');
    ink.setAttribute('stroke', 'var(--ink, #120e15)');
    ink.setAttribute('stroke-width', '5');
    const top = document.createElementNS(NS, 'g');
    top.setAttribute('stroke', 'currentColor');
    top.setAttribute('stroke-width', '2.4');
    for (const part of (GLYPHS[key] || GLYPHS.star)) {
        let el;
        if (part.startsWith('circle:')) {
            const [cx, cy, r] = part.slice(7).split(',');
            el = document.createElementNS(NS, 'circle');
            el.setAttribute('cx', cx); el.setAttribute('cy', cy); el.setAttribute('r', r);
        } else if (part.startsWith('rect:')) {
            const [x, y, w, hh, rx] = part.slice(5).split(',');
            el = document.createElementNS(NS, 'rect');
            el.setAttribute('x', x); el.setAttribute('y', y); el.setAttribute('width', w); el.setAttribute('height', hh); el.setAttribute('rx', rx || 0);
        } else {
            el = document.createElementNS(NS, 'path');
            el.setAttribute('d', part);
        }
        ink.appendChild(el);
        top.appendChild(el.cloneNode());
    }
    s.appendChild(ink);
    s.appendChild(top);
    return s;
}

// <svg> for an achievement id
export function achIcon(id, cls) {
    const a = BY_ID.get(id);
    return glyphIcon(a ? a.icon : 'star', cls);
}

// A Path2D of a glyph for canvas (the HUD card), cached per key.
const paths = new Map();
export function glyphPath(key) {
    let p = paths.get(key);
    if (p !== undefined) return p;
    p = null;
    const parts = GLYPHS[key];
    if (parts && typeof Path2D === 'function') {
        p = new Path2D();
        for (const part of parts) {
            if (part.startsWith('circle:')) { const [x, y, r] = part.slice(7).split(',').map(Number); p.moveTo(x + r, y); p.arc(x, y, r, 0, Math.PI * 2); }
            else if (part.startsWith('rect:')) { const [x, y, w, hh] = part.slice(5).split(',').map(Number); p.rect(x, y, w, hh); }
            else p.addPath(new Path2D(part));
        }
    }
    paths.set(key, p);
    return p;
}
