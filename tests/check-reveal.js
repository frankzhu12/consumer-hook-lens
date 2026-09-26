const { createSuite } = require('./harness');
const reveal = require('../utils/reveal');

const suite = createSuite('check-reveal.js');

// 一张图上的两处陷阱，顺序即揭示顺序
const HOOKS = [
  { id: 'C3', name: '凑单加购推荐' },
  { id: 'D1', name: '从众提示' }
];

// --- 初始状态 ---

suite.eq('什么都没揭示时，已揭示数为 0', reveal.revealedCount(HOOKS, []), 0);
suite.eq('什么都没揭示时，不算全部揭示', reveal.allRevealed(HOOKS, []), false);
suite.eq('第一处未揭示的是 C3', reveal.nextUnrevealed(HOOKS, []).id, 'C3');

// --- 逐个揭示 ---

suite.eq('揭示 C3 后，已揭示数为 1', reveal.revealedCount(HOOKS, ['C3']), 1);
suite.eq('揭示 C3 后，下一处是 D1', reveal.nextUnrevealed(HOOKS, ['C3']).id, 'D1');
suite.eq('两处都揭示后，全部揭示为真', reveal.allRevealed(HOOKS, ['C3', 'D1']), true);
suite.eq('全部揭示后，没有下一处', reveal.nextUnrevealed(HOOKS, ['C3', 'D1']), null);

// --- 重复与乱序不能算错 ---

suite.eq('重复 id 不会让计数翻倍', reveal.revealedCount(HOOKS, ['C3', 'C3']), 1);
suite.eq('乱序传入不影响计数', reveal.revealedCount(HOOKS, ['D1', 'C3']), 2);
suite.eq('揭示不存在的 id 不影响计数', reveal.revealedCount(HOOKS, ['Z9']), 0);
suite.eq('未揭示集合里存在脏 id 时，下一处仍是 C3', reveal.nextUnrevealed(HOOKS, ['Z9']).id, 'C3');

// --- 点击切换：点一次揭示，再点一次收起 ---

suite.eq('点一次 = 揭示', reveal.toggleRevealed([], 'C3'), ['C3']);
suite.eq('再点一次 = 收起', reveal.toggleRevealed(['C3'], 'C3'), []);
suite.eq('toggle 不会改动传进来的数组', (function () {
  const original = ['C3'];
  reveal.toggleRevealed(original, 'D1');
  return original;
})(), ['C3']);

// --- 进度文案 ---

suite.eq('内层进度写图内第几处', reveal.hookProgressText(HOOKS, []), '0 / 2');
suite.eq('内层进度写图内第几处（已揭示一处）', reveal.hookProgressText(HOOKS, ['C3']), '1 / 2');

// --- 提示语 ---

suite.eq('练模式下，剩一处时给「还有一处」', reveal.findHint('find-one', HOOKS, ['C3']), '还有一处，你觉得在哪？');
suite.eq('放手模式下一处都没找到时，说出总数但不说名字', reveal.findHint('find-all', HOOKS, []), '这张图里有 2 处，你来找找看');
suite.eq('教学模式下不给找的提示', reveal.findHint('reveal', HOOKS, []), '');
suite.eq('都找到了就不再提示', reveal.findHint('find-one', HOOKS, ['C3', 'D1']), '');
suite.eq('点错的提示不判错、不带惩罚', reveal.wrongTapHint(), '看看这里的作用');
suite.eq('跳过「自己找」的退路始终存在', reveal.skipHint(), '直接显示');

// --- 引导条：这一步该干什么（第一次打开的人唯一的说明书） ---

suite.eq('教学模式引导直接点图', reveal.guideText('reveal', HOOKS, []), '点图上你觉得是消费陷阱的地方，这里会告诉你它是什么');
suite.eq('练模式引导接着找', reveal.guideText('find-one', HOOKS, ['C3']), '还有一处，你觉得在哪？');
suite.eq('找齐了引导去按住或翻页', reveal.guideText('find-one', HOOKS, ['C3', 'D1']), '都找齐了。按住上面只看商品，或翻下一张');
suite.eq('教学模式找齐了同样给下一步', reveal.guideText('reveal', HOOKS, ['C3', 'D1']), '都找齐了。按住上面只看商品，或翻下一张');
suite.eq('没有陷阱时不给引导', reveal.guideText('reveal', [], []), '');

// --- 三档模式：教 → 练 → 放手 ---

suite.eq('三个模式的名字不能改（改了等于改了演示脚本）', reveal.SHOT_MODES, {
  REVEAL: 'reveal',
  FIND_ONE: 'find-one',
  FIND_ALL: 'find-all'
});
suite.eq('教学模式不算找', reveal.isFindMode('reveal'), false);
suite.eq('练模式算找', reveal.isFindMode('find-one'), true);
suite.eq('放手模式算找', reveal.isFindMode('find-all'), true);
suite.eq('未知模式一律不当作找（宁可退回教学，也不要卡住）', reveal.isFindMode('whatever'), false);

suite.eq('教学模式进屏时什么都不预先揭示', reveal.initialRevealed('reveal', HOOKS), []);
suite.eq('练模式进屏时也不再预制（统一为点图揭示）', reveal.initialRevealed('find-one', HOOKS), []);
suite.eq('放手模式进屏时一处都不给', reveal.initialRevealed('find-all', HOOKS), []);
suite.eq('练模式遇到空数据不会崩', reveal.initialRevealed('find-one', []), []);

suite.eq('找模式下没找到的卡片要藏名字', reveal.shouldHideName('find-all', 'D1', []), true);
suite.eq('找模式下找到的卡片要露名字', reveal.shouldHideName('find-all', 'D1', ['D1']), false);
suite.eq('教学模式下卡片一直露名字（不然不知道要找什么）', reveal.shouldHideName('reveal', 'D1', []), false);

// --- 空数据不能崩 ---

suite.noThrow('空数组不崩', function () {
  reveal.revealedCount([], []);
  reveal.nextUnrevealed([], []);
  reveal.allRevealed([], []);
  reveal.hookProgressText([], []);
  reveal.findHint('find-all', [], []);
  reveal.guideText('reveal', null, null);
});

suite.noThrow('脏数据不崩（null / undefined / 字符串）', function () {
  reveal.revealedCount(null, null);
  reveal.nextUnrevealed(undefined, 'not-an-array');
  reveal.allRevealed(null, []);
  reveal.toggleRevealed('not-an-array', 'C3');
  reveal.initialRevealed('find-one', null);
  reveal.findHint('find-one', null, null);
});

suite.done();
