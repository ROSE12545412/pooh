/** 战斗开场使用的数据结构约束。 */

import { TAG_EFFECT } from '../core/schema.js';

/** 技能标签词表，塞进提示词让模型优先复用用户世界书里已有的标签写法。 */
const TAG_VOCAB = Object.keys(TAG_EFFECT).join('、');

// ---------------------------------------------------------------------------
// JSON Schema
// ---------------------------------------------------------------------------

/** 属性的 JSON Schema 片段。 */
const attributePoolSchema = {
    type: 'object',
    properties: {
        current: { type: 'number', description: '当前值' },
        max: { type: 'number', description: '上限；无上限概念时与 current 相同' },
    },
    required: ['current', 'max'],
    additionalProperties: false,
};

/** 明确的平加值：delta 自带正负号，hit 的单位是 d20 骰面加值。 */
const modifierSchema = {
    type: 'object',
    properties: {
        attr: { type: 'string', enum: ['Atk', 'Armor', 'Speed', 'Evasion', 'hit'] },
        delta: { type: 'number', description: '原文明确给出的带符号平加值；目标判定-2/骰点-2 对应 attr=hit, delta=-2，在目标掷骰前扣判定总值，不降低施放者 Aim。不得把百分比或定性描述估成数值' },
    },
    required: ['attr', 'delta'],
    additionalProperties: false,
};

/** 技能效果的 JSON Schema。 */
const effectSchema = {
    type: 'object',
    properties: {
        type: {
            type: 'string',
            enum: ['damage', 'heal', 'mp', 'buff', 'debuff', 'shield', 'taunt', 'dispel', 'revive', 'cleanse', 'dot', 'control', 'other'],
            description: '效果类型。damage=即时伤害 heal=治疗 mp=回蓝 buff=增益 debuff=减益/骰点减益 shield=护盾 taunt=嘲讽 dispel=驱散 revive=复活 cleanse=净化 dot=持续伤害 control=控制。复合技能拆成多个效果，纯负面效果不额外加入 damage；敌对负面效果命中后附加',
        },
        power: { type: 'number', description: '该效果的准确数值；dot 是每次回合豁免失败时的每跳伤害，不乘隐藏比例。无直接数值或纯控制/骰点减益填 0，保留明确的 0' },
        duration: { type: 'integer', minimum: 0, description: '按受影响单位自己的回合计数；瞬发填 0，控制/持续伤害/减益填 >=1，每次受影响回合均消耗一次时长' },
        saveDc: { type: 'integer', minimum: 2, maximum: 30, description: '可选，仅 control/dot 使用；依据不足使用默认10。目标每回合开始独立掷 d20+现有 hit 修正，天然1失败/20成功；控制失败跳过当前行动，dot失败扣每跳伤害。成功只免除本回合效果，不移除状态' },
        tag: { type: 'string', description: '原始效果标签，例如单盲；没有填空字符串' },
        description: { type: 'string', description: '该效果的原文说明，用于追溯来源' },
        modifiers: { type: 'array', items: modifierSchema, description: '增益/减益的明确属性加值；没有明确数字填空数组。使用此数组时 power 可填 0，不重复计算同一加值' },
    },
    required: ['type', 'power', 'duration', 'tag', 'description', 'modifiers'],
    additionalProperties: false,
};

/** 技能的 JSON Schema。 */
const skillSchema = {
    type: 'object',
    properties: {
        name: { type: 'string', description: '技能名，去掉【】括号' },
        description: { type: 'string', description: '技能效果描述；原书没写就填空字符串' },
        target: {
            type: 'string',
            enum: ['single', 'group', 'self', 'all', 'random'],
            description: '逐技能明确范围。single=单体一个目标 group=群体(AOE)，覆盖对应阵营所有有效目标（敌对效果敌方，治疗增益友方） self=自身 all=双方全体 random=随机。AOE 默认伤害倍率 max(35%,1/sqrt(目标数)) 由本地引擎应用，此处保留衰减前威力，时长/DC/骰点修正不衰减',
        },
        power: { type: 'number', description: '核心威力数值，用于伤害/治疗计算；没有就填 0' },
        aim: { type: 'number', description: '施放者命中基准。原文明写 Aim 时保留原值（含 0）；本次施放判定加值 X 用 100+10*X，使默认 d20 加值等于 X。没有明确数字填 100；不得因此增加 power，也不得把目标判定/骰点减益计入施放者 Aim' },
        cost: { type: 'number', description: '消耗（通常是 MP）。没有就填 0' },
        cooldown: { type: 'number', description: '冷却回合数。没有就填 0' },
        effects: { type: 'array', items: effectSchema, description: '逐项识别即时伤害、控制、持续伤害与骰点减益，保留复合技能的全部效果；任何角色卡均按实际机制分类，不按职业/姓名套模板。只描述技能数据，不预言命中、豁免或战斗结果' },
        tags: {
            type: 'array',
            items: { type: 'string' },
            description: `原始标签，例如 "群攻"、"power:150"、"Aim:90"、"MP:40"。常用标签：${TAG_VOCAB}`,
        },
        source: { type: 'string', description: '数据出处，格式「世界书名/条目名」' },
    },
    required: ['name', 'description', 'target', 'power', 'aim', 'cost', 'cooldown', 'effects', 'tags', 'source'],
    additionalProperties: false,
};

/** 状态效果的 JSON Schema。 */
const statusSchema = {
    type: 'object',
    properties: {
        name: { type: 'string', description: '状态名，例如「中毒」「剑气护体」' },
        type: {
            type: 'string',
            enum: ['buff', 'debuff', 'dot', 'shield', 'control', 'heal', 'other'],
            description: '状态类型',
        },
        duration: { type: 'integer', minimum: 0, description: '剩余受影响单位回合数；永久填 99，控制/dot每次受影响回合均消耗一次时长，豁免成功也照常计数' },
        power: { type: 'number', description: '状态准确数值；dot为每次回合豁免失败的每跳伤害，无数值填 0' },
        saveDc: { type: 'integer', minimum: 2, maximum: 30, description: '可选，仅 control/dot 使用的回合豁免难度，缺省10；d20+已有hit修正，天然1失败/20成功，成功仅免本回合效果' },
        stacks: { type: 'number', description: '层数，默认 1' },
        description: { type: 'string', description: '状态说明' },
        modifiers: { type: 'array', items: modifierSchema, description: '只记录原文明写的属性增减，delta 保留正负号；未知数字不猜测，填空数组。不得已加进 attributes 后再次填写' },
    },
    required: ['name', 'type', 'duration', 'power', 'stacks', 'description', 'modifiers'],
    additionalProperties: false,
};

/** 战力评估的 JSON Schema。 */
const powerRatingSchema = {
    type: 'object',
    description:
        '这个角色的战力评估。这是「谁更强」的核心数据，必须给每个角色都填。',
    properties: {
        rating: {
            type: 'number',
            description:
                '战力评分 0~100，用于横向比较。必须拉开差距，不要都给 70~80。' +
                '参考：普通路人 5~15，杂兵 15~25，三流武者 30~40，二流 45~55，一流高手 60~75，顶尖强者 80~90，世界天花板 92~100。',
        },
        grade: { type: 'string', description: '档位名，优先用原世界书的说法（如「金丹后期」「上忍」「Lv.40」）；没有就用一流/二流/三流这类通用词' },
        note: { type: 'string', description: '一句话战力评价，例如「剑术精湛但体力不足，久战必败」' },
        basis: { type: 'string', description: '评分依据：说明凭什么给这个分（引用了哪些表现或设定）' },
    },
    required: ['rating', 'grade', 'note', 'basis'],
    additionalProperties: false,
};

/** 装备的 JSON Schema。 */
const equipmentSchema = {
    type: 'object',
    description: '一件装备（武器 / 防具 / 饰品）',
    properties: {
        name: { type: 'string', description: '装备名，去掉【】括号' },
        slot: {
            type: 'string',
            enum: ['weapon', 'armor', 'accessory', 'other'],
            description: '部位。weapon=武器/兵器/法宝/法器 armor=防具/护甲/法袍 accessory=饰品/护符/玉佩/戒指 other=其它',
        },
        bonuses: {
            type: 'object',
            description:
                '独立装备增益，键用 Atk/Armor/Speed/Evasion/hit（hit 直接是 d20 命中加值，不是 Aim 基准）。仅填写原文明写的带符号平加数值，不把百分比或定性描述估成数值，也不预先加进 attributes。没有明确增益就给空对象。',
            additionalProperties: { type: 'number' },
        },
        bonusMode: { type: 'string', enum: ['base', 'additive'], description: '普通装备填 base，单位属性为不含装备的基础值时叠加一次；仅权威自定义库明确为已有有效属性之外的新增量才用 additive。旧属性已含装备或口径不明时不重复叠加 base，不猜测扣掉旧装备值' },
        checks: {
            type: 'object',
            description: '装备真正的 d20 优劣势，独立于 signed bonuses/旧技能 advantage 数字。攻击优势2d20取高、劣势取低；防御优势使来袭攻击取低，防御劣势使来袭攻击取高。多来源同时有优势/劣势则抵消为单d20；只填写本场满足且无需额外条件的明确规则，否则 normal 并保留依据。仅简单无条件主d20公式应用，其余保留公式并提示未应用',
            properties: {
                attack: { type: 'string', enum: ['advantage', 'disadvantage', 'normal'], description: '持有者发起攻击的检定；未明示填 normal，不由物品名称/职业或强弱猜测' },
                defense: { type: 'string', enum: ['advantage', 'disadvantage', 'normal'], description: '持有者防御来袭攻击的检定；优势等于进攻方劣势，未明示填 normal' },
            },
            required: ['attack', 'defense'],
            additionalProperties: false,
        },
        equipped: { type: 'boolean', description: '是否正在装备；false 时加值和检定优劣势均不参与结算' },
        effect: { type: 'string', description: '逐件保留武器/防具/饰品的有利点、不利点和检定依据；无明确d20优势/劣势时明确写无，不捏造数值或算式。条件效果和暂不支持的效果只记录，不假装已生效' },
        description: { type: 'string', description: '原书对该装备的描述' },
        source: { type: 'string', description: '出处，格式「世界书名/条目名」' },
    },
    required: ['name', 'slot', 'bonuses', 'bonusMode', 'checks', 'equipped', 'effect', 'description', 'source'],
    additionalProperties: false,
};

/** 每个角色对各目标的定向说服影响力；未知不创建数值条目。 */
const socialSchema = {
    type: 'object',
    properties: {
        persona: { type: 'string', description: '保留角色的身份、性格与立场，供世界书补建；缺失填空字符串' },
        charm: {
            type: 'array',
            description: '开战时对每个对方参战者逐一评估，方向为当前角色对目标的说服影响力；依据关系、目标对该角色的好感和双方立场。不是颜值，不等于好感，不代表必招降或成功率；双方可以不同。缺少依据或数值时省略该条，整体缺失填 []，禁止默认 0 或伪造高数值。',
            items: {
                type: 'object',
                properties: {
                    targetName: { type: 'string', description: '目标在当前参战名单中的实际姓名，不使用固定示例姓名' },
                    value: { type: 'number', minimum: 0, maximum: 100, description: '有限的 0~100 说服影响力；仅明确评估为零才填 0' },
                    reason: { type: 'string', description: '关系、好感、立场的具体依据' },
                },
                required: ['targetName', 'value', 'reason'],
                additionalProperties: false,
            },
        },
    },
    required: ['persona', 'charm'],
    additionalProperties: false,
};

/** 战斗单位的 JSON Schema。 */
const combatantSchema = {
    type: 'object',
    properties: {
        name: { type: 'string', description: '角色名，使用世界书里的正式写法' },
        side: {
            type: 'string',
            enum: ['ally', 'enemy', 'neutral'],
            description: '阵营。ally=我方/主角方 enemy=敌方 neutral=中立或立场不明',
        },
        aliases: { type: 'array', items: { type: 'string' }, description: '别名/称号/曾用名' },
        tier: { type: 'string', description: '等级或境界，例如「大斗师」「金丹期」「Lv.32」；未知填空字符串' },
        tierValue: { type: 'number', description: '等级的数值化表示，用于排序比较；未知填 0' },
        powerRating: powerRatingSchema,
        social: socialSchema,
        equipment: {
            type: 'array',
            items: equipmentSchema,
            description: '武器 / 防具 / 饰品，每件单独一条，逐件记录明确的有利点/不利点、带符号加值、攻击与防御d20优劣势及依据；已选自定义库同名条目优先于场景推测，不能覆盖或重复计入基础属性。世界书没提到就填空数组，不臆造数值或检定优势。',
        },
        attributeBasis: { type: 'string', enum: ['base'], description: '必须为 base：attributes 是未叠装备和临时状态的基础属性，加值各自放 equipment.bonuses 和 statuses.modifiers' },
        attributes: {
            type: 'object',
            properties: {
                HP: attributePoolSchema,
                MP: attributePoolSchema,
                Atk: attributePoolSchema,
                Armor: attributePoolSchema,
                Speed: attributePoolSchema,
                Evasion: attributePoolSchema,
            },
            required: ['HP'],
            description: '未叠装备/临时状态的基础战斗属性；禁止把下面 equipment.bonuses 或 statuses.modifiers 预先计入。HP/MP/Atk/Armor/Speed 是标准五项；额外体系属性可保留自己的键',
            additionalProperties: attributePoolSchema,
        },
        skills: { type: 'array', items: skillSchema, description: '技能列表' },
        statuses: { type: 'array', items: statusSchema, description: '当前状态（战斗外的长期状态，如中毒、诅咒）' },
        alive: { type: 'boolean', description: '是否存活' },
        notes: { type: 'string', description: '备注：数据缺口、特殊规则、需要人类确认的疑点' },
        source: {
            type: 'object',
            properties: {
                worldbook: { type: 'string', description: '来源世界书名' },
                entry: { type: 'string', description: '来源条目名' },
            },
            required: ['worldbook', 'entry'],
            additionalProperties: false,
        },
    },
    required: ['name', 'side', 'aliases', 'tier', 'tierValue', 'powerRating', 'social', 'equipment', 'attributeBasis', 'attributes', 'skills', 'statuses', 'alive', 'notes', 'source'],
    additionalProperties: false,
};

/** 战斗开场结构化所需的完整数据 Schema。 */
export const BATTLE_JSON_SCHEMA = {
    name: 'power_system',
    description: '当前战斗场面的单位数据与战斗规则',
    strict: true,
    value: {
        type: 'object',
        properties: {
            system: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: '战力体系名称，例如「斗气大陆」「剑仙·金丹体系」' },
                    overview: { type: 'string', description: '体系总述：力量来源、晋升方式、战斗风格' },
                    scale: {
                        type: 'string',
                        description: '数值量纲说明。必须明确交代你做了怎样的数值映射，例如「原书 HP 数千~数万，已按 100:1 折算到 100 上下；Atk 与原书一致」',
                    },
                    attributeGuide: { type: 'string', description: '各属性的含义与相对关系说明' },
                    tiers: {
                        type: 'array',
                        description: '等级/境界阶梯，从低到高',
                        items: {
                            type: 'object',
                            properties: {
                                name: { type: 'string' },
                                value: { type: 'number' },
                                description: { type: 'string' },
                            },
                            required: ['name', 'value', 'description'],
                            additionalProperties: false,
                        },
                    },
                    rules: {
                        type: 'array',
                        items: { type: 'string' },
                        description: '该体系特有的战斗规则（如「境界压制：高一大境界者伤害免疫」）',
                    },
                },
                required: ['name', 'overview', 'scale', 'attributeGuide', 'tiers', 'rules'],
                additionalProperties: false,
            },
            ruleset: {
                type: 'object',
                description:
                    '从世界书里读出的战斗规则，表达成公式。世界书没有写规则时全部填空字符串，不要编造。',
                properties: {
                    name: { type: 'string', description: '规则集名称，例如「战斗铁律」「d20 检定」' },
                    description: { type: 'string', description: '规则原文的概括' },
                    hitMode: {
                        type: 'string',
                        enum: ['dice', 'chance'],
                        description: 'dice=掷骰对抗（掷出值≥目标值即命中）；chance=命中率判定',
                    },
                    powerMode: {
                        type: 'string',
                        enum: ['absolute', 'ratio-atk', 'ratio-maxhp', 'mixed'],
                        description:
                            '技能 power 的口径。absolute=绝对值；ratio-atk=占攻击力百分比；ratio-maxhp=占生命上限百分比；mixed=伤害按攻击力、护盾治疗按生命上限',
                    },
                    initiativeFormula: { type: 'string', description: '先攻公式，例：d20 + Speed' },
                    hitFormula: { type: 'string', description: '命中值公式，通用 d20 示例：d20 + (Aim - 100) / 10 + hitBonus。hitBonus 是装备和状态的实际命中平加值；原书自定义规则按原文保留' },
                    hitTargetFormula: { type: 'string', description: '命中目标值公式，例：Evasion' },
                    hitChanceFormula: { type: 'string', description: '命中率公式（返回 0~1），例：Aim / (Speed + Aim)' },
                    damageFormula: { type: 'string', description: '伤害公式，例：(power + Atk) * rand(0.8, 1.2) - Armor' },
                    healFormula: { type: 'string', description: '治疗额外加算，没有就填 "0"' },
                    shieldFormula: { type: 'string', description: '护盾额外加算，没有就填 "0"' },
                    mpFormula: { type: 'string', description: '回蓝额外加算，没有就填 "0"' },
                    buffFormula: { type: 'string', description: '增益数值额外加算，没有就填 "0"' },
                    debuffFormula: { type: 'string', description: '减益数值额外加算，没有就填 "0"' },
                    dotFormula: { type: 'string', description: '持续伤害额外加算，没有就填 "0"' },
                    critFormula: { type: 'string', description: '暴击条件，返回非 0 即暴击。例：nat == 20' },
                    fumbleFormula: { type: 'string', description: '大失败条件，例：nat == 1' },
                    critMultiplier: { type: 'number', description: '暴击倍率，默认 2' },
                    minDamage: { type: 'number', description: '命中后的最低伤害，默认 1' },
                    aoeFalloff: { type: 'string', enum: ['sqrt', 'linear', 'none'], description: '群攻威力衰减方式' },
                    aoeFalloffFloor: { type: 'number', description: '群攻衰减下限（不低于原威力的多少倍），默认 0.35' },
                    fumbleSelfHarmRatio: { type: 'number', description: '大失败自伤占最大生命的比例，默认 0.1；填 0 关闭反噬' },
                    shieldFirst: { type: 'boolean', description: '结算时是否先扣护盾再扣血，默认 true' },
                    defaultStatusDuration: { type: 'number', description: '状态效果没写持续时间时的默认回合数，默认 3' },
                    deathRule: { type: 'string', description: '死亡判定说明，例：hp<=0' },
                    notes: { type: 'string', description: '补充说明或你不确定的地方' },
                },
                required: [
                    'name',
                    'description',
                    'hitMode',
                    'powerMode',
                    'initiativeFormula',
                    'hitFormula',
                    'hitTargetFormula',
                    'hitChanceFormula',
                    'damageFormula',
                    'healFormula',
                    'shieldFormula',
                    'mpFormula',
                    'buffFormula',
                    'debuffFormula',
                    'dotFormula',
                    'critFormula',
                    'fumbleFormula',
                    'critMultiplier',
                    'minDamage',
                    'aoeFalloff',
                    'aoeFalloffFloor',
                    'fumbleSelfHarmRatio',
                    'shieldFirst',
                    'defaultStatusDuration',
                    'deathRule',
                    'notes',
                ],
                additionalProperties: false,
            },
            allies: {
                type: 'array',
                items: combatantSchema,
                description:
                    '我方 / 主角方单位。⚠️ 必须用 allies/enemies/neutral 这三个字段分栏，不要改成统一的 combatants 数组。',
            },
            enemies: {
                type: 'array',
                items: combatantSchema,
                description:
                    '敌方单位。⚠️ 即使只提到「一群杂兵」也要产出至少一条（名字里写数量，如「魔修弟子 ×5」）—— 这一栏为空就无法开战。',
            },
            neutral: { type: 'array', items: combatantSchema, description: '中立或立场不明的单位' },
            notes: { type: 'string', description: '总体备注：哪些数据缺失、哪些是推测、建议用户检查什么' },
        },
        required: ['system', 'ruleset', 'allies', 'enemies', 'neutral', 'notes'],
        additionalProperties: false,
    },
};
