import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { charmFor, generateBanter, evaluateCharm, shouldCheckCharm } from '../src/llm/banter.js';
import { LlmClient } from '../src/llm/client.js';
import { recordPersuasion, offerCharmCheck, previewCharmCheck } from '../src/combat/persuasion.js';

const text = '别替他撑场面了，过来跟我一起护住他们，好吗？';
const goal = '请洛汀在本场战斗转而支持阿禾。';
const oldReply = {
    reply: '如果你能保障他们，我愿意与你商量。', intent: 'persuasion', personaSummary: '珍视旧情，也承担保护同行者的承诺。',
    requestToDefect: true, requestEvidence: '过来跟我一起护住他们',
    wavering: true, waveringEvidence: '我愿意与你商量',
};
const modelReply = {
    ...oldReply, goal, progress: 52, summary: '已同意商量合作，仍需确认同行者安全。',
    reason: '旧情与共同保护目标使其愿意协商，安全承诺仍是阻力。', evidenceWarnings: [],
};
const assessment = { eligible: true, dc: 12, charmValue: 61, reason: '已有合作意愿降低阻力，安全条件尚未落实。' };

function fixture({ combatMode = 'spar', contextMessages = 3, charm = 82 } = {}) {
    const speaker = { id: 'speaker', name: '阿禾', side: 'ally', alive: true, statuses: [],
        social: { persona: '与洛汀自幼熟识，但对这场冲突的目的有分歧。',
            charm: charm === null ? [] : [{ targetName: '洛汀', value: charm, reason: '长期相处的信任。' }] } };
    const target = { id: 'target', name: '洛汀', side: 'enemy', alive: true, statuses: [],
        social: { persona: '珍视与阿禾的友情；与溪曾为恋人，同时答应岑守护同行者。', charm: [] } };
    const others = [
        { id: 'ally-other', name: '溪', side: 'ally', alive: true, statuses: [],
            social: { persona: '洛汀的旧侣，双方有尚未说明的误会。', charm: [] } },
        { id: 'enemy-other', name: '岑', side: 'enemy', alive: true, statuses: [],
            social: { persona: '将阿禾视为家人，与洛汀有保护同行者的约定。', charm: [] } },
    ];
    const battle = { combatMode, units: [speaker, target, ...others], initiative: [{ unitId: target.id, side: 'enemy' }],
        banterHistory: Array.from({ length: 14 }, (_, i) => ({ text: `近期口嗨${i}：仍在讨论保护同行者。` })) };
    const ctx = { name1: '阿禾', chat: Array.from({ length: 65 }, (_, i) => ({ name: '旁白', is_user: false,
        mes: `〈楼层:${String(i).padStart(2, '0')}〉第${i}层剧情。${i === 63 ? '旧侣间的误会与保护约定同时存在。' : ''}` })) };
    const settings = { banter: { contextMessages, channel: { mode: 'custom', model: 'independent-banter', temperature: 0.64 } },
        p1: { channel: { model: 'do-not-use-p1' } }, p2: { channel: { model: 'do-not-use-p2' } } };
    const persuasion = { speakerId: speaker.id, targetId: target.id, goal, progress: 37,
        summary: '先前愿意暂停攻击以讨论安全条件。', reason: '先前的保护承诺已建立部分信任。',
        pending: { eligible: true, dc: 17, charmValue: 82, modifier: 3, reason: '需落实承诺。' },
        lastRoll: { natural: 6, total: 9, success: false }, attempts: 2, status: 'pending',
        milestones: [{ progress: 37, summary: '同意讨论安全条件。', reason: '接受共同保护目标。' }] };
    return { ctx, settings, battle, speaker, target, persuasion, persona: { summary: '输入的人设整理', source: '当前剧情与人物资料' } };
}
function args(f, overrides = {}) {
    return { battle: f.battle, speaker: f.speaker, target: f.target, text, persona: f.persona,
        persuasion: f.persuasion, ...overrides };
}
// Standalone and serial: intercept the actual client boundary, restore the shared prototype on every exit.
async function withCompletions(values, run) {
    const original = LlmClient.prototype.complete;
    const calls = [];
    LlmClient.prototype.complete = async function (options) {
        const index = calls.length;
        calls.push({ ...options, data: JSON.parse(options.user), channel: this.config, label: this.label });
        assert.ok(index < values.length, 'unexpected extra model call');
        const value = typeof values[index] === 'function' ? await values[index](calls[index]) : values[index];
        return { ok: true, text: JSON.stringify(value) };
    };
    try {
        const result = await run(calls);
        assert.equal(calls.length, values.length, 'all expected model calls should be observed');
        return result;
    } finally {
        LlmClient.prototype.complete = original;
    }
}

// Run separately: node test/persuasion-llm.test.js
// Other suites also patch LlmClient.prototype.complete; do not import them here.
describe('模型累计说服契约与两阶段实际请求', { concurrency: false }, () => {
    it('两阶段都传完整关系背景、模式、近期口嗨和累计记录，使用独立banter.channel', async () => {
        const f = fixture();
        const signal = new AbortController().signal;
        const before = structuredClone(f);
        await withCompletions([modelReply, assessment], async calls => {
            const reply = await generateBanter(f.ctx, f.settings, args(f, { signal }));
            const result = await evaluateCharm(f.ctx, f.settings, args(f, { reply, signal }));
            for (const call of calls) {
                assert.equal(call.channel, f.settings.banter.channel);
                assert.equal(call.signal, signal);
                assert.equal(call.temperature, 0.64);
                assert.equal(call.data.combatMode, 'spar');
                assert.equal(call.data.combatants.length, f.battle.units.length);
                assert.deepEqual(call.data.combatants.map(unit => [unit.id, unit.social]),
                    f.battle.units.map(unit => [unit.id, unit.social]));
                assert.deepEqual(call.data.persona, f.persona);
                assert.deepEqual(call.data.persuasion, f.persuasion);
                assert.deepEqual(call.data.recentBattleTalk, f.battle.banterHistory.slice(-12).map(entry => entry.text));
                assert.match(call.data.context, /〈楼层:62〉/);
                assert.match(call.data.context, /旧侣间的误会与保护约定同时存在/);
                assert.match(call.data.context, /〈楼层:64〉/);
                assert.doesNotMatch(call.data.context, /〈楼层:61〉/);
                assert.match(call.system, /side=enemy只是当前战斗分队/);
                assert.match(call.system, /combatMode仅为战斗背景/);
                assert.match(call.system, /亲友也不自动答应或成功/);
                assert.match(call.system, /milestones、lastRoll、attempts与status/);
            }
            assert.equal(calls[1].data.context, calls[0].data.context);
            assert.equal(calls[1].data.currentPersuasion.goal, goal);
            assert.equal(calls[1].data.currentPersuasion.progress, 52);
            assert.equal(calls[1].data.currentPersuasion.summary, modelReply.summary);
            assert.deepEqual(calls[1].data.currentPersuasion.milestones, f.persuasion.milestones);
            assert.deepEqual(calls[1].data.currentPersuasion.lastRoll, f.persuasion.lastRoll);
            assert.equal(calls[1].data.currentPersuasion.attempts, 2);
            assert.equal(calls[1].data.npcReply, modelReply.reply);
            assert.equal(calls[1].data.intent, 'persuasion');
            assert.equal(reply.intent, 'persuasion');
            assert.equal(reply.reply, modelReply.reply, 'backstage metadata must not be appended to NPC dialogue');
            assert.match(calls[0].system, /intent只分类本次playerMessage的真实意图/);
            assert.match(calls[0].system, /不能把历史goal、progress或关系记忆当成本次正在劝说的证据/);
            assert.match(calls[0].system, /认真跟进真实承诺、顾虑、条件或理由，不必重复邀请/);
            assert.match(calls[0].system, /闲聊、逗趣、夸奖、示爱、口嗨和空泛威胁不因已有目标而成为劝说/);
            assert.match(calls[0].system, /威胁若确实被用于要求对方改变立场或行动，可以按实际意图归persuasion/);
            assert.match(calls[0].system, /不得把分析、原因、数值、进度、检定条件、旁白或动作叙述写进reply/);
            const schema = calls[0].jsonSchema.value;
            assert.equal(calls[0].jsonSchema.strict, true);
            for (const key of ['reply', 'intent', 'personaSummary', 'requestToDefect', 'requestEvidence', 'wavering', 'waveringEvidence',
                'goal', 'progress', 'summary', 'reason', 'evidenceWarnings']) {
                assert.ok(schema.required.includes(key), `${key} must be required`);
                assert.ok(schema.properties[key]);
            }
            assert.equal(schema.properties.intent.type, 'string');
            assert.deepEqual(schema.properties.intent.enum, ['persuasion', 'taunt', 'banter']);
            assert.deepEqual(schema.properties.evidenceWarnings.items, { type: 'string' });
            assert.equal(schema.properties.progress.minimum, 0);
            assert.equal(schema.properties.progress.maximum, 100);
            assert.equal(result.dc, 12);
            assert.equal(result.charmValue, 82, 'reuse existing directed charm rather than model replacement');
            assert.equal(result.modifier, 3);
            assert.equal(result.estimated, false);
        });
        assert.deepEqual(f, before, 'the two LLM stages must not mutate battle, units, chat, or stored persuasion');
    });

    it('两个阶段的楼层范围都限制为最近1..60，长楼层也保留末尾关系信息', async () => {
        for (const [configured, expected] of [[0, 1], [1, 1], [3, 3], [60, 60], [100, 60], [NaN, 12]]) {
            const f = fixture({ contextMessages: configured });
            f.ctx.chat[64].mes += `${'剧情'.repeat(2200)}末尾关系证据仍须可见`;
            await withCompletions([modelReply, assessment], async calls => {
                const reply = await generateBanter(f.ctx, f.settings, args(f));
                await evaluateCharm(f.ctx, f.settings, args(f, { reply }));
                for (const call of calls) {
                    assert.equal((call.data.context.match(/〈楼层:\d+〉/g) ?? []).length, expected);
                    assert.match(call.data.context, /末尾关系证据仍须可见/);
                    assert.doesNotMatch(call.data.context, /〈楼层:04〉/);
                }
            });
        }
    });

    it('模型确认本次仍是劝说的承诺跟进无需复述邀请，历史目标本身不能把新话语变成劝说', async () => {
        const f = fixture();
        const continuation = { ...modelReply, requestToDefect: false, requestEvidence: '', goal: '', progress: 58,
            reply: '好，你答应的条件我记住了。', waveringEvidence: '你答应的条件我记住了',
            summary: '接受安全保障的补充说明，仍等待行动保证。' };
        const noNewOpening = { ...continuation, reply: '我还需要考虑一下。', wavering: false, waveringEvidence: '', progress: 0, summary: '' };
        await withCompletions([continuation, noNewOpening, assessment], async calls => {
            const first = await generateBanter(f.ctx, f.settings, args(f, { text: '他们的安全我会负责。' }));
            assert.equal(first.requestToDefect, false);
            assert.equal(first.intent, 'persuasion');
            assert.equal(calls[0].data.playerMessage, '他们的安全我会负责。');
            assert.equal(first.goal, goal);
            assert.equal(first.progress, 58);
            assert.equal(shouldCheckCharm(f.target, first), true);
            const saved = { ...f.persuasion, ...first };
            const second = await generateBanter(f.ctx, f.settings, args(f, { text: '我会信守承诺。', persuasion: saved }));
            assert.equal(second.goal, goal);
            assert.equal(second.progress, 58);
            assert.equal(second.summary, first.summary);
            assert.equal(second.wavering, false);
            assert.equal(shouldCheckCharm(f.target, second, saved), true);
            assert.equal(shouldCheckCharm(f.target, { requestToDefect: false, wavering: false }, saved), false);
            assert.equal(shouldCheckCharm(f.target, { intent: 'persuasion', requestToDefect: false, wavering: false }, saved), true);
            await evaluateCharm(f.ctx, f.settings, args(f, { reply: second, persuasion: saved }));
            assert.equal(calls[2].data.currentPersuasion.goal, goal);
            assert.equal(calls[2].data.currentPersuasion.progress, 58);
        });
    });

    it('闲聊、挑衅或缺失非法intent保留旧记忆，拒绝模型虚报的目标、99进度和true标记，且不调用第二阶段', async () => {
        for (const [intent, currentText] of [
            ['banter', '今天气色真好，抱一下。'], ['taunt', '你也敢拦我？等着瞧。'],
            ...[undefined, null, '', 'Persuasion', ' persuasion ', 'support', true, { value: 'persuasion' }].map(value => [value, text]),
        ]) {
            const f = fixture();
            const npcReply = '你今天也很精神。';
            const raw = { ...modelReply, intent, reply: npcReply, goal: '模型虚构的新换边目标', progress: 99,
                summary: '模型虚构的新增承诺与进展', reason: '模型错误地把历史目标延续到本句',
                requestEvidence: currentText, waveringEvidence: npcReply };
            for (const saved of [f.persuasion, undefined]) {
                const before = structuredClone(f);
                await withCompletions([raw], async calls => {
                    const reply = await generateBanter(f.ctx, f.settings, args(f, { text: currentText, persuasion: saved }));
                    assert.equal(reply.intent, intent === 'taunt' ? 'taunt' : 'banter');
                    assert.equal(reply.reply, npcReply);
                    assert.equal(reply.requestToDefect, true);
                    assert.equal(reply.wavering, true);
                    const previous = saved ?? { goal: '', progress: 0, summary: '', reason: '' };
                    for (const key of ['goal', 'progress', 'summary', 'reason']) assert.equal(reply[key], previous[key], `${key} must retain saved memory`);
                    assert.equal(reply.requestEvidence, currentText);
                    assert.equal(reply.waveringEvidence, npcReply);
                    assert.deepEqual(reply.evidenceWarnings, [], 'even exact quotes cannot override the model intent classification');
                    assert.equal(shouldCheckCharm(f.target, reply, saved), false);
                    assert.deepEqual(await evaluateCharm(f.ctx, f.settings, args(f, { reply, persuasion: saved })),
                        { eligible: false, reason: '本次不是劝说' });
                    assert.equal(calls.length, 1, 'ordinary dialogue must only call the NPC reply stage');
                });
                assert.deepEqual(f, before, 'ordinary dialogue must not mutate any saved state');
            }
        }
    });

    it('直接评估未分类或非劝说回复也在构造请求前退出，不依赖历史目标、true标记或引用', async () => {
        const f = fixture();
        const before = structuredClone(f.persuasion);
        await withCompletions([], async () => {
            for (const reply of [undefined, null, ...['banter', 'taunt', undefined, 'invalid'].map(intent => ({ ...modelReply, intent }))]) {
                assert.equal(shouldCheckCharm(f.target, reply, f.persuasion), false);
                assert.deepEqual(await evaluateCharm(undefined, undefined, { reply, persuasion: f.persuasion }),
                    { eligible: false, reason: '本次不是劝说' });
            }
        });
        assert.deepEqual(f.persuasion, before);
    });

    it('同一句威胁是否用于要求改变立场由模型intent决定，不由本地关键词决定', async () => {
        const f = fixture();
        const demand = '不想我再出手，就帮我护住他们。';
        for (const intent of ['taunt', 'persuasion']) {
            const raw = { ...modelReply, intent, progress: 63, requestEvidence: demand };
            await withCompletions(intent === 'persuasion' ? [raw, assessment] : [raw], async () => {
                const reply = await generateBanter(f.ctx, f.settings, args(f, { text: demand }));
                assert.equal(reply.intent, intent);
                assert.equal(reply.progress, intent === 'persuasion' ? 63 : f.persuasion.progress);
                assert.equal(shouldCheckCharm(f.target, reply, f.persuasion), intent === 'persuasion');
                const result = await evaluateCharm(f.ctx, f.settings, args(f, { text: demand, reply }));
                assert.equal(result.eligible, intent === 'persuasion');
            });
        }
    });

    it('低累计回报、缺字段与非法进度均不得清零，超范围值被限制在0..100', async () => {
        const f = fixture();
        f.persuasion.progress = 76;
        for (const progress of [0, 5, -10, undefined, null, '0', NaN]) {
            const raw = { ...modelReply, goal: '', progress, summary: '', requestToDefect: false, wavering: false };
            await withCompletions([raw], async () => {
                const reply = await generateBanter(f.ctx, f.settings, args(f));
                assert.equal(reply.goal, goal);
                assert.equal(reply.progress, 76);
                assert.equal(reply.summary, f.persuasion.summary);
            });
        }
        await withCompletions([{ ...modelReply, progress: 2, summary: '本句没有新进展。' }, { ...modelReply, progress: 130 }], async () => {
            const low = await generateBanter(f.ctx, f.settings, args(f));
            assert.equal(low.summary, f.persuasion.summary, 'a lower model report must not overwrite established stance memory');
            const high = await generateBanter(f.ctx, f.settings, args(f));
            assert.equal(high.progress, 100);
        });
        assert.equal(f.persuasion.progress, 76);
    });

    it('明确分类为劝说的boolean响应只产生最小进展，重复消息不按次数加分，显式0仍为0', async () => {
        const f = fixture();
        await withCompletions([oldReply, oldReply, oldReply, { ...modelReply, progress: 0 }], async () => {
            const first = await generateBanter(f.ctx, f.settings, args(f, { persuasion: undefined }));
            assert.equal(first.progress, 1);
            assert.ok(first.goal);
            assert.ok(first.summary);
            assert.ok(first.reason);
            assert.deepEqual(first.evidenceWarnings, []);
            const second = await generateBanter(f.ctx, f.settings, args(f, { persuasion: { ...first, attempts: 999 } }));
            assert.equal(second.progress, 1);
            const established = await generateBanter(f.ctx, f.settings, args(f));
            assert.equal(established.progress, 37);
            const explicitZero = await generateBanter(f.ctx, f.settings, args(f, { persuasion: undefined }));
            assert.equal(explicitZero.progress, 0, 'do not manufacture progress on top of an explicit model value');
            assert.equal(shouldCheckCharm(f.target, explicitZero), false);
        });
    });

    it('闲聊、坚决拒绝或讽刺本身不产生进展；入口仍要求活着的enemy、目标和正进度', async () => {
        const f = fixture();
        for (const [reply, intent, requestToDefect, wavering] of [
            ['今天的风确实很大。', 'banter', false, false], ['绝不答应。', 'persuasion', true, false],
            ['你真会做梦。', 'persuasion', true, false], ['我在犹豫要不要喝水。', 'banter', false, true],
        ]) {
            await withCompletions([{ ...oldReply, reply, intent, requestToDefect, wavering, requestEvidence: '', waveringEvidence: '' }], async () => {
                const result = await generateBanter(f.ctx, f.settings, args(f, { persuasion: undefined }));
                assert.equal(result.progress, 0);
                assert.equal(shouldCheckCharm(f.target, result), false);
            });
        }
        assert.equal(shouldCheckCharm(f.target, oldReply), true, 'classified persuasion can still use boolean progress compatibility');
        assert.equal(shouldCheckCharm({ ...f.target, alive: false }, modelReply, f.persuasion), false);
        for (const side of ['ally', 'neutral']) assert.equal(shouldCheckCharm({ ...f.target, side }, modelReply, f.persuasion), false);
        assert.equal(shouldCheckCharm(f.target, { intent: 'persuasion', goal: '', progress: 80 }), false);
        assert.equal(shouldCheckCharm(f.target, { intent: 'persuasion', goal, progress: 0 }), false);
        assert.equal(shouldCheckCharm(f.target, { intent: 'persuasion', goal, progress: 12, wavering: false, requestToDefect: false }), true);
        assert.equal(shouldCheckCharm(f.target, undefined, f.persuasion), false);
        assert.equal(shouldCheckCharm(null, modelReply, f.persuasion), false);
    });

    it('完全愿意可以进入条件评估，100进度也不自动掷骰或改变阵营', async () => {
        const f = fixture();
        let rolls = 0;
        f.battle.rng = { int() { rolls++; throw new Error('LLM stages must never roll dice'); } };
        const before = structuredClone({ units: f.battle.units, initiative: f.battle.initiative, persuasion: f.persuasion });
        const willing = { ...modelReply, reply: '我愿意和你站在一起，尽我所能帮助你。', progress: 100,
            waveringEvidence: '我愿意和你站在一起', summary: '完全愿意支持说话者，尚未执行换边。' };
        await withCompletions([willing, { ...assessment, dc: 5 }], async () => {
            const reply = await generateBanter(f.ctx, f.settings, args(f));
            assert.equal(reply.wavering, true);
            assert.equal(shouldCheckCharm(f.target, reply), true);
            const conditions = await evaluateCharm(f.ctx, f.settings, args(f, { reply }));
            assert.equal(conditions.eligible, true);
            assert.equal(conditions.dc, 5);
            assert.equal(conditions.success, undefined);
            assert.equal(conditions.natural, undefined);
        });
        assert.equal(rolls, 0);
        assert.equal(f.target.side, 'enemy');
        assert.deepEqual({ units: f.battle.units, initiative: f.battle.initiative, persuasion: f.persuasion }, before);
    });

    it('自然口语和引用格式问题只报告warnings，不否决模型识别的意图、关系或积极立场', async () => {
        for (const persona of ['是说话者的长辈，但这次存在利益冲突。', '曾与说话者相恋，彼此都有未尽责任。', '与说话者素不相识的雇员，正在权衡承诺。']) {
            const f = fixture();
            f.target.social.persona = persona;
            const raw = { ...modelReply, goal: '', progress: 63,
                requestEvidence: '“过来，跟我一起护住他们。”', waveringEvidence: '“我愿意与你商量。”',
                evidenceWarnings: ['模型提示：请求为自然口语，引用含补充标点。', 12, null] };
            await withCompletions([raw, assessment], async calls => {
                const reply = await generateBanter(f.ctx, f.settings, args(f, { persuasion: undefined }));
                assert.equal(reply.requestToDefect, true);
                assert.equal(reply.wavering, true);
                assert.equal(reply.progress, 63);
                assert.ok(reply.goal);
                assert.equal(reply.evidenceWarnings.length, 3);
                assert.ok(reply.evidenceWarnings.every(warning => typeof warning === 'string'));
                assert.match(reply.evidenceWarnings.join('\n'), /requestEvidence未逐字匹配/);
                assert.match(reply.evidenceWarnings.join('\n'), /waveringEvidence未逐字匹配/);
                assert.equal(shouldCheckCharm(f.target, reply), true);
                const result = await evaluateCharm(f.ctx, f.settings, args(f, { reply, persuasion: undefined }));
                assert.equal(result.eligible, true);
                assert.equal(calls[1].data.target.persona, persona);
                assert.deepEqual(calls[1].data.evidenceWarnings, reply.evidenceWarnings);
                assert.match(calls[1].system, /不因引号、标点、转述或引用缺失否决已识别的关系与意图/);
            });
        }
        const f = fixture();
        await withCompletions([{ ...oldReply, requestEvidence: '', waveringEvidence: '' }], async () => {
            const reply = await generateBanter(f.ctx, f.settings, args(f, { persuasion: undefined }));
            assert.equal(reply.requestToDefect, true);
            assert.equal(reply.wavering, true);
            assert.equal(reply.progress, 1);
            assert.equal(reply.evidenceWarnings.length, 2);
        });
    });

    it('不同战斗模式只是两阶段输入，相同模型判断得到相同条件', async () => {
        const replies = [];
        const conditions = [];
        for (const combatMode of ['spar', 'deadly', 'custom-scene-mode']) {
            const f = fixture({ combatMode });
            await withCompletions([modelReply, assessment], async calls => {
                const reply = await generateBanter(f.ctx, f.settings, args(f));
                replies.push(reply);
                conditions.push(await evaluateCharm(f.ctx, f.settings, args(f, { reply })));
                for (const call of calls) assert.equal(call.data.combatMode, combatMode);
                assert.equal(f.target.side, 'enemy');
            });
        }
        assert.deepEqual(replies[1], replies[0]);
        assert.deepEqual(replies[2], replies[0]);
        assert.deepEqual(conditions[1], conditions[0]);
        assert.deepEqual(conditions[2], conditions[0]);
    });

    it('评估实际看到新旧累计进展，DC由模型依据阻力给出，提示包含DC校准和1/20公式', async () => {
        const f = fixture({ charm: null });
        const evaluateFromPayload = call => ({ ...assessment, dc: call.data.currentPersuasion.progress >= 70 ? 10 : 19,
            reason: `累计进展${call.data.currentPersuasion.progress}；结合承诺落实情况评估剩余阻力。` });
        await withCompletions([evaluateFromPayload, evaluateFromPayload], async calls => {
            const lower = await evaluateCharm(f.ctx, f.settings, args(f, { reply: { ...modelReply, progress: 40 } }));
            const higher = await evaluateCharm(f.ctx, f.settings, args(f, { reply: { ...modelReply, progress: 75 } }));
            assert.equal(lower.dc, 19);
            assert.equal(higher.dc, 10);
            assert.equal(higher.charmValue, 61);
            assert.equal(higher.modifier, 1);
            assert.equal(higher.estimated, true);
            assert.match(higher.reason, /累计进展75/);
            const system = calls[1].system;
            assert.match(system, /progress和summary必须实际参与DC评估/);
            for (const calibration of ['5很容易', '10容易', '15中等', '20困难', '25/30极难']) assert.ok(system.includes(calibration));
            assert.match(system, /d20 \+ floor\(\(定向魅力 - 50\) \/ 10\) >= DC/);
            assert.match(system, /天然1必败、天然20必成/);
            assert.match(system, /DC25或30只有天然20能成功/);
            assert.match(system, /现在掷骰或继续劝说/);
        });
    });

    it('旧调用可省略battle/persuasion，已有魅力沿用，模型DC完整支持5..30', async () => {
        const f = fixture();
        assert.deepEqual(charmFor(f.speaker, f.target), { value: 82, reason: '长期相处的信任。' });
        await withCompletions([oldReply, ...[5, 10, 15, 20, 25, 30].map(dc => ({ ...assessment, dc }))], async calls => {
            const reply = await generateBanter(f.ctx, f.settings, args(f, { persuasion: undefined }));
            for (const dc of [5, 10, 15, 20, 25, 30]) {
                const result = await evaluateCharm(f.ctx, f.settings, { speaker: f.speaker, target: f.target, text, reply, persona: f.persona });
                assert.equal(result.dc, dc);
                assert.equal(result.charmValue, 82);
            }
            assert.equal(calls[1].data.combatMode, null);
            assert.equal(calls[1].data.combatants.length, 2);
            assert.match(calls[1].data.context, /〈楼层:64〉/);
            assert.equal(calls[1].data.currentPersuasion.progress, 1);
            assert.ok(calls[1].data.currentPersuasion.goal);
        });
    });

    it('条件评估仍校验理由与合法DC/魅力，eligible=false保留旧返回形状', async () => {
        const f = fixture({ charm: null });
        const badValues = [
            [{ ...assessment, reason: '' }, /缺少有效依据/], [{ ...assessment, eligible: 'true' }, /缺少有效依据/],
            ...[4, 31, 15.5].map(dc => [{ ...assessment, dc }, /难度无效/]),
            ...[-1, 101, '50'].map(charmValue => [{ ...assessment, charmValue }, /魅力数值无效/]),
        ];
        for (const [value, error] of badValues) {
            await withCompletions([value], async () => {
                await assert.rejects(evaluateCharm(f.ctx, f.settings, args(f, { reply: modelReply })), error);
            });
        }
        await withCompletions([{ eligible: false, reason: '保护条件尚未形成可以检定的具体承诺。' }], async () => {
            assert.deepEqual(await evaluateCharm(f.ctx, f.settings, args(f, { persuasion: null, reply: { intent: 'persuasion', goal: '', progress: 0 } })),
                { eligible: false, reason: '保护条件尚未形成可以检定的具体承诺。' });
        });
    });

    it('recordPersuasion对非劝说只返回原状态或null，不初始化、不更新或清除待确认检定', () => {
        for (const reply of [undefined, null, ...['banter', 'taunt', undefined, 'invalid'].map(intent => ({
            ...modelReply, intent, progress: 99, goal: '虚报的新目标', summary: '虚报的新记忆',
        }))]) {
            const f = fixture();
            f.battle.persuasion = [f.persuasion];
            const before = structuredClone(f.battle);
            const array = f.battle.persuasion;
            const pending = f.persuasion.pending;
            assert.equal(recordPersuasion(f.battle, f.speaker, f.target, reply), f.persuasion);
            assert.equal(f.battle.persuasion, array);
            assert.equal(f.persuasion.pending, pending);
            assert.deepEqual(f.battle, before);
            for (const stored of [undefined, null, {}, [], [{ ...f.persuasion, speakerId: 'another-speaker' }]]) {
                const fresh = fixture();
                if (stored !== undefined) fresh.battle.persuasion = stored;
                const original = structuredClone(fresh.battle);
                assert.equal(recordPersuasion(fresh.battle, fresh.speaker, fresh.target, reply), null);
                assert.deepEqual(fresh.battle, original, 'do not create or replace persuasion storage for non-persuasion');
            }
        }
    });

    it('明确分类的劝说仍按说话者与目标单调累计，不改动其他角色对的进展', () => {
        const f = fixture();
        const otherPair = { ...structuredClone(f.persuasion), speakerId: 'ally-other' };
        const originalOther = structuredClone(otherPair);
        const lastRoll = structuredClone(f.persuasion.lastRoll);
        f.battle.persuasion = [f.persuasion, otherPair];
        const state = recordPersuasion(f.battle, f.speaker, f.target, { ...modelReply, progress: 63 });
        assert.equal(state, f.persuasion);
        assert.equal(state.progress, 63);
        assert.equal(state.revision, 1);
        assert.equal(state.summary, modelReply.summary);
        assert.equal(state.pending, null);
        assert.equal(state.status, 'awaiting_assessment');
        assert.equal(state.milestones.length, 2);
        assert.equal(recordPersuasion(f.battle, f.speaker, f.target, { ...modelReply, goal: '', progress: 10, summary: '不能覆盖既有记忆' }), state);
        assert.equal(state.goal, goal);
        assert.equal(state.progress, 63);
        assert.equal(state.summary, modelReply.summary);
        assert.equal(state.revision, 2);
        assert.equal(state.milestones.length, 2);
        assert.equal(state.attempts, 2);
        assert.deepEqual(state.lastRoll, lastRoll);
        assert.deepEqual(otherPair, originalOther);
    });

    it('最近本对NPC回复是闲聊或挑衅时隐藏旧检定但保留存档，新劝说经正常revision重建条件', () => {
        for (const intent of ['banter', 'taunt']) {
            const f = fixture();
            f.battle.id = 'battle';
            f.battle.persuasion = [f.persuasion];
            const state = recordPersuasion(f.battle, f.speaker, f.target, modelReply);
            const pending = offerCharmCheck(f.battle, state, assessment);
            const npcData = { speakerId: f.target.id, targetId: f.speaker.id };
            f.battle.banterHistory.push({ text: modelReply.reply, data: { ...npcData, intent: 'persuasion' } });
            assert.equal(previewCharmCheck(f.battle, f.speaker.id, f.target.id).id, pending.id);
            const saved = structuredClone(state);
            assert.equal(recordPersuasion(f.battle, f.speaker, f.target, { ...modelReply, intent, progress: 99 }), state);
            f.battle.banterHistory.push({ text: '这天气倒还不错。', data: { ...npcData, intent } });
            const beforePreview = structuredClone(f.battle);
            assert.equal(previewCharmCheck(f.battle, f.speaker.id, f.target.id), null);
            assert.deepEqual(f.battle, beforePreview, 'hiding the old offer is a pure read');
            assert.equal(state.pending, pending);
            assert.deepEqual(state, saved);
            f.battle.banterHistory.push(
                { text: '未分类旧NPC回复', data: npcData },
                { text: '非法分类旧NPC回复', data: { ...npcData, intent: 'unknown' } },
                { text: '另一个目标的劝说', data: { ...npcData, speakerId: 'enemy-other', intent: 'persuasion' } },
                { text: '对另一个说话者的劝说', data: { ...npcData, targetId: 'ally-other', intent: 'persuasion' } },
                { text: '玩家发言', data: { speakerId: f.speaker.id, targetId: f.target.id, intent: 'persuasion' } },
            );
            assert.equal(previewCharmCheck(f.battle, f.speaker.id, f.target.id), null, 'ignore unclassified and other-pair records when finding the latest classified NPC reply');
            assert.deepEqual(state, saved);
            const newReply = { ...modelReply, progress: 68, summary: '接受了关于安全保障的进一步承诺。' };
            recordPersuasion(f.battle, f.speaker, f.target, newReply);
            f.battle.banterHistory.push({ text: newReply.reply, data: { ...npcData, intent: newReply.intent } });
            assert.equal(previewCharmCheck(f.battle, f.speaker.id, f.target.id), null, 'new persuasion must obtain fresh assessment conditions');
            const newPending = offerCharmCheck(f.battle, state, { ...assessment, dc: 10 });
            const preview = previewCharmCheck(f.battle, f.speaker.id, f.target.id);
            assert.notEqual(newPending.id, pending.id);
            assert.equal(preview.id, newPending.id);
            assert.equal(preview.progress, 68);
            assert.equal(preview.dc, 10);
            assert.equal(preview.speakerName, f.speaker.name);
            assert.equal(preview.targetName, f.target.name);
        }
    });

    it('旧存档无分类记录或只有其他角色对的普通回复时仍可预览原有检定，敌方和存活门槛不变', () => {
        const f = fixture();
        f.battle.id = 'legacy-battle';
        f.battle.persuasion = [f.persuasion];
        const state = recordPersuasion(f.battle, f.speaker, f.target, modelReply);
        const pending = offerCharmCheck(f.battle, state, assessment);
        const npcData = { speakerId: f.target.id, targetId: f.speaker.id };
        for (const history of [undefined, null, {}, [], [
            { text: '旧口嗨没有data' },
            { text: '旧NPC回复没有intent', data: npcData },
            { text: '旧NPC回复分类无效', data: { ...npcData, intent: 'unknown' } },
            { text: '另一个目标的普通回复', data: { ...npcData, speakerId: 'enemy-other', intent: 'banter' } },
            { text: '对另一位说话者的挑衅', data: { ...npcData, targetId: 'ally-other', intent: 'taunt' } },
            { text: '玩家普通发言', data: { speakerId: f.speaker.id, targetId: f.target.id, intent: 'banter' } },
        ]]) {
            f.battle.banterHistory = history;
            const before = structuredClone(f.battle);
            assert.equal(previewCharmCheck(f.battle, f.speaker.id, f.target.id).id, pending.id);
            assert.deepEqual(f.battle, before);
        }
        for (const side of ['ally', 'neutral']) {
            f.target.side = side;
            assert.equal(previewCharmCheck(f.battle, f.speaker.id, f.target.id), null);
        }
        f.target.side = 'enemy';
        f.target.alive = false;
        assert.equal(previewCharmCheck(f.battle, f.speaker.id, f.target.id), null);
        f.target.alive = true;
        f.battle.phase = 'finished';
        assert.equal(previewCharmCheck(f.battle, f.speaker.id, f.target.id), null);
        assert.equal(state.pending, pending, 'invalidating the display never deletes pending data');
    });

    it('两个阶段继续透传取消信号，拒绝已经取消或迟到的结果', async () => {
        const f = fixture();
        for (const stage of ['talk', 'assess']) {
            const call = signal => stage === 'talk'
                ? generateBanter(f.ctx, f.settings, args(f, { signal }))
                : evaluateCharm(f.ctx, f.settings, args(f, { signal, reply: modelReply }));
            const alreadyAborted = new AbortController();
            alreadyAborted.abort();
            await withCompletions([], async () => {
                await assert.rejects(call(alreadyAborted.signal), error => error.name === 'AbortError');
            });
            const late = new AbortController();
            await withCompletions([options => {
                assert.equal(options.signal, late.signal);
                late.abort();
                return stage === 'talk' ? modelReply : assessment;
            }], async () => {
                await assert.rejects(call(late.signal), error => error.name === 'AbortError');
            });
        }
    });
});
