import { global } from "./global.js";
import { util } from "./util.js";
import { config } from "./config.js";
import { protocol } from "./protocol.js";
import { gameSound } from "./sound.js";
import * as rankPanel from "./account/rankPanel.js";
import * as rankCeremony from "./account/rankCeremony.js";
import * as dustHud from "./account/dustHud.js";
window.fakeLagMS = 0;
var sync = [];
var clockDiff = 0;
var serverStart = 0;
let levelscore = 0;
let deduction = 0;
let level = 1;
let kills = [0, 0, 0];
let sscore = util.AdvancedSmoothBar(0, 2);
let getNow = () => {
    return Date.now() - clockDiff - serverStart;
},
startSettings = {
    allowtostartgame: true,
    neededtoresync: false,
},
gui = {
    getStatNames: data => {
        return [
            data?.body_damage ?? 'Body Damage',
            data?.max_health ?? 'Max Health',
            data?.bullet_speed ?? 'Bullet Speed',
            data?.bullet_health ?? 'Bullet Health',
            data?.bullet_pen ?? 'Bullet Penetration',
            data?.bullet_damage ?? 'Bullet Damage',
            data?.reload ?? 'Reload',
            data?.move_speed ?? 'Movement Speed',
            data?.shield_regen ?? 'Shield Regeneration',
            data?.shield_cap ?? 'Shield Capacity',
            data?.mining_power ?? 'Mining Power',
        ]
    },
    skills: [
        { amount: 0, color: 'purple', cap: 1, softcap: 1 },
        { amount: 0, color: 'pink'  , cap: 1, softcap: 1 },
        { amount: 0, color: 'blue'  , cap: 1, softcap: 1 },
        { amount: 0, color: 'lgreen', cap: 1, softcap: 1 },
        { amount: 0, color: 'red'   , cap: 1, softcap: 1 },
        { amount: 0, color: 'yellow', cap: 1, softcap: 1 },
        { amount: 0, color: 'green' , cap: 1, softcap: 1 },
        { amount: 0, color: 'teal'  , cap: 1, softcap: 1 },
        { amount: 0, color: 'gold'  , cap: 1, softcap: 1 },
        { amount: 0, color: 'orange', cap: 1, softcap: 1 },
        { amount: 0, color: 'tangerine', cap: 1, softcap: 1 }
    ],
    points: 0,
    upgrades: [],
    playerid: -1,
    __s: {
        setScore: d => {
            d ? (sscore.set(d), deduction > sscore.get() && (deduction = level = 0)) : (levelscore = 3, deduction = level = 0, sscore = util.AdvancedSmoothBar(0, 2))
        },
        setKills: (solo, assists, bosses) => {
            kills = [solo, assists, bosses];
        },
        update: () => {
            levelscore = Math.ceil(Math.pow(level, 3) * 0.3083);
            levelscore = levelscore - deduction;
            if (sscore.get() >= deduction + levelscore) deduction += levelscore, level++;
            else if (sscore.get() < deduction) {
                var d = level - 1;
                deduction = Math.ceil(Math.pow(level, 3) * 0.3083);
                deduction -= levelscore - deduction * d;
                level--
            }
        },
        getProgress: () => levelscore ? Math.min(1, Math.max(0, (sscore.get() - deduction) / levelscore)) : 0,
        getScore: () => sscore.get(),
        getLevel: () => level,
        getKills: () => kills
    },
    type: 0,
    root: "",
    class: "",
    visibleEntities: false,
    dailyTank: {tank: null, ads: false},
    fps: 0,
    color: 0,
    accel: 0,
    topspeed: 1,
};
let xx = 0,
    yy = 0,
    _vx = 0,
    _vy = 0;
var moveCompensation = {
    reset: () => {
        xx = 0;
        yy = 0;
    },
    get: () => {
        if (config.lag.unresponsive) {
            return {
                x: 0,
                y: 0,
            };
        }
        return {
            x: xx,
            y: yy,
        };
    },
    iterate: (g) => {
        if (global.died || global.gameStart) return 0;

        let damp = gui.accel / gui.topSpeed,
            len = Math.sqrt(g.x * g.x + g.y * g.y);
        _vx += gui.accel * g.x / len;
        _vy += gui.accel * g.y / len;

        let motion = Math.sqrt(_vx * _vx + _vy * _vy);
        if (motion > 0 && damp) {
            let finalvelocity = motion / (damp / config.roomSpeed + 1);
            _vx = finalvelocity * _vx / motion;
            _vy = finalvelocity * _vy / motion;
        }
        xx += _vx;
        yy += _vy;
    },
};
const Integrate = class {
    constructor(dataLength) {
        this.dataLength = dataLength;
        this.elements = {};
    }
    reset() {
        this.elements = {};
    }
    update(delta, index = 0) {
        let deletedLength = delta[index++]
        for (let i = 0; i < deletedLength; i++) delete this.elements[delta[index++]]
        let updatedLength = delta[index++]
        for (let i = 0; i < updatedLength; i++) {
            let id = delta[index++]
            let data = delta.slice(index, index + this.dataLength)
            index += this.dataLength
            this.elements[id] = data
        }
        return index
    }
    entries() {
        return Object.entries(this.elements).map(([id, data]) => ({
            id: +id,
            data
        }))
    }
}
const Minimap = class {
    constructor(speed = 250) {
        this.speed = speed
        this.map = {};
        this.lastUpdate = Date.now();
    }
    update(elements) {
        this.lastUpdate = Date.now()
        for (let [key, value] of Object.entries(this.map))
            if (value.now) {
                value.old = value.now
                value.now = null
            } else {
                delete this.map[key]
            }
        for (let element of elements)
            if (this.map[element.id]) {
                this.map[element.id].now = element
            } else {
                this.map[element.id] = {
                    old: null,
                    now: element
                }
            }
    }
    get() {
        let state = Math.min(1, (Date.now() - this.lastUpdate) / this.speed)
        let stateOld = 1 - state
        return Object.values(this.map).map(({ old, now }) => {
            if (!now) return {
                type: old.type,
                id: old.id,
                x: old.x,
                y: old.y,
                color: old.color,
                size: old.size,
                alpha: stateOld,
                width: old.width,
                height: old.height
            }
            if (!old) return {
                type: now.type,
                id: now.id,
                x: now.x,
                y: now.y,
                color: now.color,
                size: now.size,
                alpha: state,
                width: now.width,
                height: now.height
            }
            return {
                type: now.type,
                id: now.id,
                x: state * now.x + stateOld * old.x,
                y: state * now.y + stateOld * old.y,
                color: now.color,
                size: state * now.size + stateOld * old.size,
                alpha: 1,
                width: state * now.width + stateOld * old.width,
                height: state * now.height + stateOld * old.height
            }
        })
    }
}

const Entry = class {
    constructor(to) {
        this.score = util.Smoothbar(0, 10, 3, .03);
        this.isNew = true;
        this.update(to);
    }
    update(to) {
        this.name = to.name;
        this.bar = to.bar;
        if (typeof to.bar === "string" && to.bar.includes(", ")) this.bar = +to.bar.split(", ")[0];
        this.color = to.color;
        this.index = to.index;
        if (this.isNew) {
            this.isNew = false;
            this.score.force(to.score);
        } else this.score.set(to.score);
        this.old = false;
        this.nameColor = to.nameColor;
        this.id = to.id;
        this.label = to.label;
        this.renderEntity = to.renderEntity;
    }
    publish() {
        let indexes = this.index.split("-"),
            ref = global.mockups[parseInt(indexes[0])];
            if (!ref) ref = global.missingno[0];

        return {
            id: this.id,
            color: this.color,
            image: util.requestEntityImage(this.index, this.color),
            position: ref.position,
            barColor: this.bar,
            label: this.name ? this.name + " - " + this.label : this.label,
            score: this.score.get(),
            nameColor: this.nameColor,
            renderEntity: this.renderEntity,
        };
    }
};
const Leaderboard = class {
    constructor() {
        this.entries = {};
    }
    get() {
        let out = [];
        let max = 1;
        for (let value of Object.values(this.entries)) {
            let data = value.publish();
            out.push(data);
            if (data.score > max) max = data.score;
        }
        out.sort((a, b) => b.score - a.score);
        return {
            data: out,
            max
        };
    }
    update(elements) {
        elements.sort((a, b) => b.score - a.score);
        for (let value of Object.values(this.entries)) value.old = true;
        for (let element of elements)
            if (this.entries[element.id]) this.entries[element.id].update(element);
            else this.entries[element.id] = new Entry(element);
        for (let [id, value] of Object.entries(this.entries))
            if (value.old) delete this.entries[id];
    }
};
let minimapAllInt = new Integrate(5),
    minimapTeamInt = new Integrate(3),
    leaderboardInt = new Integrate(8),
    leaderboard = new Leaderboard(),
    minimap = new Minimap(200);
let lags = [];
var lag = {
    get: () => lags.length ? lags.reduce((a, b) => a + b) / lags.length : 0,
    add: l => {
        lags.push(l);
        if (lags.length > config.lag.memory) {
            lags.splice(0, 1);
        }
    }
};

window.WebSocket = window.WebSocket || window.MozWebSocket;

let crawlIndex = 0,
    crawlData = [];
const get = {
    next: () => {
        if (crawlIndex >= crawlData.length) {
            console.log(crawlData);
            throw new Error('Trying to crawl past the end of the provided data!');
        } else {
            return crawlData[crawlIndex++];
        }
    },
    set: (data) => {
        crawlData = data;
        crawlIndex = 0;
    },
    all: () => crawlData.slice(crawlIndex),
    take: amount => {
        crawlIndex += amount;
        if (crawlIndex > crawlData.length) {
            console.error(crawlData);
            throw new Error("Trying to crawl past the end of the provided data!");
        }
    }
};
function physics(g) {
    g.isUpdated = true;
    if (g.motion || g.position) {
        const targetFrameTime = 33.33;
        const actualFrameTime = global.metrics.rendergap || targetFrameTime;
        const dt = actualFrameTime / targetFrameTime;
        const baseDecay = 0.2;
        g.motion -= (baseDecay * g.position) * dt;
        g.position += g.motion * dt;
        if (g.position < 0) {
            g.position = 0;
            g.motion = -g.motion;
        }
        if (g.motion > 0) {
            g.motion *= Math.pow(0.5, dt);
        }
    }
}

const GunContainer = n => {
    let a = [];
    for (let i = 0; i < n; i++) {
        a.push({
            motion: 0,
            position: 0,
            isUpdated: true,
            configLoaded: false,
            color: "",
            borderless: false,
            drawFill: true,
            drawAbove: false,
            length: 0,
            width: 0,
            aspect: 0,
            angle: 0,
            direction: 0,
            offset: 0,
        });
    }
    return {
        getPositions: () => a.map(g => {
            return g.position;
        }),
        getConfig: () => a.map(g => {
            return {
                color: g.color,
                borderless: g.borderless,
                alpha: g.alpha,
                strokeWidth: g.strokeWidth,
                drawFill: g.drawFill,
                drawAbove: g.drawAbove,
                length: g.length,
                width: g.width,
                aspect: g.aspect,
                angle: g.angle,
                direction: g.direction,
                offset: g.offset,
            };
        }),
        setConfig: (ind, c) => {
            let g = a[ind];
            if (!g.configLoaded) {
                g.configLoaded = true;
                g.color = c.color;
                g.borderless = c.borderless;
                g.alpha = c.alpha;
                g.strokeWidth = c.strokeWidth;
                g.drawFill = c.drawFill;
                g.drawAbove = c.drawAbove;
                g.length = c.length;
                g.width = c.width;
                g.aspect = c.aspect;
                g.angle = c.angle;
                g.direction = c.direction;
                g.offset = c.offset;
            }
        },
        update: () => {
            for (let instance of a) {
                physics(instance);
            }
        },
        fire: (i, power) => {
            if (a[i].isUpdated) a[i].motion += Math.sqrt(power) / 20;
            a[i].isUpdated = false;
        },
        length: a.length,
    };
};

function gunIsDrone(z, gunIndex) {
    const idx = z && z.index;
    if (idx == null || !global.mockups) return false;
    const parts = String(idx).split("-");
    let n = 0;
    for (const part of parts) {
        const mock = global.mockups[parseInt(part, 10)];
        if (!mock || !mock.guns) continue;
        if (gunIndex < n + mock.guns.length) return !!mock.guns[gunIndex - n].drone;
        n += mock.guns.length;
    }
    return false;
}

function Status() {
    let statState = 'normal',
        statTime = getNow();
    return {
        set: val => {
            if (val !== statState || statState === 'injured') {
                if (statState !== 'dying') statTime = getNow();
                statState = val;
            }
        },
        getState: () => statState,
        getFade: () => {
            return (statState === 'dying' || statState === 'killed') ? 1 - Math.min(1, (getNow() - statTime) / 300) : 1;
        },
        getColor: () => {
            return '#FFFFFF';
        },
        getBlend: () => {
            let o = (statState === 'normal' || statState === 'dying') ? 0 : 1 - Math.min(1, (getNow() - statTime) / 80);
            if (getNow() - statTime > 500 && statState === 'injured') {
                statState = 'normal';
            }
            return o;
        }
    };
}

// Floating combat text. Hits on the same body within DMG_COMBINE_MS of the
// LAST hit merge into one growing combo. The window resets on every hit, so
// a spray is one number that keeps climbing until you stop for a second.
const DMG_COMBINE_MS = 1000;
function hitWord(amount, taken, hp) {
    if (taken) {
        if (amount >= 18) return "Critical!";
        if (amount >= 8) return "Ow";
        return "";
    }
    if (hp < 0.2) return "Finish";
    if (amount >= 40) return "Crushing!";
    if (amount >= 18) return "Critical!";
    if (amount >= 8) return "Nice";
    return "";
}
function assignHitWord(d, hp) {
    d.word = hitWord(d.amount, d.self, hp);
}
function punchCamera(amount, duration, force) {
    const now = Date.now();
    const apply = (set, amt) => {
        if (!force && set.shakeStartTime !== -1 && now - set.shakeStartTime < 70) {
            set.shakeAmount = Math.max(set.shakeAmount, amt);
            set.shakeDuration = Math.max(set.shakeDuration, duration);
            return;
        }
        set.shakeStartTime = now;
        set.shakeDuration = duration;
        set.shakeAmount = amt;
        set.keepShake = false;
    };
    apply(config.graphical.shakeProperties.CameraShake, amount);
}
function punchUI(amount, duration) {
    const set = config.graphical.shakeProperties.UIShake;
    const now = Date.now();
    set.shakeStartTime = now;
    set.shakeDuration = duration;
    set.shakeAmount = amount;
    set.keepShake = false;
}
// Damage the server attributed to or against us. targetId locates the body to
// float the number over; taken=true means we were the one hit. amount is
// already scaled to 100 (percent of the target's max health). tier 0/1/2 =
// normal / Nice! / Critical!.
function pushDamageNumber(targetId, amount, tier, taken) {
    if (!(amount >= 1)) return;
    const target = global.entities.find(e => e.id === targetId);
    // Out of view (or already gone) - nothing to anchor a number to.
    if (!target) return;
    const now = performance.now();
    const hp = target.health || 0;
    const list = global.damageNumbers;
    for (let i = list.length - 1; i >= 0; i--) {
        const d = list[i];
        if (d.id !== targetId || d.self !== taken) continue;
        // combo window is from the LAST hit, not the first - keep adding as
        // long as you don't let a second of silence through.
        if (now - d.comboAt > DMG_COMBINE_MS) break;
        d.amount += amount;
        d.tier = Math.max(d.tier, tier);
        if (d.amount >= 18) d.tier = Math.max(d.tier, 2);
        else if (d.amount >= 8) d.tier = Math.max(d.tier, 1);
        d.combo = (d.combo || 1) + 1;
        d.comboAt = now;
        d.x = target.x;
        d.y = target.y;
        d.punch = now;
        assignHitWord(d, hp);
        applyHitJuice(amount, d.tier, taken);
        return;
    }
    const entry = {
        id: targetId,
        x: target.x,
        y: target.y,
        amount,
        tier,
        self: taken,
        born: now,
        comboAt: now,
        combo: 1,
        punch: 0,
        jitter: Math.random() * 2 - 1,
        word: "",
    };
    assignHitWord(entry, hp);
    list.push(entry);
    applyHitJuice(amount, tier, taken);
    if (list.length > 8) list.splice(0, list.length - 8);
}
// Rock chips are individual - no combo, no callouts, no shake. Only the
// person who landed the shot sees the number.
global.pushRockDamage = (x, y, amount, ownerId, ore) => {
    if (ownerId !== gui.playerid) return;
    if (!(amount >= 1)) return;
    const now = performance.now();
    const list = global.damageNumbers;
    list.push({
        id: 0,
        x, y,
        amount,
        tier: 0,
        self: false,
        born: now,
        comboAt: now,
        combo: 1,
        punch: 0,
        jitter: Math.random() * 2 - 1,
        word: "",
        kind: "rock",
        ore: ore | 0,
        holdMs: 220,
        fadeMs: 620,
    });
    if (list.length > 10) list.splice(0, list.length - 10);
};
function mockupOf(z) {
    if (!z?.index) return null;
    return global.mockups[parseInt(z.index.split("-")[0])] || null;
}
function spawnStructureHit(z) {
    const m = mockupOf(z);
    if (!m) return;
    const chamber = m.className === "coreChamber" || m.name === "Core Chamber";
    const outpost = m.className === "outpostBanner" || m.name === "Outpost";
    const chest = m.name === "Copper Chest" || m.name === "Epic Chest";
    if (!chamber && !outpost && !chest) return;

    let cx = z.x, cy = z.y, rim;
    if (chest) {
        rim = (z.size || 26) * 0.92;
    } else if (chamber) {
        const ch = (global.chambers || []).find(c => Math.hypot(c.x - z.x, c.y - z.y) < 80);
        if (ch) { cx = ch.x; cy = ch.y; }
        const st = ch && (global.chamberState || []).find(s => s.id === ch.id);
        const scale = (st && st.st === 2) ? Math.max(0.05, st.s || 1) : 1;
        // Outer face of the ring (radius 160), not 0.88×size which lands
        // inside the hollow pocket where the treasury gems sit.
        rim = (ch ? ch.r : 160) * scale;
    } else {
        rim = (z.size || 60) * 0.72;
    }

    const snapToRim = (x, y) => {
        const dx = x - cx, dy = y - cy;
        const d = Math.hypot(dx, dy) || 1;
        return { x: cx + dx / d * rim, y: cy + dy / d * rim };
    };

    // Prefer a live projectile sitting on the rim — that's the collision.
    let best = 48, hx = null, hy = null;
    for (const e of global.entities) {
        if (!e || e.id === z.id || e.id === gui.playerid) continue;
        if (e.drawsHealth || e.nameplate) continue;
        if ((e.size || 99) > 28) continue;
        const err = Math.abs(Math.hypot(e.x - cx, e.y - cy) - rim);
        if (err < best) { best = err; hx = e.x; hy = e.y; }
    }

    if (hx == null) {
        // Aim ray vs the ring, else the face toward the tank.
        const px = global.player.renderx, py = global.player.rendery;
        const aim = global.player.target;
        const adx = aim ? aim.x : 0, ady = aim ? aim.y : 0;
        const al = Math.hypot(adx, ady);
        if (al > 4) {
            // |P + t D - C| = rim, smallest t > 0.
            const dx = adx / al, dy = ady / al;
            const fx = px - cx, fy = py - cy;
            const b = fx * dx + fy * dy;
            const c = fx * fx + fy * fy - rim * rim;
            const disc = b * b - c;
            if (disc >= 0) {
                const t = -b - Math.sqrt(disc);
                if (t > 0) { hx = px + dx * t; hy = py + dy * t; }
            }
        }
        if (hx == null) {
            const p = snapToRim(px, py);
            hx = p.x; hy = p.y;
        }
    } else {
        const p = snapToRim(hx, hy);
        hx = p.x; hy = p.y;
    }

    if (window.terrainRenderer && window.terrainRenderer.addHitMarker)
        window.terrainRenderer.addHitMarker(hx, hy);
    if (gameSound.rockHit) gameSound.rockHit(hx, hy, 0, false);
}
function applyHitJuice(amount, tier, taken) {
    const t = Math.min(1, Math.max(0, amount) / 100);
    punchCamera(4 + t * 28, 120 + t * 160);
    if (taken) {
        global.hurtAt = performance.now();
        global.hurtPower = Math.min(1, 0.38 + amount / 50);
        if (gameSound.combatHurt) gameSound.combatHurt(Math.min(1, amount / 40));
    } else {
        if (gameSound.combatHit) gameSound.combatHit(tier);
    }
}

const process = (z = {}) => {
    let isNew = z.facing == null;

    let type = get.next();

    if (type & 0x01) {
        z.facing = get.next();
        z.layer = get.next();
        z.index = get.next();
        z.color = get.next();
        z.size = get.next();
        z.realSize = get.next();
        z.sizeFactor = get.next();
        z.angle = get.next();
        z.direction = get.next();
        z.offset = get.next();
        z.mirrorMasterAngle = get.next();
    } else {
        z.interval = global.metrics.rendergap;
        z.id = get.next();

        let i = global.entities.findIndex(x => x.id === z.id);
        if (i !== -1) {

            z = global.entities.splice(i, 1)[0];
        }

        isNew = i === -1;

        if (!isNew) {
            z.render.lastx = z.x;
            z.render.lasty = z.y;
            z.render.lastvx = z.vx;
            z.render.lastvy = z.vy;
            z.render.lastf = z.facing;
            z.render.lastRender = global.player.time;
        }

        if (type & 0x10) {
            z.index = get.next();
            z.x = get.next();
            z.y = get.next();
            z.vx = get.next();
            z.vy = get.next();
            z.size = get.next();
            let oldFacing = z.facing;
            z.facing = get.next();
            z.vfacing = isNew ? z.facing : z.facing - oldFacing;
            z.vfacing = get.next();
            z.layer = get.next();
            z.color = get.next();
        } else {
            z.index = get.next();
            z.x = get.next();
            z.y = get.next();
            z.vx = get.next();
            z.vy = get.next();
            z.size = get.next();
            let oldFacing = z.facing;
            z.facing = get.next();
            z.vfacing = isNew ? z.facing : z.facing - oldFacing;
            z.vfacing = get.next();
            z.twiggle = get.next();
            z.layer = get.next();
            z.color = get.next();
            z.borderless = get.next();
            z.drawFill = get.next();
        }
        let invuln = type & 0x10 ? 0 : get.next();
        z.invuln = invuln ? z.invuln || Date.now() : 0;

        if (isNew) {
            z.health = get.next() / 65535;
            z.shield = get.next() / 65535;
        } else {
            let hh = z.health,
                ss = z.shield;
            z.health = get.next() / 65535;
            z.shield = get.next() / 65535;

            // Taking damage used to be inferred here and flashed white. The
            // blink is now driven by the server's hitFlash field below, so this
            // branch is only left to clear a stale death fade.
            if (z.health >= hh && z.shield >= ss && z.render.status.getFade() !== 1) {
                z.render.status.set('normal');
            }
        }
        z.alpha = get.next() / 255;
        // Hit feedback. These mirror the two fields appended after alpha in the
        // server's flatten() - the order here has to match it exactly.
        let hitFlash = get.next() / 255;
        z.maxHealthN = get.next();
        z.healthN = z.health * z.maxHealthN;
        z.drawsHealth = !!(type & 0x02);

        if (type & 0x04) {
            z.name = get.next();
            z.score = get.next();
            z.digWarsGoal = get.next();
            z.gemGlow = get.next() | 0;
            // accounts (Phase 2 wire): name style nid, rank code, skin nid
            z.nameStyle = get.next() | 0;
            z.rankCode = get.next() | 0;
            z.skin = get.next() | 0;
            // your own style, for the HUD name (your nameplate is not drawn)
            if (z.id === gui.playerid) global.myNameStyle = z.nameStyle;
        }
        z.nameplate = type & 0x04;

        if (isNew) {
            z.render = {
                draws: true,
                expandsWithDeath: z.drawsHealth,
                lastRender: global.player.time,
                x: z.x,
                y: z.y,
                lastx: z.x - global.metrics.rendergap * config.roomSpeed * (1000 / 40) * z.vx,
                lasty: z.y - global.metrics.rendergap * config.roomSpeed * (1000 / 40) * z.vy,
                lastvx: z.vx,
                lastvy: z.vy,
                lastf: z.facing,
                f: z.facing,
                h: z.health,
                s: z.shield,
                interval: global.metrics.rendergap,
                slip: 0,
                status: Status(),
                size: new util.animBar(),
                health: util.AdvancedSmoothBar(z.health, 0.06, 1),
                shield: util.AdvancedSmoothBar(z.shield, 0.06, 1),
                xAnim: new util.animBar(),
                yAnim: new util.animBar(),
                faceAnim: new util.animBar(!0),
            };
        }
        if (invuln) {
            z.render.status.set('invuln');
        } else if (z.render.status.getState() === 'invuln') {
            z.render.status.set('normal');
        }

        // Server-driven red blink. We only take the rising edge of hitFlash and
        // let the renderer animate its own eased decay from that stamp, so the
        // blink looks identical whatever the tick rate does and a dropped packet
        // costs at most one blink instead of a stuck-on flash.
        if (!isNew && hitFlash > (z.hitFlash || 0)) {
            z.render.hitAt = performance.now();
            spawnStructureHit(z);
        }
        z.hitFlash = hitFlash;

        z.render.health.set(z.health);
        z.render.shield.set(z.shield);
        z.render.size.add(z.size);
        z.render.xAnim.add(z.x);
        z.render.yAnim.add(z.y);
        z.render.faceAnim.add(z.facing);

        if (!isNew && z.oldIndex !== z.index) isNew = true;
        z.oldIndex = z.index;
    }

    let gunnumb = get.next();
    if (isNew) {
        z.guns = GunContainer(gunnumb);
    } else if (gunnumb !== z.guns.length) {
        // A tank can gain or lose a barrel without changing class (a shop
        // sidearm mounts on the live body). Rebuild the container instead of
        // aborting the whole update packet.
        z.guns = GunContainer(gunnumb);
    }

    for (let i = 0; i < gunnumb; i++) {
        let time = get.next(),
            power = get.next(),
            color = get.next(),
            alpha = get.next(),
            strokeWidth = get.next(),
            borderless = get.next(),
            drawFill = get.next(),
            drawAbove = get.next(),
            length = get.next(),
            width = get.next(),
            aspect = get.next(),
            angle = get.next(),
            direction = get.next(),
            offset = get.next();
        z.guns.setConfig(i, {color, alpha, strokeWidth, borderless, drawFill, drawAbove, length, width, aspect, angle, direction, offset});
        if (time > global.player.lastUpdate - global.metrics.rendergap) {
            z.guns.fire(i, power);
            if (z.x !== undefined) {
                if (gunIsDrone(z, i)) gameSound.droneSpawn(z.x, z.y);
                else gameSound.shoot(z.x, z.y, power);
            }
        }
    }

    let turnumb = get.next();
    if (isNew || z.turrets.length !== turnumb) {
        z.turrets = [];
        for (let i = 0; i < turnumb; i++) {
            z.turrets.push(process());
        }
    } else {
        if (z.turrets.length !== turnumb) {
            throw new Error('Mismatch between data turret number and remembered turret number!');
        }
        for (let tur of z.turrets) {
            tur = process(tur);
        }
    }

    return z;
};

const convert = {
    begin: data => get.set(data),

    data: () => {

        let output = [];

        for (let i = 0, len = get.next(); i < len; i++) {
            output.push(process());
        }

        for (let e of global.entities) {

            e.render.status.set(e.health === 1 ? 'dying' : 'killed');

            if (e.render.status.getFade() !== 0 && util.isInView(e.render.x - global.player.renderx, e.render.y - global.player.rendery, e.size, true)) {
                output.push(e);
            } else {
                if (global.chats[e.id]) {
                    for (let o of global.chats[e.id]) {
                        util.remove(global.chats[e.id], global.chats[e.id].indexOf(o));
                    };
                    delete global.chats[e.id];
                };
                if (e.render.textobjs != null) {
                    for (let o of e.render.textobjs) {
                        o.remove();
                    }
                }
            }
        }

        global.entities = output;
        global.entities.sort((a, b) => {
            let sort = a.layer - b.layer;
            if (!sort) sort = b.id - a.id;
            if (!sort) throw new Error('tha fuq is up now');
            return sort;
        });
    },

    gui: () => {
        let index = get.next(),

            indices = {
                dailyTank: index & 0x1000,
                visibleName: index & 0x0800,
                class: index & 0x0400,
                root: index & 0x0200,
                topspeed: index & 0x0100,
                accel: index & 0x0080,
                skills: index & 0x0040,
                statsdata: index & 0x0020,
                upgrades: index & 0x0010,
                points: index & 0x0008,
                score: index & 0x0004,
                label: index & 0x0002,
                fps: index & 0x0001,
            };

        if (indices.fps) {
            gui.fps = get.next();
        }
        if (indices.label) {
            gui.type = get.next();
            gui.color = get.next();
            gui.playerid = get.next();
        }
        if (indices.score) {
            let score = JSON.parse(get.next());
            gui.__s.setScore(score[0]);
            gui.__s.setKills(score[1], score[2], score[3]);
        }
        if (indices.points) {
            gui.points = get.next();
        }
        if (indices.upgrades) {
            gui.upgrades = [];
            for (let i = 0, len = get.next(); i < len; i++) {
                gui.upgrades.push(get.next().split("_"));
                gui.upgrades[i][2] = util.requestEntityImage(gui.upgrades[i][2], gui.color);
            }
        }
        if (indices.statsdata) {
            for (let i = 9; i >= 0; i--) {
                gui.skills[i].name = get.next();
                gui.skills[i].cap = get.next();
                gui.skills[i].softcap = get.next();
            }
            // mining power rides last on the wire
            gui.skills[10].name = get.next();
            gui.skills[10].cap = get.next();
            gui.skills[10].softcap = get.next();
        }
        if (indices.skills) {
            let skk = get.next();
            gui.skills[0].amount = parseInt(skk.slice( 0,  2), 16);
            gui.skills[1].amount = parseInt(skk.slice( 2,  4), 16);
            gui.skills[2].amount = parseInt(skk.slice( 4,  6), 16);
            gui.skills[3].amount = parseInt(skk.slice( 6,  8), 16);
            gui.skills[4].amount = parseInt(skk.slice( 8, 10), 16);
            gui.skills[5].amount = parseInt(skk.slice(10, 12), 16);
            gui.skills[6].amount = parseInt(skk.slice(12, 14), 16);
            gui.skills[7].amount = parseInt(skk.slice(14, 16), 16);
            gui.skills[8].amount = parseInt(skk.slice(16, 18), 16);
            gui.skills[9].amount = parseInt(skk.slice(18, 20), 16);
            gui.skills[10].amount = skk.length >= 22 ? parseInt(skk.slice(20, 22), 16) : 0;
        }
        if (indices.accel) {
            gui.accel = get.next();
        }
        if (indices.topspeed) {
            gui.topspeed = get.next();
        }
        if (indices.root) {
            gui.root = get.next();
        }
        if (indices.class) {
            gui.class = get.next();
        }
        if (indices.visibleName) {
            gui.visibleEntities = get.next();
        }
        if (indices.dailyTank) {
            let dailyTank = JSON.parse(get.next());
            if (!dailyTank[0]) gui.dailyTank = {tank: null, ads: false};
            else {
                gui.dailyTank.tank = dailyTank[0];
                gui.dailyTank.ads = dailyTank[1];
            }
        }
    },
    broadcast: () => {
        let all = get.all();
        let by = minimapAllInt.update(all);
        by = minimapTeamInt.update(all, by);
        by = leaderboardInt.update(all, by);
        get.take(by);
        let map = [];
        for (let {
            id,
            data
        } of minimapAllInt.entries()) {
            map.push({
                id,
                type: data[0],
                x: (data[1] * global.gameWidth) / 255,
                y: (data[2] * global.gameHeight) / 255,
                color: data[3],
                size: data[4]
            });
        }
        for (let {
            id,
            data
        } of minimapTeamInt.entries()) {
            map.push({
                id,
                type: 0,
                x: (data[0] * global.gameWidth) / 255,
                y: (data[1] * global.gameHeight) / 255,
                color: data[2],
                size: 0
            });
        }
        minimap.update(map);
        let entries = [];
        for (let {
            id,
            data
        } of leaderboardInt.entries()) {
            entries.push({
                id,
                score: data[0],
                index: data[1],
                name: data[2],
                color: data[3],
                bar: data[4],
                nameColor: data[5],
                label: data[6],
                renderEntity: data[7],
            })
        }
        leaderboard.update(entries);
    }
};

const protocols = {
    "http:": "ws://",
    "https:": "wss://"
};
// One id per tab (survives a refresh, not shared between tabs). Sent on every
// connect so the server can hand a dropped player their raid back.
const resumeToken = (() => {
    try {
        let t = sessionStorage.getItem("dwResumeToken");
        if (!t) {
            t = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, "0")).join("");
            sessionStorage.setItem("dwResumeToken", t);
        }
        return t;
    } catch (e) { return Math.random().toString(36).slice(2) + Date.now().toString(36); }
})();
const RECONNECT_TRIES = 8;

let incoming = async function(message, socket) {
    // only defer when fake lag is actually on: a 0 ms setTimeout still pushes
    // every packet to a later task, sometimes behind a whole render frame
    if (window.fakeLagMS > 0) await new Promise(Resolve => setTimeout(Resolve, window.fakeLagMS));

    global.bandwidth.currentFa += message.data.byteLength;
    let m = protocol.decode(message.data);
    if (m === -1) {
        throw new Error('Malformed packet.');
    }

    switch (m.shift()) {
        case 'W': {
            if (m[0]) {
                global.message = '';
                socket.talk('k', global.playerKey);

                socket.ping = (payload) => {
                    socket.talk('p', payload);
                };
                socket.commandCycle = setInterval(() => {
                    if (socket.cmd.check()) socket.cmd.talk();
                });
            }
        }; break;

            case 'w': {
                if (m[0]) {
                    socket.talk('RZ', resumeToken);
                    socket.talk('s', "", 1, 0, false, 0);
                }
            }; break;
            case 'R': {
                global.gameWidth = m[0];
                global.gameHeight = m[1];
                global.player.roomAnim.x.add(m[0]);
                global.player.roomAnim.y.add(m[1]);
                global.roomSetup = JSON.parse(m[2]);
                serverStart = JSON.parse(m[3]);
                global.serverStart = serverStart;
                config.roomSpeed = m[4];
                let blackoutData = JSON.parse(m[5]);
                global.advanced.blackout.active = blackoutData.active;
                global.advanced.blackout.color = blackoutData.color;
                global.advanced.roundMap = m[6] == "circle" ? true : false;
                global.digRoyaleMode = false;

                socket.talk('S', getNow());
            } break;
            case "r": {
                global.gameWidth = m[0];
                global.gameHeight = m[1];
                global.player.roomAnim.x.add(m[0]);
                global.player.roomAnim.y.add(m[1]);
                global.roomSetup = JSON.parse(m[2]);
            } break;
            case 'TG': {
                const cols = m[0], rows = m[1];
                const cells = JSON.parse(m[2]);
                const rockState = m[3] ? JSON.parse(m[3]) : [];
                const oreState  = m[4] ? JSON.parse(m[4]) : [];
                const oreSalt   = m[5] | 0;
                global.vaults   = m[6] ? JSON.parse(m[6]) : [];
                global.outposts = m[7] ? JSON.parse(m[7]) : [];
                global.chambers = m[8] ? JSON.parse(m[8]) : [];
                global.digRoyaleMode = m[9] === 1;
                try { global.shops = m[10] ? JSON.parse(m[10]) : []; } catch (e) { global.shops = []; }
                if (window.terrainRenderer) window.terrainRenderer.init(cells, cols, rows, rockState, oreState, oreSalt);
            } break;
            case 'TUTI': {
                // Tutorial only: the landmarks of this learner's private plot.
                try { global.tutorialPlot = JSON.parse(m[0]); } catch (e) { }
            } break;
            case 'OP': {
                let next = [];
                try { next = JSON.parse(m[0]); } catch (e) { break; }
                const prev = global.outpostState || [];
                if (prev.length) {
                    for (const s of next) {
                        const old = prev.find(p => p.id === s.id);
                        if (old && s.t && s.t !== old.t && gameSound.bankCelebrate)
                            gameSound.bankCelebrate();
                    }
                }
                global.outpostState = next;
            } break;
            case 'CC': {
                let next = [];
                try { next = JSON.parse(m[0]); } catch (e) { break; }
                const prev = global.chamberState || [];
                if (prev.length) {
                    for (const s of next) {
                        const old = prev.find(p => p.id === s.id);
                        if (old && s.st === 1 && old.st !== 1 && gameSound.bankCelebrate)
                            gameSound.bankCelebrate();
                    }
                }
                global.chamberState = next;
            } break;
            case 'OU': {
                
                
                global.vault.onPad = !!m[0];
                global.vault.isOutpost = !!m[0];
            } break;
            case 'EP': {
                
                
                const by = m[2];
                for (let i = global.enemyPings.length - 1; i >= 0; i--) {
                    if (global.enemyPings[i].by === by) global.enemyPings.splice(i, 1);
                }
                global.enemyPings.push({ x: m[0], y: m[1], by, at: performance.now() });
                if (global.enemyPings.length > 16) global.enemyPings.shift();
            } break;
            case 'TM': {
                
                const n = m[0];
                const list = [];
                for (let i = 0; i < n; i++) {
                    const o = 1 + i * 4;
                    list.push({ id: m[o], name: m[o + 1], x: m[o + 2], y: m[o + 3] });
                }
                global.teammates = list;
            } break;            case 'TB': {
                
                
                const tb = global.teamBanked;
                tb.blue = m[0];
                tb.red = m[1];
                tb.at = performance.now();
            } break;
            case 'WR': {
                // War state: blue, red, target, over(0/1), winner(0/1/2), resetIn ms, win bonus
                const w = global.war;
                const wasOver = w.over;
                w.blue = m[0] | 0;
                w.red = m[1] | 0;
                w.target = m[2] | 0;
                w.over = !!m[3];
                w.winner = m[4] | 0;
                w.resetIn = m[5] | 0;
                w.bonus = m[6] | 0;
                w.at = performance.now();
                if (w.over && !wasOver) w.victoryAt = performance.now();
            } break;
            case 'RY': {
                try {
                    const d = JSON.parse(m[0]);
                    const r = global.royale;
                    r.phase = d.phase || 'live';
                    r.left = d.left | 0;
                    r.alive = d.alive | 0;
                    r.toast = d.toast || '';
                    r.winner = d.winner || null;
                    r.storm = d.storm || r.storm;
                    r.feed = d.feed || [];
                    r.board = d.board || [];
                    r.at = performance.now();
                    r.raidId = d.raidId | 0 || d.matchId | 0 || r.raidId;
                    r.raidLeft = d.raidLeft | 0 || d.left | 0;
                    r.youScore = d.youScore | 0;
                    r.youPB = d.youPB | 0;
                    r.objectives = d.objectives || [];
                    r.bloom = d.bloom || null;
                    r.chest = d.chest || null;
                    r.results = d.results || null;
                    r.lock = d.lock | 0;
                    r.lockLeft = d.lockLeft | 0;
                    r.ending = d.ending | 0;      // between raids
                    r.nextIn = d.nextIn | 0;      // ...seconds to the next one
                    r.you = d.you || null;
                    r.matchId = d.matchId | 0;
                    r.chests = d.chests || [];
                    r.event = d.event || null;
                    r.mod = d.mod || null;
                    // a new override: a popup that says what it does. The first
                    // one after joining waits a moment so it is not lost in the
                    // spawn messages.
                    if (r.mod && r.mod.id && r.mod.id !== r._modSeenId) {
                        const firstMod = !r._modSeenId;
                        r._modSeenId = r.mod.id;
                        global.callouts = global.callouts || [];
                        global.callouts.push({ kind: "override", text: (firstMod ? "OVERRIDE: " : "NEW OVERRIDE: ") + String(r.mod.name).toUpperCase(), sub: String(r.mod.desc || ""), born: performance.now() + (firstMod ? 1800 : 0), dur: 4500 });
                    }
                    r.pings = d.pings || [];
                    // boss surfaced / gone: sound + camera punch once
                    const bossNow = d.boss || null;
                    if (bossNow && bossNow.id !== r.bossSeenId) {
                        r.bossSeenId = bossNow.id;
                        punchCamera(18, 380, true);
                        if (gameSound.oreBreak) gameSound.oreBreak(global.player.renderx, global.player.rendery, 3);
                    } else if (!bossNow) r.bossSeenId = 0;
                    r.boss = bossNow;
                    // leaderboard hits: passing someone, or getting passed
                    const placeNow = d.youPlace | 0;
                    if (placeNow > 0 && r.lastPlace > 0 && placeNow !== r.lastPlace && !global.died && r.board && r.board.length) {
                        if (placeNow < r.lastPlace) {
                            const below = r.board.find(row => row.place === placeNow + 1);
                            global.createMessage("You passed " + (below ? below.name : "someone") + " - now #" + placeNow, 3200);
                            if (gameSound.gemPickup) gameSound.gemPickup(3);
                        } else {
                            const above = r.board.find(row => row.place === placeNow - 1);
                            global.createMessage((above ? above.name : "Someone") + " passed you - now #" + placeNow, 3200);
                        }
                    }
                    if (placeNow > 0) r.lastPlace = placeNow;
                    // Died before the first RY: promote to the raid screen now.
                    // Killer cam owns the first 3s after F, so hands off here.
                    if (global.died && !global.royaleDied && !(global.royaleKillerCamUntil && performance.now() < global.royaleKillerCamUntil) && (d.raidId || d.matchId)) {
                        global.royaleDied = true;
                        global.royaleSpectating = false;
                        if (!global.raidRespawnAt) global.raidRespawnAt = performance.now() + 15000;
                        try {
                            global.vault.onPad = false;
                            global.vault.remaining = 0;
                            global.vault.total = 0;
                        } catch { /* */ }
                    }
                    if (d.youPlace > 0) r.place = d.youPlace | 0;
                    // Queued for the final storm: watch until the reset drops us in.
                    if (r.lock && global.raidQueued && !global.died && !global.disconnected) {
                        global.royaleSpectating = true;
                    }
                    if (d.youPB > 0) {
                        try {
                            const prev = parseInt(localStorage.getItem('digwarsRaidPB') || '0', 10) || 0;
                            if (d.youPB > prev) localStorage.setItem('digwarsRaidPB', String(d.youPB));
                        } catch { /* */ }
                    }
                } catch (e) { /* ignore */ }
            } break;
            case 'RYP': {
                global.royale.place = m[0] | 0;
            } break;
            case 'SHC': {
                try { global.shop.catalog = JSON.parse(m[0]) || []; } catch (e) { global.shop.catalog = []; }
            } break;
            case 'SHP': {
                try {
                    const d = JSON.parse(m[0]);
                    const sh = global.shop;
                    const prevArm = sh.state.arm, prevDrill = sh.state.drill;
                    const prevKit = sh.state.kit || {};
                    sh.state = { drill: d.drill | 0, gear: d.gear || [], kit: d.kit || {}, kitOrder: d.kitOrder || [], arm: d.arm || null, armUntil: +d.armUntil || 0, gearUntil: d.gearUntil || {} };
                    // slot flashes: gold when an item arrives, white when one is spent
                    sh.slotFlash = sh.slotFlash || {};
                    const nowF = performance.now();
                    for (const id of new Set([...Object.keys(prevKit), ...Object.keys(sh.state.kit)])) {
                        const a = prevKit[id] | 0, b = sh.state.kit[id] | 0;
                        if (b > a) sh.slotFlash[id] = { at: nowF, kind: "get" };
                        else if (b < a) sh.slotFlash[id] = { at: nowF, kind: "use" };
                    }
                    if ((sh.state.drill | 0) > (prevDrill | 0)) sh.drillFlashAt = nowF;
                    if (sh.state.arm && sh.state.arm !== prevArm) sh.armFlashAt = nowF;
                    if (d.msg) { sh.msg = d.msg; sh.msgAt = performance.now(); sh.msgOk = !!d.ok; }
                    if (d.msg && d.ok && gameSound.bankCelebrate) gameSound.bankCelebrate();
                    else if (d.msg && gameSound.uiClick) gameSound.uiClick();
                } catch (e) { /* */ }
            } break;
            case 'SHU': {
                const sh = global.shop;
                const on = !!m[0];
                if (on && !sh.onPad) { sh.dismissed = false; sh.sel = null; sh.hover = -1; }
                sh.onPad = on;
                sh.padId = m[1] | 0;
                sh.padName = m[2] || "";
            } break;
            case 'KC': {
                // Raid over: its own full-screen moment, not a queued callout.
                if (m[0] === "raidend") {
                    global.raidEndFx = { at: performance.now(), sub: typeof m[3] === "string" ? m[3] : "" };
                    global.callouts.length = 0;
                    if (gameSound.bankCelebrate) gameSound.bankCelebrate();
                    break;
                }
                // kind, text, points: the big centre callout
                const list = global.callouts;
                const prev = list.length ? list[list.length - 1].born : -1e9;
                list.push({ kind: m[0] || "kill", text: m[1] || "", pts: m[2] | 0, sub: typeof m[3] === "string" ? m[3] : undefined, born: Math.max(performance.now(), prev + 700) });
                if (list.length > 5) list.shift();
                if (m[0] === "boss" || m[0] === "quest") { punchUI(8, 260); if (gameSound.bankCelebrate) gameSound.bankCelebrate(); }
            } break;
            case 'FX': {
                const kindF = m[2] || "ring";
                const nowF = performance.now();
                const fx = { x: m[0] | 0, y: m[1] | 0, kind: kindF, born: nowF };
                const dxf = fx.x - global.player.renderx, dyf = fx.y - global.player.rendery;
                const nearF = Math.hypot(dxf, dyf);
                let pushFx = true;
                if (kindF === "chest" || kindF === "chestrare") {
                    // the terrain renderer breaks the chest exactly like a rock
                    // cell (chips, sparks, flash, dust, shake); the floor halo
                    // fades out from this moment
                    const rows = (global.royale && global.royale.chests) || [];
                    const row = rows.find(r => Math.abs(r.x - fx.x) < 60 && Math.abs(r.y - fx.y) < 60);
                    const eid = row && row.e != null ? row.e : 0;
                    const size = (row ? row.rare : kindF === "chestrare") ? 40 : 36;
                    if (eid && global.chestGoneAt) global.chestGoneAt.set(eid, nowF);
                    const hold = nearF < 800 ? 55 : 0;
                    if (hold) global.hitStop = Math.max(global.hitStop || 0, Date.now() + hold);
                    const tr = window.terrainRenderer;
                    if (tr && tr.shatterAt) {
                        tr.shatterAt(fx.x, fx.y, size * 1.02, kindF === "chestrare" ? 3 : 1, hold, -(1000000 + eid));
                        if (eid && tr.dropCell) tr.dropCell(-(1000000 + eid));
                    }
                    pushFx = false;
                }
                if (kindF === "bossdead") {
                    const b = (global.royale && global.royale.boss) || global._lastBoss;
                    fx.col = (b && b.c) || "#c9a8ff";
                    if (nearF < 1600) global.hitStop = Math.max(global.hitStop || 0, Date.now() + 90);
                }
                if (pushFx) {
                    global.fx.push(fx);
                    if (global.fx.length > 24) global.fx.shift();
                }
                try {
                    if (nearF < 900) {
                        if (m[2] === "meteor" || m[2] === "charge") { punchCamera(14, 260, true); gameSound.rockBreak(m[0] | 0, m[1] | 0); }
                        if (m[2] === "bossdead") { punchCamera(44, 650, true); gameSound.oreBreak(m[0] | 0, m[1] | 0, 4); }
                        if (m[2] === "chest" || m[2] === "chestrare") { punchCamera(m[2] === "chestrare" ? 16 : 10, 240, true); gameSound.oreBreak(m[0] | 0, m[1] | 0, m[2] === "chestrare" ? 3 : 2); }
                    }
                } catch (e) { /* */ }
            } break;
            case 'RYO': {
                global.royale.occupy = m[1] | 0;
                global.royale.lockout = m[2] | 0;
            } break;
            case 'DMG': {
                // Combat text: targetId, amount (0-100 of max hp), tier
                // (0/1/2), taken (0 = we dealt it, 1 = we took it).
                pushDamageNumber(m[0], m[1] | 0, m[2] | 0, !!(m[3] | 0));
            } break;
            case 'DEAD': {
                // You just killed someone. Skull + DEAD! at their last spot.
                const now = performance.now();
                const list = global.killBanners;
                list.push({ x: m[0] | 0, y: m[1] | 0, born: now });
                if (list.length > 4) list.shift();
                global.deadFlashAt = now;
                punchCamera(36, 340, true);
                punchUI(10, 280);
                if (gameSound.combatKill) gameSound.combatKill();
            } break;
            case 'MS': {
                // Personal achievement: kind, threshold, bonus paid
                const kind = m[0] | 0, at = m[1] | 0, bonus = m[2] | 0;
                if (kind === 0) {
                    const prev = global.milestones.length
                        ? global.milestones[global.milestones.length - 1].born
                        : -1e9;
                    global.milestones.push({
                        title: util.formatLargeNumber(at),
                        bonus: bonus > 0 ? "+" + util.formatLargeNumber(bonus) : "",
                        at,
                        born: Math.max(performance.now(), prev + 400),
                    });
                    if (global.milestones.length > 4) global.milestones.shift();
                    punchCamera(22, 300, true);
                    punchUI(7, 240);
                    global.celebrateAt = performance.now();
                    if (gameSound.bankCelebrate) gameSound.bankCelebrate();
                }
            } break;
            case 'LA': {
                
                
                const L = global.leader;
                L.id = m[0];
                L.x = m[1];
                L.y = m[2];
                L.team = m[3];
                L.at = performance.now();
            } break;
            case 'GEM': {
                
                
                const carried = m[0], cap = m[1], delta = m[2];
                const g = global.gems;
                const now = performance.now();
                if (delta > 0) {
                    g.mcombo = m[5] | 0;
                    g.mcomboAt = now;
                    
                    
                    
                    g.combo = now - g.lastPickup < 900 ? g.combo + 1 : 0;
                    g.lastPickup = now;
                    if (config.game.gemSounds) gameSound.gemPickup(g.combo);
                    const last = g.popups[g.popups.length - 1];
                    if (last && now - last.born < 450) {
                        last.value += delta;
                        last.born = now;
                        last.combo = g.combo;
                    } else {
                        g.popups.push({ value: delta, born: now, combo: g.combo,
                                        drift: (Math.random() - 0.5) * 26 });
                        if (g.popups.length > 6) g.popups.shift();
                    }
                    g.flashAt = now;
                } else if (delta < 0) {
                    g.combo = 0;
                    g.mcombo = 0;
                    g.popups.length = 0;
                    // Emptied by death, not by banking (m[4]). The run you were
                    // in the middle of just ended - say so, loudly. Scaled by
                    // how full the satchel was, so losing a scrap is a blip and
                    // losing a full one is the worst sound in the game.
                    if (m[4] && config.game.gemSounds) {
                        gameSound.satchelLoss(g.cap > 0
                            ? Math.min(1, -delta / g.cap) : 1);
                    }
                }
                const wasFull = g.carried >= g.cap && g.cap > 0;
                g.carried = carried;
                g.cap = cap;
                g.banked = m[3] | 0;
                if (!wasFull && cap > 0 && carried >= cap) {
                    g.fullAt = now;
                    if (config.game.gemSounds) gameSound.satchelFull();
                }
            } break;
            case 'VU': {
                
                global.vault.onPad = !!m[0];
                global.vault.isOutpost = false;   
                if (!global.vault.onPad) {
                    global.vault.remaining = 0;
                    global.vault.total = 0;
                }
            } break;
            case 'VP': {
                
                
                const v = global.vault;
                const wasActive = v.total > 0;
                v.remaining = m[0];
                v.total = m[1];
                if (v.total > 0 && v.remaining > 0) {
                    if (config.game.gemSounds) gameSound.depositTick();
                } else if (wasActive && v.remaining <= 0 && (v.total > 0 || m[1] > 0)) {
                    v.doneAt = performance.now();
                    v.total = 0;
                    v.remaining = 0;
                    if (config.game.gemSounds) gameSound.depositDone();
                    // Near-miss feedback: banking on fumes or with the storm
                    // breathing down your neck gets called out by name.
                    try {
                        const me = global.entities.find(e => e.id === gui.playerid);
                        const hp = me ? me.health : 1;
                        const st = (global.royale && global.royale.storm) || null;
                        let stormGap = Infinity;
                        if (st && st.r > 0 && isFinite(global.player.renderx) && isFinite(global.player.rendery)) {
                            const d = Math.hypot(global.player.renderx - (st.cx || 0), global.player.rendery - (st.cy || 0));
                            stormGap = (st.r || 0) - d;
                        }
                        if (hp < 0.35) global.createMessage("Banked on fumes!", 3500);
                        else if (stormGap < 500) global.createMessage(stormGap < 0 ? "Banked inside the storm!" : "Banked ahead of the storm!", 3500);
                    } catch { /* banked quietly */ }
                }
            } break;
            case 'TR': {
                
                if (window.terrainRenderer) window.terrainRenderer.applyRockEvents(JSON.parse(m[0]));
                if (window.dwTutorialRock) window.dwTutorialRock();
            } break;
            case "temporaryban": {
                global.noAutoReconnect = true;
                global.message = "You have been temporarily banned from the game. You will be able to rejoin after a server restart.";
            } break;
            case "permanentban": {
                global.noAutoReconnect = true;
                global.message = "You have been banned from the game.";
            } break;
            case 'AC': {
                // account snapshot at spawn: rank for the HUD badge, dust for the HUD
                try {
                    const d = typeof m[0] === 'string' ? JSON.parse(m[0]) : m[0];
                    global.acct = d && typeof d === 'object' ? d : null;
                    rankPanel.setAccount(global.acct);
                    // a rank-up settled while this player was away (a
                    // disconnect, the raid bonus after they left) plays now
                    if (global.acct && global.acct.userId && rankCeremony.setUser(global.acct.userId, global.acct.rank)) {
                        setTimeout(() => { try { if (!global.died) rankCeremony.playPending(); } catch (e) { /* */ } }, 1500);
                    }
                    if (global.acct) dustHud.syncUnits(global.acct.dust, global.acct.dustCarried);
                } catch (e) { /* ignore */ }
            } break;
            case 'DU': {
                // [carriedMilli, balanceMilli, deltaMilli, kind]
                try { dustHud.onPacket(m[0], m[1], m[2], m[3]); } catch (e) { /* ignore */ }
            } break;
            case 'RK': {
                // the life's rank result, right after 'F' (never cleared by it)
                try {
                    const d = typeof m[0] === 'string' ? JSON.parse(m[0]) : m[0];
                    rankPanel.setResult(d);
                    if (d && !d.guest && d.after && global.acct) global.acct.rank = d.after;
                    if (d && !d.guest && d.after) rankCeremony.report(d.after);
                } catch (e) { /* ignore */ }
            } break;
            case 'RKP': {
                // raid-end placement bonus (top 10 accounts)
                try {
                    const d = typeof m[0] === 'string' ? JSON.parse(m[0]) : m[0];
                    rankPanel.setRaidBonus(d);
                    if (d && d.after && global.acct) global.acct.rank = d.after;
                    if (d && d.after) rankCeremony.report(d.after);
                } catch (e) { /* ignore */ }
            } break;
            case 'DQ': {
                // a daily quest's progress: a small note when one gets done
                try {
                    const d = typeof m[0] === 'string' ? JSON.parse(m[0]) : m[0];
                    if (!d || typeof d !== 'object') break;
                    const seen = global.dqSeen || (global.dqSeen = {});
                    const prev = seen[d.slot];
                    seen[d.slot] = { id: d.id, done: !!d.done };
                    if (d.done && prev && prev.id === d.id && !prev.done) {
                        const v = (+d.rewardMilli || 0) / 1000;
                        const amt = Number.isInteger(v) ? String(v) : String(+v.toFixed(2));
                        global.createMessage('Quest complete! +' + amt + ' gemdust', 4500);
                    }
                } catch (e) { /* ignore */ }
            } break;
            case 'ACH': {
                // an achievement unlocked
                try {
                    const d = typeof m[0] === 'string' ? JSON.parse(m[0]) : m[0];
                    if (d && d.id) global.createMessage('Achievement unlocked: ' + (d.name || d.id) + '!', 5000);
                } catch (e) { /* ignore */ }
            } break;
            case 'KO': {
                // Account kicked this socket (logged in elsewhere, banned):
                // the server closes it next, and it must not auto-reconnect.
                global.noAutoReconnect = true;
                global.autoReconnect = null;
                global.message = String(m[0] || "You got signed out of your account.");
            } break;
            case "svInfo": {

                global.serverStats.serverGamemodeName = m[0];
                global.serverStats.mspt = m[1];
                if (global.showDebug) console.log(`mspt: ${global.serverStats.mspt} total entities on screen: ${global.entities.length} Player X: ${(global.player.renderx).toFixed(1)} Player Y: ${(global.player.rendery).toFixed(1)}`);
            } break;
            case "gSvInfo": {
                global.serverStats.players = m[1];
            } break;
            case 'c': {
                if (global.autoReconnect) { global.autoReconnect = null; global.createMessage && global.createMessage("Reconnected.", 3000); }
                global.spawnedAt = performance.now();
                global.shieldSeen = false;
                global.respawnPending = false;
                global.died = false;
                global._specGlide = null;
                rankPanel.clear({ spawned: true });
                global.royaleSpectating = false;
                global.royaleDied = false;
                global.royaleKillerCamUntil = 0;
                global.raidRespawnAt = 0;
                global.raidQueued = false;
                global.royaleBarHits = null;
                global.showBigMap = false;
                if (global.bigMap) global.bigMap.dragging = false;
                global.royale.occupy = 0;
                global.royale.lockout = 0;
                global.pullUpgradeMenu = false;
                global.shop.onPad = false;
                global.shop.dismissed = false;
                global.callouts.length = 0;
                global.player.renderx = global.player.cx.x = m[0];
                global.player.rendery = global.player.cy.y = m[1];
                global.player.renderv = global.player.view = m[2];
                global.player.loc = { x: m[0], y: m[1] };
                // twice: the interpolator keeps the previous sample as its
                // start point, and one add would sweep the camera from the
                // old (spectate) spot to the tank instead of cutting to it
                global.player.animX.add(m[0]); global.player.animX.add(m[0]);
                global.player.animY.add(m[1]); global.player.animY.add(m[1]);
            } break;
            case 'S': {
                let clientTime = m[0],
                    serverTime = m[1],
                    laten = (getNow() - clientTime) / 2,
                    delta = getNow() - laten - serverTime;

                sync.push({
                    delta: delta,
                    latency: laten,
                });

                if (sync.length < 10) {

                    if (startSettings.neededtoresync) global.entities = [];

                    setTimeout(() => socket.talk('S', getNow()), 10);
                } else {

                    sync.sort((e, f) => e.latency - f.latency);
                    let median = sync[Math.floor(sync.length / 2)].latency;
                    let sd = 0,
                        sum = 0,
                        valid = 0;
                    for (let e of sync) {
                        sd += Math.pow(e.latency - median, 2);
                    }
                    sd = Math.sqrt(sd / sync.length);
                    for (let e of sync) {
                        if (Math.abs(e.latency - median) < sd) {
                            sum += e.delta;
                            valid++;
                        }
                    }
                    clockDiff = Math.round(sum / valid);
                    if (startSettings.neededtoresync) {
                        startSettings.neededtoresync = false;
                        startSettings.allowtostartgame = true;
                        global.pullSkillBar = false;
                        global.pullUpgradeMenu = false;
                        socket.talk("NWB");
                    }
                    global.metrics.rendertimes = 1;
                    util.pullTotalPlayers();
                    global.gameUpdate = true;

                    socket.talk('s', global.playerName, 0, 1 * config.game.autoLevelUp, global.bodyID ? global.bodyID : false, 1 * config.game.incognitoMode);
                    global.bodyID = undefined;
                    // Queue only on the initial join, not on mid-game resyncs.
                    if (!global.gameStart) global.raidQueued = true;
                }
            } break;
        case 'm': {
            global.createMessage(m[1], m[0]);
        } break;
        case "Em": {
            global.createMessage(m[1], m[0], true);
        } break;
        case 'RE': {
            global.mockups = [];
            global.entities = [];
        } break;
        case 'CC': {
            global.cached = {};
        } break;
        case 'M': {
            if (!m[1]) return;
            global.mockups[m[0]] = JSON.parse(m[1]);
        } break;
        case 'u': {

            if (m[0] == true) {
                let camx = m[1],
                    camy = m[2];
                // Pre-spawn camera drip (final-storm queue): enter the game
                // on it so queued players watch the wait view with a live
                // countdown instead of a dead connecting screen. A normal
                // spawn skips it: otherwise the first frames show a random
                // spot near the storm before the tank exists.
                const queued = global.raidQueued || !!(global.royale && global.royale.lock);
                if (!global.gameStart && startSettings.allowtostartgame && queued) {
                    global.gameStart = true;
                    global.gameConnecting = false;
                }
                if (!global.gameStart && !global.died) return;
                global.player.cx.x = camx;
                global.player.cy.y = camy;
                global.player.loc = { x: camx, y: camy };
                global.player.animX.add(m[1]);
                global.player.animY.add(m[2]);
                // Spectate glide: a jump to a new target eases over ~0.85s
                // while tracking steps stay live. Render lerps in animloop.
                if (global.died && isFinite(global.player.renderx) && isFinite(global.player.rendery)) {
                    const jump = Math.hypot(camx - global.player.renderx, camy - global.player.rendery);
                    if (jump > 180 && !global._specGlide) {
                        global._specGlide = { x0: global.player.renderx, y0: global.player.rendery, x1: camx, y1: camy, t0: performance.now(), dur: 900 };
                    } else if (global._specGlide) {
                        global._specGlide.x1 = camx;
                        global._specGlide.y1 = camy;
                    } else if (!(global.royale && global.royale.at > 0)) {
                        // Dig Royale eases the render position in animloop;
                        // other modes keep the direct follow.
                        global.player.renderx = camx;
                        global.player.rendery = camy;
                    }
                } else if (!global._specGlide) {
                    global.player.renderx = camx;
                    global.player.rendery = camy;
                }
                return;
            }
            let camtime = m[0],
                camx = m[1],
                camy = m[2],
                camfov = m[3],
                camvx = m[4],
                camvy = m[5],
                camscoping = m[6],

                theshit = m.slice(7);

                let defaultFov = 2000;
            if (!global.gameStart && startSettings.allowtostartgame) {

                global.gameStart = true;
                global.gameConnecting = false;
            };

            if (camtime > global.player.lastUpdate) {
                if (startSettings.neededtoresync) return;

                lag.add(getNow() - camtime);
                global.player.time = camtime + lag.get();
                global.metrics.rendergap = camtime - global.player.lastUpdate;
                if (global.metrics.rendergap <= 0) {
                    console.log('yo some bullshit is up wtf');
                }
                global.player.lastUpdate = camtime;

                convert.begin(theshit);
                convert.gui();
                convert.data();

                global.player.lastx = global.player.cx.x;
                global.player.lasty = global.player.cy.y;
                global.player.lastvx = global.player.vx;
                global.player.lastvy = global.player.vy;
                global.player.cx.x = camx;
                global.player.cy.y = camy;
                global.player.loc = { x: camx, y: camy };
                global.player.vx = global.died ? 0 : camvx;
                global.player.vy = global.died ? 0 : camvy;

                global.player.isScoping = camscoping;
                moveCompensation.reset();

                global.player.animX.add(m[1]);
                global.player.animY.add(m[2]);

                global.player.view = camfov;
                global.player.animv.add(global.player.view);
                if (isNaN(global.player.renderv) || global.player.renderv === 0) {
                    global.player.renderv = defaultFov;
                }

                global.metrics.lastlag = global.metrics.lag;
                global.metrics.lastuplink = getNow();
            } else {
                console.log("Old data! Last given time: " + global.player.time + "; offered packet timestamp: " + camtime + ".");
            }

            socket.talk('d', Math.max(global.player.lastUpdate, camtime));
            socket.cmd.talk();
            global.updateTimes++;
        } break;
        case "b": {
            if (startSettings.neededtoresync) return;
            convert.begin(m);
            convert.broadcast();
        } break;
        case 'p': {
            setTimeout(() => {
                try {
                    global.socket.ping(Date.now() - clockDiff - serverStart);
                } catch (e) { };
            }, 50);
            16 <= global.metrics.latency.length && global.metrics.latency.shift();
            let c = Date.now() - clockDiff - serverStart - m[0];
            0 < c && global.metrics.latency.push(c);
        } break;
        case 'F': {
            global.deathAnimation = util.AdvancedSmoothBar(0, 4, 1);
            global.deathAnimation.set(4);
            global.finalScore = util.AdvancedSmoothBar(0, 1.5);
            global.finalScore.set(m[0]);
            global.finalLifetime = util.AdvancedSmoothBar(0, 3);
            global.finalLifetime.set(m[1]);
            global.finalKills = [util.AdvancedSmoothBar(0, 4), util.AdvancedSmoothBar(0, 5.5), util.AdvancedSmoothBar(0, 2.5), util.AdvancedSmoothBar(0, 2.5), util.AdvancedSmoothBar(0, 6)];
            global.respawnTimeout = m[2];
            if (global.respawnTimeout > 0) {
                global.cannotRespawn = true;
                setTimeout(() => {
                    let respawnTimeoutloop = setInterval(() => {
                        if (global.respawnTimeout <= 1) {
                            global.cannotRespawn = false;
                            global.respawnTimeout = false;
                            clearInterval(respawnTimeoutloop);
                        } else {
                            global.respawnTimeout--;
                        }
                    }, 1000);
                }, 3000)
            }
            global.finalKills[0].set(m[3]);
            global.finalKills[1].set(m[4]);
            global.finalKills[2].set(m[5]);
            global.finalKills[3].set(m[6]);
            global.finalKills[4].set(m[7]);
            global.finalKillers = [];
            for (let i = 0; i < m[8]; i++) {
                global.finalKillers.push(m[9 + i]);
            }
            // appended after the killer list by records()
            global.finalRocks = m[9 + m[8]] | 0;
            global.finalBanked = m[10 + m[8]] | 0;
            global.finalCarried = m[11 + m[8]] | 0;
            global.finalCause = m[12 + m[8]] || "";
            global.canvas.reverseDirection = false;
            global.died = true;
            const deathPlace = m[13 + m[8]] | 0;
            if (deathPlace > 0) global.royale.place = deathPlace;
            global.finalStreak = m[14 + m[8]] | 0;
            global.finalDrillLost = m[15 + m[8]] | 0;
            global.finalInsured = m[16 + m[8]] | 0;
            // the server's own respawn wait (Second Wind shortens it)
            const respawnWaitMs = m[17 + m[8]] | 0;
            global.shop.onPad = false;
            // RK follows this packet; the rank card waits for it
            rankPanel.onDeath();
            // Death notice goes to the notification stack too, like autofire
            // toggles, so it reads even while spectating or queued.
            try {
                const dcause = global.finalCause || "";
                global.createMessage(
                    dcause === "raidend" ? "The raid ended. Everyone went down together"
                    : dcause === "rock" ? "Crushed by the living rock"
                    : dcause === "storm" ? "Lost in the storm"
                    : dcause === "base" ? "Shot down by the enemy base"
                    : global.finalKillers.length ? ("Taken down by " + global.finalKillers.join(" and "))
                    : "You died",
                    5000);
            } catch { /* */ }
            global.royale.occupy = 0;
            global.royale.lockout = 0;
            global.royaleSpectating = false;
            try {
                config.graphical.shakeProperties.CameraShake.shakeStartTime = -1;
                const dx = global.player.cx.x, dy = global.player.cy.y;
                global.player.animX.add(dx); global.player.animX.add(dx);
                global.player.animY.add(dy); global.player.animY.add(dy);
                global.player.renderx = dx;
                global.player.rendery = dy;
            } catch { /* */ }
            if (global.royale && (global.royale.at > 0 || global.royale.raidId || global.royale.matchId)) {
                // Killer cam: follow the killer 3s, then fade in the death
                // panel. Respawn tax still runs from death, not the panel.
                global.royaleDied = false;
                global.royaleSpectating = true;
                global.royaleKillerCamUntil = performance.now() + 3000;
                global.raidRespawnAt = performance.now() + (respawnWaitMs > 0 ? respawnWaitMs : 15000);
                try { global.canvas.socket.talk('RS', 2); } catch { /* */ }
                const camToken = global.royaleKillerCamUntil;
                setTimeout(() => {
                    if (!global.died) return;
                    if (global.royaleKillerCamUntil !== camToken) return;
                    global.royaleDied = true;
                    global.royaleSpectating = false;
                    global.royaleKillerCamUntil = 0;
                    try {
                        global.deathAnimation = util.AdvancedSmoothBar(0, 4, 1);
                        global.deathAnimation.set(4);
                    } catch { /* */ }
                }, 3000);
                // A dead miner leaves every pad panel behind.
                try {
                    global.vault.onPad = false;
                    global.vault.remaining = 0;
                    global.vault.total = 0;
                    global.vault.doneAt = 0;
                } catch { /* */ }
            }
            global.autoSpin = false;
            global.syncingWithTank = false;
            global.clickables.mobileButtons.active = false;
        } break;
        case 'I': {
            if (m[0]) {
                global.syncingWithTank = true;
            } else {
                global.syncingWithTank = false;
            }
        } break;
        case 'DTA': {
            let data = JSON.parse(m[0]);
            if (data.waitTime == "isVideo") {
                let renderDoc = document.createElement("video");
                renderDoc.onloadeddata = function() {
                    renderDoc.muted = false;
                    renderDoc.volume = 1;
                    global.dailyTankAd.isVideo = true;
                    global.dailyTankAd.render = renderDoc;
                    global.dailyTankAd.orginWidth = global.dailyTankAd.width;
                    global.dailyTankAd.orginHeight = global.dailyTankAd.height;
                    if (!data.normalAdSize) {
                        global.dailyTankAd.width = this.videoWidth;
                        global.dailyTankAd.height = this.videoHeight;
                    }
                    socket.talk("DTAST", renderDoc.duration);
                };
                renderDoc.onerror = () => {
                    global.dailyTankAd.renderUI = false;
                    global.createMessage("Failed to load the ad!");
                }
                renderDoc.src = `./img/ads/${data.src}`;
            } else {
                let renderDoc = new Image();
                renderDoc.onload = () => {
                    global.dailyTankAd.render = renderDoc;
                    global.dailyTankAd.orginWidth = global.dailyTankAd.width;
                    global.dailyTankAd.orginHeight = global.dailyTankAd.height;
                    if (!data.normalAdSize) {
                        global.dailyTankAd.width = renderDoc.width;
                        global.dailyTankAd.height = renderDoc.height;
                    }
                    global.dailyTankAd.readyToRender = true;
                    setTimeout(() => {
                        global.dailyTankAd.closeable = true;
                    }, `${data.waitTime}000`);
                }
                renderDoc.onerror = () => {
                    global.dailyTankAd.renderUI = false;
                    global.createMessage("Failed to load the ad!");
                }
                renderDoc.src = `./img/ads/${data.src}`;
            }
            global.dailyTankAd.renderUI = true;
        } break;
        case 'DTAD': {
            if (global.dailyTankAd.requestInterval) clearInterval(global.dailyTankAd.requestInterval)
            global.dailyTankAd.exit();
        } break;
        case 'DTAST': {
            global.dailyTankAd.render.onended = () => {
                global.dailyTankAd.requestInterval = setInterval(() => {
                    socket.talk("DTAD");
                }, 2000)
                socket.talk("DTAD");
            }
            global.dailyTankAd.render.play();
            global.dailyTankAd.readyToRender = true;
        } break;
        case 'SH': {
            let data = JSON.parse(m[0]);
            if (data.type == "camera") {
                let set = config.graphical.shakeProperties.CameraShake;
                if (data.push) {
                    set.shakeDuration += data.duration;
                    set.shakeAmount += data.amount;
                    setTimeout(() => {
                        set.shakeDuration -= data.duration;
                        set.shakeAmount -= data.amount;
                    }, 500);
                } else {
                    set.shakeDuration = data.duration;
                    set.shakeAmount = data.amount;
                }
                set.keepShake = data.keepShake;

                set.shakeStartTime = Date.now();
            }
            if (data.type == "gui") {
                let set = config.graphical.shakeProperties.UIShake;
                if (data.push) {
                    set.shakeDuration += data.duration;
                    set.shakeAmount += data.amount;
                    setTimeout(() => {
                        set.shakeDuration -= data.duration;
                        set.shakeAmount -= data.amount;
                    }, 500);
                } else {
                    set.shakeDuration = data.duration;
                    set.shakeAmount = data.amount;
                }
                set.keepShake = data.keepShake;

                set.shakeStartTime = Date.now();
            }
        } break;
        case "t": {

            socket.onclose = () => { };
            socket.close();
            global.dailyTankAd.exit();
            socket.open = false;
            clearInterval(socket.commandCycle);
            global.gameStart = false;

            global.player = global.initPlayer();

            global.gameLoading = true;
            global.serverAdd = m[0];
            global.bodyID = m[1];
            if (global.serverMap[global.serverAdd]) global.serverMap[global.serverAdd].onclick();

            let server = global.servers.find(s => s.ip === m[0]);
            if (server) location.hash = "#" + server.id;
            global.locationHash = location.hash;

            global.reconnect();
        } break;
        case 'T': {
            global.generateTankTree = true;
            global.renderTankTree = true;
        } break;

        case 'K': {

        } break;
        case 'z': {
            global.nameColor = m[0];
        } break;
        case 'RM': {
            minimapTeamInt.reset();
            minimapAllInt.elements = {};
        } break;
        case 'RL': {
            leaderboardInt.reset();
        } break;
        case 'message': {
            global.message = m[0];
        } break;
        case 'AS': {
            config.graphical.smoothcamera2 = config.graphical.smoothcamera;
            config.graphical.smoothcamera = true;
        } break;
        case 'DS': {
            if (!config.graphical.smoothcamera2) config.graphical.smoothcamera = false;
            delete config.graphical.smoothcamera2;
        } break;
        case 'CHAT_MESSAGE_ENTITY': {
            if (!global.chats) global.chats = {};
            for (let data of JSON.parse(m[0])) {
                if (!global.chats[data.id]) global.chats[data.id] = [];
                for (let e of data.messages) {
                    const alreadyExists = global.chats[data.id].find(msg => msg.id === e.id);
                    if (!alreadyExists) {
                        let alpha = util.AdvancedSmoothBar(0, 0.3, 1.5);
                        global.chats[data.id].push({
                            text: e.text,
                            id: e.id,
                            alpha: alpha
                        })
                        alpha.set(1);
                    }
                }
                for (let i = 0; i < global.chats[data.id].length; i++) {
                    let e = global.chats[data.id][i];
                    const existing = data.messages.find(o => o.id === e.id);
                    if (!existing && !e.erased) {
                        e.erased = true;
                        e.alpha.set(0);
                    };
                }
            }
        } break;
    };
}
const socketInit = () => {
    window.resizeEvent();
    // serverPath routes to a game server that is NOT the one on this port -
    // today just the tutorial, which the main server proxies through. It is
    // kept separate from serverAdd because serverAdd is also used to build
    // plain http URLs (util.pullJSON), which a path/query would corrupt.
    let socket = new WebSocket(
        protocols[location.protocol] + global.serverAdd + (global.serverPath || ""));

    socket.binaryType = 'arraybuffer';
    socket.open = false;

    let flag = false;
    let commands = [
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
    ];
    socket.cmd = {
        set: (index, value) => {
            if (commands[index] !== value) {
                commands[index] = value;
                flag = true;
            }
        },
        talk: () => {
            flag = false;
            let o = 0;
            for (let i = 0; i < 8; i++) {
                if (commands[i]) o += Math.pow(2, i);
            }
            let ratio = util.getRatio();
            socket.talk('C', Math.round(global.target.x / ratio), Math.round(global.target.y / ratio), global.reverseTank, o);
        },
        check: () => flag,
        getMotion: () => ({
            x: commands[3] - commands[2],
            y: commands[1] - commands[0],
        }),
        reactNow: () => {
            flag = true;
            return flag;
        }
    };

    socket.talk = async (...message) => {
        if (window.fakeLagMS > 0) await new Promise(Resolve => setTimeout(Resolve, window.fakeLagMS));

        if (!socket.open) return 1;
        message = protocol.encode(message)
        socket.send(message);
        global.bandwidth.currentHa += message.byteLength;
    };

    socket.onopen = function socketOpen() {
        socket.open = true;

        socket.ping = payload => socket.talk('p', payload);
    };

    socket.onmessage = (msg) => incoming(msg, socket);

    socket.onclose = () => {
        if (!global.gameLoading) return;
        clearInterval(socket.commandCycle);
        clearInterval(global.socketMotionCycle);
        if (global.dailyTankAd.render) global.dailyTankAd.exit();
        socket.open = false;
        global.showBigMap = false;
        // A drop mid-game (proxy reload, wifi blip) reconnects on its own; the
        // server keeps your raid for two minutes under the tab's resume token.
        const tries = global.autoReconnect ? global.autoReconnect.tries : 0;
        if ((global.gameStart || global.autoReconnect) && !global.noAutoReconnect && tries < RECONNECT_TRIES) {
            global.autoReconnect = { tries: tries + 1, at: Date.now() };
            const wait = Math.min(4000, 500 + tries * 500);
            setTimeout(() => {
                if (!global.autoReconnect) return;
                global.reconnect();
                global.message = "Connection dropped. Reconnecting (try " + global.autoReconnect.tries + " of " + RECONNECT_TRIES + ")...";
            }, wait);
            return;
        }
        if (global.autoReconnect && !global.noAutoReconnect) {
            // every retry failed: the game server never heard from us
            global.message = "Can't reach the server from your network. School and work networks sometimes block games. Check your connection, then press Reconnect.";
        }
        global.autoReconnect = null;
        global.disconnected = true;
    };

    socket.onerror = error => {
        clearInterval(socket.commandCycle);
        clearInterval(global.socketMotionCycle);
        global.message = 'Socket error. Maybe another server will work.';
    };

    return socket;
};

const resync = () => {
    let socket = global.socket;
    global.royaleDied = false;
    global.royaleSpectating = false;
    startSettings.neededtoresync = true;
    startSettings.allowtostartgame = false;
    sync = [];
    clockDiff = 0;
    serverStart = 0;
    minimapAllInt.elements = {};
    minimapTeamInt.elements = {};
    leaderboardInt.elements = {};
    leaderboard.entries = {};
    minimap.map = {};
    socket.talk('S', Date.now() - clockDiff - serverStart);
};

global.resetSocket = () => {
    global.royaleDied = false;
    global.royaleSpectating = false;
    global.royaleBoard.open = false;
    sync = [];
    clockDiff = 0;
    serverStart = 0;
    sscore.set(0);
    gui.points = 0,
    gui.playerid = -1,
    gui.class = "";
    gui.root = "";
    minimap.map = {};
    minimapAllInt.elements = {};
    minimapTeamInt.elements = {};
    leaderboard.entries = {};
    leaderboardInt.reset();
    global.socket = [];
};

global.reconnectSocket = () => {
    sync = [];
    clockDiff = 0;
    serverStart = 0;
    sscore.set(0);
    gui.points = 0,
    gui.playerid = -1,
    gui.class = "";
    gui.root = "";
    gui.upgrades = [];
    minimap.map = {};
    minimapAllInt.elements = {};
    minimapTeamInt.elements = {};
    leaderboard.entries = {};
    leaderboardInt.reset();
    global.socket = [];
    global.socket = socketInit();
}

export { socketInit, resync, gui, leaderboard, minimap, moveCompensation, lag, getNow, clockDiff, serverStart }
