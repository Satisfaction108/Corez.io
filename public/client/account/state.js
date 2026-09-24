// Tiny shared store for the account UI. Views subscribe with on() and get
// the full state plus the keys that changed.
const state = {
    config: null,     // { accounts, discordLogin, publicOrigin } or null when unknown
    user: null,       // User from /api/me, or null
    pending: null,    // pendingDiscord { name, avatarUrl } during Discord sign-up
    mode: 'new',      // 'new' | 'guest' | 'user' - mirrors <html data-acct>
    offline: false,   // accounts API missing, disabled or unreachable
};
const subs = new Set();

export function get(key) {
    return key ? state[key] : state;
}

export function set(patch) {
    const changed = [];
    for (const k in patch) {
        if (state[k] !== patch[k]) { state[k] = patch[k]; changed.push(k); }
    }
    if (changed.length) subs.forEach((fn) => { try { fn(state, changed); } catch (e) { console.error(e); } });
}

export function on(fn) {
    subs.add(fn);
    return () => subs.delete(fn);
}
