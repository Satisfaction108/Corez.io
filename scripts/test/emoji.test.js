// Chat emoji shortcodes: node scripts/test/emoji.test.js
//
//   convert   ":fire:" turns into the emoji, any case; unknown names and
//             plain colons ("12:30", "a: b") stay as typed
//   search    names that start with the query come first, at most 6
//   picker    one letter after the colon is enough, at most 3 at a time
//   jumbo     a message of 1-3 emoji and nothing else reads big (Discord)
'use strict';

const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

(async () => {
    const m = await import(pathToFileURL(path.join(__dirname, '..', '..', 'public', 'client', 'emoji.js')).href);
    let failed = 0;
    const test = (name, fn) => { try { fn(); console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + e.message); } };

    test('convert: known names, any case', () => {
        assert.equal(m.convert('gg :fire: :SKULL:'), 'gg 🔥 💀');
        assert.equal(m.convert(':+1: :100:'), '👍 💯');
    });
    test('convert: leaves everything else alone', () => {
        assert.equal(m.convert('meet at 12:30:00'), 'meet at 12:30:00');
        assert.equal(m.convert('a: b :nope: c'), 'a: b :nope: c');
        assert.equal(m.convert(''), '');
    });
    test('search: prefix matches first, capped', () => {
        const r = m.search('fi');
        assert.ok(r.length <= 6 && r.length > 0);
        assert.ok(r[0].name.startsWith('fi'));
        assert.ok(r.some(x => x.name === 'fire'));
        assert.deepEqual(m.search(''), []);
        assert.deepEqual(m.search('zzzzqq'), []);
    });
    test('picker: one letter is enough, three at a time', () => {
        const r = m.search('s', 3);
        assert.equal(r.length, 3);
        assert.ok(r.every(x => x.name.includes('s')));
        assert.ok(m.search('s', 3).length <= 3);
    });
    test('jumbo: only emoji, one to three', () => {
        assert.deepEqual(m.emojiOnly('💀'), ['💀']);
        assert.deepEqual(m.emojiOnly(' 💀  ☠️ '), ['💀', '☠️']);
        assert.equal(m.emojiOnly('💀 💀 💀 💀'), null, 'four is prose');
        assert.equal(m.emojiOnly('gg 💀'), null);
        assert.equal(m.emojiOnly('12:30'), null);
        assert.equal(m.emojiOnly(''), null);
    });
    console.log(failed ? failed + ' failed' : 'all 6 passed');
    process.exitCode = failed ? 1 : 0;
})();
