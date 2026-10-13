// Seed math
exports.random = x => x * Math.random()

exports.randomAngle = () => Math.PI * 2 * Math.random()

exports.randomRange = (min, max) => Math.random() * (max - min) + min

exports.irandom = i => {
    let max = Math.floor(i)
    return Math.floor(Math.random() * (max + 1)) //Inclusive
}

exports.irandomRange = (min, max) => {
    min = Math.ceil(min)
    max = Math.floor(max)
    return Math.floor(Math.random() * (max - min + 1)) + min //Inclusive
}

// does not clump the points in the middle
exports.pointInUnitCircle = () => {
    let angle = exports.randomAngle(),
        distance = Math.sqrt(Math.random());
    return {
        x: Math.cos(angle) * distance,
        y: Math.sin(angle) * distance
    };
}

exports.gauss = (mean=0, stdev=1) => {
    const u = 1 - Math.random();
    const v = Math.random();
    const z = Math.sqrt( -2.0 * Math.log( u ) ) * Math.cos( 2.0 * Math.PI * v );
    // Transform to the desired mean and standard deviation:
    return z * stdev + mean;
}

exports.gaussInverse = (min, max, clustering) => {
    let range = max - min
    let output = exports.gauss(0, range / clustering)

    while (output < 0) output += range;
    while (output > range) output -= range;
    return output + min
}

exports.gaussRing = (radius, clustering) => {
    let r = exports.random(Math.PI * 2)
    let d = exports.gauss(radius, radius * clustering)
    return {
        x: d * Math.cos(r),
        y: d * Math.sin(r),
    }
}

exports.chance = prob => exports.random(1) < prob

exports.dice = sides => exports.random(sides) < 1

exports.choose = (arr) => arr[exports.irandom(arr.length - 1)]

exports.chooseN = (arr, num) => {
    let result = [],
        extendedArr = [];
    while (extendedArr.length < num) {
        extendedArr.push(...exports.shuffle(arr));
    }
    for (var i = 0; i < num; i++) {
        result.push(extendedArr[i]);
    }
    return result;
}

exports.shuffle = (arr) => {
    arr = arr.slice(); //avoid changing the original array
    for (let i = arr.length - 1; i > 0; i--) {
        let j = Math.floor(Math.random() * i);
        [arr[j], arr[i]] = [arr[i], arr[j]];
    }
    return arr;
}

exports.chooseChance = (...arg) => {
    let totalProb = 0
    for (let value of arg)
        totalProb += value

    let answer = exports.random(totalProb)
    for (let i = 0; i < arg.length; i++) {
        if (answer < arg[i]) return i
        answer -= arg[i]
    }
}

exports.nameLists = {
    bots: ["Alice", "Bob", "Carmen", "David", "Edith", "Freddy", "Gustav", "Helga", "Janet", "Lorenzo", "Mary", "Nora", "Olivia", "Peter", "Queen", "Roger", "Suzanne", "Tommy", "Ursula", "Vincent", "Wilhelm", "Xerxes", "Yvonne", "Zachary", "Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Hotel", "India", "Juliet", "Kilo", "Lima", "Mike", "November", "Oscar", "Papa", "Quebec", "Romeo", "Sierra", "Tango", "Uniform", "Victor", "Whiskey", "X-Ray", "Yankee", "Zulu"],
    a: ["Archimedes", "Akilina", "Anastasios", "Athena", "Alkaios", "Amyntas", "Aniketos", "Artemis", "Anaxagoras", "Apollon"],
    castle: ["Berezhany", "Lutsk", "Dobromyl", "Akkerman", "Palanok", "Zolochiv", "Palanok", "Mangup", "Olseko", "Brody", "Isiaslav", "Kaffa", "Bilhorod"],
    legion: ["Vesta", "Juno", "Orcus", "Janus", "Minerva", "Ceres"]
}

exports.chooseBotName = (() => {
    const issued = new Set();

    // ── word pools ──
    const dig = [
        'mole','dig','rock','stone','gem','dust','ore','pick','mine',
        'shaft','vein','earth','clay','sand','pit','drill','bore','shard',
        'flint','slate','gravel','rubble','granite','basalt','crystal',
        'geode','pebble','boulder','cobble','dirt','mud','soot','rust',
        'ash','coal','iron','steel','copper','bronze','gold','silver',
        'zinc','lead','tin','quartz','jade','onyx','opal','ruby',
        'emerald','pearl','amber','topaz','agate','lode','fissure','crust',
        'stratum','bedrock','cinder','char','ember','spark','flame',
        'blaze','torch','lantern','cave','grotto','tunnel',
        'vault','hoard','cache','stash','loot','haul','yield','seam',
        'gouge','scrape','chip','wedge','maul','sledge','trowel',
    ];
    const general = [
        'frost','zephyr','viper','hawk','wolf','fox','bear','lynx','crow',
        'owl','kite','raven','wren','moth','newt','toad','crab','eel',
        'pike','bass','carp','seal','gull','tern','wisp','mist','haze',
        'fog','spark','bolt','surge','pulse','wave','tide','flow','rift',
        'void','echo','shade','ghost','phantom','reaper','blade','edge',
        'spike','thorn','fang','claw','talon','shank','razor','shear',
        'drift','wander','roam','scout','sentry','ward','guard','watch',
        'relic','rune','sigil','totem','idol','tusk','horn',
        'root','thorn','briar','vine','ivy','fern','moss','lichen',
        'warp','bend','twist','coil','loop','swerve','skew',
        'rust','oxide','patina','verdigris','tarnish','decay','erode',
        'silt','dregs','leech','slug','snail','grub','larva','mite',
    ];
    const words = [...dig, ...general];

    const clanTags = ['TNT','KOR','XD','GG','OP','FF','AFK','GGG','WP',
                      'LAG','EZ','MVP','ACE'];

    const leetMap = { a:'4', e:'3', i:'1', o:'0', s:'5', t:'7', g:'9', l:'1' };
    const uniSuffixes = ['','★','☆','✦','✧','•','◦']; // last 5% chance for non-empty

    // ── helpers ──
    const pick = arr => arr[Math.floor(Math.random() * arr.length)];
    const chance = p => Math.random() < p;

    function toLeet(w) {
        if (w.length < 4) return w;
        let out = '';
        for (const c of w) {
            const r = leetMap[c];
            out += r && chance(0.4) ? r : c;
        }
        return out;
    }

    function maybeDigits(w) {
        return chance(0.3) ? w + Math.floor(Math.random() * 99) : w;
    }

    function join(sep) {
        const a = pick(words);
        let b = pick(words);
        while (b === a && words.length > 1) b = pick(words);
        return a + (sep || '') + b;
    }

    // ── human-flavored pools (first names, moods, in-jokes) ──
    const firstNames = [
        'alex','sam','leo','max','ray','kai','finn','jay','ben','tom',
        'noah','liam','luca','theo','ezra','milo','remy','quinn','ash',
        'emma','mia','zoe','ivy','lily','nora','ruby','june','skye','wren',
        'dan','nick','luke','jake','ryan','cole','eli','owen','seth','joel',
        'kayden','jaxon','mason','logan','carter','austin','tyler','dylan',
    ];
    const moods = [
        'sleepy','angry','silent','shiny','crazy','lucky','sneaky','salty',
        'spicy','lazy','turbo','mega','mini','dark','neon','pro','sus',
        'ghosty','soggy','crusty','feral','chill','sweaty','goofy','silly',
        'evil','tiny','giga','average','unlucky','anonymous','random',
    ];
    const phrases = [
        'touchgrass','dontshootme','imjustmining','wheremygems','justvibing',
        'nolifer','whyamihere','imlost','pressw','holdmyore','freegems',
        'notavirus','yourlocalminer','gemgoblin','rockenjoyer','oreo',
        'taxevader','certifiedminer','sirdigsalot','gemme','mrbeast2',
        'peakgaming','ratioed','carriedbyteam','solowinner','afkfarmer',
        'literallyme','themedic','baitmaster','rockbottom','diggydiggy',
    ];

    function generate() {
        const r = Math.random();
        // 22% a first name, sometimes capitalized or numbered: "Milo", "sam234"
        if (r < 0.22) {
            let n = pick(firstNames);
            if (chance(0.4)) n = n[0].toUpperCase() + n.slice(1);
            return maybeDigits(n);
        }
        // 20% mood + word: "sleepywolf", "salty_miner", "turbofox"
        if (r < 0.42) {
            const sep = chance(0.2) ? '_' : '';
            return maybeDigits(pick(moods) + sep + pick(words));
        }
        // 15% an in-joke phrase: "touchgrass", "wheremygems"
        if (r < 0.57) return maybeDigits(pick(phrases));
        // 13% simple word
        if (r < 0.70) return maybeDigits(pick(words));
        // 12% two words joined
        if (r < 0.82) return maybeDigits(join(chance(0.25) ? '_' : ''));
        // 8% leet
        if (r < 0.90) return toLeet(chance(0.5) ? pick(moods) + pick(words) : pick(words));
        // 5% clan tagged
        if (r < 0.95) {
            const tag = pick(clanTags);
            const fmt = Math.random();
            const w = chance(0.4) ? pick(firstNames) : pick(words);
            if (fmt < 0.5) return '[' + tag + '] ' + w;
            return tag + ' | ' + w;
        }
        // 5% rare: word with unicode suffix
        return pick(words) + pick(uniSuffixes);
    }

    function chooseBotName() {
        for (let tries = 0; tries < 200; tries++) {
            let name = generate();
            if (name.length > 24) name = name.slice(0, 24);
            if (!issued.has(name)) {
                issued.add(name);
                return name;
            }
        }
        // fallback: numbered suffix
        let n = pick(words), suffix = 0;
        while (issued.has(n + suffix) && suffix < 9999) suffix++;
        const name = n + suffix;
        issued.add(name);
        return name;
    }
    chooseBotName.release = name => { issued.delete(name); };
    chooseBotName.reserve = name => { if (name) issued.add(String(name)); };
    return chooseBotName;
})();

exports.releaseBotName = name => { exports.chooseBotName.release(name); };
exports.reserveBotName = name => { exports.chooseBotName.reserve(name); };

exports.chooseBossName = (code, amount) => code in exports.nameLists ? exports.chooseN(exports.nameLists[code], amount) : []