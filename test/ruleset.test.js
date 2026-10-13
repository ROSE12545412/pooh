/**
 * 公式编译器测试。
 *
 * 这是整个插件最容易出错的地方：公式是模型生成的字符串，
 * 编译不过就要静默回落到预设，绝不能把异常抛到引擎里。
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { Rng } from '../src/core/rng.js';
import {
    GENERIC_D20,
    POWER_MODE,
    RulesetEvaluator,
    compileFormula,
    normalizeRuleset,
    resolvePower,
    sniffPowerMode,
    sniffRuleset,
} from '../src/core/ruleset.js';

describe('公式编译与求值', () => {
    const scope = { Aim: 120, Atk: 30, Speed: 20, Armor: 5, Evasion: 10, power: 40, nat: 10 };

    it('编译时拒绝超大骰子，不能借自定义 RNG 或追踪钩子绕过', () => {
        assert.throws(() => compileFormula('999999999999d20'), /骰子数量/);
        assert.throws(() => compileFormula('2d999999999999999999999'), /骰子面数/);
        assert.equal(compileFormula('1000d6')({ __rng: { dice: () => ({ total: 3500 }) } }), 3500);
    });

    it('四则运算与优先级', () => {
        assert.equal(compileFormula('1 + 2 * 3')(scope), 7);
        assert.equal(compileFormula('(1 + 2) * 3')(scope), 9);
        assert.equal(compileFormula('10 / 4')(scope), 2.5);
        assert.equal(compileFormula('10 - 3 - 2')(scope), 5);
    });

    it('一元负号', () => {
        assert.equal(compileFormula('-5')(scope), -5);
        assert.equal(compileFormula('-Armor')(scope), -5);
        assert.equal(compileFormula('3 - -2')(scope), 5);
    });

    it('变量取值', () => {
        assert.equal(compileFormula('Aim')(scope), 120);
        assert.equal(compileFormula('Atk + power')(scope), 70);
    });

    it('未知变量按 0 处理而不是崩溃', () => {
        assert.equal(compileFormula('NoSuchVar + 5')(scope), 5);
    });

    it('数学函数', () => {
        assert.equal(compileFormula('floor(3.7)')(scope), 3);
        assert.equal(compileFormula('ceil(3.1)')(scope), 4);
        assert.equal(compileFormula('round(3.5)')(scope), 4);
        assert.equal(compileFormula('min(3, 7)')(scope), 3);
        assert.equal(compileFormula('max(3, 7)')(scope), 7);
        assert.equal(compileFormula('abs(-9)')(scope), 9);
        assert.equal(compileFormula('sqrt(16)')(scope), 4);
    });

    it('除零返回 0 而不是 Infinity', () => {
        assert.equal(compileFormula('10 / 0')(scope), 0);
    });

    it('比较运算与三元表达式', () => {
        assert.equal(compileFormula('nat == 10')(scope), 1);
        assert.equal(compileFormula('nat == 20')(scope), 0);
        assert.equal(compileFormula('nat >= 10')(scope), 1);
        assert.equal(compileFormula('nat != 10')(scope), 0);
        assert.equal(compileFormula('nat > 20 ? 100 : 5')(scope), 5);
    });

    it('rand 落在区间内', () => {
        const rng = new Rng('rand-test');
        const fn = compileFormula('rand(0.8, 1.2)');
        for (let i = 0; i < 500; i++) {
            const value = fn({ ...scope, __rng: rng });
            assert.ok(value >= 0.8 && value <= 1.2, `越界：${value}`);
        }
    });

    it('randint 产生闭区间整数', () => {
        const rng = new Rng('randint-test');
        const fn = compileFormula('randint(1, 6)');
        const seen = new Set();
        for (let i = 0; i < 1000; i++) {
            const value = fn({ ...scope, __rng: rng });
            assert.ok(Number.isInteger(value) && value >= 1 && value <= 6, `越界：${value}`);
            seen.add(value);
        }
        assert.equal(seen.size, 6);
    });

    it('骰子记法走 rng，且没有 rng 时退化为中值', () => {
        const rng = new Rng('dice-formula');
        const fn = compileFormula('d20');
        const seen = new Set();
        for (let i = 0; i < 2000; i++) seen.add(fn({ ...scope, __rng: rng }));
        assert.equal(Math.min(...seen), 1);
        assert.equal(Math.max(...seen), 20);

        // 没有 rng 时不应崩溃
        assert.equal(fn(scope), 11); // d20 中值 = round(10.5) = 11
    });

    it('2d6 的总和范围正确', () => {
        const rng = new Rng('2d6');
        const fn = compileFormula('2d6');
        for (let i = 0; i < 500; i++) {
            const value = fn({ ...scope, __rng: rng });
            assert.ok(value >= 2 && value <= 12, `越界：${value}`);
        }
    });

    it('布尔值参与运算时按 1/0 处理', () => {
        assert.equal(compileFormula('flag * 10')({ flag: true }), 10);
        assert.equal(compileFormula('flag * 10')({ flag: false }), 0);
    });

    it('语法错误要抛异常（好让上层回落）', () => {
        assert.throws(() => compileFormula('1 +'), /语法错误|意外/);
        assert.throws(() => compileFormula('(1 + 2'), /语法错误|意外/);
        assert.throws(() => compileFormula('unknownFunc(1)'), /未知函数/);
        assert.throws(() => compileFormula('1 @ 2'), /无法识别/);
        assert.throws(() => compileFormula(''), /为空/);
    });

    it('真实场景公式能算对', () => {
        const rng = new Rng('real-formula');
        // 命中率制：Aim 120 / (Speed 20 + Aim 120) = 0.857
        const chance = compileFormula('Aim / (Speed + Aim)')({ ...scope, __rng: rng });
        assert.ok(Math.abs(chance - 120 / 140) < 1e-9);

        // 伤害式：(power 40 + Atk 30) * 1 - Armor 5 = 65（rand 固定在边界内）
        const dmg = compileFormula('(power + Atk) * 1 - Armor')(scope);
        assert.equal(dmg, 65);

        // 带最低伤害保护
        const protectedDmg = compileFormula('max(1, power - Armor)')({ power: 2, Armor: 50 });
        assert.equal(protectedDmg, 1);
    });
});

describe('resolvePower 威力口径', () => {
    const unit = {
        attributes: {
            Atk: { current: 80, max: 80 },
            HP: { current: 500, max: 500 },
        },
    };

    it('绝对值口径原样返回', () => {
        const result = resolvePower(150, POWER_MODE.ABSOLUTE, unit);
        assert.equal(result.value, 150);
        assert.equal(result.applied, false);
    });

    it('攻击力比例口径按 ATK 还原', () => {
        const result = resolvePower(50, POWER_MODE.RATIO_ATK, unit);
        assert.equal(result.value, 40); // 80 的 50%
        assert.ok(result.applied);
    });

    it('生命上限比例口径按 MaxHP 还原', () => {
        const result = resolvePower(20, POWER_MODE.RATIO_MAXHP, unit);
        assert.equal(result.value, 100); // 500 的 20%
    });

    it('混合口径按效果类型分流', () => {
        // 伤害走 ATK
        assert.equal(resolvePower(50, POWER_MODE.MIXED, unit, 'damage').value, 40);
        // 护盾走 MaxHP
        assert.equal(resolvePower(20, POWER_MODE.MIXED, unit, 'shield').value, 100);
        // 治疗走 MaxHP
        assert.equal(resolvePower(20, POWER_MODE.MIXED, unit, 'heal').value, 100);
    });

    it('缺少属性时不崩溃', () => {
        assert.equal(resolvePower(50, POWER_MODE.RATIO_ATK, { attributes: {} }).value, 0);
        assert.equal(resolvePower(50, POWER_MODE.RATIO_ATK, null).value, 0);
    });
});

describe('power 口径嗅探', () => {
    it('规则文本明确写了攻击力百分比 → 判定为比例制', () => {
        const result = sniffPowerMode({ combatants: [] }, '威力为 ATK的20%至50%');
        assert.equal(result.mode, POWER_MODE.MIXED);
        assert.ok(result.confidence > 0.9);
    });

    it('power 普遍远小于 ATK → 判定为比例制', () => {
        const system = {
            combatants: [
                {
                    attributes: { Atk: { current: 200, max: 200 } },
                    skills: [{ power: 40 }, { power: 60 }, { power: 25 }],
                },
            ],
        };
        const result = sniffPowerMode(system, '');
        assert.equal(result.mode, POWER_MODE.MIXED);
        assert.ok(result.confidence >= 0.7);
    });

    it('power 与 ATK 量级相当 → 判定为绝对值', () => {
        const system = {
            combatants: [
                {
                    attributes: { Atk: { current: 120, max: 120 } },
                    skills: [{ power: 150 }, { power: 90 }, { power: 200 }],
                },
            ],
        };
        const result = sniffPowerMode(system, '');
        assert.equal(result.mode, POWER_MODE.ABSOLUTE);
    });

    it('没有数据时给出低置信度的默认结论', () => {
        const result = sniffPowerMode({ combatants: [] }, '');
        assert.equal(result.mode, POWER_MODE.ABSOLUTE);
        assert.ok(result.confidence < 0.5);
    });
});

describe('规则集归一化', () => {
    it('空输入回落到通用 d20 预设', () => {
        const ruleset = normalizeRuleset({});
        assert.equal(ruleset.initiativeFormula, GENERIC_D20.initiativeFormula);
        assert.equal(ruleset.damageFormula, GENERIC_D20.damageFormula);
        assert.equal(ruleset.hitMode, 'dice');
    });

    it('坏公式被替换成默认值而不是让引擎崩掉', () => {
        const ruleset = normalizeRuleset({
            name: '坏规则',
            damageFormula: 'power + + * Armor',
            hitFormula: '(((',
        });
        assert.equal(ruleset.damageFormula, GENERIC_D20.damageFormula);
        assert.equal(ruleset.hitFormula, GENERIC_D20.hitFormula);
    });

    it('从公式形态反推命中模式', () => {
        // 有骰子 → dice
        assert.equal(normalizeRuleset({ hitFormula: 'd20 + Speed' }).hitMode, 'dice');
        // 只有除法、没骰子 → chance
        assert.equal(normalizeRuleset({ hitFormula: 'Aim / (Speed + Aim)' }).hitMode, 'chance');
    });

    it('非法枚举值被纠正', () => {
        const ruleset = normalizeRuleset({
            aoeFalloff: '乱七八糟',
            powerMode: '不存在',
            critMultiplier: -5,
            minDamage: -3,
        });
        assert.equal(ruleset.aoeFalloff, GENERIC_D20.aoeFalloff);
        assert.equal(ruleset.powerMode, GENERIC_D20.powerMode);
        assert.equal(ruleset.critMultiplier, 1);
        assert.equal(ruleset.minDamage, 0);
    });

    it('中文别名字段也能识别', () => {
        const ruleset = normalizeRuleset({
            名称: '中文规则',
            命中公式: 'd20 + Atk',
            伤害公式: 'power - Armor',
            说明: '测试',
        });
        assert.equal(ruleset.name, '中文规则');
        assert.equal(ruleset.hitFormula, 'd20 + Atk');
        assert.equal(ruleset.damageFormula, 'power - Armor');
        assert.equal(ruleset.description, '测试');
    });
});

describe('RulesetEvaluator', () => {
    it('命中率被夹在 0~1', () => {
        const rng = new Rng('evaluator');
        const evaluator = new RulesetEvaluator(
            normalizeRuleset({ hitMode: 'chance', hitChanceFormula: 'Aim / (Speed + Aim)' }),
            rng,
        );
        assert.equal(evaluator.hitChance({ Aim: 100, Speed: 0 }), 1);
        assert.equal(evaluator.hitChance({ Aim: 0, Speed: 100 }), 0);
        const middle = evaluator.hitChance({ Aim: 50, Speed: 50 });
        assert.ok(Math.abs(middle - 0.5) < 1e-9);
    });

    it('effectValue 把公式修正加到威力上且不为负', () => {
        const rng = new Rng('effect');
        const evaluator = new RulesetEvaluator(
            normalizeRuleset({ shieldFormula: 'floor(MaxHP * 0.1)' }),
            rng,
        );
        const result = evaluator.effectValue('shield', { MaxHP: 500 }, 60);
        assert.equal(result.value, 110); // 60 + 50
        assert.equal(result.modifier, 50);

        // 修正为负时不允许结果为负
        const negative = evaluator.effectValue('shield', { MaxHP: -100000 }, 10);
        assert.equal(negative.value, 0);
    });

    it('公式求值出错时返回 0 而不是抛出', () => {
        const rng = new Rng('error');
        const evaluator = new RulesetEvaluator(normalizeRuleset({}), rng);
        assert.equal(evaluator.eval('未知函数(1)', {}), 0);
    });
});

describe('ruleset 本地嗅探', () => {
    it('从 d20 规则文本里识别出关键线索', () => {
        const text = `
            先攻：投 d20 + 敏捷调整值
            命中检定：d20 + 属性修正 + 技能修正，对抗目标闪避
            伤害 = 武器基础 + floor(攻击属性 / 2) - 护甲减免，最低 1 点
            暴击：d20 出 20 时伤害 2 倍；大失败时自己受到反噬
            HP 归零即死亡
        `;
        const result = sniffRuleset(text);
        assert.ok(result.signals.length >= 3, `线索太少：${JSON.stringify(result.signals)}`);
        assert.match(result.ruleset.initiativeFormula, /d20/);
    });

    it('从命中率规则文本里识别出概率模式', () => {
        const result = sniffRuleset('命中率 = 命中 ÷ (速度 + 命中)，命中若低于对方闪避率则打空');
        assert.equal(result.ruleset.hitMode, 'chance');
    });

    it('从百分比威力描述里识别出口径', () => {
        const result = sniffRuleset('技能威力 = 目标单位 ATK 的 20% 至 50%');
        assert.equal(result.ruleset.powerMode, POWER_MODE.MIXED);
    });

    it('没有规则文本时给出通用结论而不是瞎猜', () => {
        const result = sniffRuleset('这是一段关于天气和风景的描述。');
        assert.equal(result.signals.length, 0);
        assert.equal(result.ruleset.initiativeFormula, GENERIC_D20.initiativeFormula);
    });

    it('嗅探结果永远是合法规则集（可以喂给引擎）', () => {
        const texts = [
            '',
            '随便什么文本',
            'd20 + 力量，伤害 power - Armor，暴击 2 倍',
            '命中率 = 命中/(速度+命中)，护甲减伤，威力为攻击力的30%',
        ];
        for (const text of texts) {
            const { ruleset } = sniffRuleset(text);
            assert.ok(ruleset.initiativeFormula, `先攻公式缺失：${text}`);
            assert.ok(ruleset.damageFormula, `伤害公式缺失：${text}`);
            // 能编译就说明合法
            compileFormula(ruleset.damageFormula);
            compileFormula(ruleset.initiativeFormula);
        }
    });
});
