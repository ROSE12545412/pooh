/**
 * tavern-dice / src/core/schema.js
 * ---------------------------------------------------------------------------
 * 统一战力数据模型 + 归一化 + 校验 + 与 `<Combat_block>` 文本格式的双向转换。
 *
 * 为什么要有这一层：
 *  LLM 返回的东西千奇百怪 —— 数字可能是字符串、HP 可能写成 "632/850" 也可能拆成
 *  两个字段、技能标签可能是 `[群攻;power:150;Aim:90;MP:40]` 也可能是结构化 JSON。
 *  战斗引擎不能直接吃这种脏数据，所以所有外部输入都必须先过 `normalize*`，
 *  再由 `validate*` 报出问题，最后交给引擎的永远是干净的内部结构。
 *
 * 兼容性目标（来自真实用户世界书观察）：
 *  1. `<Combat_block>` XML 风格文本 —— 用户已有的卡大量使用这种格式。
 *  2. 技能标签 `【技能名】[群攻;power:150][群降;power:20][Aim:90][MP:40]`。
 *  3. 纯 JSON（我们自己提示词的默认输出，也是内部存档格式）。
 */

/** 当前数据模型版本号。改动结构时必须递增，用于未来做数据迁移。 */
export const SCHEMA_VERSION = 3;

/** 阵营取值。 */
export const SIDE = Object.freeze({ ALLY: 'ally', ENEMY: 'enemy', NEUTRAL: 'neutral' });

/** 标准战斗属性键（Combat_block 的属性串就这五个）。 */
export const CORE_ATTRIBUTES = Object.freeze(['HP', 'MP', 'Atk', 'Armor', 'Speed']);

/** 需要「当前值 / 上限」两个数字的属性。 */
export const POOLED_ATTRIBUTES = Object.freeze(['HP', 'MP']);

/** 起手默认闪避值：世界书里没写闪避时的兜底，避免命中判定除零或必中。 */
export const DEFAULT_EVASION = 10;

/**
 * 技能标签 → 效果类型。
 *
 * 这份词表要尽量全，因为不同世界书里的写法差别很大：
 * 有的用「单体/群攻」，有的用「单回/群回蓝」，还有的带 `单/群` 前缀但不带。
 * 漏掉一个标签，模型给出的技能就会变成「已保留但未参与结算」，
 * 所以宁可多列，也不要让标签掉进 unknown。
 */
export const TAG_EFFECT = Object.freeze({
    // ---- 伤害 ----
    攻击: 'damage',
    攻: 'damage',
    单体: 'damage',
    群攻: 'damage',
    伤害: 'damage',
    物理: 'damage',
    法术: 'damage',
    群伤: 'damage',

    // ---- 治疗 / 回复 ----
    治疗: 'heal',
    回: 'heal',
    单回: 'heal',
    群回: 'heal',
    回复: 'heal',
    群回复: 'heal',

    // ---- 法力 / 资源回复 ----
    回蓝: 'mp',
    单回蓝: 'mp',
    群回蓝: 'mp',
    回魔: 'mp',
    单回魔: 'mp',
    群回魔: 'mp',

    // ---- 增益 ----
    增: 'buff',
    单增: 'buff',
    群增: 'buff',
    强化: 'buff',
    增益: 'buff',

    // ---- 减益 ----
    降: 'debuff',
    单降: 'debuff',
    群降: 'debuff',
    弱化: 'debuff',
    减益: 'debuff',
    骰点减益: 'debuff',

    // ---- 防御 ----
    防: 'buff',
    单防: 'buff',
    群防: 'buff',

    // ---- 护盾 ----
    盾: 'shield',
    单盾: 'shield',
    群盾: 'shield',
    护盾: 'shield',

    // ---- 命中 / 致盲（两者都作用在「命中」这一项上） ----
    盲: 'debuff',
    单盲: 'debuff',
    群盲: 'debuff',
    致盲: 'debuff',
    瞄: 'buff',
    单瞄: 'buff',
    群瞄: 'buff',
    瞄准: 'buff',

    // ---- 嘲讽 ----
    嘲: 'taunt',
    单嘲: 'taunt',
    群嘲: 'taunt',
    嘲讽: 'taunt',

    // ---- 机制类 ----
    驱散: 'dispel',
    单驱散: 'dispel',
    群驱散: 'dispel',
    净化: 'cleanse',
    单净化: 'cleanse',
    群净化: 'cleanse',
    复活: 'revive',
    单复活: 'revive',
    群复活: 'revive',

    // ---- 控制类 ----
    控制: 'control',
    封印: 'control',
    眩晕: 'control',
    沉默: 'control',
    定身: 'control',
    束缚: 'control',
    冰冻: 'control',
    石化: 'control',
    麻痹: 'control',
    昏迷: 'control',

    // ---- 持续伤害 ----
    持续伤害: 'dot',
    中毒: 'dot',
    灼烧: 'dot',
    燃烧: 'dot',
    流血: 'dot',
    腐蚀: 'dot',
    剧毒: 'dot',

    // ---- 占位 ----
    无: 'other',
});

/** 效果类型的中文显示名。 */
export const EFFECT_LABEL = Object.freeze({
    damage: '伤害',
    heal: '治疗',
    mp: '回蓝',
    cost: '消耗',
    buff: '增益',
    debuff: '减益',
    shield: '护盾',
    taunt: '嘲讽',
    dispel: '驱散',
    revive: '复活',
    cleanse: '净化',
    dot: '持续伤害',
    control: '控制',
    other: '其他',
});

/** 目标范围的中文显示名。 */
export const TARGET_LABEL = Object.freeze({
    single: '单体',
    group: '群体',
    self: '自身',
    all: '全体',
    random: '随机',
});

/** 状态效果的固定持续时间（回合）候选值，用于解析 `[毒;3]` 这类写法。 */
const DURATION_HINT = /^(\d+)(?:t|回合)?$/i;

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/**
 * 从任意值里抠出一个有限数字。会跳过 undefined/null/空串，也会处理 "1,200" 这种带分隔符的串。
 * @param {unknown} value
 * @returns {number|undefined}
 */
export function toNumber(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (value === null || value === undefined) return undefined;
    const text = String(value).replace(/[,\s，]/g, '').replace(/[%％]$/, '');
    if (!text) return undefined;
    const num = Number(text);
    return Number.isFinite(num) ? num : undefined;
}

/**
 * 从任意值里抠出一个非空字符串。
 * @param {unknown} value
 * @returns {string}
 */
export function toText(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) return value.map(toText).filter(Boolean).join(' ');
    return '';
}

/**
 * 「数字或 {current,max}」双形态归一化。
 * 兼容三种写法：`632`、`"632/850"`、`{current:632, max:850}`。
 * @param {unknown} value
 * @param {number} [fallbackMax] 只给了单个数字时，把上限补成多少（默认与当前值相同）
 * @returns {{current: number, max: number}}
 */
export function normalizePool(value, fallbackMax) {
    const empty = { current: 0, max: 0 };

    if (value === null || value === undefined || value === '') return { ...empty };

    if (typeof value === 'object' && !Array.isArray(value)) {
        const obj = /** @type {Record<string, unknown>} */ (value);
        const current =
            toNumber(obj.current) ??
            toNumber(obj.cur) ??
            toNumber(obj.now) ??
            toNumber(obj.value) ??
            toNumber(obj.hp) ??
            toNumber(obj.mp) ??
            0;
        const max = toNumber(obj.max) ?? toNumber(obj.maximum) ?? toNumber(obj.total) ?? fallbackMax ?? current;
        return { current: Math.max(0, current), max: Math.max(0, max || current) };
    }

    const text = String(value).trim();
    const slash = text.match(/^(-?[\d.,]+)\s*\/\s*(-?[\d.,]+)$/);
    if (slash) {
        const current = toNumber(slash[1]) ?? 0;
        const max = toNumber(slash[2]) ?? current;
        return { current: Math.max(0, current), max: Math.max(0, max) };
    }

    const single = toNumber(text);
    if (single === undefined) return { ...empty };
    const max = fallbackMax ?? single;
    return { current: Math.max(0, single), max: Math.max(0, max) };
}

/** 深拷贝（只处理 JSON 安全的数据，我们全部数据结构都是 JSON 安全的）。 */
export function deepClone(value) {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(deepClone);
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = deepClone(v);
    return out;
}

/** 生成一个稳定、可读、可排序的 id。 */
let idCounter = 0;
export function makeId(prefix = 'id') {
    idCounter = (idCounter + 1) % 100000;
    return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36).padStart(3, '0')}`;
}

// ---------------------------------------------------------------------------
// 技能标签解析
// ---------------------------------------------------------------------------

/**
 * 把一个标签 token 归一化成效果对象。
 * 支持的形态：`群攻`、`power:150`、`Aim:90`、`MP:40`、`毒;3`（未知标签 + 持续回合）。
 * @param {string} token
 * @returns {{effect: string, power: number, duration: number, raw: string, known: boolean}}
 */
export function parseSkillTagToken(token) {
    const raw = String(token ?? '').trim();
    const lower = raw.toLowerCase();

    // ⚠️ 顺序很重要：必须先认「纯效果词」，再认「键值对」。
    // 否则 `power:150` 里的 "power" 会匹配到带「攻」的模式，
    // 或者反过来 `群攻` 因为含「攻」被当成 power 标签吃掉。
    if (Object.prototype.hasOwnProperty.call(TAG_EFFECT, raw)) {
        return { effect: TAG_EFFECT[raw], power: 0, duration: 0, raw, known: true };
    }

    // 数值型标签：power:150 / aim:90 / mp:40 / 威力:150
    // ⚠️ 这里把「消耗」和「回蓝」分开成两个不同的 effect：
    //  `MP:40` / `耗蓝:40` / `cost:40` → 'cost'（技能消耗）
    //  `回蓝` 这类纯词条走上面的词表，得到 'mp'（回复法力的效果）
    // 早期版本把两者都归到 'mp'，结果回蓝技能被当成纯消耗技能、效果整条丢失。
    const kv = raw.match(/^([a-zA-Z\u4e00-\u9fa5_]+)\s*[:：]\s*(.+)$/);
    if (kv) {
        const key = kv[1].toLowerCase();
        const value = kv[2].trim();
        const alias = {
            power: 'power',
            威力: 'power',
            伤害: 'power',
            aim: 'aim',
            命中: 'aim',
            acc: 'aim',
            mp: 'cost',
            cost: 'cost',
            耗蓝: 'cost',
            消耗: 'cost',
            duration: 'duration',
            持续: 'duration',
        }[key];
        if (alias) {
            return {
                effect: alias,
                power:
                    alias === 'aim' || alias === 'cost' || alias === 'power'
                        ? (toNumber(value) ?? 0)
                        : 0,
                duration: alias === 'duration' ? (toNumber(value) ?? 0) : 0,
                raw,
                known: true,
            };
        }
        return { effect: 'other', power: toNumber(value) ?? 0, duration: 0, raw, known: false };
    }

    // 未知标签 + 可选持续回合：`毒;3` / `燃烧;2t`
    const [name, dur] = raw.split(/[;；]/).map((s) => s.trim());
    const duration = dur && DURATION_HINT.test(dur) ? Number(dur.replace(/[tT回合]/g, '')) || 0 : 0;
    return { effect: 'other', power: 0, duration, raw: name || raw, known: false };
}

/**
 * 解析技能标签块，例如 `[群攻;power:150][群降;power:20][Aim:90][MP:40]`。
 *
 * 解析策略：**按方括号分组**，每组内部再拆。
 * 这样做是因为真实写法有两种，且都常见：
 *   `[群攻;power:150]`  —— 效果与数值写在同一个方括号里（`;` 分隔）
 *   `[群攻][power:150]`  —— 效果与数值各自一个方括号
 * 如果先把所有方括号打平成一串 token，`群回蓝` 这类复合词就会被
 * `回蓝` 的子串匹配抢走（真实踩过的坑），所以必须在组内先判完整词。
 *
 * @param {string} text
 * @returns {{tags: string[], target: string, power: number, aim: number, cost: number, effects: Array<{type: string, power: number, duration: number, tag: string}>, unknownTags: string[]}}
 */
export function parseSkillTags(text) {
    /** @type {string[]} */
    const tags = [];
    /** @type {string[][]} */
    const groups = [];
    const bracketRe = /\[([^\[\]]+)\]/g;
    let m;
    while ((m = bracketRe.exec(String(text ?? '')))) {
        const parts = m[1]
            .split(/[;；]/)
            .map((t) => t.trim())
            .filter(Boolean);
        if (!parts.length) continue;
        groups.push(parts);
        tags.push(...parts);
    }

    let target = 'single';
    let power = 0;
    let aim; // 缺省与显式 Aim:0 必须区分。
    let cost = 0;
    /** @type {Array<{type: string, power: number, duration: number, tag: string}>} */
    const effects = [];
    /** @type {string[]} */
    const unknownTags = [];

    /**
     * 记录一个效果。
     * @param {string} tag
     * @param {{effect: string, power: number, duration: number, known: boolean}} parsed
     */
    const record = (tag, parsed) => {
        if (/^群/.test(tag)) target = 'group';
        else if (/^单/.test(tag) && target !== 'group') target = 'single';
        if (!parsed.known) unknownTags.push(tag);
        effects.push({ type: parsed.effect, power: parsed.power, duration: parsed.duration, tag });
    };

    for (const parts of groups) {
        let pendingEffect = null;

        for (const token of parts) {
            const parsed = parseSkillTagToken(token);

            // 全局数值参数：谁先出现算谁的（同一技能里通常只写一次）
            if (parsed.effect === 'aim') {
                aim = parsed.power;
                continue;
            }
            if (parsed.effect === 'cost') {
                cost = parsed.power;
                continue;
            }
            if (parsed.effect === 'duration') continue;

            // 裸 `power:N`：归属于同组内紧邻的前一个效果标签；
            // 若同组内没有效果标签，则视为整体威力（例如单独的 `[power:60]`）。
            if (parsed.effect === 'power') {
                if (pendingEffect) {
                    pendingEffect.power = parsed.power;
                    if (pendingEffect.type === 'damage') power = parsed.power;
                } else {
                    power = parsed.power;
                }
                continue;
            }

            record(token, parsed);
            pendingEffect = effects[effects.length - 1];
        }
    }

    return { tags, target, power, aim, cost, effects, unknownTags };
}

// ---------------------------------------------------------------------------
// 归一化：技能
// ---------------------------------------------------------------------------

/**
 * 把任意形态的技能描述归一化为内部 Skill 结构。
 * @param {unknown} input
 * @param {number} [index] 用于兜底命名
 * @returns {object|null}
 */
export function normalizeSkill(input, index = 0) {
    if (input === null || input === undefined) return null;

    /** @type {Record<string, unknown>} */
    let raw = {};
    let textForm = '';

    if (typeof input === 'string') {
        textForm = input;
    } else if (typeof input === 'object') {
        raw = /** @type {Record<string, unknown>} */ (deepClone(input));
        textForm = toText(raw.tags ?? raw.raw ?? raw.display ?? '');
    } else {
        return null;
    }

    // 技能名：【红莲野火】 / 【红莲野火】[群攻;...] / 纯文本
    const nameMatch = textForm.match(/【([^】]+)】/);
    const name =
        toText(raw.name) ||
        (nameMatch ? nameMatch[1].trim() : '') ||
        toText(raw.名称) ||
        `技能${index + 1}`;

    // 描述：去掉技能名与标签块后剩下的部分
    const description =
        toText(raw.description) ||
        toText(raw.desc) ||
        toText(raw.描述) ||
        textForm
            .replace(/【[^】]*】/g, '')
            .replace(/\[[^\[\]]*\]/g, '')
            .trim();

    const fromTags = parseSkillTags(textForm);

    const cost = toNumber(raw.cost) ?? toNumber(raw.mp) ?? toNumber(raw.消耗) ?? fromTags.cost;
    const aim = toNumber(raw.aim) ?? toNumber(raw.命中) ?? fromTags.aim;
    const powerRaw = toNumber(raw.power) ?? toNumber(raw.威力) ?? fromTags.power;

    // 目标范围：显式字段优先，其次看标签里的 单/群
    let target = toText(raw.target ?? raw.目标).toLowerCase();
    if (!['single', 'group', 'self', 'all', 'random'].includes(target)) {
        const zhTarget = toText(raw.target ?? raw.目标).replace(/[\s（(）)]/g, '').toLowerCase();
        target =
            { 单体: 'single', 群体: 'group', 群体aoe: 'group', aoe: 'group', 群攻: 'group', 自身: 'self', 全体: 'all', 随机: 'random' }[
                zhTarget
            ] || fromTags.target;
    }

    // 效果：显式数组优先，其次从标签推导
    /** @type {Array<{type: string, power: number, duration: number}>} */
    let effects = [];
    const rawEffects = raw.effects ?? raw.效果;
    if (Array.isArray(rawEffects)) {
        effects = rawEffects
            .map((e) => {
                if (typeof e === 'string') {
                    const p = parseSkillTagToken(e);
                    return { type: p.effect, power: p.power, duration: p.duration, tag: p.raw, description: '' };
                }
                const obj = /** @type {Record<string, unknown>} */ (e || {});
                const type = normalizeEffectName(toText(obj.type ?? obj.类型) || 'other');
                const saveDc = type === 'control' || type === 'dot' ? normalizeSaveDc(obj.saveDc) : undefined;
                return {
                    type,
                    power: toNumber(obj.power ?? obj.value ?? obj.数值) ?? 0,
                    // duration 计数的是受影响单位自己的回合，不是全局轮次。
                    duration: toNumber(obj.duration ?? obj.持续) ?? 0,
                    ...(saveDc !== undefined ? { saveDc } : {}),
                    tag: toText(obj.tag),
                    description: toText(obj.description ?? obj.desc ?? obj.描述),
                    ...(Array.isArray(obj.modifiers) ? { modifiers: normalizeModifiers(obj.modifiers) } : {}),
                };
            })
            .filter((e) => e.type);
    }
    if (!effects.length && fromTags.effects.length) {
        effects = fromTags.effects.map((e) => ({ ...e, description: '' }));
    }
    if (!effects.length) {
        effects = [{ type: 'damage', power: powerRaw ?? 0, duration: 0 }];
    }

    // 主伤害值：优先显式 power，其次取第一个 damage 效果的值
    const damageEffect = effects.find((e) => e.type === 'damage');
    const power = powerRaw ?? damageEffect?.power ?? 0;

    const tags = Array.isArray(raw.tags)
        ? /** @type {unknown[]} */ (raw.tags).map(toText).filter(Boolean)
        : fromTags.tags;

    return {
        id: toText(raw.id) || makeId('skill'),
        name,
        /** 汇报原文的判定加值，仅供追溯；实际加值由规则公式与 aim 决定。 */
        advantage: toNumber(raw.advantage) ?? 0,
        advantageNote: toText(raw.advantageNote),
        description,
        target,
        power,
        aim: aim ?? 100, // 仅缺省补基准；显式 0 与负值必须保留。
        cost: cost || 0,
        cooldown: toNumber(raw.cooldown ?? raw.cd ?? raw.冷却) ?? 0,
        /** @type {number} 当前剩余冷却回合 */
        cooldownLeft: toNumber(raw.cooldownLeft) ?? 0,
        effects,
        tags,
        unknownTags: fromTags.unknownTags,
        /** 技能来源（世界书条目 comment / 角色卡），便于回溯 */
        source: toText(raw.source ?? raw.来源),
        ...(toText(raw.libraryId) ? { libraryId: toText(raw.libraryId) } : {}),
    };
}

/** 把中英文效果类型名统一到内部枚举。 */
function normalizeEffectName(name) {
    const text = String(name || '').trim();
    if (!text) return 'other';
    if (EFFECT_LABEL[text]) return text;
    if (TAG_EFFECT[text]) return TAG_EFFECT[text];
    const map = {
        damage: 'damage',
        dmg: 'damage',
        heal: 'heal',
        hp: 'heal',
        mp: 'mp',
        buff: 'buff',
        debuff: 'debuff',
        shield: 'shield',
        taunt: 'taunt',
        dispel: 'dispel',
        revive: 'revive',
        cleanse: 'cleanse',
        dot: 'dot',
        control: 'control',
    };
    return map[text.toLowerCase()] || 'other';
}

// ---------------------------------------------------------------------------
// 归一化：明确的属性增减与状态效果
// ---------------------------------------------------------------------------

const MODIFIER_ATTRIBUTES = new Set(['Atk', 'Armor', 'Speed', 'Evasion', 'hit']);

/** 控制/持续伤害的可选回合豁免 DC。缺失或非法时留空，由引擎使用默认 10。 */
export function normalizeSaveDc(value) {
    if (typeof value !== 'number' && typeof value !== 'string') return undefined;
    const text = String(value).trim();
    if (!/^\d+$/.test(text)) return undefined;
    const dc = Number(text);
    return Number.isInteger(dc) && dc >= 2 && dc <= 30 ? dc : undefined;
}

/**
 * 属性加值使用带符号的 delta；状态类型不再替这个数值翻转符号。
 * 只接受引擎已支持的属性，不把描述、百分比或未知字段当成平加值。
 * @param {unknown} input
 * @returns {Array<{attr: string, delta: number}>}
 */
export function normalizeModifiers(input) {
    if (!Array.isArray(input)) return [];
    return input.flatMap((item) => {
        if (!item || typeof item !== 'object') return [];
        const attr = canonicalAttributeKey(item.attr);
        const text = toText(item.delta);
        const delta = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(text) ? Number(text) : NaN;
        return MODIFIER_ATTRIBUTES.has(attr) && Number.isFinite(delta) ? [{ attr, delta }] : [];
    });
}

/**
 * 从描述中读取「攻击+5」「命中:-2」等明确的平加值。
 * 无符号数字、百分比、年龄、等级、持续时间及定性评价均不推断。
 * @param {string} text
 * @returns {Array<{attr: string, delta: number}>}
 */
export function parseExplicitModifiers(text) {
    const source = toText(text).replace(/＋/g, '+').replace(/[−－]/g, '-');
    const names = '攻击力|攻击|防御力|防御|护甲|闪避值|闪避|速度|敏捷|目标判定|命中判定|判定加值|判定|骰点减益|骰点减值|骰点|命中加值|命中|hitBonus|Evasion|Accuracy|Armour|Armor|Defense|Defence|Attack|Speed|Dodge|Atk|Def|Spd|hit';
    const re = new RegExp(`(?<![A-Za-z0-9_])(${names})\\s*[:：=]?\\s*([+-]\\s*(?:\\d+(?:\\.\\d+)?|\\.\\d+))(?![\\d.]|\\s*[%％])`, 'gi');
    const out = [];
    for (const match of source.matchAll(re)) {
        const attr = canonicalAttributeKey(match[1]);
        // 施放者本次判定归入 skill.aim，不作为目标状态再加一次。
        const prefix = source.slice(0, match.index);
        if (attr === 'hit' && /(?:本次(?:攻击|施放|技能)?|此次(?:攻击|施放|技能)?|技能自身|施放|施展)(?:的)?\s*$/.test(prefix)) continue;
        out.push({ attr, delta: Number(match[2].replace(/\s/g, '')) });
    }
    return normalizeModifiers(out);
}

/**
 * 归一化一条状态效果。
 * @param {unknown} input
 * @returns {object|null}
 */
export function normalizeStatus(input) {
    if (!input) return null;

    if (typeof input === 'string') {
        const text = input.trim();
        const modifiers = parseExplicitModifiers(text);
        // 有明确加值时，末尾的 +5/-2 不是持续时间；回合数必须有单位。
        const m = text.match(modifiers.length
            ? /^(.+?)\s*[（(:：]?\s*(\d+)\s*(?:回合|turn|t)\s*[)）]?$/i
            : /^(.+?)\s*[（(:：]?\s*(\d+)\s*(?:回合|turn|t)?\s*[)）]?$/i);
        const name = (m ? m[1] : text).replace(/[（(:：]\s*$/, '').trim();
        const duration = m ? Number(m[2]) : 0;
        const type = modifiers.length
            ? (modifiers.some((modifier) => modifier.delta < 0) ? 'debuff' : 'buff')
            : TAG_EFFECT[name] || normalizeEffectName(name);
        return {
            id: makeId('status'),
            name: name || text,
            type: type === 'other' ? 'debuff' : type,
            duration: Number.isFinite(duration) ? duration : 0,
            power: 0,
            stacks: 1,
            description: modifiers.length ? text : '',
            ...(modifiers.length ? { modifiers } : {}),
            source: '',
        };
    }

    if (typeof input !== 'object') return null;
    const raw = /** @type {Record<string, unknown>} */ (input);
    const name = toText(raw.name ?? raw.名称 ?? raw.status) || '状态';
    const type = normalizeEffectName(toText(raw.type ?? raw.类型) || name);
    const saveDc = type === 'control' || type === 'dot' ? normalizeSaveDc(raw.saveDc) : undefined;
    return {
        id: toText(raw.id) || makeId('status'),
        name,
        type: type === 'other' ? 'debuff' : type,
        duration:
            toNumber(raw.duration ?? raw.持续 ?? raw.turns ?? raw.remaining) ??
            toNumber(raw.durationRaw) ??
            0,
        power: toNumber(raw.power ?? raw.value ?? raw.数值) ?? 0,
        ...(saveDc !== undefined ? { saveDc } : {}),
        stacks: Math.max(1, toNumber(raw.stacks ?? raw.层数) ?? 1),
        description: toText(raw.description ?? raw.desc ?? raw.描述),
        tag: toText(raw.tag),
        ...(Array.isArray(raw.modifiers) ? { modifiers: normalizeModifiers(raw.modifiers) } : {}),
        source: toText(raw.source ?? raw.来源),
    };
}

// ---------------------------------------------------------------------------
// 归一化：战力评估
// ---------------------------------------------------------------------------

/**
 * 战力评级档位。
 *
 * 为什么要有「数值 + 档位」两套：
 *  - 数值（`rating`）用于**排序与比较** —— 「谁更强」需要一个可比的量
 *  - 档位（`grade`）用于**人读与叙事** —— 世界书里写的往往是「一流高手」这种词
 * 两者都由模型给出，但我们始终能从一个推出另一个，避免模型只给一半时数据残缺。
 */
export const POWER_GRADES = Object.freeze([
    { min: 90, label: '天花板' },
    { min: 75, label: '顶尖' },
    { min: 60, label: '一流' },
    { min: 45, label: '二流' },
    { min: 30, label: '三流' },
    { min: 0, label: '杂鱼' },
]);

/**
 * 由数值评分推出档位。
 * @param {number} rating
 * @returns {string}
 */
export function gradeFromRating(rating) {
    const value = toNumber(rating) ?? 0;
    for (const band of POWER_GRADES) {
        if (value >= band.min) return band.label;
    }
    return POWER_GRADES[POWER_GRADES.length - 1].label;
}

/**
 * 归一化一个角色的战力评估。
 *
 * 兼容模型可能给出的各种形态：
 *  - 纯字符串：`"一流高手"` / `"实力深不可测"`
 *  - 纯数字：`78`
 *  - 对象：`{ rating: 78, grade: "一流", note: "……", basis: "……" }`
 *
 * @param {unknown} input
 * @returns {{rating: number, grade: string, note: string, basis: string} | null}
 */
export function normalizePowerRating(input) {
    if (input === null || input === undefined || input === '') return null;

    // 纯数字
    if (typeof input === 'number') {
        const rating = clampRating(input);
        return { rating, grade: gradeFromRating(rating), note: '', basis: '' };
    }

    // 纯字符串：当作档位/描述，不给数值（避免把「一流」硬映射成一个假数字）
    if (typeof input === 'string') {
        const text = input.trim();
        if (!text) return null;
        const asNumber = toNumber(text);
        if (asNumber !== undefined && /^-?\d+(\.\d+)?$/.test(text)) {
            const rating = clampRating(asNumber);
            return { rating, grade: gradeFromRating(rating), note: '', basis: '' };
        }
        return { rating: 0, grade: text, note: '', basis: '' };
    }

    if (typeof input !== 'object') return null;
    const raw = /** @type {Record<string, unknown>} */ (input);

    const ratingRaw =
        toNumber(raw.rating) ??
        toNumber(raw.score) ??
        toNumber(raw.value) ??
        toNumber(raw.评分) ??
        toNumber(raw.战力值);
    const rating = ratingRaw === undefined ? 0 : clampRating(ratingRaw);

    const grade = toText(raw.grade ?? raw.tier ?? raw.label ?? raw.等级 ?? raw.档位) || gradeFromRating(rating);

    return {
        rating,
        grade,
        note: toText(raw.note ?? raw.summary ?? raw.说明 ?? raw.评价 ?? raw.简述),
        basis: toText(raw.basis ?? raw.reason ?? raw.依据 ?? raw.理由),
    };
}

/** 评分夹到 0~100。 */
function clampRating(/** @type {number} */ value) {
    const n = toNumber(value) ?? 0;
    return Math.max(0, Math.min(100, Math.round(n)));
}

// ---------------------------------------------------------------------------
// 归一化：装备（武器 / 防具 / 饰品）
// ---------------------------------------------------------------------------

/** 装备部位。 */
export const EQUIP_SLOT = Object.freeze({
    WEAPON: 'weapon',
    ARMOR: 'armor',
    ACCESSORY: 'accessory',
    OTHER: 'other',
});

/** 各部位的中文名。 */
export const SLOT_LABEL = Object.freeze({
    weapon: '武器',
    armor: '防具',
    accessory: '饰品',
    other: '其它',
});

/**
 * 部位别名 → 标准部位。
 * 世界书里的写法五花八门（刀/剑/法器/法宝/灵器/护符/戒指…），都要能归位。
 */
const SLOT_ALIASES = {
    weapon: ['武器', '兵器', '刀', '剑', '枪', '弓', '弩', '杖', '法器', '法宝', '灵器', '神兵', 'weapon', 'sword', 'blade'],
    armor: ['防具', '护具', '护甲', '铠甲', '衣服', '法袍', '战甲', '盾', 'armor', 'armour', 'shield'],
    accessory: ['饰品', '首饰', '饰物', '配饰', '配件', '护符', '符咒', '戒指', '项链', '手镯', '玉佩', '吊坠', '挂坠', '耳环', '胸针', '徽章', '腰饰', '法宝饰品', 'accessory', 'ring', 'amulet', 'necklace', 'pendant', 'bracelet', 'earring', 'trinket'],
};

/**
 * 归一化装备部位。
 * @param {string} raw
 * @returns {string}
 */
export function normalizeSlot(raw) {
    const text = String(raw ?? '').trim();
    if (!text) return EQUIP_SLOT.OTHER;
    const lower = text.toLowerCase();
    const aliases = Object.entries(SLOT_ALIASES).flatMap(([slot, names]) => names.map((name) => ({ slot, name })));
    const exact = aliases.find(({ name }) => lower === name.toLowerCase());
    if (exact) return exact.slot;
    // 「法宝饰品」「剑形吊坠」不能先被短词「法宝」「剑」截走。
    return aliases.sort((a, b) => b.name.length - a.name.length)
        .find(({ name }) => lower.includes(name.toLowerCase()))?.slot ?? EQUIP_SLOT.OTHER;
}

/**
 * 解析 `[Atk:+30][Speed:+10]` 或 `[Atk+30 Speed+10]` 这样的属性增益串。
 *
 * ⚠️ 属性名里**不允许出现空格**。早期版本用 `[A-Za-z\u4e00-\u9fa5]{1,12}` 贪婪匹配，
 * 会把 `Atk+30 Speed+10` 里的键名吃成 `AtkSpeed`，于是增益整条丢失 ——
 * 这个 bug 是「装备写进 Combat_block 再解析回来」的往返测试抓出来的。
 *
 * @param {string} text
 * @returns {Record<string, number>}
 */
export function parseBonusString(text) {
    /** @type {Record<string, number>} */
    const out = {};
    // 键名允许字母/汉字，可用下划线连接，但**不含空格**；`: =` 可选；值可带正负号
    const re = /([A-Za-z][A-Za-z0-9_]{0,11}|[\u4e00-\u9fa5]{1,8})\s*[:：=]?\s*([-+]?\d+)/g;
    let m;
    while ((m = re.exec(String(text ?? '')))) {
        // 纯数字键名（例如 `+30`）跳过，避免把数值当成属性
        if (/^\d+$/.test(m[1])) continue;
        const key = canonicalAttributeKey(m[1]);
        const value = toNumber(m[2]);
        if (value !== undefined) out[key] = value;
    }
    return out;
}

/** 真正的 d20 优劣势，与旧技能 advantage 数字加值是两个独立协议。 */
function equipmentCheckMode(value) {
    const text = toText(value).replace(/\s/g, '').toLowerCase();
    if (['advantage', '优势'].includes(text)) return 'advantage';
    if (['disadvantage', '劣势'].includes(text)) return 'disadvantage';
    return 'normal';
}

/** 只读明确的攻击/防御检定标签；不从物品名、定性强弱、条件或「判定优势+3」推测。 */
export function normalizeEquipmentChecks(input, text = '') {
    const explicit = input && typeof input === 'object' && !Array.isArray(input);
    if (explicit) return {
        attack: equipmentCheckMode(input.attack ?? input.攻击 ?? input.攻击检定),
        defense: equipmentCheckMode(input.defense ?? input.防御 ?? input.防御检定),
    };
    const checks = { attack: 'normal', defense: 'normal' };
    const pattern = /(?:^|[（(【\[，,；;。\n])\s*(?:d20\s*)?(攻击|命中|防御|闪避)(?:\s*d20)?(?:检定|判定|掷骰)?\s*[:：=]?\s*(优势|劣势|普通|正常|无)(?=\s*(?:$|[）)】\]，,；;。\n]))/gi;
    for (const match of toText(text).matchAll(pattern)) {
        checks[/攻击|命中/.test(match[1]) ? 'attack' : 'defense'] = equipmentCheckMode(match[2]);
    }
    return checks;
}

/** 六列表格必须先整行读取，不能把加值列中的逗号拆成另一件装备。 */
function equipmentRow(text) {
    const row = toText(text).replace(/^\s*[-*+•]\s+/, '').replace(/\*\*/g, '').replace(/^\s*[|｜]|[|｜]\s*$/g, '');
    const cells = row.split(/[|｜]/).map((cell) => cell.trim());
    if (cells.length < 6 || (normalizeSlot(cells[0]) === EQUIP_SLOT.OTHER && !/^(其它|其他|other)$/i.test(cells[0]))) return null;
    const [slot, name, bonusText, attack, defense, ...reason] = cells;
    if (!name) return null;
    return {
        name, slot,
        bonuses: Object.fromEntries(parseExplicitModifiers(bonusText).map(({ attr, delta }) => [attr, delta])),
        checks: { attack: equipmentCheckMode(attack.replace(/^(?:攻击|命中)(?:检定|判定)?\s*[:：=]?\s*/, '')), defense: equipmentCheckMode(defense.replace(/^(?:防御|闪避)(?:检定|判定)?\s*[:：=]?\s*/, '')) },
        effect: reason.join('｜'), description: row,
    };
}

/**
 * 归一化一件装备。
 *
 * 兼容形态：
 *  - 纯字符串：`"【青莲剑】[Atk:+30][Speed:+10]（斩铁）"`
 *  - 对象：`{ name, slot, bonuses, description, source }`
 *  - 带 `bonus` 文字串：`{ name:"剑", 属性:"[Atk:+30]" }`
 *
 * @param {unknown} input
 * @param {number} [index]
 * @returns {object|null}
 */
export function normalizeEquipment(input, index = 0) {
    if (input === null || input === undefined) return null;

    let raw = /** @type {Record<string, any>} */ ({});
    let textForm = '';

    if (typeof input === 'string') {
        textForm = input.replace(/\*\*/g, '').trim();
        raw = equipmentRow(textForm) ?? {};
    } else if (typeof input === 'object') {
        raw = deepClone(input);
        textForm = toText(raw.tags ?? raw.raw ?? raw.equip ?? '');
    } else {
        return null;
    }

    // 名字：【……】 里的内容优先。
    //
    // ⚠️ 模板里装备写作 `武器·玄重尺[Atk:+30]`（部位·名字[增益]），
    // 没有【】括号。早期版本只认【】，于是名字解析失败、退化成「装备1」。
    // 这里补上第二种形态：先剥掉 `部位·` 前缀与 `[增益]`、`（效果）`，剩下的就是名字。
    const nameMatch = textForm.match(/【([^】]+)】/);
    const fromTemplateForm = textForm
        .replace(/^(?:武器|防具|护具|护甲|饰品|配饰|其它|其他|weapon|armor|accessory|other)\s*[·:：]\s*/i, '') // 部位前缀
        .replace(/\[[^\]]*\]/g, '')
        .replace(/[（(][^）)]*[）)]/g, '')
        .trim();
    const name =
        toText(raw.name) ||
        toText(raw.名称) ||
        (nameMatch ? nameMatch[1].trim() : '') ||
        fromTemplateForm ||
        `装备${index + 1}`;

    // 部位：显式字段优先，其次看名字里的关键词
    const slot =
        raw.slot || raw.部位 || raw.type
            ? normalizeSlot(toText(raw.slot ?? raw.部位 ?? raw.type))
            : normalizeSlot(`${name} ${textForm}`);

    // 属性增益：显式字段优先，其次从文本里解析
    /** @type {Record<string, number>} */
    let bonuses = {};
    const bonusesRaw = raw.bonuses ?? raw.bonus ?? raw.属性 ?? raw.加成;
    if (bonusesRaw && typeof bonusesRaw === 'object' && !Array.isArray(bonusesRaw)) {
        for (const [key, value] of Object.entries(bonusesRaw)) {
            // 结构化数字本身就是明确的 delta；「20%」等不是平加值。
            const num = typeof value === 'number' || (typeof value === 'string' && /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value.trim())) ? Number(value) : NaN;
            if (Number.isFinite(num)) bonuses[canonicalAttributeKey(key)] = num;
        }
    } else {
        const bonusText = typeof bonusesRaw === 'string' ? bonusesRaw : textForm;
        // 兼容旧的显式 [HP:100] 标签；普通描述只认带符号的已支持属性。
        for (const tag of bonusText.match(/\[[^\]]*\]/g) ?? []) {
            if (!/[%％]/.test(tag)) Object.assign(bonuses, parseBonusString(tag));
        }
        for (const { attr, delta } of parseExplicitModifiers(bonusText)) bonuses[attr] = delta;
    }
    // 剥掉属性串与名字后剩下的就是描述
    const description =
        toText(raw.description) ||
        toText(raw.desc) ||
        toText(raw.描述) ||
        textForm
            .replace(/【[^】]*】/g, '')
            .replace(/\[[^\[\]]*\]/g, '')
            .replace(/[（(][^）)]*[）)]/g, '')
            .trim();

    // 括号里的短内容通常是附加效果，例如「（斩铁）」
    const effectMatch = textForm.match(/[（(]([^）)]{2,20})[）)]/);
    const effect = toText(raw.effect ?? raw.效果) || (effectMatch ? effectMatch[1].trim() : '');

    return {
        id: toText(raw.id) || makeId('equip'),
        name,
        slot,
        bonuses,
        // base 随未计装备的基础属性叠加；additive 明确声明是已有有效属性之外的新增量。
        bonusMode: (raw.bonusMode ?? textForm.match(/\[bonusMode\s*:\s*(additive|base)\]/i)?.[1]) === 'additive' ? 'additive' : 'base',
        checks: normalizeEquipmentChecks(raw.checks, `${textForm}\n${effect}\n${description}`),
        effect,
        description,
        /** 数据出处，便于回溯 */
        source: toText(raw.source ?? raw.来源),
        ...(toText(raw.libraryId) ? { libraryId: toText(raw.libraryId) } : {}),
        /** 是否装备中 */
        equipped: raw.equipped === undefined ? !/\[equipped\s*:\s*false\]/i.test(textForm) : Boolean(raw.equipped),
    };
}

/**
 * 把一件装备的属性增益格式化成人读的字符串。
 * @param {object} equipment
 * @returns {string}
 */
export function formatEquipmentBonuses(equipment) {
    const entries = Object.entries(equipment?.bonuses ?? {});
    if (!entries.length) return '';
    return entries.map(([key, value]) => `${key}${value >= 0 ? '+' : ''}${value}`).join(' ');
}

// ---------------------------------------------------------------------------
// 归一化：战斗单位
// ---------------------------------------------------------------------------

/**
 * 定向说服影响力：来源角色 → targetName；不是颜值、好感或招降成功率。
 * 缺失和非法数值省略，不能把空值、布尔值或对象转换成 0。
 * @param {unknown} input
 * @returns {{persona: string, charm: Array<{targetName: string, value: number, reason: string}>}}
 */
export function normalizeSocial(input) {
    const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const charm = [];
    const seen = new Set();
    for (const item of Array.isArray(raw.charm) ? raw.charm : []) {
        if (!item || typeof item !== 'object') continue;
        const targetName = typeof item.targetName === 'string' ? item.targetName.trim() : '';
        const text = typeof item.value === 'string' ? item.value.trim() : '';
        const value = typeof item.value === 'number' ? item.value
            : /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text) ? Number(text) : NaN;
        if (!targetName || !Number.isFinite(value) || seen.has(targetName)) continue;
        seen.add(targetName);
        charm.push({ targetName, value: Math.max(0, Math.min(100, value)), reason: toText(item.reason) });
    }
    return { persona: toText(raw.persona), charm };
}

/**
 * 把任意形态的战斗单位归一化。
 * @param {unknown} input
 * @param {{side?: string, index?: number}} [opts]
 * @returns {object|null}
 */
export function normalizeCombatant(input, opts = {}) {
    if (!input || typeof input !== 'object') return null;
    const raw = /** @type {Record<string, unknown>} */ (deepClone(input));

    const name = toText(raw.name ?? raw.名字 ?? raw.名称 ?? raw.character);
    if (!name) return null;

    // ---- 属性 ----
    /** @type {Record<string, {current: number, max: number}>} */
    const attributes = {};

    // 形态 A：attributes 字典
    const attrSource = raw.attributes ?? raw.属性 ?? raw.stats;
    if (attrSource && typeof attrSource === 'object' && !Array.isArray(attrSource)) {
        for (const [key, value] of Object.entries(/** @type {Record<string, unknown>} */ (attrSource))) {
            const canonical = canonicalAttributeKey(key);
            attributes[canonical] = normalizePool(value);
        }
    }

    // 形态 B：`[HP:632/850][MP:180/200][Atk:120]` 属性串
    // 注意 `属性` 这个键既可能是属性串字符串、也可能是属性字典对象，两种都要认
    const attrTextField = toText(
        raw.attrText ??
            raw.attr ??
            raw.属性串 ??
            raw.attributesText ??
            (typeof raw.属性 === 'string' ? raw.属性 : ''),
    );
    if (attrTextField) {
        for (const [key, value] of parseAttributeString(attrTextField)) {
            const canonical = canonicalAttributeKey(key);
            if (!attributes[canonical] || !attributes[canonical].max) {
                attributes[canonical] = normalizePool(value, attributes[canonical]?.max);
            }
        }
    }

    // 形态 C：散落的顶层 hp/mp/atk/...
    const flatAliases = {
        HP: ['hp', 'HP', '生命', '血量', '生命值'],
        MP: ['mp', 'MP', '法力', '蓝', '能量', 'mana'],
        Atk: ['atk', 'ATK', '攻击', '攻击力', 'atk_power'],
        Armor: ['armor', 'Armour', 'def', 'DEF', '防御', '护甲'],
        Speed: ['speed', 'SPD', '速度', 'spd'],
        Evasion: ['evasion', 'eva', '闪避', '闪避值', 'dodge'],
    };
    for (const [canonical, aliases] of Object.entries(flatAliases)) {
        if (attributes[canonical] && attributes[canonical].max) continue;
        for (const alias of aliases) {
            const value = raw[alias];
            if (value !== undefined && value !== null && value !== '') {
                const pool = normalizePool(value, attributes[canonical]?.max);
                attributes[canonical] = pool;
                break;
            }
        }
    }

    // 兜底：HP 必须存在，否则这个单位在战斗里没有意义
    if (!attributes.HP || (!attributes.HP.max && !attributes.HP.current)) {
        attributes.HP = { current: 1, max: 1 };
    }
    if (attributes.HP.max <= 0) attributes.HP.max = Math.max(1, attributes.HP.current);
    if (attributes.HP.current > attributes.HP.max) attributes.HP.current = attributes.HP.max;
    if (!attributes.Speed) attributes.Speed = { current: 10, max: 10 };
    if (!attributes.Atk) attributes.Atk = { current: 10, max: 10 };
    if (!attributes.Armor) attributes.Armor = { current: 0, max: 0 };
    if (!attributes.Evasion) attributes.Evasion = { current: DEFAULT_EVASION, max: DEFAULT_EVASION };

    // ---- 阵营 ----
    const sideText = toText(raw.side ?? raw.阵营 ?? opts.side).toLowerCase();
    const side =
        {
            ally: SIDE.ALLY,
            allies: SIDE.ALLY,
            我方: SIDE.ALLY,
            友方: SIDE.ALLY,
            己方: SIDE.ALLY,
            enemy: SIDE.ENEMY,
            enemies: SIDE.ENEMY,
            敌方: SIDE.ENEMY,
            敌人: SIDE.ENEMY,
            neutral: SIDE.NEUTRAL,
            中立: SIDE.NEUTRAL,
        }[sideText] || opts.side || SIDE.NEUTRAL;

    // ---- 技能 ----
    /** @type {unknown[]} */
    const rawSkills = Array.isArray(raw.skills)
        ? raw.skills
        : Array.isArray(raw.技能)
          ? raw.技能
          : [];
    const skills = rawSkills.map((s, i) => normalizeSkill(s, i)).filter(Boolean);

    // ---- 状态 ----
    /** @type {unknown[]} */
    const rawStatuses = Array.isArray(raw.statuses)
        ? raw.statuses
        : Array.isArray(raw.status)
          ? raw.status
          : Array.isArray(raw.状态)
            ? raw.状态
            : [];
    const statuses = rawStatuses.map(normalizeStatus).filter(Boolean);

    // ---- 装备（武器 / 防具 / 饰品）----
    // 模型可能分开写成 weapons / armor / accessories，也可能合并成 equipment / items。
    // 三种都要収，并且按 名称+部位 去重（同一把剑在两条字段里各出现一次很常见）。
    /** @type {unknown[]} */
    const equipmentSource = [];
    for (const key of ['equipment', 'equipments', 'weapons', 'armor', 'armours', 'accessories', 'items', '装备', '武器', '防具', '饰品', '道具']) {
        const value = raw[key];
        if (Array.isArray(value)) equipmentSource.push(...value);
        // 单件对象（模型偶尔会这么给）
        else if (value && typeof value === 'object' && !Array.isArray(value)) equipmentSource.push(value);
        else if (typeof value === 'string' && value.trim()) equipmentSource.push(value);
    }

    /** @type {object[]} */
    const equipment = [];
    const seenEquip = new Set();
    for (const item of equipmentSource) {
        const normalized = normalizeEquipment(item, equipment.length);
        if (!normalized) continue;
        const key = `${normalized.slot}::${normalized.name}`;
        if (seenEquip.has(key)) continue;
        seenEquip.add(key);
        equipment.push(normalized);
    }

    // ---- 等级 / 境界 ----
    const tierRaw = raw.tier ?? raw.rank ?? raw.level ?? raw.等级 ?? raw.境界 ?? raw.阶位;
    const tier = typeof tierRaw === 'object' && tierRaw !== null
        ? toText(/** @type {Record<string, unknown>} */ (tierRaw).name ?? /** @type {Record<string, unknown>} */ (tierRaw).label)
        : toText(tierRaw);
    const tierValue =
        typeof tierRaw === 'object' && tierRaw !== null
            ? toNumber(/** @type {Record<string, unknown>} */ (tierRaw).value ?? /** @type {Record<string, unknown>} */ (tierRaw).index)
            : toNumber(tierRaw);

    const alive = raw.alive === undefined ? attributes.HP.current > 0 : Boolean(raw.alive);

    // ---- 战力评估 ----
    // 这是用户最关心的「谁更强」那个数字。模型可能给对象、字符串或数字，都要认。
    const powerRating =
        normalizePowerRating(raw.powerRating ?? raw.power ?? raw.战力 ?? raw.战力评估 ?? raw.rating) ?? {
            // 模型没给就留空，**不编造** —— 空值在界面上会显示成「未评估」，
            // 比一个假的数字有用得多（假数字会让人误以为模型评估过了）
            rating: 0,
            grade: '',
            note: '',
            basis: '',
        };

    return {
        id: toText(raw.id) || makeId('unit'),
        name,
        side: raw.mercyWithdrawn === true ? SIDE.NEUTRAL : side,
        aliases: Array.isArray(raw.aliases ?? raw.别名)
            ? /** @type {unknown[]} */ (raw.aliases ?? raw.别名).map(toText).filter(Boolean)
            : [],
        tier,
        tierValue,
        /** 战力评估：数值评分 + 档位 + 说明 + 评分依据 */
        powerRating,
        /** base 表示不含装备/状态的基础属性；旧输入口径未知时不能再次叠装备。 */
        attributeBasis: ['base', 'effective'].includes(raw.attributeBasis) ? raw.attributeBasis : 'unspecified',
        attributes,
        skills,
        /** 技能之外的武器 / 防具 / 饰品（各自带属性增益） */
        equipment,
        statuses,
        alive: raw.mercyWithdrawn === true ? false : alive,
        ...(raw.mercyWithdrawn === true ? { mercyWithdrawn: true, incapacitated: true,
            mercyOriginalSide: toText(raw.mercyOriginalSide ?? raw.mercy?.originalSide) || SIDE.ENEMY,
            mercy: raw.mercy && typeof raw.mercy === 'object' ? { ...raw.mercy } : {} } : {}),
        /**
         * 是否是**玩家操控的角色**。
         *
         * 由 `report-parser.js` 从【玩家】标记解析出来，或由 `app.markUserUnit()` 兜底判定。
         * 必须在这里保留 —— 否则归一化会把它丢掉，批量决策就会连玩家自己也一起替你做决定。
         */
        isUser: Boolean(raw.isUser),
        social: normalizeSocial(raw.social),
        /** 自由备注：LLM 认为重要但不属于任何字段的信息 */
        notes: toText(raw.notes ?? raw.备注),
        /** 原始 Combat_block 里的未识别字段，避免信息丢失 */
        extras: (raw.extras && typeof raw.extras === 'object' ? raw.extras : {}) || {},
        /** 数据出处，便于回溯到世界书条目 */
        source: {
            worldbook: toText(/** @type {any} */ (raw.source)?.worldbook ?? raw.世界书),
            entry: toText(/** @type {any} */ (raw.source)?.entry ?? raw.条目),
            messageIndex: toNumber(/** @type {any} */ (raw.source)?.messageIndex),
        },
    };
}

/**
 * 属性键名归一化：把「生命值」「HP值」「atk」之类统一成标准键。
 * 未知属性保留原名（首字母大写），这样特殊体系（如「剑气」「道行」）不会丢。
 * @param {string} key
 * @returns {string}
 */
export function canonicalAttributeKey(key) {
    const text = String(key ?? '').trim();
    if (!text) return 'Unknown';
    const lower = text.toLowerCase();
    const map = {
        hp: 'HP',
        生命: 'HP',
        生命值: 'HP',
        血量: 'HP',
        体力: 'HP',
        health: 'HP',
        mp: 'MP',
        法力: 'MP',
        蓝: 'MP',
        蓝量: 'MP',
        能量: 'MP',
        mana: 'MP',
        atk: 'Atk',
        攻击: 'Atk',
        攻击力: 'Atk',
        attack: 'Atk',
        armor: 'Armor',
        armour: 'Armor',
        防御: 'Armor',
        防御力: 'Armor',
        护甲: 'Armor',
        def: 'Armor',
        defence: 'Armor',
        defense: 'Armor',
        speed: 'Speed',
        速度: 'Speed',
        敏捷: 'Speed',
        spd: 'Speed',
        evasion: 'Evasion',
        闪避: 'Evasion',
        闪避值: 'Evasion',
        dodge: 'Evasion',
        hit: 'hit',
        hitbonus: 'hit',
        accuracy: 'hit',
        命中: 'hit',
        命中加值: 'hit',
        命中判定: 'hit',
        判定: 'hit',
        判定加值: 'hit',
        目标判定: 'hit',
        骰点: 'hit',
        骰点减益: 'hit',
        骰点减值: 'hit',
    };
    if (map[lower]) return map[lower];
    // 保持未知属性可读：首字符大写
    return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * 解析属性串 `[HP:632/850][MP:180/200][Atk:120][Armor:50][Speed:30]`。
 * @param {string} text
 * @returns {Array<[string, string]>} [属性名, 原始值字符串]
 */
export function parseAttributeString(text) {
    /** @type {Array<[string, string]>} */
    const out = [];
    const re = /\[\s*([^\]:：\[\]]+?)\s*[:：]\s*([^\[\]]+?)\s*\]/g;
    let m;
    while ((m = re.exec(String(text ?? '')))) {
        out.push([m[1].trim(), m[2].trim()]);
    }
    return out;
}

// ---------------------------------------------------------------------------
// 归一化：战力体系（顶层）
// ---------------------------------------------------------------------------

/**
 * 归一化整个战力体系对象。这是 P1 流水线的输出、P2 流水线的输入。
 * @param {unknown} input
 * @returns {object}
 */
export function normalizePowerSystem(input) {
    const raw = (input && typeof input === 'object' ? deepClone(input) : {}) || {};
    const rec = /** @type {Record<string, any>} */ (raw);

    /** @type {object[]} */
    const combatants = [];
    const seen = new Map();

    /**
     * 加入一个单位，按名字去重（同名同阵营视为同一人，合并技能）。
     * @param {unknown} unit
     * @param {string} side
     */
    const pushUnit = (unit, side) => {
        const normalized = normalizeCombatant(unit, { side });
        if (!normalized) return;
        const key = `${normalized.side}::${normalized.name}`;
        if (seen.has(key)) {
            const existing = seen.get(key);
            // 合并技能：按名字去重
            const skillNames = new Set(existing.skills.map((/** @type {any} */ s) => s.name));
            for (const skill of normalized.skills) {
                if (!skillNames.has(skill.name)) {
                    existing.skills.push(skill);
                    skillNames.add(skill.name);
                }
            }
            // 合并状态
            const statusNames = new Set(existing.statuses.map((/** @type {any} */ s) => s.name));
            for (const status of normalized.statuses) {
                if (!statusNames.has(status.name)) existing.statuses.push(status);
            }
            // 属性取更完整的那个（上限更大的赢）
            for (const [k, pool] of Object.entries(normalized.attributes)) {
                const cur = existing.attributes[k];
                if (!cur || (!cur.max && pool.max)) existing.attributes[k] = pool;
            }
            if (!existing.social.persona) existing.social.persona = normalized.social.persona;
            existing.social = normalizeSocial({
                persona: existing.social.persona,
                charm: [...existing.social.charm, ...normalized.social.charm],
            });
            if (!existing.notes && normalized.notes) existing.notes = normalized.notes;
            return;
        }
        seen.set(key, normalized);
        combatants.push(normalized);
    };

    // 形态 A：allies / enemies 分组
    const groups = [
        [rec.allies ?? rec.我方 ?? rec.我方列表 ?? rec.party, SIDE.ALLY],
        [rec.enemies ?? rec.敌方 ?? rec.敌方列表 ?? rec.foes, SIDE.ENEMY],
        [rec.neutral ?? rec.中立 ?? rec.中立列表, SIDE.NEUTRAL],
    ];
    for (const [list, side] of groups) {
        if (Array.isArray(list)) for (const unit of list) pushUnit(unit, /** @type {string} */ (side));
    }

    // 形态 B：扁平 combatants 数组（每家自带 side）
    if (Array.isArray(rec.combatants ?? rec.units ?? rec.角色列表)) {
        for (const unit of rec.combatants ?? rec.units ?? rec.角色列表) pushUnit(unit, SIDE.NEUTRAL);
    }

    // 体系元信息
    const system = rec.system && typeof rec.system === 'object' ? rec.system : {};
    const tiersRaw = system.tiers ?? system.等级阶梯 ?? rec.tiers ?? rec.等级阶梯;

    // 规则集：世界书里读出来的战斗规则。没有就留 null，由上层决定是否用内置预设。
    const rulesetRaw = rec.ruleset ?? system.ruleset ?? rec.规则集 ?? null;

    return {
        schemaVersion: SCHEMA_VERSION,
        /** 体系名称，例如「斗气大陆」「剑仙JX」 */
        systemName: toText(system.name ?? system.名称 ?? rec.systemName ?? rec.体系名) || '未命名战力体系',
        /** 一句话总述 */
        overview: toText(system.overview ?? system.总述 ?? rec.overview ?? rec.总述),
        /** 数值量纲说明：让 LLM 交代「HP 一万大概什么水平」，避免跨书比较失真 */
        scale: toText(system.scale ?? system.量纲 ?? rec.scale ?? rec.量纲),
        /** 等级 / 境界阶梯，从低到高 */
        tiers: Array.isArray(tiersRaw)
            ? tiersRaw.map((t, i) => {
                  if (typeof t === 'string') return { name: t, value: i + 1, description: '' };
                  const obj = /** @type {Record<string, unknown>} */ (t || {});
                  return {
                      name: toText(obj.name ?? obj.名称 ?? obj.tier) || `T${i + 1}`,
                      value: toNumber(obj.value ?? obj.level ?? obj.阶) ?? i + 1,
                      description: toText(obj.description ?? obj.desc ?? obj.说明),
                  };
              })
            : [],
        /** 属性定义说明 */
        attributeGuide: toText(system.attributeGuide ?? system.属性说明 ?? rec.attributeGuide),
        /** 判定相关的规则补充（例如某体系自带暴击规则） */
        rules: Array.isArray(system.rules ?? rec.rules ?? rec.规则)
            ? /** @type {unknown[]} */ (system.rules ?? rec.rules ?? rec.规则).map(toText).filter(Boolean)
            : [],
        /** 从世界书里读出来的战斗规则集；null 表示没读到 */
        ruleset: rulesetRaw && typeof rulesetRaw === 'object' ? rulesetRaw : null,
        combatants,
        /** 生成元数据 */
        meta: {
            generatedAt: toNumber(rec.meta?.generatedAt) ?? Date.now(),
            sourceBooks: Array.isArray(rec.meta?.sourceBooks) ? rec.meta.sourceBooks.map(toText) : [],
            model: toText(rec.meta?.model),
            note: toText(rec.meta?.note),
            /** 生成过程中被截断/跳过的世界书条目，提示用户数据可能不全 */
            truncations: Array.isArray(rec.meta?.truncations) ? rec.meta.truncations : [],
        },
    };
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

/** 严重级别。 */
export const SEVERITY = Object.freeze({ ERROR: 'error', WARNING: 'warning', INFO: 'info' });

/**
 * 校验战力体系，返回问题清单。空数组表示没问题。
 * @param {object} system
 * @returns {Array<{level: string, path: string, message: string}>}
 */
export function validatePowerSystem(system) {
    /** @type {Array<{level: string, path: string, message: string}>} */
    const issues = [];
    if (!system || typeof system !== 'object') {
        return [{ level: SEVERITY.ERROR, path: '', message: '战力体系不是对象' }];
    }
    if (!Array.isArray(system.combatants) || system.combatants.length === 0) {
        issues.push({ level: SEVERITY.ERROR, path: 'combatants', message: '没有任何战斗单位，无法开战' });
        return issues;
    }

    const nameCount = new Map();
    system.combatants.forEach((/** @type {any} */ unit, /** @type {number} */ i) => {
        const path = `combatants[${i}]`;
        if (!unit.name) issues.push({ level: SEVERITY.ERROR, path, message: '单位缺少名字' });
        const key = `${unit.side}::${unit.name}`;
        nameCount.set(key, (nameCount.get(key) ?? 0) + 1);

        if (!unit.attributes?.HP || unit.attributes.HP.max <= 0) {
            issues.push({ level: SEVERITY.ERROR, path: `${path}.HP`, message: `${unit.name} 的 HP 上限为 0` });
        }
        if (unit.attributes?.HP && unit.attributes.HP.current > unit.attributes.HP.max) {
            issues.push({ level: SEVERITY.WARNING, path: `${path}.HP`, message: `${unit.name} 当前 HP 超过上限，已截断` });
        }
        if (!unit.skills?.length) {
            issues.push({ level: SEVERITY.WARNING, path: `${path}.skills`, message: `${unit.name} 没有技能，只能用普通攻击` });
        }
        for (const skill of unit.skills ?? []) {
            if (!skill.power && !skill.effects?.some((/** @type {any} */ e) => e.power)) {
                issues.push({
                    level: SEVERITY.WARNING,
                    path: `${path}.skills.${skill.name}`,
                    message: `技能「${skill.name}」没有 power，伤害会是 0`,
                });
            }
            if (skill.unknownTags?.length) {
                issues.push({
                    level: SEVERITY.INFO,
                    path: `${path}.skills.${skill.name}`,
                    message: `技能「${skill.name}」含未识别标签：${skill.unknownTags.join('、')}（已原样保留，未参与结算）`,
                });
            }
        }
    });

    for (const [key, count] of nameCount) {
        if (count > 1) {
            const [side, name] = key.split('::');
            issues.push({
                level: SEVERITY.WARNING,
                path: 'combatants',
                message: `${side === SIDE.ALLY ? '我方' : side === SIDE.ENEMY ? '敌方' : '中立'}存在 ${count} 个同名单位「${name}」`,
            });
        }
    }

    if (!system.combatants.some((/** @type {any} */ u) => u.side === SIDE.ALLY)) {
        issues.push({ level: SEVERITY.WARNING, path: 'combatants', message: '没有我方单位，无法开战' });
    }
    if (!system.combatants.some((/** @type {any} */ u) => u.side === SIDE.ENEMY)) {
        issues.push({ level: SEVERITY.WARNING, path: 'combatants', message: '没有敌方单位，无法开战' });
    }

    return issues;
}

// ---------------------------------------------------------------------------
// Combat_block 文本 ↔ 结构化 JSON
// ---------------------------------------------------------------------------

/**
 * 把结构化战斗单位序列化成 Combat_block 里的属性串。
 * @param {object} unit
 * @returns {string}
 */
export function formatAttributeString(unit) {
    const attrs = unit?.attributes ?? {};
    const parts = [];
    for (const key of CORE_ATTRIBUTES) {
        const pool = attrs[key];
        if (!pool) continue;
        if (POOLED_ATTRIBUTES.includes(key)) parts.push(`[${key}:${pool.current}/${pool.max}]`);
        else parts.push(`[${key}:${pool.current}]`);
    }
    // 自定义属性（剑气、道行之类）跟在后面，保证不丢
    for (const [key, pool] of Object.entries(attrs)) {
        if (CORE_ATTRIBUTES.includes(key) || key === 'Evasion') continue;
        parts.push(`[${key}:${pool.current}${pool.max && pool.max !== pool.current ? `/${pool.max}` : ''}]`);
    }
    if (attrs.Evasion) parts.push(`[Evasion:${attrs.Evasion.current}]`);
    return parts.join('');
}

/**
 * 把一个技能序列化成 `【名字】[标签]` 形式。
 * 优先使用原始标签，保证「原样回写」不丢信息。
 * @param {object} skill
 * @returns {string}
 */
export function formatSkillLine(skill) {
    const tags = [];
    if (Array.isArray(skill?.tags) && skill.tags.length) {
        // 原始标签里已经带了目标/power/aim/mp 时直接复用
        const hasTarget = skill.tags.some((/** @type {string} */ t) => /^[单群]/.test(t));
        const hasPower = skill.tags.some((/** @type {string} */ t) => /power/i.test(t) || /威力/.test(t));
        tags.push(...skill.tags);
        if (!hasTarget) tags.unshift(skill.target === 'group' ? '群攻' : '单体');
        if (!hasPower && skill.power) tags.push(`power:${skill.power}`);
        if (!skill.tags.some((/** @type {string} */ t) => /aim/i.test(t)) && skill.aim) tags.push(`Aim:${skill.aim}`);
        if (!skill.tags.some((/** @type {string} */ t) => /mp/i.test(t)) && skill.cost) tags.push(`MP:${skill.cost}`);
    } else {
        tags.push(skill?.target === 'group' ? '群攻' : '单体');
        for (const effect of skill?.effects ?? []) {
            if (effect.type === 'damage') continue;
            const prefix = skill.target === 'group' ? '群' : '单';
            const zh = { heal: '回', mp: '回蓝', buff: '增', debuff: '降', shield: '盾', taunt: '嘲', dispel: '驱散', cleanse: '净化' }[
                effect.type
            ];
            if (zh) tags.push(`${prefix}${zh}${effect.power ? `;power:${effect.power}` : ''}`);
        }
        if (skill?.power) tags.push(`power:${skill.power}`);
        if (skill?.aim) tags.push(`Aim:${skill.aim}`);
        if (skill?.cost) tags.push(`MP:${skill.cost}`);
    }
    return `【${skill?.name ?? '未命名'}】${tags.filter(Boolean).map((t) => `[${t}]`).join('')}`;
}

/**
 * 把结构化单位序列化成 Combat_block 风格的可读文本块（用于注入正文，让 AI 看到战况）。
 * @param {object} unit
 * @param {string} [indent]
 * @returns {string}
 */
export function formatCombatantBlock(unit, indent = '    ') {
    const lines = [];
    lines.push(`${indent}- 角色:`);
    lines.push(`${indent}    名字: "${unit.name}"`);
    const tierPart = unit.tier ? `[${unit.tier}]` : '';
    lines.push(`${indent}    属性: "${tierPart}${formatAttributeString(unit)}"`);

    // 战力评估：把评分与档位一起写出来，让模型知道「这个人大概什么水平」
    const rating = unit.powerRating;
    if (rating && (rating.rating > 0 || rating.grade)) {
        const score = rating.rating > 0 ? `战力 ${rating.rating}/100` : '战力未评分';
        const grade = rating.grade ? `（${rating.grade}）` : '';
        const note = rating.note ? ` —— ${rating.note}` : '';
        lines.push(`${indent}    战力: "${score}${grade}${note}"`);
    }

    if (unit.statuses?.length) {
        const text = unit.statuses
            .map((/** @type {any} */ s) => `${s.name}${s.duration ? `(${s.duration}回合)` : ''}${s.stacks > 1 ? `x${s.stacks}` : ''}`)
            .join('、');
        lines.push(`${indent}    状态: "${text}"`);
    }
    // 装备：把属性增益一起写出来，这样模型能看出「这把剑给了他多少攻击」
    if (unit.equipment?.length) {
        const text = unit.equipment
            .map((/** @type {any} */ e) => {
                const bonus = formatEquipmentBonuses(e);
                const slot = SLOT_LABEL[e.slot] ?? '';
                const checkTags = [['attack', '攻击'], ['defense', '防御']].map(([key, label]) =>
                    ['advantage', 'disadvantage'].includes(e.checks?.[key]) ? `[${label}检定:${e.checks[key] === 'advantage' ? '优势' : '劣势'}]` : '').join('');
                const mode = e.bonusMode === 'additive' ? '[bonusMode:additive]' : '';
                const equipped = e.equipped === false ? '[equipped:false]' : '';
                return `${slot ? `${slot}·` : ''}${e.name}${bonus ? `[${bonus}]` : ''}${checkTags}${mode}${equipped}${e.effect ? `(${e.effect})` : ''}`;
            })
            .join('、');
        lines.push(`${indent}    装备: "${text}"`);
    }
    if (unit.skills?.length) {
        lines.push(`${indent}    技能:`);
        for (const skill of unit.skills) {
            const cd = skill.cooldownLeft > 0 ? `[冷却:${skill.cooldownLeft}]` : '';
            lines.push(`${indent}      - "${formatSkillLine(skill)}${cd}"`);
        }
    }
    if (unit.notes) lines.push(`${indent}    备注: "${unit.notes}"`);
    return lines.join('\n');
}

/**
 * 把整个战力体系序列化成 `<Combat_block>` 文本。
 * 这是「默认输出 Combat_block 文本」选项的实现。
 * @param {object} system
 * @param {{includeEmpty?: boolean, maxUnits?: number}} [opts]
 * @returns {string}
 */
export function toCombatBlock(system, opts = {}) {
    const allies = (system?.combatants ?? []).filter((/** @type {any} */ u) => u.side === SIDE.ALLY);
    const enemies = (system?.combatants ?? []).filter((/** @type {any} */ u) => u.side === SIDE.ENEMY);
    const neutrals = (system?.combatants ?? []).filter((/** @type {any} */ u) => u.side === SIDE.NEUTRAL);

    const lim = (list) => (opts.maxUnits ? list.slice(0, opts.maxUnits) : list);

    const lines = ['<Combat_block>', '战斗数据栏:'];
    if (allies.length || opts.includeEmpty) {
        lines.push('  我方列表:');
        for (const unit of lim(allies)) lines.push(formatCombatantBlock(unit));
    }
    if (enemies.length || opts.includeEmpty) {
        lines.push('  敌方列表:');
        for (const unit of lim(enemies)) lines.push(formatCombatantBlock(unit));
    }
    if (neutrals.length) {
        lines.push('  中立列表:');
        for (const unit of lim(neutrals)) lines.push(formatCombatantBlock(unit));
    }
    lines.push('</Combat_block>');
    return lines.join('\n');
}

/**
 * 解析 `formatCombatantBlock` 写出的装备行，用于往返一致。
 *
 * 形如：`武器·青莲剑[Atk+30 Speed+10](斩铁)、饰品·护心玉佩[HP+100]`
 * @param {string} text
 * @returns {object[]}
 */
export function parseEquipmentLine(text) {
    const raw = String(text ?? '').trim();
    if (!raw) return [];
    /** @type {object[]} */
    const out = [];
    // 按顿号切分（装备名里极少出现顿号）
    for (const piece of raw.split(/[、,，]/).map((s) => s.trim()).filter(Boolean)) {
        // 部位前缀：`武器·` / `饰品·`
        let slot = EQUIP_SLOT.OTHER;
        let rest = piece;
        const slotMatch = piece.match(/^(武器|防具|饰品|其它)\s*·\s*/);
        if (slotMatch) {
            slot = normalizeSlot(slotMatch[1]);
            rest = piece.slice(slotMatch[0].length);
        }
        // 附加效果：括号里的内容
        const effectMatch = rest.match(/[（(]([^）)]*)[）)]\s*$/);
        const effect = effectMatch ? effectMatch[1].trim() : '';
        if (effectMatch) rest = rest.slice(0, effectMatch.index).trim();
        // 复用统一装备协议，保留 d20 优劣势、additive 与未装备标记。
        const normalized = normalizeEquipment(piece);
        if (!normalized) continue;
        out.push({ ...normalized, slot: slotMatch ? slot : normalized.slot, effect, description: '', source: '' });
    }
    return out;
}

/**
 * 解析 `<Combat_block>` 文本为结构化战力体系。
 * 用于战斗开场结构化结果的兼容解析。
 * @param {string} text
 * @returns {object|null} 解析失败返回 null
 */
export function parseCombatBlock(text) {
    const source = String(text ?? '');
    if (!source.trim()) return null;

    /** @type {any[]} */
    const allies = [];
    /** @type {any[]} */
    const enemies = [];
    /** @type {any[]} */
    const neutrals = [];

    /** @type {any[]|null} */
    let bucket = null;
    /** @type {any} */
    let current = null;

    /** 收尾当前角色 */
    const flush = () => {
        if (current && bucket) bucket.push(current);
        current = null;
    };

    const lines = source.split(/\r?\n/);
    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || /^<\/?Combat_block>/i.test(line) || /^战斗数据栏/.test(line)) continue;

        // 分组标题
        const groupMatch = line.match(/^(我方列表|敌方列表|中立列表|友方列表|敌人列表)\s*[:：]?$/);
        if (groupMatch) {
            flush();
            bucket = groupMatch[1].startsWith('我') || groupMatch[1].startsWith('友')
                ? allies
                : groupMatch[1].startsWith('中立')
                  ? neutrals
                  : enemies;
            continue;
        }

        // 新角色开始
        if (/^-\s*角色\s*[:：]?$/.test(line)) {
            flush();
            if (!bucket) bucket = allies; // 没有分组标题时的兜底
            current = { name: '', attributes: {}, skills: [], statuses: [], notes: '' };
            continue;
        }

        if (!current) continue;

        const kv = (label) => line.match(new RegExp(`^${label}\\s*[:：]\\s*(.*)$`));
        let m;
        if ((m = kv('名字'))) {
            current.name = m[1].replace(/^["'“”]|["'“”]$/g, '').trim();
            continue;
        }
        if ((m = kv('属性'))) {
            current.attrText = m[1].replace(/^["'“”]|["'“”]$/g, '').trim();
            continue;
        }
        if ((m = kv('状态'))) {
            const text = m[1].replace(/^["'“”]|["'“”]$/g, '').trim();
            current.statuses = text ? text.split(/[、,，]/).map((s) => s.trim()).filter(Boolean) : [];
            continue;
        }
        if ((m = kv('装备'))) {
            const text = m[1].replace(/^["'“”]|["'“”]$/g, '').trim();
            current.equipment = parseEquipmentLine(text);
            continue;
        }
        if ((m = kv('备注'))) {
            current.notes = m[1].replace(/^["'“”]|["'“”]$/g, '').trim();
            continue;
        }
        if (/^技能\s*[:：]?$/.test(line)) continue;

        // `- "【技能】[标签]"` 形态的技能行
        if (/^-\s*["'“”]?【/.test(line)) {
            const skillText = line.replace(/^-\s*/, '').replace(/^["'“”]|["'“”]$/g, '').trim();
            if (skillText) current.skills.push(skillText);
            continue;
        }
    }
    flush();

    if (!allies.length && !enemies.length && !neutrals.length) return null;

    return normalizePowerSystem({
        system: { name: 'Combat_block' },
        allies,
        enemies,
        neutral: neutrals,
        meta: { note: '由 Combat_block 文本解析' },
    });
}

// ---------------------------------------------------------------------------
// 战力体系质量自检（「检验失败」的判定依据）
// ---------------------------------------------------------------------------

/** 质量问题的严重级别。 */
export const QUALITY_LEVEL = Object.freeze({
    /** 致命：这样建出来的表没法用来打 */
    FATAL: 'fatal',
    /** 警告：能用，但明显不可靠 */
    WARN: 'warn',
});

/**
 * 给战力体系做一次**质量自检**，判断「这张表到底能不能用」。
 *
 * 与 `validatePowerSystem` 的分工：
 *  - `validatePowerSystem` 查**结构**（有没有单位、HP 是不是 0、重名）—— 防崩溃
 *  - 这个函数查**内容质量** —— 防「结构没问题但根本没法打」
 *
 * 典型的不合格情形：世界书里全是纯文字、模型什么都没读出来，
 * 于是给了一堆 HP 100 / 技能空 / 所有人评分一样的角色。结构上完全合法，
 * 但拿去战斗毫无意义。这种情况就该提示用户「检验失败」并给出补救路径。
 *
 * @param {object} system
 * @returns {{ok: boolean, fatal: string[], warn: string[], stats: object}}
 */
export function checkPowerSystemQuality(system) {
    /** @type {string[]} */
    const fatal = [];
    /** @type {string[]} */
    const warn = [];

    const units = system?.combatants ?? [];
    const allies = units.filter((/** @type {any} */ u) => u.side === SIDE.ALLY);
    const enemies = units.filter((/** @type {any} */ u) => u.side === SIDE.ENEMY);

    if (!units.length) {
        return {
            ok: false,
            fatal: ['一个战斗单位都没有'],
            warn: [],
            stats: { units: 0 },
        };
    }

    // ---- 致命问题 ----
    if (!allies.length) fatal.push('没有任何我方单位');
    if (!enemies.length) fatal.push('没有任何敌方单位');

    const withSkills = units.filter((/** @type {any} */ u) => u.skills?.length);
    if (withSkills.length === 0) {
        fatal.push('所有角色都没有技能 —— 战斗只能靠普通攻击，判定会很单调');
    }

    // 属性全是兜底值（HP 上限 ≤ 10）说明模型没读到任何数值
    const fallbackHp = units.filter((/** @type {any} */ u) => (u.attributes?.HP?.max ?? 0) <= 10);
    if (fallbackHp.length === units.length) {
        fatal.push('所有角色的 HP 上限都 ≤ 10 —— 说明世界书里没读到任何数值');
    }

    // ---- 警告 ----
    if (!system?.ruleset) {
        warn.push('没有读出战斗规则，将使用内置的通用 d20 规则');
    }
    if (!toText(system?.scale)) {
        warn.push('没有说明数值量纲 —— 跨体系比较强弱时会失真');
    }

    const rated = units.filter((/** @type {any} */ u) => (u.powerRating?.rating ?? 0) > 0);
    if (rated.length === 0) {
        warn.push('没有任何角色被评估战力 —— 「谁更强」这个问题回答不了');
    } else {
        // 评分挤在一起说明没认真区分强弱
        const ratings = rated.map((/** @type {any} */ u) => u.powerRating.rating);
        const min = Math.min(...ratings);
        const max = Math.max(...ratings);
        if (rated.length >= 3 && max - min < 15) {
            warn.push(`所有战力评分都挤在 ${min}~${max} 之间 —— 强弱没拉开，评分失去意义`);
        }
    }

    const withEquipment = units.filter((/** @type {any} */ u) => u.equipment?.length);
    if (withEquipment.length === 0) {
        warn.push('没有任何角色有装备信息');
    }
    if (units.length >= 3 && withSkills.length < units.length / 2) {
        warn.push(`只有 ${withSkills.length}/${units.length} 个角色有技能`);
    }

    return {
        ok: fatal.length === 0,
        fatal,
        warn,
        stats: {
            units: units.length,
            allies: allies.length,
            enemies: enemies.length,
            withSkills: withSkills.length,
            withEquipment: withEquipment.length,
            rated: rated.length,
            hasRuleset: Boolean(system?.ruleset),
        },
    };
}

/**
 * 把 P2 返回的增量 diff 合并进战力体系。
 *
 * 设计原则：**只做 diff，不做整体重写**。这样即使 LLM 这轮抽风，
 * 也最多改坏一两个字段，而不是把整张表重写掉。
 *
 * @param {object} system 现行战力体系（会被修改）
 * @param {object} diff P2 输出的 diff
 * @returns {{applied: string[], skipped: string[]}}
 */
export function applyDiff(system, diff) {
    /** @type {string[]} */
    const applied = [];
    /** @type {string[]} */
    const skipped = [];
    if (!system || !diff || typeof diff !== 'object') return { applied, skipped };

    const findUnit = (/** @type {string} */ name, /** @type {string} */ side) => {
        if (!name) return undefined;
        const target = system.combatants.find(
            (/** @type {any} */ u) => u.name === name && (!side || u.side === side),
        );
        return target;
    };

    // ---- added ----
    if (Array.isArray(diff.added)) {
        for (const entry of diff.added) {
            const unit = normalizeCombatant(entry, { side: entry?.side });
            if (!unit) {
                skipped.push(`新增单位缺少名字：${JSON.stringify(entry).slice(0, 80)}`);
                continue;
            }
            if (findUnit(unit.name, unit.side)) {
                skipped.push(`单位「${unit.name}」已存在，改用 updated 处理`);
                continue;
            }
            system.combatants.push(unit);
            applied.push(`新增单位「${unit.name}」`);
        }
    }

    // ---- updated ----
    if (Array.isArray(diff.updated)) {
        for (const entry of diff.updated) {
            const name = toText(entry?.name ?? entry?.名字);
            const target = findUnit(name, toText(entry?.side ?? entry?.阵营));
            if (!target) {
                skipped.push(`找不到要更新的单位「${name}」`);
                continue;
            }
            const changed = [];

            // 属性
            const attrs = entry.attributes ?? entry.属性;
            if (attrs && typeof attrs === 'object') {
                for (const [key, value] of Object.entries(attrs)) {
                    const canonical = canonicalAttributeKey(key);
                    const pool = normalizePool(value, target.attributes[canonical]?.max);
                    const before = target.attributes[canonical];
                    if (!before) {
                        target.attributes[canonical] = pool;
                        changed.push(`${canonical} ${pool.current}/${pool.max}`);
                    } else if (before.current !== pool.current || before.max !== pool.max) {
                        // 只给了当前值且小于上限时，保留原上限
                        const nextMax = pool.max > 0 && pool.max !== pool.current ? pool.max : before.max;
                        const nextCur = Math.min(pool.current, nextMax || pool.current);
                        changed.push(`${canonical} ${before.current}→${nextCur}`);
                        target.attributes[canonical] = { current: nextCur, max: nextMax };
                    }
                }
            }

            // 技能：按名字替换 / 新增
            const skills = entry.skills ?? entry.技能;
            if (Array.isArray(skills)) {
                for (const s of skills) {
                    const skill = normalizeSkill(s, target.skills.length);
                    if (!skill) continue;
                    const idx = target.skills.findIndex((/** @type {any} */ x) => x.name === skill.name);
                    if (idx >= 0) {
                        target.skills[idx] = { ...target.skills[idx], ...skill, id: target.skills[idx].id };
                        changed.push(`技能「${skill.name}」已更新`);
                    } else {
                        target.skills.push(skill);
                        changed.push(`学会技能「${skill.name}」`);
                    }
                }
            }

            // 装备：整体替换（和状态同理 —— 装备是易变的，剧情里随时可能换/丢/坏）
            const equipment = entry.equipment ?? entry.装备;
            if (Array.isArray(equipment)) {
                const before = (target.equipment ?? []).map((/** @type {any} */ e) => e.name).join('、');
                /** @type {object[]} */
                const next = [];
                const seen = new Set();
                for (const item of equipment) {
                    const normalized = normalizeEquipment(item, next.length);
                    if (!normalized) continue;
                    const key = `${normalized.slot}::${normalized.name}`;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    next.push(normalized);
                }
                target.equipment = next;
                const after = next.map((e) => e.name).join('、');
                if (before !== after) changed.push(`装备变为 ${after || '无'}`);
            }

            // 状态：整体替换（状态是易变的，适合直接覆盖）
            const statuses = entry.statuses ?? entry.状态;
            if (Array.isArray(statuses)) {
                target.statuses = statuses.map(normalizeStatus).filter(Boolean);
                changed.push(`状态更新为 ${target.statuses.map((/** @type {any} */ s) => s.name).join('、') || '无'}`);
            }

            // 等级 / 存活 / 备注
            if (entry.tier !== undefined || entry.等级 !== undefined || entry.境界 !== undefined) {
                const tier = toText(entry.tier ?? entry.等级 ?? entry.境界);
                if (tier && tier !== target.tier) {
                    changed.push(`等级 ${target.tier || '?'}→${tier}`);
                    target.tier = tier;
                }
            }
            if (entry.alive !== undefined) {
                const alive = Boolean(entry.alive);
                if (alive !== target.alive) {
                    changed.push(alive ? '复活' : '阵亡');
                    target.alive = alive;
                }
            }
            if (entry.notes !== undefined || entry.备注 !== undefined) {
                const notes = toText(entry.notes ?? entry.备注);
                if (notes && notes !== target.notes) {
                    target.notes = notes;
                    changed.push('备注已更新');
                }
            }

            if (changed.length) applied.push(`「${target.name}」：${changed.join('，')}`);
        }
    }

    // ---- hpChanges：显式的血量增减（最常见的一类变化） ----
    if (Array.isArray(diff.hpChanges)) {
        for (const entry of diff.hpChanges) {
            const name = toText(entry?.name ?? entry?.名字);
            const target = findUnit(name, toText(entry?.side ?? entry?.阵营));
            if (!target) {
                skipped.push(`血量变化找不到单位「${name}」`);
                continue;
            }
            const key = canonicalAttributeKey(toText(entry?.attribute ?? entry?.属性) || 'HP');
            const pool = target.attributes[key];
            if (!pool) {
                skipped.push(`单位「${name}」没有属性 ${key}`);
                continue;
            }
            const delta = toNumber(entry?.delta ?? entry?.变化) ?? 0;
            const absolute = toNumber(entry?.value ?? entry?.当前值);
            const before = pool.current;
            // 先把待应用的增量算出来，再统一 clamp 到 0..max —— 避免治疗溢出把血条顶穿
            const rawNext = absolute !== undefined && delta === 0 ? absolute : before + delta;
            const next = Math.max(0, Math.min(pool.max || rawNext, rawNext));
            if (next !== before) {
                pool.current = next;
                if (next <= 0 && key === 'HP') target.alive = false;
                if (next > 0 && key === 'HP') target.alive = true;
                applied.push(`「${name}」${key} ${before}→${next}（${delta >= 0 && absolute === undefined ? '+' : ''}${absolute !== undefined ? `${absolute}绝对值` : delta}）`);
            }
        }
    }

    // ---- removed ----
    if (Array.isArray(diff.removed)) {
        for (const entry of diff.removed) {
            const name = toText(typeof entry === 'string' ? entry : entry?.name ?? entry?.名字);
            const i = system.combatants.findIndex((/** @type {any} */ u) => u.name === name);
            if (i >= 0) {
                const [gone] = system.combatants.splice(i, 1);
                applied.push(`移除单位「${gone.name}」`);
            } else {
                skipped.push(`找不到要移除的单位「${name}」`);
            }
        }
    }

    // ---- notes ----
    if (diff.notes || diff.备注) {
        const note = toText(diff.notes ?? diff.备注);
        if (note) {
            system.meta.note = note;
            applied.push(`总体备注：${note}`);
        }
    }

    system.meta.updatedAt = Date.now();
    return { applied, skipped };
}

/**
 * 从文本里抽出 `<Combat_block>...</Combat_block>` 片段。
 * @param {string} text
 * @returns {string|null}
 */
export function extractCombatBlock(text) {
    const m = String(text ?? '').match(/<Combat_block>([\s\S]*?)<\/Combat_block>/i);
    return m ? m[0] : null;
}
