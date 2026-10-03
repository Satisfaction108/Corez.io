// Where the dash and ability chips sit in their row (a per-browser layout
// choice, rearranged by drag and drop). The keys never change, only the
// order. No DOM, so the tests can load it.
export const ORDER_KEY = "dwChipOrder_v1";
export const CHIPS = ["dash", "ability"];

// a stored "ability,dash" -> ["ability", "dash"]; anything odd -> the default
export function parseOrder(str) {
    const parts = String(str == null ? "" : str).split(",").map(s => s.trim());
    if (parts.length !== CHIPS.length || CHIPS.some(id => !parts.includes(id))) return CHIPS.slice();
    return parts;
}
// a and b trade places (unknown ids leave it as it was)
export function swapOrder(order, a, b) {
    const out = parseOrder(order.join(","));
    const i = out.indexOf(a), j = out.indexOf(b);
    if (i < 0 || j < 0 || i === j) return out;
    out[i] = b; out[j] = a;
    return out;
}
export function loadOrder(store) {
    try { return parseOrder(store.getItem(ORDER_KEY)); } catch (e) { return CHIPS.slice(); }
}
export function saveOrder(store, order) {
    try { store.setItem(ORDER_KEY, parseOrder(order.join(",")).join(",")); } catch (e) { /* storage blocked: this session only */ }
}
