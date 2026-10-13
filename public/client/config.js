const config = {
    graphical: {
        borderChunk: 7.2,
        barChunk: 5,
        mininumBorderChunk: 0.5,
        deathBlurAmount: 3,
        slowerFOV: false,
        sharpEdges: false,
        curvyTraps: false,
        darkBorders: false,
        fancyAnimations: true,
        interpolation: false,
        lerpAnimations: false,
        lowResolution: false,
        // Performance toggles in the Graphics settings, all off by default
        fewerEffects: false,
        simpleTerrain: false,
        noShake: false,
        noGlow: false,
        noGlitch: false,
        lightSafe: false,    // Light Sensitive: no glitches, flashes or strobing, gentle shake
        fxLevel: 1,          // Effects: 0 Low, 1 Normal, 2 Max
        fpsCap30: false,
        coloredNest: false,
        colors: 'normal',
        pointy: true,
        showGrid: true,
        fontSizeBoost: 1.4,
        fontStrokeRatio: 4.5,
        neon: false,
        coloredHealthbars: false,
        separatedHealthbars: false,
        shakeProperties: {
            CameraShake: {
                shakeStartTime: -1,
                shakeDuration: -1,
                shakeAmount: -1,
                keepShake: false,
            },
            UIShake: {
                shakeStartTime: -1,
                shakeDuration: -1,
                shakeAmount: -1,
                keepShake: false,
            }
        }
    },
    animationSettings: { value: 1, scale: 1, ScaleBar: 20 },
    lag: {
        unresponsive: false,
        memory: 500,
        offset: +location.hash.match(/^(?:#debug_lag_offset=(\d+))?/)[1] || -50,
    },
    game: {
        autoLevelUp: false,
        centeredMinimap: false,
        incognitoMode: false,
        // Dig Wars toggles
        gemPopups: true,
        gemSounds: true,
        satchelWarning: true,
        leaderIndicators: true,
        warBar: true,
        // Hit feedback. One toggle covers the blink, the numbers, and the
        // callouts; the low-health vignette stays on as a survival cue.
        damageNumbers: true,
        hitFlash: true,
        lowHealthVignette: true,
    }
  };
  export { config }
// globals.
function createMessage(con, dur = 10_000, JSONMessage = false) {
    if (JSONMessage) {
        global.messages.push({
            text: "Nah that aint the text",
            faded: 0,
            textJSON: JSON.parse(con),
            time: Date.now(),
            duration: dur,
        });
    } else {
        // the same line again moves to the top instead of stacking twice
        const dup = global.messages.findIndex(m => !m.textJSON && m.text === con);
        if (dup >= 0) global.messages.splice(dup, 1);
        // a quick run of upgrades (a "Respawn as" climb, Machine Gun then
        // Minigun) is one line: the newest replaces the older ones (playtest 9:
        // they read in reverse order, newest on top)
        if (typeof con === "string" && con.startsWith("Upgraded to ")) {
            const t = Date.now();
            for (let i = global.messages.length - 1; i >= 0; i--) {
                const m = global.messages[i];
                if (!m.textJSON && typeof m.text === "string" && m.text.startsWith("Upgraded to ") && t - m.time < 6000) global.messages.splice(i, 1);
            }
        }
        global.messages.push({
            text: con,
            faded: 0,
            time: Date.now(),
            duration: dur,
        });
    }
};
function resetTarget() {
    global.player.target.x = 0;
    global.player.target.y = 0;
}
import { global } from "./global.js";
global.tips = [[
        "Tip: You can rebind any key in Settings > Keybinds."
    ], [
        "Tip: Banked gems are safe. What you're carrying drops when you die.",
        "Tip: Laggy? Turn on Fewer effects or Simple terrain in Settings.",
        "Tip: Mining Power makes you break rock much faster, so fill it early.",
        "Tip: Your base works as a bank too, but you only keep 80%.",
        "Tip: Chests and bosses pay the most, so grab them fast."
    ], [
        "Teaming up with other players isn't fair to everyone else, and you can get punished for it.",
        "Hunting one person over and over just to grief them isn't cool, and you can get punished for it.",
        "Multiboxing (running several tanks with a script) is cheating and will get you banned."
    ]
];
global.createMessage = (content, duration, JSONMessageMode) => createMessage(content, duration, JSONMessageMode);
global.resetTarget = () => resetTarget();