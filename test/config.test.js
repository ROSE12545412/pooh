/**
 * 「开箱即用」相关逻辑的测试。
 *
 * 背景（真实设计错误）：最初把通道默认模式写死成 `tavern-helper`，
 * 但它依赖用户另外装一个扩展。没装的人一打开设置就看到「不可用」，
 * 得自己猜要装什么、该改成哪个模式。
 *
 * 现在改成按环境自动挑一个当下就能用的模式，并且给地址做「是不是第三方中转」的判定。
 */

import { strict as assert } from 'node:assert';
import { describe, it, afterEach } from 'node:test';

import {
    KNOWN_PROVIDER_HOSTS,
    defaultChannel,
    defaultSettings,
    describeEndpoint,
    pickDefaultChannel,
} from '../src/config.js';
import { autoConfigureChannels } from '../src/core/store.js';

/** 造一个只有连接配置的假 ctx。 */
function ctxWithProfiles(profiles) {
    return { extensionSettings: { connectionManager: { profiles } } };
}

const PROFILE_STRONG = {
    id: 'p-strong',
    name: 'claude-opus-4-6',
    model: 'claude-opus-4-6',
    api: 'custom',
    'api-url': 'https://momoapi.asia/',
};
const PROFILE_FAST = {
    id: 'p-fast',
    name: 'build-gemini-3.7-flash',
    model: 'build-gemini-3.7-flash',
    api: 'custom',
    'api-url': 'https://example.top/v1',
};

describe('describeEndpoint 端点来源判定', () => {
    it('识别常见官方服务商', () => {
        for (const url of [
            'https://api.siliconflow.cn/v1',
            'https://api.deepseek.com',
            'https://api.openai.com/v1/chat/completions',
            'https://open.bigmodel.cn/api/paas/v4',
            'https://dashscope.aliyuncs.com/compatible-mode/v1',
        ]) {
            const info = describeEndpoint(url);
            assert.equal(info.known, true, `${url} 应被识别为已知服务商`);
            assert.equal(info.isLocal, false);
        }
    });

    it('识别本地端点', () => {
        for (const url of ['http://localhost:1234/v1', 'http://127.0.0.1:8000/v1', 'http://192.168.1.5:5000/v1']) {
            const info = describeEndpoint(url);
            assert.equal(info.isLocal, true, `${url} 应被识别为本地`);
        }
    });

    it('第三方中转域名被标为未知', () => {
        // 这些是真实存在于用户配置里的中转站形态
        for (const url of ['https://momoapi.asia/', 'https://catiecli.sukaka.top/v1', 'https://some-free-api.xyz/v1']) {
            const info = describeEndpoint(url);
            assert.equal(info.known, false, `${url} 不应被识别为官方服务商`);
            assert.equal(info.isLocal, false);
            assert.ok(info.host, '必须能解析出主机名');
        }
    });

    it('没带协议也能抠出主机名', () => {
        const info = describeEndpoint('api.siliconflow.cn/v1');
        assert.equal(info.host, 'api.siliconflow.cn');
        assert.equal(info.known, true);
    });

    it('空输入不崩', () => {
        for (const value of ['', null, undefined, '   ']) {
            const info = describeEndpoint(value);
            assert.equal(info.known, false);
            assert.equal(info.host, '');
        }
    });

    it('已识别服务商的子域名也算已知', () => {
        const info = describeEndpoint('https://api.siliconflow.cn.evil.com/v1');
        // 注意：这个应当**不**被判为已知 —— 防止钓鱼域名靠后缀匹配蒙混过关
        assert.equal(info.host, 'api.siliconflow.cn.evil.com');
        assert.equal(info.known, false, '子域名后缀匹配不应被滥用成钓鱼入口');
    });

    it('已知服务商列表里没有奇怪的条目', () => {
        assert.ok(KNOWN_PROVIDER_HOSTS.length > 15);
        for (const host of KNOWN_PROVIDER_HOSTS) {
            assert.equal(host, host.toLowerCase(), `${host} 应当是小写`);
            assert.ok(!host.includes('://'), `${host} 不应带协议`);
        }
    });
});

describe('pickDefaultChannel 环境自适应', () => {
    const hadHelper = 'TavernHelper' in globalThis;
    const previousHelper = /** @type {any} */ (globalThis).TavernHelper;
    afterEach(() => {
        if (hadHelper) /** @type {any} */ (globalThis).TavernHelper = previousHelper;
        else delete /** @type {any} */ (globalThis).TavernHelper;
    });

    it('有连接配置时优先用 profile 模式（不用另填 Key）', () => {
        delete /** @type {any} */ (globalThis).TavernHelper;
        const pick = pickDefaultChannel(ctxWithProfiles([PROFILE_STRONG]));
        assert.equal(pick.mode, 'profile');
        assert.equal(pick.profileId, PROFILE_STRONG.id);
        assert.ok(pick.reason.includes('连接配置'));
    });

    it('战斗通道优先挑更快的模型', () => {
        delete /** @type {any} */ (globalThis).TavernHelper;
        const pick = pickDefaultChannel(ctxWithProfiles([PROFILE_STRONG, PROFILE_FAST]));
        assert.equal(pick.profileId, PROFILE_FAST.id, '战斗应挑 flash 那个');
    });

    it('名字都不匹配时退回第一个配置，而不是报错', () => {
        delete /** @type {any} */ (globalThis).TavernHelper;
        const weird = { id: 'w', name: '某某配置', model: 'x' };
        const pick = pickDefaultChannel(ctxWithProfiles([weird]));
        assert.equal(pick.mode, 'profile');
        assert.equal(pick.profileId, 'w');
    });

    it('没有连接配置但装了酒馆助手时用它', () => {
        /** @type {any} */ (globalThis).TavernHelper = { generateRaw: () => {} };
        const pick = pickDefaultChannel(ctxWithProfiles([]));
        assert.equal(pick.mode, 'tavern-helper');
        assert.ok(pick.reason.includes('JS-Slash-Runner'));
    });

    it('什么都没有时退回直连并提示手动填写', () => {
        delete /** @type {any} */ (globalThis).TavernHelper;
        const pick = pickDefaultChannel(ctxWithProfiles([]));
        assert.equal(pick.mode, 'custom');
        assert.ok(pick.reason.includes('手动'));
    });

    it('空 ctx 不崩', () => {
        delete /** @type {any} */ (globalThis).TavernHelper;
        const pick = pickDefaultChannel(null);
        assert.equal(pick.mode, 'custom');
    });
});

describe('autoConfigureChannels 只动没配置过的通道', () => {
    const hadHelper = 'TavernHelper' in globalThis;
    const previousHelper = /** @type {any} */ (globalThis).TavernHelper;
    afterEach(() => {
        if (hadHelper) /** @type {any} */ (globalThis).TavernHelper = previousHelper;
        else delete /** @type {any} */ (globalThis).TavernHelper;
    });

    it('全新的设置会被自动配好', () => {
        delete /** @type {any} */ (globalThis).TavernHelper;
        const settings = defaultSettings();
        const notes = autoConfigureChannels(ctxWithProfiles([PROFILE_STRONG]), settings);
        assert.equal(settings.p2.channel.mode, 'profile');
        assert.ok(notes.length >= 1, '应当返回调整说明');
    });

    it('用户已显式配置过的通道绝不被覆盖', () => {
        delete /** @type {any} */ (globalThis).TavernHelper;
        const settings = defaultSettings();
        settings.p2.channel.mode = 'custom';
        settings.p2.channel.apiUrl = 'https://my-own-gateway.example/v1';
        settings.p2.channel.model = 'my-model';

        autoConfigureChannels(ctxWithProfiles([PROFILE_STRONG]), settings);

        assert.equal(settings.p2.channel.mode, 'custom', '用户的显式选择被覆盖了');
        assert.equal(settings.p2.channel.apiUrl, 'https://my-own-gateway.example/v1');
        assert.equal(settings.p2.channel.model, 'my-model');
    });

    it('只填了 apiUrl 也算配置过（不覆盖）', () => {
        delete /** @type {any} */ (globalThis).TavernHelper;
        const settings = defaultSettings();
        settings.p2.channel.apiUrl = 'https://x.example/v1';
        autoConfigureChannels(ctxWithProfiles([PROFILE_STRONG]), settings);
        assert.equal(settings.p2.channel.mode, 'tavern-helper', '只填了地址不应被改成 profile');
        assert.equal(settings.p2.channel.profileId, '');
    });

    it('默认值本来就是 tavern-helper，没别的东西可用时不改', () => {
        /** @type {any} */ (globalThis).TavernHelper = { generateRaw: () => {} };
        const settings = defaultSettings();
        const notes = autoConfigureChannels(ctxWithProfiles([]), settings);
        assert.equal(settings.p2.channel.mode, 'tavern-helper');
        assert.equal(notes.length, 0, '没有更优选择时不该产生「调整说明」');
    });

    it('设置结构残缺时不崩', () => {
        delete /** @type {any} */ (globalThis).TavernHelper;
        assert.doesNotThrow(() => autoConfigureChannels(null, defaultSettings()));
        assert.doesNotThrow(() => autoConfigureChannels(ctxWithProfiles([]), {}));
        assert.doesNotThrow(() => autoConfigureChannels(ctxWithProfiles([]), { p2: {} }));
    });
});

describe('defaultChannel 与 defaultSettings 的结构', () => {
    it('通道含全部必需字段', () => {
        const channel = defaultChannel();
        for (const key of ['mode', 'profileId', 'apiUrl', 'apiKey', 'model', 'temperature', 'maxTokens', 'timeout', 'retries', 'useJsonSchema']) {
            assert.ok(key in channel, `缺少字段 ${key}`);
        }
    });

    it('设置里带 channelsAutoConfigured 标记（保证自适应只做一次）', () => {
        const settings = defaultSettings();
        assert.equal(settings.channelsAutoConfigured, false);
        assert.ok(settings.p2.channel);
        assert.equal(settings.p1, undefined);
    });

    it('各次默认设置互相独立，修改不会污染下一份设置', () => {
        const settings = defaultSettings();
        const other = defaultSettings();
        settings.p2.channel.mode = 'custom';
        settings.p2.channel.model = 'a';
        assert.equal(other.p2.channel.mode, 'tavern-helper');
        assert.equal(other.p2.channel.model, '');
    });
});
