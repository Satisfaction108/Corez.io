export const KICK_SHARE = 0.16;
export const KICK_IN_MS = 28;
export const KICK_OUT_MS = 120;
export const KICK_MS = KICK_IN_MS + KICK_OUT_MS;

export function kickAt(ms, from) {
    if (!(ms >= 0) || ms >= KICK_MS) return 0;
    if (ms < KICK_IN_MS) {
        const k = ms / KICK_IN_MS;
        return from + (1 - from) * k * (2 - k);
    }
    const v = 1 - (ms - KICK_IN_MS) / KICK_OUT_MS;
    return v * v;
}
