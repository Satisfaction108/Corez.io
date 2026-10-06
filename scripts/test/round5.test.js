// Blind playtest round 4 fixes: node scripts/test/round5.test.js
//
//   crown bank  a crown banks in the final minute (it used to be refused,
//               and a 1,770 satchel dropped at the bell); the vault banks it
//               at once and won't hide it (pushed off right after, 10 s max)
//   crown moment getting a crown is a must-see slam with its reason (top 3,
//               taken, fell, left, free), the queue never drops or cuts it
//               short, the crown pops onto your tank, the card says how
//   bank pops   every rise of the Bank says what paid ("+300 banked ·
//               survived the bounty"); payGems sends the label first
//   two banks   the HUD's spendable "Bank" vs "Banked this raid" (points)
//   death card  the header and the "Points: X" line read one number
//   bounty tag  never "+300" on your own tank (BOUNTY ON YOU), baked at the
//               size drawn
//   crate       "next to you" only when it is
//   labels      the Vault label lifts over your tank; no storm plate over the
//               tanks' tags while the storm row says it
//   results     Keep results up: the podium stays over the next raid until a
//               click / Esc / 45 s
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const REPO = path.join(__dirname, '..', '..');
const SERVER = path.join(REPO, 'server');
const CLIENT = path.join(REPO, 'public', 'client');
const src = (f) => fs.readFileSync(path.join(CLIENT, f), 'utf8');
const ssrc = (f) => fs.readFileSync(path.join(SERVER, f), 'utf8');
const imp = (f) => import(pathToFileURL(path.join(CLIENT, f)).href);

global.Config = Object.assign(global.Config || {}, { dig_royale: true });
const crowns = require(path.join(SERVER, 'game', 'terrain', 'crowns.js'));
const vault = require(path.join(SERVER, 'game', 'terrain', 'vault.js'));

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// a contest with fake hooks: three tanks and one human socket
function contest() {
    crowns.newRaid();
    const said = [];
    // (every tank has a socket here, so every callout is heard)
    const mk = (id, name, score, human) => ({ id, name, score, isPlayer: !!human, isBot: !human, socket: {}, isDead: () => false });
    const a = mk(1, 'ender', 900, true), b = mk(2, 'kai', 5000), c = mk(3, 'mason', 3000), d = mk(4, 'tunnel10', 400);
    const all = [a, b, c, d];
    let left = 120_000;
    crowns.attach({
        keyOf: (x) => 'k' + x.id, scoreOf: (x) => x.score, riskOf: (x) => x.score, fighters: () => all.filter(x => !x.gone),
        isFinal: () => true, leftMs: () => left, live: () => true, clients: () => [],
        callout: (body, kind, text, pts, sub) => said.push({ to: body.name, kind, text, sub }),
        feed: () => {}, fxAt: () => {}, award: (x, n) => { x.score += n; }, move: (f, t, n) => { f.score -= n; t.score += n; },
    });
    return { a, b, c, d, all, said, setLeft: (ms) => { left = ms; } };
}

test('crown bank: a final-minute crown banks; the vault banks it at once and will not hide it', () => {
    const { a, b, c, said, setLeft } = contest();
    crowns.tick(Date.now());
    assert.ok(crowns.isCrowned(b) && crowns.isCrowned(c) && crowns.isCrowned(a), 'top 3 crowned');
    assert.equal(crowns.howOf(b).how, 'top3');
    setLeft(50_000);
    crowns.tick(Date.now() + 300);
    assert.equal(crowns.suddenOn(), true);
    assert.equal(b.crownLocked, true);
    assert.equal(crowns.BANK_IN_SD, true);
    assert.equal(crowns.bankBlocked(b), null, 'no refusal');
    const sd = said.filter(s => s.kind === 'suddendeath' && s.to === 'kai').pop();
    assert.ok(sd && /still bank/.test(sd.sub) && /pushes a crown off/.test(sd.sub), 'the vault rule, said at the final minute: ' + (sd && sd.sub));
    // the vault: no panel work, pushed off right after, never longer than CROWN_PAD_MS
    assert.equal(vault.campLimitMs({ crownLocked: true, carriedGems: 1770 }), vault.CROWN_IDLE_MS);
    assert.equal(vault.campLimitMs({ crownLocked: true, carriedGems: 0 }), vault.CROWN_IDLE_MS);
    // (Oct 5 2026: every stay limit doubled, 1.5 s -> 3 s and 10 s -> 20 s)
    assert.equal(vault.CROWN_IDLE_MS, 3000);
    assert.equal(vault.CROWN_PAD_MS, 20_000);
    const v = ssrc('game/terrain/vault.js');
    assert.match(v, /if \(!body\.crownLocked\) return false;/, 'only a crown auto-banks (bot or human)');
    assert.match(v, /now - body\._vaultPadSince > CROWN_PAD_MS/, 'and is pushed off after CROWN_PAD_MS');
    assert.ok(!/if \(body\.crownLocked\) \{ cancelDeposit/.test(v), 'a deposit is never cancelled for the crown');
    // the crown card and notes say so, not "can't bank"
    const cl = src('crownsLogic.js') + src('scoreLogic.js');
    assert.ok(!/can't bank/i.test(cl.replace(/\/\/.*$/gm, '')), "no \"can't bank\" left in the words");
});

test('crown moment: every way a crown reaches you has a reason', async () => {
    const { a, b, c, d, said, all } = contest();
    crowns.tick(Date.now());
    const top = said.filter(s => s.kind === 'crowned' && s.to === 'ender').pop();
    assert.ok(/You're top 3/.test(top.sub), top.sub);
    // a storm death: the crown falls to the best uncrowned tank, with whose it was
    b.gone = true;
    crowns.onDeath(b, null, Date.now() + 500);
    assert.equal(crowns.isCrowned(d), true);
    assert.deepEqual(crowns.howOf(d), { how: 'fell', from: 'kai' });
    assert.ok(/Its holder kai died/.test(said.filter(s => s.kind === 'crowned' && s.to === 'tunnel10').pop().sub));
    // a steal: the killer's crown says whose it took
    const e = { id: 9, name: 'justvibing17', score: 100, isPlayer: true, socket: {}, isDead: () => false };
    all.push(e);
    crowns.onDeath(c, e, Date.now() + 900);
    assert.deepEqual(crowns.howOf(e), { how: 'steal', from: 'mason' });
    // the client's words for each
    const CL = await imp('crownsLogic.js');
    assert.equal(CL.howLine({ how: 'top3' }).sub, "You're top 3 on points.");
    assert.equal(CL.howLine({ how: 'fell', from: 'kai' }).sub, 'Its holder kai went down.');
    assert.equal(CL.howLine({ how: 'steal', from: 'kai' }).sub, "You took kai's crown.");
    assert.equal(CL.howLine({ how: 'left', from: 'kai' }).title, 'A CROWN FELL TO YOU');
    assert.equal(CL.howLine({}).card, 'CROWN: IT WAS FREE');
    // RY you.crown carries how / from
    const dr = ssrc('game/gamemodes/scripts/dig_royale.js');
    assert.match(dr, /how: hw\.how \|\| undefined, from: hw\.from \|\| undefined/);
    void a;
});

test('crown moment: the must-see slam jumps the queue, is never dropped, and stays its keep time', async () => {
    // juice.js with its two app imports stubbed
    const T = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-round5-juice-'));
    for (const f of ['juice.js', 'juiceMath.js']) fs.copyFileSync(path.join(CLIENT, f), path.join(T, f));
    fs.writeFileSync(path.join(T, 'global.js'), 'export const global = {};\n');
    fs.writeFileSync(path.join(T, 'config.js'), 'export const config = { graphical: {} };\n');
    fs.writeFileSync(path.join(T, 'package.json'), '{"type":"module"}\n');
    globalThis.window = globalThis.window || {};
    let now = 1000;
    const realNow = performance.now.bind(performance);
    performance.now = () => now;
    try {
        const J = await import(pathToFileURL(path.join(T, 'juice.js')).href);
        const shown = [];
        J.init({ hudTitle: (t) => shown.push(t), drawText: () => {} });
        const frame = () => J.drawSlams({}, 0, 0, 1);
        J.slam('STORM CLOSING', '', null, 2600);
        frame();
        J.slam('BOSS', '', null, 2600); J.slam('ONE', '', null, 2600);
        const m = J.slamMust('YOU GOT A CROWN', 'reason', '#f2b83c', 4600, 64, 2800);
        // three more ordinary words: the queue is full, the crown stays
        J.slam('TWO'); J.slam('THREE'); J.slam('FOUR');
        assert.ok(J.slamState().wait.includes('YOU GOT A CROWN'), JSON.stringify(J.slamState()));
        assert.equal(J.slamState().wait[0], 'YOU GOT A CROWN', 'first in line');
        // the word up wraps up; the crown comes up and holds its keep time
        for (let t = 0; t < 1200; t += 50) { now += 50; frame(); }
        assert.equal(J.slamState().up, 'YOU GOT A CROWN');
        const upAt = m.born;
        assert.ok(upAt > 0);
        J.slamFirst('ELIMINATED', 'jaxon', '#fff', 2400, 66);
        for (let t = 0; t < 2600; t += 50) { now += 50; frame(); if (J.slamState().up !== 'YOU GOT A CROWN') break; }
        assert.ok(now - upAt >= 2700, 'kept up ' + (now - upAt) + ' ms with a kill waiting');
        assert.equal(J.slamSeen(m), true);
        // a same-first-word slam never replaces it
        assert.ok(!/^!?YOU /.test(J.slamState().up) || J.slamState().up === 'YOU GOT A CROWN');
    } finally {
        performance.now = realNow;
        fs.rmSync(T, { recursive: true, force: true });
    }
    const cr = src('crowns.js');
    assert.match(cr, /S\.slam = juice\.slamMust\(text, sub, GOLD, dur \|\| 4200, 64, 2800\)/);
    assert.match(cr, /if \(has && !S\.hadMine\) S\.popAt = performance\.now\(\)/, 'the pop starts when the crown lands on your tank');
    assert.match(cr, /const title = age < HOW_MS && S\.mine \? CL\.howLine\(S\.mine\)\.card : card\.title/);
});

test('bank pops: every Bank rise has a label, deposits stay quiet, purchases say spent', async () => {
    const B = await imp('bankPopLogic.js');
    const st = B.create();
    assert.equal(B.onBanked(st, 138, 0, {}), null, 'the first packet only records');
    // the server's label comes first (payGems), then the rise
    B.label(st, 300, 'survived the bounty', 10);
    assert.equal(B.onBanked(st, 438, 20, {}).str, '+300 banked · survived the bounty');
    // a contract and an unexplained 40 in one rise
    B.label(st, 250, 'contract: Open the epic chest', 30);
    const p = B.onBanked(st, 728, 40, {});
    assert.equal(p.str, '+40 banked');
    assert.deepEqual(st.pops.map(x => x.str), ['+300 banked · survived the bounty', '+250 banked · contract: Open the epic chest', '+40 banked']);
    // a deposit is the BANKED slam's job
    assert.equal(B.onBanked(st, 1028, 50, { deposit: true }), null);
    // a label that arrives late names the plain pop already up
    B.onBanked(st, 1128, 100, {});
    B.label(st, 100, 'the Core', 400);
    assert.equal(st.pops[st.pops.length - 1].str, '+100 banked · the Core');
    // spending at a shop
    assert.equal(B.onBanked(st, 828, 600, { spent: true }).str, '-300 spent');
    assert.equal(B.onBanked(st, 700, 700, {}), null, 'a drop elsewhere (savings lost at death) is not a purchase');
    // stale labels never pin a later rise
    B.label(st, 50, 'old', 1000);
    assert.equal(B.onBanked(st, 750, 1000 + B.LABEL_MS + 10, {}).str, '+50 banked');
    assert.equal(B.live(st, 1e9).length, 0);
    assert.ok(st.pops.length <= B.MAX_POPS);
    // the server: payGems labels every payout and talks before the GEM packet
    const dr = ssrc('game/gamemodes/scripts/dig_royale.js');
    assert.match(dr, /body\.socket\.talk\('KC', 'bankpop', payLabel\(why\), gemsN \| 0\);\s*\} catch \{ \/\* \*\/ \}\s*gems\.talkGems\(body, 0\);/);
    assert.match(dr, /payGems\(killerBody, huntBounty\.gems, 'hunt'\)/);
    assert.match(dr, /payGems\(killerBody, contracts\.REVENGE_GEMS, 'revenge'\)/);
    assert.match(ssrc('game/terrain/contracts.js'), /hooks\.pay\(body, c\.reward, "contract: " \+/);
    assert.match(ssrc('game/terrain/newcomerDirector.js'), /hooks\.pay\(body, ev\.reward, "challenge done"\)/);
    // the client: labels never become plates, every GEM rise is checked
    const si = src('socketinit.js');
    assert.match(si, /if \(m\[0\] === "bankpop"\) \{[\s\S]{0,500}bankPops\.label\(/);
    assert.match(si, /bankPops\.onBanked\(global\.bankPops/);
    assert.match(si, /"milestone " \+ util\.formatLargeNumber\(at\)/);
    const app = src('app.js');
    assert.match(app, /drawBankPops\((\(bankX1 \+ rx2\) \/ 2|global\.screenWidth \/ 2), (ry - pillH \/ 2 - 8|Math\.round\(y - 10 - 4\) - 1 - 30)\)/);
    assert.ok(fs.readFileSync(path.join(REPO, 'scripts', 'build-client.js'), 'utf8').includes('"client/bankPopLogic.js"'), 'light build profile');
});

test('two banks: the HUD says Bank (spendable), the card and results say Banked this raid', async () => {
    const SL = await imp('scoreLogic.js');
    assert.equal(SL.BANK, 'Spendable');
    assert.equal(SL.BANKED_RAID, 'Banked this raid');
    assert.match(SL.BANK_TIP_BODY, /never your points/);
    assert.equal(SL.tiles({ pts: { b: 1997, k: 90, c: 0 } })[0][0], 'BANKED THIS RAID');
    const app = src('app.js');
    assert.match(app, /const BL = scoreText\.BANK \+ ": ";/);
    assert.ok(!/\["Banked: " \+ util\.formatLargeNumber\(banked\)/.test(app), 'the pill no longer says Banked');
    assert.match(app, /drawText\(scoreText\.BANK \+ "  " \+ util\.formatLargeNumber\(g\.banked \| 0\)/, 'vault panel');
    assert.match(app, /hudTitle\(scoreText\.BANK, bx2 - 8/, 'shop panel');
    assert.match(app, /queueTip\(scoreText\.BANK_TIP, scoreText\.BANK_TIP_BODY/);
    assert.match(src('raidFinale.js'), /const CELL_LABEL = \["POINTS", "BANKED THIS RAID", "KILLS \+ CROWNS"\]/);
});

test('death card: the header and the Points line are one number, after the loss', async () => {
    const SL = await imp('scoreLogic.js');
    const you = { score: 3539, pts: { b: 2992, k: 175, c: 372 }, dl: { p: 230, by: 'justvibing17', cr: 1 } };
    assert.equal(SL.cardPoints(you), 3539);
    assert.equal(SL.deathLine(you, 272).head, 'Points: 3,539');
    assert.equal(SL.deathLine(you, 272).lost, 'lost 230: justvibing17 took your crown');
    // whatever the parts say, the line follows the header
    assert.equal(SL.deathLine({ score: 3539, pts: { b: 3092, k: 175, c: 372 } }).head, 'Points: 3,539');
    assert.equal(SL.cardPoints({ pts: { b: 10, k: 5, c: 1 } }), 16, 'no score: the parts');
    assert.match(src('app.js'), /const score = you\.score != null \|\| you\.pts \? scoreText\.cardPoints\(you\)/);
});

test('bounty tag: BOUNTY ON YOU on your own tank, no "+" sign, baked at the size drawn', () => {
    const app = src('app.js');
    // made on first use: HUD isn't defined yet when this part of app.js runs
    assert.match(app, /if \(id === gui\.playerid\) return BOUNTY_ON_YOU \|\| \(BOUNTY_ON_YOU = \{ key: "btme", word: "BOUNTY ON YOU", num: "", col: HUD\.gold \}\);/);
    assert.match(app, /num: fmtNum\(b\.gems \| 0\) \+ " gems"/);
    assert.ok(!/num: "\+" \+ \(b\.gems \| 0\)/.test(app));
    assert.match(app, /const bake = Math\.max\(12, Math\.min\(64, Math\.round\(want \/ 4\) \* 4\)\);/);
    assert.match(app, /streakSprite\(bd, fs \* \(c\._tf \? tfOf\(c\)\.a : 1\)\)/);
});

test('crate: "next to you" only within reach, else the distance', async () => {
    const NL = await imp('newcomerLogic.js');
    const ev = { kind: 'crate', t: 'Supply crate next to you', sub: 'Break it open.' };
    assert.equal(NL.bannerFor(ev, { dist: 1400 }).title, 'Supply crate down, 1.4km away');
    assert.equal(NL.bannerFor(ev, { dist: 300 }).title, 'Supply crate next to you');
    assert.equal(NL.bannerFor({ kind: 'crate', t: 'Supply drop coming to you' }, { dist: 900 }).title, 'Supply drop coming, 900m away');
    assert.equal(NL.bannerFor(ev, {}).title, 'Supply crate next to you', 'no position: the server words');
    assert.match(ssrc('game/terrain/newcomerDirector.js'), /<= 450 \? "Supply crate next to you" : "Supply crate down nearby"/);
    assert.match(src('newcomer.js'), /L\.bannerFor\(live, \{ ability: abilityName\(live\), key: keyLabel\("KEY_ABILITY", "Q"\), touch: !!global\.mobile, dist \}\)/);
});

test('labels: the Vault label lifts over your tank; no storm plate while the storm row is up', () => {
    const app = src('app.js');
    assert.match(app, /function padLabelY\(lx, ly, w, size\)/);
    assert.match(app, /let vly = padLabelY\(sx, sy - R \* 1\.42, hudTitleW\("Vault", vls\), vls\);/);
    assert.match(app, /selfOver\.r = instance\.size \* ratio;/);
    const si = src('socketinit.js');
    assert.match(si, /if \(m\[0\] === "nxstorm" && \(\(global\.royale && global\.royale\.you && global\.royale\.you\.sm > 0\) \|\| performance\.now\(\) - \(global\.stormBannerAt \|\| -1e9\) < 1500\)\) break;/);
});

test('results: Keep results up docks the podium over the next raid until a click, Esc or 45 s', () => {
    const fin = src('raidFinale.js');
    assert.match(fin, /if \(S\.keep \|\| !S\.reveal \|\| now - S\.reveal < PODIUM_AT \+ 4000\) \{ D\.on = true; D\.at = now; return; \}/, 'the drop docks them (round 9: an early drop too)');
    assert.match(fin, /const DOCK_MS = 45000;/);
    assert.match(fin, /export function click\(x, y\) \{\s*if \(D\.on\) \{ undock\(\); return true; \}/);
    assert.match(fin, /if \(D\.on && kc === 27\) \{ undock\(\); return true; \}/);
    assert.match(fin, /S\.keep \? "Kept" : "Keep results up"/);
    assert.match(fin, /if \(!S\.on && D\.on && A\) \{ drawDock\(\); return; \}/);
    assert.match(fin, /S\.keep = false;\s*D\.on = false;/, 'a new raid end starts clean');
    const cv = src('canvas.js');
    assert.match(cv, /if \(raidFinale\.click\(mpos\.x \/ guiScale\(\), mpos\.y \/ guiScale\(\)\)\) break;/);
    assert.match(cv, /if \(!event\.repeat && raidFinale\.key\(event\.keyCode\)\)/);
});

(async () => {
    let failed = 0;
    for (const t of tests) {
        try { await t.fn(); console.log('ok   ' + t.name); }
        catch (e) { failed++; console.log('FAIL ' + t.name + '\n     ' + String(e && e.stack || e).split('\n').slice(0, 6).join('\n     ')); }
    }
    console.log(failed ? `${failed} of ${tests.length} failed` : `all ${tests.length} passed`);
    process.exit(failed ? 1 : 0);
})();
