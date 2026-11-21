# Validation — 21 November 2026

## Confirmed locally

- `node --test test/*.test.mjs`: 10 tests passed. Covers durable/idempotent feedback, stale anchors, conflicting writes, private API access, origin/host checks, media identity and ranges, repeat view events, SSE updates, cloud cleanup using a mock, and a Codex protocol exchange using a mock process.
- `node scripts/check-codex.mjs`: initialize/initialized handshake succeeded against installed `codex-cli 0.146.0`. Zero model turns started.
- `node scripts/cloud-desktop.mjs`: default plan-only mode completed; zero resources created.
- Local HTTP server responded with 200 at its loopback address.
- `node --check` succeeded for the server and browser application modules.

## Observed through the real browser UI

The Codex in-app browser was used for these checks, with two separate tabs of the same local session:

1. Selected text, froze its reference, wrote a comment and attached an actual generated MP4 through the browser file chooser. Saved feedback was visible in the second tab without reloading.
2. Opened the four-second MP4 as the main artifact. The browser reported duration 4 seconds, readyState 4 and no media error. Started playback and captured a real nonzero timestamp: 0.101921 seconds. The UI displayed 00:00.101.
3. Attached an actual PNG reference through the browser file chooser and saved the video feedback. The other tab showed the same paused timestamp, 0.101921 seconds.
4. Opened the PNG, clicked its center, captured an image anchor at normalized position 0.5/0.5 and saved a third feedback item.
5. Saved an added example as a new document version. The second tab received the new text, and the earlier text feedback was visibly labelled as referring to an older version.
6. Restarted the local server and reloaded the two tabs during testing. Saved feedback and assets were retained. Browser sessions were renewed through the normal root-page navigation.

Test media were generated calibration patterns, not private user files. Screenshots and runtime data are under the ignored `.local/` directory; they are not part of the Git change.

## Not established

- No real E2B sandbox, AWS VM or other cloud desktop was provisioned. E2B SDK installation, provider credentials, viewer embedding and cleanup against a real provider still require an integration run.
- No live model review was run, and no model-driven document or desktop edit was made. The optional `--execute` adapter and frame delivery need a separately authorized end-to-end test.
- No comparison of local and cloud computer-use quality, latency or cost was performed.
- No Gmail/Dropbox account was connected; no local browser authentication was copied into a VM.
- This is not a multi-tenant deployment, a cryptographic isolation implementation or a production security audit. The local application does not encrypt its storage.
- Browser inspection covered the desktop surface; native mobile devices and assistive technology were not tested.
- The Codex Rust core and its full test suite were not changed or built. The experimental package has independent Node requirements and uses Node core libraries only.

## Required next integration run

Choose a provider account and approve a cost boundary. Start one temporary blank desktop for one to five minutes, inspect the actual mirrored screen and manual inputs, then confirm deletion in the provider account. Only after that connect an agent and test exclusive input ownership with the fixed task set described in the architecture proposal.
