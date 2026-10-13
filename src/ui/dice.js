/**
 * tavern-dice / src/ui/dice.js
 * ---------------------------------------------------------------------------
 * d20 渲染器。
 *
 * ## 用现成素材，不再手绘
 *
 * 我先后手绘过三版骰子，全部失败：
 *  - 第一版：金色实心正二十面体，每面纯色平涂 —— 像个球。
 *  - 第二版：加了金属色阶 —— 还是金色实心，方向就错了。
 *  - 第三版：改成珍珠白半透明、能看穿内部骨架 —— 数学上对，但**画出来根本认不出是骰子**。
 *
 * 用户的原话：**「你画的那个压根看不出来是什么，有没有现成的 1d20 骰子素材，你别手绘了」**。
 * 这条意见是对的。20 张成品渲染图，比我用 canvas 三角面逼近强太多。
 *
 * 素材：`assets/d20/d20_01.png` … `d20_20.png`（256px，透明底）
 * 来自 Runebit Dice 的免费样例包，授权见 `assets/d20/LICENSE.txt`。
 *
 * ## 渲染策略
 *
 *  · **滚动中**：按时间轮播面图（每 65ms 一张），读起来就是「在转」
 *  · **落定**：交叉淡入到目标面 + 一次短促的回弹
 *  · **静置**：轻微上下浮动（图片不能真转，靠这个给出「活着」的感觉）
 *  · 素材缺失时画一个**明确的占位**（数字圆盘），而不是空白 —— 空白最难排查
 */

import { diagLog } from './diag.js';

/**
 * 素材目录的**绝对 URL**。
 *
 * ⚠️ 不能用相对路径。用户实测：用 `../../assets/d20/xx.png` 时图片加载失败，
 * 控制台报 `Unexpected token '<'` —— 那是**返回了 HTML 而不是 PNG**，
 * 说明相对路径被浏览器当成**网页路由**去请求了（解析基准不是本模块，而是文档 URL）。
 *
 * 所以这里从 `import.meta.url` 推出本模块的绝对地址，再相对它拼素材路径。
 * 这样无论酒馆把扩展放在哪个目录、用什么协议（http 或 file），都能取到。
 */
const ASSET_BASE = (() => {
    try {
        return new URL('../../assets/d20/', import.meta.url).href.replace(/\/$/, '');
    } catch {
        return '../../assets/d20';
    }
})();

/** 供诊断显示：素材实际会从哪里加载。 */
export function assetBaseUrl() {
    return ASSET_BASE;
}

/** 面数。 */
const FACE_COUNT = 20;

/**
 * 换面基准间隔（毫秒）。
 *
 * 150 约等于每秒 6.7 张 —— 能看清数字在跳，又有「在转」的感觉。
 * 早期用的 65ms（约 15 张/秒）快到看不清，用户实测反馈「转的太快了」。
 */
const DEFAULT_CYCLE_MS = 150;

/**
 * 把 1~20 映射成素材文件名。
 * @param {number} value
 * @returns {string}
 */
export function faceSrc(value) {
    const n = Math.max(1, Math.min(FACE_COUNT, Math.round(Number(value) || 1)));
    return `${ASSET_BASE}/d20_${String(n).padStart(2, '0')}.png`;
}

/** @type {Map<number, any>|null} */
let cachedFaces = null;

/**
 * 预加载全部 20 张面图。
 *
 * 只加载一次并缓存 —— 掷骰时不能现加载，否则会闪。
 *
 * @param {(loaded: number, total: number) => void} [onProgress]
 * @returns {Promise<Map<number, any>>}
 */
export function preloadFaces(onProgress) {
    if (cachedFaces) return Promise.resolve(cachedFaces);
    const map = new Map();
    /** @type {Array<{value:number, src:string, reason:string}>} */
    const failed = [];
    let done = 0;

    /** 单张加载；失败也 resolve（不能因为一张图卡住整个流程）。 */
    const one = (/** @type {number} */ v) =>
        new Promise((resolve) => {
            // 桩环境里没有 Image → 直接算失败，后续走占位绘制
            if (typeof Image !== 'function') {
                done++;
                onProgress?.(done, FACE_COUNT);
                return resolve(null);
            }
            try {
                const img = new Image();
                img.onload = () => {
                    map.set(v, img);
                    done++;
                    onProgress?.(done, FACE_COUNT);
                    resolve(img);
                };
                img.onerror = () => {
                    done++;
                    onProgress?.(done, FACE_COUNT);
                    resolve(null);
                };
                img.src = faceSrc(v);
            } catch {
                // 环境不支持图片加载（Node 里 Image 可能不存在，或 file:// 被拒）
                // → 当作加载失败，走占位绘制。**绝不能因此抛错**，
                // 否则整个界面挂载都会被打断（踩过：冒烟测试卡在第 22 项）。
                done++;
                onProgress?.(done, FACE_COUNT);
                resolve(null);
            }
        });

    return Promise.all(Array.from({ length: FACE_COUNT }, (_, i) => one(i + 1))).then(() => {
        cachedFaces = map;
        if (failed.length) {
            // 把「哪张、什么路径、为什么」都打出来 —— 否则只能说「骰子不对」
            console.error(
                `[战斗掷骰] ${failed.length}/${FACE_COUNT} 张骰面素材加载失败。首张：` +
                    `${failed[0].src}（${failed[0].reason}）`,
            );
            diagLog('error', `骰面素材加载失败 ${failed.length}/${FACE_COUNT}｜基准=${ASSET_BASE}｜首张=${failed[0].src}`);
        } else {
            diagLog('info', `骰面素材已全部加载（${map.size}/${FACE_COUNT}）`);
        }
        return map;
    });
}

/** 素材是否可用（全部加载成功才算）。 */
export function hasFaceAssets() {
    return Boolean(cachedFaces && cachedFaces.size >= FACE_COUNT);
}

/** 清缓存（测试用）。 */
export function clearFaceCache() {
    cachedFaces = null;
}

/**
 * 创建掷骰动画控制器。
 *
 * @param {HTMLCanvasElement} canvas
 * @param {{size?: number, onFrame?: (state: string, value: number) => void, alwaysAnimate?: boolean}} [opts]
 *        `alwaysAnimate`：静置时也保持动画循环（缓慢浮动）。**默认关** ——
 *        开着会让 rAF 循环永不停止，测试/冒烟跑完进程退不出来（踩过）。
 */
export function createDiceRoller(canvas, opts = {}) {
    const ctx = canvas.getContext('2d');
    const alwaysAnimate = opts.alwaysAnimate === true;

    /** idle / rolling / settling / settled */
    let state = 'idle';
    let raf = /** @type {any} */ (null);

    /** 当前显示的数字。 */
    let shown = 20;
    let shownFaces = FACE_COUNT;
    /** 滚动时轮播到哪一张。 */
    let cycling = 1;
    /** 轮播计时（毫秒累加）。 */
    let cycleClock = 0;
    /** 换面基准间隔（毫秒）。越大越慢。 */
    let cycleMs = DEFAULT_CYCLE_MS;

    /** 落定交叉淡入进度 0~1。 */
    let fade = 1;
    /** 落定前的旧面（淡出用）。 */
    let prevShown = 20;
    /** 落定回弹系数。 */
    let bounce = 0;

    /** 静置浮动相位。 */
    let idlePhase = 0;
    /** 落定高亮。 */
    let flash = 0;

    const size = opts.size ?? 240;
    const dpr = Math.max(1, Math.min(3, globalThis.devicePixelRatio || 1));
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    ctx.scale(dpr, dpr);

    /** 画布是否还挂在文档上。 */
    const isDetached = () => {
        if (typeof canvas.isConnected !== 'boolean') return false;
        return !canvas.isConnected;
    };

    /** 画一张面图（居中、等比、可带缩放）。 */
    const drawFace = (/** @type {number} */ value, /** @type {number} */ alpha, /** @type {number} */ scale, faces = FACE_COUNT) => {
        if (alpha <= 0.01) return;
        const img = faces === FACE_COUNT ? cachedFaces?.get(value) : null;
        ctx.save();
        ctx.globalAlpha = alpha;
        if (!img) {
            // 素材缺失：画一个**明确**的占位（数字圆盘）。
            // 留白是最难排查的失败方式 —— 用户只会说「什么都没有」。
            ctx.fillStyle = 'rgba(24, 20, 34, 0.92)';
            ctx.beginPath();
            ctx.arc(size / 2, size / 2, size * 0.28, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = 'rgba(200, 166, 96, 0.8)';
            ctx.lineWidth = 2;
            ctx.stroke();
            ctx.fillStyle = '#ffd479';
            ctx.font = `700 ${Math.round(size * 0.26)}px Georgia, serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(String(value), size / 2, size / 2);
            if (faces !== FACE_COUNT) {
                ctx.font = `600 ${Math.round(size * 0.07)}px Georgia, serif`;
                ctx.fillText(`d${faces}`, size / 2, size * 0.68);
            }
            ctx.restore();
            return;
        }
        const drawSize = size * scale;
        ctx.drawImage(img, (size - drawSize) / 2, (size - drawSize) / 2, drawSize, drawSize);
        ctx.restore();
    };

    /** 画一帧。 */
    const draw = () => {
        ctx.clearRect(0, 0, size, size);

        const lift = state === 'rolling' ? -size * 0.02 : Math.sin(idlePhase) * size * 0.012;
        const scale = (state === 'settled' ? 1 : 0.94) + bounce * 0.06;

        // 背光：让黑曜石骰子从深色面板上浮起来
        const halo = ctx.createRadialGradient(
            size / 2,
            size / 2 + lift,
            size * 0.1,
            size / 2,
            size / 2 + lift,
            size * 0.52,
        );
        halo.addColorStop(0, `rgba(150, 175, 235, ${0.16 + flash * 0.18})`);
        halo.addColorStop(1, 'rgba(120, 145, 210, 0)');
        ctx.fillStyle = halo;
        ctx.fillRect(0, 0, size, size);

        ctx.save();
        ctx.translate(0, lift);

        if (state === 'rolling') {
            drawFace(cycling, 0.92, 0.94);
        } else if (state === 'settling') {
            // 交叉淡入：旧面淡出、新面淡入
            drawFace(prevShown, 1 - fade, 0.94 + fade * 0.06);
            drawFace(shown, fade, 0.94 + fade * 0.06, shownFaces);
        } else {
            drawFace(shown, 1, scale, shownFaces);
        }

        ctx.restore();
    };

    /** 主循环。 */
    const tick = () => {
        // 画布被移出文档 → 立刻自杀
        // （否则每次重画界面都会留下一个永不停止的 rAF 循环，进程也退不出）
        if (isDetached()) {
            raf = null;
            state = 'idle';
            return;
        }
        if (state === 'idle' && !alwaysAnimate) {
            draw();
            raf = null;
            return;
        }

        idlePhase += 0.03;

        if (state === 'idle') {
            flash = Math.max(0, flash - 0.02);
        } else if (state === 'rolling') {
            // 按时间轮播（而不是按帧），掉帧时看起来也一样快。
            //
            // ⚠️ 换面间隔**不能太快**。用户实测 65ms（约 15 张/秒）时
            // 「转的太快了，慢一点」—— 数字快到看不清，反而没有了「掷骰子」的实感。
            //
            // 这里做成**抛掷的手感**：
            //   · 起手快一点、中段稳定、最后逐渐放慢（像是快要停下来了）
            //   · 基准间隔由 roll() 传入的 cycleMs 决定（默认 150ms，约 6.7 张/秒）
            cycleClock += 16;
            const elapsed = cycleClock;
            const speed = 0.55 + 0.45 * Math.sin(Math.min(1, elapsed / 1400) * Math.PI);
            const interval = Math.max(60, cycleMs * (1 / Math.max(0.35, speed)));
            if (elapsed >= interval) {
                cycleClock = 0;
                cycling = 1 + Math.floor(Math.random() * FACE_COUNT);
            }
        } else if (state === 'settling') {
            fade = Math.min(1, fade + 0.12);
            bounce = Math.sin(Math.min(1, fade) * Math.PI) * (1 - fade) * 0.9;
            if (fade >= 1) {
                state = 'settled';
                bounce = 0;
                flash = 1;
                opts.onFrame?.('settled', shown);
            }
        } else if (state === 'settled') {
            if (flash > 0) flash = Math.max(0, flash - 0.03);
            else if (!alwaysAnimate) {
                state = 'idle';
                draw();
                raf = null;
                return;
            }
        }

        draw();
        raf = globalThis.requestAnimationFrame
            ? globalThis.requestAnimationFrame(tick)
            : setTimeout(tick, 16);
    };

    const start = () => {
        if (!raf) {
            raf = globalThis.requestAnimationFrame
                ? globalThis.requestAnimationFrame(tick)
                : setTimeout(tick, 16);
        }
    };

    if (alwaysAnimate) start();
    else draw();

    return {
        /**
         * 开始转。在**发起 API 调用之前**调用它 —— 等待的几秒就是骰子在转。
         */
        /**
         * 开始转。在**发起 API 调用之前**调用它 —— 等待的几秒就是骰子在转。
         *
         * @param {{cycleMs?: number}} [o] cycleMs：换面间隔（毫秒）。越大越慢。
         */
        roll(o = {}) {
            state = 'rolling';
            flash = 0;
            cycleClock = 0;
            cycleMs = Math.max(40, Number(o.cycleMs) || DEFAULT_CYCLE_MS);
            start();
            opts.onFrame?.('rolling', cycling);
        },

        /**
         * 停下来显示结果。在 **API 返回之后**调用。
         * @param {number} value
         * @param {number} [faces]
         */
        settle(value, faces = FACE_COUNT) {
            shownFaces = Math.max(2, Math.round(Number(faces) || FACE_COUNT));
            const target = Math.max(1, Math.min(shownFaces, Math.round(Number(value) || 1)));
            prevShown = cycling;
            shown = target;
            state = 'settling';
            fade = 0;
            start();
            opts.onFrame?.('settling', target);
        },

        /** 直接显示某个值（不带动画）。 */
        show(value, faces = FACE_COUNT) {
            shownFaces = Math.max(2, Math.round(Number(faces) || FACE_COUNT));
            shown = Math.max(1, Math.min(shownFaces, Math.round(Number(value) || 1)));
            draw();
        },

        /** 隐藏（回到静置姿态）。 */
        hide() {
            state = 'idle';
            draw();
        },

        /** 销毁，停掉动画循环。 */
        destroy() {
            state = 'idle';
            if (raf) {
                if (globalThis.cancelAnimationFrame) globalThis.cancelAnimationFrame(raf);
                else clearTimeout(raf);
                raf = null;
            }
        },

        get isRolling() {
            return state === 'rolling';
        },
    };
}

/**
 * 从一次行动的战斗日志里，找出「主判定」的骰点结果。
 *
 * @param {any[]} logs 战斗日志（battle.log）
 * @param {number} sinceIndex 只看这个下标之后的新日志
 * @returns {{nat: number, dieFaces: number, total: number, target: number, outcome: string}|null}
 */
export function pickMainRoll(logs, sinceIndex = 0) {
    const fresh = (logs ?? []).filter((l) => l.i >= sinceIndex);
    const turnChecks = fresh.filter(entry => entry?.data?.check).map(entry => ({
        ...entry.data.check, text: entry.text, statusName: entry.data.name,
        hpLost: entry.data.value ?? 0,
    }));
    // 技能命中是主结果；随后触发的状态豁免单独列出，不能偷换出手人。
    for (let i = fresh.length - 1; i >= 0; i--) {
        const data = fresh[i]?.data;
        if (data?.hit) return {
            ...data.hit,
            skillName: data.hit.skillName || data.skillName || '',
            targetId: data.hit.targetId || data.targetId || '',
            damage: data.damage,
            turnChecks,
            aoeFalloff: data.aoeFalloff ?? data.damage?.aoeFalloff,
            relatedRolls: fresh.filter(entry => entry?.data?.hit).map(entry => ({ ...entry.data.hit })),
        };
        if (typeof data?.nat === 'number') {
            return {
                ...data,
                turnChecks,
                nat: data.nat,
                dieFaces: data.dieFaces ?? 20,
                total: data.total,
                target: data.target,
                outcome: data.outcome ?? '',
            };
        }
    }
    if (turnChecks.length) return { ...turnChecks.at(-1), turnChecks: turnChecks.slice(0, -1) };
    for (let i = fresh.length - 1; i >= 0; i--) {
        const init = fresh[i]?.data?.initiative;
        if (Array.isArray(init) && init.length) {
            const entry = init[0];
            return { nat: entry.roll, dieFaces: 20, total: entry.total, target: 0, outcome: '' };
        }
    }
    return null;
}
