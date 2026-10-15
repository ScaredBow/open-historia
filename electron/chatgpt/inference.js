import { RESOURCE } from './oauth.js';
import { ChatGPTError, responseError } from './errors.js';

// Endpoint, credential, storage and streaming policy are owned by main, never IPC.
export async function apiRequest(path, access, { fetchImpl = fetch, signal, body } = {}) {
  const response = await fetchImpl(`${RESOURCE}/${path}`, {
    method: body ? 'POST' : 'GET', redirect: 'error', signal,
    headers: { Authorization: `Bearer ${access}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
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
      else if (part.functionCall) input.push({ type: 'function_call', call_id: part.functionCall.id, name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args || {}) });
      else if (part.functionResponse) input.push({ type: 'function_call_output', call_id: part.functionResponse.id, output: JSON.stringify(part.functionResponse.response ?? null) });
    }
  }
  const declarations = [request.tool, ...(request.requireOutputTool ? [] : request.lookupTools || [])].filter(Boolean);
  if (declarations.some(tool => !/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name) || !tool.schema || typeof tool.schema !== 'object')) throw new ChatGPTError('invalid_request');
  const tools = declarations.map(tool => ({ type: 'function', name: tool.name, description: tool.description || '', parameters: tool.schema, strict: false }));
  return {
    model, instructions: request.systemPrompt, input, store: false, stream: true, include: ["reasoning.encrypted_content"],
    ...(tools.length ? { tools, tool_choice: request.requireOutputTool && request.tool ? { type: 'function', name: request.tool.name } : 'required', parallel_tool_calls: !request.requireOutputTool } : {}),
    // ChatGPT plan usage rejects max_output_tokens, even when an API-key
    // provider's saved settings include a positive maxTokens value.
  };
}

export async function consumeResponse(response, onEvent = () => {}) {
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw new ChatGPTError('incomplete');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', dataLines = [], completed, total = 0;
  const dispatch = () => {
    if (!dataLines.length) return;
    const data = dataLines.join('\n'); dataLines = [];
    if (data === '[DONE]') return;
    let event;
    try { event = JSON.parse(data); } catch { throw new ChatGPTError('incomplete'); }
    onEvent({ type: 'activity' });
    if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') onEvent({ type: 'delta', delta: event.delta });
    if (event.type === 'response.function_call_arguments.delta' && typeof event.delta === 'string') onEvent({ type: 'toolDelta', delta: event.delta });
    if (event.type === 'response.failed' || event.type === 'error') throw responseError(event.response?.error?.code || event.code || event.error?.code);
    if (event.type === 'response.incomplete') throw new ChatGPTError('incomplete');
    if (event.type === 'response.completed') {
      if (event.response?.status !== 'completed') throw new ChatGPTError('incomplete');
      completed = event.response;
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
    if (!completed) throw new ChatGPTError('incomplete');
    return completed;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export function gameResult(response, outputTool) {
  const calls = (response.output || []).filter(item => item.type === 'function_call');
  const output = calls.find(item => item.name === outputTool);
  let toolInput = null;
  if (output) {
    try { toolInput = JSON.parse(output.arguments); } catch { throw new ChatGPTError('incomplete'); }
  }
  const lookupCalls = calls.filter(item => item.name !== outputTool).map(item => {
    let args;
    try { args = JSON.parse(item.arguments); } catch { throw new ChatGPTError('incomplete'); }
    return { id: item.call_id, name: item.name, args };
  });
  if (lookupCalls.length && response.output?.some(item => item.type === 'reasoning')) {
    lookupCalls[0].chatgptItems = response.output.filter(item => ['reasoning', 'function_call', 'message'].includes(item.type));
  }
  const rawText = (response.output || []).filter(item => item.type === 'message')
    .flatMap(item => item.content || []).filter(part => part.type === 'output_text').map(part => part.text).join('');
  if (!rawText && !output && !lookupCalls.length) throw new ChatGPTError('incomplete');
  return { rawText, toolInput, ...(lookupCalls.length ? { lookupCalls } : {}) };
}
