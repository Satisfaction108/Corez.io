import { util } from "./util.js";

const missingno = {
    index: -1,
    name: "MissingNo.",
    x: 0,
    y: 0,
    color: "mirror 0 1 0 true",
    strokeWidth: 1,
    upgradeColor: null,
    glow: {
        radius: null,
        color: null,
        alpha: 1,
        recursion: 1
    },
    borderless: false,
    drawFill: true,
    shape: "image=/missingno.png",
    imageInterpolation: "bilinear",
    size: 12,
    realSize: 12,
    facing: 0,
    position: {
        axis: 2,
        middle: {
            x: 0,
            y: 0
        }
    },
    statnames: {
        body_damage: "???",
        max_health: "???",
        bullet_speed: "???",
        bullet_health: "???",
        bullet_pen: "???",
        bullet_damage: "???",
        reload: "???",
        move_speed: "???",
        shield_regen: "???",
        shield_cap: "???"
    },
    rerootUpgradeTree: "basic", 
    className: "MissingNo.",
    upgrades: [],
    guns: [],
    turrets: [],
    props: []
};
function Clickable() {
    let region = {
        x: 0,
        y: 0,
        w: 0,
        h: 0,
    };
    let raw = { x: 0, y: 0, w: 0, h: 0 };
    let active = false;
    return {
        set: (x, y, w, h) => {
            raw.x = x;
            raw.y = y;
            raw.w = w;
            raw.h = h;
            region.x = x * global.ratio;
            region.y = y * global.ratio;
            region.w = w * global.ratio;
            region.h = h * global.ratio;
            active = true;
        },
        check: target => {
            let dx = Math.round(target.x - region.x);
            let dy = Math.round(target.y - region.y);
            return active && dx >= 0 && dy >= 0 && dx <= region.w && dy <= region.h;
        },
        hide: () => {
            active = false;
        },
        // Unscaled last-placed rect (matches the GUI-space coords passed to set()),
        // or null if currently hidden/never placed. Lets external code (e.g. the
        // tutorial overlay) draw highlights around real, live UI geometry instead
        // of duplicating each layout's position math.
        rect: () => active ? { x: raw.x, y: raw.y, w: raw.w, h: raw.h } : null,
    };
}
let Region = (size) => {
    
    let data = [];
    for (let i = 0; i < size; i++) {
        data.push(Clickable());
    }
    
    return {
        place: (index, ...a) => {
            if (index >= data.length) {
                console.log(index);
                console.log(data);
                throw new Error('Trying to reference a clickable outside a region!');
            }
            data[index].set(...a);
        },
        hide: () => {
            for (let region of data) region.hide();
        },
        check: x => data.findIndex(r => r.check(x)),
        rect: index => index < data.length ? data[index].rect() : null,
        size: () => data.length,
    };
};

let gameDraw;

const global = {
    
    
    KEY_SPECIAL: 192, 

    KEY_ESC: 27,
    KEY_ENTER: 13,
    KEY_SHIFT: 16,
    KEY_BECOME: 70,
    KEY_CHAT: 13,
    KEY_FIREFOOD: 119,
    KEY_SPLIT: 32,

    KEY_LEFT: 65,
    KEY_UP: 87,
    KEY_RIGHT: 68,
    KEY_DOWN: 83,
    KEY_LEFT_ARROW: 37,
    KEY_UP_ARROW: 38,
    KEY_RIGHT_ARROW: 39,
    KEY_DOWN_ARROW: 40,

    KEY_AUTO_SPIN: 67,
    KEY_AUTO_FIRE: 69,
    KEY_AUTO_ALT: 71,
    KEY_OVER_RIDE: 82,
    KEY_REVERSE_TANK: 86,
    KEY_REVERSE_MOUSE: 66,
    KEY_SPIN_LOCK: 88,

    KEY_LEVEL_UP: 78, 
    KEY_TOKEN: 80,
    KEY_CLASS_TREE: 84,
    KEY_MAX_STAT: 77,
    KEY_SUICIDE: 79,
    KEY_ZOOM_OUT: 45,
    KEY_ZOOM_IN: 61,
    KEY_DEBUG: 76,

    KEY_SCREENSHOT: 81,
    KEY_RECORD: 90,
    KEY_TOGGLE_MAP: 70,

    KEY_UPGRADE_ATK: 49,
    KEY_UPGRADE_HTL: 50,
    KEY_UPGRADE_SPD: 51,
    KEY_UPGRADE_STR: 52,
    KEY_UPGRADE_PEN: 53,
    KEY_UPGRADE_DAM: 54,
    KEY_UPGRADE_RLD: 55,
    KEY_UPGRADE_MOB: 56,
    KEY_UPGRADE_RGN: 57,
    KEY_UPGRADE_SHI: 48,
    KEY_MOUSE_0: 32,
    KEY_MOUSE_1: 86,
    KEY_MOUSE_2: 16,
    KEY_CHOOSE_1: 89,
    KEY_CHOOSE_2: 85,
    KEY_CHOOSE_3: 73,
    KEY_CHOOSE_4: 72,
    KEY_CHOOSE_5: 74,
    KEY_CHOOSE_6: 75,

    showTree: false,
    scrollX: 0,
    realScrollX: 0,
    
    screenWidth: window.innerWidth,
    screenHeight: window.innerHeight,
    gameWidth: 0,
    gameHeight: 0,
    xoffset: -0,
    yoffset: -0,
    gameLoading: false,
    gameStart: false,
    gameConnecting: false,
    gameUpdate: false,
    disconnected: false,
    autoSpin: false,
    syncingWithTank: false,
    respawnTimeout: false,
    respawnPending: false,
    showDebug: false,
    died: false,
    kicked: false,
    continuity: false,
    glCanvas: null,
    showChat: 0,
    generateTankTree: false,
    specialPressed: false,
    specialKeysPressed: [],
    backgroundColor: '#f2fbff',
    lineColor: '#000000',
    nameColor: "#FFFFFF",
    message: "",
    player: {},
    messages: [],
    mockups: [],
    missingno: [missingno],
    roomSetup: [],
    entities: [],
    cached: {},
    updateTimes: 0,
    pullUpgradeMenu: false,
    pullSkillBar: false,
    clickables: {
        stat: Region(10),
        upgrade: Region(100),
        clicked: false,
        hover: Region(1),
        skipUpgrades: Region(1),
        mobileButtons: Region(20),
        exitGame: Region(1),
        deathRespawn: Region(1),
        reconnect: Region(1),
        classTreeZoomOut: Region(2),
        classTreeZoomIn: Region(2),
        classTreeClose: Region(1),
        
        dailyTankUpgrade: Clickable(),
        dailyTankAd: Clickable(),
        dailyTankCloseAd: Clickable(),
        royaleSpectate: Region(1),
        royalePrev: Region(1),
        royaleNext: Region(1),
        royaleTab: Region(4),
        optionsMenu: {
            switchButton: Region(2),
            toggleBoxes: Region(100),
            HoverBoxes: Region(100),
        },
        
        
        vault: Region(12)
    },
    dailyTankAd: {
        render: undefined,
        closeable: false,
        renderUI: false,
        readyToRender: false,
        isVideo: false,
        width: 1204,
        height: 670,
        exit: () => {
            try {
                global.dailyTankAd.render.pause();
            } catch { };
            global.dailyTankAd.renderUI = false;
            global.dailyTankAd.readyToRender = false;
            global.dailyTankAd.closeable = false;
            global.dailyTankAd.videoBar = undefined;
            global.dailyTankAd.closebtnAnim = undefined;
            global.dailyTankAd.width = global.dailyTankAd.orginWidth;
            global.dailyTankAd.height = global.dailyTankAd.orginHeight;
            global.dailyTankAd.render = undefined;
        }
    },
    statHover: false,
    upgradeHover: false,
    statMaxing: false,
    metrics: {
        latency: [],
        lag: 0,
        rendertime: 0,
        rendertimes: 1,
        rendertime_color: "not found",
        updatetime: 0,
        lastlag: 0,
        lastrender: 0,
        rendergap: 0,
        lastuplink: 0,
        mspt: 0,
    },
    advanced: {
        roundMap: false,
        blackout: {
            active: false,
            color: "#000000"
        },
    },
    
    gems: {
        carried: 0,
        cap: 0,
        banked: 0,
        combo: 0,
        lastPickup: -1e9,
        flashAt: -1e9,
        fullAt: -1e9,
        popups: [],
    },

    // The war layer: per-round team score, win target and victory state.
    // Fed by the server's 'WR' message once a second.
    war: {
        blue: 0,
        red: 0,
        target: 1,
        over: false,
        winner: 0,        // 0 none, 1 blue, 2 red
        resetIn: 0,       // ms until the round resets (0 while active)
        bonus: 0,         // gems paid to each winner on victory
        at: -1e9,
        victoryAt: -1e9,
    },

    // Personal milestone toasts ("★ 500 BANKED") - transient, client-side.
    milestones: [],

    // Floating combat text. Server-authored (DMG packets) and scaled to 100
    // so every tank reads the same: 20 means a fifth of their life.
    damageNumbers: [],
    structureHits: [],
    killBanners: [],
    hurtAt: -1e9,
    hurtPower: 0,
    deadFlashAt: -1e9,
    celebrateAt: -1e9,
    
    
    leader: { id: -1, x: 0, y: 0, team: 0, at: -1e9 },
    
    teamBanked: { blue: 0, red: 0, at: -1e9 },
    
    teammates: [],
    
    enemyPings: [],
    
    chatMode: 'global',
    
    
    showBigMap: false,
    bigMap: { zoom: 1, cx: 0, cy: 0, dragging: false, lastX: 0, lastY: 0 },
    
    vaults: [],
    vault: {
        onPad: false,
        isOutpost: false,   
        remaining: 0,       
        total: 0,           
        doneAt: -1e9,       
    },
    
    outposts: [],
    outpostState: [],
    
    chambers: [],
    chamberState: [],
    royale: {
        phase: 'idle',
        left: 0,
        alive: 0,
        toast: '',
        winner: null,
        storm: { a: 0, r: 0, max: 1, cx: 0, cy: 0 },
        feed: [],
        occupy: 0,
        lockout: 0,
        place: 0,
        board: [],
        at: -1e9,
        raidId: 0,
        raidLeft: 0,
        youScore: 0,
        youPB: 0,
        objectives: [],
        bloom: null,
        chest: null,
        results: null,
        lock: 0,
        lockLeft: 0,
        you: null,
    },
    raidRespawnAt: 0,
    raidQueued: false,
    royaleBoard: {
        open: false,
        tab: 'map', // map | standings | feed | alive
        sort: 'gems',
    },
    royaleSpectating: false,
    royaleDied: false,
    bandwidth: {
        currentHa: 0,
        currentFa: 0,
        finalHa: 0,
        finalFa: 0,
    },
    mobileStatus: {
        enableCrosshair: false,
        showCrosshair: false,
        useBigJoysticks: false,
        showJoysticks: false,
    },
    GUIStatus: {
        renderGUI: false,
        renderLeaderboard: false,
        renderUpgrades: false,
        renderMinimap: false,
        renderhealth: false,
        renderPlayerNames: false,
        renderPlayerScores: false,
        renderPlayerBars: false,
        renderPlayerKillbar: false,
        minimapReducedInfo: false,
        fullHDMode: false,
    },
    serverStats: {
        players: "?",
        mspt: "?",
        mspt_color: "not found",
        lag_color: "not found",
        serverGamemodeName: "Unknown",
    },
    renderingInfo: {
        entities: 0,
        turretEntities: 0,
        entitiesWithName: 0,
    },
    lerp: (v, z, x) => {
        v = (x - v) / (z - v);
        return 0 >= v ? 0 : 1 <= v ? 1 : v * v * (3 - 2 * v);
    },
    refreshMonitorColoring: (e) => {
        gameDraw = e;
        global.serverStats.mspt_color = gameDraw.color.white;
        global.serverStats.lag_color = gameDraw.color.white;
        global.metrics.rendertime_color = gameDraw.color.white;
    },
    mouse: { x: 0, y: 0 },
    target: { x: 0, y: 0 },
    reverseTank: 1,
    fps: 60,
    serverStart: 0,
    screenSize: Math.min(1920, Math.max(window.innerWidth, 1280)),
    vscreenSize: 1920,
    vscreenSizey: 1080,
    timezoneLocation: new Date().getTimezoneOffset() / -60,
    ratio: window.devicePixelRatio,
    mockupLoading: { then: cb => cb() },
    treeScale: 1,
    chats: {},
    initPlayer: () => {
        global.optionsMenu_Anim = {
            switchMenu_button: util.Smoothbar(0, 2, 3, 0.08, 0.025, true),
            optionsButtonProgress: util.Smoothbar(0, 2, 0.1, 0.08, 0.025, true),
            mainMenu: util.Smoothbar(-500, 2, 3, 0.08, 0.025, true),
            mainMenuHeight: util.Smoothbar(730, 2, 3, 0.08, 0.025, true),
            isOpened: false,
            tabClickables: Region(10),  
            themeClickables: Region(100),
            activeTab: 0, 
            tabs: [["Options", 730], ["Theme", 610], ["Keybinds", 730]],
            tabSlideAnim: util.Smoothbar(0, 0.3, 1.5, 0.03, 0.025, true),
        };
        let list = {
            
            id: -1,
            x: global.screenWidth / 2,
            y: global.screenHeight / 2,
            vx: 0,
            vy: 0,
            lastvx: 0,
            lastvy: 0,
            cx: {
                x: 0,
                animX: 0,
            },
            cy: {
                y: 0,
                animY: 0,
            },
            renderx: 0,
            rendery: 0,
            lastx: global.player.x,
            lasty: global.player.y,
            isScoping: false,
            screenx: 0,
            screeny: 0,
            renderv: 2000,
            animv: new util.animBar(),
            slip: 0,
            view: 1,
            target: global.canvas.target,
            animX: new util.animBar(),
            animY: new util.animBar(),
            roomAnim: {
                x: new util.animBar(),
                y: new util.animBar(),
            },
            name: "",
            lastUpdate: 0,
            time: 0,
            screenWidth: global.screenWidth,
            screenHeight: global.screenHeight,
            nameColor: "#ffffff",
        }
        list.animv.add(list.renderv);
        return list;
    },
    tankTree: (type) => {
        if (type === "open") {
            if (global.died) return;
            global.showTree = true;
            global.pullUpgradeMenu = true;
            global.pullSkillBar = true;
            global.socket.talk('T');
        } else if (type === "exit") {
            global.showTree = false;
            global.renderTankTree = false;
            global.pullUpgradeMenu = false;
            global.pullSkillBar = false;
            global.targetTreeScale = global.treeScale = 1;
            global.scrollX = global.scrollY = global.fixedScrollX = global.fixedScrollY = -1;
            global.scrollVelocityY = global.scrollVelocityX = 0;
            global.classTreeDrag.isDragging = false;
            global.classTreeDrag.momentum = { x: 0, y: 0 };
            global.searchQuery = '';
            global.searchBarActive = false;
            global.canvas.tankTreeProps.enabled = false;
        }
    },
    exit: () => {
        document.getElementById("gameAreaWrapper").style.display = "none";
        global.socket && global.socket.close();
        document.getElementById("startMenuWrapper").style.display = "block";
        global.player = global.initPlayer();
        global.gameLoading = false;
        global.gameStart = false;
        global.gameUpdate = false;
        global.died = false;
        global.disconnected = false;
        global.royaleSpectating = false;
        global.royaleDied = false;
        global.raidRespawnAt = 0;
        global.raidQueued = false;
        global.royaleBarHits = null;
        global.showBigMap = false;
        try {
            Object.assign(global.royale, {
                phase: 'idle', at: -1e9, lock: 0, lockLeft: 0, place: 0,
                occupy: 0, lockout: 0, you: null, youScore: 0, results: null,
                toast: '', board: [], feed: [],
            });
            global.vault.onPad = false;
            global.vault.remaining = 0;
            global.vault.total = 0;
        } catch { /* */ }
        global.entities = [];
        global.roomSetup = [];
        global.messages = [];
        global.milestones = [];
        global.damageNumbers = [];
        global.structureHits = [];
        global.killBanners = [];
        global.hurtAt = -1e9;
        global.hurtPower = 0;
        global.deadFlashAt = -1e9;
        global.celebrateAt = -1e9;
        global.metrics.latency = [];
        global.chats = {};
        global.metrics.rendertime = 0;
        global.metrics.rendertimes = 1;
        global.time = 0;
        global.metrics.lag = 0;
        global.secondaryLoop = false;
        global.gameWidth = 0;
        global.gameHeight = 0;
        global.canvas.mouseMoved = false;
        global.mockups = [];
        global.mobile && document.exitFullscreen();
        clearInterval(global.socketMotionCycle);
        global.resetTarget();
        global.clearUpgrades();
        global.resetSocket();
        setTimeout(() => {
            document.getElementById("startMenuWrapper").style.top = "0px";
        }, 10);
    },
    reconnect: () => {
        global.player = global.initPlayer();
        global.gameLoading = false;
        global.gameStart = false;
        global.gameUpdate = false;
        global.died = false;
        global.disconnected = false;
        global.gameConnecting = true;
        global.message = "";
        global.entities = [];
        global.roomSetup = [];
        global.messages = [];
        global.milestones = [];
        global.damageNumbers = [];
        global.structureHits = [];
        global.killBanners = [];
        global.hurtAt = -1e9;
        global.hurtPower = 0;
        global.deadFlashAt = -1e9;
        global.celebrateAt = -1e9;
        global.metrics.latency = [];
        global.chats = {};
        global.metrics.rendertime = 0;
        global.metrics.rendertimes = 1;
        global.time = 0;
        global.metrics.lag = 0;
        global.secondaryLoop = false;
        global.mockups = [];
        global.canvas.mouseMoved = false;
        clearInterval(global.socketMotionCycle);
        global.resetTarget();
        global.clearUpgrades(true);
        global.resetSocket();
        global.startGame();
    }
};
export { global };
window.global = global;
