/**
 * 第四屏的「拿到结果以后该说什么」—— 这一屏最容易悄悄坏掉的地方。
 *
 * 坏掉的方式很隐蔽：三种不同的「没有」被说成同一句话，界面看着好好的，
 * 但用户被告知了一件假事（「模型觉得你没问题」，其实是「我们没读成」）。
 * 所以这里除了逐条走分支，还有一条专门的断言守着「三句话互不相同」。
 */

const { createSuite } = require('./harness');
const analyze = require('../utils/analyze');

const suite = createSuite('check-analyze.js');

function ann(over) {
  const base = {
    id: 'A1',
    rect: { x: 0.1, y: 0.2, w: 0.5, h: 0.1 },
    evidence: '仅剩 2 件',
    confidence: 0.9
  };
  const out = {};
  Object.keys(base).forEach(function (k) { out[k] = base[k]; });
  Object.keys(over || {}).forEach(function (k) { out[k] = over[k]; });
  return out;
}

const RESP = function (over) {
  const base = { source: 'model', annotations: [], attempts: 1, failed: false, reason: null };
  const out = {};
  Object.keys(base).forEach(function (k) { out[k] = base[k]; });
  Object.keys(over || {}).forEach(function (k) { out[k] = over[k]; });
  return out;
};

// ---------- 正常有结果 ----------

const ok = analyze.outcome(RESP({ annotations: [ann(), ann({ id: 'B1' })] }));
suite.eq('有结果时进 DONE', ok.state, 'done');
suite.ok('并且不算失败', ok.failed === false);
suite.eq('标注映射过来了', ok.hooks.length, 2);
suite.eq('引导条说清下一步', ok.guide, '它读出了 2 处 · 点图上的框，看每一处是什么');
suite.eq('有结果时不需要那句「没有」', ok.notice, null);
suite.eq('来源原样带出来（排查要用）', ok.source, 'model');

suite.eq(
  '映射只搬界面要的三个字段（白名单/坐标已经在解析层判过，不重复判）',
  Object.keys(ok.hooks[0]).sort(),
  ['evidence', 'id', 'rect']
);
suite.ok('原话也带过来了（「图上原话」比只给名字有说服力）', ok.hooks[0].evidence === '仅剩 2 件');
suite.eq('顺序不打乱', ok.hooks.map(function (h) { return h.id; }), ['A1', 'B1']);

// ---------- 三种「没有」，必须三句不同的话 ----------

const clean = analyze.outcome(RESP({ annotations: [] }));
const unsure = analyze.outcome(RESP({ annotations: [ann({ confidence: 0.1 })] }));
const failed = analyze.outcome(RESP({ source: 'fallback', reason: 'no-legal-annotation' }));

suite.eq('① 模型一条都没报 → 没看出问题', clean.notice.kind, 'clean');
suite.eq('② 报了但全被置信度筛掉 → 不太确定', unsure.notice.kind, 'unsure');
suite.eq('③ 云函数兜底 → 没读出来', failed.notice.kind, 'failed');

const titles = [clean.notice.title, unsure.notice.title, failed.notice.title];
suite.eq('三句话互不相同（说成一句就是告诉用户一件假事）', titles.length, 3);
suite.ok('确实是三句不同的话：' + titles.join(' / '), titles[0] !== titles[1] && titles[1] !== titles[2] && titles[0] !== titles[2]);
suite.ok(
  '「没读出来」和「没看出问题」不能长得像（一个是我们失败了，一个是图很干净）',
  failed.notice.title !== clean.notice.title
);

suite.eq('两种「没有」都还算有结果（有图可看），不是失败态', clean.state, 'done');
suite.eq('不确定时也算有结果', unsure.state, 'done');
suite.eq('只有真没读出来才是失败态', failed.state, 'failed');

suite.ok('「没看出问题」时引导条就是那句话（眼睛本来就在那儿）', clean.guide === clean.notice.title);
suite.ok('「不确定」时引导条也是那句话', unsure.guide === unsure.notice.title);
suite.ok('失败态不重复说话（状态块已经说了）', failed.guide === '');

// ---------- 失败态的出口 ----------

suite.eq('失败态给两个出口', failed.notice.actions.length, 2);
suite.eq(
  '两个出口是「再试一次」和「换一张」（缺一个就会卡死在这一屏）',
  failed.notice.actions.map(function (a) { return a.key; }),
  ['retry', 'pick']
);
suite.ok('失败态那句标题出自唯一来源 detect-parse', failed.notice.title === '这张图没读出来');
suite.ok('失败态有一行能让人安心的小字', typeof failed.notice.hint === 'string' && failed.notice.hint.length > 0);
suite.ok('失败态的话里不许出现技术词', failed.notice.title.indexOf('errCode') === -1 && failed.notice.hint.indexOf('errCode') === -1);
suite.ok('失败原因留在字段里（排查用，界面不显示）', failed.notice.reason === 'no-legal-annotation');

// ---------- 坏入参一律当失败，不许崩 ----------

suite.eq('null 进不去结果态', analyze.outcome(null).state, 'failed');
suite.eq('字符串进不去结果态', analyze.outcome('ok').state, 'failed');
suite.eq('annotations 不是数组也算失败（不是「没问题」）', analyze.outcome(RESP({ annotations: 'x' })).state, 'failed');
suite.eq('annotations 是对象也算失败', analyze.outcome(RESP({ annotations: {} })).state, 'failed');
suite.eq(
  '云函数说失败但给了标注：仍按失败处理（source 说了算）',
  analyze.outcome(RESP({ source: 'fallback', annotations: [ann()] })).state,
  'failed'
);
suite.noThrow('脏数据不崩', function () {
  analyze.outcome(undefined);
  analyze.outcome(RESP({ annotations: [null, 3, 'x'] }));
});

// ---------- 映射成 Shot：这是「不复制模板」的关键 ----------

const shot = analyze.ownShot({ image: '/tmp/a.jpg', hooks: ok.hooks });
suite.ok('有图就能拼出一个 shot', !!shot);
suite.eq('id 固定，界面据此认人', shot.id, analyze.OWN_SHOT_ID);
suite.ok('打上 own 标记', shot.own === true);
suite.eq(
  '复用教学屏的角色（名字写在卡片上，点一下看它在哪）',
  shot.mode,
  'reveal'
);
suite.ok('mode 必须是 reveal.js 认得的那个值', shot.mode === 'reveal');
suite.eq('hooks 原样带进 shot', shot.hooks.length, 2);
suite.eq('没给名字时用默认的', shot.appName, analyze.DEFAULT_APP_NAME);
suite.eq('给了名字就用给的', analyze.ownShot({ image: 'a', appName: '京东订单页' }).appName, '京东订单页');

suite.eq('没有图就返回 null（页面先判空，别进一个空屏）', analyze.ownShot({ hooks: ok.hooks }), null);
suite.eq('什么都不给也是 null', analyze.ownShot(), null);
suite.eq('hooks 不是数组时给空数组，不崩', analyze.ownShot({ image: 'a', hooks: 'x' }).hooks.length, 0);

suite.ok('isOwnShot 认得自己的图', analyze.isOwnShot(shot) === true);
suite.ok('isOwnShot 不认示例', analyze.isOwnShot({ id: 'shot-01' }) === false);
suite.ok('isOwnShot 对空值安全', analyze.isOwnShot(null) === false && analyze.isOwnShot(undefined) === false);

// ---------- 读图中的进度：必须是两步，不能是一个圈 ----------

suite.eq('上传有它自己的话', analyze.busyText(analyze.BUSY_STEPS.UPLOAD), '正在上传这张图');
suite.eq('读图有它自己的话', analyze.busyText(analyze.BUSY_STEPS.DETECT), '正在读这张图');
suite.ok(
  '两步的话不一样（一样就等于没有进度）',
  analyze.busyText(analyze.BUSY_STEPS.UPLOAD) !== analyze.busyText(analyze.BUSY_STEPS.DETECT)
);
suite.eq('不认识的步骤给空串，不编一句出来', analyze.busyText('?'), '');

suite.done();
