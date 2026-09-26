/**
 * 主页 —— 小程序的启动页。
 *
 * 它只回答一个问题：**这个产品是干什么的，我现在该点哪。**
 * 第一次打开的人没有任何上下文，所以主页的职责是三件事：
 *   1. 一句话说清产品（用 brand.js 里现成的那句，不另造文案 —— 一份内容只有一个来源）
 *   2. 把「教 → 练 → 放手 → 按住只看商品」这条线交代清楚
 *   3. 把用户送到 journey 页 —— 那里是完整的体验闭环
 *
 * 「上传自己的截图」直达 journey 第四屏（screen=own）—— 那里是完整的读图链路。
 *
 * 产品名和口号都从 utils/brand.js 读，这个页面里不写字面量
 * （check-brand 守着「名字不许出现第三处」，check-page-home 守着「页面显示的
 * 必须和 brand.js 一致」）。
 */

const brand = require('../../utils/brand');

Page({
  data: {
    /** 主标题。和 app.json 的导航栏标题同源，必须一字不差 */
    appName: brand.APP_NAME,
    /** 一句话说清产品。直接复用分享卡片页脚那句 —— 它本来就是产品的一句话介绍 */
    slogan: brand.CARD_FOOTER
  },

  /** 进三段示例。journey 自己会从第一屏开始，不需要带参数 */
  onStartExamples() {
    wx.navigateTo({ url: '/pages/journey/index' });
  },

  /** 上传自己的截图。第四屏（读自己的图）已经就绪，带 screen=own 直达那一屏 */
  onUploadTap() {
    wx.navigateTo({ url: '/pages/journey/index?screen=own' });
  }
});
