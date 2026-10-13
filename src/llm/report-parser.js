/**
 * tavern-dice / src/llm/report-parser.js
 * ---------------------------------------------------------------------------
 * 把「战况汇报」**直接解析**成战斗数据 —— 不调用任何模型。
 *
 * ## 为什么要做这个
 *
 * 原来的流程是两步模型：
 *
 *     正文模型读剧情 → 输出一份结构化汇报 → 掷骰模型把汇报转成 JSON
 *                                              ↑ 这一步经常失败
 *
 * 但那份汇报**本来就是结构化的**（有分节标题、有 `**名字**`、有 `- **状态**：`），
 * 再让一个模型去转 JSON，等于把已经整理好的信息重新赌一次 ——
 * 而第二个模型往往是便宜的小模型，扛不住这种长文本。
 * 用户看到的现象就是「汇报里双方都写清楚了，点开战却说没识别到人」。
 *
 * 所以现在：**先本地解析，解析不出足够单位才退回调用模型**。
 * 好处是省钱、快、确定（同样的输入永远得到同样的结果），
 * 而且不受「掷骰模型智力」影响。
 *
 * ## 解析目标格式
 *
 * 提示词（`buildSituationPrompt`）要求正文模型按这个形状汇报，
 * 所以解析器只需要认这一种：
 *
 *     ## 二、参战双方
 *     ### 我方（玩家侧）
 *     **淇**（玩家扮演，5岁，人族）
 *     - **状态**：完好无伤（估算：接近满状态）
 *     - **技能**：剧情中未展现任何具体招式
 *     - **装备**：练习木剑、柔软羊毛开衫
 *     - **临时加成**：无
 *
 * 宽容度要求：标题可能有「一、二、」「1.」「壹」等编号，也可能是 `**我方**` 而非 `###`。
 * 解析器只按**关键词**找分节（我方/敌方/中立），不依赖编号。
 */

import { toText, normalizeEquipment, normalizeSocial, normalizeStatus, parseExplicitModifiers } from '../core/schema.js';
import { buildFallbackSkill, buildRoleSkills, estimateRating, parseSkillBlock } from './skill-parse.js';
import { diagLog } from '../ui/diag.js';

/** 阵营关键词：用来判断分节标题说的是哪一方。 */
const SIDE_KEYWORDS = [
    { side: 'ally', words: ['我方', '己方', '友方', '玩家方'] },
    { side: 'enemy', words: ['敌方', '对手', '敌人', '对方', '敌对'] },
];

/** 从一行里取「- **字段**：值」的值。 */
const FIELD_RE = /^\s*[-*]?\s*\**\s*([^：:*]{1,12})\s*\**\s*[:：]\s*(.*)$/;

/**
 * 一个角色条目**必须**具备的标准字段名。
 *
 * 用途：判断某个「**加粗标题**」到底是不是一个战斗单位。
 *
 * ⚠️ 这是一次真实 bug 的修复。用户实测报「它把我的技能当成友军了」——
 * 日志里出现了一个叫「**总诀式**」的「敌方单位」，而「总诀式」其实是**技能名**。
 * 根因是人物行的判据太宽：**只要一行是 `**xxx**` 就当成角色名**。
 * 于是模型把技能名加粗、或把字段写得不规范时，就会凭空多出一个「单位」。
 *
 * 判据改成：**至少要能读到 2 个标准字段，才算一个战斗单位**。
 * 只认出 0~1 个字段的条目一律丢弃 —— 那种条目在战斗里也没法用。
 */
const KNOWN_FIELDS = [
    '位阶', '等级', '境界', '段位',
    '血量', '生命', 'HP', '状态',
    '魔量', 'MP', '法力', '灵力', '内力', '斗气',
    '技能', '招式', '能力', '术式',
    '人设', '性格', '身份', '对敌魅力',
    '装备', '武器', '防具', '护具', '护甲', '饰品', '配饰',
    '临时属性', '临时加成', '加成', '减益',
];

/**
 * 从一个角色条目的原始行里，数出**认得出的标准字段**有几个。
 *
 * 注意：解析主循环里 `current.fields` 存的是**原始行文本数组**
 *（真正的键值拆分在 `buildUnit` 里做），所以这里自己从行里提键名。
 *
 * @param {string[]} fieldLines
 * @param {Record<string, string[]>} [subItems]
 * @returns {number}
 */
function countKnownFields(fieldLines, subItems) {
    /** @type {Set<string>} */
    const keys = new Set();

    for (const line of fieldLines ?? []) {
        const m = String(line).match(FIELD_RE);
        if (m) keys.add(toText(m[1]).trim());
    }
    for (const k of Object.keys(subItems ?? {})) keys.add(toText(k).trim());

    let n = 0;
    for (const known of KNOWN_FIELDS) {
        if ([...keys].some((k) => k.includes(known))) n++;
    }
    return n;
}

/**
 * 判断这个条目像不像一个战斗单位。
 *
 * 判据：**至少认得出 1 个标准字段**（位阶 / 血量 / 技能 / 人设 …）。
 *
 * 这个判据只在**可疑**的地方用（见下），不是对所有标题都卡 ——
 * 因为合法汇报真的可能只写「- 状态：满状态」一行（测试里有这种用例）。
 * 真正需要挡的是「加粗标题后面直接跟冒号」那种写法，
 * 它的形态与技能条目一模一样（`**总诀式**：（效果）`）。
 *
 * @param {string[]} fieldLines
 * @param {Record<string, string[]>} [subItems]
 * @returns {boolean}
 */
function looksLikeUnit(fieldLines, subItems) {
    return countKnownFields(fieldLines, subItems) >= 1;
}

/**
 * 玩家角色标记。
 *
 * 提示词要求正文模型在**玩家扮演的角色**上标 `【玩家】`，
 * 因为汇报里所有同伴也都属于「我方」—— 不标出来就无法区分
 * 「哪个是我操控的、哪些该交给 AI」。
 */
const USER_MARKERS = ['【玩家】', '[玩家]', '（玩家）', '(玩家)', '【我】', '[我]'];

/**
 * 从一段文字里剥出玩家标记。
 * @param {string} text
 * @returns {{isUser: boolean, cleaned: string}}
 */
function stripUserMarker(text) {
    let cleaned = String(text ?? '');
    let isUser = false;
    for (const marker of USER_MARKERS) {
        if (cleaned.includes(marker)) {
            isUser = true;
            cleaned = cleaned.split(marker).join('');
        }
    }
    return { isUser, cleaned: cleaned.trim() };
}

/**
 * 判断两个名字是不是「同一个人的写法」。
 *
 * 用途：模型没打【玩家】标记时的兜底 —— 拿酒馆里登记的用户名去比对场上的人。
 * 名字写法很杂（「淇」「淇·格雷拉特」「保罗之子淇」），所以做子串双向匹配。
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function nameMatches(a, b) {
    const x = toText(a).trim();
    const y = toText(b).trim();
    if (!x || !y) return false;
    if (x === y) return true;

    // ⚠️ 子串匹配必须**用长的去包含短的**。
    // 早期写成 `y.includes(x)`，于是 persona 是「淇」、场上叫「淇·格雷拉特」时匹配不上 ——
    // 短的永远包含不了长的。这正是用户提的场景（完整姓名往往比登记名长）。
    //
    // 这里**不设长度下限**：比较的一方是 persona，全局只有一个，
    // 拿它去做子串匹配很安全（真正危险的是「用一个字段去匹配一堆角色名」）。
    const [short, long] = x.length <= y.length ? [x, y] : [y, x];
    if (long.includes(short)) return true;

    // 点号/空格分隔的复合名，逐段再比一次（「保罗·格雷拉特」vs「格雷拉特」）。
    // 段长要求 ≥2，避免单字段（如「·」旁边的空段）造成误命中。
    for (const part of long.split(/[·・.\s]+/).filter((seg) => seg.length >= 2)) {
        if (part === short || part.includes(short)) return true;
    }
    return false;
}

/**
 * 兜底判定「哪个单位是玩家操控的」。
 *
 * 优先级（高到低）：
 *  ① 正文模型打的【玩家】标记 —— 最可靠，它读过剧情，知道玩家此刻是谁
 *  ② 名字与酒馆登记的用户名（persona）匹配
 *  ③ 名字出现在**用户自己写的补充说明**里（用户说「只算主角和刺客单挑」，那主角就是他）
 *
 * 三个都不中时**不猜**，返回 null 并让调用方提示用户 ——
 * 猜错的代价是操作权错位（你点技能却在指挥敌人），比不标更糟。
 *
 * @param {object[]} units
 * @param {{userName?: string, situationText?: string}} [ctxInfo]
 * @returns {{unit: object|null, via: string}}
 */
export function resolveUserUnit(units, ctxInfo = {}) {
    const list = (units ?? []).filter(Boolean);
    if (!list.length) return { unit: null, via: '' };

    // ① 模型标记
    const marked = list.filter((u) => u.isUser);
    if (marked.length === 1) return { unit: marked[0], via: 'marker' };
    if (marked.length > 1) return { unit: marked[0], via: 'marker-ambiguous' };

    // ② persona 名字
    const persona = toText(ctxInfo.userName);
    if (persona) {
        const hit = list.find((u) => nameMatches(u.name, persona));
        if (hit) return { unit: hit, via: 'persona-name' };
    }

    // ③ 用户补充说明里提到的名字
    const situationText = toText(ctxInfo.situationText);
    if (situationText) {
        const hit = list.find((u) => u.name && u.name.length >= 2 && situationText.includes(u.name));
        if (hit) return { unit: hit, via: 'situation-mention' };
    }

    return { unit: null, via: '' };
}

/**
 * 建立一个「单位名 → 说明」的索引。
 *
 * 汇报的开头通常有一句总结，例如：
 *   「满状态的五岁转生者（深藏底牌未启用）vs 主动收力、持木剑先手压上的三流派上级剑士父亲」
 * 这句话能提供阵营线索（谁是「我方」、谁是「对手」），
 * 当分节标题缺失或人物名字对不上时，这是最后一根救命稻草。
 *
 * @param {string} text
 * @returns {{allyHints: Set<string>, enemyHints: Set<string>}}
 */
function collectSideHints(text) {
    const allyHints = new Set();
    const enemyHints = new Set();
    // 「A vs B」这种总结句
    const vsMatch = text.match(/^\s*(.+?)\s*(?:vs\.?|VS\.?|对|对抗|对战)\s*(.+?)\s*$/m);
    if (vsMatch) {
        // 只取其中的短名字片段（中文 1~8 字），不要整句
        for (const m of vsMatch[1].matchAll(/[\u4e00-\u9fa5]{1,6}/g)) allyHints.add(m[0]);
        for (const m of vsMatch[2].matchAll(/[\u4e00-\u9fa5]{1,6}/g)) enemyHints.add(m[0]);
    }
    return { allyHints, enemyHints };
}

/**
 * 从状态文字里估算血量百分比。
 *
 * 模型写不出精确数字，但会写「约七成」「重伤」「满状态」这种档位 —— 这里把它映射成百分比。
 * 映射表刻意做得保守：宁可高估也不要让角色一开战就濒死。
 *
 * @param {string} status
 * @returns {{percent: number, note: string}}
 */
export function percentFromStatus(status) {
    const text = toText(status);
    if (!text) return { percent: 100, note: '' };

    // 明确的比例数字：「约七成」「70%」「三成」
    const pctMatch = text.match(/(\d{1,3})\s*%/);
    if (pctMatch) return { percent: Math.max(1, Math.min(100, Number(pctMatch[1]))), note: text };

    const cnDigits = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
    const cnMatch = text.match(/([一二两三四五六七八九十])\s*成/);
    if (cnMatch) {
        const n = cnDigits[cnMatch[1]] ?? 5;
        return { percent: Math.max(5, Math.min(100, n * 10)), note: text };
    }

    // 分数与**概数**写法。
    // 「十之七八」= 70~80%，模型很爱这么写，取区间下限（保守）。
    const fracMatch = text.match(/([一二两三四五六七八九十]+)\s*之\s*([一二两三四五六七八九十]+)/);
    if (fracMatch) {
        const den = cnDigits[fracMatch[1]] ?? 10;
        const nums = [...fracMatch[2]].map((ch) => cnDigits[ch]).filter((n) => typeof n === 'number');
        if (nums.length && den > 0) {
            // 概数（给了两位数）取较小的那个
            const num = nums.length >= 2 ? Math.min(...nums) : nums[0];
            return { percent: Math.max(5, Math.min(100, Math.round((num / den) * 100))), note: text };
        }
    }

    // 定性档位（从重到轻判断，顺序很重要）
    const tiers = [
        { re: /濒死|垂死|奄奄一息/, percent: 10 },
        { re: /重伤|重创|伤势严重/, percent: 25 },
        { re: /轻伤|受了点伤|挂了彩|少量伤/, percent: 65 },
        { re: /约?七成|七分/, percent: 70 },
        { re: /约?八成|八分/, percent: 80 },
        { re: /约?六成|六分/, percent: 60 },
        { re: /约?五成|一半|半血/, percent: 50 },
        { re: /约?四成|四成/, percent: 40 },
        { re: /约?三成|三成/, percent: 30 },
        { re: /满状态|完好无伤|毫发无伤|未受伤|状态在线|精力充沛|无伤/, percent: 100 },
    ];
    for (const tier of tiers) {
        if (tier.re.test(text)) return { percent: tier.percent, note: text };
    }

    // 「估算」但没给档位 —— 当成满状态，并在 notes 里留原文
    return { percent: 100, note: text };
}

/** 分开列出的来源；括号内的多属性仍属于同一件装备/状态。 */
function splitModifierSources(text) {
    const pieces = [];
    let current = '';
    let depth = 0;
    for (const char of toText(text).replace(/\*\*/g, '')) {
        if ('[【（('.includes(char)) depth++;
        if (']】）)'.includes(char)) depth = Math.max(0, depth - 1);
        if (!depth && /[、；;，,\n]/.test(char)) {
            if (current.trim()) pieces.push(current.trim());
            current = '';
        } else current += char;
    }
    if (current.trim()) pieces.push(current.trim());
    return pieces.filter((piece) => !/^(无|暂无|没有|无装备|赤手空拳|空手)[。.]?$/.test(piece));
}

/** 保留六列装备行及旧文本格式；百分比、定性强弱不换算数值。 */
function reportEquipment(rows) {
    const pieces = rows.flatMap((row) => /[｜|]/.test(row) ? row.split(/\r?\n/) : splitModifierSources(row));
    return [...new Set(pieces)].flatMap((text) => {
        const plain = text.replace(/\*\*/g, '').replace(/^\s*[-*+•]\s+/, '').trim();
        if (!plain || /^(?:[｜|]\s*)?部位\s*[｜|]/.test(plain) || /^[\s|｜:\-—]+$/.test(plain)) return [];
        const equipment = normalizeEquipment(plain);
        if (!equipment) return [];
        // 六列形态的加值只读加值列，说明中的重复数字不能再计一次。
        if (!/[｜|]/.test(plain)) equipment.bonuses = Object.fromEntries(parseExplicitModifiers(plain).map(({ attr, delta }) => [attr, delta]));
        equipment.source = '战况汇报（明确装备规则）';
        return [equipment];
    });
}

/** 没有明确属性数字的状态只留在 notes，不凭关键词猜一个数值。 */
function reportStatuses(rows) {
    return [...new Set(rows.flatMap(splitModifierSources))].flatMap((text) => {
        const modifiers = parseExplicitModifiers(text);
        if (!modifiers.length) return [];
        const duration = text.match(/(?:持续\s*[:：]?\s*)?(\d+)\s*(?:回合|turns?)/i);
        const name = text.split(/[（(\[：:]/)[0].trim() || text;
        return [normalizeStatus({
            name,
            type: modifiers.some(({ delta }) => delta < 0) ? 'debuff' : 'buff',
            power: 0,
            duration: duration ? Number(duration[1]) : 0,
            description: text,
            modifiers,
            source: '战况汇报（明确临时加值）',
        })];
    });
}

/**
 * 把一个角色段落解析成单位。
 *
 * @param {string} name 已经从 `**名字**` 里取出的名字
 * @param {string} paren 名字后面括号里的内容（身份说明）
 * @param {string[]} fieldLines 该角色的 `- **字段**：值` 行
 * @param {string[]} freeLines 没有字段名的普通行（模型偶尔直接写）
 * @param {string} side
 * @returns {object}
 */
function buildUnit(name, paren, fieldLines, freeLines, side, isUser = false, subItems = {}) {
    /** @type {Record<string, string>} */
    const fields = {};
    for (const line of fieldLines) {
        const m = line.match(FIELD_RE);
        if (!m) continue;
        const key = toText(m[1]).replace(/\s/g, '');
        const value = toText(m[2]);
        if (key && value && !fields[key]) fields[key] = value;
    }

    /** 按关键词取字段（同一个意思模型会用不同词）。 */
    const pick = (/** @type {string[]} */ ...keys) => {
        for (const key of keys) {
            for (const [k, v] of Object.entries(fields)) {
                if (k.includes(key)) return v;
            }
        }
        return '';
    };

    // 独立收集所有重复字段与续行，不能复用只取首值的 pick 或技能解析。
    const charmRows = fieldLines.flatMap((line) => {
        const m = line.match(FIELD_RE);
        return m && m[1].trim() === '对敌魅力' ? [m[2]] : [];
    }).concat(subItems['对敌魅力'] ?? []);
    const persona = [pick('人设', '性格', '身份'),
        ...Object.entries(subItems).filter(([key]) => /^(人设|性格|身份)$/.test(key)).flatMap(([, rows]) => rows),
    ].filter(Boolean).join('\n') || toText(paren);
    const social = normalizeSocial({ persona, charm: charmRows.map((row) => {
        const [target, value, ...reason] = row.replace(/^\s*[-*+•]\s+/, '').split(/[｜|]/);
        return { targetName: toText(target).replace(/^\*\*|\*\*$/g, ''), value, reason: reason.join('｜').trim() };
    }) });

    const equipmentField = /装备|武器|防具|护具|护甲|饰品|配饰/;
    const collectRows = (pattern, equipment = false) => {
        const withSlot = (key, row) => equipment && /^(武器|防具|护具|护甲|饰品|配饰)$/.test(key) && row.trim() && !/^(无|暂无|没有|赤手空拳|空手)[。.]?$/.test(row.trim()) && !/[｜|]/.test(row)
            ? `${key}·${row}` : row;
        return [
            ...fieldLines.flatMap((line) => {
                const match = line.match(FIELD_RE);
                const key = match?.[1].replace(/\s/g, '');
                return match && pattern.test(key) ? [withSlot(key, match[2])] : [];
            }),
            ...Object.entries(subItems).filter(([key]) => pattern.test(key.replace(/\s/g, '')))
                .flatMap(([key, rows]) => rows.map((row) => withSlot(key, row))),
        ].map(toText).filter(Boolean);
    };
    const equipmentRows = collectRows(equipmentField, true);
    const temporaryRows = collectRows(/临时属性|临时加成|加成|减益|^状态$/);
    const status = pick('状态', '血量', '生命');
    const { percent, note } = percentFromStatus(status);

    // 满血基数：按身份说明里的线索给一个合理量级。
    // 有「上级剑士」「强者」这类词就高一些；「幼童」「路人」就低一些。
    const identityText = `${paren} ${status} ${pick('位阶', '等级', '境界')}`;
    let maxHp = 500;
    if (/天花板|传说|神话|最强/.test(identityText)) maxHp = 3000;
    else if (/上级|一流|精英|强者|高手|大师/.test(identityText)) maxHp = 1200;
    else if (/中坚|二流|老兵|熟练/.test(identityText)) maxHp = 700;
    else if (/幼童|孩童|小孩|孩子|路人|平民|新手|杂兵/.test(identityText)) maxHp = 120;

    const hp = Math.max(1, Math.round((maxHp * percent) / 100));

    // 魔量按同样比例换算（汇报通常也只用档位描述）
    const mpText = pick('魔量', 'MP', '法力', '灵力', '内力');
    const mpPercent = mpText ? percentFromStatus(mpText).percent : 100;
    const maxMp = Math.max(20, Math.round(maxHp * 0.6));
    const mp = Math.max(1, Math.round((maxMp * mpPercent) / 100));

    return {
        name,
        side,
        /** 是否是玩家扮演的角色（提示词里的【玩家】标记）。 */
        isUser: Boolean(isUser),
        social,
        tier: toText(pick('位阶', '等级', '境界')) || toText(paren).slice(0, 40),
        attributeBasis: 'base',
        attributes: {
            HP: { current: hp, max: maxHp },
            MP: { current: mp, max: maxMp },
            Atk: { current: Math.round(maxHp / 25), max: Math.round(maxHp / 25) },
            Armor: { current: Math.round(maxHp / 60), max: Math.round(maxHp / 60) },
            Speed: { current: 10, max: 10 },
            Evasion: { current: 10, max: 10 },
        },
        // ---- 技能：从「技能」字段 + 缩进子列表里解析 ----
        //
        // 这是修「所有人只能普攻」的核心：把技能名、判定优势、蓝耗抠出来变成真技能。
        skills: (() => {
            const parsed = parseSkillBlock(
            [
                ...(subItems && typeof subItems === 'object'
                    ? Object.entries(subItems)
                          .filter(([k]) => /技能|招式|术|能力/.test(k))
                          .flatMap(([, v]) => v)
                    : []),
                pick('技能', '招式', '能力'),
            ].filter(Boolean),
            { tier: pick('位阶', '等级', '境界') || paren },
            );

            // ---- 兜底：技能不足 3 条时按「职业 / 人设」联想补足 ----
            //
            // 用户的要求：**「没人规定必须三个技能而是保底三个技能，
            // 不到三个就按照职业或者人设联想出三个」**。
            //
            // 所以这里不是「读不出才给一条通用技」，而是**不足 3 条就补齐到 3 条**：
            //   · 先按身份/人设匹配职业模板（治疗 / 剑士 / 法师 / 护卫 / 游走 / 近身）
            //   · 匹配不上再给一条中性的通用技
            // 补出来的技能会标明 source，方便在战力表里辨认与替换。
            if (parsed.length < 3) {
                const role = buildRoleSkills({
                    name,
                    tier: pick('位阶', '等级', '境界') || paren,
                    notes: `${status} ${paren}`,
                    paren,
                });
                const seen = new Set(parsed.map((x) => x.name));
                for (const extra of role.skills ?? []) {
                    if (parsed.length >= 3) break;
                    if (seen.has(extra.name)) continue;
                    seen.add(extra.name);
                    parsed.push(extra);
                }
                if (parsed.length < 3 && !parsed.length) {
                    parsed.push(...buildFallbackSkill({ name, tier: pick('位阶', '等级', '境界') || paren }));
                }
            }

            return parsed;
        })(),
        equipment: reportEquipment(equipmentRows),
        statuses: reportStatuses(temporaryRows),
        // ---- 战力评估：模型没给就按位阶推定 ----
        // 用户要求「位阶、战力差距必须明确」，所以这里保证每个人都有一个分，
        // 否则排序与战斗手感全都拉不开差距。
        powerRating: (() => {
            const est = estimateRating(`${pick('位阶', '等级', '境界')} ${paren}`);
            return {
                rating: est.rating,
                grade: est.grade,
                note: '',
                basis: '由位阶文字推定（模型未直接给出评分）',
            };
        })(),
        alive: true,
        notes: [
            pick('人设', '性格', '身份') ? `人设：${pick('人设', '性格', '身份')}` : '',
            status ? `状态：${note || status}` : '',
            pick('技能') ? `技能：${pick('技能')}` : '',
            equipmentRows.length ? `装备：${equipmentRows.join('；')}` : '',
            temporaryRows.length ? `临时：${temporaryRows.join('；')}` : '',
            freeLines.length ? freeLines.join(' ') : '',
        ]
            .filter(Boolean)
            .join('\n'),
        source: '战况汇报（本地解析）',
    };
}

/**
 * 解析「战况汇报」文本。
 *
 * @param {string} report
 * @returns {{ok: boolean, error?: string, system?: object, stats?: object, logs: string[]}}
 */
export function parseSituationReport(report) {
    /** @type {string[]} */
    const logs = [];
    const text = String(report ?? '');
    if (!text.trim()) return { ok: false, error: '汇报内容为空', logs };

    const lines = text.split(/\r?\n/);
    const { allyHints, enemyHints } = collectSideHints(text);

    /** @type {Array<{name: string, side: string, paren: string, fields: string[], free: string[]}>} */
    const units = [];
    /** 当前所在分节的阵营（null = 还没进参战分节）。 */
    let sectionSide = /** @type {string|null} */ (null);
    /** 是否已经过了「参战双方」这一节（避免把「战场环境」里的人也当成单位）。 */
    let sawRoster = false;

    /**
     * 明确的**参战人员名单**（来自汇报里的「## 参战人员名单 → ### 参战」）。
     *
     * ⚠️ 用户的要求：「你直接去规范开始战斗时的提示词，让它把谁是参战人员写明确，
     * 写成解析器能识别准确的存在不就好了？」
     * 这条意见是对的 —— 与其事后猜「这个加粗标题是不是人名」，
     * 不如让模型先把名单写清楚，解析器**照着名单核对**。
     *
     * 名单存在时，**只有名单上的人**才会成为战斗单位；
     * 不在名单上的加粗标题一律丢弃（那些多半是技能名或小标题）。
     *
     * @type {Set<string>|null}
     */
    let declaredCombatants = null;
    const declaredSides = new Map();
    const rosterErrors = [];

    /** 名单里打了【玩家】标记的人（最可靠的来源）。 */
    let declaredUserFromRoster = /** @type {string|null} */ (null);

    /** 观战者名单：在场但不动手的人，必须排除。 */
    const declaredObservers = new Set();

    /** 名单分节状态：null=不在名单节，'combat'=参战，'watch'=观战。 */
    let rosterSection = /** @type {null|'combat'|'watch'} */ (null);

    /** @type {any} */
    let current = null;

    /** 收尾当前角色。 */
    const flush = () => {
        if (current && toText(current.name)) {
            // ⚠️ 校验：字段太少的条目**不是战斗单位**（多半是技能名被误认）。
            // 用户报过「它把我的技能当成友军了」—— 日志里冒出个叫「总诀式」的敌人。
            const fieldLines = current.fields ?? [];
            const subs = current.subItems ?? {};
            const name = toText(current.name);

            // ① 观战者一律排除（用户要求区分「参战」与「观战」）
            if (declaredObservers.has(name)) {
                diagLog('info', `「${name}」在观战名单里 —— 不计入战斗单位`);
            } else if (declaredCombatants !== null) {
                // ② 有名单时**只认名单上的人**。
                //    这比「猜这个加粗标题是不是人名」可靠得多 —— 名单是模型自己写明确的。
                if (declaredCombatants.has(name)) {
                    const declaredSide = declaredSides.get(name);
                    if (declaredSide && current.side && declaredSide !== current.side) rosterErrors.push(`「${name}」的名单阵营与详细条目冲突`);
                    current.side = declaredSide ?? current.side;
                    if (declaredUserFromRoster) current.isUser = name === declaredUserFromRoster;
                    if (looksLikeUnit(fieldLines, subs)) units.push(current);
                    else diagLog('warn', `「${name}」在参战名单里，但字段太少（${countKnownFields(fieldLines, subs)} 个），已丢弃`);
                } else {
                    diagLog('info', `「${name}」不在参战名单里 —— 已忽略（多半是技能名或小标题）`);
                }
            } else if (looksLikeUnit(fieldLines, subs)) {
                // ③ 没有名单（旧格式汇报）：退回原来的判据
                units.push(current);
            } else {
                diagLog(
                    'warn',
                    `丢弃了不像战斗单位的条目「${name}」` +
                        `（只认到 ${countKnownFields(fieldLines, subs)} 个标准字段）—— 多半是技能名被误认`,
                );
            }
        }
        current = null;
    };

    /** 按关键词判断这一行是不是分节标题，是就返回阵营。 */
    const sideOfHeading = (/** @type {string} */ line) => {
        // 去掉 markdown 标题符号与编号
        const cleaned = line
            .replace(/^#{1,6}\s*/, '')
            .replace(/^[*\s]+|[*\s]+$/g, '')
            .trim();
        if (!cleaned) return null;
        const title = cleaned.replace(/^[一二三四五六七八九十0-9]+[、.．）)]\s*/, '');
        for (const { side, words } of SIDE_KEYWORDS) {
            if (words.some((w) => new RegExp(`^${w}(?:$|[\\s（(:：]|阵营|人员|单位|角色)`).test(title))) return side;
        }
        return null;
    };

    for (const rawLine of lines) {
        const line = rawLine.replace(/\s+$/, '');

        // 名单标题必须先于普通「参战」标题处理。
        const headingText = line.replace(/^\s*#{1,6}\s*/, '').replace(/\*\*/g, '').trim();
        const headingLine = /^\s*#{1,6}\s/.test(line) || /^\s*\*\*[^*]+\*\*\s*$/.test(line);
        if (headingLine && /参战人员名单|人员名单|参战名单/.test(headingText)) {
            flush();
            rosterSection = 'combat';
            declaredCombatants ??= new Set();
            sawRoster = true;
            sectionSide = null;
            continue;
        }
        if (rosterSection && headingLine) {
            if (/^(?:[一二三四五六七八九十0-9]+[、.．）)]\s*)?(观战|旁观)(?:者|人员)?$/.test(headingText)) {
                rosterSection = 'watch';
                continue;
            }
            if (/^(?:[一二三四五六七八九十0-9]+[、.．）)]\s*)?(参战|出战|出手)(?:者|人员)?$/.test(headingText)) {
                rosterSection = 'combat';
                continue;
            }
            // 同级详细资料、我方/敌方等标题结束名单，不能吞掉后续角色。
            if (/^\s*#/.test(line) || /参战双方|战场|补充|战斗模式|我方|敌方/.test(headingText)) rosterSection = null;
        }
        if (rosterSection) {
            const entry = line.match(/^\s*[-*]?\s*\*\*([^*]{1,60})\*\*\s*([\s\S]*)$/);
            if (entry) {
                const marked = stripUserMarker(entry[1]);
                const name = marked.cleaned.replace(/^[（(]\s*/, '').replace(/\s*[）)]$/, '').trim();
                if (name && name !== '无') {
                    if (rosterSection === 'watch') declaredObservers.add(name);
                    else {
                        declaredCombatants.add(name);
                        const sideText = entry[2].split(/[｜|]/).slice(1).join(' ');
                        const sides = SIDE_KEYWORDS.filter(({ words }) => words.some((word) => sideText.includes(word))).map(({ side }) => side);
                        if (sides.length !== 1) rosterErrors.push(`「${name}」的名单阵营缺失或不明确`);
                        else if (declaredSides.has(name) && declaredSides.get(name) !== sides[0]) rosterErrors.push(`「${name}」有重复且冲突的阵营`);
                        else declaredSides.set(name, sides[0]);
                        if (marked.isUser) declaredUserFromRoster = name;
                    }
                }
            }
            continue;
        }

        // ---- 分节标题 ----
        const isHeading = /^\s*#{1,6}\s/.test(line) || /^\s*\*\*[^*]{1,20}\*\*\s*$/.test(line);
        if (isHeading) {
            const side = sideOfHeading(line);
            if (side) {
                flush();
                sectionSide = side;
                sawRoster = true;
                continue;
            }
            // 遇到「战场环境」「其他说明」这类非参战分节 → 结束收集
            if (sawRoster && /环境|说明|总结|备注|其他/.test(line)) {
                flush();
                sectionSide = null;
                continue;
            }
            // 「参战双方」这种总标题：不改变阵营，但标记已进入名单区
            if (/参战|双方|人物|单位/.test(line)) {
                sawRoster = true;
                continue;
            }
        }

        // 没进入参战分节之前，不认角色
        if (!sawRoster || (!sectionSide && declaredCombatants === null)) continue;

        // 魅力字段优先于缩进子项/加粗人名/技能；重复字段及无缩进续行均归属当前角色。
        const socialField = line.match(FIELD_RE);
        if (current && socialField && socialField[1].trim() === '对敌魅力') {
            current.fields.push(line);
            current.__lastKey = '对敌魅力';
            continue;
        }
        if (current?.__lastKey === '对敌魅力' && !socialField && /[｜|]/.test(line)) {
            current.subItems ??= {};
            (current.subItems['对敌魅力'] ??= []).push(line.trim());
            continue;
        }

        // 容忍装备表没有缩进或列表符；只认部位开头的行，不误收人物名单/技能。
        if (current && /装备|武器|防具|护具|护甲|饰品|配饰/.test(current.__lastKey ?? '')
            && /^\s*(?:[-*+•]\s+)?(?:[|｜]\s*)?(?:\*\*)?(?:部位|武器|防具|护具|护甲|饰品|配饰|其它|其他|weapon|armor|accessory|other)(?:\*\*)?\s*[｜|]/i.test(line)) {
            current.subItems ??= {};
            (current.subItems[current.__lastKey] ??= []).push(line.trim());
            continue;
        }
        // 技能/装备子项必须先归属当前角色，不能先去匹配加粗人名。
        if (current?.__lastKey && /^\s{2,}[-*+•]\s*\S/.test(line)) {
            current.subItems ??= {};
            (current.subItems[current.__lastKey] ??= []).push(toText(line.replace(/^\s*[-*+•]\s*/, '')).trim());
            continue;
        }

        // ---- 角色开头：**名字**（说明） ----
        //
        // ⚠️ 这里最容易出错的是把**字段名**当成人名。
        // 汇报里长这样：
        //     **淇**（玩家扮演，5岁，人族）
        //     - **状态**：完好无伤
        //     - **内藏底牌（剧情明写为潜伏状态，非当前生效增益）**：心脏内沉睡的…
        //
        // 第 3 行也能被「**xxx**（…）」匹配上，于是「内藏底牌（…）」被当成了角色名。
        // 判别依据：**字段名后面直接跟冒号，人名后面跟的是括号或换行**。
        // 所以先剥掉列表符号，再看「**…**」之后紧跟的第一个字符是什么。
        const stripped = line.replace(/^\s*#{1,6}\s+/, '').replace(/^\s*[-*+]\s+/, '').trim();
        const bulletMatch = stripped.match(/^\*\*([^*]{1,60})\*\*\s*([\s\S]*)$/);
        if (bulletMatch) {
            const rawLabel = toText(bulletMatch[1]).trim();
            const rest = toText(bulletMatch[2]);
            const isField = /^[：:]/.test(rest);

            // ---- 解析名字与「玩家」标记 ----
            //
            // 这里要处理模型的各种写法（都真实出现过）：
            //   **【玩家】**（淇，保罗之子）   ← 标记在粗体里，名字在括号里（会整条丢掉！）
            //   **淇【玩家】**（保罗之子）     ← 标记在名字后面
            //   **淇**（玩家扮演，5岁）        ← 标记在括号说明里
            //   **保罗·格雷拉特**（身份）      ← 没有标记
            const labelMarker = stripUserMarker(rawLabel);
            const outerMarker = stripUserMarker(rest);
            let name = labelMarker.cleaned;
            let paren = '';
            const isUser = labelMarker.isUser || outerMarker.isUser;

            const outerParen = outerMarker.cleaned.match(/^[（(]([^）)]*)[）)]/);
            if (outerParen) paren = toText(outerParen[1]);

            if (!name) {
                // 粗体里只剩标记 → 名字在括号里。取括号第一段当名字，其余当身份。
                if (outerParen) {
                    const parts = toText(outerParen[1])
                        .split(/[，,、]/)
                        .map((x) => x.trim())
                        .filter(Boolean);
                    name = parts[0] ?? '';
                    paren = parts.slice(1).join('，');
                }
            } else if (!paren) {
                // 粗体里有名字 → 看它自己带不带括号说明（例如 `**淇（5岁）**`）
                const inline = name.match(/^([^（(]+)[（(]([^）)]*)[）)]\s*$/);
                if (inline) {
                    name = toText(inline[1]);
                    paren = toText(inline[2]);
                }
            }

            // 名字可能被括号包着（`**【玩家】（淇）**` 这种写法），剥掉
            name = name.replace(/^[（(]\s*/, '').replace(/\s*[）)]$/, '').trim();

            const isFieldWord = /^(状态|技能|装备|属性|临时加成|临时属性|加成|减益|备注|说明|基础|血量|魔量|位阶|人设|对敌魅力)$/.test(name);
            const listedPerson = declaredCombatants?.has(name) === true;
            const skillRow = /[｜|]/.test(rest) || (current && /^\s*[-*+•]\s/.test(line) && /技能|招式/.test(current.__lastKey ?? '') && !listedPerson && !/^[（(]/.test(rest));
            if (!isField && !isFieldWord && skillRow && current) {
                current.subItems ??= {};
                (current.subItems[current.__lastKey || '技能'] ??= []).push(stripped);
                continue;
            }
            // 不在明确名单中的标题不能截断正在读取的人物。
            if (!isField && name && !isFieldWord && !skillRow && (declaredCombatants === null || listedPerson)) {
                flush();
                current = { name, side: sectionSide, isUser, paren, fields: [], free: [] };
                const trailing = outerParen ? outerMarker.cleaned.slice(outerParen[0].length) : outerMarker.cleaned;
                if (trailing && !/^[-*—]/.test(trailing)) current.free.push(trailing);
                continue;
            }
            // 是字段行就往下走，交给下面的字段逻辑处理
        }

        if (!current) continue;

        // ---- 字段行 / 子列表 / 自由行 ----
        //
        // ⚠️ 关键：模型常把技能写成**缩进子列表**：
        //     - 技能：
        //       - 天道核：提供无穷魔力（+10判定加值，固定消耗0点蓝量）
        //       - 斩天剑意：撕裂屏障（+10，固定消耗100点蓝量）
        // 早期版本只收「键：值」在同一行的写法，于是**整段技能被丢掉**，
        // 战斗里所有人只能普通攻击（用户报的问题）。
        const isFieldLine =
            /^\s*[-*]?\s*\**\s*[^：:*]{1,12}\s*\**\s*[:：]/.test(line) ||
            /^\s*\*\*[^*]{1,20}\*\*\s*[:：]/.test(line);

        // ⚠️ 缩进子项也算「键：值」，所以子列表判断必须**放在字段行之前**。
        // 早期顺序反了：`  - 天道核：xxx` 被当成字段行吃掉，
        // 于是技能整段丢失、战斗里只能普攻（用户报的问题）。
        const isSubItem = /^\s{2,}[-*+•]\s*\S/.test(line);

        if (isSubItem && current.__lastKey) {
            current.subItems = current.subItems ?? {};
            (current.subItems[current.__lastKey] = current.subItems[current.__lastKey] ?? []).push(
                toText(line.replace(/^\s*[-*+•]\s*/, '')).trim(),
            );
            continue;
        }

        if (isFieldLine) {
            current.fields.push(line);
            // 记录「当前正在写的字段」，供缩进子项归属
            const keyMatch = line.match(/^\s*[-*]?\s*\**\s*([^：:*]{1,12})\s*\**\s*[:：]/);
            current.__lastKey = keyMatch ? toText(keyMatch[1]).trim() : '';
            // 「技能：」后面同一行还有内容的，也算一条子项
            const inline = line.replace(/^[\s\S]*?[:：]/, '').trim();
            if (current.__lastKey && inline && /技能|招式/.test(current.__lastKey)) {
                current.subItems = current.subItems ?? {};
                (current.subItems[current.__lastKey] = current.subItems[current.__lastKey] ?? []).push(inline);
            }
            continue;
        }

        if (line.trim()) current.free.push(line.trim());
    }
    flush();

    // ---- 过滤掉「其实是字段名」的伪角色 ----
    //
    // 兜底清理：有些字段行没有列表符号，或者括号里含 `/` 这种字段特征。
    // 判据：① 没有任何字段行 ② 名字里含 `/` 或名字本身是个常见字段词。
    const FIELD_WORDS = /^(状态|技能|装备|属性|临时加成|加成|减益|备注|说明|基础|血量|注意|内藏|底牌|底细|其他|其它|补充|对敌魅力)$/;
    const realUnits = units.filter((u) => {
        const name = toText(u.name);
        if (!name) return false;
        // 名字里带 `/` 或 `／` 的几乎一定是字段（例如「临时加成/减益」）
        if (/[/／]/.test(name)) return false;
        if (FIELD_WORDS.test(name)) return false;
        // 名字里含「（」却没有配对的「）」说明是从字段里截断出来的
        if (name.includes('（') && !name.includes('）')) return false;
        // 括号说明里含字段特征的，也当字段处理
        if (/剧情明写|非当前生效|属于|性质/.test(toText(u.paren))) return false;
        // 完全没有字段行、也没有自由文本的角色，信息量为零，丢掉
        if (!u.fields.length && !u.free.length && !toText(u.paren)) return false;
        return true;
    });

    if (!realUnits.length) {
        return {
            ok: false,
            needsReview: declaredCombatants !== null,
            error: '没能从汇报里认出任何参战者（汇报需要按「我方 / 敌方」分节，且每个角色用 `**名字**` 开头）',
            logs,
        };
    }

    if (declaredCombatants !== null) {
        for (const name of declaredCombatants) {
            if (declaredObservers.has(name)) rosterErrors.push(`「${name}」同时列为参战与观战`);
            if (!realUnits.some((u) => u.name === name)) rosterErrors.push(`「${name}」缺少有效详细资料`);
        }
        if (rosterErrors.length) return { ok: false, needsReview: true, error: rosterErrors.join('；'), logs };
    }

    // ---- 兜底：分节缺失时用总结句的线索判断阵营 ----
    for (const u of realUnits) {
        if (u.side) continue;
        if (allyHints.has(u.name) || [...allyHints].some((h) => h.includes(u.name) || u.name.includes(h))) {
            u.side = 'ally';
        } else if (enemyHints.has(u.name) || [...enemyHints].some((h) => h.includes(u.name) || u.name.includes(h))) {
            u.side = 'enemy';
        } else {
            u.side = 'neutral';
        }
    }

    logs.push(`本地解析出 ${realUnits.length} 个参战者：${realUnits.map((u) => `${u.name}(${u.side})`).join('、')}`);

    // ---- 组装 ----
    const combatants = realUnits.map((u) => buildUnit(u.name, u.paren, u.fields, u.free, u.side, u.isUser, u.subItems));

    if (!combatants.some((u) => u.side === 'ally') || !combatants.some((u) => u.side === 'enemy')) {
        return { ok: false, needsReview: true, error: '参战名单未明确列出敌我双方，请核对阵营；不会自动分队', logs };
    }
    // 不按人数或排列顺序编造敌我关系。
    if (rosterErrors.length) return { ok: false, needsReview: true, error: rosterErrors.join('；'), logs };
    if (combatants.some((u) => !['ally', 'enemy'].includes(u.side))) {
        return { ok: false, needsReview: true, error: '存在阵营未明确的参战者，请修正场景名单', logs };
    }

    // ---- 环境与总述 ----
    //
    // ⚠️ 不要写「## 一、」这种死正则：模型给的编号五花八门
    // （`## 一、性质说明` / `## 一. 性质说明` / `## 1、性质说明` / 干脆不编号），
    // 所以按**关键词**找章节，再看它到下一个 `##` 之间的内容。
    /**
     * 取包含某关键词的那一节的内容。
     * @param {string[]} keywords
     * @returns {string}
     */
    const sectionText = (...keywords) => {
        const headingIdx = lines.findIndex((line) => {
            if (!/^\s*#{1,6}\s/.test(line) && !/^\s*\*\*[^*]{1,30}\*\*\s*$/.test(line)) return false;
            return keywords.some((k) => line.includes(k));
        });
        if (headingIdx < 0) return '';
        const rest = [];
        for (let i = headingIdx + 1; i < lines.length; i++) {
            if (/^\s*#{1,3}\s/.test(lines[i])) break;
            rest.push(lines[i]);
        }
        return rest.join('\n').trim();
    };

    // ---- 战斗模式：让正文 AI 判定「切磋」还是「生死搏杀」 ----
    //
    // 用户的要求：「战斗开始应该分为切磋和生死搏杀两个模式，让正文 ai 判定。
    // 如果是切磋就不能写阵亡而是力竭」。
    //
    // 解析时**宁可判成切磋**：把切磋误判成生死搏杀会写出「阵亡」，那是很荒唐的；
    // 反过来只是措辞保守一点。
    const modeText = sectionText('战斗模式', '模式') + ' ' + sectionText('补充说明', '说明');
    let combatMode = 'spar';
    if (/生死搏杀|生死之战|厮杀|死斗|以命相搏|杀意|取他性命|不死不休/.test(modeText)) {
        combatMode = 'deadly';
    } else if (/切磋|比试|点到为止|教学|训练|试探|留手|不伤|非致命/.test(modeText)) {
        combatMode = 'spar';
    } else if (modeText.trim()) {
        // 有说明但认不出来 → 保守判成切磋
        combatMode = 'spar';
    }

    return {
        ok: true,
        system: {
            systemName: '战况',
            overview: sectionText('性质说明', '性质', '总述', '概述').slice(0, 800),
            scale: '数值由战况汇报的文字描述估算（血量档位 → 百分比 → 满血基数）。不是原书数值，仅供掷骰判定。',
            setting: sectionText('战场环境', '环境', '场地').slice(0, 500),
            /** 由正文 AI 判定的战斗模式：spar=切磋 / deadly=生死搏杀 */
            combatMode,
            combatants,
        },
        stats: {
            units: combatants.length,
            allies: combatants.filter((c) => c.side === 'ally').length,
            enemies: combatants.filter((c) => c.side === 'enemy').length,
        },
        logs,
    };
}
