/** 本次检定的数值与加成。只读结算快照，不重新求值或消耗随机数。 */
import { el } from './dom.js';

export function formatCheckNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? String(Object.is(value, -0) ? 0 : value) : '—';
}

const signed = value => `${value >= 0 ? '+' : ''}${formatCheckNumber(value)}`;
const percent = value => `${formatCheckNumber(value * 100)}%`;
const finite = value => typeof value === 'number' && Number.isFinite(value);

function modifierCards(parts, title) {
    const valid = (parts ?? []).filter(part => part && finite(part.value));
    if (!valid.length) return null;
    return el('div', { class: 'td-check-modifiers' }, [
        el('div', { class: 'td-check-section-label' }, title),
        el('div', { class: 'td-check-modifier-list' }, valid.map(part =>
            el('div', { class: `td-check-modifier ${part.value < 0 ? 'is-penalty' : 'is-bonus'}`, title: part.detail || part.source || '' }, [
                el('div', { class: 'td-check-modifier-gem' }, el('span', {}, signed(part.value))),
                el('div', { class: 'td-check-modifier-source' }, part.source || '规则修正'),
                part.detail ? el('div', { class: 'td-check-modifier-detail' }, part.detail) : null,
            ]))),
    ]);
}

/** @param {any} roll 来自命中/魅力判定的完整快照 */
export function renderCheckResult(roll) {
    const root = el('div', { class: 'td-check-result', 'aria-live': 'polite' });
    if (roll?.rolling) {
        root.appendChild(el('div', { class: 'td-check-awaiting', role: 'status' }, '正在判定…'));
        return root;
    }
    if (!roll) {
        root.appendChild(el('div', { class: 'td-check-awaiting' }, '选择技能后，在此查看骰点、判定总值、目标难度和加成。'));
        return root;
    }
    const natural = finite(roll.nat) ? roll.nat : roll.value;
    const isChance = roll.hitMode === 'chance';
    const isCharm = roll.checkKind === 'charm';
    const isSave = roll.checkKind === 'control' || roll.checkKind === 'dot';
    const complete = finite(roll.total) && finite(roll.target);
    const labels = isCharm
        ? { hit: '说服成功', crit: '说服成功', miss: '说服失败', fumble: '说服失败' }
        : isSave ? { hit: '豁免成功', crit: '豁免成功', miss: '豁免失败', fumble: '豁免失败' }
        : { hit: '命中', crit: '暴击', miss: '未命中', fumble: '大失败' };
    if (!complete) {
        root.appendChild(el('div', { class: 'td-check-awaiting' }, natural > 0
            ? `骰点 ${formatCheckNumber(natural)} · ${labels[roll.outcome] || '已结算'}（本条记录未保存数值明细）`
            : '本次行动无需命中掷骰'));
        return root;
    }

    const outcome = labels[roll.outcome] || '已结算';
    const failed = roll.outcome === 'miss' || roll.outcome === 'fumble';
    root.appendChild(el('div', { class: `td-check-score ${failed ? 'is-failure' : 'is-success'}` }, [
        el('div', { class: 'td-check-score-side' }, [
            el('span', { class: 'td-check-section-label' }, isChance ? '随机检定值' : '判定总值'),
            el('strong', { class: 'td-check-total', title: String(roll.total) }, isChance ? percent(roll.total) : formatCheckNumber(roll.total)),
        ]),
        el('span', { class: 'td-check-versus' }, '对'),
        el('div', { class: 'td-check-score-side' }, [
            el('span', { class: 'td-check-section-label' }, isChance ? '命中率' : '目标难度 DC'),
            el('strong', { class: 'td-check-target', title: String(roll.target) }, isChance ? percent(roll.target) : formatCheckNumber(roll.target)),
        ]),
    ]));
    const modifiers = Array.isArray(roll.modifiers) ? roll.modifiers : null;
    const modifierSum = modifiers?.reduce((sum, part) => sum + (finite(part.value) ? part.value : 0), 0);
    const simple = !isChance && modifiers !== null && finite(natural) &&
        Math.abs(natural + modifierSum - roll.total) < 1e-9;
    if (simple) {
        root.appendChild(el('div', { class: 'td-check-equation' },
            `骰点 ${formatCheckNumber(natural)} ${modifierSum < 0 ? '−' : '+'} 加成 ${formatCheckNumber(Math.abs(modifierSum))} = ${formatCheckNumber(roll.total)}`));
    } else if (isChance) {
        root.appendChild(el('div', { class: 'td-check-equation' }, '随机检定值 < 命中率时命中'));
    } else {
        root.appendChild(el('div', { class: 'td-check-equation' }, isSave ? '判定总值 ≥ 目标难度时通过豁免' : '判定总值 ≥ 目标难度时命中'));
    }
    root.appendChild(el('div', { class: `td-check-outcome td-out-${roll.outcome || 'hit'}` }, outcome));

    const override = roll.override;
    if (override) {
        const rule = roll.specialRule || (override === 'crit' ? roll.critFormula : roll.fumbleFormula);
        root.appendChild(el('div', { class: 'td-check-rule-note' },
            `特殊判定：${rule || `天然骰 ${formatCheckNumber(natural)}`} → ${outcome}，覆盖普通数值比较。`));
    }
    if ((isChance || roll.naturalSource === '独立天然骰') && finite(natural)) {
        root.appendChild(el('div', { class: 'td-check-rule-note' },
            `独立天然 d${roll.dieFaces || 20}：${formatCheckNumber(natural)}（用于暴击／大失败判定；命中结果按公式另算）`));
    }

    const gear = roll.equipmentCheck;
    if (gear?.sources?.length) {
        const modeName = { advantage: '优势', disadvantage: '劣势', normal: '普通' };
        const resolution = gear.applied
            ? `2d20：${gear.rolls.map(formatCheckNumber).join('、')} → ${gear.mode === 'advantage' ? '取高' : '取低'} ${formatCheckNumber(gear.kept)}`
            : gear.cancelled ? '优势与劣势抵消，本次只掷一颗骰子'
            : gear.supported === false ? '当前公式不支持装备优势骰，按原公式结算'
            : `本次为${modeName[gear.mode] || '普通'}检定`;
        root.appendChild(el('div', { class: 'td-equipment-check' }, [
            el('b', {}, `装备检定 · ${resolution}`),
            ...gear.sources.map(source => el('div', { class: 'td-equipment-source' },
                `${source.unitName || (source.role === 'defender' ? '防御方' : '攻击方')} · ${source.source}：${source.check === 'defense' ? '防御' : '攻击'}${modeName[source.mode] || '普通'}`)),
        ]));
    }

    const modifierTitle = isCharm ? '魅力加成' : isSave ? '本次豁免修正' : '本次命中加成';
    const ownCards = modifierCards(modifiers, modifierTitle);
    if (ownCards) root.appendChild(ownCards);
    else if (simple) root.appendChild(modifierCards([{ source: '无额外加成', value: 0 }], modifierTitle));
    else if (!isChance) root.appendChild(el('div', { class: 'td-check-rule-note' },
        '本次按自定义公式计算；骰子组合与规则数值见下方明细。'));
    const targetCards = modifierCards(roll.targetModifiers, '目标难度修正');
    if (targetCards) root.appendChild(el('details', { class: 'td-check-formula' }, [
        el('summary', {}, '查看目标难度来源'), targetCards,
    ]));
    for (const note of roll.notes ?? []) root.appendChild(el('div', { class: 'td-check-rule-note' }, note));

    const detailLines = [];
    if (roll.formula) detailLines.push(`判定公式：${roll.formula}`);
    if (roll.targetFormula && !isChance) detailLines.push(`目标公式：${roll.targetFormula}`);
    for (const [stage, rolls] of [[isSave ? '豁免式' : '命中式', roll.dice], ['目标式', roll.targetDice], ['特殊式', roll.specialDice]]) {
        for (const dice of rolls ?? []) {
            detailLines.push(`${stage} ${dice.count || dice.rolls?.length || 1}d${dice.faces}：${(dice.rolls ?? []).join('、')} → ${formatCheckNumber(dice.total)}`);
        }
    }
    for (const [key, value] of Object.entries(roll.variables ?? {})) {
        if (finite(value)) detailLines.push(`${key} = ${formatCheckNumber(value)}`);
    }
    for (const item of roll.random ?? []) {
        detailLines.push(typeof item === 'string' ? item : `随机项：${JSON.stringify(item)}`);
    }
    if (roll.expression) detailLines.push(roll.expression);
    if (roll.statSources) {
        detailLines.push('双方属性快照（实际参与哪些项以本次公式为准）：');
        for (const [role, rows] of Object.entries(roll.statSources)) {
            for (const stat of rows ?? []) {
                if (!stat.parts?.length) continue;
                detailLines.push(`${role === 'defender' ? '防御方' : '攻击方'} ${stat.attr}：基础 ${formatCheckNumber(stat.base)} → ${formatCheckNumber(stat.value)}；${stat.parts.map(p => `${p.source} ${signed(p.delta)}`).join('、')}`);
            }
        }
    }
    if ((roll.relatedRolls?.length ?? 0) > 1) {
        detailLines.push('本次技能的逐次判定：');
        for (const other of roll.relatedRolls) {
            detailLines.push(`${other.targetName || '目标'}：${formatCheckNumber(other.total)} / ${formatCheckNumber(other.target)} · ${labels[other.outcome] || '已结算'}`);
        }
    }
    if (roll.damage) {
        detailLines.push(`本次伤害：${formatCheckNumber(roll.damage.damage)}（伤害单独计算）`);
        if (roll.damage.calculation) detailLines.push(roll.damage.calculation);
    }
    if (roll.aoeFalloff) {
        const falloff = roll.aoeFalloff;
        detailLines.push(`AOE 衰减：${falloff.targets} 个目标，伤害 ${formatCheckNumber(falloff.from)} → ${formatCheckNumber(falloff.to)}，系数 ×${formatCheckNumber(falloff.factor)}`);
    }
    if (detailLines.length) {
        root.appendChild(el('details', { class: 'td-check-formula' }, [
            el('summary', {}, '查看本次计算明细'),
            ...detailLines.map(line => el('div', {}, line)),
        ]));
    }
    if (roll.turnChecks?.length) root.appendChild(renderTurnChecks(roll.turnChecks));
    return root;
}

/** 额外状态骰与主技能命中分开显示，避免把下一人的抵抗当成本人的攻击结果。 */
export function renderTurnChecks(checks) {
    return el('div', { class: 'td-turn-checks' }, [
        el('b', {}, `回合开始额外检定 · ${checks.length} 次`),
        ...checks.map(check => el('div', { class: 'td-turn-check' }, [
            el('div', {}, check.text || `${check.actorName} · ${check.skillName}：d20(${formatCheckNumber(check.nat)})，总值 ${formatCheckNumber(check.total)} / DC ${formatCheckNumber(check.target)} · ${check.success ? '豁免成功' : '豁免失败'}`),
            check.modifiers?.length ? el('div', { class: 'notes' }, `判定修正：${check.modifiers.map(part => `${part.source} ${signed(part.value)}`).join('、')}`) : null,
            check.specialRule ? el('div', { class: 'notes' }, check.specialRule) : null,
        ])),
    ]);
}
