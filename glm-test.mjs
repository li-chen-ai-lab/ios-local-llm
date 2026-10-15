export const MODEL = 'glm-4.5-flash';
export const FREE_MODELS = [MODEL];
export const ENDPOINT = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
export const PERSONA = '你叫阿砾，是幽默温柔的聊天伙伴。用自然中文口语回复，通常不超过50字，避免说教；记清人物与物品。';

// Keep complete successful pairs only. This is a small history limit, not a token estimate.
export function buildRequest(history, prompt, model = MODEL) {
  if (!FREE_MODELS.includes(model)) throw new Error('只允许选择列表内的免费型号。');
  const text = prompt.trim();
  if (!text || [...text].length > 500) throw new Error('请输入1～500字的问题。');
  const pairs = history.filter(pair => typeof pair?.user === 'string' && typeof pair?.assistant === 'string' && (pair.model ?? MODEL) === model).slice(-2);
  return {
    model, stream: false, ...(model === 'glm-4-flash-250414' ? {} : { thinking: { type: 'disabled' } }), max_tokens: 128,
    messages: [{ role: 'system', content: PERSONA }, ...pairs.flatMap(pair => [
      { role: 'user', content: pair.user }, { role: 'assistant', content: pair.assistant },
    ]), { role: 'user', content: text }],
  };
}

function apiError(status, code) {
  if (status === 429 && code === '1302') return 'HTTP 429 · 智谱1302：账号触发速率或并发限制。建议先等待60秒，再手动发送；不会自动重试或切换模型。';
  if (status === 429 && code === '1305') return 'HTTP 429 · 智谱1305：模型服务当前过载。请稍后手动重试；不代表已经扣费，也不会切换模型。';
  if (status === 401) return 'HTTP 401：密钥无效或已失效。请在智谱控制台确认，并重新粘贴完整密钥。';
  if (status === 403) return 'HTTP 403：账号或模型权限不足，请查看智谱控制台；不会改用收费模型。';
  if (status === 429) return 'HTTP 429：触发限流或账号用量限制。请稍后手动重试，不会自动重复请求。';
  return `HTTP ${status}：智谱未完成本次请求。请检查账号状态及免费模型权限，不会自动重试。`;
}

export async function requestReply(key, body, { signal, fetchImpl = fetch } = {}) {
  const secret = key.trim();
  if (!secret || /\s/.test(secret)) throw new Error('请填写完整的智谱 API Key，不要包含空格或换行。');
  if (!FREE_MODELS.includes(body.model)) throw new Error('本测试只允许选择列表内的免费型号。');
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
  if (!response.ok) {
    // Only expose a short numeric code; provider messages can contain sensitive text.
    let providerCode = null;
    try { const data = await response.json(); const code = String(data?.error?.code ?? ''); if (/^\d{3,6}$/.test(code)) providerCode = code; } catch { /* no readable code */ }
    const described = response.status === 429 && ['1302', '1305'].includes(providerCode);
    const suffix = providerCode && !described ? `（智谱错误码 ${providerCode}）` : '';
    throw Object.assign(new Error(apiError(response.status, providerCode) + suffix), { httpStatus: response.status, providerCode });
  }
  let data;
  try { data = await response.json(); } catch { throw new Error('智谱返回了无法解析的响应。'); }
  const choice = data?.choices?.[0];
  const text = choice?.message?.content;
  if (typeof text !== 'string' || !text.trim()) throw new Error('智谱未返回有效文本。请稍后手动重试；不会自动增加输出上限。');
  const finite = n => Number.isFinite(n) && n >= 0 ? n : null;
  return {
    text, requestedModel: body.model,
    returnedModel: typeof data.model === 'string' && /^glm[-a-zA-Z0-9_.]{1,80}$/.test(data.model) ? data.model : null,
    finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : null,
    usage: {
      promptTokens: finite(data.usage?.prompt_tokens), completionTokens: finite(data.usage?.completion_tokens),
      totalTokens: finite(data.usage?.total_tokens), reasoningTokens: finite(data.usage?.completion_tokens_details?.reasoning_tokens),
    },
  };
}

export function safeReport(history, records, secret = '', selectedModel = MODEL) {
  const report = JSON.stringify({ schemaVersion: 1, experiment: 'glm-free-api-test', exportedAt: new Date().toISOString(),
    model: selectedModel, allowedFreeModels: FREE_MODELS, inference: '智谱云端，需要联网', maxOutputTokens: 128, retainedPreviousRounds: 2,
    firstTokenLatency: '无法测量：此最小测试使用非流式回复', history, records }, null, 2);
  return secret.trim() ? report.split(secret.trim()).join('[密钥已移除]') : report;
}

if (typeof document !== 'undefined') {
  const el = id => document.getElementById(id);
  const key = el('api-key'), prompt = el('prompt'), send = el('send'), cancel = el('cancel'), model = el('model');
  const status = el('status'), chat = el('chat');
  let history = [], records = [], active = null;
  const showStatus = (text, error = false) => { status.textContent = text; status.dataset.error = String(error); };
  const render = pending => {
    chat.replaceChildren();
    const messages = history.filter(pair => pair.model === model.value).flatMap(pair => [{ role: 'user', text: pair.user }, { role: 'assistant', text: pair.assistant }]);
    if (pending) messages.push({ role: 'user', text: pending });
    for (const message of messages) {
      const article = document.createElement('article'), name = document.createElement('strong'), text = document.createElement('p');
      article.className = message.role; name.textContent = message.role === 'user' ? '你' : '阿砾 · 智谱云端';
      text.textContent = message.text; article.append(name, text); chat.append(article);
    }
  };
  model.addEventListener('change', () => {
    render(); showStatus(`已选择 ${model.value}，尚未发送。每个模型只使用自己的最近2轮上下文。`);
    el('usage').textContent = `当前型号：${model.value}。切换不会自动请求；各模型的测试统计保留在导出结果中。`;
  });
  el('examples').addEventListener('click', event => {
    if (event.target instanceof HTMLButtonElement && !active) { prompt.value = event.target.dataset.prompt || ''; prompt.focus(); }
  });
  cancel.addEventListener('click', () => active?.abort());
  send.addEventListener('click', async () => {
    if (active) return;
    let body;
    try { body = buildRequest(history, prompt.value, model.value); if (!key.value.trim()) throw new Error('请先在上方填写智谱 API Key。'); }
    catch (error) { showStatus(error.message, true); return; }
    const text = prompt.value.trim(), secret = key.value.trim(), controller = new AbortController();
    active = controller; send.disabled = true; cancel.disabled = false; prompt.disabled = true; key.disabled = true; model.disabled = true;
    for (const id of ['clear', 'export']) el(id).disabled = true;
    const started = performance.now();
    const update = () => showStatus(`已发送给智谱，等待回复… ${Math.floor((performance.now() - started) / 1000)}秒。最多等待60秒；可以取消。`);
    update(); render(text);
    const clock = setInterval(update, 1000);
    const timeout = setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), 60000);
    try {
      const reply = await requestReply(secret, body, { signal: controller.signal });
      history.push({ model: body.model, user: text, assistant: reply.text }); history = history.slice(-50);
      const elapsedMs = Math.round(performance.now() - started);
      records.push({ ok: true, at: new Date().toISOString(), elapsedMs, requestedModel: reply.requestedModel, returnedModel: reply.returnedModel, retainedPreviousRounds: (body.messages.length - 2) / 2, ...reply.usage, finishReason: reply.finishReason });
      prompt.value = '';
      const value = n => n === null ? '无法测量' : String(n);
      el('usage').textContent = `请求型号：${reply.requestedModel}\n服务端返回型号：${reply.returnedModel ?? '未提供，需查看智谱控制台'}\n本次耗时 ${(elapsedMs / 1000).toFixed(2)}秒；输入 ${value(reply.usage.promptTokens)} / 输出 ${value(reply.usage.completionTokens)} / 合计 ${value(reply.usage.totalTokens)} tokens。Token数是用量，不是扣款金额；实际费用以智谱控制台账单为准。`;
      showStatus(reply.finishReason === 'length' ? '已收到回复，但达到128 tokens上限，可能被截断。' : '已收到智谱回复。没有后台续聊或额外记忆请求。');
    } catch (error) {
      records.push({ ok: false, at: new Date().toISOString(), requestedModel: body.model, httpStatus: error.httpStatus ?? null, providerCode: error.providerCode ?? null, elapsedMs: Math.round(performance.now() - started), error: error.message });
      el('usage').textContent = `本次请求型号：${body.model}。未获得本次Token用量；不沿用上一条回复的统计。实际费用以智谱控制台账单为准。`;
      showStatus(error.message, true);
    } finally {
      clearInterval(clock); clearTimeout(timeout); active = null;
      records = records.slice(-100); send.disabled = false; cancel.disabled = true; prompt.disabled = false; key.disabled = false; model.disabled = false;
      for (const id of ['clear', 'export']) el(id).disabled = false;
      render();
    }
  });
  el('clear').addEventListener('click', () => { history = []; records = []; render(); el('usage').textContent = '本次聊天与统计已清空。'; showStatus('聊天已清空。下次发送只包含人设和你的新问题。'); });
  el('export').addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([safeReport(history, records, key.value, model.value)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'glm-free-api-test.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  addEventListener('pagehide', () => { key.value = ''; active?.abort(); });
}
