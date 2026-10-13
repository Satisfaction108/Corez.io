export const LONG_LIFE_MS = 10 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;
export const MAX_NOT_NOW = 2;
export const SHOWN_KEY = "dwLongLifeAskAt";
export const NO_KEY = "dwLongLifeNo";
export const TITLE = "That was a great run!";
export const HEADLINE = "Keep your progress?";

const read = (st, k) => { try { return +st.getItem(k) || 0; } catch (e) { return 0; } };
const write = (st, k, v) => { try { st.setItem(k, String(v)); } catch (e) { } };

export function lifeMs(o) {
    if (!o) return 0;
    const server = Math.max(0, (+o.serverSecs || 0) * 1000);
    const diedAt = +o.diedAt || 0, spawnedAt = +o.spawnedAt || 0;
    const client = spawnedAt !== 0 && diedAt > 0 && diedAt > spawnedAt ? diedAt - spawnedAt : 0;
    return Math.max(server, client);
}

export function decide(o, st) {
    if (!o || !o.guest || o.blocked) return false;
    if ((+o.lifeMs || 0) < LONG_LIFE_MS) return false;
    if (!st) return true;
    if (read(st, NO_KEY) >= MAX_NOT_NOW) return false;
    const now = +o.now || Date.now();
    const last = read(st, SHOWN_KEY);
    if (last > 0 && now - last < DAY_MS && now >= last) return false;
    return true;
}

export function markShown(st, now) {
    if (st) write(st, SHOWN_KEY, +now || Date.now());
}

export function notNow(st) {
    if (!st) return 0;
    const n = read(st, NO_KEY) + 1;
    write(st, NO_KEY, n);
    return n;
}

export function lastedText(ms) {
    const mins = Math.max(0, Math.floor((+ms || 0) / 60000));
    const plural = (n, w) => n + " " + w + (n === 1 ? "" : "s");
    if (mins < 60) return plural(mins, "minute");
    const h = Math.floor(mins / 60), m = mins % 60;
    return m ? plural(h, "hour") + " and " + plural(m, "minute") : plural(h, "hour");
}

export function body(ms) {
    return "You lasted " + lastedText(ms) + ". Make an account to keep your gemdust, rank and unlocks.";
}
