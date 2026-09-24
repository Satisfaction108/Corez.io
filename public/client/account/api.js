// Thin client for the accounts HTTP API (Phase 1 contract).
// Every call resolves to { ok, status, data } and never throws: a network
// failure or timeout comes back as status 0 with a synthetic error body, so
// callers only ever branch on `ok` and read `data.error.code`.
const TIMEOUT_MS = 8000;

async function request(method, path, body) {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), TIMEOUT_MS) : 0;
    const opts = {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'X-DW': '1', 'Accept': 'application/json' },
        signal: ctl ? ctl.signal : undefined,
    };
    // Non-GET routes demand a JSON content type (CSRF gate), even with no fields.
    if (method !== 'GET') {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body || {});
    }
    try {
        const res = await fetch(path, opts);
        let data = null;
        if (res.status !== 204) {
            const text = await res.text();
            // An old server answers unknown paths with index.html; treat
            // anything that is not JSON as "no data".
            if (text) { try { data = JSON.parse(text); } catch (e) { data = null; } }
        }
        return { ok: res.ok, status: res.status, data };
    } catch (e) {
        const timeout = e && e.name === 'AbortError';
        return {
            ok: false, status: 0,
            data: { error: { code: timeout ? 'timeout' : 'network', message: timeout ? 'The server took too long to answer.' : 'Could not reach the server.' } },
        };
    } finally {
        if (timer) clearTimeout(timer);
    }
}

const get = (path) => request('GET', path);
const post = (path, body) => request('POST', path, body);

export const config = () => get('/api/config');
export const me = () => get('/api/me');

export const signup = (username, password) => post('/api/auth/signup', { username, password });
export const login = (username, password) => post('/api/auth/login', { username, password });
export const logout = () => post('/api/auth/logout', {});
export const logoutAll = () => post('/api/auth/logout-all', {});
export const usernameAvailable = (name) => get('/api/auth/username-available?name=' + encodeURIComponent(name));
export const recover = (username, recoveryCode, newPassword) => post('/api/auth/recover', { username, recoveryCode, newPassword });
export const reset = (token, newPassword) => post('/api/auth/reset', { token, newPassword });
export const reauthPassword = (currentPassword) => post('/api/auth/reauth', { currentPassword });
export const discordComplete = (username, password) => post('/api/auth/discord/complete', password ? { username, password } : { username });

export const changeUsername = (username, currentPassword) => post('/api/account/username', currentPassword ? { username, currentPassword } : { username });
export const changePassword = (currentPassword, newPassword) => post('/api/account/password', currentPassword ? { currentPassword, newPassword } : { newPassword });
export const regenRecoveryCode = (currentPassword) => post('/api/account/recovery-code', currentPassword ? { currentPassword } : {});
export const unlinkDiscord = (currentPassword) => post('/api/account/discord/unlink', { currentPassword });
export const deleteAccount = (currentPassword) => post('/api/account/delete', currentPassword ? { currentPassword, confirm: 'DELETE' } : { confirm: 'DELETE' });

// Discord OAuth is a full-page redirect, not a fetch.
export const discordStartUrl = (mode) => '/auth/discord/start?mode=' + encodeURIComponent(mode || 'login');

// Item Shop and Locker (Phase 3). Money routes carry an idempotency key so
// a retried click never charges twice.
export function idemKey() {
    const b = new Uint8Array(12);
    (window.crypto || window.msCrypto).getRandomValues(b);
    return 'k' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}
export const store = () => get('/api/store');
export const purchase = (itemId, day, idempotencyKey, color) => post('/api/store/purchase', color ? { itemId, day, idempotencyKey, color } : { itemId, day, idempotencyKey });
export const gift = (itemId, day, toUserId, idempotencyKey, preset) => post('/api/store/gift', { itemId, day, toUserId, idempotencyKey, preset });
export const refund = (purchaseId) => post('/api/store/refund', { purchaseId });
export const storeHistory = () => get('/api/store/history');
export const locker = () => get('/api/locker');
export const equip = (slot, itemId, color) => post('/api/locker/equip', color ? { slot, itemId, color } : { slot, itemId });
// Friends, profiles, the leaderboard and daily quests (Phases 4 and 5).
export const friends = () => get('/api/friends');
export const friendRequest = (username) => post('/api/friends/request', { username });
export const friendRespond = (userId, accept) => post('/api/friends/respond', { userId, accept: !!accept });
export const friendCancel = (userId) => post('/api/friends/cancel', { userId });
export const friendRemove = (userId) => post('/api/friends/remove', { userId });
export const friendBlock = (who) => post('/api/friends/block', /^DW-/i.test(String(who || '')) ? { userId: who } : { username: who });
export const friendUnblock = (userId) => post('/api/friends/unblock', { userId });
export const profile = (u) => get('/api/profile?u=' + encodeURIComponent(u));
export const leaderboard = (limit) => get('/api/leaderboard?limit=' + (limit || 100));
export const quests = () => get('/api/quests');
// Server-Sent Events: a URL, since EventSource does its own fetching.
export const EVENTS_URL = '/api/events';
