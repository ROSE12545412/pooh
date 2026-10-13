import { strict as assert } from 'node:assert';
import { it } from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
const root = new URL('../', import.meta.url);
it('发布清单版本一致且入口和素材完整', () => {
    const manifest = JSON.parse(readFileSync(new URL('manifest.json', root), 'utf8'));
    const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
    assert.equal(manifest.version, pkg.version);
    for (const name of [manifest.js, manifest.css, 'assets/float-d20.png', 'assets/d20/LICENSE.txt']) {
        assert.ok(existsSync(new URL(name, root)), `Missing release asset: ${name}`);
    }
    assert.ok(!JSON.stringify({ manifest, pkg }).includes('YOUR_NAME'));
});
it('发布工作流携带assets且不打包日志或本地设置', () => {
    const workflow = readFileSync(new URL('.github/workflows/release.yml', root), 'utf8');
    const command = workflow.split('\n').find(line => line.trim().startsWith('cp -r '));
    assert.ok(command?.includes('src assets index.js style.css manifest.json'));
    assert.ok(!command.includes('*.log'));
    assert.ok(!command.includes('settings.local'));
});
