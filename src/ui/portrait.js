import { getPortrait, savePortrait, portraitKey } from '../core/portraits.js';
import { el, on, toast } from './dom.js';

/** 紧凑头像：图片仅存本地 IndexedDB，不写入聊天存档。 */
export function renderPortrait(ctx, unit, helpers) {
    const first = Array.from(String(unit.name ?? '').trim())[0] || '？';
    const face = el('button', {
        type: 'button', class: 'td-portrait',
        title: `${unit.name}：点击上传或更换头像`,
        'aria-label': `${unit.name}，上传或更换头像`,
    }, el('span', { class: 'td-portrait-initial', 'aria-hidden': 'true' }, first));
    const input = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', hidden: true });
    const wrap = el('div', { class: 'td-portrait-wrap' }, [face, input]);
    let key;
    try { key = portraitKey(ctx, unit); } catch (error) { face.title = error.message; }

    const show = (blob) => {
        if (!blob || !face.isConnected) return;
        const url = URL.createObjectURL(blob);
        const image = el('img', { alt: unit.name, class: 'td-portrait-image' });
        let observer;
        const release = () => { URL.revokeObjectURL(url); observer?.disconnect(); };
        image.onload = release;
        image.onerror = () => { release(); image.remove(); };
        if (typeof MutationObserver === 'function') {
            observer = new MutationObserver(() => { if (!face.isConnected) release(); });
            observer.observe(document.body, { childList: true, subtree: true });
        }
        image.src = url;
        face.appendChild(image);
    };
    if (key) getPortrait(key).then(show).catch(error => {
        // 首字仍可正常显示；用户点击上传时会收到明确的保存错误。
        face.title = `${unit.name}：${error.message}；点击重试上传`;
    });
    on(face, 'click', (event) => {
        event.stopPropagation();
        input.click();
    });
    on(input, 'click', event => event.stopPropagation());
    on(input, 'change', async (event) => {
        event.stopPropagation();
        const file = input.files?.[0];
        if (!file) return;
        face.disabled = true;
        try {
            if (!key) key = portraitKey(ctx, unit);
            if (file.size > 5 * 1024 * 1024) throw new Error('头像图片不能超过 5 MB');
            if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) {
                throw new Error('请选择 PNG、JPEG、WebP 或 GIF 图片');
            }
            // 成功解码后才替换旧头像，损坏文件不会覆盖已有图片。
            await new Promise((resolve, reject) => {
                const probe = new Image();
                const url = URL.createObjectURL(file);
                probe.onload = () => { URL.revokeObjectURL(url); resolve(); };
                probe.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片无法读取，请换一张图片')); };
                probe.src = url;
            });
            await savePortrait(key, file);
            toast(`${unit.name}的头像已保存`, 'success');
            helpers.rerender();
        } catch (error) {
            toast(error.message || '头像保存失败', 'error');
        } finally {
            face.disabled = false;
            input.value = '';
        }
    });
    return wrap;
}
