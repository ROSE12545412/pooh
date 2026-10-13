/**
 * tavern-dice / src/ui/battle.js
 * ---------------------------------------------------------------------------
 * 战斗视图：先攻序、单位面板、技能选择、目标选择、战斗日志。
 *
 * 交互流程刻意做成「两步式」：
 *   点技能 → 高亮可选目标 → 点目标 → 结算
 * 因为回合制里最常见的误操作就是「选错目标」，多一步确认比事后撤销便宜。
 */

import { renderPortrait } from './portrait.js';
import { renderPrebattle } from './prebattle.js';
import { loadoutSceneNote } from '../core/loadout.js';
import { OUTCOME } from '../combat/engine.js';
import { canUseSkill } from '../combat/engine.js';
import { hitPenaltyPreview, skillEffectLabels, skillMechanicsText } from '../combat/preview.js';
import { SIDE, SLOT_LABEL, TARGET_LABEL, formatEquipmentBonuses, toNumber } from '../core/schema.js';
import { buildSceneRequest } from '../llm/scene-prompt.js';
import { buildCheckPanel } from './frame.js';
import { renderCheckResult, renderTurnChecks } from './check-result.js';
import { createDiceRoller, hasFaceAssets, preloadFaces } from './dice.js';
import { button, checkbox, clear, confirmDialog, el, formatAgo, formatTime, on, select, stat, textInput, toast } from './dom.js';

/** 阵营显示名。 */
const SIDE_LABEL = { [SIDE.ALLY]: '我方', [SIDE.ENEMY]: '敌方', [SIDE.NEUTRAL]: '中立' };

/**
 * 渲染战斗视图。
 * @param {import('../app.js').AppController} app
 * @param {{rerender: () => void, setTab: (tab: string) => void}} helpers
 * @returns {HTMLElement}
 */
export function renderBattle(app, helpers) {
    const root = el('div', { class: 'td-view td-view-battle' });
    const battle = app.battle;

    if (!battle) {
        // 战斗结束后：先显示「结算已就绪」面板，让用户决定什么时候发出去
        if (app.battleResultSnapshot) root.appendChild(renderResultPanel(app, helpers));
        root.appendChild(renderBattleIdle(app, helpers));
        return root;
    }

    root.appendChild(renderBattleHeader(app, battle, helpers));
    root.appendChild(renderInitiativeStrip(battle));
    root.appendChild(renderUserPicker(app, battle, helpers));
    root.appendChild(renderBanter(app, battle, helpers));
    root.appendChild(renderUnitPanels(app, battle, helpers));

    // 骰子与技能共用一个操作区，选招时无需上下寻找。
    root.appendChild(el('div', { class: 'td-combat-console' }, [
        renderDiceStage(app, battle),
        renderActionBar(app, battle, helpers),
    ]));

    // 判定结束后立刻给出结算预览 —— 战斗只要还在，就还没回写战力数据，
    // 让用户能先看清楚结果再决定结束
    if (battle.phase === 'finished') root.appendChild(renderResultPanel(app, helpers, battle));

    root.appendChild(renderBattleLog(battle));

    // ---- 自动衔接的触发点 ----
    //
    // ⚠️ 只在「你打完一手」后触发是不够的：如果轮到的是**队友**（我方但不是你操控的），
    // 就不会有人接着推进，界面卡在那里等玩家点（用户报的「友方敌方仍然需要我点击」）。
    // 所以每次渲染战斗页时都检查一次 —— 只要当前不是你的回合，就自动接着打。
    //
    // 用渲染时机而不是定时器：这样「重画界面」本身就是推进的驱动力，
    // 不会因为标签页切换 / 面板重开而丢失推进。
    if (battle.phase !== 'finished' && !app.busy && !app._autoDriving) {
        const current = battle.currentUnit;
        if (current && !app.isUserUnit(current)) {
            // 放到下一帧，避免在渲染过程中改状态导致递归渲染
            setTimeout(() => {
                if (app._autoDriving || app.busy) return;
                if (!app.battle || app.battle.phase === 'finished') return;
                const u = app.battle.currentUnit;
                if (!u || app.isUserUnit(u)) return;
                app._maybeContinueAutoDrive();
            }, 0);
        }
    }

    return root;
}

/** 掷骰结果对应的展示样式。 */
const OUTCOME_STYLE = {
    crit: { cls: 'td-out-crit', label: '大成功', color: '#ffd76e' },
    hit: { cls: 'td-out-hit', label: '命中', color: '#8fe388' },
    miss: { cls: 'td-out-miss', label: '未命中', color: '#9aa3b2' },
    fumble: { cls: 'td-out-fumble', label: '大失败', color: '#ff7a7a' },
};

/**
 * 掷骰舞台：d20 画布 + 结果数字 + 动作描述。
 *
 * 博德之门 3 的关键视觉元素都在这里：
 *  - 中央一颗**大号金色 d20**，转动时数字快速跳动
 *  - 停下时数字定住，并给一圈琥珀色外发光
 *  - 结果按性质着色（大成功金、命中绿、未命中灰、大失败红）
 *  - 上方一行斜体衬线字的**动作描述**
 *
 * @param {import('../app.js').AppController} app
 * @param {any} battle
 */
function renderDiceStage(app, battle) {
    const roll = app.displayRoll;
    const showDice = app.settings.battle.showDice !== false;
    const unit = actionUnit(app, battle);
    const penalty = roll?.rolling ? roll.penaltyPreview : hitPenaltyPreview(unit, battle.ruleset);
    const initialChecks = !roll ? battle.log.filter(entry => entry?.data?.check).slice(-4)
        .map(entry => ({ ...entry.data.check, text: entry.text })) : [];

    // 使用出手时的结算快照，不能借用已经切换到下一回合的角色或重新掷骰。
    const resultLine = el('div', { class: 'td-check-result-wrap' }, [
        penalty ? renderPenaltyPreview(penalty) : null,
        roll?.targetName ? el('div', { class: 'td-check-target-name' }, `目标：${roll.targetName}`) : null,
        roll?.flavor ? el('div', { class: 'td-check-flavor' }, `「${roll.flavor}」`) : null,
        renderCheckResult(roll),
        initialChecks.length ? renderTurnChecks(initialChecks) : null,
    ]);

    // ---- 骰子容器 ----
    const diceHolder = el('div', { class: 'td-bg3-dice-holder' });
    if (showDice) {
        queueMicrotask(() => {
            if (!diceHolder.isConnected) return;
            mountDiceCanvas(diceHolder, app);
        });
    }

    // ---- 底部按钮 ----
    //
    // ⚠️ 这里原来的两个按钮是**死的**，用户直接指出「点击骰子和再掷一次没用就删了」：
    //   · 「点击骰子」只调 app.notify()（重画一遍），什么都不做；
    //   · 「再掷一次」只清 displayRoll，也不真的重掷。
    // 死按钮比没有按钮更糟：用户会以为功能坏了。
    // 现在改成**真的有行为**的按钮，没有可做的事就不渲染按钮。
    const buttons = [];
    if (roll && !roll.rolling && !battle.isFinished && battle.currentUnit) {
        const sameUnit = app.isUserUnit(battle.currentUnit);
        // 只有轮到**你自己**时才让你重掷/重选 —— AI 的回合不该由你插手
        if (sameUnit) {
            buttons.push(
                button('重选技能', () => {
                    app.displayRoll = null;
                    app.notify();
                }, { small: true, title: '清掉刚才的结果显示，重新挑一个技能' }),
            );
        }
    }

    return buildCheckPanel({
        actorName: roll ? (roll.actorName || '本次行动') : (unit?.name ?? ''),
        checkLabel: roll?.checkKind === 'charm' ? '魅力检定'
            : roll?.checkKind === 'control' ? `${roll.skillName} · 控制豁免`
            : roll?.checkKind === 'dot' ? `${roll.skillName} · 持续伤害豁免`
            : roll?.skillName ? `${roll.skillName} · 命中检定` : '命中检定',
        dc: null,
        modifier: null,
        hint: roll?.rolling ? '掷骰中…' : '本次判定结果',
        // 不再给 onRoll —— 骰子由行动流程自动驱动，不需要玩家点它
        onRoll: undefined,
        diceHolder,
        resultLine,
        buttons,
    });
}

/** 当前行动者的负面修正始终在掷骰前显示；读取快照，不重新求值骰子。 */
function renderPenaltyPreview(preview) {
    const total = preview.netModifier;
    return el('div', { class: 'td-preroll-penalty', role: 'status', 'data-actor-id': preview.actorId }, [
        el('b', {}, `${preview.actorName} · 掷骰前减益`),
        ...preview.parts.map(part => el('div', { class: 'td-preroll-source' }, `${part.source}：${part.value}`)),
        el('div', {}, `负面修正合计 ${preview.penalty}；装备与状态的净修正 ${total >= 0 ? '+' : ''}${total}（技能加成另计）`),
        el('div', { class: 'notes' }, preview.appliesToHit
            ? (preview.hitMode === 'chance' ? '此修正计入命中率公式，也计入控制与持续伤害豁免。'
                : '计入最终命中骰点与控制、持续伤害豁免；天然 1 / 20 仍按特殊规则判定。')
            : '当前自定义命中公式未使用 hitBonus；此减益仍计入控制与持续伤害豁免。'),
    ]);
}

/**
 * 给这次判定起个名字（截图里是「魅力检定」那种）。
 *
 * 我们没有 D&D 的属性体系，所以按当前行动的性质来命名 ——
 * 用技能就是「技能检定」，否则是「命中检定」。
 * @param {any} battle
 * @param {any} unit
 * @returns {string}
 */
function describeCheck(battle, unit) {
    if (!unit) return '';
    const lastSkill = battle?.log?.length
        ? [...battle.log].reverse().find((/** @type {any} */ l) => l.type === 'attack')?.data?.skillName
        : '';
    return lastSkill ? `${lastSkill} 检定` : '攻击检定';
}

/**
 * 在容器里挂载（或复用）d20 画布。
 *
 * 复用很重要：每次重画界面都新建画布会**打断正在转的动画**，
 * 表现就是骰子一顿一顿地跳。所以把 roller 存在 app 上，容器换了就搬过去。
 *
 * @param {HTMLElement} holder
 * @param {import('../app.js').AppController} app
 */
/**
 * 判断是不是「非浏览器」环境（冒烟测试的假 DOM）。
 *
 * 用途：关掉需要真实渲染循环的特性（骰子常驻自转），否则测试进程会挂住。
 */
function isStubEnv() {
    return typeof /** @type {any} */ (globalThis).requestAnimationFrame !== 'function' ||
        Boolean(/** @type {any} */ (globalThis).__TAVERN_DICE_STUB__);
}

function mountDiceCanvas(holder, app) {
    // 预加载 20 张骰面素材。只加载一次并缓存 ——
    // 掷骰那一刻不能现加载，否则会闪一下白。
    if (!hasFaceAssets()) {
        preloadFaces((loaded, total) => {
            if (loaded === total && !hasFaceAssets()) {
                console.warn('[战斗掷骰] 骰面素材未能全部加载，将使用占位绘制');
            }
        }).catch((e) => {
            console.warn('[战斗掷骰] 骰面素材预加载失败', e);
        });
    }

    let roller = /** @type {any} */ (app.diceRoller);
    let canvas = /** @type {HTMLCanvasElement} */ (roller?.canvas ?? null);

    const size = Math.max(150, Math.min(240, Math.round(window.innerWidth * 0.24) || 200));

    if (!canvas || canvas.width === 0) {
        canvas = /** @type {HTMLCanvasElement} */ (el('canvas', { class: 'td-dice-canvas' }));
        // alwaysAnimate: 静置时也缓慢自转 —— BG3 的骰子在等待时是活的，不是死贴图。
        // 但**桩环境里必须关掉**：常驻 rAF 循环会让测试进程退不出来（踩过）。
        roller = createDiceRoller(canvas, { size, alwaysAnimate: !isStubEnv() });
        roller.canvas = canvas; // 记下来，便于下次复用
        app.diceRoller = roller;
    }

    holder.appendChild(canvas);

    // 如果这次渲染时正处在「思考中」，让新挂载的画布继续转
    if (app.displayRoll?.rolling) roller.roll({ cycleMs: app.settings.battle.diceCycleMs });
    else if (app.displayRoll && !app.displayRoll.rolling && app.displayRoll.value > 0) {
        roller.settle(app.displayRoll.value, app.displayRoll.dieFaces ?? 20);
    } else roller.hide();
}

/**
 * 战斗结算面板。
 *
 * 这是「战斗不占楼层」这个设计的出口：
 *  - 战斗**全程**在插件里记录，聊天一个楼层都不动
 *  - 打完之后在这里合成**一条**消息，用户看过、确认了才发出去让正文模型续写
 *
 * 之所以要用户手动点：自动发出去等于替用户决定了「现在就继续剧情」，
 * 而且用户可能想先改改文字、或者干脆想重打一次。
 *
 * @param {import('../app.js').AppController} app
 * @param {{rerender: () => void}} helpers
 * @param {any} [battle] 还在战斗对象里时（判定刚结束、尚未回写）
 */
function renderResultPanel(app, helpers, battle) {
    const text = app.data.battleResult?.combatText ?? app.battleResultText({ includeBanter: false });
    if (!text) return el('div');
    const banterText = app.battleBanterText();

    const finished = Boolean(battle) && battle.phase === 'finished';
    const sent = app.battleSent;
    const box = el('div', { class: 'td-result-panel' });

    const textCount = el('span', { class: 'td-tag' });
    box.appendChild(
        el('div', { class: 'td-row td-between' }, [
            el('b', {}, finished ? '🏁 战斗判定结束' : '🏁 战斗已结束'),
            textCount,
        ]),
    );

    box.appendChild(
        el('div', { class: 'notes' }, [
            '战斗过程**只记录在插件里**，没有占用任何聊天楼层。',
            '下面这条是把整场战斗合成的一条消息 —— 发出去之后正文模型会接着写。',
            '你可以先改文字，或者复制出来自己用。',
        ].join('')),
    );

    const textarea = /** @type {HTMLTextAreaElement} */ (
        el('textarea', { class: 'text_pole td-result-text', rows: '10', spellcheck: 'false', value: text })
    );
    box.appendChild(textarea);

    const banterPreview = el('pre', { class: 'td-pre td-result-banter-preview', 'aria-label': '将随结算发送的口嗨记录' }, banterText);
    const banterHint = el('div', { class: 'notes td-result-banter-hint' });
    const banterToggle = button('', async () => {
        if (app.busy || !banterText) return;
        const pending = app.setBattleResultIncludeBanter(!app.includeBanterInResult, textarea.value);
        refreshBanterPreview();
        const saved = await pending;
        if (!saved.ok) toast(saved.error || '发送选择保存失败', 'error');
    }, { id: 'td-result-banter-toggle', disabled: app.busy || !banterText,
        title: '是否将口嗨记录一同发送进正文？切换仅更新预览，点击发送后才会写入聊天。' });
    const refreshBanterPreview = () => {
        const include = app.includeBanterInResult;
        banterToggle.textContent = include ? '💬 口嗨记录：一同发送' : '💬 口嗨记录：不发送';
        banterToggle.setAttribute('aria-pressed', String(include));
        banterPreview.style.display = include && banterText ? '' : 'none';
        banterHint.textContent = !banterText ? '本场没有可附带的口嗨记录。' : include
            ? '下方口嗨记录会随上方结算一起发送。切换为“不发送”可取消附带。'
            : '口嗨仍保留在插件记录中；本次只发送战斗结果、魅力检定与投靠结果。';
        textCount.textContent = `${textarea.value.length + (include && banterText ? banterText.length + 2 : 0)} 字`;
    };
    on(textarea, 'input', refreshBanterPreview);
    refreshBanterPreview();
    box.appendChild(el('div', { class: 'td-row td-gap td-wrap' }, [
        el('span', {}, '口嗨记录是否一同发送进正文？'), banterToggle,
    ]));
    box.appendChild(banterHint);
    box.appendChild(banterPreview);

    const actions = el('div', { class: 'td-row td-gap td-wrap td-result-actions' });

    if (finished) {
        actions.appendChild(
            button(
                '✅ 结束战斗并整理结果',
                async () => {
                    const result = await app.finishBattle(textarea.value);
                    helpers.rerender();
                    if (result.ok) toast('结果已整理，可发送给正文模型续写', 'success');
                },
                { variant: 'primary', disabled: app.busy },
            ),
        );
    }

    actions.appendChild(
        button(
            sent ? '📤 再发一次' : '📤 发送给正文模型续写',
            async () => {
                // 保留用户编辑的战斗文本；口嗨由控制器按当前开关附加。
                const result = await app.sendBattleResult(textarea.value);
                helpers.rerender();
                if (!result.ok) toast(result.error ?? '发送失败', 'error');
            },
            { variant: finished ? undefined : 'primary', disabled: app.busy },
        ),
    );

    actions.appendChild(
        button('📋 复制', async () => {
            const copyText = app.includeBanterInResult && banterText ? `${textarea.value}\n\n${banterText}` : textarea.value;
            try {
                await navigator.clipboard.writeText(copyText);
                toast('已复制到剪贴板', 'success');
            } catch {
                // 复制完整预览，不把口嗨写回编辑框而导致发送时重复附加。
                const copyArea = el('textarea', { class: 'text_pole', readonly: true, rows: '6', value: copyText });
                box.appendChild(copyArea);
                copyArea.select();
                toast('已选中完整结算，请手动复制', 'info');
            }
        }),
    );

    actions.appendChild(
        button('🗑 丢弃结算', async () => {
            await app.discardBattleResult();
            helpers.rerender();
        }, { small: true, variant: 'danger' }),
    );

    box.appendChild(actions);

    if (sent) {
        box.appendChild(el('div', { class: 'notes' }, '已发送过。再点一次会重复发一条 —— 通常不需要。'));
    }

    return box;
}

/**
 * 没在打的时候：**开战入口**。
 *
 * 这是整个插件的核心入口。设计思路（与「填表」相反）：
 *   用户只需要**描述一下要打谁**（甚至什么都不写直接点开战），
 *   正文模型自己去读当前剧情，把参战双方、状态、血量估算、技能、临时加成读出来；
 *   再由掷骰模型转成结构化数据，确认后开打。
 *
 * 之所以不要求用户填表：那些信息模型本来就知道，让人再手打一遍纯属折腾。
 *
 * @param {import('../app.js').AppController} app
 * @param {{rerender: () => void, setTab: (tab: string) => void}} helpers
 */
function renderBattleIdle(app, helpers) {
    const settings = app.settings;
    const system = app.powerSystem;
    const allies = system?.combatants?.filter((/** @type {any} */ u) => u.side === SIDE.ALLY && u.alive) ?? [];
    const enemies = system?.combatants?.filter((/** @type {any} */ u) => u.side === SIDE.ENEMY && u.alive) ?? [];
    const root = el('div', { class: 'td-battle-setup' });

    root.appendChild(
        el('div', { class: 'td-start-hero' }, [
            el('h3', {}, '⚔️ 开始一场战斗'),
            el('p', { class: 'notes' }, [
                '点下面的按钮，插件会**自动把一条战斗场景指令写进输入框并发出去** —— ',
                '正文模型会当场写出一份战斗场景清单（我方/敌方、位阶、人设、血量、魔量、技能、武器、临时属性）。',
                '等它输出完，插件直接解析这份清单并开打。**你不用填任何表，也不用等剧情里恰好正在打。**',
            ].join('')),
        ]),
    );

    // ---- 战斗场景指令预览（可折叠）----
    const situationInput = /** @type {HTMLTextAreaElement} */ (
        el('textarea', {
            class: 'text_pole td-situation-input',
            rows: '3',
            placeholder:
                '（可选）补充要求，会追加到战斗场景指令里，例如：\n这是一场切磋，不要下杀手\n把跟着我的三个护卫也算进我方',
        })
    );

    const scenePreview = el(
        'pre',
        { class: 'td-pre td-scene-preview' },
        [buildSceneRequest({ template: app.settings.battle.scenePrompt }),
            loadoutSceneNote(app.loadoutEntries || [], { accessoryMode: app.prebattleSelection?.accessoryMode || 'story' })].filter(Boolean).join('\n\n'),
    );

    const seedInput = /** @type {HTMLInputElement} */ (
        textInput({ placeholder: '随机种子（留空则随机）', value: settings.battle.seed ?? '' })
    );

    root.appendChild(
        el('div', { class: 'td-panel-soft' }, [
            el('div', { class: 'td-mini-label' }, '补充要求（可选）'),
            situationInput,
            renderPrebattle(app, helpers),
            el('div', { class: 'td-row td-gap td-wrap td-start-actions' }, [
                button(
                    '⚔️ 开始战斗',
                    async () => {
                        const result = await app.startBattleByScene({
                            situation: situationInput.value.trim() || undefined,
                            autoSend: settings.battle.autoSendScene !== false,
                        });
                        helpers.rerender();
                        if (result.ok) {
                            helpers.setTab('battle');
                            return;
                        }
                        if (result.needsManualSend) return; // 已经提示过了
                        if (result.error && result.error !== '已被用户终止') toast(result.error, 'error');
                    },
                    { variant: 'primary', disabled: app.busy },
                ),
                button(
                    '📝 只写指令（不发送）',
                    () => {
                        const ok = app.writeToInput(
                            [buildSceneRequest({
                                situation: situationInput.value.trim() || undefined,
                                template: settings.battle.scenePrompt,
                            }), loadoutSceneNote(app.loadoutEntries || [], { accessoryMode: app.prebattleSelection?.accessoryMode || 'story' })].filter(Boolean).join('\n\n'),
                        );
                        helpers.rerender();
                        toast(ok ? '指令已写入输入框 —— 检查后按发送' : '找不到输入框', ok ? 'success' : 'error');
                    },
                    { disabled: app.busy, title: '想先看看/改改指令内容再发时用' },
                ),
                button(
                    '👁 读已有剧情开战',
                    async () => {
                        await app.readBattleSituation({ situation: situationInput.value.trim() || undefined });
                        helpers.rerender();
                    },
                    { disabled: app.busy, title: '不生成新场景，直接读最近剧情里已有的战斗' },
                ),
            ]),
            el('div', { class: 'td-row td-gap td-wrap' }, [
                el('div', { class: 'td-labeled' }, [el('span', { class: 'td-mini-label' }, '种子'), seedInput]),
                button('保存', async () => {
                    settings.battle.seed = seedInput.value.trim();
                    await app.persistSettings({ silent: true });
                    toast('已保存', 'success');
                }, { small: true }),
            ]),
            el('details', { class: 'td-scene-details' }, [
                el('summary', {}, '看看会写进输入框的指令长什么样'),
                scenePreview,
            ]),
        ]),
    );

    // ---- 已有的战况汇报 ----
    const situation = app.battleSituation;
    if (situation?.report) {
        // 模型可能在汇报里明说「当前没有战斗场面」——
        // 这种情况要显眼地标出来，否则用户点了开战却不知道为什么没动
        const looksLikeNoBattle = /当前剧情没有战斗场面|没有正在发生的战斗|无战斗|没有战斗/.test(situation.report);

        root.appendChild(
            el('div', { class: `td-situation-report${looksLikeNoBattle ? ' td-situation-nobattle' : ''}` }, [
                el('div', { class: 'td-row td-between' }, [
                    el('b', {}, looksLikeNoBattle ? '⚠️ 模型认为当前没有战斗' : '📋 模型读到的战况'),
                    el('span', { class: 'notes' }, formatAgo(situation.at)),
                ]),
                looksLikeNoBattle
                    ? el('div', { class: 'notes' }, [
                          '模型读完剧情后认为眼下并没有正在发生的战斗。可以：',
                          '① 在下面的输入框里写清「谁在打谁」再点「只读场面」重读；',
                          '② 或者直接点「⚔️ 强制开战」（如果你就是想现在打一场）。',
                      ].join(''))
                    : null,
                el('pre', { class: 'td-pre td-situation-text' }, situation.report),
                el('div', { class: 'td-row td-gap td-wrap' }, [
                    button(
                        looksLikeNoBattle ? '⚔️ 强制开战（按上面的汇报）' : '⚔️ 用这个战况开战',
                        async () => {
                            const result = await app.startBattleFromSituation({ skipRead: true, force: true });
                            helpers.rerender();
                            if (!result.ok && result.error && !result.noBattle && result.error !== '已被用户终止') {
                                toast(result.error, 'error');
                            }
                        },
                        { variant: 'primary', disabled: app.busy },
                    ),
                    button('🔄 重新读一遍', async () => {
                        await app.readBattleSituation({ situation: situationInput.value.trim() || undefined });
                        helpers.rerender();
                    }, { disabled: app.busy }),
                    button('✏ 手工修正', () => {
                        // 把汇报放回输入框让用户改，改完再读一遍 —— 比让他重写整段省事
                        situationInput.value = situation.report;
                        toast('已把战况放进输入框，改好后点「只读场面」重新整理', 'info');
                    }),
                    button('🗑 丢弃', () => {
                        app.battleSituation = null;
                        helpers.rerender();
                    }, { small: true }),
                ]),
            ]),
        );
    }

    // ---- 现有战斗数据概况 ----
    // 注意：这是「上一次开战留下的数据」，不代表即将开打的场面 ——
    // 点「开始战斗」会重新生成一份全新的战斗场景。
    const stats = system
        ? el('div', { class: 'td-stats' }, [
              stat('数据里的单位', system.combatants.length),
              stat('我方可战', allies.length),
              stat('敌方可战', enemies.length),
              stat('规则集', app.ruleset.name),
          ])
        : el('div', { class: 'notes' }, '（还没有战斗数据 —— 点「开始战斗」会先生成战斗场景）');

    root.appendChild(stats);

    // ---- 兜底：手工指定 ----
    root.appendChild(
        el('details', { class: 'td-start-manual' }, [
            el('summary', {}, '恢复战斗存档'),
            el('div', { class: 'td-row td-gap td-wrap' }, [
                button('🔄 恢复上一场战斗', () => {
                    if (app.restoreBattle()) {
                        helpers.rerender();
                        toast('已恢复上一场战斗', 'success');
                    } else {
                        toast('本聊天没有可恢复的战斗', 'info');
                    }
                }),
            ]),
        ]),
    );

    return root;
}

/** 战斗头部：标题、回合数、控制按钮。 */
function renderBattleHeader(app, battle, helpers) {
    const finished = battle.phase === 'finished';
    const winnerText =
        battle.winner === SIDE.ALLY ? '我方胜利' : battle.winner === SIDE.ENEMY ? '我方败北' : battle.winner === 'draw' ? '两败俱伤' : '';

    return el('div', { class: 'td-battle-head' }, [
        el('div', { class: 'td-battle-title' }, [
            el('b', {}, battle.name),
            el('span', { class: 'td-badge' }, `第 ${battle.round} 回合`),
            el('span', { class: 'td-badge td-badge-seed', title: '随机种子（可用于复盘）' }, `种子 ${battle.seed}`),
            el('span', { class: 'td-badge' }, `规则集 ${app.ruleset.name}`),
            // 战斗模式徽章：切磋 vs 生死搏杀。
            // 这个必须显眼 —— 它决定倒下的人是「力竭」还是「阵亡」。
            el(
                'span',
                {
                    class: `td-badge ${battle.combatMode === 'deadly' ? 'td-badge-bad' : 'td-badge-good'}`,
                    title:
                        battle.combatMode === 'deadly'
                            ? '生死搏杀：倒下即阵亡'
                            : '切磋：倒下算力竭，不会阵亡（由正文 AI 判定，可在设置里强制指定）',
                },
                battle.combatMode === 'deadly' ? '⚔ 生死搏杀' : '🤝 切磋',
            ),
            finished && winnerText ? el('span', { class: `td-badge ${battle.winner === SIDE.ALLY ? 'td-badge-good' : 'td-badge-bad'}` }, winnerText) : null,
        ]),
        el('div', { class: 'td-battle-controls' }, [
            button('▶ 自动推进', () => runAutoAdvance(app, helpers), {
                title: '连续执行直到轮到我方单位或战斗结束',
                disabled: finished || app.busy,
            }),
            button('🎲 自动行动一次', async () => {
                const result = await app.autoAct();
                if (!result.ok) toast(result.error ?? '行动失败', 'warning');
                helpers.rerender();
            }, { disabled: finished || app.busy, title: '让当前单位按启发式规则行动' }),
            button('⏭ 跳过', async () => {
                await (app.isUserUnit(app.battle?.currentUnit) ? app.playPlayerTurn.bind(app) : app.act.bind(app))({ action: 'skip' });
                helpers.rerender();
            }, { disabled: finished || app.busy }),
            button('🛡 防御', async () => {
                await (app.isUserUnit(app.battle?.currentUnit) ? app.playPlayerTurn.bind(app) : app.act.bind(app))({ action: 'defend' });
                helpers.rerender();
            }, { disabled: finished || app.busy }),
            finished
                ? button('✅ 结束战斗并整理结果', async () => {
                      const result = await app.finishBattle();
                      helpers.rerender();
                      if (result.ok) toast('结果已整理，可发送给正文模型续写', 'success');
                  }, { variant: 'primary' })
                : button('✖ 放弃战斗', async () => {
                      // 先给一次即时反馈 —— 弹窗创建有一帧延迟，用户会以为按不动
                      const ok = await confirmDialog('放弃当前战斗？本场进度将被清除，不会发送给正文模型。');
                      if (!ok) return;
                      const result = await app.abandonBattle();
                      helpers.rerender();
                      toast(result?.ok === false ? '放弃失败' : '已放弃这场战斗', result?.ok === false ? 'error' : 'info');
                  }, { variant: 'danger' }),
        ]),
    ]);
}

/**
 * 「哪个角色是我」选择条。
 *
 * 为什么需要它：插件要适配任何一张卡，所以**绝不能猜**你的角色是谁。
 * 自动识别（模型标记 / persona 名字 / 补充说明）可能失败，
 * 失败时必须让你**一键指定**，而不是默默地把你的角色也交给 AI。
 *
 * @param {import('../app.js').AppController} app
 * @param {any} battle
 * @param {{rerender: () => void}} helpers
 */
function renderUserPicker(app, battle, helpers) {
    const allies = battle.units.filter((/** @type {any} */ u) => u.side === 'ally');
    if (!allies.length) return el('div');

    const current = allies.find((/** @type {any} */ u) => app.isUserUnit(u));
    const box = el('div', { class: `td-user-picker${current ? '' : ' td-user-picker-warn'}` });

    box.appendChild(
        el('div', { class: 'td-row td-between' }, [
            el('b', {}, current ? `🎮 你操控：${current.name}` : '⚠️ 还没指定哪个角色是你'),
            el('span', { class: 'notes' }, current ? (app.settings.battle.aiControlsAllies !== false ? '其余我方成员由 AI 操作' : '队友由你手动指挥') : '请先指定玩家角色，自动行动已暂停'),
        ]),
    );

    const buttons = el('div', { class: 'td-row td-gap td-wrap' });
    for (const u of allies) {
        const isCurrent = current === u;
        buttons.appendChild(
            button(
                `${isCurrent ? '✓ ' : ''}${u.name}`,
                async () => {
                    const result = await app.setUserUnit(isCurrent ? '' : u.name);
                    if (!result.ok) toast(result.error || '暂时无法换人', 'warning');
                    helpers.rerender();
                },
                {
                    small: true,
                    variant: isCurrent ? 'primary' : undefined,
                    disabled: app.busy || app._autoDriving || app._playerTurnRunning || !u.alive,
                    title: app.busy ? '等待当前行动完成后可换人' : isCurrent ? '点一下取消指定' : `把「${u.name}」设为你的角色`,
                },
            ),
        );
    }
    box.appendChild(buttons);

    if (!current) {
        box.appendChild(
            el('div', { class: 'notes' }, [
                '自动识别没成功。点上面你的角色名字即可 —— 指定后**只有你自己那一手需要操作**，队友交给 AI。',
                `（你在酒馆里登记的 persona 名字是「${app.ctx?.name1 || '（未设置）'}」）`,
            ].join('')),
        );
    }

    return box;
}

/** 先攻顺序条。 */
function renderInitiativeStrip(battle) {
    const strip = el('div', { class: 'td-initiative' }, [
        el('span', { class: 'td-mini-label' }, '先攻'),
    ]);
    battle.initiative.forEach((entry, index) => {
        const unit = battle.units.find((/** @type {any} */ u) => u.id === entry.unitId);
        if (!unit || unit.mercyWithdrawn === true) return;
        const isCurrent = index === battle.turnIndex && battle.phase !== 'finished';
        strip.appendChild(
            el(
                'div',
                {
                    class: `td-init-chip${isCurrent ? ' td-init-current' : ''}${unit.alive ? '' : ' td-init-dead'}`,
                    title: `${unit.name}：先攻 ${entry.roll} + ${entry.bonus} = ${entry.total}`,
                },
                [
                    el('span', { class: 'td-init-name' }, unit.name),
                    el('span', { class: 'td-init-roll' }, String(entry.total)),
                ],
            ),
        );
    });
    return strip;
}

/** 草稿随战斗对象存活，notify 重绘不丢失输入或发送状态。 */
const banterDrafts = new WeakMap();

function renderBanter(app, battle, helpers) {
    let draft = banterDrafts.get(battle);
    if (!draft) {
        draft = { text: '', targetId: '', sending: false, checking: false, error: '' };
        banterDrafts.set(battle, draft);
    }
    const targets = battle.units.filter(u => u.alive && u.side === 'enemy' && !app.isUserUnit(u));
    if (!targets.some(u => u.id === draft.targetId)) draft.targetId = targets[0]?.id ?? '';
    const box = el('div', { class: 'td-banter' });
    const input = /** @type {HTMLTextAreaElement} */ (el('textarea', {
        class: 'text_pole td-banter-input', rows: '2', 'aria-label': '口嗨内容',
        placeholder: '对敌方角色说点什么……', value: draft.text,
    }));
    const picker = /** @type {HTMLSelectElement} */ (el('select', {
        class: 'text_pole td-banter-target', 'aria-label': '口嗨对象（存活敌方）',
    }, targets.length ? targets.map(u => el('option', { value: u.id, text: u.name }))
        : [el('option', { value: '', text: '暂无可对话的敌方角色' })]));
    picker.value = draft.targetId;
    const hint = el('div', { class: 'notes', role: 'status', 'aria-live': 'polite' });
    const send = /** @type {HTMLButtonElement} */ (el('button', {
        type: 'button', class: 'menu_button td-banter-send', text: '发送口嗨',
    }));
    const persuasion = el('div', {
        class: 'td-persuasion', role: 'region', 'aria-label': '说服检定确认',
    });
    const interactionDisabledReason = () => {
        if (app.battle !== battle || battle.phase === 'finished') return '战斗已结束，无法继续口嗨或检定。';
        if (draft.sending || draft.checking || app.busy) return '正在处理，请稍候。';
        if (!battle.currentUnit?.alive || !app.isUserUnit(battle.currentUnit)) return '仅在存活玩家的回合可口嗨或检定。';
        if (!battle.units.some(u => u.id === draft.targetId && u.alive && u.side === 'enemy' && !app.isUserUnit(u))) return '暂无可对话的敌方角色，请选择存活的敌方目标。';
        return '';
    };
    const disabledReason = () => {
        const reason = interactionDisabledReason();
        if (reason) return reason;
        if (!draft.text.trim()) return '请输入口嗨内容后发送。';
        if (typeof app.sendBanter !== 'function') return '口嗨功能尚未就绪。';
        return '';
    };
    const chooseCharm = async (targetId, preview, defer) => {
        const method = defer ? 'deferCharmCheck' : 'rollCharmCheck';
        if (interactionDisabledReason() || draft.targetId !== targetId || typeof app[method] !== 'function') return;
        // 按玩家看到的待确认 token 提交；控制器负责检查保存后的真实状态。
        const panel = box.closest('.td-panel');
        let saved = false;
        draft.checking = true;
        draft.error = '';
        refresh();
        try {
            const result = await app[method]({ targetId, pendingId: preview.id });
            saved = Boolean(result?.ok);
            if (!saved) draft.error = String(result?.error || '说服操作未完成，请重试。');
        } catch {
            draft.error = '说服操作未完成，草稿已保留，请重试。';
        } finally {
            draft.checking = false;
            helpers.rerender();
            if (defer && saved && app.battle === battle && draft.targetId === targetId) {
                const liveInput = panel?.querySelector('.td-banter-input') ?? (box.isConnected ? input : null);
                liveInput?.focus();
            }
        }
    };
    const refreshPersuasion = () => {
        clear(persuasion);
        persuasion.hidden = true;
        const targetId = draft.targetId;
        const target = battle.units.find(u => u.id === targetId && u.alive && u.side === 'enemy' && !app.isUserUnit(u));
        persuasion.setAttribute('data-target-id', targetId);
        if (!target) return;
        // 只有控制器确认本次对话可触发说服检定时才显示确认；记忆与评估留在后台。
        const preview = typeof app.getCharmPreview === 'function' ? app.getCharmPreview(targetId) : null;
        if (!preview) return;
        persuasion.hidden = false;
        persuasion.appendChild(el('b', { class: 'td-persuasion-target' }, `对 ${target.name} 的说服`));
        const offer = el('div', { class: 'td-charm-offer', 'data-pending-id': preview.id });
        offer.appendChild(el('b', {}, '现在进行说服检定吗？'));
        const modifier = Number(preview.modifier);
        offer.appendChild(el('div', { class: 'td-charm-stats' }, [
            el('strong', { class: 'td-charm-required' }, `d20 ≥ ${preview.requiredNatural}`),
            el('span', { class: 'td-charm-dc' }, `DC ${preview.dc}`),
            el('span', { class: 'td-charm-modifier' }, `魅力加成 ${modifier >= 0 ? '+' : ''}${modifier}`),
            el('span', { class: 'td-charm-chance' }, `成功率 ${Math.round(preview.successChance * 1000) / 10}%`),
        ]));
        offer.appendChild(el('div', { class: 'notes td-charm-rules' },
            `天然 1 失败，天然 20 成功。${preview.natural20Only ? '当前仅天然 20 可成功。' : ''}`));
        if (preview.deferred) {
            offer.appendChild(el('div', { class: 'notes td-charm-deferred' },
                '已暂缓检定。'));
        }
        const actions = el('div', { class: 'td-row td-gap td-wrap td-charm-actions' });
        for (const [label, className, method, defer] of [
            ['现在掷骰', 'td-charm-roll', 'rollCharmCheck', false],
            ['继续劝说', 'td-charm-defer', 'deferCharmCheck', true],
        ]) {
            const action = el('button', { type: 'button', class: `menu_button ${className}`, text: label });
            const reason = interactionDisabledReason() || (typeof app[method] !== 'function' ? '说服检定功能尚未就绪。' : '');
            action.disabled = Boolean(reason);
            action.title = reason || (defer ? '保留草稿，继续输入劝说内容' : '按当前预览进行一次说服检定');
            on(action, 'click', () => chooseCharm(targetId, preview, defer));
            actions.appendChild(action);
        }
        offer.appendChild(actions);
        persuasion.appendChild(offer);
    };
    const refresh = () => {
        const reason = disabledReason();
        send.disabled = Boolean(reason);
        send.title = reason || '发送口嗨，不推进回合';
        picker.disabled = draft.sending || draft.checking || !targets.length;
        hint.textContent = draft.error || reason || '口嗨不推进回合，可继续选择战斗行动。';
        refreshPersuasion();
    };
    on(input, 'input', () => { draft.text = input.value; draft.error = ''; refresh(); });
    on(picker, 'change', () => { draft.targetId = picker.value; draft.error = ''; refresh(); });
    on(send, 'click', async () => {
        if (disabledReason()) { refresh(); return; }
        const sentText = draft.text;
        const targetId = draft.targetId;
        draft.sending = true;
        draft.error = '';
        refresh();
        try {
            const result = await app.sendBanter({ targetId, text: sentText.trim() });
            if (result?.ok) {
                // 等待期间允许继续写草稿；成功也只清空实际发送的那份。
                if (draft.text === sentText) draft.text = '';
            } else draft.error = String(result?.error || '发送失败，草稿已保留，请重试。');
        } catch {
            draft.error = '发送失败，草稿已保留，请重试。';
        } finally {
            draft.sending = false;
            helpers.rerender();
        }
    });
    refresh();
    box.appendChild(el('b', {}, '战场口嗨'));
    box.appendChild(input);
    box.appendChild(el('div', { class: 'td-row td-gap td-wrap' }, [picker, send]));
    box.appendChild(persuasion);
    box.appendChild(hint);
    const entries = [...(battle.banterHistory ?? [])].sort((a, b) => (a.at ?? 0) - (b.at ?? 0)).slice(-8);
    if (entries.length) {
        const recent = el('div', { class: 'td-banter-recent', 'aria-label': '最近口嗨对话' });
        for (const entry of entries) {
            const line = el('div');
            line.textContent = String(entry.text ?? '');
            recent.appendChild(line);
        }
        box.appendChild(recent);
    }
    return box;
}

/** 单位面板区。 */
function renderUnitPanels(app, battle, helpers) {
    const wrap = el('div', { class: 'td-battle-units' }, [
        el('div', { class: 'notes td-roster-help' }, '点击头像更换图片 · 点击红蓝球查看属性'),
    ]);

    for (const side of [SIDE.ALLY, SIDE.ENEMY, SIDE.NEUTRAL]) {
        const units = battle.units.filter((/** @type {any} */ u) => u.side === side && !u.mercyWithdrawn);
        if (side === SIDE.ALLY) units.sort((a, b) => Number(app.isUserUnit(b)) - Number(app.isUserUnit(a)));
        if (!units.length) continue;
        const column = el('div', { class: `td-battle-column td-column-${side}` }, [
            el('div', { class: 'td-column-head' }, `${SIDE_LABEL[side] ?? side}`),
        ]);
        const roster = el('div', { class: 'td-roster-row' });
        for (const unit of units) roster.appendChild(renderBattleUnit(app, battle, unit, helpers));
        column.appendChild(roster);
        wrap.appendChild(column);
    }
    const spectators = battle.units.filter(unit => unit.mercyWithdrawn === true);
    if (spectators.length) {
        const seats = el('section', { class: 'td-battle-column td-mercy-spectators', 'aria-label': '观战席' }, [
            el('div', { class: 'td-column-head' }, '观战席 · 已留手退出'),
            el('div', { class: 'notes' }, '这些角色保留生命，已退出本场战斗，不再行动或成为攻击目标；不是阵亡。'),
        ]);
        const roster = el('div', { class: 'td-roster-row' });
        for (const unit of spectators) roster.appendChild(renderBattleUnit(app, battle, unit, helpers));
        seats.appendChild(roster);
        wrap.appendChild(seats);
    }
    return wrap;
}

/** 展开状态随战斗对象回收；每次刷新UI不会把正在查看的属性折叠。 */
const expandedUnitDetails = new WeakMap();

/** 红蓝玻璃球，液面随当前资源比例变化；数值只在展开详情后出现。 */
function resourceOrb(pool, kind, label) {
    const ratio = pool.max > 0 ? Number(pool.current) / Number(pool.max) : 0;
    const percent = Number.isFinite(ratio) ? Math.max(0, Math.min(100, ratio * 100)) : 0;
    return el('span', { class: 'td-resource-wrap', 'aria-hidden': 'true' }, [
        el('span', { class: 'td-resource-orb td-orb-' + kind }, [
            el('span', { class: 'td-orb-liquid', style: { height: percent + '%' } }),
            el('span', { class: 'td-orb-glass' }),
        ]),
        el('span', { class: 'td-orb-label' }, label),
    ]);
}

/** 战斗中的紧凑头像卡。 */
function renderBattleUnit(app, battle, unit, helpers) {
    const withdrawn = unit.mercyWithdrawn === true;
    const isCurrent = !withdrawn && battle.currentUnit?.id === unit.id && battle.phase !== 'finished';
    const isPlayer = app.isUserUnit(unit);
    const hp = unit.attributes?.HP ?? { current: 0, max: 0 };
    const mp = unit.attributes?.MP ?? { current: 0, max: 0 };
    const shield = (unit.statuses ?? []).filter(s => s.type === 'shield')
        .reduce((sum, s) => sum + (toNumber(s.power) || 0) * (s.stacks || 1), 0);
    let expanded = expandedUnitDetails.get(battle);
    if (!expanded) { expanded = new Set(); expandedUnitDetails.set(battle, expanded); }
    const detailId = 'td-unit-details-' + unit.id;
    const details = el('div', { class: 'td-unit-details', id: detailId }, [
        el('div', { class: 'td-resource-values' }, [
            el('span', {}, '生命 HP ' + hp.current + '/' + hp.max),
            el('span', {}, '魔量 MP ' + mp.current + '/' + mp.max),
            shield > 0 ? el('span', {}, '护盾 ' + shield) : null,
        ]),
        el('div', { class: 'td-bunit-attrs' }, [
            '攻 ' + (unit.attributes?.Atk?.current ?? 0),
            '甲 ' + (unit.attributes?.Armor?.current ?? 0),
            '速 ' + (unit.attributes?.Speed?.current ?? 0),
            '闪 ' + (unit.attributes?.Evasion?.current ?? 0),
        ].join('　')),
        unit.tier ? el('div', { class: 'notes' }, '位阶：' + unit.tier) : null,
        el('div', { class: 'td-unit-charm' }, [
            el('b', {}, '定向魅力'),
            ...(Array.isArray(unit.social?.charm) && unit.social.charm.length
                ? unit.social.charm.map(charm => el('div', {
                    text: `对 ${charm.targetName}：${charm.value} · ${charm.reason || '未提供原因'}`,
                }))
                : [el('div', {}, '暂无定向魅力记录')]),
        ]),
        unit.equipment?.length ? el('div', { class: 'td-bunit-equips' }, unit.equipment.map(e =>
            (SLOT_LABEL[e.slot] ?? '其它') + '·' + e.name + ' ' + formatEquipmentBonuses(e) + (e.effect ? '（' + e.effect + '）' : '')
        ).join('；')) : null,
        unit.statuses?.length ? el('div', { class: 'td-bunit-statuses' }, unit.statuses.map(s =>
            el('span', { class: 'td-tag td-tag-sm' }, s.name + (s.duration ? '·' + s.duration : ''))
        )) : null,
    ]);
    details.hidden = !expanded.has(unit.id);
    on(details, 'click', e => e.stopPropagation());
    const resources = el('button', {
        type: 'button', class: 'td-resource-toggle',
        'aria-label': unit.name + '：查看生命、魔量、攻击、护甲、速度与闪避',
        'aria-expanded': String(!details.hidden), 'aria-controls': detailId,
        title: '点击红蓝球查看或收起属性',
    }, [resourceOrb(hp, 'hp', '生命'), resourceOrb(mp, 'mp', '魔量')]);
    on(resources, 'click', e => {
        e.stopPropagation();
        details.hidden = !details.hidden;
        if (details.hidden) expanded.delete(unit.id); else expanded.add(unit.id);
        resources.setAttribute('aria-expanded', String(!details.hidden));
    });
    const card = el('div', {
        class: 'td-bunit td-roster-unit' + (isPlayer ? ' td-player-unit' : '') +
            (isCurrent ? ' td-bunit-current' : '') + (withdrawn ? ' td-bunit-withdrawn' : unit.alive ? '' : ' td-bunit-dead'),
        id: 'td-bunit-' + unit.id,
    }, [
        renderPortrait(app.ctx, unit, helpers),
        el('div', { class: 'td-bunit-name', title: unit.name }, unit.name),
        el('div', { class: 'td-unit-role' }, withdrawn ? '观战席' : isPlayer ? '你操控' : SIDE_LABEL[unit.side] ?? '参战者'),
        isCurrent ? el('span', { class: 'td-tag td-tag-good' }, '行动中') : null,
        withdrawn ? el('span', { class: 'td-tag td-tag-good' }, '留手退出 · 存活')
            : !unit.alive ? el('span', { class: 'td-tag' }, battle.combatMode === 'spar' ? '力竭' : '倒下') : null,
        resources, details,
    ]);
    const pending = getPendingAction(app, battle);
    if (!withdrawn && pending && pending.candidateIds?.includes(unit.id)) {
        card.classList.add('td-bunit-targetable');
        card.appendChild(button('选为目标', async () => {
            await executePending(app, battle, [unit.id], helpers);
        }, { small: true, disabled: app.busy }));
        on(card, 'click', async e => {
            if (e.target?.closest?.('button, input, .td-unit-details')) return;
            e.stopPropagation();
            await executePending(app, battle, [unit.id], helpers);
        });
    }
    return card;
}

/** 待执行的动作（选了技能、还没选目标）。 */
let pendingAction = new WeakMap();
const BASIC_ATTACK = Object.freeze({ id: '', name: '普通攻击', target: 'single', effects: [{ type: 'damage' }] });
function actionUnit(app, battle) {
    return typeof app.getActionUnit === 'function' ? app.getActionUnit() : battle.currentUnit;
}

function getPendingAction(app, battle) {
    const pending = pendingAction.get(battle);
    if (!pending) return null;
    const unit = actionUnit(app, battle);
    const manual = unit && (app.isUserUnit(unit) || (unit.side === 'ally' && app.settings.battle.aiControlsAllies === false));
    const skill = pending.skillId ? unit?.skills?.find(s => s.id === pending.skillId) : BASIC_ATTACK;
    if (!manual || battle.phase === 'finished' || pending.unitId !== unit?.id ||
        pending.round !== battle.round || pending.turnIndex !== battle.turnIndex || !skill) {
        pendingAction.delete(battle);
        return null;
    }
    pending.candidateIds = battle.targetCandidates(unit, skill).map(target => target.id);
    return pending;
}

/**
 * 技能与动作区。
 * @param {import('../app.js').AppController} app
 * @param {any} battle
 * @param {{rerender: () => void}} helpers
 */
function renderActionBar(app, battle, helpers) {
    const unit = actionUnit(app, battle);
    const wrap = el('div', { class: 'td-action-bar' });

    if (battle.phase === 'finished') {
        wrap.appendChild(el('div', { class: 'notes' }, '战斗已结束。点「结束战斗并整理结果」保存本场结算，再发送给正文模型续写。'));
        return wrap;
    }
    if (!unit) {
        wrap.appendChild(el('div', { class: 'notes' }, '当前没有行动单位。'));
        return wrap;
    }

    const isPlayer = app.isUserUnit(unit);
    const manualAlly = unit.side === 'ally' && app.settings.battle.aiControlsAllies === false;
    if (!isPlayer && !manualAlly) {
        const owners = battle.units.filter(u => app.isUserUnit(u));
        if (owners.length !== 1) {
            wrap.appendChild(el('div', { class: 'notes' }, '请先在上方指定你操控的角色，自动行动已暂停。'));
            return wrap;
        }
        if (app._autoDriveStop && !app._autoDriving && !app._playerTurnRunning) {
            wrap.appendChild(el('div', { class: 'notes' }, '自动行动已暂停。可在上方重新选择你要操控的角色。'));
            return wrap;
        }
        wrap.appendChild(el('div', { class: 'td-action-head' }, (app._autoDriving || app._playerTurnRunning ? 'AI 正在处理：' : '等待自动行动：') + unit.name));
        wrap.appendChild(el('div', { class: 'notes' }, '自动选择技能、掷骰并更新数据，完成后回到你的回合。'));
        if (app._autoDriving || app._playerTurnRunning) {
            wrap.appendChild(button('⏹ 停止自动推进', () => app.stopAutoDrive(), { variant: 'danger' }));
        }
        return wrap;
    }
    const pending = getPendingAction(app, battle);

    wrap.appendChild(
        el('div', { class: 'td-action-head' }, [
            el('b', {}, `${battle.awaitingPlayerAction ? '准备行动' : '轮到'}：${unit.name}`),
            el('span', { class: 'notes' }, `${SIDE_LABEL[unit.side] ?? unit.side}`),
            pending ? el('span', { class: 'td-tag td-tag-warn' }, `正在为「${pending.skillName}」选择目标`) : null,
            pending ? button('取消选择', () => {
                pendingAction.delete(battle);
                helpers.rerender();
            }, { small: true }) : null,
        ]),
    );

    if (battle.awaitingPlayerAction) wrap.appendChild(el('div', { class: 'td-manual-start notes' },
        '换人不会推进回合。选定技能与目标后才开始行动；仍按先攻顺序处理，执行前会复核目标。'));

    // 普通攻击
    const basicSkillRow = el('div', { class: 'td-skill-buttons' });
    basicSkillRow.appendChild(
        button('普通攻击 · 单体', () => selectSkill(app, battle, BASIC_ATTACK, helpers), {
            title: '用攻击力进行普通攻击；选择目标后执行', disabled: app.busy,
        }),
    );

    // 技能按钮
    for (const skill of unit.skills ?? []) {
        const usable = canUseSkill(unit, skill);
        const effects = skillEffectLabels(skill);
        // 只标当前规则真正使用的加值，旧存档里的文字“优势”不等于实际数值。
        const standardAim = /^(?:1?d20)\+\(Aim-100\)\/10(?:\+hitBonus)?$/.test(String(battle.ruleset?.hitFormula || '').replace(/\s+/g, ''));
        const aimModifier = (Number(skill.aim ?? 100) - 100) / 10;
        const aimLabel = standardAim && battle.ruleset?.hitMode !== 'chance'
            ? `命中${aimModifier >= 0 ? '+' : ''}${aimModifier}` : `Aim ${skill.aim ?? 100}`;
        const label = [
            skill.name,
            aimLabel,
            `威${skill.power}`,
            skill.cost ? `耗${skill.cost}` : '耗0',
            TARGET_LABEL[skill.target] ?? skill.target,
            effects,
        ]
            .filter(Boolean)
            .join(' · ');

        basicSkillRow.appendChild(
            button(
                label,
                () => {
                    selectSkill(app, battle, skill, helpers);
                },
                {
                    disabled: app.busy || !usable.usable,
                    title: usable.usable
                        ? [
                              skill.description || '',
                              `效果：${effects}`,
                              ...skillMechanicsText(skill, battle.ruleset),
                              `${aimLabel}；装备与状态另按当前判定公式结算`,
                              skill.advantageNote || '',
                              `消耗：${skill.cost || 0} 点`,
                          ]
                              .filter(Boolean)
                              .join('\n')
                        : usable.reason,
                },
            ),
        );
    }

    wrap.appendChild(basicSkillRow);
    if (pending) {
        const choices = el('div', { class: 'td-target-picker', role: 'group', 'aria-label': '选择技能目标' }, [
            el('b', {}, `「${pending.skillName}」选定目标`),
        ]);
        for (const target of battle.units.filter(target => pending.candidateIds.includes(target.id))) {
            const choice = button(`选择 ${target.name}`, () => executePending(app, battle, [target.id], helpers), {
                disabled: app.busy, title: `${target.name} · HP ${target.attributes?.HP?.current ?? 0}/${target.attributes?.HP?.max ?? 0}`,
            });
            choice.setAttribute('data-target-id', target.id);
            choices.appendChild(choice);
        }
        if (!pending.candidateIds.length) choices.appendChild(el('div', { class: 'notes' }, '已没有合法目标，请重新选择技能。'));
        wrap.appendChild(choices);
    }
    return wrap;
}

/**
 * 单体技能始终显式选目标（包括唯一目标）；群体、自身及随机技能直接交引擎结算。
 * @param {import('../app.js').AppController} app
 * @param {any} battle
 * @param {any} skill
 * @param {{rerender: () => void}} helpers
 */
async function selectSkill(app, battle, skill, helpers) {
    const unit = actionUnit(app, battle);
    if (!unit || app.busy || app.battle !== battle || battle.phase === 'finished') return;
    if (!app.isUserUnit(unit) && !(unit.side === 'ally' && app.settings.battle.aiControlsAllies === false)) return;
    const candidates = battle.targetCandidates(unit, skill);

    if (!candidates.length) {
        toast('这个技能当前没有可用目标', 'warning');
        return;
    }
    if (skill.target !== 'single') {
        pendingAction.delete(battle);
        const result = await (app.isUserUnit(unit) ? app.playPlayerTurn.bind(app) : app.act.bind(app))({ skillId: skill.id });
        if (!result?.ok) toast(result?.error || '行动未执行', 'warning');
        helpers.rerender();
        return;
    }
    pendingAction.set(battle, {
        unitId: unit.id,
        round: battle.round,
        turnIndex: battle.turnIndex,
        skillId: skill.id,
        skillName: skill.name,
        candidateIds: candidates.map((/** @type {any} */ c) => c.id),
    });
    helpers.rerender();
    toast(`请点击「${skill.name}」的目标`, 'info');
}

/**
 * 执行待选目标动作。
 * @param {import('../app.js').AppController} app
 * @param {any} battle
 * @param {string[]} targetIds
 * @param {{rerender: () => void}} helpers
 */
async function executePending(app, battle, targetIds, helpers) {
    const pending = getPendingAction(app, battle);
    if (!pending || app.busy || app.battle !== battle) return;
    if (targetIds.length !== 1 || !pending.candidateIds.includes(targetIds[0])) {
        toast('目标已失效，请重新选择', 'warning');
        helpers.rerender();
        return;
    }
    pendingAction.delete(battle);
    const result = await (app.isUserUnit(actionUnit(app, battle)) ? app.playPlayerTurn.bind(app) : app.act.bind(app))({
        skillId: pending.skillId, targetIds, action: pending.skillId ? 'skill' : 'attack',
    });
    if (!result?.ok) toast(result?.error || '行动未执行', 'warning');
    helpers.rerender();
}

/** 自动推进。 */
async function runAutoAdvance(app, helpers) {
    const result = await app.autoAdvance({ stopOnAlly: true });
    helpers.rerender();
    if (result.steps === 0) toast('轮到我方行动了', 'info');
}

/** 战斗日志。 */
function renderBattleLog(battle) {
    const body = el('div', { class: 'td-blog' });
    const records = [...battle.log, ...(battle.banterHistory ?? [])]
        .sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
    const entries = records.slice(-300);

    for (const entry of [...entries].reverse()) {
        body.appendChild(
            el('div', { class: `td-blog-line td-blog-${entry.type}` }, [
                el('span', { class: 'td-blog-time' }, formatTime(entry.at)),
                el('span', { class: 'td-blog-round' }, `R${entry.round}`),
                el('span', { class: 'td-blog-text' }, entry.text),
            ]),
        );
    }

    if (!entries.length) body.appendChild(el('div', { class: 'notes' }, '还没有结算记录。'));

    // 骰点明细：把最近几次命中的结构化数据摊开，方便复盘
    const detail = el('div', { class: 'td-blog-details' });
    const rolls = battle.log.filter((/** @type {any} */ l) => l.type === 'attack' && l.data?.hit).slice(-8).reverse();
    if (rolls.length) {
        detail.appendChild(el('div', { class: 'td-mini-label' }, '最近判定的骰点明细'));
        for (const entry of rolls) {
            const data = /** @type {any} */ (entry.data);
            detail.appendChild(
                el('div', { class: 'td-roll-detail' }, [
                    el('b', {}, data.skillName ?? '攻击'),
                    el('span', {}, `　${data.hit.expression}`),
                    el('span', { class: 'notes' }, `　${outcomeLabel(data.hit.outcome)}`),
                    data.damage ? el('span', { class: 'notes' }, `　${data.damage.calculation}`) : null,
                ]),
            );
        }
    }

    return el('div', { class: 'td-blog-wrap' }, [
        el('div', { class: 'td-blog-head' }, [
            el('b', {}, `战斗日志（${records.length} 条）`),
        ]),
        detail,
        body,
    ]);
}

/** 结果的中文名。 */
function outcomeLabel(/** @type {string} */ outcome) {
    return (
        {
            [OUTCOME.HIT]: '命中',
            [OUTCOME.CRIT]: '暴击',
            [OUTCOME.MISS]: '未命中',
            [OUTCOME.FUMBLE]: '大失败',
        }[outcome] ?? outcome
    );
}

/** 清掉待选动作（切换战斗时用）。 */
export function clearPendingAction(/** @type {object|undefined} */ battle) {
    if (battle && typeof battle === 'object') pendingAction.delete(battle);
    else pendingAction = new WeakMap();
}

export { clear, select };
