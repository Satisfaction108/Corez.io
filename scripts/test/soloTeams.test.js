// Solo raid team ids: node scripts/test/soloTeams.test.js
//
// On the solo server every combatant is a team of one. Team ids used to be a
// plain random pick (-200..-3199), so a bot or a respawning player could roll
// the id of someone alive, and the two of them became a team: no damage
// between them, one colour, on each other's minimap. It looked like a duo in
// Solo. Every royale spawn now takes its id from duoRaid.freshTeamId.
//
//   pool       freshTeamId never hands out a live player's or bot's id, even
//              when the random roll keeps landing on it
//   raid       an id isn't reused within a raid (dead bodies keep board rows);
//              newRaid frees them, except the ones still alive
//   solo       with duos off the book stays empty and nobody gets a mate
//   wiring     the solo spawn paths (human spawn, raid bots, raid start) use
//              the pool and no longer call the raw random pick
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SERVER = path.join(__dirname, '..', '..', 'server');
global.Config = { dig_royale: true };
global.entities = new Map();
global.gameManager = { socketManager: { clients: [] }, room: { width: 4000, height: 4000 }, terrainGrid: null };

// a rigged roll: replays `rolls`, then falls back to a counter
let rolls = [];
let next = -200;
global.getRandomTeam = () => rolls.length ? rolls.shift() : next--;

const duoRaid = require(path.join(SERVER, 'game', 'duo', 'duoRaid.js'));

let nextId = 1;
function body(team, kind = 'bot') {
    const b = { id: nextId++, team, isBot: kind === 'bot', isPlayer: kind === 'player', dead: false, isDead() { return this.dead; } };
    global.entities.set(b.id, b);
    return b;
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('pool: a live player\'s id is skipped even if the roll keeps hitting it', () => {
    global.entities.clear();
    duoRaid.newRaid();
    const you = body(-777, 'player');
    rolls = [-777, -777, -777, -778];
    const t = duoRaid.freshTeamId();
    assert.notEqual(t, you.team);
    assert.equal(t, -778);
});

test('pool: a live bot\'s id is skipped too', () => {
    global.entities.clear();
    duoRaid.newRaid();
    const bot = body(-900, 'bot');
    rolls = [-900, -901];
    assert.equal(duoRaid.freshTeamId(), -901);
    assert.notEqual(bot.team, -901);
});

test('pool: a whole raid of spawns gets distinct ids', () => {
    global.entities.clear();
    duoRaid.newRaid();
    const seen = new Set();
    for (let i = 0; i < 400; i++) {
        // the old pick, squeezed onto 20 values so it collides constantly
        rolls = [-200 - Math.floor(Math.random() * 20)];
        const t = duoRaid.freshTeamId();
        assert.ok(!seen.has(t), 'reused ' + t);
        seen.add(t);
        body(t, i % 7 ? 'bot' : 'player');
    }
});

test('raid: a dead body\'s id stays taken until the next raid', () => {
    global.entities.clear();
    duoRaid.newRaid();
    rolls = [-1234];
    const t = duoRaid.freshTeamId();
    const b = body(t);
    b.dead = true;
    global.entities.delete(b.id);
    rolls = [-1234, -1235];
    assert.equal(duoRaid.freshTeamId(), -1235);
    duoRaid.newRaid();
    rolls = [-1234];
    assert.equal(duoRaid.freshTeamId(), -1234);
});

test('raid: newRaid keeps the ids of bodies still alive', () => {
    global.entities.clear();
    duoRaid.newRaid();
    rolls = [-1500];
    const t = duoRaid.freshTeamId();
    body(t, 'player');
    duoRaid.newRaid();
    rolls = [-1500, -1501];
    assert.equal(duoRaid.freshTeamId(), -1501);
});

test('solo: the team book stays empty and nobody has a mate', () => {
    assert.equal(duoRaid.on(), false);
    assert.equal(duoRaid.book.teams.size, 0);
    const b = body(duoRaid.freshTeamId(), 'player');
    b.socket = { duoKey: null };
    assert.equal(duoRaid.teamKeyOf(b), null);
    assert.equal(duoRaid.mateBody(b), null);
});

test('wiring: solo spawns take their team from the pool', () => {
    const sockets = fs.readFileSync(path.join(SERVER, 'game', 'network', 'sockets.js'), 'utf8');
    const royale = fs.readFileSync(path.join(SERVER, 'game', 'gamemodes', 'scripts', 'dig_royale.js'), 'utf8');
    assert.match(sockets, /else if \(Config\.dig_royale\) \{[\s\S]{0,400}?duoRaid\.js'\)\.freshTeamId\(\)/,
        'the human spawn branch has no solo pool pick');
    const bot = royale.slice(royale.indexOf('function spawnRaidBot'), royale.indexOf('function spawnTeamBot'));
    assert.ok(bot.length > 0, 'spawnRaidBot not found');
    assert.doesNotMatch(bot, /getRandomTeam/, 'raid bots still roll a raw random team');
    assert.match(bot, /duo\.freshTeamId\(\)/);
    const start = royale.slice(royale.indexOf('function startRaid'), royale.indexOf('function startRaid') + 800);
    assert.match(start, /\n\s*try \{ duo\.newRaid\(\); \}/, 'startRaid must free team ids on every server');
});

let failed = 0;
for (const t of tests) {
    try { t.fn(); console.log('ok   ' + t.name); }
    catch (e) { failed++; console.log('FAIL ' + t.name + '\n     ' + (e && e.stack || e)); }
}
console.log(failed ? failed + ' failed' : 'all ' + tests.length + ' passed');
process.exit(failed ? 1 : 0);
