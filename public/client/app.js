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

(async function (util, global, config, Canvas, color, gameDraw, socketStuff) {
    let { socketInit, resync, gui, leaderboard, minimap, moveCompensation, lag, getNow } = socketStuff;

    // ---- Hit feedback ----------------------------------------------------
    // The blink is triggered by the server (entity.js stamps hitAt on damage and
    // reports a decaying hitFlash); everything below is just how it's drawn.
    // White, not red: a red flash vanishes on the red team in a brawl. Warm
    // white is the diep/valorant trick - it reads on every team colour.
    const HIT_BLINK_MS = 180;
    const HIT_BLINK_STRENGTH = 0.88;
    const HIT_BLINK_COLOR = "#FFF4E0";
    const DMG_FADE_IN_MS = 160;
    const DMG_POP_MS = 300;
    const DMG_FADE_OUT_MS = 900;
    const DMG_COMBO_HOLD_MS = 1000;
    const DMG_RISE = 50;
    // Low-health vignette. Starts faint around half health and creeps inward
    // as you drop, so it reads as mounting pressure rather than a jump scare.
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

    // qa hook: forwards a packet to the live socket (server ignores debug packets unless enabled)
    window.royaleTalk = (...m) => { try { return global.socket && global.socket.talk && global.socket.talk(...m); } catch (e) { return e; } };
    window.royaleState = () => global;
    // console helper for trying items on a local server: window.dwGems(10000)
    window.dwGems = (n = 10000) => window.royaleTalk("DBG", "gems", n | 0);
    global.clearUpgrades = (clearNow = false) => {
        if (clearNow) gui.upgrades = [];
        else {
            global.pullUpgradeMenu = true;
            let loop = setInterval(() => {
                if (upgradeMenu.get() < (-global.columnCount * 3) * 0.9999) {
                    global.pullUpgradeMenu = false;
                    gui.upgrades = [];
                    clearInterval(loop);
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

    global.mobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry/i.test(navigator.userAgent);
    global.mobile && document.body.classList.add("mobile");
    if (!global.mobile) {
        document.getElementById("tabAppearance").classList.remove("shadowScroll");
        document.getElementById("tabOptions").classList.remove("shadowScroll");
    };

    function getKeybinds() {
        let kb = localStorage.getItem("keybinds");
        keybinds = typeof kb === "string" && kb.startsWith("{") ? JSON.parse(kb) : {};
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

    window.onload = async () => {

        global.serverMap = {};
        global.servers = [];

        global.loadServerSelector(false, "Connecting...");

        fetch("/getServers.json").then(response => response.json()).then(json => {
            global.servers = json;
            global.loadServerSelector(json);
        }).catch(error => {
            console.error(error);
        })

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
        // A hidden GUI is a screenshot-only state: never carry it across
        // sessions. Starting with a blank HUD reads as a broken game.
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
        util.retrieveFromLocalStorage("showCrosshair");
        util.retrieveFromLocalStorage("showJoystick");
        util.retrieveFromLocalStorage("optFullHD");
        util.retrieveFromLocalStorage("optUiScale");

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
            document.getElementById("optUiScale").value = global.mobile ? "mobile" : "small";
            util.submitToLocalStorage("optUiScale");
            localStorage.setItem("uiScaleSettings", "true");
        }
        // Desktop default moved from Normal to Small (Normal crowds a 1080p
        // screen). Players still on the old default get moved over once;
        // anyone who picks Normal again afterwards keeps it.
        if (!localStorage.getItem("uiScaleSmallDefault")) {
            if (!global.mobile && document.getElementById("optUiScale").value === "normal") {
                document.getElementById("optUiScale").value = "small";
                util.submitToLocalStorage("optUiScale");
            }
            localStorage.setItem("uiScaleSmallDefault", "1");
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
                    global.createTabMenu(`This server is running a development build of Dig Wars. (${global.version})`, "warning");
                }

                let keyValue = localStorage.getItem('playerKeyInputValue');
                (async function() {
                    let A_response = await fetch(`/api/getAddonAuthors?token=${keyValue}`);
                    let A_data = await A_response.json().catch(() => false);
                    if (A_data && Array.isArray(A_data)) initalizeAddonAuthors(A_data);
                })();
            });
        } catch { };

        if (global.mobile && window.innerHeight > 1.1 * window.innerWidth) {
            let tabMenu = global.createTabMenu("Please turn your device to landscape mode.", "warning", true);
            window.addEventListener("orientationchange", () => {
                window.innerHeight > 1.1 * window.innerWidth || tabMenu.remove();
            });
        };

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
                } else if (key === global.KEY_ENTER && !global.gameStart) {
                    startGame();
                }
            }
        };
        window.addEventListener("resize", resizeEvent);

        resizeEvent();
    };

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
        i_div.textContent = `Dig Wars ${global.version}` + `${global.devBuild ? "-dev" : ""}`;
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
        if (name !== null && author !== null) customPlate.textContent = `Custom - ${name} ${author}`;
        themeValue.addEventListener("input", () => {
            let {name, author} = getThemeDisplayName(themeValue);
            if (name !== null && author !== null) customPlate.textContent = `Custom - ${name} ${author}`; else customPlate.textContent = "Custom - Unable to pull name or author.";
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
        
        if (!global.mobile) {
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

            function spawnBurst(x, y) {
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

    function resizeEvent() {
        let scale = window.devicePixelRatio;
        if (config.graphical.lowResolution) {
            scale *= 0.5;
        }
        global.screenWidth = global.vscreenSize = window.innerWidth * scale;
        global.screenHeight = global.vscreenSizey = window.innerHeight * scale;
        c.resize(global.screenWidth, global.screenHeight);
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
    window.dwCtxCtor = (i) => ctx[i];
    // The tutorial's ore-tier card shows the real gem entities rather than
    // approximations of them, which means it needs the game's own renderer.
    // Assigned once drawEntity exists - see the bottom of this module.
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

    let CalcScreenSize = () => Math.max(global.vscreenSize, (16 / 9) * global.vscreenSizey) / global.player.renderv,
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
                    let realSize = size.toFixed(0);
                    alpha *= GetScreenDistance(instance.render.x - global.player.loc.x, instance.render.y - global.player.loc.y, parseInt(realSize));
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
                        alert("Your theme does not an entry for \"aqua\" (the color used by Hexagons). A fallback has been provided.");
                        content.aqua = content.teal;
                    } else if (!content.lavender) {
                        alert("Your theme does not an entry for \"lavender\" (the color used by the nest). A fallback has been provided.");
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
        } catch (e) { logError && alert("An error has accoured while reading your theme, it may be corrupted or outdated."); }

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
            c[3] && f.push(c[3]);
            y.innerHTML = f.join(" - ");
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
                global.UIscale = 1920;
                break;
            case "large":
                global.UIscale = 1536;
                break;
            case "mobile":
                global.UIscale = 1280;
                break;
        }
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

    function startGame() {

        if (global.gameLoading) return;
        global.gameLoading = true;
        // Fresh start: no raid state leaks in from a previous game.
        global.raidQueued = false;
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
                lock: 0, lockLeft: 0, you: null,
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
        global.launchingTutorial = false;
        global.launchingDigWars = false;
        if (global.mobile) {
            var d = document.body;
            d.requestFullscreen ? d.requestFullscreen()
                : d.msRequestFullscreen ? d.msRequestFullscreen()
                    : d.mozRequestFullScreen ? d.mozRequestFullScreen()
                        : d.webkitRequestFullscreen && d.webkitRequestFullscreen();
        }

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
        util.submitToLocalStorage("showCrosshair");
        util.submitToLocalStorage("showJoystick");
        util.submitToLocalStorage("optFullHD");
        util.submitToLocalStorage("optUiScale");

        util.submitToLocalStorage("optIncognitoMode");
        loadSettings();
        global.optionsCheckboxes = undefined;

        let playerNameInput = document.getElementById("playerNameInput");
        let playerKeyInput = document.getElementById("playerKeyInput");
        let autolevelUpInput = document.getElementById("autoLevelUp").checked;
        global.autolvlUp = autolevelUpInput;

        util.submitToLocalStorage("playerNameInput");
        util.submitToLocalStorage("playerKeyInput");
        global.playerName = global.player.name = playerNameInput.value;
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
    const mobileUpgradeGlide = Smoothbar(0, 2, 3, 0.08, 0.025, true);
    const lbGlide = AdvancedSmoothBar(0, 0.3, 1.5);
    const chatInput = Smoothbar(0, 2, 0.1, 0.07, 0.025, true);

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
    var getClassUpgradeKey = function (number) {
        switch (number) {
            case 0:
                return "Y";
            case 1:
                return "U";
            case 2:
                return "I";
            case 3:
                return "H";
            case 4:
                return "J";
            case 5:
                return "K";
            default:
                return null;
        }
    };

    let tiles,
        branches,
        tankTree,
        measureSize = (x, y, colorIndex, { index, tier = 0 }) => {
            tiles.push({ x, y, colorIndex, index });
            let { upgrades } = global.mockups[parseInt(index)],
                xStart = x,
                cumulativeWidth = 1,
                maxHeight = 1,
                hasUpgrades = [],
                noUpgrades = [];
            for (let i = 0; i < upgrades.length; i++) {
                let upgrade = upgrades[i];
                if (global.mockups[upgrade.index].upgrades.length) {
                    hasUpgrades.push(upgrade);
                } else {
                    noUpgrades.push(upgrade);
                }
            }
            for (let i = 0; i < hasUpgrades.length; i++) {
                let upgrade = hasUpgrades[i],
                    spacing = 2 * Math.max(1, upgrade.tier - tier),
                    measure = measureSize(x, y + spacing, upgrade.upgradeColor ?? i, upgrade);
                branches.push([{ x, y: y + Math.sign(i) }, { x, y: y + spacing + 1 }]);
                if (i === hasUpgrades.length - 1 && !noUpgrades.length) {
                    branches.push([{ x: xStart, y: y + 1 }, { x, y: y + 1 }]);
                }
                x += measure.width;
                cumulativeWidth += measure.width;
                if (maxHeight < measure.height) maxHeight = measure.height;
            }
            y++;
            for (let i = 0; i < noUpgrades.length; i++) {
                let upgrade = noUpgrades[i],
                    height = 2 + upgrades.length;
                measureSize(x, y + 1 + i + Math.sign(hasUpgrades.length) * 2, upgrade.upgradeColor ?? i, upgrade);
                if (i === noUpgrades.length - 1) {
                    if (hasUpgrades.length > 1) cumulativeWidth++;
                    branches.push([{ x: xStart, y }, { x, y }]);
                    branches.push([{ x, y }, { x, y: y + noUpgrades.length + Math.sign(hasUpgrades.length) * 2 }]);
                }
                if (maxHeight < height) maxHeight = height;
            }
            return {
                width: cumulativeWidth,
                height: 2 + maxHeight,
            };
        };

    function generateTankTree(indexes) {
        tiles = [];
        branches = [];
        tankTree = { width: 0, height: 0 };
        let rightmostSoFar = 0;
        if (!Array.isArray(indexes)) indexes = [indexes];
        for (let index of indexes) {
            rightmostSoFar += 3 + measureSize(rightmostSoFar, 0, 0, { index }).width;
        }
        for (let { x, y } of tiles) {
            tankTree.width = Math.max(tankTree.width, x);
            tankTree.height = Math.max(tankTree.height, y);
        }
    };

    function clearScreen(clearColor, alpha, context) {
        context.fillStyle = clearColor;
        context.globalAlpha = alpha;
        context.fillRect(0, 0, global.screenWidth, global.screenHeight);
        context.globalAlpha = 1;
    }

    // dev console handle (module-scoped state is otherwise unreachable)
    window.dwDebug = global;

    const fontWidth = "bold";
    function measureText(text, fontSize, withHeight = false) {
        fontSize += config.graphical.fontSizeBoost;
        ctx[2].font = fontWidth + " " + fontSize + "px Rubik, Ubuntu";
        let measurement = ctx[2].measureText(arrayifyText(text).reduce((a, b, i) => (i & 1) ? a : a + b, ''));
        return withHeight ? { width: measurement.width, height: fontSize } : measurement.width;
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
            } else if (textArrayRaw[1]) {
                textArray.push(first, textArrayRaw.shift());
            } else {
                textArrayRaw.shift();
                textArray.push(first + '§' + textArrayRaw.shift(), textArrayRaw.shift());
            }
        }
        return textArray;
    }

    function drawText(rawText, x, y, size, defaultFillStyle, align = "left", center = false, fade = 1, stroke = true, context = ctx[2]) {
        size += config.graphical.fontSizeBoost;

        let offset = size / 5,
            ratio = 1,
            textArray = arrayifyText(rawText),
            renderedFullText = textArray.reduce((a, b, i) => (i & 1) ? a : a + b, '');

        if (ratio !== 1) {
            size *= ratio;
        }
        context.font = "bold " + size + "px Rubik, Ubuntu";

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
        if (alignMultiplier) {
            Xoffset -= context.measureText(renderedFullText).width * alignMultiplier;
        }

        let strokeRatio = typeof stroke === "number" ? stroke : config.graphical.fontStrokeRatio;
        context.lineWidth = (size + 1) / strokeRatio;
        context.textAlign = "left";
        context.textBaseline = "middle";
        context.strokeStyle = color.black;
        context.fillStyle = defaultFillStyle;
        context.save();
        context.lineCap = "round";
        context.lineJoin = "round";
        if (fade < 1) context.globalAlpha *= Math.max(0, fade);
        if (ratio !== 1) {
            context.scale(1 / ratio, 1 / ratio);
        }

        Xoffset += x * ratio - size / 4;
        Yoffset += y * ratio - Yoffset * (center ? 1.05 : 1.5);
        if (stroke) {
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
                    Xoffset += context.measureText(textArray[i - 2] + str).width - context.measureText(str).width;
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
        ctx[2].beginPath();
        ctx[2].lineTo(Math.round(x1) + 0.5, Math.round(y1) + 0.5);
        ctx[2].lineTo(Math.round(x2) + 0.5, Math.round(y2) + 0.5);
        ctx[2].closePath();
        ctx[2].stroke();
    }

    function drawBar(x1, x2, y, width, color, context = ctx[2]) {
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
            // Offscreen blit is for faded bodies so guns+hull share one alpha.
            // Full-opacity tanks used to go through it too, which resized a
            // canvas per gun-tank per frame. Keep the path for transparency.
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
            let h = [];
            h = aspect > 0 ? [height * aspect, height] : [height, -height * aspect];

            let points = [],
                sinT = Math.sin(angle),
                cosT = Math.cos(angle);
            points.push([-position, h[1]]);
            points.push([length * 2 - position, h[0]]);
            points.push([length * 2 - position, -h[0]]);
            points.push([-position, -h[1]]);
            context.globalAlpha = alpha;

            context.beginPath();
            for (let point of points) {
                let newX = point[0] * cosT - point[1] * sinT + x,
                    newY = point[0] * sinT + point[1] * cosT + y;
                context.lineTo(newX, newY);
            }
            context.closePath();
            context.lineWidth *= strokeWidth
            context.lineWidth *= fill ? 1 : 0.5;
            if (!borderless) context.stroke();
            context.lineWidth /= fill ? 1 : 0.5;
            if (fill) context.fill();
            context.globalAlpha = 1;
        };

        return (baseColor, x, y, instance, ratio, alpha = 1, scale = 1, lineWidthMult = 1, rot = 0, turretsObeyRot = false, assignedContext = false, turretInfo = false, render = instance.render, smoothsize = false) => {

            const fade = turretInfo ? 1 : render.status.getFade();
            if (fade === 0 || alpha === 0) return;

            const alphaFade = fade * alpha;
            if (!global.gameUpdate && alphaFade < 0.5) return;

            let context = assignedContext || ctx[1];
            const indexStr = instance.index;
            const indexes = indexStr.split("-");
            const mockupIndex = +indexes[0];
            const m = global.mockups[mockupIndex] || global.missingno[0];
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

            // Carrier glow: a fat satchel broadcasts. Soft gold halo plus a
            // breathing rim, scaled by the synced glow rung (1-6, matching
            // the satchel size rungs so halo and pack always agree).
            const glowRung = (!turretInfo && !global.lowFx && (instance.gemGlow | 0)) || 0;
            if (glowRung > 0) {
                const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 480);
                const haloR = drawSize * (1.45 + 0.22 * glowRung);
                const ha = (0.10 + 0.05 * glowRung) * alphaFade * (0.8 + 0.2 * pulse);
                // The halo is the tank's own colour: a loaded carrier reads as
                // "that tank, glowing", not as a generic gold blob.
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

            const turrets = instance.isImage ? source.turrets : [...source.turrets, ...m.props];
            if (m.props) turrets.sort((a, b) => a.layer - b.layer);

            source.guns.update();

            let xx = x, yy = y;
            const useFancyCanvas = DEAIC(assignedContext, alphaFade, m.shape, m.glow, source.guns.length, turrets.length);

            if (useFancyCanvas) {
                context = ctx2;
                context.canvas.width = context.canvas.height = drawSize * m.position.axis + ratio * 20 * m.position.axis;
                xx = context.canvas.width / 2 - (drawSize * m.position.axis * m.position.middle.x * Math.cos(rot)) / 4;
                yy = context.canvas.height / 2 - (drawSize * m.position.axis * m.position.middle.x * Math.sin(rot)) / 4;
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

            // Server-driven hit blink, eased on the client so it stays smooth
            // between network ticks. A short fade-in then a squared falloff
            // reads as an impact rather than the tank simply changing colour.
            let hitBlend = 0;
            if (config.game.hitFlash && render.hitAt && instance.drawsHealth) {
                const ht = (performance.now() - render.hitAt) / HIT_BLINK_MS;
                if (ht < 1) {
                    const fadeIn = ht < 0.12 ? ht / 0.12 : 1;
                    hitBlend = fadeIn * (1 - ht) * (1 - ht) * HIT_BLINK_STRENGTH;
                }
            }

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
                    const gunAlpha = g.alpha === undefined ? 1 : g.alpha;
                    let mixedColor = gameDraw.mixColors(gunColor, statusColor, blend);
                    global.gameUpdate && instance.invuln !== 0 && 100 > (Date.now() - instance.invuln) % 200 && ((mixedColor = gameDraw.mixColors(gunColor, gameDraw.getColor(6), 0.3)));
                    if (hitBlend > 0) mixedColor = gameDraw.mixColors(mixedColor, HIT_BLINK_COLOR, hitBlend);
                    gameDraw.setColor(context, mixedColor);

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

                    let bodyColor = gameDraw.mixColors(
                        gameDraw.modifyColor(instance.color, baseColor),
                        statusColor,
                        blend
                    );
                    global.gameUpdate && instance.invuln !== 0 && 100 > (Date.now() - instance.invuln) % 200 && ((bodyColor = gameDraw.mixColors(gameDraw.modifyColor(instance.color, baseColor), gameDraw.getColor(6), 0.3)));
                    if (hitBlend > 0) bodyColor = gameDraw.mixColors(bodyColor, HIT_BLINK_COLOR, hitBlend);
                    gameDraw.setColor(context, bodyColor);

                    const glow = m.glow;
                    const glowRadius = glow.radius;

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

            if (!assignedContext && context !== ctx[1] && context.canvas.width > 0 && context.canvas.height > 0) {
                ctx[1].save();

                ctx[1].globalAlpha = alphaFade;
                ctx[1].imageSmoothingEnabled = true;

                ctx[1].drawImage(context.canvas, x - xx, y - yy);
                ctx[1].restore();
            }

            // hit ring lives on the world canvas so it isn't clipped by the
            // offscreen body blit. only health-drawing bodies, so a bullet
            // storm doesn't grow a field of white circles.
            if (turretInfo === false && !assignedContext && instance.drawsHealth && hitBlend > 0) {
                const ht = Math.max(0, Math.min(1, (performance.now() - render.hitAt) / HIT_BLINK_MS));
                const ringCtx = ctx[1];
                ringCtx.save();
                ringCtx.globalAlpha = alphaFade * (1 - ht) * (1 - ht) * 0.9;
                ringCtx.strokeStyle = HIT_BLINK_COLOR;
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
    // See the note by window.dwCtx: the tutorial draws real game entities on
    // its ore-tier card, so it needs the renderer that draws everything else.
    window.dwDrawEntity = drawEntity;

    const iconColorOrder = [10, 11, 12, 15, 13, 2, 14, 4, 5, 1, 0, 3];
    function getIconColor(colorIndex) {
        return iconColorOrder[colorIndex % 12].toString();
    }

    function drawEntityIcon(model, x, y, len, height, lineWidthMult, angle, alpha, colorIndex, upgradeKey, hover = false, extraScale = 1) {
        let picture = (typeof model == "object") ? model : util.getEntityImageFromMockup(model, gui.color),
            position = picture.position,
            scale = (0.6 * len * extraScale) / position.axis,
            entityX = x + 0.5 * len,
            entityY = y + 0.5 * height,
            baseColor = picture.color;

        let xShift = position.middle.x * Math.cos(angle) - position.middle.y * Math.sin(angle),
            yShift = position.middle.x * Math.sin(angle) + position.middle.y * Math.cos(angle);
        entityX -= scale * xShift;
        entityY -= scale * yShift;

        ctx[2].globalAlpha = alpha;
        ctx[2].fillStyle = picture.upgradeColor != null
            ? gameDraw.modifyColor(picture.upgradeColor)
            : gameDraw.getColor(getIconColor(colorIndex));
        drawGuiRect(x, y, len, height);

        if (hover) {
            if (global.clickables.clicked) {
                ctx[2].globalAlpha = 0.2;
                ctx[2].fillStyle = color.black;
            } else {
                ctx[2].globalAlpha = 0.15;
                ctx[2].fillStyle = color.guiwhite;
            }
            drawGuiRect(x, y, len, height);
        }
        ctx[2].globalAlpha = 0.25 * alpha;
        ctx[2].fillStyle = color.black;
        drawGuiRect(x, y + height * 0.6, len, height * 0.4);
        ctx[2].globalAlpha = 1;

        drawEntity(baseColor, entityX, entityY, picture, 1, 1, scale / picture.size, lineWidthMult, angle, true, ctx[2]);

        drawText(picture.upgradeName ?? picture.name, x + (upgradeKey ? 0.9 * len : len) / 2, y + height * 0.94, height / 10, color.guiwhite, "center");

        if (upgradeKey) {
            drawText("[" + upgradeKey + "]", x + len - 4, y + height - 6, height / 8 - 5, color.guiwhite, "right");
        }
        ctx[2].strokeStyle = color.black;
        ctx[2].lineWidth = 3 * lineWidthMult;
        drawGuiRect(x, y, len, height, true);
    }

    // Dig Wars: the cavern floor - a seamless tile drawn in the GAME'S OWN
    // vector language: flat fills only, hard edges, no gradients, no alpha
    // haze. Exactly how a professional flat-2D floor asset is authored -
    // big blobby two-tone earth patches (like the rocks' facets, laid flat)
    // and a few outlined pebbles that share the wall's border color. Built
    // once on an offscreen tile, world-locked, deterministic.
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
        // the floor's three flat tones: base, a step lighter, a step darker.
        // Neutral near-black so the cool teal wall and team colors own all
        // the contrast.
        const BASE = "#1e1d1b", LIGHT = "#232220", DARK = "#191817";
        t.fillStyle = BASE;
        t.fillRect(0, 0, S, S);
        // toroidal draw: paint each feature at all 9 wrap offsets so the
        // tile is seamless when repeated. All randomness is rolled BEFORE
        // the 9 copies so every copy is identical (no seams).
        const wrapped = (draw) => {
            for (let dx = -1; dx <= 1; dx++)
                for (let dy = -1; dy <= 1; dy++) {
                    t.save();
                    t.translate(dx * S, dy * S);
                    draw();
                    t.restore();
                }
        };
        // an irregular rounded blob: N points around a centre with jittered
        // radius, joined by quadratic curves - the universal flat-game-art
        // "patch of ground" shape
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
        // ── layer 1: large flat earth patches, dark then light, so the
        //    ground is visibly mottled but in only three quiet tones ──
        for (let i = 0; i < 9; i++) {
            const path = blob(rng() * S, rng() * S, 26 + rng() * 34);
            wrapped(() => { path(); t.fillStyle = DARK; t.fill(); });
        }
        for (let i = 0; i < 9; i++) {
            const path = blob(rng() * S, rng() * S, 20 + rng() * 28);
            wrapped(() => { path(); t.fillStyle = LIGHT; t.fill(); });
        }
        // ── layer 2: small flat dirt clods - tiny light blobs sitting on
        //    the patches, pure flat fill, like a tileset's detail pass ──
        for (let i = 0; i < 26; i++) {
            const path = blob(rng() * S, rng() * S, 2.5 + rng() * 4.5);
            const tone = rng() < 0.5 ? "#262521" : "#161514";
            wrapped(() => { path(); t.fillStyle = tone; t.fill(); });
        }
        // ── layer 3: a few pebbles in the wall's own visual language -
        //    flat stone fill + the SAME dark border every rock wears ──
        for (let i = 0; i < 12; i++) {
            const x = rng() * S, y = rng() * S;
            const r = 2.2 + rng() * 2.8, rot = rng() * Math.PI;
            const squish = 0.65 + rng() * 0.3;
            const col = rng() < 0.5 ? "#393732" : "#454239";
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

    // Dig Wars: the team Vault - THE bank, drawn in the game's own flat
    // style: bold shapes, dark outlines, a team-colored gem heart. Gold is
    // reserved for gem dust (deposit stream / progress), so a blue vault
    // never sits in a yellow halo on a blue floor.
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
        // The island is circular from the moment you join (lobby included),
        // not just once the raid goes live.
        return !!(global.digRoyaleMode || royaleActive());
    }
    function royaleLobbyPhase() {
        return false;
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
    function makeVaultSprites(pal = GOLD_PAL) {
        const S = 256, C = S / 2;
        const GEM = [[-1, -0.38], [-0.55, -0.95], [0.55, -0.95], [1, -0.38], [0, 0.95]];
        const layer = (draw) => {
            const cv = document.createElement("canvas");
            cv.width = cv.height = S;
            const c = cv.getContext("2d");
            c.translate(C, C);
            c.lineJoin = "round";
            draw(c);
            return cv;
        };
        const ring = (c, r, w, fill, stroke, sw = 5) => {
            c.lineWidth = w;
            c.strokeStyle = fill;
            c.beginPath(); c.arc(0, 0, r, 0, Math.PI * 2); c.stroke();
            c.lineWidth = sw;
            c.strokeStyle = stroke;
            c.beginPath(); c.arc(0, 0, r + w / 2, 0, Math.PI * 2); c.stroke();
            c.beginPath(); c.arc(0, 0, r - w / 2, 0, Math.PI * 2); c.stroke();
        };
        // static base: flat armored disc, arras-style dark borders
        const plate = layer((c) => {
            c.fillStyle = "#2a2e38";
            c.beginPath(); c.arc(0, 0, S * 0.47, 0, Math.PI * 2); c.fill();
            c.lineWidth = 7; c.strokeStyle = "#0d0f14"; c.stroke();
            c.lineWidth = 10; c.strokeStyle = pal.main;
            c.beginPath(); c.arc(0, 0, S * 0.455, 0, Math.PI * 2); c.stroke();
            c.lineWidth = 4; c.strokeStyle = "#0d0f14";
            c.beginPath(); c.arc(0, 0, S * 0.47, 0, Math.PI * 2); c.stroke();
            // team-colored stud bolts on the rim
            for (let i = 0; i < 8; i++) {
                const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
                const bx = Math.cos(a) * S * 0.415, by = Math.sin(a) * S * 0.415;
                c.fillStyle = pal.main;
                c.beginPath(); c.arc(bx, by, S * 0.026, 0, Math.PI * 2); c.fill();
                c.lineWidth = 3; c.strokeStyle = "#0d0f14"; c.stroke();
            }
            // recessed inner disc
            c.fillStyle = "#1e222b";
            c.beginPath(); c.arc(0, 0, S * 0.33, 0, Math.PI * 2); c.fill();
            c.lineWidth = 5; c.strokeStyle = "#0d0f14"; c.stroke();
        });
        // rotating lock ring: flat teeth, team-tipped
        const cog = layer((c) => {
            ring(c, S * 0.375, S * 0.045, "#565e6e", "#16181d", 4);
            for (let i = 0; i < 12; i++) {
                c.save();
                c.rotate((i / 12) * Math.PI * 2);
                c.fillStyle = i % 3 === 0 ? pal.main : "#6a7385";
                c.fillRect(S * 0.345, -S * 0.016, S * 0.062, S * 0.032);
                c.lineWidth = 3; c.strokeStyle = "#16181d";
                c.strokeRect(S * 0.345, -S * 0.016, S * 0.062, S * 0.032);
                c.restore();
            }
        });
        // the heart: a big team-color gem-cut emblem + three flat handles.
        // Same silhouette as every gem in the game - this is where they go.
        const wheel = layer((c) => {
            c.lineCap = "round";
            for (let i = 0; i < 3; i++) {
                const a = (i / 3) * Math.PI * 2 - Math.PI / 2;
                c.lineWidth = S * 0.05;
                c.strokeStyle = "#6a7385";
                c.beginPath();
                c.moveTo(Math.cos(a) * S * 0.12, Math.sin(a) * S * 0.12);
                c.lineTo(Math.cos(a) * S * 0.27, Math.sin(a) * S * 0.27);
                c.stroke();
                c.lineWidth = S * 0.018;
                c.strokeStyle = "#16181d";
                c.beginPath();
                c.moveTo(Math.cos(a) * S * 0.12, Math.sin(a) * S * 0.12);
                c.lineTo(Math.cos(a) * S * 0.27, Math.sin(a) * S * 0.27);
                c.stroke();
            }
            const drawGem = (scale, fill) => {
                c.fillStyle = fill;
                c.beginPath();
                GEM.forEach((p, i) => {
                    const px = p[0] * S * scale, py = p[1] * S * scale;
                    i ? c.lineTo(px, py) : c.moveTo(px, py);
                });
                c.closePath(); c.fill();
            };
            drawGem(0.155, pal.main);
            c.lineWidth = 5; c.strokeStyle = "#16181d"; c.stroke();
            drawGem(0.085, pal.light);
            drawGem(0.038, pal.high);
        });
        return { plate, cog, wheel };
    }

    function drawVaults(roomX, roomY, ratio) {
        if (royaleLobbyPhase()) return;
        if (!global.vaults.length) return;
        const now = performance.now();
        const v0 = global.vault;
        const halfW = global.gameWidth / 2, halfH = global.gameHeight / 2;
        const c = ctx[0];
        for (const v of global.vaults) {
            const sx = roomX + (v.x + halfW) * ratio;
            const sy = roomY + (v.y + halfH) * ratio;
            const R = v.r * 1.15 * ratio;
            if (sx < -R * 2 || sx > global.screenWidth + R * 2 ||
                sy < -R * 2 || sy > global.screenHeight + R * 2) continue;
            const depositing = v0.total > 0 && v0.onPad;
            const doneFlash = Math.max(0, 1 - (now - v0.doneAt) / 700);
            const rainbow = !!v.rainbow;
            const teamCol = rainbow ? hsvCss((now / 12) % 360)
                : gameDraw.getColor(v.team === -1 ? "blue" : "red");
            const pal = rainbow ? { main: teamCol, light: "#ffffff", high: "#ffffff" }
                : (v.team === -1 ? BLUE_PAL : RED_PAL);
            const doorSprites = rainbow ? getVaultSpritesForColor("#c5cad6")
                : getVaultSpritesForTeam(v.team);

            c.save();
            c.translate(sx, sy);
            c.fillStyle = "rgba(0,0,0,0.5)";
            c.beginPath(); c.arc(3, 5, R, 0, Math.PI * 2); c.fill();
            // flat octagonal foundation: tanks are round, structures are
            // not - the pad keeps the vault from reading as one more tank
            c.beginPath();
            for (let i = 0; i < 8; i++) {
                const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
                const ox = Math.cos(a) * R * 1.22, oy = Math.sin(a) * R * 1.22;
                i ? c.lineTo(ox, oy) : c.moveTo(ox, oy);
            }
            c.closePath();
            c.fillStyle = "#16181e";
            c.fill();
            c.globalAlpha = 0.35;
            c.fillStyle = teamCol;
            c.fill();
            c.globalAlpha = 1;
            c.lineWidth = Math.max(3, R * 0.07);
            c.lineJoin = "round";
            c.strokeStyle = teamCol;
            c.stroke();
            c.lineWidth = Math.max(2, R * 0.03);
            c.strokeStyle = "#0d0f14";
            c.stroke();
            const pulse = 0.5 + 0.5 * Math.sin(now / 650);
            {
                const auraR = R * (1.28 + 0.08 * pulse);
                // the rainbow vault cycles through 12 baked hues; a fixed team
                // colour bakes once
                let tintA = null;
                if (rainbow) {
                    const [hr, hg, hb] = hsvRgb((Math.round(((now / 12) % 360) / 30) * 30) % 360);
                    tintA = hr + "," + hg + "," + hb;
                } else {
                    const rgbA = toRgb(teamCol);
                    if (rgbA) tintA = rgbA.r + "," + rgbA.g + "," + rgbA.b;
                }
                if (tintA) {
                    const spr = haloSprite("aura|" + tintA, tintA, [[0.42, 1], [1, 0]]);
                    c.save();
                    c.globalAlpha = 0.22 + 0.10 * pulse + doneFlash * 0.28;
                    c.drawImage(spr, -auraR, -auraR, auraR * 2, auraR * 2);
                    c.restore();
                }
            }
            // team claim ring
            c.globalAlpha = 0.75 + 0.2 * pulse;
            c.lineWidth = Math.max(2.5, R * 0.06);
            c.strokeStyle = doneFlash > 0 ? (rainbow ? teamCol : pal.high) : teamCol;
            c.beginPath(); c.arc(0, 0, R * 1.06, 0, Math.PI * 2); c.stroke();
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
            if (depositing && v0.total > 0) {
                const frac = 1 - v0.remaining / v0.total;
                c.lineWidth = Math.max(3.5, R * 0.09);
                c.lineCap = "round";
                c.strokeStyle = GOLD_PAL.main;
                c.beginPath();
                c.arc(0, 0, R * 0.96, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
                c.stroke();
            }
            c.restore();

            // deposit dust: gold motes streaming from the player into the
            // vault heart, each swallowed with a tiny flash - the money is
            // visibly leaving your bag and entering the door
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
            // a small fully-opaque white "Vault" label floats above the door
            drawText("Vault", sx, sy - R * 1.38, R * 0.24, "#ffffff", "center", false, 1, 10, c);

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
            } else v0._burstDone = false;
        }

        // animate the dust
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

    // Dig Wars: forward outpost pads - flat octagonal foundations in the
    // same visual language as the vault, carved into the wall's pockets.
    // Grey while neutral, ringed in the owner's color once a banner stands
    // (the banner itself is a real entity and draws like any tank). A gold
    // arc shows capture progress on a contested neutral pad.
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
            // the capturable structure's body color: team blue/red, or the
            // site's sketch color once owned in Royale. Neutral is grey.
            const bodyCol = (st.o && st.c) ? st.c
                         : st.t === -1 ? gameDraw.getColor("blue")
                         : st.t === -2 ? gameDraw.getColor("red")
                         : (royaleActive() ? "#8a90a0" : gameDraw.getColor("yellow"));
            c.save();
            c.translate(sx, sy);
            c.lineJoin = "round";
            // flat octagonal foundation (the vault's structural language)
            c.beginPath();
            for (let i = 0; i < 8; i++) {
                const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
                const ox = Math.cos(a) * R * 1.08, oy = Math.sin(a) * R * 1.08;
                i ? c.lineTo(ox, oy) : c.moveTo(ox, oy);
            }
            c.closePath();
            c.fillStyle = "#16181e";
            c.fill();
            if (st.t || st.o) {
                c.globalAlpha = 0.28;
                c.fillStyle = ownCol;
                c.fill();
                c.globalAlpha = 1;
            } else if (royaleActive()) {
                c.globalAlpha = 0.16 + 0.08 * Math.sin(now / 700 + o.id);
                c.fillStyle = "#8a90a0";
                c.fill();
                c.globalAlpha = 1;
            }
            c.lineWidth = Math.max(3, R * 0.06);
            c.strokeStyle = (st.t || st.o) ? ownCol : (royaleActive() ? "#8a90a0" : "#111318");
            c.stroke();
            // recessed inner disc
            c.fillStyle = "#31363f";
            c.beginPath(); c.arc(0, 0, R * 0.74, 0, Math.PI * 2); c.fill();
            c.lineWidth = Math.max(2, R * 0.045);
            c.strokeStyle = "#16181d";
            c.stroke();
            // the capturable STRUCTURE: a big team-colored octagon standing on
            // the pad, drawn semi-transparent so it reads as a built thing.
            // the real banner entity is suppressed in drawEntities so players
            // always render ON TOP of the outpost (like the base vaults).
            if (st.t || st.h) {
                const bodyR = R * 1.33;   // matches the banner entity's realSize
                const tgtH = Math.max(0, Math.min(1, st.h || 0));
                if (o._smoothH === undefined) o._smoothH = tgtH;
                o._smoothH += (tgtH - o._smoothH) * 0.12;
                const frac = o._smoothH;
                const corePulse = 0.5 + 0.5 * Math.sin(now / 500 + o.id * 2);
                const coreAlpha = (0.18 + 0.12 * corePulse) * (0.4 + 0.6 * frac);
                const coreGrad = c.createRadialGradient(0, 0, 0, 0, 0, bodyR * 1.3);
                coreGrad.addColorStop(0, bodyCol);
                coreGrad.addColorStop(0.5, bodyCol);
                coreGrad.addColorStop(1, "rgba(0,0,0,0)");
                c.globalAlpha = coreAlpha;
                c.fillStyle = coreGrad;
                c.beginPath(); c.arc(0, 0, bodyR * 1.3, 0, Math.PI * 2); c.fill();
                c.globalAlpha = 1;
                c.globalAlpha = 0.55;
                c.beginPath();
                for (let i = 0; i < 8; i++) {
                    const a = (i / 8) * Math.PI * 2;
                    const ox = Math.cos(a) * bodyR, oy = Math.sin(a) * bodyR;
                    i ? c.lineTo(ox, oy) : c.moveTo(ox, oy);
                }
                c.closePath();
                c.fillStyle = bodyCol;
                c.fill();
                c.lineWidth = Math.max(3, R * 0.06);
                c.strokeStyle = "rgba(0,0,0,0.4)";
                c.stroke();
                c.globalAlpha = 0.15;
                c.lineWidth = Math.max(1.5, R * 0.025);
                c.strokeStyle = "#ffffff";
                for (let i = 0; i < 8; i++) {
                    const a = (i / 8) * Math.PI * 2;
                    c.beginPath();
                    c.moveTo(0, 0);
                    c.lineTo(Math.cos(a) * bodyR, Math.sin(a) * bodyR);
                    c.stroke();
                }
                c.globalAlpha = 1;
                const orbSpin = now / 4000 + o.id;
                c.save();
                c.rotate(orbSpin);
                c.globalAlpha = 0.4 + 0.2 * corePulse;
                c.lineWidth = Math.max(2, R * 0.03);
                c.strokeStyle = bodyCol;
                for (let i = 0; i < 6; i++) {
                    const a = (i / 6) * Math.PI * 2;
                    c.beginPath();
                    c.arc(0, 0, bodyR * 1.18, a - 0.12, a + 0.12);
                    c.stroke();
                }
                c.restore();
                c.globalAlpha = 1;
                const ringR = bodyR * 1.12;
                c.lineWidth = Math.max(3, R * 0.05);
                c.lineCap = "round";
                c.globalAlpha = 0.2;
                c.strokeStyle = "#000000";
                c.beginPath(); c.arc(0, 0, ringR, 0, Math.PI * 2); c.stroke();
                if (frac > 0.001) {
                    c.globalAlpha = 0.85;
                    c.strokeStyle = "#ffffff";
                    c.beginPath();
                    c.arc(0, 0, ringR, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
                    c.stroke();
                }
                c.globalAlpha = 1;
                // HP bar: sits ~5-6 px below the structure octagon's bottom edge
                const barW = R * 2.6, barH = Math.max(3, R * 0.06);
                const barY = bodyR + 5.5;
                c.fillStyle = "rgba(0,0,0,0.6)";
                c.fillRect(-barW / 2, barY, barW, barH);
                if (frac > 0.003) {
                    c.fillStyle = bodyCol;
                    c.fillRect(-barW / 2 + 1, barY + 1, (barW - 2) * frac, barH - 2);
                }
                c.lineWidth = 1.5;
                c.strokeStyle = "rgba(0,0,0,0.7)";
                c.strokeRect(-barW / 2, barY, barW, barH);
            }
            // ownership ring: breathes in the owner's color, dim grey neutral
            const pulse = 0.5 + 0.5 * Math.sin(now / 700 + o.id);
            c.globalAlpha = st.t ? 0.55 + 0.25 * pulse : 0.35;
            c.lineWidth = Math.max(2.5, R * 0.055);
            c.strokeStyle = ownCol;
            c.beginPath(); c.arc(0, 0, R * 0.92, 0, Math.PI * 2); c.stroke();
            c.globalAlpha = 1;
            c.restore();
            // CONQUEST BLAST: ownership just changed hands - a big double
            // shockwave in the new owner's color rolls off the site
            if (o._lastTeam === undefined) o._lastTeam = st.t;
            if (st.t !== o._lastTeam) {
                o._lastTeam = st.t;
                if (st.t) o._blastAt = now;           // captured (not the fall to grey)
            }
            if (o._blastAt && now - o._blastAt < 1200) {
                const t = (now - o._blastAt) / 1200;
                const eo = 1 - Math.pow(1 - t, 3);
                const a = Math.pow(1 - t, 1.4);
                c.save();
                for (let ring = 0; ring < 3; ring++) {
                    const rt = Math.max(0, eo - ring * 0.12);
                    if (rt <= 0) continue;
                    c.beginPath();
                    c.arc(sx, sy, R * (0.5 + 3.0 * rt), 0, Math.PI * 2);
                    c.strokeStyle = ring === 0 ? "#ffffff" : ownCol;
                    c.globalAlpha = a * (ring === 0 ? 0.8 : 0.5 - ring * 0.12);
                    c.lineWidth = Math.max(2, R * (0.14 - ring * 0.03) * (1 - t));
                    c.stroke();
                }
                const beamH = R * (1.5 + 3.5 * eo);
                const beamGrad = c.createLinearGradient(0, sy, 0, sy - beamH);
                beamGrad.addColorStop(0, ownCol);
                beamGrad.addColorStop(0.4, ownCol);
                beamGrad.addColorStop(1, "rgba(0,0,0,0)");
                c.globalAlpha = a * 0.5;
                c.fillStyle = beamGrad;
                const beamW = R * 0.35 * (1 - t * 0.5);
                c.beginPath();
                c.moveTo(sx - beamW, sy);
                c.lineTo(sx + beamW, sy);
                c.lineTo(sx + beamW * 0.3, sy - beamH);
                c.lineTo(sx - beamW * 0.3, sy - beamH);
                c.closePath();
                c.fill();
                c.globalAlpha = a * 0.4;
                const glowGrad = c.createRadialGradient(sx, sy, 0, sx, sy, R * (1 + eo));
                glowGrad.addColorStop(0, "#ffffff");
                glowGrad.addColorStop(0.3, ownCol);
                glowGrad.addColorStop(1, "rgba(0,0,0,0)");
                c.fillStyle = glowGrad;
                c.beginPath(); c.arc(sx, sy, R * (1 + eo), 0, Math.PI * 2); c.fill();
                for (let i = 0; i < 22; i++) {
                    const ang = (i / 22) * Math.PI * 2 + o.id;
                    const rr = R * (0.4 + 2.8 * eo);
                    const sz = Math.max(1.5, R * 0.06 * (1 - t * 0.7));
                    c.globalAlpha = a * (0.7 + 0.3 * Math.sin(i * 1.7));
                    c.fillStyle = i % 4 === 0 ? "#ffffff" : ownCol;
                    c.beginPath();
                    c.arc(sx + Math.cos(ang) * rr, sy + Math.sin(ang) * rr, sz, 0, Math.PI * 2);
                    c.fill();
                }
                c.globalAlpha = a * 0.5;
                c.lineWidth = Math.max(1.5, R * 0.03);
                c.strokeStyle = ownCol;
                for (let i = 0; i < 16; i++) {
                    const ang = (i / 16) * Math.PI * 2 + o.id + 0.1;
                    const rr = R * (0.4 + 2.6 * eo);
                    const tr = R * (0.4 + 2.2 * eo);
                    c.beginPath();
                    c.moveTo(sx + Math.cos(ang) * tr, sy + Math.sin(ang) * tr);
                    c.lineTo(sx + Math.cos(ang) * rr, sy + Math.sin(ang) * rr);
                    c.stroke();
                }
                c.restore();
            }
        }
    }

    // The outposts' mini vault doors - the EXACT vault art from the bases,
    // drawn large and ON TOP of the octagon foundation. Ring + door recolored
    // for the owner (blue / red) or neutral yellow. Rendered on the
    // BACKGROUND layer (below all players/entities) so the player always
    // appears on top of the outpost.
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
            const R = o.r * 0.92 * ratio;  // the door: big, front and center,
                                           // clearly ON TOP of the structure
            if (sx < -R * 3 || sx > global.screenWidth + R * 3 ||
                sy < -R * 3 || sy > global.screenHeight + R * 3) continue;
            const ownCol = (st.o && st.c) ? st.c
                        : st.t === -1 ? gameDraw.getColor("blue")
                        : st.t === -2 ? gameDraw.getColor("red")
                        : (royaleActive() ? "#8a90a0" : gameDraw.getColor("yellow"));
            c.save();
            c.translate(sx, sy);
            // ownership claim ring, exactly like the base vaults wear
            const pulse = 0.5 + 0.5 * Math.sin(now / 650 + o.id);
            c.globalAlpha = (st.t || st.o) ? 0.55 + 0.25 * pulse : 0.35;
            c.lineWidth = Math.max(2.5, R * 0.06);
            c.strokeStyle = ownCol;
            c.beginPath(); c.arc(0, 0, R * 1.06, 0, Math.PI * 2); c.stroke();
            c.globalAlpha = 1;
            // the same three door layers the base vaults use, recolored for
            // the owner (blue / red) or the site color / grey in Royale
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
    // The chambers render as a clean black octagon - no team halo, no facet
    // fill, no embedded crystal art and no damage cracks (the treasury gems
    // are real entities that drift inside the ring and render on top of this
    // floor-layer rock). The octagon's rotation is seeded deterministically
    // per chamber (id + site) so the two chambers don't sit at identical
    // angles, and the shape is built in UNIT space + scaled at draw time so
    // zoom changes never invalidate the cache.
    // art caches, keyed to the chamber list signature (ids recycle between
    // maps, so the whole cache drops whenever the sites change)
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

    // The chamber is built the way the outposts are: flat fills, chunky dark
    // borders, bold team colour, and it breathes. Geometry is cached ONCE per
    // site as unit-space Path2Ds and scaled at draw time, so it stays crisp at
    // any zoom and never needs rebuilding - and unlike blitting a sprite, the
    // only pixels touched are the ones the walls actually cover. (A 512px
    // sprite blit measured 3.2ms/frame on a software canvas; this is ~0.1ms.)
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
        // cache invalidation: chamber ids recycle between maps, so drop the
        // whole art cache whenever the site list changes
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
            // Unit-space paths scaled into place: line widths are given in unit
            // space too, so the transform carries them. The empty pocket is the
            // same art ghosted back and the regrowing ring is it scaled up from
            // nothing, so no state needs its own geometry.
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

            // The living layer, drawn fresh each frame the way the outposts do
            // theirs: a containment ring that breathes in the owner's colour
            // and a set of arc segments orbiting the wall. A handful of strokes
            // - everything static already came out of the sprite above.
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
            // integrity ring around the wall, exactly the outpost's capture
            // ring: a dark track with a white arc sweeping the remaining health
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
            drawText(o.name, sx, sy - o.r * ratio * 1.55 - 26,
                     Math.min(32, o.r * ratio * 0.42),
                     o.color || st.c || color.guiwhite, "center", false, 1, true, c);
            // Contested window, visible to both sides: callout + the
            // banner's remaining HP as the break bar. Attackers see what
            // they must finish, defenders see what they must save.
            if (st.cont) {
                const blink = 0.65 + 0.35 * Math.sin(performance.now() / 240);
                drawText("UNDER ATTACK", sx, sy - o.r * ratio * 1.55 - 86,
                         Math.min(24, o.r * ratio * 0.3),
                         "#ff6b5e", "center", false, blink, true, c);
                const bw2 = Math.min(110, o.r * ratio), bh2 = 7;
                const bx2 = sx - bw2 / 2, by2 = sy - o.r * ratio * 1.55 - 66;
                c.save();
                c.globalAlpha = blink;
                c.fillStyle = color.black;
                c.fillRect(bx2 - 1, by2 - 1, bw2 + 2, bh2 + 2);
                c.fillStyle = "#e03e41";
                c.fillRect(bx2, by2, bw2 * Math.max(0, Math.min(1, st.h || 0)), bh2);
                c.restore();
            }
            if (royaleActive() && st.l > 0) {
                drawText(st.l + "s", sx, sy + o.r * ratio * 1.05,
                         Math.min(22, o.r * ratio * 0.28),
                         st.c || color.guiwhite, "center", false, 1, true, c);
            }
        }
        // core chambers wear their name above the boulder too - and only once
        // the ring is fully regrown (st.st === 0): no name while the pocket is
        // empty, none while the sliver is still growing back
        for (const ch of global.chambers) {
            const st = global.chamberState.find(s => s.id === ch.id) || {};
            if (st.st !== undefined && st.st !== 0) continue;
            const sx = -px + global.screenWidth / 2 + ratio * (ch.x);
            const sy = -py + global.screenHeight / 2 + ratio * (ch.y);
            const R = ch.r * ratio;
            if (sx < -R * 2 || sx > global.screenWidth + R * 2 ||
                sy < -R * 2 || sy > global.screenHeight + R * 2) continue;
            // Same plain label treatment the outposts use, in the owning
            // team's colour, cleared above the integrity ring.
            const labelSize = Math.min(32, ch.r * ratio * 0.3);
            drawText(ch.name, sx, sy - ch.r * ratio * 1.07 - labelSize * 1.5,
                     labelSize,
                     ch.team === -1 ? gameDraw.getColor("blue") : gameDraw.getColor("red"),
                     "center", false, 1, true, c);
        }
    }

    function stormSnap() {
        const s = global.royale && global.royale.storm;
        if (!s || !s.a) return null;
        if (s.n == null) return s;
        // RY lands every 500ms but n predicts +250ms. Clamping at 1 used to
        // glide, freeze, glide (the stutter). Extrapolate at the same rate
        // instead so the edge moves continuously; the cap only guards stalls.
        const t = Math.min(4, Math.max(0, (performance.now() - global.royale.at) / 250));
        return Object.assign({}, s, { r: (s.r || 0) + ((s.n || s.r) - s.r) * t });
    }
    function circleRadiusWorld() {
        const s = global.royale && global.royale.storm;
        if (s && s.max > 0) return s.max;
        return Math.min(global.gameWidth, global.gameHeight) / 2;
    }
    function fillStormOnMap(c, mapX, mapY, scale, x, y, w, h) {
        const s = stormSnap();
        if (!s) return;
        const cx = mapX(s.cx || 0), cy = mapY(s.cy || 0);
        const maxR = (s.max || circleRadiusWorld()) * scale;
        const rr = Math.max(2, (s.r || 0) * scale);
        c.save();
        c.beginPath();
        c.rect(x, y, w, h);
        c.arc(cx, cy, rr, 0, Math.PI * 2, true);
        c.fillStyle = "rgba(88, 48, 120, 0.38)";
        c.fill("evenodd");
        c.strokeStyle = "#5a2a78";
        c.lineWidth = 2;
        c.beginPath();
        c.arc(cx, cy, rr, 0, Math.PI * 2);
        c.stroke();
        c.restore();
    }
    function playerInStorm() {
        const s = stormSnap();
        if (!s) return false;
        const px = global.player.renderx, py = global.player.rendery;
        const dx = px - (s.cx || 0), dy = py - (s.cy || 0);
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
        const cx = roomX + ((s.cx || 0) + halfW) * ratio;
        const cy = roomY + ((s.cy || 0) + halfH) * ratio;
        const rr = Math.max(0, (s.r || 0) * ratio);
        const c = ctx[0];
        c.save();
        c.beginPath();
        c.rect(-40, -40, global.screenWidth + 80, global.screenHeight + 80);
        c.arc(cx, cy, rr, 0, Math.PI * 2, true);
        c.clip("evenodd");
        c.fillStyle = "rgba(72, 38, 96, 0.46)";
        c.globalAlpha = 1;
        c.fillRect(-40, -40, global.screenWidth + 80, global.screenHeight + 80);
        c.restore();
        c.save();
        const wall = Math.max(8, 12 * ratio);
        c.beginPath();
        c.arc(cx, cy, rr + wall, 0, Math.PI * 2);
        c.arc(cx, cy, Math.max(0, rr - 2), 0, Math.PI * 2, true);
        c.fillStyle = "#6a3a78";
        c.fill("evenodd");
        c.strokeStyle = "#2a1028";
        c.lineWidth = Math.max(2, 2.5 * ratio);
        c.beginPath();
        c.arc(cx, cy, rr, 0, Math.PI * 2);
        c.stroke();
        c.restore();
    }

    function drawFloor(px, py, ratio, tick) {

        // out-of-bounds void: even darker than the cavern floor
        clearScreen("#0d0d0c", 1, ctx[0]);

        let gameWidth = global.gameWidth = global.player.roomAnim.x.get(tick);
        let gameHeight = global.gameHeight = global.player.roomAnim.y.get(tick);

        ctx[0].globalAlpha = 1;
        // room base = the dirt tile's ground color, so even if the pattern
        // ever fails to build the floor is dark, never white
        ctx[0].fillStyle = "#1e1d1b";

        let roomX = -px + global.screenWidth / 2 - ratio * gameWidth / 2,
            roomY = -py + global.screenHeight / 2 - ratio * gameHeight / 2,
            roomWidth = ratio * gameWidth,
            roomHeight = ratio * gameHeight;
        // Circular dirt island for round maps and dig royale alike (lobby
        // included - the map is a circle from the moment you join). The dirt
        // is clipped to a perfect circle, but the ROCKS draw unclipped after
        // the restore below, so rim rocks overhang raw and are never sliced.
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
        // Square dirt base for normal modes. Royale paints its dirt under
        // the rocks only (below), leaving void at the raw rock edge.
        if (!royaleMode() || !getMapPaths()) ctx[0].fillRect(roomX, roomY, roomWidth, roomHeight);
        // muddy cavern floor: repeat the dirt tile across the room,
        // anchored to world coordinates and scaled with the camera so the
        // ground never "swims". PERF: only the visible slice of the room is
        // pattern-filled - filling the whole room rect each frame was a
        // fullscreen-and-then-some rasterization for nothing.
        // Royale island: dirt lives ONLY under the rocks (their combined
        // path), so the void starts exactly at the rocks' raw edge. No
        // square dirt corners, no rock ever cut or culled for it.
        if (royaleMode()) {
            const islPaths = getMapPaths();
            if (islPaths) {
                if (!floorPattern) floorPattern = makeFloorPattern(ctx[0]);
                ctx[0].save();
                ctx[0].translate(roomX + roomWidth / 2, roomY + roomHeight / 2);
                ctx[0].scale(ratio, ratio);
                ctx[0].fillStyle = "#1e1d1b";
                ctx[0].fill(islPaths.alive);
                ctx[0].fill(islPaths.dead);
                ctx[0].fillStyle = floorPattern;
                ctx[0].fill(islPaths.alive);
                ctx[0].fill(islPaths.dead);
                ctx[0].restore();
            }
        }
        if (!floorPattern) floorPattern = makeFloorPattern(ctx[0]);
        if (!royaleMode() || !getMapPaths()) {
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
                    // Team floors are deep, saturated islands. Structures on
                    // top then wear a brighter team jewel so blue never sits
                    // on yellow and red never reads as rust-on-dirt.
                    let tintAlpha = 0.3;
                    if (tile.color === "blue") {
                        try { tileColor = gameDraw.mixColors(tileColor, "#1a46c8", 0.62); } catch (e) { /* keep */ }
                        tintAlpha = 0.52;
                    } else if (tile.color === "red") {
                        try { tileColor = gameDraw.mixColors(tileColor, "#c31828", 0.55); } catch (e) { /* keep */ }
                        tintAlpha = 0.48;
                    }

                    if (tileColor !== color.white) {
                        // bases/nests keep their ORIGINAL look: lay down the
                        // stock light floor under the tint so the team color
                        // reads exactly as it always did - bright, safe
                        // islands punched out of the dark cavern dirt
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
        // the rock wall first - the vaults and outposts sit ON TOP of it, so
        // nothing ever washes over the doors or their labels
        if (window.terrainRenderer && window.terrainRenderer.ready) {
            // near-opaque on the dark cavern floor - the old 0.5 wash only
            // read against a white arena; here it would melt into the dirt
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
        // Dig Wars: core chamber boulders beside each vault (one big rock per
        // team with the treasury drifting inside - gems are real entities, so
        // they render on top of this floor-layer rock)
        drawChambers(roomX, roomY, ratio);
        // the outposts' mini vault doors - drawn here in the FLOOR layer (below
        // players) so the player always renders on top of the outpost
        drawOutpostDoors(px, py, ratio);
    }

    // Dig Wars: the outpost structure is a real server entity (its HP drives
    // capture combat) but every pixel of it - octagon, door, HP bar - is drawn
    // by the dedicated floor-layer passes (drawOutposts + drawOutpostDoors).
    // Flag its entity here so the generic entity pass never paints a second
    // octagon or a second health bar over the pad.
    function isOutpostBannerEntity(instance) {
        if (!instance || !instance.index) return false;
        const _obM = global.mockups[parseInt(instance.index.split("-")[0])];
        return !!(_obM && (_obM.name === "Outpost" || _obM.className === "outpostBanner"));
    }

    // Dig Wars: core chamber boulders are drawn entirely by the floor-layer
    // drawChambers pass - suppress the entity so it never paints a second
    // rock or a second health bar over the boulder.
    function isCoreChamberEntity(instance) {
        if (!instance || !instance.index) return false;
        const _obM = global.mockups[parseInt(instance.index.split("-")[0])];
        return !!(_obM && (_obM.name === "Core Chamber" || _obM.className === "coreChamber"));
    }

    // Dig Wars: treasury gems locked inside a chamber ring. They're real
    // entities (the server drifts them), but rendering 80+ of them through the
    // full entity pipeline (body + facet + sparkle Props + glow + spin
    // transform) is what melted the frame rate around a chamber. Each class is
    // instead pre-rendered ONCE onto a hidden canvas that replicates the real
    // drawEntity output (halo + body + outline + facet + sparkle, the exact
    // same layered cut the loose pickups wear), and per frame a contained gem
    // costs ONE rotated drawImage - no shadowBlur, no path building, no
    // allocation. Gem pickups near a ring's outline are included (they read
    // the same, and the test is a cheap distance check). Returns the gem class
    // when contained (also used as a truthy skip test), "" otherwise.
    // Every gem pickup draws from its baked sprite (glow included). Sending
    // loose gems through drawEntity meant one live shadowBlur pass per gem
    // per frame, which is what made a Retina laptop crawl with 15 gems on
    // screen. The class is cached on the instance once the mockup is known.
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

    // The canonical gem cut (unit coords) - mirrors GEM_CUT in terrainRenderer
    // and digwars.js, so the baked gems keep the exact same silhouette.
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

    // Per-class art. body / facet / glow(+radius+alpha) are the gemPickup* +
    // gemFacet* + GLOW values from digwars.js, so the baked gems carry the
    // exact same palette AND halo as the loose pickups the full entity
    // pipeline draws elsewhere. The rim is gameDraw.getColorDark(body) - the
    // same darkened tint the pipeline gives every real pickup, theme-aware.
    // `size` is the treasury tier's SIZE for that class: the real pipeline's
    // outline is a fixed world-space width (borderChunk * strokeWidth, not
    // proportional to the gem), so the bake divides it by each class's size.
    const GEM_SPRITE_PAL = {
        gemPickupCopper:      { size: 16, body: "#c96f2e", facet: "#eda766", glow: "#e8a05c", glowR: 0.8,  glowA: 0.3 },
        gemPickupVein:        { size: 20, body: "#3b7ce0", facet: "#7fb1f2", glow: "#6fa3f2", glowR: 1,    glowA: 0.35 },
        gemPickupShard:       { size: 30, body: "#b13ecf", facet: "#d98af0", glow: "#e08af5", glowR: 1.4,  glowA: 0.45 },
        gemPickupShardCore:   { size: 34, body: "#b13ecf", facet: "#d98af0", glow: "#e08af5", glowR: 2,    glowA: 0.55 },
        gemPickupEmerald:     { size: 34, body: "#1fbf6b", facet: "#6ff5a8", glow: "#6ff5a8", glowR: 1.8,  glowA: 0.55 },
        gemPickupEmeraldCore: { size: 34, body: "#1fbf6b", facet: "#6ff5a8", glow: "#6ff5a8", glowR: 2.4,  glowA: 0.65 },
        gemPickupLoot:        { size: 7,  body: "#e0a63b", facet: "#f2cf7f", glow: "#f5cf6e", glowR: 1.2,  glowA: 0.4 },
    };

    // Baked, full-fidelity sprites. Every contained gem is pre-rendered once
    // per class onto a hidden canvas that replicates the REAL drawEntity
    // output for a gem pickup: soft glow halo (shadowBlur under a borderless
    // body fill at the glow's alpha), the filled gem cut, its darkened rim
    // (stroke first, so the fill hides the inner half - exactly like the real
    // pipeline), then the facet + sparkle Props at their true size/offset/
    // angle (0.525 / 0.2 of the body, 0.12 crown / 0.405 offset, 12deg spin).
    // The bake runs colors through gameDraw.modifyColor too, so the sprite is
    // byte-for-byte the same colors a loose gem draws one screen over.
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

        // body: stroke first, then fill hides the inner half (real pipeline)
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

        // sparkle prop (0.2 scale, 0.405 offset at direction+angle = up-left,
        // spun 12deg exactly like the real gemSparkle's t.angle)
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

    // Draw a contained gem from its cached sprite: one rotated drawImage, no
    // per-frame shadowBlur or allocation. `isize` is the gem's render size
    // (world units); the real pipeline maps the unit cut to `isize * ratio`
    // pixels, so the sprite is blitted at exactly that scale.
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
    // Tutorial ore-tier card: same baked sprite the world gems use, sized in
    // pixels so the legend cannot drift into a mockup/icon version.
    window.dwDrawGem = function (c, x, y, bodyPx, alpha, facing, cls) {
        const pal = GEM_SPRITE_PAL[cls] || GEM_SPRITE_PAL.gemPickupVein;
        const isize = pal.size || 16;
        drawContainedGem(c, x, y, bodyPx / isize, alpha, isize, facing, cls);
    };

    // ── Baked radial halos: one gradient per colour, drawn as an image ──
    // A live createRadialGradient per entity per frame was the single most
    // expensive thing in the render path.
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
    // ── Raid bosses wear an aura: a floor halo in their colour, two
    // counter-rotating dashed rings and five orbiting shards. Cheap (one
    // baked sprite plus a few strokes) and unmistakable from across the map.
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
        c.drawImage(haloSprite("bossaura|" + tint, tint, [[0, 0.6], [0.45, 0.22], [1, 0]]), x - hr, y - hr, hr * 2, hr * 2);
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
        // two lighter facets and a darker lower half give it the rock's
        // flat-shaded look without a texture
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
        const tier = kind.epic ? 3 : 1;
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
        c.fillStyle = "rgb(38,34,48)"; c.fill(g.body);
        c.fillStyle = "rgb(47,43,59)"; c.fill(g.facets);
        c.fillStyle = "rgba(5,4,7,0.28)"; c.fill(g.shade);
        if (stage >= 1) { c.fillStyle = "rgba(5,4,7," + (0.06 * stage).toFixed(2) + ")"; c.fill(g.body); }
        const borderPx = tilePx ? 0.072 * rockSz * tilePx : Math.max(2, 3 * ratio);
        c.lineWidth = borderPx / R; c.strokeStyle = "rgb(5,4,7)"; c.stroke(g.body);
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
        // the prize: one ore gem set into the rock, drawn from the same
        // baked sprite the loose gems use (glow included)
        // The prize is set INTO the rock: a pocket cut below the surface, the
        // gem sitting low in it with only its crown showing (no glow, flat
        // fills like everything else on the wall), an inner shadow from the
        // pocket's upper edge, and the rock's own border running over the
        // gem's edge with a lip of stone across its foot.
        const gemK = 0.40 * sy;
        const gx = x + trX, gy = y + trY, gr = R * gemK;
        const gpal = kind.epic ? { body: "#b13ecf", facet: "#d98af0", deep: "#6d2287" } : { body: "#c96f2e", facet: "#eda766", deep: "#7a4018" };
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
        c.fillStyle = "rgb(38,34,48)"; c.fillRect(gx - gr * 1.5, gy + gr * 0.48, gr * 3, gr * 1.3);
        c.fillStyle = "rgba(5,4,7,0.7)"; c.fillRect(gx - gr * 1.5, gy + gr * 0.48, gr * 3, Math.max(1, R * 0.04));
        c.restore();
        pocket();
        c.lineJoin = "round"; c.lineWidth = Math.max(1.5, borderPx * 0.8); c.strokeStyle = "rgb(5,4,7)"; c.stroke();
        c.restore();
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
        for (let instance of global.entities) {
            if (!instance.render.draws) {
                instance._onScreen = false;
                continue;
            }
            // Dig Wars: the outpost banner is drawn entirely by the floor-layer
            // passes - skip the entity so it never paints a second octagon over
            // the pad (its custom HP bar lives in drawOutposts too). Core
            // chamber boulders are drawn by drawChambers the same way.
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
            }
            x += global.screenWidth / 2;
            y += global.screenHeight / 2;
            const rad = (isize || instance.size) * ratio + 80;
            const onScreen = instance.id === gui.playerid ||
                (x >= -rad && y >= -rad && x <= global.screenWidth + rad && y <= global.screenHeight + rad);
            instance._onScreen = onScreen;
            instance._sx = x;
            instance._sy = y;
            if (!onScreen) continue;
            let alpha = instance.id === gui.playerid ? 1 : instance.alpha;
            alpha = handleScreenDistance(alpha, instance, false);
            // treasury gems inside a chamber ring: the real gem look (halo +
            // body + outline + facet + sparkle) restacked from cached paths,
            // skipping the whole body+prop+spin pipeline
            const _gcls = gemSpriteClass(instance);
            if (_gcls) {
                let ga = instance.alpha * alpha * instance.render.status.getFade();
                // expiring gems blink like any invulnerable entity would
                if (instance.invuln && 100 > (Date.now() - instance.invuln) % 200) ga *= 0.55;
                if (ga > 0.01) drawContainedGem(ctx[1], x, y, ratio, ga, isize, instance.render.f, _gcls);
                continue;
            }
            const _chest = isLootChestEntity(instance);
            if (_chest) {
                drawChestBoulder(ctx[1], x, y, instance, ratio, instance.alpha * alpha, isize, _chest);
                continue;
            }
            if (isRoyaleBossEntity(instance)) drawBossAura(ctx[1], x, y, instance, ratio, instance.alpha * alpha);
            drawEntity(baseColor, x, y, instance, ratio, instance.alpha * alpha, 1, 1, instance.render.f, false, false, false, instance.render, isize);
            if (global.royale && global.outpostState && !royaleLobbyPhase() && global.royale.phase === "live") {
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
        for (let instance of global.entities) {
            // Dig Wars: same banner skip as the shape pass - the generic entity
            // health bar must not stack over the pad's custom HP bar.
            if (!instance._onScreen) continue;
            if (isOutpostBannerEntity(instance)) continue;
            if (isCoreChamberEntity(instance)) continue;
            if (gemSpriteClass(instance)) continue;
            if (isLootChestEntity(instance)) continue;
            let alpha = instance.id === gui.playerid ? 1 : instance.alpha;
            alpha = handleScreenDistance(alpha, instance);
            let x = instance.id === gui.playerid ? global.player.screenx : instance._sx - global.screenWidth / 2,
                y = instance.id === gui.playerid ? global.player.screeny : instance._sy - global.screenHeight / 2;
            drawHealth(x, y, instance, ratio, gui.visibleEntities ? 1 : alpha, instance.size);
            drawName(x, y, instance, ratio, gui.visibleEntities ? alpha * 0.75 + 0.25 : alpha, instance.size);
        }
        for (let instance of global.entities) {
            if (!instance._onScreen) continue;
            if (gemSpriteClass(instance)) continue;
            if (isLootChestEntity(instance)) continue;
            let alpha = instance.id === gui.playerid ? 1 : instance.alpha;
            alpha = handleScreenDistance(alpha, instance);
            let x = instance.id === gui.playerid ? global.player.screenx : instance._sx - global.screenWidth / 2,
                y = instance.id === gui.playerid ? global.player.screeny : instance._sy - global.screenHeight / 2;
            drawChatMessages(x, false, py, instance, ratio, gui.visibleEntities ? 1 : alpha, instance.size, px, py);
            drawChatInput(x, y, instance, ratio, instance.size);
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

    global.scrollX = global.scrollY = global.fixedScrollX = global.fixedScrollY = -1;
    global.scrollVelocityY = global.scrollVelocityX = 0;
    let lastGuiType = null;
    let classTreeDrag = {
        isDragging: false,
        startX: 0,
        startY: 0,
        lastX: 0,
        lastY: 0,
        momentum: { x: 0, y: 0 }
    };

    let searchResults = [];
    let filteredTiles = null;
    let searchCache = new Map();

    const SHOW_NAMES_ZOOM_THRESHOLD = 1.5;
    const CULL_MARGIN = 200;

    let tankNameCache = new Map();
    global.searchQuery = '';
    function searchTankByName(query) {
        if (!query || query.trim() === '') {
            searchResults = [];
            filteredTiles = null;
            tankNameCache.clear();
            global.searchQuery = '';
            return;
        }

        const lowerQuery = query.toLowerCase().trim();
        global.searchQuery = query;

        if (searchCache.has(lowerQuery)) {
            const cached = searchCache.get(lowerQuery);
            searchResults = cached.results;
            filteredTiles = cached.tiles;
            return;
        }

        if (tankNameCache.size === 0) {
            for (let i = 0; i < global.mockups.length; i++) {
                const m = global.mockups[i];
                if (m && m.name) {
                    tankNameCache.set(i, m.name.toLowerCase());
                }
            }
        }

        searchResults = [];
        const matchingIndexes = new Set();

        for (let [index, name] of tankNameCache) {
            if (name.includes(lowerQuery)) {
                searchResults.push(global.mockups[index]);
                matchingIndexes.add(index);
            }
        }

        if (searchResults.length > 0) {

            filteredTiles = [];

            const leadsToSearchResult = (tankIndex, visited = new Set()) => {
                if (visited.has(tankIndex)) return false;
                visited.add(tankIndex);

                if (matchingIndexes.has(parseInt(tankIndex))) return true;

                const mockup = global.mockups[parseInt(tankIndex)];
                if (mockup && mockup.upgrades) {
                    for (let upgrade of mockup.upgrades) {
                        if (leadsToSearchResult(upgrade.index, visited)) {
                            return true;
                        }
                    }
                }
                return false;
            };

            for (let tile of tiles) {
                const tileIndex = parseInt(tile.index);
                if (matchingIndexes.has(tileIndex) || leadsToSearchResult(tile.index)) {
                    filteredTiles.push(tile);
                }
            }
        } else {

            filteredTiles = tiles.filter(tile => {
                const mockup = global.mockups[parseInt(tile.index)];
                return mockup && mockup.className === 'basic';
            });
        }

        searchCache.set(lowerQuery, {
            results: searchResults,
            tiles: filteredTiles
        });
    }
    global.searchTankByName = searchTankByName;

    function drawUpgradeTree(spacing, alcoveSize) {
        if (global.died) {

            global.tankTree("exit");
            return;
        }

        if (lastGuiType != gui.type || global.generateTankTree) {
            try {
                let m = util.requestEntityImage(gui.type),
                    rootName = m.rerootUpgradeTree,
                    rootIndex = [];
                for (let name of rootName) {
                    let mockup = global.mockups.find(i => i && i.className === name);
                    let ind = name == undefined || !mockup ? -1 : mockup.index;
                    rootIndex.push(ind);
                }
                if (!rootIndex.includes(-1)) {
                    generateTankTree(rootIndex);
                }
                lastGuiType = gui.type;
                global.generateTankTree = false;

                global.searchQuery = '';
                searchResults = [];
                filteredTiles = null;
                searchCache.clear();
            } catch { }
        }

        if (!tankTree) {
            console.log('No class tree rendered yet.');
            return;
        }

        ctx[2].globalAlpha = 0.5;
        ctx[2].fillStyle = color.guiwhite;
        ctx[2].fillRect(0, 0, global.screenWidth, global.screenHeight);
        ctx[2].globalAlpha = 1;

        if (global.renderTankTree) {
            let tileSize = alcoveSize / 2,
                size = tileSize - 4,
                spaceBetween = 10,
                screenDivisor = (spaceBetween + tileSize) * 2 * global.treeScale,
                padding = tileSize / screenDivisor,
                dividedWidth = global.screenWidth / screenDivisor,
                dividedHeight = global.screenHeight / screenDivisor,
                treeFactor = 1 + spaceBetween / tileSize;

            if (!classTreeDrag.isDragging) {
                const friction = 0.92;
                classTreeDrag.momentum.x *= friction;
                classTreeDrag.momentum.y *= friction;

                if (Math.abs(classTreeDrag.momentum.x) < 0.1) classTreeDrag.momentum.x = 0;
                if (Math.abs(classTreeDrag.momentum.y) < 0.1) classTreeDrag.momentum.y = 0;
            }

            global.scrollVelocityX = classTreeDrag.momentum.x;
            global.scrollVelocityY = classTreeDrag.momentum.y;

            global.fixedScrollX = Math.max(
                dividedWidth - padding,
                Math.min(
                    tankTree.width * treeFactor + padding - dividedWidth,
                    global.fixedScrollX + global.scrollVelocityX
                )
            );
            global.fixedScrollY = Math.max(
                dividedHeight - padding,
                Math.min(
                    tankTree.height * treeFactor + padding - dividedHeight,
                    global.fixedScrollY + global.scrollVelocityY
                )
            );
            if (Math.abs(global.targetTreeScale - global.treeScale) > 0.001) {
                global.treeScale += (global.targetTreeScale - global.treeScale) * 0.15;
                if (Math.abs(global.targetTreeScale - global.treeScale) < 0.001) {
                    global.treeScale = global.targetTreeScale;
                }
            }

            global.scrollX = util.lerp(global.scrollX, global.fixedScrollX, 0.10, true);
            global.scrollY = util.lerp(global.scrollY, global.fixedScrollY, 0.10, true);

            const tilesToRender = filteredTiles || tiles;

            const halfWidth = global.screenWidth / 2;
            const halfHeight = global.screenHeight / 2;
            const tileSpacing = tileSize + spaceBetween;
            const scaledSpacing = tileSpacing * global.treeScale;
            const halfSize = 0.5 * size;

            ctx[2].strokeStyle = color.black;
            ctx[2].lineWidth = 2 * global.treeScale;
            ctx[2].beginPath();

            for (let [start, end] of branches) {
                let sx = ((start.x - global.scrollX) * tileSpacing + 1 + halfSize) * global.treeScale + halfWidth,
                    sy = ((start.y - global.scrollY) * tileSpacing + 1 + halfSize) * global.treeScale + halfHeight,
                    ex = ((end.x - global.scrollX) * tileSpacing + 1 + halfSize) * global.treeScale + halfWidth,
                    ey = ((end.y - global.scrollY) * tileSpacing + 1 + halfSize) * global.treeScale + halfHeight;

                if (ex < -CULL_MARGIN || sx > global.screenWidth + CULL_MARGIN ||
                    ey < -CULL_MARGIN || sy > global.screenHeight + CULL_MARGIN) continue;

                ctx[2].moveTo(sx, sy);
                ctx[2].lineTo(ex, ey);
            }
            ctx[2].stroke();

            let angle = -Math.PI / 4;
            const scaledTileSize = tileSize * global.treeScale;

            for (let { x, y, colorIndex, index } of tilesToRender) {
                let ax = (x - global.scrollX) * scaledSpacing + halfWidth,
                    ay = (y - global.scrollY) * scaledSpacing + halfHeight;

                if (ax < -scaledTileSize - CULL_MARGIN || ax > global.screenWidth + CULL_MARGIN ||
                    ay < -scaledTileSize - CULL_MARGIN || ay > global.screenHeight + CULL_MARGIN) continue;

                drawEntityIcon(index.toString(), ax, ay, scaledTileSize, scaledTileSize, global.treeScale, angle, 1, colorIndex, false, false, 1);
            }
        }

        drawClassTreeUI(spacing);

        ctx[2].globalAlpha = 1;
    }
    global.targetTreeScale = 1;
    global.classTreeDrag = classTreeDrag;
    function drawClassTreeUI(spacing) {
        if (!global.renderTankTree) {

            return;
        }
        const uiY = spacing + 20;
        const buttonSize = 40;
        const buttonSpacing = 10;

        drawText("Arrow keys or mouse to navigate the class tree. Shift to navigate faster. Scroll wheel, (+/- keys) or zoom buttons to zoom in/out.", global.screenWidth / 2, spacing + 10, 17, color.guiwhite, "center");

        const searchBarWidth = 300;
        const searchBarHeight = 35;
        const searchBarX = global.screenWidth / 2 - searchBarWidth / 2;
        const searchBarY = uiY;

        ctx[2].globalAlpha = global.searchBarActive ? 0.95 : 0.8;
        ctx[2].fillStyle = global.searchBarActive ? color.vlgrey : color.white;
        ctx[2].fillRect(searchBarX, searchBarY, searchBarWidth, searchBarHeight);
        ctx[2].strokeStyle = global.searchBarActive ? color.blue : color.black;
        ctx[2].lineWidth = global.searchBarActive ? 3 : 2;
        ctx[2].strokeRect(searchBarX, searchBarY, searchBarWidth, searchBarHeight);
        ctx[2].globalAlpha = 1;

        const displayText = global.searchBarActive && !global.searchQuery
            ? "Type to search..."
            : global.searchQuery || "Click to search tanks...";
        const textColor = color.white;
        const showCursor = global.searchBarActive && Date.now() % 1000 < 500;

        drawText(
            displayText + (showCursor ? "|" : ""),
            searchBarX + 10,
            searchBarY + searchBarHeight / 2,
            14,
            textColor,
            "left",
            true
        );

        const zoomInX = searchBarX + searchBarWidth + buttonSpacing + 20;
        const zoomOutX = zoomInX + buttonSize + buttonSpacing;

        drawButton(
            zoomInX,
            searchBarY,
            buttonSize,
            searchBarHeight,
            1,
            "rect",
            "+",
            20,
            color.grey,
            color.black,
            color.black,
            true,
            "classTreeZoomIn",
            global.canvas.height / global.screenHeight / global.ratio,
            0
        );

        drawButton(
            zoomOutX,
            searchBarY,
            buttonSize,
            searchBarHeight,
            1,
            "rect",
            "-",
            20,
            color.grey,
            color.black,
            color.black,
            true,
            "classTreeZoomOut",
            global.canvas.height / global.screenHeight / global.ratio,
            1
        );

        const closeButtonSize = 35;
        const closeButtonX = searchBarX - buttonSpacing * 2.6;
        const closeButtonY = uiY;

        drawButton(
            closeButtonX,
            closeButtonY,
            closeButtonSize,
            closeButtonSize,
            1,
            "rect",
            "✕",
            24,
            color.red,
            color.black,
            color.black,
            true,
            "classTreeClose",
            global.canvas.height / global.screenHeight / global.ratio,
            0
        );

        const instructionY = searchBarY + searchBarHeight + 5;
        if (global.searchQuery) {
            const resultsText = searchResults.length > 0
                ? `Found ${searchResults.length} tank${searchResults.length !== 1 ? 's' : ''} (showing upgrade paths)`
                : "No tanks found - showing Basic";
            drawText(
                resultsText,
                global.screenWidth / 2,
                instructionY + 10,
                11,
                searchResults.length > 0 ? color.green : color.orange,
                "center"
            );
        }
    }

    // Bottom of the top-centre message stack, refreshed every frame by
    // drawMessages and read by drawMilestones so the two can't overlap.
    let messageStackBottom = 0;

    function drawMessages(spacing, alcoveSize) {

        let height = 18;
        let x = global.screenWidth / 2;
        let y = spacing + 5;
        // Royale: stack runs top-right under the kill feed so the raid
        // clock and storm timer keep top-center to themselves.
        const msgRight = typeof royaleActive === "function" && royaleActive();
        if (msgRight) {
            const feedN = Math.min(6, ((global.royale && global.royale.feed) || []).length);
            y = Math.max(42 + feedN * 18 + 12, (royaleFeedBottom || 0) + 12);
        }
        if (global.mobile) {
            if (global.canUpgrade) {
                mobileUpgradeGlide.set(0 + (global.canUpgrade || global.upgradeHover));
                y += (alcoveSize / 1.4 ) * mobileUpgradeGlide.get();
            }
            y += global.canSkill || global.showSkill ? (alcoveSize / 2.2 ) * statMenu.get() : 0;
        }

        var Bd = Date.now();
        var yy = config.animationSettings.ScaleBar;
        // the right-hand stack stops above the minimap instead of running into it
        const yLimit = msgRight && !global.mobile ? global.screenHeight - alcoveSize - spacing - 22 - 30 : Infinity;
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
            if (y > yLimit) continue;

            let K = Math.max(0, Math.min(1, time / 300, duration / 300));
            if (msg.textJSON) {
                let len = 0;

                msg.textJSON.forEach((txt) => {
                    if (len < measureText(txt, height - 4.25, false)) len = measureText(txt, height - 4.25, false)
                })
                ctx[2].globalAlpha = 0.5 * K;

                const jx = msgRight ? global.screenWidth - 18 - len : x - len / 2;
                drawBarAdvanced(jx, jx + len, y + yy / 2, height, color.black, 17.5 * (msg.textJSON.length) - 17.5 + 1);
                ctx[2].globalAlpha = K;

                msg.textobjs = [];
                msg.textJSON.forEach((txt) => {
                    msg.textobjs[msg.textobjs.length] = function () { };
                    drawText(txt, jx + 2, y + 16 + 17.5 * (msg.textobjs.length - 1), height - 4.3, color.guiwhite, "left", false, 1, 5.5);
                })
                y += 23 * K + 17.5 * (3 - 2 * K) * (msg.textJSON.length - 1) * K * K;
            } else {

                if (msg.len == null) msg.len = measureText(text, height - 4.3);

                ctx[2].globalAlpha = 0.5 * K;
                const bx = msgRight ? global.screenWidth - 18 - msg.len : x - msg.len / 2;
                drawBar(bx, bx + msg.len, y + yy / 2, height + 2, color.black);

                ctx[2].globalAlpha = K;
                drawText(text, bx + msg.len / 2, y + yy / 1.3, height - 4.3, color.guiwhite, "center", false, 1, 5.5);
                y += 23 * (3 - 2 * K) * K * K;
            }
        }
        // Remember where the stack ended so the milestone cards can sit under
        // it instead of on top of it - both live at top-centre, and Dig Wars
        // broadcasts (emerald finds, war events) land here constantly.
        messageStackBottom = y;
        ctx[2].globalAlpha = 1;
    }

    function drawChatMessages(x, y, py, instance, ratio, alpha, isize) {
        if (global.GUIStatus.renderChat === false) return;
        if (!(instance.id === gui.playerid) && instance.alpha < 0.25) return;
        let size = isize * ratio,
            g = Math.max(20, size);

        if (!y) y = instance.id === gui.playerid
            ? global.player.screeny - 1 * global.showChatGlide * g
            : ratio * instance.render.y - py;

        let fade = instance.render.status.getFade();
        fade *= fade;
        ctx[1].globalAlpha = fade;

        x += global.screenWidth / 2;
        y += global.screenHeight / 2;
        if (instance.id !== gui.playerid && instance.nameplate) y -= 8 * ratio;
        let messages = global.chats[instance.id];
        if (!messages) return;

        const messageSpacing = 25 * 0.04 * g;

        for (let i = 0; i < messages.length; i++) {
            let chatIndex = messages.length - 1 - i;
            let chat = messages[chatIndex],
                text = chat.text,
                msgLengthHalf = measureText(text, 0.5 * g) / 2,
                crownLift = (config.game.leaderIndicators && global.leader &&
                             global.leader.id === instance.id) ? 0.55 : 0,
                barScale = (global.GUIStatus.renderPlayerScores ? 3.05 : 2.65) + crownLift,
                textScale = (global.GUIStatus.renderPlayerScores ? 2.84 : 2.44) + crownLift,
                valpha = chat.alpha.get();

            if (chat.erased && valpha === 0) {
                util.remove(global.chats[instance.id], chatIndex);
                messages.sort((a, b) => a.id - b.id);
            }
            if (chat.targetY === undefined) {
                chat.targetY = i * messageSpacing;
                chat.currentY = i === 0 ? 0 : (i-1) * messageSpacing;
            }
            chat.targetY = i * messageSpacing;
            const animationSpeed = 10;
            chat.currentY += (chat.targetY - chat.currentY) * animationSpeed / global.metrics.rendertime;
            let slideOffset = chat.currentY;

            if (valpha <= 0) continue;

            ctx[1].globalAlpha = 0.5 * valpha * alpha * alpha * fade;
            drawBar(x - msgLengthHalf, x + msgLengthHalf, y - g * (instance.id === gui.playerid ? 2.7 + crownLift : barScale) - slideOffset, 0.75 * g, gameDraw.getColorDark(gameDraw.getColor(instance.color.split(" ")[0])), ctx[1]);
            ctx[1].globalAlpha = valpha * alpha * fade;
            config.graphical.fontStrokeRatio *= 1.2;
            drawText(text, x, y - g * (instance.id === gui.playerid ? 2.49 + crownLift : textScale) - slideOffset, 0.50 * g, color.guiwhite, "center", false, 1, true, ctx[1]);
            config.graphical.fontStrokeRatio /= 1.2;
        }
    }

    function drawHealth(x, y, instance, ratio, alpha, isize) {
        if (!(0.02 > alpha)) {
            let fade = instance.render.status.getFade();
            fade *= fade;
            ctx[1].globalAlpha = fade;

            let size = isize * ratio,
                indexes = instance.index.split("-"),
                m = global.mockups[parseInt(indexes[0])];
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

    // ── Enemy pings in the world: a bobbing red marker at the spot, and a
    // small quiet edge indicator when it's off-screen (the subtle cousin
    // of the leader arrow - informative, never nagging). Pings live 6s. ──
    function drawEnemyPings() {
        const now = performance.now();
        for (let i = global.enemyPings.length - 1; i >= 0; i--) {
            if (now - global.enemyPings[i].at > 20000) global.enemyPings.splice(i, 1);
        }
        if (!global.enemyPings.length || global.died) return;
        const wr = util.getRatio();
        const cx = global.screenWidth / 2, cy = global.screenHeight / 2;
        for (const p of global.enemyPings) {
            const age = now - p.at;
            const fade = age > 19000 ? 1 - (age - 19000) / 1000 : 1;
            const dx = (p.x - global.player.renderx) * wr;
            const dy = (p.y - global.player.rendery) * wr;
            const onScreen = Math.abs(dx) < cx - 30 && Math.abs(dy) < cy - 30;
            if (onScreen) {
                const bob = Math.sin(now / 260 + (p.at % 97)) * 3;
                const r = 13 + 1.5 * Math.sin(now / 200);
                drawPingDiamond(ctx[2], cx + dx, cy + dy - 16 + bob, r, fade);
                // spawn pulse ring
                if (age < 650) {
                    const t = age / 650;
                    ctx[2].save();
                    ctx[2].globalAlpha = (1 - t) * 0.6;
                    ctx[2].strokeStyle = "#eb4034";
                    ctx[2].lineWidth = 3 * (1 - t) + 1;
                    ctx[2].beginPath();
                    ctx[2].arc(cx + dx, cy + dy, 14 + t * 46, 0, Math.PI * 2);
                    ctx[2].stroke();
                    ctx[2].restore();
                }
            } else {
                const ang = Math.atan2(dy, dx);
                const inset = 30;
                const t2 = Math.min((cx - inset) / (Math.abs(Math.cos(ang)) || 1e-9),
                                    (cy - inset) / (Math.abs(Math.sin(ang)) || 1e-9));
                drawPingDiamond(ctx[2], cx + Math.cos(ang) * t2, cy + Math.sin(ang) * t2, 13, fade * 0.7);
            }
        }
    }

    // ── Leader crown: the classic simple 2D game crown - three equal
    // triangular spikes on a flat band, balls on the tips, flat gold with a
    // dark outline. Everyone sees it on the #1 player, themselves included.
    // The crown wears the LEADER'S TEAM COLOR (blue leader = blue crown,
    // red leader = red crown) everywhere it appears: overhead, the screen
    // edge indicator, and both maps. Gold only as a fallback.
    function crownColor() {
        const t = global.leader && global.leader.team;
        if (t === -1) return gameDraw.getColor("blue");
        if (t === -2) return gameDraw.getColor("red");
        return color.gold;
    }
    function drawCrown(x, y, g, a, c = ctx[1]) {
        // The crown: flat solid color, three ball tips melting into the
        // spikes, softly rounded silhouette - matches the reference art.
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
                if (global.GUIStatus.renderPlayerNames) drawText(name, x, y - g * (global.GUIStatus.renderPlayerScores ? 1.9 : 1.45), 0.55 * g, namecolor == "#ffffff" ? color.guiwhite : namecolor, "center", false, 1, true, ctx[1]);
                if (global.GUIStatus.renderPlayerScores || typeof instance.score === "string") drawText(typeof instance.score === "string" ? instance.score : util.handleLargeNumber(instance.score), x, y - 1.45 * g, 0.3 * g, namecolor == "#ffffff" ? color.guiwhite : namecolor, "center", false, 1, true, ctx[1]);
                if (global.showDebug && instance.digWarsGoal) {
                    drawText(`goal: ${instance.digWarsGoal}`, x, y + 1.2 * g, 0.28 * g, color.teal, "center", false, 1, true, ctx[1]);
                }
                ctx[1].globalAlpha = 1;
            }
        }
    }

    function drawSkillBars(spacing, alcoveSize) {
        // Tutorial: the stat bars show only when the lesson either lets you
        // spend (allow includes stats) or is literally pointing at them (the
        // "find your points" step highlights the bar without unlocking it).
        // Otherwise they stay hidden - a bar that takes clicks the server
        // refuses would read as broken rather than locked.
        if (global.tutorialMode) {
            const allow = window.dwTutAllow || "";
            const ui = window.dwTutUi || "";
            if (!allow.includes("stats") && !ui.startsWith("skill") &&
                !ui.startsWith("stat") && ui !== "points") return;
        }

        if (global.mobile) return drawMobileSkillUpgrades(spacing, alcoveSize);
        statMenu.set(0 + (global.died || global.statHover || (global.canSkill && !gui.skills.every(skill => skill.cap === skill.amount))));
        global.clickables.stat.hide();

        let vspacing = 5;
        let height = 14;
        let gap = 44.5;
        let len = alcoveSize - 10;
        let save = len;
        let x = spacing + 3 + (statMenu.get() - 1) * (height + 50 + len * ska(gui.skills.reduce((largest, skill) => Math.max(largest, skill.cap), 0)));
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
            drawText(name, Math.round(x + len / 2) - 5.5, y + height / 2, height - 4.1, textcolor, "center", true);

            const keyTxt = statIdx === 10 ? minKeyName : String((statIdx + 1) % 10);
            // fixed column: every key label centred on the same x, so "-"
            // lines up with the digits above it
            drawText("[" + keyTxt + "]", Math.round(x + save * ska(maxLevel) - height * 0.25) - 22, y + height / 2, height - 6, textcolor, "center", true);
            if (textcolor === color.guiwhite) {

                global.clickables.stat.place(statIdx, x * clickableRatio, y * clickableRatio, len * clickableRatio, height * clickableRatio);
            }

            if (level) {
                drawText("+" + level, Math.round(x + len + 4) - 5.5, y + height / 2, height - 5, col, "left", true);
            }

            y -= height + vspacing;
        }

        global.clickables.hover.place(0, 0, y * clickableRatio, 0.8 * len * clickableRatio, (global.screenHeight - y) * clickableRatio);
        if (gui.points !== 0) {

            drawText("x" + gui.points, Math.round(x + len - 2) - 13, Math.round(y + height - 4) + 2, 18.5, color.guiwhite, "right");
        }
    }

    function drawSelfInfo(max) {

        // Dig Wars bottom stack (bottom → top): team war bar, wallet row,
        // player name. The old level bar is gone - everyone is 45, it said
        // nothing.
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
        // ── Dig Wars wallet row (replaces the old score bar) ─────────────
        // Two separate pills so the facts don't mash together: a gold
        // carried-meter that fills with satchel load (blinks red at cap),
        // and a solid teal banked pill. Uses the exact footprint the score
        // bar had, so the killbar / info-mode layouts are untouched.
        // On non-gem gamemodes (no GEM data → cap 0) the stock score bar
        // draws instead.
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
            drawBar(rx1, carX2, ry, height - 3 + config.graphical.barChunk, color.black);
            drawBar(rx1, carX2, ry, height - 3, color.grey);
            if (load > 0.004) drawBar(rx1, rx1 + (carX2 - rx1) * load, ry, height - 3.5, blink ? "#eb4034" : color.gold);
            {
                // text never leaves its pill: shrink to fit
                const carTxt = "Carried: " + util.formatLargeNumber(g.carried | 0);
                let cs2 = 13; while (cs2 > 9 && measureText(carTxt, cs2) > (carX2 - rx1) - 10) cs2 -= 0.5;
                drawText(carTxt, (rx1 + carX2) / 2 + 0.5, ry + 6 - (13 - cs2) * 0.35, cs2, color.guiwhite, "center");
            }
            drawBar(bankX1, rx2, ry, height - 3 + config.graphical.barChunk, color.black);
            drawBar(bankX1, rx2, ry, height - 3, color.grey);
            drawBar(bankX1, rx2, ry, height - 3.5, color.teal);
            {
                const bankTxt = "Banked: " + util.formatLargeNumber(g.banked | 0);
                let bs2 = 13; while (bs2 > 9 && measureText(bankTxt, bs2) > (rx2 - bankX1) - 10) bs2 -= 0.5;
                drawText(bankTxt, (bankX1 + rx2) / 2 + 0.5, ry + 6 - (13 - bs2) * 0.35, bs2, color.guiwhite, "center");
            }
        }
        ctx[2].lineWidth = 4;
        var name = global.player.name.substring(7, global.player.name.length + 1);
        drawText(name, Math.round(x + width / 2) + 1.5, Math.round(y - 10 - 4) - 1, 31, global.nameColor == "#ffffff" ? color.guiwhite : global.nameColor, "center");
    }

    // Dig Wars: the Vault panel - fades and slides in while you stand on
    // your team's pad, themed in your team color. Choose the exact dust
    // amount three ways: drag/click the slider, tap a percent, or nudge
    // with the − / + steppers.
    const vaultGlide = Smoothbar(0, 2, 3, 0.1, 0.025, true);
    const VAULT_MIN_DEPOSIT = 15;
    // A real typed input for the deposit amount - native caret, selection,
    // clamping. Created once, positioned over the canvas panel each frame.
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
            "background:#0d0e14;color:#ffd75e;border:2px solid #ffd75e;" +
            "border-radius:8px;outline:none;font-family:Rubik,Ubuntu,sans-serif;" +
            "font-weight:bold;box-shadow:0 0 14px #ffd75e33 inset;";
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
        // taking focus means the game canvas stops hearing keyUPs - release
        // every held command or a held W drives the tank into the wall
        // forever (the "stuck on W" bug)
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

    // Dig Wars: the Vault panel - dead simple: how much dust do you want to
    // cash out? Type it (clamped to your satchel), hit DEPOSIT or Enter.
    function drawVaultUI() {
        const v = global.vault, g = global.gems;
        const active = v.total > 0;
        const belowMin = !active && (g.carried | 0) < VAULT_MIN_DEPOSIT;
        const wantOpen = v.onPad && !global.died;
        vaultGlide.set(wantOpen ? 1 : 0);
        const glide = vaultGlide.get();
        if (glide < 0.02) {
            global.clickables.vault.hide();
            hideVaultInput();
            v.wasOpen = false;
            return;
        }
        const now = performance.now();
        const W = 340, H = belowMin ? 92 : 136;
        const x = (global.screenWidth - W) / 2;
        const y = global.screenHeight - 318 + (1 - glide) * 26;
        const cr = global.canvas ? global.canvas.height / global.screenHeight / global.ratio : 1;
        const c = ctx[2];
        // team color for the frame - getColor can return undefined for
        // unmapped indices and mixColors requires hex strings, so guard
        let teamCol = gameDraw.getColor(gui.color);
        if (typeof teamCol !== "string" || teamCol[0] !== "#") teamCol = color.gold;

        c.save();
        c.globalAlpha = glide;
        c.fillStyle = "rgba(16,17,23,0.93)";
        optionsMenu_drawRoundedRect(x, y, W, H, 12);
        c.fill();
        c.lineWidth = 3;
        c.strokeStyle = teamCol;
        optionsMenu_drawRoundedRect(x, y, W, H, 12);
        c.stroke();
        drawText(v.isOutpost ? "BASE BANK · 80% CREDIT" : (royaleActive() ? "VAULT · 100% CREDIT" : "TEAM VAULT"),
                 x + W / 2, y + 21, 15, teamCol, "center");
        c.fillStyle = teamCol;
        c.fillRect(x + W / 2 - 56, y + 28, 112, 2.5);
        drawText("Banked  " + util.formatLargeNumber(g.banked | 0), x + 16, y + 46, 12, color.teal, "left");
        drawText("Carried  " + util.formatLargeNumber(g.carried | 0), x + W - 16, y + 46, 12, color.gold, "right");

        global.clickables.vault.hide();
        if (belowMin) {
            hideVaultInput();
            drawText("Need at least " + VAULT_MIN_DEPOSIT + " dust to cash out.",
                     x + W / 2, y + 70, 12.5, "#ff9a8c", "center");
        } else if (active) {
            // ── channeling: gold progress + live count + cancel ──
            hideVaultInput();
            const frac = 1 - v.remaining / v.total;
            const bx = x + 20, bw = W - 40, by = y + 60, bh = 16;
            drawBar(bx, bx + bw, by + bh / 2, bh + config.graphical.barChunk, color.black);
            drawBar(bx, bx + bw, by + bh / 2, bh, color.grey);
            // Rainbow vaults bank in the vault's live hue; base banks stay gold.
            const chanCol = (royaleActive() && !v.isOutpost) ? hsvCss((now / 12) % 360) : "#ffd75e";
            drawBar(bx, bx + Math.max(6, bw * frac), by + bh / 2, bh - 1, chanCol);
            if (frac > 0.03) {
                const shx = bx + ((now / 900) % 1) * bw * frac;
                c.save();
                c.globalAlpha = glide * 0.35;
                c.fillStyle = "#fff6d8";
                c.fillRect(shx - 6, by, 12, bh);
                c.restore();
            }
            drawText(util.formatLargeNumber(Math.round(v.total - v.remaining)) + " / " +
                     util.formatLargeNumber(v.total) + "  secured…",
                     x + W / 2, by + bh + 18, 12.5, color.guiwhite, "center");
            const cbx = x + W / 2 - 46, cby = y + H - 30, cbw = 92, cbh = 20;
            c.fillStyle = "#33191c";
            optionsMenu_drawRoundedRect(cbx, cby, cbw, cbh, 6); c.fill();
            c.lineWidth = 2; c.strokeStyle = "#e05b4a";
            optionsMenu_drawRoundedRect(cbx, cby, cbw, cbh, 6); c.stroke();
            drawText("CANCEL", cbx + cbw / 2, cby + 14.5, 12, "#ff9a8c", "center");
            global.clickables.vault.place(11, cbx * cr, cby * cr, cbw * cr, cbh * cr);
        } else {
            
            drawText("How much dust to cash out?", x + W / 2, y + 66, 12, color.guiwhite, "center");
            const el = getVaultInput();
            const iw = 150, ih = 30;
            const ix = x + W / 2 - iw / 2 - 62, iy = y + 78;
            el.style.left = (ix * cr) + "px";
            el.style.top = (iy * cr) + "px";
            el.style.width = (iw * cr - 4) + "px";
            el.style.height = (ih * cr - 4) + "px";
            el.style.fontSize = (15 * cr) + "px";
            el.style.opacity = glide;
            if (el.style.display === "none") {
                el.style.display = "block";
                el.value = "" + (g.carried | 0);   // defaults to everything
                
                
                
            }
            const dbx = x + W / 2 + 26, dby = y + 78, dbw = 108, dbh = 30;
            const dpulse = 0.8 + 0.2 * Math.sin(now / 380);
            c.fillStyle = "#3d3110";
            optionsMenu_drawRoundedRect(dbx, dby, dbw, dbh, 7); c.fill();
            c.lineWidth = 3;
            c.strokeStyle = `rgba(255,215,94,${dpulse * glide})`;
            optionsMenu_drawRoundedRect(dbx, dby, dbw, dbh, 7); c.stroke();
            drawText("DEPOSIT", dbx + dbw / 2, dby + 20, 14, "#ffd75e", "center");
            global.clickables.vault.place(10, dbx * cr, dby * cr, dbw * cr, dbh * cr);
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
            const fe = 1 - Math.pow(1 - ft, 3);
            ctx[2].save();
            ctx[2].globalAlpha = (1 - ft) * 0.5;
            ctx[2].strokeStyle = color.gold;
            ctx[2].lineWidth = 3.5 * (1 - ft) + 0.5;
            ctx[2].beginPath();
            ctx[2].arc(cx, cy, 26 + fe * 30, 0, Math.PI * 2);
            ctx[2].stroke();
            ctx[2].restore();
        }

        // +N numbers: rise off the tank and fade; chains heat gold → white
        for (let i = g.popups.length - 1; i >= 0; i--) {
            const p = g.popups[i];
            const t = (now - p.born) / 1000;
            if (t >= 1) { g.popups.splice(i, 1); continue; }
            const rise  = 52 + 42 * (1 - Math.pow(1 - t, 2.2));
            const alpha = t < 0.55 ? 1 : 1 - (t - 0.55) / 0.45;
            const heat  = Math.min(1, (p.combo || 0) / 8);
            const size  = 16 + Math.min(10, p.value / 25) + Math.min(6, (p.combo || 0));
            ctx[2].save();
            ctx[2].globalAlpha = alpha;
            drawText("+" + p.value,
                     Math.round(cx + (p.drift || 0)), Math.round(cy - rise),
                     size, gameDraw.mixColors(color.gold, "#ffffff", heat), "center");
            ctx[2].restore();
        }
    }

    
    
    
    
    // Mining combo meter: server-counted chain (2.5s window, up to +50%
    // dust), drawn under the tank with a depleting fuse bar. Starts at ×2 -
    // a lone pickup is not a combo.
    function drawMineCombo() {
        const g = global.gems;
        if (!g || !config.game.gemPopups) return;
        const n = g.mcombo | 0;
        if (n < 2) return;
        const now = performance.now();
        const left = 1 - (now - (g.mcomboAt || 0)) / 2500;
        if (left <= 0) return;
        const bonus = Math.min(50, 5 * (n - 1));
        const cx = global.screenWidth / 2, cy = global.screenHeight / 2 + 88;
        const a = Math.min(1, left * 3);
        const c = ctx[2];
        c.save();
        drawText("MINING ×" + n, cx, cy, 17, "#ffd75e", "center", true, a, 5);
        drawText("+" + bonus + "% DUST", cx, cy + 20, 11, color.guiwhite, "center", true, a, 4);
        const bw = 120, bx = cx - bw / 2, by = cy + 30;
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

    // ═════════════════════════════════════════════════════════════════════
    // Dig Royale HUD. One thing per screen region:
    //   top centre   raid clock, storm + twist, your place, toast, boss bar
    //   top right    standings, then the kill feed, then system notices
    //   mid left     quest tracker
    //   bottom left  kit box above the skill bars
    //   centre       kill callouts (one at a time)
    // ═════════════════════════════════════════════════════════════════════
    const SHOP_TABS = [["drill", "Drills"], ["gear", "Gear"], ["kit", "Kit"], ["arm", "Sidearms"]];
    const SHOP_ACCENT = "#5ce0d8";
    const KIT_SHORT = { charge: "CHARGE", strut: "STRUT", medkit: "MEDKIT", overdrive: "OVERDRV", anchor: "ANCHOR", flash: "FLASH", bulwark: "BULWARK", decoy: "DECOY" };
    const GEAR_TAG = { scanner: "SCN", magnet: "MAG", satchel: "SAT", insurance: "INS", cloak: "CLK", boots: "TRD", plating: "PLT", express: "EXP", mark: "MRK", wind: "WND" };
    const shopGlide = Smoothbar(0, 2, 3, 0.1, 0.025, true);
    const kitGlide = Smoothbar(0, 2, 3, 0.1, 0.025, true);
    let kitBoxTop = 0;   // 0 while the kit box is hidden
    // Highest point the bottom-left block (kit box, else the 11 stat bars and
    // their points counter) can reach. The upgrade tiles and the quest and
    // override cards all have to stop above it.
    function leftColumnFloor() {
        if (kitBoxTop > 0) return kitBoxTop;
        return global.screenHeight - 20 - 5.5 - 14 - 10 * (14 + 5) - 30;
    }
    const bossGlide = Smoothbar(0, 2, 3, 0.08, 0.025, true);
    let royaleFeedBottom = 0;
    const GEM_ICON = [[-1, -0.38], [-0.55, -0.95], [0.55, -0.95], [1, -0.38], [0, 0.95]];

    function shopUiMode() { return royaleActive() || !!global.tutorialMode; }
    function shopOpenWanted() {
        return shopUiMode() && global.shop.onPad && !global.shop.dismissed && !global.died && !global.showBigMap;
    }
    function fmtNum(n) { return util.formatLargeNumber(Math.round(n || 0)); }
    function fmtDist(d) { return d >= 1000 ? (d / 1000).toFixed(1) + "k" : String(Math.round(d)); }
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
    function wrapLines(text, size, maxW) {
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
    function keyLabel(id, dflt) {
        const now = performance.now();
        if (now - keyLabelCache.at > 1500) {
            keyLabelCache.at = now;
            keyLabelCache.map = {};
            for (const k of ["KEY_UPGRADE_MIN", "KEY_KIT_1", "KEY_KIT_2", "KEY_KIT_3", "KEY_TOGGLE_MAP"]) {
                const el = document.querySelector('#controlSettings b[data-key="' + k + '"]');
                if (el && el.textContent) keyLabelCache.map[k] = el.textContent;
            }
        }
        return keyLabelCache.map[id] || dflt;
    }
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
    let hudTopBottom = 60;
    function hudAvoidRects() {
        const sw = global.screenWidth, sh = global.screenHeight;
        const out = [];
        if (standingsRect) out.push(standingsRect);
        out.push({ x: sw / 2 - 240, y: 0, w: 480, h: hudTopBottom + 6 });
        out.push({ x: sw / 2 - 250, y: sh - 112, w: 500, h: 112 });   // name + wallet row
        const lf = leftColumnFloor();
        out.push({ x: 0, y: lf, w: 232, h: sh - lf });
        out.push({ x: sw - 252, y: sh - 262, w: 252, h: 262 });
        // class-upgrade tiles and the quest card under them
        if ((global.upgradeBoxBottom | 0) > 0) out.push({ x: 0, y: 0, w: Math.max(280, (global.upgradeBoxRight | 0) + 8), h: global.upgradeBoxBottom + 8 });
        if (questRect) out.push(questRect);
        if (overrideRect) out.push(overrideRect);
        return out;
    }
    // Step a point out of a panel by the shortest move that stays on screen
    // (a panel on the bottom edge must push the marker UP, not off-screen).
    function nudgeOut(p, r, b) {
        if (p.x < r.x || p.x > r.x + r.w || p.y < r.y || p.y > r.y + r.h) return;
        // Wide panels (wallet row, top cluster, standings) are left by
        // moving vertically, tall ones (skill bars, minimap) horizontally:
        // sliding along a wide panel only parks the label beside it.
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
        for (const r of hudAvoidRects()) nudgeOut(p, r, bounds);
        p.x = Math.max(left, Math.min(right, p.x));
        p.y = Math.max(top, Math.min(bottom, p.y));
        return p;
    }
    // Soft light under every chest so they read from far away.
    function drawChestGlow(roomX, roomY, ratio) {
        if (!royaleActive() || global.lowFx) return;
        const list = (global.royale && global.royale.chests) || [];
        if (!list.length) return;
        const halfW = global.gameWidth / 2, halfH = global.gameHeight / 2;
        const c = ctx[0];
        const now = performance.now();
        for (const ch of list) {
            const sx = roomX + (ch.x + halfW) * ratio, sy = roomY + (ch.y + halfH) * ratio;
            const R = (ch.rare ? 100 : 78) * ratio;
            if (sx < -R || sx > global.screenWidth + R || sy < -R || sy > global.screenHeight + R) continue;
            const pulse = 0.5 + 0.5 * Math.sin(now / 700 + (ch.id | 0));
            let a = 0.7 + 0.3 * pulse;
            const gone = ch.e != null ? chestGoneAt.get(ch.e) : undefined;
            if (gone !== undefined) { a *= Math.max(0, 1 - (now - gone) / 150); if (a <= 0) continue; }
            const spr = haloSprite(ch.rare ? "chest-e" : "chest-c", ch.rare ? "220,140,248" : "240,160,96", [[0, 0.40], [0.55, 0.11], [1, 0]]);
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
            // drop shadow, then the flat hexagonal foundation (the hitbox)
            c.fillStyle = "rgba(0,0,0,0.5)";
            polyPath(c, 3, 5, R * 1.16, 6, Math.PI / 6); c.fill();
            polyPath(c, 0, 0, R * 1.16, 6, Math.PI / 6);
            c.fillStyle = "#16181e"; c.fill();
            c.globalAlpha = 0.35; c.fillStyle = SHOP_ACCENT; c.fill(); c.globalAlpha = 1;
            c.lineJoin = "round";
            c.lineWidth = Math.max(3, R * 0.07); c.strokeStyle = SHOP_ACCENT; c.stroke();
            c.lineWidth = Math.max(2, R * 0.03); c.strokeStyle = "#0d0f14"; c.stroke();
            if (!global.lowFx) {
                const auraR = R * (1.30 + 0.08 * pulse);
                const halo = haloSprite("aura|92,224,216", "92,224,216", [[0.42, 1], [1, 0]]);
                c.save();
                c.globalAlpha = 0.16 + 0.08 * pulse + (mine ? 0.12 : 0);
                c.drawImage(halo, -auraR, -auraR, auraR * 2, auraR * 2);
                c.restore();
            }
            // claim ring: hexagonal, dashed and turning while you stand on it
            c.globalAlpha = mine ? 0.9 : 0.55 + 0.2 * pulse;
            c.lineWidth = Math.max(2.5, R * 0.055);
            c.strokeStyle = mine ? "#ffffff" : SHOP_ACCENT;
            if (mine) { c.setLineDash([R * 0.18, R * 0.12]); c.lineDashOffset = -now / 45; }
            polyPath(c, 0, 0, R * 1.0, 6, Math.PI / 6); c.stroke();
            c.setLineDash([]); c.globalAlpha = 1;
            // armoured plate and a slow gem wheel, same sprites as the vault
            const pr = R * 0.66;
            c.drawImage(spr.plate, -pr, -pr, pr * 2, pr * 2);
            c.save();
            c.rotate(now / 6000 + s.id);
            c.drawImage(spr.wheel, -pr, -pr, pr * 2, pr * 2);
            c.restore();
            // the coin: what this pad is for
            const cr = R * 0.24;
            c.beginPath(); c.arc(0, 0, cr, 0, Math.PI * 2);
            c.fillStyle = "#1b2430"; c.fill();
            c.lineWidth = Math.max(2, R * 0.04); c.strokeStyle = SHOP_ACCENT; c.stroke();
            gemPath(c, 0, cr * 0.05, cr * 0.62);
            c.fillStyle = color.gold; c.fill();
            c.lineWidth = Math.max(1, R * 0.02); c.strokeStyle = "#5a4310"; c.stroke();
            c.restore();
            drawText("SHOP", sx, sy - R * 1.36, Math.max(11, R * 0.17), SHOP_ACCENT, "center", true, 1, 5, ctx[0]);
            drawText(String(s.name || "").replace(" Shop", "").toUpperCase(), sx, sy + R * 1.44, Math.max(9, R * 0.12), "#b9c3d1", "center", true, 1, 5, ctx[0]);
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
        if (!global.lowFx) {
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
        drawText("ORE BLOOM  " + Math.ceil(left) + "s", sx, sy - R - 14 * ratio, Math.max(11, 16 * ratio), "#ffd76e", "center", true, fade, 5, ctx[0]);
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
    function tickAdaptiveQuality() {
        const now = performance.now();
        if (fxQ.last) {
            const dt = Math.min(250, now - fxQ.last);
            fxQ.ema = fxQ.ema * 0.9 + dt * 0.1;
        }
        fxQ.last = now;
        if (document.hidden) return;
        if (fxQ.ema > 34) { fxQ.fastSince = 0; if (!fxQ.slowSince) fxQ.slowSince = now; }
        else if (fxQ.ema < 20) { fxQ.slowSince = 0; if (!fxQ.fastSince) fxQ.fastSince = now; }
        else { fxQ.slowSince = 0; fxQ.fastSince = 0; }
        if (!global.lowFx && fxQ.slowSince && now - fxQ.slowSince > 3000) { global.lowFx = true; fxQ.slowSince = 0; }
        if (global.lowFx && fxQ.fastSince && now - fxQ.fastSince > 6000) { global.lowFx = false; fxQ.fastSince = 0; }
    }
    function drawRoyaleHUD() {
        const cx = global.screenWidth / 2;
        const now = performance.now();
        if (!royaleActive()) {
            // Raid data has not arrived yet: say so rather than show nothing.
            if (global.digRoyaleMode && global.gameStart && !global.tutorialMode) {
                if (!hudWaitSince) hudWaitSince = now;
                else if (now - hudWaitSince > 4000) drawText("Waiting for raid data...", cx, 30, 13, color.grey, "center");
            }
            return;
        }
        hudWaitSince = 0;
        hudErrText = "";
        tickAdaptiveQuality();
        const r = global.royale;
        if (!global.died) spectateBarBottom = 0;
        const top0 = global.died && spectateBarBottom > 0 ? spectateBarBottom : 0;
        let y = 50 + top0;
        hudSafe("top", () => {
            drawText("RAID " + fmtRaidClock(r.raidLeft | 0) + "     ALIVE " + (r.alive | 0), cx, 28 + top0, 15, color.guiwhite, "center", true);
            const st = r.storm || {};
            if (st.a) {
                drawText(st.hold ? ("Storm holding for " + (st.left | 0) + "s") : ("Storm closes in " + fmtRaidClock(st.left | 0)), cx, y, 12, st.hold ? color.gold : "#b678e0", "center", true);
                y += 18;
            }
            y += 3;
            if (r.place > 0) drawText("#" + r.place + "   ·   " + fmtNum(r.youScore | 0) + " pts", cx, y, 13, color.gold, "center", true);
            else if (r.youScore > 0) drawText(fmtNum(r.youScore | 0) + " pts", cx, y, 13, color.gold, "center", true);
            y += 21;
            if (r.lock) { drawText("Final storm, " + Math.max(0, r.lockLeft | 0) + "s left. Nobody respawns now.", cx, y, 12.5, "#b678e0", "center", true); y += 20; }
            else if (r.toast) { drawText(r.toast, cx, y, 12.5, color.guiwhite, "center", true); y += 20; }
        });
        hudSafe("boss", () => {
            bossGlide.set(r.boss ? 1 : 0);
            const bg = bossGlide.get();
            // the row is reserved in full while the bar is visible: alpha
            // fades, nothing below it slides
            if (bg > 0.02) { drawBossBar(cx, y, bg); y += BOSS_H + BOSS_GAP; }
        });
        hudSafe("status", () => {
            const objs = r.objectives || [];
            for (let i = 0; i < Math.min(2, objs.length); i++) {
                const o = objs[i];
                if (o.kind !== "contest") continue;
                drawText((o.name || "Outpost") + " contested", cx, y, 12, o.c || color.gold, "center", true);
                y += 18;
            }
            const myStreak = (r.you && r.you.streak) | 0;
            if (myStreak >= 4 && !global.died) {
                const blink = 0.7 + 0.3 * Math.sin(now / 240);
                drawText(myStreak + " kill streak. You're marked on everyone's map", cx, y, 12, "#ffb347", "center", true, blink, 5);
                y += 18;
            }
            const you = r.you || {};
            if (you.overdrive > 0 || you.anchor > 0) {
                const parts = [];
                if (you.overdrive > 0) parts.push("OVERDRIVE " + you.overdrive + "s");
                if (you.anchor > 0) parts.push("STORM ANCHOR " + you.anchor + "s");
                drawText(parts.join("   "), cx, y, 12, color.teal, "center", true);
                y += 18;
            }
            if (r.occupy > 0) drawText("You can stay " + r.occupy + "s longer", cx, global.screenHeight - 56, 15, color.gold, "center");
            else if (r.lockout > 0) drawText("You can come back in " + r.lockout + "s", cx, global.screenHeight - 56, 15, color.guiwhite, "center");
        });
        hudTopBottom = y;
        let standBottom = 36;
        hudSafe("standings", () => { standBottom = drawRoyaleStandings(); });
        hudSafe("feed", () => drawRoyaleFeed(standBottom + 14));
        hudSafe("cards", layoutLeftCards);
        hudSafe("quest", drawQuestCard);
        hudSafe("override", drawOverrideCard);
        hudSafe("storm", () => {
            if (!playerInStorm()) return;
            const c = ctx[2];
            c.save();
            c.fillStyle = "rgba(160, 35, 35, 0.28)";
            c.fillRect(0, 0, global.screenWidth, 10);
            c.fillRect(0, global.screenHeight - 10, global.screenWidth, 10);
            c.fillRect(0, 0, 10, global.screenHeight);
            c.fillRect(global.screenWidth - 10, 0, 10, global.screenHeight);
            c.restore();
        });
        if (hudErrText) drawText("HUD error: " + hudErrText, cx, global.screenHeight - 78, 11, "#ff7a6b", "center");
    }
    const BOSS_H = 50, BOSS_GAP = 8;
    let spectateBarBottom = 0;   // the top cluster starts under the spectate bar while dead
    function drawBossBar(cx, y, a) {
        const b = global.royale.boss || global._lastBoss;
        if (!b) return;
        global._lastBoss = b;
        const c = ctx[2];
        const W = Math.min(400, global.screenWidth - 60), H = BOSS_H;
        const x = cx - W / 2;
        const col = b.c || "#c9a8ff";
        const dist = Math.hypot((b.x || 0) - global.player.renderx, (b.y || 0) - global.player.rendery);
        c.save();
        c.globalAlpha = a;
        roundRectPath(c, x, y, W, H, 10);
        c.fillStyle = "rgba(14,12,20,0.9)";
        c.fill();
        c.lineWidth = 2;
        c.strokeStyle = col;
        c.stroke();
        polyPath(c, x + 18, y + 13, 8, 8, Math.PI / 8);
        c.fillStyle = col; c.fill();
        c.strokeStyle = color.black; c.lineWidth = 1.5; c.stroke();
        c.restore();
        // three fixed rows: name and bounty, health bar, percent and range
        const gemsTxt = fmtNum(b.gems) + " GEMS";
        const gemsW = measureText(gemsTxt, 11.5);
        fitText(String(b.name || "Boss").toUpperCase(), x + 34 + (W - 34 - gemsW - 24) / 2, y + 13, 12.5, W - 34 - gemsW - 24, col);
        drawText(gemsTxt, x + W - 12, y + 13, 11.5, color.gold, "right", true, a);
        const bx = x + 12, bw = W - 24, byc = y + 27, bh = 9;
        c.save();
        c.globalAlpha = a;
        drawBar(bx, bx + bw, byc, bh + config.graphical.barChunk, color.black);
        drawBar(bx, bx + bw, byc, bh, "#2c2434");
        const hp = Math.max(0, Math.min(1, b.hp || 0));
        if (hp > 0) drawBar(bx, bx + Math.max(4, bw * hp), byc, bh - 1, hp > 0.5 ? col : hp > 0.2 ? color.gold : "#eb4034");
        if (b.sh > 0.01) {
            c.globalAlpha = a * 0.55;
            drawBar(bx, bx + Math.max(3, bw * b.sh), byc, bh - 3, color.teal);
        }
        c.restore();
        drawText(Math.round(hp * 100) + "%", bx, y + 42, 10, color.grey, "left", true, a);
        if (isFinite(dist) && dist < 1e6) drawText(fmtDist(dist) + " away", bx + bw, y + 42, 10, color.grey, "right", true, a);
    }

    // ── race panel: top three plus you, with your gap to first ──────────
    const standingsFit = new Map();
    function drawRoyaleStandings() {
        const r = global.royale;
        const board = r.board || [];
        if (!board.length) { standingsRect = null; return 36; }
        const W = Math.min(262, global.screenWidth * 0.3), rowH = 20;
        const x = global.screenWidth - 18 - W, y0 = 36;
        const myPlace = r.place | 0;
        const top = board.slice(0, 3);
        const me = myPlace > 3 ? board.find(row => row.place === myPlace) : null;
        const rows = me ? top.concat([me]) : top;
        const H = 26 + rows.length * rowH + (myPlace > 1 ? 18 : 8);
        standingsRect = { x: x - 8, y: y0 - 8, w: W + 16, h: H + 16 };
        const c = ctx[2];
        c.save();
        roundRectPath(c, x, y0, W, H, 9);
        c.fillStyle = "rgba(12,13,18,0.84)";
        c.fill();
        c.lineWidth = 1.5;
        c.strokeStyle = "rgba(255,255,255,0.10)";
        c.stroke();
        c.fillStyle = "rgba(255,255,255,0.06)";
        c.fillRect(x + 10, y0 + 20, W - 20, 1);
        c.restore();
        drawText("STANDINGS", x + 10, y0 + 11, 10, color.grey, "left", true);
        drawText("PTS", x + W - 10, y0 + 11, 10, color.grey, "right", true);
        const myHex = playerHexCol() || color.gold;
        let ry = y0 + 26;
        for (const row of rows) {
            const isMe = row.place === myPlace && myPlace > 0;
            // your row: only the name changes colour, no band behind it
            const nameCol = isMe ? myHex : color.guiwhite;
            const rankCol = row.place === 1 ? color.gold : row.place === 2 ? "#d8dce6" : row.place === 3 ? "#c9955a" : color.grey;
            const rowMid = ry + rowH / 2 - 1;
            drawText("#" + row.place, x + 12, rowMid, 11, rankCol, "left", true);
            const scoreTxt = fmtNum(row.score | 0);
            const scoreW = measureText(scoreTxt, 12);
            const nameTxt = shortName(row.name, 18) + (row.streak >= 4 ? "  §#ff7a6b§x" + row.streak : "");
            const plain = shortName(row.name, 18) + (row.streak >= 4 ? "  x" + row.streak : "");
            // shrink-to-fit is measured once per row per name width, not per frame
            const fitKey = plain + "|" + ((W - 40 - scoreW - 22) | 0);
            let ns = standingsFit.get(fitKey);
            if (ns === undefined) {
                ns = 12; while (ns > 8 && measureText(plain, ns) > W - 40 - scoreW - 22) ns -= 0.5;
                if (standingsFit.size > 64) standingsFit.clear();
                standingsFit.set(fitKey, ns);
            }
            drawText(nameTxt, x + 40, rowMid, ns, nameCol, "left", true);
            drawText(scoreTxt, x + W - 10, rowMid, 12, nameCol, "right", true);
            ry += rowH;
        }
        if (myPlace > 1 && top[0]) {
            const gap = (top[0].score | 0) - (r.youScore | 0);
            drawText(fmtNum(gap) + " behind #1", x + W - 10, ry + 7, 10, color.grey, "right", true);
        }
        return y0 + H;
    }

    // ── kill feed: one line, one badge at most, quiet ───────────────────
    function feedLine(f) {
        const myHex = playerHexCol(), myName = global.playerName || "";
        const tag = (n, col) => "§" + col + "§" + n + "§reset§";
        const who = (n, dflt, max = 13) => {
            const nm = shortName(n || dflt, max);
            return (myHex && (n || "") === myName) ? tag(nm, myHex) : nm;
        };
        let badge = null;
        if (f.boss) {
            const nm = tag(f.name || "Boss", f.c || "#c9a8ff");
            if (f.spawn) return { text: nm + " has surfaced", badge: null };
            if (f.gone) return { text: nm + " burrowed away", badge: null };
            if (f.slain) return { text: tag(shortName(f.by || "The wall", 14), (myHex && (f.by || "") === myName) ? myHex : color.gold) + " took down " + nm, badge: f.pts ? { t: "+" + fmtNum(f.pts), col: color.gold } : null };
        }
        if (f.chest) return { text: who(f.name, "Someone") + " cracked an epic chest", badge: null };
        if (f.bloom) return { text: "Ore bloom in " + (f.name || "the wall"), badge: null };
        if (f.event) return { text: f.kind === "meteor" ? "Meteor shower over " + (f.name || "the map") : "Gem rain over the safe zone", badge: null };
        if (f.storm) return { text: who(f.name, "Someone") + " got caught by the storm", badge: null };
        if (f.rock) return { text: who(f.name, "Someone") + " got crushed by the wall", badge: null };
        const vic = who(f.name, "someone");
        if (f.verb === "was devoured by") return { text: vic + " fed the " + tag(shortName(f.by || "boss", 16), "#c9a8ff"), badge: null };
        const byCol = (myHex && (f.by || "") === myName) ? myHex : "gold";
        const text = tag(shortName(f.by || "Someone", 13), byCol) + "  ›  " + vic;
        if (f.shutdown) badge = { t: "SHUTDOWN", col: "#ff9a5a" };
        else if (f.streak >= 4) badge = { t: "x" + f.streak, col: "#ff7a6b" };
        else if (f.loot) badge = { t: "+" + fmtNum(f.loot), col: color.teal };
        return { text, badge };
    }

    function drawRoyaleFeed(yTop) {
        const feed = (global.royale.feed || []).slice(-6);
        const now = Date.now();
        const right = global.screenWidth - 18;
        let y = yTop;
        const c = ctx[2];
        for (let i = feed.length - 1; i >= 0; i--) {
            const f = feed[i];
            if (!f) continue;
            const age = now - (f.at || now);
            if (age > 11000) continue;
            const a = age > 8500 ? Math.max(0.12, 1 - (age - 8500) / 2500) : 1;
            const line = feedLine(f);
            let bx = right;
            if (line.badge) {
                const bw = measureText(line.badge.t, 9.5) + 12;
                c.save();
                c.globalAlpha = a;
                roundRectPath(c, right - bw, y + 1, bw, 15, 4);
                c.fillStyle = "rgba(12,13,18,0.85)";
                c.fill();
                c.lineWidth = 1;
                c.strokeStyle = line.badge.col;
                c.stroke();
                c.restore();
                drawText(line.badge.t, right - bw / 2, y + 9, 9.5, line.badge.col, "center", true, a);
                bx = right - bw - 8;
            }
            drawText(String(line.text).replace(/§reset§$/, ""), bx, y + 9, 12, color.guiwhite, "right", true, a, 5);
            y += 21;
        }
        royaleFeedBottom = y;
    }

    // ── quest tracker ──────────────────────────────────────────────────
    let questRect = null, overrideRect = null;
    // ── left cards: the quest card with the override card right under it,
    // in the gap between the class-upgrade tiles and the kit box. When the
    // gap is too short the override drops its description; when even that
    // won't fit (a tall upgrade grid) both cards move beside the tiles.
    let leftCards = null;
    const CARD_W = 214, QUEST_H = 54, CARD_GAP = 6;
    const overrideH = n => n ? 44 + n * 13 : 38;
    function layoutLeftCards() {
        const r = global.royale;
        const q = !global.died && r.you && r.you.quest ? r.you.quest : null;
        const mod = !global.died && r.mod && r.mod.name ? r.mod : null;
        if (!q && !mod) { leftCards = null; return; }
        const lines = mod ? wrapLines(String(mod.desc || ""), 10, CARD_W - 20).slice(0, 3) : [];
        const stackH = n => (q ? QUEST_H : 0) + (mod ? (q ? CARD_GAP : 0) + overrideH(n) : 0);
        const floor = leftColumnFloor() - 10;
        const tiles = (global.upgradeBoxBottom | 0) > 0;
        const top = tiles ? global.upgradeBoxBottom + 12 : 16;
        const pref = Math.max(global.screenHeight * 0.42, 330, top);
        for (const n of [lines.length, 0]) {
            const y = Math.round(Math.min(pref, floor - stackH(n)));
            if (y >= top) { leftCards = { x: 20, y, q, mod, lines: lines.slice(0, n) }; return; }
        }
        const x = Math.round((global.upgradeBoxRight | 0) + 16);
        let y = Math.round(global.upgradeBoxTop || 70);
        // keep clear of the raid clock cluster at top centre
        if (x + CARD_W > global.screenWidth / 2 - 250) y = Math.max(y, hudTopBottom + 8);
        leftCards = { x, y, q, mod, lines };
    }
    // ── raid override card: this raid's twist and what it does, in the same
    // tile language as the quest card, right under it
    function drawOverrideCard() {
        const L = leftCards;
        const mod = L && L.mod;
        if (!mod) { overrideRect = null; return; }
        const W = CARD_W;
        const lines = L.lines;
        const H = overrideH(lines.length);
        const x = L.x, y = L.q ? L.y + QUEST_H + CARD_GAP : L.y;
        overrideRect = { x: x - 6, y: y - 6, w: W + 12, h: H + 12 };
        const c = ctx[2];
        c.save();
        roundRectPath(c, x, y, W, H, 9);
        c.fillStyle = "rgba(12,13,18,0.84)";
        c.fill();
        c.lineWidth = 1.5;
        c.strokeStyle = "rgba(201,168,255,0.5)";
        c.stroke();
        c.restore();
        drawText("THIS RAID'S OVERRIDE", x + 10, y + 12, 10, color.grey, "left", true);
        drawText(String(mod.name).toUpperCase(), x + 10, y + 28, 12.5, "#c9a8ff", "left", true);
        let ly = y + 44;
        for (const ln of lines) { drawText(ln, x + 10, ly, 10, "#b9c3d1", "left", true); ly += 13; }
    }
    function drawQuestCard() {
        const L = leftCards;
        const q = L && L.q;
        if (!q) { questRect = null; return; }
        const W = CARD_W, H = QUEST_H;
        const x = L.x, y = L.y;
        questRect = { x: x - 6, y: y - 6, w: W + 12, h: H + 12 };
        const c = ctx[2];
        c.save();
        roundRectPath(c, x, y, W, H, 9);
        c.fillStyle = "rgba(12,13,18,0.84)";
        c.fill();
        c.lineWidth = 1.5;
        c.strokeStyle = "rgba(110,206,220,0.45)";
        c.stroke();
        c.restore();
        drawText("QUEST " + ((q.idx | 0) + 1) + "/" + (q.total | 0), x + 10, y + 12, 10, color.grey, "left", true);
        drawText("+" + fmtNum(q.reward) + " gems", x + W - 10, y + 12, 10, color.teal, "right", true);
        // progress first, then the quest text gets whatever width is left
        const progTxt = fmtNum(q.prog || 0) + " / " + fmtNum(q.goal);
        const progW = measureText(progTxt, 10);
        const maxTW = W - 20 - progW - 8;
        let qs = 12, txt = String(q.text || "");
        while (qs > 9.5 && measureText(txt, qs) > maxTW) qs -= 0.5;
        if (measureText(txt, qs) > maxTW) {
            while (txt.length > 2 && measureText(txt + "…", qs) > maxTW) txt = txt.slice(0, -1);
            txt += "…";
        }
        drawText(txt, x + 10, y + 29, qs, color.guiwhite, "left", true);
        drawText(progTxt, x + W - 10, y + 29, 10, color.grey, "right", true);
        const bx = x + 10, bw = W - 20, by = y + 40, bh = 6;
        drawBar(bx, bx + bw, by + bh / 2, bh + 3, color.black);
        drawBar(bx, bx + bw, by + bh / 2, bh, "#2a2e38");
        const frac = q.goal > 0 ? Math.min(1, (q.prog || 0) / q.goal) : 0;
        if (frac > 0) drawBar(bx, bx + Math.max(3, bw * frac), by + bh / 2, bh - 1, color.teal);
    }

    // ── centre callouts ────────────────────────────────────────────────
    function drawKillCallouts() {
        const list = global.callouts;
        if (!list || !list.length) return;
        if (!shopUiMode()) { list.length = 0; return; }
        const now = performance.now();
        const DUR0 = 2300;
        const c = ctx[2];
        const cx = global.screenWidth / 2, cy = Math.round(global.screenHeight * 0.37);
        for (let k = list.length - 1; k >= 0; k--) {
            const t = list[k];
            const DUR = t.dur || DUR0;
            const age = now - t.born;
            if (age > DUR) { list.splice(k, 1); continue; }
            if (age < 0) continue;
            const inT = Math.min(1, age / 160);
            const outT = age > DUR - 500 ? 1 - (age - (DUR - 500)) / 500 : 1;
            const a = (inT * inT * (3 - 2 * inT)) * Math.max(0, outT);
            const pop = inT < 1 ? 1.2 - 0.2 * inT : 1;
            const col = t.kind === "override" ? "#c9a8ff" : t.kind === "shutdown" ? "#ff9a5a" : t.kind === "boss" ? "#c9a8ff"
                : t.kind === "chest" ? color.gold : t.kind === "quest" ? color.teal : t.kind === "streak" ? "#ff7a6b" : color.guiwhite;
            const size = (t.kind === "streak" ? 15 : 21) * pop;
            const len = measureText(t.text, size) + 44;
            c.save();
            c.globalAlpha = a * 0.6;
            roundRectPath(c, cx - len / 2, cy - size * 0.9, len, size * 1.8 + (t.pts ? 22 : 0), 10);
            c.fillStyle = "rgba(10,11,16,0.85)";
            c.fill();
            c.restore();
            drawText(t.text, cx, cy, size, col, "center", true, a, 4.5);
            if (t.pts) drawText("+" + fmtNum(t.pts) + " pts", cx, cy + size * 0.95 + 8, 14 * pop, color.gold, "center", true, a, 4.5);
            if (t.sub) drawText(t.sub, cx, cy + size * 0.95 + 8, 12.5, "#d8dce6", "center", true, a, 4.5);
            break;
        }
    }

    // ── kit box: sits above the skill bars, styled like them ───────────
    // Tooltips: anything hoverable queues one; drawTooltips paints the last
    // one after every panel so it sits on top.
    let pendingTip = null;
    function queueTip(title, body, ax, ay, above = true) { pendingTip = { title, body, ax, ay, above }; }
    let tipKey = "", tipAt = 0;
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
        const w = Math.max(measureText(tip.title, 11.5) + 20, ...lines.map(l => measureText(l, 10.5) + 20), 90);
        const h = 24 + lines.length * 14 + (lines.length ? 6 : 0);
        let x = Math.max(6, Math.min(global.screenWidth - w - 6, tip.ax - w / 2));
        let y = tip.above ? tip.ay - h - 8 : tip.ay + 8;
        if (y < 6) y = tip.ay + 8;
        y += (tip.above ? 1 : -1) * 6 * (1 - ease);
        c.save();
        c.globalAlpha = ease;
        roundRectPath(c, x, y, w, h, 7);
        c.fillStyle = "rgba(10,11,16,0.94)";
        c.fill();
        c.lineWidth = 1.2;
        c.strokeStyle = "rgba(255,255,255,0.18)";
        c.stroke();
        c.restore();
        drawText(tip.title, x + 10, y + 12, 11.5, color.guiwhite, "left", true, ease);
        let ly = y + 30;
        for (const l of lines) { drawText(l, x + 10, ly, 10.5, "#b9c3d1", "left", true, ease); ly += 14; }
    }
    const ROMAN = ["", "I", "II", "III", "IV", "V"];
    // A tiny card per kit item: rounded corners, the item's colour, a glyph
    // you can tell apart at 22px. Used in the kit slots.
    const KIT_CARD = {
        medkit: "#3fbf7a", charge: "#e07c2f", strut: "#8a93a6", overdrive: "#f0a030",
        anchor: "#4d8be0", flash: "#38b8b0", bulwark: "#7a8494", decoy: "#d4a83a",
    };
    function drawKitGlyph(c, id, u, col) {
        // every glyph is painted twice: a dark outline pass, then the white
        // pass, so it reads on any card colour at 26px
        const passes = [["rgba(0,0,0,0.7)", 2.4], ["#ffffff", 0]];
        c.lineCap = "round"; c.lineJoin = "round";
        for (const [paint, extra] of passes) {
            c.fillStyle = paint; c.strokeStyle = paint;
            const lw = Math.max(1.6, u * 0.2) + extra;
            c.lineWidth = lw;
            switch (id) {
                case "medkit":
                    c.lineWidth = u * 0.42 + extra;
                    c.beginPath(); c.moveTo(0, -u * 0.6); c.lineTo(0, u * 0.6); c.moveTo(-u * 0.6, 0); c.lineTo(u * 0.6, 0); c.stroke();
                    break;
                case "charge":
                    c.beginPath();
                    c.moveTo(u * 0.18, -u * 0.78); c.lineTo(-u * 0.4, u * 0.08); c.lineTo(u * 0.02, u * 0.08);
                    c.lineTo(-u * 0.18, u * 0.78); c.lineTo(u * 0.42, -u * 0.1); c.lineTo(u * 0.02, -u * 0.1);
                    c.closePath(); c.fill(); if (extra) { c.lineWidth = extra; c.stroke(); }
                    break;
                case "strut":
                    c.lineWidth = u * 0.22 + extra;
                    c.beginPath(); c.moveTo(-u * 0.55, -u * 0.6); c.lineTo(u * 0.55, -u * 0.6); c.moveTo(-u * 0.55, u * 0.6); c.lineTo(u * 0.55, u * 0.6); c.moveTo(0, -u * 0.55); c.lineTo(0, u * 0.55); c.stroke();
                    break;
                case "overdrive":
                    c.beginPath(); c.arc(0, u * 0.15, u * 0.62, Math.PI * 1.05, Math.PI * 1.95); c.stroke();
                    c.beginPath(); c.moveTo(0, u * 0.15); c.lineTo(u * 0.42, -u * 0.28); c.stroke();
                    c.beginPath(); c.arc(0, u * 0.15, u * 0.12 + extra * 0.4, 0, Math.PI * 2); c.fill();
                    break;
                case "anchor":
                    c.beginPath(); c.arc(0, -u * 0.55, u * 0.14 + extra * 0.3, 0, Math.PI * 2); c.stroke();
                    c.beginPath(); c.moveTo(0, -u * 0.4); c.lineTo(0, u * 0.62); c.stroke();
                    c.beginPath(); c.moveTo(-u * 0.38, -u * 0.12); c.lineTo(u * 0.38, -u * 0.12); c.stroke();
                    c.beginPath(); c.arc(0, u * 0.12, u * 0.5, Math.PI * 0.12, Math.PI * 0.88); c.stroke();
                    c.beginPath(); c.moveTo(-u * 0.5, u * 0.3); c.lineTo(-u * 0.62, u * 0.5); c.moveTo(u * 0.5, u * 0.3); c.lineTo(u * 0.62, u * 0.5); c.stroke();
                    break;
                case "flash":
                    gemPath(c, 0, u * 0.02, u * 0.66); c.fill(); if (extra) { c.lineWidth = extra; c.stroke(); }
                    if (!extra) {
                        c.fillStyle = col;
                        c.beginPath();
                        c.moveTo(u * 0.1, -u * 0.38); c.lineTo(-u * 0.2, u * 0.04); c.lineTo(u * 0.02, u * 0.04);
                        c.lineTo(-u * 0.1, u * 0.42); c.lineTo(u * 0.22, -u * 0.02); c.lineTo(u * 0.02, -u * 0.02);
                        c.closePath(); c.fill();
                    }
                    break;
                case "bulwark":
                    c.fillRect(-u * 0.64 - extra / 2, -u * 0.6 - extra / 2, u * 1.28 + extra, u * 1.2 + extra);
                    if (!extra) {
                        c.strokeStyle = col; c.lineWidth = Math.max(1, u * 0.1);
                        c.beginPath();
                        for (let r = 1; r < 3; r++) { const yy = -u * 0.6 + r * u * 0.4; c.moveTo(-u * 0.64, yy); c.lineTo(u * 0.64, yy); }
                        c.moveTo(0, -u * 0.6); c.lineTo(0, -u * 0.2); c.moveTo(-u * 0.32, -u * 0.2); c.lineTo(-u * 0.32, u * 0.2); c.moveTo(u * 0.32, -u * 0.2); c.lineTo(u * 0.32, u * 0.2); c.moveTo(0, u * 0.2); c.lineTo(0, u * 0.6);
                        c.stroke();
                    }
                    break;
                case "decoy":
                    c.setLineDash([u * 0.24, u * 0.16]);
                    gemPath(c, 0, u * 0.02, u * 0.66); c.stroke();
                    c.setLineDash([]);
                    c.beginPath(); c.arc(0, 0, u * 0.14 + extra * 0.3, 0, Math.PI * 2); c.fill();
                    break;
                default:
                    gemPath(c, 0, 0, u * 0.6); c.fill();
            }
        }
    }
    const kitIconSprites = new Map();
    function kitIconSprite(id, s) {
        const key = id + "@" + s;
        let spr = kitIconSprites.get(key);
        if (spr) return spr;
        const col = KIT_CARD[id] || "#8a93a6";
        const scale = 2, pad = 4;
        const S = (s + pad * 2) * scale;
        spr = document.createElement("canvas");
        spr.width = spr.height = S;
        const c = spr.getContext("2d");
        c.scale(scale, scale);
        c.translate(s / 2 + pad, s / 2 + pad);
        const h = s / 2, rr = s * 0.24;
        c.save();
        c.translate(0.6, 1.4);
        roundRectPath(c, -h, -h, s, s, rr);
        c.fillStyle = "rgba(0,0,0,0.45)"; c.fill();
        c.restore();
        roundRectPath(c, -h, -h, s, s, rr);
        const grad = c.createLinearGradient(0, -h, 0, h);
        grad.addColorStop(0, gameDraw.mixColors(col, "#ffffff", 0.18));
        grad.addColorStop(1, gameDraw.mixColors(col, "#000000", 0.22));
        c.fillStyle = grad; c.fill();
        c.save();
        c.clip();
        c.fillStyle = "rgba(255,255,255,0.14)";
        c.fillRect(-h, -h, s, s * 0.42);
        c.restore();
        c.lineWidth = 1.5;
        c.strokeStyle = "rgba(0,0,0,0.7)";
        roundRectPath(c, -h + 0.75, -h + 0.75, s - 1.5, s - 1.5, rr - 0.5); c.stroke();
        c.save();
        c.translate(0.5, 0.5);
        c.globalAlpha = 0.35;
        c.fillStyle = "#000000"; c.strokeStyle = "#000000";
        drawKitGlyph(c, id, h * 0.92, "#000000");
        c.restore();
        drawKitGlyph(c, id, h * 0.92, col);
        if (kitIconSprites.size > 40) kitIconSprites.clear();
        kitIconSprites.set(key, spr);
        return spr;
    }
    function drawKitIcon(c, id, cx, cy, s) {
        const spr = kitIconSprite(id, s);
        const half = spr.width / 4;   // sprite is baked at 2x with padding
        c.drawImage(spr, cx - half, cy - half, half * 2, half * 2);
    }
    function drawKitBox(spacing, alcoveSize) {
        const want = shopUiMode() && !global.died && !global.mobile && global.gems && global.gems.cap > 0 &&
            (!global.tutorialMode || (window.dwTutUi === "kit" || (window.dwTutAllow || "").includes("kit") || (global.shop.state && (global.shop.state.kitOrder || []).length)));
        kitGlide.set(want ? 1 : 0);
        const g = kitGlide.get();
        kitBoxTop = 0;
        if (g < 0.02) { global.clickables.kit.hide(); return; }
        const sh = global.shop, st = sh.state || {};
        const catalog = sh.catalog || [];
        const byId = id => catalog.find(i => i.id === id);
        const now = performance.now();
        // same anchors as drawSkillBars: 11 bars of 14 + 5, counter row above
        const barH = 14, vsp = 5, bars = 11;
        const barsTop = global.screenHeight - spacing - 5.5 - barH - (bars - 1) * (barH + vsp);
        const W = alcoveSize - 10, H = 118;
        const x = spacing + 3;
        const y = barsTop - 26 - H + (1 - g) * 14;
        kitBoxTop = barsTop - 26 - H;
        const c = ctx[2];
        const cr = global.canvas.height / global.screenHeight / global.ratio;
        const hov = global.clickables.kit.check({ x: global.mouse.x, y: global.mouse.y });
        global.clickables.kit.hide();
        c.save();
        c.globalAlpha = g;
        roundRectPath(c, x, y, W, H, 8);
        c.fillStyle = "rgba(0,0,0,0.46)";
        c.fill();
        c.lineWidth = 1.5;
        c.strokeStyle = "rgba(255,255,255,0.10)";
        c.stroke();
        // top row: two equal chips, drill and sidearm, aligned to the slot grid
        const pad = 8, gap = 6;
        const chipY = y + 7, chipH = 17, chipW = (W - pad * 2 - gap) / 2;
        const drillItem = st.drill > 0 ? byId("drill" + st.drill) : null;
        const armItem = st.arm ? byId(st.arm) : null;
        const chips = [
            { i: 3, x: x + pad, text: st.drill > 0 ? "DRILL " + ROMAN[st.drill] : "NO DRILL", col: st.drill > 0 ? "#eda766" : color.grey, on: st.drill > 0,
              flash: sh.drillFlashAt, tip: drillItem ? [drillItem.name, drillItem.desc] : ["Drill", "Sold at any shop. Each tier chews rock faster."] },
            { i: 4, x: x + pad + chipW + gap, text: armItem ? (shortName(armItem.name, st.armUntil > Date.now() ? 9 : 14).toUpperCase() + (st.armUntil > Date.now() ? "  " + fmtRaidClock(Math.ceil((st.armUntil - Date.now()) / 1000)) : "")) : "NO SIDEARM", col: armItem ? "#c9a8ff" : color.grey, on: !!armItem,
              flash: sh.armFlashAt, tip: armItem ? [armItem.name + "  ·  right click", armItem.desc] : ["Sidearm", "A second gun on right click. Sold at any shop."] },
        ];
        for (const ch of chips) {
            const fl = ch.flash ? Math.max(0, 1 - (now - ch.flash) / 700) : 0;
            roundRectPath(c, ch.x, chipY, chipW, chipH, 5);
            c.fillStyle = ch.on ? "rgba(255,255,255," + (0.07 + 0.25 * fl) + ")" : "rgba(255,255,255,0.035)";
            c.fill();
            if (hov === ch.i) { c.lineWidth = 1; c.strokeStyle = "rgba(255,255,255,0.35)"; c.stroke(); }
            drawText(ch.text, ch.x + chipW / 2, chipY + chipH / 2 + 0.5, 9, ch.col, "center", true, g);
            global.clickables.kit.place(ch.i, ch.x * cr, chipY * cr, chipW * cr, chipH * cr);
            if (hov === ch.i) queueTip(ch.tip[0], ch.tip[1], ch.x + chipW / 2, y);
        }
        // gear row: every passive you own, as a small tag with a tooltip
        const gearY = chipY + chipH + 6, gearH = 16;
        const gearIds = (st.gear || []).filter(id => byId(id));
        drawText("GEAR", x + pad + 2, gearY + gearH / 2, 8, color.grey, "left", true, g);
        if (!gearIds.length) {
            drawText("none yet", x + pad + 34, gearY + gearH / 2, 8, "rgba(160,168,180,0.7)", "left", true, g);
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
                roundRectPath(c, bx, gearY, bw, gearH, 4);
                c.fillStyle = hov === 10 + i ? "rgba(92,224,216,0.32)" : ending ? "rgba(255,120,110,0.28)" : "rgba(92,224,216,0.16)";
                c.fill();
                c.lineWidth = 1; c.strokeStyle = ending ? "rgba(255,120,110,0.7)" : "rgba(92,224,216,0.45)"; c.stroke();
                // time left: a thin bar along the bottom edge of the tag
                c.fillStyle = ending ? "#ff9a8c" : SHOP_ACCENT;
                c.fillRect(bx + 2, gearY + gearH - 3, (bw - 4) * frac, 2);
                drawText(GEAR_TAG[item.id] || item.name.slice(0, 3).toUpperCase(), bx + bw / 2, gearY + gearH / 2 - 0.5, bw < 30 ? 6.5 : 7.5, ending ? "#ff9a8c" : SHOP_ACCENT, "center", true, g);
                global.clickables.kit.place(10 + i, bx * cr, gearY * cr, bw * cr, gearH * cr);
                if (hov === 10 + i) queueTip(item.name + (leftMs >= 0 ? "  ·  " + fmtRaidClock(Math.ceil(leftMs / 1000)) + " left" : ""), item.desc, bx + bw / 2, y);
            }
        }
        // slots: key badge top-left, count top-right, name below
        const keys = [keyLabel("KEY_KIT_1", "Z"), keyLabel("KEY_KIT_2", "Q"), keyLabel("KEY_KIT_3", "N")];
        const slotY = gearY + gearH + 7, slotH = H - (slotY - y) - 7;
        const slotW = (W - pad * 2 - gap * 2) / 3;
        for (let i = 0; i < 3; i++) {
            const sx = x + pad + i * (slotW + gap);
            const id = (st.kitOrder || [])[i];
            const item = id ? byId(id) : null;
            const count = id ? (st.kit[id] | 0) : 0;
            const fl = id && sh.slotFlash && sh.slotFlash[id] ? sh.slotFlash[id] : null;
            const flT = fl ? Math.max(0, 1 - (now - fl.at) / 650) : 0;
            roundRectPath(c, sx, slotY, slotW, slotH, 6);
            c.fillStyle = item ? "rgba(255,215,94," + (0.10 + (fl && fl.kind === "get" ? 0.35 * flT : 0)) + ")" : "rgba(255,255,255,0.03)";
            c.fill();
            c.lineWidth = hov === i ? 1.6 : 1;
            c.strokeStyle = item ? (fl && fl.kind === "use" ? "rgba(255,255,255," + (0.45 + 0.5 * flT) + ")" : "rgba(255,215,94,0.5)") : "rgba(255,255,255,0.08)";
            c.stroke();
            // key badge
            roundRectPath(c, sx + 4, slotY + 4, 15, 12, 3);
            c.fillStyle = item ? "rgba(255,215,94,0.22)" : "rgba(255,255,255,0.06)";
            c.fill();
            drawText(keys[i], sx + 11.5, slotY + 10.5, 8, item ? color.gold : color.grey, "center", true, g);
            if (item) {
                drawText("x" + count, sx + slotW - 5, slotY + 10.5, 8.5, color.teal, "right", true, g);
                // the item's card: rounded corners, its own colour, its own glyph
                drawKitIcon(c, item.id, sx + slotW / 2, slotY + 30, 26);
                drawText(KIT_SHORT[item.id] || item.name.slice(0, 7).toUpperCase(), sx + slotW / 2, slotY + slotH - 8, 8, color.guiwhite, "center", true, g);
                global.clickables.kit.place(i, sx * cr, slotY * cr, slotW * cr, slotH * cr);
                if (hov === i) queueTip(item.name + "  ·  " + keys[i], item.desc + " Drag it out of the box to throw it away.", sx + slotW / 2, y);
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
                drawText("empty", sx + slotW / 2, slotY + slotH - 8, 8, color.grey, "center", true, g);
                global.clickables.kit.place(i, sx * cr, slotY * cr, slotW * cr, slotH * cr);
                if (hov === i) queueTip("Kit slot " + (i + 1) + "  ·  " + keys[i], "Holds one kit item type. Buy at a shop or break a chest.", sx + slotW / 2, y);
            }
        }
        global.kitBoxRectCanvas = { x: x * cr, y: y * cr, w: W * cr, h: H * cr };
        // drag ghost: the item's card follows the cursor; outside the box it
        // reads DROP
        const dragK = global.kitDrag;
        if (dragK) {
            const id = (st.kitOrder || [])[dragK.slot];
            const mx = global.mouse.x / cr, my = global.mouse.y / cr;
            if (id && Math.hypot(global.mouse.x - dragK.x, global.mouse.y - dragK.y) > 14) {
                const outside = mx < x || mx > x + W || my < y || my > y + H;
                c.save();
                c.globalAlpha = 0.9;
                drawKitIcon(c, id, mx, my, 26);
                c.restore();
                drawText(outside ? "DROP" : "", mx, my + 24, 9, "#ff9a8c", "center", true);
            }
        }
        c.restore();
    }
    // ── shop panel ─────────────────────────────────────────────────────
    function shopStatus(item) {
        const st = global.shop.state || {};
        if (item.cat === "drill") {
            if ((st.drill | 0) >= item.tier) return { text: "OWNED", col: SHOP_ACCENT, buy: false };
            if (item.tier !== (st.drill | 0) + 1) return { text: "LOCKED", col: color.grey, buy: false };
            return { text: "NEXT", col: color.gold, buy: true };
        }
        if (item.cat === "gear") {
            if ((st.gear || []).includes(item.id)) return { text: "RUNNING", col: SHOP_ACCENT, buy: false };
            if ((st.gear || []).length >= 4) return { text: "GEAR FULL", col: color.grey, buy: false };
            return { text: "", col: color.grey, buy: true };
        }
        if (item.cat === "kit") {
            const have = (st.kit || {})[item.id] | 0;
            if (have >= item.max) return { text: "x" + have + " FULL", col: SHOP_ACCENT, buy: false };
            if (!have && (st.kitOrder || []).length >= 3) return { text: "KIT FULL", col: color.grey, buy: false };
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
    // black border. The same recipe the class-upgrade tiles use.
    function drawFlatTile(c, x, y, w, h, fill, hoverT, alpha, sel, selCol) {
        c.save();
        c.globalAlpha = alpha;
        c.fillStyle = fill;
        c.fillRect(x, y, w, h);
        if (hoverT > 0) {
            c.globalAlpha = alpha * 0.22 * hoverT;
            c.fillStyle = color.guiwhite;
            c.fillRect(x, y, w, h);
            c.globalAlpha = alpha * 0.8 * hoverT;
            c.lineWidth = 1.5;
            c.strokeStyle = selCol || SHOP_ACCENT;
            c.strokeRect(x + 3, y + 3, w - 6, h - 6);
        }
        c.globalAlpha = alpha * 0.25;
        c.fillStyle = color.black;
        c.fillRect(x, y + h * 0.6, w, h * 0.4);
        c.globalAlpha = alpha;
        c.lineWidth = 3;
        c.strokeStyle = color.black;
        c.strokeRect(x, y, w, h);
        if (sel) {
            c.lineWidth = 2;
            c.strokeStyle = selCol || SHOP_ACCENT;
            c.strokeRect(x + 3, y + 3, w - 6, h - 6);
        }
        c.restore();
    }
    const SHOP_PANEL = "#1b1e26", SHOP_HEAD = "#1f3437", SHOP_CARD = "#262a35", SHOP_CARD_OFF = "#1e2028", SHOP_CARD_SEL = "#1e3c40";
    const shopMeasure = new Map();
    function shopMeasureText(txt, size) {
        const k = txt + "|" + size;
        let w = shopMeasure.get(k);
        if (w === undefined) { w = measureText(txt, size); if (shopMeasure.size > 400) shopMeasure.clear(); shopMeasure.set(k, w); }
        return w;
    }
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
        // frame
        c.save();
        c.globalAlpha = g;
        c.fillStyle = "rgba(0,0,0,0.35)";
        c.fillRect(x + 4, y + 6, W, H);
        c.fillStyle = SHOP_PANEL;
        c.fillRect(x, y, W, H);
        c.fillStyle = SHOP_HEAD;
        c.fillRect(x, y, W, 46);
        c.globalAlpha = g * 0.25;
        c.fillStyle = color.black;
        c.fillRect(x, y + 46 * 0.6, W, 46 * 0.4);
        c.globalAlpha = g;
        c.lineWidth = 3;
        c.strokeStyle = color.black;
        c.strokeRect(x, y, W, H);
        c.beginPath(); c.moveTo(x, y + 46); c.lineTo(x + W, y + 46); c.stroke();
        gemPath(c, x + 30, y + 23, 9);
        c.fillStyle = color.gold; c.fill();
        c.lineWidth = 1.2; c.strokeStyle = "#5a4310"; c.stroke();
        c.restore();
        drawText("SHOP", x + 48, y + 23, 17, SHOP_ACCENT, "left", true, g);
        drawText(String(sh.padName || "").replace(" Shop", "").toUpperCase(), x + 48 + shopMeasureText("SHOP", 17) + 12, y + 24, 10.5, color.grey, "left", true, g);
        const bankTxt = fmtNum(global.gems.banked | 0);
        drawText(bankTxt, x + W - 62, y + 23, 14, color.teal, "right", true, g);
        drawText("BANKED", x + W - 62 - shopMeasureText(bankTxt, 14) - 10, y + 23, 10, color.grey, "right", true, g);
        // close
        const cbs = 24, cbx = x + W - 42, cby = y + 11;
        drawButton(cbx + cbs / 2, cby, cbs, cbs, g, "rect", "X", 12, "#8a3a3a", false, false, true, "shop", cr, 41);
        c.globalAlpha = 1;
        // tabs
        const tabY = y + 58, tabH = 26, tabW = (W - 40) / SHOP_TABS.length;
        for (let i = 0; i < SHOP_TABS.length; i++) {
            const [id, label] = SHOP_TABS[i];
            const tx = x + 20 + i * tabW;
            const on = sh.tab === id;
            drawButton(tx + tabW / 2, tabY, tabW - 6, tabH, g, "rect", label.toUpperCase(), 11, on ? SHOP_ACCENT : color.grey, false, on ? SHOP_ACCENT : false, true, "shop", cr, i);
            c.globalAlpha = 1;
        }
        // item grid + detail
        const items = catalog.filter(it => it.cat === sh.tab);
        sh.tabItems = items;
        if (!sh.sel || !items.find(it => it.id === sh.sel)) sh.sel = items.length ? items[0].id : null;
        const gridX = x + 20, gridY = tabY + tabH + 14;
        const detailW = 240;
        const gridW = W - 40 - detailW - 14;
        const cols = gridW >= 430 ? 3 : 2;
        const cardW = (gridW - (cols - 1) * 8) / cols, cardH = 58;
        const hover = global.clickables.shop.check({ x: global.mouse.x, y: global.mouse.y });
        const kitFull = ((sh.state && sh.state.kitOrder) || []).length >= 3;
        for (let i = 0; i < items.length && i < 36; i++) {
            const it = items[i];
            const col = i % cols, row = (i / cols) | 0;
            const ix = gridX + col * (cardW + 8), iy = gridY + row * (cardH + 8);
            if (iy + cardH > y + H - 32) break;
            const sel = it.id === sh.sel;
            const hov = hover === 4 + i;
            const hT = hoverEase("card:" + it.id, hov, now);
            const status = shopStatus(it);
            const afford = (global.gems.banked | 0) >= it.price;
            drawFlatTile(c, ix, iy, cardW, cardH, sel ? SHOP_CARD_SEL : status.buy ? SHOP_CARD : SHOP_CARD_OFF, hT, g, sel, SHOP_ACCENT);
            let nameX = ix + 10;
            if (it.cat === "kit") { drawKitIcon(c, it.id, ix + 18, iy + 17, 18); nameX = ix + 32; }
            const nameW = cardW - (nameX - ix) - 10;
            let ns = 12; while (ns > 9 && shopMeasureText(it.name, ns) > nameW) ns -= 0.5;
            drawText(it.name, nameX, iy + 17, ns, status.buy ? color.guiwhite : "#9aa2b0", "left", true, g);
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
        drawFlatTile(c, dx, dy, detailW, dh, "#20242e", 0, g, false);
        const sel = items.find(it => it.id === sh.sel);
        if (sel) {
            const status = shopStatus(sel);
            const catName = (SHOP_TABS.find(t => t[0] === sel.cat) || ["", ""])[1].toUpperCase();
            let tx = dx + 14;
            if (sel.cat === "kit") { drawKitIcon(c, sel.id, dx + 27, dy + 24, 26); tx = dx + 48; }
            drawText(sel.name, tx, dy + 18, 15, color.guiwhite, "left", true, g);
            drawText(catName + (sel.cat === "kit" ? "  ·  MAX " + sel.max + " PER SLOT" : sel.cat === "drill" ? "  ·  TIER " + sel.tier : sel.cat === "arm" ? "  ·  RIGHT CLICK" : "  ·  PASSIVE"), tx, dy + 36, 9.5, color.grey, "left", true, g);
            const lines = wrapLines(sel.desc, 11.5, detailW - 28);
            let ly = dy + 60;
            for (const ln of lines.slice(0, 5)) { drawText(ln, dx + 14, ly, 11.5, "#d8dce6", "left", true, g); ly += 16; }
            if (sel.cat === "kit" && !status.buy && status.text === "KIT FULL") {
                for (const ln of wrapLines("Your kit holds 3 kinds of item. Use one up to make room.", 10.5, detailW - 28)) {
                    drawText(ln, dx + 14, ly + 2, 10.5, "#ff9a8c", "left", true, g); ly += 14;
                }
            }
            const afford = (global.gems.banked | 0) >= sel.price;
            c.save(); c.globalAlpha = g;
            gemPath(c, dx + 20, dy + dh - 52, 6);
            c.fillStyle = afford ? color.gold : "#ff9a8c"; c.fill();
            c.restore();
            drawText(fmtNum(sel.price) + " banked", dx + 32, dy + dh - 52, 13, afford ? color.gold : "#ff9a8c", "left", true, g);
            const can = status.buy && afford;
            const bbx = dx + 14, bby = dy + dh - 40, bbw = detailW - 28, bbh = 28;
            const btnText = !status.buy ? (status.text === "KIT FULL" ? "KIT FULL (3 SLOTS)" : status.text || "UNAVAILABLE") : !afford ? "NOT ENOUGH BANKED" : "BUY";
            drawButton(bbx + bbw / 2, bby, bbw, bbh, g, "rect", btnText, 12.5, can ? color.gold : color.grey, false, can ? color.gold : false, can, "shop", cr, 40);
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
    function drawEdgeMarker(c, e, col, glyph, name, distText, placed) {
        const sw = global.screenWidth, sh = global.screenHeight;
        const label = name + (distText ? "  " + distText : "");
        const tw = measureText(label, 10.5);
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
        c.save();
        c.translate(e.x, e.y);
        c.rotate(e.ang);
        c.fillStyle = col; c.strokeStyle = color.black; c.lineWidth = 2; c.lineJoin = "round";
        c.beginPath(); c.moveTo(10, 0); c.lineTo(-6, -8); c.lineTo(-3, 0); c.lineTo(-6, 8); c.closePath();
        c.fill(); c.stroke();
        c.restore();
        c.save();
        roundRectPath(c, px - pw / 2, py - ph / 2, pw, ph, 10.5);
        c.fillStyle = "rgba(10,11,16,0.86)";
        c.fill();
        c.lineWidth = 1.5;
        c.strokeStyle = col;
        c.stroke();
        c.fillStyle = col; c.strokeStyle = color.black; c.lineWidth = 1.2;
        const gx = px - pw / 2 + 12, gy = py;
        if (glyph === "boss") { polyPath(c, gx, gy, 6.5, 8, Math.PI / 8); c.fill(); c.stroke(); }
        else if (glyph === "gem") { gemPath(c, gx, gy + 0.5, 6.5); c.fill(); c.stroke(); }
        else if (glyph === "skull") { c.restore(); drawSkull(c, gx, gy, 6, col); c.save(); }
        else { c.beginPath(); c.moveTo(gx, gy - 6); c.lineTo(gx + 6, gy + 5); c.lineTo(gx - 6, gy + 5); c.closePath(); c.fill(); c.stroke(); }
        c.restore();
        drawText(label, px - pw / 2 + 23, py + 0.5, 10.5, color.guiwhite, "left", true, 1, 5);
    }
    // Damage reads on the chest itself: jagged cracks grow from the centre
    // as health falls, seeded per chest so they do not flicker.
    const KIT_FX = {
        medkit: "#6ff5a8", overdrive: "#ffb347", anchor: "#7fb1f2", flash: "#5ce0d8",
        bulwark: "#b9c3d1", decoy: "#ffd75e", strut: "#c9c9d6", charge: "#ffe0a8",
    };
    const chestSeenAt = new Map();
    function drawRoyaleWorldMarkers(px, py, ratio) {
        if (!royaleActive() || global.died) return;
        sweepTracks();
        const r = global.royale;
        const c = ctx[2];
        const cx = global.screenWidth / 2, cy = global.screenHeight / 2;
        const now = performance.now();
        const pulse = 0.5 + 0.5 * Math.sin(now / 300);
        const toScreen = (wx, wy) => ({ x: ratio * wx - px + cx, y: ratio * wy - py + cy });
        const onScreen = (s, m) => s.x > -m && s.x < global.screenWidth + m && s.y > -m && s.y < global.screenHeight + m;
        const me = { x: global.player.renderx, y: global.player.rendery };
        const marks = [];
        if (r.boss) {
            const p = trackPos("boss", r.boss.x, r.boss.y, 0.6);
            const s = toScreen(p.x, p.y);
            if (!onScreen(s, -60)) marks.push({ pri: 1, s, col: r.boss.c || "#c9a8ff", glyph: "boss", name: String(r.boss.name || "BOSS").toUpperCase(), d: Math.hypot(p.x - me.x, p.y - me.y) });
        }
        if (r.bloom && r.bloom.until > Date.now()) {
            const s = toScreen(r.bloom.x, r.bloom.y);
            const d = Math.hypot(r.bloom.x - me.x, r.bloom.y - me.y);
            if (!onScreen(s, -(r.bloom.r || 300) * ratio) && d < 3400) marks.push({ pri: 2, s, col: "#ffd76e", glyph: "gem", name: "ORE BLOOM", d });
        }
        // marked streakers: a red mark over the tank on screen, the nearest
        // one off screen gets an edge marker
        let nearest = null;
        for (const p of (r.pings || [])) {
            if (p.id === gui.playerid) continue;
            const tp = trackPos("ping" + p.id, p.x, p.y, 0.6);
            const s = toScreen(tp.x, tp.y);
            const d = Math.hypot(tp.x - me.x, tp.y - me.y);
            if (onScreen(s, -20)) {
                const yy = s.y - 62 * Math.min(1.4, ratio) - 8;
                c.save();
                c.translate(s.x, yy);
                c.fillStyle = "#e03e41"; c.strokeStyle = color.black; c.lineWidth = 2.2; c.lineJoin = "round";
                c.beginPath(); c.moveTo(0, 9); c.lineTo(-8, -4); c.lineTo(8, -4); c.closePath();
                c.fill(); c.stroke();
                c.restore();
                drawText("STREAK x" + p.streak, s.x, yy - 13, 10.5, "#ffb347", "center", true, 0.7 + 0.3 * pulse, 5);
            } else if (!nearest || d < nearest.d) {
                nearest = { pri: 3, s, col: "#ffb347", glyph: "streak", name: "STREAK x" + p.streak + " " + shortName(p.name, 10).toUpperCase(), d };
            }
        }
        if (nearest) marks.push(nearest);
        marks.sort((a, b) => a.pri - b.pri);
        const placed = [];
        for (const mk of marks.slice(0, 3)) {
            const e = edgePoint(mk.s.x - cx, mk.s.y - cy);
            drawEdgeMarker(c, e, mk.col, mk.glyph, mk.name, fmtDist(mk.d), placed);
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
            const big = f.kind === "boss" || f.kind === "bossdead" || f.kind === "bloom";
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
                if (t < 0.7 && !global.lowFx) { c.globalAlpha = (1 - t / 0.7) * 0.5; c.drawImage(vignetteSprite(sw, shh, 0.35, tint), 0, 0, sw, shh); }
                {
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
                for (const sp of f.sparks) {
                    const r2 = eo * sp.sp * 420 * ratio, r1 = r2 * 0.55;
                    c.globalAlpha = fadeA * 0.95;
                    c.strokeStyle = sp.white ? "#ffffff" : bcol;
                    c.lineWidth = Math.max(1, 3.5 * (1 - t * 0.6) * ratio);
                    c.beginPath(); c.moveTo(sx + Math.cos(sp.ang) * r1, sy + Math.sin(sp.ang) * r1); c.lineTo(sx + Math.cos(sp.ang) * r2, sy + Math.sin(sp.ang) * r2); c.stroke();
                }
                c.globalAlpha = fadeA;
                for (let pi = 0; pi < f.parts.length; pi += global.lowFx ? 2 : 1) {
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
        const mapLabel = (text, mx, my, above, col) => drawText(text, mx, my + (above ? -1 : 1) * (above ? labelPx * 0.6 + 2 : labelPx * 0.9 + 2), labelPx, col, "center", true, 0.95, 4);
        for (const s of (global.shops || [])) {
            const mx = T.X(s.x), my = T.Y(s.y);
            if (!inside(mx, my)) continue;
            polyPath(c, mx, my, dotR * 1.5, 6, Math.PI / 6);
            c.fillStyle = "#12191f"; c.fill();
            c.lineWidth = 1.6; c.strokeStyle = SHOP_ACCENT; c.stroke();
            gemPath(c, mx, my, dotR * 0.7);
            c.fillStyle = color.gold; c.fill();
        }
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
        for (const p of (r.pings || [])) {
            if (p.id === gui.playerid) continue;
            const tp = trackPos("ping" + p.id, p.x, p.y, 0.6);
            const mx = T.X(tp.x), my = T.Y(tp.y);
            if (!inside(mx, my)) continue;
            c.save();
            c.translate(mx, my);
            c.fillStyle = "#ffb347"; c.strokeStyle = color.black; c.lineWidth = 1.5; c.lineJoin = "round";
            const s2 = dotR * 1.6;
            c.beginPath(); c.moveTo(0, -s2); c.lineTo(s2, s2 * 0.8); c.lineTo(-s2, s2 * 0.8); c.closePath();
            c.fill(); c.stroke();
            c.restore();
            if (p.streak) drawText("x" + p.streak, mx, my - dotR * 2.6, 8, "#ffb347", "center", true);
            c.save();
            c.globalAlpha = 0.8;
            c.strokeStyle = "#ffb347"; c.lineWidth = 1.5;
            c.beginPath(); c.arc(mx, my, dotR * 2.6 * pulse, 0, Math.PI * 2); c.stroke();
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
    }
    function drawRaidResults() {
        const r = global.royale;
        if (!royaleActive() || !r.results || !r.results.top) return;
        const c = ctx[2];
        const cx = global.screenWidth / 2, cy = global.screenHeight * 0.34;
        const rows = r.results.top.slice(0, 10);
        const PW = Math.min(420, global.screenWidth - 40);
        const PH = 64 + rows.length * 22;
        const px = cx - PW / 2, py = cy - PH / 2;
        c.save();
        c.fillStyle = "rgba(16,17,22,0.94)";
        c.fillRect(px, py, PW, PH);
        c.lineWidth = 3;
        c.strokeStyle = color.black;
        c.strokeRect(px, py, PW, PH);
        c.restore();
        drawText("RAID OVER. TOP 10 PAID.", cx, py + 26, 16, color.gold, "center");
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            drawText("#" + (i + 1) + " " + (row.name || "Unnamed") + "  " + util.formatLargeNumber(row.score | 0),
                cx, py + 52 + i * 22, 13, color.guiwhite, "center");
        }
    }

    // Full-screen victory/defeat banner while the war round is being decided.
    function drawWarBanner() {
        if (royaleActive() && global.royale.results) {
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
        roundRectPath(c, bx, cy - 46, bw, 92, 14);
        c.fillStyle = "rgba(16,17,22,0.95)";
        c.fill();
        c.lineWidth = 3;
        c.strokeStyle = col;
        c.stroke();
        drawText(name + " TEAM WINS THE WAR", cx, cy - 12, 30, col, "center");
        const secs = Math.max(0, Math.ceil((w.resetIn || 0) / 1000));
        drawText("+" + util.formatLargeNumber(w.bonus || 0) + " gems for every " + name.toLowerCase() +
                 " miner - new war in " + secs + "s", cx, cy + 26, 15, color.guiwhite, "center");
        c.restore();
    }

    // Banked-gem rungs. A quiet gold beat - label, number, bonus - not a
    // carnival. The pop is the reward; the rest of the HUD stays readable.
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
            roundRectPath(c, cx - pw / 2, cy - ph / 2 - 8, pw, ph, 16);
            c.fillStyle = "rgba(18, 16, 10, 0.82)";
            c.fill();
            c.lineWidth = 3;
            c.strokeStyle = myCol;
            c.stroke();
            c.restore();

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
            drawText("BANKED", cx, cy - 36 * pop, 14, myCol, "center", true, 1, 7);
            drawText(t.title, cx, cy + 2, titleSize, color.guiwhite, "center", true, 1, 4.5);
            if (t.bonus) {
                drawText(t.bonus, cx, cy + 44 * pop, bonusSize, myCol, "center", true, 1, 4.5);
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

    // Floating damage numbers. World-anchored. A combo holds at full strength
    // until a second of silence, then fades. Words are picked for YOU vs THEM
    // so "Nice" never sits on your own head.
    function drawDamageNumbers(px, py, ratio) {
        const list = global.damageNumbers;
        if (!list || !list.length) return;
        if (!config.game.damageNumbers) { list.length = 0; return; }
        const now = performance.now();
        const c = ctx[2];
        const halfW = global.screenWidth / 2,
              halfH = global.screenHeight / 2;
        const ROCK_ORE_TINT = ["#F2F0EA", "#E9A766", "#7FB1F2", "#D98AF0", "#6FF5A8"];
        c.save();
        for (let i = list.length - 1; i >= 0; i--) {
            const d = list[i];
            const live = d.kind === "rock" ? null : global.entities.find(e => e.id === d.id);
            if (live) { d.x = live.x; d.y = live.y; }
            const age = now - d.born;
            const idle = now - (d.comboAt || d.born);
            const hold = d.holdMs ?? DMG_COMBO_HOLD_MS;
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
            const size = rock
                ? (12.5 + Math.min(6, d.amount * 0.08)) * pop * ratio
                : (15.5 + Math.min(8, d.amount * 0.1) + (tier >= 2 ? 3.5 : tier >= 1 ? 1.5 : 0) + (finish ? 3 : 0) + Math.min(3, combo * 0.25)) * pop * ratio;
            const tint = rock
                ? (ROCK_ORE_TINT[d.ore | 0] || ROCK_ORE_TINT[0])
                : d.self
                    ? "#FF5A52"
                    : (finish || tier >= 2 ? "#FFB020" : tier >= 1 ? "#FFD24A" : "#FFF4C4");

            if (!rock && !d.self && age < HIT_TICK_MS) {
                drawHitTicks(c, ratio * d.x - px + halfW, ratio * d.y - py + halfH, ratio, age, tint, fade);
            }

            c.globalAlpha = fade;
            if (d.word) {
                drawText(d.word, x, y - size * 0.92, size * 0.44, tint, "center", true, 1, 6);
            }
            const num = "-" + util.formatLargeNumber(Math.round(d.amount));
            drawText(num, x, y, size, tint, "center", true, 1, 5.5);
            if (!rock && combo >= 2) {
                drawText("×" + combo, x, y + size * 0.78, size * 0.36, tint, "center", true, 1, 6);
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

    // Red edge vignette as your own health drops. Smoothed toward the target
    // rather than tracking health directly, so a burst of chip damage feathers
    // in instead of strobing. Intensity and how far it creeps inward both
    // climb as health falls. A separate short slam covers the moment you
    // actually get hit, even at full hp.
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

        if (lowHpLevel < 0.004 && hurt < 0.01 && dead < 0.01 && cele < 0.01) return;

        const c = ctx[2];
        const w = global.screenWidth, h = global.screenHeight;
        const r = Math.hypot(w, h) / 2;

        if (lowHpLevel >= 0.004) {
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

        if (hurt > 0.01) {
            c.save();
            c.globalAlpha = 0.34 * hurt;
            c.drawImage(vignetteSprite(w, h, 0.52, "210,28,28"), 0, 0, w, h);
            c.restore();
        }
        if (cele > 0.01) {
            c.save();
            c.globalAlpha = 0.34 * cele;
            c.drawImage(vignetteSprite(w, h, 0.5, "239,199,75"), 0, 0, w, h);
            c.restore();
        }
        if (dead > 0.01) {
            c.save();
            c.globalAlpha = 0.28 * dead;
            c.drawImage(vignetteSprite(w, h, 0.58, "255,255,255"), 0, 0, w, h);
            c.restore();
        }
    }

    // The satchel is the best thing in this game and for a long time it was a
    // number in a bar. This is the other half of it: the screen itself gets
    // more frightened the richer you are.
    //
    // It used to be binary - nothing at all until the cap, then a red pulse -
    // which meant the entire dangerous middle of a run (a half-full satchel is
    // already worth killing for) looked exactly like carrying nothing. Now it
    // rises continuously from gameSound.tensionStart, warm gold while you are
    // merely rich, bleeding to red as you approach the cap.
    //
    // The throb is driven by gameSound.satchelPulse() rather than its own sine
    // so the screen beats on the same clock as the heartbeat you can hear.
    // One body, two senses - that sync is the whole effect.
    function drawSatchelDanger() {
        const g = global.gems;
        if (!config.game.satchelWarning) return;
        if (!g || !(g.cap > 0) || global.died) return;
        const load = Math.min(1, (g.carried || 0) / g.cap);
        const start = gameSound.tensionStart != null ? gameSound.tensionStart : 0.30;
        const t = (load - start) / (1 - start);
        if (t <= 0) return;
        const full = load >= 1;

        // Beat shape: a sharp systolic spike that decays, not a smooth sine -
        // a sine reads as "breathing", a spike reads as "pulse".
        const ph = gameSound.satchelPulse
            ? gameSound.satchelPulse()
            : (performance.now() % 800) / 800;
        const beat = Math.pow(1 - ph, 3);

        const c = ctx[2];
        const w = global.screenWidth, h = global.screenHeight;
        const r = Math.hypot(w, h) / 2;
        // Gold at the low end, red at the top: the colour itself tells you how
        // close to the cap you are without reading the bar.
        const mix  = Math.min(1, Math.max(0, (load - 0.6) / 0.4));
        const cr = Math.round(212 + 23 * mix),
              cg = Math.round(163 - 99 * mix),
              cb = Math.round(58  - 6  * mix);
        const rgb = cr + "," + cg + "," + cb;
        // Steady floor plus the beat on top, so it is present between beats
        // instead of blinking on and off.
        const a = (0.035 + 0.10 * t) + (0.03 + 0.13 * t) * beat;
        // The vignette also closes in: tunnel vision as the load grows.
        const inner = 0.80 - 0.20 * t - 0.03 * beat;
        if (global.lowFx) return;
        c.save();
        c.globalAlpha = a;
        c.drawImage(vignetteSprite(w, h, inner, rgb), 0, 0, w, h);
        c.restore();

        if (full) {
            c.save();
            c.globalAlpha = 0.68 + 0.32 * beat;
            drawText("Your satchel is full. Go bank it.", w / 2, 112, 16, "#eb4034", "center");
            c.restore();
        }
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

    
    
    
    let mapPaths = null;
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
            const alive = new Path2D(), dead = new Path2D();
            for (const [k, cell] of tr._cellPolys) {
                
                
                const backAsRock = tr._growing && tr._growing.get(k)?.mapped;
                const p = (tr._rockDead.has(k) && !backAsRock) ? dead : alive;
                const poly = cell.poly;
                p.moveTo((poly[0][0] / cols - 0.5) * gw, (poly[0][1] / rows - 0.5) * gh);
                for (let i = 1; i < poly.length; i++)
                    p.lineTo((poly[i][0] / cols - 0.5) * gw, (poly[i][1] / rows - 0.5) * gh);
                p.closePath();
            }
            mapPaths = { alive, dead, epoch: (mapPaths ? mapPaths.epoch : 0) + 1, builtAt: nowMP };
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
        c.lineWidth = Math.max(1.4, r * 0.34);
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
        if (royaleMode()) {
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
            c.fillStyle = "#413c4c";
            c.fill(paths.alive);
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
            // structure HP bar (neutral included - chipping a grey outpost
            
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
            drawPingDiamond(c, mx, my, dotR * 2.4, age > 19000 ? 1 - (age - 19000) / 1000 : 1);
        }
        for (const t of global.teammates) {
            if (t.id === gui.playerid) continue;
            // Tutorial: every learner is on blue, but they are strangers in
            // separate plots - a dot revealing someone else's position breaks
            // the private-world illusion the plots exist to create.
            if (global.tutorialMode) continue;
            // a friendly leader is marked by the crown ALONE - drawing the
            
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
            if (revm && revm.alive && isFinite(revm.x) && isFinite(revm.y)) {
                const mx = T.X(revm.x), my = T.Y(revm.y);
                if (inside(mx, my)) {
                    const s2 = dotR * 1.5;
                    c.save();
                    c.translate(mx, my);
                    c.rotate(Math.PI / 4);
                    c.fillStyle = "#e03e41";
                    c.strokeStyle = color.black;
                    c.lineWidth = 1.6;
                    c.beginPath();
                    c.rect(-s2, -s2, s2 * 2, s2 * 2);
                    c.fill();
                    c.stroke();
                    c.restore();
                    c.save();
                    c.beginPath();
                    c.arc(mx, my, dotR * 2.3 * pulse, 0, Math.PI * 2);
                    c.strokeStyle = "#e03e41";
                    c.lineWidth = 2;
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
        const dpr = Math.max(1, Math.min(2, global.ratio || 1));
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
        ctx[2].save();
        // round island, round map
        ctx[2].beginPath();
        ctx[2].arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
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
        ctx[2].save();
        ctx[2].beginPath();
        ctx[2].arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
        ctx[2].lineWidth = 4;
        ctx[2].strokeStyle = "rgba(0,0,0,0.6)";
        ctx[2].stroke();
        ctx[2].lineWidth = 1.5;
        ctx[2].strokeStyle = "rgba(255,255,255,0.22)";
        ctx[2].stroke();
        ctx[2].restore();
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
        const keyName = keyEl && keyEl.textContent ? keyEl.textContent : "F";
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
        const fitW = sw * 0.72, fitH = sh * 0.8;
        const fit = Math.min(fitW / gw, fitH / gh) * pop;
        const panelW = gw * fit, panelH = gh * fit;
        const px0 = (sw - panelW) / 2, py0 = (sh - panelH) / 2;
        
        // Tutorial: the room holds several learners' plots, but a learner
        // should only ever see their own training ground. Lock the frame to
        // their plot instead of showing a map of places they cannot go.
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
        const tabH = royaleActive() ? 30 : 0;
        optionsMenu_drawRoundedRect(px0 - 4, py0 - 4, panelW + 8, panelH + 8, 8);
        ctx[2].fillStyle = "#111318";
        ctx[2].fill();
        if (royaleActive()) drawRoyaleFTabs(px0, py0, panelW, tabH);
        ctx[2].save();
        ctx[2].beginPath();
        ctx[2].rect(px0, py0 + tabH, panelW, panelH - tabH);
        ctx[2].clip();
        const tab = (global.royaleBoard && global.royaleBoard.tab) || 'map';
        if (royaleActive() && tab !== 'map') {
            ctx[2].fillStyle = "#16181e";
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
                const ownCol = st.t === -1 ? gameDraw.getColor("blue")
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
        ctx[2].lineWidth = 3;
        ctx[2].strokeStyle = color.black;
        ctx[2].strokeRect(px0 - 2, py0 - 2, panelW + 4, panelH + 4);
        const keyEl = document.querySelector('#controlSettings b[data-key="KEY_TOGGLE_MAP"]');
        const keyName = keyEl && keyEl.textContent ? keyEl.textContent : "F";
        drawText("[" + keyName + "] close",
                 sw / 2, py0 + panelH + 22, 13, color.guiwhite, "center");
        ctx[2].restore();
    }

    function drawRoyaleFTabs(x, y, w, h) {
        const tabs = ["Map", "Standings", "Feed", "Alive"];
        const ids = ["map", "standings", "feed", "alive"];
        const tab = (global.royaleBoard && global.royaleBoard.tab) || "map";
        const tw = w / tabs.length;
        const c = ctx[2];
        const cr = global.canvas.height / global.screenHeight / global.ratio;
        c.save();
        c.fillStyle = "#111318";
        c.fillRect(x, y, w, h);
        c.strokeStyle = color.black;
        c.lineWidth = 3;
        c.strokeRect(x, y, w, h);
        for (let i = 0; i < tabs.length; i++) {
            const tx = x + i * tw;
            const on = tab === ids[i];
            if (on) {
                c.fillStyle = "#2a2e38";
                c.fillRect(tx, y, tw, h);
            }
            c.strokeStyle = color.black;
            c.lineWidth = 2;
            c.beginPath();
            c.moveTo(tx, y);
            c.lineTo(tx, y + h);
            c.stroke();
            drawText(tabs[i], tx + tw / 2, y + h / 2 + 5, 13, on ? color.gold : color.guiwhite, "center");
            global.clickables.royaleTab.place(i, tx * cr, y * cr, tw * cr, h * cr);
        }
        c.restore();
    }
    function drawRoyaleFTabBody(x, y, w, h, tab) {
        const rows = tab === "feed"
            ? (global.royale.feed || []).slice().reverse().map(f => ({
                name: feedLine(f).text,
                extra: f.pts ? ("+" + f.pts) : "",
            }))
            : tab === "alive"
                ? ((global.royale.board || []).filter(r => r.alive || r.here)).map((r, i) => ({
                    name: (i + 1) + ". " + (r.name || "Unnamed"),
                    extra: !r.alive ? "respawning" : (r.kills | 0) ? ((r.kills | 0) + " kills") : "alive",
                    me: r.id === gui.playerid || (r.place > 0 && r.place === (global.royale.place | 0)),
                }))
                : royaleBoardRows().map((r, i) => ({
                    name: (i + 1) + ". " + (r.name || "Unnamed"),
                    extra: util.formatLargeNumber(r.score || r.gems | 0) + " pts  " + (r.kills | 0) + " kills",
                    me: r.id === gui.playerid || (r.place > 0 && r.place === (global.royale.place | 0)),
                }));
        if (!rows.length) {
            drawText(tab === "alive" ? "Nobody is alive" : "Nobody here yet", x + w / 2, y + h / 2, 16, color.guiwhite, "center");
            return;
        }
        const rowH = 28;
        let headH = 0;
        if (tab === "standings") {
            drawText("PTS = banked + 200 per kill + 50% carried", x + 18, y + 16, 12, color.grey, "left");
            headH = 22;
        }
        const meHex = playerHexCol() || color.gold;
        for (let i = 0; i < rows.length && i < Math.floor((h - 20 - headH) / rowH); i++) {
            const ry = y + 16 + headH + i * rowH;
            // your row: your colour on the name only, nothing behind it
            drawText(rows[i].name, x + 18, ry, 14, rows[i].me ? meHex : color.guiwhite, "left");
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
        let x = global.mobile ? spacing : global.screenWidth - spacing - len - 5;
        let y = global.mobile ? spacing : global.screenHeight - height - spacing - 5;
        if (global.GUIStatus.renderMinimap) {
            
            if (royaleActive() && !global.mobile) {
                const mx = global.screenWidth - spacing - len - 5;
                const my = global.screenHeight - len - spacing - 22;
                drawFortniteMinimap(mx, my, len);
                const keyEl = document.querySelector('#controlSettings b[data-key="KEY_TOGGLE_MAP"]');
                const keyName = keyEl && keyEl.textContent ? keyEl.textContent : "F";
                drawText("[" + keyName + "] map", mx + len / 2, my + len + 16, 11, color.guiwhite, "center");
            } else if (window.terrainRenderer && window.terrainRenderer.ready && global.gems && global.gems.cap > 0 && !global.mobile) {
                const mx = global.screenWidth - spacing - len - 5;
                const my = global.screenHeight - len - spacing - 5;
                drawFortniteMinimap(mx, my, len);
            } else {
            if (global.mobile) {
                y += global.canUpgrade ? (alcoveSize / 1.5) * mobileUpgradeGlide.get() * upgradeColumns / 1.5 + spacing * (upgradeColumns + 1.55) + 9 : 0;
                y += global.canSkill || global.showSkill ? statMenu.get() * alcoveSize / 2.6 + spacing / 0.75 : 0;
            }

            let centerX = x + len / 2;
            let centerY = y + height / 2;

            // Tutorial: the room holds one arena per learner. Drawn to room
            // scale the minimap shows everybody's training ground at once and
            // shrinks the learner's own to a corner of it - so frame it on
            // their arena instead, exactly as the full map already does.
            // Everything outside the frame falls outside the clip below.
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
        if (global.mobile || !global.GUIStatus.renderMinimap) {
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
        } else if (!global.GUIStatus.minimapReducedInfo) {
            drawText(`§${global.serverStats.lag_color}§ ${(100 * gui.fps).toFixed(2)}% §reset§/ ` + global.serverStats.players + ` player${global.serverStats.players == 1 ? "" : "s"}`, x + len, y - 50 - 2 * 14, 10, color.guiwhite, "right");
            drawText(`§${global.metrics.rendertime_color}§ ${global.metrics.rendertime} FPS §reset§/` + `§${global.serverStats.mspt_color}§ ${global.serverStats.mspt} mspt`, x + len, y - 50 - 1 * 14, 10, color.guiwhite, "right");
            drawText(ping.toFixed(1) + " ms / " + global.serverStats.serverGamemodeName + " " + global.locationHash, x + len, y - 50, 10, color.guiwhite, "right");
        }
    }

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

        let mobileGlide = mobileUpgradeGlide.get();
        if (global.mobile) {
            if (global.canUpgrade && 2 * 20 + gui.upgrades.length * (6.5 * 23 + 17) > 1.4 * x) {
                y += (alcoveSize / 1.4) * mobileGlide;
            }
            y += global.canSkill || global.showSkill ? (alcoveSize / 2.2 ) * statMenu.get() : 0;
        }
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
    // Replaces the top-right leaderboard in BR - no screen space wasted.
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

        if (global.optionsMenu_Anim.isOpened) global.clickables.upgrade.hide();
        global.upgradeBoxBottom = 0;
        if (gui.upgrades.length > 0) {
            let internalSpacing = 15;
            let len = alcoveSize / 2;
            let height = len;

            global.columnCount = Math.max(global.mobile ? 9 : 3, Math.floor(gui.upgrades.length ** 0.55));
            // Desktop: add columns while the grid would run down into the kit
            // box / stat bars (short windows, big trees). Six at most, past
            // that it would reach the raid clock at top centre instead.
            if (!global.mobile) {
                const gridBottom = cols => {
                    let gy = spacing - height - internalSpacing + 5 + 46, tick = cols, branch = -1;
                    for (const u of gui.upgrades) {
                        if (tick === cols || u[0] != branch) {
                            gy += height + internalSpacing;
                            if (u[0] != branch && u[1] != "undefined" && String(u[1]).length > 0) gy += 3 * internalSpacing;
                            branch = u[0];
                            tick = 0;
                        }
                        tick++;
                    }
                    return gy + height + internalSpacing - 5 + 19.1 + 6;
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

            let x = glide * 2 * spacing + spacing + 5;
            
            let y = spacing - height - internalSpacing + 5 + 46;
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

            for (let i = 0; i < gui.upgrades.length; i++) {
                let upgrade = gui.upgrades[i];
                let upgradeBranch = upgrade[0];
                let upgradeBranchLabel = upgrade[1] == "undefined" ? "" : upgrade[1];
                let model = upgrade[2];

                if (ticker === global.columnCount || upgradeBranch != lastBranch) {
                    x = xStart;
                    y += height + internalSpacing;
                    if (upgradeBranch != lastBranch) {
                        if (upgradeBranchLabel.length > 0) {
                            drawText(" " + upgradeBranchLabel, xStart, y + internalSpacing * 2, internalSpacing * 2.3, color.guiwhite, "left", false);
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

                drawEntityIcon(model, x, y, len, height, 1, upgradeSpin, 0.6, colorIndex++, !global.mobile ? upgradeKey : false, !global.mobile ? upgradeNum == upgradeHoverIndex : false);

                ticker++;
                upgradeNum++;
            }

            let h = 19.1,
                textScale = h - 6,
                msg = "Don't Upgrade",
                m = measureText(msg, textScale),
                buttonX = initialX + (rowWidth + len - initialX) / 2,
                buttonY = initialY + height + internalSpacing - 5;
            // the quest card sits below this edge while the tiles are on screen
            if (glide > -0.5) {
                global.upgradeBoxBottom = buttonY + h + 6;
                global.upgradeBoxTop = gridTop;
                global.upgradeBoxRight = gridRight;
            }

            // Tutorial: declining is not a choice a lesson offers - and the
            // decline only clears the menu locally, so the evolve step would
            // stall on an empty box the server never repopulates.
            if (!global.tutorialMode) drawButton(buttonX, buttonY, m, h, 1, "rect", msg, textScale - 3.3, false, false, false, true, "skipUpgrades", clickableRatio, 0);

            if (gui.dailyTank && gui.dailyTank.tank) {
                let image = util.requestEntityImage(gui.dailyTank.tank, gui.color);
                let hover = global.clickables.dailyTankUpgrade.check({ x: global.mouse.x, y: global.mouse.y });
                image.upgradeColor = "36 0 1 0 false";
                drawEntityIcon(image, xStart, initialY + height + internalSpacing + 50, len, height, 1, upgradeSpin, 0.4, 10, false, hover);
                drawText("Daily Tank!", xStart + 50, initialY + height + internalSpacing + 67, 12, gameDraw.getColor(36), "center");
                global.clickables.dailyTankUpgrade.set(xStart * clickableRatio, (initialY + height + internalSpacing + 50) * clickableRatio, len * clickableRatio, height * clickableRatio);
                gui.dailyTank.ads && drawButton(xStart + 50, initialY + height + internalSpacing + 160, m, h, 1, "rect", "Watch An Ad", textScale - 3.3, false, false, false, true, "dailyTankAd", clickableRatio, false);
            }

            if (upgradeHoverIndex > -1 && upgradeHoverIndex < gui.upgrades.length && !global.mobile) {
                let picture = gui.upgrades[upgradeHoverIndex][2];
                if (picture.upgradeTooltip.length > 0) {
                    let boxWidth = measureText(picture.name, alcoveSize / 10),
                        boxX = global.mouse.x * global.screenWidth / global.canvas.width + 2,
                        boxY = global.mouse.y * global.screenHeight / global.canvas.height + 2,
                        boxPadding = 6,
                        splitTooltip = picture.upgradeTooltip.split("\n"),
                        textY = boxY + boxPadding + alcoveSize / 10;

                    for (let line of splitTooltip) boxWidth = Math.max(boxWidth, measureText(line, alcoveSize / 15));

                    gameDraw.setColor(ctx[2], color.dgrey);
                    ctx[2].lineWidth /= 1.5;
                    drawGuiRect(boxX, boxY, boxWidth + boxPadding * 3, alcoveSize * (splitTooltip.length + 1) / 10 + boxPadding * 3, false);
                    drawGuiRect(boxX, boxY, boxWidth + boxPadding * 3, alcoveSize * (splitTooltip.length + 1) / 10 + boxPadding * 3, true);
                    ctx[2].lineWidth *= 1.5;
                    drawText(picture.name, boxX + boxPadding * 1.5, textY, alcoveSize / 10, color.guiwhite);

                    for (let t of splitTooltip) {
                        textY += boxPadding + alcoveSize / 15
                        drawText(t, boxX + boxPadding * 1.5, textY, alcoveSize / 15, color.guiwhite);
                    }
                }
            }
        } else {
            global.canUpgrade = false;
            upgradeMenu.force(0);
            global.clickables.upgrade.hide();
            global.clickables.skipUpgrades.hide();
        }
    }

    function drawMobileJoysticks() {

        let radius = Math.min(
            global.mobileStatus.useBigJoysticks ? global.screenWidth * 0.8 : global.screenWidth * 0.6,
            global.mobileStatus.useBigJoysticks ? global.screenHeight * 0.16 : global.screenHeight * 0.12
        );

        ctx[2].globalAlpha = 0.3;
        ctx[2].fillStyle = "#ffffff";
        ctx[2].beginPath();
        ctx[2].arc(
            (global.screenWidth * 1) / 6,
            (global.screenHeight * 2) / 3,
            radius,
            0,
            2 * Math.PI
        );
        ctx[2].arc(
            (global.screenWidth * 5) / 6,
            (global.screenHeight * 2) / 3,
            radius,
            0,
            2 * Math.PI
        );
        ctx[2].fill();
        ctx[2].globalAlpha = 0.5;
        ctx[2].fillStyle = "#ffffff";
        ctx[2].beginPath();
        if (global.mobileStatus.showJoysticks && global.canvas.movementTouchPos) {
            ctx[2].arc(
                global.canvas.movementTouchPos.x + (global.screenWidth * 1) / 6,
                global.canvas.movementTouchPos.y + (global.screenHeight * 2) / 3,
                radius / 2.5,
                0,
                2 * Math.PI
            );
            ctx[2].arc(
                global.canvas.controlTouchPos.x + (global.screenWidth * 5) / 6,
                global.canvas.controlTouchPos.y + (global.screenHeight * 2) / 3,
                radius / 2.5,
                0,
                2 * Math.PI
            );
        }
        ctx[2].fill();

        drawCrosshair();
    };

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

    function drawMobileButtons(spacing, alcoveSize) {
        let makeButton = (index, x, y, width, height, text, clickableRatio) => {

            global.clickables.mobileButtons.place(index, x * clickableRatio, y * clickableRatio, width * clickableRatio, height * clickableRatio);

            ctx[2].globalAlpha = 0.5;
            ctx[2].fillStyle = color.grey;
            drawGuiRect(x, y, width, height);
            ctx[2].globalAlpha = 0.1;
            ctx[2].fillStyle = color.black;
            drawGuiRect(x, y + height * 0.6, width, height * 0.4);
            ctx[2].globalAlpha = 1;

            drawText(text, x + width / 2, y + height * 0.5, height * 0.6, color.guiwhite, "center", true);

            ctx[2].strokeStyle = color.black;
            ctx[2].lineWidth = 3;
            drawGuiRect(x, y, width, height, true);
        }

        let makeButtons = (buttons, startX, startY, baseSize, clickableRatio, spacing) => {
            let x = startX, y = startY, index = 0;

            for (let row = 0; row < buttons.length; row++) {
                for (let col = 0; col < buttons[row].length; col++) {
                    makeButton(buttons[row][col][3] ?? index, x, y, baseSize * (buttons[row][col][1] ?? 1), baseSize * (buttons[row][col][2] ?? 1), buttons[row][col][0], clickableRatio);
                    x += baseSize * (buttons[row][col][1] ?? 1) + spacing;
                    index++;
                }

                x = startX;
                y += Math.max(...buttons[row].map(b => baseSize * (b[2] ?? 1))) + spacing;
            }
        }
        if (global.clickables.mobileButtons.active == null) global.clickables.mobileButtons.active = false;
        if (global.clickables.mobileButtons.altFire == null) global.clickables.mobileButtons.altFire = false;

        global.clickables.mobileButtons.hide();

        mobileUpgradeGlide.set(0 + (global.canUpgrade || global.upgradeHover));

        let clickableRatio = global.canvas.height / global.screenHeight / global.ratio;
        let upgradeColumns = Math.ceil(gui.upgrades.length / 9);
        let yOffset = 0;
        if (global.mobile) {
            yOffset += global.canUpgrade ? (alcoveSize / 1.5 ) * mobileUpgradeGlide.get() * upgradeColumns / 1.5 + spacing * (upgradeColumns + 1.55) + -17.5 : 0;
            yOffset += global.canSkill || global.showSkill ? statMenu.get() * alcoveSize / 2.6 + spacing / 0.75 : 0;
        }
        let buttons;
        let baseSize = (alcoveSize - spacing * 2) / 3;

        if (global.mobile) {
            buttons = global.clickables.mobileButtons.active ? [
                [[global.clickables.mobileButtons.active ? "-" : "+"], [`Alt ${global.clickables.mobileButtons.altFire ? "Manual" : "Disabled"}`, 6], [`${!document.fullscreenElement ? "Full" : "Exit Full"} Screen`, 5]],
                [["Autofire", 3.5], ["Reverse", 3.5], ["Self-Destruct", 5]],
                [["Autospin", 3.5], ["Override", 3.5], ["Level Up", 5]],
                [["Action", 3.5], ["Special", 3.5], ["Chat", 5]],
            ] : [
                [[global.clickables.mobileButtons.active ? "-" : "+"]],
            ];
        }
        if (global.clickables.mobileButtons.altFire) buttons.push([["\u2756", 2, 2]]);

        let len = alcoveSize;
        makeButtons(buttons, len + spacing * 2, yOffset + spacing, baseSize, clickableRatio, spacing);
    }

    function drawMobileSkillUpgrades(spacing, alcoveSize) {
        global.canSkill = gui.points > 0 && gui.skills.some(s => s.amount < s.cap) && !global.canUpgrade;
        global.showSkill = !global.canUpgrade && !global.canSkill && global.died;
        statMenu.set(global.canSkill || global.showSkill || global.disconnected ? 1 : 0);
        let n = statMenu.get();
        global.clickables.stat.hide();
        let t = alcoveSize / 2,
            q = alcoveSize / 3,
            x = 2 * n * spacing - spacing,
            statNames,
            clickableRatio = global.canvas.height / global.screenHeight / global.ratio;

            try {
                statNames = gui.getStatNames(global.mockups[parseInt(gui.type.split("-")[0])].statnames);
            } catch (e) {
                statNames = gui.getStatNames(global.missingno[0].statnames);
            }

        if (global.canSkill || global.showSkill) {
            for (let i = 0; i < gui.skills.length; i++) {
                let skill = gui.skills[i],
                    softcap = skill.softcap;

                if (softcap <= 0) continue;

                const mStat = i === 10 ? 10 : 9 - i;
                let amount = skill.amount,
                    skillColor = color[skill.color],
                    cap = skill.cap,
                    name = statNames[mStat].split(/\s+/),
                    halfNameLength = Math.floor(name.length / 2),
                    [name1, name2] = name.length === 1 ? [name[0], null] : [name.slice(0, halfNameLength).join(" "), name.slice(halfNameLength).join(" ")];

                ctx[2].globalAlpha = 0.5;
                ctx[2].fillStyle = skillColor;
                drawGuiRect(x, spacing, t, 2 * q / 3);

                ctx[2].globalAlpha = 0.1;
                ctx[2].fillStyle = color.black;
                drawGuiRect(x, spacing + q * 2 / 3 * 2 / 3, t, q * 2 / 3 / 3);

                ctx[2].globalAlpha = 1;
                ctx[2].fillStyle = color.guiwhite;
                drawGuiRect(x, spacing + q * 2 / 3, t, q / 3);

                ctx[2].fillStyle = skillColor;
                drawGuiRect(x, spacing + q * 2 / 3, t * amount / softcap, q / 3);

                ctx[2].strokeStyle = color.black;
                ctx[2].lineWidth = 1;
                for (let j = 1; j < cap; j++) {
                    let width = x + j / softcap * t;
                    drawGuiLine(width, spacing + q * 2 / 3, width, spacing + q);
                }

                cap === 0 || !gui.points || softcap !== cap && amount === softcap || global.clickables.stat.place(mStat, x * clickableRatio, spacing * clickableRatio, t * clickableRatio, q * clickableRatio);

                if (name2) {
                    drawText(name2, x + t / 2, spacing + q * 0.55, q / 5, color.guiwhite, "center");
                    drawText(name1, x + t / 2, spacing + q * 0.3, q / 5, color.guiwhite, "center");
                } else {
                    drawText(name1, x + t / 2, spacing + q * 0.425, q / 5, color.guiwhite, "center");
                }

                if (amount > 0) {
                    drawText(`+${amount}`, x + t / 2, spacing + q * 1.3, q / 4, skillColor, "center");
                }

                ctx[2].strokeStyle = color.black;
                ctx[2].globalAlpha = 1;
                ctx[2].lineWidth = 3;
                drawGuiLine(x, spacing + q * 2 / 3, x + t, spacing + q * 2 / 3);
                drawGuiRect(x, spacing, t, q, true);

                x += n * (t + 14);
            }

            if (gui.points > 1) {
                drawText(`x${gui.points}`, x, spacing + 20, 20, color.guiwhite, "left");
            }
        }
    };

    let ichatInput = 0;
    function drawChatInput(x, y, instance, ratio, isize) {
        if (global.showChat === 0 || !global.canvas.chatBox) return;
        if (instance.id === gui.playerid) {
            let size = isize * ratio,
                g = Math.max(20, size);

            if (!global.showChat) {
                if (ichatInput === 0) chatInput.force(0);
                if (ichatInput >= 200) return;
                ichatInput++;
            } else if (ichatInput) {
                ichatInput = 0;
                chatInput.force(0);
            }
            if (global.died && global.showChat) {
                global.canvas.chatBox.blur();
                global.canvas.cv.focus();
                global.showChat = false;
                if (global.canvas.chatBox.value) global.canvas.chatBox.value = "";
            }

            chatInput.set(1);
            global.showChatGlide = global.showChat ? chatInput.get() : 1 - chatInput.get();
            x += global.screenWidth / 2;
            y += global.screenHeight / 2;
            let boxLengthHalf = (10.49 * g) / 2;
            global.canvas.chatBox.loadedProperly = true;

            global.canvas.chatBox.style.color = color.black;
            global.canvas.chatBox.style.backgroundColor = color.guiwhite;
            global.canvas.chatBox.style.borderColor = color.black;
            global.canvas.chatBox.style.borderWidth = 0.1 * g + 'px';
            global.canvas.chatBox.style.opacity = global.showChatGlide;
            global.canvas.chatBox.style.width = (boxLengthHalf * 2 + 0.75 * g) / global.screenWidth * 100 + `%`;
            global.canvas.chatBox.style.height = 0.95 * g + `px`;
            global.canvas.chatBox.style.left = (x - boxLengthHalf - 0.75 * g / 2) / global.screenWidth * 100 + `%`;
            global.canvas.chatBox.style.top =  (y - g * (2.26) - 0.55 * g) / global.screenWidth * window.innerWidth + `px`;

            global.canvas.chatInput.style.opacity = global.showChatGlide;
            global.canvas.chatInput.style["font-size"] = 0.5 * g + 'px';
            global.canvas.chatInput.style.color = color.black;
            global.canvas.chatInput.style.width = (boxLengthHalf * 2 + 0.35 * g) / global.screenWidth * 100 + `%`;
            global.canvas.chatInput.style.height = 0.95 * g + `px`;
            global.canvas.chatInput.style.left = (x - boxLengthHalf - 0.35 * g / 2) / global.screenWidth * 100 + `%`;
            global.canvas.chatInput.style.top =  (y - g * (2.26) - 0.55 * g) / global.screenWidth * window.innerWidth + `px`;
            if (global.canvas.chatBox && global.showChatGlide < 0.005 && !global.showChat) chatInput.force(0), global.canvas.chatInput.remove(), global.canvas.chatBox.remove(), global.canvas.chatBox = false;
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
        drawText("Watch this ad to get your reward!", x + wwidth / 2, y + height + 34, 20, "#fff", "center", false, 1, false);
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
            txt = "Succumbed to";
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
        : "Bank your gemdust at the vault, you drop most of it when you die";

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
    // A single framed panel in the same flat, dark-bordered language as the
    // vault and the outposts: portrait on the left in its own recess, run
    // summary on the right. The old layout drew the tank and its name at
    // roughly the same x as the stat column, so a wide tank sat on top of the
    // text - everything now lives in reserved columns that cannot collide.
    // "1h 04m", "2m 06s", "48s" - the spelled-out form ran past the tile
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
        c.font = "bold " + s2 + "px Rubik, Ubuntu";
        let w = c.measureText(txt).width;
        while (w > maxW && s2 > 8) {
            s2 -= 0.5;
            c.font = "bold " + s2 + "px Rubik, Ubuntu";
            w = c.measureText(txt).width;
        }
        drawText(txt, cx, cy, s2, col, "center");
    };
    const deathStat = (label, value, iconKind, bx, by, bw, alpha) => {
        const c = ctx[2];
        c.save();
        c.globalAlpha = alpha;
        roundRectPath(c, bx, by, bw, 40, 7);
        c.fillStyle = "rgba(255,255,255,0.045)";
        c.fill();
        c.lineWidth = 2;
        c.strokeStyle = "rgba(0,0,0,0.45)";
        c.stroke();
        c.restore();
        if (iconKind) drawDeathIcon(iconKind, bx + 20, by + 20, 17, alpha);
        // shrink to fit the box: long labels and six-figure values both happen
        const maxW = bw - 50;
        let ls = 11; while (ls > 7.5 && measureText(label, ls) > maxW) ls -= 0.5;
        let vs = 16; while (vs > 9 && measureText(value, vs) > maxW) vs -= 0.5;
        drawText(label, bx + 40, by + 12, ls, color.grey, "left");
        drawText(value, bx + 40, by + 31, vs, color.guiwhite, "left");
    };
    const roundRectPath = (c, x, y, w, h, r) => {
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
        if (global.GUIStatus.renderGUI && global.GUIStatus.renderPlayerBars) {
            drawLeaderArrow();
            drawEnemyPings();
        }
        try { tutorial.drawIndicators(); } catch (e) { }
    };

    const gameDrawDead = () => {
        // Killer cam: clean 3s on the killer, no panel yet. The handoff guard
        // covers the gap between the cam expiring and its timer firing
        // (timers can land late / throttled), so the classic screen never
        // flashes a frame before the raid panel takes over.
        const killerCamLive = global.royaleKillerCamUntil && performance.now() < global.royaleKillerCamUntil;
        if (global.died && (killerCamLive || (!global.royaleDied && global.royaleSpectating))) {
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
        c.save();
        roundRectPath(c, px, py, PW, PH, 16);
        c.fillStyle = "rgba(16,17,22,0.93)";
        c.fill();
        c.lineWidth = 4;
        c.strokeStyle = "#111318";
        c.stroke();
        c.lineWidth = 1.5;
        c.strokeStyle = "rgba(255,215,94,0.22)";
        c.stroke();
        c.restore();

        drawText("YOU DIED", cx, py + 34, 27, color.gold, "center");

        // ── left column: portrait recess + tank name ──────────────────────
        const COLW = 176;
        const lx = px + 22, ly = py + 62;
        c.save();
        roundRectPath(c, lx, ly, COLW, 210, 12);
        c.fillStyle = "rgba(255,255,255,0.04)";
        c.fill();
        c.lineWidth = 2;
        c.strokeStyle = "rgba(0,0,0,0.5)";
        c.stroke();
        c.restore();
        try {
            const picture = util.getEntityImageFromMockup(gui.type, gui.color);
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
        // Names run to 24 characters, which overflows the column at full size,
        // so shrink to fit rather than spilling out of the panel.
        fitText(name === "" ? "You" : name, lx + COLW / 2, ly + 198, 16, COLW - 16, color.guiwhite);

        // ── right column: the run in numbers ──────────────────────────────
        const rx = lx + COLW + 18;
        const rw = px + PW - 22 - rx;
        let ry = py + 62;

        // headline score
        c.save();
        c.globalAlpha = global.lerp(0, 1, glide);
        roundRectPath(c, rx, ry, rw, 58, 9);
        c.fillStyle = "rgba(255,215,94,0.10)";
        c.fill();
        c.lineWidth = 2;
        c.strokeStyle = "rgba(255,215,94,0.35)";
        c.stroke();
        c.restore();
        drawText("SCORE", rx + 14, ry + 15, 11, color.grey, "left");
        drawText(util.formatLargeNumber(Math.round(global.finalScore.get())),
                 rx + 14, ry + 41, 24, color.gold, "left");
        ry += 68;

        // Score is carried plus banked, so both are shown in their own right -
        // the old screen labelled the combined figure "banked", which was wrong.
        const half = (rw - 8) / 2;
        const rows = [
            ["CARRIED AT DEATH", String(global.finalCarried | 0), "gem"],
            ["BANKED", String(global.finalBanked | 0), "gem"],
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
        const killedBy = cause === "rock" ? "Crushed by the living rock"
            : cause === "base" ? "Shot down by the enemy base"
            : global.finalKillers.length
                ? "Taken down by " + global.finalKillers.join(" and ")
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
                    ? "(you may respawn in " + global.respawnTimeout + " Secon" + `${global.respawnTimeout <= 1 ? 'd' : 'ds'}` + ")"
                    : "(you cannot respawn)")
                : global.mobile ? "(tap to respawn)"
                : global.gamepadMode ? "(Press RT or R2 button to respawn)" : '',
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
    // The raid's only death screen: gold-framed, full run stats, auto respawn
    // (paused during the final-storm spawn lock). Death is a tax, not an end.
    const gameDrawDeadRoyale = () => {
        let glide = global.deathAnimation.get();
        // The whole card fades in first (panelA), then the staggered rows
        // play on top. Backdrop ramps from nothing - no more 0.32 dim pop.
        const panelA = global.lerp(0, 0.7, glide);
        const rise = (1 - panelA) * 18;
        clearScreen(color.black, 0.62 * global.lerp(0, 0.6, glide), ctx[2]);
        const c = ctx[2];
        const cx = global.screenWidth / 2;
        const you = global.royale.you || {};
        const place = (you.place || global.royale.place) | 0;
        const score = (you.score != null ? you.score : global.royale.youScore) | 0;
        const PW = Math.min(620, global.screenWidth - 40);
        const PH = 474;
        const px = cx - PW / 2;
        const py = Math.max(12, global.screenHeight / 2 - PH / 2 - 6) + rise;
        // panel: dark card, black keyline, gold raid frame
        c.save();
        c.globalAlpha = panelA;
        roundRectPath(c, px, py, PW, PH, 16);
        c.fillStyle = "rgba(16,17,22,0.94)";
        c.fill();
        c.lineWidth = 4;
        c.strokeStyle = "#111318";
        c.stroke();
        c.lineWidth = 2;
        c.strokeStyle = "rgba(255,215,94,0.75)";
        c.stroke();
        c.restore();

        drawText("YOU DIED", cx, py + 34, 26 * (0.8 + 0.2 * panelA), color.gold, "center", true, panelA);
        drawText("The raid keeps going without you for a bit", cx, py + 54, 11, color.grey, "center", true, panelA);

        // headline score + place
        const bx = px + 22, bw = PW - 44;
        c.save();
        c.globalAlpha = global.lerp(0, 1, glide) * (0.25 + 0.75 * panelA);
        roundRectPath(c, bx, py + 66, bw, 58, 9);
        c.fillStyle = "rgba(255,215,94,0.10)";
        c.fill();
        c.lineWidth = 2;
        c.strokeStyle = "rgba(255,215,94,0.35)";
        c.stroke();
        c.restore();
        drawText("RAID SCORE", bx + 14, py + 79, 11, color.grey, "left", true, panelA);
        drawText(util.formatLargeNumber(Math.round(score)), bx + 14, py + 105, 24, color.gold, "left", true, panelA);
        if (place > 0) drawText("#" + place, bx + bw - 14, py + 105, 24, color.guiwhite, "right", true, panelA);

        // the run in numbers: kept vs lost is the whole raid economy
        const half = (bw - 8) / 2;
        const rows = [
            ["BANKED (KEPT)", util.formatLargeNumber((you.banked != null ? you.banked : global.finalBanked) | 0), "gem"],
            ["SATCHEL LOST", util.formatLargeNumber(global.finalCarried | 0), "gem"],
            ["KILLS", String((you.kills != null ? you.kills : Math.round(global.finalKills[0].get())) | 0), "combat"],
            ["CARRIED (50% PTS)", util.formatLargeNumber((you.carried != null ? you.carried : 0) | 0), "gem"],
            ["ROCKS MINED", String(global.finalRocks | 0), "pickaxe"],
            ["SURVIVED", compactTime(global.finalLifetime.get()), "clock"],
        ];
        const gy = py + 134;
        for (let i = 0; i < rows.length; i++) {
            const col = i % 2, row = (i / 2) | 0;
            const a = global.lerp(1 + i * 0.2, 1.25 + i * 0.2, glide);
            deathStat(rows[i][0], rows[i][1], rows[i][2],
                      bx + col * (half + 8), gy + row * 46, half, a);
        }

        const cause = global.finalCause || "";
        const killedBy = cause === "rock" ? "Crushed by the living rock"
            : cause === "storm" ? "Lost in the storm"
            : global.finalKillers.length
                ? "Taken down by " + global.finalKillers.join(" and ")
                : "Nobody finished you off";
        c.save();
        c.globalAlpha = global.lerp(2.4, 2.7, glide);
        drawText(killedBy, cx, gy + 3 * 46 + 14, 13, color.grey, "center");
        c.restore();
        const extras = [];
        if ((global.finalInsured | 0) > 0) extras.push("Your insurance saved " + util.formatLargeNumber(global.finalInsured | 0) + " of it");
        if ((global.finalStreak | 0) >= 3) extras.push("Your " + (global.finalStreak | 0) + " kill streak is over");
        if (global.finalDrillLost) extras.push("Your drill dropped a tier");
        drawText(extras.length ? extras.join(". ") + "." : "You dropped everything you were carrying, but your bank is safe.", cx, gy + 3 * 46 + 34, 12, extras.length ? color.gold : color.guiwhite, "center", true, panelA);

        const locked = !!(global.royale.lock && global.royale.at > 0);
        const waitMs = Math.max(0, (global.raidRespawnAt || 0) - performance.now());
        if (!locked && global.raidRespawnAt > 0 && waitMs <= 0 && !global.disconnected && !global.respawnPending) {
            try { global.canvas.respawn(); } catch { /* */ }
        }
        drawText(locked
                ? ("Final storm - no spawns for " + Math.max(0, global.royale.lockLeft | 0) + "s")
                : (waitMs > 0 ? ("Respawning in " + Math.ceil(waitMs / 1000) + "s") : "Respawning"),
                 cx, gy + 3 * 46 + 56, 14, color.gold, "center", true, panelA);
        global.clickables.royalePrev.hide();
        global.clickables.royaleNext.hide();
        global.clickables.royalePlay.hide();
        global.clickables.deathRespawn.hide();
        const by = py + PH - 46;
        const cr = global.canvas.height / global.screenHeight / global.ratio;
        const ga = global.lerp(3, 3.25, glide);
        // DOM Spectate/Home live below the panel and take the clicks.
        if (typeof royaleDomBuilt !== "undefined" && royaleDomBuilt) return;
        if (!global.disconnected) {
            drawButton(cx - 90, by, 150, 32, ga, "rect", "Spectate", 15, false, false, false, true, "royaleSpectate", cr, 0);
            drawButton(cx + 90, by, 150, 32, ga, "rect", "Home", 15, false, false, false, true, "exitGame", cr, 0);
        }
    };
    const drawRoyaleSpectateBar = () => {
        const sw = global.screenWidth;
        const barW = Math.min(620, sw - 40);
        const x = (sw - barW) / 2;
        const y = 10;
        spectateBarBottom = y + 58;
        const h = 36;
        const c = ctx[2];
        c.save();
        c.fillStyle = "rgba(16,17,22,0.92)";
        c.fillRect(x, y, barW, h);
        c.lineWidth = 3;
        c.strokeStyle = color.black;
        c.strokeRect(x, y, barW, h);
        c.restore();
        // Spectating is manual: Prev/Next hop, Play rejoins (queues through
        // the 15s tax), Home exits. No auto-rejoin while watching.
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
        const label = locked
            ? ("Final storm " + lockLeft + "s" + (place > 0 ? ("  #" + place) : "") + "  ·  no respawns")
            : queued ? "Dropping in..."
            : ("Spectating" + (place > 0 ? ("  #" + place) : "") +
               (global.died ? (waitMs > 0 ? ("  ·  Rejoin in " + Math.ceil(waitMs / 1000) + "s") : "  ·  Rejoining") : ""));
        fitText(label, x + barW / 2, y + 24, 14, Math.max(60, barW - 4 * bw - 60), color.guiwhite);
        // DOM buttons (Prev/Next/Play/Home) sit just below this bar and take
        // the clicks. Skip the canvas twins so there is one working set.
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
    const drawGameplay = (tick, ratio) => {

        global.metrics.rendertimes++;
        global.GRAPHDATA = 0;
        let tickMotion = lasttick ? tick - lasttick : null;
        lasttick = tick;
        let motion = compensation();
        motion.set();
        global.GRAPHDATA = motion.getPrediction();

        let playerx = global.player.animX.get(tick);
        let playery = global.player.animY.get(tick);
        if (global._specGlide) {
            // Spectate glide owns the camera: the chase below would drag it
            // back toward the corpse every frame and end in a snap. The glide
            // retargets live from server updates, then hands off smoothly.
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
        } else if (config.graphical.lerpAnimations) {
            // lerp toward the INTERPOLATED position - chasing raw 30Hz
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

        if (!global.mobile && !global.gamepadMode) calculateTarget();

        let spacing = 20;

        drawFloor(px, py, ratio, tick);
        drawEntities(px, py, ratio, tick, spacing);
        drawOutpostLabels(px, py, ratio);
        drawRoyaleWorldMarkers(px, py, ratio);
        drawFx(px, py, ratio);
        // Same camera transform the entities just used, so the numbers sit
        // exactly over the bodies that took the hit. Drawn before the HUD so
        // the HUD always wins the overlap.
        drawDamageNumbers(px, py, ratio);
        drawKillBanners(px, py, ratio);
        // World-anchored tutorial markers: drawn here so they share the exact
        // camera transform the entities just used, and sit above the world but
        // below the GUI. (The screen-space tutorial HUD draws later, in hook().)
        tutorial.drawWorld(px, py, ratio);
    };

    const drawGUI = (tick, scaleRatio) => {
        scaleScreenRatio(scaleRatio, true);
        let ratio = util.getScreenRatio();

        let spacing = 20;
        // Desktop: 200 UI units, so the upgrade tiles, stat bars, kit box and
        // minimap follow the UI Scale setting like everything else. It used
        // to be 200 device pixels, which made that column huge on small or
        // Low Resolution screens and never shrank it on Small. The mobile
        // layout is tuned around the old sizing, so it keeps it.
        let alcoveSize = global.mobile ? 200 / ratio : 200;
        gui.__s.update();
        let lb = leaderboard.get();
        let max = lb.max;
        global.canSkill = !!gui.points && !global.showTree && !global.pullSkillBar;
        let shake = false;
        if (config.graphical.shakeProperties.UIShake.shakeStartTime !== -1) shake = applyScreenShake("gui", true);
        if (shake) ctx[2].translate(shake.dx, shake.dy);
        if (global.mobile) {
            drawMobileJoysticks();
            drawMobileButtons(spacing, alcoveSize);
        }
        if (global.gamepadMode) drawCrosshair();
        if (!global.GUIStatus.renderGUI && global.gameStart) {
            drawText("GUI hidden. Turn it on under Settings > Graphics.", global.screenWidth / 2, global.screenHeight - 24, 12, color.grey, "center");
        }
        if (global.GUIStatus.renderGUI) {
            updateMapSmoothing();
            drawLowHealthVignette();
            drawSatchelDanger();
            drawTeamBankBar();
            drawRoyaleHUD();
            drawKillCallouts();
            if (global.royaleSpectating) drawRoyaleSpectateBar();
            try { updateRoyaleDomButtons(); } catch { /* */ }
            drawRoyaleBoard();
            drawMessages(spacing, alcoveSize);
            drawMilestones();
            drawWarBanner();
            if (global.GUIStatus.renderUpgrades) drawSkillBars(spacing, alcoveSize);
            if (global.GUIStatus.renderPlayerBars) {
                drawSelfInfo(max);
                drawGemPopups();   // +N numbers + pickup ring over the tank
                drawMineCombo();    // mining chain meter under the tank
                drawKitBox(spacing, alcoveSize);
                drawVaultUI();
                drawShopUI();
                drawTooltips();
            }
            drawMinimapAndDebug(spacing, alcoveSize, global.GRAPHDATA, tick);
            // Tutorial: a leaderboard is competition furniture; the server
            // sends an empty one there anyway (nobody is leaderboardable).
            if (global.GUIStatus.renderLeaderboard && !global.tutorialMode && !royaleActive()) drawLeaderboard(spacing, alcoveSize, max);
            if (global.GUIStatus.renderUpgrades) drawAvailableUpgrades(spacing, alcoveSize);
            // leader arrow + enemy pings moved to drawTopIndicators(), which
            // runs at the very end of the frame - here they were being covered
            // by the minimap, leaderboard, big map and upgrade tree
        } else if (global.GUIStatus.renderUpgrades) drawAvailableUpgrades(spacing, alcoveSize);
        if (global.showTree) {
            drawUpgradeTree(spacing, alcoveSize);
        }
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
                cv && cv.socket && cv.socket.talk('RS', 2);
            } else if (kind === "play") {
                cv && cv.respawn && cv.respawn();
            } else if (kind === "home") {
                global.exit && global.exit();
            }
        } catch { /* */ }
        try {
            const cv = document.getElementById("gameCanvas");
            if (cv && global.gameStart) cv.focus();
        } catch { /* */ }
    }
    function royaleDomBtn(id, text) {
        const b = document.createElement("button");
        b.id = id;
        b.textContent = text;
        b.style.height = "38px";
        b.style.padding = "0 14px";
        b.style.borderRadius = "10px";
        b.style.border = "2px solid #000";
        b.style.background = "#16171d";
        b.style.color = "#f2ecdc";
        b.style.cursor = "pointer";
        b.style.font = "700 12px Rubik, Ubuntu, sans-serif";
        b.style.boxShadow = "0 2px 0 rgba(0,0,0,.4)";
        return b;
    }
    function getRoyaleDomButtons() {
        if (royaleDomBuilt) return;
        royaleDomBuilt = true;
        const spec = document.createElement("div");
        spec.id = "royaleSpecDom";
        spec.style.cssText = "position:fixed;top:52px;left:50%;transform:translateX(-50%);z-index:31;display:none;gap:8px;align-items:center;";
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
        dead.style.cssText = "position:fixed;left:50%;bottom:8%;transform:translateX(-50%);z-index:31;display:none;gap:8px;align-items:center;";
        const sp = royaleDomBtn("royaleDomSpectate", "Spectate");
        const homeD = royaleDomBtn("royaleDomHomeDead", "Home");
        sp.onclick = () => royaleDomAct("spectate");
        homeD.onclick = () => royaleDomAct("home");
        dead.append(sp, homeD);
        document.body.appendChild(dead);
        try { updateRoyaleDomButtons(); } catch { /* */ }
    }
    function updateRoyaleDomButtons() {
        getRoyaleDomButtons();
        const spec = document.getElementById("royaleSpecDom");
        const dead = document.getElementById("royaleDeadDom");
        if (!spec || !dead) return;
        const inGame = !!(global.gameStart && !global.disconnected);
        if (global.royaleKillerCamUntil && performance.now() < global.royaleKillerCamUntil) {
            spec.style.display = "none";
            dead.style.display = "none";
            return;
        }
        const spectating = !!(inGame && global.royaleSpectating);
        const deadShow = !!(inGame && global.died && global.royaleDied && !global.royaleSpectating);
        spec.style.display = spectating ? "flex" : "none";
        dead.style.display = deadShow ? "flex" : "none";
        const play = document.getElementById("royaleDomPlay");
        if (play) {
            const locked = !!(global.royale && global.royale.lock && global.royale.at > 0);
            const waitMs = Math.max(0, (global.raidRespawnAt || 0) - performance.now());
            let label = "Play";
            if (locked) label = Math.max(0, global.royale.lockLeft | 0) + "s";
            else if (global.respawnPending) label = "Wait";
            else if (global.died && waitMs > 0) label = "Play (" + Math.ceil(waitMs / 1000) + "s)";
            play.textContent = label;
            play.style.opacity = (!global.died || locked || global.respawnPending) ? "0.55" : "1";
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
        
        const chatBtn = document.createElement("button");
        chatBtn.id = "ingameChatModeBtn";
        chatBtn.textContent = "Global Chat";
        chatBtn.onclick = () => {
            global.chatMode = global.chatMode === "team" ? "global" : "team";
            chatBtn.textContent = global.chatMode === "team" ? "Team Chat" : "Global Chat";
            chatBtn.blur();
            const cv = document.getElementById("gameCanvas");
            if (cv && global.gameStart) cv.focus();
        };
        document.body.appendChild(chatBtn);

        // Raid spectate/death controls as DOM buttons, same as the gear and
        // Global Chat toggle. Canvas clickables kept missing (map drag eats
        // mousedown, auto-respawn cleared died before mouseup), so Prev goes
        // to the previous spectate target, Next to the next, Play rejoins,
        // Home exits. No canvas coordinate math to drift.
        getRoyaleDomButtons();

        // The in-game "?" replay button is gone on purpose: the tutorial now
        // lives on its own server, so replaying it mid-match would mean
        // yanking a player out of a live fight. It is reachable from the
        // homepage Tutorial button instead.

        setInterval(() => {
            const show = (global.gameStart && !global.died && !global.disconnected) ? "flex" : "none";
            btn.style.display = show;
            chatBtn.style.display = show;
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

    let drawConnectingScreen = () => {
        let ratio = util.getScreenRatio();
        scaleScreenRatio(ratio, true);
        const locked = !!(global.royale && global.royale.lock && global.royale.at > 0);
        if (locked) {
            const left = Math.max(0, global.royale.lockLeft | 0);
            clearScreen(color.white, 1, ctx[2]);
            drawText("Final storm. No respawns for " + left + "s.", global.screenWidth / 2, global.screenHeight / 2, 22, color.guiwhite, "center");
            drawText("The raid keeps going. You drop back in when it lifts.", global.screenWidth / 2, global.screenHeight / 2 + 34, 15, color.gold, "center");
            return;
        }
        clearScreen(color.white, 1, ctx[2]);
        drawText("Connecting...", global.screenWidth / 2, global.screenHeight / 2, 30, color.guiwhite, "center");
        drawText(global.message, global.screenWidth / 2, global.screenHeight / 2 + 30, 15, color.lgreen, "center");
        drawText(global.tips, global.screenWidth / 2, global.screenHeight / 2 + 60, 15, color.guiwhite, "center");
    };

    const drawDisconnectedScreen = () => {
        let ratio = util.getScreenRatio();
        scaleScreenRatio(ratio, true);
        clearScreen(gameDraw.mixColors(color.red, color.guiblack, 0.3), global.gameStart ? 0.25 : 1, ctx[2]);
        drawText("Disconnected", global.screenWidth / 2, global.screenHeight / 2, 30, color.guiwhite, "center");
        if (global.message === '') global.message = 'The connection has closed. you may attempt to regain score or reload the game.';
        drawText(global.message, global.screenWidth / 2, global.screenHeight / 2 + 30, 15, color.orange, "center");
        lastPing = 0;
        drawButton(global.screenWidth / 2 - 80, global.screenHeight / 2 + 135, 130, 30, 1, "rect", "Back", 15, false, false, false, true, "exitGame", global.canvas.height / global.screenHeight / global.ratio, 0);
        drawButton(global.screenWidth / 2 + 80, global.screenHeight / 2 + 135, 130, 30, 1, "rect", "Reconnect", 15, false, false, false, true, "reconnect", global.canvas.height / global.screenHeight / global.ratio, 0);
    };

    const drawResyncScreen = () => {
        let ratio = util.getScreenRatio();
        scaleScreenRatio(ratio, true);
        clearScreen(gameDraw.mixColors(color.black, color.guiblack, 0.3), 0.25, ctx[2]);
        drawText("Out of sync!", global.screenWidth / 2, global.screenHeight / 2 - 10, 30, color.red, "center");
        drawText("The client is out of sync, please wait until this screen has disappeared.", global.screenWidth / 2, global.screenHeight / 2 + 40, 15, color.guiwhite, "center");
        drawText("The rendering has paused to prevent interuptions.", global.screenWidth / 2, global.screenHeight / 2 + 90, 15, color.guiwhite, "center");
    };

    const drawErrorScreen = () => {
        let ratio = util.getScreenRatio();
        scaleScreenRatio(ratio, true);
        clearScreen(gameDraw.mixColors(color.black, color.guiblack, 0.3), 0.25, ctx[2]);
        drawText("Client error detected!", global.screenWidth / 2, global.screenHeight / 2, 30, color.red, "center");
        drawText("If this is because of an entity, try to move away from it.", global.screenWidth / 2, global.screenHeight / 2 + 30, 15, color.guiwhite, "center");
        drawText("Check your browser's console logs and report whatever you see to the developers.", global.screenWidth / 2, global.screenHeight / 2 + 60, 15, color.guiwhite, "center");
    }
    let animationFrame =
    (!/Chrome\/8[4-6]\.0\.41([4-7][0-9]|8[0-3])\./.test(navigator.userAgent) &&
      window.requestAnimationFrame) ||
    ((a) => setTimeout(() => a(Date.now()), 1e3 / 60));
    function animloop(tick) {
        if (document.getElementById("gameAreaWrapper").style.display === "none") {
            setTimeout(() => animloop(Date.now()), 200);
            return;
        }
        animationFrame(animloop);
        renderFrame(tick);
    }
    // One frame of the game, separate from the scheduler so QA tooling can
    // step frames in a background tab where requestAnimationFrame is paused.
    window.dwRenderFrame = renderFrame;
    function renderFrame(tick) {
        // Hit-stop: hold the last frame for a beat when a rock is destroyed
        if (global.hitStop && Date.now() < global.hitStop) return;
        if (global.gameStart) {

            let fovtickMotion = fovlasttick ? tick - fovlasttick : null;
            fovlasttick = tick;
            let renderv = null == fovtickMotion ? 0 : config.graphical.slowerFOV ? 0.98 : 0.99 ** fovtickMotion;
            let renderfov = global.player.animv.get(tick);
            global.player.renderv = global.player.renderv * renderv + renderfov * (1 - renderv);

            global.renderingInfo.entities = 0;
            global.renderingInfo.turretEntities = 0;
            global.renderingInfo.entitiesWithName = 0;
        }

        var ratio = config.graphical.screenshotMode ? 2 : util.getRatio();

        gameDraw.reanimateColors();
        for (let context of ctx) {
            context.lineCap = "round";
            context.lineJoin = "round";
            // The contexts stay scaled to the UI ratio between frames. When
            // the canvas is smaller than the UI scale (small window, Low
            // Resolution mode) a clearRect in scaled units only wipes part
            // of the canvas and the GUI layer smears old text over new. Clear
            // in device pixels, then put the scale back.
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
        if (global.GUIStatus.fullHDMode) ctx[2].translate(0.5, 0.5);
        let p = performance.now();
        try {
            drawGameplay(tick, ratio);
            drawGUI(tick, util.getScreenRatio());
            tutorial.hook();
            drawTopIndicators();
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
                // The satchel heartbeat is a continuous state, not an event,
                // so it has to be driven every frame like rammer movement is.
                const sg = global.gems;
                gameSound.satchelTension(sg && sg.cap > 0
                    ? Math.min(1, (sg.carried || 0) / sg.cap) : 0);
            } else {
                gameSound.rammerMove(0);
                gameSound.satchelTension(0);
            }
            if (global.gameConnecting && !global.disconnected) {
                drawConnectingScreen();
            };
            if (global.died) {
                gameDrawDead();
            }
            if (global.showBigMap) drawBigMap();
            if (isNaN(global.time)) drawResyncScreen();
            if (global.disconnected) {
                drawDisconnectedScreen();
            }
            if (global.dailyTankAd.renderUI) drawAdScreen();
            drawOptionsMenu(tick, 20, util.getScreenRatio());
            if (global.GUIStatus.fullHDMode) ctx[2].translate(-0.5, -0.5);

        } catch (e) {

            drawErrorScreen();
            if (global.GUIStatus.fullHDMode) ctx[2].translate(-0.5, -0.5);

            throw e;
        }
        let t = performance.now();
        global.metrics.mspt = t - p;
    }
})(util, global, config, Canvas, colors, gameDraw, socketStuff)