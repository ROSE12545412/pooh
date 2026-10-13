/**
 * 骰子动画 与 AI 决策 的测试。
 *
 * 这两块是「一个回合」的核心：
 *   骰子开始转 → 调 API 思考 → 骰子停下 → 本地结算
 *
 * 测试重点：
 *  - **几何正确**（正二十面体必须是 12 顶点 / 20 面 / 30 棱，否则画出来不是骰子）
 *  - **骰点提取正确**（要从战斗日志里挑对那一次判定）
 *  - **提示词的硬约束**（AI 不能替骰子决定成败 —— 这条错了整个设计就崩了）
 */

import { strict as assert } from 'node:assert';
import { readFileSync, statSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
    clearFaceCache,
    createDiceRoller,
    faceSrc,
    hasFaceAssets,
    pickMainRoll,
    preloadFaces,
} from '../src/ui/dice.js';
import {
    DECIDE_JSON_SCHEMA,
    DECIDE_MODE,
    DECIDE_MODE_LABEL,
    buildDecidePrompt,
    decideAction,
    renderBattleBrief,
} from '../src/llm/decider.js';
import { defaultSettings } from '../src/config.js';
import { normalizeCombatant, normalizePowerSystem } from '../src/core/schema.js';

/** 固定 DPR，避免不同环境下画布尺寸不一致。 */
globalThis.devicePixelRatio = 1;

/** 造一个假的 canvas 上下文，用来验证动画不崩。 */
function makeCanvasStub() {
    const calls = { fill: 0, stroke: 0, fillText: 0, strokeText: 0, clearRect: 0 };
    const noop = () => {};
    const ctx = {
        canvas: null,
        scale: noop,
        clearRect: () => calls.clearRect++,
        beginPath: noop,
        moveTo: noop,
        lineTo: noop,
        closePath: noop,
        fill: () => calls.fill++,
        fillRect: noop,
        drawImage: noop,
        translate: noop,
        stroke: () => calls.stroke++,
        save: noop,
        restore: noop,
        arc: noop,
        ellipse: noop,
        transform: noop,
        setTransform: noop,
        resetTransform: noop,
        fillText: () => calls.fillText++,
        strokeText: () => calls.strokeText++,
        strokeText: noop,
        createRadialGradient: () => ({ addColorStop: noop }),
        createLinearGradient: () => ({ addColorStop: noop }),
        measureText: () => ({ width: 10 }),
        // 这些是**属性**不是方法，少一个都可能让绘制路径行为不一致
        fillStyle: '',
        strokeStyle: '',
        lineWidth: 1,
        font: '',
        globalAlpha: 1,
        textAlign: 'start',
        textBaseline: 'alphabetic',
        shadowColor: '',
        shadowBlur: 0,
    };
    const canvas = {
        width: 0,
        height: 0,
        style: {},
        getContext: (type) => (type === '2d' ? ctx : null),
    };
    return { canvas, calls };
}

describe('createDiceRoller 动画流程', () => {
    it('roll → settle → 停在目标数字', async () => {
        const { canvas, calls } = makeCanvasStub();
        const frames = [];
        const roller = createDiceRoller(canvas, { size: 200, onFrame: (s, v) => frames.push([s, v]) });

        assert.equal(roller.isRolling, false, '初始不该在转');

        roller.roll();
        assert.equal(roller.isRolling, true, 'roll() 后应当处于转动状态');
        // 跑几帧
        for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 8));
        assert.ok(calls.clearRect > 0, '应当真的画了');

        roller.settle(17);
        // settle 需要若干帧完成 —— 轮询而不是赌固定帧数（帧调度受环境影响）
        for (let i = 0; i < 200 && !frames.some(([st]) => st === 'settled'); i++) {
            await new Promise((r) => setTimeout(r, 6));
        }

        assert.ok(frames.some(([s]) => s === 'rolling'), '应当报告过 rolling 状态');
        assert.ok(frames.some(([s]) => s === 'settled'), '应当报告过 settled 状态');
        assert.ok(calls.fillText > 0, '应当画过数字');

        roller.destroy();
    });

    it('settle 会把值夹到 1~20（防止引擎给出奇怪的值）', async () => {
        const { canvas } = makeCanvasStub();
        const frames = [];
        const roller = createDiceRoller(canvas, { size: 120, onFrame: (s, v) => frames.push([s, v]) });

        roller.settle(-5);
        for (let i = 0; i < 200 && !frames.some(([st]) => st === 'settled'); i++) {
            await new Promise((r) => setTimeout(r, 6));
        }
        const settled = frames.filter(([s]) => s === 'settled').pop();
        assert.ok(settled, '应当落到 settled');
        assert.equal(settled[1], 1, '负数应当被夹到 1');

        roller.destroy();
    });

    it('hide 能停掉动画（战斗结束后用）', async () => {
        const { canvas } = makeCanvasStub();
        const roller = createDiceRoller(canvas, { size: 120 });
        roller.roll();
        await new Promise((r) => setTimeout(r, 10));
        roller.hide();
        assert.equal(roller.isRolling, false, 'hide 后不该还在转');
        roller.destroy();
    });

    it('destroy 停掉 requestAnimationFrame 循环（不留后台任务）', async () => {
        const { canvas } = makeCanvasStub();
        const roller = createDiceRoller(canvas, { size: 120 });
        roller.roll();
        await new Promise((r) => setTimeout(r, 10));
        roller.destroy();
        assert.equal(roller.isRolling, false);
    });

    it('画布尺寸会按 devicePixelRatio 放大（高清屏不糊）', () => {
        const { canvas } = makeCanvasStub();
        createDiceRoller(canvas, { size: 200 });
        assert.ok(canvas.width >= 200, `画布内部宽度应当 ≥200，实际 ${canvas.width}`);
        assert.equal(canvas.style.width, '200px', 'CSS 尺寸应当是逻辑尺寸');
    });
});

describe('pickMainRoll 从战斗日志里取骰点', () => {
    const logs = [
        { i: 0, type: 'turn', text: '战斗开始' },
        {
            i: 1,
            type: 'roll',
            text: '先攻顺序：甲(18+2=20) → 乙(9+1=10)',
            data: { initiative: [{ name: '甲', roll: 18, total: 20 }, { name: '乙', roll: 9, total: 10 }] },
        },
        {
            i: 2,
            type: 'attack',
            text: '甲 命中 乙',
            data: { hit: { nat: 17, dieFaces: 20, total: 19, target: 12, outcome: 'hit' } },
        },
        { i: 3, type: 'attack', text: '乙 未命中 甲', data: { hit: { nat: 3, dieFaces: 20, total: 4, target: 15, outcome: 'miss' } } },
    ];

    it('取最近一次判定的骰点', () => {
        const roll = pickMainRoll(logs, 0);
        assert.equal(roll.nat, 3, '应当取最后一条 attack 的 nat');
        assert.equal(roll.outcome, 'miss');
    });

    it('只看 sinceIndex 之后的新日志', () => {
        const roll = pickMainRoll(logs, 3);
        assert.equal(roll.nat, 3, '应当只看到下标 3 的那条');

        const none = pickMainRoll(logs, 4);
        assert.equal(none, null, '没有新日志时返回 null');
    });

    it('本回合没有攻击时退到先攻掷骰', () => {
        const roll = pickMainRoll([logs[1]], 0);
        assert.equal(roll.nat, 18, '应当用先攻的 roll');
    });

    it('完全没有掷骰数据时返回 null（不是崩）', () => {
        assert.equal(pickMainRoll([{ i: 0, type: 'turn', text: 'x' }], 0), null);
        assert.equal(pickMainRoll([], 0), null);
        assert.equal(pickMainRoll(null, 0), null);
    });

    it('兼容扁平的 nat 数据（不一定包在 hit 里）', () => {
        const roll = pickMainRoll([{ i: 5, type: 'roll', text: 'x', data: { nat: 11, dieFaces: 20, total: 14, target: 10, outcome: 'hit' } }], 0);
        assert.equal(roll.nat, 11);
    });
});

describe('renderBattleBrief 战况简报', () => {
    function makeBattle() {
        const system = normalizePowerSystem({
            combatants: [
                normalizeCombatant({
                    name: '甲',
                    side: 'ally',
                    skills: [{ name: '斩击', power: 30, aim: 100, effects: [{ type: 'damage', power: 30, duration: 0 }] }],
                }),
                normalizeCombatant({ name: '乙', side: 'enemy' }),
            ],
        });
        return { system };
    }

    it('列出所有单位与他们的状态', () => {
        const { system } = makeBattle();
        const battle = {
            round: 1,
            units: system.combatants,
            currentUnit: system.combatants[0],
            log: [],
        };
        const brief = renderBattleBrief(battle);
        assert.ok(brief.includes('甲'), '应当有甲');
        assert.ok(brief.includes('乙'), '应当有乙');
        assert.ok(brief.includes('我方'), '应当标出阵营');
        assert.ok(brief.includes('敌方'));
        assert.ok(brief.includes('第 1 回合'));
    });

    it('列出当前行动者的可用技能（含 id，供模型引用）', () => {
        const { system } = makeBattle();
        const battle = { round: 1, units: system.combatants, currentUnit: system.combatants[0], log: [] };
        const brief = renderBattleBrief(battle);
        assert.ok(brief.includes('可用技能'), '应当列出技能');
        assert.ok(brief.includes('id='), '应当给技能 id（模型要原样返回）');
        assert.ok(brief.includes('斩击'));
    });

    it('没有技能时明说只能普攻', () => {
        const { system } = makeBattle();
        const battle = { round: 1, units: system.combatants, currentUnit: system.combatants[1], log: [] };
        const brief = renderBattleBrief(battle);
        assert.ok(brief.includes('普通攻击'));
    });

    it('带上最近发生的几条（让模型避免重复描写）', () => {
        const { system } = makeBattle();
        const battle = {
            round: 2,
            units: system.combatants,
            currentUnit: system.combatants[0],
            log: [{ text: '甲 挥剑砍中乙' }, { text: '乙 后退' }],
        };
        const brief = renderBattleBrief(battle);
        assert.ok(brief.includes('最近发生'));
        assert.ok(brief.includes('挥剑砍中'));
    });

    it('空战斗不崩', () => {
        assert.doesNotThrow(() => renderBattleBrief(null));
        assert.doesNotThrow(() => renderBattleBrief({}));
    });
});

describe('buildDecidePrompt 提示词硬约束', () => {
    /**
     * 这里最关键的一条：**AI 不能决定成败**。
     * 如果模型能写「一剑刺穿心脏造成 240 伤害」，而引擎算出的是「未命中」，
     * 整个「掷骰决定结果」的设计就崩了 —— 用户会看到自相矛盾的文本。
     */

    it('明确禁止写出结果（命中/伤害/闪避）', () => {
        const { system } = buildDecidePrompt({ brief: 'x', mode: DECIDE_MODE.FLAVOR });
        assert.ok(system.includes('不要决定成败'), '必须声明不决定成败');
        assert.ok(system.includes('命中'), '应当点名禁止写「命中」');
        assert.ok(system.includes('伤害'), '应当点名禁止写伤害');
        assert.ok(system.includes('大失败') || system.includes('骰子决定'), '应当说明成败由骰子决定');
    });

    it('给出「对/错」的对照例子（比抽象规则有效）', () => {
        const { system } = buildDecidePrompt({ brief: 'x', mode: DECIDE_MODE.FLAVOR });
        assert.ok(system.includes('剑光如练'), '应当给出正例');
        assert.ok(system.includes('错'), '应当给出反例');
    });

    it('禁止编造技能与改数值', () => {
        const { system } = buildDecidePrompt({ brief: 'x', mode: DECIDE_MODE.AUTO });
        assert.ok(system.includes('不要编造技能'));
        assert.ok(system.includes('不要改数值'));
    });

    it('flavor 模式说明「技能与目标由玩家选定」', () => {
        const { user } = buildDecidePrompt({ brief: 'x', mode: DECIDE_MODE.FLAVOR });
        assert.ok(user.includes('玩家'), '应当说明玩家已选定');
    });

    it('auto 模式说明「你来决定怎么打」', () => {
        const { user } = buildDecidePrompt({ brief: 'x', mode: DECIDE_MODE.AUTO });
        assert.ok(user.includes('你来决定'), '应当说明由模型决定');
    });

    it('把战况简报放进 user', () => {
        const { user } = buildDecidePrompt({ brief: '简报内容 ABC', mode: DECIDE_MODE.FLAVOR });
        assert.ok(user.includes('简报内容 ABC'));
    });

    it('要求贴合角色性格、避免重复', () => {
        const { system } = buildDecidePrompt({ brief: 'x', mode: DECIDE_MODE.FLAVOR });
        assert.ok(system.includes('性格'), '应当要求贴合性格');
        assert.ok(system.includes('重复'), '应当要求避免重复上一回合');
    });
});

describe('DECIDE_JSON_SCHEMA 只让模型决定「怎么打」', () => {
    it('字段只有技能、目标、动作类型、描述 —— 没有伤害或血量', () => {
        const props = Object.keys(DECIDE_JSON_SCHEMA.value.properties);
        assert.deepEqual(props.sort(), ['action', 'flavor', 'skillId', 'targetId', 'targetName'].sort());
        for (const forbidden of ['damage', 'hp', 'hit', 'success', 'outcome']) {
            assert.ok(!props.includes(forbidden), `不该让模型决定 ${forbidden}`);
        }
    });

    it('flavor 字段的说明里明确禁止写结果', () => {
        const desc = DECIDE_JSON_SCHEMA.value.properties.flavor.description;
        assert.ok(desc.includes('不要写结果') || desc.includes('结果由骰子决定'), '必须禁止写结果');
    });

    it('每个模式都有中文名（UI 要用）', () => {
        for (const mode of Object.values(DECIDE_MODE)) {
            assert.ok(DECIDE_MODE_LABEL[mode], `模式 ${mode} 缺少中文名`);
        }
    });
});

describe('decideAction 降级行为', () => {
    it('模式 off 时不发起任何请求', async () => {
        const settings = defaultSettings();
        settings.battle.decideMode = DECIDE_MODE.OFF;
        const battle = {
            round: 1,
            units: [{ id: 'u1', name: '甲', side: 'ally', skills: [], attributes: {} }],
            currentUnit: { id: 'u1', name: '甲', side: 'ally', skills: [], attributes: {} },
            log: [],
        };
        const result = await decideAction(null, settings, battle, {});
        assert.equal(result.ok, true, 'off 模式应当直接成功');
        assert.equal(result.decision.flavor, '', 'off 模式不该有描述');
    });

    it('没有当前行动单位时给出可读错误', async () => {
        const result = await decideAction(null, defaultSettings(), { round: 1, units: [], currentUnit: null, log: [] }, {});
        assert.equal(result.ok, false);
        assert.match(result.error, /没有行动单位/);
    });

    it('已中止的信号立即返回', async () => {
        const controller = new AbortController();
        controller.abort();
        const unit = { id: 'u1', name: '甲', side: 'ally', skills: [], attributes: {} };
        const result = await decideAction(null, defaultSettings(), { round: 1, units: [unit], currentUnit: unit, log: [] }, {
            signal: controller.signal,
        });
        assert.equal(result.aborted, true);
    });

    it('请求失败时返回结构化失败（不抛异常）', async () => {
        const settings = defaultSettings();
        settings.p2.channel.mode = 'custom';
        settings.p2.channel.apiUrl = 'https://127.0.0.1:1/v1';
        settings.p2.channel.model = 'none';
        settings.p2.channel.timeout = 1;
        settings.p2.channel.retries = 0;

        const unit = { id: 'u1', name: '甲', side: 'ally', skills: [], attributes: {} };
        const result = await decideAction(null, settings, { round: 1, units: [unit], currentUnit: unit, log: [] }, {});
        assert.equal(typeof result.ok, 'boolean', '应当返回结构化结果而不是抛异常');
        assert.ok(Array.isArray(result.logs));
    });
});


describe('骰面素材（不再手绘）', () => {
    /**
     * 用户的原话：**「你画的那个压根看不出来是什么，有没有现成的 1d20 骰子素材，你别手绘了」**。
     *
     * 我先后手绘过三版（金色实心 → 金属色阶 → 珍珠白半透明），全部失败。
     * 现在改用 20 张成品渲染图，这里锁住素材方案的契约。
     */

    it('faceSrc 把 1~20 映射成正确的文件名（含补零）', () => {
        assert.ok(faceSrc(1).endsWith('d20_01.png'), faceSrc(1));
        assert.ok(faceSrc(7).endsWith('d20_07.png'), faceSrc(7));
        assert.ok(faceSrc(20).endsWith('d20_20.png'), faceSrc(20));
    });

    it('越界的值被夹到 1~20（引擎给出怪值也不能崩）', () => {
        assert.ok(faceSrc(0).endsWith('d20_01.png'));
        assert.ok(faceSrc(-5).endsWith('d20_01.png'));
        assert.ok(faceSrc(999).endsWith('d20_20.png'));
        assert.ok(faceSrc(NaN).endsWith('d20_01.png'));
    });

    it('20 张素材文件都真的存在（不是只写了路径）', () => {
        const dir = new URL('../assets/d20/', import.meta.url);
        for (let v = 1; v <= 20; v++) {
            const name = faceSrc(v).split('/').pop();
            const stat = statSync(new URL(name, dir), { throwIfNoEntry: false });
            assert.ok(stat && stat.size > 1000, `缺少素材或文件过小：${name}`);
        }
    });

    it('附带授权文件（第三方素材必须留着）', () => {
        const dir = new URL('../assets/d20/', import.meta.url);
        assert.ok(statSync(new URL('LICENSE.txt', dir), { throwIfNoEntry: false }), '缺 LICENSE.txt');
        assert.ok(statSync(new URL('README.txt', dir), { throwIfNoEntry: false }), '缺 README.txt');
    });

    it('没有素材时也画得出东西（不留白）', () => {
        // 留白是最难排查的失败方式：用户只会说「什么都没有」。
        clearFaceCache();
        const { canvas, calls } = makeCanvasStub();
        const roller = createDiceRoller(canvas, { size: 120 });
        roller.show(13);
        assert.ok(calls.fillText > 0, '没有素材时应当画占位数字');
        roller.destroy();
    });

    it('素材加载失败时不抛异常（优雅降级）', async () => {
        // 桩环境里没有 Image，preloadFaces 应当全部 resolve(null)
        clearFaceCache();
        const map = await preloadFaces();
        assert.ok(map instanceof Map, '应当返回 Map');
        assert.equal(hasFaceAssets(), false, '桩环境里不该认为素材可用');
        clearFaceCache();
    });

    it('滚动时轮播、落定时交叉淡入（图片方案的核心）', () => {
        const src = readFileSync(new URL('../src/ui/dice.js', import.meta.url), 'utf8');
        assert.ok(src.includes('cycling'), '滚动应当轮播面图');
        assert.ok(src.includes('交叉淡入'), '应当有交叉淡入');
        assert.ok(src.includes('drawImage'), '应当用 drawImage 画素材');
        // 不能再有手绘几何
        assert.ok(!src.includes('VERTICES'), '不该再有手绘顶点表');
        assert.ok(!src.includes('PHI'), '不该再有正二十面体几何');
    });
});


describe('BG3 检定面板（骰子外面的金框那一套）', () => {
    const frameSource = readFileSync(new URL('../src/ui/frame.js', import.meta.url), 'utf8');

    it('用 SVG 画卷草纹（CSS 画不出细长曲线）', () => {
        assert.ok(frameSource.includes('createElementNS'), '应当用 SVG 命名空间建节点');
        assert.ok(frameSource.includes('filigreeCornerPath'), '应当有卷草纹路径');
        assert.ok(frameSource.includes('C '), '路径应当用三次贝塞尔（曲线）');
    });

    it('四角对称：只画一个角，其余旋转复用', () => {
        assert.ok(frameSource.includes('scale(-1,1)'), '应当有镜像复用');
        assert.ok(frameSource.includes('scale(-1,-1)'), '应当有对角复用');
        const corners = (frameSource.match(/transform: /g) || []).length;
        assert.ok(corners >= 4, `应当有 4 个角变换，实际 ${corners}`);
    });

    it('金色描边用渐变（不是纯色，才有金属感）', () => {
        assert.ok(frameSource.includes('linearGradient'), '应当有金色渐变');
        assert.ok(frameSource.includes('td-bg3-gold'), '应当有渐变 id');
    });

    it('面板结构齐全：角色名 / 检定名 / 难度 / 骰子 / 点击提示 / 修正值', () => {
        for (const cls of ['td-bg3-actor', 'td-bg3-check', 'td-bg3-dc-value', 'td-bg3-clickable', 'td-bg3-mod-diamond']) {
            assert.ok(frameSource.includes(cls), `缺少 ${cls}`);
        }
    });

    it('修正值用菱形镶框（截图里是菱形）', () => {
        assert.ok(frameSource.includes('td-bg3-mod-diamond'), '应当有菱形框');
    });

    it('修正值带正负号', () => {
        assert.ok(frameSource.includes("opts.modifier >= 0 ? '+' : ''"), '正数应当带 + 号');
    });
});

describe('骰子转速（用户实测反馈「转的太快了，慢一点」）', () => {
    const src = readFileSync(new URL('../src/ui/dice.js', import.meta.url), 'utf8');

    it('默认换面间隔 ≥ 120ms（65ms 时快到看不清数字）', () => {
        const m = src.match(/const DEFAULT_CYCLE_MS = (\d+)/);
        assert.ok(m, '应当有 DEFAULT_CYCLE_MS 常量');
        const ms = Number(m[1]);
        assert.ok(ms >= 120, `默认间隔 ${ms}ms 太快了，数字会看不清`);
    });

    it('roll() 支持调用方覆盖间隔（设置里可调）', () => {
        assert.ok(/roll\(o = \{\}\)/.test(src), 'roll 应当接受参数');
        assert.ok(src.includes('cycleMs'), '应当支持 cycleMs');
    });

    it('转速有「抛掷手感」：起手与收尾更慢', () => {
        assert.ok(/Math\.sin/.test(src) && src.includes('speed'), '应当有速度包络');
    });

    it('间隔有下限保护（不会快到闪成一片）', () => {
        assert.ok(src.includes('Math.max(60, cycleMs'), '间隔应当有下限');
        assert.ok(src.includes('Math.max(40, Number(o.cycleMs)'), '入参应当被夹住');
    });

    it('设置里有转速输入框', () => {
        const settings = readFileSync(new URL('../src/ui/settings.js', import.meta.url), 'utf8');
        assert.ok(settings.includes('diceCycleMs'), '设置页应当能调转速');
    });

    it('app 掷骰时把设置传进 roll()', () => {
        const app = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
        assert.ok(app.includes('roll({ cycleMs: this.settings.battle.diceCycleMs })'), '应当传设置值');
    });
});
