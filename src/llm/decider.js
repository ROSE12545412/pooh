/**
 * tavern-dice / src/llm/decider.js
 * ---------------------------------------------------------------------------
 * 「让 AI 思考这一回合怎么打」。
 *
 * ## 它在整个流程里的位置
 *
 *     玩家点技能 / AI 替单位决定
 *        ↓
 *     【骰子开始转】──────────────┐
 *        ↓                        │ 这段时间就是等待 API
 *     调用 API 思考本次行动         │ —— 等待被赋予了「正在掷骰」的意义
 *        ↓                        │
 *     【骰子停下，显示结果】────────┘
 *        ↓
 *     引擎结算 → 显示回合结果
 *
 * ## 三种模式
 *
 *  - `off`：完全不调 API，用引擎的启发式规则选目标（最快，零成本）
 *  - `flavor`（默认）：**行动由玩家点选，但让 AI 写一句动作描述** ——
 *    既保留了玩家的操作感，又让每次攻击都有符合角色性格的文字
 *  - `auto`：连「用哪个技能、打谁」都交给 AI 决定（最像「AI 在打」）
 *
 * 默认用 `flavor` 是因为：完全自动会让玩家失去参与感，
 * 而完全不调 AI 又达不到用户要的「AI 思考」效果。
 */

import { toText } from '../core/schema.js';
import { skillEffectLabels, skillMechanicsText } from '../combat/preview.js';
import { chooseFallbackTarget, legalTargetCandidates } from '../combat/targeting.js';
import { LlmClient, describeError, extractBalancedCandidates, parseJsonLoose } from './client.js';

/** 决策模式。 */
export const DECIDE_MODE = Object.freeze({
    OFF: 'off',
    FLAVOR: 'flavor',
    AUTO: 'auto',
});

/** 模式的中文名。 */
export const DECIDE_MODE_LABEL = Object.freeze({
    off: '不调用（纯本地规则）',
    flavor: '只让 AI 写动作描述（推荐）',
    auto: '让 AI 决定用哪个技能打谁',
});

function unitLabel(unit) {
    return `${unit.name ?? '（无名）'}${unit.id ? ` [id=${unit.id}]` : ''}`;
}

/** 与玩家说明共用实际机制；目标预览不消耗随机数。 */
function skillDecisionDetails(battle, unit, skill) {
    const effects = skillEffectLabels(skill);
    const mechanics = skillMechanicsText(skill, battle.ruleset);
    const candidates = legalTargetCandidates(battle, unit, skill).map(unitLabel);
    return [effects ? `效果 ${effects}` : '', ...mechanics,
        `合法目标：${candidates.join('、') || '无'}`].filter(Boolean).join('；');
}

function basicAttackDetails(battle, unit) {
    return `- 普通攻击（action=attack，skillId 留空）；合法目标：${
        legalTargetCandidates(battle, unit).map(unitLabel).join('、') || '无'}`;
}

/** 稳定 id 优先；兼容旧模型的唯一同名匹配，重名绝不默选第一人。 */
function matchUnit(units, id, name) {
    const byId = id ? units.find(unit => unit.id === id) : null;
    if (byId) return byId;
    const byName = name ? units.filter(unit => unit.name === name) : [];
    return byName.length === 1 ? byName[0] : null;
}

/** 单个和批量决策共用：先确定技能，再按该技能的完整候选验证目标。 */
function normalizeDecision(raw, battle, unit, log) {
    const decision = {
        skillId: toText(raw?.skillId),
        targetId: toText(raw?.targetId),
        targetName: toText(raw?.targetName),
        action: ['skill', 'attack', 'defend', 'skip'].includes(toText(raw?.action))
            ? toText(raw.action) : raw?.skillId ? 'skill' : 'attack',
        flavor: toText(raw?.flavor),
    };
    if (['defend', 'skip'].includes(decision.action)) {
        return { ...decision, skillId: '', targetId: '', targetName: '' };
    }
    const skill = decision.action === 'skill' && decision.skillId
        ? (unit.skills ?? []).find(entry => entry.id === decision.skillId || entry.name === decision.skillId)
        : null;
    if (decision.action === 'skill' && !skill) {
        log(`⚠ 「${unit.name}」的技能「${decision.skillId}」不在技能表里，改用普通攻击`);
    }
    decision.skillId = skill?.id ?? '';
    decision.action = skill ? 'skill' : 'attack';
    // 群体和随机目标留给引擎，不提前选择/掷骰，避免把一次群攻缩成单体。
    if (['group', 'all', 'random'].includes(skill?.target)) {
        return { ...decision, targetId: '', targetName: '' };
    }
    const candidates = legalTargetCandidates(battle, unit, skill);
    let target = matchUnit(candidates, decision.targetId, decision.targetName);
    if (!target) {
        if (decision.targetId || decision.targetName) {
            log(`⚠ 「${unit.name}」的目标「${decision.targetName || decision.targetId}」不是当前行动的合法目标，改用本地规则`);
        }
        target = chooseFallbackTarget(battle, unit, skill);
    }
    decision.targetId = target?.id ?? '';
    decision.targetName = target?.name ?? '';
    return decision;
}

/**
 * 把战况整理成给决策模型的简报。
 *
 * 要点：只给**决策必需**的信息（谁在打、各自状态、可用技能），
 * 不要塞完整日志 —— 那既费 token 又会干扰判断。
 *
 * @param {any} battle
 * @returns {string}
 */
export function renderBattleBrief(battle, unit = battle?.currentUnit) {
    if (!battle) return '（没有战斗）';
    const lines = [`第 ${battle.round ?? '?'} 回合，当前行动者：${unit ? unitLabel(unit) : '（无）'}`];
    lines.push('');

    // 容错：battle.units 理论上一定有，但日志/调试路径上不该因为缺字段就崩
    const units = Array.isArray(battle.units) ? battle.units : [];
    lines.push('全体单位：');
    if (!units.length) {
        lines.push('- （没有单位）');
    }
    for (const u of units) {
        if (!u || typeof u !== 'object') continue;
        const hp = u.attributes?.HP;
        const pct = hp?.max ? Math.round(((hp.current ?? 0) / hp.max) * 100) : 0;
        const side = u.side === 'ally' ? '我方' : u.side === 'enemy' ? '敌方' : '中立';
        const mark = u.id === unit?.id ? ' ←当前行动' : '';
        lines.push(
            `- ${side} ${unitLabel(u)}${u.tier ? `[${u.tier}]` : ''}：` +
                (u.alive === false ? '已阵亡' : `HP ${hp?.current ?? 0}/${hp?.max ?? 0}（${pct}%）`) +
                `，攻 ${u.attributes?.Atk?.current ?? 0}，甲 ${u.attributes?.Armor?.current ?? 0}，速 ${u.attributes?.Speed?.current ?? 0}` +
                (u.statuses?.length
                    ? `，状态：${u.statuses.map((/** @type {any} */ s) => `${s?.name ?? '?'}${s?.duration ? `(${s.duration})` : ''}`).join('、')}`
                    : '') +
                mark,
        );
    }
    lines.push('');

    // 注意：unit 可能是 undefined（例如只有 units 没有 currentUnit 的残缺对象），
    // 这里必须用 unit?.name —— 早期写成 unit.name 会在这种情况下崩
    if (unit?.skills?.length) {
        lines.push(`${unit.name} 可用技能：`);
        for (const s of unit.skills) {
            if (!s) continue;
            lines.push(
                `- id=${s.id}　${s.name ?? '（无名技能）'}：威力 ${s.power}，命中 ${s.aim}，消耗 ${s.cost ?? 0} MP，` +
                    `目标 ${s.target}${s.tags?.length ? `，标签 ${s.tags.join('/')}` : ''}；${skillDecisionDetails(battle, unit, s)}` +
                    (s.description ? `　说明：${s.description}` : ''),
            );
        }
    } else if (unit) {
        lines.push(`${unit.name} 没有技能，只能普通攻击。`);
    }

    if (unit) lines.push(basicAttackDetails(battle, unit));
    lines.push('');
    lines.push(`可用 MP：${unit?.attributes?.MP?.current ?? 0}/${unit?.attributes?.MP?.max ?? 0}`);

    const recent = (Array.isArray(battle.log) ? battle.log : [])
        .slice(-6)
        .map((/** @type {any} */ l) => l?.text)
        .filter(Boolean);
    if (recent.length) {
        lines.push('');
        lines.push('最近发生：');
        for (const t of recent) lines.push(`· ${t}`);
    }

    return lines.join('\n');
}

/**
 * 决策结果的 JSON Schema。
 *
 * 只要求模型返回「打了谁 / 用了什么招 / 一句动作描述」——
 * **不让它算伤害或血量**，那些必须由本地引擎算，否则数值会飘。
 */
export const DECIDE_JSON_SCHEMA = {
    name: 'battle_action',
    strict: true,
    value: {
        type: 'object',
        properties: {
            skillId: {
                type: 'string',
                description: '要用的技能 id；用普通攻击填空字符串。只能用上面列出的技能。',
            },
            targetId: {
                type: 'string',
                description: '目标单位的稳定 id，优先填写；不用 id 时填空字符串并填写 targetName。',
            },
            targetName: {
                type: 'string',
                description: '目标单位的名字，必须与该技能合法目标列表里的名字完全一致。已填写 targetId 时可留空。',
            },
            action: {
                type: 'string',
                enum: ['skill', 'attack', 'defend', 'skip'],
                description: 'skill=用技能 attack=普通攻击 defend=防御 skip=跳过',
            },
            flavor: {
                type: 'string',
                description:
                    '一句话描述这个角色**如何**做出这个动作，要符合他的性格与武器。例如「李长风踏前一步，剑光如练」。不要写结果（不要说命中了、造成了多少伤害）——结果由骰子决定。',
            },
        },
        // strict schema 要求字段齐全；空 id 和旧模型省略 id 都按名字兼容解析。
        required: ['skillId', 'targetId', 'targetName', 'action', 'flavor'],
        additionalProperties: false,
    },
};

/**
 * 构造决策提示词。
 *
 * **关键约束：绝对不能替骰子决定成败。**
 * 模型只描述「意图与动作」，命中与否、伤害多少一律由本地引擎掷骰。
 * 早期没有这条约束时，模型会写「一剑刺穿了他的心脏，造成 240 点伤害」，
 * 与引擎算出来的「未命中」直接矛盾。
 *
 * @param {{brief: string, mode: string, unitName?: string}} input
 * @returns {{system: string, user: string}}
 */
export function buildDecidePrompt(input) {
    const auto = input.mode === DECIDE_MODE.AUTO;
    const system = `你是一个回合制战斗的战术助手。你要为**当前行动的单位**决定这一回合怎么做。

# 你可以决定什么
${auto ? '- **用哪个技能** 与 **打谁**（你可能没得选，那就按最优选）' : '- 玩家已经选好了行动与目标，你**不需要改变它**，只要写动作描述'}
- 一句话的**动作描述**（flavor）

# 绝对不能做的事（最重要）
1. **不要决定成败。** 命中与否由骰子决定，你写的描述里**不能**出现「命中」「击中」「刺穿」「躲开」「造成了 X 伤害」这类结果。
   你只写**意图与动作**：「李长风踏前一步，剑光如练」——对；「李长风一剑刺穿敌胸，造成 200 伤害」——错。
2. **不要编造技能。** 只能用列表里给出的技能；没有合适的就是普通攻击。
3. **不要改数值。** 不要写 HP 变化、buff 数值，那些由本地引擎算。
4. 目标必须从所选技能（或普通攻击）的「合法目标」完整列表里选择；优先填写 targetId，也接受原样的 targetName。
5. 名单顺序不代表优先级。根据威胁、血量、控制与治疗需要选择任何合法目标；合理集火可以保留，不必强行轮换。
6. group/all/random 的目标由引擎决定，targetId 与 targetName 填空；治疗可以选合法的队友或自身。

# 动作描述怎么写
- 贴合这个角色的**性格、武器、境界**（列表里有他的资料）
- 一句话，20~40 字，有画面感
- 不要重复上一回合的描写（可以参考「最近发生」避免雷同）
- 不要用「你」称呼玩家角色，用他的名字

# 输出
严格按 JSON Schema 输出。`;

    const user = [
        auto ? '# 战况简报（你来决定怎么打）' : '# 战况简报（行动已由玩家选定，你只写描述）',
        input.brief,
        '',
        '# 任务',
        auto
            ? '根据战况，为当前行动者选择最合理的技能与目标，并写一句动作描述。'
            : '为当前行动者的这次行动写一句动作描述。技能与目标照简报里玩家选定的来。',
        '记住：描述里**不要出现任何结果**（命中/伤害/闪避），只写动作本身。',
    ].join('\n');

    return { system, user };
}

/**
 * 一轮批量决策的 JSON Schema。
 *
 * 一次让模型把**同侧所有单位**这一轮的行动都想好 —— 5 个敌人只花 1 次调用，
 * 而不是 5 次。多人战时这是数量级的差别。
 */
export const DECIDE_BATCH_JSON_SCHEMA = {
    name: 'battle_actions_batch',
    strict: true,
    value: {
        type: 'object',
        properties: {
            actions: {
                type: 'array',
                description: '每个单位一条，顺序不限，但名字必须与简报里的完全一致。',
                items: {
                    type: 'object',
                    properties: {
                        unitId: {
                            type: 'string',
                            description: '行动单位的稳定 id，优先填写；不用 id 时填空字符串并填写 unitName。',
                        },
                        unitName: {
                            type: 'string',
                            description: '行动单位的名字，必须与简报里的名字完全一致。已填写 unitId 时可留空。',
                        },
                        skillId: {
                            type: 'string',
                            description: '要用的技能 id；用普通攻击填空字符串。只能用该单位自己的技能。',
                        },
                        targetId: {
                            type: 'string',
                            description: '目标单位的稳定 id，优先填写；不用 id 时填空字符串并填写 targetName。',
                        },
                        targetName: {
                            type: 'string',
                            description: '目标单位的名字，必须与该技能合法目标列表里的名字完全一致。已填写 targetId 时可留空。',
                        },
                        action: {
                            type: 'string',
                            enum: ['skill', 'attack', 'defend', 'skip'],
                            description: 'skill=用技能 attack=普通攻击 defend=防御 skip=跳过',
                        },
                        flavor: {
                            type: 'string',
                            description:
                                '一句话描述这个单位**如何**做出这个动作，要符合它的性格与武器。不要写结果（不要说命中了、造成了多少伤害）——结果由骰子决定。',
                        },
                    },
                    required: ['unitId', 'unitName', 'skillId', 'targetId', 'targetName', 'action', 'flavor'],
                    additionalProperties: false,
                },
            },
        },
        required: ['actions'],
        additionalProperties: false,
    },
};

/**
 * 构造**批量**决策提示词：一次想好同侧所有单位这一轮的行动。
 *
 * 与单个版本的差别：
 *  - 简报里列出**每个待决策单位**的技能与状态
 *  - 要求模型**考虑到彼此配合**（谁先控制、谁补刀），这是逐单位决策做不到的
 *  - 每个单位一条，名字必须原样返回（我们要靠名字把决策对回单位）
 *
 * @param {{brief: string, unitNames: string[]}} input
 * @returns {{system: string, user: string}}
 */
export function buildBatchDecidePrompt(input) {
    const system = `你是一个回合制战斗的战术助手。你要**一次**为同一边的多个单位决定这一轮各自怎么做。

# 你要为每个单位决定
- **用哪个技能**（每个单位只能用它自己技能表里的技能；没有合适的就普通攻击）
- **打谁**（目标必须在场上且还活着）
- 一句话的**动作描述**

# 配合很重要
这些单位是同一阵营，你可以在决策时让它们**互相配合**：
例如一个先控制住对方最危险的人，另一个集火已经残血的目标。
但**不要**替它们决定结果 —— 你只决定意图。

# 绝对不能做的事（最重要）
1. **不要决定成败。** 命中与否由骰子决定，你写的描述里**不能**出现「命中」「击中」「刺穿」「躲开」「造成了 X 伤害」这类结果。
   你只写**意图与动作**：「李长风踏前一步，剑光如练」——对；「李长风一剑刺穿敌胸，造成 200 伤害」——错。
2. **不要编造技能。** 只能用简报里给出的、属于该单位自己的技能。
3. **不要改数值。** 不要写 HP 变化、buff 数值，那些由本地引擎算。
4. **每个单位都要有一条**，优先填写 unitId；也接受与简报里**完全一致**的 unitName。
5. 目标必须从该单位所选技能（或普通攻击）的「合法目标」完整列表里选择；优先填写 targetId，也接受原样的 targetName。
6. 名单顺序不代表优先级。根据威胁、血量、控制与治疗需要选任何合法目标；合理集火可以保留，不必强行轮换。
7. group/all/random 的目标由引擎决定，targetId 与 targetName 填空；治疗可以选合法的队友或自身。

# 动作描述怎么写
- 贴合这个单位的**性格、武器、境界**
- 一句话，20~40 字，有画面感
- 同一个单位不要和上一回合描述雷同
- 不要用「你」称呼玩家角色，用名字

# 输出
严格按 JSON Schema 输出，\`actions\` 数组里每个单位一条。`;

    const user = [
        '# 战况简报（同侧全部待决策单位）',
        input.brief,
        '',
        '# 本轮需要你决策的单位',
        input.unitNames.map((n) => `- ${n}`).join('\n'),
        '',
        '# 任务',
        '为上面列出的**每一个**单位决定这一轮的技能与目标，并各写一句动作描述。',
        '注意可以让它们互相配合。记住：描述里**不要出现任何结果**（命中/伤害/闪避），只写动作本身。',
    ].join('\n');

    return { system, user };
}

/**
 * 把多个单位这一轮的处境整理成**一份**简报。
 *
 * 只列待决策的单位及其技能，再附全体状态 —— 不塞完整日志（费 token 又干扰判断）。
 *
 * @param {any} battle
 * @param {any[]} units 待决策的单位
 * @returns {string}
 */
export function renderBatchBrief(battle, units) {
    if (!battle) return '（没有战斗）';
    const lines = [`第 ${battle.round ?? '?'} 回合`];
    lines.push('');

    lines.push('全体单位现状：');
    const all = Array.isArray(battle.units) ? battle.units : [];
    for (const u of all) {
        if (!u) continue;
        const hp = u.attributes?.HP;
        const pct = hp?.max ? Math.round(((hp.current ?? 0) / hp.max) * 100) : 0;
        const side = u.side === 'ally' ? '我方' : u.side === 'enemy' ? '敌方' : '中立';
        lines.push(
            `- ${side} ${unitLabel(u)}${u.tier ? `[${u.tier}]` : ''}：` +
                (u.alive === false ? '已阵亡' : `HP ${hp?.current ?? 0}/${hp?.max ?? 0}（${pct}%）`) +
                `，攻 ${u.attributes?.Atk?.current ?? 0}，甲 ${u.attributes?.Armor?.current ?? 0}` +
                (u.statuses?.length
                    ? `，状态：${u.statuses.map((/** @type {any} */ s) => `${s?.name ?? '?'}${s?.duration ? `(${s.duration})` : ''}`).join('、')}`
                    : ''),
        );
    }
    lines.push('');

    for (const unit of units) {
        if (!unit) continue;
        lines.push(`## ${unit.name}（需要你决策）${unit.id ? ` [unitId=${unit.id}]` : ''}`);
        lines.push(
            `HP ${unit.attributes?.HP?.current ?? 0}/${unit.attributes?.HP?.max ?? 0}，` +
                `MP ${unit.attributes?.MP?.current ?? 0}/${unit.attributes?.MP?.max ?? 0}，` +
                `攻 ${unit.attributes?.Atk?.current ?? 0}，甲 ${unit.attributes?.Armor?.current ?? 0}`,
        );
        if (unit.skills?.length) {
            for (const s of unit.skills) {
                if (!s) continue;
                lines.push(
                    `- id=${s.id}　${s.name ?? '（无名）'}：威力 ${s.power}，命中 ${s.aim}，消耗 ${s.cost ?? 0} MP，` +
                        `目标 ${s.target}；${skillDecisionDetails(battle, unit, s)}` +
                        (s.description ? `　说明：${s.description}` : ''),
                );
            }
        } else {
            lines.push('- （没有技能，只能普通攻击）');
        }
        lines.push(basicAttackDetails(battle, unit));
        lines.push('');
    }

    const recent = (Array.isArray(battle.log) ? battle.log : [])
        .slice(-5)
        .map((/** @type {any} */ l) => l?.text)
        .filter(Boolean);
    if (recent.length) {
        lines.push('最近发生：');
        for (const t of recent) lines.push(`· ${t}`);
    }

    return lines.join('\n');
}

/**
 * **一次**为多个单位决定这一轮的行动。
 *
 * 多人战的关键优化：5 个敌人原本要 5 次调用，现在只要 1 次。
 * 顺带还能让模型考虑**彼此配合**（先控住谁、再集火谁），
 * 这是逐单位分别决策做不到的。
 *
 * 返回的 `decisions` 以**单位 id** 为键，方便调用方直接查。
 *
 * @param {any} ctx
 * @param {object} settings
 * @param {any} battle
 * @param {any[]} units 要一起决策的单位（通常是同侧的全部存活单位）
 * @param {{signal?: AbortSignal, onProgress?: Function}} [opts]
 * @returns {Promise<{ok: boolean, error?: string, aborted?: boolean, decisions?: Record<string, any>, logs: string[]}>}
 */
export async function decideActionsBatch(ctx, settings, battle, units, opts = {}) {
    /** @type {string[]} */
    const logs = [];
    const log = (/** @type {string} */ msg) => {
        logs.push(msg);
        console.log(`[战斗掷骰][批量决策] ${msg}`);
        opts.onProgress?.('log', msg);
    };

    const list = (units ?? []).filter((u) => u && u.alive !== false);
    if (!list.length) return { ok: true, decisions: {}, logs };
    if (list.length === 1) {
        // 只有一个单位时没必要走批量路径
        const single = await decideAction(ctx, {
            ...settings, battle: { ...settings?.battle, decideMode: DECIDE_MODE.AUTO },
        }, battle, { ...opts, _forceUnit: list[0] });
        if (!single.ok) return { ok: false, error: single.error, aborted: single.aborted, logs: [...logs, ...single.logs] };
        return {
            ok: true,
            decisions: { [list[0].id]: single.decision },
            logs: [...logs, ...single.logs],
        };
    }

    if (opts.signal?.aborted) {
        return { ok: false, aborted: true, error: '已被用户终止', logs };
    }

    /** @type {Record<string, any>} */
    const channel = settings.p2.channel;
    const client = new LlmClient(ctx, channel, '批量决策');

    const brief = renderBatchBrief(battle, list);
    const { system, user } = buildBatchDecidePrompt({ brief, unitNames: list.map(unitLabel) });

    const started = Date.now();
    const response = await client.complete({
        system,
        user,
        jsonSchema: DECIDE_BATCH_JSON_SCHEMA,
        signal: opts.signal,
        temperature: 0.85,
        expectedOutputRatio: 0.45,
    });

    if (response.aborted || opts.signal?.aborted) {
        return { ok: false, aborted: true, error: '已被用户终止', logs };
    }
    if (!response.ok) {
        const reason = describeError(response.error) || '批量决策请求失败';
        log(`✖ 批量决策失败：${reason}`);
        return { ok: false, error: reason, logs };
    }
    if (response.meta?.notice) log(`ℹ️ ${response.meta.notice}`);

    // ---- 解析：多路兜底 ----
    //
    // 踩过的坑：只靠 `parseJsonLoose` 时，模型哪怕只是多写了一句「好的，这是我的决策：」
    // 或者漏了个逗号，就会整批解析失败、0 个单位 —— 用户看到「已想好 0/2 个单位」。
    // 所以这里依次尝试：宽松解析 → 从文本里抠平衡 JSON → 从 Markdown 代码块里抠。
    /** @type {any[]|null} */
    let rawActions = null;
    const attempts = [];

    const loose = parseJsonLoose(response.text);
    if (loose.ok) {
        const v = /** @type {any} */ (loose.value);
        if (Array.isArray(v)) rawActions = v;
        else if (Array.isArray(v?.actions)) rawActions = v.actions;
        // 有的模型会直接把单个单位的结果平铺出来
        else if (v?.unitName || v?.unitId) rawActions = [v];
    }
    attempts.push(`宽松解析：${Array.isArray(rawActions) ? rawActions.length + ' 条' : '失败'}`);

    if (!Array.isArray(rawActions) || rawActions.length < list.length) {
        for (const candidate of extractBalancedCandidates(response.text)) {
            // extractBalancedCandidates 的公开 API 返回 string[]，不是 {text}[]。
            const parsed = parseJsonLoose(candidate);
            if (!parsed.ok) continue;
            const v = parsed.value;
            const found = Array.isArray(v?.actions) ? v.actions : Array.isArray(v) ? v
                : v?.unitName || v?.unitId ? [v] : null;
            if (found && found.length > (rawActions?.length ?? 0)) rawActions = found;
            if (rawActions?.length >= list.length) break;
        }
        attempts.push(`平衡提取：${Array.isArray(rawActions) ? rawActions.length + ' 条' : '失败'}`);
    }

    if (!Array.isArray(rawActions) || !rawActions.length) {
        log('⚠ 批量决策结果无法解析，本回合改用本地规则（每个单位仍会正常出手）');
        log(`  尝试过程：${attempts.join(' → ')}`);
        log(`  模型原始返回（前 600 字）：${String(response.text).slice(0, 600)}`);
        return { ok: true, decisions: {}, logs, parseFailed: true, raw: response.text };
    }

    /** @type {Record<string, any>} */
    const decisions = {};
    for (const raw of rawActions) {
        const unitName = toText(raw?.unitName);
        const unitId = toText(raw?.unitId);
        const unit = matchUnit(list, unitId, unitName);
        if (!unit) {
            if (unitId || unitName) log(`⚠ 模型给的单位「${unitName || unitId}」不在待决策列表里或名字重复，已忽略`);
            continue;
        }
        decisions[unit.id] = normalizeDecision(raw, battle, unit, log);
    }

    const missing = list.filter((u) => !decisions[u.id]);
    if (missing.length) {
        log(`⚠ ${missing.map((u) => u.name).join('、')} 没有拿到决策，这些单位将使用本地规则`);
    }

    log(
        `✓ 批量决策完成（${Date.now() - started} ms）：${list.length} 个单位，` +
            `${Object.keys(decisions).length} 条可用决策` +
            (list.length > 1 ? `（省下 ${list.length - 1} 次调用）` : ''),
    );
    return { ok: true, decisions, logs };
}

/**
 * 让 AI 思考一次行动。
 *
 * 这个函数会被**在骰子开始转之后**调用 —— 它花掉的每一毫秒，
 * 都是骰子在转的时间。
 *
 * @param {any} ctx
 * @param {object} settings
 * @param {any} battle
 * @param {{signal?: AbortSignal, preselect?: {skillId?: string, targetId?: string, targetName?: string, action?: string}, onProgress?: Function, _forceUnit?: object}} [opts]
 * @returns {Promise<{ok: boolean, error?: string, aborted?: boolean, decision?: {skillId: string, targetId: string, targetName: string, action: string, flavor: string}, logs: string[]}>}
 */
export async function decideAction(ctx, settings, battle, opts = {}) {
    /** @type {string[]} */
    const logs = [];
    const log = (/** @type {string} */ msg) => {
        logs.push(msg);
        console.log(`[战斗掷骰][决策] ${msg}`);
        opts.onProgress?.('log', msg);
    };

    const mode = settings?.battle?.decideMode ?? DECIDE_MODE.FLAVOR;
    // `_forceUnit` 供批量决策在「只有一个单位」时复用这条路径
    const unit = opts._forceUnit ?? battle?.currentUnit;
    if (!unit) return { ok: false, error: '当前没有行动单位', logs };

    let brief = renderBattleBrief(battle, unit);
    if (mode === DECIDE_MODE.FLAVOR && opts.preselect) {
        const choice = opts.preselect;
        brief += `\n\n玩家选定：action=${choice.action ?? (choice.skillId ? 'skill' : 'attack')}，` +
            `skillId=${choice.skillId ?? ''}，targetId=${choice.targetId ?? ''}，targetName=${choice.targetName ?? ''}`;
    }

    // ---- 模式 off：完全不调 API ----
    if (mode === DECIDE_MODE.OFF) {
        return { ok: true, decision: { skillId: '', targetId: '', targetName: '', action: '', flavor: '' }, logs };
    }

    if (opts.signal?.aborted) {
        return { ok: false, aborted: true, error: '已被用户终止', logs };
    }

    /** @type {Record<string, any>} */
    const channel = settings.p2.channel;
    const client = new LlmClient(ctx, channel, '战斗决策');

    const { system, user } = buildDecidePrompt({ brief, mode, unitName: unit.name });
    const started = Date.now();
    const response = await client.complete({
        system,
        user,
        jsonSchema: DECIDE_JSON_SCHEMA,
        signal: opts.signal,
        temperature: 0.85,
        expectedOutputRatio: 0.3,
    });

    if (response.aborted || opts.signal?.aborted) {
        return { ok: false, aborted: true, error: '已被用户终止', logs };
    }
    if (!response.ok) {
        const reason = describeError(response.error) || '决策请求失败';
        log(`✖ 决策失败：${reason}`);
        return { ok: false, error: reason, logs };
    }
    if (response.meta?.notice) log(`ℹ️ ${response.meta.notice}`);

    let parsed = parseJsonLoose(response.text);
    const isDecision = value => value && typeof value === 'object' && !Array.isArray(value) &&
        ['action', 'skillId', 'targetId', 'targetName'].some(key => Object.hasOwn(value, key));
    if (!parsed.ok || !isDecision(parsed.value)) {
        for (const candidate of extractBalancedCandidates(response.text)) {
            const attempt = parseJsonLoose(candidate);
            if (attempt.ok && isDecision(attempt.value)) { parsed = attempt; break; }
        }
    }
    if (!parsed.ok || !isDecision(parsed.value)) {
        log(`⚠ 决策结果无法解析，本回合退回本地规则`);
        return { ok: true, decision: { skillId: '', targetId: '', targetName: '', action: '', flavor: '' }, logs };
    }

    let raw = /** @type {any} */ (parsed.value);
    // 明确的空 skillId 表示玩家选了普攻，不得被模型擅自换成技能。
    if (mode === DECIDE_MODE.FLAVOR && opts.preselect) {
        raw = {
            ...raw,
            skillId: toText(opts.preselect.skillId),
            targetId: toText(opts.preselect.targetId),
            targetName: toText(opts.preselect.targetName),
            action: toText(opts.preselect.action) || (opts.preselect.skillId ? 'skill' : 'attack'),
        };
    }
    const decision = normalizeDecision(raw, battle, unit, log);

    log(`✓ 决策完成（${Date.now() - started} ms）${decision.flavor ? `：${decision.flavor}` : ''}`);
    return { ok: true, decision, logs };
}
