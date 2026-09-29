// Duo teams on the duo raid server: who shares a team with whom. Pure
// bookkeeping (no entities, no sockets), so the rules can be tested alone;
// dig_royale.js and sockets.js do the wiring.
//
// A team has at most two human members, keyed by a member key (mk):
//   a party ticket's mk ('u:<id>' / 'g:<id>'), else 'u:<account id>' for an
//   account, else 't:<resume token>' for a guest tab.
// Team ids are arras team numbers (negative), so sharing one means no
// friendly fire and one body colour.
//
// Rules:
//   - a member always gets their own team back (respawn, reconnect, a new raid)
//   - party members (same pid) share a team; that team never takes strangers
//   - a lone player with fill on joins the oldest team that has one member
//     and is open for fill (another lone filler, or a party whose mate never
//     turned up within RESERVE_MS); otherwise they get a fresh team, open for
//     the next filler: two lone players queueing close together get paired,
//     and a later lone joiner fills an empty partner slot
//   - fill off: a team of one, closed
//   - a disconnected member keeps their slot for AWAY_MS (the raid's resume
//     window), then the slot frees; an empty team is gone
//
// The fill queue (wait/match): a lone filler with no team does not spawn
// straight away, they wait. match() pairs two waiters into a fresh team (or
// seats a waiter in an open team whose partner left for good); a waiter who
// has waited fillWaitMs gets a team of their own with a bot teammate
// (team.bot), which never takes a stranger.
//
// team.key names one formation of a team (a second member arriving, or a bot
// teammate): standings group rows by it, so a departed partner's row never
// merges with whoever takes the slot next, and a team id reused later can't
// pull strangers into one row.
'use strict';

const RESERVE_MS = 90 * 1000;
const AWAY_MS = 45 * 1000;
const FILL_WAIT_MS = 45 * 1000;

class DuoTeams {
    constructor(opts = {}) {
        this.now = opts.now || (() => Date.now());
        this.newTeamId = opts.newTeamId || (() => -200 - Math.floor(Math.random() * 3000));
        this.reserveMs = opts.reserveMs != null ? opts.reserveMs : RESERVE_MS;
        this.awayMs = opts.awayMs != null ? opts.awayMs : AWAY_MS;
        this.fillWaitMs = opts.fillWaitMs != null ? opts.fillWaitMs : FILL_WAIT_MS;
        this.teams = new Map();      // id -> team
        this.byMember = new Map();   // mk -> team id
        this.waiting = new Map();    // mk -> {mk, name, since}  (the fill queue)
        this.keySeq = 0;
    }

    _newKey(prefix = 'd') { return prefix + (++this.keySeq); }

    _freshId() {
        for (let i = 0; i < 100; i++) {
            const id = this.newTeamId();
            if (!this.teams.has(id)) return id;
        }
        let id = -5000;
        while (this.teams.has(id)) id--;
        return id;
    }

    _make(pid, fill, mates) {
        const t = this.now();
        const team = { id: this._freshId(), pid: pid || null, fill: !!fill, members: new Map(), expect: new Set(mates || []), createdAt: t, color: null, key: null, bot: null };
        this.teams.set(team.id, team);
        return team;
    }

    _add(team, mk, name) {
        team.members.set(mk, { mk, name: name || '', joinedAt: this.now(), away: 0 });
        this.byMember.set(mk, team.id);
        this.waiting.delete(mk);
        // a pair forms (or re-forms around a new partner): a new standings key
        if (team.members.size === 2) team.key = this._newKey();
    }

    // Open for a stranger right now?
    fillable(team, t = this.now()) {
        if (team.members.size !== 1) return false;
        if (team.bot) return false;                  // has a bot teammate: kept, no swap mid-raid
        if (!team.pid) return team.fill;
        // a party whose mate never showed: open after the reservation, if
        // the member who is here asked for fill
        return team.fill && t - team.createdAt > this.reserveMs;
    }

    // {mk, pid?, mates?, fill, name} -> {team, created, paired}
    join(req) {
        const t = this.now();
        const mk = req.mk;
        const had = this.byMember.get(mk);
        if (had != null && this.teams.has(had)) {
            const team = this.teams.get(had);
            const m = team.members.get(mk);
            // a ticket for a different party moves you over (new party, same tab)
            if (!(req.pid && team.pid !== req.pid)) {
                if (m) { m.away = 0; if (req.name) m.name = req.name; }
                return { team, created: false, paired: team.members.size > 1 };
            }
            this.drop(mk);
        }
        if (req.pid) {
            for (const team of this.teams.values()) {
                if (team.pid !== req.pid) continue;
                if (team.members.size < 2) {
                    this._add(team, mk, req.name);
                    return { team, created: false, paired: team.members.size > 1 };
                }
            }
            const team = this._make(req.pid, req.fill, req.mates);
            this._add(team, mk, req.name);
            return { team, created: true, paired: false };
        }
        if (req.fill) {
            let best = null;
            for (const team of this.teams.values()) {
                if (!this.fillable(team, t)) continue;
                const other = [...team.members.values()][0];
                if (other && other.away) continue;           // don't pair with someone who is gone
                if (!best || team.createdAt < best.createdAt) best = team;
            }
            if (best) {
                this._add(best, mk, req.name);
                return { team: best, created: false, paired: true };
            }
            const team = this._make(null, true);
            this._add(team, mk, req.name);
            return { team, created: true, paired: false };
        }
        const team = this._make(null, false);
        this._add(team, mk, req.name);
        return { team, created: true, paired: false };
    }

    // The socket closed: the slot is kept for awayMs.
    away(mk) {
        const team = this.teamOf(mk);
        const m = team && team.members.get(mk);
        if (m && !m.away) m.away = this.now();
    }

    back(mk) {
        const team = this.teamOf(mk);
        const m = team && team.members.get(mk);
        if (m) m.away = 0;
    }

    drop(mk) {
        this.waiting.delete(mk);
        const id = this.byMember.get(mk);
        if (id == null) return null;
        this.byMember.delete(mk);
        const team = this.teams.get(id);
        if (!team) return null;
        team.members.delete(mk);
        if (!team.members.size) this.teams.delete(id);
        return team;
    }

    // -> the teams that lost a member
    sweep() {
        const t = this.now();
        const touched = [];
        for (const team of [...this.teams.values()]) {
            for (const m of [...team.members.values()]) {
                if (m.away && t - m.away > this.awayMs) {
                    this.drop(m.mk);
                    touched.push(team);
                }
            }
        }
        return touched;
    }

    teamOf(mk) {
        const id = this.byMember.get(mk);
        return id == null ? null : this.teams.get(id) || null;
    }

    teamById(id) { return this.teams.get(id) || null; }

    mateOf(mk) {
        const team = this.teamOf(mk);
        if (!team) return null;
        for (const m of team.members.values()) if (m.mk !== mk) return m;
        return null;
    }

    // Is this team id one of ours (a human duo team)?
    has(id) { return this.teams.has(id); }

    // ---- the fill queue ----

    // A lone filler with no team starts (or keeps) waiting. -> the entry
    wait(mk, name) {
        let w = this.waiting.get(mk);
        if (!w) { w = { mk, name: name || '', since: this.now() }; this.waiting.set(mk, w); }
        else if (name) w.name = name;
        return w;
    }

    unwait(mk) { return this.waiting.delete(mk); }

    isWaiting(mk) { return this.waiting.has(mk); }

    // Settle the queue. -> [{kind:'pair', team, mks:[a, b]}
    //                      | {kind:'join', team, mk}      (an open team's empty slot)
    //                      | {kind:'bot', team, mk}]      (waited fillWaitMs: bot teammate)
    // canBot(): false holds a timed-out waiter in the queue (no bot room).
    match(canBot = () => true) {
        const t = this.now();
        const out = [];
        const list = [...this.waiting.values()].sort((a, b) => a.since - b.since);
        // two waiters: one fresh team, both in
        while (list.length >= 2) {
            const a = list.shift(), b = list.shift();
            const team = this._make(null, true);
            this._add(team, a.mk, a.name);
            this._add(team, b.mk, b.name);
            out.push({ kind: 'pair', team, mks: [a.mk, b.mk] });
        }
        for (const w of list) {
            // an open slot: a lone player whose partner left for good (or a
            // party whose mate never came, past the reservation)
            let best = null;
            for (const team of this.teams.values()) {
                if (!this.fillable(team, t)) continue;
                const other = [...team.members.values()][0];
                if (other && other.away) continue;
                if (!best || team.createdAt < best.createdAt) best = team;
            }
            if (best) {
                this._add(best, w.mk, w.name);
                out.push({ kind: 'join', team: best, mk: w.mk });
                continue;
            }
            if (t - w.since >= this.fillWaitMs && canBot()) {
                const team = this._make(null, false);
                this._add(team, w.mk, w.name);
                this.attachBot(team);
                out.push({ kind: 'bot', team, mk: w.mk });
            }
        }
        return out;
    }

    // A bot teammate for a team of one (never takes a stranger after this).
    attachBot(team, name) {
        team.fill = false;
        team.bot = { name: name || '', fam: null, body: null, respawnAt: 0 };
        team.key = this._newKey();
        return team.bot;
    }

    reset() { this.teams.clear(); this.byMember.clear(); this.waiting.clear(); }
}

// Team standings: group board rows by team (rows carry tm, the formation
// key; rows without one stand alone), sum score and kills, order like the
// solo board. A team is at most two rows: if more ever share a key (a bug
// upstream), the extras stand alone and it is logged once.
// -> [{tm, rows, score, kills, gems, alive, place}]
let overfullLogged = false;
function teamStandings(rows) {
    const by = new Map();
    const count = new Map();
    for (const r of rows) {
        let k = r.tm != null ? r.tm : 'x' + r.id;
        if (r.tm != null) {
            const n = (count.get(k) || 0) + 1;
            count.set(k, n);
            if (n > 2) {
                if (!overfullLogged) { overfullLogged = true; console.warn('[DUO] more than two rows on team key', k, 'split'); }
                k = 'x' + r.id;
            }
        }
        let t = by.get(k);
        if (!t) { t = { tm: typeof k === 'string' && k[0] === 'x' ? null : r.tm, rows: [], score: 0, kills: 0, gems: 0, alive: false, here: false }; by.set(k, t); }
        t.rows.push(r);
        t.score += r.score | 0;
        t.kills += r.kills | 0;
        t.gems += r.gems | 0;
        if (r.alive) t.alive = true;
        if (r.here) t.here = true;
    }
    const out = [...by.values()].sort((a, b) => (b.score - a.score) || (b.gems - a.gems) || (b.kills - a.kills));
    out.forEach((t, i) => { t.place = i + 1; });
    return out;
}

module.exports = { DuoTeams, teamStandings, RESERVE_MS, AWAY_MS, FILL_WAIT_MS };
