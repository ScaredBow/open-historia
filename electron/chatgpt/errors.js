// Desktop-only errors: never forward OAuth responses, URLs or tokens to logs/IPC.
const messages = {
  cancelled: 'ChatGPT request cancelled.',
  busy: 'Finish the current ChatGPT account change first.',
  storage_unavailable: 'Unlock your operating system credential store to use ChatGPT sign-in.',
  storage_invalid: 'The saved ChatGPT connection could not be read. Unlock the credential store and restart; your saved file has been preserved.',
  sign_in_required: 'Sign in with ChatGPT in Settings to continue.',
  sharing_not_enabled: 'Allow ChatGPT plan usage for Open Historia in ChatGPT Settings, then reconnect.',
  invalid_identity: 'ChatGPT identity verification failed. Please sign in again.',
  invalid_callback: 'The ChatGPT sign-in callback was invalid. Please try again.',
  access_denied: 'ChatGPT sign-in was declined. You can try again when ready.',
  network: 'Could not reach ChatGPT. Check your connection and try again.',
  incomplete: 'ChatGPT did not complete the response. No partial result was accepted.',
  invalid_request: 'The ChatGPT request was invalid.',
  model_unavailable: 'This model is unavailable for the selected ChatGPT account. Refresh models in Settings.',
  subscription_sharing_usage_limit_exceeded: 'Your ChatGPT plan usage limit has been reached. Open Manage usage in Settings.',
  subscription_sharing_usage_unavailable: 'ChatGPT plan usage is unavailable. Open Manage usage in Settings.',
  rate_limited: 'ChatGPT is rate limited. Please try again later.',
  service_unavailable: 'ChatGPT is temporarily unavailable. Please try again later.',
};
export class ChatGPTError extends Error {
  constructor(code, status) {
    super(messages[code] || 'ChatGPT could not complete the request. Reconnect in Settings if it persists.');
    this.name = 'ChatGPTError'; this.code = code; this.status = status;
  }
}
export function safeError(error) {
  const safe = error instanceof ChatGPTError ? error : new ChatGPTError(error?.name === 'AbortError' || error?.name === 'TimeoutError' ? 'cancelled' : 'network');
  return { code: safe.code, message: safe.message, status: safe.status };
}
export function responseError(code, status) {
  if (['subscription_sharing_usage_limit_exceeded', 'subscription_sharing_usage_unavailable'].includes(code)) return new ChatGPTError(code, status);
  if (['invalid_grant', 'invalid_token', 'login_required'].includes(code) || status === 401) return new ChatGPTError('sign_in_required', status);
  if (status === 403) return new ChatGPTError('sharing_not_enabled', status);
  if (status === 429) return new ChatGPTError('rate_limited', status);
  if (status >= 500) return new ChatGPTError('service_unavailable', status);
  if (code === 'model_not_found' || status === 404) return new ChatGPTError('model_unavailable', status);
  return new ChatGPTError('invalid_request', status);
}
