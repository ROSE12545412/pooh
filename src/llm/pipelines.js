/** 战斗提示词共用的聊天读取与当前数据摘要。 */

import { SIDE, toText } from '../core/schema.js';

/**
 * 把 ctx.chat 里的消息拼成纯文本，供提示词使用。
 * @param {any} ctx
 * @param {number} count 取最近多少条
 * @param {{maxCharsPerMessage?: number, withSpeaker?: boolean}} [opts]
 * @returns {{text: string, fromIndex: number, toIndex: number}}
 */
export function renderRecentMessages(ctx, count, opts = {}) {
    const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];
    const n = Math.max(0, Number(count) || 0);
    const from = Math.max(0, chat.length - n);
    const limit = opts.maxCharsPerMessage ?? 6000;
    /** @type {string[]} */
    const lines = [];

    for (let i = from; i < chat.length; i++) {
        const msg = chat[i];
        if (!msg || msg.is_system) continue;
        const speaker = msg.is_user
            ? toText(ctx?.name1) || 'User'
            : toText(msg.name) || toText(ctx?.name2) || 'Character';
        let body = toText(msg.mes);
        if (limit > 0 && body.length > limit) body = `${body.slice(0, limit)}…（截断）`;
        lines.push(`【${speaker}】\n${body}`);
    }

    return { text: lines.join('\n\n'), fromIndex: from, toIndex: chat.length - 1 };
}

/**
 * 取最近一条 AI 消息的正文。
 * @param {any} ctx
 * @returns {{text: string, index: number}|null}
 */
export function getLastAssistantMessage(ctx) {
    const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];
    for (let i = chat.length - 1; i >= 0; i--) {
        const msg = chat[i];
        if (msg && !msg.is_user && !msg.is_system) {
            return { text: toText(msg.mes), index: i };
        }
    }
    return null;
}

/**
 * 汇总当前战斗数据为紧凑文本，供战斗模型使用。
 * @param {object} powerSystem
 * @param {{maxUnits?: number}} [opts]
 * @returns {string}
 */
export function summarizePowerSystem(powerSystem, opts = {}) {
    if (!powerSystem?.combatants?.length) return '（战力表为空）';
    const maxUnits = opts.maxUnits ?? 200;
    /** @type {string[]} */
    const lines = [];

    const sideLabel = { [SIDE.ALLY]: '我方', [SIDE.ENEMY]: '敌方', [SIDE.NEUTRAL]: '中立' };

    for (const side of [SIDE.ALLY, SIDE.ENEMY, SIDE.NEUTRAL]) {
        const units = powerSystem.combatants.filter((/** @type {any} */ u) => u.side === side);
        if (!units.length) continue;
        lines.push(`## ${sideLabel[side] ?? side}`);
        for (const unit of units.slice(0, maxUnits)) {
            const attrs = Object.entries(unit.attributes)
                .map(([k, v]) =>
                    ['HP', 'MP'].includes(k) ? `${k}:${v.current}/${v.max}` : `${k}:${v.current}`,
                )
                .join(' ');
            const skills = unit.skills.length
                ? unit.skills
                      .map(
                          (/** @type {any} */ s) =>
                              `${s.name}(power:${s.power}${s.cost ? ` MP:${s.cost}` : ''}${s.cooldownLeft > 0 ? ` 冷却:${s.cooldownLeft}` : ''})`,
                      )
                      .join('、')
                : '无';
            const statuses = unit.statuses.length
                ? unit.statuses.map((/** @type {any} */ s) => `${s.name}${s.duration ? `(${s.duration})` : ''}`).join('、')
                : '无';
            const equipment = unit.equipment?.length
                ? unit.equipment
                      .map((/** @type {any} */ e) => {
                          const bonus = Object.entries(e.bonuses ?? {})
                              .map(([k, v]) => `${k}${Number(v) >= 0 ? '+' : ''}${v}`)
                              .join(' ');
                          return `${e.name}${bonus ? `[${bonus}]` : ''}`;
                      })
                      .join('、')
                : '无';
            const power =
                unit.powerRating && (unit.powerRating.rating > 0 || unit.powerRating.grade)
                    ? `战力${unit.powerRating.rating || '?'}${unit.powerRating.grade ? `(${unit.powerRating.grade})` : ''} `
                    : '';
            lines.push(
                `- ${unit.name}${unit.tier ? `[${unit.tier}]` : ''}${unit.alive ? '' : '（已阵亡）'}: ${power}${attrs}` +
                    `\n  装备: ${equipment}` +
                    `\n  技能: ${skills}` +
                    `\n  状态: ${statuses}`,
            );
        }
        if (units.length > maxUnits) lines.push(`…（另有 ${units.length - maxUnits} 个单位未列出）`);
    }

    return lines.join('\n');
}

export { SIDE };
