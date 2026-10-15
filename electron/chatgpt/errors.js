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
  permission_denied: 'ChatGPT plan access is restricted by policy, region, or permission. Check your account and integration settings.',
  subscription_sharing_user_not_eligible: 'This account or workspace is not eligible for ChatGPT plan usage.',
  subscription_sharing_unsupported_capability: 'This request uses a capability unsupported by ChatGPT plan usage.',
  subscription_sharing_route_not_supported: 'This ChatGPT plan endpoint is unsupported. Check the integration configuration.',
  authorization_context_invalid: 'The ChatGPT permission context does not authorize this operation. Check the client and grant configuration.',
  invalid_client: 'The ChatGPT client registration is invalid. Check the integration configuration.',
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
  if (['subscription_sharing_user_not_eligible', 'subscription_sharing_unsupported_capability', 'subscription_sharing_route_not_supported', 'invalid_client'].includes(code)) return new ChatGPTError(code, status);
  if (['chatpass_v2_scope_not_authorized', 'chatpass_v2_invalid_authorization_context'].includes(code)) return new ChatGPTError('authorization_context_invalid', status);
  if (code === 'subscription_sharing_user_unavailable') return new ChatGPTError('service_unavailable', status);
  if (['invalid_grant', 'invalid_token', 'login_required', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused'].includes(code) || status === 401) return new ChatGPTError('sign_in_required', status);
  if (status === 403) return new ChatGPTError('permission_denied', status);
  if (status === 429) return new ChatGPTError('rate_limited', status);
  if (status >= 500) return new ChatGPTError('service_unavailable', status);
  if (code === 'model_not_found' || status === 404) return new ChatGPTError('model_unavailable', status);
  return new ChatGPTError('invalid_request', status);
}
