/**
 * 战斗模式：切磋 vs 生死搏杀。
 *
 * 用户的要求：「战斗开始应该分为切磋和生死搏杀两个模式，让正文 ai 判定。
 * 如果是切磋就不能写阵亡而是力竭」。
 *
 * 这个区分很重要 —— 把父子木剑切磋打出「阵亡」是很荒唐的。
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { Battle, COMBAT_MODE, COMBAT_MODE_LABEL, applyDamage, downLabel } from '../src/combat/engine.js';
import { parseSituationReport } from '../src/llm/report-parser.js';
import { normalizeCombatant, normalizePowerSystem } from '../src/core/schema.js';

/** 造一个战士。 */
function makeUnit(name, side, hp = 100) {
    return normalizeCombatant({
        name,
        side,
        attributes: {
            HP: { current: hp, max: hp },
            Atk: { current: 20, max: 20 },
            Speed: { current: 10, max: 10 },
        },
    });
}

describe('downLabel 措辞', () => {
    it('切磋是力竭，生死是阵亡', () => {
        assert.equal(downLabel(COMBAT_MODE.SPAR), '力竭');
        assert.equal(downLabel(COMBAT_MODE.DEADLY), '阵亡');
    });

    it('模式中文名', () => {
        assert.equal(COMBAT_MODE_LABEL.spar, '切磋');
        assert.equal(COMBAT_MODE_LABEL.deadly, '生死搏杀');
    });
});

describe('applyDamage：血尽时的后果按模式区分', () => {
    it('切磋：倒下时标记 incapacitated（力竭）', () => {
        const unit = makeUnit('测试', 'ally', 50);
        const r = applyDamage(unit, 999, undefined, COMBAT_MODE.SPAR);
        assert.ok(r.hpLost > 0, '应当扣血');
        assert.equal(unit.alive, false, '应当倒下');
        assert.equal(unit.incapacitated, true, '切磋里倒下应当标记为力竭');
    });

    it('生死：倒下时不标 incapacitated（是阵亡）', () => {
        const unit = makeUnit('测试', 'ally', 50);
        applyDamage(unit, 999, undefined, COMBAT_MODE.DEADLY);
        assert.equal(unit.alive, false, '应当倒下');
        assert.ok(!unit.incapacitated, '生死搏杀里倒下不该标成力竭');
    });

    it('没打空时不标记', () => {
        const unit = makeUnit('测试', 'ally', 500);
        applyDamage(unit, 10, undefined, COMBAT_MODE.SPAR);
        assert.equal(unit.alive, true);
        assert.ok(!unit.incapacitated, '没倒下不该标记力竭');
    });

    it('不传模式时默认按生死（保守）', () => {
        const unit = makeUnit('测试', 'ally', 10);
        applyDamage(unit, 999);
        assert.ok(!unit.incapacitated, '默认不标力竭');
    });
});

describe('Battle 记住战斗模式', () => {
    it('构造时传入', () => {
        const b = new Battle(normalizePowerSystem({ combatants: [makeUnit('甲', 'ally'), makeUnit('乙', 'enemy')] }), {
            seed: 's1',
            combatMode: COMBAT_MODE.SPAR,
        });
        assert.equal(b.combatMode, COMBAT_MODE.SPAR);
    });

    it('不传时默认生死（保守）', () => {
        const b = new Battle(normalizePowerSystem({ combatants: [makeUnit('甲', 'ally'), makeUnit('乙', 'enemy')] }), {
            seed: 's1',
        });
        assert.equal(b.combatMode, COMBAT_MODE.DEADLY);
    });

    it('战斗对象在状态里保留模式（可被 toState/fromState 带走）', () => {
        const b = new Battle(normalizePowerSystem({ combatants: [makeUnit('甲', 'ally'), makeUnit('乙', 'enemy')] }), {
            seed: 's1',
            combatMode: COMBAT_MODE.SPAR,
        });
        const state = b.toState();
        assert.equal(state.combatMode, COMBAT_MODE.SPAR, 'toState 应当带上模式');
        const restored = Battle.fromState(state);
        assert.equal(restored.combatMode, COMBAT_MODE.SPAR, 'fromState 应当还原模式');
    });
});

describe('战斗日志的措辞按模式走', () => {
    it('切磋结算写「落败」而不是「败北」', () => {
        const system = normalizePowerSystem({
            combatants: [
                makeUnit('弱', 'ally', 1),
                { ...makeUnit('强', 'enemy', 99), attributes: { HP: { current: 99, max: 99 }, Atk: { current: 999, max: 999 }, Speed: { current: 1, max: 1 } } },
            ],
        });
        const b = new Battle(system, { seed: 'spar-end', combatMode: COMBAT_MODE.SPAR });
        b.start();
        // 直接把我方打空，触发结算
        const weak = b.units.find((u) => u.name === '弱');
        applyDamage(weak, 999, b.ruleset, b.combatMode);
        b._checkEnd();
        const text = b.log.map((l) => l.text).join('\n');
        assert.ok(text.includes('落败'), `切磋应当写「落败」，实际：${text}`);
        assert.ok(!text.includes('败北'), '切磋不该写「败北」');
    });

    it('生死结算写「败北」', () => {
        const system = normalizePowerSystem({
            combatants: [
                makeUnit('弱', 'ally', 1),
                { ...makeUnit('强', 'enemy', 99), attributes: { HP: { current: 99, max: 99 }, Atk: { current: 999, max: 999 }, Speed: { current: 1, max: 1 } } },
            ],
        });
        const b = new Battle(system, { seed: 'deadly-end', combatMode: COMBAT_MODE.DEADLY });
        b.start();
        const weak = b.units.find((u) => u.name === '弱');
        applyDamage(weak, 999, b.ruleset, b.combatMode);
        b._checkEnd();
        const text = b.log.map((l) => l.text).join('\n');
        assert.ok(text.includes('败北'), `生死应当写「败北」，实际：${text}`);
    });
});

describe('模式由正文 AI 判定（解析汇报里的「## 战斗模式」）', () => {
    const base = `## 参战双方
### 我方
**【玩家】甲**（幼童）
- 位阶：无阶
- 技能：
  - 木剑直刺｜伤害｜80｜5｜一记直刺
### 敌方
**乙**（父亲）
- 位阶：上级剑士
- 技能：
  - 疾风直劈｜伤害｜200｜20｜重斩
`;

    it('写「切磋」→ spar', () => {
        assert.equal(parseSituationReport(`${base}\n## 战斗模式\n切磋\n`).system.combatMode, 'spar');
    });

    it('写「生死搏杀」→ deadly', () => {
        assert.equal(parseSituationReport(`${base}\n## 战斗模式\n生死搏杀\n`).system.combatMode, 'deadly');
    });

    it('认各种生死说法', () => {
        for (const word of ['生死搏杀', '生死之战', '厮杀', '死斗', '以命相搏', '不死不休']) {
            assert.equal(
                parseSituationReport(`${base}\n## 战斗模式\n${word}\n`).system.combatMode,
                'deadly',
                `「${word}」应当判成生死搏杀`,
            );
        }
    });

    it('认各种切磋说法', () => {
        for (const word of ['切磋', '比试', '点到为止', '教学', '训练', '试探', '留手']) {
            assert.equal(
                parseSituationReport(`${base}\n## 战斗模式\n${word}\n`).system.combatMode,
                'spar',
                `「${word}」应当判成切磋`,
            );
        }
    });

    it('没说时**保守判成切磋**（宁可少写「阵亡」）', () => {
        // 把切磋误判成生死会写出「阵亡」，那是很荒唐的；反过来只是措辞保守
        assert.equal(parseSituationReport(base).system.combatMode, 'spar');
    });
});

describe('提示词要求模型判定模式', () => {
    const promptSource = readFileSync(new URL('../src/llm/scene-prompt.js', import.meta.url), 'utf8');

    it('模板里有「## 战斗模式」一节', () => {
        assert.ok(promptSource.includes('## 战斗模式'), '模板应当有战斗模式一节');
    });

    it('给出判定标准（切磋 vs 生死）', () => {
        assert.ok(promptSource.includes('无意取对方性命'), '应当说明切磋的判据');
        assert.ok(promptSource.includes('意图杀死对方'), '应当说明生死的判据');
    });

    it('明确告诉模型后果差异', () => {
        assert.ok(promptSource.includes('切磋里倒下叫「力竭」'), '应当说明后果');
        assert.ok(promptSource.includes('生死搏杀里倒下才是阵亡'), '应当说明生死搏杀的后果');
        assert.ok(promptSource.includes('不要仅凭人物关系、身份或武器类型推断战斗模式'), '应当按当前情景判断，不套用特定场景');
    });
});

describe('应用层：设置可覆盖 AI 判定', () => {
    const appSource = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');

    it('设置指定 spar/deadly 时优先于 AI 判定', () => {
        assert.ok(appSource.includes("modeSetting === 'spar' || modeSetting === 'deadly'"), '应当支持强制指定');
        assert.ok(appSource.includes("system.combatMode === 'deadly'"), '应当读取 AI 判定的结果');
    });

    it('开战日志会说明模式与来源', () => {
        assert.ok(appSource.includes('正文 AI 判定'), '应当标明来源');
        assert.ok(appSource.includes('切磋模式：倒下算「力竭」，不会阵亡'), '应当提示后果');
    });

    it('老存档缺 combatMode 时按切磋处理（更安全）', () => {
        assert.ok(
            appSource.includes("this.battle.combatMode !== 'spar' && this.battle.combatMode !== 'deadly'"),
            '应当兜底补齐模式',
        );
    });
});
