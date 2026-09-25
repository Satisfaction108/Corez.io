// Live gemdust, one small line under each wallet pill in the bottom HUD:
// what the satchel would bank ("+0.42 dust", lost if you die) under Carried,
// the account balance under Banked. A kill pops "+0.25", banking flies a
// dust gem from the satchel to the balance, dying shakes the satchel figure
// red before it drains. Accounts only: nothing draws until the server sends
// dust ('AC' at spawn, then 'DU').
import { gameSound } from '../sound.js';

const DUST = '#a98bff';
const LOSS_RED = '#eb4034';
const GEM = [[-1, -0.38], [-0.55, -0.95], [0.55, -0.95], [1, -0.38], [0, 0.95]];
const FLY_MS = 560;

// DU kinds (contract)
export const KIND = { SYNC: 0, PICKUP: 1, BANK: 2, KILL: 3, DEATH: 4, PLACEMENT: 5, QUEST: 6, REWARD: 7 };   // REWARD: chest / boss / shop

const D = {
    on: false,
    carried: 0, balance: 0,       // milli, as the server last said
    showC: 0, showB: 0,           // what is on screen (eased)
    balTarget: 0,                 // balance waits for the flying gem
    pops: [], flies: [],
    bumpAt: 0, balBumpAt: 0, lossAt: 0, lossFrom: 0,
    last: 0,
};

const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const easeOut = (k) => 1 - Math.pow(1 - k, 3);
const easeOutBack = (k) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2); };
// a swell that rises and settles back smoothly over `ms` (0 = no bump)
const bump = (since, ms, amt) => since < ms ? 1 + amt * Math.sin(Math.PI * easeOut(since / ms)) : 1;
const fmt = (milli) => (Math.max(0, milli) / 1000).toFixed(2);

export const active = () => D.on;

export function reset() {
    D.on = false;
    D.carried = D.balance = D.showC = D.showB = D.balTarget = 0;
    D.pops = []; D.flies = [];
    D.bumpAt = D.balBumpAt = D.lossAt = 0;
}

// From 'AC' (dust units) at spawn.
export function syncUnits(balance, carried) {
    onPacket(Math.round((+carried || 0) * 1000), Math.round((+balance || 0) * 1000), 0, KIND.SYNC);
}

export function onPacket(carriedMilli, balanceMilli, deltaMilli, kind) {
    const now = performance.now();
    const c = Math.max(0, carriedMilli | 0), b = Math.max(0, balanceMilli | 0), d = deltaMilli | 0;
    kind = kind | 0;
    const first = !D.on;
    const dC = c - D.carried, dB = b - D.balance;
    D.on = true;
    if (first || kind === KIND.SYNC) {
        D.carried = D.showC = c;
        D.balance = D.showB = D.balTarget = b;
        return;
    }
    if (kind === KIND.BANK && dB > 0) {
        // the balance waits until the gem lands on it
        D.flies.push({ at: now, amount: dB });
        D.balTarget = b;
    } else if (kind === KIND.DEATH) {
        D.lossAt = now;
        D.lossFrom = D.showC;
        D.balTarget = b;
    } else {
        D.balTarget = b;
    }
    if (kind === KIND.PICKUP) D.bumpAt = now;
    if (kind === KIND.KILL || kind === KIND.PLACEMENT || kind === KIND.QUEST || kind === KIND.REWARD) {
        const amt = d > 0 ? d : Math.max(dB, dC);
        if (amt > 0) {
            // pop where the dust went: the satchel, or straight to the balance
            D.pops.push({ at: now, txt: '+' + fmt(amt), where: dC > 0 && dC >= dB ? 'c' : 'b' });
            if (D.pops.length > 4) D.pops.shift();
            try { gameSound.dustPop && gameSound.dustPop(); } catch (e) { /* */ }
        }
    }
    D.carried = c;
    D.balance = b;
}

function gemPath(c, x, y, r) {
    c.beginPath();
    GEM.forEach(([gx, gy], i) => (i ? c.lineTo(x + gx * r, y + gy * r) : c.moveTo(x + gx * r, y + gy * r)));
    c.closePath();
}
function gemIcon(c, x, y, r, alpha) {
    c.save();
    c.globalAlpha *= alpha;
    c.lineJoin = 'round';
    gemPath(c, x, y, r);
    c.lineWidth = Math.max(2, r * 0.55);
    c.strokeStyle = '#1b1430';
    c.stroke();
    c.fillStyle = DUST;
    c.fill();
    gemPath(c, x, y - r * 0.12, r * 0.5);
    c.fillStyle = '#d8c9ff';
    c.fill();
    c.restore();
}

// geo: { carX, bankX, y } in GUI units; A: { drawText, measureText }
export function draw(c, geo, A) {
    if (!D.on) return;
    const now = performance.now();
    const dt = Math.min(100, now - (D.last || now));
    D.last = now;
    const ease = 1 - Math.pow(0.001, dt / 1000);   // ~ 1/7 s to settle

    // satchel line: eases, except while a death shows what was lost
    const lossT = D.lossAt ? now - D.lossAt : 1e9;
    if (lossT < 520) D.showC = D.lossFrom;
    else D.showC += (D.carried - D.showC) * (lossT < 1300 ? ease * 0.8 : Math.min(1, ease * 1.6));
    if (Math.abs(D.showC - D.carried) < 1) D.showC = D.carried;

    // flying gems land, then the balance counts
    for (let i = D.flies.length - 1; i >= 0; i--) {
        const f = D.flies[i];
        if (now - f.at >= FLY_MS) {
            D.flies.splice(i, 1);
            D.balBumpAt = now;
            try { gameSound.dustBank && gameSound.dustBank(); } catch (e) { /* */ }
        }
    }
    const heldB = D.flies.length ? D.flies.reduce((s, f) => s + f.amount, 0) : 0;
    const wantB = D.balTarget - heldB;
    D.showB += (wantB - D.showB) * Math.min(1, ease * 1.3);
    if (Math.abs(D.showB - wantB) < 1) D.showB = wantB;

    const y = geo.y;
    if (D.showC >= 5 || lossT < 1300) {
        const lost = lossT < 1300;
        const shake = lost && lossT < 600 ? Math.sin(lossT * 0.09) * 3.2 * (1 - lossT / 600) : 0;
        const bk = bump(now - D.bumpAt, 220, 0.12);
        const a = lost && lossT > 900 ? 1 - easeOut((lossT - 900) / 400) : 1;
        A.drawText((lost ? '\u2212' : '+') + fmt(D.showC) + ' dust', geo.carX + shake, y, 10.5 * bk, lost ? LOSS_RED : DUST, 'center', true, a);
    }
    {
        const bk = bump(now - D.balBumpAt, 300, 0.16);
        const txt = fmt(D.showB) + ' dust';
        const tw = A.measureText(txt, 10.5 * bk);
        const gx = geo.bankX - tw / 2 - 7;
        gemIcon(c, gx, y, 4.6 * bk, 1);
        A.drawText(txt, geo.bankX + 5, y, 10.5 * bk, DUST, 'center', true, 1);
    }
    for (const f of D.flies) {
        const k = clamp((now - f.at) / FLY_MS);
        const e = k * k * (3 - 2 * k);
        const x = geo.carX + (geo.bankX - geo.carX) * e;
        const yy = y - Math.sin(Math.PI * e) * 26;
        gemIcon(c, x, yy, 5.5 + 2 * Math.sin(Math.PI * e), 1);
    }
    for (let i = D.pops.length - 1; i >= 0; i--) {
        const p = D.pops[i];
        const k = (now - p.at) / 950;
        if (k >= 1) { D.pops.splice(i, 1); continue; }
        // beside the figure it went into, drifting up a little (the pills
        // sit right above, so it never climbs into their text)
        const base = p.where === 'c' ? geo.carX + A.measureText('+0.00 dust', 10.5) / 2 : geo.bankX + 5 + A.measureText(fmt(D.showB) + ' dust', 10.5) / 2;
        // pops in with a little overshoot, drifts up, fades out eased
        const sz = 11.5 * (k < 0.22 ? 0.7 + 0.3 * easeOutBack(k / 0.22) : 1);
        A.drawText(p.txt, base + 6, y + 1 - 7 * easeOut(k), sz, DUST, 'left', true, k > 0.6 ? 1 - easeOut((k - 0.6) / 0.4) : clamp(k / 0.08));
    }
}

// Harness only.
export const debugState = () => D;
