# Open Historia for iOS and App Clips

This port bundles the existing game UI inside a native iOS 17+ application and
App Clip. Both run the game and save library on the device. An Apple-only welcome dialog offers ChatGPT sign-in before entering the library. Map data still comes
from the game's existing verified content nodes, and model inference goes to
OpenAI. It does not embed the hosted website, run a VM, or run models offline.
The website deployment and launch metadata are not changed by this PR.

**Release status: not approved for production.** Compilation, simulator checks,
and physical-device/live-account results must be recorded below before release.
In particular, Network.framework loopback + ASWebAuthenticationSession must be
proved inside a signed App Clip; ordinary app and simulator success cannot prove
that App Clip entitlement and lifecycle behavior works on a device.

## Build

On macOS with Xcode 16+ and Node 22:

```sh
npm ci
npm run build:ios
brew install xcodegen
sips -z 1024 1024 apple/Resources/Assets.xcassets/AppIcon.appiconset/Icon.png
cd apple
cp Config/Local.xcconfig.example Config/Local.xcconfig
# Set your registered identifiers, Team ID, domain and App Store numeric ID.
xcodegen generate
open OpenHistoria.xcodeproj
```

Build the OpenHistoria scheme; the Clip is embedded in the containing app.
`swift test --package-path apple` runs the core protocol tests from the repository
root. `npm ci --prefix apple/browser-tests && npm test --prefix apple/browser-tests` runs the bundled UI/sign-in/save-migration regression with mocked native replies (requires Chrome, or set `BROWSER_PATH`). The Apple workflow builds unsigned device targets, checks the Clip's size,
and runs native unit/UI tests for the containing app and App Clip in the simulator. Unsigned artifacts are validation
outputs, not installable releases. `Local.xcconfig` is ignored by git.

## Design

- A Network.framework listener binds only `127.0.0.1:30427` and serves immutable
  bundled resources. Its stable origin preserves IndexedDB between launches.
  A busy port fails closed without navigating to an unknown listener.
- A separate ephemeral loopback listener captures the exact OAuth HTTP redirect.
  System authentication runs in ASWebAuthenticationSession, never an embedded
  login page. Validated callback capture dismisses the session; cancellation,
  app backgrounding, and a ten-minute deadline stop sign-in.
- PKCE S256, random state/nonce, strict method/path/Host/duplicate-query validation,
  RS256 signature and issuer/audience/time/subject/nonce checks are mandatory.
  Discovery endpoints stay on auth.openai.com. Credential requests never follow
  redirects. The issued client ID is saved before token exchange.
- Keychain holds one atomic, device-only, when-unlocked credential record. There
  is no shared Keychain group or iCloud synchronization. App Clip Keychain
  migration to the containing application is provided by iOS and must be tested.
  Rotating refresh tokens are checkpointed before remote JWKS verification.
- Only one native account/inference operation runs at a time, so refreshes cannot
  race. Account changes cancel and drain requests. Cancellation never accepts a
  late response. No ChatGPT tokens enter JavaScript, IndexedDB, logs or archives.
- The bridge accepts named operations only from the owning WKWebView main frame
  at its exact loopback origin. Native inference fixes the endpoint and policy;
  it discovers allowed models, sets `store:false`, parses bounded SSE, and accepts
  only completed responses. Plan-limit failures never switch to a billable key.
- Regular website and Android builds remove the Apple/ChatGPT entry points.
  Apple builds contain no analytics or website service worker.

## Saves and features

The full game UI, scenario editor, model settings, languages and local library
are bundled. Map downloads and community features require internet. Safari
provider CORS restrictions still apply to optional API-key providers; ChatGPT
uses native networking. Desktop filesystem/server/LAN features are not ported.
App Clips have no background execution and cannot guarantee long-lived storage.
An on-screen notice tells the player to use **Keep saves**, then get the full app.
Keep saves captures an IndexedDB transaction snapshot plus settings into a
protected App Group file (100 MB transfer limit). The full app imports only into
an empty library and never overwrites existing full-app games. Binary map and
flag values survive the typed archive format. Saves made after Keep saves need
another transfer. Use normal library exports for larger libraries/backups.
Native download sharing is provided; file import/export availability remains a
physical App Clip test gate. Account secrets are excluded from the transfer;
optional user-entered API-key settings follow the existing game's settings.

## Distribution setup (manual, no website deployment in this PR)

1. Register the parent and `.Clip` bundle identifiers, shared App Group, associated
   domains, and App Clip relationship in the Apple Developer account.
2. Configure signing and App Store ID in `Config/Local.xcconfig`. Replace the
   placeholder icon with an approved 1024px asset before store submission.
3. Publish the domain's `/.well-known/apple-app-site-association` with:
   `{"appclips":{"apps":["TEAMID.your.registered.bundle.Clip"]}}`.
4. When website changes are separately authorized, add the Safari Smart App Banner:
   `<meta name="apple-itunes-app" content="app-id=APP_STORE_ID, app-clip-bundle-id=your.registered.bundle.Clip, app-clip-display=card">`.
5. Configure a default App Clip experience in App Store Connect and submit the
   containing app with its Clip. The user still taps Open and consents to ChatGPT
   login/plan use. A page cannot silently install or launch a Clip.
6. Use digital-only invocation and minimum iOS 17 for the 100 MB allowance.
   Validate Apple's thinned/uncompressed size at archive submission. The build
   resource budget is 80 MB and CI rejects a Clip >=100,000,000 bytes.
7. Complete App Store privacy declarations for actual outgoing game/AI data and
   review included third-party assets/licenses. The bundled privacy manifest is
   not a substitute for App Store privacy labels. Source remains AGPL-3.0-or-later.

## Required release evidence

Record device/OS/build, expected result, actual result and artifact for each:

- Signed App Clip launched through Safari's real invocation card; parent absent.
- Fresh eligible account, returning account/issued ID, declined sharing, MFA,
  cancellation, delayed callback, wrong state, replay and account switch.
- Native loopback callback with local-network permission denied; no LAN access.
- Refresh rotation, app termination at checkpoint, offline JWKS recovery,
  revoked/expired session, plan limit, unavailable model, and sign-out offline.
- Complete game turn with tool lookups and encrypted reasoning replay; cancel and
  interrupt a streamed turn without applying partial state; recover on resume.
- Clip restart, WebKit process termination, lock/background, low memory,
  save transfer followed by full-app installation, account Keychain migration,
  existing parent saves, binary flag/map saves, export/import and retention.
- VoiceOver, Dynamic Type, reduced motion, iPhone/iPad orientation, keyboard,
  content-node outage, first launch with poor connectivity, and package thinning.
- App Store review, privacy/permission text, associated domain and real release
  signing. No shipping until the above pass; simulator success is insufficient.

References: [OpenAI sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in),
[Apple App Clip capabilities](https://developer.apple.com/documentation/appclip/choosing-the-right-functionality-for-your-app-clip),
[Apple local-network privacy](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy),
[App Clip sizes](https://developer.apple.com/help/app-store-connect/reference/app-uploads/maximum-build-file-sizes).
