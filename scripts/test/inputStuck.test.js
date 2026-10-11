'use strict';
const assert = require('assert');
const H = require('./headlessGame.js');
const { sleep } = H;

const why = H.available();
if (why) { console.log('skipped: ' + why); process.exit(0); }

const WATCH = `(() => {
    const s = window.royaleState().socket;
    if (!s.__watched) {
        const talk = s.talk;
        s.talk = (...m) => { if (m[0] === 'C') { window.__lastC = m[4] | 0; window.__cN = (window.__cN | 0) + 1; } return talk.apply(s, m); };
        s.__watched = true;
    }
    return true;
})()`;

const GRID = `(() => {
    const cv = document.getElementById('gameCanvas');
    const bad = {};
    const interactive = (e) => !!(e.closest && e.closest('button, a, input, textarea, select, [role=button], [role=dialog], #dwIgc, #dwHint, .gt-stack, #dwcPanel'));
    for (let y = 6; y < innerHeight; y += 30) for (let x = 6; x < innerWidth; x += 30) {
        const e = document.elementFromPoint(x, y);
        if (!e || e === cv || interactive(e)) continue;
        const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
        const invisible = +cs.opacity < 0.05 || cs.visibility === 'hidden' || (cs.backgroundColor === 'rgba(0, 0, 0, 0)' && !(e.innerText || '').trim() && cs.backgroundImage === 'none' && e.tagName !== 'CANVAS' && e.tagName !== 'svg' && e.tagName !== 'IMG' && !e.closest('svg'));
        if (!invisible) continue;
        const k = e.tagName + (e.id ? '#' + e.id : '') + (typeof e.className === 'string' && e.className ? '.' + e.className.split(' ')[0] : '');
        bad[k] = bad[k] || { n: 0, rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] };
        bad[k].n++;
    }
    return bad;
})()`;

async function bits(page) { return page.eval('window.__lastC | 0'); }

async function movesAndAims(page, tag) {
    await page.eval('window.royaleState().canvas.cv.focus(), true').catch(() => {});
    await page.move(900, 420);
    await page.keyDown('w', 'KeyW', 87);
    await sleep(350);
    let b = await bits(page);
    assert.ok(b & 1, tag + ': W did not reach the game (C bits ' + b + ', focus ' + await page.eval('document.activeElement && (document.activeElement.id || document.activeElement.tagName)') + ')');
    await page.keyUp('w', 'KeyW', 87);
    await sleep(300);
    b = await bits(page);
    assert.ok(!(b & 1), tag + ': W stuck down after release (C bits ' + b + ')');
    await page.move(820, 300);
    await page.down(820, 300);
    await sleep(300);
    b = await bits(page);
    assert.ok(b & 16, tag + ': a click in the world did not fire (C bits ' + b + ')');
    await page.up(820, 300);
    await sleep(300);
    b = await bits(page);
    assert.ok(!(b & 16), tag + ': fire stuck after the release (C bits ' + b + ')');
}

(async () => {
    const g = await H.start({ port: 4410 });
    const { page, origin } = g;
    let results = [];
    try {
        await H.play(page, origin);
        await sleep(4000);
        await page.eval(`window.royaleTalk('DBG', 'god'), true`);
        await page.eval(WATCH);
        await sleep(500);
        results = await H.runChecks([
            ['baseline: keys move, the mouse aims and fires', () => movesAndAims(page, 'baseline')],
            ['no invisible DOM layer over the game', async () => {
                const bad = await page.eval(GRID);
                const keys = Object.keys(bad);
                assert.equal(keys.length, 0, 'invisible elements take clicks: ' + JSON.stringify(bad));
            }],
            ['tank tree: T opens and closes, input comes back', async () => {
                await page.key('t', 'KeyT', 84); await sleep(900);
                assert.ok(await page.eval('!!window.royaleState().showTree'), 'the tree did not open');
                await page.key('t', 'KeyT', 84); await sleep(600);
                await movesAndAims(page, 'after tree');
            }],
            ['big map: M opens and closes, input comes back', async () => {
                await page.key('m', 'KeyM', 77); await sleep(500);
                assert.ok(await page.eval('!!window.royaleState().showBigMap'), 'the map did not open');
                await page.down(640, 400); await page.move(700, 430); await page.up(700, 430);
                await page.key('m', 'KeyM', 77); await sleep(400);
                await movesAndAims(page, 'after map');
            }],
            ['chat: Enter opens, typing and Enter send, Esc closes', async () => {
                await page.key('Enter', 'Enter', 13); await sleep(400);
                assert.ok(await page.eval('!!window.royaleState().showChat'), 'chat did not open');
                await page.send('Input.insertText', { text: 'hi' });
                await page.key('Enter', 'Enter', 13); await sleep(400);
                await movesAndAims(page, 'after sending chat');
                await page.key('Enter', 'Enter', 13); await sleep(400);
                await page.key('Escape', 'Escape', 27); await sleep(400);
                await movesAndAims(page, 'after Esc in chat');
            }],
            ['alt-tab: a held key and button let go on blur, and work after focus', async () => {
                await page.keyDown('w', 'KeyW', 87);
                await page.down(820, 300);
                await sleep(300);
                assert.ok((await bits(page)) & 17, 'not held before the blur');
                await page.eval(`window.dispatchEvent(new Event('blur')), true`);
                await sleep(300);
                const b = await bits(page);
                assert.ok(!(b & 1) && !(b & 16), 'still held after the blur (C bits ' + b + ')');
                await page.eval(`window.dispatchEvent(new Event('focus')), true`);
                await page.keyUp('w', 'KeyW', 87); await page.up(820, 300);
                await sleep(200);
                await movesAndAims(page, 'after alt-tab');
            }],
            ['tab hidden: visibilitychange lets go of everything', async () => {
                await page.keyDown('d', 'KeyD', 68);
                await sleep(300);
                assert.ok((await bits(page)) & 8, 'D not held');
                await page.eval(`(() => { Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); delete document.hidden; return true; })()`);
                await sleep(300);
                assert.ok(!((await bits(page)) & 8), 'D stuck after the tab was hidden');
                await page.keyUp('d', 'KeyD', 68);
                await movesAndAims(page, 'after hidden tab');
            }],
            ['focus on a DOM button: keys still reach the game', async () => {
                const id = await page.eval(`(() => { const b = [...document.querySelectorAll('button')].find(b => b.getClientRects().length && !b.closest('#dwIgc')); if (!b) return null; b.focus(); return b.id || b.className || 'button'; })()`);
                if (!id) return 'no visible DOM button in game';
                await movesAndAims(page, 'focus on ' + id);
                return id;
            }],
            ['focus stuck in a hidden text box: keys still reach the game', async () => {
                await page.eval(`(() => { let i = document.getElementById('__hiddenBox'); if (!i) { i = document.createElement('input'); i.id = '__hiddenBox'; i.type = 'text'; i.style.cssText = 'position:fixed;left:10px;top:10px;width:120px;height:20px;opacity:0'; document.body.appendChild(i); } i.focus(); return document.activeElement === i; })()`);
                await page.move(900, 420);
                await page.keyDown('w', 'KeyW', 87);
                await sleep(350);
                const b = await bits(page);
                await page.keyUp('w', 'KeyW', 87);
                await sleep(200);
                assert.ok(b & 1, 'W went into the hidden box (C bits ' + b + ')');
                await movesAndAims(page, 'after the hidden box');
            }],
            ['a release over a DOM card that swallows mouseup never leaves the gun firing', async () => {
                await page.eval(`(() => { let d = document.getElementById('__stopper'); if (!d) { d = document.createElement('div'); d.id = '__stopper'; d.style.cssText = 'position:fixed;left:960px;top:520px;width:160px;height:90px;z-index:60;background:#333'; for (const t of ['mouseup', 'click']) d.addEventListener(t, e => e.stopPropagation()); document.body.appendChild(d); } return true; })()`);
                await page.move(820, 300); await page.down(820, 300); await sleep(250);
                assert.ok((await bits(page)) & 16, 'did not fire');
                await page.move(1000, 560); await page.up(1000, 560); await sleep(300);
                const b = await bits(page);
                await page.eval(`document.getElementById('__stopper').remove(), true`);
                assert.ok(!(b & 16), 'fire stuck after a release over the card (C bits ' + b + ')');
            }],
            ['a release over an upgrade tile lets go of the gun', async () => {
                await page.eval(`window.royaleTalk('DBG', 'lvl', 30), true`);
                let tile = null;
                for (let i = 0; i < 48 && !tile; i++) {
                    await sleep(250);
                    tile = await page.eval(`(() => { const G = window.royaleState(); if (!G.canUpgrade) return null; const r = G.clickables.upgrade.rect(0); return r && r.x > 0 ? r : null; })()`);
                }
                if (!tile) return 'no tiles offered';
                await page.move(820, 330); await page.down(820, 330); await sleep(250);
                assert.ok((await bits(page)) & 16, 'did not fire');
                await page.move(tile.x + tile.w / 2, tile.y + tile.h / 2); await page.up(tile.x + tile.w / 2, tile.y + tile.h / 2); await sleep(300);
                const b = await bits(page);
                assert.ok(!(b & 16), 'fire stuck after a release over a tile (C bits ' + b + ')');
                await movesAndAims(page, 'after the tile');
            }],
            ['shop pad: the panel opens, Esc puts it away, input works', async () => {
                await page.eval(`window.royaleTalk('DBG', 'shop', 0), true`);
                await sleep(1500);
                await page.key('Escape', 'Escape', 27); await sleep(300);
                await movesAndAims(page, 'after the shop');
            }],
            ['death card: dies, Enter drops back in, input works', async () => {
                await page.eval(`window.royaleTalk('DBG', 'god'), window.royaleTalk('DBG', 'kill'), true`);
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
                await sleep(3500);
                await page.eval(`window.royaleTalk('DBG', 'god'), true`);
                await movesAndAims(page, 'after the death card');
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
