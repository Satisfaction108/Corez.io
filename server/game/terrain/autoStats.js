// Auto stats: a player who hasn't put a single stat point anywhere AFTER_MS into
'use strict';

const envMs = +process.env.ROYALE_AUTO_STATS_MS;
const AFTER_MS = envMs > 0 ? envMs : 20_000;
let ON = process.env.ROYALE_AUTO_STATS === '1';   // off unless asked for (owner: no build picked for you)
function setEnabled(v) { ON = !!v; }
function isEnabled() { return ON; }

// raw order: [rld, pen, str, dam, spd, shi, atk, hlt, rgn, mob, min] 50 points
const GUN_BUILD = [7, 7, 5, 7, 4, 2, 0, 5, 2, 5, 6];
const RAM_BUILD = [0, 0, 0, 0, 0, 8, 9, 9, 7, 9, 8];
const GUN_PRIORITY = [3, 0, 1, 2, 7, 10, 9, 4, 5, 8, 6];
const RAM_PRIORITY = [6, 7, 9, 5, 8, 10, 0, 1, 2, 3, 4];
const TEMPLATE_POINTS = 50;
// Oct 8 (owner): a new player (fewer than NEW_LIVES lives ever) picks their own
// build, but Mining Power is lifted to NEW_MINING for free, on top of their own
// points, so rock doesn't take forever to break while they learn
const NEW_LIVES = 10;
const NEW_AFTER_MS = 1000;
const MINING = 10;            // raw slot of Mining Power
const NEW_MINING = 5;

// combat points spent (slots 0..9)
function combatSpent(raw) {
    let n = 0;
    for (let i = 0; i < 10 && i < (raw || []).length; i++) n += raw[i] | 0;
    return n;
}

// Pure: place `points` on top of `raw` by the template, then round-robin the rest
function placeBuild(raw, points, caps, rammer = false) {
    const tpl = rammer ? RAM_BUILD : GUN_BUILD;
    const pri = rammer ? RAM_PRIORITY : GUN_PRIORITY;
    const out = (raw || []).slice();
    while (out.length < tpl.length) out.push(0);
    let left = Math.max(0, points | 0);
    const cap = (i) => (caps && caps[i] != null ? caps[i] | 0 : 9);
    const scale = left / TEMPLATE_POINTS;
    for (let i = 0; i < tpl.length && left > 0; i++) {
        const want = Math.floor(tpl[i] * scale);
        const n = Math.max(0, Math.min(want, cap(i) - (out[i] | 0), left));
        out[i] = (out[i] | 0) + n;
        left -= n;
    }
    for (let guard = 0; left > 0 && guard < 20; guard++) {
        let placed = false;
        for (const i of pri) {
            if (left <= 0) break;
            if ((out[i] | 0) < cap(i)) { out[i] = (out[i] | 0) + 1; left--; placed = true; }
        }
        if (!placed) break;
    }
    return { raw: out, left };
}

// no guns, or a smasher hull
function isRammer(body) {
    const guns = body && body.guns;
    if (!guns) return false;
    if (body.settings && body.settings.reloadToAcceleration) return true;
    const n = typeof guns.size === 'number' ? guns.size : (guns.length | 0);
    return n === 0;
}

// once a second per human body
function tick(body, t = Date.now()) {
    if (!body || !(ON || body._autoStatsNew) || !body.socket || !body.skill || !body.isPlayer) return false;
    if (typeof Config !== 'undefined' && Config.tutorial) return false;
    if (body.isDead && body.isDead()) return false;
    if (!body._autoStatsAt || t < body._autoStatsAt) return false;
    body._autoStatsAt = 0;
    const sk = body.skill;
    if (body._autoStatsNew) return newbieMining(body, sk);
    if (!((sk.points | 0) > 0) || combatSpent(sk.raw) > 0) return false;
    const before = sk.points | 0;
    const fit = placeBuild(sk.raw, before, sk.caps, isRammer(body));
    try {
        sk.set(fit.raw);
        sk.points = fit.left;
        body.refreshBodyAttributes();
        if (body.syncSkillsToGuns) body.syncSkillsToGuns();
    } catch (e) {
        console.error('[AUTOSTATS]', e && e.message);
        return false;
    }
    const used = before - fit.left;
    try {
        body.sendMessage("Your " + used + " unspent stat points went into a balanced build. Next life, you can pick your own.");
    } catch { /* */ }
    return true;
}

// arm (again) for this body: a new life or a new raid's respec
// A new player's free Mining Power: up to NEW_MINING (never past the cap), their
// own points untouched. -> true when it lifted it
function newbieMining(body, sk) {
    const raw = (sk.raw || []).slice();
    const cap = sk.caps && sk.caps[MINING] != null ? sk.caps[MINING] | 0 : 9;
    const want = Math.min(cap, NEW_MINING);
    if (!((raw[MINING] | 0) < want)) return false;
    raw[MINING] = want;
    try {
        sk.set(raw);
        body.refreshBodyAttributes();
        if (body.syncSkillsToGuns) body.syncSkillsToGuns();
    } catch (e) {
        console.error('[AUTOSTATS]', e && e.message);
        return false;
    }
    try { body.sendMessage("To help you while you learn, your Mining Power starts at " + want + "."); } catch { /* */ }
    return true;
}

// `newbie`: a new player (lifetime lives under NEW_LIVES): the free Mining Power, right away
function arm(body, t = Date.now(), newbie = false) {
    if (!body) return;
    body._autoStatsNew = !!newbie;
    body._autoStatsAt = t + (newbie ? NEW_AFTER_MS : AFTER_MS);
}

module.exports = { AFTER_MS, NEW_AFTER_MS, NEW_LIVES, NEW_MINING, GUN_BUILD, RAM_BUILD, setEnabled, isEnabled, combatSpent, placeBuild, tick, arm, newbieMining };
