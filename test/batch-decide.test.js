/**
 * 多人战「批量决策」的测试。
 *
 * 核心动机：5 个敌人原本要 5 次 API 调用，一轮下来又慢又费。
 * 合并成一次之后，顺便还能让模型**考虑彼此配合**（先控住谁、再集火谁）——
 * 这是逐单位分别决策做不到的。
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
    DECIDE_BATCH_JSON_SCHEMA,
    buildBatchDecidePrompt,
    decideActionsBatch,
    renderBatchBrief,
} from '../src/llm/decider.js';
import { defaultSettings } from '../src/config.js';
import { normalizeCombatant, normalizePowerSystem } from '../src/core/schema.js';

/** 造一场多单位战斗。 */
function makeBattle(enemyCount = 3) {
    const combatants = [
        normalizeCombatant({
            name: '我方甲',
            side: 'ally',
            skills: [{ name: '斩击', power: 30, aim: 100, effects: [{ type: 'damage', power: 30, duration: 0 }] }],
        }),
    ];
    for (let i = 1; i <= enemyCount; i++) {
        combatants.push(
            normalizeCombatant({
                name: `敌${i}`,
                side: 'enemy',
                skills: [{ name: '爪击', power: 20, aim: 100, effects: [{ type: 'damage', power: 20, duration: 0 }] }],
            }),
        );
    }
    const system = normalizePowerSystem({ combatants });
    return {
        id: 'battle-test',
        round: 1,
        units: system.combatants,
        currentUnit: system.combatants.find((u) => u.side === 'enemy'),
        log: [{ text: '我方甲 挥剑砍中敌1' }],
    };
}

describe('renderBatchBrief 多单位简报', () => {
    const battle = makeBattle(3);
    const enemies = battle.units.filter((u) => u.side === 'enemy');

    it('列出全体单位现状', () => {
        const brief = renderBatchBrief(battle, enemies);
        assert.ok(brief.includes('我方甲'), '应当有我方');
        assert.ok(brief.includes('敌1') && brief.includes('敌3'), '应当有全部敌人');
        assert.ok(brief.includes('HP'), '应当有血量');
    });

    it('为每个待决策单位单独列出技能（模型要给对技能）', () => {
        const brief = renderBatchBrief(battle, enemies);
        for (const e of enemies) {
            assert.ok(brief.includes(`## ${e.name}（需要你决策）`), `应当为 ${e.name} 单列一节`);
        }
        assert.ok(brief.includes('id='), '应当给技能 id');
        assert.ok(brief.includes('爪击'), '应当列出技能名');
    });

    it('带上最近发生（避免重复描写）', () => {
        const brief = renderBatchBrief(battle, enemies);
        assert.ok(brief.includes('最近发生'));
        assert.ok(brief.includes('挥剑砍中'));
    });

    it('没有技能的单位明说只能普攻', () => {
        const bare = normalizePowerSystem({
            combatants: [
                normalizeCombatant({ name: '甲', side: 'ally', skills: [] }),
                normalizeCombatant({ name: '乙', side: 'enemy', skills: [] }),
            ],
        });
        const battle2 = { round: 1, units: bare.combatants, currentUnit: bare.combatants[1], log: [] };
        const brief = renderBatchBrief(battle2, [bare.combatants[1]]);
        assert.ok(brief.includes('只能普通攻击'));
    });

    it('空输入不崩', () => {
        assert.doesNotThrow(() => renderBatchBrief(null, []));
        assert.doesNotThrow(() => renderBatchBrief({}, []));
        assert.doesNotThrow(() => renderBatchBrief({ units: [] }, [null]));
    });
});

describe('buildBatchDecidePrompt 批量提示词', () => {
    const units = ['敌1', '敌2', '敌3'];

    it('要求为每个单位各出一条决策', () => {
        const { user } = buildBatchDecidePrompt({ brief: 'x', unitNames: units });
        for (const n of units) assert.ok(user.includes(n), `应当列出 ${n}`);
        assert.ok(user.includes('每一个'), '应当强调每个单位都要有');
    });

    it('明确禁止决定成败（与单单位版本同样严格）', () => {
        const { system } = buildBatchDecidePrompt({ brief: 'x', unitNames: units });
        assert.ok(system.includes('不要决定成败'), '必须声明不决定成败');
        assert.ok(system.includes('剑光如练'), '应当给出正例');
        assert.ok(system.includes('错'), '应当给出反例');
    });

    it('鼓励配合（这是批量决策相对逐单位的最大优势）', () => {
        const { system } = buildBatchDecidePrompt({ brief: 'x', unitNames: units });
        assert.ok(system.includes('配合'), '应当鼓励配合');
        assert.ok(system.includes('集火') || system.includes('控制'), '应当给出配合的例子');
    });

    it('要求技能只能用该单位自己的', () => {
        const { system } = buildBatchDecidePrompt({ brief: 'x', unitNames: units });
        assert.ok(system.includes('只能用简报里给出的'), '必须限制技能来源');
    });

    it('要求名字原样返回（否则对不回单位）', () => {
        const { system } = buildBatchDecidePrompt({ brief: 'x', unitNames: units });
        assert.ok(system.includes('完全一致'), '必须要求名字一致');
    });

    it('把简报放进 user', () => {
        const { user } = buildBatchDecidePrompt({ brief: '简报 ABC', unitNames: units });
        assert.ok(user.includes('简报 ABC'));
    });
});

describe('DECIDE_BATCH_JSON_SCHEMA', () => {
    it('是「每个单位一条」的数组结构', () => {
        const items = DECIDE_BATCH_JSON_SCHEMA.value.properties.actions;
        assert.equal(items.type, 'array');
        assert.ok(items.items.properties.unitName, '每条必须带单位名');
        assert.ok(items.items.properties.skillId);
        assert.ok(items.items.properties.targetName);
        assert.ok(items.items.properties.flavor);
    });

    it('字段里没有伤害或血量（成败由骰子决定）', () => {
        const props = Object.keys(DECIDE_BATCH_JSON_SCHEMA.value.properties.actions.items.properties);
        for (const forbidden of ['damage', 'hp', 'hit', 'success', 'outcome']) {
            assert.ok(!props.includes(forbidden), `不该让模型决定 ${forbidden}`);
        }
    });

    it('flavor 说明里禁止写结果', () => {
        const desc = DECIDE_BATCH_JSON_SCHEMA.value.properties.actions.items.properties.flavor.description;
        assert.ok(desc.includes('不要写结果') || desc.includes('结果由骰子决定'), '必须禁止写结果');
    });
});

describe('decideActionsBatch 降级与边界', () => {
    it('空列表直接返回空决策（不调 API）', async () => {
        const result = await decideActionsBatch(null, defaultSettings(), makeBattle(1), [], {});
        assert.equal(result.ok, true);
        assert.deepEqual(result.decisions, {});
    });

    it('只有 1 个单位时退到单单位路径', async () => {
        const battle = makeBattle(1);
        const enemy = battle.units.find((u) => u.side === 'enemy');
        // 通道不可用 → 单单位路径会失败，但应当是「结构化失败」而不是崩
        const settings = defaultSettings();
        settings.p2.channel.mode = 'custom';
        settings.p2.channel.apiUrl = 'https://127.0.0.1:1/v1';
        settings.p2.channel.model = 'none';
        settings.p2.channel.timeout = 1;
        settings.p2.channel.retries = 0;

        const result = await decideActionsBatch(null, settings, { ...battle, currentUnit: enemy }, [enemy], {});
        assert.equal(typeof result.ok, 'boolean', '应当返回结构化结果而不是抛异常');
        assert.ok(Array.isArray(result.logs));
    });

    it('已中止的信号立即返回', async () => {
        const controller = new AbortController();
        controller.abort();
        const battle = makeBattle(3);
        const enemies = battle.units.filter((u) => u.side === 'enemy');
        const result = await decideActionsBatch(null, defaultSettings(), battle, enemies, {
            signal: controller.signal,
        });
        assert.equal(result.aborted, true);
    });

    it('阵亡单位不参与决策', async () => {
        const battle = makeBattle(3);
        const enemies = battle.units.filter((u) => u.side === 'enemy');
        enemies[0].alive = false;
        const alive = enemies.filter((u) => u.alive);
        assert.equal(alive.length, 2);
        // 只传存活的两个，且通道不可用 → 返回失败但不应包含已阵亡单位
        const result = await decideActionsBatch(null, defaultSettings(), battle, alive, {});
        assert.equal(typeof result.ok, 'boolean');
    });

    it('请求失败时返回结构化失败（不抛异常）', async () => {
        const settings = defaultSettings();
        settings.p2.channel.mode = 'custom';
        settings.p2.channel.apiUrl = 'https://127.0.0.1:1/v1';
        settings.p2.channel.model = 'none';
        settings.p2.channel.timeout = 1;
        settings.p2.channel.retries = 0;

        const battle = makeBattle(3);
        const enemies = battle.units.filter((u) => u.side === 'enemy');
        const result = await decideActionsBatch(null, settings, battle, enemies, {});
        assert.equal(result.ok, false, '连不上应当失败');
        assert.ok(result.error, '应当给出错误原因');
    });
});

describe('配置默认值', () => {
    it('批量决策默认开启（多人战的省调用优化）', () => {
        assert.equal(defaultSettings().battle.batchDecisions, true);
    });

    it('敌方 AI 决策默认开启', () => {
        assert.equal(defaultSettings().battle.decideForEnemies, true);
    });
});


describe('批量解析的健壮性（用户报「想好 0 个单位」）', () => {
    const source = readFileSync(new URL('../src/llm/decider.js', import.meta.url), 'utf8');

    it('不只用 parseJsonLoose —— 还从文本里抠平衡 JSON', () => {
        // 踩过的坑：模型多写一句「好的，这是我的决策：」就会整批解析失败
        assert.ok(source.includes('extractBalancedCandidates'), '应当用平衡提取器兜底');
    });

    it('模型原始返回会记进日志（否则无法排查）', () => {
        assert.ok(source.includes('模型原始返回'), '解析失败时必须打印原始返回');
    });

    it('解析失败时报告 parseFailed，让调用方能用本地规则兜底', () => {
        assert.ok(source.includes('parseFailed: true'), '应当报告解析失败');
    });

    it('接受多种返回形状（裸数组 / {actions} / 单个单位平铺）', () => {
        assert.ok(source.includes('Array.isArray(v)'), '应当接受裸数组');
        assert.ok(source.includes('v?.actions'), '应当接受 {actions:[...]}');
        assert.ok(source.includes('v?.unitName'), '应当接受单个单位平铺');
    });
});

describe('本地规则兜底（解析失败也不能让单位白过一回合）', () => {
    const appSource = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');

    it('planRound 会用 autoChooseAction 补上模型没给到的单位', () => {
        assert.ok(appSource.includes('autoChooseAction(battle, { forUnit: u })'), '应当为缺失单位补本地规则');
        assert.ok(appSource.includes('fromLocalRule'), '应当标记这是本地规则的决策');
    });

    it('autoChooseAction 支持指定单位', () => {
        const engine = readFileSync(new URL('../src/combat/engine.js', import.meta.url), 'utf8');
        assert.ok(engine.includes('opts.forUnit ?? battle.currentUnit'), '必须支持 forUnit');
    });

    it('兜底时会明确告诉用户有几个单位用了本地规则', () => {
        assert.ok(appSource.includes('其中') && appSource.includes('改用本地规则'), '应当在日志里说明');
        assert.ok(appSource.includes('localsFilled'), '应当统计数量');
    });
});

describe('自动推进的停止条件', () => {
    const appSource = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');

    it('停在「玩家单位」而不是「我方单位」', () => {
        // 队友也是我方 —— 按阵营停的话每个队友回合都会停，用户要一直点
        assert.ok(appSource.includes('this.isUserUnit(unit)'), '停止条件必须基于 isUserUnit');
        assert.ok(
            /stopOnAlly = opts\.stopOnAlly === true/.test(appSource),
            '旧的按阵营停必须改成「显式传 true 才生效」',
        );
    });
});

describe('确认弹窗不依赖宿主 API', () => {
    const domSource = readFileSync(new URL('../src/ui/dom.js', import.meta.url), 'utf8');

    it('不再用 window.confirm（TauriTavern 里可能被禁用）', () => {
        assert.ok(!/return window\.confirm\(/.test(domSource), '不该依赖 window.confirm');
    });

    it('不再用 callGenericPopup（不保证存在）', () => {
        assert.ok(!domSource.includes('callGenericPopup('), '不该依赖 callGenericPopup');
    });

    it('用自己的弹窗，且关闭时也算取消（否则 Promise 永不兑现）', () => {
        assert.ok(domSource.includes('openModal({'), '应当用插件自己的弹窗');
        assert.ok(domSource.includes('MutationObserver'), '应当监听弹窗关闭以兑现 Promise');
    });
});
