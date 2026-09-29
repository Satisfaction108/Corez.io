// Client version tests: node scripts/test/clientVersion.test.js
//
//   dev       the public/ fingerprint holds still, then moves when a file is
//             touched, added or removed (after the 2 s rescan window)
//   build     follows .client-build.json: a rebuild moves it, a server with
//             the same build keeps it, a missing or torn manifest is safe
//   stamp     the menu page gets its <meta name="client-version"> in <head>
//
// Everything lives in a temp folder that is removed at the end.
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { clientVersion, stampHtml } = require('../../server/lib/clientVersion.js');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-version-test-'));
const pub = path.join(ROOT, 'public');
const build = path.join(ROOT, 'build');
fs.mkdirSync(path.join(pub, 'client'), { recursive: true });
fs.mkdirSync(build, { recursive: true });
fs.writeFileSync(path.join(pub, 'index.html'), '<html><head><title>x</title></head><body></body></html>');
fs.writeFileSync(path.join(pub, 'client', 'app.js'), 'export {};');

// the rescan window is Date.now based; step the clock instead of waiting
const realNow = Date.now;
let clock = realNow();
Date.now = () => clock;
const later = () => { clock += 2500; };
const bumpMtime = (file, s) => { const t = new Date(realNow() + s * 1000); fs.utimesSync(file, t, t); };

try {
    // dev
    {
        const get = clientVersion({ publicDir: pub });
        const a = get();
        assert.match(a, /^d[0-9a-f]{12}$/);
        later();
        assert.equal(get(), a, 'nothing changed');
        bumpMtime(path.join(pub, 'client', 'app.js'), 10);
        assert.equal(get(), a, 'inside the rescan window');
        later();
        const b = get();
        assert.notEqual(b, a, 'a touched file moves it');
        fs.writeFileSync(path.join(pub, 'client', 'new.js'), '');
        later();
        const c = get();
        assert.notEqual(c, b, 'a new file moves it');
        fs.rmSync(path.join(pub, 'client', 'new.js'));
        later();
        assert.equal(get(), b, 'removing it goes back');
        fs.writeFileSync(path.join(pub, '.DS_Store'), 'x');
        later();
        assert.equal(get(), b, 'dotfiles do not count');
        assert.equal(clientVersion({ publicDir: pub })(), b, 'a restart on the same files keeps it');
        console.log('dev ok');
    }

    // build
    {
        const manifest = path.join(build, '.client-build.json');
        const get = clientVersion({ publicDir: pub, buildDir: build });
        assert.equal(get(), 'nobuild');
        fs.writeFileSync(manifest, JSON.stringify({ builtAt: '2026-09-29T10:00:00.000Z', files: { 'client/app.js': 'aa' } }));
        later();
        const a = get();
        assert.match(a, /^b[0-9a-f]{12}$/);
        // public/ edits without a rebuild are not what production serves
        bumpMtime(path.join(pub, 'client', 'app.js'), 20);
        later();
        assert.equal(get(), a);
        assert.equal(clientVersion({ publicDir: pub, buildDir: build })(), a, 'a restart on the same build keeps it');
        fs.writeFileSync(manifest, JSON.stringify({ builtAt: '2026-09-29T11:00:00.000Z', files: { 'client/app.js': 'bb' } }));
        bumpMtime(manifest, 30);
        later();
        const b = get();
        assert.notEqual(b, a, 'a rebuild moves it');
        fs.writeFileSync(manifest, '{"builtAt": "2026-');
        bumpMtime(manifest, 40);
        later();
        assert.equal(get(), b, 'a torn manifest keeps the last good one');
        console.log('build ok');
    }

    // stamp
    {
        const out = stampHtml('<html><head><title>x</title></head><body></body></html>', 'b123');
        assert.ok(out.includes('<meta name="client-version" content="b123">\n</head>'));
        assert.equal(out.indexOf('client-version'), out.lastIndexOf('client-version'));
        assert.ok(stampHtml('<p>no head</p>', 'd1').startsWith('<meta name="client-version" content="d1">'));
        console.log('stamp ok');
    }
    console.log('clientVersion: all passed');
} finally {
    Date.now = realNow;
    fs.rmSync(ROOT, { recursive: true, force: true });
}
