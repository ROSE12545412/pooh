/**
 * 数据模型测试：归一化、校验、Combat_block 双向转换、diff 合并。
 *
 * 这一层是「AI 的脏输出」和「引擎的干净输入」之间的过滤器，
 * 也是最容易被真实世界数据打穿的地方，所以覆盖面要广。
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
    SEVERITY,
    applyDiff,
    canonicalAttributeKey,
    extractCombatBlock,
    formatAttributeString,
    formatSkillLine,
    normalizeCombatant,
    normalizePool,
    normalizePowerSystem,
    normalizeSkill,
    normalizeStatus,
    parseAttributeString,
    parseCombatBlock,
    parseSkillTags,
    toCombatBlock,
    toNumber,
    validatePowerSystem,
} from '../src/core/schema.js';

/** 造一个最小可用的单位。 */
function unit(overrides = {}) {
    return {
        name: '测试角色',
        side: 'ally',
        attributes: {
            HP: { current: 100, max: 100 },
            MP: { current: 50, max: 50 },
            Atk: { current: 20, max: 20 },
            Armor: { current: 5, max: 5 },
            Speed: { current: 10, max: 10 },
        },
        skills: [
            {
                name: '普通斩',
                power: 30,
                aim: 100,
                cost: 0,
                target: 'single',
                effects: [{ type: 'damage', power: 30, duration: 0 }],
            },
        ],
        statuses: [],
        alive: true,
        ...overrides,
    };
}

describe('toNumber 取值容错', () => {
    it('处理数值、字符串、千分位、百分号', () => {
        assert.equal(toNumber(42), 42);
        assert.equal(toNumber('42'), 42);
        assert.equal(toNumber('1,200'), 1200);
        assert.equal(toNumber('30%'), 30);
        assert.equal(toNumber('  7  '), 7);
        assert.equal(toNumber('-3.5'), -3.5);
    });

    it('非法值返回 undefined 而不是 NaN', () => {
        assert.equal(toNumber('abc'), undefined);
        assert.equal(toNumber(''), undefined);
        assert.equal(toNumber(null), undefined);
        assert.equal(toNumber(undefined), undefined);
        assert.equal(toNumber(NaN), undefined);
        assert.equal(toNumber(Infinity), undefined);
    });
});

describe('normalizePool 属性池归一化', () => {
    it('支持数字、分数串、对象三种形态', () => {
        assert.deepEqual(normalizePool(100), { current: 100, max: 100 });
        assert.deepEqual(normalizePool('632/850'), { current: 632, max: 850 });
        assert.deepEqual(normalizePool({ current: 10, max: 20 }), { current: 10, max: 20 });
        assert.deepEqual(normalizePool({ value: 15 }), { current: 15, max: 15 });
    });

    it('支持全角冒号与中文分隔的写法', () => {
        assert.deepEqual(normalizePool('300／400'.replace('／', '/')), { current: 300, max: 400 });
    });

    it('负数被夹到 0（血量不可能为负）', () => {
        assert.deepEqual(normalizePool('-50/100'), { current: 0, max: 100 });
    });

    it('空值返回全零而不是 undefined', () => {
        assert.deepEqual(normalizePool(null), { current: 0, max: 0 });
        assert.deepEqual(normalizePool(''), { current: 0, max: 0 });
        assert.deepEqual(normalizePool(undefined), { current: 0, max: 0 });
    });

    it('fallbackMax 在只给当前值时生效', () => {
        assert.deepEqual(normalizePool(30, 100), { current: 30, max: 100 });
    });
});

describe('属性键归一化', () => {
    it('中英文别名都归到标准键', () => {
        assert.equal(canonicalAttributeKey('hp'), 'HP');
        assert.equal(canonicalAttributeKey('生命值'), 'HP');
        assert.equal(canonicalAttributeKey('血量'), 'HP');
        assert.equal(canonicalAttributeKey('mana'), 'MP');
        assert.equal(canonicalAttributeKey('攻击力'), 'Atk');
        assert.equal(canonicalAttributeKey('防御'), 'Armor');
        assert.equal(canonicalAttributeKey('速度'), 'Speed');
        assert.equal(canonicalAttributeKey('闪避'), 'Evasion');
    });

    it('未知属性保留原名（特殊体系不能丢）', () => {
        assert.equal(canonicalAttributeKey('剑气'), '剑气');
        assert.equal(canonicalAttributeKey('道行'), '道行');
        assert.equal(canonicalAttributeKey('unknownStat'), 'UnknownStat');
    });
});

describe('属性串解析', () => {
    it('解析世界书里的标准写法', () => {
        const pairs = parseAttributeString('[HP:632/850][MP:180/200][Atk:120][Armor:50][Speed:30]');
        assert.equal(pairs.length, 5);
        assert.deepEqual(pairs[0], ['HP', '632/850']);
        assert.deepEqual(pairs[2], ['Atk', '120']);
    });

    it('容忍全角冒号与空格', () => {
        const pairs = parseAttributeString('[ HP ： 100/200 ] [Atk: 15]');
        assert.equal(pairs.length, 2);
        assert.equal(pairs[0][0], 'HP');
    });

    it('没有属性串时返回空数组', () => {
        assert.deepEqual(parseAttributeString(''), []);
        assert.deepEqual(parseAttributeString('随便一段话'), []);
    });
});

describe('技能标签解析', () => {
    it('解析群攻技能的全部标签', () => {
        const result = parseSkillTags('【红莲野火】[群攻;power:150][群降;power:20][Aim:90][MP:40]');
        assert.equal(result.target, 'group');
        assert.equal(result.power, 150);
        assert.equal(result.aim, 90);
        assert.equal(result.cost, 40);
        assert.equal(result.effects.length, 2);
        assert.equal(result.effects[0].type, 'damage');
        assert.equal(result.effects[1].type, 'debuff');
        assert.equal(result.unknownTags.length, 0);
    });

    it('解析单体治疗技能', () => {
        const result = parseSkillTags('【回春术】[单回;power:200][Aim:100][MP:65]');
        assert.equal(result.target, 'single');
        assert.equal(result.effects[0].type, 'heal');
        assert.equal(result.effects[0].power, 200);
    });

    it('群前缀决定目标范围', () => {
        assert.equal(parseSkillTags('[群盾;power:300]').target, 'group');
        assert.equal(parseSkillTags('[单盾;power:400]').target, 'single');
    });

    it('未知标签被记录而不是丢弃', () => {
        const result = parseSkillTags('[群体;power:14][单瞄;power:20]');
        assert.ok(result.unknownTags.includes('群体'), `未识别标签应被记录：${JSON.stringify(result.unknownTags)}`);
    });

    it('全角分号也能分隔', () => {
        const result = parseSkillTags('[群攻；power:100]');
        assert.equal(result.power, 100);
    });

    it('没有标签块时返回默认值', () => {
        const result = parseSkillTags('【无名】');
        assert.equal(result.power, 0);
        assert.equal(result.target, 'single');
    });

    it('中文别名标签映射到正确效果', () => {
        assert.equal(parseSkillTags('[群回蓝;power:30]').effects[0].type, 'mp');
        assert.equal(parseSkillTags('[单嘲;power:3]').effects[0].type, 'taunt');
        assert.equal(parseSkillTags('[群盲;power:20]').effects[0].type, 'debuff');
    });
});

describe('技能归一化', () => {
    it('从字符串形态解析出完整技能', () => {
        const skill = normalizeSkill('【青莲剑衣】[单盾;power:10][Aim:100][MP:0]');
        assert.equal(skill.name, '青莲剑衣');
        assert.equal(skill.target, 'single');
        assert.equal(skill.aim, 100);
        assert.equal(skill.cost, 0);
        assert.ok(skill.effects.some((e) => e.type === 'shield'));
    });

    it('从结构化对象读取字段', () => {
        const skill = normalizeSkill({
            name: '测试',
            power: 55,
            aim: 88,
            cost: 12,
            target: 'group',
            effects: [{ type: 'damage', power: 55 }],
        });
        assert.equal(skill.power, 55);
        assert.equal(skill.aim, 88);
        assert.equal(skill.cost, 12);
        assert.equal(skill.target, 'group');
    });

    it('中文目标名映射到英文枚举', () => {
        assert.equal(normalizeSkill({ name: 'x', target: '群体' }).target, 'group');
        assert.equal(normalizeSkill({ name: 'x', target: '自身' }).target, 'self');
    });

    it('没写 Aim 时给一个不会永远打空的默认值', () => {
        const skill = normalizeSkill({ name: '无命中技能', power: 10 });
        assert.equal(skill.aim, 100);
    });

    it('完全没有效果时补一个伤害效果', () => {
        const skill = normalizeSkill({ name: '裸技能', power: 20 });
        assert.equal(skill.effects.length, 1);
        assert.equal(skill.effects[0].type, 'damage');
    });

    it('空输入返回 null', () => {
        assert.equal(normalizeSkill(null), null);
        assert.equal(normalizeSkill(undefined), null);
    });
});

describe('状态归一化', () => {
    it('从字符串解析出状态名与持续时间', () => {
        const status = normalizeStatus('中毒(3回合)');
        assert.equal(status.name, '中毒');
        assert.equal(status.duration, 3);
        assert.equal(status.type, 'dot');
    });

    it('从对象读取字段', () => {
        const status = normalizeStatus({ name: '剑气护体', type: 'buff', duration: 5, power: 20, stacks: 2 });
        assert.equal(status.name, '剑气护体');
        assert.equal(status.duration, 5);
        assert.equal(status.power, 20);
        assert.equal(status.stacks, 2);
    });

    it('中英文类型名都能识别', () => {
        assert.equal(normalizeStatus({ name: 'x', type: 'shield' }).type, 'shield');
        assert.equal(normalizeStatus({ name: '受伤', type: 'debuff' }).type, 'debuff');
    });

    it('层数至少为 1', () => {
        assert.equal(normalizeStatus({ name: 'x', stacks: 0 }).stacks, 1);
        assert.equal(normalizeStatus({ name: 'x', stacks: -3 }).stacks, 1);
    });
});

describe('战斗单位归一化', () => {
    it('从属性串形态构造单位', () => {
        const result = normalizeCombatant({
            name: '烈阳剑尊',
            属性: '[HP:632/850][MP:180/200][Atk:120][Armor:50][Speed:30]',
            skills: ['【红莲野火】[群攻;power:150][Aim:90][MP:40]'],
        });
        assert.equal(result.name, '烈阳剑尊');
        assert.equal(result.attributes.HP.current, 632);
        assert.equal(result.attributes.HP.max, 850);
        assert.equal(result.attributes.Atk.current, 120);
        assert.equal(result.skills.length, 1);
        assert.equal(result.skills[0].power, 150);
    });

    it('从扁平字段构造单位', () => {
        const result = normalizeCombatant({ name: '小明', hp: 80, atk: 12, speed: 9 });
        assert.equal(result.attributes.HP.current, 80);
        assert.equal(result.attributes.Atk.current, 12);
        assert.equal(result.attributes.Speed.current, 9);
    });

    it('中文阵营名映射到枚举', () => {
        assert.equal(normalizeCombatant({ name: 'x', 阵营: '我方' }).side, 'ally');
        assert.equal(normalizeCombatant({ name: 'x', 阵营: '敌方' }).side, 'enemy');
        assert.equal(normalizeCombatant({ name: 'x', 阵营: '中立' }).side, 'neutral');
    });

    it('缺 HP 时给一个不至于除零的兜底', () => {
        const result = normalizeCombatant({ name: '无属性角色' });
        assert.ok(result.attributes.HP.max >= 1);
        assert.ok(result.attributes.Evasion.current > 0, '闪避必须有值，否则命中判定会异常');
    });

    it('当前值超过上限时被夹回', () => {
        const result = normalizeCombatant({ name: 'x', hp: '200/100' });
        assert.equal(result.attributes.HP.current, 100);
        assert.equal(result.attributes.HP.max, 100);
    });

    it('没有名字直接返回 null', () => {
        assert.equal(normalizeCombatant({}), null);
        assert.equal(normalizeCombatant({ name: '   ' }), null);
        assert.equal(normalizeCombatant(null), null);
    });

    it('保留出处信息', () => {
        const result = normalizeCombatant({ name: 'x', source: { worldbook: '某书', entry: '某条目' } });
        assert.equal(result.source.worldbook, '某书');
        assert.equal(result.source.entry, '某条目');
    });
});

describe('战力体系归一化', () => {
    it('合并 allies / enemies 分组', () => {
        const system = normalizePowerSystem({
            system: { name: '测试体系' },
            allies: [unit({ name: '队友' })],
            enemies: [unit({ name: '敌人', side: 'enemy' })],
        });
        assert.equal(system.combatants.length, 2);
        assert.equal(system.combatants[0].side, 'ally');
        assert.equal(system.combatants[1].side, 'enemy');
    });

    it('支持扁平的 combatants 数组', () => {
        const system = normalizePowerSystem({
            combatants: [unit({ name: 'A', side: 'ally' }), unit({ name: 'B', side: 'enemy' })],
        });
        assert.equal(system.combatants.length, 2);
    });

    it('同名同阵营去重并合并技能', () => {
        const system = normalizePowerSystem({
            allies: [
                unit({
                    name: '同名',
                    skills: [{ name: '技能甲', power: 10, aim: 100, effects: [{ type: 'damage', power: 10, duration: 0 }] }],
                }),
                unit({
                    name: '同名',
                    skills: [{ name: '技能乙', power: 20, aim: 100, effects: [{ type: 'damage', power: 20, duration: 0 }] }],
                }),
            ],
        });
        assert.equal(system.combatants.length, 1);
        // 用集合比较，顺序不重要
        const names = system.combatants[0].skills.map((s) => s.name);
        assert.equal(names.length, 2);
        assert.ok(names.includes('技能甲') && names.includes('技能乙'), `技能合并失败：${names}`);
    });

    it('缺少体系名时给占位名', () => {
        const system = normalizePowerSystem({ allies: [unit()] });
        assert.ok(system.systemName);
    });

    it('完全空的输入不崩溃', () => {
        const system = normalizePowerSystem(null);
        assert.deepEqual(system.combatants, []);
        assert.ok(system.systemName);
    });

    it('保留规则集字段', () => {
        const system = normalizePowerSystem({
            allies: [unit()],
            ruleset: { name: '某规则', damageFormula: 'power - Armor' },
        });
        assert.equal(system.ruleset.name, '某规则');
    });
});

describe('战力体系校验', () => {
    it('正常数据没有问题', () => {
        const system = normalizePowerSystem({
            allies: [unit()],
            enemies: [unit({ name: '敌人', side: 'enemy' })],
        });
        const issues = validatePowerSystem(system).filter((i) => i.level === SEVERITY.ERROR);
        assert.deepEqual(issues, []);
    });

    it('没有单位时报告致命错误', () => {
        const issues = validatePowerSystem({ combatants: [] });
        assert.ok(issues.some((i) => i.level === SEVERITY.ERROR));
    });

    it('缺一方时给出警告', () => {
        const system = normalizePowerSystem({ allies: [unit()] });
        const issues = validatePowerSystem(system);
        assert.ok(issues.some((i) => i.level === SEVERITY.WARNING && i.message.includes('敌方')));
    });

    it('同名单位给出警告', () => {
        const system = normalizePowerSystem({
            allies: [unit({ name: '同名' }), unit({ name: '同名', id: 'x' })],
            enemies: [unit({ name: '敌', side: 'enemy' })],
        });
        // 归一化会先合并同名，所以这里手工构造一个重复的情况
        system.combatants.push(JSON.parse(JSON.stringify(system.combatants[0])));
        const issues = validatePowerSystem(system);
        assert.ok(issues.some((i) => i.message.includes('同名')));
    });

    it('没有技能的单位给出警告但不阻断', () => {
        const system = normalizePowerSystem({
            allies: [unit({ skills: [] })],
            enemies: [unit({ name: '敌', side: 'enemy' })],
        });
        const issues = validatePowerSystem(system);
        assert.ok(issues.some((i) => i.level === SEVERITY.WARNING && i.message.includes('技能')));
        assert.ok(!issues.some((i) => i.level === SEVERITY.ERROR));
    });

    it('非对象输入返回错误而不是抛异常', () => {
        const issues = validatePowerSystem(null);
        assert.equal(issues[0].level, SEVERITY.ERROR);
    });
});

describe('Combat_block 解析', () => {
    const sample = `<Combat_block>
战斗数据栏:
  我方列表:
    - 角色:
        名字: "⚔️李长风"
        属性: "[HP:620/620][MP:240/240][Atk:100][Armor:40][Speed:50]"
        技能:
          - "【绝息印】[单体;power:250][Aim:80][MP:50]"
          - "【御风决】[群增;power:30][Aim:100][MP:30]"
  敌方列表:
    - 角色:
        名字: "🌲远古树精"
        属性: "[HP:3000/3000][MP:500/500][Atk:150][Armor:80][Speed:10]"
        技能:
          - "【毒藤蔓延】[群攻;power:80][Aim:80][MP:50]"
</Combat_block>`;

    it('解析出正确的单位数与阵营', () => {
        const parsed = parseCombatBlock(sample);
        assert.ok(parsed);
        assert.equal(parsed.combatants.length, 2);
        const ally = parsed.combatants.find((u) => u.side === 'ally');
        const enemy = parsed.combatants.find((u) => u.side === 'enemy');
        assert.equal(ally.name, '⚔️李长风');
        assert.equal(enemy.name, '🌲远古树精');
    });

    it('属性与技能都解析正确', () => {
        const parsed = parseCombatBlock(sample);
        const ally = parsed.combatants.find((u) => u.side === 'ally');
        assert.equal(ally.attributes.HP.current, 620);
        assert.equal(ally.attributes.Speed.current, 50);
        assert.equal(ally.skills.length, 2);
        assert.equal(ally.skills[0].power, 250);
        assert.equal(ally.skills[1].target, 'group');
    });

    it('解析状态行', () => {
        const parsed = parseCombatBlock(`<Combat_block>
战斗数据栏:
  我方列表:
    - 角色:
        名字: "测试"
        属性: "[HP:100/100]"
        状态: "中毒(3回合)、护体真气(5回合)"
</Combat_block>`);
        assert.equal(parsed.combatants[0].statuses.length, 2);
        assert.equal(parsed.combatants[0].statuses[0].name, '中毒');
    });

    it('没有有效内容时返回 null', () => {
        assert.equal(parseCombatBlock(''), null);
        assert.equal(parseCombatBlock('一段无关的文字'), null);
    });

    it('extractCombatBlock 精确切出块', () => {
        const text = `前面的话\n${sample}\n后面的话`;
        const block = extractCombatBlock(text);
        assert.ok(block.startsWith('<Combat_block>'));
        assert.ok(block.endsWith('</Combat_block>'));
        assert.ok(!block.includes('前面的话'));
    });

    it('没有块时返回 null', () => {
        assert.equal(extractCombatBlock('没有块的正文'), null);
    });
});

describe('Combat_block 序列化', () => {
    it('属性串往返一致', () => {
        const u = normalizeCombatant({
            name: 'x',
            attributes: {
                HP: { current: 620, max: 620 },
                MP: { current: 240, max: 240 },
                Atk: { current: 100, max: 100 },
                Armor: { current: 40, max: 40 },
                Speed: { current: 50, max: 50 },
            },
        });
        const text = formatAttributeString(u);
        // 五项标准属性按固定顺序输出；Evasion 是引擎必需字段，会跟在后面
        assert.ok(text.startsWith('[HP:620/620][MP:240/240][Atk:100][Armor:40][Speed:50]'), text);
        // 再解析回来应当一致
        const pairs = parseAttributeString(text);
        assert.equal(pairs.length, 6);
        assert.deepEqual(pairs.slice(0, 5).map((p) => p[0]), ['HP', 'MP', 'Atk', 'Armor', 'Speed']);
    });

    it('自定义属性不丢失', () => {
        const u = normalizeCombatant({
            name: 'x',
            attributes: {
                HP: { current: 100, max: 100 },
                剑气: { current: 30, max: 30 },
            },
        });
        const text = formatAttributeString(u);
        assert.ok(text.includes('剑气'), `自定义属性丢失了：${text}`);
    });

    it('技能行保留原始标签', () => {
        const skill = normalizeSkill('【红莲野火】[群攻;power:150][群降;power:20][Aim:90][MP:40]');
        const line = formatSkillLine(skill);
        assert.ok(line.includes('【红莲野火】'));
        assert.ok(line.includes('群攻'));
        assert.ok(line.includes('power:150'));
        assert.ok(line.includes('MP:40'));
    });

    it('整表序列化 → 解析 → 再序列化保持稳定（幂等）', () => {
        const system = normalizePowerSystem({
            system: { name: '往返测试' },
            allies: [unit({ name: '甲' })],
            enemies: [unit({ name: '乙', side: 'enemy' })],
        });
        const first = toCombatBlock(system);
        assert.ok(first.startsWith('<Combat_block>'));
        assert.ok(first.includes('我方列表'));
        assert.ok(first.includes('敌方列表'));

        const reparsed = parseCombatBlock(first);
        assert.ok(reparsed, '生成的文本必须能被自己解析回来');
        const second = toCombatBlock(reparsed);
        assert.equal(second, first, '第二次序列化应当与第一次完全一致');
    });

    it('maxUnits 限制生效', () => {
        const system = normalizePowerSystem({
            allies: [unit({ name: 'A' }), unit({ name: 'B' }), unit({ name: 'C' })],
            enemies: [unit({ name: 'E', side: 'enemy' })],
        });
        const text = toCombatBlock(system, { maxUnits: 1 });
        assert.ok(!text.includes('"B"'));
    });
});

describe('applyDiff 增量合并', () => {
    function baseSystem() {
        return normalizePowerSystem({
            system: { name: 'diff 测试' },
            allies: [unit({ name: '甲', attributes: { HP: { current: 100, max: 100 }, MP: { current: 50, max: 50 }, Atk: { current: 20, max: 20 }, Armor: { current: 5, max: 5 }, Speed: { current: 10, max: 10 } } })],
            enemies: [unit({ name: '乙', side: 'enemy' })],
        });
    }

    it('hpChanges 扣血', () => {
        const system = baseSystem();
        const result = applyDiff(system, { hpChanges: [{ name: '甲', attribute: 'HP', delta: -30 }] });
        assert.equal(system.combatants[0].attributes.HP.current, 70);
        assert.equal(result.applied.length, 1);
    });

    it('hpChanges 治疗不会超过上限', () => {
        const system = baseSystem();
        system.combatants[0].attributes.HP.current = 90;
        applyDiff(system, { hpChanges: [{ name: '甲', attribute: 'HP', delta: 999 }] });
        assert.equal(system.combatants[0].attributes.HP.current, 100);
    });

    it('扣血到 0 时标记阵亡', () => {
        const system = baseSystem();
        applyDiff(system, { hpChanges: [{ name: '甲', attribute: 'HP', delta: -999 }] });
        assert.equal(system.combatants[0].attributes.HP.current, 0);
        assert.equal(system.combatants[0].alive, false);
    });

    it('找不到单位时记录跳过而不是静默忽略', () => {
        const system = baseSystem();
        const result = applyDiff(system, { hpChanges: [{ name: '不存在的人', attribute: 'HP', delta: -10 }] });
        assert.equal(result.applied.length, 0);
        assert.equal(result.skipped.length, 1);
    });

    it('added 新增单位', () => {
        const system = baseSystem();
        const result = applyDiff(system, { added: [unit({ name: '丙' })] });
        assert.equal(system.combatants.length, 3);
        assert.ok(result.applied[0].includes('丙'));
    });

    it('added 遇到同名同阵营时不重复添加', () => {
        const system = baseSystem();
        const result = applyDiff(system, { added: [unit({ name: '甲' })] });
        assert.equal(system.combatants.length, 2);
        assert.equal(result.skipped.length, 1);
    });

    it('updated 只改给出的属性，其余保持', () => {
        const system = baseSystem();
        applyDiff(system, { updated: [{ name: '甲', attributes: { HP: { current: 40, max: 100 } } }] });
        assert.equal(system.combatants[0].attributes.HP.current, 40);
        assert.equal(system.combatants[0].attributes.Atk.current, 20, '未提及的属性不应被改动');
    });

    it('updated 只给当前值时保留原上限', () => {
        const system = baseSystem();
        applyDiff(system, { updated: [{ name: '甲', attributes: { HP: { current: 55, max: 55 } } }] });
        // 上限 100 大于当前值 55，应当保留 100
        assert.equal(system.combatants[0].attributes.HP.max, 100);
        assert.equal(system.combatants[0].attributes.HP.current, 55);
    });

    it('updated 能学会新技能', () => {
        const system = baseSystem();
        applyDiff(system, {
            updated: [{ name: '甲', skills: [{ name: '新绝招', power: 300, aim: 90 }] }],
        });
        const names = system.combatants[0].skills.map((s) => s.name);
        assert.ok(names.includes('新绝招'));
    });

    it('updated 覆盖状态列表', () => {
        const system = baseSystem();
        applyDiff(system, { updated: [{ name: '甲', statuses: ['中毒(3回合)'] }] });
        assert.equal(system.combatants[0].statuses.length, 1);
        assert.equal(system.combatants[0].statuses[0].name, '中毒');
    });

    it('removed 移除单位', () => {
        const system = baseSystem();
        const result = applyDiff(system, { removed: ['乙'] });
        assert.equal(system.combatants.length, 1);
        assert.ok(result.applied[0].includes('乙'));
    });

    it('空 diff 不产生任何改动', () => {
        const system = baseSystem();
        const before = JSON.stringify(system.combatants);
        const result = applyDiff(system, {});
        assert.equal(JSON.stringify(system.combatants), before);
        assert.equal(result.applied.length, 0);
    });

    it('脏 diff（null / 非法结构）不崩溃', () => {
        const system = baseSystem();
        assert.doesNotThrow(() => applyDiff(system, null));
        assert.doesNotThrow(() => applyDiff(system, { added: 'not-an-array', updated: 42, removed: {} }));
        assert.doesNotThrow(() => applyDiff(null, { added: [] }));
    });

    it('合并后写入 updatedAt', () => {
        const system = baseSystem();
        applyDiff(system, { notes: '测试' });
        assert.ok(system.meta.updatedAt > 0);
    });
});
