// Swear and slur filter: node scripts/test/profanity.test.js
//
//   catches    plain, stretched, spaced, dotted, leet, camelCase in names
//   passes     the Scunthorpe list (class, assassin, grapple, therapist...)
//   mask       chat keeps its shape, bad words become asterisks
//   names      guests under 5 characters, rude or empty play as "Guest#1234";
//              account usernames are refused; the server paths use it
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..', '..');
const P = require(path.join(REPO, 'shared', 'profanity.js'));

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('catches swears and slurs, stretched, spaced, dotted and in leetspeak', () => {
    for (const s of ['fuck', 'FUCK you', 'fuuuuuck', 'f u c k', 'f.u.c.k', 'f-u-c-k', 'phuck', 'motherfucker', 'sh1t', '5h!t',
        'shiiiit', 'bullshit', 'b1tch', 'b i t c h', '@ss', 'a$$', 'cunt', 'C U N T', 'n1gger', 'n i g g a', 'f@ggot', 'faggots',
        'dickhead', 'asshole', 'a55hole', 'whore', 'slut', 'rapist', 'retarded', 'kys', 'pussy', 'tits', 'fuk', 'twat']) {
        assert.ok(P.hasProfanity(s), 'should catch: ' + s);
    }
});

test('passes ordinary words (no Scunthorpe problem)', () => {
    for (const s of ['class', 'classic', 'assassin', 'Scunthorpe', 'grapple', 'therapist', 'cocktail', 'cockpit', 'saltwater',
        'passage', 'bass', 'assess', 'assume', 'Sussex', 'spicy', 'title', 'titan', 'grapes', 'drape', 'scrape', 'Dickens',
        'Hancock', 'peacock', 'shiitake', 'Matsushita', 'Yamashita', 'cucumber', 'raccoon', 'cocoon', 'analysis', 'glass',
        'pistol', 'snigger', 'hello there', 'good game', 'Corez rocks', 'Grapple Hook', 'Launch Pad']) {
        assert.equal(P.hasProfanity(s), false, 'should pass: ' + s);
    }
});

test('names: camelCase, underscores and digits do not hide a word', () => {
    for (const s of ['BigShitGuy', 'big_ass_guy', 'xXfuckXx', 'Fuck123', 'iAmACunt', 'n1gg4']) assert.ok(P.hasProfanity(s), s);
    for (const s of ['ClassAct', 'Assassin_99', 'GrappleKing', 'BassDrop', 'TitanFall']) assert.equal(P.hasProfanity(s), false, s);
});

test('chat: bad words become asterisks, the rest of the line stays', () => {
    assert.equal(P.mask('what the fuck'), 'what the ****');
    assert.equal(P.mask('you are a f u c k ing bitch'), 'you are a * * * * ing *****');
    assert.equal(P.mask('nice class, assassin!'), 'nice class, assassin!');
    assert.equal(P.mask('sh1t happens'), '**** happens');
    assert.equal(P.mask('gg'), 'gg');
    assert.equal(P.mask(''), '');
});

test('guest names: at least 5 characters and nothing rude, else "Guest#1234"', () => {
    assert.equal(P.MIN_NAME, 5);
    const isGuest = (n) => /^Guest#\d{4}$/.test(n);
    assert.ok(isGuest(P.guestName('abcd')), 'four characters');
    assert.ok(isGuest(P.guestName('   abc   ')), 'trimmed first');
    assert.ok(isGuest(P.guestName('')), 'empty');
    assert.equal(P.guestName('  Bobby '), 'Bobby');
    assert.ok(isGuest(P.guestName('ShitLord')), 'rude');
    // the same player keeps the same number
    const sock = {};
    assert.equal(P.guestName('', sock), P.guestName('abc', sock));
    assert.equal(P.nameProblem('abc'), 'short');
    assert.equal(P.nameProblem('Fuckface'), 'rude');
    assert.equal(P.nameProblem('Grapple'), null);
});

test('account usernames are refused with a clear message', () => {
    const names = require(path.join(REPO, 'server', 'accounts', 'names.js'));
    const v = names.validateUsername('xXfuckXx');
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'profanity');
    assert.match(v.message, /Pick another/);
    assert.equal(names.validateUsername('a_s_s_h_o_l_e'.slice(0, 16)).ok, false);
    assert.equal(names.validateUsername('Assassin_99').ok, true);
    assert.equal(names.validateUsername('GrappleKing').ok, true);
});

test('wiring: raid names, in-game chat, friend chat, party guests, the shared file and the client hint', () => {
    const read = (...p) => fs.readFileSync(path.join(REPO, ...p), 'utf8');
    const so = read('server', 'game', 'network', 'sockets.js');
    assert.match(so, /message = profanity\.mask\(message\);/, 'in-game chat masked for everyone');
    assert.match(so, /else name = profanity\.guestName\(name, socket\);/);
    const br = read('server', 'accounts', 'game', 'bridge.js');
    assert.match(br, /clean = profanity\.guestName\(clean, socket\);/, 'guests in raids');
    assert.match(br, /profanity\.hasProfanity\(socket\.account\.username\) \? profanity\.fallbackName\(socket\)/, 'old account names too');
    assert.match(read('server', 'accounts', 'messages.js'), /profanity\.js'\)\.mask\(sanitizeMessage/, 'friend chat');
    assert.match(read('server', 'accounts', 'party.js'), /hasProfanity\(s\)\) s = ''/, 'party guest names');
    assert.match(read('server', 'accounts', 'index.js'), /SHARED_FILES = new Set\(\[[^\]]*'profanity\.js'/, 'served to the client');
    assert.match(read('public', 'index.html'), /<script src="\/shared\/profanity\.js"><\/script>/);
    assert.match(read('public', 'client', 'nameHint.js'), /at least " \+ p\.MIN_NAME \+ " characters/);
    assert.ok(!read('shared', 'profanity.js').includes(String.fromCharCode(0x2014)), 'no em dashes');
});

(async () => {
    let failed = 0;
    for (const t of tests) {
        try { await t.fn(); console.log('ok   ' + t.name); }
        catch (e) { failed++; console.log('FAIL ' + t.name + '\n     ' + String(e && e.stack || e).split('\n').slice(0, 4).join('\n     ')); }
    }
    console.log(failed ? `${failed} of ${tests.length} failed` : `all ${tests.length} passed`);
    process.exit(failed ? 1 : 0);
})();
