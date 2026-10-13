/**
 * tavern-dice / src/ui/frame.js
 * ---------------------------------------------------------------------------
 * 博德之门 3 的**检定面板**（用户截图里骰子外面那一整套）。
 *
 * ## 截图里的构成（从上到下）
 *
 *  1. 顶部：角色名（衬线大字） + 「魅力检定」小字
 *  2. **深紫面板**，四角与上下边缘带**金色卷草纹**（filigree），中间开出骰子区
 *  3. 面板内上方：「难度 / 等级」两行小字 + 一个大数字（DC）
 *  4. 中间：骰子本体
 *  5. 「点击骰子」按钮（暗底、金色描边、居中小字）
 *  6. 面板下方：一个**菱形镶框**装修正值（截图里是 +4），下面标来源（「游荡 熟练项」）
 *  7. 再下面：「总计 / 难度」一行 + 「添加加成」按钮
 *
 * ## 为什么用 SVG 画花纹
 *
 * 卷草纹是**细长的曲线**，用 CSS 边框画不出来，用 canvas 又不好复用与缩放。
 * SVG 的 `path` 能精确描述曲线，还自带渐变与描边，是最合适的工具。
 * 关键是**四角对称**：只画一个角，另外三个用 `transform` 旋转复用。
 */

import { el } from './dom.js';

/**
 * 造一条「卷草纹」角饰路径。
 *
 * 形状参照截图：从角落往外甩出的两片**螺旋叶**，中间夹一根短须。
 * 用三次贝塞尔拼出来 —— 关键是收尾要往回收（螺旋感），不能是简单的弧。
 *
 * @param {number} s 缩放（以 100 为基准设计）
 * @returns {string}
 */
function filigreeCornerPath(s = 1) {
    const k = (/** @type {number} */ n) => (n * s).toFixed(1);
    return [
        // 主叶：从角落甩出、末端回卷
        `M 0 0`,
        `C ${k(26)} ${k(2)} ${k(52)} ${k(6)} ${k(66)} ${k(20)}`,
        `C ${k(76)} ${k(31)} ${k(70)} ${k(45)} ${k(57)} ${k(45)}`,
        `C ${k(47)} ${k(45)} ${k(43)} ${k(36)} ${k(50)} ${k(31)}`,
        // 副叶：更短的一根，往另一个方向
        `M ${k(4)} ${k(26)}`,
        `C ${k(8)} ${k(48)} ${k(22)} ${k(62)} ${k(40)} ${k(64)}`,
        `C ${k(52)} ${k(65)} ${k(58)} ${k(56)} ${k(52)} ${k(49)}`,
        `C ${k(47)} ${k(44)} ${k(39)} ${k(47)} ${k(41)} ${k(54)}`,
        // 中间短须
        `M ${k(18)} ${k(12)}`,
        `C ${k(28)} ${k(20)} ${k(36)} ${k(30)} ${k(38)} ${k(40)}`,
    ].join(' ');
}

/**
 * 面板边框的四角 + 上下中点的装饰。
 *
 * @param {{width: number, height: number, gold: string, goldDim: string}} opts
 * @returns {SVGElement}
 */
function buildFrameSvg(opts) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'td-bg3-frame-svg');
    svg.setAttribute('viewBox', `0 0 ${opts.width} ${opts.height}`);
    svg.setAttribute('preserveAspectRatio', 'none');

    // 渐变：金色描边用（左上亮、右下暗，像被光照到）
    const defs = document.createElementNS(NS, 'defs');
    const grad = document.createElementNS(NS, 'linearGradient');
    grad.setAttribute('id', 'td-bg3-gold');
    grad.setAttribute('x1', '0');
    grad.setAttribute('y1', '0');
    grad.setAttribute('x2', '1');
    grad.setAttribute('y2', '1');
    for (const [offset, color] of [
        ['0%', '#f0d79a'],
        ['35%', '#c9a24e'],
        ['70%', '#8f6f2c'],
        ['100%', '#e2c583'],
    ]) {
        const stop = document.createElementNS(NS, 'stop');
        stop.setAttribute('offset', offset);
        stop.setAttribute('stop-color', color);
        grad.appendChild(stop);
    }
    defs.appendChild(grad);
    svg.appendChild(defs);

    const g = document.createElementNS(NS, 'g');

    // ---- 四角卷草纹：只画左上，其余三个旋转复用 ----
    const corners = [
        { transform: 'translate(0,0)' },
        { transform: `translate(${opts.width},0) scale(-1,1)` },
        { transform: `translate(0,${opts.height}) scale(1,-1)` },
        { transform: `translate(${opts.width},${opts.height}) scale(-1,-1)` },
    ];
    for (const c of corners) {
        const cg = document.createElementNS(NS, 'g');
        cg.setAttribute('transform', c.transform);
        const path = document.createElementNS(NS, 'path');
        path.setAttribute('d', filigreeCornerPath(0.62));
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', 'url(#td-bg3-gold)');
        path.setAttribute('stroke-width', '1.6');
        path.setAttribute('stroke-linecap', 'round');
        cg.appendChild(path);
        g.appendChild(cg);
    }

    // ---- 上下中点的小菱形（截图里上下各有装饰节点）----
    for (const y of [0, opts.height]) {
        const d = document.createElementNS(NS, 'path');
        const cxp = opts.width / 2;
        d.setAttribute('d', `M ${cxp} ${y - 7} L ${cxp + 7} ${y} L ${cxp} ${y + 7} L ${cxp - 7} ${y} Z`);
        d.setAttribute('fill', opts.gold);
        d.setAttribute('stroke', opts.goldDim);
        d.setAttribute('stroke-width', '1');
        g.appendChild(d);
        // 菱形两侧各拉一条短线，形成「收腰」的观感
        for (const dir of [-1, 1]) {
            const line = document.createElementNS(NS, 'path');
            line.setAttribute(
                'd',
                `M ${cxp + dir * 12} ${y} L ${cxp + dir * (opts.width * 0.32)} ${y}`,
            );
            line.setAttribute('stroke', 'url(#td-bg3-gold)');
            line.setAttribute('stroke-width', '1.3');
            line.setAttribute('opacity', '0.75');
            g.appendChild(line);
        }
    }

    svg.appendChild(g);
    return svg;
}

/**
 * 检定面板。
 *
 * 结构（与截图对应）：
 *
 *     ┌ 角色名 ──────────────┐
 *     │ 魅力检定              │
 *     │ ╔═══ 金框 ═══╗        │
 *     │   难度 / 等级         │
 *     │      5               │
 *     │    [ 骰子 ]           │
 *     │   [点击骰子]          │
 *     │ ╚════════════╝        │
 *     │   ◇ +4 ◇              │
 *     │   游荡 熟练项          │
 *     │ 总计 / 难度  [添加加成] │
 *     └──────────────────────┘
 *
 * @param {{
 *   actorName?: string,
 *   checkLabel?: string,
 *   dc?: number|null,
 *   modifier?: number|null,
 *   modifierSource?: string,
 *   hint?: string,
 *   onRoll?: () => void,
 *   diceHolder: HTMLElement,
 *   resultLine?: HTMLElement|null,
 *   buttons?: HTMLElement[],
 * }} opts
 * @returns {HTMLElement}
 */
export function buildCheckPanel(opts) {
    const root = el('div', { class: 'td-bg3-panel' });

    // ---- 顶部：角色名 + 检定名 ----
    if (opts.actorName) {
        root.appendChild(el('div', { class: 'td-bg3-actor' }, opts.actorName));
    }
    if (opts.checkLabel) {
        root.appendChild(el('div', { class: 'td-bg3-check' }, opts.checkLabel));
    }

    // ---- 主面板（带金框）----
    const shield = el('div', { class: 'td-bg3-shield' });
    // 金框 SVG 叠在底层
    const frameLayer = el('div', { class: 'td-bg3-frame-layer' });
    shield.appendChild(frameLayer);
    // 内容层
    const inner = el('div', { class: 'td-bg3-inner' });
    shield.appendChild(inner);

    // 难度 / 等级 + 大数字
    if (opts.dc !== null && opts.dc !== undefined) {
        inner.appendChild(
            el('div', { class: 'td-bg3-dc' }, [
                el('div', { class: 'td-bg3-dc-label' }, '难度'),
                el('div', { class: 'td-bg3-dc-label' }, '等级'),
                el('div', { class: 'td-bg3-dc-value' }, String(opts.dc)),
            ]),
        );
    }

    // 骰子
    inner.appendChild(opts.diceHolder);

    // 结果行（命中 / 大成功等）
    if (opts.resultLine) inner.appendChild(opts.resultLine);

    // 「点击骰子」
    if (opts.onRoll) {
        inner.appendChild(
            el(
                'div',
                { class: 'td-bg3-clickable', role: 'button', tabindex: '0' },
                opts.hint || '点击骰子',
            ),
        );
    }

    root.appendChild(shield);

    // ---- 修正值：菱形镶框 ----
    if (opts.modifier !== null && opts.modifier !== undefined) {
        const sign = opts.modifier >= 0 ? '+' : '';
        const diamond = el('div', { class: 'td-bg3-mod' }, [
            el('div', { class: 'td-bg3-mod-diamond' }, [
                el('div', { class: 'td-bg3-mod-value' }, `${sign}${opts.modifier}`),
            ]),
        ]);
        if (opts.modifierSource) {
            diamond.appendChild(el('div', { class: 'td-bg3-mod-source' }, opts.modifierSource));
        }
        root.appendChild(diamond);
    }

    // ---- 底部：总计 / 难度 + 操作按钮 ----
    const footer = el('div', { class: 'td-bg3-footer' });
    if (opts.buttons?.length) {
        for (const b of opts.buttons) footer.appendChild(b);
    }
    if (footer.children.length) root.appendChild(footer);

    return root;
}

export { buildFrameSvg, filigreeCornerPath };
