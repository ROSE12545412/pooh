import { button, el, on, toast } from './dom.js';
import { loadoutRuleSummary } from '../core/loadout.js';

const expanded = new WeakMap();
const radioGroups = new WeakMap();
let nextGroup = 0;
const kinds = { skill: '技能', weapon: '武器', armor: '防具', accessory: '饰品' };

/** 战前携带选择；只写下一战设置，不直接修改任何战斗单位。 */
export function renderPrebattle(app, helpers) {
    if (!expanded.has(app)) expanded.set(app, {});
    if (!radioGroups.has(app)) radioGroups.set(app, `td-prebattle-${++nextGroup}`);
    const state = expanded.get(app);
    const selection = app.prebattleSelection || { skills: [], weapon: null, armor: null, accessories: [], accessoryMode: 'story' };
    const entries = app.loadoutEntries || [];
    const root = el('section', { class: 'td-prebattle', 'aria-label': '战前技能与装备选择' }, [
        el('h4', {}, '🎒 战前装备（可选）'),
        el('p', { class: 'notes' }, '与自定义库「以后携带」同步，仅影响下一场战斗。技能多选，武器／防具各一件，饰品最多两件；未润色条目请先到自定义库润色。'),
    ]);
    const update = async (kind, value) => {
        if (app.busy) return;
        try {
            const result = await app.setPrebattleSelection(kind, value);
            if (result?.ok === false) toast(result.error || '战前选择未保存', 'warning');
        } catch (error) { toast(String(error?.message || error), 'error'); }
        finally { helpers.rerender(); }
    };
    for (const [kind, title] of Object.entries(kinds)) {
        const list = entries.filter(entry => entry.kind === kind);
        const picked = kind === 'skill' ? selection.skills || [] : kind === 'accessory' ? (selection.accessoryMode === 'custom' ? selection.accessories || [] : []) : selection[kind] ? [selection[kind]] : [];
        const drawer = el('details', { class: 'td-prebattle-drawer', 'data-kind': kind });
        drawer.open = Boolean(state[kind]);
        on(drawer, 'toggle', () => { state[kind] = drawer.open; });
        const count = kind === 'accessory' ? selection.accessoryMode === 'story' ? '使用正文' : selection.accessoryMode === 'none' ? '不佩戴' : `${picked.length}/2` : kind === 'weapon' || kind === 'armor' ? picked.length ? '已选择' : '使用正文' : `已选 ${picked.length}`;
        drawer.appendChild(el('summary', {}, `${title} · ${count}`));
        if (kind === 'skill') drawer.appendChild(el('div', { class: 'td-actions' }, [
            button('全选技能', () => update('skill', list.filter(entry => entry.rule).map(entry => entry.id)), { disabled: app.busy || !list.some(entry => entry.rule), id: 'td-prebattle-skills-all', small: true }),
            button('清空技能', () => update('skill', []), { disabled: app.busy || !picked.length, id: 'td-prebattle-skills-clear', small: true }),
        ]));
        if (kind === 'accessory') drawer.appendChild(el('div', { class: 'td-actions' }, [
            button('不佩戴饰品', () => update('accessory', []), { disabled: app.busy, id: 'td-prebattle-accessories-none', small: true }),
            button('恢复正文饰品', () => update('accessoryMode', 'story'), { disabled: app.busy, id: 'td-prebattle-accessories-story', small: true }),
        ]));
        const choice = (entry, story = false) => {
            const id = story ? null : entry.id;
            const single = kind === 'weapon' || kind === 'armor';
            const checked = story ? !selection[kind] : picked.includes(id);
            const name = story ? `使用正文${title}` : entry.name;
            const input = el('input', { type: single ? 'radio' : 'checkbox', name: single ? `${radioGroups.get(app)}-${kind}` : null,
                class: 'td-prebattle-choice', 'data-entry-id': id ?? 'story', 'data-kind': kind, checked,
                'aria-label': `${title}：${name}` });
            const sameName = ids => !story && ids.some(value => value !== id && list.find(item => item.id === value)?.name.trim().normalize('NFKC').toLowerCase() === entry.name.trim().normalize('NFKC').toLowerCase());
            input.disabled = Boolean(app.busy || (!story && !entry.rule) || (kind === 'accessory' && !checked && (picked.length >= 2 || sameName(picked))));
            on(input, 'change', () => {
                if (input.disabled || app.busy) return;
                if (single) { if (input.checked) update(kind, id); return; }
                const latest = app.prebattleSelection || selection;
                const current = kind === 'skill' ? latest.skills || [] : latest.accessoryMode === 'custom' ? latest.accessories || [] : [];
                const values = input.checked ? [...new Set([...current, id])] : current.filter(value => value !== id);
                if (kind === 'accessory' && input.checked && (values.length > 2 || sameName(current))) {
                    input.checked = false;
                    toast(values.length > 2 ? '饰品最多携带两件' : '不能同时携带同名饰品', 'warning');
                    helpers.rerender();
                    return;
                }
                update(kind, values);
            });
            const hint = story ? '保留正文生成的装备，不以自定义条目覆盖。' : entry.rule ? loadoutRuleSummary(entry) : '尚未润色，请先在自定义库润色。';
            drawer.appendChild(el('label', { class: 'td-prebattle-entry', title: story ? hint : `${entry.description || ''}\n${hint}` }, [
                input, el('span', {}, [el('b', {}, name), el('span', { class: 'notes td-prebattle-hint' }, hint),
                    !story && entry.description ? el('span', { class: 'notes td-prebattle-description' }, entry.description) : null]),
            ]));
        };
        if (kind === 'weapon' || kind === 'armor') choice(null, true);
        for (const entry of list) choice(entry);
        if (!list.length) drawer.appendChild(el('p', { class: 'notes' }, `库中没有${title}，可先到自定义库添加并润色。`));
        root.appendChild(drawer);
    }
    return root;
}
