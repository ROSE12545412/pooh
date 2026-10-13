/** 说服记忆与待确认检定；这些操作不消耗战斗随机数、不改变阵营。 */
const clone = value => JSON.parse(JSON.stringify(value));
const text = (value, max = 4000) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const progressValue = value => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;

export function findPersuasion(battle, speakerId, targetId) {
    return Array.isArray(battle?.persuasion)
        ? battle.persuasion.find(item => item?.speakerId === speakerId && item?.targetId === targetId) ?? null
        : null;
}

export function recordPersuasion(battle, speaker, target, reply) {
    let state = findPersuasion(battle, speaker.id, target.id);
    if (reply?.intent !== 'persuasion') return state;
    if (!Array.isArray(battle.persuasion)) battle.persuasion = [];
    if (!state) {
        state = { speakerId: speaker.id, targetId: target.id, progress: 0, goal: '', summary: '', reason: '',
            revision: 0, attempts: 0, milestones: [], pending: null, status: 'none' };
        battle.persuasion.push(state);
    }
    const previous = progressValue(state.progress);
    const proposed = progressValue(reply.progress);
    state.progress = Math.max(previous, proposed);
    state.goal = text(reply.goal, 1000) || state.goal || (reply.requestToDefect ? '说服对方加入我方' : '');
    // 模型漏写累计值、或提出较低值时，已获得的进展及记忆都不能被清空。
    if (proposed >= previous || !state.summary) state.summary = text(reply.summary) || state.summary || '';
    state.reason = text(reply.reason, 1500) || state.reason || '';
    state.lastReply = text(reply.reply);
    state.revision = Math.max(0, Number.isSafeInteger(state.revision) ? state.revision : 0) + 1;
    state.updatedAt = Date.now();
    state.pending = null; // 新回复之后要重新评估，旧按钮的条件不再有效。
    state.status = state.goal && state.progress > 0 ? 'awaiting_assessment' : 'none';
    state.evidenceWarnings = Array.isArray(reply.evidenceWarnings) ? reply.evidenceWarnings.map(item => text(item, 500)).filter(Boolean) : [];
    if (!Array.isArray(state.milestones)) state.milestones = [];
    if (state.progress > previous) {
        state.milestones.push({ progress: state.progress, summary: state.summary, reason: state.reason, round: battle.round, at: state.updatedAt });
    }
    return state;
}

/** 枚举20个可能骰点计算真实概率，包含天然1失败、20成功。没有掷骰。 */
export function charmOdds(assessment) {
    if (!Number.isInteger(assessment?.dc) || assessment.dc < 5 || assessment.dc > 30 ||
        !Number.isFinite(assessment?.charmValue) || assessment.charmValue < 0 || assessment.charmValue > 100) return null;
    const modifier = Math.floor((assessment.charmValue - 50) / 10);
    const successful = Array.from({ length: 20 }, (_, i) => i + 1)
        .filter(natural => natural !== 1 && (natural === 20 || natural + modifier >= assessment.dc));
    return { modifier, rawRequiredNatural: assessment.dc - modifier, requiredNatural: successful[0],
        successChance: successful.length / 20, natural20Only: successful.length === 1 };
}

export function offerCharmCheck(battle, state, assessment) {
    state.pending = null;
    state.lastAssessment = clone(assessment);
    if (assessment.eligible !== true) {
        state.status = 'ineligible';
        state.reason = text(assessment.reason, 1500) || '当前条件尚不允许检定';
        return null;
    }
    if (!state.goal || state.progress <= 0) throw new Error('尚无累计说服进展，不能创建检定');
    const odds = charmOdds(assessment);
    if (!odds) throw new Error('魅力判定条件无效，未创建检定');
    state.pending = { ...clone(assessment), ...odds, id: `${battle.id}:${state.speakerId}:${state.targetId}:${state.revision}`,
        speakerId: state.speakerId, targetId: state.targetId, progress: state.progress, goal: state.goal,
        deferred: false, offeredAt: Date.now() };
    state.status = 'ready';
    state.reason = text(assessment.reason, 1500) || state.reason;
    return state.pending;
}

export function previewCharmCheck(battle, speakerId, targetId) {
    const state = findPersuasion(battle, speakerId, targetId);
    const pending = state?.pending;
    const speaker = battle?.units?.find(unit => unit.id === speakerId);
    const target = battle?.units?.find(unit => unit.id === targetId);
    if (battle?.phase === 'finished' || state?.status !== 'ready' || !pending ||
        pending.id !== `${battle.id}:${speakerId}:${targetId}:${state.revision}` ||
        !speaker?.alive || speaker.side !== 'ally' || !target?.alive || target.side !== 'enemy') return null;
    const history = Array.isArray(battle.banterHistory) ? battle.banterHistory : [];
    for (let index = history.length - 1; index >= 0; index--) {
        const data = history[index]?.data;
        if (data?.speakerId !== targetId || data?.targetId !== speakerId) continue;
        if (data.intent === 'banter' || data.intent === 'taunt') return null;
        if (data.intent === 'persuasion') break;
        // Legacy or invalid classifications do not invalidate offers from old saves.
    }
    const odds = charmOdds(pending);
    if (!odds) return null;
    return { ...clone(pending), ...odds, speakerName: speaker.name, targetName: target.name };
}

export function recordCharmRoll(state, result) {
    state.pending = null;
    state.attempts = (Number.isSafeInteger(state.attempts) && state.attempts >= 0 ? state.attempts : 0) + 1;
    state.lastRoll = clone(result);
    state.status = result.success ? 'success' : 'failed';
    // 检定失败不抹掉已累计的动摇；之后的口嗨模型会收到这份记录。
}
