/**
 * 「哪个单位是玩家操控的」+ 玩家信息注入的测试。
 *
 * ## 为什么这块要单独测
 *
 * 用户提了一个很关键的问题：**「你不能把淇直接指定成 user，如果有不叫淇的 user 呢？」**
 *
 * 插件要适配任何一张卡，所以**绝不能**把某个具体角色名写死。
 * 正确做法是分三层：
 *  ① 提示词把「玩家是谁」**运行时告诉模型**（来自酒馆 persona，不是猜的）
 *  ② 模型在条目上打【玩家】标记
 *  ③ 标记丢了就用 persona 名字 / 用户补充说明兜底
 * 三层都不中时**不猜** —— 猜错会导致操作权错位（点技能却在指挥敌人）。
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { buildSceneRequest } from '../src/llm/scene-prompt.js';
import { parseSituationReport, resolveUserUnit } from '../src/llm/report-parser.js';

describe('代码里不得硬编码任何具体角色名', () => {
    it('scene-prompt.js 与 report-parser.js 的**有效代码**里没有角色名', () => {
        // 注释里出现示例名字是可以的（那是给人看的），
        // 但代码里不能有 —— 否则换一张卡就废了。
        for (const file of ['../src/llm/scene-prompt.js', '../src/llm/report-parser.js', '../src/app.js']) {
            const source = readFileSync(new URL(file, import.meta.url), 'utf8');
            // 剥掉注释与字符串里的示例后，检查有没有「淇」这类具体名字出现在逻辑里
            const noBlockComments = source.replace(/\/\*[\s\S]*?\*\//g, '');
            const codeOnly = noBlockComments
                .split('\n')
                .filter((l) => !/^\s*(\/\/|\*)/.test(l))
                .join('\n');
            assert.ok(!codeOnly.includes('淇'), `${file} 的代码里不该出现「淇」`);
            assert.ok(!codeOnly.includes('保罗·格雷拉特'), `${file} 的代码里不该出现具体角色名`);
        }
    });
});

describe('buildSceneRequest 运行时注入「玩家是谁」', () => {
    it('把 persona 名字写进提示词，并要求标记打在它上面', () => {
        const text = buildSceneRequest({ userName: '小明', characterName: '李长风' });
        assert.ok(text.includes('小明'), '必须写明 persona 名字');
        assert.ok(text.includes('【玩家】标记请打在这个角色的条目上'), '必须指明标记打哪');
    });

    it('persona 与卡主角不同名时，给出「可能扮演主角」的第二种情形', () => {
        const text = buildSceneRequest({ userName: '小明', characterName: '李长风' });
        assert.ok(text.includes('李长风'), '应当提到卡主角');
        assert.ok(text.includes('如果玩家扮演的就是主角本人'), '应当说明这种情形怎么打标记');
    });

    it('persona 与卡主角同名时不重复啰嗦', () => {
        const text = buildSceneRequest({ userName: '李长风', characterName: '李长风' });
        const hits = text.split('李长风').length - 1;
        assert.ok(hits <= 2, `同名时不该反复提同一个名字，实际出现 ${hits} 次`);
    });

    it('完全没有玩家信息时，要求模型按剧情判断而不是瞎猜', () => {
        const text = buildSceneRequest({});
        assert.ok(text.includes('没能自动读到'), '应当说明没读到玩家信息');
        assert.ok(text.includes('根据剧情判断'), '应当要求按剧情判断');
    });

    it('明确禁止凭角色名猜（防转生/改名/伪装的情形）', () => {
        const text = buildSceneRequest({ userName: '小明' });
        assert.ok(text.includes('不要凭角色名去猜'), '必须禁止硬猜');
        assert.ok(text.includes('宁可不打'), '应当说明宁可漏标也不要错标');
    });

    it('用户还可能以别的名字出现时，会列出来', () => {
        const text = buildSceneRequest({ userName: '小明', extraNames: ['阿明', '明哥'] });
        assert.ok(text.includes('阿明') && text.includes('明哥'), '应当列出额外身份');
    });

    it('没有 {{{{USER_NOTE}}}} 占位的自定义模板也能带上玩家说明', () => {
        const text = buildSceneRequest({ template: '写一份战斗场景\n{{SITUATION}}', userName: '小明', situation: '切磋' });
        assert.ok(text.includes('小明'), '玩家说明应当被追加');
        assert.ok(text.includes('切磋'), '补充要求也要在');
    });

    it('内置模板里不再残留任何占位符', () => {
        for (const opts of [{}, { userName: '小明' }, { situation: 'x' }, { userName: '小明', situation: 'x' }]) {
            const text = buildSceneRequest(opts);
            assert.ok(!text.includes('{{'), `不该残留占位符，实际还有：${text.match(/\{\{[^}]*\}\}/)?.[0]}`);
        }
    });
});

describe('resolveUserUnit 三层兜底', () => {
    function sceneWith(markerOn) {
        const base = `## 参战双方
### 我方
${markerOn ? '**李长风【玩家】**' : '**李长风**'}（剑修）
- 血量：满状态
**苏婉**（护卫）
- 血量：满状态
### 敌方
**血魔**（魔修）
- 血量：满状态`;
        return parseSituationReport(base).system.combatants;
    }

    it('① 优先用模型打的标记（最可靠 —— 它读过剧情）', () => {
        const r = resolveUserUnit(sceneWith(true), { userName: '完全对不上的名字' });
        assert.equal(r.unit?.name, '李长风');
        assert.equal(r.via, 'marker', '有标记时应当以标记为准');
    });

    it('② 没标记时用 persona 名字匹配', () => {
        const r = resolveUserUnit(sceneWith(false), { userName: '李长风' });
        assert.equal(r.unit?.name, '李长风');
        assert.equal(r.via, 'persona-name');
    });

    it('② 支持名字的包含写法（「淇」能匹配「淇·格雷拉特」）', () => {
        const units = parseSituationReport(`## 参战双方
### 我方
**淇·格雷拉特**（幼童）
- 血量：满状态
### 敌方
**敌**（剑士）
- 血量：满状态`).system.combatants;
        const r = resolveUserUnit(units, { userName: '淇' });
        assert.equal(r.unit?.name, '淇·格雷拉特', '应当能匹配上');
    });

    it('③ 都匹配不上时，用用户补充说明里提到的名字', () => {
        const r = resolveUserUnit(sceneWith(false), { userName: '小明', situationText: '只算李长风单挑血魔' });
        assert.equal(r.unit?.name, '李长风');
        assert.equal(r.via, 'situation-mention');
    });

    it('三层都不中时**不猜**（猜错会让操作权错位）', () => {
        const r = resolveUserUnit(sceneWith(false), { userName: '小明' });
        assert.equal(r.unit, null, '不该瞎指一个');
        assert.equal(r.via, '');
    });

    it('模型打了多个标记时取第一个，并标记为「有歧义」', () => {
        const units = parseSituationReport(`## 参战双方
### 我方
**甲【玩家】**（剑客）
- 血量：满状态
**乙【玩家】**（法师）
- 血量：满状态
### 敌方
**丙**（妖修）
- 血量：满状态`).system.combatants;
        const r = resolveUserUnit(units, {});
        assert.equal(r.unit?.name, '甲', '取第一个');
        assert.equal(r.via, 'marker-ambiguous', '要让调用方能提示用户');
    });

    it('我方只有一个人时，没标记也算它吗？—— 不，仍然要凭依据', () => {
        const units = parseSituationReport(`## 参战双方
### 我方
**某人**（剑客）
- 血量：满状态
### 敌方
**敌**（妖修）
- 血量：满状态`).system.combatants;
        // 只有一个我方单位确实很可能就是玩家，但「很可能是」不等于「确定」——
        // 保持不猜，把决定权留给用户，避免在多人卡上养成错误习惯
        const r = resolveUserUnit(units, {});
        assert.equal(r.unit, null);
    });

    it('空输入不崩', () => {
        assert.doesNotThrow(() => resolveUserUnit([], {}));
        assert.doesNotThrow(() => resolveUserUnit(null, {}));
        assert.doesNotThrow(() => resolveUserUnit([null, undefined], {}));
        assert.equal(resolveUserUnit(null, {}).unit, null);
    });

    it('单个人的 persona 名字不会误伤别人（要求长度 ≥2）', () => {
        const units = parseSituationReport(`## 参战双方
### 我方
**甲某**（剑客）
- 血量：满状态
### 敌方
**乙**（妖修）
- 血量：满状态`).system.combatants;
        // persona 是单字「乙」—— 两字以上的名字才做子串匹配，避免「乙」命中一堆人
        const r = resolveUserUnit(units, { userName: '乙' });
        assert.equal(r.unit?.name, '乙', '完整相等仍然要匹配上');
        assert.equal(r.via, 'persona-name');
    });
});

describe('解析器对新格式的字段支持', () => {
    it('血量与魔量都按档位换算（不再固定满值）', () => {
        const r = parseSituationReport(`## 参战双方
### 我方
**【玩家】（甲）**（上级剑士）
- 血量：约七成
- 魔量：约三成
### 敌方
**乙**（杂兵）
- 血量：满状态`);
        const a = r.system.combatants.find((u) => u.name === '甲');
        assert.ok(a.attributes.HP.current < a.attributes.HP.max, '七成血要低于满血');
        assert.ok(a.attributes.MP.current < a.attributes.MP.max, '三成魔要低于满魔');
    });

    it('位阶单独进 tier', () => {
        const r = parseSituationReport(`## 参战双方
### 我方
**【玩家】（甲）**（剑客）
- 位阶：金丹中期
- 血量：满状态
### 敌方
**乙**（妖修）
- 位阶：筑基后期
- 血量：满状态`);
        assert.equal(r.system.combatants.find((u) => u.name === '甲').tier, '金丹中期');
    });

    it('名字被括号包着时能剥干净', () => {
        const r = parseSituationReport(`## 参战双方
### 我方
**【玩家】（甲）**（剑客）
- 血量：满状态
### 敌方
**乙**（妖修）
- 血量：满状态`);
        const names = r.system.combatants.map((u) => u.name);
        assert.ok(names.includes('甲'), `名字应当剥掉括号，实际：${names.join('、')}`);
        assert.ok(!names.some((n) => n.includes('（')), '不该残留括号');
    });
});
