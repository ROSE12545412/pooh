/**
 * 通用技能机制契约。运行：node test/skill-mechanics.test.js
 *
 * single 可显式选一个合法目标；group/all 覆盖完整候选，不受 targetIds 缩窄。
 * 直接伤害与所有负面状态共享每目标的一次命中判定。群攻只缩小最终直接/DoT 伤害。
 * 控制/DoT 每个受影响回合开始各独立掷 d20 + hitBonus vs saveDc（缺省10）：
 * 天然1失败、20通过；控制失败跳过整个行动，DoT失败扣 power * stacks，通过则无损。
 * duration 包含完整的受影响回合，在行动/跳过后扣减；本行动新挂/刷新的状态下回合才扣。
 * 任何保存/展示/候选预览都不能再掷骰，快照包含已完成开始判定的回合与状态版本。
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { Rng } from '../src/core/rng.js';
import { GENERIC_D20 } from '../src/core/ruleset.js';
import { normalizeCombatant, normalizeSkill } from '../src/core/schema.js';
import {
    Battle, PHASE, OUTCOME, attr, autoChooseAction, canUseSkill, controlledBy,
    effectiveStats, expireStatuses, rollStatusSave, tickStatuses,
} from '../src/combat/engine.js';

/** 每项是实际的 d20 面值；任何多掷骰都会失败。 */
class SequenceRng extends Rng {
    constructor(...rolls) {
        super(1);
        this.rolls = rolls;
    }
    next() {
        assert.ok(this.rolls.length, '只允许真实判定消费随机数');
        this.calls++;
        return (this.rolls.shift() - 0.5) / 20;
    }
}

const RULES = {
    ...GENERIC_D20, initiativeFormula: 'Speed', damageFormula: 'power',
    critFormula: '0', fumbleFormula: '0', fumbleSelfHarmRatio: 0,
};

function unit(id, side, speed, overrides = {}) {
    const { attributes = {}, ...rest } = overrides;
    return normalizeCombatant({
        id, name: id, side, attributeBasis: 'base', skills: [], statuses: [], equipment: [],
        attributes: {
            HP: { current: 1000, max: 1000 }, MP: { current: 100, max: 100 },
            Atk: 20, Armor: 0, Evasion: 10, Speed: speed, ...attributes,
        },
        ...rest,
    });
}

function skill(effects = [{ type: 'damage', power: 100 }], overrides = {}) {
    return normalizeSkill({ id: 'move', name: '任意世界的技能', power: 100, aim: 100, target: 'single', effects, ...overrides });
}

function battle({ move = skill(), actor = {}, enemies, enemyCount = 2, friends = [], rules = {}, rng, seed = 'skills', combatMode = 'deadly', start = true } = {}) {
    const enemyUnits = enemies ?? Array.from({ length: enemyCount }, (_, index) => unit(`enemy${index + 1}`, 'enemy', 20 - index));
    const value = new Battle({ combatants: [unit('actor', 'ally', 100, { skills: [move], ...actor }), ...friends, ...enemyUnits] }, {
        seed, ruleset: { ...RULES, ...rules }, combatMode,
    });
    if (rng) value.rng = rng;
    if (start) assert.equal(value.start().ok, true);
    return value;
}

const named = (value, id) => value.units.find((entry) => entry.id === id);
const checks = (value, kind) => value.log.filter((entry) => entry.data?.check?.checkKind === kind).map((entry) => entry.data);
const attacks = (value) => value.log.filter((entry) => entry.data?.hit);
const cleanLog = (value) => value.log.map(({ at, ...entry }) => entry);

function status(type, overrides = {}) {
    return { id: `s-${type}`, name: `任意${type}名称`, type, power: 0, duration: 1, stacks: 1, ...overrides };
}

function seedWithFirstRoll(expected) {
    for (let seed = 1; seed < 10000; seed++) {
        if (new Rng(seed).d20() === expected) return seed;
    }
    assert.fail(`找不到面值 ${expected} 的种子`);
}

describe('单体候选、显式选择与无副作用校验', () => {
    it('单体可选第二个敌人，普通攻击共用同一路径', () => {
        for (const basic of [false, true]) {
            const value = battle({ rng: new SequenceRng(12) });
            const actor = named(value, 'actor');
            const before = value.rng.snapshot();
            assert.deepEqual(value.targetCandidates(actor, actor.skills[0]).map((entry) => entry.id), ['enemy1', 'enemy2']);
            assert.deepEqual(value.rng.snapshot(), before);
            assert.deepEqual(value.resolveTargets(actor, actor.skills[0]).map((entry) => entry.id), ['enemy1']);
            const result = value.act({ ...(basic ? {} : { skillId: 'move' }), targetIds: ['enemy2'] });
            assert.equal(result.ok, true);
            assert.equal(attr(named(value, 'enemy1'), 'HP'), 1000);
            assert.equal(attr(named(value, 'enemy2'), 'HP'), basic ? 980 : 900);
            assert.equal(attacks(value)[0].data.hit.targetId, 'enemy2');
            assert.equal(value.rng.calls, 1);
        }
    });

    it('不存在、友方、死亡、空选、多选在MP/冷却/RNG/回合/日志变化前拒绝', () => {
        const value = battle({ move: skill(undefined, { cost: 15, cooldown: 3 }), rng: new SequenceRng(), friends: [unit('friend', 'ally', 1)] });
        named(value, 'enemy2').alive = false;
        for (const targetIds of [['missing'], ['friend'], ['actor'], ['enemy2'], [], ['enemy1', 'enemy1'], 'enemy1']) {
            for (const basic of [false, true]) {
                const before = value.toState();
                const result = value.act({ ...(basic ? {} : { skillId: 'move' }), targetIds });
                assert.equal(result.ok, false, JSON.stringify(targetIds));
                assert.match(result.error, /目标/);
                assert.deepEqual(value.toState(), before, '错误目标不能付出任何代价或偷换成首个敌人');
            }
        }
    });

    it('纯控制、DoT、减益、嘲讽面向敌人；治疗候选含自身，预览随机目标不掷骰', () => {
        const value = battle({ rng: new SequenceRng(20), friends: [unit('friend', 'ally', 1)] });
        const actor = named(value, 'actor');
        for (const type of ['control', 'dot', 'debuff', 'taunt']) {
            assert.deepEqual(value.targetCandidates(actor, skill([{ type }])).map((entry) => entry.id), ['enemy1', 'enemy2']);
        }
        assert.deepEqual(value.targetCandidates(actor, skill([{ type: 'heal' }])).map((entry) => entry.id), ['actor', 'friend']);
        const random = skill([{ type: 'control' }], { target: 'random' });
        for (let i = 0; i < 5; i++) assert.equal(value.targetCandidates(actor, random).length, 2);
        assert.equal(value.rng.calls, 0);
        assert.equal(value.resolveTargets(actor, random)[0].id, 'enemy2');
        assert.equal(value.rng.calls, 1);
    });

    it('本地自动行动从完整候选选最弱目标且决策不消费RNG', () => {
        const value = battle({ rng: new SequenceRng() });
        named(value, 'enemy2').attributes.HP.current = 30;
        assert.deepEqual(autoChooseAction(value).targetIds, ['enemy2']);
        assert.equal(value.rng.calls, 0);
    });
});

describe('群体覆盖和真正伤害的衰减', () => {
    it('group 即便提交一个目标，也打中所有敌人并按完整数量衰减', () => {
        const value = battle({ move: skill(undefined, { target: 'group' }), rng: new SequenceRng(12, 12) });
        assert.equal(value.act({ skillId: 'move', targetIds: ['enemy2'] }).ok, true);
        assert.deepEqual(['enemy1', 'enemy2'].map((id) => attr(named(value, id), 'HP')), [929, 929]);
        const entries = value.log.filter((entry) => entry.data?.aoeFalloff);
        assert.equal(entries.length, 2);
        for (const entry of entries) {
            assert.deepEqual(entry.data.aoeFalloff, {
                from: 100, to: 71, factor: 1 / Math.sqrt(2), targets: 2,
                effectType: 'damage', targetId: entry.data.aoeFalloff.targetId,
            });
        }
        assert.equal(value.rng.calls, 2);
    });

    it('all 保留全场范围，显式目标不会缩小范围', () => {
        const value = battle({ move: skill(undefined, { target: 'all' }), rng: new SequenceRng(12, 12, 12) });
        assert.equal(value.act({ skillId: 'move', targetIds: ['enemy2'] }).ok, true);
        assert.deepEqual(value.units.map((entry) => attr(entry, 'HP')), [942, 942, 942]);
        assert.equal(attacks(value).length, 3);
    });

    it('比例先还原，再将含护甲公式的直接伤害和DoT各衰减一次，不衰减DC/负修正', () => {
        const move = skill([
            { type: 'damage', power: 0 },
            { type: 'control', power: 0, saveDc: 18, duration: 1, modifiers: [] },
            { type: 'dot', power: 1, saveDc: 14, duration: 2 },
            { type: 'debuff', power: 0, duration: 1, description: '命中降低', modifiers: [{ attr: 'hit', delta: -4 }] },
        ], { target: 'group', power: 1 });
        const value = battle({
            move, actor: { attributes: { Atk: 1000 } },
            enemies: Array.from({ length: 4 }, (_, index) => unit(`enemy${index + 1}`, 'enemy', 20 - index, { attributes: { Armor: 30 } })),
            rules: { powerMode: 'ratio-atk', damageFormula: 'power + 100 - Armor' }, rng: new SequenceRng(12, 12, 12, 12),
        });
        const actor = named(value, 'actor');
        value._resolveSkill(actor, actor.skills[0], ['enemy4']);
        for (const enemy of value.units.filter((entry) => entry.side === 'enemy')) {
            assert.equal(attr(enemy, 'HP'), 960); // (1% * 1000 + 100 - 30) * 0.5
            assert.equal(enemy.statuses.find((entry) => entry.type === 'dot').power, 5);
            assert.equal(enemy.statuses.find((entry) => entry.type === 'control').saveDc, 18);
            assert.equal(enemy.statuses.find((entry) => entry.type === 'control').power, 0);
            assert.equal(enemy.statuses.find((entry) => entry.type === 'debuff').power, 0);
            assert.equal(effectiveStats(enemy).hit, -4);
        }
        const falloffs = value.log.filter((entry) => entry.data?.aoeFalloff).map((entry) => entry.data.aoeFalloff);
        assert.equal(falloffs.length, 8);
        assert.equal(falloffs.filter((entry) => entry.effectType === 'damage' && entry.from === 80 && entry.to === 40).length, 4);
        assert.equal(falloffs.filter((entry) => entry.effectType === 'dot' && entry.from === 10 && entry.to === 5).length, 4);
        assert.equal(value.rng.calls, 4);
    });

    it('线性/不开衰减/默认下限仍受规则控制，零DoT保持零', () => {
        for (const [rules, expected] of [
            [{ aoeFalloff: 'linear' }, 35],
            [{ aoeFalloff: 'linear', aoeFalloffFloor: 0 }, 25],
            [{ aoeFalloff: 'none' }, 100],
        ]) {
            const value = battle({
                move: skill([{ type: 'damage', power: 100 }, { type: 'dot', power: 0, duration: 1 }], { target: 'group' }),
                enemyCount: 4, rules, rng: new SequenceRng(12, 12, 12, 12),
            });
            value._resolveSkill(named(value, 'actor'), named(value, 'actor').skills[0]);
            for (const enemy of value.units.filter((entry) => entry.side === 'enemy')) {
                assert.equal(attr(enemy, 'HP'), 1000 - expected);
                assert.equal(enemy.statuses.find((entry) => entry.type === 'dot').power, 0);
            }
        }
    });
});

describe('负面状态必须先命中且共享一次命中骰', () => {
    it('纯负面技能命中前不应用；未命中不挂状态', () => {
        for (const type of ['control', 'dot', 'debuff', 'taunt']) {
            const value = battle({ move: skill([{ type, power: 0, duration: 1, modifiers: [] }]), rng: new SequenceRng(3) });
            assert.equal(value.act({ skillId: 'move', targetIds: ['enemy2'] }).ok, true);
            assert.equal(named(value, 'enemy2').statuses.length, 0);
            assert.equal(attacks(value).length, 1);
            assert.equal(attacks(value)[0].data.hit.outcome, OUTCOME.MISS);
            assert.equal(value.rng.calls, 1);
        }
    });

    it('混合伤害+控制+DoT+减益共用一次命中，成功全部保留、失败全部不挂', () => {
        for (const nat of [3, 12]) {
            const value = battle({ move: skill([
                { type: 'damage', power: 100 }, { type: 'control', duration: 1, modifiers: [] },
                { type: 'dot', power: 7, duration: 1 }, { type: 'debuff', power: 0, duration: 1, modifiers: [{ attr: 'hit', delta: -3 }] },
            ]), rng: new SequenceRng(nat) });
            value.act({ skillId: 'move', targetIds: ['enemy2'] });
            const target = named(value, 'enemy2');
            assert.equal(attr(target, 'HP'), nat === 12 ? 900 : 1000);
            assert.deepEqual(target.statuses.map((entry) => entry.type), nat === 12 ? ['control', 'dot', 'debuff'] : []);
            assert.equal(value.rng.calls, 1);
            assert.equal(attacks(value).length, 1);
        }
    });
});

describe('控制、DoT、骰点减益与完整受影响回合', () => {
    it('任意命名control持续1回合也会掷失败并跳过行动，随后过期', () => {
        const value = battle({ move: skill([{ type: 'control', duration: 1, saveDc: 15, modifiers: [] }]), rng: new SequenceRng(12, 4) });
        value.act({ skillId: 'move', targetIds: ['enemy1'] });
        assert.equal(value.currentUnit.id, 'enemy2');
        assert.equal(named(value, 'enemy1').statuses.length, 0);
        const event = checks(value, 'control')[0];
        assert.equal(event.success, false);
        assert.equal(event.skipped, true);
        assert.deepEqual([event.check.actorName, event.check.skillName, event.check.nat, event.check.total, event.check.target], ['enemy1', '任意世界的技能', 4, 4, 15]);
        assert.equal(event.check.formula, 'd20 + hitBonus');
        assert.equal(event.check.saveDc, 15);
        assert.equal(event.check.override, null);
        assert.match(event.text, /判定失败.*跳过整个行动/);
        assert.equal(value.rng.calls, 2);
    });

    it('控制判定通过后该回合能真正出手，持续1状态在出手后才过期', () => {
        const value = battle({ move: skill([{ type: 'control', duration: 1, saveDc: 15, modifiers: [] }]), rng: new SequenceRng(12, 17, 12) });
        value.act({ skillId: 'move', targetIds: ['enemy1'] });
        const target = named(value, 'enemy1');
        assert.equal(value.currentUnit.id, 'enemy1');
        assert.equal(target.statuses[0].duration, 1);
        assert.equal(controlledBy(target), '');
        assert.equal(canUseSkill(target, skill()).usable, true);
        assert.equal(checks(value, 'control')[0].success, true);
        assert.equal(value.act({ targetIds: ['actor'] }).ok, true);
        assert.equal(attr(named(value, 'actor'), 'HP'), 980);
        assert.equal(target.statuses.length, 0);
        assert.equal(value.rng.calls, 3);
    });

    it('多回合控制每回合重判，通过不会永久免疫后续失败', () => {
        const value = battle({ move: skill([{ type: 'control', duration: 2, modifiers: [] }]), rng: new SequenceRng(12, 17, 3) });
        value.act({ skillId: 'move', targetIds: ['enemy1'] });
        value.act({ action: 'skip' }); // enemy1 的第一次通过回合
        assert.equal(named(value, 'enemy1').statuses[0].duration, 1);
        value.act({ action: 'skip' }); // enemy2
        value.act({ action: 'skip' }); // actor，enemy1 的第二次判定失败
        assert.equal(value.currentUnit.id, 'enemy2');
        assert.deepEqual(checks(value, 'control').map((event) => event.success), [true, false]);
        assert.equal(named(value, 'enemy1').statuses.length, 0);
        assert.equal(value.rng.calls, 3);
    });

    it('DoT命中后每次开始额外掷骰，失败扣伤害、通过也显示0损失', () => {
        const value = battle({ move: skill([{ type: 'dot', power: 7, duration: 2, saveDc: 10 }]), rng: new SequenceRng(12, 4, 17) });
        value.act({ skillId: 'move', targetIds: ['enemy1'] });
        const target = named(value, 'enemy1');
        assert.equal(attr(target, 'HP'), 993);
        assert.equal(target.statuses[0].duration, 2);
        assert.equal(checks(value, 'dot')[0].value, 7);
        value.act({ action: 'skip' });
        assert.equal(target.statuses[0].duration, 1);
        value.act({ action: 'skip' });
        value.act({ action: 'skip' });
        assert.equal(attr(target, 'HP'), 993);
        assert.equal(checks(value, 'dot')[1].success, true);
        assert.equal(checks(value, 'dot')[1].value, 0);
        assert.match(checks(value, 'dot')[1].text, /17.*判定通过.*0 点生命/);
        value.act({ action: 'skip' });
        assert.equal(target.statuses.length, 0);
        assert.equal(value.rng.calls, 3);
    });

    it('每个控制与DoT各用自己的真实骰，失败DoT使用power×stacks', () => {
        const value = battle({
            actor: { statuses: [status('control', { modifiers: [] }), status('dot', { power: 7, stacks: 2 })] },
            rng: new SequenceRng(17, 4),
        });
        assert.equal(attr(named(value, 'actor'), 'HP'), 986);
        assert.equal(value.currentUnit.id, 'actor');
        assert.equal(checks(value, 'control')[0].check.nat, 17);
        assert.equal(checks(value, 'dot')[0].check.nat, 4);
        assert.equal(value.rng.calls, 2);
    });

    it('天然1必败、20必过，显式负hit也进入抵抗最终总值', () => {
        const actor = unit('actor', 'ally', 100, { statuses: [status('debuff', { modifiers: [{ attr: 'hit', delta: -4 }] })] });
        const check = rollStatusSave(new SequenceRng(12), actor, status('dot'), 'dot');
        assert.equal(check.total, 8);
        assert.equal(check.target, 10);
        assert.equal(check.success, false);
        assert.deepEqual(check.modifiers.map((part) => part.value), [-4]);
        assert.equal(check.nat + check.modifiers.reduce((sum, part) => sum + part.value, 0), check.total);
        actor.statuses[0].modifiers[0].delta = 100;
        const failure = rollStatusSave(new SequenceRng(1), actor, status('control', { saveDc: 2 }), 'control');
        assert.equal(failure.success, false);
        assert.equal(failure.override, OUTCOME.FUMBLE);
        actor.statuses[0].modifiers[0].delta = -100;
        const success = rollStatusSave(new SequenceRng(20), actor, status('control', { saveDc: 30 }), 'control');
        assert.equal(success.success, true);
        assert.equal(success.override, OUTCOME.CRIT);
    });

    it('duration1骰点减益先显示负号，留到主命中total才在行动后移除', () => {
        const value = battle({
            move: skill([{ type: 'debuff', power: 0, duration: 1, description: '扭曲骰点', modifiers: [{ attr: 'hit', delta: -4 }] }]),
            rng: new SequenceRng(12, 12),
        });
        value.act({ skillId: 'move', targetIds: ['enemy1'] });
        const target = named(value, 'enemy1');
        assert.equal(effectiveStats(target).hit, -4);
        const previewIndex = value.log.findIndex((entry) => entry.data?.type === 'modifier');
        assert.ok(previewIndex >= 0);
        assert.match(value.log[previewIndex].text, /掷骰前.*-4/);
        value.act({ targetIds: ['actor'] });
        const attackIndex = value.log.findIndex((entry) => entry.data?.hit?.actorId === 'enemy1');
        assert.ok(previewIndex < attackIndex);
        assert.equal(value.log[attackIndex].data.hit.nat, 12);
        assert.equal(value.log[attackIndex].data.hit.total, 8);
        assert.equal(value.log[attackIndex].data.hit.outcome, OUTCOME.MISS);
        assert.equal(effectiveStats(target).hit, 0);
        assert.equal(target.statuses.length, 0);
    });

    it('self 新挂与本回合刷新的状态不会在同一次施法结束时损失持续时间', () => {
        const move = skill([{ type: 'buff', power: 0, duration: 1, modifiers: [{ attr: 'hit', delta: 2 }] }], { target: 'self' });
        const value = battle({ move, rng: new SequenceRng() });
        const actor = named(value, 'actor');
        value.act({ skillId: 'move' });
        assert.equal(actor.statuses[0].duration, 1);
        value.act({ action: 'skip' });
        value.act({ action: 'skip' });
        value.act({ skillId: 'move' });
        assert.equal(actor.statuses[0].duration, 1);
        assert.equal(actor.statuses[0].stacks, 2);
        value.act({ action: 'skip' });
        value.act({ action: 'skip' });
        value.act({ action: 'skip' });
        assert.equal(actor.statuses.length, 0);
        assert.equal(value.rng.calls, 0);
    });

    it('DoT血尽沿用切磋力竭/生死阵亡，并保留实际失败骰日志', () => {
        for (const mode of ['spar', 'deadly']) {
            const value = battle({ move: skill([{ type: 'dot', power: 2000, duration: 1 }]), combatMode: mode, rng: new SequenceRng(12, 4) });
            value.act({ skillId: 'move', targetIds: ['enemy1'] });
            const target = named(value, 'enemy1');
            assert.equal(target.alive, false);
            assert.equal(target.incapacitated, mode === 'spar');
            assert.match(checks(value, 'dot')[0].text, mode === 'spar' ? /力竭/ : /阵亡/);
            assert.equal(checks(value, 'dot')[0].check.nat, 4);
            if (mode === 'spar') assert.ok(value.log.every((entry) => !entry.text.includes('阵亡')));
            assert.equal(value.currentUnit.id, 'enemy2');
        }
    });

    it('独立tick/expire API表达开始与结束两个时点', () => {
        const actor = unit('actor', 'ally', 100, { statuses: [status('dot', { power: 7 })] });
        const events = tickStatuses(new SequenceRng(4), actor, RULES, 'spar');
        assert.equal(events[0].check.nat, 4);
        assert.equal(actor.statuses[0].duration, 1);
        assert.equal(expireStatuses(actor)[0].type, 'expire');
        assert.equal(actor.statuses.length, 0);
    });
});

describe('种子、快照和无递归推进', () => {
    it('同种子控制/DoT的真实检查、伤害、RNG游标完全复现', () => {
        const run = () => {
            const value = battle({ actor: { statuses: [status('control', { duration: 3, modifiers: [] }), status('dot', { power: 9, duration: 3 })] }, seed: 'repeat-statuses' });
            for (let i = 0; i < 12; i++) value.act({ action: 'skip' });
            return { units: value.units, log: cleanLog(value), rng: value.rng.snapshot(), round: value.round };
        };
        assert.deepEqual(run(), run());
    });

    it('等待输入时恢复不重复tick，已通过控制可行动，后续骰序和过期与原战斗一致', () => {
        const original = battle({
            actor: { statuses: [status('control', { duration: 2, modifiers: [] }), status('dot', { power: 7, duration: 2 }), status('debuff', { duration: 2, modifiers: [{ attr: 'hit', delta: -3 }] })] },
            seed: seedWithFirstRoll(20),
        });
        assert.equal(original.currentUnit.id, 'actor');
        assert.equal(original.rng.calls, 2);
        const state = JSON.parse(JSON.stringify(original.toState()));
        const restored = Battle.fromState(state);
        const before = restored.toState();
        restored._beginTurn();
        assert.deepEqual(restored.toState(), before);
        assert.equal(controlledBy(restored.currentUnit), '');
        assert.equal(checks(restored, 'control').length, 1);
        assert.equal(checks(restored, 'dot').length, 1);
        assert.equal(restored.act({ targetIds: ['enemy2'] }).ok, true);
        assert.equal(original.act({ targetIds: ['enemy2'] }).ok, true);
        for (let i = 0; i < 8; i++) {
            restored.act({ action: 'skip' });
            original.act({ action: 'skip' });
        }
        // JSON 存储会去掉 schema 自带的 undefined 可选属性，两侧按同一存储形态比较。
        assert.deepEqual(JSON.parse(JSON.stringify(restored.units)), JSON.parse(JSON.stringify(original.units)));
        assert.deepEqual(restored.rng.snapshot(), original.rng.snapshot());
        assert.deepEqual(JSON.parse(JSON.stringify(cleanLog(restored))), JSON.parse(JSON.stringify(cleanLog(original))));
    });

    it('旧等待输入快照兼容缺失回合凭据，不重新掷状态骰', () => {
        const value = battle({ actor: { statuses: [status('control', { duration: 2, modifiers: [] })] }, seed: seedWithFirstRoll(20) });
        const state = value.toState();
        delete state._activeTurn;
        for (const entry of state.units[0].statuses) delete entry._controlSaved;
        const restored = Battle.fromState(state);
        restored._beginTurn();
        assert.deepEqual(restored.rng.snapshot(), value.rng.snapshot());
        assert.equal(controlledBy(restored.currentUnit), '');
        assert.equal(restored.act({ action: 'skip' }).ok, true);
    });

    it('连续6000次控制跳过使用迭代，不会堆栈溢出或多掷骰', () => {
        const duration = 3000;
        const value = battle({
            actor: { statuses: [status('control', { duration, modifiers: [] })] },
            enemies: [unit('enemy1', 'enemy', 20, { statuses: [status('control', { duration, modifiers: [] })] })],
            rng: new SequenceRng(...Array(duration * 2).fill(1)),
        });
        assert.equal(value.phase, PHASE.AWAITING_INPUT);
        assert.equal(value.currentUnit.id, 'actor');
        assert.equal(value.round, duration + 1);
        assert.equal(value.rng.calls, duration * 2);
        assert.ok(value.units.every((entry) => entry.statuses.length === 0));
    });
});
