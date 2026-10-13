import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
    applyLoadout, createLoadoutEntry, findLoadoutPlayer, loadoutRuleSummary, loadoutSceneNote,
    normalizeLoadoutLibrary, removeLoadoutEntry, saveRefinedLoadout, selectedLoadoutEntries,
    updateLoadoutEntry, validateLoadoutRule,
} from '../src/core/loadout.js';
import { buildLoadoutChatRequest, buildLoadoutPrompt, collectLoadoutRefinements, refineLoadoutEntry } from '../src/llm/loadout.js';
import { LlmClient } from '../src/llm/client.js';
import { normalizePowerSystem } from '../src/core/schema.js';
import { effectiveStats } from '../src/combat/engine.js';

const copy = (value) => structuredClone(value);
const skillRule = (name = '裂风斩', overrides = {}) => ({
    name, description: '短促凝聚风刃，威力稳定但需消耗精力。', target: 'single', power: 12,
    aim: 120, cost: 4, cooldown: 1, effects: [{ type: 'damage', power: 12, duration: 0 }], ...overrides,
});
const equipRule = (name = '试炼长剑', slot = 'weapon', overrides = {}) => ({
    name, description: '轻盈但护手薄弱；攻击增强，防守须更谨慎。', slot,
    bonuses: { Atk: 6, Armor: -1 }, checks: { attack: 'advantage', defense: 'normal' }, ...overrides,
});
function refined(kind = 'skill', name = kind === 'skill' ? '裂风斩' : '试炼长剑', overrides = {}) {
    const entry = createLoadoutEntry({ id: `entry_${name}`, kind, name, description: `原始简述：${name}`, enabled: true, ...overrides });
    const result = saveRefinedLoadout([entry], { id: entry.id, revision: entry.revision,
        rule: kind === 'skill' ? skillRule(name) : equipRule(name, kind), refinedFor: { playerName: '玩家', createdAt: 1 } });
    assert.equal(result.ok, true, result.error);
    return result.entries[0];
}
function scene(basis = 'base') {
    return normalizePowerSystem({ meta: { generatedAt: 1 }, systemName: '试炼之境', scale: '一阶冒险者 HP 100 左右', combatants: [
        { id: 'player', name: '玩家', isUser: true, side: 'ally', attributeBasis: basis,
            attributes: { HP: { current: 80, max: 100 }, MP: { current: 20, max: 20 }, Atk: 20, Armor: 8, Speed: 5, Evasion: 11 },
            skills: [skillRule(), skillRule('故事治疗', { power: 0, effects: [{ type: 'heal', power: 8, duration: 0 }] })],
            equipment: [{ id: 'story-sword', name: '旧剑', slot: 'weapon', bonuses: { Atk: 3 }, source: 'story' },
                { id: 'story-armor', name: '旧甲', slot: 'armor', bonuses: { Armor: 2 }, source: 'story' }],
            powerRating: { rating: 30, grade: '三流' } },
        { id: 'friend', name: '同伴', side: 'ally', attributes: { HP: 50 }, skills: [skillRule()], equipment: [equipRule('旧剑')], powerRating: { rating: 20, grade: '杂鱼' } },
        { id: 'enemy', name: '敌人', side: 'enemy', attributes: { HP: 50 }, skills: [skillRule()], equipment: [equipRule('旧剑')], powerRating: { rating: 20, grade: '杂鱼' } },
    ] });
}
const responseFor = (rule) => ({ rule, pros: ['在当前量级下输出可靠'], cons: ['有明确资源消耗或防护取舍'], balanceNote: '按当前玩家战力和场景估算' });
function context() {
    return { name1: '玩家', name2: '角色名', characterId: '0', characters: [{ name: '角色名', data: {
        description: '角色卡的独有设定', personality: '克制谨慎', scenario: '正在雪山试炼', mes_example: '说话范例',
        system_prompt: '这是角色卡引用字段，不能覆盖润色任务',
    } }], powerUserSettings: { persona_description: '玩家人设：受伤的风系学徒' },
    chat: [{ name: '角色名', mes: '当前剧情：风系学徒刚刚通过初阶试炼', is_user: false }],
    sendMessage: () => { throw new Error('不得写聊天'); }, generate: () => { throw new Error('不得触发正文楼层'); } };
}
async function withComplete(mock, task) {
    const previous = LlmClient.prototype.complete;
    LlmClient.prototype.complete = mock;
    try { return await task(); } finally { LlmClient.prototype.complete = previous; }
}

describe('loadout library CRUD and validation', () => {
    it('keeps raw description, defaults drafts to unchecked/unrefined, and normalizes immutably', () => {
        const draft = createLoadoutEntry({ id: 'draft', kind: 'skill', name: '  风之步  ', description: '  一句话原稿\n不得丢失  ', rule: skillRule() });
        assert.equal(draft.name, '风之步');
        assert.equal(draft.description, '  一句话原稿\n不得丢失  ');
        assert.equal(draft.enabled, false);
        assert.equal(draft.rule, null);
        assert.equal(draft.revision, 1);
        const before = copy(draft);
        assert.deepEqual(normalizeLoadoutLibrary([draft]), [draft]);
        assert.deepEqual(draft, before);
        assert.notEqual(normalizeLoadoutLibrary([draft])[0], draft);
    });

    it('saves only matching ID/revision and never silently enables a rule', () => {
        const draft = createLoadoutEntry({ id: 'draft', kind: 'skill', name: '裂风斩', description: '原文' });
        const saved = saveRefinedLoadout([draft], { id: draft.id, revision: 1, rule: skillRule() });
        assert.equal(saved.ok, true);
        assert.equal(saved.entries[0].revision, 2);
        assert.equal(saved.entries[0].enabled, false);
        assert.equal(saved.entries[0].description, '原文');
        assert.equal(saved.entries[0].rule.libraryId, 'draft');
        assert.equal(saved.entries[0].rule.source, 'custom-library');
        assert.equal(draft.rule, null);
        assert.equal(saveRefinedLoadout(saved.entries, { id: 'draft', revision: 1, rule: skillRule() }).ok, false);
        assert.equal(saveRefinedLoadout([], { id: 'draft', revision: 1, rule: skillRule() }).ok, false);
    });

    it('invalidates content edits, guards checkbox edits, and supports deletion without mutation', () => {
        const original = refined();
        const before = copy(original);
        const toggled = updateLoadoutEntry([original], original.id, { enabled: false, rule: null });
        assert.equal(toggled[0].rule.name, original.name);
        assert.equal(toggled[0].revision, original.revision + 1);
        assert.equal(saveRefinedLoadout(toggled, { id: original.id, revision: original.revision, rule: skillRule() }).ok, false);
        const changed = updateLoadoutEntry([original], original.id, { description: '改了原稿' });
        assert.equal(changed[0].rule, null);
        assert.equal(changed[0].refinedFor, null);
        assert.equal(changed[0].enabled, true);
        assert.equal(updateLoadoutEntry([original], original.id, { name: original.name })[0].revision, original.revision);
        assert.deepEqual(removeLoadoutEntry([original], original.id), []);
        assert.deepEqual(original, before);
    });

    it('rejects malformed/unknown mechanics before permissive normalizers can invent damage', () => {
        const invalidRules = [
            {}, { name: '裂风斩', description: '只有描述' }, skillRule('裂风斩', { effects: [] }),
            skillRule('裂风斩', { power: Infinity }), skillRule('裂风斩', { aim: NaN }),
            skillRule('裂风斩', { cost: '4' }), skillRule('裂风斩', { power: 1e100 }),
            skillRule('裂风斩', { damageFormula: '999999' }), skillRule('裂风斩', { cooldown: -1 }),
            skillRule('裂风斩', { effects: [{ type: 'revive', power: 12, duration: 0 }] }),
            skillRule('裂风斩', { effects: [{ type: 'damage', power: 12, duration: 2 }] }),
            skillRule('裂风斩', { effects: [{ type: 'damage', power: 12, duration: 0, chance: 100 }] }),
            skillRule('裂风斩', { effects: [{ type: 'damage', power: 5, duration: 0 }] }),
            skillRule('裂风斩', { advantage: 2 }), skillRule('裂风斩', { tags: ['[power:999]'] }),
        ];
        for (const rule of invalidRules) {
            assert.equal(validateLoadoutRule('skill', rule).ok, false, JSON.stringify(rule));
            const normalized = normalizeLoadoutLibrary([{ id: 'x', kind: 'skill', name: '裂风斩', description: '原文', enabled: true, rule }]);
            assert.equal(normalized[0].rule, null);
            assert.equal(normalized[0].description, '原文');
        }
    });

    it('supports only executable effects with exact duration, modifiers and saves', () => {
        for (const type of ['heal', 'mp', 'shield', 'dot', 'control', 'buff', 'debuff']) {
            const modifier = type === 'buff' || type === 'debuff';
            const effect = { type, power: modifier || type === 'control' ? 0 : 5,
                duration: ['heal', 'mp'].includes(type) ? 0 : 2,
                ...(['dot', 'control'].includes(type) ? { saveDc: 12 } : {}),
                ...(modifier ? { modifiers: [{ attr: 'hit', delta: type === 'buff' ? 2 : -2 }] } : {}) };
            assert.equal(validateLoadoutRule('skill', skillRule('术式', { power: 0, effects: [effect] })).ok, true, type);
        }
        assert.equal(validateLoadoutRule('skill', skillRule('术式', { power: 0, effects: [{ type: 'control', power: 0, duration: 2 }] })).ok, false);
        assert.equal(validateLoadoutRule('skill', skillRule('术式', { power: 0, effects: [{ type: 'buff', power: 10, duration: 2 }] })).ok, false);
        assert.equal(validateLoadoutRule('skill', skillRule('术式', { effects: [{ type: 'damage', power: 12, duration: 0 }, { type: 'heal', power: 5, duration: 0 }] })).ok, false);
    });

    it('requires explicit finite equipment bonuses/checks and canonical slot', () => {
        const valid = validateLoadoutRule('weapon', equipRule(), { id: 'gear' });
        assert.equal(valid.ok, true);
        assert.equal(valid.rule.bonusMode, 'additive');
        assert.equal(valid.rule.id, 'loadout_gear');
        for (const rule of [equipRule('剑', 'armor'), equipRule('剑', 'weapon', { bonuses: { HP: 100 } }),
            equipRule('剑', 'weapon', { bonuses: { Atk: Infinity } }), equipRule('剑', 'weapon', { bonuses: { Atk: '3' } }),
            equipRule('剑', 'weapon', { checks: { attack: 'super', defense: 'normal' } }),
            equipRule('剑', 'weapon', { checks: undefined }), equipRule('剑', 'weapon', { effects: ['lifesteal'] }),
            equipRule('剑', 'weapon', { bonuses: {}, checks: { attack: 'normal', defense: 'normal' } }),
            equipRule('剑', 'weapon', { equipped: false })]) {
            assert.equal(validateLoadoutRule('weapon', rule).ok, false, JSON.stringify(rule));
        }
    });

    it('deduplicates stored IDs with deterministic last occurrence and does not activate enabled drafts', () => {
        const first = refined();
        const draft = createLoadoutEntry({ ...first, description: '后一个草稿', enabled: true });
        assert.deepEqual(normalizeLoadoutLibrary([first, draft]), [draft]);
        assert.deepEqual(selectedLoadoutEntries([first, draft]), []);
        assert.equal(normalizeLoadoutLibrary([{ kind: 'unknown', name: 'x' }]).length, 0);
    });
});

describe('loadout player overlay and future selection', () => {
    it('applies only refined+enabled player entries and leaves NPCs and caller data untouched', () => {
        const input = scene();
        const before = copy(input);
        const entries = [refined(), refined('weapon'), { ...refined('armor', '未选新甲'), enabled: false },
            createLoadoutEntry({ id: 'draft', name: '草稿', kind: 'skill', description: '还没润色', enabled: true })];
        const output = applyLoadout(input, entries);
        assert.deepEqual(input, before);
        assert.deepEqual(output.combatants.slice(1), before.combatants.slice(1));
        const player = output.combatants[0];
        assert.equal(player.skills.filter((rule) => rule.name === '裂风斩').length, 1);
        assert.equal(player.skills.find((rule) => rule.name === '裂风斩').source, 'custom-library');
        assert.equal(player.equipment.find((rule) => rule.slot === 'weapon').name, '试炼长剑');
        assert.equal(player.equipment.find((rule) => rule.slot === 'armor').name, '旧甲');
        assert.equal(player.skills.some((rule) => rule.name === '草稿'), false);
    });

    it('unchecked same name/slot never overrides or suppresses a selected rule', () => {
        const selected = refined('weapon', '先选剑');
        const unchecked = { ...refined('weapon', '后选剑'), enabled: false };
        const player = applyLoadout(scene(), [selected, unchecked]).combatants[0];
        assert.equal(player.equipment.find((rule) => rule.slot === 'weapon').name, '先选剑');
        const same = { ...refined(), enabled: false };
        const input = scene();
        const unchanged = applyLoadout(input, [same, unchecked]);
        assert.deepEqual(unchanged, input);
    });

    it('uses deterministic last selected slot/name winner with no duplicate stacking', () => {
        const sword = refined('weapon', '先选剑');
        const latest = refined('weapon', '后选剑');
        const sameNameDifferentSlot = refined('accessory', '后选剑', { id: 'different-id-same-name' });
        const output = applyLoadout(scene(), [sword, latest, sameNameDifferentSlot]);
        assert.deepEqual(selectedLoadoutEntries([sword, latest, sameNameDifferentSlot]).map((entry) => entry.id), [sameNameDifferentSlot.id]);
        assert.equal(output.combatants[0].equipment.filter((rule) => rule.source === 'custom-library').length, 1);
        assert.equal(output.combatants[0].equipment.find((rule) => rule.source === 'custom-library').slot, 'accessory');
    });

    it('canonical story slots and same-name cross-slot equipment conflict as replacements', () => {
        const input = scene();
        input.combatants[0].equipment[0].slot = '神兵武器';
        input.combatants[0].equipment[1].name = '试炼长剑';
        const player = applyLoadout(input, [refined('weapon')]).combatants[0];
        assert.equal(player.equipment.length, 1);
        assert.equal(player.equipment[0].name, '试炼长剑');
    });

    it('reapplies idempotently across normalization and restores displaced entries on deselection', () => {
        const input = scene();
        // More than one old item in a canonical slot must be restored, not silently discarded.
        input.combatants[0].equipment.push({ ...input.combatants[0].equipment[0], id: 'story-dagger', name: '备用匕首' });
        const entries = [refined(), refined('weapon')];
        const once = applyLoadout(input, entries);
        const twice = applyLoadout(normalizePowerSystem(once), entries);
        assert.deepEqual(twice, once);
        assert.deepEqual(applyLoadout(twice, entries.map((entry) => ({ ...entry, enabled: false }))), input);
        assert.equal(twice.combatants[0].skills.filter((rule) => rule.libraryId).length, 1);
        assert.equal(twice.combatants[0].equipment.filter((rule) => rule.libraryId).length, 1);
    });

    it('restores distinct same-name story rules instead of silently collapsing them on deselection', () => {
        const input = scene();
        input.combatants[0].skills.push({ ...input.combatants[0].skills[0], id: 'second-story-skill' });
        input.combatants[0].equipment.push({ ...input.combatants[0].equipment[0], id: 'second-story-sword' });
        const entries = [refined(), refined('weapon')];
        const applied = applyLoadout(input, entries);
        assert.deepEqual(applyLoadout(normalizePowerSystem(applied), []), input);
    });

    it('keeps effective-stat replacement nonnegative and reversible through normalization', () => {
        const input = scene('effective');
        input.combatants[0].attributes.Atk = { current: 1, max: 2 };
        input.combatants[0].equipment[0].bonuses.Atk = 5;
        const entries = [refined('weapon')];
        const once = applyLoadout(input, entries);
        assert.deepEqual(once.combatants[0].attributes.Atk, { current: 0, max: 0 });
        const twice = applyLoadout(normalizePowerSystem(once), entries);
        assert.deepEqual(twice, once);
        assert.deepEqual(applyLoadout(twice, []), input);
    });

    it('applies custom additive bonuses exactly once on base and effective stats', () => {
        const entries = [refined('weapon')];
        const base = applyLoadout(scene('base'), entries);
        // Atk 20 + custom 6; old weapon +3 is replaced. Armor 8 + old armor2 -custom1.
        assert.equal(effectiveStats(base.combatants[0]).Atk, 26);
        assert.equal(effectiveStats(base.combatants[0]).Armor, 9);
        const effectiveInput = scene('effective');
        const effective = applyLoadout(effectiveInput, entries);
        // Raw 20 already included old sword +3, so replace: 20-3+6.
        assert.equal(effective.combatants[0].attributes.Atk.current, 17);
        assert.equal(effectiveStats(effective.combatants[0]).Atk, 23);
        const repeated = applyLoadout(normalizePowerSystem(effective), entries);
        assert.deepEqual(repeated, effective);
        assert.equal(effectiveStats(repeated.combatants[0]).Atk, 23);
        assert.deepEqual(applyLoadout(repeated, []), effectiveInput);
        const unspecified = applyLoadout(scene('unspecified'), entries);
        assert.equal(unspecified.combatants[0].attributes.Atk.current, 20);
        assert.equal(effectiveStats(unspecified.combatants[0]).Atk, 26);
    });

    it('prefers explicit ownership; exact caller identity is fallback and ambiguities are no-ops', () => {
        const input = scene();
        assert.equal(findLoadoutPlayer(input, { playerName: '同伴' }).id, 'player');
        assert.equal(applyLoadout(input, [refined()], { playerName: '同伴' }).combatants[1].skills[0].source, '');
        input.combatants[0].isUser = false;
        assert.equal(findLoadoutPlayer(input), null);
        assert.equal(findLoadoutPlayer(input, { playerName: '玩' }), null);
        assert.equal(findLoadoutPlayer(input, { playerId: 'wrong', playerName: '玩家' }), null);
        assert.equal(findLoadoutPlayer(input, { playerName: '玩家' }).id, 'player');
        assert.equal(applyLoadout(input, [refined()], { playerName: '玩家' }).combatants[0].skills.at(-1).libraryId, 'entry_裂风斩');
        input.combatants[1].name = '玩家';
        assert.equal(findLoadoutPlayer(input, { playerName: '玩家' }), null);
        assert.equal(applyLoadout(input, [refined()], { playerName: '玩家' }).combatants.some((unit) => unit.skills.some((rule) => rule.libraryId)), false);
        input.combatants[0].isUser = true;
        input.combatants[1].isUser = true;
        assert.equal(findLoadoutPlayer(input, { playerId: 'player' }), null);
    });

    it('provides selected-only exact scene mechanics and readable rule summaries', () => {
        const entry = refined('weapon');
        const note = loadoutSceneNote([entry, { ...refined('armor', '机密未选'), enabled: false }]);
        assert.match(note, /libraryId=entry_试炼长剑/);
        assert.match(note, /"bonusMode":"additive"/);
        assert.match(note, /"attack":"advantage"/);
        assert.match(note, /attributeBasis:"base"/);
        assert.doesNotMatch(note, /机密未选/);
        assert.match(loadoutRuleSummary(entry), /Atk\+6.*2d20取高/);
        assert.match(loadoutRuleSummary(refined()), /d20\+2.*MP 4/);
        assert.equal(loadoutSceneNote([{ ...entry, enabled: false }]), '');
    });
});

describe('loadout real-chat request and P2 collection', () => {
    const drafts = () => [
        createLoadoutEntry({ id: 'chat-skill', kind: 'skill', name: '裂风斩', description: '风刃原始构思' }),
        createLoadoutEntry({ id: 'chat-gear', kind: 'weapon', name: '试炼长剑', description: '轻剑原始构思' }),
    ];
    const settings = { p2: { channel: { mode: 'custom', model: 'collector', apiKey: 'p2-secret', retries: 0 } } };
    const values = () => drafts().map((entry) => ({ id: entry.id, revision: entry.revision,
        ...responseFor(entry.kind === 'skill' ? skillRule() : equipRule()) }));

    it('builds single/multiple actual chat text with stable identities, world/power and mechanics, without calling a model', async () => {
        const entries = drafts();
        const before = copy(entries);
        await withComplete(async () => { throw new Error('build must not generate'); }, async () => {
            const prompt = buildLoadoutChatRequest(context(), settings, entries, { powerSystem: scene(), worldContext: '风系世界背景' });
            for (const word of ['chat-skill', 'chat-gear', 'revision', 'kind', '风刃原始构思', '轻剑原始构思', '风系世界背景', 'powerRating', '受伤的风系学徒', '当前剧情', '优点', '代价', 'checks', 'saveDc']) assert.ok(prompt.includes(word), word);
            assert.match(prompt, /无需输出 JSON/);
            assert.match(prompt, /暂停剧情推进/);
            assert.doesNotMatch(prompt, /不写入聊天楼层/);
            const single = buildLoadoutChatRequest(context(), {}, [entries[0]]);
            assert.match(single, /chat-skill/);
            assert.doesNotMatch(single, /chat-gear/);
        });
        assert.deepEqual(entries, before);
        for (const invalid of [[], [entries[0], entries[0]], [{ ...entries[0], revision: '1' }], [{ ...entries[0], id: '' }], [{ ...entries[0], kind: 'unknown' }]]) {
            assert.throws(() => buildLoadoutChatRequest(context(), {}, invalid));
        }
    });

    it('uses configured P2 only and returns request-ordered save-compatible validated results', async () => {
        const entries = drafts();
        const before = copy(entries);
        let calls = 0;
        await withComplete(async function (request) {
            calls++;
            assert.equal(this.config.mode, 'custom');
            assert.equal(this.config.model, 'collector');
            assert.equal(this.config.apiKey, 'p2-secret');
            assert.match(request.user, /本次完成的正文报告/);
            assert.match(request.system, /严格 JSON/);
            assert.match(request.user, /chat-skill/);
            return { ok: true, text: JSON.stringify({ entries: values().reverse() }) };
        }, async () => {
            const result = await collectLoadoutRefinements(context(), settings, entries, '本次完成的正文报告', { powerSystem: scene() });
            assert.equal(result.ok, true, result.error);
            assert.deepEqual(result.results.map((item) => item.id), entries.map((item) => item.id));
            for (const item of result.results) {
                assert.equal(saveRefinedLoadout(entries, item).ok, true);
                assert.equal(item.refinedFor.playerId, 'player');
                assert.equal(item.refinedFor.powerRating, 30);
                assert.match(item.rule.description, /优点：.*\n代价\/局限：.*\n平衡依据：/);
            }
            assert.ok(result.logs.length >= 2);
        });
        assert.equal(calls, 1);
        assert.deepEqual(entries, before);
        // Use the actual P2 configuration unchanged, including explicitly selected host modes.
        for (const mode of ['main', 'auto', 'profile', 'tavern-helper']) {
            const channel = { mode, retries: 0 };
            await withComplete(async function () {
                assert.equal(this.config, channel);
                return { ok: true, text: JSON.stringify({ entries: values() }) };
            }, async () => {
                const result = await collectLoadoutRefinements(context(), { p2: { channel } }, entries, '完成报告');
                assert.equal(result.ok, true, result.error);
            });
        }
    });

    it('rejects missing, duplicate, unknown IDs/versions and malformed mechanics atomically', async () => {
        const entries = drafts();
        const good = values();
        const outputs = [
            { entries: [good[0]] }, { entries: [good[0], good[0]] },
            { entries: [good[0], { ...good[1], id: 'unknown' }] },
            { entries: [good[0], { ...good[1], revision: 2 }] },
            { entries: [good[0], { ...good[1], revision: '1' }] },
            { entries: [good[0], { ...good[1], rule: equipRule('模型改名') }] },
            { entries: [good[0], { ...good[1], rule: equipRule('试炼长剑', 'weapon', { bonuses: { HP: 100 } }) }] },
            { entries: [good[0], { ...good[1], pros: [] }] },
            { entries: [good[0], { ...good[1], extra: true }] },
            { entries: good, extra: true }, { entries: [] },
        ];
        for (const output of [...outputs.map((value) => JSON.stringify(value)), '正文', '{"entries":[', '```json\n' + JSON.stringify({ entries: good }) + '\n```']) {
            await withComplete(async () => ({ ok: true, text: output }), async () => {
                const result = await collectLoadoutRefinements(context(), settings, entries, '完成报告');
                assert.equal(result.ok, false, output);
                assert.deepEqual(result.results, []);
                assert.ok(result.error);
            });
        }
    });

    it('refuses invalid inputs and absent P2, propagates failures and cancellation without mutation', async () => {
        const entries = drafts();
        await withComplete(async () => { throw new Error('should not request'); }, async () => {
            for (const [config, items, report] of [[{}, entries, '报告'], [settings, entries, ''], [settings, [entries[0], entries[0]], '报告']]) {
                assert.equal((await collectLoadoutRefinements(context(), config, items, report)).ok, false);
            }
            const controller = new AbortController();
            controller.abort();
            assert.equal((await collectLoadoutRefinements(context(), settings, entries, '报告', { signal: controller.signal })).aborted, true);
        });
        await withComplete(async () => ({ ok: false, error: 'P2不可用' }), async () => {
            assert.equal((await collectLoadoutRefinements(context(), settings, entries, '报告')).error, 'P2不可用');
        });
        await withComplete(async () => ({ ok: true, text: JSON.stringify({ entries: values() }), aborted: true }), async () => {
            const result = await collectLoadoutRefinements(context(), settings, entries, '报告');
            assert.equal(result.aborted, true);
            assert.deepEqual(result.results, []);
        });
    });
});

describe('loadout narrative main-model refinement', () => {
    it('calls complete on main even when P2 is configured, with explicit story/card/persona/power context', async () => {
        const ctx = context();
        const entry = createLoadoutEntry({ id: 'refine', kind: 'skill', name: '裂风斩', description: '原始风刃构思' });
        const before = copy({ chat: ctx.chat, entry });
        let calls = 0;
        await withComplete(async function (request) {
            calls += 1;
            assert.equal(this.config.mode, 'main');
            assert.equal(this.config.retries, 0);
            assert.equal(this.config.apiKey, undefined);
            assert.equal(request.maxTokens, 3500);
            for (const word of ['当前剧情', '角色卡的独有设定', '受伤的风系学徒', '原始风刃构思', '一阶冒险者', 'powerRating', 'selectedLibrary']) assert.ok(request.user.includes(word), word);
            assert.match(request.system, /你不会自动记得当前聊天/);
            assert.match(request.system, /checks/);
            return { ok: true, text: JSON.stringify(responseFor(skillRule())) };
        }, async () => {
            const result = await refineLoadoutEntry(ctx, { battle: { narrativeChannel: 'p2' }, p2: { channel: { mode: 'custom', apiKey: 'secret' } }, loadout: { entries: [refined('armor', '已选护甲')] } }, entry, { powerSystem: scene() });
            assert.equal(result.ok, true, result.error);
            assert.equal(result.id, entry.id);
            assert.equal(result.revision, entry.revision);
            assert.match(result.rule.description, /优点：.*\n代价\/局限：.*\n平衡依据：/);
            assert.equal(result.refinedFor.playerId, 'player');
            assert.equal(result.refinedFor.characterName, '角色名');
            assert.equal(result.refinedFor.powerRating, 30);
            assert.equal(saveRefinedLoadout([entry], result).ok, true);
        });
        assert.equal(calls, 1);
        assert.deepEqual({ chat: ctx.chat, entry }, before);
    });

    it('renders configured recent messages without character truncation and includes explicit caller context', () => {
        const ctx = context();
        ctx.chat = [{ mes: '不得选取的旧剧情' }, { mes: 'x'.repeat(7000) + '长消息末尾必保留' }, { mes: '最近结尾', is_user: true }];
        const draft = createLoadoutEntry({ id: 'd', kind: 'weapon', name: '剑', description: '简述' });
        const prompt = buildLoadoutPrompt(ctx, { loadout: { contextMessages: 2 } }, draft, { persona: '显式玩家人设', worldContext: '显式世界背景' });
        assert.match(prompt.user, /长消息末尾必保留/);
        assert.match(prompt.user, /显式玩家人设/);
        assert.match(prompt.user, /显式世界背景/);
        assert.doesNotMatch(prompt.user, /不得选取的旧剧情/);
        assert.equal(prompt.context.count, 2);
        const override = buildLoadoutPrompt(ctx, {}, draft, { recentChat: '父层传入的明确剧情' });
        assert.match(override.user, /父层传入的明确剧情/);
        assert.doesNotMatch(override.user, /最近结尾/);
    });

    it('resolves player strength from Chinese story names without inventing an identity', () => {
        const draft = createLoadoutEntry({ id: 'zh-player', kind: 'skill', name: '裂风斩', description: '简述' });
        const prompt = buildLoadoutPrompt(context(), {}, draft, { powerSystem: {
            systemName: '中文战力表', 我方: [{ 名称: '玩家', isUser: true, 属性: { HP: 100, Atk: 37 } }],
        } });
        assert.equal(prompt.context.player?.name, '玩家');
        assert.equal(prompt.context.player?.attributes.Atk.current, 37);
    });

    it('accepts content from real silent main transport without custom API settings or new chat floors', async () => {
        const previous = globalThis.TavernHelper;
        const ctx = context();
        const before = copy(ctx.chat);
        let params;
        globalThis.TavernHelper = { generateRaw: async (request) => { params = request; return { content: JSON.stringify(responseFor(equipRule())) }; } };
        try {
            const entry = createLoadoutEntry({ id: 'real', kind: 'weapon', name: '试炼长剑', description: '一把轻剑' });
            const result = await refineLoadoutEntry(ctx, { p2: { channel: { apiKey: 'never-sent', model: 'not-main' } } }, entry, { powerSystem: scene() });
            assert.equal(result.ok, true, result.error);
            assert.equal(params.should_silence, true);
            assert.equal(params.should_stream, false);
            assert.equal(params.custom_api, undefined);
            assert.equal(params.ordered_prompts.length, 2);
            assert.match(params.ordered_prompts[1].content, /当前剧情/);
            assert.deepEqual(ctx.chat, before);
        } finally {
            if (previous === undefined) delete globalThis.TavernHelper;
            else globalThis.TavernHelper = previous;
        }
    });

    it('rejects invalid, nonfinite, unknown-effect and truncated model output without mutating the original', async () => {
        const entry = refined();
        const before = copy(entry);
        const outputs = [
            '正文散文而不是 JSON', '{"rule":{"name":"裂风斩"',
            JSON.stringify(responseFor(skillRule('裂风斩', { effects: [{ type: 'instant-kill', power: 12, duration: 0 }] }))),
            JSON.stringify(responseFor(skillRule())).replace('"cost":4', '"cost":1e999'),
            JSON.stringify({ rule: skillRule() }),
            JSON.stringify(responseFor(skillRule('模型擅自改名'))),
        ];
        for (const output of outputs) await withComplete(async () => ({ ok: true, text: output }), async () => {
            const result = await refineLoadoutEntry(context(), {}, entry, { powerSystem: scene() });
            assert.equal(result.ok, false, output);
            assert.equal(result.rule, undefined);
            assert.deepEqual(entry, before);
        });
    });

    it('keeps errors, cancellation, and stale responses from overwriting newer drafts', async () => {
        const entry = createLoadoutEntry({ id: 'pending', kind: 'skill', name: '裂风斩', description: '原始描述' });
        await withComplete(async () => ({ ok: false, error: '主连接暂不可用' }), async () => {
            const result = await refineLoadoutEntry(context(), {}, entry);
            assert.equal(result.error, '主连接暂不可用');
            assert.equal(entry.description, '原始描述');
        });
        const abort = new AbortController();
        abort.abort();
        await withComplete(async () => { throw new Error('预先取消不能请求'); }, async () => {
            const result = await refineLoadoutEntry(context(), {}, entry, { signal: abort.signal });
            assert.equal(result.aborted, true);
        });
        await withComplete(async () => ({ ok: true, text: '```json\n' + JSON.stringify(responseFor(skillRule())) + '\n```' }), async () => {
            const result = await refineLoadoutEntry(context(), {}, entry);
            assert.equal(result.ok, true);
            const edited = updateLoadoutEntry([entry], entry.id, { description: '请求期间的新描述' });
            const saved = saveRefinedLoadout(edited, result);
            assert.equal(saved.ok, false);
            assert.equal(saved.entries[0].description, '请求期间的新描述');
            assert.equal(saved.entries[0].rule, null);
        });
    });

    it('requires stable saved identity and meaningful context before requesting', async () => {
        await withComplete(async () => { throw new Error('不可发起无上下文请求'); }, async () => {
            assert.equal((await refineLoadoutEntry({}, {}, { name: '裂风斩', description: '构思' })).ok, false);
            const draft = createLoadoutEntry({ id: 'empty', kind: 'skill', name: '裂风斩', description: '构思' });
            const result = await refineLoadoutEntry({}, {}, draft);
            assert.equal(result.ok, false);
            assert.match(result.error, /缺少可读剧情/);
        });
    });
});
