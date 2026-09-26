/**
 * 云函数里那一份词典，必须和 utils/hooks.js 逐字段一样。
 *
 * 为什么值得为它单独写一个套件：词典一旦漂，**不会有任何人发现** ——
 * 模型照样返回结果，只是按旧名字返回，界面上看起来一切正常。
 * 这类问题只能靠脚本扫出来，靠人看是看不出来的。
 */

const fs = require('fs');
const path = require('path');
const { createSuite } = require('./harness');
const hooks = require('../utils/hooks');

const suite = createSuite('check-detect-sync.js');

const ROOT = path.join(__dirname, '..');
const DICT_FILE = path.join(ROOT, 'cloudfunctions', 'detect', 'lib', 'hook-dict.js');
const PROMPT_FILE = path.join(ROOT, 'cloudfunctions', 'detect', 'lib', 'prompt.js');

const REGEN_HINT = '重新生成：node tools/build-detect-prompt.js';

function readText(p) {
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

// --- 生成物存在吗 ---

suite.ok('云函数侧的词典文件存在', fs.existsSync(DICT_FILE));
suite.ok('云函数的 prompt 文件存在', fs.existsSync(PROMPT_FILE));

if (!fs.existsSync(DICT_FILE)) {
  suite.done();
  return;
}

const dictSource = readText(DICT_FILE);
const dict = require(DICT_FILE);
const prompt = require(PROMPT_FILE);

// --- 生成物 = 词典，逐字段比 ---

const wantDimensions = hooks.HOOK_DIMENSIONS.map(function (d) {
  return { id: d.id, name: d.name, blurb: d.blurb, closing: d.closing };
});
const wantPatterns = hooks.HOOK_PATTERNS.map(function (p) {
  return { id: p.id, dimensionId: p.dimensionId, name: p.name, note: p.note };
});

suite.eq(
  '云函数侧的 5 个维度与词典逐字段一致（不一致就跑 ' + REGEN_HINT + '）',
  dict.DIMENSIONS,
  wantDimensions
);
suite.eq(
  '云函数侧的 13 个模式与词典逐字段一致（不一致就跑 ' + REGEN_HINT + '）',
  dict.PATTERNS,
  wantPatterns
);

// --- 生成物自己要有「别手改」的标识 ---

suite.ok('生成物开头就写着「不要手改」', dictSource.indexOf('不要手改') !== -1);
suite.ok('生成物里写着重新生成的命令', dictSource.indexOf(REGEN_HINT) !== -1);
suite.ok('生成物里写明了来源', dictSource.indexOf('utils/hooks.js') !== -1);

// --- prompt 不许手抄词典 ---

const promptSource = readText(PROMPT_FILE);
const copied = hooks.HOOK_PATTERNS.filter(function (p) {
  return promptSource.indexOf(p.name) !== -1;
}).map(function (p) { return p.name; });
suite.eq(
  'prompt 源码里一个陷阱名都没有手抄（有的话就该从 hook-dict 读）',
  copied,
  []
);

const copiedNotes = hooks.HOOK_PATTERNS.filter(function (p) {
  return promptSource.indexOf(p.note) !== -1;
}).map(function (p) { return p.id; });
suite.eq('prompt 源码里也没有手抄的机制句', copiedNotes, []);

// --- 但运行时必须真的用上词典 ---

const text = prompt.DETECT_PROMPT;
suite.ok('prompt 是一段非空的文字', typeof text === 'string' && text.length > 200);

const missingInPrompt = hooks.HOOK_PATTERNS.filter(function (p) {
  return text.indexOf(p.id + ' ' + p.name) === -1;
}).map(function (p) { return p.id; });
suite.eq('每个模式的「id + 名字」都出现在 prompt 里', missingInPrompt, []);

const missingNotes = hooks.HOOK_PATTERNS.filter(function (p) {
  return text.indexOf(p.note) === -1;
}).map(function (p) { return p.id; });
suite.eq('每句机制都出现在 prompt 里（一个字都不能差）', missingNotes, []);

const missingDims = hooks.HOOK_DIMENSIONS.filter(function (d) {
  return text.indexOf(d.name) === -1;
}).map(function (d) { return d.id; });
suite.eq('每个维度的名字都出现在 prompt 里（模型要知道归属）', missingDims, []);

// --- 反过来：prompt 里不许出现词典之外的编码 ---

const codesInPrompt = [];
const re = /\b([A-E][1-9])\b/g;
let m;
while ((m = re.exec(text)) !== null) {
  if (codesInPrompt.indexOf(m[1]) === -1) codesInPrompt.push(m[1]);
}
const ghostCodes = codesInPrompt.filter(function (c) { return !hooks.getHookPattern(c); });
suite.eq('prompt 里没有词典之外的编码（那个格式示例里的除外）', ghostCodes, []);

// --- 三条硬规矩要真的写进指令里 ---

suite.ok('prompt 里写了「只判断设计机制」', text.indexOf('只判断') !== -1);
suite.ok('prompt 里写了「词典之外不要自造分类」', text.indexOf('不要自造分类') !== -1);
suite.ok('prompt 里写了「宁可少报」', text.indexOf('宁可少报') !== -1);
suite.ok('prompt 里允许「一处都没看出来」这个答案', text.indexOf('{"annotations": []}') !== -1);
suite.ok('prompt 里要求只输出 JSON', text.indexOf('只输出 JSON') !== -1);
suite.ok('prompt 里说明了 rect 是 0–1 比例、不是像素', text.indexOf('0–1') !== -1);

// --- 约定：阈值这类常量只有一处来源 ---

const detectParse = require('../utils/detect-parse');
suite.ok(
  'prompt 里「最多 12 个字」的说法和解析层的上限一致',
  text.indexOf('最多 ' + detectParse.MAX_EVIDENCE + ' 个字') !== -1
);
suite.ok(
  'prompt 里「最多 4 处」的说法和解析层的上限一致（模型多报的会被裁掉，指令里就得说清）',
  text.indexOf('最多 ' + detectParse.MAX_ANNOTATIONS + ' 处') !== -1
);

// --- 框的是整个元素，不是一句文字 ---
//
// 视觉模型最常犯的错就是只框一行字 —— 框小了，手指按不住，按住只看商品时
// 也盖不住整个设计。这条指令是 2026-09-26 从外部经验里吸收的，要守着别漂。

suite.ok('prompt 里写了「框住完整的界面元素」', text.indexOf('完整的界面元素') !== -1);
suite.ok('prompt 里写了「不要只框其中一句文字」', text.indexOf('不要只框其中一句文字') !== -1);

suite.done();
