/** Conservative capture and exact host-mediated removal of a loadout request/report pair. */
import { sameGenerationChat, readGenerationActivity } from './generation-wait.js';

const fail = (error) => ({ ok: false, error });
const snapshot = (message) => JSON.stringify(message);
const recorded = (message) => Object.freeze({ reference: message, text: message?.mes, content: snapshot(message) });
const matches = (record, message) => record?.reference === message && record.text === message?.mes
    && record.content === snapshot(message);

/** message is the completed waiter's {index,text}, never a guessed latest reply. */
export function captureLoadoutChatPair(ctx, identity, baselineLength, request, message) {
    const failed = (error) => ({ ...fail(error), pair: null });
    try {
        if (!identity || !sameGenerationChat(identity, ctx)) return failed('已切换聊天；不会清理原请求');
        const chat = ctx?.chat;
        if (!Number.isSafeInteger(baselineLength) || baselineLength < 0 || !Array.isArray(chat)
            || chat.length !== baselineLength + 2) return failed('聊天楼层数量不匹配；请求期间存在新消息或迟到回复');
        const user = chat[baselineLength];
        const assistant = chat[baselineLength + 1];
        if (typeof request !== 'string' || !user?.is_user || user.mes !== request) return failed('请求楼层身份或原始文本不匹配');
        if (!assistant || assistant.is_user || assistant.is_system || typeof message?.text !== 'string'
            || message.index !== baselineLength + 1 || assistant.mes !== message.text) return failed('正文报告楼层、索引或原始文本不匹配');
        const pair = Object.freeze({ identity: Object.freeze({ ...identity }), baselineLength,
            request, text: message.text,
            user: recorded(user), assistant: recorded(assistant),
            prefix: Object.freeze(chat.slice(0, baselineLength).map(recorded)),
        });
        return { ok: true, pair, error: null };
    } catch (error) {
        return failed(`无法可靠记录聊天楼层：${error?.message ?? error}`);
    }
}

function check(ctx, pair, cleaned = false) {
    if (!pair?.identity || !sameGenerationChat(pair.identity, ctx)) return '已切换聊天；不会清理其他聊天';
    const baseline = pair.baselineLength;
    if (!Number.isSafeInteger(baseline) || baseline < 0 || !Array.isArray(pair.prefix)
        || pair.prefix.length !== baseline || !Array.isArray(ctx?.chat)
        || ctx.chat.length !== baseline + (cleaned ? 0 : 2)) return '聊天长度已变化或删除未完成；不会继续删除';
    for (let i = 0; i < baseline; i++) {
        if (!matches(pair.prefix[i], ctx.chat[i])) return '原剧情楼层引用或内容已改变；不会继续删除';
    }
    if (!cleaned) {
        const user = ctx.chat[baseline];
        const assistant = ctx.chat[baseline + 1];
        if (!matches(pair.user, user) || !matches(pair.assistant, assistant)
            || !user?.is_user || assistant?.is_user || assistant?.is_system
            || user.mes !== pair.request || assistant.mes !== pair.text) return '请求或报告楼层引用、身份或文本已改变；不会删除';
    }
    return null;
}

/** Never mutates ctx.chat itself, and never retries a different deletion API after failure. */
export async function deleteLoadoutChatPair(getContext, pair, { signal, helper = globalThis.TavernHelper } = {}) {
    try {
        if (signal?.aborted) return fail('清理已取消；聊天楼层保留');
        const ctx = getContext();
        const error = check(ctx, pair);
        if (error) return fail(error);
        if (readGenerationActivity(ctx, { helper }) === true) return fail('正文仍在生成；不会删除聊天楼层');
        const owner = typeof helper?.deleteChatMessages === 'function' ? helper
            : typeof ctx?.deleteChatMessages === 'function' ? ctx : null;
        // No speculative /cut fallback: official command semantics must be verified first.
        if (!owner) return fail('宿主没有精确删除接口；请求与报告楼层保留，请手动清理');
        // Host activity getters may have side effects; re-read immediately before invoking deletion.
        if (signal?.aborted) return fail('清理已取消；聊天楼层保留');
        const current = getContext();
        const changed = check(current, pair);
        if (changed) return fail(changed);
        if (readGenerationActivity(current, { helper }) === true) return fail('正文已重新开始生成；不会删除聊天楼层');
        // Activity readers can mutate the host as well; validate again after the last read.
        if (signal?.aborted) return fail('清理已取消；聊天楼层保留');
        const readyError = check(current, pair);
        if (readyError) return fail(readyError);
        const deletionOwner = owner === ctx ? current : owner;
        if (typeof deletionOwner?.deleteChatMessages !== 'function') return fail('宿主精确删除接口已不可用；聊天楼层保留');
        const result = await deletionOwner.deleteChatMessages([pair.baselineLength, pair.baselineLength + 1], { refresh: 'affected' });
        if (result === false || result?.ok === false || result?.isAborted === true || result?.isError === true) {
            return fail('宿主删除失败；不会尝试其他删除方式');
        }
        const after = getContext();
        const invalid = check(after, pair, true);
        if (invalid) return fail(invalid);
        if (signal?.aborted) return fail('清理期间已取消；不再进行其他删除');
        return { ok: true, error: null };
    } catch (error) {
        return fail(`清理失败；不会重试其他删除方式：${error?.message ?? error}`);
    }
}
