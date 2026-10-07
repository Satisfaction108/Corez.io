import { global } from "./global.js";
import { util } from "./util.js";
import { config } from "./config.js";
import * as socketStuff from "./socketinit.js";
import { AdvancedRecorder } from "./recorder.js";
import { gameSound } from "./sound.js";
import { touch, inputModeWatch } from "./touch.js";
import * as abilityFx from "./abilityFx.js";
import * as raidPerks from "./raidPerks.js";
import * as raidFinale from "./raidFinale.js";
import { attachEmoji } from "./emoji.js";
import * as upGrid from "./upgradeGridLogic.js";
let { gui } = socketStuff;

// duos: team chat and pings are on (the duo server says so in RY)
const duoChat = () => !!(global.royale && global.royale.duos);

function hitClientRect(mouse, r) {
    if (!r || mouse == null) return false;
    const x = mouse.clientX, y = mouse.clientY;
    return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

// standing on a vault, base bank or shop pad (abilities don't work there)
function onAnyPad() { return !!((global.shop && global.shop.onPad) || (global.vault && global.vault.onPad)); }
// GUI units per canvas pixel (the HUD draws in GUI units)
function guiScale() { return (global.canvas && global.canvas.height / global.screenHeight / global.ratio) || 1; }
// a press on one of the HUD's own buttons
function overHudButton(mpos) {
    const c = global.clickables;
    return !!abilityFx.chipAt(mpos.x / guiScale(), mpos.y / guiScale()) || c.vault.check(mpos) !== -1 || c.shop.check(mpos) !== -1 || c.kit.check(mpos) !== -1 ||
        c.skipUpgrades.check(mpos) !== -1 || (c.royalePlay && c.royalePlay.check(mpos) !== -1) ||
        (c.lastTank && c.lastTank.check(mpos) !== -1) || (c.statBtn && c.statBtn.check(mpos) !== -1) ||
        (c.upgradePage && c.upgradePage.check(mpos) !== -1) ||
        raidPerks.hit(mpos.x / guiScale(), mpos.y / guiScale());
}
// Enter right after a respawn does not open the chat (mashed on the death card)
const ENTER_GUARD_MS = 1200;
function enterGuarded(now) {
    return now - (global.spawnedAt || -1e9) < ENTER_GUARD_MS;
}
// only movement letters typed (w a s d, any case, spaces): a chat opened by
const MOVE_KEYS = [87, 65, 83, 68];
function chatIsMash(value, kc) {
    if (!MOVE_KEYS.includes(kc)) return false;
    return /^[wasd\s]*$/i.test(String(value || ""));
}

class Canvas {
    constructor() {
        this.directionLock = false;
        this.target = global.target;
        this.socket = global.socket;
        this.directions = [];
        this.chatListener = function(id, event) {
            // a movement key held down in a chat with nothing but movement letters in it: it
            if (event.repeat && chatIsMash(this[id] && this[id].value, event.keyCode)) {
                event.preventDefault();
                this[id].value = "";
                this.chatListener(id, { keyCode: global.KEY_ESC, preventDefault() { } });
                return;
            }
            // duos: Tab flips between your partner (Team) and everyone nearby (All)
            if (event.keyCode === 9 && duoChat()) {
                event.preventDefault();
                global.duoChatAll = !global.duoChatAll;
                gameSound.uiClick();
                return;
            }
            if (![global.KEY_ENTER, global.KEY_ESC].includes(event.keyCode)) return;
            // closed before the blur: a phone treats blur as Done (spawnChatInput)
            global.showChat = false;
            // iOS can leave the page scrolled after its keyboard goes away
            if (global.mobile) setTimeout(() => { if (window.scrollY || window.scrollX) window.scrollTo(0, 0); if (window.resizeEvent) window.resizeEvent(); }, 60);
            if (this.chatAutoPaused) { this.chatAutoPaused = false; if (!global.died) this.socket.talk("t", 1, false); }
            this[id].blur();
            this.cv.focus();
            setTimeout(() => {
                if (this.chatBox && !this.chatBox.loadedProperly) this.chatBox.remove(), this.chatInput.remove(), this.chatBox = false;
            }, 50)
            if (!this[id].value) return;
            if (event.keyCode === global.KEY_ENTER) {
                let text = this[id].value, team = duoChat() && !global.duoChatAll;
                // "/a hi" says it to all, "/t hi" to your partner, whatever the pill says
                const pre = /^\/([at])\s+/i.exec(text);
                if (pre && duoChat()) { team = pre[1].toLowerCase() === 't'; text = text.slice(pre[0].length); }
                // dead: only your partner can hear you
                if (duoChat() && global.died) team = true;
                // a save code goes to the server, never to a partner's chat
                if (/^\s*\$restore(\s|$)/i.test(text)) team = false;
                if (text.trim()) {
                    if (team) this.socket.talk('TC', text);
                    else this.socket.talk('M', text, global.chatMode === 'team' ? 1 : 0);
                }
            }
            this[id].value = "";
        }

        this.cv = document.getElementById('gameCanvas');
        this.cvb = document.getElementById('gameCanvas-background');
        this.cvg = document.getElementById('gameCanvas-gameplay');
        this.cvu = document.getElementById('gameCanvas-gui');
        // The HUD layer may be sharper than the world (app.js resizeEvent):
        // automatic resolution only lowers the world layers.
        this.cv.resize = (width, height, guiW = width, guiH = height) => {
            this.cv.width = this.cvb.width = this.cvg.width = this.width = width;
            this.cv.height = this.cvb.height = this.cvg.height = this.height = height;
            this.cvu.width = guiW;
            this.cvu.height = guiH;
        };
        this.cv.resize(innerWidth, innerHeight);
        this.reverseDirection = false;
        this.inverseMouse = false;
        this.spinLock = false;
        this.mouseMoved = false;
        this.treeScrollSpeed = 0.5;
        this.treeScrollSpeedMultiplier = 1;
        this.initalized = false;
        this.tankTreeProps = {
            searchQuery: '',
            enabled: false,
        }
        global.canvas = this;
    }
    init() {
        // Both sets of input are wired up; global.mobile says which one plays.
        // Phones and tablets: twin sticks and thumb buttons (touch.js). A real
        // touch on the game switches to them, a mouse that moves (or clicks)
        // or game keys with a pointer to aim with switch back (touchInput.js
        // inputModeWatch), so a touch screen laptop or a PC whose browser
        // claims to be a phone still plays with mouse and keys.
        touch.attach(this);
        const watch = inputModeWatch(() => global.inputEnv ? global.inputEnv() : {});
        const flip = (want) => { if (want !== null && want !== !!global.mobile && global.setTouchMode) global.setTouchMode(want); };
        touch.onTouchSeen = () => flip(watch.touch(performance.now()));
        // pointer events carry the device; touch and pen never count as a mouse
        window.addEventListener("pointermove", (e) => {
            if (e.pointerType === "mouse") flip(watch.mouseMove(e.clientX, e.clientY, performance.now(), !!global.mobile));
        }, true);
        window.addEventListener("pointerdown", (e) => {
            if (e.pointerType === "mouse") flip(watch.mouseDown(performance.now(), !!global.mobile));
        }, true);
        // aim follows the cursor from the window, not just the canvas: a DOM
        // card or overlay sitting over the game must never freeze the aim
        // (the canvas only hears moves under a held button then)
        window.addEventListener("mousemove", (event) => {if (!global.mobile && (global.gameStart || global.disconnected)) this.mouseMove(event)});
        this.cv.addEventListener("mousedown", (event) => {if (!global.mobile && (global.gameStart || global.disconnected)) this.mouseDown(event)});
        // the release is heard anywhere on the window: a press on the game let
        // go over a DOM box (the vault input, chat, an overlay) used to be
        // lost, leaving a kit or chip drag armed to eat the next click
        window.addEventListener("mouseup", (event) => {if (!global.mobile && (global.gameStart || global.disconnected)) this.mouseUp(event)});
        this.cv.addEventListener("keypress", (event) => {if (!global.mobile && global.gameStart) this.keyPress(event)});
        this.cv.addEventListener("wheel", (event) => {if (!global.mobile && global.gameStart) this.wheel(event)});
        this.cv.addEventListener("keydown", (event) => {
            // playing on the keyboard (not a shortcut) with a mouse or trackpad around
            if (global.mobile && global.gameStart && !global.showChat && !event.metaKey && !event.ctrlKey && !event.altKey && !/^(Shift|Meta|Control|Alt|CapsLock|Tab|Escape)$/.test(event.key || ""))
                flip(watch.key(performance.now(), true));
            // dash is Alt: Alt+D / Alt+F / Alt+E would jump to the browser's
            // address bar or menus while you move
            if (global.gameStart && event.altKey && !global.showChat) event.preventDefault();
            if (global.gameStart) this.keyDown(event);
        });
        this.cv.addEventListener("keyup", (event) => {if (global.gameStart) this.keyUp(event)});
        // The death card's Enter / Space work wherever the focus went (a click on a DOM
        window.addEventListener("keydown", (event) => {
            // Round 9 bug 1: after the death card the focus can sit on the page (the Respawn
            if (event.target !== this.cv && global.gameStart && !global.died && !global.showChat && !global.disconnected) {
                const t0 = event.target, tag0 = t0 && t0.tagName;
                const stray = !t0 || t0 === document.body || t0 === document.documentElement ||
                    (tag0 === "BUTTON" && t0.offsetParent === null);
                if (stray && !event.metaKey && !event.ctrlKey) {
                    try { this.cv.focus(); } catch (e) { /* */ }
                    this.keyDown(event);
                    return;
                }
            }
            if (event.target === this.cv || !global.gameStart || !global.died || global.disconnected || global.tutorialMode) return;
            if (!(global.royale && global.royale.at > 0)) return;
            const kc = event.keyCode;
            if (kc !== global.KEY_ENTER && kc !== 32) return;
            if (kc === global.KEY_ENTER && duoChat()) return;
            const t = event.target, tag = t && t.tagName;
            if (global.showChat || tag === "TEXTAREA" || (t && t.isContentEditable)) return;
            // a visible text box keeps its keys (a hidden one doesn't)
            if (tag === "INPUT" && t.offsetParent !== null && t.type !== "button") return;
            // the Play again button handles its own Enter / Space
            if (t && t.id === "royaleDomPlayAgain") return;
            event.preventDefault();
            global.rbWantBuild = false;   // Enter / Space = plain Respawn
            if (!event.repeat) this.respawn();
            try { if (t && t.blur) t.blur(); this.cv.focus(); } catch (e) { /* */ }
        });
        window.addEventListener("gamepadconnected", (e) => {
            global.createMessage("Controller connected. Gamepad mode on.");
            this.runGamepad();
        });
        window.addEventListener("gamepaddisconnected", (e) => {
            global.createMessage("Controller disconnected. Gamepad mode off.");
            this.stopGamepad();
        });
        this.initalized = true;
    }

    wheel(event) {
        // over the upgrade tiles with more than one page: the wheel turns it
        {
            const UG = global.upgradePg, pg = UG && UG.pg;
            if (pg && pg.pages > 1 && global.canUpgrade && !global.showBigMap) {
                const k = this.height / global.screenHeight;
                const gx = (event.clientX * global.ratio) / k, gy = (event.clientY * global.ratio) / k;
                if (gx <= (global.upgradeBoxRight || 0) + 10 && gy >= (global.upgradeBoxTop || 0) - 10 && gy <= (global.upgradeBoxBottom || 0) + 10) {
                    const t = performance.now();
                    if (t - (UG.wheelAt || 0) > 180) { UG.wheelAt = t; UG.page = upGrid.turn(UG.page, pg.pages, event.deltaY > 0 ? 1 : -1); }
                    event.preventDefault && event.preventDefault();
                    return;
                }
            }
        }
        // full-map overlay: wheel zooms toward the cursor
        if (global.showBigMap) {
            const bm = global.bigMap;
            const P = bm._panel;
            const oldZoom = bm.zoom || 1;
            const newZoom = event.deltaY > 0
                ? Math.max(1, oldZoom / 1.18)
                : Math.min(4, oldZoom * 1.18);
            if (P && newZoom !== oldZoom) {
                // keep the world point under the cursor fixed:
                // c' = w - (w - c) * (oldZoom / newZoom)
                const mScale = this.height / global.screenHeight;
                const gx = (event.clientX * global.ratio) / mScale;
                const gy = (event.clientY * global.ratio) / mScale;
                const wcx = P.wx0 + (gx - P.x) / P.s;
                const wcy = P.wy0 + (gy - P.y) / P.s;
                bm.cx = wcx - (wcx - (bm.cx || 0)) * (oldZoom / newZoom);
                bm.cy = wcy - (wcy - (bm.cy || 0)) * (oldZoom / newZoom);
            }
            bm.zoom = newZoom;
            event.preventDefault && event.preventDefault();
            return;
        }
        // the owner's spectator (server ignores this for everyone else): zoom
        if (!global.died && !global.showTree && global.gameStart && !global.showChat) {
            const t = performance.now();
            if (t - (this._specZoomAt || 0) > 90 && Math.abs(event.deltaY) > 0) {
                this._specZoomAt = t;
                this.socket.talk('SPZ', event.deltaY > 0 ? 1 : -1);
            }
        }
        if (!global.died && global.showTree) {
            if (event.deltaY > 1) {
                global.targetTreeScale = Math.max(global.targetTreeScale / 1.2, 0.5);
            } else {
                global.targetTreeScale = Math.min(global.targetTreeScale * 1.2, 8);
            }
        }
    }
    keyPress(event) {
        switch (event.keyCode) {
            case global.KEY_ZOOM_OUT:
                if (!global.died && global.showTree) global.targetTreeScale = Math.max(global.targetTreeScale / 1.2, 0.5);
                break;
            case global.KEY_ZOOM_IN:
                if (!global.died && global.showTree) global.targetTreeScale = Math.min(global.targetTreeScale * 1.2, 8);
                break;
        }
    }
    releaseMovement() {
        // any UI that steals focus (chat, map, inputs) drops held movement
        // keys, otherwise the tank drifts until the key is pressed again
        for (let i = 0; i < 4; i++) this.socket.cmd.set(i, false);
    }
    spawnChatInput() {
        if (!this.chatBox) {
            this.chatBox = document.createElement("div");
            this.chatBox.id = "chatBox";
            this.chatBox.style.zIndex = 10;
            document.getElementById("gameAreaWrapper").appendChild(this.chatBox);
            // Input
            this.chatInput = document.createElement("input");
            this.chatInput.id = "chatInput";
            this.chatInput.style.zIndex = 11;
            this.chatInput.addEventListener('keydown', event => this.chatListener("chatInput", event));
            if (global.mobile) {
                // the phone keyboard's Done (or closing it) sends what's typed
                this.chatInput.setAttribute("enterkeyhint", "send");
                this.chatInput.addEventListener('blur', () => {
                    if (global.showChat) this.chatListener("chatInput", { keyCode: global.KEY_ENTER, preventDefault() { } });
                });
            }
            document.getElementById("gameAreaWrapper").appendChild(this.chatInput);
            attachEmoji(this.chatInput);
        }
        this.releaseMovement();
        // touch: typing never drives or shoots; the sticks let go and the tank stops
        if (global.mobile) {
            touch.releaseAll();
            for (const i of [4, 5, 6, 7]) this.socket.cmd.set(i, false);
            this.socket.cmd.reactNow();
            // auto-fire holds too, and comes back when the box closes
            if (touch.autoFire && !this.chatAutoPaused) { this.chatAutoPaused = true; this.socket.talk("t", 1, false); }
        }
        this.chatInput.focus();
        global.showChat = true;
    }
    // touch: a tap outside the box closes it and sends what's typed, like Done
    closeChat() {
        if (!global.showChat || !this.chatInput) return;
        this.chatListener("chatInput", { keyCode: global.KEY_ENTER, preventDefault() { } });
    }

    respawn() {
        // the raid's results are for everyone: no click or key skips them (raidFinale
        if (global.died && raidFinale.active() && !global.finaleRespawn) return;
        // The storm's spawn lock, or the death card's wait: asking now queues the drop
        if (global.died && !global.tutorialMode && global.royale && global.royale.lock && global.royale.at > 0 && global.royale.storm && global.royale.storm.fin) {
            global.respawnQueued = false;
            if (!global.royaleSpectating) { global.royaleSpectating = true; try { this.socket.talk('RS', 2); } catch (e) { /* */ } }
            return;
        }
        const locked = !!(global.royale && global.royale.lock && global.royale.at > 0);
        const waiting = global.died && global.raidRespawnAt > 0 && performance.now() < global.raidRespawnAt;
        if (locked || waiting) {
            if (global.died && !global.respawnPending && !global.tutorialMode) global.respawnQueued = true;
            return;
        }
        global.respawnQueued = false;
        // a new version is about to reload the page (version.js): no drop
        // that the reload would cut short
        if (global.died && global.updateHoldsRespawn) return;
        if (global.died && !global.cannotRespawn && !global.respawnPending) {
            global.respawnPending = true;
            global.royaleDied = false;
            global.royaleSpectating = false;
            global.royaleKillerCamUntil = 0;
            global._specGlide = null;
            global.raidRespawnAt = 0;
            global.raidQueued = true;
            // "Respawn as <Tank>": the server puts the last build back on the new body
            if (global.rbWantBuild) { try { this.socket.talk('rb', 'build'); } catch (e) { /* */ } }
            global.rbWantBuild = false;
            this.socket.talk('s', global.playerName, 0, 1 * config.game.autoLevelUp, false, 1 * config.game.incognitoMode);
            setTimeout(() => {
                if (global.respawnPending) global.respawnPending = false;
            }, 5000);
        }
    }

    // ── Dig Royale input: kit slots and the shop panel ───────────────────
    royaleKeyDown(event) {
        if (!(global.royale && global.royale.at > 0) && !global.tutorialMode) return false;
        const kc = event.keyCode;
        // the death card: Space is Play again (Enter is too, below, except on
        // the duo server where it opens the team chat). A held fire key only
        // repeats, so it never counts.
        if (kc === 32 && global.died && !global.tutorialMode && !global.disconnected) {
            if (!event.repeat && !global.showChat) { global.rbWantBuild = false; this.respawn(); }
            return true;
        }
        // Enter: the same as the button, whenever the button works
        if (kc === global.KEY_ENTER && global.died && !global.tutorialMode && !global.disconnected && !duoChat() && !global.showChat) {
            if (!event.repeat) { global.rbWantBuild = false; this.respawn(); }
            return true;
        }
        // B on a vault pad: Bank all, the same request as the panel's button
        // (app.js drawVaultUI stamps bankAllAt while that button is up)
        if (kc === 66 && !global.died && !global.showChat && global.vault && global.vault.onPad &&
            performance.now() - (global.vault.bankAllAt || 0) < 400 && !(document.activeElement && document.activeElement.id === "vaultInput")) {
            if (!event.repeat) { this.socket.talk('vd', 0); gameSound.uiClick(); }
            return true;
        }
        // dash and the ability slot (abilityFx.js); before the server has said
        // the system is on, the keys keep their old jobs
        if (!global.died && global.abil && global.abil.on && !global.showTree && !global.showChat) {
            if (kc === global.KEY_DASH) { event.preventDefault(); if (!event.repeat) this.useDash(); return true; }
            if (kc === global.KEY_ABILITY) { if (!event.repeat) this.abilityDown(); return true; }
        }
        // abilities switched off on this server: Q goes back to being kit slot 2
        const kit2 = kc === global.KEY_KIT_2 || (kc === global.KEY_ABILITY && !(global.abil && global.abil.on));
        if (!global.died && !event.repeat && (kc === global.KEY_KIT_1 || kit2 || kc === global.KEY_KIT_3)) {
            const slot = kc === global.KEY_KIT_1 ? 0 : kit2 ? 1 : 2;
            const ko = (global.shop.state && global.shop.state.kitOrder) || [];
            if (!ko[slot]) return false;     // empty slot: the key keeps its other job
            this.useKitSlot(slot);
            return true;
        }
        // raid perk cards: Shift+1/2/3 (plain digits stay the stat keys)
        if (raidPerks.key(event)) return true;
        // the raid card (firstSeconds.js): Esc lets it go early
        if (kc === global.KEY_ESC && !event.repeat && global.introCardUp && global.introSkip && global.introSkip()) return true;
        if (kc === global.KEY_ESC && global.abilAim) { abilityFx.cancelAim(); gameSound.uiClick(); return true; }
        if (kc === global.KEY_ESC && global.shop.onPad && !global.shop.dismissed) {
            global.shop.dismissed = true;
            gameSound.uiClick();
            return true;
        }
        return false;
    }
    // the ability key coming up does nothing: aim mode waits for the click
    royaleKeyUp(event) {
        if (event && event.keyCode === global.KEY_ABILITY && global.abilAim) return true;
        // Alt let go on its own would put Windows' focus on the browser menu
        if (event && event.keyCode === 18 && global.KEY_DASH === 18) { event.preventDefault(); return true; }
        return false;
    }
    // kit slots trade places, an empty slot included (the server's order
    // decides; this just moves them at once so the drop doesn't flicker)
    swapKitSlots(from, to) {
        const st = global.shop && global.shop.state;
        const ko = (st && st.kitOrder) || [];
        if (!ko[from] || from === to || to < 0 || to > 2) return;
        while (ko.length < 3) ko.push(null);
        const id = ko[from]; ko[from] = ko[to] || null; ko[to] = id;
        while (ko.length && !ko[ko.length - 1]) ko.pop();
        this.socket.talk('ko', from, to);
        gameSound.uiClick();
    }
    useKitSlot(slot) {
        const ko = (global.shop.state && global.shop.state.kitOrder) || [];
        if (!ko[slot]) {
            global.createMessage("Kit slot " + (slot + 1) + " is empty. Buy items at a shop.", 2200);
            return;
        }
        const wr = util.getRatio();
        let wx = global.player.renderx + global.target.x / wr;
        let wy = global.player.rendery + global.target.y / wr;
        if (!isFinite(wx) || !isFinite(wy)) { wx = global.player.renderx; wy = global.player.rendery; }
        // the item rides along: the server uses what this slot SHOWS, even
        // if its own order moved on (a drag swap still in flight)
        this.socket.talk('sk', slot, Math.round(wx), Math.round(wy), String(ko[slot]));
        global.kitUsedAt = performance.now();   // coach.js: the ability step
        try { localStorage.setItem("dwAbilityUsed_v1", "1"); } catch (e) { /* */ }   // coachLogic.js ABILITY_KEY: for good
        gameSound.uiClick();
    }
    useDash() {
        if (abilityFx.predictDash()) this.socket.talk('ab', 0);
        else if (global.abil && global.abil.d <= 0) gameSound.uiClick();
    }
    // The ability key: a placed or thrown one (pad, wall, shockwave, smoke)
    // goes into aim mode, where a left click puts it down and right click,
    // Esc or the key again cancel it for free; anything else fires at once.
    abilityDown() {
        const ab = global.abil || {};
        if (global.abilAim && global.abilAim.mode === "click") { abilityFx.cancelAim(); gameSound.uiClick(); return; }
        const onPad = (global.shop && global.shop.onPad) || (global.vault && global.vault.onPad);
        const down = ab.act === "burrow" && ab.actAt > performance.now();
        if (!onPad && !down && ab.eq && abilityFx.cdLeft() <= 0 && abilityFx.startAim(ab.eq)) {
            global.abilAim.mode = "click";
            gameSound.uiClick();
            return;
        }
        this.useAbility();
    }
    // aim mode's left click: down it goes at the previewed spot
    placeAim() {
        const spot = abilityFx.aimSpot(util.getRatio());
        abilityFx.cancelAim();
        if (spot && !global.died) this.useAbilityAt(spot.x, spot.y);
    }
    // The ability key never swaps abilities: that's the shop panel's Equip
    // button. On any pad it does nothing but say so.
    useAbility() {
        const ab = global.abil || {};
        if (global.shop && global.shop.onPad) { global.createMessage("Equip abilities with the Equip button.", 2000); return; }
        if (global.vault && global.vault.onPad) { global.createMessage("Equip abilities at a shop.", 2000); return; }
        if (!ab.eq) { global.createMessage("No ability yet. Shops sell them.", 2200); return; }
        if (abilityFx.cdLeft() > 0) return;
        const wr = util.getRatio();
        let wx = global.player.renderx + global.target.x / wr;
        let wy = global.player.rendery + global.target.y / wr;
        this.useAbilityAt(wx, wy);
    }
    useAbilityAt(wx, wy) {
        if (!isFinite(wx) || !isFinite(wy)) { wx = global.player.renderx; wy = global.player.rendery; }
        this.socket.talk('ab', 1, Math.round(wx), Math.round(wy));
        global.abilityUsedAt = performance.now();   // coach.js: the ability step
        try { localStorage.setItem("dwAbilityUsed_v1", "1"); } catch (e) { /* */ }   // coachLogic.js ABILITY_KEY: for good
    }
    keyDown(event) {
        if (global.dailyTankAd.renderUI) return;
        // the kept raid results: Esc puts them away
        if (!event.repeat && raidFinale.key(event.keyCode)) { event.preventDefault(); return; }
        // Command on its own: the owner's spectator shows or hides (the server
        // ignores it for everyone else)
        if ((event.keyCode === 91 || event.keyCode === 93) && !event.repeat && !global.showChat && !global.died) {
            try { this.socket.talk('SPI'); } catch (e) { /* */ }
        }
        if (global.specialPressed) {
            event.preventDefault();
            if (!event.repeat) global.specialKeysPressed.push(event.keyCode);
            this.socket.talk("#", ...global.specialKeysPressed);
            return;
        }
        // raid kit, shop and free-camera keys take priority
        if (this.royaleKeyDown(event)) return;

        // Handle search input when tree is open and search bar is active
        if (global.showTree && global.searchBarActive) {
            if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
                event.preventDefault();
                this.tankTreeProps.searchQuery += event.key;
                global.searchTankByName(this.tankTreeProps.searchQuery);
                return;
            } else if (event.keyCode === 8) { // Backspace
                event.preventDefault();
                this.tankTreeProps.searchQuery = this.tankTreeProps.searchQuery.slice(0, -1);
                global.searchTankByName(this.tankTreeProps.searchQuery);
                return;
            } else if (event.keyCode === 27) { // Escape
                event.preventDefault();
                this.tankTreeProps.searchQuery = '';
                global.searchTankByName('');
                global.searchBarActive = false;
                return;
            } else if (event.keyCode === global.KEY_ENTER) {
                event.preventDefault();
                global.searchBarActive = false;
                return;
            }
        }

        switch (event.keyCode) {
            case global.KEY_SHIFT:
                if (global.showTree) this.treeScrollSpeedMultiplier = 5;
                else this.socket.cmd.set(6, true);
                break;

            case global.KEY_ENTER:
                // duos: dead, Enter still talks to your partner (Space or the
                // Play again button drops you back in)
                if (global.died && duoChat() && !global.disconnected) {
                    this.spawnChatInput();
                    break;
                }
                if (global.died) {
                    if (!global.cannotRespawn) { this.respawn(); break; }
                    break;
                }

                // or to talk instead
                if (global.gameStart && !global.died && !global.disconnected) {
                    if (enterGuarded(performance.now())) break;
                    this.spawnChatInput();
                    break;
                }
                break;

            case global.KEY_UP_ARROW:
                if (!global.died && global.showTree) return (global.classTreeDrag.isDragging = true, global.classTreeDrag.momentum.y = -this.treeScrollSpeed * this.treeScrollSpeedMultiplier);
            case global.KEY_UP:
                this.socket.cmd.set(0, true);
                break;
            case global.KEY_DOWN_ARROW:
                if (!global.died && global.showTree) return (global.classTreeDrag.isDragging = true, global.classTreeDrag.momentum.y = +this.treeScrollSpeed * this.treeScrollSpeedMultiplier);
            case global.KEY_DOWN:
                this.socket.cmd.set(1, true);
                break;
            case global.KEY_LEFT_ARROW:
                if (!global.died && global.showTree) return (global.classTreeDrag.isDragging = true, global.classTreeDrag.momentum.x = -this.treeScrollSpeed * this.treeScrollSpeedMultiplier);
            case global.KEY_LEFT:
                // A is movement, so never start spectate from it: key-repeat after
                // death would jump the camera to a random player.
                if (global.royaleSpectating && global.died && !event.repeat) {
                    this.socket.talk('RS', 0);
                    break;
                }
                if (global.died) break;
                this.socket.cmd.set(2, true);
                break;
            case global.KEY_RIGHT_ARROW:
                if (!global.died && global.showTree) return (global.classTreeDrag.isDragging = true, global.classTreeDrag.momentum.x = +this.treeScrollSpeed * this.treeScrollSpeedMultiplier);
            case global.KEY_RIGHT:
                if (global.royaleSpectating && global.died && !event.repeat) {
                    this.socket.talk('RS', 1);
                    break;
                }
                if (global.died) break;
                this.socket.cmd.set(3, true);
                break;
            case global.KEY_MOUSE_0:
                this.socket.cmd.set(4, true);
                break;
            case global.KEY_MOUSE_1:
                this.socket.cmd.set(5, true);
                break;
            case global.KEY_MOUSE_2:
                this.socket.cmd.set(6, true);
                break;
            case global.KEY_SIDEARM:
                this.socket.cmd.set(7, true);
                break;
            case global.KEY_TOKEN:
                this.socket.talk('0');
                break;
            case global.KEY_MAX_STAT:
                global.statMaxing = true;
                break;
            case global.KEY_TOGGLE_MAP:
                if (!global.gameStart || global.disconnected) break;
                global.showBigMap = !global.showBigMap;
                if (global.showBigMap) {
                    global.royaleBoard.tab = global.royaleBoard.tab || 'map';
                    global.bigMap.zoom = 1;
                    global.bigMap.cx = 0;
                    global.bigMap.cy = 0;
                    global.bigMap.dragging = false;
                    if (!global.died) this.releaseMovement();
                }
                break;
            case global.KEY_SUICIDE:
                this.socket.talk('1');
                break;
        }
        if (!event.repeat) {
            switch (event.keyCode) {
                case global.KEY_SPECIAL:
                    this.socket.talk("#");
                    global.specialPressed = true;
                    global.specialKeysPressed = [];
                    break;
                case global.KEY_AUTO_SPIN:
                    global.autoSpin = !global.autoSpin;
                    this.socket.talk("t", 0, true);
                    break;
                case global.KEY_AUTO_FIRE:
                    this.socket.talk("t", 1, true);
                    break;
                // R is AI override (Dig Wars has no Spin Lock)
                case global.KEY_OVER_RIDE:
                    this.socket.talk("t", 2, true);
                    break;
                case global.KEY_AUTO_ALT: {
                    // duos: a ping for your partner (dead or alive)
                    if (duoChat()) { this.duoPing(); break; }
                // G: enemy ping - drops a team-wide danger marker at
                    // the cursor's world position
                    const nowP = Date.now();
                    if (!this._lastEnemyPing || nowP - this._lastEnemyPing > 600) {
                        this._lastEnemyPing = nowP;
                        const wr = util.getRatio();
                        let wx = global.player.renderx + global.target.x / wr;
                        let wy = global.player.rendery + global.target.y / wr;
                        // degenerate ratio (hidden tab etc.) → ping own spot
                        if (!isFinite(wx) || !isFinite(wy)) {
                            wx = global.player.renderx;
                            wy = global.player.rendery;
                        }
                        if (isFinite(wx) && isFinite(wy)) this.socket.talk('EP', Math.round(wx), Math.round(wy));
                    }
                    break;
                }
                case global.KEY_REVERSE_MOUSE:
                    this.inverseMouse = !this.inverseMouse;
                    global.createMessage(this.inverseMouse ? "Reverse mouse enabled." : "Reverse mouse disabled.");
                    break;
                case global.KEY_REVERSE_TANK:
                    this.reverseDirection = !this.reverseDirection;
                    global.createMessage(this.reverseDirection ? "Reverse tank enabled." : "Reverse tank disabled.");
                    break;
                case global.KEY_SAVE:
                    // Save & leave: stay still 20 s for a code (saveCode.js).
                    // Checked before the debug overlay so an old saved bind
                    // that also sits on this key can't steal it.
                    if (window.dwSave) window.dwSave.toggle();
                    break;
                case global.KEY_DEBUG:
                    global.showDebug = !global.showDebug;
                    break;
                case global.KEY_CLASS_TREE:
                    this.tankTreeProps.enabled = !this.tankTreeProps.enabled;
                    global.tankTree(this.tankTreeProps.enabled ? "open" : "exit");
                    break;
                case global.KEY_RECORD:
                    this.record();
                    break;
                case global.KEY_SCREENSHOT:
                    this.screenshot();
                    break;
            }
            if (global.canSkill) {
                let skill = [
                    global.KEY_UPGRADE_ATK, global.KEY_UPGRADE_HTL, global.KEY_UPGRADE_SPD,
                    global.KEY_UPGRADE_STR, global.KEY_UPGRADE_PEN, global.KEY_UPGRADE_DAM,
                    global.KEY_UPGRADE_RLD, global.KEY_UPGRADE_MOB, global.KEY_UPGRADE_RGN,
                    global.KEY_UPGRADE_SHI, global.KEY_UPGRADE_MIN
                ].indexOf(event.keyCode);
                // firefox minus is 173
                if (skill < 0 && event.keyCode === 173 && global.KEY_UPGRADE_MIN === 189) skill = 10;
                // Numpad 1-9/0 as a second path to the same stats. Keyboards
                // block certain simultaneous key combinations in their wiring,
                // so a particular stat can be unreachable while you are holding
                // movement keys even though the neighbouring digits work. The
                // numpad sits on different matrix lines and gets through.
                if (skill < 0 && event.location === 3) {
                    if (event.keyCode >= 97 && event.keyCode <= 105) skill = event.keyCode - 97;
                    else if (event.keyCode === 96) skill = 9;
                    else if (event.keyCode === 109) skill = 10;
                }
                if (skill >= 0) {
                    this.socket.talk('x', skill, 1 * global.statMaxing);
                    gameSound.buildUpgrade();
                }
            }
            if (global.canUpgrade) {
                // the choose keys pick from the page on screen (app.js pager)
                const keys = [global.KEY_CHOOSE_1, global.KEY_CHOOSE_2, global.KEY_CHOOSE_3, global.KEY_CHOOSE_4, global.KEY_CHOOSE_5, global.KEY_CHOOSE_6];
                const kn = keys.indexOf(event.keyCode);
                if (kn >= 0) {
                    const pg = global.upgradePg && global.upgradePg.pg;
                    const i = pg ? upGrid.keyPick(kn, gui.upgrades.length, upGrid.pageSize(global.mobile), pg.page) : kn;
                    if (i >= 0 && gui.upgrades[i]) {
                        this.socket.talk("U", i, parseInt(gui.upgrades[i][0]));
                        gameSound.uiClick();
                    }
                }
            }
        }
    }
    keyUp(event) {
        if (global.dailyTankAd.renderUI) return;
        if (this.royaleKeyUp(event)) return;
        switch (event.keyCode) {
            case global.KEY_SPECIAL:
                global.specialPressed = false;
                global.specialKeysPressed = [];
                break;
            case global.KEY_SHIFT:
                if (global.showTree) this.treeScrollSpeedMultiplier = 1;
                else this.socket.cmd.set(6, false);
                break;
            case global.KEY_UP_ARROW:
                global.classTreeDrag.momentum.y = 0;
                global.classTreeDrag.isDragging = false;
            case global.KEY_UP:
                this.socket.cmd.set(0, false);
                break;
            case global.KEY_DOWN_ARROW:
                global.classTreeDrag.momentum.y = 0;
                global.classTreeDrag.isDragging = false;
            case global.KEY_DOWN:
                this.socket.cmd.set(1, false);
                break;
            case global.KEY_LEFT_ARROW:
                global.classTreeDrag.momentum.x = 0;
                global.classTreeDrag.isDragging = false;
            case global.KEY_LEFT:
                this.socket.cmd.set(2, false);
                break;
            case global.KEY_RIGHT_ARROW:
                global.classTreeDrag.momentum.x = 0;
                global.classTreeDrag.isDragging = false;
            case global.KEY_RIGHT:
                this.socket.cmd.set(3, false);
                break;
            case global.KEY_MOUSE_0:
                this.socket.cmd.set(4, false);
                break;
            case global.KEY_MOUSE_1:
                this.socket.cmd.set(5, false);
                break;
            case global.KEY_MOUSE_2:
                this.socket.cmd.set(6, false);
                break;
            case global.KEY_SIDEARM:
                this.socket.cmd.set(7, false);
                break;
            case global.KEY_MAX_STAT:
                global.statMaxing = false;
                break;
        }
        if (global.specialPressed) {
            let arrayCopy = global.specialKeysPressed.slice();
            let i = global.specialKeysPressed.indexOf(event.keyCode);
            if (i >= 0) {
                global.specialKeysPressed.splice(i, 1);
                arrayCopy[i] = -event.keyCode;
            }
            else arrayCopy.push(-event.keyCode);
            this.socket.talk("#", ...arrayCopy);
        }
    }
    mouseDown(mouse) {
        let primaryFire = 4,
            secondaryFire = 6;
        if (this.inverseMouse) [primaryFire, secondaryFire] = [secondaryFire, primaryFire];
        global.clickables.clicked = true;
        // a lost mouseup (a lag spike, a release off the window) must not
        // leave the aim-mode swallow or a kit / chip drag armed for this click
        this.aimClickHeld = false;
        if (mouse.button === 0) { global.kitDrag = null; global.chipDrag = null; }
        switch (mouse.button) {
            case 0:
                let mpos = {
                    x: mouse.clientX * global.ratio,
                    y: mouse.clientY * global.ratio,
                };
                // "Don't upgrade" acts on release, so remember whether the
                // press began on it: a shot fired elsewhere and released over
                // the button must not throw the upgrade menu away.
                this.skipUpgradePressed = global.clickables.skipUpgrades.check(mpos) !== -1;
                // the build buttons (Last tank, Same stats, Random) act on release too
                this.lastTankPressed = global.clickables.lastTank.check(mpos) !== -1;
                this.statBtnPressed = global.clickables.statBtn.check(mpos);
                // aim mode: the click puts the ability down and never fires the
                // gun. On a pad, or on a HUD button (the vault's Deposit, the
                // shop, the kit), the aim lets go and the click does its job.
                if (global.abilAim && global.abilAim.mode === "click" && (onAnyPad() || overHudButton(mpos))) abilityFx.cancelAim();
                if (global.abilAim && global.abilAim.mode === "click" && !global.died) {
                    this.placeAim();
                    this.aimClickHeld = true;
                    break;
                }
                // the shop panel acts on release too, and only for a press that
                // began on the same spot: a shot released over it as the panel
                // opens under you must never buy or equip
                this.shopPressed = global.shop && global.shop.onPad ? global.clickables.shop.check(mpos) : -1;
                // full-map overlay swallows clicks: start a drag, never fire
                if (global.showBigMap) {
                    const mScale = this.height / global.screenHeight;
                    global.bigMap.dragging = true;
                    global.bigMap.lastX = mpos.x / mScale;
                    global.bigMap.lastY = mpos.y / mScale;
                    break;
                }
                if (global.showTree) {
                    // Start dragging if not clicking UI elements
                    global.classTreeDrag.isDragging = true;
                    global.classTreeDrag.startX = global.classTreeDrag.lastX = mouse.clientX;
                    global.classTreeDrag.startY = global.classTreeDrag.lastY = mouse.clientY;
                    global.classTreeDrag.momentum = { x: 0, y: 0 };
                    break;
                }
                // a raid perk card, its Later button or the Perk ready chip:
                // picked or opened here, and the press never fires the gun
                if (raidPerks.click(mpos.x / guiScale(), mpos.y / guiScale())) break;
                // raid results: the Keep button, or a click that puts kept results away
                if (raidFinale.click(mpos.x / guiScale(), mpos.y / guiScale())) break;
                // a press on the dash or ability chip starts a drag to reorder
                // them (mouseUp swaps); it never fires the gun
                const chipHit = !global.died ? abilityFx.chipAt(mpos.x / guiScale(), mpos.y / guiScale()) : null;
                if (chipHit) {
                    global.chipDrag = { id: chipHit, x: mpos.x / guiScale(), y: mpos.y / guiScale() };
                    break;
                }
                // a press on a kit slot starts a drag; release decides (mouseUp)
                const kitHit = global.clickables.kit.check(mpos);
                if (kitHit !== -1 && kitHit < 3 && !global.died) {
                    global.kitDrag = { slot: kitHit, x: mpos.x, y: mpos.y };
                    break;
                }
                let statIndex = global.clickables.stat.check(mpos);
                let upgradeCheck = global.clickables.upgrade.check(mpos);
                if (statIndex !== -1) {
                    this.socket.talk('x', statIndex, 0);
                    global.statTapAt = performance.now();
                    gameSound.buildUpgrade();
                } else if (
                    !global.dailyTankAd.renderUI &&
                    global.clickables.optionsMenu.toggleBoxes.check(mpos) == -1 &&
                    global.clickables.optionsMenu.switchButton.check(mpos) == -1 &&
                    !(global.optionsMenu_Anim.hit && (
                        (!global.optionsMenu_Anim.isOpened && global.optionsMenu_Anim.hit.open &&
                            mpos.x >= global.optionsMenu_Anim.hit.open.x && mpos.x <= global.optionsMenu_Anim.hit.open.x + global.optionsMenu_Anim.hit.open.w &&
                            mpos.y >= global.optionsMenu_Anim.hit.open.y && mpos.y <= global.optionsMenu_Anim.hit.open.y + global.optionsMenu_Anim.hit.open.h) ||
                        (global.optionsMenu_Anim.isOpened && global.optionsMenu_Anim.hit.close &&
                            mpos.x >= global.optionsMenu_Anim.hit.close.x && mpos.x <= global.optionsMenu_Anim.hit.close.x + global.optionsMenu_Anim.hit.close.w &&
                            mpos.y >= global.optionsMenu_Anim.hit.close.y && mpos.y <= global.optionsMenu_Anim.hit.close.y + global.optionsMenu_Anim.hit.close.h)
                    )) &&
                    global.optionsMenu_Anim.tabClickables.check(mpos) == -1 &&
                    global.clickables.vault.check(mpos) == -1 &&
                    global.clickables.skipUpgrades.check(mpos) == -1 &&
                    global.clickables.lastTank.check(mpos) == -1 &&
                    global.clickables.upgradePage.check(mpos) == -1 &&
                    global.clickables.statBtn.check(mpos) == -1 &&
                    global.clickables.dailyTankUpgrade.check(mpos) == false &&
                    global.clickables.dailyTankAd.check(mpos) === false &&
                    global.clickables.royaleTab.check(mpos) == -1 &&
                    global.clickables.royaleSpectate.check(mpos) == -1 &&
                    global.clickables.royalePrev.check(mpos) == -1 &&
                    global.clickables.royaleNext.check(mpos) == -1 &&
                    global.clickables.royalePlay.check(mpos) == -1 &&
                    global.clickables.shop.check(mpos) == -1 &&
                    global.clickables.kit.check(mpos) == -1 &&
                    upgradeCheck == -1 &&
                    !global.died
                ) this.socket.cmd.set(primaryFire, true);
                break;
            case 1:
                if (duoChat()) this.duoPing();
                this.socket.cmd.set(5, true);
                break;
            case 2:
                // aim mode: right click backs out of it (nothing spent)
                if (global.abilAim && global.abilAim.mode === "click") {
                    abilityFx.cancelAim();
                    gameSound.uiClick();
                    this.aimClickHeld = true;
                    break;
                }
                this.socket.cmd.set(secondaryFire, true);
                break;
        }
    }
    // M, and a tap on the touch minimap
    toggleBigMap() {
        if (!global.gameStart || global.disconnected) return;
        global.showBigMap = !global.showBigMap;
        if (global.showBigMap) {
            global.royaleBoard.tab = global.royaleBoard.tab || 'map';
            global.bigMap.zoom = 1;
            global.bigMap.cx = 0;
            global.bigMap.cy = 0;
            global.bigMap.dragging = false;
            if (!global.died) this.releaseMovement();
        }
    }
    // duos: ping the spot under the cursor for your partner (the server
    // names it and rate limits to one a second; this just skips the spam)
    duoPing() {
        const now = Date.now();
        if (this._lastDuoPing && now - this._lastDuoPing < 900) return;
        this._lastDuoPing = now;
        const wr = util.getRatio();
        let wx = global.player.renderx + global.target.x / wr;
        let wy = global.player.rendery + global.target.y / wr;
        if (!isFinite(wx) || !isFinite(wy)) { wx = global.player.renderx; wy = global.player.rendery; }
        if (isFinite(wx) && isFinite(wy)) this.socket.talk('PG', Math.round(wx), Math.round(wy));
    }
    mouseUp(mouse) {
        let primaryFire = 4,
            secondaryFire = 6;
        if (this.inverseMouse) [primaryFire, secondaryFire] = [secondaryFire, primaryFire];
        global.clickables.clicked = false;
        // the release of the click that placed or cancelled an aim
        if (this.aimClickHeld && (mouse.button === 0 || mouse.button === 2)) { this.aimClickHeld = false; return; }
        switch (mouse.button) {
            case 0:
                let mpos = {
                    x: mouse.clientX * global.ratio,
                    y: mouse.clientY * global.ratio,
                };
                // the end of a tap on a raid perk card (touch picks on release)
                if (raidPerks.release(mpos.x / guiScale(), mpos.y / guiScale())) break;
                if (global.chipDrag) {
                    // dropped on the other chip: they trade places (layout only)
                    const d = global.chipDrag;
                    global.chipDrag = null;
                    const over = abilityFx.chipAt(mpos.x / guiScale(), mpos.y / guiScale());
                    if (over && over !== d.id) { abilityFx.swapChips(d.id, over); gameSound.uiClick(); }
                    break;
                }
                if (global.kitDrag) {
                    // a tap uses the item; a drag onto another slot swaps them;
                    // a drag out of the box throws it away
                    const d = global.kitDrag;
                    global.kitDrag = null;
                    const moved = Math.hypot(mpos.x - d.x, mpos.y - d.y) > 14;
                    const target = global.clickables.kit.check(mpos);
                    const overSlot = target === d.slot;
                    if (moved && target >= 0 && target < 3 && target !== d.slot) { this.swapKitSlots(d.slot, target); }
                    else if (!moved || overSlot) { if (!moved) this.useKitSlot(d.slot); }
                    else if (!global.died) { this.socket.talk('kd', d.slot); global.kitDropped = (global.kitDropped | 0) + 1; gameSound.uiClick(); }
                    break;
                }
                let upgradeIndex = global.clickables.upgrade.check(mpos);
                let dailyTankUpgrade = global.clickables.dailyTankUpgrade.check(mpos);
                let dailyTankAd = global.clickables.dailyTankAd.check(mpos);
                let dailyTankCloseAd = global.clickables.dailyTankCloseAd.check(mpos);
                let respawnCheck = global.clickables.deathRespawn.check(mpos);
                let exitGame = global.clickables.exitGame.check(mpos);
                let reconnectCheck = global.clickables.reconnect.check(mpos);
                if (reconnectCheck !== -1 && global.disconnected) {
                    global.reconnect();
                    gameSound.uiClick();
                    break;
                }
                // Death / spectate buttons use the same clickable regions as
                // settings and chat. Check them before the map overlay.
                if (respawnCheck !== -1 && !global.disconnected) {
                    this.respawn(); gameSound.uiClick();
                    break;
                }
                if (global.clickables.royaleSpectate.check(mpos) !== -1 && !global.disconnected && global.died) {
                    global.royaleSpectating = true;
                    this.socket.talk('RS', window.dwDuoMateAlive && window.dwDuoMateAlive() ? 3 : 2);
                    gameSound.uiClick();
                    break;
                }
                if (global.clickables.royalePrev.check(mpos) !== -1 && global.died) {
                    global.royaleSpectating = true;
                    this.socket.talk('RS', 0);
                    gameSound.uiClick();
                    break;
                }
                if (global.clickables.royaleNext.check(mpos) !== -1 && global.died) {
                    global.royaleSpectating = true;
                    this.socket.talk('RS', 1);
                    gameSound.uiClick();
                    break;
                }
                if (global.clickables.royalePlay.check(mpos) !== -1 && global.died && !global.disconnected) {
                    this.respawn();
                    gameSound.uiClick();
                    break;
                }
                if (exitGame !== -1 && (global.disconnected || global.died)) {
                    global.exit();
                    gameSound.uiClick();
                    break;
                }
                // outfitter panel: items 4-39, buy 40, close 41, tabs 42 and up
                const shopClick = global.clickables.shop.check(mpos);
                if (shopClick !== -1 && global.shop.onPad && !global.died) {
                    const sh = global.shop;
                    const pressed = this.shopPressed === shopClick && performance.now() - (sh.openAt || 0) > 300;
                    this.shopPressed = -1;
                    if (!pressed) break;
                    if (shopClick >= 42) { const id = (sh.tabIds || [])[shopClick - 42]; if (id) { sh.tab = id; sh.tabPicked = true; } }
                    else if (shopClick === 40) { if (sh.sel) this.socket.talk('sb', String(sh.sel)); }
                    else if (shopClick === 41) sh.dismissed = true;
                    else {
                        const it = (sh.tabItems || [])[shopClick - 4];
                        if (it) sh.sel = it.id;
                    }
                    gameSound.uiClick();
                    break;
                }
                const kitClick = global.clickables.kit.check(mpos);
                if (kitClick !== -1 && !global.died) {
                    // slots are handled by the press/drag path above; chips and
                    // gear tags are hover-only
                    break;
                }
                if (global.showBigMap && !global.disconnected) {
                    const tab = global.clickables.royaleTab.check(mpos);
                    if (tab !== -1) {
                        global.royaleBoard.tab = ['map', 'standings', 'feed', 'alive'][tab] || 'map';
                        gameSound.uiClick();
                        break;
                    }
                    global.bigMap.dragging = false;
                    break;
                }
                let optionsMenu_Switch = global.clickables.optionsMenu.switchButton.check(mpos);
                let optionsMenu_toggleBox = global.clickables.optionsMenu.toggleBoxes.check(mpos);
                let optionsMenu_tabClick = global.optionsMenu_Anim.tabClickables ? global.optionsMenu_Anim.tabClickables.check(mpos) : -1;
                // Direct hit-rects published by drawOptionsMenu: the same
                // geometry that's actually drawn, so the arrow button can't
                // go dead if the clickable-region state drifts
                const omHitRect = (r) => !!r && mpos.x >= r.x && mpos.x <= r.x + r.w &&
                                                mpos.y >= r.y && mpos.y <= r.y + r.h;
                const omHit = global.optionsMenu_Anim.hit || {};
                // Options menu clickables
                if (optionsMenu_Switch === 0 ||
                    (!global.optionsMenu_Anim.isOpened && omHitRect(omHit.open))) {
                    global.optionsMenu_Anim.switchMenu_button.set(-40);
                    global.optionsMenu_Anim.mainMenu.set(25);
                    global.optionsMenu_Anim.isOpened = true;
                    gameSound.uiClick();
                    break;
                }
                if (optionsMenu_Switch === 1 ||
                    (global.optionsMenu_Anim.isOpened && omHitRect(omHit.close))) {
                    global.optionsMenu_Anim.switchMenu_button.set(0);
                    global.optionsMenu_Anim.mainMenu.set(-500);
                    global.optionsMenu_Anim.isOpened = false;
                    gameSound.uiClick();
                    break;
                }
                if (optionsMenu_tabClick !== -1) {
                    global.optionsMenu_Anim.activeTab = optionsMenu_tabClick;
                    global.optionsMenu_Anim.tabOffset.set(optionsMenu_tabClick);
                    global.optionsMenu_Anim.mainMenuHeight.set(global.optionsMenu_Anim.tabs[optionsMenu_tabClick][1]);
                    gameSound.uiClick();
                    break;
                }
                // Dig Wars vault panel: 10 deposit (reads the typed input),
                // 11 cancel
                let vaultClick = global.clickables.vault.check(mpos);
                if (vaultClick !== -1) {
                    if (vaultClick === 9) {
                        // Bank all: 0 is "everything carried" on the server, so a gem picked up a moment
                        this.socket.talk('vd', 0);
                    } else if (vaultClick === 10) {
                        const el = document.getElementById('vaultInput');
                        const carried = global.gems.carried | 0;
                        // an empty or cleared box means everything you carry
                        const typed = parseInt(el && el.value);
                        const n = typed > 0 ? Math.min(carried, typed) : carried;
                        this.socket.talk('vd', Math.max(0, n));
                    } else if (vaultClick === 11) {
                        this.socket.talk('vc');
                    }
                    gameSound.uiClick();
                    break;
                }
                if (optionsMenu_toggleBox !== -1) {
                    let box = global.optionsCheckboxes[optionsMenu_toggleBox];
                    let doc = document.getElementById(box.id);
                    box.value = !box.value;
                    if (doc) doc.checked = box.value;
                    if (doc) util.submitToLocalStorage(box.id);
                    gameSound.uiClick();
                    break;
                }
                let optionsMenu_themeClick = (global.optionsMenu_Anim.isOpened && global.optionsMenu_Anim.activeTab === 1 && global.optionsMenu_Anim.themeClickables) ? global.optionsMenu_Anim.themeClickables.check(mpos) : -1;
                if (optionsMenu_themeClick !== -1) {
                    const themeValues = ["normal","dark","classic","classicDark","natural","discord","midnight","solarizedDark","retro","snow","navigator","coralReef","gruvbox","eggplant","wrSheetTheme","lyric","bleach","nebula","forest","pastel","descent","badlands","pumpkinSkeleton","blindness"];
                    let sel = document.getElementById("optColors");
                    if (sel && themeValues[optionsMenu_themeClick]) {
                        sel.value = themeValues[optionsMenu_themeClick];
                        sel.dispatchEvent(new Event("change"));
                        util.submitToLocalStorage("optColors");
                    }
                    gameSound.uiClick();
                    break;
                }
                // Stop dragging class tree
                if (global.classTreeDrag.isDragging) {
                    global.classTreeDrag.isDragging = false;
                }
                if (global.clickables.classTreeClose.check(mpos) === 0) {
                    global.tankTree("exit");
                    gameSound.uiClick();
                    break;
                }

                // Check zoom buttons
                if (global.clickables.classTreeZoomIn.check(mpos) === 0) {
                    global.targetTreeScale = Math.min(global.targetTreeScale * 1.2, 8);
                    gameSound.uiClick();
                    break;
                }
                if (global.clickables.classTreeAll.check(mpos) === 0) {
                    try { window.open("/tanks", "_blank", "noopener"); } catch (e) { /* popup blocked */ }
                    gameSound.uiClick();
                    break;
                }
                if (global.clickables.classTreeZoomOut.check(mpos) === 1) {
                    global.targetTreeScale = Math.max(global.targetTreeScale / 1.2, 0.5);
                    gameSound.uiClick();
                    break;
                }

                // Check search bar click
                const searchBarWidth = 300;
                const searchBarHeight = 35;
                const searchBarX = global.screenWidth / 2 / global.ratio - searchBarWidth / 2;
                const searchBarY = 30;

                if (mpos.x / global.ratio >= searchBarX && 
                    mpos.x / global.ratio <= searchBarX + searchBarWidth &&
                    mpos.y / global.ratio >= searchBarY && 
                    mpos.y / global.ratio <= searchBarY + searchBarHeight) {
                    global.searchBarActive = true;
                    break;
                } else {
                    global.searchBarActive = false;
                }
                if (global.clickables.royaleTab.check(mpos) !== -1) {
                    const tab = global.clickables.royaleTab.check(mpos);
                    global.royaleBoard.tab = ['map', 'standings', 'feed', 'alive'][tab] || 'map';
                    global.showBigMap = true;
                    gameSound.uiClick();
                    break;
                }
                if (reconnectCheck !== -1) {
                    gameSound.uiClick();
                } else
                if (upgradeIndex !== -1 && upgradeIndex < gui.upgrades.length && !global.dailyTankAd.renderUI) {
                    this.socket.talk('U', upgradeIndex, parseInt(gui.upgrades[upgradeIndex][0]));
                    // touch: the tank picker stays up for the next tier (app.js touchTilesOpen)
                    global.upgradePickedAt = performance.now();
                    gameSound.uiClick();
                } else if (dailyTankUpgrade == true && !global.dailyTankAd.renderUI) {
                    this.socket.talk('U', JSON.stringify([{isDailyUpgrade: true, tank: gui.dailyTank.tank}]), "null");
                    gameSound.uiClick();
                } else if (dailyTankAd == true) {
                    this.socket.talk("DTA"); // Request to get an ad
                    gameSound.uiClick();
                } else if (dailyTankCloseAd == true && global.dailyTankAd.renderUI) {
                    this.socket.talk("DTAD");
                    gameSound.uiClick();
                } else if (this.skipUpgradePressed && global.clickables.skipUpgrades.check(mpos) !== -1) {
                    this.skipUpgradePressed = false;
                    global.clearUpgrades();
                    gameSound.uiClick();
                } else if (global.clickables.upgradePage.check(mpos) !== -1 && global.upgradePg && global.upgradePg.pg) {
                    const UG = global.upgradePg;
                    UG.page = upGrid.turn(UG.page, UG.pg.pages, global.clickables.upgradePage.check(mpos) === 0 ? -1 : 1);
                    gameSound.uiClick();
                } else if (this.lastTankPressed && global.clickables.lastTank.check(mpos) !== -1) {
                    this.lastTankPressed = false;
                    this.socket.talk('rb', 'tank');
                    global.upgradePickedAt = performance.now();
                    gameSound.uiClick();
                } else if (this.statBtnPressed > -1 && global.clickables.statBtn.check(mpos) === this.statBtnPressed) {
                    this.socket.talk('rb', this.statBtnPressed === 0 ? 'stats' : 'random');
                    this.statBtnPressed = -1;
                    gameSound.uiClick();
                } else this.socket.cmd.set(primaryFire, false);
                break;
            case 1:
                this.socket.cmd.set(5, false);
                break;
            case 2:
                this.socket.cmd.set(secondaryFire, false);
                break;
        }
    }
    mouseMove(mouse) {
        // full-map overlay: drag to pan (world-space, so it tracks 1:1 at
        // any zoom)
        if (global.showBigMap && global.bigMap.dragging) {
            const bm = global.bigMap, P = bm._panel;
            const mScale = this.height / global.screenHeight;
            const mx = (mouse.clientX * global.ratio) / mScale;
            const my = (mouse.clientY * global.ratio) / mScale;
            if (P) {
                bm.cx -= (mx - bm.lastX) / P.s;
                bm.cy -= (my - bm.lastY) / P.s;
            }
            bm.lastX = mx;
            bm.lastY = my;
            global.mouse.x = mouse.clientX * global.ratio;
            global.mouse.y = mouse.clientY * global.ratio;
            return;
        }
        // Handle class tree dragging with smooth momentum
        if (global.showTree && global.classTreeDrag.isDragging) {
            const dx = (mouse.clientX - global.classTreeDrag.lastX) / global.treeScale;
            const dy = (mouse.clientY - global.classTreeDrag.lastY) / global.treeScale;

            // Smooth momentum update
            global.classTreeDrag.momentum.x = -dx * 0.01;
            global.classTreeDrag.momentum.y = -dy * 0.01;

            global.classTreeDrag.lastX = mouse.clientX;
            global.classTreeDrag.lastY = mouse.clientY;
            return;
        }
        global.statHover =
            global.clickables.hover.check({
                x: mouse.clientX * global.ratio,
                y: mouse.clientY * global.ratio,
            }) === 0;
        if (this.spinLock) return;
        global.mouse.x = mouse.clientX * global.ratio;
        global.mouse.y = mouse.clientY * global.ratio;
        if (global.gameStart) {
            this.mouseMoved = true;
            global.socket.cmd.reactNow();
        }
    }
    record() {
        // Merges the stacked game canvases into one each frame for the
        // recorder. The recorder saves the file itself when it stops.
        // phones record a lighter file: at most 1280 wide, 30 fps, 6 Mbps
        const scale = global.mobile ? Math.min(1, 1280 / Math.max(this.cv.width, this.cv.height)) : 1;
        let AdvancedCanvasCapturer = () => {
            let canvas = document.createElement("canvas");
            let ctx = canvas.getContext("2d", { alpha: false });
            let layers = [];
            let stop = false;
            let srcW = 0, srcH = 0;
            return {
                init: () => {
                    layers = [this.cvb, global.glCanvas || null, this.cvg, this.cvu].filter(Boolean);
                    canvas.width = Math.round(this.cv.width * scale);
                    canvas.height = Math.round(this.cv.height * scale);
                },
                start: () => {
                    stop = false;
                    srcW = this.cv.width; srcH = this.cv.height;
                    canvas.width = Math.round(srcW * scale);
                    canvas.height = Math.round(srcH * scale);
                    const anim = () => {
                        if (stop) return;
                        if (srcW !== this.cv.width || srcH !== this.cv.height) {
                            global.createMessage("Recording stopped because the window resized. Saving...", 5_000);
                            this.videoRecorderCanvas.stop();
                            if (this.videoRecorder.state === "recording") this.videoRecorder.stop();
                            return;
                        }
                        ctx.fillStyle = "#000";
                        ctx.fillRect(0, 0, canvas.width, canvas.height);
                        for (const layer of layers) ctx.drawImage(layer, 0, 0, canvas.width, canvas.height);
                        requestAnimationFrame(anim);
                    };
                    anim();
                },
                stop: () => { stop = true; },
                getCanvas: () => canvas
            }
        }
        if (!this.cv.captureStream || !window.MediaRecorder) {
            global.createMessage("Your browser can't record video.", 4_000);
            return;
        }
        if (this.videoRecorder && this.videoRecorder.state === "recording") {
            if (!global.mobile) global.createMessage("Recording saved!", 4_000);
            this.videoRecorderCanvas.stop();
            this.videoRecorder.stop();
            return;
        }
        // a fresh recorder each time: the canvas size may have changed
        this.videoRecorderCanvas = AdvancedCanvasCapturer();
        this.videoRecorderCanvas.init();
        this.videoRecorderCanvas.start();
        try {
            this.videoRecorder = global.mobile
                ? new AdvancedRecorder(this.videoRecorderCanvas.getCanvas(), 30, { maxBps: 6e6, onSaved: (blob, name) => touch.showClip(blob, name) })
                : new AdvancedRecorder(this.videoRecorderCanvas.getCanvas(), 60);
            this.videoRecorder.start();
            global.createMessage(global.mobile ? "Recording. Tap the red button again to stop." : "Recording... press the record key again to stop.", 3_000);
        } catch (e) {
            this.videoRecorderCanvas.stop();
            this.videoRecorder = null;
            global.createMessage("Couldn't start recording.", 4_000);
        }
    }
    screenshot() {
        let AdvancedCanvasCapturer = () => {
            let canvas = this.cvb.cloneNode();
            let ctx = canvas.getContext("2d");
            let toMerge = [];
            return {
                init: () => {
                    let glCanvas = global.glCanvas || null;
                    // Merge all layers, including WebGL2 if present
                    toMerge = glCanvas
                    ? [this.cvb, glCanvas, this.cvg, this.cvu]
                    : [this.cvb, this.cvg, this.cvu];
                    ctx.canvas.width = this.cv.width;
                    ctx.canvas.height = this.cv.height;
                },
                capture: () => {
                    ctx.canvas.width = this.cv.width;
                    ctx.canvas.height = this.cv.height;
                    ctx.fillStyle = "#ffffff"
                    ctx.fillRect(0, 0, this.cv.width, this.cv.height);
                    toMerge.forEach(layer => {
                        if (layer) ctx.drawImage(layer, 0, 0, this.cv.width, this.cv.height);
                    });
                },
                getCanvas: () => canvas
            }
        }
        if (this.screenshotCanvas) {
            this.screenshotCanvas.capture();
        } else {
            this.screenshotCanvas = AdvancedCanvasCapturer();
            this.screenshotCanvas.init();
            this.screenshotCanvas.capture();
        }
        let cv = this.screenshotCanvas.getCanvas();
        var x = cv.toDataURL(),
            k = atob(x.split(",")[1]);
        x = x.split(",")[0].split(":")[1].split(";")[0];
        let p = new Uint8Array(k.length);
        for (let a = 0; a < k.length; a++) p[a] = k.charCodeAt(a);
        let q = URL.createObjectURL(new Blob([p], {type: x})),
        w = document.createElement("a");
        w.style.display = "none";
        w.setAttribute("download", "osa-screenshot.png");
        w.setAttribute("href", q);
        document.body.appendChild(w);
        setTimeout(() => {
            URL.revokeObjectURL(q);
            document.body.removeChild(w);
        }, 100);
        w.click();
        global.createMessage("Saving screenshot...", 3_000);
    }
    // CONTROLLER/GAMEPAD SUPPORT
    runGamepad() {
        let sendHelp = () => {
            let helpLines = [
                "Control help menu:",
                "Options button = Help Menu",
                "RT / R2 = Fire",
                "LT / L2 = Alt Fire",
                "Left Joystick: Move Body",
                "Right Joystick: Move Face",
                "A / X = Autofire",
                "B / O = Autospin",
                "X / ■ = Override",
                "Y / ▲ = Take Control",
            ];
            global.createMessage(JSON.stringify(helpLines), 15_000, true);
        }
        let gamepadControls = {
            A: 0,
            B: 0,
            X: 0,
            Y: 0,
            help: 0,
        }
        global.gamepadMode = true;
        global.player.target = this.target;
        this.gamepadInterval = setInterval(() => {
            let gamepads = navigator.getGamepads().find((x) => x !== null)
            if (gamepads) {
                this.gamepad = gamepads;
            } else this.gamepad = undefined;
            if (this.gamepad) {
                let angle = (p) => (p < this.gamepad.axes.length ? this.gamepad.axes[p] : 0);
                let target = this.gamepad.axes.slice(0, 2).map((x) => Math.round(x))
                var h = angle(2);
                angle = angle(3);
                if (0.01 < h * h + angle * angle) {
                    let p = 0.6 * Math.max(global.screenWidth, global.screenHeight);
                    this.target.x = (h * p);
                    this.target.y = (angle * p);
                    global.mobileStatus.showCrosshair = true;
                } else global.mobileStatus.showCrosshair = false;
                /*for (let i = 0; i < this.gamepad.buttons.length; i++) { // If you want to add a button, uncomment this and get the array number.
                    let info = this.gamepad.buttons[i];
                    if (info.pressed) {
                        let debugLine = [
                            "(DEBUG)",
                            `Array number: ${i}`,
                        ];
                        global.createMessage(JSON.stringify(debugLine), 5_000, true);
                    }
                }*/
                // Button presses
                if (this.gamepad.buttons[0].pressed) {
                    gamepadControls.A++
                } else {
                    gamepadControls.A = 0;
                }
                if (this.gamepad.buttons[1].pressed) {
                    gamepadControls.B++
                } else {
                    gamepadControls.B = 0;
                }
                if (this.gamepad.buttons[2].pressed) {
                    gamepadControls.X++
                } else {
                    gamepadControls.X = 0;
                }
                if (this.gamepad.buttons[3].pressed) {
                    gamepadControls.Y++
                } else {
                    gamepadControls.Y = 0;
                }
                if (this.gamepad.buttons[9].pressed) {
                    gamepadControls.help++
                } else {
                    gamepadControls.help = 0;
                }
                if (gamepadControls.A === 1) {
                    this.socket.talk("t", 1, true);
                }

                if (gamepadControls.B === 1) {
                    global.autoSpin = !global.autoSpin;
                    this.socket.talk("t", 0, true);
                }

                if (gamepadControls.X === 1) {
                    this.socket.talk("t", 2, true);
                }

                if (gamepadControls.Y === 1) {
                    this.socket.talk('H');
                }

                if (gamepadControls.help === 1) {
                    sendHelp();
                }
                // Shoot
                if (this.gamepad.buttons[7].pressed) {
                    if (global.died && !global.cannotRespawn) {
                        this.respawn();
                    } else {
                        this.socket.cmd.set(4, true);
                    }
                } else {
                    this.socket.cmd.set(4, false);
                }
                // Alt shoot
                if (this.gamepad.buttons[6].pressed) {
                    this.socket.cmd.set(6, true);
                } else {
                    this.socket.cmd.set(6, false);
                }
                // Sidearm (left bumper)
                this.socket.cmd.set(7, !!(this.gamepad.buttons[4] && this.gamepad.buttons[4].pressed));
                // Move body
                let cx = 0;
                let cy = 0;
                let ex = target[0];
                let ey = target[1];
                if (ex > cx) {
                    this.socket.cmd.set(2, false);
                    this.socket.cmd.set(3, true);
                } else if (ex < cx) {
                    this.socket.cmd.set(2, true);
                    this.socket.cmd.set(3, false);
                } else {
                    this.socket.cmd.set(2, false);
                    this.socket.cmd.set(3, false);
                }

                if (ey > cy) {
                    this.socket.cmd.set(0, false);
                    this.socket.cmd.set(1, true);
                } else if (ey < cy) {
                    this.socket.cmd.set(0, true);
                    this.socket.cmd.set(1, false);
                } else {
                    this.socket.cmd.set(0, false);
                    this.socket.cmd.set(1, false);
                }
            }
        }, 10)
        global.createMessage("Gamepad mode is ready.");
        sendHelp();
    }
    stopGamepad() {
        clearInterval(this.gamepadInterval);
        this.gamepad = undefined;
        global.gamepadMode = false;
        this.socket.cmd.set(0, false);
        this.socket.cmd.set(1, false);
        this.socket.cmd.set(2, false);
        this.socket.cmd.set(3, false);
        this.socket.cmd.set(4, false);
        this.socket.cmd.set(6, false);
        this.socket.cmd.set(7, false);
    }
}
export { Canvas }
