/**
 * 第四屏（用户自己的截图）的纯逻辑：状态、文案、以及把标注映射成界面要的形状。
 *
 * 为什么单独成一个文件：这一屏最容易出错的地方**全是看不见的**。
 * 云函数回来以后该说什么话、该进哪个状态、图上有几处 —— 这些判断一旦写在页面事件里，
 * 就只能靠真机手点；抽出来就能在 Node 里逐条喂（空结果、全被置信度筛掉、云函数兜底……）。
 *
 * ── 三种「没有」是这个文件存在的最大理由 ──
 *
 *   ① 模型说没看出问题    ② 这次没读出来    ③ 报了但都不太确定
 *
 * 它们是三件不同的事。说成同一句话，「不假装」这条规矩就丢了 ——
 * 用户会以为模型看了图说没问题，而实际上我们连图都没读成。
 * 「两张图看起来一样、意思相反」是这一屏最危险的失败方式，所以它有专门的断言守着。
 */

const { parseAnnotations, sourceNotice, SOURCE } = require('./detect-parse');

/** 第四屏的四个状态。页面照着它渲染，不在事件里自己判断该显示什么 */
const OWN_STATES = {
  /** 还没选图（或用户取消了选图） */
  PICK: 'pick',
  /** 正在上传 / 正在读 */
  BUSY: 'busy',
  /** 有结果了（可能一处都没有） */
  DONE: 'done',
  /** 没读出来 */
  FAILED: 'failed'
};

/** 读图过程中的两步。分开是为了让进度是**真的**，而不是一个一直转的圈 */
const BUSY_STEPS = {
  UPLOAD: 'upload',
  DETECT: 'detect'
};

const OWN_SHOT_ID = 'own';

const DEFAULT_APP_NAME = '你的截图';

/**
 * 第四屏沿用教学屏的角色（`reveal`）：名字写在卡片上，点一下看它在哪。
 *
 * 为什么不新加一个 mode：这一屏和教学屏要的交互是同一套 ——
 * 卡片上写着陷阱名、点一下图上被框住。复用 mode 就等于复用了揭示、按住、卡片全部逻辑，
 * 一行都不用改。新加一个 mode 只会多出一处要跟着改的地方。
 */
const OWN_MODE = 'reveal';

/** 读图中的进度文案。两步必须说得出区别，否则进度是假的 */
function busyText(step) {
  if (step === BUSY_STEPS.UPLOAD) return '正在上传这张图';
  if (step === BUSY_STEPS.DETECT) return '正在读这张图';
  return '';
}

function isOwnShot(shot) {
  return !!(shot && shot.own === true);
}

/**
 * 把云函数的标注映射成界面用的 hooks。
 *
 * 只搬三个字段，**不重复做校验**：白名单、坐标、置信度已经在 utils/detect-parse.js 里
 * 判过一轮了（那是唯一实现）。这里再判一次就是两份规则，两份必漂。
 */
function toHooks(annotations) {
  if (!Array.isArray(annotations)) return [];
  const out = [];
  for (let i = 0; i < annotations.length; i++) {
    const a = annotations[i];
    if (!a || typeof a !== 'object') continue;
    out.push({ id: a.id, rect: a.rect, evidence: a.evidence });
  }
  return out;
}

/**
 * 拼出第四屏要用的 shot 对象 —— 形状和 data/shots.js 里的示例一模一样。
 *
 * 这就是「不复制模板」的全部秘密：形状一样，标注层、揭示、按住、卡片生成
 * 全都不需要知道这是示例还是用户自己的图。
 *
 * 没有图（image 为空）时返回 null，让页面自己判空 —— 项目纪律：依赖上一步数据的页面先判空。
 */
function ownShot(input) {
  const o = input || {};
  if (!o.image) return null;
  return {
    id: OWN_SHOT_ID,
    own: true,
    mode: OWN_MODE,
    appName: o.appName || DEFAULT_APP_NAME,
    image: o.image,
    hooks: toHooks(o.hooks)
  };
}

/**
 * 结果为空时的那句话。
 *
 * 两种情况分开：模型报了但我们一条都没敢用（不确定），和模型压根没报（没看出问题）。
 * 前者是在说「我们没把握」，后者是在说「这张图很干净」——
 * 对用户来说，这两句话的价值完全不同。
 */
function emptyNotice(rawCount) {
  if (rawCount > 0) {
    return {
      kind: 'unsure',
      title: '有几处它不太确定，先不标了',
      hint: '宁可不标，也不想给你指错地方'
    };
  }
  return {
    kind: 'clean',
    title: '这张图里没看出问题',
    hint: ''
  };
}

/** 没读出来。这句**标题**来自 detect-parse 的唯一来源，出口在这里加 */
function failedNotice(reason) {
  return {
    kind: 'failed',
    title: sourceNotice(SOURCE.FALLBACK),
    hint: '可能是网络或识别的临时问题，不是你这张图的问题',
    reason: reason || null,
    actions: [
      { key: 'retry', label: '再试一次' },
      { key: 'pick', label: '换一张' }
    ]
  };
}

/** 有结果时的引导条：说清下一步，不评价对错 */
function guideForOwn(count) {
  if (!count || count <= 0) return '';
  return '它读出了 ' + count + ' 处 · 点图上的框，看每一处是什么';
}

/**
 * 主入口：云函数的返回 → 第四屏该显示什么。
 *
 * 页面拿到这个结果只做渲染，不做任何判断 —— 所有分支都在这里，都被测到了。
 *
 * @param {object} response 云函数 detect 的返回：{ source, annotations, attempts, failed, reason }
 */
function outcome(response, options) {
  const opts = options || {};
  if (!response || typeof response !== 'object') {
    return failedResult('bad-response');
  }

  // 云函数自己说是兜底 —— 直接进失败态，不去看它给了什么
  if (response.source === SOURCE.FALLBACK) {
    return failedResult(response.reason);
  }

  // size 是图幅（像素宽高）：模型有时会直接给像素坐标，没有它换算不了
  const parsed = parseAnnotations(response.annotations, { size: opts.size });
  if (!parsed.shapeOk) {
    // 连一份回答都算不上（不是数组、不是对象）。这不是「没问题」，是「没成功」
    return failedResult('bad-shape');
  }

  const rawCount = Array.isArray(response.annotations) ? response.annotations.length : 0;
  const hooks = toHooks(parsed.annotations);

  if (hooks.length === 0) {
    const notice = emptyNotice(rawCount);
    return {
      state: OWN_STATES.DONE,
      failed: false,
      source: response.source,
      hooks: [],
      // 一处都没有时，那句话就放在引导条上 —— 用户的眼睛已经在那儿了
      guide: notice.title,
      notice: notice,
      // 丢弃原因**必须带出去**：界面上「不太确定」那句话背后可能是「模型没把握」，
      // 也可能是「我们自己的坐标解析把它扔了」。两件事长一个样，不记下来就只能靠猜。
      dropped: parsed.dropped
    };
  }

  return {
    state: OWN_STATES.DONE,
    failed: false,
    source: response.source,
    hooks: hooks,
    guide: guideForOwn(hooks.length),
    notice: null,
    dropped: parsed.dropped
  };
}

function failedResult(reason) {
  return {
    state: OWN_STATES.FAILED,
    failed: true,
    source: SOURCE.FALLBACK,
    hooks: [],
    // 失败态由状态块说话（标题 + 一行小字 + 两个出口），引导条不重复
    guide: '',
    notice: failedNotice(reason)
  };
}

module.exports = {
  OWN_STATES: OWN_STATES,
  BUSY_STEPS: BUSY_STEPS,
  OWN_SHOT_ID: OWN_SHOT_ID,
  OWN_MODE: OWN_MODE,
  DEFAULT_APP_NAME: DEFAULT_APP_NAME,
  busyText: busyText,
  isOwnShot: isOwnShot,
  toHooks: toHooks,
  ownShot: ownShot,
  emptyNotice: emptyNotice,
  failedNotice: failedNotice,
  guideForOwn: guideForOwn,
  outcome: outcome
};
