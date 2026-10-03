// 流水线单元测试：npx tsx experiments/voice-draft/ec3/selftest.mts
import { run } from './pipeline.mts';
import assert from 'node:assert';
const T = { 1: '我先看一下 go 005，现在是什么状态？', 2: '那除了证据不足，还有别的原因吗？', 3: '实际上我认为这些结论是样本质量造成的。', 4: '也就是说，进程形态是完全不一样的？', 5: '你刚才说的那个表，再解释一下' };
const ctx = '[用户] 查一下\n[Claude Code] GOAL-005 的状态是 achieved\n| 方案 | 代价 |\n| A | 高 |';
const raw = { items: [
  { id: 1, unit: 1, type: '问题', span: '我先看一下 go 005，现在是什么状态？', answers: null },
  { id: 2, unit: 2, type: '探路', span: '那除了证据不足，还有别的原因吗？', answers: null },
  { id: 3, unit: 3, type: '假设', span: '实际上我认为这些结论是样本质量造成的', answers: 2 },
  { id: 4, unit: 4, type: '事实', span: '也就是说进程形态是完全不一样的？', answers: null },
  { id: 5, unit: 5, type: '问题', span: '你刚才说的那个表再解释一下', answers: null },
  { id: 6, unit: 5, type: '事实', span: '这句话我编的', answers: null }],
  replacements: [{ from: 'go 005', to: 'GOAL-005' }, { from: 'go', to: 'server/*' }, { from: '状态', to: 'achieved' }], anchors: [{ unit: 5, lines: [3, 4] }, { unit: 1, lines: [2] }, { unit: 5, lines: [1, 3] }] };
const r = run(raw, T as any, ctx, true);
assert.equal(r.dropped, 1, '编造的跨度被丢弃');
assert.equal(r.overridden, 1, '求证式问句被覆盖成假设');
assert.equal(r.items.find((i) => i.id === 4)!.type, '假设');
assert.ok(r.items.find((i) => i.id === 2)!.answeredBy === 3, '自问自答合并');
assert.ok(!r.prompt.includes('还有别的原因吗'), '被回答的问题不渲染');
assert.ok(r.prompt.includes('GOAL-005'), '合法替换被应用');
assert.equal(r.replacements.accepted.length, 1);
assert.ok(r.replacements.rejected.some((x: any) => x.why === 'not-latin' || x.why === 'to-not-in-context' || x.why === 'concretizes' || x.why === 'from-in-context' || x.why === 'too-far'), '危险替换被拒绝');
assert.equal(r.anchors.ok.length, 1, '只接受带指代标志、行号合法且连续的引用');
assert.ok(r.prompt.includes('> 引用：| 方案 | 代价 |'), '引用逐字');
const r0 = run(raw, T as any, '', false); assert.equal(r0.replacements.accepted.length, 0); assert.equal(r0.anchors.ok.length, 0);
console.log('SELFTEST-OK'); console.log(r.prompt);
