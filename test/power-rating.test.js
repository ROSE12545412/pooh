/**
 * 战力评估（powerRating）测试。
 *
 * 这是用户的原始需求之一：战力表不只是「战斗体系」，还要有**每个角色的战力评估**。
 * 它回答的是「这些人里谁更强」，所以既要能横向比较（数值），
 * 也要保留原世界书的说法（档位），还要能说明评分依据。
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
    POWER_GRADES,
    formatCombatantBlock,
    gradeFromRating,
    normalizeCombatant,
    normalizePowerRating,
    normalizePowerSystem,
    toCombatBlock,
} from '../src/core/schema.js';

describe('gradeFromRating 档位推导', () => {
    it('按区间给出档位', () => {
        assert.equal(gradeFromRating(95), '天花板');
        assert.equal(gradeFromRating(80), '顶尖');
        assert.equal(gradeFromRating(65), '一流');
        assert.equal(gradeFromRating(50), '二流');
        assert.equal(gradeFromRating(35), '三流');
        assert.equal(gradeFromRating(10), '杂鱼');
        assert.equal(gradeFromRating(0), '杂鱼');
    });

    it('边界值归入较高档', () => {
        for (const band of POWER_GRADES) {
            assert.equal(gradeFromRating(band.min), band.label, `${band.min} 应当归入 ${band.label}`);
        }
    });

    it('非法输入不崩', () => {
        assert.equal(gradeFromRating(undefined), '杂鱼');
        assert.equal(gradeFromRating(NaN), '杂鱼');
        assert.equal(gradeFromRating('abc'), '杂鱼');
    });
});

describe('normalizePowerRating 归一化', () => {
    it('解析完整对象', () => {
        const result = normalizePowerRating({
            rating: 78,
            grade: '金丹后期',
            note: '剑术精湛但体力不济',
            basis: '原文提到他连战三日力竭',
        });
        assert.equal(result.rating, 78);
        assert.equal(result.grade, '金丹后期');
        assert.equal(result.note, '剑术精湛但体力不济');
        assert.ok(result.basis.includes('连战三日'));
    });

    it('只有数字时自动补档位', () => {
        const result = normalizePowerRating(82);
        assert.equal(result.rating, 82);
        assert.equal(result.grade, '顶尖', '应当由数值推出档位');
    });

    it('只有字符串时当作档位，不编造数值', () => {
        const result = normalizePowerRating('一流高手');
        assert.equal(result.grade, '一流高手');
        assert.equal(result.rating, 0, '不该把「一流」硬映射成一个假数字');
    });

    it('字符串里的数字仍然当数值', () => {
        const result = normalizePowerRating('88');
        assert.equal(result.rating, 88);
        assert.equal(result.grade, '顶尖');
    });

    it('中文别名字段也能识别', () => {
        const result = normalizePowerRating({ 战力值: 66, 档位: '上忍', 评价: '速度极快', 依据: '秒杀上忍' });
        assert.equal(result.rating, 66);
        assert.equal(result.grade, '上忍');
        assert.equal(result.note, '速度极快');
        assert.equal(result.basis, '秒杀上忍');
    });

    it('评分被夹到 0~100', () => {
        assert.equal(normalizePowerRating({ rating: 999 }).rating, 100);
        assert.equal(normalizePowerRating({ rating: -50 }).rating, 0);
        assert.equal(normalizePowerRating({ rating: 77.6 }).rating, 78, '应当取整');
    });

    it('空输入返回 null（而不是一个假的 0 分）', () => {
        assert.equal(normalizePowerRating(null), null);
        assert.equal(normalizePowerRating(undefined), null);
        assert.equal(normalizePowerRating(''), null);
    });

    it('无字段的对象按 0 分处理（该对象确实是模型给的一个评估结构）', () => {
        const result = normalizePowerRating({});
        assert.equal(result.rating, 0);
        assert.equal(result.grade, '杂鱼');
    });
});

describe('单位里的战力评估', () => {
    it('从对象的 powerRating 字段读取', () => {
        const unit = normalizeCombatant({
            name: '甲',
            powerRating: { rating: 72, grade: '一流', note: '很强', basis: '剧情表现' },
        });
        assert.equal(unit.powerRating.rating, 72);
        assert.equal(unit.powerRating.grade, '一流');
    });

    it('兼容中文键「战力評估」/「战力」', () => {
        assert.equal(normalizeCombatant({ name: '甲', 战力: { rating: 55 } }).powerRating.rating, 55);
        assert.equal(normalizeCombatant({ name: '甲', 战力: '二流' }).powerRating.grade, '二流');
    });

    it('模型没给时留空而不是编造', () => {
        const unit = normalizeCombatant({ name: '甲' });
        assert.equal(unit.powerRating.rating, 0, '不该编造评分');
        assert.equal(unit.powerRating.grade, '', '不该编造档位');
        assert.equal(unit.powerRating.note, '');
    });

    it('整个体系里每个单位都带 powerRating 字段（结构一致）', () => {
        const system = normalizePowerSystem({
            allies: [normalizeCombatant({ name: '甲', powerRating: { rating: 60 } })],
            enemies: [normalizeCombatant({ name: '乙', side: 'enemy' })],
        });
        for (const unit of system.combatants) {
            assert.ok(unit.powerRating, `${unit.name} 缺少 powerRating`);
            assert.equal(typeof unit.powerRating.rating, 'number');
            assert.equal(typeof unit.powerRating.grade, 'string');
        }
    });
});

describe('战力评估的输出格式', () => {
    it('Combat_block 里带战力行', () => {
        const unit = normalizeCombatant({
            name: '甲',
            powerRating: { rating: 85, grade: '顶尖', note: '当世第一剑客', basis: 'x' },
        });
        const block = formatCombatantBlock(unit);
        assert.ok(block.includes('战力'), '应当有战力行');
        assert.ok(block.includes('85/100'), '应当带评分');
        assert.ok(block.includes('顶尖'), '应当带档位');
        assert.ok(block.includes('当世第一剑客'), '应当带评价');
    });

    it('未评估的单位不会输出假的战力行', () => {
        const unit = normalizeCombatant({ name: '甲' });
        const block = formatCombatantBlock(unit);
        assert.ok(!block.includes('战力 0/100'), '未评估时不该显示 0 分，会被误读成「很弱」');
    });

    it('只有档位没有数值时也能正常输出', () => {
        const unit = normalizeCombatant({ name: '甲', powerRating: '深不可测' });
        const block = formatCombatantBlock(unit);
        assert.ok(block.includes('深不可测'));
        assert.ok(block.includes('未评分'), '应当说明没有数值评分');
    });

    it('整表序列化包含战力信息（可回写正文）', () => {
        const system = normalizePowerSystem({
            allies: [normalizeCombatant({ name: '甲', powerRating: { rating: 70, grade: '一流' } })],
            enemies: [normalizeCombatant({ name: '敌', side: 'enemy', powerRating: { rating: 40, grade: '三流' } })],
        });
        const text = toCombatBlock(system);
        assert.ok(text.includes('70/100'));
        assert.ok(text.includes('40/100'));
        assert.ok(text.includes('一流') && text.includes('三流'));
    });

    it('往返解析后战力评估不丢失', () => {
        const system = normalizePowerSystem({
            allies: [normalizeCombatant({ name: '甲', powerRating: { rating: 70, grade: '一流', note: '备注' } })],
            enemies: [normalizeCombatant({ name: '敌', side: 'enemy', powerRating: { rating: 40 } })],
        });
        const text = toCombatBlock(system);
        // 文本里必须真的带上这些信息，否则注入正文后模型看不到强弱
        const ratingLines = text.split('\n').filter((l) => l.includes('战力'));
        assert.equal(ratingLines.length, 2, `应当有 2 行战力信息，实际 ${ratingLines.length}`);
    });
});
