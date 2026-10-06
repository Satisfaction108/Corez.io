// The Shop's "View all" tab: every cosmetic in the catalog (skins, name styles
import { groups, counts, rewardTag, priceText, CAT_ORDER, CAT_LABEL } from './shopGalleryLogic.js';

const PW = 160, PH = 110;           // preview stage, css px (scales to the card)
let filter = 'all';                 // remembered while the page is up

// deps: { h, icon, clear ui.js helpers items the catalog (DWCosmetics.ITEMS)
export function render(el, deps) {
    const { h, clear } = deps;
    const items = deps.items || [];
    let owned = deps.owned instanceof Set ? deps.owned : null;
    const n = counts(items);
    if (filter !== 'all' && !n[filter]) filter = 'all';

    const chips = h('div', { class: 'gal-chips', role: 'group', 'aria-label': 'Show' });
    const list = h('div', { class: 'gal-list' });
    const root = h('div', { class: 'gal' },
        h('div', { class: 'gal-note', text: 'Everything in the game, for a look. Items come and go in the Shop tab.' }),
        chips, list);
    el.appendChild(root);

    const paintChips = () => {
        clear(chips);
        for (const k of ['all'].concat(CAT_ORDER).concat(Object.keys(n).filter((c) => c !== 'all' && CAT_ORDER.indexOf(c) < 0))) {
            if (!n[k]) continue;
            const on = filter === k;
            chips.appendChild(h('button', {
                type: 'button', class: 'gal-chip' + (on ? ' on' : ''), 'aria-pressed': on ? 'true' : 'false', 'data-cat': k,
                onclick: () => { if (filter === k) return; filter = k; paintChips(); paintList(); },
            }, h('span', { text: k === 'all' ? 'All' : (CAT_LABEL[k] || k) }), h('span', { class: 'gal-n', text: String(n[k]) })));
        }
    };

    // previews are drawn when a card first comes near the screen
    let io = null;
    const mountPrev = (well) => {
        if (well._dwDone) return;
        well._dwDone = true;
        const it = well._dwItem;
        let cv = null;
        try { cv = deps.preview(it, PW, PH); } catch (e) { cv = null; }
        if (cv) well.appendChild(cv);
    };
    const watch = (well) => {
        if (io) io.observe(well);
        else mountPrev(well);
    };

    const card = (it, has) => {
        const tag = rewardTag(it);
        const well = h('span', { class: 'shop-prev gal-prev' });
        well._dwItem = it;
        const foot = h('span', { class: 'shop-foot gal-foot' },
            tag ? h('span', { class: 'gal-tag', text: tag })
                : h('span', { class: 'shop-price gal-price' }, deps.icon ? deps.icon('dust') : null, h('span', { text: priceText(it.price) })));
        if (has) foot.appendChild(h('span', { class: 'shop-owned gal-owned', text: 'Owned' }));
        const c = h('div', { class: 'shop-card gal-card r-' + (it.rarity || 'common') + (has ? ' owned' : ''), role: 'listitem', 'data-id': it.id, 'aria-label': it.name },
            h('span', { class: 'shop-band' }),
            well,
            h('span', { class: 'shop-meta' },
                h('span', { class: 'shop-name', text: it.name }),
                // the section heading already says what kind of item it is
                h('span', { class: 'shop-sub' }, h('span', { class: 'shop-rar', text: deps.rarityName ? deps.rarityName(it.rarity) : it.rarity })),
                foot));
        c._dwFoot = foot;
        watch(well);
        return c;
    };

    const paintList = () => {
        if (deps.stop) deps.stop(list);
        if (io) io.disconnect();
        io = typeof IntersectionObserver === 'function' ? new IntersectionObserver((ents) => {
            for (const en of ents) if (en.isIntersecting) { io.unobserve(en.target); mountPrev(en.target); }
        }, { rootMargin: '240px 0px' }) : null;
        clear(list);
        for (const g of groups(items, owned, filter)) {
            list.appendChild(h('div', { class: 'shop-sec gal-sec', 'data-cat': g.cat },
                h('div', { class: 'shop-h' }, h('span', { text: g.label }), h('span', { class: 'gal-hn', text: String(g.items.length) })),
                h('div', { class: 'shop-grid gal', role: 'list' }, g.items.map((x) => card(x.item, x.owned)))));
        }
    };

    paintChips();
    paintList();

    // what you own can arrive after the first paint: stamp the cards in place
    if (deps.owned && typeof deps.owned.then === 'function') {
        deps.owned.then((set) => {
            if (!(set instanceof Set) || !root.isConnected) return;
            owned = set;
            list.querySelectorAll('.gal-card').forEach((c) => {
                const id = c.getAttribute('data-id');
                if (!set.has(id) || c.classList.contains('owned')) return;
                c.classList.add('owned');
                if (c._dwFoot) c._dwFoot.appendChild(h('span', { class: 'shop-owned gal-owned', text: 'Owned' }));
            });
        }, () => {});
    }
    return root;
}
