import { util } from "./util.js";
import { global } from "./global.js";
import { config } from "./config.js";
import { Canvas } from "./canvas.js";
import { color as colors } from "./color.js";
import { gameDraw } from "./gameDraw.js";
import * as socketStuff from "./socketinit.js";
import './terrainRenderer.js';
import { gameSound } from "./sound.js";
import * as tutorial from './tutorial.js';
import * as coach from './coach.js';
import * as firstHints from './firstHints.js';
import { touch, STICK, touchPref, haptic, AIMED_KIT, mobileFullscreen, touchPrimary } from './touch.js';
import * as raidFinale from './raidFinale.js';
import * as levelsHud from './levelsHud.js';
import * as signupPrompt from './signupPrompt.js';
import * as stormFx from './stormFx.js';
import * as abilityFx from './abilityFx.js';
import * as abilityIntro from './abilityIntro.js';
import * as nameCheck from './nameHint.js';
import { tabSeen, markTabSeen, TAB_SEEN_MS } from './abilityIntroLogic.js';
import * as raidHeat from './raidHeat.js';
import * as crowns from './crowns.js';
import * as scoreText from './scoreLogic.js';
import * as newcomer from './newcomer.js';
import * as firstSeconds from './firstSeconds.js';
import { shopHint, minesBy } from './firstSecondsLogic.js';
import { full as fxFull, slamShowing, slamUp as juiceSlamUp, burst as juiceBurst, ring as juiceRing } from './juice.js';
import * as autoQ from './autoQuality.js';
import { ResGovernor, RES, resBudget, resLevels } from './autoQualityLogic.js';
import * as rankBadges from './account/rankBadges.js';
import * as rankPanel from './account/rankPanel.js';
import * as rankCeremony from './account/rankCeremony.js';
import * as dustHud from './account/dustHud.js';
import { BY_ID as ACH_BY_ID } from './account/achievements.js';
import * as achCard from './achievementCard.js';
import * as cosmetics from './account/cosmetics.js';
import * as sidekicks from './sidekicks.js';
import * as hitFx from './hitFx.js';
import * as raidPerks from './raidPerks.js';
import * as bankPopLogic from './bankPopLogic.js';
import { tankFloor as perkTankFloor, overlaps as rectsOverlap } from './raidPerksLogic.js';
import * as deathText from './deathCardLogic.js';
import * as buildBtnLabels from './buildButtonsLogic.js';
import { layoutLabels } from './labelLayout.js';
import * as chatPanel from './chatPanelLogic.js';
import * as upGrid from './upgradeGridLogic.js';
import * as treeUi from './tankTree.js';
import { netSmooth } from './netSmooth.js';
import { predictor } from './predict.js';
import * as aoHud from './alwaysOn.js';

(async function (util, global, config, Canvas, color, gameDraw, socketStuff) {
    let { socketInit, resync, gui, leaderboard, minimap, moveCompensation, lag, getNow } = socketStuff;

    // ---- Hit feedback ----------------------------------------------------
    // The server triggers the blink (entity.js stamps hitAt and reports a
    // decaying hitFlash); this only draws it. A hit flashes the body red,
    // diep style; a body that's red already flashes warm white instead, or
    // the hit would vanish into it. The first frame or two go white hot and
    // the body punches up a touch; the curves live in hitFx.js.
    const HIT_BLINK_MS = hitFx.FLASH_MS;
    const HIT_BLINK_COLOR = "#FFF4E0";
    const HIT_BLINK_RED = "#FF3B3B";
    const hitTints = new Map();
    function hitTintFor(hex) {
        let t = hitTints.get(hex);
        if (t === undefined) {
            const c = parseInt(String(hex).slice(1), 16) || 0;
            const r = (c >> 16) & 255, g = (c >> 8) & 255, b = c & 255;
            t = r > 170 && g < 130 && b < 130 ? HIT_BLINK_COLOR : HIT_BLINK_RED;
            if (hitTints.size > 256) hitTints.clear();
            hitTints.set(hex, t);
        }
        return t;
    }
    const DMG_FADE_IN_MS = 160;
    const DMG_POP_MS = 300;
    const DMG_FADE_OUT_MS = 900;
    const DMG_COMBO_HOLD_MS = 1000;
    const DMG_RISE = 50;
    // Low-health vignette: starts faint around half health and creeps inward.
    const LOW_HP_START = 0.52;
    const LOW_HP_FULL = 0.06;
    const HIT_TICK_MS = 400;
    const killSkullImg = new Image();
    killSkullImg.src = "img/skull.svg";

    fetch("changelog.md", { cache: "no-cache" }).then(response => response.text()).then(response => {
        let a = [];
        for (let c of response.split("\n")) {
            0 !== c.length && (response = c.charAt(0), "#" === response ? (initalizeChangelog(a, !0), a = [c.slice(1).trim()]) : "-" === response ? a.push(c.slice(1).trim()) : a[a.length - 1] += " " + c.trim());
        }
    });

    let controls = document.getElementById("controlSettings"),
        resetButton = document.getElementById("resetControls"),
        selectedElement = null,
        controlsArray = [],
        defaultKeybinds = {},
        keybinds = {};
    // Graphics > Performance switches for slow machines. Off by default.
    const PERF_TOGGLES = ["optFewerFx", "optSimpleTerrain", "optNoShake", "optNoGlow", "optNoGlitch", "optLightSafe", "opt30Fps"];

    // in a raid and alive, for portal SDKs (client/portal.js); read-only and
    // available everywhere, unlike the qa hooks below
    window.dwPlaying = () => !!(global.gameStart && !global.died && !global.disconnected);

    // qa hooks, local servers only: forward a packet to the socket, read the
    // state, and window.dwGems(10000) for trying items
    const localHost = /^(localhost|127\.0\.0\.1|\[::1\]|.+\.localhost|.+\.test)$/.test(location.hostname);
    if (localHost) {
        window.royaleTalk = (...m) => { try { return global.socket && global.socket.talk && global.socket.talk(...m); } catch (e) { return e; } };
        window.royaleState = () => global;
        window.dwGems = (n = 10000) => window.royaleTalk("DBG", "gems", n | 0);
    }
    // The server sends the menu only when it changes, so anything cleared
    // here stays gone until the next evolve. The slide-out clear must never
    // outlive its menu, or it wipes the next life's menu when that one slides
    // away (tank tree, resync).
    let upgradeClearLoop = null;
    global.clearUpgrades = (clearNow = false) => {
        if (upgradeClearLoop) { clearInterval(upgradeClearLoop); upgradeClearLoop = null; }
        if (clearNow || !gui.upgrades.length) gui.upgrades = [];
        else {
            global.pullUpgradeMenu = true;
            upgradeClearLoop = setInterval(() => {
                // something brought the menu back (spawn, tree closed): keep it
                if (!global.pullUpgradeMenu) {
                    clearInterval(upgradeClearLoop);
                    upgradeClearLoop = null;
                } else if (!gui.upgrades.length || upgradeMenu.get() < (-global.columnCount * 3) * 0.9999) {
                    global.pullUpgradeMenu = false;
                    gui.upgrades = [];
                    clearInterval(upgradeClearLoop);
                    upgradeClearLoop = null;
                }
            }, 10)
        }
    }

    let leaderboardEntries = {};
    let leaderboardUpdate = 0;
    global.canUpgrade = false;
    global.canSkill = false;
    global.showTree = false;
    global.message = "";
    global.time = 0;
    global.guntime = 0;

    var upgradeSpin = 0,
        lastPing = 0,
        lasttick = 0,
        fovlasttick = 0;

    let tips = global.tips[Math.floor(Math.random() * global.tips.length)];
    global.tips = tips[Math.floor(Math.random() * tips.length)];

    // Touch play for touch-first devices (touchInput.js touchPrimary): the
    // primary pointer decides, not the user agent alone. It still flips while
    // you play: a mouse that moves or game keys with a pointer to aim with go
    // to mouse and keys, a touch on the game goes to touch (setTouchMode).
    const mq = (q) => { try { return window.matchMedia ? window.matchMedia(q).matches : null; } catch (e) { return null; } };
    global.inputEnv = () => ({ ua: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints, coarse: mq("(pointer: coarse)"), fine: mq("(any-pointer: fine)") });
    global.mobile = touchPrimary(global.inputEnv());
    global.mobile && document.body.classList.add("mobile");
    if (!global.mobile) {
        document.getElementById("tabAppearance").classList.remove("shadowScroll");
        document.getElementById("tabOptions").classList.remove("shadowScroll");
    };

    function getKeybinds() {
        let kb = localStorage.getItem("keybinds");
        keybinds = typeof kb === "string" && kb.startsWith("{") ? JSON.parse(kb) : {};
        // L used to be the debug overlay; a bind saved back then would now
        // clash with Save & leave, so it goes back to the new default (F8)
        if (keybinds.KEY_DEBUG && keybinds.KEY_DEBUG[1] === 76 && !keybinds.KEY_SAVE) {
            delete keybinds.KEY_DEBUG;
            setKeybinds();
        }
        // Dash moved off Shift (Shift is repel again), then briefly sat on F
        // and backtick: a dash bind saved on any of them goes to Alt
        if (keybinds.KEY_DASH && [16, 70, 192].includes(keybinds.KEY_DASH[1])) {
            delete keybinds.KEY_DASH;
            setKeybinds();
        }
        // Reverse mouse sat on B (the Bank key) and swapped the buttons whenever
        // someone banked off a pad: a saved B for it goes back to unbound
        if (keybinds.KEY_REVERSE_MOUSE && keybinds.KEY_REVERSE_MOUSE[1] === 66) {
            delete keybinds.KEY_REVERSE_MOUSE;
            setKeybinds();
        }
        // a Mac calls that key Option
        if (!keybinds.KEY_DASH && /Mac|iPhone|iPad/.test(navigator.platform)) {
            for (const b of document.querySelectorAll('b[data-key="KEY_DASH"]')) b.textContent = "Option";
        }
        // Dash, Q (ability), comma (kit slot 2), period (screenshot)
        // and R (AI override) are new defaults: a bind someone saved on one of
        // those keys keeps it, and the new action starts unbound until they
        // pick a key for it
        const NEW_DEFAULTS = ["KEY_DASH", "KEY_ABILITY", "KEY_KIT_2", "KEY_SCREENSHOT", "KEY_OVER_RIDE"];
        // Once: kit slot 2 sat on R for a day and got saved as unbound for
        // anyone with R taken. An unbound new action whose default key is
        // free now gets its default back.
        if (!localStorage.getItem("dwKeybindFix_v1")) {
            for (const id of NEW_DEFAULTS) {
                const b = keybinds[id];
                if (!b || b[1] !== -1) continue;
                const code = global[id];
                if (!Object.keys(keybinds).some(k => k !== id && keybinds[k] && keybinds[k][1] === code)) delete keybinds[id];
            }
            setKeybinds();
            try { localStorage.setItem("dwKeybindFix_v1", "1"); } catch (e) { }
        }
        for (const id of NEW_DEFAULTS) {
            if (keybinds[id]) continue;
            const code = global[id];
            // backtick is the special key too; in a raid dash takes it first
            const shared = [];
            if (Object.keys(keybinds).some(k => k !== id && !shared.includes(k) && keybinds[k] && keybinds[k][1] === code)) {
                keybinds[id] = ["", -1];
                setKeybinds();
            }
        }
    }

    function setKeybinds() {
        localStorage.setItem("keybinds", JSON.stringify(keybinds));
    }

    function unselectElement() {
        if (window.getSelection) {
            window.getSelection().removeAllRanges();
        }
        selectedElement.element.parentNode.parentNode.classList.remove("editing");
        selectedElement = null;
    }

    function selectElement(element) {
        selectedElement = element;
        selectedElement.element.parentNode.parentNode.classList.add("editing");
        if (selectedElement.keyCode !== -1 && window.getSelection) {
            let selection = window.getSelection();
            selection.removeAllRanges();
            let range = document.createRange();
            range.selectNodeContents(selectedElement.element);
            selection.addRange(range);
        }
    }

    function setKeybind(key, keyCode) {
        selectedElement.element.parentNode.parentNode.classList.remove("editing");
        resetButton.classList.add("active");
        if (keyCode !== selectedElement.keyCode) {
            let otherElement = controlsArray.find(c => c.keyCode === keyCode);
            if (keyCode !== -1 && otherElement) {
                otherElement.keyName = "";
                otherElement.element.innerText = "";
                otherElement.keyCode = -1;
                global[otherElement.keyId] = -1;
                keybinds[otherElement.keyId] = ["", -1];
            }
        }
        selectedElement.keyName = key;
        selectedElement.element.innerText = key;
        selectedElement.keyCode = keyCode;
        global[selectedElement.keyId] = keyCode;
        keybinds[selectedElement.keyId] = [key, keyCode];
        setKeybinds();
    }

    function getElements(kb, storeInDefault) {
        for (let row of controls.rows) {
            for (let cell of row.cells) {
                let element = cell.firstChild.firstChild;
                if (!element) continue;
                let key = element.dataset.key;
                if (storeInDefault) defaultKeybinds[key] = [element.innerText, global[key]];
                if (kb[key]) {
                    element.innerText = kb[key][0];
                    global[key] = kb[key][1];
                    resetButton.classList.add("active");
                }
                let obj = {
                    element,
                    keyId: key,
                    keyName: element.innerText,
                    keyCode: global[key]
                };
                controlsArray.push(obj);
            }
        }
    }

    // The menu is wired as soon as the page is parsed, not at window.onload:
    // that waits for every font and picture too, and Play stayed dead until
    // then (client/funnel.js holds an early press until this has run).
    const onMenuReady = async () => {

        global.serverMap = {};
        global.servers = [];

        global.loadServerSelector(false, "Connecting...");

        // Play stays grey until this list arrives, so keep trying: one failed
        // request on a phone connection used to leave it grey for good.
        let listTries = 0;
        const loadList = () => fetch("/getServers.json", { cache: "no-store" }).then(response => response.json()).then(json => {
            global.servers = json;
            global.loadServerSelector(json);
        }).catch(error => {
            console.error(error);
            setTimeout(loadList, Math.min(8000, 1000 * ++listTries));
        });
        loadList();

        util.retrieveFromLocalStorage("playerNameInput");
        util.retrieveFromLocalStorage("playerKeyInput");
        util.retrieveFromLocalStorage("optSharpEdges");
        util.retrieveFromLocalStorage("optSlowerFOV");
        util.retrieveFromLocalStorage("optPredictive");
        util.retrieveFromLocalStorage("optFancy");
        util.retrieveFromLocalStorage("optLowResolution");
        util.retrieveFromLocalStorage("smoothCamera");
        util.retrieveFromLocalStorage("optColors");
        util.retrieveFromLocalStorage("optPointy");
        util.retrieveFromLocalStorage("optCurvyTraps");
        util.retrieveFromLocalStorage("optNoGrid");
        util.retrieveFromLocalStorage("optInterpolation");
        util.retrieveFromLocalStorage("optLerpAnim");
        util.retrieveFromLocalStorage("optOptimizeMode");
        util.retrieveFromLocalStorage("optCenterMinimap");
        util.retrieveFromLocalStorage("optBorders");

        for (const id of ["optSatchelWarning", "optLeaderIndicators", "optWarBar", "optChatMessages", "optHitFeedback"]) {
            if (localStorage.getItem(id + "Checked") !== null) util.retrieveFromLocalStorage(id);
        }
        util.retrieveFromLocalStorage("optRenderKillbar");
        util.retrieveFromLocalStorage("separatedHealthbars");
        util.retrieveFromLocalStorage("autoLevelUp");
        localStorage.removeItem("optMobileValue"); 

        util.retrieveFromLocalStorage("optRenderGui");
        // A hidden GUI is a screenshot-only state: never carry it across sessions.
        if (!document.getElementById("optRenderGui").checked) {
            document.getElementById("optRenderGui").checked = true;
            util.submitToLocalStorage("optRenderGui");
        }
        util.retrieveFromLocalStorage("optRenderLeaderboard");
        util.retrieveFromLocalStorage("optRenderUpgrades");
        util.retrieveFromLocalStorage("optRenderMinimap");
        util.retrieveFromLocalStorage("optRenderNames");
        util.retrieveFromLocalStorage("optRenderHealth");
        util.retrieveFromLocalStorage("optRenderScores");
        util.retrieveFromLocalStorage("optRenderPlayerBars");
        util.retrieveFromLocalStorage("optReducedInfo");
        util.retrieveFromLocalStorage("optShowFps");
        util.retrieveFromLocalStorage("showCrosshair");
        util.retrieveFromLocalStorage("showJoystick");
        util.retrieveFromLocalStorage("optFullHD");
        for (const id of PERF_TOGGLES) util.retrieveFromLocalStorage(id);
        {
            // Effects intensity: Normal until somebody picks another
            const fl = document.getElementById("optFxLevel");
            if (fl) { util.retrieveFromLocalStorage("optFxLevel"); if (!fl.value) fl.value = "normal"; }
        }
        util.retrieveFromLocalStorage("optUiScale");
        // phones and tablets start on the lighter preset once (they can turn it off)
        if (global.mobile && !localStorage.getItem("dwTouchPerfDefaults")) {
            const fx = document.getElementById("optFewerFx");
            if (fx) { fx.checked = true; util.submitToLocalStorage("optFewerFx"); }
            localStorage.setItem("dwTouchPerfDefaults", "1");
        }

        util.retrieveFromLocalStorage("optIncognitoMode");

        if (document.getElementById("optColors").value === "") {
            document.getElementById("optColors").value = "dark";
        }
        if (document.getElementById("optBorders").value === "") {
            document.getElementById("optBorders").value = "normal";
        }

        if (document.getElementById("optMobile").value === "") {
            document.getElementById("optMobile").value = "mobile";
        }

        if (!localStorage.getItem("loadedForFirstTime")) {
            document.getElementById("optRenderGui").checked = true;
            document.getElementById("optRenderLeaderboard").checked = true;
            document.getElementById("optRenderUpgrades").checked = true;
            document.getElementById("optRenderMinimap").checked = true;
            document.getElementById("optRenderNames").checked = true;
            document.getElementById("optRenderHealth").checked = true;
            document.getElementById("optRenderScores").checked = true;
            document.getElementById("optRenderPlayerBars").checked = true;
            document.getElementById("optFancy").checked = true;
            document.getElementById("optInterpolation").checked = true;
            document.getElementById("optFancy").checked = true;
            document.getElementById("autoLevelUp").checked = true;
            if (global.mobile) document.getElementById("showCrosshair").checked = true, document.getElementById("showJoystick").checked = true;

            util.submitToLocalStorage("optRenderGui");
            util.submitToLocalStorage("optRenderLeaderboard");
            util.submitToLocalStorage("optRenderUpgrades");
            util.submitToLocalStorage("optRenderMinimap");
            util.submitToLocalStorage("optRenderNames");
            util.submitToLocalStorage("optRenderHealth");
            util.submitToLocalStorage("optRenderScores");
            util.submitToLocalStorage("optRenderPlayerBars");
            util.submitToLocalStorage("showCrosshair");
            util.submitToLocalStorage("showJoystick");
            util.submitToLocalStorage("optInterpolation");
            util.submitToLocalStorage("optFancy");
            util.submitToLocalStorage("autoLevelUp");
            localStorage.setItem("loadedForFirstTime", "true");
            localStorage.setItem("uiScaleSettings", null);
        }
        if (!localStorage.getItem("uiScaleSettings") || document.getElementById("optUiScale").value === "") {
            document.getElementById("optUiScale").value = global.mobile ? "mobile" : "normal";
            util.submitToLocalStorage("optUiScale");
            localStorage.setItem("uiScaleSettings", "true");
        }
        // One-time migration: desktop players auto-set to Small go back to
        // Normal once; anyone who picks Small afterwards keeps it.
        if (!localStorage.getItem("uiScaleNormalDefault")) {
            if (!global.mobile && document.getElementById("optUiScale").value === "small") {
                document.getElementById("optUiScale").value = "normal";
                util.submitToLocalStorage("optUiScale");
            }
            localStorage.setItem("uiScaleNormalDefault", "1");
        }
        loadSettings();

        document.getElementById("optColors").addEventListener("change", () => loadSettings());

        if (localStorage.getItem("keybindsSanitized") !== "1") {
            localStorage.removeItem("keybinds");
            localStorage.setItem("keybindsSanitized", "1");
        }
        getKeybinds();
        getElements(keybinds, true);

        const settingsPanelOpen = () => {
            const p = document.getElementById("homeSettingsPanel");
            return !!(p && p.classList.contains("open"));
        };
        document.addEventListener("click", event => {
            if (!global.gameStart || settingsPanelOpen()) {
                let element = controlsArray.find(({ element }) => element === event.target);
                if (selectedElement) {
                    const prev = selectedElement;
                    unselectElement();

                    if (element && element !== prev) selectElement(element);
                } else if (element) selectElement(element);
            }
        });
        resetButton.addEventListener("click", () => {
            keybinds = {};
            setKeybinds();
            controlsArray = [];
            getElements(defaultKeybinds);
            resetButton.classList.add("spin");
            setTimeout(() => {
                resetButton.classList.remove("active");
                resetButton.classList.remove("spin");
            }, 400);
        });

        global.createTabMenu = (text, type, addDismissButton = false) => {
            let allowedType = [
                "warning",
                "critical",
                "discord",
                "stat",
                "achieve",
            ];
            if (allowedType.includes(type)) {
                let b = document.getElementById("menuTabs");
                b.style.textAlign = "center";
                let d = document.createElement("span");
                d.classList.add("menuTab");
                d.classList.add(type);
                d.appendChild(document.createTextNode(`${text}${addDismissButton ? "\xa0\xa0\xa0" : ""}`));
                if (addDismissButton) {
                    text = document.createElement("text");
                    text.style.textDecoration = "underline";
                    text.href = "javascript:;";
                    text.appendChild(document.createTextNode("Dismiss"));
                    text.addEventListener("click", () => d.remove());
                    d.appendChild(text);
                }
                b.appendChild(d);
                return d;
            } else throw new Error("Invalid menu tab type.");
        };
        try {
            fetch("/version").then(json => json.json()).then(ve => {
                global.version = ve.ver;
                if (ve.devBuild) {
                    global.devBuild = true;
                    global.createTabMenu(`This is a dev build of Corez.io (${global.version})`, "warning");
                }

                let keyValue = localStorage.getItem('playerKeyInputValue');
                (async function() {
                    let A_response = await fetch(`/api/getAddonAuthors?token=${keyValue}`);
                    let A_data = await A_response.json().catch(() => false);
                    if (A_data && Array.isArray(A_data)) initalizeAddonAuthors(A_data);
                })();
            });
        } catch { };

        // phones: the menu's own note (#mobileNote) suggests holding it sideways

        document.getElementById("startButton").onclick = () => startGame();
        document.onkeydown = (e) => {
            if (!((global.gameStart && !settingsPanelOpen()) || e.shiftKey || e.ctrlKey || e.altKey)) {
                let key = e.which || e.keyCode;
                if (selectedElement) {
                    if ("Escape" === e.key) {
                        unselectElement();
                    } else if (1 !== e.key.length || 3 === e.location) {
                        if (!("Backspace" !== e.key && "Delete" !== e.key)) {
                            setKeybind("", -1);
                            unselectElement();
                        }
                    } else {
                        setKeybind(e.key.toUpperCase(), e.keyCode);

                        unselectElement();
                    }
                } else if (key === global.KEY_ENTER && !global.gameStart && !(window.dwAccount && window.dwAccount.blocksEnter())
                    // Enter on a focused button presses that button (Tutorial, a region...)
                    && !(e.target && e.target.closest && e.target.closest("button, a, select, textarea"))) {
                    startGame();
                }
            }
        };
        window.addEventListener("resize", resizeEvent);

        resizeEvent();
    };
    // DOMContentLoaded comes after every module script in the page has run
    // (serverSelectorHandler.js, which this uses, is one of the later ones)
    if (document.readyState === "complete") setTimeout(onMenuReady, 0);
    else document.addEventListener("DOMContentLoaded", onMenuReady, { once: true });

    function toggleOptionsMenu() {
        let clicked = false,
            a = document.getElementById("startMenuSlidingTrigger"),
            c = document.getElementById("optionArrow"),
            h = document.getElementById("viewOptionText"),
            u = document.getElementsByClassName("sliderHolder")[0],
            y = document.getElementsByClassName("slider"),
            toggle = () => {
                c.style.transform = c.style.webkitTransform = clicked
                    ? "translate(2px, -2px) rotate(45deg)"
                    : "rotate(-45deg)";
                h.innerText = clicked ? "close options" : "view options";
                clicked ? u.classList.add("slided") : u.classList.remove("slided");
                y[0].style.opacity = clicked ? 0 : 1;
                y[2].style.opacity = clicked ? 1 : 0;
            };
        a.onclick = () => {
            clicked = !clicked;
            toggle();
        };
        return () => {
            clicked || ((clicked = !0), toggle());
        };
    };

    function tabOptionsMenuSwitcher() {
        let buttonTabs = document.getElementById("optionMenuTabs"),
            tabOptions = [
                document.getElementById("tabAppearance"),
                document.getElementById("tabOptions"),
                document.getElementById("tabControls"),
                document.getElementById("tabLinks"),
                document.getElementById("tabAddons"),
            ];
        for (let g = 1; g < tabOptions.length; g++) tabOptions[g].style.display = "none";
        let e = 0;
        for (let g = 0; g < buttonTabs.children.length; g++)
            buttonTabs.children[g].addEventListener("click", () => {
                e !== g &&
                    (buttonTabs.children[e].classList.remove("active"),
                        buttonTabs.children[g].classList.add("active"),
                        (tabOptions[e].style.display = "none"),
                        (tabOptions[g].style.display = "block"),
                        (e = g))
            });
    }
    function initalizeAddonAuthors(data) {
        let mainDoc = document.getElementById("tabAddons");
        mainDoc.innerHTML = "";
        for (let doc of document.getElementById("optionMenuTabs").children) {
            if (doc.textContent.toLowerCase() === "addons") doc.style.display = "";
        }

        let i_div = document.createElement("div");
        i_div.classList.add("optionsHeader");
        i_div.textContent = `Corez.io ${global.version}` + `${global.devBuild ? "-dev" : ""}`;
        mainDoc.appendChild(i_div);

        for (let e of data) {
            let warnDoc = null;
            if (e["osa-version"].target !== global.version) {
                warnDoc = document.createElement("ul3");
                warnDoc.textContent = "This addon may be incompatible with your version";
            }
            let divDoc = document.createElement("div");
            divDoc.classList.add("optionsHeader");
            let name = document.createElement("ul");
            let addonVer = document.createElement("ul");
            let versionValue = document.createElement("ul2");
            let author = document.createElement("ul");
            let authorValue = document.createElement("ul2");
            let targetVer = document.createElement("ul");
            let targetVerValue = document.createElement("ul2");

            name.textContent = e.name;
            addonVer.textContent = 'Version: ';
            versionValue.textContent = `${e["addon-version"]}`;
            addonVer.appendChild(versionValue);
            author.textContent = "Author(s): ";
            authorValue.textContent = "";
            for (let i = 0; i < e.authors.length; i++) {
                let auth = e.authors[i];
                authorValue.textContent += `${i !== 0 ? ", " : ""}${auth}`;
            }
            author.appendChild(authorValue);
            targetVer.textContent = `Made for OSA version ${e["osa-version"].target}`;

            divDoc.appendChild(name);
            divDoc.appendChild(author);
            divDoc.appendChild(addonVer);
            if (warnDoc) divDoc.appendChild(warnDoc);
            divDoc.appendChild(targetVer);

            mainDoc.appendChild(divDoc);
        }
    }

    function customThemeDisplayHandler() {

        util.retrieveFromLocalStorage("optCustom");
        let themeValue = document.getElementById("optCustom");
        let customPlate;
        for (let e of document.getElementById("optColors").children) {
            if (e.value === "custom") customPlate = e;
        }
        let {name, author} = getThemeDisplayName(themeValue);
        if (name !== null && author !== null) customPlate.textContent = `Custom: ${name} ${author}`;
        themeValue.addEventListener("input", () => {
            let {name, author} = getThemeDisplayName(themeValue);
            if (name !== null && author !== null) customPlate.textContent = `Custom: ${name} ${author}`; else customPlate.textContent = "Custom (no name or author)";
        });
    }

    function snowAndFireworkEffects() {
        let currentDate = new Date(),
        snowAmount = global.mobile
        ? 0
        : Math.max(
            0,
            1 -
                Math.abs(
                currentDate.getTime() -
                    new Date(currentDate.getFullYear() - (6 > currentDate.getMonth() ? 1 : 0), 11, 25)
                ) / 20736e5
            );
        if (snowAmount) {
            let snowCanvas = document.createElement("canvas");
            snowCanvas.style.position = "absolute";
            snowCanvas.style.top = "0";
            document.body.insertBefore(snowCanvas, document.body.firstChild);
            let b = snowCanvas.getContext("2d"),
            snows = [],
            updateSnow = () => {
                snowCanvas.width !== window.innerWidth && (snowCanvas.width = window.innerWidth);
                snowCanvas.height !== window.innerHeight && (snowCanvas.height = window.innerHeight);
                b.clearRect(0, 0, snowCanvas.width, snowCanvas.height);
                b.fillStyle = "#ffffff";
                for (let snow of snows) {
                snow.x += 5 / snow.speed + Math.random();
                snow.y += 12.5 / snow.speed + Math.random();
                let fade = 2 * Math.min(0.4, 1 - snow.y / snowCanvas.height);
                0 < fade
                    ? ((b.globalAlpha = fade),
                    b.beginPath(),
                    b.arc(snow.x, snow.y, snow.speed, 0, 2 * Math.PI),
                    b.fill())
                    : (snow.vanished = !0);
                }
                0.001 * snowCanvas.width * snowAmount > Math.random() &&
                snows.push({
                    x: snowCanvas.width * (1.5 * Math.random() - 0.5),
                    y: -50 - 100 * Math.random(),
                    speed: 2 + Math.random() * Math.random() * 7,
                });
                if (global.gameStart) snowCanvas.remove();
                else requestAnimationFrame(updateSnow);
            };
            setInterval(() => {
                snows = snows.filter((g) => !g.vanished);
            }, 2e3);
            updateSnow();
        }

            let Gd = "en-US" === navigator.language && -7 <= global.timezoneLocation && -4 >= global.timezoneLocation,
            Hd = 6 === currentDate.getMonth() && 4 === currentDate.getDate(),
            Id =
            (11 === currentDate.getMonth() && 31 === currentDate.getDate()) ||
            (0 === currentDate.getMonth() && 3 >= currentDate.getDate());

        // the menu shows a raid behind it now (homeWorld.js), no fireworks over that
        if (!global.mobile && !window.dwHomeWorld) {
            let fireworkCanvas = document.createElement("canvas");
            fireworkCanvas.id = "homeFireworkCanvas";
            fireworkCanvas.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:0;";
            document.body.insertBefore(fireworkCanvas, document.body.firstChild);
            let b = fireworkCanvas.getContext("2d"),
            fireworks = [],
            fwDpr = 1,
            fwW = 0,
            fwH = 0;

            function fxPalette() {
                const s = getComputedStyle(document.documentElement);
                const keys = ["a", "b", "c", "d", "e"];
                const out = [];
                for (let i = 0; i < keys.length; i++) {
                    const k = keys[i];
                    out.push({
                        fill: (s.getPropertyValue("--tank-" + k) || "#4ec4e8").trim(),
                        stroke: (s.getPropertyValue("--tank-" + k + "-line") || "#142838").trim(),
                    });
                }
                return out;
            }

            function pickFx() {
                const pal = fxPalette();
                return pal[(Math.random() * pal.length) | 0];
            }

            function drawCartoonShard(p, alpha) {
                b.save();
                b.translate(p.x, p.y);
                b.rotate(p.ang);
                b.globalAlpha = alpha;
                b.lineJoin = "round";
                b.lineCap = "round";
                b.lineWidth = Math.max(2.4, p.r * 0.32);
                b.fillStyle = p.fill;
                b.strokeStyle = p.stroke;
                b.beginPath();
                if (p.sides < 2) {
                    b.arc(0, 0, p.r, 0, Math.PI * 2);
                } else {
                    const rot = p.sides % 2 ? 0 : Math.PI / p.sides;
                    for (let i = 0; i < p.sides; i++) {
                        const a = rot - Math.PI / 2 + (Math.PI * 2 * i) / p.sides;
                        const x = Math.cos(a) * p.r;
                        const y = Math.sin(a) * p.r;
                        if (i) b.lineTo(x, y);
                        else b.moveTo(x, y);
                    }
                    b.closePath();
                }
                b.fill();
                b.stroke();
                b.restore();
            }

            // October: the bursts throw candy corn (client/halloween.js)
            const halloween = () => document.documentElement.classList.contains("dw-halloween") && window.dwHalloweenFx;

            function spawnBurst(x, y) {
                const hw = halloween();
                if (hw) return hw.burst(x, y);
                const n = 10 + ((Math.random() * 8) | 0);
                const pal = pickFx();
                const pal2 = pickFx();
                for (let i = 0; i < n; i++) {
                    const ang = ((i + Math.random()) / n) * Math.PI * 2;
                    const spd = 2.2 + Math.random() * 3.4;
                    const col = i % 2 ? pal2 : pal;
                    fireworks.push({
                        x, y,
                        M: Math.cos(ang) * spd,
                        H: Math.sin(ang) * spd - 0.6,
                        r: 5 + Math.random() * 7,
                        sides: [0, 3, 4, 5, 6][(Math.random() * 5) | 0],
                        ang: Math.random() * Math.PI * 2,
                        spin: (Math.random() - 0.5) * 0.18,
                        fill: col.fill,
                        stroke: col.stroke,
                        time: 28 + Math.random() * 18,
                        life: 0,
                        Oa: false,
                    });
                }
            }

            let updateFireworks = () => {
                const nextDpr = Math.min(window.devicePixelRatio || 1, 2);
                if (fwW !== window.innerWidth || fwH !== window.innerHeight || fwDpr !== nextDpr) {
                    fwW = window.innerWidth;
                    fwH = window.innerHeight;
                    fwDpr = nextDpr;
                    fireworkCanvas.width = Math.max(1, Math.floor(fwW * fwDpr));
                    fireworkCanvas.height = Math.max(1, Math.floor(fwH * fwDpr));
                    b.setTransform(fwDpr, 0, 0, fwDpr, 0, 0);
                }
                b.clearRect(0, 0, fwW, fwH);
                for (const firework of fireworks) {
                    firework.H += 0.12;
                    firework.x += firework.M;
                    firework.y += firework.H;
                    firework.M *= 0.98;
                    firework.H *= 0.98;
                    firework.ang += firework.spin || 0;
                    firework.time--;
                    firework.life = (firework.life || 0) + 1;
                    const fade = Math.max(0, Math.min(1, firework.time / 14));
                    if (fade > 0) {
                        if (firework.Oa) {
                            drawCartoonShard({
                                x: firework.x,
                                y: firework.y,
                                r: 4.5,
                                sides: 0,
                                ang: 0,
                                fill: firework.fill,
                                stroke: firework.stroke,
                            }, 0.85);
                        } else {
                            const p = Object.assign({}, firework);
                            p.r = firework.r * (0.55 + 0.45 * fade);
                            drawCartoonShard(p, 0.55 + 0.35 * fade);
                        }
                    } else if (firework.Oa && !firework.vanished) {
                        spawnBurst(firework.x, firework.y);
                        firework.vanished = true;
                    } else {
                        firework.vanished = true;
                    }
                }
                const hw = halloween();
                if (hw) hw.corn(b, fwDpr);
                if (window.dwCalmZone) window.dwCalmZone.apply(b);
                if (3e-5 * fwW > Math.random()) {
                    const col = pickFx();
                    fireworks.push({
                        fill: col.fill,
                        stroke: col.stroke,
                        x: fwW * Math.random(),
                        y: fwH + 8,
                        M: 4 * Math.random() - 2,
                        H: 5 * Math.random() - 15,
                        r: 4.5,
                        sides: 0,
                        ang: 0,
                        spin: 0,
                        time: 32 + 12 * Math.random(),
                        Oa: true,
                        vanished: false,
                    });
                }
                if (global.gameStart) fireworkCanvas.remove();
                else requestAnimationFrame(updateFireworks);
            };
            setInterval(() => {
                fireworks = fireworks.filter((k) => !k.vanished);
            }, 2e3);
            updateFireworks();
        }
    }

    toggleOptionsMenu();
    tabOptionsMenuSwitcher();
    customThemeDisplayHandler();
    snowAndFireworkEffects();

    // ── automatic resolution ───────────────────────────────────────────────
    // Three stacked canvases at full pixel density. Without GPU canvas
    // acceleration (Chromebooks, blocklisted drivers) the cost is almost all
    // per pixel: ~45 ms a frame at 1080p, 250-500 ms at 4K. So the pixel
    // budget steps down while frames stay slow, tries a step up after a
    // smooth stretch, and remembers the level that works.
    // The floor is ~1100x820; below that HUD text turns to mush on a 1080p
    // screen. A remembered level is only trusted one step down; each session
    // re-learns the rest. "Full HD" in settings keeps it at 1080p or better.
    // Levels and timing live in autoQualityLogic.js (ResGovernor, tested):
    // small steps (75% of the pixels each) after a sustained dip only, never
    // on a tab refocus or one hitch, and back up one level at a time.
    const AUTO_RES_FLOOR = () => (global.GUIStatus && global.GUIStatus.fullHDMode) ? 1920 * 1080 : RES.FLOOR;
    let autoResNative = 0;   // the screen's own pixel count (resizeEvent)
    const autoResMax = () => resLevels(autoResNative, AUTO_RES_FLOOR());
    let autoResStart = 0;
    try { autoResStart = Math.max(0, Math.min(3, (parseInt(localStorage.getItem("dwAutoResStep"), 10) || 0) - 1)); } catch (e) { }
    const autoRes = new ResGovernor(autoResStart);
    let autoResLast = 0, autoResTold = false;
    autoQ.init({ toast: (text) => global.createMessage(text, 5000), resLevel: autoResStart });
    function setAutoResLevel(level) {
        const down = level > autoRes.level;
        if (!autoRes.set(performance.now(), Math.max(0, Math.min(autoResMax(), level)))) return;
        autoResChanged(down);
    }
    function autoResChanged(down) {
        try { localStorage.setItem("dwAutoResStep", String(autoRes.level)); } catch (e) { }
        autoQ.resolutionLow(autoRes.level > 0);
        resizeEvent();
        if (down && !autoResTold) {
            autoResTold = true;
            try { global.createMessage("The resolution was lowered so the game runs smoother.", 4000); } catch (e) { }
        }
    }
    function autoResTick(now) {
        const dt = autoResLast ? now - autoResLast : 16.7;
        autoResLast = now;
        // tab switches, hidden panes and the menu are not slow frames
        // the sky drop's dive (skyDrop.js) is a second of wide view, not a slow machine
        const diving = global.dropZoom !== undefined && global.dropZoom !== 1;
        if (document.hidden || !global.gameStart || diving || autoRes.hold || global.recording) { autoRes.pause(now); return; }
        // the effects ladder (autoQuality.js) goes first, resolution last
        const step = autoRes.frame(now, dt, (ema) => autoQ.resolutionTurn(ema), autoResMax());
        if (step) autoResChanged(step > 0);
    }
    // QA: dwAutoRes() reports, dwAutoRes(n) jumps to a level, dwAutoRes(n, true)
    // holds it there (A/B runs on a busy machine), dwAutoRes(null, false) lets go
    let recResLevel = 0;
    global.recordQuality = (on) => {
        if (on) {
            recResLevel = autoRes.level;
            global.recording = true;
            autoQ.recording(true);
            if (autoRes.level) setAutoResLevel(0);
        } else {
            global.recording = false;
            autoQ.recording(false);
            if (recResLevel > autoRes.level) setAutoResLevel(recResLevel);
            recResLevel = 0;
        }
    };
    window.dwAutoRes = (level, hold) => {
        if (hold != null) autoRes.hold = !!hold;
        if (level != null) setAutoResLevel(level | 0);
        return { level: autoRes.level, max: autoResMax(), fpsEma: +(1000 / autoRes.ema).toFixed(1), canvas: global.screenWidth + "x" + global.screenHeight, hud: ctx[2].canvas.width + "x" + ctx[2].canvas.height };
    };

    let resizedW = 0, resizedH = 0;
    const HUD_PIXEL_FLOOR = 1920 * 1200;
    let guiDensity = 1;
    window.dwHudDensity = () => guiDensity;
    function resizeEvent() {
        // touch: a keyboard opening for the chat box only shortens the
        // window; the game keeps its size so the HUD doesn't jump
        if (global.mobile && global.showChat && resizedW === window.innerWidth && window.innerHeight < resizedH) return;
        resizedW = window.innerWidth; resizedH = window.innerHeight;
        // never more than 2x density (a 3x phone panel is 9x the pixels)
        let scale = Math.min(2, window.devicePixelRatio || 1);
        if (config.graphical.lowResolution) {
            scale *= 0.5;
        }
        let pixels = window.innerWidth * window.innerHeight * scale * scale;
        // touch: about a 2x phone screen; a tablet's panel is 3-4x that
        const native = global.mobile ? Math.min(pixels, 1.6e6) : pixels;
        autoResNative = native;
        const budget = Math.min(native < pixels ? native : Infinity, resBudget(Math.min(autoRes.level, autoResMax()), native, AUTO_RES_FLOOR()));
        // The HUD keeps its own, higher budget: a big tank's wide view slows
        // the world down and steps the resolution down, and the HUD drawn at
        // that resolution (pixelated, see main.css) went soft as you grew.
        // HUD pixels are cheap (it is mostly empty). The first step, the one
        // a session remembers, leaves it at full density: a 1080p floor on a
        // retina screen drew it at 70% and stretched it, which is what made
        // the bars, tiles and text look low-res. Deeper steps are a slow
        // machine (often no GPU canvas), and those keep the 1080p+ floor.
        const guiBudget = global.mobile ? Math.max(budget, 1.6e6)
            : budget >= 1920 * 1080 ? Infinity : Math.max(budget, HUD_PIXEL_FLOOR);
        const guiScale = pixels > guiBudget ? scale * Math.sqrt(guiBudget / pixels) : scale;
        if (pixels > budget) scale *= Math.sqrt(budget / pixels);
        global.screenWidth = global.vscreenSize = window.innerWidth * scale;
        global.screenHeight = global.vscreenSizey = window.innerHeight * scale;
        const k = Math.max(1, guiScale / scale);
        // the canvases are drawn nearest-neighbour (main.css) for a crisp
        // 1:1 screen; a lowered resolution stretched that way is grain, so
        // a stretched layer is filtered smooth instead
        const nat = Math.min(2, window.devicePixelRatio || 1) * (config.graphical.lowResolution ? 0.5 : 1);
        const soft = scale < nat * 0.99 ? "auto" : "", softGui = scale * k < nat * 0.99 ? "auto" : "";
        if (global.canvas && global.canvas.cvb && global.canvas.cvb.style.imageRendering !== soft) {
            global.canvas.cvb.style.imageRendering = global.canvas.cvg.style.imageRendering = global.canvas.cv.style.imageRendering = soft;
        }
        if (global.canvas && global.canvas.cvu && global.canvas.cvu.style.imageRendering !== softGui) global.canvas.cvu.style.imageRendering = softGui;
        c.resize(global.screenWidth, global.screenHeight, Math.round(global.screenWidth * k), Math.round(global.screenHeight * k));
        // the HUD context draws in the same units as the world ones, k times denser
        if (ctx && ctx[2]) {
            guiDensity = ctx[2].canvas.width / global.screenWidth;
            ctx[2].setTransform(guiDensity, 0, 0, guiDensity, 0, 0);
        }
        global.ratio = scale;
        global.screenSize = Math.min(1920, Math.max(window.innerWidth, 1280));
    }

    window.resizeEvent = resizeEvent;
    global.canvas = new Canvas();
    var c = global.canvas.cv;
    var ctx = [
        document.getElementById("gameCanvas-background").getContext("2d"),
        document.getElementById("gameCanvas-gameplay").getContext("2d"),
        document.getElementById("gameCanvas-gui").getContext("2d"),
    ];
    window.dwCtx = ctx;
    // drawText, hudTitle and the upgrade tiles ask for the context's scale a
    // few hundred times a frame, and getTransform() makes a new DOMMatrix each
    // time (garbage, and GC hitches). The game contexts keep their own copy
    // of a, b, c, d in step with save / restore / scale / setTransform; a
    // rotate or a matrix argument just marks it stale. renderFrame resyncs.
    function trackTransform(c) {
        if (!c || c._tf) return;
        const P = Object.getPrototypeOf(c), tf = c._tf = { a: 1, b: 0, c: 0, d: 1, ok: false }, st = c._tfStack = [];
        const sync = () => { const m = P.getTransform.call(c); tf.a = m.a; tf.b = m.b; tf.c = m.c; tf.d = m.d; tf.ok = true; };
        c._tfSync = sync;
        c.save = function () { st.push(tf.ok ? tf.a : NaN, tf.b, tf.c, tf.d); return P.save.call(this); };
        c.restore = function () {
            if (st.length >= 4) { const d = st.pop(), cc = st.pop(), b = st.pop(), a = st.pop(); if (a === a) { tf.a = a; tf.b = b; tf.c = cc; tf.d = d; tf.ok = true; } else tf.ok = false; }
            else tf.ok = false;
            return P.restore.call(this);
        };
        c.scale = function (x, y) {
            if (tf.ok) { tf.a *= x; tf.b *= x; tf.c *= y; tf.d *= y; }
            return P.scale.call(this, x, y);
        };
        c.rotate = function (r) { tf.ok = false; return P.rotate.call(this, r); };
        c.transform = function (a, b, cc, d, e, f) { tf.ok = false; return P.transform.call(this, a, b, cc, d, e, f); };
        c.setTransform = function (a, b, cc, d, e, f) {
            if (typeof a === "number") { tf.a = a; tf.b = b; tf.c = cc; tf.d = d; tf.ok = true; return P.setTransform.call(this, a, b, cc, d, e, f); }
            tf.ok = false;
            return arguments.length ? P.setTransform.call(this, a) : P.setTransform.call(this);
        };
        c.resetTransform = function () { tf.a = 1; tf.b = 0; tf.c = 0; tf.d = 1; tf.ok = true; return P.resetTransform.call(this); };
    }
    for (const c of ctx) trackTransform(c);
    // a frame starts clean: anything outside the wrappers (a canvas resize
    // resets the state) is picked up here
    function resyncTransforms() { for (const c of ctx) { if (c._tf) { c._tfStack.length = 0; c._tf.ok = false; } } }
    // { a, b, c, d } of a context's transform; never keep the object
    function tfOf(c) {
        const tf = c._tf;
        if (!tf) return c.getTransform();
        if (!tf.ok) c._tfSync();
        return tf;
    }
    window.dwCtxCtor = (i) => ctx[i];
    // The tutorial's ore-tier card draws real gem entities with the game's own
    // renderer. Assigned once drawEntity exists (bottom of this module).
    var c2 = document.createElement("canvas");
    var ctx2 = c2.getContext("2d");
    ctx2.imageSmoothingEnabled = false;

    function Smoothbar(value, speed, sharpness = 3, lerpValue = 0.025, syncWithfps = false) {
        let time = Date.now();
        let display = value;
        let oldvalue = value;
        return {
            set: (val) => {
                if (value !== val) {
                    oldvalue = display;
                    value = val;
                    time = Date.now();
                }
            },
            get: (round = false) => {
                display = util.lerp(display, value, lerpValue, syncWithfps);
                if (Math.abs(value - display) < 0.1 && round) display = value;
                return display;
            },
            force: (val) => {
                display = value = val;
            },
        };
    };

    function AdvancedSmoothBar(a, b, d = 3) {
        let value = a;
        let speed = b;
        let h = d;
        let time = Date.now();
        let display;
        let S = display = a;
        let set = (a) => {
            value !== a &&
                ((S = get()), (value = a), (time = Date.now()));
        };
        let get = () => {
            let a = (Date.now() - time) / 1e3;
            return (display =
                a >= speed ? value : S + (value - S) * Math.pow(a / speed, 1 / h));
        };
        return {
            set: (a) => set(a),
            get: () => get(),
            force: (val) => {
                display = value = val;
            },
        }
    };

    global.player = global.initPlayer();
    function calculateTarget() {
        if (!global.canvas.mouseMoved) return;
        global.target.x = global.mouse.x - (global.player.screenx / global.screenWidth * global.canvas.width + global.canvas.width / 2);
        global.target.y = global.mouse.y - (global.player.screeny / global.screenHeight * global.canvas.height + global.canvas.height / 2);
        if (global.canvas.reverseDirection) global.reverseTank = -1;
        else global.reverseTank = 1;
        global.target.x *= global.screenWidth / global.canvas.width;
        global.target.y *= global.screenHeight / global.canvas.height;
        return global.target;
    };

    let CalcScreenSize = () => Math.max(global.vscreenSize, (16 / 9) * global.vscreenSizey / (global.mobile && global.vscreenSizey > global.vscreenSize ? 1.7 : 1)) / global.player.renderv,
        handleScreenDistance = (alpha, instance, fade = true) => {
            let indexes = instance.index,
            m = global.mockups[parseInt(indexes, 10)] ?? global.missingno[0];
            switch (fade) {
                case true:
                    GetScreenDistance(instance.render.x - global.player.loc.x, instance.render.y - global.player.loc.y, instance.size) ||
                    (alpha *= GetScreenDistanceF(instance.render.x - global.player.loc.x, instance.size));
                    (alpha *= GetScreenDistanceV(instance.render.y - global.player.loc.y, instance.size));
                    break;
                case false:
                    let size = instance.size;
                    size *= m.position.axis;
                    // Math.round == parseInt(size.toFixed(0)) for a size, minus a string per entity per frame
                    alpha *= GetScreenDistance(instance.render.x - global.player.loc.x, instance.render.y - global.player.loc.y, Math.round(size));
                    break;
            }
            return alpha;
        },
        GetScreenDistance = (a, b, d) => {
            d += 6;
            let e = 2 * CalcScreenSize();
            return (
                (a + d) * e > -global.vscreenSize &&
                (a - d) * e < global.vscreenSize &&
                (b + d) * e > -global.vscreenSizey &&
                (b - d) * e < global.vscreenSizey
            );
        },
        GetScreenDistanceF = (a, b) => {
            b += 6;
            let d = 2 * CalcScreenSize();
            return Math.max(
                0,
                Math.min(1, 2 + (-a + global.vscreenSize / d) / b, 2 + (a + global.vscreenSize / d) / b)
            );
        },
        GetScreenDistanceV = (a, b) => {
            b += 6;
            let d = 2 * CalcScreenSize();
            return Math.max(
                0,
                Math.min(1, 2 + (a + global.vscreenSizey / d) / b, 2 + (-a + global.vscreenSizey / d) / b)
            );
        };

    function parseTheme(string, logError = true) {

        try {
            var stripped = string.replace(/\s+/g, "");
            2 == stripped.length % 4 ? (stripped += "==") : 3 == stripped.length % 4 && (stripped += "=");
            let data = atob(stripped);
            let name = 'Unknown Theme',
                author = '';
            let index = data.indexOf('\x00');
            if (index === -1) return null;
            name = data.slice(0, index) || name;
            data = data.slice(index + 1);
            index = data.indexOf('\x00');
            if (index === -1) return null;
            author = data.slice(0, index) || author;
            data = data.slice(index + 1);
            let border = data.charCodeAt(0) / 0xff;
            data = data.slice(1);
            let paletteSize = Math.floor(data.length / 3);
            if (paletteSize < 2) return null;
            let colorArray = [];
            for (let i = 0; i < paletteSize; i++) {
                let red = data.charCodeAt(i * 3)
                let green = data.charCodeAt(i * 3 + 1)
                let blue = data.charCodeAt(i * 3 + 2)
                let color = (red << 16) | (green << 8) | blue
                colorArray.push('#' + color.toString(16).padStart(6, '0'))
            }
            let content = {
                teal: colorArray[0],
                lgreen: colorArray[1],
                orange: colorArray[2],
                yellow: colorArray[3],
                aqua: colorArray[4],
                pink: colorArray[5],
                vlgrey: colorArray[6],
                lgrey: colorArray[7],
                guiwhite: colorArray[8],
                black: colorArray[9],

                blue: colorArray[10],
                green: colorArray[11],
                red: colorArray[12],
                gold: colorArray[13],
                purple: colorArray[14],
                magenta: colorArray[15],
                grey: colorArray[16],
                dgrey: colorArray[17],
                white: colorArray[18],
                guiblack: colorArray[19],

                paletteSize,
                border,
            }
            return { name, author, content };
        } catch { }

        try {
            let output = JSON.parse(string);
            if (typeof output !== 'object')
                return null;
            let { name = 'Unknown Theme', author = '', content } = output;
            for (let colorHex of [
                content.teal,
                content.lgreen,
                content.orange,
                content.yellow,
                content.aqua,
                content.lavender,
                content.pink,
                content.vlgrey,
                content.lgrey,
                content.guiwhite,
                content.black,

                content.blue,
                content.green,
                content.red,
                content.gold,
                content.purple,
                content.magenta,
                content.grey,
                content.dgrey,
                content.white,
                content.guiblack,
            ]) {
                if (!/^#[0-9a-fA-F]{6}$/.test(colorHex)) {
                    if (!content.aqua) {
                        alert("Your theme is missing \"aqua\" (the hexagon colour), so it got a default.");
                        content.aqua = content.teal;
                    } else if (!content.lavender) {
                        alert("Your theme is missing \"lavender\" (the nest colour), so it got a default.");
                        content.lavender = "#b58efd";
                    } else {
                        if (logError) {
                            throw new Error("Unable to read the theme");
                        } else return {
                            name: 'Unknown Theme',
                            author: '?',
                            content: null,
                        }
                    }
                };
            }
            return {
                name: (typeof name === 'string' && name) || 'Unnamed Theme',
                author: (typeof author === 'string' && author) || '',
                content,
            }
        } catch (e) { logError && alert("Couldn't read your theme. It might be broken or too old."); }

        return {
            name: 'Unknown Theme',
            author: '?',
            content: null,
        };
    }
    function getThemeDisplayName(doc) {
        if (doc.value !== "") {
            let {name, author, content} = parseTheme(doc.value);
            if (content !== null) {
                let displayName = name;
                let displayAuthor = author === "" ? "" : author === "fan-made" || author === "Fan-made" || author === "Fan-Made" ? "(Fan-Made)" : `(by ${author})`;
                return {
                    name: displayName,
                    author: displayAuthor
                }
            }
        } else return {
            name: null,
            author: null,
        }
    }
    function initalizeChangelog(b, a) {
        let triggerChangelog = ( () => {
            let a = document.getElementById("changelogTabs")
            , b = a.firstElementChild
            , d = document.getElementById("patchNotes")
            , e = {};
            for (let g = 0; g < a.children.length; g++) {
                let k = a.children[g]
                , l = k.dataset.type;
                e[l] = () => {
                    if (k !== b) {
                        var u = b.dataset.type;
                        b.classList.remove("active");
                        k.classList.add("active");
                        d.classList.remove(u);
                        d.classList.add(l);
                        b = k
                    }
                }
                ;
                k.addEventListener("click", e[l])
            }
            return e
        }
        )()
        var sa = document.getElementById("patchNotes");
        var c = b.shift();
        if (c) {
            c = c.match(/^([A-Za-z ]+[A-Za-z])\s*\[([0-9\-]+)\]\s*(.+)?$/) || [c, c, null];
            var h = c[1] ? {
                    "Announcement": "announcement",
                    "Balance": "balance",
                    "Balance Update": "balance-update",
                    "Balance Update Details": "balance",
                    "Event": "event",
                    "Event Poll": "poll",
                    "Gamemode": "event",
                    "Gamemode Poll": "poll",
                    "Patch": "patch",
                    "Poll": "poll",
                    "Update": "update",
                } [c[1]] : null,
                d = document.createElement("div");
            h && d.classList.add(h);
            var y = document.createElement("b"),
                f = [c[1]];
            if (c[2]) {
                var e = new Date(c[2] + "T00:00:00Z");
                if (e > Date.now()) return;
                f.push(e.toLocaleDateString("default", {
                    year: "numeric",
                    month: "long",
                    day: "numeric",
                    timeZone: "UTC"
                }))
            }
            // the title first, then a small "Update · <date>" tag
            y.innerHTML = c[3] ? c[3] + " <small>" + f.join(" · ") + "</small>" : f.join(" · ");
            d.appendChild(y);
            let g = document.createElement("ul");
            let l;
            for (let n of b) l = document.createElement("li"), l.innerHTML = n, g.appendChild(l);
            l = g.getElementsByTagName("a");
            for (a = 0; a < l.length; a++) {
                let u = l[a];
                if (!u.href) continue;
                let p = u.href.lastIndexOf("#");
                -1 !== p && (p = u.href.slice(p + 1),
                "options-menu" === p ? h[a].addEventListener("click", r => {
                    r.preventDefault();
                    tc()
                }
                ) : triggerChangelog[p] && h[a].addEventListener("click", r => {
                    r.preventDefault();
                    triggerChangelog[p]()
                }
                ))
            }
            d.appendChild(g)
            a && d.appendChild(document.createElement("hr"));
            sa.appendChild(d)
        }
    }

    // Touch play on or off mid-session (canvas.js watches the input). The HUD
    // reads global.mobile every frame; the UI scale and canvas size follow.
    function setTouchMode(on) {
        on = !!on;
        if (on === !!global.mobile) return;
        global.mobile = on;
        document.body.classList.toggle("mobile", on);
        touch.setActive(on);
        const sock = global.socket;
        if (sock && sock.cmd) {
            // nothing either way may stay held down (sticks, aim fire, sidearm)
            for (const i of [0, 1, 2, 3, 4, 7]) sock.cmd.set(i, false);
            sock.cmd.reactNow();
        }
        global.touchMovePacked = 0;
        if (global.mobileStatus) global.mobileStatus.showCrosshair = false;
        if (on) { global.mouse.x = -9999; global.mouse.y = -9999; }
        else if (global.canvas) global.canvas.mouseMoved = false;
        try { loadSettings(); } catch (e) { resizeEvent(); }
    }
    global.setTouchMode = setTouchMode;

    function loadSettings() {
        config.graphical.fancyAnimations = document.getElementById("optFancy").checked;
        config.graphical.interpolation = document.getElementById("optInterpolation").checked;
        config.graphical.lerpAnimations = document.getElementById("optLerpAnim").checked;
        config.graphical.smoothcamera = document.getElementById("smoothCamera").checked;
        config.graphical.pointy = document.getElementById("optPointy").checked;
        config.graphical.curvyTraps = document.getElementById("optCurvyTraps").checked;
        config.game.autoLevelUp = document.getElementById("autoLevelUp").checked;
        config.game.centeredMinimap = document.getElementById("optCenterMinimap").checked;
        config.lag.unresponsive = document.getElementById("optPredictive").checked;
        config.graphical.sharpEdges = document.getElementById("optSharpEdges").checked;
        {
            const ng = document.getElementById("optNoGrid");
            config.graphical.showGrid = !(ng && ng.checked);
        }
        config.graphical.coloredHealthbars = true; 
        config.graphical.separatedHealthbars = document.getElementById("separatedHealthbars").checked;
        config.graphical.lowResolution = document.getElementById("optLowResolution").checked;
        global.userLowRes = config.graphical.lowResolution;
        if (global.userLowRes) global.autoLowRes = false;
        config.graphical.coloredNest = true;      
        config.graphical.slowerFOV = document.getElementById("optSlowerFOV").checked;
        config.graphical.optimizeMode = document.getElementById("optOptimizeMode").checked;
        {
            const on = (id) => { const el = document.getElementById(id); return !!(el && el.checked); };
            config.graphical.fewerEffects = on("optFewerFx");
            config.graphical.simpleTerrain = on("optSimpleTerrain");
            config.graphical.noShake = on("optNoShake");
            config.graphical.noGlow = on("optNoGlow");
            config.graphical.noGlitch = on("optNoGlitch");
            config.graphical.lightSafe = on("optLightSafe");
            const fl = document.getElementById("optFxLevel");
            config.graphical.fxLevel = fl && fl.value === "low" ? 0 : fl && fl.value === "max" ? 2 : 1;
            config.graphical.fpsCap30 = on("opt30Fps");
            config.graphical.showFps = on("optShowFps");
            // slow machines: automatic rungs on top of the player's choices
            autoQ.applyTo(config.graphical);
        }

        global.GUIStatus.renderGUI = document.getElementById("optRenderGui").checked;
        global.GUIStatus.renderLeaderboard = document.getElementById("optRenderLeaderboard").checked;
        global.GUIStatus.renderUpgrades = document.getElementById("optRenderUpgrades").checked;
        global.GUIStatus.renderMinimap = document.getElementById("optRenderMinimap").checked;
        global.GUIStatus.renderPlayerNames = document.getElementById("optRenderNames").checked;
        global.GUIStatus.renderPlayerScores = document.getElementById("optRenderScores").checked;
        global.GUIStatus.renderPlayerBars = document.getElementById("optRenderPlayerBars").checked;
        global.GUIStatus.renderPlayerKillbar = document.getElementById("optRenderKillbar").checked;
        global.GUIStatus.renderhealth = document.getElementById("optRenderHealth").checked;
        global.GUIStatus.minimapReducedInfo = document.getElementById("optReducedInfo").checked;
        global.GUIStatus.fullHDMode = document.getElementById("optFullHD").checked;
        try { if (typeof resizeEvent === "function" && global.canvas) resizeEvent(); } catch (e) { /* not ready yet */ }
        global.mobileStatus.enableCrosshair = document.getElementById("showCrosshair").checked;
        global.mobileStatus.showJoysticks = document.getElementById("showJoystick").checked;

        config.game.incognitoMode = document.getElementById("optIncognitoMode").checked;

        const dwOpt = (id) => { const el = document.getElementById(id); return el ? el.checked : true; };
        config.game.satchelWarning = dwOpt("optSatchelWarning");
        config.game.leaderIndicators = dwOpt("optLeaderIndicators");
        config.game.warBar = dwOpt("optWarBar");
        config.game.damageNumbers = dwOpt("optHitFeedback");
        config.game.hitFlash = dwOpt("optHitFeedback");
        global.GUIStatus.renderChat = dwOpt("optChatMessages");

        switch (document.getElementById("optBorders").value) {
            case "normal":
                config.graphical.darkBorders = config.graphical.neon = false;
                break;
            case "dark":
                config.graphical.darkBorders = true;
                config.graphical.neon = false;
                break;
            case "glass":
                config.graphical.darkBorders = false;
                config.graphical.neon = true;
                break;
            case "neon":
                config.graphical.darkBorders = config.graphical.neon = true;
                break;
        }

        global.autoScale = false; 
        switch (document.getElementById("optUiScale").value) {
            case "small":
                global.UIscale = 2560;
                break;
            case "normal":
                // Small's layout, about 12% bigger (1920 spreads the HUD out)
                global.UIscale = 2000;
                break;
            case "large":
                global.UIscale = 1536;
                break;
            case "mobile":
                global.UIscale = 1280;
                break;
        }
        // Phones and tablets measure the HUD along the long side (util.js
        // getScreenRatio), so the same numbers read a little bigger there.
        if (global.mobile) global.UIscale = { 2560: 1500, 2000: 1300, 1536: 960, 1280: 1100 }[global.UIscale] || 1100;
        util.submitToLocalStorage("optColors");
        let a = document.getElementById("optColors").value;
        color = colors[a === "" ? "dark" : a];
        if (a == "custom") {
            let customTheme = document.getElementById("optCustom").value;
            color = parseTheme(customTheme).content;
            util.submitToLocalStorage("optCustom");
        }
        gameDraw.color = color;
        gameDraw.colorCache = {};
        global.refreshMonitorColoring(gameDraw);
    }

    // Ranked: the death card's result, the dust HUD and the account snapshot
    // belong to one game. The rank-up ceremony waits for the RAID OVER title
    // to lift before it starts.
    rankCeremony.setGate(() => !raidFinale.holdsCeremony() && (!global.raidEndFx || performance.now() - global.raidEndFx.at > 2400));
    {
        const exit0 = global.exit;
        global.exit = function () {
            try { rankPanel.clear(); dustHud.reset(); global.acct = null; } catch (e) { /* */ }
            return exit0.apply(this, arguments);
        };
    }

    function startGame() {

        if (global.gameLoading) return;
        // a tab left open over a deploy checks the version first and reloads
        // instead of joining on old code (version.js beforePlay)
        if (!global._reconnecting && !startGame._checked && window.dwVersion && window.dwVersion.beforePlay) {
            if (startGame._asking) return;
            startGame._asking = true;
            window.dwVersion.beforePlay().then((reloading) => {
                startGame._asking = false;
                if (reloading) return;
                startGame._checked = true;
                try { startGame(); } finally { startGame._checked = false; }
            }, () => { startGame._asking = false; startGame._checked = true; try { startGame(); } finally { startGame._checked = false; } });
            return;
        }
        // Guests: a typed name that's too short or rude has to be fixed first;
        // an empty box gets a random name (no hoops for someone who just
        // wants to play). Accounts play under their username.
        if (!global._reconnecting && !(window.dwAccount && window.dwAccount.playName && window.dwAccount.playName())) {
            const nameInput = document.getElementById("playerNameInput");
            if (nameInput && !nameCheck.okToPlay(nameInput)) return;
        }
        global.gameLoading = true;
        try { rankPanel.clear(); dustHud.reset(); global.acct = null; } catch (e) { /* */ }
        try { if (window.dwSave) window.dwSave.reset(); } catch (e) { /* */ }
        // Fresh start: no raid state leaks in from a previous game.
        // (A kick or ban sets noAutoReconnect for that socket only; the
        // server repeats it if the new connection is refused too.)
        global.noAutoReconnect = false;
        global.raidQueued = false;
        global.duoFill = null;
        global.royaleSpectating = false;
        global.royaleDied = false;
        global.raidRespawnAt = 0;
        global.royaleBarHits = null;
        global.showBigMap = false;
        if (global.bigMap) global.bigMap.dragging = false;
        try {
            Object.assign(global.royale, {
                phase: 'idle', left: 0, alive: 0, toast: '', winner: null,
                storm: { a: 0, r: 0, max: 1, cx: 0, cy: 0 },
                feed: [], occupy: 0, lockout: 0, place: 0, board: [],
                at: -1e9, raidId: 0, raidLeft: 0, youScore: 0, youPB: 0,
                objectives: [], bloom: null, chest: null, results: null,
                lock: 0, lockLeft: 0, you: null, duos: 0, teams: null, duo: null,
                chests: [], boss: null, event: null, mod: null, pings: [], lastPlace: 0, bossSeenId: 0,
            });
            global.shop.onPad = false;
            global.shop.dismissed = false;
            global.shop.state = { drill: 0, gear: [], kit: {}, kitOrder: [], arm: null };
            global.callouts.length = 0;
            global.fx.length = 0;
            global.vault.onPad = false;
            global.vault.remaining = 0;
            global.vault.total = 0;
        } catch { /* */ }
        // Play must not inherit a leftover /tut path or tutorial overlay from
        // a previous click. Only launchTutorial() sets launchingTutorial.
        if (!global.launchingTutorial && !global.launchingDigWars) {
            global.tutorialMode = false;
            global.tutorialPlot = null;
            global.serverPath = "";
        }
        global._reconnecting = false;
        global.launchingTutorial = false;
        global.launchingDigWars = false;
        // phones: full screen (and landscape on Android) from the Play tap
        if (global.mobile) mobileFullscreen();

        util.submitToLocalStorage("optFancy");
        util.submitToLocalStorage("optLowResolution");
        util.submitToLocalStorage("smoothCamera");
        util.submitToLocalStorage("optBorders");
        util.submitToLocalStorage("optPointy");
        util.submitToLocalStorage("optCurvyTraps");
        util.submitToLocalStorage("optNoGrid");
        util.submitToLocalStorage("optInterpolation");
        util.submitToLocalStorage("optLerpAnim");
        util.submitToLocalStorage("optOptimizeMode");
        util.submitToLocalStorage("optCenterMinimap");
        util.submitToLocalStorage("autoLevelUp");
        util.submitToLocalStorage("optPredictive");
        util.submitToLocalStorage("optSharpEdges");
        util.submitToLocalStorage("optSlowerFOV");
        util.submitToLocalStorage("optRenderKillbar");
        util.submitToLocalStorage("separatedHealthbars");

        util.submitToLocalStorage("optRenderGui");
        util.submitToLocalStorage("optRenderLeaderboard");
        util.submitToLocalStorage("optRenderUpgrades");
        util.submitToLocalStorage("optRenderMinimap");
        util.submitToLocalStorage("optRenderNames");
        util.submitToLocalStorage("optRenderHealth");
        util.submitToLocalStorage("optRenderScores");
        util.submitToLocalStorage("optRenderPlayerBars");
        util.submitToLocalStorage("optReducedInfo");
        util.submitToLocalStorage("optShowFps");
        util.submitToLocalStorage("showCrosshair");
        util.submitToLocalStorage("showJoystick");
        util.submitToLocalStorage("optFullHD");
        for (const id of PERF_TOGGLES) util.submitToLocalStorage(id);
        util.submitToLocalStorage("optUiScale");

        util.submitToLocalStorage("optIncognitoMode");
        loadSettings();
        global.optionsCheckboxes = undefined;

        let playerNameInput = document.getElementById("playerNameInput");
        let playerKeyInput = document.getElementById("playerKeyInput");
        let autolevelUpInput = document.getElementById("autoLevelUp").checked;
        global.autolvlUp = autolevelUpInput;

        // Logged-in players play under their username (the server enforces it
        // too); the guest name in the input and localStorage is left alone.
        const accountName = window.dwAccount ? window.dwAccount.playName() : null;
        if (!accountName) util.submitToLocalStorage("playerNameInput");
        util.submitToLocalStorage("playerKeyInput");
        global.playerName = global.player.name = accountName || playerNameInput.value;
        global.playerKey = playerKeyInput.value.replace(/(<([^>]+)>)/gi, "").substring(0, 64);

        global.screenWidth = window.innerWidth;
        global.screenHeight = window.innerHeight;
        document.getElementById("startMenuWrapper").style.top = "-700px";
        setTimeout(() => {
            document.getElementById("startMenuWrapper").style.display = "none";
        }, 1e3);

        global.gameConnecting = true;

        global.socket = socketInit();

        global.canvas.socket = global.socket;
        global.socketMotionCycle = setInterval(() => moveCompensation.iterate(global.socket.cmd.getMotion()), 1e3 / 40);
        if (!global.playerTotalInterval) global.playerTotalInterval = setInterval(() => util.pullTotalPlayers(), 20000);
        if (!global.canvas.initalized) global.canvas.init();
        document.getElementById("gameAreaWrapper").style.display = "block";
        document.getElementById("gameCanvas").focus();
        window.onbeforeunload = () => (global.gameStart && !global.died && !global.disconnected ? !0 : null);

        !global.clientStarted && startClient();
    }
    global.startGame = () => startGame();
    function startClient() {
        animloop();
        global.clientStarted = true;
    }

    window.requestAnimFrame = window.requestAnimationFrame || window.webkitRequestAnimationFrame || window.mozRequestAnimationFrame || window.msRequestAnimationFrame || (callback => setTimeout(callback, 1000 / 60));
    window.cancelAnimFrame = window.cancelAnimationFrame || window.mozCancelAnimationFrame;

    const statMenu = Smoothbar(0, 2, 0.1, 0.08, 0.025, true);
    const upgradeMenu = Smoothbar(0, 2, 3, 0.08, 0.025, true);
    const lbGlide = AdvancedSmoothBar(0, 0.3, 1.5);

    function graph() {
        var data = [];
        return (point, x, y, w, h, col) => {

            data.push(point);
            while (data.length > w) {
                data.splice(0, 1);
            }

            let min = Math.min(...data),
                max = Math.max(...data),
                range = max - min;

            if (max > 0 && min < 0) {
                drawBar(x, x + w, y + (h * max) / range, 2, color.guiwhite);
            }

            ctx[2].beginPath();
            let i = -1;
            for (let p of data) {
                if (!++i) {
                    ctx[2].moveTo(x, y + (h * (max - p)) / range);
                } else {
                    ctx[2].lineTo(x + i, y + (h * (max - p)) / range);
                }
            }
            ctx[2].lineWidth = 1;
            ctx[2].strokeStyle = col;
            ctx[2].stroke();
        };
    }

    function interpolate(p1, p2, v1, v2, ts, tt) {
        let k = Math.cos((1 + tt) * Math.PI);
        return 0.5 * (((1 + tt) * v1 + p1) * (k + 1) + (-tt * v2 + p2) * (1 - k));
    }

    function extrapolate(p1, p2, v1, v2, ts, tt) {
        return p2 + (p2 - p1) * tt;
    }

    let modulo = function (a, n) {
        return ((a % n) + n) % n;
    };
    function angleDifference(sourceA, targetA) {
        let a = targetA - sourceA;
        return modulo(a + Math.PI, 2 * Math.PI) - Math.PI;
    }

    const compensation = () => {

        let t = 0,
            tt = 0,
            ts = 0;

        return {
            set: (
                time = global.player.time,
                interval = global.metrics.rendergap
            ) => {
                t = Math.max(getNow() - time - 80, -interval);
                if (t > 150 && t < 1000) {
                    t = 150;
                }
                if (t > 1000) {
                    t = (1000 * 1000 * Math.sin(t / 1000 - 1)) / t + 1000;
                }
                tt = t / interval;
                ts = 30 * config.roomSpeed * t / 1E3;
            },
            predict: (p1, p2, v1, v2) => {
                return t >= 0
                    ? extrapolate(p1, p2, v1, v2, ts, tt)
                    : interpolate(p1, p2, v1, v2, ts, tt);
            },
            predictFacing: (f1, f2) => {
                return f1 + (1 + tt) * angleDifference(f1, f2);
            },
            getPrediction: () => {
                return t;
            },
        };
    };

    const timingGraph = graph(),
        lagGraph = graph(),
        gapGraph = graph();

    let skas = [];
    for (let i = 1; i <= 256; i++) {
        skas.push((i - 2) * 0.01 + Math.log(4 * (i / 9) + 1) / 1.513);
    }
    const ska = (x) => skas[x];
    // Keycap for the n-th choice: the player's own binding (canvas.js
    // listens for KEY_CHOOSE_1..6), so a rebound key shows what to press.
    const CHOOSE_KEY_DEFAULTS = ["Y", "U", "I", "H", "J", "K"];
    var getClassUpgradeKey = function (number) {
        if (!(number >= 0 && number < CHOOSE_KEY_DEFAULTS.length)) return null;
        return keyLabel("KEY_CHOOSE_" + (number + 1), CHOOSE_KEY_DEFAULTS[number]);
    };


    function clearScreen(clearColor, alpha, context) {
        context.fillStyle = clearColor;
        context.globalAlpha = alpha;
        context.fillRect(0, 0, global.screenWidth, global.screenHeight);
        context.globalAlpha = 1;
    }

    // dev console handle (module-scoped state is otherwise unreachable)
    if (localHost) window.dwDebug = global;

    const fontWidth = "bold";
    // Widths by size|text. HUD labels and the shrink-to-fit loops ask for the
    // same strings every frame; each real measureText is a Blink object (GC
    // pressure) plus a split of the colour codes. The font is still set, as
    // callers may draw with it straight after.
    // (var + lazy init: measureText is hoisted, so no TDZ if it runs early)
    var measureCache;
    function measureText(text, fontSize, withHeight = false) {
        fontSize += config.graphical.fontSizeBoost;
        ctx[2].font = fontWidth + " " + fontSize + "px Ubuntu, sans-serif";
        if (!measureCache) {
            measureCache = new Map();
            try { document.fonts.addEventListener("loadingdone", () => measureCache.clear()); } catch (e) { }
        }
        const mk = fontSize + "|" + text;
        let width = measureCache.get(mk);
        if (width === undefined) {
            width = ctx[2].measureText(arrayifyText(text).reduce((a, b, i) => (i & 1) ? a : a + b, '')).width;
            // drop the oldest quarter, not everything: a full clear re-measures
            // every label on screen in one frame
            if (measureCache.size >= 1200) { let n = 300; for (const k of measureCache.keys()) { measureCache.delete(k); if (--n <= 0) break; } }
            measureCache.set(mk, width);
        }
        return withHeight ? { width, height: fontSize } : width;
    }

    function arrayifyText(rawText) {

        let textArrayRaw = rawText.split('§'),
            textArray = [];
        if (!(textArrayRaw.length & 1)) {
            textArrayRaw.unshift('');
        }
        while (textArrayRaw.length) {
            let first = textArrayRaw.shift();
            if (!textArrayRaw.length) {
                textArray.push(first);
            } else if (textArrayRaw[1] || textArrayRaw.length === 2) {
                textArray.push(first, textArrayRaw.shift());
            } else {
                textArrayRaw.shift();
                textArray.push(first + '§' + textArrayRaw.shift(), textArrayRaw.shift());
            }
        }
        return textArray;
    }

    // Widths of coloured runs in drawText's font, which is fixed apart from
    // the size. Run text like the kill feed repeats every frame.
    const runWidths = new Map();
    // a web font arriving changes every width
    try { document.fonts.addEventListener("loadingdone", () => { runWidths.clear(); tagIcons.clear(); }); } catch (e) { }
    function runWidth(context, size, text) {
        const k = size + "|" + text;
        let w = runWidths.get(k);
        if (w === undefined) {
            w = context.measureText(text).width;
            if (runWidths.size > 600) runWidths.clear();
            runWidths.set(k, w);
        }
        return w;
    }
    // nameHalo: null, or nameGlow (the armed style's glow, copied out of cosmetics.nameFx)
    let nameRim = null, nameHalo = null;
    const nameGlow = { halo: null, haloHi: null, haloA: 1 };
    // drawText is the busiest text path (names, labels, feed): a string that
    // has been asked for a few frames in a row gets drawn once into a sprite
    // by drawTextDirect itself and reused, so it looks exactly the same.
    // Name styles (rim, halo), gradients and rotated layers go direct.
    const textSprites = new Map(), textSeen = new Map();
    try { document.fonts.addEventListener("loadingdone", () => textSprites.clear()); } catch (e) { }
    // Changing strings (clocks, distances, counts) make a new sprite every
    // second or so. Sprites not drawn for a couple of seconds go back to a
    // pool of canvases by size bucket, and new ones take from it: no canvas
    // (and backing store) is made and dropped every frame.
    let textFrame = 0;
    const spritePool = new Map();
    const SPRITE_POOL_MAX = 64;
    let spritePooled = 0;
    const bucketOf = (pw, ph) => (Math.ceil(pw / 32) * 32) + "x" + (Math.ceil(ph / 8) * 8);
    function spriteCanvas(pw, ph) {
        const key = bucketOf(pw, ph), list = spritePool.get(key);
        if (list && list.length) { spritePooled--; return list.pop(); }
        // no exact bucket: the smallest pooled canvas that fits within twice
        // the area (users clear the whole canvas and blit only pw x ph), so
        // changing strings stop making a new canvas each
        if (spritePooled) {
            const need = Math.ceil(pw / 32) * 32 * Math.ceil(ph / 8) * 8;
            let best = null, bestA = need * 2 + 1;
            for (const l of spritePool.values()) {
                const c0 = l[l.length - 1];
                if (!c0 || c0.width < pw || c0.height < ph) continue;
                const a = c0.width * c0.height;
                if (a < bestA) { bestA = a; best = l; }
            }
            if (best) { spritePooled--; return best.pop(); }
        }
        const cv = document.createElement("canvas");
        cv.width = Math.ceil(pw / 32) * 32; cv.height = Math.ceil(ph / 8) * 8;
        cv._bucket = key;
        return cv;
    }
    function freeSprite(e) {
        const cv = e.cv;
        if (!cv || spritePooled >= SPRITE_POOL_MAX) return;
        let list = spritePool.get(cv._bucket);
        if (!list) spritePool.set(cv._bucket, list = []);
        list.push(cv); spritePooled++;
    }
    function sweepTextSprites() {
        textFrame++;
        if (textFrame % 60) return;
        for (const [k, e] of textSprites) if (textFrame - e.used > 150) { textSprites.delete(k); freeSprite(e); }
        for (const [k, e] of titleSprites) if (textFrame - (e.used || 0) > 150) { titleSprites.delete(k); freeSprite(e); }
        for (const [k, e] of scaledSprites) if (textFrame - e.used > 150) { scaledSprites.delete(k); freeSprite(e); }
    }
    // A sprite baked at the layer's own scale goes on 1:1 at whole device
    // pixels when it is within a couple of percent of the size asked for.
    // Stretching it that last bit, or drawing it at a fractional spot,
    // resamples every pixel, and that is what made HUD text and tiles look
    // soft. Far off (a zoom, a pop), it stretches as before.
    function blitSprite(c, t, cv, pw, ph, x, y, w, h) {
        const a = t.a, d = t.d, dw = w * a, dh = h * d;
        if (!crispOff && a > 0 && d > 0 && Math.abs(dw - pw) <= pw * 0.02 + 1 && Math.abs(dh - ph) <= ph * 0.02 + 1) {
            c.drawImage(cv, 0, 0, pw, ph, Math.round(x * a) / a, Math.round(y * d) / d, pw / a, ph / d);
        } else c.drawImage(cv, 0, 0, pw, ph, x, y, w, h);
    }
    // QA: window.dwCrispOff = true puts back the old stretched blits (A/B)
    let crispOff = false;
    Object.defineProperty(window, "dwCrispOff", { get: () => crispOff, set: (v) => { crispOff = !!v; textSprites.clear(); titleSprites.clear(); upgTileCache.clear(); kitIconSprites.clear(); }, configurable: true });
    // sprite keys: the layer scale to 1%, sizes to a quarter unit, so a
    // still label comes out the size it was asked for
    const spriteScale = (a) => crispOff ? Math.round(a * 20) / 20 : Math.round(a * 100) / 100;
    const spriteSize = (size) => crispOff ? Math.max(1, Math.round(size * 2) / 2) : Math.max(1, Math.round(size * 4) / 4);
    function drawText(rawText, x, y, size, defaultFillStyle, align = "left", center = false, fade = 1, stroke = true, context = ctx[2]) {
        // offscreen bakes (tiles, icons) are a cache already: text goes in as vector
        if (nameRim || nameHalo || typeof defaultFillStyle !== "string" || typeof rawText !== "string" || !rawText || (!context._tf && !crispOff)) {
            return drawTextDirect(rawText, x, y, size, defaultFillStyle, align, center, fade, stroke, context);
        }
        const t = tfOf(context);
        if (t.b || t.c) return drawTextDirect(rawText, x, y, size, defaultFillStyle, align, center, fade, stroke, context);
        const sc = spriteScale(t.a);
        const q = spriteSize(size);
        const key = rawText + "|" + q + "|" + defaultFillStyle + "|" + (center ? 1 : 0) + "|" + stroke + "|" + sc;
        let e = textSprites.get(key);
        if (!e) {
            const n = (textSeen.get(key) || 0) + 1;
            if (n < 4 || sc <= 0) {
                if (textSeen.size > 3000) textSeen.clear();
                textSeen.set(key, n);
                return drawTextDirect(rawText, x, y, size, defaultFillStyle, align, center, fade, stroke, context);
            }
            textSeen.delete(key);
            const fs = q + config.graphical.fontSizeBoost;
            const w = measureText(rawText, q);
            const pad = fs * 0.6 + 4, W = w + pad * 2, H = fs * 2.6 + 8;
            const pw = Math.max(1, Math.ceil(W * sc)), ph = Math.max(1, Math.ceil(H * sc));
            const cv = spriteCanvas(pw, ph);
            const g = cv.getContext("2d");
            g.setTransform(1, 0, 0, 1, 0, 0);
            g.clearRect(0, 0, cv.width, cv.height);
            g.scale(sc, sc);
            drawTextDirect(rawText, pad, H / 2, q, defaultFillStyle, "left", center, 1, stroke, g);
            e = { cv, w, W, H, X0: pad, Y0: H / 2, pw, ph, used: textFrame };
            if (textSprites.size > 700) { let k = 0; for (const [kk, old] of textSprites) { textSprites.delete(kk); freeSprite(old); if (++k >= 150) break; } }
            textSprites.set(key, e);
        }
        e.used = textFrame;
        const k = size / q;
        const mult = align === "center" ? 0.5 : align === "right" ? 1 : 0;
        const a0 = context.globalAlpha;
        if (fade < 1) context.globalAlpha = a0 * Math.max(0, fade);
        if (crispOff) {
            const dx = Math.round((x - e.w * k * mult - e.X0 * k) * sc) / sc;
            const dy = Math.round((y - e.Y0 * k) * sc) / sc;
            context.drawImage(e.cv, 0, 0, e.pw, e.ph, dx, dy, e.W * k, e.H * k);
        } else blitSprite(context, t, e.cv, e.pw, e.ph, x - e.w * k * mult - e.X0 * k, y - e.Y0 * k, e.pw / sc * k, e.ph / sc * k);
        context.globalAlpha = a0;
    }
    // Text that pops (damage numbers): one sprite per string and base size,
    // drawn at size = base * scale. drawText's own cache can't hold it, since
    // the size (and so its key) changes every frame of the pop, which left
    // every number on the slow strokeText path in a fight.
    const scaledSprites = new Map();
    try { document.fonts.addEventListener("loadingdone", () => scaledSprites.clear()); } catch (e) { }
    function drawTextScaled(rawText, x, y, base, scale, fill, center = true, stroke = true, context = ctx[2]) {
        const t = tfOf(context);
        if (t.b || t.c || !(scale > 0)) return drawTextDirect(rawText, x, y, base * scale, fill, "center", center, 1, stroke, context);
        // drawn at the largest it pops to, so it never blurs
        const sc = Math.round(t.a * 1.5 * 10) / 10;
        const q = Math.max(4, Math.round(base));
        const key = rawText + "|" + q + "|" + fill + "|" + stroke + "|" + sc;
        let e = scaledSprites.get(key);
        if (!e) {
            const fs = q + config.graphical.fontSizeBoost;
            const w = measureText(rawText, q);
            const pad = fs * 0.6 + 4, W = w + pad * 2, H = fs * 2.6 + 8;
            const pw = Math.max(1, Math.ceil(W * sc)), ph = Math.max(1, Math.ceil(H * sc));
            const cv = spriteCanvas(pw, ph);
            const g = cv.getContext("2d");
            g.setTransform(1, 0, 0, 1, 0, 0);
            g.clearRect(0, 0, cv.width, cv.height);
            g.scale(sc, sc);
            drawTextDirect(rawText, pad, H / 2, q, fill, "left", center, 1, stroke, g);
            e = { cv, w, W, H, X0: pad, Y0: H / 2, pw, ph, used: textFrame };
            if (scaledSprites.size > 300) { let n = 0; for (const [kk, old] of scaledSprites) { scaledSprites.delete(kk); freeSprite(old); if (++n >= 80) break; } }
            scaledSprites.set(key, e);
        }
        e.used = textFrame;
        const k = base * scale / q;
        context.drawImage(e.cv, 0, 0, e.pw, e.ph, x - e.w * k * 0.5 - e.X0 * k, y - e.Y0 * k, e.W * k, e.H * k);
    }
    function drawTextDirect(rawText, x, y, size, defaultFillStyle, align = "left", center = false, fade = 1, stroke = true, context = ctx[2]) {
        size += config.graphical.fontSizeBoost;

        let offset = size / 5,
            ratio = 1,
            textArray = arrayifyText(rawText),
            renderedFullText = textArray.reduce((a, b, i) => (i & 1) ? a : a + b, '');

        if (ratio !== 1) {
            size *= ratio;
        }
        context.font = "bold " + size + "px Ubuntu, sans-serif";

        let Xoffset = offset,
            Yoffset = (size + 2 * offset) / 2,
            alignMultiplier = 0;

        switch (align) {

            case "center":
                alignMultiplier = 0.5;
                break;
            case "right":
                alignMultiplier = 1;
        }
        // one colour run: let the canvas align it rather than measure it
        // (damage numbers change size every frame, so no cache would hit)
        const nativeAlign = alignMultiplier && textArray.length === 1;
        if (alignMultiplier && !nativeAlign) {
            Xoffset -= runWidth(context, size, renderedFullText) * alignMultiplier;
        }

        let strokeRatio = typeof stroke === "number" ? stroke : config.graphical.fontStrokeRatio;
        context.lineWidth = (size + 1) / strokeRatio;
        context.textAlign = "left";
        context.textBaseline = "middle";
        // a name style's outline / halo (styledName sets them for this one call)
        const rim = nameRim, halo = nameHalo;
        nameRim = nameHalo = null;
        context.strokeStyle = rim || color.black;
        context.fillStyle = defaultFillStyle;
        context.save();
        if (nativeAlign) context.textAlign = align;
        context.lineCap = "round";
        context.lineJoin = "round";
        if (fade < 1) context.globalAlpha *= Math.max(0, fade);
        if (ratio !== 1) {
            context.scale(1 / ratio, 1 / ratio);
        }

        Xoffset += x * ratio - size / 4;
        Yoffset += y * ratio - Yoffset * (center ? 1.05 : 1.5);
        if (stroke) {
            if (halo) {
                // the style's glow (cosmetics.strokeHalo): a bright core
                // hugging the outline, two soft steps out
                cosmetics.strokeHalo(context, renderedFullText, Xoffset, Yoffset, halo);
                context.strokeStyle = rim || color.black;
            }
            context.strokeText(renderedFullText, Xoffset, Yoffset);
        }
        for (let i = 0; i < textArray.length; i++) {
            let str = textArray[i];

            if (i & 1) {

                if (str === "reset") {
                    context.fillStyle = defaultFillStyle;
                } else {
                    str = gameDraw.getColor(str) ?? str;
                }
                context.fillStyle = str;

            } else {

                if (i) {
                    Xoffset += runWidth(context, size, textArray[i - 2] + str) - runWidth(context, size, str);
                }
                context.fillText(str, Xoffset, Yoffset);
            }
        }
        context.restore();
    }

    function scaleScreenRatio(by, unset) {
        global.screenWidth /= by;
        global.screenHeight /= by;
        ctx[0].scale(by, by);
        ctx[1].scale(by, by);
        ctx[2].scale(by, by);
        if (!unset) ratio *= by;
    };

    function drawGuiRect(x, y, length, height, stroke = false) {
        switch (stroke) {
            case true:
                ctx[2].strokeRect(x, y, length, height);
                break;
            case false:
                ctx[2].fillRect(x, y, length, height);
                break;
        }
    }

    function drawGuiCircle(x, y, radius, stroke = false) {
        ctx[2].beginPath();
        ctx[2].arc(x, y, radius, 0, Math.PI * 2);
        stroke ? ctx[2].stroke() : ctx[2].fill();
    }

    function drawGuiLine(x1, y1, x2, y2) {
        const c = ctx[2], t = tfOf(c), a = t.a, d = t.d;
        if (crispOff || t.b || t.c || !(a > 0) || !(d > 0)) {
            c.beginPath();
            c.lineTo(Math.round(x1) + 0.5, Math.round(y1) + 0.5);
            c.lineTo(Math.round(x2) + 0.5, Math.round(y2) + 0.5);
            c.closePath();
            c.stroke();
            return;
        }
        // On whole device pixels (rounding in UI units, then +0.5, only lines
        // up at 1x): a width in whole pixels, an odd one centred on a pixel
        // centre and an even one on a pixel edge, so both sides are hard.
        const lw0 = c.lineWidth, px = Math.max(1, Math.round(lw0 * Math.min(a, d))), off = (px & 1) * 0.5;
        const sx = (v) => x1 === x2 ? (Math.floor(v * a) + off) / a : Math.round(v * a) / a;
        const sy = (v) => y1 === y2 ? (Math.floor(v * d) + off) / d : Math.round(v * d) / d;
        c.lineWidth = px / Math.min(a, d);
        c.beginPath();
        c.moveTo(sx(x1), sy(y1));
        c.lineTo(sx(x2), sy(y2));
        c.stroke();
        c.lineWidth = lw0;
    }

    function drawBar(x1, x2, y, width, color, context = ctx[2]) {
        // On whole device pixels: the centre on a pixel edge and an even
        // width, so a stack of bars (outline, track, fill) shares hard top and
        // bottom edges. At a fractional spot each edge was a half-blended row.
        // (The ends are round caps and stay put: a stat bar at level 0 is a
        // near-zero line drawn as a dot, and an exactly zero one draws nothing.)
        const t = !crispOff && context._tf ? tfOf(context) : null;
        if (t && !t.b && !t.c && t.d > 0) {
            const d = t.d;
            width = Math.max(2, 2 * Math.round(width * d / 2)) / d;
            y = Math.round(y * d) / d;
        }
        context.beginPath();
        context.lineTo(x1, y);
        context.lineTo(x2, y);
        context.lineWidth = width;
        if (color) context.strokeStyle = color;
        context.closePath();
        context.stroke();
    }

    function drawBarStroke(x1, y, width, color, h2) {
        ctx[2].lineWidth = 2.5;
        ctx[2].strokeStyle = color;
        ctx[2].beginPath();
        ctx[2].moveTo(x1, y);
        ctx[2].lineTo(x1 + width, y);
        ctx[2].arc(x1 + width, y + h2 / 2, h2 / 2, -Math.PI / 2, Math.PI / 2);
        ctx[2].lineTo(x1, y + h2);
        ctx[2].arc(x1, y + h2 / 2, h2 / 2, Math.PI / 2, -Math.PI / 2);
        ctx[2].stroke();
    }

    function drawBarAdvanced(x1, x2, y, width, color, h2) {
        ctx[2].beginPath();
        ctx[2].roundRect(x1 - width / 2, y - width / 2, x2 - x1 + width, h2 + width, [width / 2]);
        ctx[2].fillStyle = color;
        ctx[2].fill();
    }

    function drawButton(x, y, width, height, alpha, type = "rect", text, textSize, color1, color2, color3, clickable = false, clickType, clickableRatio, index) {

        if (width == true) width = measureText(text, height);

        if (clickable) {
            switch (index) {
                case false:
                    global.clickables[clickType].set((x - width / 2) * clickableRatio, y * clickableRatio, width * clickableRatio, height * clickableRatio);
                    break;
                default:
                    global.clickables[clickType].place(index, (x - width / 2) * clickableRatio, y * clickableRatio, width * clickableRatio, height * clickableRatio);
                    break;
            }
        }
        let hover = false;
        if (clickable) hover = global.clickables[clickType].check({ x: global.mouse.x, y: global.mouse.y });

        ctx[2].globalAlpha = 0.5 * alpha;
        ctx[2].fillStyle = color1 ? color1 : color.grey;
        if (type == "rect") drawGuiRect(x - width / 2, y, width, height);
        else if (type == "bar") drawBar(x - width / 2, x + width / 2, y + height / 2, height, color1 ? color1 : color.grey);
        ctx[2].globalAlpha = 0.1 * alpha;

        if (clickable && (index !== false && hover == index) || hover === true) {
            if (global.clickables.clicked) {
                ctx[2].globalAlpha = 0.2 * alpha;
                ctx[2].fillStyle = color.black;
            } else {
                ctx[2].globalAlpha = 0.15 * alpha;
                ctx[2].fillStyle = color.guiwhite;
            }
            if (type == "rect") drawGuiRect(x - width / 2, y, width, height);
            else if (type == "bar") drawBar(x - width / 2, x + width / 2, y + height / 2, height, false)

        }
        ctx[2].fillStyle = color2 ? color2 : color.black;
        if (type == "rect") drawGuiRect(x - width / 2, y + height * 0.6, width, height * 0.4);
        else if (type == "bar") drawBar(x - width / 1.9, x + width / 1.9, y + height * 0.7, height * 0.6, color2 ? color2 : color.black);
        ctx[2].globalAlpha = 1 * alpha;
        ctx[2].fillStyle = color.guiwhite;
        ctx[2].strokeStyle = color.black;

        if (text) drawText(text, x, y + height * 0.5, textSize ? textSize : height * 0.6, color.guiwhite, "center", true);

        ctx[2].strokeStyle = color3 ? color3 : color.black;
        ctx[2].lineWidth = 3;
        if (type == "rect") drawGuiRect(x - width / 2, y, width, height, true);
        else if (type == "bar") drawBarStroke(x - width / 2, y, width, color3 ? color3 : color.black, height);
    }

    // Previews (upgrade tiles, /tanks atlas): the theme's grey barrels and turrets
    // drawn light with a dark edge, so they read on any tile colour
    let previewGrey = false;
    const PREVIEW_GREY = "#b4b3bd", PREVIEW_GREY_EDGE = "#55535f";
    window.dwPreviewGrey = (on) => { previewGrey = !!on; };
    // An entity's class mockup index, the number before the first "-" of its
    // index string, parsed once per index change instead of a split per call
    // (several times per entity per frame).
    function entMockupIndex(e) {
        const s = e.index;
        if (e._mxS !== s) { e._mxS = s; e._mxI = +String(s).split("-")[0]; }
        return e._mxI;
    }
    const drawEntity = (() => {
        let drawPolyImgs = [],
        drawPoly3D = new Map(),
        drawPoly4D = new Map(),
        cameraFor3dProjection = { x: 0, y: 0, z: -1 },
        cameraFor4dProjection = { x: 0, y: 0, z: 0, w: -1 },
        projectPoint3d = p => {
            if (p.z == 0) return p;
            p.x /= p.z - cameraFor3dProjection.z;
            p.y /= p.z - cameraFor3dProjection.z;
            p.z = 0;
            return p;
        },
        projectPoint4d = p => {
            if (p.w == 0) return projectPoint3d(p);
            p.x /= p.w - cameraFor4dProjection.w;
            p.y /= p.w - cameraFor4dProjection.w;
            p.z /= p.w - cameraFor4dProjection.w;
            p.w = 0;
            return projectPoint3d(p);
        },
        rotatePointXY = (p, angle) => {
            let q = {
                x: 0,
                y: 0,
                z: 0
            };
            const cos = Math.cos(angle);
            const sin = Math.sin(angle);
            q.x = p.x * cos + p.z * sin;
            q.z = -p.x * sin + p.z * cos;
            q.y = p.y * cos - q.z * sin;
            q.z = p.y * sin + q.z * cos;
            return q;
        },
        rotatePointXYZ = (p, angle) => {
            let q = {
                x: 0,
                y: 0,
                z: 0,
                w: 0
            };
            const cos = Math.cos(angle);
            const sin = Math.sin(angle);
            q.x = p.x * cos + p.z * sin;
            q.z = -p.x * sin + p.z * cos;
            q.y = p.y * cos - q.z * sin;
            q.z = p.y * sin + q.z * cos;
            let y = q.y;
            q.y = y * cos - p.w * sin;
            q.w = y * sin + p.w * cos;
            let z = q.z;
            q.z = z * cos - p.w * sin;
            q.w = z * sin + p.w * cos;
            return q;
        },
        distanceBetweenPointsSquared3d = (a, b) => {
            let dx = b.x - a.x,
                dy = b.y - a.y,
                dz = b.z - a.z;
            return dx * dx + dy * dy + dz * dz;
        },
        distanceBetweenPointsSquared4d = (a, b) => {
            let dx = b.x - a.x,
                dy = b.y - a.y,
                dz = b.z - a.z,
                dw = b.w - a.w;
            return dx * dx + dy * dy + dz * dz + dw * dw;
        },
        sortSides3d = (arr, a, b) => {
            let aAvgZ = 0,
                bAvgZ = 0,
                aDist = 0,
                bDist = 0;
            for (let i = 0; i < a.length; ++i) {
                aAvgZ += arr[a[i]].z;
                aDist += distanceBetweenPointsSquared3d(
                    cameraFor3dProjection,
                    arr[a[i]]
                );
            }
            for (let i = 0; i < b.length; ++i) {
                bAvgZ += arr[b[i]].z;
                bDist += distanceBetweenPointsSquared3d(
                    cameraFor3dProjection,
                    arr[b[i]]
                );
            }
            aAvgZ /= a.length;
            bAvgZ /= b.length;
            aDist /= a.length * a.length;
            bDist /= b.length * b.length;
            return (bAvgZ - aAvgZ) * 1e3 + (bDist - aDist);
        },
        sortSides4d = (arr, a, b) => {
            let aAvgW = 0,
                bAvgW = 0,
                aDist = 0,
                bDist = 0;
            for (let i = 0; i < a.length; ++i) {
                aAvgW += arr[a[i]].w;
                aDist += distanceBetweenPointsSquared4d(
                    cameraFor4dProjection,
                    arr[a[i]]
                );
            }
            for (let i = 0; i < b.length; ++i) {
                bAvgW += arr[b[i]].w;
                bDist += distanceBetweenPointsSquared4d(
                    cameraFor4dProjection,
                    arr[b[i]]
                );
            }
            aAvgW /= a.length;
            bAvgW /= b.length;
            aDist /= a.length * a.length;
            bDist /= b.length * b.length;
            return (
                ((bAvgW - aAvgW) * 1e3 + (bDist - aDist)) * 1e3 +
                sortSides3d(arr, a, b)
            );
        },
        DEAIC = (assignedContext, Alpha, shape, glow, gunLength, turretsLength) => {
            // Offscreen blit only for faded bodies, so guns+hull share one
            // alpha; routing opaque tanks through it resizes a canvas per
            // gun-tank per frame.
            if (global.gameUpdate && config.graphical.fancyAnimations && assignedContext != ctx2) {
                if (Alpha < 1) {
                    if (config.graphical.optimizeMode) {
                        if (gunLength > 0 || turretsLength > 0 || glow.radius) return true;
                        return false;
                    } else if (shape !== 0 || gunLength > 0 || turretsLength > 0 || glow.radius) {
                        return true;
                    }
                }
            }
            return false;
        },

        drawBody = (context, centerX, centerY, radius, sides, angle = 0, borderless, fill, imageInterpolation, hasGlow = false) => {
            try {

                context.beginPath();
                if (sides instanceof Array) {
                    let dx = Math.cos(angle);
                    let dy = Math.sin(angle);
                    for (let [x, y] of sides)
                        context.lineTo(
                            centerX + radius * (x * dx - y * dy),
                            centerY + radius * (y * dx + x * dy)
                        );
                } else {
                    if ("string" === typeof sides) {
                        if (sides.startsWith('image=')) {
                            let img = drawPolyImgs[sides];
                            if (!img) {
                            const defaultDirectory = sides.startsWith("image=/");
                            const clientRootDirectory = sides.startsWith("image=./");
                            const onlineDirectory = sides.startsWith("image=https");
                            img = drawPolyImgs[sides] = new Image();
                            img.src =
                            defaultDirectory ?
                            `img${sides.slice(6)}` :
                            clientRootDirectory || onlineDirectory ?
                            `${onlineDirectory ? sides.slice(6) : sides.slice(7)}` :
                            "img/missingno.png";
                            img.onerror = function() {
                                img.src = "img/missingno.png";
                            }
                            }
                            context.translate(centerX, centerY);
                            context.rotate(angle);
                            context.imageSmoothingEnabled = imageInterpolation;
                            const imageSize = radius / 1.09;
                            context.drawImage(img, -imageSize, -imageSize, imageSize * 2, imageSize * 2);
                            context.imageSmoothingEnabled = true;
                            context.rotate(-angle);
                            context.translate(-centerX, -centerY);
                            return;
                        }
                        if (sides.startsWith('3d=')) {
                            let polygon3d = drawPoly3D.get(sides);
                            if (!polygon3d) {
                                let dividedParts = sides.slice(3).split('/');
                                let vertexesRaw = dividedParts[0].split(',').map(Number);
                                if (vertexesRaw.length % 3 != 0) {
                                    throw new Error(
                                        '3D Shape cannot be rendered. Vertexes count: ' +
                                            vertexesRaw.length / 3
                                    );
                                }
                                let vertexes = Array(vertexesRaw.length / 3);
                                for (let i = 0; i < vertexesRaw.length; i += 3) {
                                    vertexes[i / 3] = {
                                        x: vertexesRaw[i],
                                        y: vertexesRaw[i + 1],
                                        z: vertexesRaw[i + 2]
                                    };
                                }
                                let indicesRaw = dividedParts[1].split(';');
                                let indices = [];
                                for (let i = 0; i < indicesRaw.length; ++i) {
                                    indices.push(indicesRaw[i].split(',').map(Number));
                                }
                                polygon3d = {
                                    vertexes,
                                    indices,
                                    multiplier: Number(dividedParts[2])
                                };
                                drawPoly3D.set(sides, polygon3d);
                            }
                            const rotated = polygon3d.vertexes
                                .slice()
                                .map(p => rotatePointXY(p, angle));
                            const sortedSides = polygon3d.indices
                                .slice()
                                .sort((a, b) => sortSides3d(rotated, a, b));
                            context.lineWidth /= 2;
                            const size = radius * polygon3d.multiplier;
                            for (const sides of sortedSides) {
                                context.beginPath();
                                for (let i = 0; i < sides.length; ++i) {
                                    const a = projectPoint3d(rotated[sides[i]]);
                                    const b = projectPoint3d(
                                        rotated[sides[(i + 1) % sides.length]]
                                    );
                                    context.lineTo(
                                        centerX + a.x * size,
                                        centerY + a.y * size,
                                        centerX + b.x * size,
                                        centerY + b.y * size
                                    );
                                }
                                context.closePath();
                                context.fill();
                                context.stroke();
                            }
                            return;
                        }
                        if (sides.startsWith('4d=')) {
                            let polygon4d = drawPoly4D.get(sides);
                            if (!polygon4d) {
                                let dividedParts = sides.slice(3).split('/');
                                let vertexesRaw = dividedParts[0].split(',').map(Number);
                                if (vertexesRaw.length % 4 != 0) {
                                    throw new Error(
                                        '4D Shape cannot be rendered. Vertexes count: ' +
                                            vertexesRaw.length / 4
                                    );
                                }
                                let vertexes = Array(vertexesRaw.length / 4);
                                for (let i = 0; i < vertexesRaw.length; i += 4) {
                                    vertexes[i / 4] = {
                                        x: vertexesRaw[i],
                                        y: vertexesRaw[i + 1],
                                        z: vertexesRaw[i + 2],
                                        w: vertexesRaw[i + 3]
                                    };
                                }
                                let indicesRaw = dividedParts[1].split(';');
                                let indices = [];
                                for (let i = 0; i < indicesRaw.length; ++i) {
                                    indices.push(indicesRaw[i].split(',').map(Number));
                                }
                                polygon4d = {
                                    vertexes,
                                    indices,
                                    multiplier: Number(dividedParts[2])
                                };
                                drawPoly4D.set(sides, polygon4d);
                            }
                            const rotated = polygon4d.vertexes
                                .slice()
                                .map(p => rotatePointXYZ(p, angle));
                            const sortedSides = polygon4d.indices
                                .slice()
                                .sort((a, b) => sortSides4d(rotated, a, b));
                            context.lineWidth /= 2;
                            const size = radius * polygon4d.multiplier;
                            for (const sides of sortedSides) {
                                context.beginPath();
                                for (let i = 0; i < sides.length; ++i) {
                                    const a = projectPoint4d(rotated[sides[i]]);
                                    const b = projectPoint4d(
                                        rotated[sides[(i + 1) % sides.length]]
                                    );
                                    context.lineTo(
                                        centerX + a.x * size,
                                        centerY + a.y * size,
                                        centerX + b.x * size,
                                        centerY + b.y * size
                                    );
                                }
                                context.closePath();
                                context.fill();
                                context.stroke();
                            }
                            return;
                        }
                        let path = new Path2D(sides);
                        context.save();
                        context.translate(centerX, centerY);
                        context.scale(radius, radius);
                        context.lineWidth /= radius;
                        context.rotate(angle);
                        context.lineWidth *= fill ? 1 : 0.5;
                        if (!borderless) context.stroke(path);
                        if (fill) context.fill(path);
                        context.restore();
                        return;
                    }
                    angle += sides % 2 ? 0 : Math.PI / sides;
                }
                if (!sides) {

                    let fillcolor = context.fillStyle;
                    let strokecolor = context.strokeStyle;
                    let borderRadius = context.globalAlpha < 1 ? 4 : 2;
                    switch (hasGlow) {
                        case true:
                            context.arc(centerX, centerY, radius, 0, 2 * Math.PI);
                            context.fillStyle = strokecolor;
                            context.lineWidth *= fill ? 1 : 0.5;
                            if (!borderless) context.stroke();
                            break;
                        default:
                            context.arc(centerX, centerY, radius + context.lineWidth / borderRadius, 0, 2 * Math.PI);
                            context.fillStyle = strokecolor;
                            context.lineWidth /= 2;
                            if (!borderless) {
                                switch (context.globalAlpha) {
                                    case 1:
                                        context.fill();
                                        break;
                                    default:
                                        context.stroke();
                                        break;
                                }
                            }
                            break;
                    }
                    context.closePath();
                    context.beginPath();
                    context.fillStyle = fillcolor;
                    context.arc(centerX, centerY, radius * fill, 0, 2 * Math.PI);
                    if (fill) {
                        context.fill();
                    }
                    context.closePath();
                    return;
                } else if (0 > sides) {

                    if (config.graphical.pointy) context.lineJoin = "miter";
                    sides = -sides;
                    angle += (sides % 1) * Math.PI * 2;
                    sides = Math.floor(sides);
                    let dip = 1 - 6 / (sides ** 2);
                    context.moveTo(centerX + radius * Math.cos(angle), centerY + radius * Math.sin(angle));
                    context.lineWidth *= fill ? 1 : 0.5;
                    for (let i = 0; i < sides; i++) {
                        let htheta = ((i + 0.5) / sides) * 2 * Math.PI + angle,
                            theta = ((i + 1) / sides) * 2 * Math.PI + angle,
                            cx = centerX + radius * dip * Math.cos(htheta),
                            cy = centerY + radius * dip * Math.sin(htheta),
                            px = centerX + radius * Math.cos(theta),
                            py = centerY + radius * Math.sin(theta);
                        if (config.graphical.curvyTraps) {
                            context.quadraticCurveTo(cx, cy, px, py);
                        } else {
                            context.lineTo(cx, cy);
                            context.lineTo(px, py);
                        }
                    }
                } else if (0 < sides) {

                    angle += (sides % 1) * Math.PI * 2;
                    sides = Math.floor(sides);
                    context.lineWidth *= fill ? 1 : 0.5;
                    for (let i = 0; i < sides; i++) {
                        let theta = (i / sides) * 2 * Math.PI + angle;
                        context.lineTo(centerX + radius * Math.cos(theta), centerY + radius * Math.sin(theta));
                    }
                }
                context.closePath();
                if (!borderless) context.stroke();
                if (fill) {
                    context.fill();
                }
                context.lineJoin = "round";
            } catch (e) {
                resizeEvent();
                console.error("Uh oh, 'CanvasRenderingContext2D' has gotton an error! Error: " + e);
            }
        },

        drawGun = (context, x, y, length, height, aspect, angle, borderless, fill, alpha, strokeWidth, position) => {
            // the same four corners as before, without two arrays per gun per frame
            const h0 = aspect > 0 ? height * aspect : height,
                h1 = aspect > 0 ? height : -height * aspect;
            const sinT = Math.sin(angle),
                cosT = Math.cos(angle);
            const back = -position, front = length * 2 - position;
            context.globalAlpha = alpha;

            context.beginPath();
            context.lineTo(back * cosT - h1 * sinT + x, back * sinT + h1 * cosT + y);
            context.lineTo(front * cosT - h0 * sinT + x, front * sinT + h0 * cosT + y);
            context.lineTo(front * cosT - -h0 * sinT + x, front * sinT + -h0 * cosT + y);
            context.lineTo(back * cosT - -h1 * sinT + x, back * sinT + -h1 * cosT + y);
            context.closePath();
            context.lineWidth *= strokeWidth
            context.lineWidth *= fill ? 1 : 0.5;
            if (!borderless) context.stroke();
            context.lineWidth /= fill ? 1 : 0.5;
            if (fill) context.fill();
            context.globalAlpha = 1;
        };
        const byLayer = (a, b) => a.layer - b.layer;
        // Ready the scratch canvas for a side x side body (side truncated the
        // way a canvas width is): cleared, default state, identity transform.
        // Grows only; a reused canvas gets the state a width reset would give.
        const fancyCanvasBegin = (c, size) => {
            const side = size >= 1 && size < 1e5 ? Math.trunc(size) : 0;
            const cv = c.canvas;
            if (side > cv.width || side > cv.height) {
                const grown = Math.min(8192, Math.max(side, Math.ceil(cv.width * 1.25)));
                cv.width = grown;
                cv.height = grown;
                return side;
            }
            c.setTransform(1, 0, 0, 1, 0, 0);
            c.globalAlpha = 1;
            c.globalCompositeOperation = "source-over";
            c.shadowBlur = 0;
            c.shadowOffsetX = 0;
            c.shadowOffsetY = 0;
            c.imageSmoothingEnabled = true;
            c.clearRect(0, 0, cv.width, cv.height);
            return side;
        };
        // one options object for every skinned hull, refilled per draw
        const skinOpts = { statusColor: null, blend: 0, flash: false, flashColor: null, hitBlend: 0, hitColor: null, borderless: false, fill: true, lowFx: false, force: false };

        return (baseColor, x, y, instance, ratio, alpha = 1, scale = 1, lineWidthMult = 1, rot = 0, turretsObeyRot = false, assignedContext = false, turretInfo = false, render = instance.render, smoothsize = false) => {

            const fade = turretInfo ? 1 : render.status.getFade();
            if (fade === 0 || alpha === 0) return;

            const alphaFade = fade * alpha;
            if (!global.gameUpdate && alphaFade < 0.5) return;

            let context = assignedContext || ctx[1];
            const m = global.mockups[entMockupIndex(instance)] || global.missingno[0];
            const source = turretInfo === false ? instance : turretInfo;

            const instSize = instance.size;
            let drawSize = smoothsize ? scale * ratio * smoothsize : scale * ratio * instSize;

            if (global.gameUpdate && fade !== 1) {
                drawSize *= config.graphical.fancyAnimations ?
                    (1 + 0.5 * (1 - fade)) :
                    (1 - 2 * (1 - fade));

                if (drawSize < 0) drawSize = scale * ratio * instSize;
            }

            if (drawSize < 0.1) return;

            // Hit flash and punch for this body (hitFx.js). Copied out of the
            // shared look object before any turret recursion can touch it.
            let hitBlend = 0, hitHot = 0, hitTintHot = false;
            if (turretInfo === false && render.hitAt && instance.drawsHealth) {
                const hl = hitFx.bodyLook(render, instance.id === gui.playerid, performance.now());
                hitBlend = hl.blend; hitHot = hl.hot; hitTintHot = hl.tintHot;
                if (hl.scale !== 1) drawSize *= hl.scale;
            }

            // Carrier glow: halo plus a breathing rim, scaled by the synced
            // glow rung (1-6, matching the satchel size rungs).
            const glowRung = (!turretInfo && !glowOff() && (instance.gemGlow | 0)) || 0;
            if (glowRung > 0) {
                const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 480);
                const haloR = drawSize * (1.45 + 0.22 * glowRung);
                const ha = (0.10 + 0.05 * glowRung) * alphaFade * (0.8 + 0.2 * pulse);
                // the halo is the tank's own colour, not a generic gold
                let bodyCol = "#ffd75e";
                try { bodyCol = gameDraw.modifyColor(instance.color) || bodyCol; } catch (e) { /* */ }
                const bodyRgb = toRgb(bodyCol) || { r: 255, g: 215, b: 94 };
                const tint = bodyRgb.r + "," + bodyRgb.g + "," + bodyRgb.b;
                const spr = haloSprite("halo|" + tint, tint, [[0.35, 0], [0.65, 0.7], [1, 0]]);
                context.save();
                context.globalAlpha = ha;
                context.drawImage(spr, x - haloR, y - haloR, haloR * 2, haloR * 2);
                context.globalAlpha = alphaFade * (0.22 + 0.09 * glowRung) * (0.65 + 0.35 * pulse);
                context.strokeStyle = bodyCol;
                context.lineWidth = Math.max(1.5, drawSize * 0.045);
                context.beginPath();
                context.arc(x, y, drawSize * (1.08 + 0.03 * pulse), 0, Math.PI * 2);
                context.stroke();
                context.restore();
            }

            // no props and at most one turret (every bullet): nothing to merge
            // or order, so skip the per-frame copy and sort
            const turrets = !instance.isImage && m.props && m.props.length === 0 && source.turrets.length < 2 ? source.turrets
                : instance.isImage ? source.turrets : [...source.turrets, ...m.props];
            if (m.props && turrets !== source.turrets || instance.isImage && m.props) turrets.sort(byLayer);

            source.guns.update();

            let xx = x, yy = y;
            const useFancyCanvas = DEAIC(assignedContext, alphaFade, m.shape, m.glow, source.guns.length, turrets.length);

            let fancySide = 0;
            if (useFancyCanvas) {
                context = ctx2;
                // The body is drawn opaque into the top-left side x side of
                // the scratch canvas, then blitted with the fade. The canvas
                // only grows: resizing it per draw (every dying drone or trap,
                // every frame of its fade) reallocated its backing store, and
                // the source-rect blit below copies exactly what the
                // old exactly-sized canvas held.
                fancySide = fancyCanvasBegin(context, drawSize * m.position.axis + ratio * 20 * m.position.axis);
                xx = fancySide / 2 - (drawSize * m.position.axis * m.position.middle.x * Math.cos(rot)) / 4;
                yy = fancySide / 2 - (drawSize * m.position.axis * m.position.middle.x * Math.sin(rot)) / 4;
                context.translate(0.5, 0.5);
            } else if (alphaFade < 0.5 && !config.graphical.fancyAnimations) {
                return;
            }

            const sharp = config.graphical.sharpEdges;
            const minBorder = config.graphical.mininumBorderChunk;
            const borderChunk = config.graphical.borderChunk;
            const initStrokeWidth = lineWidthMult * Math.max(minBorder, ratio * borderChunk);

            context.lineCap = sharp ? "miter" : "round";
            context.lineJoin = sharp ? "miter" : "round";
            context.lineWidth = initStrokeWidth;

            const sizeRatio = (drawSize / m.size) * m.realSize;

            for (let i = 0; i < turrets.length; i++) {
                let t = turrets[i];
                if (t.isProp) t = util.requestEntityImage(t);
                if (!t.sizeFactor) continue; // zero-size prop
                if (t.lerpedFacing === undefined) {
                    t.lerpedFacing = t.facing;
                } else {
                    t.lerpedFacing = util.lerpAngle(t.lerpedFacing, t.facing, 0.1, true);
                }
                t.invuln = instance.invuln;
                if (!t.layer) {
                    const ang = t.direction + t.angle + rot;
                    const len = t.offset * drawSize;
                    const facing = t.forceAngle === null || t.forceAngle === undefined ? (t.mirrorMasterAngle || turretsObeyRot) ? rot + t.angle : t.lerpedFacing : t.angle;
                    const cosAng = Math.cos(ang);
                    const sinAng = Math.sin(ang);

                    context.lineWidth = initStrokeWidth * t.strokeWidth;

                    drawEntity(
                        baseColor,
                        xx + len * cosAng,
                        yy + len * sinAng,
                        t,
                        ratio,
                        1,
                        (drawSize / ratio / t.size) * t.sizeFactor,
                        lineWidthMult,
                        facing,
                        turretsObeyRot,
                        context,
                        t,
                        render
                    );
                }
            }

            const positions = source.guns.getPositions();
            const gunConfig = source.guns.getConfig();
            const statusColor = render.status.getColor();
            const blend = render.status.getBlend();

            // Server-driven hit blink, eased on the client between network
            // ticks: white hot for a frame or two, melting into the red, then a
            // squared falloff. mixColors is cached, so this is a map lookup.
            let hitTint = hitBlend > 0 ? hitTintFor(gameDraw.modifyColor(instance.color, baseColor)) : HIT_BLINK_COLOR;
            if (hitHot > 0 && hitTintHot) hitTint = gameDraw.mixColors(hitTint, hitFx.HOT_COLOR, hitHot * 0.85);

            const sourceGuns = source.guns;
            const gunLength = sourceGuns.length;

            for (let drawAbove = 0; drawAbove < 2; ++drawAbove) {

                for (let i = 0; i < gunLength; ++i) {
                    const g = gunConfig[i];
                    if (g.hidden) continue;

                    if ((drawAbove === 0 && g.drawAbove) || (drawAbove === 1 && !g.drawAbove)) {
                        continue;
                    }

                    context.lineWidth = initStrokeWidth;

                    const gAngle = g.angle + rot;
                    const gunAngle = g.direction + gAngle;
                    const cosGunAngle = Math.cos(gunAngle);
                    const sinGunAngle = Math.sin(gunAngle);

                    const gx = g.offset * cosGunAngle;
                    const gy = g.offset * sinGunAngle;

                    let gunColor = g.color == null ? color.grey : gameDraw.modifyColor(g.color, baseColor);
                    const lightGun = previewGrey && gunColor === color.grey;
                    if (lightGun) gunColor = PREVIEW_GREY;
                    const gunAlpha = g.alpha === undefined ? 1 : g.alpha;
                    let mixedColor = gameDraw.mixColors(gunColor, statusColor, blend);
                    global.gameUpdate && instance.invuln !== 0 && 100 > (Date.now() - instance.invuln) % 200 && ((mixedColor = gameDraw.mixColors(gunColor, gameDraw.getColor(6), 0.3)));
                    if (hitBlend > 0) mixedColor = gameDraw.mixColors(mixedColor, hitTint, hitBlend * 0.6);
                    gameDraw.setColor(context, mixedColor);
                    if (lightGun) context.strokeStyle = PREVIEW_GREY_EDGE;

                    drawGun(
                        context,
                        xx + drawSize * gx,
                        yy + drawSize * gy,
                        drawSize * g.length / 2,
                        drawSize * g.width / 2,
                        g.aspect,
                        gAngle,
                        g.borderless,
                        g.drawFill,
                        gunAlpha,
                        g.strokeWidth,
                        drawSize * positions[i]
                    );
                }

                if (drawAbove === 0) {
                    context.globalAlpha = !useFancyCanvas && alphaFade < 1 && config.graphical.fancyAnimations ? alphaFade : 1;
                    context.lineWidth = initStrokeWidth * m.strokeWidth;

                    // bodyBase: the unmixed hull colour (skins are built from it)
                    let bodyBase = gameDraw.modifyColor(instance.color, baseColor);
                    const lightBody = previewGrey && bodyBase === color.grey;
                    if (lightBody) bodyBase = PREVIEW_GREY;
                    const invulnBlink = !!(global.gameUpdate && instance.invuln !== 0 && 100 > (Date.now() - instance.invuln) % 200);
                    let bodyColor = gameDraw.mixColors(bodyBase, statusColor, blend);
                    if (invulnBlink) bodyColor = gameDraw.mixColors(bodyBase, gameDraw.getColor(6), 0.3);
                    if (hitBlend > 0) bodyColor = gameDraw.mixColors(bodyColor, hitTint, hitBlend);
                    gameDraw.setColor(context, bodyColor);
                    if (lightBody) context.strokeStyle = PREVIEW_GREY_EDGE;

                    const glow = m.glow;
                    const glowRadius = config.graphical.noGlow ? 0 : glow.radius;

                    if (glowRadius > 0) {

                        context.shadowColor = glow.color != null
                            ? gameDraw.modifyColor(glow.color)
                            : gameDraw.mixColors(
                                gameDraw.modifyColor(instance.color),
                                statusColor,
                                0
                            );

                        const glowSize = glowRadius * sizeRatio;
                        context.shadowBlur = glowSize;
                        context.shadowOffsetX = 0;
                        context.shadowOffsetY = 0;
                        context.globalAlpha = glow.alpha;

                        const recursion = glow.recursion;
                        const shape = m.shape;

                        for (let i = 0; i < recursion; ++i) {
                            drawBody(context, xx, yy, sizeRatio, shape, rot, true, m.drawFill, false, true);
                        }

                        context.globalAlpha = 1;
                    }

                    if (glowRadius > 0) {
                        context.shadowBlur = 0;
                        context.shadowOffsetX = 0;
                        context.shadowOffsetY = 0;
                    }

                    drawBody(context, xx, yy, sizeRatio, m.shape, rot, m.borderless, m.drawFill, m.imageInterpolation);
                    // tank skin (accounts): the hull only, never turrets or guns
                    if (turretInfo === false && instance.skin) {
                        try {
                            const so = skinOpts;
                            so.statusColor = statusColor; so.blend = blend; so.flash = invulnBlink; so.flashColor = gameDraw.getColor(6);
                            so.hitBlend = hitBlend; so.hitColor = hitTint; so.borderless = m.borderless; so.fill = m.drawFill;
                            so.lowFx = !!(global.lowFx || config.graphical.optimizeMode); so.force = !!instance.skinForce;
                            cosmetics.paintHull(context, xx, yy, sizeRatio, m.shape, rot, instance.skin, bodyBase, so);
                        } catch (e) { /* a skin never breaks the frame */ }
                    }
                }
            }

            for (let i = 0; i < turrets.length; i++) {
                let t = turrets[i];
                if (t.isProp) t = util.requestEntityImage(t);
                if (!t.sizeFactor) continue; // zero-size prop
                if (t.lerpedFacing === undefined) {
                    t.lerpedFacing = t.facing;
                } else {
                    t.lerpedFacing = util.lerpAngle(t.lerpedFacing, t.facing, 0.1, true);
                }
                t.invuln = instance.invuln;
                if (t.layer) {
                    const ang = t.direction + t.angle + rot;
                    const len = t.offset * drawSize;
                    const facing = t.forceAngle === null || t.forceAngle === undefined ? (t.mirrorMasterAngle || turretsObeyRot) ? rot + t.angle : t.lerpedFacing : t.angle;
                    const cosAng = Math.cos(ang);
                    const sinAng = Math.sin(ang);

                    context.lineWidth = initStrokeWidth * t.strokeWidth;

                    drawEntity(
                        baseColor,
                        xx + len * cosAng,
                        yy + len * sinAng,
                        t,
                        ratio,
                        1,
                        (drawSize / ratio / t.size) * t.sizeFactor,
                        lineWidthMult,
                        facing,
                        turretsObeyRot,
                        context,
                        t,
                        render
                    );
                }
            }

            if (!assignedContext && context !== ctx[1] && fancySide > 0) {
                ctx[1].save();

                ctx[1].globalAlpha = alphaFade;
                ctx[1].imageSmoothingEnabled = true;

                ctx[1].drawImage(context.canvas, 0, 0, fancySide, fancySide, x - xx, y - yy, fancySide, fancySide);
                ctx[1].restore();
            }

            // hit ring lives on the world canvas so the offscreen body blit
            // doesn't clip it; only for health-drawing bodies, not bullets.
            if (turretInfo === false && !assignedContext && instance.drawsHealth && hitBlend > 0) {
                const ht = Math.max(0, Math.min(1, (performance.now() - render.hitAt) / HIT_BLINK_MS));
                const ringCtx = ctx[1];
                ringCtx.save();
                ringCtx.globalAlpha = alphaFade * (1 - ht) * (1 - ht) * 0.9;
                ringCtx.strokeStyle = hitTint;
                ringCtx.lineWidth = Math.max(1.6, initStrokeWidth * (1.7 - ht * 0.8));
                ringCtx.beginPath();
                ringCtx.arc(x, y, sizeRatio * (1.06 + ht * 0.72), 0, Math.PI * 2);
                ringCtx.stroke();
                ringCtx.restore();
            }

            if (sharp) {
                context.lineCap = "round";
                context.lineJoin = "round";
            }
        }
    })();
    // See window.dwCtx: the tutorial's ore-tier card needs the game renderer.
    window.dwDrawEntity = drawEntity;

    const iconColorOrder = [10, 11, 12, 15, 13, 2, 14, 4, 5, 1, 0, 3];
    function getIconColor(colorIndex) {
        return iconColorOrder[colorIndex % 12].toString();
    }

    // ─── upgrade tiles (menu + class tree), HUD look ────────────────────
    // One plate per tank: flat face over a darker lip, keyline, name band
    // and the choose key as a keycap. All but the tank preview is rasterised
    // once per (colour, size, state, name, key) at device resolution and
    // blitted; drawEntity draws the live tank between plate and label.
    // Sizes are quantised so a zooming class tree does not mint a bitmap
    // every frame.
    const upgTileCache = new Map();
    // Tank pictures by class index. Building one walks every gun and turret
    // of the class, so the tree, tiles and death card keep them between frames.
    const mockupPics = new Map();
    function mockupPicture(index, col) {
        const k = index + "|" + col;
        const hit = mockupPics.get(k);
        if (hit && hit.mockups === global.mockups) return hit.pic;
        const pic = util.getEntityImageFromMockup(index, col);
        // one built before its mockup arrived is a placeholder: don't keep it
        if (String(index).split("-").every(i => global.mockups[parseInt(i)])) {
            if (mockupPics.size > 300) mockupPics.clear();
            mockupPics.set(k, { pic, mockups: global.mockups });
        }
        return pic;
    }
    let upgFontOk = false;
    const UPG_BAND = 0.25;              // name band, fraction of the face
    const UPG_LIP = 4;                  // lip depth at a 100-unit tile
    function upgTileColors(model, colorIndex) {
        let face = model.upgradeColor != null
            ? gameDraw.modifyColor(model.upgradeColor)
            : gameDraw.getColor(getIconColor(colorIndex));
        if (typeof face !== "string" || face[0] !== "#" || face.length !== 7) return [face || HUD.face, HUD.faceDk];
        // calm the raw palette a touch so the tiles sit with the dark plates
        return [gameDraw.mixColors(face, HUD.wellSolid, 0.18), gameDraw.mixColors(face, HUD.ink, 0.5)];
    }
    // A tile asked for at the same size a few frames running (the choice
    // tiles, a class tree at rest) is baked at its exact device size, whole
    // pixels wide, and blitted 1:1 on whole pixels. One that is zooming
    // takes the ~4% steps below and is stretched the rest of the way.
    const upgExactSeen = new Map();
    function upgTileBitmap(kind, w, h, dpr, parts, paint) {
        // until Lilita One has loaded, labels rasterise in the fallback font;
        // key on it so they are redrawn once the real face arrives
        if (!upgFontOk) { try { upgFontOk = !document.fonts || document.fonts.check('12px "Lilita One"'); } catch (e) { upgFontOk = true; } }
        const tail = "|" + (h / w).toFixed(3) + "|" + parts + "|" + config.graphical.fontSizeBoost + "|" + upgFontOk;
        if (!crispOff) {
            const W = Math.max(8, Math.round(w * dpr));
            const ek = kind + "|=" + W + "|" + dpr.toFixed(3) + tail;
            let bm = upgTileCache.get(ek);
            if (bm) return bm;
            const n = (upgExactSeen.get(ek) || 0) + 1;
            if (n >= 3) {
                upgExactSeen.delete(ek);
                const u = W / w, P = Math.ceil(4 * u);           // device px per unit, pad in px
                const cv = document.createElement("canvas");
                cv.width = W + P * 2;
                cv.height = Math.ceil(h * u) + P * 2;
                const c = cv.getContext("2d");
                c.translate(P, P);
                c.scale(u, u);
                paint(c);
                bm = { cv, P, exact: true };
                if (upgTileCache.size > 500) upgTileCache.clear();
                upgTileCache.set(ek, bm);
                return bm;
            }
            if (upgExactSeen.size > 2000) upgExactSeen.clear();
            upgExactSeen.set(ek, n);
        }
        // quantise the device size to ~4% steps; blit scales the rest
        const q = Math.max(8, Math.round(Math.pow(1.04, Math.round(Math.log(w * dpr) / Math.log(1.04)))));
        const k = kind + "|" + q + tail;
        let bm = upgTileCache.get(k);
        if (bm) return bm;
        const u = q / w;                                 // device px per UI unit
        const pad = 4;                                   // room for outline + lip line
        const cv = document.createElement("canvas");
        cv.width = Math.ceil((w + pad * 2) * u);
        cv.height = Math.ceil((h + pad * 2) * u);
        const c = cv.getContext("2d");
        c.scale(u, u);
        c.translate(pad, pad);
        paint(c);
        bm = { cv, pad };
        if (upgTileCache.size > 500) upgTileCache.clear();
        upgTileCache.set(k, bm);
        return bm;
    }
    function upgBlit(bm, x, y, w, h) {
        if (bm.exact) {
            const t = tfOf(ctx[2]), a = t.a, d = t.d;
            ctx[2].drawImage(bm.cv, (Math.round(x * a) - bm.P) / a, (Math.round(y * d) - bm.P) / d, bm.cv.width / a, bm.cv.height / d);
        } else ctx[2].drawImage(bm.cv, x - bm.pad, y - bm.pad, w + bm.pad * 2, h + bm.pad * 2);
    }
    // state: 0 idle, 1 hover, 2 pressed. key: keycap label or false.
    // A tile's tank at device pixels with a light rim, drawn once per tank and
    // tile size (fr: upGrid.tileFrame) and blitted after
    const TILE_RIM = "rgba(255,243,217,0.9)";
    const tilePrevCache = new Map();
    let tilePrevHalo = null;
    function tankMockOf(picture) {
        const ids = String(picture.index).split("-").map(i => global.mockups && global.mockups[parseInt(i)]).filter(Boolean);
        if (ids.length < 2) return ids[0] || null;
        return { ...ids[0], guns: ids.flatMap(m => m.guns || []), turrets: ids.flatMap(m => m.turrets || []) };
    }
    const tileFrames = new Map();
    function tileFrameOf(picture, len, height) {
        const key = picture.index + "|" + len.toFixed(2) + "|" + height.toFixed(2);
        let fr = tileFrames.get(key);
        if (!fr) {
            const m = tankMockOf(picture);
            fr = upGrid.tileFrame(m || { shape: 0 }, len, height, (i) => global.mockups && global.mockups[i]);
            fr.box = upGrid.silhouette(m || { shape: 0 }, fr.angle, (i) => global.mockups && global.mockups[i]);
            if (tileFrames.size > 160) tileFrames.clear();
            tileFrames.set(key, fr);
        }
        return fr;
    }
    function drawTilePreview(picture, ex, ey, fr, lineWidthMult, k) {
        if (crispOff) return false;
        const t = tfOf(ctx[2]);
        const a = Math.abs(t.a);
        if (!(a > 0) || t.b || t.c || Math.abs(Math.abs(t.d) - a) > 1e-6) return false;
        const key = picture.index + "|" + picture.color + "|" + fr.scale.toFixed(3) + "|" + lineWidthMult + "|" + a.toFixed(3);
        let e = tilePrevCache.get(key);
        if (!e) {
            const rim = Math.max(1.25, 1.7 * k) * a;                // device px
            const P = Math.ceil(rim + 4 * a + 3), sc = fr.scale * a, b = fr.box;
            const W = Math.ceil((b.x1 - b.x0) * sc) + P * 2, H = Math.ceil((b.y1 - b.y0) * sc) + P * 2;
            if (W > 1024 || H > 1024) return false;
            const ox = Math.round(-b.x0 * sc) + P, oy = Math.round(-b.y0 * sc) + P;
            const cv = document.createElement("canvas");
            cv.width = W; cv.height = H;
            if (!tilePrevHalo) tilePrevHalo = document.createElement("canvas");
            const hv = tilePrevHalo;
            if (hv.width < W || hv.height < H) { hv.width = Math.max(W, hv.width); hv.height = Math.max(H, hv.height); }
            const tank = document.createElement("canvas");
            tank.width = W; tank.height = H;
            const c = tank.getContext("2d"), h = hv.getContext("2d"), o = cv.getContext("2d");
            c.setTransform(a, 0, 0, a, 0, 0);
            c.lineCap = "round";
            c.lineJoin = "round";
            previewGrey = true;
            try { drawEntity(picture.color, ox / a, oy / a, picture, 1, 1, fr.scale / picture.size, lineWidthMult, fr.angle, true, c); }
            finally { previewGrey = false; }
            h.setTransform(1, 0, 0, 1, 0, 0);
            h.clearRect(0, 0, hv.width, hv.height);
            h.drawImage(tank, 0, 0);
            h.globalCompositeOperation = "source-in";
            h.fillStyle = TILE_RIM;
            h.fillRect(0, 0, W, H);
            h.globalCompositeOperation = "source-over";
            for (let i = 0; i < 8; i++) {
                const an = i * Math.PI / 4;
                o.drawImage(hv, 0, 0, W, H, Math.cos(an) * rim, Math.sin(an) * rim, W, H);
            }
            o.drawImage(tank, 0, 0);
            e = { cv, ox, oy };
            if (tilePrevCache.size >= 64) tilePrevCache.delete(tilePrevCache.keys().next().value);
            tilePrevCache.set(key, e);
        }
        // the tank's centre on a whole device pixel (tracked transforms carry no translation)
        const ux = 1 / a, dx = Math.round(ex * a), dy = Math.round(ey * a);
        ctx[2].drawImage(e.cv, (dx - e.ox) * ux, (dy - e.oy) * ux, e.cv.width * ux, e.cv.height * ux);
        return true;
    }
    // crisp: the choose grid's tiles: a bigger tank
    function drawUpgradeTile(model, x, y, len, height, colorIndex, key, state = 0, angle = -Math.PI / 4, lineWidthMult = 1, alpha = 1, crisp = false) {
        const picture = (typeof model == "object") ? model : mockupPicture(model, gui.color);
        const position = picture.position;
        const t = tfOf(ctx[2]);
        const dpr = Math.hypot(t.a, t.b) || 1;
        const k = len / 100;                             // tile scale vs the 100-unit design
        const lip = UPG_LIP * k;
        const down = state === 2 ? Math.min(2 * k, lip - 1) : 0;
        const faceH = height - lip;
        const band = faceH * UPG_BAND;
        const r = Math.max(3, 10 * k);
        const [face, lipCol] = upgTileColors(picture, colorIndex);
        const name = String(picture.upgradeName ?? picture.name ?? "");

        const plate = upgTileBitmap("p" + face + lipCol, len, height, dpr, state, (c) => {
            // lip, then the face lifted off it (pressed: sunk into it)
            roundRectPath(c, 0, down, len, height - down, r);
            c.fillStyle = lipCol;
            c.fill();
            roundRectPath(c, 0, down, len, faceH, r);
            c.fillStyle = face;
            c.fill();
            if (state === 1) { c.fillStyle = "rgba(255,255,255,0.16)"; c.fill(); }
            else if (state === 2) { c.fillStyle = "rgba(0,0,0,0.14)"; c.fill(); }
            // flat top highlight strip, like the menu's plates
            roundRectPath(c, 3 * k, down + 3 * k, len - 6 * k, Math.max(2, 5 * k), 2.5 * k);
            c.fillStyle = "rgba(255,255,255,0.13)";
            c.fill();
        });
        // no guns of its own or on its turrets (Smasher, Spike, ...), or a ram
        // tank's smasher stat set (Architect's launchers sit on turrets: it shoots)
        const ramMock = global.mockups && global.mockups[parseInt(String(picture.index).split("-")[0])];
        const ram = !!(picture.guns && (upGrid.isRamMockup(ramMock || picture) ||
            (minesBy(picture.guns.length) === "ram" && !upGrid.turretGuns(ramMock || picture))));
        const label = upgTileBitmap("l" + name + (ram ? "|ram" : ""), len, height, dpr, (key || "") + state, (c) => {
            // name band across the bottom of the face, inside the plate
            c.save();
            roundRectPath(c, 0, down, len, faceH, r);
            c.clip();
            c.fillStyle = "rgba(0,0,0,0.5)";
            c.fillRect(0, down + faceH - band, len, band);
            c.restore();
            // one line if it fits near full size, else two lines, else shrink
            // (a ram tile: one smaller line over the RAMS ROCK chip, both in the band)
            const rb = ram ? upGrid.ramBadge(len, height, (sz) => hudTitleW("RAMS ROCK", sz), down) : null;
            const base = rb ? Math.max(5, rb.nameMax) : Math.max(6, band * 0.62), room = len - 10 * k;
            const mid = rb ? rb.nameMid : down + faceH - band / 2;
            const words = name.split(" ");
            let size = base;
            while (size > base * 0.8 && hudTitleW(name, size) > room) size -= 0.5;
            if (rb || hudTitleW(name, size) <= room || words.length < 2) {
                while (size > 6 && hudTitleW(name, size) > room) size -= 0.5;
                hudTitle(name, len / 2, mid, size, HUD.head, "center", 1, c);
            } else {
                // split where the two halves come out most even
                let best = 1, bestW = Infinity;
                for (let i = 1; i < words.length; i++) {
                    const w = Math.max(hudTitleW(words.slice(0, i).join(" "), 10), hudTitleW(words.slice(i).join(" "), 10));
                    if (w < bestW) { bestW = w; best = i; }
                }
                const l1 = words.slice(0, best).join(" "), l2 = words.slice(best).join(" ");
                size = Math.min(base * 0.72, band * 0.46);
                while (size > 5 && Math.max(hudTitleW(l1, size), hudTitleW(l2, size)) > room) size -= 0.5;
                hudTitle(l1, len / 2, mid - size * 0.52, size, HUD.head, "center", 1, c);
                hudTitle(l2, len / 2, mid + size * 0.52, size, HUD.head, "center", 1, c);
            }
            if (key) hudKey(c, 5 * k, down + 5 * k, key, Math.max(10, 17 * k));
            // the fine keyline last so nothing paints over the edge
            c.lineJoin = "round";
            c.lineWidth = Math.max(1, 1.5 * k);
            c.strokeStyle = HUD.line;
            roundRectPath(c, 0, down, len, height - down, r);
            c.stroke();
            // "RAMS ROCK": a small chip under the name, inside the band
            if (rb) {
                const b = rb;
                roundRectPath(c, b.x, b.y, b.w, b.h, b.h / 2);
                c.fillStyle = "rgba(0,0,0,0.92)";
                c.fill();
                c.lineWidth = Math.max(1, 1.2 * k);
                c.strokeStyle = HUD.gold;
                c.stroke();
                hudTitle("RAMS ROCK", len / 2, b.y + b.h / 2, b.size, HUD.gold, "center", 1, c);
            }
        });

        // the plate lands on whole pixels; the tank keeps its place on it
        if (plate.exact) { const t2 = tfOf(ctx[2]); x = Math.round(x * t2.a) / t2.a; y = Math.round(y * t2.d) / t2.d; }
        ctx[2].save();
        ctx[2].globalAlpha *= alpha;
        upgBlit(plate, x, y, len, height);
        if (crisp) {
            // the choose grid: the whole silhouette (barrels, turrets) framed above the
            // name band at the arras tilt, front barrels to the upper right; still, cached
            const fr = tileFrameOf(picture, len, height);
            const ex = x + fr.x, ey = y + down + fr.y;
            if (!drawTilePreview(picture, ex, ey, fr, lineWidthMult, k)) {
                previewGrey = true;
                try { drawEntity(picture.color, ex, ey, picture, 1, 1, fr.scale / picture.size, lineWidthMult, fr.angle, true, ctx[2]); }
                finally { previewGrey = false; }
            }
        } else {
            // the live tank, centred in the face above the name band
            const scale = 0.55 * len / position.axis;
            const areaH = faceH - band;
            let entityX = x + 0.5 * len, entityY = y + down + areaH * 0.5 + 1;
            const xShift = position.middle.x * Math.cos(angle) - position.middle.y * Math.sin(angle),
                yShift = position.middle.x * Math.sin(angle) + position.middle.y * Math.cos(angle);
            entityX -= scale * xShift;
            entityY -= scale * yShift;
            drawEntity(picture.color, entityX, entityY, picture, 1, 1, scale / picture.size, lineWidthMult, angle, true, ctx[2]);
        }
        ctx[2].globalAlpha = alpha;
        upgBlit(label, x, y, len, height);
        ctx[2].restore();
    }

    // QA: one upgrade tile into any 2d context (tile previews, scripts/build-tanks.js checks)
    window.dwUpgradeTile = (c, ...args) => { const o = ctx[2]; ctx[2] = c; try { drawUpgradeTile(...args); } finally { ctx[2] = o; } };

    // Dig Wars: the cavern floor. A seamless flat-fill tile (no gradients):
    // two-tone earth patches plus a few pebbles outlined like the walls.
    // Built once offscreen, world-locked, deterministic.
    let floorPattern = null;
    function makeFloorPattern(context) {
        const S = 256;
        const tile = document.createElement("canvas");
        tile.width = tile.height = S;
        const t = tile.getContext("2d");
        // deterministic hash so every session's floor looks the same
        let seed = 7;
        const rng = () => {
            seed = (Math.imul(seed, 1597334677) + 926135893) | 0;
            return ((seed >>> 8) & 0xffffff) / 0x1000000;
        };
        // three flat tones: base, lighter, darker. Neutral near-black so the
        // wall and team colours own the contrast.
        // (Oct 6: lifted a step, the cave read murky; still well under the rocks)
        const BASE = "#282624", LIGHT = "#2e2c29", DARK = "#222120";
        t.fillStyle = BASE;
        t.fillRect(0, 0, S, S);
        // toroidal draw: paint each feature at all 9 wrap offsets so the
        // tile is seamless. Randomness is rolled before the 9 copies so
        // every copy is identical.
        const wrapped = (draw) => {
            for (let dx = -1; dx <= 1; dx++)
                for (let dy = -1; dy <= 1; dy++) {
                    t.save();
                    t.translate(dx * S, dy * S);
                    draw();
                    t.restore();
                }
        };
        // irregular rounded blob: N points with jittered radius, joined by
        // quadratic curves
        const blob = (x, y, r) => {
            const n = 7 + (rng() * 3 | 0);
            const pts = [];
            for (let i = 0; i < n; i++) {
                const a = (i / n) * Math.PI * 2 + rng() * 0.4;
                const rr = r * (0.62 + rng() * 0.55);
                pts.push([x + Math.cos(a) * rr, y + Math.sin(a) * rr]);
            }
            return () => {
                t.beginPath();
                for (let i = 0; i < n; i++) {
                    const p = pts[i], q = pts[(i + 1) % n];
                    const mx = (p[0] + q[0]) / 2, my = (p[1] + q[1]) / 2;
                    i ? t.quadraticCurveTo(p[0], p[1], mx, my)
                      : t.moveTo((pts[n - 1][0] + p[0]) / 2, (pts[n - 1][1] + p[1]) / 2);
                    if (i) continue;
                    t.quadraticCurveTo(p[0], p[1], mx, my);
                }
                t.closePath();
            };
        };
        // layer 1: large earth patches, dark then light
        for (let i = 0; i < 9; i++) {
            const path = blob(rng() * S, rng() * S, 26 + rng() * 34);
            wrapped(() => { path(); t.fillStyle = DARK; t.fill(); });
        }
        for (let i = 0; i < 9; i++) {
            const path = blob(rng() * S, rng() * S, 20 + rng() * 28);
            wrapped(() => { path(); t.fillStyle = LIGHT; t.fill(); });
        }
        // layer 2: small light dirt clods on the patches
        for (let i = 0; i < 26; i++) {
            const path = blob(rng() * S, rng() * S, 2.5 + rng() * 4.5);
            const tone = rng() < 0.5 ? "#33312c" : "#1e1d1b";
            wrapped(() => { path(); t.fillStyle = tone; t.fill(); });
        }
        // layer 3: pebbles with the same dark border the rocks wear
        for (let i = 0; i < 12; i++) {
            const x = rng() * S, y = rng() * S;
            const r = 2.2 + rng() * 2.8, rot = rng() * Math.PI;
            const squish = 0.65 + rng() * 0.3;
            const col = rng() < 0.5 ? "#44413b" : "#514d44";
            wrapped(() => {
                t.save();
                t.translate(x, y);
                t.rotate(rot);
                t.fillStyle = col;
                t.beginPath();
                t.ellipse(0, 0, r, r * squish, 0, 0, Math.PI * 2);
                t.fill();
                t.lineWidth = 1.4;
                t.strokeStyle = "rgb(5,4,7)";
                t.stroke();
                t.restore();
            });
        }
        return context.createPattern(tile, "repeat");
    }

    // Dig Wars: the team vault (bank). Flat shapes, dark outlines, a
    // team-coloured gem heart. Gold is reserved for gem dust (deposit
    // stream / progress).
    let vaultDust = [];   // deposit stream + completion burst particles
    const GOLD_PAL   = { main: "#efc74b", light: "#f7dd8a", high: "#fff6d8" };
    const BLUE_PAL   = { main: "#3d8fff", light: "#9ec5ff", high: "#e8f1ff" };
    const RED_PAL    = { main: "#ff3b4a", light: "#ff8b93", high: "#ffe0e2" };
    const YELLOW_PAL = { main: "#e0c04a", light: "#f3e39a", high: "#fff8de" };
    function hexToRgb(hex) {
        if (typeof hex !== "string" || hex[0] !== "#") return [61, 143, 255];
        const h = hex.length === 4
            ? hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3]
            : hex.slice(1, 7);
        const n = parseInt(h, 16);
        if (!Number.isFinite(n)) return [61, 143, 255];
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    function rgba(hex, a) {
        const [r, g, b] = hexToRgb(hex);
        return `rgba(${r},${g},${b},${a})`;
    }
    const vaultSpritesTeam = {};   // team-keyed door sprite sets
    // [r,g,b] pulled toward the HUD ink by k (0..1), as a css colour
    function inkShade(rgb, k) {
        return "rgb(" + Math.round(rgb[0] + (18 - rgb[0]) * k) + "," +
            Math.round(rgb[1] + (14 - rgb[1]) * k) + "," + Math.round(rgb[2] + (21 - rgb[2]) * k) + ")";
    }
    function palFromHex(hex) {
        return { main: hex, light: hex, high: "#ffffff" };
    }
    function hsvRgb(h) {
        const s = 0.85, v = 1;
        const f = (n) => {
            const k = (n + h / 60) % 6;
            return v - v * s * Math.max(Math.min(k, 4 - k, 1), 0);
        };
        return [Math.round(f(5) * 255), Math.round(f(3) * 255), Math.round(f(1) * 255)];
    }
    const GREY_PAL = { main: "#8a90a0", light: "#c5cad6", high: "#f2f4f8" };
    function getVaultSpritesForColor(hex) {
        const key = hex || "grey";
        if (!vaultSpritesTeam[key]) {
            vaultSpritesTeam[key] = makeVaultSprites(hex ? palFromHex(hex) : GREY_PAL);
        }
        return vaultSpritesTeam[key];
    }
    function getVaultSpritesForTeam(team) {
        const key = team === -1 ? "blue" : team === -2 ? "red" : "yellow";
        if (!vaultSpritesTeam[key]) {
            const pal = team === -1 ? BLUE_PAL : team === -2 ? RED_PAL : YELLOW_PAL;
            vaultSpritesTeam[key] = makeVaultSprites(pal);
        }
        return vaultSpritesTeam[key];
    }
    function hsvCss(h) {
        const [r, g, b] = hsvRgb(h);
        return `rgb(${r},${g},${b})`;
    }
    function royaleActive() {
        return !!(global.royale && global.royale.at > 0);
    }
    function royaleMode() {
        // circular from the moment you join, lobby included
        return !!(global.digRoyaleMode || royaleActive());
    }
    function royaleLobbyPhase() {
        return false;
    }
    // Tutorial: the learner's round practice island ({x, y, r}), else null.
    function tutorialIsland() {
        const tp = global.tutorialMode && global.tutorialPlot;
        return tp && tp.island && tp.island.r > 0 ? tp.island : null;
    }
    // Pads drawn the Dig Royale way (grey neutral bases, site colours).
    function royaleLook() {
        return royaleActive() || !!global.tutorialMode;
    }
    function royaleBoardRows() {
        const b = (global.royale && global.royale.board) || [];
        const sort = (global.royaleBoard && global.royaleBoard.sort) || 'score';
        return b.slice().sort((x, y) => {
            if (sort === 'kills') return (y.kills - x.kills) || ((y.score || y.gems) - (x.score || x.gems));
            if (sort === 'gems') return (y.gems - x.gems) || (y.kills - x.kills);
            return ((y.score || y.gems) - (x.score || x.gems)) || (y.kills - x.kills);
        });
    }
    function fmtRaidClock(sec) {
        sec = Math.max(0, sec | 0);
        const h = (sec / 3600) | 0, m = ((sec % 3600) / 60) | 0, s = sec % 60;
        if (h > 0) return h + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
        return m + ":" + String(s).padStart(2, "0");
    }
    // Door art, baked once per colour: rock-purple faces, one ink outline per
    // shape, a hard ink drop; the colour is kept to rim, bolts and gem heart.
    function makeVaultSprites(pal = GOLD_PAL) {
        const S = 256, C = S / 2;
        const INK = "#120e15", LW = 5;
        const GEM = [[-1, -0.38], [-0.55, -0.95], [0.55, -0.95], [1, -0.38], [0, 0.95]];
        const layer = (draw) => {
            const cv = document.createElement("canvas");
            cv.width = cv.height = S;
            const c = cv.getContext("2d");
            c.translate(C, C);
            c.lineJoin = "round";
            c.lineCap = "round";
            draw(c);
            return cv;
        };
        const disc = (c, r, fill, lw = LW, y = 0) => {
            c.beginPath(); c.arc(0, y, r, 0, Math.PI * 2);
            c.fillStyle = fill; c.fill();
            if (lw) { c.lineWidth = lw; c.strokeStyle = INK; c.stroke(); }
        };
        // static base: ink drop, flat plate, coloured rim, recessed well
        const plate = layer((c) => {
            disc(c, S * 0.46, INK, 0, S * 0.024);
            disc(c, S * 0.46, "#3a3245");
            c.lineWidth = S * 0.032; c.strokeStyle = pal.main;
            c.beginPath(); c.arc(0, 0, S * 0.425, 0, Math.PI * 2); c.stroke();
            c.lineWidth = 3; c.strokeStyle = INK;
            c.beginPath(); c.arc(0, 0, S * 0.405, 0, Math.PI * 2); c.stroke();
            disc(c, S * 0.325, "#1e1924");
        });
        // rotating lock ring: a flat purple band with short teeth, every
        // third one in the door colour
        const cog = layer((c) => {
            c.lineWidth = S * 0.045 + LW; c.strokeStyle = INK;
            c.beginPath(); c.arc(0, 0, S * 0.365, 0, Math.PI * 2); c.stroke();
            c.lineWidth = S * 0.045; c.strokeStyle = "#4a4156";
            c.stroke();
            for (let i = 0; i < 12; i++) {
                c.save();
                c.rotate((i / 12) * Math.PI * 2);
                c.beginPath();
                c.rect(S * 0.335, -S * 0.019, S * 0.06, S * 0.038);
                c.fillStyle = i % 3 === 0 ? pal.main : "#6b5f7a";
                c.fill();
                c.lineWidth = 3; c.strokeStyle = INK; c.stroke();
                c.restore();
            }
        });
        // the heart: a gem-cut emblem in the door colour + three handles
        const wheel = layer((c) => {
            const spoke = (w, col) => {
                c.lineWidth = w; c.strokeStyle = col;
                c.beginPath();
                for (let i = 0; i < 3; i++) {
                    const a = (i / 3) * Math.PI * 2 - Math.PI / 2;
                    c.moveTo(Math.cos(a) * S * 0.12, Math.sin(a) * S * 0.12);
                    c.lineTo(Math.cos(a) * S * 0.25, Math.sin(a) * S * 0.25);
                }
                c.stroke();
            };
            spoke(S * 0.045 + LW, INK);
            spoke(S * 0.045, "#6b5f7a");
            const gem = (scale, dy) => {
                c.beginPath();
                GEM.forEach((p, i) => {
                    const px = p[0] * S * scale, py = p[1] * S * scale + dy;
                    i ? c.lineTo(px, py) : c.moveTo(px, py);
                });
                c.closePath();
            };
            gem(0.15, 0); c.fillStyle = pal.main; c.fill();
            c.lineWidth = LW; c.strokeStyle = INK; c.stroke();
            // one flat lighter facet across the crown, like the gem pickups
            c.save();
            gem(0.15, 0); c.clip();
            c.fillStyle = "rgba(255,255,255,0.28)";
            c.fillRect(-S * 0.15, -S * 0.15, S * 0.3, S * 0.085);
            c.restore();
            gem(0.15, 0); c.lineWidth = LW; c.strokeStyle = INK; c.stroke();
        });
        return { plate, cog, wheel };
    }

    let depositVault = null;   // the vault the cash-out effects play on
    // A pad label (screen x, y = its centre line, w wide, size tall) moved clear of
    function padLabelY(lx, ly, w, size) {
        if (selfOver.at < overheadFrame - 2 || !(selfOver.r > 0) || global.died) return ly;
        const r = selfOver.r + 4, hh = size * 0.6;
        if (Math.abs(lx - selfOver.x) > w / 2 + r || Math.abs(ly - selfOver.y) > r + hh) return ly;
        return Math.min(ly, Math.min(selfOver.top, selfOver.y - r) - hh - 6);
    }
    function drawVaults(roomX, roomY, ratio) {
        if (royaleLobbyPhase()) return;
        if (!global.vaults.length) return;
        const now = performance.now();
        const v0 = global.vault;
        const halfW = global.gameWidth / 2, halfH = global.gameHeight / 2;
        const c = ctx[0];
        // The cash-out ring, spin, dust and finish flash belong to the vault
        // you're standing on. global.vault is one state for every pad (a base
        // bank sends the same packets), so without this a deposit at your
        // base, or at one vault, drew its ring inside any other vault on
        // screen.
        if (v0.onPad && !v0.isOutpost) {
            let bd = Infinity, best = null;
            const mx = global.player.renderx, my = global.player.rendery;
            for (const v of global.vaults) {
                const d = (v.x - mx) ** 2 + (v.y - my) ** 2;
                if (d < bd) { bd = d; best = v; }
            }
            if (best && bd < (best.r * 2) ** 2) depositVault = best;
        } else if (!(now - v0.doneAt < 700)) depositVault = null;
        for (const v of global.vaults) {
            const sx = roomX + (v.x + halfW) * ratio;
            const sy = roomY + (v.y + halfH) * ratio;
            const R = v.r * 1.15 * ratio;
            if (sx < -R * 2 || sx > global.screenWidth + R * 2 ||
                sy < -R * 2 || sy > global.screenHeight + R * 2) continue;
            const mine = v === depositVault;
            const depositing = mine && v0.total > 0 && v0.onPad && !v0.isOutpost;
            const doneFlash = mine ? Math.max(0, 1 - (now - v0.doneAt) / 700) : 0;
            // raid vaults (the old "rainbow" ones) are one steady colour: the Banked pill's
            const rainbow = !!v.rainbow;
            const teamCol = rainbow ? BANK_PILL
                : gameDraw.getColor(v.team === -1 ? "blue" : "red");
            const pal = rainbow ? { main: teamCol, light: "#ffffff", high: "#ffffff" }
                : (v.team === -1 ? BLUE_PAL : RED_PAL);
            const doorSprites = rainbow ? getVaultSpritesForColor("#c5cad6")
                : getVaultSpritesForTeam(v.team);

            c.save();
            c.translate(sx, sy);
            c.lineJoin = "round";
            const lw = Math.max(1.5, R * 0.035);
            const hue = hexToRgb(teamCol);
            // octagonal foundation so the vault doesn't read as a tank: ink
            // drop, deep team shade, ink outline, bright rim band for the claim
            polyPath(c, 0, R * 0.07, R * 1.22, 8, Math.PI / 8);
            c.fillStyle = "rgba(0,0,0,0.6)";
            c.fill();
            polyPath(c, 0, 0, R * 1.22, 8, Math.PI / 8);
            c.fillStyle = inkShade(hue, 0.6);
            c.fill();
            c.lineWidth = lw;
            c.strokeStyle = HUD.ink;
            c.stroke();
            const pulse = 0.5 + 0.5 * Math.sin(now / 650);
            polyPath(c, 0, 0, R * 1.11, 8, Math.PI / 8);
            c.globalAlpha = 0.8 + 0.2 * pulse;
            c.lineWidth = Math.max(2, R * 0.065);
            c.strokeStyle = doneFlash > 0 ? HUD.head : teamCol;
            c.stroke();
            c.globalAlpha = 1;

            // door layers: plate static, cog & emblem counter-rotating
            const spin = depositing ? now / 200 : now / 6000;
            c.drawImage(doorSprites.plate, -R, -R, R * 2, R * 2);
            c.save(); c.rotate(spin * 0.7);
            c.drawImage(doorSprites.cog, -R, -R, R * 2, R * 2);
            c.restore();
            c.save(); c.rotate(-spin * 0.4);
            c.drawImage(doorSprites.wheel, -R, -R, R * 2, R * 2);
            c.restore();

            // sparkle: the team heart glints on its own clock
            const sparkT = ((now / 2600 + (v.team === -1 ? 0 : 0.5)) % 1);
            if (sparkT < 0.16) {
                const ga = Math.sin(sparkT / 0.16 * Math.PI);
                const gr = R * 0.10 * ga;
                c.save();
                c.globalAlpha = ga * 0.9;
                c.strokeStyle = pal.high;
                c.lineWidth = Math.max(1.5, gr * 0.3);
                c.beginPath();
                for (let aI = 0; aI < 4; aI++) {
                    const ang = aI * Math.PI / 2 + sparkT * 3;
                    c.moveTo(0, 0);
                    c.lineTo(Math.cos(ang) * gr * (aI % 2 ? 1.6 : 2.6),
                             Math.sin(ang) * gr * (aI % 2 ? 1.6 : 2.6));
                }
                c.stroke();
                c.restore();
            }

            // gold is gem-dust: only while cashing out
            // (the HUD bar bent into a ring: ink keyline, dark track, flat fill)
            if (depositing && v0.total > 0) {
                const frac = Math.max(0, Math.min(1, 1 - v0.remaining / v0.total));
                const bw = Math.max(4, R * 0.085), br = R * 0.96;
                c.beginPath(); c.arc(0, 0, br, 0, Math.PI * 2);
                c.lineWidth = bw + lw * 2; c.strokeStyle = HUD.ink; c.stroke();
                c.lineWidth = bw; c.strokeStyle = HUD.wellSolid; c.stroke();
                if (frac > 0.001) {
                    c.beginPath();
                    c.arc(0, 0, br, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
                    c.lineCap = "round";
                    c.strokeStyle = HUD.gold;
                    c.stroke();
                    c.lineCap = "butt";
                }
            }
            c.restore();

            // deposit dust: gold motes streaming from the player into the
            // vault heart, each ending in a tiny flash
            if (depositing) {
                const px0 = global.screenWidth / 2, py0 = global.screenHeight / 2;
                for (let n = 0; n < 2; n++) {
                    if (vaultDust.length > 70) break;
                    vaultDust.push({
                        x: px0 + (Math.random() - 0.5) * 26,
                        y: py0 + (Math.random() - 0.5) * 26,
                        tx: sx, ty: sy,
                        born: now, life: 420 + Math.random() * 160,
                        bend: (Math.random() - 0.5) * 90,
                        size: 1.6 + Math.random() * 2.2,
                    });
                }
            }
            // the name floats above the door in the HUD's display face
            const vls = Math.max(13, R * 0.28);
            let vly = padLabelY(sx, sy - R * 1.42, hudTitleW("Vault", vls), vls);
            let vla = labelAlpha(sx, vly, 60, 24);
            // under a banner: the name moves below the pad instead of hiding (round 9 bug 4
            if (vla < 1 && !deathCardUp()) {
                const alt = sy + R * 1.3, la2 = labelAlpha(sx, alt, 60, 24);
                if (la2 > vla) { vly = alt; vla = la2; }
            }
            // standing on it: the deposit panel says it, so the name steps aside
            const onThis = global.vault.onPad && !global.vault.isOutpost && Math.hypot(sx - global.screenWidth / 2, sy - global.screenHeight / 2) < R;
            if (!onThis) worldLabel(c, "Vault", sx, vly, vls, HUD.head, 1, 0, hudTitleW("Vault", vls) + 8, vls + 6);

            if (doneFlash > 0) {
                // completion burst: one-off ring of gold sparks
                if (!v0._burstDone) {
                    v0._burstDone = true;
                    for (let n = 0; n < 22; n++) {
                        const a = (n / 22) * Math.PI * 2;
                        vaultDust.push({
                            burst: true,
                            x: sx, y: sy,
                            vx: Math.cos(a) * (2 + Math.random() * 2.5),
                            vy: Math.sin(a) * (2 + Math.random() * 2.5),
                            born: now, life: 500 + Math.random() * 200,
                            size: 2 + Math.random() * 2,
                        });
                    }
                }
            } else if (mine) v0._burstDone = false;
        }

        if (vaultDust.length) {
            c.save();
            for (let i = vaultDust.length - 1; i >= 0; i--) {
                const d = vaultDust[i];
                const t = (now - d.born) / d.life;
                if (t >= 1) { vaultDust.splice(i, 1); continue; }
                let dx, dy, a;
                if (d.burst) {
                    dx = d.x + d.vx * (now - d.born) / 16;
                    dy = d.y + d.vy * (now - d.born) / 16;
                    a = 1 - t;
                } else {
                    const e = t * t * (3 - 2 * t); // smoothstep glide
                    const mx = (d.x + d.tx) / 2 - (d.ty - d.y) * 0.002 * d.bend;
                    const my = (d.y + d.ty) / 2 + (d.tx - d.x) * 0.002 * d.bend;
                    const u = 1 - e;
                    dx = u * u * d.x + 2 * u * e * mx + e * e * d.tx;
                    dy = u * u * d.y + 2 * u * e * my + e * e * d.ty;
                    a = t > 0.85 ? (1 - t) / 0.15 : 1;
                }
                c.globalAlpha = a;
                c.fillStyle = t > 0.9 ? "#fff6d8" : "#ffd75e";
                c.beginPath();
                c.arc(dx, dy, d.size * (1 - t * 0.4), 0, Math.PI * 2);
                c.fill();
            }
            c.globalAlpha = 1;
            c.restore();
        }
    }

    // Dig Wars: outpost pads, octagonal foundations styled like the vault.
    // Grey while neutral, ringed in the owner's colour once a banner stands.
    // A gold arc shows capture progress on a contested neutral pad.
    function drawOutposts(roomX, roomY, ratio) {
        if (royaleLobbyPhase()) return;
        if (!global.outposts.length) return;
        const now = performance.now();
        const halfW = global.gameWidth / 2, halfH = global.gameHeight / 2;
        const c = ctx[0];
        for (const o of global.outposts) {
            const st = global.outpostState.find(s => s.id === o.id) || {};
            const sx = roomX + (o.x + halfW) * ratio;
            const sy = roomY + (o.y + halfH) * ratio;
            const R = o.r * ratio;
            if (sx < -R * 2 || sx > global.screenWidth + R * 2 ||
                sy < -R * 2 || sy > global.screenHeight + R * 2) continue;
            const ownCol = (st.o && st.c) ? st.c
                        : st.t === -1 ? gameDraw.getColor("blue")
                        : st.t === -2 ? gameDraw.getColor("red")
                        : "#8a90a0";
            // body colour: team blue/red, or the site's colour once owned in
            // Royale; neutral is grey
            const bodyCol = (st.o && st.c) ? st.c
                         : st.t === -1 ? gameDraw.getColor("blue")
                         : st.t === -2 ? gameDraw.getColor("red")
                         : (royaleLook() ? "#8a90a0" : gameDraw.getColor("yellow"));
            c.save();
            c.translate(sx, sy);
            c.lineJoin = "round";
            // vault plate style: ink drop, deep claim shade, outline, rim band
            const lw = Math.max(1.5, R * 0.035);
            const band = Math.max(2, R * 0.065);
            const pulse = 0.5 + 0.5 * Math.sin(now / 650 + o.id);
            const claimed = !!(st.t || st.h);
            const hue = hexToRgb(claimed ? bodyCol : ownCol);
            if (claimed) {
                // the structure: the octagon on the pad (matches the banner
                // entity's realSize). The banner entity itself is suppressed
                // in drawEntities so players render on top of the outpost.
                const bodyR = R * 1.33;
                const tgtH = Math.max(0, Math.min(1, st.h || 0));
                if (o._smoothH === undefined) o._smoothH = tgtH;
                o._smoothH += (tgtH - o._smoothH) * 0.12;
                const frac = o._smoothH;
                polyPath(c, 0, R * 0.08, bodyR, 8, 0);
                c.fillStyle = "rgba(0,0,0,0.6)";
                c.fill();
                polyPath(c, 0, 0, bodyR, 8, 0);
                c.fillStyle = inkShade(hue, 0.6);
                c.fill();
                c.lineWidth = lw; c.strokeStyle = HUD.ink; c.stroke();
                polyPath(c, 0, 0, bodyR * 0.915, 8, 0);
                c.globalAlpha = 0.8 + 0.2 * pulse;
                c.lineWidth = band; c.strokeStyle = bodyCol; c.stroke();
                c.globalAlpha = 1;
                // the pad it stands on, one step down
                polyPath(c, 0, 0, R * 1.02, 8, Math.PI / 8);
                c.fillStyle = inkShade(hue, 0.74);
                c.fill();
                c.lineWidth = lw; c.strokeStyle = HUD.ink; c.stroke();
                // banner HP: the HUD bar bent into a ring round the structure
                // (ink keyline, dark track, flat cream fill)
                const ringR = bodyR * 1.1, bw = Math.max(4, R * 0.085);
                c.beginPath(); c.arc(0, 0, ringR, 0, Math.PI * 2);
                c.lineWidth = bw + lw * 2; c.strokeStyle = HUD.ink; c.stroke();
                c.lineWidth = bw; c.strokeStyle = HUD.wellSolid; c.stroke();
                if (frac > 0.001) {
                    c.beginPath();
                    c.arc(0, 0, ringR, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
                    c.lineCap = "round"; c.strokeStyle = HUD.head; c.stroke();
                    c.lineCap = "butt";
                }
            } else {
                // neutral pad: the same plate, grey (or the site colour)
                polyPath(c, 0, R * 0.07, R * 1.08, 8, Math.PI / 8);
                c.fillStyle = "rgba(0,0,0,0.6)";
                c.fill();
                polyPath(c, 0, 0, R * 1.08, 8, Math.PI / 8);
                c.fillStyle = inkShade(hue, 0.6);
                c.fill();
                c.lineWidth = lw; c.strokeStyle = HUD.ink; c.stroke();
                polyPath(c, 0, 0, R * 0.97, 8, Math.PI / 8);
                c.globalAlpha = 0.55 + 0.2 * pulse;
                c.lineWidth = band; c.strokeStyle = ownCol; c.stroke();
                c.globalAlpha = 1;
            }
            c.restore();
            // conquest blast: on an ownership change, a double shockwave in
            // the new owner's colour
            if (o._lastTeam === undefined) o._lastTeam = st.t;
            if (st.t !== o._lastTeam) {
                o._lastTeam = st.t;
                if (st.t) o._blastAt = now;           // captured (not the fall to grey)
            }
            if (o._blastAt && now - o._blastAt < 1200) {
                const t = (now - o._blastAt) / 1200;
                const eo = 1 - Math.pow(1 - t, 3);
                const a = Math.pow(1 - t, 1.4);
                // two shockwave bands (cream lead with an ink keyline, owner
                // colour behind) and a ring of flat sparks
                c.save();
                for (let ring = 1; ring >= 0; ring--) {
                    const rt = Math.max(0, eo - ring * 0.14);
                    if (rt <= 0) continue;
                    const w = Math.max(2, R * (0.12 - ring * 0.04) * (1 - t));
                    c.beginPath();
                    c.arc(sx, sy, R * (0.5 + 3.0 * rt), 0, Math.PI * 2);
                    c.globalAlpha = a * (ring === 0 ? 0.9 : 0.6);
                    if (ring === 0) { c.lineWidth = w + 3; c.strokeStyle = HUD.ink; c.stroke(); }
                    c.lineWidth = w;
                    c.strokeStyle = ring === 0 ? HUD.head : ownCol;
                    c.stroke();
                }
                const sz = Math.max(1.5, R * 0.06 * (1 - t * 0.7));
                const rr = R * (0.4 + 2.8 * eo);
                for (let i = 0; i < 22; i++) {
                    const ang = (i / 22) * Math.PI * 2 + o.id;
                    c.globalAlpha = a * (0.7 + 0.3 * Math.sin(i * 1.7));
                    c.fillStyle = i % 4 === 0 ? HUD.head : ownCol;
                    c.beginPath();
                    c.arc(sx + Math.cos(ang) * rr, sy + Math.sin(ang) * rr, sz, 0, Math.PI * 2);
                    c.fill();
                }
                c.restore();
            }
        }
    }

    // Outpost vault doors: the base vault art on top of the octagon,
    // recoloured for the owner. Drawn on the background layer so players
    // appear on top of the outpost.
    function drawOutpostDoors(px, py, ratio) {
        if (royaleLobbyPhase()) return;
        if (!global.outposts.length) return;
        const now = performance.now();
        const halfW = global.gameWidth / 2, halfH = global.gameHeight / 2;
        const roomX = -px + global.screenWidth / 2 - ratio * global.gameWidth / 2;
        const roomY = -py + global.screenHeight / 2 - ratio * global.gameHeight / 2;
        const c = ctx[0];   // drawn on the background layer so players stay on top
        for (const o of global.outposts) {
            const st = global.outpostState.find(s => s.id === o.id) || {};
            const sx = roomX + (o.x + halfW) * ratio;
            const sy = roomY + (o.y + halfH) * ratio;
            const R = o.r * 0.92 * ratio;
            if (sx < -R * 3 || sx > global.screenWidth + R * 3 ||
                sy < -R * 3 || sy > global.screenHeight + R * 3) continue;
            const ownCol = (st.o && st.c) ? st.c
                        : st.t === -1 ? gameDraw.getColor("blue")
                        : st.t === -2 ? gameDraw.getColor("red")
                        : (royaleActive() ? "#8a90a0" : gameDraw.getColor("yellow"));
            c.save();
            c.translate(sx, sy);
            // the base vaults' three door layers, recoloured for the owner
            // (or the site colour / grey in Royale); the claim colour lives
            // on the pad's rim band
            const doorSprites = (st.o && st.c)
                ? getVaultSpritesForColor(st.c)
                : (royaleActive() && !st.o ? getVaultSpritesForColor(null) : getVaultSpritesForTeam(st.t));
            const spin = now / 2200;
            c.drawImage(doorSprites.plate, -R, -R, R * 2, R * 2);
            c.save(); c.rotate(spin * 0.7);
            c.drawImage(doorSprites.cog, -R, -R, R * 2, R * 2);
            c.restore();
            c.save(); c.rotate(-spin * 0.5);
            c.drawImage(doorSprites.wheel, -R, -R, R * 2, R * 2);
            c.restore();
            c.restore();
        }
    }

    // ── Core chamber rock art ───────────────────────────────────────────────
    // A plain octagon on the floor layer; the treasury gems are real entities
    // drawn on top. Rotation is seeded per chamber (id + site), and the shape
    // is built in unit space and scaled at draw time so zoom never
    // invalidates the cache.
    // Art caches are keyed to the chamber list signature (ids recycle between
    // maps, so the whole cache drops whenever the sites change).
    const chamberArt = { sig: "", rock: new Map() };
    // the drawn ring's hollow inner edge (world units) - must match
    // CHAMBER_INNER in server/game/terrain/coreChambers.js
    const CHAMBER_INNER = 148;
    const CHAMBER_SIDES = 15;

    function chamberHash(id, x, y) {
        const base = (Math.imul(id + 1013, 2654435761) +
                      Math.imul(Math.round(x), 40503) +
                      Math.imul(Math.round(y), 45131)) >>> 0;
        return (i, s) => {
            let n = (base + Math.imul(i + 1, 374761393) + Math.imul(s + 7, 668265263)) >>> 0;
            n = Math.imul(n ^ (n >>> 13), 1274126177) >>> 0;
            return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
        };
    }

    // Geometry is cached once per site as unit-space Path2Ds and scaled at
    // draw time: crisp at any zoom, and only the wall pixels are touched (a
    // 512px sprite blit costs ~3.2ms/frame on a software canvas; this ~0.1ms).
    function makeChamberArt(h) {
        const inRu = CHAMBER_INNER / 160;         // hollow inner edge, unit space
        const wu = 1 - inRu;                      // wall thickness, unit space
        const rot = (h(0, 110) - 0.5) * 0.6;
        const midR = (1 + inRu) / 2;
        const ang = i => (i / CHAMBER_SIDES) * Math.PI * 2 + rot;

        const ngon = r => {
            const p = new Path2D();
            for (let i = 0; i < CHAMBER_SIDES; i++) {
                const a = ang(i), x = Math.cos(a) * r, y = Math.sin(a) * r;
                if (i) p.lineTo(x, y); else p.moveTo(x, y);
            }
            p.closePath();
            return p;
        };
        const outer = ngon(1), inner = ngon(inRu);
        const ring = new Path2D();
        ring.addPath(outer); ring.addPath(inner);

        // bold team plate across each wall face
        const plates = new Path2D();
        for (let i = 0; i < CHAMBER_SIDES; i++) {
            const a0 = ang(i), a1 = ang(i + 1);
            const x0 = Math.cos(a0) * midR, y0 = Math.sin(a0) * midR;
            const x1 = Math.cos(a1) * midR, y1 = Math.sin(a1) * midR;
            plates.moveTo(x0 + (x1 - x0) * 0.2, y0 + (y1 - y0) * 0.2);
            plates.lineTo(x0 + (x1 - x0) * 0.8, y0 + (y1 - y0) * 0.8);
        }
        // stud bolt on every corner
        const studs = new Path2D();
        for (let i = 0; i < CHAMBER_SIDES; i++) {
            const a = ang(i), x = Math.cos(a) * midR, y = Math.sin(a) * midR;
            studs.moveTo(x + wu * 0.44, y);
            studs.arc(x, y, wu * 0.44, 0, Math.PI * 2);
        }
        // buttress spokes standing on the floor inside the wall
        const spokes = new Path2D();
        for (let i = 0; i < CHAMBER_SIDES; i++) {
            const a = ang(i) + Math.PI / CHAMBER_SIDES;
            const ca = Math.cos(a), sa = Math.sin(a);
            spokes.moveTo(ca * inRu, sa * inRu);
            spokes.lineTo(ca * inRu * 0.55, sa * inRu * 0.55);
        }
        return { outer, inner, ring, plates, studs, spokes, wu, inRu };
    }

    function drawChambers(roomX, roomY, ratio) {
        if (!global.chambers.length) return;
        const halfW = global.gameWidth / 2, halfH = global.gameHeight / 2;
        const c = ctx[0];   // BACKGROUND layer - players and gems stay on top
        // chamber ids recycle between maps: drop the cache when sites change
        const sig = global.chambers.map(ch => ch.id + "@" + ch.x + "," + ch.y + "," + ch.team).join("|");
        if (sig !== chamberArt.sig) {
            chamberArt.sig = sig;
            chamberArt.rock.clear();
        }
        for (const ch of global.chambers) {
            const st = global.chamberState.find(s => s.id === ch.id) || {};
            const sx = roomX + (ch.x + halfW) * ratio;
            const sy = roomY + (ch.y + halfH) * ratio;
            const R = ch.r * ratio;
            if (sx < -R * 2 || sx > global.screenWidth + R * 2 ||
                sy < -R * 2 || sy > global.screenHeight + R * 2) continue;
            const teamCol = ch.team === -1 ? gameDraw.getColor("blue") : gameDraw.getColor("red");
            // before the first CC broadcast lands, assume the boulder is up
            const mode = st.st === undefined ? 0 : st.st;
            const alive = mode === 0;
            const regrowing = mode === 2;
            const scale = regrowing ? Math.max(0.05, st.s || 0.05) : 1;
            const h = chamberHash(ch.id, ch.x, ch.y);

            let art = chamberArt.rock.get(ch.id);
            if (!art) {
                art = makeChamberArt(h);
                chamberArt.rock.set(ch.id, art);
            }
            // Unit-space paths scaled into place (line widths too). The empty
            // pocket is the same art ghosted, and the regrowing ring is it
            // scaled up from nothing, so no state needs its own geometry.
            const wu = art.wu;
            const s = R * scale;
            c.save();
            c.translate(sx, sy);
            c.scale(s, s);
            c.globalAlpha = mode === 1 ? 0.16 : (regrowing ? 0.6 : 1);
            const a0 = c.globalAlpha;

            c.globalAlpha = a0 * 0.18;                 // floor tint
            c.fillStyle = teamCol;
            c.fill(art.inner);
            c.strokeStyle = teamCol;                    // buttress spokes
            c.lineWidth = wu * 0.34;
            c.stroke(art.spokes);

            c.globalAlpha = a0;                        // the wall, flat
            c.fillStyle = "#23262d";
            c.fill(art.ring, "evenodd");
            c.strokeStyle = "#111318";
            c.lineWidth = wu * 0.5;
            c.stroke(art.outer);
            c.strokeStyle = "#16181d";
            c.lineWidth = wu * 0.34;
            c.stroke(art.inner);

            c.globalAlpha = a0 * 0.92;                 // team plates
            c.strokeStyle = teamCol;
            c.lineWidth = wu * 0.52;
            c.stroke(art.plates);

            c.globalAlpha = a0;                        // stud bolts
            c.fillStyle = teamCol;
            c.fill(art.studs);
            c.strokeStyle = "#111318";
            c.lineWidth = wu * 0.22;
            c.stroke(art.studs);
            c.restore();
            if (mode === 1) continue;

            // Per-frame layer: a breathing ring in the owner's colour and arc
            // segments orbiting the wall.
            const now = performance.now();
            const inRpx = R * scale * (CHAMBER_INNER / 160);
            const pulse = 0.5 + 0.5 * Math.sin(now / 700 + ch.id);
            c.save();
            c.translate(sx, sy);
            c.lineCap = "round";
            c.globalAlpha = (0.5 + 0.25 * pulse) * (regrowing ? 0.5 : 1);
            c.lineWidth = Math.max(2.5, R * 0.05);
            c.strokeStyle = teamCol;
            c.beginPath(); c.arc(0, 0, inRpx * 0.94, 0, Math.PI * 2); c.stroke();
            // integrity ring, same as the outpost's capture ring: dark track,
            // white arc for remaining health
            if (alive && st.h !== undefined) {
                const ringR = R * scale * 1.07;
                c.globalAlpha = 0.22;
                c.strokeStyle = "#000000";
                c.lineWidth = Math.max(3, R * 0.05);
                c.beginPath(); c.arc(0, 0, ringR, 0, Math.PI * 2); c.stroke();
                if (st.h > 0.001) {
                    c.globalAlpha = 0.85;
                    c.strokeStyle = "#ffffff";
                    c.beginPath();
                    c.arc(0, 0, ringR, -Math.PI / 2, -Math.PI / 2 + st.h * Math.PI * 2);
                    c.stroke();
                }
            }
            c.rotate(now / 5200 + ch.id);
            c.globalAlpha = (0.42 + 0.2 * pulse) * (regrowing ? 0.5 : 1);
            c.lineWidth = Math.max(2, R * 0.036);
            c.strokeStyle = teamCol;
            for (let i = 0; i < 6; i++) {
                const a = (i / 6) * Math.PI * 2;
                c.beginPath();
                c.arc(0, 0, inRpx * 1.16, a - 0.13, a + 0.13);
                c.stroke();
            }
            c.restore();

            // HP bar: below the boulder, filled with the owning team's color
            // (hidden while the pocket is empty or the ring is still forming)
            if (alive && st.h !== undefined && st.h > 0.003) {
                const barW = R * 1.05, barH = Math.max(5, R * 0.08);
                const barY = R * scale + barH * 2.2;
                const rr = barH / 2;
                const cap = (x, y, w, hh, r) => {
                    c.beginPath();
                    c.moveTo(x + r, y);
                    c.arcTo(x + w, y, x + w, y + hh, r);
                    c.arcTo(x + w, y + hh, x, y + hh, r);
                    c.arcTo(x, y + hh, x, y, r);
                    c.arcTo(x, y, x + w, y, r);
                    c.closePath();
                };
                cap(sx - barW / 2, sy + barY, barW, barH, rr);
                c.fillStyle = "rgba(12,13,17,0.82)";
                c.fill();
                c.lineWidth = Math.max(1.5, barH * 0.3);
                c.strokeStyle = "#16181d";
                c.stroke();
                if (st.h > 0.02) {
                    const iw = (barW - barH * 0.5) * st.h;
                    cap(sx - barW / 2 + barH * 0.25, sy + barY + barH * 0.25,
                        iw, barH * 0.5, barH * 0.25);
                    c.fillStyle = teamCol;
                    c.fill();
                }
            }
        }
    }

    let teamBankTold = false;
    let teamBankTip = null;   // pending/showing Team Bank tip (drawHudNotes)
    function drawOutpostLabels(px, py, ratio) {
        if (royaleLobbyPhase()) return;
        const c = ctx[2];
        for (const o of global.outposts) {
            const sx = -px + global.screenWidth / 2 + ratio * (o.x);
            const sy = -py + global.screenHeight / 2 + ratio * (o.y);
            const R = o.r * ratio;
            if (sx < -R * 2 || sx > global.screenWidth + R * 2 ||
                sy < -R * 2 || sy > global.screenHeight + R * 2) continue;
            const st = global.outpostState.find(s => s.id === o.id) || {};
            // round 12: the first Team Bank you come near says what it is, once
            if (!teamBankTold && royaleActive() && !global.died && !global.tutorialMode &&
                Math.hypot(sx - global.screenWidth / 2, sy - global.screenHeight / 2) < buildBtnLabels.TEAM_BANK_NEAR * ratio) {
                teamBankTold = true;
                // Oct 6 2026: it used to be a toast that sat on the spawn goal line; it
                // waits for the drop-in intro and then takes a row in the note stack
                if (buildBtnLabels.firstTime("teamBank", () => window.localStorage)) teamBankTip = { shownAt: 0 };
            }
            // name in the HUD display face, just above the HP ring of a
            // standing structure, else above the bare pad
            const fs = Math.min(30, Math.max(13, R * 0.4));
            const top = (st.t || st.h) ? R * 1.33 * 1.1 + Math.max(4, R * 0.085) : R * 1.08;
            const ty = sy - top - fs * 0.5 - Math.max(6, R * 0.12);
            worldLabel(c, o.name, sx, ty, fs, o.color || st.c || HUD.head, 1, 1, fs * o.name.length * 0.55, fs * 1.4);
            // contested: callout + the banner's remaining HP, shown to both sides
            if (st.cont && (st.h || 0) < 0.5) {
                const blink = 0.65 + 0.35 * Math.sin(performance.now() / 240);
                const as = Math.min(22, Math.max(11, R * 0.28));
                const bw2 = Math.min(110, R), bh2 = 8, by2 = ty - fs * 0.5 - 8 - bh2;
                hudTitle("UNDER ATTACK", sx, by2 - 6 - as * 0.5, as, "#ff6b5e", "center", blink, c);
                c.save();
                c.globalAlpha = blink;
                hudBar(c, sx - bw2 / 2, by2, bw2, bh2, st.h || 0, HUD.danger);
                c.restore();
            }
            if (royaleActive() && st.l > 0) {
                hudTitle(st.l + "s", sx, sy + R * 1.05,
                         Math.min(20, Math.max(11, R * 0.26)),
                         st.c || HUD.head, "center", 1, c);
            }
        }
        // core chamber names, only once the ring is fully regrown (st.st === 0)
        for (const ch of global.chambers) {
            const st = global.chamberState.find(s => s.id === ch.id) || {};
            if (st.st !== undefined && st.st !== 0) continue;
            const sx = -px + global.screenWidth / 2 + ratio * (ch.x);
            const sy = -py + global.screenHeight / 2 + ratio * (ch.y);
            const R = ch.r * ratio;
            if (sx < -R * 2 || sx > global.screenWidth + R * 2 ||
                sy < -R * 2 || sy > global.screenHeight + R * 2) continue;
            // outpost-style label in the owner's colour, above the integrity ring
            const labelSize = Math.min(32, ch.r * ratio * 0.3);
            drawText(ch.name, sx, sy - ch.r * ratio * 1.07 - labelSize * 1.5,
                     labelSize,
                     ch.team === -1 ? gameDraw.getColor("blue") : gameDraw.getColor("red"),
                     "center", false, 1, true, c);
        }
    }

    // one reused object: this runs several times a frame
    const stormView = { a: 0, cx: 0, cy: 0, tx: 0, ty: 0, r: 0, max: 0, to: 0, fin: 0, hold: 0 };
    function stormSnap() {
        const s = aoHud.stormView() || (global.royale && global.royale.storm);
        if (!s || !s.a) return null;
        // RY lands every 500ms but n predicts +250ms. Extrapolate past t=1 at
        // the same rate so the edge moves continuously (clamping at 1 makes it
        // stutter); the cap only guards stalls.
        const t = s.n == null ? 0 : Math.min(4, Math.max(0, (performance.now() - global.royale.at) / 250));
        const v = stormView;
        v.a = s.a; v.max = s.max || 0; v.to = s.to || 0; v.fin = s.fin || 0; v.hold = s.hold || 0;
        v.r = (s.r || 0) + (s.n == null ? 0 : ((s.n || s.r) - s.r) * t);
        // the centre slides too (each cycle opens on the rock circle, then closes toward
        const cx0 = s.cx || 0, cy0 = s.cy || 0;
        v.cx = s.nx == null ? cx0 : cx0 + (s.nx - cx0) * t;
        v.cy = s.ny == null ? cy0 : cy0 + (s.ny - cy0) * t;
        v.tx = s.tx == null ? v.cx : s.tx; v.ty = s.ty == null ? v.cy : s.ty;
        v.out = s.out || 0;
        return v;
    }
    function fillStormOnMap(c, mapX, mapY, scale, x, y, w, h) {
        const s = stormSnap();
        if (!s) return;
        const cx = mapX(s.cx || 0), cy = mapY(s.cy || 0);
        const rr = Math.max(2, (s.r || 0) * scale);
        if (s.out > 0) { c.save(); c.beginPath(); c.arc(cx, cy, Math.max(rr, s.out * scale), 0, Math.PI * 2); c.clip(); }
        stormFx.drawMap(c, cx, cy, rr, x, y, w, h, (s.to || 0) * scale, safeZoneJob(), mapX(s.tx), mapY(s.ty));
        if (s.out > 0) c.restore();
    }
    function playerInStorm() {
        const s = stormSnap();
        if (!s) return false;
        const px = global.player.renderx, py = global.player.rendery;
        const dx = px - (s.cx || 0), dy = py - (s.cy || 0);
        if (s.out > 0 && dx * dx + dy * dy > s.out * s.out) return false;
        return dx * dx + dy * dy > (s.r || 0) * (s.r || 0);
    }
    function strokeStormCircle(c, mapX, mapY, scale, x, y, w, h) {
        if (x == null) return;
        fillStormOnMap(c, mapX, mapY, scale, x, y, w, h);
    }
    function drawStorm(roomX, roomY, ratio) {
        const s = stormSnap();
        if (!s) return;
        const halfW = global.gameWidth / 2, halfH = global.gameHeight / 2;
        const ox = roomX + halfW * ratio, oy = roomY + halfH * ratio;
        const rr = Math.max(0, s.r * ratio);
        if (s.out > 0) { ctx[0].save(); ctx[0].beginPath(); ctx[0].arc(ox + s.cx * ratio, oy + s.cy * ratio, Math.max(rr, s.out * ratio), 0, Math.PI * 2); ctx[0].clip(); }
        stormFx.drawWorld(ctx[0], ox + s.cx * ratio, oy + s.cy * ratio, rr, ox, oy, ratio, global.screenWidth, global.screenHeight);
        if (s.out > 0) ctx[0].restore();
        // the safe-zone job: the whole edge lights up
        if (safeZoneJob()) stormFx.drawSafeZone(ctx[0], ox + s.cx * ratio, oy + s.cy * ratio, rr, ratio, global.screenWidth, global.screenHeight);
    }
    function safeZoneJob() {
        const r = global.royale;
        const ob = !global.died && r && r.you && r.you.obj;
        return !!(ob && ob.k === "zone" && ob.st === 0);
    }

    function drawFloor(px, py, ratio, tick) {

        // out-of-bounds void: even darker than the cavern floor
        clearScreen("#0d0d0c", 1, ctx[0]);

        let gameWidth = global.gameWidth = global.player.roomAnim.x.get(tick);
        let gameHeight = global.gameHeight = global.player.roomAnim.y.get(tick);

        ctx[0].globalAlpha = 1;
        // room base = the dirt tile's ground colour, so a failed pattern
        // still leaves a dark floor
        ctx[0].fillStyle = "#282624";

        let roomX = -px + global.screenWidth / 2 - ratio * gameWidth / 2,
            roomY = -py + global.screenHeight / 2 - ratio * gameHeight / 2,
            roomWidth = ratio * gameWidth,
            roomHeight = ratio * gameHeight;
        // Circular dirt island for round maps and dig royale (lobby
        // included). The dirt is clipped to a circle, but the rocks draw
        // unclipped after the restore below, so rim rocks are never sliced.
        const circleClip = global.advanced.roundMap || royaleMode();
        if (circleClip) {
            ctx[0].save();
            ctx[0].beginPath();
            ctx[0].arc(
                -px + global.screenWidth / 2 - (ratio * gameWidth) * 0,
                -py + global.screenHeight / 2 - (ratio * gameHeight) * 0,
                (ratio * global.gameWidth) / 2,
                0,
                Math.PI * 2
            );
            ctx[0].clip();
        }
        // Tutorial: dirt on the learner's round island only, void around it,
        // like a small copy of the raid map. Rim rocks overhang it unclipped.
        const island = tutorialIsland();
        if (island) {
            if (!floorPattern) floorPattern = makeFloorPattern(ctx[0]);
            ctx[0].save();
            ctx[0].translate(roomX + roomWidth / 2, roomY + roomHeight / 2);
            ctx[0].scale(ratio, ratio);
            ctx[0].beginPath();
            ctx[0].arc(island.x, island.y, island.r + 40, 0, Math.PI * 2);
            ctx[0].fillStyle = "#282624";
            ctx[0].fill();
            ctx[0].fillStyle = floorPattern;
            ctx[0].fill();
            ctx[0].restore();
        }
        // Square dirt base for normal modes. Royale paints its dirt under
        // the rocks only (below), leaving void at the raw rock edge.
        if (!island && (!royaleMode() || !getMapPaths())) ctx[0].fillRect(roomX, roomY, roomWidth, roomHeight);
        // Cavern floor: the dirt tile repeated, anchored to world coordinates
        // and scaled with the camera. Only the visible slice of the room is
        // pattern-filled.
        // Royale island: dirt lives only under the rocks (their combined
        // path), so the void starts exactly at the rocks' raw edge.
        if (royaleMode()) {
            const islPaths = getMapPaths();
            if (islPaths) {
                if (!floorPattern) floorPattern = makeFloorPattern(ctx[0]);
                ctx[0].save();
                ctx[0].translate(roomX + roomWidth / 2, roomY + roomHeight / 2);
                ctx[0].scale(ratio, ratio);
                ctx[0].fillStyle = "#282624";
                ctx[0].fill(islPaths.alive);
                ctx[0].fill(islPaths.dead);
                ctx[0].fillStyle = floorPattern;
                ctx[0].fill(islPaths.alive);
                ctx[0].fill(islPaths.dead);
                ctx[0].restore();
            }
        }
        if (!floorPattern) floorPattern = makeFloorPattern(ctx[0]);
        if (!island && (!royaleMode() || !getMapPaths())) {
            const vx0 = Math.max(roomX, 0), vy0 = Math.max(roomY, 0);
            const vx1 = Math.min(roomX + roomWidth, global.screenWidth);
            const vy1 = Math.min(roomY + roomHeight, global.screenHeight);
            if (vx1 > vx0 && vy1 > vy0) {
                ctx[0].save();
                ctx[0].translate(roomX, roomY);
                ctx[0].scale(ratio, ratio);
                ctx[0].fillStyle = floorPattern;
                ctx[0].fillRect((vx0 - roomX) / ratio, (vy0 - roomY) / ratio,
                                (vx1 - vx0) / ratio, (vy1 - vy0) / ratio);
                ctx[0].restore();
            }
        }
        if (global.roomSetup.length) {
            let W = global.roomSetup[0].length,
                H = global.roomSetup.length;

            for (let f = 0; f < H; f++) {
                let e = global.roomSetup[f];
                for (let h = 0; h < W; h++) {
                    let tile = e[h];
                    let top = ratio * h * gameWidth / W - px + global.screenWidth / 2 - ratio * gameWidth / 2,
                        bottom = ratio * f * gameHeight / H - py + global.screenHeight / 2 - ratio * gameHeight / 2,
                        left = ratio * (h + 1) * gameWidth / W - px + global.screenWidth / 2 - ratio * gameWidth / 2,
                        right = ratio * (f + 1) * gameHeight / H - py + global.screenHeight / 2 - ratio * gameHeight / 2;
                    if (tile.image) {
                        ctx[0].globalAlpha = 1;
                        if (!tile.renderImage) {
                            tile.renderImage = new Image();
                            tile.renderImage.src = `img/${tile.image}`;
                            tile.renderImage.onerror = () => {
                                console.warn(`Failed to get ${tile.image}! If you are the developer of this game, make sure that you typed the path correctly. Using unknown image.`)
                                tile.renderImage.src = `img/missingno.png`;
                            }
                        };
                        ctx[0].drawImage(tile.renderImage, top, bottom, left - top, right - bottom);
                    }

                    ctx[0].globalAlpha = 0.3;
                    if (tile.color == 'none') tile.color = 'border';
                    let tileColor = gameDraw.getColor(tile.color, true);
                    // team floors are deep, saturated tints; structures on
                    // top wear a brighter team colour
                    let tintAlpha = 0.3;
                    if (tile.color === "blue") {
                        try { tileColor = gameDraw.mixColors(tileColor, "#1a46c8", 0.62); } catch (e) { /* keep */ }
                        tintAlpha = 0.52;
                    } else if (tile.color === "red") {
                        try { tileColor = gameDraw.mixColors(tileColor, "#c31828", 0.55); } catch (e) { /* keep */ }
                        tintAlpha = 0.48;
                    }

                    if (tileColor !== color.white) {
                        // bases/nests keep the stock light floor under the
                        // tint: bright islands in the dark cavern dirt
                        ctx[0].globalAlpha = 1;
                        ctx[0].fillStyle = color.white;
                        ctx[0].fillRect(top, bottom, left - top, right - bottom);
                        ctx[0].globalAlpha = tintAlpha;
                        ctx[0].fillStyle = tileColor;
                        ctx[0].fillRect(top, bottom, left - top, right - bottom);
                    }
                }
            }
        }
        let gridsize = 30 * ratio;
        if (config.graphical.showGrid && 2.5 < gridsize) {
            ctx[0].save();
            ctx[0].lineWidth = ratio;
            // light grid lines - dark ones vanish on the cavern floor
            ctx[0].strokeStyle = "#ffffff";
            ctx[0].globalAlpha = 0.035;
            ctx[0].beginPath();
            for (let x = (global.screenWidth / 2 - px) % gridsize; x < global.screenWidth; x += gridsize) {
                ctx[0].moveTo(x, 0);
                ctx[0].lineTo(x, global.screenHeight);
            }
            for (let y = (global.screenHeight / 2 - py) % gridsize; y < global.screenHeight; y += gridsize) {
                ctx[0].moveTo(0, y);
                ctx[0].lineTo(global.screenWidth, y);
            }
            ctx[0].stroke();
            ctx[0].globalAlpha = 1;
            ctx[0].restore();
        }
        // Unclip for the rocks: the dirt is a perfect circle, the rocks are
        // raw and overhang it. Round (non-royale) maps keep the clip.
        if (royaleMode() && circleClip) ctx[0].restore();
        // the rock wall first; vaults and outposts sit on top of it
        if (window.terrainRenderer && window.terrainRenderer.ready) {
            // near-opaque: a lighter wash melts into the dark cavern floor
            ctx[0].globalAlpha = 0.9;
            window.terrainRenderer.draw(ctx[0], px, py, ratio, gameWidth, gameHeight, global.screenWidth, global.screenHeight);
        }
        if (circleClip && !royaleMode()) ctx[0].restore();
        ctx[0].globalAlpha = 1;
        drawBloomGlow(roomX, roomY, ratio);
        drawEventZone(roomX, roomY, ratio);
        drawChestGlow(roomX, roomY, ratio);
        drawStorm(roomX, roomY, ratio);
        // Dig Wars: team vault doors, set into the base floors
        drawVaults(roomX, roomY, ratio);
        drawShops(roomX, roomY, ratio);
        // Dig Wars: forward outpost pads, carved into the wall
        drawOutposts(roomX, roomY, ratio);
        // Dig Wars: core chambers (treasury gems are entities drawn on top)
        drawChambers(roomX, roomY, ratio);
        // outpost doors, on the floor layer so players render on top
        drawOutpostDoors(px, py, ratio);
    }

    // Dig Wars: the outpost structure is a real server entity (its HP drives
    // capture combat), but it is drawn entirely by drawOutposts +
    // drawOutpostDoors. The generic entity pass skips it.
    function isOutpostBannerEntity(instance) {
        if (!instance || !instance.index) return false;
        const _obM = global.mockups[entMockupIndex(instance)];
        return !!(_obM && (_obM.name === "Outpost" || _obM.className === "outpostBanner"));
    }

    // Dig Wars: core chambers are drawn entirely by drawChambers; the
    // generic entity pass skips them.
    function isCoreChamberEntity(instance) {
        if (!instance || !instance.index) return false;
        const _obM = global.mockups[entMockupIndex(instance)];
        return !!(_obM && (_obM.name === "Core Chamber" || _obM.className === "coreChamber"));
    }

    // Gem pickups (loose and treasury) skip the entity pipeline: each class
    // is pre-rendered once to a sprite that replicates drawEntity's output
    // (halo, body, outline, facet, sparkle), so a gem costs one rotated
    // drawImage per frame with no shadowBlur. gemSpriteClass returns the gem
    // class ("" for non-gems), cached on the instance once the mockup is known.
    function gemSpriteClass(instance) {
        if (!instance || !instance.index) return "";
        if (instance._gemCls !== undefined) return instance._gemCls;
        const m = global.mockups[parseInt(instance.index.split("-")[0])];
        if (!m) return "";
        const cls = (m.className && m.className.startsWith("gemPickup") && GEM_SPRITE_PAL[m.className]) ? m.className : "";
        instance._gemCls = cls;
        return cls;
    }
    function isContainedChamberGem(instance) {
        if (!global.chambers.length || !instance || !instance.index) return "";
        const _obM = global.mockups[parseInt(instance.index.split("-")[0])];
        if (!_obM || !_obM.className || !_obM.className.startsWith("gemPickup")) return "";
        for (const ch of global.chambers) {
            const dx = instance.x - ch.x, dy = instance.y - ch.y;
            if (Math.hypot(dx, dy) < ch.r) return _obM.className;
        }
        return "";
    }

    // The canonical gem cut (unit coords); mirrors GEM_CUT in terrainRenderer
    // and digwars.js.
    const GEM_CUT = [
        [-1, -0.38], [-0.55, -0.95], [0.55, -0.95], [1, -0.38], [0, 0.95],
    ];
    const GEM_CUT_PATH = (() => {
        const p = new Path2D();
        GEM_CUT.forEach((pt, i) => {
            if (i === 0) p.moveTo(pt[0], pt[1]); else p.lineTo(pt[0], pt[1]);
        });
        p.closePath();
        return p;
    })();

    // Per-class art. body / facet / glow(+radius+alpha) mirror the gemPickup*,
    // gemFacet* and GLOW values in digwars.js; the rim is
    // gameDraw.getColorDark(body), as the pipeline does.
    // `size` is the class's SIZE: the pipeline's outline is a fixed
    // world-space width (borderChunk * strokeWidth), so the bake divides it
    // by each class's size.
    const GEM_SPRITE_PAL = {
        gemPickupCopper:      { size: 16, body: "#c96f2e", facet: "#eda766", glow: "#e8a05c", glowR: 0.8,  glowA: 0.3 },
        gemPickupVein:        { size: 20, body: "#3b7ce0", facet: "#7fb1f2", glow: "#6fa3f2", glowR: 1,    glowA: 0.35 },
        gemPickupShard:       { size: 30, body: "#b13ecf", facet: "#d98af0", glow: "#e08af5", glowR: 1.4,  glowA: 0.45 },
        gemPickupShardCore:   { size: 34, body: "#b13ecf", facet: "#d98af0", glow: "#e08af5", glowR: 2,    glowA: 0.55 },
        gemPickupEmerald:     { size: 34, body: "#1fbf6b", facet: "#6ff5a8", glow: "#6ff5a8", glowR: 1.8,  glowA: 0.55 },
        gemPickupEmeraldCore: { size: 34, body: "#1fbf6b", facet: "#6ff5a8", glow: "#6ff5a8", glowR: 2.4,  glowA: 0.65 },
        gemPickupLoot:        { size: 7,  body: "#e0a63b", facet: "#f2cf7f", glow: "#f5cf6e", glowR: 1.2,  glowA: 0.4 },
    };

    // Baked sprites replicating drawEntity for a gem pickup: glow halo
    // (shadowBlur under a borderless body fill at the glow alpha), the gem
    // cut with its darkened rim (stroke first, fill hides the inner half),
    // then the facet + sparkle Props at their real size/offset/angle.
    // Colours go through gameDraw.modifyColor like the pipeline's.
    const GEM_SPRITES = {};
    const GEM_SPRITE_HALF = 6.0;    // unit span covered (biggest glow ~2.4)
    const GEM_SPRITE_SCALE = 64;    // px per world unit inside the sprite
    const GEM_RIM_UNITS = 7.2 * 0.55; // borderChunk * strokeWidth, cut-units per SIZE=1
    function gemSprite(cls) {
        let s = GEM_SPRITES[cls];
        if (s) return s;
        const pal = GEM_SPRITE_PAL[cls] || GEM_SPRITE_PAL.gemPickupVein;
        const body  = gameDraw.modifyColor(pal.body + " 0 1 0 false");
        const rim   = gameDraw.getColorDark(body);
        const glow  = gameDraw.modifyColor(pal.glow + " 0 1 0 false");
        const facet = gameDraw.modifyColor(pal.facet + " 0 1 0 false");

        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = Math.ceil(GEM_SPRITE_HALF * 2 * GEM_SPRITE_SCALE);
        const c = canvas.getContext("2d");
        c.translate(canvas.width / 2, canvas.height / 2);
        c.scale(GEM_SPRITE_SCALE, GEM_SPRITE_SCALE);

        // glow pass: borderless body fill at the glow alpha casts the halo
        c.globalAlpha = pal.glowA;
        c.shadowColor = glow;
        c.shadowBlur = pal.glowR * GEM_SPRITE_SCALE;
        c.shadowOffsetX = 0;
        c.shadowOffsetY = 0;
        c.fillStyle = body;
        c.fill(GEM_CUT_PATH);
        c.globalAlpha = 1;
        c.shadowBlur = 0;

        // body: stroke first, then fill hides the inner half
        c.lineJoin = "round";
        c.lineCap = "round";
        c.lineWidth = GEM_RIM_UNITS / (pal.size || 7);
        c.strokeStyle = rim;
        c.stroke(GEM_CUT_PATH);
        c.fillStyle = body;
        c.fill(GEM_CUT_PATH);

        // facet prop (0.525 scale, 0.12 toward the crown, aligned with body)
        c.save();
        c.translate(0, -0.12);
        c.scale(0.525, 0.525);
        c.fillStyle = facet;
        c.fill(GEM_CUT_PATH);
        c.restore();

        // sparkle prop (0.2 scale, 0.405 offset up-left, spun 12deg like
        // gemSparkle's t.angle)
        c.save();
        c.translate(-0.148, -0.377);
        c.rotate(0.20944);
        c.scale(0.2, 0.2);
        c.fillStyle = "#ffffff";
        c.fill(GEM_CUT_PATH);
        c.restore();

        s = { canvas, half: GEM_SPRITE_HALF };
        GEM_SPRITES[cls] = s;
        return s;
    }

    // Draw a gem from its cached sprite. `isize` is the render size (world
    // units); the unit cut maps to `isize * ratio` pixels, as in the pipeline.
    function drawContainedGem(c, x, y, ratio, alpha, isize, facing, cls) {
        const spr = gemSprite(cls);
        const k = isize * ratio;
        if (k < 0.1) return; // sub-pixel (the real pipeline skips below 0.1 too)
        c.save();
        c.translate(x, y);
        c.rotate(facing);
        c.globalAlpha = alpha;
        const h = spr.half * k;
        c.drawImage(spr.canvas, -h, -h, h * 2, h * 2);
        c.restore();
    }
    // Tutorial ore-tier card: the same baked sprite, sized in pixels.
    window.dwDrawGem = function (c, x, y, bodyPx, alpha, facing, cls) {
        const pal = GEM_SPRITE_PAL[cls] || GEM_SPRITE_PAL.gemPickupVein;
        const isize = pal.size || 16;
        drawContainedGem(c, x, y, bodyPx / isize, alpha, isize, facing, cls);
    };

    // ── Baked radial halos: one gradient per colour, drawn as an image ──
    // A live createRadialGradient per entity per frame is too expensive.
    const haloSprites = new Map();
    function haloSprite(key, rgb, stops) {
        let spr = haloSprites.get(key);
        if (spr) return spr;
        const S = 192;
        spr = document.createElement("canvas");
        spr.width = spr.height = S;
        const c = spr.getContext("2d");
        const g = c.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
        for (const [pos, a] of stops) g.addColorStop(pos, "rgba(" + rgb + "," + a + ")");
        c.fillStyle = g;
        c.fillRect(0, 0, S, S);
        if (haloSprites.size > 128) haloSprites.delete(haloSprites.keys().next().value);
        haloSprites.set(key, spr);
        return spr;
    }
    // Full-screen vignettes, baked at half resolution per size/colour.
    const vignetteSprites = new Map();
    function vignetteSprite(w, h, inner, rgb) {
        inner = Math.round(inner * 20) / 20;
        const key = (w | 0) + "x" + (h | 0) + "|" + inner + "|" + rgb;
        let spr = vignetteSprites.get(key);
        if (spr) return spr;
        const cw = Math.max(2, Math.ceil(w / 2)), chh = Math.max(2, Math.ceil(h / 2));
        spr = document.createElement("canvas");
        spr.width = cw; spr.height = chh;
        const c = spr.getContext("2d");
        const r = Math.hypot(cw, chh) / 2;
        const gd = c.createRadialGradient(cw / 2, chh / 2, Math.max(1, r * inner), cw / 2, chh / 2, r);
        gd.addColorStop(0, "rgba(" + rgb + ",0)");
        gd.addColorStop(1, "rgba(" + rgb + ",1)");
        c.fillStyle = gd;
        c.fillRect(0, 0, cw, chh);
        if (vignetteSprites.size > 24) vignetteSprites.delete(vignetteSprites.keys().next().value);
        vignetteSprites.set(key, spr);
        return spr;
    }
    function shakeCamera(amount, duration) {
        const sh = config.graphical.shakeProperties.CameraShake;
        if (sh.shakeStartTime !== -1 && sh.shakeAmount > amount && Date.now() - sh.shakeStartTime < sh.shakeDuration) return;
        sh.shakeStartTime = Date.now();
        sh.shakeDuration = duration;
        sh.shakeAmount = amount;
    }

    // ── Ore chests are boulders ────────────────────────────────────────
    // A chest is a rock with a vein of ore in it. It cracks like the wall as
    // it takes damage and shatters like the wall when it breaks (drawFx).
    // The server entity only supplies position, size and health.
    const CHEST_NAMES = ["Copper Chest", "Epic Chest"];
    function isLootChestEntity(instance) {
        if (!instance || !instance.index) return null;
        if (instance._chest !== undefined) return instance._chest;
        const m = global.mockups[parseInt(instance.index.split("-")[0])];
        if (!m) return null;
        let kind = null;
        if (m.name === "Copper Chest" || m.className === "lootChest") kind = { epic: false };
        else if (m.name === "Epic Chest" || m.className === "lootChestRare") kind = { epic: true };
        instance._chest = kind;
        return kind;
    }
    // ── Raid boss aura: a floor halo in their colour, two counter-rotating
    // dashed rings and five orbiting shards (one baked sprite + a few strokes).
    const BOSS_NAME_RE = /Vault Warden|Magma Drillhead|Geode Colossus|Shard Wraith/;
    function isRoyaleBossEntity(instance) {
        if (!instance || !instance.index) return false;
        if (instance._isBoss !== undefined) return instance._isBoss;
        const m = global.mockups[parseInt(instance.index.split("-")[0])];
        if (!m) return false;
        instance._isBoss = BOSS_NAME_RE.test(m.name || "");
        return instance._isBoss;
    }
    function drawBossAura(c, x, y, instance, ratio, alpha) {
        const now = performance.now();
        const R = (instance.size || 40) * ratio;
        if (R < 4) return;
        const b = (global.royale && global.royale.boss) || global._lastBoss;
        const col = (b && b.c) || "#c9a8ff";
        const rgb = toRgb(col) || { r: 201, g: 168, b: 255 };
        const tint = rgb.r + "," + rgb.g + "," + rgb.b;
        const pulse = 0.5 + 0.5 * Math.sin(now / 420);
        c.save();
        c.globalAlpha = alpha * (0.5 + 0.25 * pulse);
        const hr = R * (2.1 + 0.15 * pulse);
        if (!config.graphical.noGlow) c.drawImage(haloSprite("bossaura|" + tint, tint, [[0, 0.6], [0.45, 0.22], [1, 0]]), x - hr, y - hr, hr * 2, hr * 2);
        c.globalAlpha = alpha * 0.75;
        c.strokeStyle = col; c.lineCap = "round";
        c.lineWidth = Math.max(1.5, R * 0.05);
        c.setLineDash([R * 0.35, R * 0.22]); c.lineDashOffset = -now / 28;
        c.beginPath(); c.arc(x, y, R * 1.32, 0, Math.PI * 2); c.stroke();
        c.globalAlpha = alpha * 0.5;
        c.lineWidth = Math.max(1, R * 0.03);
        c.setLineDash([R * 0.18, R * 0.3]); c.lineDashOffset = now / 40;
        c.beginPath(); c.arc(x, y, R * 1.58, 0, Math.PI * 2); c.stroke();
        c.setLineDash([]);
        c.globalAlpha = alpha * 0.9;
        c.fillStyle = col; c.strokeStyle = "rgba(5,4,7,0.9)"; c.lineWidth = Math.max(1, R * 0.025);
        for (let i = 0; i < 5; i++) {
            const a = (now / 900) * (i % 2 ? -1 : 1) + i * (Math.PI * 2 / 5);
            const rr = R * (1.45 + 0.08 * Math.sin(now / 300 + i));
            gemPath(c, x + Math.cos(a) * rr, y + Math.sin(a) * rr, R * 0.13);
            c.fill(); c.stroke();
        }
        c.restore();
    }
    function lcg(seed) {
        let h = (Math.abs(seed | 0) * 2654435761) >>> 0;
        return () => { h = (h * 1664525 + 1013904223) >>> 0; return h / 4294967296; };
    }
    function chestStageOf(frac) {
        return frac > 5 / 6 ? 0 : frac > 4 / 6 ? 1 : frac > 3 / 6 ? 2 : frac > 2 / 6 ? 3 : frac > 1 / 6 ? 4 : 5;
    }
    // Per-chest geometry in unit space (radius 1): faceted body, ore core,
    // veins and five cumulative crack stages. Seeded by id so nothing flickers.
    const chestGeoms = new Map();
    function chestGeom(id, epic) {
        const key = (id | 0) + (epic ? "e" : "c");
        let g = chestGeoms.get(key);
        if (g) return g;
        const rnd = lcg((id | 0) + (epic ? 977 : 0));
        const n = epic ? 10 : 9;
        const pts = [];
        for (let i = 0; i < n; i++) {
            const a = (i / n) * Math.PI * 2 + (rnd() - 0.5) * 0.44;
            const r = 0.84 + rnd() * 0.24;
            pts.push([Math.cos(a) * r, Math.sin(a) * r]);
        }
        const body = new Path2D();
        pts.forEach((p, i) => i ? body.lineTo(p[0], p[1]) : body.moveTo(p[0], p[1]));
        body.closePath();
        // two lighter facets and a darker lower half: flat shading, no texture
        const facets = new Path2D();
        for (let f = 0; f < 2; f++) {
            const i = Math.floor(rnd() * n);
            const a = pts[i], b = pts[(i + 1) % n];
            facets.moveTo(0.05, -0.05); facets.lineTo(a[0], a[1]); facets.lineTo(b[0], b[1]); facets.closePath();
        }
        const shade = new Path2D();
        const lower = pts.filter(p => p[0] + p[1] > 0.15);
        if (lower.length >= 2) {
            shade.moveTo(0.1, 0.1);
            for (const p of lower) shade.lineTo(p[0], p[1]);
            shade.closePath();
        }
        g = { body, facets, shade, pts };
        if (chestGeoms.size > 64) chestGeoms.delete(chestGeoms.keys().next().value);
        chestGeoms.set(key, g);
        return g;
    }
    const chestSpawnByEnt = new Map();   // entity id -> when it landed (performance clock)
    const chestGoneAt = (global.chestGoneAt = new Map());   // entity id -> when it broke (set by the FX packet)
    const CHEST_FALLBACK = {
        1: { pal: { mid: "rgba(201,111,46,0.95)", light: "rgba(237,167,102,0.95)", core: "rgba(255,233,209,0.9)" }, crack: { deep: "140,62,15", hot: "235,140,60", hair: "255,218,175" } },
        3: { pal: { mid: "rgba(177,62,207,0.95)", light: "rgba(217,138,240,0.95)", core: "rgba(251,230,255,0.9)" }, crack: { deep: "110,25,140", hot: "200,95,240", hair: "242,205,255" } },
        4: { pal: { mid: "rgba(46,170,104,0.95)", light: "rgba(111,245,168,0.95)", core: "rgba(225,255,236,0.9)" }, crack: { deep: "14,90,52", hot: "70,220,140", hair: "205,255,225" } },
    };
    const chestCellKey = (id) => -(1000000 + (id | 0));
    function drawChestBoulder(c, x, y, instance, ratio, alpha, isize, kind) {
        const now = performance.now();
        // A fading chest is either broken (the FX packet drew the shatter)
        // or simply out of view; either way the body stops here.
        if (instance.render.status.getFade() < 1) return;
        const R = isize * ratio;
        if (R < 0.5) return;
        const tr = window.terrainRenderer;
        const g = chestGeom(instance.id, kind.epic);
        // a supply crate is emerald (raidHeat.crateKind)
        const tier = kind.emerald ? 4 : kind.epic ? 3 : 1;
        const TR = tr && tr.constructor;
        const cpal = (TR && TR.CRACK_PAL && TR.CRACK_PAL[tier]) || CHEST_FALLBACK[tier].crack;
        // the chest is a cell of the terrain renderer too: same crack
        // generator, same fracture net, same caches
        const key = chestCellKey(instance.id);
        let cell = null, tilePx = 0, rockSz = 2.4;
        if (tr && tr.ready && tr._world) {
            const w = tr._world;
            tilePx = ratio * w.s;
            rockSz = Math.min(tr._cols, 120) / 50.0;
            if (!instance._chestCell || instance._chestCellR !== isize ||
                Math.abs(instance._chestCellX - instance.render.x) > 2 || Math.abs(instance._chestCellY - instance.render.y) > 2) {
                const cx = (instance.render.x + w.hw) / w.s, cy = (instance.render.y + w.hh) / w.s, rt = isize / w.s;
                const poly = g.pts.map(pt => [cx + pt[0] * rt, cy + pt[1] * rt]);
                const path = new Path2D();
                poly.forEach((pt, i) => i ? path.lineTo(pt[0], pt[1]) : path.moveTo(pt[0], pt[1]));
                path.closePath();
                instance._chestCell = { k: key, poly, cx, cy, path };
                instance._chestCellR = isize; instance._chestCellX = instance.render.x; instance._chestCellY = instance.render.y;
                tr.registerCell(key, instance._chestCell);
            }
            cell = instance._chestCell;
        }
        // landing: drop in from above, squash on touchdown, one dust ring
        let sx = 1, sy = 1, shadowK = 1, landDust = 0;
        const spawn = chestSpawnByEnt.get(instance.id);
        if (spawn !== undefined) {
            const age = now - spawn;
            if (age < 500) {
                const k = age / 500;
                if (k < 0.6) { const u = k / 0.6; const sc = 1.6 - 0.6 * u * u; sx = sy = sc; shadowK = 1 / sc; }
                else { const u = (k - 0.6) / 0.4; const e = 1 - Math.pow(1 - u, 3); sx = 1 + 0.18 * (1 - e); sy = 1 - 0.16 * (1 - e); }
                if (k >= 0.6 && !instance._thudDone) {
                    instance._thudDone = true;
                    const d = Math.hypot(instance.render.x - global.player.renderx, instance.render.y - global.player.rendery);
                    if (d < 700) {
                        shakeCamera(6, 160);
                        try { gameSound.rockHit(instance.render.x, instance.render.y, 3, false); } catch (e) { /* */ }
                    }
                }
                if (age > 300) landDust = (age - 300) / 220;
            }
        }
        const hp = typeof instance.health === "number" ? instance.health : 1;
        const stage = chestStageOf(hp);
        if (instance._chestStage !== undefined && stage > instance._chestStage) {
            instance._chestSnapAt = now;
            const d = Math.hypot(instance.render.x - global.player.renderx, instance.render.y - global.player.rendery);
            if (d < 800) shakeCamera(2, 140);
        }
        instance._chestStage = stage;
        const hitB = instance.render.hitAt ? Math.max(0, 1 - (now - instance.render.hitAt) / 150) : 0;
        const snapT = instance._chestSnapAt ? Math.max(0, 1 - (now - instance._chestSnapAt) / 220) : 0;
        const snap = snapT * snapT;
        const boost = Math.max(hitB, snap);
        c.save();
        c.globalAlpha = alpha;
        if (landDust > 0 && landDust < 1) {
            const q = 1 - Math.pow(1 - landDust, 4);
            c.beginPath(); c.arc(x, y, R * (0.6 + 1.8 * q), 0, Math.PI * 2);
            c.strokeStyle = "rgba(110,100,125," + (Math.pow(1 - landDust, 1.5) * 0.45).toFixed(3) + ")";
            c.lineWidth = 0.12 * R * (1 - landDust) + 0.5;
            c.stroke();
        }
        // drop shadow
        c.save();
        c.translate(x + 0.06 * R, y + 0.09 * R);
        c.scale(R * shadowK, R * shadowK);
        c.fillStyle = "rgba(0,0,0,0.38)";
        c.fill(g.body);
        c.restore();
        // body: the wall's own palette and border weight
        c.save();
        c.translate(x, y);
        let trX = 0, trY = 0;
        if (stage >= 5) {
            trX = Math.sin(now / 17 + (instance.id % 13)) * 0.02 * R; trY = Math.cos(now / 23 + (instance.id % 7)) * 0.02 * R;
            c.translate(trX, trY);
            c.scale(1.05, 1.05);
        }
        c.scale(R * sx, R * sy);
        c.lineJoin = "round"; c.lineCap = "round";
        c.fillStyle = "rgb(43,39,55)"; c.fill(g.body);
        c.fillStyle = "rgb(61,55,77)"; c.fill(g.facets);
        c.fillStyle = "rgba(16,13,22,0.34)"; c.fill(g.shade);
        if (stage >= 1) { c.fillStyle = "rgba(16,13,22," + (0.07 * stage).toFixed(2) + ")"; c.fill(g.body); }
        const borderPx = tilePx ? 0.072 * rockSz * tilePx : Math.max(2, 3 * ratio);
        c.lineWidth = borderPx / R; c.strokeStyle = "rgb(16,13,22)"; c.stroke(g.body);
        if (hitB > 0) { c.fillStyle = "rgba(255,244,210," + (0.35 * hitB).toFixed(3) + ")"; c.fill(g.body); }
        c.restore();
        // cracks: the terrain renderer's, in its tile space
        if (cell && stage >= 1 && tr._getCrackPath) {
            const path = tr._getCrackPath(key, stage);
            if (path) {
                c.save();
                c.translate(x + trX - cell.cx * tilePx, y + trY - cell.cy * tilePx);
                c.scale(tilePx, tilePx);
                c.lineCap = "round"; c.lineJoin = "round";
                const a = 0.30 + 0.035 * stage;
                const w = 0.035 * rockSz * (0.28 + 0.075 * stage) * (1 + snap);
                c.strokeStyle = "rgba(5,4,7,0.8)"; c.lineWidth = w * 2.1; c.stroke(path);
                c.strokeStyle = "rgba(" + cpal.deep + "," + a.toFixed(2) + ")"; c.lineWidth = w * 1.2; c.stroke(path);
                c.strokeStyle = "rgba(" + cpal.hot + "," + Math.min(1, a * 0.9 + boost * 0.45).toFixed(2) + ")"; c.lineWidth = w * 0.5; c.stroke(path);
                c.strokeStyle = "rgba(" + cpal.hair + "," + Math.max(0.08 + 0.025 * stage, boost * 0.6).toFixed(2) + ")"; c.lineWidth = w * 0.2; c.stroke(path);
                c.restore();
            }
        }
        c.restore();
        // The prize: one ore gem set into a pocket in the rock, only its
        // crown showing (no glow), with an inner shadow under the pocket's
        // top edge and a lip of stone across its foot.
        const gemK = 0.40 * sy;
        const gx = x + trX, gy = y + trY, gr = R * gemK;
        const gpal = kind.emerald ? { body: "#2eaa68", facet: "#6ff5a8", deep: "#145c36" } : kind.epic ? { body: "#b13ecf", facet: "#d98af0", deep: "#6d2287" } : { body: "#c96f2e", facet: "#eda766", deep: "#7a4018" };
        const pocket = () => gemPath(c, gx, gy + gr * 0.1, gr * 1.28);
        c.save();
        c.globalAlpha = alpha;
        pocket(); c.fillStyle = "rgb(12,10,16)"; c.fill();
        c.save();
        pocket(); c.clip();
        gemPath(c, gx, gy + gr * 0.14, gr * 0.98);
        c.fillStyle = gpal.deep; c.fill();
        c.save();
        gemPath(c, gx, gy + gr * 0.14, gr * 0.98); c.clip();
        c.fillStyle = gpal.body; c.fillRect(gx - gr, gy - gr, gr * 2, gr * 0.92);
        c.fillStyle = gpal.facet;
        c.beginPath(); c.moveTo(gx - gr * 0.55, gy - gr * 0.72); c.lineTo(gx + gr * 0.12, gy - gr * 0.72); c.lineTo(gx - gr * 0.22, gy - gr * 0.18); c.closePath(); c.fill();
        c.restore();
        // inner shadow: two flat bands under the pocket's top edge
        c.fillStyle = "rgba(5,4,7,0.45)"; c.fillRect(gx - gr * 1.4, gy - gr * 1.2, gr * 2.8, gr * 0.55);
        c.fillStyle = "rgba(5,4,7,0.2)";  c.fillRect(gx - gr * 1.4, gy - gr * 0.65, gr * 2.8, gr * 0.35);
        // a lip of rock over the gem's foot
        c.fillStyle = "rgb(43,39,55)"; c.fillRect(gx - gr * 1.5, gy + gr * 0.48, gr * 3, gr * 1.3);
        c.fillStyle = "rgba(5,4,7,0.7)"; c.fillRect(gx - gr * 1.5, gy + gr * 0.48, gr * 3, Math.max(1, R * 0.04));
        c.restore();
        pocket();
        c.lineJoin = "round"; c.lineWidth = Math.max(1.5, borderPx * 0.8); c.strokeStyle = "rgb(5,4,7)"; c.stroke();
        c.restore();
        drawChestLabel(c, x, y - R * 1.12, R, instance, kind, alpha);
    }
    // Round 8: a light name over every chest ("Epic chest"), since new players took
    const CHEST_LABEL = { copper: "Copper chest", epic: "Epic chest", crate: "Supply crate" };
    const CHEST_LABEL_COL = { copper: "#eda766", epic: "#d98af0", crate: "#6ff5a8" };
    function drawChestLabel(c, x, y, R, instance, kind, alpha) {
        if (!royaleActive() || global.showBigMap || R < 6) return;
        const k = kind.emerald ? "crate" : kind.epic ? "epic" : "copper";
        const d = Math.hypot(instance.render.x - global.player.renderx, instance.render.y - global.player.rendery);
        const far = d < 900 ? 1 : Math.max(0.35, 1 - (d - 900) / 1100);
        const size = Math.max(12, Math.min(17, R * 0.3));
        const ly = y - size * 0.55;
        const w = hudTitleW(CHEST_LABEL[k], size) + 8;
        const a = alpha * 0.92 * far;
        if (a < 0.03) return;
        worldLabel(c, CHEST_LABEL[k], x, ly, size, CHEST_LABEL_COL[k], a, k === "crate" ? 1 : k === "epic" ? 2 : 3, w, size + 6);
    }
    let bgCanvasEl = null, bgHidden = false;
    function drawEntities(px, py, ratio, tick) {
        const bgEl = bgCanvasEl || (bgCanvasEl = document.getElementById("gameCanvas-background"));
        if (global.advanced.blackout.active) {
            if (!bgHidden) { bgEl.style.display = "none"; bgHidden = true; }
            ctx[1].drawImage(ctx[0].canvas, 0, 0, global.screenWidth, global.screenHeight);
            if (global.glCanvas) ctx[1].drawImage(global.glCanvas, 0, 0, global.screenWidth, global.screenHeight);
        } else if (bgHidden) { bgEl.style.display = "block"; bgHidden = false; }

        const motion = compensation();
        let livingPred = false;
        const nsNow = Math.abs(performance.now() - tick) < 100 ? tick : performance.now();
        const nsOn = netSmooth.active(nsNow) && config.graphical.interpolation && !config.graphical.lerpAnimations;
        const finaleIds = raidFinale.watchIds();
        const skCount = sidekicks.count();
        overheadFrame++;
        // who owns a captured base this frame: the ring check below then costs
        // one Set lookup per entity instead of a filtered array per entity
        const outOwners = drawEntities.owners || (drawEntities.owners = new Set());
        outOwners.clear();
        if (global.outpostState) for (const s of global.outpostState) if (s.c) outOwners.add(s.o);
        for (let instance of global.entities) {
            if (!instance.render.draws) {
                instance._onScreen = false;
                continue;
            }
            // Dig Wars: outpost banners and core chambers are drawn by the
            // floor-layer passes (HP bars included)
            if (isOutpostBannerEntity(instance) || isCoreChamberEntity(instance)) {
                const rst = instance.render.status.getFade();
                if (rst < 1 && !instance.deathSounded) {
                    instance.deathSounded = true;
                    const x = instance.render.x || instance.x;
                    const y = instance.render.y || instance.y;
                    if (isCoreChamberEntity(instance)) gameSound.oreBreak(x, y, 2);
                    else gameSound.rockBreak(x, y);
                } else if (rst === 1 && instance.deathSounded) {
                    instance.deathSounded = false;
                }
                instance._onScreen = false;
                continue;
            }
            let rst = instance.render.status.getFade();
            // first frame of a death fade: play a size-appropriate sound
            // (chests break with the rock sound from the FX handler instead)
            if (rst < 1 && !instance.deathSounded) {
                instance.deathSounded = true;
                if (!isLootChestEntity(instance)) gameSound.die(instance.render.x, instance.render.y,
                              instance.realSize || instance.size || 20);
            } else if (rst === 1 && instance.deathSounded) {
                instance.deathSounded = false; // entity recovered/reused
            }
            if (rst === 1) {
                if (!livingPred) {
                    motion.set();
                    livingPred = true;
                }
            } else {
                livingPred = false;
                if (config.graphical.lerpAnimations) {
                    instance.x += instance.vx * global.metrics.updatetime / global.metrics.rendertime;
                    instance.y += instance.vy * global.metrics.updatetime / global.metrics.rendertime;
                    instance.facing += instance.vfacing * global.metrics.updatetime / global.metrics.rendertime;
                }
                motion.set(instance.render.lastRender, instance.render.interval);
            }
            let isize = instance.render.size.get(tick, 1 !== rst);
            const nsT = nsOn && instance.render.ns ? netSmooth.entity(instance.render.ns, nsNow) : null;
            instance.render.x = !config.graphical.interpolation ?
                motion.predict(instance.render.lastx, instance.x, instance.render.lastvx, instance.vx) :
                config.graphical.lerpAnimations ?
                util.lerp(instance.render.x, Math.round(instance.x + instance.vx), 0.1, true) :
                instance.render.xAnim.get(tick, 1 !== rst);

            instance.render.y = !config.graphical.interpolation ?
                motion.predict(instance.render.lasty, instance.y, instance.render.lastvy, instance.vy) :
                config.graphical.lerpAnimations ?
                util.lerp(instance.render.y, Math.round(instance.y + instance.vy), 0.1, true) :
                instance.render.yAnim.get(tick, 1 !== rst);

            instance.render.f = !config.graphical.interpolation ?
                motion.predictFacing(instance.render.lastf, instance.facing) :
                instance.render.faceAnim.get(tick, 1 !== rst);
            if (nsT) { instance.render.x = nsT.x; instance.render.y = nsT.y; instance.render.f = nsT.f; }
            if (nsOn && instance.id === gui.playerid && !global.died && !global.player.isScoping) { const nsC = netSmooth.camNow(); if (nsC) { instance.render.x = nsC.x; instance.render.y = nsC.y; } }
            if (global.player.predOn && instance.id === gui.playerid && !global.died && rst === 1) { instance.render.x = global.player.predX; instance.render.y = global.player.predY; }

            instance.id === gui.playerid &&
                !global.autoSpin &&
                !global.syncingWithTank &&
                !instance.twiggle &&
                !global.died ?
                instance.render.f = Math.atan2(global.target.y * global.reverseTank, global.target.x * global.reverseTank) : 0

            let x = ratio * instance.render.x - px,
                y = ratio * instance.render.y - py,
                baseColor = instance.color;
            if (instance.id === gui.playerid) {
                x = !config.graphical.smoothcamera && !global.player.isScoping && config.graphical.shakeProperties.CameraShake.shakeStartTime == -1 && !global.died ? 0 : x;
                y = !config.graphical.smoothcamera && !global.player.isScoping && config.graphical.shakeProperties.CameraShake.shakeStartTime == -1 && !global.died ? 0 : y;
                global.player.screenx = x;
                global.player.screeny = y;
                global.player.name = instance.name ?? "";
                // the HUD's HP / shield bars read your own entity (drawVitals)
                global.selfEnt = instance;
            }
            x += global.screenWidth / 2;
            y += global.screenHeight / 2;
            // falling out of the sky: drawn up its trail by its height (skyDrop.js);
            // your own tank pinned to the middle is already there (the camera rides it)
            const fall = raidHeat.fallOf(instance.id);
            if (fall && !(instance.id === gui.playerid && x === global.screenWidth / 2 && y === global.screenHeight / 2)) { x += fall.dx * ratio; y += fall.dy * ratio; }
            const rad = (isize || instance.size) * ratio + 80;
            const onScreen = instance.id === gui.playerid ||
                (x >= -rad && y >= -rad && x <= global.screenWidth + rad && y <= global.screenHeight + rad);
            instance._onScreen = onScreen;
            instance._sx = x;
            instance._sy = y;
            if (finaleIds !== null && finaleIds.has(instance.id)) {
                raidFinale.seen(instance.id, x / global.screenWidth, y / global.screenHeight, (isize || instance.size) * ratio / global.screenWidth);
            }
            if (!onScreen) continue;
            // the raid-end freeze makes everyone invulnerable: that is not a spawn shield
            if (instance.id === gui.playerid && !global.died && !raidFinale.active()) drawSpawnShield(ctx[1], x, y, (isize || instance.size) * ratio, instance.invuln);
            // your hull's size on screen, as a share of its width: the perk
            // cards keep clear of it (raidPerks.js, GUI units differ)
            if (instance.id === gui.playerid) global.selfRFrac = (isize || instance.size) * ratio / Math.max(1, global.screenWidth);
            let alpha = instance.id === gui.playerid ? 1 : instance.alpha;
            alpha = handleScreenDistance(alpha, instance, false);
            // treasury gems inside a chamber ring: drawn from the baked sprite
            const _gcls = gemSpriteClass(instance);
            if (_gcls) {
                let ga = instance.alpha * alpha * instance.render.status.getFade();
                // expiring gems blink like any invulnerable entity would
                if (instance.invuln && 100 > (Date.now() - instance.invuln) % 200) ga *= 0.55;
                if (ga > 0.01) drawContainedGem(ctx[1], x, y, ratio, ga, isize, instance.render.f, _gcls);
                continue;
            }
            if (raidHeat.isCoreEntity(instance)) {
                raidHeat.drawCore(ctx[1], x, y, instance, ratio, instance.alpha * alpha, isize);
                continue;
            }
            const _chest = isLootChestEntity(instance);
            if (_chest) {
                drawChestBoulder(ctx[1], x, y, instance, ratio, instance.alpha * alpha, isize, raidHeat.crateKind(instance.id) || _chest);
                continue;
            }
            if (isRoyaleBossEntity(instance)) drawBossAura(ctx[1], x, y, instance, ratio, instance.alpha * alpha);
            drawEntity(baseColor, x, y, instance, fall ? ratio * fall.s : ratio, instance.alpha * alpha, 1, 1, instance.render.f, false, false, false, instance.render, isize);
            // a Locker sidekick only shows where its owner was just drawn (sidekicks.js)
            if (skCount && sidekicks.has(instance.id)) sidekicks.note(instance, x, y, instance.alpha * alpha, rst, isize || instance.size, !!fall);
            if (outOwners.has(instance.id) && global.royale && global.outpostState && !royaleLobbyPhase() && global.royale.phase === "live") {
                const ownedAll = global.outpostState.filter(s => s.o === instance.id && s.c);
                if (ownedAll.length) {
                    // one ring per owned base, stacked outward and touching, each
                    // in that base's colour
                    const c = ctx[1];
                    const lw = Math.max(3, isize * ratio * 0.14);
                    c.save();
                    c.globalAlpha = (instance.alpha * alpha) * (0.7 + 0.3 * Math.sin(performance.now() / 400));
                    c.lineWidth = lw;
                    for (let oi = 0; oi < ownedAll.length && oi < 4; oi++) {
                        c.strokeStyle = ownedAll[oi].c;
                        c.beginPath();
                        c.arc(x, y, isize * ratio * 1.38 + oi * lw, 0, Math.PI * 2);
                        c.stroke();
                    }
                    c.restore();
                }
            }
        }
        if (skCount) { try { sidekicks.draw(ctx[1], ratio, px, py, tick, gui.playerid); } catch (e) { /* never break the frame */ } }
        // the death card owns the screen: names, badges and crowns step back
        const lblK = deathCardUp() ? 0.45 : 1;
        for (let instance of global.entities) {
            // Dig Wars: same banner skip as the shape pass (no generic HP bar)
            if (!instance._onScreen) continue;
            if (isOutpostBannerEntity(instance)) continue;
            if (isCoreChamberEntity(instance)) continue;
            if (gemSpriteClass(instance)) continue;
            if (isLootChestEntity(instance)) continue;
            if (raidHeat.isCoreEntity(instance)) continue;
            // the sky drop's wide view (skyDrop.js): other tanks are specks,
            // their names and bars are clutter and text cost
            if (global.dropZoom < 0.75 && instance.id !== gui.playerid && window.dwDropOpt !== false) continue;
            let alpha = instance.id === gui.playerid ? 1 : instance.alpha;
            alpha = handleScreenDistance(alpha, instance) * lblK;
            let x = instance.id === gui.playerid ? global.player.screenx : instance._sx - global.screenWidth / 2,
                y = instance.id === gui.playerid ? global.player.screeny : instance._sy - global.screenHeight / 2;
            drawHealth(x, y, instance, ratio, gui.visibleEntities ? 1 : alpha, instance.size);
            drawName(x, y, instance, ratio, gui.visibleEntities ? (alpha * 0.75 + 0.25) * lblK : alpha, instance.size);
            drawStreakBadge(x, y, instance, ratio, gui.visibleEntities ? (alpha * 0.75 + 0.25) * lblK : alpha, instance.size);
            // the top of your own overhead stack (badge, crown): the +N gem pops rise from
            if (instance.id === gui.playerid) {
                selfOver.top = overheadTop(instance, y + global.screenHeight / 2, ratio, instance.size);
                selfOver.at = overheadFrame;
                selfOver.x = x + global.screenWidth / 2;
                selfOver.y = y + global.screenHeight / 2;
                selfOver.r = instance.size * ratio;
            }
            // the Crown Contest: a big gold crown over the stack (crowns.js)
            if (royaleActive() && !raidFinale.active() && crowns.crownOf(instance.id)) {
                try {
                    const sx = x + global.screenWidth / 2, sy = y + global.screenHeight / 2;
                    crowns.drawOverhead(ctx[1], sx, sy, crownStackTop(instance, sy, ratio, instance.size), instance.size, ratio, gui.visibleEntities ? (alpha * 0.75 + 0.25) * lblK : alpha, instance.id);
                } catch (e) { /* never break the frame */ }
            }
        }
        if (global.advanced.blackout.active) {
            let entity = global.entities.find((u) => u.id === gui.playerid);
            if (entity) {
                ctx[1].beginPath();
                let x = global.screenWidth / 2 - px + ratio * 0,
                    y = global.screenHeight / 2 - py + ratio * 0,
                    kt = ratio * global.gameWidth,
                    ky = ratio * global.gameHeight,
                    G = global.roomSetup[0].length,
                    L = global.roomSetup.length

                for (let S = 0; S < L; S++) for (let ea = 0; ea < G; ea++) {
                    let Pc = x + ((ea + 0.5) / G) * kt - kt / 2,
                        Qc = y + ((S + 0.5) / L) * ky - ky / 2,
                        tile = global.roomSetup[S][ea];

                    if (tile.visibleOnBlackout) {
                        ctx[1].moveTo(Pc + ((0.5) / G) * kt, Qc);
                        ctx[1].arc(Pc, Qc, ((0.5) / G) * kt, 0, 2 * Math.PI);
                    }
                }
                for (let entity of global.entities) {
                    let x = ratio * entity.render.x - px,
                        y = ratio * entity.render.y - py,
                        indexes = entity.index.split("-"),
                        m = global.mockups[parseInt(indexes[0])] ?? global.missingno[0];

                    x += global.screenWidth / 2;
                    y += global.screenHeight / 2;
                    if (entity.id === gui.playerid || (m.visibleOnBlackout && entity.alpha < 0.1)) {
                        ctx[1].moveTo(x, y);
                        ctx[1].arc(x, y, entity.size * ratio * 4, 0, 2 * Math.PI);
                    }
                    if (entity.id === gui.playerid) {
                        if (!global.died) {
                            ctx[1].moveTo(x, y);
                            let na = Math.atan2(global.target.y * global.reverseTank, global.target.x * global.reverseTank);
                            ctx[1].arc(x, y, entity.size * ratio * 24, na - 0.3, na + 0.3);
                        }
                        for (let gun of m.guns) {
                            let facing = entity.render.f,
                                tx = x + gun.offset * Math.cos(gun.direction + gun.angle + facing) + (gun.length / 2) * Math.cos(gun.angle + facing),
                                ty = y + gun.offset * Math.sin(gun.direction + gun.angle + facing) + (gun.length / 2) * Math.sin(gun.angle + facing);
                            ctx[1].moveTo(tx, ty);
                            let Ia = facing + gun.angle;
                            ctx[1].arc(tx, ty, entity.size * ratio * gun.length * 6, Ia - 0.3, Ia + 0.3);
                        }
                    }
                }
                ctx[1].globalAlpha = 1;
                ctx[1].fillStyle = global.advanced.blackout.color;
                ctx[1].globalCompositeOperation = "destination-in";
                ctx[1].fill();
                ctx[1].globalCompositeOperation = "destination-over";
                ctx[1].fillRect(0, 0, global.screenWidth, global.screenHeight);
                ctx[1].globalCompositeOperation = "source-over";
            } else {
                ctx[1].globalAlpha = 1;
                ctx[1].fillStyle = global.advanced.blackout.color;
                ctx[1].fillRect(0, 0, global.screenWidth, global.screenHeight);
            }
        }
    }

    function drawUpgradeTree() {
        if (global.died) { global.tankTree("exit"); return; }
        if (!treeUi.opened()) treeUi.open();
        treeUi.draw(ctx[2], global.screenWidth, global.screenHeight);
    }

    // Bottom of the top-centre message stack, refreshed every frame by
    // drawMessages and read by drawMilestones so the two can't overlap.
    let messageStackBottom = 0;
    // the last few raid toasts: a broadcast of the same words stays out of the stack
    const recentToasts = new Map();
    let lastToastSeen = "";
    function toastSaid(text) {
        const t = global.royale && global.royale.toast;
        const now = Date.now();
        if (t && t !== lastToastSeen) { lastToastSeen = t; recentToasts.set(t, now); if (recentToasts.size > 8) recentToasts.delete(recentToasts.keys().next().value); }
        if (t && t === text) return true;
        const at = recentToasts.get(text);
        if (at != null && now - at < 20000) return true;
        // the plate in the middle has it ("Final minutes of this raid")
        for (const c of (global.callouts || [])) if (c.text && c.text.length > 8 && text.startsWith(c.text)) return true;
        return false;
    }
    // ── side cards: an achievement, growing a size. One at a time on the
    // right, a few seconds each, queued.
    const sideNotes = [];
    const SIDE_MS = 4200;
    global.sideNote = (n) => { if (!n || !n.title) return; sideNotes.push({ kind: n.kind || "", id: n.id || "", title: String(n.title), sub: n.sub ? String(n.sub) : "", at: 0, ach: n.ach || null, dur: n.dur || 0 }); if (sideNotes.length > 5) sideNotes.shift(); };
    // QA and socketinit's 'ACH': achievementCard.js queues them (and holds
    // all but First Steps in newcomer stage 0)
    window.dwAch = (d) => achCard.receive(d);
    const achPaths = new Map();
    function achPath(id) {
        let p = achPaths.get(id);
        if (p !== undefined) return p;
        p = null;
        const a = ACH_BY_ID.get(id);
        if (a && typeof Path2D === "function") {
            p = new Path2D();
            for (const part of a.d) {
                if (part.startsWith("circle:")) { const [x, y, rr] = part.slice(7).split(",").map(Number); p.moveTo(x + rr, y); p.arc(x, y, rr, 0, Math.PI * 2); }
                else if (part.startsWith("rect:")) { const [x, y, w, h] = part.slice(5).split(",").map(Number); p.rect(x, y, w, h); }
                else p.addPath(new Path2D(part));
            }
        }
        achPaths.set(id, p);
        return p;
    }
    // cx: centred in the lane under the clock (Royale); else the right edge
    function drawSideNote(y, cx) {
        const now = performance.now();
        achCard.pump(sideNotes);
        let n = sideNotes[0];
        while (n && n.at && now - n.at > (n.dur || SIDE_MS)) { sideNotes.shift(); n = sideNotes[0]; }
        if (!n || global.died) return y;
        if (!n.at) n.at = now;
        const age = now - n.at;
        // an achievement: its own card (achievementCard.js)
        if (n.kind === "ach" && n.ach) { n.centreX = cx != null ? cx : null; return y + achCard.draw(ctx[2], n, global.screenWidth - HUD.edge, y, age, n.dur || SIDE_MS) + 10; }
        const a = Math.min(1, age / 200, (SIDE_MS - age) / 300);
        const c = ctx[2];
        // phones: the title only, the thumbs need that side
        if (global.mobile && n.sub && n.kind !== "ach") n.sub = "";
        const tw = hudTitleW(n.title, 15), sw = n.sub ? hudTextW(n.sub, 10.5) : 0;
        const W = Math.round(Math.max(tw, sw) + 58), H = n.sub ? 42 : 30;
        const slide = Math.max(0, 1 - age / 200);
        const x = cx != null ? Math.round(cx - W / 2) : global.screenWidth - HUD.edge - W + Math.round(slide * slide * 40);
        hudPanel(c, x, y, W, H, { alpha: a });
        // the medal: the achievement's colour with its glyph in ink, or an up chevron
        const ix = x + 21, iy = y + H / 2, ir = 12;
        const ach = n.kind === "ach" ? ACH_BY_ID.get(n.id) : null;
        c.save();
        c.globalAlpha *= a;
        c.beginPath(); c.arc(ix, iy, ir, 0, Math.PI * 2);
        c.fillStyle = ach ? ach.color : n.kind === "grow" ? HUD.emerald : HUD.gold; c.fill();
        c.lineWidth = 2; c.strokeStyle = HUD.ink; c.stroke();
        c.strokeStyle = HUD.ink; c.lineCap = "round"; c.lineJoin = "round";
        const gp = ach ? achPath(ach.id) : null;
        if (gp) { c.translate(ix - 8.5, iy - 8.5); c.scale(17 / 24, 17 / 24); c.lineWidth = 2.6; c.stroke(gp); }
        else { c.lineWidth = 3; c.beginPath(); c.moveTo(ix - 5, iy + 3); c.lineTo(ix, iy - 3); c.lineTo(ix + 5, iy + 3); c.stroke(); }
        c.restore();
        if (n.sub && n.kind === "ach") {
            // "Achievement unlocked" as the label, the medal's name under it
            drawText(n.sub, x + 40, y + 13, 10.5, HUD.text2, "left", true, a);
            hudTitle(n.title, x + 40, y + 29, 15, HUD.head, "left", a);
        } else if (n.sub) {
            hudTitle(n.title, x + 40, y + 14, 15, HUD.head, "left", a);
            drawText(n.sub, x + 40, y + 30, 10.5, HUD.text2, "left", true, a);
        } else hudTitle(n.title, x + 40, y + H / 2, 15, HUD.head, "left", a);
        return y + H + 10;
    }
    // ...and the left edge of the right-hand (Royale) stack, for the Raid
    // Night callout; screenWidth when nothing is showing
    let messageStackLeft = 1e9;

    function drawMessages(spacing, alcoveSize) {
        // the first seconds: the stack waits for the raid card (held, not lost) (round 8
        // playtest 9: the raid card (FRESH START) and the results / champion
        // screen hold it too, on every screen; lines held through the results
        // are old news once it goes (the finale said it) and drop
        const finHold = raidFinale.active();
        if (!firstSeconds.shows("messages") || global.introCardUp || finHold || (global.mobile && slamShowing())) {
            const t0 = Date.now();
            for (const m of global.messages) { m.time = t0; if (finHold && !m.finAt) m.finAt = t0; }
            return;
        }
        for (const m of global.messages) if (m.finAt) { if (Date.now() - m.finAt > 6000) m.duration = 0; m.finAt = 0; }
        // Royale: these lines go through the one lane under the raid clock
        // (laneMessage in drawHudNotes), one at a time, never the right edge
        if (typeof royaleActive === "function" && royaleActive()) {
            messageStackBottom = hudTopBottom || 0;
            messageStackLeft = 1e9;
            return;
        }

        let height = 18;
        let x = global.screenWidth / 2;
        let y = spacing + 5;
        // touch: under the button row
        if (global.mobile) y = Math.max(y, 60 * touchUnits());
        // Royale: stack runs top-right under the kill feed so the raid
        // clock and storm timer keep top-center to themselves.
        const msgRight = typeof royaleActive === "function" && royaleActive();
        if (msgRight) {
            const feedN = Math.min(6, ((global.royale && global.royale.feed) || []).length);
            y = Math.max(42 + feedN * 18 + 12, (royaleFeedBottom || 0) + 12);
        }
        // touch: the minimap owns the top-right corner, the stack starts under it
        if (global.mobile && msgRight && hudDrawn.minimap) y = Math.max(y, hudDrawn.minimap.y + hudDrawn.minimap.h + 16, global.screenHeight > global.screenWidth ? hudTopBottom + 10 : 0);
        // ...and the HP / shield bars under it (drawVitals)
        if (global.mobile && msgRight && vitalsRect) y = Math.max(y, vitalsRect.y + vitalsRect.h + 8);
        // round 11: and under any card or banner already up in the right
        // column (a perk banner, a coach card), so a spawn message never sits on one
        if (msgRight) {
            try {
                const colX = global.screenWidth - 320, rs = hudAvoidRects();
                for (let pass = 0; pass < 2; pass++) for (const r of rs) {
                    if (!r || r === vitalsRect || r.x + r.w < colX || r.y > y + 4 || r.y + r.h <= y) continue;
                    if (r.y + r.h > global.screenHeight * 0.6) continue;
                    y = r.y + r.h + 8;
                }
            } catch (e) { /* */ }
        }

        var Bd = Date.now();
        var yy = config.animationSettings.ScaleBar;
        // side cards (an achievement, growing) head the stack, one at a time
        const ySide = y;
        if (msgRight) y = drawSideNote(y);
        // the right-hand stack stops above the minimap instead of running into it
        // (touch: above the kit buttons)
        const yLimit = !msgRight ? Infinity : global.mobile ? touchRightTop() - 30 : Math.min(global.screenHeight - alcoveSize - spacing - 22 - 30, vitalsRect ? vitalsRect.y - 8 : Infinity);
        // and holds three toasts at most (a side card counts as one): the rest
        // queue, oldest first, with their clocks held, and a long queue drops
        // its oldest waiting lines
        if (msgRight) {
            const cap = y > ySide ? 2 : 3, QUEUE_MAX = 4;
            let live = 0;
            const waiting = [];
            for (const m of global.messages) {
                m.wait = false;
                if (m.duration - (Bd - m.time) <= 0 || toastSaid(m.text)) continue;
                if (++live > cap) { m.wait = true; m.time = Bd; waiting.push(m); }
            }
            for (let i = 0; i < waiting.length - QUEUE_MAX; i++) { waiting[i].wait = false; waiting[i].duration = 0; }
        }
        let stackLeft = global.screenWidth;
        for (let i = global.messages.length - 1; i >= 0; i--) {
            let msg = global.messages[i],
                txt = msg.text,
                time = Bd - msg.time,
                duration = msg.duration - time,
                text = txt;

            if (0 >= duration) {
                 global.messages.splice(i, 1);
                 continue;
            }
            if (msg.wait) continue;
            if (y > yLimit) continue;
            // the toast pill up top says it (or said it a moment ago)
            if (msgRight && toastSaid(msg.text)) {
                msg.duration = Math.min(msg.duration, time);
                continue;
            }
            // touch: long lines wrap instead of running across the screen
            if (global.mobile && !msg.textJSON && !msg.wrapped) {
                msg.wrapped = true;
                const maxW = global.screenWidth * (global.screenHeight > global.screenWidth ? 0.8 : 0.4);
                if (measureText(text, height - 4.3) > maxW) msg.textJSON = wrapLines(text, height - 4.3, maxW).slice(0, 3);
            }
            let K = Math.max(0, Math.min(1, time / 300, duration / 300));
            if (msg.textJSON) {
                let len = 0;

                msg.textJSON.forEach((txt) => {
                    if (len < measureText(txt, height - 4.25, false)) len = measureText(txt, height - 4.25, false)
                })
                const jx = msgRight ? global.screenWidth - HUD.edge - 10 - len : x - len / 2;
                if (msgRight && jx - 10 < stackLeft) stackLeft = jx - 10;
                hudPanel(ctx[2], jx - 10, y + yy / 2 - height / 2 - 1, len + 20, height + 2 + 17.5 * (msg.textJSON.length - 1), { alpha: K, r: 8, lw: 2, lip: 2, bevel: false });
                ctx[2].globalAlpha = K;

                msg.textobjs = [];
                msg.textJSON.forEach((txt) => {
                    msg.textobjs[msg.textobjs.length] = function () { };
                    drawText(txt, jx + 2, y + 16 + 17.5 * (msg.textobjs.length - 1), height - 4.3, color.guiwhite, "left", false, 1, 5.5);
                })
                y += 28 * K + 17.5 * (3 - 2 * K) * (msg.textJSON.length - 1) * K * K;
            } else {

                if (msg.len == null) msg.len = measureText(text, height - 4.3);

                const bx = msgRight ? global.screenWidth - HUD.edge - 10 - msg.len : x - msg.len / 2;
                if (msgRight && bx - 10 < stackLeft) stackLeft = bx - 10;
                hudPanel(ctx[2], bx - 10, y + yy / 2 - height / 2 - 2, msg.len + 20, height + 4, { alpha: K, r: 8, lw: 2, lip: 2, bevel: false });

                ctx[2].globalAlpha = K;
                drawText(text, bx + msg.len / 2, y + yy / 1.3, height - 4.3, color.guiwhite, "center", false, 1, 5.5);
                y += 28 * (3 - 2 * K) * K * K;
            }
        }
        // remember where the stack ended so the milestone cards sit under it
        messageStackBottom = y;
        messageStackLeft = stackLeft;
        ctx[2].globalAlpha = 1;
    }

    // ── overhead stack ──────────────────────────────────────────────────
    // Everything over a tank, bottom up: the hull, the name + rank badge (and
    // score), the partner chevron or ONE tag (bounty, revenge, hunted,
    // streak), then a crown. Each piece
    // asks for the top of what sits under it, so nothing overlaps at any
    // tank size or zoom.
    // the top of the hull and the name block (no streak badge)
    function nameStackTop(instance, y, ratio, isize) {
        const size = isize * ratio, g = Math.max(20, size);
        const m = global.mockups[parseInt(String(instance.index).split("-")[0])] || global.missingno[0];
        const realSize = m && m.size ? (size / m.size) * m.realSize : size;
        let top = y - Math.max(realSize, size) - 3;
        if (instance.id === gui.playerid || !instance.nameplate) return top;
        if (m && m.className && String(m.className).startsWith("royale")) return Math.min(top, y - size - 44);
        if (global.GUIStatus.renderPlayerNames) {
            const ny = y - g * (global.GUIStatus.renderPlayerScores ? 1.9 : 1.45);
            // far plates are drawn smaller (drawName sets _plateK this frame)
            const pk = instance._plateK || 1;
            top = Math.min(top, ny - 0.56 * g * pk);            // name cap height and the badge top
            if (isDuoMate(instance.id)) top = Math.min(top, mateChevronTop(ny, g, pk));  // the partner chevron
        } else if (global.GUIStatus.renderPlayerScores) top = Math.min(top, y - 1.75 * g);
        return top;
    }
    // duos: your partner (their plate carries the team chevron, and nothing else over it)
    function isDuoMate(id) {
        const r = global.royale, dm = r && r.duos && r.duo && r.duo.mate;
        return !!(dm && dm.id === id);
    }
    // The partner chevron: a small team-colour "v" pointing down at the name.
    // ds is its width; the tip sits a small gap over the name's cap height.
    // (function declarations, so they are hoisted: no TDZ whatever calls first)
    function mateChevronSize(g, pk) { return Math.max(7, 0.34 * g * pk); }
    function mateChevronTip(ny, g, pk) { return ny - 0.52 * g * pk - 2; }
    function mateChevronTop(ny, g, pk) { return mateChevronTip(ny, g, pk) - mateChevronSize(g, pk) * 0.62 - 2; }
    function drawMateChevron(c, x, ny, g, pk) {
        const ds = mateChevronSize(g, pk), tip = mateChevronTip(ny, g, pk), h = ds * 0.62;
        c.save();
        c.lineJoin = "round";
        c.beginPath();
        c.moveTo(x - ds / 2, tip - h);
        c.lineTo(x, tip - h * 0.42);
        c.lineTo(x + ds / 2, tip - h);
        c.lineTo(x, tip);
        c.closePath();
        c.lineWidth = Math.max(1.5, ds * 0.22);
        c.strokeStyle = HUD.ink;
        c.stroke();
        c.fillStyle = playerHexCol() || HUD.sky;
        c.fill();
        c.restore();
    }
    // Marked streakers (RY pings, 4+ kills in a row): id -> streak, rebuilt
    // only when a new packet brings a new list.
    const streakById = new Map();
    let streakSrc = null;
    function streakOf(id) {
        if (!royaleActive() || raidFinale.active()) return 0;
        const pings = global.royale.pings;
        if (pings !== streakSrc) {
            streakSrc = pings;
            streakById.clear();
            if (pings) for (let i = 0; i < pings.length; i++) streakById.set(pings[i].id, pings[i].streak | 0);
        }
        return streakById.get(id) || 0;
    }
    // Raid points per entity id, from the standings (RY board), as the plate label
    const boardLabelById = new Map();
    let boardLabelSrc = null;
    function boardScoreLabel(id) {
        const board = global.royale && global.royale.board;
        if (board !== boardLabelSrc) {
            boardLabelSrc = board;
            boardLabelById.clear();
            if (board) for (let i = 0; i < board.length; i++) {
                const row = board[i];
                // a tank with no points yet carries just its name ("0 pts" under every fresh plate was noise)
                if (row && row.id != null && (row.score | 0) > 0) boardLabelById.set(row.id, fmtNum(row.score | 0) + " pts");
            }
        }
        return boardLabelById.get(id) || "";
    }
    // The badge over a tank: your revenge target, the bounty, or a streak.
    const streakBadges = new Map();
    const REVENGE_BADGE = { key: "rv", word: "REVENGE", num: "", col: "#ff4b4b", icon: "skull" };
    // a tank far beyond a new or struggling player: the server flags it
    const TOUGH_BADGE = { key: "tough", word: "TOO STRONG", num: "", col: "#b9b2c8", icon: "skull" };
    let bountyBadge = null;
    // HUD is defined further down, so its gold is read on first use)
    let BOUNTY_ON_YOU = null;
    function badgeOf(id) {
        if (!royaleActive() || raidFinale.active()) return null;
        const r = global.royale;
        // ONE tag over a tank (Oct 6, the plates were cluttered), by priority:
        // your duo partner's chevron (drawName) > a crown > the bounty > revenge / too
        // strong > hunted > a streak
        if (isDuoMate(id)) return null;
        // a tag is about other players: never one on your own tank (Oct 7)
        if (id === gui.playerid) return null;
        // a worn crown is the one thing over that tank (crown > bounty > streak)
        try { if (crowns.overheadH(id, 1, 1) > 0) return null; } catch (e) { /* */ }
        const b = r.bounty;
        if (b && b.e === id) {
            // TOO STRONG is about someone else: never on your own tank (you can be the bounty
            if (r.you && r.you.bt && id !== gui.playerid) return TOUGH_BADGE;
            // on your own tank it's the price on your head, not a reward, and a tiny "+"
            if (id === gui.playerid) return BOUNTY_ON_YOU || (BOUNTY_ON_YOU = { key: "btme", word: "BOUNTY ON YOU", num: "", col: HUD.gold, icon: "target" });
            // the leader bounty (lead: 1) stays on whoever leads, no countdown
            const key = "bt" + (b.lead ? "L" : "") + (b.gems | 0);
            if (!bountyBadge || bountyBadge.key !== key) bountyBadge = { key, word: b.lead ? "LEADER BOUNTY " : "BOUNTY ", num: "", col: HUD.gold, icon: "target" };
            return bountyBadge;
        }
        const rv = r.you && r.you.revenge;
        if (rv && rv.alive && rv.e === id && id !== gui.playerid) return rv.tough ? TOUGH_BADGE : REVENGE_BADGE;
        const hb = raidHeat.badge(id);
        if (hb) return hb;
        const n = streakOf(id);
        if (!n) return null;
        let bd = streakBadges.get(n);
        if (!bd) { bd = { key: "s" + n, word: "STREAK ", num: String(n), col: "#ff9a2e", streak: n, icon: "flame" }; streakBadges.set(n, bd); }
        return bd;
    }
    // the name stack plus the badge over it: where a crown sits
    // (the tag is an icon on the name row since Oct 7, so it adds no height;
    // a tank with no name drawn, like your own, has it just over the hull)
    function crownStackTop(instance, y, ratio, isize) {
        const top = nameStackTop(instance, y, ratio, isize);
        if (tagOnName(instance) || !badgeOf(instance.id)) return top;
        return top - selfTagD(isize, ratio) - 4;
    }
    function tagOnName(instance) { return instance._nameAt === overheadFrame && instance.id !== gui.playerid; }
    function selfTagD(isize, ratio) { return Math.max(20, Math.min(34, 0.65 * Math.max(20, isize * ratio))); }
    function overheadTop(instance, y, ratio, isize) {
        const top = crownStackTop(instance, y, ratio, isize);
        // a crown over it (the Crown Contest): the stack's top is over that
        if (royaleActive() && crowns.crownOf(instance.id)) return top - crowns.overheadH(instance.id, isize, ratio);
        return top;
    }
    // the ids whose badge drew this frame; the edge marker skips them
    const streakShownAt = new Map();
    let overheadFrame = 0;
    // your own overhead stack's top this frame (screen units), for the gem pops
    const selfOver = { top: 0, at: -1, x: 0, y: 0, r: 0 };
    // Oct 7: the tag is a small icon on the name row (red skull = your revenge,
    // grey skull = too strong, target = hunted / top target, flame + count =
    // a streak), right of the name; on your own tank (no name) beside the hull.
    // Nothing stacks over the name for it.
    const tagIcons = new Map();
    function tagIconSprite(bd, want) {
        const bake = Math.max(12, Math.min(72, Math.round(want / 2) * 2));
        const sk = bd.key + "@" + bake;
        let spr = tagIcons.get(sk);
        if (spr) return spr;
        const d = bake, ow = Math.max(1.5, d * 0.1), pad = Math.ceil(ow + 1);
        const num = bd.icon === "flame" ? bd.num : "";
        const cv = document.createElement("canvas");
        let c = cv.getContext("2d");
        const fs = Math.round(d * 0.72);
        c.font = fs + "px " + HUD.font;
        const nw = num ? Math.ceil(c.measureText(num).width) + Math.round(d * 0.12) : 0;
        cv.width = d + nw + pad * 2; cv.height = d + pad * 2;
        c = cv.getContext("2d");
        c.lineJoin = "round"; c.lineCap = "round";
        const cx = pad + d / 2, cy = pad + d / 2, r = d / 2;
        const ink = HUD.ink;
        if (bd.icon === "skull") {
            // cranium and jaw in one outline, then the eyes and nose cut in ink
            c.beginPath();
            c.arc(cx, cy - r * 0.12, r * 0.78, Math.PI * 0.82, Math.PI * 2.18);
            c.lineTo(cx + r * 0.46, cy + r * 0.86);
            c.lineTo(cx - r * 0.46, cy + r * 0.86);
            c.closePath();
            c.lineWidth = ow * 2; c.strokeStyle = ink; c.stroke();
            c.fillStyle = bd.col; c.fill();
            c.fillStyle = ink;
            c.beginPath(); c.ellipse(cx - r * 0.32, cy - r * 0.1, r * 0.2, r * 0.24, 0, 0, Math.PI * 2); c.fill();
            c.beginPath(); c.ellipse(cx + r * 0.32, cy - r * 0.1, r * 0.2, r * 0.24, 0, 0, Math.PI * 2); c.fill();
            c.beginPath(); c.moveTo(cx, cy + r * 0.2); c.lineTo(cx - r * 0.1, cy + r * 0.38); c.lineTo(cx + r * 0.1, cy + r * 0.38); c.closePath(); c.fill();
            c.lineWidth = Math.max(1, ow * 0.7);
            for (const k of [-0.2, 0, 0.2]) { c.beginPath(); c.moveTo(cx + r * k, cy + r * 0.62); c.lineTo(cx + r * k, cy + r * 0.86); c.stroke(); }
        } else if (bd.icon === "target") {
            const top = /TOP/.test(bd.word);
            // TOP TARGET in gold, so it reads apart from a plain hunted mark
            if (top) bd = { ...bd, col: "#ffc93c" };
            c.lineWidth = ow * 2; c.strokeStyle = ink;
            c.beginPath(); c.arc(cx, cy, r * 0.8, 0, Math.PI * 2); c.stroke();
            c.lineWidth = ow * 1.1; c.strokeStyle = bd.col;
            c.beginPath(); c.arc(cx, cy, r * 0.8, 0, Math.PI * 2); c.stroke();
            if (top) { c.beginPath(); c.arc(cx, cy, r * 0.48, 0, Math.PI * 2); c.lineWidth = ow * 2; c.strokeStyle = ink; c.stroke(); c.lineWidth = ow * 1.1; c.strokeStyle = bd.col; c.stroke(); }
            // the crosshair ticks and the centre dot
            for (let k = 0; k < 4; k++) {
                const a = k * Math.PI / 2, ca = Math.cos(a), sa = Math.sin(a);
                c.beginPath(); c.moveTo(cx + ca * r * 0.55, cy + sa * r * 0.55); c.lineTo(cx + ca * r * 0.98, cy + sa * r * 0.98);
                c.lineWidth = ow * 2; c.strokeStyle = ink; c.stroke(); c.lineWidth = ow * 1.1; c.strokeStyle = bd.col; c.stroke();
            }
            c.beginPath(); c.arc(cx, cy, r * 0.2, 0, Math.PI * 2); c.lineWidth = ow * 1.4; c.strokeStyle = ink; c.stroke(); c.fillStyle = bd.col; c.fill();
        } else {
            // a flame: an outer tongue, then a lighter core
            const flame = (k) => {
                c.beginPath();
                c.moveTo(cx, cy - r * 0.95 * k);
                c.bezierCurveTo(cx + r * 0.25 * k, cy - r * 0.5 * k, cx + r * 0.85 * k, cy - r * 0.1 * k, cx + r * 0.62 * k, cy + r * 0.45 * k);
                c.bezierCurveTo(cx + r * 0.45 * k, cy + r * 0.9 * k, cx - r * 0.45 * k, cy + r * 0.9 * k, cx - r * 0.62 * k, cy + r * 0.45 * k);
                c.bezierCurveTo(cx - r * 0.8 * k, cy, cx - r * 0.35 * k, cy - r * 0.35 * k, cx, cy - r * 0.95 * k);
                c.closePath();
            };
            flame(1); c.lineWidth = ow * 2; c.strokeStyle = ink; c.stroke(); c.fillStyle = bd.col; c.fill();
            c.save(); c.translate(0, r * 0.22); flame(0.55); c.fillStyle = "#ffe08a"; c.fill(); c.restore();
            if (num) {
                c.font = "bold " + fs + "px " + HUD.font;
                c.textBaseline = "middle"; c.textAlign = "left";
                const tx = pad + d + Math.round(d * 0.08), ty = cy + d * 0.04;
                c.lineWidth = fs * 0.24; c.strokeStyle = ink; c.strokeText(num, tx, ty);
                c.fillStyle = HUD.head; c.fillText(num, tx, ty);
            }
        }
        spr = { cv, d, pad };
        if (tagIcons.size > 80) tagIcons.clear();
        tagIcons.set(sk, spr);
        return spr;
    }
    // QA: every tag icon on one strip (data URL), to look at without a raid
    window.dwTagIcons = (d = 48) => {
        const list = [REVENGE_BADGE, TOUGH_BADGE, { key: "huQA", word: "HUNTED ", num: "", col: "#ff5a48", icon: "target" }, { key: "tpQA", word: "TOP TARGET ", num: "", col: "#ff5a48", icon: "target" }, { key: "s7", word: "STREAK ", num: "7", col: "#ff9a2e", icon: "flame" }];
        const sp = list.map(b => tagIconSprite(b, d));
        const cv = document.createElement("canvas");
        cv.width = sp.reduce((a, s2) => a + s2.cv.width + 12, 12); cv.height = d + 24;
        const c = cv.getContext("2d"); c.fillStyle = "#3a3340"; c.fillRect(0, 0, cv.width, cv.height);
        let x = 12; for (const s2 of sp) { c.drawImage(s2.cv, x, 12); x += s2.cv.width + 12; }
        return cv.toDataURL();
    };
    function drawStreakBadge(x, y, instance, ratio, alpha, isize) {
        const bd = badgeOf(instance.id);
        if (!bd || alpha < 0.02) return;
        let fade = instance.render.status.getFade();
        fade *= fade;
        if (fade < 0.02) return;
        x += global.screenWidth / 2;
        y += global.screenHeight / 2;
        const c = ctx[1];
        const size = isize * ratio;
        // on the name row (drawName left its right edge this frame), else beside the hull
        const onName = tagOnName(instance);
        const d = onName ? Math.max(14, instance._nameFs * 1.3) : selfTagD(isize, ratio);
        const ds = c._tf ? tfOf(c).a : 1;
        const spr = tagIconSprite(bd, d * ds);
        const k = d / spr.d;
        const w = spr.cv.width * k, h = spr.cv.height * k;
        let bx, by;
        if (onName) { bx = instance._nameRight + d * 0.22 - spr.pad * k; by = instance._nameMid - h / 2; }
        else { const top = nameStackTop(instance, y, ratio, isize); bx = x - d / 2 - spr.pad * k; by = top - 2 - d - spr.pad * k; }
        bx = Math.max(4, Math.min(global.screenWidth - w - 4, bx));
        c.save();
        c.globalAlpha = alpha * alpha * fade * (instance._plateA || 1) * labelAlpha(bx + w / 2, by + h / 2, w, h);
        c.drawImage(spr.cv, Math.round(bx * ds) / ds, Math.round(by * ds) / ds, w, h);
        c.restore();
        if (streakShownAt.size > 64 && !streakShownAt.has(instance.id)) streakShownAt.clear();
        streakShownAt.set(instance.id, overheadFrame);
    }
    function drawHealth(x, y, instance, ratio, alpha, isize) {
        if (!(0.02 > alpha)) {
            let fade = instance.render.status.getFade();
            fade *= fade;
            ctx[1].globalAlpha = fade;

            let size = isize * ratio,
                m = global.mockups[entMockupIndex(instance)];
            if (!m) m = global.missingno[0];
            let realSize = (size / m.size) * m.realSize;

            if (instance.drawsHealth) {
                let health = instance.render.health.get(),
                    shield = instance.render.shield.get();

                x += global.screenWidth / 2;
                y += global.screenHeight / 2;

                if (health < 0.99 || shield < 0.99 && global.GUIStatus.renderhealth) {
                    let col = config.graphical.coloredHealthbars ? gameDraw.mixColors(gameDraw.modifyColor(instance.color), color.guiwhite, 0.5) : color.lgreen;
                    let yy = y + realSize + 14.3 * ratio;
                    let barWidth = 1 * ratio;
                    let barChunk = (config.graphical.barChunk || 0) * ratio;
                    let seperated = config.graphical.separatedHealthbars;

                    ctx[1].globalAlpha = alpha * alpha * fade;

                    drawBar(x - size, x + size, yy, seperated ? barWidth + barChunk * 1.6 : barWidth + barChunk, color.black, ctx[1])

                    drawBar(x - size, x - size + 2 * size * health, seperated ? yy + barWidth * 1.45 : yy, barWidth + barChunk * 0.35, col, ctx[1])

                    if (shield || seperated) {
                        if (!seperated) ctx[1].globalAlpha *= 0.7;
                        ctx[1].globalAlpha *= 0.3 + 0.3 * shield;
                        drawBar(x - size, x - size + 2 * size * shield, seperated ? yy - barWidth * 1.45 : yy, barWidth + barChunk * 0.35, config.graphical.coloredHealthbars ? gameDraw.mixColors(col, color.guiblack, 0.25) : color.teal, ctx[1])
                    }
                    if (gui.showhealthtext) drawText(Math.round(instance.health * 100) + "/100", x, yy + barWidth * 2 + barWidth * config.graphical.separatedHealthbars * 2 + 10, 12 * ratio, color.guiwhite, "center");
                    ctx[1].globalAlpha = alpha;
                }
            }
        }
    }

    // ── Enemy pings: a bobbing red marker at the spot, or an edge marker
    // (inside the HUD-safe frame) when off-screen. Only the nearest few
    // draw; far ones fade. Pings live 20s. ──
    const ENEMY_PING_MAX = 5;
    function drawEnemyPings() {
        const now = performance.now();
        for (let i = global.enemyPings.length - 1; i >= 0; i--) {
            if (now - global.enemyPings[i].at > 20000) global.enemyPings.splice(i, 1);
        }
        if (!global.enemyPings.length || global.died) return;
        const wr = util.getRatio();
        const cx = global.screenWidth / 2, cy = global.screenHeight / 2;
        const mx0 = global.player.renderx, my0 = global.player.rendery;
        const list = global.enemyPings.map(p => ({ p, d: Math.hypot(p.x - mx0, p.y - my0) }))
            .sort((a, b) => a.d - b.d).slice(0, ENEMY_PING_MAX);
        const c = ctx[2];
        for (const { p, d } of list) {
            const age = now - p.at;
            const far = Math.max(0.5, 1 - Math.max(0, d - 2000) / 5000);
            const fade = (age > 19000 ? 1 - (age - 19000) / 1000 : 1) * far;
            const dx = (p.x - mx0) * wr;
            const dy = (p.y - my0) * wr;
            const onScreen = Math.abs(dx) < cx - 40 && Math.abs(dy) < cy - 40;
            if (onScreen) {
                const bob = Math.sin(now / 260 + (p.at % 97)) * 4;
                const r = 23 + 2 * Math.sin(now / 200);
                drawPingDiamond(c, cx + dx, cy + dy - 26 + bob, r, fade);
                // spawn pulse ring
                if (age < 700) {
                    const t = age / 700;
                    c.save();
                    c.globalAlpha = (1 - t) * 0.7;
                    c.strokeStyle = "#eb4034";
                    c.lineWidth = 4.5 * (1 - t) + 1.5;
                    c.beginPath();
                    c.arc(cx + dx, cy + dy, 22 + t * 70, 0, Math.PI * 2);
                    c.stroke();
                    c.restore();
                }
            } else {
                // HUD-safe edge spot, then an outward arrow and the diamond just inside it
                const e = edgePoint(dx, dy);
                const ca = Math.cos(e.ang), sa = Math.sin(e.ang);
                c.save();
                c.globalAlpha = fade;
                c.translate(e.x, e.y);
                c.rotate(e.ang);
                c.fillStyle = "#eb4034"; c.strokeStyle = color.black; c.lineWidth = 2.5; c.lineJoin = "round";
                c.beginPath(); c.moveTo(2, 0); c.lineTo(-10, -9); c.lineTo(-10, 9); c.closePath();
                c.fill(); c.stroke();
                c.restore();
                drawPingDiamond(c, e.x - ca * 32, e.y - sa * 32, 22, fade * 0.95);
            }
        }
    }

    // ── duos: quick pings (G or middle mouse; socketinit 'PG') ─────────
    // A pin at the spot in the ping's colour with its label, a ring on the
    // ground; off screen an edge marker; on the map a pulsing dot. Your own
    // ping draws the same so you can see what your partner sees. 5 s.
    const DUO_PING_MS = 5000;
    const DUO_PING_LABEL = { here: "Here", enemy: "Enemy", gems: "Gems", base: "Base" };
    function duoPingCol(p) {
        return p.kind === "enemy" ? HUD.danger : p.kind === "gems" ? HUD.emerald : p.kind === "base" ? HUD.gold : (playerHexCol() || HUD.sky);
    }
    function liveDuoPings() {
        const now = performance.now();
        const list = global.duoPings;
        for (let i = list.length - 1; i >= 0; i--) if (now - list[i].at > DUO_PING_MS) list.splice(i, 1);
        return list;
    }
    function duoPingAlpha(p, now) {
        const age = now - p.at;
        return age > DUO_PING_MS - 600 ? Math.max(0, (DUO_PING_MS - age) / 600) : 1;
    }
    // the little glyph inside a pin head (and the edge pill)
    function drawPingGlyph(c, x, y, r, kind) {
        c.save();
        c.fillStyle = "#fff3d9"; c.strokeStyle = HUD.ink; c.lineJoin = "round";
        if (kind === "enemy") {
            // crosshair
            c.lineWidth = Math.max(1.6, r * 0.28); c.strokeStyle = "#fff3d9"; c.lineCap = "round";
            c.beginPath(); c.arc(x, y, r * 0.55, 0, Math.PI * 2); c.stroke();
            c.beginPath();
            c.moveTo(x - r * 0.95, y); c.lineTo(x - r * 0.3, y); c.moveTo(x + r * 0.3, y); c.lineTo(x + r * 0.95, y);
            c.moveTo(x, y - r * 0.95); c.lineTo(x, y - r * 0.3); c.moveTo(x, y + r * 0.3); c.lineTo(x, y + r * 0.95);
            c.stroke();
        } else if (kind === "gems") {
            gemPath(c, x, y + r * 0.05, r * 0.8); c.lineWidth = Math.max(1, r * 0.16); c.fill(); c.stroke();
        } else if (kind === "base") {
            polyPath(c, x, y, r * 0.78, 8, Math.PI / 8); c.lineWidth = Math.max(1, r * 0.16); c.fill(); c.stroke();
        } else {
            c.beginPath(); c.arc(x, y, r * 0.42, 0, Math.PI * 2); c.fill();
        }
        c.restore();
    }
    function drawDuoPings() {
        if (!(global.royale && global.royale.duos)) return;
        const list = liveDuoPings();
        if (!list.length) return;
        const now = performance.now();
        const c = ctx[2];
        const wr = util.getRatio();
        const cx = global.screenWidth / 2, cy = global.screenHeight / 2;
        const mx0 = global.player.renderx, my0 = global.player.rendery;
        const placed = [];
        for (const p of list) {
            const a = duoPingAlpha(p, now);
            if (a <= 0) continue;
            const col = duoPingCol(p);
            const age = now - p.at;
            const pop = age < 220 ? 0.6 + 0.4 * (age / 220) + 0.15 * Math.sin((age / 220) * Math.PI) : 1;
            const label = DUO_PING_LABEL[p.kind] || "Here";
            const dx = (p.x - mx0) * wr, dy = (p.y - my0) * wr;
            const sx = cx + dx, sy = cy + dy;
            const onScreen = Math.abs(dx) < cx - 30 && Math.abs(dy) < cy - 50;
            if (onScreen) {
                c.save();
                c.globalAlpha = a;
                // ground rings, one a second
                for (let k = 0; k < 2; k++) {
                    const t = ((age / 1000) + k * 0.5) % 1;
                    c.globalAlpha = a * (1 - t) * 0.8;
                    c.strokeStyle = col; c.lineWidth = 3 * (1 - t) + 1.2;
                    c.beginPath(); c.ellipse(sx, sy, 12 + t * 34, (12 + t * 34) * 0.55, 0, 0, Math.PI * 2); c.stroke();
                }
                // the pin: a head with the glyph, a point on the spot
                const R = 18 * pop, hy = sy - 36 * pop - Math.sin(now / 280) * 2;
                c.globalAlpha = a;
                // teardrop: the sides run tangent into the head, so it's symmetric
                const tipY = sy - 2, d = Math.max(R * 1.25, tipY - hy);
                const al = Math.acos(Math.min(0.999, R / d));
                c.beginPath();
                c.moveTo(sx, tipY);
                c.lineTo(sx + R * Math.cos(Math.PI / 2 + al), hy + R * Math.sin(Math.PI / 2 + al));
                c.arc(sx, hy, R, Math.PI / 2 + al, Math.PI * 2.5 - al);
                c.closePath();
                c.fillStyle = col; c.strokeStyle = HUD.ink; c.lineWidth = 3; c.lineJoin = "round";
                c.fill(); c.stroke();
                c.restore();
                c.save(); c.globalAlpha = a; drawPingGlyph(c, sx, hy, R * 0.72, p.kind); c.restore();
                // label over the pin, the sender under it
                hudTitle(label, sx, hy - R - 12, 17, col, "center", a);
                drawText(p.mine ? "You" : shortName(p.name || "Teammate", 14), sx, sy + 20, 11.5, HUD.text, "center", true, a, 4.5);
            } else {
                const e = edgePoint(dx, dy);
                const who = p.mine ? "" : shortName(p.name || "Mate", 10).toUpperCase() + ": ";
                const d = Math.hypot(p.x - mx0, p.y - my0);
                c.save(); c.globalAlpha = a;
                drawEdgeMarker(c, e, col, "ping:" + p.kind, who + (p.kind === "here" ? "PING" : label.toUpperCase()), fmtDist(d), placed);
                c.restore();
            }
        }
    }
    // minimap / big map: a pulsing dot in the ping colour
    function drawDuoPingsMap(c, T, inside, dotR) {
        if (!(global.royale && global.royale.duos)) return;
        const list = liveDuoPings();
        const now = performance.now();
        for (const p of list) {
            const a = duoPingAlpha(p, now);
            const mx = T.X(p.x), my = T.Y(p.y);
            if (a <= 0 || !inside(mx, my)) continue;
            const col = duoPingCol(p);
            const t = ((now - p.at) / 900) % 1;
            c.save();
            c.globalAlpha = a * (1 - t);
            c.strokeStyle = col; c.lineWidth = 2;
            c.beginPath(); c.arc(mx, my, dotR * (2.4 + 3.2 * t), 0, Math.PI * 2); c.stroke();
            c.globalAlpha = a;
            c.beginPath(); c.arc(mx, my, dotR * 2.3, 0, Math.PI * 2);
            c.fillStyle = col; c.strokeStyle = color.black; c.lineWidth = 2; c.fill(); c.stroke();
            c.restore();
            drawPingGlyph(c, mx, my, dotR * 1.6, p.kind);
        }
    }

    // ── Leader crown on the #1 player (themselves included): three spikes
    // with ball tips on a flat band, in the leader's team colour everywhere
    // it appears (overhead, edge indicator, both maps). Gold is the fallback.
    function crownColor() {
        const t = global.leader && global.leader.team;
        if (t === -1) return gameDraw.getColor("blue");
        if (t === -2) return gameDraw.getColor("red");
        return color.gold;
    }
    function drawCrown(x, y, g, a, c = ctx[1]) {
        const w = 1.05 * g, h = 0.72 * g;
        const sideY = y - h * 0.92;  // outer tip centers
        const midY  = y - h * 1.12;  // center tip sits higher
        const tipR  = 0.155 * g;
        const cc = crownColor();
        c.save();
        c.globalAlpha = a;
        c.lineJoin = "round";
        c.lineCap = "round";
        c.fillStyle = cc;
        c.strokeStyle = cc;
        // body: base → left tip → valley → center tip → valley → right tip
        c.beginPath();
        c.moveTo(x - 0.38 * w, y);
        c.lineTo(x - 0.5 * w, sideY);
        c.lineTo(x - 0.165 * w, y - 0.5 * h);
        c.lineTo(x, midY);
        c.lineTo(x + 0.165 * w, y - 0.5 * h);
        c.lineTo(x + 0.5 * w, sideY);
        c.lineTo(x + 0.38 * w, y);
        c.closePath();
        // fat same-color stroke first = the soft rounded corners
        c.lineWidth = 0.16 * g;
        c.stroke();
        c.fill();
        // the three ball tips, merged into the spikes
        for (const [tx, ty] of [[-0.5 * w, sideY], [0, midY], [0.5 * w, sideY]]) {
            c.beginPath();
            c.arc(x + tx, ty, tipR, 0, Math.PI * 2);
            c.fill();
        }
        c.restore();
    }

    // Which badge a name gets, as a wire code (0 = none). Ranked divisions
    // (codeToDivision) show for everyone; the placement "?" (20) only on your own
    // name, so a new account sees its rank is on its way.
    function nameBadgeCode(code, self) {
        code = code | 0;
        const d = rankBadges.codeToDivision(code);
        return typeof d === "number" || (self && d === "placement") ? code : 0;
    }
    // Room a badge takes left of a name (badge + gap), so callers can centre
    // badge and name together.
    // bk: badge height in font sizes (1.25 on the HUD, smaller on world plates)
    function nameBadgeRoom(code, size, bk = 1.25) { return code ? (bk + 0.4) * size : 0; }
    // Rank badge just left of a name drawn by drawText (code from
    // nameBadgeCode). The badge is bk x the font size and centred on the
    // text's own middle, which drawText puts 0.35 of a size above y unless
    // centred. tw: the text's width when the caller has it. Returns the
    // width it took (0 when nothing drew).
    function drawNameBadge(code, text, x, y, size, align = "center", c = ctx[2], centered = false, bk = 1.25, tw = -1) {
        code = code | 0;
        if (!code) return 0;
        const fs = size + config.graphical.fontSizeBoost;
        const bh = bk * size;
        if (tw < 0) tw = align === "left" ? 0 : measureText(text, size);
        // drawText's glyphs start size/20 left of the measured box
        const left = (align === "center" ? x - tw / 2 : align === "right" ? x - tw : x) - 0.05 * fs;
        const cy = centered ? y - 0.035 * fs : y - 0.35 * fs;
        rankBadges.drawBadge(c, left - bh * 0.5 - size * 0.4, cy, bh, rankBadges.codeToDivision(code));
        return nameBadgeRoom(code, size, bk);
    }

    // Name style (accounts): what drawText should draw for a name and with
    // which fill. The fill is a colour, or a gradient laid over the exact box
    // drawText will draw the name in (its left edge is size/20 left of x);
    // legendary styles also get their suffix glyph as a colour code. Below
    // 8 px, or with no style, it is the plain colour. `solid` is the colour
    // the name would have had (a Custom Color's own hex rides in there).
    // y / centered are what drawText gets, so vertical fills line up with
    // the letters. It also arms the style's outline and halo for the very
    // next drawText call.
    const nameFillOpts = { still: false, mid: 0, fs: 0 };
    const styledOut = { text: "", fill: null };
    function styledName(name, nid, solid, x, size, align = "left", context = ctx[2], y = 0, centered = false) {
        const st = nid ? cosmetics.nameStyleOf(nid) : null;
        const out = styledOut;
        out.text = name; out.fill = solid;
        if (!st || !name) return out;
        const text = cosmetics.withGlyph(name, st);
        const fs = size + config.graphical.fontSizeBoost;
        const still = !!(global.lowFx || config.graphical.fewerEffects);
        const fx = cosmetics.nameFx(st, { still });
        nameRim = fx.rim;
        nameHalo = fx.halo ? nameGlow : null;
        nameGlow.halo = fx.halo; nameGlow.haloHi = fx.haloHi; nameGlow.haloA = fx.haloA;
        out.text = text;
        if (fs < 8) { out.fill = cosmetics.solidOf(st, solid); return out; }
        const full = measureText(text, size);
        const w = text === name ? full : measureText(name, size);
        const a = align === "center" ? 0.5 : align === "right" ? 1 : 0;
        const o = nameFillOpts;
        o.still = still; o.mid = centered ? y - 0.035 * fs : y - 0.35 * fs; o.fs = fs;
        out.fill = cosmetics.nameFill(context, st, solid, x - full * a - fs / 20, w, o);
        return out;
    }
    const hexOr = (v, dflt) => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v : dflt;

    // A world plate's name, centred on x. A still name style (gradient, rim,
    // halo) is baked once per name / style / size / layer scale into a
    // drawText sprite at device pixels and blitted 1:1 (it went direct before:
    // two halo strokes, a stroke and a pattern fill every frame, soft at the
    // edges). Scrolling or pulsing styles still draw direct. Returns the
    // drawn width (glyph included), so callers needn't measure again.
    function drawPlateName(name, nid, solid, x, y, size, c) {
        const st = nid ? cosmetics.nameStyleOf(nid) : null;
        if (!st || !name) {
            drawText(name, x, y, size, solid, "center", false, 1, true, c);
            return measureText(name, size);
        }
        const s = st.style;
        const still = !!(global.lowFx || config.graphical.fewerEffects);
        const anim = !still && (s.kind === "scroll" || s.kind === "prism" || (!!s.pulse && !config.graphical.noGlow));
        const t = c._tf ? tfOf(c) : null;
        if (anim || !t || t.b || t.c || crispOff || !(t.a > 0)) {
            const sn = styledName(name, nid, solid, x, size, "center", c, y);
            drawText(sn.text, x, y, size, sn.fill, "center", false, 1, true, c);
            return measureText(sn.text, size);
        }
        const sc = spriteScale(t.a), q = spriteSize(size);
        const key = "\u0001" + name + "|" + nid + "|" + q + "|" + solid + "|" + sc + "|" + (config.graphical.noGlow ? 1 : 0) + (still ? 1 : 0);
        let e = textSprites.get(key);
        if (!e) {
            const text = cosmetics.withGlyph(name, st);
            const fs = q + config.graphical.fontSizeBoost;
            const w = measureText(text, q);
            const pad = fs * 0.6 + 4, W = w + pad * 2, H = fs * 2.6 + 8;
            const pw = Math.max(1, Math.ceil(W * sc)), ph = Math.max(1, Math.ceil(H * sc));
            const cv = spriteCanvas(pw, ph);
            const g = cv.getContext("2d");
            g.setTransform(1, 0, 0, 1, 0, 0);
            g.clearRect(0, 0, cv.width, cv.height);
            g.scale(sc, sc);
            const sn = styledName(name, nid, solid, pad, q, "left", g, H / 2);
            drawTextDirect(sn.text, pad, H / 2, q, sn.fill, "left", false, 1, true, g);
            e = { cv, w, W, H, X0: pad, Y0: H / 2, pw, ph, used: textFrame };
            if (textSprites.size > 700) { let n = 0; for (const [kk, old] of textSprites) { textSprites.delete(kk); freeSprite(old); if (++n >= 150) break; } }
            textSprites.set(key, e);
        }
        e.used = textFrame;
        const k = size / q;
        blitSprite(c, t, e.cv, e.pw, e.ph, x - e.w * k * 0.5 - e.X0 * k, y - e.Y0 * k, e.pw / sc * k, e.ph / sc * k);
        return e.w * k;
    }
    // Plates far from the screen centre, or on tiny tanks, step back: smaller
    // and fainter, in three fixed steps (so sprites stay cached). Plain
    // numbers, no consts: nothing here can hit a TDZ.
    function plateStep(x, y, size) {
        const hw = global.screenWidth / 2, hh = global.screenHeight / 2;
        const nd = Math.max(Math.abs(x - hw) / hw, Math.abs(y - hh) / hh);
        let s = nd < 0.62 ? 0 : nd < 0.84 ? 1 : 2;
        if (size < 16 && s < 1) s = 1;
        return s;
    }

    function drawName(x, y, instance, ratio, alpha, isize) {
        if (!(0.02 > alpha)) {
            let fade = instance.render.status.getFade();
            fade *= fade;
            ctx[2].globalAlpha = fade;

            let size = isize * ratio;
            x += global.screenWidth / 2;
            y += global.screenHeight / 2;

            const L = global.leader;
            if (config.game.leaderIndicators && !royaleActive() && L && L.id === instance.id && performance.now() - L.at < 1200) {
                const g = Math.max(20, size);
                const isSelf = instance.id === gui.playerid;
                // above the name/score stack for others; straight above the
                // hull for yourself (your own name isn't drawn)
                const cy = y - g * (isSelf ? 1.7 : (global.GUIStatus.renderPlayerScores ? 2.5 : 2.05)) - 5;
                drawCrown(x, cy + Math.sin(performance.now() / 350) * 0.06 * g,
                          g, alpha * alpha * fade);
            }

            if (instance.id !== gui.playerid && instance.nameplate) {
                var name = instance.name.substring(7, instance.name.length + 1);
                var namecolor = instance.name.substring(0, 7);
                ctx[1].globalAlpha = alpha * alpha * fade;
                // raid bosses: a fixed-size title above the hull, no score line
                const bossMock = global.mockups[parseInt(String(instance.index).split("-")[0])];
                if (bossMock && bossMock.className && String(bossMock.className).startsWith("royale")) {
                    drawText(name.toUpperCase(), x, y - size - 26, 17, namecolor == "#ffffff" ? color.guiwhite : namecolor, "center", false, 1, true, ctx[1]);
                    ctx[1].globalAlpha = 1;
                    return;
                }
                let g = Math.max(20, size);
                // never a plate for a tank whose plate can't be on screen
                if (x < -260 || x > global.screenWidth + 260 || y < -60 || y > global.screenHeight + 3 * g + 20) {
                    ctx[1].globalAlpha = 1;
                    return;
                }
                // far or tiny: smaller and fainter (the tag over it reads these too)
                const step = plateStep(x, y, size);
                const pk = step === 0 ? 1 : step === 1 ? 0.9 : 0.8;
                instance._plateK = pk;
                instance._plateA = step === 0 ? 1 : step === 1 ? 0.8 : 0.62;
                ctx[1].globalAlpha = alpha * alpha * fade * instance._plateA;
                if (global.GUIStatus.renderPlayerNames) {
                    const ny = y - g * (global.GUIStatus.renderPlayerScores ? 1.9 : 1.45);
                    const fsz = 0.55 * g * pk;
                    // name first; the rank badge small, just left of it; the two
                    // centred over the hull as one
                    const bk = 0.95;
                    const code = nameBadgeCode(instance.rankCode, false), nx = x + nameBadgeRoom(code, fsz, bk) / 2;
                    const tw = drawPlateName(name, instance.nameStyle, namecolor == "#ffffff" ? color.guiwhite : namecolor, nx, ny, fsz, ctx[1]);
                    drawNameBadge(code, name, nx, ny, fsz, "center", ctx[1], false, bk, tw);
                    // where the name ends: the tag icon (drawStreakBadge) sits right of it
                    instance._nameRight = nx + tw / 2; instance._nameMid = ny - fsz * 0.36; instance._nameFs = fsz; instance._nameAt = overheadFrame;
                    // won a raid in the last 24 h: a small crown after the name
                    if (royaleActive() && crowns.isChamp(instance.id)) {
                        try { crowns.drawCrownIcon(ctx[1], nx + tw / 2 + 0.5 * g * pk, ny - 0.2 * g * pk, 0.5 * g * pk, "gold", 1); } catch (e) { /* */ }
                        instance._nameRight += 0.75 * g * pk;
                    }
                    // duos: a small chevron in your team colour over your partner
                    // (it takes the tag spot: badgeOf gives a partner no tag)
                    if (isDuoMate(instance.id)) drawMateChevron(ctx[1], x, ny, g, pk);
                }
                if (global.GUIStatus.renderPlayerScores || typeof instance.score === "string") {
                    // raids: the standings' points, never the hull's own XP score (the two disagreed
                    const lbl = typeof instance.score === "string" ? instance.score
                        : royaleActive() ? boardScoreLabel(instance.id) : util.handleLargeNumber(instance.score);
                    if (lbl) drawText(lbl, x, y - 1.45 * g, 0.3 * g, namecolor == "#ffffff" ? color.guiwhite : namecolor, "center", false, 1, true, ctx[1]);
                }
                if (global.showDebug && instance.digWarsGoal) {
                    drawText(`goal: ${instance.digWarsGoal}`, x, y + 1.2 * g, 0.28 * g, color.teal, "center", false, 1, true, ctx[1]);
                }
                ctx[1].globalAlpha = 1;
            }
        }
    }

    function drawSkillBars(spacing, alcoveSize) {
        global.statPanelBox = null;
        // Tutorial: stat bars show only when the lesson allows stats or
        // highlights them (the "find your points" step); otherwise they are
        // hidden, since the server refuses the clicks.
        if (global.tutorialMode) {
            const allow = window.dwTutAllow || "";
            const ui = window.dwTutUi || "";
            if (!allow.includes("stats") && !ui.startsWith("skill") &&
                !ui.startsWith("stat") && ui !== "points") return;
        }
        global.clickables.statBtn.hide();
        // touch: the stats chip and panel (drawTouchStats)
        if (global.mobile) return;

        // the first seconds of a first raid: the bars slide in a few seconds after landing
        // (the raid death card owns the screen: the bars tuck away under it)
        statMenu.set(!firstSeconds.shows("stats") || deathScreenOn() ? 0 : 0 + (global.died || global.statHover || (global.canSkill && !gui.skills.every(skill => skill.cap === skill.amount))));
        // round 12: a tutorial card about the stats keeps the panel all the way
        // in (it used to sit half off-screen, slid out, while the card talked about it)
        if (global.tutorialMode) statMenu.set(1);
        global.clickables.stat.hide();

        let vspacing = STAT_BAR_GAP;
        let height = STAT_BAR_H;
        let gap = 44.5;
        let len = alcoveSize - 10;
        let save = len;
        let x = HUD.edge + (statMenu.get() - 1) * (height + 50 + len * ska(gui.skills.reduce((largest, skill) => Math.max(largest, skill.cap), 0)));
        let y = global.screenHeight - spacing - 5.5 - height;
        let ticker = 11;
        let namedata;
        try {
            namedata = gui.getStatNames(global.mockups[parseInt(gui.type.split("-")[0])].statnames);
        } catch (e) {
            namedata = gui.getStatNames(global.missingno[0].statnames);
        }
        let clickableRatio = global.canvas.height / global.screenHeight / global.ratio;

        const minKeyName = keyLabel("KEY_UPGRADE_MIN", "-");
        // Draw order (bottom → top): Mining Power first as the final stat,
        // then skills[0..9] which map to stats 9..0.
        const order = [];
        if (gui.skills.length > 10) order.push(10);
        for (let i = 0; i < Math.min(10, gui.skills.length); i++) order.push(i);
        for (const i of order) {
            if (i !== 10) ticker--;
            const statIdx = i === 10 ? 10 : ticker - 1;
            let skill = gui.skills[i],
                name = namedata[statIdx],
                level = skill.amount,
                col = color[skill.color],
                cap = skill.softcap,
                maxLevel = skill.cap;

            if (!cap) continue;
            // Tutorial: bars the current lesson is not about are dimmed and
            // take no clicks (the server refuses them anyway).
            const tutLocked = global.tutorialMode && window.dwTutStatOpen && !window.dwTutStatOpen(statIdx);
            ctx[2].globalAlpha = tutLocked ? 0.35 : 1;

            len = save;
            let max = 0,
                extension = cap > max,
                blocking = cap < maxLevel;
            if (extension) {
                max = cap;
            }

            drawBar(x + height / 2, x - height / 2 + len * ska(cap) - 14, y + height / 2, height - 2.8 + config.graphical.barChunk, color.black);
            drawBar(x + height / 2, x + height / 2 + len * ska(cap) - gap, y + height / 2, height - 3, color.grey);
            drawBar(x + height / 2, x + height / 2 + len * ska(level) - gap, y + height / 2, height - 5.5 + config.graphical.barChunk, color.black);
            drawBar(x + height / 2, x + height / 2 + len * ska(level) - gap, y + height / 2, height - 3.5, col);

            if (blocking) {
                ctx[2].lineWidth = 1;
                ctx[2].strokeStyle = color.grey;
                for (let j = cap + 1; j < max; j++) {
                    drawGuiLine(x + len * ska(j) - gap, y + 1.5, x + len * ska(j) - gap, y - 3 + height);
                }
            }

            ctx[2].strokeStyle = color.black;
            ctx[2].lineWidth = 1;
            for (let j = 1; j < level + 1; j++) {
                drawGuiLine(x + len * ska(j) - gap, y + 1.5, x + len * ska(j) - gap, y - 3 + height);
            }

            len = save * ska(max);
            let textcolor = level == maxLevel ? col : !gui.points || (cap !== maxLevel && level == cap) ? color.grey : color.guiwhite;
            // stat name in the HUD display face; light on a maxed (full) bar
            // so it stays readable. Shrinks (cached widths) only if it would
            // run into the key.
            let nameSize = height - 4;
            while (nameSize > 9 && hudTitleW(name, nameSize) > save - 52) nameSize -= 0.5;
            // always light text: grey on a coloured fill can't be read, so a
            // stat you can't upgrade right now just fades a little instead
            const dim = textcolor === color.grey && level != maxLevel;
            hudTitle(name, Math.round(x + len / 2) - 5.5, y + height / 2, nameSize, HUD.head, "center", dim ? 0.72 : 1);

            const keyTxt = statIdx === 10 ? minKeyName : String((statIdx + 1) % 10);
            // fixed column: every key label centred on the same x, so "-"
            // lines up with the digits above it
            drawText("[" + keyTxt + "]", Math.round(x + save * ska(maxLevel) - height * 0.25) - 22, y + height / 2, height - 7, textcolor === color.grey ? HUD.text2 : textcolor, "center", true);
            if (textcolor === color.guiwhite && !tutLocked) {

                global.clickables.stat.place(statIdx, x * clickableRatio, y * clickableRatio, len * clickableRatio, height * clickableRatio);
            }

            if (level) {
                hudTitle("+" + level, Math.round(x + len + 4) - 5.5, y + height / 2, height - 5, col, "left");
            }
            ctx[2].globalAlpha = 1;

            y -= height + vspacing;
        }

        global.clickables.hover.place(0, 0, y * clickableRatio, 0.8 * len * clickableRatio, (global.screenHeight - y) * clickableRatio);
        if (statMenu.get() > 0.5) {
            const panelTop = y + height + vspacing - 2, panelBottom = global.screenHeight - spacing - 3;
            global.statPanelBox = { x: 0, y: panelTop, w: Math.max(0, x + save * ska(gui.skills.reduce((m, sk) => Math.max(m, sk.cap), 0)) + 40), h: panelBottom - panelTop, at: performance.now() };
        }
        if (gui.points !== 0) {

            const ptsX = Math.round(x + len - 2) - 13, ptsY = Math.round(y + height - 4) + 2;
            drawText("x" + gui.points, ptsX, ptsY, 22, color.guiwhite, "right");
            // round 9: Same stats / Random in one row from the panel's left edge, centred on
            const sb = buildBtnLabels.statButtons(global.royale && global.royale.you, gui.points, global.died, global.tutorialMode);
            if (sb.length && royaleActive()) {
                const right = ptsX - measureText("x" + gui.points, 22) - 10;
                const mid = ptsY - 0.35 * (22 + config.graphical.fontSizeBoost) + 3;
                drawStatBuildButtons(sb, right, mid, x + 1, clickableRatio, true);
            }
        }
    }
    // the stat panel's build buttons, right-aligned to `right`, centred on cy
    function drawStatBuildButtons(sb, right, cy, minX, cr, leftAlign = false) {
        let size = 11.5, bh = 20, gap = 6;
        const widthAt = (sz) => { let w = 0; for (const b of sb) w += hudTitleW(b.label, sz) + 16; return w + gap * (sb.length - 1); };
        while (size > 9 && right - widthAt(size) < minX) size -= 0.5;
        let bx = leftAlign ? Math.min(right, minX + widthAt(size)) : right;
        for (let i = sb.length - 1; i >= 0; i--) {
            const b = sb[i], w = hudTitleW(b.label, size) + 16;
            hudButton(ctx[2], bx - w / 2, cy - bh / 2 - 1, w, bh, b.label, { size, type: "statBtn", index: b.i, cr, textCol: HUD.text, r: 6 });
            bx -= w + gap;
        }
    }

    // where the death card is, as fractions of the screen
    function deathCardFrac(x, y, w, h) {
        const f = global.deathCardFrac || (global.deathCardFrac = { x: 0, y: 0, w: 0, h: 0 });
        f.x = x; f.y = y; f.w = w; f.h = h;
    }
    // the raid death card (gameDrawDeadRoyale) is on screen
    function deathScreenOn() {
        return !!(global.died && global.royaleDied && !global.royaleSpectating && !raidFinale.active() && !lastStormCount());
    }
    function deathCardUp() {
        return deathScreenOn() && deathIntroK() > 0;
    }
    function aoNow() { return aoHud.on() || !!global.aoWorld; }
    window.dwAoNow = () => aoNow();
    function deathCalm() { return !!((global.reducedMotion && global.reducedMotion()) || config.graphical.lightSafe); }
    function deathIntroK() {
        const at = global.royaleDiedAt || 0;
        if (!(at > 0) || global.tutorialMode) return 1;
        return deathText.introK(performance.now() - at, deathCalm());
    }
    window.dwDeathIntro = () => ({ k: deathIntroK(), at: global.royaleDiedAt || 0, beat: deathText.introBeat(deathCalm()), fade: deathText.INTRO.fade });
    const BANK_PILL = "#7fb1f2", BANK_PILL_TEXT = "#120e15";
    // the bottom bar's "Tank: <name>" line: your current tank's name, or ""
    const SELF_TANK_LIFT = 18;
    let selfTankFor = null, selfTankLabel = "";
    function selfTankName() {
        if (global.died || !gui.type) return "";
        if (selfTankFor === gui.type && selfTankLabel) return selfTankLabel;
        const m = global.mockups && global.mockups[parseInt(String(gui.type).split("-")[0])];
        selfTankFor = gui.type;
        selfTankLabel = m && m.name ? String(m.name) : "";
        return selfTankLabel;
    }
    function drawSelfInfo(max) {

        // Dig Wars bottom stack (bottom → top): team war bar, wallet row,
        // player name. No level bar: everyone is level 45.
        let width = 440,
            scorewidth = 70,
            scorelength = 0,
            height = 17,
            x = (global.screenWidth - width) / 2,
            y = global.screenHeight - 44 - height;
        const warLive = config.game.warBar && global.war &&
            performance.now() - global.war.at <= 6000;
        if (warLive) y -= 8;
        ctx[2].lineWidth = 10;
        if (global.GUIStatus.renderPlayerKillbar) {
            scorelength = -112.2;
            scorewidth = 160;
            drawBar(x + scorewidth - scorelength, x + width - scorewidth - scorelength, y + height / 2, height - 3 + config.graphical.barChunk, color.black);
            drawBar(x + scorewidth - scorelength, x + width - scorewidth - scorelength, y + height / 2, height - 3, color.grey);
            drawBar(x + scorewidth - scorelength, x - scorelength + width * ((scorewidth / width) + ((width - scorewidth * 2) / width) * (1 ? Math.min(1, gui.__s.getKills()[0] / 1) : 1)), y + height / 2, height - 3.5, color.teal);
            drawText("Kills: " + util.formatKills(...gui.__s.getKills()), x + width / 2 + 0.5 - scorelength, y + height / 2 + 6, 13, color.guiwhite, "center");
            scorelength = 72.5;
            scorewidth = 120;
        }
        // ── Dig Wars wallet row, in the score bar's footprint ────────────
        // Two pills: a gold carried-meter filling with satchel load (blinks
        // red at cap) and a teal banked pill. Modes without GEM data (cap 0)
        // draw the stock score bar.
        if (!global.gems || !(global.gems.cap > 0)) {
            drawBar(x + scorewidth - scorelength, x + width - scorewidth - scorelength, y + height / 2, height - 3 + config.graphical.barChunk, color.black);
            drawBar(x + scorewidth - scorelength, x + width - scorewidth - scorelength, y + height / 2, height - 3, color.grey);
            drawBar(x + scorewidth - scorelength, x - scorelength + width * ((scorewidth / width) + ((width - scorewidth * 2) / width) * (max ? Math.min(1, gui.__s.getScore() / max) : 1)), y + height / 2, height - 3.5, color.green);
            drawText("Score: " + util.formatLargeNumber(Math.round(gui.__s.getScore())), x + width / 2 + 0.5 - scorelength, y + height / 2 + 6, 13, color.guiwhite, "center");
        } else {
            const g = global.gems;
            const rx1 = x + scorewidth - scorelength,
                rx2 = x + width - scorewidth - scorelength,
                ry = y + height / 2,
                capR = (height - 3) / 2,
                mid = rx1 + (rx2 - rx1) * 0.44,
                carX2 = mid - capR - 3,
                bankX1 = mid + capR + 3,
                load = g.cap > 0 ? Math.min(1, g.carried / g.cap) : 0,
                blink = load >= 1 && Math.floor(Date.now() / 160) % 2 === 0;
            const pillH = height + 1;
            hudDrawn.wallet = { x: rx1 - capR, y: ry - pillH / 2, w: rx2 - rx1 + capR * 2, h: pillH };
            hudBar(ctx[2], rx1 - capR, ry - pillH / 2, carX2 - rx1 + capR * 2, pillH, load, blink ? HUD.danger : HUD.gold);
            {
                // text never leaves its pill: shrink to fit
                const carTxt = "Carried: " + util.formatLargeNumber(g.carried | 0);
                let cs2 = 13; while (cs2 > 9 && hudTextW(carTxt, cs2) > (carX2 - rx1) - 10) cs2 -= 0.5;
                drawText(carTxt, (rx1 + carX2) / 2 + 0.5, ry + 6 - (13 - cs2) * 0.35, cs2, color.guiwhite, "center");
            }
            // azurite, the blue gem's light face: clear of the gold Carried
            // pill and the teal HUD accents; it takes ink text
            hudBar(ctx[2], bankX1 - capR, ry - pillH / 2, rx2 - bankX1 + capR * 2, pillH, 1, BANK_PILL);
            {
                // the kept part came from earlier raids: spendable, but not score.
                // Big numbers go short (47.5k), then the kept part drops, so
                // the text never spills out of the pill.
                const room = (rx2 - bankX1) - 10, banked = g.banked | 0, kept = g.kept | 0;
                // "Bank": what you can spend now
                const BL = scoreText.BANK + ": ";
                const tries = kept > 0
                    ? [BL + util.formatLargeNumber(banked) + "  (" + util.formatLargeNumber(kept) + " savings)",
                        BL + shortGems(banked) + " (" + shortGems(kept) + " savings)",
                        BL + util.formatLargeNumber(banked), BL + shortGems(banked)]
                    : [BL + util.formatLargeNumber(banked), BL + shortGems(banked)];
                let bankTxt = tries[tries.length - 1];
                for (const t of tries) if (hudTextW(t, 11) <= room) { bankTxt = t; break; }
                let bs2 = 13; while (bs2 > 9 && hudTextW(bankTxt, bs2) > room) bs2 -= 0.5;
                drawText(bankTxt, (bankX1 + rx2) / 2 + 0.5, ry + 6 - (13 - bs2) * 0.35, bs2, color.guiwhite, "center");
                // what "Bank" means, on hover (it is not the points number)
                if (royaleActive() && !global.mobile && global.canvas && !global.died) {
                    const cr2 = global.canvas.height / global.screenHeight / global.ratio;
                    const mx2 = global.mouse.x / (cr2 * global.ratio), my2 = global.mouse.y / (cr2 * global.ratio);
                    if (mx2 >= bankX1 - capR && mx2 <= rx2 + capR && my2 >= ry - pillH / 2 && my2 <= ry + pillH / 2) queueTip(scoreText.BANK_TIP, scoreText.bankTipBody(aoNow()), (bankX1 + rx2) / 2, ry - pillH / 2, true);
                }
                // above your name, never on it (round 7: "+250 banked · milestone 1,000" sat on
                drawBankPops(global.screenWidth / 2, Math.round(y - 10 - 4) - 1 - 30 - (selfTankName() ? SELF_TANK_LIFT : 0));
            }
            // gemdust (accounts): satchel dust under Carried, balance under Banked
            if (nxShows("cosmetics")) try { dustHud.draw(ctx[2], { carX: (rx1 + carX2) / 2, bankX: (bankX1 + rx2) / 2, y: ry + 19 }, { drawText, measureText }); } catch (e) { /* never break the HUD */ }
        }
        ctx[2].lineWidth = 4;
        var name = global.player.name.substring(7, global.player.name.length + 1);
        // your rank badge (placement "?" included) and name, centred as one
        const myCode = name ? nameBadgeCode(myRankCode(), true) : 0;
        // "Tank: Rhino" in a small line between the name and the wallet row
        const tankName = selfTankName();
        const nameX = Math.round(x + width / 2 + nameBadgeRoom(myCode, 31) / 2) + 1.5, nameY = Math.round(y - 10 - 4) - 1 - (tankName ? SELF_TANK_LIFT : 0);
        if (tankName) {
            let ts = 15; while (ts > 10 && hudTitleW(tankName, ts) > width - 40) ts -= 0.5;
            hudTitle(tankName, Math.round(x + width / 2), Math.round(y - 13), ts, HUD.head, "center");
        }
        const mySn = styledName(name, global.myNameStyle, global.nameColor == "#ffffff" ? color.guiwhite : global.nameColor, nameX, 31, "center", ctx[2], nameY);
        drawText(mySn.text, nameX, nameY, 31, mySn.fill, "center");
        drawNameBadge(myCode, mySn.text, nameX, nameY, 31, "center", ctx[2]);
    }

    // Bank pops (bankPopLogic.js): every rise of the Bank says what paid ("+300
    let bankPopOpt = null;
    function drawBankPops(cx, y0) {
        if (!global.bankPops || !royaleActive() || global.died) return;
        const now = performance.now();
        const list = bankPopLogic.live(global.bankPops, now);
        if (!list.length) return;
        const c = ctx[2];
        let y = y0;
        for (let i = list.length - 1; i >= 0; i--) {
            const p = list[i];
            const age = now - p.at, k = age / bankPopLogic.POP_MS;
            const a = Math.min(1, age / 160) * (k > 0.75 ? Math.max(0, (1 - k) / 0.25) : 1);
            const pop = age < 220 ? 1 + 0.25 * Math.sin(Math.PI * age / 220) : 1;
            const rise = Math.min(1, age / 420) * 10;
            if (p.w == null || p.wFor !== p.str) { p.w = measureText(p.str, 13) + 22; p.wFor = p.str; }
            const sz = 13 * pop, w = Math.round(p.w), h = 22;
            const yy = y - h / 2 - rise;
            if (!bankPopOpt) bankPopOpt = [{ r: 11, bevel: false, stroke: HUD.gold }, { r: 11, bevel: false, stroke: HUD.text2 }];
            c.save();
            c.globalAlpha = a;
            hudPanel(c, Math.round(cx - w / 2), yy - h / 2, w, h, bankPopOpt[p.n < 0 ? 1 : 0]);
            c.restore();
            // drawText sets its glyphs size/20 left of x: put that back so the words sit dead
            drawText(p.str, cx + (sz + config.graphical.fontSizeBoost) / 20, yy, sz, p.n < 0 ? HUD.text : HUD.gold, "center", true, a);
            y -= h + 4;
        }
    }
    window.dwBankPops = () => global.bankPops ? global.bankPops.pops.map(p => p.str) : [];

    // Points pops (scoreLogic.js ptsPops): every change of your points says why ("+60
    let ptsPopOpt = null;
    function drawPtsPops(x0, y0, align, dir = -1) {
        if (!global.ptsPops || !royaleActive()) return;
        const now = performance.now();
        const list = scoreText.ptsLive(global.ptsPops, now);
        if (!list.length) return;
        const c = ctx[2];
        let y = y0;
        if (!ptsPopOpt) ptsPopOpt = [{ r: 11, bevel: false, stroke: HUD.gold }, { r: 11, bevel: false, stroke: "#ff6b5e" }];
        for (let i = list.length - 1; i >= 0; i--) {
            const p = list[i];
            const age = now - p.at, k = age / scoreText.PTS_POP_MS;
            const a = Math.min(1, age / 160) * (k > 0.75 ? Math.max(0, (1 - k) / 0.25) : 1);
            const pop = age < 220 ? 1 + 0.25 * Math.sin(Math.PI * age / 220) : 1;
            if (p.w == null) p.w = measureText(p.str, 13) + 22;
            const w = p.w, h = 22;
            const x = align === "right" ? x0 - w : x0;
            c.save();
            c.globalAlpha = a;
            hudPanel(c, x, y - h / 2, w, h, ptsPopOpt[p.n < 0 ? 1 : 0]);
            c.restore();
            drawText(p.str, x + w / 2, y, 13 * pop, p.n < 0 ? "#ff9a8c" : HUD.gold, "center", true, a);
            y += dir * (h + 4);
        }
    }
    window.dwPtsPops = () => global.ptsPops ? global.ptsPops.pops.map(p => p.str) : [];

    // 47500 -> "47.5k", 1250000 -> "1.25m"
    function shortGems(n) {
        if (n < 10000) return util.formatLargeNumber(n);
        if (n < 1e6) return (Math.floor(n / 100) / 10) + "k";
        return (Math.floor(n / 1e4) / 100) + "m";
    }

    // Your own rank as a wire code (0 guest, 1..19 ranked, 20 placement),
    // from the 'AC' snapshot socketinit keeps current through RK / RKP.
    function myRankCode() {
        const r = global.acct && global.acct.rank;
        if (!r) return 0;
        if (r.division == null) return rankBadges.CODE_PLACEMENT;
        return rankBadges.divisionToCode(r.division);
    }

    // Dig Wars: the vault panel, shown while you stand on your team's pad.
    const vaultGlide = Smoothbar(0, 2, 3, 0.1, 0.025, true);
    const VAULT_MIN_DEPOSIT = 15;
    // A real DOM input for the deposit amount, created once and positioned
    // over the canvas panel each frame.
    let vaultInput = null;
    function getVaultInput() {
        if (vaultInput) return vaultInput;
        const style = document.createElement("style");
        style.textContent = "#vaultInput::-webkit-inner-spin-button,#vaultInput::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}" +
            "#vaultInput::selection{background:#ffd75e55}";
        document.head.appendChild(style);
        vaultInput = document.createElement("input");
        vaultInput.id = "vaultInput";
        vaultInput.type = "text";
        vaultInput.inputMode = "numeric";
        vaultInput.autocomplete = "off";
        vaultInput.style.cssText =
            "position:fixed;display:none;z-index:40;text-align:center;" +
            "background:#1e1924;color:#fff3d9;border:1px solid #120e15;" +
            "border-radius:9px;outline:none;font-family:Rubik,Ubuntu,sans-serif;font-weight:700;" +
            "box-shadow:inset 0 2px 3px rgba(0,0,0,.35);";
        vaultInput.oninput = () => {
            // digits only, clamped to what's actually carried
            let n = vaultInput.value.replace(/[^0-9]/g, "");
            const max = global.gems.carried | 0;
            if (n !== "" && parseInt(n) > max) n = "" + max;
            if (vaultInput.value !== n) vaultInput.value = n;
        };
        vaultInput.onkeydown = (e) => {
            e.stopPropagation();
            if (e.key === "Enter") {
                const n = parseInt(vaultInput.value) || 0;
                if (n >= 1 && global.socket) global.socket.talk('vd', n);
                vaultInput.blur();
                document.getElementById("gameCanvas").focus();
            } else if (e.key === "Escape") {
                vaultInput.blur();
                document.getElementById("gameCanvas").focus();
            }
        };
        // taking focus means the canvas misses keyups: release every held
        // command or a held key keeps driving the tank
        vaultInput.onfocus = () => {
            if (global.socket && global.socket.cmd) {
                for (let i = 0; i < 8; i++) global.socket.cmd.set(i, false);
            }
        };
        document.body.appendChild(vaultInput);
        return vaultInput;
    }
    function hideVaultInput() {
        if (!vaultInput || vaultInput.style.display === "none") return;
        vaultInput.style.display = "none";
        if (document.activeElement === vaultInput) {
            vaultInput.blur();
            document.getElementById("gameCanvas").focus();
        }
    }

    // Deposit channel bar: the HUD bar plus a breathing sheen on the fill and
    // a bright tick at its leading edge, with notches drifting toward it.
    function drawChannelBar(c, bx, by, bw, bh, frac, col, now) {
        hudBar(c, bx, by, bw, bh, frac, col);
        const fw = Math.max(bh, bw * frac);
        c.save();
        roundRectPath(c, bx + 1, by + 1, fw - 2, bh - 2, (bh - 2) / 2);
        c.clip();
        const pulse = 0.5 + 0.5 * Math.sin(now / 420);
        c.fillStyle = "rgba(255,255,255," + (0.05 + 0.07 * pulse).toFixed(3) + ")";
        c.fillRect(bx, by, fw, bh);
        // notches flowing right, like gems pouring into the vault
        c.fillStyle = "rgba(0,0,0,0.16)";
        const gap = 14, off = (now / 60) % gap;
        for (let sx = bx - gap + off; sx < bx + fw; sx += gap) {
            c.beginPath();
            c.moveTo(sx, by + bh);
            c.lineTo(sx + 5, by + bh);
            c.lineTo(sx + 5 + bh * 0.45, by);
            c.lineTo(sx + bh * 0.45, by);
            c.closePath();
            c.fill();
        }
        c.restore();
        if (frac < 0.995) {
            const ex = bx + fw - bh / 2;
            c.save();
            c.fillStyle = "rgba(255,248,225," + (0.75 + 0.25 * pulse).toFixed(3) + ")";
            roundRectPath(c, ex - 1.5, by + 3, 3, bh - 6, 1.5);
            c.fill();
            c.restore();
        }
    }
    const VAULT_CROWN_LINE = "You have a crown, so you'll bank and then get pushed off the vault.";
    // Playtest 9: a player parked on a vault with 8,098 gems for a minute and
    // never saw the panel. Over it, a big gold call: "Press B to bank all N"
    // (touch: "Tap Bank all to bank N"). Bottom edge at `bottom`, centred on cx.
    function drawBankPrompt(c, cx, bottom, allTxt, now, alpha) {
        const touchP = !!global.mobile;
        const lead = touchP ? "Tap Bank all to bank " + allTxt : "or click to bank all " + allTxt;
        const size = 22, keyH = 30;
        const tw = hudTitleW(touchP ? lead : "Press", size) + (touchP ? 0 : 10 + hudTitleW("B", keyH * 0.62) + keyH * 0.55 + 10 + hudTitleW(lead, size));
        const w = Math.min(global.screenWidth - 24, tw + 44), h = 50;
        const calmP = global.reducedMotion && global.reducedMotion();
        const k = calmP ? 1 : 1 + 0.035 * Math.sin(now / 170);
        const y = bottom - h;
        c.save();
        c.globalAlpha *= alpha;
        c.translate(cx, y + h / 2); c.scale(k, k); c.translate(-cx, -(y + h / 2));
        hudPanel(c, cx - w / 2, y, w, h, { fill: "rgba(43,33,20,0.95)", r: 14 });
        c.strokeStyle = HUD.gold; c.lineWidth = 3;
        roundRectPath(c, cx - w / 2 + 1.5, y + 1.5, w - 3, h - 3, 13);
        c.stroke();
        let tx = cx - tw / 2;
        const my = y + h / 2 - 1;
        if (touchP) hudTitle(lead, cx, my, size, HUD.gold, "center", 1, c);
        else {
            hudTitle("Press", tx, my, size, HUD.gold, "left", 1, c);
            tx += hudTitleW("Press", size) + 10;
            tx += hudKey(c, tx, my - keyH / 2, "B", keyH) + 10;
            hudTitle(lead, tx, my, size, HUD.gold, "left", 1, c);
        }
        // a chevron down at the button
        c.fillStyle = HUD.gold;
        c.beginPath(); c.moveTo(cx - 9, y + h - 1); c.lineTo(cx + 9, y + h - 1); c.lineTo(cx, y + h + 9); c.closePath(); c.fill();
        c.restore();
    }
    // a deposit has finished once (this visit or any before, localStorage)
    let vaultTaughtK = null;
    function vaultTaught(v) {
        if (vaultTaughtK === null) { try { vaultTaughtK = window.localStorage.getItem("dwBankTaught_v1") === "1"; } catch (e) { vaultTaughtK = false; } }
        if (!vaultTaughtK && v && v.doneAt > 0 && !global.tutorialMode) {
            vaultTaughtK = true;
            try { window.localStorage.setItem("dwBankTaught_v1", "1"); } catch (e) { /* */ }
        }
        return vaultTaughtK;
    }
    function drawVaultUI() {
        const v = global.vault, g = global.gems;
        if (v && v.doneAt > 0) vaultTaught(v);
        const active = v.total > 0;
        if (!active) v.shownFrac = -1;
        const belowMin = !active && (g.carried | 0) < VAULT_MIN_DEPOSIT;
        // Tutorial: the deposit panel only opens on the pad the lesson is about.
        const tutBank = !global.tutorialMode ||
            (window.dwTutAllow || "").split(",").includes(v.isOutpost ? "bank:base" : "bank:vault");
        const wantOpen = v.onPad && !global.died && tutBank;
        vaultGlide.set(wantOpen ? 1 : 0);
        const glide = vaultGlide.get();
        if (glide < 0.02) {
            global.clickables.vault.hide();
            hideVaultInput();
            v.wasOpen = false;
            return;
        }
        const now = performance.now();
        // a final-minute crown banks like anyone, but the vault won't hold it (server
        const ry = royaleActive() && global.royale.you;
        const crownSd = !!(ry && ry.crown && ry.crown.sd) && !v.isOutpost;
        const H0 = belowMin ? 92 : 168;
        const W = 340, H = H0 + (crownSd ? 24 : 0);
        const x = (global.screenWidth - W) / 2;
        const y = global.screenHeight - 350 + (1 - glide) * 26;
        const cr = global.canvas ? global.canvas.height / global.screenHeight / global.ratio : 1;
        const c = ctx[2];
        // guarded: getColor can return undefined for unmapped indices and
        // mixColors requires hex strings
        let teamCol = gameDraw.getColor(gui.color);
        if (typeof teamCol !== "string" || teamCol[0] !== "#") teamCol = color.gold;

        if (global.mobile) touch.uiRects.vault = { x: x * cr, y: y * cr, w: W * cr, h: H * cr };
        c.save();
        c.globalAlpha = glide;
        hudPanel(c, x, y, W, H, { fill: HUD.solid, r: HUD.r + 2 });
        hudTitle(v.isOutpost ? "Team Bank · 80% credit" : (royaleActive() ? "Vault · 100% credit" : "Team vault"),
                 x + W / 2, y + 19, 17, teamCol, "center");
        // the first Team Bank you stand on says what it is (round 9)
        if (v.isOutpost && buildBtnLabels.firstTime("teamBank", () => window.localStorage)) global.createMessage(buildBtnLabels.TEAM_BANK_TIP, 7000);
        c.fillStyle = "rgba(0,0,0,0.6)";
        c.fillRect(x + 14, y + 33, W - 28, 2);
        drawText(scoreText.BANK + "  " + util.formatLargeNumber(g.banked | 0), x + 16, y + 49, 12, color.teal, "left", true);
        drawText("Carried  " + util.formatLargeNumber(g.carried | 0), x + W - 16, y + 49, 12, HUD.gold, "right", true);

        global.clickables.vault.hide();
        if (belowMin) {
            hideVaultInput();
            drawText("You need at least " + VAULT_MIN_DEPOSIT + " gems to bank.",
                     x + W / 2, y + 70, 12.5, "#ff9a8c", "center");
        } else if (active) {
            // ── channeling: gold progress + live count + cancel ──
            hideVaultInput();
            const target = Math.max(0, Math.min(1, 1 - v.remaining / v.total));
            // the server reports the channel in steps; ease the shown fill
            if (!(v.shownFrac >= 0) || target < v.shownFrac - 0.25 || !v.shownAt) v.shownFrac = target;
            const dt = Math.min(0.1, Math.max(0, (now - (v.shownAt || now)) / 1000));
            v.shownAt = now;
            v.shownFrac += (target - v.shownFrac) * Math.min(1, dt * 8);
            const frac = v.shownFrac;
            const bx = x + 20, bw = W - 40, by = y + 62, bh = 16;
            // raid vaults bank in the vault's own blue
            const chanCol = (royaleActive() && !v.isOutpost) ? BANK_PILL : HUD.gold;
            drawChannelBar(c, bx, by, bw, bh, Math.max(0.04, frac), chanCol, now);
            drawText(util.formatLargeNumber(Math.round(v.total - v.remaining)) + " / " +
                     util.formatLargeNumber(v.total) + "  secured…",
                     x + W / 2, by + bh + 18, 12.5, color.guiwhite, "center");
            hudButton(c, x + W / 2, y + H0 - 33, 110, 26, "Cancel", { fill: HUD.danger, lipCol: HUD.dangerDk, textCol: "#fff", size: 14, type: "vault", index: 11, cr });
        } else {
            // one click (or B) banks everything (the server reads 0 as "all")
            v.bankAllAt = now;
            const allTxt = util.formatLargeNumber(g.carried | 0);
            const touchBig = !!global.mobile;
            // the big "Press B" prompt over the panel teaches the key until your
            // first deposit lands; after that the button carries the key
            const taught = vaultTaught(v);
            hudButton(c, x + W / 2, y + (touchBig ? 54 : 60), W - 40, touchBig ? 54 : 42, (touchBig ? "Bank all " : "Bank all  ") + allTxt + " gems" + (taught && !touchBig ? "  (B)" : ""),
                      { fill: HUD.play, lipCol: HUD.playDk, textCol: "#fff", size: touchBig ? 22 : 18, type: "vault", index: 9, cr });
            if (!taught) drawBankPrompt(c, x + W / 2, y - 14, allTxt, now, glide);
            drawText("or bank part of it", x + W / 2, y + 118, 11, HUD.text2, "center", true);
            const el = getVaultInput();
            const iw = 130, ih = 30;
            const ix = x + W / 2 - 120, iy = y + 126;
            el.style.left = (ix * cr) + "px";
            el.style.top = (iy * cr) + "px";
            el.style.width = (iw * cr - 4) + "px";
            el.style.height = (ih * cr - 4) + "px";
            el.style.fontSize = (15 * cr) + "px";
            el.style.opacity = glide;
            if (el.style.visibility) el.style.visibility = "";
            if (el.style.display === "none") {
                el.style.display = "block";
                el.value = "" + (g.carried | 0);   // defaults to everything
            }
            const dbx = ix + iw + 10, dby = y + 125, dbw = 100, dbh = 32;
            hudButton(c, dbx + dbw / 2, dby, dbw, dbh, "Bank", { fill: HUD.face, lipCol: HUD.faceDk, textCol: HUD.text, size: 15, type: "vault", index: 10, cr });
        }
        if (crownSd) {
            c.fillStyle = "rgba(255,59,78,0.16)";
            c.fillRect(x + 14, y + H0 - 6, W - 28, 24);
            const cl = fitLine(VAULT_CROWN_LINE, 12, 9, W - 40);
            drawText(cl.txt, x + W / 2, y + H0 + 6, cl.qs, "#ffb3bb", "center", true);
        }
        c.restore();
    }

    // Dig Wars: pickup feedback in the WORLD, not the HUD - +N popups float

    function drawGemPopups() {
        const g = global.gems;
        if (!g || !config.game.gemPopups) return;
        const now = performance.now();

        const cx = global.screenWidth / 2, cy = global.screenHeight / 2;

        const ft = (now - g.flashAt) / 380;
        if (ft >= 0 && ft < 1) {
            // Oct 6: brighter and crisper (a gold ring plus a thin cream one
            // inside it); reduced motion keeps it still and just fades it
            const calmFx = !!(global.reducedMotion && global.reducedMotion());
            const fe = calmFx ? 0.4 : 1 - Math.pow(1 - ft, 3);
            const c2 = ctx[2];
            c2.save();
            c2.globalAlpha = (1 - ft) * 0.82;
            c2.strokeStyle = "#ffcf4a";
            c2.lineWidth = 3.5 * (1 - ft) + 0.75;
            c2.beginPath();
            c2.arc(cx, cy, 26 + fe * 30, 0, Math.PI * 2);
            c2.stroke();
            if (ft < 0.6) {
                c2.globalAlpha = (1 - ft / 0.6) * 0.75;
                c2.strokeStyle = "#fff4cf";
                c2.lineWidth = 1.5;
                c2.beginPath();
                c2.arc(cx, cy, 22 + fe * 22, 0, Math.PI * 2);
                c2.stroke();
            }
            c2.restore();
        }

        // +N numbers: rise off the tank and fade
        const stackTop = selfOver.at === overheadFrame ? selfOver.top : cy;
        const base = Math.max(52, cy - stackTop + 18);
        for (let i = g.popups.length - 1; i >= 0; i--) {
            const p = g.popups[i];
            const t = (now - p.born) / 1000;
            if (t >= 1) { g.popups.splice(i, 1); continue; }
            const rise  = base + 42 * (1 - Math.pow(1 - t, 2.2));
            const alpha = t < 0.55 ? 1 : 1 - (t - 0.55) / 0.45;
            const heat  = Math.min(1, (p.combo || 0) / 8);
            const size  = 16 + Math.min(10, p.value / 25) + Math.min(6, (p.combo || 0));
            ctx[2].save();
            ctx[2].globalAlpha = alpha;
            drawText("+" + p.value,
                     Math.round(cx + (p.drift || 0)), Math.round(cy - rise),
                     size, gameDraw.mixColors("#ffd04d", "#ffffff", heat * 0.85), "center");
            ctx[2].restore();
        }
    }

    // Mining combo meter: server-counted chain (2.5s window, up to +50%
    // dust), drawn under the tank with a depleting fuse bar. Starts at ×2.
    function drawMineCombo() {
        const g = global.gems;
        if (!g || !config.game.gemPopups) return;
        const n = g.mcombo | 0;
        if (n < 2) return;
        const now = performance.now();
        const left = 1 - (now - (g.mcomboAt || 0)) / 2500;
        if (left <= 0) return;
        const bonus = Math.min(50, 5 * (n - 1));
        // under your hull and its health bar (a fixed +96 sat on the bar, and
        // inside a grown hull)
        let cy = global.screenHeight / 2 + 96;
        if (selfOver.at >= overheadFrame - 1 && selfOver.r > 0) cy = Math.max(cy, selfOver.y + selfOver.r * 1.45 + 40);
        const cx = global.screenWidth / 2;
        const a = Math.min(1, left * 3) * (raidHeat.slamUp() ? 0.45 : 0.85);
        const c = ctx[2];
        c.save();
        drawText("Mining x" + n + "  ·  +" + bonus + "% gems", cx, cy, 11.5, "#f2d69a", "center", true, a, 4);
        const bw = 80, bx = cx - bw / 2, by = cy + 9;
        c.globalAlpha = a;
        c.fillStyle = "rgba(0,0,0,0.55)";
        c.fillRect(bx - 1, by - 1, bw + 2, 6);
        c.fillStyle = "#ffd75e";
        c.fillRect(bx, by, bw * Math.max(0, left), 4);
        c.restore();
    }

    const leaderArrow = { a: 0, x: 0, y: 0, ang: 0 };
    function drawLeaderArrow() {
        if (royaleActive()) return;
        const L = global.leader, la = leaderArrow;
        if (!config.game.leaderIndicators) { la.a = 0; return; }
        const now = performance.now();
        let target = 0;
        if (L && L.id !== -1 && L.id !== gui.playerid &&
            now - L.at < 1200 && !global.died) {
            const smL = (global._mapSmooth && global._mapSmooth.leader) || L;
            const wr = util.getRatio();
            const dx = (smL.x - global.player.renderx) * wr;
            const dy = (smL.y - global.player.rendery) * wr;
            const cx = global.screenWidth / 2, cy = global.screenHeight / 2;
            const onScreen = Math.abs(dx) < cx - 40 && Math.abs(dy) < cy - 40;
            if (!onScreen) {
                target = 1;
                la.ang = Math.atan2(dy, dx);

                const inset = 28;
                const t = Math.min((cx - inset) / (Math.abs(Math.cos(la.ang)) || 1e-9),
                                   (cy - inset) / (Math.abs(Math.sin(la.ang)) || 1e-9));
                la.x = cx + Math.cos(la.ang) * t;
                la.y = cy + Math.sin(la.ang) * t;
            }
        }
        la.a += (target - la.a) * 0.12;
        if (la.a < 0.02) return;
        const pulse = 1 + 0.06 * Math.sin(now / 280);
        const c = ctx[2];
        c.save();
        c.globalAlpha = la.a * 0.95;
        c.translate(la.x, la.y);
        c.rotate(la.ang);
        c.scale(pulse, pulse);
        // sleek dart: long nose, notched tail
        c.beginPath();
        c.moveTo(16, 0);
        c.lineTo(-10, -11);
        c.lineTo(-4.5, 0);
        c.lineTo(-10, 11);
        c.closePath();
        c.lineWidth = 3.5;
        c.strokeStyle = color.black;
        c.stroke();
        c.fillStyle = color.gold;
        c.fill();
        c.restore();

        drawCrown(la.x - Math.cos(la.ang) * 50,
                  la.y - Math.sin(la.ang) * 50 + 9,
                  28, la.a * 0.95, ctx[2]);
    }

    let warBarFrac = 0.5;
    function drawTeamBankBar() {
        if (royaleActive()) return;
        const w = global.war;
        if (!config.game.warBar || !w) return;
        const now = performance.now();
        if (w.at <= 0 || now - w.at > 6000) return; // no data yet, or stale
        const bw = 440, h = 13,
            x = (global.screenWidth - bw) / 2,
            y = global.screenHeight - 22 - h,
            cy = y + h / 2,
            blue = w.blue | 0, red = w.red | 0,
            total = blue + red;

        // Blue-vs-red share bar (who is ahead right now).
        warBarFrac += ((total > 0 ? blue / total : 0.5) - warBarFrac) * 0.08;
        const f = Math.max(0, Math.min(1, warBarFrac));
        const split = x + bw * f;
        drawBar(x, x + bw, cy, h + config.graphical.barChunk, color.black);
        if (f > 0.003) drawBar(x, split, cy, h - 3, color.blue);
        if (f < 0.997) drawBar(split, x + bw, cy, h - 3, color.red);
        drawBar(x + bw / 2 - 0.8, x + bw / 2 + 0.8, cy, h - 5, "rgba(0,0,0,0.35)");
        drawBar(split - 2.6, split + 2.6, cy, h + 2, color.black);
        drawBar(split - 1.4, split + 1.4, cy, h - 1, color.guiwhite);
        drawText(util.formatLargeNumber(blue), x - 10, cy + 5, 13, color.blue, "right");
        drawText(util.formatLargeNumber(red), x + bw + 10, cy + 5, 13, color.red, "left");
    }

    // Flat player-body hex for tinting your own banners and cards, or null.
    function playerHexCol() {
        // gui.color arrives compiled ("11 0 1 0 false"); modifyColor resolves it
        let h = null;
        try { h = gameDraw.modifyColor(gui.color); } catch (e) { h = null; }
        if (!(typeof h === "string" && h[0] === "#")) { const g2 = gameDraw.getColor(gui.color); h = (typeof g2 === "string" && g2[0] === "#") ? g2 : null; }
        return h;
    }
    window.dwGuiColor = () => ({ color: gui.color, hex: playerHexCol() });
    sidekicks.setColorResolver((c) => {
        let h = null;
        try { h = gameDraw.modifyColor(c); } catch (e) { h = null; }
        if (!(typeof h === "string" && h[0] === "#")) { const g2 = gameDraw.getColor(c); h = (typeof g2 === "string" && g2[0] === "#") ? g2 : null; }
        return h;
    });

    // ═════════════════════════════════════════════════════════════════════
    // HUD look: the menu's plates (home.css), drawn on the canvas. Fine
    // keyline, one top highlight, a soft drop, flat palette fills. Lilita
    // One for titles, Rubik for labels. Every in-game panel, chip, button
    // and bar goes through these helpers. Paths only: no shadows or
    // filters, and per-frame text measurement is cached.
    // ═════════════════════════════════════════════════════════════════════
    const HUD = {
        ink: "#1a1a1a",
        panel: "rgba(0,0,0,0.4)",
        solid: "rgba(18,18,20,0.86)",
        raised: "rgba(0,0,0,0.28)",
        well: "rgba(0,0,0,0.3)",
        wellSolid: "#3a3a3a",
        track: "rgba(0,0,0,0.55)",
        face: "#555555", faceDk: "#3a3a3a",
        bevel: "rgba(0,0,0,0)",
        head: "#ffffff", text: "#f2f2f2", text2: "#cfcfcf",
        copper: "#e07b2e", copperDk: "#9e4a14",
        gold: "#f2b83c", goldDk: "#a8750f",
        emerald: "#3fcf7a", play: "#4fcf5c", playDk: "#2c8f37",
        danger: "#e0473b", dangerDk: "#9c2a21",
        lilac: "#b98bff", sky: "#4ec4e8",   // lilac is the storm, nothing else
        r: 5, rSmall: 4, rBig: 6,
        lw: 1.5, lip: 0,
        line: "#333333",
        frame: "rgba(0,0,0,0.6)",
        drop: "rgba(0,0,0,0)",
        edge: 25,
        font: 'Ubuntu, sans-serif',
        ui: 'Ubuntu, sans-serif',
        titleMin: 15,
    };
    try { document.fonts && document.fonts.load('700 20px Ubuntu'); } catch (e) { }
    // A plate: a soft drop under it, flat fill, fine keyline, and a single
    // highlight along the top edge. o: { fill, r, lw, lip, bevel:false, stroke, alpha }
    function hudPanel(c, x, y, w, h, o = {}) {
        const r = Math.min(o.r != null ? o.r : HUD.r, 6, h / 2);
        c.save();
        if (o.alpha != null) c.globalAlpha *= o.alpha;
        roundRectPath(c, x, y, w, h, r);
        c.fillStyle = o.fill || HUD.panel;
        c.fill();
        if (o.stroke || o.fill === HUD.solid) {
            c.lineWidth = 2;
            c.lineJoin = "round";
            c.strokeStyle = o.stroke || HUD.frame;
            c.stroke();
        }
        c.restore();
    }
    // A recessed slot inside a plate: darker fill, thin ink keyline.
    function hudWell(c, x, y, w, h, r = HUD.rSmall, fill = HUD.well, line = HUD.line, lw = 1) {
        roundRectPath(c, x, y, w, h, Math.min(r, 5, h / 2));
        c.fillStyle = fill;
        c.fill();
        if (lw > 0 && line !== HUD.line && line !== HUD.ink) { c.lineWidth = 1.5; c.strokeStyle = line; c.stroke(); }
    }
    function hudBar(c, x, y, w, h, frac, col, track = HUD.track) {
        if (track === HUD.wellSolid) track = HUD.track;
        roundRectPath(c, x, y, w, h, h / 2);
        c.fillStyle = track;
        c.fill();
        c.lineWidth = 1.5;
        c.strokeStyle = HUD.frame;
        c.stroke();
        frac = Math.max(0, Math.min(1, frac || 0));
        const inset = h >= 10 ? 2.5 : h >= 6 ? 1.5 : 1;
        const ih = h - inset * 2;
        if (frac > 0.001 && ih > 0.5) {
            roundRectPath(c, x + inset, y + inset, Math.max(ih, (w - inset * 2) * frac), ih, ih / 2);
            c.fillStyle = col;
            c.fill();
        }
    }
    // Title text, centred on y. Lilita One from HUD.titleMin up; smaller
    // labels are Rubik bold. A thin dark rim keeps either readable.
    const hudFonts = new Map();
    function hudFont(size) {
        let f = hudFonts.get(size);
        if (f === undefined) {
            f = "700 " + size + "px " + HUD.font;
            if (hudFonts.size > 400) hudFonts.clear();
            hudFonts.set(size, f);
        }
        return f;
    }
    // Stroked HUD text is costly to draw (font set + strokeText + fillText,
    // every frame, ~80 call sites), so each label is drawn once into a small
    // sprite at the layer's pixel scale and reused. Sizes snap to 0.5 and the
    // sprite is stretched the last bit, so zooming labels don't make a new
    // sprite every frame. Non-string colours (gradients) skip the cache.
    const titleSprites = new Map();
    let titleSpritesFontsOk = false;
    // a label has to be asked for a few frames running before it gets a
    // sprite, so counters that change every frame are drawn directly
    const titleSeen = new Map();
    function titleSprite(text, q, col, scale) {
        const key = text + "|" + q + "|" + col + "|" + scale;
        let e = titleSprites.get(key);
        if (e) { e.used = textFrame; return e; }
        const n = (titleSeen.get(key) || 0) + 1;
        if (n < 4) {
            if (titleSeen.size > 3000) titleSeen.clear();
            titleSeen.set(key, n);
            return null;
        }
        titleSeen.delete(key);
        if (!titleSpritesFontsOk && document.fonts && document.fonts.status === "loaded") titleSpritesFontsOk = true;
        const m = ctx[2];
        m.save(); m.font = hudFont(q); const w = m.measureText(text).width; m.restore();
        const lw = Math.max(1.75, q * 0.19);
        const pad = lw + 2, W = w + pad * 2, H = q * 1.5 + pad * 2;
        const pw = Math.max(1, Math.ceil(W * scale)), ph = Math.max(1, Math.ceil(H * scale));
        const cv = spriteCanvas(pw, ph);
        const g = cv.getContext("2d");
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.clearRect(0, 0, cv.width, cv.height);
        g.scale(scale, scale);
        g.font = hudFont(q);
        g.textAlign = "left";
        g.textBaseline = "middle";
        g.lineJoin = "round";
        g.lineWidth = lw;
        g.strokeStyle = HUD.line;
        const dy = q * 0.04;
        g.strokeText(text, pad, H / 2 + dy);
        g.fillStyle = col;
        g.fillText(text, pad, H / 2 + dy);
        e = { cv, w, W, H, pad, pw, ph, used: textFrame };
        // only keep sprites made with the real fonts in (first frames can be fallback)
        if (titleSpritesFontsOk) {
            if (titleSprites.size > 600) { let n = 0; for (const [k, old] of titleSprites) { titleSprites.delete(k); freeSprite(old); if (++n >= 150) break; } }
            titleSprites.set(key, e);
        } else e.loose = true;
        return e;
    }
    if (document.fonts && document.fonts.addEventListener) document.fonts.addEventListener("loadingdone", () => titleSprites.clear());
    function hudTitle(text, x, y, size, col, align = "left", alpha = 1, c = ctx[2]) {
        size += config.graphical.fontSizeBoost;
        // offscreen bakes (tiles, icons) are a cache already: drawn as vector
        const t = typeof col === "string" && text !== "" && (c._tf || crispOff) ? tfOf(c) : null;
        const sc = t ? spriteScale(Math.hypot(t.a, t.b)) : 0;
        if (sc > 0 && !t.b && !t.c) {
            const q = spriteSize(size), k = size / q;
            const e = titleSprite(String(text), q, col, sc);
            if (e) return drawTitleSprite(e, c, x, y, k, sc, align, alpha, t);
        }
        hudTitleDirect(text, x, y, size, col, align, alpha, c);
    }
    function drawTitleSprite(e, c, x, y, k, sc, align, alpha, t) {
        {
            const w = e.W * k, h = e.H * k, tw = e.w * k;
            let dx = align === "center" ? x - tw / 2 : align === "right" ? x - tw : x;
            dx -= e.pad * k;
            const a0 = c.globalAlpha;
            if (alpha < 1) c.globalAlpha = a0 * Math.max(0, alpha);
            if (crispOff) {
                dx = Math.round(dx * sc) / sc;
                const dy = Math.round((y - h / 2) * sc) / sc;
                c.drawImage(e.cv, 0, 0, e.pw || e.cv.width, e.ph || e.cv.height, dx, dy, w, h);
            } else blitSprite(c, t, e.cv, e.pw, e.ph, dx, y - h / 2, e.pw / sc * k, e.ph / sc * k);
            c.globalAlpha = a0;
            // a fallback-font sprite is used once and handed back
            if (e.loose) { e.loose = false; freeSprite(e); }
        }
    }
    function hudTitleDirect(text, x, y, size, col, align, alpha, c) {
        c.save();
        if (alpha < 1) c.globalAlpha *= Math.max(0, alpha);
        c.font = hudFont(size);
        c.textAlign = align;
        c.textBaseline = "middle";
        c.lineJoin = "round";
        const dy = size * 0.04;
        c.lineWidth = Math.max(1.75, size * 0.19);
        c.strokeStyle = HUD.line;
        c.strokeText(text, x, y + dy);
        c.fillStyle = col;
        c.fillText(text, x, y + dy);
        c.restore();
    }
    const hudTitleWidths = new Map();
    function hudTitleW(text, size) {
        size += config.graphical.fontSizeBoost;
        // zoom-scaled world labels and popping titles ask for a new size
        // every frame: measure on a quarter-unit grid and scale (canvas text
        // width is linear in the font size), so they hit the cache
        let q = Math.max(0.25, Math.round(size * 4) / 4);
        if ((q >= HUD.titleMin) !== (size >= HUD.titleMin)) q = size;   // hudFont switches face there
        const k = text + "|" + q;
        let w = hudTitleWidths.get(k);
        if (w === undefined) {
            const c = ctx[2];
            c.save(); c.font = hudFont(q); w = c.measureText(text).width; c.restore();
            // drop the oldest quarter: a full clear re-measured every label at once
            if (hudTitleWidths.size >= 800) { let n = 200; for (const kk of hudTitleWidths.keys()) { hudTitleWidths.delete(kk); if (--n <= 0) break; } }
            hudTitleWidths.set(k, w);
        }
        return q === size ? w : w * size / q;
    }
    // Cached measureText for HUD strings that repeat frame to frame.
    const hudTextWidths = new Map();
    function hudTextW(text, size) {
        const k = text + "|" + size;
        let w = hudTextWidths.get(k);
        if (w === undefined) {
            w = measureText(text, size);
            if (hudTextWidths.size >= 800) { let n = 200; for (const kk of hudTextWidths.keys()) { hudTextWidths.delete(kk); if (--n <= 0) break; } }
            hudTextWidths.set(k, w);
        }
        return w;
    }
    const labelCases = new Map();
    function labelCase(t) {
        let v = labelCases.get(t);
        if (v === undefined) {
            v = String(t).toLowerCase().replace(/\b([ivx]+)\b/g, (m) => m.toUpperCase()).replace(/^\s*\S/, (m) => m.toUpperCase());
            if (labelCases.size > 300) labelCases.clear();
            labelCases.set(t, v);
        }
        return v;
    }
    window.dwLabelCase = labelCase;
    // A keycap: small raised face over its own darker lip. Returns its width.
    function hudKey(c, x, y, label, h = 18, alpha = 1) {
        const size = h * 0.62;
        const w = Math.max(h, hudTitleW(label, size) + h * 0.55);
        c.save();
        if (alpha < 1) c.globalAlpha *= alpha;
        roundRectPath(c, x, y, w, h, Math.min(3, h * 0.2));
        c.fillStyle = "rgba(0,0,0,0.45)";
        c.fill();
        c.lineWidth = 1.5;
        c.strokeStyle = "rgba(255,255,255,0.28)";
        c.stroke();
        c.restore();
        hudTitle(label, x + w / 2, y + h / 2, size, HUD.head, "center", alpha, c);
        return w;
    }
    // Chunky button with a lip, like .dw-btn. Registers the same clickables
    // drawButton does (index false = set, else place).
    // o: { fill, lipCol, textCol, size, enabled, type, index, cr, alpha }
    function hudButton(c, cx, y, w, h, label, o = {}) {
        const x = cx - w / 2;
        const alpha = o.alpha != null ? o.alpha : 1;
        const on = o.enabled !== false;
        let hover = false;
        if (o.type && on) {
            const cl = global.clickables[o.type];
            if (o.index === false || o.index == null) cl.set(x * o.cr, y * o.cr, w * o.cr, h * o.cr);
            else cl.place(o.index, x * o.cr, y * o.cr, w * o.cr, h * o.cr);
            const hv = cl.check({ x: global.mouse.x, y: global.mouse.y });
            hover = (o.index === false || o.index == null) ? hv === true : hv === o.index;
        }
        const down = hover && global.clickables.clicked ? 1 : 0;
        const fill = o.fill || HUD.face;
        const r = Math.min(o.r != null ? o.r : 4, 5);
        c.save();
        c.globalAlpha *= alpha * (on ? 1 : 0.55);
        const yy = y + down;
        roundRectPath(c, x, yy, w, h, r);
        c.fillStyle = fill;
        c.fill();
        if (hover && !down) {
            c.fillStyle = "rgba(255,255,255,0.14)";
            c.fill();
        }
        c.lineWidth = 2.5;
        c.strokeStyle = HUD.frame;
        c.stroke();
        c.restore();
        if (label) {
            let s = o.size || Math.min(16, h * 0.5);
            while (s > 8 && hudTitleW(label, s) > w - 12) s -= 0.5;
            hudTitle(label, cx, yy + h / 2, s, o.textCol || HUD.head, "center", alpha * (on ? 1 : 0.7), c);
        }
        return hover;
    }

    // ═════════════════════════════════════════════════════════════════════
    // Dig Royale HUD. One thing per screen region:
    //   top centre   raid clock, storm + twist, your place, toast, boss bar
    //   top right    standings, then the kill feed, then system notices
    //   mid left     quest tracker
    //   bottom left  kit box above the skill bars
    //   centre       kill callouts (one at a time)
    // ═════════════════════════════════════════════════════════════════════
    const SHOP_TABS_OLD = [["drill", "Drills"], ["gear", "Gear"], ["kit", "Kit"], ["arm", "Sidearms"]];
    // with the ability system on (the catalog sells abilities) they lead
    const SHOP_TABS_AB = [["ability", "Abilities"], ["drill", "Drills"], ["gear", "Gear"], ["kit", "Kit"], ["arm", "Sidearms"]];
    let SHOP_TABS = SHOP_TABS_OLD;
    const SHOP_ACCENT = "#5ce0d8";
    const SHOP_FACE = inkShade(hexToRgb(SHOP_ACCENT), 0.66);
    const KIT_SHORT = { charge: "CHARGE", strut: "STRUT", medkit: "MEDKIT", overdrive: "OVERDRV", anchor: "ANCHOR", flash: "FLASH", bulwark: "BULWARK", decoy: "DECOY", barrage: "BARRAGE", rocket: "ROCKET", flare: "FLARE" };
    const GEAR_TAG = { statpt: "+1", scanner: "SCN", magnet: "MAG", satchel: "SAT", insurance: "INS", cloak: "CLK", boots: "TRD", plating: "PLT", express: "EXP", mark: "MRK", wind: "WND" };
    const shopGlide = Smoothbar(0, 2, 3, 0.1, 0.025, true);
    const kitGlide = Smoothbar(0, 2, 3, 0.1, 0.025, true);
    let kitBoxTop = 0;   // 0 while the kit box is hidden
    // the bottom-left stat bars (drawSkillBars); the kit box and the left
    // column floor are anchored to the same numbers. Tall enough that the
    // stat names stay readable on 1366x768 / 1280x720 at Normal scale.
    const STAT_BAR_H = 16, STAT_BAR_GAP = 5;
    // Highest point the bottom-left block (kit box, else the 11 stat bars and
    // their points counter) can reach; the upgrade tiles and the quest and
    // override cards stop above it.
    function leftColumnFloor() {
        // touch: the lower left belongs to the move stick
        if (global.mobile) return touchLeftFloor() - 12;
        if (kitBoxTop > 0) return kitBoxTop;
        return global.screenHeight - 20 - 5.5 - STAT_BAR_H - 10 * (STAT_BAR_H + STAT_BAR_GAP) - 34;
    }
    const bossGlide = Smoothbar(0, 2, 3, 0.08, 0.025, true);
    let royaleFeedBottom = 0;
    const GEM_ICON = [[-1, -0.38], [-0.55, -0.95], [0.55, -0.95], [1, -0.38], [0, 0.95]];

    function shopUiMode() { return royaleActive() || !!global.tutorialMode; }
    function shopOpenWanted() {
        return shopUiMode() && global.shop.onPad && !global.shop.dismissed && !global.died && !global.showBigMap &&
            // Tutorial: the panel only opens in the steps that sell something.
            (!global.tutorialMode || /(^|,)shop:/.test(window.dwTutAllow || "")) &&
            // a first raid: the panel waits for the coach's ability step
            (global.tutorialMode || newcomer.shopOpen());
    }
    function fmtNum(n) { return util.formatLargeNumber(Math.round(n || 0)); }
    // the raid-end finale draws with the HUD's own pieces
    raidFinale.init({
        ctx: () => ctx[2], HUD, hudPanel, hudWell, hudTitle, hudTitleW, hudBar, drawText, measureText,
        gemSprite, vignetteSprite, fmtNum, selfId: () => gui.playerid,
        rankHasContent: () => rankPanel.hasContent(),
        rankDraw: (c, x, y, w, h, a) => rankPanel.draw(c, x, y, w, h,
            { drawText, measureText, drawBar, color, barChunk: config.graphical.barChunk }, a),
    });
    // distances read as metres everywhere (round 8): "570m", "2.1km"
    function fmtDist(d) { return d >= 1000 ? (d / 1000).toFixed(1) + "km" : Math.round(d) + "m"; }
    stormFx.init({ hudTitle, hudTitleW, hudTextW: (t, sz) => hudTextW(t, sz), hudPanel, drawText, fmtDist });
    // hunted marks, the Core, drop-ins and the screen juice (raidHeat.js, juice.js)
    raidHeat.init({ HUD, hudPanel, hudTitle, hudTitleW, hudBar, drawText, fmtNum, fmtDist, haloSprite, vignetteSprite, coachOn: () => coach.active(), colorOf: (c) => gameDraw.modifyColor(c), cardHold: () => deathCardUp() });
    achCard.init({ HUD, hudPanel, hudTitle, hudTitleW, hudTextW: (t, sz) => hudTextW(t, sz), drawText, rr: (c, x, y, w, h, r) => roundRectPath(c, x, y, w, h, r) });
    function treeTankPaint(c, key, x, y, w, h) {
        const picture = mockupPicture(String(key), gui.color);
        const m = tankMockOf(picture);
        const f = upGrid.previewFrame(m || { shape: 0 }, w, h, 2, (i) => global.mockups && global.mockups[i], 0.28 * w);
        c.save();
        c.lineCap = "round";
        c.lineJoin = "round";
        previewGrey = true;
        try { drawEntity(picture.color, x + w / 2 + f.x, y + h / 2 + f.y, picture, 1, 1, f.scale / picture.size, 1, f.angle, true, c); }
        finally { previewGrey = false; c.restore(); }
    }
    treeUi.init({
        HUD, hudPanel, hudTitle, hudTitleW,
        rr: (c, x, y, w, h, r) => roundRectPath(c, x, y, w, h, r),
        mockups: () => global.mockups,
        tankType: () => gui.type,
        playerColor: () => gui.color,
        ready: () => !!global.renderTankTree && !!global.mockups && global.mockups.length > 0,
        tileColors: (key, ci) => upgTileColors(mockupPicture(String(key), gui.color), ci),
        paintTank: treeTankPaint,
        mobile: () => !!global.mobile,
        devScale: () => Math.hypot(tfOf(ctx[2]).a, tfOf(ctx[2]).b) || 1,
        click: () => { try { gameSound.uiClick(); } catch (e) { } },
        mix: (a, b, t) => gameDraw.mixColors(a, b, t),
        t5Label: () => { const st = upGrid.t5State(global.royale && global.royale.you); const at = st && st.at > 1 ? st.at : 2; return (Math.round(at * 100) / 100) + "x"; },
    });
    global.treeUi = treeUi;
    window.dwTree = treeUi;
    crowns.init({ HUD, hudPanel, hudTitle, hudTitleW, hudTextW, measureText, roundRectPath: (c, x, y, w, h, r) => roundRectPath(c, x, y, w, h, r), drawText, fmtNum, fmtDist, haloSprite, vignetteSprite, myHex: () => playerHexCol() || HUD.gold });
    // the first raids: what the HUD shows per stage, the goal line, director moments
    newcomer.init({ hudPanel, hudTitle, hudTitleW, hudTextW: (t, sz) => hudTextW(t, sz), drawText, keyLabel: (id, d) => keyLabel(id, d), NOTE_H: 24, NOTE_GAP: 8 });
    // the first seconds of a raid: the raid card, then the HUD in steps
    firstSeconds.init({
        HUD, panel: hudPanel, title: hudTitle, titleW: hudTitleW, textW: (t, sz) => hudTextW(t, sz),
        text: (t, x, y, sz, col, align, alpha) => drawText(t, x, y, sz, col, align, true, alpha),
        gemPath: (c, x, y, r) => gemPath(c, x, y, r), keyLabel: (id, d) => keyLabel(id, d), rect: (k) => hudRectOf(k),
        // the stat bars' block (desktop), drawn or not
        statRect: () => {
            if (global.mobile || !gui.points) return null;
            const bottom = global.screenHeight - 20 - 5.5, top = bottom - 11 * STAT_BAR_H - 10 * STAT_BAR_GAP - 30;
            return { x: HUD.edge, y: top, w: 210, h: bottom - top };
        },
    });
    // stage 3 (veterans) shows everything: every check below is true there
    function nxShows(piece, opts) { return newcomer.shows(piece, opts); }
    function gemPath(c, x, y, r) {
        c.beginPath();
        for (let i = 0; i < GEM_ICON.length; i++) {
            const px = x + GEM_ICON[i][0] * r, py = y + GEM_ICON[i][1] * r;
            i ? c.lineTo(px, py) : c.moveTo(px, py);
        }
        c.closePath();
    }
    function polyPath(c, x, y, r, n, rot = 0) {
        c.beginPath();
        for (let i = 0; i < n; i++) {
            const a = (i / n) * Math.PI * 2 + rot;
            const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r;
            i ? c.lineTo(px, py) : c.moveTo(px, py);
        }
        c.closePath();
    }
    // memoized: the same tooltip / override text wraps every frame
    const wrapCache = new Map();
    function wrapLines(text, size, maxW) {
        const key = (size + config.graphical.fontSizeBoost) + "|" + (maxW | 0) + "|" + text;
        const hit = wrapCache.get(key);
        if (hit) return hit;
        const lines = wrapLinesRaw(text, size, maxW);
        if (wrapCache.size > 200) wrapCache.clear();
        wrapCache.set(key, lines);
        return lines;
    }
    function wrapLinesRaw(text, size, maxW) {
        const words = String(text || "").split(/\s+/);
        const lines = [];
        let cur = "";
        for (const w of words) {
            const t = cur ? cur + " " + w : w;
            if (measureText(t, size) > maxW && cur) { lines.push(cur); cur = w; }
            else cur = t;
        }
        if (cur) lines.push(cur);
        return lines;
    }
    function shortName(n, max) {
        n = String(n || "Unnamed");
        return n.length > max ? n.slice(0, max - 1) + "…" : n;
    }
    // Keybind labels change rarely; querying the DOM per frame does not pay.
    const keyLabelCache = { at: 0, map: {} };
    const KEY_LABEL_IDS = ["KEY_UPGRADE_MIN", "KEY_KIT_1", "KEY_KIT_2", "KEY_KIT_3", "KEY_TOGGLE_MAP",
        "KEY_CHOOSE_1", "KEY_CHOOSE_2", "KEY_CHOOSE_3", "KEY_CHOOSE_4", "KEY_CHOOSE_5", "KEY_CHOOSE_6",
        "KEY_UPGRADE_ATK", "KEY_UPGRADE_HTL", "KEY_UPGRADE_SPD", "KEY_UPGRADE_STR", "KEY_UPGRADE_PEN",
        "KEY_UPGRADE_DAM", "KEY_UPGRADE_RLD", "KEY_UPGRADE_MOB", "KEY_UPGRADE_RGN", "KEY_UPGRADE_SHI", "KEY_SIDEARM",
        "KEY_DASH", "KEY_ABILITY"];
    function keyLabel(id, dflt) {
        const now = performance.now();
        if (now - keyLabelCache.at > 1500) {
            keyLabelCache.at = now;
            keyLabelCache.map = {};
            for (const k of KEY_LABEL_IDS) {
                const el = document.querySelector('#controlSettings b[data-key="' + k + '"]');
                if (el && el.textContent) keyLabelCache.map[k] = el.textContent;
            }
        }
        return keyLabelCache.map[id] || dflt;
    }
    function sidearmInput() { return global.mobile ? "round button" : keyLabel("KEY_SIDEARM", "X"); }
    // Off-screen indicator inside a HUD-safe frame: clear of the top cluster,
    // the right-hand panels and the bottom row.
    // "#rrggbb" / "#rgb" / "rgb(...)" to channels, for tinted gradients.
    function toRgb(str) {
        if (typeof str !== "string") return null;
        let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(str.trim());
        if (m) {
            let h = m[1];
            if (h.length === 3) h = h.split("").map(ch => ch + ch).join("");
            const n = parseInt(h, 16);
            return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
        }
        m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(str);
        return m ? { r: +m[1], g: +m[2], b: +m[3] } : null;
    }
    // Interpolated world positions for things the raid packet reports only
    // twice a second (boss, revenge target, marked streakers): extrapolate
    // along the last observed velocity and ease onto it, so markers and
    // minimap dots move at frame rate instead of stepping every 500ms.
    const posTracks = new Map();
    function trackPos(key, x, y, maxSpeed = 0.6) {
        const now = performance.now();
        let t = posTracks.get(key);
        if (!t || !isFinite(t.sx) || !isFinite(t.sy)) {
            t = { tx: x, ty: y, vx: 0, vy: 0, at: now, sx: x, sy: y, last: now };
            posTracks.set(key, t);
            return { x, y };
        }
        if (x !== t.tx || y !== t.ty) {
            const dt = Math.max(80, now - t.at);
            if (Math.hypot(x - t.tx, y - t.ty) > 1200) { t.vx = 0; t.vy = 0; t.sx = x; t.sy = y; }
            else {
                t.vx = Math.max(-maxSpeed, Math.min(maxSpeed, (x - t.tx) / dt));
                t.vy = Math.max(-maxSpeed, Math.min(maxSpeed, (y - t.ty) / dt));
            }
            t.tx = x; t.ty = y; t.at = now;
        }
        const age = Math.min(700, now - t.at);
        const px = t.tx + t.vx * age, py = t.ty + t.vy * age;
        const fdt = Math.min(100, now - t.last);
        t.last = now;
        const k = 1 - Math.pow(0.82, fdt / 16.7);
        t.sx += (px - t.sx) * k;
        t.sy += (py - t.sy) * k;
        return { x: t.sx, y: t.sy };
    }
    let trackSweepAt = 0;
    function sweepTracks() {
        const now = performance.now();
        if (now - trackSweepAt < 5000) return;
        trackSweepAt = now;
        for (const [k, t] of posTracks) if (now - t.last > 4000) posTracks.delete(k);
    }
    function drawSkull(c, x, y, r, col) {
        c.save();
        c.translate(x, y);
        c.fillStyle = col;
        c.strokeStyle = color.black;
        c.lineWidth = Math.max(1.5, r * 0.18);
        c.lineJoin = "round";
        // cranium + jaw
        c.beginPath();
        c.arc(0, -r * 0.12, r, Math.PI * 0.78, Math.PI * 2.22);
        c.lineTo(r * 0.5, r * 0.62);
        c.lineTo(r * 0.5, r * 0.98);
        c.lineTo(-r * 0.5, r * 0.98);
        c.lineTo(-r * 0.5, r * 0.62);
        c.closePath();
        c.fill();
        c.stroke();
        // eyes and nose
        c.fillStyle = color.black;
        c.beginPath();
        c.arc(-r * 0.38, -r * 0.1, r * 0.25, 0, Math.PI * 2);
        c.arc(r * 0.38, -r * 0.1, r * 0.25, 0, Math.PI * 2);
        c.fill();
        c.beginPath();
        c.moveTo(0, r * 0.22); c.lineTo(-r * 0.13, r * 0.5); c.lineTo(r * 0.13, r * 0.5); c.closePath();
        c.fill();
        // teeth
        c.strokeStyle = color.black;
        c.lineWidth = Math.max(1, r * 0.1);
        for (const tx of [-0.25, 0, 0.25]) {
            c.beginPath(); c.moveTo(tx * r, r * 0.66); c.lineTo(tx * r, r * 0.98); c.stroke();
        }
        c.restore();
    }
    // Panels an edge marker must not sit on. The standings rect and the top
    // cluster are recorded by the functions that draw them.
    let standingsRect = null;
    // the raid chat panel under it (drawChatPanel)
    let chatPanelRect = null, chatPanelErr = "", chatPanelLay = null;
    let hudTopBottom = 60;
    // A name in the world (a pad, an outpost, a compass word) that lands under
    // HUD text steps back to a faint ghost instead of printing over it. The
    // rects are last frame's, rebuilt a few times a second.
    let labelRects = [], labelRectsAt = 0;
    function labelAlpha(cx0, cy0, w, h) {
        if (!royaleActive()) return 1;
        // the death card owns the screen: pad and site labels step back
        if (deathCardUp()) return 0.25;
        const x = cx0 - w / 2, y = cy0 - h / 2;
        for (const R of labelRectsNow()) if (x < R.x + R.w && x + w > R.x && y < R.y + R.h && y + h > R.y) return 0.18;
        return 1;
    }
    function labelRectsNow() {
        const now = performance.now();
        if (now - labelRectsAt > 120) {
            labelRectsAt = now;
            labelRects = hudAvoidRects();
            if (hudDrawn.feed) labelRects.push(hudDrawn.feed);
            if (messageStackBottom > royaleFeedBottom && messageStackLeft < global.screenWidth) labelRects.push({ x: messageStackLeft, y: royaleFeedBottom, w: global.screenWidth - messageStackLeft, h: messageStackBottom - royaleFeedBottom });
            // round 9 bug 4: the big banners (a slam, the last ten seconds)
            if (global.countdownRect) labelRects.push(global.countdownRect);
            if (global.hudSlamY > 0 && juiceSlamUp()) labelRects.push({ x: global.screenWidth / 2 - 300, y: global.hudSlamY - 26, w: 600, h: 62 });
        }
        return labelRects;
    }
    // World labels: queued while the world draws (worldLabel), then laid out
    // so none prints over another and drawn (flushWorldLabels, labelLayout.js).
    // Each keeps its own canvas. The pool lives on the function (no per-frame
    // allocations, nothing for module evaluation to trip over).
    //   pri: 0 pads, 1 crates and outposts, 2 epic chests, 3 the rest
    function worldLabel(c, text, x, y, size, col, alpha, pri, w, h) {
        const S = worldLabel.S || (worldLabel.S = { pool: [], q: [], placed: [] });
        const it = S.pool[S.q.length] || (S.pool[S.q.length] = {});
        it.c = c; it.text = text; it.x = x; it.y = y; it.size = size; it.col = col; it.alpha = alpha;
        it.pri = pri; it.w = w; it.h = h; it.dy = 0; it.blocked = false;
        it.d = Math.abs(x - global.screenWidth / 2) + Math.abs(y - global.screenHeight / 2);
        S.q.push(it);
    }
    // World labels show when the thing is reasonably near: full in the middle
    // of the screen, fading out toward the edges (the thing itself still
    // draws; its name stops crowding the corners and the HUD)
    function labelNear(x, y) {
        const hw = global.screenWidth / 2, hh = global.screenHeight / 2;
        if (!(hw > 0) || !(hh > 0) || global.tutorialMode) return 1;
        const r = Math.hypot((x - hw) / hw, (y - hh) / hh);
        return Math.max(0, Math.min(1, (0.98 - r) / 0.4));
    }
    function flushWorldLabels() {
        const S = worldLabel.S;
        if (!S || !S.q.length) return;
        const rects = royaleActive() && !deathCardUp() ? labelRectsNow() : null;
        layoutLabels(S.q, rects, S.placed);
        for (let i = 0; i < S.q.length; i++) {
            const it = S.q[i];
            const ly = it.y + it.dy;
            const a = it.alpha * (it.blocked ? 0.3 : 1) * labelAlpha(it.x, ly, it.w, it.h) * labelNear(it.x, ly);
            // (the background canvas goes under the blackout: those draw on the gameplay one)
            if (a >= 0.03) hudTitle(it.text, it.x, ly, it.size, it.col, "center", a, it.c === ctx[0] ? ctx[1] : it.c);
            it.c = null;
        }
        S.q.length = 0;
    }
    function hudAvoidRects() {
        const sw = global.screenWidth, sh = global.screenHeight;
        const out = [];
        if (standingsRect) out.push(standingsRect);
        const topW = Math.max(480, noteMaxW() + 8);
        out.push({ x: sw / 2 - topW / 2, y: 0, w: topW, h: hudTopBottom + 6 });
        out.push({ x: sw / 2 - 250, y: sh - 130, w: 500, h: 130 });   // the player bar: name, tank chip, wallet row
        const lf = leftColumnFloor();
        out.push({ x: 0, y: lf, w: 232, h: sh - lf });
        out.push({ x: sw - 252, y: sh - 262, w: 252, h: 262 });
        // round 12: the minimap as drawn plus its "Map [M]" key on the left
        // (markers used to pile onto both); set where the minimap is drawn
        const mh = global.minimapHintRect;
        if (mh && !global.mobile) out.push(mh);
        // class-upgrade tiles and the quest card under them
        if ((global.upgradeBoxBottom | 0) > 0) out.push({ x: 0, y: 0, w: Math.max(280, (global.upgradeBoxRight | 0) + 8), h: global.upgradeBoxBottom + 8 });
        if (questRect) out.push(questRect);
        if (overrideRect) out.push(overrideRect);
        if (duoRect) out.push(duoRect);
        if (chatPanelRect) out.push(chatPanelRect);
        if (global.coachRect) out.push(global.coachRect);
        if (global.hintRect) out.push(global.hintRect);
        if (abilityBarRect) out.push(abilityBarRect);
        if (vitalsRect) out.push(vitalsRect);
        if (!perkAvoidSkip) { const pr = raidPerks.avoidRect(); if (pr) out.push(pr); }
        return out;
    }
    // Where the main HUD pieces were drawn this frame (GUI units), for
    // coach.js. Pieces without a drawn record are derived from their anchors.
    let hudDrawn = {};
    function hudRectOf(kind) {
        const sh = global.screenHeight;
        switch (kind) {
            case "standings": return standingsRect;
            case "quest": case "contract": return questRect;
            case "vitals": return vitalsRect;
            case "feed": {
                const f = hudDrawn.feed;
                return f ? { x: f.x, y: f.y, w: f.w, h: Math.max(f.h, 63) } : null;
            }
            case "kit":
                if (global.mobile) return hudDrawn.kit || null;
                return kitBoxTop > 0 ? { x: HUD.edge, y: kitBoxTop, w: 190, h: 118 } : null;
            case "stats": {
                // touch: the Stats chip (the panel's cells are the stat clickables)
                if (global.mobile) return hudDrawn.stats || null;
                if (!global.canSkill) return null;
                const bottom = sh - 20 - 5.5;
                const top = bottom - 11 * STAT_BAR_H - 10 * STAT_BAR_GAP - 30;
                return { x: HUD.edge, y: top, w: 210, h: bottom - top };
            }
            case "upgrades":
                if (global.mobile) return hudDrawn.upgrades || null;
                return (global.upgradeBoxBottom | 0) > 0
                ? { x: HUD.edge, y: global.upgradeBoxTop, w: global.upgradeBoxRight - HUD.edge, h: global.upgradeBoxBottom - global.upgradeBoxTop }
                : null;
            default: return hudDrawn[kind] || null;
        }
    }
    window.dwHud = {
        rect: hudRectOf,
        edgePoint: (dx, dy) => edgePoint(dx, dy),
        edgeMarker: (c, e, col, glyph, name, dist, placed) => drawEdgeMarker(c, e, col, glyph, name, dist, placed),
        panel: (c, x, y, w, h, o) => hudPanel(c, x, y, w, h, o),
        title: (text, x, y, size, col, align, alpha, c) => hudTitle(text, x, y, size, col, align, alpha, c),
        titleW: (text, size) => hudTitleW(text, size),
        colors: HUD,
    };
    // Step a point out of a panel by the shortest move that stays on screen
    // (a panel on the bottom edge must push the marker UP, not off-screen).
    function nudgeOut(p, r, b) {
        if (p.x < r.x || p.x > r.x + r.w || p.y < r.y || p.y > r.y + r.h) return;
        // leave wide panels (wallet row, top cluster, standings) vertically
        // and tall ones (skill bars, minimap) horizontally
        const vert = [
            { x: p.x, y: r.y - 3, d: p.y - r.y },
            { x: p.x, y: r.y + r.h + 3, d: r.y + r.h - p.y },
        ];
        const horiz = [
            { x: r.x - 3, y: p.y, d: p.x - r.x },
            { x: r.x + r.w + 3, y: p.y, d: r.x + r.w - p.x },
        ];
        const inB = c => c.x >= b.left && c.x <= b.right && c.y >= b.top && c.y <= b.bottom;
        let cands = (r.w >= r.h ? vert : horiz).filter(inB);
        if (!cands.length) cands = (r.w >= r.h ? horiz : vert).filter(inB);
        if (!cands.length) return;
        cands.sort((a, c) => a.d - c.d);
        p.x = cands[0].x;
        p.y = cands[0].y;
    }
    // Where the ray from screen centre toward an off-screen point meets the
    // screen edge (a small margin in), stepped off any HUD panel it lands on.
    function edgePoint(dx, dy) {
        const sw = global.screenWidth, sh = global.screenHeight;
        const left = 16, right = sw - 16, top = 16, bottom = sh - 20;
        const cx = sw / 2, cy = sh / 2;
        const ang = Math.atan2(dy, dx);
        const c = Math.cos(ang), s = Math.sin(ang);
        const tx = c > 0 ? (right - cx) / c : c < 0 ? (left - cx) / c : Infinity;
        const ty = s > 0 ? (bottom - cy) / s : s < 0 ? (top - cy) / s : Infinity;
        const t = Math.max(0, Math.min(tx, ty));
        const p = { x: cx + c * t, y: cy + s * t, ang };
        const bounds = { left, right, top, bottom };
        // twice: a step out of one panel can land in the next (round 12)
        const rects = hudAvoidRects();
        for (let pass = 0; pass < 2; pass++) for (const r of rects) nudgeOut(p, r, bounds);
        p.x = Math.max(left, Math.min(right, p.x));
        p.y = Math.max(top, Math.min(bottom, p.y));
        return p;
    }
    // Soft light under every chest so they read from far away.
    function drawChestGlow(roomX, roomY, ratio) {
        if (!royaleActive() || glowOff()) return;
        const list = (global.royale && global.royale.chests) || [];
        if (!list.length) return;
        const halfW = global.gameWidth / 2, halfH = global.gameHeight / 2;
        const c = ctx[0];
        const now = performance.now();
        for (const ch of list) {
            const sx = roomX + (ch.x + halfW) * ratio, sy = roomY + (ch.y + halfH) * ratio;
            const R = (ch.z ? ch.z * 2.5 : ch.rare ? 100 : 78) * ratio;
            if (sx < -R || sx > global.screenWidth + R || sy < -R || sy > global.screenHeight + R) continue;
            const pulse = 0.5 + 0.5 * Math.sin(now / 700 + (ch.id | 0));
            let a = 0.7 + 0.3 * pulse;
            const gone = ch.e != null ? chestGoneAt.get(ch.e) : undefined;
            if (gone !== undefined) { a *= Math.max(0, 1 - (now - gone) / 150); if (a <= 0) continue; }
            const spr = haloSprite(ch.sd ? "chest-sd" : ch.rare ? "chest-e" : "chest-c", ch.sd ? "111,245,168" : ch.rare ? "220,140,248" : "240,160,96", [[0, 0.40], [0.55, 0.11], [1, 0]]);
            c.save();
            c.globalAlpha = a;
            c.drawImage(spr, sx - R, sy - R, R * 2, R * 2);
            c.restore();
        }
    }
    // ── floor layer: shop pads, bloom glow, event zones ────────────────
    function drawShops(roomX, roomY, ratio) {
        if (!global.shops.length || !(royaleMode() || global.tutorialMode)) return;
        const now = performance.now();
        const halfW = global.gameWidth / 2, halfH = global.gameHeight / 2;
        const c = ctx[0];
        const spr = getVaultSpritesForColor(SHOP_ACCENT);
        for (const s of global.shops) {
            const sx = roomX + (s.x + halfW) * ratio, sy = roomY + (s.y + halfH) * ratio;
            const R = (s.r || 95) * ratio;
            if (sx < -R * 2 || sx > global.screenWidth + R * 2 || sy < -R * 2 || sy > global.screenHeight + R * 2) continue;
            const mine = global.shop.onPad && global.shop.padId === s.id;
            const pulse = 0.5 + 0.5 * Math.sin(now / 650 + s.id);
            c.save();
            c.translate(sx, sy);
            c.lineJoin = "round";
            const lw = Math.max(1.5, R * 0.04);
            // vault plate style on a hexagon (the hitbox): ink drop, deep
            // teal face, ink outline, rim band
            polyPath(c, 0, R * 0.07, R * 1.16, 6, Math.PI / 6);
            c.fillStyle = "rgba(0,0,0,0.6)"; c.fill();
            polyPath(c, 0, 0, R * 1.16, 6, Math.PI / 6);
            c.fillStyle = SHOP_FACE; c.fill();
            c.lineWidth = lw; c.strokeStyle = HUD.ink; c.stroke();
            polyPath(c, 0, 0, R * 1.0, 6, Math.PI / 6);
            c.lineWidth = Math.max(2, R * 0.065);
            c.globalAlpha = 0.8 + 0.2 * pulse;
            c.strokeStyle = SHOP_ACCENT; c.stroke();
            c.globalAlpha = 1;
            // yours: cream dashes run round the band while you stand on it
            if (mine) {
                c.setLineDash([R * 0.18, R * 0.12]); c.lineDashOffset = -now / 45;
                c.lineWidth = Math.max(1.5, R * 0.035); c.strokeStyle = HUD.head; c.stroke();
                c.setLineDash([]);
            }
            // plate and a slow gem wheel, same sprites as the vault
            const pr = R * 0.66;
            c.drawImage(spr.plate, -pr, -pr, pr * 2, pr * 2);
            c.save();
            c.rotate(now / 6000 + s.id);
            c.drawImage(spr.wheel, -pr, -pr, pr * 2, pr * 2);
            c.restore();
            // the coin: what this pad is for
            const cr = R * 0.24;
            c.beginPath(); c.arc(0, 0, cr, 0, Math.PI * 2);
            c.fillStyle = HUD.wellSolid; c.fill();
            c.lineWidth = lw; c.strokeStyle = HUD.ink; c.stroke();
            gemPath(c, 0, cr * 0.05, cr * 0.62);
            c.fillStyle = HUD.gold; c.fill();
            c.save(); c.clip();
            c.fillStyle = "rgba(255,255,255,0.3)";
            c.fillRect(-cr, cr * 0.05 - cr * 0.62, cr * 2, cr * 0.36);
            c.restore();
            c.lineWidth = Math.max(1.2, R * 0.028); c.strokeStyle = HUD.ink; c.stroke();
            c.restore();
            // one label per pad ("North Shop"), above it; none while you stand
            // on it (the shop panel says where you are)
            if (!mine) {
                const sl = String(s.name || "Shop"), sls = Math.max(13, R * 0.25);
                worldLabel(c, sl, sx, sy - R * 1.4, sls, SHOP_ACCENT, 1, 0, hudTitleW(sl, sls) + 8, sls + 6);
            }
        }
    }

    function drawBloomGlow(roomX, roomY, ratio) {
        if (!royaleActive()) return;
        const b = global.royale.bloom;
        if (!b || !(b.until > Date.now())) return;
        const halfW = global.gameWidth / 2, halfH = global.gameHeight / 2;
        const sx = roomX + (b.x + halfW) * ratio, sy = roomY + (b.y + halfH) * ratio;
        const R = (b.r || 340) * ratio;
        if (sx < -R * 2 || sx > global.screenWidth + R * 2 || sy < -R * 2 || sy > global.screenHeight + R * 2) return;
        const now = performance.now();
        const pulse = 0.5 + 0.5 * Math.sin(now / 520);
        const left = Math.max(0, (b.until - Date.now()) / 1000);
        const fade = Math.min(1, left / 8);
        const c = ctx[0];
        c.save();
        if (!glowOff()) {
            const spr = haloSprite("bloom", "255,205,90", [[0, 1], [0.7, 0.46], [1, 0]]);
            c.globalAlpha = (0.28 + 0.10 * pulse) * fade;
            const rr = R * 1.15;
            c.drawImage(spr, sx - rr, sy - rr, rr * 2, rr * 2);
        }
        c.globalAlpha = (0.45 + 0.35 * pulse) * fade;
        c.strokeStyle = "#ffd76e";
        c.lineWidth = Math.max(2, 5 * ratio);
        c.setLineDash([R * 0.12, R * 0.08]);
        c.lineDashOffset = -now / 25;
        c.beginPath(); c.arc(sx, sy, R, 0, Math.PI * 2); c.stroke();
        c.restore();
        const bla = fade * labelNear(sx, sy - R - 14 * ratio) * labelAlpha(sx, sy - R - 14 * ratio, 160, 24);
        if (bla > 0.03) drawText("ORE BLOOM  " + Math.ceil(left) + "s", sx, sy - R - 14 * ratio, Math.max(11, 16 * ratio), "#ffd76e", "center", true, bla, 5, ctx[0]);
    }

    function drawEventZone(roomX, roomY, ratio) {
        if (!royaleActive()) return;
        const ev = global.royale.event;
        if (!ev || !(ev.until > Date.now())) return;
        const halfW = global.gameWidth / 2, halfH = global.gameHeight / 2;
        const sx = roomX + (ev.x + halfW) * ratio, sy = roomY + (ev.y + halfH) * ratio;
        const R = (ev.r || 380) * ratio;
        if (sx < -R * 2 || sx > global.screenWidth + R * 2 || sy < -R * 2 || sy > global.screenHeight + R * 2) return;
        const now = performance.now();
        const warn = Date.now() < ev.liveAt;
        const meteor = ev.kind === "meteor";
        const col = meteor ? (warn ? "#ff6c3a" : "#ffb07a") : "#7fb1f2";
        const c = ctx[0];
        c.save();
        c.globalAlpha = warn ? 0.35 + 0.35 * Math.abs(Math.sin(now / 160)) : 0.3;
        c.strokeStyle = col;
        c.lineWidth = Math.max(2, 6 * ratio);
        c.setLineDash([R * 0.1, R * 0.07]);
        c.lineDashOffset = now / 30;
        c.beginPath(); c.arc(sx, sy, R, 0, Math.PI * 2); c.stroke();
        c.setLineDash([]);
        c.globalAlpha = 0.08;
        c.fillStyle = col;
        c.beginPath(); c.arc(sx, sy, R, 0, Math.PI * 2); c.fill();
        c.restore();
        const label = meteor ? (warn ? "METEORS IN " + Math.ceil((ev.liveAt - Date.now()) / 1000) : "METEOR SHOWER") : (warn ? "GEM RAIN IN " + Math.ceil((ev.liveAt - Date.now()) / 1000) : "GEM RAIN");
        drawText(label, sx, sy - R - 14 * ratio, Math.max(11, 16 * ratio), col, "center", true, 1, 5, ctx[0]);
    }

    // ── top cluster ────────────────────────────────────────────────────
    // Each region draws inside its own guard: a failure in one panel logs
    // once and shows a small red note instead of blanking the whole HUD.
    const hudErrLogged = new Set();
    let hudErrText = "";
    function hudSafe(label, fn) {
        try { fn(); } catch (e) {
            hudErrText = label + ": " + (e && e.message || e);
            if (!hudErrLogged.has(label)) { hudErrLogged.add(label); console.error("[HUD] " + label + " failed", e); }
        }
    }
    let hudWaitSince = 0;
    // Automatic effects trim: when frames stay slow for a few seconds the
    // halos, vignettes and half the debris go away; they come back once the
    // frame rate has been healthy for a while. Resolution never changes.
    const fxQ = { last: 0, ema: 16.7, slowSince: 0, fastSince: 0 };
    // Glows and halos go when the automatic trim kicks in or the player
    // turned on "No Glow".
    const glowOff = () => global.lowFx || config.graphical.noGlow;
    function tickAdaptiveQuality() {
        const now = performance.now();
        if (fxQ.last) {
            const dt = Math.min(250, now - fxQ.last);
            fxQ.ema = fxQ.ema * 0.9 + dt * 0.1;
        }
        fxQ.last = now;
        if (document.hidden) return;
        if (global.recording) { global.lowFx = false; fxQ.slowSince = fxQ.fastSince = 0; return; }
        // the 30 FPS cap draws every ~33 ms by design: slow is past 45 ms
        // there (34 latched lowFx on for good, since 20 never comes back)
        const cap30 = !!config.graphical.fpsCap30;
        if (fxQ.ema > (cap30 ? 45 : 34)) { fxQ.fastSince = 0; if (!fxQ.slowSince) fxQ.slowSince = now; }
        else if (fxQ.ema < (cap30 ? 38 : 20)) { fxQ.slowSince = 0; if (!fxQ.fastSince) fxQ.fastSince = now; }
        else { fxQ.slowSince = 0; fxQ.fastSince = 0; }
        if (!global.lowFx && fxQ.slowSince && now - fxQ.slowSince > 3000) { global.lowFx = true; fxQ.slowSince = 0; }
        if (global.lowFx && fxQ.fastSince && now - fxQ.fastSince > 6000) { global.lowFx = false; fxQ.fastSince = 0; }
    }
    // ── the notification stack under the clock ─────────────────────────
    // Every line that wants a spot up there goes through here, by priority:
    // 0 critical (the lock, the storm's last seconds, storm and vault
    // warnings), 1 your hunted status (a compact badge), 2 raid news and
    // timers, 3 the rest. NOTE_ROWS show at once, the same width rules for
    // all; the others wait for a free row (they're states, still there when
    // one frees up). The same line twice shows once.
    // Oct 8: one row (owner: two pills under the clock at once read as clutter);
    // the hunted badge sits beside the clock instead of taking the row
    const NOTE_ROWS = 1, NOTE_H = 24, NOTE_GAP = 8;
    const NOTE_CRIT = /storm|vault|clos|respawn/i;
    const hudNoteList = [], notePool = [];
    let notePoolN = 0;
    function hudNote(pri, key, text, col) {
        const n = notePool[notePoolN] || (notePool[notePoolN] = {});
        notePoolN++;
        n.pri = pri; n.key = key; n.text = text; n.col = col; n.pulse = 0; n.badge = false; n.sub = ""; n.draw = null;
        return n;
    }
    // as wide as the gap between the standings (touch: the minimap) allows
    function noteMaxW() {
        const cx = global.screenWidth / 2;
        let right = global.screenWidth - HUD.edge;
        if (global.mobile) right = Math.min(right, touchMinimapRect().x - 10);
        else if (standingsRect) right = Math.min(right, standingsRect.x - 4);
        // the chat panel, when it sits up level with the stack
        if (!global.mobile && chatPanelRect && chatPanelRect.y < hudTopBottom + 140) right = Math.min(right, chatPanelRect.x - 4);
        return Math.max(220, Math.min(560, 2 * (right - cx)));
    }
    const noteFit = new Map();
    function drawNotePill(c, n, cx, y, maxW) {
        const fk = n.text + "|" + (maxW | 0);
        let fs = noteFit.get(fk);
        if (fs === undefined) {
            // shrink to fit, never cut
            fs = 12.5; while (fs > 9.5 && hudTextW(n.text, fs) + 28 > maxW) fs -= 0.5;
            if (noteFit.size > 64) noteFit.clear();
            noteFit.set(fk, fs);
        }
        const tw = hudTextW(n.text, fs), a = n.pulse ? 0.7 + 0.3 * n.pulse : 1;
        hudPanel(c, Math.round(cx - tw / 2 - 14), y, tw + 28, NOTE_H, { r: NOTE_H / 2, lw: 2.5, lip: 2.5, bevel: false, alpha: a });
        drawText(n.text, cx, y + NOTE_H / 2, fs, n.col, "center", true, a);
        return y + NOTE_H + NOTE_GAP;
    }
    // hunted: a small red tag and a count, not a whole line
    function noteBadgeW(n) { return hudTitleW(n.text, 12) + (n.sub ? hudTextW(n.sub, 11) + 10 : 0) + 22; }
    function drawNoteBadge(c, n, cx, y) {
        const tw = hudTitleW(n.text, 12), sw = n.sub ? hudTextW(n.sub, 11) + 10 : 0;
        const w = tw + sw + 22, h = 22, x = Math.round(cx - w / 2);
        const a = 0.82 + 0.18 * (n.pulse || 1);
        c.save();
        c.globalAlpha = a;
        roundRectPath(c, x, y, w, h, h / 2);
        c.fillStyle = "#3a0d14"; c.fill();
        c.lineWidth = 2.5; c.strokeStyle = n.col; c.stroke();
        c.restore();
        hudTitle(n.text, x + 11, y + h / 2, 12, n.col, "left", a);
        if (n.sub) drawText(n.sub, x + 11 + tw + 10, y + h / 2, 11, "#ffd0d6", "left", true, a);
        return y + h + NOTE_GAP;
    }
    // ── the lane message ───────────────────────────────────────────────
    // Server lines ('m': "Slow down a sec.", the new raid rule, "Taken down
    // by ivy"), the kill feed lines that matter (drawRoyaleFeed) and the side
    // cards (an achievement, growing) all share ONE row in the note stack
    // under the clock: one at a time, oldest first, the rest wait with their
    // clocks held. A queue moves each one along faster. Nothing on the right edge.
    // Oct 8: one row under the clock, so news goes over the steady states (the
    // shield and pad timers, hunted, the goal line) and under the critical ones (0)
    const LANE_MS = 5200, LANE_BUSY_MS = 3000, LANE_WAIT_MAX = 4, LANE_PRI = 0.9;
    // waited this long for the row: old news, dropped
    const LANE_STALE_MS = 14000;
    // said by a line of its own up here already (the spawn shield note)
    const LANE_DUPE = /^You're shielded for \d+ seconds/i;
    const lane = { cur: null, at: 0, shown: false, last: 0, lines: [], fitKey: "", fs: 13 };
    const laneText = (m) => m.textJSON ? m.textJSON.join(" ") : String(m.text == null ? "" : m.text);
    function laneHeld() {
        return !firstSeconds.shows("messages") || !!global.introCardUp || raidFinale.active() || (global.mobile && slamShowing());
    }
    function laneMessage(push) {
        const now = Date.now();
        const dt = lane.last ? Math.min(250, Math.max(0, now - lane.last)) : 0;
        lane.last = now;
        // it lost its row last frame (more urgent lines up): its clock waits
        if (lane.cur && !lane.shown) lane.at += dt;
        lane.shown = false;
        if (laneHeld()) return;
        // a side card takes the row first; it runs on its own clock
        if (sideNotes.length && !global.died) {
            if (lane.cur) lane.at += dt;
            const n = hudNote(LANE_PRI, "lane", "side:" + sideNotes[0].title, color.guiwhite);
            n.draw = drawLaneSide;
            push(n);
            return;
        }
        const msgs = global.messages;
        let waiting = 0;
        for (let i = msgs.length - 1; i >= 0; i--) {
            const m = msgs[i];
            if (m === lane.cur) continue;
            if (!m.laneAt) m.laneAt = now;
            if (!(m.duration > 0) || toastSaid(laneText(m)) || LANE_DUPE.test(laneText(m)) || now - m.laneAt > LANE_STALE_MS) { msgs.splice(i, 1); continue; }
            m.time = now;
            waiting++;
        }
        // a long queue drops its oldest quiet lines (other people's kills) first, then the oldest
        for (let i = 0; waiting > LANE_WAIT_MAX && i < msgs.length; i++) {
            if (msgs[i] !== lane.cur && msgs[i].lo) { msgs.splice(i, 1); i--; waiting--; }
        }
        while (waiting > LANE_WAIT_MAX) { const i = msgs[0] === lane.cur ? 1 : 0; msgs.splice(i, 1); waiting--; }
        if (lane.cur && msgs.indexOf(lane.cur) < 0) lane.cur = null;
        if (lane.cur) {
            const life = Math.min(lane.cur.duration, waiting > 0 ? LANE_BUSY_MS : LANE_MS);
            if (now - lane.at > life) { msgs.splice(msgs.indexOf(lane.cur), 1); lane.cur = null; waiting = Math.max(0, waiting - 1); }
        }
        if (!lane.cur) {
            // your own lines go before other people's kills
            let pick = null;
            for (const m of msgs) if (!m.lo) { pick = m; break; }
            lane.cur = pick || msgs[0] || null;
            lane.at = now;
            if (lane.cur) waiting = Math.max(0, waiting - 1);
        }
        const m = lane.cur;
        if (!m) return;
        const n = hudNote(LANE_PRI, "lane", laneText(m), color.guiwhite);
        n.draw = drawLaneMsg;
        n.msgAge = now - lane.at;
        n.msgLife = Math.min(m.duration, waiting > 0 ? LANE_BUSY_MS : LANE_MS);
        n.rich = !!m.rich;
        push(n);
    }
    function drawLaneSide(c, n, cx, y) {
        lane.shown = true;
        const y2 = drawSideNote(y, cx);
        return y2 > y ? y2 - 10 + NOTE_GAP : y;
    }
    // one or two lines in a pill, the same face as the other notes
    function drawLaneMsg(c, n, cx, y, maxW) {
        lane.shown = true;
        const room = Math.min(maxW, 620) - 32;
        const fk = n.text + "|" + (room | 0);
        if (lane.fitKey !== fk) {
            lane.fitKey = fk;
            lane.fs = 13;
            lane.lines = [n.text];
            // feed lines carry colour codes: one line, shrunk to fit
            if (n.rich) { while (lane.fs > 10 && measureText(n.text, lane.fs) > room) lane.fs -= 0.5; }
            else if (hudTextW(n.text, 13) > room) {
                lane.lines = wrapLines(n.text, 12.5, room).slice(0, 2);
                lane.fs = 12.5;
                while (lane.fs > 10 && lane.lines.some(l => hudTextW(l, lane.fs) > room)) lane.fs -= 0.5;
            }
        }
        const lines = lane.lines, fs = lane.fs, lh = fs + 5;
        let tw = 0;
        for (const l of lines) tw = Math.max(tw, hudTextW(l, fs));
        const H = Math.max(NOTE_H, lines.length * lh + 9);
        const a = Math.max(0, Math.min(1, n.msgAge / 180, (n.msgLife - n.msgAge) / 260));
        hudPanel(c, Math.round(cx - tw / 2 - 14), y, tw + 28, H, { r: Math.min(H / 2, 12), lw: 2.5, lip: 2.5, bevel: false, alpha: a });
        for (let i = 0; i < lines.length; i++) drawText(lines[i], cx, y + H / 2 + (i - (lines.length - 1) / 2) * lh, fs, color.guiwhite, "center", true, a);
        return y + H + NOTE_GAP;
    }
    // QA: what's in the lane queue
    window.dwLane = () => ({ cur: lane.cur ? laneText(lane.cur) : "", waiting: (global.messages || []).filter(m => m !== lane.cur).map(laneText), side: sideNotes.length });

    // Rock biomes: the first time in a raid you settle into one, its name
    // shows for a few seconds at the bottom of the note stack. Quiet on
    // purpose: lowest priority, it simply doesn't show when the stack is busy.
    // A raid start resends the map (terrainRenderer.inits), which clears it.
    const biomeSeen = { inits: -1, seen: new Set(), cur: -1, since: 0, show: null, showAt: 0, checkAt: 0 };
    const BIOME_SETTLE_MS = 1200, BIOME_NOTE_MS = 3500;
    function biomeNote() {
        const tr = window.terrainRenderer, B = window.DWBiomes;
        if (!tr || !tr._bio || !B || global.tutorialMode) return null;
        const bs = biomeSeen, now = performance.now();
        if (bs.inits !== tr.inits) { bs.inits = tr.inits; bs.seen.clear(); bs.cur = -1; bs.show = null; }
        if (global.died || royaleLobbyPhase()) { bs.cur = -1; return null; }
        if (now >= bs.checkAt) {
            bs.checkAt = now + 250;
            const hw = global.gameWidth / 2, hh = global.gameHeight / 2;
            if (hw > 0 && hh > 0) {
                const bio = tr._bio;
                const b = B.biomeAt(global.player.renderx / hw, global.player.rendery / hh, bio.cols, bio.rows, bio.seed);
                // a moment inside first, so running along a seam stays quiet
                if (b !== bs.cur) { bs.cur = b; bs.since = now; }
                else if (now - bs.since >= BIOME_SETTLE_MS && !bs.seen.has(b)) {
                    bs.seen.add(b);
                    bs.show = B.BIOMES[b];
                    bs.showAt = now;
                }
            }
        }
        return bs.show && now - bs.showAt < BIOME_NOTE_MS ? bs.show : null;
    }
    function drawHudNotes(y) {
        const r = global.royale;
        const list = hudNoteList;
        list.length = 0; notePoolN = 0;
        const push = (n) => {
            if (!n || !n.text) return;
            for (const o of list) if (o.key === n.key || o.text === n.text) return;
            list.push(n);
        };
        const st = r.storm || {};
        // (the Crown Contest keeps the last storm open: no lock there)
        if (r.lock) push(hudNote(0, "lock", st.fin ? "Last " + Math.max(0, r.lockLeft | 0) + "s of the raid, so nobody respawns now."
            : "The storm shuts in " + Math.max(0, r.lockLeft | 0) + "s, and nobody respawns until it opens.", HUD.lilac));
        else if (r.toast && newcomer.toastAllowed(r.toast)) push(hudNote(NOTE_CRIT.test(r.toast) ? 0 : 2, "toast", r.toast, color.guiwhite));
        // the pad timers, up top where nothing covers them (round 12)
        if (!global.died && r.occupy > 0) push(hudNote(1, "padtime", "You can stay " + r.occupy + "s longer", color.gold));
        else if (!global.died && r.lockout > 0) push(hudNote(1, "padtime", "You can come back in " + r.lockout + "s", color.guiwhite));
        try { push(spawnShieldNote()); } catch (e) { /* */ }
        try { raidHeat.hudNotes(push); } catch (e) { /* */ }
        try { aoHud.hudNotes(push, hudNote, HUD); } catch (e) { }
        // the Crown Contest: one line when there's no tracker panel (a first
        // raid, a phone), or when you hold a crown
        try { crowns.hudNotes(push, global.mobile || !nxShows("standings") || (global.nxKnown && (global.nxStage | 0) === 0)); } catch (e) { /* */ }
        // the first raids: the goal line, a challenge's clock, NEW intros
        try { newcomer.hudNotes(push, hudNote); } catch (e) { /* */ }
        try { coach.mineTipNote(push, hudNote); } catch (e) { /* */ }
        if (teamBankTip && !global.died) {
            const tn = performance.now();
            if (!teamBankTip.shownAt && !global.hudCardUp && tn - (global.spawnedAt || 0) > 7000) teamBankTip.shownAt = tn;
            if (teamBankTip.shownAt && tn - teamBankTip.shownAt < 9000) push(hudNote(2, "teambank", buildBtnLabels.TEAM_BANK_TIP, HUD.gold));
            else if (teamBankTip.shownAt) teamBankTip = null;
        }
        const objs = nxShows("outposts") ? r.objectives || [] : [];
        for (let i = 0; i < Math.min(2, objs.length); i++) {
            const o = objs[i];
            if (o.kind === "contest") push(hudNote(2, "contest" + i, (o.name || "Outpost") + " contested", o.c || color.gold));
        }
        if (!global.died) {
            const you = r.you || {};
            if (you.overdrive > 0 || you.anchor > 0) {
                const parts = [];
                if (you.overdrive > 0) parts.push("OVERDRIVE " + you.overdrive + "s");
                if (you.anchor > 0) parts.push("STORM ANCHOR " + you.anchor + "s");
                push(hudNote(2, "buff", parts.join("   "), color.teal));
            }
            // a big satchel with danger around: bank it, it isn't points yet
            const carryN = global.gems && global.gems.carried != null ? global.gems.carried | 0 : you.carried | 0;
            const cn = scoreText.carryNote({
                carried: carryN, near: you.hunt ? you.hunt.n | 0 : 0, storm: (you.sm || 0) > 0, noBank: false,
                hp: global.hurtAt && performance.now() - global.hurtAt < 4000 ? 0.5 : 1,
            });
            // the vault deposit: how far it got, and what's still carried when it stops short
            const v0 = global.vault;
            if (v0 && (v0.total > 0 || v0.cutAt > 0)) {
                const nowD = performance.now();
                const live = (v0.total | 0) > 0 && (v0.remaining | 0) > 0;
                if (live || nowD - v0.cutAt < scoreText.DEP_CUT_MS) {
                    const dc = global._depNote || (global._depNote = { t: -1, r: -1, cut: -1, car: -1, n: null });
                    if (dc.t !== (v0.total | 0) || dc.r !== (v0.remaining | 0) || dc.cut !== (v0.cutAt || 0) || dc.car !== carryN) {
                        dc.t = v0.total | 0; dc.r = v0.remaining | 0; dc.cut = v0.cutAt || 0; dc.car = carryN;
                        dc.n = scoreText.depositNote(v0, carryN, nowD);
                    }
                    const dn = dc.n;
                    if (dn) push(hudNote(0, "deposit", dn.text, dn.hot ? "#ff9a5c" : HUD.gold));
                }
            }
            // a full satchel says it once, in the stack (it used to print on its own under it too)
            const gfull = global.gems && global.gems.cap > 0 && (global.gems.carried | 0) >= global.gems.cap;
            if (gfull && config.game.satchelWarning) {
                const fn = hudNote(0, "carry", "Your satchel is full. Go bank it.", "#ff7a6b");
                fn.pulse = 0.5 + 0.5 * Math.sin(performance.now() / 160);
                push(fn);
            } else if (cn) {
                push(hudNote(cn.hot ? 1 : 2, "carry", cn.text + ". " + cn.sub, cn.hot ? "#ffb347" : HUD.gold));
            }
            const myStreak = you.streak | 0;
            if (myStreak >= 4 && nxShows("streaks")) push(hudNote(3, "streak", myStreak + " kill streak! You're on everyone's map now", "#ffb347"));
            // Raid Night coming up (shared/events.js): a small chip in the last 24 h
            const evChip = global.tutorialMode || !nxShows("raidNight") ? "" : eventHudTick().chip;
            if (evChip) push(hudNote(3, "event", evChip, HUD.gold));
            const biome = biomeNote();
            if (biome) push(hudNote(3, "biome", biome.name, biome.ui));
        }
        // the one message row: server lines, your kills, side cards
        try { laneMessage(push); } catch (e) { /* never break the frame */ }
        list.sort((a, b) => a.pri - b.pri);
        const c = ctx[2], cx = global.screenWidth / 2, maxW = noteMaxW();
        // a badge (hunted) goes left of the clock plate, level with its top row
        const ck = hudDrawn.clock;
        if (ck && !topMin.on) {
            for (let i = list.length - 1; i >= 0; i--) {
                if (!list[i].badge) continue;
                const b = list.splice(i, 1)[0];
                const bw = noteBadgeW(b);
                drawNoteBadge(c, b, Math.round(ck.x - 10 - bw / 2), ck.y + 8);
            }
        }
        for (let i = 0; i < list.length && i < NOTE_ROWS; i++) {
            y = list[i].draw ? list[i].draw(c, list[i], cx, y, maxW) : list[i].badge ? drawNoteBadge(c, list[i], cx, y) : drawNotePill(c, list[i], cx, y, maxW);
        }
        return y;
    }
    // QA: what the stack shows this frame
    window.dwHudNotes = () => hudNoteList.slice(0, NOTE_ROWS + 1).map(n => n.text + (n.sub ? " " + n.sub : ""));

    function drawRoyaleHUD() {
        const cx = global.screenWidth / 2;
        const now = performance.now();
        if (!royaleActive()) {
            // raid data has not arrived yet
            if (global.digRoyaleMode && global.gameStart && !global.tutorialMode) {
                if (!hudWaitSince) hudWaitSince = now;
                else if (now - hudWaitSince > 4000) drawText(global.aoWorld ? "Waiting for the server..." : "Waiting for raid data...", cx, 30, 13, color.grey, "center");
            }
            return;
        }
        hudWaitSince = 0;
        hudErrText = "";
        tickAdaptiveQuality();
        const r = global.royale;
        if (raidFinale.hidesHud()) { hudTopBottom = HUD.edge; return; }
        if (!global.died) spectateBarBottom = 0;
        let top0 = global.died && spectateBarBottom > 0 ? spectateBarBottom : 0;
        // touch, held upright: under the button row and the minimap
        if (global.mobile && global.screenHeight > global.screenWidth && !top0) { const mm = touchMinimapRect(); top0 = mm.y + mm.h + 4 - HUD.edge; }
        let y = HUD.edge + top0;
        hudSafe("top", () => {
            // one plate: raid clock | alive, then your place and the storm.
            // Minimized (the corner toggle, remembered): one slim strip.
            const c = ctx[2];
            const st = r.storm || {};
            const placeTxt = r.place > 0 ? "#" + r.place + "  ·  " + fmtNum(r.youScore | 0) + " pts"
                : r.youScore > 0 ? fmtNum(r.youScore | 0) + " pts" : "";
            // a raid is st.cn storms; the last one closes all the way
            const stormNo = st.fin ? "Last storm" : st.cn > 0 ? "Storm " + ((st.c | 0) + 1) + "/" + st.cn : "Storm";
            const stormTxt = !st.a ? "" : st.fin && st.hold ? "Last storm closing"
                : st.hold ? stormNo + " holds " + fmtRaidClock(st.left | 0) : stormNo + " in " + fmtRaidClock(st.left | 0);
            const stormCol = st.hold ? HUD.gold : HUD.lilac;
            // Raid Night staging: the raid hasn't started; a countdown instead of the clock
            const stLeft = r.staging > 0 ? Math.max(0, r.staging - (performance.now() - (r.stagingAt || 0))) : 0;
            if (stLeft > 0) {
                const SW = 340, SH = 66, sx0 = Math.round(cx - SW / 2), sy0 = y;
                hudPanel(c, sx0, sy0, SW, SH);
                hudDrawn.clock = { x: sx0, y: sy0, w: SW, h: SH };
                const secs = Math.ceil(stLeft / 1000);
                const lw2 = hudTitleW("Raid starts in", 15), vw = hudTitleW(fmtRaidClock(secs), 24);
                const x0 = cx - (lw2 + 8 + vw) / 2;
                hudTitle("Raid starts in", x0, sy0 + 22, 15, HUD.text2, "left");
                hudTitle(fmtRaidClock(secs), x0 + lw2 + 8, sy0 + 22, 24, secs <= 10 ? HUD.gold : HUD.head, "left");
                drawText("The raid hasn't started yet, so hang out for a bit.", cx, sy0 + 48, 12, HUD.lilac, "center", true);
                y = sy0 + SH + HUD.lip + 8;
                return;
            }
            if (r.ao && r.ao.on) { y = aoHud.drawPanel(c, cx, y, aoApi()); return; }
            if (topMin.on) { y = drawTopStrip(c, cx, y, stormTxt, stormCol); return; }
            const PW = 300, rowH = 38, footH = (placeTxt || stormTxt) ? 24 : 0, PH = rowH + footH;
            const px = Math.round(cx - PW / 2), py = y;
            hudPanel(c, px, py, PW, PH);
            // your points sit on this plate: hover it for how they add up
            if (placeTxt) pointsRuleTip(px, py + rowH, PW, footH);
            hudDrawn.clock = { x: px, y: py, w: PW, h: PH };
            const pair = (label, value, zx) => {
                const lw2 = hudTitleW(label, 15), vw = hudTitleW(value, 21), gap = 6;
                const x0 = zx - (lw2 + gap + vw) / 2;
                hudTitle(label, x0, py + rowH / 2 + 1, 15, HUD.text2, "left");
                hudTitle(value, x0 + lw2 + gap, py + rowH / 2, 21, HUD.head, "left");
            };
            pair("Raid", fmtRaidClock(r.raidLeft | 0), px + PW * 0.27);
            pair("Alive", String(r.alive | 0), px + PW * 0.7);
            if (footH) {
                const fy = py + rowH + footH / 2 - 3;
                if (placeTxt && stormTxt) {
                    drawText(placeTxt, px + 14, fy, 12, HUD.gold, "left", true);
                    drawText(stormTxt, px + PW - 14, fy, 12, stormCol, "right", true);
                } else drawText(placeTxt || stormTxt, cx, fy, 12, placeTxt ? HUD.gold : stormCol, "center", true);
            }
            drawTopToggle(c, px + PW - 17, py + 6, false);
            // round 9: the storm stage's gem multiplier (server RY storm.gmul), a small pill
            const gm = +st.gmul || 1;
            if (gm > 1 && st.a) {
                const gt = gm === 1.5 ? "Gems x1.5" : gm === 2 ? "Gems x2" : "Gems x" + (Math.round(gm * 10) / 10);
                const gw = hudTitleW(gt, 13) + 16, gh = 22, gx = px - 8 - gw, gy = py + rowH + footH / 2 - gh / 2;
                hudPanel(c, gx, gy, gw, gh, { r: 4 });
                hudTitle(gt, gx + gw / 2, gy + gh / 2, 13, HUD.gold, "center");
            }
            // what moved your points, right by them (scoreLogic ptsPops)
            if (placeTxt && !global.died) drawPtsPops(px + PW + 10, py + rowH + footH / 2, "left", 1);
            y = py + PH + HUD.lip + 8;
        });
        hudSafe("notes", () => { y = drawHudNotes(y); });
        if (r.ao && r.ao.on) hudSafe("aoResult", () => { y = aoHud.drawResult(ctx[2], cx, y, aoApi()); });
        hudSafe("boss", () => {
            // the boss and the Core share one row of compact cards; the row is
            // reserved in full while a card is visible (alpha fades, nothing
            // below slides). Minimized, the strip carries them instead.
            // the first raids: the cards only when it's right there
            bossGlide.set(r.boss && nxShows("boss", { near: newcomer.bossNear() }) ? 1 : 0);
            const bg = bossGlide.get();
            const boss = bg > 0.02, core = raidHeat.coreUp() && nxShows("core", { near: newcomer.coreNear() });
            if (topMin.on || (!boss && !core)) return;
            const c = ctx[2], gap = 10;
            const W = boss && core ? Math.min(236, (global.screenWidth - 60 - gap) / 2) : Math.min(300, global.screenWidth - 60);
            let x = Math.round(cx - (boss && core ? W * 2 + gap : W) / 2);
            if (boss) { drawBossBar(x, y, W, bg); x += W + gap; }
            if (core) raidHeat.drawCoreCard(c, x, y, W, BOSS_H);
            y += BOSS_H + BOSS_GAP;
        });
        // round 12: the pad timers ("You can come back in 1s") sat under your
        // name and the carried bar; they are note-stack lines now (drawHudNotes)
        hudSafe("countdown", () => raidFinale.drawCountdown(y));
        // the storm warning gets its own row right here, away from the tank,
        // and the slams (stormFx.drawHud fills it)
        stormHud.rowY = 0;
        if (stormHud.inside || stormHud.near) { stormHud.rowY = y; y += 34; }
        hudTopBottom = y;
        // CSS px, for the DOM notification cards under the clock (gameToasts.js)
        global.hudTopPx = y * window.innerWidth / Math.max(1, global.screenWidth);
        let standBottom = 36;
        // touch: the minimap has that corner; standings are a tap away on the map
        if (global.mobile) { const mm = touchMinimapRect(); standBottom = Math.max(mm.y + mm.h + 18, global.screenHeight > global.screenWidth ? y + 6 : 0); }
        else if (nxShows("standings")) hudSafe("standings", () => { standBottom = drawRoyaleStandings(); });
        else standingsRect = null;
        hudSafe("feed", () => drawRoyaleFeed(standBottom + 14));
        hudSafe("cards", layoutLeftCards);
        hudSafe("duo", drawDuoCard);
        hudSafe("quest", drawQuestCard);
        hudSafe("override", drawOverrideCard);
        hudSafe("storm", () => {
            const hs = stormHud;
            const s = stormSnap();
            // round 8: not before your tank exists or while it is still falling in: the
            const placed = !!global.selfEnt && global.selfEnt.id === gui.playerid && !global.raidQueued && !(raidHeat.landAt && raidHeat.landAt() > performance.now());
            hs.inside = !!s && !global.died && placed && playerInStorm();
            if (hs.inside) {
                const px = global.player.renderx, py = global.player.rendery;
                const you = r.you || {};
                hs.sm = +you.sm || 0;
                hs.immune = you.anchor | 0;
                hs.final = !!(s.fin && s.hold);
                hs.dist = Math.hypot(px - s.cx, py - s.cy) - s.r;
                hs.dirAng = Math.atan2(s.cy - py, s.cx - px);
            }
            // still inside, but the edge gets here soon: seconds until it does
            hs.near = 0;
            if (!hs.inside && s && !global.died) {
                const raw = aoHud.stormView() || global.royale.storm || {};
                const speed = raw.n == null ? 0 : ((raw.r || 0) - raw.n) * 4;
                const px = global.player.renderx, py = global.player.rendery;
                const gap = s.r - Math.hypot(px - s.cx, py - s.cy);
                if (speed > 0.5 && gap / speed < STORM_NEAR_S) {
                    hs.near = Math.max(1, Math.ceil(gap / speed));
                    hs.dirAng = Math.atan2(s.cy - py, s.cx - px);
                }
            }
            hs.laneY = hudLanes().slamY;
            hs.yieldText = raidHeat.slamUp();
            ctx[2].save();
            stormFx.drawHud(ctx[2], global.screenWidth, global.screenHeight, hudTopBottom, hs);
            ctx[2].restore();
        });
        if (hudErrText) drawText("HUD error: " + hudErrText, cx, global.screenHeight - 78, 11, "#ff7a6b", "center");
    }
    let aoApiObj = null;
    function aoApi() {
        if (aoApiObj) return aoApiObj;
        aoApiObj = {
            HUD, fmtNum, hudPanel, hudTitle, hudTitleW, hudTextW, drawText,
            setClock: (rect) => { hudDrawn.clock = rect; },
            pops: (x, y) => drawPtsPops(x, y, "left", 1),
            label: (text, x, y, size, col) => drawText(text, x, y, size, col, "center", true, 0.95),
            infoDot: (cx, cy) => drawRuleDot(ctx[2], cx, cy),
            hoverTip: (x, y, w, h, title, body) => {
                if (global.mobile || !global.canvas || global.died) return false;
                const cr = global.canvas.height / global.screenHeight / global.ratio;
                const mx = global.mouse.x / (cr * global.ratio), my = global.mouse.y / (cr * global.ratio);
                if (mx >= x && mx <= x + w && my >= y && my <= y + h) { queueTip(title, body, x + w / 2, y + h, false); return true; }
                return false;
            },
        };
        return aoApiObj;
    }
    const stormHud = { inside: false, near: 0, sm: 0, immune: 0, final: false, dist: 0, dirAng: 0, laneY: 0, yieldText: false, rowY: 0 };
    const STORM_NEAR_S = 15;   // warn this many seconds before the edge reaches you
    const BOSS_H = 44, BOSS_GAP = 10;
    let spectateBarBottom = 0;   // the top cluster starts under the spectate bar while dead
    function drawBossBar(x, y, W, a) {
        const b = global.royale.boss || global._lastBoss;
        if (!b) return;
        global._lastBoss = b;
        const c = ctx[2];
        const H = BOSS_H;
        const col = b.c || "#c9a8ff";
        const dist = Math.hypot((b.x || 0) - global.player.renderx, (b.y || 0) - global.player.rendery);
        hudPanel(c, x, y, W, H, { alpha: a });
        c.save();
        c.globalAlpha = a;
        polyPath(c, x + 16, y + 13, 7, 8, Math.PI / 8);
        c.fillStyle = col; c.fill();
        c.strokeStyle = HUD.ink; c.lineWidth = 2; c.stroke();
        c.restore();
        // three fixed rows: name and bounty, health bar, percent and range
        const gemsTxt = fmtNum(b.gems) + " gems";
        const gemsW = hudTitleW(gemsTxt, 12);
        const nameTxt = String(b.name || "Boss");
        let ns = 14; while (ns > 10 && hudTitleW(nameTxt, ns) > W - 28 - gemsW - 18) ns -= 0.5;
        hudTitle(nameTxt, x + 28, y + 13, ns, col, "left", a);
        hudTitle(gemsTxt, x + W - 10, y + 13, 12, HUD.gold, "right", a);
        const bx = x + 10, bw = W - 20, bh = 8, byTop = y + 22;
        const hp = Math.max(0, Math.min(1, b.hp || 0));
        c.save();
        c.globalAlpha = a;
        hudBar(c, bx, byTop, bw, bh, hp, hp > 0.5 ? col : hp > 0.2 ? HUD.gold : HUD.danger);
        if (b.sh > 0.01) {
            c.globalAlpha = a * 0.6;
            roundRectPath(c, bx + 2, byTop + 2, Math.max(3, (bw - 4) * b.sh), bh - 4, (bh - 4) / 2);
            c.fillStyle = color.teal; c.fill();
        }
        c.restore();
        drawText(Math.round(hp * 100) + "%", bx + 2, y + H - 8, 9.5, HUD.text2, "left", true, a);
        if (isFinite(dist) && dist < 1e6) drawText(fmtDist(dist) + " away", bx + bw - 2, y + H - 8, 9.5, HUD.text2, "right", true, a);
    }
    // ── the top group, minimized: "16:07 · Storm 1/3 in 1:07" on one strip,
    // with a boss or Core hp sliver. The toggle sits in the corner of either.
    const TOP_MIN_KEY = "dwHudTopMin";
    const topMin = { on: (() => { try { return localStorage.getItem(TOP_MIN_KEY) === "1"; } catch (e) { return false; } })(), rect: null };
    function setTopMin(on) {
        topMin.on = !!on;
        try { localStorage.setItem(TOP_MIN_KEY, topMin.on ? "1" : "0"); } catch (e) { /* */ }
        try { gameSound.uiClick(); } catch (e) { /* */ }
    }
    // a small keycap with a chevron: up = shrink, down = open again
    function drawTopToggle(c, x, y, open) {
        const s = 14;
        hudWell(c, x - 2, y - 2, s + 4, s + 4, 5);
        c.save();
        c.strokeStyle = HUD.text2; c.lineWidth = 2; c.lineCap = "round"; c.lineJoin = "round";
        c.beginPath();
        const mx = x + s / 2, my = y + s / 2, d = open ? 2 : -2;
        c.moveTo(mx - 4, my - d); c.lineTo(mx, my + d); c.lineTo(mx + 4, my - d);
        c.stroke();
        c.restore();
        // generous to tap: the whole corner
        topMin.rect = { x: x - 10, y: y - 8, w: s + 20, h: s + 16 };
    }
    function drawTopStrip(c, cx, y, stormTxt, stormCol) {
        const r = global.royale;
        const clock = fmtRaidClock(r.raidLeft | 0);
        const sep = stormTxt ? "  ·  " : "";
        const cw = hudTitleW(clock, 15), sw = stormTxt ? hudTextW(sep + stormTxt, 11.5) : 0;
        const boss = !!r.boss, core = raidHeat.coreUp();
        const SL = 52, minis = (boss ? SL + 10 : 0) + (core ? SL + 10 : 0);
        const H = 26, W = Math.round(cw + sw + minis + 50);
        const x = Math.round(cx - W / 2);
        hudPanel(c, x, y, W, H, { r: 9 });
        hudDrawn.clock = { x, y, w: W, h: H };
        let tx = x + 12;
        hudTitle(clock, tx, y + H / 2, 15, HUD.head, "left");
        tx += cw;
        if (stormTxt) { drawText(sep + stormTxt, tx, y + H / 2, 11.5, stormCol, "left", true); tx += sw; }
        tx += 10;
        if (boss) {
            const b = r.boss, col = b.c || "#c9a8ff";
            c.save();
            polyPath(c, tx + 6, y + H / 2, 5, 8, Math.PI / 8);
            c.fillStyle = col; c.fill(); c.strokeStyle = HUD.ink; c.lineWidth = 1.5; c.stroke();
            c.restore();
            hudBar(c, tx + 15, y + H / 2 - 3, SL - 15, 6, Math.max(0, Math.min(1, b.hp || 0)), col);
            tx += SL + 10;
        }
        if (core) { raidHeat.drawCoreMini(c, tx, y + H / 2, SL); tx += SL + 10; }
        drawTopToggle(c, x + W - 22, y + 6, true);
        return y + H + HUD.lip + 8;
    }
    // the toggle takes the press before the game sees it (no shot fired)
    {
        const inRect = (R, cx0, cy0) => {
            if (!R) return false;
            const gx = cx0 * global.screenWidth / Math.max(1, window.innerWidth), gy = cy0 * global.screenHeight / Math.max(1, window.innerHeight);
            return gx >= R.x && gx <= R.x + R.w && gy >= R.y && gy <= R.y + R.h;
        };
        const hitTop = (cx0, cy0) => !!global.gameStart && royaleActive() && !raidFinale.hidesHud() && inRect(topMin.rect, cx0, cy0);
        let swallowUp = false;
        window.addEventListener("mousedown", (e) => {
            if (e.button !== 0 || !hitTop(e.clientX, e.clientY)) return;
            setTopMin(!topMin.on); swallowUp = true;
            e.preventDefault(); e.stopImmediatePropagation();
        }, true);
        window.addEventListener("mouseup", (e) => { if (swallowUp) { swallowUp = false; e.stopImmediatePropagation(); } }, true);
        window.addEventListener("touchstart", (e) => {
            const t = e.changedTouches && e.changedTouches[0];
            if (!t) return;
            if (leftCards && leftCards.modMin && global.gameStart && inRect(overrideRect, t.clientX, t.clientY)) {
                modView.openUntil = performance.now() + 6000;
                e.preventDefault(); e.stopImmediatePropagation();
                return;
            }
            if (!hitTop(t.clientX, t.clientY)) return;
            setTopMin(!topMin.on);
            e.preventDefault(); e.stopImmediatePropagation();
        }, { capture: true, passive: false });
        window.dwHudTopMin = (v) => { if (v != null) setTopMin(v); return topMin.on; };
    }

    // ── race panel: top three plus you, with your gap to first ──────────
    const standingsFit = new Map();
    function standingsHex(ci) {
        let h = null;
        if (ci != null) { try { h = gameDraw.getColor(ci); } catch (e) { h = null; } }
        return typeof h === "string" && h[0] === "#" ? h : color.red;
    }
    function fitStandingsText(head, name, tail, room) {
        const key = head + "|" + name + "|" + tail + "|" + (room | 0);
        let f = standingsFit.get(key);
        if (f) return f;
        const full = String(name || "Unnamed");
        let ns = 11.5, text = head + full + tail;
        while (ns > 9 && measureText(text, ns) > room) ns -= 0.5;
        for (let k = full.length - 1; k >= 1 && measureText(text, ns) > room; k--) text = head + full.slice(0, k).trimEnd() + "…" + tail;
        f = { text, ns };
        if (standingsFit.size > 64) standingsFit.clear();
        standingsFit.set(key, f);
        return f;
    }
    // duos: team rows ("Alex & Sam", combined score); your team's names in your colour
    function drawTeamStandings() {
        const r = global.royale;
        const teams = r.teams || [];
        if (!teams.length) { standingsRect = null; return 36; }
        const W = Math.min(262, global.screenWidth * 0.3), rowH = 22;
        const x = global.screenWidth - HUD.edge - W, y0 = HUD.edge;
        const myTm = r.duo ? r.duo.tm : null;
        const myPlace = r.duo ? r.duo.place | 0 : 0;
        const top = teams.slice(0, 3);
        const me = myPlace > 3 ? teams.find(t => t.tm === myTm) : null;
        const rows = me ? top.concat([me]) : top;
        const H = 30 + rows.length * rowH + (myPlace > 1 ? 16 : 2);
        standingsRect = { x: x - 8, y: y0 - 8, w: W + 16, h: H + 16 };
        const c = ctx[2];
        hudTitle("Team leaderboard", x + W / 2, y0 + 12, 19, HUD.head, "center");
        let crownOn = false;
        try { crownOn = crowns.drawTeamEdge(c, x, y0, W, H); } catch (e) { }
        const myHex = playerHexCol() || color.gold;
        const best = Math.max(1, (top[0] && top[0].score) | 0);
        const barH = 18;
        let ry = y0 + 28;
        for (const t of rows) {
            const isMe = myTm != null && t.tm === myTm;
            const rowMid = ry + barH / 2;
            const nCr = crownOn ? Math.min(2, t.cr | 0) : 0;
            const bx = x + nCr * 13, bw = W - nCr * 13;
            for (let k = 0; k < nCr; k++) { try { crowns.drawCrownIcon(c, x + 5 + k * 13, rowMid, 11, "gold", 1); } catch (e) { } }
            hudBar(c, bx, ry, bw, barH, Math.max(0.05, (t.score | 0) / best), isMe ? myHex : standingsHex(t.c));
            const names = (t.names || []).map(n => shortName(n, t.names.length > 1 ? 9 : 16)).join(" & ");
            const fit = fitStandingsText(t.place > 3 ? "#" + t.place + " " : "", names, " - " + fmtNum(t.score | 0), bw - barH - 4);
            drawText(fit.text, bx + bw / 2, rowMid, fit.ns, t.alive ? color.guiwhite : HUD.text2, "center", true);
            ry += rowH;
        }
        if (myPlace > 1 && top[0]) {
            const gap = (top[0].score | 0) - ((r.duo && r.duo.score) | 0);
            drawText(fmtNum(Math.max(0, gap)) + " behind #1", x + W / 2, ry + 5, 11, HUD.text2, "center", true);
        }
        return y0 + H;
    }
    function drawRoyaleStandings() {
        const r = global.royale;
        if (r.duos && r.teams) return drawTeamStandings();
        // the Crown Contest: the three crowns take the standings' place
        const aoOn = !!(r.ao && r.ao.on);
        if (crowns.active() && !aoOn) {
            const W = Math.min(262, global.screenWidth * 0.3);
            const x = global.screenWidth - HUD.edge - W, y0 = HUD.edge;
            const bottom = crowns.drawTracker(ctx[2], x, y0, W);
            standingsRect = { x: x - 8, y: y0 - 8, w: W + 16, h: bottom - y0 + 16 };
            pointsRuleTip(x, y0, W, bottom - y0);
            return bottom;
        }
        const board = r.board || [];
        if (!board.length) { standingsRect = null; return 36; }
        const W = Math.min(262, global.screenWidth * 0.3), rowH = 22, barH = 18;
        const x = global.screenWidth - HUD.edge - W, y0 = HUD.edge;
        const myPlace = r.place | 0;
        const top = board.slice(0, 3);
        const me = myPlace > 3 ? board.find(row => !row.bot && row.place === myPlace) : null;
        const rows = me ? top.concat([me]) : top;
        const aoFoot = aoOn ? aoHud.standingsFoot() : null;
        const aoFootH = aoFoot ? 16 + (aoFoot.line2 ? 15 : 0) : 0;
        const H = 30 + rows.length * rowH + (myPlace > 1 ? 16 : 2) + aoFootH;
        standingsRect = { x: x - 8, y: y0 - 8, w: W + 16, h: H + 16 };
        const c = ctx[2];
        const boardTitle = aoOn ? aoHud.standingsTitle() : "Leaderboard";
        hudTitle(boardTitle, x + W / 2, y0 + 12, 19, HUD.head, "center");
        drawRuleDot(c, x + W / 2 + hudTitleW(boardTitle, 19) / 2 + 14, y0 + 12);
        pointsRuleTip(x, y0, W, H);
        const myHex = playerHexCol() || color.gold;
        const mineRow = (row) => !row.bot && row.place === myPlace && myPlace > 0;
        const codeOf = (row) => mineRow(row) ? nameBadgeCode(myRankCode() || row.rk, true) : nameBadgeCode(row.rk, false);
        const rkCol = rows.some(row => codeOf(row)) ? 18 : 0;
        const best = Math.max(1, (top[0] && top[0].score) | 0);
        let ry = y0 + 28;
        for (const row of rows) {
            const isMe = mineRow(row);
            const barCol = isMe ? myHex : standingsHex(row.c);
            const rowMid = ry + barH / 2;
            const rk = codeOf(row);
            if (rk) rankBadges.drawBadge(c, x + 7, rowMid, 15, rankBadges.codeToDivision(rk));
            const bx = x + rkCol, bw = W - rkCol;
            hudBar(c, bx, ry, bw, barH, Math.max(0.05, (row.score | 0) / best), barCol);
            const head = row.place > 3 ? "#" + row.place + " " : "";
            const tail = " - " + fmtNum(row.score | 0) + (row.streak >= 4 ? " x" + row.streak : "");
            const fit = fitStandingsText(head, shortName(row.name, 18), tail, bw - barH - 4);
            drawText(fit.text, bx + bw / 2, rowMid, fit.ns, color.guiwhite, "center", true);
            if (aoOn && row.cr) { try { crowns.drawCrownIcon(c, bx + bw - 10, rowMid, 11, "gold", 1); } catch (e) { } }
            ry += rowH;
        }
        if (myPlace > 1 && top[0]) {
            const gap = (top[0].score | 0) - (r.youScore | 0);
            drawText(fmtNum(gap) + " behind #1", x + W / 2, ry + 5, 11, HUD.text2, "center", true);
            ry += 16;
        }
        if (aoFoot) {
            const fy = myPlace > 1 && top[0] ? ry + 4 : ry + 9;
            let fs = 11;
            while (fs > 9 && hudTextW(aoFoot.line1, fs) > W) fs -= 0.5;
            drawText(aoFoot.line1, x + W / 2, fy, fs, HUD.gold, "center", true);
            if (aoFoot.line2) {
                let f2 = 10.5;
                while (f2 > 8.5 && hudTextW(aoFoot.line2, f2) > W) f2 -= 0.5;
                drawText(aoFoot.line2, x + W / 2, fy + 15, f2, HUD.text2, "center", true);
            }
        }
        return y0 + H;
    }

    // How points add up, on hover over the standings (desktop)
    function drawRuleDot(c, cx, cy) {
        c.save();
        c.beginPath(); c.arc(cx, cy, 6.5, 0, Math.PI * 2);
        c.fillStyle = "rgba(0,0,0,0.45)"; c.fill();
        c.restore();
        drawText("?", cx, cy + 0.5, 10, HUD.head, "center", true);
    }
    function pointsRuleTip(x, y, w, h) {
        if (global.mobile || !global.canvas || global.died) return;
        const cr = global.canvas.height / global.screenHeight / global.ratio;
        const mx = global.mouse.x / (cr * global.ratio), my = global.mouse.y / (cr * global.ratio);
        if (mx >= x && mx <= x + w && my >= y && my <= y + h) queueTip(scoreText.RULE, scoreText.ruleBody(aoNow()), x + w / 2, y + h, false);
    }
    window.dwPointsRule = () => ({ rule: scoreText.RULE, body: scoreText.ruleBody(aoNow()), bank: scoreText.bankTipBody(aoNow()) });

    // ── kill feed: one line, one badge at most, quiet ───────────────────
    function feedLine(f) {
        const myHex = playerHexCol(), myName = global.playerName || "";
        const tag = (n, col) => "§" + col + "§" + n + "§reset§";
        const who = (n, dflt, max = 13) => {
            const nm = shortName(n || dflt, max);
            return (myHex && (n || "") === myName) ? tag(nm, myHex) : nm;
        };
        let badge = null;
        if (f.ao) return aoHud.feedLine(f, who, tag);
        const crownLine = crowns.feedLine(f, who, tag);
        if (crownLine) return crownLine;
        const heat = raidHeat.feedLine(f, who, tag);
        if (heat) return heat;
        if (f.boss) {
            const nm = tag(f.name || "Boss", f.c || "#c9a8ff");
            if (f.spawn) return { text: nm + " has surfaced", badge: null };
            if (f.gone) return { text: nm + " burrowed away", badge: null };
            if (f.slain) return { text: tag(shortName(f.by || "The wall", 14), (myHex && (f.by || "") === myName) ? myHex : color.gold) + " took down " + nm, badge: f.pts ? { t: "+" + fmtNum(f.pts), col: color.gold } : null };
        }
        if (f.chest) return { text: who(f.name, "Someone") + " opened an epic chest", badge: null };
        if (f.bloom) return { text: "Ore bloom in " + (f.name || "the wall"), badge: null };
        if (f.event) return { text: f.kind === "meteor" ? "Meteor shower over " + (f.name || "the map")
            : f.kind === "supply" ? "Supply drop in " + (f.name || "the zone")
            : f.kind === "bounty" ? (f.lead ? "Bounty on the leader: " : "Bounty on ") + who(f.name, "someone")
            : "Gem rain over the safe zone", badge: null };
        if (f.storm) return { text: who(f.name, "Someone") + " got caught by the storm", badge: null };
        if (f.rock) return { text: who(f.name, "Someone") + " got crushed by the wall", badge: null };
        if (!f.name) return null;
        const vic = who(f.name, "someone");
        if (!f.by) return { text: vic + " went down", badge: null };
        if (f.verb === "was devoured by") return { text: vic + " fed the " + tag(shortName(f.by || "boss", 16), "#c9a8ff"), badge: null };
        const byCol = (myHex && (f.by || "") === myName) ? myHex : "gold";
        const text = tag(shortName(f.by || "Someone", 13), byCol) + "  ›  " + vic;
        if (f.shutdown) badge = { t: "SHUTDOWN", col: "#ff9a5a" };
        else if (f.streak >= 4) badge = { t: "x" + f.streak, col: "#ff7a6b" };
        else if (f.loot) badge = { t: "+" + fmtNum(f.loot), col: color.teal };
        return { text, badge };
    }

    // The kill feed no longer has its own column on the right: the lines
    // that matter go through the lane under the clock (laneMessage), once
    // each. Yours (you killed, you died, your crown) first; other people's
    // big moments (a shutdown, a streak, a boss, a bounty) only when the
    // lane is quiet; everyday kills between other tanks stay on the big map's feed.
    const feedSeen = new Map();
    function feedNotable(f) {
        return !!(f.shutdown || f.streak >= 4 || f.bounty || f.hunt || f.cloot || (f.core && f.broke) || (f.boss && f.slain) || f.chest || crowns.feedLine(f, (n) => n || "", (n) => n));
    }
    function drawRoyaleFeed(yTop) {
        const feed = global.royale.feed || [];
        const now = Date.now(), myName = global.playerName || "";
        for (let i = Math.max(0, feed.length - 4); i < feed.length; i++) {
            const f = feed[i];
            if (!f) continue;
            const key = (f.at || 0) + "|" + (f.name || "") + "|" + (f.by || "") + "|" + (f.verb || "");
            if (feedSeen.has(key)) continue;
            feedSeen.set(key, now);
            if (feedSeen.size > 60) feedSeen.delete(feedSeen.keys().next().value);
            // arrivals (a boss, the Core, a supply drop, a bloom) are the toast's news
            if (f.event || f.bloom || (f.spawn && (f.boss || f.core))) continue;
            // the first raid: only lines with your name in them
            if (!newcomer.feedAllowed(f, myName)) continue;
            // old news (the first broadcast after joining carries the last few)
            if (now - (f.at || now) > 6000) continue;
            const mine = !!myName && (f.name === myName || f.by === myName);
            if (!mine && !feedNotable(f)) continue;
            let line = null;
            try { line = feedLine(f); } catch (e) { line = null; }
            if (!line || !line.text) continue;
            let text = String(line.text).replace(/§reset§$/, "");
            if (line.badge) text += "§reset§   §" + line.badge.col + "§" + line.badge.t;
            global.messages.push({ text, time: now, duration: mine ? 4200 : 3000, rich: true, lo: !mine, faded: 0 });
        }
        royaleFeedBottom = yTop;
        hudDrawn.feed = null;
    }

    // ── raid chat panel ────────────────────────────────────────────────
    // Under the standings, like florr / diep: the last few lines of the raid
    // (socketinit 'CH' + duo 'TC', model in chatPanelLogic.js), newest at the
    // bottom, "Name: message" with the name in the sender's body colour.
    // Lines fade after a while; Enter opens the input in the bottom row (a
    // DOM input, canvas.js spawnChatInput) and the recent history comes back.
    // Touch: under the minimap, and while typing it moves under the button
    // row so the keyboard never covers it.
    const chatVis = [], chatLays = [];
    const CHAT_FS = 12.5, CHAT_LH = 16, CHAT_PAD_X = 10, CHAT_PAD_Y = 7;
    function chatNameHex(line) {
        if (line._hex) return line._hex;
        let raw = null;
        if (line.color) {
            try { raw = gameDraw.modifyColor(line.color); } catch (e) { raw = null; }
            if (!(typeof raw === "string" && raw[0] === "#")) { try { raw = gameDraw.getColor(line.color); } catch (e) { raw = null; } }
        }
        // duo team lines carry no colour: you two share the team colour
        if (!(typeof raw === "string" && raw[0] === "#") && (line.mine || line.team)) raw = playerHexCol();
        const hex = chatPanel.readableColor(raw, "");
        if (hex) line._hex = hex;
        return hex || HUD.text2;
    }
    // a line's wrapped layout, kept until the width or size changes
    function chatLineLayout(line, textW, fs) {
        const key = textW + "|" + fs + "|" + config.graphical.fontSizeBoost;
        if (line._lay && line._layKey === key) return line._lay;
        const tag = line.team ? "[Team]" : "";
        const name = chatPanel.shortName(line.name) + ":";
        const tagW = tag ? hudTitleW(tag, fs) + 5 : 0;
        const nameW = hudTitleW(name, fs) + 5;
        const lines = chatPanel.wrapMessage(line.text, tagW + nameW, textW, s => hudTitleW(s, fs));
        line._lay = { tag, name, tagW, nameW, lines };
        line._layKey = key;
        return line._lay;
    }
    // the idle row's keycap + words (drawn in drawChatPanel)
    let chatOpenedEver = (() => { try { return localStorage.getItem("dwChatOpened_v1") === "1"; } catch (e) { return true; } })();
    function chatHintW() { return Math.max(15, hudTitleW("Enter", 15 * 0.62) + 15 * 0.55) + 6 + hudTextW("to chat", 10.5) + 8; }
    function chatModePillW(label, fs) { return hudTitleW(label, fs - 1.5) + 14; }
    function chatInputHide() {
        global.chatPanelRow = null;
        const inp = global.canvas && global.canvas.chatInput;
        if (inp && inp.style.display !== "none" && !global.showChat) inp.style.display = "none";
        const pill = global.canvas && global.canvas.chatModeHit;
        if (pill && pill.style.display !== "none") pill.style.display = "none";
    }
    // touch has no Tab: a tap on the Team / All pill flips it (a DOM hit area
    // over the drawn pill, so the box keeps its focus and the keyboard)
    function chatModeHit() {
        const cv = global.canvas;
        if (!cv.chatModeHit || !cv.chatModeHit.isConnected) {
            const el = document.createElement("div");
            el.id = "chatModeHit";
            el.style.cssText = "position:absolute;z-index:12;display:none;cursor:pointer;background:transparent;";
            const flip = (e) => {
                e.preventDefault(); e.stopPropagation();
                if (!global.died) { global.duoChatAll = !global.duoChatAll; gameSound.uiClick(); }
            };
            el.addEventListener("mousedown", flip);
            el.addEventListener("touchstart", flip, { passive: false });
            document.getElementById("gameAreaWrapper").appendChild(el);
            cv.chatModeHit = el;
        }
        return cv.chatModeHit;
    }
    function drawChatPanel() {
        chatPanelRect = null;
        const cv = global.canvas;
        const open = !!(global.showChat && cv && cv.chatInput);
        const duo = !!(global.royale && global.royale.duos);
        // dead in solo: nobody to talk to until you drop again
        if (open && global.died && !duo) { try { cv.chatListener("chatInput", { keyCode: global.KEY_ESC, preventDefault() { } }); } catch (e) { /* */ } }
        if (raidFinale.hidesHud() || global.showBigMap) { chatInputHide(); return; }
        const sw = global.screenWidth, sh = global.screenHeight, mob = !!global.mobile;
        const now = performance.now();
        const fs = mob ? 12 : CHAT_FS, lh = mob ? 15.5 : CHAT_LH;
        const max = mob ? (open ? 3 : chatPanel.CHAT_SHOW_TOUCH) : chatPanel.CHAT_SHOW;
        let vis = chatPanel.visibleLines(chatPanel.chatLog, now, open, max, chatVis);
        // Settings > Chat messages off: only your own lines
        if (global.GUIStatus.renderChat === false) vis = vis.filter(v => v.line.mine);
        const uiPerCss = sw / Math.max(1, window.innerWidth);
        // where the panel goes
        let x, y, W, floor;
        if (mob) {
            const mm = touchMinimapRect();
            const TL = touch.L;
            if (open) {
                // typing: under the button row on the left, above any keyboard
                const sa = TL ? TL.safe : { l: 0, t: 0 };
                x = Math.max(8, (sa.l || 0) + 8) * uiPerCss;
                y = (Math.max(8, sa.t || 0) + 58) * uiPerCss;
                // ...and left of the raid clock's note stack
                W = Math.max(200, Math.min(420, mm.x - 12 - x, sw / 2 - noteMaxW() / 2 - 8 - x));
                floor = sh * 0.6;
            } else {
                // right of your tank, under the raid clock stack and the
                // minimap, left of the HP bars and the kit column, over the
                // ability buttons: clear of every thumb control
                let right = mm.x + mm.w;
                const kitL = (id) => { const b = TL && TL[id]; return b && touch.buttonShown(id) ? (b.x - (b.w || b.r * 2) / 2) * uiPerCss : 1e9; };
                right = Math.min(right, kitL("kit0") - 10, kitL("kit1") - 10, kitL("kit2") - 10);
                if (vitalsRect) right = Math.min(right, vitalsRect.x - 6);
                W = Math.max(160, Math.min(280, right - sw / 2 - 60));
                x = right - W;
                y = Math.max(mm.y + mm.h + 6, hudTopBottom + 4);
                floor = sh * 0.62;
                if (TL) for (const id of ["ability", "dash", "arm", "kit0", "kit1", "kit2"]) {
                    const b = TL[id];
                    if (!b || !touch.buttonShown(id)) continue;
                    const hw = (b.w || b.r * 2) / 2, hh = (b.h || b.r * 2) / 2;
                    const bl = (b.x - hw) * uiPerCss, br = (b.x + hw) * uiPerCss, bt = (b.y - hh) * uiPerCss;
                    if (bl < x + W && br > x && bt > y) floor = Math.min(floor, bt - 8);
                }
            }
        } else {
            W = Math.min(262, sw * 0.3);
            x = sw - HUD.edge - W;
            y = royaleActive() && standingsRect ? standingsRect.y + standingsRect.h + 2 : HUD.edge;
            const mh = global.minimapHintRect;
            floor = (mh ? Math.min(mh.y, sh - 262) : sh - 262) - 12;
        }
        chatPanelLay = { x, y, W, floor };
        const textW = W - CHAT_PAD_X * 2;
        // the bottom row: the input while typing; on desktop a quiet "Enter to chat" otherwise
        // (Oct 8: the hint is for the first raids, until you've opened chat once)
        if (open && !chatOpenedEver) { chatOpenedEver = true; try { localStorage.setItem("dwChatOpened_v1", "1"); } catch (e) { /* */ } }
        const showHint = !open && !mob && !global.died && royaleActive() && !chatOpenedEver && (global.nxStage == null ? 3 : global.nxStage | 0) < 3;
        // touch: the input's text is 16 CSS px at least (iOS zooms into smaller)
        const inFs = mob ? Math.max(fs, 16 * uiPerCss) : fs;
        const rowH = open ? Math.round(Math.max(22, inFs * 1.65)) : showHint ? 18 : 0;
        // lay the lines out, dropping the oldest until the panel fits
        let rows = 0;
        const lays = chatLays;
        lays.length = 0;
        for (const v of vis) { const L = chatLineLayout(v.line, textW, fs); lays.push(L); rows += L.lines.length; }
        const heightFor = (n) => CHAT_PAD_Y * 2 + n * lh + (rowH ? (n ? 6 : 0) + rowH : 0);
        let first = 0;
        while (first < vis.length && y + heightFor(rows) > floor) { rows -= lays[first].lines.length; first++; }
        if (!rows && !rowH) { chatInputHide(); return; }
        // nothing said lately: just the "Enter to chat" chip, at the right edge
        if (!rows && showHint) { const cw = Math.round(chatHintW() + CHAT_PAD_X * 2 + 4); x += W - cw; W = cw; }
        const H = heightFor(rows);
        // closed, the panel is as faded as its newest line; the hint alone is quieter
        let A = open ? 1 : 0;
        for (let i = first; i < vis.length; i++) A = Math.max(A, vis[i].a);
        if (!rows && showHint) A = 0.55;
        // dead: only where the death card isn't
        const dc = global.deathCardFrac;
        if (global.died && !open && deathCardUp() && dc && x < (dc.x + dc.w) * sw && x + W > dc.x * sw && y < (dc.y + dc.h) * sh && y + H > dc.y * sh) { chatInputHide(); return; }
        const c = ctx[2];
        chatPanelRect = { x: x - 6, y: y - 6, w: W + 12, h: H + 12 };
        hudPanel(c, x, y, W, H, { alpha: A, fill: open ? "rgba(0,0,0,0.45)" : "rgba(0,0,0,0.3)", r: 4 });
        // the lines, oldest first
        let ly = y + CHAT_PAD_Y + lh / 2;
        const teamHex = playerHexCol() || HUD.sky;
        for (let i = first; i < vis.length; i++) {
            const v = vis[i], L = lays[i];
            // a new line comes in quickly instead of popping
            const a = v.a * Math.min(1, (now - v.line.at) / 160 + 0.25);
            let lx = x + CHAT_PAD_X;
            if (L.tag) { hudTitle(L.tag, lx, ly, fs, teamHex, "left", a); lx += L.tagW; }
            hudTitle(L.name, lx, ly, fs, chatNameHex(v.line), "left", a);
            lx += L.nameW;
            for (let k = 0; k < L.lines.length; k++) {
                if (L.lines[k]) hudTitle(L.lines[k], k ? x + CHAT_PAD_X : lx, ly, fs, HUD.text, "left", a);
                ly += lh;
            }
        }
        const inp = cv && cv.chatInput;
        if (!rowH) { chatInputHide(); return; }
        const rx = x + CHAT_PAD_X - 4, rw = W - CHAT_PAD_X * 2 + 8, ry = y + H - CHAT_PAD_Y - rowH;
        global.chatPanelRow = { x: rx, y: ry, w: rw, h: rowH };
        if (!open) {
            // "Enter to chat", quiet; a click on it opens the box (canvas.js)
            const kh = 15, kw = hudKey(c, rx + 4, ry + (rowH - kh) / 2, "Enter", kh, A);
            drawText("to chat", rx + 4 + kw + 6, ry + rowH / 2, 10.5, HUD.text2, "left", true, A);
            if (inp && inp.style.display !== "none") inp.style.display = "none";
            const pill = cv && cv.chatModeHit;
            if (pill && pill.style.display !== "none") pill.style.display = "none";
            return;
        }
        // the input row: a recessed well, the Team / All pill in duos, the DOM input over the rest
        hudWell(c, rx, ry, rw, rowH, HUD.rSmall, HUD.wellSolid, HUD.line, 1.5);
        let pillW = 0;
        const team = duo && (global.died || !global.duoChatAll);
        const hit = duo ? chatModeHit() : (cv.chatModeHit || null);
        const cssPerUi = 1 / uiPerCss;
        if (duo) {
            const label = team ? "Team" : "All";
            const ph = rowH - 8, pw = chatModePillW(label, fs);
            const px = rx + 4, py = ry + 4;
            hudWell(c, px, py, pw, ph, ph / 2, team ? teamHex : HUD.face, HUD.line, 1.5);
            hudTitle(label, px + pw / 2, py + ph / 2, fs - 1.5, "#ffffff", "center");
            pillW = pw + 4;
            const st = hit.style;
            st.display = "block";
            st.left = px * cssPerUi + "px"; st.top = py * cssPerUi + "px";
            st.width = pw * cssPerUi + "px"; st.height = ph * cssPerUi + "px";
            st.cursor = global.died ? "default" : "pointer";
        } else if (hit && hit.style.display !== "none") hit.style.display = "none";
        if (inp) {
            const st = inp.style;
            if (st.display !== "block") st.display = "block";
            const left = rx + 4 + pillW, w = rw - 8 - pillW;
            st.left = left * cssPerUi + "px";
            st.top = ry * cssPerUi + "px";
            st.width = Math.max(40, w * cssPerUi) + "px";
            st.height = rowH * cssPerUi + "px";
            st.padding = "0 " + Math.round(4 * cssPerUi) + "px";
            st.fontSize = (mob ? Math.max(16, inFs * cssPerUi) : inFs * cssPerUi).toFixed(1) + "px";
            st.lineHeight = rowH * cssPerUi + "px";
            const ph = global.died ? "Only your teammate can hear you"
                : duo ? (mob ? (team ? "To your teammate" : "To everyone") : team ? "To your teammate, Tab for everyone" : "To everyone, Tab for your teammate")
                : aoNow() ? "Say something to everyone" : "Say something to the raid";
            if (inp.placeholder !== ph) inp.placeholder = ph;
        }
    }
    window.dwChatPanel = () => ({ rect: chatPanelRect, row: global.chatPanelRow, err: chatPanelErr, lay: chatPanelLay, lines: chatPanel.chatLog.list.slice(-8).map(l => ({ name: l.name, text: l.text, team: l.team, hex: l._hex || "" })) });

    // ── contract tracker ───────────────────────────────────────────────
    let questRect = null, overrideRect = null;
    // ── left cards: the contract card with the override card right under it,
    // in the gap between the class-upgrade tiles and the kit box. When the
    // gap is too short the override drops its description; when even that
    // won't fit (a tall upgrade grid) both cards move beside the tiles.
    let leftCards = null;
    // same width and left edge as the kit box below, so the column is one
    // straight edge
    const CARD_W = 190, QUEST_H = 68, CARD_GAP = 10;
    // the breather between contracts (st 3) is a small chip
    const WAIT_H = 24, WAIT_W = 138;
    const questH = q => q ? (q.st === 3 ? WAIT_H : QUEST_H) : 0;
    const overrideH = n => n ? 48 + n * 13 : 40;
    // the override reads in full for its first 10 s, then folds to a one-line
    // chip; hover (or a tap) opens it again for a while
    const MOD_MIN_H = 26, MOD_OPEN_MS = 10000;
    const modView = { name: "", at: 0, openUntil: 0 };
    function modFolded(mod) {
        const now = performance.now();
        if (modView.name !== mod.name) { modView.name = mod.name; modView.at = now; }
        if (now - modView.at < MOD_OPEN_MS || now < modView.openUntil) return false;
        const R = overrideRect;
        if (R && !global.mobile && global.canvas) {
            const cr = global.canvas.height / global.screenHeight / global.ratio;
            const mx = global.mouse.x / (cr * global.ratio), my = global.mouse.y / (cr * global.ratio);
            if (mx >= R.x && mx <= R.x + R.w && my >= R.y && my <= R.y + R.h) return false;
        }
        return true;
    }
    function layoutLeftCards() {
        const r = global.royale;
        // the contract (server contracts.js): one short job at a time
        const q = !global.died && r.you && r.you.obj && nxShows("contracts") ? r.you.obj : null;
        const mod = !global.died && r.mod && r.mod.name && nxShows("twist") ? r.mod : null;
        // duos: the teammate card tops the stack (dead or alive)
        const duo = r.duos && r.duo ? r.duo : null;
        if (!q && !mod && !duo) { leftCards = null; return; }
        const modMin = !!mod && modFolded(mod);
        const lines = mod && !modMin ? wrapLines(String(mod.desc || ""), 10, CARD_W - 24).slice(0, 3) : [];
        const duoOff = duo ? DUO_H + ((q || mod) ? CARD_GAP : 0) : 0;
        const stackH = n => duoOff + questH(q) + (mod ? (q ? CARD_GAP : 0) + (modMin ? MOD_MIN_H : overrideH(n)) : 0);
        const floor = leftColumnFloor() - 10;
        const tiles = (global.upgradeBoxBottom | 0) > 0;
        // touch: no room beside the tiles, the cards wait for the pick
        if (tiles && global.mobile) { leftCards = null; return; }
        // touch: under the button row, and a short screen drops the override
        // card (it's on the map too) before anything overlaps
        const touchTop = global.mobile ? (Math.max(8, touch.L ? touch.L.safe.t : 0) + 58) * touchUnits() : 0;
        const top = tiles ? global.upgradeBoxBottom + 12 : Math.max(16, touchTop);
        const pref = Math.max(global.screenHeight * 0.42, 330, top);
        for (const n of [lines.length, 0]) {
            const y = Math.round(Math.min(pref, floor - stackH(n)));
            if (y >= top) { leftCards = { x: HUD.edge, y, q, mod, modMin, lines: lines.slice(0, n), duo, duoOff }; return; }
        }
        if (global.mobile) {
            const noMod = duo ? DUO_H + (q ? CARD_GAP : 0) : 0;
            const y = Math.round(Math.min(pref, floor - noMod - questH(q)));
            leftCards = y >= top ? { x: HUD.edge, y, q, mod: null, modMin: false, lines: [], duo, duoOff: noMod } : duo ? { x: HUD.edge, y: top, q: null, mod: null, modMin: false, lines: [], duo, duoOff: 0 } : null;
            return;
        }
        const x = Math.round((global.upgradeBoxRight | 0) + 16);
        let y = Math.round(global.upgradeBoxTop || 70);
        // keep clear of the raid clock cluster at top centre
        if (x + CARD_W > global.screenWidth / 2 - 250) y = Math.max(y, hudTopBottom + 8);
        // and of the first-raid card under it (coach.js), so they never stack
        const cr = global.coachRect;
        if (cr && x < cr.x + cr.w && x + CARD_W > cr.x && y < cr.y + cr.h) y = Math.max(y, Math.round(cr.y + cr.h + 8));
        // beside the tiles the cards are over the playfield: a folded
        // override stays off (it's on the big map)
        leftCards = { x, y, q, mod: modMin ? null : mod, modMin, lines, duo, duoOff };
    }
    // ── raid override card: this raid's twist and what it does, in the same
    // tile language as the quest card, right under it
    function drawOverrideCard() {
        const L = leftCards;
        const mod = L && L.mod;
        if (!mod || global.hudCalm) { overrideRect = null; return; }
        const W = CARD_W;
        const lines = L.lines;
        const H = L.modMin ? MOD_MIN_H : overrideH(lines.length);
        const x = L.x, y = (L.q ? L.y + questH(L.q) + CARD_GAP : L.y) + (L.duoOff | 0);
        overrideRect = { x: x - 6, y: y - 6, w: W + 12, h: H + 12 };
        const c = ctx[2];
        if (L.modMin) {
            // folded: "Raid rule" and the name on one line (hover opens it)
            hudPanel(c, x, y, W, H, { alpha: 0.9 });
            const lw = hudTextW("Raid rule", 10.5);
            drawText("Raid rule", x + 10, y + H / 2, 10.5, HUD.text2, "left", true, 0.95);
            const name = String(mod.name);
            let ns = 13; while (ns > 9.5 && hudTitleW(name, ns) > W - 28 - lw) ns -= 0.5;
            hudTitle(name, x + 18 + lw, y + H / 2, ns, HUD.copper, "left", 0.95);
            return;
        }
        hudPanel(c, x, y, W, H);
        hudTitle("Override (raid rule)", x + 12, y + 14, 12, HUD.text2, "left");
        const name = String(mod.name);
        let ns = 16; while (ns > 11 && hudTitleW(name, ns) > W - 24) ns -= 0.5;
        hudTitle(name, x + 12, y + 31, ns, HUD.copper, "left");
        let ly = y + 49;
        for (const ln of lines) { drawText(ln, x + 12, ly, 10, HUD.text, "left", true); ly += 13; }
    }
    // One line of text fitted to the card: shrink, then ellipsize (cached).
    const questFit = new Map();
    function fitLine(raw, size, min, maxW) {
        const k = raw + "|" + size + "|" + maxW;
        let fit = questFit.get(k);
        if (fit) return fit;
        let qs = size, txt = raw;
        while (qs > min && measureText(txt, qs) > maxW) qs -= 0.5;
        if (measureText(txt, qs) > maxW) {
            while (txt.length > 2 && measureText(txt + "…", qs) > maxW) txt = txt.slice(0, -1);
            txt += "…";
        }
        fit = { txt, qs };
        if (questFit.size > 48) questFit.clear();
        questFit.set(k, fit);
        return fit;
    }
    // Where the contract points right now: the live entity when it's in view,
    // else the raid packet's position eased between packets.
    const ctgt = { x: 0, y: 0, size: 0 };
    function contractTarget(o) {
        if (!o || o.st !== 0) return null;
        // the safe zone: the nearest point a little inside the live edge
        if (o.k === "zone") {
            const s = stormSnap();
            if (s && s.a && s.r > 0) {
                const px = global.player.renderx, py = global.player.rendery;
                const dx = px - s.cx, dy = py - s.cy, d = Math.hypot(dx, dy) || 1;
                const r = Math.max(0, s.r - 150);
                if (d <= r) { ctgt.x = s.cx; ctgt.y = s.cy; }
                else { ctgt.x = s.cx + dx / d * r; ctgt.y = s.cy + dy / d * r; }
                ctgt.size = 0;
                return ctgt;
            }
        }
        if (o.x == null) return null;
        if (o.e != null) {
            const list = global.entities;
            for (let i = 0; i < list.length; i++) {
                const e = list[i];
                if (e.id !== o.e) continue;
                ctgt.x = e.render && e.render.x != null ? e.render.x : e.x;
                ctgt.y = e.render && e.render.y != null ? e.render.y : e.y;
                ctgt.size = e.size || 30;
                return ctgt;
            }
        }
        const p = trackPos("contract" + o.id, o.x, o.y, 0.6);
        ctgt.x = p.x; ctgt.y = p.y; ctgt.size = 0;
        return ctgt;
    }
    const CONTRACT_LABEL = { chest: "CHEST", bank: "VAULT", mine: "ORE", boss: "BOSS", bounty: "BOUNTY", streaker: "STREAKER", hunt: "TARGET", bloom: "ORE BLOOM", event: "EVENT", zone: "SAFE ZONE", shop: "SHOP" };
    function drawQuestCard() {
        const L = leftCards;
        const o = L && L.q;
        if (!o) { questRect = null; return; }
        const W = CARD_W, H = questH(o);
        const now = performance.now();
        const calm = !!(global.reducedMotion && global.reducedMotion());
        // between contracts: a short row counting down to the next one
        if (o.st === 3) {
            const x = L.x, y = L.y + (L.duoOff | 0), w = WAIT_W;
            questRect = { x: x - 6, y: y - 6, w: w + 12, h: H + 12 };
            const c = ctx[2];
            hudPanel(c, x, y, w, H, { alpha: 0.8 });
            const left = Math.max(0, (o.ms || 0) - (now - (o.at || now)));
            drawText("Next contract", x + 10, y + H / 2, 10.5, HUD.text2, "left", true, 0.95);
            drawText(fmtRaidClock(Math.ceil(left / 1000)), x + w - 10, y + H / 2, 11, HUD.gold, "right", true, 0.95);
            return;
        }
        // a new contract slides in from the left
        const bornAge = now - (global.royale.objBornAt || 0);
        const slide = calm || o.st !== 0 ? 0 : Math.max(0, 1 - bornAge / 260);
        const x = L.x - Math.round(slide * slide * 60), y = L.y + (L.duoOff | 0);
        questRect = { x: L.x - 6, y: y - 6, w: W + 12, h: H + 12 };
        const c = ctx[2];
        const a = 1 - slide;
        const done = o.st === 1, missed = o.st === 2;
        hudPanel(c, x, y, W, H, { alpha: a });
        // done: a green rim that fades out
        if (done) {
            const k = Math.max(0, 1 - (now - (global.royale.objEndAt || now)) / 1400);
            if (k > 0) {
                c.save();
                c.globalAlpha = a * k;
                roundRectPath(c, x - 2, y - 2, W + 4, H + 4, HUD.r + 2);
                c.lineWidth = 3; c.strokeStyle = HUD.emerald; c.stroke();
                c.restore();
            }
        }
        const left = Math.max(0, (o.ms || 0) - (now - (o.at || now)));
        const secs = Math.ceil(left / 1000);
        hudTitle(done ? "Contract done" : missed ? "Missed" : "Contract", x + 12, y + 14, 13, done ? HUD.emerald : missed ? HUD.danger : HUD.gold, "left", a);
        if (!done && !missed) {
            const tt = fmtRaidClock(secs);
            drawText(tt, x + W - 12, y + 14, 11, secs <= 10 ? HUD.danger : HUD.text2, "right", true, a);
            // a small arrow toward the target, beside the clock
            const tg = contractTarget(o);
            if (tg) {
                const dx = tg.x - global.player.renderx, dy = tg.y - global.player.rendery;
                if (dx * dx + dy * dy > 160 * 160) {
                    const ax = x + W - 12 - hudTextW(tt, 11) - 12, ay = y + 14;
                    c.save();
                    c.globalAlpha = a;
                    c.translate(ax, ay);
                    c.rotate(Math.atan2(dy, dx));
                    c.beginPath(); c.moveTo(6, 0); c.lineTo(-4, -5); c.lineTo(-2, 0); c.lineTo(-4, 5); c.closePath();
                    c.fillStyle = HUD.gold; c.strokeStyle = HUD.ink; c.lineWidth = 1.5; c.lineJoin = "round";
                    c.fill(); c.stroke();
                    c.restore();
                }
            }
        }
        // the job itself, on up to two lines
        const lines = wrapLines(String((missed && o.why) || o.t || ""), 11.5, W - 24);
        const txtCol = missed ? HUD.text2 : color.guiwhite;
        if (lines.length > 1) {
            drawText(lines[0], x + 12, y + 30, 11.5, txtCol, "left", true, a);
            const f2 = lines.length > 2 ? fitLine(lines.slice(1).join(" "), 11.5, 11.5, W - 24) : null;
            drawText(f2 ? f2.txt : lines[1], x + 12, y + 43, 11.5, txtCol, "left", true, a);
        } else drawText(lines[0] || "", x + 12, y + 36, 11.5, txtCol, "left", true, a);
        // (a quick repeat of the safe-zone job pays nothing: no reward shown)
        const noRew = !((o.r | 0) > 0);
        const rewTxt = noRew ? "" : "+" + fmtNum(o.r | 0);
        const rewW = noRew ? -18 : hudTextW(rewTxt, 10.5);
        const bx = x + 12, bw = W - 24 - rewW - 18, by = y + 53, bh = 8;
        const frac = done ? 1 : o.g > 0 ? Math.min(1, (o.p || 0) / o.g) : 0;
        c.save();
        c.globalAlpha = a * (missed ? 0.45 : 1);
        hudBar(c, bx, by, bw, bh, frac, done ? HUD.emerald : HUD.gold);
        c.restore();
        // the reward: gems, with a small gem in front
        if (noRew) return;
        const gx = x + W - 12 - rewW - 7;
        c.save();
        c.globalAlpha = a * (missed ? 0.45 : 1);
        c.fillStyle = HUD.emerald; c.strokeStyle = HUD.ink; c.lineWidth = 1.3;
        gemPath(c, gx, by + bh / 2, 4.5); c.fill(); c.stroke();
        c.restore();
        drawText(rewTxt, x + W - 12, by + bh / 2, 10.5, missed ? HUD.text2 : HUD.emerald, "right", true, a);
    }

    // ── duos: the teammate card (top of the left stack) ─────────────────
    // Your partner's name in your shared colour, their health, and what
    // they're up to; alone, it says so (and whether someone may join).
    const DUO_H = 58;
    let duoRect = null;
    const duoFit = new Map();
    function fitTitle(text, size, min, room) {
        const k = text + "|" + size + "|" + (room | 0);
        let ns = duoFit.get(k);
        if (ns === undefined) {
            ns = size; while (ns > min && hudTitleW(text, ns) > room) ns -= 0.5;
            if (duoFit.size > 48) duoFit.clear();
            duoFit.set(k, ns);
        }
        return ns;
    }
    function drawDuoCard() {
        const L = leftCards;
        const d = L && L.duo;
        if (!d) { duoRect = null; return; }
        const W = CARD_W, H = DUO_H, x = L.x, y = L.y;
        duoRect = { x: x - 6, y: y - 6, w: W + 12, h: H + 12 };
        const c = ctx[2];
        hudPanel(c, x, y, W, H);
        const col = playerHexCol() || HUD.sky;
        const m = d.mate;
        if (!m) {
            hudTitle("Duo", x + 12, y + 14, 12, HUD.text2, "left");
            const title = d.party ? "Waiting for your mate" : "Playing without a teammate";
            hudTitle(title, x + 12, y + 31, fitTitle(title, 14, 10, W - 24), HUD.head, "left");
            drawText(d.party ? "They drop in next to you" : d.fill ? "Someone may join you" : "Fill is off", x + 12, y + 47, 10, HUD.text2, "left", true);
            return;
        }
        // a diamond in the team colour, then the name
        c.save();
        c.translate(x + 17, y + 15);
        c.rotate(Math.PI / 4);
        c.fillStyle = col; c.strokeStyle = HUD.ink; c.lineWidth = 2;
        c.fillRect(-4.5, -4.5, 9, 9); c.strokeRect(-4.5, -4.5, 9, 9);
        c.restore();
        let name = shortName(m.name || "Teammate", 16);
        let status, stCol = HUD.text2;
        if (m.away) status = "Dropped out";
        else if (!m.alive) { status = m.back > 0 ? "Back in " + m.back + "s" : "Down"; stCol = HUD.danger; }
        else if (m.fight) { status = "Fighting"; stCol = HUD.gold; }
        else status = "";
        const stW = status ? hudTextW(status, 10.5) + 8 : 0;
        // every teammate reads as a player: no tag after the name
        const nameRoom = W - 40 - stW;
        const nameSz = fitTitle(name, 15, 10, nameRoom);
        // still too long at the smallest size: trim it so the tag and status fit
        for (let n = name.length; hudTitleW(name, nameSz) > nameRoom && n > 4; n--) name = String(m.name || "Teammate").slice(0, n - 1) + "…";
        hudTitle(name, x + 28, y + 15, nameSz, col, "left");
        if (status) drawText(status, x + W - 12, y + 15, 10.5, stCol, "right", true);
        const bx = x + 12, bw = W - 24, bh = 10, by = y + 26;
        const hp = m.alive ? Math.max(0, Math.min(1, +m.hp || 0)) : 0;
        hudBar(c, bx, by, bw, bh, hp, hp > 0.5 ? HUD.emerald : hp > 0.25 ? HUD.gold : HUD.danger);
        if (m.alive && m.sh > 0.01) {
            c.save();
            c.globalAlpha = 0.6;
            roundRectPath(c, bx + 2, by + 2, Math.max(3, (bw - 4) * m.sh), bh - 4, (bh - 4) / 2);
            c.fillStyle = color.teal; c.fill();
            c.restore();
        }
        let foot = "";
        if (m.alive && m.x != null) {
            const tp = trackPos("duomate", m.x, m.y, 0.8);
            const dist = Math.hypot(tp.x - global.player.renderx, tp.y - global.player.rendery);
            foot = global.died ? "Still fighting" : dist < 700 ? "Right by you" : fmtDist(dist) + " away";
        } else if (m.away) foot = "Their spot stays open 2 min";
        else foot = m.bot ? "Drops back in beside you" : "Stay alive until they're back";
        drawText(foot, x + 12, y + 47, 10, HUD.text2, "left", true);
        if (m.alive) drawText(Math.round(hp * 100) + "%", x + W - 12, y + 47, 10, HUD.text2, "right", true);
    }

    // ── the top lane ───────────────────────────────────────────────────
    // Oct 8 (owner: "popups covering the screen"): the slams (raidHeat:
    // ELIMINATED, BANKED, YOU'RE HUNTED, the Core) and the plates (kill
    // callouts, event callouts) share ONE compact lane right under everything
    // at the top (the clock stack, the DOM notification cards, the first-raid
    // guide). The middle of the screen stays clear. One thing at a time: a
    // plate waits (its clock held) while a slam is up or queued.
    const lanes = { slamY: 0, plateY: 0, tight: true, slamK: 1, top: 0 };
    function hudLanes() {
        const H = global.screenHeight;
        if (!global.tutorialMode) eventHudTick();
        let top = Math.max(hudTopBottom || HUD.edge, evHud.toastFloor || 0);
        const cr = global.coachRect;
        if (cr && cr.y < H * 0.4) top = Math.max(top, cr.y + cr.h);
        // upright phones: the HP / shield bars sit under the clock panel
        if (global.mobile && vitalsRect && vitalsRect.y < H * 0.4 && global.screenHeight > global.screenWidth) top = Math.max(top, vitalsRect.y + vitalsRect.h);
        lanes.top = top;
        // a slam needs SLAM_RISE above its line and SLAM_DROP below; on a
        // short screen (a phone with the boss bar up) it shrinks to fit above the tank
        const room = H * 0.42 - top;
        lanes.slamK = Math.max(0.7, Math.min(1, room / (8 + raidHeat.SLAM_RISE + raidHeat.SLAM_DROP)));
        lanes.slamY = Math.round(top + 8 + raidHeat.SLAM_RISE * lanes.slamK);
        lanes.plateY = lanes.slamY;
        lanes.tight = true;
        return lanes;
    }
    // a plate holds its place in the queue while the lanes overlap
    let plateWaitAt = 0;
    function platesWait(now) {
        // the death card: plates wait for it to go, the newest two kept)
        const card = deathCardUp();
        if (card && global.callouts && global.callouts.length > 2) global.callouts.splice(0, global.callouts.length - 2);
        const wait = lanes.tight && raidHeat.slamUp() || (global.mobile && now - (global.kitCardAt || 0) < 150) || global.introCardUp || global.introWait || card;
        const dt = wait && plateWaitAt ? now - plateWaitAt : 0;
        plateWaitAt = wait ? now : 0;
        return dt;
    }
    function drawKillCallouts() {
        const list = global.callouts;
        if (!list || !list.length) return;
        if (!shopUiMode()) { list.length = 0; return; }
        const now = performance.now();
        const held = platesWait(now);
        if (held > 0 || plateWaitAt) { for (const t of list) t.born += held; return; }
        const DUR0 = 2300;
        const c = ctx[2];
        const cx = global.screenWidth / 2, cy = lanes.plateY || Math.round(global.screenHeight * 0.37);
        for (let k = list.length - 1; k >= 0; k--) {
            const t = list[k];
            const DUR = t.dur || DUR0;
            const age = now - t.born;
            if (age > DUR || !newcomer.calloutAllowed(t.kind)) { list.splice(k, 1); continue; }
            if (age < 0) continue;
            const inT = Math.min(1, age / 160);
            const outT = age > DUR - 500 ? 1 - (age - (DUR - 500)) / 500 : 1;
            const a = (inT * inT * (3 - 2 * inT)) * Math.max(0, outT);
            const pop = inT < 1 ? 1.2 - 0.2 * inT : 1;
            const col = raidHeat.calloutCol(t.kind) || (t.kind === "override" || t.kind === "late" ? HUD.copper : t.kind === "shutdown" ? "#ff9a5a" : t.kind === "boss" ? "#c9a8ff"
                : t.kind === "chest" || t.kind === "dropin" || t.kind === "bounty" || t.kind === "restored" ? color.gold : t.kind === "quest" ? color.teal : t.kind === "streak" ? "#ff7a6b"
                : t.kind === "tier5" || t.kind === "level" ? HUD.gold
                : t.kind === "grown" || t.kind === "contract" ? HUD.emerald : t.kind === "revenge" ? "#ff6b5e" : color.guiwhite);
            // Oct 8: a compact plate in the top lane (it was a 23-unit title over the play area)
            const base = t.kind === "streak" ? 14 : 17, size = base * pop;
            // the points ride on the sub line: one plate, two lines at most
            const subTxt = t.pts ? "+" + fmtNum(t.pts) + " pts" + (t.sub ? "  ·  " + t.sub : "") : t.sub || "";
            const len = (Math.max(hudTitleW(t.text, base), subTxt ? hudTextW(subTxt, 11) : 0) + 32) * pop;
            const ph = size * 1.6 + (subTxt ? 16 * pop : 0);
            hudPanel(c, cx - len / 2, cy - size * 0.8, len, ph, { alpha: a, fill: "rgba(0,0,0,0.43)", r: HUD.r * pop });
            // coach.js: this plate sits where its card goes on desktop
            global.hudCalloutUp = true;
            global.hudCalloutAt = performance.now();   // raidPerks: the cards wait for it
            hudTitle(t.text, cx, cy, size, col, "center", a);
            if (subTxt) drawText(subTxt, cx, cy + size * 0.8 + 6, 11, t.pts ? HUD.gold : t.kind === "contract" || t.kind === "bounty" ? HUD.emerald : "#d8dce6", "center", true, a, 4);
            break;
        }
    }

    // ── kit box: sits above the skill bars, styled like them ───────────
    // Tooltips: anything hoverable queues one; drawTooltips paints the last
    // one after every panel so it sits on top.
    let pendingTip = null;
    function queueTip(title, body, ax, ay, above = true) { pendingTip = { title, body, ax, ay, above }; }
    let tipKey = "", tipAt = 0;
    window.dwTip = () => tipKey;
    function drawTooltips() {
        const tip = pendingTip;
        pendingTip = null;
        if (!tip) { tipKey = ""; return; }
        const now = performance.now();
        const key = tip.title + "|" + tip.body;
        if (key !== tipKey) { tipKey = key; tipAt = now; }
        const inT = Math.min(1, (now - tipAt) / 140);
        const ease = inT * inT * (3 - 2 * inT);
        const c = ctx[2];
        const maxW = 230;
        const lines = wrapLines(tip.body || "", 10.5, maxW - 20);
        const w = Math.max(hudTitleW(tip.title, 13) + 24, ...lines.map(l => hudTextW(l, 10.5) + 24), 90);
        const h = 26 + lines.length * 14 + (lines.length ? 6 : 0);
        let x = Math.max(6, Math.min(global.screenWidth - w - 6, tip.ax - w / 2));
        let y = tip.above ? tip.ay - h - 8 : tip.ay + 8;
        if (y < 6) y = tip.ay + 8;
        y += (tip.above ? 1 : -1) * 6 * (1 - ease);
        hudPanel(c, x, y, w, h, { alpha: ease, fill: HUD.solid, r: HUD.rSmall + 1, lw: 2.5, lip: 2.5 });
        hudTitle(tip.title, x + 12, y + 14, 13, HUD.head, "left", ease);
        let ly = y + 32;
        for (const l of lines) { drawText(l, x + 12, ly, 10.5, HUD.text, "left", true, ease); ly += 14; }
    }
    const ROMAN = ["", "I", "II", "III", "IV", "V"];
    // Kit item art. Each icon is a chunky tile like the upgrade tiles (a face
    // over a darker lip) with a flat object on it, outlined in the tile's own
    // dark shade the way tanks and gems are.
    const KIT_CARD = {
        medkit: "#3fbf7a", charge: "#e07c2f", strut: "#8a93a6", overdrive: "#f0a030",
        anchor: "#4d8be0", flash: "#38b8b0", bulwark: "#7a8494", decoy: "#d4a83a",
        barrage: "#b0413e", rocket: "#e8642c", flare: "#d84a7a",
        // abilities (abilityFx.js AB_COLOR, a shade deeper for the tile)
        grapple: "#3a9fc4", burrow: "#b8722c", shock: "#7a66e0", radar: "#2fae64",
        wall: "#7a8494", smoke: "#6c6680", rush: "#d8433a", pad: "#d49a26",
    };
    const KIT_LIGHT = "#fff8ec", KIT_SPARK = "#ffd640", KIT_ROCK = "#6f6480", KIT_WOOD = "#d99a5c";
    const kitDark = col => gameDraw.mixColors(col, HUD.ink, 0.62);
    const circlePath = (c, x, y, r) => { c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); };
    const pointsPath = (c, pts, u, dx = 0, dy = 0, k = 1) => {
        c.beginPath();
        pts.forEach((p, i) => i ? c.lineTo(dx + p[0] * u * k, dy + p[1] * u * k) : c.moveTo(dx + p[0] * u * k, dy + p[1] * u * k));
        c.closePath();
    };
    function starPath(c, x, y, r, ri, n = 4, rot = -Math.PI / 2) {
        c.beginPath();
        for (let i = 0; i < n * 2; i++) {
            const a = rot + i * Math.PI / n, rr = i & 1 ? ri : r;
            i ? c.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr) : c.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
        }
        c.closePath();
    }
    const BOLT = [[0.2, -1], [-0.55, 0.12], [-0.02, 0.12], [-0.22, 1], [0.55, -0.16], [0.04, -0.16]];
    const ROCK_CHUNK = [[-1, -0.3], [-0.4, -1], [0.5, -0.8], [1, 0], [0.6, 0.8], [-0.3, 1], [-0.9, 0.5]];
    // Each glyph is a list of parts: { p: path, fill } for a solid shape,
    // { p, line, col } for a thick stroke, and { detail } for marks painted on
    // top without an outline. u is half the glyph box.
    const KIT_GLYPHS = {
        medkit: u => [
            { p: c => pointsPath(c, [[-0.25, -0.68], [0.25, -0.68], [0.25, -0.25], [0.68, -0.25], [0.68, 0.25], [0.25, 0.25],
                [0.25, 0.68], [-0.25, 0.68], [-0.25, 0.25], [-0.68, 0.25], [-0.68, -0.25], [-0.25, -0.25]], u), fill: KIT_LIGHT },
        ],
        charge: u => [
            { p: c => { c.beginPath(); c.moveTo(u * 0.24, -u * 0.34); c.quadraticCurveTo(u * 0.3, -u * 0.66, u * 0.56, -u * 0.58); }, line: u * 0.11, col: "#e9d8b4" },
            { p: c => pointsPath(c, [[0.08, -0.46], [0.36, -0.2], [0.18, -0.02], [-0.1, -0.28]], u), fill: "#8a8096" },
            { p: c => circlePath(c, -u * 0.12, u * 0.16, u * 0.5), fill: "#3d3547" },
            { p: c => starPath(c, u * 0.58, -u * 0.58, u * 0.27, u * 0.1), fill: KIT_SPARK },
            { detail: true, p: c => circlePath(c, -u * 0.32, -u * 0.04, u * 0.11), fill: "rgba(255,255,255,0.4)" },
        ],
        strut: u => [
            // a timber mine prop holding a tunnel open
            { p: c => pointsPath(c, [[-0.3, -0.4], [0.3, -0.4], [0.3, 0.66], [-0.3, 0.66]], u), fill: "#2a2330" },
            { p: c => pointsPath(c, [[-0.5, -0.38], [-0.26, -0.38], [-0.26, 0.66], [-0.5, 0.66]], u), fill: KIT_WOOD },
            { p: c => pointsPath(c, [[0.26, -0.38], [0.5, -0.38], [0.5, 0.66], [0.26, 0.66]], u), fill: KIT_WOOD },
            { p: c => pointsPath(c, [[-0.7, -0.66], [0.7, -0.66], [0.7, -0.38], [-0.7, -0.38]], u), fill: KIT_WOOD },
            { detail: u * 0.07, col: "#a8672f", p: c => {
                c.beginPath();
                c.moveTo(-u * 0.5, -u * 0.52); c.lineTo(u * 0.1, -u * 0.52);
                c.moveTo(-u * 0.38, -u * 0.18); c.lineTo(-u * 0.38, u * 0.3);
                c.moveTo(u * 0.38, u * 0.02); c.lineTo(u * 0.38, u * 0.48);
            } },
        ],
        overdrive: u => [
            { p: c => polyPath(c, 0, 0, u * 0.66, 6, Math.PI / 6), fill: "#3d3547" },
            { p: c => pointsPath(c, BOLT, u, u * 0.02, 0, 0.5), fill: KIT_SPARK },
        ],
        anchor: u => [
            { p: c => circlePath(c, 0, -u * 0.52, u * 0.14), line: u * 0.13, col: KIT_LIGHT },
            { p: c => { c.beginPath(); c.moveTo(0, -u * 0.38); c.lineTo(0, u * 0.6); }, line: u * 0.17, col: KIT_LIGHT },
            { p: c => { c.beginPath(); c.moveTo(-u * 0.32, -u * 0.18); c.lineTo(u * 0.32, -u * 0.18); }, line: u * 0.15, col: KIT_LIGHT },
            { p: c => { c.beginPath(); c.arc(0, u * 0.08, u * 0.52, Math.PI * 0.12, Math.PI * 0.88); }, line: u * 0.15, col: KIT_LIGHT },
            { p: c => pointsPath(c, [[-0.66, 0.1], [-0.36, 0.3], [-0.6, 0.44]], u), fill: KIT_LIGHT },
            { p: c => pointsPath(c, [[0.66, 0.1], [0.36, 0.3], [0.6, 0.44]], u), fill: KIT_LIGHT },
        ],
        flash: u => [
            { p: c => gemPath(c, -u * 0.08, -u * 0.06, u * 0.62), fill: "#c8f7f1" },
            { detail: u * 0.06, col: "rgba(20,70,68,0.45)", p: c => {
                const x = -u * 0.08, y = -u * 0.06, r = u * 0.62;
                c.beginPath();
                c.moveTo(x - r, y - r * 0.38); c.lineTo(x + r, y - r * 0.38);
                c.moveTo(x - r * 0.3, y - r * 0.95); c.lineTo(x - r * 0.42, y - r * 0.38); c.lineTo(x, y + r * 0.95);
                c.moveTo(x + r * 0.3, y - r * 0.95); c.lineTo(x + r * 0.42, y - r * 0.38); c.lineTo(x, y + r * 0.95);
            } },
            { p: c => pointsPath(c, BOLT, u, u * 0.42, u * 0.36, 0.36), fill: KIT_SPARK },
        ],
        bulwark: u => {
            // three courses of brick with the joints staggered
            const rows = [[[-0.68, -0.02], [0.08, 0.68]], [[-0.68, -0.38], [-0.26, 0.34], [0.46, 0.68]], [[-0.68, -0.02], [0.08, 0.68]]];
            const parts = [];
            rows.forEach((row, r) => {
                const y0 = -0.62 + r * 0.43, y1 = y0 + 0.33;
                for (const [x0, x1] of row) parts.push({ p: c => pointsPath(c, [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], u), fill: "#e4dcee" });
            });
            return parts;
        },
        decoy: u => [
            { p: c => {
                c.beginPath();
                c.moveTo(-u * 0.14, -u * 0.34);
                c.bezierCurveTo(-u * 0.72, -u * 0.1, -u * 0.7, u * 0.66, 0, u * 0.66);
                c.bezierCurveTo(u * 0.7, u * 0.66, u * 0.72, -u * 0.1, u * 0.14, -u * 0.34);
                c.closePath();
            }, fill: KIT_LIGHT },
            { p: c => pointsPath(c, [[-0.26, -0.66], [0, -0.44], [0.26, -0.66], [0.2, -0.36], [-0.2, -0.36]], u), fill: KIT_LIGHT },
            { p: c => roundRectPath(c, -u * 0.24, -u * 0.44, u * 0.48, u * 0.14, u * 0.06), fill: "#a8672f" },
            { detail: u * 0.13, col: "#8a6414", p: c => {
                c.beginPath();
                c.arc(0, u * 0.04, u * 0.15, Math.PI * 1.05, Math.PI * 2.3);
                c.lineTo(0, u * 0.3);
            } },
            { detail: true, fill: "#8a6414", p: c => circlePath(c, 0, u * 0.48, u * 0.075) },
        ],
        barrage: u => [
            { p: c => { c.beginPath(); c.moveTo(-u * 0.7, u * 0.06); c.lineTo(-u * 0.42, -u * 0.12); c.moveTo(-u * 0.66, u * 0.6); c.lineTo(-u * 0.36, u * 0.4); c.moveTo(-u * 0.2, -u * 0.56); c.lineTo(u * 0.02, -u * 0.66); }, line: u * 0.1, col: KIT_LIGHT },
            { p: c => pointsPath(c, ROCK_CHUNK, u, u * 0.34, -u * 0.3, 0.32), fill: KIT_ROCK },
            { p: c => pointsPath(c, ROCK_CHUNK, u, -u * 0.18, u * 0.1, 0.28), fill: KIT_ROCK },
            { p: c => pointsPath(c, ROCK_CHUNK, u, u * 0.3, u * 0.44, 0.22), fill: KIT_ROCK },
            { detail: true, fill: "#8d82a0", p: c => {
                pointsPath(c, [[-0.4, -1], [0.5, -0.8], [0.1, -0.2]], u, u * 0.34, -u * 0.3, 0.32);
            } },
        ],
    };
    // abilities and the mobility kit
    Object.assign(KIT_GLYPHS, {
        grapple: u => [
            // a rope running to a three-pronged hook
            { p: c => { c.beginPath(); c.moveTo(-u * 0.62, u * 0.62); c.quadraticCurveTo(-u * 0.5, -u * 0.05, u * 0.12, -u * 0.12); }, line: u * 0.12, col: "#e9d8b4" },
            { p: c => { c.beginPath(); c.moveTo(u * 0.1, -u * 0.12); c.lineTo(u * 0.5, -u * 0.52); }, line: u * 0.17, col: KIT_LIGHT },
            { p: c => { c.beginPath(); c.arc(u * 0.32, -u * 0.34, u * 0.36, Math.PI * 0.05, Math.PI * 0.6); }, line: u * 0.13, col: KIT_LIGHT },
            { p: c => { c.beginPath(); c.arc(u * 0.32, -u * 0.34, u * 0.36, Math.PI * 1.4, Math.PI * 1.95); }, line: u * 0.13, col: KIT_LIGHT },
            { p: c => pointsPath(c, [[0.5, -0.7], [0.72, -0.72], [0.7, -0.5]], u), fill: KIT_LIGHT },
        ],
        burrow: u => [
            // a drill bit, point first, with its spiral flutes
            { p: c => pointsPath(c, [[-0.62, -0.42], [0.72, 0], [-0.62, 0.42]], u), fill: "#e4dcee" },
            { p: c => roundRectPath(c, -u * 0.78, -u * 0.3, u * 0.24, u * 0.6, u * 0.06), fill: "#3d3547" },
            { detail: u * 0.08, col: "#8a7f96", p: c => {
                c.beginPath();
                c.moveTo(-u * 0.36, -u * 0.32); c.lineTo(-u * 0.14, u * 0.25);
                c.moveTo(-u * 0.04, -u * 0.2); c.lineTo(u * 0.14, u * 0.15);
                c.moveTo(u * 0.26, -u * 0.09); c.lineTo(u * 0.4, u * 0.06);
            } },
            { p: c => starPath(c, u * 0.72, -u * 0.36, u * 0.2, u * 0.08), fill: KIT_SPARK },
        ],
        shock: u => [
            { p: c => circlePath(c, 0, 0, u * 0.2), fill: KIT_LIGHT },
            { p: c => { c.beginPath(); c.arc(0, 0, u * 0.44, -0.9, 0.9); }, line: u * 0.12, col: KIT_LIGHT },
            { p: c => { c.beginPath(); c.arc(0, 0, u * 0.44, Math.PI - 0.9, Math.PI + 0.9); }, line: u * 0.12, col: KIT_LIGHT },
            { p: c => { c.beginPath(); c.arc(0, 0, u * 0.68, -0.7, 0.7); }, line: u * 0.11, col: KIT_LIGHT },
            { p: c => { c.beginPath(); c.arc(0, 0, u * 0.68, Math.PI - 0.7, Math.PI + 0.7); }, line: u * 0.11, col: KIT_LIGHT },
        ],
        radar: u => [
            { p: c => circlePath(c, 0, 0, u * 0.66), fill: "#1e3a2a" },
            { p: c => { c.beginPath(); c.moveTo(0, 0); c.arc(0, 0, u * 0.66, -Math.PI / 2, -Math.PI / 2 + 1.1); c.closePath(); }, fill: "#7df0a8" },
            { detail: u * 0.06, col: "rgba(125,240,168,0.6)", p: c => { c.beginPath(); c.arc(0, 0, u * 0.36, 0, Math.PI * 2); } },
            { detail: true, fill: KIT_SPARK, p: c => circlePath(c, -u * 0.28, u * 0.22, u * 0.09) },
            { detail: true, fill: "#ffffff", p: c => circlePath(c, u * 0.3, u * 0.3, u * 0.07) },
        ],
        wall: u => [
            // three rocks rising in a row
            { p: c => pointsPath(c, ROCK_CHUNK, u, -u * 0.44, u * 0.12, 0.3), fill: KIT_ROCK },
            { p: c => pointsPath(c, ROCK_CHUNK, u, 0, -u * 0.1, 0.36), fill: "#8d82a0" },
            { p: c => pointsPath(c, ROCK_CHUNK, u, u * 0.44, u * 0.12, 0.3), fill: KIT_ROCK },
            { p: c => { c.beginPath(); c.moveTo(-u * 0.7, u * 0.6); c.lineTo(u * 0.7, u * 0.6); }, line: u * 0.12, col: KIT_LIGHT },
        ],
        smoke: u => [
            { p: c => circlePath(c, -u * 0.3, u * 0.12, u * 0.32), fill: "#d8d2e4" },
            { p: c => circlePath(c, u * 0.08, -u * 0.14, u * 0.38), fill: "#ece8f4" },
            { p: c => circlePath(c, u * 0.38, u * 0.18, u * 0.28), fill: "#d8d2e4" },
            { p: c => roundRectPath(c, -u * 0.6, u * 0.12, u * 1.24, u * 0.34, u * 0.17), fill: "#d8d2e4" },
        ],
        rush: u => [
            { p: c => pointsPath(c, BOLT, u, -u * 0.08, 0, 0.62), fill: KIT_SPARK },
            { p: c => { c.beginPath(); c.moveTo(u * 0.34, -u * 0.5); c.lineTo(u * 0.62, -u * 0.22); c.lineTo(u * 0.34, u * 0.06); }, line: u * 0.12, col: KIT_LIGHT },
        ],
        pad: u => [
            { p: c => roundRectPath(c, -u * 0.66, u * 0.3, u * 1.32, u * 0.3, u * 0.12), fill: "#3d3547" },
            { p: c => pointsPath(c, [[0, -0.7], [0.5, -0.12], [0.2, -0.12], [0.2, 0.22], [-0.2, 0.22], [-0.2, -0.12], [-0.5, -0.12]], u), fill: KIT_LIGHT },
        ],
        rocket: u => [
            // a boot with a flame out of the heel
            { p: c => pointsPath(c, [[-0.5, 0.5], [-0.5, 0.06], [-0.3, 0.06], [-0.3, -0.6], [0.08, -0.6], [0.08, 0.06], [0.5, 0.2], [0.6, 0.5]], u), fill: KIT_LIGHT },
            { p: c => pointsPath(c, [[-0.5, 0.28], [-0.82, 0.38], [-0.62, 0.48], [-0.86, 0.62], [-0.5, 0.58]], u), fill: KIT_SPARK },
            { detail: u * 0.08, col: "#a8672f", p: c => { c.beginPath(); c.moveTo(-u * 0.3, -u * 0.3); c.lineTo(u * 0.08, -u * 0.3); } },
        ],
        flare: u => [
            { p: c => starPath(c, -u * 0.12, u * 0.08, u * 0.5, u * 0.18, 5), fill: "#ffe6f0" },
            { p: c => pointsPath(c, [[0.18, -0.42], [0.66, -0.66], [0.42, -0.18]], u), fill: KIT_SPARK },
            { p: c => { c.beginPath(); c.moveTo(u * 0.16, -u * 0.16); c.lineTo(u * 0.52, -u * 0.52); }, line: u * 0.12, col: KIT_SPARK },
        ],
    });
    // Paints a glyph's parts as one sticker: a soft drop, every outline, then
    // every fill, so parts that touch merge into a single silhouette.
    function paintKitGlyph(c, id, u, dark) {
        const make = KIT_GLYPHS[id];
        const parts = make ? make(u) : [{ p: cc => gemPath(cc, 0, 0, u * 0.6), fill: KIT_LIGHT }];
        const b = Math.max(1.2, u * 0.14);
        c.lineCap = "round"; c.lineJoin = "round";
        const body = parts.filter(q => !q.detail);
        const outline = () => {
            for (const q of body) {
                q.p(c);
                c.lineWidth = (q.line || 0) + b * 2;
                c.stroke();
                if (q.fill) c.fill();
            }
        };
        c.save();
        c.translate(0, u * 0.1);
        c.fillStyle = c.strokeStyle = "rgba(0,0,0,0.26)";
        outline();
        c.restore();
        c.fillStyle = c.strokeStyle = dark;
        outline();
        for (const q of body) {
            q.p(c);
            if (q.line) { c.lineWidth = q.line; c.strokeStyle = q.col; c.stroke(); }
            else { c.fillStyle = q.fill; c.fill(); }
        }
        for (const q of parts) {
            if (!q.detail) continue;
            q.p(c);
            if (q.fill) { c.fillStyle = q.fill; c.fill(); }
            else { c.lineWidth = q.detail; c.strokeStyle = q.col; c.stroke(); }
        }
    }
    // Baked at the layer's own pixel scale (dpr), so the usual sizes go on
    // 1:1. A fixed 3x bake was shrunk on every draw, which aliased the
    // glyphs on a 1x screen and softened them on a retina one.
    const KIT_SPRITE_SCALE = 3;
    const kitIconSprites = new Map();
    function kitIconSprite(id, s, dpr = KIT_SPRITE_SCALE) {
        const k = crispOff ? KIT_SPRITE_SCALE : Math.max(0.5, Math.round(dpr * 100) / 100);
        const key = id + "@" + s + "@" + k;
        let spr = kitIconSprites.get(key);
        if (spr) return spr;
        const col = KIT_CARD[id] || "#8a93a6";
        const pad = Math.ceil(s * 0.12);
        spr = document.createElement("canvas");
        spr.width = spr.height = Math.ceil((s + pad * 2) * k);
        spr.unit = s + pad * 2;
        const c = spr.getContext("2d");
        c.scale(k, k);
        c.translate(pad, pad);
        // the tile: a darker lip under the face, a flat highlight strip and
        // the fine keyline, same recipe as the upgrade tiles
        const r = s * 0.22, lip = Math.max(2, s * 0.08);
        roundRectPath(c, 0, lip * 0.6, s, s, r);
        c.fillStyle = "rgba(0,0,0,0.3)"; c.fill();
        roundRectPath(c, 0, 0, s, s, r);
        c.fillStyle = gameDraw.mixColors(col, HUD.ink, 0.45); c.fill();
        roundRectPath(c, 0, 0, s, s - lip, r);
        c.fillStyle = col; c.fill();
        roundRectPath(c, s * 0.1, s * 0.07, s * 0.8, Math.max(1.5, s * 0.07), s * 0.035);
        c.fillStyle = "rgba(255,255,255,0.2)"; c.fill();
        roundRectPath(c, 0, 0, s, s, r);
        c.lineWidth = Math.max(1, s * 0.035); c.strokeStyle = HUD.line; c.stroke();
        c.translate(s / 2, (s - lip) / 2 + s * 0.01);
        paintKitGlyph(c, id, s * 0.5, kitDark(col));
        if (kitIconSprites.size > 40) kitIconSprites.clear();
        kitIconSprites.set(key, spr);
        return spr;
    }
    function drawKitIcon(c, id, cx, cy, s) {
        const t = tfOf(c);
        if (t.b || t.c || crispOff) {
            const spr = kitIconSprite(id, s);
            const half = spr.unit / 2;
            c.drawImage(spr, cx - half, cy - half, half * 2, half * 2);
            return;
        }
        const spr = kitIconSprite(id, s, t.a);
        const half = spr.unit / 2;
        blitSprite(c, t, spr, spr.width, spr.height, cx - half, cy - half, half * 2, half * 2);
    }
    function drawKitBox(spacing, alcoveSize) {
        const want = shopUiMode() && !global.died && !global.mobile && global.gems && global.gems.cap > 0 &&
            (!global.tutorialMode || (window.dwTutUi === "kit" || (window.dwTutAllow || "").includes("kit") || (global.shop.state && (global.shop.state.kitOrder || []).length))) &&
            // a first raid: the box comes in with its first item
            (global.tutorialMode || nxShows("kit", { owned: newcomer.ownsKit() }));
        kitGlide.set(want ? 1 : 0);
        const g = kitGlide.get();
        kitBoxTop = 0;
        if (g < 0.02) { global.clickables.kit.hide(); return; }
        const sh = global.shop, st = sh.state || {};
        const catalog = sh.catalog || [];
        const byId = id => catalog.find(i => i.id === id);
        const now = performance.now();
        // same anchors as drawSkillBars: 11 bars, counter row above
        const barH = STAT_BAR_H, vsp = STAT_BAR_GAP, bars = 11;
        const barsTop = global.screenHeight - spacing - 5.5 - barH - (bars - 1) * (barH + vsp);
        const W = alcoveSize - 10, H = 118;
        const x = HUD.edge;
        // 42 clear above the bars: room for the counter row (Same stats / Random) between
        const y = barsTop - 42 - H + (1 - g) * 14;
        kitBoxTop = barsTop - 42 - H;
        const c = ctx[2];
        const cr = global.canvas.height / global.screenHeight / global.ratio;
        const hov = global.clickables.kit.check({ x: global.mouse.x, y: global.mouse.y });
        global.clickables.kit.hide();
        c.save();
        c.globalAlpha = g;
        hudPanel(c, x, y, W, H);
        // top row: two equal chips, drill and sidearm, aligned to the slot grid
        const pad = 8, gap = 6;
        const chipY = y + 7, chipH = 17, chipW = (W - pad * 2 - gap) / 2;
        const drillItem = st.drill > 0 ? byId("drill" + st.drill) : null;
        const armItem = st.arm ? byId(st.arm) : null;
        const chips = [
            { i: 3, x: x + pad, text: st.drill > 0 ? "DRILL " + ROMAN[st.drill] : "NO DRILL", col: st.drill > 0 ? "#eda766" : HUD.text2, on: st.drill > 0,
              flash: sh.drillFlashAt, tip: drillItem ? [drillItem.name, drillItem.desc] : ["Drill", "Buy one at a shop. Each tier digs faster."] },
            { i: 4, x: x + pad + chipW + gap, text: armItem ? (shortName(armItem.name, st.armUntil > Date.now() ? 9 : 14).toUpperCase() + (st.armUntil > Date.now() ? "  " + fmtRaidClock(Math.ceil((st.armUntil - Date.now()) / 1000)) : "")) : "NO SIDEARM", col: armItem ? "#c9a8ff" : HUD.text2, on: !!armItem,
              flash: sh.armFlashAt, tip: armItem ? [armItem.name + "  ·  " + sidearmInput(), armItem.desc] : ["Sidearm", "A second gun on " + sidearmInput() + ". Shops sell them."] },
        ];
        for (const ch of chips) {
            const fl = ch.flash ? Math.max(0, 1 - (now - ch.flash) / 700) : 0;
            hudWell(c, ch.x, chipY, chipW, chipH, 5, hov === ch.i ? "rgba(255,255,255,0.14)" : fl > 0 ? "rgba(255,255,255," + (0.25 * fl) + ")" : HUD.well, HUD.ink, 1.5);
            drawText(labelCase(ch.text), ch.x + chipW / 2, chipY + chipH / 2 + 0.5, 10, ch.col, "center", true, g);
            global.clickables.kit.place(ch.i, ch.x * cr, chipY * cr, chipW * cr, chipH * cr);
            if (hov === ch.i) queueTip(ch.tip[0], ch.tip[1], ch.x + chipW / 2, y);
        }
        // gear row: every passive you own, as a small tag with a tooltip
        const gearY = chipY + chipH + 6, gearH = 16;
        const gearIds = (st.gear || []).filter(id => byId(id));
        hudTitle("Gear", x + pad + 1, gearY + gearH / 2, 10, HUD.text2, "left", g);
        if (!gearIds.length) {
            drawText("None yet", x + pad + 34, gearY + gearH / 2, 9, HUD.text2, "left", true, g);
        } else {
            const gx0 = x + pad + 32, gwAll = W - pad * 2 - 32;
            const bw = Math.min(36, (gwAll - 3 * (gearIds.length - 1)) / gearIds.length);
            const nowG = Date.now();
            for (let i = 0; i < gearIds.length; i++) {
                const item = byId(gearIds[i]);
                const bx = gx0 + i * (bw + 3);
                const until = +((st.gearUntil || {})[item.id]) || 0;
                const leftMs = until > 1 ? Math.max(0, until - nowG) : -1;
                const frac = leftMs < 0 ? 1 : Math.min(1, leftMs / 300000);
                const ending = leftMs >= 0 && leftMs < 30000 && (nowG % 600) < 300;
                hudWell(c, bx, gearY, bw, gearH, 4, hov === 10 + i ? "rgba(92,224,216,0.32)" : ending ? "rgba(255,120,110,0.28)" : "rgba(92,224,216,0.14)", HUD.ink, 1.5);
                // time left: a thin bar along the bottom edge of the tag
                c.fillStyle = ending ? "#ff9a8c" : SHOP_ACCENT;
                c.fillRect(bx + 2, gearY + gearH - 3, (bw - 4) * frac, 2);
                drawText(GEAR_TAG[item.id] || item.name.slice(0, 3).toUpperCase(), bx + bw / 2, gearY + gearH / 2 - 0.5, bw < 30 ? 6.5 : 7.5, ending ? "#ff9a8c" : SHOP_ACCENT, "center", true, g);
                global.clickables.kit.place(10 + i, bx * cr, gearY * cr, bw * cr, gearH * cr);
                if (hov === 10 + i) queueTip(item.name + (leftMs >= 0 ? "  ·  " + fmtRaidClock(Math.ceil(leftMs / 1000)) + " left" : ""), item.desc, bx + bw / 2, y);
            }
        }
        // slots: key badge top-left, count top-right, name below
        const keys = [keyLabel("KEY_KIT_1", "Z"), keyLabel("KEY_KIT_2", ","), keyLabel("KEY_KIT_3", "N")];
        const slotY = gearY + gearH + 7, slotH = H - (slotY - y) - 7;
        const slotW = (W - pad * 2 - gap * 2) / 3;
        for (let i = 0; i < 3; i++) {
            const sx = x + pad + i * (slotW + gap);
            kitSlotRects[i].x = sx; kitSlotRects[i].y = slotY; kitSlotRects[i].w = slotW; kitSlotRects[i].h = slotH;
            const id = (st.kitOrder || [])[i];
            const item = id ? byId(id) : null;
            const count = id ? (st.kit[id] | 0) : 0;
            const fl = id && sh.slotFlash && sh.slotFlash[id] ? sh.slotFlash[id] : null;
            const flT = fl ? Math.max(0, 1 - (now - fl.at) / 650) : 0;
            hudWell(c, sx, slotY, slotW, slotH, 6,
                item ? "rgba(242,184,60," + (0.12 + (fl && fl.kind === "get" ? 0.35 * flT : 0) + (hov === i ? 0.08 : 0)) + ")" : (hov === i ? "rgba(255,255,255,0.08)" : HUD.well),
                item && fl && fl.kind === "use" ? "rgba(255,255,255," + (0.45 + 0.5 * flT) + ")" : HUD.ink, 2);
            // key badge: a little keycap, dim when the slot is empty
            hudKey(c, sx + 4, slotY + 4, keys[i], 14, item ? 1 : 0.55);
            if (item) {
                drawText("x" + count, sx + slotW - 5, slotY + 11, 8.5, color.teal, "right", true, g);
                kitSlotIcons[item.id] = { x: sx + slotW / 2, y: slotY + 30, w: slotW, h: slotH, sx, sy: slotY, at: now };
                // the item's card: rounded corners, its own colour, its own glyph
                if (global.kitUnlockHeld !== item.id) drawKitIcon(c, item.id, sx + slotW / 2, slotY + 30, 26);
                drawText(labelCase(KIT_SHORT[item.id] || item.name.slice(0, 7)), sx + slotW / 2, slotY + slotH - 8, 9, color.guiwhite, "center", true, g);
                global.clickables.kit.place(i, sx * cr, slotY * cr, slotW * cr, slotH * cr);
                if (hov === i) queueTip(item.name + "  ·  " + keys[i], item.desc + " Drag to move it, or drag it out to throw it away.", sx + slotW / 2, y);
                if (fl && fl.kind === "use" && flT > 0) {
                    c.save();
                    c.globalAlpha = g * flT * 0.8;
                    c.strokeStyle = "#ffffff";
                    c.lineWidth = 2;
                    roundRectPath(c, sx - 4 * (1 - flT), slotY - 4 * (1 - flT), slotW + 8 * (1 - flT), slotH + 8 * (1 - flT), 7);
                    c.stroke();
                    c.restore();
                }
            } else {
                // empty card outline so the slot still reads as a card
                c.save();
                c.globalAlpha = g * 0.35;
                roundRectPath(c, sx + slotW / 2 - 13, slotY + 17, 26, 26, 6);
                c.setLineDash([3, 3]);
                c.lineWidth = 1; c.strokeStyle = "#ffffff"; c.stroke();
                c.restore();
                drawText("Empty", sx + slotW / 2, slotY + slotH - 8, 8, HUD.text2, "center", true, g);
                global.clickables.kit.place(i, sx * cr, slotY * cr, slotW * cr, slotH * cr);
                if (hov === i) queueTip("Kit slot " + (i + 1) + "  ·  " + keys[i], "Holds one kind of item. Get them at shops or from chests.", sx + slotW / 2, y);
            }
        }
        global.kitBoxRectCanvas = { x: x * cr, y: y * cr, w: W * cr, h: H * cr };
        // drag ghost: the item's card follows the cursor; over another slot
        // that slot lights up (they swap), outside the box it reads DROP
        const dragK = global.kitDrag;
        if (dragK) {
            const id = (st.kitOrder || [])[dragK.slot];
            const mx = global.mouse.x / (cr * global.ratio), my = global.mouse.y / (cr * global.ratio);
            if (id && Math.hypot(global.mouse.x - dragK.x, global.mouse.y - dragK.y) > 14) {
                const outside = mx < x || mx > x + W || my < y || my > y + H;
                const over = global.clickables.kit.check({ x: global.mouse.x, y: global.mouse.y });
                if (over >= 0 && over < 3 && over !== dragK.slot) {
                    const r = kitSlotRects[over];
                    c.save();
                    roundRectPath(c, r.x - 2, r.y - 2, r.w + 4, r.h + 4, 8);
                    c.lineWidth = 2.5; c.strokeStyle = HUD.gold; c.stroke();
                    c.restore();
                }
                c.save();
                c.globalAlpha = 0.9;
                drawKitIcon(c, id, mx, my, 26);
                c.restore();
                drawText(outside ? "DROP" : over >= 0 && over < 3 && over !== dragK.slot ? ((st.kitOrder || [])[over] ? "SWAP" : "MOVE") : "", mx, my + 24, 9, outside ? "#ff9a8c" : HUD.gold, "center", true);
            }
        }
        c.restore();
    }
    // dash + ability chips and effects (abilityFx.js) draw with these pieces
    abilityFx.init({
        // roundRectPath is a const further down: reach it at call time
        HUD, hudPanel, hudWell, hudKey, hudTitle, hudTitleW, hudTextW: (t, sz) => hudTextW(t, sz), drawText, roundRectPath: (...a) => roundRectPath(...a), keyLabel,
        drawKitIcon: (c, id, x, y, sz) => drawKitIcon(c, id, x, y, sz),
        queueTip: (t, b, x, y) => queueTip(t, b, x, y),
        markSlot: (id, r) => { kitSlotIcons[id] = r; },
        gemClass: (e) => gemSpriteClass(e),
        landAt: () => raidHeat.landAt ? raidHeat.landAt() : 0,
        hudButton: (...a) => hudButton(...a),
    });
    abilityFx.setSelf(() => gui.playerid);
    // ── raid perks (raidPerks.js): the cards, the Perk ready chip, your build ──
    raidPerks.init({
        HUD, hudPanel, hudTitle, hudTitleW, hudTextW: (t, sz) => hudTextW(t, sz), drawText, hudKey,
        rr: (...a) => roundRectPath(...a), haloSprite: (k, rgb, st) => haloSprite(k, rgb, st),
        queueTip: (t, b, x, y) => queueTip(t, b, x, y), newcomerStage: () => newcomer.stage(),
    });
    let perkAvoidSkip = false;
    let perkBlockedBy = "";
    window.dwPerkBlock = () => perkBlockedBy;
    // QA: the perk row's room last frame
    const perkLay = { bottom: 0, minTop: 0, left: 0, right: 0, blocked: false };
    window.dwPerkLay = () => perkLay;
    function drawRaidPerks() {
        if (!royaleActive() || global.tutorialMode || global.royaleSpectating) return;
        const sw = global.screenWidth, sh = global.screenHeight;
        // the satchel pills (drawSelfInfo), or where they would be
        const wallet = hudDrawn.wallet || { x: sw / 2 - 150, y: sh - 61.5, w: 300, h: 19 };
        const cr = global.canvas.height / global.screenHeight / global.ratio;
        // the row's lower edge sits just above your name (the name and the
        // satchel pills take the bottom 112), its top under your tank
        let bottom = wallet.y - 54;
        let minTop = perkTankFloor(sh, (global.selfRFrac || 0) * sw);
        // round 8, touch: a landscape phone has no room under the tank for the desktop
        const touchRow = !!global.mobile;
        if (touchRow) {
            bottom = wallet.y - 8;
            minTop = Math.round(sh / 2 + Math.max(40, (global.selfRFrac || 0) * sw + 22));
            // a grown hull on a phone: the row may cover its lower edge rather than never
            minTop = Math.max(Math.round(sh / 2 + 24), Math.min(minTop, Math.floor(bottom - 94 - 34)));
        }
        // the band left and right: clear of every other HUD piece it would touch
        let left = HUD.edge, right = sw - HUD.edge, blocked = false;
        perkBlockedBy = "";
        perkAvoidSkip = true;
        let avoid = [];
        try { avoid = hudAvoidRects(); } finally { perkAvoidSkip = false; }
        // round 8: a piece that only grazes the band's lower edge (the dash / ability
        const want = 3 * raidPerks.CARD_W + 2 * 16;
        if (!touchRow) for (const r of avoid) {
            if (r.y >= bottom || r.y + r.h <= bottom - 40 || r.y < bottom - 40) continue;
            if (r.x < sw / 2 + want / 2 && r.x + r.w > sw / 2 - want / 2 && r.y - 8 - minTop >= 94 + 34) bottom = Math.min(bottom, r.y - 8);
        }
        // touch: the name and wallet row's keep-out is the one the row may cover)
        const bandBottom = touchRow ? Math.min(bottom, sh - 113) : bottom;
        const band = { x: 0, y: Math.min(minTop, bottom - 120), w: sw, h: bandBottom - Math.min(minTop, bottom - 120) };
        if (touchRow && touch.L && touch.L.dash && touch.L.ability) {
            // the dash / ability thumb buttons on the right
            const k = touchUnits(), L = touch.L;
            right = Math.min(right, (Math.min(L.dash.x - L.dash.r, L.ability.x - L.ability.r) - 10) * k);
        }
        for (const r of avoid) {
            if (!rectsOverlap(r, band)) continue;
            // touch: the first-raid guide card steps aside for an offer (hudCardUp below)
            if (touchRow && r === global.coachRect && raidPerks.offerUp()) continue;
            const mid = r.x + r.w / 2;
            if (r.x <= sw / 2 && r.x + r.w >= sw / 2) {
                if (r.y - 8 - minTop >= 94 + 34) bottom = Math.min(bottom, r.y - 8);
                else if (bottom - (r.y + r.h + 8) >= 94 + 34) minTop = Math.max(minTop, r.y + r.h + 8);
                else { perkBlockedBy = "centre " + Math.round(r.x) + "," + Math.round(r.y) + " " + Math.round(r.w) + "x" + Math.round(r.h); blocked = true; }
            }
            else if (mid < sw / 2) left = Math.max(left, r.x + r.w + 16);
            else right = Math.min(right, r.x - 16);
        }
        // the build strip's own left limit: whatever sits at its height on the left (the
        let stripLeft = HUD.edge + 8;
        const sBand = { x: 0, y: wallet.y - 84, w: wallet.x, h: wallet.h + 90 };
        for (const r of avoid) if (r.x + r.w / 2 < sw / 2 && r.x + r.w < wallet.x && rectsOverlap(r, sBand)) stripLeft = Math.max(stripLeft, r.x + r.w + 12);
        // touch: clear of the move stick's "Drag to move" line at the bottom left
        if (touchRow) stripLeft = Math.max(stripLeft, Math.round(sw * 0.26));
        if (right - left < 3 * 184 + 32 || bottom - minTop < 94 + 34) { perkBlockedBy = "space " + Math.round(right - left) + "x" + Math.round(bottom - minTop); blocked = true; }
        // something else owns the middle: the shop or vault panel, the map,
        // the tank tree, a new item reveal, the sky drop
        const sp = global.shop;
        if ((sp && sp.onPad && !sp.dismissed) || (global.vault && global.vault.onPad) || global.showBigMap || global.showTree ||
            (global.kitUnlocks && global.kitUnlocks.length) || (raidHeat.landAt && raidHeat.landAt() > 0)) { perkBlockedBy = perkBlockedBy || "panel"; blocked = true; }
        const you = global.royale && global.royale.you;
        // playtest 9: a fresh offer waits while the middle is busy (a callout
        // plate like YOU'RE HUNTED, a slam, a new crown's card)
        const tNow = performance.now();
        let stage = false;
        try { stage = tNow - (global.hudCalloutAt || -1e9) < 400 || !!(raidHeat.slamUp && raidHeat.slamUp()) || !!(crowns.cardFresh && crowns.cardFresh()); } catch (e) { stage = false; }
        raidPerks.drawHud(ctx[2], {
            wallet, bottom, minTop, left, right, blocked, stripLeft, hold: stage,
            score: you && you.score != null ? +you.score : +(global.royale && global.royale.youScore) || 0,
            stage: newcomer.known() ? newcomer.stage() : 3,
            mouse: global.mobile ? null : { x: global.mouse.x / (cr * global.ratio), y: global.mouse.y / (cr * global.ratio) },
        });
        perkLay.bottom = bottom; perkLay.minTop = minTop; perkLay.left = left; perkLay.right = right; perkLay.blocked = blocked;
        if (global.mobile) {
            // taps reach canvas.mouseDown like clicks (touch.js anyClickable)
            const k = touchUnits();
            const st = window.dwRaidPerks ? window.dwRaidPerks() : null;
            if (st && st.view === "cards" && !global.hudCardUp) global.hudCardUp = "perk";
            const put = (id, r) => { if (r) touch.uiRects[id] = { x: r.x / k, y: r.y / k, w: r.w / k, h: r.h / k }; };
            if (st) {
                (st.cards || []).forEach((r, i) => put("perk" + i, r));
                put("perkChip", st.chip);
                if (st.view === "cards") put("perkLater", st.later);
            }
        }
    }
    let abilityBarRect = null;
    function drawAbilityBar() {
        abilityBarRect = null;
        const want = shopUiMode() && !global.died && !global.mobile && global.gems && global.gems.cap > 0 && hudDrawn.wallet &&
            // a first raid: the dash and ability chips come in with an ability
            (global.tutorialMode || nxShows("ability", { owned: newcomer.ownsAbility() }));
        if (!want) return;
        const cr = global.canvas.height / global.screenHeight / global.ratio;
        abilityBarRect = abilityFx.drawHud(ctx[2], hudDrawn.wallet, { x: global.mouse.x / (cr * global.ratio), y: global.mouse.y / (cr * global.ratio) });
        if (abilityBarRect) hudDrawn.ability = abilityBarRect;
    }
    // ── new ability reveal ─────────────────────────────────────────────
    // socketinit queues { id } in global.kitUnlocks when a kit item arrives
    // (abilityFx.js queues { id, ab: true } for an ability).
    // One at a time: the screen dims, the icon slams in at the centre over
    // spinning rays under a NEW ABILITY! ribbon, holds, then flies into its
    // kit slot, which pulses when it lands.
    const UNLOCK_CARD_MS = 3200;     // how long the small unlock card sits
    const kitSlotIcons = {};    // id -> slot geometry from the last drawKitBox
    const kitSlotRects = [{ x: 0, y: 0, w: 0, h: 0 }, { x: 0, y: 0, w: 0, h: 0 }, { x: 0, y: 0, w: 0, h: 0 }];   // GUI units, for the swap highlight
    let kitSlotPulse = null;
    function unlockBlurb(desc) {
        let s = String(desc || "");
        const dot = s.search(/[.!?](\s|$)/);
        if (dot > 0) s = s.slice(0, dot + 1);
        const colon = s.indexOf(":");
        if (colon > 24) s = s.slice(0, colon) + ".";
        return s;
    }
    const easeOut = (u) => 1 - (1 - u) * (1 - u) * (1 - u);
    const ramp = (t, a, b) => Math.max(0, Math.min(1, (t - a) / (b - a)));
    function drawKitSlotPulse(now) {
        const p = kitSlotPulse;
        if (!p) return;
        const age = now - p.at, slot = kitSlotIcons[p.id];
        if (age > 650 || !slot || now - slot.at > 200) { kitSlotPulse = null; return; }
        const u = age / 650;
        const c = ctx[2];
        c.save();
        c.globalAlpha = (1 - u) * 0.95;
        c.strokeStyle = color.gold;
        c.lineWidth = 3 * (1 - u) + 1;
        const grow = 10 * u;
        roundRectPath(c, slot.sx - grow, slot.sy - grow, slot.w + grow * 2, slot.h + grow * 2, 7 + grow);
        c.stroke();
        // a few sparks thrown off the slot as the icon lands
        for (let i = 0; i < 6; i++) {
            const a = -Math.PI / 2 + (i - 2.5) * 0.5, d = 14 + 26 * easeOut(u);
            c.fillStyle = i & 1 ? "#ffffff" : KIT_SPARK;
            starPath(c, slot.x + Math.cos(a) * d, slot.y + Math.sin(a) * d, 5 * (1 - u), 1.8 * (1 - u));
            c.fill();
        }
        c.restore();
    }
    let unlockHoldUntil = 0;
    // Something you have had before: no card, a flash at your tank and the
    // icon glides into its slot on an arc, with a short line under it.
    const GLIDE_MS = 720;
    function drawKitGlides(now) {
        const q = global.kitGlides;
        if (!q || !q.length) return;
        if (global.died || !shopUiMode()) { q.length = 0; return; }
        const land = raidHeat.landAt ? raidHeat.landAt() : 0;
        if (land > 0) unlockHoldUntil = land + 600;
        if (now < unlockHoldUntil) return;
        const c = ctx[2];
        const sx = global.screenWidth / 2, sy = global.screenHeight / 2;
        const calm = !!(global.reducedMotion && global.reducedMotion());
        for (let i = q.length - 1; i >= 0; i--) {
            const g = q[i];
            if (!g.start) g.start = now + i * 160;
            const age = now - g.start;
            if (age < 0) continue;
            const slot = kitSlotIcons[g.id];
            const live = slot && now - slot.at < 250;
            const u = Math.min(1, age / GLIDE_MS);
            const e = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
            const tx = live ? slot.x : sx, ty = live ? slot.y : sy - 60;
            const ix = sx + (tx - sx) * e, iy = sy - 40 + (ty - sy + 40) * e - Math.sin(Math.PI * e) * (calm ? 0 : 70);
            c.save();
            // the flash where you are
            if (age < 260) {
                const f = age / 260;
                c.globalAlpha = (1 - f) * 0.8;
                c.strokeStyle = KIT_CARD[g.id] || HUD.gold;
                c.lineWidth = 6 * (1 - f) + 1;
                circlePath(c, sx, sy - 40, 18 + 46 * f); c.stroke();
            }
            // a short trail
            if (!calm && !config.graphical.fewerEffects) {
                for (let k = 1; k <= 4; k++) {
                    const f = Math.max(0, u - k * 0.05);
                    const ee = f < 0.5 ? 4 * f * f * f : 1 - Math.pow(-2 * f + 2, 3) / 2;
                    c.globalAlpha = 0.7 * (1 - k / 5) * (1 - u * 0.6);
                    c.fillStyle = k & 1 ? KIT_SPARK : "#ffffff";
                    starPath(c, sx + (tx - sx) * ee, sy - 40 + (ty - sy + 40) * ee - Math.sin(Math.PI * ee) * 70, 6 - k, (6 - k) * 0.36);
                    c.fill();
                }
            }
            c.globalAlpha = live ? 1 : 1 - Math.max(0, u - 0.7) / 0.3;
            if (u < 1) drawKitIcon(c, g.id, ix, iy, 40 + (26 - 40) * e);
            c.restore();
            if (g.text && age < GLIDE_MS + 1600) {
                const a = age < GLIDE_MS + 1200 ? 1 : 1 - (age - GLIDE_MS - 1200) / 400;
                hudTitle(g.text, sx, sy + 70, 15, HUD.head, "center", Math.min(1, age / 200) * a);
            }
            if (u >= 1 && !g.landed) {
                g.landed = true;
                if (live) kitSlotPulse = { id: g.id, at: now };
            }
            if (age > GLIDE_MS + (g.text ? 1600 : 0)) q.splice(i, 1);
        }
    }
    function drawKitUnlock() {
        const now = performance.now();
        drawKitSlotPulse(now);
        drawKitGlides(now);
        const q = global.kitUnlocks;
        global.kitUnlockHeld = null;
        if (!q || !q.length) return;
        if (global.died || !shopUiMode()) { q.length = 0; return; }
        // never over the sky drop: the cards wait until just after the landing
        const land = raidHeat.landAt ? raidHeat.landAt() : 0;
        if (land > 0) unlockHoldUntil = land + 600;
        if (now < unlockHoldUntil) return;
        const sh = global.shop;
        const u = q[0];
        const item = (sh.catalog || []).find(i => i.id === u.id);
        if (!item) { q.shift(); return; }
        if (!u.start) u.start = now;
        // a small, quiet card at the edge of the HUD: it slides in, sits a
        // few seconds, then its icon glides into the slot. No dim, no burst,
        // nothing over the playfield and nothing that takes a click.
        const IN = 220, hold = q.length > 1 ? 1600 : UNLOCK_CARD_MS, FLY = 480;
        const age = now - u.start;
        const flyAt = IN + hold;
        const slot = kitSlotIcons[u.id];
        const slotLive = slot && now - slot.at < 200;
        if (age > flyAt + FLY) {
            q.shift();
            if (slotLive) {
                kitSlotPulse = { id: u.id, at: now };
                sh.slotFlash = sh.slotFlash || {};
                sh.slotFlash[u.id] = { at: now, kind: "get" };
            }
            return;
        }
        // the slot shows its icon straight away (a queue of cards used to
        // leave the third slot blank for several seconds); the card's icon
        // just flies onto it at the end
        global.kitUnlockHeld = null;
        const c = ctx[2];
        const calm = !!(global.reducedMotion && global.reducedMotion());
        const sw = global.screenWidth, shh = global.screenHeight;
        const W = 290, H = 62, IS = 42;
        // desktop: just above the ability / kit row at the bottom; touch: at
        // the top under the clock, clear of both thumbs
        let x, y;
        if (global.mobile) {
            // round 8: toward the left (the owner: the NEW ITEM / NEW ABILITY card should
            x = Math.max(HUD.edge, 12);
            y = Math.max((hudTopBottom | 0) + 10, 60 * touchUnits() + 8);
            // the plates (drawKillCallouts) wait while this card has the spot
            global.kitCardAt = now;
        } else {
            const a = hudDrawn.ability;
            const bottom = a ? a.y - 12 : shh - 170;
            x = a ? Math.max(12, Math.min(sw - W - 12, a.x + a.w / 2 - W / 2)) : (sw - W) / 2;
            y = bottom - H;
        }
        const inT = calm ? 1 : easeOut(ramp(age, 0, IN));
        const out = age > flyAt ? 1 - ramp(age, flyAt, flyAt + FLY * 0.6) : 1;
        const a = inT * out;
        if (a > 0.01) {
            const dy = (1 - inT) * (global.mobile ? -10 : 10);
            const col = KIT_CARD[u.id] || HUD.gold;
            c.save();
            hudPanel(c, x, y + dy, W, H, { r: 12, alpha: a, fill: HUD.solid });
            // a thin bar in the item's colour down the left edge
            c.globalAlpha = a;
            c.fillStyle = col;
            roundRectPath(c, x + 4, y + dy + 8, 4, H - 16, 2);
            c.fill();
            const label = u.ab ? (u.trial ? "FREE TRIAL" : "NEW ABILITY") : "NEW ITEM";
            const tx = x + 16 + IS + 12;
            hudTitle(label, tx, y + dy + 15, 10.5, HUD.gold, "left", a, c);
            let ns = 17; while (ns > 12 && hudTitleW(item.name, ns) > W - (tx - x) - 12) ns -= 1;
            hudTitle(item.name, tx, y + dy + 32, ns, HUD.head, "left", a, c);
            // one short line: how to use it (or where it went)
            const slotIdx = (sh.state.kitOrder || []).indexOf(u.id);
            const keyName = u.spare ? "" : u.ab ? keyLabel("KEY_ABILITY", "Q") : slotIdx >= 0 ? keyLabel("KEY_KIT_" + (slotIdx + 1), ["Z", ",", "N"][slotIdx]) : "";
            const line = u.spare ? "Added. Equip it at a shop." : u.trial ? "Free for 2 minutes. Buy it to keep it."
                : global.mobile ? (u.ab ? "Tap the ability button to use it." : "Tap its button on the right to use it.")
                : keyName ? null : (wrapLines(unlockBlurb(item.desc), 11.5, W - (tx - x) - 12)[0] || "");
            if (line != null) drawText(line, tx, y + dy + 49, 11.5, HUD.text2, "left", true, a);
            else {
                const kh = 18;
                hudTitle("Press", tx, y + dy + 49, 11.5, HUD.text2, "left", a, c);
                c.globalAlpha = a;
                hudKey(c, tx + hudTitleW("Press", 11.5) + 6, y + dy + 49 - kh / 2, keyName, kh);
                hudTitle("to use", tx + hudTitleW("Press", 11.5) + 12 + Math.max(kh, hudTitleW(keyName, kh * 0.62) + kh * 0.55), y + dy + 49, 11.5, HUD.text2, "left", a, c);
            }
            c.restore();
        }
        // the icon: on the card, then a short glide into its slot
        const ix0 = x + 16 + IS / 2, iy0 = y + H / 2;
        const fly = age > flyAt ? Math.min(1, (age - flyAt) / FLY) : 0;
        let ix = ix0, iy = iy0 + (1 - inT) * (global.mobile ? -10 : 10), is = IS, ia = inT;
        if (fly > 0) {
            const e = fly < 0.5 ? 4 * fly * fly * fly : 1 - Math.pow(-2 * fly + 2, 3) / 2;
            if (slotLive) {
                ix = ix0 + (slot.x - ix0) * e;
                iy = iy0 + (slot.y - iy0) * e - (calm ? 0 : Math.sin(Math.PI * e) * 30);
                is = IS + (26 - IS) * e;
            } else ia = 1 - e;
        }
        const spr = kitIconSprite(u.id, IS);
        const half = spr.unit / 2 * (is / IS);
        c.save();
        c.globalAlpha = ia;
        c.drawImage(spr, ix - half, iy - half, half * 2, half * 2);
        c.restore();
    }
    // ── shop panel ─────────────────────────────────────────────────────
    function shopStatus(item) {
        const st = global.shop.state || {};
        if (item.cat === "ability") {
            const ab = global.abil || {};
            if (ab.eq === item.id && ab.trialId !== item.id) return { text: "EQUIPPED", col: SHOP_ACCENT, buy: false };
            if ((ab.own || []).includes(item.id)) return { text: "OWNED", col: SHOP_ACCENT, buy: true, equip: true };
            if (ab.trialId === item.id) return { text: "ON TRIAL", col: color.gold, buy: true };
            return { text: "", col: color.grey, buy: true };
        }
        if (item.cat === "drill") {
            if ((st.drill | 0) >= item.tier) return { text: "OWNED", col: SHOP_ACCENT, buy: false };
            if (item.tier !== (st.drill | 0) + 1) return { text: "LOCKED", col: color.grey, buy: false };
            return { text: "NEXT", col: color.gold, buy: true };
        }
        // Stat Point: not a timed gear item, buy as many as fit
        if (item.id === "statpt") return { text: st.statPts ? st.statPts + "/10" : "", col: SHOP_ACCENT, buy: (st.statPts | 0) < 10 };
        if (item.cat === "gear") {
            if ((st.gear || []).includes(item.id)) return { text: "RUNNING", col: SHOP_ACCENT, buy: false };
            if ((st.gear || []).length >= 4) return { text: "GEAR FULL", col: color.grey, buy: false };
            return { text: "", col: color.grey, buy: true };
        }
        if (item.cat === "kit") {
            const have = (st.kit || {})[item.id] | 0;
            if (have >= item.max) return { text: "x" + have + " FULL", col: SHOP_ACCENT, buy: false };
            if (!have && (st.kitOrder || []).filter(Boolean).length >= 3) return { text: "KIT FULL", col: color.grey, buy: false };
            return { text: have ? "x" + have : "", col: SHOP_ACCENT, buy: true };
        }
        if (item.cat === "arm") return st.arm === item.id ? { text: "MOUNTED", col: SHOP_ACCENT, buy: false } : { text: "", col: color.grey, buy: true };
        return { text: "", col: color.grey, buy: true };
    }

    // Hover states ease in and out over 140 ms instead of snapping.
    const hoverEases = new Map();
    function hoverEase(id, on, now) {
        let e = hoverEases.get(id);
        if (!e) { e = { v: on ? 1 : 0, t: now }; hoverEases.set(id, e); return e.v; }
        const step = Math.min(100, now - e.t) / 140;
        e.t = now;
        e.v = on ? Math.min(1, e.v + step) : Math.max(0, e.v - step);
        if (hoverEases.size > 200) hoverEases.clear();
        return e.v;
    }
    // One flat tile: opaque face, lighter on hover, bottom shade strip,
    // black border (same recipe as the class-upgrade tiles).
    function drawFlatTile(c, x, y, w, h, fill, hoverT, alpha, sel, selCol) {
        // a card on a plate: flat face, fine keyline; the picked one gets
        // the menu's copper ring
        c.save();
        c.globalAlpha = alpha;
        const r = 8;
        roundRectPath(c, x, y, w, h, r);
        c.fillStyle = fill;
        c.fill();
        if (hoverT > 0) {
            c.fillStyle = "rgba(255,255,255," + (0.1 * hoverT) + ")";
            c.fill();
        }
        c.lineWidth = 1.25;
        c.strokeStyle = HUD.line;
        c.stroke();
        if (sel) {
            roundRectPath(c, x - 3.5, y - 3.5, w + 7, h + 7, r + 3);
            c.lineWidth = 2.5;
            c.strokeStyle = selCol || HUD.copper;
            c.stroke();
        }
        c.restore();
    }
    const SHOP_CARD = HUD.raised, SHOP_CARD_OFF = "#29232f", SHOP_CARD_SEL = "#43384f";
    const shopMeasure = new Map();
    function shopMeasureText(txt, size) {
        const k = txt + "|" + size;
        let w = shopMeasure.get(k);
        if (w === undefined) { w = measureText(txt, size); if (shopMeasure.size > 400) shopMeasure.clear(); shopMeasure.set(k, w); }
        return w;
    }
    let abTabSeen = true, abTabFor = 0, abTabLast = 0;
    try { abTabSeen = tabSeen(localStorage); } catch (e) { abTabSeen = true; }
    function drawShopUI() {
        const want = shopOpenWanted();
        shopGlide.set(want ? 1 : 0);
        const g = shopGlide.get();
        if (g < 0.02) { global.clickables.shop.hide(); global.shop.tabItems = []; return; }
        const sh = global.shop;
        const catalog = sh.catalog || [];
        const now = performance.now();
        const sw = global.screenWidth, shh = global.screenHeight;
        const W = Math.min(720, sw - 40), H = Math.min(440, shh - 130);
        const x = Math.round((sw - W) / 2), y = Math.round(Math.max(76, (shh - H) / 2 - 20) + (1 - g) * 22);
        const cr = global.canvas.height / shh / global.ratio;
        const c = ctx[2];
        global.clickables.shop.hide();
        // touch: the whole plate takes taps, so a thumb on it never drives the tank
        if (global.mobile) touch.uiRects.shop = { x: x * cr, y: y * cr, w: W * cr, h: H * cr };
        // frame: one solid plate, heading row, divider
        c.save();
        c.globalAlpha = g;
        hudPanel(c, x, y, W, H, { fill: HUD.solid, r: HUD.rBig });
        c.fillStyle = "rgba(0,0,0,0.6)";
        c.fillRect(x + 14, y + 50, W - 28, 2);
        gemPath(c, x + 28, y + 26, 10);
        c.fillStyle = HUD.gold; c.fill();
        c.lineWidth = 2; c.strokeStyle = HUD.ink; c.stroke();
        c.restore();
        hudTitle("Shop", x + 46, y + 26, 24, HUD.head, "left", g);
        hudTitle(String(sh.padName || "").replace(" Shop", ""), x + 46 + hudTitleW("Shop", 24) + 10, y + 28, 14, HUD.text2, "left", g);
        // banked: a dark wallet pill like the menu's gem counter
        const bankTxt = fmtNum(global.gems.banked | 0);
        const bw2 = hudTitleW(bankTxt, 16) + 40, bh2 = 30, bx2 = x + W - 58 - bw2, by2 = y + 11;
        c.save();
        c.globalAlpha = g;
        hudWell(c, bx2, by2, bw2, bh2, bh2 / 2, HUD.wellSolid, HUD.ink, 2.5);
        gemPath(c, bx2 + 16, by2 + bh2 / 2, 7);
        c.fillStyle = HUD.gold; c.fill();
        c.lineWidth = 1.5; c.strokeStyle = HUD.ink; c.stroke();
        c.restore();
        hudTitle(bankTxt, bx2 + bw2 - 12, by2 + bh2 / 2, 16, HUD.head, "right", g);
        hudTitle(scoreText.BANK, bx2 - 8, by2 + bh2 / 2, 12, HUD.text2, "right", g);
        // close: the menu's little red button
        const cbs = 30;
        hudButton(c, x + W - 14 - cbs / 2, y + 11, cbs, cbs, "X", { fill: HUD.danger, lipCol: HUD.dangerDk, textCol: "#fff", size: 15, type: "shop", index: 41, cr, alpha: g });
        // tabs: chunky toggles, the picked one copper (abTabSeen: the NEW badge)
        SHOP_TABS = catalog.some(it => it.cat === "ability") ? SHOP_TABS_AB : SHOP_TABS_OLD;
        sh.tabIds = SHOP_TABS.map(t => t[0]);
        if (!sh.tabPicked && SHOP_TABS === SHOP_TABS_AB && !global.tutorialMode) sh.tab = "ability";
        const tabY = y + 62, tabH = 30, tabW = (W - 40) / SHOP_TABS.length;
        for (let i = 0; i < SHOP_TABS.length; i++) {
            const [id, label] = SHOP_TABS[i];
            const tx = x + 20 + i * tabW;
            const on = sh.tab === id;
            hudButton(c, tx + tabW / 2, tabY, tabW - 8, tabH, label, on
                ? { fill: HUD.copper, lipCol: HUD.copperDk, textCol: "#fff", size: 14, type: "shop", index: 42 + i, cr, alpha: g }
                : { size: 14, type: "shop", index: 42 + i, cr, alpha: g, textCol: HUD.text });
            // NEW on the Abilities tab until it has been looked at once
            if (id === "ability" && !abTabSeen) {
                const nowT = performance.now();
                if (on) {
                    if (nowT - abTabLast < 250) abTabFor += nowT - abTabLast;
                    abTabLast = nowT;
                    if (abTabFor > TAB_SEEN_MS) { abTabSeen = true; try { markTabSeen(localStorage); } catch (e) { /* */ } }
                }
                const bw = hudTitleW("NEW", 9) + 12, bx = tx + tabW - 8 - bw / 2, byy = tabY - 4;
                hudPanel(c, bx - bw / 2, byy - 7, bw, 14, { r: 7, lip: 1.5, fill: HUD.danger, alpha: g });
                hudTitle("NEW", bx, byy, 9, "#fff", "center", g, c);
            }
        }
        // item grid + detail
        const items = catalog.filter(it => it.cat === sh.tab);
        sh.tabItems = items;
        if (!sh.sel || !items.find(it => it.id === sh.sel)) sh.sel = items.length ? items[0].id : null;
        // nothing to spend yet: say how to get there, over the grid
        let hintH = 0;
        if (!global.tutorialMode) {
            let cheapest = 0;
            for (const it of catalog) if (it && it.price > 0 && (!cheapest || it.price < cheapest)) cheapest = it.price;
            const hint = shopHint({ banked: global.gems.banked | 0, carried: global.gems.carried | 0, cheapest });
            if (hint) {
                hintH = 44;
                const hx = x + 20, hy = tabY + tabH + 12, hw = W - 40;
                c.save(); c.globalAlpha = g;
                hudWell(c, hx, hy, hw, 38, 10, HUD.wellSolid, HUD.gold, 2);
                gemPath(c, hx + 20, hy + 19, 8);
                c.fillStyle = HUD.gold; c.fill();
                c.lineWidth = 1.5; c.strokeStyle = HUD.ink; c.stroke();
                c.restore();
                hudTitle(hint.title, hx + 36, hy + 12, 13, HUD.gold, "left", g);
                let hs = 11.5; while (hs > 9 && hudTextW(hint.text, hs) > hw - 48) hs -= 0.5;
                drawText(hint.text, hx + 36, hy + 28, hs, HUD.text, "left", true, g);
            }
        }
        const gridX = x + 20, gridY = tabY + tabH + 16 + hintH, GAP = 10;
        const detailW = 240;
        const gridW = W - 40 - detailW - 14;
        // every item in the tab must fit: cards shrink, and a third column
        // opens if that's too tight
        const gridH = y + H - 32 - gridY;
        const rowsFor = (n) => Math.max(1, Math.ceil(items.length / n));
        const fitH = (n) => Math.floor((gridH - (rowsFor(n) - 1) * GAP) / rowsFor(n));
        let cols = gridW >= 430 ? 3 : 2;
        let cardH = Math.min(58, fitH(cols));
        if (cardH < 44 && cols < 3) { cols = 3; cardH = Math.min(58, fitH(cols)); }
        cardH = Math.max(36, cardH);
        const cardW = (gridW - (cols - 1) * GAP) / cols;
        const hover = global.clickables.shop.check({ x: global.mouse.x, y: global.mouse.y });
        const kitFull = ((sh.state && sh.state.kitOrder) || []).filter(Boolean).length >= 3;
        for (let i = 0; i < items.length && i < 36; i++) {
            const it = items[i];
            const col = i % cols, row = (i / cols) | 0;
            const ix = gridX + col * (cardW + GAP), iy = gridY + row * (cardH + GAP);
            if (iy + cardH > y + H - 32 + 1) break;
            const sel = it.id === sh.sel;
            const hov = hover === 4 + i;
            const hT = hoverEase("card:" + it.id, hov, now);
            const status = shopStatus(it);
            const afford = status.equip || (global.gems.banked | 0) >= it.price;
            drawFlatTile(c, ix, iy, cardW, cardH, sel ? SHOP_CARD_SEL : status.buy ? SHOP_CARD : SHOP_CARD_OFF, hT, g, sel, HUD.copper);
            let nameX = ix + 10;
            if (it.cat === "kit" || it.cat === "ability") { drawKitIcon(c, it.id, ix + 18, iy + Math.min(17, cardH * 0.3), Math.min(18, cardH * 0.34)); nameX = ix + 32; }
            const nameW = cardW - (nameX - ix) - 10;
            let ns = 12; while (ns > 9 && shopMeasureText(it.name, ns) > nameW) ns -= 0.5;
            drawText(it.name, nameX, iy + Math.min(17, cardH * 0.3), ns, status.buy ? color.guiwhite : HUD.text2, "left", true, g);
            c.save(); c.globalAlpha = g;
            gemPath(c, ix + 12, iy + cardH - 16, 5);
            c.fillStyle = afford ? color.gold : "#7a5a5a"; c.fill();
            c.restore();
            drawText(fmtNum(it.price), ix + 22, iy + cardH - 16, 11.5, afford ? color.gold : "#ff9a8c", "left", true, g);
            if (status.text) drawText(status.text, ix + cardW - 8, iy + cardH - 16, 9, status.col, "right", true, g);
            global.clickables.shop.place(4 + i, ix * cr, iy * cr, cardW * cr, cardH * cr);
            if (hov && it.id !== sh.sel) queueTip(it.name + "  ·  " + fmtNum(it.price) + " banked", it.desc, ix + cardW / 2, iy);
        }
        // detail pane
        const dx = x + W - 20 - detailW, dy = gridY, dh = y + H - 32 - gridY;
        c.save(); c.globalAlpha = g;
        hudWell(c, dx, dy, detailW, dh, 10, HUD.wellSolid, HUD.ink, 2.5);
        c.restore();
        const sel = items.find(it => it.id === sh.sel);
        if (sel) {
            const status = shopStatus(sel);
            const catName = (SHOP_TABS.find(t => t[0] === sel.cat) || ["", ""])[1].toUpperCase();
            let tx = dx + 14;
            if (sel.cat === "kit" || sel.cat === "ability") { drawKitIcon(c, sel.id, dx + 27, dy + 24, 26); tx = dx + 48; }
            let ns2 = 18; while (ns2 > 12 && hudTitleW(sel.name, ns2) > dx + detailW - 12 - tx) ns2 -= 0.5;
            hudTitle(sel.name, tx, dy + 19, ns2, HUD.head, "left", g);
            const abInput = global.mobile ? "BUTTON" : "KEY " + keyLabel("KEY_ABILITY", "Q").toUpperCase();
            drawText(catName + (sel.cat === "kit" ? "  ·  MAX " + sel.max + " PER SLOT" : sel.cat === "drill" ? "  ·  TIER " + sel.tier : sel.cat === "arm" ? "  ·  " + sidearmInput().toUpperCase()
                : sel.cat === "ability" ? "  ·  " + Math.round((sel.cd || 0) / 1000) + "S COOLDOWN  ·  " + abInput : "  ·  5 MINUTES"), tx, dy + 37, 9.5, HUD.text2, "left", true, g);
            const lines = wrapLines(sel.desc, 11.5, detailW - 28);
            let ly = dy + 60;
            for (const ln of lines.slice(0, 5)) { drawText(ln, dx + 14, ly, 11.5, HUD.text, "left", true, g); ly += 16; }
            if (sel.cat === "ability") {
                for (const ln of wrapLines(aoNow() ? "You keep it for as long as you stay in the game, even after you die. You can swap abilities here with Equip." : "You keep it for the whole raid, even after you die. You can swap abilities here with Equip.", 10.5, detailW - 28)) {
                    drawText(ln, dx + 14, ly + 2, 10.5, HUD.text2, "left", true, g); ly += 14;
                }
            }
            if (sel.cat === "kit" && !status.buy && status.text === "KIT FULL") {
                for (const ln of wrapLines("Your kit only holds 3 kinds of items, so use one up first.", 10.5, detailW - 28)) {
                    drawText(ln, dx + 14, ly + 2, 10.5, "#ff9a8c", "left", true, g); ly += 14;
                }
            }
            const afford = status.equip || (global.gems.banked | 0) >= sel.price;
            c.save(); c.globalAlpha = g;
            gemPath(c, dx + 20, dy + dh - 60, 6.5);
            c.fillStyle = afford ? HUD.gold : "#ff9a8c"; c.fill();
            c.lineWidth = 1.5; c.strokeStyle = HUD.ink; c.stroke();
            c.restore();
            hudTitle(status.equip ? "Owned" : fmtNum(sel.price) + " banked", dx + 32, dy + dh - 60, 15, afford ? HUD.gold : "#ff9a8c", "left", g);
            const can = status.buy && afford;
            const bbx = dx + 14, bby = dy + dh - 48, bbw = detailW - 28, bbh = 36;
            const cap = t => t.charAt(0) + t.slice(1).toLowerCase();
            const btnText = !status.buy ? (status.text === "KIT FULL" ? "Kit full (3 slots)" : cap(status.text || "UNAVAILABLE")) : status.equip ? "Equip" : !afford ? "Not enough banked" : "Buy";
            hudButton(c, bbx + bbw / 2, bby, bbw, bbh, btnText, can
                ? { fill: HUD.play, lipCol: HUD.playDk, textCol: "#fff", size: 17, type: "shop", index: 40, cr, alpha: g }
                : { enabled: false, size: 14, alpha: g, textCol: HUD.text });
            c.globalAlpha = 1;
        }
        const msgAge = now - (sh.msgAt || -1e9);
        if (sh.msg && msgAge < 3200) {
            drawText(sh.msg, x + W / 2, y + H - 15, 11.5, sh.msgOk ? color.teal : "#ff9a8c", "center", true, g * (msgAge > 2600 ? 1 - (msgAge - 2600) / 600 : 1));
        }
    }

    // ── world layer: boss and bloom edge markers, streak marks, fx ──────
    // `placed` collects pill rects so two markers on the same edge slide
    // apart instead of stacking.
    // mini: the quieter second marker, its glyph and distance only, a little faded
    function drawEdgeMarker(c, e, col, glyph, name, distText, placed, mini = false) {
        const sw = global.screenWidth, sh = global.screenHeight;
        if (name && name === name.toUpperCase()) name = labelCase(name);
        const label = mini ? (distText || "") : name + (distText ? "  " + distText : "");
        const tw = hudTextW(label, 10.5);
        const pw = tw + 36, ph = 21;
        const inX = -Math.cos(e.ang), inY = -Math.sin(e.ang);
        const horiz = Math.abs(inX) > Math.abs(inY);
        const pillAt = () => {
            let px = e.x + inX * (13 + (horiz ? pw / 2 : 0));
            let py = e.y + inY * (13 + (horiz ? 0 : ph / 2));
            px = Math.max(pw / 2 + 4, Math.min(sw - pw / 2 - 4, px));
            py = Math.max(ph / 2 + 4, Math.min(sh - ph / 2 - 4, py));
            return { x: px - pw / 2, y: py - ph / 2, w: pw, h: ph, cx: px, cy: py };
        };
        let rect = pillAt();
        if (placed) {
            // the pill itself must clear other pills AND the HUD panels
            const blockers = placed.concat(hudAvoidRects());
            for (let tries = 0; tries < 6; tries++) {
                const hit = blockers.find(r => rect.x < r.x + r.w + 6 && rect.x + rect.w + 6 > r.x && rect.y < r.y + r.h + 6 && rect.y + rect.h + 6 > r.y);
                if (!hit) break;
                // slide along the edge, away from the other pill
                if (horiz) e.y += (rect.cy >= hit.y + hit.h / 2 ? 1 : -1) * (ph + 8);
                else e.x += (rect.cx >= hit.x + hit.w / 2 ? 1 : -1) * (pw + 8);
                e.x = Math.max(16, Math.min(sw - 16, e.x));
                e.y = Math.max(16, Math.min(sh - 20, e.y));
                rect = pillAt();
            }
            placed.push(rect);
        }
        const px = rect.cx, py = rect.cy;
        const a0 = c.globalAlpha;
        if (mini) c.globalAlpha = a0 * 0.72;
        c.save();
        c.translate(e.x, e.y);
        c.rotate(e.ang);
        c.fillStyle = col; c.strokeStyle = color.black; c.lineWidth = 2; c.lineJoin = "round";
        c.beginPath(); c.moveTo(10, 0); c.lineTo(-6, -8); c.lineTo(-3, 0); c.lineTo(-6, 8); c.closePath();
        c.fill(); c.stroke();
        c.restore();
        c.save();
        roundRectPath(c, px - pw / 2, py - ph / 2, pw, ph, 10.5);
        c.fillStyle = HUD.panel;
        c.fill();
        c.lineWidth = 2;
        c.strokeStyle = HUD.ink;
        c.stroke();
        c.fillStyle = col; c.strokeStyle = HUD.ink; c.lineWidth = 1.5;
        const gx = px - pw / 2 + 12, gy = py;
        if (glyph === "boss") { polyPath(c, gx, gy, 6.5, 8, Math.PI / 8); c.fill(); c.stroke(); }
        else if (glyph === "gem") { gemPath(c, gx, gy + 0.5, 6.5); c.fill(); c.stroke(); }
        else if (glyph === "skull") { c.restore(); drawSkull(c, gx, gy, 6, col); c.save(); }
        else if (glyph === "contract") { c.beginPath(); c.arc(gx, gy, 6, 0, Math.PI * 2); c.fill(); c.stroke(); c.beginPath(); c.arc(gx, gy, 2.2, 0, Math.PI * 2); c.fillStyle = HUD.ink; c.fill(); }
        else if (glyph === "mate") { c.save(); c.translate(gx, gy); c.rotate(Math.PI / 4); c.fillRect(-4.5, -4.5, 9, 9); c.strokeRect(-4.5, -4.5, 9, 9); c.restore(); }
        else if (glyph === "crown") crowns.drawCrownIcon(c, gx, gy, 11);
        else if (glyph.startsWith("ping:")) { c.beginPath(); c.arc(gx, gy, 7, 0, Math.PI * 2); c.fill(); c.stroke(); drawPingGlyph(c, gx, gy, 5, glyph.slice(5)); }
        else { c.beginPath(); c.moveTo(gx, gy - 6); c.lineTo(gx + 6, gy + 5); c.lineTo(gx - 6, gy + 5); c.closePath(); c.fill(); c.stroke(); }
        c.restore();
        if (label) drawText(label, px - pw / 2 + 23, py + 0.5, 10.5, color.guiwhite, "left", true, c.globalAlpha, 5);
        c.globalAlpha = a0;
    }
    // Damage reads on the chest itself: jagged cracks grow from the centre
    // as health falls, seeded per chest so they do not flicker.
    const KIT_FX = {
        medkit: "#6ff5a8", overdrive: "#ffb347", anchor: "#7fb1f2", flash: "#5ce0d8",
        bulwark: "#b9c3d1", decoy: "#ffd75e", strut: "#c9c9d6", charge: "#ffe0a8",
        barrage: "#ff8a6b", rocket: "#ffb347", flare: "#ff8ab0",
    };
    const chestSeenAt = new Map();
    function drawRoyaleWorldMarkers(px, py, ratio) {
        if (!royaleActive() || global.died) return;
        sweepTracks();
        const r = global.royale;
        const c = ctx[2];
        const cx = global.screenWidth / 2, cy = global.screenHeight / 2;
        const now = performance.now();
        const toScreen = (wx, wy) => ({ x: ratio * wx - px + cx, y: ratio * wy - py + cy });
        const onScreen = (s, m) => s.x > -m && s.x < global.screenWidth + m && s.y > -m && s.y < global.screenHeight + m;
        const me = { x: global.player.renderx, y: global.player.rendery };
        const marks = [];
        // the contract's target: a ring on it when it's in view, else the
        // first edge marker
        const ob = r.you && nxShows("contracts") ? r.you.obj : null;
        const tg = ob ? contractTarget(ob) : null;
        let contractE = -1;
        if (tg && ob.k === "zone") {
            // the safe zone: the whole edge is lit (drawStorm), so no ring;
            // an arrow at your tank points in, unless the storm's own
            // "get out" arrow is already up, and an edge marker when the
            // way in is off screen
            const s = toScreen(tg.x, tg.y);
            const d = Math.hypot(tg.x - me.x, tg.y - me.y);
            if (!onScreen(s, -30)) marks.push({ pri: -1, s, col: HUD.gold, glyph: "contract", name: CONTRACT_LABEL.zone, d });
            if (d > 40 && !playerInStorm()) drawSafeArrow(c, cx, cy, Math.atan2(tg.y - me.y, tg.x - me.x), now);
        } else if (tg) {
            contractE = ob.e != null ? ob.e : -1;
            const s = toScreen(tg.x, tg.y);
            const d = Math.hypot(tg.x - me.x, tg.y - me.y);
            const rr = (ob.tr || (tg.size ? tg.size * 1.5 + 14 : 46)) * ratio;
            if (onScreen(s, -Math.min(rr, 40))) {
                if (d > 120) drawContractRing(c, s.x, s.y, rr, now);
            } else marks.push({ pri: -1, s, col: HUD.gold, glyph: "contract", name: CONTRACT_LABEL[ob.k] || "CONTRACT", d });
        }
        // round 9: the rich vein ping (socketinit FX veinping)
        const vp = global.veinPing;
        if (vp && now < vp.until) {
            const s = toScreen(vp.x, vp.y);
            const d = Math.hypot(vp.x - me.x, vp.y - me.y);
            if (d < 220) global.veinPing = null;
            else if (!onScreen(s, -30)) marks.push({ pri: 0, s, col: "#7fe3ff", glyph: "gem", name: "RICH VEIN", d });
        }
        // revenge: your last killer, when it's not already the contract target
        const rv = r.you && r.you.revenge;
        if (rv && rv.alive && !rv.tough && rv.e !== contractE && isFinite(rv.x) && nxShows("revenge")) {
            const p = trackPos("revenge", rv.x, rv.y, 0.8);
            const s = toScreen(p.x, p.y);
            const d = Math.hypot(p.x - me.x, p.y - me.y);
            if (!onScreen(s, -20) && d < 3600) marks.push({ pri: 2, s, col: "#ff6b5e", glyph: "skull", name: "Revenge: " + shortName(rv.name, 10), d });
        }
        if (r.boss && nxShows("boss", { near: newcomer.bossNear() })) {
            const p = trackPos("boss", r.boss.x, r.boss.y, 0.6);
            const s = toScreen(p.x, p.y);
            if (!onScreen(s, -60)) marks.push({ pri: 1, s, col: r.boss.c || "#c9a8ff", glyph: "boss", name: String(r.boss.name || "Boss"), d: Math.hypot(p.x - me.x, p.y - me.y) });
        }
        if (r.bloom && r.bloom.until > Date.now()) {
            const s = toScreen(r.bloom.x, r.bloom.y);
            const d = Math.hypot(r.bloom.x - me.x, r.bloom.y - me.y);
            if (!onScreen(s, -(r.bloom.r || 300) * ratio) && d < 3400) marks.push({ pri: 2, s, col: "#ffd76e", glyph: "gem", name: "ORE BLOOM", d });
        }
        // marked streakers: the badge over the tank (drawStreakBadge, in the
        // overhead stack); the nearest one out of sight gets an edge marker
        let nearest = null;
        for (const p of (nxShows("streaks") ? r.pings || [] : [])) {
            if (p.id === gui.playerid || streakShownAt.get(p.id) === overheadFrame) continue;
            const tp = trackPos("ping" + p.id, p.x, p.y, 0.6);
            const s = toScreen(tp.x, tp.y);
            if (onScreen(s, -20)) continue;
            const d = Math.hypot(tp.x - me.x, tp.y - me.y);
            if (!nearest || d < nearest.d) {
                nearest = { pri: 3, s, col: "#ffb347", glyph: "streak", name: shortName(p.name, 10) + " x" + p.streak, d };
            }
        }
        if (nearest) marks.push(nearest);
        // duos: your partner off screen gets an arrow in your colour
        const dmate = r.duos && r.duo && r.duo.mate;
        if (dmate && dmate.alive && dmate.x != null) {
            const tp = trackPos("duomate", dmate.x, dmate.y, 0.8);
            const s = toScreen(tp.x, tp.y);
            if (!onScreen(s, -30)) marks.push({ pri: 0, s, col: playerHexCol() || HUD.sky, glyph: "mate", name: shortName(dmate.name || "Teammate", 12), d: Math.hypot(tp.x - me.x, tp.y - me.y) });
        }
        try {
            if (r.ao && r.ao.on) {
                aoHud.drawWorld(c, cx - px, cy - py, ratio, aoApi());
                for (const mk of aoHud.mapMarks()) {
                    const s = toScreen(mk.x, mk.y);
                    const d = Math.hypot(mk.x - me.x, mk.y - me.y);
                    if (d > mk.r * 0.9 && !onScreen(s, -40)) marks.push({ pri: mk.live ? 0 : 1, s, col: mk.col, glyph: "gem", name: String(mk.n || "Event").toUpperCase(), d });
                }
            }
        } catch (e) { }
        raidHeat.worldMarks(marks, toScreen, onScreen, me, trackPos, ratio);
        try { crowns.worldMarks(marks, toScreen, onScreen, me, trackPos); } catch (e) { /* */ }
        // a director moment (first raids): its arrow, or its ring when in view
        try { newcomer.worldMarks(marks, toScreen, onScreen, me, c, ratio); } catch (e) { /* */ }
        marks.sort((a, b) => a.pri - b.pri);
        const placed = [], kept = [];
        // one chip per thing (the contract on the boss, a supply drop said
        // twice) and two at most: the most important one named, the next
        // one a quiet glyph and distance (the big map has the rest)
        for (const mk of marks) {
            if (kept.length >= 2) break;
            if (kept.some(o => o.name === mk.name || Math.hypot(o.s.x - mk.s.x, o.s.y - mk.s.y) < 90)) continue;
            kept.push(mk);
        }
        for (let i = 0; i < kept.length; i++) {
            const mk = kept[i];
            const e = edgePoint(mk.s.x - cx, mk.s.y - cy);
            drawEdgeMarker(c, e, mk.col, mk.glyph, mk.name, fmtDist(mk.d), placed, i > 0);
        }
        // a chest seen for the first time while still young plays its landing
        const seen = new Set();
        for (const ch of (r.chests || [])) {
            seen.add(ch.id);
            if (!chestSeenAt.has(ch.id)) {
                const fresh = ch.a != null && ch.a < 900;
                chestSeenAt.set(ch.id, now);
                if (fresh && ch.e != null) chestSpawnByEnt.set(ch.e, now);
            }
        }
        for (const id of chestSeenAt.keys()) if (!seen.has(id)) chestSeenAt.delete(id);
        for (const [eid, t0] of chestSpawnByEnt) if (now - t0 > 5000) chestSpawnByEnt.delete(eid);
        for (const [eid, t0] of chestGoneAt) if (now - t0 > 2000) { chestGoneAt.delete(eid); if (window.terrainRenderer && window.terrainRenderer.dropCell) window.terrainRenderer.dropCell(chestCellKey(eid)); }
    }
    // The safe-zone job's arrow: gold, circling your tank, pointing the way
    // in (the same shape as the storm's "get out" arrow).
    function drawSafeArrow(c, x, y, ang, now) {
        const calm = !!(global.reducedMotion && global.reducedMotion());
        const ar = 86 + (calm ? 0 : Math.sin(now / 160) * 5);
        c.save();
        c.translate(x + Math.cos(ang) * ar, y + Math.sin(ang) * ar);
        c.rotate(ang);
        c.scale(2.2, 2.2);
        c.globalAlpha = 0.95;
        c.fillStyle = HUD.gold; c.strokeStyle = HUD.ink; c.lineWidth = 1.4; c.lineJoin = "round";
        c.beginPath(); c.moveTo(10, 0); c.lineTo(-6, -8); c.lineTo(-3, 0); c.lineTo(-6, 8); c.closePath();
        c.fill(); c.stroke();
        c.restore();
    }
    // A gold ring with four ticks on the contract target; it breathes unless
    // reduced motion is on.
    const ringDash = [0, 0], NO_DASH = [];
    function drawContractRing(c, x, y, R, now) {
        const calm = !!(global.reducedMotion && global.reducedMotion());
        const k = calm ? 0 : 0.5 + 0.5 * Math.sin(now / 260);
        const rr = R * (1 + 0.06 * k);
        c.save();
        c.lineCap = "round";
        c.globalAlpha = 0.9;
        c.strokeStyle = HUD.ink; c.lineWidth = 6;
        c.beginPath(); c.arc(x, y, rr, 0, Math.PI * 2); c.stroke();
        c.strokeStyle = HUD.gold; c.lineWidth = 3;
        ringDash[0] = rr * 0.42; ringDash[1] = rr * 0.36;
        c.setLineDash(ringDash);
        c.lineDashOffset = calm ? 0 : -now / 40;
        c.beginPath(); c.arc(x, y, rr, 0, Math.PI * 2); c.stroke();
        c.setLineDash(NO_DASH);
        for (let i = 0; i < 4; i++) {
            const a = i * Math.PI / 2 + Math.PI / 4;
            const ca = Math.cos(a), sa = Math.sin(a);
            c.strokeStyle = HUD.ink; c.lineWidth = 6;
            c.beginPath(); c.moveTo(x + ca * (rr + 6), y + sa * (rr + 6)); c.lineTo(x + ca * (rr + 16), y + sa * (rr + 16)); c.stroke();
            c.strokeStyle = HUD.gold; c.lineWidth = 3;
            c.beginPath(); c.moveTo(x + ca * (rr + 6), y + sa * (rr + 6)); c.lineTo(x + ca * (rr + 16), y + sa * (rr + 16)); c.stroke();
        }
        c.restore();
    }
    const ROCK_CHIPS = ["rgb(5,4,7)", "rgb(14,12,19)", "rgb(26,23,33)"];
    // Boss death: a white-out, a tinted vignette pulse, a core bloom, light
    // rays, three shockwaves and a debris field in the boss's colour.
    function buildBossBurst(f) {
        const rnd = lcg(((f.born | 0) ^ 0x5bd1) >>> 0 || 11);
        f.parts = [];
        for (let e = 0; e < 56; e++) f.parts.push({ ang: rnd() * Math.PI * 2, sp: 0.35 + rnd() * 1, size: 3 + rnd() * 9, dark: rnd() < 0.6, shade: Math.floor(rnd() * 3), spin: (rnd() - 0.5) * 16, sq: 0.45 + rnd() * 0.55 });
        f.sparks = [];
        for (let e = 0; e < 44; e++) f.sparks.push({ ang: rnd() * Math.PI * 2, sp: 0.5 + rnd() * 1, white: rnd() < 0.3 });
        f.rays = [];
        for (let e = 0; e < 18; e++) f.rays.push({ ang: rnd() * Math.PI * 2, len0: 40 + rnd() * 40, len: 260 + rnd() * 320, w: 3 + rnd() * 5, a: 0.5 + rnd() * 0.45 });
    }
    function drawFx(px, py, ratio) {
        const list = global.fx;
        if (!list || !list.length) return;
        const now = performance.now();
        const c = ctx[2];
        const cx = global.screenWidth / 2, cy = global.screenHeight / 2;
        for (let i = list.length - 1; i >= 0; i--) {
            const f = list[i];
            const big = f.kind === "boss" || f.kind === "bossdead" || f.kind === "bloom" || f.kind === "supply";
            const DUR = f.kind === "bossdead" ? 2200 : big ? 1400 : 800;
            const age = now - f.born;
            if (age > DUR) { list.splice(i, 1); continue; }
            if (age < 0) continue;                 // hit-stop: the burst starts after the freeze
            const t = age / DUR;
            const sx = ratio * f.x - px + cx, sy = ratio * f.y - py + cy;
            if (sx < -300 || sx > global.screenWidth + 300 || sy < -300 || sy > global.screenHeight + 300) continue;
            if (f.kind.startsWith("kit_")) {
                // kit use: a coloured pulse around the tank plus a few shards
                const id = f.kind.slice(4);
                // most kit items draw their own look (abilityFx.js, the AF packet)
                if (abilityFx.KIT_FX_IDS.has(id)) { list.splice(i, 1); continue; }
                const col = KIT_FX[id] || "#ffd76e";
                const DUR2 = 700;
                if (age > DUR2) { list.splice(i, 1); continue; }
                const t2 = age / DUR2;
                c.save();
                c.globalAlpha = (1 - t2) * 0.85;
                c.strokeStyle = col;
                c.lineWidth = Math.max(1.5, 5 * (1 - t2) * ratio);
                c.beginPath(); c.arc(sx, sy, (30 + 120 * t2) * ratio, 0, Math.PI * 2); c.stroke();
                if (id === "medkit") {
                    // a cross that rises and fades
                    c.globalAlpha = (1 - t2) * 0.9;
                    c.fillStyle = col;
                    const s3 = 14 * ratio, w3 = 5 * ratio, yy = sy - 40 * ratio - 40 * ratio * t2;
                    c.fillRect(sx - w3 / 2, yy - s3, w3, s3 * 2);
                    c.fillRect(sx - s3, yy - w3 / 2, s3 * 2, w3);
                } else if (id === "anchor" || id === "bulwark") {
                    c.globalAlpha = (1 - t2) * 0.6;
                    polyPath(c, sx, sy, (44 + 30 * t2) * ratio, 6, Math.PI / 6);
                    c.lineWidth = Math.max(1.5, 3 * ratio); c.stroke();
                } else {
                    c.fillStyle = col; c.strokeStyle = color.black; c.lineWidth = 1;
                    c.globalAlpha = Math.max(0, 1 - t2 * 1.1);
                    for (let k = 0; k < 8; k++) {
                        const a = (k / 8) * Math.PI * 2 + t2 * 0.8;
                        const dist = (26 + 70 * t2) * ratio;
                        gemPath(c, sx + Math.cos(a) * dist, sy + Math.sin(a) * dist - 20 * ratio * t2, Math.max(2, (6 - 3 * t2) * ratio));
                        c.fill(); c.stroke();
                    }
                }
                c.restore();
                continue;
            }
            if (f.kind === "bossdead") {
                if (!f.parts) buildBossBurst(f);
                const bcol = f.col || "#c9a8ff";
                const rgb = toRgb(bcol) || { r: 201, g: 168, b: 255 };
                const tint = rgb.r + "," + rgb.g + "," + rgb.b;
                const sw = global.screenWidth, shh = global.screenHeight;
                const eo = 1 - Math.pow(1 - t, 3);
                c.save();
                if (t < 0.18) { c.globalAlpha = (1 - t / 0.18) * 0.6; c.fillStyle = "#ffffff"; c.fillRect(0, 0, sw, shh); }
                if (t < 0.7 && !glowOff()) { c.globalAlpha = (1 - t / 0.7) * 0.5; c.drawImage(vignetteSprite(sw, shh, 0.35, tint), 0, 0, sw, shh); }
                if (!config.graphical.noGlow) {
                    const hr = (80 + 520 * eo) * ratio;
                    c.globalAlpha = Math.max(0, 1 - t * 1.4) * 0.9;
                    c.drawImage(haloSprite("bossdead|" + tint, tint, [[0, 1], [0.4, 0.55], [1, 0]]), sx - hr, sy - hr, hr * 2, hr * 2);
                }
                c.lineCap = "round";
                for (const r of f.rays) {
                    const len = (r.len0 + r.len * eo) * ratio;
                    c.globalAlpha = Math.max(0, 1 - t * 1.25) * r.a;
                    c.strokeStyle = "#ffffff";
                    c.lineWidth = Math.max(1, r.w * (1 - t) * ratio);
                    c.beginPath(); c.moveTo(sx + Math.cos(r.ang) * len * 0.15, sy + Math.sin(r.ang) * len * 0.15); c.lineTo(sx + Math.cos(r.ang) * len, sy + Math.sin(r.ang) * len); c.stroke();
                }
                for (let i = 0; i < 3; i++) {
                    const tt = (t - i * 0.09) / (1 - i * 0.09);
                    if (tt <= 0) continue;
                    const e2 = 1 - Math.pow(1 - tt, 3);
                    const Rw = (40 + (1100 - i * 260) * e2) * ratio;
                    c.globalAlpha = (1 - tt) * (i === 0 ? 0.9 : 0.55);
                    c.strokeStyle = i === 1 ? "#ffffff" : bcol;
                    c.lineWidth = Math.max(1.5, (14 - i * 3) * (1 - tt) * ratio);
                    c.beginPath(); c.arc(sx, sy, Rw, 0, Math.PI * 2); c.stroke();
                }
                const fadeA = t < 0.55 ? 1 : 1 - (t - 0.55) / 0.45;
                for (const sp of config.graphical.fewerEffects ? [] : f.sparks) {
                    const r2 = eo * sp.sp * 420 * ratio, r1 = r2 * 0.55;
                    c.globalAlpha = fadeA * 0.95;
                    c.strokeStyle = sp.white ? "#ffffff" : bcol;
                    c.lineWidth = Math.max(1, 3.5 * (1 - t * 0.6) * ratio);
                    c.beginPath(); c.moveTo(sx + Math.cos(sp.ang) * r1, sy + Math.sin(sp.ang) * r1); c.lineTo(sx + Math.cos(sp.ang) * r2, sy + Math.sin(sp.ang) * r2); c.stroke();
                }
                c.globalAlpha = fadeA;
                for (let pi = 0; pi < f.parts.length; pi += config.graphical.fewerEffects ? 3 : global.lowFx ? 2 : 1) {
                    const p = f.parts[pi];
                    const dist = eo * p.sp * 380 * ratio;
                    const gx = sx + Math.cos(p.ang) * dist, gy = sy + Math.sin(p.ang) * dist + 60 * ratio * t * t;
                    const s2 = p.size * ratio * (1 - t * 0.5);
                    c.save();
                    c.translate(gx, gy);
                    c.rotate(p.ang + p.spin * eo);
                    c.fillStyle = p.dark ? ROCK_CHIPS[p.shade] : bcol;
                    c.fillRect(-s2, -s2 * p.sq, s2 * 2, s2 * 2 * p.sq);
                    c.restore();
                }
                c.restore();
                continue;
            }
            const col = f.kind === "meteor" ? "#ff9a5a" : f.kind === "charge" ? "#ffe0a8" : f.kind === "bossdead" ? "#c9a8ff"
                : f.kind === "boss" ? "#c9a8ff" : "#ffd76e";
            const R = (big ? 40 + t * 420 : 16 + t * 170) * ratio;
            c.save();
            c.globalAlpha = (1 - t) * (big ? 0.7 : 0.6);
            c.strokeStyle = col;
            c.lineWidth = Math.max(1.5, (big ? 6 : 4) * (1 - t) * ratio);
            c.beginPath(); c.arc(sx, sy, R, 0, Math.PI * 2); c.stroke();
            if (f.kind === "meteor" || f.kind === "charge" || f.kind === "bossdead") {
                c.globalAlpha = (1 - t) * 0.25;
                c.fillStyle = col;
                c.beginPath(); c.arc(sx, sy, R * 0.55, 0, Math.PI * 2); c.fill();
            }
            c.restore();
        }
    }
    // ── tank knockouts ─────────────────────────────────────────────────
    // A wreck bursting in its own colour: a white core, two shock rings, hull
    // shards flung out on an ease-out and, for your own tank, some smoke.
    // Everything is a function of age, so there is no per-frame physics.
    function buildTankBurst(b) {
        let hex = null;
        try { hex = gameDraw.modifyColor(b.col); } catch (e) { hex = null; }
        if (!(typeof hex === "string" && hex[0] === "#")) hex = "#c8c8c8";
        b.shades = [hex, gameDraw.mixColors(hex, "#ffffff", 0.45), gameDraw.mixColors(hex, "#000000", 0.3), "#8d8d98", "#ffd75e"];
        const lite = !!config.graphical.fewerEffects;
        const n = fxFull() ? (b.self ? 34 : 16) : (b.self ? 22 : 10);
        b.parts = [];
        for (let i = 0; i < n; i++) {
            b.parts.push({
                ang: (i / n) * Math.PI * 2 + (Math.random() - 0.5) * 0.7,
                sp: 0.4 + Math.random() * 0.8,
                size: (b.self ? 7 : 4.5) + Math.random() * (b.self ? 8 : 5),
                spin: (Math.random() - 0.5) * 10,
                sq: 0.55 + Math.random() * 0.45,
                shade: Math.random() < 0.15 ? 3 : Math.random() < 0.3 ? 2 : Math.random() < 0.5 ? 1 : 0,
                tri: Math.random() < 0.4,
                gem: false,
            });
        }
        const gems = b.self && b.gems >= 10 ? Math.min(lite ? 6 : 12, 2 + Math.floor(b.gems / 80)) : 0;
        for (let i = 0; i < gems; i++) {
            b.parts.push({
                ang: Math.random() * Math.PI * 2,
                sp: 0.55 + Math.random() * 0.75,
                size: 5 + Math.random() * 4,
                spin: (Math.random() - 0.5) * 6,
                sq: 1,
                shade: 4,
                tri: false,
                gem: true,
            });
        }
        b.smoke = [];
        if (b.self) for (let i = 0; i < 7; i++) b.smoke.push({ ang: Math.random() * Math.PI * 2, d: 0.15 + Math.random() * 0.45, r: 0.6 + Math.random() * 0.6 });
        if (!b.self && !lite) {
            try {
                juiceBurst(b.x, b.y, fxFull() ? 8 : 5, b.shades[1], 150 + (b.size || 30) * 2, 520, 2, 4);
                juiceRing(b.x, b.y, "#ffffff", 8, 60 + (b.size || 30) * 2, 280, 5);
            } catch (e) { void e; }
        }
    }
    let wreckBlend = 1;
    const wreckRender = { status: { getFade: () => 1, getColor: () => "#FFFFFF", getBlend: () => wreckBlend, health: { get: () => 1 }, shield: { get: () => 1 } } };
    const WRECK_HULL_MS = 210;
    function drawWreckHull(c, b, sx, sy, ratio, eff) {
        if (!b.type || eff >= WRECK_HULL_MS) return;
        let pic = null, size = 0;
        try { pic = mockupPicture(b.type, b.colIdx); size = pic && pic.size; } catch (e) { pic = null; }
        if (!pic || !(size > 0)) return;
        const u = eff / WRECK_HULL_MS;
        wreckBlend = u < 0.3 ? 1 : Math.round((1 - 0.45 * (u - 0.3) / 0.7) * 20) / 20;
        const swell = 1 + 0.28 * u * u;
        c.save();
        try { drawEntity(pic.color, sx, sy, pic, ratio, 1 - u * u, (b.size / size) * swell, 1, b.facing || 0, false, c, false, wreckRender); } catch (e) { void e; }
        c.restore();
    }
    function drawTankBursts(px, py, ratio) {
        const list = global.tankBursts;
        if (!list || !list.length) return;
        const now = performance.now();
        const c = ctx[2];
        const cx = global.screenWidth / 2, cy = global.screenHeight / 2;
        const calm = deathCalm();
        const lite = !!config.graphical.fewerEffects;
        for (let i = list.length - 1; i >= 0; i--) {
            const b = list[i];
            const DUR = b.self ? 1150 : 750;
            const raw = now - b.born;
            const age = b.self ? deathText.introWarp(raw, calm) : raw;
            if (age > DUR) { list.splice(i, 1); continue; }
            if (raw < 0) continue;
            const sx = ratio * b.x - px + cx, sy = ratio * b.y - py + cy;
            if (sx < -400 || sx > global.screenWidth + 400 || sy < -400 || sy > global.screenHeight + 400) continue;
            if (!b.parts) buildTankBurst(b);
            const t = age / DUR, eo = 1 - Math.pow(1 - t, 3);
            const k = Math.max(0.75, Math.min(2.2, (b.size || 30) / 30)) * ratio;
            const reach = (b.self ? 250 : 140) * k;
            c.save();
            const glowT = b.self ? 0.6 : 0.4;
            if (t < glowT && !config.graphical.noGlow) {
                if (!b.koKey) {
                    const rgb = toRgb(b.shades[0]) || { r: 200, g: 200, b: 200 };
                    b.koTint = rgb.r + "," + rgb.g + "," + rgb.b;
                    b.koKey = "ko|" + b.koTint;
                }
                const hr = (b.self ? 70 + 220 * eo : 40 + 110 * eo) * k;
                c.globalAlpha = (1 - t / glowT) * (b.self ? 0.75 : 0.6);
                c.drawImage(haloSprite(b.koKey, b.koTint, [[0, 1], [0.45, 0.5], [1, 0]]), sx - hr, sy - hr, hr * 2, hr * 2);
            }
            if (!lite) {
                for (let si = 0; si < b.smoke.length; si++) {
                    const sm = b.smoke[si];
                    const d = sm.d * reach * eo;
                    c.globalAlpha = 0.3 * (1 - t);
                    c.fillStyle = "#1c1720";
                    c.beginPath(); c.arc(sx + Math.cos(sm.ang) * d, sy + Math.sin(sm.ang) * d, sm.r * (18 + 46 * eo) * k, 0, Math.PI * 2); c.fill();
                }
            }
            const pop0 = b.self && b.type ? 90 : 0;
            if (age >= pop0 && age < pop0 + 170) {
                const u = (age - pop0) / 170;
                c.globalAlpha = (1 - u) * 0.95;
                c.fillStyle = "#ffffff";
                c.beginPath(); c.arc(sx, sy, (b.self ? 36 : 22) * k * (0.7 + u), 0, Math.PI * 2); c.fill();
            }
            for (let r = 0; r < 2; r++) {
                const tt = (t - r * 0.1) / (1 - r * 0.1);
                if (tt <= 0) continue;
                const e2 = 1 - Math.pow(1 - tt, 3);
                c.globalAlpha = (1 - tt) * (r ? 0.5 : 0.85);
                c.strokeStyle = r ? "#ffffff" : b.shades[1];
                c.lineWidth = Math.max(1.5, (b.self ? 10 : 6) * (1 - tt) * k);
                c.beginPath(); c.arc(sx, sy, (14 + (b.self ? 230 : 120) * e2) * k * (1 - r * 0.25), 0, Math.PI * 2); c.stroke();
            }
            c.globalAlpha = t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4;
            c.strokeStyle = HUD.line;
            c.lineWidth = Math.max(1, 1.6 * k);
            c.lineJoin = "round";
            for (let pi = 0; pi < b.parts.length; pi += lite ? 2 : 1) {
                const p = b.parts[pi];
                const d = eo * p.sp * reach * (p.gem ? 1.15 : 1);
                const s2 = p.size * k * (1 - t * 0.45);
                c.save();
                c.translate(sx + Math.cos(p.ang) * d, sy + Math.sin(p.ang) * d);
                c.rotate(p.ang + p.spin * eo);
                c.fillStyle = b.shades[p.shade];
                c.beginPath();
                if (p.gem) { c.moveTo(0, -s2); c.lineTo(s2 * 0.72, 0); c.lineTo(0, s2); c.lineTo(-s2 * 0.72, 0); c.closePath(); }
                else if (p.tri) { c.moveTo(s2, 0); c.lineTo(-s2 * 0.8, s2 * p.sq); c.lineTo(-s2 * 0.8, -s2 * p.sq); c.closePath(); }
                else c.rect(-s2, -s2 * p.sq, s2 * 2, s2 * 2 * p.sq);
                c.fill(); c.stroke();
                c.restore();
            }
            c.restore();
            if (b.self) drawWreckHull(c, b, sx, sy, ratio, age);
        }
    }
    // ── minimap / big map extras ────────────────────────────────────────
    function drawRoyaleMapExtras(T, rx, ry, rw, rh, dotR) {
        const r = global.royale;
        const c = ctx[2];
        const inside = (x, y) => x > rx - 8 && x < rx + rw + 8 && y > ry - 8 && y < ry + rh + 8;
        const now = performance.now();
        const tnow = Date.now();
        const pulse = 1 + 0.18 * Math.sin(now / 240);
        // labels scale with the map: tiny on the minimap, readable on the big map
        const labelPx = Math.max(7, Math.min(12, dotR * 2.6));
        // labels never pile up (Oct 8: Core, Vault, boss and event names stacked
        // on one spot): one that would overlap a placed one, or a vault's own
        // name, is left out; earlier calls win
        const placed = [];
        for (const v of (global.vaults || [])) { const vx = T.X(v.x), vy = T.Y(v.y); placed.push({ x: vx - labelPx * 2, y: vy - labelPx * 2.6, w: labelPx * 4, h: labelPx * 1.6 }); }
        const mapLabel = (text, mx, my, above, col) => {
            const ly = my + (above ? -1 : 1) * (above ? labelPx * 0.6 + 2 : labelPx * 0.9 + 2);
            const w = text.length * labelPx * 0.62 + 4, h = labelPx + 3;
            const r0 = { x: mx - w / 2, y: ly - h / 2, w, h };
            for (const q of placed) if (r0.x < q.x + q.w && r0.x + r0.w > q.x && r0.y < q.y + q.h && r0.y + r0.h > q.y) return;
            placed.push(r0);
            drawText(text, mx, ly, labelPx, col, "center", true, 0.95, 4);
        };
        // duos: your partner, a dot in your colour with a ring and their name
        const dmate = r.duos && r.duo && r.duo.mate;
        if (dmate && dmate.alive && dmate.x != null) {
            const tp = trackPos("duomate", dmate.x, dmate.y, 0.8);
            const mx = T.X(tp.x), my = T.Y(tp.y);
            if (inside(mx, my)) {
                const mc = playerHexCol() || HUD.sky;
                c.save();
                c.beginPath(); c.arc(mx, my, dotR * 1.25, 0, Math.PI * 2);
                c.fillStyle = mc; c.strokeStyle = color.black; c.lineWidth = 1.6; c.fill(); c.stroke();
                c.globalAlpha = 0.85;
                c.strokeStyle = mc; c.lineWidth = 1.5;
                c.beginPath(); c.arc(mx, my, dotR * 2.4, 0, Math.PI * 2); c.stroke();
                c.restore();
                if (labelPx >= 8) mapLabel(shortName(dmate.name || "Teammate", 12), mx, my - dotR * 2.4, true, mc);
            }
        }
        for (const s of (global.shops || [])) {
            const mx = T.X(s.x), my = T.Y(s.y);
            if (!inside(mx, my)) continue;
            polyPath(c, mx, my, dotR * 1.5, 6, Math.PI / 6);
            c.fillStyle = "#12191f"; c.fill();
            c.lineWidth = 1.6; c.strokeStyle = SHOP_ACCENT; c.stroke();
            gemPath(c, mx, my, dotR * 0.7);
            c.fillStyle = color.gold; c.fill();
        }
        if (r.ao && r.ao.on) { try { const sc = (T.X(1000) - T.X(0)) / 1000; aoHud.drawMap(c, T.X, T.Y, sc); } catch (e) { } }
        if (r.bloom && r.bloom.until > tnow) {
            const mx = T.X(r.bloom.x), my = T.Y(r.bloom.y);
            if (inside(mx, my)) {
                const rr = Math.max(dotR * 2.4, (r.bloom.r || 340) * T.s);
                c.save();
                c.globalAlpha = 0.28;
                c.fillStyle = "#ffd76e";
                c.beginPath(); c.arc(mx, my, rr, 0, Math.PI * 2); c.fill();
                c.globalAlpha = 0.9;
                c.strokeStyle = "#ffd76e"; c.lineWidth = 2;
                c.beginPath(); c.arc(mx, my, rr * pulse, 0, Math.PI * 2); c.stroke();
                c.restore();
                mapLabel("ORE BLOOM", mx, my - rr, true, "#ffd76e");
            }
        }
        if (r.event && r.event.until > tnow) {
            const mx = T.X(r.event.x), my = T.Y(r.event.y);
            if (inside(mx, my)) {
                c.save();
                c.globalAlpha = 0.85;
                c.strokeStyle = r.event.kind === "meteor" ? "#ff9a5a" : "#7fb1f2";
                c.lineWidth = 2;
                c.setLineDash([4, 3]);
                const er = Math.max(dotR * 2.2, (r.event.r || 380) * T.s);
                c.beginPath(); c.arc(mx, my, er * pulse, 0, Math.PI * 2); c.stroke();
                c.restore();
                mapLabel(r.event.kind === "meteor" ? "METEORS" : "GEM RAIN", mx, my - er, true, r.event.kind === "meteor" ? "#ff9a5a" : "#7fb1f2");
            }
        }
        for (const ch of (r.chests || [])) {
            const mx = T.X(ch.x), my = T.Y(ch.y);
            if (!inside(mx, my)) continue;
            gemPath(c, mx, my, dotR * (ch.rare ? 1.2 : 0.95));
            c.fillStyle = ch.rare ? "#dc8cf8" : "#f0a060";
            c.strokeStyle = color.black; c.lineWidth = 1.2; c.fill(); c.stroke();
        }
        const scan = (r.you && r.you.scan) || null;
        if (scan && scan.length) {
            // Ore Scanner: the vein gem as before, ringed so it reads as "found"
            for (const o of scan) {
                const mx = T.X(o.x), my = T.Y(o.y);
                if (!inside(mx, my)) continue;
                const colS = o.o === 4 ? "#6ff5a8" : "#d98af0";
                c.save();
                c.globalAlpha = 0.85;
                c.strokeStyle = colS; c.lineWidth = 1.2;
                c.beginPath(); c.arc(mx, my, dotR * 1.9, 0, Math.PI * 2); c.stroke();
                c.restore();
                gemPath(c, mx, my, dotR * 0.9);
                c.fillStyle = colS; c.strokeStyle = color.black; c.lineWidth = 1; c.fill(); c.stroke();
            }
        }
        // round 12: the runaway leader's spot, pinged every 30 s (a fixed
        // point where they were, not a live track), for everyone but them
        const lp = r.lping;
        if (lp && lp.id !== gui.playerid) {
            const mx = T.X(lp.x), my = T.Y(lp.y);
            if (inside(mx, my)) {
                const k = Math.max(0, Math.min(1, (lp.ms | 0) / 6000));
                c.save();
                c.globalAlpha = 0.35 + 0.65 * k;
                c.strokeStyle = HUD.gold; c.lineWidth = 2.2;
                c.beginPath(); c.arc(mx, my, dotR * (2.4 + 3.2 * (1 - pulse * 0.5)), 0, Math.PI * 2); c.stroke();
                c.fillStyle = HUD.gold; c.strokeStyle = color.black; c.lineWidth = 1.5;
                c.beginPath(); c.arc(mx, my, dotR * 1.5, 0, Math.PI * 2); c.fill(); c.stroke();
                c.restore();
                drawText("#1", mx, my - dotR * 4.2, 9, HUD.gold, "center", true);
            }
        }
        for (const p of (r.pings || [])) {
            if (p.id === gui.playerid) continue;
            const tp = trackPos("ping" + p.id, p.x, p.y, 0.6);
            const mx = T.X(tp.x), my = T.Y(tp.y);
            if (!inside(mx, my)) continue;
            c.save();
            c.translate(mx, my);
            c.fillStyle = "#ffb347"; c.strokeStyle = color.black; c.lineWidth = 2; c.lineJoin = "round";
            const s2 = dotR * 2.6;
            c.beginPath(); c.moveTo(0, -s2); c.lineTo(s2, s2 * 0.8); c.lineTo(-s2, s2 * 0.8); c.closePath();
            c.fill(); c.stroke();
            c.restore();
            if (p.streak) drawText("x" + p.streak, mx, my - dotR * 3.8, 9, "#ffb347", "center", true);
            c.save();
            c.globalAlpha = 0.8;
            c.strokeStyle = "#ffb347"; c.lineWidth = 2;
            c.beginPath(); c.arc(mx, my, dotR * 3.8 * pulse, 0, Math.PI * 2); c.stroke();
            c.restore();
        }
        if (r.boss) {
            const bp = trackPos("boss", r.boss.x, r.boss.y, 0.6);
            const mx = T.X(bp.x), my = T.Y(bp.y);
            if (inside(mx, my)) {
                const col = r.boss.c || "#c9a8ff";
                polyPath(c, mx, my, dotR * 2.1, 8, Math.PI / 8);
                c.fillStyle = col; c.strokeStyle = color.black; c.lineWidth = 1.8; c.fill(); c.stroke();
                c.save();
                c.globalAlpha = 0.85;
                c.strokeStyle = col; c.lineWidth = 2;
                c.beginPath(); c.arc(mx, my, dotR * 3.4 * pulse, 0, Math.PI * 2); c.stroke();
                c.restore();
                mapLabel(String(r.boss.name || "BOSS").toUpperCase(), mx, my + dotR * 3.4, false, col);
            }
        }
        raidHeat.drawMap(c, T, inside, dotR, pulse, mapLabel, trackPos);
        try { crowns.drawMap(c, T, inside, dotR, pulse); } catch (e) { /* */ }
    }
    // ── spawn shield ──────────────────────────────────────────────────────
    // The server holds the shield for 4 s, then drops it on the first move
    // or shot.
    const SHIELD_GRACE_MS = 5000;
    const WIND_SHIELD_MS = 10000;   // shop.js WIND_SHIELD_MS
    const SHIELD_CAP_MS = 25000;
    let shieldOnPrev = false;
    // VU 2 (socketinit) marks the post-bank vault shield, labelled apart from the
    const VAULT_SHIELD_MS = 3000;   // vault.js POST_BANK_SHIELD_MS
    function vaultShieldNow() {
        const at = global.vaultShieldAt || 0;
        return at > (global.spawnedAt || 0) && performance.now() - at < VAULT_SHIELD_MS + 1500;
    }
    function drawSpawnShield(c, x, y, R, invuln) {
        const on = !!invuln;
        if (shieldOnPrev && !on && (vaultShieldNow() || (global.spawnedAt && performance.now() - global.spawnedAt < 120000))) {
            try { global.createMessage(vaultShieldNow() ? "Your vault shield is gone, so you can be hit now." : "Your shield is gone, so you can be hit now.", 3000); } catch { /* */ }
        }
        shieldOnPrev = on;
        if (!on) return;
        const vs = vaultShieldNow();
        global.shieldSeen = true;
        const now = performance.now();
        const pulse = 0.5 + 0.5 * Math.sin(now / 180);
        c.save();
        c.globalAlpha = 0.18 + 0.1 * pulse;
        // the vault shield is gold, the spawn shield cyan
        c.fillStyle = vs ? "#ffd166" : "#7fe3ff";
        c.beginPath(); c.arc(x, y, R * 1.55, 0, Math.PI * 2); c.fill();
        c.globalAlpha = 0.75;
        c.lineWidth = Math.max(2, R * 0.09);
        c.strokeStyle = vs ? "#ffe9a8" : "#bff2ff";
        c.setLineDash([R * 0.35, R * 0.22]);
        c.lineDashOffset = -now / 40;
        c.beginPath(); c.arc(x, y, R * 1.55, 0, Math.PI * 2); c.stroke();
        c.restore();
    }
    // The shield's status line is a note-stack row under the clock (Oct 6:
    // under the tank it printed over chest and crate labels)
    function spawnShieldNote() {
        if (global.died || !global.shieldSeen || !shieldOnPrev || raidFinale.active()) return null;
        if (vaultShieldNow()) {
            const vl = Math.max(1, Math.ceil((VAULT_SHIELD_MS - (performance.now() - global.vaultShieldAt)) / 1000));
            return hudNote(1, "shield", "Vault shield: safe for " + vl + "s, but shooting drops it", "#ffe9a8");
        }
        const since = performance.now() - (global.spawnedAt || 0);
        const capLeft = Math.ceil((SHIELD_CAP_MS - since) / 1000);
        if (capLeft > 0 && capLeft <= 10) return hudNote(1, "shield", "Spawn shield: ends in " + capLeft + "s, sooner if you move or shoot", capLeft <= 3 ? "#ffd166" : "#bff2ff");
        if (global.coachRect && since > 4000) return null;
        const left = Math.ceil((SHIELD_GRACE_MS - since) / 1000);
        // Second Wind (shop gear): moving keeps the shield up to 10 s
        const wu = global.shop && global.shop.state && global.shop.state.gearUntil && global.shop.state.gearUntil.wind;
        const windLeft = wu === true || +wu > Date.now() ? Math.ceil((WIND_SHIELD_MS - since) / 1000) : 0;
        const line = windLeft > 0
            ? (left > 0 ? "Spawn shield: safe for " + left + "s, then shooting drops it" : "Spawn shield: holds while you move for " + windLeft + "s, but shooting drops it")
            : left > 0
            ? "Spawn shield: safe for " + left + "s, then moving or shooting drops it"
            : "Spawn shield: moving or shooting drops it";
        if (since < 4000) global.hudCardUp = "shield";
        return hudNote(1, "shield", line, "#bff2ff");
    }

    // ── raid over: raidFinale.js owns the whole sequence ──────────────────
    function drawRaidEndFx() {
        raidFinale.draw();
    }

    function drawRaidResults() {
        const r = global.royale;
        if (!royaleActive() || !r.results || !r.results.top || raidFinale.active()) return;
        const c = ctx[2];
        const cx = global.screenWidth / 2, cy = global.screenHeight * 0.34;
        const rows = r.results.top.slice(0, 10);
        const PW = Math.min(420, global.screenWidth - 40);
        const PH = 64 + rows.length * 22;
        const px = cx - PW / 2, py = cy - PH / 2;
        hudPanel(c, px, py, PW, PH, { fill: HUD.solid, r: HUD.rBig });
        hudTitle(r.duos ? "Raid over! The top 10 teams get paid." : "Raid over! The top 10 get paid.", cx, py + 24, 19, HUD.gold, "center");
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            drawText("#" + (i + 1) + " " + (row.name || "Unnamed") + "  " + util.formatLargeNumber(row.score | 0),
                cx, py + 52 + i * 22, 13, color.guiwhite, "center");
        }
    }

    // Full-screen victory/defeat banner while the war round is being decided.
    function drawWarBanner() {
        if (royaleActive() && global.royale.results) {
            global.hudCardUp = "results";
            drawRaidResults();
            return;
        }
        const w = global.war;
        if (!w || !w.over || !config.game.warBar || global.died) return;
        const now = performance.now();
        const since = Math.max(0, now - (w.victoryAt || now));
        const fade = Math.min(1, since / 450);
        const isBlue = w.winner === 1;
        const name = isBlue ? "BLUE" : "RED";
        const col = isBlue ? color.blue : color.red;
        const c = ctx[2];
        const cx = global.screenWidth / 2, cy = global.screenHeight * 0.30;
        c.save();
        c.globalAlpha = fade;
        // soft team-coloured wash over the whole screen
        c.fillStyle = isBlue ? "rgba(30,70,170,0.20)" : "rgba(170,35,30,0.20)";
        c.fillRect(0, 0, global.screenWidth, global.screenHeight);
        // banner panel
        const bw = Math.min(580, global.screenWidth - 60);
        const bx = cx - bw / 2;
        hudPanel(c, bx, cy - 46, bw, 92, { fill: HUD.solid, r: HUD.rBig });
        hudTitle(name.charAt(0) + name.slice(1).toLowerCase() + " team wins the war", cx, cy - 14, 32, col, "center");
        const secs = Math.max(0, Math.ceil((w.resetIn || 0) / 1000));
        drawText("+" + util.formatLargeNumber(w.bonus || 0) + " gems for every " + name.toLowerCase() +
                 " miner. New war in " + secs + "s", cx, cy + 26, 15, color.guiwhite, "center");
        c.restore();
    }

    // Raid Night (shared/events.js, window.DWEvents): the chip text under
    // the raid clock and two centred callouts, at T-10 min and at the start.
    // Worked out once a second; the frame only reads the cached strings.
    const evHud = { at: 0, chip: "", soonFor: "", liveFor: "", callAt: 0, title: "", sub: "", w: 0, toastFloor: 0 };
    const EV_CALL_MS = 5200;
    function eventHudTick() {
        const E = window.DWEvents;
        const t = Date.now();
        if (t - evHud.at < 1000) return evHud;
        evHud.at = t;
        // the DOM notification cards under the clock (gameToasts.js), in HUD
        // units: the centre lanes start below them
        evHud.toastFloor = 0;
        const st = document.getElementById("dwGameToasts");
        if (st && st.childElementCount) evHud.toastFloor = st.getBoundingClientRect().bottom * global.screenWidth / Math.max(1, window.innerWidth);
        if (!E) return evHud;
        const now = E.now(), c = E.current(now);
        // in a raid the countdown only shows in the last hour (the menu card has the rest)
        evHud.chip = c && !c.live && c.ms <= Math.min(E.HUD_LEAD_MS, 3600000) ? c.ev.name + " in " + E.countdown(c.ms) : "";
        // callouts wait for a free screen: not dead, not the raid-end finale
        if (!c || global.died || raidFinale.active()) return evHud;
        const id = c.ev.id;
        if (!c.live && c.ms <= E.SOON_MS && c.ms > 60000 && evHud.soonFor !== id) {
            evHud.soonFor = id;
            const m = Math.round(c.ms / 60000);
            showEventCallout(c.ev.name + " in " + m + (m === 1 ? " minute" : " minutes"), c.ev.blurb || "");
        } else if (c.live && now - c.ev.startMs < 120000 && evHud.liveFor !== id) {
            evHud.liveFor = evHud.soonFor = id;
            showEventCallout(c.ev.name + " starts now!", "Everyone's in.");
        }
        return evHud;
    }
    function showEventCallout(title, sub) {
        evHud.title = title;
        evHud.sub = sub;
        evHud.w = 0;   // measured on the first frame it draws
        evHud.callAt = performance.now();
        try { gameSound.dustBank(); } catch (e) { /* */ }
    }
    const evPanelOpts = { alpha: 1, r: 13, fill: "rgba(0,0,0,0.55)" };
    function drawEventCallout() {
        if (!evHud.callAt) return;
        const age = performance.now() - evHud.callAt;
        if (age > EV_CALL_MS) { evHud.callAt = 0; return; }
        if (global.died || global.tutorialMode || raidFinale.hidesHud() || !royaleActive() || global.hudCalm || !nxShows("raidNight")) return;
        // one plate at a time: a kill callout up (or a slam over the lane) holds it
        const nowE = performance.now();
        if (global.hudCalloutUp || plateWaitAt) { evHud.callAt += nowE - (evHud.waitAt || nowE); evHud.waitAt = nowE; return; }
        evHud.waitAt = 0;
        const c = ctx[2];
        // touch: the HUD is scaled up, so a smaller plate keeps it clear of the
        // message stack on the right
        // Oct 8: a compact plate in the top lane, the middle stays clear
        const TS = global.mobile ? 15 : 18, SS = global.mobile ? 10.5 : 11.5, PH = global.mobile ? 42 : 48;
        if (!evHud.w) evHud.w = Math.max(hudTitleW(evHud.title, TS), evHud.sub ? hudTextW(evHud.sub, SS) : 0) + (global.mobile ? 44 : 64);
        const inT = Math.min(1, age / 260), outT = Math.min(1, (EV_CALL_MS - age) / 600);
        const a = inT * inT * (3 - 2 * inT) * outT;
        const pop = 0.94 + 0.06 * (1 - Math.pow(1 - inT, 3));
        const w = Math.min(global.screenWidth - 40, evHud.w) * pop, h = (evHud.sub ? PH : PH - 26) * pop;
        // centred, unless that would run into the right-hand message stack
        const cx = Math.max(global.screenWidth * 0.2 + w / 2, Math.min(global.screenWidth / 2, messageStackLeft - 10 - w / 2));
        // under the clock stack, the first-raid guide and any notification cards
        let top = hudTopBottom | 0;
        const cr = global.coachRect;
        if (cr && cr.y < global.screenHeight * 0.4) top = Math.max(top, cr.y + cr.h);   // touch puts it at the bottom
        top = Math.max(top, evHud.toastFloor);
        // never lower than just above the tank, which sits at mid screen
        const cy = Math.round(Math.min(global.screenHeight * 0.42 - h / 2, Math.max(lanes.top || 0, top) + 8 + h / 2));
        evPanelOpts.alpha = a;
        global.hudCardUp = "event";
        hudPanel(c, cx - w / 2, cy - h / 2, w, h, evPanelOpts);
        // the words stay put while the plate pops (one font size, cached widths)
        hudTitle(evHud.title, cx, cy - (evHud.sub ? TS * 0.45 : 0), TS, HUD.gold, "center", a);
        if (evHud.sub) drawText(evHud.sub, cx, cy + SS * 1.05, SS, color.guiwhite, "center", true, a);
    }

    // Banked-gem rungs: a short gold pop (label, number, bonus).
    function drawMilestones() {
        const list = global.milestones;
        if (!list || !list.length) return;
        const now = performance.now();
        const c = ctx[2];
        const cx = global.screenWidth / 2;
        const cy = Math.max(global.screenHeight * 0.2, (messageStackBottom || 24) + 78);
        const DUR = 3800;

        for (let k = list.length - 1; k >= 0; k--) {
            const t = list[k];
            const age = now - t.born;
            if (age > DUR) { list.splice(k, 1); continue; }
            if (age < 0) continue;

            const inT = Math.min(1, age / 220);
            const outT = age > DUR - 700 ? 1 - (age - (DUR - 700)) / 700 : 1;
            const a = (inT < 1 ? inT * inT * (3 - 2 * inT) : 1) * Math.max(0, outT * outT);
            const pop = inT < 1
                ? (inT < 0.45 ? 0.15 + 1.45 * (1 - Math.pow(1 - inT / 0.45, 3)) : 1.6 - 0.6 * ((inT - 0.45) / 0.55))
                : 1;

            c.save();
            c.globalAlpha = a * 0.55;
            const myCol = playerHexCol() || color.gold;
            const pw = 280 * pop, ph = 118 * pop;
            c.restore();
            hudPanel(c, cx - pw / 2, cy - ph / 2 - 8, pw, ph, { alpha: a * 0.9, r: HUD.rBig * pop });

            c.save();
            c.strokeStyle = myCol;
            c.lineCap = "round";
            for (let r = 0; r < 3; r++) {
                const ring = (40 + r * 22) + Math.min(120, age * (0.14 - r * 0.03));
                c.globalAlpha = a * (0.62 - r * 0.16) * Math.max(0, 1 - age / 1100);
                c.lineWidth = 3 - r * 0.6;
                c.beginPath();
                c.arc(cx, cy, ring * pop, 0, Math.PI * 2);
                c.stroke();
            }
            c.restore();

            c.save();
            c.globalAlpha = a;
            const titleSize = 42 * pop;
            const bonusSize = 26 * pop;
            hudTitle("Banked", cx, cy - 38 * pop, 16, myCol, "center");
            hudTitle(t.title, cx, cy + 2, titleSize, HUD.head, "center");
            if (t.bonus) {
                hudTitle(t.bonus, cx, cy + 42 * pop, bonusSize, myCol, "center");
            }
            c.restore();
            break;
        }
    }

    function drawHitTicks(c, ox, oy, ratio, age, tint, alpha) {
        if (age < 0 || age >= HIT_TICK_MS || !(alpha > 0)) return;
        const ht = age / HIT_TICK_MS;
        const ha = (1 - ht) * (1 - ht) * alpha;
        const spread = (5 + 12 * ht) * ratio;
        c.save();
        c.globalAlpha = ha;
        c.strokeStyle = tint;
        c.lineWidth = Math.max(1.5, 1.8 * ratio);
        c.lineCap = "round";
        for (let k = 0; k < 4; k++) {
            const ang = Math.PI / 4 + k * Math.PI / 2;
            const ca = Math.cos(ang), sa = Math.sin(ang);
            c.beginPath();
            c.moveTo(ox + ca * spread * 0.45, oy + sa * spread * 0.45);
            c.lineTo(ox + ca * spread, oy + sa * spread);
            c.stroke();
        }
        c.restore();
    }

    // Floating damage numbers, world-anchored. A combo holds at full strength
    // until a second of silence, then fades. Words differ for you vs others.
    const dmgById = new Map();
    function drawDamageNumbers(px, py, ratio) {
        const list = global.damageNumbers;
        if (!list || !list.length) return;
        if (!config.game.damageNumbers) { list.length = 0; return; }
        const now = performance.now();
        const c = ctx[2];
        const halfW = global.screenWidth / 2,
              halfH = global.screenHeight / 2;
        const ROCK_ORE_TINT = ["#F2F0EA", "#E9A766", "#7FB1F2", "#D98AF0", "#6FF5A8"];
        // one pass over the entities, not one search per number
        const byId = dmgById; byId.clear();
        for (const e of global.entities) byId.set(e.id, e);
        c.save();
        for (let i = list.length - 1; i >= 0; i--) {
            const d = list[i];
            const live = d.kind === "rock" ? null : byId.get(d.id);
            if (live) { d.x = live.x; d.y = live.y; }
            const age = now - d.born;
            const idle = now - (d.comboAt || d.born);
            const hold = (d.holdMs ?? DMG_COMBO_HOLD_MS) * (fxFull() ? 1 : 0.75);
            const fadeOut = d.fadeMs ?? DMG_FADE_OUT_MS;
            if (idle >= hold + fadeOut) { list.splice(i, 1); continue; }

            let fade;
            if (age < DMG_FADE_IN_MS) {
                const u = age / DMG_FADE_IN_MS;
                fade = u * u * (3 - 2 * u);
            } else if (idle < hold) {
                fade = 1;
            } else {
                const u = Math.min(1, (idle - hold) / fadeOut);
                fade = (1 - u) * (1 - u);
            }

            let pop;
            if (age < DMG_POP_MS) {
                const u = age / DMG_POP_MS;
                if (u < 0.48) {
                    const k = u / 0.48;
                    pop = 0.18 + 1.22 * (1 - (1 - k) * (1 - k) * (1 - k));
                } else {
                    const k = (u - 0.48) / 0.52;
                    pop = 1.4 - 0.4 * (k * k * (3 - 2 * k));
                }
            } else {
                pop = 1;
            }
            if (idle >= hold) {
                const u = (idle - hold) / fadeOut;
                pop *= 1 - 0.14 * u;
            }
            if (d.punch) {
                const pt = (now - d.punch) / 150;
                if (pt < 1) pop *= 1 + 0.22 * (1 - pt) * (1 - pt);
            }

            const riseT = Math.min(1, age / 800);
            const rise = DMG_RISE * (1 - Math.pow(1 - riseT, 2.2));
            const x = ratio * d.x - px + halfW + d.jitter * 6 * ratio;
            const y = ratio * d.y - py + halfH - (24 + rise) * ratio;
            if (x < -80 || x > global.screenWidth + 80) continue;
            if (y < -80 || y > global.screenHeight + 80) continue;

            const rock = d.kind === "rock";
            const tier = d.tier || 0;
            const combo = d.combo || 1;
            const finish = d.word === "Finish";
            const base = (rock
                ? (12.5 + Math.min(6, d.amount * 0.08)) * ratio
                : (15.5 + Math.min(8, d.amount * 0.1) + (tier >= 2 ? 3.5 : tier >= 1 ? 1.5 : 0) + (finish ? 3 : 0) + Math.min(3, combo * 0.25)) * ratio) * (fxFull() ? 1 : 0.86);
            const size = base * pop;
            const tint = d.col ? d.col : rock
                ? (ROCK_ORE_TINT[d.ore | 0] || ROCK_ORE_TINT[0])
                : d.self
                    ? "#FF5A52"
                    : (finish || tier >= 2 ? "#FFB020" : tier >= 1 ? "#FFD24A" : "#FFF4C4");

            if (!rock && !d.self && age < HIT_TICK_MS) {
                drawHitTicks(c, ratio * d.x - px + halfW, ratio * d.y - py + halfH, ratio, age, tint, fade);
            }

            c.globalAlpha = fade;
            if (d.word) {
                drawTextScaled(d.word, x, y - size * 0.92, base * 0.44, pop, tint, true, 6);
            }
            const num = d._numFor === d.amount ? d._num : (d._numFor = d.amount, d._num = "-" + util.formatLargeNumber(Math.round(d.amount)));
            drawTextScaled(num, x, y, base, pop, tint, true, 5.5);
            if (!rock && combo >= 2) {
                drawTextScaled("×" + combo, x, y + size * 0.78, base * 0.36, pop, tint, true, 6);
            }
            c.globalAlpha = 1;
        }
        c.restore();
    }

    // Fallback skull if the svg hasn't loaded yet.
    function drawKillSkull(c, x, y, s) {
        const sw = Math.max(1.4, s * 0.09);
        c.save();
        c.translate(x, y);
        c.lineJoin = "round";
        c.lineCap = "round";
        c.fillStyle = color.guiwhite;
        c.strokeStyle = color.black;
        c.lineWidth = sw;

        const cr = s * 0.42;
        const cc = -s * 0.12;
        const a0 = Math.PI * 0.22;
        const a1 = Math.PI - a0;
        const tx = Math.cos(a0) * cr;
        const ty = cc + Math.sin(a0) * cr;
        const jx = tx * 0.82;
        const jb = s * 0.38;
        const jr = s * 0.10;

        c.beginPath();
        c.arc(0, cc, cr, a0, a1, true);
        c.lineTo(-jx, jb - jr);
        c.quadraticCurveTo(-jx, jb, -jx + jr, jb);
        c.lineTo(jx - jr, jb);
        c.quadraticCurveTo(jx, jb, jx, jb - jr);
        c.lineTo(tx, ty);
        c.closePath();
        c.fill();
        c.stroke();

        c.fillStyle = color.black;
        const er = s * 0.10;
        c.beginPath();
        c.arc(-s * 0.14, cc - s * 0.01, er, 0, Math.PI * 2);
        c.fill();
        c.beginPath();
        c.arc(s * 0.14, cc - s * 0.01, er, 0, Math.PI * 2);
        c.fill();

        c.beginPath();
        c.moveTo(0, s * 0.04);
        c.lineTo(-s * 0.05, s * 0.15);
        c.lineTo(s * 0.05, s * 0.15);
        c.closePath();
        c.fill();

        c.lineWidth = sw * 0.8;
        const t0 = s * 0.22, t1 = jb - sw * 0.35;
        c.beginPath();
        c.moveTo(-s * 0.09, t0); c.lineTo(-s * 0.09, t1);
        c.moveTo(0, t0); c.lineTo(0, t1);
        c.moveTo(s * 0.09, t0); c.lineTo(s * 0.09, t1);
        c.stroke();
        c.restore();
    }
    function drawKillBanners(px, py, ratio) {
        const list = global.killBanners;
        if (!list || !list.length) return;
        const now = performance.now();
        const c = ctx[2];
        const halfW = global.screenWidth / 2, halfH = global.screenHeight / 2;
        const HOLD = 1600, FADE = 900, DUR = HOLD + FADE;
        for (let i = list.length - 1; i >= 0; i--) {
            const d = list[i];
            const age = now - d.born;
            if (age >= DUR) { list.splice(i, 1); continue; }
            let fade = 1;
            if (age < 140) {
                const u = age / 140;
                fade = u * u * (3 - 2 * u);
            } else if (age > HOLD) {
                const u = (age - HOLD) / FADE;
                fade = (1 - u) * (1 - u);
            }
            const pop = age < 280
                ? (age < 90 ? 0.2 + 1.45 * (age / 90) : 1.65 - 0.65 * ((age - 90) / 190))
                : 1;
            let x = ratio * d.x - px + halfW;
            let y = ratio * d.y - py + halfH;
            x = Math.max(56, Math.min(global.screenWidth - 56, x));
            y = Math.max(56, Math.min(global.screenHeight - 70, y));

            // Your kill banner wears your body color.
            const myCol = playerHexCol() || color.guiwhite;
            c.save();
            c.strokeStyle = myCol;
            c.lineCap = "round";
            for (let r = 0; r < 2; r++) {
                c.globalAlpha = fade * (0.7 - r * 0.28) * Math.max(0, 1 - age / 1100);
                c.lineWidth = (2.6 - r * 0.7) * ratio;
                c.beginPath();
                c.arc(x, y, ((16 + r * 14) + age * (0.08 - r * 0.02)) * ratio * pop, 0, Math.PI * 2);
                c.stroke();
            }
            c.restore();

            const skullS = 36 * pop * ratio;
            c.save();
            c.globalAlpha = fade;
            if (killSkullImg.complete && killSkullImg.naturalWidth) {
                c.drawImage(killSkullImg, x - skullS / 2, y - skullS * 0.68, skullS, skullS);
            } else {
                drawKillSkull(c, x, y - 12 * pop * ratio, 22 * pop * ratio);
            }
            drawText("DEAD", x, y + 28 * pop * ratio, 17 * pop * ratio, myCol, "center", true, 1, 5.5);
            c.restore();
        }
    }

    // Red edge vignette as your health drops, smoothed toward the target so
    // chip damage doesn't strobe. Intensity and reach both climb as health
    // falls; a separate short slam marks each hit, even at full hp.
    let lowHpLevel = 0;
    function drawLowHealthVignette() {
        let target = 0;
        if (config.game.lowHealthVignette && !global.died && global.gameStart) {
            const me = global.entities.find(e => e.id === gui.playerid);
            if (me && me.health < LOW_HP_START) {
                const k = (LOW_HP_START - me.health) / (LOW_HP_START - LOW_HP_FULL);
                target = Math.max(0, Math.min(1, k));
            }
        }
        lowHpLevel += (target - lowHpLevel) * 0.07;

        const now = performance.now();
        const hurtAge = now - (global.hurtAt || -1e9);
        const hurt = hurtAge < 240 ? (1 - hurtAge / 240) * (global.hurtPower || 0.5) : 0;
        const deadAge = now - (global.deadFlashAt || -1e9);
        const dead = deadAge < 320 ? 1 - deadAge / 320 : 0;
        const celeAge = now - (global.celebrateAt || -1e9);
        const cele = celeAge < 420 ? 1 - celeAge / 420 : 0;
        const koAge = now - (global.selfDeathAt || -1e9);
        const ko = koAge >= 0 && koAge < 1100 ? 1 - koAge / 1100 : 0;

        if (lowHpLevel < 0.004 && hurt < 0.01 && dead < 0.01 && cele < 0.01 && ko < 0.01) return;
        // "No Glow" keeps the knockout blink but drops the edge tints
        const tints = !config.graphical.noGlow;

        const c = ctx[2];
        const w = global.screenWidth, h = global.screenHeight;
        const r = Math.hypot(w, h) / 2;

        if (tints && lowHpLevel >= 0.004) {
            // heartbeat: ~1.1s at the threshold tightening to ~0.42s near death.
            const period = 1100 - 680 * lowHpLevel;
            const pulse = 0.5 + 0.5 * Math.sin(now / (period / (2 * Math.PI)));
            const peak = (0.07 + 0.40 * lowHpLevel) * (0.84 + 0.16 * pulse);
            const inner = 0.78 - 0.30 * lowHpLevel;
            c.save();
            c.globalAlpha = peak;
            c.drawImage(vignetteSprite(w, h, inner, "170,16,16"), 0, 0, w, h);
            c.restore();
        }

        if (tints && hurt > 0.01) {
            c.save();
            c.globalAlpha = 0.34 * hurt;
            c.drawImage(vignetteSprite(w, h, 0.52, "210,28,28"), 0, 0, w, h);
            c.restore();
        }
        if (tints && cele > 0.01) {
            c.save();
            c.globalAlpha = 0.34 * cele;
            c.drawImage(vignetteSprite(w, h, 0.5, "239,199,75"), 0, 0, w, h);
            c.restore();
        }
        if (tints && dead > 0.01) {
            c.save();
            c.globalAlpha = 0.28 * dead;
            c.drawImage(vignetteSprite(w, h, 0.58, "255,255,255"), 0, 0, w, h);
            c.restore();
        }
        if (ko > 0.01) {
            // your own knockout: a blink of white (skipped under reduced motion), then red closing in
            c.save();
            if (koAge < 110 && !(global.reducedMotion && global.reducedMotion())) {
                c.globalAlpha = 0.4 * (1 - koAge / 110);
                c.fillStyle = "#ffffff";
                c.fillRect(0, 0, w, h);
            }
            c.globalAlpha = 0.7 * ko;
            if (tints) c.drawImage(vignetteSprite(w, h, 0.4, "190,18,18"), 0, 0, w, h);
            c.restore();
        }
    }

    // Satchel danger vignette: rises continuously from gameSound.tensionStart,
    // gold while rich, shifting to red near the cap. The throb is driven by
    // gameSound.satchelPulse() so it beats in sync with the audible heartbeat.
    function drawSatchelDanger() {
        const g = global.gems;
        if (!config.game.satchelWarning) return;
        if (!g || !(g.cap > 0) || global.died) return;
        const load = Math.min(1, (g.carried || 0) / g.cap);
        const start = gameSound.tensionStart != null ? gameSound.tensionStart : 0.30;
        const t = (load - start) / (1 - start);
        if (t <= 0) return;
        const full = load >= 1;

        // beat shape: a sharp spike that decays (a sine reads as breathing)
        const ph = gameSound.satchelPulse
            ? gameSound.satchelPulse()
            : (performance.now() % 800) / 800;
        const beat = Math.pow(1 - ph, 3);

        const c = ctx[2];
        const w = global.screenWidth, h = global.screenHeight;
        const r = Math.hypot(w, h) / 2;
        // gold at the low end, red near the cap
        const mix  = Math.min(1, Math.max(0, (load - 0.6) / 0.4));
        const cr = Math.round(212 + 23 * mix),
              cg = Math.round(163 - 99 * mix),
              cb = Math.round(58  - 6  * mix);
        const rgb = cr + "," + cg + "," + cb;
        // steady floor plus the beat on top
        const a = (0.035 + 0.10 * t) + (0.03 + 0.13 * t) * beat;
        // the vignette closes in as the load grows
        const inner = 0.80 - 0.20 * t - 0.03 * beat;
        if (glowOff()) return;
        c.save();
        c.globalAlpha = a;
        c.drawImage(vignetteSprite(w, h, inner, rgb), 0, 0, w, h);
        c.restore();

        // (full: "Your satchel is full. Go bank it." is a note-stack line now, drawHudNotes)
    }

    function handleSpeedMonitor() {
        if ((100 * gui.fps) < 100) global.serverStats.lag_color = color.orange; else global.serverStats.lag_color = color.guiwhite;
        if (global.metrics.rendertime < 10) global.metrics.rendertime_color = color.orange; else global.metrics.rendertime_color = color.guiwhite;
        if (global.serverStats.mspt > 28.0) {
            global.serverStats.mspt_color = color.red;
        } else if (global.serverStats.mspt > 20.0) {
            global.serverStats.mspt_color = color.orange;
        } else global.serverStats.mspt_color = color.guiwhite;
    }
    const xc = { cc: 0, dc: 0 };
    // ═══ Dig Wars world map (Fortnite-style, pure vector) ═══════════════

    function myTeamColor() {
        try {
            const c = gameDraw.modifyColor
                ? gameDraw.modifyColor(gui.color)
                : gameDraw.getColor(gui.color);
            if (typeof c === "string" && c.length) return c;
        } catch (e) {  }
        try {
            const c = gameDraw.getColor(gui.color);
            if (typeof c === "string" && c.length) return c;
        } catch (e) {  }
        return "#00b2e1";
    }

    let mapPaths = null, mapChunks = null;
    const MAP_PATHS_MIN_MS = 700;
    function getMapPaths() {
        const tr = window.terrainRenderer;
        if (!tr || !tr.ready || !tr._cellPolys.size) return null;
        // mapDirty flips on every rock death and regrow; while anyone mines
        // that is every frame, so the rebuild is rate limited
        const nowMP = performance.now();
        if (!mapPaths || (tr.mapDirty && nowMP - (mapPaths.builtAt || 0) >= MAP_PATHS_MIN_MS)) {
            tr.mapDirty = false;
            const gw = global.gameWidth, gh = global.gameHeight;
            const cols = tr._cols, rows = tr._rows;
            // PERF: built as small per-region paths joined with addPath.
            // Appending to one huge Path2D slows as it grows (every
            // moveTo/closePath walks it): ~390ms for a 10k-cell map vs ~10ms
            // chunked, and it reruns on every rock break.
            // Only the chunks whose cells changed since the last build are
            // rebuilt (a rebuild of all of them every 0.7 s while anyone mined
            // made ~300 Path2D objects a time: Blink garbage, GC hitches).
            const MAP_CHUNKS = 12;
            const mc = mapChunks || (mapChunks = { state: new Map(), cells: new Map(), alive: new Map(), dead: new Map(), bio: new Map(), cols: -1 });
            // rock biomes: live rock is also kept per biome, so the maps can
            // tint it (see drawWorldWindow); a new map seed starts over
            const bioN = tr._bio && window.DWBiomes ? window.DWBiomes.N : 0;
            if (mc.cols !== cols || mc.n !== tr._cellPolys.size || mc.bioOf !== tr._bio) {
                mc.state.clear(); mc.cells.clear(); mc.alive.clear(); mc.dead.clear(); mc.bio.clear(); mc.cols = cols; mc.n = tr._cellPolys.size;
                mc.bioOf = tr._bio;
                for (const [k, cell] of tr._cellPolys) {
                    const ck = Math.min(MAP_CHUNKS - 1, Math.max(0, Math.floor(cell.cx / cols * MAP_CHUNKS))) * MAP_CHUNKS +
                               Math.min(MAP_CHUNKS - 1, Math.max(0, Math.floor(cell.cy / rows * MAP_CHUNKS)));
                    let list = mc.cells.get(ck);
                    if (!list) mc.cells.set(ck, list = []);
                    list.push(k);
                }
            }
            const isDead = (k) => tr._rockDead.has(k) && !(tr._growing && tr._growing.get(k)?.mapped);
            const changed = new Set();
            for (const [ck, list] of mc.cells) {
                for (const k of list) {
                    const d = isDead(k);
                    if (mc.state.get(k) !== d) { mc.state.set(k, d); changed.add(ck); }
                }
            }
            for (const ck of changed) {
                let pa = null, pd = null, pb = null;
                for (const k of mc.cells.get(ck)) {
                    const cell = tr._cellPolys.get(k);
                    if (!cell) continue;
                    let p;
                    if (mc.state.get(k)) p = pd || (pd = new Path2D());
                    else if (bioN) {
                        // per biome; the chunk's live path is put together below
                        const b = Math.max(0, tr.biomeOf(k));
                        pb = pb || [];
                        p = pb[b] || (pb[b] = new Path2D());
                    } else p = pa || (pa = new Path2D());
                    const poly = cell.poly;
                    p.moveTo((poly[0][0] / cols - 0.5) * gw, (poly[0][1] / rows - 0.5) * gh);
                    for (let i = 1; i < poly.length; i++)
                        p.lineTo((poly[i][0] / cols - 0.5) * gw, (poly[i][1] / rows - 0.5) * gh);
                    p.closePath();
                }
                if (pb) {
                    pa = new Path2D();
                    for (const q of pb) if (q) pa.addPath(q);
                    mc.bio.set(ck, pb);
                } else mc.bio.delete(ck);
                if (pa) mc.alive.set(ck, pa); else mc.alive.delete(ck);
                if (pd) mc.dead.set(ck, pd); else mc.dead.delete(ck);
            }
            if (mapPaths && !changed.size) { mapPaths.builtAt = nowMP; return mapPaths; }
            const alive = new Path2D(), dead = new Path2D();
            for (const p of mc.alive.values()) alive.addPath(p);
            for (const p of mc.dead.values()) dead.addPath(p);
            let aliveBio = null;
            if (bioN) {
                aliveBio = [];
                for (const pb of mc.bio.values()) {
                    for (let b = 0; b < pb.length; b++) {
                        if (!pb[b]) continue;
                        (aliveBio[b] || (aliveBio[b] = new Path2D())).addPath(pb[b]);
                    }
                }
            }
            mapPaths = { alive, dead, aliveBio, epoch: (mapPaths ? mapPaths.epoch : 0) + 1, builtAt: nowMP };
        }
        return mapPaths;
    }

    function drawPingDiamond(c, x, y, r, alpha) {
        c.save();
        c.globalAlpha = alpha;
        c.lineJoin = "round";
        c.beginPath();
        c.moveTo(x, y - r);
        c.lineTo(x + r * 0.8, y);
        c.lineTo(x, y + r);
        c.lineTo(x - r * 0.8, y);
        c.closePath();
        c.strokeStyle = color.black;
        c.lineWidth = Math.max(1.4, Math.min(r * 0.34, 2.5 + r * 0.1));
        c.stroke();
        c.fillStyle = "#eb4034";
        c.fill();
        c.beginPath();
        c.arc(x, y - r * 0.05, r * 0.22, 0, Math.PI * 2);
        c.fillStyle = "rgba(255,255,255,0.9)";
        c.fill();
        c.restore();
    }

    function drawWorldWindow(c, rx, ry, rw, rh, wx0, wy0, wspan) {
        const tr = window.terrainRenderer;
        const gw = global.gameWidth, gh = global.gameHeight;
        const s = rw / wspan; // px per world unit
        const X = (v) => rx + (v - wx0) * s;
        const Y = (v) => ry + (v - wy0) * s;

        c.fillStyle = "#0e1418";
        c.fillRect(rx, ry, rw, rh);
        const isl = tutorialIsland();
        if (isl) {
            c.fillStyle = "#1e1d1b";
            c.beginPath();
            c.arc(X(isl.x), Y(isl.y), (isl.r + 40) * s, 0, Math.PI * 2);
            c.fill();
        } else if (royaleMode()) {
            // Island dirt only under the rocks: the map edge is the rocks.
            const islP = getMapPaths();
            if (islP) {
                c.save();
                c.translate(rx - wx0 * s, ry - wy0 * s);
                c.scale(s, s);
                c.fillStyle = "#1e1d1b";
                c.fill(islP.alive);
                c.fill(islP.dead);
                c.restore();
            } else {
                c.fillStyle = "#1e1d1b";
                c.fillRect(X(-gw / 2), Y(-gh / 2), gw * s, gh * s);
            }
        } else {
            c.fillStyle = "#22323b";
            c.fillRect(X(-gw / 2), Y(-gh / 2), gw * s, gh * s);
        }

        if (global.roomSetup.length) {
            const Rw = global.roomSetup[0].length, Rh = global.roomSetup.length;
            c.globalAlpha = 0.34;
            for (let ty = 0; ty < Rh; ty++) {
                for (let tx = 0; tx < Rw; tx++) {
                    const cell = global.roomSetup[ty][tx];
                    if (!cell || cell.color === "none") continue;
                    let col = gameDraw.getColor(cell.color);
                    if (col === color.white) continue;
                    if (cell.color === "blue") {
                        try { col = gameDraw.mixColors(col, "#1737a8", 0.5); } catch (e) {  }
                        c.globalAlpha = 0.48;
                    } else {
                        c.globalAlpha = 0.34;
                    }
                    c.fillStyle = col;

                    const tx0 = X((tx / Rw - 0.5) * gw), tx1 = X(((tx + 1) / Rw - 0.5) * gw);
                    const ty0 = Y((ty / Rh - 0.5) * gh), ty1 = Y(((ty + 1) / Rh - 0.5) * gh);
                    c.fillRect(tx0, ty0, tx1 - tx0, ty1 - ty0);
                }
            }
            c.globalAlpha = 1;
        }

        const paths = getMapPaths();
        if (paths && tr) {
            c.save();
            c.translate(rx - wx0 * s, ry - wy0 * s);
            c.scale(s, s);
            c.fillStyle = "#2b2320";
            c.fill(paths.dead);
            const BI = paths.aliveBio && window.DWBiomes ? window.DWBiomes.BIOMES : null;
            if (BI) {
                // rock tinted by biome, kept close to the old grey so pings,
                // pads and players still sit on top
                for (let b = 0; b < paths.aliveBio.length; b++) {
                    if (!paths.aliveBio[b]) continue;
                    c.fillStyle = (BI[b] && BI[b].map) || "#413c4c";
                    c.fill(paths.aliveBio[b]);
                }
            } else {
                c.fillStyle = "#413c4c";
                c.fill(paths.alive);
            }
            const borderW = 0.09 * (Math.min(tr._cols, 120) / 50.0) * (gw / tr._cols); 
            if (borderW * s > 0.45) {
                c.strokeStyle = "rgb(8,7,10)";
                c.lineJoin = "round";
                c.lineWidth = borderW;
                c.stroke(paths.alive);
            }
            c.restore();
        }

        const GEMM = [[-1, -0.38], [-0.55, -0.95], [0.55, -0.95], [1, -0.38], [0, 0.95]];
        for (const v of global.vaults) {
            const vx = X(v.x), vy = Y(v.y);
            const vr = Math.max(3, (v.r || 95) * s);

            const vc = v.team === -2 ? color.red : color.blue;
            c.beginPath();
            c.arc(vx, vy, vr, 0, Math.PI * 2);
            c.fillStyle = vc;
            c.globalAlpha = 0.4;
            c.fill();
            c.globalAlpha = 1;
            c.lineWidth = Math.max(1, vr * 0.12);
            c.strokeStyle = "rgba(8,7,10,0.8)";
            c.stroke();
            const gr = Math.max(3.2, vr * 0.5);
            c.beginPath();
            for (let i = 0; i < GEMM.length; i++) {
                const px = vx + GEMM[i][0] * gr, py = vy + GEMM[i][1] * gr;
                i ? c.lineTo(px, py) : c.moveTo(px, py);
            }
            c.closePath();
            c.fillStyle = color.gold;
            c.strokeStyle = color.black;
            c.lineWidth = 1.4;
            c.fill();
            c.stroke();
        }

        return { X, Y, s };
    }

    function drawMapMarkers(T, rx, ry, rw, rh, nameSize, dotR, skipNameId, hoverOutpostId) {
        const c = ctx[2];
        abilityFx.drawMapRadar(c, T);
        const inside = (x, y) => x > rx - 8 && x < rx + rw + 8 && y > ry - 8 && y < ry + rh + 8;
        const teamCol = myTeamColor();

        if (!royaleLobbyPhase()) for (const o of global.outposts) {
            const st = global.outpostState.find(s => s.id === o.id) || {};
            const mx = T.X(o.x), my = T.Y(o.y);
            if (!inside(mx, my)) continue;
            const ownCol = (st.o && st.c) ? st.c
                        : st.t === -1 ? gameDraw.getColor("blue")
                        : st.t === -2 ? gameDraw.getColor("red")
                        : (royaleActive() ? "#8a90a0" : gameDraw.getColor("yellow")); 
            const s2 = dotR * 1.2;
            c.save();
            c.translate(mx, my);
            c.rotate(Math.PI / 4);
            c.fillStyle = ownCol;
            c.strokeStyle = color.black;
            c.lineWidth = 1.6;
            c.beginPath();
            c.rect(-s2, -s2, s2 * 2, s2 * 2);
            c.fill();
            c.stroke();
            c.restore();
            // structure HP bar, neutral outposts included
            if (st.h > 0 && o.id !== hoverOutpostId) {
                const bw = dotR * 5, bh = 2.5, bx = mx - bw / 2, by = my + s2 + 3;
                c.fillStyle = color.black;
                c.fillRect(bx - 0.5, by - 0.5, bw + 1, bh + 1);
                c.fillStyle = ownCol;
                c.fillRect(bx, by, bw * st.h, bh);
            }
            // small white label on the big map (hover pass draws gold)
            if (nameSize > 0 && o.id !== hoverOutpostId) {
                drawText(o.name, Math.round(mx), Math.round(my - s2 - 6), nameSize * 0.85, color.guiwhite, "center");
            }
        }

        for (const ch of global.chambers) {
            const st = global.chamberState.find(s => s.id === ch.id) || {};
            const mx = T.X(ch.x), my = T.Y(ch.y);
            if (!inside(mx, my)) continue;
            const cc = ch.team === -1 ? gameDraw.getColor("blue") : gameDraw.getColor("red");

            const grow = st.st === 2 ? Math.max(0.12, st.s || 0.15) : 1;
            const s2 = dotR * 1.35 * grow;
            c.globalAlpha = st.st === 1 ? 0.25 : st.st === 2 ? 0.75 : 0.9;
            c.save();
            c.translate(mx, my);
            c.lineJoin = "round";
            c.strokeStyle = st.st === 1 ? "#6a6f7a" : cc;
            c.fillStyle = st.st === 1 ? "rgba(8,7,10,0.85)" : cc;
            c.lineWidth = 1.8;
            c.beginPath();
            for (let i = 0; i < 8; i++) {
                const a = (i / 8) * Math.PI * 2;
                const jit = 0.82 + ((i * 137 + ch.id * 61) % 30) / 100;
                const ox = Math.cos(a) * s2 * jit, oy = Math.sin(a) * s2 * jit;
                i ? c.lineTo(ox, oy) : c.moveTo(ox, oy);
            }
            c.closePath();
            c.fill();
            c.stroke();
            c.restore();
            c.globalAlpha = 1;

            if (st.h > 0) {
                const bw = dotR * 5, bh = 2.5, bx = mx - bw / 2, by = my + s2 + 3;
                c.fillStyle = color.black;
                c.fillRect(bx - 0.5, by - 0.5, bw + 1, bh + 1);
                c.fillStyle = cc;
                c.fillRect(bx, by, bw * st.h, bh);
            }
            // small white label on the big map
            if (nameSize > 0) {
                drawText(ch.name, Math.round(mx), Math.round(my - s2 - 6), nameSize * 0.85, color.guiwhite, "center");
            }
        }

        const L = global.leader;
        const sm = global._mapSmooth;
        if (config.game.leaderIndicators && !royaleActive() && L && L.id !== -1 &&
            L.id !== gui.playerid && sm && sm.leader &&
            performance.now() - L.at < 1200) {
            const lx = T.X(sm.leader.x), ly = T.Y(sm.leader.y);
            if (inside(lx, ly)) drawCrown(lx, ly + dotR * 1.2, dotR * 3.8, 1, c);
        }

        const nowPing = performance.now();
        for (const p of global.enemyPings) {
            const age = nowPing - p.at;
            if (age > 20000) continue;
            const mx = T.X(p.x), my = T.Y(p.y);
            if (!inside(mx, my)) continue;
            drawPingDiamond(c, mx, my, dotR * 3.9, age > 19000 ? 1 - (age - 19000) / 1000 : 1);
        }
        drawDuoPingsMap(c, T, inside, dotR);
        for (const t of global.teammates) {
            if (t.id === gui.playerid) continue;
            // Tutorial: learners share the blue team but live in separate
            // plots, so never show another learner's position
            if (global.tutorialMode) continue;
            // a friendly leader is marked by the crown alone
            if (config.game.leaderIndicators && L && t.id === L.id &&
                performance.now() - L.at < 1200) continue;
            const sp = (sm && sm.mates.get(t.id)) || t;
            const mx = T.X(sp.x), my = T.Y(sp.y);
            if (!inside(mx, my)) continue;
            c.beginPath();
            c.arc(mx, my, dotR, 0, Math.PI * 2);
            c.fillStyle = teamCol;
            c.strokeStyle = color.black;
            c.lineWidth = 1.6;
            c.fill();
            c.stroke();
            c.beginPath();
            c.arc(mx, my, dotR * 0.38, 0, Math.PI * 2);
            c.fillStyle = "rgba(255,255,255,0.85)";
            c.fill();

            if (nameSize > 0 && t.id !== skipNameId) {
                drawText(t.name || "Player", Math.round(mx), Math.round(my - dotR - 5), nameSize, color.guiwhite, "center");
            }
        }
        if (royaleActive()) {
            const rr = global.royale || {};
            const tnow = Date.now();
            const pulse = 1 + 0.18 * Math.sin(performance.now() / 240);
            for (const o of (rr.objectives || [])) {
                if (o.kind !== "contest" || (o.until && o.until < tnow)) continue;
                const mx = T.X(o.x), my = T.Y(o.y);
                if (!inside(mx, my)) continue;
                c.save();
                c.beginPath();
                c.arc(mx, my, dotR * 2.1 * pulse, 0, Math.PI * 2);
                c.strokeStyle = "#e03e41";
                c.lineWidth = 2.5;
                c.stroke();
                c.restore();
            }
            // Revenge mark: red diamond + pulse ring, tracking live.
            const revm = (rr.you && rr.you.revenge) || null;
            if (revm && revm.alive && !revm.tough && isFinite(revm.x) && isFinite(revm.y)) {
                const mx = T.X(revm.x), my = T.Y(revm.y);
                if (inside(mx, my)) {
                    const s2 = dotR * 2.4;
                    c.save();
                    c.translate(mx, my);
                    c.rotate(Math.PI / 4);
                    c.fillStyle = "#e03e41";
                    c.strokeStyle = color.black;
                    c.lineWidth = 2;
                    c.beginPath();
                    c.rect(-s2, -s2, s2 * 2, s2 * 2);
                    c.fill();
                    c.stroke();
                    c.restore();
                    c.save();
                    c.beginPath();
                    c.arc(mx, my, dotR * 3.6 * pulse, 0, Math.PI * 2);
                    c.strokeStyle = "#e03e41";
                    c.lineWidth = 2.2;
                    c.stroke();
                    c.restore();
                }
            }
        }

        // the bounty: a gold diamond wherever it is
        if (royaleActive()) {
            const bm = (global.royale || {}).bounty;
            if (bm && isFinite(bm.x) && isFinite(bm.y)) {
                const mx = T.X(bm.x), my = T.Y(bm.y);
                if (inside(mx, my)) {
                    const s2 = dotR * 2.2;
                    c.save();
                    c.translate(mx, my);
                    c.rotate(Math.PI / 4);
                    c.fillStyle = HUD.gold;
                    c.strokeStyle = color.black;
                    c.lineWidth = 2;
                    c.beginPath();
                    c.rect(-s2, -s2, s2 * 2, s2 * 2);
                    c.fill();
                    c.stroke();
                    c.restore();
                }
            }
        }
        if (royaleActive()) drawRoyaleMapExtras(T, rx, ry, rw, rh, dotR);
        const px = T.X(global.player.renderx), py = T.Y(global.player.rendery);
        if (inside(px, py)) {
            const ang = Math.atan2(global.target.y, global.target.x);
            const r = dotR * 1.9;
            c.save();
            c.translate(px, py);
            c.rotate(ang);
            c.lineJoin = "round";
            c.lineCap = "round";
            c.beginPath();
            c.moveTo(r * 1.15, 0);
            c.lineTo(-r * 0.75, -r * 0.72);
            c.lineTo(-r * 0.3, 0);
            c.lineTo(-r * 0.75, r * 0.72);
            c.closePath();

            c.strokeStyle = color.black;
            c.lineWidth = r * 0.55;
            c.stroke();
            c.fillStyle = teamCol;
            c.fill();
            c.strokeStyle = "rgba(255,255,255,0.9)";
            c.lineWidth = r * 0.16;
            c.stroke();
            c.restore();
        }
    }

    const cornerCache = { canvas: null, sizePx: 0, epoch: -1, cx: 1e9, cy: 1e9, wx0: 0, wy0: 0 };
    const cornerVign = { canvas: null, size: 0 };
    function drawFortniteMinimap(x, y, size) {
        const gw = global.gameWidth, gh = global.gameHeight;
        if (!gw || !gh) return;
        const span = 2800;          
        const cSpan = span * 1.35;  

        let wx0 = global.player.renderx - span / 2;
        let wy0 = global.player.rendery - span / 2;
        wx0 = Math.max(-gw / 2 - span * 0.08, Math.min(gw / 2 - span * 0.92, wx0));
        wy0 = Math.max(-gh / 2 - span * 0.08, Math.min(gh / 2 - span * 0.92, wy0));
        const cxNow = wx0 + span / 2, cyNow = wy0 + span / 2;
        const paths = getMapPaths(); 
        const epoch = paths ? paths.epoch : -1;
        // At least the screen's density, and never under the HUD layer's own
        // pixels per unit: global.ratio is the world's, which the automatic
        // resolution lowers, and a big screen's UI scale passes 2. (A bake a
        // bit denser than the layer stays sharp while the map pans.)
        const hudT = tfOf(ctx[2]);
        const dpr = crispOff ? Math.max(1, Math.min(2, global.ratio || 1))
            : Math.max(1, Math.min(4, Math.max(Math.min(2, window.devicePixelRatio || 1), Math.round(Math.hypot(hudT.a, hudT.b) * 20) / 20)));
        const S = Math.ceil(size * dpr * (cSpan / span));
        const margin = (cSpan - span) / 2;
        const nowMM = performance.now();
        const needsNow = !cornerCache.canvas || cornerCache.sizePx !== S ||
            Math.abs(cxNow - cornerCache.cx) > margin * 0.7 ||
            Math.abs(cyNow - cornerCache.cy) > margin * 0.7;
        const needsEpoch = cornerCache.epoch !== epoch && nowMM - (cornerCache.bakedAt || 0) >= MAP_PATHS_MIN_MS;
        if (needsNow || needsEpoch) {
            cornerCache.bakedAt = nowMM;
            cornerCache.bakes = (cornerCache.bakes | 0) + 1;
            if (!cornerCache.canvas || cornerCache.sizePx !== S) {
                cornerCache.canvas = document.createElement("canvas");
                cornerCache.canvas.width = cornerCache.canvas.height = S;
                cornerCache.sizePx = S;
            }
            const oc = cornerCache.canvas.getContext("2d");
            oc.clearRect(0, 0, S, S);
            const cWx0 = cxNow - cSpan / 2, cWy0 = cyNow - cSpan / 2;
            drawWorldWindow(oc, 0, 0, S, S, cWx0, cWy0, cSpan);
            cornerCache.cx = cxNow;
            cornerCache.cy = cyNow;
            cornerCache.wx0 = cWx0;
            cornerCache.wy0 = cWy0;
            cornerCache.epoch = epoch;
        }
        const mmR = size * 0.12;
        ctx[2].save();
        roundRectPath(ctx[2], x, y, size, size, mmR);
        ctx[2].fillStyle = "rgba(0,0,0,0.35)";
        ctx[2].fill();
        ctx[2].clip();
        const ppw = S / cSpan;
        ctx[2].imageSmoothingEnabled = true;
        ctx[2].drawImage(cornerCache.canvas,
            (wx0 - cornerCache.wx0) * ppw, (wy0 - cornerCache.wy0) * ppw,
            span * ppw, span * ppw,
            x, y, size, size);
        const s2 = size / span;
        const T = {
            X: (wx) => x + (wx - wx0) * s2,
            Y: (wy) => y + (wy - wy0) * s2,
            s: s2,
        };
        drawMapMarkers(T, x, y, size, size, 8.5, 3.4);
        strokeStormCircle(ctx[2], T.X, T.Y, T.s, x, y, size, size);
        ctx[2].restore();
        const c2 = ctx[2];
        c2.save();
        c2.lineWidth = 3;
        c2.strokeStyle = "#555555";
        roundRectPath(c2, x, y, size, size, mmR);
        c2.stroke();
        c2.restore();
    }

    function drawRoyaleFullMinimap(x, y, size) {
        const gw = global.gameWidth, gh = global.gameHeight;
        if (!gw || !gh) return;
        const c = ctx[2];
        c.save();
        c.beginPath();
        c.rect(x, y, size, size);
        c.clip();
        const T = drawWorldWindow(c, x, y, size, size, -gw / 2, -gh / 2, gw);
        if (!royaleLobbyPhase()) drawMapMarkers(T, x, y, size, size, 6, 2.8);
        else {
            const px = T.X(global.player.renderx), py = T.Y(global.player.rendery);
            c.fillStyle = color.guiwhite;
            c.beginPath();
            c.arc(px, py, 3, 0, Math.PI * 2);
            c.fill();
        }
        strokeStormCircle(c, T.X, T.Y, T.s, x, y, size, size);
        c.restore();
        c.lineWidth = 3;
        c.strokeStyle = color.black;
        c.strokeRect(x, y, size, size);
        const keyEl = document.querySelector('#controlSettings b[data-key="KEY_TOGGLE_MAP"]');
        const keyName = keyEl && keyEl.textContent ? keyEl.textContent : "M";
        drawText("[" + keyName + "] map", x + size / 2, y + size + 16, 11, color.guiwhite, "center");
    }

    let bigMapFade = 0;
    function drawBigMap() {
        const mapTarget = global.showBigMap ? 1 : 0;
        bigMapFade = util.lerp(bigMapFade, mapTarget, mapTarget ? 0.1 : 0.28, true);
        const fade = bigMapFade;
        if (fade < 0.02) return;

        const vi = document.getElementById("vaultInput");
        if (vi && vi.style.display !== "none") vi.style.display = "none";
        const bm = global.bigMap;
        const gw = global.gameWidth, gh = global.gameHeight;
        if (!gw || !gh) return;
        const sw = global.screenWidth, sh = global.screenHeight;
        ctx[2].save();
        ctx[2].globalAlpha = fade;
        ctx[2].fillStyle = "rgba(5,6,10,0.55)";
        ctx[2].fillRect(0, 0, sw, sh);

        const pop = 0.97 + 0.03 * fade;
        // leaves the name + wallet row at the bottom uncovered
        const fitW = sw * 0.72, fitH = sh * 0.76;
        const fit = Math.min(fitW / gw, fitH / gh) * pop;
        const panelW = gw * fit, panelH = gh * fit;
        const px0 = (sw - panelW) / 2, py0 = (sh - panelH) / 2 - sh * 0.02;

        // Tutorial: the room holds several learners' plots; frame the map on
        // the learner's own plot.
        const tp = global.tutorialPlot;
        if (tp && tp.size) {
            bm.zoom = gw / tp.size;
            bm.cx = tp.cx;
            bm.cy = tp.cy;
        } else if (royaleActive()) {
            bm.zoom = 1;
            bm.cx = 0;
            bm.cy = 0;
        } else {
            bm.zoom = Math.max(1, Math.min(4, bm.zoom || 1));
        }
        const span = gw / bm.zoom;
        const spanY = gh / bm.zoom;
        if (!(tp && tp.size) && !royaleActive()) {
            bm.cx = Math.max(-gw / 2 + span / 2, Math.min(gw / 2 - span / 2, bm.cx || 0));
            bm.cy = Math.max(-gh / 2 + spanY / 2, Math.min(gh / 2 - spanY / 2, bm.cy || 0));
        }
        const wx0 = bm.cx - span / 2, wy0 = bm.cy - spanY / 2;

        bm._panel = { x: px0, y: py0, w: panelW, h: panelH, s: panelW / span, wx0, wy0 };
        const tabH = royaleActive() ? 34 : 0;
        hudPanel(ctx[2], px0 - 8, py0 - 8, panelW + 16, panelH + 16, { fill: HUD.solid, r: HUD.rBig });
        // raid: the close hint sits at the end of the tab strip, so nothing
        // hangs under the plate onto the name and wallet row
        const closeW = tabH ? 104 : 0;
        if (royaleActive()) drawRoyaleFTabs(px0, py0, panelW - closeW, tabH);
        ctx[2].save();
        ctx[2].beginPath();
        ctx[2].rect(px0, py0 + tabH, panelW, panelH - tabH);
        ctx[2].clip();
        const tab = (global.royaleBoard && global.royaleBoard.tab) || 'map';
        if (royaleActive() && tab !== 'map') {
            ctx[2].fillStyle = HUD.raised;
            ctx[2].fillRect(px0, py0 + tabH, panelW, panelH - tabH);
            drawRoyaleFTabBody(px0, py0 + tabH, panelW, panelH - tabH, tab);
        } else {
        const T = drawWorldWindow(ctx[2], px0, py0, panelW, panelH, wx0, wy0, span);
        strokeStormCircle(ctx[2], T.X, T.Y, T.s, px0, py0 + tabH, panelW, panelH - tabH);

        const mScale = global.canvas ? global.canvas.height / global.screenHeight : 1;
        const hx = global.mouse.x / mScale, hy = global.mouse.y / mScale;
        let hoverMate = null;
        for (const t of global.teammates) {
            if (t.id === gui.playerid) continue;
            if (Math.hypot(T.X(t.x) - hx, T.Y(t.y) - hy) < 22) { hoverMate = t; break; }
        }
        let hoverOutpost = null;
        if (!hoverMate) for (const o of global.outposts) {
            if (Math.hypot(T.X(o.x) - hx, T.Y(o.y) - hy) < 24) { hoverOutpost = o; break; }
        }
        drawMapMarkers(T, px0, py0, panelW, panelH, 10, 4.6,
                       hoverMate ? hoverMate.id : undefined,
                       hoverOutpost ? hoverOutpost.id : undefined);
        // hover: ring + bolder name on the teammate under the cursor
        if (hoverMate) {
            const mx = T.X(hoverMate.x), my = T.Y(hoverMate.y);
            ctx[2].beginPath();
            ctx[2].arc(mx, my, 8.5, 0, Math.PI * 2);
            ctx[2].strokeStyle = color.gold;
            ctx[2].lineWidth = 2.5;
            ctx[2].stroke();
            drawText(hoverMate.name || "Player", Math.round(mx), Math.round(my - 17), 14, color.gold, "center");
        }

        if (hoverOutpost) {
            const st = global.outpostState.find(s => s.id === hoverOutpost.id) || {};
            const mx = T.X(hoverOutpost.x), my = T.Y(hoverOutpost.y);
            drawText(hoverOutpost.name, Math.round(mx), Math.round(my - 16), 14, hoverOutpost.color || color.gold, "center");
            if (st.h > 0) {
                const ownCol = (st.o && st.c) ? st.c
                            : st.t === -1 ? gameDraw.getColor("blue")
                            : st.t === -2 ? gameDraw.getColor("red") : gameDraw.getColor("yellow");
                const bw = 52, bh = 5, bx = mx - bw / 2, by = my + 10;
                ctx[2].fillStyle = color.black;
                ctx[2].fillRect(bx - 1, by - 1, bw + 2, bh + 2);
                ctx[2].fillStyle = ownCol;
                ctx[2].fillRect(bx, by, bw * st.h, bh);
            }
        }
        for (const v of global.vaults) {
            if (royaleLobbyPhase()) break;
            const mx = T.X(v.x), my = T.Y(v.y);
            const vr = Math.max(6, v.r * (bm._panel.s || 1));
            if (Math.hypot(mx - hx, my - hy) < Math.max(18, vr)) {
                drawText("Vault", Math.round(mx), Math.round(my - vr - 10), 16, color.gold, "center");
            } else {
                drawText("Vault", Math.round(mx), Math.round(my - vr - 6), 10, color.guiwhite, "center");
            }
        }
        } // end map-tab world draw
        ctx[2].restore();
        // keyline round the map/list well, under the tab strip
        roundRectPath(ctx[2], px0, py0 + tabH, panelW, panelH - tabH, 6);
        ctx[2].lineWidth = 2.5;
        ctx[2].strokeStyle = HUD.ink;
        ctx[2].stroke();
        if (global.mobile) {
            // touch: a real button (and a tap outside the panel closes it too)
            const bw = hudTitleW("Close", 14) + 26, bh = Math.max(28, tabH - 8);
            const bx = tabH ? px0 + panelW - closeW / 2 : sw / 2, by = tabH ? py0 + (tabH - bh) / 2 : py0 + panelH + 10;
            hudButton(ctx[2], bx, by, bw, bh, "Close", { fill: HUD.danger, lipCol: HUD.dangerDk, textCol: "#fff", size: 14 });
            const k = touchUnits();
            touch.zones.mapClose = { x: (bx - bw / 2) / k - 6, y: by / k - 6, w: bw / k + 12, h: bh / k + 12, tap: () => global.canvas.toggleBigMap() };
            touch.uiRects.map = { x: px0 / k, y: py0 / k, w: panelW / k, h: (panelH + (tabH ? 0 : 50)) / k };
        } else {
            const keyName = keyLabel("KEY_TOGGLE_MAP", "M");
            const kw = Math.max(20, hudTitleW(keyName, 12.4) + 11);
            const rowW = kw + 6 + hudTitleW("Close", 14);
            const rx0 = tabH ? px0 + panelW - closeW / 2 - rowW / 2 : sw / 2 - rowW / 2;
            const ky = tabH ? py0 + tabH / 2 - 7 : py0 + panelH + 18;
            hudKey(ctx[2], rx0, ky, keyName, 20);
            hudTitle("Close", rx0 + kw + 6, ky + 8.75, 14, HUD.text2, "left");
        }
        ctx[2].restore();
    }

    function drawRoyaleFTabs(x, y, w, h) {
        // the settings panel's tabs: the picked one is a raised face joined
        // to the list below, the rest are just labels on the plate
        const tabs = ["Map", "Standings", "Feed", "Alive"];
        const ids = ["map", "standings", "feed", "alive"];
        const tab = (global.royaleBoard && global.royaleBoard.tab) || "map";
        const tw = w / tabs.length;
        const c = ctx[2];
        const cr = global.canvas.height / global.screenHeight / global.ratio;
        const hov = global.clickables.royaleTab.check({ x: global.mouse.x, y: global.mouse.y });
        c.save();
        for (let i = 0; i < tabs.length; i++) {
            const tx = x + i * tw;
            const on = tab === ids[i];
            if (on) {
                const r = 9, tx0 = tx + 3, tw0 = tw - 6, ty0 = y + 3;
                c.beginPath();
                c.moveTo(tx0, y + h + 1);
                c.lineTo(tx0, ty0 + r);
                c.arcTo(tx0, ty0, tx0 + r, ty0, r);
                c.lineTo(tx0 + tw0 - r, ty0);
                c.arcTo(tx0 + tw0, ty0, tx0 + tw0, ty0 + r, r);
                c.lineTo(tx0 + tw0, y + h + 1);
                c.fillStyle = HUD.raised;
                c.fill();
                c.lineWidth = 2.5;
                c.strokeStyle = HUD.ink;
                c.stroke();
            }
            hudTitle(tabs[i], tx + tw / 2, y + h / 2 + 2, 15, on ? HUD.head : hov === i ? HUD.text : HUD.text2, "center");
            global.clickables.royaleTab.place(i, tx * cr, y * cr, tw * cr, h * cr);
        }
        c.restore();
    }
    function drawRoyaleFTabBody(x, y, w, h, tab) {
        const rows = tab === "feed"
            ? (global.royale.feed || []).slice().reverse().map(f => {
                let line = null;
                try { line = feedLine(f); } catch (e) { line = null; }
                return line && line.text ? { name: line.text, extra: f.pts ? ("+" + f.pts) : "" } : null;
            }).filter(Boolean)
            : tab === "alive"
                ? ((global.royale.board || []).filter(r => r.alive || r.here)).map((r, i) => ({
                    num: (i + 1) + ".", name: r.name || "Unnamed", rk: r.rk | 0, ns: r.ns | 0, nc: r.nc,
                    extra: !r.alive ? "respawning" : (r.kills | 0) ? ((r.kills | 0) + " kills") : "alive",
                    me: r.id === gui.playerid || (!r.bot && r.place > 0 && r.place === (global.royale.place | 0)),
                }))
                : royaleBoardRows().map((r, i) => ({
                    num: (i + 1) + ".", name: r.name || "Unnamed", rk: r.rk | 0, ns: r.ns | 0, nc: r.nc,
                    extra: util.formatLargeNumber(r.score || r.gems | 0) + " pts  " + (r.kills | 0) + " kills",
                    me: r.id === gui.playerid || (!r.bot && r.place > 0 && r.place === (global.royale.place | 0)),
                }));
        if (!rows.length) {
            drawText(tab === "alive" ? "Nobody is alive" : "Nobody here yet", x + w / 2, y + h / 2, 16, color.guiwhite, "center");
            return;
        }
        const rowH = 28;
        let headH = 0;
        if (tab === "standings") {
            drawText(scoreText.RULE + ". Banked gems are safe.", x + 18, y + 16, 12, HUD.text2, "left");
            headH = 22;
        }
        const meHex = playerHexCol() || color.gold;
        // board tabs: place number in its own column, then the rank badge
        // column (only when someone has a rank), then the name
        for (const r of rows) if (r.num) r.rk = nameBadgeCode(r.me ? myRankCode() || r.rk : r.rk, r.me);
        const rkCol = rows.some(r => r.rk) ? 24 : 0;
        const numW = rows[0] && rows[0].num ? measureText(rows.length + ".", 14) + 8 : 0;
        for (let i = 0; i < rows.length && i < Math.floor((h - 20 - headH) / rowH); i++) {
            const ry = y + 16 + headH + i * rowH;
            const col = rows[i].me ? meHex : color.guiwhite;
            // your row: your colour on the name only, nothing behind it
            if (rows[i].num) {
                drawText(rows[i].num, x + 18 + numW - 8, ry, 14, col, "right");
                if (rows[i].rk) rankBadges.drawBadge(ctx[2], x + 18 + numW + 9, ry - 5.4, 18, rankBadges.codeToDivision(rows[i].rk));
                const fSn = styledName(rows[i].name, rows[i].ns, hexOr(rows[i].nc, col), x + 18 + numW + rkCol, 14, "left", ctx[2], ry);
                drawText(fSn.text, x + 18 + numW + rkCol, ry, 14, fSn.fill, "left");
            } else drawText(rows[i].name, x + 18, ry, 14, col, "left");
            if (rows[i].extra) drawText(rows[i].extra, x + w - 18, ry, 14, color.gold, "right");
        }
    }

    // Glide map markers between the 250ms position updates - once per

    function updateMapSmoothing() {
        if (!global._mapSmooth) global._mapSmooth = { leader: null, mates: new Map() };
        const sm = global._mapSmooth;
        const L = global.leader;
        if (L && L.id !== -1) {
            if (!sm.leader || sm.leaderId !== L.id) { sm.leader = { x: L.x, y: L.y }; sm.leaderId = L.id; }
            sm.leader.x += (L.x - sm.leader.x) * 0.12;
            sm.leader.y += (L.y - sm.leader.y) * 0.12;
        } else sm.leader = null;
        const seen = new Set();
        for (const t of global.teammates) {
            seen.add(t.id);
            let sp = sm.mates.get(t.id);
            if (!sp) { sp = { x: t.x, y: t.y }; sm.mates.set(t.id, sp); }
            sp.x += (t.x - sp.x) * 0.12;
            sp.y += (t.y - sp.y) * 0.12;
        }
        for (const id of sm.mates.keys()) if (!seen.has(id)) sm.mates.delete(id);
    }

    function drawMinimapAndDebug(spacing, alcoveSize, GRAPHDATA) {

        let len = alcoveSize;
        let height = (len / global.gameWidth) * global.gameHeight;
        let upgradeColumns = Math.ceil(gui.upgrades.length / 9);
        let x = global.screenWidth - spacing - len - 5;
        let y = global.screenHeight - height - spacing - 5;
        if (global.GUIStatus.renderMinimap) {
            if (global.mobile && (royaleActive() || (window.terrainRenderer && window.terrainRenderer.ready && global.gems && global.gems.cap > 0))) {
                // touch: top right, where the standings sit on desktop (they
                // are one tap away on the map), and a tap opens the full map
                const k = touchUnits();
                const { x: mx, y: my, w: ml } = touchMinimapRect();
                drawFortniteMinimap(mx, my, ml);
                hudDrawn.minimap = { x: mx, y: my, w: ml, h: ml };
                touch.zones.map = { x: mx / k, y: my / k, w: ml / k, h: ml / k, tap: () => global.canvas.toggleBigMap() };
            } else if (royaleActive()) {
                const mx = global.screenWidth - HUD.edge - len;
                const my = global.screenHeight - len - HUD.edge - HUD.lip;
                drawFortniteMinimap(mx, my, len);
                hudDrawn.minimap = { x: mx, y: my, w: len, h: len };
                const mapTxt = "Map (" + keyLabel("KEY_TOGGLE_MAP", "M") + ")";
                const mapLx = Math.round(mx - 7), mapLy = Math.round(my + len - 8);
                hudTitle(mapTxt, mapLx, mapLy, 11, HUD.head, "right");
                if (global.canvas && !global.died) {
                    const crm = global.canvas.height / global.screenHeight / global.ratio;
                    const mxm = global.mouse.x / (crm * global.ratio), mym = global.mouse.y / (crm * global.ratio);
                    if (Math.hypot(mxm - (mx + len / 2), mym - (my + len / 2)) < len / 2) queueTip("Map  ·  " + keyLabel("KEY_TOGGLE_MAP", "M"), "Press " + keyLabel("KEY_TOGGLE_MAP", "M") + " for the full map.", mx + len / 2, my, true);
                }
                const hx = mapLx - hudTitleW(mapTxt, 11) - 10;
                global.minimapHintRect = { x: hx, y: my - 10, w: global.screenWidth - hx, h: global.screenHeight - my + 10 };
            } else if (window.terrainRenderer && window.terrainRenderer.ready && global.gems && global.gems.cap > 0) {
                const mx = global.screenWidth - spacing - len - 5;
                const my = global.screenHeight - len - spacing - 5;
                drawFortniteMinimap(mx, my, len);
            } else {

            let centerX = x + len / 2;
            let centerY = y + height / 2;

            // Tutorial: the room holds one arena per learner; frame the
            // minimap on the learner's own, as the full map does. The clip
            // below drops everything outside it.
            let mmW = global.gameWidth, mmH = global.gameHeight;
            let mmCX = 0, mmCY = 0;
            const tutPlot = global.tutorialPlot;
            if (tutPlot && tutPlot.size) {
                mmW = mmH = tutPlot.size;
                mmCX = tutPlot.cx; mmCY = tutPlot.cy;
            }
            const mmX = (wx) => x + ((wx - mmCX) / mmW + 0.5) * len;
            const mmY = (wy) => y + ((wy - mmCY) / mmH + 0.5) * height;

            ctx[2].globalAlpha = 0.4;
            ctx[2].save();
            ctx[2].fillStyle = color.white;
            (global.advanced.roundMap && !royaleActive()) ? drawGuiCircle(x + len / 2, y + height / 2, len / 2) : drawGuiRect(x, y, len, height);
            ctx[2].beginPath();
            (global.advanced.roundMap && !royaleActive()) ? ctx[2].arc(x + len / 2, y + height / 2, len / 2, 0, 2 * Math.PI) : ctx[2].rect(x, y, len, height);
            ctx[2].clip();

            if (global.roomSetup.length) {
                let W = global.roomSetup[0].length,
                    H = global.roomSetup.length,
                    i = 0;

                let playerWorldX = global.player.cx.animX;
                let playerWorldY = global.player.cy.animY;

                for (let ycell = 0; ycell < H; ycell++) {
                    let j = 0;
                    for (let xcell = 0; xcell < W; xcell++) {
                        let cell = global.roomSetup[ycell][xcell];

                        let cellWorldX = (xcell / W - 0.5) * global.gameWidth;
                        let cellWorldY = (ycell / H - 0.5) * global.gameHeight;

                        let relX = cellWorldX - playerWorldX;
                        let relY = cellWorldY - playerWorldY;

                        let minimapX = config.game.centeredMinimap ? centerX + (relX / mmW) * len : mmX(cellWorldX);
                        let minimapY = config.game.centeredMinimap ? centerY + (relY / mmH) * height : mmY(cellWorldY);
                        let cellWidth = (len / W) * (global.gameWidth / mmW);
                        let cellHeight = (height / H) * (global.gameHeight / mmH);
                        if (!cell) {
                            ctx[2].fillStyle = gameDraw.getColor("border", true);
                            drawGuiRect(minimapX, minimapY, cellWidth, cellHeight);
                        } else {
                            let color = cell.color;
                            if (color == 'none') cell.color = 'pureBlack';
                            if (cell.renderImage) {
                                ctx[2].globalAlpha = 1;
                                ctx[2].drawImage(cell.renderImage, minimapX, minimapY, cellWidth, cellHeight);
                            }
                            ctx[2].globalAlpha = 0.4;
                            ctx[2].fillStyle = gameDraw.getColor(color);
                            if (gameDraw.getColor(color) !== color.white) {
                                drawGuiRect(minimapX, minimapY, cellWidth, cellHeight);
                            }
                        };
                        j++;
                    }
                    i++;
                }
            }
            ctx[2].globalAlpha = 1;
            for (let entity of minimap.get()) {
                ctx[2].fillStyle = gameDraw.mixColors(gameDraw.modifyColor(entity.color), color.black, 0.3);
                ctx[2].globalAlpha = entity.alpha;

                let relX = entity.x - global.player.cx.animX;
                let relY = entity.y - global.player.cy.animY;

                let minimapX = config.game.centeredMinimap ? centerX + (relX / mmW) * len : mmX(entity.x);
                let minimapY = config.game.centeredMinimap ? centerY + (relY / mmH) * height : mmY(entity.y);

                switch (entity.type) {
                    case 2:

                        let trueSize = (entity.size + 2) / 1.1283791671;
                        let sizeOnMap = (trueSize / mmW) * len;
                        drawGuiRect(minimapX - sizeOnMap, minimapY - sizeOnMap, sizeOnMap * 2, sizeOnMap * 2);
                        break;
                    case 1:

                        let entitySize = (entity.size / mmW) * len;
                        drawGuiCircle(minimapX, minimapY, entitySize);
                        break;
                    case 0:

                        if (entity.id !== gui.playerid) {
                            drawGuiCircle(minimapX, minimapY, !global.mobile ? 2 : 3.5);
                        }
                        break;
                }
            }

            // Dig Wars: vault markers - little gold gems on each base
            if (global.vaults.length && !royaleLobbyPhase()) {
                const GEMM = [[-1, -0.38], [-0.55, -0.95], [0.55, -0.95], [1, -0.38], [0, 0.95]];
                const gp = 0.85 + 0.15 * Math.sin(performance.now() / 500);
                for (const v of global.vaults) {
                    const relX = v.x - global.player.cx.animX;
                    const relY = v.y - global.player.cy.animY;
                    const mx = config.game.centeredMinimap ? centerX + (relX / mmW) * len : mmX(v.x);
                    const my = config.game.centeredMinimap ? centerY + (relY / mmH) * height : mmY(v.y);
                    const mr = (global.mobile ? 6 : 4.5) * gp;
                    ctx[2].beginPath();
                    for (let i = 0; i < GEMM.length; i++) {
                        const px = mx + GEMM[i][0] * mr, py = my + GEMM[i][1] * mr;
                        i ? ctx[2].lineTo(px, py) : ctx[2].moveTo(px, py);
                    }
                    ctx[2].closePath();
                    ctx[2].fillStyle = color.gold;
                    ctx[2].strokeStyle = color.black;
                    ctx[2].lineWidth = 1.5;
                    ctx[2].fill();
                    ctx[2].stroke();
                }
            }

            strokeStormCircle(ctx[2], mmX, mmY, len / mmW, x, y, len, height);

            ctx[2].globalAlpha = 1;
            ctx[2].lineWidth = 1;
            ctx[2].strokeStyle = color.guiblack;
            ctx[2].fillStyle = color.guiblack;

            drawGuiCircle(config.game.centeredMinimap ? centerX : mmX(global.player.cx.animX), config.game.centeredMinimap ? centerY : mmY(global.player.cy.animY), !global.mobile ? 2 : 3.5, false);
            ctx[2].restore();
            ctx[2].globalAlpha = 1;
            ctx[2].fillStyle = color.black;

            ctx[2].lineWidth = 3;
            (global.advanced.roundMap && !royaleActive()) ? drawGuiCircle(x + len / 2, y + height / 2, len / 2, true) : drawGuiRect(x, y, len, height, true);
            }
        }
        if (!global.GUIStatus.renderMinimap) {
            x = global.screenWidth - spacing - len;
            y = global.screenHeight - spacing;
        }
        if (global.showDebug) {
            drawGuiRect(x, y - 40, len, 30);
            lagGraph(lag.get(), x, y - 40, len, 30, color.teal);
            gapGraph(global.metrics.rendergap, x, y - 40, len, 30, color.pink);
            timingGraph(GRAPHDATA, x, y - 40, len, 30, color.yellow);
        }

        if (!global.showDebug) y += 13 * 3;

        handleSpeedMonitor();

        if (!global.metrics.latency.length) global.metrics.latency.push(0);
        let ping = global.metrics.latency.reduce((b, a) => b + a, 1) / global.metrics.latency.length - 1;
        let xloc = global.player.renderx / 30;
        let yloc = global.player.rendery / 30;
        if (global.showDebug) {
            let getRenderingInfo = (data, isTurret) => {
                isTurret ? global.renderingInfo.turretEntities += data.length : global.renderingInfo.entities += data.length;
                for (let instance of data) {
                    if (instance.name && instance.id !== gui.playerid) global.renderingInfo.entitiesWithName++;
                    if (instance.turrets.length) getRenderingInfo(instance.turrets, true);
                };
            };
            getRenderingInfo(global.entities, false);
            if (!global.tankSpeedHistory) global.tankSpeedHistory = [];
            const HISTORY_LENGTH = 5;
            let rawSpeed = Math.sqrt(global.player.vx * global.player.vx + global.player.vy * global.player.vy) * config.roomSpeed;
            rawSpeed = rawSpeed * 0.765;
            global.tankSpeedHistory.push(rawSpeed);
            if (global.tankSpeedHistory.length > HISTORY_LENGTH) global.tankSpeedHistory.shift();
            let tankSpeed = global.tankSpeedHistory.reduce((sum, val) => sum + val, 0) / global.tankSpeedHistory.length;
            drawText(`§${global.serverStats.lag_color}§ ${(100 * gui.fps).toFixed(2)}% §reset§/ ` + global.serverStats.players + ` player${global.serverStats.players == 1 ? "" : "s"}`, x + len, y - 50 - 9 * 14, 10, color.guiwhite, "right");
            drawText(`Coordinates: (${xloc.toFixed(2)}, ${yloc.toFixed(2)})`, x + len, y - 50 - 8 * 14, 10, color.guiwhite, "right");
            drawText("Speed: " + tankSpeed.toFixed(2) + " gu/s", x + len, y - 50 - 7 * 14, 10, color.guiwhite, "right");
            drawText("Memory: " + global.metrics.rendergap.toFixed(1) + " Mib", x + len, y - 50 - 6 * 14, 10, color.guiwhite, "right");
            drawText(`Rendering: e ${global.renderingInfo.entities} t: ${global.renderingInfo.turretEntities} n: ${global.renderingInfo.entitiesWithName}`, x + len, y - 50 - 5 * 14, 10, color.guiwhite, "right");
            drawText(`Bandwidth: tx ${global.bandwidth.finalHa} rx ${global.bandwidth.finalFa}`, x + len, y - 50 - 4 * 14, 10, color.guiwhite, "right");
            drawText("Update Rate: " + global.metrics.updatetime + "Hz", x + len, y - 50 - 3 * 14, 10, color.guiwhite, "right");
            drawText("Prediction: " + Math.round(GRAPHDATA) + "ms", x + len, y - 50 - 2 * 14, 10, color.guiwhite, "right");
            drawText(`§${global.metrics.rendertime_color}§ ${global.metrics.rendertime} FPS §reset§/` + `§${global.serverStats.mspt_color}§ ${global.serverStats.mspt} mspt : ${global.metrics.mspt.toFixed(1)} gmspt`, x + len, y - 50 - 1 * 14, 10, color.guiwhite, "right");
            drawText(ping.toFixed(1) + " ms / " + global.serverStats.serverGamemodeName + " " + global.locationHash, x + len, y - 50, 10, color.guiwhite, "right");
        } else if (royaleActive() || global.mobile) {
            // raid: one quiet line over the map, the rest lives behind debug
            // (touch: under it, the map is at the top)
            drawVitals();
            const mm = hudDrawn.minimap;
            const ly = mm ? (global.mobile ? mm.y + mm.h + 4 : mm.y - 8) : y - 50;
            // opt-in since Oct 8 (Settings > UI Elements > FPS and ping)
            if (config.graphical.showFps) {
                const slow = global.metrics.rendertime < 30 ? "§" + color.orange + "§" : "";
                drawText(`${slow}${global.metrics.rendertime} FPS${slow ? "§reset§" : ""}  ·  ${Math.round(ping)} ms`, mm ? mm.x + mm.w : x + len, ly, 9.5, HUD.text2, "right", true);
            }
        } else if (!global.GUIStatus.minimapReducedInfo) {
            drawText(`§${global.serverStats.lag_color}§ ${(100 * gui.fps).toFixed(2)}% §reset§/ ` + global.serverStats.players + ` player${global.serverStats.players == 1 ? "" : "s"}`, x + len, y - 50 - 2 * 14, 10, color.guiwhite, "right");
            drawText(`§${global.metrics.rendertime_color}§ ${global.metrics.rendertime} FPS §reset§/` + `§${global.serverStats.mspt_color}§ ${global.serverStats.mspt} mspt`, x + len, y - 50 - 1 * 14, 10, color.guiwhite, "right");
            drawText(ping.toFixed(1) + " ms / " + global.serverStats.serverGamemodeName + " " + global.locationHash, x + len, y - 50, 10, color.guiwhite, "right");
        }
    }

    // ── HP and shield, Fortnite style (round 8) ────────────────────────
    // Two bars over the minimap and its FPS line (touch: under them, the map is top
    const VITAL_W = { hpTxt: "", hp: -1, hpMax: -1, shTxt: "", sh: -1, shMax: -1 };
    const HP_COLS = [];
    for (let i = 0; i <= 20; i++) {
        // red (0) -> amber (0.5) -> green (1)
        const f = i / 20, a = [224, 71, 59], b = [242, 184, 60], g = [79, 207, 92];
        const p = f < 0.5 ? a : b, q = f < 0.5 ? b : g, k = f < 0.5 ? f * 2 : (f - 0.5) * 2;
        HP_COLS.push("rgb(" + Math.round(p[0] + (q[0] - p[0]) * k) + "," + Math.round(p[1] + (q[1] - p[1]) * k) + "," + Math.round(p[2] + (q[2] - p[2]) * k) + ")");
    }
    const SHIELD_COL = "#5cb8ff";
    var vitalsRect = null;
    function drawVitals() {
        vitalsRect = null;
        const mm = hudDrawn.minimap, me = global.selfEnt;
        if (!mm || !me || !royaleActive() || global.tutorialMode || global.died || global.royaleSpectating || global.showBigMap || raidFinale.active()) return;
        if (me.id !== gui.playerid || !(me.maxHealthN > 0)) return;
        const c = ctx[2];
        const hpMax = me.maxHealthN | 0, hp = Math.max(0, Math.min(hpMax, Math.round((me.health || 0) * hpMax)));
        const you = global.royale && global.royale.you;
        const shMax = you && you.shm > 0 ? you.shm | 0 : 0;
        const sh = shMax ? Math.max(0, Math.min(shMax, Math.round((me.shield || 0) * shMax))) : 0;
        const V = VITAL_W;
        if (hp !== V.hp || hpMax !== V.hpMax) { V.hp = hp; V.hpMax = hpMax; V.hpTxt = "HP " + fmtNum(hp) + " / " + fmtNum(hpMax); }
        if (sh !== V.sh || shMax !== V.shMax) { V.sh = sh; V.shMax = shMax; V.shTxt = "Shield " + fmtNum(sh) + " / " + fmtNum(shMax); }
        const w = mm.w, x = mm.x;
        const hH = global.mobile ? 19 : 20, sH = global.mobile ? 17 : 18, gap = 4;
        const total = (shMax ? sH + gap : 0) + hH;
        // desktop: above the FPS line (which sits 8 over the map)
        let y0 = global.mobile ? mm.y + mm.h + 18 : mm.y - 22 - total;
        // no FPS line between them (it's opt-in): the bars sit right over the map
        if (!global.mobile && !config.graphical.showFps) y0 += 12;
        if (global.mobile && global.screenHeight > global.screenWidth) y0 = Math.max(y0, (hudTopBottom | 0) + 8);
        const hf = me.render && me.render.health ? me.render.health.get() : me.health;
        const sf = me.render && me.render.shield ? me.render.shield.get() : me.shield;
        let y = y0;
        if (shMax) {
            hudBar(c, x, y, w, sH, sf, SHIELD_COL);
            vitalLabel(c, V.shTxt, x, y, w, sH);
            y += sH + gap;
        }
        hudBar(c, x, y, w, hH, hf, HP_COLS[Math.max(0, Math.min(20, Math.round((me.health || 0) * 20)))]);
        vitalLabel(c, V.hpTxt, x, y, w, hH);
        vitalsRect = { x: x - 4, y: y0 - 4, w: w + 8, h: total + 8 };
    }
    function vitalLabel(c, text, x, y, w, h) {
        const boost = config.graphical.fontSizeBoost || 0;
        let size = Math.max(7, (h - 5) / 1.12 - boost);
        const tw = hudTitleW(text, size);
        if (tw > w - 14) size = Math.max(6, size * (w - 14) / tw);
        hudTitle(text, x + w / 2, y + h / 2, size, HUD.head, "center", 1, c);
    }
    window.dwVitals = () => ({ rect: vitalsRect, hp: VITAL_W.hpTxt, sh: VITAL_W.shTxt });

    function drawLeaderboard(spacing, alcoveSize, max) {

        let lb = leaderboard.get();
        let vspacing = 4;
        let len = alcoveSize;
        let height = 14;
        let x = global.screenWidth - spacing - 10;
        let y = spacing + height + 13;
        lbGlide.set(0 + lb.data.length > 0);
        let glide = lbGlide.get();
        x -= lb.data.length ? len * glide : len * glide;

        drawText("Leaderboard", Math.round(x + len / 2) + 0.5, Math.round(y - 6) + 0.5, height + 3.5, color.guiwhite, "center", false, 1, 5.5);
        y += 7;

        for (let i = 0; i < lb.data.length; i++) {
            let entry = lb.data[i];
            let lbEntry = leaderboardEntries[entry.id];
            if (!lbEntry) {
                lbEntry = leaderboardEntries[entry.id] = {
                    ...entry,
                    leaderboardUpdate,
                    animX: Smoothbar(0, 0.30, 1.5, 0.045, true),
                    animY: Smoothbar(0, 0.30, 1.5, 0.045, true),
                    x: 0,
                    y: i,
                    targetX: 1,
                    targetY: i
                };
            }
            if (lbEntry.y !== i && lbEntry.targetY !== i) lbEntry.targetY = i;

            lbEntry.image = entry.image;
            lbEntry.position = entry.position;
            lbEntry.barColor = entry.barColor;
            lbEntry.label = entry.label;
            lbEntry.score = entry.score;
            lbEntry.nameColor = entry.nameColor;
            lbEntry.visible = true;
            lbEntry.update = leaderboardUpdate;
        }
        for (let id in leaderboardEntries) {
            let entry = leaderboardEntries[id];
            if (entry.update !== leaderboardUpdate && entry.targetX !== 0) entry.targetX = 0;
            if (entry.update === leaderboardUpdate && entry.targetX === 0) entry.targetX = 1;
            if (entry.animX.get() > 0.999) {
                entry.animX.force(0);
                entry.x = entry.targetX;
                if (entry.x === 0) {
                    entry.visible = false;
                    delete leaderboardEntries[id];
                };
            }
            if (entry.animY.get() > 0.999) {
                entry.animY.force(0);
                entry.y = entry.targetY;
            }
            if (entry.x !== entry.targetX) entry.animX.set(1);
            if (entry.y !== entry.targetY) entry.animY.set(1);

            if (entry.visible) {
                let scale = height / entry.position.axis;
                let fullX = global.screenWidth + 1.5 * height + scale * entry.position.middle.x * Math.SQRT1_2 + 10;
                let entryX = entry.x ? x : fullX;
                if (entry.x !== entry.targetX) entryX = entryX + entry.animX.get() * ((entry.targetX ? x : fullX) - entryX);
                let entryPos = entry.y;
                if (entry.y !== entry.targetY) entryPos = entry.y + entry.animY.get() * (entry.targetY - entry.y);
                let entryY = y + (vspacing + height) * entryPos;

                drawBar(entryX, entryX + len, entryY + height / 2 - .7, height - 3 + config.graphical.barChunk, color.black);
                drawBar(entryX, entryX + len, entryY + height / 2 - .7, height - 3, color.grey);
                let shift = Math.min(1, entry.score / max);
                drawBar(entryX, entryX + len * shift, entryY + height / 2 - .7, height - 3.5, gameDraw.modifyColor(entry.barColor, "mirror 0 1 0 false"));

                let nameColor = entry.nameColor || "#FFFFFF";
                let overwritelabel = entry.label.includes("#")
                    ? entry.label.replace("##", Math.round(entry.score).toString()).replace("#s", 1 === Math.round(entry.score) ? "" : "s")
                    : false;
                drawText(overwritelabel ? overwritelabel : entry.label + (": " + util.handleLargeNumber(Math.round(entry.score))), entryX + len / 2, entryY + height / 2, height - 4.5, nameColor == "#ffffff" ? color.guiwhite : nameColor, "center", true);

                if (entry.renderEntity) {
                    let xx = entryX - 1.5 * height - scale * entry.position.middle.x * Math.SQRT1_2,
                        yy = entryY + 0.5 * height - scale * entry.position.middle.y * Math.SQRT1_2,
                        baseColor = entry.color;
                    drawEntity(baseColor, xx, yy, entry.image, 1 / scale, 1, (scale * scale) / entry.image.size, (scale * scale) / entry.image.size / 8.5, -Math.PI / 4, true, ctx[2], false, entry.image.render, false, true);
                }
            }
        }
        leaderboardUpdate++;
    }

    // Royale standings above the minimap (F to toggle, tabs sort by gems/kills).
    // Replaces the top-right leaderboard in BR.
    function drawRoyaleBoard() {
        if (!global.showBigMap) global.clickables.royaleTab.hide();
        if (!global.royaleSpectating) {
            global.clickables.royalePrev.hide();
            global.clickables.royaleNext.hide();
            global.clickables.royalePlay.hide();
        }
        if (!global.died) {
            global.clickables.royaleSpectate.hide();
            global.clickables.royalePlay.hide();
        }
    }

    function drawAvailableUpgrades(spacing, alcoveSize) {

        global.clickables.lastTank.hide();
        if (global.optionsMenu_Anim.isOpened) global.clickables.upgrade.hide();
        global.upgradeBoxBottom = 0;
        // the first seconds of a first raid: the tiles glide in a few seconds after
        if (gui.upgrades.length > 0 && !firstSeconds.shows("tiles")) {
            global.canUpgrade = false;
            global.clickables.upgrade.hide();
            global.clickables.skipUpgrades.hide();
            return;
        }
        if (gui.upgrades.length > 0) {
            // pages (upgradeGridLogic.js): 6 a page on desktop
            const UG = global.upgradePg || (global.upgradePg = { key: "", page: 0, pg: null, seen: new Set() });
            const ukey = upGrid.optionsKey(gui.upgrades);
            if (ukey !== UG.key) { UG.key = ukey; UG.page = 0; UG.seen = new Set(); }
            const pg = upGrid.pageOf(gui.upgrades.length, upGrid.pageSize(global.mobile), UG.page);
            UG.page = pg.page; UG.pg = pg;
            // the pages of these options seen so far: "+N more" pulses until all were
            if (!UG.seen) UG.seen = new Set();
            UG.seen.add(pg.page);
            const shownUps = pg.pages > 1 ? gui.upgrades.slice(pg.start, pg.end) : gui.upgrades;
            const pagerH = pg.pages > 1 ? (global.mobile ? 36 : 30) : 0;
            // Tier 5 options (server terrain/tier5.js): gold pips
            const t5s = upGrid.t5State(global.royale && global.royale.you);
            const goldOpts = !!(t5s && t5s.gold);
            let internalSpacing = 15;
            let len = alcoveSize / 2;
            let height = len;
            // touch: a "New tank" chip; the tiles open in a panel over the middle
            let tp = null;
            if (global.mobile) {
                if (!touchTilesOpen()) {
                    global.canUpgrade = true;
                    global.clickables.upgrade.hide();
                    global.clickables.skipUpgrades.hide();
                    return;
                }
                len = height = 74;
                internalSpacing = 12;
                tp = {};
            }

            global.columnCount = pg.pages > 1 ? upGrid.COLS_DESKTOP : Math.max(3, Math.floor(gui.upgrades.length ** 0.55));
            // Room for the DOM gear + fullscreen buttons (10px + 42px + 3px drop,
            // CSS px) above the first row; on a small window at Small scale
            // 46 UI units is not enough.
            const cssPerUi = global.canvas.height / global.screenHeight / global.ratio;
            let topPad = Math.max(46, Math.ceil(63 / (cssPerUi || 1)) - spacing - 5);
            // Desktop: add columns while the grid would run into the kit box /
            // stat bars. Six at most, or it reaches the raid clock.
            if (tp) {
                // touch panel: up to five across, centred, sized to its rows
                global.columnCount = pg.pages > 1 ? upGrid.COLS_TOUCH : Math.min(5, Math.max(3, Math.ceil(gui.upgrades.length / 2)));
                let rows = 0, branch = -1, tick = global.columnCount, labels = 0;
                for (const u of shownUps) {
                    if (tick === global.columnCount || u[0] != branch) {
                        rows++;
                        if (u[0] != branch && u[1] != "undefined" && String(u[1]).length > 0) labels++;
                        branch = u[0]; tick = 0;
                    }
                    tick++;
                }
                const cols = Math.min(global.columnCount, shownUps.length);
                tp.gw = cols * (len + internalSpacing) - internalSpacing;
                tp.w = tp.gw + 32;
                const head = 60;
                tp.w = Math.max(tp.w, 330);
                tp.h = head + rows * (height + internalSpacing) + labels * 3 * internalSpacing + (global.tutorialMode ? 4 : 34) + pagerH;
                tp.x = Math.round((global.screenWidth - tp.w) / 2);
                tp.y = Math.round(Math.max(40, (global.screenHeight - tp.h) / 2 - 10));
                topPad = tp.y + head - spacing - 5;
                hudPanel(ctx[2], tp.x, tp.y, tp.w, tp.h, { fill: HUD.solid, r: HUD.rBig });
                hudTitle(goldOpts ? "Pick your Tier 5 tank" : "Pick your next tank", tp.x + 16, tp.y + 22, 17, goldOpts ? HUD.gold : HUD.head, "left");
                // just picked: this is the next tier, straight away
                const fresh = performance.now() - (touchTiles.nextAt || -1e9) < 3000;
                drawText(fresh ? "Nice! Here's the next tier" : "Each one fights differently, so pick one", tp.x + 16, tp.y + 44, 11.5, fresh ? HUD.gold : HUD.text2, "left", true);
                const cbs = 30;
                hudButton(ctx[2], tp.x + tp.w - 10 - cbs / 2, tp.y + 7, cbs, cbs, "X", { fill: HUD.danger, lipCol: HUD.dangerDk, textCol: "#fff", size: 15 });
                const k = touchUnits();
                touch.zones.tilesClose = { x: (tp.x + tp.w - 10 - cbs) / k - 6, y: (tp.y + 7) / k - 6, w: cbs / k + 12, h: cbs / k + 12, tap: () => { touchTiles.open = false; } };
                touch.uiRects.tiles = { x: tp.x / k, y: tp.y / k, w: tp.w / k, h: tp.h / k };
            } else {
                const gridBottom = cols => {
                    let gy = spacing - height - internalSpacing + 5 + topPad, tick = cols, branch = -1;
                    for (const u of shownUps) {
                        if (tick === cols || u[0] != branch) {
                            gy += height + internalSpacing;
                            if (u[0] != branch && u[1] != "undefined" && String(u[1]).length > 0) gy += 3 * internalSpacing;
                            branch = u[0];
                            tick = 0;
                        }
                        tick++;
                    }
                    return gy + height + internalSpacing - 5 + 24 + 2.5 + 6 + pagerH;
                };
                const limit = leftColumnFloor() - 8;
                while (global.columnCount < 6 && gridBottom(global.columnCount) > limit) global.columnCount++;
            }
            if (!global.canUpgrade) {
                upgradeMenu.force(-global.columnCount * 3)
                global.canUpgrade = true;
            } else
                if (global.pullUpgradeMenu) {
                    upgradeMenu.set(-global.columnCount * 3);
                } else upgradeMenu.set(0);
            let glide = upgradeMenu.get();

            upgradeSpin = Date.now() * 0.0005;
            upgradeSpin = upgradeSpin - (Math.floor(upgradeSpin / Math.PI / 2) * Math.PI * 2);

            let x = tp ? tp.x + Math.round((tp.w - tp.gw) / 2) : glide * 2 * spacing + spacing + 5;

            let y = spacing - height - internalSpacing + 5 + topPad;
            let xStart = x;
            let initialX = x;
            let rowWidth = 0;
            let initialY = y;
            let ticker = 0;
            let upgradeNum = 0;
            let colorIndex = 0;
            let clickableRatio = global.canvas.height / global.screenHeight / global.ratio;
            let lastBranch = -1;
            let upgradeHoverIndex = global.clickables.upgrade.check({ x: global.mouse.x, y: global.mouse.y });
            let gridTop = null, gridRight = 0;
            // only the page on screen is clickable
            global.clickables.upgrade.hide();

            for (let i = pg.start; i < pg.end; i++) {
                let upgrade = gui.upgrades[i];
                let upgradeBranch = upgrade[0];
                let upgradeBranchLabel = upgrade[1] == "undefined" ? "" : upgrade[1];
                let model = upgrade[2];

                if (ticker === global.columnCount || upgradeBranch != lastBranch) {
                    x = xStart;
                    y += height + internalSpacing;
                    if (upgradeBranch != lastBranch) {
                        if (upgradeBranchLabel.length > 0) {
                            hudTitle(upgradeBranchLabel, xStart + 2, y + internalSpacing * 2, internalSpacing * 1.9, HUD.head, "left");
                            y += 3 * internalSpacing;
                        }
                        colorIndex = 0;
                    }
                    lastBranch = upgradeBranch;
                    ticker = 0;
                } else {
                    x += len + internalSpacing;
                }

                if (y > initialY) initialY = y;
                if (gridTop === null) gridTop = y;
                gridRight = Math.max(gridRight, x + len);
                rowWidth = x;
                !global.optionsMenu_Anim.isOpened && global.clickables.upgrade.place(i, x * clickableRatio, y * clickableRatio, len * clickableRatio, height * clickableRatio);
                let upgradeKey = getClassUpgradeKey(upgradeNum);

                const tileState = !global.mobile && i == upgradeHoverIndex ? (global.clickables.clicked ? 2 : 1) : 0;
                drawUpgradeTile(model, x, y, len, height, colorIndex++, !global.mobile ? upgradeKey : false, tileState, upgradeSpin, 1, 1, true);
                if (goldOpts) drawT5Pip(ctx[2], x, y + (tileState === 2 ? 2 * len / 100 : 0), len, height);

                ticker++;
                upgradeNum++;
            }

            // paged: centre on the full grid, so a short last page doesn't slide the buttons left
            if (pg.pages > 1) {
                const cols = Math.max(1, global.columnCount | 0);
                gridRight = Math.max(gridRight, xStart + cols * len + (cols - 1) * internalSpacing);
                rowWidth = Math.max(rowWidth, gridRight - len);
            }
            let h = 24,
                msg = "Don't upgrade",
                m = hudTitleW(msg, 13) + 24,
                buttonX = tp ? tp.x + tp.w / 2 : initialX + (rowWidth + len - initialX) / 2,
                buttonY = initialY + height + internalSpacing - 5;
            // the pager: "< +N more" back, page dots, a pulsing "+N more >" on
            if (pg.pages > 1) {
                const now = performance.now();
                const px = tp ? tp.x + tp.w / 2 : initialX + (gridRight - initialX) / 2, py = buttonY - 4;
                const ps = upGrid.pageSize(!!tp);
                const nextTxt = upGrid.nextLabel(gui.upgrades.length, pg, ps), prevTxt = upGrid.prevLabel(gui.upgrades.length, pg, ps);
                const L = upGrid.pagerLayout(px, py, pg.pages, prevTxt, nextTxt, (t, sz) => hudTitleW(t, sz), !!tp);
                const pulse = upGrid.pagerPulse(UG.seen, pg.pages);
                const c2 = ctx[2];
                global.clickables.upgradePage.hide();
                const big = (r, txt, index, glow) => {
                    if (glow) {
                        // a gold ring breathing out from the button
                        const ph = (now % 1100) / 1100, grow = 2 + ph * 7;
                        c2.save();
                        c2.globalAlpha *= 0.85 * (1 - ph);
                        c2.lineWidth = 3;
                        c2.strokeStyle = HUD.gold;
                        roundRectPath(c2, r.x - grow, r.y - grow, r.w + grow * 2, L.h + grow * 2, 8 + grow);
                        c2.stroke();
                        c2.restore();
                    }
                    const bob = glow ? Math.sin(now / 180) * 1.5 : 0;
                    hudButton(c2, r.x + r.w / 2, r.y, r.w, L.h, txt, { size: L.size + (glow ? 0.5 + bob * 0.3 : 0), type: "upgradePage", index, cr: clickableRatio, fill: HUD.gold, lipCol: HUD.goldDk, textCol: HUD.ink });
                };
                if (L.prev) big(L.prev, prevTxt, 0, false);
                if (L.next) big(L.next, nextTxt, 1, pulse);
                c2.save();
                for (let d = 0; d < pg.pages; d++) {
                    c2.beginPath();
                    c2.arc(L.dots.x + L.dots.gap / 2 + d * L.dots.gap, L.dots.y, d === pg.page ? 4.5 : 3.5, 0, Math.PI * 2);
                    c2.fillStyle = d === pg.page ? HUD.gold : "rgba(255,243,217,0.35)";
                    c2.fill();
                    c2.lineWidth = 1.5;
                    c2.strokeStyle = HUD.ink;
                    c2.stroke();
                }
                c2.restore();
                buttonY += pagerH;
                if (tp) {
                    const k = touchUnits();
                    if (L.prev) touch.zones.tilesPrev = { x: L.prev.x / k - 4, y: py / k - 6, w: L.prev.w / k + 8, h: L.h / k + 12, tap: () => { UG.page = upGrid.turn(UG.page, pg.pages, -1); } };
                    else delete touch.zones.tilesPrev;
                    if (L.next) touch.zones.tilesNext = { x: L.next.x / k - 4, y: py / k - 6, w: L.next.w / k + 8, h: L.h / k + 12, tap: () => { UG.page = upGrid.turn(UG.page, pg.pages, 1); } };
                    else delete touch.zones.tilesNext;
                }
            } else global.clickables.upgradePage.hide();
            // round 9: "Last tank: <Tank>" right next to it while you're below the tank you
            const ltLab = buildBtnLabels.lastTank(global.royale && global.royale.you, global.tutorialMode);
            const ltW = ltLab ? hudTitleW(ltLab, 13) + 24 : 0;
            if (ltLab) {
                const lx = buttonX - (m + 8 + ltW) / 2;
                buttonX = lx + m / 2;
                hudButton(ctx[2], lx + m + 8 + ltW / 2, buttonY, ltW, h, ltLab, { size: 13, type: "lastTank", index: 0, cr: clickableRatio, fill: HUD.play, lipCol: HUD.playDk, textCol: "#fff" });
            }
            // the quest card sits below this edge while the tiles are on screen
            if (glide > -0.5 && !tp) {
                global.upgradeBoxBottom = buttonY + h + 2.5 + 6;
                global.upgradeBoxTop = gridTop;
                global.upgradeBoxRight = gridRight;
            }

            // Tutorial: no decline. It only clears the menu locally, so the
            // evolve step would stall on a box the server never repopulates.
            if (!global.tutorialMode) hudButton(ctx[2], buttonX, buttonY, m, h, msg, { size: 13, type: "skipUpgrades", index: 0, cr: clickableRatio, textCol: HUD.text });

            if (gui.dailyTank && gui.dailyTank.tank) {
                let image = util.requestEntityImage(gui.dailyTank.tank, gui.color);
                let hover = global.clickables.dailyTankUpgrade.check({ x: global.mouse.x, y: global.mouse.y });
                image.upgradeColor = "36 0 1 0 false";
                drawUpgradeTile(image, xStart, initialY + height + internalSpacing + 50, len, height, 10, false, hover ? (global.clickables.clicked ? 2 : 1) : 0, upgradeSpin, 1, 1, true);
                hudTitle("Daily tank!", xStart + len / 2, initialY + height + internalSpacing + 40, 13, HUD.gold, "center");
                global.clickables.dailyTankUpgrade.set(xStart * clickableRatio, (initialY + height + internalSpacing + 50) * clickableRatio, len * clickableRatio, height * clickableRatio);
                gui.dailyTank.ads && drawButton(xStart + 50, initialY + height + internalSpacing + 160, m, h, 1, "rect", "Watch an ad", 9.8, false, false, false, true, "dailyTankAd", clickableRatio, false);
            }

            if (upgradeHoverIndex >= pg.start && upgradeHoverIndex < pg.end && upgradeHoverIndex < gui.upgrades.length && !global.mobile) {
                let picture = gui.upgrades[upgradeHoverIndex][2];
                // the name always (long ones shrink on the tile), Tier 5 says so
                const tipText = (goldOpts ? "Tier 5" + (picture.upgradeTooltip ? "\n" : "") : "") + (picture.upgradeTooltip || "");
                if (picture && picture.name) {
                    let boxWidth = measureText(picture.name, alcoveSize / 10),
                        boxX = global.mouse.x * global.screenWidth / global.canvas.width + 2,
                        boxY = global.mouse.y * global.screenHeight / global.canvas.height + 2,
                        boxPadding = 6,
                        splitTooltip = tipText ? tipText.split("\n") : [],
                        textY = boxY + boxPadding + alcoveSize / 10;

                    for (let line of splitTooltip) boxWidth = Math.max(boxWidth, measureText(line, alcoveSize / 15));

                    boxWidth = Math.max(boxWidth, hudTitleW(picture.name, alcoveSize / 10));
                    hudPanel(ctx[2], boxX, boxY, boxWidth + boxPadding * 3, alcoveSize * (splitTooltip.length + 1) / 10 + boxPadding * 3, { fill: HUD.solid, r: HUD.rSmall });
                    hudTitle(picture.name, boxX + boxPadding * 1.5, textY - alcoveSize / 30, alcoveSize / 10, goldOpts ? HUD.gold : HUD.head);

                    for (let t of splitTooltip) {
                        textY += boxPadding + alcoveSize / 15
                        drawText(t, boxX + boxPadding * 1.5, textY, alcoveSize / 15, t === "Tier 5" ? HUD.gold : HUD.text);
                    }
                }
            }
        } else {
            global.canUpgrade = false;
            upgradeMenu.force(0);
            global.clickables.upgrade.hide();
            global.clickables.skipUpgrades.hide();
            global.clickables.upgradePage.hide();
            if (global.upgradePg) global.upgradePg.pg = null;
            // Tier 4, Tier 5 not earned yet: the gold progress ring where the tiles go
            const st = t5RingUp();
            if (st && !global.mobile) {
                const cssPerUi = global.canvas.height / global.screenHeight / global.ratio;
                const topPad = Math.max(46, Math.ceil(63 / (cssPerUi || 1)) - spacing - 5);
                const x = spacing + 5, y = spacing + 5 + topPad;
                const r = drawT5Ring(ctx[2], x, y, st, performance.now());
                global.upgradeBoxTop = y;
                global.upgradeBoxBottom = y + r.h;
                global.upgradeBoxRight = x + r.w;
            }
        }
    }
    // the Tier 5 ring's state, or null (Tier 4 in a raid, not earned, alive, no tiles)
    function t5RingUp() {
        if (gui.upgrades.length || global.died || global.tutorialMode || !global.royale) return null;
        const st = upGrid.t5State(global.royale.you);
        return st && st.ring ? st : null;
    }
    // gold progress ring + "Grow to 2x to unlock Tier 5"
    function drawT5Ring(c, x, y, st, now, h = 58) {
        const title = upGrid.ringTitle(st), sub = upGrid.ringSub(st);
        const w = Math.round(h + 14 + Math.max(hudTitleW(title, 13), hudTextW(sub, 10.5)) + 16);
        hudPanel(c, x, y, w, h, { fill: HUD.solid, r: HUD.rSmall });
        const cx = x + h / 2 + 2, cy = y + h / 2, rr = h * 0.33;
        c.save();
        c.lineCap = "round";
        c.lineWidth = 5; c.strokeStyle = "rgba(0,0,0,0.55)";
        c.beginPath(); c.arc(cx, cy, rr, 0, Math.PI * 2); c.stroke();
        c.lineWidth = 5; c.strokeStyle = HUD.gold;
        c.beginPath(); c.arc(cx, cy, rr, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0.02, st.progress)); c.stroke();
        // the head of the ring breathes so it reads as live
        const a = -Math.PI / 2 + Math.PI * 2 * Math.max(0.02, st.progress);
        c.globalAlpha = 0.55 + 0.45 * Math.sin(now / 300);
        c.beginPath(); c.arc(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, 4, 0, Math.PI * 2); c.fillStyle = HUD.gold; c.fill();
        c.restore();
        hudTitle("T5", cx, cy, 13, HUD.gold, "center");
        hudTitle(title, x + h + 12, y + h * 0.36, 13, HUD.gold, "left");
        drawText(sub, x + h + 12, y + h * 0.7, 10.5, HUD.text2, "left", true);
        return { w, h };
    }
    // a Tier 5 option: gold keyline and a gold pip top right
    function drawT5Pip(c, x, y, len, height) {
        const k = len / 100, r = Math.max(3, 10 * k);
        c.save();
        c.lineWidth = Math.max(1.5, 2.5 * k);
        c.strokeStyle = HUD.gold;
        roundRectPath(c, x, y, len, height - UPG_LIP * k, r);
        c.stroke();
        const pr = Math.max(3, 5 * k), px = x + len - 9 * k, py = y + 9 * k;
        c.beginPath(); c.arc(px, py, pr + 1.5 * k, 0, Math.PI * 2); c.fillStyle = HUD.ink; c.fill();
        c.beginPath(); c.arc(px, py, pr, 0, Math.PI * 2); c.fillStyle = HUD.gold; c.fill();
        c.restore();
    }

    // ── touch HUD (phones and tablets) ─────────────────────────────────
    // touch.js owns the input and the button geometry (CSS px); this draws
    // it in HUD units. touchUnits() is HUD units per CSS pixel.
    // (window.innerWidth can force a layout, so it is read once a frame)
    let touchK = 1;
    function touchUnits() { return touchK; }
    const touchStats = { open: false, at: 0, seenPoints: 0 };
    const touchHint = { move: false, aim: false };
    try { touchHint.move = touchHint.aim = localStorage.getItem("dwTouchSticks") === "1"; } catch (e) { }
    function touchMinimapRect() {
        // upright there is less width: the button row needs its share
        const k = touchUnits(), len = global.screenHeight > global.screenWidth ? 136 : 160;
        const sa = touch.L ? touch.L.safe : { r: 0, t: 0 };
        return { x: global.screenWidth - Math.max(HUD.edge * 0.6, sa.r * k + 8) - len, y: Math.max(HUD.edge * 0.6, sa.t * k + 8), w: len, h: len };
    }
    // the chips on the left edge ("New tank", "Stats") start here; the cards stay above
    function touchChipBase() {
        return Math.round(global.screenHeight * (global.screenHeight > global.screenWidth ? 0.62 : 0.5));
    }
    function touchChipH() { return 44 * touchUnits() * 0.95; }
    function touchLeftFloor() {
        return touchChipBase() - (gui.upgrades.length > 0 || t5RingUp() ? touchChipH() + 10 : 0);
    }
    const touchTiles = { open: false, seen: "" };
    touch.closeTiles = () => { touchTiles.open = false; };
    // the tank picker: opens from its chip, and on its own in the tutorial
    // After a pick it stays up while the server sends the next tier's
    // choices, and closes once there are none (or on X, or a tap outside).
    function touchTilesOpen() {
        const justPicked = performance.now() - (global.upgradePickedAt || -1e9) < 1500;
        if (!gui.upgrades.length) { if (!justPicked) touchTiles.open = false; return false; }
        const key = gui.upgrades.map(u => u[2] && u[2].name).join("|");
        if (key !== touchTiles.seen) {
            touchTiles.seen = key;
            touchTiles.open = !!global.tutorialMode || (touchTiles.open && justPicked);
            if (touchTiles.open && justPicked) touchTiles.nextAt = performance.now();
        }
        return touchTiles.open;
    }
    // top of the kit buttons: the message stack stops above them
    function touchRightTop() {
        const L = touch.L;
        if (!L) return global.screenHeight * 0.45;
        const k = touchUnits();
        const top = L.kit2 ? L.kit2.y - L.kit2.h / 2 : L.arm.y - L.arm.r;
        return top * k;
    }
    function drawTouchStick(c, s, kind, k, now) {
        const R = STICK.R * k;
        const ox = s.ox * k, oy = s.oy * k;
        let dx = (s.x - s.ox) * k, dy = (s.y - s.oy) * k;
        const d = Math.hypot(dx, dy);
        if (d > R) { dx *= R / d; dy *= R / d; }
        const push = Math.min(1, d / R);
        const hot = kind === "aim" ? (s.firing ? HUD.copper : HUD.gold) : HUD.sky;
        const rgb = kind === "aim" ? (s.firing ? "224,123,46" : "242,184,60") : "78,196,232";
        c.save();
        // base: a dark see-through disc with a fine rim and the dead zone ring
        c.globalAlpha = 0.55;
        c.beginPath(); c.arc(ox, oy, R, 0, Math.PI * 2);
        c.fillStyle = "rgba(0,0,0,0.5)"; c.fill();
        c.lineWidth = 2; c.strokeStyle = "rgba(255,243,217,0.35)"; c.stroke();
        c.globalAlpha = 0.35;
        c.beginPath(); c.arc(ox, oy, R * STICK.DEAD, 0, Math.PI * 2);
        c.lineWidth = 1.5; c.strokeStyle = "rgba(255,243,217,0.5)"; c.stroke();
        // the rim lights up the way you push
        if (push > STICK.DEAD) {
            const a = Math.atan2(dy, dx);
            c.globalAlpha = 0.35 + 0.55 * push;
            c.beginPath(); c.arc(ox, oy, R - 2, a - 0.55, a + 0.55);
            c.lineWidth = 5; c.lineCap = "round"; c.strokeStyle = hot; c.stroke();
        }
        // knob with a soft glow under it
        const kx = ox + dx, ky = oy + dy, kr = R * 0.44;
        if (!config.graphical.noGlow) {
            c.globalAlpha = 0.25 + 0.45 * push;
            const hr = kr * 2.4;
            c.drawImage(haloSprite("stick|" + rgb, rgb, [[0, 0.7], [0.5, 0.25], [1, 0]]), kx - hr, ky - hr, hr * 2, hr * 2);
        }
        c.globalAlpha = 0.92;
        c.beginPath(); c.arc(kx, ky + 2, kr, 0, Math.PI * 2);
        c.fillStyle = HUD.faceDk; c.fill();
        c.beginPath(); c.arc(kx, ky, kr, 0, Math.PI * 2);
        c.fillStyle = push > STICK.DEAD ? hot : HUD.face; c.fill();
        c.lineWidth = 1.5; c.strokeStyle = HUD.line; c.stroke();
        c.beginPath(); c.arc(kx, ky - kr * 0.18, kr * 0.62, Math.PI * 1.1, Math.PI * 1.9);
        c.lineWidth = 2; c.strokeStyle = "rgba(255,255,255,0.28)"; c.stroke();
        c.restore();
    }
    // where the aim lands, a small ring (it snaps a little with aim assist)
    function drawTouchReticle(c, now) {
        const t = global.target;
        const sw = global.screenWidth, sh = global.screenHeight;
        const kk = sw / Math.max(1, global.canvas.width);
        const x = sw / 2 + (global.player.screenx || 0) * 0 + t.x * kk, y = sh / 2 + t.y * kk;
        c.save();
        c.globalAlpha = 0.7;
        c.lineWidth = 2; c.strokeStyle = HUD.head;
        const r = 9 + Math.sin(now / 140) * 1.2;
        c.beginPath();
        for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2 + Math.PI / 4; c.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r); c.lineTo(x + Math.cos(a) * (r + 6), y + Math.sin(a) * (r + 6)); }
        c.stroke();
        c.globalAlpha = 0.9;
        c.beginPath(); c.arc(x, y, 2.5, 0, Math.PI * 2); c.fillStyle = HUD.head; c.fill();
        c.restore();
    }
    function drawTouchKit(c, L, k, now) {
        const sh = global.shop, st = sh.state || {};
        const catalog = sh.catalog || [];
        const ko = st.kitOrder || [];
        if (!touch.buttonShown("kit0")) return;
        {
            const a = L.kit0, b = L.kit2;
            const x0 = Math.min(a.x, b.x) - a.w / 2, y0 = Math.min(a.y, b.y) - a.h / 2;
            hudDrawn.kit = { x: x0 * k, y: y0 * k, w: (Math.max(a.x, b.x) + a.w / 2 - x0) * k, h: (Math.max(a.y, b.y) + a.h / 2 - y0) * k };
        }
        for (let i = 0; i < 3; i++) {
            const b = L["kit" + i];
            const id = ko[i];
            const item = id ? catalog.find(it => it.id === id) : null;
            const w = b.w * k, h = b.h * k, x = b.x * k - w / 2, y = b.y * k - h / 2;
            const held = [...touch.btn.values()].includes("kit" + i);
            // only while a finger is still on it: a drag left over from a
            // missed release must never hide the icon of whatever lands here
            const drag = held && global.kitDrag && global.kitDrag.slot === i;
            c.save();
            c.globalAlpha = item ? 1 : 0.4;
            const armed = touch.place && touch.place.slot === i;
            hudPanel(c, x, y + (held ? 2 : 0), w, h, { r: 12, fill: held || armed ? HUD.raised : HUD.panel });
            if (armed) {
                c.save();
                c.globalAlpha = 0.75 + 0.25 * Math.sin(now / 160);
                roundRectPath(c, x - 3, y - 3, w + 6, h + 6, 14);
                c.lineWidth = 3; c.strokeStyle = HUD.gold; c.stroke();
                c.restore();
            }
            if (item) {
                const fl = sh.slotFlash && sh.slotFlash[id];
                const flT = fl ? Math.max(0, 1 - (now - fl.at) / 650) : 0;
                if (flT > 0) {
                    c.globalAlpha = flT * 0.8;
                    roundRectPath(c, x - 4 * (1 - flT), y - 4 * (1 - flT), w + 8 * (1 - flT), h + 8 * (1 - flT), 13);
                    c.lineWidth = 2; c.strokeStyle = fl.kind === "use" ? "#fff" : HUD.gold; c.stroke();
                    c.globalAlpha = 1;
                }
                if (!drag && global.kitUnlockHeld !== item.id) drawKitIcon(c, item.id, x + w / 2, y + h * 0.46 + (held ? 2 : 0), Math.min(w, h) * 0.5);
                kitSlotIcons[item.id] = { x: x + w / 2, y: y + h * 0.46, w, h, sx: x, sy: y, at: now };
                const n = st.kit[id] | 0;
                if (n > 1) {
                    const bw = Math.max(20, hudTitleW("x" + n, 11) + 10);
                    hudWell(c, x + w - bw + 4, y - 6, bw, 17, 8, HUD.wellSolid, HUD.ink, 2);
                    drawText("x" + n, x + w - bw / 2 + 4, y + 2.5, 10.5, color.teal, "center", true);
                }
                drawText(labelCase(KIT_SHORT[item.id] || item.name.slice(0, 7)), x + w / 2, y + h - 9, 9, color.guiwhite, "center", true);
                // the server's short use cooldown as a sweep
                const used = fl && fl.kind === "use" ? now - fl.at : 1e9;
                if (used < 600) {
                    c.globalAlpha = 0.5;
                    c.beginPath(); c.moveTo(x + w / 2, y + h / 2);
                    c.arc(x + w / 2, y + h / 2, Math.max(w, h), -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (1 - used / 600));
                    c.closePath();
                    c.save(); roundRectPath(c, x, y, w, h, 12); c.clip();
                    c.fillStyle = "rgba(0,0,0,0.6)"; c.fillRect(x, y, w, h);
                    c.restore();
                }
            } else {
                c.globalAlpha = 0.5;
                roundRectPath(c, x + w / 2 - w * 0.2, y + h * 0.46 - w * 0.2, w * 0.4, w * 0.4, 6);
                c.setLineDash([3, 3]); c.lineWidth = 1; c.strokeStyle = "#fff"; c.stroke(); c.setLineDash([]);
            }
            c.restore();
        }
        // dragging a kit card out: it follows the thumb, far enough out it reads DROP
        const dk = global.kitDrag;
        if (dk && dk.touch && touch.lastDrag) {
            const id = ko[dk.slot], b = L["kit" + dk.slot];
            if (id && b) {
                const mx = touch.lastDrag.x, my = touch.lastDrag.y;
                const far = Math.hypot(mx - b.x, my - b.y) > b.w * 1.8;
                if (Math.hypot(mx - b.x, my - b.y) > 10) {
                    c.save(); c.globalAlpha = 0.9;
                    drawKitIcon(c, id, mx * k, my * k - 30, 30);
                    c.restore();
                    if (far) hudTitle("Drop", mx * k, my * k + 2, 13, "#ff9a8c", "center");
                }
            }
        }
    }
    // Placing an aimed kit item (touch.js place): the range ring round the
    // tank, the landing spot under the finger (red past the ring, where it is
    // held to the edge), and a prompt with a cancel key above the wallet row.
    function drawTouchPlace(c, k, now) {
        const p = touch.place;
        if (!p) return;
        global.hudCardUp = "place";
        const sw = global.screenWidth, sh = global.screenHeight, cx = sw / 2, cy = sh / 2;
        const spec = AIMED_KIT[p.id] || {};
        const wpc = touch.worldPerCss();
        const R = p.max / wpc * k;
        const pulse = 0.5 + 0.5 * Math.sin(now / 300);
        c.save();
        c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2);
        c.globalAlpha = 0.07; c.fillStyle = HUD.gold; c.fill();
        c.globalAlpha = 0.55 + 0.25 * pulse;
        c.setLineDash([14, 10]); c.lineDashOffset = -now / 40;
        c.lineWidth = 5; c.strokeStyle = HUD.ink; c.stroke();
        c.lineWidth = 2.5; c.strokeStyle = HUD.gold; c.stroke();
        c.setLineDash([]);
        c.restore();
        const s = touch.placeSpot();
        if (s) {
            const x = cx + s.dx * k, y = cy + s.dy * k;
            const col = s.out ? "#ff9a8c" : HUD.gold;
            c.save();
            // the throw, from the tank
            c.beginPath(); c.moveTo(cx, cy); c.lineTo(x, y);
            c.setLineDash(spec.line ? [] : [8, 8]);
            c.lineCap = "round";
            c.globalAlpha = 0.8;
            c.lineWidth = spec.line ? 7 : 4.5; c.strokeStyle = HUD.ink; c.stroke();
            c.lineWidth = spec.line ? 3.5 : 2; c.strokeStyle = col; c.stroke();
            c.setLineDash([]);
            // what it hits: the charge's blast, or the barrage's crosshair
            const br = spec.blast ? spec.blast / wpc * k : 18;
            c.beginPath(); c.arc(x, y, br, 0, Math.PI * 2);
            c.globalAlpha = 0.2 + 0.08 * pulse; c.fillStyle = col; c.fill();
            c.globalAlpha = 1;
            c.lineWidth = 5; c.strokeStyle = HUD.ink; c.stroke();
            c.lineWidth = 2.5; c.strokeStyle = col; c.stroke();
            c.beginPath();
            for (let i = 0; i < 4; i++) {
                const a = i * Math.PI / 2;
                c.moveTo(x + Math.cos(a) * 5, y + Math.sin(a) * 5);
                c.lineTo(x + Math.cos(a) * 13, y + Math.sin(a) * 13);
            }
            c.lineWidth = 5; c.strokeStyle = HUD.ink; c.stroke();
            c.lineWidth = 2.5; c.strokeStyle = "#fff"; c.stroke();
            if (s.out) {
                // the finger is past the range: a faint line out to it and a red x
                const fx = cx + s.fx * k, fy = cy + s.fy * k;
                c.beginPath(); c.moveTo(x, y); c.lineTo(fx, fy);
                c.globalAlpha = 0.5; c.setLineDash([4, 6]);
                c.lineWidth = 2; c.strokeStyle = "#ff9a8c"; c.stroke();
                c.setLineDash([]);
                c.globalAlpha = 0.9;
                c.beginPath();
                c.moveTo(fx - 7, fy - 7); c.lineTo(fx + 7, fy + 7); c.moveTo(fx + 7, fy - 7); c.lineTo(fx - 7, fy + 7);
                c.lineWidth = 5; c.strokeStyle = HUD.ink; c.stroke();
                c.lineWidth = 2.5; c.strokeStyle = "#ff9a8c"; c.stroke();
            }
            c.restore();
        }
        // the prompt
        const item = (global.shop.catalog || []).find(it => it.id === p.id);
        const line = !s ? "Tap where to deploy" : s.out ? "Too far, so it will land on the ring" : "Lift your finger to deploy";
        const sub = (item ? item.name : "Ability") + "  \u00b7  range " + p.max;
        const cbs = 30, pw = Math.max(hudTitleW(line, 19), hudTextW(sub, 11.5)) + 34 + cbs + 10, ph = 54;
        // low in the middle, above the carried / banked row (where the
        // first-raid card sits; it steps aside meanwhile), off the tank
        const px = Math.round(cx - pw / 2), py = Math.round((touch.viewH() - 58) * k - ph);
        hudPanel(c, px, py, pw, ph, { fill: HUD.solid, r: HUD.rBig });
        hudTitle(line, px + 16, py + 20, 19, s && s.out ? "#ff9a8c" : HUD.gold, "left");
        drawText(sub, px + 16, py + 41, 11.5, HUD.text2, "left", true);
        hudButton(c, px + pw - 10 - cbs / 2, py + (ph - cbs) / 2, cbs, cbs, "X", { fill: HUD.danger, lipCol: HUD.dangerDk, textCol: "#fff", size: 15 });
        touch.zones.placeCancel = { x: (px + pw - 10 - cbs) / k - 8, y: (py + (ph - cbs) / 2) / k - 8, w: cbs / k + 16, h: cbs / k + 16, tap: () => { touch.place = null; } };
    }
    function drawTouchArm(c, L, k, now) {
        if (!touch.buttonShown("arm")) return;
        const st = global.shop.state || {};
        const item = (global.shop.catalog || []).find(it => it.id === st.arm);
        const b = L.arm;
        const x = b.x * k, y = b.y * k, r = b.r * k;
        const held = touch.armHeld;
        const on = touch.armOn;
        c.save();
        c.globalAlpha = 1;
        c.beginPath(); c.arc(x, y + 3, r, 0, Math.PI * 2); c.fillStyle = HUD.drop; c.fill();
        c.beginPath(); c.arc(x, y + (held ? 2 : 0), r, 0, Math.PI * 2);
        c.fillStyle = held ? HUD.copperDk : on ? HUD.copper : HUD.panel; c.fill();
        c.lineWidth = 1.5; c.strokeStyle = HUD.line; c.stroke();
        // burn-out ring for timed sidearms, a full ring for permanent ones
        const left = st.armUntil > 0 ? Math.max(0, st.armUntil - Date.now()) / 150000 : 1;
        c.beginPath(); c.arc(x, y + (held ? 2 : 0), r - 4, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, left));
        c.lineWidth = 3.5; c.lineCap = "round"; c.strokeStyle = left < 0.2 && (now % 600) < 300 ? "#ff9a8c" : HUD.gold; c.stroke();
        c.restore();
        const nm = item ? shortName(item.name, 10) : "Sidearm";
        let fs = 13; while (fs > 8 && hudTitleW(nm, fs) > r * 1.7) fs -= 0.5;
        hudTitle(nm, x, y - 3 + (held ? 2 : 0), fs, HUD.head, "center");
        hudTitle(on ? "Auto" : "Hold", x, y + 12 + (held ? 2 : 0), 9, on ? HUD.head : HUD.text2, "center");
    }
    // First time each chip shows up, a pointer says what it does; tapping the
    // chip once retires it for good.
    const chipHint = { tiles: false, stats: false };
    const CHIP_HINT_TURN = 5000;   // ms each pointer holds while both are new
    let chipHintBoth = 0;
    try { Object.assign(chipHint, JSON.parse(localStorage.getItem("dwChipHints_v1") || "{}")); } catch (e) { }
    function chipHintDone(id) {
        if (chipHint[id]) return;
        chipHint[id] = true;
        try { localStorage.setItem("dwChipHints_v1", JSON.stringify(chipHint)); } catch (e) { }
    }
    // A plate to the right of the chip, its notch pointing back at it (the
    // coach's tag style).
    function drawChipPointer(c, b, text, now) {
        const size = 15, ph = 28, pw = hudTitleW(text, size) + 26;
        const bob = Math.sin(now / 240) * 3;
        const x = b.x + b.w + 18 + bob, y = b.y + b.h / 2 - ph / 2;
        c.save();
        c.beginPath();
        const ny = y + ph / 2;
        c.moveTo(x - 10, ny); c.lineTo(x + 3, ny - 8); c.lineTo(x + 3, ny + 8);
        c.closePath();
        c.fillStyle = HUD.gold; c.fill();
        c.lineWidth = 2; c.strokeStyle = HUD.ink; c.stroke();
        c.restore();
        hudPanel(c, x, y, pw, ph, { r: ph / 2, fill: HUD.solid, lip: 2.5, bevel: false });
        hudTitle(text, x + pw / 2, y + ph / 2, size, HUD.gold, "center");
    }
    // Stats on touch: a chip on the left edge; a tap opens two columns of big
    // cells over the lower left. Tap a cell to put a point in it.
    function drawTouchStats(k, now) {
        const c = ctx[2];
        global.touchPanelRight = 0;
        global.touchTilesOpen = !!(touchTiles.open && gui.upgrades.length);
        global.clickables.stat.hide();
        let statsOk = true;
        if (global.tutorialMode) {
            const allow = window.dwTutAllow || "", ui = window.dwTutUi || "";
            if (!allow.includes("stats") && !ui.startsWith("skill") && !ui.startsWith("stat") && ui !== "points") statsOk = false;
        }
        const pts = gui.points | 0;
        const canAny = statsOk && pts > 0 && gui.skills.some(s => s.softcap > 0 && s.amount < s.cap);
        if (!statsOk) touchStats.open = false;
        if (!touch.playing() || raidFinale.hidesHud() || global.showBigMap) { touchStats.open = false; return; }
        if (touchStats.open && !canAny && now - touchStats.at > 1200) touchStats.open = false;
        if (touchStats.open && now - touchStats.at > 10000) touchStats.open = false;
        const sa = touch.L ? touch.L.safe : { l: 0 };
        const x0 = Math.max(HUD.edge * 0.6, sa.l * k + 8);
        const chipH = touchChipH();
        // One first-time pointer at a time: New tank first, then Stats (they
        // take turns every few seconds while both are new). None while the
        // first-raid card points somewhere else; on its "Upgrade your tank"
        // step this pointer is its pointer, even once retired.
        const coachStep = global.coachPointing || "";
        const forced = coachStep === "upgrade", blocked = !!coachStep && !forced;
        const tilesUp = gui.upgrades.length > 0 && !touchTiles.open && !touchStats.open;
        const statsUp = !touchStats.open && canAny;
        // (Oct 8: the pointers are for the first raids; a veteran's chips speak for themselves)
        const wants = id => !blocked && (forced || (!chipHint[id] && (global.nxStage == null ? 3 : global.nxStage | 0) < 3));
        const tw = tilesUp && wants("tiles"), sw2 = statsUp && wants("stats");
        let pointAt = null;
        if (tw && sw2) {
            if (!chipHintBoth) chipHintBoth = now;
            pointAt = ((now - chipHintBoth) / CHIP_HINT_TURN | 0) % 2 ? "stats" : "tiles";
        } else {
            chipHintBoth = 0;
            pointAt = tw ? "tiles" : sw2 ? "stats" : null;
        }
        global.chipPointAt = pointAt;   // QA: which chip has the pointer
        // A chip is a real button: a raised key with a glyph cap (gold arrow
        // for a new tank, the stat panel's green + for points), a pulsing
        // ring while there is something to do, and a count badge.
        const chip = (id, y, label, badge, glyph, tap) => {
            const cap = chipH - 12;
            const bw = badge ? hudTitleW(badge, 15) + 14 : 0;
            const cw = 8 + cap + 10 + hudTitleW(label, 17) + (badge ? 10 + bw + 8 : 16);
            const pulse = 0.5 + 0.5 * Math.sin(now / 260);
            const held = [...touch.btn.values()].includes(id);
            c.save();
            if (!config.graphical.noGlow) {
                c.globalAlpha = 0.3 + 0.3 * pulse;
                const hr = cw;
                c.drawImage(haloSprite("statchip|242,184,60", "242,184,60", [[0, 0.5], [0.5, 0.18], [1, 0]]), x0 + cw / 2 - hr, y + chipH / 2 - hr * 0.6, hr * 2, hr * 1.2);
            }
            c.restore();
            hudButton(c, x0 + cw / 2, y + (held ? 2 : 0), cw, chipH, "", { fill: HUD.raised, lipCol: HUD.faceDk, r: chipH / 2 });
            // the ring breathes out from the chip
            c.save();
            c.globalAlpha = 0.85 * (1 - ((now / 1100) % 1));
            const g = 3 + 7 * ((now / 1100) % 1);
            roundRectPath(c, x0 - g, y - g, cw + 2 * g, chipH + 2 * g, chipH / 2 + g);
            c.lineWidth = 2; c.strokeStyle = HUD.gold; c.stroke();
            c.restore();
            const cx0 = x0 + 8, cy0 = y + 5 + (held ? 2 : 0);
            const green = glyph === "plus";
            hudButton(c, cx0 + cap / 2, cy0, cap, cap, "", { fill: green ? HUD.play : HUD.gold, lipCol: green ? HUD.playDk : HUD.goldDk, r: cap * 0.3 });
            // the glyph, ink-rimmed like the rest of the HUD
            const gx = cx0 + cap / 2, gy = cy0 + (cap - 4) / 2, gs = cap * 0.26;
            c.save();
            c.beginPath();
            if (green) { c.moveTo(gx - gs, gy); c.lineTo(gx + gs, gy); c.moveTo(gx, gy - gs); c.lineTo(gx, gy + gs); }
            else { c.moveTo(gx - gs, gy + gs * 0.45); c.lineTo(gx, gy - gs * 0.65); c.lineTo(gx + gs, gy + gs * 0.45); }
            c.lineCap = "round"; c.lineJoin = "round";
            c.lineWidth = 6; c.strokeStyle = HUD.ink; c.stroke();
            c.lineWidth = 3.2; c.strokeStyle = "#fff"; c.stroke();
            c.restore();
            const lx = cx0 + cap + 10;
            hudTitle(label, lx, y + chipH / 2 - 1 + (held ? 2 : 0), 17, HUD.head, "left");
            if (badge) {
                const bx = x0 + cw - bw - 8;
                hudWell(c, bx, y + chipH / 2 - 12 + (held ? 2 : 0), bw, 22, 11, HUD.gold, HUD.ink, 2);
                drawText(badge, bx + bw / 2, y + chipH / 2 - 1 + (held ? 2 : 0), 14, HUD.ink, "center", true, 1, false);
            }
            touch.zones[id] = { x: x0 / k, y: y / k, w: cw / k, h: chipH / k, tap: () => { chipHintDone(id); tap(); } };
            const r = { x: x0, y, w: cw, h: chipH };
            if (id === pointAt && !(global.shop && global.shop.onPad && !global.shop.dismissed)) drawChipPointer(c, r, id === "tiles" ? "Tap to upgrade your tank" : "Tap to spend your points", now);
            return r;
        };
        if (gui.upgrades.length > 0 && !touchTiles.open && !touchStats.open) {
            const t5g = upGrid.t5State(global.royale && global.royale.you);
            hudDrawn.upgrades = chip("tiles", touchChipBase() - chipH - 12, t5g && t5g.gold ? "Tier 5!" : "New tank!", "", "arrow", () => { touchTiles.open = true; touchStats.open = false; });
        }
        // Tier 4, Tier 5 not earned: the gold ring sits in the New tank chip's place
        const ring5 = !touchTiles.open && !touchStats.open ? t5RingUp() : null;
        if (ring5) { const ry = touchChipBase() - chipH - 12, rs = drawT5Ring(c, x0, ry, ring5, now, chipH); hudDrawn.upgrades = { x: x0, y: ry, w: rs.w, h: rs.h }; }
        if (!touchStats.open) {
            if (!canAny) return;
            hudDrawn.stats = touchStats.chip = chip("stats", touchChipBase(), "Stats", "+" + pts, "plus", () => { touchStats.open = true; touchStats.at = performance.now(); touchTiles.open = false; });
            return;
        }
        touch.zones.stats = null;
        let names;
        try { names = gui.getStatNames(global.mockups[parseInt(gui.type.split("-")[0])].statnames); }
        catch (e) { names = gui.getStatNames(global.missingno[0].statnames); }
        // desktop order: stats 1..9, 0, then Mining Power
        const cells = [];
        for (let i = 0; i < gui.skills.length; i++) {
            const sk = gui.skills[i];
            if (!(sk.softcap > 0)) continue;
            const statIdx = i === 10 ? 10 : 9 - i;
            cells.push({ sk, statIdx, name: names[statIdx] });
        }
        cells.sort((a, b) => a.statIdx - b.statIdx);
        const portrait = global.screenHeight > global.screenWidth;
        const cols = 2, rows = Math.ceil(cells.length / cols);
        // upright: leave the kit and sidearm column on the right uncovered
        const rightCol = portrait && touch.L ? (touch.L.unit + 30) * k : 0;
        const cellW = Math.min(portrait ? (global.screenWidth - x0 * 2 - 30 - rightCol) / 2 : 190, 220), cellH = Math.max(34, 40 * k * 0.95), gap = 6;
        const W = cols * cellW + (cols - 1) * gap + 20, H = rows * cellH + (rows - 1) * gap + 58;
        const px = x0, py = Math.max(56, global.screenHeight - Math.max(HUD.edge * 0.6, (touch.L ? touch.L.safe.b : 0) * k + 8) - H);
        hudPanel(c, px, py, W, H, { fill: HUD.solid, r: HUD.rBig });
        hudTitle("Stats", px + 12, py + 18, 17, HUD.head, "left");
        drawText(pts ? pts + (pts === 1 ? " point" : " points") + " to spend" : "All spent", px + 64, py + 19, 11, pts ? HUD.gold : HUD.text2, "left", true);
        drawText("Tap a + to get stronger.", px + 12, py + 39, 11, HUD.text2, "left", true);
        // close
        const cbs = 30;
        hudButton(c, px + W - 10 - cbs / 2, py + 5, cbs, cbs, "X", { fill: HUD.danger, lipCol: HUD.dangerDk, textCol: "#fff", size: 15 });
        touch.zones.statsClose = { x: (px + W - 10 - cbs) / k - 6, y: (py + 5) / k - 6, w: cbs / k + 12, h: cbs / k + 12, tap: () => { touchStats.open = false; } };
        const cr = global.canvas.height / global.screenHeight / global.ratio;
        // round 9: Same stats / Random in the header, left of the close button
        {
            const sb = buildBtnLabels.statButtons(global.royale && global.royale.you, pts, global.died, global.tutorialMode);
            if (sb.length && royaleActive()) drawStatBuildButtons(sb, px + W - 10 - cbs - 8, py + 21, px + 70 + measureText(pts + " points to spend", 11), cr);
        }
        for (let n = 0; n < cells.length; n++) {
            const { sk, statIdx, name } = cells[n];
            const cx = px + 10 + (n % cols) * (cellW + gap), cy = py + 50 + ((n / cols) | 0) * (cellH + gap);
            const tutLocked = global.tutorialMode && window.dwTutStatOpen && !window.dwTutStatOpen(statIdx);
            const can = pts > 0 && sk.amount < sk.cap && !(sk.cap !== sk.softcap && sk.amount >= sk.softcap) && !tutLocked;
            const col = color[sk.color];
            c.save();
            c.globalAlpha = tutLocked ? 0.35 : 1;
            hudWell(c, cx, cy, cellW, cellH, 8, HUD.well, HUD.ink, 2);
            // level bar along the bottom
            const frac = sk.softcap ? Math.min(1, sk.amount / sk.softcap) : 0;
            hudBar(c, cx + 8, cy + cellH - 11, cellW - cellH - 10, 6, frac, col);
            c.restore();
            let ns = 12.5; while (ns > 8.5 && hudTitleW(name, ns) > cellW - cellH - 18) ns -= 0.5;
            hudTitle(name, cx + 9, cy + (cellH - 12) / 2 + 1, ns, sk.amount >= sk.cap ? col : can ? HUD.head : HUD.text2, "left", tutLocked ? 0.35 : 1);
            // the + key on the right
            const bs = cellH - 8;
            hudButton(c, cx + cellW - 4 - bs / 2, cy + 4, bs, bs, sk.amount >= sk.cap ? "Max" : "+", can
                ? { fill: HUD.play, lipCol: HUD.playDk, textCol: "#fff", size: sk.amount >= sk.cap ? 10 : 20 }
                : { enabled: false, size: sk.amount >= sk.cap ? 10 : 18, textCol: HUD.text });
            if (can) global.clickables.stat.place(statIdx, cx * cr, cy * cr, cellW * cr, cellH * cr);
        }
        // the panel takes taps (not the stick) while it is up
        touch.uiRects.stats = { x: px / k, y: py / k, w: W / k, h: H / k };
        global.touchPanelRight = (px + W) / k;
        touchStats.panel = { x: px, y: py, w: W, h: H };
    }
    let touchSeenTap = 0;
    function drawTouchHud() {
        if (!global.gameStart) return;
        const c = ctx[2];
        const now = performance.now();
        const k = touchUnits();
        const L = touch.layout();
        touch.isFinale = () => raidFinale.active();
        drawTouchStats(k, now);
        if (!touch.playing() || raidFinale.hidesHud() || global.showBigMap) return;
        if (global.statTapAt && global.statTapAt !== touchSeenTap) { touchSeenTap = global.statTapAt; touchStats.at = now; }
        drawTouchKit(c, L, k, now);
        drawTouchArm(c, L, k, now);
        if (touch.buttonShown("dash")) abilityFx.drawTouch(c, L, k, (name) => [...touch.btn.values()].includes(name));
        drawTouchPlace(c, k, now);
        abilityFx.drawTouchTip(L, k, c);
        if (touch.move) { drawTouchStick(c, touch.move, "move", k, now); if (!touchHint.move) { touchHint.move = true; saveTouchHint(); } }
        if (touch.aim) { drawTouchStick(c, touch.aim, "aim", k, now); if (!touchHint.aim && touch.aim.firing) { touchHint.aim = true; saveTouchHint(); } }
        if (touch.aim && touch.aim.firing) drawTouchReticle(c, now);
        // first raids: ghost sticks show where the thumbs go (not over an open shop)
        const shopUp = !!(global.shop && global.shop.onPad && !global.shop.dismissed);
        if ((!touchHint.move || !touchHint.aim) && !shopUp) {
            const sw = global.screenWidth, sh = global.screenHeight;
            const bob = Math.sin(now / 500) * 4;
            const ghost = (x, y, label) => {
                c.save();
                c.globalAlpha = 0.3;
                c.beginPath(); c.arc(x, y, STICK.R * k, 0, Math.PI * 2);
                c.lineWidth = 2; c.setLineDash([6, 6]); c.strokeStyle = HUD.head; c.stroke(); c.setLineDash([]);
                c.beginPath(); c.arc(x, y + bob, STICK.R * k * 0.44, 0, Math.PI * 2);
                c.fillStyle = "rgba(255,243,217,0.4)"; c.fill();
                c.restore();
                hudTitle(label, x, y + STICK.R * k + 16, 14, HUD.head, "center", 0.75);
            };
            if (!touchHint.move && !touch.move) ghost(sw * 0.2, sh * 0.72, "Drag to move");
            // right of the middle, clear of the first-raid card, left of the kit buttons
            if (!touchHint.aim && !touch.aim) ghost(sw * (sh > sw ? 0.62 : 0.76), sh * 0.72, "Drag to aim and shoot");
        }
    }
    function saveTouchHint() {
        try { if (touchHint.move && touchHint.aim) localStorage.setItem("dwTouchSticks", "1"); } catch (e) { }
    }

    function drawCrosshair() {
        if (global.mobileStatus.showCrosshair && (global.mobileStatus.enableCrosshair || global.gamepadMode)) {
            const crosshairpos = {
                x: global.screenWidth / 2 + global.player.target.x,
                y: global.screenHeight / 2 + global.player.target.y
            };
            ctx[2].lineWidth = 1;
            ctx[2].globalAlpha = 1;
            gameDraw.setColor(ctx[2], color.black);
            ctx[2].beginPath();
            ctx[2].moveTo(crosshairpos.x, crosshairpos.y - 20);
            ctx[2].lineTo(crosshairpos.x, crosshairpos.y + 20);
            ctx[2].moveTo(crosshairpos.x - 20, crosshairpos.y);
            ctx[2].lineTo(crosshairpos.x + 20, crosshairpos.y);
            ctx[2].closePath();
            ctx[2].stroke();
        }
    }

    let drawAdScreen = () => {
        gameDraw.setColor(ctx[2], "#000");
        ctx[2].globalAlpha = 0.8;
        drawGuiRect(0, 0, global.screenWidth, global.screenHeight);
        let width = global.dailyTankAd.width;
        let height = global.dailyTankAd.height;
        let x = (global.screenWidth - width) / 2;
        let y = (global.screenHeight - height) / 2;
        ctx[2].globalAlpha = 1;
        gameDraw.setColor(ctx[2], "#000");
        drawGuiRect(x, y, width, height);
        gameDraw.setColor(ctx[2], color.grey);
        ctx[2].lineWidth = 3;
        drawGuiRect(x, y, width, height, true);
        if (global.dailyTankAd.readyToRender) {
            ctx[2].imageSmoothingEnabled = true;
            ctx[2].drawImage(global.dailyTankAd.render, x + 1.7, y + 1.7, width - 3.5, height - 3.6);
            ctx[2].imageSmoothingEnabled = false;
            if (global.dailyTankAd.isVideo) {
                if (!global.dailyTankAd.videoBar) {
                    global.dailyTankAd.videoBar = AdvancedSmoothBar(0, 4, 1);
                    global.dailyTankAd.videoBar.set(0);
                }
                const duration = global.dailyTankAd.render.duration;
                global.dailyTankAd.videoBar.set(global.dailyTankAd.render.currentTime);
                gameDraw.setColor(ctx[2], "#eafc47");
                drawGuiRect(x + 1.8, y + height - 22, (Math.min(width, global.dailyTankAd.render.currentTime * width / duration - 4)), 20.2);
            }
            if (global.dailyTankAd.closeable) {
                if (!global.dailyTankAd.closebtnAnim) {
                    global.dailyTankAd.closebtnAnim = AdvancedSmoothBar(0, 0.3, 1);
                    setTimeout(() => {
                        global.dailyTankAd.closebtnAnim.set(1);
                    }, 1000)
                }
                drawButton(x + width - 25, y + 7, 35, 35, global.dailyTankAd.closebtnAnim.get(), "rect", "✕", 24, color.red, color.red, false, true, "dailyTankCloseAd", global.canvas.height / global.screenHeight / global.ratio, false);
            }
        } else {
            drawText("Loading...", global.screenWidth / 2, global.screenHeight / 2, 40, "#fff", "center", false, 1, false);
        }
        let wwidth = global.dailyTankAd.width + 2;
        let hheight = 35;
        gameDraw.setColor(ctx[2], "#828282");
        ctx[2].globalAlpha = 0.5;
        drawGuiRect(x - 1.5, y + height + 10, wwidth, hheight);
        ctx[2].globalAlpha = 1;
        drawText("Watch the ad to get it", x + wwidth / 2, y + height + 34, 20, "#fff", "center", false, 1, false);
    }

    let getKills = () => {
        let finalKills = {
            " kills": [Math.round(global.finalKills[0].get()), 1],
            " assists": [Math.round(global.finalKills[1].get()), 0.5],
            " visitors defeated": [Math.round(global.finalKills[2].get()), 3],
            " structures destroyed": [Math.round(global.finalKills[3].get()), 3],
            " polygons destroyed": [Math.round(global.finalKills[4].get()), 0.05],
        }, killCountTexts = [];
        let destruction = 0;
        for (let key in finalKills) {
            if (finalKills[key][0]) {
                destruction += finalKills[key][0] * finalKills[key][1];
                killCountTexts.push(finalKills[key][0] + key);
            }
        }
        return !killCountTexts.length ? "A true pacifist" :
            killCountTexts.length == 1 ? killCountTexts.join(" and ") :
                killCountTexts.slice(0, -1).join(", ") + " and " + killCountTexts[killCountTexts.length - 1];
    };

    let getDeath = () => {
        let txt = "";
        if (global.finalKillers.length) {
            txt = "Killed by";
            for (let e of global.finalKillers) {
                const killerName = /^\d+(?:-\d+)*$/.test(String(e))
                    ? util.getEntityImageFromMockup(String(e)).name
                    : String(e);
                txt += " " + util.addArticle(killerName) + " and";
            }
            txt = txt.slice(0, -4);
        } else {
            txt += "Well that was kinda dumb huh";
        }
        return txt;
    };

    let getTips = () => global.finalKillers.length
        ? "lol you died"
        : "Bank at a vault. You drop what you carry when you die";

    // Small flat vector icons for the death screen - same visual language

    function drawDeathIcon(kind, x, y, s, a) {
        const c = ctx[2];
        c.save();
        c.globalAlpha = a;
        c.strokeStyle = color.guiwhite;
        c.fillStyle = color.guiwhite;
        c.lineWidth = 2;
        c.lineCap = "round";
        c.lineJoin = "round";
        switch (kind) {
            case "clock": {
                c.beginPath(); c.arc(x, y, s * 0.45, 0, Math.PI * 2); c.stroke();
                c.beginPath();
                c.moveTo(x, y); c.lineTo(x, y - s * 0.26);
                c.moveTo(x, y); c.lineTo(x + s * 0.18, y + s * 0.08);
                c.stroke();
                break;
            }
            case "combat": { 
                const r = s * 0.4;
                c.beginPath();
                c.moveTo(x - r, y - r); c.lineTo(x + r, y + r);
                c.moveTo(x + r, y - r); c.lineTo(x - r, y + r);
                c.stroke();
                c.beginPath();
                c.moveTo(x - r * 0.35, y + r); c.lineTo(x - r, y + r * 0.35);
                c.moveTo(x + r * 0.35, y + r); c.lineTo(x + r, y + r * 0.35);
                c.stroke();
                break;
            }
            case "skull": {
                const r = s * 0.38;
                c.beginPath(); c.arc(x, y - s * 0.06, r, 0, Math.PI * 2); c.fill();
                c.fillRect(x - r * 0.55, y + s * 0.02, r * 1.1, s * 0.3);
                c.fillStyle = "#0d0e14";
                c.beginPath();
                c.arc(x - r * 0.38, y - s * 0.1, r * 0.22, 0, Math.PI * 2);
                c.arc(x + r * 0.38, y - s * 0.1, r * 0.22, 0, Math.PI * 2);
                c.fill();
                break;
            }
            case "pickaxe": {
                // rocks mined: a pick struck through a chip of stone
                const r = s * 0.5;
                c.strokeStyle = color.guiwhite;
                c.lineWidth = 2;
                c.beginPath();
                c.moveTo(x - r * 0.85, y + r * 0.85);
                c.lineTo(x + r * 0.6, y - r * 0.6);
                c.stroke();
                c.beginPath();
                c.moveTo(x + r * 0.05, y - r * 0.95);
                c.quadraticCurveTo(x + r * 0.75, y - r * 0.5, x + r * 0.95, y + r * 0.1);
                c.stroke();
                break;
            }
            case "gem": { 
                const r = s * 0.5;
                c.fillStyle = color.gold;
                c.strokeStyle = color.black;
                c.lineWidth = 1.5;
                c.beginPath();
                c.moveTo(x - r, y - r * 0.38);
                c.lineTo(x - r * 0.55, y - r * 0.95);
                c.lineTo(x + r * 0.55, y - r * 0.95);
                c.lineTo(x + r, y - r * 0.38);
                c.lineTo(x, y + r * 0.95);
                c.closePath();
                c.fill(); c.stroke();
                break;
            }
            case "crown": {
                try { crowns.drawCrownIcon(c, x, y, s * 0.95, "gold", a); } catch (e) { /* */ }
                break;
            }
            case "pulse": { 
                c.beginPath();
                c.moveTo(x - s * 0.5, y);
                c.lineTo(x - s * 0.18, y);
                c.lineTo(x - s * 0.04, y - s * 0.34);
                c.lineTo(x + s * 0.12, y + s * 0.3);
                c.lineTo(x + s * 0.22, y);
                c.lineTo(x + s * 0.5, y);
                c.stroke();
                break;
            }
        }
        c.restore();
    }

    // ── Death screen ───────────────────────────────────────────────────────
    // One framed panel: portrait in its own recess on the left, run summary
    // on the right, in reserved columns so a wide tank never covers the text.
    // compactTime: "1h 04m", "2m 06s", "48s" (fits the tile)
    const compactTime = (secs) => {
        secs = Math.max(0, Math.round(secs));
        const h = (secs / 3600) | 0, m = ((secs % 3600) / 60) | 0, sc = secs % 60;
        if (h) return h + "h " + String(m).padStart(2, "0") + "m";
        if (m) return m + "m " + String(sc).padStart(2, "0") + "s";
        return sc + "s";
    };
    // Centre text at the largest size that still fits maxW, down to a floor.
    const fitText = (txt, cx, cy, size, maxW, col) => {
        const c = ctx[2];
        let s2 = size;
        c.font = "bold " + s2 + "px Ubuntu, sans-serif";
        let w = c.measureText(txt).width;
        while (w > maxW && s2 > 8) {
            s2 -= 0.5;
            c.font = "bold " + s2 + "px Ubuntu, sans-serif";
            w = c.measureText(txt).width;
        }
        drawText(txt, cx, cy, s2, col, "center");
    };
    const deathStat = (label, value, iconKind, bx, by, bw, alpha, bh = 40) => {
        const c = ctx[2];
        label = labelCase(label);
        c.save();
        c.globalAlpha = alpha;
        hudWell(c, bx, by, bw, bh, 8, HUD.well, HUD.ink, 2);
        c.restore();
        if (iconKind) drawDeathIcon(iconKind, bx + 20, by + bh / 2, 17, alpha);
        // shrink to fit the box: long labels and six-figure values both happen
        const maxW = bw - 50;
        let ls = 11; while (ls > 7.5 && hudTextW(label, ls) > maxW) ls -= 0.5;
        let vs = 17; while (vs > 9 && hudTitleW(value, vs) > maxW) vs -= 0.5;
        drawText(label, bx + 40, by + bh / 2 - 8, ls, HUD.text2, "left");
        hudTitle(value, bx + 40, by + bh / 2 + 7, vs, HUD.head, "left", alpha);
    };
    const roundRectPath = (c, x, y, w, h, r) => {
        // on a game layer, the sides land on whole device pixels: plates,
        // pills and bars get hard edges instead of half-blended ones
        if (c._tf && !crispOff && w > 0 && h > 0) {
            const t = tfOf(c);
            if (!t.b && !t.c && t.a > 0 && t.d > 0) {
                const a = t.a, d = t.d, x1 = Math.round((x + w) * a) / a, y1 = Math.round((y + h) * d) / d;
                x = Math.round(x * a) / a; y = Math.round(y * d) / d;
                w = Math.max(1 / a, x1 - x); h = Math.max(1 / d, y1 - y);
            }
        }
        r = Math.min(r, w / 2, h / 2);
        c.beginPath();
        c.moveTo(x + r, y);
        c.arcTo(x + w, y, x + w, y + h, r);
        c.arcTo(x + w, y + h, x, y + h, r);
        c.arcTo(x, y + h, x, y, r);
        c.arcTo(x, y, x + w, y, r);
        c.closePath();
    };

    // Everything that must sit above the whole interface: the leader arrow, the
    // team's enemy markers and the tutorial's off-screen pointer. Drawn after
    // all other GUI so nothing can paint over them.
    const drawTopIndicators = () => {
        // drawGUI has already put us in GUI space; calling scaleScreenRatio
        // again would divide screenWidth a second time every frame
        if (global.died || global.disconnected) return;
        if (global.GUIStatus.renderGUI) { try { drawDuoPings(); } catch (e) { /* */ } }
        if (global.GUIStatus.renderGUI && global.GUIStatus.renderPlayerBars) {
            drawLeaderArrow();
            drawEnemyPings();
        }
        try { tutorial.drawIndicators(); } catch (e) { }
        try { coach.drawIndicators(); } catch (e) { }
    };

    const gameDrawDead = () => {
        // the raid-end finale is on screen instead
        if (raidFinale.active()) {
            global.clickables.royaleSpectate.hide();
            global.clickables.deathRespawn.hide();
            global.clickables.royalePrev.hide();
            global.clickables.royaleNext.hide();
            global.clickables.royalePlay.hide();
            return;
        }
        // Spectating before the raid card came up (a Spectate click while the
        // death packet was still settling): no classic screen underneath.
        if (global.died && !global.royaleDied && global.royaleSpectating) {
            global.clickables.royaleSpectate.hide();
            global.clickables.deathRespawn.hide();
            global.clickables.royalePrev.hide();
            global.clickables.royaleNext.hide();
            global.clickables.royalePlay.hide();
            return;
        }
        // Royale owns its death screen (placement + spectate + home, no respawn).
        if (global.royaleDied && global.royaleSpectating) {
            global.clickables.royaleSpectate.hide();
            global.clickables.deathRespawn.hide();
            return;
        }
        // dead in the last storm when the raid's last ten seconds start: no
        // card, just the fight and the countdown, then the results
        if (global.royaleDied && lastStormCount()) {
            global.clickables.royaleSpectate.hide();
            global.clickables.deathRespawn.hide();
            global.clickables.royalePrev.hide();
            global.clickables.royaleNext.hide();
            global.clickables.royalePlay.hide();
            return;
        }
        if (global.royaleDied) {
            gameDrawDeadRoyale();
            return;
        }
        let glide = global.deathAnimation.get();
        clearScreen(color.black, 0.32 + 0.28 * global.lerp(0, 0.5, glide), ctx[2]);
        let ratio = util.getScreenRatio();
        scaleScreenRatio(ratio, true);

        const c = ctx[2];
        const cx = global.screenWidth / 2;
        const PW = Math.min(620, global.screenWidth - 40);
        const PH = 374;
        const px = cx - PW / 2;
        const py = Math.max(12, global.screenHeight / 2 - PH / 2 - 10)
                 - 700 * (1 - global.lerp(0, 1, glide));

        // panel
        hudPanel(c, px, py, PW, PH, { fill: HUD.solid, r: HUD.rBig + 2, lip: 5 });

        hudTitle("You died", cx, py + 32, 32, HUD.gold, "center");

        // ── left column: portrait recess + tank name ──────────────────────
        const COLW = 176;
        const lx = px + 22, ly = py + 62;
        c.save();
        hudWell(c, lx, ly, COLW, 210, 12, HUD.well, HUD.ink, 2);
        c.restore();
        try {
            const picture = mockupPicture(gui.type, gui.color);
            const position = global.mockups[parseInt(gui.type.split("-")[0])].position;
            const len = 104;
            const scale = len / position.axis;
            const pcx = lx + COLW / 2 - scale * position.middle.x * 0.707;
            const pcy = ly + 84 + scale * position.middle.y * Math.SQRT1_2;
            drawEntity(picture.color, (pcx + 0.5) | 0, (pcy + 0.5) | 0, picture,
                       1.5, 1, (0.5 * scale) / picture.realSize, 1, -Math.PI / 4, true, ctx[2]);
            drawText("TANK", lx + COLW / 2, ly + 136, 10, color.grey, "center");
            fitText(picture.name, lx + COLW / 2, ly + 153, 17, COLW - 16, color.guiwhite);
        } catch (e) { }

        const name = global.player.name.substring(7, global.player.name.length + 1);
        drawText("MINER", lx + COLW / 2, ly + 180, 10, color.grey, "center");
        // names run to 24 characters: shrink to fit the column
        fitText(name === "" ? "You" : name, lx + COLW / 2, ly + 198, 16, COLW - 16, color.guiwhite);

        // ── right column: the run in numbers ──────────────────────────────
        const rx = lx + COLW + 18;
        const rw = px + PW - 22 - rx;
        let ry = py + 62;

        // headline score
        c.save();
        c.globalAlpha = global.lerp(0, 1, glide);
        hudWell(c, rx, ry, rw, 58, 10, "rgba(242,184,60,0.12)", HUD.ink, 2.5);
        c.restore();
        drawText("SCORE", rx + 14, ry + 15, 11, color.grey, "left");
        drawText(util.formatLargeNumber(Math.round(global.finalScore.get())),
                 rx + 14, ry + 41, 24, color.gold, "left");
        ry += 68;

        // score is carried plus banked, so both are shown separately
        const half = (rw - 8) / 2;
        const rows = [
            ["CARRIED AT DEATH", String(global.finalCarried | 0), "gem"],
            // one meaning per number: this raid's banked in a raid, else the bank
            (global.royale && global.royale.you && global.royale.you.banked != null)
                ? [aoHud.on() ? "BANKED TODAY" : "BANKED THIS RAID", String(global.royale.you.banked | 0), "gem"]
                : [scoreText.BANK.toUpperCase(), String(global.finalBanked | 0), "gem"],
            ["ROCKS MINED", String(global.finalRocks | 0), "pickaxe"],
            ["SURVIVED", compactTime(global.finalLifetime.get()), "clock"],
            ["KILLS", String(Math.round(global.finalKills[0].get())), "combat"],
            ["ASSISTS", String(Math.round(global.finalKills[1].get())), "combat"],
        ];
        for (let i = 0; i < rows.length; i++) {
            const col = i % 2, row = (i / 2) | 0;
            const a = global.lerp(1 + i * 0.2, 1.25 + i * 0.2, glide);
            deathStat(rows[i][0], rows[i][1], rows[i][2],
                      rx + col * (half + 8), ry + row * 46, half, a);
        }
        ry += 3 * 46 + 4;

        // who got you
        const cause = global.finalCause || "";
        const killedBy = cause === "raidend" ? "The raid ended"
            : cause === "rock" ? "Crushed by the living rock"
            : cause === "base" ? "Shot by the enemy base"
            : cause === "core" ? "Killed by the Core"
            : global.finalKillers.length
                ? "Killed by " + global.finalKillers.join(" and ")
                : "Nobody finished you off";
        c.save();
        c.globalAlpha = global.lerp(2.4, 2.7, glide);
        drawText(killedBy, cx, ry + 12, 13, color.grey, "center");
        c.restore();

        // ── respawn controls ──────────────────────────────────────────────
        const by = py + PH - 52;
        ctx[2].globalAlpha = global.lerp(3, 3.25, glide);
        if (global.cannotRespawn || global.mobile || global.gamepadMode) {
            drawText(global.cannotRespawn
                ? (global.respawnTimeout
                    ? "(you can respawn in " + global.respawnTimeout + "s)"
                    : "(you can't respawn)")
                : global.mobile ? "(tap to respawn)"
                : global.gamepadMode ? "(press RT or R2 to respawn)" : '',
                cx, by - 12, 14, color.guiwhite, "center");
        }
        if (!global.disconnected && !global.cannotRespawn) {
            const cr = global.canvas.height / global.screenHeight / global.ratio;
            if (!global.mobile && !global.gamepadMode) {
                drawButton(cx - 85, by + 12, 140, 34, global.lerp(3, 3.25, glide), "rect", "Back", 15, false, false, false, true, "exitGame", cr, 0);
                drawButton(cx + 85, by + 12, 140, 34, global.lerp(3, 3.25, glide), "rect", "Respawn", 15, false, false, false, true, "deathRespawn", cr, 0);
            } else {
                drawButton(cx, by + 14, 160, 46, global.lerp(3, 3.25, glide), "rect", "Back", 22, false, false, false, true, "exitGame", cr, 0);
            }
        }
    };
    // ── Raid death screen ────────────────────────────────────────────────
    // The whole card is there from the first frame (one short fade, nothing
    // staggered). One wide card, low and centred: the life in numbers on the
    // left, who got you and what's next on the right. The camera follows your
    // killer meanwhile and lifts (deathCamLift, see drawGameplay) so they
    // stay in view above the card. The footer is the Play again button (DOM,
    // updateRoyaleDomButtons): it counts down the server's 3 s wait, then
    // waits for a click, Enter, Space or RT. Nothing drops you in on its own;
    // the raid end queues everyone itself (raidFinale.js).
    const lastStormCount = () => !!(global.died && global.royale && global.royale.lock && raidFinale.countdownUp());
    // "Your perks stay until the raid ends." centred on cx, your build's
    // icons in front of it (raidPerks.js)
    function drawDeathPerkLine(c, line, cx, y, maxW, A) {
        const n = Math.min(10, raidPerks.build().length), s = 16;
        const iconsW = n ? n * (s + 3) + 5 : 0;
        const f = fitLine(line, 12.5, 9.5, Math.max(80, maxW - iconsW));
        const tw = hudTextW(f.txt, f.qs);
        const x0 = cx - (iconsW + tw) / 2;
        if (n) raidPerks.drawDeathIcons(c, x0, y, s, A);
        drawText(f.txt, x0 + iconsW, y, f.qs, HUD.gold, "left", true, A);
    }
    // The first raids' death card (newcomer.js stages 0-1): what got you and
    // how to dodge it next time, what you kept, and one big Respawn.
    const XP_STRIP_H = 30;
    function xpStripTexts(d, w) {
        const key = d.lv + "|" + d.into + "|" + d.need + "|" + d.life + "|" + d.next + "|" + (w | 0);
        if (d._k === key) return d._t;
        const lvl = "Lvl " + d.lv;
        const gain = d.life > 0 ? "+" + d.life.toLocaleString("en-US") + " XP" : "";
        const mid = levelsHud.xpLine(d);
        const lvlW = hudTitleW(lvl, 15) + 18;
        const midW = measureText(mid, 12) + 14;
        const gainW = gain ? hudTitleW(gain, 14) + 14 : 0;
        const nextRoom = w >= 560 ? Math.min(300, Math.round(w * 0.36)) : 0;
        const nx = nextRoom && d.next ? fitLine(d.next, 12.5, 10, nextRoom - 14) : null;
        d._k = key;
        d._t = { lvl, gain, mid, lvlW, midW, gainW, nx, nextW: nx ? Math.min(nextRoom, measureText(nx.txt, nx.qs) + 14) : 0 };
        return d._t;
    }
    function drawXpStrip(c, x, y, w, d, A) {
        const h = XP_STRIP_H, t = xpStripTexts(d, w), my = y + h / 2;
        c.save();
        c.globalAlpha = A;
        hudWell(c, x, y, w, h, 8, "rgba(0,0,0,0.45)", HUD.ink, 2);
        c.restore();
        hudTitle(t.lvl, x + 10, my, 15, HUD.gold, "left", A);
        const bx = x + t.lvlW, bw = Math.max(60, Math.min(360, w - t.lvlW - t.midW - t.gainW - t.nextW - 12)), bh = 14, by = Math.round(my - bh / 2);
        const k = d.max ? 1 : d.need > 0 ? Math.max(0, Math.min(1, d.into / d.need)) : 0;
        const k0 = d.max ? 1 : d.need > 0 ? Math.max(0, Math.min(k, (d.from | 0) / d.need)) : 0;
        c.save();
        c.globalAlpha = A;
        roundRectPath(c, bx, by, bw, bh, bh / 2);
        c.fillStyle = "rgba(0,0,0,0.55)"; c.fill();
        if (k > 0) {
            c.save();
            roundRectPath(c, bx, by, bw, bh, bh / 2);
            c.clip();
            c.fillStyle = "#ffe869"; c.fillRect(bx, by, Math.round(bw * k), bh);
            if (k0 > 0) { c.fillStyle = "#c9a227"; c.fillRect(bx, by, Math.round(bw * k0), bh); }
            c.restore();
        }
        roundRectPath(c, bx, by, bw, bh, bh / 2);
        c.lineWidth = 2; c.strokeStyle = HUD.ink; c.stroke();
        c.restore();
        drawText(t.mid, bx + bw + 10, my, 12, HUD.text, "left", true, A);
        if (t.gain) hudTitle(t.gain, bx + bw + t.midW + 6, my, 14, "#9dff8a", "left", A);
        if (t.nx) drawText(t.nx.txt, x + w - 10, my, t.nx.qs, HUD.text, "right", true, A);
        return h;
    }
    const gameDrawDeadNewcomer = (A) => {
        const c = ctx[2];
        const sw = global.screenWidth, sh = global.screenHeight;
        const info = newcomer.deathInfo();
        const W = Math.min(620, sw - 32), pad = 22, gap = 14;
        const iw = W - pad * 2;
        const tipLines = wrapLines(info.tip, 17, iw - 70).slice(0, 3);
        const TIP_H = Math.max(64, 26 + tipLines.length * 23);
        const KEPT_H = 44;
        // the Points line, every death (playtest 5: the first two cards had none, later
        const you = (global.royale && global.royale.you) || {};
        const dln = scoreText.deathLine(you, global.finalCarried | 0, 0, global.finalNxKept | 0);
        const PTS_H = 26;
        // raid perks: they come back with you, said under what you kept
        const perkLine = global.finalCause === "raidend" ? "" : raidPerks.deathLine();
        const PERK_H = perkLine ? 26 : 0;
        const aoLine = aoHud.deathLine();
        const AO_H = aoLine ? 24 : 0;
        // the rank card stays for the second raid (placement lives), not the first
        const hasRank = newcomer.stage() >= 1 && rankPanel.hasContent();
        const RANK_H = 106;
        const lvc = levelsHud.deathCard(global.royaleDiedAt || 0);
        const XPH = lvc ? XP_STRIP_H + gap : 0;
        const cssK = sh / Math.max(1, window.innerHeight);
        const PLAY_CSS_H = 74;
        const FOOT = Math.round(PLAY_CSS_H * cssK);
        const HEAD = 44;
        const H = pad + HEAD + TIP_H + gap + KEPT_H + PTS_H + PERK_H + AO_H + XPH + (hasRank ? gap + RANK_H : 0) + gap + FOOT + 14;
        const BTN = Math.round((40 + 22) * cssK);
        const px = Math.round(sw / 2 - W / 2);
        const py = Math.round(Math.max(12, sh - H - BTN - 12));
        const cx = sw / 2;
        global.deathCamLift = Math.max(0, sh / 2 - Math.max(110, py / 2 + 10));
        deathCardFrac(px / sw, py / sh, W / sw, (H + BTN) / sh);
        global.deathPanelCss = {
            cx: Math.round(cx * window.innerWidth / Math.max(1, sw)),
            top: Math.round((py + H) * window.innerHeight / Math.max(1, sh)) + 10,
        };
        hudPanel(c, px, py, W, H, { alpha: A, fill: HUD.solid, r: HUD.rBig + 2, lip: 5 });
        drawPtsPops(px + W - 16, Math.max(14, py - 16), "right", -1);
        const hx = px + pad;
        let y = py + pad;
        hudTitle("You died", cx, y + 16, 30, HUD.gold, "center", A);
        y += HEAD;
        // the tip: an icon for what got you, then how to dodge it
        c.save();
        c.globalAlpha = A;
        hudWell(c, hx, y, iw, TIP_H, 12, "rgba(242,184,60,0.10)", HUD.ink, 2.5);
        c.restore();
        const icon = info.kind === "storm" ? "clock" : info.kind === "rock" ? "pickaxe" : info.kind === "raidend" ? "clock" : "skull";
        drawDeathIcon(icon, hx + 34, y + TIP_H / 2, 30, A * 0.9);
        let ty = y + TIP_H / 2 - (tipLines.length - 1) * 11.5;
        for (const ln of tipLines) { drawText(ln, hx + 64, ty, 17, HUD.head, "left", true, A); ty += 23; }
        y += TIP_H + gap;
        // what you kept
        c.save();
        c.globalAlpha = A;
        hudWell(c, hx, y, iw, KEPT_H, 10, "rgba(0,0,0,0.45)", HUD.ink, 2);
        c.fillStyle = HUD.gold; c.strokeStyle = HUD.ink; c.lineWidth = 1.5;
        gemPath(c, hx + 22, y + KEPT_H / 2, 7); c.fill(); c.stroke();
        c.restore();
        const kf = fitLine(info.kept, 15, 10, iw - 54);
        drawText(kf.txt, hx + 40, y + KEPT_H / 2, kf.qs, HUD.gold, "left", true, A);
        const pf = fitLine(dln.head + " (" + dln.lost + ")", 14, 9.5, iw);
        drawText(pf.txt, cx, y + KEPT_H + PTS_H / 2 + 2, pf.qs, dln.hurt ? "#ff9a8c" : HUD.gold, "center", true, A);
        if (perkLine) drawDeathPerkLine(c, perkLine, cx, y + KEPT_H + PTS_H + PERK_H / 2 + 4, iw, A);
        if (aoLine) { const af = fitLine(aoLine, 14, 9.5, iw); drawText(af.txt, cx, y + KEPT_H + PTS_H + PERK_H + AO_H / 2 + 2, af.qs, HUD.sky, "center", true, A); }
        y += KEPT_H + PTS_H + PERK_H + AO_H + gap;
        if (lvc) { drawXpStrip(c, hx, y, iw, lvc, A); y += XPH; }
        if (hasRank) {
            try {
                rankPanel.draw(c, hx, y, iw, RANK_H,
                    { drawText, measureText, drawBar, color, barChunk: config.graphical.barChunk }, A);
            } catch (e) { /* never break the death screen */ }
            y += RANK_H + gap;
        }
        // the big Respawn (DOM, placed here)
        const playW = iw;
        const toCssX = window.innerWidth / Math.max(1, sw), toCssY = window.innerHeight / Math.max(1, sh);
        global.deathPlayCss = { cx: Math.round(cx * toCssX), top: Math.round(y * toCssY), w: Math.round(playW * toCssX), h: PLAY_CSS_H, big: true };
        global.clickables.royalePrev.hide();
        global.clickables.royaleNext.hide();
        global.clickables.deathRespawn.hide();
        if (typeof royaleDomBuilt !== "undefined" && royaleDomBuilt) { global.clickables.royalePlay.hide(); return; }
        if (!global.disconnected) {
            const cr = global.canvas.height / global.screenHeight / global.ratio;
            const st = playAgainState();
            drawButton(cx, y, playW, FOOT, st.ready ? A : A * 0.5, "rect", st.label, 26, false, false, false, st.ready, "royalePlay", cr, 0);
            if (!st.ready) global.clickables.royalePlay.hide();
            const bty = py + H + 12;
            drawButton(cx - 90, bty, 150, 32, A, "rect", "Spectate", 15, false, false, false, true, "royaleSpectate", cr, 0);
            drawButton(cx + 90, bty, 150, 32, A, "rect", "Home", 15, false, false, false, true, "exitGame", cr, 0);
        }
    };
    // the tank this life ended in, kept from the moment of death
    let deathTankAt = -1, deathTank = null;
    function deathTankOf() {
        const at = global.royaleDiedAt || 0;
        if (at !== deathTankAt || !deathTank) {
            deathTankAt = at;
            const m = gui.type && global.mockups && global.mockups[parseInt(String(gui.type).split("-")[0])];
            deathTank = m ? { type: String(gui.type), color: gui.color, name: String(m.name || "") } : null;
        }
        return deathTank;
    }
    const gameDrawDeadRoyale = () => {
        const A = deathIntroK();
        if (A <= 0) {
            global.clickables.royalePrev.hide();
            global.clickables.royaleNext.hide();
            global.clickables.deathRespawn.hide();
            global.clickables.royalePlay.hide();
            global.clickables.royaleSpectate.hide();
            return;
        }
        const c = ctx[2];
        clearScreen(color.black, 0.34 * A, c);
        const dy = deathText.introSlide(A, deathCalm());
        if (dy) { c.save(); c.translate(0, dy); }
        try {
            if (newcomer.deathCardWanted()) gameDrawDeadNewcomer(A);
            else drawRoyaleDeathCard(A);
        } finally { if (dy) c.restore(); }
    };
    const drawRoyaleDeathCard = (A) => {
        const you = global.royale.you || {};
        const rv = you.revenge || null;
        const c = ctx[2];

        // ── the words under the tiles (they size the card, deathCardLogic) ──
        const extras = [];
        if ((global.finalInsured | 0) > 0) extras.push("Your insurance saved " + util.formatLargeNumber(global.finalInsured | 0) + " of it");
        if ((global.finalStreak | 0) >= 3) extras.push("Your " + (global.finalStreak | 0) + " kill streak is over");
        if (global.finalDrillLost) extras.push("Your drill dropped a tier");
        { const aoLine = aoHud.deathLine(); if (aoLine) extras.push(aoLine); }
        // bank.js: only savings from earlier raids pay for a death "Points: 6,942 (lost
        const dln = scoreText.deathLine(you, global.finalCarried | 0, global.finalBankLoss | 0, global.finalNxKept | 0);
        if (dln.savings) extras.push(dln.savings);
        // past the soft line: the BANKED PTS tile's gems (scoreLogic.bankSoftLine)
        { const bsl = scoreText.bankSoftLine(scoreText.parts(you)); if (bsl) extras.push(bsl); }
        // raid perks: one more line under the stats, with your build's icons
        // (not when it was the raid ending that took everyone down)
        const perkLine = global.finalCause === "raidend" ? "" : raidPerks.deathLine();
        const perkIcons = perkLine ? Math.min(10, raidPerks.build().length) : 0;
        const hasRank = rankPanel.hasContent();
        const lvc = levelsHud.deathCard(global.royaleDiedAt || 0);
        const HEAD = 64, TILE = 44, NEXT_H = 40, WHO_H = 74, PLAY_CSS_H = 58;
        const RANK_H = hasRank ? rankPanel.panelHeight() : 0;
        const pad = 18, gap = 10, IN = 12;
        const cardLayout = (sw, sh) => {
            const W = Math.min(1040, sw - 32);
            const two = W >= 820;
            const colW = two ? Math.floor((W - pad * 2 - gap) / 2) : W - pad * 2;
            const cssK = sh / Math.max(1, window.innerHeight);
            const FOOT = Math.round(PLAY_CSS_H * cssK);
            const block = deathText.layoutText({
                pts: dln.head + " (" + dln.lost + ")", extras,
                sub: dln.sub || "Banked gems are safe, and carried gems only count once you bank them.",
                perkLine, perkIcons, w: colW - IN * 2, measure: hudTextW,
            });
            const gridH = 3 * TILE + 2 * gap;
            const tilesH = gridH + gap;
            const leftH = tilesH + block.h;
            const bodyH = two ? leftH : leftH + gap + WHO_H + gap + NEXT_H;
            const H = pad + HEAD + gap + bodyH + (lvc ? gap + XP_STRIP_H : 0) + (hasRank ? gap + RANK_H : 0) + gap + FOOT + pad;
            const BTN = Math.round((40 + 22) * cssK);
            return { W, two, colW, cssK, FOOT, block, gridH, tilesH, leftH, bodyH, H, BTN };
        };
        const SW = global.screenWidth, SH = global.screenHeight;
        let k = 1, Lc = cardLayout(SW, SH);
        for (let it = 0; it < 4; it++) {
            const room = SH / k, need = Lc.H + Lc.BTN + 24;
            if (need <= room + 0.5) break;
            k = Math.max(0.62, k * room / need);
            Lc = cardLayout(SW / k, SH / k);
        }
        const sw = SW / k, sh = SH / k;
        const { W, two, colW, cssK, FOOT, block, gridH, tilesH, leftH, bodyH, H, BTN } = Lc;
        const px = Math.round(sw / 2 - W / 2);
        const py = Math.round(Math.max(12, sh - H - BTN - 12));
        const cx = sw / 2;
        global.deathCamLift = Math.max(0, sh / 2 - Math.max(110, py / 2 + 10)) * k;
        deathCardFrac(px / sw, py / sh, W / sw, (H + BTN) / sh);
        global.deathPanelCss = {
            cx: Math.round(cx * window.innerWidth / Math.max(1, sw)),
            top: Math.round((py + H) * window.innerHeight / Math.max(1, sh)) + 10,
        };
        if (k !== 1) { c.save(); c.scale(k, k); }

        hudPanel(c, px, py, W, H, { alpha: A, fill: HUD.solid, r: HUD.rBig + 2, lip: 5 });
        drawPtsPops(px + W - 16, Math.max(14, py - 16), "right", -1);

        const hx = px + pad, hy = py + pad, hw = W - pad * 2, hmid = hy + HEAD / 2;
        c.save();
        c.globalAlpha = A;
        hudWell(c, hx, hy, hw, HEAD, 10, "rgba(242,184,60,0.12)", HUD.ink, 2.5);
        c.restore();
        const cause = global.finalCause || "";
        const killedBy = cause === "raidend" ? "The raid ended"
            : cause === "rock" ? "Crushed by the living rock"
            : cause === "storm" ? "Lost in the storm"
            : cause === "base" ? "Shot by the enemy base"
            : cause === "core" ? "Killed by the Core"
            : global.finalKillers.length
                ? "Killed by " + global.finalKillers.join(" and ")
                : "Nobody finished you off";
        const place = (you.place || global.royale.place) | 0;
        const score = you.score != null || you.pts ? scoreText.cardPoints(you) : (global.royale.youScore | 0);
        const placeTxt = place > 0 ? "#" + place : "";
        const placeW = placeTxt ? hudTitleW(placeTxt, 28) : 0;
        const scoreTxt = util.formatLargeNumber(Math.round(score));
        const scoreR = hx + hw - IN - 4 - (placeW ? placeW + 22 : 0);
        const scoreW = Math.max(hudTitleW(scoreTxt, 26), hudTextW("POINTS", 11));
        const dTank = deathTankOf();
        const PORT = dTank ? HEAD - 16 : 0, tx0 = PORT ? hx + 8 + PORT + IN : hx + IN + 4;
        if (dTank) {
            c.save();
            c.globalAlpha = A;
            hudWell(c, hx + 8, hy + 8, PORT, PORT, 9, HUD.well, HUD.ink, 2);
            try {
                const picture = mockupPicture(dTank.type, dTank.color);
                const position = global.mockups[parseInt(String(dTank.type).split("-")[0])].position;
                const sc = (PORT * 0.8) / position.axis, ang = -Math.PI / 4;
                const pcx = hx + 8 + PORT / 2 - sc * (position.middle.x * Math.cos(ang) - position.middle.y * Math.sin(ang));
                const pcy = hy + 8 + PORT / 2 - sc * (position.middle.x * Math.sin(ang) + position.middle.y * Math.cos(ang));
                drawEntity(picture.color, pcx, pcy, picture, 1, 1, sc / picture.size, 1, ang, true, c);
            } catch (e) { void e; }
            c.restore();
        }
        hudTitle("You died", tx0, hmid - 9, 28, HUD.gold, "left", A);
        const textRoom = Math.max(120, scoreR - scoreW - 24 - tx0);
        const whoLine = killedBy + (dTank && dTank.name ? " · " + dTank.name : "");
        const kb = fitLine(whoLine, 13, 10, textRoom);
        drawText(kb.txt, tx0, hmid + 14, kb.qs, HUD.text, "left", true, A);
        drawText("Points", scoreR, hmid - 11, 12, HUD.text2, "right", true, A);
        hudTitle(scoreTxt, scoreR, hmid + 9, 26, HUD.gold, "right", A);
        if (placeTxt) hudTitle(placeTxt, hx + hw - IN - 4, hmid, 28, HUD.head, "right", A);

        const by = hy + HEAD + gap;
        const half = (colW - gap) / 2;
        const pt = scoreText.tiles(you);
        if (aoHud.on()) pt[0] = [String(pt[0][0]).replace("THIS RAID", "TODAY"), pt[0][1], pt[0][2]];
        const rows = [
            pt[0],
            pt[1],
            pt[2],
            ["DROPPED (NOT PTS)", util.formatLargeNumber(global.finalCarried | 0), "gem"],
            ["KILLS", String((you.kills != null ? you.kills : global.finalKillCount) | 0), "skull"],
            ["SURVIVED", compactTime(global.finalLifeSecs || 0), "clock"],
        ];
        c.save();
        c.globalAlpha = A;
        for (let i = 0; i < rows.length; i++) {
            deathStat(rows[i][0], rows[i][1], rows[i][2], hx + (i % 2) * (half + gap), by + ((i / 2) | 0) * (TILE + gap), half, A, TILE);
        }
        c.restore();
        const ty0 = by + tilesH, lx = hx + IN;
        c.save();
        c.globalAlpha = A;
        hudWell(c, hx, ty0, colW, block.h, 10, "rgba(0,0,0,0.45)", HUD.ink, 2);
        c.restore();
        for (const r of block.rows) {
            const ly = ty0 + r.y;
            if (r.kind === "pts") drawText(r.text, lx, ly, r.size, dln.hurt ? "#ff9a8c" : HUD.gold, "left", true, A);
            else if (r.kind === "ex") drawText(r.text, lx, ly, r.size, color.gold, "left", true, A);
            else if (r.kind === "sub") drawText(r.text, lx, ly, r.size, HUD.text2, "left", true, A);
            else if (r.kind === "icons") raidPerks.drawDeathIcons(c, lx, ly, deathText.TEXT.icon, A);
            else if (r.kind === "perk") {
                const piw = r.iconsW || 0;
                if (piw) raidPerks.drawDeathIcons(c, lx, ly, deathText.TEXT.icon, A);
                drawText(r.text, lx + piw, ly, r.size, HUD.gold, "left", true, A);
            }
        }

        const rx = two ? hx + colW + gap : hx;
        const ry = two ? by : by + leftH + gap;
        const whoH = two ? gridH : WHO_H;
        c.save();
        c.globalAlpha = A;
        hudWell(c, rx, ry, colW, whoH, 10, rv ? "rgba(255,107,94,0.10)" : "rgba(0,0,0,0.45)", HUD.ink, 2);
        c.restore();
        const wy = ry + whoH / 2, wtx = rx + IN + 44, wRoom = colW - IN * 2 - 44;
        if (rv) {
            drawSkull(c, rx + IN + 20, wy, 13, "#ff6b5e");
            drawText(rv.tough ? "Too strong for now" : "Revenge", wtx, wy - 24, 12, HUD.text2, "left", true, A);
            const nm = shortName(rv.name || "Unnamed", 18);
            let ns = 24; while (ns > 14 && hudTitleW(nm, ns) > wRoom) ns -= 1;
            hudTitle(nm, wtx, wy + 2, ns, "#ff9a8c", "left", A);
            const sub = rv.tough ? "They're much stronger than you. Get bigger first, then get them back."
                : rv.alive ? "They're marked for you. Get them for +" + fmtNum(rv.bonus || 200) + " gems." : "They'll be marked for you once they're back.";
            const sf = fitLine(sub, 12, 9.5, wRoom);
            drawText(sf.txt, wtx, wy + 25, sf.qs, HUD.text, "left", true, A);
        } else {
            drawDeathIcon(cause === "storm" ? "clock" : "skull", rx + IN + 20, wy, 22, A * 0.8);
            const t1 = fitLine(killedBy, 15, 10, wRoom);
            drawText(t1.txt, wtx, wy - 9, t1.qs, HUD.head, "left", true, A);
            drawText("No one to get revenge on.", wtx, wy + 13, 12, HUD.text2, "left", true, A);
        }
        const nyTop = two ? ty0 : ry + whoH + gap;
        const nextH = two ? block.h : NEXT_H;
        c.save();
        c.globalAlpha = A;
        hudWell(c, rx, nyTop, colW, nextH, 10, "rgba(0,0,0,0.45)", HUD.ink, 2);
        c.restore();
        const ny = nyTop + nextH / 2;
        const nextTxt = you.next ? "Next: " + String(you.next).charAt(0).toLowerCase() + String(you.next).slice(1) : "Next: a new contract when you land";
        const fn = fitLine(nextTxt, 12, 9.5, colW - IN * 2 - 18);
        c.save();
        c.globalAlpha = A;
        c.fillStyle = HUD.gold; c.strokeStyle = HUD.ink; c.lineWidth = 1.5;
        c.beginPath(); c.arc(rx + IN + 6, ny, 5.5, 0, Math.PI * 2); c.fill(); c.stroke();
        c.beginPath(); c.arc(rx + IN + 6, ny, 2, 0, Math.PI * 2); c.fillStyle = HUD.ink; c.fill();
        c.restore();
        drawText(fn.txt, rx + IN + 18, ny, fn.qs, HUD.gold, "left", true, A);

        let fy = by + bodyH + gap;
        if (lvc) { drawXpStrip(c, hx, fy, hw, lvc, A); fy += XP_STRIP_H + gap; }
        if (hasRank) {
            try {
                rankPanel.draw(c, hx, fy, hw, RANK_H,
                    { drawText, measureText, drawBar, color, barChunk: config.graphical.barChunk }, A);
            } catch (e) { void e; }
            fy += RANK_H + gap;
        }

        const pair = !!buildBtnLabels.respawnAs(you, global.diedAsTank);
        const playW = pair ? hw : Math.min(colW, Math.round(380 * cssK));
        const toCssX = window.innerWidth / Math.max(1, sw), toCssY = window.innerHeight / Math.max(1, sh);
        global.deathPlayCss = {
            cx: Math.round(cx * toCssX),
            top: Math.round(fy * toCssY),
            w: Math.round(playW * toCssX),
            h: PLAY_CSS_H,
            gap: Math.round(gap * toCssX),
            split: pair ? Math.round(colW * toCssX) : 0,
        };
        global.clickables.royalePrev.hide();
        global.clickables.royaleNext.hide();
        global.clickables.deathRespawn.hide();
        if (typeof royaleDomBuilt !== "undefined" && royaleDomBuilt) global.clickables.royalePlay.hide();
        else if (!global.disconnected) {
            const cr = global.canvas.height / global.screenHeight / global.ratio;
            const st = playAgainState();
            drawButton(cx, fy, playW, FOOT, st.ready ? A : A * 0.5, "rect", st.label, 22, false, false, false, st.ready, "royalePlay", cr, 0);
            if (!st.ready) global.clickables.royalePlay.hide();
            const bty = py + H + 12;
            drawButton(cx - 90, bty, 150, 32, A, "rect", "Spectate", 15, false, false, false, true, "royaleSpectate", cr, 0);
            drawButton(cx + 90, bty, 150, 32, A, "rect", "Home", 15, false, false, false, true, "exitGame", cr, 0);
        }
        if (k !== 1) c.restore();
    };
    // The death card's Play again button: its label, and whether it works yet.
    // respawn() (canvas.js) enforces the same rules; the server enforces the
    // 3 s wait on its own.
    // queue: the button still takes a click (or Enter) while it waits, and that
    function playAgainState() {
        const locked = !!(global.royale && global.royale.lock && global.royale.at > 0);
        const waitMs = Math.max(0, (global.raidRespawnAt || 0) - performance.now());
        const q = !!global.respawnQueued;
        if (locked) {
            const left = Math.max(0, global.royale.lockLeft | 0);
            // the raid's last lock: nobody comes back, so the button says so and takes you to
            if (global.royale.storm && global.royale.storm.fin) return { ready: false, ended: true, label: "No more respawns this raid" };
            // short enough for the button (round 7: the old line spilled off both edges)
            return { ready: false, queue: true, queued: q, label: q ? "Storm resetting: you drop in (" + left + "s)" : "Storm resetting (" + left + "s)" };
        }
        if (global.respawnPending) return { ready: false, label: "Dropping in..." };
        if (q && waitMs > 0) return { ready: false, queue: true, queued: true, label: "Respawning in " + Math.ceil(waitMs / 1000) + "..." };
        // one word for it, every death of every raid: you drop back into the same raid
        if (waitMs > 0) return { ready: false, queue: true, label: "Respawn in " + Math.ceil(waitMs / 1000) + "..." };
        if (global.updateHoldsRespawn) return { ready: false, label: "Updating the game..." };
        return { ready: true, label: "Respawn" };
    }
    // The death card button's font: the CSS size, or smaller until the label fits
    function playAgainFont(st, pc, keyTxt, label) {
        const base = pc.big && st.ready ? 34 : st.ready ? 26 : 22;
        const room = Math.max(40, (pc.w | 0) - 36 - (keyTxt ? 64 : 0)) * (st.ended ? 2 : 1);
        const len = Math.max(1, String((label != null ? label : st.label) || "").length);
        const fit = Math.floor(room / (len * 0.55));
        return Math.max(12, Math.min(base, fit)) + "px";
    }
    // "Respawn in 3..." -> "Respawn 3" for the narrow button
    function shortRespawn(label) {
        const m = /^Respawn(?:ing)? in (\d+)\.\.\.$/.exec(label || "");
        if (m) return "Respawn " + m[1];
        // round 11: the storm-lock countdown was cut to "Respa..." on the narrow button
        const l = /^Storm resetting(: you drop in)? \((\d+)s\)$/.exec(label || "");
        return l ? (l[1] ? "Drop in " : "Respawn ") + l[2] + "s" : label;
    }
    // round 11: shrink a DOM button's font until its label fits (never "Respa..."),
    // measured once per label / width / base size
    function setFontSize(el, v) {
        if (el.style.getPropertyValue("font-size") !== v || el.style.getPropertyPriority("font-size") !== "important") el.style.setProperty("font-size", v, "important");
    }
    function fitBtnFont(el, lab, text, widthPx, fsPx) {
        const c = el._fit || (el._fit = {});
        const key = text + "|" + widthPx + "|" + fsPx;
        if (c.key === key) return c.fs;
        c.key = key;
        let fs = parseFloat(fsPx) || 16;
        try {
            if (lab.textContent !== text) lab.textContent = text;
            el.style.width = widthPx;
            setFontSize(el, fs + "px");
            if (lab.clientWidth > 0) {
                while (fs > 10 && lab.scrollWidth > lab.clientWidth + 1) { fs -= 1; setFontSize(el, fs + "px"); }
            } else c.key = "";
            const room = (parseFloat(widthPx) || 0) - 30;
            if (room > 0) {
                const mc = fitBtnFont.mc || (fitBtnFont.mc = document.createElement("canvas").getContext("2d"));
                mc.font = "700 " + fs + "px Ubuntu, sans-serif";
                const tw = mc.measureText(text).width;
                if (tw > room) { fs = Math.max(10, Math.floor(fs * room / tw)); setFontSize(el, fs + "px"); }
            }
        } catch (e) { /* */ }
        return (c.fs = fs + "px");
    }
    window.dwPlayAgain = () => { const st = playAgainState(); return { label: st.label, ready: !!st.ready, ended: !!st.ended, font: global.deathPlayCss ? playAgainFont(st, global.deathPlayCss, "") : "" }; };
    // A respawn asked for during the storm lock or the death wait (canvas respawn
    function flushQueuedRespawn() {
        if (!global.respawnQueued) return;
        if (!global.died || global.disconnected || raidFinale.active()) { global.respawnQueued = false; return; }
        const locked = !!(global.royale && global.royale.lock && global.royale.at > 0);
        if (locked || global.respawnPending || global.updateHoldsRespawn) return;
        if (global.raidRespawnAt > 0 && performance.now() < global.raidRespawnAt) return;
        try { if (global.canvas && global.canvas.respawn) global.canvas.respawn(); } catch (e) { /* */ }
    }
    window.dwRespawnQueued = () => !!global.respawnQueued;
    const drawRoyaleSpectateBar = () => {
        const sw = global.screenWidth;
        const barW = Math.min(620, sw - 40);
        const x = (sw - barW) / 2;
        const y = 10;
        spectateBarBottom = y + 58;
        const h = 36;
        const c = ctx[2];
        hudPanel(c, x, y, barW, h, { fill: HUD.solid });
        // Spectating is manual: Prev/Next hop, Play rejoins (after the 3 s
        // death wait), Home exits. No auto-rejoin while watching.
        const locked = !!(global.royale.lock && global.royale.at > 0);
        const lockLeft = Math.max(0, global.royale.lockLeft | 0);
        const place = global.royale.place | 0;
        const queued = !global.died && global.raidQueued;
        const waitMs = Math.max(0, (global.raidRespawnAt || 0) - performance.now());
        const bw = barW < 480 ? 64 : 86;
        const prevCx = x + 6 + bw / 2;
        const nextCx = x + 12 + bw * 1.5;
        const homeCx = x + barW - 6 - bw / 2;
        const playCx = x + barW - 12 - bw * 1.5;
        const finalLock = locked && !!(global.royale.storm && global.royale.storm.fin);
        const label = finalLock ? "No more respawns this raid"
            : locked
            ? ("Storm shuts in " + lockLeft + "s" + (place > 0 ? ("  #" + place) : "") + (global.respawnQueued ? "  ·  Respawning when it settles" : "  ·  Respawn after"))
            : queued ? "Dropping in..."
            : ("Spectating" + (place > 0 ? ("  #" + place) : "") +
               (global.died ? (waitMs > 0 ? ("  ·  Rejoin in " + Math.ceil(waitMs / 1000) + "s") : "  ·  Press Play to rejoin") : ""));
        fitText(label, x + barW / 2, y + 24, 14, Math.max(60, barW - 4 * bw - 60), color.guiwhite);
        // DOM buttons (Prev/Next/Play/Home) sit below this bar and take the
        // clicks, so no canvas buttons here.
        if (typeof royaleDomBuilt !== "undefined" && royaleDomBuilt) {
            global.clickables.royalePrev.hide();
            global.clickables.royaleNext.hide();
            global.clickables.royalePlay.hide();
            global.clickables.exitGame.hide();
            return;
        }
        const cr = global.canvas.height / global.screenHeight / global.ratio;
        drawButton(prevCx, y + 3, bw, 30, 1, "rect", "Prev", 14, false, false, false, true, "royalePrev", cr, 0);
        drawButton(nextCx, y + 3, bw, 30, 1, "rect", "Next", 14, false, false, false, true, "royaleNext", cr, 0);
        const canPlay = global.died && !locked && !global.respawnPending && !global.disconnected;
        if (canPlay) {
            drawButton(playCx, y + 3, bw, 30, 1, "rect", "Play", 14, false, false, false, true, "royalePlay", cr, 0);
        } else {
            global.clickables.royalePlay.hide();
            drawButton(playCx, y + 3, bw, 30, 0.45, "rect", locked ? (lockLeft + "s") : "Wait", 14, false, false, false, false, "royalePlay", cr, 0);
        }
        drawButton(homeCx, y + 3, bw, 30, 1, "rect", "Home", 14, false, false, false, true, "exitGame", cr, 0);
    };
    const applyScreenShake = (type = "camera", returnOption = false) => {
        let properties = type == "gui" ? config.graphical.shakeProperties.UIShake : config.graphical.shakeProperties.CameraShake;
        if (config.graphical.noShake) { properties.shakeStartTime = -1; return; }
        var cdx = 0;
        var cdy = 0;
        if (properties.shakeStartTime == -1) return;
        var dt = Date.now() - properties.shakeStartTime;
        if (dt > properties.shakeDuration) {
            properties.shakeStartTime = -1;
            properties.shakeDuration = -1;
            properties.shakeAmount = -1;
            return;
        }
        var easingCoef = dt / properties.shakeDuration;
        var easing = (1 - easingCoef) * (1 - easingCoef);
        cdx = easing * Math.sin(dt * 0.09) * properties.shakeAmount;
        cdy = easing * Math.cos(dt * 0.13) * properties.shakeAmount * 0.8;
        if (properties.keepShake && dt > 100) properties.shakeStartTime = Date.now();
        if (cdx == 0 && cdy == 0) return;
        if (returnOption) return {
            dx: cdx,
            dy: cdy,
        }
        global.player.renderx += cdx;
        global.player.rendery += cdy;
    }
    let deathLift = 0;
    const voidWatch = { since: 0, lastFrame: 0, scenes: -1, stage: 0, playing: false, heals: 0, asks: 0, reconnects: 0, reconnectAt: -1e9, warned: false };
    function healCamera() {
        deathLift = 0;
        lasttick = 0;
        fovlasttick = 0;
        global._specGlide = null;
        if (!(global.player.renderv > 0 && isFinite(global.player.renderv))) global.player.renderv = 2000;
        if (!isFinite(global.player.renderx) || !isFinite(global.player.rendery)) {
            global.player.renderx = global.player.cx && isFinite(global.player.cx.x) ? global.player.cx.x : 0;
            global.player.rendery = global.player.cy && isFinite(global.player.cy.y) ? global.player.cy.y : 0;
        }
        voidWatch.heals++;
    }
    function watchVoid(now) {
        const vw = voidWatch, tr = window.terrainRenderer;
        const playing = !!(global.gameStart && !global.died && !global.disconnected && global.gameWidth > 0);
        if (!playing) { vw.playing = false; vw.since = 0; vw.stage = 0; return; }
        if (!vw.playing) { vw.playing = true; vw.since = 0; vw.stage = 0; }
        if (now - vw.lastFrame > 1000) vw.since = 0;
        vw.lastFrame = now;
        const scenes = tr ? tr.scenes | 0 : 0;
        const building = !!(tr && tr.ready && (tr._blankFrames | 0) > 0);
        const drew = (!!(tr && tr.ready) && scenes !== vw.scenes) || building;
        vw.scenes = scenes;
        if (drew) { vw.since = 0; vw.stage = 0; return; }
        if (!vw.since) { vw.since = now; return; }
        const gone = now - vw.since;
        const noMap = !(tr && tr.ready);
        if (gone > 2000 && vw.stage < 1) {
            vw.stage = 1;
            healCamera();
            if (noMap) {
                vw.asks++;
                if (!vw.warned) { vw.warned = true; console.warn('No map 2 s after spawning, asking the server again'); }
                try { if (global.socket && global.socket.readyState === 1) global.socket.talk('TQ'); } catch (e) { }
            }
        } else if (gone > 10000 && vw.stage < 2) {
            vw.stage = 2;
            if (!noMap || !global.digRoyaleMode || global.tutorialMode || now - vw.reconnectAt < 60000 || !global.reconnect) return;
            vw.reconnectAt = now;
            vw.reconnects++;
            try { global.reconnect(); } catch (e) { }
        }
    }
    window.dwVoid = () => ({ since: voidWatch.since, stage: voidWatch.stage, heals: voidWatch.heals, asks: voidWatch.asks, reconnects: voidWatch.reconnects, scenes: window.terrainRenderer ? window.terrainRenderer.scenes | 0 : 0 });
    const drawGameplay = (tick, ratio) => {

        global.metrics.rendertimes++;
        global.GRAPHDATA = 0;
        let tickMotion = lasttick ? tick - lasttick : null;
        if (!(tickMotion >= 0 && tickMotion < 5000)) tickMotion = null;
        lasttick = tick;
        let motion = compensation();
        motion.set();
        global.GRAPHDATA = motion.getPrediction();

        let playerx = global.player.animX.get(tick);
        let playery = global.player.animY.get(tick);
        const nsNow = Math.abs(performance.now() - tick) < 100 ? tick : performance.now();
        if (netSmooth.active(nsNow)) {
            netSmooth.frame(nsNow);
            const nsCam = !global.died && !global._specGlide ? netSmooth.camera(nsNow) : null;
            if (nsCam) { playerx = nsCam.x; playery = nsCam.y; }
        }
        let pred = null;
        if (!global.died && !global._specGlide) {
            try { pred = predictor.frame(nsNow, playerx, playery); } catch (e) { pred = null; }
        } else {
            try { predictor.frame(nsNow, NaN, NaN); } catch (e) { }
        }
        global.player.predOn = !!pred;
        if (pred) { playerx = pred.x; playery = pred.y; global.player.predX = pred.x; global.player.predY = pred.y; }
        if (global._specGlide) {
            // Spectate glide owns the camera (the chase below would drag it
            // back toward the corpse); it retargets from server updates, then
            // hands off smoothly.
        } else if (global.died && royaleActive()) {
            // Spectating: ease onto whoever the camera follows so a target
            // swap or a respawn never snaps. Frame-time compensated here, so
            // no syncWithFps (that would double-compensate and overshoot).
            const dt = Math.min(250, tickMotion || 16.7);
            const k = Math.min(1, 1 - Math.pow(0.80, dt / 16.7));
            const far = Math.hypot(playerx - global.player.renderx, playery - global.player.rendery);
            if (!isFinite(far) || far > 6000) {
                global.player.renderx = playerx;
                global.player.rendery = playery;
            } else {
                global.player.renderx = util.lerp(global.player.renderx, playerx, k);
                global.player.rendery = util.lerp(global.player.rendery, playery, k);
            }
        } else if (pred) {
            global.player.renderx = playerx;
            global.player.rendery = playery;
        } else if (config.graphical.lerpAnimations) {
            // lerp toward the interpolated position, not raw 30Hz updates
            global.player.renderx = util.lerp(global.player.renderx, playerx, 0.15, true);
            global.player.rendery = util.lerp(global.player.rendery, playery, 0.15, true);
        } else if (config.graphical.smoothcamera && config.graphical.shakeProperties.CameraShake.shakeStartTime == -1) {
            let n = null == tickMotion ? 0 : 0.99 ** tickMotion;
            global.player.renderx = global.player.renderx * n + playerx * (1 - n);
            global.player.rendery = global.player.rendery * n + playery * (1 - n);
        } else if (!config.graphical.interpolation) {
            global.player.renderx = motion.predict(global.player.lastx, global.player.cx.x, global.player.lastvx, global.player.vx),
            global.player.rendery = motion.predict(global.player.lasty, global.player.cy.y, global.player.lastvy, global.player.vy);
        } else {
            global.player.renderx = playerx;
            global.player.rendery = playery;
        }
        if (config.graphical.shakeProperties.CameraShake.shakeStartTime !== -1) applyScreenShake();
        global.player.cx.animX = playerx;
        global.player.cy.animY = playery;
        let px = ratio * global.player.renderx,
            py = ratio * global.player.rendery;
        // the sky drop: the camera rides your falling tank down to its spot
        // (the minimap and markers keep reading renderx, so they don't jump)
        {
            let camFall = null;
            try { camFall = raidHeat.camOffset(); } catch (e) { camFall = null; }
            if (camFall) { px += camFall.dx * ratio; py += camFall.dy * ratio; }
        }
        // a big hit you land leans the view a pixel or two toward it (hitFx.js)
        {
            const nd = hitFx.camNudge(performance.now());
            if (nd.x !== 0 || nd.y !== 0) { px += nd.x; py += nd.y; }
        }
        // raid death card: lift the view so the killer shows above the card
        {
            const want = global.died && global.royaleDied && !global.royaleSpectating && !lastStormCount() ? (global.deathCamLift || 0) * util.getScreenRatio() * deathIntroK() : 0;
            const dt = Math.min(100, tickMotion || 16.7);
            deathLift += (want - deathLift) * Math.min(1, 1 - Math.pow(0.8, dt / 16.7));
            if (Math.abs(deathLift) < 0.5 && !want) deathLift = 0;
            if (!isFinite(deathLift)) { deathLift = 0; voidWatch.heals++; }
            py += deathLift;
        }
        if (!isFinite(px) || !isFinite(py)) {
            healCamera();
            const fx = isFinite(playerx) ? playerx : 0, fy = isFinite(playery) ? playery : 0;
            global.player.renderx = fx;
            global.player.rendery = fy;
            px = ratio * fx;
            py = ratio * fy;
        }

        if (!global.mobile && !global.gamepadMode) calculateTarget();

        let spacing = 20;

        drawFloor(px, py, ratio, tick);
        try { raidHeat.drawFloor(ctx[0], px, py, ratio); } catch (e) { /* never break the frame */ }
        try { abilityFx.drawFloor(ctx[0], px, py, ratio); } catch (e) { /* never break the frame */ }
        drawEntities(px, py, ratio, tick, spacing);
        drawOutpostLabels(px, py, ratio);
        flushWorldLabels();
        drawRoyaleWorldMarkers(px, py, ratio);
        drawFx(px, py, ratio);
        try { abilityFx.drawWorld(ctx[2], px, py, ratio); } catch (e) { /* never break the frame */ }
        try { raidPerks.drawWorld(ctx[2], px, py, ratio); } catch (e) { /* never break the frame */ }
        drawTankBursts(px, py, ratio);
        try { raidHeat.drawWorld(ctx[2], px, py, ratio); } catch (e) { /* never break the frame */ }
        // same camera transform as the entities; drawn before the HUD so the
        // HUD wins the overlap
        drawDamageNumbers(px, py, ratio);
        drawKillBanners(px, py, ratio);
        // World-anchored tutorial markers: same camera transform, above the
        // world, below the GUI. (The screen-space tutorial HUD draws in hook().)
        tutorial.drawWorld(px, py, ratio);
        try { coach.drawWorld(px, py, ratio); } catch (e) { }
    };

    const drawGUI = (tick, scaleRatio) => {
        scaleScreenRatio(scaleRatio, true);
        let ratio = util.getScreenRatio();

        let spacing = 20;
        // 200 UI units, so the upgrade tiles, stat bars, kit box and minimap
        // follow the UI Scale setting. Touch screens use a smaller column:
        // the sticks need the lower corners.
        let alcoveSize = global.mobile ? 160 : 200;
        gui.__s.update();
        hudDrawn = {};
        // the first raids (newcomer.js): reads last frame's big card first
        global._nxCardWas = global.hudCardUp;
        try { newcomer.tick(); } catch (e) { /* never break the frame */ }
        try { firstSeconds.tick(); } catch (e) { /* never break the frame */ }
        // big center-screen cards this frame; coach.js waits while one is up
        global.hudCardUp = "";
        global.hudCalloutUp = false;
        let lb = leaderboard.get();
        let max = lb.max;
        global.canSkill = !!gui.points && !global.showTree && !global.pullSkillBar;
        let shake = false;
        if (config.graphical.shakeProperties.UIShake.shakeStartTime !== -1) shake = applyScreenShake("gui", true);
        if (shake) ctx[2].translate(shake.dx, shake.dy);
        if (global.mobile) {
            touchK = global.screenWidth / Math.max(1, touch.viewW());
            touch.zones = {}; touch.uiRects = {};
            touch.frame(performance.now());
        }
        if (global.gamepadMode) drawCrosshair();
        if (!global.GUIStatus.renderGUI && global.gameStart) {
            drawText("GUI hidden. Turn it on under Settings > Graphics.", global.screenWidth / 2, global.screenHeight - 24, 12, color.grey, "center");
        }
        if (global.GUIStatus.renderGUI) {
            updateMapSmoothing();
            drawLowHealthVignette();
            try { raidHeat.drawScreen(ctx[2]); } catch (e) { /* */ }
            try { crowns.drawScreen(ctx[2]); } catch (e) { /* */ }
            drawSatchelDanger();
            drawTeamBankBar();
            drawRoyaleHUD();
            if (!global.died) { try { drawChatPanel(); } catch (e) { chatPanelRect = null; chatPanelErr = String(e && e.message); } }
            hudLanes();
            drawKillCallouts();
            try { raidHeat.drawSlams(ctx[2], lanes.slamY, lanes.slamK); } catch (e) { /* */ }
            global.hudSlamY = lanes.slamY;
            try { firstSeconds.draw(ctx[2], lanes); } catch (e) { /* */ }
            if (global.royaleSpectating && !lastStormCount()) drawRoyaleSpectateBar();
            try { updateRoyaleDomButtons(); } catch { /* */ }
            drawRoyaleBoard();
            drawMessages(spacing, alcoveSize);
            drawMilestones();
            drawEventCallout();
            drawWarBanner();
            // the raid-end finale takes the whole screen: the winner's own HUD steps aside
            const finaleHud = raidFinale.hidesHud();
            if (global.GUIStatus.renderUpgrades && !finaleHud) drawSkillBars(spacing, alcoveSize);
            if (global.GUIStatus.renderPlayerBars && !finaleHud) {
                // the death card covers the middle: your name and wallet row under it only leaked
                if (!deathScreenOn()) drawSelfInfo(max);
                drawGemPopups();   // +N numbers + pickup ring over the tank
                drawMineCombo();    // mining chain meter under the tank
                drawKitBox(spacing, alcoveSize);
                drawAbilityBar();
                try { drawRaidPerks(); } catch (e) { /* never break the frame */ }
                drawVaultUI();
                drawShopUI();
            }
            if (!finaleHud) drawMinimapAndDebug(spacing, alcoveSize, global.GRAPHDATA, tick);
            // Tutorial: no leaderboard (the server sends an empty one anyway)
            if (global.GUIStatus.renderLeaderboard && !global.tutorialMode && !royaleActive()) drawLeaderboard(spacing, alcoveSize, max);
            if (global.GUIStatus.renderUpgrades && !finaleHud) drawAvailableUpgrades(spacing, alcoveSize);
            // touch: the thumb buttons, chips and stat panel go under the reveal too
            if (global.mobile) drawTouchHud();
            // hover hints above everything, the upgrade tiles included
            if (global.GUIStatus.renderPlayerBars && !finaleHud) drawTooltips();
            // the new ability reveal dims everything under it (the vault and
            // shop panels included), so it goes last
            if (global.GUIStatus.renderPlayerBars && !finaleHud) drawKitUnlock();
            // the one-time ability tour, over everything
            if (global.GUIStatus.renderPlayerBars && !finaleHud && nxShows("abilityTour")) { try { abilityIntro.draw(ctx[2], global.mobile ? touchUnits() : null); } catch (e) { /* never break the frame */ } }
            // leader arrow + enemy pings are drawn in drawTopIndicators(), at
            // the end of the frame, so no panel covers them
        } else {
            if (global.GUIStatus.renderUpgrades) drawAvailableUpgrades(spacing, alcoveSize);
            if (global.mobile) drawTouchHud();
        }
        if (global.showTree) global.hudCardUp = "tankTree";
        if (shake) ctx[2].translate(-shake.dx, -shake.dy);
        global.metrics.lastrender = getNow();
    }

    function optionsMenu_drawRoundedRect(x, y, w, h, r) {
        ctx[2].beginPath();
        ctx[2].moveTo(x+r, y);
        ctx[2].lineTo(x+w-r, y);
        ctx[2].quadraticCurveTo(x+w, y, x+w, y+r);
        ctx[2].lineTo(x+w, y+h-r);
        ctx[2].quadraticCurveTo(x+w, y+h, x+w-r, y+h);
        ctx[2].lineTo(x+r, y+h);
        ctx[2].quadraticCurveTo(x, y+h, x, y+h-r);
        ctx[2].lineTo(x, y+r);
        ctx[2].quadraticCurveTo(x, y, x+r, y);
        ctx[2].closePath();
    }

    function drawToolip(cb) {

        cb.tooltipService.alpha.set(cb.tooltipService.targetAlpha);

        const anim = cb.tooltipService.alpha.get();

        const clickableRatio = global.canvas.height / global.screenHeight / global.ratio;

        if (anim > 0.001) {
            ctx[2].save();
            ctx[2].globalAlpha = anim;

            const paddingX = 9;
            const paddingY = 6;

            const splitTooltip = cb.tooltipService.text.split("\n");

            let textW = cb.tooltipService.text.length;
            for (let line of splitTooltip) textW = Math.max(textW, measureText(line, 13.5));
            const textH = 16;
            const boxW = textW + paddingX * 2;
            let boxH = 0;
            if (splitTooltip.length === 1) boxH = textH + paddingY * 2.5;
            if (splitTooltip.length !== 1) for (let line of splitTooltip) boxH += textH;

            const tipX = cb.tooltipService.x / clickableRatio;
            const tipY = cb.tooltipService.y / clickableRatio;

            const bx = tipX;
            const by = tipY;
            let textY = by;

            ctx[2].fillStyle = "rgba(30, 30, 30, 0.45)";
            optionsMenu_drawRoundedRect(bx, by, boxW, splitTooltip.length === 1 ? boxH : boxH + 15, 8);
            ctx[2].fill();
            ctx[2].globalAlpha = anim;

            for (let i = 0; i < splitTooltip.length; i++) {
                let text = splitTooltip[i];
                let increaseLength = splitTooltip.length === 1 ? 22 : 17.6;
                textY += increaseLength;
                drawText(text, bx + paddingX, splitTooltip.length === 1 ? textY : textY + 3, 13.5, color.guiwhite);
            }

            ctx[2].restore();
        }
    }

    let ingameSettingsBtn = null;
    let royaleDomBuilt = false;
    function royaleDomAct(kind) {
        try {
            const cv = global.canvas;
            if (kind === "prev") {
                global.royaleSpectating = true;
                cv && cv.socket && cv.socket.talk('RS', 0);
            } else if (kind === "next") {
                global.royaleSpectating = true;
                cv && cv.socket && cv.socket.talk('RS', 1);
            } else if (kind === "spectate") {
                global.royaleSpectating = true;
                global.respawnQueued = false;
                // duos: your partner first (3), else your killer (2)
                cv && cv.socket && cv.socket.talk('RS', duoMateAlive() ? 3 : 2);
            } else if (kind === "play") {
                cv && cv.respawn && cv.respawn();
            } else if (kind === "home") {
                global.exit && global.exit();
            } else if (kind === "signup") {
                // back to the menu, where the sign-up form opens
                global.exit && global.exit();
                if (window.dwAccount && window.dwAccount.openSignup) window.dwAccount.openSignup();
                // the account UI may not be loaded yet (client/funnel.js adds it late)
                else if (window.DWFunnel && window.DWFunnel.withAccountUi) window.DWFunnel.withAccountUi((a) => a.openSignup && a.openSignup());
                return;
            }
        } catch { /* */ }
        try {
            const cv = document.getElementById("gameCanvas");
            if (cv && global.gameStart) cv.focus();
        } catch { /* */ }
    }
    function duoMateAlive() {
        const d = global.royale && global.royale.duos && global.royale.duo;
        return !!(d && d.mate && d.mate.alive);
    }
    window.dwDuoMateAlive = duoMateAlive;
    function royaleDomBtn(id, text) {
        const b = document.createElement("button");
        b.id = id;
        b.textContent = text;
        b.className = "dw-igbtn";   // home.css: the menu's chunky button
        return b;
    }
    function getRoyaleDomButtons() {
        if (royaleDomBuilt) return;
        royaleDomBuilt = true;
        const spec = document.createElement("div");
        spec.id = "royaleSpecDom";
        spec.style.cssText = "position:fixed;top:56px;left:50%;transform:translateX(-50%);z-index:31;display:none;gap:10px;align-items:center;";
        const prev = royaleDomBtn("royaleDomPrev", "Prev");
        const next = royaleDomBtn("royaleDomNext", "Next");
        const play = royaleDomBtn("royaleDomPlay", "Play");
        const homeS = royaleDomBtn("royaleDomHomeSpec", "Home");
        prev.onclick = () => royaleDomAct("prev");
        next.onclick = () => royaleDomAct("next");
        play.onclick = () => royaleDomAct("play");
        homeS.onclick = () => royaleDomAct("home");
        spec.append(prev, next, play, homeS);
        document.body.appendChild(spec);
        const dead = document.createElement("div");
        dead.id = "royaleDeadDom";
        dead.style.cssText = "position:fixed;left:50%;bottom:8%;transform:translateX(-50%);z-index:31;display:none;gap:10px;align-items:center;";
        const sp = royaleDomBtn("royaleDomSpectate", "Spectate");
        const homeD = royaleDomBtn("royaleDomHomeDead", "Home");
        sp.onclick = () => royaleDomAct("spectate");
        homeD.onclick = () => royaleDomAct("home");
        // guests: the rank card's nudge has its button here, with the others
        const signup = royaleDomBtn("royaleDomSignup", "Get an account");
        signup.classList.add("accent");
        signup.style.display = "none";
        signup.onclick = () => royaleDomAct("signup");
        dead.append(sp, homeD, signup);
        document.body.appendChild(dead);
        // the death card's footer: big, green, counts the wait down first
        const again = royaleDomBtn("royaleDomPlayAgain", "Respawn");
        again.classList.add("play");
        again.style.cssText = "position:fixed;z-index:31;display:none;transform:translateX(-50%);";
        again.innerHTML = '<span class="pa-label"></span><kbd class="pa-key"></kbd>';
        // pointerdown, not click: a click needs the press and the release on the same
        const againAct = () => {
            if (again.disabled) return;
            const t = performance.now();
            if (t - (again._actAt || 0) < 400) return;
            again._actAt = t;
            gameSound.uiClick();
            global.rbWantBuild = false;
            royaleDomAct(again.dataset.ended ? "spectate" : "play");
        };
        // preventDefault: the press must not leave the focus on a button that hides on
        again.addEventListener("pointerdown", (e) => { if (e.button === 0 || e.pointerType === "touch") { e.preventDefault(); againAct(); } });
        again.onclick = againAct;
        document.body.appendChild(again);
        // round 9: "Respawn as <Tank>" beside it (same tank and stats)
        const asBuild = royaleDomBtn("royaleDomPlayBuild", "");
        asBuild.classList.add("play", "build");
        asBuild.style.cssText = "position:fixed;z-index:31;display:none;transform:translateX(-50%);flex-direction:column;justify-content:center;line-height:1.05;";
        asBuild.innerHTML = '<span class="pb-label"></span><span class="pb-sub" style="font-size:0.5em;opacity:0.85;margin-top:3px"></span>';
        const buildAct = () => {
            if (asBuild.disabled) return;
            const t = performance.now();
            if (t - (asBuild._actAt || 0) < 400) return;
            asBuild._actAt = t;
            gameSound.uiClick();
            global.rbWantBuild = true;
            royaleDomAct("play");
        };
        asBuild.addEventListener("pointerdown", (e) => { if (e.button === 0 || e.pointerType === "touch") { e.preventDefault(); buildAct(); } });
        asBuild.onclick = buildAct;
        document.body.appendChild(asBuild);
        try { updateRoyaleDomButtons(); } catch { /* */ }
    }
    // Runs every frame: the DOM is only written when a value changes (a style
    // or text write each frame was a style recalc each frame)
    const domEls = {};
    const domEl = (id) => { let e = domEls[id]; if (!e || !e.isConnected) e = domEls[id] = document.getElementById(id); return e; };
    const setStyle = (el, k, v) => { if (el && el.style[k] !== v) el.style[k] = v; };
    function introStyle(el, k, clicks) {
        if (!el) return;
        const y = global.deathIntroY | 0;
        setStyle(el, "opacity", k >= 1 ? "1" : String(Math.round(k * 100) / 100));
        setStyle(el, "transform", y ? "translate(-50%, " + y + "px)" : "translateX(-50%)");
        if (clicks) setStyle(el, "pointerEvents", k < 0.4 ? "none" : "");
    }
    function updateRoyaleDomButtons() {
        getRoyaleDomButtons();
        const spec = domEl("royaleSpecDom");
        const dead = domEl("royaleDeadDom");
        if (!spec || !dead) return;
        const inGame = !!(global.gameStart && !global.disconnected);
        const again = domEl("royaleDomPlayAgain");
        const asBuild = domEl("royaleDomPlayBuild");
        if (raidFinale.active()) {
            setStyle(spec, "display", "none");
            setStyle(dead, "display", "none");
            setStyle(again, "display", "none");
            setStyle(asBuild, "display", "none");
            setStyle(domEl("royaleDomBuildWhy"), "display", "none");
            try { signupPrompt.update(false); } catch (e) { }
            return;
        }
        const countdown = lastStormCount();
        const spectating = !!(inGame && global.royaleSpectating && !joinUp && !countdown);
        const deadShow = !!(inGame && global.died && global.royaleDied && !global.royaleSpectating && !countdown);
        setStyle(spec, "display", spectating ? "flex" : "none");
        setStyle(dead, "display", deadShow ? "flex" : "none");
        const ik = deadShow ? deathIntroK() : 1;
        global.deathIntroNow = ik;
        global.deathIntroY = deadShow ? Math.round(deathText.introSlide(ik, deathCalm())) : 0;
        introStyle(dead, ik, true);
        introStyle(again, ik, true);
        introStyle(asBuild, ik, true);
        introStyle(domEl("royaleDomBuildWhy"), ik, false);
        let longLifeUp = false;
        try { longLifeUp = signupPrompt.update(deadShow); } catch (e) { longLifeUp = false; }
        if (again) {
            const pc = global.deathPlayCss;
            const show = deadShow && !!pc;
            setStyle(again, "display", show ? "inline-flex" : "none");
            const st0 = show ? playAgainState() : null;
            const ra = show && !st0.ended && !global.tutorialMode ? buildBtnLabels.respawnAs(global.royale && global.royale.you, global.diedAsTank) : null;
            if (asBuild) setStyle(asBuild, "display", ra ? "inline-flex" : "none");
            // no saved build for an upgraded tank: a short reason line under the footer
            {
                if (!show) again._shownAt = 0; else if (!(again._shownAt > 0)) again._shownAt = performance.now();
                let why = domEl("royaleDomBuildWhy");
                if (!why) {
                    why = document.createElement("div");
                    why.id = "royaleDomBuildWhy";
                    why.style.cssText = "position:fixed;z-index:31;display:none;transform:translateX(-50%);font:600 13px Ubuntu,sans-serif;color:#fff;opacity:0.85;text-shadow:0 1px 2px #000;white-space:nowrap;pointer-events:none;";
                    document.body.appendChild(why);
                }
                const whyTxt = show && !st0.ended && !global.tutorialMode ? buildBtnLabels.respawnAsWhy(global.royale && global.royale.you, global.diedAsTank, performance.now() - again._shownAt) : "";
                setStyle(why, "display", whyTxt ? "block" : "none");
                if (whyTxt) {
                    if (why.textContent !== whyTxt) why.textContent = whyTxt;
                    setStyle(why, "left", pc.cx + "px");
                    setStyle(why, "top", Math.round(pc.top + pc.h + 8) + "px");
                }
            }
            if (show) {
                const st = st0;
                // two buttons share the footer: Respawn (left) and Respawn as <Tank>
                let pcA = pc;
                if (ra && asBuild) {
                    // Respawn as <Tank> is the bigger of the two (wider and a little taller, centred
                    const gap = pc.gap || 12, wa = pc.split ? Math.max(60, Math.min(pc.split, pc.w - gap - 60)) : Math.round((pc.w - gap) * 0.4), wb = pc.w - gap - wa;
                    const x0 = pc.cx - pc.w / 2;
                    pcA = { cx: Math.round(x0 + wa / 2), top: pc.top, w: wa, h: pc.h, big: pc.big };
                    const bfs = Math.max(12, Math.min(pc.big ? 26 : 22, Math.floor((wb - 28) / (Math.max(1, ra.label.length) * 0.55)))) + "px";
                    const wantB = { left: Math.round(x0 + wa + gap + wb / 2) + "px", top: pc.top + "px", width: wb + "px", height: pc.h + "px" };
                    for (const k in wantB) if (asBuild.style[k] !== wantB[k]) asBuild.style[k] = wantB[k];
                    setFontSize(asBuild, fitBtnFont(asBuild, asBuild.firstChild, ra.label, wb + "px", bfs));
                    const bl = asBuild.firstChild, bs = asBuild.lastChild;
                    if (bl.textContent !== ra.label) bl.textContent = ra.label;
                    if (bs.textContent !== ra.sub) bs.textContent = ra.sub;
                    const offB = !st.ready && !(st.queue && !st.queued);
                    if (asBuild.disabled !== offB) asBuild.disabled = offB;
                }
                // Enter opens the team chat on the duo server, so Space there
                let keyTxt = !st.ready || global.mobile ? "" : global.gamepadMode ? "RT" : (global.royale && global.royale.duos) ? "Space" : "Enter";
                // playtest 9 ("R... Enter"): beside Respawn as <Tank> the button is narrow,
                // so the key chip goes and the countdown is short ("Respawn 3")
                const narrow = !!(ra && asBuild) && pcA.w < 240;
                if (narrow) keyTxt = "";
                const labTxt = narrow ? shortRespawn(st.label) : st.label;
                // the first raids' card: a bigger word on a bigger button
                const lab0 = again.firstChild, key0 = again.lastChild;
                if (key0.textContent !== keyTxt) key0.textContent = keyTxt;
                setStyle(key0, "display", keyTxt ? "" : "none");
                const fs = st.ended ? playAgainFont(st, pcA, keyTxt, labTxt) : fitBtnFont(again, lab0, labTxt, pcA.w + "px", playAgainFont(st, pcA, keyTxt, labTxt));
                const want = { left: pcA.cx + "px", top: pcA.top + "px", width: pcA.w + "px", height: pcA.h + "px" };
                for (const k in want) if (again.style[k] !== want[k]) again.style[k] = want[k];
                setFontSize(again, fs);
                const lab = again.firstChild, key = again.lastChild;
                if (lab.textContent !== labTxt) lab.textContent = labTxt;
                setStyle(lab, "whiteSpace", st.ended ? "normal" : "");
                setStyle(lab, "lineHeight", st.ended ? "1.1" : "");
                if (key.textContent !== keyTxt) key.textContent = keyTxt;
                setStyle(key, "display", keyTxt ? "" : "none");
                // a wait can still be clicked: it queues the drop
                const off = !st.ready && !(st.queue && !st.queued) && !st.ended;
                if (again.disabled !== off) again.disabled = off;
                again.dataset.ended = st.ended ? "1" : "";
                // no respawns left: after a moment on the card, watch the finish
                if (st.ended) {
                    const now = performance.now();
                    if (!(again._endedAt > 0)) again._endedAt = now;
                    else if (now - again._endedAt > 2500 && !global.royaleSpectating) royaleDomAct("spectate");
                } else again._endedAt = 0;
            }
        }
        // the buttons sit right under the death card (gameDrawDeadRoyale)
        if (deadShow && global.deathPanelCss) {
            const left = global.deathPanelCss.cx + "px", top = global.deathPanelCss.top + "px";
            if (dead.style.left !== left) dead.style.left = left;
            if (dead.style.top !== top) { dead.style.top = top; dead.style.bottom = "auto"; }
        }
        const spBtn = domEl("royaleDomSpectate");
        if (spBtn) {
            const want = duoMateAlive() ? "Watch " + shortName(global.royale.duo.mate.name || "teammate", 12) : "Spectate";
            if (spBtn.textContent !== want) spBtn.textContent = want;
        }
        const signup = domEl("royaleDomSignup");
        if (signup) setStyle(signup, "display", deadShow && rankPanel.isGuestNudge() && !longLifeUp ? "" : "none");
        const play = domEl("royaleDomPlay");
        if (play) {
            const locked = !!(global.royale && global.royale.lock && global.royale.at > 0);
            const waitMs = Math.max(0, (global.raidRespawnAt || 0) - performance.now());
            let label = "Play";
            if (locked) label = (global.respawnQueued ? "Queued " : "") + Math.max(0, global.royale.lockLeft | 0) + "s";
            else if (global.respawnPending) label = "Wait";
            else if (global.died && waitMs > 0) label = "Play (" + Math.ceil(waitMs / 1000) + "s)";
            if (play.textContent !== label) play.textContent = label;
            // respawn() refuses until the death wait is up; look it too
            const off = !global.died || locked || global.respawnPending || waitMs > 0;
            setStyle(play, "opacity", off ? "0.55" : "1");
            // a lock or a wait still takes the click: it queues the drop
            const noClick = global.died && (global.respawnPending || global.respawnQueued);
            if (play.disabled !== noClick) play.disabled = noClick;
        }
    }
    function getIngameSettingsBtn() {
        if (ingameSettingsBtn) return ingameSettingsBtn;

        const btn = document.createElement("button");
        btn.id = "ingameSettingsBtn";
        btn.title = "Settings";
        const home = document.getElementById("homeSettingsBtn");
        btn.innerHTML = home ? home.innerHTML : "⚙";
        btn.onclick = () => {
            const panel = document.getElementById("homeSettingsPanel");
            const overlay = document.getElementById("homeSettingsOverlay");
            if (!panel) return;
            const open = !panel.classList.contains("open");
            panel.classList.toggle("open", open);
            if (overlay) overlay.classList.toggle("visible", open);
            btn.blur(); 

            if (!open) {
                const cv = document.getElementById("gameCanvas");
                if (cv && global.gameStart) cv.focus();
            }
        };
        document.body.appendChild(btn);

        // Fullscreen, right of the gear (portals love it). Hidden when
        // the page may not go fullscreen, e.g. a portal iframe without allow.
        const fs = window.dwFullscreen;
        let fsBtn = null;
        if (fs && fs.supported()) {
            fsBtn = document.createElement("button");
            fsBtn.id = "ingameFullscreenBtn";
            fsBtn.className = "dw-fs-toggle";
            fsBtn.title = fs.isOn() ? "Exit fullscreen" : "Fullscreen";
            fsBtn.setAttribute("aria-label", fsBtn.title);
            fsBtn.innerHTML = '<svg class="dw-ic fs-on"><use href="#i-fs"/></svg><svg class="dw-ic fs-off"><use href="#i-fs-exit"/></svg>';
            fsBtn.onclick = () => {
                // turned off by hand: touch.js stops asking for it back
                window.dwFsUserOff = fs.isOn();
                fs.toggle();
                fsBtn.blur();
                const cv = document.getElementById("gameCanvas");
                if (cv && global.gameStart) cv.focus();
            };
            document.body.appendChild(fsBtn);
        }

        // Raid spectate/death controls are DOM buttons, like the gear: canvas
        // clickables miss (map drag eats mousedown, auto-respawn clears died
        // before mouseup). Prev/Next cycle spectate
        // targets, Play rejoins, Home exits.
        getRoyaleDomButtons();

        // No in-game tutorial replay: the tutorial runs on its own server and
        // is reached from the homepage.

        setInterval(() => {
            const show = (global.gameStart && !global.died && !global.disconnected) ? "flex" : "none";
            btn.style.display = show;
            if (fsBtn) {
                fsBtn.style.display = show;
                if (show !== "none") fsBtn.style.left = (btn.offsetLeft + btn.offsetWidth + 8) + "px";
            }
            try { updateRoyaleDomButtons(); } catch { /* */ }
        }, 250);

        const panel = document.getElementById("homeSettingsPanel");
        if (panel && !panel.dwWired) {
            panel.dwWired = true;
            panel.addEventListener("change", (e) => {
                if (e.target && e.target.id) util.submitToLocalStorage(e.target.id);
                loadSettings();

                if (window.resizeEvent) window.resizeEvent();
            });
        }
        ingameSettingsBtn = btn;
        return btn;
    }

    function drawOptionsMenu() {
        getIngameSettingsBtn();
        if (global.clickables && global.clickables.optionsMenu) {
            global.clickables.optionsMenu.switchButton.hide();
            global.clickables.optionsMenu.toggleBoxes.hide();
        }
        if (global.optionsMenu_Anim) {
            global.optionsMenu_Anim.hit = { open: null, close: null };
            global.optionsMenu_Anim.isOpened = false;
        }
    }

    function runSecondary() {
        let pingAttempt = setInterval(() => {
            if (global.gameUpdate && !global.disconnected) {
                clearInterval(pingAttempt);
                resizeEvent();
                global.socket.ping(Date.now(), socketStuff.clockDiff - socketStuff.serverStart);
            };
        }, 500);
    }

    // Canvas side of the connecting / disconnected states: just the backdrop.
    // The message plate and its buttons are DOM (#dwJoin, updateJoinState).
    let drawConnectingScreen = () => {
        let ratio = util.getScreenRatio();
        scaleScreenRatio(ratio, true);
        clearScreen(HUD.wellSolid, 1, ctx[2]);
    };

    const drawDisconnectedScreen = () => {
        let ratio = util.getScreenRatio();
        scaleScreenRatio(ratio, true);
        clearScreen(HUD.wellSolid, global.gameStart ? 0.35 : 1, ctx[2]);
        lastPing = 0;
        global.clickables.reconnect.hide();
    };

    // ── Join / connection states (#dwJoin) ────────────────────────────────
    // One calm plate for every "you're not playing yet" moment: connecting,
    // reconnecting, disconnected / kicked, and the wait before your first
    // spawn (final-storm lock, the between-raids window, a slow spawn).
    // Timing comes from the RY packet: lockLeft / raidLeft while the storm
    // lock is on, the next-raid deadline (global.raidNextLeft) while the raid
    // is over.
    var joinEl = null, joinKey = "", joinUp = false, joinMode = "", joinModeAt = 0;   // var: read by updateRoyaleDomButtons above
    function joinClock(sec) {
        sec = Math.max(0, Math.ceil(sec));
        return Math.floor(sec / 60) + ":" + String(sec % 60).padStart(2, "0");
    }
    function getJoinEl() {
        if (joinEl) return joinEl;
        const el = document.createElement("div");
        el.id = "dwJoin";
        el.setAttribute("role", "status");
        el.setAttribute("aria-live", "polite");
        el.innerHTML =
            '<div class="dwj-card">' +
                '<img class="dwj-logo" src="/img/logo.svg" alt="" width="72" height="72">' +
                '<div class="dwj-title"></div>' +
                '<div class="dwj-count"><span class="dwj-count-lbl"></span><b class="dwj-count-n"></b></div>' +
                '<div class="dwj-line"></div>' +
                '<div class="dwj-dots" aria-hidden="true"><i></i><i></i><i></i></div>' +
                '<div class="dwj-btns">' +
                    '<button type="button" class="dw-btn dwj-back">Back to menu</button>' +
                    '<button type="button" class="dw-btn primary dwj-re">Reconnect</button>' +
                    '<button type="button" class="dw-btn primary dwj-solo">Go solo</button>' +
                '</div>' +
            '</div>';
        el.querySelector(".dwj-back").onclick = () => {
            try { gameSound.uiClick(); } catch { /* */ }
            // leaving the teammate queue: tell the server first
            if (global.duoFill) { try { global.socket.talk('DX', 'cancel'); } catch { /* */ } global.duoFill = null; }
            global.exit && global.exit(); hideJoinState();
        };
        el.querySelector(".dwj-solo").onclick = () => {
            try { gameSound.uiClick(); } catch { /* */ }
            if (!global.duoFill) return;
            try { global.socket.talk('DX', 'solo'); } catch { /* */ }
            global.duoFill = { phase: "solo", waited: 0, name: "", at: performance.now(), mine: true };
        };
        el.querySelector(".dwj-re").onclick = () => { try { gameSound.uiClick(); } catch { /* */ } if (global.disconnected) global.reconnect(); };
        document.body.appendChild(el);
        joinEl = el;
        return el;
    }
    function hideJoinState() {
        if (!joinUp) return;
        joinUp = false;
        joinKey = "";
        joinMode = "";
        if (joinEl) joinEl.classList.remove("open");
    }
    // Queued while the server holds spawns: the final storm lock, or the
    // wait between raids. Null when a spawn can go through. Raid state is
    // only trusted while its packets are fresh, so a previous game's raid
    // can't leak in.
    function raidWaitState(r, now) {
        if (!(r.at > 0) || now - r.at > 3000) return null;
        const age = (now - r.at) / 1000;
        if (r.ending) {
            const n = global.raidNextLeft(now);
            return { mode: "ending", title: "Raid over", lbl: n > 0.5 ? "Next raid starts in" : "", n: n > 0.5 ? joinClock(n) : "",
                line: n > 0.5 ? "The raid is over. You'll drop in when the next one starts." : "The next raid is starting…",
                back: true, dots: true };
        }
        if (r.lock) {
            const lockN = (r.lockLeft | 0) - age;
            const raidN = (r.raidLeft | 0) - age;
            if ((r.raidLeft | 0) > 0 && (r.raidLeft | 0) <= (r.lockLeft | 0)) {
                // the raid ends before the storm lock lifts
                const n = raidN + 17;
                return { mode: "late", title: "Final storm", lbl: "Next raid starts in", n: joinClock(n),
                    line: "The raid is ending, so nobody can spawn. You'll be in the next one.", back: true, dots: true };
            }
            return { mode: "lock", title: "Storm closing", lbl: lockN > 0.5 ? "You spawn in" : "", n: lockN > 0.5 ? joinClock(lockN) : "",
                line: lockN > 0.5 ? "Nobody can spawn while the storm is closing. You'll drop in when it opens." : "Spawning you now…",
                back: true, dots: true };
        }
        return null;
    }
    // What the plate should say right now, or null when you're playing.
    function joinState() {
        const now = performance.now();
        const r = global.royale || {};
        const ra = global.autoReconnect;
        if (global.disconnected) {
            const msg = String(global.message || "");
            let title = "Lost connection";
            if (global.noAutoReconnect) {
                title = /another tab|somewhere else|another device/i.test(msg) ? "Opened somewhere else"
                    : /banned/i.test(msg) ? "You're banned"
                    : /signed out|log in/i.test(msg) ? "Signed out"
                    : "Disconnected";
            }
            return { mode: "down", title, line: msg || "Connection closed. Press Reconnect to get back in.",
                back: true, re: true, dots: false, see: !!global.gameStart };
        }
        if (ra) {
            return { mode: "retry", title: "Lost connection", line: "Trying again (" + (ra.tries | 0) + "/8)", back: true, dots: true, see: !!global.gameStart };
        }
        // Duos, alone with Fill on: waiting for a teammate (the 'DW' packet)
        const df = global.duoFill;
        if (df && !(global.gameStart && !global.raidQueued && !global.died)) {
            const age = now - df.at;
            if (df.phase === "find") {
                const between = r.at > 0 && r.ending;
                return { mode: "fill", title: "Finding a teammate…", lbl: "Searching", n: joinClock(Math.floor((df.waited + age) / 1000)),
                    line: between ? "The raid is almost over, so you'll team up for the next one."
                        : "You'll team up with the next solo player who joins.",
                    back: true, backLbl: "Cancel", solo: true, dots: true };
            }
            if (df.phase === "bot" && age < 6000)
                return { mode: "fillbot", title: "No teammates around", line: "Finding you a teammate…", dots: true };
            if (df.phase === "paired" && age < 6000)
                return { mode: "paired", title: "Teamed up!", line: "Dropping in with " + (df.name || "your teammate") + "…", dots: true };
            if (df.phase === "solo" && age < 6000)
                return { mode: "fillsolo", title: "Going solo", line: df.mine ? "Dropping you in solo…" : "Nobody's around, so you're dropping in solo…", dots: true };
        }
        if (global.gameConnecting && !global.gameStart) {
            // joined during the final storm or between raids: the server
            // holds the spawn, so say why and for how long
            const wait = global.raidQueued && raidWaitState(r, now);
            if (wait) return wait;
            const slow = joinMode === "connect" && now - joinModeAt > 7000;
            const msg = String(global.message || "");
            return { mode: "connect", title: "Connecting…",
                line: msg || (slow ? "This is taking a while, please hang on." : String(global.tips || "")),
                back: true, dots: true };
        }
        // in the game, not spawned yet
        if (global.gameStart && !global.died && global.raidQueued) {
            const wait = raidWaitState(r, now);
            if (wait) return wait;
            // a normal spawn is near-instant: only speak up if it isn't
            if (joinMode !== "join" && !joinUp) {
                if (!joinState._waitAt) joinState._waitAt = now;
                if (now - joinState._waitAt < 600) return null;
            }
            const slow = joinMode === "join" && now - joinModeAt > 8000;
            return { mode: "join", title: "Getting you in…", line: slow ? "This is taking a while, please hang on." : "Finding you a spot to drop in.",
                back: true, dots: true };
        }
        joinState._waitAt = 0;
        return null;
    }
    function updateJoinState() {
        const st = joinState();
        if (!st) { hideJoinState(); return; }
        const el = getJoinEl();
        if (st.mode !== joinMode) { joinMode = st.mode; joinModeAt = performance.now(); }
        const key = [st.mode, st.title, st.lbl, st.n, st.line, st.back, st.backLbl, st.re, st.solo, st.dots, st.see].join("|");
        if (key !== joinKey) {
            joinKey = key;
            el.dataset.mode = st.mode;
            el.classList.toggle("see", !!st.see);
            el.querySelector(".dwj-title").textContent = st.title;
            const cnt = el.querySelector(".dwj-count");
            cnt.hidden = !st.n;
            el.querySelector(".dwj-count-lbl").textContent = st.lbl || "";
            el.querySelector(".dwj-count-n").textContent = st.n || "";
            const line = el.querySelector(".dwj-line");
            line.textContent = st.line || "";
            line.hidden = !st.line;
            el.querySelector(".dwj-dots").hidden = !st.dots;
            const back = el.querySelector(".dwj-back");
            back.hidden = !st.back;
            back.textContent = st.backLbl || "Back to menu";
            el.querySelector(".dwj-re").hidden = !st.re;
            el.querySelector(".dwj-solo").hidden = !st.solo;
            el.querySelector(".dwj-btns").hidden = !st.back && !st.re && !st.solo;
        }
        if (!joinUp) { joinUp = true; el.classList.add("open"); }
    }
    window.dwJoinState = { update: updateJoinState, hide: hideJoinState };

    const drawResyncScreen = () => {
        let ratio = util.getScreenRatio();
        scaleScreenRatio(ratio, true);
        clearScreen(gameDraw.mixColors(color.black, color.guiblack, 0.3), 0.25, ctx[2]);
        drawText("Out of sync", global.screenWidth / 2, global.screenHeight / 2 - 10, 30, color.red, "center");
        drawText("Your game got out of sync. Hang on while it fixes itself.", global.screenWidth / 2, global.screenHeight / 2 + 40, 15, color.guiwhite, "center");
        drawText("The game is paused until it catches up.", global.screenWidth / 2, global.screenHeight / 2 + 90, 15, color.guiwhite, "center");
    };

    const drawErrorScreen = () => {
        let ratio = util.getScreenRatio();
        scaleScreenRatio(ratio, true);
        clearScreen(gameDraw.mixColors(color.black, color.guiblack, 0.3), 0.25, ctx[2]);
        drawText("Something went wrong", global.screenWidth / 2, global.screenHeight / 2, 30, color.red, "center");
        drawText("If something on screen did it, try moving away from it.", global.screenWidth / 2, global.screenHeight / 2 + 30, 15, color.guiwhite, "center");
        drawText("Check the browser console (F12) and send me what it says.", global.screenWidth / 2, global.screenHeight / 2 + 60, 15, color.guiwhite, "center");
    }
    let animationFrame =
    (!/Chrome\/8[4-6]\.0\.41([4-7][0-9]|8[0-3])\./.test(navigator.userAgent) &&
      window.requestAnimationFrame) ||
    ((a) => setTimeout(() => a(performance.now()), 1e3 / 60));
    let lastCappedFrame = -1e9;
    function animloop(tick) {
        if (document.getElementById("gameAreaWrapper").style.display === "none") {
            hideJoinState();
            setTimeout(() => animloop(performance.now()), 200);
            return;
        }
        animationFrame(animloop);
        try { autoResTick(performance.now()); } catch (e) { }
        // 30 FPS cap: draw on a 30 Hz grid, taking the screen refresh that
        // lands closest (every other one at 60 Hz, every fourth at 120 Hz)
        if (config.graphical.fpsCap30) {
            const due = lastCappedFrame + 1000 / 30;
            if (tick < due - 6) return;
            lastCappedFrame = tick - due > 30 ? tick : due;   // after a stall, start the grid again
        }
        const drawAt = performance.now();
        renderFrame(tick);
        try { autoQ.frame(drawAt, performance.now() - drawAt); } catch (e) { }
    }
    // One frame of the game, separate from the scheduler so QA tooling can
    // step frames in a background tab where requestAnimationFrame is paused.
    let frameErrRun = 0;
    const frameErrSent = new Set();
    function reportFrameError(e) {
        const m = String((e && e.message) || e || "error").slice(0, 200);
        const st = String((e && e.stack) || "").slice(0, 700);
        const key = m + "|" + st.slice(0, 160);
        if (frameErrSent.has(key) || frameErrSent.size >= 4) return;
        frameErrSent.add(key);
        try {
            fetch("/api/clienterr", { method: "POST", credentials: "same-origin", keepalive: true, headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ m, s: st, w: "frame", v: String(location.pathname || "") }) }).catch(() => { });
        } catch (err) { }
    }
    window.dwRenderFrame = renderFrame;
    function renderFrame(tick) {
        resyncTransforms();
        sweepTextSprites();
        // the raid-end shake moves the whole layer, hit-stop or not
        raidFinale.shakeFrame(performance.now());
        // Hit-stop: hold the last frame for a beat when a rock is destroyed
        if (global.hitStop && Date.now() < global.hitStop && !config.graphical.noShake) return;
        if (global.gameStart) {

            let fovtickMotion = fovlasttick ? tick - fovlasttick : null;
            if (!(fovtickMotion >= 0 && fovtickMotion < 5000)) fovtickMotion = null;
            fovlasttick = tick;
            let renderv = null == fovtickMotion ? 0 : config.graphical.slowerFOV ? 0.98 : 0.99 ** fovtickMotion;
            let renderfov = global.player.animv.get(tick);
            global.player.renderv = global.player.renderv * renderv + renderfov * (1 - renderv);
            if (!(global.player.renderv > 0 && isFinite(global.player.renderv))) {
                global.player.renderv = renderfov > 0 && isFinite(renderfov) ? renderfov : 2000;
                voidWatch.heals++;
            }

            global.renderingInfo.entities = 0;
            global.renderingInfo.turretEntities = 0;
            global.renderingInfo.entitiesWithName = 0;
        }

        var ratio = config.graphical.screenshotMode ? 2 : util.getRatio();
        // the sky drop pulls the camera up and dives it back down (skyDrop.js)
        if (!config.graphical.screenshotMode) { try { ratio *= raidHeat.camZoom(ratio); } catch (e) { /* */ } }

        gameDraw.reanimateColors();
        for (let context of ctx) {
            context.lineCap = "round";
            context.lineJoin = "round";
            // The contexts stay scaled to the UI ratio between frames; when
            // the canvas is smaller than the UI scale, a clearRect in scaled
            // units only wipes part of it. Clear in device pixels, then put
            // the scale back.
            context.save();
            context.setTransform(1, 0, 0, 1, 0, 0);
            context.clearRect(0, 0, context.canvas.width, context.canvas.height);
            context.restore();
        }

        if (!isFinite(global.player.renderx) || !isFinite(global.player.rendery)) {
            global.player.renderx = global.player.cx.x;
            global.player.rendery = global.player.cy.y;
        }
        // Spectate glide consumer: ease the camera onto a far jump target.
        if (global._specGlide) {
            const g = global._specGlide;
            if (!global.died) {
                global._specGlide = null;
            } else {
                const k = Math.min(1, (performance.now() - g.t0) / g.dur);
                const e = k * k * k * (k * (k * 6 - 15) + 10);
                global.player.renderx = g.x0 + (g.x1 - g.x0) * e;
                global.player.rendery = g.y0 + (g.y1 - g.y0) * e;
                if (k >= 1) {
                    global.player.renderx = g.x1;
                    global.player.rendery = g.y1;
                    global._specGlide = null;
                }
            }
        }

        if (global.gameUpdate && !global.disconnected) {
            global.time = getNow();
            if (isNaN(global.time)) {
                global.gameUpdate = false;
                global.pullUpgradeMenu = true;
                global.pullSkillBar = true;
                resizeEvent();
                resync();
            }
            if (global.time - lastPing > 1000) {

                lastPing = global.time;

                global.metrics.rendertime = global.metrics.rendertimes - 1;
                global.metrics.rendertimes = 0;
                global.fps = global.metrics.rendertime;

                global.metrics.updatetime = global.updateTimes;
                global.updateTimes = 0;

                global.bandwidth.finalHa = global.bandwidth.currentHa;
                global.bandwidth.finalFa = global.bandwidth.currentFa;
                global.bandwidth.currentHa = 0;
                global.bandwidth.currentFa = 0;
                if (!global.secondaryLoop) global.secondaryLoop = true, runSecondary();
            }
            global.metrics.lag = global.time - global.player.time;
        }
        // (Full HD used to shift the HUD half a pixel here, an old trick for
        // 1px lines at 1x. With the HUD scaled to the UI size it only put
        // every edge and text sprite between two pixels: a blur.)
        let p = performance.now();
        try {
            drawGameplay(tick, ratio);
            try { watchVoid(performance.now()); } catch (e) { }
            // glitch strips and the low-health colour drain, under the HUD
            try { raidHeat.postWorld(ctx); } catch (e) { /* */ }
            drawGUI(tick, util.getScreenRatio());
            tutorial.hook();
            try { coach.hook(); } catch (e) { }
            try { firstHints.hook(hudAvoidRects); } catch (e) { }
            drawTopIndicators();
            if (global.showTree) drawUpgradeTree();
            if (global.gameStart && !global.died && !global.disconnected) {
                let ram = 0;
                const type = gui && gui.type;
                if (type) {
                    const mock = global.mockups[parseInt(String(type).split("-")[0], 10)];
                    if (mock && (!mock.guns || mock.guns.length === 0)) {
                        const spd = Math.hypot(global.player.vx || 0, global.player.vy || 0);
                        ram = Math.max(0, Math.min(1, spd / 8));
                    }
                }
                gameSound.rammerMove(ram);
                // the satchel heartbeat is continuous state, driven every frame
                const sg = global.gems;
                // the last seconds of a raid push the heartbeat too
                gameSound.satchelTension(Math.max(raidFinale.tension(), raidHeat.tension(), sg && sg.cap > 0
                    ? Math.min(1, (sg.carried || 0) / sg.cap) : 0));
            } else {
                gameSound.rammerMove(0);
                gameSound.satchelTension(0);
            }
            if (global.gameConnecting && !global.disconnected) {
                drawConnectingScreen();
            };
            if (global.died) {
                flushQueuedRespawn();
                gameDrawDead();
                // duos: your partner's pings stay readable over the death card
                if (global.GUIStatus.renderGUI && global.royale && global.royale.duos && !global.disconnected) {
                    try { drawDuoPings(); } catch (e) { /* never break the frame */ }
                }
                // the raid chat stays readable too (and in duos, the box to your partner)
                if (global.GUIStatus.renderGUI && !global.disconnected) { try { drawChatPanel(); } catch (e) { chatPanelRect = null; chatPanelErr = String(e && e.message); } }
            }
            drawRaidEndFx();
            if (global.showBigMap) drawBigMap();
            if (isNaN(global.time)) drawResyncScreen();
            if (global.disconnected) {
                drawDisconnectedScreen();
            }
            try { updateJoinState(); } catch (e) { /* never break the frame */ }
            if (global.dailyTankAd.renderUI) drawAdScreen();
            drawOptionsMenu(tick, 20, util.getScreenRatio());

            frameErrRun = 0;
        } catch (e) {
            frameErrRun++;
            reportFrameError(e);
            if (frameErrRun >= 90) drawErrorScreen();
            if (frameErrRun === 1 || frameErrRun % 600 === 0) console.error(e);
        }
        let t = performance.now();
        global.metrics.mspt = t - p;
    }
})(util, global, config, Canvas, colors, gameDraw, socketStuff)