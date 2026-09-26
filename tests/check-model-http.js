/**
 * 直连外部模型那条路（lib/model-http.js）。
 *
 * 这里一次网都不上：httpPost 是注入的，所以 200 / 403 / 乱 JSON / 超时 / 分段返回
 * 全都能离线验。理由和 defense.js 注入 callModel 一样 —— 这是「没界面」的东西。
 *
 * 特别要守住的两条：
 *   1. **403 必须看得见状态码**。现实里它最常见的意思是「免费额度用尽」，
 *      只看「调用失败」四个字谁也猜不到；
 *   2. **没配齐三个环境变量时不许发请求**，也不许悄悄退回内置模型 ——
 *      那是「假装成功」的一个变种，由调用方（index.js）明确决定走哪条。
 */

const { createSuite } = require('./harness');
const mh = require('../cloudfunctions/detect/lib/model-http');
const defense = require('../cloudfunctions/detect/lib/defense');

const suite = createSuite('check-model-http.js');

const ENV = {
  MODEL_BASE_URL: 'https://example.com/compatible-mode/v1',
  MODEL_API_KEY: 'test-key-not-real',
  MODEL_NAME: 'qwen3.8-omni-flash'
};

const PROMPT = '找出这张图里的诱导设计';
const IMAGE = 'https://example.com/a.jpg';

// ---------- 读配置 ----------

suite.eq(
  '三个环境变量都读到了',
  mh.readConfig(ENV),
  { baseUrl: ENV.MODEL_BASE_URL, apiKey: ENV.MODEL_API_KEY, model: ENV.MODEL_NAME, reasoningEffort: 'none', imageDetail: 'high' }
);

suite.eq(
  '端点尾部多余的斜杠会被去掉（否则拼出 /v1//chat/completions）',
  mh.readConfig({ MODEL_BASE_URL: 'https://example.com/v1///' }).baseUrl,
  'https://example.com/v1'
);

suite.eq('什么都没配时读到三个空串，思考强度默认 none，图片保真默认 high', mh.readConfig({}), { baseUrl: '', apiKey: '', model: '', reasoningEffort: 'none', imageDetail: 'high' });

// ---------- 关思考（reasoning_effort）----------
//
// 这条是 2026-09-25 拿真模型、真图测出来的，不是猜的：
//   不带该参数 → 18.1 秒，1372 个输出 token 里 1199 个在思考
//   带 none     → 2.5 秒，182 个 token 全是正文
// 非流式必须等思考全部生成完才返回，所以云函数那两次「20 秒整、0 字节」就是它。
// 不设默认、或默认值写错，表现是「演示时每张图都超时」——必须守死。

suite.eq('默认关思考', mh.readConfig(ENV).reasoningEffort, 'none');
suite.eq('显式配成别的就按配的来', mh.readConfig({ MODEL_REASONING_EFFORT: 'low' }).reasoningEffort, 'low');
suite.eq('显式配成空串表示「这个模型不吃这个参数」', mh.readConfig({ MODEL_REASONING_EFFORT: '' }).reasoningEffort, '');

suite.ok('三个都齐了才算配好', mh.isConfigured(mh.readConfig(ENV)) === true);
suite.ok('缺端点不算配好', mh.isConfigured({ apiKey: 'k', model: 'm' }) === false);
suite.ok('缺 Key 不算配好', mh.isConfigured({ baseUrl: 'u', model: 'm' }) === false);
suite.ok('缺模型名不算配好', mh.isConfigured({ baseUrl: 'u', apiKey: 'k' }) === false);

// ---------- 发请求 ----------

/** 记下每次调用，并按第几次返回预设的响应 */
function makePost(responder) {
  const calls = [];
  const fn = function (url, headers, body, timeoutMs) {
    calls.push({ url: url, headers: headers, body: body, timeoutMs: timeoutMs });
    const r = responder(calls.length);
    if (r && r.reject) return Promise.reject(r.reject);
    return Promise.resolve(r);
  };
  fn.calls = calls;
  return fn;
}

function ok200(content) {
  return {
    statusCode: 200,
    body: JSON.stringify({ choices: [{ message: { content: content } }] })
  };
}

function build(overrides) {
  const opts = {
    config: mh.readConfig(ENV),
    prompt: PROMPT,
    image: IMAGE
  };
  Object.keys(overrides || {}).forEach(function (k) { opts[k] = overrides[k]; });
  return mh.createHttpCallModel(opts);
}

/**
 * 调一次，把「正常返回」和「抛错」都收成同一个形状。
 *
 * 直接 await 一个会抛错的调用，结果是**整个套件崩掉**（看不到是哪一条红，
 * 只看到脚本挂了）—— 那比一条变红的断言难查得多。所以这里统一接住。
 */
async function tryCall(callModel) {
  try {
    return { ok: true, text: await callModel(1) };
  } catch (err) {
    return { ok: false, msg: err && err.message };
  }
}

async function main() {
  // 一次正常返回
  {
    const post = makePost(function () { return ok200('{"annotations": []}'); });
    const r = await tryCall(build({ httpPost: post }));
    suite.eq('200 时把模型说的话原样带回来（解析是 defense 的事）', r.ok ? r.text : r.msg, '{"annotations": []}');

    const call = post.calls[0];
    suite.eq('拼出来的地址是「端点 + /chat/completions」', call.url, ENV.MODEL_BASE_URL + mh.CHAT_PATH);
    suite.eq('Authorization 头带上了 Bearer', call.headers.Authorization, 'Bearer ' + ENV.MODEL_API_KEY);
    suite.eq('请求体里的模型名用的是配置值', call.body.model, ENV.MODEL_NAME);

    const content = call.body.messages[0].content;
    suite.eq('消息里是两段：文字 + 图片', content.length, 2);
    suite.eq('第一段是提示词', content[0], { type: 'text', text: PROMPT });
    // detail 默认 high：输出是坐标，视觉定位精度和图的保真度直接相关（低档图被压缩过）
    suite.eq('第二段是图片地址，带默认的 high 保真档', content[1], { type: 'image_url', image_url: { url: IMAGE, detail: 'high' } });
    suite.eq('超时传给了 httpPost（自己不管超时就会耗光整个函数）', call.timeoutMs, mh.DEFAULT_TIMEOUT_MS);

    // 关思考必须真的进了请求体 —— 少发这个字段，线上就是 18 秒起跳
    suite.eq('请求体默认带 reasoning_effort: none', call.body.reasoning_effort, 'none');
  }

  // 换成不吃这个参数的模型时，字段要能整个消失（而不是发个空值过去）
  {
    const post = makePost(function () { return ok200('{}'); });
    const cfg = mh.readConfig(Object.assign({}, ENV, { MODEL_REASONING_EFFORT: '' }));
    await tryCall(mh.createHttpCallModel({ config: cfg, httpPost: post, prompt: PROMPT, image: IMAGE }));
    suite.ok(
      '配成空串时请求体里没有 reasoning_effort 字段',
      !('reasoning_effort' in post.calls[0].body)
    );
  }

  // detail 同一条规矩：不吃它的端点配成空串，image_url 里就不能出现这个字段
  {
    const post = makePost(function () { return ok200('{}'); });
    const cfg = mh.readConfig(Object.assign({}, ENV, { MODEL_IMAGE_DETAIL: '' }));
    await tryCall(mh.createHttpCallModel({ config: cfg, httpPost: post, prompt: PROMPT, image: IMAGE }));
    suite.eq(
      'MODEL_IMAGE_DETAIL 配成空串时 image_url 里没有 detail 字段',
      post.calls[0].body.messages[0].content[1].image_url,
      { url: IMAGE }
    );
  }

  {
    const post = makePost(function () { return ok200('{}'); });
    const cfg = mh.readConfig(Object.assign({}, ENV, { MODEL_IMAGE_DETAIL: 'low' }));
    await tryCall(mh.createHttpCallModel({ config: cfg, httpPost: post, prompt: PROMPT, image: IMAGE }));
    suite.eq('显式配的保真档按配的来', post.calls[0].body.messages[0].content[1].image_url.detail, 'low');
  }

  // omni 这类模型会分段返回
  {
    const post = makePost(function () {
      return ok200([{ text: '前半' }, { text: '后半' }]);
    });
    const r = await tryCall(build({ httpPost: post }));
    suite.eq('content 是数组时拼成一段（不处理会当成「模型没说话」）', r.ok ? r.text : r.msg, '前半后半');
  }

  // 403：现实里最常见的意思是免费额度用尽
  {
    const post = makePost(function () {
      return { statusCode: 403, body: '{"error":{"message":"Free quota exhausted"}}' };
    });
    let msg = '';
    try {
      await build({ httpPost: post })();
    } catch (err) {
      msg = err.message;
    }
    suite.ok('403 会抛错（不能当成成功）', msg.length > 0);
    suite.ok('错误信息里带着状态码 403（只看「调用失败」猜不到是额度问题）', msg.indexOf('403') !== -1);
    suite.ok('错误信息里带着服务端给的原文片段', msg.indexOf('Free quota exhausted') !== -1);
  }

  // 其它非 2xx
  {
    const post = makePost(function () { return { statusCode: 500, body: 'boom' }; });
    let msg = '';
    try {
      await build({ httpPost: post })();
    } catch (err) {
      msg = err.message;
    }
    suite.ok('500 也抛错，并且带上状态码', msg.indexOf('500') !== -1);
  }

  // 返回不是 JSON / 没有 content
  {
    const bad = makePost(function () { return { statusCode: 200, body: 'not json at all' }; });
    let m1 = '';
    try { await build({ httpPost: bad })(); } catch (err) { m1 = err.message; }
    suite.ok('返回的不是 JSON 时抛错，且带原文片段', m1.indexOf('not json at all') !== -1);

    const empty = makePost(function () { return { statusCode: 200, body: '{"choices":[{"message":{}}]}' }; });
    let m2 = '';
    try { await build({ httpPost: empty })(); } catch (err) { m2 = err.message; }
    suite.ok('有 choices 但没有 content 时抛错', m2.indexOf('没有文本内容') !== -1);
  }

  // 网络层直接报错（超时/域名不通）
  {
    const post = makePost(function () { return { reject: new Error('模型请求超时（20000ms）') }; });
    let msg = '';
    try { await build({ httpPost: post })(); } catch (err) { msg = err.message; }
    suite.eq('网络层的错误原样透传（不许吞掉换一句含糊的话）', msg, '模型请求超时（20000ms）');
  }

  // 没配齐时不许发请求
  {
    const post = makePost(function () { return ok200('{}'); });
    let msg = '';
    try {
      await mh.createHttpCallModel({ httpPost: post, prompt: PROMPT, imageUrl: IMAGE })();
    } catch (err) {
      msg = err.message;
    }
    suite.ok('没配齐环境变量时明确报错', msg.indexOf('MODEL_') !== -1);
    suite.eq('并且一次请求都没发出去（也没悄悄退回别的地方）', post.calls.length, 0);
  }

  // 超时值必须塞得进函数的 60 秒上限
  suite.ok(
    '默认超时不超过 55 秒（给换链接和写日志留余量，实测 ' + mh.DEFAULT_TIMEOUT_MS + 'ms）',
    mh.DEFAULT_TIMEOUT_MS <= 55000 && mh.DEFAULT_TIMEOUT_MS > 0
  );

  // ---------- 和 defense 接起来 ----------

  {
    const post = makePost(function () { return ok200('{"annotations": [{"patternId":"A1"}]}'); });
    const r = await defense.runDetect({
      callModel: build({ httpPost: post }),
      maxAttempts: 1,
      log: function () {}
    });
    suite.eq('配上之后能跑通整条梯子', r.source, 'model');
    suite.eq('标注原样带回（严格校验在客户端）', r.annotations.length, 1);
  }

  {
    const post = makePost(function () { return { statusCode: 403, body: 'quota' }; });
    const logs = [];
    const r = await defense.runDetect({
      callModel: build({ httpPost: post }),
      maxAttempts: 1,
      log: function (level, message, detail) { logs.push({ level: level, message: message, detail: detail }); }
    });
    suite.eq('403 时走诚实失败，不假装成功', r.source, 'fallback');
    suite.eq('并且给空数组，不伪造标注', r.annotations, []);
    suite.ok(
      '403 的细节进了日志（真机上排查全靠它）',
      logs.some(function (l) { return l.level === 'error' && l.message.indexOf('403') !== -1; })
    );
  }

  suite.done();
}

main().catch(function (err) {
  console.error('check-model-http.js 自己崩了：', err);
  process.exit(1);
});
