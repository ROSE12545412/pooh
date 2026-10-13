/**
 * tavern-dice / src/llm/setup.js
 * ---------------------------------------------------------------------------
 * 「开战」前的场面读取。
 *
 * ## 分工
 *
 * 一次战斗要两件事：
 *  1. **眼下谁在打、什么状态** —— 这必须问**正文模型**（当前聊天在用的那个），
 *     因为只有它完整读过这张卡、这段剧情、这些世界书。别的模型看几段摘要是猜不准的。
 *  2. **把场面变成能掷骰的数据** —— 这交给**掷骰模型**（同一份数据，结构化提取）。
 *
 * 所以开战流程是：
 *
 *     用户写「我方三人围攻血魔」+ 点开战
 *        ↓  正文模型（带完整上下文）
 *     读出场面对手、人数、状态、血量估算、技能、临时加成
 *        ↓  掷骰模型（只看这段，便宜快）
 *     结构化 → 用户确认 → 引擎掷骰
 *
 * ## 为什么不让用户填表
 *
 * 填表要求用户把模型已经知道的东西再手打一遍 —— 麻烦且容易填错。
 * 让正文模型自己读，用户只需要**描述一下要打谁**（甚至只点个按钮）。
 */

import { toText } from '../core/schema.js';
import { LlmClient, describeError, extractPowerSystem, getTavernHelper, parseJsonLoose } from './client.js';
import { parseCombatBlock } from '../core/schema.js';
import { renderRecentMessages } from './pipelines.js';

/** 通道模式的中文名，用于日志（让用户看得出插件在试什么）。 */
const CHANNEL_MODE_LABEL = Object.freeze({
    main: '主连接（复用当前聊天在用的模型）',
    'tavern-helper': '酒馆助手（TavernHelper）',
    profile: '连接配置（Connection Profile）',
    custom: '直连（OpenAI 兼容端点）',
});

/**
 * 构造「请正文模型读出当前场面」的提示词。
 *
 * 关键设计：
 *  - **让模型用自然语言汇报**，不要 JSON —— 正文模型的任务是「理解剧情」，
 *    强行要求 JSON 反而容易出错。结构化交给下一步的掷骰模型。
 *  - 明确要求**估算**而不是编造精确值：模型不知道确切血量，但能从「他吐了口血」
 *    估出「大概七成」。
 *  - 要求**如实说明不确定的地方**。
 *
 * @param {{situation?: string, recentChat: string, characterName?: string, userName?: string, knownUnits?: string}} input
 * @returns {{system: string, user: string}}
 */
export function buildSituationPrompt(input) {
    const system = `你是一个战斗场面记录员。用户要开始一场战斗，你的任务是**读懂当前的剧情场面**，把参战方汇报清楚。

# 你要读出来的东西
1. **有哪些人在打** —— 我方（含玩家角色与同伴）与敌方，各自的**名字**（用剧情里的叫法）。
   如果剧情里有名有姓的人都列上；杂兵可以合并成一条并注明数量（例如「魔修弟子 ×5」）。
2. **各自当前的状态** —— 是否受伤、大约还有多少血（用**百分比或档位**描述，例如「约七成」「重伤」「满状态」）、
   是否中毒/被控制/有增益。**你不需要精确数字**，凭剧情描述估算即可，但要说明是估算。
3. **各自的技能 / 招式** —— 剧情里表现过或用过的，以及你对这个角色的了解。
   不确定就写「未知」，不要编。
4. **武器与装备** —— 剧情或设定里提到的武器、法宝、护具。
5. **临时加成** —— 此刻生效的增益或减益：阵法、嗑药、buff 法术、地形优势、偷袭先手等。
6. **战场环境** —— 一句话：在哪打、有没有影响战斗的因素（狭窄、黑暗、高低差）。

# 铁律
1. **只写剧情里能支持的内容。** 剧情没提到的技能、装备不要编。
2. **区分「确定」与「估算」。** 血量一律是估算，请明确标注。
3. **不要替用户决定怎么打。** 你只负责记录场面，不做战术建议。
4. **用自然语言分条汇报**，不要输出 JSON。格式随意，写清楚就行。
5. 如果剧情里**其实没有正在发生的战斗**，直接说明「当前剧情没有战斗场面」，
   并列出**接下来最可能与谁发生冲突**（如果剧情有暗示的话）。`;

    const parts = [
        '# 当前角色卡语境',
        `- 角色卡：${toText(input.characterName) || '（未知）'}`,
        `- 玩家扮演：${toText(input.userName) || '（未知）'}`,
        '',
    ];

    if (input.knownUnits) {
        parts.push('# 已有的战力表（可参考，但**以当前剧情为准**）');
        parts.push(input.knownUnits);
        parts.push('');
    }

    if (toText(input.situation)) {
        parts.push('# 用户对战况的补充说明（优先级最高）');
        parts.push(toText(input.situation));
        parts.push('');
    }

    parts.push('# 最近的剧情');
    parts.push(input.recentChat || '（没有可读的剧情）');
    parts.push('');

    parts.push('# 任务');
    parts.push('读完上面的剧情，分条汇报：参战的双方都有谁、各自什么状态（血量用估算）、技能、装备、临时加成、战场环境。');
    parts.push('记住：不要编造剧情里没有的内容；血量明确标注为估算。');

    return { system, user: parts.join('\n') };
}

/**
 * 请正文模型读出当前场面。
 *
 * @param {any} ctx
 * @param {object} settings
 * @param {{situation?: string, signal?: AbortSignal, onProgress?: Function, scanMessages?: number, knownUnits?: string}} [opts]
 * @returns {Promise<{ok: boolean, error?: string, aborted?: boolean, report?: string, hasBattle?: boolean, logs: string[]}>}
 */
export async function readSituation(ctx, settings, opts = {}) {
    /** @type {string[]} */
    const logs = [];
    const log = (/** @type {string} */ msg) => {
        logs.push(msg);
        console.log(`[战斗掷骰][场面] ${msg}`);
        opts.onProgress?.('log', msg);
    };

    if (opts.signal?.aborted) {
        return { ok: false, aborted: true, error: '已被用户终止', logs };
    }

    const count = Math.max(4, Math.min(60, Number(opts.scanMessages) || 12));
    const { text: recentChat } = renderRecentMessages(ctx, count, { maxCharsPerMessage: 4000 });
    if (!recentChat.trim()) {
        return { ok: false, error: '最近的聊天里没有可读的内容', logs };
    }
    log(`读取最近 ${count} 条剧情（${recentChat.length} 字）`);

    const chid = ctx?.characterId;
    const char = typeof chid === 'number' ? ctx?.characters?.[chid] : ctx?.character;

    // 正文模型 = 「复用主连接」或用户指定
    const channel = resolveNarrativeChannel(settings);
    const client = new LlmClient(ctx, channel, '场面读取');

    // 把「用哪条通道、哪个模型」写进日志 —— 出问题时这是第一手信息。
    // 早期版本不说这些，用户只看到一句错误，根本不知道插件在试什么。
    const modeLabel = CHANNEL_MODE_LABEL[channel?.mode] ?? channel?.mode ?? '（未指定）';
    log(`正文模型通道：${modeLabel}${channel?.model ? ` · 模型 ${channel.model}` : ''}`);
    if (channel?.mode === 'main') {
        const helper = getTavernHelper();
        const helperOk = Boolean(helper && typeof helper.generateRaw === 'function');
        log(`  主连接依赖酒馆助手（TavernHelper）：${helperOk ? '✅ 已检测到' : '❌ 未检测到'}`);
    }

    const { system, user } = buildSituationPrompt({
        situation: opts.situation,
        recentChat,
        characterName: toText(char?.name) || toText(ctx?.name2),
        userName: toText(ctx?.name1),
        knownUnits: opts.knownUnits,
    });

    const response = await client.ask(system, user, { signal: opts.signal, expectedOutputRatio: 0.8 });
    if (response.aborted || opts.signal?.aborted) {
        return { ok: false, aborted: true, error: '已被用户终止', logs };
    }
    if (!response.ok) {
        const reason = describeError(response.error) || '请求失败（没有拿到可读的错误信息，请按 F12 看控制台）';
        log(`✖ 场面读取失败：${reason}`);
        // 给可操作的建议，而不是让用户对着一个错误干瞪眼
        if (channel?.mode === 'main') {
            log('  提示：「主连接」要求酒馆助手（JS-Slash-Runner）已安装并启用。');
            log('  也可以到「设置 → 战斗」把「正文模型通道」改成「战斗模型」（用你自己的 API）。');
        }
        return { ok: false, error: reason, logs };
    }
    const report = response.text.trim();
    const hasBattle = !/当前剧情没有战斗场面|没有正在发生的战斗|无战斗/.test(report);
    log(`✓ 场面读取完成（${report.length} 字）${hasBattle ? '' : '，但模型认为当前没有战斗'}`);

    return { ok: true, report, hasBattle, logs };
}
/**
 * 决定「正文模型」用哪条通道。
 *
 * 默认走**主连接**：那才是用户当前聊天正在用的模型，也是唯一完整读过这张卡与这段剧情的。
 * 用户在设置里显式指定了别的通道就听他的。
 *
 * @param {object} settings
 * @returns {object}
 */
export function resolveNarrativeChannel(settings) {
    const configured = toText(settings?.battle?.narrativeChannel);
    if (configured === 'p2') return settings.p2.channel;
    if (configured === 'main') return { mode: 'main' };

    // 默认：优先用主连接；但它未必可用，所以这里给一个「主连接优先」的配置
    return { mode: 'main' };
}

/**
 * 统计一份（可能还没归一化的）战力体系里有多少个单位。
 *
 * ⚠️ 必须同时认三种形态 —— 这是踩过的坑：
 *  - `{allies: [...], enemies: [...]}` —— 提示词里的标准分栏
 *  - `{combatants: [...]}`              —— **统一列表格式，归一化阶段完全接受**
 *  - `{我方: [...], 敌方: [...]}`        —— 中文键名
 *
 * 早期版本只数 `allies` + `enemies`，于是模型一旦返回统一格式就会数出 0，
 * 报「没能识别出参战者」—— **明明数据是好的，却被判成失败**。
 * 用户看到的现象就是「汇报里双方都读出来了，还是说没检测到谁在打谁」。
 *
 * @param {any} system
 * @returns {number}
 */
export function countUnits(system) {
    if (!system || typeof system !== 'object') return 0;
    const buckets = [
        system.allies,
        system.enemies,
        system.combatants,
        system.units,
        system.我方,
        system.敌方,
        system.角色,
    ];
    let total = 0;
    for (const bucket of buckets) {
        if (Array.isArray(bucket)) total += bucket.length;
    }
    if (total > 0) return total;
    // 有的模型直接返回一个数组
    if (Array.isArray(system)) return system.length;
    return 0;
}

/**
 * 把场面汇报交给掷骰模型，转成结构化战力体系。
 *
 * ⚠️ 设计上踩过一个坑：早期版本**只把「汇报」给这一步**，不给原始剧情。
 * 结果第一个模型要是漏了人、或者把话说含糊了，这一步就无从补救 ——
 * 最后产出 0 个单位、报「没有任何战斗单位，无法开战」。
 *
 * 现在把**原始剧情也一起给**：汇报是主依据（它已经提炼过），
 * 剧情是后备（汇报漏了谁，从这里补）。多花几百到几千 token，换来的是「读得出人」。
 *
 * @param {any} ctx
 * @param {object} settings
 * @param {string} report 正文模型给出的场面汇报
 * @param {{signal?: AbortSignal, onProgress?: Function, powerSystem?: object, recentChat?: string, situation?: string}} [opts]
 * @returns {Promise<{ok: boolean, error?: string, aborted?: boolean, system?: object, logs: string[]}>}
 */
export async function structureSituation(ctx, settings, report, opts = {}) {
    /** @type {string[]} */
    const logs = [];
    const log = (/** @type {string} */ msg) => {
        logs.push(msg);
        console.log(`[战斗掷骰][结构化] ${msg}`);
        opts.onProgress?.('log', msg);
    };

    if (opts.signal?.aborted) {
        return { ok: false, aborted: true, error: '已被用户终止', logs };
    }

    /** @type {Record<string, any>} */
    const channel = settings.p2.channel;
    const client = new LlmClient(ctx, channel, '场面结构化');

    const system = `你是一个数据转换器。用户会给你一段**战斗场面汇报**（自然语言，已由另一个模型读过剧情后提炼），
你要把它转成结构化的战斗数据。可能还会附上**原始剧情**作为补充。

# 规则
1. **以汇报为主依据，原始剧情为后备。** 汇报里明确写了的人物、技能、装备照抄；汇报漏了但剧情里明显在场的角色，从剧情里补上。
2. **至少要有一个人。** 如果汇报里提到了任何参战者（哪怕是「一群魔修弟子」），都要产出对应的单位 ——
   无名杂兵合并成一条并在名字里写数量（例如「魔修弟子 ×5」）。
   **绝对不要返回空的 allies 与 enemies** —— 那等于告诉用户「没人打架」，是最没用的结果。
3. **数值靠合理换算，并在 notes 里注明是估算**：
   - 汇报说「约七成血」→ 若该角色满血按 500 算，就填 HP 350/500
   - 汇报说「重伤」「濒死」→ 大约 10%~25%
   - 汇报说「满状态」→ 填满
   - 汇报没有具体数值时，按该角色的**实力定位**给一个合理的满血值
     （杂兵 100~300，精英 500~1500，强者 2000~5000），并在 notes 里写明是估算
4. **技能与装备按汇报内容填。** 汇报写「未知」的就留空数组，不要编。
5. **临时加成要体现为 \`statuses\`**（例如「嗑了爆灵丹」→ 一个 buff 状态）。
6. **阵营必须分清**：汇报里的我方 → \`allies\`，敌方 → \`enemies\`。
   汇报没说清谁是敌谁是友时，按剧情推断；实在判断不了就放 \`enemies\`（因为开战需要双方）。
7. 战力评分按汇报里的实力描述给一个 0~100 的估计，并在 basis 里写明依据。

# 输出
严格按 JSON Schema 输出。\`system.scale\` 里写明你用的数值口径与估算方式。`;

    const user = [
        '# 战斗场面汇报（主依据）',
        report,
        '',
        opts.situation ? '# 用户对战况的补充说明（优先级最高）' : '',
        opts.situation ?? '',
        '',
        opts.recentChat ? '# 原始剧情（后备：汇报漏了谁，从这里补）' : '',
        opts.recentChat ?? '',
        '',
        opts.powerSystem ? '# 已有战力表（可用于对齐数值口径；但场面汇报优先）' : '',
        opts.powerSystem
            ? opts.powerSystem.combatants
                  .slice(0, 40)
                  .map((/** @type {any} */ u) => `${u.name}（${u.side}）HP上限${u.attributes?.HP?.max ?? '?'}`)
                  .join('、')
            : '',
        '',
        '# 任务',
        '把上面的场面转成结构化战斗数据。以汇报为主、剧情为后备；数值是估算，请在 notes 与 scale 里注明。',
        '记住：**至少要产出一个人**，绝不能返回空的 allies 与 enemies。',
    ]
        .filter(Boolean)
        .join('\n');

    const { BATTLE_JSON_SCHEMA } = await import('../prompts/index.js');
    const response = await client.ask(system, user, {
        jsonSchema: BATTLE_JSON_SCHEMA,
        signal: opts.signal,
        expectedOutputRatio: 1.0,
    });

    if (response.aborted || opts.signal?.aborted) {
        return { ok: false, aborted: true, error: '已被用户终止', logs };
    }
    if (!response.ok) {
        log(`✖ 结构化失败：${describeError(response.error) || '没有拿到可读的错误信息'}`);
        return { ok: false, error: describeError(response.error) || '结构化失败', logs };
    }
    if (response.meta?.notice) log(`ℹ️ ${response.meta.notice}`);

    const extracted = extractPowerSystem(response.text, parseCombatBlock);
    if (!extracted.ok) {
        // 再退一步：试试能不能抠出 JSON
        const loose = parseJsonLoose(response.text);
        if (!loose.ok) {
            log(`✖ 返回内容无法解析：${extracted.error}`);
            // 把原始返回贴进日志 —— 光说「解析失败」用户没法排查，
            // 看到实际返回才知道是模型不听话还是格式问题
            log(`  模型原始返回（前 500 字）：${response.text.slice(0, 500)}`);
            return { ok: false, error: extracted.error, logs };
        }
        log('⚠ 用宽松解析救回来了');
        const looseSystem = /** @type {any} */ (loose.value);
        // 注意：这里必须用 countUnits（认三种形态），不能只数 allies/enemies
        if (countUnits(looseSystem) === 0) {
            log('✖ 解析出的数据里没有任何战斗单位');
            log(`  模型原始返回（前 800 字）：${response.text.slice(0, 800)}`);
            return { ok: false, error: '模型没有产出任何战斗单位（原始返回已记入日志）', logs };
        }
        return { ok: true, system: looseSystem, logs };
    }

    // 解析成功但一个单位都没数到 —— 到这里才该判失败。
    // 注意用 countUnits 而不是只看 allies/enemies：统一格式（combatants）也是合法的。
    if (countUnits(extracted.value) === 0) {
        log('✖ 结构化结果里没有任何战斗单位');
        log('  可能原因：正文模型认为当前剧情没有战斗场面，或汇报里没写清参战者。');
        log(`  场面汇报（前 300 字）：${report.slice(0, 300)}`);
        log(`  模型原始返回（前 800 字）：${response.text.slice(0, 800)}`);
        return {
            ok: false,
            error:
                '模型没能从当前剧情里识别出参战者。可以在上面的输入框里写清「谁在打谁」再试一次，' +
                '或到「设置 → ⚔ 战斗用哪两个模型」把「掷骰模型」换成能力更强的通道。',
            logs,
        };
    }

    const allyCount = extracted.value?.allies?.length ?? 0;
    const enemyCount = extracted.value?.enemies?.length ?? 0;
    const total = countUnits(extracted.value);
    log(
        allyCount || enemyCount
            ? `✓ 结构化完成：${allyCount} 我方 / ${enemyCount} 敌方`
            : `✓ 结构化完成：共 ${total} 个单位（模型用了统一列表格式，归一化时会按 side 自动分阵营）`,
    );
    return { ok: true, system: /** @type {any} */ (extracted.value), logs };
}
