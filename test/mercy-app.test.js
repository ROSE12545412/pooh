import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { AppController } from '../src/app.js';
import { DECIDE_MODE } from '../src/llm/decider.js';

function fixture({ teammate = false, targets = 1 } = {}) {
    const ctx = { chatId: 'mercy-chat', characterId: 1, chat: [], chatMetadata: {}, extensionSettings: {}, async saveMetadata() {} };
    const app = new AppController(ctx);
    app.settings.battle.decideMode = DECIDE_MODE.OFF;
    app.settings.battle.aiControlsAllies = false;
    app.settings.battle.decideForEnemies = false;
    const unit = { id: 'actor', name: teammate ? '同伴' : '玩家', isUser: !teammate, side: 'ally', alive: true,
        attributes: { HP: { current: 100, max: 100 }, MP: { current: 20, max: 20 } },
        skills: [{ id: 'strike', name: '终结斩', target: 'all', effects: [{ type: 'damage', power: 100 }] }] };
    const enemies = Array.from({ length: targets }, (_, i) => ({ id: `enemy-${i}`, name: `敌人${i}`, side: 'enemy', alive: true,
        attributes: { HP: { current: 1, max: 20 }, MP: { current: 0, max: 0 } }, statuses: [] }));
    const calls = { threats: [], actions: [], persisted: 0 };
    const battle = { currentUnit: unit, round: 1, phase: 'active', combatMode: 'deadly', name: '死斗', seed: 9,
        awaitingPlayerAction: false, units: [unit, ...enemies], log: [],
        lethalCandidates(action) { calls.threats.push(structuredClone(action)); return enemies; },
        act(action) { calls.actions.push(structuredClone(action)); unit.attributes.MP.current -= 3; this.round++; return { ok: true, lines: [] }; },
    };
    app.battle = battle;
    app._persistBattle = async () => { calls.persisted++; };
    // Controller behavior is isolated from scheduling; no AI or timer can open an unrelated dialog.
    app._maybeContinueAutoDrive = () => {};
    app.notify = () => {};
    return { app, ctx, battle, unit, enemies, calls };
}
const action = () => ({ action: 'skill', skillId: 'strike', targetIds: ['enemy-0'] });

function untouched(f) {
    assert.equal(f.calls.actions.length, 0);
    assert.equal(f.calls.persisted, 0);
    assert.equal(f.unit.attributes.MP.current, 20);
    assert.equal(f.battle.round, 1);
    assert.deepEqual(f.battle.log, []);
    assert.equal(f.app._autoDriveStop, true);
    assert.equal(f.battle.awaitingPlayerAction, true);
}

describe('死斗留手的控制器集成', () => {
    it('先预判再逐目标询问，继续正常结算且调用者不能预塞留手指令', async () => {
        const f = fixture();
        const prompts = [];
        f.app.askMercy = async opts => { assert.equal(f.calls.threats.length, 1); assert.equal(f.calls.actions.length, 0); prompts.push(opts); return 'continue'; };
        const result = await f.app.act({ ...action(), mercyTargetIds: ['enemy-0'], interceptTargetIds: ['enemy-0'] });
        assert.equal(result.ok, true);
        assert.equal(prompts.length, 1);
        assert.equal(prompts[0].actorName, '玩家');
        assert.equal(prompts[0].targetName, '敌人0');
        assert.equal(prompts[0].skillName, '终结斩');
        assert.equal(prompts[0].isPlayer, true);
        assert.equal('mercyTargetIds' in f.calls.threats[0], false);
        assert.equal('interceptTargetIds' in f.calls.actions[0], false);
        assert.equal('mercyTargetIds' in f.calls.actions[0], false);
        assert.equal(f.unit.attributes.MP.current, 17);
        assert.equal(f.calls.persisted, 1);
    });

    it('玩家多目标仅将选择留手的敌人传入 mercyTargetIds', async () => {
        const f = fixture({ targets: 2 });
        const prompts = [];
        f.app.askMercy = async opts => { prompts.push(opts.targetName); return prompts.length === 1 ? 'mercy' : 'continue'; };
        assert.equal((await f.app.act(action())).ok, true);
        assert.deepEqual(prompts, ['敌人0', '敌人1']);
        assert.deepEqual(f.calls.actions[0].mercyTargetIds, ['enemy-0']);
        assert.equal('interceptTargetIds' in f.calls.actions[0], false);
    });

    it('友方同伴的留手选择转换为 interceptTargetIds 而非玩家留手', async () => {
        const f = fixture({ teammate: true });
        f.app.askMercy = async opts => { assert.equal(opts.isPlayer, false); return 'mercy'; };
        assert.equal((await f.app.act(action())).ok, true);
        assert.deepEqual(f.calls.actions[0].interceptTargetIds, ['enemy-0']);
        assert.equal('mercyTargetIds' in f.calls.actions[0], false);
    });

    it('第二个目标取消时整手暂停，前一个留手选择不提前扣资源或掷骰', async () => {
        const f = fixture({ targets: 2 });
        let count = 0;
        f.app.askMercy = async () => ++count === 1 ? 'mercy' : 'cancel';
        const result = await f.app.act(action());
        assert.equal(result.ok, false);
        assert.equal(result.cancelled, true);
        untouched(f);
    });

    for (const change of ['chat', 'battle', 'abort', 'actor', 'round']) {
        it(`询问迟到后 ${change} 变化拒绝结算，不消耗资源`, async () => {
            const f = fixture();
            const controller = new AbortController();
            f.app._abort = controller;
            let release;
            f.app.askMercy = () => new Promise(resolve => { release = resolve; });
            const pending = f.app.act(action());
            assert.equal(typeof release, 'function');
            if (change === 'chat') f.ctx.chatId = 'another-chat';
            if (change === 'battle') f.app.battle = { ...f.battle, name: '另一场战斗' };
            if (change === 'abort') controller.abort();
            if (change === 'actor') f.battle.currentUnit = f.enemies[0];
            if (change === 'round') f.battle.round++;
            release('continue');
            const result = await pending;
            assert.equal(result.ok, false);
            assert.equal(result.cancelled, true);
            assert.equal(f.calls.actions.length, 0);
            assert.equal(f.calls.persisted, 0);
            assert.equal(f.unit.attributes.MP.current, 20);
            assert.equal(f.app._autoDriveStop, true);
            assert.equal(f.battle.awaitingPlayerAction, true);
        });
    }

    it('结果保留留手退出者的敌方身份及全部留手日志，不误报阵亡', () => {
        const f = fixture();
        const enemy = f.enemies[0];
        enemy.side = 'neutral';
        enemy.mercyWithdrawn = true;
        enemy.alive = true;
        f.battle.phase = 'finished';
        f.battle.winner = '我方胜利';
        f.battle.log = Array.from({ length: 30 }, (_, i) => ({ type: 'mercy', text: `留手记录-${i}-结束` }));
        const text = f.app.battleResultText({ includeBanter: false });
        assert.match(text, /敌方：敌人0（留手保命，退出至观战席）/);
        assert.doesNotMatch(text, /敌人0（阵亡）/);
        for (let i = 0; i < 30; i++) assert.ok(text.includes(`留手记录-${i}-结束`), `未保留第 ${i} 条留手记录`);
    });
});
