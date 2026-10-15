export async function unwrap(promise) {
  const response = await promise;
  if (!response?.ok) {
    const error = new Error(response?.error?.message || 'ChatGPT connection unavailable.');
    error.code = response?.error?.code;
    if (error.code === 'cancelled') error.name = 'AbortError';
    // Plan limits never silently fall through to a paid API-key provider.
    throw error;
  }
  return response.value;
}

export async function callChatGPT(systemPrompt, history, opts = {}) {
  const bridge = globalThis.window?.ohChatGPT;
  if (!bridge) throw new Error('ChatGPT sign-in is available only in a supported local app.');
  const id = crypto.randomUUID();
  opts.signal?.throwIfAborted();
  let full = "";
  const unsubscribe = bridge.onEvent(event => {
    if (event.id !== id) return;
    if (event.type === 'activity') opts.onActivity?.();
    if (event.type === 'delta') { full += event.delta; try { opts.onChunk?.(event.delta, full); } catch { /* A preview cannot interrupt inference. */ } }
    if (event.type === 'request') opts.onRequest?.(event.status);
    // Output tool arguments are interpreted only from the completed response;
    // lookup argument deltas must never be applied as game-state updates.
  });
  const cancel = () => { void bridge.cancel(id); };
  try {
    const pending = bridge.infer(id, {
      profileId: opts.entrySettings?.chatgptProfileId,
      model: opts.entrySettings?.model || '', systemPrompt, history,
      tool: opts.tool, lookupTools: opts.lookupTools,
      requireOutputTool: opts.requireOutputTool === true,
      maxTokens: opts.maxTokens,
    });
    opts.signal?.addEventListener('abort', cancel, { once: true });
    if (opts.signal?.aborted) cancel();
    const response = await unwrap(pending);
    opts.signal?.throwIfAborted();
    if (response.usage) opts.onUsage?.({ usage: {
      prompt_tokens: response.usage.input_tokens, completion_tokens: response.usage.output_tokens,
      total_tokens: response.usage.total_tokens, prompt_tokens_details: response.usage.input_tokens_details,
    } });
    return opts.tool ? response.result : response.result.rawText;
  } finally { unsubscribe(); opts.signal?.removeEventListener('abort', cancel); }
}
