/**
 * 「主动生成战斗场景」的测试。
 *
 * 动机：原来是**被动读**已有剧情 —— 剧情里恰好没在打，就读不出人、开不了战。
 * 用户的原话是「傻乎乎等着读 AI 正文」。
 *
 * 现在改成**主动驱动**：点开战 → 自动往输入框写一条战斗场景指令 → 发给正文模型 →
 * 它当场写出一份战斗场景清单 → 等输出完 → 本地解析 → 开打。
 *
 * 测试重点：
 *  - 提示词里的**输出格式必须写死**（因为我们靠本地解析，不再让第二个模型转格式）
 *  - **【玩家】标记**必须被要求保留（系统靠它区分玩家操控的角色）
 *  - 占位符替换的边界（有/没有补充要求、自定义模板里没有占位符）
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
    DEFAULT_SCENE_PROMPT,
    buildSceneRequest,
    looksLikeSceneReply,
    looksLikeSceneRequest,
} from '../src/llm/scene-prompt.js';
import { parseSituationReport } from '../src/llm/report-parser.js';

describe('DEFAULT_SCENE_PROMPT 输出格式', () => {
    it('给出精确的字段名与层级（解析器照着读）', () => {
        for (const field of ['位阶', '人设', '血量', '魔量', '技能', '武器与装备', '临时属性']) {
            assert.ok(DEFAULT_SCENE_PROMPT.includes(field), `必须包含字段「${field}」`);
        }
    });

    it('有「参战双方 / 我方 / 敌方」的层级（解析器靠它分阵营）', () => {
        assert.ok(DEFAULT_SCENE_PROMPT.includes('参战双方'));
        assert.ok(DEFAULT_SCENE_PROMPT.includes('### 我方'));
        assert.ok(DEFAULT_SCENE_PROMPT.includes('### 敌方'));
    });

    it('角色条目用 `**名字**（身份）` 开头（解析器靠它认人）', () => {
        assert.ok(/\*\*[^*]+\*\*（/.test(DEFAULT_SCENE_PROMPT), '应当给出这个格式的示例');
    });

    it('明确要求保留【玩家】标记', () => {
        assert.ok(DEFAULT_SCENE_PROMPT.includes('【玩家】'), '必须有这个标记');
        assert.ok(DEFAULT_SCENE_PROMPT.includes('必须保留'), '必须说明这个标记要保留');
        assert.ok(
            DEFAULT_SCENE_PROMPT.includes('自己操控') || DEFAULT_SCENE_PROMPT.includes('玩家扮演的角色'),
            '必须解释这个标记的作用',
        );
    });

    it('禁止写伤害数字与胜负（铁律）', () => {
        assert.ok(DEFAULT_SCENE_PROMPT.includes('不要') && DEFAULT_SCENE_PROMPT.includes('伤害'));
        assert.ok(DEFAULT_SCENE_PROMPT.includes('铁律') || DEFAULT_SCENE_PROMPT.includes('由掷骰引擎结算'));
    });

    it('声明放弃创作（避免模型自由发挥写一大段剧情）', () => {
        assert.ok(DEFAULT_SCENE_PROMPT.includes('放弃一切创作'), '必须明确要求放弃创作');
    });

    it('血量/魔量允许用档位描述（模型给不出精确数字）', () => {
        assert.ok(DEFAULT_SCENE_PROMPT.includes('百分比或档位'), '应当允许档位描述');
    });

    it('带一个 {{SITUATION}} 占位符', () => {
        assert.ok(DEFAULT_SCENE_PROMPT.includes('{{SITUATION}}'), '必须有占位符供补充要求注入');
    });
});

describe('buildSceneRequest 占位符替换', () => {
    it('有补充要求时替换掉占位行', () => {
        const text = buildSceneRequest({ situation: '这是一场切磋，不要下杀手' });
        assert.ok(text.includes('这是一场切磋，不要下杀手'), '应当包含补充要求');
        assert.ok(!text.includes('{{SITUATION}}'), '占位符必须被替换掉');
    });

    it('没有补充要求时整行删掉（不留空占位）', () => {
        const text = buildSceneRequest({});
        assert.ok(!text.includes('{{SITUATION}}'), '不该残留占位符');
        assert.ok(!/\n\s*\n\s*\n/.test(text), '不该留下多余空行');
    });

    it('自定义模板里没有占位符时，补充要求追加到末尾', () => {
        const text = buildSceneRequest({ template: '写一份战斗场景', situation: '只要三个人' });
        assert.ok(text.startsWith('写一份战斗场景'), '应当保留自定义模板');
        assert.ok(text.includes('只要三个人'), '补充要求应当被带上');
        assert.ok(text.includes('补充要求'), '应当标明这是补充要求');
    });

    it('模板为空时用内置模板', () => {
        const text = buildSceneRequest({ template: '   ' });
        assert.ok(text.includes('放弃一切创作'), '空模板应当退回内置模板');
    });

    it('结果首尾不留空白', () => {
        const text = buildSceneRequest({ situation: 'x' });
        assert.equal(text, text.trim());
    });
});

describe('looksLikeSceneRequest / looksLikeSceneReply 识别', () => {
    it('认得出战斗场景指令', () => {
        assert.equal(looksLikeSceneRequest(buildSceneRequest({})), true);
        assert.equal(looksLikeSceneRequest('今天天气不错'), false);
        assert.equal(looksLikeSceneRequest(''), false);
    });

    it('认得出战斗场景回复', () => {
        assert.equal(
            looksLikeSceneReply(`## 参战双方\n### 我方\n**甲**（剑士）\n- 血量：满状态`),
            true,
        );
    });

    it('普通正文不会被误认', () => {
        assert.equal(looksLikeSceneReply('他拔出了剑，两人对视。'), false);
        assert.equal(looksLikeSceneReply(''), false);
    });
});

describe('新格式的端到端解析', () => {
    it('解析出全部字段并标记出玩家角色', () => {
        const reply = `# 战斗场景

## 参战双方

### 我方
**【玩家】（淇）**（保罗之子）
- 位阶：无阶
- 人设：转生者
- 血量：满状态
- 魔量：满状态
- 技能：暂无
- 武器与装备：练习木剑
- 临时属性：无

**苏婉**（同行剑士）
- 位阶：二流剑士
- 血量：约八成
- 技能：流云剑：连续两次快斩

### 敌方
**保罗·格雷拉特**（三流派上级剑士）
- 位阶：上级剑士
- 血量：满状态
- 临时属性：主动压制出力

## 战场环境
后院，清晨。

## 补充说明
父子切磋。`;

        const r = parseSituationReport(reply);
        assert.equal(r.ok, true, r.error);
        assert.equal(r.stats.units, 3, `应当认出 3 个人：${r.system.combatants.map((u) => u.name).join('、')}`);

        const user = r.system.combatants.filter((u) => u.isUser);
        assert.equal(user.length, 1, '应当恰好标出 1 个玩家角色');
        assert.equal(user[0].name, '淇', '玩家角色应当是淇');
        assert.equal(user[0].side, 'ally', '玩家角色属于我方');

        // 其他人不该被误标
        assert.equal(r.system.combatants.find((u) => u.name === '苏婉').isUser, false);
        assert.equal(r.system.combatants.find((u) => u.name === '保罗·格雷拉特').isUser, false);
    });

    it('血量与魔量都按档位换算成了数值', () => {
        const reply = `## 参战双方
### 我方
**【玩家】（甲）**（上级剑士）
- 血量：约七成
- 魔量：约三成
### 敌方
**乙**（杂兵）
- 血量：满状态`;
        const r = parseSituationReport(reply);
        assert.equal(r.ok, true, r.error);
        const a = r.system.combatants.find((u) => u.name === '甲');
        assert.ok(a.attributes.HP.current < a.attributes.HP.max, '七成血应当低于满血');
        assert.ok(Math.abs(a.attributes.HP.current / a.attributes.HP.max - 0.7) < 0.06, '应当在七成左右');
        assert.ok(a.attributes.MP.current < a.attributes.MP.max, '魔量也该按比例');
    });

    it('位阶写进 tier（不再只是括号里的身份）', () => {
        const reply = `## 参战双方
### 我方
**【玩家】（甲）**（剑客）
- 位阶：金丹中期
- 血量：满状态
### 敌方
**乙**（妖修）
- 位阶：筑基后期
- 血量：满状态`;
        const r = parseSituationReport(reply);
        assert.equal(r.system.combatants.find((u) => u.name === '甲').tier, '金丹中期');
        assert.equal(r.system.combatants.find((u) => u.name === '乙').tier, '筑基后期');
    });

    it('临时属性被保留（影响掷骰判定，不能丢）', () => {
        const reply = `## 参战双方
### 我方
**【玩家】（甲）**（剑客）
- 血量：满状态
- 临时属性：服了爆灵丹，攻击力翻倍
### 敌方
**乙**（妖修）
- 血量：满状态`;
        const r = parseSituationReport(reply);
        const a = r.system.combatants.find((u) => u.name === '甲');
        assert.ok(a.notes.includes('爆灵丹'), `临时属性应当保留，实际：${a.notes}`);
    });
});
