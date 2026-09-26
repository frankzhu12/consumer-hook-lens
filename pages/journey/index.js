const { SHOTS } = require('../../data/shots');
const { getHookPattern } = require('../../utils/hooks');
const reveal = require('../../utils/reveal');
const hold = require('../../utils/hold');
const { rectToStyle } = require('../../utils/annotations');
const swipe = require('../../utils/swipe');
const analyze = require('../../utils/analyze');

/** 第四屏排在三段示例之后，序号固定接在最后 */
const OWN_INDEX = SHOTS.length;

/** 云函数名。改名字只改这一处 */
const CLOUD_DETECT = 'detect';

/**
 * 把 shot（示例或用户自己的图）+ 已揭示集合，拼成标注层和卡片要用的视图数据。
 *
 * 抽成模块级函数是因为第四屏和示例屏用的是**同一个**渲染逻辑：
 * 差别只在 shot 从哪来（data/shots.js 还是云函数的返回），拼法一模一样。
 * 若在页面里写两份，两份必漂。
 */
function buildHookViews(shot, revealed, holding) {
  const hooks = [];
  if (!shot || !Array.isArray(shot.hooks)) return hooks;
  shot.hooks.forEach(function (h, i) {
    const pattern = getHookPattern(h.id);
    if (!pattern) {
      // 错误不许吞掉：词典里没这个 id，是数据写错了
      console.error('[journey] 词典里找不到陷阱 id：' + h.id);
      return;
    }
    const style = rectToStyle(h.rect);
    if (!style) {
      // 坐标非法就干脆不画这个框，也不要画出一个错位的框
      console.error('[journey] 坐标不合法，已跳过：' + h.id + ' ' + JSON.stringify(h.rect));
      return;
    }
    const isOn = revealed.indexOf(h.id) !== -1;
    const hidden = reveal.shouldHideName(shot.mode, h.id, revealed);

    let state = '点一下，看它在哪';
    let note = pattern.note;
    if (hidden) {
      state = '还没找到';
      note = '点一下图上你觉得是消费陷阱的地方';
    } else if (isOn) {
      state = reveal.isFindMode(shot.mode) ? '找到了 · 点一下收起' : '已标出 · 点一下收起';
    }

    // 编号跟着「找到的先后」走，不跟数据顺序走：
    // 用户第一个点中的就是 ①，第二个才是 ② —— 先点中划线价也不该跳出一个 ②。
    // 没揭示的不显示编号（没有框、没有卡内容），编号随手给一个稳定值即可。
    const isRevealedNow = isOn && !hidden;
    const foundAt = revealed.indexOf(h.id);
    const order = isRevealedNow && foundAt !== -1 ? foundAt + 1 : i + 1;

    hooks.push({
      id: h.id,
      order: order,
      name: pattern.name,
      // 用户自己的图：卡片上优先给模型摘出来的图上原话（evidence），
      // 它是对着这张图说的话，比词典里的通用机制句更有说服力。
      // 示例数据没有 evidence，自然落回词典 —— 示例屏一个字都不用改。
      note: h.evidence || note,
      state: state,
      hidden: hidden,
      revealed: isOn,
      // 按住时，已经标出来的那几处被盖住
      covered: holding && isOn,
      style:
        'left:' + style.left + ';top:' + style.top + ';' +
        'width:' + style.width + ';height:' + style.height + ';'
    });
  });
  return hooks;
}

Page({
  data: {
    shotIndex: 0,
    shotTotal: SHOTS.length + 1,
    shot: null,
    hooks: [],
    cardIndex: 0,
    hookProgress: '',
    guide: '',
    allDone: false,
    skipLabel: '',
    findMode: false,
    isLastShot: false,
    isFirstShot: true,
    /** 手指正按在按钮上 */
    holding: false,
    /** 至少标出了一处，按住才有意义 */
    holdReady: false,
    holdBtnLabel: '',
    /** 按钮下面那行小字：邀请动作 */
    holdHint: '',
    /**
     * 能不能做卡片。条件是「至少标出一处」，和 holdReady 恰好相同，
     * 但**故意分成两个字段** —— 它们回答的是两个问题，以后要分开改时不用动对方。
     */
    canMakeCard: false,

    // ── 第四屏（用户自己的图）──────────────────────────
    /** 现在是不是第四屏 */
    isOwn: false,
    /** 第四屏状态机：pick / busy / done / failed。页面照着它渲染，不在事件里现判 */
    ownState: analyze.OWN_STATES.PICK,
    /** 读图中的两步进度文案（上传 / 读图） */
    ownBusyText: '',
    /** 失败态那块的内容：标题 + 一行小字 + 两个出口 */
    ownNotice: null,
    /** 第三屏收尾的入口：三处都标完才出现，这是演示脚本的转折点 */
    showOwnEntry: false,

    /** 第四屏可以直接选用的示例图（和三段示例同一批素材） */
    sampleImages: SHOTS.map(function (s) { return s.image; }),
    /** 三张示例卡下面的小字标签（对应示例的场景：购物 / 支付 / 活动） */
    sampleLabels: ['购物', '支付', '活动'],
    /** 当前选中的示例卡下标。-1 = 一张都没选 */
    ownSampleIndex: -1
  },

  onLoad: function (options) {
    this.revealed = [];
    this.holding = false;
    /** 每一屏的进度存档：shotIndex → 已揭示的 id 数组。回退时靠它恢复 */
    this.progressMap = {};

    // ── 第四屏的实例内状态（不进 data：data 只放界面要渲染的东西）──
    /** 第四屏状态机的当前状态 */
    this.ownState = analyze.OWN_STATES.PICK;
    /** 读图进行到哪一步 */
    this.ownStep = '';
    /** 用户选的那张图（本地临时路径，展示用） */
    this.ownImagePath = '';
    /** 上传后拿到的 fileID（云函数用它读图） */
    this.ownFileID = '';
    /** analyze.outcome() 的结果（done / failed 共用） */
    this.ownOutcome = null;
    /** done 态的 shot（Shot 形状，标注已映射进去） */
    this.ownShotData = null;

    // 主页「上传截图」带 screen=own 进来：直接落到第四屏，不走前三段示例
    this.goShot(options && options.screen === 'own' ? OWN_INDEX : 0);
  },

  goShot: function (index) {
    // 第四屏不走示例数据的查找路径
    if (index >= OWN_INDEX) {
      this.enterOwn();
      return;
    }
    const shot = SHOTS[index];
    // 页面守卫：没有数据就别往下走，免得出现一屏空白
    if (!shot) {
      console.error('[journey] 找不到第 ' + index + ' 张示例');
      return;
    }
    // 离开当前屏前，先把这屏已标出的进度存档 —— 回退时才能原样恢复。
    // 首次进页（还没有当前屏）不存，存进来的也是空集。
    if (this.data.shot) {
      this.progressMap[this.data.shotIndex] = this.revealed.slice();
    }
    // 换图时按住状态必须清掉，否则新一屏会带着上一屏的盖子进来
    this.holding = false;
    // 进这一屏：有存档就恢复存档（回退不丢进度），没有才按 mode 初始化。
    // slice 是防串档：恢复出来的一份，之后怎么点都不会改到存档。
    const saved = this.progressMap[index];
    this.revealed = saved ? saved.slice() : reveal.initialRevealed(shot.mode, shot.hooks);
    this.setData(
      {
        shotIndex: index,
        shot: shot,
        cardIndex: 0,
        findMode: reveal.isFindMode(shot.mode),
        isLastShot: index === SHOTS.length - 1,
        isFirstShot: index === 0,
        isOwn: false
      },
      this.refresh
    );
  },

  /** 把示例数据 + 已揭示集合，拼成界面要用的视图数据 */
  refresh: function () {
    if (this.data.isOwn) {
      this.refreshOwn();
      return;
    }
    const shot = this.data.shot;
    if (!shot) return;
    const holding = this.holding === true;
    const hooks = buildHookViews(shot, this.revealed, holding);

    const holdReady = hold.canHold(this.revealed);
    const allDone = reveal.allRevealed(shot.hooks, this.revealed);

    this.setData({
      hooks: hooks,
      hookProgress: reveal.hookProgressText(shot.hooks, this.revealed),
      guide: reveal.guideText(shot.mode, shot.hooks, this.revealed),
      // 「直接显示」只在还有得找的屏上出现 —— 教学屏没有「找」可跳过
      skipLabel: reveal.isFindMode(shot.mode) && !allDone ? reveal.skipHint() : '',
      allDone: allDone,
      holding: holding,
      holdReady: holdReady,
      holdBtnLabel: hold.holdLabel(holding),
      holdHint: hold.holdHintText(holdReady, holding),
      canMakeCard: holdReady,
      // 第三屏收尾的转折点：三处都标完，「用你自己的图试一次」才出现
      showOwnEntry: this.data.isLastShot && allDone
    });
  },

  // ── 第四屏：进屏与视图 ──────────────────────────────

  /** 进第四屏。状态留在了实例里（选过图、有结果），回来时原样恢复 */
  enterOwn: function () {
    // 离开当前屏前先存档 —— 示例屏的规矩对第四屏自己也适用
    if (this.data.shot) {
      this.progressMap[this.data.shotIndex] = this.revealed.slice();
    }
    this.holding = false;
    const state = this.ownState || analyze.OWN_STATES.PICK;
    // done 态恢复完整的 shot；busy/failed 恢复「只有图、没有标注」的 shot；
    // 还没选过图就是 null，让选图块顶上来
    const shot =
      state === analyze.OWN_STATES.DONE
        ? this.ownShotData
        : (this.ownImagePath ? analyze.ownShot({ image: this.ownImagePath, hooks: [] }) : null);
    // done 态的揭示进度同样有存档（比如标到一半滑回示例屏再回来）
    const saved = state === analyze.OWN_STATES.DONE ? this.progressMap[OWN_INDEX] : null;
    this.revealed = saved ? saved.slice() : [];
    this.setData(
      {
        shotIndex: OWN_INDEX,
        shot: shot,
        cardIndex: 0,
        findMode: false,
        isLastShot: true,
        isFirstShot: false,
        isOwn: true
      },
      this.refresh
    );
  },

  /**
   * 第四屏的视图刷新。
   *
   * 结构刻意和示例屏的 refresh 对齐：都是「拼 hooks → 算按住态 → setData」。
   * 差别只有三处：引导条的话来自 analyze（三种「没有」的文案在那边）、
   * 没有「直接显示」的退路、卡片入口暂不开放（7.4c 接）。
   */
  refreshOwn: function () {
    const state = this.ownState || analyze.OWN_STATES.PICK;
    const shot = this.data.shot;
    const holding = this.holding === true;

    // 还没选图：整个标注视图清空，别让示例屏的东西残留到选图块底下
    if (!shot) {
      this.setData({
        hooks: [],
        hookProgress: '',
        guide: '',
        allDone: false,
        skipLabel: '',
        holding: false,
        holdReady: false,
        holdBtnLabel: hold.holdLabel(false),
        holdHint: '',
        canMakeCard: false,
        showOwnEntry: false,
        ownState: state,
        ownBusyText: '',
        ownNotice: state === analyze.OWN_STATES.FAILED && this.ownOutcome
          ? this.ownOutcome.notice
          : null
      });
      return;
    }

    const hooks = buildHookViews(shot, this.revealed, holding);
    const holdReady = hold.canHold(this.revealed);

    let guide = '';
    if (state === analyze.OWN_STATES.BUSY) {
      // 进度是**真的**：上传和读图是两个步骤，两句话说得清区别
      guide = this.data.ownBusyText;
    } else if (state === analyze.OWN_STATES.DONE) {
      // 有结果（包括「没看出问题」）时，那句话在 analyze.outcome 里就定好了
      guide = this.ownOutcome ? this.ownOutcome.guide : '';
    }
    // failed 不进引导条：失败态有自己的块（标题 + 小字 + 两个出口），两处同时说话会抢

    this.setData({
      hooks: hooks,
      hookProgress: reveal.hookProgressText(shot.hooks, this.revealed),
      guide: guide,
      allDone: reveal.allRevealed(shot.hooks, this.revealed),
      skipLabel: '',
      holding: holding,
      holdReady: holdReady,
      holdBtnLabel: hold.holdLabel(holding),
      holdHint: hold.holdHintText(holdReady, holding),
      // 第四屏做卡片要跨页带图，7.4c 再接；现在先关死，不开一个「能点但打不开」的门
      canMakeCard: false,
      showOwnEntry: false,
      ownState: state,
      ownNotice: state === analyze.OWN_STATES.FAILED && this.ownOutcome
        ? this.ownOutcome.notice
        : null
    });
  },

  onEnterOwn: function () {
    this.enterOwn();
  },

  // ── 第四屏：选图 → 上传 → 读图 ──────────────────────
  // 链路上每一步失败都落到 setOwnFailed，没有一个分支会「悄悄没下文」。

  /** 点一张示例卡：只是选中它（橙框 + 对勾），链路等「开始分析」才启动。
   *  再点别的卡就换选中，再点同一张保持选中 —— 选中和开跑是两步，别混在一起 */
  onPickSample: function (e) {
    const index = Number(e && e.currentTarget && e.currentTarget.dataset.index);
    if (!SHOTS[index]) return;
    this.setData({ ownSampleIndex: index });
  },

  /** 开始分析：把选中的示例图送进读图链路。素材在代码包里，
   *  云存储上传只认真实本地文件，所以先复制一份到用户目录再走同一条链路；
   *  复制不了（机型差异）就用代码包原路径继续 —— 链路上自己的守卫会接住真正的失败 */
  onStartAnalyze: function () {
    const index = this.data.ownSampleIndex;
    if (index < 0 || !SHOTS[index]) {
      // 没选就点：不静默、不替用户猜一张，一句话说清少什么
      wx.showToast({ title: '先选一张截图', icon: 'none' });
      return;
    }
    const shot = SHOTS[index];
    const self = this;
    let fs = null;
    if (wx.getFileSystemManager && wx.env && wx.env.USER_DATA_PATH) {
      fs = wx.getFileSystemManager();
    }
    if (!fs) {
      this.ownProcess(shot.image);
      return;
    }
    const dest = wx.env.USER_DATA_PATH + '/sample-' + index + '.jpg';
    fs.copyFile({
      srcPath: shot.image,
      destPath: dest,
      success: function () {
        self.ownProcess(dest);
      },
      fail: function () {
        self.ownProcess(shot.image);
      }
    });
  },

  onPickImage: function () {
    const self = this;
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sizeType: ['compressed'],
      success: function (res) {
        const f = res && res.tempFiles && res.tempFiles[0];
        if (!f || !f.tempFilePath) return; // 没拿到图就当没选，停在选图态
        // 上传前把图压到 720px 宽：模型读图的时间随图的大小涨，
        // 而定位促销元素要的是「相对位置」，不需要原图分辨率。
        // 压缩失败（机型差异）就用原图继续，别让链路断在这里。
        wx.compressImage({
          src: f.tempFilePath,
          quality: 35,
          compressedWidth: 600,
          success: function (c) {
            self.ownProcess(c.tempFilePath);
          },
          fail: function () {
            self.ownProcess(f.tempFilePath);
          }
        });
      }
      // 用户取消（fail cancel）什么都不做：停回选图态就是正确反应
    });
  },

  /** 拿到图之后的整条链路：图先上舞台，再上传、再读图 —— 两步进度用户都看得见 */
  ownProcess: function (imagePath) {
    this.ownImagePath = imagePath;
    this.ownFileID = '';
    this.ownImageSize = null;
    // 图幅是**换算像素坐标**的唯一依据：模型有时直接给 `{"x":264,...}` 这种像素值，
    // 没有宽高就没法换成 0–1 比例，那些标注会被整条丢掉（界面于是显示「不太确定」）。
    // 取不到也不算失败 —— 那时候像素坐标照旧判非法，宁可不画也不画错位。
    const self = this;
    wx.getImageInfo({
      src: imagePath,
      success: function (info) {
        self.ownImageSize = { w: info && info.width, h: info && info.height };
      },
      fail: function () {
        self.ownImageSize = null;
      }
    });
    const shot = analyze.ownShot({ image: imagePath, hooks: [] });
    if (!shot) {
      // 选图成功却没有路径是说不通的，但守一下：宁要诚实的失败，不要白屏
      this.setOwnFailed('bad-image');
      return;
    }
    this.setData({ shot: shot });
    this.setOwnBusy(analyze.BUSY_STEPS.UPLOAD);
    this.ownUpload();
  },

  setOwnBusy: function (step) {
    this.ownState = analyze.OWN_STATES.BUSY;
    this.ownStep = step;
    // 用户可能在读图中已经滑回示例屏了：状态记下，界面不动
    if (!this.data.isOwn) return;
    this.setData({ ownBusyText: analyze.busyText(step) }, this.refresh);
  },

  ownUpload: function () {
    const self = this;
    if (!wx.cloud || !wx.cloud.uploadFile) {
      this.setOwnFailed('no-cloud');
      return;
    }
    const m = /\.(\w+)$/.exec(this.ownImagePath || '');
    wx.cloud.uploadFile({
      cloudPath: 'detect/' + Date.now() + '-' + Math.floor(Math.random() * 1000000) + (m ? '.' + m[1] : '.png'),
      filePath: this.ownImagePath,
      success: function (res) {
        if (!res || !res.fileID) {
          self.setOwnFailed('no-fileid');
          return;
        }
        self.ownFileID = res.fileID;
        self.setOwnBusy(analyze.BUSY_STEPS.DETECT);
        self.ownDetect();
      },
      fail: function (err) {
        console.error('[journey] 上传失败（原始错误）', err);
        self.setOwnFailed('upload');
      }
    });
  },

  ownDetect: function () {
    const self = this;
    if (!wx.cloud || !wx.cloud.callFunction) {
      this.setOwnFailed('no-cloud');
      return;
    }
    wx.cloud.callFunction({
      name: CLOUD_DETECT,
      data: { fileID: this.ownFileID },
      success: function (res) {
        self.applyOwnResult(res && res.result);
      },
      fail: function (err) {
        // 真实错误必须留下：errMsg/errCode 是排查云调用问题的唯一线索
        console.error('[journey] 云函数调用失败（原始错误）', err);
        self.setOwnFailed('detect');
      }
    });
  },

  /**
   * 云函数返回 → 第四屏该显示什么。
   *
   * 所有分支都在 analyze.outcome 里，这里只负责「把结果接进页面」。
   */
  applyOwnResult: function (response) {
    const r = analyze.outcome(response, { size: this.ownImageSize });
    this.ownOutcome = r;
    // 丢掉的原因只有日志里有：界面上「不太确定」这句话背后，
    // 可能是模型真没把握，也可能是我们自己的解析把结果扔了 —— 不打出来就只能靠猜
    if (r.dropped && r.dropped.length) {
      console.warn('[journey] 标注被丢掉：', r.dropped.join('、'));
    }
    if (r.failed) {
      this.ownState = analyze.OWN_STATES.FAILED;
    } else {
      this.ownState = analyze.OWN_STATES.DONE;
      this.ownShotData = analyze.ownShot({ image: this.ownImagePath, hooks: r.hooks });
    }
    // 读图期间用户可能已经滑回示例屏了：结果先存好，等回到第四屏再上界面
    if (!this.data.isOwn) return;
    if (r.failed) {
      this.refresh();
      return;
    }
    if (!this.ownShotData) {
      // 有标注却拼不出 shot，说明图丢了 —— 按失败处理，不硬撑
      this.setOwnFailed('bad-image');
      return;
    }
    this.revealed = reveal.initialRevealed(this.ownShotData.mode, this.ownShotData.hooks);
    this.setData({ shot: this.ownShotData }, this.refresh);
  },

  /** 链路上任何一步失败都落到这里。文案在 analyze.failedNotice，出处唯一 */
  setOwnFailed: function (reason) {
    this.ownState = analyze.OWN_STATES.FAILED;
    this.ownOutcome = { failed: true, notice: analyze.failedNotice(reason) };
    // 失败原因进日志（排查用），不进界面 —— 界面上只有那两句人话
    console.error('[journey] 第四屏读图没成功：' + (reason || ''));
    if (!this.data.isOwn) return;
    this.refresh();
  },

  /** 失败态的两个出口：再试一次 / 换一张 */
  onOwnAction: function (e) {
    const key = e && e.currentTarget && e.currentTarget.dataset.key;
    if (key === 'retry') {
      // 有图就整条链路重跑（两步进度照真走）；图都没有就回到选图
      if (this.ownImagePath) {
        this.ownProcess(this.ownImagePath);
      } else {
        this.setOwnPick();
      }
      return;
    }
    if (key === 'pick') {
      this.setOwnPick();
    }
  },

  /** 回到选图态。图和结果都清掉 —— 「换一张」就要真的换一张 */
  setOwnPick: function () {
    this.ownState = analyze.OWN_STATES.PICK;
    this.ownStep = '';
    this.ownOutcome = null;
    this.ownShotData = null;
    this.ownImagePath = '';
    this.ownFileID = '';
    this.revealed = [];
    delete this.progressMap[OWN_INDEX];
    this.setData({ shot: null, ownNotice: null }, this.refresh);
  },

  // ── 按住，只看商品 ──
  // 用 bindtouchstart / bindtouchend，不用 bindlongpress：
  // bindlongpress 只在长按时触发一次，而且不包含手指刚碰到的那一刻，
  // 松手时机也无从得知 —— 而「按住→松开」的连续性正是这个动作的全部。

  onHoldStart: function () {
    if (!this.data.holdReady) {
      wx.showToast({ title: hold.HOLD_LOCKED_TEXT, icon: 'none', duration: 1400 });
      return;
    }
    if (this.holding) return;
    this.holding = true;
    this.refresh();
  },

  onHoldEnd: function () {
    if (!this.holding) return;
    this.holding = false;
    this.refresh();
  },

  /** 盖子上的点击：什么都不做，只是别让它落到图上去（否则会误弹提示） */
  onCoverTap: function () {
    return;
  },

  /** 点底部卡片：揭示 / 收起。找的模式下，没找到的那几张点不动 ——
      否则一路点过去就把「找」这件事绕过去了 */
  onCardTap: function (e) {
    // 按住时不许操作，免得一只手按住、另一只手把状态改乱了
    if (this.holding) return;
    const item = this.findHook(e.currentTarget.dataset.id);
    if (!item) return;
    if (item.hidden) {
      wx.showToast({ title: '先在图里找找看', icon: 'none', duration: 1200 });
      return;
    }
    this.revealed = reveal.toggleRevealed(this.revealed, item.id);
    this.refresh();
  },

  /** 点左右滑动卡片 */
  onCardChange: function (e) {
    this.setData({ cardIndex: e.detail.current });
  },

  /** 点图上已经标出来的框：把对应卡片切到前面来 */
  onMarkTap: function (e) {
    if (this.holding) return;
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    this.setData({ cardIndex: this.hookIndexById(id) });
  },

  /** 在图上点中了一处还没找到的陷阱 —— 这就是「找到」 */
  onHitTap: function (e) {
    if (this.holding) return;
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    this.revealed = reveal.toggleRevealed(this.revealed, id);
    const next = { cardIndex: this.hookIndexById(id) };
    this.setData(next, this.refresh);
  },

  /** 按 id 找 hook 在 hooks 数组里的下标；找不到就停在当前卡片 */
  hookIndexById: function (id) {
    const list = this.data.hooks || [];
    for (let i = 0; i < list.length; i++) {
      if (list[i].id === id) return i;
    }
    return this.data.cardIndex;
  },

  /** 点在图上、但没点中任何一处。不判错，只给一句轻提示 */
  onStageTap: function () {
    if (this.holding) return;
    const shot = this.data.shot;
    if (!shot || !reveal.isFindMode(shot.mode)) return;
    if (reveal.allRevealed(shot.hooks, this.revealed)) return;
    wx.showToast({ title: reveal.wrongTapHint(), icon: 'none', duration: 1200 });
  },

  /** 「直接显示」：不想找也能走通 */
  onRevealNext: function () {
    if (this.holding) return;
    const next = reveal.nextUnrevealed(this.data.shot.hooks, this.revealed);
    if (!next) return;
    const index = this.data.shot.hooks.map(function (h) { return h.id; }).indexOf(next.id);
    this.revealed = reveal.toggleRevealed(this.revealed, next.id);
    this.setData({ cardIndex: index < 0 ? this.data.cardIndex : index }, this.refresh);
  },

  onNextShot: function () {
    const next = this.data.shotIndex + 1;
    // 第四屏的两个入口：第三屏收尾的入口、主页「上传截图」带参直达。
    // 翻页箭头仍然不接第四屏 —— 顺着示例走完才算完成引导
    if (next >= OWN_INDEX) return;
    this.goShot(next);
  },

  /** 退回上一张。第一张时没有上一张，直接不动（按钮同时是置灰的） */
  onPrevShot: function () {
    const prev = this.data.shotIndex - 1;
    if (prev < 0) return;
    this.goShot(prev);
  },

  // --- 图上左右滑动翻页 ---
  // 判别逻辑在 utils/swipe.js（纯函数）；这里只记起点、问方向、执行翻页。
  // touchend 用 changedTouches：手指此刻已经离开，touches 里未必还有它。

  onStageTouchStart: function (e) {
    const t = e.touches && e.touches[0];
    this.touchStart = t ? { x: t.clientX, y: t.clientY } : null;
  },

  onStageTouchEnd: function (e) {
    // 按住看商品时不许翻页，免得一只手按住、另一只手把屏翻了
    if (this.holding) {
      this.touchStart = null;
      return;
    }
    const t = e.changedTouches && e.changedTouches[0];
    if (!t || !this.touchStart) return;
    const dir = swipe.swipeDirection(this.touchStart, { x: t.clientX, y: t.clientY });
    this.touchStart = null;
    if (dir === 'left') this.onNextShot();
    else if (dir === 'right') this.onPrevShot();
  },

  onStageTouchCancel: function () {
    this.touchStart = null;
  },

  /** 去生成卡片。只带上这一屏里**已经标出来**的那几处 */
  onMakeCard: function () {
    if (!this.data.canMakeCard) {
      wx.showToast({ title: '先标出一处，再来做卡片', icon: 'none', duration: 1400 });
      return;
    }
    // 用 hooks 而不是 revealed：hooks 是按示例顺序拼好的，而且已经滤掉了词典里没有的 id
    const ids = this.data.hooks
      .filter(function (h) { return h.revealed; })
      .map(function (h) { return h.id; });
    if (ids.length === 0) {
      // 上面那道门已经挡住了，这里再挡一次：宁可什么都不做，也不要开一个空卡片页
      console.error('[journey] canMakeCard 为真但一处都没标出来，状态不一致');
      return;
    }
    wx.navigateTo({
      url: '/pages/card/index?shot=' + this.data.shotIndex + '&ids=' + ids.join(',')
    });
  },

  findHook: function (id) {
    const list = this.data.hooks.filter(function (h) { return h.id === id; });
    return list.length ? list[0] : null;
  }
});
