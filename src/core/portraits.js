/** Browser-local portrait storage. UI owns file inputs and Object URL lifetimes. */
const DATABASE = 'tavern-dice-portraits';
const STORE = 'portraits';
const MAX_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

function text(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function identifier(value) {
    return typeof value === 'number' && Number.isFinite(value) ? String(value) : text(value);
}

/**
 * Stable card/group + unit name; independent of battle IDs, roster IDs and side.
 * Avatar filenames survive character-list reordering. name2 is the fallback on
 * hosts without card data; renaming a fallback name changes its storage scope.
 * Same-name units within one scope intentionally share their portrait.
 * @returns {string}
 */
export function portraitKey(ctx, unit) {
    const name = text(typeof unit === 'string' ? unit : unit?.name);
    if (!name) throw new Error('无法生成头像键：缺少人物名称。');
    const group = identifier(ctx?.groupId);
    let scope;
    if (group) {
        scope = ['group', group];
    } else {
        const id = identifier(ctx?.characterId);
        const card = (id ? ctx?.characters?.[id] : undefined) ?? ctx?.character;
        const avatar = text(card?.avatar);
        const cardName = text(ctx?.name2) || text(card?.name);
        if (avatar) scope = ['card-avatar', avatar];
        else if (cardName) scope = ['card-name', cardName];
        else if (id) scope = ['card-id', id];
        else throw new Error('无法生成头像键：缺少当前角色卡或群聊信息。');
    }
    // JSON tuple avoids collisions when names contain separators or quotes.
    return JSON.stringify(['tavern-dice-portrait', 1, ...scope, name]);
}

function validateKey(key) {
    if (typeof key !== 'string' || !key.trim()) throw new Error('头像存储失败：头像键不能为空。');
}

async function validateBlob(blob) {
    if (typeof Blob === 'undefined' || !(blob instanceof Blob)) {
        throw new Error('头像保存失败：请选择有效的图片 Blob。');
    }
    if (!IMAGE_TYPES.has(blob.type.toLowerCase())) {
        throw new Error('头像保存失败：仅支持 PNG、JPEG、WebP、GIF 图片，不支持 SVG。');
    }
    if (blob.size === 0) throw new Error('头像保存失败：图片不能为空。');
    if (blob.size > MAX_BYTES) throw new Error('头像保存失败：图片大小不能超过 5MB。');
    let bytes;
    try {
        bytes = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
    } catch (cause) {
        throw new Error('头像保存失败：无法读取图片文件内容。', { cause });
    }
    const matches = (signature, offset = 0) => signature.every((value, index) => bytes[offset + index] === value);
    const signatures = {
        'image/png': () => matches([137, 80, 78, 71, 13, 10, 26, 10]),
        'image/jpeg': () => matches([255, 216, 255]),
        'image/gif': () => matches([71, 73, 70, 56, 55, 97]) || matches([71, 73, 70, 56, 57, 97]),
        'image/webp': () => matches([82, 73, 70, 70]) && matches([87, 69, 66, 80], 8),
    };
    if (!signatures[blob.type.toLowerCase()]()) {
        throw new Error('头像保存失败：图片文件签名与声明格式不符，请选择有效的 PNG、JPEG、WebP 或 GIF 图片。');
    }
}

function storageError(action, cause) {
    const detail = cause?.message || cause?.name;
    return new Error(`头像${action}失败：IndexedDB 本地存储不可用或操作失败${detail ? `（${detail}）` : ''}。`, { cause });
}

function openDatabase() {
    return new Promise((resolve, reject) => {
        let settled = false;
        let request;
        const fail = (error) => {
            settled = true;
            reject(error);
        };
        try {
            if (!globalThis.indexedDB || typeof globalThis.indexedDB.open !== 'function') {
                throw new Error('当前浏览器不支持或已禁用 IndexedDB');
            }
            request = globalThis.indexedDB.open(DATABASE, 1);
            request.onupgradeneeded = () => {
                try {
                    if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
                } catch (error) {
                    try { request.transaction?.abort(); } catch { /* Preserve the original error. */ }
                    fail(error);
                }
            };
            request.onerror = () => fail(request.error || new Error('无法打开头像数据库'));
            request.onblocked = () => fail(new Error('头像数据库被其他页面占用，请关闭其他页面后重试'));
            request.onsuccess = () => {
                const db = request.result;
                if (settled) {
                    db.close();
                    return;
                }
                settled = true;
                db.onversionchange = () => db.close();
                resolve(db);
            };
        } catch (error) {
            fail(error);
        }
    });
}

async function operate(key, mode, action, issue) {
    validateKey(key);
    let db;
    try {
        db = await openDatabase();
        return await new Promise((resolve, reject) => {
            const transaction = db.transaction(STORE, mode);
            let result;
            transaction.oncomplete = () => resolve(result);
            transaction.onerror = () => reject(transaction.error || new Error('头像事务执行失败'));
            transaction.onabort = () => reject(transaction.error || new Error('头像事务已中止，数据未保存'));
            const request = issue(transaction.objectStore(STORE));
            request.onsuccess = () => { result = request.result; };
            request.onerror = () => reject(request.error || new Error('头像数据请求失败'));
        });
    } catch (error) {
        throw storageError(action, error);
    } finally {
        db?.close();
    }
}

/** @param {string} key @returns {Promise<Blob|null>} */
export async function getPortrait(key) {
    const result = await operate(key, 'readonly', '读取', store => store.get(key));
    if (result === undefined) return null;
    if (typeof Blob === 'undefined' || !(result instanceof Blob)) {
        throw new Error('头像读取失败：IndexedDB 中的头像数据不是有效的 Blob。');
    }
    return result;
}

/** MIME + magic bytes and <= 5 MiB; does not fully decode images. @returns {Promise<void>} */
export async function savePortrait(key, blob) {
    await validateBlob(blob);
    await operate(key, 'readwrite', '保存', store => store.put(blob, key));
}

/** Deleting a missing key succeeds; unavailable storage always rejects. @returns {Promise<void>} */
export async function deletePortrait(key) {
    await operate(key, 'readwrite', '删除', store => store.delete(key));
}
