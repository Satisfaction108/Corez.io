// The Shop's "View all" gallery, the pure part (no DOM, no network): which

// heading order, and the chip / heading text of each category
export const CAT_ORDER = ['skin', 'nameStyle', 'sidekick', 'sdSkin', 'sdName'];
export const CAT_LABEL = {
    skin: 'Skins', nameStyle: 'Name styles', sidekick: 'Sidekicks', sdSkin: 'Sidekick skins', sdName: 'Sidekick names',
};
const RARITY_RANK = { legendary: 0, epic: 1, rare: 2, uncommon: 3, common: 4 };
const rank = (r) => (r in RARITY_RANK ? RARITY_RANK[r] : 5);

// Rarest first, then dearest first, then by name
export function compare(a, b) {
    return rank(a.rarity) - rank(b.rarity) || (+b.price || 0) - (+a.price || 0) || String(a.name).localeCompare(String(b.name));
}

// Not for sale: an invite or achievement reward ("exclusive")
export const notSold = (it) => !!(it && (it.exclusive || !(+it.price > 0)));

// The tag beside the price line, or null
export function rewardTag(it) {
    if (!notSold(it)) return null;
    if (it.earn) return 'Achievement reward';
    if (it.id === 'ns_ringleader') return 'Invite reward';
    return 'Not sold';
}

// "250" / "12.5" gemdust from milli-dust, as plain text
export function priceText(milli) {
    const v = (+milli || 0) / 1000;
    return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
}

// > [{ cat, label, items: [{ item, owned }] }] in CAT_ORDER, empty groups dropped
export function groups(items, owned, only) {
    const has = owned && typeof owned.has === 'function' ? (id) => owned.has(id) : () => false;
    const by = new Map();
    for (const it of items || []) {
        if (!it || it.retired || !it.id || !it.cat) continue;
        if (!by.has(it.cat)) by.set(it.cat, []);
        by.get(it.cat).push(it);
    }
    const cats = CAT_ORDER.filter((c) => by.has(c)).concat([...by.keys()].filter((c) => CAT_ORDER.indexOf(c) < 0));
    const out = [];
    for (const cat of cats) {
        if (only && only !== 'all' && only !== cat) continue;
        const list = by.get(cat).slice().sort(compare);
        out.push({ cat, label: CAT_LABEL[cat] || cat, items: list.map((item) => ({ item, owned: has(item.id) })) });
    }
    return out;
}

// how many items each chip stands for: { all, skin, nameStyle, ... }
export function counts(items) {
    const c = { all: 0 };
    for (const it of items || []) {
        if (!it || it.retired || !it.cat) continue;
        c.all++;
        c[it.cat] = (c[it.cat] || 0) + 1;
    }
    return c;
}
