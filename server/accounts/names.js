// Username rules, guest-name sanitising and password rules.
//
// Everything here is server-side only. The profanity check is deliberately
// small: a few severe terms matched as substrings of the leet-normalised
// name, and a list of milder words matched only as whole tokens (split on
// underscores and camelCase), so "Scunthorpe" or "grape_juice" still pass.
'use strict';

const USERNAME_RE = /^[A-Za-z0-9_]{3,16}$/;

// Compared after leet-normalising and dropping underscores, so "Adm1n" and
// "a_d_m_i_n" are caught too.
const RESERVED = new Set([
    'admin', 'administrator', 'admins', 'mod', 'mods', 'moderator', 'moderators', 'modteam',
    'staff', 'support', 'help', 'helpdesk', 'helper', 'system', 'sysadmin', 'sysop', 'root',
    'owner', 'dev', 'devs', 'developer', 'developers', 'official', 'server', 'console', 'bot',
    'bots', 'guest', 'guests', 'anonymous', 'anon', 'unknown', 'unnamed', 'player', 'players',
    'nobody', 'everyone', 'here', 'null', 'undefined', 'nan', 'true', 'false', 'none', 'void',
    'deleted', 'banned', 'removed', 'digwars', 'digwar', 'digroyale', 'arras', 'arrasio',
    'hackclub', 'discord', 'discordapp', 'clyde', 'api', 'www', 'http', 'https', 'account',
    'accounts', 'login', 'logout', 'signin', 'signup', 'register', 'settings', 'profile',
    'leaderboard', 'shop', 'store', 'itemshop', 'locker', 'friends', 'security', 'legend',
    'announcement', 'announcements', 'news', 'info', 'contact', 'abuse', 'noreply',
]);
// Names that merely start with these are also reserved ("Admin_Bob", "DigWarsTeam").
const RESERVED_PREFIXES = ['admin', 'moderator', 'digwars', 'official', 'sysadmin', 'staffteam'];

// Severe terms: matched anywhere in the normalised name.
const SEVERE = ['nigger', 'nigga', 'faggot', 'fagot', 'hitler', 'kkk', 'pedophile', 'paedophile'];
// Milder words: only when a whole token equals one of these.
const MILD = new Set([
    'fuck', 'fucker', 'fucking', 'fuk', 'fck', 'fuckyou', 'fuckoff', 'motherfucker', 'shit', 'shithead',
    'bullshit', 'bitch', 'bitches', 'cunt', 'dick', 'dickhead', 'cock', 'cocks', 'pussy', 'ass',
    'asshole', 'arsehole', 'bastard', 'whore', 'slut', 'penis', 'vagina', 'porn', 'porno', 'sex',
    'sexy', 'cum', 'jizz', 'dildo', 'tits', 'titties', 'boobs', 'wank', 'wanker', 'twat', 'rape',
    'nazi', 'nazis', 'fag', 'fags', 'kike', 'chink', 'spic', 'coon', 'tranny', 'incel', 'pedo',
    'molest', 'suicide', 'kys', 'killyourself', 'rapist', 'retard', 'retarded',
]);

const LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '6': 'g', '7': 't', '8': 'b', '9': 'g' };

function leet(s, oneAs = 'i') {
    let out = '';
    for (const ch of s.toLowerCase()) out += ch === '1' ? oneAs : (LEET[ch] || ch);
    return out;
}

function collapseRepeats(s) {
    return s.replace(/(.)\1+/g, '$1');
}

// Every spelling worth checking for one token: "1" read as i and as l, with
// the leading/trailing digits removed ("shit99"), and with runs collapsed
// ("shiiit").
function variants(token) {
    const out = new Set();
    const bases = [token, token.replace(/^\d+|\d+$/g, '')];
    for (const b of bases) {
        if (!b) continue;
        for (const one of ['i', 'l']) {
            const v = leet(b, one);
            out.add(v);
            out.add(collapseRepeats(v));
        }
    }
    return out;
}

function tokensOf(name) {
    const tokens = new Set();
    for (const part of name.split('_')) {
        if (!part) continue;
        tokens.add(part);
        // camelCase / PascalCase pieces: "BigShitGuy" -> Big, Shit, Guy
        for (const piece of part.split(/(?<=[a-z0-9])(?=[A-Z])/)) if (piece) tokens.add(piece);
    }
    tokens.add(name.replace(/_/g, ''));   // "s_h_i_t"
    return tokens;
}

function isProfane(name) {
    const whole = variants(name.replace(/_/g, ''));
    for (const v of whole) {
        for (const bad of SEVERE) if (v.includes(bad)) return true;
    }
    for (const token of tokensOf(name)) {
        for (const v of variants(token)) if (MILD.has(v)) return true;
    }
    return false;
}

function isReserved(name) {
    for (const v of variants(name.replace(/_/g, ''))) {
        if (RESERVED.has(v)) return true;
        for (const p of RESERVED_PREFIXES) if (v.startsWith(p)) return true;
    }
    return false;
}

const USERNAME_MESSAGES = {
    type: 'Pick a username.',
    too_short: 'Names need at least 3 characters.',
    too_long: 'Names can be 16 characters max.',
    invalid_chars: 'Use only letters, numbers and underscores.',
    underscores: 'Too many underscores in a row.',
    reserved: "That name's off-limits. Try another!",
    profanity: "That name isn't allowed. Try another!",
};

// -> {ok:true} | {ok:false, reason, message}. Does not check availability
// or holds (users.js does, it needs the database).
function validateUsername(name) {
    const fail = reason => ({ ok: false, reason, message: USERNAME_MESSAGES[reason] });
    if (typeof name !== 'string' || !name) return fail('type');
    if (name.length < 3) return fail('too_short');
    if (name.length > 16) return fail('too_long');
    if (!USERNAME_RE.test(name)) return fail('invalid_chars');
    if (/^_+$/.test(name) || name.includes('___')) return fail('underscores');
    if (isReserved(name)) return fail('reserved');
    if (isProfane(name)) return fail('profanity');
    return { ok: true };
}

// Guest (and any displayed) names: no colour-code marker, no control, zero
// width, bidi or tag characters, no zalgo stacks, single spaces, 24 chars max.
const STRIP_RE = /[\u00A7\u0000-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF0-\uFFFB]|[\u{E0000}-\u{E007F}]|[\u{E0100}-\u{E01EF}]/gu;

// Letters from other scripts that pass for ASCII ones in the game's font.
// Keys are single code points; capitals are listed where the capital is the
// look-alike (Greek H is "h", although its lowercase is not).
const CONFUSABLES = {
    // Cyrillic
    '\u0430': 'a', '\u0435': 'e', '\u043E': 'o', '\u0440': 'p', '\u0441': 'c', '\u0443': 'y', '\u0445': 'x',
    '\u0456': 'i', '\u0458': 'j', '\u0455': 's', '\u0501': 'd', '\u04CF': 'l', '\u04BB': 'h', '\u051B': 'q', '\u051D': 'w',
    '\u0410': 'a', '\u0412': 'b', '\u0415': 'e', '\u041A': 'k', '\u041C': 'm', '\u041D': 'h', '\u041E': 'o',
    '\u0420': 'p', '\u0421': 'c', '\u0422': 't', '\u0423': 'y', '\u0425': 'x', '\u0406': 'i', '\u0408': 'j',
    '\u0405': 's', '\u0500': 'd', '\u04C0': 'l',
    // Greek
    '\u0391': 'a', '\u0392': 'b', '\u0395': 'e', '\u0396': 'z', '\u0397': 'h', '\u0399': 'i', '\u039A': 'k',
    '\u039C': 'm', '\u039D': 'n', '\u039F': 'o', '\u03A1': 'p', '\u03A4': 't', '\u03A5': 'y', '\u03A7': 'x',
    '\u03B1': 'a', '\u03B9': 'i', '\u03BA': 'k', '\u03BF': 'o', '\u03C1': 'p', '\u03C4': 't', '\u03C5': 'u',
    '\u03BD': 'v', '\u03C7': 'x',
    // Latin / Armenian odds and ends
    '\u0261': 'g', '\u0578': 'n', '\u0585': 'o', '\u0131': 'i', '\u0237': 'j',
};

// A comparison key for "does this read as that": NFKC (fullwidth and other
// compatibility forms become ASCII), look-alike letters mapped to ASCII,
// lowercase, combining marks stripped. Digits are kept as they are, since
// usernames can contain them.
function foldConfusables(str) {
    const s = String(str == null ? '' : str).normalize('NFKC').normalize('NFD').replace(/\p{M}/gu, '');
    let out = '';
    for (const ch of s) {
        const lower = ch.toLowerCase();
        out += CONFUSABLES[ch] || CONFUSABLES[lower] || lower;
    }
    return out;
}

function sanitizeGuestName(name) {
    let s = String(name == null ? '' : name).normalize('NFC').replace(STRIP_RE, '');
    s = s.replace(/(\p{M}{2})\p{M}+/gu, '$1');          // at most 2 stacked combining marks
    s = s.replace(/\s+/gu, ' ').trim();
    const chars = Array.from(s);                          // count code points, never split a pair
    if (chars.length > 24) s = chars.slice(0, 24).join('').trim();
    return s;
}

// Friend chat: line breaks and tabs read as spaces, then the same strip as
// guest names (control, bidi, zero-width, fillers), stacked marks capped,
// whitespace collapsed. The caller checks the length (in code points).
function sanitizeMessage(body) {
    let s = String(body == null ? '' : body).normalize('NFC').replace(/[\t\n\v\f\r\u0085\u2028\u2029]/g, ' ').replace(STRIP_RE, '');
    s = s.replace(/(\p{M}{2})\p{M}+/gu, '$1');
    return s.replace(/\s+/gu, ' ').trim();
}

// About 200 of the most common passwords that pass the length rule, plus a
// few game-specific ones. Compared case-insensitively.
const COMMON_PASSWORDS = new Set(`
password password1 password12 password123 password1234 passw0rd p@ssword p@ssw0rd pa55word pa55w0rd
12345678 123456789 1234567890 12345678910 0123456789 87654321 987654321 9876543210 11111111 00000000
22222222 88888888 99999999 12341234 11223344 12121212 13131313 69696969 123123123 147258369 159753258
qwertyui qwerty12 qwerty123 qwerty1234 qwertyuiop 1qaz2wsx 1q2w3e4r 1q2w3e4r5t 1q2w3e4r5t6y q1w2e3r4
zaq12wsx asdfghjk asdfghjkl asdf1234 zxcvbnm1 zxcvbnm123 abcd1234 abc12345 abcdefgh abcdefg1 aa123456
iloveyou iloveyou1 iloveyou2 princess princess1 sunshine sunshine1 football football1 baseball
basketball soccer12 hockey12 superman batman12 spiderman starwars starwars1 pokemon1 pokemon123
minecraft minecraft1 minecraft123 fortnite fortnite1 fortnite123 roblox12 roblox123 robloxian
letmein1 letmein123 welcome1 welcome12 welcome123 trustno1 whatever whatever1 computer computer1
internet michael1 jennifer jordan23 charlie1 master12 masterkey access14 shadow12 monkey12 monkey123
dragon12 dragon123 killer12 freedom1 mustang1 ferrari1 corvette chelsea1 liverpool arsenal1 manchester
cheese12 chocolate cookie12 butterfly flower12 purple12 orange12 banana12 pepper12 summer12 summer2024
summer2025 winter12 autumn12 spring12 august12 october1 november december january1 february
hello123 hello1234 helloworld lovely12 loveme12 lover123 babygirl babygirl1 angel123 blessed1 jesus123
secret12 secret123 changeme changeme1 default1 administrator admin123 admin1234 root1234 test1234
testing1 testing123 guest123 user1234 login123 pass1234 passpass mypassword yourpassword nopassword
qazwsxedc 1qazxsw2 asdasdasd qweqweqwe zxczxczxc aaaaaaaa abababab abcabcabc 123abc123 a1b2c3d4
gamer123 gaming123 player123 noob1234 pro12345 hacker12 hunter12 ranger12 thunder1 lightning
digwars digwars1 digwars123 digwars2024 digwars2025 digwars2026 arras123 arrasio1 diggerman
`.trim().split(/\s+/));

const PASSWORD_MESSAGES = {
    type: 'Enter a password.',
    too_short: 'Passwords need at least 8 characters.',
    too_long: 'Passwords can be 128 characters max.',
    same_as_username: "Your password can't be your username.",
    common: "That password's too easy to guess. Try another!",
};

// -> {ok:true} | {ok:false, reason, message}
function validatePassword(password, username) {
    const fail = reason => ({ ok: false, reason, message: PASSWORD_MESSAGES[reason] });
    if (typeof password !== 'string' || !password) return fail('type');
    const length = Array.from(password).length;
    if (length < 8) return fail('too_short');
    if (length > 128) return fail('too_long');
    const lc = password.toLowerCase();
    if (username && lc === String(username).toLowerCase()) return fail('same_as_username');
    if (COMMON_PASSWORDS.has(lc)) return fail('common');
    return { ok: true };
}

module.exports = {
    validateUsername,
    validatePassword,
    sanitizeGuestName,
    sanitizeMessage,
    foldConfusables,
    isReserved,
    isProfane,
    COMMON_PASSWORDS,
};
