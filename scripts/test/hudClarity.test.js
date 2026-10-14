// HUD clarity fixes from the 2nd blind playtest: node scripts/test/hudClarity.test.js
//
//   death card   your name + wallet row is not drawn under the raid death card
//                (it leaked "ie", "B", "ender" between the DOM buttons)
//   badges       a BOUNTY / STREAK badge over a HUD panel goes to a ghost
//   kit pointer  the coach's "Your kit" tag sits above the box, tight ring
//   coach card   holds still while the mouse is on or near it
//   colour       a solo player wears one colour through a raid's lives; a new
//                raid picks again; a reload keeps its colour
//   vault        one steady colour (the Banked pill's blue), no cycling hue
//   plates       a raid nameplate shows the standings' points, not hull XP
//   overrides    the popup and card say what an override is
//   kit line     the kit keys read as words ("Z, comma or N")
//   magnet       the base pull reach is a little longer; Ore Magnet still
//                multiplies on top
//   new raid     a new raid on the same page gets a short "FRESH START" card
//                and a "New raid: pick your tank" nudge; a respawn gets none
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const ROOT = path.join(__dirname, '../..');
const CLIENT = path.join(ROOT, 'public/client');
const SERVER = path.join(ROOT, 'server');
const src = (f) => fs.readFileSync(path.join(CLIENT, f), 'utf8');

let passed = 0;
function t(name, fn) {
    try { fn(); passed++; } catch (e) { console.error('FAIL ' + name); throw e; }
}

(async () => {
    const FS = await import(pathToFileURL(path.join(CLIENT, 'firstSecondsLogic.js')).href);
    const NX = await import(pathToFileURL(path.join(CLIENT, 'newcomerLogic.js')).href);
    const app = src('app.js');
    const coach = src('coach.js');

    t('death card: the wallet row steps aside while the card is up', () => {
        assert.ok(/if \(!deathScreenOn\(\)\) drawSelfInfo\(max\);/.test(app));
        const fn = app.slice(app.indexOf('function deathScreenOn()'), app.indexOf('function deathScreenOn()') + 260);
        assert.ok(fn.includes('global.royaleDied') && fn.includes('!global.royaleSpectating'), 'spectating keeps the row');
    });

    t('badges: a badge over a HUD rect is ghosted with labelAlpha', () => {
        const fn = app.slice(app.indexOf('function drawStreakBadge('), app.indexOf('function drawHealth('));
        assert.ok(/labelAlpha\(bx \+ w \/ 2, by \+ h \/ 2, w, h\)/.test(fn));
        // the ability bar is one of the rects
        const av = app.slice(app.indexOf('function hudAvoidRects()'), app.indexOf('function hudAvoidRects()') + 1400);
        assert.ok(av.includes('abilityBarRect'));
    });

    t('coach: no kit or ability step, only move, mine, bank and upgrade', () => {
        assert.ok(!/hudRect\("kit"\)/.test(coach));
        assert.ok(!/"Your kit"/.test(coach));
    });

    t('coach card: holds its place while the mouse is near', () => {
        assert.ok(/const hold = st\.top > 0 && top !== st\.top && !global\.mobile && ptrNear\(st\.top, w, h\);/.test(coach));
        assert.ok(/if \(hold\) top = st\.top;/.test(coach));
        assert.ok(coach.includes('addEventListener("pointermove"'));
    });

    t('colour: one colour per raid for a solo player', () => {
        global.royaleTeamColors = new Map();
        let n = 0;
        const palette = [10, 12, 11, 14, 2];
        global.assignTeamColor = (team) => { const c = palette[n++ % palette.length]; global.royaleTeamColors.set(team, c); return c; };
        const { colorFor } = require(path.join(SERVER, 'game/terrain/soloColor.js'));
        const sock = {};
        const c1 = colorFor(sock, -301, 7, null);
        const c2 = colorFor(sock, -302, 7, null);
        const c3 = colorFor(sock, -303, 7, null);
        assert.equal(c2, c1); assert.equal(c3, c1);
        assert.equal(global.royaleTeamColors.get(-303), c1, 'the new team id carries the colour');
        // a new raid picks again
        const c4 = colorFor(sock, -304, 8, null);
        assert.notEqual(c4, c1);
        // a reload's kept colour wins
        assert.equal(colorFor(sock, -305, 8, { team: -305, color: 13 }), 13);
        assert.equal(colorFor(sock, -306, 8, null), 13);
        // no raid id (duos path): no memory
        const other = {};
        const d1 = colorFor(other, -400, 0, null), d2 = colorFor(other, -401, 0, null);
        assert.notEqual(d1, d2);
        assert.equal(other._raidColor, undefined);
        const sk = fs.readFileSync(path.join(SERVER, 'game/network/sockets.js'), 'utf8');
        assert.ok(/soloColor\.js'\)\.colorFor\(socket, team, rid, kept\)/.test(sk));
        const dr = fs.readFileSync(path.join(SERVER, 'game/gamemodes/scripts/dig_royale.js'), 'utf8');
        assert.ok(/raidIdNow: \(\) => raidId/.test(dr));
    });

    t('vault: one steady colour, no cycling hue', () => {
        const fn = app.slice(app.indexOf('function drawVaults('), app.indexOf('function drawVaults(') + 3000);
        assert.ok(!/hsvCss\(|hsvRgb\(/.test(fn), 'drawVaults still cycles a hue');
        assert.ok(/rainbow \? BANK_PILL/.test(fn));
        assert.ok(/royaleActive\(\) && !v\.isOutpost\) \? BANK_PILL : HUD\.gold/.test(app), 'the deposit bar matches');
    });

    t('plates: raid nameplates read the standings', () => {
        assert.ok(/royaleActive\(\) \? boardScoreLabel\(instance\.id\)/.test(app));
        const fn = app.slice(app.indexOf('function boardScoreLabel('), app.indexOf('function boardScoreLabel(') + 600);
        assert.ok(fn.includes('fmtNum(') && fn.includes('if (board !== boardLabelSrc)'), 'same format as the standings, rebuilt per board');
    });

    t('overrides: the popup and card say what an override is', () => {
        assert.equal(NX.modCalloutSub('Bosses show up twice as often.'), "This raid's special rule: Bosses show up twice as often.");
        assert.ok(NX.modCalloutSub('').length > 10);
        // round 9: a mid-raid change is a small message, the card says the rest
        assert.ok(src('socketinit.js').includes('"New raid rule: " + String(r.mod.name) + ". " + modCalloutSub(r.mod.desc)'));
        assert.ok(app.includes('"Override (raid rule)"') && app.includes('drawText("Raid rule"'));
        assert.ok(/Override, a special rule/.test(NX.introText('twist', 2, {})));
    });

    t('kit line: keys as words', () => {
        assert.equal(NX.kitKeysText(['Z', ',', 'N']), 'Z, comma or N');
        assert.equal(NX.kitKeysText(['X']), 'X');
        assert.equal(NX.kitKeysText([]), '');
        const line = NX.introText('kit', 1, {}, { kit: NX.kitKeysText(['Z', ',', 'N']) });
        assert.ok(line.includes('Z, comma or N') && line.includes('one-use'), line);
        assert.ok(!src('newcomer.js').includes('NEW FEATURE'), 'the in-raid NEW FEATURE intros are gone');
    });

    t('magnet: a small base bump, Ore Magnet on top', () => {
        const gs = fs.readFileSync(path.join(SERVER, 'game/terrain/gems.js'), 'utf8');
        const reach = +(/const MAGNET_REACH = (\d+);/.exec(gs) || [])[1];
        assert.ok(reach > 110 && reach <= 150, 'base reach ' + reach);
        assert.ok(/best\.realSize \* 2\.6 \+ MAGNET_REACH\) \* \(bias \? 1\.45 : 1\) \* magBoost/.test(gs));
        // the repel bubbles keep their old size
        assert.ok(/const MAGNET_BONUS = 110;/.test(gs));
        // the Gem Magnet ring on the client mirrors it
        assert.ok(src('abilityFx.js').includes('* 2.6 + ' + reach + ') * MAGNET_MULT'));
        // Ore Magnet still +40% a stack
        const rp = fs.readFileSync(path.join(SERVER, 'game/terrain/raidPerks.js'), 'utf8');
        assert.ok(/magnet: 1 \+ 0\.4 \* n\('magnet'\)/.test(rp));
    });

    t('new raid: a short card and a tank nudge; respawns get none', () => {
        assert.equal(FS.isNewRaid(0, 5), false);
        assert.equal(FS.isNewRaid(5, 5), false);
        assert.equal(FS.isNewRaid(5, 0), false);
        assert.equal(FS.isNewRaid(5, 6), true);
        const p = FS.planFor({ newRaid: true, newcomer: true });
        assert.equal(p.newRaid, true);
        // Oct 8: a veteran's new raid gets the card but no pointers
        assert.equal(FS.planFor({ newRaid: true }).nudge, 0);
        assert.equal(FS.nudgeAlpha(FS.planFor({ newRaid: true }), FS.planFor({ newRaid: true }).intro + 600, 'tiles', false), 0);
        assert.equal(FS.planFor({ newRaid: true, tutorial: true }), null);
        // tiles and stats come in on landing; the toasts wait a moment and the
        // tank pointer waits for the card (calmer raid start)
        assert.ok(FS.shows(p, 10, 'tiles', false) && FS.shows(p, 10, 'stats', false));
        assert.ok(!FS.shows(p, 10, 'messages', false) && FS.shows(p, p.messages, 'messages', false));
        assert.ok(!FS.shows(p, -1, 'tiles', false), 'not while still falling');
        assert.equal(FS.nudgeAlpha(p, 600, 'tiles', false), 0, 'no pointer under the card');
        assert.ok(FS.nudgeAlpha(p, p.intro + 600, 'tiles', false) > 0.5);
        assert.ok(FS.introAlpha(p, 1000) > 0.9 && FS.introAlpha(p, p.intro + 1) === 0);
        assert.equal(FS.nudgeText(p, 'tiles'), 'New raid: pick your tank');
        assert.equal(FS.nudgeText(FS.planFor({ newcomer: true }), 'tiles'), 'You can pick a new tank any time');
        const ln = FS.introLines({ newRaid: true, points: 50, tanks: 9, leftMs: 600000 });
        assert.equal(ln.eyebrow, 'NEW RAID');
        assert.ok(ln.goal.includes('Basic') && ln.goal.includes('50 points'), ln.goal);
        assert.ok(ln.status.includes('9 tanks'));
        assert.ok(!/—/.test(JSON.stringify(ln)), 'no em dashes');
        const fsj = src('firstSeconds.js');
        assert.ok(fsj.includes('L.isNewRaid(S.raid, rid, S.alive ? 0 : S.raidStart, start)') && fsj.includes('L.planFor({ newRaid: true, recap: missed, newcomer: isNew(), ao: !!global.aoWorld })'), 'a new raid card (after the last raid\'s recap when its podium was missed)');
        assert.ok(fsj.includes('!S.plan.newRaid'), 'the falling re-plan keeps the new raid card');
    });

    console.log('hudClarity: ' + passed + ' checks passed');
})().catch(e => { console.error(e); process.exit(1); });
