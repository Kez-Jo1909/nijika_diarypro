// OpenAI 兼容的 /chat/completions。
// baseUrl 填服务商或中转站给的地址，末尾有没有 /v1 都可以。

export function chatCompletionsUrl(baseUrl) {
  const trimmed = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("还没填接口地址");
  if (/\/chat\/completions$/i.test(trimmed)) return trimmed;
  return `${trimmed}/chat/completions`;
}

function errorMessage(status, bodyText) {
  try {
    const parsed = JSON.parse(bodyText);
    const msg = parsed.error?.message || parsed.message;
    if (msg) return `${status} ${msg}`;
  } catch {
    // 中转站有时直接回一段 HTML 或纯文本
  }
  const snippet = bodyText.replace(/\s+/g, " ").slice(0, 180);
  return snippet ? `${status} ${snippet}` : `请求失败（${status}）`;
}

function readPart(part) {
  if (typeof part === "string") return part;
  if (Array.isArray(part)) {
    return part.map((item) => item?.text || item?.content || "").join("");
  }
  return "";
}

function tryJson(text) {
  try {
    const value = JSON.parse(text);
    if (value && typeof value === "object") return value;
  } catch {
    // 后面还有别的拆法，这里先不算失败
  }
  return null;
}

function looksLikeSse(text) {
  return /^data:/m.test(text);
}

// 不少中转站无视 stream:false，HTTP 200 时仍按 SSE 吐 data: {...}。
function assembleSse(text) {
  let content = "";
  let reasoning = "";
  let last = null;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    const obj = tryJson(payload);
    if (!obj) continue;
    last = obj;
    const choice = obj.choices?.[0];
    const delta = choice?.delta || choice?.message;
    if (delta) {
      content += readPart(delta.content);
      reasoning += readPart(delta.reasoning_content);
    }
    if (typeof choice?.text === "string") content += choice.text;
  }
  if ((content || reasoning).trim()) {
    return { choices: [{ message: { content, reasoning_content: reasoning } }] };
  }
  if (last) return last;
  throw new Error("接口按流式返回了，但没有读到正文");
}

export function parseCompletionBody(bodyText, contentType = "") {
  const text = String(bodyText || "").replace(/^\uFEFF/, "").trim();
  if (!text) throw new Error("接口返回是空的");

  if (/text\/event-stream/i.test(contentType) || looksLikeSse(text)) {
    return assembleSse(text);
  }

  const direct = tryJson(text);
  if (direct) return direct;

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const sliced = tryJson(text.slice(start, end + 1));
    if (sliced) return sliced;
  }

  if (/<!doctype html|<html[\s>]/i.test(text)) {
    throw new Error("接口返回了一张网页，不是聊天数据。地址应填中转站文档里的 API 根路径，一般以 /v1 结尾，不要填网站首页。");
  }

  const snippet = text.replace(/\s+/g, " ").slice(0, 140);
  throw new Error(`接口返回的不是 JSON：${snippet}`);
}

function extractText(data) {
  const root = data?.data?.choices ? data.data : data;
  if (root?.error) {
    const msg = root.error.message || root.error.msg || root.error;
    throw new Error(typeof msg === "string" ? msg : "接口返回了错误");
  }
  const choice = root?.choices?.[0];
  if (!choice) return "";
  const message = choice.message || choice.delta || {};
  const content = readPart(message.content).trim();
  if (content) return content;
  // 少数中转把正文放在 reasoning_content，内容为空时再看一眼
  const reasoning = readPart(message.reasoning_content).trim();
  if (reasoning) return reasoning;
  if (typeof choice.text === "string" && choice.text.trim()) return choice.text;
  return "";
}

async function postCompletion(url, apiKey, body) {
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(body)
    });
  } catch (err) {
    const failed = new Error(
      "浏览器没有拿到接口响应。多半是中转站没放行 http://localhost:8080 的跨域，或地址/网络不通。"
    );
    failed.cause = err;
    throw failed;
  }

  const bodyText = await response.text();
  if (!response.ok) {
    const message = errorMessage(response.status, bodyText);
    // 新一点的模型只认 max_completion_tokens，老接口只认 max_tokens。错了就换一次。
    if (body.max_tokens && /max_tokens|unsupported/i.test(message) && !body.max_completion_tokens) {
      const retry = { ...body, max_completion_tokens: body.max_tokens };
      delete retry.max_tokens;
      return postCompletion(url, apiKey, retry);
    }
    throw new Error(message);
  }

  return parseCompletionBody(bodyText, response.headers.get("content-type") || "");
}

export async function completeChat({ baseUrl, apiKey, model, messages, temperature, maxTokens }) {
  if (!apiKey || !String(apiKey).trim()) throw new Error("还没填 API 密钥");
  if (!model || !String(model).trim()) throw new Error("还没填模型名");

  const data = await postCompletion(chatCompletionsUrl(baseUrl), apiKey.trim(), {
    model: model.trim(),
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: false
  });

  const text = extractText(data).trim();
  if (!text) throw new Error("模型没有返回内容");
  return text;
}

export function parseJsonObject(text) {
  const trimmed = String(text).trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : trimmed;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("模型没有返回 JSON");
  return JSON.parse(raw.slice(start, end + 1));
}

export function dateContext(now = new Date()) {
  const week = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"][now.getDay()];
  const month = now.getMonth() + 1;
  const day = now.getDate();
  let season = "冬天";
  if (month >= 3 && month <= 5) season = "春天";
  else if (month >= 6 && month <= 8) season = "夏天";
  else if (month >= 9 && month <= 11) season = "秋天";

  const notes = [];
  if (month === 2 && day === 21) notes.push("今天是虹夏的生日（2月21日）");
  if (month === 3 && day === 13) notes.push("今天是结束乐队成立日（3月13日）");
  if (month === 7 && day === 27) notes.push("今天是结束乐队成立一周年（7月27日）");

  return { week, month, day, season, notes };
}
