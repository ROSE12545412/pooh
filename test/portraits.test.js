import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { deletePortrait, getPortrait, portraitKey, savePortrait } from '../src/core/portraits.js';

// Small asynchronous fake: requests succeed before the transaction commits.
// Failed/aborted writes never publish their staged value.
function fakeIndexedDB(options = {}) {
    const values = new Map();
    const state = { commits: 0, closes: 0, opens: 0 };
    let created = false;
    const db = {
        objectStoreNames: { contains: () => created },
        createObjectStore() { created = true; },
        close() { state.closes++; },
        transaction() {
            if (options.transactionThrows) throw new Error('transaction disabled');
            const transaction = { error: null };
            transaction.objectStore = () => {
                const requestFor = (kind, key, blob) => {
                    const request = {};
                    queueMicrotask(() => {
                        if (options.requestFails) {
                            request.error = new Error('QuotaExceededError');
                            request.onerror?.();
                            transaction.error = request.error;
                            transaction.onabort?.();
                            return;
                        }
                        request.result = kind === 'get' ? values.get(key) : undefined;
                        request.onsuccess?.();
                        setImmediate(() => {
                            if (options.abortAfterSuccess) {
                                transaction.error = new Error('commit aborted');
                                transaction.onabort?.();
                                return;
                            }
                            if (kind === 'put') values.set(key, blob);
                            if (kind === 'delete') values.delete(key);
                            state.commits++;
                            transaction.oncomplete?.();
                        });
                    });
                    return request;
                };
                return {
                    get: key => requestFor('get', key),
                    put: (blob, key) => requestFor('put', key, blob),
                    delete: key => requestFor('delete', key),
                };
            };
            return transaction;
        },
    };
    return {
        state,
        open() {
            state.opens++;
            if (options.openThrows) throw new Error('SecurityError');
            const request = { result: db };
            queueMicrotask(() => {
                if (options.openFails) {
                    request.error = new Error('database unavailable');
                    request.onerror?.();
                } else if (options.blocked) {
                    request.onblocked?.();
                    // An already rejected open can still later succeed in browsers.
                    queueMicrotask(() => request.onsuccess?.());
                } else {
                    if (!created) request.onupgradeneeded?.();
                    request.onsuccess?.();
                }
            });
            return request;
        },
    };
}

async function withIndexedDB(value, fn) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
    Object.defineProperty(globalThis, 'indexedDB', { value, configurable: true });
    try { await fn(); }
    finally {
        if (descriptor) Object.defineProperty(globalThis, 'indexedDB', descriptor);
        else delete globalThis.indexedDB;
    }
}

const signatures = {
    'image/png': [137, 80, 78, 71, 13, 10, 26, 10],
    'image/jpeg': [255, 216, 255],
    'image/webp': [82, 73, 70, 70, 4, 0, 0, 0, 87, 69, 66, 80],
    'image/gif': [71, 73, 70, 56, 57, 97],
};
const image = (type, size) => {
    const bytes = new Uint8Array(size ?? signatures[type].length);
    bytes.set(signatures[type]);
    return new Blob([bytes], { type });
};
const png = () => image('image/png');

describe('头像稳定作用域', () => {
    it('角色列表重排、刷新、后续战斗和阵营变化复用 avatar + name', () => {
        const before = { characterId: 0, characters: [{ avatar: 'card.png' }], name2: '旧显示名', chatId: 'old' };
        const after = { characterId: '1', characters: [{}, { avatar: 'card.png' }], name2: '新显示名', chatId: 'new' };
        assert.equal(portraitKey(before, { id: 'battle-1', name: '  阿青 ', side: 'ally' }),
            portraitKey(after, { id: 'battle-2', name: '阿青', side: 'enemy' }));
        assert.notEqual(portraitKey(before, '阿青'), portraitKey({ character: { avatar: 'other.png' } }, '阿青'));
        assert.notEqual(portraitKey(before, '阿青'), portraitKey(before, '小白'));
    });

    it('群聊优先于当前发言角色，群聊之间及单聊隔离', () => {
        assert.equal(portraitKey({ groupId: 0, name2: '甲' }, '同名'), portraitKey({ groupId: '0', name2: '乙' }, '同名'));
        assert.notEqual(portraitKey({ groupId: 'A' }, '同名'), portraitKey({ groupId: 'B' }, '同名'));
        assert.notEqual(portraitKey({ groupId: 'A' }, '同名'), portraitKey({ name2: 'A' }, '同名'));
    });

    it('缺少卡片数据时降级 name2，然后 characterId；分隔符不能产生碰撞', () => {
        assert.equal(portraitKey({ name2: '卡', characterId: 1 }, '人'), portraitKey({ name2: '卡', characterId: 99 }, '人'));
        assert.equal(portraitKey({ characterId: 0 }, '人'), portraitKey({ characterId: '0' }, '人'));
        assert.notEqual(portraitKey({ name2: 'a:b' }, 'c'), portraitKey({ name2: 'a' }, 'b:c'));
        assert.throws(() => portraitKey({}, '人'), /缺少当前角色卡或群聊/);
        assert.throws(() => portraitKey({ name2: '卡' }, { id: 'random' }), /缺少人物名称/);
    });
});

describe('头像 IndexedDB 存储', { concurrency: false }, () => {
    it('真实异步请求顺序：缺失、写入、覆盖、读取、删除；每次提交后关闭连接', async () => {
        const fake = fakeIndexedDB();
        await withIndexedDB(fake, async () => {
            assert.equal(await getPortrait('key'), null);
            const first = png();
            assert.equal(await savePortrait('key', first), undefined);
            assert.equal(fake.state.commits, 2);
            assert.equal(await getPortrait('key'), first);
            const second = image('image/webp');
            await savePortrait('key', second);
            assert.equal(await getPortrait('key'), second);
            assert.equal(await deletePortrait('key'), undefined);
            assert.equal(await getPortrait('key'), null);
            await deletePortrait('missing');
            assert.equal(fake.state.closes, fake.state.opens);
        });
    });

    it('四种允许 MIME 和恰好 5MiB 有效，超限/SVG/空文件/非 Blob 均拒绝', async () => {
        const fake = fakeIndexedDB();
        await withIndexedDB(fake, async () => {
            for (const type of ['image/png', 'image/jpeg', 'image/webp', 'image/gif']) {
                await savePortrait(type, image(type));
                await assert.rejects(savePortrait(type, new Blob(['<svg>fake image</svg>'], { type })), /签名与声明格式不符/);
            }
            await savePortrait('limit', image('image/png', 5 * 1024 * 1024));
            await savePortrait('gif87', new Blob([new Uint8Array([71, 73, 70, 56, 55, 97])], { type: 'image/gif' }));
            await assert.rejects(savePortrait('mismatch', new Blob([new Uint8Array(signatures['image/png'])], { type: 'image/jpeg' })), /签名与声明格式不符/);
            const opens = fake.state.opens;
            await assert.rejects(savePortrait('key', new Blob([new Uint8Array(5 * 1024 * 1024 + 1)], { type: 'image/png' })), /不能超过 5MB/);
            for (const type of ['image/svg+xml', 'text/html', '', 'image/jpg']) {
                await assert.rejects(savePortrait('key', new Blob(['x'], { type })), /仅支持.*不支持 SVG/);
            }
            await assert.rejects(savePortrait('key', new Blob([], { type: 'image/png' })), /不能为空/);
            await assert.rejects(savePortrait('key', { type: 'image/png', size: 12 }), /Blob/);
            for (const operation of [() => getPortrait(' '), () => savePortrait('', png()), () => deletePortrait(null)]) {
                await assert.rejects(operation(), /头像键不能为空/);
            }
            assert.equal(fake.state.opens, opens);
        });
    });

    it('不支持 IndexedDB 时读写删除都拒绝，绝不内存成功', async () => {
        await withIndexedDB(undefined, async () => {
            for (const operation of [() => getPortrait('key'), () => savePortrait('key', png()), () => deletePortrait('key')]) {
                await assert.rejects(operation(), /头像.*失败：IndexedDB.*不支持或已禁用/);
            }
        });
    });

    for (const failure of ['openThrows', 'openFails', 'blocked', 'transactionThrows', 'requestFails', 'abortAfterSuccess']) {
        it(`${failure} 会返回中文错误，事务成功前不会报告保存完成`, async () => {
            const fake = fakeIndexedDB({ [failure]: true });
            await withIndexedDB(fake, async () => {
                await assert.rejects(savePortrait('key', png()), /头像保存失败：IndexedDB/);
                assert.equal(fake.state.commits, 0);
                if (!['openThrows', 'openFails'].includes(failure)) assert.equal(fake.state.closes, 1);
            });
        });
    }
});
