import { RESOURCE } from './oauth.js';
import { ChatGPTError, responseError, fetchResponse } from './errors.js';

// Endpoint, credential, storage and streaming policy are owned by main, never IPC.
export async function apiRequest(path, access, { fetchImpl = fetch, signal, body, onResponse } = {}) {
  const response = await fetchResponse(fetchImpl, `${RESOURCE}/${path}`, {
    method: body ? 'POST' : 'GET', redirect: 'error', signal,
    headers: { Authorization: `Bearer ${access}`, ...(body ? { 'Content-Type': 'application/json', Accept: 'text/event-stream' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  onResponse?.(response);
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw responseError(data.error?.code, response.status);
  }
  return response;
}

export function buildRequest(request, model) {
  if (!request || typeof request !== 'object' || !Array.isArray(request.history)
      || request.history.length > 2000 || typeof request.systemPrompt !== 'string'
      || JSON.stringify(request).length > 4_000_000) throw new ChatGPTError('invalid_request');
  const input = [];
  for (const message of request.history) {
    if (message.role === 'model' && Array.isArray(message.chatgptItems)) {
      // Responses reasoning models need the returned reasoning items alongside
      // their tool calls when store:false. These are opaque model output, not
      // credentials; replay only the supported output item kinds.
      for (const item of message.chatgptItems) {
        if (!['reasoning', 'function_call', 'message'].includes(item?.type)) throw new ChatGPTError('invalid_request');
        input.push(item);
      }
      continue;
    }
    for (const part of message.parts || []) {
      if (typeof part.text === 'string') input.push({ role: message.role === 'model' ? 'assistant' : 'user', content: part.text });
      else if (part.functionCall) input.push({ type: 'function_call', namespace: 'open_historia', call_id: part.functionCall.id, name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args || {}) });
      else if (part.functionResponse) input.push({ type: 'function_call_output', call_id: part.functionResponse.id, output: JSON.stringify(part.functionResponse.response ?? null) });
    }
  }
  const declarations = [request.tool, ...(request.requireOutputTool ? [] : request.lookupTools || [])].filter(Boolean);
  if (declarations.some(tool => !/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name) || !tool.schema || typeof tool.schema !== 'object')) throw new ChatGPTError('invalid_request');
  const tools = declarations.map(tool => ({ type: 'function', name: tool.name, description: tool.description || '', parameters: tool.schema, strict: false }));
  return {
    model, instructions: request.systemPrompt, input, store: false, stream: true, include: ["reasoning.encrypted_content"],
    ...(tools.length ? { tools: [{ type: 'namespace', name: 'open_historia', description: 'Open Historia game output and lookups', tools }], tool_choice: 'required', parallel_tool_calls: false } : {}),
    // ChatGPT plan usage rejects max_output_tokens, even when an API-key
    // provider's saved settings include a positive maxTokens value.
  };
}

export async function consumeResponse(response, onEvent = () => {}) {
  const contentType = response.headers.get('content-type');
  if (!response.body || (contentType !== null && contentType.split(';')[0].trim().toLowerCase() !== 'text/event-stream')) {
    await response.body?.cancel().catch(() => {});
    throw new ChatGPTError('incomplete', undefined, 'invalid_stream');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', dataLines = [], completed, total = 0;
  const items = new Map(), textItems = new Map();
  const dispatch = () => {
    if (!dataLines.length) return;
    const data = dataLines.join('\n'); dataLines = [];
    if (data === '[DONE]') return;
    let event;
    try { event = JSON.parse(data); } catch { throw new ChatGPTError('incomplete', undefined, 'malformed_event'); }
    onEvent({ type: 'activity' });
    if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
      const index = Number.isInteger(event.output_index) ? event.output_index : 0;
      const contentIndex = Number.isInteger(event.content_index) ? event.content_index : 0;
      const parts = textItems.get(index) || new Map();
      parts.set(contentIndex, (parts.get(contentIndex) || '') + event.delta); textItems.set(index, parts);
      onEvent({ type: 'delta', delta: event.delta });
    }
    if (event.type === 'response.output_item.done' && event.item && typeof event.item === 'object') {
      items.set(Number.isInteger(event.output_index) ? event.output_index : items.size, event.item);
    }
    if (event.type === 'response.function_call_arguments.delta' && typeof event.delta === 'string') onEvent({ type: 'toolDelta', delta: event.delta });
    if (event.type === 'response.failed' || event.type === 'error') throw responseError(event.response?.error?.code || event.code || event.error?.code);
    if (event.type === 'response.incomplete') throw new ChatGPTError('incomplete', undefined, 'service_incomplete');
    if (event.type === 'response.completed') {
      if (event.response?.status !== undefined && event.response.status !== 'completed') throw new ChatGPTError('incomplete', undefined, 'service_incomplete');
      // The completion event is the commit boundary. Some direct-route streams
      // omit its output payload; retain completed items and text deltas just as
      // the reference client does, but never promote them without this event.
      for (const [index, parts] of textItems) {
        if (!items.has(index)) items.set(index, { type: 'message', content: [...parts].sort(([a], [b]) => a - b)
          .map(([, text]) => ({ type: 'output_text', text })) });
      }
      completed = { ...event.response, status: 'completed', output: event.response?.output?.length
        ? event.response.output : [...items].sort(([a], [b]) => a - b).map(([, item]) => item) };
    }
  };
  try {
    while (!completed) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      total += value?.length || 0;
      if (buffer.length > 8_000_000 || total > 32_000_000) throw new ChatGPTError('incomplete');
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, ''); buffer = buffer.slice(newline + 1);
        if (!line) dispatch();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
      }
      if (done) break;
    }
    if (!completed) throw new ChatGPTError('incomplete', undefined, 'missing_completion');
    return completed;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export function gameResult(response, outputTool) {
  const calls = (response.output || []).filter(item => item.type === 'function_call');
  const output = calls.find(item => item.name === outputTool);
  // Never commit final game state alongside unexecuted lookups (or competing
  // final outputs), even if a service ignores parallel_tool_calls:false.
  if (output && calls.length !== 1) throw new ChatGPTError('incomplete');
  let toolInput = null;
  if (output) {
    try { toolInput = JSON.parse(output.arguments); } catch { throw new ChatGPTError('incomplete'); }
  }
  const lookupCalls = calls.filter(item => item.name !== outputTool).map(item => {
    let args;
    try { args = JSON.parse(item.arguments); } catch { throw new ChatGPTError('incomplete'); }
    return { id: item.call_id, name: item.name, args };
  });
  if (lookupCalls.length && response.output?.some(item => item.type === 'reasoning' || item.namespace)) {
    lookupCalls[0].chatgptItems = response.output.filter(item => ['reasoning', 'function_call', 'message'].includes(item.type));
  }
  const rawText = (response.output || []).filter(item => item.type === 'message')
    .flatMap(item => item.content || []).filter(part => part.type === 'output_text').map(part => part.text).join('');
  if (!rawText && !output && !lookupCalls.length) throw new ChatGPTError('incomplete', undefined, 'empty_output');
  return { rawText, toolInput, ...(lookupCalls.length ? { lookupCalls } : {}) };
}
