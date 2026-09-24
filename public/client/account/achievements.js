// The 12 achievements: friendly names, what they ask for, a flat colour and
// a small line icon each (24-unit grid, drawn with currentColor).
const NS = 'http://www.w3.org/2000/svg';

export const ACHIEVEMENTS = [
    { id: 'first_blood', name: 'First Blood', desc: 'Knock out another player', color: '#ff7a6b',
        d: ['M12 3v4M12 17v4M3 12h4M17 12h4', 'circle:12,12,6', 'circle:12,12,1.6'] },
    { id: 'bot_buster', name: 'Bot Buster', desc: 'Knock out 50 bots', color: '#7ad3ff',
        d: ['M12 3v3', 'circle:12,2.6,1', 'rect:5,6,14,12,3', 'M9 11v1.5M15 11v1.5', 'M9.5 15h5', 'M3 11v3M21 11v3'] },
    { id: 'banker', name: 'Banker', desc: 'Bank 10,000 gems', color: '#4fe08f',
        d: ['M3.5 9 12 4l8.5 5z', 'M5.5 10.5v6M9.8 10.5v6M14.2 10.5v6M18.5 10.5v6', 'M3.5 19.5h17'] },
    { id: 'tycoon', name: 'Tycoon', desc: 'Bank 250,000 gems', color: '#ffc665',
        d: ['M4 8.5 7.5 12 12 6l4.5 6L20 8.5l-1.6 9.5H5.6z', 'M5.6 20.5h12.8'] },
    { id: 'podium', name: 'Podium', desc: 'Finish a raid in the top 3', color: '#d8dfea',
        d: ['M8.5 20.5v-10h7v10', 'M3 20.5v-6h5.5M15.5 16.5H21v4', 'M2 20.5h20', 'M12 4.5v3'] },
    { id: 'champion', name: 'Champion', desc: 'Win a raid', color: '#ffb23d',
        d: ['M8 20h8M12 15.5V20', 'M7 4h10v5a5 5 0 0 1-10 0z', 'M17 5.5h2.5V7a3 3 0 0 1-3 3M7 5.5H4.5V7a3 3 0 0 0 3 3'] },
    { id: 'boss_slayer', name: 'Boss Slayer', desc: 'Land the final hit on a boss', color: '#c3a6ff',
        d: ['M14.5 3.5H20.5V9.5L10 20 4 14z', 'M7.5 12.5l4 4', 'M4 20l2.5-2.5'] },
    { id: 'survivor', name: 'Survivor', desc: 'Survive 30 minutes without dying', color: '#6ee0d6',
        d: ['M12 21s-7.5-3.2-7.5-9.5V5.5L12 3l7.5 2.5v6C19.5 17.8 12 21 12 21z', 'M8.5 12l2.4 2.4 4.6-4.8'] },
    { id: 'streaker', name: 'Streaker', desc: 'Get a 5-knockout streak', color: '#ff9f43',
        d: ['M12 21c-4 0-6.5-2.7-6.5-6.2 0-3.3 2.4-5 3.6-8.3.2-.6 1-.7 1.3-.1.9 1.6 1.2 3 1.1 4.6 1.2-.8 2-2.1 2.3-3.4.1-.5.8-.7 1.1-.2 1.5 2.2 2.6 4.6 2.6 7.4 0 3.5-2.5 6.2-5.5 6.2z'] },
    { id: 'hoarder', name: 'Hoarder', desc: 'Carry 3,000 gems at once', color: '#e0a060',
        d: ['M9 4.5h6l-1.6 3h-2.8z', 'M10.6 7.5C6.5 9 4.5 12.5 4.5 15.5c0 3 2.5 5 7.5 5s7.5-2 7.5-5c0-3-2-6.5-6.1-8'] },
    { id: 'emerald_eye', name: 'Emerald Eye', desc: 'Grab 25 emeralds', color: '#1fbf6b',
        d: ['M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z', 'M12 8.6 15 11.2 13.9 15H10.1L9 11.2z'] },
    { id: 'veteran', name: 'Veteran', desc: 'Play 250 games', color: '#b4b8bd',
        d: ['M5 4.5h14v8.5L12 20l-7-7z', 'M8.5 9 12 11.5 15.5 9', 'M8.5 12.8 12 15.3l3.5-2.5'] },
];
export const BY_ID = new Map(ACHIEVEMENTS.map((a) => [a.id, a]));

// <svg> for an achievement, stroked in currentColor.
export function achIcon(id, cls) {
    const a = BY_ID.get(id);
    const s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('class', 'dw-ic' + (cls ? ' ' + cls : ''));
    s.setAttribute('aria-hidden', 'true');
    s.setAttribute('focusable', 'false');
    s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '1.9');
    s.setAttribute('stroke-linecap', 'round');
    s.setAttribute('stroke-linejoin', 'round');
    for (const part of (a ? a.d : [])) {
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
        s.appendChild(el);
    }
    return s;
}
