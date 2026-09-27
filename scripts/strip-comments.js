const fs = require('fs');
const path = require('path');

function stripComments(code) {
    let out = '';
    let i = 0;
    const n = code.length;

    let state = 'code'; // code, sq, dq, tpl, lc, bc
    let tplDepth = 0;
    let tplExpr = false;
    let regexAllowed = true;

    while (i < n) {
        const c = code[i];
        const next = code[i + 1];

        if (state === 'code') {
            // line comment
            if (c === '/' && next === '/') {
                state = 'lc';
                i += 2;
                continue;
            }
            // block comment
            if (c === '/' && next === '*') {
                state = 'bc';
                i += 2;
                continue;
            }
            // single-quote string
            if (c === "'") {
                state = 'sq';
                out += c;
                i++;
                continue;
            }
            // double-quote string
            if (c === '"') {
                state = 'dq';
                out += c;
                i++;
                continue;
            }
            // template literal
            if (c === '`') {
                state = 'tpl';
                tplDepth = 0;
                tplExpr = false;
                out += c;
                i++;
                continue;
            }
            // regex heuristic: '/' starts a regex when a value is expected
            if (c === '/' && regexAllowed && next && next !== '/' && next !== '*') {
                // scan to closing unescaped slash
                let j = i + 1;
                let inClass = false;
                let closed = false;
                while (j < n) {
                    if (code[j] === '\\') { j += 2; continue; }
                    if (code[j] === '[') inClass = true;
                    else if (code[j] === ']') inClass = false;
                    else if (code[j] === '/' && !inClass) { closed = true; break; }
                    j++;
                }
                if (closed) {
                    // include flags after closing /
                    let k = j + 1;
                    while (k < n && /[a-z]/i.test(code[k])) k++;
                    out += code.slice(i, k);
                    i = k;
                    regexAllowed = false;
                    continue;
                }
            }
            // track whether a regex can start based on last emitted char
            if (c === ')' || c === ']' || c === '}' || c === ';' || c === ',' || c === '.' || c === ':' ||
                /[a-zA-Z0-9_$]/.test(c)) {
                regexAllowed = false;
            } else {
                regexAllowed = true;
            }
            out += c;
            i++;
        }
        else if (state === 'lc') {
            if (c === '\n') {
                state = 'code';
                out += c;
            }
            i++;
        }
        else if (state === 'bc') {
            if (c === '*' && next === '/') {
                state = 'code';
                i += 2;
                // keep a newline if the block comment spanned lines
                continue;
            }
            if (c === '\n') out += c;
            i++;
        }
        else if (state === 'sq' || state === 'dq') {
            const quote = state === 'sq' ? "'" : '"';
            if (c === '\\') {
                out += c + (next || '');
                i += 2;
                continue;
            }
            if (c === quote) {
                state = 'code';
                regexAllowed = false;
            }
            out += c;
            i++;
        }
        else if (state === 'tpl') {
            if (tplExpr) {
                // inside ${...} - treat as code-ish
                if (c === "'") { state = 'tpl_sq'; out += c; i++; continue; }
                if (c === '"') { state = 'tpl_dq'; out += c; i++; continue; }
                if (c === '`') { out += c; i++; continue; }
                if (c === '{') { tplDepth++; out += c; i++; continue; }
                if (c === '}') {
                    tplDepth--;
                    out += c;
                    i++;
                    if (tplDepth === 0) tplExpr = false;
                    continue;
                }
                if (c === '/' && next === '/') {
                    out += '  ';
                    i += 2;
                    continue;
                }
                if (c === '/' && next === '*') {
                    out += '  ';
                    i += 2;
                    while (i < n && !(code[i] === '*' && code[i+1] === '/')) i++;
                    i += 2;
                    continue;
                }
                out += c;
                i++;
                continue;
            }
            if (c === '\\') {
                out += c + (next || '');
                i += 2;
                continue;
            }
            if (c === '`') {
                state = 'code';
                regexAllowed = false;
                out += c;
                i++;
                continue;
            }
            if (c === '$' && next === '{') {
                tplExpr = true;
                tplDepth = 1;
                out += '${';
                i += 2;
                continue;
            }
            out += c;
            i++;
        }
        else if (state === 'tpl_sq' || state === 'tpl_dq') {
            const quote = state === 'tpl_sq' ? "'" : '"';
            if (c === '\\') {
                out += c + (next || '');
                i += 2;
                continue;
            }
            if (c === quote) {
                state = 'tpl';
                out += c;
                i++;
                continue;
            }
            out += c;
            i++;
        }
    }

    // clean up: collapse multiple blank lines left by removed block comments
    out = out.replace(/\n{3,}/g, '\n\n');
    return out;
}

const files = process.argv.slice(2);
for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const stripped = stripComments(src);
    fs.writeFileSync(f, stripped);
    console.log(`stripped ${f}`);
}