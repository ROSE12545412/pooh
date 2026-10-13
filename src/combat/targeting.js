/** AI 目标选择：引擎提供完整合法候选；只有实际兜底时才抽取随机数。 */
import { Rng } from '../core/rng.js';

// targetCandidates(undefined) 不能表达普通攻击；显式伤害效果保证它按敌对行动筛选。
const BASIC_ATTACK = { target: 'single', effects: [{ type: 'damage' }] };
const HOSTILE_EFFECTS = new Set(['damage', 'control', 'dot', 'debuff', 'taunt']);

/** 只读候选查询。不要调用 resolveTargets：它会截断单体列表或消耗随机数。 */
export function legalTargetCandidates(battle, unit, skill) {
    if (!unit || typeof battle?.targetCandidates !== 'function') return [];
    return battle.targetCandidates(unit, skill ?? BASIC_ATTACK).filter(target => target && target.alive !== false);
}

function stat(unit, name) {
    const value = Number(unit.attributes?.[name]?.current);
    return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function deficit(unit, name) {
    const max = Number(unit.attributes?.[name]?.max);
    return max > 0 ? Math.max(0, Math.min(1, 1 - stat(unit, name) / max)) : 0;
}

function stableKey(unit) {
    return String(unit.id ?? unit.name ?? '');
}

/**
 * 为缺失/无效的单体 AI 目标兜底，返回合法单位或 null；不修改有效的模型/玩家选择。
 * skill 留空表示普通攻击。self 返回自身；group/all/random 由引擎结算，返回 null。
 * 受伤程度、威胁与护甲决定简单战术排序；同分使用战斗的可重放 RNG，且先按稳定 id
 * 排序，所以调整参战名单顺序不会改变同种子的选择。唯一最优目标不消耗 RNG。
 * 调用方必须在实际行动时重新校验缓存目标；不要在提示词/UI 预览中调用本函数。
 * @returns {object|null}
 */
export function chooseFallbackTarget(battle, unit, skill) {
    if (['group', 'all', 'random'].includes(skill?.target)) return null;
    const candidates = legalTargetCandidates(battle, unit, skill);
    if (!candidates.length) return null;
    if (candidates.length === 1) return candidates[0];

    const effects = new Set((skill ?? BASIC_ATTACK).effects?.map(effect => effect.type) ?? []);
    const hostile = [...effects].some(type => HOSTILE_EFFECTS.has(type));
    const threat = target => stat(target, 'Atk') + stat(target, 'Speed') * 0.25;
    const maxThreat = Math.max(1, ...candidates.map(threat));
    const maxArmor = Math.max(1, ...candidates.map(target => stat(target, 'Armor')));
    const score = target => {
        if (!hostile && effects.has('heal')) return deficit(target, 'HP');
        if (!hostile && effects.has('mp')) return deficit(target, 'MP');
        if (!hostile && effects.has('shield')) return deficit(target, 'HP');
        if (!hostile) return threat(target) / maxThreat;
        return deficit(target, 'HP') * 3 + threat(target) / maxThreat +
            (1 - stat(target, 'Armor') / maxArmor) * 0.25;
    };
    const ranked = candidates.map(target => ({ target, score: score(target) }));
    const best = Math.max(...ranked.map(entry => entry.score));
    const ties = ranked.filter(entry => Math.abs(entry.score - best) < 1e-9).map(entry => entry.target)
        .sort((a, b) => stableKey(a) < stableKey(b) ? -1 : stableKey(a) > stableKey(b) ? 1 : 0);
    if (ties.length === 1) return ties[0];

    // 真正的 Battle 总有 rng；简化调用方也获得稳定选择，绝不退回数组首位/Math.random。
    const rng = battle?.rng ?? new Rng([
        battle?.seed ?? battle?.id ?? 'targeting', battle?.round ?? 0,
        stableKey(unit), skill?.id ?? 'basic_attack',
    ].join('|'));
    return ties[rng.int(0, ties.length - 1)];
}
