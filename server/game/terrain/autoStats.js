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
    if (!ON || !body || !body.socket || !body.skill || !body.isPlayer) return false;
    if (typeof Config !== 'undefined' && Config.tutorial) return false;
    if (body.isDead && body.isDead()) return false;
    if (!body._autoStatsAt || t < body._autoStatsAt) return false;
    body._autoStatsAt = 0;
    const sk = body.skill;
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
        body.sendMessage("Your " + used + " unspent stat points went into a balanced build. Pick your own next life to play it your way.");
    } catch { /* */ }
    return true;
}

// arm (again) for this body: a new life or a new raid's respec
function arm(body, t = Date.now()) { if (body) body._autoStatsAt = t + AFTER_MS; }

module.exports = { AFTER_MS, GUN_BUILD, RAM_BUILD, setEnabled, isEnabled, combatSpent, placeBuild, tick, arm };
