/**
 * tavern-dice / src/combat/engine.js
 * ---------------------------------------------------------------------------
 * 回合制战斗引擎 —— **规则集驱动，不含任何特定卡或特定世界观的硬编码**。
 *
 * 判定怎么算、伤害怎么算、暴击怎么判、power 是绝对值还是百分比，
 * 全部来自 `ruleset`（见 src/core/ruleset.js）。世界书里写了规则就用世界书的，
 * 没写就用内置的「通用 d20」预设。
 *
 * 这样设计的原因：不同角色的卡，战斗规则差别极大 ——
 * 掷骰对抗制、命中率制、百分比威力、境界压制……把它们统一成一套硬编码公式，
 * 必然有一半的卡算出来是错的。
 *
 * 引擎的工程约束：
 *  - 纯逻辑：不读全局状态、不碰 DOM、不调 fetch，可以在 node --test 里直接跑。
 *  - 可复现：所有随机数来自传入的 Rng，同种子必然同结果。
 */

import { Rng } from '../core/rng.js';
import { chooseFallbackTarget } from './targeting.js';
import {
    POWER_MODE,
    RulesetEvaluator,
    normalizeRuleset,
    compileCached,
    resolvePower,
} from '../core/ruleset.js';
import {
    SIDE,
    canonicalAttributeKey,
    deepClone,
    normalizeCombatant,
    normalizeSkill,
    normalizeStatus,
    toNumber,
    toText,
} from '../core/schema.js';

/** 战斗阶段。 */
export const PHASE = Object.freeze({
    IDLE: 'idle',
    AWAITING_INPUT: 'awaiting_input',
    RESOLVING: 'resolving',
    FINISHED: 'finished',
});

/** 单次判定的结果类型。 */
/**
 * 战斗模式。
 *
 * 用户的要求：「战斗开始应该分为切磋和生死搏杀两个模式，让正文 ai 判定。
 * 如果是切磋就不能写阵亡而是力竭」。
 *
 * 区别只在**血尽之后的后果**：
 *  - `spar`（切磋）：失去战斗力 = **力竭**，不会阵亡
 *  - `deadly`（生死搏杀）：失去战斗力 = **阵亡**
 *
 * 这个区分很重要 —— 把父子木剑切磋打出「阵亡」是很荒唐的。
 */
export const COMBAT_MODE = Object.freeze({
    SPAR: 'spar',
    DEADLY: 'deadly',
});

/** 模式的中文名。 */
export const COMBAT_MODE_LABEL = Object.freeze({
    spar: '切磋',
    deadly: '生死搏杀',
});

/** 血尽时的措辞（切磋用力竭，生死用阵亡）。 */
export function downLabel(mode) {
    return mode === COMBAT_MODE.DEADLY ? '阵亡' : '力竭';
}

export const OUTCOME = Object.freeze({
    HIT: 'hit',
    CRIT: 'crit',
    MISS: 'miss',
    FUMBLE: 'fumble',
});

// ---------------------------------------------------------------------------
// 取值辅助
// ---------------------------------------------------------------------------

/**
 * 读单位的某个属性当前值。
 * @param {object} unit
 * @param {string} key
 * @param {number} [fallback]
 * @returns {number}
 */
export function attr(unit, key, fallback = 0) {
    const pool = unit?.attributes?.[canonicalAttributeKey(key)];
    if (!pool) return fallback;
    return toNumber(pool.current) ?? fallback;
}

/**
 * 读单位的某个属性上限。
 * @param {object} unit
 * @param {string} key
 * @param {number} [fallback]
 * @returns {number}
 */
export function attrMax(unit, key, fallback = 0) {
    const pool = unit?.attributes?.[canonicalAttributeKey(key)];
    if (!pool) return fallback;
    return toNumber(pool.max) ?? toNumber(pool.current) ?? fallback;
}

/**
 * 汇总一个单位受状态影响后的有效属性。
 *
 * 明确的 modifiers 数组优先；只有缺少该字段的旧状态才按名称/描述关键词识别。
 * 关键词表覆盖中英文常见写法；识别不出来的状态不影响数值（只在日志里显示）。
 *
 * @param {object} unit
 * @returns {{Atk: number, Armor: number, Speed: number, Evasion: number, hit: number, parts: Array<{source: string, attr: string, delta: number}>}}
 */
export function effectiveStats(unit) {
    const stats = {
        Atk: attr(unit, 'Atk', 10),
        Armor: attr(unit, 'Armor', 0),
        Speed: attr(unit, 'Speed', 10),
        Evasion: attr(unit, 'Evasion', 10),
        hit: 0,
    };
    /** @type {Array<{source: string, attr: string, delta: number}>} */
    const parts = [];
    const apply = (key, delta, source) => {
        const canonical = /^(hit|hitBonus|aim|accuracy|命中)$/i.test(key) ? 'hit' : canonicalAttributeKey(key);
        if (!Object.hasOwn(stats, canonical) || !Number.isFinite(delta) || delta === 0) return;
        stats[canonical] += delta;
        parts.push({ source, attr: canonical, delta });
    };

    // 旧卡可能已经把装备计入属性，默认不重复叠加；additive 明确指有效属性之外的新增量。
    for (const equipment of unit?.equipment ?? []) {
        if (equipment.equipped === false || (unit.attributeBasis !== 'base' && equipment.bonusMode !== 'additive')) continue;
        for (const [key, value] of Object.entries(equipment.bonuses ?? {})) {
            apply(key, toNumber(value), `装备：${equipment.name}`);
        }
    }

    for (const status of unit?.statuses ?? []) {
        const text = `${status.name} ${status.description ?? ''} ${status.tag ?? ''}`.toLowerCase();
        const stacks = toNumber(status.stacks) || 1;
        const power = Math.abs(toNumber(status.power) ?? 0);
        const add = (/** @type {string} */ key, /** @type {number} */ delta, /** @type {string} */ why) => {
            apply(key, delta, `${status.name}${why ? `（${why}）` : ''}`);
        };
        if (Array.isArray(status.modifiers)) {
            for (const modifier of status.modifiers) {
                apply(modifier.attr, (toNumber(modifier.delta) ?? 0) * stacks, status.name);
            }
            continue;
        }

        if (status.type === 'buff' || status.type === 'debuff') {
            const sign = status.type === 'buff' ? 1 : -1;
            const amount = power * stacks * sign;
            // 攻击力
            if (/攻击|atk|力量|威力/.test(text)) add('Atk', amount, '攻击');
            // 防御
            if (/防御|护甲|armor|def|铁壁|护体|罡气|护盾强化/.test(text)) add('Armor', amount, '防御');
            // 速度
            if (/速度|敏捷|speed|spd|迅捷|迟缓/.test(text)) add('Speed', amount, '速度');
            // 闪避
            if (/闪避|evasion|dodge|灵敏|身法/.test(text)) add('Evasion', amount, '闪避');
            // 命中（单独一个字段，因为命中修正的量纲常与属性不同）
            if (/命中|瞄准|瞄|精准|accuracy|aim|致盲|失明/.test(text)) add('hit', amount, '命中');
        }

        // 控制类状态额外降低闪避（让控制技能真的有价值）
        if (status.type === 'control' || /眩晕|封印|定身|束缚|麻痹|冰冻|石化/.test(status.name)) {
            add('Evasion', -Math.floor(stats.Evasion * 0.5), '受控');
        }
    }

    // 下限修正也属于真实计算的一步，保留它才能让来源明细与最终属性相加一致。
    for (const [key, floor] of Object.entries({ Atk: 0, Armor: 0, Speed: 1, Evasion: 1 })) {
        if (stats[key] < floor) apply(key, floor - stats[key], `${key} 下限`);
    }

    return { ...stats, parts };
}

/** 兼容旧 API：有效闪避。 */
export function effectiveEvasion(unit) {
    const s = effectiveStats(unit);
    return { value: s.Evasion, parts: s.parts.filter((p) => p.attr === 'Evasion') };
}

/** 兼容旧 API：有效命中加值。 */
export function effectiveAim(attacker) {
    const s = effectiveStats(attacker);
    return { value: s.hit, parts: s.parts.filter((p) => p.attr === 'hit') };
}

/** 兼容旧 API：有效护甲。 */
export function effectiveArmor(unit) {
    return effectiveStats(unit).Armor;
}

/**
 * 计算护盾总量。
 * @param {object} unit
 * @returns {number}
 */
export function shieldTotal(unit) {
    return (unit?.statuses ?? [])
        .filter((/** @type {any} */ s) => s.type === 'shield')
        .reduce((sum, /** @type {any} */ s) => sum + (toNumber(s.power) || 0) * (s.stacks || 1), 0);
}

/**
 * 构造公式求值的作用域。
 *
 * 公式里可以直接用 `Aim`、`Speed`、`Armor`、`power` 这类名字，
 * 不需要关心它们来自哪个单位。但**有两类变量的归属需要特别说明**：
 *
 *  - `Atk` / `HP` / `MaxHP` / `MP` / `hitBonus`：始终指**行动方**（先攻、伤害计算都要用自己这边）
 *  - `Armor` / `Evasion` / `target*`：始终指**冲突的对方**（减伤、闪避天然是对面的属性）
 *  - `Speed`：**两边都可能用到**，所以由 `defenderIsSpeed` 开关决定：
 *      · 先攻公式（默认）→ 自己的速度
 *      · 命中判定 → 对方的速度（「命中率 = 命中 ÷ (速度 + 命中)」里的速度只能是目标的）
 *
 * 这个开关不是猜测：`Evasion` 只能来自对方、`Aim` 只能来自自己，
 * 所以任何同时用到两者的公式（命中判定必然如此）都只可能是对抗式。
 * 自动切换比让模型每次都给 `targetSpeed` 这样的限定名可靠得多。
 *
 * @param {object} opts
 * @returns {Record<string, any>}
 */
export function buildScope(opts) {
    const {
        attacker,
        defender,
        skill,
        resolvedPower = 0,
        nat = 0,
        targets = 1,
        round = 1,
        multiplier = 1,
        /** true 时 `Speed` / `Spd` 取防守方的值 */
        defenderIsSpeed = false,
        extra = {},
    } = opts;

    const aStats = attacker ? effectiveStats(attacker) : { Atk: 0, Armor: 0, Speed: 0, Evasion: 0, hit: 0 };
    const dStats = defender ? effectiveStats(defender) : { Atk: 0, Armor: 0, Speed: 0, Evasion: 0, hit: 0 };
    const speedForFormula = defenderIsSpeed ? dStats.Speed : aStats.Speed;

    return {
        // 行动方
        Aim: toNumber(skill?.aim) ?? 100,
        Hit: toNumber(skill?.aim) ?? 100,
        Accuracy: toNumber(skill?.aim) ?? 100,
        Atk: aStats.Atk,
        atk: aStats.Atk,
        HP: attr(attacker, 'HP', 0),
        MaxHP: attrMax(attacker, 'HP', 0),
        MP: attr(attacker, 'MP', 0),
        MaxMP: attrMax(attacker, 'MP', 0),
        hitBonus: aStats.hit,
        attackerSpeed: aStats.Speed,

        // 速度：归属由 defenderIsSpeed 决定（见函数注释）
        Speed: speedForFormula,
        Spd: speedForFormula,
        targetSpeed: dStats.Speed,

        // 冲突对方
        Evasion: dStats.Evasion,
        Armor: dStats.Armor,
        Def: dStats.Armor,
        targetArmor: dStats.Armor,
        targetAtk: dStats.Atk,
        targetHP: attr(defender, 'HP', 0),
        targetMaxHP: attrMax(defender, 'HP', 1),
        targetHPPercent:
            attrMax(defender, 'HP', 1) > 0 ? attr(defender, 'HP', 0) / attrMax(defender, 'HP', 1) : 1,

        // 技能与战斗
        power: resolvedPower,
        cost: toNumber(skill?.cost) || 0,
        nat,
        crit: 0, // 暴击判定时会被替换
        critMult: 1,
        CritMultiplier: 1,
        targets,
        multiplier,
        round,

        ...extra,
    };
}

// ---------------------------------------------------------------------------
// 先攻
// ---------------------------------------------------------------------------

/**
 * 掷先攻并生成行动顺序。
 * @param {Rng} rng
 * @param {object[]} units
 * @param {object} ruleset
 * @returns {{order: Array<{unitId: string, name: string, side: string, roll: number, bonus: number, total: number}>, rngSnapshot: object}}
 */
export function rollInitiative(rng, units, ruleset) {
    const evaluator = new RulesetEvaluator(ruleset, rng);

    const entries = units
        .filter((u) => u.alive)
        .map((unit) => {
            const scope = buildScope({ attacker: unit });
            const total = evaluator.initiative(scope);
            // 拆出「骰点」与「加值」两部分，纯粹为了日志好看：
            // 先算一次不带随机的基准值，差值即为加值
            const stats = effectiveStats(unit);
            const base = stats.Speed;
            return {
                unitId: unit.id,
                name: unit.name,
                side: unit.side,
                roll: Math.round(total - base),
                bonus: Math.round(base),
                total: Math.round(total),
                statSources: statSourceTrace(unit, stats),
            };
        });

    entries.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, 'zh-Hans-CN'));
    return { order: entries, rngSnapshot: rng.snapshot() };
}

// ---------------------------------------------------------------------------
// 命中判定
// ---------------------------------------------------------------------------

/** 装备只控制攻击检定，防御优势映射为来袭攻击劣势；不同来源不堆额外骰子。 */
function equipmentCheckSources(attacker, defender) {
    const sources = [];
    for (const [unit, role, check] of [[attacker, 'attacker', 'attack'], [defender, 'defender', 'defense']]) {
        for (const equipment of unit?.equipment ?? []) {
            if (equipment.equipped === false) continue;
            const mode = equipment.checks?.[check];
            if (mode !== 'advantage' && mode !== 'disadvantage') continue;
            const attackMode = role === 'defender' ? (mode === 'advantage' ? 'disadvantage' : 'advantage') : mode;
            sources.push({ source: `装备：${equipment.name}`, unitId: unit.id, unitName: unit.name, role, check, mode, attackMode });
        }
    }
    const advantage = sources.some((source) => source.attackMode === 'advantage');
    const disadvantage = sources.some((source) => source.attackMode === 'disadvantage');
    return { mode: advantage === disadvantage ? 'normal' : advantage ? 'advantage' : 'disadvantage', cancelled: advantage && disadvantage, sources };
}

/** 只能替换主 d20 的确定性加减式；不猜任意自定义公式的优劣势含义。 */
function simplePrimaryD20(formula, compiled) {
    const compact = formula.replace(/\s/g, '');
    return compiled.diceTerms.length === 1 && compiled.diceTerms[0].count === 1 && compiled.diceTerms[0].faces === 20 && !compiled.maySkipDice
        && /^1?d20(?:[+-][A-Za-z0-9_()+*/.\-]+)?$/i.test(compact)
        && !/[A-Za-z_]\w*\(/.test(compact);
}

/** 这是属性来源，不声称任意自定义公式都把各项直接加在骰面上。 */
function statSourceTrace(unit, stats = effectiveStats(unit)) {
    return ['hit', 'Evasion', 'Armor', 'Atk', 'Speed'].map((key) => ({
        attr: key,
        base: key === 'hit' ? 0 : attr(unit, key, key === 'Armor' ? 0 : 10),
        value: stats[key],
        parts: stats.parts.filter((part) => part.attr === key).map((part) => ({ ...part })),
    }));
}

/**
 * 掷命中。
 *
 * 两种模式：
 *  - `dice`   掷骰对抗：命中值 = hitFormula(...)，目标值 = hitTargetFormula(...)，命中值 >= 目标值即命中。
 *  - `chance` 概率判定：命中率 = hitChanceFormula(...)（0~1），直接按概率掷。
 *
 * 两种模式都会先掷 `nat`（默认 d20），供暴击/大失败公式使用。
 *
 * @param {Rng} rng
 * @param {object} attacker
 * @param {object} defender
 * @param {object} skill
 * @param {object} ruleset
 * @returns {object}
 */
export function rollHit(rng, attacker, defender, skill, ruleset) {
    const rs = normalizeRuleset(ruleset);
    const evaluator = new RulesetEvaluator(rs, rng);

    // 单颗命中骰复用天然值；复杂公式仍保留原来的独立天然骰语义。
    const hitFormula = compileCached(rs.hitFormula);
    const terms = hitFormula.diceTerms;
    const shareNatural = rs.hitMode === 'dice' && terms.length === 1 && terms[0].count === 1 && !hitFormula.maySkipDice;
    const faces = Math.max(2, sniffHitDie(rs.hitFormula) || 20);
    const equipmentCheck = equipmentCheckSources(attacker, defender);
    equipmentCheck.supported = rs.hitMode === 'dice' && shareNatural && simplePrimaryD20(rs.hitFormula, hitFormula);
    equipmentCheck.applied = equipmentCheck.supported && equipmentCheck.mode !== 'normal';
    const naturalRolls = [rng.int(1, faces)];
    if (equipmentCheck.applied) naturalRolls.push(rng.int(1, faces));
    const nat = equipmentCheck.applied
        ? (equipmentCheck.mode === 'advantage' ? Math.max(...naturalRolls) : Math.min(...naturalRolls))
        : naturalRolls[0];
    equipmentCheck.rolls = [...naturalRolls];
    equipmentCheck.kept = nat;
    const scope = buildScope({ attacker, defender, skill, nat, defenderIsSpeed: true });
    const diceTrace = [];
    const random = [];
    let usedNatural = false;
    const tracedScope = (stage) => ({
        ...scope,
        __rollDice: (count, dieFaces, meta) => {
            const shared = stage === 'hit' && shareNatural && !usedNatural && count === 1 && dieFaces === faces;
            const result = shared ? {
                count: naturalRolls.length, faces, rolls: [...naturalRolls], total: nat,
                ...(equipmentCheck.applied ? { kept: nat, keep: equipmentCheck.mode === 'advantage' ? 'highest' : 'lowest' } : {}),
            } : rng.dice(count, dieFaces);
            if (shared) usedNatural = true;
            diceTrace.push({ ...result, rolls: [...result.rolls], stage, ...meta });
            return result;
        },
        __recordRandom: (event) => random.push({ ...event, stage }),
    });

    let outcome;
    let total;
    let target;
    const formula = rs.hitMode === 'chance' ? rs.hitChanceFormula : rs.hitFormula;
    if (rs.hitMode === 'chance') {
        target = evaluator.hitChance(tracedScope('chance'));
        total = rng.next();
        random.push({ kind: 'chance', min: 0, max: 1, value: total, stage: 'hit' });
        outcome = total < target ? OUTCOME.HIT : OUTCOME.MISS;
    } else {
        total = evaluator.hitValue(tracedScope('hit'));
        target = evaluator.hitTarget(tracedScope('target'));
        outcome = total >= target ? OUTCOME.HIT : OUTCOME.MISS;
    }

    // 保持规则原有优先级：暴击先于大失败；两者都可以覆盖普通比较结果。
    const baseOutcome = outcome;
    let override;
    if (evaluator.isCrit(tracedScope('crit'))) override = OUTCOME.CRIT;
    else if (evaluator.isFumble(tracedScope('fumble'))) override = OUTCOME.FUMBLE;
    if (override) outcome = override;

    const compact = formula.replace(/\s+/g, '');
    const defaultSum = rs.hitMode === 'dice' && /^(?:1?d20)\+\(Aim-100\)\/10(?:\+hitBonus)?$/.test(compact);
    const attackerStats = effectiveStats(attacker);
    const defenderStats = effectiveStats(defender);
    const modifiers = defaultSum
        ? [
            { source: '技能命中', value: (scope.Aim - 100) / 10, detail: `(${scope.Aim} - 100) / 10` },
            ...(compact.endsWith('+hitBonus')
                ? attackerStats.parts.filter((part) => part.attr === 'hit').map((part) => ({ source: part.source, value: part.delta }))
                : []),
        ]
        : null;
    const targetModifiers = rs.hitMode === 'dice' && rs.hitTargetFormula.trim() === 'Evasion'
        ? [
            { source: '基础闪避', value: attr(defender, 'Evasion', 10) },
            ...defenderStats.parts.filter((part) => part.attr === 'Evasion').map((part) => ({ source: part.source, value: part.delta })),
        ]
        : null;
    const notes = [];
    for (const unit of [...new Set([attacker, defender])]) {
        if (!unit || unit.attributeBasis === 'base') continue;
        const equipped = (unit.equipment ?? []).filter((gear) => gear.equipped !== false);
        if (equipped.some((gear) => gear.bonusMode !== 'additive' && Object.keys(gear.bonuses ?? {}).length)) {
            notes.push(`${unit.name ?? '单位'}的属性已含装备或口径未明确，未额外叠加装备 base 加成`);
        }
        if (equipped.some((gear) => gear.bonusMode === 'additive' && Object.keys(gear.bonuses ?? {}).length)) {
            notes.push(`${unit.name ?? '单位'}仅叠加明确标记 additive 的装备新增量；旧有效属性中的装备数值不可分离，未猜测扣减`);
        }
    }
    if (equipmentCheck.sources.length) {
        const labels = { advantage: '优势', disadvantage: '劣势', normal: '普通' };
        const sources = equipmentCheck.sources.map((source) => `${source.unitName}的${source.source}（${source.check === 'attack' ? '攻击' : '防御'}${labels[source.mode]}→进攻方${labels[source.attackMode]}）`).join('、');
        if (equipmentCheck.cancelled) notes.push(`装备 d20 优势与劣势抵消，按原规则普通检定；来源：${sources}`);
        else if (!equipmentCheck.supported) notes.push(`未应用装备 d20 ${labels[equipmentCheck.mode]}：当前命中规则不是可安全替换的单颗、无条件主 d20，保留原公式与掷骰，不虚构 2d20 算式；来源：${sources}`);
        else notes.push(`装备 d20 ${labels[equipmentCheck.mode]}：掷出 ${naturalRolls.join('、')}，取${equipmentCheck.mode === 'advantage' ? '高' : '低'} ${nat}；来源：${sources}`);
    }
    const specialRule = override
        ? `${override === OUTCOME.CRIT ? '暴击' : '大失败'}公式 ${override === OUTCOME.CRIT ? rs.critFormula : rs.fumbleFormula} 成立，覆盖普通比较结果`
        : '';
    return {
        outcome,
        baseOutcome,
        nat,
        dieFaces: faces,
        total,
        target,
        hitMode: rs.hitMode,
        comparison: rs.hitMode === 'chance' ? '<' : '>=',
        formula,
        targetFormula: rs.hitMode === 'chance' ? rs.hitChanceFormula : rs.hitTargetFormula,
        modifiers,
        targetModifiers,
        equipmentCheck,
        statSources: { attacker: statSourceTrace(attacker, attackerStats), defender: statSourceTrace(defender, defenderStats) },
        dice: diceTrace.filter((entry) => entry.stage === 'hit' || entry.stage === 'chance'),
        targetDice: diceTrace.filter((entry) => entry.stage === 'target'),
        specialDice: diceTrace.filter((entry) => entry.stage === 'crit' || entry.stage === 'fumble'),
        random,
        naturalSource: usedNatural ? '命中骰' : '独立天然骰',
        scope: { ...scope },
        variables: Object.fromEntries([...new Set([
            ...compileCached(formula).variables,
            ...(rs.hitMode === 'dice' ? compileCached(rs.hitTargetFormula).variables : []),
            ...compileCached(rs.critFormula).variables,
            ...compileCached(rs.fumbleFormula).variables,
        ])].map((key) => [key, toNumber(scope[key]) ?? 0])),
        override,
        specialRule,
        critFormula: rs.critFormula,
        fumbleFormula: rs.fumbleFormula,
        notes,
        actorId: attacker?.id,
        actorName: attacker?.name ?? '',
        actorSide: attacker?.side ?? '',
        targetId: defender?.id,
        targetName: defender?.name ?? '',
        targetSide: defender?.side ?? '',
        skillName: skill?.name ?? '',
        expression: (rs.hitMode === 'chance'
            ? `掷出 ${total * 100}% < 命中率 ${target * 100}%`
            : `${rs.hitFormula} = ${total} ｜ 目标 ${rs.hitTargetFormula} = ${target}`) + (specialRule ? ` ｜ ${specialRule}` : ''),
    };
}

/** 从公式里嗅探命中骰面：`d20 + ...` → 20；`d100` → 100。 */
function sniffHitDie(formula) {
    const m = String(formula ?? '').match(/\b(\d*)d(\d+)\b/i);
    if (!m) return 0;
    return Number(m[2]) || 0;
}

// ---------------------------------------------------------------------------
// 伤害结算
// ---------------------------------------------------------------------------

/**
 * 结算伤害。
 * @param {Rng} rng
 * @param {object} attacker
 * @param {object} defender
 * @param {object} skill
 * @param {object} hit 来自 rollHit 的结果
 * @param {object} ruleset
 * @param {number} [powerOverride] 可选原始威力（仍按 powerMode 解释）
 * @param {number} [targetCount] 群攻实际覆盖数量；先还原威力、算伤害，再衰减一次
 * @returns {object}
 */
export function rollDamage(rng, attacker, defender, skill, hit, ruleset, powerOverride, targetCount = 1) {
    const rs = normalizeRuleset(ruleset);
    const evaluator = new RulesetEvaluator(rs, rng);

    // 1. power 口径还原
    const resolved = resolvePower(
        powerOverride ?? skill?.power,
        rs.powerMode,
        attacker,
        'damage',
        effectiveStats(attacker),
    );

    const isCrit = hit.outcome === OUTCOME.CRIT;
    const critMult = isCrit ? rs.critMultiplier : 1;

    // 2. 按规则集的伤害公式算
    const scope = buildScope({
        attacker,
        defender,
        skill,
        resolvedPower: resolved.value,
        nat: hit.nat,
    });
    scope.crit = isCrit ? 1 : 0;
    scope.critMult = critMult;
    scope.CritMultiplier = critMult;

    let damage = evaluator.damage(scope);

    // 3. 未命中 / 大失败：伤害一律归零。
    //    注意这里是无条件归零 —— 即使规则集的伤害公式里用了 `nat` 自己处理了未命中的情况，
    //    也会被这一步覆盖。如果某个体系需要「未命中也有擦伤」，正确做法是把它写进
    //    damageFormula（用 `nat` 判断）并把下限调好，而不是指望这里放行。
    if (hit.outcome === OUTCOME.MISS || hit.outcome === OUTCOME.FUMBLE) {
        damage = 0;
    }

    damage = Math.floor(damage);
    if (damage < rs.minDamage && hit.outcome !== OUTCOME.MISS && hit.outcome !== OUTCOME.FUMBLE) {
        damage = rs.minDamage;
    }
    damage = Math.max(0, damage);
    // 只衰减真正的伤害，不先缩小百分比威力，也不让附带控制/骰点减值跟着缩小。
    const aoeFalloff = damageFalloff(damage, targetCount, rs);
    damage = aoeFalloff.to;

    const powerLabel = resolved.applied ? `${resolved.base} × ${toNumber(powerOverride ?? skill?.power) || 0}%` : '';

    return {
        power: resolved.value,
        powerRaw: toNumber(powerOverride ?? skill?.power) || 0,
        powerBase: resolved.base,
        critMultiplier: critMult,
        isCrit,
        damage,
        ...(targetCount > 1 ? { aoeFalloff } : {}),
        formula: rs.damageFormula,
        scope: { ...scope },
        statSources: { attacker: statSourceTrace(attacker), defender: statSourceTrace(defender) },
        calculation:
            `${rs.damageFormula} → ${damage}` +
            (powerLabel ? `（威力口径：${powerLabel} = ${Math.round(resolved.value)}）` : '') +
            (isCrit ? `（暴击 ×${critMult}）` : ''),
    };
}

/**
 * 求一个非伤害效果的最终数值。
 * @param {Rng} rng
 * @param {object} attacker
 * @param {object} defender
 * @param {object} skill
 * @param {string} effectType
 * @param {number} rawPower
 * @param {object} ruleset
 * @param {number} [targetCount] 仅 dot 使用群攻衰减，其余状态数值与修正保持原值
 * @returns {object}
 */
export function rollEffectValue(rng, attacker, defender, skill, effectType, rawPower, ruleset, targetCount = 1) {
    const rs = normalizeRuleset(ruleset);
    const evaluator = new RulesetEvaluator(rs, rng);
    const resolved = resolvePower(rawPower, rs.powerMode, attacker, effectType, effectiveStats(attacker));
    const scope = buildScope({ attacker, defender, skill, resolvedPower: resolved.value });
    const { value, formula } = evaluator.effectValue(effectType, scope, resolved.value);
    const aoeFalloff = damageFalloff(Math.floor(value), effectType === 'dot' ? targetCount : 1, rs);
    return {
        value: aoeFalloff.to,
        formula,
        powerBase: resolved.applied ? `${resolved.base} × ${rawPower}%` : '',
        ...(effectType === 'dot' && targetCount > 1 ? { aoeFalloff } : {}),
    };
}

// ---------------------------------------------------------------------------
// 数值应用
// ---------------------------------------------------------------------------

/**
 * 把伤害打到目标身上：先扣护盾，再扣 HP。
 * @param {object} target
 * @param {number} damage
 * @param {object} [ruleset]
 * @returns {{absorbed: number, hpLost: number, remaining: number, shieldBroken: string[]}}
 */
export function applyDamage(target, damage, ruleset, mode = COMBAT_MODE.DEADLY) {
    if (target?.mercyWithdrawn) return { absorbed: 0, hpLost: 0, remaining: 0, shieldBroken: [] };
    const rs = normalizeRuleset(ruleset);
    let left = Math.max(0, Math.floor(damage));
    let absorbed = 0;
    /** @type {string[]} */
    const shieldBroken = [];

    for (const status of target.statuses ?? []) {
        if (left <= 0) break;
        if (status.type !== 'shield') continue;
        const capacity = (toNumber(status.power) || 0) * (status.stacks || 1);
        if (capacity <= 0) continue;
        const used = Math.min(capacity, left);
        absorbed += used;
        left -= used;
        const remaining = capacity - used;
        if (remaining <= 0) {
            shieldBroken.push(status.name);
            status.power = 0;
            status.duration = 0;
        } else {
            status.power = remaining / (status.stacks || 1);
        }
    }

    target.statuses = (target.statuses ?? []).filter(
        (/** @type {any} */ s) => !(s.type === 'shield' && (toNumber(s.power) || 0) <= 0),
    );

    const pool = target.attributes?.HP;
    let hpLost = 0;
    if (pool && left > 0) {
        hpLost = Math.min(pool.current, left);
        pool.current = Math.max(0, pool.current - left);
        if (pool.current <= 0) {
            target.alive = false;
            // 切磋里倒下的人是**力竭**，不是死了 —— 用 incapacitated 记下来，
            // 让日志、结算、UI 都能用对措辞。
            // 生死搏杀里倒下就是阵亡，不标这个（标了反而会让界面写「力竭」）。
            target.incapacitated = mode !== COMBAT_MODE.DEADLY;
        }
    }
    void rs;

    return { absorbed, hpLost, remaining: left - hpLost, shieldBroken };
}

/**
 * 治疗 / 回蓝。
 * @param {object} target
 * @param {string} key 'HP' | 'MP'
 * @param {number} amount
 * @returns {{healed: number, before: number, after: number}}
 */
export function applyHeal(target, key, amount) {
    const canonical = canonicalAttributeKey(key);
    const pool = target.attributes?.[canonical];
    if (!pool) return { healed: 0, before: 0, after: 0 };
    const before = pool.current;
    if (target.mercyWithdrawn) return { healed: 0, before, after: before };
    pool.current = Math.min(pool.max, pool.current + Math.max(0, Math.floor(amount)));
    if (canonical === 'HP' && pool.current > 0) target.alive = true;
    return { healed: pool.current - before, before, after: pool.current };
}

/**
 * 扣蓝。
 * @param {object} unit
 * @param {number} cost
 * @returns {{ok: boolean, paid: number, before: number, after: number}}
 */
export function spendMp(unit, cost) {
    const pool = unit.attributes?.MP;
    const need = Math.max(0, Math.floor(toNumber(cost) || 0));
    if (!pool) return { ok: true, paid: 0, before: 0, after: 0 };
    const before = pool.current;
    if (before < need) return { ok: false, paid: 0, before, after: before };
    pool.current = before - need;
    return { ok: true, paid: need, before, after: pool.current };
}

// ---------------------------------------------------------------------------
// 技能可用性
// ---------------------------------------------------------------------------

/**
 * 判断技能当前能否使用。
 * @param {object} unit
 * @param {object} skill
 * @returns {{usable: boolean, reason: string}}
 */
export function canUseSkill(unit, skill) {
    // 措辞保持中性：这个函数拿不到战斗模式，而「力竭 / 阵亡」要靠模式决定。
    // 具体用哪个词由调用方（UI 与日志）按 combatMode 显示。
    if (!unit?.alive) return { usable: false, reason: unit?.incapacitated ? '已失去战斗力' : '已阵亡' };
    if (!skill) return { usable: false, reason: '技能不存在' };
    if ((skill.cooldownLeft ?? 0) > 0) return { usable: false, reason: `冷却中（剩 ${skill.cooldownLeft} 回合）` };
    const pool = unit.attributes?.MP;
    if (pool && (skill.cost ?? 0) > pool.current) {
        return { usable: false, reason: `资源不足（需 ${skill.cost}，余 ${pool.current}）` };
    }
    const blocked = controlledBy(unit);
    if (blocked) return { usable: false, reason: `被「${blocked}」控制` };
    return { usable: true, reason: '' };
}

/**
 * 单位是否被控制到无法行动。
 * @param {object} unit
 * @returns {string} 控制状态名，没有则为空串
 */
export function controlledBy(unit) {
    const blocked = (unit?.statuses ?? []).find(
        (status) => isControlStatus(status) && (status.duration ?? 0) > 0 && status._controlSaved !== true,
    );
    return blocked ? blocked.name : '';
}

/** 显式 control 不依赖名字；仅没有明确 modifiers 的旧减益保留名称兼容。 */
function isControlStatus(status) {
    return status.type === 'control' || (
        status.type === 'debuff' && !Array.isArray(status.modifiers) &&
        /眩晕|封印|沉默|定身|束缚|麻痹|冰冻|石化|昏迷/.test(status.name)
    );
}

const HOSTILE_EFFECTS = new Set(['damage', 'control', 'dot', 'debuff', 'taunt']);

function hasHostileEffect(skill) {
    return (skill?.effects ?? []).some((effect) => HOSTILE_EFFECTS.has(effect.type));
}

// ---------------------------------------------------------------------------
// 群攻衰减
// ---------------------------------------------------------------------------

/**
 * 按目标数量衰减技能威力。
 * @param {number} power
 * @param {number} targetCount
 * @param {object} ruleset
 * @returns {number}
 */
export function aoeEffectivePower(power, targetCount, ruleset) {
    return damageFalloff(power, targetCount, ruleset).to;
}

/** 单次伤害的衰减记录。保留零值，避免无伤害效果凭空变成 1 点。 */
function damageFalloff(value, targetCount, ruleset) {
    const rs = normalizeRuleset(ruleset);
    const targets = Math.max(1, targetCount);
    const factor = targets === 1 || rs.aoeFalloff === 'none'
        ? 1
        : Math.max(rs.aoeFalloffFloor, rs.aoeFalloff === 'linear' ? 1 / targets : 1 / Math.sqrt(targets));
    const from = Math.max(0, toNumber(value) ?? 0);
    const to = factor === 1 || from === 0 ? from : Math.max(1, Math.round(from * factor));
    return { from, to, factor, targets };
}

// ---------------------------------------------------------------------------
// 状态效果结算
// ---------------------------------------------------------------------------

/**
 * 每个控制/DoT 在受影响单位的回合开始时独立掷一次真正的 d20。
 * success/outcome 指「受影响者抵抗成功」，不是施法者命中；天然 1 失败、20 成功。
 * 判定与 HP 结算只在这里发生，展示与快照恢复读取 trace，不再消费 RNG。
 */
export function rollStatusSave(rng, unit, status, checkKind) {
    const stats = effectiveStats(unit);
    const modifiers = stats.parts.filter((part) => part.attr === 'hit')
        .map((part) => ({ source: part.source, value: part.delta }));
    const target = Math.min(30, Math.max(2, toNumber(status.saveDc) ?? 10));
    const nat = rng.int(1, 20);
    const total = nat + stats.hit;
    const success = nat === 20 || (nat !== 1 && total >= target);
    const specialRule = nat === 20 ? '天然 20：抵抗必定成功' : nat === 1 ? '天然 1：抵抗必定失败' : '';
    const signed = stats.hit < 0 ? `- ${Math.abs(stats.hit)}` : `+ ${stats.hit}`;
    return {
        checkKind,
        actorId: unit.id,
        actorName: unit.name,
        actorSide: unit.side,
        targetId: status.id,
        targetName: status.name,
        skillName: status.name,
        nat,
        dieFaces: 20,
        total,
        target,
        saveDc: target,
        hitMode: 'dice',
        comparison: '>=',
        formula: 'd20 + hitBonus',
        targetFormula: 'saveDc',
        modifiers,
        targetModifiers: [{ source: '抵抗难度', value: target }],
        dice: [{ count: 1, faces: 20, rolls: [nat], total: nat, stage: checkKind }],
        targetDice: [],
        specialDice: [],
        random: [],
        naturalSource: '状态抵抗骰',
        variables: { hitBonus: stats.hit, saveDc: target },
        scope: { hitBonus: stats.hit, saveDc: target, nat },
        baseOutcome: total >= target ? OUTCOME.HIT : OUTCOME.MISS,
        outcome: success ? OUTCOME.HIT : OUTCOME.MISS,
        override: nat === 20 ? OUTCOME.CRIT : nat === 1 ? OUTCOME.FUMBLE : null,
        success,
        saved: success,
        specialRule,
        expression: `d20(${nat}) ${signed} = ${total}，对抗 DC ${target}${specialRule ? `；${specialRule}` : ''}`,
    };
}

/**
 * 回合开始：控制判定失败跳过整个行动；DoT 判定失败扣 power × stacks。
 * 无论通过还是失败都消耗一个受影响回合，但持续时间由 expireStatuses 在行动/跳过后扣减。
 * 因而 duration:1 的命中修正也会留到这一次主行动结束。
 */
export function tickStatuses(rng, unit, ruleset, mode = COMBAT_MODE.DEADLY) {
    if (unit?.mercyWithdrawn) return [];
    const events = [];
    const stats = effectiveStats(unit);
    const modifiers = stats.parts.filter((part) => part.attr === 'hit');
    if (modifiers.length) {
        const detail = modifiers.map((part) => `${part.source} ${part.delta >= 0 ? '+' : ''}${part.delta}`).join('、');
        events.push({
            type: 'modifier', value: stats.hit, modifiers, actorId: unit.id,
            text: `${unit.name} 掷骰前修正：${detail}；命中/抵抗总修正 ${stats.hit >= 0 ? '+' : ''}${stats.hit}`,
        });
    }
    for (const status of unit.statuses ?? []) delete status._controlSaved;
    // applyDamage 可移除破碎护盾，迭代开始时的数组以免漏掉后续状态。
    for (const status of [...(unit.statuses ?? [])]) {
        if (!unit.alive) break;
        if ((status.duration ?? 0) <= 0) continue;
        const checkKind = isControlStatus(status) ? 'control' : status.type === 'dot' ? 'dot' : '';
        if (checkKind) {
            const check = rollStatusSave(rng, unit, status, checkKind);
            if (checkKind === 'control') {
                status._controlSaved = check.success;
                events.push({
                    type: 'control', checkKind, check, success: check.success, skipped: !check.success,
                    name: status.name, value: 0,
                    text: `${unit.name} 对「${status.name}」的控制抵抗：${check.expression} → ${
                        check.success ? '判定通过，抵抗该控制，该控制本回合不阻止行动' : '判定失败，受控跳过整个行动'
                    }`,
                });
            } else {
                const damage = check.success ? 0 : Math.max(0, Math.floor((toNumber(status.power) ?? 0) * (status.stacks || 1)));
                const applied = damage > 0 ? applyDamage(unit, damage, ruleset, mode) : { hpLost: 0, absorbed: 0, shieldBroken: [] };
                events.push({
                    type: 'dot', checkKind, check, success: check.success,
                    name: status.name, value: applied.hpLost, damage, ...applied,
                    text: `${unit.name} 对「${status.name}」的持续伤害抵抗：${check.expression} → ${
                        check.success ? '判定通过，抵抗本次持续伤害（损失 0 点生命）'
                            : `判定失败，持续伤害 ${damage} 点，损失 ${applied.hpLost} 点生命${applied.absorbed ? `，护盾吸收 ${applied.absorbed} 点` : ''}`
                    }${!unit.alive ? `；${unit.name} ${downLabel(mode)}` : ''}`,
                });
            }
        }
        if (status.type === 'heal' && /hot|再生|回复|恢复|回春/.test(status.name) && status.power) {
            const { healed } = applyHeal(unit, 'HP', status.power);
            if (healed > 0) {
                events.push({ type: 'hot', name: status.name, value: healed, text: `${unit.name} 因「${status.name}」回复 ${healed} 点生命` });
            }
        }
    }
    return events;
}

function statusTurnEntries(unit) {
    return (unit.statuses ?? []).map((status) => ({ id: status.id, revision: status._revision ?? 0 }));
}

/**
 * 回合结束只扣开始时已有、且本行动中未刷新的状态；自身新挂的状态从下次回合计时。
 * activeStatuses 仅含 ID/版本号，可随战斗快照保存；护盾沿用消耗完才消失的旧语义。
 */
export function expireStatuses(unit, activeStatuses = statusTurnEntries(unit)) {
    const active = new Map(activeStatuses.map((status) => [status.id, status.revision]));
    const expired = new Set();
    const events = [];
    for (const status of unit.statuses ?? []) {
        delete status._controlSaved;
        if (!active.has(status.id) || active.get(status.id) !== (status._revision ?? 0)) continue;
        if ((status.duration ?? 0) > 0) status.duration -= 1;
        if ((status.duration ?? 0) <= 0 && status.type !== 'shield') {
            expired.add(status);
            events.push({ type: 'expire', name: status.name, value: 0, text: `「${status.name}」效果结束` });
        }
    }
    unit.statuses = (unit.statuses ?? []).filter((status) => !expired.has(status));
    return events;
}

/**
 * 给单位挂一个状态（同名叠加层数并刷新持续时间）。
 * @param {object} unit
 * @param {object} status
 * @returns {object} 最终生效的状态对象
 */
export function addStatus(unit, status) {
    if (!status) return status;
    if (!Array.isArray(unit.statuses)) unit.statuses = [];
    // 一个技能可以同时附带 control/dot/debuff，不能因为同名把它们吞成单一状态。
    const existing = unit.statuses.find((s) => s.name === status.name && s.type === status.type);
    if (existing) {
        existing.stacks = (existing.stacks || 1) + (status.stacks || 1);
        existing.duration = Math.max(existing.duration || 0, status.duration || 0);
        if (status.power) existing.power = Math.max(existing.power || 0, status.power);
        if (status.saveDc !== undefined) existing.saveDc = status.saveDc;
        if (Array.isArray(status.modifiers)) existing.modifiers = deepClone(status.modifiers);
        existing._revision = (existing._revision ?? 0) + 1;
        return existing;
    }
    unit.statuses.push(status);
    return status;
}

// ---------------------------------------------------------------------------
// 战斗状态机
// ---------------------------------------------------------------------------

/**
 * 一场战斗。
 *
 * 生命周期：
 *   new Battle(powerSystem, {ruleset, seed}) → start() → 循环 { currentUnit, act() } → 结束
 *
 * `battle.toState()` 的结果可以直接 JSON 序列化存进 chatMetadata。
 */
export class Battle {
    /**
     * @param {object} powerSystem 已归一化的战力体系
     * @param {{seed?: string|number, ruleset?: object, name?: string, includeNeutral?: boolean, skillList?: any[]}} [opts]
     */
    constructor(powerSystem, opts = {}) {
        this.id = `battle_${Date.now().toString(36)}`;
        this.name = toText(opts.name) || '未命名战斗';
        this.seed = opts.seed ?? new Rng().seed;
        this.rng = new Rng(this.seed);
        /** 战斗模式：切磋（spar）还是生死搏杀（deadly）。血尽时措辞不同。 */
        this.combatMode = opts.combatMode === COMBAT_MODE.SPAR ? COMBAT_MODE.SPAR : COMBAT_MODE.DEADLY;
        this.ruleset = normalizeRuleset(opts.ruleset);
        this.evaluator = new RulesetEvaluator(this.ruleset, this.rng);

        const includeNeutral = Boolean(opts.includeNeutral);
        this.units = (powerSystem?.combatants ?? [])
            .filter((/** @type {any} */ u) => u.side !== SIDE.NEUTRAL || includeNeutral)
            .map((/** @type {any} */ u) => normalizeCombatant(deepClone(u), { side: u.side }))
            .filter(Boolean);

        /** @type {Array<object>} */
        this.initiative = [];
        this.round = 0;
        this.turnIndex = 0;
        this.phase = PHASE.IDLE;
        /** 已完成开始判定的行动及其状态版本；快照恢复不能重复掷骰。 */
        this._activeTurn = null;
        /** @type {Array<object>} */
        this.log = [];
        /** 口嗨独立存储便于选择是否附带；战斗记录视图合并显示。 @type {Array<object>} */
        this.banterHistory = [];
        /** 按说服者和目标保存累计进展、待确认条件及已完成检定。 */
        this.persuasion = [];
        this.winner = /** @type {string|null} */ (null);
    }

    /** 参战单位快照（深拷贝，UI 用，避免 UI 误改内部状态）。 */
    get unitsSnapshot() {
        return deepClone(this.units);
    }

    /** 导出可持久化状态。 */
    toState() {
        const { rng, evaluator, ...rest } = this;
        void evaluator;
        return { ...deepClone(rest), rngSnapshot: rng.snapshot() };
    }

    /** 从持久化状态恢复一场战斗。 */
    static fromState(state) {
        const battle = Object.create(Battle.prototype);
        Object.assign(battle, deepClone(state));
        if (!Array.isArray(battle.persuasion)) battle.persuasion = [];
        // 兼容旧存档：对话迁出战斗日志，保留其内容和先后顺序。
        const log = Array.isArray(battle.log) ? battle.log : [];
        const history = Array.isArray(battle.banterHistory) ? battle.banterHistory : [];
        battle.banterHistory = [...history, ...log.filter(entry => entry.type === 'banter')]
            .sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
            .map((entry, i) => ({ ...entry, i }));
        battle.log = log.filter(entry => entry.type !== 'banter').map((entry, i) => ({ ...entry, i }));
        battle.rng = Rng.fromSnapshot(state.rngSnapshot ?? { seed: state.seed });
        battle.ruleset = normalizeRuleset(state.ruleset);
        battle.evaluator = new RulesetEvaluator(battle.ruleset, battle.rng);
        // 旧快照没有回合凭据：等待输入意味着开始结算已完成，不能重新掷状态骰。
        if (!Object.hasOwn(battle, '_activeTurn')) {
            const unit = battle.currentUnit;
            battle._activeTurn = unit && battle.phase === PHASE.AWAITING_INPUT
                ? { unitId: unit.id, round: battle.round, turnIndex: battle.turnIndex, statuses: statusTurnEntries(unit) }
                : null;
            if (battle._activeTurn) {
                for (const status of unit.statuses ?? []) {
                    if (isControlStatus(status)) status._controlSaved = true;
                }
            }
        }
        return battle;
    }

    /**
     * 写日志。
     * @param {string} type system/attack/heal/status/turn/end/roll
     * @param {string} text 人话描述
     * @param {object} [data] 结构化明细（骰点等），UI 可展开查看
     */
    pushLog(type, text, data) {
        // 兼容旧调用方，禁止将口嗨混回战斗日志。
        if (type === 'banter') return this.pushBanter(text, data);
        this.log.push({
            i: this.log.length,
            round: this.round,
            type,
            text,
            data: data ? deepClone(data) : undefined,
            at: Date.now(),
        });
    }

    /** 记录口嗨对话，供口嗨区域与模型上下文使用。 */
    pushBanter(text, data) {
        this.banterHistory.push({
            i: this.banterHistory.length,
            round: this.round,
            type: 'banter',
            text,
            data: data ? deepClone(data) : undefined,
            at: Date.now(),
        });
    }

    /**
     * 开战。
     * @returns {{ok: boolean, error?: string}}
     */
    start() {
        const allies = this.units.filter((u) => u.side === SIDE.ALLY && u.alive);
        const enemies = this.units.filter((u) => u.side === SIDE.ENEMY && u.alive);
        if (!allies.length) return { ok: false, error: '没有我方单位' };
        if (!enemies.length) return { ok: false, error: '没有敌方单位' };

        const { order } = rollInitiative(this.rng, this.units, this.ruleset);
        this.initiative = order;
        this.round = 1;
        this.turnIndex = 0;
        this.phase = PHASE.AWAITING_INPUT;

        this.pushLog('system', `⚔️ 战斗开始：${this.name}`, {
            seed: this.seed,
            unitCount: this.units.length,
            ruleset: this.ruleset.name,
        });
        this.pushLog('roll', `先攻顺序：${order.map((e) => `${e.name}(${e.roll}+${e.bonus}=${e.total})`).join(' → ')}`, {
            initiative: order,
        });

        this._beginTurn();
        return { ok: true };
    }

    /** 当前行动单位。 */
    get currentUnit() {
        const entry = this.initiative[this.turnIndex];
        if (!entry) return null;
        return this.units.find((u) => u.id === entry.unitId) ?? null;
    }

    /** 连续的死亡/受控单位使用迭代推进，避免递归堆栈增长。 */
    _beginTurn() {
        while (this.phase !== PHASE.FINISHED) {
            const unit = this.currentUnit;
            if (!unit) {
                this._endBattle();
                return;
            }
            if (this._activeTurn?.unitId === unit.id && this._activeTurn.round === this.round &&
                this._activeTurn.turnIndex === this.turnIndex) return;
            if (this._checkEnd()) return;
            if (!unit.alive) {
                this._moveTurnIndex();
                continue;
            }
            this._activeTurn = { unitId: unit.id, round: this.round, turnIndex: this.turnIndex, statuses: statusTurnEntries(unit) };
            this.pushLog('turn', `—— 第 ${this.round} 回合 · ${unit.name} 行动 ——`);
            const events = tickStatuses(this.rng, unit, this.ruleset, this.combatMode);
            for (const event of events) this.pushLog('status', event.text, event);

            if (unit.alive) {
                for (const skill of unit.skills ?? []) {
                    if ((skill.cooldownLeft ?? 0) > 0) skill.cooldownLeft -= 1;
                }
            }
            const control = unit.alive ? controlledBy(unit) : '';
            if (!unit.alive || control) {
                if (!unit.alive) {
                    this.pushLog('system', `${unit.name} 因持续伤害${downLabel(this.combatMode)}`);
                } else {
                    this.pushLog('status', `${unit.name} 被「${control}」控制，本回合无法行动`);
                }
                this._finishTurn();
                if (this._checkEnd()) return;
                this._moveTurnIndex();
                continue;
            }
            this.phase = PHASE.AWAITING_INPUT;
            return;
        }
    }

    /** 开始时存在的状态在主行动、主动跳过、受控跳过后各扣一次。 */
    _finishTurn() {
        if (!this._activeTurn) return;
        const unit = this.units.find((entry) => entry.id === this._activeTurn.unitId);
        if (unit) {
            for (const event of expireStatuses(unit, this._activeTurn.statuses)) this.pushLog('status', event.text, event);
        }
        this._activeTurn = null;
    }

    _moveTurnIndex() {
        this.turnIndex += 1;
        if (this.turnIndex >= this.initiative.length) {
            this.turnIndex = 0;
            this.round += 1;
            this.pushLog('system', `======== 第 ${this.round} 回合 ========`);
        }
    }

    /** 推进到下一个行动者，必要时开新回合。 */
    _advanceTurn() {
        this._finishTurn();
        if (this._checkEnd()) return;
        this._moveTurnIndex();
        this._beginTurn();
    }

    /**
     * 检查胜负。
     * @returns {boolean} 战斗是否已结束
     */
    _checkEnd() {
        const alliesAlive = this.units.filter((u) => u.side === SIDE.ALLY && u.alive).length;
        const enemiesAlive = this.units.filter((u) => u.side === SIDE.ENEMY && u.alive).length;
        if (enemiesAlive === 0 && alliesAlive === 0) {
            this.winner = 'draw';
            this._endBattle();
            return true;
        }
        if (!enemiesAlive) {
            this.winner = SIDE.ALLY;
            this._endBattle();
            return true;
        }
        if (!alliesAlive) {
            this.winner = SIDE.ENEMY;
            this._endBattle();
            return true;
        }
        return false;
    }

    /** 收尾。 */
    _endBattle() {
        this.phase = PHASE.FINISHED;
        if (this.winner) {
            // 切磋用「胜 / 负」，生死用「胜 / 败北」——
            // 「败北」配上「力竭」会显得自相矛盾（人又没死，何来败北）。
            const spar = this.combatMode !== COMBAT_MODE.DEADLY;
            const label =
                this.winner === SIDE.ALLY
                    ? '我方胜利'
                    : this.winner === SIDE.ENEMY
                      ? spar
                          ? '我方落败'
                          : '我方败北'
                      : '两败俱伤';
            this.pushLog('end', `🏁 战斗结束：${label}（共 ${this.round} 回合）`, { winner: this.winner });
        }
    }

    /**
     * 所有合法目标（单体也返回完整候选）。只读、不掷骰，UI/预览/行动校验均可安全调用。
     * group 指对应阵营全体，all 沿用全场所有存活单位的语义；友方治疗候选包括自身。
     */
    targetCandidates(unit, skill) {
        if (!unit?.alive) return [];
        const target = skill?.target ?? 'single';
        if (target === 'self') return [unit];
        if (target === 'all') return this.units.filter((entry) => entry.alive);
        const hostile = hasHostileEffect(skill);
        return this.units.filter((entry) => entry.alive && (hostile
            ? entry.id !== unit.id && entry.side !== SIDE.NEUTRAL && (unit.side === SIDE.NEUTRAL || entry.side !== unit.side)
            : entry.side === unit.side || entry.side === SIDE.NEUTRAL));
    }

    /** 选实际目标；单体未指定时使用战术兜底，同分按可重放 RNG 抽签而非锁定首位。 */
    resolveTargets(unit, skill) {
        const candidates = this.targetCandidates(unit, skill);
        if (skill?.target === 'group' || skill?.target === 'all' || skill?.target === 'self') return candidates;
        if (skill?.target === 'random') return candidates.length ? [candidates[this.rng.int(0, candidates.length - 1)]] : [];
        const target = chooseFallbackTarget(this, unit, skill);
        return target ? [target] : [];
    }

    /** 在支付资源、冷却、掷骰和推进之前校验；显式错误绝不悄悄改成首个目标。 */
    _targetError(unit, skill, targetIds) {
        const candidates = this.targetCandidates(unit, skill);
        if (!candidates.length) return '没有可用目标';
        if (targetIds === undefined) return '';
        if (!Array.isArray(targetIds) || !targetIds.length) return '请选择有效目标';
        if (targetIds.some((id) => !candidates.some((entry) => entry.id === id))) return '所选目标无效、已倒下或不是该技能的合法目标';
        if ((skill?.target ?? 'single') === 'single' && targetIds.length !== 1) return '单体技能只能选择一个目标';
        return '';
    }

    /** Possible immediate lethal hits only; never consumes the battle RNG or mutates units. */
    lethalCandidates(action = {}) {
        const unit = this.currentUnit;
        if (this.combatMode !== COMBAT_MODE.DEADLY || !unit?.alive || unit.side !== SIDE.ALLY
            || (action.unitId && action.unitId !== unit.id) || ['skip', 'defend'].includes(action.action)) return [];
        const skill = (unit.skills ?? []).find(s => s.id === action.skillId || s.name === action.skillId);
        const move = skill ?? normalizeSkill({ id: 'basic_attack', name: '普通攻击', target: 'single',
            power: this.ruleset.powerMode === POWER_MODE.ABSOLUTE ? effectiveStats(unit).Atk : 100,
            aim: 100, cost: 0, effects: [{ type: 'damage', power: 0, duration: 0 }] });
        if (!canUseSkill(unit, move).usable || this._targetError(unit, move, action.targetIds)
            || !(move.effects ?? []).some(e => e.type === 'damage')) return [];
        let targets = this.targetCandidates(unit, move);
        if ((move.target ?? 'single') === 'single' && action.targetIds) targets = targets.filter(t => action.targetIds.includes(t.id));
        const count = ['group', 'all'].includes(move.target) ? targets.length : 1;
        if (!unit.isUser && this.units.filter(u => u.side === SIDE.ALLY && u.alive && u.isUser).length !== 1) return [];
        const result = [];
        for (const target of targets.filter(t => t.side === SIDE.ENEMY && !t.mercyWithdrawn)) {
            const queue = [[]];
            let attempts = 0, possibleDamage = 0, uncertain = false;
            while (queue.length && attempts++ < 2048) {
                const path = queue.pop();
                let cursor = 0, branch = null;
                const rng = new Rng(0);
                rng.int = (lo, hi) => {
                    const low = Math.ceil(Math.min(lo, hi)), high = Math.floor(Math.max(lo, hi));
                    lo = low; hi = high;
                    const index = cursor++;
                    if (index < path.length) return path[index];
                    if (!branch) branch = { lo, hi };
                    return lo;
                };
                // Continuous custom rand/chance cannot be exhaustively bounded: conservatively prompt.
                rng.next = () => { uncertain = true; return 0; };
                const hit = rollHit(rng, unit, target, move, this.ruleset);
                const damage = rollDamage(rng, unit, target, move, hit, this.ruleset, undefined, count);
                if (branch) {
                    if (branch.hi - branch.lo > 200 || queue.length + branch.hi - branch.lo > 4096) { uncertain = true; break; }
                    for (let value = branch.lo; value <= branch.hi; value++) queue.push([...path, value]);
                } else {
                    const copy = deepClone(target);
                    possibleDamage = Math.max(possibleDamage, applyDamage(copy, damage.damage, this.ruleset, this.combatMode).hpLost);
                    if (!copy.alive) break;
                }
            }
            if (queue.length && attempts >= 2048) uncertain = true;
            if (uncertain || possibleDamage >= target.attributes.HP.current) result.push({ ...deepClone(target), possibleDamage, uncertain });
        }
        return result;
    }

    /**
     * 执行一次行动。引擎唯一的输入口。
     * @param {{unitId?: string, skillId?: string, targetIds?: string[], action?: string}} action
     * @returns {{ok: boolean, error?: string, lines: string[]}}
     */
    act(action) {
        if (this.phase === PHASE.FINISHED) return { ok: false, error: '战斗已结束', lines: [] };
        const unit = this.currentUnit;
        if (!unit) return { ok: false, error: '当前没有行动单位', lines: [] };
        if (action?.unitId && action.unitId !== unit.id) return { ok: false, error: '还未轮到该单位行动', lines: [] };

        if (action?.action === 'skip' || action?.action === 'defend') {
            const label = action.action === 'defend' ? '进入防御姿态' : '跳过回合';
            // 防御姿态：新挂的增益保留到下一个自身回合结束。
            if (action.action === 'defend') {
                addStatus(unit, normalizeStatus({ name: '防御姿态', type: 'buff', duration: 1, power: 0, description: '防御' }));
            }
            this.pushLog('turn', `${unit.name} ${label}`);
            this._advanceTurn();
            return { ok: true, lines: [`${unit.name} ${label}`] };
        }

        const skill =
            (unit.skills ?? []).find((s) => s.id === action?.skillId) ??
            (unit.skills ?? []).find((s) => s.name === action?.skillId) ??
            null;

        // 普通攻击与技能完全共用目标选择和前置校验。
        const move = skill ?? normalizeSkill({
            id: 'basic_attack', name: '普通攻击', target: 'single',
            power: this.ruleset.powerMode === POWER_MODE.ABSOLUTE ? effectiveStats(unit).Atk : 100,
            aim: 100, cost: 0,
            effects: [{ type: 'damage', power: 0, duration: 0 }],
            tags: ['单体'],
        });
        const usable = canUseSkill(unit, move);
        if (!usable.usable) return { ok: false, error: usable.reason, lines: [] };
        const targetError = this._targetError(unit, move, action?.targetIds);
        if (targetError) return { ok: false, error: targetError, lines: [] };

        const paid = spendMp(unit, move.cost);
        if (!paid.ok) return { ok: false, error: '资源不足', lines: [] };
        this.phase = PHASE.RESOLVING;
        if (skill?.cooldown) skill.cooldownLeft = skill.cooldown + 1;
        if (paid.paid > 0) {
            this.pushLog('system', `${unit.name} 消耗 ${paid.paid} 点资源`, { resource: paid });
        }
        const lines = this._resolveSkill(unit, move, action?.targetIds, action);
        this._advanceTurn();
        return { ok: true, lines };
    }

    /**
     * 结算一个技能的完整效果。
     * @param {object} unit
     * @param {object} skill
     * @param {string[]} [targetIds]
     * @returns {string[]} 日志行
     */
    _resolveSkill(unit, skill, targetIds, action = {}) {
        /** @type {string[]} */
        const lines = [];

        const targetError = this._targetError(unit, skill, targetIds);
        if (targetError) return [`${unit.name} 的「${skill.name}」：${targetError}`];
        const targets = (skill.target ?? 'single') === 'single' && targetIds !== undefined
            ? this.targetCandidates(unit, skill).filter((target) => target.id === targetIds[0])
            : this.resolveTargets(unit, skill);
        const hasDamage = (skill.effects ?? []).some((effect) => effect.type === 'damage');
        const hostile = hasHostileEffect(skill);
        const targetCount = skill.target === 'group' || skill.target === 'all' ? targets.length : 1;
        const logFalloff = (resolved, target, effectType) => {
            if (!resolved.aoeFalloff) return;
            const falloff = { ...resolved.aoeFalloff, effectType, targetId: target.id };
            const label = effectType === 'dot' ? '每次持续伤害' : '伤害';
            this.pushLog('system', `${unit.name} 的「${skill.name}」覆盖 ${falloff.targets} 个目标，${target.name} 的${label} ${falloff.from} → ${falloff.to}（群攻系数 ×${Number(falloff.factor.toFixed(4))}）`, { aoeFalloff: falloff });
        };

        for (const target of targets) {
            if (!target.alive) continue;
            // 每个目标只命中判定一次；伤害与所有负面状态共享该结果。
            const hit = hostile ? rollHit(this.rng, unit, target, skill, this.ruleset) : null;
            const landed = !hit || hit.outcome === OUTCOME.HIT || hit.outcome === OUTCOME.CRIT;
            if (hit) {
                const dmg = hasDamage ? rollDamage(this.rng, unit, target, skill, hit, this.ruleset, undefined, targetCount) : null;
                if (dmg) logFalloff(dmg, target, 'damage');

                const outcomeLabel =
                    hit.outcome === OUTCOME.CRIT
                        ? '💥 暴击'
                        : hit.outcome === OUTCOME.HIT
                          ? '命中'
                          : hit.outcome === OUTCOME.FUMBLE
                            ? '💀 大失败'
                            : '未命中';

                const line = `${unit.name} 用「${skill.name}」${hasDamage ? '攻击' : '影响'} ${target.name}：${hit.expression} → ${outcomeLabel}${
                    landed && dmg ? `，伤害 ${dmg.damage}` : ''
                }`;
                lines.push(line);
                this.pushLog('attack', line, {
                    hit,
                    damage: dmg,
                    targetId: target.id,
                    skillName: skill.name,
                });

                if (landed && dmg) {
                    let spared = false;
                    const players = this.units.filter(u => u.side === SIDE.ALLY && u.alive && u.isUser);
                    const player = unit.isUser ? unit : players.length === 1 ? players[0] : null;
                    const mercy = unit.isUser && Array.isArray(action.mercyTargetIds) && action.mercyTargetIds.includes(target.id);
                    const intercept = !unit.isUser && player && Array.isArray(action.interceptTargetIds) && action.interceptTargetIds.includes(target.id);
                    const projected = deepClone(target);
                    applyDamage(projected, dmg.damage, this.ruleset, this.combatMode);
                    if (this.combatMode === COMBAT_MODE.DEADLY && unit.side === SIDE.ALLY && target.side === SIDE.ENEMY
                        && !projected.alive && (mercy || intercept)) {
                        const nat = intercept ? this.rng.d20() : null;
                        const bonus = intercept ? effectiveStats(player).hit : 0;
                        const success = mercy || nat === 20 || (nat !== 1 && nat + bonus >= 10);
                        const reason = mercy ? '玩家主动留手' : success ? '玩家成功阻止队友致命攻击' : '玩家阻止队友失败';
                        const text = intercept ? `${player.name} 尝试阻止 ${unit.name} 杀死 ${target.name}：d20 ${nat} + ${bonus} = ${nat + bonus} 对抗 DC10，${success ? '成功，保留1点生命并安全退出战斗观战' : '失败，按原致命伤害结算'}`
                            : `${unit.name} 对 ${target.name} 留手，保留1点生命并退出战斗观战`;
                        lines.push(text);
                        this.pushLog('mercy', text, { success, reason, actorId: unit.id, userId: player?.id,
                            targetId: target.id, nat, bonus, total: nat === null ? null : nat + bonus, dc: intercept ? 10 : null });
                        spared = success;
                    }
                    const applied = applyDamage(target, dmg.damage, this.ruleset, this.combatMode);
                    if (spared) {
                        target.attributes.HP.current = 1;
                        applied.hpLost = Math.max(0, applied.hpLost - 1);
                        target.alive = false;
                        target.incapacitated = true;
                        target.mercyWithdrawn = true;
                        target.mercyOriginalSide = target.side;
                        target.side = SIDE.NEUTRAL;
                        target.mercy = { originalSide: target.mercyOriginalSide, actorId: unit.id, userId: player?.id,
                            reason: mercy ? '玩家主动留手' : '玩家成功阻止队友致命攻击' };
                        target.statuses = [];
                        lines.push(`${target.name} 保留1点生命，安全退出战斗进入观战席`);
                    }
                    if (applied.absorbed > 0) {
                        const t = `${target.name} 的护盾吸收 ${applied.absorbed} 点伤害${
                            applied.shieldBroken.length ? `，「${applied.shieldBroken.join('、')}」破碎` : ''
                        }`;
                        lines.push(t);
                        this.pushLog('status', t, applied);
                    }
                    const hpText = `${target.name} 损失 ${applied.hpLost} 点生命（${target.attributes.HP.current}/${target.attributes.HP.max}）`;
                    lines.push(hpText);
                    this.pushLog('attack', hpText, {
                        targetId: target.id,
                        hp: target.attributes.HP,
                        alive: target.alive,
                    });
                    if (!target.alive && !target.mercyWithdrawn) {
                        const t =
                        this.combatMode === COMBAT_MODE.DEADLY
                            ? `☠️ ${target.name} 倒下了（阵亡）`
                            : `💫 ${target.name} 力竭，失去了战斗力`;
                        lines.push(t);
                        this.pushLog('system', t, { targetId: target.id });
                    }
                } else if (
                    hit.outcome === OUTCOME.FUMBLE &&
                    this.ruleset.fumbleSelfHarmRatio > 0 &&
                    this.rng.next() < 0.5
                ) {
                    const selfDmg = Math.max(
                        1,
                        Math.round(attrMax(unit, 'HP', 10) * this.ruleset.fumbleSelfHarmRatio),
                    );
                    const applied = applyDamage(unit, selfDmg, this.ruleset, this.combatMode);
                    const t = `💀 ${unit.name} 大失败反噬，自伤 ${applied.hpLost} 点`;
                    lines.push(t);
                    this.pushLog('attack', t, { selfHarm: applied, unitId: unit.id });
                    if (!unit.alive) {
                        const d =
                        this.combatMode === COMBAT_MODE.DEADLY
                            ? `☠️ ${unit.name} 因反噬倒下（阵亡）`
                            : `💫 ${unit.name} 因反噬力竭`;
                        lines.push(d);
                        this.pushLog('system', d, { unitId: unit.id });
                    }
                }
            }

            // Withdrawn observers are immune to pending hostile effects and healing/revival.
            if (target.mercyWithdrawn) continue;
            // ---------- 非伤害效果 ----------
            for (const [effectIndex, effect] of (skill.effects ?? []).entries()) {
                if (effect.type === 'damage') continue;
                if (HOSTILE_EFFECTS.has(effect.type) && (!landed || !target.alive)) continue;

                const rawPower = effect.power ?? skill.power ?? 0;
                const resolved = rollEffectValue(
                    this.rng,
                    unit,
                    target,
                    skill,
                    effect.type,
                    rawPower,
                    this.ruleset,
                    targetCount,
                );
                logFalloff(resolved, target, effect.type);
                const value = resolved.value;

                if (effect.type === 'heal' || effect.type === 'mp') {
                    const key = effect.type === 'heal' ? 'HP' : 'MP';
                    if (value <= 0) {
                        // 数值为 0 也允许挂成持续回复状态，而不是静默无效果
                        const status = normalizeStatus({
                            id: `status_${target.id}_${skill.id}_${effectIndex}`,
                            name: skill.name,
                            type: 'heal',
                            duration: effect.duration || this.ruleset.defaultStatusDuration,
                            power: 0,
                            description: effect.description || effect.tag || `${EFFECT_TEXT[effect.type] ?? effect.type}（无数值）`,
                            tag: effect.tag,
                            modifiers: effect.modifiers,
                            source: unit.name,
                        });
                        if (status) addStatus(target, status);
                        continue;
                    }
                    const { healed, after, before } = applyHeal(target, key, value);
                    if (healed > 0) {
                        const t = `${unit.name} 的「${skill.name}」为 ${target.name} 回复 ${healed} 点 ${key}（${before}→${after}）`;
                        lines.push(t);
                        this.pushLog('heal', t, { targetId: target.id, key, healed, formula: resolved.formula });
                    }
                    continue;
                }

                // 其余统一挂状态
                const status = normalizeStatus({
                    id: `status_${target.id}_${skill.id}_${effectIndex}`,
                    name: skill.name,
                    type: effect.type,
                    duration: effect.duration || this.ruleset.defaultStatusDuration,
                    power: value,
                    saveDc: effect.saveDc,
                    description: effect.description || effect.tag || '',
                    tag: effect.tag,
                    modifiers: effect.modifiers,
                    source: unit.name,
                });
                if (!status) continue;
                const applied = addStatus(target, status);
                const positive = !HOSTILE_EFFECTS.has(effect.type);
                const modifierText = (applied.modifiers ?? []).map((part) => `${part.attr} ${part.delta >= 0 ? '+' : ''}${part.delta}`).join('、');
                const saveText = effect.type === 'control' || effect.type === 'dot' ? `，每回合 d20 抵抗 DC ${applied.saveDc ?? 10}` : '';
                const t = `${target.name} 获得「${applied.name}」（${positive ? '正面' : '负面'}，持续 ${applied.duration} 个自身回合${
                    applied.power ? `，数值 ${applied.power}` : ''
                }${modifierText ? `，${modifierText}` : ''}${saveText}）`;
                lines.push(t);
                this.pushLog('status', t, { targetId: target.id, status: applied, formula: resolved.formula });
            }
        }

        return lines;
    }
}

/** 效果类型的中文名，用于状态描述。 */
const EFFECT_TEXT = Object.freeze({
    heal: '治疗',
    mp: '回蓝',
    buff: '增益',
    debuff: '减益',
    shield: '护盾',
    taunt: '嘲讽',
    dispel: '驱散',
    revive: '复活',
    cleanse: '净化',
    dot: '持续伤害',
    control: '控制',
});

// ---------------------------------------------------------------------------
// 自动行动
// ---------------------------------------------------------------------------

/**
 * 给当前单位挑一个「还算聪明」的行动（自动战斗 / 敌方 AI）。
 *
 * 启发式规则，不是 AI：
 *   1. 血线告急且手里有治疗 → 先奶。
 *   2. 敌人 ≥ 2 且有群攻 → 群攻。
 *   3. 否则用期望伤害最高的可用技能。
 *   4. 都没得用就普通攻击。
 *
 * @param {Battle} battle
 * @returns {{unitId: string, skillId?: string, targetIds?: string[], action?: string}}
  * @param {{forUnit?: object}} [opts] forUnit 指定为哪个单位决策（默认当前行动单位）
 */
export function autoChooseAction(battle, opts = {}) {
    // `forUnit` 让调用方为**指定的**单位决策，而不是只能决策「当前行动单位」。
    // 用途：批量决策失败时，为同侧每个单位各补一条本地规则行动。
    const unit = opts.forUnit ?? battle.currentUnit;
    if (!unit) return { unitId: '' };

    // 只在需要单体兜底时抽签；群体/随机目标仍由实际结算阶段决定。
    const choose = (skill) => {
        const target = chooseFallbackTarget(battle, unit, skill);
        return { unitId: unit.id, ...(skill ? { skillId: skill.id } : {}),
            ...(target ? { targetIds: [target.id] } : {}) };
    };
    const usableSkills = (unit.skills ?? []).filter((s) => canUseSkill(unit, s).usable);
    const maxHp = attrMax(unit, 'HP', 1);
    const hpRatio = maxHp > 0 ? attr(unit, 'HP', 0) / maxHp : 1;

    const hostileCount = battle.units.filter(
        (u) => u.alive && u.side !== unit.side && u.side !== SIDE.NEUTRAL,
    ).length;

    // 1. 治疗优先
    if (hpRatio < 0.35) {
        const healer = usableSkills.find((s) =>
            (s.effects ?? []).some((/** @type {any} */ e) => e.type === 'heal'),
        );
        if (healer) return choose(healer);
    }

    // 2. 群攻
    if (hostileCount >= 2) {
        const aoe = usableSkills
            .filter(
                (s) =>
                    (s.target === 'group' || s.target === 'all') &&
                    (s.effects ?? []).some((/** @type {any} */ e) => e.type === 'damage'),
            )
            .sort((a, b) => b.power - a.power)[0];
        if (aoe) return { unitId: unit.id, skillId: aoe.id };
    }

    // 3. 单体最高伤害
    const damageSkills = usableSkills
        .filter((s) => (s.effects ?? []).some((/** @type {any} */ e) => e.type === 'damage'))
        .sort((a, b) => scoreSkill(b, unit) - scoreSkill(a, unit));
    if (damageSkills.length) return choose(damageSkills[0]);

    // 4. 辅助技能
    if (usableSkills.length) return choose(usableSkills[0]);

    // 5. 普通攻击：显式目标让纯本地/批量兜底与模型决策遵守相同规则。
    return choose();
}

/** 给技能打分：期望伤害 - 资源压力惩罚。 */
function scoreSkill(skill, unit) {
    const power = toNumber(skill.power) || 0;
    const cost = toNumber(skill.cost) || 0;
    const mp = attr(unit, 'MP', 999);
    const pressure = mp > 0 ? cost / Math.max(1, mp) : 0;
    const controlBonus = (skill.effects ?? []).some((/** @type {any} */ e) => e.type === 'control') ? 30 : 0;
    return power * (1 - Math.min(0.5, pressure)) + controlBonus;
}

export { POWER_MODE, normalizeRuleset, resolvePower };
