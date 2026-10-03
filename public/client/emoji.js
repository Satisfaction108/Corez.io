// Discord style emoji for the chat boxes: ":fire:" turns into the emoji as
// soon as the second colon goes in, and typing ":fi" shows a small picker
// (arrows or mouse to choose, Tab or Enter to take it, Esc to close).
// attachEmoji(input) wires one <input>; the raid chat (canvas.js) and the
// friends chat (account/chat.js) both use it.

const LIST = [
    // faces
    ["grinning", "😀"], ["smiley", "😃"], ["smile", "😄"], ["grin", "😁"], ["laughing", "😆"], ["sweat_smile", "😅"],
    ["joy", "😂"], ["rofl", "🤣"], ["slight_smile", "🙂"], ["upside_down", "🙃"], ["wink", "😉"], ["blush", "😊"],
    ["innocent", "😇"], ["heart_eyes", "😍"], ["star_struck", "🤩"], ["kissing_heart", "😘"], ["yum", "😋"],
    ["stuck_out_tongue", "😛"], ["zany_face", "🤪"], ["money_mouth", "🤑"], ["hugging", "🤗"], ["thinking", "🤔"],
    ["shushing_face", "🤫"], ["zipper_mouth", "🤐"], ["raised_eyebrow", "🤨"], ["neutral_face", "😐"],
    ["expressionless", "😑"], ["no_mouth", "😶"], ["smirk", "😏"], ["unamused", "😒"], ["rolling_eyes", "🙄"],
    ["grimacing", "😬"], ["relieved", "😌"], ["pensive", "😔"], ["sleepy", "😪"], ["sleeping", "😴"],
    ["mask", "😷"], ["nauseated_face", "🤢"], ["vomiting", "🤮"], ["hot_face", "🥵"], ["cold_face", "🥶"],
    ["woozy_face", "🥴"], ["dizzy_face", "😵"], ["exploding_head", "🤯"], ["cowboy", "🤠"], ["partying_face", "🥳"],
    ["sunglasses", "😎"], ["nerd", "🤓"], ["monocle", "🧐"], ["confused", "😕"], ["worried", "😟"],
    ["slight_frown", "🙁"], ["open_mouth", "😮"], ["hushed", "😯"], ["astonished", "😲"], ["flushed", "😳"],
    ["pleading_face", "🥺"], ["fearful", "😨"], ["cold_sweat", "😰"], ["cry", "😢"], ["sob", "😭"],
    ["scream", "😱"], ["confounded", "😖"], ["persevere", "😣"], ["disappointed", "😞"], ["sweat", "😓"],
    ["weary", "😩"], ["tired_face", "😫"], ["yawning_face", "🥱"], ["triumph", "😤"], ["rage", "😡"],
    ["angry", "😠"], ["cursing", "🤬"], ["smiling_imp", "😈"], ["imp", "👿"], ["skull", "💀"],
    ["skull_crossbones", "☠️"], ["poop", "💩"], ["clown", "🤡"], ["ogre", "👹"], ["ghost", "👻"],
    ["alien", "👽"], ["space_invader", "👾"], ["robot", "🤖"], ["smiley_cat", "😺"], ["melting_face", "🫠"],
    ["salute", "🫡"], ["face_holding_back_tears", "🥹"], ["dotted_line_face", "🫥"],
    // hands and people
    ["wave", "👋"], ["raised_hand", "✋"], ["ok_hand", "👌"], ["pinched_fingers", "🤌"], ["v", "✌️"],
    ["crossed_fingers", "🤞"], ["love_you", "🤟"], ["metal", "🤘"], ["call_me", "🤙"], ["point_left", "👈"],
    ["point_right", "👉"], ["point_up", "☝️"], ["point_down", "👇"], ["middle_finger", "🖕"], ["thumbsup", "👍"],
    ["+1", "👍"], ["thumbsdown", "👎"], ["-1", "👎"], ["fist", "✊"], ["punch", "👊"], ["clap", "👏"],
    ["raised_hands", "🙌"], ["open_hands", "👐"], ["handshake", "🤝"], ["pray", "🙏"], ["muscle", "💪"],
    ["writing_hand", "✍️"], ["nail_care", "💅"], ["eyes", "👀"], ["eye", "👁️"], ["brain", "🧠"],
    ["tongue", "👅"], ["lips", "👄"], ["baby", "👶"], ["man_shrugging", "🤷‍♂️"], ["shrug", "🤷"],
    ["facepalm", "🤦"], ["ninja", "🥷"], ["crown", "👑"],
    // hearts and symbols
    ["heart", "❤️"], ["orange_heart", "🧡"], ["yellow_heart", "💛"], ["green_heart", "💚"], ["blue_heart", "💙"],
    ["purple_heart", "💜"], ["black_heart", "🖤"], ["white_heart", "🤍"], ["broken_heart", "💔"],
    ["sparkling_heart", "💖"], ["two_hearts", "💕"], ["100", "💯"], ["anger", "💢"], ["boom", "💥"],
    ["collision", "💥"], ["dizzy", "💫"], ["sweat_drops", "💦"], ["dash", "💨"], ["zzz", "💤"],
    ["speech_balloon", "💬"], ["thought_balloon", "💭"], ["question", "❓"], ["exclamation", "❗"],
    ["bangbang", "‼️"], ["interrobang", "⁉️"], ["warning", "⚠️"], ["no_entry", "⛔"], ["x", "❌"],
    ["white_check_mark", "✅"], ["check", "✔️"], ["heavy_check_mark", "✔️"], ["o", "⭕"], ["sos", "🆘"],
    ["up", "🆙"], ["cool", "🆒"], ["new", "🆕"], ["free", "🆓"], ["ok", "🆗"], ["arrow_up", "⬆️"],
    ["arrow_down", "⬇️"], ["arrow_left", "⬅️"], ["arrow_right", "➡️"], ["recycle", "♻️"], ["infinity", "♾️"],
    ["zero", "0️⃣"], ["one", "1️⃣"], ["two", "2️⃣"], ["three", "3️⃣"],
    // things in this game, more or less
    ["fire", "🔥"], ["gem", "💎"], ["moneybag", "💰"], ["money_with_wings", "💸"], ["coin", "🪙"],
    ["trophy", "🏆"], ["first_place", "🥇"], ["second_place", "🥈"], ["third_place", "🥉"], ["medal", "🏅"],
    ["crossed_swords", "⚔️"], ["dagger", "🗡️"], ["shield", "🛡️"], ["bow_and_arrow", "🏹"], ["bomb", "💣"],
    ["gun", "🔫"], ["pick", "⛏️"], ["hammer", "🔨"], ["tools", "🛠️"], ["wrench", "🔧"], ["gear", "⚙️"],
    ["chains", "⛓️"], ["magnet", "🧲"], ["rock", "🪨"], ["mountain", "⛰️"], ["volcano", "🌋"],
    ["rocket", "🚀"], ["dart", "🎯"], ["game_die", "🎲"], ["video_game", "🎮"], ["joystick", "🕹️"],
    ["crystal_ball", "🔮"], ["key", "🔑"], ["lock", "🔒"], ["unlock", "🔓"], ["bell", "🔔"], ["mega", "📣"],
    ["loudspeaker", "📢"], ["hourglass", "⌛"], ["stopwatch", "⏱️"], ["alarm_clock", "⏰"], ["tada", "🎉"],
    ["confetti_ball", "🎊"], ["gift", "🎁"], ["balloon", "🎈"], ["sparkles", "✨"], ["star", "⭐"],
    ["star2", "🌟"], ["zap", "⚡"], ["cyclone", "🌀"], ["tornado", "🌪️"], ["cloud_rain", "🌧️"],
    ["thunder_cloud_rain", "⛈️"], ["snowflake", "❄️"], ["droplet", "💧"], ["ocean", "🌊"], ["sunny", "☀️"],
    ["crescent_moon", "🌙"], ["rainbow", "🌈"], ["earth_americas", "🌎"], ["satellite", "🛰️"],
    ["flag_white", "🏳️"], ["checkered_flag", "🏁"], ["triangular_flag", "🚩"], ["pirate_flag", "🏴‍☠️"],
    ["car", "🚗"], ["red_car", "🚗"], ["airplane", "✈️"], ["ufo", "🛸"], ["anchor", "⚓"],
    // animals, food, misc
    ["dog", "🐶"], ["cat", "🐱"], ["mouse", "🐭"], ["rabbit", "🐰"], ["fox", "🦊"], ["bear", "🐻"],
    ["panda", "🐼"], ["frog", "🐸"], ["monkey", "🐒"], ["see_no_evil", "🙈"], ["chicken", "🐔"],
    ["penguin", "🐧"], ["bird", "🐦"], ["eagle", "🦅"], ["owl", "🦉"], ["wolf", "🐺"], ["unicorn", "🦄"],
    ["bee", "🐝"], ["bug", "🐛"], ["snail", "🐌"], ["spider", "🕷️"], ["turtle", "🐢"], ["snake", "🐍"],
    ["dragon", "🐉"], ["t_rex", "🦖"], ["shark", "🦈"], ["octopus", "🐙"], ["crab", "🦀"], ["fish", "🐟"],
    ["goat", "🐐"], ["sheep", "🐑"], ["cow", "🐮"], ["pig", "🐷"], ["horse", "🐴"], ["shrimp", "🦐"],
    ["apple", "🍎"], ["banana", "🍌"], ["watermelon", "🍉"], ["grapes", "🍇"], ["cherries", "🍒"],
    ["pizza", "🍕"], ["hamburger", "🍔"], ["fries", "🍟"], ["hotdog", "🌭"], ["taco", "🌮"], ["popcorn", "🍿"],
    ["cookie", "🍪"], ["cake", "🍰"], ["birthday", "🎂"], ["doughnut", "🍩"], ["ice_cream", "🍨"],
    ["candy", "🍬"], ["coffee", "☕"], ["tea", "🍵"], ["milk", "🥛"], ["beer", "🍺"], ["salt", "🧂"],
    ["cheese", "🧀"], ["egg", "🥚"], ["bread", "🍞"], ["eggplant", "🍆"], ["peach", "🍑"], ["corn", "🌽"],
    ["seedling", "🌱"], ["four_leaf_clover", "🍀"], ["mushroom", "🍄"], ["rose", "🌹"], ["sunflower", "🌻"],
    ["cactus", "🌵"], ["evergreen_tree", "🌲"], ["moyai", "🗿"], ["nerd_face", "🤓"], ["cap", "🧢"],
    ["goofy", "🤪"], ["sus", "🤨"], ["gg", "🤝"], ["l", "🇱"], ["w", "🇼"], ["ez", "😎"],
];
const MAP = new Map();
for (const [name, ch] of LIST) if (!MAP.has(name)) MAP.set(name, ch);
const NAMES = [...MAP.keys()];

// ":fire:" -> "🔥" for every name we know; unknown ones stay as typed
export function convert(text) {
    if (!text || text.indexOf(":") < 0) return text;
    return text.replace(/:([a-z0-9_+-]{1,32}):/gi, (all, name) => MAP.get(name.toLowerCase()) || all);
}

// names that start with `q` first, then names that contain it
export function search(q, max = 6) {
    q = String(q || "").toLowerCase();
    if (!q) return [];
    const starts = [], has = [];
    for (const n of NAMES) {
        if (n.startsWith(q)) starts.push(n);
        else if (has.length < max && n.includes(q)) has.push(n);
        if (starts.length >= max) break;
    }
    return starts.concat(has).slice(0, max).map(n => ({ name: n, ch: MAP.get(n) }));
}

let styled = false;
function addStyle() {
    if (styled) return;
    styled = true;
    const st = document.createElement("style");
    st.textContent =
        ".dw-emo{position:fixed;z-index:60;min-width:190px;max-width:280px;padding:4px;border-radius:10px;" +
        "background:#1e1924;border:1px solid #120e15;box-shadow:0 4px 0 rgba(0,0,0,.34);" +
        "font:600 13px/1.2 Rubik,Ubuntu,sans-serif;color:#efe6ff;display:none}" +
        ".dw-emo-row{display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:7px;cursor:pointer;white-space:nowrap}" +
        ".dw-emo-row b{font-size:18px;font-weight:400;width:22px;text-align:center}" +
        ".dw-emo-row span{opacity:.85;overflow:hidden;text-overflow:ellipsis}" +
        ".dw-emo-row.on{background:#3a2f4a}" +
        ".dw-emo-tip{padding:3px 8px 2px;font-size:10.5px;opacity:.5;font-weight:500}";
    document.head.appendChild(st);
}

export function attachEmoji(input) {
    if (!input || input._dwEmoji) return;
    input._dwEmoji = true;
    addStyle();
    const box = document.createElement("div");
    box.className = "dw-emo";
    document.body.appendChild(box);
    let items = [], pick = 0, from = -1;

    const hide = () => { box.style.display = "none"; items = []; from = -1; };
    const place = () => {
        const r = input.getBoundingClientRect();
        box.style.left = Math.max(6, Math.min(r.left, innerWidth - 290)) + "px";
        // above the box, unless it sits near the top (phones put the raid chat there)
        if (r.top > 220) { box.style.top = ""; box.style.bottom = (innerHeight - r.top + 6) + "px"; }
        else { box.style.bottom = ""; box.style.top = (r.bottom + 6) + "px"; }
    };
    const paint = () => {
        box.textContent = "";
        items.forEach((it, i) => {
            const row = document.createElement("div");
            row.className = "dw-emo-row" + (i === pick ? " on" : "");
            const b = document.createElement("b"); b.textContent = it.ch;
            const s = document.createElement("span"); s.textContent = ":" + it.name + ":";
            row.append(b, s);
            // mousedown, not click: a click would blur the input first and send
            row.addEventListener("mousedown", (e) => { e.preventDefault(); take(i); });
            box.appendChild(row);
        });
        const tip = document.createElement("div");
        tip.className = "dw-emo-tip";
        tip.textContent = "Tab to pick, Esc to close";
        box.appendChild(tip);
    };
    const take = (i) => {
        const it = items[i];
        if (!it || from < 0) return hide();
        const v = input.value, end = input.selectionStart;
        const next = v.slice(0, from) + it.ch + v.slice(end);
        if (input.maxLength > 0 && next.length > input.maxLength) return hide();
        input.value = next;
        const at = from + it.ch.length;
        input.setSelectionRange(at, at);
        hide();
        input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const look = () => {
        const end = input.selectionStart;
        if (end == null) return hide();
        const m = /(^|[\s(]):([a-z0-9_+-]{2,32})$/i.exec(input.value.slice(0, end));
        if (!m) return hide();
        const found = search(m[2]);
        if (!found.length) return hide();
        items = found;
        pick = Math.min(pick, items.length - 1);
        from = end - m[2].length - 1;
        paint();
        place();
        box.style.display = "block";
    };

    input.addEventListener("input", () => {
        // a finished ":name:" turns into the emoji right away, caret kept in place
        const v = input.value, end = input.selectionStart;
        const before = v.slice(0, end), after = v.slice(end);
        const nb = convert(before), na = convert(after);
        if (nb !== before || na !== after) {
            input.value = nb + na;
            input.setSelectionRange(nb.length, nb.length);
        }
        pick = 0;
        look();
    });
    // capture, so a pick wins over the box's own Enter (send) handler
    input.addEventListener("keydown", (e) => {
        if (box.style.display !== "block" || !items.length) return;
        const k = e.key;
        if (k === "ArrowDown" || k === "ArrowUp") {
            pick = (pick + (k === "ArrowDown" ? 1 : items.length - 1)) % items.length;
            paint();
        } else if (k === "Tab" || k === "Enter") {
            take(pick);
        } else if (k === "Escape") {
            hide();
        } else return;
        e.preventDefault();
        e.stopImmediatePropagation();
    }, true);
    input.addEventListener("blur", hide);
    input.addEventListener("click", look);
}
