// The owner's spectator: ` + G on a tank (server keyCommands.js inspect,
// dig_royale.js inspectOf) sends INS with everything about it. The sheet
// stays up until Esc, the close button or the next one.

const st = { el: null };

const num = (n) => (Math.round(n) || 0).toLocaleString();
function dur(ms) {
    const s = Math.max(0, Math.round((ms || 0) / 1000));
    const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, r = s % 60;
    if (h) return h + "h " + m + "m";
    if (m) return m + "m " + r + "s";
    return r + "s";
}

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
}

function section(root, title, rows) {
    root.appendChild(el("div", "ins-h", title));
    if (!rows.length) { root.appendChild(el("div", "ins-none", "None")); return; }
    for (const [k, v] of rows) {
        const row = el("div", "ins-row");
        row.appendChild(el("span", "ins-k", k));
        row.appendChild(el("span", "ins-v", v));
        root.appendChild(row);
    }
}

function close() {
    if (st.el) st.el.remove();
    st.el = null;
}

function show(d) {
    close();
    const root = el("div", "");
    root.id = "dwInspect";
    const head = el("div", "ins-top");
    const title = el("div", "ins-title");
    title.appendChild(el("b", "", d.name));
    title.appendChild(el("span", "ins-sub", [d.who, d.tank, "Level " + d.level, "#" + d.id].filter(Boolean).join("  ·  ")));
    head.appendChild(title);
    const x = el("button", "ins-x", "\u00d7");
    x.type = "button";
    x.setAttribute("aria-label", "Close");
    x.onclick = close;
    head.appendChild(x);
    root.appendChild(head);

    const body = el("div", "ins-body");
    section(body, "Gems and score", [
        ["Banked", num(d.banked)],
        ["Carried", num(d.carried)],
        ["Score", num(d.score)],
        ["This life", num(d.run)],
        ["Kills", num(d.kills) + (d.botKills ? " (" + num(d.botKills) + " bots)" : "")],
        ["Streak", num(d.streak) + " (best " + num(d.bestStreak) + ")"],
        ["Lives", num(d.lives)],
        ...(d.hp ? [["Health", num(d.hp[0]) + " / " + num(d.hp[1])]] : []),
        ...(d.shield ? [["Shield", num(d.shield[0]) + " / " + num(d.shield[1])]] : []),
    ]);
    section(body, "Time", [
        ["Played", dur(d.playMs)],
        ["This life", dur(d.lifeMs)],
        ["On this tank", dur(d.tankMs)],
    ]);
    section(body, "Perks", d.perks.map(([n, lv, max]) => [n, lv + " / " + max]));
    section(body, "Abilities", [
        ...(d.ability ? [["Equipped", d.ability]] : []),
        ...d.abilities.map(n => ["Owned", n]),
        ...(d.twist ? [["From the twist", d.twist]] : []),
        ...(d.trial ? [["Trial", d.trial]] : []),
    ]);
    section(body, "Kit, sidearm and gear", [
        ...d.kit.map(([n, c]) => ["Kit", n + " x" + c]),
        ...(d.arm ? [["Sidearm", d.arm]] : []),
        ...d.gear.map(([n, left]) => ["Gear", left > 0 ? n + " (" + dur(left) + ")" : n]),
        ...(d.drill ? [["Drill", "Level " + d.drill]] : []),
    ]);
    section(body, "Stats" + (d.points ? " (" + d.points + " unspent)" : ""), d.stats.map(([n, v, cap]) => [n, v + " / " + cap]));
    root.appendChild(body);
    document.body.appendChild(root);
    st.el = root;
}

export function onPacket(raw) {
    let d = null;
    try { d = JSON.parse(raw); } catch (e) { return; }
    if (d) show(d);
}

window.addEventListener("keydown", (e) => {
    if (st.el && e.key === "Escape") { close(); e.stopPropagation(); }
}, true);
