# Desktop ChatGPT plan integration

Open Historia's Electron builds offer **Continue with ChatGPT** in first-run AI setup and **ChatGPT plan** in Settings → AI → Models. Use an eligible account and grant plan usage. Model choices come from that account. Manage usage opens https://chatgpt.com/settings/usage. Limits follow the account's plan and settings; this feature does not promise a fixed weekly allowance. It does not read ChatGPT conversations.

## Implementation and scope

- Main-process code: `electron/chatgpt/`. The independent implementation follows the public registration, accounts, and Responses API protocols linked below. It does not redistribute the devkit's separately licensed SDK. `jose` 6.1.3 verifies ID tokens.
- The sandboxed game preload exposes named actions, safe account metadata, and request progress. Main validates the owning window, main frame, and exact local origin on every IPC invocation. There are no HTTP authentication/inference routes on the shared web server.
- First registration uses a persisted host UUID and `dynamic_agent_client`, then saves the issued client ID before code exchange. Returning authorization reuses that registration. State, nonce, PKCE, signature, issuer, audience, expiry, and returning subject are checked.
- Each account registration has its own credentials and label, even when email addresses match. Only opaque profile IDs are saved with game provider settings. Tokens remain in `userData/chatgpt/accounts.enc`, encrypted with Electron `safeStorage`; Linux's insecure `basic_text` backend is rejected. Files are replaced atomically with owner-only permissions on Unix. A missing/unlocked keyring never triggers plaintext fallback or overwrites an unreadable file.
- Electron's existing single-instance lock and the main-process queue serialize refreshes. Received refresh rotations are checkpointed before identity validation. Transient key-server failures preserve the checkpoint for recovery. Account changes cancel active requests. Sign-out attempts remote revocation, clears local tokens, and reports unconfirmed revocation.
- Requests use only public `/v1/models` and `/v1/responses`, with `store:false` and streaming. Model availability is checked with the request's own account. Structured game output and lookup tool rounds use Responses function calls; encrypted reasoning items are replayed for stateless lookup continuations. Only `response.completed` commits a result. Malformed, interrupted, failed, or incomplete streams fail the call. Plan-limit errors do not silently fall through to an API-key provider.
- The model's advanced custom-parameter controls are hidden for ChatGPT connections; requests use the integration's supported parameters. Output-tool arguments are consumed on completion rather than progressively applied to game state.
- Website and Android builds compile out the desktop account UI and transport. The catalog additionally requires the real preload capability. Existing API-key providers remain available. Shared frontend changes provide the desktop hooks; no website server, deployment, or website-specific source is changed.

## Validation

Run `node --test server/chatgptDesktop.test.js src/desktop/*.test.js`, `npm test`, `npm run build`, and `npm run build:web`. Check the web output contains no `ohChatGPT`, `Continue with ChatGPT`, OAuth endpoints, or desktop ChatGPT chunks. The normal web build requires `scripts/seed-web-defaults.mjs`; its generated files are ignored by git.

Before publishing a release, verify on each target OS:

1. Install the packaged app. Check the sandboxed preload loads, ordinary gameplay opens, and the OS credential store is available (Linux needs a supported keyring).
2. Use an eligible real account to sign in, approve plan usage, load available models, and complete an advisor message and a structured time skip with lookup calls. Confirm usage in ChatGPT Settings. A connected badge alone is not sufficient.
3. Restart and repeat a request; verify no API key is required. Exercise refresh after token expiry, account switching, consent denial, cancellation, and reconnect.
4. Sign out during a request; verify it stops and local credentials are removed. Test unavailable network, exhausted allowance, and remote access revocation; check recovery messages and absence of silent API-key fallback.
5. Build/install Windows, macOS, and Linux distributions using the existing desktop workflows. Confirm the new main-process modules, preload, and production `jose` dependency are packaged. Verify application signing/notarization according to the existing release policy.

These real-account and OS checks cannot be replaced by mocked OAuth or Chromium component tests. Do not publish solely on the automated tests described here.

## References

- https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt
- https://developers.openai.com/siwc/token-sharing-open-source/sign-in
- https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions
- https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
