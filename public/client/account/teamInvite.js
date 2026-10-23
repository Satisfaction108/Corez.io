import { toast } from './ui.js';
import * as gameToasts from './gameToasts.js';

const LINK_RE = /^\/\?team=[A-Za-z0-9]{6}$/;
const SHOW_MAX_MS = 60000;

const shown = new Map();

const inGame = () => document.body.classList.contains('in-game');

function go(link) {
    try { location.assign(new URL(link, location.origin).href); } catch (e) { void e; }
}

export function receive(d) {
    if (!d || typeof d.link !== 'string' || !LINK_RE.test(d.link)) return;
    const now = Date.now();
    const left = Math.min(SHOW_MAX_MS, (+d.expiresAt || 0) - now);
    if (left < 3000) return;
    for (const [k, at] of shown) if (at < now) shown.delete(k);
    const key = (d.from || '') + d.link;
    if (shown.has(key)) return;
    shown.set(key, now + left);
    const name = String(d.fromName || 'A friend');
    if (inGame() && gameToasts.teamInvite({ key, name, ms: left }, () => go(d.link))) return;
    toast(name + ' invited you to their team in 2TDM', {
        duration: left,
        actions: [
            { label: 'Join', onClick: () => go(d.link) },
            { label: 'Not now', onClick: () => {} },
        ],
    });
}
