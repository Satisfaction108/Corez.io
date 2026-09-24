// GET /api/quests        {day, resetsAt, quests:[{slot, id, text, goal, progress, rewardMilli, done}]}
// GET /api/achievements  {achievements:[{id, name, desc, goal, progress, unlockedAt}]}
// (accounts only). Quest progress made in a raid reaches the database within
// 5 s; a completion immediately.
'use strict';

const quests = require('../quests');
const achievements = require('../achievements');

function getQuests(ctx) {
    const a = ctx.requireAuth();
    ctx.json(200, quests.list(a.user.id, Date.now()));
}

function getAchievements(ctx) {
    const a = ctx.requireAuth();
    ctx.json(200, { achievements: achievements.list(a.user.id) });
}

function register(router) {
    router.add('GET', '/api/quests', getQuests);
    router.add('GET', '/api/achievements', getAchievements);
}

module.exports = { register };
