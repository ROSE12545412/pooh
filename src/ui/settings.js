/**
 * tavern-dice / src/ui/settings.js
 * ---------------------------------------------------------------------------
 * 设置视图：当前场景、战斗模型、掷骰规则、结果发送与存档。
 */

import { LlmClient, describeError } from '../llm/client.js';
import { listPersonaBooks } from '../llm/persona-worldbook.js';
import { Rng } from '../core/rng.js';
import { describeEndpoint } from '../config.js';
import {
    FORMULA_FUNCTIONS,
    FORMULA_VARIABLES,
    GENERIC_D20,
    POWER_MODE_LABEL,
    RulesetEvaluator,
    clearFormulaCache,
    normalizeRuleset,
    sniffPowerMode,
} from '../core/ruleset.js';
import { exportAll, importAll } from '../core/store.js';
import {
    button,
    checkbox,
    clear,
    confirmDialog,
    drawer,
    el,
    field,
    openModal,
    select,
    stat,
    textInput,
    toast,
} from './dom.js';

/** 通道模式选项。 */
function channelModeOptions(app, channel) {
    const probe = LlmClient.probe(app.ctx);
    /** @type {Array<{value: string, label: string, title?: string}>} */
    const options = [];

    if (probe.profiles.length) {
        options.push({
            value: 'profile',
            label: `连接配置（推荐，已有 ${probe.profiles.length} 个）`,
            title: '复用你在酒馆「连接配置」里保存的配置。Key 存在酒馆的 secrets 里，不用另填。',
        });
    }

    options.push({
        value: 'tavern-helper',
        label: probe.tavernHelper
            ? '酒馆助手 generateRaw（已安装 JS-Slash-Runner）'
            : '酒馆助手 generateRaw（需先装 JS-Slash-Runner 扩展）',
        title: '「酒馆助手」是扩展 JS-Slash-Runner 在界面上显示的名字，作者 KAKAA。装了它才能在扩展里跑自定义脚本，本插件用它的 generateRaw 发请求。',
    });

    options.push({
        value: 'custom',
        label: '直连 OpenAI 兼容端点',
        title: '自己填 API 地址 / Key / 模型，不依赖任何其它扩展。',
    });

    options.push({
        value: 'main',
        label: '复用当前主连接（兜底，会被预设影响）',
        title: '沿用当前聊天的主连接。最省事，但会被当前预设与上下文影响，输出格式可能不稳定。',
    });

    return options;
}

/** 正文场景读取、结构化与战斗决策设置。 */
function renderBattleChannelDrawer(app, helpers) {
    const settings = app.settings;
    const battle = settings.battle;
    // 兼容旧存档中的建表通道选择；战斗请求统一改用现有战斗模型。
    for (const key of ['narrativeChannel', 'structureChannel', 'decideChannel']) {
        if (battle[key] === 'p1') battle[key] = 'p2';
    }
    const probe = LlmClient.probe(app.ctx);
    const body = el('div', { class: 'td-form' });

    body.appendChild(
        el('p', { class: 'notes' }, [
            '开战分两步：**正文模型**读当前场面（谁在打、什么状态、血量估算、技能、临时加成），',
            '**掷骰模型**把这份汇报转成可掷骰的数据。两者需求不同，所以可以分开配。',
        ].join('')),
    );

    // ---- 环境自检：把「能不能用主连接」直接摊开 ----
    const helperOk = probe.tavernHelper;
    body.appendChild(
        el('div', { class: helperOk ? 'td-test-ok' : 'td-warn-box' }, [
            el('b', {}, helperOk ? '✅ 主连接可用' : '⚠️ 主连接不可用'),
            el('div', { class: 'notes' }, [
                helperOk
                    ? `已检测到酒馆助手（TavernHelper${probe.tavernHelperVersion ? ` v${probe.tavernHelperVersion}` : ''}），「主连接」模式可以复用你当前聊天在用的模型。`
                    : '「主连接」依赖酒馆助手扩展 **JS-Slash-Runner**（界面上叫「酒馆助手」）。没装或没启用时，' +
                      '「主连接」会失败 —— 请把下面的「正文模型」改成「战斗模型」。',
            ].join('')),
        ]),
    );

    body.appendChild(
        field(
            '正文模型（读当前场面）',
            select(
                [
                    { value: 'main', label: '主连接（当前聊天在用的模型）' },
                    { value: 'p2', label: '战斗模型' },
                ],
                battle.narrativeChannel,
                async (v) => {
                    battle.narrativeChannel = v;
                    await app.persistSettings({ silent: true });
                    helpers.rerender();
                },
            ),
            '为什么默认用主连接：只有**当前聊天在用的那个模型**完整读过这张卡与这段剧情，它读场面最准。' +
                '但它需要酒馆助手支持；不可用时就换成你自己配的通道。',
        ),
    );

    body.appendChild(
        field(
            '掷骰模型（结构化数据）',
            select(
                [
                    { value: 'p2', label: '战斗模型（结构化与决策）' },
                ],
                battle.structureChannel,
                async (v) => {
                    battle.structureChannel = v;
                    await app.persistSettings({ silent: true });
                },
            ),
            '这一步只是「把一段文字转成 JSON」，输入很短，用便宜快的模型就够。',
        ),
    );

    body.appendChild(
        el('div', { class: 'td-form-inline' }, [
            field('扫描最近多少条消息', textInput({
                value: String(battle.scanMessages ?? 12),
                type: 'number',
                min: '4',
                max: '60',
                onInput: (v) => {
                    battle.scanMessages = Number(v);
                },
            }), '读场面时给模型看多少条剧情。太少会漏掉在场的人。'),
            field('随机种子', textInput({
                value: battle.seed ?? '',
                placeholder: '留空则随机',
                onInput: (v) => {
                    battle.seed = v;
                },
            }), '记下种子可以复盘同一场战斗。'),
        ]),
    );

    // ---- 回合流程：AI 思考 + 掷骰动画 ----
    body.appendChild(el('hr', { class: 'td-hr' }));
    body.appendChild(el('div', { class: 'td-mini-label' }, '回合流程'));
    body.appendChild(
        el('div', { class: 'notes' }, [
            '每个回合的时序：**骰子开始转 → 调 API 思考本次行动 → 骰子停下显示结果 → 本地引擎结算**。',
            '等待 API 的那几秒正好是骰子在转 —— 等待被变成了仪式感。',
        ].join('')),
    );

    body.appendChild(
        field(
            '每回合让 AI 思考吗',
            select(
                [
                    { value: 'flavor', label: '只让 AI 写动作描述（推荐）' },
                    { value: 'auto', label: '让 AI 决定用哪个技能打谁' },
                    { value: 'off', label: '不调用（纯本地规则，最快）' },
                ],
                battle.decideMode,
                async (v) => {
                    battle.decideMode = v;
                    await app.persistSettings({ silent: true });
                    helpers.rerender();
                },
            ),
            battle.decideMode === 'flavor'
                ? '你点技能选目标，AI 为这次行动写一句符合角色性格的描述（例如「李长风踏前一步，剑光如练」）。**AI 不决定成败** —— 命中与否由骰子说了算。'
                : battle.decideMode === 'auto'
                  ? '连「用哪个技能、打谁」都交给 AI 决定，你只负责看。最像「AI 在打」，但你会失去操作感，且每回合都要一次调用。'
                  : '完全不调 API，用引擎的启发式规则选目标。最快、零成本，但攻击描述是机械的。',
        ),
    );

    body.appendChild(
        field(
            '战斗模式',
            select(
                [
                    { value: 'auto', label: '由正文 AI 判定（推荐）' },
                    { value: 'spar', label: '一律按切磋（不会阵亡）' },
                    { value: 'deadly', label: '一律按生死搏杀（会阵亡）' },
                ],
                battle.combatMode ?? 'auto',
                async (v) => {
                    battle.combatMode = v;
                    await app.persistSettings({ silent: true });
                    helpers.rerender();
                },
            ),
            '默认让**正文 AI 判定** —— 它读过剧情，最清楚这是切磋还是生死搏杀。' +
                '切磋模式下倒下的人算**力竭**，不会阵亡；生死搏杀才会写出阵亡。\n' +
                '想让所有战斗都安全就选「一律按切磋」，想看真正的厮杀就选「一律按生死搏杀」。',
        ),
        checkbox('AI 行动后自动接着打（推荐开）', battle.autoDrive !== false, async (v) => {
            battle.autoDrive = v;
            await app.persistSettings({ silent: true });
        }, {
            hint:
                '开着时：AI 单位（敌方 + 队友）行动完会**自动接着下一个**，一路跑到轮到你为止 —— ' +
                '不用每打一手点一下。轮到你操控的角色时会自动停下，那一手永远由你决定。\n' +
                '关掉则每打完一手都要你点一次「继续」。',
        }),
        field(
            '骰子转速（换面间隔 · 毫秒）',
            textInput({
                value: String(battle.diceCycleMs ?? 150),
                type: 'number',
                min: '40',
                max: '600',
                step: '10',
                onInput: (v) => {
                    battle.diceCycleMs = Math.max(40, Math.min(600, Number(v) || 150));
                },
            }),
            '数字越大转得越慢。默认 **150**（约每秒 6.7 张）—— 能看清数字在跳。\n' +
                '嫌快就调到 250~300；想更利落就调到 80~100。改完下一次掷骰生效。',
        ),
        checkbox('显示 d20 掷骰动画', battle.showDice !== false, async (v) => {
            battle.showDice = v;
            await app.persistSettings({ silent: true });
            helpers.rerender();
        }, { hint: '用 assets/d20 里的 20 张成品骰面图（黑曜石 + 金纹），转到目标数字时交叉淡入定格。' }),
    );

    if (battle.decideMode !== 'off') {
        body.appendChild(
            field(
                '决策走哪条通道',
                select(
                    [
                        { value: 'p2', label: '战斗模型（结构化与决策）' },
                    ],
                    battle.decideChannel,
                    async (v) => {
                        battle.decideChannel = v;
                        await app.persistSettings({ silent: true });
                    },
                ),
                '决策的输入很短（一份战况简报），用便宜快的模型就够。',
            ),
        );
        body.appendChild(
            checkbox('敌方回合也让 AI 思考（推荐开）', battle.decideForEnemies !== false, async (v) => {
                battle.decideForEnemies = v;
                await app.persistSettings({ silent: true });
            }, {
                hint:
                    '开着才是「AI 当对手跟你打」—— 它会自己挑技能、选目标、写动作描述。' +
                    '关掉的话敌方只会用引擎的启发式规则随机挑个目标，等于你自己跟自己打。' +
                    '只有在嫌慢或想省 token 时才建议关。',
            }),
        );
        body.appendChild(
            checkbox('多人战合并成一次思考（推荐开）', battle.batchDecisions !== false, async (v) => {
                battle.batchDecisions = v;
                await app.persistSettings({ silent: true });
            }, {
                hint:
                    '把**同一侧所有单位**这一轮的行动合并成**一次**调用。' +
                    '5 个敌人原本要 5 次，合并后只要 1 次；而且模型能看到同伴的技能，' +
                    '可以安排配合（先控住谁、再集火谁）—— 逐单位分别决策做不到这一点。' +
                    '战斗页会出现「🧠 一次想好这一侧 N 个单位的行动」按钮。',
            }),
        );
        body.appendChild(
            checkbox('队友交给 AI 操作（推荐开）', battle.aiControlsAllies !== false, async (v) => {
                battle.aiControlsAllies = v;
                await app.persistSettings({ silent: true });
            }, {
                hint:
                    '你自己操控的角色**永远由你操作**（AI 不替你决定）。' +
                    '这个开关管的是**其余我方成员**：开着就交给 AI（战斗页有「一次想好我方 N 个单位的行动」按钮），' +
                    '关掉则每个队友都要你亲自点。\n' +
                    '哪个角色是你，在战斗页顶部的「🎮 你操控」里指定，会自动记住。',
            }),
        );
    }

    if (battle.showDice !== false) {
        body.appendChild(
            el('div', { class: 'td-form-inline' }, [
                field('动画最短时长（毫秒）', textInput({
                    value: String(battle.diceMinDuration ?? 900),
                    type: 'number',
                    min: '0',
                    max: '5000',
                    step: '100',
                    onInput: (v) => {
                        battle.diceMinDuration = Number(v);
                    },
                }), '太快看不见就没仪式感了。API 更快时也会转够这么久。'),
                field('动画最长时长（毫秒）', textInput({
                    value: String(battle.diceMaxDuration ?? 15000),
                    type: 'number',
                    min: '1000',
                    max: '60000',
                    step: '1000',
                    onInput: (v) => {
                        battle.diceMaxDuration = Number(v);
                    },
                }), 'API 超过这个时间就强行停下显示结果，避免无尽地转。'),
            ]),
        );
    }

    // ---- 连通性测试：真的发一次请求 ----
    const result = el('div', { class: 'td-probe-result' });
    body.appendChild(
        el('div', { class: 'td-row td-gap td-wrap' }, [
            button(
                '🔌 测试正文模型',
                async () => {
                    clear(result);
                    result.appendChild(el('div', { class: 'notes' }, '正在测试…'));
                    const outcome = await app.probeNarrativeChannel();
                    clear(result);
                    result.appendChild(
                        el('div', { class: outcome.ok ? 'td-test-ok' : 'td-test-bad' }, [
                            el('b', {}, outcome.ok ? `✅ 通过（${outcome.ms} ms）` : '❌ 失败'),
                            el('div', { class: 'notes' }, outcome.detail),
                        ]),
                    );
                },
                { variant: 'primary' },
            ),
            button('💾 保存', async () => {
                await app.persistSettings({ silent: true });
                toast('已保存', 'success');
            }),
        ]),
    );
    body.appendChild(result);

    body.appendChild(
        el('div', { class: 'notes' }, [
            '测试会真的发一次很短的请求（问一句「回一个词」），用来确认通道确实通。',
            '失败时上面会显示**具体原因**，而不是笼统的「未知错误」。',
        ].join('')),
    );

    return drawer('⚔ 战斗用哪两个模型', body, { open: false, id: 'td-battle-drawer' });
}

/**
 * 渲染设置视图。
 * @param {import('../app.js').AppController} app
 * @param {{rerender: () => void}} helpers
 * @returns {HTMLElement}
 */
export function renderSettings(app, helpers) {
    const root = el('div', { class: 'td-view td-view-settings' });
    const settings = app.settings;
    const probe = LlmClient.probe(app.ctx);

    root.appendChild(renderWindowSize(app, helpers));
    root.appendChild(renderBallSize(app, helpers));
    root.appendChild(renderStatusPanel(app, probe, helpers));
    root.appendChild(renderBattleChannelDrawer(app, helpers));
    root.appendChild(renderChannelDrawer(app, 'p2', '🔌 战斗模型', '用于当前场景的结构化提取与战斗行动决策，也可用于正文场景读取。', helpers));
    root.appendChild(renderChannelDrawer(app, 'banter', '💬 口嗨模型', '独立配置口嗨使用的 API 与模型；只影响口嗨，不影响战斗模型。', helpers));
    root.appendChild(renderRulesetDrawer(app, helpers));
    root.appendChild(renderInjectionDrawer(app, helpers));
    root.appendChild(renderAdvancedDrawer(app, helpers));

    void settings;
    return root;
}

export function renderBallSize(app, helpers) {
    const slider = el('input', { type: 'range', min: '40', max: '128', step: '4', value: String(app.settings.ballSize || 64), 'aria-label': '悬浮骰子大小' });
    const label = el('span', {}, `${slider.value}px`);
    const save = async (size) => {
        app.settings.ballSize = size;
        const ok = await app.persistSettings();
        if (ok === false) toast('骰子大小已应用，但保存失败。', 'warning');
    };
    slider.addEventListener('input', () => {
        label.textContent = `${slider.value}px`;
        app.settings.ballSize = Number(slider.value);
        app.notify();
    });
    slider.addEventListener('change', () => { void save(Number(slider.value)); });
    return el('section', { class: 'td-window-size' }, [
        el('h4', {}, '🎲 悬浮骰子大小'),
        el('p', { class: 'notes' }, '仅调整屏幕上可拖动的骰子按钮，不改变主面板。宽度40–128px，保持图片比例。'),
        el('label', {}, ['大小 ', label, slider]),
        button('恢复默认（64px）', async () => { await save(64); helpers.rerender?.(); }),
    ]);
}

export function renderWindowSize(app, helpers) {
    const root = el('section', { class: 'td-window-size' }, [
        el('h4', {}, '🪟 悬浮窗大小'),
        el('p', { class: 'notes' }, '电脑调整宽高（像素）；手机调整占屏比例。超出屏幕时自动限制，不影响战斗。'),
    ]);
    const rect = app.settings.panelRect || {};
    const width = el('input', { type: 'number', class: 'text_pole', min: '420', max: '2400', step: '10', value: String(rect.w || 880), 'aria-label': '悬浮窗宽度' });
    const height = el('input', { type: 'number', class: 'text_pole', min: '320', max: '1800', step: '10', value: String(rect.h || 620), 'aria-label': '悬浮窗高度' });
    const scale = el('input', { type: 'range', min: '60', max: '100', step: '5', value: String(Math.round((app.settings.panelMobileScale || 1) * 100)), 'aria-label': '手机悬浮窗占屏比例' });
    const value = el('span', {}, `${scale.value}%`);
    scale.addEventListener('input', () => { value.textContent = `${scale.value}%`; });
    const save = async (reset = false) => {
        const w = Number(width.value), h = Number(height.value), s = Number(scale.value);
        if (!reset && (!Number.isFinite(w) || !Number.isFinite(h) || !Number.isFinite(s) || w < 420 || w > 2400 || h < 320 || h > 1800 || s < 60 || s > 100)) {
            toast('宽度需420–2400，高度320–1800，手机比例60–100%。', 'warning'); return;
        }
        app.settings.panelRect = reset ? { x: 0, y: 0, w: 880, h: 620 } : { ...app.settings.panelRect, w, h };
        app.settings.panelMobileScale = reset ? 1 : s / 100;
        const ok = await app.persistSettings();
        helpers.rerender?.();
        if (ok === false) toast('大小已应用，但保存失败，本次会话仍可使用。', 'warning');
    };
    root.appendChild(el('div', { class: 'td-window-size-fields' }, [
        el('label', {}, ['宽度 px', width]), el('label', {}, ['高度 px', height]),
        el('label', {}, ['手机占屏比例 ', value, scale]),
    ]));
    root.appendChild(el('div', { class: 'td-actions' }, [button('应用大小', () => save()), button('恢复默认', () => save(true))]));
    return root;
}

function renderStatusPanel(app, probe, helpers) {
    const diag = app.diagnostics();
    /** @type {HTMLElement[]} */
    const rows = [];

    const line = (
        /** @type {string} */ label,
        /** @type {string} */ value,
        /** @type {string} */ hint = '',
        /** @type {boolean|null} */ ok = null,
    ) => {
        rows.push(
            el('div', { class: 'td-status-row' }, [
                el('span', { class: `td-status-dot${ok === null ? '' : ok ? ' td-ok' : ' td-bad'}` }),
                el('span', { class: 'td-status-label' }, label),
                el('span', { class: 'td-status-value' }, value),
                hint ? el('span', { class: 'notes' }, hint) : null,
            ]),
        );
    };

    line(
        '酒馆助手（TavernHelper）',
        probe.tavernHelper ? '可用' : '不可用',
        probe.tavernHelper ? '' : '装 JS-Slash-Runner 后，战斗模型可以直接用自带 URL/Key/Model 与 JSON Schema',
        probe.tavernHelper,
    );
    line(
        '连接配置服务',
        probe.profileService ? '可用' : '不可用',
        probe.profileService ? `共 ${probe.profiles.length} 个配置` : '该酒馆不支持连接配置',
        probe.profileService,
    );
    line('当前角色', diag.characterName || '（未选择）', diag.userName ? `玩家：${diag.userName}` : '');
    line('当前聊天', diag.chatId || '（未开始）', '场景数据与战斗记录都保存在这个聊天里');

    return el('div', { class: 'td-status-panel' }, [
        el('div', { class: 'td-status-head' }, [
            el('b', {}, '🧪 环境自检'),
            button('重新检测', () => helpers.rerender(), { small: true }),
        ]),
        ...rows,
    ]);
}

/**
 * 模型名输入 + 「拉取模型列表」。
 *
 * 为什么要有这个：让用户手打模型名是最容易出错的一步 ——
 * 大小写差一个字母、版本号记错、或者压根不记得服务商提供了哪些模型，
 * 结果就是「测试通道」报一个看不懂的错。
 *
 * @param {import('../app.js').AppController} app
 * @param {object} channel
 * @param {object} probe
 * @param {{rerender: () => void}} helpers
 * @returns {HTMLElement}
 */
function renderModelField(app, channel, probe, helpers) {
    const wrap = el('div', { class: 'td-field td-model-field' });

    const modelInput = /** @type {HTMLInputElement} */ (
        textInput({
            value: channel.model,
            placeholder: '例如 deepseek-chat',
            onInput: (v) => {
                channel.model = v;
            },
        })
    );

    const pickerHolder = el('div', { class: 'td-model-picker' });
    const statusHolder = el('div', { class: 'td-model-status' });

    /**
     * 把拉到的模型渲染成一个快速选择下拉框。
     * @param {string[]} models
     */
    const renderPicker = (models) => {
        clear(pickerHolder);
        if (!models.length) return;
        const picker = select(
            [{ value: '', label: `— 选择模型（共 ${models.length} 个）—` }, ...models.map((m) => ({ value: m, label: m }))],
            models.includes(channel.model) ? channel.model : '',
            async (v) => {
                if (!v) return;
                channel.model = v;
                modelInput.value = v;
                await app.persistSettings({ silent: true });
            },
        );
        pickerHolder.appendChild(picker);
    };

    const fetchButton = button(
        '📋 拉取模型列表',
        async () => {
            clear(statusHolder);
            statusHolder.appendChild(el('div', { class: 'notes' }, '正在拉取…'));

            const client = new LlmClient(app.ctx, channel, '拉取模型');
            const result = await client.listModels();

            clear(statusHolder);
            if (result.ok) {
                renderPicker(result.models);
                statusHolder.appendChild(
                    el('div', { class: 'notes td-ok' }, `✓ 拉到 ${result.models.length} 个模型（来源：${result.source}），可从上面的下拉框选`),
                );
                app.log(`· 已拉取 ${result.models.length} 个模型（${result.source}）`);
            } else {
                clear(pickerHolder);
                statusHolder.appendChild(
                    el('div', { class: 'td-warn-box' }, [
                        el('b', {}, '✗ 拉取失败，请手动填写模型名'),
                        el('div', { class: 'notes' }, result.error ?? '未知原因'),
                        el('div', { class: 'notes' }, [
                            '常见原因：',
                            '① 该端点没有实现 /models 接口；',
                            '② 浏览器跨域限制（CORS）—— 这种情况改用「连接配置」模式，或直接手填模型名；',
                            '③ API 地址填得不对（注意地址要指到版本号那一层，例如 https://api.x.com/v1）。',
                        ].join('')),
                    ]),
                );
            }
            void helpers;
        },
        { small: true, title: '从服务商拉取可用模型列表，避免模型名打错' },
    );

    // 已经能从连接配置里知道模型的，就不必再拉
    if (channel.mode === 'profile' && probe.profiles?.length) {
        const current = probe.profiles.find((p) => p.id === channel.profileId);
        if (current?.model) {
            modelInput.value = current.model;
            channel.model = current.model;
        }
        wrap.appendChild(
            el('label', { class: 'td-field-label' }, '模型（由所选连接配置决定）'),
        );
        wrap.appendChild(modelInput);
        wrap.appendChild(el('div', { class: 'notes' }, `当前连接配置的模型：${current?.model || '（未指定）'}。留空即使用该配置自带的模型。`));
        return wrap;
    }

    wrap.appendChild(el('div', { class: 'td-row td-between td-model-head' }, [
        el('label', { class: 'td-field-label' }, '模型名'),
        fetchButton,
    ]));
    wrap.appendChild(modelInput);
    wrap.appendChild(pickerHolder);
    wrap.appendChild(statusHolder);
    wrap.appendChild(
        el('small', { class: 'notes' }, '不确定模型名就点「拉取模型列表」。拉不到也不要紧，手动填对即可（大小写敏感、不要带多余空格）。'),
    );

    return wrap;
}

/** 口嗨上下文与目标角色人设设置；刷新列表不读写世界书内容。 */
function renderBanterFields(app) {
    const banter = app.settings.banter;
    const body = el('div', { class: 'td-form' });
    const save = () => app.persistSettings({ silent: true });
    const normalizeCount = (value) => {
        const number = value === '' || value == null ? 12 : Number(value);
        return Math.max(1, Math.min(60, Math.trunc(Number.isFinite(number) ? number : 12)));
    };
    const contextInput = textInput({
        value: String(normalizeCount(banter.contextMessages)),
        type: 'number',
        min: '1',
        max: '60',
        step: '1',
        onInput: (v) => {
            banter.contextMessages = normalizeCount(v);
        },
    });
    contextInput.addEventListener('change', async () => {
        banter.contextMessages = normalizeCount(contextInput.value);
        contextInput.value = String(banter.contextMessages);
        await save();
    });
    body.appendChild(field('读取最近上下文楼层数', contextInput, '范围 1～60，默认 12 层；用于口嗨时理解最近剧情。'));

    const bookHolder = el('div');
    const status = el('div', { class: 'notes', 'aria-live': 'polite' });
    const renderBooks = (names) => {
        const books = [...new Set(names.filter((name) => typeof name === 'string' && name))];
        const selected = banter.worldbookName || '';
        const options = [{ value: '', label: '不选择（不读写世界书）' }];
        if (selected && !books.includes(selected)) {
            options.push({ value: selected, label: `${selected}（已保存，当前列表未找到）` });
        }
        options.push(...books.map((name) => ({ value: name, label: name })));
        clear(bookHolder);
        bookHolder.appendChild(select(options, selected, async (v) => {
            banter.worldbookName = v;
            await save();
        }));
    };
    let loading = false;
    const refreshBooks = async () => {
        if (loading) return;
        loading = true;
        status.textContent = '正在刷新世界书列表…';
        try {
            const names = await listPersonaBooks(app.ctx);
            if (!Array.isArray(names)) throw new Error('世界书列表格式异常');
            renderBooks(names);
            status.textContent = names.length ? `已获取 ${names.length} 本世界书` : '暂无可用世界书，可创建后刷新列表。';
        } catch (error) {
            status.textContent = `刷新失败：${describeError(error)}；已保留当前选择，可稍后重试。`;
        } finally {
            loading = false;
        }
    };
    renderBooks([]);
    body.appendChild(field('人设世界书', bookHolder, '只有选择世界书后才会读写人设；选择“不选择”即可停止世界书读写。'));
    body.appendChild(el('div', { class: 'td-row td-gap' }, [
        button('刷新世界书列表', refreshBooks, { small: true }),
        status,
    ]));
    body.appendChild(checkbox('读取目标角色人设', banter.readWorldbook !== false, async (v) => {
        banter.readWorldbook = v;
        await save();
    }, { hint: '只读取所选世界书中目标角色的人设，不重新建立全局人物表。' }));
    body.appendChild(checkbox('缺少人设时补写', banter.createMissingPersona !== false, async (v) => {
        banter.createMissingPersona = v;
        await save();
    }, { hint: '默认开启。口嗨时若目标角色缺少人设，会直接补写到所选世界书，无需再次确认；未选世界书时不会写入。' }));
    void refreshBooks();
    return body;
}

/**
 * 一条 API 通道的设置抽屉。
 * @param {import('../app.js').AppController} app
 * @param {'p2'|'banter'} which
 * @param {string} title
 * @param {string} description
 * @param {{rerender: () => void}} helpers
 */
function renderChannelDrawer(app, which, title, description, helpers) {
    const settings = app.settings;
    const channel = settings[which].channel;
    const probe = LlmClient.probe(app.ctx);

    /** 保存并重画（模式切换会改变可见字段）。 */
    const touch = async (/** @type {boolean} */ rerender = false) => {
        await app.persistSettings({ silent: true });
        if (rerender) helpers.rerender();
    };

    const body = el('div', { class: 'td-channel' }, [
        el('p', { class: 'notes' }, description),
    ]);

    body.appendChild(
        field(
            '通道模式',
            select(channelModeOptions(app, channel), channel.mode, async (v) => {
                channel.mode = v;
                await touch(true);
            }),
            channel.mode === 'profile'
                ? '复用你在「连接配置」里保存的配置。API Key 存在酒馆的 secrets 里，扩展读不到明文，只能这样用 —— 这也是它最省事的原因。'
                : channel.mode === 'tavern-helper'
                  ? '「酒馆助手」是扩展 **JS-Slash-Runner**（作者 KAKAA）在酒馆界面上显示的名字。装了它才能用这条通道；本插件调用它的 generateRaw 来发请求，可以带自定义 URL/Key/Model 与 JSON Schema 强约束。'
                  : channel.mode === 'custom'
                    ? '直接 fetch 目标端点，不依赖任何其它扩展。填 Base URL 或完整 /chat/completions 地址都可以。注意浏览器跨域限制可能拦住请求。'
                    : '沿用当前聊天主连接。最省事，但会被当前预设与上下文影响，输出格式可能不稳定。',
        ),
    );

    // 连接配置选择
    if (channel.mode === 'profile') {
        if (probe.profiles.length) {
            body.appendChild(
                field(
                    '连接配置',
                    select(
                        probe.profiles.map((p) => ({
                            value: p.id,
                            label: p.name,
                            title: `${p.api} ｜ ${p.apiUrl} ｜ ${p.model}`,
                        })),
                        channel.profileId,
                        async (v) => {
                            channel.profileId = v;
                            await touch();
                        },
                    ),
                ),
            );
        } else {
            body.appendChild(
                el('div', { class: 'td-warn-box' }, [
                    el('b', {}, '没有可用的连接配置'),
                    el('div', { class: 'notes' }, '先在酒馆的「连接配置」里新建一个，或改用「直连」模式。'),
                ]),
            );
        }
    }

    // 直连参数
    if (channel.mode === 'custom' || (channel.mode === 'tavern-helper' && !probe.tavernHelper)) {
        const urlInput = textInput({
            value: channel.apiUrl,
            placeholder: 'https://api.example.com/v1',
            onInput: (v) => {
                channel.apiUrl = v;
                refreshEndpointHint(v);
            },
        });
        const endpointHint = el('div', { class: 'td-endpoint-hint' });

        /** 按当前地址刷新「这是谁的端点」提示。 */
        const refreshEndpointHint = (/** @type {string} */ url) => {
            clear(endpointHint);
            const info = describeEndpoint(url);
            if (!info.host) return;

            if (info.isLocal) {
                endpointHint.appendChild(el('div', { class: 'notes td-ok' }, `✓ 本地端点（${info.host}）`));
                return;
            }
            if (info.known) {
                endpointHint.appendChild(el('div', { class: 'notes td-ok' }, `✓ 已识别的服务商（${info.host}）`));
                return;
            }
        };
        refreshEndpointHint(channel.apiUrl);

        body.appendChild(
            el('div', { class: 'td-form' }, [
                field('API 地址', urlInput, '填 Base URL 或完整的 /chat/completions 地址都行。'),
                endpointHint,
                field('API Key', textInput({
                    value: channel.apiKey,
                    type: 'password',
                    placeholder: 'sk-...',
                    onInput: (v) => {
                        channel.apiKey = v;
                    },
                }), '仅保存在本地 settings.json，不会上传。'),
            ]),
        );
    }

    // 模型名 + 拉取模型列表
    body.appendChild(renderModelField(app, channel, probe, helpers));

    if (which === 'banter') body.appendChild(renderBanterFields(app));

    // 采样参数
    body.appendChild(
        el('div', { class: 'td-form td-form-inline' }, [
            field('温度', textInput({
                value: String(channel.temperature ?? 0.2),
                type: 'number',
                min: '0',
                max: '2',
                step: '0.1',
                onInput: (v) => {
                    channel.temperature = Number(v);
                },
            }), which === 'banter' ? '温度越高，对白变化越多；请按角色表现需要调整。' : '结构化与决策建议 0~0.2，减少随机发挥。'),
            field('最大输出 token', textInput({
                value: String(channel.maxTokens ?? 8192),
                type: 'number',
                min: '0',
                onInput: (v) => {
                    channel.maxTokens = Number(v);
                },
            }), '填 0 表示按输入长度自动推导。'),
            field('超时（秒）', textInput({
                value: String(channel.timeout ?? 120),
                type: 'number',
                min: '10',
                onInput: (v) => {
                    channel.timeout = Number(v);
                },
            })),
            field('重试次数', textInput({
                value: String(channel.retries ?? 2),
                type: 'number',
                min: '0',
                max: '5',
                onInput: (v) => {
                    channel.retries = Number(v);
                },
            })),
        ]),
    );

    body.appendChild(
        checkbox('强制 JSON Schema 输出', channel.useJsonSchema !== false, async (v) => {
            channel.useJsonSchema = v;
            await touch();
        }, {
            hint: '开启后模型必须按我们的结构输出，解析成功率显著提高。部分第三方端点不支持该参数，报错时请关掉。',
        }),
    );

    body.appendChild(
        el('div', { class: 'td-row td-gap' }, [
            button('💾 保存设置', async () => {
                await touch();
                toast('设置已保存', 'success');
            }, { variant: 'primary' }),
            button('🔌 测试这条通道', () => testChannel(app, which, helpers)),
        ]),
    );

    // 测试结果区
    body.appendChild(el('div', { class: 'td-test-result', id: `td-test-${which}` }));

    return drawer(title, body, { open: true, id: `td-channel-${which}` });
}

/** 测试一条通道是否可用。 */
async function testChannel(app, which, helpers) {
    const holder = document.getElementById(`td-test-${which}`);
    if (!holder) return;
    clear(holder);
    holder.appendChild(el('div', { class: 'notes' }, '正在测试…'));

    const channel = app.settings[which].channel;
    const client = new LlmClient(app.ctx, channel, which === 'banter' ? '测试口嗨模型' : '测试战斗模型');
    const started = Date.now();

    const result = await client.ask(
        '你是一个测试助手。只输出 JSON，不要任何解释。',
        '请输出这个 JSON：{"ok": true, "message": "通道正常"}',
        { maxTokens: 200, expectedOutputRatio: 0.2 },
    );

    clear(holder);
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    if (result.ok) {
        holder.appendChild(
            el('div', { class: 'td-test-ok' }, [
                el('b', {}, `✅ 通道正常（${elapsed}s，输入约 ${result.meta.inputTokens} tokens）`),
                el('pre', { class: 'td-pre' }, result.text.slice(0, 500)),
            ]),
        );
    } else {
        holder.appendChild(
            el('div', { class: 'td-test-bad' }, [
                el('b', {}, `❌ 测试失败（${elapsed}s）`),
                el('div', {}, result.error ?? '未知错误'),
                el('div', { class: 'notes' }, [
                    '排查建议：',
                    '① 模式选「酒馆助手」但没装 JS-Slash-Runner → 改用「直连」并填 URL/Key/Model；',
                    '② 用「直连」报 CORS 或网络错误 → 换「连接配置」模式；',
                    '③ 返回空内容 → 关掉「强制 JSON Schema」再试；',
                    '④ 超时 → 把超时调大，或换更快的模型。',
                ].join('')),
            ]),
        );
    }
    void helpers;
}

/** 规则集抽屉。 */
function renderRulesetDrawer(app, helpers) {
    const settings = app.settings;
    const ruleset = app.ruleset;
    const body = el('div', { class: 'td-ruleset' });

    body.appendChild(
        el('p', { class: 'notes' }, [
            '掷骰怎么算，由这套公式决定。默认使用当前场景规则；没有场景规则时使用内置的通用 d20。',
            '公式是**数据**，不是代码：改完立刻生效，不需要改插件。',
        ].join('')),
    );

    body.appendChild(
        el('div', { class: 'td-stats' }, [
            stat('当前规则集', ruleset.name),
            stat('命中模式', ruleset.hitMode === 'chance' ? '概率判定' : '掷骰对抗'),
            stat('威力口径', POWER_MODE_LABEL[ruleset.powerMode] ?? ruleset.powerMode),
        ]),
    );

    if (app.powerSystem?.meta?.powerModeReason) {
        body.appendChild(
            el('div', { class: 'notes' }, `口径判定依据：${app.powerSystem.meta.powerModeReason}`),
        );
    }

    /** 编辑中的规则集（用户覆盖）。 */
    const draft = { ...(settings.rulesetOverride ?? ruleset) };

    /** 公式输入项。 */
    const formulaField = (/** @type {string} */ key, /** @type {string} */ label, /** @type {string} */ hint) =>
        field(
            label,
            textInput({
                value: String(draft[key] ?? ''),
                onInput: (v) => {
                    draft[key] = v;
                },
            }),
            hint,
        );

    body.appendChild(
        el('div', { class: 'td-form' }, [
            field('规则集名称', textInput({
                value: String(draft.name ?? ''),
                onInput: (v) => {
                    draft.name = v;
                },
            })),
            field(
                '命中模式',
                select(
                    [
                        { value: 'dice', label: '掷骰对抗（掷出值 ≥ 目标值即命中）' },
                        { value: 'chance', label: '概率判定（命中率公式返回 0~1）' },
                    ],
                    String(draft.hitMode ?? 'dice'),
                    (v) => {
                        draft.hitMode = v;
                        helpers.rerender();
                    },
                ),
            ),
            field(
                '威力口径',
                select(
                    Object.entries(POWER_MODE_LABEL).map(([value, label]) => ({ value, label })),
                    String(draft.powerMode ?? 'absolute'),
                    (v) => {
                        draft.powerMode = v;
                    },
                ),
                '技能里的 power 是绝对值、还是某项属性的百分比。选错了伤害会差一个数量级。',
            ),
        ]),
    );

    body.appendChild(el('div', { class: 'td-mini-label' }, '公式'));
    body.appendChild(
        el('div', { class: 'td-form' }, [
            formulaField('initiativeFormula', '先攻', '例：d20 + Speed'),
            draft.hitMode === 'chance'
                ? formulaField('hitChanceFormula', '命中率', '例：Aim / (Speed + Aim)（返回 0~1）')
                : formulaField('hitFormula', '命中值', '例：d20 + (Aim - 100) / 10'),
            draft.hitMode === 'chance' ? null : formulaField('hitTargetFormula', '命中目标值', '例：Evasion'),
            formulaField('damageFormula', '伤害', '例：(power + d6) - Armor'),
            formulaField('healFormula', '治疗加成', '在威力之外额外加算的部分，例：0'),
            formulaField('shieldFormula', '护盾加成', '例：0'),
            formulaField('critFormula', '暴击条件', '返回非 0 即暴击，例：nat == 20'),
            formulaField('fumbleFormula', '大失败条件', '返回非 0 即大失败，例：nat == 1'),
            field('暴击倍率', textInput({
                value: String(draft.critMultiplier ?? 2),
                type: 'number',
                min: '1',
                step: '0.5',
                onInput: (v) => {
                    draft.critMultiplier = Number(v);
                },
            }), '伤害公式里用 critMult 引用它。'),
            field('最低伤害', textInput({
                value: String(draft.minDamage ?? 1),
                type: 'number',
                min: '0',
                onInput: (v) => {
                    draft.minDamage = Number(v);
                },
            })),
            field('大失败自伤比例', textInput({
                value: String(draft.fumbleSelfHarmRatio ?? 0.1),
                type: 'number',
                min: '0',
                max: '1',
                step: '0.05',
                onInput: (v) => {
                    draft.fumbleSelfHarmRatio = Number(v);
                },
            }), '占最大生命值的比例。填 0 关闭反噬。'),
            field('群攻衰减', select(
                [
                    { value: 'sqrt', label: '按目标数开方衰减（推荐）' },
                    { value: 'linear', label: '按目标数线性衰减' },
                    { value: 'none', label: '不衰减' },
                ],
                String(draft.aoeFalloff ?? 'sqrt'),
                (v) => {
                    draft.aoeFalloff = v;
                },
            )),
        ]),
    );

    body.appendChild(
        el('div', { class: 'td-help' }, [
            el('b', {}, '可用变量：'),
            el('code', {}, FORMULA_VARIABLES.join(' ')),
            el('b', {}, '可用函数：'),
            el('code', {}, FORMULA_FUNCTIONS.join(' ')),
            el('div', { class: 'notes' }, '骰子直接写 d20、2d6、1d100。变量名不区分业务含义，引擎会在结算时自动填入攻守双方的对应数值。'),
        ]),
    );

    body.appendChild(
        el('div', { class: 'td-row td-gap' }, [
            button('💾 保存并生效', async () => {
                settings.rulesetOverride = { ...draft, id: draft.id ?? `user-${Date.now()}`, source: 'user' };
                clearFormulaCache();
                await app.persistSettings({ silent: true });
                helpers.rerender();
                toast('规则集已更新', 'success');
            }, { variant: 'primary' }),
            button('↩ 恢复自动（用场景规则/预设）', async () => {
                settings.rulesetOverride = null;
                clearFormulaCache();
                await app.persistSettings({ silent: true });
                helpers.rerender();
                toast('已恢复自动规则集', 'info');
            }),
            button('🧪 试算一次', () => {
                const preview = el('div', { class: 'td-pre' });
                try {
                    const rs = normalizeRuleset({ ...draft, source: 'user' });
                    const rng = new Rng('preview');
                    const ev = new RulesetEvaluator(rs, rng);
                    const scope = {
                        Aim: 100,
                        Hit: 100,
                        Accuracy: 100,
                        Atk: 30,
                        atk: 30,
                        Speed: 20,
                        Spd: 20,
                        Armor: 5,
                        Def: 5,
                        Evasion: 10,
                        power: 20,
                        cost: 0,
                        nat: 10,
                        crit: 0,
                        critMult: 1,
                        CritMultiplier: 1,
                        targets: 1,
                        multiplier: 1,
                        round: 1,
                        hitBonus: 0,
                        HP: 100,
                        MaxHP: 100,
                        MP: 0,
                        MaxMP: 0,
                        targetArmor: 5,
                        targetSpeed: 15,
                        targetHP: 100,
                        targetMaxHP: 100,
                        targetHPPercent: 1,
                    };
                    const lines = [
                        `样本：攻击方 Atk 30 / Speed 20，防守方 Armor 5 / Evasion 10 / Speed 15，技能 Aim 100 / power 20`,
                        ``,
                        `先攻　${rs.initiativeFormula} = ${Math.round(ev.eval(rs.initiativeFormula, scope))}`,
                        rs.hitMode === 'chance'
                            ? `命中　${rs.hitChanceFormula} = ${(ev.hitChance(scope) * 100).toFixed(1)}%`
                            : `命中　${rs.hitFormula} = ${Math.round(ev.hitValue(scope))}　目标 ${rs.hitTargetFormula} = ${Math.round(ev.hitTarget(scope))}`,
                        `伤害　${rs.damageFormula} = ${Math.round(ev.damage(scope))}`,
                        `暴击　${rs.critFormula} → nat=20 时${ev.isCrit({ ...scope, nat: 20 }) ? '成立' : '不成立'}`,
                        `大失败　${rs.fumbleFormula} → nat=1 时${ev.isFumble({ ...scope, nat: 1 }) ? '成立' : '不成立'}`,
                    ];
                    preview.textContent = lines.join('\n');
                } catch (e) {
                    preview.textContent = `试算失败：${describeError(e)}`;
                }
                const old = body.querySelector('.td-pre');
                if (old) old.remove();
                body.appendChild(preview);
            }),
        ]),
    );

    return drawer('🎯 掷骰规则', body, { open: false, id: 'td-ruleset-drawer' });
}

/**
 * 「战斗怎么进正文」抽屉。
 *
 * ⚠️ 这里以前叫「正文注入」，做的是**每回合往聊天里塞一条 `is_system` 系统消息**。
 * 那个做法被砍掉了 —— 每打一回合就多一个楼层，一晚上下来聊天记录全是战斗旁白，
 * 把剧情淹了；而且那些旁注**不触发 AI**，纯粹占位。
 *
 * 现在的做法：**战斗全程不碰聊天**，打完之后合成一条，由用户点发送。
 * 所以这个抽屉只剩「上限」这一个参数，外加一个预览。
 */
function renderInjectionDrawer(app, helpers) {
    const settings = app.settings;
    const body = el('div', { class: 'td-form' }, [
        el('div', { class: 'td-test-ok' }, [
            el('b', {}, '✅ 战斗不会占用聊天楼层'),
            el('div', { class: 'notes' }, [
                '战斗过程**只记录在插件里**（战斗页 + 日志页），聊天一个字都不动。',
                '打完之后，战斗页会出现结算面板：把整场战斗合成**一条**消息，',
                '你确认（或修改）后点「📤 发送给正文模型续写」，正文模型才会接着写。',
            ].join('')),
        ]),
        el('p', { class: 'notes' }, [
            '这样做的好处：① 不会每回合刷一个楼层；② 你能控制「什么时候继续剧情」；',
            '③ 发出去的那条可以自己改文字；④ 不想让 AI 知道战斗细节时，直接不点发送即可。',
        ].join('')),
        field('结算文本上限（字符）', textInput({
            value: String(settings.injection.maxChars ?? 4000),
            type: 'number',
            min: '200',
            step: '200',
            onInput: (v) => {
                settings.injection.maxChars = Number(v);
            },
        }), '战斗结算里节选的关键过程不会超过这个长度，避免一条消息太长。'),
        el('div', { class: 'td-row td-gap' }, [
            button('👁 预览战斗结算长什么样', () => {
                const preview = el('pre', { class: 'td-pre' }, app.battleResultText() || '（还没有战斗结果）');
                openPreview('战斗结算预览', preview);
            }),
        ]),
    ]);
    void helpers;
    return drawer('📤 战斗怎么进正文', body, { open: false, id: 'td-injection-drawer' });
}

/** 高级抽屉：导入导出、数据管理。 */
function renderAdvancedDrawer(app, helpers) {
    const body = el('div', { class: 'td-form' }, [
        el('div', { class: 'td-stats' }, [
            stat('本聊天数据条目', (app.data.auditLog ?? []).length),
            stat('当前场景单位', app.powerSystem?.combatants?.length ?? 0),
            stat('数据版本', String(app.data.dataVersion ?? 1)),
        ]),
        el('div', { class: 'td-row td-gap td-wrap' }, [
            button('⬇ 导出数据 (JSON，不含 API 密钥)', async () => {
                const payload = JSON.stringify(exportAll(app.ctx), null, 2);
                try {
                    await navigator.clipboard.writeText(payload);
                    toast('已复制到剪贴板', 'success');
                } catch {
                    openPreview('导出数据（手动复制）', el('pre', { class: 'td-pre' }, payload));
                }
            }),
            button('⬆ 导入数据 (JSON)', () => {
                const textarea = /** @type {HTMLTextAreaElement} */ (
                    el('textarea', { class: 'text_pole', rows: '10', placeholder: '把之前导出的 JSON 粘贴到这里' })
                );
                openPreview(
                    '导入数据',
                    el('div', {}, [
                        el('div', { class: 'notes' }, '导入已保存的场景与战斗数据，不会覆盖你的 API 通道与密钥配置。'),
                        textarea,
                        el('div', { class: 'td-row td-gap' }, [
                            button('确认导入', async () => {
                                try {
                                    const payload = JSON.parse(textarea.value);
                                    const result = await importAll(app.ctx, payload, { includeSettings: false });
                                    if (result.ok) {
                                        toast(`已导入：${result.imported.join('、') || '无'}`, 'success');
                                        helpers.rerender();
                                    } else {
                                        toast(`导入失败：${result.error}`, 'error');
                                    }
                                } catch (e) {
                                    toast(`JSON 解析失败：${describeError(e)}`, 'error');
                                }
                            }, { variant: 'primary' }),
                        ]),
                    ]),
                );
            }),
            button('🗑 清空本聊天数据', async () => {
                if (!(await confirmDialog('清空本聊天的场景数据、战斗记录与审计日志？'))) return;
                await app.reset();
                helpers.rerender();
            }, { variant: 'danger' }),
        ]),
        el('hr', { class: 'td-hr' }),
        el('div', { class: 'td-help' }, [
            el('b', {}, '数据存在哪里'),
            el('ul', {}, [
                el('li', {}, '设置（战斗模型、规则、结果发送）→ 酒馆的 settings.json，跟人走、跨聊天共享。'),
                el('li', {}, '场景数据、战斗进度、审计日志 → 当前聊天的 metadata，**跟聊天走**。'),
                el('li', {}, '换一张卡或新开一个聊天，会使用各自的场景与战斗存档。'),
            ]),
        ]),
        el('div', { class: 'td-help' }, [
            el('b', {}, '关于「不污染正文」'),
            el('div', { class: 'notes' }, '插件只写聊天 metadata（战斗进度、审计日志），**从不修改任何消息内容**。战斗过程也不会占用聊天楼层 —— 打完后由你决定要不要把结算发出去。'),
        ]),
    ]);
    return drawer('🧰 高级与数据管理', body, { open: false, id: 'td-advanced-drawer' });
}

/** 打开一个只读预览弹窗。 */
function openPreview(/** @type {string} */ title, /** @type {HTMLElement} */ content) {
    openModal({ title, body: content, hideConfirm: true, wide: true });
}

export { GENERIC_D20, sniffPowerMode };
