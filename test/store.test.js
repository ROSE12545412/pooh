import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { EXT_ID, defaultChannel, defaultSettings } from '../src/config.js';
import { normalizePowerSystem } from '../src/core/schema.js';
import { exportAll, getChatData, getSettings, importAll } from '../src/core/store.js';

function context(settings = defaultSettings()) {
    return {
        extensionSettings: { [EXT_ID]: settings },
        chatMetadata: {},
        saveSettingsDebounced() {},
        async saveMetadata() {},
    };
}

function legacySettings(version) {
    const settings = {
        channelsAutoConfigured: true,
        p1: { channel: { ...defaultChannel(), apiKey: 'old-build-key' } },
        p2: {
            channel: { ...defaultChannel(), mode: 'custom', apiUrl: 'https://battle.example/v1', apiKey: 'battle-key', model: 'battle-model' },
            auto: true, detectNew: true, updateEveryN: 1,
        },
        buildMode: 'worldbook', draft: { text: 'old template' }, search: { enabled: true },
        battle: { decideChannel: 'p1', structureChannel: 'p1', sceneChannel: 'p1', sceneReadChannel: 'main', decideForEnemies: false },
    };
    if (version !== undefined) settings.settingsVersion = version;
    return settings;
}

function assertRemoved(settings) {
    for (const key of ['p1', 'buildMode', 'draft', 'search']) assert.equal(Object.hasOwn(settings, key), false, key);
    assert.deepEqual(Object.keys(settings.p2), ['channel']);
}

describe('配置删除迁移', () => {
    for (const version of [undefined, 1, 2]) {
        it(`迁移旧版本 ${version ?? '无版本号'}，保留战斗凭据并将 P1 选择改为 P2`, () => {
            const old = legacySettings(version);
            const channel = structuredClone(old.p2.channel);
            const ctx = context(old);
            const settings = getSettings(ctx);
            assertRemoved(settings);
            assert.deepEqual(settings.p2.channel, channel);
            for (const key of ['decideChannel', 'structureChannel', 'sceneChannel']) assert.equal(settings.battle[key], 'p2');
            assert.equal(settings.battle.sceneReadChannel, 'main');
            assert.equal(settings.battle.decideForEnemies, version === 2 ? false : true);
            // 真实读取与保存后的重新加载都不能通过补默认值复活旧自动更新。
            getSettings(ctx);
            const restored = getSettings(context(JSON.parse(JSON.stringify(settings))));
            assertRemoved(restored);
            assert.deepEqual(restored.p2.channel, channel);
        });
    }

    it('导入旧设置也执行迁移，后续用户关闭敌方决策不会被再次打开', async () => {
        const ctx = context();
        assert.equal((await importAll(ctx, { settings: legacySettings() }, { includeSettings: true })).ok, true);
        const settings = getSettings(ctx);
        assertRemoved(settings);
        assert.equal(settings.battle.decideChannel, 'p2');
        assert.equal(settings.p2.channel.apiKey, 'battle-key');
        settings.battle.decideForEnemies = false;
        assert.equal(getSettings(ctx).battle.decideForEnemies, false);
    });
});

describe('完整聊天存档导入导出', () => {
    it('保留场景、战斗快照、审计和结算，默认保留本机连接且不共享引用', async () => {
        const source = context();
        source.chatMetadata[EXT_ID] = {
            dataVersion: 1, createdAt: 123, updatedAt: 456,
            powerSystem: normalizePowerSystem({ allies: [{ name: '玩家', attributes: { HP: { current: 17, max: 30 } } }] }),
            battle: { round: 4, phase: 'acting', units: [{ id: 'player', hp: 17 }], rng: { seed: 'repeatable', state: 12345 }, log: [{ type: 'damage', amount: 13 }] },
            auditLog: [{ at: 400, round: 4, type: 'action', payload: { skill: '斩击' } }],
            battleResult: { text: '战斗胜利', sent: true, messageId: 42 },
        };
        const exported = exportAll(source);
        const wire = JSON.parse(JSON.stringify(exported));
        const destination = context();
        destination.extensionSettings[EXT_ID].p2.channel = { ...defaultChannel(), mode: 'custom', apiKey: 'local-key', model: 'local-model' };
        const localChannel = structuredClone(destination.extensionSettings[EXT_ID].p2.channel);
        let saves = 0;
        destination.saveMetadata = async () => { saves++; };
        assert.equal((await importAll(destination, wire)).ok, true);
        assert.equal(saves, 1);
        const restored = getChatData(destination);
        for (const key of ['battle', 'auditLog', 'battleResult', 'createdAt', 'dataVersion']) assert.deepEqual(restored[key], wire.chat[key], key);
        assert.equal(restored.powerSystem.combatants[0].attributes.HP.current, 17);
        assert.deepEqual(getSettings(destination).p2.channel, localChannel);
        const reexported = exportAll(destination);
        for (const key of ['battle', 'auditLog', 'battleResult']) assert.deepEqual(reexported.chat[key], exported.chat[key]);
        wire.chat.battle.units[0].hp = 0;
        exported.chat.auditLog[0].payload.skill = '改写';
        assert.equal(restored.battle.units[0].hp, 17);
        assert.equal(source.chatMetadata[EXT_ID].auditLog[0].payload.skill, '斩击');
    });

    it('仅导入审计时保留已有战斗和结算；显式 null 才清空战斗', async () => {
        const ctx = context();
        ctx.chatMetadata[EXT_ID] = { battle: { round: 2 }, auditLog: [], battleResult: { text: '旧结算' } };
        assert.equal((await importAll(ctx, { chat: { auditLog: [{ type: 'import' }] } })).ok, true);
        assert.deepEqual(getChatData(ctx).battle, { round: 2 });
        assert.deepEqual(getChatData(ctx).battleResult, { text: '旧结算' });
        assert.equal((await importAll(ctx, { chat: { battle: null } })).ok, true);
        assert.equal(getChatData(ctx).battle, null);
        assert.deepEqual(getChatData(ctx).auditLog, [{ type: 'import' }]);
    });
});
