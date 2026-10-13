/**
 * tavern-dice / src/core/ruleset.js
 * ---------------------------------------------------------------------------
 * 数据驱动的规则集解析器。
 *
 * 设计目标：**引擎里不允许出现任何一张卡或一个体系的硬编码。**
 *
 * 现实情况是：不同角色的卡，战斗规则完全不同 ——
 * 有的卡用「命中率 = Aim/(Speed+Aim)」「伤害 = 威力 × (0.8~1.2) - 护甲」，
 * 有的卡用 d20 对抗、有的用 d100 百分比、有的卡压根没写规则只有一段文字描述境界强弱。
 *
 * 所以做法是：让 P1 流水线在整理战力体系的同时，顺手把世界书里的战斗规则一起抽出来，
 * 表达成下面这套**公式表达式**，再由引擎解释执行。
 * 读不到规则就用内置的通用预设。
 *
 * 公式表达式（formula）支持的语法：
 *   - 骰子：        `d20`、`2d6`、`1d100`
 *   - 变量：        `Aim`、`Speed`、`Armor`、`Atk`、`power`、`rank`、`level`
 *   - 四则运算：    `+ - * /`  与括号
 *   - 函数：        `floor(x)` `ceil(x)` `round(x)` `min(a,b)` `max(a,b)` `abs(x)`
 *   - 随机区间：    `rand(0.8, 1.2)`（含两端浮点）、`randint(1, 6)`（含两端整数）
 *
 * 例：
 *   命中： `d20 + (Aim - 100) / 10`   （d20 对抗式）
 *   命中： `Aim / (Speed + Aim)`      （命中率式，结果解释为概率）
 *   伤害： `(power + Atk) * rand(0.8, 1.2) - Armor`
 *   伤害： `power * rand(0.9, 1.1) - Armor`
 */

import { toNumber, toText } from './schema.js';
import { Rng, validateDiceSize } from './rng.js';

// ---------------------------------------------------------------------------
// 预设
// ---------------------------------------------------------------------------

/**
 * 内置通用规则集。不依赖任何特定卡，作为「世界书里读不到规则」时的兜底。
 */
export const GENERIC_D20 = Object.freeze({
    id: 'generic-d20',
    name: '通用 d20',
    description:
        '通用回合制判定：先攻掷 d20 加速度；命中掷 d20 加上命中修正对抗闪避；伤害为技能威力加骰面对抗护甲。适用于世界书里没有写明战斗规则的卡。',
    /** 'dice' = 掷骰对抗（结果看是否达标）；'chance' = 算出命中概率再判定 */
    hitMode: 'dice',
    initiativeFormula: 'd20 + Speed',
    hitFormula: 'd20 + (Aim - 100) / 10 + hitBonus',
    /** 命中判定的目标值表达式，只在 hitMode='dice' 时使用 */
    hitTargetFormula: 'Evasion',
    /** 伤害表达式，只在 hitMode='dice' 时使用 */
    damageFormula: '(power + d6) * critMult - Armor',
    /** 命中率表达式，只在 hitMode='chance' 时使用，应返回 0~1 */
    hitChanceFormula: 'Aim / (Speed + Aim)',

    // ---- 各效果类型的数值表达式（power 之外的部分） ----
    // 规则是：最终数值 = 还原后的 power + 这里算出来的修正，再夹到 0 以上。
    healFormula: '0',
    shieldFormula: '0',
    mpFormula: '0',
    buffFormula: '0',
    debuffFormula: '0',
    dotFormula: '0',

    critFormula: 'nat == 20',
    fumbleFormula: 'nat == 1',
    /** 暴击倍率，供 damageFormula 通过 critMult 变量引用（公式没用到也无所谓） */
    critMultiplier: 2,
    /** 大失败自伤比例（占最大 HP）；0 表示不反噬 */
    fumbleSelfHarmRatio: 0.1,
    /** 命中后的最低伤害 */
    minDamage: 1,
    /** 结算顺序：先扣护盾再扣 HP */
    shieldFirst: true,
    /** 群攻威力衰减 */
    aoeFalloff: 'sqrt',
    aoeFalloffFloor: 0.35,
    /** 状态默认持续回合 */
    defaultStatusDuration: 3,
    /** power 的解释方式，见 POWER_MODE */
    powerMode: 'absolute',
    /** 死亡判定：HP <= 0 */
    deathRule: 'hp<=0',
    /** 额外说明，展示给用户 */
    notes: '',
});

/** 相对威力（百分比）语义的规则集骨架：技能 power 是「占某项属性的比例」。 */
export const RELATIVE_POWER_BASE = Object.freeze({
    id: 'relative-power',
    name: '相对威力制',
    description:
        '技能威力以「占某项属性的百分比」表示（例如「威力为攻击力的 20%~50%」），结算时先按比例还原成绝对值。',
    powerMode: 'ratio-atk',
    notes: '比例口径下的 power 会先乘以对应属性再参与伤害计算。',
});

// ---------------------------------------------------------------------------
// power 口径
// ---------------------------------------------------------------------------

/**
 * 技能 `power` 字段的几种口径。这是跨卡兼容最麻烦的一点：
 * 同一个字段名，在不同卡里可能是绝对值、可能是百分比、也可能是别的属性的倍数。
 */
export const POWER_MODE = Object.freeze({
    /** 绝对值：power 直接就是伤害基数 */
    ABSOLUTE: 'absolute',
    /** 攻击力比例：power 是 ATK 的百分比（世界书写 `Power: ATK的20%~50%`） */
    RATIO_ATK: 'ratio-atk',
    /** 生命上限比例：power 是 MaxHP 的百分比（护盾/治疗常见） */
    RATIO_MAXHP: 'ratio-maxhp',
    /** 多项混合：伤害看 ATK 比例、护盾治疗看 MaxHP 比例 */
    MIXED: 'mixed',
});

/** power 口径的中文说明，用于 UI 提示。 */
export const POWER_MODE_LABEL = Object.freeze({
    absolute: '绝对值',
    'ratio-atk': '占攻击力百分比',
    'ratio-maxhp': '占生命上限百分比',
    mixed: '混合（伤害按攻击力、护盾治疗按生命上限）',
});

/**
 * 把技能 power 还原成绝对数值。
 *
 * @param {number} power 原始 power
 * @param {string} mode POWER_MODE 之一
 * @param {object} unit 施法者
 * @param {string} [effectType] 效果类型，'mixed' 模式下用来区分走哪个比例
 * @param {Record<string, number>} [effectiveAttributes] 引擎已经汇总装备、状态后的属性。
 * @returns {{value: number, base: string, applied: boolean}}
 */
export function resolvePower(power, mode, unit, effectType = 'damage', effectiveAttributes = {}) {
    const raw = toNumber(power) ?? 0;
    const attrOf = (/** @type {string} */ key, /** @type {number} */ fallback) => {
        if (key === 'Atk' && toNumber(effectiveAttributes.Atk) !== undefined) return toNumber(effectiveAttributes.Atk);
        const pool = unit?.attributes?.[key];
        if (!pool) return fallback;
        return key === 'Atk'
            ? toNumber(pool.current) ?? toNumber(pool.max) ?? fallback
            : toNumber(pool.max) ?? toNumber(pool.current) ?? fallback;
    };

    switch (mode) {
        case POWER_MODE.RATIO_ATK: {
            const atk = attrOf('Atk', 0);
            return { value: (raw / 100) * atk, base: `ATK(${atk})`, applied: true };
        }
        case POWER_MODE.RATIO_MAXHP: {
            const hp = attrOf('HP', 0);
            return { value: (raw / 100) * hp, base: `MaxHP(${hp})`, applied: true };
        }
        case POWER_MODE.MIXED: {
            // 伤害/减益走 ATK 比例；治疗/护盾走 MaxHP 比例
            const useHp = ['heal', 'shield'].includes(effectType);
            const key = useHp ? 'HP' : 'Atk';
            const base = attrOf(key, 0);
            return {
                value: (raw / 100) * base,
                base: `${useHp ? 'MaxHP' : 'ATK'}(${base})`,
                applied: true,
            };
        }
        default:
            return { value: raw, base: '', applied: false };
    }
}

/**
 * 自动嗅探 power 口径。
 *
 * 判断依据（基于真实世界书观察）：
 *  - 规则文本里出现「ATK的百分比」「占攻击力」「威力：攻击力」→ 比例制
 *  - 同一人物所有技能 power 都在 1~100 之间，而 ATK 是三位数以上 → 大概率是比例制
 *  - power 普遍大于 100 且与 ATK 量级相当 → 绝对制
 *
 * @param {object} system 归一化后的战力体系
 * @param {string} [ruleText] 世界书里的规则原文（有的话判断更准）
 * @returns {{mode: string, reason: string, confidence: number}}
 */
export function sniffPowerMode(system, ruleText = '') {
    const text = String(ruleText ?? '');
    if (/ATK\s*的?\s*\d+\s*%|攻击力的?\s*\d+\s*%|占攻击力|威力.{0,6}攻击力/i.test(text)) {
        return { mode: POWER_MODE.MIXED, reason: '规则文本里明确写了「威力 = 攻击力的百分比」', confidence: 0.95 };
    }
    if (/MaxHP\s*的?\s*\d+\s*%|生命上限的?\s*\d+\s*%/i.test(text)) {
        return { mode: POWER_MODE.RATIO_MAXHP, reason: '规则文本里明确写了「按生命上限百分比」', confidence: 0.9 };
    }

    const units = (system?.combatants ?? []).filter((/** @type {any} */ u) => u.skills?.length);
    if (!units.length) return { mode: POWER_MODE.ABSOLUTE, reason: '没有技能数据，按绝对值处理', confidence: 0.3 };

    /** @type {number[]} */
    const powers = [];
    /** @type {number[]} */
    const atks = [];
    for (const unit of units) {
        const atk = toNumber(unit.attributes?.Atk?.max) || 0;
        if (atk > 0) atks.push(atk);
        for (const skill of unit.skills) {
            const p = toNumber(skill.power) || 0;
            if (p > 0) powers.push(p);
        }
    }
    if (!powers.length || !atks.length) {
        return { mode: POWER_MODE.ABSOLUTE, reason: '数据不足，按绝对值处理', confidence: 0.3 };
    }

    const avg = (/** @type {number[]} */ list) => list.reduce((a, b) => a + b, 0) / list.length;
    const avgPower = avg(powers);
    const avgAtk = avg(atks);
    const maxPower = Math.max(...powers);

    // 所有 power 都 <= 100 且平均攻击力显著更大 → 比例制
    if (maxPower <= 100 && avgAtk > 0 && avgPower / avgAtk < 1.2) {
        const pct = (avgPower / avgAtk) * 100;
        if (pct >= 5 && pct <= 200) {
            return {
                mode: POWER_MODE.MIXED,
                reason: `所有技能 power ≤ 100，平均 ${avgPower.toFixed(0)} 而平均攻击力 ${avgAtk.toFixed(0)}，比例约 ${pct.toFixed(0)}%，判定为百分比口径`,
                confidence: 0.7,
            };
        }
    }

    return {
        mode: POWER_MODE.ABSOLUTE,
        reason: `power 量级（平均 ${avgPower.toFixed(0)}）与攻击力（平均 ${avgAtk.toFixed(0)}）相当或更大，判定为绝对值口径`,
        confidence: 0.6,
    };
}

// ---------------------------------------------------------------------------
// 规则集归一化
// ---------------------------------------------------------------------------

/** 允许出现在公式里的变量名白名单（防止 LLM 编出莫名其妙的变量名）。 */
export const FORMULA_VARIABLES = Object.freeze([
    'Aim',
    'Hit',
    'Accuracy',
    'hitBonus',
    'critMult',
    'CritMultiplier',
    'attackerSpeed',
    'targetSpeed',
    'targetArmor',
    'targetAtk',
    'targetHP',
    'targetMaxHP',
    'targetHPPercent',
    'Speed',
    'Spd',
    'Armor',
    'Def',
    'Atk',
    'HP',
    'MaxHP',
    'MP',
    'MaxMP',
    'Evasion',
    'power',
    'level',
    'rank',
    'tier',
    'nat',
    'crit',
    'round',
    'targets',
    'multiplier',
]);

/** 允许出现在公式里的函数。 */
export const FORMULA_FUNCTIONS = Object.freeze(['floor', 'ceil', 'round', 'min', 'max', 'abs', 'rand', 'randint', 'sqrt']);

/**
 * 归一化一套规则集。任何字段缺失都会回落到 GENERIC_D20 的对应值。
 *
 * @param {unknown} input LLM 输出的规则集对象，或预设对象
 * @returns {object}
 */
export function normalizeRuleset(input) {
    const raw = input && typeof input === 'object' ? /** @type {Record<string, any>} */ (input) : {};
    const base = GENERIC_D20;

    // hitMode：兼容 LLM 可能给的各种说法
    let hitMode = toText(raw.hitMode ?? raw.hit_mode ?? raw.命中模式).toLowerCase();
    if (!['dice', 'chance'].includes(hitMode)) {
        // 从公式形态反推：出现 d20/d100 就是掷骰式，出现除法且没有骰子就是概率式
        const probe = toText(raw.hitFormula ?? raw.hit_formula ?? raw.命中公式 ?? '');
        if (/\b\d*d\d+\b/i.test(probe)) hitMode = 'dice';
        else if (probe.includes('/')) hitMode = 'chance';
        else hitMode = base.hitMode;
    }

    const pickFormula = (/** @type {string[]} */ keys, /** @type {string} */ fallback) => {
        for (const key of keys) {
            const value = toText(raw[key]);
            if (value) return value;
        }
        return fallback;
    };

    const normalized = {
        id: toText(raw.id) || `custom-${Math.random().toString(36).slice(2, 8)}`,
        name: toText(raw.name ?? raw.名称) || '自定义规则',
        description: toText(raw.description ?? raw.说明) || '',
        hitMode,
        initiativeFormula: pickFormula(['initiativeFormula', 'initiative_formula', '先攻公式'], base.initiativeFormula),
        hitFormula: pickFormula(['hitFormula', 'hit_formula', '命中公式'], base.hitFormula),
        hitTargetFormula: pickFormula(
            ['hitTargetFormula', 'hit_target_formula', '命中目标公式'],
            hitMode === 'dice' ? base.hitTargetFormula : '1',
        ),
        hitChanceFormula: pickFormula(['hitChanceFormula', 'hit_chance_formula', '命中率公式'], base.hitChanceFormula),
        damageFormula: pickFormula(['damageFormula', 'damage_formula', '伤害公式'], base.damageFormula),
        healFormula: pickFormula(['healFormula', 'heal_formula', '治疗公式'], base.healFormula),
        shieldFormula: pickFormula(['shieldFormula', 'shield_formula', '护盾公式'], base.shieldFormula),
        mpFormula: pickFormula(['mpFormula', 'mp_formula', '回蓝公式'], base.mpFormula),
        buffFormula: pickFormula(['buffFormula', 'buff_formula', '增益公式'], base.buffFormula),
        debuffFormula: pickFormula(['debuffFormula', 'debuff_formula', '减益公式'], base.debuffFormula),
        dotFormula: pickFormula(['dotFormula', 'dot_formula', '持续伤害公式'], base.dotFormula),
        critFormula: pickFormula(['critFormula', 'crit_formula', '暴击公式'], base.critFormula),
        fumbleFormula: pickFormula(['fumbleFormula', 'fumble_formula', '大失败公式'], base.fumbleFormula),
        critMultiplier: Math.max(1, toNumber(raw.critMultiplier ?? raw.暴击倍率) ?? base.critMultiplier),
        fumbleSelfHarmRatio: clampNumber(toNumber(raw.fumbleSelfHarmRatio ?? raw.大失败自伤比例), 0, 1, base.fumbleSelfHarmRatio),
        minDamage: Math.max(0, toNumber(raw.minDamage ?? raw.最低伤害) ?? base.minDamage),
        shieldFirst: raw.shieldFirst === undefined ? base.shieldFirst : Boolean(raw.shieldFirst),
        aoeFalloff: ['none', 'linear', 'sqrt'].includes(toText(raw.aoeFalloff))
            ? toText(raw.aoeFalloff)
            : base.aoeFalloff,
        aoeFalloffFloor: clampNumber(toNumber(raw.aoeFalloffFloor), 0, 1, base.aoeFalloffFloor),
        defaultStatusDuration: Math.max(1, toNumber(raw.defaultStatusDuration ?? raw.默认持续回合) ?? base.defaultStatusDuration),
        powerMode: Object.values(POWER_MODE).includes(toText(raw.powerMode))
            ? toText(raw.powerMode)
            : base.powerMode,
        deathRule: toText(raw.deathRule ?? raw.死亡判定) || base.deathRule,
        notes: toText(raw.notes ?? raw.备注),
        /** 规则来源：'worldbook' | 'preset' | 'user' */
        source: toText(raw.source) || 'preset',
    };

    // 只升级旧通用预设；同样形状的自定义规则仍以用户给出的公式为准。
    if (normalized.id === 'generic-d20' && normalized.hitFormula.replace(/\s+/g, '') === 'd20+(Aim-100)/10') {
        normalized.hitFormula = base.hitFormula;
    }

    // 公式编译自检：编译不过就回落到预设，绝不让坏公式进引擎
    const formulaKeys = [
        'initiativeFormula',
        'hitFormula',
        'hitTargetFormula',
        'hitChanceFormula',
        'damageFormula',
        'healFormula',
        'shieldFormula',
        'mpFormula',
        'buffFormula',
        'debuffFormula',
        'dotFormula',
        'critFormula',
        'fumbleFormula',
    ];
    for (const key of formulaKeys) {
        const formula = normalized[key];
        try {
            compileFormula(formula);
        } catch (e) {
            console.warn(`[战斗掷骰] 规则集「${normalized.name}」的 ${key} 公式无法编译（${formula}），已回落默认值`, e);
            normalized[key] = /** @type {any} */ (base)[key];
        }
    }

    return normalized;
}

/** 数字夹取。 */
function clampNumber(value, min, max, fallback) {
    const n = toNumber(value);
    if (n === undefined) return fallback;
    return Math.min(max, Math.max(min, n));
}

// ---------------------------------------------------------------------------
// 公式引擎
// ---------------------------------------------------------------------------

/**
 * 编译公式为可复用的求值函数。
 *
 * 实现方式：手写递归下降解析器。**不用 eval / new Function**，
 * 因为酒馆页面可能有 CSP 限制，而且 eval 一个来自 LLM 的字符串风险太高。
 *
 * @param {string} formula
 * @returns {(scope: Record<string, number|boolean>) => number} 求值函数
 * @throws {Error} 语法错误时抛出
 */
export function compileFormula(formula) {
    const text = String(formula ?? '').trim();
    if (!text) throw new Error('公式为空');

    // ---- 词法分析 ----
    /** @type {Array<{type: string, value: any}>} */
    const tokens = [];
    let i = 0;
    while (i < text.length) {
        const ch = text[i];

        if (/\s/.test(ch)) {
            i++;
            continue;
        }
        // 骰子记法：d20 / 2d6 / 1d100 / 3D6
        // 必须放在「数字」之前判断，否则 `2d6` 会被切成 数字(2) + 标识符(d6)。
        const diceMatch = /^(\d*)[dD](\d+)/.exec(text.slice(i));
        if (diceMatch) {
            tokens.push({
                type: 'dice',
                count: diceMatch[1] ? Number(diceMatch[1]) : 1,
                faces: Number(diceMatch[2]),
                notation: diceMatch[0],
                offset: i,
            });
            i += diceMatch[0].length;
            continue;
        }
        // 数字
        if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(text[i + 1] ?? ''))) {
            let j = i;
            while (j < text.length && /[0-9.]/.test(text[j])) j++;
            tokens.push({ type: 'number', value: Number(text.slice(i, j)) });
            i = j;
            continue;
        }
        // 标识符 / 函数
        if (/[A-Za-z_\u4e00-\u9fa5]/.test(ch)) {
            let j = i;
            while (j < text.length && /[A-Za-z0-9_\u4e00-\u9fa5]/.test(text[j])) j++;
            tokens.push({ type: 'ident', value: text.slice(i, j) });
            i = j;
            continue;
        }
        // 运算符与括号
        // 注意：`=` `!` `&` `|` 必须出现在这里，否则下面的多字符运算符分支永远进不去
        if ('+-*/()<>?:,=!&|'.includes(ch)) {
            if ((ch === '&' || ch === '|') && text[i + 1] === ch) {
                tokens.push({ type: 'op', value: ch + ch });
                i += 2;
                continue;
            }
            // 支持 == <= >= !=
            if (ch === '=' && text[i + 1] === '=') {
                tokens.push({ type: 'op', value: '==' });
                i += 2;
                continue;
            }
            if (ch === '!' && text[i + 1] === '=') {
                tokens.push({ type: 'op', value: '!=' });
                i += 2;
                continue;
            }
            if ((ch === '<' || ch === '>') && text[i + 1] === '=') {
                tokens.push({ type: 'op', value: `${ch}=` });
                i += 2;
                continue;
            }
            tokens.push({ type: 'op', value: ch });
            i++;
            continue;
        }
        throw new Error(`公式中出现无法识别的字符「${ch}」`);
    }

    let pos = 0;
    const peek = () => tokens[pos];
    const eat = (/** @type {string} */ value) => {
        const t = tokens[pos];
        if (!t || t.value !== value) throw new Error(`公式语法错误：期望「${value}」`);
        pos++;
        return t;
    };

    // ---- 语法分析（递归下降） ----

    /** 三元表达式  cond ? a : b */
    function parseTernary() {
        const cond = parseOr();
        if (peek()?.value === '?') {
            eat('?');
            const a = parseTernary();
            eat(':');
            const b = parseTernary();
            return (/** @type {any} */ scope) => (cond(scope) ? a(scope) : b(scope));
        }
        return cond;
    }

    function parseOr() {
        let left = parseAnd();
        while (peek()?.value === '||') {
            eat('||');
            const right = parseAnd();
            const l = left;
            left = (/** @type {any} */ s) => (l(s) || right(s) ? 1 : 0);
        }
        return left;
    }

    function parseAnd() {
        let left = parseComparison();
        while (peek()?.value === '&&') {
            eat('&&');
            const right = parseComparison();
            const l = left;
            left = (/** @type {any} */ s) => (l(s) && right(s) ? 1 : 0);
        }
        return left;
    }

    function parseComparison() {
        let left = parseAdditive();
        while (['==', '!=', '<', '>', '<=', '>='].includes(peek()?.value)) {
            const op = tokens[pos++].value;
            const right = parseAdditive();
            const l = left;
            const r = right;
            left = (/** @type {any} */ s) => {
                const a = l(s);
                const b = r(s);
                switch (op) {
                    case '==':
                        return a === b ? 1 : 0;
                    case '!=':
                        return a !== b ? 1 : 0;
                    case '<':
                        return a < b ? 1 : 0;
                    case '>':
                        return a > b ? 1 : 0;
                    case '<=':
                        return a <= b ? 1 : 0;
                    case '>=':
                        return a >= b ? 1 : 0;
                    default:
                        return 0;
                }
            };
        }
        return left;
    }

    function parseAdditive() {
        let left = parseMultiplicative();
        while (peek()?.value === '+' || peek()?.value === '-') {
            const op = tokens[pos++].value;
            const right = parseMultiplicative();
            const l = left;
            const r = right;
            left = op === '+' ? (/** @type {any} */ s) => l(s) + r(s) : (/** @type {any} */ s) => l(s) - r(s);
        }
        return left;
    }

    function parseMultiplicative() {
        let left = parseUnary();
        while (peek()?.value === '*' || peek()?.value === '/') {
            const op = tokens[pos++].value;
            const right = parseUnary();
            const l = left;
            const r = right;
            left =
                op === '*'
                    ? (/** @type {any} */ s) => l(s) * r(s)
                    : (/** @type {any} */ s) => {
                          const divisor = r(s);
                          return divisor === 0 ? 0 : l(s) / divisor;
                      };
        }
        return left;
    }

    function parseUnary() {
        if (peek()?.value === '-') {
            eat('-');
            const operand = parseUnary();
            return (/** @type {any} */ s) => -operand(s);
        }
        if (peek()?.value === '+') {
            eat('+');
            return parseUnary();
        }
        return parsePrimary();
    }

    function parsePrimary() {
        const token = tokens[pos];
        if (!token) throw new Error('公式意外结束');

        if (token.type === 'number') {
            pos++;
            const value = token.value;
            return () => value;
        }

        if (token.type === 'dice') {
            pos++;
            const count = token.count;
            const faces = token.faces;
            validateDiceSize(count, faces);
            // 追踪钩子只在这个节点真正执行时调用；短路分支不会预掷骰子。
            return (/** @type {any} */ s) => {
                if (typeof s.__rollDice === 'function') {
                    return s.__rollDice(count, faces, { notation: token.notation, offset: token.offset }).total;
                }
                const rng = s.__rng;
                if (rng && typeof rng.dice === 'function') return rng.dice(count, faces).total;
                return Math.round(((faces + 1) / 2) * count);
            };
        }

        if (token.type === 'ident') {
            const name = token.value;
            pos++;
            if (peek()?.value === '(') {
                // 函数调用
                eat('(');
                /** @type {Array<(scope: any) => number>} */
                const args = [];
                if (peek()?.value !== ')') {
                    args.push(parseTernary());
                    while (peek()?.value === ',') {
                        eat(',');
                        args.push(parseTernary());
                    }
                }
                eat(')');
                return buildFunctionCall(name, args);
            }
            // 变量
            return (/** @type {any} */ s) => {
                const value = s[name];
                if (typeof value === 'boolean') return value ? 1 : 0;
                const n = Number(value);
                return Number.isFinite(n) ? n : 0;
            };
        }

        if (token.value === '(') {
            eat('(');
            const inner = parseTernary();
            eat(')');
            return inner;
        }

        throw new Error(`公式语法错误：意外的记号「${token.value}」`);
    }

    const compiled = parseTernary();
    if (pos !== tokens.length) {
        throw new Error(`公式语法错误：还有未解析的内容「${tokens[pos]?.value}」`);
    }

    const evaluate = (/** @type {Record<string, any>} */ scope) => {
        const result = compiled(scope);
        return Number.isFinite(result) ? result : 0;
    };
    // 只有一颗、且必定求值的命中骰，才可与天然骰共用。这里仅保存静态信息，不消费 RNG。
    evaluate.diceTerms = tokens.filter((token) => token.type === 'dice').map(({ count, faces }) => ({ count, faces }));
    evaluate.variables = [...new Set(tokens.filter((token, index) => token.type === 'ident' && tokens[index + 1]?.value !== '(').map((token) => token.value))];
    evaluate.maySkipDice = tokens.some((token) => token.type === 'op' && ['?', '&&', '||'].includes(token.value));
    return evaluate;
}

/**
 * 构造函数调用节点。
 * @param {string} name
 * @param {Array<(scope: any) => number>} args
 * @returns {(scope: Record<string, any>) => number}
 */
function buildFunctionCall(name, args) {
    const lower = name.toLowerCase();
    switch (lower) {
        case 'floor':
            requireArgs(name, args, 1);
            return (s) => Math.floor(args[0](s));
        case 'ceil':
            requireArgs(name, args, 1);
            return (s) => Math.ceil(args[0](s));
        case 'round':
            requireArgs(name, args, 1);
            return (s) => Math.round(args[0](s));
        case 'abs':
            requireArgs(name, args, 1);
            return (s) => Math.abs(args[0](s));
        case 'sqrt':
            requireArgs(name, args, 1);
            return (s) => Math.sqrt(Math.max(0, args[0](s)));
        case 'min':
            return (s) => Math.min(...args.map((a) => a(s)));
        case 'max':
            return (s) => Math.max(...args.map((a) => a(s)));
        case 'rand':
            requireArgs(name, args, 2);
            return (s) => {
                const lo = args[0](s);
                const hi = args[1](s);
                const rng = s.__rng;
                const unit = rng && typeof rng.next === 'function' ? rng.next() : 0.5;
                const value = lo + unit * (hi - lo);
                s.__recordRandom?.({ kind: 'rand', min: lo, max: hi, value });
                return value;
            };
        case 'randint':
            requireArgs(name, args, 2);
            return (s) => {
                const lo = Math.ceil(args[0](s));
                const hi = Math.floor(args[1](s));
                const rng = s.__rng;
                const value = rng && typeof rng.int === 'function' ? rng.int(lo, hi) : Math.round((lo + hi) / 2);
                s.__recordRandom?.({ kind: 'randint', min: lo, max: hi, value });
                return value;
            };
        default:
            throw new Error(`公式里使用了未知函数「${name}」`);
    }
}

/** 参数个数校验。 */
function requireArgs(/** @type {string} */ name, /** @type {any[]} */ args, /** @type {number} */ count) {
    if (args.length < count) throw new Error(`函数「${name}」需要至少 ${count} 个参数`);
}

// ---------------------------------------------------------------------------
// 规则集求值封装
// ---------------------------------------------------------------------------

/** 编译缓存，避免每次结算都重新解析公式。 */
const compileCache = new Map();

/**
 * 带缓存的编译。
 * @param {string} formula
 * @returns {(scope: Record<string, any>) => number}
 */
export function compileCached(formula) {
    const key = String(formula);
    let compiled = compileCache.get(key);
    if (!compiled) {
        compiled = compileFormula(key);
        compileCache.set(key, compiled);
    }
    return compiled;
}

/**
 * 规则集的求值器：绑定好公式与随机数，供引擎直接调用。
 */
export class RulesetEvaluator {
    /**
     * @param {object} ruleset 已归一化的规则集
     * @param {Rng} rng
     */
    constructor(ruleset, rng) {
        this.ruleset = normalizeRuleset(ruleset);
        this.rng = rng;
    }

    /**
     * 求值一个公式。
     * @param {string} formula
     * @param {Record<string, any>} scope
     * @returns {number}
     */
    eval(formula, scope) {
        try {
            return compileCached(formula)({ __rng: this.rng, ...scope });
        } catch (e) {
            console.error(`[战斗掷骰] 公式求值失败：${formula}`, e);
            return 0;
        }
    }

    /** 先攻值。 */
    initiative(scope) {
        return this.eval(this.ruleset.initiativeFormula, scope);
    }

    /** 命中式的命中总值。 */
    hitValue(scope) {
        return this.eval(this.ruleset.hitFormula, scope);
    }

    /** 命中式的目标值。 */
    hitTarget(scope) {
        return this.eval(this.ruleset.hitTargetFormula, scope);
    }

    /** 命中率式的概率（0~1）。 */
    hitChance(scope) {
        const raw = this.eval(this.ruleset.hitChanceFormula, scope);
        return Math.max(0, Math.min(1, raw));
    }

    /** 伤害。 */
    damage(scope) {
        return this.eval(this.ruleset.damageFormula, scope);
    }

    /** 是否暴击。 */
    isCrit(scope) {
        return this.eval(this.ruleset.critFormula, scope) !== 0;
    }

    /** 是否大失败。 */
    isFumble(scope) {
        return this.eval(this.ruleset.fumbleFormula, scope) !== 0;
    }

    /**
     * 求某个效果类型的数值。
     * 统一回：最终数值 = 还原后的 power + 该类型的公式修正，且不小于 0。
     * @param {string} type 效果类型：damage/heal/shield/mp/buff/debuff/dot
     * @param {Record<string, any>} scope
     * @param {number} resolvedPower 已按 powerMode 还原过的威力
     * @returns {{value: number, formula: string, modifier: number}}
     */
    effectValue(type, scope, resolvedPower) {
        const key = `${type}Formula`;
        const formula = toText(/** @type {any} */ (this.ruleset)[key]) || '0';
        const modifier = this.eval(formula, scope);
        return {
            value: Math.max(0, resolvedPower + modifier),
            formula: formula === '0' ? '' : formula,
            modifier,
        };
    }
}

/** 清空编译缓存（用户改了公式之后调用）。 */
export function clearFormulaCache() {
    compileCache.clear();
}

// ---------------------------------------------------------------------------
// 从世界书规则文本里抽取规则集（LLM 不可用时的本地兜底）
// ---------------------------------------------------------------------------

/**
 * 本地规则嗅探：在世界书文本里找战斗规则的痕迹，拼出一套近似的规则集。
 *
 * 这只是兜底 —— 有 LLM 时应该让它输出结构化的规则集。
 * 但兜底必须有，因为：① 用户可以关掉 P1 的规则抽取；② 有时候模型就是不听话。
 *
 * @param {string} ruleText 世界书全部相关条目的正文
 * @returns {{ruleset: object, signals: string[]}}
 */
export function sniffRuleset(ruleText) {
    const text = String(ruleText ?? '');
    /** @type {string[]} */
    const signals = [];
    const ruleset = { ...GENERIC_D20, source: 'worldbook' };

    // 先攻
    if (/先攻.{0,20}(d20|1d20)/i.test(text)) {
        signals.push('发现「先攻 d20」的描述');
    } else if (/行动顺序|先攻|出手顺序/.test(text) && /敏捷|速度|Speed|Spd/i.test(text)) {
        ruleset.initiativeFormula = 'd20 + Speed';
        signals.push('发现按速度/敏捷决定行动顺序');
    }

    // 命中：d20 对抗式
    const d20Hit = text.match(/d20\s*\+\s*([^，。；\n]{1,40})/i);
    if (d20Hit) {
        signals.push(`发现 d20 命中式：d20 + ${d20Hit[1].trim()}`);
    }
    // 命中：概率式（Aim/(Speed+Aim) 一类）
    if (/命中率|闪避率|命中概率/.test(text) && /(敏捷|速度|Speed)\s*[+/]/.test(text)) {
        ruleset.hitMode = 'chance';
        signals.push('发现「命中率 = 命中 ÷ (速度 + 命中)」这类概率式描述');
    }

    // 伤害：护甲减伤
    if (/护甲|防御力?/.test(text) && /(减|扣|抵|抵消|减免)/.test(text)) {
        signals.push('发现护甲减伤机制');
    }
    // 伤害：随机浮动
    const variance = text.match(/(\d+(?:\.\d+)?)\s*[~～\-—]\s*(\d+(?:\.\d+)?)\s*倍|浮动\s*(\d+)\s*%/);
    if (variance) {
        signals.push('发现伤害随机浮动区间');
    }
    // 暴击
    if (/暴击|致命一击|会心/.test(text)) {
        const mult = text.match(/暴击.{0,12}?(\d(?:\.\d)?)\s*倍/);
        if (mult) signals.push(`发现暴击倍率 ${mult[1]} 倍`);
    }
    // 大失败
    if (/大失败|致命失误|自伤|反噬/.test(text)) {
        signals.push('发现大失败/反噬机制');
    }
    // 威力口径
    if (/威力|Power|power/.test(text) && /(ATK|攻击力|攻击)\s*的?\s*\d+\s*%/.test(text)) {
        ruleset.powerMode = POWER_MODE.MIXED;
        signals.push('发现「威力 = 攻击力百分比」口径');
    }
    // 群攻
    if (/群攻|群体|范围攻击|全体/.test(text)) {
        signals.push('发现群体攻击机制');
    }
    // 死亡
    if (/HP\s*(?:≤|<=|低于|归零|为\s*0)/i.test(text) || /生命值.{0,6}(归零|为零|耗尽)/.test(text)) {
        ruleset.deathRule = 'hp<=0';
        signals.push('发现「生命归零即死亡」规则');
    }

    ruleset.description = signals.length
        ? `从世界书文本本地嗅探出的规则（${signals.length} 条线索）。建议用 LLM 重新抽取以获得更准确的结果。`
        : '世界书里没有发现明确规则，使用通用 d20 规则。';
    ruleset.notes = signals.join('；');

    return { ruleset: normalizeRuleset(ruleset), signals };
}
