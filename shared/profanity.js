// Swear and slur filter for names and chat, shared by the server (require)
// and the client (<script> at /shared/profanity.js, window.DWProfanity).
//
// Each word or name piece is normalised first: lowercase, look-alike digits
// and symbols read as letters (0 o, 1 i or l, 3 e, 4 a, 5 s, 7 t, @ a, $ s),
// accents dropped, and letters spaced or dotted apart ("f u c k", "f.u.c.k")
// joined back up. Stretched letters ("fuuuck") still match, since every
// letter of a listed word may repeat.
//
// Two lists, so ordinary words stay clean ("class", "assassin",
// "Scunthorpe", "grapple", "therapist", "cocktail", "saltwater"):
//   ANYWHERE  stems no normal English word contains, matched inside a word
//   WHOLE     words matched only as a whole word, with a few endings (s, er,
//             ing...)
//
// mask(text)        the text with each bad word turned into asterisks
// hasProfanity(s)   true when a name or line has one
// guestName(name, holder)  a name safe to show: "Guest#1234" when it's bad,
//                    too short or empty (holder keeps the number steady)
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.DWProfanity = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const ANYWHERE = [
        'fuck', 'fck', 'phuck', 'motherfuck', 'shit', 'bitch', 'biatch', 'whore', 'slut', 'jizz',
        'nigger', 'nigga', 'niggr', 'faggot', 'fagot', 'dickhead', 'asshole', 'arsehole', 'cocksuck',
        'dipshit', 'bullshit', 'wanker', 'bastard', 'pedophil', 'paedophil', 'kkk', 'hitler',
    ];
    const WHOLE = [
        'fuk', 'fuking', 'ass', 'arse', 'cunt', 'cunty', 'cock', 'dick', 'pussy', 'pussies', 'twat', 'wank', 'cum',
        'tit', 'tits', 'titty', 'titties', 'boob', 'boobs', 'porn', 'porno', 'dildo', 'rape', 'raped', 'rapist',
        'fag', 'dyke', 'kike', 'chink', 'spic', 'coon', 'tranny', 'retard', 'retarded', 'nazi', 'kys',
        'killyourself', 'pedo', 'prick', 'bollocks', 'skank',
    ];
    const ENDINGS = ['s', 'es', 'er', 'ers', 'ed', 'ing'];
    // words that only look like a listed one
    const ALLOW = new Set(['shiitake', 'snigger', 'sniggers', 'sniggered', 'sniggering', 'cocktail', 'cocktails', 'cockpit', 'peacock', 'dickens']);

    // "fuck" -> /f+u+c+k+/: any letter may be stretched
    const stretch = (w) => new RegExp(w.split('').map(ch => ch + '+').join(''));
    const ANY_RE = ANYWHERE.map(w => w === 'shit' ? /s+h+i+t+(?!a)/ : stretch(w));   // not Matsushita, Yamashita
    const WHOLE_RE = WHOLE.map(w => new RegExp('^' + w.split('').map(ch => ch + '+').join('') + '(?:' + ENDINGS.join('|') + ')?$'));

    const LEET = { '0': 'o', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's', '!': 'i', '8': 'b', '9': 'g', '6': 'g' };
    // lowercase, accents off, look-alikes mapped; `one` is what 1 and | read as
    function norm(s, one) {
        s = String(s == null ? '' : s).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
        let out = '';
        for (const ch of s) out += ch === '1' || ch === '|' ? one : (LEET[ch] || ch);
        return out;
    }
    // just the letters
    const letters = (s) => s.replace(/[^a-z]/g, '');

    function wordIsBad(word) {
        for (const one of ['i', 'l']) {
            const w = letters(norm(word, one));
            if (!w) continue;
            if (ALLOW.has(w)) return false;
            for (const re of ANY_RE) if (re.test(w)) return true;
            for (const re of WHOLE_RE) if (re.test(w)) return true;
        }
        return false;
    }

    // a word plus its camelCase / underscore pieces ("BigShitGuy", "big_ass")
    function piecesOf(word) {
        const out = [word];
        for (const part of word.split(/[_\-.]+/)) {
            if (part && part !== word) out.push(part);
            for (const p of part.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)) if (p && p !== part) out.push(p);
        }
        return out;
    }

    // Spans of single characters set apart by spaces or punctuation
    // ("f u c k", "s.h.i.t", "b - i - t - c - h"): [start, end) in the text.
    const SPACED = /(?:^|(?<=[\s]))(?:[\p{L}0-9@$!|](?:[\s.\-_*,+~]+)){2,}[\p{L}0-9@$!|](?=[\s.,!?]*(?:\s|$))/gu;

    function hits(text) {
        const s = String(text == null ? '' : text);
        const out = [];
        let m;
        SPACED.lastIndex = 0;
        while ((m = SPACED.exec(s))) {
            // the letters and where each sits; mask only the bad stretch
            // ("you are a f u c k": not the "a")
            const at = [];
            const re = /[^\s.\-_*,+~]/gu;
            let c;
            while ((c = re.exec(m[0]))) at.push(m.index + c.index);
            for (let i = 0; i < at.length; i++) {
                for (let j = i + 2; j < at.length; j++) {
                    let joined = '';
                    for (let k = i; k <= j; k++) joined += s[at[k]];
                    if (!wordIsBad(joined)) continue;
                    // as tight as it goes on the left too
                    let a = i;
                    while (j - a >= 2 && wordIsBad(joined.slice(a - i + 1))) a++;
                    out.push([at[a], at[j] + 1]);
                    i = j;
                    break;
                }
            }
        }
        // every word (runs of anything but spaces)
        const word = /\S+/g;
        while ((m = word.exec(s))) {
            const at = m.index, w = m[0];
            if (out.some(([a, b]) => at >= a && at < b)) continue;
            if (piecesOf(w).some(wordIsBad)) out.push([at, at + w.length]);
        }
        return out;
    }

    function hasProfanity(text) {
        const s = String(text == null ? '' : text);
        if (hits(s).length) return true;
        // a name squashed together: "bigFUCKguy" is caught by ANYWHERE above,
        // and "f_u_c_k" by the letters alone
        const flat = letters(norm(s, 'i'));
        return flat.length >= 3 && flat.length <= 24 && wordIsBad(flat);
    }

    // Each bad word becomes asterisks (letters and digits only, so the shape
    // of the line stays).
    function mask(text) {
        const s = String(text == null ? '' : text);
        const list = hits(s);
        if (!list.length) return s;
        let out = '', last = 0;
        for (const [a, b] of list.sort((p, q) => p[0] - q[0])) {
            if (a < last) continue;
            out += s.slice(last, a) + s.slice(a, b).replace(/[^\s]/g, '*');
            last = b;
        }
        return out + s.slice(last);
    }

    // Guests and raid names: at least MIN_NAME characters and nothing rude,
    // else the fallback.
    const MIN_NAME = 5;
    const FALLBACK = 'Guest';
    // "Guest#4821": the number sticks to `holder` (a socket) so a player keeps
    // the same one for the session
    function fallbackName(holder) {
        let n = holder && holder._guestNo;
        if (!n) { n = 1000 + Math.floor(Math.random() * 9000); if (holder) holder._guestNo = n; }
        return FALLBACK + '#' + n;
    }
    function nameProblem(name) {
        const s = String(name == null ? '' : name).trim();
        if (Array.from(s).length < MIN_NAME) return 'short';
        if (hasProfanity(s)) return 'rude';
        return null;
    }
    function guestName(name, holder) {
        const s = String(name == null ? '' : name).trim();
        return nameProblem(s) ? fallbackName(holder) : s;
    }

    return { mask, hasProfanity, guestName, fallbackName, nameProblem, wordIsBad, MIN_NAME, FALLBACK };
});
