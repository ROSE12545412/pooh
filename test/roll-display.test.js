import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { AppController } from '../src/app.js';
import { Battle } from '../src/combat/engine.js';
import { hitPenaltyPreview, skillMechanicsText } from '../src/combat/preview.js';
import { normalizePowerSystem } from '../src/core/schema.js';
import { pickMainRoll } from '../src/ui/dice.js';
import { renderBattleBrief, renderBatchBrief } from '../src/llm/decider.js';

function fixture(ruleset) {
    const ctx = { name1: '玩家', chatMetadata: {}, extensionSettings: {}, saveSettingsDebounced() {}, async saveMetadata() {} };
    const app = new AppController(ctx);
    const system = normalizePowerSystem({ combatants: [
        { name: '玩家', side: 'ally', isUser: true, skills: [{ id: 'strike', name: '定向打击', aim: 130, power: 5 }],
            attributes: { HP: 1000, MP: 100, Atk: 20, Armor: 0, Speed: 1, Evasion: 10 } },
        { name: '对手', side: 'enemy', attributes: { HP: 1000, MP: 100, Atk: 20, Armor: 0, Speed: 1, Evasion: 10 } },
    ] });
    app.battle = new Battle(system, { seed: 'roll-display', ...(ruleset ? { ruleset } : {}) });
    app.battle.start();
    app.battle.turnIndex = app.battle.initiative.findIndex(entry => entry.name === '玩家');
    app.settings.battle.decideMode = 'off';
    app.settings.battle.showDice = false;
    app.settings.battle.userUnitName = '玩家';
    // Only prevent the next turn's scheduling: the controller and engine resolve normally.
    app._maybeContinueAutoDrive = () => {};
    app.battle.rng.next = () => 0.55;
    return app;
}

describe('出手快照贯通控制器与骰子显示', () => {
    it('实际行动之后保留骰点、总值、DC、修正和原出手人，下一回合不改名', async () => {
        const app = fixture();
        const target = app.battle.units.find(unit => unit.name === '对手');
        const result = await app.act({ action: 'skill', skillId: 'strike', targetIds: [target.id] });
        assert.equal(result.ok, true);
        assert.equal(app.battle.currentUnit.name, '对手');
        const display = app.displayRoll;
        assert.equal(display.actorName, '玩家');
        assert.equal(display.targetName, '对手');
        assert.equal(display.skillName, '定向打击');
        assert.equal(display.value, 12);
        assert.equal(display.total, 15);
        assert.equal(display.target, 10);
        assert.equal(display.outcome, 'hit');
        assert.equal(display.modifiers.reduce((sum, part) => sum + part.value, 0), 3);
        const saved = app.data.battle;
        const restored = Battle.fromState(saved);
        const replay = pickMainRoll(restored.log);
        assert.equal(replay.total, display.total);
        assert.deepEqual(replay.modifiers, display.modifiers);
        assert.equal(replay.actorName, '玩家');
    });

    it('防御等不掷骰的动作不残留上次的命中总值', async () => {
        const app = fixture();
        app.displayRoll = { value: 20, total: 28, target: 10, actorName: '旧角色' };
        assert.equal((await app.act({ action: 'defend' })).ok, true);
        assert.equal(app.displayRoll.value, 0);
        assert.equal(app.displayRoll.actorName, '玩家');
        assert.equal(app.displayRoll.total, undefined);
    });

    it('范围攻击保留各次命中明细，主结果只选本次新增记录', () => {
        const hit = { nat: 12, dieFaces: 20, total: 15.25, target: 14.5, outcome: 'hit', actorName: '甲', modifiers: [{ source: '技能命中', value: 3.25 }] };
        const logs = [
            { i: 0, data: { hit: { ...hit, nat: 1, outcome: 'fumble' } } },
            { i: 1, data: { hit: { ...hit, targetName: '乙' }, skillName: '群攻' } },
            { i: 2, data: { hit: { ...hit, targetName: '丙', target: 17, outcome: 'miss' }, skillName: '群攻' } },
        ];
        const result = pickMainRoll(logs, 1);
        assert.equal(result.skillName, '群攻');
        assert.equal(result.targetName, '丙');
        assert.equal(result.total, 15.25);
        assert.deepEqual(result.relatedRolls.map(roll => roll.targetName), ['乙', '丙']);
        assert.equal(pickMainRoll(logs, 3), null);
    });

    it('下一行动者的额外豁免独立于主命中，保留全部真实骰点', () => {
        const hit = { nat: 15, dieFaces: 20, total: 17, target: 10, outcome: 'hit', actorName: '玩家' };
        const control = { checkKind: 'control', actorName: '对手', skillName: '束缚', nat: 2, total: -1,
            target: 12, outcome: 'miss', success: false, modifiers: [{ source: '失衡', value: -3 }] };
        const dot = { ...control, checkKind: 'dot', skillName: '灼热', nat: 20, total: 17, outcome: 'hit', success: true, override: 'crit' };
        const logs = [
            { i: 0, data: { hit, skillName: '复合技', damage: { damage: 20, aoeFalloff: { from: 40, to: 20, factor: .5, targets: 4 } } } },
            { i: 1, text: '对手跳过行动', data: { check: control, name: '束缚', value: 0 } },
            { i: 2, text: '对手免除持续伤害', data: { check: dot, name: '灼热', value: 0 } },
        ];
        const main = pickMainRoll(logs);
        assert.equal(main.actorName, '玩家');
        assert.equal(main.nat, 15);
        assert.deepEqual(main.turnChecks.map(check => check.nat), [2, 20]);
        assert.equal(main.aoeFalloff.factor, .5);
        assert.equal(pickMainRoll(logs, 1).actorName, '对手');
        assert.equal(pickMainRoll(logs, 1).checkKind, 'dot');
        assert.equal(pickMainRoll(logs, 1).turnChecks.length, 1);
    });

    it('掷骰前按来源显示堆叠扣点，不消耗RNG；自定义公式没有hitBonus时不谎称生效', () => {
        const app = fixture();
        const unit = app.battle.currentUnit;
        unit.statuses = [
            { name: '迟滞', type: 'debuff', duration: 2, stacks: 2, modifiers: [{ attr: 'hit', delta: -2 }] },
            { name: '专注', type: 'buff', duration: 2, stacks: 1, modifiers: [{ attr: 'hit', delta: 1 }] },
        ];
        const before = app.battle.rng.snapshot();
        const preview = hitPenaltyPreview(unit, app.battle.ruleset);
        assert.equal(preview.penalty, -4);
        assert.equal(preview.netModifier, -3);
        assert.equal(preview.parts.length, 1);
        assert.ok(preview.parts[0].source.includes('迟滞'));
        assert.equal(preview.appliesToHit, true);
        assert.equal(hitPenaltyPreview(unit, { hitFormula: 'd20' }).appliesToHit, false);
        assert.deepEqual(app.battle.rng.snapshot(), before);
        assert.match(skillMechanicsText({ target: 'group', effects: [{ type: 'control', duration: 2, saveDc: 14 }] }, app.battle.ruleset).join(' '), /DC 14/);
    });

    it('单人和批量AI都能看到真实控制、持续伤害、减益与合法目标，不预掷骰', () => {
        const app = fixture();
        const battle = app.battle;
        battle.currentUnit.skills = [{ id: 'control', name: '复合术', power: 0, target: 'group', effects: [
            { type: 'control', duration: 2, saveDc: 14 },
            { type: 'dot', power: 8, duration: 3, saveDc: 12 },
            { type: 'debuff', duration: 2, modifiers: [{ attr: 'hit', delta: -2 }] },
        ] }];
        const state = JSON.stringify(battle.toState());
        for (const brief of [renderBattleBrief(battle), renderBatchBrief(battle, [battle.currentUnit])]) {
            for (const text of ['AOE', '控制', '持续伤害', '骰点减益', 'DC 14', 'DC 12', '合法目标：对手']) {
                assert.ok(brief.includes(text), `简报缺少 ${text}`);
            }
        }
        assert.equal(JSON.stringify(battle.toState()), state);
    });

    it('扁平自定义判定仍保留概率、公式与实际骰面，不裁切为d20', () => {
        const input = { nat: 78, dieFaces: 100, hitMode: 'chance', total: 0.28, target: 0.6,
            formula: 'Aim/(Speed+Aim)', variables: { Aim: 30, Speed: 20 }, outcome: 'hit', modifiers: null };
        const result = pickMainRoll([{ i: 0, data: input }]);
        for (const [key, value] of Object.entries(input)) assert.deepEqual(result[key], value);
    });
});
