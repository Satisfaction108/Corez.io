// Growth: a tank's size follows its raid score (Config.royale_growth).
// The engine's own Config.growth path ties size to level and hands out skill
// points past 45, so this keeps its own multiplier on the body (growthMult)
// and entity.js folds it into sizeMultiplier and the stats below.
//
// Score is the raid board score (scoreOf), so kills, banking, bosses, chests
// and quests all feed it. A respawn comes back at the size the score earns,
// but never above RESPAWN_CAP; only growth earned in this life goes past it.

const RESPAWN_CAP = 2.3;
const LIVE_CEIL = 3.3;       // soft ceiling: approached, never reached
const GAIN = 0.64;
const SCALE = 1500;
// the "you grew" card fires when a life crosses one of these
const STAGES = [1.25, 1.5, 1.75, 2, 2.3, 2.6, 2.9];
const REFRESH_STEP = 0.03;   // stats are recomputed every time size moves this much
const EASE_MS = 900;

function enabled() {
    return !!(Config.dig_royale && Config.royale_growth && !Config.tutorial);
}

// 1 + GAIN*ln(1 + s/SCALE): early points show, then each step costs more.
// Past RESPAWN_CAP it bends toward LIVE_CEIL.
function multFor(score) {
    const s = Math.max(0, score || 0);
    const raw = 1 + GAIN * Math.log(1 + s / SCALE);
    if (raw <= RESPAWN_CAP) return raw;
    const room = LIVE_CEIL - RESPAWN_CAP;
    return RESPAWN_CAP + room * (1 - Math.exp(-(raw - RESPAWN_CAP) / room));
}

// the score that lands exactly on RESPAWN_CAP
const CAP_SCORE = SCALE * (Math.exp((RESPAWN_CAP - 1) / GAIN) - 1);

// Trade-offs, all 1 at normal size.
function speedMult(g) { return 1 / (1 + 0.28 * (g - 1)); }
function healthMult(g) { return 1 + 0.5 * (g - 1); }
function bodyDamageMult(g) { return 1 + 0.35 * (g - 1); }
// the camera opens up with g^0.3 instead of arras' g^0.5
function fovMult(g) { return Math.pow(g, -0.2); }
// more rock under a bigger hull and bigger shots: the per-second dig budget
function mineMult(g) { return 1 + 0.3 * (g - 1); }

// Called from refreshBodyAttributes, after the skill math.
function applyPerks(body) {
    const g = body.growthMult || 1;
    if (g <= 1) return;
    const sp = speedMult(g);
    body.topSpeed *= sp;
    body.acceleration *= sp;
    body.health.set(body.health.max * healthMult(g));
    body.damage *= bodyDamageMult(g);
}

function stageOf(g) {
    let i = 0;
    while (i < STAGES.length && g >= STAGES[i] - 1e-6) i++;
    return i;
}

// A fresh life: size from the score so far, capped for the respawn.
function onSpawn(body, score) {
    if (!body) return;
    if (!enabled()) { body.growthMult = 1; return; }
    const s = Math.max(0, score || 0);
    body._growScore0 = s;
    body._growEff = Math.min(s, CAP_SCORE);
    body._growTarget = multFor(body._growEff);
    body.growthMult = body._growTarget;
    body._growStage = stageOf(body.growthMult);
    body._growRefreshed = body.growthMult;
    body.sizeMultiplier = body.growthMult;
    try { body.refreshBodyAttributes(); } catch { /* */ }
}

// Every raid tick. scoreFor(body) -> raid score. onStage(body, g, stageIdx)
// fires when a life grows into a new stage; onRefit(body, fresh) after each
// size step (fresh: a body seen for the first time), so the raid can make
// room in the rock for the bigger hull.
let lastAt = 0;
function tick(t, bodies, scoreFor, onStage, onRefit) {
    if (!enabled()) return;
    const dt = Math.min(250, Math.max(1, t - (lastAt || t)));
    lastAt = t;
    const k = Math.min(1, dt / EASE_MS);
    for (const body of bodies) {
        if (!body || body.isDead?.()) continue;
        const score = scoreFor(body);
        if (score == null) continue;
        if (body._growEff == null) {
            onSpawn(body, score);
            if (onRefit && body.growthMult > 1.15) { try { onRefit(body, true); } catch { /* */ } }
            continue;
        }
        // growth never undoes itself inside a life (carried gems are half
        // the score and a shop trip spends them)
        const eff = body._growEff + Math.max(0, score - body._growScore0);
        if (eff > body._growEff) {
            body._growEff = eff;
            body._growScore0 = score;
            body._growTarget = multFor(eff);
        } else if (score < body._growScore0) body._growScore0 = score;
        const target = body._growTarget;
        let g = body.growthMult || 1;
        if (g === target) continue;
        g += (target - g) * k + Math.sign(target - g) * 0.0015 * (dt / 33);
        if ((target - g) * Math.sign(target - (body.growthMult || 1)) <= 0) g = target;
        body.growthMult = g;
        body.sizeMultiplier = g * ((global.royaleMods && global.royaleMods.sizeMult) || 1);
        if (Math.abs(g - body._growRefreshed) >= REFRESH_STEP || g === target) {
            body._growRefreshed = g;
            try { body.refreshBodyAttributes(); } catch { /* */ }
            if (onRefit) { try { onRefit(body, false); } catch { /* */ } }
        }
        const st = stageOf(g);
        if (st > (body._growStage | 0)) {
            body._growStage = st;
            try { if (onStage) onStage(body, STAGES[st - 1], st); } catch { /* */ }
        }
    }
}

module.exports = {
    RESPAWN_CAP, LIVE_CEIL, STAGES, CAP_SCORE,
    enabled, multFor, onSpawn, tick, applyPerks, stageOf,
    speedMult, healthMult, bodyDamageMult, fovMult, mineMult,
};
