/**
 * tavern-dice / src/core/rng.js
 * ---------------------------------------------------------------------------
 * 可复现的伪随机数发生器（PRNG）与骰子掷骰原语。
 *
 * 设计目标：**每一场战斗都必须可复查**。
 * 所有随机数都来自一个带种子的发生器，种子会写进战斗日志。
 * 只要拿着同一个种子 + 同一串操作序列，重放就能得到完全一致的结果，
 * 这样玩家质疑「你这一刀凭什么暴击」时可以直接复核。
 *
 * 实现说明：
 *  - 使用 mulberry32：32 位状态、速度快、分布质量足够跑团使用，且实现只有几行，
 *    方便在插件这种「无法引入依赖」的环境里内联。
 *  - 不使用 Math.random，因为它无法播种、无法重放。
 */

/** 单次掷骰明细的安全预算，防止模型/导入公式阻塞 UI 或耗尽内存。 */
export const MAX_DICE_COUNT = 1000;

/** @param {number} count @param {number} faces */
export function validateDiceSize(count, faces) {
    if (!Number.isSafeInteger(count) || count < 1 || count > MAX_DICE_COUNT) {
        throw new RangeError(`骰子数量必须是 1～${MAX_DICE_COUNT} 的整数`);
    }
    if (!Number.isSafeInteger(faces) || faces < 2 || faces > Math.floor(Number.MAX_SAFE_INTEGER / count)) {
        throw new RangeError('骰子面数或总和超出安全整数范围');
    }
}

/** 一个可复现的随机数发生器。 */
export class Rng {
    /**
     * @param {number|string} [seed] 种子。数字直接用；字符串会被哈希成一个 32 位整数；
     *                               省略则用当前时间生成一个随机种子。
     */
    constructor(seed) {
        /** @type {number} 原始种子（已归一化为 32 位无符号整数） */
        this.seed = Rng.normalizeSeed(seed);
        /** @type {number} 内部状态 */
        this._state = this.seed >>> 0;
        /** @type {number} 已消耗的随机数个数，用于调试与日志 */
        this.calls = 0;
    }

    /**
     * 把任意种子归一化为 32 位无符号整数。
     * @param {number|string|undefined} seed
     * @returns {number}
     */
    static normalizeSeed(seed) {
        if (seed === undefined || seed === null || seed === '') {
            // 没有种子时用时间戳，但仍然明确暴露出来，方便日志记录
            return (Date.now() ^ (Math.random() * 0x100000000)) >>> 0;
        }
        if (typeof seed === 'number' && Number.isFinite(seed)) {
            return Math.floor(Math.abs(seed)) >>> 0;
        }
        // 字符串种子：FNV-1a 32 位哈希，把「战斗名 / 日期」之类变成稳定数字
        const text = String(seed);
        let hash = 0x811c9dc5;
        for (let i = 0; i < text.length; i++) {
            hash ^= text.charCodeAt(i);
            hash = Math.imul(hash, 0x01000193) >>> 0;
        }
        return hash >>> 0;
    }

    /**
     * 生成下一个 [0, 1) 区间的浮点数。
     * @returns {number}
     */
    next() {
        this.calls++;
        let t = (this._state += 0x6d2b79f5) >>> 0;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }

    /**
     * 生成 [min, max] 闭区间内的整数（含两端）。
     * @param {number} min
     * @param {number} max
     * @returns {number}
     */
    int(min, max) {
        const lo = Math.ceil(Math.min(min, max));
        const hi = Math.floor(Math.max(min, max));
        if (hi < lo) return lo;
        return lo + Math.floor(this.next() * (hi - lo + 1));
    }

    /**
     * 掷 n 个 m 面骰，返回明细与总和。
     * @param {number} count 骰子个数
     * @param {number} faces 骰子面数
     * @returns {{rolls: number[], total: number, count: number, faces: number}}
     */
    dice(count, faces) {
        if (!Number.isFinite(count) || !Number.isFinite(faces)) {
            throw new RangeError('骰子数量和面数必须是有限数字');
        }
        const n = Math.max(1, Math.floor(count) || 1);
        const f = Math.max(2, Math.floor(faces) || 6);
        validateDiceSize(n, f);
        /** @type {number[]} */
        const rolls = [];
        let total = 0;
        for (let i = 0; i < n; i++) {
            const r = this.int(1, f);
            rolls.push(r);
            total += r;
        }
        return { rolls, total, count: n, faces: f };
    }

    /** 掷一颗 d20。@returns {number} */
    d20() {
        return this.int(1, 20);
    }

    /** 掷一颗 d100。@returns {number} */
    d100() {
        return this.int(1, 100);
    }

    /**
     * 按权重随机取一项。
     * @template T
     * @param {Array<{item: T, weight: number}>} entries
     * @param {T} [fallback]
     * @returns {T}
     */
    weighted(entries, fallback) {
        const usable = (entries || []).filter((e) => e && Number(e.weight) > 0);
        if (!usable.length) return /** @type {T} */ (fallback);
        const total = usable.reduce((sum, e) => sum + Number(e.weight), 0);
        let point = this.next() * total;
        for (const entry of usable) {
            point -= Number(entry.weight);
            if (point <= 0) return entry.item;
        }
        return usable[usable.length - 1].item;
    }

    /**
     * 洗牌（Fisher-Yates），返回新数组，不修改入参。
     * @template T
     * @param {T[]} list
     * @returns {T[]}
     */
    shuffle(list) {
        const out = [...(list || [])];
        for (let i = out.length - 1; i > 0; i--) {
            const j = this.int(0, i);
            [out[i], out[j]] = [out[j], out[i]];
        }
        return out;
    }

    /**
     * 导出可复现的快照。重放时用 `Rng.fromSnapshot()` 还原到同一状态。
     * @returns {{seed: number, state: number, calls: number}}
     */
    snapshot() {
        return { seed: this.seed, state: this._state >>> 0, calls: this.calls };
    }

    /**
     * 从快照还原发生器。
     * @param {{seed?: number, state?: number, calls?: number}} snap
     * @returns {Rng}
     */
    static fromSnapshot(snap) {
        const rng = new Rng(snap?.seed ?? 0);
        if (snap && typeof snap.state === 'number') rng._state = snap.state >>> 0;
        if (snap && typeof snap.calls === 'number') rng.calls = snap.calls;
        return rng;
    }
}

/**
 * 生成一个人类可读、便于口头复述的随机种子（例如 "K7F2-9QX3"）。
 * 用在「开一场新战斗」时给玩家一个可以记下来的种子。
 * @returns {string}
 */
export function randomSeedLabel() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉易混的 I O 0 1
    let out = '';
    const bytes = new Uint32Array(8);
    if (typeof globalThis.crypto?.getRandomValues === 'function') {
        globalThis.crypto.getRandomValues(bytes);
    } else {
        for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 0x100000000);
    }
    for (let i = 0; i < 8; i++) {
        out += alphabet[bytes[i] % alphabet.length];
        if (i === 3) out += '-';
    }
    return out;
}

/**
 * 解析骰子表达式，例如 `2d6+3`、`d20`、`1d8-1`、`3d6`。
 * 战斗中技能的伤害骰、状态附加骰都会走这里。
 * @param {string} expr
 * @returns {{count: number, faces: number, modifier: number} | null}
 */
export function parseDiceExpression(expr) {
    const text = String(expr ?? '').trim().toLowerCase().replace(/\s+/g, '');
    if (!text) return null;
    const match = text.match(/^(\d*)d(\d+)([+-]\d+)?$/);
    if (!match) return null;
    const parsed = {
        count: match[1] ? Number(match[1]) : 1,
        faces: Number(match[2]),
        modifier: match[3] ? Number(match[3]) : 0,
    };
    try {
        validateDiceSize(parsed.count, parsed.faces);
        if (!Number.isSafeInteger(parsed.modifier)) return null;
    } catch {
        return null;
    }
    return parsed;
}

/**
 * 按骰子表达式掷骰。
 * @param {Rng} rng
 * @param {string} expr 例如 `2d6+3`
 * @param {number} [fallbackFaces] 表达式非法时的兜底面数（默认 6）
 * @returns {{rolls: number[], total: number, modifier: number, expr: string, raw: number}}
 */
export function rollExpression(rng, expr, fallbackFaces = 6) {
    const parsed = parseDiceExpression(expr);
    if (!parsed) {
        const dice = rng.dice(1, fallbackFaces);
        return {
            rolls: dice.rolls,
            raw: dice.total,
            modifier: 0,
            total: dice.total,
            expr: `1d${fallbackFaces}`,
        };
    }
    const dice = rng.dice(parsed.count, parsed.faces);
    return {
        rolls: dice.rolls,
        raw: dice.total,
        modifier: parsed.modifier,
        total: dice.total + parsed.modifier,
        expr: `${parsed.count}d${parsed.faces}${parsed.modifier ? (parsed.modifier > 0 ? `+${parsed.modifier}` : parsed.modifier) : ''}`,
    };
}
