// Thin client for the accounts HTTP API.
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
    // a guest's duo party identity (party.js keeps it per tab)
    if (partyGuest && path.startsWith('/api/party')) opts.headers['X-Party-Guest'] = partyGuest;
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
            // A server without the accounts API answers unknown paths with
            // index.html; anything that is not JSON counts as "no data".
            if (text) { try { data = JSON.parse(text); } catch (e) { data = null; } }
        }
        return { ok: res.ok, status: res.status, data };
    } catch (e) {
        const timeout = e && e.name === 'AbortError';
        return {
            ok: false, status: 0,
            data: { error: { code: timeout ? 'timeout' : 'network', message: timeout ? 'The server is taking too long to answer.' : 'Couldn’t reach the server.' } },
        };
    } finally {
        if (timer) clearTimeout(timer);
    }
}

let partyGuest = '';
export function setPartyGuest(token) { partyGuest = typeof token === 'string' ? token : ''; }

const get = (path) => request('GET', path);
const post = (path, body) => request('POST', path, body);

export const config = () => get('/api/config');
export const sendFeedback = (body) => post('/api/feedback', body);
export const me = () => get('/api/me');

// An invite code this browser arrived with (invite.js), sent with a sign-up.
let refSource = () => '';
export function setRefSource(fn) { refSource = typeof fn === 'function' ? fn : () => ''; }
function withRef(body) {
    let ref = '';
    try { ref = refSource() || ''; } catch (e) { ref = ''; }
    return ref ? Object.assign(body, { ref }) : body;
}

export const signup = (username, password) => post('/api/auth/signup', withRef({ username, password }));
// one tap "Keep my stuff": no password, this browser stays logged in
export const quickSignup = (username) => post('/api/auth/quick', withRef({ username }));
export const login = (username, password) => post('/api/auth/login', { username, password });
export const logout = () => post('/api/auth/logout', {});
export const logoutAll = () => post('/api/auth/logout-all', {});
export const usernameAvailable = (name) => get('/api/auth/username-available?name=' + encodeURIComponent(name));
export const recover = (username, recoveryCode, newPassword) => post('/api/auth/recover', { username, recoveryCode, newPassword });
export const reset = (token, newPassword) => post('/api/auth/reset', { token, newPassword });
export const reauthPassword = (currentPassword) => post('/api/auth/reauth', { currentPassword });
export const discordComplete = (username, password) => post('/api/auth/discord/complete', withRef(password ? { username, password } : { username }));

export const changeUsername = (username, currentPassword) => post('/api/account/username', currentPassword ? { username, currentPassword } : { username });
export const changePassword = (currentPassword, newPassword) => post('/api/account/password', currentPassword ? { currentPassword, newPassword } : { newPassword });
export const regenRecoveryCode = (currentPassword) => post('/api/account/recovery-code', currentPassword ? { currentPassword } : {});
export const unlinkDiscord = (currentPassword) => post('/api/account/discord/unlink', { currentPassword });
export const deleteAccount = (currentPassword) => post('/api/account/delete', currentPassword ? { currentPassword, confirm: 'DELETE' } : { confirm: 'DELETE' });

// Discord OAuth is a full-page redirect, not a fetch.
export const discordStartUrl = (mode) => '/auth/discord/start?mode=' + encodeURIComponent(mode || 'login');

// Item Shop and Locker. Money routes carry an idempotency key so
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
// {sidekick, sdSkin, sdName, name, color}: the Locker's Sidekick panel in one go
export const saveSidekick = (body) => post('/api/locker/sidekick', body);
// Friends, profiles, the leaderboard and daily quests.
export const friends = () => get('/api/friends');
export const friendRequest = (username) => post('/api/friends/request', { username });
export const friendRespond = (userId, accept) => post('/api/friends/respond', { userId, accept: !!accept });
export const friendCancel = (userId) => post('/api/friends/cancel', { userId });
export const friendRemove = (userId) => post('/api/friends/remove', { userId });
export const friendBlock = (who) => post('/api/friends/block', /^DW-/i.test(String(who || '')) ? { userId: who } : { username: who });
export const friendUnblock = (userId) => post('/api/friends/unblock', { userId });

export const friendMessages = (userId, before) => get('/api/friends/messages?userId=' + encodeURIComponent(userId) + (before ? '&before=' + encodeURIComponent(before) : '') + '&limit=50');
export const friendSend = (userId, body) => post('/api/friends/messages', { userId, body });
export const friendRead = (userId, upTo) => post('/api/friends/messages/read', { userId, upTo });
export const profile = (u) => get('/api/profile?u=' + encodeURIComponent(u));
export const leaderboard = (limit, type) => get('/api/leaderboard?limit=' + (limit || 100) + (type && type !== 'ranked' ? '&type=' + type : ''));
export const quests = () => get('/api/quests');
// achievements for an account, or this browser's guest id (POST: never in a URL)
export const achievements = (guestId) => post('/api/achievements', guestId ? { guestId } : {});
export const invite = () => get('/api/invite');
// The daily rewards track and push pings (guests send their browser's guest
// id in the body, never in the URL).
export const daily = (guestId) => post('/api/daily', guestId ? { guestId } : {});
export const dailyClaim = (guestId) => post('/api/daily/claim', guestId ? { guestId } : {});
export const pushSubscribe = (body) => post('/api/push/subscribe', body);
export const pushUnsubscribe = (endpoint) => post('/api/push/unsubscribe', { endpoint });
// Server-Sent Events: a URL, since EventSource does its own fetching.
export const EVENTS_URL = '/api/events';
// Duo parties (guests too: they carry the X-Party-Guest token set above).
export const party = () => get('/api/party');
export const partyCreate = (name) => post('/api/party/create', { name });
export const partyJoin = (code, name) => post('/api/party/join', { code, name });
export const partyInvite = (userId) => post('/api/party/invite', { userId });
export const partyInviteCancel = (id) => post('/api/party/invite/cancel', { id });
export const partyRespond = (id, accept) => post('/api/party/respond', { id, accept: !!accept });
export const partyLeave = () => post('/api/party/leave', {});
export const partyLaunch = (fill) => post('/api/party/launch', { fill: !!fill });
export const partyTicket = (fill) => post('/api/party/ticket', { fill: !!fill });
