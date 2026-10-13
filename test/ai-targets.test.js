import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { defaultSettings } from '../src/config.js';
import { normalizePowerSystem } from '../src/core/schema.js';
import { Rng } from '../src/core/rng.js';
import { Battle, autoChooseAction } from '../src/combat/engine.js';
import { chooseFallbackTarget, legalTargetCandidates } from '../src/combat/targeting.js';
import { LlmClient } from '../src/llm/client.js';
import {
    DECIDE_JSON_SCHEMA, DECIDE_BATCH_JSON_SCHEMA, decideAction, decideActionsBatch,
    renderBattleBrief, renderBatchBrief,
} from '../src/llm/decider.js';

function makeBattle(seed = 'ai-target-tests') {
    const skills = [
        { id: 'strike', name: '斩击', target: 'single', effects: [{ type: 'damage' }] },
        { id: 'heal', name: '疗伤', target: 'single', effects: [{ type: 'heal' }] },
        { id: 'self-heal', name: '自愈', target: 'self', effects: [{ type: 'heal' }] },
        { id: 'group-strike', name: '横扫', target: 'group', effects: [{ type: 'damage' }] },
        { id: 'random-strike', name: '乱击', target: 'random', effects: [{ type: 'damage' }] },
    ].map(skill => ({ power: 20, cost: 0, aim: 100, ...skill }));
    const unit = (id, name, side) => ({
        id, name, side, skills,
        attributes: {
            HP: { current: 100, max: 100 }, MP: { current: 100, max: 100 },
            Atk: { current: 20, max: 20 }, Armor: { current: 5, max: 5 },
            Speed: { current: 10, max: 10 }, Evasion: { current: 10, max: 10 },
        },
    });
    const battle = new Battle(normalizePowerSystem({ combatants: [
        unit('ally-a', '前排队友', 'ally'), unit('ally-b', '后排队友', 'ally'), unit('ally-c', '侧翼队友', 'ally'),
        unit('enemy-a', '敌方甲', 'enemy'), unit('enemy-b', '敌方乙', 'enemy'),
    ] }), { seed });
    battle.start();
    const allies = battle.units.filter(unit => unit.side === 'ally');
    const enemies = battle.units.filter(unit => unit.side === 'enemy');
    battle.turnIndex = battle.initiative.findIndex(entry => entry.unitId === enemies[0].id);
    return { battle, allies, enemies, actor: enemies[0] };
}

function settings(mode = 'auto') {
    const value = defaultSettings();
    value.battle.decideMode = mode;
    return value;
}

/** Mock the real public client API; restore automatically after each behavior test. */
function model(t, response) {
    const calls = [];
    t.mock.method(LlmClient.prototype, 'complete', async request => {
        calls.push(request);
        return { ok: true, text: typeof response === 'string' ? response : JSON.stringify(response), meta: {} };
    });
    return calls;
}

function rawAction(target, extra = {}) {
    return { action: 'attack', skillId: '', targetName: target?.name ?? '', flavor: '举刃上前。', ...extra };
}

function makeTacticalTarget(allies) {
    allies[2].attributes.HP.current = 20;
    allies[2].attributes.Atk.current = 80;
}

describe('AI 单位决策：模型决定合法目标，本地只验证', () => {
    for (const targetIndex of [0, 1, 2]) {
        it(`保留模型指定第 ${targetIndex + 1} 名合法目标且不会消耗 RNG`, async t => {
            const { battle, allies } = makeBattle();
            // 即使另一目标战术评分更高，也不能覆盖有效模型目标。
            makeTacticalTarget(allies);
            const raw = targetIndex === 2
                ? rawAction(null, { targetId: allies[2].id }) : rawAction(allies[targetIndex]);
            const calls = model(t, raw);
            const before = battle.rng.snapshot();
            for (let repeat = 0; repeat < 3; repeat++) {
                const result = await decideAction(null, settings(), battle);
                assert.equal(result.ok, true);
                assert.equal(result.decision.targetId, allies[targetIndex].id);
                assert.equal(result.decision.targetName, allies[targetIndex].name);
                assert.equal(result.decision.action, 'attack');
            }
            assert.deepEqual(battle.rng.snapshot(), before, '合理集火不应被轮换或重新抽签');
            assert.equal(calls.length, 3);
            assert.equal(calls[0].jsonSchema, DECIDE_JSON_SCHEMA);
            for (const target of allies) assert.ok(calls[0].user.includes(`[id=${target.id}]`));
        });
    }

    it('目标重名时优先使用稳定 targetId', async t => {
        const { battle, allies } = makeBattle();
        allies[0].name = allies[1].name = '同名角色';
        model(t, rawAction(allies[0], { targetId: allies[1].id }));
        const result = await decideAction(null, settings(), battle);
        assert.equal(result.decision.targetId, allies[1].id);
    });

    for (const invalid of ['missing', 'unknown', 'dead', 'friendly']) {
        it(`普通攻击 ${invalid} 目标从所有合法候选中选择战术目标`, async t => {
            const { battle, allies, enemies } = makeBattle();
            makeTacticalTarget(allies);
            if (invalid === 'dead') allies[0].alive = false;
            const target = invalid === 'friendly' ? enemies[1] : invalid === 'dead' ? allies[0]
                : invalid === 'unknown' ? { name: '不存在的目标', id: 'missing' } : null;
            model(t, rawAction(target, { targetId: target?.id ?? '' }));
            const result = await decideAction(null, settings(), battle);
            assert.equal(result.decision.targetId, allies[2].id);
            assert.equal(result.decision.targetName, allies[2].name);
            assert.ok(legalTargetCandidates(battle, battle.currentUnit).includes(allies[2]));
        });
    }

    it('技能不存在时先改为普通攻击，再按普攻目标规则校验', async t => {
        const { battle, allies, actor } = makeBattle();
        makeTacticalTarget(allies);
        model(t, rawAction(actor, { action: 'skill', skillId: '不存在的技能' }));
        const result = await decideAction(null, settings(), battle);
        assert.equal(result.decision.action, 'attack');
        assert.equal(result.decision.skillId, '');
        assert.equal(result.decision.targetId, allies[2].id);
    });

    for (const useSelf of [false, true]) {
        it(`治疗保留模型指定${useSelf ? '自身' : '队友'}的合法目标`, async t => {
            const { battle, enemies, actor } = makeBattle();
            enemies[1].attributes.HP.current = 10;
            const target = useSelf ? actor : enemies[1];
            model(t, rawAction(target, { action: 'skill', skillId: 'heal' }));
            const before = battle.rng.snapshot();
            const result = await decideAction(null, settings(), battle);
            assert.equal(result.decision.targetId, target.id);
            assert.equal(result.decision.skillId, 'heal');
            assert.deepEqual(battle.rng.snapshot(), before);
        });
    }

    it('治疗不能指定敌对阵营，自身技能只能指定自己', async t => {
        const { battle, allies, enemies, actor } = makeBattle();
        enemies[1].attributes.HP.current = 10;
        const response = rawAction(allies[2], { action: 'skill', skillId: 'heal' });
        model(t, response);
        const healed = await decideAction(null, settings(), battle);
        assert.equal(healed.decision.targetId, enemies[1].id);
        response.skillId = 'self-heal';
        const before = battle.rng.snapshot();
        const self = await decideAction(null, settings(), battle);
        assert.equal(self.decision.targetId, actor.id);
        assert.deepEqual(battle.rng.snapshot(), before, '唯一合法目标不掷骰');
    });

    for (const skillId of ['group-strike', 'random-strike']) {
        it(`${skillId} 留给引擎选择覆盖/随机目标，决策阶段不抽签`, async t => {
            const { battle, allies } = makeBattle();
            model(t, rawAction(allies[1], { action: 'skill', skillId }));
            const before = battle.rng.snapshot();
            const result = await decideAction(null, settings(), battle);
            assert.equal(result.decision.skillId, skillId);
            assert.equal(result.decision.targetId, '');
            assert.equal(result.decision.targetName, '');
            assert.deepEqual(battle.rng.snapshot(), before);
        });
    }

    it('只写描述时，玩家选定的普通攻击和第二目标不会被模型技能替换', async t => {
        const { battle, allies } = makeBattle();
        const calls = model(t, rawAction(allies[2], { action: 'skill', skillId: 'strike' }));
        const result = await decideAction(null, settings('flavor'), battle, {
            preselect: { action: 'attack', skillId: '', targetName: allies[1].name },
        });
        assert.equal(result.decision.skillId, '');
        assert.equal(result.decision.action, 'attack');
        assert.equal(result.decision.targetId, allies[1].id);
        assert.ok(calls[0].user.includes('玩家选定：action=attack'));
    });

    it('防御/跳过不选目标、不抽签', async t => {
        const { battle, allies } = makeBattle();
        const response = rawAction(allies[1], { action: 'defend' });
        model(t, response);
        const before = battle.rng.snapshot();
        for (const action of ['defend', 'skip']) {
            response.action = action;
            const result = await decideAction(null, settings(), battle);
            assert.equal(result.decision.action, action);
            assert.equal(result.decision.targetId, '');
        }
        assert.deepEqual(battle.rng.snapshot(), before);
    });

    it('结构噪声之外的平衡 JSON 中仍能找到有效单单位选择', async t => {
        const { battle, allies } = makeBattle();
        model(t, '参考资料：{"a":1,"b":2,"c":3,"d":4,"e":5,"f":6,"g":7}\n行动：' +
            JSON.stringify(rawAction(allies[2])));
        const result = await decideAction(null, settings(), battle);
        assert.equal(result.decision.targetId, allies[2].id);
    });
});

describe('AI 批量决策实际 complete 路径', () => {
    it('按稳定 actor id / 兼容名字映射，分别保留第二和第三目标', async t => {
        const { battle, allies, enemies } = makeBattle();
        const calls = model(t, { actions: [
            { ...rawAction(allies[1]), unitId: enemies[0].id, unitName: '旧的名字' },
            { ...rawAction(null, { targetId: allies[2].id }), unitName: enemies[1].name },
        ] });
        const before = battle.rng.snapshot();
        const result = await decideActionsBatch(null, settings(), battle, enemies);
        assert.equal(result.ok, true);
        assert.equal(result.decisions[enemies[0].id].targetId, allies[1].id);
        assert.equal(result.decisions[enemies[1].id].targetId, allies[2].id);
        assert.deepEqual(battle.rng.snapshot(), before);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].jsonSchema, DECIDE_BATCH_JSON_SCHEMA);
    });

    it('有意集火同一个非首位目标，不强制轮换', async t => {
        const { battle, allies, enemies } = makeBattle();
        model(t, { actions: enemies.map(unit => ({ ...rawAction(allies[2]), unitName: unit.name })) });
        const result = await decideActionsBatch(null, settings(), battle, enemies);
        for (const unit of enemies) assert.equal(result.decisions[unit.id].targetId, allies[2].id);
    });

    it('缺失与错误阵营目标均显式兜底到合法的第三目标', async t => {
        const { battle, allies, enemies } = makeBattle();
        makeTacticalTarget(allies);
        model(t, { actions: [
            { ...rawAction(null), unitName: enemies[0].name },
            { ...rawAction(enemies[0]), unitName: enemies[1].name },
        ] });
        const result = await decideActionsBatch(null, settings(), battle, enemies);
        for (const unit of enemies) assert.equal(result.decisions[unit.id].targetId, allies[2].id);
    });

    it('平衡提取按 string[] API 处理，能找回被大噪声对象遮住的完整批量结果', async t => {
        const { battle, allies, enemies } = makeBattle();
        const payload = { actions: enemies.map((unit, i) => ({
            ...rawAction(allies[i + 1]), unitId: unit.id,
        })) };
        model(t, '说明：{"a":1,"b":2,"c":3,"d":4,"e":5,"f":6,"g":7,"h":8}\n```json\n' +
            JSON.stringify(payload) + '\n```');
        const result = await decideActionsBatch(null, settings(), battle, enemies);
        assert.equal(Object.keys(result.decisions).length, 2);
        assert.equal(result.decisions[enemies[0].id].targetId, allies[1].id);
        assert.equal(result.decisions[enemies[1].id].targetId, allies[2].id);
    });

    it('模型同时返回重名行动者时可按不同 unitId 正确匹配', async t => {
        const { battle, allies, enemies } = makeBattle();
        enemies[0].name = enemies[1].name = '同名对手';
        model(t, { actions: enemies.map((unit, i) => ({
            ...rawAction(allies[i + 1]), unitId: unit.id, unitName: unit.name,
        })) });
        const result = await decideActionsBatch(null, settings(), battle, enemies);
        assert.equal(result.decisions[enemies[0].id].targetId, allies[1].id);
        assert.equal(result.decisions[enemies[1].id].targetId, allies[2].id);
    });

    it('仅一个待决策单位时提示词和目标验证使用指定单位，而非当前行动者', async t => {
        const { battle, allies, enemies } = makeBattle();
        battle.turnIndex = battle.initiative.findIndex(entry => entry.unitId === allies[0].id);
        const calls = model(t, rawAction(allies[2]));
        const result = await decideActionsBatch(null, settings('flavor'), battle, [enemies[1]]);
        assert.equal(result.decisions[enemies[1].id].targetId, allies[2].id);
        assert.ok(calls[0].user.includes(`当前行动者：${enemies[1].name} [id=${enemies[1].id}]`));
        assert.ok(calls[0].system.includes('用哪个技能** 与 **打谁'));
        assert.equal(battle.currentUnit.id, allies[0].id);
    });
});

describe('纯引擎自动行动不锁定首位', () => {
    for (const attackKind of ['basic', 'single']) {
        it(`${attackKind} 同分目标覆盖所有位置、反转名单可重放`, () => {
            const picks = new Set();
            for (let seed = 0; seed < 32; seed++) {
                const { battle, actor } = makeBattle(seed);
                actor.skills = attackKind === 'basic' ? [] : actor.skills.filter(skill => skill.id === 'strike');
                const replay = Battle.fromState(battle.toState());
                replay.units.reverse();
                const chosen = autoChooseAction(battle);
                const replayed = autoChooseAction(replay);
                assert.deepEqual(chosen, replayed);
                assert.equal(chosen.targetIds.length, 1);
                picks.add(chosen.targetIds[0]);
                const result = battle.act(chosen);
                assert.equal(result.ok, true);
                assert.equal(battle.log.find(entry => entry.data?.hit)?.data.targetId, chosen.targetIds[0]);
            }
            assert.deepEqual([...picks].sort(), ['ally-a', 'ally-b', 'ally-c']);
        });
    }

    it('直接省略单体目标的引擎行动仍选择最优目标而非数组首位', () => {
        const { battle, allies, actor } = makeBattle();
        makeTacticalTarget(allies);
        assert.equal(battle.act({ unitId: actor.id, action: 'attack' }).ok, true);
        assert.equal(battle.log.find(entry => entry.data?.hit)?.data.targetId, allies[2].id);
    });

    it('本地 random/group/all 行动不提前抽签或塞入虚假单体目标', () => {
        for (const target of ['random', 'group', 'all']) {
            const { battle, actor } = makeBattle();
            actor.skills = [{ ...actor.skills.find(skill => skill.id === 'strike'), target }];
            const before = battle.rng.snapshot();
            const choice = autoChooseAction(battle);
            assert.equal(choice.skillId, 'strike');
            assert.equal(choice.targetIds, undefined);
            assert.deepEqual(battle.rng.snapshot(), before);
        }
    });

    it('本地治疗/护盾优先合法受伤队友，并遵守自身技能目标', () => {
        const { battle, enemies, actor } = makeBattle();
        actor.attributes.HP.current = 30;
        enemies[1].attributes.HP.current = 5;
        actor.skills = actor.skills.filter(skill => skill.id === 'heal');
        assert.deepEqual(autoChooseAction(battle).targetIds, [enemies[1].id]);
        actor.skills[0].effects = [{ type: 'shield' }];
        assert.deepEqual(autoChooseAction(battle).targetIds, [enemies[1].id]);
        actor.skills[0].target = 'self';
        assert.deepEqual(autoChooseAction(battle).targetIds, [actor.id]);
    });
});

describe('AI 本地目标兜底与只读候选', () => {
    it('单体技能与普通攻击的完整候选包含第二、第三单位', () => {
        const { battle, allies, actor } = makeBattle();
        assert.deepEqual(legalTargetCandidates(battle, actor).map(unit => unit.id), allies.map(unit => unit.id));
        const strike = actor.skills.find(skill => skill.id === 'strike');
        assert.deepEqual(legalTargetCandidates(battle, actor, strike).map(unit => unit.id), allies.map(unit => unit.id));
    });

    it('提示词给出全部合法候选及稳定 id，生成预览不消耗 RNG', () => {
        const { battle, allies, enemies, actor } = makeBattle();
        const before = battle.rng.snapshot();
        for (const brief of [renderBattleBrief(battle), renderBatchBrief(battle, enemies)]) {
            const attackLines = brief.split('\n').filter(line => line.includes('普通攻击（action=attack'));
            assert.ok(attackLines.length);
            for (const line of attackLines) {
                for (const target of allies) assert.ok(line.includes(`${target.name} [id=${target.id}]`));
                assert.ok(!line.includes(actor.name));
            }
        }
        assert.deepEqual(battle.rng.snapshot(), before);
    });

    it('同分由可重放 RNG 决定，能选到全部位置且不依赖数组顺序', () => {
        const picks = new Set();
        for (let seed = 0; seed < 32; seed++) {
            const { battle, actor } = makeBattle(seed);
            const other = Battle.fromState(battle.toState());
            other.units.reverse();
            const chosen = chooseFallbackTarget(battle, actor);
            const replayed = chooseFallbackTarget(other, other.units.find(unit => unit.id === actor.id));
            assert.equal(chosen.id, replayed.id);
            picks.add(chosen.id);
        }
        assert.deepEqual([...picks].sort(), ['ally-a', 'ally-b', 'ally-c']);
    });

    it('威胁和受伤程度决定战术排序，不取第一个单位', () => {
        const { battle, allies, actor } = makeBattle();
        allies[1].attributes.Atk.current = 200;
        const before = battle.rng.snapshot();
        assert.equal(chooseFallbackTarget(battle, actor).id, allies[1].id);
        allies[2].attributes.HP.current = 10;
        assert.equal(chooseFallbackTarget(battle, actor).id, allies[2].id);
        assert.deepEqual(battle.rng.snapshot(), before, '唯一最佳目标不需要抽签');
    });

    it('受伤队友/自己均可治疗，自疗只有自身一个候选', () => {
        const { battle, actor, enemies } = makeBattle();
        const heal = actor.skills.find(skill => skill.id === 'heal');
        enemies[1].attributes.HP.current = 10;
        assert.equal(chooseFallbackTarget(battle, actor, heal).id, enemies[1].id);
        actor.attributes.HP.current = 1;
        assert.equal(chooseFallbackTarget(battle, actor, heal).id, actor.id);
        const self = actor.skills.find(skill => skill.id === 'self-heal');
        assert.equal(chooseFallbackTarget(battle, actor, self).id, actor.id);
    });

    it('遵守引擎收窄的候选（如嘲讽合法性），唯一候选不抽签', async t => {
        const { battle, actor, allies } = makeBattle();
        t.mock.method(battle, 'targetCandidates', () => [allies[1]]);
        model(t, rawAction(allies[2]));
        const before = battle.rng.snapshot();
        assert.equal(chooseFallbackTarget(battle, actor).id, allies[1].id);
        const result = await decideAction(null, settings(), battle);
        assert.equal(result.decision.targetId, allies[1].id);
        assert.deepEqual(battle.rng.snapshot(), before);
    });

    it('没有候选/群攻/随机目标都不抽签并返回 null', () => {
        const { battle, actor, allies } = makeBattle();
        const before = battle.rng.snapshot();
        for (const target of ['group', 'all', 'random']) {
            assert.equal(chooseFallbackTarget(battle, actor, { target, effects: [{ type: 'damage' }] }), null);
        }
        for (const ally of allies) ally.alive = false;
        assert.equal(chooseFallbackTarget(battle, actor), null);
        assert.deepEqual(battle.rng.snapshot(), before);
    });

    it('同分兜底只消费一次战斗 RNG，可从快照重放', () => {
        const { battle, actor } = makeBattle();
        const before = battle.rng.snapshot();
        const chosen = chooseFallbackTarget(battle, actor);
        assert.equal(battle.rng.calls, before.calls + 1);
        battle.rng = Rng.fromSnapshot(before);
        assert.equal(chooseFallbackTarget(battle, actor).id, chosen.id);
    });
});
