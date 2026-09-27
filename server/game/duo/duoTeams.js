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
'use strict';

const RESERVE_MS = 90 * 1000;
const AWAY_MS = 120 * 1000;

class DuoTeams {
    constructor(opts = {}) {
        this.now = opts.now || (() => Date.now());
        this.newTeamId = opts.newTeamId || (() => -200 - Math.floor(Math.random() * 3000));
        this.reserveMs = opts.reserveMs != null ? opts.reserveMs : RESERVE_MS;
        this.awayMs = opts.awayMs != null ? opts.awayMs : AWAY_MS;
        this.teams = new Map();      // id -> team
        this.byMember = new Map();   // mk -> team id
    }

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
        const team = { id: this._freshId(), pid: pid || null, fill: !!fill, members: new Map(), expect: new Set(mates || []), createdAt: t, color: null };
        this.teams.set(team.id, team);
        return team;
    }

    _add(team, mk, name) {
        team.members.set(mk, { mk, name: name || '', joinedAt: this.now(), away: 0 });
        this.byMember.set(mk, team.id);
    }

    // Open for a stranger right now?
    fillable(team, t = this.now()) {
        if (team.members.size !== 1) return false;
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

    reset() { this.teams.clear(); this.byMember.clear(); }
}

// Team standings: group board rows by team (rows carry tm), sum score and
// kills, order like the solo board. -> [{tm, rows, score, kills, gems, alive, place}]
function teamStandings(rows) {
    const by = new Map();
    for (const r of rows) {
        const k = r.tm != null ? r.tm : 'x' + r.id;
        let t = by.get(k);
        if (!t) { t = { tm: r.tm != null ? r.tm : null, rows: [], score: 0, kills: 0, gems: 0, alive: false, here: false }; by.set(k, t); }
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

module.exports = { DuoTeams, teamStandings, RESERVE_MS, AWAY_MS };
