/** 魅力判定只有本地随机数有权决定成败，模型只给条件。 */
export function resolveRecruitment(battle, speaker, target, assessment) {
    if (!battle || battle.phase === 'finished' || !battle.units.includes(speaker) || !battle.units.includes(target)) {
        throw new Error('战斗或参战者已变化，取消魅力检定');
    }
    if (!speaker.alive || !target.alive || speaker.side !== 'ally' || target.side !== 'enemy') {
        throw new Error('只有存活的我方角色可以说服存活的对方角色换边');
    }
    if (assessment?.eligible !== true || !Number.isInteger(assessment.dc) || assessment.dc < 5 || assessment.dc > 30 ||
        !Number.isFinite(assessment.charmValue) || assessment.charmValue < 0 || assessment.charmValue > 100) {
        throw new Error('无效魅力检定条件，未掷骰');
    }
    const modifier = Math.floor((assessment.charmValue - 50) / 10);
    const natural = battle.rng.int(1, 20);
    const total = natural + modifier;
    const success = natural !== 1 && (natural === 20 || total >= assessment.dc);
    const result = { natural, modifier, total, dc: assessment.dc, success, charmValue: assessment.charmValue,
        speakerId: speaker.id, targetId: target.id, reason: assessment.reason,
        goal: assessment.goal || '', progress: assessment.progress };
    battle.pushLog('charm', `🎲 ${speaker.name}说服${target.name}：d20=${natural}，修正${modifier >= 0 ? '+' : ''}${modifier}，合计${total} / DC ${assessment.dc}，${success ? '成功' : '失败'}。`, result);
    if (success) {
        target.side = 'ally';
        target.isUser = false;
        for (const entry of battle.initiative) if (entry.unitId === target.id) entry.side = 'ally';
        battle.pushLog('defection', `🤝 ${target.name}接受${speaker.name}的劝说，本场战斗从敌方转为我方，保留当前伤势、资源与技能参与后续战斗。`, {
            ...result, from: 'enemy', to: 'ally', targetName: target.name, speakerName: speaker.name,
        });
        battle._checkEnd();
    }
    return result;
}
