/**
 * 「玩家自己的角色」的归属测试。
 *
 * 用户的原话：「接」—— 把 `isUser` 接到批量决策上，让**队友交给 AI、我自己那一手我自己操作**。
 *
 * 这里测的是这条链路上的三个关键点：
 *  - 批量决策必须**排除**玩家单位（否则 AI 会替你做决定）
 *  - 数据被重建后标记要能恢复（靠持久化的名字，不靠内存标记）
 *  - 没指定玩家时必须**明说**，而不是默默把你的角色也交给 AI
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { defaultSettings } from '../src/config.js';
import { normalizeCombatant, normalizePowerSystem } from '../src/core/schema.js';

/** 用最小桩复刻 AppController 里的用户判定逻辑，行为与源码一致。 */
function makeHarness() {
    const settings = defaultSettings();
    const markedNames = new Set();

    const app = {
        settings,
        ctx: { name1: '' },
        log: () => {},
        notify: () => {},
        /** 与 src/app.js 的 isUserUnit 一致 */
        isUserUnit(unit) {
            if (!unit) return false;
            if (unit.isUser) return true;
            const remembered = String(settings.battle.userUnitName ?? '').trim();
            if (!remembered) return false;
            return String(unit.name ?? '') === remembered;
        },
        /** 与 src/app.js 的 markUserUnit 一致 */
        markUserUnit(system) {
            const combatants = system?.combatants ?? [];
            if (!combatants.length) return null;
            const marked = combatants.filter((u) => u.isUser);
            if (marked.length >= 1) {
                for (const u of combatants) u.isUser = u === marked[0];
                return { name: marked[0].name, via: 'marker' };
            }
            const remembered = String(settings.battle.userUnitName ?? '').trim();
            if (remembered) {
                const hit = combatants.find((u) => String(u.name ?? '') === remembered);
                if (hit) {
                    hit.isUser = true;
                    return { name: hit.name, via: 'remembered' };
                }
            }
            const persona = String(app.ctx?.name1 ?? '').trim();
            if (persona) {
                const hit = combatants.find((u) => String(u.name ?? '') === persona || String(u.name ?? '').includes(persona));
                if (hit) {
                    hit.isUser = true;
                    return { name: hit.name, via: 'persona' };
                }
            }
            return null;
        },
        /** 从 planRound 里抽出的「该交给 AI 的单位」逻辑 */
        unitsForAi(battle, side) {
            const allAlive = battle.units.filter((u) => u.side === side && u.alive);
            let units = allAlive;
            let skippedUser = '';
            if (side === 'ally') {
                const userUnit = allAlive.find((u) => app.isUserUnit(u));
                if (userUnit) {
                    units = allAlive.filter((u) => u !== userUnit);
                    skippedUser = userUnit.name;
                }
            }
            return { units, skippedUser, allAlive };
        },
    };
    void markedNames;
    return app;
}

/** 造一场「玩家 + 两个队友 vs 两个敌人」的战斗。 */
function makeBattle(userIsMarked = false) {
    const combatants = [
        normalizeCombatant({ name: '我', side: 'ally', attributes: { HP: { current: 100, max: 100 } } }),
        normalizeCombatant({ name: '队友甲', side: 'ally', attributes: { HP: { current: 100, max: 100 } } }),
        normalizeCombatant({ name: '队友乙', side: 'ally', attributes: { HP: { current: 100, max: 100 } } }),
        normalizeCombatant({ name: '敌1', side: 'enemy', attributes: { HP: { current: 100, max: 100 } } }),
        normalizeCombatant({ name: '敌2', side: 'enemy', attributes: { HP: { current: 100, max: 100 } } }),
    ];
    if (userIsMarked) combatants[0].isUser = true;
    const system = normalizePowerSystem({ combatants });
    return { id: 'b1', round: 1, units: system.combatants, currentUnit: system.combatants[0], log: [] };
}

describe('批量决策排除玩家单位', () => {
    it('标了 isUser 时，AI 只接管队友', () => {
        const app = makeHarness();
        const battle = makeBattle(true);
        const { units, skippedUser } = app.unitsForAi(battle, 'ally');
        assert.equal(skippedUser, '我', '应当报告排除了谁');
        assert.deepEqual(
            units.map((u) => u.name).sort(),
            ['队友乙', '队友甲'],
            'AI 应当只拿到两个队友',
        );
        assert.ok(!units.some((u) => u.name === '我'), '绝不能把玩家单位交给 AI');
    });

    it('没标 isUser 但设置里记住了名字，同样排除', () => {
        const app = makeHarness();
        app.settings.battle.userUnitName = '我';
        const battle = makeBattle(false);
        const { units, skippedUser } = app.unitsForAi(battle, 'ally');
        assert.equal(skippedUser, '我');
        assert.equal(units.length, 2);
    });

    it('数据被重建后（isUser 丢了）靠名字恢复标记', () => {
        const app = makeHarness();
        app.settings.battle.userUnitName = '我';
        const battle = makeBattle(false);
        assert.equal(battle.units[0].isUser, false, '前置条件：标记确实丢了（归一化会补成 false）');
        const who = app.markUserUnit({ combatants: battle.units });
        assert.equal(who?.name, '我');
        assert.equal(who?.via, 'remembered', '应当说明是靠记住的名字恢复的');
        assert.equal(battle.units[0].isUser, true);
    });

    it('数据自带标记时优先用标记', () => {
        const app = makeHarness();
        app.settings.battle.userUnitName = '队友甲';
        const battle = makeBattle(true);
        const who = app.markUserUnit({ combatants: battle.units });
        assert.equal(who?.name, '我', '标记优先于记住的名字');
        assert.equal(who?.via, 'marker');
    });

    it('都没有时退回 persona 名字', () => {
        const app = makeHarness();
        app.ctx.name1 = '队友乙';
        const battle = makeBattle(false);
        const who = app.markUserUnit({ combatants: battle.units });
        assert.equal(who?.name, '队友乙');
        assert.equal(who?.via, 'persona');
    });

    it('啥都没有时返回 null（不猜）', () => {
        const app = makeHarness();
        const battle = makeBattle(false);
        assert.equal(app.markUserUnit({ combatants: battle.units }), null);
    });

    it('敌方永远整个交给 AI（不受玩家单位影响）', () => {
        const app = makeHarness();
        app.settings.battle.userUnitName = '我';
        const battle = makeBattle(true);
        const { units, skippedUser } = app.unitsForAi(battle, 'enemy');
        assert.equal(units.length, 2, '两个敌人都在');
        assert.equal(skippedUser, '', '敌方不该有「跳过玩家」这回事');
    });

    it('我方只剩玩家一人时，AI 拿不到任何单位', () => {
        const app = makeHarness();
        const battle = makeBattle(true);
        for (const u of battle.units) if (u.side === 'ally' && u.name !== '我') u.alive = false;
        const { units, skippedUser } = app.unitsForAi(battle, 'ally');
        assert.equal(units.length, 0, '不该把玩家自己交给 AI');
        assert.equal(skippedUser, '我');
    });
});

describe('源码里的连线（静态检查防回退）', () => {
    const appSource = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');

    it('planRound 里确实按 isUserUnit 做了排除', () => {
        assert.ok(appSource.includes('this.isUserUnit(u)'), 'planRound 必须查玩家单位');
        assert.ok(
            /units = allAlive\.filter\([\s\S]{0,120}?!== userUnit\)/.test(appSource),
            '必须把玩家单位从 AI 名单里剔除',
        );
    });

    it('数据重建后重新标记玩家（否则标记会丢）', () => {
        const calls = (appSource.match(/this\.markUserUnit\(/g) || []).length;
        // 开战走的是 replacePowerSystem，所以「数据被重建」的两条主路径就够了
        assert.ok(calls >= 2, `数据重建的两条主路径都应重新标记，实际只有 ${calls} 处`);
    });

    it('玩家单位名会持久化（跨战斗记住）', () => {
        assert.ok(appSource.includes('settings.battle.userUnitName = resolved.unit.name'), '识别成功后要存名字');
        assert.ok(appSource.includes('async setUserUnit('), '要有手动指定入口');
    });

    it('act() 里玩家自己选了行动时不吃队列决策', () => {
        assert.ok(appSource.includes('playerChose'), '必须有「玩家是否明确指定了这一手」的判断');
        assert.ok(
            /!playerChose/.test(appSource),
            '玩家选了就不能用队列里的决策顶掉它',
        );
    });
});

describe('配置默认值', () => {
    it('队友默认交给 AI', () => {
        assert.equal(defaultSettings().battle.aiControlsAllies, true);
    });

    it('玩家单位名默认为空（等待运行时识别）', () => {
        assert.equal(defaultSettings().battle.userUnitName, '');
    });
});
