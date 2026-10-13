/**
 * 装备（武器 / 防具 / 饰品）测试。
 *
 * 装备不是「战力表界面」的一部分 —— 战斗单位本身就有装备，
 * 开战时读场面也会读出来，所以这套逻辑在砍掉战力表页之后依然有效。
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
    EQUIP_SLOT,
    SLOT_LABEL,
    applyDiff,
    formatCombatantBlock,
    formatEquipmentBonuses,
    normalizeCombatant,
    normalizeEquipment,
    normalizePowerSystem,
    normalizeSlot,
    parseBonusString,
    parseEquipmentLine,
    toCombatBlock,
} from '../src/core/schema.js';

describe('normalizeSlot 部位识别', () => {
    it('识别武器类写法', () => {
        for (const name of ['武器', '兵器', '刀', '剑', '枪', '弓', '杖', '法器', '法宝', '灵器', '神兵', 'weapon', 'sword']) {
            assert.equal(normalizeSlot(name), EQUIP_SLOT.WEAPON, `${name} 应当归为武器`);
        }
    });

    it('识别防具类写法', () => {
        for (const name of ['防具', '护甲', '铠甲', '法袍', '战甲', '盾', 'armor', 'shield']) {
            assert.equal(normalizeSlot(name), EQUIP_SLOT.ARMOR, `${name} 应当归为防具`);
        }
    });

    it('识别饰品类写法', () => {
        for (const name of ['饰品', '首饰', '护符', '玉佩', '戒指', '项链', '手镯', 'accessory', 'ring']) {
            assert.equal(normalizeSlot(name), EQUIP_SLOT.ACCESSORY, `${name} 应当归为饰品`);
        }
    });

    it('认不出来的归为其它，不崩', () => {
        assert.equal(normalizeSlot('莫名其妙'), EQUIP_SLOT.OTHER);
        assert.equal(normalizeSlot(''), EQUIP_SLOT.OTHER);
        assert.equal(normalizeSlot(null), EQUIP_SLOT.OTHER);
    });

    it('能从「长名字里含关键词」判断', () => {
        assert.equal(normalizeSlot('上古神剑·青莲'), EQUIP_SLOT.WEAPON, '名字里含「剑」应当归为武器');
        assert.equal(normalizeSlot('九转护心玉佩'), EQUIP_SLOT.ACCESSORY);
    });
});

describe('parseBonusString 属性增益解析', () => {
    it('解析标准写法', () => {
        assert.deepEqual(parseBonusString('[Atk:+30][Speed:+10]'), { Atk: 30, Speed: 10 });
    });

    it('支持负值', () => {
        assert.deepEqual(parseBonusString('[Speed:-5]'), { Speed: -5 });
    });

    it('支持中文属性名', () => {
        assert.deepEqual(parseBonusString('[攻击力:+20][生命值:100]'), { Atk: 20, HP: 100 });
    });

    it('支持全角冒号', () => {
        assert.deepEqual(parseBonusString('[Atk：+30]'), { Atk: 30 });
    });

    it('同一方括号里空格分隔的多个增益也能解析', () => {
        // 这条是往返测试抓出来的 bug：早期正则会贪婪吃掉空格，把键名读成 AtkSpeed
        assert.deepEqual(parseBonusString('[Atk+30 Speed+10]'), { Atk: 30, Speed: 10 });
    });

    it('没有属性串时返回空对象', () => {
        assert.deepEqual(parseBonusString('一把普通的剑'), {});
        assert.deepEqual(parseBonusString(''), {});
        assert.deepEqual(parseBonusString(null), {});
    });
});

describe('normalizeEquipment 归一化', () => {
    it('从字符串形态解析（含名字、增益、附加效果）', () => {
        const equip = normalizeEquipment('【青莲剑】[Atk:+30][Speed:+10]（斩铁）');
        assert.equal(equip.name, '青莲剑');
        assert.equal(equip.slot, EQUIP_SLOT.WEAPON);
        assert.deepEqual(equip.bonuses, { Atk: 30, Speed: 10 });
        assert.equal(equip.effect, '斩铁');
    });

    it('从对象形态解析', () => {
        const equip = normalizeEquipment({
            name: '护心玉佩',
            slot: '饰品',
            bonuses: { HP: 100 },
            effect: '临死免伤一次',
            description: '祖传之物',
        });
        assert.equal(equip.slot, EQUIP_SLOT.ACCESSORY);
        assert.deepEqual(equip.bonuses, { HP: 100 });
        assert.equal(equip.effect, '临死免伤一次');
        assert.equal(equip.description, '祖传之物');
    });

    it('中文键名也能识别', () => {
        const equip = normalizeEquipment({ 名称: '玄铁甲', 部位: '护甲', 属性: '[Armor:+25]', 描述: '沉重但坚固' });
        assert.equal(equip.name, '玄铁甲');
        assert.equal(equip.slot, EQUIP_SLOT.ARMOR);
        assert.deepEqual(equip.bonuses, { Armor: 25 });
        assert.equal(equip.description, '沉重但坚固');
    });

    it('部位能从名字推断（没给 slot 时）', () => {
        assert.equal(normalizeEquipment({ name: '青莲剑' }).slot, EQUIP_SLOT.WEAPON);
        assert.equal(normalizeEquipment({ name: '护心玉佩' }).slot, EQUIP_SLOT.ACCESSORY);
    });

    it('`部位·名字[增益]` 形态也能解析出名字', () => {
        const equip = normalizeEquipment('武器·玄重尺[Atk:+30]');
        assert.equal(equip.name, '玄重尺', '名字不该退化成「装备1」');
        assert.equal(equip.slot, EQUIP_SLOT.WEAPON);
    });

    it('没有增益时 bonuses 是空对象而不是 undefined', () => {
        const equip = normalizeEquipment({ name: '木剑' });
        assert.deepEqual(equip.bonuses, {});
        assert.equal(formatEquipmentBonuses(equip), '');
    });

    it('空输入返回 null', () => {
        assert.equal(normalizeEquipment(null), null);
        assert.equal(normalizeEquipment(undefined), null);
    });

    it('每个部位都有中文名（UI 要用）', () => {
        for (const slot of Object.values(EQUIP_SLOT)) {
            assert.ok(SLOT_LABEL[slot], `部位 ${slot} 缺少中文名`);
        }
    });
});

describe('单位里的装备', () => {
    it('合并 weapons / armor / accessories 三类字段', () => {
        const unit = normalizeCombatant({
            name: '李长风',
            weapons: ['【青莲剑】[Atk:+30]'],
            armor: ['【玄铁甲】[Armor:+25]'],
            accessories: ['【护心玉佩】[HP:+100]'],
        });
        assert.equal(unit.equipment.length, 3);
        const slots = unit.equipment.map((e) => e.slot).sort();
        assert.deepEqual(slots, ['accessory', 'armor', 'weapon']);
    });

    it('合并 equipment 单一字段', () => {
        const unit = normalizeCombatant({
            name: '甲',
            equipment: [
                { name: '长剑', slot: 'weapon', bonuses: { Atk: 10 } },
                { name: '皮甲', slot: 'armor', bonuses: { Armor: 5 } },
            ],
        });
        assert.equal(unit.equipment.length, 2);
    });

    it('按 部位+名称 去重（同一件在两处出现很常见）', () => {
        const unit = normalizeCombatant({
            name: '甲',
            weapons: ['【青莲剑】[Atk:+30]'],
            equipment: ['【青莲剑】[Atk:+30]'],
        });
        assert.equal(unit.equipment.length, 1, '同名同部位应当去重');
    });

    it('中文键名也能识别', () => {
        const unit = normalizeCombatant({ name: '甲', 武器: ['【剑】'], 饰品: [{ name: '玉镯' }] });
        assert.equal(unit.equipment.length, 2);
    });

    it('没有装备时是空数组，不是 undefined', () => {
        const unit = normalizeCombatant({ name: '甲' });
        assert.deepEqual(unit.equipment, []);
    });

    it('整个体系里每个单位都带 equipment 字段（结构一致）', () => {
        const system = normalizePowerSystem({
            allies: [normalizeCombatant({ name: '甲', side: 'ally' })],
            enemies: [normalizeCombatant({ name: '乙', side: 'enemy', weapons: ['刀'] })],
        });
        for (const unit of system.combatants) {
            assert.ok(Array.isArray(unit.equipment), `${unit.name} 缺少 equipment`);
        }
    });
});

describe('装备的 Combat_block 输出与往返', () => {
    it('输出带部位、增益与效果', () => {
        const unit = normalizeCombatant({
            name: '甲',
            weapons: ['【青莲剑】[Atk:+30][Speed:+10]（斩铁）'],
        });
        const block = formatCombatantBlock(unit);
        assert.ok(block.includes('装备'), '应当有装备行');
        assert.ok(block.includes('青莲剑'));
        assert.ok(block.includes('武器'), '应当带部位');
        assert.ok(block.includes('Atk+30'), `应当带增益，实际：${block}`);
        assert.ok(block.includes('斩铁'), '应当带附加效果');
    });

    it('没有装备时不输出装备行', () => {
        const unit = normalizeCombatant({ name: '甲' });
        assert.ok(!formatCombatantBlock(unit).includes('装备'));
    });

    it('装备行能被解析回来', () => {
        const parsed = parseEquipmentLine('武器·青莲剑[Atk+30 Speed+10](斩铁)、饰品·护心玉佩[HP+100]');
        assert.equal(parsed.length, 2);
        assert.equal(parsed[0].slot, EQUIP_SLOT.WEAPON);
        assert.equal(parsed[0].name, '青莲剑');
        assert.deepEqual(parsed[0].bonuses, { Atk: 30, Speed: 10 });
        assert.equal(parsed[0].effect, '斩铁');
        assert.equal(parsed[1].slot, EQUIP_SLOT.ACCESSORY);
        assert.deepEqual(parsed[1].bonuses, { HP: 100 });
    });

    it('整表序列化 → 解析后装备不丢（往返）', () => {
        const system = normalizePowerSystem({
            allies: [
                normalizeCombatant({
                    name: '甲',
                    side: 'ally',
                    weapons: ['【青莲剑】[Atk:+30]'],
                    accessories: ['【护心玉佩】[HP:+100]'],
                }),
            ],
            enemies: [normalizeCombatant({ name: '敌', side: 'enemy', weapons: ['【断刀】[Atk:+12]'] })],
        });
        const text = toCombatBlock(system);
        assert.ok(text.includes('青莲剑'), '导出的文本里应当有武器');
        assert.ok(text.includes('护心玉佩'), '导出的文本里应当有饰品');

        const equipmentLines = text.split('\n').filter((l) => l.includes('装备'));
        assert.equal(equipmentLines.length, 2, `应当有 2 行装备信息，实际 ${equipmentLines.length}`);
    });
});

describe('增量更新里的装备', () => {
    it('获得新装备会被合并进去并记入变更', () => {
        const system = normalizePowerSystem({
            allies: [normalizeCombatant({ name: '甲', side: 'ally' })],
            enemies: [normalizeCombatant({ name: '敌', side: 'enemy' })],
        });
        const result = applyDiff(system, {
            updated: [{ name: '甲', equipment: [{ name: '青莲剑', slot: 'weapon', bonuses: { Atk: 30 } }] }],
        });
        const unit = system.combatants.find((u) => u.name === '甲');
        assert.equal(unit.equipment.length, 1);
        assert.equal(unit.equipment[0].name, '青莲剑');
        assert.ok(result.applied.some((c) => c.includes('装备')), `变更说明里应当提到装备：${result.applied}`);
    });

    it('失去装备时列表被清空', () => {
        const system = normalizePowerSystem({
            allies: [normalizeCombatant({ name: '甲', side: 'ally', weapons: ['剑'] })],
            enemies: [normalizeCombatant({ name: '敌', side: 'enemy' })],
        });
        assert.equal(system.combatants.find((u) => u.name === '甲').equipment.length, 1);

        applyDiff(system, { updated: [{ name: '甲', equipment: [] }] });
        assert.equal(system.combatants.find((u) => u.name === '甲').equipment.length, 0, '空数组应当清空装备');
    });

    it('空数组不会产生「装备变化」的噪音记录', () => {
        const system = normalizePowerSystem({
            allies: [normalizeCombatant({ name: '甲', side: 'ally' })],
            enemies: [normalizeCombatant({ name: '敌', side: 'enemy' })],
        });
        const result = applyDiff(system, { updated: [{ name: '甲', equipment: [] }] });
        assert.ok(!result.applied.some((c) => c.includes('装备')), '本来就没装备，不该记成变更');
    });

    it('未提装备时保持原样（模型只报属性变化不该清空装备）', () => {
        const system = normalizePowerSystem({
            allies: [normalizeCombatant({ name: '甲', side: 'ally', weapons: ['【青莲剑】'] })],
            enemies: [normalizeCombatant({ name: '敌', side: 'enemy' })],
        });
        applyDiff(system, { updated: [{ name: '甲', attributes: { HP: { current: 50, max: 100 } } }] });
        const unit = system.combatants.find((u) => u.name === '甲');
        assert.equal(unit.equipment.length, 1, '没提装备就不该动它');
        assert.equal(unit.equipment[0].name, '青莲剑');
    });
});
