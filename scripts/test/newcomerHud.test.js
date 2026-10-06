// The first raids' HUD: node scripts/test/newcomerHud.test.js
//
//   stage      royale.you.nx -> 0..3; missing, junk or out of range is a
//              veteran (3); dwForceNx wins over the server
//   pieces     what each stage shows: stage 0 the basics and the goal line,
//              stage 1 adds the shop side, the standings and the feed, stage 2
//              the bosses, contracts, bounties, hunted and the Core; the boss
//              and Core cards show early when they're right there, the kit
//              and ability slots when you already hold something
//   filters    toasts, centre plates and the kill feed wait for their stage
//   goal       dig and bank, then upgrade, then the storm; the coach's step
//              wins while it runs
//   intros     one line per piece, once, from its stage, never for veterans
//   director   banners per kind (unknown kinds: their own text, else none),
//              payoffs, the clock math for `left` / `until`
//   death      a tip per cause (bot, player, boss, storm, rock, base, Core,
//              raid end, nothing) and what you kept
//   veterans   stage 3 shows every piece and filters nothing, and the wiring
//              in app.js / coach.js / raidHeat.js / abilityFx.js / socketinit.js
//              only changes anything below stage 3
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const CLIENT = path.join(__dirname, '../../public/client');

let passed = 0;
function t(name, fn) {
    try { fn(); passed++; } catch (e) { console.error('FAIL ' + name); throw e; }
}

(async () => {
    const L = await import(pathToFileURL(path.join(CLIENT, 'newcomerLogic.js')).href);

    // ── stage ─────────────────────────────────────────────────────────
    t('stage: missing or odd values are veterans', () => {
        assert.equal(L.effectiveStage(undefined, null), 3);
        assert.equal(L.effectiveStage(null, null), 3);
        assert.equal(L.effectiveStage('', null), 3);
        assert.equal(L.effectiveStage('abc', null), 3);
        assert.equal(L.effectiveStage(NaN, null), 3);
        assert.equal(L.effectiveStage(9, null), 3);
        assert.equal(L.effectiveStage(-2, null), 0);
        for (const n of [0, 1, 2, 3]) assert.equal(L.effectiveStage(n, null), n);
        assert.equal(L.effectiveStage('1', null), 1);
    });
    t('stage: a forced stage wins', () => {
        assert.equal(L.effectiveStage(3, 0), 0);
        assert.equal(L.effectiveStage(undefined, 2), 2);
        assert.equal(L.effectiveStage(0, null), 0);
    });

    // ── pieces per stage ──────────────────────────────────────────────
    const BASICS = ['clock', 'health', 'wallet', 'storm', 'minimap', 'coach'];
    const STAGE1 = ['standings', 'feed', 'shop', 'ability', 'kit', 'abilityTour', 'raidEvents', 'outposts', 'raidNight', 'cosmetics', 'placeMsgs'];
    const STAGE2 = ['boss', 'contracts', 'bounties', 'hunted', 'core', 'twist', 'streaks', 'revenge'];
    t('stage 0: only the basics and the goal line', () => {
        for (const p of BASICS) assert.ok(L.shows(p, 0), p);
        assert.ok(L.shows('goalLine', 0));
        assert.ok(L.shows('directorMoments', 0));
        for (const p of STAGE1.concat(STAGE2)) assert.ok(!L.shows(p, 0), p);
    });
    t('stage 1: the shop side comes in', () => {
        for (const p of BASICS.concat(STAGE1)) assert.ok(L.shows(p, 1), p);
        for (const p of STAGE2) assert.ok(!L.shows(p, 1), p);
        assert.ok(!L.shows('goalLine', 1));
    });
    t('stage 2: bosses, contracts, bounties, the Core', () => {
        for (const p of BASICS.concat(STAGE1, STAGE2)) assert.ok(L.shows(p, 2), p);
        assert.ok(!L.shows('goalLine', 2));
    });
    t('early pieces: near or owned', () => {
        assert.ok(L.shows('boss', 0, { near: true }));
        assert.ok(L.shows('core', 1, { near: true }));
        assert.ok(!L.shows('contracts', 0, { near: true }));
        assert.ok(L.shows('ability', 0, { owned: true }));
        assert.ok(L.shows('kit', 0, { owned: true }));
        assert.ok(!L.shows('shop', 0, { owned: true }));
    });
    t('unknown pieces always show', () => {
        for (const n of [0, 1, 2, 3]) assert.ok(L.shows('somethingNew', n));
    });

    // ── filters ───────────────────────────────────────────────────────
    t('toasts: critical always, big systems from stage 2', () => {
        assert.ok(L.toastAllowed('Storm closes in 10s', 0));
        assert.ok(L.toastAllowed('The vault is closing', 0));
        assert.ok(!L.toastAllowed('Meteor shower over the north', 0));
        assert.ok(L.toastAllowed('Meteor shower over the north', 1));
        assert.ok(!L.toastAllowed('The Warden has surfaced', 1));
        assert.ok(!L.toastAllowed('Bounty on Alex', 1));
        assert.ok(L.toastAllowed('The Warden has surfaced', 2));
        assert.ok(L.toastAllowed('', 0));
    });
    t('plates: twists, bounties and contracts wait', () => {
        for (const k of ['override', 'bounty', 'contract', 'boss', 'streak', 'revenge', 'shutdown']) {
            assert.ok(!L.calloutAllowed(k, 0), k);
            assert.ok(!L.calloutAllowed(k, 1), k);
            assert.ok(L.calloutAllowed(k, 2), k);
        }
        for (const k of ['chest', 'dropin', 'restored', 'grown', 'mystery']) assert.ok(L.calloutAllowed(k, 0), k);
    });
    t('feed: stage 0 keeps your own lines', () => {
        assert.ok(L.feedAllowed({ name: 'Me', by: 'Bot' }, 0, 'Me'));
        assert.ok(L.feedAllowed({ name: 'Bot', by: 'Me' }, 0, 'Me'));
        assert.ok(!L.feedAllowed({ name: 'A', by: 'B' }, 0, 'Me'));
        assert.ok(!L.feedAllowed({ name: 'A', by: 'B' }, 0, ''));
        assert.ok(L.feedAllowed({ name: 'A', by: 'B' }, 1, 'Me'));
    });

    // ── the goal line ─────────────────────────────────────────────────
    t('goal: dig, then upgrade, then the storm', () => {
        let g = L.goalFor({ bankedRaid: 0, canUpgrade: true });
        assert.equal(g.id, 'dig');
        assert.equal(g.text, 'Dig gems → Bank them at the vault');
        assert.equal(g.arrow, 'vault');
        g = L.goalFor({ bankedRaid: 120, canUpgrade: true });
        assert.equal(g.text, 'Upgrade your tank');
        assert.equal(g.arrow, '');
        g = L.goalFor({ bankedRaid: 120, canUpgrade: false });
        assert.equal(g.text, 'Stay out of the storm');
    });
    t('goal: the coach step wins', () => {
        for (const s of ['move', 'mine', 'bank']) assert.equal(L.goalFor({ coachStep: s, bankedRaid: 500, canUpgrade: false }).id, 'dig');
        assert.equal(L.goalFor({ coachStep: 'upgrade', bankedRaid: 0 }).id, 'upgrade');
        assert.equal(L.goalFor({ coachStep: 'ability', bankedRaid: 0 }).text, 'Try your new ability');
        assert.equal(L.goalFor({ coachStep: 'final', bankedRaid: 10 }).id, 'storm');
        assert.equal(L.goalFor({ coachStep: 'tutorial', bankedRaid: 0 }).id, 'dig');
        assert.equal(L.goalFor(null).id, 'dig');
    });
    t('goal and coach copy: no em dashes', () => {
        for (const v of Object.values(L.GOALS)) assert.ok(!/—/.test(v), v);
        for (const v of Object.values(L.DEATH_TIPS)) assert.ok(!/—/.test(v), v);
        for (const v of Object.values(L.INTROS)) assert.ok(!/—/.test(v.text + (v.touch || '')), v.text);
    });

    // ── intros ────────────────────────────────────────────────────────
    t('intros: from their stage, once, never for veterans', () => {
        assert.equal(L.introText('shop', 0, {}), '');
        assert.ok(L.introText('shop', 1, {}).startsWith('Shops sell'));
        assert.equal(L.introText('shop', 1, { shop: 1 }), '');
        assert.equal(L.introText('boss', 1, {}), '');
        assert.ok(L.introText('boss', 2, {}).length > 10);
        assert.ok(L.introText('core', 2, {}).includes('Core'));
        for (const id of Object.keys(L.INTROS)) assert.equal(L.introText(id, 3, {}), '', id);
        assert.equal(L.introText('nope', 1, {}), '');
        assert.ok(L.introText('ability', 1, {}, { ability: 'E' }).includes('Press E'));
        assert.ok(L.introText('ability', 1, {}, { touch: true }).includes('Tap'));
        assert.ok(L.introText('kit', 1, {}, { kit: 'Z  ,  N' }).includes('Z  ,  N'));
    });

    // ── director moments ──────────────────────────────────────────────
    t('director: banners per kind', () => {
        assert.equal(L.bannerFor({ kind: 'crate' }).title, 'Supply crate incoming!');
        assert.equal(L.bannerFor({ kind: 'supply' }).kind, 'crate');
        assert.equal(L.bannerFor({ kind: 'ore_pocket' }).title, 'Rich vein nearby');
        assert.equal(L.bannerFor({ kind: 'orePocket' }).kind, 'ore');
        assert.equal(L.bannerFor({ kind: 'chest' }).mark, 'CHEST');
        const ab = L.bannerFor({ kind: 'ability' }, { ability: 'Grapple Hook', key: 'Q' });
        assert.equal(ab.title, 'Free ability: Grapple Hook');
        assert.equal(ab.sub, 'Press Q to try it.');
        assert.equal(ab.mark, '');
        assert.ok(L.bannerFor({ kind: 'trial' }, { touch: true }).sub.startsWith('Tap'));
        const tm = L.bannerFor({ kind: 'timed', t: 'Mine 5 rocks' });
        assert.equal(tm.title, 'Mine 5 rocks');
        assert.equal(tm.kind, 'timed');
        assert.equal(L.bannerFor({ kind: 'timed' }).title, 'Quick challenge!');
    });
    t('director: the server contract (newcomerDirector.js)', () => {
        // kinds as the server names them
        assert.equal(L.normKind('trial'), 'ability');
        assert.equal(L.normKind('objective'), 'timed');
        // its title wins, but a trial always says which key
        const tr = L.bannerFor({ kind: 'trial', t: 'Free trial: Grapple Hook', sub: 'Yours for 2 minutes. Give it a go.' }, { key: 'Q' });
        assert.equal(tr.title, 'Free trial: Grapple Hook');
        assert.equal(tr.sub, 'Press Q to try it.');
        const ore = L.bannerFor({ kind: 'ore', t: 'Rich vein nearby', sub: 'Shoot the glowing rocks.' });
        assert.equal(ore.sub, 'Shoot the glowing rocks.');
        const job = L.bannerFor({ kind: 'objective', t: 'Bank 200 gems in 60 seconds', goal: 200, prog: 40 });
        assert.equal(job.title, 'Bank 200 gems in 60 seconds');
        assert.equal(job.mark, 'VAULT');
        assert.equal(L.progressText({ goal: 200, prog: 40 }), '40/200');
        assert.equal(L.progressText({ goal: 200, prog: 260 }), '200/200');
        assert.equal(L.progressText({}), '');
        // how it ended
        assert.equal(L.endState({ state: 'live' }), '');
        assert.equal(L.endState({ state: 'done', done: 1 }), 'done');
        assert.equal(L.endState({ failed: 1 }), 'failed');
        assert.equal(L.endState({ state: 'gone' }), 'gone');
        assert.equal(L.endState({ kind: 'ore' }), '');
        assert.equal(L.endState(null), '');
    });
    t('director: unknown kinds are graceful', () => {
        const a = L.bannerFor({ kind: 'dragon', t: 'Something stirs' });
        assert.equal(a.kind, '');
        assert.equal(a.title, 'Something stirs');
        assert.equal(a.mark, 'LOOK');
        assert.equal(L.bannerFor({ kind: 'dragon' }).title, '');
        assert.equal(L.bannerFor(null).title, '');
        assert.equal(L.bannerFor({}).title, '');
        assert.equal(L.payoffFor({ kind: 'dragon' }).title, 'Nice!');
    });
    t('director: payoffs', () => {
        assert.equal(L.payoffFor({ kind: 'crate' }).title, 'Crate opened!');
        assert.equal(L.payoffFor({ kind: 'ore', r: 250 }).sub, '+250 gems');
        const p = L.payoffFor({ kind: 'timed', r: 100 }, 12300);
        assert.equal(p.title, 'Challenge done!');
        assert.ok(p.sub.includes('+100 gems') && p.sub.includes('13s to spare'));
        assert.equal(L.payoffFor({ kind: 'timed' }, 0).sub, '');
    });
    t('director: the clock', () => {
        // left: ms when the packet came in
        assert.equal(L.leftMs({ left: 30000 }, 1000, 6000, 0), 25000);
        assert.equal(L.leftMs({ left: 3000 }, 1000, 9000, 0), 0);
        // until as a Date.now() time
        assert.equal(L.leftMs({ until: 1.7e12 + 20000 }, 0, 0, 1.7e12), 20000);
        // until as ms from the packet
        assert.equal(L.leftMs({ until: 10000 }, 500, 2500, 0), 8000);
        assert.equal(L.leftMs({}, 0, 0, 0), Infinity);
        assert.equal(L.clock(24000), '0:24');
        assert.equal(L.clock(61000), '1:01');
        assert.equal(L.clock(-5), '0:00');
        assert.equal(L.eventKey({ id: 7, kind: 'ore' }), 'id:7');
        assert.equal(L.eventKey({ kind: 'ore', x: 1.2, y: 2.7, until: 9 }), 'ore|1|3|9');
    });

    // ── the death card ────────────────────────────────────────────────
    t('death: a tip per cause', () => {
        const bots = new Set(['Rusty']);
        const isBot = n => bots.has(n);
        assert.equal(L.deathTip({ cause: 'storm' }), 'The storm got you. Follow the arrow back to the circle.');
        assert.equal(L.deathTip({ killers: ['Rusty'], isBot }), 'Another miner hunted you down. Bank gems before you get too heavy.');
        assert.equal(L.deathKind({ killers: ['Alex'], isBot }), 'player');
        assert.equal(L.deathKind({ killers: ['The Warden'], isBot }), 'boss');
        assert.equal(L.deathKind({ killers: ['Big Thing'], bossName: 'Big Thing' }), 'boss');
        assert.equal(L.deathKind({ cause: 'rock', killers: ['Alex'] }), 'rock');
        assert.equal(L.deathKind({ cause: 'base' }), 'base');
        assert.equal(L.deathKind({ cause: 'core' }), 'core');
        assert.equal(L.deathKind({ cause: 'raidend' }), 'raidend');
        assert.equal(L.deathKind({}), 'none');
        assert.equal(L.deathKind(null), 'none');
        for (const k of ['bot', 'player', 'boss', 'storm', 'rock', 'base', 'core', 'raidend', 'none']) assert.ok(L.DEATH_TIPS[k].length > 20, k);
    });
    t('death: what you kept', () => {
        assert.equal(L.keptLine({ banked: 300, carried: 120, kept: 120 }), 'You kept half your satchel. Your bank is safe too.');
        assert.equal(L.keptLine({ banked: 0, carried: 100, kept: 100 }), 'You kept half your satchel.');
        assert.equal(L.keptLine({ banked: 0, carried: 300, kept: 100 }), 'You kept 100 gems from your satchel.');
        assert.equal(L.keptLine({ banked: 1340, carried: 50, kept: 0 }), 'You kept your 1,340 banked gems. Your satchel dropped.');
        assert.equal(L.keptLine({ banked: 40, carried: 0 }), 'You kept your 40 banked gems.');
        assert.equal(L.keptLine({ banked: 0, carried: 80 }), 'Nothing was banked, so your gems dropped. Bank them next time.');
        assert.equal(L.keptLine({}), 'Nothing lost. Jump back in.');
    });

    // ── veterans ──────────────────────────────────────────────────────
    t('veterans: every piece, nothing filtered', () => {
        for (const p of BASICS.concat(STAGE1, STAGE2)) assert.ok(L.shows(p, 3), p);
        assert.ok(!L.shows('goalLine', 3));
        assert.ok(!L.shows('directorMoments', 3));
        for (const txt of ['Bounty on Alex', 'The Warden has surfaced', 'Meteor shower']) assert.ok(L.toastAllowed(txt, 3));
        for (const k of ['override', 'bounty', 'contract', 'boss', 'streak', 'revenge', 'shutdown', 'quest']) assert.ok(L.calloutAllowed(k, 3));
        assert.ok(L.feedAllowed({ name: 'A', by: 'B' }, 3, 'Me'));
        const table = L.stageTable(3);
        assert.deepEqual(Object.entries(table).filter(([, v]) => !v).map(([k]) => k).sort(), ['directorMoments', 'goalLine']);
    });

    const src = f => fs.readFileSync(path.join(CLIENT, f), 'utf8');
    t('veterans: the wiring only bites below stage 3', () => {
        const app = src('app.js');
        // every gate goes through newcomer.shows / its filters
        assert.ok(/function nxShows\(piece, opts\) \{ return newcomer\.shows\(piece, opts\); \}/.test(app));
        const nc = src('newcomer.js');
        assert.ok(/export function hudNotes[\s\S]{0,120}S\.stage >= L\.VETERAN\) return;/.test(nc), 'notes are off for veterans');
        assert.ok(/export function deathCardWanted\(\) \{ return S\.stage <= 1; \}/.test(nc));
        assert.ok(/if \(S\.stage !== 0\) return true;/.test(nc), 'the shop only waits on stage 0');
        assert.ok(/if \(!inRaid\(\) \|\| S\.stage >= L\.VETERAN\) \{\s*global\.nxBannerUp = false;/.test(nc), 'no director for veterans');
        // the death card switches on deathCardWanted only; the button says
        // Respawn at every stage (round 4: it used to flip mid-session)
        assert.ok(app.includes('if (newcomer.deathCardWanted()) return gameDrawDeadNewcomer();'));
        assert.ok(app.includes('return { ready: true, label: "Respawn" };'));
        // scripts/test/newcomer.test.js reads this one
        assert.ok(app.includes('"Respawn in "'));
        // the server's two callouts get colours, and nothing filters them
        assert.ok(L.calloutAllowed('nxstorm', 0) && L.calloutAllowed('nx', 0));
        assert.ok(src('raidHeat.js').includes('case "nxstorm": return'));
        // other modules: stage 0 needs the server (or a forced) stage
        const coach = src('coach.js');
        assert.ok(coach.includes('const nxEarly = global.nxKnown && (global.nxStage | 0) < 3;'));
        assert.ok(coach.includes('if (id === "ability" && global.nxKnown && (global.nxStage | 0) === 0 && !ownsKit()) return true;'));
        assert.ok(coach.includes('global.nxKnown && (global.nxStage | 0) < 2 ?'));
        const heat = src('raidHeat.js');
        assert.ok(heat.includes('const nx = () => global.nxStage == null ? 3 : global.nxStage;'));
        assert.ok(heat.includes('if (global.nxKnown && nx() === 0) calmHud = true;'));
        assert.ok(src('abilityFx.js').includes('global.nxKnown && global.nxStage === 0'));
        assert.ok(src('socketinit.js').includes('!((global.nxStage | 0) === 0 && global.nxKnown)'));
        // the build treats the new files as frame-loop code
        const build = fs.readFileSync(path.join(__dirname, '../build-client.js'), 'utf8');
        assert.ok(build.includes('"client/newcomer.js"') && build.includes('"client/newcomerLogic.js"'));
    });
    t('hooks: QA and the docs', () => {
        const nc = src('newcomer.js');
        assert.ok(nc.includes('window.dwForceNx = '));
        assert.ok(nc.includes('window.dwNx = '));
        assert.ok(nc.includes('window.dwNxMoment = '));
        assert.ok(!/—/.test(nc + src('newcomerLogic.js')), 'no em dashes');
    });

    console.log('newcomerHud: ' + passed + ' checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
