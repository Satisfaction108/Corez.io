// The "every day's prize" panel's words, from /api/daily's status and the shared

export const dustTxt = (milli) => { const v = (+milli || 0) / 1000; return Number.isInteger(v) ? String(v) : String(+v.toFixed(2)); };

export function itemWords(it) {
    if (!it) return '';
    return it.cat === 'sidekick' ? it.name + ' sidekick' : it.cat === 'sdSkin' ? it.name + ' sidekick skin' : it.name;
}

const hours = (ms) => Math.round(ms / 3600000);

export function ruleLine(DY) {
    return 'The next day unlocks ' + hours(DY.UNLOCK_MS) + 'h after your last claim. If you miss ' +
        hours(DY.GRACE_MS) + 'h, you drop back ' + DY.DROP_BACK + ' days, but never to zero. After day ' + DY.DAYS + ', it starts over.';
}

export function rows(st, DY, opts = {}) {
    const guest = !!opts.guest;
    const out = [];
    if (!st || !Array.isArray(st.track) || !DY) return { rows: out, rule: DY ? ruleLine(DY) : '', guest };
    // a finished week shows all seven until day 1 comes round again (pips())
    const done = !st.ready && st.step === DY.DAYS ? DY.DAYS : (st.day | 0) - 1;
    const cur = st.day | 0;
    for (let i = 1; i <= DY.DAYS; i++) {
        const r = st.track[i - 1] || { day: i, dustMilli: 0 };
        const def = DY.TRACK[i - 1] || {};
        let state = 'later';
        if (i <= done) state = 'done';
        else if (done < DY.DAYS && i === cur) state = st.ready ? 'today' : 'next';
        else if (st.ready && done < DY.DAYS && i === cur + 1) state = 'next';
        let text, note = '';
        if (r.item) {
            text = itemWords(r.item);
            if (def.fallbackMilli > 0) note = dustTxt(def.fallbackMilli + (r.dustMilli | 0)) + ' gemdust if you already own it';
        } else {
            text = dustTxt(r.dustMilli) + ' gemdust';
            if (r.had) note = 'You already own the ' + itemWords(r.had);
        }
        if (guest && state !== 'done') note = note ? note + '. Sign up to claim it.' : 'Sign up to claim it.';
        out.push({ day: i, state, text, note, item: r.item || null });
    }
    return { rows: out, rule: ruleLine(DY), guest };
}

export const STATE_WORDS = { done: 'Claimed', today: 'Today', next: 'Next', later: '' };
