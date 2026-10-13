/** 只读的行动提示；不消耗随机数，也不提前执行判定。 */
import { effectiveStats } from './engine.js';
import { normalizeRuleset } from '../core/ruleset.js';

export function hitPenaltyPreview(unit, ruleset) {
    if (!unit) return null;
    const stats = effectiveStats(unit);
    const parts = stats.parts.filter(part => part.attr === 'hit' && part.delta < 0)
        .map(part => ({ source: part.source, value: part.delta }));
    if (!parts.length) return null;
    const rs = normalizeRuleset(ruleset);
    const formula = rs.hitMode === 'chance' ? rs.hitChanceFormula : rs.hitFormula;
    return {
        actorId: unit.id,
        actorName: unit.name,
        parts,
        penalty: parts.reduce((sum, part) => sum + part.value, 0),
        netModifier: stats.hit,
        appliesToHit: /\bhitBonus\b/.test(formula),
        hitMode: rs.hitMode,
        formula,
    };
}

const EFFECT_NAMES = {
    damage: '伤害', control: '控制', dot: '持续伤害', debuff: '减益',
    heal: '治疗', mp: '回蓝', shield: '护盾', buff: '增益', taunt: '嘲讽',
};

/** 技能说明与判定规则一致；数值不由界面重新推断。 */
export function skillMechanicsText(skill, ruleset) {
    const rs = normalizeRuleset(ruleset);
    const lines = [];
    if (skill.target === 'single') lines.push('单体：点击技能后选择一个合法目标');
    if (skill.target === 'group' || skill.target === 'all') {
        const falloff = rs.aoeFalloff === 'none' ? '当前规则不衰减'
            : `每目标伤害乘以 max(${rs.aoeFalloffFloor}, 1/${rs.aoeFalloff === 'linear' ? '目标数' : '√目标数'})`;
        lines.push(`AOE：覆盖所有合法目标；${falloff}`);
    }
    for (const effect of skill.effects ?? []) {
        const duration = effect.duration > 0 ? effect.duration : rs.defaultStatusDuration;
        const dc = effect.saveDc ?? 10;
        if (effect.type === 'control') lines.push(`控制：命中后持续 ${duration} 个目标回合；回合开始 d20+判定修正 对抗 DC ${dc}，失败跳过行动`);
        if (effect.type === 'dot') lines.push(`持续伤害：命中后持续 ${duration} 个目标回合；每回合 d20+判定修正 对抗 DC ${dc}，失败扣血，成功免本次伤害`);
        if (effect.type === 'debuff') {
            const hit = (effect.modifiers ?? []).filter(part => part.attr === 'hit').reduce((sum, part) => sum + part.delta, 0);
            lines.push(hit < 0 ? `骰点减益：命中后目标的命中与状态豁免修正 ${hit}，持续 ${duration} 个目标回合`
                : `减益：命中后挂状态，持续 ${duration} 个目标回合`);
        }
    }
    return lines;
}

export function skillEffectLabels(skill) {
    return [...new Set((skill.effects ?? []).map(effect =>
        effect.type === 'debuff' && effect.modifiers?.some(part => part.attr === 'hit' && part.delta < 0)
            ? '骰点减益' : EFFECT_NAMES[effect.type] || effect.type))].join(' / ');
}
