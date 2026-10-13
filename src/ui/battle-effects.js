/** Real engine-log driven, memory-only battle presentation. Never rolls or mutates combat. */
const consumed = new WeakMap();
const active = new WeakMap();
const LABELS = { melee: '近战', fire: '火焰', ice: '寒霜', lightning: '雷击', arcane: '施法', control: '束缚', poison: '中毒', heal: '治疗', shield: '护盾', status: '状态', special: '特殊效果', miss: '未命中' };
const THEMES = [['fire', /火|炎|焰|fire/i], ['ice', /冰|霜|寒|ice|frost/i], ['lightning', /雷|电|lightning/i], ['poison', /毒|poison/i], ['arcane', /魔法|法术|奥术|magic|arcane|spell/i]];
const outcomeOf = hit => ['crit', 'fumble'].includes(hit?.override) ? hit.override : hit?.outcome;
const landed = outcome => outcome === 'hit' || outcome === 'crit';
function effectType(type) {
    if (type === 'damage') return 'damage';
    if (type === 'control' || type === 'taunt') return 'control';
    if (type === 'dot' || type === 'poison') return 'poison';
    if (type === 'heal' || type === 'mp' || type === 'revive') return 'heal';
    if (type === 'shield') return 'shield';
    if (['buff', 'debuff', 'status'].includes(type)) return 'status';
    return 'special';
}

/** Pure snapshot: only logs produced by this action, not subsequent turn/save events. */
export function buildBattleVisual(battle, actor, action, entries) {
    if (!battle || !actor || ['defend', 'skip'].includes(action?.action)) return null;
    const skill = actor.skills?.find(s => s.id === action?.skillId || s.name === action?.skillId)
        ?? { name: '普通攻击', effects: [{ type: 'damage' }] };
    if (!skill) return null;
    const effects = skill.effects ?? [];
    const targets = new Map();
    const get = id => {
        if (!targets.has(id)) targets.set(id, { id, success: false, outcome: '', types: [], amount: 0 });
        return targets.get(id);
    };
    const addType = (target, type) => { if (!target.types.includes(type)) target.types.push(type); };
    for (const entry of entries ?? []) {
        const data = entry?.data;
        if (!data?.targetId) continue;
        if (entry.type === 'attack' && data.hit && !data.hit.checkKind) {
            const outcome = outcomeOf(data.hit);
            if (!['hit', 'crit', 'miss', 'fumble'].includes(outcome)) continue;
            const target = get(data.targetId);
            target.outcome = outcome;
            target.success = landed(outcome);
            if (data.damage && effects.some(e => e.type === 'damage')) {
                addType(target, target.success ? 'damage' : 'miss');
                target.amount = target.success ? data.damage.damage ?? 0 : 0;
            } else if (!target.success) addType(target, 'miss');
        } else if (entry.type === 'heal' && data.healed > 0 && effects.some(e => ['heal', 'mp'].includes(e.type))) {
            const target = get(data.targetId);
            target.success = true;
            target.amount = data.healed;
            addType(target, 'heal');
        } else if (entry.type === 'status' && data.status && !data.check && effects.some(e => e.type === data.status.type)) {
            const target = get(data.targetId);
            target.success = true;
            addType(target, effectType(data.status.type));
        }
    }
    if (!targets.size) return null;
    const list = [...targets.values()];
    const types = [...new Set(list.flatMap(t => t.types))];
    // Words select a colour/animation only. Success always comes from engine traces.
    const words = [skill.name, skill.description, ...effects.map(e => `${e.description ?? ''} ${e.tag ?? ''}`)].join(' ');
    const wordTheme = THEMES.find(([, re]) => re.test(words))?.[0];
    const theme = types.includes('control') ? 'control' : types.includes('heal') ? 'heal' : types.includes('shield') ? 'shield'
        : wordTheme ?? (types.includes('poison') ? 'poison' : types.includes('damage') ? 'melee' : types.includes('status') ? 'status' : 'special');
    if (['fire', 'ice', 'lightning', 'arcane'].includes(theme)) types.push('magic');
    if (['fire', 'ice', 'lightning'].includes(theme)) types.push('elemental');
    const outcomes = list.map(t => t.outcome).filter(Boolean);
    const outcome = ['crit', 'fumble', 'hit', 'miss'].find(o => outcomes.includes(o)) ?? 'effect';
    return { battle, actorId: actor.id, targets: list, type: types[0] ?? 'special', types, theme, outcome,
        skillName: skill.name, focus: list.some(t => t.success && landed(t.outcome)),
        label: outcome === 'crit' ? '暴击 · 大成功' : outcome === 'fumble' ? '大失败' : LABELS[theme] ?? '效果' };
}

/** Scroll only the side list: never scrollIntoView (which can move the page/dock). */
function focusCard(card, reduced) {
    const side = card.closest('.td-card-side');
    if (!side || !(side.clientHeight > 0)) return;
    const cardRect = card.getBoundingClientRect();
    const sideRect = side.getBoundingClientRect();
    const top = side.scrollTop + cardRect.top - sideRect.top - (side.clientTop || 0);
    const bottom = top + (card.offsetHeight || cardRect.height);
    const desired = top < side.scrollTop ? top : bottom > side.scrollTop + side.clientHeight ? bottom - side.clientHeight : side.scrollTop;
    if (desired === side.scrollTop) return;
    const position = Math.max(0, Math.min(desired, Math.max(0, side.scrollHeight - side.clientHeight)));
    if (typeof side.scrollTo === 'function') side.scrollTo({ top: position, behavior: reduced ? 'auto' : 'smooth' });
    else side.scrollTop = position;
}

/** Called while rendering; defer consumption until this actual root is mounted and current. */
export function playBattleVisual(root, app) {
    const event = app.battleVisual;
    if (!event) return;
    const valid = () => root.isConnected && app.battleVisual === event && app.battle === event.battle
        && app.ctx === event.ctx && app.ctx?.chatMetadata === event.metadata;
    const play = () => {
        if (!valid() || consumed.get(app) === event.seq) return;
        const cardFor = id => [...root.querySelectorAll('.td-character-card')].find(card => card.id === 'td-bunit-' + id);
        const actor = cardFor(event.actorId);
        if (!actor) return; // Do not consume an unmounted/missing-card render.
        consumed.set(app, event.seq);
        active.get(app)?.();
        const reduced = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;
        const cleanups = [];
        let timer;
        let observer;
        let cleaned = false;
        const cleanup = () => {
            if (cleaned) return;
            cleaned = true;
            clearTimeout(timer);
            observer?.disconnect();
            for (const fn of cleanups) fn();
            if (active.get(app) === cleanup) active.delete(app);
        };
        const decorate = (card, role, types, label, outcome) => {
            const classes = [...new Set([`td-fx-${role}`, ...types.map(t => `td-fx-${t}`), `td-fx-${outcome}`,
                ...(outcome === 'crit' ? ['td-fx-great'] : [])])];
            card.classList.add(...classes);
            const previousDirection = card.style.getPropertyValue('--td-fx-direction');
            const direction = card.closest('.td-card-enemies') ? '-1' : '1';
            card.style.setProperty('--td-fx-direction', direction);
            const overlay = root.ownerDocument.createElement('div');
            overlay.className = 'td-fx-overlay';
            overlay.dataset.type = types.join(' ');
            overlay.dataset.outcome = outcome;
            overlay.style.setProperty('--td-fx-direction', direction);
            if (reduced) { card.classList.add('td-fx-reduced'); overlay.style.animation = 'none'; }
            const caption = root.ownerDocument.createElement('span');
            caption.className = 'td-fx-caption';
            caption.textContent = label;
            overlay.appendChild(caption);
            card.appendChild(overlay);
            // A short actor animation must not cut off longer target/elemental trails.
            const end = e => { if ((e.target === card || e.target === overlay) && e.elapsedTime >= 1) cleanup(); };
            card.addEventListener('animationend', end);
            cleanups.push(() => {
                card.removeEventListener('animationend', end);
                card.classList.remove(...classes, 'td-fx-reduced');
                overlay.remove();
                if (previousDirection) card.style.setProperty('--td-fx-direction', previousDirection);
                else card.style.removeProperty('--td-fx-direction');
            });
        };
        decorate(actor, 'actor', [...event.types, event.theme], `${event.skillName} · ${event.label}`, event.outcome);
        for (const target of event.targets) {
            const card = cardFor(target.id);
            if (!card || card === actor) continue;
            decorate(card, 'target', target.success ? [...target.types, event.theme] : ['miss'],
                target.success ? `${LABELS[event.theme] ?? '效果'}${target.amount ? ' ' + target.amount : ''}` : target.outcome === 'fumble' ? '大失败' : '未命中', target.outcome || 'effect');
        }
        const stage = root.querySelector('.td-bg3-panel');
        if (stage) {
            const classes = [`td-fx-${event.outcome}`, ...(event.outcome === 'crit' ? ['td-fx-great'] : [])];
            stage.classList.add(...classes);
            cleanups.push(() => stage.classList.remove(...classes));
        }
        if (event.focus) focusCard(actor, reduced);
        active.set(app, cleanup);
        timer = setTimeout(cleanup, reduced ? 450 : 1200);
        if (typeof MutationObserver === 'function') {
            observer = new MutationObserver(() => { if (!valid() || !actor.isConnected) cleanup(); });
            observer.observe(root.ownerDocument, { childList: true, subtree: true });
        }
    };
    queueMicrotask(() => {
        if (root.isConnected) play();
        else if (typeof requestAnimationFrame === 'function') requestAnimationFrame(play);
    });
}
