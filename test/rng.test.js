/**
 * 随机数与骰子原语的测试。
 * 重点验证「同种子必然同结果」——这是战斗可复盘的前提。
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { MAX_DICE_COUNT, Rng, parseDiceExpression, randomSeedLabel, rollExpression } from '../src/core/rng.js';

describe('Rng 种子与复现', () => {
    it('相同种子的两个实例产生完全相同的序列', () => {
        const a = new Rng('test-seed');
        const b = new Rng('test-seed');
        const seqA = Array.from({ length: 50 }, () => a.next());
        const seqB = Array.from({ length: 50 }, () => b.next());
        assert.deepEqual(seqA, seqB);
    });

    it('不同种子产生不同序列', () => {
        const a = new Rng('seed-a');
        const b = new Rng('seed-b');
        const seqA = Array.from({ length: 20 }, () => a.next());
        const seqB = Array.from({ length: 20 }, () => b.next());
        assert.notDeepEqual(seqA, seqB);
    });

    it('字符串种子稳定哈希（同字符串 → 同种子）', () => {
        assert.equal(Rng.normalizeSeed('K7F2-9QX3'), Rng.normalizeSeed('K7F2-9QX3'));
        assert.notEqual(Rng.normalizeSeed('K7F2-9QX3'), Rng.normalizeSeed('K7F2-9QX4'));
    });

    it('快照可以精确还原序列（用于重放战斗）', () => {
        const rng = new Rng('replay-test');
        // 先消耗一些随机数
        for (let i = 0; i < 7; i++) rng.next();
        const snapshot = rng.snapshot();
        const expected = Array.from({ length: 10 }, () => rng.next());

        const restored = Rng.fromSnapshot(snapshot);
        const actual = Array.from({ length: 10 }, () => restored.next());
        assert.deepEqual(actual, expected);
    });

    it('next() 落在 [0, 1) 区间', () => {
        const rng = new Rng(12345);
        for (let i = 0; i < 1000; i++) {
            const value = rng.next();
            assert.ok(value >= 0 && value < 1, `越界：${value}`);
        }
    });

    it('int() 落在闭区间内且能取到两端', () => {
        const rng = new Rng('int-test');
        const seen = new Set();
        for (let i = 0; i < 2000; i++) {
            const value = rng.int(1, 6);
            assert.ok(Number.isInteger(value), '必须返回整数');
            assert.ok(value >= 1 && value <= 6, `越界：${value}`);
            seen.add(value);
        }
        assert.equal(seen.size, 6, '六个面都应该出现过');
    });

    it('int() 在 min > max 时不会崩，返回较小者', () => {
        const rng = new Rng('edge');
        // min=5 max=3 → 归一化后 lo=3 hi=5，但 hi<lo 成立时应当返回 lo 而不是乱数
        const value = rng.int(5, 3);
        assert.ok(Number.isInteger(value), '必须返回整数');
        assert.ok(value >= 3 && value <= 5, `超出归一化区间：${value}`);
    });

    it('dice() 返回的明细与总和一致', () => {
        const rng = new Rng('dice-test');
        for (let i = 0; i < 200; i++) {
            const result = rng.dice(3, 8);
            assert.equal(result.rolls.length, 3);
            assert.equal(result.total, result.rolls.reduce((a, b) => a + b, 0));
            for (const roll of result.rolls) assert.ok(roll >= 1 && roll <= 8);
        }
    });

    it('d20 只产生 1~20', () => {
        const rng = new Rng('d20-test');
        const seen = new Set();
        for (let i = 0; i < 3000; i++) seen.add(rng.d20());
        assert.equal(Math.min(...seen), 1);
        assert.equal(Math.max(...seen), 20);
    });

    it('weighted 遵循权重且能处理全零权重', () => {
        const rng = new Rng('weighted');
        const counts = { a: 0, b: 0 };
        for (let i = 0; i < 1000; i++) {
            counts[rng.weighted([{ item: 'a', weight: 9 }, { item: 'b', weight: 1 }], 'a')]++;
        }
        assert.ok(counts.a > counts.b * 3, `权重未生效：${JSON.stringify(counts)}`);
        assert.equal(rng.weighted([{ item: 'a', weight: 0 }], 'fallback'), 'fallback');
        assert.equal(rng.weighted([], 'fallback'), 'fallback');
    });

    it('shuffle 不修改原数组且元素不丢', () => {
        const rng = new Rng('shuffle');
        const original = [1, 2, 3, 4, 5, 6, 7, 8];
        const shuffled = rng.shuffle(original);
        assert.deepEqual(original, [1, 2, 3, 4, 5, 6, 7, 8], '原数组不应被修改');
        assert.deepEqual([...shuffled].sort((a, b) => a - b), original);
    });

    it('shuffle 同种子结果一致', () => {
        const a = new Rng('same').shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
        const b = new Rng('same').shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
        assert.deepEqual(a, b);
    });
});

describe('骰子安全预算', () => {
    it('超大或非有限输入在消耗随机数之前拒绝', () => {
        const rng = new Rng('budget');
        for (const count of [MAX_DICE_COUNT + 1, 999999999999, Infinity, NaN]) {
            assert.throws(() => rng.dice(count, 20), RangeError);
        }
        for (const faces of [Infinity, NaN, Number.MAX_SAFE_INTEGER]) {
            assert.throws(() => rng.dice(2, faces), RangeError);
        }
        assert.equal(rng.calls, 0);
        assert.equal(rng.dice(MAX_DICE_COUNT, 6).rolls.length, MAX_DICE_COUNT);
    });
    it('表达式拒绝超限输入，安全上限保持可用', () => {
        assert.equal(parseDiceExpression('999999999999d20'), null);
        assert.equal(parseDiceExpression('2d999999999999999999999'), null);
        assert.equal(parseDiceExpression('2d6+999999999999999999999'), null);
        assert.equal(parseDiceExpression(`${MAX_DICE_COUNT}d6`).count, MAX_DICE_COUNT);
        assert.equal(rollExpression(new Rng('fallback-budget'), '999999999999d20').rolls.length, 1);
    });
});

describe('骰子表达式', () => {
    it('解析常见写法', () => {
        assert.deepEqual(parseDiceExpression('d20'), { count: 1, faces: 20, modifier: 0 });
        assert.deepEqual(parseDiceExpression('2d6'), { count: 2, faces: 6, modifier: 0 });
        assert.deepEqual(parseDiceExpression('2d6+3'), { count: 2, faces: 6, modifier: 3 });
        assert.deepEqual(parseDiceExpression('1d8-1'), { count: 1, faces: 8, modifier: -1 });
        assert.deepEqual(parseDiceExpression(' 3D6 '), { count: 3, faces: 6, modifier: 0 });
    });

    it('拒绝非法表达式', () => {
        assert.equal(parseDiceExpression('abc'), null);
        assert.equal(parseDiceExpression('d'), null);
        assert.equal(parseDiceExpression(''), null);
        assert.equal(parseDiceExpression('2d6*3'), null);
    });

    it('rollExpression 的总和等于明细加修正', () => {
        const rng = new Rng('expr');
        const result = rollExpression(rng, '2d6+3');
        assert.equal(result.total, result.raw + 3);
        assert.equal(result.raw, result.rolls.reduce((a, b) => a + b, 0));
        assert.equal(result.rolls.length, 2);
    });

    it('rollExpression 遇到非法表达式会退化而不是抛错', () => {
        const rng = new Rng('fallback');
        const result = rollExpression(rng, 'garbage', 10);
        assert.equal(result.rolls.length, 1);
        assert.ok(result.total >= 1 && result.total <= 10);
    });
});

describe('randomSeedLabel', () => {
    it('生成的标签是 8 位、带连字符、无易混字符', () => {
        for (let i = 0; i < 50; i++) {
            const label = randomSeedLabel();
            assert.match(label, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
            // 不该出现容易看错的字符
            assert.doesNotMatch(label, /[IO01]/);
        }
    });

    it('多次生成基本不重复', () => {
        const set = new Set(Array.from({ length: 200 }, () => randomSeedLabel()));
        assert.ok(set.size > 190, `重复过多：${set.size}/200`);
    });
});
