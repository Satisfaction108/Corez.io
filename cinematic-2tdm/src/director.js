import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

THREE.ColorManagement.enabled = false;

const W = 1920, H = 1080, FPS = 60, DURATION = 24;

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const lerp = (a, b, k) => a + (b - a) * k;
const inv = (a, b, v) => clamp((v - a) / (b - a));
const easeInOut = k => k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
const easeOut = k => 1 - Math.pow(1 - k, 3);
const easeIn = k => k * k * k;
const easeOutBack = k => { const c = 1.9; return 1 + (c + 1) * Math.pow(k - 1, 3) + c * Math.pow(k - 1, 2); };
const v3 = (x, y, z) => new THREE.Vector3(x, y, z);
const angleTo = (x0, z0, x1, z1) => Math.atan2(z1 - z0, x1 - x0);
const lerpAngle = (a, b, k) => { const d = ((b - a + Math.PI * 3) % (Math.PI * 2)) - Math.PI; return a + d * k; };
const wob = (t, f, ph) => Math.sin(t * f + ph) * 0.6 + Math.sin(t * f * 2.13 + ph * 1.7) * 0.3 + Math.sin(t * f * 4.7 + ph * 0.3) * 0.1;

function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const COL = {
    blue: '#2f7ff2', red: '#f0405a', barrel: '#a7a7af', floor: '#e2e4ea', grid: '#d1d4dc', sky: '#eef0f5',
    gem: '#5fe89a', gemLine: '#14894b', ink: '#1b1510', gold: '#ffd24a', copper: '#e07b2e'
};
const BIOME = {
    sandstone: [252, 212, 98], clay: [246, 158, 96], moss: [140, 214, 106],
    crystal: [102, 198, 240], magma: [250, 116, 110], obsidian: [124, 134, 248]
};
const shade = (c, k) => new THREE.Color(c).multiplyScalar(k);
const lift = (c, k) => new THREE.Color(c).lerp(new THREE.Color(1, 1, 1), k);
const rgbColor = a => new THREE.Color(a[0] / 255, a[1] / 255, a[2] / 255);

const glCanvas = document.createElement('canvas');
glCanvas.width = W; glCanvas.height = H;
const out = document.getElementById('out');
out.width = W; out.height = H;
const ctx = out.getContext('2d');
const renderer = new THREE.WebGLRenderer({ canvas: glCanvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(W, H, false);
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
const scene = new THREE.Scene();
scene.background = new THREE.Color(COL.sky);
const camera = new THREE.PerspectiveCamera(40, W / H, 0.05, 900);

const FOG = { uFogColor: { value: new THREE.Color(COL.sky) }, uFogNear: { value: 60 }, uFogFar: { value: 240 } };
const LIGHT = new THREE.Vector3(-0.45, 0.85, 0.55).normalize();

const VS = `
varying vec3 vN; varying vec3 vW;
void main() {
  vN = normalize(mat3(modelMatrix) * normal);
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const FS = `
uniform vec3 uColor; uniform vec3 uLight; uniform float uFlat; uniform float uFlash; uniform float uOpacity; uniform float uGem;
uniform vec3 uFogColor; uniform float uFogNear; uniform float uFogFar;
varying vec3 vN; varying vec3 vW;
void main() {
  vec3 n = normalize(vN);
  float d = dot(n, uLight);
  float s = d > 0.65 ? 1.0 : (d > 0.25 ? 0.9 : (d > -0.2 ? 0.82 : 0.74));
  if (uGem > 0.5) s = d > 0.75 ? 1.22 : (d > 0.35 ? 1.04 : (d > -0.1 ? 0.86 : 0.72));
  s = mix(s, 1.0, uFlat);
  vec3 c = min(uColor * s, vec3(1.0));
  c = mix(c, vec3(1.0), uFlash);
  float f = smoothstep(uFogNear, uFogFar, distance(vW, cameraPosition));
  gl_FragColor = vec4(mix(c, uFogColor, f), uOpacity);
}`;

function toonMat(color, o = {}) {
    return new THREE.ShaderMaterial({
        uniforms: {
            ...FOG, uLight: { value: LIGHT }, uColor: { value: new THREE.Color(color) },
            uFlat: { value: o.flat ?? 0 }, uFlash: { value: 0 }, uOpacity: { value: 1 }, uGem: { value: o.gem ? 1 : 0 }
        },
        vertexShader: VS, fragmentShader: FS, side: o.side ?? THREE.FrontSide
    });
}

class Part extends THREE.Group {
    constructor(geo, hullGeo, color, o = {}) {
        super();
        this.mat = toonMat(color, { flat: o.flat ?? 0, gem: o.gem });
        this.hullMat = toonMat(o.outline ?? shade(color, 0.62), { flat: 1, side: THREE.BackSide });
        this.body = new THREE.Mesh(geo, this.mat);
        this.add(this.body);
        if (hullGeo) {
            this.hull = new THREE.Mesh(hullGeo, this.hullMat);
            if (o.hullScale) this.hull.scale.setScalar(o.hullScale);
            this.add(this.hull);
        }
    }
    setColor(c, k = 0.6) {
        this.mat.uniforms.uColor.value.set(c);
        this.hullMat.uniforms.uColor.value.set(c).multiplyScalar(k);
    }
    flash(a) {
        this.mat.uniforms.uFlash.value = a;
        this.hullMat.uniforms.uFlash.value = a * 0.5;
    }
    fade(a) {
        this.mat.transparent = a < 1;
        this.mat.depthWrite = a >= 1;
        this.mat.uniforms.uOpacity.value = a;
        if (this.hull) {
            this.hull.visible = a > 0.35;
            this.hullMat.transparent = a < 1;
            this.hullMat.uniforms.uOpacity.value = clamp((a - 0.35) / 0.65);
        }
    }
}

const OUT = 0.075;
const geoCache = new Map();
const cached = (key, make) => { if (!geoCache.has(key)) geoCache.set(key, make()); return geoCache.get(key); };
const G = {
    sphere: new THREE.SphereGeometry(1, 64, 40),
    sphereHull: new THREE.SphereGeometry(1 + OUT, 64, 40),
    chunk: new THREE.IcosahedronGeometry(1, 0),
    chunkHull: new THREE.IcosahedronGeometry(1.28, 0),
    shadow: new THREE.CircleGeometry(1.06, 48).rotateX(-Math.PI / 2)
};
function barrelGeo(s) {
    return cached(`b${s.len}_${s.r0}_${s.r1}`, () => new THREE.CylinderGeometry(s.r1, s.r0, s.len, 40, 1).rotateZ(-Math.PI / 2).translate(s.len / 2, 0, 0));
}
function barrelHull(s) {
    return cached(`bh${s.len}_${s.r0}_${s.r1}`, () => new THREE.CylinderGeometry(s.r1 + OUT, s.r0 + OUT, s.len + OUT, 40, 1).rotateZ(-Math.PI / 2).translate((s.len + OUT) / 2, 0, 0));
}
function boreGeo(s) {
    return cached(`bo${s.r1}`, () => new THREE.CircleGeometry(s.r1 * 0.7, 40).rotateY(Math.PI / 2));
}
function gemGeo(s) {
    const crown = new THREE.CylinderGeometry(0.5 * s, 0.95 * s, 0.38 * s, 8, 1).toNonIndexed();
    crown.translate(0, 0.19 * s, 0);
    const pav = new THREE.ConeGeometry(0.95 * s, 0.95 * s, 8, 1).toNonIndexed();
    pav.rotateX(Math.PI);
    pav.translate(0, -0.475 * s, 0);
    for (const g of [crown, pav]) { g.deleteAttribute('uv'); g.deleteAttribute('normal'); }
    const m = mergeGeometries([crown, pav]);
    m.computeVertexNormals();
    return m;
}
G.gem = gemGeo(0.55);
G.gemHull = gemGeo(0.55 * 1.2);
const shadowMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.075, depthWrite: false });

const KINDS = {
    basic: [{ len: 1.9, r0: 0.42, r1: 0.42 }],
    twin: [{ len: 1.9, r0: 0.36, r1: 0.36, off: 0.46 }, { len: 1.9, r0: 0.36, r1: 0.36, off: -0.46 }],
    sniper: [{ len: 2.45, r0: 0.38, r1: 0.38 }],
    mg: [{ len: 1.75, r0: 0.42, r1: 0.72, br: 0.42 }],
    destroyer: [{ len: 1.95, r0: 0.72, r1: 0.72 }],
    flank: [{ len: 1.9, r0: 0.42, r1: 0.42 }, { len: 1.55, r0: 0.42, r1: 0.42, ang: Math.PI * 2 / 3 }, { len: 1.55, r0: 0.42, r1: 0.42, ang: -Math.PI * 2 / 3 }],
    tri: [{ len: 1.9, r0: 0.42, r1: 0.42 }, { len: 1.6, r0: 0.42, r1: 0.42, ang: Math.PI - 0.55 }, { len: 1.6, r0: 0.42, r1: 0.42, ang: Math.PI + 0.55 }]
};

class Tank extends THREE.Group {
    constructor(color, kind = 'basic', size = 1) {
        super();
        this.size = size;
        this.color = color;
        this.rig = new THREE.Group();
        this.rig.position.y = size + 0.14;
        this.rig.scale.setScalar(size);
        this.squash = new THREE.Group();
        this.squash.add(this.rig);
        this.add(this.squash);
        Tank.made = (Tank.made || 0) + 1;
        this.bobPhase = (Tank.made * 2.39) % 6.28;
        this.jiggles = [];
        this.body = new Part(G.sphere, G.sphereHull, color, { flat: 1 });
        this.rig.add(this.body);
        this.barrels = KINDS[kind].map(spec => {
            const pivot = new THREE.Group();
            pivot.rotation.y = -(spec.ang || 0);
            const slide = new THREE.Group();
            slide.position.z = spec.off || 0;
            pivot.add(slide);
            const part = new Part(barrelGeo(spec), barrelHull(spec), COL.barrel, { flat: 1 });
            slide.add(part);
            const bore = new THREE.Mesh(boreGeo(spec), toonMat(shade(COL.barrel, 0.72), { flat: 1 }));
            bore.position.x = spec.len + 0.004;
            slide.add(bore);
            this.rig.add(pivot);
            return { spec, pivot, slide, part, bore };
        });
        this.shadow = new THREE.Mesh(G.shadow, shadowMat);
        this.shadow.scale.setScalar(size);
        this.shadow.position.y = 0.012;
        this.add(this.shadow);
    }
    flash(a) {
        this.body.flash(a);
        for (const b of this.barrels) b.part.flash(a * 0.8);
    }
    fade(a) {
        this.body.fade(a);
        for (const b of this.barrels) { b.part.fade(a); b.bore.visible = a > 0.5; }
        this.shadow.visible = a > 0.5;
    }
}

class Pool {
    constructor(make) { this.make = make; this.items = []; this.i = 0; this.group = new THREE.Group(); scene.add(this.group); }
    begin() { this.i = 0; }
    get() {
        let it = this.items[this.i];
        if (!it) { it = this.make(); this.items.push(it); this.group.add(it); }
        this.i++;
        it.visible = true;
        return it;
    }
    end() { for (let j = this.i; j < this.items.length; j++) this.items[j].visible = false; }
}
const pools = [];
const bulletPools = new Map();
function bulletOf(color) {
    let p = bulletPools.get(color);
    if (!p) { p = new Pool(() => new Part(G.sphere, G.sphereHull, color, { flat: 1 })); bulletPools.set(color, p); pools.push(p); }
    return p.get();
}
const chunkPool = new Pool(() => new Part(G.chunk, G.chunkHull, '#ffffff'));
const gemPool = new Pool(() => new Part(G.gem, G.gemHull, COL.gem, { gem: true, outline: COL.gemLine }));
pools.push(chunkPool, gemPool);

function circleTexture(fill, ring) {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    g.beginPath(); g.arc(64, 64, 54, 0, Math.PI * 2);
    if (fill) { g.fillStyle = fill; g.fill(); }
    if (ring) { g.lineWidth = 9; g.strokeStyle = ring; g.stroke(); }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.NoColorSpace;
    return tex;
}
const puffTex = circleTexture('#ffffff', 'rgba(0,0,0,0.13)');
const puffPool = new Pool(() => new THREE.Sprite(new THREE.SpriteMaterial({ map: puffTex, transparent: true, depthWrite: false })));
pools.push(puffPool);

const ringMat = c => new THREE.MeshBasicMaterial({ color: new THREE.Color(c), transparent: true, depthWrite: false, side: THREE.DoubleSide });
const ringGeo = new THREE.RingGeometry(0.86, 1, 64).rotateX(-Math.PI / 2);

function ballistic(p0, v0, dt, g = 22, floorY = 0.2, bounce = 0.38, fric = 0.55) {
    let x = p0.x, y = p0.y, z = p0.z, vx = v0.x, vy = v0.y, vz = v0.z, tt = dt;
    for (let k = 0; k < 4; k++) {
        const a = -0.5 * g, b = vy, c = y - floorY;
        const disc = b * b - 4 * a * c;
        const th = disc < 0 ? Infinity : (-b - Math.sqrt(disc)) / (2 * a);
        if (tt <= th) return { x: x + vx * tt, y: y + vy * tt - 0.5 * g * tt * tt, z: z + vz * tt, rest: false };
        x += vx * th; z += vz * th; y = floorY;
        const vyHit = vy - g * th;
        vy = -vyHit * bounce; vx *= fric; vz *= fric; tt -= th;
        if (vy < 1.2) {
            const s = (1 - Math.exp(-tt * 5)) / 5;
            return { x: x + vx * s, y: floorY, z: z + vz * s, rest: true };
        }
    }
    return { x, y, z, rest: true };
}

function burst(o) {
    const r = rng(o.seed);
    const list = [];
    for (let i = 0; i < o.n; i++) {
        const a = r() * Math.PI * 2;
        const sp = (o.speed ?? 6) * (0.45 + r() * 0.8);
        let vx = Math.cos(a) * sp, vz = Math.sin(a) * sp;
        if (o.dir) { vx = vx * 0.55 + o.dir.x * sp; vz = vz * 0.55 + o.dir.z * sp; }
        list.push({
            t0: o.t0 + (o.stagger ?? 0) * r(),
            p0: v3(o.at.x + (r() - 0.5) * (o.spread ?? 0.6), o.at.y + (r() - 0.5) * (o.spreadY ?? 0.5), o.at.z + (r() - 0.5) * (o.spread ?? 0.6)),
            v0: v3(vx, (o.up ?? 6) * (0.5 + r() * 0.8), vz),
            spin: v3(r() * 14 - 7, r() * 14 - 7, r() * 14 - 7),
            size: (o.size ?? 0.3) * (0.6 + r() * 0.7),
            life: (o.life ?? 1.2) * (0.75 + r() * 0.5),
            color: Array.isArray(o.color) ? o.color[Math.floor(r() * o.color.length)] : o.color,
            g: o.g ?? 24
        });
    }
    return list;
}
function drawBursts(list, t) {
    for (const p of list) {
        const dt = t - p.t0;
        if (dt < 0 || dt > p.life) continue;
        const pos = ballistic(p.p0, p.v0, dt, p.g, p.size * 0.8);
        const m = chunkPool.get();
        m.setColor(p.color, 0.6);
        m.position.set(pos.x, pos.y, pos.z);
        const sd = Math.min(dt, 0.6);
        m.rotation.set(p.spin.x * sd, p.spin.y * sd, p.spin.z * sd);
        m.scale.setScalar(p.size * clamp((p.life - dt) / 0.25));
    }
}
function puffs(o) {
    const r = rng(o.seed);
    const list = [];
    for (let i = 0; i < o.n; i++) {
        const a = r() * Math.PI * 2;
        const sp = (o.speed ?? 2) * (0.4 + r() * 0.8);
        list.push({
            t0: o.t0 + (o.stagger ?? 0) * r(),
            p0: v3(o.at.x + (r() - 0.5) * (o.spread ?? 1), o.at.y + r() * 0.4, o.at.z + (r() - 0.5) * (o.spread ?? 1)),
            v: v3(Math.cos(a) * sp + (o.drift?.x ?? 0), (o.rise ?? 1.2) * (0.5 + r()), Math.sin(a) * sp + (o.drift?.z ?? 0)),
            size: (o.size ?? 1) * (0.6 + r() * 0.7),
            life: (o.life ?? 0.8) * (0.7 + r() * 0.6),
            color: o.color ?? '#f2efe8',
            alpha: o.alpha ?? 0.9
        });
    }
    return list;
}
function drawPuffs(list, t) {
    for (const p of list) {
        const dt = t - p.t0;
        if (dt < 0 || dt > p.life) continue;
        const k = dt / p.life;
        const s = puffPool.get();
        const damp = (1 - Math.exp(-dt * 3)) / 3;
        s.position.set(p.p0.x + p.v.x * damp, p.p0.y + p.v.y * damp, p.p0.z + p.v.z * damp);
        s.scale.setScalar(p.size * (0.5 + easeOut(k) * 0.9));
        s.material.color.set(p.color);
        s.material.opacity = p.alpha * (1 - easeIn(k));
    }
}

class Actor {
    constructor(tank, pose, o = {}) {
        this.tank = tank;
        this.poseFn = pose;
        this.fires = [];
        this.speed = o.speed ?? 17;
        this.life = o.life ?? 1.4;
        this.color = o.color ?? tank.color;
        this.cache = new Map();
        this.hidden = false;
    }
    fire(t, o = {}) {
        const f = { t, barrels: o.barrels ?? null, dieX: o.dieX, end: o.end, stopAt: o.stopAt, scale: o.scale ?? 1, speed: o.speed, id: this.fires.length };
        this.fires.push(f);
        return f;
    }
    apply(t, cartoon = false) {
        const p = this.poseFn(t);
        this.tank.position.set(p.x, p.y || 0, p.z);
        this.tank.rotation.y = -p.a;
        if (cartoon) this.cartoon(t, p);
        this.tank.updateMatrixWorld(true);
        return p;
    }
    cartoon(t, p) {
        const q = this.poseFn(t - 0.05);
        const vx = (p.x - q.x) / 0.05, vz = (p.z - q.z) / 0.05;
        const fwd = vx * Math.cos(p.a) + vz * Math.sin(p.a);
        const side = -vx * Math.sin(p.a) + vz * Math.cos(p.a);
        const speed = Math.hypot(vx, vz);
        const run = clamp(speed / 7) * 0.34;
        const turn = clamp(Math.abs(lerpAngle(q.a, p.a, 1) - q.a) / 0.05 / 6) * 0.08;
        let last = -1e9;
        for (const f of this.fires) { if (f.t > t) break; last = f.t; }
        const dt = t - last;
        const kick = dt >= 0 && dt < 1 ? Math.exp(-dt * 6) * Math.cos(dt * 24) : 0;
        let jig = 0;
        for (const h of this.tank.jiggles) { const d = t - h; if (d >= 0 && d < 1) jig += Math.exp(-d * 8) * Math.sin(d * 34); }
        const bob = 0.075 * Math.sin(t * 7.5 + this.tank.bobPhase);
        const along = Math.abs(fwd) >= Math.abs(side) ? 1 : 0;
        const stretch = run * (along ? 1 : 0.6);
        let sx = 1 + (along ? stretch : -stretch * 0.5) - 0.36 * kick + 0.32 * jig - turn * 0.6;
        let sz = 1 + (along ? -stretch * 0.55 : stretch) + 0.26 * kick - 0.3 * jig + turn;
        let sy = 1 - stretch * 0.45 + bob - bob * 0.5 * (sx - 1) + 0.16 * kick + 0.22 * jig;
        this.tank.squash.scale.set(sx, sy, sz);
    }
    origin(f, bi) {
        const key = f.id * 16 + bi;
        if (this.cache.has(key)) return this.cache.get(key);
        const p = this.apply(f.t);
        const b = this.tank.barrels[bi];
        const sx = b.slide.position.x;
        b.slide.position.x = 0;
        this.tank.updateMatrixWorld(true);
        const pos = b.slide.localToWorld(v3(b.spec.len * 0.82, 0, 0));
        b.slide.position.x = sx;
        const a = p.a + (b.spec.ang || 0);
        const dir = v3(Math.cos(a), 0, Math.sin(a));
        const r = (b.spec.br ?? b.spec.r1) * 0.84 * this.tank.size * f.scale;
        const speed = f.speed ?? this.speed;
        let end = f.end ?? f.t + this.life;
        if (f.dieX !== undefined && Math.abs(dir.x) > 0.05) end = Math.min(end, f.t + (f.dieX - pos.x) / (dir.x * speed));
        if (f.stopAt) end = Math.min(end, f.t + Math.max(0, Math.hypot(f.stopAt.x - pos.x, f.stopAt.z - pos.z) - f.stopAt.r - r) / speed);
        const o = { pos, dir, r, speed, end };
        this.cache.set(key, o);
        return o;
    }
    update(t) {
        if (this.hidden) { this.tank.visible = false; return; }
        this.tank.visible = true;
        for (const f of this.fires) {
            if (t < f.t || t > f.t + this.life + 0.4) continue;
            const list = f.barrels ?? this.tank.barrels.map((_, i) => i);
            for (const bi of list) {
                const o = this.origin(f, bi);
                if (t > o.end + 0.16) continue;
                const travel = Math.min(t, o.end) - f.t;
                const b = bulletOf(this.color);
                b.position.copy(o.pos).addScaledVector(o.dir, o.speed * travel);
                let sc = o.r * clamp(0.55 + travel * 9, 0, 1), a = 1;
                if (t > o.end) { const k = (t - o.end) / 0.16; sc *= 1 + 0.75 * k; a = 1 - k; }
                const smear = 1 + 0.45 * clamp(1 - travel * 4) + 0.18;
                b.rotation.set(0, -Math.atan2(o.dir.z, o.dir.x), 0);
                b.scale.set(sc * smear, sc / Math.sqrt(smear), sc / Math.sqrt(smear));
                b.fade(a);
            }
        }
        this.apply(t, true);
        for (let bi = 0; bi < this.tank.barrels.length; bi++) {
            let last = -1e9;
            for (const f of this.fires) {
                if (f.t > t) break;
                if (!f.barrels || f.barrels.includes(bi)) last = f.t;
            }
            const dt = t - last;
            const k = dt < 0.04 ? dt / 0.04 : Math.exp(-(dt - 0.04) * 11);
            this.tank.barrels[bi].slide.position.x = -0.32 * k;
        }
    }
}

function offsetPoly(P, d) {
    const n = P.length;
    let area = 0;
    for (let i = 0; i < n; i++) { const a = P[i], b = P[(i + 1) % n]; area += a.x * b.z - b.x * a.z; }
    const s = area > 0 ? 1 : -1;
    const lines = [];
    for (let i = 0; i < n; i++) {
        const a = P[i], b = P[(i + 1) % n];
        const dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz) || 1;
        const nx = s * dz / L, nz = -s * dx / L;
        lines.push({ px: a.x + nx * d, pz: a.z + nz * d, dx, dz });
    }
    const res = [];
    for (let i = 0; i < n; i++) {
        const l1 = lines[(i - 1 + n) % n], l2 = lines[i];
        const cr = l1.dx * l2.dz - l1.dz * l2.dx;
        if (Math.abs(cr) < 1e-9) { res.push({ x: l2.px, z: l2.pz }); continue; }
        const t = ((l2.px - l1.px) * l2.dz - (l2.pz - l1.pz) * l2.dx) / cr;
        res.push({ x: l1.px + l1.dx * t, z: l1.pz + l1.dz * t });
    }
    return res;
}
function polyArea(P) {
    let a = 0;
    for (let i = 0; i < P.length; i++) { const p = P[i], q = P[(i + 1) % P.length]; a += p.x * q.z - q.x * p.z; }
    return a / 2;
}
function clipHalf(P, m, nrm) {
    const res = [];
    for (let i = 0; i < P.length; i++) {
        const a = P[i], b = P[(i + 1) % P.length];
        const fa = (a.x - m.x) * nrm.x + (a.z - m.z) * nrm.z;
        const fb = (b.x - m.x) * nrm.x + (b.z - m.z) * nrm.z;
        if (fa <= 0) res.push(a);
        if ((fa <= 0) !== (fb <= 0)) { const k = fa / (fa - fb); res.push({ x: a.x + (b.x - a.x) * k, z: a.z + (b.z - a.z) * k }); }
    }
    return res;
}
function prismGeo(poly, h, c, y0 = 0) {
    const shape = new THREE.Shape(poly.map(p => new THREE.Vector2(p.x - c.x, -(p.z - c.z))));
    const g = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false, curveSegments: 1 });
    g.rotateX(-Math.PI / 2);
    g.translate(0, y0, 0);
    return g;
}

function rockCluster(o) {
    const r = rng(o.seed);
    const sx = o.sx ?? 1, sz = o.sz ?? 1;
    const sites = [];
    const minD = o.R * 1.55 / Math.sqrt(o.n);
    let tries = 0;
    while (sites.length < o.n && tries++ < 6000) {
        const a = r() * Math.PI * 2, d = Math.sqrt(r()) * o.R * 0.95;
        const p = { x: o.cx + Math.cos(a) * d * sx, z: o.cz + Math.sin(a) * d * sz };
        if (sites.every(s => Math.hypot(s.x - p.x, s.z - p.z) > minD)) sites.push(p);
    }
    const boundary = [];
    const ph = r() * 10;
    for (let i = 0; i < 24; i++) {
        const a = i / 24 * Math.PI * 2;
        const rr = o.R * (1 + 0.1 * Math.sin(a * 3 + ph) + 0.06 * Math.sin(a * 5 + ph * 2));
        boundary.push({ x: o.cx + Math.cos(a) * rr * sx, z: o.cz + Math.sin(a) * rr * sz });
    }
    const fill = BIOME[o.biome];
    const cells = [];
    const group = new THREE.Group();
    for (const s of sites) {
        let poly = boundary.slice();
        for (const s2 of sites) {
            if (s2 === s) continue;
            poly = clipHalf(poly, { x: (s.x + s2.x) / 2, z: (s.z + s2.z) / 2 }, { x: s2.x - s.x, z: s2.z - s.z });
            if (poly.length < 3) break;
        }
        if (poly.length < 3) continue;
        const A0 = polyArea(poly);
        const shrunk = offsetPoly(poly, -(o.gap ?? 0.07));
        const A1 = polyArea(shrunk);
        if (Math.sign(A1) !== Math.sign(A0) || Math.abs(A1) < 0.25) continue;
        let cx = 0, cz = 0;
        for (const p of shrunk) { cx += p.x; cz += p.z; }
        const c = { x: cx / shrunk.length, z: cz / shrunk.length };
        const dist = Math.hypot((c.x - o.cx) / sx, (c.z - o.cz) / sz) / o.R;
        const h = lerp(o.hMin ?? 1.1, o.hMax ?? 1.7, r()) * (1 + 0.28 * (1 - dist));
        const vary = (r() * 2 - 1) * 10;
        const col = rgbColor(fill.map(v => clamp(v + vary, 0, 255)));
        const hullPoly = offsetPoly(shrunk, 0.085);
        const part = new Part(prismGeo(shrunk, h, c), prismGeo(hullPoly, h + 0.085, c, -0.02), col, { outline: rgbColor(fill).multiplyScalar(0.55) });
        part.position.set(c.x, 0, c.z);
        group.add(part);
        cells.push({ part, c, h, poly: shrunk, color: col, rad: Math.sqrt(Math.abs(A1) / Math.PI), alive: true });
    }
    return { group, cells };
}

function padMat(c1, c2, period) {
    return new THREE.ShaderMaterial({
        uniforms: { ...FOG, uC1: { value: new THREE.Color(c1) }, uC2: { value: new THREE.Color(c2) }, uP: { value: period } },
        vertexShader: `varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
        fragmentShader: `uniform vec3 uC1; uniform vec3 uC2; uniform float uP; uniform vec3 uFogColor; uniform float uFogNear; uniform float uFogFar; varying vec3 vW;
void main(){ float s = fract((vW.x + vW.z) / uP); float aa = fwidth((vW.x + vW.z) / uP) * 1.2; float m = smoothstep(0.5 - aa, 0.5 + aa, s) - smoothstep(1.0 - aa, 1.0, s);
vec3 c = mix(uC1, uC2, m); float f = smoothstep(uFogNear, uFogFar, distance(vW, cameraPosition)); gl_FragColor = vec4(mix(c, uFogColor, f), 1.0); }`
    });
}

function makeBase(team, cx, cz, w, d) {
    const g = new THREE.Group();
    const col = team === 'blue' ? COL.blue : COL.red;
    const border = new THREE.Mesh(new THREE.BoxGeometry(w + 0.7, 0.1, d + 0.7), toonMat(shade(lift(col, 0.25), 0.8), { flat: 1 }));
    border.position.set(cx, 0.05, cz);
    g.add(border);
    const slab = new THREE.Mesh(new THREE.BoxGeometry(w, 0.16, d), padMat(lift(col, 0.74), lift(col, 0.66), 2.6));
    slab.position.set(cx, 0.08, cz);
    g.add(slab);
    const bankRim = new THREE.Mesh(new THREE.CylinderGeometry(3.5, 3.5, 0.24, 72), toonMat(shade(lift(col, 0.2), 0.78), { flat: 1 }));
    bankRim.position.set(cx, 0.12, cz);
    g.add(bankRim);
    const bank = new THREE.Mesh(new THREE.CylinderGeometry(3.1, 3.1, 0.3, 72), toonMat(lift(col, 0.42), { flat: 1 }));
    bank.position.set(cx, 0.15, cz);
    g.add(bank);
    const inner = new THREE.Mesh(new THREE.CylinderGeometry(1.7, 1.7, 0.34, 64), toonMat(lift(col, 0.6), { flat: 1 }));
    inner.position.set(cx, 0.17, cz);
    g.add(inner);
    const marker = new Part(G.gem, G.gemHull, COL.gem, { gem: true, outline: COL.gemLine });
    marker.position.set(cx, 1.35, cz);
    marker.scale.setScalar(1.25);
    g.add(marker);
    const pulse = new THREE.Mesh(ringGeo, ringMat(lift(col, 0.1)));
    pulse.position.set(cx, 0.35, cz);
    pulse.visible = false;
    g.add(pulse);
    return { group: g, marker, pulse, cx, cz, bank };
}

const floorMat = new THREE.ShaderMaterial({
    uniforms: { ...FOG, uBase: { value: new THREE.Color(COL.floor) }, uLine: { value: new THREE.Color(COL.grid) }, uCell: { value: 2.5 }, uW: { value: 0.028 } },
    vertexShader: `varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `uniform vec3 uBase; uniform vec3 uLine; uniform float uCell; uniform float uW; uniform vec3 uFogColor; uniform float uFogNear; uniform float uFogFar; varying vec3 vW;
void main(){
  vec2 c = vW.xz / uCell;
  vec2 g = abs(fract(c + 0.5) - 0.5);
  vec2 aa = fwidth(c);
  vec2 l = 1.0 - smoothstep(vec2(uW) - aa * 0.8, vec2(uW) + aa * 0.8, g);
  float line = max(l.x, l.y) * clamp(1.4 - length(aa) * 3.0, 0.0, 1.0);
  vec3 col = mix(uBase, uLine, line);
  float f = smoothstep(uFogNear, uFogFar, distance(vW, cameraPosition));
  gl_FragColor = vec4(mix(col, uFogColor, f), 1.0);
}`
});
const floor = new THREE.Mesh(new THREE.PlaneGeometry(3000, 3000).rotateX(-Math.PI / 2), floorMat);
scene.add(floor);

const CUES = [];
const cue = (t, name, gain = 1, rate = 1) => CUES.push({ t: +t.toFixed(4), name, gain, rate });

const SLOW = { a: 10.85, b: 11.1, c: 11.85, d: 12.2, s: 0.09 };
const speedAt = t => {
    if (t < SLOW.a || t > SLOW.d) return 1;
    if (t < SLOW.b) return lerp(1, SLOW.s, easeInOut(inv(SLOW.a, SLOW.b, t)));
    if (t < SLOW.c) return SLOW.s;
    return lerp(SLOW.s, 1, easeInOut(inv(SLOW.c, SLOW.d, t)));
};
const GT = [];
{
    let g = 0;
    for (let i = 0; i <= DURATION * 1000; i++) { GT.push(g); g += speedAt(i / 1000) / 1000; }
}
const gameTime = t => { const i = clamp(t * 1000, 0, GT.length - 1); const i0 = Math.floor(i); return lerp(GT[i0], GT[Math.min(i0 + 1, GT.length - 1)], i - i0); };
const realTime = g => { let lo = 0, hi = GT.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (GT[m] < g) lo = m; else hi = m; } return lo / 1000; };

const sets = [];
function makeSet(name) {
    const group = new THREE.Group();
    group.visible = false;
    scene.add(group);
    const s = { name, group, update: () => {} };
    sets.push(s);
    return s;
}

const field = makeSet('field');
const blueBase = makeBase('blue', -31, 0, 10, 22);
const redBase = makeBase('red', 31, 0, 10, 22);
field.group.add(blueBase.group, redBase.group);
const M = rockCluster({ cx: 0, cz: -8.6, R: 4.7, n: 14, biome: 'sandstone', seed: 11, hMin: 1.32, hMax: 1.92 });
field.group.add(M.group);
const fieldRocks = [
    rockCluster({ cx: -12, cz: -17, R: 5.4, n: 16, biome: 'moss', seed: 3, hMin: 1.44, hMax: 2.28 }),
    rockCluster({ cx: 12, cz: -19, R: 6, n: 18, biome: 'crystal', seed: 5, hMin: 1.44, hMax: 2.4 }),
    rockCluster({ cx: -25, cz: -17, R: 3.6, n: 8, biome: 'clay', seed: 7 }),
    rockCluster({ cx: 25, cz: -16, R: 4, n: 9, biome: 'obsidian', seed: 9 }),
    rockCluster({ cx: -14, cz: 14, R: 3.3, n: 7, biome: 'magma', seed: 13 }),
    rockCluster({ cx: 15, cz: 15, R: 3.5, n: 8, biome: 'clay', seed: 15 }),
    rockCluster({ cx: 0, cz: -36, R: 9, n: 26, biome: 'obsidian', seed: 17, hMin: 1.8, hMax: 3.3 }),
    rockCluster({ cx: -30, cz: -34, R: 7, n: 16, biome: 'moss', seed: 19, hMin: 1.8, hMax: 3.0 }),
    rockCluster({ cx: 30, cz: -33, R: 7, n: 16, biome: 'magma', seed: 21, hMin: 1.8, hMax: 3.0 }),
    rockCluster({ cx: -1, cz: 22, R: 4, n: 9, biome: 'crystal', seed: 23 })
];
for (const rc of fieldRocks) field.group.add(rc.group);

const target = M.cells.reduce((best, c) => (c.c.z - 0.35 * Math.abs(c.c.x) > best.c.z - 0.35 * Math.abs(best.c.x) ? c : best));
const T = target.c;
const B0 = { x: T.x - 3.7, z: T.z + 5.3 };
const B1 = { x: T.x - 2.9, z: T.z + 2.4 };
const BL = { x: -6.5, z: 0.8 };
const RL = { x: 6.5, z: 0.8 };
const RS = { x: 13.6, z: 0.8 };
const GEM_UP = 1.05;
const KNOCK_V = v3(-2.6, 7.0, 5.6);

const blueLead = new Tank(COL.blue, 'basic');
const redLead = new Tank(COL.red, 'basic');
field.group.add(blueLead, redLead);

let tS = 99, tK = 99;
const aimMine = angleTo(B0.x, B0.z, T.x, T.z);
const leadCharge = g => g < 10 ? 0 : 1.5 * (g - 10) * clamp((g - 10) / 0.4 + 0.3);

function storyGem(t) {
    if (t < tS) return null;
    let p;
    if (t < tK) {
        const k = easeOutBack(inv(tS, tS + 0.42, t));
        p = { x: T.x, y: lerp(0.3, GEM_UP, k) + 0.07 * Math.sin((t - tS) * 4.2), z: T.z, spin: (t - tS) * 2.4 };
    } else {
        const p0 = storyGem(tK - 1e-4);
        const b = ballistic(p0, KNOCK_V, t - tK, 20, 0.66, 0.42, 0.55);
        p = { x: b.x, y: b.y, z: b.z, spin: p0.spin + 9 * (1 - Math.exp(-(t - tK) * 2.2)) + (t - tK) * 0.8 };
        if (b.rest) p.y += 0.05 * Math.sin(t * 3);
    }
    const trem = inv(5.0, 5.4, t) * (1 - inv(6.8, 7.0, t));
    if (trem > 0) p.y += Math.abs(Math.sin(t * 21)) * 0.13 * trem;
    return p;
}

function bluePose(g) {
    const t = g;
    if (t < tS + 0.08) return { x: B0.x, z: B0.z, a: aimMine };
    if (t < 3.25) {
        const k = easeInOut(inv(tS + 0.08, 3.2, t));
        const x = lerp(B0.x, B1.x, k), z = lerp(B0.z, B1.z, k);
        const gp = storyGem(t);
        return { x, z, a: lerpAngle(aimMine, angleTo(x, z, gp.x, gp.z), easeOut(inv(tS, tS + 0.5, t))) };
    }
    const aGem = angleTo(B1.x, B1.z, T.x, T.z);
    const aRed = angleTo(BL.x, BL.z, RL.x, RL.z);
    if (t < 3.5) {
        const k = inv(3.25, 3.5, t);
        return { x: B1.x - Math.sin(k * Math.PI) * 0.35, z: B1.z + Math.sin(k * Math.PI) * 0.2, a: aGem };
    }
    if (t < 4.4) {
        const k = easeInOut(inv(3.5, 4.4, t));
        return { x: lerp(B1.x, BL.x, k), z: lerp(B1.z, BL.z, k), a: lerpAngle(aGem, aRed, easeInOut(inv(3.7, 4.3, t))) };
    }
    const back = Math.PI - 0.32;
    let a = aRed + 0.04 * Math.sin(t * 2.3);
    if (t >= 5.0 && t < 6.0) a = lerpAngle(aRed, back + 0.12 * Math.sin(t * 5), easeInOut(inv(5.0, 5.35, t)));
    if (t >= 6.0) a = lerpAngle(back, aRed, easeOutBack(inv(6.0, 6.24, t))) + 0.03 * Math.sin(t * 2.1);
    return { x: BL.x + leadCharge(g), z: BL.z, a };
}
function redPose(g) {
    const t = g;
    const aBlue = angleTo(RL.x, RL.z, BL.x, BL.z);
    if (t < 3.5) {
        const gp = { x: T.x, z: T.z };
        return { x: RS.x, z: RS.z, a: angleTo(RS.x, RS.z, gp.x, gp.z) };
    }
    if (t < 4.5) {
        const k = easeOut(inv(3.5, 4.5, t));
        return { x: lerp(RS.x, RL.x, k), z: RL.z, a: lerpAngle(angleTo(RS.x, RS.z, T.x, T.z), aBlue, easeInOut(inv(3.5, 4.2, t))) };
    }
    const back = 0.32;
    let a = aBlue + 0.04 * Math.sin(t * 2.0 + 1);
    if (t >= 5.0 && t < 6.5) a = lerpAngle(aBlue, back - 0.12 * Math.sin(t * 5 + 1), easeInOut(inv(5.08, 5.42, t)));
    if (t >= 6.5) a = lerpAngle(back, aBlue, easeOutBack(inv(6.5, 6.74, t))) + 0.03 * Math.sin(t * 2.4);
    return { x: RL.x - leadCharge(g), z: RL.z, a };
}

const blueActor = new Actor(blueLead, bluePose, { speed: 18, life: 1.2 });
const redActor = new Actor(redLead, redPose, { speed: 22, life: 1.4 });
const mineFires = [0.2, 0.5, 0.8, 1.1, 1.4].map(t => blueActor.fire(t, { stopAt: { x: T.x, z: T.z, r: target.rad * 0.8 } }));
const mineHits = mineFires.map(f => blueActor.origin(f, 0).end);
tS = mineHits[mineHits.length - 1];
for (const f of mineFires) cue(f.t, 'shoot', 0.28);
mineHits.forEach((h, i) => cue(h, i === mineHits.length - 1 ? 'rock-break' : 'rock-hit', i === mineHits.length - 1 ? 0.6 : 0.35));
cue(tS + 0.05, 'ore-break', 0.5);
cue(tS + 0.12, 'gem-pickup', 0.45, 1.25);
const knockFire = redActor.fire(2.62, { stopAt: { x: T.x, z: T.z, r: 0.45 } });
tK = redActor.origin(knockFire, 0).end;
cue(2.62, 'shoot', 0.35, 0.85);
cue(tK, 'combat-hit', 0.9);
cue(tK + 0.02, 'gem-pickup', 0.35, 0.7);
const shatterChunks = burst({ t0: tS, at: v3(T.x, target.h * 0.55, T.z), n: 16, color: [target.color.getHexString(), shade(target.color, 0.88).getHexString()].map(h => '#' + h), seed: 31, speed: 5.5, up: 7, size: 0.34, spread: 1.4, spreadY: 1.6, life: 1.6 });
const shatterDust = puffs({ t0: tS, at: v3(T.x, 0.6, T.z), n: 9, seed: 32, size: 2.4, spread: 1.6, life: 1.1, color: '#f6efd8' });
const hitChips = mineHits.slice(0, -1).map((h, i) => burst({ t0: h, at: v3(T.x - 0.6, 1.0, T.z + target.rad * 0.7), n: 5, color: '#' + target.color.getHexString(), seed: 40 + i, speed: 3.5, up: 4.5, size: 0.14, life: 0.6, dir: v3(-0.5, 0, 0.7) }));
const knockSpark = puffs({ t0: tK, at: v3(T.x, GEM_UP, T.z), n: 5, seed: 50, size: 0.8, spread: 0.3, life: 0.35, color: '#fff3e8', speed: 3 });
const redSmoke = puffs({ t0: 3.45, at: v3(RS.x - 1.4, 1.0, RS.z), n: 5, seed: 51, size: 0.55, spread: 0.2, life: 1.3, color: '#d9d9de', rise: 0.8, speed: 0.3, stagger: 0.7, alpha: 0.7 });

const pebbles = (() => {
    const r = rng(77);
    const list = [];
    for (let i = 0; i < 70; i++) {
        const t0 = lerp(5.05, 6.95, r());
        const x = lerp(-11, 11, r()), z = lerp(-3.5, 4.5, r());
        list.push(...burst({ t0, at: v3(x, 0.1, z), n: 1, color: r() > 0.5 ? '#c4c7cf' : '#b7bac3', seed: 1000 + i, speed: 0.6, up: 3.2 + r() * 2, size: 0.11, life: 0.55, g: 26 }));
    }
    return list;
})();

const ARMY = { blue: [], red: [] };
{
    const kindsB = ['twin', 'sniper', 'mg', 'basic', 'flank', 'destroyer', 'tri', 'twin', 'mg', 'basic'];
    const kindsR = ['mg', 'twin', 'destroyer', 'basic', 'sniper', 'tri', 'twin', 'flank', 'basic', 'mg'];
    for (const team of ['blue', 'red']) {
        const r = rng(team === 'blue' ? 101 : 202);
        const sgn = team === 'blue' ? -1 : 1;
        const placed = [];
        for (let i = 0; i < 10; i++) {
            let sx = 0, sz = 0;
            for (let tries = 0; tries < 200; tries++) {
                sx = 9 + r() * 9;
                sz = lerp(-2.9, 4.6, r());
                if (sx < 12.5 && Math.abs(sz - 0.8) < 1.5) continue;
                if (placed.every(p => Math.hypot(p.x - sx, p.z - sz) > 2.5)) break;
            }
            placed.push({ x: sx, z: sz });
        }
        placed.forEach((s, i) => {
            const kind = (team === 'blue' ? kindsB : kindsR)[i];
            const tank = new Tank(team === 'blue' ? COL.blue : COL.red, kind);
            field.group.add(tank);
            const slotX = sgn * s.x;
            const slotZ = s.z;
            const startX = sgn * (27 + r() * 7);
            const startZ = lerp(-8, 8, r());
            const st = 7.0 + r() * 0.75;
            const bow = (r() - 0.5) * 5;
            const pace = 1.1 + r() * 2.3;
            const weaveA = 0.35 + r() * 0.8, weaveF = 0.8 + r() * 1.6;
            const face = team === 'blue' ? 0 : Math.PI;
            const ph = r() * 10;
            const aimSwing = 0.12 + r() * 0.2;
            const pose = g => {
                let x, z;
                if (g < st) { x = startX; z = startZ; }
                else if (g < 10) { const k = easeInOut(inv(st, 10, g)); x = lerp(startX, slotX, k); z = lerp(startZ, slotZ, k) + Math.sin(k * Math.PI) * bow; }
                else { const d = g - 10; x = slotX - sgn * pace * d; z = slotZ + weaveA * Math.sin(d * weaveF + ph) * clamp(d * 2); }
                return { x, z, a: face + aimSwing * wob(g, 1.2 + (ph % 1), ph) };
            };
            const actor = new Actor(tank, pose, { speed: kind === 'sniper' ? 22 : kind === 'destroyer' ? 12 : 15.5, life: 1.6 });
            let ft = 9.72 + r() * 0.3;
            let bi = 0;
            const gap = kind === 'destroyer' ? 0.75 : kind === 'mg' ? 0.2 : kind === 'sniper' ? 0.55 : 0.33;
            while (ft < DURATION) {
                const front = kind === 'flank' || kind === 'tri' ? [0] : kind === 'twin' ? [bi++ % 2] : null;
                const dieX = team === 'blue' ? lerp(-1.5, 4.2, r()) : lerp(-4.2, 1.5, r());
                actor.fire(ft, { barrels: front, dieX });
                ft += gap * 1.7 * (0.6 + r() * 0.9) + (r() < 0.15 ? 0.5 + r() * 0.6 : 0);
            }
            ARMY[team].push(actor);
        });
    }
}
{
    blueActor.speed = 15; redActor.speed = 15;
    const gm = gameTime(11.5);
    let hero = gm - 0.28;
    for (let i = 0; i < 3; i++) hero = gm - (Math.abs(BL.x + leadCharge(hero)) - 1.56 - 0.42) / 15;
    const times = [];
    for (let ft = 9.78; ft < DURATION; ft += 0.36) if (Math.abs(ft - hero) > 0.18) times.push(ft);
    times.push(hero);
    times.sort((a, b) => a - b);
    for (const ft of times) {
        blueActor.fire(ft, { dieX: -0.42 });
        redActor.fire(ft, { dieX: 0.42 });
    }
}
{
    const r = rng(555);
    const all = [...ARMY.blue, ...ARMY.red, blueActor, redActor];
    for (const a of all) for (const f of a.fires) {
        if (f.t < 9.7) continue;
        const rt = realTime(f.t);
        if (rt > 12.45) continue;
        const slow = speedAt(rt) < 0.5;
        if (r() < (slow ? 0.25 : 0.5)) cue(rt, r() > 0.5 ? 'shoot' : 'shoot2', slow ? 0.2 : 0.16, slow ? 0.45 : 0.9 + r() * 0.2);
    }
}
const S6_CENTER = v3(0, 1, 0.8);

field.update = (t) => {
    const g = gameTime(t);
    for (const c of M.cells) {
        const isT = c === target;
        c.part.visible = !(isT && g >= tS);
        if (isT && g < tS) {
            let fl = 0, sh = 0;
            for (let i = 0; i < mineHits.length - 1; i++) {
                const d = g - mineHits[i];
                if (d >= 0) { fl = Math.max(fl, 0.75 * Math.exp(-d * 14)); sh += Math.exp(-d * 18) * Math.sin(d * 70); }
            }
            c.part.flash(fl);
            c.part.position.set(c.c.x + sh * 0.06, 0, c.c.z - sh * 0.08);
        }
    }
    blueActor.update(g);
    redActor.update(g);
    for (const team of ['blue', 'red']) for (const a of ARMY[team]) a.update(g);
    drawBursts(shatterChunks, g);
    for (const hc of hitChips) drawBursts(hc, g);
    drawPuffs(shatterDust, g);
    drawPuffs(knockSpark, g);
    drawPuffs(redSmoke, g);
    drawBursts(pebbles, g);
    const gp = storyGem(g);
    if (gp) {
        const m = gemPool.get();
        m.position.set(gp.x, gp.y, gp.z);
        m.rotation.set(0.12 * Math.sin(g * 2), gp.spin, 0.1 * Math.cos(g * 1.7));
        m.scale.setScalar(clamp((g - tS) / 0.12) * 1.15);
    }
    for (const b of [blueBase, redBase]) {
        b.marker.rotation.y = t * 1.1;
        b.marker.position.y = 1.35 + 0.1 * Math.sin(t * 2.4);
    }
};

const sets2 = {};

function montageFloorRocks(set, ox, list) {
    for (const o of list) set.group.add(rockCluster({ ...o, cx: ox + o.cx }).group);
}

{
    const K = 300;
    const s = makeSet('kill');
    montageFloorRocks(s, K, [
        { cx: 7, cz: -13, R: 5.5, n: 14, biome: 'magma', seed: 61, hMin: 1.44, hMax: 2.28 },
        { cx: -9, cz: -15, R: 6, n: 15, biome: 'moss', seed: 62, hMin: 1.56, hMax: 2.4 },
        { cx: 1, cz: -28, R: 8, n: 18, biome: 'obsidian', seed: 63, hMin: 1.8, hMax: 3.0 }
    ]);
    const victim = new Tank(COL.red, 'twin');
    const shooter = new Tank(COL.blue, 'basic');
    const bgB = new Tank(COL.blue, 'mg');
    const bgR = new Tank(COL.red, 'basic');
    const bgR2 = new Tank(COL.red, 'sniper');
    s.group.add(victim, shooter, bgB, bgR, bgR2);
    const T0 = 12.5, DIE = 13.0;
    const vx = t => K + 1.4 - 0.9 * (t - T0);
    const hits = [12.7, 12.82, 12.94];
    const knock = t => hits.reduce((acc, h) => acc + (t > h ? 0.22 * (1 - Math.exp(-(t - h) * 16)) : 0), 0);
    const vActor = new Actor(victim, t => ({ x: vx(t) + knock(t), z: 0.2, a: Math.PI + 0.05 * Math.sin(t * 3) }), { speed: 16 });
    vActor.fire(12.52, { barrels: [0] });
    vActor.fire(12.68, { barrels: [1] });
    vActor.fire(12.84, { barrels: [0] });
    const sActor = new Actor(shooter, () => ({ x: K - 9.5, z: 0.25, a: 0 }), { speed: 24, life: 1 });
    for (const h of hits) {
        const mx = K - 9.5 + 1.56;
        const t0 = h - ((vx(h) + knock(h) - 1.0 - 0.4) - mx) / 24;
        sActor.fire(t0, { end: h });
        cue(h, 'combat-hit', 0.85, 1 + (h - 12.7) * 0.6);
    }
    cue(DIE, 'combat-kill', 1);
    cue(DIE + 0.02, 'die-on-screen', 0.5);
    const bgBA = new Actor(bgB, t => ({ x: K - 7, z: -6.5, a: 0.12 }), { speed: 15, life: 1.3 });
    const bgRA = new Actor(bgR, t => ({ x: K + 9, z: -5.5, a: Math.PI - 0.1 }), { speed: 15, life: 1.3 });
    const bgR2A = new Actor(bgR2, t => ({ x: K + 7.5, z: -9, a: Math.PI + 0.05 }), { speed: 20, life: 1.3 });
    for (let t = 11.6; t < 13.4; t += 0.2) bgBA.fire(t, { dieX: K + 1.5 });
    for (let t = 11.7; t < 13.4; t += 0.31) bgRA.fire(t, { dieX: K - 1 });
    for (let t = 11.75; t < 13.4; t += 0.5) bgR2A.fire(t, { dieX: K - 0.5 });
    const shards = burst({ t0: DIE, at: v3(K + 1.2, 1, 0.2), n: 14, color: [COL.red, '#f36a7d', COL.barrel], seed: 66, speed: 6.5, up: 7, size: 0.26, spread: 1.2, spreadY: 1.2, life: 1.2 });
    const deathPuff = puffs({ t0: DIE, at: v3(K + 1.2, 0.6, 0.2), n: 7, seed: 67, size: 2.2, spread: 1.2, life: 0.7, color: '#ffe7ea' });
    s.update = t => {
        for (const a of [sActor, bgBA, bgRA, bgR2A]) a.update(t);
        if (t < DIE + 0.24) {
            vActor.update(t);
            let fl = 0;
            for (const h of hits) if (t >= h) fl = Math.max(fl, 0.9 * Math.exp(-(t - h) * 15));
            victim.jiggles = hits;
            const dk = inv(DIE, DIE + 0.24, t);
            victim.flash(Math.max(fl, dk > 0 ? 0.35 : 0));
            victim.scale.setScalar(1 + 0.5 * easeOut(dk));
            victim.fade(1 - dk);
        } else victim.visible = false;
        drawBursts(shards, t);
        drawPuffs(deathPuff, t);
    };
    s.cam = t => {
        const k = inv(12.5, 13.25, t);
        const sh = t > DIE ? 0.12 * Math.exp(-(t - DIE) * 9) : 0;
        look(v3(K - 2.2 + k * 0.9 + wob(t, 40, 1) * sh, 1.6 + wob(t, 37, 2) * sh, 8.4 - k * 0.9), v3(K - 0.4, 1.0, 0.1), 38);
        fog(50, 160);
    };
    s.victim = victim;
    sets2.kill = s;
}

{
    const X = 600;
    const s = makeSet('mine');
    const rc = rockCluster({ cx: X + 2.6, cz: -1.8, R: 3.4, n: 9, biome: 'crystal', seed: 71, hMin: 1.14, hMax: 1.62 });
    s.group.add(rc.group);
    montageFloorRocks(s, X, [
        { cx: -6, cz: -14, R: 5, n: 12, biome: 'obsidian', seed: 72, hMin: 1.56, hMax: 2.4 },
        { cx: 11, cz: -13, R: 5, n: 12, biome: 'moss', seed: 73, hMin: 1.44, hMax: 2.16 }
    ]);
    const tgt = rc.cells.reduce((b, c) => (c.c.x * -0.7 + c.c.z > b.c.x * -0.7 + b.c.z ? c : b));
    const tank = new Tank(COL.blue, 'sniper');
    s.group.add(tank);
    const P = { x: X - 4.6, z: 2.4 };
    const aim = angleTo(P.x, P.z, tgt.c.x, tgt.c.z);
    const act = new Actor(tank, t => ({ x: P.x + (t > 13.8 ? 0.6 * easeOut(inv(13.8, 14.0, t)) : 0), z: P.z, a: aim }), { speed: 26, life: 1 });
    const fires = [13.2, 13.34, 13.48].map(t => act.fire(t, { stopAt: { x: tgt.c.x, z: tgt.c.z, r: tgt.rad * 0.8 } }));
    const hits = fires.map(f => act.origin(f, 0).end);
    const brk = hits[hits.length - 1];
    fires.forEach(f => cue(f.t, 'shoot', 0.5, 1.1));
    hits.forEach((h, i) => cue(h, i === hits.length - 1 ? 'rock-break' : 'rock-hit', 0.8));
    cue(brk + 0.03, 'ore-break', 0.9);
    const chunks = burst({ t0: brk, at: v3(tgt.c.x, tgt.h * 0.5, tgt.c.z), n: 14, color: ['#' + tgt.color.getHexString(), '#9fdcf6'], seed: 74, speed: 5.5, up: 7, size: 0.3, spread: 1.2, spreadY: 1.4, life: 1.2 });
    const dust = puffs({ t0: brk, at: v3(tgt.c.x, 0.6, tgt.c.z), n: 7, seed: 75, size: 2.1, spread: 1.4, life: 0.9, color: '#eaf7fd' });
    const gemV = [v3(-3.2, 7.5, 2.6), v3(-1.4, 8.5, 3.6), v3(-4.4, 6.2, 1.2)];
    const pick = [13.8, 13.86, 13.92];
    pick.forEach(p => cue(p + 0.1, 'gem-pickup', 0.6, 1.1));
    s.update = t => {
        for (const c of rc.cells) {
            const isT = c === tgt;
            c.part.visible = !(isT && t >= brk);
            if (isT) {
                let fl = 0;
                for (const h of hits.slice(0, -1)) if (t >= h) fl = Math.max(fl, 0.75 * Math.exp(-(t - h) * 14));
                c.part.flash(fl);
            }
        }
        act.update(t);
        drawBursts(chunks, t);
        drawPuffs(dust, t);
        if (t >= brk) gemV.forEach((v, i) => {
            const p0 = v3(tgt.c.x, 1.2, tgt.c.z);
            let p = ballistic(p0, v, t - brk, 22, 0.62, 0.4, 0.5);
            let sc = 1.1 * clamp((t - brk) / 0.1);
            const pt = pick[i];
            if (t > pt) {
                const k = easeIn(inv(pt, pt + 0.12, t));
                const tp = tank.position;
                const pp = ballistic(p0, v, pt - brk, 22, 0.62, 0.4, 0.5);
                p = { x: lerp(pp.x, tp.x, k), y: lerp(pp.y, 1, k), z: lerp(pp.z, tp.z, k) };
                sc *= 1 - k;
                if (k >= 1) return;
            }
            const m = gemPool.get();
            m.position.set(p.x, p.y, p.z);
            m.rotation.set(0.2, (t - brk) * 6 + i, 0.1);
            m.scale.setScalar(sc);
        });
    };
    s.cam = t => {
        const k = inv(13.25, 14, t);
        look(v3(X - 0.4 - k * 0.8, 2.3 + k * 0.2, 9.8 - k * 0.6), v3(X - 0.8, 0.9, 0.2), 40);
        fog(50, 160);
    };
    sets2.mine = s;
}

{
    const X = 900;
    const s = makeSet('bank');
    const base = makeBase('blue', X, 0, 16, 16);
    s.group.add(base.group);
    montageFloorRocks(s, X, [
        { cx: -14, cz: -16, R: 5, n: 12, biome: 'moss', seed: 81, hMin: 1.56, hMax: 2.28 },
        { cx: 12, cz: -18, R: 6, n: 14, biome: 'crystal', seed: 82, hMin: 1.56, hMax: 2.4 }
    ]);
    const carrier = new Tank(COL.blue, 'basic');
    const mate1 = new Tank(COL.blue, 'twin');
    const mate2 = new Tank(COL.blue, 'flank');
    s.group.add(carrier, mate1, mate2);
    const S = { x: X - 8.5, z: 6.5 }, E = { x: X - 3.6, z: 2.5 };
    const cPose = t => {
        const k = easeOut(inv(14.0, 14.42, t));
        const x = lerp(S.x, E.x, k), z = lerp(S.z, E.z, k);
        return { x, z, a: angleTo(x, z, X, 0) };
    };
    const cA = new Actor(carrier, cPose);
    const m1 = new Actor(mate1, t => ({ x: X + 5.5 - (t - 14) * 1.2, z: -5.5, a: Math.PI * 0.85 }));
    const m2 = new Actor(mate2, t => ({ x: X - 6, z: -6 + (t - 14) * 0.8, a: -0.6 + (t - 14) * 0.6 }));
    const dep = [0, 1, 2, 3, 4, 5].map(i => 14.46 + i * 0.085);
    dep.forEach((d, i) => cue(d + 0.25, 'deposit-tick', 0.7, 1 + i * 0.05));
    cue(15.0, 'deposit-done', 0.9);
    cue(15.02, 'bank-celebrate', 1);
    s.update = t => {
        cA.update(t); m1.update(t); m2.update(t);
        base.marker.rotation.y = t * 1.4;
        base.marker.position.y = 1.35 + 0.1 * Math.sin(t * 2.4) + 0.35 * Math.exp(-Math.max(0, t - 15.0) * 6) * (t >= 15.0 ? 1 : 0);
        dep.forEach((d, i) => {
            const k = inv(d, d + 0.25, t);
            if (t < d || k >= 1) return;
            const tp = carrier.position;
            const m = gemPool.get();
            const e = easeInOut(k);
            m.position.set(lerp(tp.x, X, e), lerp(1.2, 1.0, e) + Math.sin(k * Math.PI) * 2.4, lerp(tp.z, 0, e));
            m.rotation.set(0.3, t * 8 + i, 0);
            m.scale.setScalar(0.95 * (1 - easeIn(inv(0.85, 1, k)) * 0.6));
        });
        const lastLand = dep.filter(d => t >= d + 0.25).pop();
        const big = t >= 15.0;
        const pt = big ? 15.0 : lastLand;
        if (pt !== undefined) {
            const k = inv(pt, pt + (big ? 0.6 : 0.3), t);
            base.pulse.visible = k < 1;
            base.pulse.scale.setScalar(lerp(big ? 2.5 : 1.8, big ? 9 : 4.2, easeOut(k)));
            base.pulse.material.opacity = (1 - k) * (big ? 0.9 : 0.6);
        } else base.pulse.visible = false;
    };
    s.cam = t => {
        const k = easeInOut(inv(14, 15.25, t));
        const a = lerp(0.62, 0.92, k);
        const rad = lerp(12.5, 11, k);
        const c = v3(X - 1.4, 0.6, 0.6);
        look(v3(c.x + Math.cos(a) * rad * 0.62, lerp(5.2, 4.6, k), c.z + Math.sin(a) * rad), c, 40);
        fog(60, 180);
    };
    s.text = t => {
        if (t < 15.0) return null;
        return { p: v3(X, 3.2 + easeOut(inv(15, 15.25, t)) * 1.2, 0), k: easeOutBack(inv(15, 15.18, t)), a: 1 - inv(15.15, 15.25, t) * 0 };
    };
    sets2.bank = s;
}

{
    const X = 1200;
    const s = makeSet('threat');
    montageFloorRocks(s, X, [
        { cx: -8, cz: -10, R: 5, n: 12, biome: 'magma', seed: 91, hMin: 1.68, hMax: 2.52 },
        { cx: 9, cz: -11, R: 5.5, n: 13, biome: 'obsidian', seed: 92, hMin: 1.68, hMax: 2.64 },
        { cx: 0, cz: -26, R: 8, n: 18, biome: 'clay', seed: 93, hMin: 1.8, hMax: 3.0 }
    ]);
    const boss = new Tank(COL.red, 'destroyer', 1.7);
    const w1 = new Tank(COL.red, 'mg');
    const w2 = new Tank(COL.red, 'twin');
    s.group.add(boss, w1, w2);
    const FIRE = 15.72;
    const bA = new Actor(boss, t => ({ x: X, z: 0, a: lerpAngle(0.05, Math.PI / 2, easeInOut(inv(15.28, 15.58, t))) }), { speed: 22, life: 1 });
    bA.fire(FIRE, { scale: 1 });
    const w1A = new Actor(w1, t => ({ x: X - 5.2, z: -3.5, a: Math.PI / 2 - 0.35 }), { speed: 15, life: 1 });
    const w2A = new Actor(w2, t => ({ x: X + 5.4, z: -4, a: Math.PI / 2 + 0.3 }), { speed: 15, life: 1 });
    w1A.fire(15.4); w1A.fire(15.6); w1A.fire(15.8);
    w2A.fire(15.35, { barrels: [0] }); w2A.fire(15.55, { barrels: [1] }); w2A.fire(15.75, { barrels: [0] });
    cue(FIRE, 'shoot', 1, 0.55);
    cue(FIRE, 'combat-hurt', 0.6, 0.5);
    s.update = t => { bA.update(t); w1A.update(t); w2A.update(t); };
    s.cam = t => {
        const k = easeInOut(inv(15.25, 15.72, t));
        const sh = t > FIRE ? 0.2 * Math.exp(-(t - FIRE) * 7) : 0;
        look(v3(X + lerp(-2.4, 0, k) + wob(t, 45, 1) * sh, 1.7 + wob(t, 41, 2) * sh, lerp(10.5, 8.4, k)), v3(X, 1.75, 0), lerp(40, 46, k));
        fog(50, 170);
    };
    s.fill = t => inv(15.9, 15.98, t);
    sets2.threat = s;
}

function look(pos, target, fov, roll = 0) {
    camera.position.copy(pos);
    camera.up.set(Math.sin(roll), Math.cos(roll), 0);
    camera.lookAt(target);
    camera.fov = fov;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
}
function fog(near, far) { FOG.uFogNear.value = near; FOG.uFogFar.value = far; }
function shake(t, amp, ph = 0) { return v3(wob(t, 31, ph) * amp, wob(t, 27, ph + 2) * amp, wob(t, 23, ph + 4) * amp * 0.5); }
function bez(p0, p1, p2, p3, k) {
    const u = 1 - k;
    return p0.clone().multiplyScalar(u * u * u).addScaledVector(p1, 3 * u * u * k).addScaledVector(p2, 3 * u * k * k).addScaledVector(p3, k * k * k);
}
const tremor = t => inv(5.0, 5.5, t) * (1 - inv(5.9, 6.0, t)) * 0.06;

const camS1 = t => {
    const k = inv(0, 2.5, t);
    const L = Math.hypot(T.x - B0.x, T.z - B0.z);
    const f = { x: (T.x - B0.x) / L, z: (T.z - B0.z) / L };
    const rt = { x: -f.z, z: f.x };
    const side = lerp(7.2, 6.2, easeInOut(k)), back = lerp(1.2, -0.4, easeInOut(k));
    const pos = v3(B0.x + rt.x * side - f.x * back, lerp(1.7, 1.45, k), B0.z + rt.z * side - f.z * back);
    const mid = v3(lerp(B0.x, T.x, 0.48), 1.25, lerp(B0.z, T.z, 0.48));
    const sh = t > tS ? shake(t, 0.08 * Math.exp(-(t - tS) * 6)) : v3(0, 0, 0);
    look(pos.add(sh), mid, 40);
    fog(40, 150);
};
const camS2 = t => {
    const k = inv(2.5, 3.5, t);
    const g = v3(T.x, GEM_UP, T.z);
    const pos = v3(g.x + lerp(0.9, 0.55, k), lerp(1.35, 1.2, k), g.z + lerp(3.0, 2.2, k));
    const sh = t > tK ? shake(t, 0.06 * Math.exp(-(t - tK) * 7)) : v3(0, 0, 0);
    look(pos.add(sh), g.clone().add(v3(0, -0.05, 0)), 34);
    fog(30, 120);
};
const camS3 = t => {
    const k = inv(3.5, 6.0, t);
    const pos = v3(0, lerp(1.4, 1.3, k), lerp(17.5, 14.6, easeInOut(k)));
    look(pos.add(shake(t, tremor(t) * 2)), v3(0, 1.35, 0), 31);
    fog(50, 170);
};
const camS4a = t => {
    const k = easeOut(inv(6.0, 6.5, t));
    const b = blueLead.position;
    const pos = v3(b.x + lerp(3.5, 2.6, k), lerp(1.55, 1.35, k), b.z + lerp(2.5, 1.85, k));
    look(pos.add(shake(t, 0.03)), v3(b.x + 0.9, 1.05, b.z + 0.2), 34);
    fog(30, 130);
};
const camS4b = t => {
    const k = easeOut(inv(6.5, 7.0, t));
    const b = redLead.position;
    const pos = v3(b.x - lerp(3.5, 2.6, k), lerp(1.55, 1.35, k), b.z + lerp(2.5, 1.85, k));
    look(pos.add(shake(t, 0.03, 3)), v3(b.x - 0.9, 1.05, b.z + 0.2), 34);
    fog(30, 130);
};
const camS5 = t => {
    const k = easeInOut(inv(7.0, 9.75, t));
    const pos = bez(v3(-11.8, 1.45, 3.9), v3(-14.5, 2.4, 10), v3(-8, 22, 42), v3(0, 33, 48), k);
    const tgt = new THREE.Vector3().lerpVectors(v3(3, 1.1, 0.8), v3(0, 0, -2.5), easeInOut(inv(7.2, 9.75, t)));
    const drift = Math.max(0, t - 9.75);
    pos.x += drift * 0.6;
    look(pos, tgt, lerp(36, 44, k));
    fog(lerp(50, 120, k), lerp(170, 420, k));
};
const camS6 = t => {
    const c = S6_CENTER;
    const kIn = easeInOut(inv(10.85, 11.4, t));
    const kOut = easeOut(inv(12.15, 12.5, t));
    const pull = kIn * (1 - kOut);
    const rad = lerp(lerp(14, 12.8, inv(10, 10.85, t)), 9.5, pull);
    const az = Math.PI / 2 + lerp(0.12, -0.32, easeInOut(inv(10.95, 12.15, t))) * pull;
    const y = lerp(lerp(4.6, 4.2, inv(10, 10.85, t)), 6.6, pull);
    const pos = v3(c.x + Math.cos(az) * rad, y, c.z + Math.sin(az) * rad);
    const sh = speedAt(t) > 0.5 ? shake(t, 0.03, 5) : v3(0, 0, 0);
    look(pos.add(sh), v3(c.x, lerp(0.7, 0.9, pull), c.z - lerp(0.6, 0.2, pull)), lerp(50, 38, pull));
    fog(50, 170);
};

const SHOTS = [
    { t0: 0, t1: 2.5, set: field, cam: camS1, name: 'mine' },
    { t0: 2.5, t1: 3.5, set: field, cam: camS2, name: 'gem' },
    { t0: 3.5, t1: 6.0, set: field, cam: camS3, name: 'standoff' },
    { t0: 6.0, t1: 6.5, set: field, cam: camS4a, name: 'blueClose' },
    { t0: 6.5, t1: 7.0, set: field, cam: camS4b, name: 'redClose' },
    { t0: 7.0, t1: 10.0, set: field, cam: camS5, name: 'reveal' },
    { t0: 10.0, t1: 12.5, set: field, cam: camS6, name: 'charge' },
    { t0: 12.5, t1: 13.25, set: sets2.kill, cam: sets2.kill.cam, name: 'kill' },
    { t0: 13.25, t1: 14.0, set: sets2.mine, cam: sets2.mine.cam, name: 'mine2' },
    { t0: 14.0, t1: 15.25, set: sets2.bank, cam: sets2.bank.cam, name: 'bank' },
    { t0: 15.25, t1: 16.0, set: sets2.threat, cam: sets2.threat.cam, name: 'threat' },
    { t0: 16.0, t1: 17.0, flat: drawLineArt, name: 'flashes' },
    { t0: 17.0, t1: DURATION + 1, flat: drawEndCard, name: 'end' }
];
cue(3.62, 'buttonclick', 0.35, 1.3);
cue(5.36, 'buttonclick', 0.3, 0.9);
cue(7.15, 'rammer-move', 0.3, 0.8);
cue(8.2, 'rammer-move', 0.3, 0.7);

const strokeText = (c, text, x, y, fill, lw, stroke = COL.ink) => {
    c.lineJoin = 'round';
    c.lineWidth = lw;
    c.strokeStyle = stroke;
    c.strokeText(text, x, y);
    c.fillStyle = fill;
    c.fillText(text, x, y);
};
function screenOf(p) {
    const v = p.clone().project(camera);
    return { x: (v.x + 1) * 0.5 * W, y: (1 - v.y) * 0.5 * H, ok: v.z < 1 && v.z > -1 };
}
const pxPerUnit = p => H / (2 * Math.tan(camera.fov * Math.PI / 360) * p.distanceTo(camera.position));
function drawMark(c, ch, p, k, t, ph = 0, color = COL.gold) {
    if (k <= 0) return;
    const s = screenOf(p);
    if (!s.ok) return;
    const size = pxPerUnit(p) * 1.35 * k;
    c.save();
    c.translate(s.x, s.y);
    c.rotate(0.14 * Math.sin(t * 8 + ph));
    c.font = `${size}px 'Lilita One'`;
    c.textAlign = 'center';
    c.textBaseline = 'alphabetic';
    c.fillStyle = COL.ink;
    c.fillText(ch, size * 0.04, size * 0.07);
    strokeText(c, ch, 0, 0, color, size * 0.17);
    c.restore();
}
const markK = (t, a, b) => easeOutBack(inv(a, a + 0.2, t)) * (1 - easeIn(inv(b - 0.15, b, t)));

function overlayMarks(c, t) {
    if (t >= 3.5 && t < 6.0) {
        const bp = blueLead.position.clone().add(v3(0.1, 2.65, 0));
        const rp = redLead.position.clone().add(v3(-0.1, 2.65, 0));
        drawMark(c, '!', bp, markK(t, 3.62, 4.75), t, 0);
        drawMark(c, '?', bp, markK(t, 5.36, 6.0), t, 1);
        drawMark(c, '?', rp, markK(t, 5.44, 6.0), t, 2);
    }
}

const SCORE = {
    blue: [[13.02, 100], ...[0, 1, 2, 3, 4, 5].map(i => [14.71 + i * 0.085, 100]), [15.0, 0]],
    red: [[12.78, 100], [13.6, 150], [15.4, 150]]
};
const scoreAt = (team, t) => SCORE[team].reduce((acc, [et, v]) => acc + v * easeOut(inv(et, et + 0.2, t)), 0);
const popAt = (team, t) => SCORE[team].reduce((acc, [et]) => Math.max(acc, t >= et ? Math.exp(-(t - et) * 9) : 0), 0);
function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
}
function drawHud(c, t) {
    if (t < 9.4 || t >= 16) return;
    const k = easeOutBack(inv(9.4, 9.75, t));
    const y = lerp(-110, 30, k);
    const bw = 600, bh = 82, x = W / 2 - bw / 2;
    c.save();
    c.globalAlpha = clamp(k * 1.5);
    roundRect(c, x, y, bw, bh, 18);
    c.fillStyle = 'rgba(28,30,40,0.42)';
    c.fill();
    const b = scoreAt('blue', t), r = scoreAt('red', t);
    const frac = b + r < 1 ? 0.5 : b / (b + r);
    const barX = x + 22, barW = bw - 44, barY = y + bh - 26, barH = 14;
    roundRect(c, barX - 3, barY - 3, barW + 6, barH + 6, 10);
    c.fillStyle = 'rgba(0,0,0,0.35)'; c.fill();
    c.save();
    roundRect(c, barX, barY, barW, barH, 7); c.clip();
    c.fillStyle = COL.blue; c.fillRect(barX, barY, barW * frac, barH);
    c.fillStyle = COL.red; c.fillRect(barX + barW * frac, barY, barW * (1 - frac), barH);
    c.fillStyle = 'rgba(255,255,255,0.25)'; c.fillRect(barX, barY, barW, barH * 0.4);
    c.restore();
    c.font = `36px 'UbuntuB'`;
    c.textBaseline = 'alphabetic';
    const fmt = v => Math.round(v).toLocaleString('en-US');
    const drawSide = (label, val, color, side, pop) => {
        c.save();
        const tx = side < 0 ? x + 26 : x + bw - 26;
        c.textAlign = side < 0 ? 'left' : 'right';
        c.translate(tx, y + 44);
        c.scale(1 + pop * 0.18, 1 + pop * 0.18);
        c.lineJoin = 'round';
        c.lineWidth = 7;
        c.strokeStyle = 'rgba(20,20,28,0.85)';
        const text = `${label}  ${fmt(val)}`;
        c.strokeText(text, 0, 0);
        c.fillStyle = '#ffffff';
        c.fillText(text, 0, 0);
        c.restore();
        const dotX = side < 0 ? x - 4 : x + bw + 4;
        c.beginPath(); c.arc(dotX, y + bh / 2, 22, 0, Math.PI * 2);
        c.fillStyle = color; c.fill();
        c.lineWidth = 5; c.strokeStyle = shade(color, 0.62).getStyle(); c.stroke();
    };
    drawSide('Blue', b, COL.blue, -1, popAt('blue', t));
    drawSide('Red', r, COL.red, 1, popAt('red', t));
    c.font = `26px 'UbuntuB'`;
    c.textAlign = 'center';
    c.fillStyle = 'rgba(255,255,255,0.8)';
    c.fillText('Team Score', W / 2, y + 40);
    c.restore();
}
function drawBankText(c, t) {
    const info = sets2.bank.text(t);
    if (!info) return;
    const s = screenOf(info.p);
    if (!s.ok) return;
    c.save();
    c.translate(s.x, s.y);
    c.scale(info.k, info.k);
    c.rotate(-0.05);
    c.font = `96px 'Lilita One'`;
    c.textAlign = 'center';
    c.fillStyle = COL.ink;
    c.fillText('+600', 5, 8);
    strokeText(c, '+600', 0, 0, '#7fb6ff', 14);
    c.restore();
}

function jitterPath(c, pts, closed, r, amp) {
    c.beginPath();
    pts.forEach((p, i) => {
        const x = p[0] + (r() - 0.5) * amp, y = p[1] + (r() - 0.5) * amp;
        if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
    });
    if (closed) c.closePath();
    c.stroke();
}
function inkCircle(c, cx, cy, rad, r, amp) {
    const pts = [];
    const n = 48;
    for (let i = 0; i <= n; i++) {
        const a = i / n * Math.PI * 2 + 0.2;
        const rr = rad * (1 + (r() - 0.5) * 0.03);
        pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
    }
    jitterPath(c, pts, false, r, amp);
}
function inkTank(c, cx, cy, rad, ang, r, amp, barrelW = 0.84, barrelL = 1.9) {
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const P = (u, v) => [cx + (u * ca - v * sa) * rad, cy + (u * sa + v * ca) * rad];
    const hw = barrelW / 2;
    const u0 = Math.sqrt(Math.max(0, 1 - hw * hw));
    jitterPath(c, [P(u0, -hw), P(barrelL, -hw), P(barrelL, hw), P(u0, hw)], false, r, amp);
    inkCircle(c, cx, cy, rad, r, amp);
}
function speedLines(c, r, n, cx, cy, minR, maxR, amp) {
    for (let i = 0; i < n; i++) {
        const a = r() * Math.PI * 2;
        const r0 = lerp(minR, maxR, r()), r1 = r0 + lerp(80, 260, r());
        jitterPath(c, [[cx + Math.cos(a) * r0, cy + Math.sin(a) * r0], [cx + Math.cos(a) * r1, cy + Math.sin(a) * r1]], false, r, amp);
    }
}
function drawLineArt(c, t) {
    const lt = t - 16;
    const f = Math.floor(lt * FPS);
    const r = rng(9000 + Math.floor(f / 2));
    const panel = Math.floor(lt / (1 / 6));
    const dark = panel % 2 === 0 || panel >= 4;
    c.fillStyle = dark ? '#000000' : '#ffffff';
    c.fillRect(0, 0, W, H);
    c.strokeStyle = dark ? '#ffffff' : '#000000';
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.lineWidth = 11;
    const amp = 7;
    const zoom = 1 + (lt % (1 / 6)) * 0.6;
    c.save();
    c.translate(W / 2, H / 2);
    c.scale(zoom, zoom);
    c.translate(-W / 2, -H / 2);
    if (panel === 0) {
        inkTank(c, W * 0.42, H * 0.55, 230, -0.08, r, amp);
        c.lineWidth = 7;
        for (let i = 0; i < 7; i++) { const y = H * 0.3 + i * 70; const x = 150 + r() * 120; jitterPath(c, [[x, y], [x + 260 + r() * 200, y]], false, r, 5); }
    } else if (panel === 1) {
        inkTank(c, W * 0.6, H * 0.52, 260, Math.PI + 0.1, r, amp, 1.44, 1.95);
        c.lineWidth = 7;
        for (let i = 0; i < 7; i++) { const y = H * 0.25 + i * 80; const x = W - 150 - r() * 120; jitterPath(c, [[x, y], [x - 260 - r() * 200, y]], false, r, 5); }
    } else if (panel === 2) {
        inkTank(c, W * 0.2, H * 0.55, 140, 0, r, amp);
        inkTank(c, W * 0.8, H * 0.55, 140, Math.PI, r, amp);
        c.lineWidth = 9;
        inkCircle(c, W * 0.44, H * 0.55, 46, r, 5);
        inkCircle(c, W * 0.56, H * 0.55, 46, r, 5);
        speedLines(c, r, 14, W / 2, H * 0.55, 90, 140, 5);
    } else if (panel === 3) {
        c.lineWidth = 12;
        const cx = W / 2, cy = H / 2;
        const pts = [];
        const n = 22;
        for (let i = 0; i <= n; i++) {
            const a = i / n * Math.PI * 2;
            const rr = i % 2 === 0 ? 470 + r() * 120 : 170 + r() * 50;
            pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
        }
        jitterPath(c, pts, false, r, 10);
        c.lineWidth = 8;
        speedLines(c, r, 18, cx, cy, 560, 650, 6);
    } else {
        c.lineWidth = 4;
        if (lt < 0.8) for (let i = 0; i < 5; i++) { const x = r() * W, y = r() * H; jitterPath(c, [[x, y], [x + 30, y + (r() - 0.5) * 20]], false, r, 4); }
    }
    c.restore();
}

const logoImg = new Image();
logoImg.src = 'logo.svg';
function wordmarkParts(c, size) {
    c.font = `${size}px 'Lilita One'`;
    const wa = c.measureText('Corez').width;
    c.font = `${size * 0.66}px 'Lilita One'`;
    const wb = c.measureText('.io').width;
    return { wa, wb, w: wa + wb + 2 };
}
function drawWordmark(c, x, y, size) {
    const { wa } = wordmarkParts(c, size);
    const lw = size * 9 / 58;
    const ox = size * 3 / 58, oy = size * 5 / 58;
    c.save();
    c.translate(x, y);
    c.rotate(-3 * Math.PI / 180);
    c.textBaseline = 'alphabetic';
    c.textAlign = 'left';
    c.lineJoin = 'round';
    const pass = (dx, dy, fillA, fillB, stroke) => {
        c.font = `${size}px 'Lilita One'`;
        c.lineWidth = lw * 2;
        c.strokeStyle = stroke;
        c.strokeText('Corez', dx, dy);
        c.font = `${size * 0.66}px 'Lilita One'`;
        c.strokeText('.io', dx + wa + 2, dy);
        c.font = `${size}px 'Lilita One'`;
        c.fillStyle = fillA;
        c.fillText('Corez', dx, dy);
        c.font = `${size * 0.66}px 'Lilita One'`;
        c.fillStyle = fillB;
        c.fillText('.io', dx + wa + 2, dy);
    };
    pass(ox, oy, COL.ink, COL.ink, COL.ink);
    pass(0, 0, COL.gold, COL.copper, COL.ink);
    c.restore();
}
function drawModeTitle(c, cx, y, size) {
    const text = '2TDM';
    c.save();
    c.font = `${size}px 'Lilita One'`;
    c.textAlign = 'center';
    c.textBaseline = 'alphabetic';
    c.lineJoin = 'round';
    const w = c.measureText(text).width;
    const lw = size * 9 / 58;
    c.translate(cx, y);
    c.rotate(-3 * Math.PI / 180);
    c.lineWidth = lw * 2;
    c.strokeStyle = COL.ink;
    c.fillStyle = COL.ink;
    c.strokeText(text, size * 3 / 58, size * 5 / 58);
    c.fillText(text, size * 3 / 58, size * 5 / 58);
    c.strokeText(text, 0, 0);
    const split = (side, color) => {
        c.save();
        c.beginPath();
        const tilt = size * 0.25;
        if (side < 0) { c.moveTo(-w, -size * 1.2); c.lineTo(tilt, -size * 1.2); c.lineTo(-tilt, size * 0.4); c.lineTo(-w, size * 0.4); }
        else { c.moveTo(tilt, -size * 1.2); c.lineTo(w, -size * 1.2); c.lineTo(w, size * 0.4); c.lineTo(-tilt, size * 0.4); }
        c.closePath();
        c.clip();
        c.fillStyle = color;
        c.fillText(text, 0, 0);
        c.restore();
    };
    split(-1, '#4a93ff');
    split(1, '#ff5a70');
    c.restore();
}
const EMBERS = (() => {
    const r = rng(4242);
    return Array.from({ length: 70 }, (_, i) => ({ side: i % 2 ? 1 : -1, x: r(), sp: lerp(60, 170, r()), off: r() * 2000, size: lerp(2, 6, r()), ph: r() * 10, sway: lerp(10, 40, r()) }));
})();
function drawEndCard(c, t) {
    const lt = t - 17;
    c.fillStyle = '#0d0b12';
    c.fillRect(0, 0, W, H);
    const glowK = easeOut(inv(0, 0.6, lt));
    const g1 = c.createRadialGradient(W * 0.28, H * 0.72, 10, W * 0.28, H * 0.72, 900);
    g1.addColorStop(0, `rgba(47,127,242,${0.2 * glowK})`); g1.addColorStop(1, 'rgba(47,127,242,0)');
    c.fillStyle = g1; c.fillRect(0, 0, W, H);
    const g2 = c.createRadialGradient(W * 0.72, H * 0.72, 10, W * 0.72, H * 0.72, 900);
    g2.addColorStop(0, `rgba(240,64,90,${0.2 * glowK})`); g2.addColorStop(1, 'rgba(240,64,90,0)');
    c.fillStyle = g2; c.fillRect(0, 0, W, H);
    const g3 = c.createRadialGradient(W / 2, 330, 10, W / 2, 330, 620);
    g3.addColorStop(0, `rgba(255,210,74,${0.16 * glowK})`); g3.addColorStop(1, 'rgba(255,210,74,0)');
    c.fillStyle = g3; c.fillRect(0, 0, W, H);
    for (const e of EMBERS) {
        const y = H + 40 - ((lt * e.sp + e.off) % (H + 80));
        const x = (e.side < 0 ? e.x * W * 0.48 : W - e.x * W * 0.48) + Math.sin(lt * 1.3 + e.ph) * e.sway;
        const a = (0.35 + 0.35 * Math.sin(lt * 4 + e.ph)) * glowK;
        c.beginPath(); c.arc(x, y, e.size, 0, Math.PI * 2);
        c.fillStyle = e.side < 0 ? `rgba(110,170,255,${a})` : `rgba(255,110,130,${a})`;
        c.fill();
    }
    const slam = lt < 0.5 ? Math.exp(-lt * 10) : 0;
    const sx = wob(lt, 60, 1) * 14 * slam, sy = wob(lt, 55, 2) * 14 * slam;
    c.save();
    c.translate(sx, sy);
    const wmSize = 168;
    const { w: wmW } = wordmarkParts(c, wmSize);
    const emb = 220;
    const total = emb + 14 + wmW;
    const left = W / 2 - total / 2;
    const cy = 345;
    const ek = easeOutBack(inv(0, 0.42, lt));
    if (ek > 0 && logoImg.complete) {
        c.save();
        c.translate(left + emb / 2, cy);
        c.rotate(-8 * Math.PI / 180 - (1 - easeOut(inv(0, 0.55, lt))) * 3.2);
        c.scale(ek, ek);
        c.drawImage(logoImg, -emb / 2, -emb / 2, emb, emb);
        c.restore();
    }
    const wk = easeOutBack(inv(0.1, 0.42, lt));
    if (wk > 0) {
        c.save();
        const wx = left + emb + 14, wy = cy + wmSize * 0.33;
        c.translate(wx + wmW / 2, wy - wmSize * 0.3);
        const s = lerp(1.6, 1, wk);
        c.scale(s, s);
        c.globalAlpha = clamp(wk * 2);
        c.translate(-(wx + wmW / 2), -(wy - wmSize * 0.3));
        drawWordmark(c, wx, wy, wmSize);
        c.restore();
    }
    const nk = easeOut(inv(0.75, 1.1, lt));
    if (nk > 0) {
        c.save();
        c.globalAlpha = nk;
        c.font = `36px 'UbuntuB'`;
        c.letterSpacing = '10px';
        c.textAlign = 'center';
        c.fillStyle = '#c9c3d8';
        c.fillText('NEW MODE', W / 2 + 5, 535 + (1 - nk) * 20);
        c.restore();
    }
    const mk = easeOutBack(inv(0.9, 1.25, lt));
    if (mk > 0) {
        c.save();
        c.translate(W / 2, 735);
        const s = lerp(1.7, 1, mk);
        c.scale(s, s);
        c.globalAlpha = clamp(mk * 2);
        drawModeTitle(c, 0, 0, 190);
        c.restore();
    }
    const pk = easeOut(inv(1.7, 2.2, lt));
    if (pk > 0) {
        c.save();
        c.globalAlpha = pk;
        c.font = `50px 'UbuntuB'`;
        c.textAlign = 'center';
        const a = 'Play now on ', b = 'corez.io';
        const wa = c.measureText(a).width, wb = c.measureText(b).width;
        const x0 = W / 2 - (wa + wb) / 2;
        const y = 905 + (1 - pk) * 16;
        c.textAlign = 'left';
        c.fillStyle = '#eeeaf6';
        c.fillText(a, x0, y);
        c.fillStyle = COL.gold;
        c.fillText(b, x0 + wa, y);
        c.restore();
    }
    c.restore();
    if (lt < 0.07) { c.fillStyle = `rgba(255,255,255,${1 - lt / 0.07})`; c.fillRect(0, 0, W, H); }
    const fadeOut = inv(DURATION - 0.6, DURATION, t);
    if (fadeOut > 0) { c.fillStyle = `rgba(0,0,0,${fadeOut})`; c.fillRect(0, 0, W, H); }
}
cue(16.0, 'combat-hurt', 0.7, 0.8);
cue(16.17, 'combat-hit', 0.7, 0.7);
cue(16.33, 'combat-hurt', 0.7, 0.6);
cue(16.5, 'combat-kill', 0.8, 0.6);
cue(17.0, 'bank-celebrate', 0.9, 0.75);
cue(17.0, 'rock-break', 0.8, 0.5);
cue(17.92, 'combat-hit', 0.5, 0.8);

function shotAt(t) { return SHOTS.find(s => t >= s.t0 && t < s.t1) ?? SHOTS[SHOTS.length - 1]; }

function renderAt(t) {
    const shot = shotAt(t);
    if (shot.flat) {
        shot.flat(ctx, t);
        return;
    }
    for (const s of sets) s.group.visible = s === shot.set;
    for (const p of pools) p.begin();
    shot.set.update(t);
    for (const p of pools) p.end();
    shot.cam(t);
    renderer.render(scene, camera);
    ctx.drawImage(glCanvas, 0, 0);
    overlayMarks(ctx, t);
    if (shot.set === sets2.bank) drawBankText(ctx, t);
    if (shot.set === sets2.threat) {
        const k = sets2.threat.fill(t);
        if (k > 0) { ctx.fillStyle = `rgba(240,64,90,${k})`; ctx.fillRect(0, 0, W, H); }
    }
    drawHud(ctx, t);
}

window.CUES = CUES.sort((a, b) => a.t - b.t);
window.SHOTS = SHOTS.map(s => ({ t0: s.t0, t1: s.t1, name: s.name }));
window.DURATION = DURATION;
window.FPS = FPS;
window.renderFrame = (f, fmt = 'jpeg') => {
    renderAt(f / FPS);
    return out.toDataURL(fmt === 'png' ? 'image/png' : 'image/jpeg', 0.95).split(',')[1];
};
window.renderTime = (t, fmt = 'png') => {
    renderAt(t);
    return out.toDataURL(fmt === 'png' ? 'image/png' : 'image/jpeg', 0.95).split(',')[1];
};
Promise.all([document.fonts.load("40px 'Lilita One'"), document.fonts.load("40px 'UbuntuB'"), new Promise(r => { if (logoImg.complete) r(); else { logoImg.onload = r; logoImg.onerror = r; } })]).then(() => {
    renderAt(0);
    window.__ready = true;
});
