// GET  /api/quests        {day, resetsAt, quests:[{slot, id, text, goal, progress, rewardMilli, done}],
//                          streaks: streaks.view()}
// GET  /api/achievements  {achievements:[...], players, guest:false}   (accounts)
// POST /api/achievements  {guestId?} -> {achievements:[...], players, guest, adoptedNow}
//      Logged in wins; otherwise the browser's guest id (POST so it never sits
//      in a URL). An account made in the last day that sends the guest id of
//      the browser it was made on takes that guest's achievements over
//      (achievements.adoptGuest), rewards paid then.
//   achievements[]: {id, cat, name, desc, icon, color, tier, secret, goal,
//      progress, unlockedAt, rewardMilli, item, rarity (% of players)}
//      A secret one not unlocked comes back as ??? with no item.
// Quest progress made in a raid reaches the database within 5 s; a
// completion immediately. Achievement counters within 5 s, unlocks at once.
'use strict';

const quests = require('../quests');
const achievements = require('../achievements');
const streaks = require('../streaks');
const guests = require('../guests');
const users = require('../users');
const { HttpError } = require('../http');

function getQuests(ctx) {
    const a = ctx.requireAuth();
    const now = Date.now();
    ctx.json(200, { ...quests.list(a.user.id, now), streaks: streaks.view(a.user.id, now) });
}

function getAchievements(ctx) {
    const a = ctx.requireAuth();
    ctx.json(200, { achievements: achievements.list(a.user.id), players: achievements.rarity().players, guest: false });
}

function postAchievements(ctx) {
    ctx.limit('achievements', ctx.ipKey);
    const a = ctx.auth();
    const g = ctx.body && ctx.body.guestId;
    let owner, adoptedNow = null;
    if (a) {
        if (users.isBanned(a.user, ctx.now)) throw new HttpError(403, 'banned', 'This account is banned.');
        owner = { kind: 'a', id: a.user.id };
        if (guests.valid(g) && a.user.created_at >= ctx.now - achievements.NEW_ACCOUNT_MS) {
            const r = achievements.adoptGuest(g, a.user.id, ctx.now);
            if (r.moved.length) adoptedNow = { ids: r.moved, rewardMilli: r.rewardMilli, items: r.items };
        }
    } else if (guests.valid(g)) owner = { kind: 'g', id: g };
    else throw new HttpError(400, 'no_owner', 'Something went wrong. Please refresh and try again.');
    ctx.json(200, { achievements: achievements.listFor(owner, ctx.now), players: achievements.rarity(ctx.now).players, guest: owner.kind === 'g', adoptedNow });
}

function register(router) {
    router.add('GET', '/api/quests', getQuests);
    router.add('GET', '/api/achievements', getAchievements);
    router.add('POST', '/api/achievements', postAchievements);
}

module.exports = { register };
