class Activation {
    constructor(body) {
        this.body = body;
        this.active = true;
        this.timer = 15;
    }
    // A bot's bullets, drones and traps must keep simulating with no player
    // camera nearby, or off-screen bots can't mine or fight.
    botOwned() {
        if (this.body._rootIsBot === undefined) {
            let root = this.body, hops = 0;
            while (root.master && root.master !== root && hops++ < 8) root = root.master;
            this.body._rootIsBot = !!(root.isBot || root.isPlayer);
        }
        return this.body._rootIsBot;
    }
    update() {
        if (this.body.skipLife) { return this.active = false; }
        if (this.body.alwaysActive) { return this.active = true; }
        if (this.body.isDead()) { return 0; }
        switch (this.active) {
            case false:
                this.body.removeFromGrid();
                // A dropped gem is world state, not a projectile: it must survive
                // with no client camera covering it.
                if (this.body.settings.diesAtRange && !this.body.isGemPickup && !this.botOwned()) this.body.kill();
                if (!(this.timer--)) this.active = true;
                break;
            case true:
                this.body.addToGrid();
                this.timer = 15;
                this.active = this.body.isPlayer || this.body.isBot || this.botOwned() || global.gameManager.views.some(v => v.check(this.body, 0.6));
                break;
        }
    }
    check() { return this.active };
}

const dirtyCheck = function (p, r) {
    for (let i = 0; i < entitiesToAvoid.length; i++) {
        let e = entitiesToAvoid[i];
        if (Math.abs(p.x - e.x) < r + e.size && Math.abs(p.y - e.y) < r + e.size) return true;
    }
    return false
};

let remapTarget = (i, ref, self) => {
    if (i.target == null || !(i.main || i.alt)) return undefined;
    return {
        x: i.target.x + ref.x - self.x,
        y: i.target.y + ref.y - self.y,
    };
};

let lazyRealSizes = [1, 1, 1];
for (var i = 3; i < 17; i++) {
    // We say that the real size of a 0-gon, 1-gon, 2-gon is one, then push the real sizes of triangles, squares, etc...
    let circum = (2 * Math.PI) / i;
    lazyRealSizes.push(Math.sqrt(circum * (1 / Math.sin(circum))));
}

lazyRealSizes = new Proxy(lazyRealSizes, {
    get: function(arr, i) {
        if (!(i in arr) && !isNaN(i)) {
            let circum = (2 * Math.PI) / i;
            arr[i] = Math.sqrt(circum * (1 / Math.sin(circum)));
        }
        return arr[i];
    }
});

// Shots from a raid boss or a bot hit softer than their definitions: the
// root tank carries the factor (terrain/bosses.js tune, game/index.js
// BOT_SHOT_MULT)
// hit harder (terrain/growth.js damageMult). Read per collision by
// damageMultiplier(other), `target` being what the shot hit.
const botDiff = require('../../miscFiles/botDifficulty.js');
function rootOf(e) {
    let root = e, hops = 0;
    while (root && root.master && root.master !== root && hops++ < 8) root = root.master;
    return root;
}
let _fair = null;
function fairPlay() { return _fair || (_fair = require('../terrain/fairPlay.js')); }
function shotMult(o, target) {
    const root = rootOf(o.master);
    if (!root || root === o) return 1;
    let m = root.bossShotMult || 1;
    if (root.isBot) {
        // bot fire lands the same into every player, whoever they are
        const hit = target ? rootOf(target) : null;
        m = hit && hit.isPlayer ? botDiff.shotMult() : root.botShotMult || 1;
    }
    if (root.growthMult > 1 && global.royaleGrowth) m *= global.royaleGrowth.damageMult(root.growthMult);
    // anyone banking, bot or human, takes slightly softer shots from everyone
    if (target) {
        const hit = rootOf(target);
        if (hit && hit._bankCover > 0 && hit !== root) m *= fairPlay().bankCoverMult(hit);
    }
    return m;
}

module.exports = { dirtyCheck, remapTarget, lazyRealSizes, Activation, shotMult }