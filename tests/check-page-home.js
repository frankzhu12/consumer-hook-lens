/**
 * 主页的状态机 —— 把页面在 Node 里跑起来测。
 *
 * 主页很小，但它守着两条别的页面没有的规矩：
 *   1. **文案不许硬编码。** 产品名和口号都从 utils/brand.js 读 ——
 *      check-brand 守着「名字不许出现第三处」，这里守着「页面显示的
 *      必须和 brand.js、app.json 一致」。哪天有人图快在 wxml 里写了字面量，
 *      wxml 没法直接测，但 data 源头一变就会在这里被抓住。
 *   2. **入口必须通。** 主页是启动页，唯一的活儿就是把人送进 journey ——
 *      navigateTo 的 url 错一个字，整条产品线就断在第一屏。
 *
 * 另外核对 app.json：home 必须是第一个页面（启动页），journey/card 必须还在。
 */

const fs = require('fs');
const path = require('path');
const { createSuite } = require('./harness');

const suite = createSuite('check-page-home.js');

// --- 桩：Page / wx ---

let pageConfig = null;
const navigations = [];

global.Page = function (cfg) {
  pageConfig = cfg;
};
global.wx = {
  navigateTo: function (o) {
    navigations.push(o && o.url);
  }
};

require('../pages/home/index.js');

const brand = require('../utils/brand');

if (!pageConfig) {
  throw new Error('主页没把配置交给 Page()，后面的检查都无从谈起');
}

/** 造一个页面实例：把配置上的方法和 data 搬过来，再补一个 setData */
function makePage() {
  const inst = {};
  Object.keys(pageConfig).forEach(function (k) {
    inst[k] = pageConfig[k];
  });
  inst.data = JSON.parse(JSON.stringify(pageConfig.data));
  inst.setData = function (patch) {
    const self = this;
    Object.keys(patch).forEach(function (k) {
      self.data[k] = patch[k];
    });
  };
  return inst;
}

// --- app.json：主页是启动页，且 journey/card 都还在 ---

const appJson = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'app.json'), 'utf8')
);

suite.eq('主页是第一个页面（启动页）', appJson.pages[0], 'pages/home/index');
suite.ok('journey 页还在清单里', appJson.pages.indexOf('pages/journey/index') !== -1);
suite.ok('card 页还在清单里', appJson.pages.indexOf('pages/card/index') !== -1);

// --- 文案来源：页面 data 必须和 brand.js / app.json 一致 ---

const page = makePage();
page.onLoad ? page.onLoad() : null;

suite.eq('产品名来自 brand.js（不是页面里另写的）', page.data.appName, brand.APP_NAME);
suite.eq('口号来自 brand.js（复用卡片页脚那句，不另造文案）', page.data.slogan, brand.CARD_FOOTER);
suite.eq(
  '页面显示的名字和 app.json 导航栏标题一字不差',
  page.data.appName,
  appJson.window.navigationBarTitleText
);

// --- 上传入口：直达 journey 第四屏（读用户自己的图） ---

page.onUploadTap();
suite.eq(
  '点「上传截图」带 screen=own 跳 journey 第四屏',
  navigations[0],
  '/pages/journey/index?screen=own'
);

// --- 主入口：把人送进 journey ---

page.onStartExamples();
suite.eq('点「看看例子」跳 journey 页', navigations[1], '/pages/journey/index');

page.onStartExamples();
suite.eq('连点两次，每次都正常发起跳转（不吞不崩）', navigations.length, 3);

suite.done();
