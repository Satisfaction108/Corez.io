// The death card's Play again, server side: node scripts/test/playAgain.test.js
//
// One local server (ports 4800-4803, ROYALE_DEBUG, a 12 s idle kick) and
// headless ws clients:
//   wait      a Play again sent 1 s after the death is held until 3 s
//   noAuto    nobody is dropped back in without asking, however long they
//             sit on the card; the request after that spawns at once
//   idle      a player left on the death card with no input goes to the menu
//             (IK, close 4001) at the idle limit; one moving the mouse stays
//   arsenal   the override's Annihilator sidearm is on the first spawn and on
//             every respawn (DBG me reports the mounted sidearm)
//
// PLAY_E2E=0 skips it. Data goes under $DATA_DIR if set (point it at a
// scratch directory), otherwise the OS temp dir; removed when it passes.
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const REPO = path.join(__dirname, '..', '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ROOT = process.env.DATA_DIR
    ? path.join(process.env.DATA_DIR, `play-again-test-${process.pid}-${Date.now()}`)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'dw-play-again-test-'));
fs.mkdirSync(ROOT, { recursive: true });
const KICK_MS = 12000;

class Client {
    constructor(port, name) {
        const WebSocket = require(path.join(REPO, 'node_modules', 'ws'));
        this.ft = require('../../server/lib/fasttalk.js');
        this.log = [];
        this.closed = false;
        this.closeCode = null;
        this.name = name;
        this.token = 'tok' + name + 'x'.repeat(12);
        this.spawnedOnce = false;
        this.ws = new WebSocket('ws://localhost:' + port, { headers: { Origin: 'http://localhost:' + port } });
        this.ws.binaryType = 'arraybuffer';
        this.ws.on('message', d => {
            const m = this.ft.decode(d);
            if (!m) return;
            const type = m.shift();
            this.log.push({ type, m, at: Date.now() });
            if (type === 'W') this.talk('k', '');
            if (type === 'w') { this.talk('RZ', this.token); this.talk('s', '', 1, 0, false, 0); }
            if (type === 'TG' && !this.spawnedOnce) { this.spawnedOnce = true; setTimeout(() => this.talk('s', this.name, 0, 0, false, 0), 200); }
        });
        this.ws.on('close', (code) => { this.closed = true; this.closeCode = code; });
        this.ws.on('error', err => { this.error = err; });
    }
    talk(...m) { try { this.ws.send(this.ft.encode(m)); } catch (e) { /* closed */ } }
    play() { this.talk('s', this.name, 0, 0, false, 0); }
    mark() { return this.log.length; }
    seen(type, from = 0) { return this.log.slice(from).find(e => e.type === type); }
    async waitFor(type, pred = () => true, from = 0, ms = 20000) {
        const end = Date.now() + ms;
        while (Date.now() < end) {
            const hit = this.log.slice(from).find(e => e.type === type && pred(e.m));
            if (hit) return hit;
            await sleep(40);
        }
        throw new Error(`${this.name}: timed out waiting for ${type}; saw ${[...new Set(this.log.slice(from).map(e => e.type))].join(',')}`);
    }
    async dbg(...args) {
        const i0 = this.mark();
        this.talk('DBG', ...args);
        return JSON.parse((await this.waitFor('KC', m => m[0] === 'dbg', i0, 5000)).m[1]);
    }
    // die now; resolves with the death packet
    async die() {
        const i0 = this.mark();
        this.talk('DBG', 'kill');
        return this.waitFor('F', () => true, i0, 5000);
    }
    poke() { this._side = ((this._side | 0) + 1) % 4; const a = this._side * Math.PI / 2; this.talk('C', Math.round(200 * Math.cos(a)), Math.round(200 * Math.sin(a)), 1, 0); }
    keepActive(ms = 1500) { this.stopActive(); this._act = setInterval(() => this.poke(), ms); }
    stopActive() { if (this._act) clearInterval(this._act); this._act = null; }
    close() { this.stopActive(); try { this.ws.close(); } catch (e) { /* */ } }
}

async function main() {
    if (process.env.PLAY_E2E === '0') { console.log('skipped (PLAY_E2E=0)'); return 0; }
    const port = 4800;
    const origin = 'http://localhost:' + port;
    const dataDir = path.join(ROOT, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    const env = { ...process.env, ROYALE_DEBUG: '1', ROYALE_IDLE_KICK_MS: String(KICK_MS), ROYALE_IDLE_PROTECT_MS: '600000',
        SESSION_SECRET: 'play-again-test-secret-0123456789-abcdefgh', DATA_DIR: dataDir, PUBLIC_ORIGIN: origin, PUBLIC_HOST: 'localhost:' + port,
        TRUSTED_PROXIES: '127.0.0.1', SINGLE_PROCESS: 'true', PORT: String(port), BR_PORT: String(port),
        TUT_PORT: String(port + 1), DUO_PORT: String(port + 2), DW_PORT: String(port + 3) };
    delete env.NODE_ENV;
    for (const k of Object.keys(env)) if (/^DISCORD_/.test(k)) delete env[k];
    const logFile = path.join(ROOT, 'server.log');
    const out = fs.openSync(logFile, 'w');
    const child = spawn(process.execPath, ['index.js'], { cwd: REPO, env, stdio: ['ignore', out, out] });
    const clients = [];
    const results = [];
    const check = async (name, fn) => {
        const s = Date.now();
        try { const note = await fn(); results.push(true); console.log(`ok   ${name} (${Date.now() - s} ms)${note ? ' - ' + note : ''}`); }
        catch (e) { results.push(false); console.log(`FAIL ${name}\n     ${String(e && e.stack || e).split('\n').slice(0, 6).join('\n     ')}`); }
    };
    try {
        for (let i = 0; i < 160; i++) {
            try { if ((await fetch(origin + '/api/config')).status === 200) break; } catch (e) { /* booting */ }
            await sleep(250);
        }
        let ready = false;
        for (let i = 0; i < 20 && !ready; i++) {
            const c = new Client(port, 'Warm' + i);
            for (let j = 0; j < 20 && !c.log.some(x => x.type === 'W'); j++) await sleep(100);
            ready = c.log.some(x => x.type === 'W');
            c.spawnedOnce = true;
            c.close();
            if (!ready) await sleep(500);
        }
        assert.ok(ready, 'game socket never welcomed a client');

        const A = new Client(port, 'Again' + (Math.random() * 900 + 100 | 0));
        clients.push(A);
        await A.waitFor('c');
        // no keys pressed all along, so the spawn shield keeps the bots off
        await sleep(400);

        await check('arsenal: the Annihilator is mounted on the spawn it starts on', async () => {
            const i0 = A.mark();
            A.talk('DBG', 'twist', 'arsenal');
            await A.waitFor('SHP', m => JSON.parse(m[0]).arm === 'flak', i0, 5000);
            assert.equal((await A.dbg('me')).arm, 'flak');
        });

        await check('wait: Play again 1 s after the death is held until 3 s', async () => {
            const f = await A.die();
            const i0 = A.mark();
            await sleep(1000);
            A.play();
            const c = await A.waitFor('c', () => true, i0, 6000);
            const after = c.at - f.at;
            assert.ok(after >= 2850 && after <= 3800, 'dropped in ' + after + ' ms after the death');
            return 'dropped in at ' + after + ' ms';
        });

        await check('arsenal: still mounted after the respawn', async () => {
            await sleep(300);
            assert.equal((await A.dbg('me')).arm, 'flak');
            const shp = [...A.log].reverse().find(e => e.type === 'SHP');
            assert.equal(JSON.parse(shp.m[0]).arm, 'flak', 'the kit box knows');
        });

        await check('noAuto: nobody drops you back in; asking does, at once', async () => {
            const f = await A.die();
            const i0 = A.mark();
            A.keepActive();              // present and moving the mouse, just not pressing Play
            await sleep(7000);
            A.stopActive();
            assert.equal(A.seen('c', i0), undefined, 'spawned without asking');
            const i1 = A.mark();
            A.play();
            const c = await A.waitFor('c', () => true, i1, 3000);
            assert.ok(c.at - Date.now() < 3000);
            assert.equal(A.closed, false);
            await sleep(300);
            assert.equal((await A.dbg('me')).arm, 'flak', 'third life, still armed');
            A.keepActive();              // alive and playing while B joins
            return 'spawned ' + (c.at - f.at) + ' ms after the death, on request';
        });

        await check('idle: a player left on the death card goes to the menu at the idle limit', async () => {
            const B = new Client(port, 'Stay' + (Math.random() * 900 + 100 | 0));
            clients.push(B);
            await B.waitFor('c');
            await sleep(400);
            // A sits on the card doing nothing; B sits on it moving the mouse
            A.stopActive();
            const fA = await A.die();
            await B.die();
            B.keepActive();
            const ik = await A.waitFor('IK', () => true, 0, KICK_MS + 6000);
            const after = ik.at - fA.at;
            assert.ok(after >= KICK_MS - 300 && after <= KICK_MS + 2500, 'kicked ' + after + ' ms after the death');
            assert.equal(ik.m[0], 'Removed for being inactive for 5 minutes');
            for (let i = 0; i < 40 && !A.closed; i++) await sleep(100);
            assert.equal(A.closeCode, 4001);
            await sleep(3000);
            assert.equal(B.seen('IK'), undefined, 'the one moving the mouse stays');
            assert.equal(B.closed, false);
            // and B can still play again after all that
            const i1 = B.mark();
            B.stopActive();
            B.play();
            await B.waitFor('c', () => true, i1, 3000);
            return 'kicked ' + (after / 1000).toFixed(1) + ' s after the death (limit ' + KICK_MS / 1000 + ' s)';
        });
    } catch (e) {
        results.push(false);
        console.log('FAIL setup\n     ' + String(e && e.stack || e).split('\n').slice(0, 6).join('\n     '));
    } finally {
        for (const c of clients) c.close();
        child.kill('SIGINT');
        await new Promise(res => { if (child.exitCode !== null) res(); else child.once('exit', res); setTimeout(res, 6000); });
        if (child.exitCode === null) child.kill('SIGKILL');
        fs.closeSync(out);
    }
    const failed = results.filter(r => !r).length;
    console.log(failed ? `${failed} of ${results.length} failed (server log in ${logFile})` : `all ${results.length} passed`);
    if (!failed) fs.rmSync(ROOT, { recursive: true, force: true });
    return failed;
}

main().then(f => process.exit(f ? 1 : 0), e => { console.error(e); process.exit(1); });
