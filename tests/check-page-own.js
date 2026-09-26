/**
 * 第四屏的页面状态机 —— 「进第四屏 → 选图 → 出标注」与「失败 → 失败态」在 Node 里走通。
 *
 * 为什么单独一个文件：check-page.js 管的是示例三屏的按住/卡片状态机，
 * 第四屏多了一整条异步链路（选图 → 上传 → 云函数），桩的东西和要防的错都不一样。
 * 最大的那个错叫「读图期间用户滑走了」—— 结果回来时页面已经不在第四屏，
 * 不设防的话示例屏会被自己的 shot 覆盖掉。这个错只能靠桩测抓，手点很难碰到。
 *
 * 办法和 check-page.js 相同：Page / wx 桩掉，直接调页面方法。
 * 云链路的桩是**队列 + 挂起**：队列里有的自动放行，没有的挂起等测试手动喂 ——
 * 这样两步进度（上传 / 读图）才有机会被观察到，否则同步桩一步跑完什么也看不见。
 */

const { createSuite } = require('./harness');

const suite = createSuite('check-page-own.js');

// --- 桩：Page / wx ---

let pageConfig = null;
const toasts = [];

global.Page = function (cfg) {
  pageConfig = cfg;
};
global.getCurrentPages = function () {
  return [{}, {}];
};

// 云链路的手动放行口：桩收到调用但队列里没货时，把回调存在这里
let pendingChoose = null;
let pendingUpload = null;
let pendingDetect = null;

// 云链路的调用记录：链路走到哪一步、参数对不对，靠它们断言
const calls = {
  choose: 0,
  upload: 0,
  detect: 0,
  getImageInfo: 0,
  lastUpload: null, // { cloudPath, filePath }
  lastDetect: null  // { name, data }
};

// 示例图复制（代码包 → 用户目录）的桩：队列 + 挂起，和云链路同一套办法
let pendingCopy = null;
const copyQueue = [];

/** 桩给的图幅。600×900 是压缩后的典型尺寸，改它就能模拟别的机型 */
let imageInfoSize = { w: 600, h: 900 };

const chooseQueue = [];
const uploadQueue = [];
const detectQueue = [];

global.wx = {
  showToast: function (o) {
    toasts.push(o && o.title);
  },
  navigateTo: function () {},
  navigateBack: function () {},
  env: { USER_DATA_PATH: '/tmp/wxfake/usr' },
  getFileSystemManager: function () {
    return {
      copyFile: function (opts) {
        if (copyQueue.length === 0) {
          pendingCopy = opts;
          return;
        }
        const r = copyQueue.shift();
        if (r.ok) {
          if (opts.success) opts.success();
        } else if (opts.fail) {
          opts.fail(r.res || {});
        }
      }
    };
  },
  chooseMedia: function (opts) {
    calls.choose += 1;
    if (chooseQueue.length === 0) {
      pendingChoose = opts && opts.success;
      return;
    }
    const r = chooseQueue.shift();
    if (r.ok) {
      if (opts && opts.success) opts.success(r.res);
    } else if (opts && opts.fail) {
      opts.fail(r.res || { errMsg: 'chooseMedia:fail cancel' });
    }
  },
  // 压缩桩：透传原图（真实机型上失败也会走 fail 分支回退原图，见页面代码）
  compressImage: function (opts) {
    if (opts && opts.success) opts.success({ tempFilePath: opts.src });
    else if (opts && opts.fail) opts.fail({});
  },
  // 图片信息桩：给一个固定图幅。模型直接给像素坐标时，换算成 0–1 比例全靠它
  getImageInfo: function (opts) {
    calls.getImageInfo += 1;
    if (opts && opts.success) opts.success({ width: imageInfoSize.w, height: imageInfoSize.h });
  },
  cloud: {
    uploadFile: function (opts) {
      calls.upload += 1;
      calls.lastUpload = { cloudPath: opts.cloudPath, filePath: opts.filePath };
      if (uploadQueue.length === 0) {
        pendingUpload = opts;
        return;
      }
      const r = uploadQueue.shift();
      if (r.ok) {
        if (opts.success) opts.success(r.res);
      } else if (opts.fail) {
        opts.fail(r.res || {});
      }
    },
    callFunction: function (opts) {
      calls.detect += 1;
      calls.lastDetect = { name: opts.name, data: opts.data };
      if (detectQueue.length === 0) {
        pendingDetect = opts;
        return;
      }
      const r = detectQueue.shift();
      if (r.ok) {
        if (opts.success) opts.success(r.res);
      } else if (opts.fail) {
        opts.fail(r.res || {});
      }
    }
  }
};

require('../pages/journey/index.js');

const analyze = require('../utils/analyze');
const detectParse = require('../utils/detect-parse');
const hold = require('../utils/hold');
const { getHookPattern } = require('../utils/hooks');
const { SHOTS } = require('../data/shots');

if (!pageConfig) {
  throw new Error('页面没把配置交给 Page()，后面的检查都无从谈起');
}

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

function tap(target, key) {
  return { currentTarget: { dataset: { key: key } } };
}

function tapId(target, id) {
  return { currentTarget: { dataset: { id: id } } };
}

/** 模拟选完一张图：路径是随手编的，本页只用它当展示地址 */
const IMG_A = '/tmp/wxfake/own-a.jpg';
const IMG_B = '/tmp/wxfake/own-b.jpg';

/** 云函数的一份正常回答：两处都有把握、都带图上原话 */
const RESULT_OK = {
  source: 'model',
  annotations: [
    { id: 'A1', rect: { x: 0.02, y: 0.5, w: 0.96, h: 0.08 }, confidence: 0.9, evidence: '仅限今日' },
    { id: 'B1', rect: { x: 0.24, y: 0.76, w: 0.13, h: 0.03 }, confidence: 0.8, evidence: '原价999' }
  ]
};

const FAILED_TITLE = detectParse.sourceNotice(detectParse.SOURCE.FALLBACK);
const CLEAN_TITLE = '这张图里没看出问题';
const UNSURE_TITLE = '有几处它不太确定，先不标了';
const DONE_GUIDE = analyze.guideForOwn(2);

/** 一条走到「上传挂起」的捷径：进第四屏 → 选图成功，链路停在等上传结果 */
function startBusyAtUpload(page) {
  page.onEnterOwn();
  chooseQueue.push({ ok: true, res: { tempFiles: [{ tempFilePath: IMG_A }] } });
  page.onPickImage();
}

/** 一条走到「读图挂起」的捷径：上传成功放行，链路停在等云函数返回 */
function startBusyAtDetect(page) {
  startBusyAtUpload(page);
  pendingUpload.success({ fileID: 'cloud://fake-1' });
}

function pickThenDetect(page, result) {
  startBusyAtDetect(page);
  pendingDetect.success({ result: result });
}

// --- 主页「上传截图」直达：带 screen=own 打开就直接落在第四屏 ---

const direct = makePage();
direct.onLoad({ screen: 'own' });
suite.eq('带 screen=own 打开，直接就是第四屏', direct.data.isOwn, true);
suite.eq('带 screen=own 打开，序号接在示例后面', direct.data.shotIndex, SHOTS.length);
suite.eq('直达第四屏也从选图态起步', direct.data.ownState, analyze.OWN_STATES.PICK);
suite.ok('直达第四屏不带示例的图进来', !direct.data.shot);

// 不带参数打开仍然从第一屏开始 —— 老路径不能被新参数带偏
const normal = makePage();
normal.onLoad();
suite.eq('不带参数打开，还是从第一屏开始', normal.data.shotIndex, 0);
suite.eq('不带参数打开，不是第四屏', normal.data.isOwn, false);

// --- 第四屏选示例图：先选中（点卡只改选中态），点「开始分析」才进读图链路 ---

const sample = makePage();
sample.onEnterOwn();
suite.eq('进第四屏时一张都没选', sample.data.ownSampleIndex, -1);
sample.onPickSample({ currentTarget: { dataset: { index: 0 } } });
suite.eq('点示例卡只是选中，不进上传链路', calls.upload, 0);
suite.eq('选中的是点的那张', sample.data.ownSampleIndex, 0);
suite.eq('选中后还停在选图态', sample.data.ownState, analyze.OWN_STATES.PICK);

// 没选就点开始分析：只弹提示，不开链路
const goEmpty = makePage();
goEmpty.onEnterOwn();
const toastBefore = toasts.length;
goEmpty.onStartAnalyze();
suite.ok('没选就点开始分析，只弹一句提示', toasts.length === toastBefore + 1);
suite.eq('没选就点开始分析，不进上传链路', calls.upload, 0);

// 选中之后再点开始分析：复制成功，走和自选图完全相同的读图链路
copyQueue.push({ ok: true });
sample.onStartAnalyze();
suite.eq('点开始分析才进上传链路（复制成功后上传一次）', calls.upload, 1);
suite.ok(
  '上传的是复制到用户目录的副本，不是代码包原路径',
  calls.lastUpload.filePath.indexOf('/tmp/wxfake/usr/sample-0') === 0
);
suite.eq('选中的示例图进入读图中的 busy 态', sample.data.ownState, analyze.OWN_STATES.BUSY);

// 复制失败（机型差异）不能断链：退回代码包原路径继续
const sample2 = makePage();
sample2.onEnterOwn();
sample2.onPickSample({ currentTarget: { dataset: { index: 1 } } });
copyQueue.push({ ok: false });
sample2.onStartAnalyze();
suite.ok('复制失败就退回原路径继续上传', calls.lastUpload.filePath === '/assets/samples/02.jpg');

// --- 入口：只在第三屏收尾出现 ---

const entry = makePage();
entry.onLoad();
suite.eq('第一屏没有「用你自己的图」入口', entry.data.showOwnEntry, false);

entry.goShot(1);
suite.eq('第二屏也没有入口', entry.data.showOwnEntry, false);

entry.goShot(2);
suite.eq('第三屏还没标完，入口不出现', entry.data.showOwnEntry, false);

// 第三屏是「放手」屏，用「直接显示」走完
for (let i = 0; i <= SHOTS[2].hooks.length; i++) entry.onRevealNext();
suite.eq('三处都标完，入口出现', entry.data.showOwnEntry, true);

entry.onEnterOwn();
suite.eq('点入口进入第四屏（序号接在三段示例之后）', entry.data.shotIndex, SHOTS.length);
suite.eq('第四屏知道自己是第四屏', entry.data.isOwn, true);
suite.eq('刚进来是选图态', entry.data.ownState, analyze.OWN_STATES.PICK);
suite.eq('选图态没有 shot（选图块顶上来）', entry.data.shot, null);
suite.eq('选图态图上没有任何标注残留', entry.data.hooks, []);
suite.eq('选图态引导条是空的（选图块自己会说话）', entry.data.guide, '');
suite.eq('选图态不能做卡片', entry.data.canMakeCard, false);
suite.eq('进第四屏后入口自己收起来', entry.data.showOwnEntry, false);
suite.eq('第四屏后面没有下一张（箭头置灰）', entry.data.isLastShot, true);

// 第四屏上按住：一处都没有，按钮是锁着的
toasts.length = 0;
entry.onHoldStart();
suite.eq('选图态按住只给提示，不进按住态', entry.data.holding, false);
suite.eq('提示就是那句「先标出一处」', toasts[0], hold.HOLD_LOCKED_TEXT);

// 第四屏向左滑：后面没有下一张
entry.onStageTouchStart({ touches: [{ clientX: 300, clientY: 400 }] });
entry.onStageTouchEnd({ changedTouches: [{ clientX: 100, clientY: 400 }] });
suite.eq('第四屏向左滑原地不动', entry.data.shotIndex, SHOTS.length);

// 回退到第三屏：进度不丢；再进来还是选图态
entry.onPrevShot();
suite.eq('第四屏退回第三屏', entry.data.shotIndex, 2);
suite.eq('回退后不再是第四屏', entry.data.isOwn, false);
suite.eq('第三屏标出的进度原样还在',
  entry.data.hooks.filter(function (h) { return h.revealed; }).length, SHOTS[2].hooks.length);
suite.eq('回退后入口还在（进度没丢，收尾还在）', entry.data.showOwnEntry, true);

entry.onEnterOwn();
suite.eq('再进第四屏仍是选图态（还没选过图）', entry.data.ownState, analyze.OWN_STATES.PICK);

// --- 选图 → 上传 → 读图：两步进度是真的 ---

const busy = makePage();
busy.onLoad();
busy.goShot(2);
for (let i = 0; i <= SHOTS[2].hooks.length; i++) busy.onRevealNext();
busy.onEnterOwn();

// 用户取消选图：停在选图态就是正确反应
chooseQueue.push({ ok: false });
const uploadBeforeCancel = calls.upload;
busy.onPickImage();
suite.eq('取消选图后仍停在选图态', busy.data.ownState, analyze.OWN_STATES.PICK);
suite.eq('取消选图不会触发上传', calls.upload, uploadBeforeCancel);

// 选图成功：链路停在「正在上传」
startBusyAtUpload(busy);
suite.eq('选完图进入忙碌态', busy.data.ownState, analyze.OWN_STATES.BUSY);
suite.eq('图先上舞台（读图也是读「这张图」）', busy.data.shot.image, IMG_A);
suite.eq('忙碌态的 shot 也是自己的图', busy.data.shot.own, true);
suite.eq('第一步的进度文案是「正在上传」', busy.data.guide, analyze.busyText(analyze.BUSY_STEPS.UPLOAD));
suite.eq('上传收到了选的那张图', calls.lastUpload && calls.lastUpload.filePath, IMG_A);
suite.ok('云存储路径收在 detect/ 目录下', (calls.lastUpload.cloudPath || '').indexOf('detect/') === 0);
suite.eq('上传没完成不会去读图', calls.detect, 0);

// 上传成功：链路停在「正在读」
pendingUpload.success({ fileID: 'cloud://fake-1' });
suite.eq('第二步的进度文案是「正在读」', busy.data.guide, analyze.busyText(analyze.BUSY_STEPS.DETECT));
suite.eq('读图调的是 detect 云函数', calls.lastDetect && calls.lastDetect.name, 'detect');
suite.eq('读图把 fileID 交给了云函数', calls.lastDetect && calls.lastDetect.data.fileID, 'cloud://fake-1');

// 云函数返回：出标注
pendingDetect.success({ result: RESULT_OK });
suite.eq('出结果后进入完成态', busy.data.ownState, analyze.OWN_STATES.DONE);
suite.eq('完成态的 shot 还是自己的图', busy.data.shot.image, IMG_A);
suite.eq('shot 形状和示例同构（own 标记）', busy.data.shot.own, true);
suite.eq('两处标注都进了 shot', busy.data.shot.hooks.length, 2);
suite.eq('标注层的框也画出来了', busy.data.hooks.length, 2);
suite.eq('第一处卡片上的名字来自词典', busy.data.hooks[0].name, getHookPattern('A1').name);
suite.eq('第一处卡片上给的是图上原话（不是词典机制句）', busy.data.hooks[0].note, '仅限今日');
suite.eq('完成态引导条说清读出了几处', busy.data.guide, DONE_GUIDE);
suite.eq('结果没揭示前按钮仍是锁着的', busy.data.holdReady, false);
suite.eq('第四屏没有「直接显示」退路（结果就是结果）', busy.data.skipLabel, '');

// 点卡片揭示 → 按住照常可用（第四屏必须也能「只看商品」）
busy.onCardTap(tapId(null, 'A1'));
suite.eq('点卡片揭开了第一处', busy.data.holdReady, true);
busy.onHoldStart();
suite.eq('按住时揭开的框被盖住', busy.data.hooks.filter(function (h) { return h.covered; }).map(function (h) { return h.id; }), ['A1']);
busy.onHoldEnd();
suite.eq('松手后照常复原', busy.data.hooks.filter(function (h) { return h.covered; }).length, 0);

// 卡片入口在第四屏是关死的（7.4c 才接）
suite.eq('第四屏揭示后也不能做卡片', busy.data.canMakeCard, false);

// 离开再回来：done 态和揭示进度都还在
busy.onPrevShot();
suite.eq('从第四屏退回第三屏', busy.data.shotIndex, 2);
busy.onEnterOwn();
suite.eq('回来还是完成态', busy.data.ownState, analyze.OWN_STATES.DONE);
suite.eq('回来标注还是两处', busy.data.shot.hooks.length, 2);
suite.eq('回来的揭示进度没丢', busy.data.hooks.filter(function (h) { return h.revealed; }).map(function (h) { return h.id; }), ['A1']);

// --- 三种「没有」是三句不同的话 ---

// ① 模型说没看出问题
const clean = makePage();
clean.onLoad();
clean.goShot(2);
for (let i = 0; i <= SHOTS[2].hooks.length; i++) clean.onRevealNext();
pickThenDetect(clean, { source: 'model', annotations: [] });
suite.eq('模型报空 → 还是完成态', clean.data.ownState, analyze.OWN_STATES.DONE);
suite.eq('模型报空 → 引导条说「没看出问题」', clean.data.guide, CLEAN_TITLE);
suite.eq('模型报空 → 图上没有框', clean.data.hooks, []);

// ② 报了但都不太确定（全被置信度筛掉）
const unsure = makePage();
unsure.onLoad();
unsure.goShot(2);
for (let i = 0; i <= SHOTS[2].hooks.length; i++) unsure.onRevealNext();
pickThenDetect(unsure, {
  source: 'model',
  annotations: [{ id: 'A1', rect: { x: 0.1, y: 0.1, w: 0.5, h: 0.1 }, confidence: 0.2 }]
});
suite.eq('全被筛掉 → 也是完成态（不是失败）', unsure.data.ownState, analyze.OWN_STATES.DONE);
suite.eq('全被筛掉 → 说的是「不太确定，先不标了」', unsure.data.guide, UNSURE_TITLE);

// ②b 模型给的是**像素坐标**（600×900 的图上，一处 540×90 的框）
//
// 这才是真机上最常发生的一种「看起来像没把握」：模型直接给 `{"x":36,...}` 这种像素值，
// 换算需要图幅 —— 没有它，36 会被夹成 1、宽高被压成 0，整条判非法。
// 界面于是说「不太确定，先不标了」，而实际上模型报得很清楚。

const pixels = makePage();
pixels.onLoad();
pixels.goShot(2);
for (let i = 0; i <= SHOTS[2].hooks.length; i++) pixels.onRevealNext();
pickThenDetect(pixels, {
  source: 'model',
  annotations: [{ id: 'A1', rect: { x: 54, y: 450, w: 540, h: 90 }, confidence: 0.9 }]
});
suite.eq('像素坐标 → 照样出标注（不是「不太确定」）', pixels.data.ownState, analyze.OWN_STATES.DONE);
suite.eq('像素坐标 → 图上有一处', pixels.data.shot.hooks.length, 1);
// 写成 (…[0] || {}) 而不是直接取 [0]：换算一旦坏了，这条是**一条变红的断言**，
// 而不是 `Cannot read properties of undefined` —— 后者会把整个套件带崩，看不出红在哪
suite.eq('像素坐标 → 按比例换算过来了', (pixels.data.shot.hooks[0] || {}).rect, { x: 0.09, y: 0.5, w: 0.9, h: 0.1 });
suite.ok('页面确实去问了图幅（换算像素坐标全靠它）', calls.getImageInfo > 0);

// ③ 云函数自己兜底 → 失败态，不看它给了什么
const fallback = makePage();
fallback.onLoad();
fallback.goShot(2);
for (let i = 0; i <= SHOTS[2].hooks.length; i++) fallback.onRevealNext();
pickThenDetect(fallback, { source: 'fallback', reason: 'all-attempts-failed', annotations: [] });
suite.eq('兜底返回 → 失败态', fallback.data.ownState, analyze.OWN_STATES.FAILED);
suite.eq('失败态标题来自唯一来源', fallback.data.ownNotice && fallback.data.ownNotice.title, FAILED_TITLE);
suite.ok('失败态有一行「不是你这张图的问题」',
  (fallback.data.ownNotice && fallback.data.ownNotice.hint || '').indexOf('不是你这张图的问题') !== -1);
suite.eq('失败态有两条出口',
  (fallback.data.ownNotice && fallback.data.ownNotice.actions || []).map(function (a) { return a.key; }),
  ['retry', 'pick']);
suite.eq('失败态引导条是空的（失败块在说话）', fallback.data.guide, '');

// 三句话互不相同 —— 这条在 analyze 层测过，这里守住「页面显示的也是这三句」
suite.ok('三种「没有」在页面上仍是三句不同的话',
  CLEAN_TITLE !== UNSURE_TITLE && CLEAN_TITLE !== FAILED_TITLE && UNSURE_TITLE !== FAILED_TITLE);

// --- 失败态的出口与其它失败原因 ---

// 重试：整条链路重跑，两步进度照真走
const uploadBeforeRetry = calls.upload;
fallback.onOwnAction(tap(null, 'retry'));
suite.eq('点「再试一次」回到上传步骤', fallback.data.guide, analyze.busyText(analyze.BUSY_STEPS.UPLOAD));
suite.eq('重试真的重新上传了', calls.upload, uploadBeforeRetry + 1);
pendingUpload.success({ fileID: 'cloud://fake-2' });
pendingDetect.success({ result: RESULT_OK });
suite.eq('重试成功后照样出标注', fallback.data.ownState, analyze.OWN_STATES.DONE);
suite.eq('重试后的引导条恢复完成态', fallback.data.guide, DONE_GUIDE);

// 换一张：清干净，回到选图态
fallback.onOwnAction(tap(null, 'pick'));
suite.eq('点「换一张」回到选图态', fallback.data.ownState, analyze.OWN_STATES.PICK);
suite.eq('换一张后图也清掉了', fallback.data.shot, null);
suite.eq('换一张后引导条空了', fallback.data.guide, '');

// 上传失败：也是那句真话，而且不能继续去读图
const upfail = makePage();
upfail.onLoad();
upfail.goShot(2);
for (let i = 0; i <= SHOTS[2].hooks.length; i++) upfail.onRevealNext();
const detectBefore = calls.detect;
startBusyAtUpload(upfail);
pendingUpload.fail({});
suite.eq('上传失败 → 失败态', upfail.data.ownState, analyze.OWN_STATES.FAILED);
suite.eq('上传失败的标题是同一句', upfail.data.ownNotice.title, FAILED_TITLE);
suite.eq('上传失败不会去调云函数', calls.detect, detectBefore);

// 云函数调用失败（网络等）：同一句真话
const detfail = makePage();
detfail.onLoad();
detfail.goShot(2);
for (let i = 0; i <= SHOTS[2].hooks.length; i++) detfail.onRevealNext();
startBusyAtDetect(detfail);
pendingDetect.fail({});
suite.eq('云函数失败 → 失败态', detfail.data.ownState, analyze.OWN_STATES.FAILED);
suite.eq('云函数失败的标题是同一句', detfail.data.ownNotice.title, FAILED_TITLE);

// 连云开发都没有（基础库过旧 / init 失败）：也是失败态，不崩
const nocloud = makePage();
nocloud.onLoad();
nocloud.goShot(2);
for (let i = 0; i <= SHOTS[2].hooks.length; i++) nocloud.onRevealNext();
const savedCloud = wx.cloud;
wx.cloud = undefined;
startBusyAtUpload(nocloud);
suite.eq('没有云开发 → 失败态，不崩', nocloud.data.ownState, analyze.OWN_STATES.FAILED);
suite.eq('没有云开发的标题是同一句', nocloud.data.ownNotice.title, FAILED_TITLE);
wx.cloud = savedCloud;

// --- 读图中用户滑走了（本文件最重要的一个错） ---

const race = makePage();
race.onLoad();
race.goShot(2);
for (let i = 0; i <= SHOTS[2].hooks.length; i++) race.onRevealNext();
startBusyAtUpload(race);
// 上传还没回来，人已经滑回第三屏
race.onPrevShot();
suite.eq('读图中能滑回示例屏', race.data.isOwn, false);
suite.eq('示例屏还是示例屏（没被第四屏的图盖掉）', race.data.shot.id, SHOTS[2].id);
// 结果这时才回来
pendingUpload.success({ fileID: 'cloud://fake-3' });
pendingDetect.success({ result: RESULT_OK });
suite.eq('结果回来时示例屏纹丝不动', race.data.shot.id, SHOTS[2].id);
suite.eq('示例屏的引导条没有被第四屏的话覆盖',
  race.data.guide, '都找齐了。按住上面只看商品，或翻下一张');
// 回到第四屏：结果已经存好，原样上界面
race.onEnterOwn();
suite.eq('回到第四屏，结果已经在了', race.data.ownState, analyze.OWN_STATES.DONE);
suite.eq('回到第四屏，标注齐全', race.data.shot.hooks.length, 2);
suite.eq('回到第四屏，图还是选的那张', race.data.shot.image, IMG_A);

// 读图中滑走、结果还是失败的：同样不影响示例屏
const race2 = makePage();
race2.onLoad();
race2.goShot(2);
for (let i = 0; i <= SHOTS[2].hooks.length; i++) race2.onRevealNext();
startBusyAtDetect(race2);
race2.onPrevShot();
pendingDetect.fail({});
suite.eq('失败结果回来时示例屏也纹丝不动', race2.data.shot.id, SHOTS[2].id);
race2.onEnterOwn();
suite.eq('回到第四屏看到的是失败态', race2.data.ownState, analyze.OWN_STATES.FAILED);

// --- 换一张是真的换 ---

pickThenDetect(race, { source: 'model', annotations: [] });
race.onOwnAction(tap(null, 'pick'));
chooseQueue.push({ ok: true, res: { tempFiles: [{ tempFilePath: IMG_B }] } });
race.onPickImage();
suite.eq('换一张后舞台上是新的图', race.data.shot.image, IMG_B);
pendingUpload.success({ fileID: 'cloud://fake-4' });
pendingDetect.success({ result: RESULT_OK });
suite.eq('换一张后照常出标注', race.data.ownState, analyze.OWN_STATES.DONE);
suite.eq('换一张后的标注是新一轮的', race.data.shot.hooks.length, 2);

suite.done();
