const P = () => window.DWProfanity;

function hintFor(value) {
    const p = P();
    const s = String(value || "").trim();
    if (!s) return "";
    if (!p) return Array.from(s).length < 2 ? "Names need at least 2 characters." : "";
    const why = p.nameProblem(s);
    if (why === "short") return "Names need at least " + p.MIN_NAME + " characters.";
    if (why === "rude") return "Pick a different name.";
    return "";
}

function attach() {
    const input = document.getElementById("playerNameInput");
    if (!input || input._nameHint) return;
    input._nameHint = true;
    const hint = document.createElement("div");
    hint.id = "nameHint";
    hint.className = "name-hint";
    hint.setAttribute("aria-live", "polite");
    input.insertAdjacentElement("afterend", hint);
    const update = () => {
        const text = hintFor(input.value);
        if (!text) input.classList.remove("name-bad");
        hint.textContent = text;
        hint.classList.toggle("on", !!text);
    };
    input.addEventListener("input", update);
    update();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", attach);
else attach();

function randomName() {
    return "Guest#" + (1000 + ((Math.random() * 9000) | 0));
}

// Play pressed: true to go ahead. An empty box gets a random name; a bad one
// holds Play and shows why.
function okToPlay(input) {
    const s = String(input.value || "").trim();
    if (!s) {
        input.value = randomName();
        input.dispatchEvent(new Event("input"));
        return true;
    }
    const text = hintFor(s);
    if (!text) return true;
    const hint = document.getElementById("nameHint");
    if (hint) { hint.textContent = text; hint.classList.add("on"); }
    input.classList.remove("name-bad");
    void input.offsetWidth;
    input.classList.add("name-bad");
    try { input.focus(); } catch (e) { /* */ }
    return false;
}

export { hintFor, okToPlay, randomName };
