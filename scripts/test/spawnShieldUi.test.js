'use strict';
const assert = require('assert');
const H = require('./headlessGame.js');
const { sleep } = H;

const why = H.available();
if (why) { console.log('skipped: ' + why); process.exit(0); }

const FIRE_WATCH = `(() => {
    const G = window.royaleState(), cmd = G.socket.cmd;
    if (!cmd.__watched) {
        const set = cmd.set;
        cmd.set = (i, v) => { if (i === 4 && v) window.__fired = (window.__fired || 0) + 1; return set(i, v); };
        cmd.__watched = true;
    }
    window.__fired = 0;
    return true;
})()`;

async function landed(page) {
    for (let i = 0; i < 60; i++) {
        const me = await H.dbgMe(page);
        if (me && me.invuln && !me.dead) return me;
        await sleep(250);
    }
    throw new Error('never landed with a shield');
}

async function age(page) {
    const me = await H.dbgMe(page);
    return { me, age: me && me.cap ? 45000 - me.cap : null };
}

(async () => {
    const g = await H.start({ port: 4400 });
    const { page, origin } = g;
    let results = [];
    try {
        await H.play(page, origin);
        results = await H.runChecks([
            ['spawn: the shield is up after landing, capped near 45 s', async () => {
                const me = await landed(page);
                await sleep(2500);
                assert.ok(me.cap > 35000 && me.cap <= 45000, 'cap left ' + me.cap);
                await page.eval(FIRE_WATCH);
                return 'cap left ' + me.cap + ' ms';
            }],
            ['stat bars: clicks on bars, gaps and labels never fire or drop the shield', async () => {
                await page.eval(`window.royaleTalk('DBG', 'lvl', 30), true`);
                let rects = [];
                for (let i = 0; i < 40 && rects.length < 3; i++) {
                    await sleep(250);
                    await page.move(30, 700);
                    rects = await page.eval(`(() => { const c = window.royaleState().clickables.stat; const out = []; for (let i = 0; i < 11; i++) { const r = c.rect(i); if (r && r.x > -5) out.push(r); } return out; })()`);
                }
                assert.ok(rects.length >= 3, 'the stat bars never slid in (' + rects.length + ')');
                rects.sort((a, b) => a.y - b.y);
                for (let i = 0; i < Math.min(4, rects.length - 1); i++) {
                    const r = rects[i], n = rects[i + 1];
                    await page.click(r.x + r.w / 2, r.y + r.h / 2);
                    await sleep(60);
                    await page.click(r.x + r.w * 0.3, (r.y + r.h + n.y) / 2);
                    await sleep(60);
                    await page.click(r.x + r.w + 12, r.y + r.h / 2);
                    await sleep(60);
                }
                const fired = await page.eval('window.__fired | 0');
                assert.equal(fired, 0, 'a click on the stat panel fired the gun');
                const me = await H.dbgMe(page);
                assert.ok(me.invuln, 'shield dropped: ' + JSON.stringify(me));
                return rects.length + ' bars';
            }],
            ['upgrade tiles: gaps, a pick and a quick second click stay UI', async () => {
                let tiles = [];
                for (let i = 0; i < 48 && tiles.length < 2; i++) {
                    await sleep(250);
                    tiles = await page.eval(`(() => { const G = window.royaleState(), c = G.clickables.upgrade; const out = []; if (!G.canUpgrade) return out; for (let i = 0; i < 12; i++) { const r = c.rect(i); if (r && r.x > 0) out.push(r); } return out; })()`);
                }
                assert.ok(tiles.length >= 2, 'no upgrade tiles offered');
                const a = tiles[0], b = tiles[1];
                const gapX = b.x > a.x + a.w ? (a.x + a.w + b.x) / 2 : a.x + a.w / 2;
                const gapY = b.x > a.x + a.w ? a.y + a.h / 2 : (a.y + a.h + b.y) / 2;
                await page.click(gapX, gapY);
                await sleep(80);
                await page.click(a.x + a.w / 2, a.y - 6);
                await sleep(80);
                await page.click(a.x + a.w / 2, a.y + a.h / 2);
                await sleep(120);
                await page.click(a.x + a.w / 2, a.y + a.h / 2);
                await sleep(120);
                await page.click(a.x + a.w / 2 + 6, a.y + a.h / 2 + 6);
                await sleep(300);
                const fired = await page.eval('window.__fired | 0');
                assert.equal(fired, 0, 'a click on the tiles fired the gun');
                const me = await H.dbgMe(page);
                assert.ok(me.invuln, 'shield dropped: ' + JSON.stringify(me));
                return tiles.length + ' tiles';
            }],
            ['UI keys: stat digits, pick keys, map, tree and Esc keep the shield', async () => {
                for (const [k, c, kc] of [['1', 'Digit1', 49], ['2', 'Digit2', 50], ['y', 'KeyY', 89], ['m', 'KeyM', 77], ['m', 'KeyM', 77], ['t', 'KeyT', 84]]) {
                    await page.key(k, c, kc);
                    await sleep(250);
                }
                await sleep(500);
                await page.key('t', 'KeyT', 84);
                await sleep(300);
                await page.key('Escape', 'Escape', 27);
                await sleep(300);
                const fired = await page.eval('window.__fired | 0');
                assert.equal(fired, 0);
                const { me, age: a } = await age(page);
                assert.ok(me.invuln, 'shield dropped: ' + JSON.stringify(me));
                assert.ok(a > 5200, 'still inside the 5 s grace (' + a + '), the check proves nothing');
                return 'shielded ' + (a / 1000).toFixed(1) + ' s after the spawn, past the grace';
            }],
            ['cap: idling with the shield ends it by about 45 s', async () => {
                let me = null;
                for (let i = 0; i < 120; i++) {
                    me = await H.dbgMe(page);
                    if (!me.invuln) break;
                    await sleep(500);
                }
                assert.ok(!me.invuln && !me.dead, 'the shield never ended: ' + JSON.stringify(me));
                return 'ended';
            }],
            ['a real shot into the world still ends a fresh shield', async () => {
                await page.eval(`window.royaleTalk('DBG', 'kill'), true`);
                let dead = false;
                for (let i = 0; i < 40 && !dead; i++) { await sleep(250); dead = !(await page.eval('window.dwPlaying()')); }
                assert.ok(dead, 'DBG kill did not take');
                await sleep(400);
                let back = false;
                for (let i = 0; i < 80 && !back; i++) {
                    if (i % 4 === 0) await page.key('Enter', 'Enter', 13);
                    await sleep(250);
                    back = await page.eval('window.dwPlaying()');
                }
                assert.ok(back, 'never dropped back in');
                await landed(page);
                await sleep(3500);
                await page.click(640, 230);
                await sleep(600);
                const me = await H.dbgMe(page);
                assert.ok(!me.invuln, 'shooting did not end the shield: ' + JSON.stringify(me));
                return 'ended by the shot';
            }],
            ['no page errors', async () => {
                if (page.errors.length) throw new Error(page.errors.slice(0, 6).join('\n'));
            }],
        ]);
    } catch (e) {
        results.push(false);
        console.log('FAIL setup\n     ' + String(e && e.stack || e).split('\n').slice(0, 6).join('\n     '));
    } finally {
        await g.stop();
    }
    const failed = results.filter(r => !r).length;
    console.log(failed ? failed + ' of ' + results.length + ' failed (server log ' + g.logFile + ')' : 'all ' + results.length + ' passed');
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
