/**
 * 页面状态机 —— 把页面在 Node 里跑起来测。
 *
 * 为什么值得这么做：TODO 里那条验收标准是「连续按 10 次不出现状态错乱」。
 * 人在手机上连按 10 次，看的是「好像没坏」；脚本连按 10 次，比的是**每一次
 * 松手后的数据是否逐字段回到按住之前**。后者才是能挡住「第三屏按住之后
 * 盖子留在图上」这类 bug 的东西。
 *
 * 办法：小程序页面就是一个普通对象，页面级 API 只有 wx 和 Page 两个全局。
 * 把这两个桩掉，就能在 Node 里直接调页面的方法。
 *
 * 覆盖：按住按钮的状态机 + 卡片入口的开关 + 换屏时的状态清理。
 */

const { createSuite } = require('./harness');

const suite = createSuite('check-page.js');

// --- 桩：Page / wx ---

let pageConfig = null;
const toasts = [];
const navigations = [];

global.Page = function (cfg) {
  pageConfig = cfg;
};
global.wx = {
  showToast: function (o) {
    toasts.push(o && o.title);
  },
  navigateTo: function (o) {
    navigations.push(o && o.url);
  },
  navigateBack: function () {}
};
global.getCurrentPages = function () {
  return [{}, {}];
};

require('../pages/journey/index.js');

const hold = require('../utils/hold');
const card = require('../utils/card');
const { SHOTS } = require('../data/shots');

if (!pageConfig) {
  throw new Error('页面没把配置交给 Page()，后面的检查都无从谈起');
}

/** 造一个页面实例：把配置上的方法和 data 搬过来，再补一个 setData */
function makePage() {
  const inst = {};
  Object.keys(pageConfig).forEach(function (k) {
    inst[k] = pageConfig[k];
  });
  inst.data = JSON.parse(JSON.stringify(pageConfig.data));
  inst.setData = function (patch, cb) {
    const self = this;
    Object.keys(patch).forEach(function (k) {
      self.data[k] = patch[k];
    });
    if (typeof cb === 'function') cb.call(self);
  };
  return inst;
}

function tap(target, id, order) {
  return { currentTarget: { dataset: { id: id, order: order } } };
}

function snapshot(inst) {
  return JSON.stringify(inst.data);
}

/**
 * 逐字段比两次快照，只报**变了的那些字段**。
 * 直接打印两份 JSON 看着很唬人，但真正有用的信息只有「哪个字段变了」。
 */
function diffSnapshot(a, b) {
  const A = JSON.parse(a);
  const B = JSON.parse(b);
  const keys = {};
  Object.keys(A).forEach(function (k) { keys[k] = 1; });
  Object.keys(B).forEach(function (k) { keys[k] = 1; });
  const changed = [];
  Object.keys(keys).forEach(function (k) {
    const va = JSON.stringify(A[k]);
    const vb = JSON.stringify(B[k]);
    if (va !== vb) changed.push(k + '：' + va + ' → ' + vb);
  });
  return changed.length ? changed.join('；') : '（无差异）';
}

function assertSame(suite, name, inst, expected) {
  const now = snapshot(inst);
  if (now === expected) {
    suite.ok(name, true);
    return;
  }
  suite.ok(name + '（变了的是 ' + diffSnapshot(expected, now) + '）', false);
}

/** 把某张图上已标出的那几处列出来 */
function coveredOf(inst) {
  return inst.data.hooks.filter(function (h) { return h.covered; }).map(function (h) { return h.id; });
}

/** 把某张图上已标出的 id 列出来（不管按没按住） */
function revealedIds(inst) {
  return inst.data.hooks.filter(function (h) { return h.revealed; }).map(function (h) { return h.id; });
}

// --- 进场 ---

const page = makePage();
page.onLoad();

suite.eq('进场停在第一张示例', page.data.shotIndex, 0);
suite.eq('进场时没在按住', page.data.holding, false);
suite.eq('进场时「上一张」是置灰的（第一张没有上一张）', page.data.isFirstShot, true);
toasts.length = 0;
page.onPrevShot();
suite.eq('第一张点「上一张」不动', page.data.shotIndex, 0);
suite.eq('教学屏进场时一处都没标出', page.data.holdReady, false);
suite.eq('教学屏进场时按钮下面的小字是「先标出一处」', page.data.holdHint, hold.HOLD_LOCKED_TEXT);
suite.eq('进场时没有盖子', coveredOf(page).length, 0);
suite.eq('进场时引导条让用户直接点图', page.data.guide, '点图上你觉得是消费陷阱的地方，这里会告诉你它是什么');
suite.eq('教学屏没有「直接显示」退路（没有「找」可跳过）', page.data.skipLabel, '');

// --- 一处都没标出时按住：按下也不动，只给一句提示 ---

toasts.length = 0;
page.onHoldStart();
suite.eq('没标出时按下去也不会进入按住态', page.data.holding, false);
suite.eq('没标出时按下去会给一句提示', toasts[0], hold.HOLD_LOCKED_TEXT);

// --- 标出一处，按钮才活 ---
// 入口在图上：点中 hook，卡片才上线（点卡片只是教学屏上还留着的备用路径）

page.onHitTap(tap(null, 'A1', 1));
suite.eq('教学屏点图上的热区也能标出一处', page.data.holdReady, true);
suite.eq('标出后卡片跟着上线', page.data.hooks[0].revealed, true);
suite.eq('点中后轮到对应卡片', page.data.cardIndex, 0);
suite.eq('标出一处后小字变成邀请动作', page.data.holdHint, hold.HOLD_IDLE_TEXT);

// --- 按住 ---

const beforeHold = snapshot(page);
page.onHoldStart();

suite.eq('按住时进入按住态', page.data.holding, true);
suite.eq('按住时已标出的那处被盖住', coveredOf(page), ['A1']);
suite.eq('按住时按钮改成「松开，恢复」', page.data.holdBtnLabel, hold.holdLabel(true));
suite.eq('按住时小字让位', page.data.holdHint, '');
suite.eq('按住时分数依然可读（没被清掉）', page.data.hookProgress, '1 / 2');

// --- 按住期间不许误点把状态改乱 ---

page.onCardTap(tap(null, 'B1'));
suite.eq('按住时点卡片无效', coveredOf(page), ['A1']);
page.onHitTap(tap(null, 'B1', 2));
suite.eq('按住时点图上热区无效', coveredOf(page), ['A1']);
page.onRevealNext();
suite.eq('按住时「直接显示」无效', page.data.hookProgress, '1 / 2');
toasts.length = 0;
page.onStageTap();
suite.eq('按住时点空白不会弹提示', toasts.length, 0);

// --- 松手完全还原 ---

page.onHoldEnd();

suite.eq('松手后退出按住态', page.data.holding, false);
suite.eq('松手后盖子全没了', coveredOf(page).length, 0);
assertSame(suite, '松手后逐字段回到按住之前', page, beforeHold);

// --- 连续按 10 次不出现状态错乱 ---

let stable = true;
let firstBad = 0;
for (let i = 1; i <= 10; i++) {
  page.onHoldStart();
  page.onHoldEnd();
  if (snapshot(page) !== beforeHold) {
    stable = false;
    if (!firstBad) firstBad = i;
  }
}
suite.ok('连续按 10 次，每次松手后都回到按住之前' + (stable ? '' : '（第 ' + firstBad + ' 次就不对了）'), stable);

// 交替出现的极端情况：按下→按下→松开→松开，不该多盖一层或少盖一层
page.onHoldStart();
page.onHoldStart();
page.onHoldEnd();
page.onHoldEnd();
assertSame(suite, '重复按下松开也不多不少', page, beforeHold);

// 没按住时松手：不该有副作用
page.onHoldEnd();
assertSame(suite, '没按住时松手是空操作', page, beforeHold);

// 触摸被系统打断（来电、手势返回）也要还原
page.onHoldStart();
page.onHoldEnd();
assertSame(suite, '触摸被打断后也还原（touchcancel 走同一个处理）', page, beforeHold);

// 盖子上点一下不该有任何副作用
page.onHoldStart();
page.onCoverTap();
suite.eq('点盖子不改变任何状态', coveredOf(page), ['A1']);
page.onHoldEnd();

// --- 标出两处，那句话要同时点出两个名字 ---

page.onCardTap(tap(null, 'B1'));
suite.eq('两处都标出后引导条换成「找齐了」的下一步', page.data.guide, '都找齐了。按住上面只看商品，或翻下一张');
suite.eq('找齐后引导条不再是「点卡片」', page.data.allDone, true);
page.onHoldStart();
suite.eq('两处都标出时，图上盖住两处', coveredOf(page), ['A1', 'B1']);
page.onHoldEnd();

// --- 编号跟着「找到的先后」走：第一个点中的永远是 ① ---
// （修的 bug：先点中数据顺序靠后的那处，图上却跳出 ②——编号不该跟数据顺序，该跟人）

const seq = makePage();
seq.onLoad();
// 先点中数据里的第二处（划线价）：它就是 ①，卡片也切到它
seq.onHitTap(tap(null, 'B1', 2));
suite.eq('先点中数据里的第二处时，它的编号是 ①', seq.data.hooks[1].order, 1);
suite.eq('先点中它时，卡片也切到它', seq.data.cardIndex, 1);
suite.eq('没点中的那处还是热区，不出框', seq.data.hooks[0].revealed, false);
// 再点中第一处：接着编号 ②，先找到的那个不挪位
seq.onHitTap(tap(null, 'A1', 1));
suite.eq('后点中的那处接着编号 ②', seq.data.hooks[0].order, 2);
suite.eq('先找到的 ① 不因为数据顺序靠前而被挤成 ②', seq.data.hooks[1].order, 1);
// 点图上已标出的框：按 id 把对应卡片切到前面来
seq.onMarkTap({ currentTarget: { dataset: { id: 'A1' } } });
suite.eq('点 ② 的框，卡片切到 ②', seq.data.cardIndex, 0);
seq.onMarkTap({ currentTarget: { dataset: { id: 'B1' } } });
suite.eq('点 ① 的框，卡片切到 ①', seq.data.cardIndex, 1);

// --- 换到「练」的那一屏：不再预制任何一处，先点图上的热区 ---

page.onNextShot();

suite.eq('换屏后停在第二张', page.data.shotIndex, 1);
suite.eq('换屏后没在按住', page.data.holding, false);
suite.eq('换屏后按钮还锁着（练的那屏也不给预制的了）', page.data.holdReady, false);
suite.eq('换屏后图上没有残留的盖子', coveredOf(page).length, 0);
suite.eq('练屏的引导条跟着屏型换（两处都靠自己找）', page.data.guide, '这张图里有 2 处，你来找找看');
suite.eq('练屏有「直接显示」退路', page.data.skipLabel, '直接显示');

// 和第一屏同一个入口：点中图上的热区，卡片才上线
page.onHitTap(tap(null, 'C2', 1));
suite.eq('第二屏点图上的热区也能标出一处', page.data.holdReady, true);
suite.eq('点中后轮到对应卡片', page.data.cardIndex, 0);

page.onHoldStart();
suite.eq('在第二屏按住的，只盖第二屏已标出的那一处', coveredOf(page), ['C2']);
page.onHoldEnd();

// 按住的时候换屏（一只手按住、另一只手点「下一张」）：盖子不能跟到新屏
page.onHoldStart();
page.onNextShot();
suite.eq('按住时换屏，按住态被清掉', page.data.holding, false);
suite.eq('按住时换屏，新屏上没有盖子', coveredOf(page).length, 0);
suite.eq('按住时换屏后停在第三张', page.data.shotIndex, 2);

// --- 最后一屏：没有下一张 ---

page.onNextShot();
suite.eq('最后一屏再点「下一张」不动', page.data.shotIndex, 2);
suite.eq('最后一屏自己知道是最后一屏', page.data.isLastShot, true);

// --- 回退：上一张，进度不丢 ---
// 回退的意义全在「回去时东西还在」：goShot 若还是进屏即重置，
// 按钮就算加上了也只是「回去重做一遍」，那不是回退。

page.onPrevShot();
suite.eq('第三屏点「上一张」回到第二张', page.data.shotIndex, 1);
suite.eq('回退到第二屏，之前标出的 C3 原样还在', revealedIds(page), ['C2']);
suite.eq('回退后按住照常可用', page.data.holdReady, true);
suite.eq('回退后图上没有残留的盖子', coveredOf(page).length, 0);

page.onPrevShot();
suite.eq('再退回到第一张', page.data.shotIndex, 0);
suite.eq('回退到第一屏，A1、B1 都还在', revealedIds(page), ['A1', 'B1']);

page.onPrevShot();
suite.eq('第一张再点「上一张」不动', page.data.shotIndex, 0);
suite.eq('第一张自己知道是第一张', page.data.isFirstShot, true);

// 回退后再前进：恢复的是存档，不是重新初始化
page.onNextShot();
suite.eq('回退后再前进，第二屏的进度原样还原', revealedIds(page), ['C2']);
page.onNextShot();
suite.eq('再前进到第三屏，放手屏的存档是空集（离开时一处都没标）', revealedIds(page), []);

// --- 图上左右滑动翻页 ---
// 滑动 = touchstart 记起点、touchend 问方向。判别逻辑在 utils/swipe.js，这里测链路。

page.onStageTouchStart({ touches: [{ clientX: 300, clientY: 400 }] });
page.onStageTouchEnd({ changedTouches: [{ clientX: 180, clientY: 400 }] });
suite.eq('最后一屏向左滑，没有下一张，原地不动', page.data.shotIndex, 2);

page.onStageTouchStart({ touches: [{ clientX: 200, clientY: 400 }] });
page.onStageTouchEnd({ changedTouches: [{ clientX: 320, clientY: 400 }] });
suite.eq('图上向右滑一记，退回上一张', page.data.shotIndex, 1);
suite.eq('滑动翻页同样保留进度（和按钮回退走同一条 goShot）', revealedIds(page), ['C2']);

const beforeSmallMove = page.data.shotIndex;
page.onStageTouchStart({ touches: [{ clientX: 200, clientY: 400 }] });
page.onStageTouchEnd({ changedTouches: [{ clientX: 230, clientY: 400 }] });
suite.eq('短距离的挪动不算滑，不翻页', page.data.shotIndex, beforeSmallMove);

page.onStageTouchStart({ touches: [{ clientX: 200, clientY: 400 }] });
page.onStageTouchCancel();
page.onStageTouchEnd({ changedTouches: [{ clientX: 80, clientY: 400 }] });
suite.eq('被打断的触摸（touchcancel 之后）不再判方向', page.data.shotIndex, beforeSmallMove);

page.onHoldStart();
page.onStageTouchStart({ touches: [{ clientX: 300, clientY: 400 }] });
page.onStageTouchEnd({ changedTouches: [{ clientX: 180, clientY: 400 }] });
suite.eq('按住看商品时滑动不翻页', page.data.shotIndex, 1);
suite.eq('按住态也没有被滑动破坏', page.data.holding, true);
page.onHoldEnd();

// --- 卡片入口 ---
// 门只有一道：至少标出一处。开得太早会做出空卡片，开得太晚用户以为没这功能。

navigations.length = 0;
toasts.length = 0;

const fresh = makePage();
fresh.onLoad();

suite.eq('刚进第一屏（一处都没标出）不能做卡片', fresh.data.canMakeCard, false);

fresh.onMakeCard();
suite.eq('还没标出就点卡片入口：不跳转', navigations.length, 0);
suite.eq('还没标出就点卡片入口：给一句提示', toasts[0], '先标出一处，再来做卡片');

fresh.onCardTap(tap(null, 'A1'));
suite.eq('标出一处后可以做卡片了', fresh.data.canMakeCard, true);

fresh.onMakeCard();
suite.eq('点卡片入口会跳到卡片页', navigations.length, 1);
suite.ok('跳转带上这张示例的序号', navigations[0].indexOf('shot=0') !== -1);
suite.ok('跳转只带上已经标出来的那一处', navigations[0].indexOf('ids=A1') !== -1);
suite.ok('跳转没带上没标出来的那一处', navigations[0].indexOf('B1') === -1);

// 两处都标出来时两个都要带上，而且是按示例顺序
navigations.length = 0;
fresh.onCardTap(tap(null, 'B1'));
fresh.onMakeCard();
suite.eq('两处都标出时按示例顺序带上两个 id', navigations[0], '/pages/card/index?shot=0&ids=A1,B1');

// 换到第二屏（不给预制了）：标出一处后卡片入口才开
navigations.length = 0;
fresh.onNextShot();
suite.eq('第二屏刚进场（一处都没标）不能做卡片', fresh.data.canMakeCard, false);
fresh.onHitTap(tap(null, 'C2', 1));
suite.eq('第二屏点图上的热区标出一处后，可以做卡片', fresh.data.canMakeCard, true);
fresh.onMakeCard();
suite.ok('第二屏的跳转带的是第二屏的序号', navigations[0].indexOf('shot=1') !== -1);
suite.ok('第二屏的跳转带的是第二屏已标出的那一处', navigations[0].indexOf('ids=C2') !== -1);

// 跳过去的 id 必须能真的做出一张卡片 —— 否则就是"能点但打不开"
const plan = card.buildCard({ shot: SHOTS[1], revealed: ['C2'] });
suite.ok('第二屏带过去的参数能真的排出一张卡片', !!plan);
suite.eq('这张卡片上确实只有一处', plan.count, 1);

// 找的模式下，还没找到的卡片是**点不动的**（这是设计，不是 bug）——
// 所以下面要全标出来，只能走「直接显示」那条路。
const findPage = makePage();
findPage.onLoad();
findPage.goShot(2);
toasts.length = 0;
findPage.onCardTap(tap(null, 'D1', 1));
suite.eq('第三屏（一处都不给）点卡片点不开', findPage.data.hooks.filter(function (h) { return h.revealed; }).length, 0);
suite.eq('第三屏点卡片只给一句「先在图里找找看」', toasts[0], '先在图里找找看');

// 三段示例、每一屏在"全标出来"的状态下，参数都必须能排出卡片
let unbuildable = [];
SHOTS.forEach(function (shot, i) {
  const page2 = makePage();
  page2.onLoad();
  page2.goShot(i);
  // 「直接显示」一次揭示一处，多调几次直到没有可揭示的
  for (let k = 0; k <= shot.hooks.length; k++) page2.onRevealNext();
  const revealedCount = page2.data.hooks.filter(function (h) { return h.revealed; }).length;
  if (revealedCount !== shot.hooks.length) {
    unbuildable.push(shot.id + ' 用「直接显示」没能全标出来（' + revealedCount + '/' + shot.hooks.length + '）');
    return;
  }
  if (!page2.data.canMakeCard) {
    unbuildable.push(shot.id + ' 全标出来了却做不了卡片');
    return;
  }
  navigations.length = 0;
  page2.onMakeCard();
  if (navigations.length !== 1) {
    unbuildable.push(shot.id + ' 点卡片入口没跳转');
    return;
  }
  // 从 url 里把参数解出来，直接喂给排版 —— 这条链路两端打通的唯一证明
  const m = navigations[0].match(/shot=(\d+)&ids=(.*)$/);
  if (!m) {
    unbuildable.push(shot.id + ' 跳转 url 解析不出来：' + navigations[0]);
    return;
  }
  const ids = m[2].split(',');
  const p = card.buildCard({ shot: SHOTS[Number(m[1])], revealed: ids });
  if (!p) unbuildable.push(shot.id + ' 参数能跳转但排不出卡片');
  else if (p.count !== shot.hooks.length) unbuildable.push(shot.id + ' 卡片上的处数对不上');
});
suite.eq('三段示例全标出来后，点卡片 → 跳转 → 排版这条链路全通', unbuildable, []);

suite.done();
