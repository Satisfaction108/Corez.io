// GET /auth/reset#<token>: a standalone password reset page that needs none
// of the game client. The admin /resetpassword link points at
// PUBLIC_ORIGIN/#reset=<token> (the menu's own form); this page is the
// fallback printed next to it. The token stays in the URL fragment, so it
// never reaches the server logs or a Referer; the page posts it to
// POST /api/auth/reset (same origin, JSON) and, on success, the browser is
// logged in and sent to the game.
'use strict';

const nodeCrypto = require('crypto');
const { BASE_HEADERS } = require('../http');

function page(nonce) {
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Reset password · Dig Wars</title>
<style nonce="${nonce}">
:root{color-scheme:dark;--bg:#16181d;--card:#20232b;--line:#343945;--text:#e8eaef;--dim:#9aa1ae;--accent:#3fb6a8;--bad:#e06c6c}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:16px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:16px}
main{width:100%;max-width:360px;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:24px}
h1{margin:0 0 4px;font-size:22px}p{margin:0 0 16px;color:var(--dim);font-size:14px}
label{display:block;font-size:13px;color:var(--dim);margin:12px 0 4px}
input{width:100%;padding:10px 12px;border-radius:6px;border:1px solid var(--line);background:var(--bg);color:var(--text);font-size:16px}
button{margin-top:18px;width:100%;padding:11px;border:0;border-radius:6px;background:var(--accent);color:#0d1312;font-weight:700;font-size:16px;cursor:pointer}
button:disabled{opacity:.6;cursor:default}#msg{margin-top:14px;font-size:14px;min-height:1.4em}.bad{color:var(--bad)}.ok{color:var(--accent)}
a{color:var(--accent)}
</style></head><body><main>
<h1>Reset password</h1><p id="who">Choose a new password for your Dig Wars account.</p>
<form id="f" autocomplete="off">
<label for="pw">New password</label><input id="pw" type="password" autocomplete="new-password" minlength="8" maxlength="128" required>
<label for="pw2">Type it again</label><input id="pw2" type="password" autocomplete="new-password" minlength="8" maxlength="128" required>
<button id="go" type="submit">Set password</button></form>
<div id="msg" role="status"></div>
</main>
<script nonce="${nonce}">
(function(){
  var h = location.hash.replace(/^#/, ''); var m = /(?:^|&)reset=([^&]+)/.exec(h);
  var token = decodeURIComponent(m ? m[1] : h);
  try { history.replaceState(null, '', location.pathname); } catch (e) {}
  var f = document.getElementById('f'), msg = document.getElementById('msg'), go = document.getElementById('go');
  function say(t, cls){ msg.textContent = t; msg.className = cls || ''; }
  if (!token || token.length < 20) { f.hidden = true; say('This reset link is broken. Ask an admin for a new one!', 'bad'); return; }
  f.addEventListener('submit', function(ev){
    ev.preventDefault();
    var a = document.getElementById('pw').value, b = document.getElementById('pw2').value;
    if (a !== b) return say("The passwords don't match.", 'bad');
    go.disabled = true; say('Saving...');
    fetch('/api/auth/reset', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: token, newPassword: a }) })
      .then(function(r){ return r.json().catch(function(){ return {}; }).then(function(j){ return { ok: r.ok, j: j }; }); })
      .then(function(res){
        if (res.ok) { f.hidden = true; say('Password changed! You are logged in' + (res.j.user ? ' as ' + res.j.user.username : '') + '.', 'ok');
          var a2 = document.createElement('a'); a2.href = '/'; a2.textContent = 'Play Dig Wars'; msg.appendChild(document.createElement('br')); msg.appendChild(a2); return; }
        go.disabled = false; say((res.j.error && res.j.error.message) || "That didn't work. Try again!", 'bad');
      }, function(){ go.disabled = false; say("Couldn't reach the server. Try again!", 'bad'); });
  });
})();
</script></body></html>`;
}

function getResetPage(ctx) {
    const nonce = nodeCrypto.randomBytes(16).toString('base64');
    const body = page(nonce);
    const h = {
        ...BASE_HEADERS,
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`,
        'Referrer-Policy': 'no-referrer',
        'X-Frame-Options': 'DENY',
    };
    if (ctx.outCookies.length) h['Set-Cookie'] = ctx.outCookies;
    ctx.res.writeHead(200, h);
    ctx.res.end(ctx.req.method === 'HEAD' ? undefined : body);
}

function register(router) {
    router.add('GET', '/auth/reset', getResetPage, { navigation: true });
}

module.exports = { register };
