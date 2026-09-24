// Cookie header parsing and Set-Cookie serialising.
'use strict';

const config = require('./config');

// "a=1; b=2" -> {a:'1', b:'2'}. The first occurrence of a name wins, which is
// what browsers send for the most specific path.
function parse(header) {
    const out = Object.create(null);
    if (!header || typeof header !== 'string') return out;
    for (const part of header.split(';')) {
        const eq = part.indexOf('=');
        if (eq <= 0) continue;
        const name = part.slice(0, eq).trim();
        if (!name || name in out) continue;
        let value = part.slice(eq + 1).trim();
        if (value.length >= 2 && value[0] === '"' && value[value.length - 1] === '"') value = value.slice(1, -1);
        try {
            out[name] = decodeURIComponent(value);
        } catch (e) {
            out[name] = value;
        }
    }
    return out;
}

// All our cookies are HttpOnly and SameSite=Lax (Lax still rides along on
// the top-level GET back from Discord). Secure whenever the origin is https.
function serialize(name, value, opts = {}) {
    const parts = [`${name}=${encodeURIComponent(value)}`];
    parts.push('Path=' + (opts.path || '/'));
    if (opts.maxAge != null) parts.push('Max-Age=' + Math.max(0, Math.floor(opts.maxAge)));
    if (opts.maxAge === 0) parts.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
    parts.push('HttpOnly');
    parts.push('SameSite=' + (opts.sameSite || 'Lax'));
    if (opts.secure != null ? opts.secure : config.secure) parts.push('Secure');
    return parts.join('; ');
}

function clear(name, opts = {}) {
    return serialize(name, '', { ...opts, maxAge: 0 });
}

module.exports = { parse, serialize, clear };
