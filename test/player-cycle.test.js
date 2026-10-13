import { strict as assert } from 'node:assert';
import { it } from 'node:test';
import { AppController } from '../src/app.js';
import { Battle } from '../src/combat/engine.js';
import { normalizePowerSystem } from '../src/core/schema.js';

function switchingFixture() {
    const app = new AppController({ name1: '甲', chatMetadata: {}, extensionSettings: {}, saveSettingsDebounced() {}, async saveMetadata() {} });
    app.battle = new Battle(normalizePowerSystem({ combatants: [
        { name: '甲', side: 'ally', isUser: true }, { name: '乙', side: 'ally' }, { name: '敌', side: 'enemy' },
    ] }), { seed: 'switch-player' });
    app.battle.start();
    app.settings.battle.userUnitName = '甲';
    app.battle.turnIndex = app.battle.initiative.findIndex(e => e.name === '甲');
    return app;
}

it('换人只保存唯一玩家身份，不推进、不消耗骰子，等待提交技能', async () => {
    const app = switchingFixture();
    app._autoDriveStop = true;
    app._autoDriveBudget = 99;
    app._decisionQueue = { byUnit: { stale: {} } };
    const observations = [];
    app.on('state-changed', () => observations.push(app.battle.units.filter(u => app.isUserUnit(u)).map(u => u.name)));
    let runs = 0;
    app.autoAdvance = async () => { runs++; return { ok: true }; };
    const before = app.battle.toState();
    assert.equal((await app.setUserUnit('乙')).ok, true);
    app._maybeContinueAutoDrive();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(app._autoDriveStop, true);
    assert.equal(app.battle.awaitingPlayerAction, true);
    assert.equal(app.battle.round, before.round);
    assert.equal(app.battle.turnIndex, before.turnIndex);
    assert.deepEqual(app.battle.rng.snapshot(), before.rngSnapshot);
    assert.deepEqual(app.battle.log, before.log);
    assert.equal(app._decisionQueue, null);
    assert.ok(app._autoDriveBudget < 99);
    assert.ok(observations.every(names => names.length === 1 && names[0] === '乙'));
    assert.equal(runs, 0);
});

it('AI处理中拒绝换人，取消和重新指定均等到手动提交才恢复', async () => {
    const app = switchingFixture();
    app.busy = true;
    assert.equal((await app.setUserUnit('乙')).ok, false);
    assert.equal(app.settings.battle.userUnitName, '甲');
    app.busy = false;
    assert.equal((await app.setUserUnit('')).ok, true);
    assert.equal(app._autoDriveStop, true);
    assert.equal((await app.setUserUnit('甲')).ok, true);
    assert.equal(app._autoDriveStop, true);
    assert.equal(app.battle.awaitingPlayerAction, true);
});

it('重绘反复请求推进只排一个任务，切换战斗使旧任务失效', async () => {
    const app = switchingFixture();
    app.battle.turnIndex = app.battle.initiative.findIndex(e => e.name === '敌');
    let runs = 0;
    app.autoAdvance = async () => { runs++; };
    app._maybeContinueAutoDrive();
    app._maybeContinueAutoDrive();
    app.battle = null;
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(runs, 0);
    assert.equal(app._autoDriveScheduled, false);
});

it('玩家一次选技等待完整 AI 阶段，并阻止重复提交', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const events = [];
    const app = {
        battle: { currentUnit: { isUser: true } }, busy: false,
        isUserUnit: (u) => u?.isUser === true,
        setBusy(value) { this.busy = value; }, notify() {},
        async act(action) { events.push(action.skillId); return { ok: true }; },
        async autoAdvance() { events.push('AI'); await gate; events.push('回到玩家'); },
    };
    const first = AppController.prototype.playPlayerTurn.call(app, { skillId: '玩家技能' });
    await Promise.resolve();
    assert.equal(app.busy, true);
    const duplicate = await AppController.prototype.playPlayerTurn.call(app, { skillId: '重复技能' });
    assert.equal(duplicate.ok, false);
    release();
    assert.equal((await first).ok, true);
    assert.deepEqual(events, ['玩家技能', 'AI', '回到玩家']);
    assert.equal(app.busy, false);
    assert.equal(app._playerTurnRunning, false);
});

it('暂停提交群攻或自身技能的失效显式目标不能先推进AI', async () => {
    const app = switchingFixture();
    await app.setUserUnit('乙');
    const actor = app.getActionUnit();
    let runs = 0;
    app.autoAdvance = async () => { runs++; return { ok: true }; };
    actor.skills.push({ id: 'group', target: 'group', cost: 0, cooldownLeft: 0, effects: [{ type: 'damage' }] });
    actor.skills.push({ id: 'self', target: 'self', cost: 0, cooldownLeft: 0, effects: [{ type: 'shield' }] });
    const before = app.battle.toState();
    for (const skillId of ['group', 'self']) {
        const result = await app.playPlayerTurn({ skillId, targetIds: ['stale-target'] });
        assert.equal(result.ok, false);
        assert.deepEqual(app.battle.toState(), before);
    }
    assert.equal(runs, 0);
    assert.equal(app._autoDriveStop, true);
});

it('敌方不能从玩家选技入口提交', async () => {
    let called = false;
    const app = { battle: { currentUnit: {} }, isUserUnit: () => false, act() { called = true; } };
    assert.equal((await AppController.prototype.playPlayerTurn.call(app, {})).ok, false);
    assert.equal(called, false);
});
