/** Reusable, explicitly selected player rules. Never infer mechanics from prose. */
import { deepClone, makeId, normalizeEquipment, normalizePowerSystem, normalizeSkill, normalizeSlot, SCHEMA_VERSION } from './schema.js';

export const LOADOUT_KINDS = Object.freeze(['skill', 'weapon', 'armor', 'accessory']);
const ATTRS = new Set(['Atk', 'Armor', 'Speed', 'Evasion', 'hit']);
const EFFECTS = new Set(['damage', 'heal', 'mp', 'buff', 'debuff', 'shield', 'dot', 'control']);
const CHECKS = new Set(['normal', 'advantage', 'disadvantage']);
const SOURCE = 'custom-library';
const MAX_NUMBER = 1000000;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' ? value : '';
const key = (value) => text(value).normalize('NFKC').trim().toLocaleLowerCase();
const clone = (value) => JSON.parse(JSON.stringify(value));
const finite = (value, min = -MAX_NUMBER, max = MAX_NUMBER) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const integer = (value, min, max) => Number.isInteger(value) && finite(value, min, max);
const invalid = (error) => ({ ok: false, error });
function unknownKeys(value, allowed) {
    return Object.keys(value).filter((name) => !allowed.includes(name));
}

/**
 * Strict gate BEFORE the permissive story-schema normalizers. Failure has no fallback attack.
 * Metadata is owned by the library; a model cannot choose another entry's identity or source.
 * @returns {{ok:boolean, rule?:object, error?:string}}
 */
export function validateLoadoutRule(kind, raw, { id, name } = {}) {
    if (!LOADOUT_KINDS.includes(kind) || !object(raw)) return invalid('规则必须是已知类别的对象');
    const expectedName = text(name).trim();
    const ruleName = text(raw.name).trim();
    if (!ruleName || (expectedName && ruleName !== expectedName)) return invalid('规则名称必须与库条目名称一致');
    if (!text(raw.description).trim()) return invalid('规则缺少完整说明（含优点、代价或局限）');
    const common = ['id', 'name', 'description', 'source', 'libraryId'];
    const allowed = kind === 'skill'
        ? [...common, 'target', 'power', 'aim', 'cost', 'cooldown', 'cooldownLeft', 'effects', 'tags', 'unknownTags', 'advantage', 'advantageNote']
        : [...common, 'slot', 'bonuses', 'checks', 'effect', 'equipped', 'bonusMode'];
    const unknown = unknownKeys(raw, allowed);
    if (unknown.length) return invalid(`不支持的规则字段：${unknown.join('、')}`);
    const libraryId = text(id).trim() || text(raw.libraryId).trim();
    const metadata = { ...(libraryId ? { id: `loadout_${libraryId}`, libraryId } : {}), source: SOURCE };

    if (kind !== 'skill') {
        if (raw.slot !== kind) return invalid('装备部位必须与条目类别一致');
        if (!object(raw.bonuses)) return invalid('装备必须提供 bonuses 对象（可为空）');
        for (const [attr, value] of Object.entries(raw.bonuses)) {
            if (!ATTRS.has(attr) || !finite(value)) return invalid(`无效或不支持的装备加值：${attr}`);
        }
        if (!object(raw.checks) || unknownKeys(raw.checks, ['attack', 'defense']).length
            || !CHECKS.has(raw.checks.attack) || !CHECKS.has(raw.checks.defense)) {
            return invalid('装备 checks 必须明确 attack/defense 的 normal、advantage 或 disadvantage');
        }
        if (raw.effect !== undefined && typeof raw.effect !== 'string') return invalid('装备 effect 必须是说明文字');
        if (raw.equipped !== undefined && raw.equipped !== true) return invalid('库规则不能包含未装备状态；请使用条目勾选开关');
        if (raw.bonusMode !== undefined && raw.bonusMode !== 'additive') return invalid('库装备的 bonusMode 必须为 additive');
        if (!Object.values(raw.bonuses).some((value) => value !== 0)
            && raw.checks.attack === 'normal' && raw.checks.defense === 'normal') {
            return invalid('装备没有可执行的属性加值或优势/劣势');
        }
        const rule = normalizeEquipment({ ...raw, ...metadata, equipped: true, bonusMode: 'additive' });
        // Preserve metadata even when an older schema is loaded; current schema also retains it.
        return { ok: true, rule: { ...rule, ...metadata, checks: { ...raw.checks }, bonusMode: 'additive', equipped: true } };
    }

    if (!['single', 'group', 'self', 'all', 'random'].includes(raw.target)) return invalid('技能目标不受支持');
    if (!finite(raw.power, 0) || !finite(raw.aim, -200, 400) || !Number.isInteger((raw.aim - 100) / 10)
        || !finite(raw.cost, 0) || !integer(raw.cooldown, 0, 99)) {
        return invalid('技能 power/cost 必须为有限非负数，aim 必须产生 -30～30 的整数 d20 修正，cooldown 为 0～99 整数');
    }
    if (raw.cooldownLeft !== undefined && raw.cooldownLeft !== 0) return invalid('库技能不能保存战斗中的剩余冷却');
    if (raw.advantage !== undefined && raw.advantage !== 0) return invalid('技能 advantage 不执行判定；请把本次命中加值写入 aim');
    if (raw.advantageNote !== undefined && typeof raw.advantageNote !== 'string') return invalid('advantageNote 必须是文字');
    for (const field of ['tags', 'unknownTags']) {
        if (raw[field] !== undefined && (!Array.isArray(raw[field]) || raw[field].length)) return invalid(`库技能不解析 ${field}，请只提供明确 effects`);
    }
    if (!Array.isArray(raw.effects) || !raw.effects.length || raw.effects.length > 12) return invalid('技能必须有 1～12 个受支持的明确效果');
    const effects = [];
    for (const effect of raw.effects) {
        if (!object(effect) || unknownKeys(effect, ['type', 'power', 'duration', 'saveDc', 'tag', 'description', 'modifiers']).length
            || !EFFECTS.has(effect.type)) return invalid('技能包含未知效果或效果字段');
        if (!finite(effect.power, 0) || !integer(effect.duration, 0, 99)) return invalid('效果 power/duration 必须是有限且合法的数值');
        if (effect.description !== undefined && typeof effect.description !== 'string') return invalid('效果说明必须是文字');
        if (effect.tag !== undefined && typeof effect.tag !== 'string') return invalid('效果 tag 必须是文字');
        const instant = ['damage', 'heal', 'mp'].includes(effect.type);
        if ((instant && effect.duration !== 0) || (!instant && effect.duration < 1)) return invalid('伤害/治疗/回蓝为即时效果；其余效果必须明确 1～99 个自身回合');
        if (['control', 'dot'].includes(effect.type)) {
            if (!integer(effect.saveDc, 2, 30)) return invalid('控制/持续伤害必须明确 2～30 的整数 saveDc');
        } else if (effect.saveDc !== undefined) return invalid('只有控制/持续伤害支持 saveDc');
        const hasModifiers = ['buff', 'debuff'].includes(effect.type);
        if (hasModifiers) {
            if (effect.power !== 0 || !Array.isArray(effect.modifiers) || !effect.modifiers.length || effect.modifiers.length > 5) return invalid('增减益使用非空 modifiers 和 power:0，不从文字猜测');
            const seen = new Set();
            for (const modifier of effect.modifiers) {
                if (!object(modifier) || unknownKeys(modifier, ['attr', 'delta']).length || !ATTRS.has(modifier.attr)
                    || !finite(modifier.delta) || modifier.delta === 0 || seen.has(modifier.attr)) return invalid('无效、重复或不支持的 modifiers');
                if ((effect.type === 'buff' && modifier.delta < 0) || (effect.type === 'debuff' && modifier.delta > 0)) return invalid('buff 必须为正加值，debuff 必须为负加值');
                seen.add(modifier.attr);
            }
        } else if (effect.modifiers !== undefined && (!Array.isArray(effect.modifiers) || effect.modifiers.length)) {
            return invalid('只有 buff/debuff 支持属性 modifiers');
        }
        if (['damage', 'heal', 'mp', 'shield', 'dot'].includes(effect.type) && effect.power <= 0) return invalid('数值效果必须提供正 power');
        if (effect.type === 'control' && effect.power !== 0) return invalid('control 使用持续回合与 saveDc，power 应为 0');
        effects.push(clone(effect));
    }
    const damages = effects.filter((effect) => effect.type === 'damage');
    if (damages.length > 1 || raw.power !== (damages[0]?.power ?? 0)) return invalid('主 power 必须等于唯一 damage 效果的 power；没有伤害则为 0');
    const hostile = effects.some((effect) => ['damage', 'debuff', 'dot', 'control'].includes(effect.type));
    const beneficial = effects.some((effect) => ['heal', 'mp', 'buff', 'shield'].includes(effect.type));
    if (hostile && beneficial) return invalid('同一技能不能混合敌我效果；引擎不会把同次效果分配给不同阵营');
    if (hostile && raw.target === 'self') return invalid('不支持对自身的敌对效果');
    const rule = normalizeSkill({ ...raw, effects, ...metadata, tags: [], advantage: 0, cooldownLeft: 0 });
    return { ok: true, rule: { ...rule, ...metadata } };
}

function refinedMetadata(raw) {
    if (!object(raw)) return null;
    const out = {};
    for (const field of ['playerId', 'playerName', 'characterId', 'characterName', 'systemName', 'scale']) {
        if (typeof raw[field] === 'string' || (field === 'characterId' && Number.isInteger(raw[field]))) out[field] = String(raw[field]);
    }
    for (const field of ['createdAt', 'entryRevision', 'contextMessages', 'contextFrom', 'contextTo', 'powerRating']) {
        if (finite(raw[field], -1, Number.MAX_SAFE_INTEGER)) out[field] = raw[field];
    }
    return out;
}

function normalizeEntry(raw) {
    if (!object(raw) || !LOADOUT_KINDS.includes(raw.kind)) return null;
    const id = text(raw.id).trim() || makeId('loadout');
    const name = text(raw.name).trim();
    const checked = validateLoadoutRule(raw.kind, raw.rule, { id, name });
    return {
        id, kind: raw.kind, name, description: text(raw.description), enabled: raw.enabled === true,
        revision: integer(raw.revision, 1, Number.MAX_SAFE_INTEGER - 1) ? raw.revision : 1,
        rule: name && checked.ok ? checked.rule : null,
        refinedFor: name && checked.ok ? refinedMetadata(raw.refinedFor) : null,
    };
}

/** Invalid stored mechanics become unrefined, never a schema-generated default attack. Duplicate IDs: last wins. */
export function normalizeLoadoutLibrary(entries) {
    if (!Array.isArray(entries)) return [];
    const normalized = entries.map(normalizeEntry).filter(Boolean);
    return normalized.filter((entry, index) => normalized.findLastIndex((candidate) => candidate.id === entry.id) === index);
}

/** New drafts are never automatically selected or considered refined. */
export function createLoadoutEntry(input = {}) {
    return normalizeEntry({ ...input, kind: LOADOUT_KINDS.includes(input.kind) ? input.kind : 'skill', revision: 1, enabled: input.enabled === true, rule: null, refinedFor: null });
}

/** Only user-editable fields are patched. Content edits invalidate refinement; any change invalidates an in-flight request. */
export function updateLoadoutEntry(entries, id, patch = {}) {
    return normalizeLoadoutLibrary(entries).map((entry) => {
        if (entry.id !== id) return entry;
        const next = { ...entry };
        for (const field of ['name', 'description', 'kind', 'enabled']) {
            if (!Object.hasOwn(patch, field)) continue;
            if (field === 'enabled') next.enabled = patch.enabled === true;
            else if (field === 'kind') { if (LOADOUT_KINDS.includes(patch.kind)) next.kind = patch.kind; }
            else if (typeof patch[field] === 'string') next[field] = field === 'name' ? patch[field].trim() : patch[field];
        }
        const contentChanged = ['name', 'description', 'kind'].some((field) => next[field] !== entry[field]);
        if (contentChanged || next.enabled !== entry.enabled) next.revision += 1;
        if (contentChanged) { next.rule = null; next.refinedFor = null; }
        return next;
    });
}

export function removeLoadoutEntry(entries, id) {
    return normalizeLoadoutLibrary(entries).filter((entry) => entry.id !== id);
}

/** Atomic compare-and-save. Caller persists the returned array only on ok. Never changes the checkbox. */
export function saveRefinedLoadout(entries, result = {}) {
    const current = normalizeLoadoutLibrary(entries);
    const entry = current.find((candidate) => candidate.id === result.id);
    if (!entry || entry.revision !== result.revision) return { ...invalid('条目已修改或删除，本次润色结果未覆盖新版本'), entries: current };
    if (result.ok === false) return { ...invalid(result.error || '润色失败，保留原始描述'), entries: current };
    const checked = validateLoadoutRule(entry.kind, result.rule, entry);
    if (!checked.ok) return { ...checked, entries: current };
    return {
        ok: true,
        entries: current.map((candidate) => candidate.id === entry.id
            ? { ...entry, revision: entry.revision + 1, rule: checked.rule, refinedFor: refinedMetadata(result.refinedFor) }
            : candidate),
    };
}

function conflicts(a, b) {
    return key(a.name) === key(b.name) || (a.slot && b.slot && normalizeSlot(a.slot) === normalizeSlot(b.slot));
}

/** Last valid selection wins each name and weapon/armor slot; at most two distinct accessories coexist. */
export function selectedLoadoutEntries(entries) {
    const winners = [];
    for (const entry of normalizeLoadoutLibrary(entries)) {
        if (!entry.enabled || !entry.rule) continue;
        for (let i = winners.length - 1; i >= 0; i -= 1) {
            const sameCategory = (entry.kind === 'skill') === (winners[i].kind === 'skill');
            if (sameCategory && (key(entry.name) === key(winners[i].name)
                || (entry.kind !== 'accessory' && conflicts(entry.rule, winners[i].rule)))) winners.splice(i, 1);
        }
        winners.push(entry);
        const accessories = winners.filter(e => e.kind === 'accessory');
        if (accessories.length > 2) winners.splice(winners.indexOf(accessories[0]), 1);
    }
    return winners;
}

function inputUnits(system) {
    if (!object(system)) return [];
    return [system.allies ?? system.我方 ?? system.我方列表 ?? system.party,
        system.enemies ?? system.敌方 ?? system.敌方列表 ?? system.foes,
        system.neutral ?? system.中立 ?? system.中立列表,
        system.combatants ?? system.units ?? system.角色列表].flatMap((units) => Array.isArray(units) ? units.filter(object) : []);
}

/** Explicit ownership outranks a supplied exact ID/name. Ambiguity is always a no-op; never match aliases or substrings. */
export function findLoadoutPlayer(system, { playerId, playerName } = {}) {
    const units = inputUnits(system);
    const marked = units.filter((unit) => unit.isUser === true);
    if (marked.length) return marked.length === 1 ? marked[0] : null;
    if (text(playerId).trim()) {
        const byId = units.filter((unit) => unit.id === playerId);
        return byId.length === 1 ? byId[0] : null;
    }
    if (!text(playerName).trim()) return null;
    const byName = units.filter((unit) => text(unit.name ?? unit.名称).trim() === playerName.trim());
    return byName.length === 1 ? byName[0] : null;
}

function restoreOverlay(unit) {
    const previous = unit.extras?.loadoutOverlay;
    unit.skills = unit.skills.filter((item) => item.source !== SOURCE);
    unit.equipment = unit.equipment.filter((item) => item.source !== SOURCE);
    if (!object(previous) || previous.version !== 1) return;
    for (const [field, saved] of [['skills', previous.skills], ['equipment', previous.equipment]]) {
        if (!Array.isArray(saved)) continue;
        for (const displaced of saved) {
            if (!object(displaced?.item) || displaced.item.source === SOURCE) continue;
            // Distinct story IDs may intentionally share a name. Restore every displaced
            // item, but do not overwrite a surviving entry with the same identity.
            if (unit[field].some((item) => displaced.item.id
                ? item.id === displaced.item.id : key(item.name) === key(displaced.item.name))) continue;
            const normalized = field === 'skills' ? normalizeSkill(displaced.item) : normalizeEquipment(displaced.item);
            if (normalized) unit[field].splice(Math.max(0, Math.min(unit[field].length, displaced.index || 0)), 0, normalized);
        }
    }
    for (const [attr, saved] of Object.entries(previous.attributeDeltas ?? {})) {
        if (!['Atk', 'Armor', 'Speed', 'Evasion'].includes(attr)) continue;
        const deltas = object(saved) ? saved : { current: saved, max: saved };
        const pool = unit.attributes[attr];
        for (const field of ['current', 'max']) {
            if (pool && finite(pool[field], 0, Number.MAX_SAFE_INTEGER)
                && finite(deltas[field], -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)) pool[field] += deltas[field];
        }
    }
    delete unit.extras.loadoutOverlay;
}

/**
 * Non-mutating pre-battle overlay. Only a uniquely identified player receives selected rules.
 * extras.loadoutOverlay stores displaced story entries / effective-stat deltas for reversible,
 * idempotent reapplication, including after normalizePowerSystem and checkbox changes.
 */
export function applyLoadout(system, entries, opts = {}) {
    // Resolve before normalization: the story normalizer merges same-name units, hiding ambiguity.
    const originalPlayer = findLoadoutPlayer(system, opts);
    // Already-normalized input is cloned verbatim: re-normalizing untouched NPCs can
    // change legacy rating defaults, which is not this player's library's business.
    const result = system?.schemaVersion === SCHEMA_VERSION && Array.isArray(system.combatants)
        ? deepClone(system) : normalizePowerSystem(system);
    if (!originalPlayer) return result;
    const playerName = text(originalPlayer.name ?? originalPlayer.名称).trim();
    // A raw normalizer may merge a namesake and drop the chosen ID. Never fall
    // back from that missing explicit ID to a different unit merely by name.
    if (!originalPlayer.id && inputUnits(system).filter((unit) => text(unit.name ?? unit.名称).trim() === playerName).length !== 1) return result;
    const matches = originalPlayer.id
        ? result.combatants.filter((unit) => unit.id === originalPlayer.id)
        : result.combatants.filter((unit) => unit.name === playerName);
    if (matches.length !== 1) return result;
    const player = matches[0];
    restoreOverlay(player);
    const candidates = selectedLoadoutEntries(entries);
    const accessoryMode = ['story', 'custom', 'none'].includes(opts.accessoryMode) ? opts.accessoryMode
        : candidates.some(e => e.kind === 'accessory') ? 'custom' : 'story';
    // An empty custom selection must not suppress story gear; only explicit none does.
    const replaceAccessories = accessoryMode === 'none' || (accessoryMode === 'custom' && candidates.some(e => e.kind === 'accessory'));
    const selected = candidates.filter(e => e.kind !== 'accessory' || accessoryMode === 'custom');
    if (!selected.length && !replaceAccessories) return result;
    const backup = { version: 1, skills: [], equipment: [], attributeDeltas: {} };
    for (const [field, kind] of [['skills', 'skill'], ['equipment', 'equipment']]) {
        const rules = selected.filter((entry) => (entry.kind === 'skill') === (kind === 'skill')).map((entry) => clone(entry.rule));
        player[field] = player[field].filter((item, index) => {
            const accessory = field === 'equipment' && normalizeSlot(item.slot) === 'accessory';
            if (!(accessory && replaceAccessories) && !rules.some((rule) => conflicts(item, rule))) return true;
            backup[field].push({ index, item: clone(item) });
            if (field === 'equipment' && player.attributeBasis === 'effective' && item.equipped !== false && item.bonusMode !== 'additive') {
                for (const [attr, delta] of Object.entries(item.bonuses ?? {})) {
                    if (!['Atk', 'Armor', 'Speed', 'Evasion'].includes(attr) || !finite(delta)) continue;
                    const pool = player.attributes[attr];
                    if (!pool || !finite(pool.current)) continue;
                    // Pools are nonnegative in the story schema. Keep that invariant
                    // here too, and save the ACTUAL per-field subtraction so a later
                    // normalization cannot clamp a negative pool and destroy rollback.
                    const saved = backup.attributeDeltas[attr] ?? { current: 0, max: 0 };
                    for (const field of ['current', 'max']) {
                        if (!finite(pool[field])) continue;
                        const before = pool[field];
                        pool[field] = Math.max(0, before - delta);
                        saved[field] += before - pool[field];
                    }
                    backup.attributeDeltas[attr] = saved;
                }
            }
            return false;
        });
        player[field].push(...rules);
    }
    player.extras.loadoutOverlay = backup;
    return result;
}

/** Compact, plain-text display; descriptions are not parsed or promised as executable effects. */
export function loadoutRuleSummary(entryOrRule, kind) {
    const rule = entryOrRule?.rule ?? entryOrRule;
    const type = entryOrRule?.kind ?? kind ?? (rule?.slot ? 'equipment' : 'skill');
    if (!object(rule) || (Object.hasOwn(entryOrRule ?? {}, 'rule') && !entryOrRule.rule)) return '尚未润色：不会带入战斗';
    if (type !== 'skill') {
        const bonuses = Object.entries(rule.bonuses ?? {}).map(([attr, value]) => `${attr}${value >= 0 ? '+' : ''}${value}`);
        const labels = { normal: '正常', advantage: '优势（2d20取高）', disadvantage: '劣势（2d20取低）' };
        return [...bonuses, `攻击${labels[rule.checks?.attack] ?? '正常'}`, `防御${labels[rule.checks?.defense] ?? '正常'}`].join('；');
    }
    const effects = (rule.effects ?? []).map((effect) => [effect.type, effect.power ? `power ${effect.power}` : '',
        ...(effect.modifiers ?? []).map((modifier) => `${modifier.attr}${modifier.delta >= 0 ? '+' : ''}${modifier.delta}`),
        effect.duration ? `${effect.duration}自身回合` : '', effect.saveDc ? `豁免 DC ${effect.saveDc}` : ''].filter(Boolean).join(' '));
    const bonus = (rule.aim - 100) / 10;
    return [`${rule.target}；d20${bonus >= 0 ? '+' : ''}${bonus}`, `MP ${rule.cost}；冷却 ${rule.cooldown}`, ...effects].join('；');
}
export const ruleSummary = loadoutRuleSummary;

/** Request-time hint only; the local overlay remains authoritative even if the model omits it. */
export function loadoutSceneNote(entries, opts = {}) {
    const candidates = selectedLoadoutEntries(entries);
    const mode = ['story', 'custom', 'none'].includes(opts.accessoryMode) ? opts.accessoryMode
        : candidates.some(e => e.kind === 'accessory') ? 'custom' : 'story';
    const selected = candidates.filter(e => e.kind !== 'accessory' || mode === 'custom');
    if (!selected.length && mode !== 'none') return '';
    return [
        '【玩家已勾选并润色的自定义技能/装备库】',
        '以下仅属于唯一标明 isUser:true 的玩家，不得复制给 NPC；不明确玩家时不要猜测。',
        '同名技能替换剧情技能；武器、防具各限一件，自定义替换同名或同部位剧情装备。未列出的库条目未生效。禁止重复叠加。',
        mode === 'none' ? '玩家明确不佩戴饰品：移除全部剧情饰品及其加值，不生成或补回任何饰品。'
            : mode === 'custom' && selected.some(e => e.kind === 'accessory')
                ? '自定义饰品最多两件且不得同名；下面选中的饰品共同替换全部剧情饰品，两个饰品可以同时佩戴，不得因同槽位只保留一个。'
                : '饰品使用正文剧情装备；没有选中自定义饰品时不得覆盖或移除剧情饰品。',
        '玩家属性必须输出 attributeBasis:"base"，表示不含任何装备/状态加值；库装备 bonusMode:"additive" 将由本地引擎额外应用一次，不要预先写进属性。',
        '不要把库装备仅改 source 后当成剧情装备重建，不要添加额外公式/描述隐含效果。JSON mechanics 是执行规则，说明只作叙事。',
        ...selected.map((entry) => `- libraryId=${entry.id}；${entry.kind}「${entry.name}」\n${JSON.stringify(entry.rule)}`),
    ].join('\n');
}
