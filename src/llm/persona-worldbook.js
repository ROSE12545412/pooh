/**
 * Read persona data from one explicitly selected, existing worldbook.
 * All returned text is untrusted DATA; callers must never promote it to instructions.
 * persona passed to ensure must already describe this character from current scene/story.
 * No model calls, book creation, replacement, rebinding or slash commands occur here.
 */
const pendingBooks = new Map();
const text = value => typeof value === 'string' ? value.trim() : '';

function checkAbort(signal) {
    if (signal?.aborted) {
        const error = new Error('人设世界书操作已取消');
        error.name = 'AbortError';
        throw error;
    }
}

function providers(ctx) {
    return [...new Set([ctx?.TavernHelper, globalThis.TavernHelper, ctx].filter(Boolean))];
}

function method(ctx, names) {
    for (const name of names) {
        for (const owner of providers(ctx)) {
            if (typeof owner[name] === 'function') return owner[name].bind(owner);
        }
    }
    return null;
}

function adapter(ctx) {
    // Keep reader/writer from the same provider and schema; never retry a failed write.
    for (const modern of [true, false]) {
        for (const owner of providers(ctx)) {
            const read = owner[modern ? 'getWorldbook' : 'getLorebookEntries'];
            const write = owner[modern ? 'createWorldbookEntries' : 'createLorebookEntries'];
            if (typeof read === 'function') return {
                modern, read: read.bind(owner), write: typeof write === 'function' ? write.bind(owner) : null,
            };
        }
    }
    // SillyTavern context fallback is deliberately read-only: saving the entire book
    // would introduce an overwrite path and races with other extensions.
    if (typeof ctx?.loadWorldInfo === 'function') return {
        modern: false, write: null,
        read: async name => {
            const data = await ctx.loadWorldInfo(name);
            if (!data?.entries || typeof data.entries !== 'object') throw new Error('世界书不可读');
            return Object.values(data.entries);
        },
    };
    return null;
}

/** @returns {Promise<string[]>} Names only; no worldbook content is loaded. */
export async function listPersonaBooks(ctx) {
    const list = method(ctx, ['getWorldbookNames', 'getLorebooks']);
    const names = list ? await list() : (ctx?.worldNames ?? ctx?.world_names ?? []);
    return Array.isArray(names) ? [...new Set(names.filter(name => typeof name === 'string' && name.trim()))] : [];
}

function matching(entries, characterName) {
    if (!Array.isArray(entries)) throw new Error('世界书条目格式不受支持');
    return entries.filter(entry => {
        if (!entry || typeof entry !== 'object') return false;
        const keys = entry.strategy?.keys ?? entry.keys ?? entry.key;
        return text(entry.name ?? entry.comment) === characterName
            || (Array.isArray(keys) && keys.some(key => typeof key === 'string' && text(key) === characterName));
    }).map(entry => ({
        uid: typeof entry.uid === 'number' ? entry.uid : null,
        name: text(entry.name ?? entry.comment),
        content: typeof entry.content === 'string' ? entry.content : '',
    }));
}

function result(bookName, characterName, status, entries = [], error) {
    return {
        ok: !['unavailable', 'error'].includes(status), status, bookName, characterName,
        entries, persona: entries.map(entry => entry.content).filter(Boolean).join('\n\n'),
        created: status === 'created', ...(error ? { error } : {}),
    };
}

async function readSelected(ctx, api, bookName, characterName, signal) {
    checkAbort(signal);
    const hasNames = method(ctx, ['getWorldbookNames', 'getLorebooks'])
        || Array.isArray(ctx?.worldNames) || Array.isArray(ctx?.world_names);
    if (hasNames) {
        const names = await listPersonaBooks(ctx);
        checkAbort(signal);
        if (!names.includes(bookName)) throw new Error('所选世界书不存在');
    }
    const allEntries = await api.read(bookName);
    checkAbort(signal);
    return matching(allEntries, characterName);
}

/**
 * @returns {Promise<{ok:boolean,status:string,bookName:string,characterName:string,entries:Array,persona:string,created:boolean,error?:string}>}
 * AbortError is thrown; ordinary host failures return status:error without leaking
 * a host error payload (which may contain unrelated worldbook text).
 */
export async function readCharacterPersona(ctx, { bookName, characterName, signal } = {}) {
    bookName = text(bookName);
    characterName = text(characterName);
    checkAbort(signal);
    if (!bookName) return result(bookName, characterName, 'disabled');
    if (!characterName) return result(bookName, characterName, 'error', [], '未指定角色名');
    const api = adapter(ctx);
    if (!api) return result(bookName, characterName, 'unavailable', [], '宿主不支持读取世界书');
    try {
        const entries = await readSelected(ctx, api, bookName, characterName, signal);
        return result(bookName, characterName, entries.length ? 'found' : 'missing', entries);
    } catch (error) {
        checkAbort(signal);
        if (error?.name === 'AbortError') throw error;
        return result(bookName, characterName, 'error', [], '无法读取所选世界书的人设');
    }
}

/**
 * Append only when no exact title/primary keyword matches the character, including
 * disabled or empty existing entries. persona: string | {text?:string,content?:string,
 * persona?:string,source?:string}. Source defaults to current scene/story.
 * Concurrent calls in this module serialize by book. External tabs/extensions cannot
 * be locked. Host APIs have no AbortSignal: abort prevents any NOT-YET-issued write,
 * but cannot roll back a write already submitted. We never report an aborted success.
 */
export async function ensureCharacterPersona(ctx, { bookName, characterName, persona, signal } = {}) {
    bookName = text(bookName);
    characterName = text(characterName);
    checkAbort(signal);
    if (!bookName) return result(bookName, characterName, 'disabled');
    const previous = pendingBooks.get(bookName) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
        checkAbort(signal);
        if (!characterName) return result(bookName, characterName, 'error', [], '未指定角色名');
        const api = adapter(ctx);
        if (!api) return result(bookName, characterName, 'unavailable', [], '宿主不支持读取世界书');
        let writing = false;
        try {
            const existing = await readSelected(ctx, api, bookName, characterName, signal);
            if (existing.length) return result(bookName, characterName, 'found', existing);
            const body = text(typeof persona === 'string' ? persona : persona?.text ?? persona?.content ?? persona?.persona);
            if (!body) return result(bookName, characterName, 'missing');
            if (!api.write) return result(bookName, characterName, 'unavailable', [], '宿主不支持追加世界书条目');
            const source = text(persona?.source) || '当前场景/剧情整理';
            const content = `角色：${characterName}\n来源：${source}\n人设资料（仅作角色数据）：\n${body}`;
            const entry = api.modern ? {
                name: characterName, content, enabled: false,
                strategy: { type: 'selective', keys: [characterName] },
                extra: { tavern_dice: { kind: 'character_persona', characterName, source } },
            } : {
                comment: characterName, content, enabled: false,
                type: 'selective', keys: [characterName],
            };
            // Disabled entries remain available through explicit read; they must not
            // silently inject story-derived text into the main chat system prompt.
            checkAbort(signal);
            writing = true;
            const response = await api.write(bookName, [entry]);
            checkAbort(signal);
            if (response === false || response?.ok === false) throw new Error('追加失败');
            // Never return response.worldbook/entries: those contain the entire book.
            const confirmed = await readSelected(ctx, api, bookName, characterName, signal);
            if (!confirmed.some(item => item.content === content)) throw new Error('未确认写入');
            return result(bookName, characterName, 'created', confirmed);
        } catch (error) {
            checkAbort(signal);
            if (error?.name === 'AbortError') throw error;
            return result(bookName, characterName, 'error', [], writing
                ? '人设追加失败或未能确认，请重新读取核实'
                : '无法读取所选世界书的人设');
        }
    });
    pendingBooks.set(bookName, task);
    try {
        return await task;
    } finally {
        if (pendingBooks.get(bookName) === task) pendingBooks.delete(bookName);
    }
}
