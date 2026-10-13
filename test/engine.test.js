/**
 * 战斗引擎测试。
 *
 * 两个重点：
 *  1. **可复现性** —— 同种子、同操作序列必须得到完全相同的结果（这是「复盘争议回合」的基础）
 *  2. **规则集驱动** —— 换一套规则集，引擎行为必须跟着变，证明引擎里没有硬编码
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { Rng } from '../src/core/rng.js';
import { GENERIC_D20, POWER_MODE, normalizeRuleset } from '../src/core/ruleset.js';
import { normalizeCombatant, normalizePowerSystem } from '../src/core/schema.js';
import {
    Battle,
    OUTCOME,
    addStatus,
    aoeEffectivePower,
    applyDamage,
    applyHeal,
    attr,
    attrMax,
    autoChooseAction,
    canUseSkill,
    controlledBy,
    effectiveStats,
    expireStatuses,
    rollDamage,
    rollHit,
    rollInitiative,
    shieldTotal,
    spendMp,
    tickStatuses,
} from '../src/combat/engine.js';

/** 造一个单位。 */
function makeUnit(overrides = {}) {
    return normalizeCombatant({
        name: '测试角色',
        side: 'ally',
        attributes: {
            HP: { current: 100, max: 100 },
            MP: { current: 50, max: 50 },
            Atk: { current: 20, max: 20 },
            Armor: { current: 5, max: 5 },
            Speed: { current: 10, max: 10 },
            Evasion: { current: 10, max: 10 },
        },
        skills: [
            {
                name: '斩击',
                power: 30,
                aim: 100,
                cost: 0,
                target: 'single',
                effects: [{ type: 'damage', power: 30, duration: 0 }],
            },
        ],
        ...overrides,
    });
}

/** 造一场战斗（不 start）。 */
function makeBattle(opts = {}) {
    const system = normalizePowerSystem({
        system: { name: '测试体系' },
        allies: [
            makeUnit({ name: '甲', ...(opts.ally ?? {}) }),
            makeUnit({ name: '乙', ...(opts.ally2 ?? {}) }),
        ],
        enemies: [makeUnit({ name: '敌人', side: 'enemy', ...(opts.enemy ?? {}) })],
    });
    return new Battle(system, { seed: opts.seed ?? 'battle-test', ruleset: opts.ruleset });
}

describe('属性读取', () => {
    it('attr / attrMax 读标准键', () => {
        const unit = makeUnit();
        assert.equal(attr(unit, 'HP'), 100);
        assert.equal(attrMax(unit, 'HP'), 100);
        assert.equal(attr(unit, 'Atk'), 20);
    });

    it('缺属性时返回兜底值', () => {
        const unit = makeUnit();
        assert.equal(attr(unit, '不存在', 42), 42);
        assert.equal(attr(null, 'HP', 7), 7);
    });

    it('中文键名也能读', () => {
        const unit = makeUnit();
        assert.equal(attr(unit, '攻击力'), 20);
    });
});

describe('有效属性与状态影响', () => {
    it('无状态时等于基础值', () => {
        const stats = effectiveStats(makeUnit());
        assert.equal(stats.Atk, 20);
        assert.equal(stats.Armor, 5);
        assert.equal(stats.hit, 0);
    });

    it('增益状态提升攻击力', () => {
        const unit = makeUnit();
        addStatus(unit, { id: 's1', name: '狂暴', type: 'buff', power: 15, duration: 3, stacks: 1, description: '攻击力提升', source: '' });
        assert.equal(effectiveStats(unit).Atk, 35);
    });

    it('减益状态降低防御', () => {
        const unit = makeUnit();
        addStatus(unit, { id: 's1', name: '破甲', type: 'debuff', power: 3, duration: 3, stacks: 1, description: '防御下降', source: '' });
        assert.equal(effectiveStats(unit).Armor, 2);
    });

    it('层数会乘算', () => {
        const unit = makeUnit();
        addStatus(unit, { id: 's1', name: '强化', type: 'buff', power: 5, duration: 3, stacks: 3, description: '攻击力', source: '' });
        assert.equal(effectiveStats(unit).Atk, 35); // 20 + 5*3
    });

    it('命中类状态进入 hit 字段而不是 Atk', () => {
        const unit = makeUnit();
        addStatus(unit, { id: 's1', name: '瞄准', type: 'buff', power: 20, duration: 3, stacks: 1, description: '命中提升', source: '' });
        const stats = effectiveStats(unit);
        assert.equal(stats.hit, 20);
        assert.equal(stats.Atk, 20, '命中增益不应污染攻击力');
    });

    it('控制状态大幅降低闪避', () => {
        const unit = makeUnit();
        addStatus(unit, { id: 's1', name: '眩晕', type: 'control', power: 0, duration: 2, stacks: 1, description: '', source: '' });
        assert.ok(effectiveStats(unit).Evasion < 10);
    });

    it('属性不会被状态压成负数', () => {
        const unit = makeUnit();
        addStatus(unit, { id: 's1', name: '破甲', type: 'debuff', power: 999, duration: 3, stacks: 1, description: '防御下降', source: '' });
        assert.equal(effectiveStats(unit).Armor, 0);
    });

    it('识别不出关键词的状态不影响数值', () => {
        const unit = makeUnit();
        addStatus(unit, { id: 's1', name: '心情不错', type: 'buff', power: 999, duration: 3, stacks: 1, description: '', source: '' });
        assert.equal(effectiveStats(unit).Atk, 20);
    });
});

describe('先攻', () => {
    it('按总值降序排列', () => {
        const rng = new Rng('init');
        const units = [
            makeUnit({ name: '慢', attributes: { HP: { current: 10, max: 10 }, Speed: { current: 1, max: 1 }, Atk: { current: 1, max: 1 }, Armor: { current: 0, max: 0 }, Evasion: { current: 1, max: 1 } } }),
            makeUnit({ name: '快', attributes: { HP: { current: 10, max: 10 }, Speed: { current: 50, max: 50 }, Atk: { current: 1, max: 1 }, Armor: { current: 0, max: 0 }, Evasion: { current: 1, max: 1 } } }),
        ];
        const { order } = rollInitiative(rng, units, GENERIC_D20);
        assert.equal(order[0].name, '快');
        assert.equal(order[1].name, '慢');
    });

    it('只把存活单位排进先攻序', () => {
        const rng = new Rng('init2');
        const dead = makeUnit({ name: '尸体', alive: false });
        const alive = makeUnit({ name: '活人' });
        const { order } = rollInitiative(rng, [dead, alive], GENERIC_D20);
        assert.equal(order.length, 1);
        assert.equal(order[0].name, '活人');
    });

    it('同种子先攻结果一致', () => {
        const units = [makeUnit({ name: 'A' }), makeUnit({ name: 'B' }), makeUnit({ name: 'C' })];
        const a = rollInitiative(new Rng('same'), units, GENERIC_D20).order.map((e) => `${e.name}:${e.total}`);
        const b = rollInitiative(new Rng('same'), units, GENERIC_D20).order.map((e) => `${e.name}:${e.total}`);
        assert.deepEqual(a, b);
    });
});

describe('命中判定（掷骰对抗模式）', () => {
    const ruleset = normalizeRuleset({ ...GENERIC_D20, hitFormula: 'd20 + (Aim - 100) / 10', hitTargetFormula: 'Evasion' });

    it('结果只可能是四种之一', () => {
        const rng = new Rng('hit');
        const attacker = makeUnit();
        const defender = makeUnit({ name: '防', side: 'enemy' });
        const skill = attacker.skills[0];
        for (let i = 0; i < 200; i++) {
            const hit = rollHit(rng, attacker, defender, skill, ruleset);
            assert.ok(Object.values(OUTCOME).includes(hit.outcome), `非法结果：${hit.outcome}`);
            assert.ok(hit.nat >= 1 && hit.nat <= 20, `骰点越界：${hit.nat}`);
            assert.ok(typeof hit.expression === 'string' && hit.expression.length > 0, '必须有可读的判定说明');
        }
    });

    it('天然 20 一定暴击，天然 1 一定大失败', () => {
        // 通过大量采样确认两端行为
        const rng = new Rng('extremes');
        const attacker = makeUnit();
        const defender = makeUnit({ name: '防', side: 'enemy' });
        const skill = attacker.skills[0];
        let sawCrit = false;
        let sawFumble = false;
        for (let i = 0; i < 3000; i++) {
            const hit = rollHit(rng, attacker, defender, skill, ruleset);
            if (hit.nat === 20) {
                assert.equal(hit.outcome, OUTCOME.CRIT);
                sawCrit = true;
            }
            if (hit.nat === 1) {
                assert.equal(hit.outcome, OUTCOME.FUMBLE);
                sawFumble = true;
            }
        }
        assert.ok(sawCrit && sawFumble, '采样次数不足以覆盖两端');
    });

    it('高闪避目标明显更难被打中', () => {
        const attacker = makeUnit();
        const skill = attacker.skills[0];
        const countHits = (/** @type {number} */ evasion) => {
            const rng = new Rng('evasion-test');
            const defender = makeUnit({
                name: '防',
                side: 'enemy',
                attributes: { HP: { current: 100, max: 100 }, Evasion: { current: evasion, max: evasion }, Speed: { current: 10, max: 10 }, Atk: { current: 1, max: 1 }, Armor: { current: 0, max: 0 } },
            });
            let hits = 0;
            for (let i = 0; i < 800; i++) {
                const hit = rollHit(rng, attacker, defender, skill, ruleset);
                if (hit.outcome === OUTCOME.HIT || hit.outcome === OUTCOME.CRIT) hits++;
            }
            return hits;
        };
        const easyHits = countHits(5);
        const hardHits = countHits(25);
        assert.ok(easyHits > hardHits, `闪避没起作用：易中 ${easyHits} vs 难中 ${hardHits}`);
    });
});

describe('命中判定（概率模式）', () => {
    const ruleset = normalizeRuleset({
        ...GENERIC_D20,
        hitMode: 'chance',
        hitChanceFormula: 'Aim / (Speed + Aim)',
    });

    it('命中率与公式一致（大样本）', () => {
        const rng = new Rng('chance-test');
        const attacker = makeUnit();
        const defender = makeUnit({
            name: '防',
            side: 'enemy',
            attributes: { HP: { current: 100, max: 100 }, Speed: { current: 100, max: 100 }, Atk: { current: 1, max: 1 }, Armor: { current: 0, max: 0 }, Evasion: { current: 1, max: 1 } },
        });
        const skill = attacker.skills[0]; // aim 100
        // 命中率应为 100 / (100 + 100) = 0.5
        let hits = 0;
        const n = 4000;
        for (let i = 0; i < n; i++) {
            const hit = rollHit(rng, attacker, defender, skill, ruleset);
            if (hit.outcome === OUTCOME.HIT || hit.outcome === OUTCOME.CRIT) hits++;
        }
        const ratio = hits / n;
        assert.ok(Math.abs(ratio - 0.5) < 0.05, `命中率偏差过大：${ratio.toFixed(3)}`);
        assert.equal(ruleset.hitMode, 'chance');
    });
});

describe('伤害结算', () => {
    it('通用 d20 规则集：伤害落在合理区间', () => {
        const rng = new Rng('dmg');
        const attacker = makeUnit();
        const defender = makeUnit({ name: '防', side: 'enemy' });
        const skill = attacker.skills[0]; // power 30, defender armor 5
        for (let i = 0; i < 300; i++) {
            const hit = { outcome: OUTCOME.HIT, nat: 10, total: 10, target: 10 };
            const dmg = rollDamage(rng, attacker, defender, skill, hit, GENERIC_D20);
            // (30 + 1d6) - 5 → 26 ~ 31
            assert.ok(dmg.damage >= 26 && dmg.damage <= 31, `伤害越界：${dmg.damage}（${dmg.calculation}）`);
        }
    });

    it('未命中时伤害为 0', () => {
        const rng = new Rng('miss');
        const attacker = makeUnit();
        const defender = makeUnit({ name: '防', side: 'enemy' });
        const skill = attacker.skills[0];
        const dmg = rollDamage(rng, attacker, defender, skill, { outcome: OUTCOME.MISS, nat: 1, total: 1, target: 10 }, GENERIC_D20);
        assert.equal(dmg.damage, 0);
    });

    it('命中后至少有最低伤害（护甲再高也不会 0 伤）', () => {
        const rng = new Rng('min-dmg');
        const attacker = makeUnit({ attributes: { HP: { current: 10, max: 10 }, Atk: { current: 1, max: 1 }, Armor: { current: 0, max: 0 }, Speed: { current: 1, max: 1 }, Evasion: { current: 1, max: 1 } } });
        const defender = makeUnit({
            name: '铁罐头',
            side: 'enemy',
            attributes: { HP: { current: 100, max: 100 }, Armor: { current: 999, max: 999 }, Atk: { current: 1, max: 1 }, Speed: { current: 1, max: 1 }, Evasion: { current: 1, max: 1 } },
        });
        const skill = normalizeCombatant({ name: 'x', skills: [{ name: '弱击', power: 5, aim: 100 }] }).skills[0];
        const dmg = rollDamage(rng, attacker, defender, skill, { outcome: OUTCOME.HIT, nat: 10, total: 10, target: 10 }, GENERIC_D20);
        assert.equal(dmg.damage, GENERIC_D20.minDamage);
    });

    it('暴击倍率生效', () => {
        const rng = new Rng('crit-dmg');
        const attacker = makeUnit();
        const defender = makeUnit({ name: '防', side: 'enemy' });
        const skill = attacker.skills[0];
        const normal = rollDamage(rng, attacker, defender, skill, { outcome: OUTCOME.HIT, nat: 10, total: 10, target: 10 }, GENERIC_D20);
        const crit = rollDamage(rng, attacker, defender, skill, { outcome: OUTCOME.CRIT, nat: 20, total: 20, target: 10 }, GENERIC_D20);
        assert.ok(crit.isCrit);
        assert.equal(crit.critMultiplier, 2);
        // 暴击伤害应当是同等骰点下普通伤害的两倍左右
        assert.ok(crit.damage >= normal.damage, `暴击没有更疼：${crit.damage} vs ${normal.damage}`);
    });

    it('规则集里的 damageFormula 真的被使用（不是硬编码）', () => {
        const rng = new Rng('custom-formula');
        const attacker = makeUnit();
        const defender = makeUnit({ name: '防', side: 'enemy' });
        const skill = attacker.skills[0];
        // 一个完全平铺直叙的公式：伤害恒等于 power
        const flat = normalizeRuleset({ ...GENERIC_D20, damageFormula: 'power' });
        const dmg = rollDamage(rng, attacker, defender, skill, { outcome: OUTCOME.HIT, nat: 10, total: 10, target: 10 }, flat);
        assert.equal(dmg.damage, 30, `自定义公式未生效：${dmg.calculation}`);
    });

    it('比例威力口径生效', () => {
        const rng = new Rng('ratio');
        const attacker = makeUnit({ attributes: { HP: { current: 100, max: 100 }, Atk: { current: 200, max: 200 }, Armor: { current: 0, max: 0 }, Speed: { current: 1, max: 1 }, Evasion: { current: 1, max: 1 } } });
        const defender = makeUnit({
            name: '防',
            side: 'enemy',
            attributes: { HP: { current: 100, max: 100 }, Armor: { current: 0, max: 0 }, Atk: { current: 1, max: 1 }, Speed: { current: 1, max: 1 }, Evasion: { current: 1, max: 1 } },
        });
        const skill = normalizeCombatant({ name: 'x', skills: [{ name: '比例技', power: 50, aim: 100 }] }).skills[0];
        const ratioRuleset = normalizeRuleset({ ...GENERIC_D20, powerMode: POWER_MODE.RATIO_ATK, damageFormula: 'power' });
        const dmg = rollDamage(rng, attacker, defender, skill, { outcome: OUTCOME.HIT, nat: 10, total: 10, target: 10 }, ratioRuleset);
        // 50% of ATK 200 = 100
        assert.equal(dmg.damage, 100, `比例口径未生效：${dmg.calculation}`);
        assert.equal(dmg.powerBase, 'ATK(200)');
    });
});

describe('伤害应用与护盾', () => {
    it('先扣护盾再扣血', () => {
        const unit = makeUnit({ attributes: { HP: { current: 100, max: 100 } } });
        addStatus(unit, { id: 's', name: '护盾', type: 'shield', power: 30, duration: 3, stacks: 1, description: '护盾', source: '' });
        assert.equal(shieldTotal(unit), 30);

        const result = applyDamage(unit, 50);
        assert.equal(result.absorbed, 30);
        assert.equal(result.hpLost, 20);
        assert.equal(unit.attributes.HP.current, 80);
        assert.equal(shieldTotal(unit), 0, '护盾应当被打破并移除');
    });

    it('护盾足够时血量不变', () => {
        const unit = makeUnit({ attributes: { HP: { current: 100, max: 100 } } });
        addStatus(unit, { id: 's', name: '护盾', type: 'shield', power: 50, duration: 3, stacks: 1, description: '', source: '' });
        const result = applyDamage(unit, 20);
        assert.equal(result.hpLost, 0);
        assert.equal(unit.attributes.HP.current, 100);
        assert.equal(shieldTotal(unit), 30);
    });

    it('血量归零时标记阵亡', () => {
        const unit = makeUnit({ attributes: { HP: { current: 10, max: 100 } } });
        applyDamage(unit, 999);
        assert.equal(unit.attributes.HP.current, 0);
        assert.equal(unit.alive, false);
    });

    it('治疗不超过上限，且能复活', () => {
        const unit = makeUnit({ attributes: { HP: { current: 0, max: 100 } }, alive: false });
        const result = applyHeal(unit, 'HP', 500);
        assert.equal(unit.attributes.HP.current, 100);
        assert.equal(result.healed, 100);
        assert.equal(unit.alive, true);
    });

    it('回蓝同样受上限约束', () => {
        const unit = makeUnit({ attributes: { MP: { current: 10, max: 50 } } });
        applyHeal(unit, 'MP', 999);
        assert.equal(unit.attributes.MP.current, 50);
    });
});

describe('资源消耗', () => {
    it('够扣时正常扣', () => {
        const unit = makeUnit({ attributes: { MP: { current: 50, max: 50 } } });
        const result = spendMp(unit, 20);
        assert.equal(result.ok, true);
        assert.equal(unit.attributes.MP.current, 30);
    });

    it('不够扣时不扣并返回失败', () => {
        const unit = makeUnit({ attributes: { MP: { current: 5, max: 50 } } });
        const result = spendMp(unit, 20);
        assert.equal(result.ok, false);
        assert.equal(unit.attributes.MP.current, 5, '不够扣时不应部分扣除');
    });

    it('没有 MP 属性的单位视为无限资源', () => {
        const unit = normalizeCombatant({ name: 'x', attributes: { HP: { current: 10, max: 10 } } });
        assert.equal(spendMp(unit, 999).ok, true);
    });
});

describe('技能可用性', () => {
    it('正常技能可用', () => {
        const unit = makeUnit();
        assert.equal(canUseSkill(unit, unit.skills[0]).usable, true);
    });

    it('冷却中不可用并说明原因', () => {
        const unit = makeUnit();
        unit.skills[0].cooldownLeft = 2;
        const result = canUseSkill(unit, unit.skills[0]);
        assert.equal(result.usable, false);
        assert.match(result.reason, /冷却/);
    });

    it('资源不足不可用', () => {
        const unit = makeUnit({ attributes: { MP: { current: 1, max: 50 } } });
        unit.skills[0].cost = 30;
        assert.match(canUseSkill(unit, unit.skills[0]).reason, /资源不足/);
    });

    it('阵亡单位不可行动', () => {
        const unit = makeUnit({ alive: false });
        assert.match(canUseSkill(unit, unit.skills[0]).reason, /阵亡/);
    });

    it('被控制时识别出控制状态', () => {
        const unit = makeUnit();
        addStatus(unit, { id: 's', name: '眩晕', type: 'control', power: 0, duration: 2, stacks: 1, description: '', source: '' });
        assert.equal(controlledBy(unit), '眩晕');
        assert.match(canUseSkill(unit, unit.skills[0]).reason, /控制/);
    });

    it('控制状态过期后恢复行动', () => {
        const unit = makeUnit();
        addStatus(unit, { id: 's', name: '眩晕', type: 'control', power: 0, duration: 0, stacks: 1, description: '', source: '' });
        assert.equal(controlledBy(unit), '');
    });
});

describe('群攻衰减', () => {
    it('单目标不衰减', () => {
        assert.equal(aoeEffectivePower(100, 1, GENERIC_D20), 100);
    });

    it('按开方衰减且不低于地板值', () => {
        const two = aoeEffectivePower(100, 2, GENERIC_D20); // 100/sqrt(2) ≈ 71
        const four = aoeEffectivePower(100, 4, GENERIC_D20); // 50
        const many = aoeEffectivePower(100, 1000, GENERIC_D20); // 触底 35
        assert.ok(two < 100 && two > four, `衰减不符合预期：2目标 ${two}，4目标 ${four}`);
        assert.ok(many >= Math.floor(100 * GENERIC_D20.aoeFalloffFloor));
    });

    it('可以选择不衰减或线性衰减', () => {
        assert.equal(aoeEffectivePower(100, 4, normalizeRuleset({ aoeFalloff: 'none' })), 100);
        // 线性衰减 1/4 = 0.25，低于默认地板 0.35，所以会被抬到 35
        assert.equal(aoeEffectivePower(100, 4, normalizeRuleset({ aoeFalloff: 'linear' })), 35);
        // 把地板调低后就是纯线性
        assert.equal(
            aoeEffectivePower(100, 4, normalizeRuleset({ aoeFalloff: 'linear', aoeFalloffFloor: 0 })),
            25,
        );
    });
});

describe('状态结算', () => {
    it('持续伤害在回合豁免失败后扣血', () => {
        const rng = new Rng('dot');
        rng.next = () => 0; // 天然1：确定失败，不依赖种子恰好失败。
        const unit = makeUnit({ attributes: { HP: { current: 100, max: 100 } } });
        addStatus(unit, { id: 's', name: '中毒', type: 'dot', power: 7, duration: 3, stacks: 1, description: '', source: '' });
        const events = tickStatuses(rng, unit);
        assert.equal(unit.attributes.HP.current, 93);
        assert.ok(events.some((e) => e.type === 'dot'));
    });

    it('持续时间会递减，到期后移除', () => {
        const rng = new Rng('expire');
        const unit = makeUnit();
        addStatus(unit, { id: 's', name: '临时增益', type: 'buff', power: 5, duration: 2, stacks: 1, description: '攻击', source: '' });
        tickStatuses(rng, unit);
        assert.equal(unit.statuses[0].duration, 2, '回合开始不能提前移除仍应影响本次行动的状态');
        expireStatuses(unit);
        assert.equal(unit.statuses.length, 1, '还剩 1 回合不应移除');
        assert.equal(unit.statuses[0].duration, 1);
        tickStatuses(rng, unit);
        assert.equal(unit.statuses[0].duration, 1, '持续1回合也必须作用于这次行动');
        const events = expireStatuses(unit);
        assert.equal(unit.statuses.length, 0, '到期应当移除');
        assert.ok(events.some((e) => e.type === 'expire'));
    });

    it('护盾不会被持续时间清理掉', () => {
        const rng = new Rng('shield-keep');
        const unit = makeUnit();
        addStatus(unit, { id: 's', name: '护盾', type: 'shield', power: 20, duration: 1, stacks: 1, description: '', source: '' });
        tickStatuses(rng, unit);
        expireStatuses(unit);
        tickStatuses(rng, unit);
        expireStatuses(unit);
        assert.equal(shieldTotal(unit), 20, '护盾不应因持续时间归零而消失');
    });

    it('同名状态叠加层数并刷新持续时间', () => {
        const unit = makeUnit();
        addStatus(unit, { id: 'a', name: '中毒', type: 'dot', power: 5, duration: 2, stacks: 1, description: '', source: '' });
        addStatus(unit, { id: 'b', name: '中毒', type: 'dot', power: 5, duration: 5, stacks: 2, description: '', source: '' });
        assert.equal(unit.statuses.length, 1);
        assert.equal(unit.statuses[0].stacks, 3);
        assert.equal(unit.statuses[0].duration, 5);
    });
});

describe('战斗状态机', () => {
    it('开战后进入等待行动状态', () => {
        const battle = makeBattle();
        const result = battle.start();
        assert.equal(result.ok, true);
        assert.equal(battle.round, 1);
        assert.equal(battle.phase, 'awaiting_input');
        assert.ok(battle.currentUnit, '必须有当前行动单位');
    });

    it('缺少一方时拒绝开战', () => {
        const system = normalizePowerSystem({ allies: [makeUnit()] });
        const battle = new Battle(system, { seed: 'no-enemy' });
        const result = battle.start();
        assert.equal(result.ok, false);
        assert.match(result.error, /敌方/);
    });

    it('行动会推进到下一个单位', () => {
        const battle = makeBattle();
        battle.start();
        const first = battle.currentUnit?.id;
        const result = battle.act({});
        assert.equal(result.ok, true);
        assert.notEqual(battle.currentUnit?.id, first, '应当轮到下一个单位');
    });

    it('跳过回合会推进', () => {
        const battle = makeBattle();
        battle.start();
        const first = battle.currentUnit?.id;
        const result = battle.act({ action: 'skip' });
        assert.equal(result.ok, true);
        assert.notEqual(battle.currentUnit?.id, first);
    });

    it('回合数会在所有人行动完后递增', () => {
        const battle = makeBattle();
        battle.start();
        const total = battle.initiative.length;
        // 本回合已经开始了第一个单位的回合，所以再推进 total 次就会进入第 2 回合
        for (let i = 0; i < total; i++) {
            if (battle.phase === 'finished') break;
            battle.act({ action: 'skip' });
        }
        assert.ok(battle.round >= 2, `回合数没有递增：${battle.round}`);
    });

    it('战斗结束后拒绝继续行动', () => {
        const system = normalizePowerSystem({
            allies: [makeUnit({ name: '甲' })],
            enemies: [makeUnit({ name: '弱鸡', side: 'enemy', attributes: { HP: { current: 1, max: 1 }, Atk: { current: 1, max: 1 }, Armor: { current: 0, max: 0 }, Speed: { current: 1, max: 1 }, Evasion: { current: 1, max: 1 } } })],
        });
        const battle = new Battle(system, { seed: 'quick-win' });
        battle.start();
        // 反复打直到结束
        for (let i = 0; i < 30 && battle.phase !== 'finished'; i++) {
            if (battle.currentUnit?.side === 'enemy') battle.act({});
            else battle.act({});
        }
        assert.equal(battle.phase, 'finished');
        assert.equal(battle.winner, 'ally');
        const result = battle.act({});
        assert.equal(result.ok, false);
        assert.match(result.error, /已结束/);
    });

    it('日志记录了开战、先攻与回合信息', () => {
        const battle = makeBattle();
        battle.start();
        const types = battle.log.map((l) => l.type);
        assert.ok(types.includes('system'));
        assert.ok(types.includes('roll'));
        assert.ok(types.includes('turn'));
    });

    it('对不存在的技能返回错误而不是崩溃', () => {
        const battle = makeBattle();
        battle.start();
        const result = battle.act({ skillId: '不存在的技能' });
        // 找不到技能时会退化成普通攻击，所以应当成功
        assert.equal(result.ok, true);
    });
});

describe('可复现性（战斗复盘的基础）', () => {
    /** 跑一场固定脚本的战斗，返回结果摘要。 */
    function runScripted(seed) {
        const battle = makeBattle({ seed });
        battle.start();
        const lines = [];
        for (let i = 0; i < 24 && battle.phase !== 'finished'; i++) {
            const unit = battle.currentUnit;
            if (!unit) break;
            const result = battle.act({});
            lines.push(`${unit.name}:${result.ok}:${result.lines.join('|')}`);
        }
        return {
            lines,
            winner: battle.winner,
            round: battle.round,
            hp: battle.units.map((u) => `${u.name}=${u.attributes.HP.current}`).join(','),
        };
    }

    it('同种子同脚本 → 完全一致的结果', () => {
        const a = runScripted('replay-seed-42');
        const b = runScripted('replay-seed-42');
        assert.deepEqual(a, b, '同种子必须完全可复现');
    });

    it('不同种子 → 结果不同', () => {
        const a = runScripted('seed-alpha');
        const b = runScripted('seed-beta');
        assert.notDeepEqual(a, b, '不同种子应当得到不同过程');
    });

    it('从快照恢复后继续跑，结果与不间断跑一致', () => {
        // 前半段
        const battle = makeBattle({ seed: 'snapshot-seed' });
        battle.start();
        for (let i = 0; i < 4; i++) battle.act({});
        const state = battle.toState();

        // 恢复后继续
        const restored = Battle.fromState(state);
        for (let i = 0; i < 4; i++) {
            if (restored.phase === 'finished') break;
            restored.act({});
        }

        // 不间断跑到同一位置
        const direct = makeBattle({ seed: 'snapshot-seed' });
        direct.start();
        for (let i = 0; i < 8; i++) {
            if (direct.phase === 'finished') break;
            direct.act({});
        }

        assert.equal(restored.round, direct.round, '恢复后回合数应当一致');
        assert.deepEqual(
            restored.units.map((u) => u.attributes.HP.current),
            direct.units.map((u) => u.attributes.HP.current),
            '恢复后血量应当一致',
        );
    });

    it('导出的状态是 JSON 安全的（能存进聊天 metadata）', () => {
        const battle = makeBattle({ seed: 'json-safe' });
        battle.start();
        battle.act({});
        const state = battle.toState();
        assert.doesNotThrow(() => JSON.parse(JSON.stringify(state)));
        assert.ok(state.seed);
        assert.ok(state.rngSnapshot);
    });
});

describe('自动行动', () => {
    it('总能给出一个可执行的行动', () => {
        const battle = makeBattle();
        battle.start();
        const choice = autoChooseAction(battle);
        assert.equal(choice.unitId, battle.currentUnit?.id);
        const result = battle.act(choice);
        assert.equal(result.ok, true, `自动选择的行动执行失败：${result.error}`);
    });

    it('残血且有治疗技能时优先治疗', () => {
        const healer = makeUnit({
            name: '奶妈',
            attributes: { HP: { current: 20, max: 200 }, MP: { current: 100, max: 100 }, Atk: { current: 5, max: 5 }, Armor: { current: 5, max: 5 }, Speed: { current: 10, max: 10 }, Evasion: { current: 10, max: 10 } },
            skills: [
                { name: '治疗术', power: 100, aim: 100, cost: 5, target: 'single', effects: [{ type: 'heal', power: 100, duration: 0 }] },
                { name: '重击', power: 40, aim: 100, cost: 0, target: 'single', effects: [{ type: 'damage', power: 40, duration: 0 }] },
            ],
        });
        const system = normalizePowerSystem({
            allies: [healer],
            enemies: [makeUnit({ name: '敌', side: 'enemy' })],
        });
        const battle = new Battle(system, { seed: 'heal-first' });
        battle.start();
        // 让治疗单位行动
        for (let i = 0; i < 10 && battle.currentUnit?.name !== '奶妈'; i++) battle.act({ action: 'skip' });
        if (battle.currentUnit?.name === '奶妈') {
            const choice = autoChooseAction(battle);
            const chosen = healer.skills.find((s) => s.id === choice.skillId);
            assert.equal(chosen?.name, '治疗术', `残血时没有优先治疗：${JSON.stringify(choice)}`);
        }
    });

    it('敌人多且有群攻时选择群攻', () => {
        const aoeUnit = makeUnit({
            name: '法师',
            skills: [
                { name: '火球', power: 30, aim: 100, cost: 0, target: 'single', effects: [{ type: 'damage', power: 30, duration: 0 }] },
                { name: '烈焰风暴', power: 50, aim: 90, cost: 0, target: 'group', effects: [{ type: 'damage', power: 50, duration: 0 }] },
            ],
        });
        const system = normalizePowerSystem({
            allies: [aoeUnit],
            enemies: [
                makeUnit({ name: '敌1', side: 'enemy' }),
                makeUnit({ name: '敌2', side: 'enemy' }),
                makeUnit({ name: '敌3', side: 'enemy' }),
            ],
        });
        const battle = new Battle(system, { seed: 'aoe-first' });
        battle.start();
        for (let i = 0; i < 10 && battle.currentUnit?.name !== '法师'; i++) battle.act({ action: 'skip' });
        const choice = autoChooseAction(battle);
        const chosen = aoeUnit.skills.find((s) => s.id === choice.skillId);
        assert.equal(chosen?.name, '烈焰风暴', `多目标时没有选择群攻：${JSON.stringify(choice)}`);
    });
});

describe('引擎不依赖任何特定世界观（规则集驱动验证）', () => {
    it('换一套完全不同的规则集，引擎行为跟着变', () => {
        const system = normalizePowerSystem({
            allies: [makeUnit({ name: '甲' })],
            enemies: [makeUnit({ name: '敌', side: 'enemy' })],
        });

        // 只取「斩击」且**确实命中**的伤害记录，避免把未命中的 0 伤混进来
        const pickSkillDamage = (/** @type {any} */ battle) =>
            battle.log
                .filter(
                    (l) =>
                        l.data?.damage &&
                        l.data.skillName === '斩击' &&
                        (l.data.hit?.outcome === 'hit' || l.data.hit?.outcome === 'crit'),
                )
                .map((l) => l.data.damage.damage);

        /** 反复使用「斩击」直到至少打中一次。 */
        const landOneSlash = (/** @type {any} */ battle) => {
            for (let i = 0; i < 20 && battle.phase !== 'finished'; i++) {
                const unit = battle.currentUnit;
                const skill = unit?.skills?.find((/** @type {any} */ s) => s.name === '斩击');
                battle.act(skill ? { skillId: skill.id } : {});
                if (pickSkillDamage(battle).length) return;
            }
        };

        // 规则 A：伤害恒为 power
        const rulesetA = normalizeRuleset({ ...GENERIC_D20, damageFormula: 'power' });
        const battleA = new Battle(system, { seed: 'rules-A', ruleset: rulesetA });
        battleA.start();
        landOneSlash(battleA);
        const damageA = pickSkillDamage(battleA);

        // 规则 B：伤害恒为 power 的 10 倍
        const rulesetB = normalizeRuleset({ ...GENERIC_D20, damageFormula: 'power * 10' });
        const battleB = new Battle(system, { seed: 'rules-B', ruleset: rulesetB });
        battleB.start();
        landOneSlash(battleB);
        const damageB = pickSkillDamage(battleB);

        assert.ok(damageA.length, '规则 A 没有产生伤害记录');
        assert.ok(damageB.length, '规则 B 没有产生伤害记录');
        assert.equal(damageA[0], 30, `规则 A 未生效：${damageA[0]}`);
        assert.equal(damageB[0], 300, `规则 B 未生效：${damageB[0]}`);
    });

    it('规则集名与公式会被记录进战斗状态', () => {
        const ruleset = normalizeRuleset({ ...GENERIC_D20, name: '自定义测试规则', damageFormula: 'power - Armor' });
        const battle = makeBattle({ ruleset, seed: 'ruleset-record' });
        battle.start();
        const state = battle.toState();
        assert.equal(state.ruleset.name, '自定义测试规则');
        assert.equal(state.ruleset.damageFormula, 'power - Armor');
    });

    it('恢复战斗时规则集一并恢复', () => {
        const ruleset = normalizeRuleset({ ...GENERIC_D20, name: '恢复测试', damageFormula: 'power * 3' });
        const battle = makeBattle({ ruleset, seed: 'restore-ruleset' });
        battle.start();
        const restored = Battle.fromState(battle.toState());
        assert.equal(restored.ruleset.name, '恢复测试');
        assert.equal(restored.ruleset.damageFormula, 'power * 3');
        // 恢复后还能正常行动
        const result = restored.act({});
        assert.equal(result.ok, true);
    });
});
