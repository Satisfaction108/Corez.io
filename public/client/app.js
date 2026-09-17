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
            document.getElementById("optUiScale").value = global.mobile ? "mobile" : "normal";
            util.submitToLocalStorage("optUiScale");
            localStorage.setItem("uiScaleSettings", "true");
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

    function guiToClientRect(gx, gy, gw, gh) {
        const el = (global.canvas && global.canvas.cv) || document.getElementById("gameCanvas");
        if (!el || !global.screenWidth || !global.screenHeight) return { x: gx, y: gy, w: gw, h: gh };
        const br = el.getBoundingClientRect();
        return {
            x: br.left + gx / global.screenWidth * br.width,
            y: br.top + gy / global.screenHeight * br.height,
            w: gw / global.screenWidth * br.width,
            h: gh / global.screenHeight * br.height,
        };
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
            const aura = c.createRadialGradient(0, 0, R * 0.55, 0, 0, R * (1.28 + 0.08 * pulse));
            aura.addColorStop(0, rgba(teamCol, 0.22 + 0.10 * pulse + doneFlash * 0.28));
            aura.addColorStop(1, rgba(teamCol, 0));
            c.fillStyle = aura;
            c.beginPath(); c.arc(0, 0, R * 1.35, 0, Math.PI * 2); c.fill();
            // team claim ring
            c.globalAlpha = 0.75 + 0.2 * pulse;
            c.lineWidth = Math.max(2.5, R * 0.06);
            c.strokeStyle = doneFlash > 0 ? pal.high : teamCol;
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
            drawText(o.name, sx, sy - o.r * ratio * 1.55 - 4.5,
                     Math.min(32, o.r * ratio * 0.42),
                     color.guiwhite, "center", false, 1, true, c);
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
        const t = Math.min(1, Math.max(0, (performance.now() - global.royale.at) / 250));
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
        if (global.advanced.roundMap) {
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
        ctx[0].fillRect(roomX, roomY, roomWidth, roomHeight);
        // muddy cavern floor: repeat the dirt tile across the room,
        // anchored to world coordinates and scaled with the camera so the
        // ground never "swims". PERF: only the visible slice of the room is
        // pattern-filled - filling the whole room rect each frame was a
        // fullscreen-and-then-some rasterization for nothing.
        if (!floorPattern) floorPattern = makeFloorPattern(ctx[0]);
        {
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
        // the rock wall first - the vaults and outposts sit ON TOP of it, so
        // nothing ever washes over the doors or their labels
        if (window.terrainRenderer && window.terrainRenderer.ready) {
            // near-opaque on the dark cavern floor - the old 0.5 wash only
            // read against a white arena; here it would melt into the dirt
            ctx[0].globalAlpha = 0.9;
            window.terrainRenderer.draw(ctx[0], px, py, ratio, gameWidth, gameHeight, global.screenWidth, global.screenHeight);
        }
        global.advanced.roundMap && ctx[0].restore();
        ctx[0].globalAlpha = 1;
        drawStorm(roomX, roomY, ratio);
        // Dig Wars: team vault doors, set into the base floors
        drawVaults(roomX, roomY, ratio);
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

    function drawEntities(px, py, ratio, tick) {
        if (global.advanced.blackout.active) {
            document.getElementById("gameCanvas-background").style.display = "none";
            ctx[1].drawImage(ctx[0].canvas, 0, 0, global.screenWidth, global.screenHeight);
            if (global.glCanvas) ctx[1].drawImage(global.glCanvas, 0, 0, global.screenWidth, global.screenHeight);
        } else if (document.getElementById("gameCanvas-background").style.display === "none") document.getElementById("gameCanvas-background").style.display = "block";

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
            if (rst < 1 && !instance.deathSounded) {
                instance.deathSounded = true;
                gameSound.die(instance.render.x, instance.render.y,
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
            const _gcls = isContainedChamberGem(instance);
            if (_gcls) {
                drawContainedGem(ctx[1], x, y, ratio, instance.alpha * alpha, isize, instance.render.f, _gcls);
                continue;
            }
            drawEntity(baseColor, x, y, instance, ratio, instance.alpha * alpha, 1, 1, instance.render.f, false, false, false, instance.render, isize);
            if (global.royale && global.outpostState && !royaleLobbyPhase() && global.royale.phase === "live") {
                const owned = global.outpostState.find(s => s.o === instance.id && s.c);
                if (owned) {
                    const c = ctx[1];
                    c.save();
                    c.globalAlpha = (instance.alpha * alpha) * (0.7 + 0.3 * Math.sin(performance.now() / 400));
                    c.strokeStyle = owned.c;
                    c.lineWidth = Math.max(3, isize * ratio * 0.14);
                    c.beginPath();
                    c.arc(x, y, isize * ratio * 1.38, 0, Math.PI * 2);
                    c.stroke();
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
            if (isContainedChamberGem(instance)) continue;
            let alpha = instance.id === gui.playerid ? 1 : instance.alpha;
            alpha = handleScreenDistance(alpha, instance);
            let x = instance.id === gui.playerid ? global.player.screenx : instance._sx - global.screenWidth / 2,
                y = instance.id === gui.playerid ? global.player.screeny : instance._sy - global.screenHeight / 2;
            drawHealth(x, y, instance, ratio, gui.visibleEntities ? 1 : alpha, instance.size);
            drawName(x, y, instance, ratio, gui.visibleEntities ? alpha * 0.75 + 0.25 : alpha, instance.size);
        }
        for (let instance of global.entities) {
            if (!instance._onScreen) continue;
            if (isContainedChamberGem(instance)) continue;
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
        if (global.mobile) {
            if (global.canUpgrade) {
                mobileUpgradeGlide.set(0 + (global.canUpgrade || global.upgradeHover));
                y += (alcoveSize / 1.4 ) * mobileUpgradeGlide.get();
            }
            y += global.canSkill || global.showSkill ? (alcoveSize / 2.2 ) * statMenu.get() : 0;
        }

        var Bd = Date.now();
        var yy = config.animationSettings.ScaleBar;
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

            let K = Math.max(0, Math.min(1, time / 300, duration / 300));
            if (msg.textJSON) {
                let len = 0;

                msg.textJSON.forEach((txt) => {
                    if (len < measureText(txt, height - 4.25, false)) len = measureText(txt, height - 4.25, false)
                })
                ctx[2].globalAlpha = 0.5 * K;

                drawBarAdvanced(x - len / 2, x + len / 2, y + yy / 2, height, color.black, 17.5 * (msg.textJSON.length) - 17.5 + 1);
                ctx[2].globalAlpha = K;

                msg.textobjs = [];
                msg.textJSON.forEach((txt) => {
                    msg.textobjs[msg.textobjs.length] = function () { };
                    drawText(txt, x - len / 2 + 2, y + 16 + 17.5 * (msg.textobjs.length - 1), height - 4.3, color.guiwhite, "left", false, 1, 5.5);
                })
                y += 23 * K + 17.5 * (3 - 2 * K) * (msg.textJSON.length - 1) * K * K;
            } else {

                if (msg.len == null) msg.len = measureText(text, height - 4.3);

                ctx[2].globalAlpha = 0.5 * K;
                drawBar(x - msg.len / 2, x + msg.len / 2, y + yy / 2, height + 2, color.black);

                ctx[2].globalAlpha = K;
                drawText(text, x, y + yy / 1.3, height - 4.3, color.guiwhite, "center", false, 1, 5.5);
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

        for (let i = 0; i < gui.skills.length; i++) {
            ticker--;

            let skill = gui.skills[i],
                name = namedata[ticker - 1],
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

            drawText("[" + (ticker % 10) + "]", Math.round(x + len - height * 0.25) - 14.5, y + height / 2, height - 6, textcolor, "right", true);
            if (textcolor === color.guiwhite) {

                global.clickables.stat.place(ticker - 1, x * clickableRatio, y * clickableRatio, len * clickableRatio, height * clickableRatio);
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
                mid = rx1 + (rx2 - rx1) * 0.54,
                carX2 = mid - capR - 3,
                bankX1 = mid + capR + 3,
                load = g.cap > 0 ? Math.min(1, g.carried / g.cap) : 0,
                blink = load >= 1 && Math.floor(Date.now() / 160) % 2 === 0;
            drawBar(rx1, carX2, ry, height - 3 + config.graphical.barChunk, color.black);
            drawBar(rx1, carX2, ry, height - 3, color.grey);
            if (load > 0.004) drawBar(rx1, rx1 + (carX2 - rx1) * load, ry, height - 3.5, blink ? "#eb4034" : color.gold);
            drawText("Carried: " + util.formatLargeNumber(g.carried | 0), (rx1 + carX2) / 2 + 0.5, ry + 6, 13, color.guiwhite, "center");
            drawBar(bankX1, rx2, ry, height - 3 + config.graphical.barChunk, color.black);
            drawBar(bankX1, rx2, ry, height - 3, color.grey);
            drawBar(bankX1, rx2, ry, height - 3.5, color.teal);
            drawText("Banked: " + util.formatLargeNumber(g.banked | 0), (bankX1 + rx2) / 2 + 0.5, ry + 6, 13, color.guiwhite, "center");
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
        drawText(v.isOutpost ? "OUTPOST BANK · 80% CREDIT" : "TEAM VAULT",
                 x + W / 2, y + 21, 15, teamCol, "center");
        c.fillStyle = teamCol;
        c.fillRect(x + W / 2 - 56, y + 28, 112, 2.5);
        drawText("Banked  " + util.formatLargeNumber(g.banked | 0), x + 16, y + 46, 12, color.teal, "left");
        drawText("Carried  " + util.formatLargeNumber(g.carried | 0), x + W - 16, y + 46, 12, color.gold, "right");

        global.clickables.vault.hide();
        if (belowMin) {
            hideVaultInput();
            drawText("You need at least " + VAULT_MIN_DEPOSIT + " gem dust to cash out!",
                     x + W / 2, y + 70, 12.5, "#ff9a8c", "center");
        } else if (active) {
            // ── channeling: gold progress + live count + cancel ──
            hideVaultInput();
            const frac = 1 - v.remaining / v.total;
            const bx = x + 20, bw = W - 40, by = y + 60, bh = 16;
            drawBar(bx, bx + bw, by + bh / 2, bh + config.graphical.barChunk, color.black);
            drawBar(bx, bx + bw, by + bh / 2, bh, color.grey);
            drawBar(bx, bx + Math.max(6, bw * frac), by + bh / 2, bh - 1, "#ffd75e");
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
            
            drawText("How much dust do you want to cash out?", x + W / 2, y + 66, 12, color.guiwhite, "center");
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

    function drawRoyaleHUD() {
        if (!royaleActive()) return;
        const r = global.royale;
        const cx = global.screenWidth / 2;
        drawText("RAID " + fmtRaidClock(r.raidLeft | 0) + "   ALIVE " + (r.alive | 0), cx, 30, 15, color.guiwhite, "center");
        const st = r.storm || {};
        if (st.a) {
            const label = st.hold ? ("STORM HOLD " + (st.left | 0) + "s") : ("STORM SHRINKS " + (st.left | 0) + "s");
            drawText(label + "  C" + ((st.c | 0) + 1), cx, 50, 13, st.hold ? color.gold : color.guiwhite, "center");
        }
        if (r.place > 0) drawText("#" + r.place + "  " + util.formatLargeNumber(r.youScore | 0) + " pts", cx, 70, 13, color.gold, "center");
        else if (r.youScore > 0) drawText(util.formatLargeNumber(r.youScore | 0) + " pts", cx, 70, 13, color.gold, "center");
        if (r.toast) drawText(r.toast, cx, 90, 13, color.guiwhite, "center");
        const objs = r.objectives || [];
        for (let i = 0; i < Math.min(3, objs.length); i++) {
            const o = objs[i];
            const label = o.kind === "bloom" ? "Ore bloom active" : o.kind === "chest" ? "Loot chest dropped" : (o.name || "Outpost") + " contested";
            drawText(label, cx, 110 + i * 17, 12, color.gold, "center");
        }
        if (r.occupy > 0) {
            drawText("Pad eject in " + r.occupy + "s", cx, global.screenHeight - 56, 16, color.gold, "center");
        } else if (r.lockout > 0) {
            drawText("Re-enter in " + r.lockout + "s", cx, global.screenHeight - 56, 16, color.guiwhite, "center");
        }
        const feed = r.feed || [];
        for (let i = 0; i < feed.length; i++) {
            const f = feed[feed.length - 1 - i];
            if (!f) continue;
            const y = 42 + i * 18;
            const right = global.screenWidth - 18;
            if (f.chest) {
                drawText((f.name || "Someone") + " claimed the loot chest", right, y, 13, color.gold, "right");
            } else if (f.storm) {
                drawText((f.name || "Someone") + " was lost in the storm", right, y, 13, color.guiwhite, "right");
            } else {
                const verb = f.verb || "killed";
                drawText("§gold§" + (f.by || "Someone") + "§reset§ " + verb + " " + (f.name || "someone"),
                         right, y, 13, color.guiwhite, "right");
            }
        }
        if (playerInStorm()) {
            const c = ctx[2];
            c.save();
            c.fillStyle = "rgba(160, 35, 35, 0.28)";
            c.fillRect(0, 0, global.screenWidth, 10);
            c.fillRect(0, global.screenHeight - 10, global.screenWidth, 10);
            c.fillRect(0, 0, 10, global.screenHeight);
            c.fillRect(global.screenWidth - 10, 0, 10, global.screenHeight);
            c.restore();
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
            const pw = 280 * pop, ph = 118 * pop;
            roundRectPath(c, cx - pw / 2, cy - ph / 2 - 8, pw, ph, 16);
            c.fillStyle = "rgba(18, 16, 10, 0.82)";
            c.fill();
            c.lineWidth = 3;
            c.strokeStyle = color.gold;
            c.stroke();
            c.restore();

            c.save();
            c.strokeStyle = color.gold;
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
            drawText("BANKED", cx, cy - 36 * pop, 14, color.gold, "center", true, 1, 7);
            drawText(t.title, cx, cy + 2, titleSize, color.guiwhite, "center", true, 1, 4.5);
            if (t.bonus) {
                drawText(t.bonus, cx, cy + 44 * pop, bonusSize, color.gold, "center", true, 1, 4.5);
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

            c.save();
            c.strokeStyle = color.guiwhite;
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
            drawText("DEAD", x, y + 28 * pop * ratio, 17 * pop * ratio, color.guiwhite, "center", true, 1, 5.5);
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
            const gd = c.createRadialGradient(w / 2, h / 2, r * inner, w / 2, h / 2, r);
            gd.addColorStop(0, "rgba(170,16,16,0)");
            gd.addColorStop(1, "rgba(170,16,16," + peak.toFixed(3) + ")");
            c.fillStyle = gd;
            c.fillRect(0, 0, w, h);
            c.restore();
        }

        if (hurt > 0.01) {
            c.save();
            const gd = c.createRadialGradient(w / 2, h / 2, r * 0.52, w / 2, h / 2, r);
            gd.addColorStop(0, "rgba(210,28,28,0)");
            gd.addColorStop(1, "rgba(210,28,28," + (0.34 * hurt).toFixed(3) + ")");
            c.fillStyle = gd;
            c.fillRect(0, 0, w, h);
            c.restore();
        }
        if (cele > 0.01) {
            c.save();
            const gd = c.createRadialGradient(w / 2, h / 2, r * 0.5, w / 2, h / 2, r);
            gd.addColorStop(0, "rgba(239,199,75,0)");
            gd.addColorStop(1, "rgba(239,199,75," + (0.34 * cele).toFixed(3) + ")");
            c.fillStyle = gd;
            c.fillRect(0, 0, w, h);
            c.restore();
        }
        if (dead > 0.01) {
            c.save();
            const gd = c.createRadialGradient(w / 2, h / 2, r * 0.58, w / 2, h / 2, r);
            gd.addColorStop(0, "rgba(255,255,255,0)");
            gd.addColorStop(1, "rgba(255,255,255," + (0.28 * dead).toFixed(3) + ")");
            c.fillStyle = gd;
            c.fillRect(0, 0, w, h);
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
        const inner = r * (0.80 - 0.20 * t - 0.03 * beat);
        c.save();
        const gd = c.createRadialGradient(w / 2, h / 2, Math.max(1, inner), w / 2, h / 2, r);
        gd.addColorStop(0, "rgba(" + rgb + ",0)");
        gd.addColorStop(1, "rgba(" + rgb + "," + a.toFixed(3) + ")");
        c.fillStyle = gd;
        c.fillRect(0, 0, w, h);
        c.restore();

        if (full) {
            c.save();
            c.globalAlpha = 0.68 + 0.32 * beat;
            drawText("Gem limit reached, please bank it!", w / 2, 112, 16, "#eb4034", "center");
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
    function getMapPaths() {
        const tr = window.terrainRenderer;
        if (!tr || !tr.ready || !tr._cellPolys.size) return null;
        if (!mapPaths || tr.mapDirty) {
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
            mapPaths = { alive, dead, epoch: (mapPaths ? mapPaths.epoch : 0) + 1 };
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
        if (royaleActive()) {
            const cr = circleRadiusWorld();
            c.beginPath();
            c.arc(X(0), Y(0), Math.max(2, cr * s), 0, Math.PI * 2);
            c.fillStyle = "#1e1d1b";
            c.fill();
            c.save();
            c.beginPath();
            c.arc(X(0), Y(0), Math.max(2, cr * s), 0, Math.PI * 2);
            c.clip();
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

        if (royaleActive()) c.restore();
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
            if (rr.bloom) {
                const mx = T.X(rr.bloom.x), my = T.Y(rr.bloom.y);
                if (inside(mx, my)) {
                    c.save();
                    c.beginPath();
                    c.arc(mx, my, Math.max(5, dotR * 2.6 * pulse), 0, Math.PI * 2);
                    c.fillStyle = "rgba(239,199,75,0.85)";
                    c.fill();
                    c.lineWidth = 2;
                    c.strokeStyle = color.black;
                    c.stroke();
                    c.restore();
                    if (nameSize > 0) drawText("BLOOM", Math.round(mx), Math.round(my - dotR * 3.4), nameSize * 0.85, "#efc74b", "center");
                }
            }
            if (rr.chest) {
                const mx = T.X(rr.chest.x), my = T.Y(rr.chest.y);
                if (inside(mx, my)) {
                    const s = dotR * 2.2 * pulse;
                    c.save();
                    c.fillStyle = "#7de08a";
                    c.strokeStyle = color.black;
                    c.lineWidth = 2;
                    c.fillRect(mx - s / 2, my - s / 2, s, s);
                    c.strokeRect(mx - s / 2, my - s / 2, s, s);
                    c.restore();
                    if (nameSize > 0) drawText("CHEST", Math.round(mx), Math.round(my - s), nameSize * 0.85, "#7de08a", "center");
                }
            }
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
        }

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
        const circle = royaleActive(); // BR disk reads as a circle, not a square
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
        const needs = !cornerCache.canvas || cornerCache.sizePx !== S ||
            cornerCache.epoch !== epoch ||
            Math.abs(cxNow - cornerCache.cx) > margin * 0.7 ||
            Math.abs(cyNow - cornerCache.cy) > margin * 0.7;
        if (needs) {
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
        if (circle) {
            ctx[2].beginPath();
            ctx[2].arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
            ctx[2].clip();
        } else {
            optionsMenu_drawRoundedRect(x, y, size, size, 12);
            ctx[2].clip();
        }
        
        
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
        const cr = circleRadiusWorld();
        c.beginPath();
        c.rect(x - 2, y - 2, size + 4, size + 4);
        c.arc(T.X(0), T.Y(0), Math.max(2, cr * T.s), 0, Math.PI * 2, true);
        c.fillStyle = "#0d0d0c";
        c.fill("evenodd");
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
            drawText(hoverOutpost.name, Math.round(mx), Math.round(my - 16), 14, color.gold, "center");
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
                name: f.chest
                    ? ((f.name || "Unnamed") + " claimed the loot chest")
                    : f.storm
                    ? ((f.name || "Unnamed") + " was lost in the storm")
                    : ((f.by || "Someone") + " " + (f.verb || "killed") + " " + (f.name || "Unnamed")),
                extra: f.place ? ("#" + f.place) : "",
            }))
            : tab === "alive"
                ? ((global.royale.board || []).filter(r => r.alive)).map((r, i) => ({
                    name: (i + 1) + ". " + (r.name || "Unnamed"),
                    extra: (r.kills | 0) ? ((r.kills | 0) + " elims") : "alive",
                }))
                : royaleBoardRows().map((r, i) => ({
                    name: (i + 1) + ". " + (r.name || "Unnamed") + (r.alive === false ? "  X" : ""),
                    extra: util.formatLargeNumber(r.score || r.gems | 0) + " pts  " + (r.kills | 0) + "K " + ((r.holds | 0) + "H"),
                }));
        if (!rows.length) {
            drawText(tab === "alive" ? "Nobody is alive" : "Nobody here yet", x + w / 2, y + h / 2, 16, color.guiwhite, "center");
            return;
        }
        const rowH = 28;
        for (let i = 0; i < rows.length && i < Math.floor((h - 20) / rowH); i++) {
            const ry = y + 16 + i * rowH;
            drawText(rows[i].name, x + 18, ry, 14, color.guiwhite, "left");
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
            global.advanced.roundMap ? drawGuiCircle(x + len / 2, y + height / 2, len / 2) : drawGuiRect(x, y, len, height);
            ctx[2].beginPath();
            global.advanced.roundMap ? ctx[2].arc(x + len / 2, y + height / 2, len / 2, 0, 2 * Math.PI) : ctx[2].rect(x, y, len, height);
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
            global.advanced.roundMap ? drawGuiCircle(x + len / 2, y + height / 2, len / 2, true) : drawGuiRect(x, y, len, height, true);
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
        }
    }

    function drawAvailableUpgrades(spacing, alcoveSize) {

        if (global.optionsMenu_Anim.isOpened) global.clickables.upgrade.hide();
        if (gui.upgrades.length > 0) {
            let internalSpacing = 15;
            let len = alcoveSize / 2;
            let height = len;

            global.columnCount = Math.max(global.mobile ? 9 : 3, Math.floor(gui.upgrades.length ** 0.55));
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

                let amount = skill.amount,
                    skillColor = color[skill.color],
                    cap = skill.cap,
                    name = statNames[9 - i].split(/\s+/),
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

                cap === 0 || !gui.points || softcap !== cap && amount === softcap || global.clickables.stat.place(9 - i, x * clickableRatio, spacing * clickableRatio, t * clickableRatio, q * clickableRatio);

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
        drawText(label, bx + 40, by + 12, 11, color.grey, "left");
        drawText(value, bx + 40, by + 31, 16, color.guiwhite, "left");
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
        // Royale owns its death screen (placement + spectate + home, no respawn).
        if (global.royaleDied && (global.royaleSpectating || global.showBigMap)) {
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
    // ── Royale death screen ──────────────────────────────────────────────
    // Raid: death is a tax. Short countdown, auto respawn, weak drill on return.
    const gameDrawDeadRoyale = () => {
        let glide = global.deathAnimation.get();
        clearScreen(color.black, 0.32 + 0.28 * global.lerp(0, 0.5, glide), ctx[2]);
        const c = ctx[2];
        const cx = global.screenWidth / 2;
        const place = global.royale.place | 0;
        const PW = Math.min(480, global.screenWidth - 40);
        const PH = 270;
        const px = cx - PW / 2;
        const py = Math.max(20, global.screenHeight / 2 - PH / 2);
        c.save();
        c.fillStyle = "rgba(16,17,22,0.93)";
        c.fillRect(px, py, PW, PH);
        c.lineWidth = 3;
        c.strokeStyle = color.black;
        c.strokeRect(px, py, PW, PH);
        c.restore();
        drawText("YOU DIED", cx, py + 36, 22, color.gold, "center");
        drawText(place > 0 ? ("#" + place + "  " + util.formatLargeNumber(global.royale.youScore | 0) + " pts") : "Raid continues", cx, py + 80, 20, color.guiwhite, "center");
        const kills = Math.round(global.finalKills[0].get());
        const gems = (global.finalBanked | 0) + (global.finalCarried | 0);
        drawText(kills + " elims   " + util.formatLargeNumber(gems) + " gems   " + compactTime(global.finalLifetime.get()),
                 cx, py + 110, 14, color.guiwhite, "center");
        const cause = global.finalCause || "";
        const killedBy = cause === "rock" ? "Crushed by the living rock"
            : cause === "storm" ? "Lost in the storm"
            : global.finalKillers.length
                ? "Taken down by " + global.finalKillers.join(" and ")
                : "Nobody finished you off";
        drawText(killedBy, cx, py + 134, 13, color.grey, "center");
        drawText("Banked gems kept. Satchel dropped. Drill weak for 30s.", cx, py + 156, 12, color.guiwhite, "center");
        const waitMs = Math.max(0, (global.raidRespawnAt || 0) - performance.now());
        if (waitMs <= 0 && !global.disconnected && !global.respawnPending) {
            try { global.canvas.respawn(); } catch { /* */ }
        }
        drawText(waitMs > 0 ? ("Respawning in " + Math.ceil(waitMs / 1000) + "s") : "Respawning", cx, py + 180, 14, color.gold, "center");
        global.clickables.royalePrev.hide();
        global.clickables.royaleNext.hide();
        const by = py + PH - 46;
        const cr = global.canvas.height / global.screenHeight / global.ratio;
        const ga = global.lerp(3, 3.25, glide);
        if (!global.disconnected) {
            drawButton(cx - 90, by, 150, 32, ga, "rect", "Spectate", 15, false, false, false, true, "royaleSpectate", cr, 0);
            drawButton(cx + 90, by, 150, 32, ga, "rect", "Home", 15, false, false, false, true, "exitGame", cr, 0);
            global.royaleBarHits = {
                spectate: guiToClientRect(cx - 90 - 75, by, 150, 32),
                play: null,
                prev: null,
                next: null,
                home: guiToClientRect(cx + 90 - 75, by, 150, 32),
            };
        }
    };
    const drawRoyaleSpectateBar = () => {
        const sw = global.screenWidth;
        const barW = Math.min(620, sw - 40);
        const x = (sw - barW) / 2;
        const y = 10;
        const h = 36;
        const c = ctx[2];
        c.save();
        c.fillStyle = "rgba(16,17,22,0.92)";
        c.fillRect(x, y, barW, h);
        c.lineWidth = 3;
        c.strokeStyle = color.black;
        c.strokeRect(x, y, barW, h);
        c.restore();
        const place = global.royale.place | 0;
        const waitMs = Math.max(0, (global.raidRespawnAt || 0) - performance.now());
        if (waitMs <= 0 && global.died && !global.disconnected && !global.respawnPending) {
            try { global.canvas.respawn(); } catch { /* */ }
        }
        const label = "Spectating" + (place > 0 ? ("  #" + place) : "") + (waitMs > 0 ? ("  Respawn " + Math.ceil(waitMs / 1000) + "s") : "");
        drawText(label, x + barW / 2, y + 24, 14, color.guiwhite, "center");
        const cr = global.canvas.height / global.screenHeight / global.ratio;
        drawButton(x + 56, y + 3, 100, 30, 1, "rect", "Prev", 14, false, false, false, true, "royalePrev", cr, 0);
        drawButton(x + 166, y + 3, 100, 30, 1, "rect", "Next", 14, false, false, false, true, "royaleNext", cr, 0);
        global.royaleBarHits = {
            prev: guiToClientRect(x + 56 - 50, y + 3, 100, 30),
            next: guiToClientRect(x + 166 - 50, y + 3, 100, 30),
            spectate: null,
            play: null,
            home: null,
        };
        drawButton(x + barW - 58, y + 3, 90, 30, 1, "rect", "Home", 14, false, false, false, true, "exitGame", cr, 0);
        global.royaleBarHits.home = guiToClientRect(x + barW - 58 - 45, y + 3, 90, 30);
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
        if (config.graphical.lerpAnimations) {
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
        let alcoveSize = 200 / ratio;
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
        if (global.GUIStatus.renderGUI) {
            updateMapSmoothing();
            drawLowHealthVignette();
            drawSatchelDanger();
            drawTeamBankBar();
            drawRoyaleHUD();
            if (global.royaleSpectating) drawRoyaleSpectateBar();
            drawRoyaleBoard();
            drawMessages(spacing, alcoveSize);
            drawMilestones();
            drawWarBanner();
            if (global.GUIStatus.renderUpgrades) drawSkillBars(spacing, alcoveSize);
            if (global.GUIStatus.renderPlayerBars) {
                drawSelfInfo(max);
                drawGemPopups();   // +N numbers + pickup ring over the tank
                drawVaultUI();     
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

        // The in-game "?" replay button is gone on purpose: the tutorial now
        // lives on its own server, so replaying it mid-match would mean
        // yanking a player out of a live fight. It is reachable from the
        // homepage Tutorial button instead.

        setInterval(() => {
            const show = (global.gameStart && !global.died && !global.disconnected) ? "flex" : "none";
            btn.style.display = show;
            chatBtn.style.display = show;
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
            context.clearRect(0, 0, context.canvas.width, context.canvas.height);
        }

        if (isNaN(global.player.renderx) && isNaN(global.player.rendery)) {
            global.player.renderx = global.player.cx.x;
            global.player.rendery = global.player.cy.y;
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