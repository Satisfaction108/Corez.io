// The rank card on the raid death screen: the free strip under the run stats
// in gameDrawDeadRoyale. Badge on the left; rank name and a +/- RP pill; a
// bar that shows where you land (a light ghost first) and then eases there
// while the numbers count; one short line under it, plus the gemdust.
//
// Variants: normal, loss (fares, Platinum and up), placement lives (pips),
// the placement reveal, Legend (#N), a guest nudge, and "Calculating" while
// the RK packet is on its way. A bar that fills past the division starts the
// RANKED UP ceremony, then refills in the new division.
//
// State comes from socketinit ('AC', 'F', 'RK', 'RKP', 'c'). 'F' never
// clears a result (RK lands right after it); respawn / startGame / exit do.
import { drawBadge, TIER_COLORS, tierOf } from './rankBadges.js';
import * as ceremony from './rankCeremony.js';
import { gameSound } from '../sound.js';

const R = () => window.DWRanks || null;
const DUST = '#a98bff';
const GAIN = { fill: 'rgba(95,210,76,0.16)', line: 'rgba(95,210,76,0.6)', text: '#8fe07f' };
const LOSS = { fill: 'rgba(235,64,52,0.16)', line: 'rgba(235,64,52,0.6)', text: '#ff8b7e' };
const SOFT = '#9a96a8';   // secondary lines: readable, but quieter than the stats
const EVEN = { fill: 'rgba(255,255,255,0.06)', line: 'rgba(255,255,255,0.18)', text: '#c9c1ad' };

const S = {
    acct: false,        // an 'AC' arrived on this socket: an RK is coming
    diedAt: 0,
    shownAt: 0,
    guest: null,        // guest RK payload
    steps: [],          // one per result: the life, then the raid bonus
    parts: [],
    dustMilli: 0,
    capped: false,
};

const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const easeOut = (k) => 1 - Math.pow(1 - k, 3);
const fmtInt = (n) => Math.round(n || 0).toLocaleString('en-US');
const fmtDust = (milli) => (Math.max(0, milli || 0) / 1000).toFixed(2);
const nameOf = (i) => (R() ? R().nameOf(i) : (i == null ? 'Unranked' : 'Rank ' + (i + 1)));

/* ── state in ────────────────────────────────────────────────────────── */
export function setAccount(ac) { S.acct = !!ac; }

export function onDeath() {
    S.diedAt = performance.now();
    S.shownAt = 0;
}

export function clear() {
    S.diedAt = 0;
    S.shownAt = 0;
    S.guest = null;
    S.steps = [];
    S.parts = [];
    S.dustMilli = 0;
    S.capped = false;
}

// Everything the renderer needs about one snapshot.
function snap(s) {
    s = s || {};
    const div = s.division == null ? null : s.division | 0;
    const pl = s.placement || {};
    return {
        division: div, rp: +s.rp || 0, into: +s.into || 0, size: +s.size || 0,
        pct: div === 18 ? 1 : clamp(+s.pct || 0), legendNo: s.legendNo | 0,
        lives: pl.lives | 0, of: pl.of || 3, done: !!pl.done,
    };
}

function addStep(kind, before, after, delta, flags) {
    const b = snap(before), a = snap(after);
    const placement = flags.placement || null;
    const reveal = !!(placement && placement.finished) || (b.division == null && a.division != null);
    const inPlacement = !reveal && a.division == null;
    const up = !reveal && !inPlacement && b.division != null && a.division != null && a.division > b.division;
    const step = {
        kind, b, a, delta: delta | 0, reveal, inPlacement, up,
        tierUp: up && (flags.tierUp || (R() && R().isTierUp(b.division, a.division))),
        placement, phase: 'wait', t0: 0, cer: null, cerDone: false, swapAt: 0, soundDone: false,
    };
    if (reveal || up) {
        step.cer = ceremony.enqueue({ kind: reveal ? 'reveal' : step.tierUp ? 'tier' : 'up', from: reveal ? 'placement' : b.division, to: a.division, legendNo: a.legendNo });
    }
    S.steps.push(step);
}

export function setResult(rk) {
    if (!rk || typeof rk !== 'object') return;
    if (rk.guest) { S.guest = rk; return; }
    S.acct = true;
    S.guest = null;
    S.parts = Array.isArray(rk.parts) ? rk.parts.slice(0, 5) : [];
    if (rk.fare > 0 && !S.parts.some((p) => /fare/i.test(p[0]))) S.parts.push(['Entry fee', -rk.fare]);
    S.capped = !!rk.capped;
    S.dustMilli += (rk.dust && rk.dust.lifeMilli) | 0;
    addStep('life', rk.before, rk.after, rk.delta, { placement: rk.placement, tierUp: rk.tierUp });
}

export function setRaidBonus(p) {
    if (!p || typeof p !== 'object') return;
    S.acct = true;
    if (p.bonusRP) S.parts.push(['#' + (p.place | 0) + ' in raid', p.bonusRP | 0]);
    S.dustMilli += p.bonusDustMilli | 0;
    addStep('raid', p.before, p.after, p.bonusRP, { tierUp: p.tierUp });
}

export const isGuestNudge = () => !!S.guest;
export const hasContent = () => !!(S.guest || S.steps.length || (S.acct && S.diedAt));
export const debugState = () => S;

/* ── the timeline ────────────────────────────────────────────────────── */
function fillMs(from, to) { return 450 + 950 * Math.min(1, Math.abs(to - from)); }

function advance(now) {
    let prevEnd = S.shownAt + 450;
    for (const st of S.steps) {
        if (st.phase === 'done') { prevEnd = Math.max(prevEnd, st.endAt + 300); continue; }
        if (st.phase === 'wait') {
            if (now < prevEnd) return st;
            st.phase = 'fill';
            st.t0 = now;
            if (st.delta < 0 && gameSound.rankDown) { try { gameSound.rankDown(); } catch (e) { /* */ } }
        }
        if (st.phase === 'fill') {
            const dur = st.inPlacement || st.reveal ? 700 : st.up ? fillMs(st.b.pct, 1) : fillMs(st.b.pct, st.a.pct);
            if (now - st.t0 < dur) return st;
            if (st.cer) {
                st.phase = 'cer';
                const ev = st.cer;
                ceremony.start(ev, () => { st.cerDone = true; });
            } else {
                st.phase = 'done';
                st.endAt = now;
                continue;
            }
        }
        if (st.phase === 'cer') {
            if (!st.cerDone) return st;
            st.phase = 'fill2';
            st.t0 = now;
            st.swapAt = now;
        }
        if (st.phase === 'fill2') {
            if (now - st.t0 < fillMs(0, st.a.pct) + 150) return st;
            st.phase = 'done';
            st.endAt = now;
        }
    }
    return S.steps[S.steps.length - 1] || null;
}

// What to show for a step at `now`.
function view(st, now) {
    const b = st.b, a = st.a;
    const v = { division: a.division, legendNo: a.legendNo, pips: null, bar: null, ghost: null, loss: st.delta < 0,
        into: a.into, size: a.size, prog: 1, swapK: 1, rp: a.rp, legend: a.division === 18 };
    if (st.phase === 'wait') {
        v.division = st.reveal ? null : b.division;
        v.prog = 0;
        v.into = b.into; v.size = b.size; v.rp = b.rp;
        v.legend = b.division === 18;
        if (st.inPlacement || st.reveal) v.pips = { have: b.lives, pop: -1, k: 0 };
        else if (st.up) { v.bar = b.pct; v.ghost = [b.pct, 1]; }
        else { v.bar = b.pct; v.ghost = [Math.min(b.pct, a.pct), Math.max(b.pct, a.pct)]; }
        v.ghostK = 0;
        return v;
    }
    if (st.phase === 'fill' || st.phase === 'cer') {
        const dur = st.inPlacement || st.reveal ? 700 : st.up ? fillMs(b.pct, 1) : fillMs(b.pct, a.pct);
        const k = st.phase === 'cer' ? 1 : clamp((now - st.t0) / dur);
        // the bar and every number count in on one easeOutCubic curve
        const e = easeOut(clamp((k - 0.18) / 0.82));
        v.ghostK = clamp(k / 0.18);
        v.prog = e;
        if (st.inPlacement || st.reveal) {
            const have = st.reveal ? 3 : a.lives;
            v.division = null;
            v.pips = { have: Math.max(b.lives, have), pop: have > b.lives ? have - 1 : -1, k: e };
            v.prog = e;
            v.into = a.into; v.size = a.size;
            return v;
        }
        if (st.up) {
            v.division = b.division;
            v.legend = b.division === 18;
            v.bar = b.pct + (1 - b.pct) * e;
            v.ghost = [b.pct, 1];
            v.into = b.into + (b.size - b.into) * e; v.size = b.size;
            v.rp = b.rp + (a.rp - b.rp) * e * 0.5;
            return v;
        }
        v.bar = b.pct + (a.pct - b.pct) * e;
        v.ghost = [Math.min(b.pct, a.pct), Math.max(b.pct, a.pct)];
        v.into = b.into + (a.into - b.into) * e;
        v.rp = b.rp + (a.rp - b.rp) * e;
        return v;
    }
    if (st.phase === 'fill2') {
        const k = clamp((now - st.t0) / (fillMs(0, a.pct) + 150));
        const e = easeOut(clamp((k - 0.12) / 0.88));
        v.swapK = clamp((now - st.swapAt) / 260);
        v.bar = a.pct * e;
        v.ghost = [0, a.pct];
        v.ghostK = clamp(k / 0.12);
        v.into = a.into * e;
        v.prog = 1;
        return v;
    }
    // done
    v.bar = a.pct;
    v.ghost = null;
    if (a.division == null) v.pips = { have: a.lives, pop: -1, k: 1 };
    return v;
}

/* ── drawing ─────────────────────────────────────────────────────────── */
function rrect(c, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
}

function pill(c, A, txt, rx, cy, style, alpha) {
    const w = A.measureText(txt, 12.5) + 20, h = 22;
    c.save();
    c.globalAlpha = alpha;
    rrect(c, rx - w, cy - h / 2, w, h, h / 2);
    c.fillStyle = style.fill;
    c.fill();
    c.lineWidth = 1.5;
    c.strokeStyle = style.line;
    c.stroke();
    c.restore();
    A.drawText(txt, rx - w / 2, cy, 12.5, style.text, 'center', true, alpha);
    return w;
}

function fitSize(A, txt, size, maxW, floor = 9) {
    while (size > floor && A.measureText(txt, size) > maxW) size -= 0.5;
    return size;
}

function bar(c, A, x0, x1, cy, v, col, alpha) {
    const chunk = A.barChunk || 5;
    c.save();
    c.globalAlpha = alpha;
    c.lineCap = 'round';
    A.drawBar(x0, x1, cy, 12 + chunk, A.color.black);
    A.drawBar(x0, x1, cy, 12, '#1d1e25');
    const span = x1 - x0;
    if (v.ghost && v.ghost[1] > v.ghost[0] + 0.002) {
        c.globalAlpha = alpha * (v.loss ? 0.55 : 0.35) * (v.ghostK == null ? 1 : v.ghostK);
        A.drawBar(x0 + span * v.ghost[0], x0 + span * v.ghost[1], cy, 9, v.loss ? '#eb4034' : col.light);
        c.globalAlpha = alpha;
    }
    if (v.bar > 0.004) A.drawBar(x0, x0 + span * v.bar, cy, 9.5, col.base);
    c.restore();
}

function pipRow(c, A, x0, cy, v, alpha) {
    const n = 3, s = 8.5, gap = 30;
    const col = TIER_COLORS.placement;
    for (let i = 0; i < n; i++) {
        const x = x0 + s + 2 + i * gap;
        const on = i < v.pips.have;
        let k = 1;
        if (i === v.pips.pop) k = easeOut(clamp(v.pips.k * 1.4));
        c.save();
        c.globalAlpha = alpha;
        c.lineJoin = 'round';
        const path = (sz) => {
            c.beginPath();
            c.moveTo(x, cy - sz * 1.15); c.lineTo(x + sz, cy); c.lineTo(x, cy + sz * 1.15); c.lineTo(x - sz, cy);
            c.closePath();
        };
        path(s);
        c.lineWidth = 5;
        c.strokeStyle = '#111318';
        c.stroke();
        c.fillStyle = '#23252d';
        c.fill();
        if (on) {
            const sz = s * (i === v.pips.pop ? 0.4 + 0.6 * k : 1);
            path(sz);
            c.fillStyle = '#ffc665';
            c.fill();
            c.fillStyle = '#dc921f';
            c.beginPath();
            c.moveTo(x, cy); c.lineTo(x + sz, cy); c.lineTo(x, cy + sz * 1.15); c.closePath();
            c.fill();
        }
        c.restore();
    }
    return x0 + n * gap;
}

// Draw the card into (x, y, w, h). A = the game's helpers:
// { drawText, measureText, drawBar, color, barChunk }. Returns false when
// there is nothing to show (no account, ranked off), so the space stays empty.
export function draw(c, x, y, w, h, A, alpha = 1, nowIn) {
    if (!hasContent()) return false;
    const now = nowIn || performance.now();
    if (!S.shownAt) S.shownAt = now;
    if (alpha <= 0.01) return true;

    c.save();
    c.globalAlpha = alpha;
    rrect(c, x, y, w, h, 9);
    c.fillStyle = 'rgba(255,255,255,0.045)';
    c.fill();
    c.lineWidth = 2;
    c.strokeStyle = 'rgba(0,0,0,0.45)';
    c.stroke();
    c.restore();

    const bx = x + 50, by = y + h / 2;
    const x0 = x + 98, x1 = x + w - 16;
    const grey = A.color.grey, white = A.color.guiwhite;

    if (S.guest) {
        drawBadge(c, bx, by, 64, 'placement', { alpha: alpha * 0.7 });
        A.drawText('RANKED', x0, y + 22, 10, grey, 'left', true, alpha);
        const t = 'Make an account to get ranked!';
        A.drawText(t, x0, y + 46, fitSize(A, t, 17, x1 - x0), white, 'left', true, alpha);
        const wb = S.guest.wouldBe;
        const line = wb && wb.name ? 'That game would’ve put you in ' + wb.name : 'Every raid counts once you’re ranked';
        A.drawText(line, x0, y + 72, fitSize(A, line, 12, x1 - x0), SOFT, 'left', true, alpha);
        return true;
    }

    const st = advance(now);
    if (!st) {
        // an account, but the result has not landed yet
        const waited = now - (S.diedAt || now);
        const pulse = 0.45 + 0.25 * Math.sin(now / 260);
        drawBadge(c, bx, by, 64, 'placement', { alpha: alpha * pulse });
        A.drawText('RANK', x0, y + 30, 10, grey, 'left', true, alpha);
        const dots = '.'.repeat(1 + (Math.floor(now / 380) % 3));
        A.drawText(waited > 7000 ? 'Your rank will show up soon' : 'Counting points' + dots, x0, y + 54, 16, SOFT, 'left', true, alpha);
        return true;
    }

    const v = view(st, now);
    const col = v.division == null ? TIER_COLORS.placement : TIER_COLORS[tierOf(v.division)];

    // badge (a quick settle when it swaps to the new division)
    const sk = easeOut(v.swapK);
    const ba = alpha * (0.35 + 0.65 * sk);
    drawBadge(c, bx, by, 72, v.division == null ? 'placement' : v.division, { legendNo: v.legendNo, alpha: ba });
    if (v.swapK < 1) {
        c.save();
        c.globalAlpha = alpha * (1 - sk) * 0.8;
        c.lineWidth = 3;
        c.strokeStyle = col.light;
        c.beginPath();
        c.arc(bx, by, 30 + 16 * sk, 0, Math.PI * 2);
        c.stroke();
        c.restore();
    }

    // total RP change so far, counted in
    let total = 0;
    for (const s2 of S.steps) {
        if (s2 === st) { total += s2.delta * (s2.phase === 'wait' ? 0 : s2.phase === 'fill' ? v.prog : 1); break; }
        total += s2.delta;
    }
    const tot = Math.round(total);
    const pillTxt = (tot > 0 ? '+' : tot < 0 ? '−' : '+') + Math.abs(tot) + ' RP';
    const pw = pill(c, A, pillTxt, x1, y + 30, tot > 0 ? GAIN : tot < 0 ? LOSS : EVEN, alpha);

    // label + name
    const placing = v.division == null;
    A.drawText(placing ? 'PLACEMENT' : st.kind === 'raid' && st.phase !== 'done' ? 'RAID BONUS' : 'RANK', x0, y + 14, 10, grey, 'left', true, alpha);
    let name = placing ? 'Game ' + Math.min(3, Math.max(1, st.reveal ? 3 : st.a.lives)) + ' of 3' : nameOf(v.division);
    const nameMax = x1 - x0 - pw - 12;
    const ns = fitSize(A, name, 18, nameMax, 12);
    A.drawText(name, x0, y + 32, ns, col.text, 'left', true, alpha);
    if (v.legend && v.legendNo > 0) {
        const nx = x0 + A.measureText(name, ns) + 10;
        const no = '#' + v.legendNo;
        A.drawText(no, nx, y + 32, 16, '#ffc665', 'left', true, alpha);
        const was = st.b.legendNo | 0;
        if (was > v.legendNo && st.phase === 'done') {
            A.drawText('▲' + (was - v.legendNo), nx + A.measureText(no, 16) + 8, y + 32, 11, GAIN.text, 'left', true, alpha);
        }
    }

    // bar or placement pips, then the line under it
    let line = '';
    if (v.pips) {
        pipRow(c, A, x0, y + 58, v, alpha);
        const left = 3 - v.pips.have;
        if (st.reveal && st.phase !== 'wait') line = 'Placement complete!';
        else if (st.phase !== 'wait' && st.inPlacement && st.a.lives <= st.b.lives) line = 'Too quick to count. Survive longer!';
        else line = left <= 0 ? 'Placement complete!' : left + ' more ' + (left === 1 ? 'game' : 'games') + ' to get your rank';
        A.drawText(line, x0 + 96, y + 58, fitSize(A, line, 12, x1 - x0 - 96), SOFT, 'left', true, alpha);
        line = '';
    } else {
        bar(c, A, x0 + 6, x1 - 6, y + 58, v, col, alpha);
        if (v.legend) line = fmtInt(v.rp) + ' RP';
        else {
            line = fmtInt(v.into) + ' / ' + fmtInt(v.size) + ' RP';
            if (v.division != null && v.division < 18) line += '  ·  next ' + nameOf(v.division + 1);
        }
    }
    const dustTxt = S.dustMilli > 0 ? '+' + fmtDust(S.dustMilli) + ' gemdust' : '';
    const dw = dustTxt ? A.measureText(dustTxt, 12) : 0;
    if (line) A.drawText(line, x0, y + 79, fitSize(A, line, 12, x1 - x0 - dw - 14), white, 'left', true, alpha);
    if (dustTxt) A.drawText(dustTxt, x1, v.pips ? y + 82 : y + 79, 12, DUST, 'right', true, alpha);

    // where the points came from, small
    const bits = S.parts.filter((p) => p && p[1]).map((p) => p[0] + ' ' + (p[1] > 0 ? '+' : '−') + Math.abs(p[1] | 0));
    if (S.capped) bits.push('Max per game');
    if (bits.length) {
        const t = bits.join('  ·  ');
        A.drawText(t, x0, y + 97, fitSize(A, t, 10, x1 - x0, 8), SOFT, 'left', true, alpha);
    }
    return true;
}
