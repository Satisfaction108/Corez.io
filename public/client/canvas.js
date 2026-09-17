import { global } from "./global.js";
import { util } from "./util.js";
import { config } from "./config.js";
import * as socketStuff from "./socketinit.js";
import { AdvancedRecorder } from "./recorder.js";
import { gameSound } from "./sound.js";
let { gui } = socketStuff;

function hitClientRect(mouse, r) {
    if (!r || mouse == null) return false;
    const x = mouse.clientX, y = mouse.clientY;
    return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

class Canvas {
    constructor() {
        this.directionLock = false;
        this.target = global.target;
        this.socket = global.socket;
        this.directions = [];
        this.chatListener = function(id, event) {
            if (![global.KEY_ENTER, global.KEY_ESC].includes(event.keyCode)) return;
            this[id].blur();
            this.cv.focus();
            global.showChat = false;
            setTimeout(() => {
                if (!this.chatBox.loadedProperly) this.chatBox.remove(), this.chatInput.remove(), this.chatBox = false;
            }, 50)
            if (!this[id].value) return;
            if (event.keyCode === global.KEY_ENTER) this.socket.talk('M', this[id].value, global.chatMode === 'team' ? 1 : 0);
            this[id].value = "";
        }

        this.cv = document.getElementById('gameCanvas');
        this.cvb = document.getElementById('gameCanvas-background');
        this.cvg = document.getElementById('gameCanvas-gameplay');
        this.cvu = document.getElementById('gameCanvas-gui');
        this.cv.resize = (width, height) => {
            this.cv.width = this.cvb.width = this.cvg.width = this.cvu.width = this.width = width;
            this.cv.height = this.cvb.height = this.cvg.height = this.cvu.height = this.height = height;
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
        global.mobile && optMobile.value == "mobile" || optMobile.value == "mobileWithBigJoysticks" ? ( // Mobile
            this.mobilecv = this.cv,
            this.controlTouch = null,
            this.movementTouch = null,
            this.movementTouchPos = { x: 0, y: 0 },
            this.controlTouchPos = { x: 0, y: 0 },
            this.mobilecv.addEventListener("touchstart", (event) => {if (global.gameStart || global.disconnected) this.touchStart(event)}),
            this.mobilecv.addEventListener("touchmove", (event) => {if (global.gameStart) this.touchMove(event)}),
            this.mobilecv.addEventListener("touchend", (event) => {if (global.gameStart) this.touchEnd(event)}),
            this.mobilecv.addEventListener("touchcancel", (event) => {if (global.gameStart) this.touchEnd(event)})
        ) : ( // PC
            this.cv.addEventListener("mousemove", (event) => {if (global.gameStart || global.disconnected) this.mouseMove(event)}),
            this.cv.addEventListener("mousedown", (event) => {if (global.gameStart || global.disconnected) this.mouseDown(event)}),
            this.cv.addEventListener("mouseup", (event) => {if (global.gameStart || global.disconnected) this.mouseUp(event)}),
            this.cv.addEventListener("keypress", (event) => {if (global.gameStart) this.keyPress(event)}),
            this.cv.addEventListener("wheel", (event) => {if (global.gameStart) this.wheel(event)})
        );
        this.cv.addEventListener("keydown", (event) => {if (global.gameStart) this.keyDown(event)});
        this.cv.addEventListener("keyup", (event) => {if (global.gameStart) this.keyUp(event)});
        window.addEventListener("gamepadconnected", (e) => {
            global.createMessage("Controller detected! Initalizing Gamepad mode...");
            this.runGamepad();
        });
        window.addEventListener("gamepaddisconnected", (e) => {
            global.createMessage("Controller disconnected! Gamepad mode terminated.");
            this.stopGamepad();
        });
        this.initalized = true;
    }

    wheel(event) {
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
            document.getElementById("gameAreaWrapper").appendChild(this.chatInput);
        }
        this.releaseMovement();
        this.chatInput.focus();
        global.showChat = true;
    }

    respawn() {
        // Final storm: no spawns. Hold the death UI until the reset.
        if (global.royale && global.royale.lock && global.royale.at > 0) return;
        if (global.died && !global.cannotRespawn && !global.respawnPending) {
            global.respawnPending = true;
            global.royaleDied = false;
            global.royaleSpectating = false;
            global.royaleKillerCamUntil = 0;
            global._specGlide = null;
            global.raidRespawnAt = 0;
            global.raidQueued = true;
            this.socket.talk('s', global.playerName, 0, 1 * config.game.autoLevelUp, false, 1 * config.game.incognitoMode);
            setTimeout(() => {
                if (global.respawnPending) global.respawnPending = false;
            }, 5000);
        }
    }

    keyDown(event) {
        if (global.dailyTankAd.renderUI) return;
        if (global.specialPressed) {
            event.preventDefault();
            if (!event.repeat) global.specialKeysPressed.push(event.keyCode);
            this.socket.talk("#", ...global.specialKeysPressed);
            return;
        }

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
                if (global.died) {
                    if (!global.cannotRespawn) { this.respawn(); break; }
                    break;
                }

                // or to talk instead
                if (global.gameStart && !global.died && !global.disconnected) {
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
                // A is movement. Never start spectate from it — key-repeat after
                // death was jumping the camera to a random player.
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
                // Dig Wars: Spin Lock is removed; AI override is back on R
                case global.KEY_OVER_RIDE:
                    this.socket.talk("t", 2, true);
                    break;
                case global.KEY_AUTO_ALT: {
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
                    global.KEY_UPGRADE_SHI
                ].indexOf(event.keyCode);
                // Numpad 1-9/0 as a second path to the same stats. Keyboards
                // block certain simultaneous key combinations in their wiring,
                // so a particular stat can be unreachable while you are holding
                // movement keys even though the neighbouring digits work. The
                // numpad sits on different matrix lines and gets through.
                if (skill < 0 && event.location === 3) {
                    if (event.keyCode >= 97 && event.keyCode <= 105) skill = event.keyCode - 97;
                    else if (event.keyCode === 96) skill = 9;
                }
                if (skill >= 0) {
                    this.socket.talk('x', skill, 1 * global.statMaxing);
                    gameSound.buildUpgrade();
                }
            }
            if (global.canUpgrade) {
                switch (event.keyCode) {
                    case global.KEY_CHOOSE_1:
                        this.socket.talk("U", 0, parseInt(gui.upgrades[0][0]));
                        gameSound.uiClick();
                        break;
                    case global.KEY_CHOOSE_2:
                        this.socket.talk("U", 1, parseInt(gui.upgrades[1][0]));
                        gameSound.uiClick();
                        break;
                    case global.KEY_CHOOSE_3:
                        this.socket.talk("U", 2, parseInt(gui.upgrades[2][0]));
                        gameSound.uiClick();
                        break;
                    case global.KEY_CHOOSE_4:
                        this.socket.talk("U", 3, parseInt(gui.upgrades[3][0]));
                        gameSound.uiClick();
                        break;
                    case global.KEY_CHOOSE_5:
                        this.socket.talk("U", 4, parseInt(gui.upgrades[4][0]));
                        gameSound.uiClick();
                        break;
                    case global.KEY_CHOOSE_6:
                        this.socket.talk("U", 5, parseInt(gui.upgrades[5][0]));
                        gameSound.uiClick();
                        break;
                }
            }
        }
    }
    keyUp(event) {
        if (global.dailyTankAd.renderUI) return;
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
        switch (mouse.button) {
            case 0:
                let mpos = {
                    x: mouse.clientX * global.ratio,
                    y: mouse.clientY * global.ratio,
                };
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
                let statIndex = global.clickables.stat.check(mpos);
                let upgradeCheck = global.clickables.upgrade.check(mpos);
                if (statIndex !== -1) {
                    this.socket.talk('x', statIndex, 0);
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
                    global.clickables.dailyTankUpgrade.check(mpos) == false &&
                    global.clickables.dailyTankAd.check(mpos) === false &&
                    global.clickables.royaleTab.check(mpos) == -1 &&
                    global.clickables.royaleSpectate.check(mpos) == -1 &&
                    global.clickables.royalePrev.check(mpos) == -1 &&
                    global.clickables.royaleNext.check(mpos) == -1 &&
                    global.clickables.royalePlay.check(mpos) == -1 &&
                    upgradeCheck == -1 &&
                    !global.died
                ) this.socket.cmd.set(primaryFire, true);
                break;
            case 1:
                this.socket.cmd.set(5, true);
                break;
            case 2:
                this.socket.cmd.set(secondaryFire, true);
                break;
        }
    }
    mouseUp(mouse) {
        let primaryFire = 4,
            secondaryFire = 6;
        if (this.inverseMouse) [primaryFire, secondaryFire] = [secondaryFire, primaryFire];
        global.clickables.clicked = false;
        switch (mouse.button) {
            case 0:
                let mpos = {
                    x: mouse.clientX * global.ratio,
                    y: mouse.clientY * global.ratio,
                };
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
                    this.socket.talk('RS', 2);
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
                // Direct hit-rects published by drawOptionsMenu — the same
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
                    if (vaultClick === 10) {
                        const el = document.getElementById('vaultInput');
                        const carried = global.gems.carried | 0;
                        const n = Math.min(carried, parseInt(el && el.value) || 0);
                        if (n >= 1) this.socket.talk('vd', n);
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
                } else if (global.clickables.skipUpgrades.check(mpos) !== -1) {
                    global.clearUpgrades();
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
        let AdvancedCanvasCapturer = () => {
            let canvas = this.cvb.cloneNode();
            let ctx = canvas.getContext("2d");
            let toMerge = [];
            let stop = false;
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
                start: () => {
                    stop = false; // Reset flag
                    ctx.canvas.width = this.cv.width; // Set Width
                    ctx.canvas.height = this.cv.height; // Set Height
                    const anim = () => {
                        if (stop) return;
                        if (ctx.canvas.width !== this.cv.width || ctx.canvas.height !== this.cv.height) {
                            global.createMessage("Recorder stopped due to resize change. Saving file...", 5_000);
                            this.videoRecorder.stop();
                            this.videoRecorderCanvas.stop();
                            setTimeout(() => this.videoRecorder.download(), 200);
                        }
                        ctx.fillRect(0, 0, this.cv.width, this.cv.height);
                        toMerge.forEach(layer => {
                            if (layer) ctx.drawImage(layer, 0, 0);
                        });
                        requestAnimationFrame(anim);
                    };
                    anim();
                },
                stop: () => { stop = true; },
                getCanvas: () => canvas
            }
        }
        if (this.cv.captureStream && window.MediaRecorder) {
            if (this.videoRecorder) {
                switch (this.videoRecorder.state) {
                    case "inactive":
                        global.createMessage("Recorder Started!", 2_000);
                        this.videoRecorderCanvas.start();
                        this.videoRecorder.start();
                        break;
                    case "recording":
                        global.createMessage("Recorder Stopped! Saving file...", 5_000);
                        this.videoRecorder.stop();
                        this.videoRecorderCanvas.stop();
                        setTimeout(() => this.videoRecorder.download(), 200);
                }
            } else {
                this.videoRecorderCanvas = AdvancedCanvasCapturer();
                this.videoRecorderCanvas.init();
                this.videoRecorderCanvas.start();
                this.videoRecorder = new AdvancedRecorder(this.videoRecorderCanvas.getCanvas(), 60);
                global.createMessage("Recorder Started!", 2_000);
                this.videoRecorder.start();
            }
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
                    ctx.canvas.width = this.cv.width; // Set Width
                    ctx.canvas.height = this.cv.height; // Set Height
                    ctx.fillStyle = "#ffffff"
                    ctx.fillRect(0, 0, this.cv.width, this.cv.height);
                    toMerge.forEach(layer => {
                        if (layer) ctx.drawImage(layer, 0, 0);
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
    // MOBILE SUPPORT
    touchStart(e) {
        e.preventDefault();
        // Raid bar buttons first: tap-anywhere-respawn must not eat them.
        for (let touch of e.changedTouches) {
            let mpos = {
                x: touch.clientX * global.ratio,
                y: touch.clientY * global.ratio,
            };
            if (global.clickables.royalePrev.check(mpos) !== -1 && global.died) {
                global.royaleSpectating = true;
                this.socket.talk('RS', 0);
                gameSound.uiClick();
                return;
            }
            if (global.clickables.royaleNext.check(mpos) !== -1 && global.died) {
                global.royaleSpectating = true;
                this.socket.talk('RS', 1);
                gameSound.uiClick();
                return;
            }
            if (global.clickables.royaleSpectate.check(mpos) !== -1 && global.died && !global.disconnected) {
                global.royaleSpectating = true;
                this.socket.talk('RS', 2);
                gameSound.uiClick();
                return;
            }
            if (global.clickables.royalePlay.check(mpos) !== -1 && global.died && !global.disconnected) {
                this.respawn();
                gameSound.uiClick();
                return;
            }
            if (global.clickables.exitGame.check(mpos) !== -1 && (global.died || global.disconnected)) {
                global.exit();
                gameSound.uiClick();
                return;
            }
        }
        if (global.died) {
            return;
        } else {
            for (let touch of e.changedTouches) {
                let mpos = {
                    x: touch.clientX * global.ratio,
                    y: touch.clientY * global.ratio,
                };
                let id = touch.identifier;
                let buttonIndex = global.clickables.mobileButtons.check(mpos);
                if (buttonIndex !== -1) {
                    gameSound.uiClick();
                    switch (buttonIndex) {
                        case 0:
                            global.clickables.mobileButtons.active = !global.clickables.mobileButtons.active;
                            break;
                        case 1:
                            if (global.clickables.mobileButtons.active) {
                                global.clickables.mobileButtons.altFire =
                                    !global.clickables.mobileButtons.altFire;
                                if (!global.clickables.mobileButtons.altFire)
                                    this.socket.cmd.set(6, false);
                            } else if (global.isInverted)
                                (global.isInverted = false), this.socket.cmd.set(6, false);
                            else (global.isInverted = true), this.socket.cmd.set(6, true);
                            break;
                        case 2:
                            if (!document.fullscreenElement) {
                                var d = document.body;
                                d.requestFullscreen
                                    ? d.requestFullscreen()
                                    : d.msRequestFullscreen
                                        ? d.msRequestFullscreen()
                                        : d.mozRequestFullScreen
                                            ? d.mozRequestFullScreen()
                                            : d.webkitRequestFullscreen && d.webkitRequestFullscreen();
                            } else {
                                document.exitFullscreen();
                            }
                            break;
                        case 3:
                            this.socket.talk("t", 1, true);
                            break;
                        case 4:
                            this.reverseDirection = !this.reverseDirection;
                            global.createMessage(this.reverseDirection ? "Reverse tank enabled." : "Reverse tank disabled.");
                            break;
                        case 5:
                            this.socket.talk("1");
                            break;
                        case 6:
                            global.autoSpin = !global.autoSpin;
                            this.socket.talk("t", 0, true);
                            break;
                        case 7:
                            this.socket.talk("t", 2, true);
                            break;
                        case 8:
                            this.socket.talk("L");
                            break;
                        case 9:
                            this.socket.talk("H");
                            break;
                        case 10:
                            this.socket.talk("0");
                            break;
                        case 11:
                            if (global.gameStart && !global.died && !global.disconnected) {
                                this.spawnChatInput();
                                break;
                            }
                            break;
                        default:
                            throw new Error("Unknown button index.");
                    }
                } else {
                    let statIndex = global.clickables.stat.check(mpos);
                    let exitGame = global.clickables.exitGame.check(mpos);
                    let reconnectCheck = global.clickables.reconnect.check(mpos);
                    if (reconnectCheck !== -1) {
                        if (global.disconnected) global.reconnect();
                        gameSound.uiClick();
                    } else if (exitGame !== -1) {
                        if (global.disconnected || global.died) global.exit();
                        gameSound.uiClick();
                    } else if (statIndex !== -1) {
                        this.socket.talk("x", statIndex, 0);
                        gameSound.buildUpgrade();
                    } else if (global.clickables.skipUpgrades.check(mpos) !== -1) {
                        global.clearUpgrades();
                        gameSound.uiClick();
                    } else {
                        let upgradeIndex = global.clickables.upgrade.check(mpos);
                        if (upgradeIndex !== -1) {
                            this.socket.talk("U", upgradeIndex, parseInt(gui.upgrades[upgradeIndex][0]));
                            gameSound.uiClick();
                        } else {
                            let onLeft = mpos.x < this.cv.width / 2;
                            if (this.movementTouch === null && onLeft) {
                                this.movementTouch = id;
                            } else if (this.controlTouch === null && !onLeft) {
                                this.controlTouch = id;
                                this.socket.cmd.set(4, true);
                            }
                        }
                    }
                }
            }
            this.touchMove(e);
        }
    }
    touchMove(e) {
        e.preventDefault();
        for (let touch of e.changedTouches) {
            let mpos = {
                x: touch.clientX * global.ratio,
                y: touch.clientY * global.ratio,
            };
            let id = touch.identifier;

            if (this.movementTouch === id) {
                let radius = Math.min(global.screenWidth * 0.6, global.screenHeight * 0.12);
                let cx = (mpos.x - (this.cv.width * 1) / 6)  / (radius / 64);
                let cy = (mpos.y - (this.cv.height * 2) / 3)  / (radius / 64);
                let touchX = cx / (radius / 64);
                let touchY = cy / (radius / 64);
                let r = Math.sqrt(cx ** 2 + cy ** 2);
                let angle = Math.atan2(cy, cx);
                if (r > radius) {
                    touchX = Math.cos(angle) * radius / 1.05;
                    touchY = Math.sin(angle) * radius / 1.05;
                }
                this.movementTouchPos = { x: touchX, y: touchY };
                let x = mpos.x - (this.cv.width * 1) / 6;
                let y = mpos.y - (this.cv.height * 2) / 3;
                let norm = Math.sqrt(x * x + y * y);
                x /= norm;
                y /= norm;
                let amount = 0.38268323650898;
                if (y < -amount !== this.movementTop)
                    this.socket.cmd.set(0, (this.movementTop = y < -amount));
                if (y > amount !== this.movementBottom)
                    this.socket.cmd.set(1, (this.movementBottom = y > amount));
                if (x < -amount !== this.movementLeft)
                    this.socket.cmd.set(2, (this.movementLeft = x < -amount));
                if (x > amount !== this.movementRight)
                    this.socket.cmd.set(3, (this.movementRight = x > amount));
            } else if (this.controlTouch === id) {
                global.mobileStatus.showCrosshair = true;
                let radius = Math.min(
                    global.screenWidth * 0.6,
                    global.screenHeight * 0.12
                );
                let cx = (mpos.x - (this.cv.width * 5) / 6)  / (radius / 64);
                let cy = (mpos.y - (this.cv.height * 2) / 3)  / (radius / 64);
                let touchX = cx / (radius / 64);
                let touchY = cy / (radius / 64);
                let r = Math.sqrt(cx ** 2 + cy ** 2);
                let angle = Math.atan2(cy, cx);
                if (r > radius) {
                    touchX = Math.cos(angle) * radius / 1.05;
                    touchY = Math.sin(angle) * radius / 1.05;
                }
                this.controlTouchPos = { x: touchX, y: touchY };
                if (!this.spinLock) {
                    if (cx < -radius) cx = -radius;
                    else if (cx > radius) cx = radius;
                    if (cy < -radius) cy = -radius;
                    else if (cy > radius) cy = radius;
                    this.target.x = ((cx / radius) * global.screenWidth) / 2;
                    this.target.y = ((cy / radius) * global.screenHeight) / 2;
                }
            }
        }
        global.mouse = this.target;
    }
    touchEnd(e) {
        e.preventDefault();
        for (let touch of e.changedTouches) {
            let id = touch.identifier;
      
            if (this.movementTouch === id) {
                this.movementTouch = null;
                this.movementTouchPos = { x: 0, y: 0 };
                if (this.movementTop) this.socket.cmd.set(0, (this.movementTop = false));
                if (this.movementBottom) this.socket.cmd.set(1, (this.movementBottom = false));
                if (this.movementLeft) this.socket.cmd.set(2, (this.movementLeft = false));
                if (this.movementRight) this.socket.cmd.set(3, (this.movementRight = false));
            } else if (this.controlTouch === id) {
                this.controlTouch = null;
                this.controlTouchPos = { x: 0, y: 0 };
                this.socket.cmd.set(4, false);
                global.mobileStatus.showCrosshair = false;
            }
        }
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
        global.createMessage("Gamepad mode initalized and ready to use.");
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
    }
}
export { Canvas }
