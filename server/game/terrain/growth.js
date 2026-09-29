// Growth: a tank's size follows its raid score (Config.royale_growth).
// The engine's own Config.growth path ties size to level and hands out skill
// points past 45, so this keeps its own multiplier on the body (growthMult)
// and entity.js folds it into sizeMultiplier and the stats below.
//
// Score is the raid board score (scoreOf), so kills, banking, bosses, chests
// and quests all feed it. A respawn comes back at the size a quarter of the
// score earns, never above RESPAWN_CAP, and grows on from there with every
// point earned in the new life.

const RESPAWN_SHARE = 0.25;
const RESPAWN_CAP = 2;
const GAIN = 0.64;
const SCALE = 1100;          // 2x at ~4.1k score (was 1500: ~5.7k)
// Bots grow from BOT_SCORE_MULT times their score, so a server has big
// tanks around to chase. Growth only: the board keeps the real score.
const BOT_SCORE_MULT = 2;
// the "you grew" card fires when a life crosses one of these
const STAGES = [1.25, 1.5, 1.75, 2, 2.3, 2.6, 2.9, 3.25, 3.5, 4, 4.5, 5, 6, 7, 8, 10];
const REFRESH_STEP = 0.03;   // stats are recomputed every time size moves this much
const EASE_MS = 900;

function enabled() {
    return !!(Config.dig_royale && Config.royale_growth && !Config.tutorial);
}

// 1 + GAIN*ln(1 + s/SCALE): early points show, then each step costs more,
// but there's no ceiling: every doubling of score still adds ~0.44x.
function multFor(score) {
    const s = Math.max(0, score || 0);
    return 1 + GAIN * Math.log(1 + s / SCALE);
}

// the growth score that lands exactly on RESPAWN_CAP
const CAP_SCORE = SCALE * (Math.exp((RESPAWN_CAP - 1) / GAIN) - 1);

function scoreMult(body) { return body && body.isBot ? BOT_SCORE_MULT : 1; }

// What a fresh life starts growing from: a quarter of the raid score, capped.
function spawnEff(score) {
    return Math.min(Math.max(0, score || 0) * RESPAWN_SHARE, CAP_SCORE);
}

// Trade-offs, all 1 at normal size.
function speedMult(g) { return 1 / (1 + 0.28 * (g - 1)); }
// Health and damage creep up with size, slowly: STAT_AT_100K at a 100k
// growth score, in a straight line from 1 at normal size. Damage covers
// everything the tank deals: shots and rams into tanks, chests and rock.
const STAT_AT_100K = 1.6;
const STAT_K = (STAT_AT_100K - 1) / (multFor(100000) - 1);
function statMult(g) { return 1 + STAT_K * Math.max(0, g - 1); }
function healthMult(g) { return statMult(g); }
function damageMult(g) { return statMult(g); }
function bodyDamageMult(g) { return statMult(g); }
// The camera: arras' own sqrt(size) times this, so the view follows
// g^VIEW_POW, up to VIEW_MAX times a normal tank's.
const VIEW_POW = 0.7;
const VIEW_MAX = 1.8;
function viewMult(g) { return Math.min(VIEW_MAX, Math.pow(Math.max(1, g), VIEW_POW)); }
function fovMult(g) { return viewMult(g) / Math.sqrt(Math.max(1, g)); }
// Rock: every hit digs damageMult harder, and the per-second dig budget
// rises by the same factor, so a grown tank digs at most that much faster.
function mineMult(g) { return damageMult(g); }

// Called from refreshBodyAttributes, after the skill math.
function applyPerks(body) {
    const g = body.growthMult || 1;
    if (g <= 1) return;
    const sp = speedMult(g);
    body.topSpeed *= sp;
    body.acceleration *= sp;
    body.health.set(body.health.max * healthMult(g));
    body.damage *= damageMult(g);
}

function stageOf(g) {
    let i = 0;
    while (i < STAGES.length && g >= STAGES[i] - 1e-6) i++;
    return i;
}

// A fresh life: size from a quarter of the score so far, capped for the
// respawn. `keep` (a reconnect) carries the old life's growth score as is.
function onSpawn(body, score, keep) {
    if (!body) return;
    if (!enabled()) { body.growthMult = 1; return; }
    const s = Math.max(0, score || 0) * scoreMult(body);
    body._growScore0 = s;
    body._growEff = keep > 0 ? keep : spawnEff(s);
    body._growTarget = multFor(body._growEff);
    body.growthMult = body._growTarget;
    body._growStage = stageOf(body.growthMult);
    body._growRefreshed = body.growthMult;
    body.sizeMultiplier = body.growthMult;
    try { body.refreshBodyAttributes(); } catch { /* */ }
}

// Every raid tick. scoreFor(body) -> raid score (a bot's counts double).
// onStage(body, g, stageIdx) fires when a life grows into a new stage;
// onRefit(body, fresh) after each size step (fresh: a body seen for the
// first time), so the raid can make room in the rock for the bigger hull.
let lastAt = 0;
function tick(t, bodies, scoreFor, onStage, onRefit) {
    if (!enabled()) return;
    const dt = Math.min(250, Math.max(1, t - (lastAt || t)));
    lastAt = t;
    const k = Math.min(1, dt / EASE_MS);
    for (const body of bodies) {
        if (!body || body.isDead?.()) continue;
        let score = scoreFor(body);
        if (score == null) continue;
        score *= scoreMult(body);
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
    RESPAWN_SHARE, RESPAWN_CAP, STAGES, CAP_SCORE,
    BOT_SCORE_MULT, enabled, multFor, spawnEff, scoreMult, onSpawn, tick, applyPerks, stageOf,
    speedMult, healthMult, damageMult, bodyDamageMult, statMult, fovMult, viewMult, mineMult,
    SCALE, GAIN, STAT_AT_100K, VIEW_MAX,
};
