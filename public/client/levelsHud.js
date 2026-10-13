import { global } from "./global.js";
import { gameSound } from "./sound.js";

const S = { on: false, lv: 1, xp: 0, into: 0, need: 0, max: false, title: "", life: 0, next: "", guest: false, day: 0, cap: 0 };
const start = { lv: 1, into: 0 };
let card = null;
let cappedDay = -1;
const notes = [];

const dayNow = () => Math.floor(Date.now() / 86400000);

function body(line) {
    return String(line || "").replace(/^Level \d+!\s*/, "");
}

function bestUp(ups) {
    for (let i = ups.length - 1; i >= 0; i--) if (ups[i] && !/gemdust\.?$/.test(ups[i].line || "")) return ups[i];
    return ups[ups.length - 1];
}

function levelUp(ups) {
    const top = ups[ups.length - 1];
    const pick = bestUp(ups);
    const title = "Level " + (top.lv | 0) + "!";
    const sub = body(pick.line) || "";
    notes.push({ title, sub, lv: top.lv | 0, at: Date.now() });
    if (notes.length > 6) notes.shift();
    const list = global.callouts || (global.callouts = []);
    const prev = list.length ? list[list.length - 1].born : -1e9;
    list.push({ kind: "level", text: title, pts: 0, sub, dur: 4800, born: Math.max(performance.now(), prev + 700) });
    if (list.length > 5) list.shift();
    try { gameSound.rankUp(!!top.ms); } catch (e) { void e; }
}

function capNote() {
    const d = dayNow();
    if (cappedDay === d) return;
    cappedDay = d;
    if (typeof global.createMessage === "function") global.createMessage("That's all the XP for today. Come back tomorrow for more!", 6000);
}

export function receive(d) {
    if (!d || typeof d !== "object") return;
    const first = !S.on;
    S.on = true;
    S.lv = Math.max(1, d.lv | 0);
    S.xp = Math.max(0, d.xp | 0);
    S.into = Math.max(0, d.into | 0);
    S.need = Math.max(0, d.need | 0);
    S.max = !!d.max;
    S.title = String(d.title || "");
    S.life = Math.max(0, d.life | 0);
    S.next = String(d.next || "");
    S.guest = !!d.guest;
    S.day = d.day | 0;
    S.cap = d.cap | 0;
    if (first || d.adopted) { start.lv = S.lv; start.into = Math.max(0, S.into - S.life); }
    if (d.dead) {
        card = { at: performance.now(), lv: S.lv, into: S.into, need: S.need, max: S.max, life: S.life, next: S.next, guest: S.guest, from: start.lv < S.lv ? 0 : start.into, up: S.lv > start.lv };
        start.lv = S.lv;
        start.into = S.into;
    }
    if (Array.isArray(d.ups) && d.ups.length) levelUp(d.ups);
    if (d.capped) capNote();
}

export function state() { return S; }

export function deathCard(diedAt) {
    if (card && !(diedAt > 0 && card.at < diedAt - 1500)) return card;
    if (!S.on) return null;
    return { at: 0, lv: S.lv, into: S.into, need: S.need, max: S.max, life: S.life, next: S.next, guest: S.guest, from: start.lv < S.lv ? 0 : start.into, up: S.lv > start.lv };
}

export function newLife() { card = null; }

export function xpLine(c) {
    if (!c) return "";
    return c.max ? "Max level" : (c.into | 0).toLocaleString("en-US") + " / " + (c.need | 0).toLocaleString("en-US") + " XP";
}

window.dwLevelsHud = { receive, state, deathCard, newLife, notes: () => notes.slice() };
