(function () {
    var LV = window.DWLevels;
    var row = document.getElementById('lvRow');
    if (!LV || !row) return;
    var get = function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } };
    var raw = get('dwLvLast');
    var c = null;
    try { c = JSON.parse(raw || 'null'); } catch (e) { c = null; }
    if (!c || c.v !== 2 || !c.by || typeof c.by !== 'object') c = { last: '', by: {} };
    var key = '';
    if (get('dwAcctHint') === 'user') key = /^a:/.test(c.last || '') ? c.last : '';
    else if (/^[a-f0-9]{32}$/.test(get('dwGuestId') || '')) key = 'g:' + get('dwGuestId');
    var v = key ? c.by[key] : null;
    if (!v && raw == null && get('dwAcctHint') !== 'user') v = { level: 1, into: 0, need: LV.NEED[1], max: false };
    if (!v || !(v.level >= 1)) return;
    var fmt = function (n) { return (n | 0).toLocaleString('en-US'); };
    var k = v.max ? 1 : v.need > 0 ? Math.max(0, Math.min(1, v.into / v.need)) : 0;
    var fill = row.querySelector('.lv-fill'), lv = row.querySelector('.lv-lv'), xp = row.querySelector('.lv-xp'), chip = row.querySelector('.lv-chip');
    if (fill) fill.style.width = (k * 100).toFixed(1) + '%';
    if (lv) lv.textContent = 'Lvl ' + v.level;
    if (xp) xp.textContent = v.max ? 'Max level' : fmt(v.into) + ' / ' + fmt(v.need) + ' XP';
    var next = LV.nextUnlock(v.level);
    if (chip) { chip.hidden = !next; if (next) chip.textContent = 'Next: ' + LV.shortText(next, window.DWCosmetics) + ' at Lvl ' + next.level; }
    row.hidden = false;
    row.addEventListener('click', function () { if (!window.dwLevelsReady) window.__dwLvOpen = true; }, true);
})();
