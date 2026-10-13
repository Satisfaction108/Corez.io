'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const H = require('./headlessGame.js');

const REPO = H.REPO;
const sleep = H.sleep;
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const why = H.available();
if (why) { console.log('skip: ' + why); process.exit(0); }

const KINDS = ['storm', 'core', 'rush', 'hill', 'boss', 'meteor'];

async function main() {
    const net = require('net');
    const portFree = (p) => new Promise(res => { const s = net.createServer(); s.once('error', () => res(false)); s.once('listening', () => s.close(() => res(true))); s.listen(p, '127.0.0.1'); });
    let base = 0;
    for (let p = +process.env.TEST_PORT || 4800; p < 5400 && !base; p += 10) {
        let ok = true;
        for (let i = 0; i <= 5 && ok; i++) ok = await portFree(p + i);
        if (ok) base = p;
    }
    if (!base) throw new Error('no free port from 4800');
    const port = base, cdpPort = base + 5, origin = 'http://localhost:' + port;
    const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-ao-e2e-'));
    const dataDir = path.join(ROOT, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    const env = Object.assign({}, process.env, {
        ROYALE_DEBUG: '1', ROYALE_ALWAYS_ON: '1', ROYALE_AO_TANKS: process.env.ROYALE_AO_TANKS || '6', SOLO_RAIDS: '1', BOT_CHAT_AI: 'false',
        SESSION_SECRET: 'ao-e2e-test-secret-0123456789-abcdefghij', DATA_DIR: dataDir, PUBLIC_ORIGIN: origin, PUBLIC_HOST: 'localhost:' + port,
        TRUSTED_PROXIES: '127.0.0.1', SINGLE_PROCESS: 'true', PORT: String(port), BR_PORT: String(port),
        TUT_PORT: String(port + 1), DUO_PORT: String(port + 2), DW_PORT: String(port + 3),
    });
    delete env.NODE_ENV;
    for (const k of Object.keys(env)) if (/^(DISCORD_|WEB_PUSH_|BACKUP_)/.test(k)) delete env[k];
    const logFile = path.join(ROOT, 'server.log');
    const out = fs.openSync(logFile, 'a');
    const WS = require(path.join(REPO, 'node_modules', 'ws'));
    let server = null, chrome = null, ws = null;
    const stopProc = async (ch, sig) => {
        if (!ch || ch.exitCode !== null) return;
        ch.kill(sig);
        await new Promise(res => { if (ch.exitCode !== null) res(); else ch.once('exit', res); setTimeout(res, 8000); });
        if (ch.exitCode === null && ch.signalCode === null) ch.kill('SIGKILL');
    };
    const startServer = async () => {
        server = spawn(process.execPath, ['--no-lazy', 'index.js'], { cwd: REPO, env, stdio: ['ignore', out, out] });
        for (let i = 0; i < 240; i++) {
            if (server.exitCode !== null) throw new Error('server exited (' + server.exitCode + '), log ' + logFile);
            try { if ((await fetch(origin + '/api/config')).status === 200) return; } catch (e) { }
            await sleep(250);
        }
        throw new Error('server never answered');
    };
    const results = [];
    let page = null;
    try {
        await startServer();
        chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + cdpPort, '--user-data-dir=' + path.join(ROOT, 'chrome'),
            '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio', '--window-size=1280,800',
            '--disable-background-timer-throttling', '--disable-renderer-backgrounding', 'about:blank'], { stdio: 'ignore' });
        let target = null;
        for (let i = 0; i < 80 && !target; i++) {
            try { target = (await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()).find(t => t.type === 'page'); } catch (e) { }
            if (!target) await sleep(250);
        }
        if (!target) throw new Error('no Chrome page');
        ws = new WS(target.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
        await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
        page = await (async () => {
            const P = new (class {
                constructor() { this.id = 0; this.pend = new Map(); this.errors = []; }
                send(method, params = {}) { return new Promise((res, rej) => { const i = ++this.id; this.pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); }); }
                async eval(expr) {
                    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
                    if (r.exceptionDetails) throw new Error('eval failed: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
                    return r.result.value;
                }
            })();
            ws.on('message', (m) => {
                const d = JSON.parse(m);
                if (d.id && P.pend.has(d.id)) { const p = P.pend.get(d.id); P.pend.delete(d.id); if (d.error) p.rej(new Error(JSON.stringify(d.error))); else p.res(d.result); return; }
                if (d.method === 'Runtime.exceptionThrown') { const x = d.params.exceptionDetails || {}; P.errors.push('exception: ' + ((x.exception && x.exception.description) || x.text || '').split('\n').slice(0, 4).join(' | ')); }
                else if (d.method === 'Page.javascriptDialogOpening') P.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => { });
            });
            return P;
        })();
        await page.send('Runtime.enable');
        await page.send('Page.enable');
        await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
        await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `try { localStorage.setItem('digRoyaleTutorialDone_v1','1'); localStorage.setItem('digwarsTutorialDone_v3','1'); localStorage.setItem('dwCoach_v1', JSON.stringify({status:'veteran',done:{}})); localStorage.setItem('dwChipHints_v1', JSON.stringify({all:1})); } catch (e) {}` });

        const T = (...a) => page.eval(`window.royaleTalk(${a.map(x => JSON.stringify(x)).join(',')}), true`);
        const R = (expr) => page.eval(`(() => { const r = window.royaleState().royale || {}; return ${expr}; })()`);
        const waitFor = async (expr, ms = 15000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await R(expr); } catch (e) { v = null; } if (v) return v; await sleep(250); } return v; };
        const dbg = async (...a) => {
            const n0 = await page.eval('(window.dwDbgLog || []).length');
            await T('DBG', ...a);
            for (let i = 0; i < 40; i++) {
                await sleep(100);
                const v = await page.eval(`(() => { const l = window.dwDbgLog || []; return l.length > ${n0} ? l[l.length - 1].text : null; })()`);
                if (v) { try { return JSON.parse(v); } catch (e) { return v; } }
            }
            return null;
        };
        const check = async (name, fn) => {
            const s = Date.now();
            try { const note = await fn(); results.push(true); console.log(`ok   ${name} (${Date.now() - s} ms)${note ? ' - ' + note : ''}`); }
            catch (e) { results.push(false); console.log(`FAIL ${name}\n     ${String(e && e.message || e).split('\n').slice(0, 10).join('\n     ')}`); }
        };
        const serverErrors = () => fs.readFileSync(logFile, 'utf8').split('\n').filter(l => /\[ALWAYS-ON\]|\[RAID\] .* failed|TypeError|ReferenceError/.test(l)).slice(0, 8);
        const respawn = async () => {
            await sleep(3600);
            await page.eval(`(() => { const a = document.getElementById('royaleDomPlayAgain'); if (a) a.click(); try { window.royaleState().canvas.respawn(); } catch (e) { } return 1; })()`);
            const ok = await waitFor('window.dwPlaying()', 20000).catch(() => false) || await page.eval('window.dwPlaying()');
            if (!ok) throw new Error('never respawned');
            await sleep(1500);
        };
        const join = async () => { await H.play(page, origin); await sleep(2500); await T('DBG', 'god'); await sleep(500); };

        await join();

        await check('the world is Always-On: no raid clock, no global storm, an event panel', async () => {
            const s = await waitFor('r.ao && r.ao.on ? { ao: r.ao, left: r.raidLeft, storm: r.storm && r.storm.a } : null', 10000);
            assert.ok(s && s.ao, 'RY carries ao');
            assert.equal(s.left | 0, 0, 'no raid clock');
            assert.ok(!s.storm, 'no global storm');
            assert.ok(s.ao.nx && s.ao.nx.k && s.ao.nx.in > 0, 'the next event is planned');
            const st = await dbg('aostate');
            assert.ok(st && st.res && st.res.on, 'aostate answers');
            return s.ao.nx.n + ' in ' + Math.round(s.ao.nx.in / 1000) + ' s, in ' + s.ao.nx.w;
        });

        await check('bots keep the world lively', async () => {
            const n = await waitFor('(r.alive | 0) >= 4 ? r.alive : 0', 25000);
            assert.ok(n >= 4, 'tanks in the world: ' + n);
            return n + ' tanks';
        });

        await check('bots keep their names and points through a death', async () => {
            const want = Math.max(2, (+env.ROYALE_AO_TANKS || 6) - 2);
            const before = await waitFor(`(() => { const b = (r.board || []).filter(x => x.bot && x.here); return b.length >= ${want} ? b.map(x => ({ n: x.name, s: x.score | 0 })) : null; })()`, 30000);
            assert.ok(before && before.length >= want, 'bots on the board: ' + JSON.stringify(before));
            const kb = await dbg('killbot');
            assert.ok(kb && kb.killbot === 1, 'a bot went down: ' + JSON.stringify(kb));
            await sleep(12000);
            const after = await R('(r.board || []).filter(x => x.bot).map(x => ({ n: x.name, s: x.score | 0, here: x.here | 0 }))');
            for (const b of before) {
                const a = after.find(x => x.n === b.n);
                assert.ok(a, b.n + ' is still on the board');
                assert.ok(a.s >= b.s, b.n + ' kept its points: ' + b.s + ' -> ' + a.s);
            }
            const names0 = new Set(before.map(x => x.n));
            const fresh = after.filter(x => x.here && !names0.has(x.n));
            assert.equal(fresh.length, 0, 'no new names: ' + fresh.map(x => x.n).join(', '));
            const back = after.filter(x => x.here && names0.has(x.n)).length;
            assert.ok(back >= before.length - 1, 'the bot came back as itself: ' + back + ' of ' + before.length);
            const st = await dbg('aostate');
            assert.ok(st.res.roster && st.res.roster.on, 'the Always-On roster is on');
            return before.map(x => x.n).join(', ');
        });

        for (const kind of ['boss', 'core']) {
            await check(kind + ': it rises at least 900 away from a player on the marker, after a warning', async () => {
                await dbg('event', 'plan', kind, 20);
                await dbg('event', 'go', 0);
                await sleep(700);
                const me = await page.eval('(() => { const g = window.royaleState(); return [g.player.renderx, g.player.rendery]; })()');
                const st = await dbg('event', 'next');
                assert.ok(st && st.res && st.res.started === kind, 'started: ' + JSON.stringify(st));
                const s2 = await dbg('aostate');
                const cur = s2.res.cur;
                const d0 = Math.hypot(cur.x - me[0], cur.y - me[1]);
                assert.ok(d0 >= 860, 'it rises ' + Math.round(d0) + ' away from me');
                assert.ok(cur.spot && cur.spot.human >= 860, 'the spot keeps clear: ' + JSON.stringify(cur.spot));
                const early = await R(kind === 'boss' ? '!!r.boss' : '!!(r.core && r.core.s === "up")');
                assert.ok(!early, 'not up straight away (the warning runs first)');
                const up = await waitFor(kind === 'boss' ? 'r.boss ? { x: r.boss.x, y: r.boss.y } : null' : 'r.core && r.core.s === "up" ? { x: r.core.x, y: r.core.y } : null', 6000);
                assert.ok(up, 'it arrived');
                const d1 = Math.hypot(up.x - me[0], up.y - me[1]);
                assert.ok(d1 >= 800, 'landed ' + Math.round(d1) + ' away');
                await dbg('event', 'end');
                await sleep(2500);
                return Math.round(d0) + ' u';
            });
        }

        let banked0 = 0;
        await check('mine and bank: the daily score grows', async () => {
            const s0 = await R('r.youScore | 0');
            await T('DBG', 'carry', 600);
            await sleep(400);
            await T('DBG', 'vault', 0);
            await sleep(1200);
            for (let i = 0; i < 3; i++) {
                await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'b', code: 'KeyB', windowsVirtualKeyCode: 66 });
                await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'b', code: 'KeyB', windowsVirtualKeyCode: 66 });
                await sleep(300);
            }
            const s1 = await waitFor(`(r.you && (r.you.banked | 0) >= 600) ? r.youScore | 0 : 0`, 25000);
            assert.ok(s1 >= s0 + 600, 'score ' + s0 + ' -> ' + s1);
            banked0 = s1;
            await T('DBG', 'shop', 0);
            return s0 + ' -> ' + s1;
        });

        await check('die and respawn: the banked score is kept', async () => {
            await T('DBG', 'god');
            await sleep(200);
            await T('DBG', 'kill');
            const dead = await waitFor('window.royaleState().died', 8000);
            assert.ok(dead, 'died');
            const ds = await R('r.youScore | 0');
            assert.ok(ds >= banked0, 'dead: ' + ds);
            const dl = await page.eval('(() => { try { return window.royaleState().royale.ao ? 1 : 0; } catch (e) { return 0; } })()');
            assert.equal(dl, 1);
            await respawn();
            await T('DBG', 'god');
            const s = await waitFor(`(r.youScore | 0) >= ${banked0} ? r.youScore | 0 : 0`, 8000);
            assert.ok(s >= banked0, 'after respawn: ' + s);
            return String(s);
        });

        await check('rejoin from the menu: same score', async () => {
            await join();
            const s = await waitFor(`(r.youScore | 0) >= ${banked0} ? r.youScore | 0 : 0`, 12000);
            assert.ok(s >= banked0, 'after rejoin: ' + s);
            return String(s);
        });

        await check('a server restart keeps the daily score', async () => {
            await sleep(11000);
            await stopProc(server, 'SIGINT');
            await startServer();
            await join();
            const s = await waitFor(`(r.youScore | 0) >= ${banked0} ? r.youScore | 0 : 0`, 15000);
            assert.ok(s >= banked0, 'after restart: ' + s + ' wanted ' + banked0);
            const me = await waitFor('r.board && r.board.find(x => !x.bot && x.place === r.place) || null', 5000);
            assert.ok(me, 'on the daily board');
            return String(s);
        });

        for (const kind of KINDS) {
            await check('event ' + kind + ': starts, runs, ends and awards a top 3', async () => {
                const st = await dbg('event', 'start', kind);
                assert.ok(st && st.res && st.res.started === kind, 'started: ' + JSON.stringify(st));
                const ev = await waitFor(`r.ao && r.ao.ev && r.ao.ev.k === ${JSON.stringify(kind)} ? r.ao.ev : null`, 6000);
                assert.ok(ev, 'the HUD sees it');
                assert.ok(ev.left > 0 && ev.n, 'has a clock');
                await dbg('event', 'go', kind === 'hill' ? 200 : kind === 'core' ? 160 : 0);
                await sleep(2500);
                if (kind === 'storm') {
                    const as = await R('r.aoStorm');
                    assert.ok(as && as.a && as.out > as.r, 'the scoped storm ring');
                }
                if (kind === 'core') assert.ok(await waitFor('r.core && r.core.s === "up"', 4000), 'the Core is up');
                if (kind === 'boss') assert.ok(await waitFor('!!r.boss', 4000), 'the boss is up');
                if (kind === 'rush') assert.ok(await waitFor('!!r.bloom', 4000), 'the rush region is rich');
                const sc = await dbg('event', 'score', 250);
                assert.ok(sc && sc.res && sc.res.place >= 1, 'scored: ' + JSON.stringify(sc));
                await dbg('event', 'left', 2);
                if (kind === 'boss' || kind === 'core') {
                    const key = kind === 'boss' ? 'exits' : 'blasts';
                    let seen = 0;
                    for (let i = 0; i < 30 && !seen; i++) { await sleep(150); seen = await page.eval(`(window.dwEventFx && window.dwEventFx().${key}) || 0`); }
                    assert.ok(seen > 0, kind === 'boss' ? 'the boss leaves with its exit' : 'the Core blows up on time out');
                }
                const res = await waitFor(`r.ao && r.ao.res && r.ao.res.k === ${JSON.stringify(kind)} ? { res: r.ao.res, you: r.you && r.you.ao } : null`, 12000);
                assert.ok(res, 'results arrived');
                assert.ok(res.res.top.length >= 1 && res.res.top.length <= 3, 'a top 3');
                assert.ok(res.you && res.you.rr && res.you.rr.pl >= 1 && res.you.rr.p > 0, 'my place and points: ' + JSON.stringify(res.you));
                const told = await page.eval(`(() => { const g = window.royaleState(); const pops = (window.dwPtsPops && window.dwPtsPops()) || []; return pops.some(p => p.includes(${JSON.stringify(res.res.n)})) || (g.callouts || []).some(c => c.kind === 'aoaward'); })()`);
                assert.ok(told, 'the award is explained with a points pop');
                const card = await page.eval('(() => { try { return !!window.royaleState().royale.ao; } catch (e) { return false; } })()');
                assert.ok(card);
                const errs = serverErrors();
                assert.equal(errs.length, 0, errs.join('\n'));
                await sleep(800);
                return res.res.top.map(t => t.n + ' ' + t.p).join(', ') + ' / me ' + res.you.rr.pl;
            });
        }

        await check('the next event follows, and never the same kind twice', async () => {
            const st = await dbg('aostate');
            assert.ok(st.res.next && st.res.next.k, 'planned');
            assert.notEqual(st.res.next.k, st.res.history[st.res.history.length - 1]);
            assert.ok(st.res.next.gap >= 6 * 60_000 && st.res.next.gap <= 8 * 60_000 + 1000, 'six to eight minutes after the last start: ' + st.res.next.gap);
            assert.ok(st.res.next.afterEnd >= 75_000, 'a breather after the last one: ' + st.res.next.afterEnd);
            return st.res.next.k + ' in ' + Math.round(st.res.next.in / 1000) + ' s';
        });

        await check('no raid end and no finale in this mode', async () => {
            await T('DBG', 'raidend');
            await sleep(3000);
            const s = await page.eval('(() => { const g = window.royaleState(); return { fx: !!g.raidEndFx, res: !!(g.royale && g.royale.results), playing: window.dwPlaying(), ending: g.royale.ending | 0 }; })()');
            assert.deepEqual(s, { fx: false, res: false, playing: true, ending: 0 });
            const log = fs.readFileSync(logFile, 'utf8');
            assert.ok(!/The raid is over/.test(log), 'no raid-over broadcast');
        });

        await check('a player who dies and respawns during an event still gets the crown', async () => {
            await dbg('event', 'start', 'meteor');
            await waitFor('r.ao && r.ao.ev && r.ao.ev.k === "meteor"', 6000);
            const sc = await dbg('event', 'score', 900);
            assert.ok(sc && sc.res && sc.res.place === 1, 'first: ' + JSON.stringify(sc));
            await T('DBG', 'god');
            await sleep(200);
            await T('DBG', 'kill');
            assert.ok(await waitFor('window.royaleState().died', 8000), 'died');
            await respawn();
            await T('DBG', 'god');
            await dbg('event', 'left', 2);
            const res = await waitFor('r.ao && r.ao.res && r.ao.res.k === "meteor" ? 1 : 0', 12000);
            assert.ok(res, 'results');
            const crowned = await waitFor('r.you && r.you.crown ? r.you.crown : null', 6000);
            assert.ok(crowned, 'my new body wears the crown');
            return 'crown: ' + JSON.stringify(crowned);
        });

        await check('dead when the event ends: the crown waits for the respawn', async () => {
            await dbg('event', 'start', 'hill');
            await waitFor('r.ao && r.ao.ev && r.ao.ev.k === "hill"', 6000);
            await dbg('event', 'score', 950);
            await T('DBG', 'god');
            await sleep(200);
            await T('DBG', 'kill');
            assert.ok(await waitFor('window.royaleState().died', 8000), 'died');
            await dbg('event', 'left', 1);
            assert.ok(await waitFor('r.ao && r.ao.res && r.ao.res.k === "hill" ? 1 : 0', 12000), 'results');
            await respawn();
            await T('DBG', 'god');
            const crowned = await waitFor('r.you && r.you.crown ? r.you.crown : null', 8000);
            assert.ok(crowned, 'the crown was waiting');
        });

        await check('bots go to a Core Siege and shoot the Core', async () => {
            for (let i = 0; i < 4 && await page.eval('!!window.royaleState().died'); i++) { await respawn(); await sleep(2000); }
            assert.ok(await waitFor('!window.royaleState().died ? 1 : 0', 15000), 'alive again');
            await dbg('event', 'start', 'core');
            let st = null, botPts = 0, going = 0;
            for (let i = 0; i < 45 && !botPts; i++) {
                await sleep(1500);
                st = await dbg('aostate');
                const cur = st && st.res && st.res.cur;
                if (!cur) break;
                botPts = cur.scores.filter(x => x.b && x.p > 0).length;
                going = Math.max(going, st.res.bots.filter(b => b.g === 'aoshoot' || b.g === 'aogo').length);
            }
            assert.ok(going >= 1, 'bots took the event goal: ' + JSON.stringify(st && st.res && st.res.bots));
            assert.ok(botPts >= 1, 'a bot damaged the Core: ' + JSON.stringify(st && st.res && st.res.cur && st.res.cur.scores));
            await dbg('event', 'end');
            await sleep(2000);
            return botPts + ' bots scored, ' + going + ' on the way';
        });

        await check('the daily reset pays the champions and empties the board', async () => {
            const before = await R('r.youScore | 0');
            assert.ok(before > 0);
            const name = await page.eval('window.royaleState().playerName || ""');
            const day0 = await R('r.ao.day');
            const st = await dbg('dayreset');
            assert.ok(st && st.res && st.res.champs, 'reset ran: ' + JSON.stringify(st));
            const after = await waitFor(`r.ao.day !== ${JSON.stringify(day0)} && (r.youScore | 0) < ${before} ? { s: r.youScore | 0, ch: r.ao.ch, day: r.ao.day } : null`, 8000);
            assert.ok(after, 'the board reset');
            assert.ok(after.s < 50, 'score now ' + after.s);
            assert.ok(after.ch.length >= 1, "yesterday's champions are shown");
            const api = await (await fetch(origin + '/api/champions')).json();
            assert.ok(api.on && api.champs.length >= 1, 'menu API: ' + JSON.stringify(api));
            return 'champs ' + after.ch.map(c => c.n).join(', ') + (name ? ' (me ' + name + ')' : '');
        });

        await check('the client drew it all without errors', async () => {
            const errs = page.errors.filter(e => !/favicon|ERR_|net::/.test(e));
            assert.equal(errs.length, 0, errs.slice(0, 5).join('\n'));
            const se = serverErrors();
            assert.equal(se.length, 0, se.join('\n'));
        });
    } finally {
        try { if (ws) ws.close(); } catch (e) { }
        await stopProc(chrome, 'SIGTERM');
        await stopProc(server, 'SIGINT');
        try { fs.closeSync(out); } catch (e) { }
    }
    const failed = results.filter(x => !x).length;
    console.log(failed ? `${failed} of ${results.length} failed (log ${logFile})` : `all ${results.length} passed`);
    if (!failed) { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (e) { } }
    process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
