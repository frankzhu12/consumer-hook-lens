/**
 * 「按住，只看商品」的纯逻辑 —— 不碰界面。
 *
 * 这个动作是整套演示的高潮：按住时把已经标出来的那几处促销提示盖住，
 * 商品和价格留下。松手复原，评委就能在同一位置比较：
 * 「有这些提示时我先看什么？没有它们时，我还想买吗？」
 *
 * 规矩（写在这里，改之前先想清楚）：
 * - **只盖已经标出来的那些**。没找到的那处如果也被盖住，等于剧透答案。
 * - 图上不另配说明文字（2026-09-26 按用户要求拆掉横幅）：
 *   按住是一次身体动作，话都在按钮和引导条里说完了，盖住就是盖住。
 */

/** 至少标出一处，按住才有意义 */
function canHold(revealed) {
  return Array.isArray(revealed) && revealed.length > 0;
}

/** 按住时要盖住哪些：就是已经标出来的那些 */
function coveredIds(hooks, revealed) {
  if (!Array.isArray(hooks)) return [];
  const list = Array.isArray(revealed) ? revealed : [];
  const out = [];
  hooks.forEach(function (h) {
    if (list.indexOf(h.id) !== -1) out.push(h.id);
  });
  return out;
}

function holdLabel(holding) {
  return holding ? '松开，恢复' : '按住，只看商品';
}

/**
 * 按钮下面那行小字。
 *
 * 「先标出一处，再按住试试」和「按住下面，把刚才那几处拿掉」都是**邀请动作**。
 * 按住时返回空串：那时候整个界面都在「使劲看」，一个字都不要多说。
 */
const HOLD_LOCKED_TEXT = '先标出一处，再按住试试';
const HOLD_IDLE_TEXT = '按住下面，把刚才那几处拿掉';

function holdHintText(canHoldNow, holding) {
  if (!canHoldNow) return HOLD_LOCKED_TEXT;
  if (holding) return '';
  return HOLD_IDLE_TEXT;
}

module.exports = {
  canHold: canHold,
  coveredIds: coveredIds,
  holdLabel: holdLabel,
  holdHintText: holdHintText,
  HOLD_LOCKED_TEXT: HOLD_LOCKED_TEXT,
  HOLD_IDLE_TEXT: HOLD_IDLE_TEXT
};
