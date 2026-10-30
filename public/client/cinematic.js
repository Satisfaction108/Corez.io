const SEEN_KEY = "dwCinema2tdm_v1";
const SRC = "/media/corez2tdm.mp4";
const STYLE_ID = "dwCinemaStyle";

const CSS = `
#dwCinema { position: fixed; inset: 0; z-index: 9000; overflow: hidden; background: #0d0b12; opacity: 0; transition: opacity 260ms ease; }
#dwCinema.show { opacity: 1; }
#dwCinema .cine-bg { position: absolute; inset: -6%; width: 112%; height: 112%; object-fit: cover; filter: blur(34px) saturate(1.3) brightness(.45); transform: scale(1.04); pointer-events: none; }
#dwCinema .cine-stage { position: absolute; left: 50%; top: 46%; transform: translate(-50%, -50%); width: min(92vw, calc(78vh * 16 / 9)); aspect-ratio: 16 / 9; border-radius: 20px; overflow: hidden; border: 3px solid #0c0a0e; box-shadow: 0 6px 0 #0c0a0e, 0 24px 60px rgba(0,0,0,.55); background: #000; }
#dwCinema .cine-main { width: 100%; height: 100%; object-fit: cover; display: block; }
#dwCinema .cine-bar { position: absolute; left: 50%; transform: translateX(-50%); top: calc(46% + min(46vw * 9 / 16, 39vh) + 20px); width: min(92vw, calc(78vh * 16 / 9)); display: flex; align-items: center; gap: 14px; }
#dwCinema .cine-track { flex: 1; height: 10px; border-radius: 999px; background: rgba(255,255,255,.14); border: 2px solid #0c0a0e; overflow: hidden; }
#dwCinema .cine-fill { height: 100%; width: 0; background: linear-gradient(90deg, #4a93ff 0%, #4a93ff 50%, #ff5a70 50%, #ff5a70 100%); background-size: var(--cine-w, 100%) 100%; }
#dwCinema .cine-btn { height: 42px; padding: 0 20px 4px; border-radius: 12px; border: 3px solid #0c0a0e; cursor: pointer; font: 400 20px/1 'Lilita One', 'Rubik', sans-serif; letter-spacing: .02em; transition: transform 60ms, filter 80ms; white-space: nowrap; }
#dwCinema .cine-btn:hover { filter: brightness(1.08); }
#dwCinema .cine-btn:active { transform: translateY(3px); }
#dwCinema .cine-skip { background: #ffd24a; color: #1b1510; box-shadow: inset 0 -4px 0 #d9a514, 0 3px 0 #0c0a0e; }
#dwCinema .cine-sound { background: #4a4156; color: #fff; box-shadow: inset 0 -4px 0 #2e2837, 0 3px 0 #0c0a0e; display: none; }
#dwCinema .cine-hint { position: absolute; left: 0; right: 0; bottom: max(14px, env(safe-area-inset-bottom)); text-align: center; color: rgba(255,255,255,.5); font: 700 12px/1 Ubuntu, sans-serif; }
`;

let open = null;

function seen() {
    try { return localStorage.getItem(SEEN_KEY) === "1"; } catch (e) { return true; }
}
function markSeen() {
    try { localStorage.setItem(SEEN_KEY, "1"); } catch (e) { void e; }
}
function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = CSS;
    document.head.appendChild(s);
}
function makeVideo(cls, muted) {
    const v = document.createElement("video");
    v.className = cls;
    v.src = SRC;
    v.playsInline = true;
    v.setAttribute("playsinline", "");
    v.preload = "auto";
    v.muted = muted;
    return v;
}

export function wanted() { return !seen() && !open; }

export function play(onDone, opts = {}) {
    if (open) return;
    ensureStyle();
    if (!opts.replay) markSeen();
    const wrap = document.createElement("div");
    wrap.id = "dwCinema";
    const bg = makeVideo("cine-bg", true);
    bg.setAttribute("aria-hidden", "true");
    const stage = document.createElement("div");
    stage.className = "cine-stage";
    const video = makeVideo("cine-main", false);
    stage.appendChild(video);
    const bar = document.createElement("div");
    bar.className = "cine-bar";
    const sound = document.createElement("button");
    sound.type = "button";
    sound.className = "cine-btn cine-sound";
    sound.textContent = "Sound on";
    const track = document.createElement("div");
    track.className = "cine-track";
    const fill = document.createElement("div");
    fill.className = "cine-fill";
    track.appendChild(fill);
    const skip = document.createElement("button");
    skip.type = "button";
    skip.className = "cine-btn cine-skip";
    skip.textContent = opts.replay ? "Close" : "Skip";
    bar.append(sound, track, skip);
    const hint = document.createElement("div");
    hint.className = "cine-hint";
    hint.textContent = "Press Esc to skip";
    wrap.append(bg, stage, bar, hint);
    document.body.appendChild(wrap);
    requestAnimationFrame(() => wrap.classList.add("show"));

    let finished = false, raf = 0;
    const finish = () => {
        if (finished) return;
        finished = true;
        cancelAnimationFrame(raf);
        document.removeEventListener("keydown", onKey, true);
        try { video.pause(); bg.pause(); } catch (e) { void e; }
        wrap.classList.remove("show");
        setTimeout(() => { wrap.remove(); open = null; if (typeof onDone === "function") onDone(); }, 260);
    };
    const onKey = (e) => {
        if (e.key === "Escape" || e.key === "Enter") { e.preventDefault(); e.stopPropagation(); finish(); }
    };
    const progress = () => {
        const d = video.duration || 0;
        const k = d > 0 ? Math.min(1, video.currentTime / d) : 0;
        fill.style.width = (k * 100) + "%";
        fill.style.setProperty("--cine-w", (k > 0 ? 100 / k : 100) + "%");
        if (Math.abs((bg.currentTime || 0) - video.currentTime) > 0.3) { try { bg.currentTime = video.currentTime; } catch (e) { void e; } }
        raf = requestAnimationFrame(progress);
    };
    document.addEventListener("keydown", onKey, true);
    skip.onclick = (e) => { e.preventDefault(); finish(); };
    sound.onclick = (e) => { e.preventDefault(); video.muted = false; sound.style.display = "none"; video.play().catch(() => {}); };
    video.onended = finish;
    video.onerror = finish;
    open = { wrap, finish };
    raf = requestAnimationFrame(progress);
    bg.play().catch(() => {});
    const tried = video.play();
    if (tried && typeof tried.catch === "function") {
        tried.catch(() => {
            video.muted = true;
            sound.style.display = "block";
            video.play().catch(finish);
        });
    }
}

export function replay() { play(null, { replay: true }); }

window.dwCinema = { wanted, play, replay };
document.addEventListener("click", (e) => {
    const a = e.target && e.target.closest ? e.target.closest(".dw-watch-cinematic") : null;
    if (!a) return;
    e.preventDefault();
    replay();
});

