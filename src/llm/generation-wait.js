/** 等待正文场景生成：事件作提示，当前聊天的新回复与生成状态作校验。 */

export function currentGenerationContext(fallback) {
    try {
        return globalThis.SillyTavern?.getContext?.() ?? fallback;
    } catch {
        return fallback;
    }
}

export function generationChatIdentity(ctx) {
    let id = ctx?.chatId;
    try { id = ctx?.getCurrentChatId?.() ?? id; } catch { /* 使用已有标识 */ }
    return { id, characterId: ctx?.characterId, groupId: ctx?.groupId, metadata: ctx?.chatMetadata };
}

export function sameGenerationChat(identity, ctx) {
    const current = generationChatIdentity(ctx);
    if (identity.characterId !== current.characterId || identity.groupId !== current.groupId) return false;
    if (identity.id != null && current.id != null) return String(identity.id) === String(current.id);
    return identity.metadata === current.metadata;
}

function elementVisible(node, view) {
    if (!node || node.isConnected === false) return null;
    try {
        const style = view?.getComputedStyle?.(node);
        if (style) {
            if (style.display === 'none' || style.visibility === 'hidden') return false;
            // 被整个聊天容器隐藏时不能据此判断生成停止。
            if (typeof node.getClientRects === 'function' && !node.getClientRects().length) return null;
            return true;
        }
        if (node.hidden === true || node.style?.display === 'none') return false;
    } catch { /* 没有可用的 DOM 状态 */ }
    return null;
}

/** true=仍在生成，false=已确认空闲，null=宿主未提供可靠状态。 */
export function readGenerationActivity(ctx, { helper = globalThis.TavernHelper, document = globalThis.document, view = globalThis } = {}) {
    // 酒馆助手直接读取宿主的 is_send_press，避免依赖上下文快照或按钮样式。
    try {
        const active = helper?.builtin?.duringGenerating?.();
        if (typeof active === 'boolean') return active;
    } catch { /* 未安装或旧版助手，继续使用宿主状态 */ }
    const states = [];
    // getContext 的部分分支暴露布尔状态；缺失字段绝不当成 false。
    for (const key of ['isGenerating', 'is_send_press']) {
        try {
            const value = typeof ctx?.[key] === 'function' ? ctx[key]() : ctx?.[key];
            if (typeof value === 'boolean') states.push(value);
        } catch { /* 继续使用其它状态来源 */ }
    }
    const streaming = ctx?.streamingProcessor;
    if (streaming && typeof streaming.isFinished === 'boolean') states.push(!streaming.isFinished);
    const stopVisible = elementVisible(document?.getElementById?.('mes_stop'), view);
    if (stopVisible === true) states.push(true);
    else if (stopVisible === false) {
        const send = document?.getElementById?.('send_but');
        if (elementVisible(send, view) === true && !send.disabled && send.getAttribute?.('aria-disabled') !== 'true') {
            states.push(false);
        }
    }
    if (states.includes(true)) return true;
    return states.includes(false) ? false : null;
}

/**
 * 只接受 arm() 之后新增的正文回复；正文不变本身不能证明流式输出结束。
 * readActivity/getContext 可注入，用真实状态机覆盖不同宿主与事件时序。
 */
export function createGenerationWait({
    getContext, readActivity = readGenerationActivity, signal,
    timeoutMs = 180000, pollMs = 200, settleMs = 400, emptyGraceMs = 1500,
    deferred = false, onUpdate,
}) {
    const initial = getContext();
    const identity = generationChatIdentity(initial);
    let baselineLength = Array.isArray(initial?.chat) ? initial.chat.length : 0;
    let armed = !deferred;
    let settled = false;
    let endedAt = null;
    let candidate = null;
    let candidateAt = 0;
    let idleAt = null;
    let interval = null;
    let timeout = null;
    let lastUpdate = '';
    let resolve;
    const promise = new Promise(done => { resolve = done; });

    function finish(result) {
        if (settled) return;
        settled = true;
        clearInterval(interval);
        clearTimeout(timeout);
        signal?.removeEventListener?.('abort', onAbort);
        resolve(result);
    }
    function onAbort() { finish({ ok: false, aborted: true }); }

    function inspect() {
        if (settled || !armed) return;
        try {
            const ctx = getContext();
            if (!sameGenerationChat(identity, ctx)) {
                finish({ ok: false, aborted: true, chatChanged: true, error: '已切换聊天，停止等待原场景' });
                return;
            }
            const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];
            let next = null;
            for (let i = chat.length - 1; i >= baselineLength; i--) {
                const message = chat[i];
                if (message && !message.is_user && !message.is_system) {
                    const text = String(message.mes ?? '');
                    if (text.trim() && !/^(?:\.{1,3}|…|▍|█)$/.test(text.trim())) next = { index: i, text };
                    break;
                }
            }
            const now = Date.now();
            if (candidate?.index !== next?.index || candidate?.text !== next?.text) candidateAt = now;
            candidate = next;
            const activity = readActivity(ctx);
            if (activity === true) idleAt = null;
            else if (activity === false && idleAt === null) idleAt = now;
            else if (activity === null) idleAt = null;
            const stable = candidate && now - candidateAt >= settleMs;
            const idle = activity === false && idleAt !== null && now - idleAt >= settleMs;
            const ended = endedAt !== null && now - endedAt >= settleMs && activity !== true;
            if (stable && (idle || ended)) {
                finish({ ok: true, message: candidate, via: ended ? 'event' : 'generation-state' });
                return;
            }
            if (endedAt !== null && activity !== true && !candidate && now - endedAt >= emptyGraceMs) {
                finish({ ok: false, error: '正文生成已结束，但没有收到本次新的 AI 回复' });
                return;
            }
            const update = { chars: candidate?.text.length ?? 0, activity, ended: endedAt !== null };
            const key = JSON.stringify(update);
            if (key !== lastUpdate) {
                lastUpdate = key;
                onUpdate?.(update);
            }
        } catch (error) {
            finish({ ok: false, error: `检查正文生成状态失败：${error?.message ?? error}` });
        }
    }

    function arm() {
        if (settled || armed) return;
        const ctx = getContext();
        if (!sameGenerationChat(identity, ctx)) {
            finish({ ok: false, aborted: true, chatChanged: true, error: '已切换聊天，停止等待原场景' });
            return;
        }
        baselineLength = Array.isArray(ctx?.chat) ? ctx.chat.length : 0;
        armed = true;
        inspect();
    }
    function notifyEnded() {
        if (settled || !armed) return;
        endedAt = Date.now();
        inspect();
    }
    function notifyStopped() { finish({ ok: false, aborted: true, error: '正文生成已停止' }); }

    signal?.addEventListener?.('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    else {
        timeout = setTimeout(() => finish({ ok: false, timedOut: true, error: '等待正文输出超时' }), Math.max(1, timeoutMs));
        interval = setInterval(inspect, Math.max(1, pollMs));
        inspect();
    }
    return { promise, arm, inspect, notifyEnded, notifyStopped, cancel: finish, get settled() { return settled; } };
}
