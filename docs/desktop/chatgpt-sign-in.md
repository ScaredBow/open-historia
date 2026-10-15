# Desktop ChatGPT plan integration

Open Historia's Electron builds offer **Continue with ChatGPT** in first-run AI setup and **ChatGPT plan** in Settings → AI → Models. Use an eligible account and grant plan usage. Model choices come from that account. Manage usage opens https://chatgpt.com/settings/usage. Limits follow the account's plan and settings; this feature does not promise a fixed weekly allowance. It does not read ChatGPT conversations.

## Setup

1. Install a build containing this integration, or follow the [source setup](../../README.md#manual)
   and launch it with `npm run electron` after `npm run build`.
2. Choose **Continue with ChatGPT** during first-run AI setup, or open
   **Settings → AI → Models** and add a **ChatGPT plan** connection.
3. Complete sign-in in the browser and approve plan usage. Return to the app and
   select a model available to that account.
4. Send an advisor message, then try a structured time skip. A connected account
   badge confirms authentication, not successful inference.

This connection is available only in Electron, not the website, a browser opened
against the local server, or Android. Hosted ChatGPT requests require internet access.

## Troubleshooting and fallback

| Symptom | What to check |
|---|---|
| ChatGPT connection option is missing | Use the Electron window from a build containing the integration. Restart the application after updating its main-process code. |
| Credential storage is unavailable | Unlock the OS credential store. Linux requires a supported keyring; plaintext storage is intentionally unsupported. |
| Sign-in or refresh requires consent | Reconnect the affected account and approve plan usage again. |
| Allowance or usage is unavailable | Open **Manage usage** and check the account's plan/settings. These failures stop the request without selecting an API-key backup. |
| Network, service, or model unavailable | Check connectivity and the selected model. These errors may advance through your configured Fallback list, which can include paid API-key providers. |
| Response is incomplete or malformed | Retry on the current build. Save the error's logging file if it persists; partial output is never committed to game state. |
| Sign-out reports unconfirmed revocation | Local credentials have been cleared, but remote revocation could not be confirmed. Review access in your account settings. |

Generic rate limits follow the configured wait/next preference. Unexpected internal
errors and credential-write failures stop the request without selecting a backup.
When reporting an error, include the build/commit, OS, model, action attempted,
and the **Save logging file** output. Review the log for private game content before
sharing; never include tokens or the encrypted account file.

## Implementation and scope

- Main-process code: `electron/chatgpt/`. The independent implementation follows the public registration, accounts, and Responses API protocols linked below. It does not redistribute the devkit's separately licensed SDK. `jose` 6.1.3 verifies ID tokens.
- The sandboxed game preload exposes named actions, safe account metadata, and request progress. Main validates the owning window, main frame, and exact local origin on every IPC invocation. There are no HTTP authentication/inference routes on the shared web server.
- First registration uses a persisted host UUID and `dynamic_agent_client`, then saves the issued client ID before code exchange. Returning authorization reuses that registration. State, nonce, PKCE, signature, issuer, audience, expiry, and returning subject are checked.
- Each account registration has its own credentials and label, even when email addresses match. Only opaque profile IDs are saved with game provider settings. Tokens remain in `userData/chatgpt/accounts.enc`, encrypted with Electron `safeStorage`; Linux's insecure `basic_text` backend is rejected. Files are replaced atomically with owner-only permissions on Unix. Windows replacement uses Node/libuv’s replace-existing rename with bounded retries for transient locks; the destination is never unlinked before replacement. A missing/locked keyring never triggers plaintext fallback or overwrites an unreadable file.
- Electron's existing single-instance lock and the main-process queue serialize refreshes. Received refresh rotations are checkpointed before identity validation. Transient key-server failures preserve the checkpoint for recovery. Account changes cancel active requests. A refresh already sent to the token endpoint finishes under its own 60-second timeout and persists the rotated credentials before cancellation is observed; account changes may wait for that bounded rotation. Refresh responses without a new ID token retain the previously verified identity. Sign-out attempts remote revocation, clears local tokens, and reports unconfirmed revocation.
- Requests use only public `/v1/models` and `/v1/responses`, with `store:false`, streaming, and `Accept: text/event-stream`. Model availability is checked with the request's own account. Structured game output and lookup tool rounds use Responses function calls in the `open_historia` namespace; encrypted reasoning items are replayed for stateless lookup continuations. Only `response.completed` commits a result. Text deltas and completed output items can reconstruct a sparse completion payload; a stream that ends without completion is rejected. Parallel tool calls are disabled, and mixed final-output/lookup responses are rejected without applying game state. Malformed, interrupted, failed, or incomplete streams fail the call. Plan-limit and usage-unavailable errors stop without falling through to an API-key provider. Network/service failures and unavailable models can advance through the configured Fallback list; generic rate limits follow its wait/next preference. A backup may use an API key. Unexpected internal errors and credential-persistence failures are terminal and never select a backup. Model-unavailable failures use the normal bounded busy period, so temporary catalog or entitlement failures do not permanently disable an entry.
- The model's advanced custom-parameter controls are hidden for ChatGPT connections; requests use the integration's supported parameters. Output-tool arguments are consumed on completion rather than progressively applied to game state.
- Website and Android builds compile out the desktop account UI and transport. The catalog additionally requires the real preload capability. Existing API-key providers remain available. Shared frontend changes provide the desktop hooks; the shared server exposes no ChatGPT OAuth or inference endpoints.

## Validation

Run from the repository root:

```bash
node --test server/chatgptDesktop.test.js src/desktop/*.test.js
npm test
npm run build
npm run build:web
```

Check the web output contains no `ohChatGPT`, `Continue with ChatGPT`, OAuth endpoints, or desktop ChatGPT chunks. The normal web build requires `scripts/seed-web-defaults.mjs`; its generated files are ignored by git.

The Tests workflow runs the focused desktop regressions on Linux, Windows, and macOS, including repeated vault replacement and failed-write preservation. These use mocked credential storage and do not replace native Electron/keyring or real-account verification.

### Current verification gap

The macOS advisor log from 2026-10-15 showed unsuccessful live responses. Stream
handling was subsequently updated in commit `5917069`; successful real-account
inference after that fix has not yet been confirmed. Automated regression coverage
does not close this release gate. Record the tested commit, OS/package, and results
when completing the checks below.

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
