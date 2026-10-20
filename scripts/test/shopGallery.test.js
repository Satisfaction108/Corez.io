// Shop "View all" gallery tests: node scripts/test/shopGallery.test.js
//
// The gallery (public/client/account/shopGallery.js) is look-only. Checked:
//   - the pure part (shopGalleryLogic.js): every live catalog item is in it,
//     retired ones are not, groups and sort order, reward tags, prices
//   - the module's source: no imports but the logic file, no network, no
//     purchase / gift / equip / refund call, no shop item window
//   - the DOM: it is rendered into a tiny fake document with the real ui.js
//     element builder and a fetch that fails the test if anything calls it;
//     then every element with a click listener is clicked. Only the
//     category chips may listen, cards are not buttons, nothing fetches.
//   - shop.js hands it no store API (its deps object)
// No server, no browser.
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const REPO = path.join(__dirname, '..', '..');
const ACC = path.join(REPO, 'public', 'client', 'account');
const C = require('../../shared/cosmetics.js');

let passed = 0, failed = 0;
async function test(name, fn) {
    try { await fn(); passed++; console.log('  ok  ' + name); }
    catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
}

/* ── a tiny DOM, just enough for ui.js h() and the gallery ─────────── */
class FakeNode {
    constructor() { this.childNodes = []; this.parentNode = null; }
    get firstChild() { return this.childNodes[0] || null; }
    appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); this.childNodes.push(c); c.parentNode = this; return c; }
    removeChild(c) { const i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); c.parentNode = null; return c; }
    get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n === docRoot; }
    get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
    set textContent(v) { this.childNodes.forEach((c) => { c.parentNode = null; }); this.childNodes = []; if (v !== '' && v != null) this.appendChild(new FakeText(String(v))); }
}
class FakeText extends FakeNode { constructor(t) { super(); this.data = t; } get textContent() { return this.data; } }
class FakeEl extends FakeNode {
    constructor(tag) {
        super();
        this.tagName = String(tag).toUpperCase();
        this.attrs = {};
        this.listeners = {};
        this.style = { setProperty() {} };
        this.dataset = {};
        const self = this;
        this.classList = {
            contains: (c) => (self.attrs.class || '').split(/\s+/).indexOf(c) >= 0,
            add: (c) => { if (!self.classList.contains(c)) self.attrs.class = ((self.attrs.class || '') + ' ' + c).trim(); },
            remove: (c) => { self.attrs.class = (self.attrs.class || '').split(/\s+/).filter((x) => x && x !== c).join(' '); },
            toggle: (c, on) => { if (on === undefined) on = !self.classList.contains(c); if (on) self.classList.add(c); else self.classList.remove(c); return on; },
        };
    }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    removeAttribute(k) { delete this.attrs[k]; }
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
    click() { for (const fn of this.listeners.click || []) fn({ type: 'click', currentTarget: this, target: this, preventDefault() {}, stopPropagation() {} }); }
    all() { const out = []; const walk = (n) => { for (const c of n.childNodes) if (c instanceof FakeEl) { out.push(c); walk(c); } }; walk(this); return out; }
    querySelectorAll(sel) {
        assert.ok(/^\.[\w-]+$/.test(sel), 'fake DOM only does .class selectors: ' + sel);
        const cls = sel.slice(1);
        return this.all().filter((e) => e.classList.contains(cls));
    }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}
const docRoot = new FakeEl('html');
global.Node = FakeNode;
global.document = {
    createElement: (t) => new FakeEl(t),
    createElementNS: (ns, t) => new FakeEl(t),
    createTextNode: (t) => new FakeText(t),
    addEventListener() {},
    body: docRoot,
};
global.window = global;
const fetches = [];
global.fetch = (...a) => { fetches.push(a); return Promise.reject(new Error('the gallery must not fetch')); };
global.XMLHttpRequest = function () { fetches.push(['xhr']); throw new Error('the gallery must not use XHR'); };

(async () => {
    const L = await import(pathToFileURL(path.join(ACC, 'shopGalleryLogic.js')).href);
    const live = C.ITEMS.filter((it) => !it.retired);

    console.log('logic');
    await test('every live item of every category is in the gallery, once', () => {
        const g = L.groups(C.ITEMS, null, 'all');
        const ids = g.flatMap((x) => x.items.map((y) => y.item.id));
        assert.equal(ids.length, live.length);
        assert.equal(new Set(ids).size, ids.length);
        const liveCats = C.CATS.filter((cat) => live.some((it) => it.cat === cat));
        for (const cat of liveCats) assert.ok(g.some((x) => x.cat === cat), 'missing category ' + cat);
        assert.deepEqual(g.map((x) => x.cat), L.CAT_ORDER.filter((c) => liveCats.includes(c)));
        assert.deepEqual(L.counts(C.ITEMS).all, live.length);
    });
    await test('retired items are left out, unknown categories go last', () => {
        const fake = [{ id: 'ns_a', cat: 'nameStyle', name: 'A', rarity: 'rare', price: 5000 },
            { id: 'ns_b', cat: 'nameStyle', name: 'B', rarity: 'rare', price: 5000, retired: true },
            { id: 'zz_c', cat: 'banner', name: 'C', rarity: 'epic', price: 9000 },
            { id: 'sk_d', cat: 'skin', name: 'D', rarity: 'common', price: 1000 }];
        const g = L.groups(fake, new Set(['zz_c']), 'all');
        assert.deepEqual(g.map((x) => x.cat), ['skin', 'nameStyle', 'banner']);
        assert.equal(g[1].items.length, 1);
        assert.equal(g[2].items[0].owned, true);
        assert.equal(g[0].items[0].owned, false);
        assert.deepEqual(L.groups(fake, null, 'skin').map((x) => x.cat), ['skin']);
    });
    await test('sorted by rarity (rarest first), then price (dearest first)', () => {
        for (const g of L.groups(C.ITEMS, null, 'all')) {
            const RK = { legendary: 0, epic: 1, rare: 2, uncommon: 3, common: 4 };
            for (let i = 1; i < g.items.length; i++) {
                const a = g.items[i - 1].item, b = g.items[i].item;
                assert.ok(RK[a.rarity] < RK[b.rarity] || (RK[a.rarity] === RK[b.rarity] && a.price >= b.price), g.cat + ': ' + a.id + ' before ' + b.id);
            }
        }
    });
    await test('reward-only items are tagged, the rest show a price', () => {
        assert.equal(L.rewardTag(C.byId('ns_corebreaker')), 'Achievement reward');
        assert.equal(L.rewardTag(C.byId('ns_ringleader')), 'Invite reward');
        assert.equal(L.rewardTag(C.byId('sk_void')), null);
        assert.equal(L.rewardTag({ id: 'x', exclusive: true, price: 0 }), 'Not sold');
        for (const it of live) if (!it.exclusive) assert.ok(it.price > 0 && L.rewardTag(it) === null, it.id);
        assert.equal(L.priceText(250000), '250');
        assert.equal(L.priceText(12500), '12.5');
    });

    console.log('source');
    const src = fs.readFileSync(path.join(ACC, 'shopGallery.js'), 'utf8');
    const code = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    await test('the gallery module has no purchase call and no network', () => {
        const imports = [...code.matchAll(/^\s*import\b[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
        assert.deepEqual(imports, ['./shopGalleryLogic.js'], 'only the pure logic may be imported');
        assert.ok(!/\bimport\s*\(/.test(code), 'no dynamic import');
        for (const bad of [/purchase/i, /\bgift/i, /\bequip/i, /refund/i, /\bbuy/i, /openItem/, /\bapi\b/, /\/api\//, /\bfetch\b/, /XMLHttpRequest/, /sendBeacon/, /WebSocket/, /EventSource/, /location\s*[.=]/]) {
            assert.ok(!bad.test(code), 'shopGallery.js mentions ' + bad);
        }
        const logic = fs.readFileSync(path.join(ACC, 'shopGalleryLogic.js'), 'utf8').replace(/\/\/.*$/gm, '');
        assert.ok(!/\bimport\b|fetch|purchase|\/api\//.test(logic), 'the logic file is pure');
    });
    await test('shop.js hands the gallery no store API', () => {
        const shop = fs.readFileSync(path.join(ACC, 'shop.js'), 'utf8');
        const m = /function galleryDeps\(\) \{([\s\S]*?)\n\}/.exec(shop);
        assert.ok(m, 'galleryDeps in shop.js');
        assert.ok(!/purchase|gift|equip|openItem|refund|doBuy|api\./.test(m[1]), 'galleryDeps: ' + m[1]);
        assert.ok(/\['all', 'View all'\]/.test(shop), 'the View all tab');
        assert.ok(/tab === 'all'\) \{ gallery\.render\(body, galleryDeps\(\)\); return; \}/.test(shop), 'the tab renders only the gallery');
    });

    console.log('dom');
    const ui = await import(pathToFileURL(path.join(ACC, 'ui.js')).href);
    const gallery = await import(pathToFileURL(path.join(ACC, 'shopGallery.js')).href);
    const previews = [];
    const deps = (owned) => ({
        h: ui.h, icon: ui.icon, clear: ui.clear,
        items: C.ITEMS,
        preview: (it, w, h) => { previews.push(it.id); const cv = new FakeEl('canvas'); cv.setAttribute('class', 'dw-prev'); return cv; },
        stop() {},
        owned,
        rarityName: (r) => (C.RARITIES[r] || {}).name,
    });
    const el = new FakeEl('div');
    docRoot.appendChild(el);
    let resolveOwned;
    const ownedP = new Promise((r) => { resolveOwned = r; });
    gallery.render(el, deps(ownedP));

    await test('one card per live item, every one with its preview, name, rarity and price or tag', () => {
        const cards = el.querySelectorAll('.gal-card');
        assert.equal(cards.length, live.length);
        assert.equal(previews.length, live.length, 'no IntersectionObserver here, so every preview mounts');
        for (const c of cards) {
            const it = C.byId(c.getAttribute('data-id'));
            assert.ok(it && !it.retired, 'card for ' + c.getAttribute('data-id'));
            assert.ok(c.classList.contains('r-' + it.rarity), it.id + ' rarity colour');
            assert.ok(c.querySelector('.dw-prev'), it.id + ' preview');
            assert.equal(c.querySelector('.shop-name').textContent, it.name);
            assert.equal(c.querySelector('.shop-rar').textContent, C.RARITIES[it.rarity].name);
            const foot = c.querySelector('.gal-foot').textContent;
            if (it.exclusive) assert.ok(/reward|Not sold/.test(foot), it.id + ' tag: ' + foot);
            else assert.ok(foot.includes(L.priceText(it.price)), it.id + ' price: ' + foot);
        }
    });
    await test('cards are not buttons and nothing but the chips listens for clicks', () => {
        for (const e of el.all()) {
            const hasClick = !!(e.listeners.click && e.listeners.click.length);
            if (e.tagName === 'BUTTON' || hasClick) assert.ok(e.classList.contains('gal-chip'), 'clickable non-chip: ' + e.tagName + ' ' + e.getAttribute('class'));
        }
        for (const c of el.querySelectorAll('.gal-card')) {
            assert.equal(c.tagName, 'DIV');
            assert.ok(!c.all().some((x) => x.tagName === 'BUTTON' || x.tagName === 'A' || x.tagName === 'FORM'), 'no control inside a card');
        }
    });
    await test('clicking every clickable element (and every card) fetches nothing', () => {
        const before = previews.length;
        for (let round = 0; round < 2; round++) {
            for (const e of el.all()) e.click();
        }
        // ...and the chips really filter
        const chip = el.querySelectorAll('.gal-chip').find((b) => b.getAttribute('data-cat') === 'sidekick');
        chip.click();
        assert.equal(el.querySelectorAll('.gal-sec').length, 1);
        assert.equal(el.querySelectorAll('.gal-card').length, live.filter((x) => x.cat === 'sidekick').length);
        el.querySelectorAll('.gal-chip').find((b) => b.getAttribute('data-cat') === 'all').click();
        assert.equal(el.querySelectorAll('.gal-card').length, live.length);
        assert.ok(previews.length > before);
        assert.equal(fetches.length, 0, 'fetch/XHR calls: ' + JSON.stringify(fetches));
    });
    await test('what you own arrives later and is stamped Owned in place', async () => {
        resolveOwned(new Set(['sk_void', 'ns_corebreaker']));
        await ownedP; await new Promise((r) => setImmediate(r));
        const owned = el.querySelectorAll('.gal-card').filter((c) => c.classList.contains('owned')).map((c) => c.getAttribute('data-id')).sort();
        assert.deepEqual(owned, ['ns_corebreaker', 'sk_void']);
        assert.equal(el.querySelectorAll('.gal-owned').length, 2);
        assert.equal(fetches.length, 0);
    });
    await test('a guest (owned null) gets the same gallery, nothing owned', () => {
        const g = new FakeEl('div');
        docRoot.appendChild(g);
        gallery.render(g, deps(null));
        assert.equal(g.querySelectorAll('.gal-card').length, live.length);
        assert.equal(g.querySelectorAll('.gal-owned').length, 0);
        assert.equal(fetches.length, 0);
    });

    console.log(failed ? `${failed} failed, ${passed} passed` : `all ${passed} passed`);
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
