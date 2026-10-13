import { button, el, field, on, select, textInput, toast } from './dom.js';
import { loadoutRuleSummary } from '../core/loadout.js';

const KINDS = { skill: '技能', weapon: '武器', armor: '防具', accessory: '饰品' };
const drafts = new WeakMap();
// 仅本次插件会话保留润色选择，不混入「以后携带」或持久化设置。
const refineSelections = new WeakMap();
const blank = () => ({ id: '', kind: 'skill', name: '', description: '', error: '' });

/** 库属于用户设置；只装入下一场战斗，不修改正在结算的单位。 */
export function renderLoadout(app, helpers) {
    if (!drafts.has(app)) drafts.set(app, blank());
    const draft = drafts.get(app);
    const entries = app.loadoutEntries;
    if (!refineSelections.has(app)) refineSelections.set(app, new Set());
    const selected = refineSelections.get(app);
    const entryIds = new Set(entries.map(entry => entry.id));
    for (const id of selected) if (!entryIds.has(id)) selected.delete(id);
    const root = el('div', { class: 'td-view td-view-loadout' }, [
        el('h3', {}, '自定义技能与装备库'),
        el('p', { class: 'notes' }, '写一句作用 → 保存 → 选择润色 → 发送到酒馆聊天，由正文模型输出润色内容 → 插件模型转换为 d20 规则并回填 → 勾选以后携带。成功回填后自动清理本次发送与正文回复两楼；不是静默正文请求。'),
        el('p', { class: 'notes' }, '「以后携带」与战斗页的战前选择同步，只在新战斗装备给已确认的玩家角色。技能多选，武器／防具各一件，饰品最多两件；两个饰品可同时生效，不因同类饰品槽互相覆盖。同名技能或装备冲突时自定义优先且不重复叠加；不佩戴／恢复正文饰品可在战前选择切换。切换角色卡或实力变化后可重新润色。'),
    ]);
    const rerender = () => helpers.rerender();
    const run = async (task) => {
        try {
            const result = await task();
            draft.error = result?.ok === false ? result.error || '操作未完成' : '';
            if (draft.error) toast(draft.error, 'warning');
            return result;
        } catch (error) {
            draft.error = String(error?.message || error);
            toast(draft.error, 'error');
            return { ok: false };
        } finally { rerender(); }
    };
    const contextCount = textInput({ type: 'number', value: String(app.settings.loadout.contextMessages), min: '1', max: '60',
        onInput: value => { const n = Number(value); if (Number.isInteger(n) && n >= 1 && n <= 60) app.settings.loadout.contextMessages = n; } });
    contextCount.disabled = app.busy;
    on(contextCount, 'change', () => app.persistSettings({ silent: true }));
    root.appendChild(field('润色读取最近剧情层数', contextCount, '另附当前卡的人设及玩家战斗数据。'));

    const form = el('div', { class: 'td-loadout-editor' });
    const kind = select(Object.entries(KINDS).map(([value, label]) => ({ value, label })), draft.kind, value => { draft.kind = value; });
    kind.id = 'td-loadout-kind'; kind.disabled = app.busy;
    const name = textInput({ id: 'td-loadout-name', value: draft.name, placeholder: '名称', onInput: value => { draft.name = value; } });
    name.disabled = app.busy;
    const description = el('textarea', { id: 'td-loadout-description', class: 'text_pole', rows: '3', value: draft.description,
        placeholder: '一句话说明作用、增益及代价；具体 d20 数值交给正文适配' });
    description.disabled = app.busy;
    on(description, 'input', () => { draft.description = description.value; });
    form.appendChild(el('b', {}, draft.id ? '编辑条目（修改描述后需重新润色）' : '新增条目'));
    form.appendChild(field('类型', kind));
    form.appendChild(field('名称', name));
    form.appendChild(field('作用与增益／减益', description));
    form.appendChild(el('div', { class: 'td-actions' }, [
        button(draft.id ? '保存修改' : '添加到库', () => run(async () => {
            const result = await app.saveLoadout({ ...draft });
            if (result.ok) Object.assign(draft, blank());
            return result;
        }), { id: 'td-loadout-save', disabled: app.busy }),
        draft.id ? button('取消编辑', () => { Object.assign(draft, blank()); rerender(); }, { disabled: app.busy }) : null,
    ]));
    if (draft.error) form.appendChild(el('div', { class: 'td-test-bad', role: 'alert' }, draft.error));
    root.appendChild(form);

    root.appendChild(el('p', { class: 'notes' }, '「选择润色」可单选或多选，与「以后携带」互不影响。正文会读取当前剧情、角色设定和玩家实力；回填失败时不自动清理聊天两楼。'));
    root.appendChild(el('div', { class: 'td-actions' }, [
        button('全选', () => { for (const entry of entries) selected.add(entry.id); rerender(); },
            { id: 'td-loadout-select-all', disabled: app.busy || !entries.length }),
        button('清空', () => { selected.clear(); rerender(); },
            { id: 'td-loadout-select-clear', disabled: app.busy || !selected.size }),
        button(`发送所选给正文润色（${selected.size}）`, () => run(() => app.refineLoadout(entries.filter(entry => selected.has(entry.id)).map(entry => entry.id))),
            { id: 'td-loadout-refine-selected', disabled: app.busy || !selected.size,
                title: '在酒馆聊天真实发送；正文输出后由插件模型回填规则，成功后清理本次两楼。不会自动勾选携带或改动当前战斗。' }),
    ]));
    const list = el('div', { class: 'td-loadout-list' });
    for (const entry of entries) {
        const row = el('section', { class: 'td-loadout-entry', 'data-entry-id': entry.id });
        const carry = el('input', { type: 'checkbox', class: 'td-loadout-carry', checked: entry.enabled,
            'aria-label': `${entry.name}：以后战斗携带` });
        carry.disabled = app.busy || !entry.rule;
        on(carry, 'change', () => run(() => app.setLoadoutEnabled(entry.id, carry.checked)));
        row.appendChild(el('label', { class: 'td-loadout-heading' }, [carry, el('b', {}, entry.name), el('span', { class: 'td-tag' }, KINDS[entry.kind]), '以后携带']));
        const refineChoice = el('input', { type: 'checkbox', class: 'td-loadout-refine-choice', checked: selected.has(entry.id),
            'aria-label': `${entry.name}：选择润色` });
        refineChoice.disabled = app.busy;
        on(refineChoice, 'change', () => {
            if (app.busy) return;
            if (refineChoice.checked) selected.add(entry.id);
            else selected.delete(entry.id);
            rerender();
        });
        row.appendChild(el('label', { class: 'checkbox_label' }, [refineChoice, '选择润色']));
        row.appendChild(el('p', {}, entry.description));
        row.appendChild(el('div', { class: entry.rule ? 'td-loadout-rule' : 'notes' }, entry.rule ? loadoutRuleSummary(entry) : '尚未润色为规则，暂不带入战斗。'));
        if (entry.rule) row.appendChild(el('details', { class: 'td-loadout-details' }, [
            el('summary', {}, '查看完整 d20 规则'), el('pre', {}, JSON.stringify(entry.rule, null, 2)),
        ]));
        row.appendChild(el('div', { class: 'td-actions' }, [
            button('正文润色并回填', () => run(() => app.refineLoadout(entry.id)), { disabled: app.busy, title: '在酒馆聊天真实发送此条目；正文输出后由插件模型回填，成功后清理本次两楼；不会自动勾选或改动当前战斗' }),
            button('编辑', () => { Object.assign(draft, { id: entry.id, name: entry.name, kind: entry.kind, description: entry.description, error: '' }); rerender(); }, { disabled: app.busy }),
            button('删除', () => run(async () => {
                const result = await app.deleteLoadout(entry.id);
                if (result?.ok !== false) {
                    selected.delete(entry.id);
                    if (draft.id === entry.id) Object.assign(draft, blank());
                }
                return result;
            }), { disabled: app.busy, variant: 'danger' }),
        ]));
        list.appendChild(row);
    }
    if (!entries.length) list.appendChild(el('p', { class: 'notes' }, '库中还没有条目。先添加一个技能或装备。'));
    root.appendChild(list);
    return root;
}
