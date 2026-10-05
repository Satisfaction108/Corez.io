// The in-raid achievement card, the rules: which unlocks show now, which
// wait for later (the newcomer HUD stages), how the queue folds a burst, and
// the card's words. Pure functions, no DOM or game state, so
// scripts/test/achievements.test.js can run them in node.
// achievementCard.js is the glue and the drawing.
//
// Stage is newcomer.js's (royale.you.nx): 0 first raid, 1 second, 2 third,
// 3 veteran; null/unknown counts as a veteran. In stage 0 only First Steps
// raise a card; anything else is held (kept in localStorage) and shown once
// the player is past stage 0.

export const CARD_MS = 4200;          // one card on screen
export const CARD_FAST_MS = 2600;     // ...when another is waiting behind it
export const MAX_WAIT = 4;            // more than this waiting fold into one "+N more" card
export const HELD_MAX = 40;
const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V'];

export function stageOf(nxStage) {
    const n = Number(nxStage);
    return nxStage == null || nxStage === '' || !isFinite(n) ? 3 : Math.max(0, Math.min(3, Math.floor(n)));
}

// -> 'show' | 'hold' | 'drop'
export function admit(d, nxStage) {
    if (!d || !d.id) return 'drop';
    return stageOf(nxStage) >= 1 || d.cat === 'first' ? 'show' : 'hold';
}

// Held cards once the stage allows them: one or two come out as their own
// cards, more than that as a single summary. -> {show:[...], summary:n, rest:[...]}
export function release(held, nxStage) {
    const list = Array.isArray(held) ? held : [];
    if (!list.length || stageOf(nxStage) < 1) return { show: [], summary: 0, rest: list };
    if (list.length <= 2) return { show: list.slice(), summary: 0, rest: [] };
    return { show: [], summary: list.length, rest: [] };
}

// Add one to the waiting queue (mutates q). A burst past MAX_WAIT folds the
// newest into one summary card at the end, so a flood never stacks up.
export function enqueue(q, d) {
    if (!d) return q;
    if (q.some((x) => x.id && x.id === d.id)) return q;
    if (q.length >= MAX_WAIT) {
        const last = q[q.length - 1];
        const add = d.summary || 1;
        // the last waiting card and this one become one "+N" card
        if (last.summary) last.summary += add;
        else q[q.length - 1] = { summary: 1 + add };
        return q;
    }
    q.push(d);
    return q;
}

export function durationFor(waiting) { return waiting > 0 ? CARD_FAST_MS : CARD_MS; }

export function fmtDust(milli) {
    const v = (+milli || 0) / 1000;
    return Number.isInteger(v) ? String(v) : String(+v.toFixed(2));
}

// The card's words: {label, title, tier, desc, reward, rewardKind}
// rewardKind: 'dust' | 'guest' | ''
export function cardText(d, itemName) {
    if (!d) return null;
    if (d.summary) {
        const n = d.summary | 0;
        return { label: 'Achievements', title: '+' + n + ' unlocked', tier: '', desc: 'See them all on the home screen.', reward: '', rewardKind: '' };
    }
    const parts = [];
    if (+d.rewardMilli > 0) parts.push('+' + fmtDust(d.rewardMilli) + ' gemdust');
    if (d.item) parts.push((itemName || 'a new') + ' name style');
    let reward = parts.join(' and ');
    let rewardKind = reward ? 'dust' : '';
    if (d.guest) { reward = 'Sign up to keep your rewards'; rewardKind = 'guest'; }
    return {
        label: d.secret ? 'Secret found!' : 'Achievement unlocked',
        title: String(d.name || d.id),
        tier: ROMAN[d.tier | 0] || '',
        desc: String(d.desc || ''),
        reward, rewardKind,
    };
}
