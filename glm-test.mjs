export const MODEL = 'glm-4.7-flash';
export const ENDPOINT = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
export const PERSONA = '你叫阿砾，是幽默温柔的聊天伙伴。用自然中文口语回复，通常不超过50字，避免说教；记清人物与物品。';

// Keep complete successful pairs only. This is a small history limit, not a token estimate.
export function buildRequest(history, prompt) {
  const text = prompt.trim();
  if (!text || [...text].length > 500) throw new Error('请输入1～500字的问题。');
  const pairs = history.filter(pair => typeof pair?.user === 'string' && typeof pair?.assistant === 'string').slice(-2);
  return {
    model: MODEL, stream: false, thinking: { type: 'disabled' }, max_tokens: 128,
    messages: [{ role: 'system', content: PERSONA }, ...pairs.flatMap(pair => [
      { role: 'user', content: pair.user }, { role: 'assistant', content: pair.assistant },
    ]), { role: 'user', content: text }],
  };
}

function apiError(status) {
  if (status === 401) return 'HTTP 401：密钥无效或已失效。请在智谱控制台确认，并重新粘贴完整密钥。';
  if (status === 403) return 'HTTP 403：账号或模型权限不足，请查看智谱控制台；不会改用收费模型。';
  if (status === 429) return 'HTTP 429：触发限流或账号用量限制。请稍后手动重试，不会自动重复请求。';
  return `HTTP ${status}：智谱未完成本次请求。请检查账号状态及免费模型权限，不会自动重试。`;
}

export async function requestReply(key, body, { signal, fetchImpl = fetch } = {}) {
  const secret = key.trim();
  if (!secret || /\s/.test(secret)) throw new Error('请填写完整的智谱 API Key，不要包含空格或换行。');
  if (body.model !== MODEL) throw new Error('本测试只允许使用 glm-4.7-flash。');
  let response;
  try {
    response = await fetchImpl(ENDPOINT, {
      // Keep browser preflight minimal. This app never writes API responses to caches.
      method: 'POST', credentials: 'omit', redirect: 'error',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body: JSON.stringify(body), signal,
    });
  } catch {
    if (signal?.aborted) throw new Error(signal.reason?.name === 'TimeoutError' ? '已等待60秒，停止本机等待；智谱可能已经处理了请求。' : '已取消本机等待；智谱可能已经处理了请求。');
    throw new Error('无法连接智谱：可能是网络、跨域或服务暂不可用。请检查联网状态；不会自动重试。');
  }
  // Never put raw provider errors, headers or credentials into diagnostics.
  if (!response.ok) throw new Error(apiError(response.status));
  let data;
  try { data = await response.json(); } catch { throw new Error('智谱返回了无法解析的响应。'); }
  const choice = data?.choices?.[0];
  const text = choice?.message?.content;
  if (typeof text !== 'string' || !text.trim()) throw new Error('智谱未返回有效文本。请稍后手动重试；不会自动增加输出上限。');
  const finite = n => Number.isFinite(n) && n >= 0 ? n : null;
  return {
    text, finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : null,
    usage: {
      promptTokens: finite(data.usage?.prompt_tokens), completionTokens: finite(data.usage?.completion_tokens),
      totalTokens: finite(data.usage?.total_tokens), reasoningTokens: finite(data.usage?.completion_tokens_details?.reasoning_tokens),
    },
  };
}

export function safeReport(history, records, secret = '') {
  const report = JSON.stringify({ schemaVersion: 1, experiment: 'glm-free-api-test', exportedAt: new Date().toISOString(),
    model: MODEL, inference: '智谱云端，需要联网', maxOutputTokens: 128, retainedPreviousRounds: 2,
    firstTokenLatency: '无法测量：此最小测试使用非流式回复', history, records }, null, 2);
  return secret.trim() ? report.split(secret.trim()).join('[密钥已移除]') : report;
}

if (typeof document !== 'undefined') {
  const el = id => document.getElementById(id);
  const key = el('api-key'), prompt = el('prompt'), send = el('send'), cancel = el('cancel');
  const status = el('status'), chat = el('chat');
  let history = [], records = [], active = null;
  const showStatus = (text, error = false) => { status.textContent = text; status.dataset.error = String(error); };
  const render = pending => {
    chat.replaceChildren();
    const messages = history.flatMap(pair => [{ role: 'user', text: pair.user }, { role: 'assistant', text: pair.assistant }]);
    if (pending) messages.push({ role: 'user', text: pending });
    for (const message of messages) {
      const article = document.createElement('article'), name = document.createElement('strong'), text = document.createElement('p');
      article.className = message.role; name.textContent = message.role === 'user' ? '你' : '阿砾 · 智谱云端';
      text.textContent = message.text; article.append(name, text); chat.append(article);
    }
  };
  el('examples').addEventListener('click', event => {
    if (event.target instanceof HTMLButtonElement && !active) { prompt.value = event.target.dataset.prompt || ''; prompt.focus(); }
  });
  cancel.addEventListener('click', () => active?.abort());
  send.addEventListener('click', async () => {
    if (active) return;
    let body;
    try { body = buildRequest(history, prompt.value); if (!key.value.trim()) throw new Error('请先在上方填写智谱 API Key。'); }
    catch (error) { showStatus(error.message, true); return; }
    const text = prompt.value.trim(), secret = key.value.trim(), controller = new AbortController();
    active = controller; send.disabled = true; cancel.disabled = false; prompt.disabled = true; key.disabled = true;
    for (const id of ['clear', 'export']) el(id).disabled = true;
    const started = performance.now();
    const update = () => showStatus(`已发送给智谱，等待回复… ${Math.floor((performance.now() - started) / 1000)}秒。最多等待60秒；可以取消。`);
    update(); render(text);
    const clock = setInterval(update, 1000);
    const timeout = setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), 60000);
    try {
      const reply = await requestReply(secret, body, { signal: controller.signal });
      history.push({ user: text, assistant: reply.text }); history = history.slice(-50);
      const elapsedMs = Math.round(performance.now() - started);
      records.push({ ok: true, at: new Date().toISOString(), elapsedMs, retainedPreviousRounds: (body.messages.length - 2) / 2, ...reply.usage, finishReason: reply.finishReason });
      prompt.value = '';
      const value = n => n === null ? '无法测量' : String(n);
      el('usage').textContent = `本次耗时 ${(elapsedMs / 1000).toFixed(2)}秒；输入 ${value(reply.usage.promptTokens)} / 输出 ${value(reply.usage.completionTokens)} / 合计 ${value(reply.usage.totalTokens)} tokens。`;
      showStatus(reply.finishReason === 'length' ? '已收到回复，但达到128 tokens上限，可能被截断。' : '已收到智谱回复。没有后台续聊或额外记忆请求。');
    } catch (error) {
      records.push({ ok: false, at: new Date().toISOString(), elapsedMs: Math.round(performance.now() - started), error: error.message });
      showStatus(error.message, true);
    } finally {
      clearInterval(clock); clearTimeout(timeout); active = null;
      records = records.slice(-100); send.disabled = false; cancel.disabled = true; prompt.disabled = false; key.disabled = false;
      for (const id of ['clear', 'export']) el(id).disabled = false;
      render();
    }
  });
  el('clear').addEventListener('click', () => { history = []; records = []; render(); el('usage').textContent = '本次聊天与统计已清空。'; showStatus('聊天已清空。下次发送只包含人设和你的新问题。'); });
  el('export').addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([safeReport(history, records, key.value)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'glm-free-api-test.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  addEventListener('pagehide', () => { key.value = ''; active?.abort(); });
}
