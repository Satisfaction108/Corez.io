// The first seconds of a raid: node scripts/test/firstSeconds.test.js
//
//   plan       someone new gets the raid card, then messages, tank tiles,
//              stat bars, the ability slam and the guide card one after
//              another; someone who has played before gets a short card and
//              nothing held; the tutorial gets nothing
//   gates      nothing new shows while the drop is still falling; a hit lets
//              everything in at once; no plan = everything shows
//   card       fades in and out, the lines (goal, controls, who's in) and the
//              ram wording for a hull with no guns
//   shop       with nothing banked the shop says how to get gems there
//   no "bot"   nothing the player reads calls an opponent a bot
//   listing    the menu's raid rows never read under the 4 tanks you meet;
//              other rows and the raw counts stay true
//   wiring     app.js / coach.js / juice.js / abilityFx.js / build
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const ROOT = path.join(__dirname, '../..');
const CLIENT = path.join(ROOT, 'public/client');
const src = (f) => fs.readFileSync(path.join(CLIENT, f), 'utf8');

let passed = 0;
function t(name, fn) {
    try { fn(); passed++; } catch (e) { console.error('FAIL ' + name); throw e; }
}

(async () => {
    const L = await import(pathToFileURL(path.join(CLIENT, 'firstSecondsLogic.js')).href);

    // ── plan ───────────────────────────────────────────────────────────
    t('plan: someone new gets the HUD one piece at a time', () => {
        const p = L.planFor({ newcomer: true });
        assert.ok(p.newcomer);
        // the card first, then the rest in order, all inside ~9 s
        assert.ok(p.intro >= 5000 && p.intro <= 6500, "round 8: about 65% longer than 3.4 s");
        assert.ok(p.messages <= p.intro);
        assert.ok(p.intro <= p.tiles && p.tiles < p.stats && p.stats < p.ability && p.ability < p.coach);
        assert.ok(p.coach <= 9500, 'the guide card is not held long');
        // nothing new while the card is up
        for (const piece of ['tiles', 'stats', 'ability', 'coach']) {
            assert.equal(L.shows(p, 0, piece, false), false, piece + ' at landing');
            assert.equal(L.shows(p, p.intro - 1, piece, false), false, piece + ' under the card');
        }
        assert.equal(L.shows(p, p.tiles, 'tiles', false), true);
        assert.equal(L.shows(p, p.tiles, 'stats', false), false);
        assert.equal(L.shows(p, p.stats, 'stats', false), true);
        assert.equal(L.shows(p, p.coach, 'coach', false), true);
        for (const piece of L.PIECES) assert.equal(L.shows(p, 20000, piece, false), true, piece + ' later');
    });
    t('plan: returning players get a short card and nothing held', () => {
        const p = L.planFor({ newcomer: false });
        assert.ok(!p.newcomer);
        assert.ok(p.intro > 0 && p.intro <= 4000);
        for (const piece of ['messages', 'tiles', 'stats', 'coach']) {
            assert.equal(L.shows(p, -1, piece, false), true, piece + ' while falling');
            assert.equal(L.shows(p, 0, piece, false), true, piece);
        }
        // only the slam lane waits for the card
        assert.equal(L.shows(p, 100, 'ability', false), false);
        assert.equal(L.shows(p, p.intro, 'ability', false), true);
        assert.equal(L.nudgeAlpha(p, 100, 'tiles', false), 0, 'no nudges');
    });
    t('plan: the tutorial and later lives get none', () => {
        assert.equal(L.planFor({ tutorial: true, newcomer: true }), null);
        for (const piece of L.PIECES) assert.equal(L.shows(null, 0, piece, false), true);
        assert.equal(L.introAlpha(null, 500), 0);
    });

    // ── gates ──────────────────────────────────────────────────────────
    t('gates: falling holds, a hit lets everything in', () => {
        const p = L.planFor({ newcomer: true });
        for (const piece of L.PIECES) {
            assert.equal(L.shows(p, -1, piece, false), false, piece + ' falling');
            assert.equal(L.shows(p, 100, piece, true), true, piece + ' released');
        }
        assert.equal(L.waitFor(p, 1000, 'ability', false), p.ability - 1000);
        assert.equal(L.waitFor(p, 1000, 'ability', true), 0);
        assert.equal(L.waitFor(p, p.ability + 5, 'ability', false), 0);
    });

    // ── the card ───────────────────────────────────────────────────────
    t('card: fades in on landing, out at the end, fast on a hit', () => {
        const p = L.planFor({ newcomer: true });
        assert.equal(L.introAlpha(p, -1), 0);
        assert.ok(L.introAlpha(p, 30) < 0.3);
        assert.equal(L.introAlpha(p, 1500), 1);
        assert.ok(L.introAlpha(p, p.intro - 100) < 0.5);
        assert.equal(L.introAlpha(p, p.intro), 0);
        assert.ok(L.introAlpha(p, 1500, 125) < 0.6);
        assert.equal(L.introAlpha(p, 1500, 300), 0);
    });
    t('card: goal, controls and who is in', () => {
        const d = L.introLines({ keys: 'WASD', tanks: 9, leftMs: 462000, twist: 'Low Gravity' });
        assert.equal(d.title, 'DIG. BANK. WIN.');
        assert.match(d.goal, /colored rocks/);
        assert.match(d.goal, /vault/);
        assert.match(d.controls, /^WASD to move/);
        assert.equal(d.status, '9 tanks in this raid  ·  7:42 left  ·  Twist: Low Gravity');
        const m = L.introLines({ mobile: true, tanks: 1 });
        assert.match(m.controls, /thumb/);
        assert.equal(m.status, '');
        assert.match(L.introLines({ gunless: true }).goal, /^Ram/);
        for (const v of Object.values(d).concat(Object.values(m))) assert.ok(!/—/.test(v) && !/\bbots?\b/i.test(v), v);
    });
    t('tiles: a hull without guns digs by ramming', () => {
        assert.equal(L.minesBy(0), 'ram');
        assert.equal(L.minesBy(undefined), 'ram');
        assert.equal(L.minesBy(2), 'gun');
    });
    t('nudges: beside a piece for a moment after it comes in', () => {
        const p = L.planFor({ newcomer: true });
        assert.equal(L.nudgeAlpha(p, p.tiles - 1, 'tiles', false), 0);
        assert.ok(L.nudgeAlpha(p, p.tiles + 1000, 'tiles', false) > 0.9);
        assert.equal(L.nudgeAlpha(p, p.tiles + p.nudge + 1, 'tiles', false), 0);
        assert.equal(L.nudgeAlpha(p, p.tiles + 1000, 'tiles', true), 0, 'not after a hit');
    });

    // ── the shop ───────────────────────────────────────────────────────
    t('shop: nothing banked says how to get there', () => {
        const none = L.shopHint({ banked: 0, carried: 0, cheapest: 300 });
        assert.match(none.text, /bank them at a vault/);
        const carry = L.shopHint({ banked: 0, carried: 420, cheapest: 300 });
        assert.match(carry.text, /You carry 420 gems/);
        const near = L.shopHint({ banked: 180, carried: 0, cheapest: 300 });
        assert.match(near.text, /Bank 120 more/);
        assert.equal(L.shopHint({ banked: 300, carried: 0, cheapest: 300 }), null);
        assert.equal(L.shopHint({ banked: 5000, carried: 10, cheapest: 300 }), null);
        assert.match(L.shopHint({ banked: 0, carried: 2500, cheapest: 300 }).text, /2,500/);
    });

    // ── no "bot" in front of players ───────────────────────────────────
    const NL = await import(pathToFileURL(path.join(CLIENT, 'newcomerLogic.js')).href);
    t('no bot talk: death tips, duo panel, tutorial, quests, achievements', () => {
        for (const v of Object.values(NL.DEATH_TIPS)) assert.ok(!/\bbots?\b/i.test(v), v);
        const app = src('app.js');
        assert.ok(!app.includes('drawText("BOT"'), 'no BOT tag on a teammate');
        assert.ok(!/Matching you with a bot|A bot will partner/.test(app));
        assert.ok(!/with a bot/.test(src('tutorial.js')));
        assert.ok(!/bots count/i.test(fs.readFileSync(path.join(ROOT, 'server/accounts/quests.js'), 'utf8')));
        const ach = fs.readFileSync(path.join(ROOT, 'shared/achievements.js'), 'utf8');
        for (const line of ach.split('\n').filter(l => /^\s*A\(/.test(l))) {
            const m = line.match(/A\('[^']*',\s*'[^']*',\s*'([^']*)',\s*'([^']*)'/);
            if (m) assert.ok(!/\bbots?\b/i.test(m[1] + ' ' + m[2]), line.trim());
        }
        assert.ok(!/\bbots?\b/i.test(src('coach.js').match(/function content[\s\S]*?\n}\n/)[0].replace(/\/\/.*$/gm, '')));
    });

    // ── the menu's online number ───────────────────────────────────────
    t('listing: raid rows never under the 4 tanks you meet', () => {
        const { listedPlayers, RAID_FLOOR } = require(path.join(ROOT, 'server/lib/listedPlayers.js'));
        assert.equal(RAID_FLOOR, 4);
        assert.equal(listedPlayers({ mode: 'solo', players: 0 }), 4);
        assert.equal(listedPlayers({ mode: 'duo', players: 2 }), 4);
        assert.equal(listedPlayers({ mode: 'solo', players: 11 }), 11);
        assert.equal(listedPlayers({ mode: undefined, players: 0 }), 0, 'other servers stay true');
        assert.equal(listedPlayers(null), 0);
        const server = fs.readFileSync(path.join(ROOT, 'server/server.js'), 'utf8');
        assert.ok(server.includes('players: listedPlayers({ mode, players: '), 'getServers uses it');
        // the admin side reads the raw numbers
        const cmds = fs.readFileSync(path.join(ROOT, 'server/accounts/discord/commands.js'), 'utf8');
        assert.ok(!cmds.includes('listedPlayers'));
    });

    // ── wiring ─────────────────────────────────────────────────────────
    t('wiring: app.js, coach.js, juice.js, abilityFx.js, the build', () => {
        const app = src('app.js');
        assert.ok(app.includes('try { firstSeconds.tick(); }'));
        assert.ok(app.includes('try { firstSeconds.draw(ctx[2], lanes); }'));
        assert.ok(app.includes('statMenu.set(!firstSeconds.shows("stats") ? 0 :'));
        assert.ok(app.includes('if (gui.upgrades.length > 0 && !firstSeconds.shows("tiles")) {'));
        assert.ok(app.includes('if (!firstSeconds.shows("messages") || (global.mobile && (slamShowing() || global.introCardUp))) {'));
        assert.ok(app.includes('shopHint({ banked: global.gems.banked | 0'));
        assert.ok(app.includes('hudTitle("RAMS ROCK"'));
        const coach = src('coach.js');
        assert.ok(coach.includes('if (global.introHold) return true;'));
        assert.ok(coach.includes('"Ram rocks. Grab the gems."'));
        const juice = src('juice.js');
        assert.ok(juice.includes('export function setIntroHold(fn)'));
        assert.ok(juice.includes('Math.max(dropHold(), introHold())'));
        const fsGlue = src('firstSeconds.js');
        assert.ok(fsGlue.includes('juice.setIntroHold(slamHoldUntil)'));
        assert.ok(fsGlue.includes('window.dwFirstSec = '));
        const ab = src('abilityFx.js');
        assert.ok(ab.includes('"Click to " + verb + " " + shortName(id)'));
        assert.ok(ab.includes('"Right click, Esc or " + key + " to cancel"'));
        const build = fs.readFileSync(path.join(ROOT, 'scripts/build-client.js'), 'utf8');
        assert.ok(build.includes('"client/firstSeconds.js"') && build.includes('"client/firstSecondsLogic.js"'));
        const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
        assert.ok(html.includes('class="hero-tag"'));
        assert.ok(html.includes('src="/img/logo.svg"'), 'logo untouched');
        assert.ok(html.includes('Developed by <b>ZyroX</b>'), 'credits kept');
        for (const f of ['firstSeconds.js', 'firstSecondsLogic.js']) assert.ok(!/—/.test(src(f)), f + ': no em dashes');
    });

    console.log('firstSeconds: ' + passed + ' checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
