// Death-path harness: exercises onCombatantDead (kill credit, feed, revenge
// marks, avenge bonus) with stubbed terrain deps. Run: node scripts/revenge-test.js
const Module = require('module');
const path = require('path');

const scriptDir = '/Users/raghavan/Documents/GitHub/Arras2/server/game/gamemodes/scripts';
function stubDep(rel) {
    const abs = require.resolve(rel, { paths: [scriptDir] });
    const m = new Module(abs, module);
    m.exports = {};
    m.loaded = true;
    require.cache[abs] = m;
}
for (const d of ['../../terrain/storm.js', '../../terrain/vault.js', '../../terrain/outposts.js', '../../terrain/gems.js']) stubDep(d);

global.Config = { dig_royale: true };
global.gameManager = { gameHandler: { bots: [] }, socketManager: { players: [] } };

const dr = require('/Users/raghavan/Documents/GitHub/Arras2/server/game/gamemodes/scripts/dig_royale.js');

let failures = 0;
const check = (name, cond) => {
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name);
    if (!cond) failures++;
};

const mkBot = (id, fam) => ({ id, name: 'Bot' + id, isBot: true, botFamilyId: fam, isDead: () => false, carriedGems: 0, royaleAlive: true });
const mkHuman = (sid, id) => ({ id, name: 'Me', isPlayer: true, socket: { id: sid, status: {} }, isDead: () => true, deathCause: '', finalKillers: [], carriedGems: 100, royaleAlive: true });

// 1. Bot K kills human V: credit + V marked on K. Must not throw (the old
// block-scoped `s` ReferenceError killed feed/credit/respawn silently).
const K = mkBot(2, 7);
const V = mkHuman('x1', 1);
V.finalKillers = [K];
dr.onCombatantDead(V);
let rows = dr.boardSnapshot();
let kRow = rows.find(r => r.name === 'Bot2');
let vRow = rows.find(r => r.name === 'Me');
check('killer credited 1 kill', kRow && kRow.kills === 1);
check('victim scored row exists', !!vRow);

// 2. V (respawned, same socket key) kills K back: avenge = 200 + 200 bonus.
const K2 = mkBot(2, 7); K2.isDead = () => true; K2.deathCause = '';
const V2 = mkHuman('x1', 9);
V2.carriedGems = 0;
V2.isDead = () => false;
K2.finalKillers = [V2];
K2.royaleAlive = true;
dr.onCombatantDead(K2);
rows = dr.boardSnapshot();
const vRow2 = rows.find(r => r.name === 'Me');
check('avenger has 1 kill', vRow2 && vRow2.kills === 1);
check('avenge pays double (400)', vRow2 && vRow2.score === 400);

// 3. Plain re-kill without a mark pays single.
const K3 = mkBot(5, 8); K3.isDead = () => true; K3.finalKillers = [V2]; K3.royaleAlive = true;
dr.onCombatantDead(K3);
rows = dr.boardSnapshot();
const vRow3 = rows.find(r => r.name === 'Me');
check('second victim: kills = 2', vRow3 && vRow3.kills === 2);
check('second victim pays single (600 total)', vRow3 && vRow3.score === 600);

// 4. Env death clears the mark: storm death sets nothing, no crash.
const V4 = mkHuman('x1', 10);
V4.deathCause = 'storm';
V4.royaleAlive = true;
dr.onCombatantDead(V4);
check('storm death does not throw', true);

console.log(failures ? `\n${failures} FAILURES` : '\nALL PASS');
process.exit(failures ? 1 : 0);
