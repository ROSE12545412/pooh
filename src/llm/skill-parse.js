/**
 * tavern-dice / src/llm/skill-parse.js
 * ---------------------------------------------------------------------------
 * 从战况汇报的**表格行**里读出技能。优先解析这种格式：
 *
 *     - 技能名｜范围｜效果类型｜威力｜消耗｜持续回合｜回合豁免DC｜效果说明
 *     - 扰乱｜单体｜骰点减益｜0｜5｜2｜-｜命中后目标判定-2
 *     - 旧五列「技能名｜效果类型｜威力｜消耗｜一句话效果」仍兼容
 *
 * ## 设计原则：让模板规范，解析器只做「读」
 *
 * 早期版本试图在解析器里**猜**：从自由文本里抠「+10判定加值」「固定消耗100点蓝量」，
 * 再按**职业模板**补技能。这条路是错的 ——
 * 一千张卡就有一千种职业，猜不完；而且模型会写「剧情未展开」这类推辞，
 * 怎么猜都是垃圾。
 *
 * 所以现在的分工是：
 *   - **提示词**把格式规范到没法含糊（管道分隔的表格行、效果类型给闭集、威力消耗要求纯数字）
 *   - **解析器**只老实读这个格式，外加宽容地兼容旧写法
 *   - 职业模板**降级为最后兜底**，只在彻底读不出技能时用一条通用技，避免角色只能普攻
 */

import { normalizeSaveDc, parseExplicitModifiers, toText } from '../core/schema.js';

/** 效果类型的闭集（提示词里也是这几个词）。 */
const EFFECT_WORDS = {
    伤害: 'damage',
    治疗: 'heal',
    护盾: 'shield',
    增益: 'buff',
    减益: 'debuff',
    控制: 'control',
    持续伤害: 'dot',
    骰点减益: 'debuff',
    回蓝: 'mp',
    嘲讽: 'taunt',
    驱散: 'dispel',
    净化: 'cleanse',
    复活: 'revive',
    其他: 'other',
    mp: 'mp',
    taunt: 'taunt',
    dispel: 'dispel',
    cleanse: 'cleanse',
    revive: 'revive',
    other: 'other',
    // 英文与近义词也认，兼容模型自由发挥
    damage: 'damage',
    heal: 'heal',
    shield: 'shield',
    buff: 'buff',
    debuff: 'debuff',
    control: 'control',
    dot: 'dot',
    攻击: 'damage',
    回复: 'heal',
    防御: 'shield',
    强化: 'buff',
    削弱: 'debuff',
    眩晕: 'control',
    中毒: 'dot',
};

/** 效果类型的关键词（旧写法兜底）。 */
const EFFECT_KEYWORDS = [
    { type: 'heal', words: ['治愈', '治疗', '回复', '回血', '疗伤', '止血', '愈合'] },
    { type: 'shield', words: ['护盾', '格挡', '招架', '防御', '减伤', '卸力', '罡气'] },
    { type: 'debuff', words: ['中毒', '削弱', '减速', '封印', '压制', '威慑', '威压', '封锁'] },
    { type: 'buff', words: ['强化', '增益', '提升', '加速', '集中', '专注', '蓄力', '加持'] },
    { type: 'dot', words: ['持续伤害', '灼烧', '燃烧', '流血', '腐蚀'] },
    { type: 'control', words: ['定身', '眩晕', '禁锢', '束缚', '缴械', '击退'] },
];

/** 目标类型关键词。 */
const TARGET_KEYWORDS = [
    { target: 'group', words: ['群攻', '范围', '全体', '群体', '溅射', '横扫', 'aoe'] },
    { target: 'self', words: ['自身', '自我', '己身', '自疗', '净化自身'] },
    { target: 'all', words: ['全场', '所有单位'] },
    { target: 'random', words: ['随机'] },
];

/** 推辞式文字的特征（模型的免责声明，不是技能）。 */
const REFUSAL_RE =
    /剧情|设定|原文|未展开|未提及|未明确|未施展|未量化|未给出|只提到|仅提到|未登场|未知|待补|暂无|无技能|其余|^[*※（(【\s]*(说明|注|备注)/;

/**
 * 清理一行技能文本：去掉列表符号与首尾空白。
 * @param {string} line
 * @returns {string}
 */
function cleanLine(line) {
    return toText(line)
        .replace(/^\s*[-*+•]\s*/, '')
        .replace(/^\s*\d+[.)]\s*/, '')
        .trim();
}

/** 显式范围列不再依赖招式名或描述里的「全体」「范围」等词。 */
function explicitTarget(value) {
    const text = toText(value).replace(/[\s（(）)]/g, '').toLowerCase();
    return {
        单体: 'single', single: 'single', 群体: 'group', 群体aoe: 'group', 群攻: 'group', aoe: 'group', group: 'group',
        自身: 'self', self: 'self', 全体: 'all', all: 'all', 随机: 'random', random: 'random',
    }[text];
}

/** 复合类型按分隔符展开，持续伤害作为完整词，不拆成即时伤害。 */
function explicitEffectTypes(value) {
    return [...new Set(toText(value).toLowerCase().split(/[+＋/、,，;；&＆]/)
        .map((word) => EFFECT_WORDS[word.replace(/[\s（(）)]/g, '')]).filter(Boolean))];
}

/** 八列表数值不从定性描述、百分比或缺失值估算。 */
function explicitNumber(value) {
    const text = toText(value);
    if (!/^\d+(?:\.\d+)?$/.test(text)) return undefined;
    const number = Number(text);
    return Number.isFinite(number) ? number : undefined;
}

/** 每种效果可用「持续伤害=18」或「持续伤害威力18」明确覆盖公共威力。 */
function effectPower(text, type) {
    const labels = {
        即时伤害: 'damage', 持续伤害: 'dot', 每跳伤害: 'dot', 每回合伤害: 'dot',
        伤害: 'damage', 治疗: 'heal', 护盾: 'shield', 回蓝: 'mp', 每跳: 'dot',
        damage: 'damage', heal: 'heal', shield: 'shield', mp: 'mp', dot: 'dot', tick: 'dot',
    };
    // 一起扫描长短标签，避免把「持续伤害」内部的「伤害」当成另一项即时威力。
    const pattern = new RegExp(
        `(?<![A-Za-z0-9_])(${Object.keys(labels).join('|')})\\s*(?:威力\\s*[:：=]?|[:：=])\\s*(\\d+(?:\\.\\d+)?)(?![\\d.]|\\s*[%％])`, 'gi',
    );
    for (const match of toText(text).matchAll(pattern)) {
        if (labels[match[1].toLowerCase()] === type) return explicitNumber(match[2]);
    }
    return undefined;
}

/**
 * 解析八列显式技能契约，同时保留旧五列表兼容。
 * 支持全角 ｜ 与半角 |，允许两侧有空格。
 * @param {string} line
 * @param {{tier?: string}} [opts]
 * @returns {object|null}
 */
export function parsePipeSkill(line, opts = {}) {
    const raw = cleanLine(line);
    if (!raw) return null;

    // 全角/半角竖线都要认；模型偶尔用｜与|混写
    const parts = raw.split(/[｜|]/).map((x) => x.trim());
    if (parts.length < 3) return null;

    const name = parts[0].replace(/^[【\[]|[】\]]$/g, '').trim();
    if (!name || REFUSAL_RE.test(name)) return null;

    const isExplicit = parts.length >= 8 && (explicitTarget(parts[1]) !== undefined || explicitEffectTypes(parts[2]).length > 0);
    const typeColumn = parts[isExplicit ? 2 : 1];
    const listedTypes = explicitEffectTypes(typeColumn);
    const powerColumn = parts[isExplicit ? 3 : 2];
    const power = isExplicit ? explicitNumber(powerColumn) : toNumberSafe(powerColumn);
    const cost = isExplicit ? explicitNumber(parts[4]) : toNumberSafe(parts[3]);
    const description = parts.slice(isExplicit ? 7 : 4).join('｜').trim() || name;

    // 新表分类完全由显式列决定；旧表才保留描述推断。未知类型保留为 other。
    const effects = listedTypes.length ? listedTypes : isExplicit ? ['other'] : parseEffects(`${name} ${description}`, 0);
    const target = isExplicit ? explicitTarget(parts[1]) ?? 'single' : parseTarget(`${name} ${description}`);
    const advantage = parseSkillAdvantage(description, effects);
    const modifiers = parseExplicitModifiers(description);
    const duration = isExplicit ? explicitNumber(parts[5]) : undefined;
    const saveDc = isExplicit ? normalizeSaveDc(parts[6]) ?? 10 : undefined;
    const powerText = `${powerColumn}；${description}`;
    const basePower = power ?? (isExplicit ? effectPower(powerText, effects[0]) ?? 0 : estimatePower(opts.tier ?? ''));

    return {
        name: name.slice(0, 60),
        description: description.slice(0, 300),
        target,
        power: isExplicit && effects.includes('damage') ? effectPower(powerText, 'damage') ?? basePower : basePower,
        aim: 100 + advantage.bonus * 10,
        cost: cost ?? (isExplicit ? 0 : 10),
        cooldown: 0,
        cooldownLeft: 0,
        effects: effects.map((type) => {
            const persistent = ['dot', 'debuff', 'buff', 'control', 'taunt'].includes(type);
            const numeric = ['damage', 'heal', 'shield', 'dot', 'mp'].includes(type);
            return {
                type,
                power: numeric ? (isExplicit ? effectPower(powerText, type) ?? basePower : Math.round((power ?? 120) * 0.6)) : 0,
                duration: persistent ? (Number.isInteger(duration) && duration >= 1 ? duration : 2)
                    : type === 'shield' && Number.isInteger(duration) ? duration : 0,
                ...(isExplicit && (type === 'control' || type === 'dot') ? { saveDc } : {}),
                description,
                modifiers: type === 'buff' || type === 'debuff' ? modifiers : [],
            };
        }),
        tags: [],
        unknownTags: [],
        advantage: advantage.bonus,
        advantageNote: advantage.note,
        source: '战况汇报（表格）',
    };
}

/** 宽松取数字：`120` / `120 点` / `约120` 都能读。 */
function toNumberSafe(value) {
    const t = toText(value);
    const m = t.match(/([+-]?\d{1,4})/);
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : null;
}

/**
 * 把「判定优势」的文字换算成命中加成（旧写法的兼容路径）。
 * @param {string} text
 * @returns {{bonus: number, note: string}}
 */
export function parseAdvantage(text) {
    const t = toText(text).replace(/＋/g, '+').replace(/[−－]/g, '-');
    // 只读取明确的判定加值；减伤、速度、年龄、持续时间及定性优势不折算成命中。
    const label = '(?:判定(?:加值|优势|加成)?|优势(?:加值)?|命中(?:判定|加值|加成)?)';
    const number = '[+-]\\s*(?:\\d+(?:\\.\\d+)?|\\.\\d+)';
    const contextual = t.match(new RegExp(
        `${label}\\s*[:：=]?\\s*(${number})(?![\\d.]|\\s*[%％])|(${number})\\s*(?:点)?\\s*${label}`,
    ));
    const value = contextual ? Number((contextual[1] ?? contextual[2]).replace(/\s/g, '')) : 0;
    return { bonus: Number.isFinite(value) ? value : 0, note: t.slice(0, 120) };
}

/** 状态效果中的命中数值属于目标状态；施放判定须明确标注归属。 */
function parseSkillAdvantage(text, effects) {
    if (!effects.some((type) => ['buff', 'debuff', 'control', 'dot'].includes(type))) {
        // 「目标判定」即使误写在纯伤害说明里，也不能降低施放者的 Aim。
        return parseAdvantage(toText(text).replace(/(?:目标|对方|敌方|受击者)[^，,；;。\n]*/g, ''));
    }
    const casting = toText(text).match(/(?:本次(?:攻击|施放|技能)?|此次(?:攻击|施放|技能)?|技能自身|施放|施展)(?:的)?\s*(?:命中)?判定(?:加值|优势|加成)?\s*[:：=]?\s*[+＋\-−－]\s*(?:\d+(?:\.\d+)?|\.\d+)(?![\d.]|\s*[%％])/);
    return parseAdvantage(casting?.[0] ?? '');
}

/**
 * 把「消耗」的文字换算成 MP 消耗（旧写法的兼容路径）。
 * @param {string} text
 * @returns {number}
 */
export function parseMpCost(text) {
    const t = toText(text);
    const m = t.match(/(?:固定)?\s*消耗\s*([+-]?\d{1,4})\s*(?:点|MP|mp)?/);
    if (m) return Math.max(0, Math.min(9999, Number(m[1])));
    if (/无消耗|不消耗|无需消耗|不需消耗/.test(t)) return 0;
    const m2 = t.match(/([+-]?\d{1,4})\s*(?:点|MP|mp)\s*(?:蓝量|魔力|斗气|法力|MP)/);
    if (m2) return Math.max(0, Math.min(9999, Number(m2[1])));
    return 0;
}

/**
 * 从技能描述判断目标类型。
 * @param {string} text
 * @returns {string}
 */
export function parseTarget(text) {
    const t = toText(text);
    for (const { target, words } of TARGET_KEYWORDS) {
        if (words.some((w) => t.includes(w))) return target;
    }
    return 'single';
}

/**
 * 从技能描述判断效果类型。
 * @param {string} text
 * @param {number} [advantage]
 * @returns {string[]}
 */
export function parseEffects(text, advantage = 0) {
    const t = toText(text);
    /** @type {string[]} */
    const found = [];
    for (const { type, words } of EFFECT_KEYWORDS) {
        if (words.some((w) => t.includes(w))) found.push(type);
    }
    if (!found.length) {
        if (/瞬移|位移|传送|闪现/.test(t)) found.push('buff');
        else if (/攻击|斩|劈|刺|击|斩击|突刺|轰|爆|斩天|撕裂|贯穿/.test(t) || advantage > 0) found.push('damage');
        else found.push('buff');
    }

    // 分类修正：攻击技不该因为描述里有「屏障」被归成护盾；位移与治疗不算伤害
    const offensive = /攻击|斩|劈|刺|突刺|轰|爆|剑意|斩天|撕裂|贯穿/.test(t);
    let out = found;
    if (offensive && !/治愈|治疗|回复|回血/.test(t)) {
        out = out.filter((x) => x !== 'shield');
        if (!out.includes('damage')) out.unshift('damage');
    }
    if (/瞬移|位移|传送|闪现/.test(t)) out = out.filter((x) => x !== 'damage');
    if (out.includes('heal')) out = out.filter((x) => x !== 'damage');
    return out.length ? out : ['damage'];
}

/**
 * 按位阶估算技能的威力基准（只在表格没给威力时用）。
 * @param {string} tierText
 * 判定加值不改变威力，避免同一来源同时被算进命中与伤害。
 * @returns {number}
 */
export function estimatePower(tierText) {
    const t = toText(tierText);
    let base = 120;
    if (/天花板|传说|神话|最强|神级|宇宙/.test(t)) base = 420;
    else if (/上级|一流|精英|强者|大师|S级/.test(t)) base = 260;
    else if (/中级|中坚|二流|老兵|熟练|A级|B级/.test(t)) base = 170;
    else if (/初级|下级|三流|新手|杂兵|见习/.test(t)) base = 100;
    else if (/幼童|孩童|小孩|凡人|平民|无阶/.test(t)) base = 70;

    let nature = 1;
    if (/终极|最强|究极|神级|不可知|虚空|撕裂一切|灭世|碾压/.test(t)) nature = 2.6;
    else if (/绝招|奥义|秘术|禁术|全力|致命/.test(t)) nature = 1.7;
    else if (/基础|初级|简单|普通/.test(t)) nature = 0.8;

    return Math.max(20, Math.min(1000, Math.round(base * nature)));
}

/**
 * 解析**旧写法**的技能行（自由文本形态）。
 *
 * 这是兼容路径：如果提示词按新格式输出，走 `parsePipeSkill`；
 * 用户自定义了旧模板时走这里。
 *
 * @param {string} line
 * @param {{tier?: string}} [opts]
 * @returns {object|null}
 */
export function parseSkillLine(line, opts = {}) {
    // 管道格式优先
    const piped = parsePipeSkill(line, opts);
    if (piped) return piped;

    const raw = cleanLine(line);
    if (!raw || REFUSAL_RE.test(raw)) return null;
    if (/^[（(][^）)]{0,40}[）)]$/.test(raw)) return null;

    let name = '';
    let detail = '';
    const colon = raw.match(/^([^：:]{1,30})[：:]\s*([\s\S]*)$/);
    if (colon) {
        name = toText(colon[1]).replace(/^[【\[]|[】\]]$/g, '').trim();
        detail = toText(colon[2]);
    } else {
        const parenMatch = raw.match(/^([^（(]{1,30})[（(]([\s\S]*)[）)]\s*$/);
        if (parenMatch) {
            name = toText(parenMatch[1]).trim();
            detail = toText(parenMatch[2]);
        } else {
            name = raw;
        }
    }
    if (!name || REFUSAL_RE.test(name)) return null;

    const haystack = `${name} ${detail} ${raw}`;
    const cost = parseMpCost(haystack);
    const target = parseTarget(haystack);
    const effects = parseEffects(haystack, parseAdvantage(haystack).bonus);
    const advantage = parseSkillAdvantage(haystack, effects);
    const power = estimatePower(`${opts.tier ?? ''} ${name} ${detail}`);
    const aim = 100 + advantage.bonus * 10;
    const modifiers = parseExplicitModifiers(detail);

    return {
        name: name.slice(0, 60),
        description: (detail || raw).slice(0, 300),
        target,
        power,
        aim,
        cost,
        cooldown: 0,
        cooldownLeft: 0,
        effects: effects.map((type) => ({
            type,
            power: type === 'damage' || type === 'heal' || type === 'shield' || type === 'dot' ? Math.round(power * 0.6) : 0,
            duration: type === 'dot' || type === 'debuff' || type === 'buff' ? 2 : 0,
            description: detail || raw,
            modifiers: type === 'buff' || type === 'debuff' ? modifiers : [],
        })),
        tags: [],
        unknownTags: [],
        advantage: advantage.bonus,
        advantageNote: advantage.note,
        source: '战况汇报（自由文本）',
    };
}

/**
 * 解析一整块技能文本。
 * @param {string[]} lines
 * @param {{tier?: string}} [opts]
 * @returns {object[]}
 */
export function parseSkillBlock(lines, opts = {}) {
    /** @type {object[]} */
    const out = [];
    const seen = new Set();

    for (const line of lines ?? []) {
        // 分号分隔的多个技能要在**原始行**上拆
        const text = String(line ?? '');
        // 管道行最后一列里的分号可能分隔同一效果的多个属性，不能拆成新技能。
        const pieces = (/[｜|]/.test(text) ? [text] : text.split(/[；;]/))
            .map((x) => x.trim())
            .filter(Boolean);

        for (const piece of pieces) {
            const skill = parseSkillLine(piece, opts);
            if (!skill || seen.has(skill.name)) continue;
            seen.add(skill.name);
            out.push(skill);
        }
    }
    return out;
}

/**
 * 按位阶文字推定战力评分（0~100）。
 * @param {string} tierText
 * @returns {{rating: number, grade: string}}
 */
export function estimateRating(tierText) {
    const t = toText(tierText);
    const table = [
        { rating: 95, grade: '天花板', re: /天花板|传说|神话|最强|神级|宇宙|不可测|无穷/ },
        { rating: 82, grade: '顶尖', re: /顶尖|上级|S级|大师|一流|精英|强者|化神|元婴/ },
        { rating: 62, grade: '一流', re: /一流|中坚|金丹|A级|熟练|老兵/ },
        { rating: 45, grade: '二流', re: /二流|中级|筑基|B级|正规/ },
        { rating: 30, grade: '三流', re: /三流|初级|下级|炼气|C级|见习|杂兵/ },
        { rating: 12, grade: '凡人', re: /凡人|平民|路人|无阶|幼童|孩童|幼子/ },
    ];
    for (const row of table) {
        if (row.re.test(t)) return { rating: row.rating, grade: row.grade };
    }
    return { rating: 40, grade: '' };
}

/**
 * 最后兜底：彻底读不出技能时，给一条**通用**技能，避免这个角色只能普攻。
 *
 * ⚠️ 这里刻意**不按职业猜**（一千张卡就有一千种职业，猜不完）。
 * 名称与效果都保持中性，让人一眼看出这是占位、需要用户自己改。
 *
 * @param {{name?: string, tier?: string}} unitInfo
 * @returns {object[]}
 */
export function buildFallbackSkill(unitInfo) {
    const power = estimatePower(toText(unitInfo?.tier));
    return [
        {
            name: '全力一击',
            description: '倾尽全力的一击（系统兜底生成，可在战力表里改）',
            target: 'single',
            power,
            aim: 100,
            cost: 10,
            cooldown: 0,
            cooldownLeft: 0,
            effects: [{ type: 'damage', power: Math.round(power * 0.6), duration: 0 }],
            tags: [],
            unknownTags: [],
            advantage: 0,
            advantageNote: '',
            source: '系统兜底（未能从汇报里读出技能）',
        },
    ];
}

/**
 * 职业 / 身份 → 技能模板。
 *
 * ## 用途：技能**保底 3 条**
 *
 * 用户的要求：**「没人规定必须三个技能而是保底三个技能，
 * 不到三个就按照职业或者人设联想出三个」**。
 *
 * 所以这不是「猜职业替模型做主」，而是**补足下限**：
 * 模型只写了 1~2 条技能时，按这个人的身份把剩下的补齐，
 * 免得一个治疗术师在战斗里只能普攻。
 *
 * 补出来的技能会带 `source: '按定位推导' `，在战力表里一眼能认出来、也方便替换。
 */
const ROLE_TEMPLATES = [
    {
        role: 'healer',
        label: '治疗',
        re: /治愈|治疗|牧师|僧侣|医疗|奶妈|回复|药师|术师|祭司/,
        skills: [
            { name: '治愈术', desc: '治疗单体伤势并止血', advantage: 4, cost: 25, effects: ['heal'], target: 'single' },
            { name: '群体回复', desc: '为周围同伴恢复体力', advantage: 3, cost: 40, effects: ['heal'], target: 'group' },
            { name: '净化术', desc: '解除毒素与异常状态', advantage: 3, cost: 20, effects: ['heal'], target: 'single' },
        ],
    },
    {
        role: 'guard',
        label: '护卫',
        re: /护卫|禁卫|侍女|守卫|侍从|保镖|女仆/,
        skills: [
            { name: '防御架势', desc: '架剑格挡并卸去冲击', advantage: 4, cost: 20, effects: ['shield'], target: 'self' },
            { name: '卡位阻截', desc: '封死对方进攻路线', advantage: 3, cost: 15, effects: ['shield'], target: 'single' },
            { name: '反击斩', desc: '化解攻势后顺势反制', advantage: 3, cost: 25, effects: ['damage'], target: 'single' },
        ],
    },
    {
        role: 'swordsman',
        label: '剑士',
        re: /剑士|剑客|剑神流|水神流|北神流|剑修|刀客|武者|战士|骑士|斗士|剑/,
        skills: [
            { name: '基础斩击', desc: '一记干净利落的斩击', advantage: 3, cost: 10, effects: ['damage'], target: 'single' },
            { name: '突刺', desc: '低重心蹬地发力的直线刺击', advantage: 5, cost: 25, effects: ['damage'], target: 'single' },
            { name: '卸力格挡', desc: '借躯干微调化解冲击', advantage: 4, cost: 20, effects: ['shield'], target: 'self' },
        ],
    },
    {
        role: 'mage',
        label: '法系',
        re: /法师|巫师|魔法|咒术|灵术|道士|术者|魔/,
        skills: [
            { name: '魔力弹', desc: '凝聚魔力的远程打击', advantage: 4, cost: 20, effects: ['damage'], target: 'single' },
            { name: '范围法术', desc: '覆盖一片区域的术法', advantage: 3, cost: 45, effects: ['damage'], target: 'group' },
            { name: '护盾术', desc: '以魔力形成屏障', advantage: 4, cost: 30, effects: ['shield'], target: 'self' },
        ],
    },
    {
        role: 'rogue',
        label: '游走',
        re: /盗贼|刺客|斥候|忍者|游侠|猎人|弓手|盗/,
        skills: [
            { name: '偷袭', desc: '抓住破绽的一击', advantage: 6, cost: 20, effects: ['damage'], target: 'single' },
            { name: '连击', desc: '快速连续的攻击', advantage: 4, cost: 25, effects: ['damage'], target: 'single' },
            { name: '隐匿', desc: '拉开距离并寻找下一手机会', advantage: 3, cost: 15, effects: ['buff'], target: 'self' },
        ],
    },
    {
        role: 'brawler',
        label: '近身',
        re: /拳|格斗|体术|力士|摔跤|蛮/,
        skills: [
            { name: '重拳', desc: '蓄力的正面重击', advantage: 4, cost: 15, effects: ['damage'], target: 'single' },
            { name: '擒拿', desc: '锁住对手使其失衡', advantage: 3, cost: 20, effects: ['control'], target: 'single' },
            { name: '铁躯', desc: '绷紧肌肉硬抗打击', advantage: 3, cost: 10, effects: ['shield'], target: 'self' },
        ],
    },
];

/**
 * 按职业 / 身份生成技能（用于把技能补足到 3 条）。
 *
 * @param {{name?: string, tier?: string, notes?: string, paren?: string}} unitInfo
 * @returns {{skills: object[], role: string, label: string}}
 */
export function buildRoleSkills(unitInfo) {
    const haystack = [unitInfo?.tier, unitInfo?.paren, unitInfo?.notes, unitInfo?.name]
        .map((x) => toText(x))
        .join(' ');

    const matched = ROLE_TEMPLATES.find((tpl) => tpl.re.test(haystack));
    if (!matched) return { skills: [], role: '', label: '' };

    const skills = matched.skills.map((tpl) => {
        const power = estimatePower((unitInfo?.tier ?? '') + ' ' + tpl.desc);
        return {
            name: tpl.name,
            description: tpl.desc,
            target: tpl.target,
            power,
            aim: Math.max(60, Math.min(180, 100 + Math.round(tpl.advantage * 1.2))),
            cost: tpl.cost,
            cooldown: 0,
            cooldownLeft: 0,
            effects: tpl.effects.map((type) => ({
                type,
                power: type === 'damage' || type === 'heal' || type === 'shield' ? Math.round(power * 0.6) : 0,
                duration: type === 'control' ? 2 : 0,
            })),
            tags: [],
            unknownTags: [],
            advantage: tpl.advantage,
            advantageNote: '按「' + matched.label + '」身份推导',
            source: '按定位推导（' + matched.label + '）',
        };
    });

    return { skills, role: matched.role, label: matched.label };
}
