const { createSuite } = require('./harness');
const hold = require('../utils/hold');

const suite = createSuite('check-hold.js');

const HOOKS = [
  { id: 'A1', rect: { x: 0, y: 0.5, w: 1, h: 0.08 } },
  { id: 'B1', rect: { x: 0.24, y: 0.75, w: 0.1, h: 0.03 } }
];

// --- 一处都没标出来时，按住没意义 ---

suite.eq('什么都没标出来，按不动', hold.canHold([]), false);
suite.eq('标出一处就按得动', hold.canHold(['A1']), true);
suite.eq('脏数据当作按不动', hold.canHold(null), false);

// --- 只盖已经标出来的那些 ---

suite.eq('只盖标出来的那一处', hold.coveredIds(HOOKS, ['A1']), ['A1']);
suite.eq('标出两处就盖两处', hold.coveredIds(HOOKS, ['A1', 'B1']), ['A1', 'B1']);
suite.eq('没标出来的一处不会被盖（盖了就是剧透答案）', hold.coveredIds(HOOKS, ['B1']), ['B1']);
suite.eq('空集合什么都不盖', hold.coveredIds(HOOKS, []), []);
suite.eq('跟着示例顺序，不跟着已标出的顺序', hold.coveredIds(HOOKS, ['B1', 'A1']), ['A1', 'B1']);

// --- 按钮文案 ---

suite.eq('没按住时是「按住，只看商品」', hold.holdLabel(false), '按住，只看商品');
suite.eq('按住时变成「松开，恢复」', hold.holdLabel(true), '松开，恢复');

// --- 按钮下面那行小字 ---

suite.eq('一处都没标出时，小字说的是「先标出一处」', hold.holdHintText(false, false), hold.HOLD_LOCKED_TEXT);
suite.eq('标出了没按住时，小字在邀请动作', hold.holdHintText(true, false), hold.HOLD_IDLE_TEXT);
suite.eq('按住时小字闭嘴（按住就是按住，一个字不多说）', hold.holdHintText(true, true), '');

// --- 图上不配说明文字 ---

// 2026-09-26 拆掉了按住时压在图上的那条横幅（用户：小字意义不大）。
// 这条断言守着「别再加回来」：hold 模块的导出里不许再出现横幅/点破类的东西。

const exported = Object.keys(hold);
const bannerKeys = exported.filter(function (k) {
  return /banner|caption|fallback/i.test(k);
});
suite.eq('hold 模块里没有横幅相关的导出（拆掉的东西别悄悄长回来）', bannerKeys, []);

// --- 别把界面搞崩 ---

suite.noThrow('脏数据不崩', function () {
  hold.coveredIds(null, null);
  hold.coveredIds(HOOKS, 'not-an-array');
  hold.holdHintText(undefined, undefined);
});

suite.done();
