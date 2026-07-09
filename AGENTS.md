# AGENTS.md — LinkedIn to Notion Chrome Extension

## One-line summary

Vanilla JS Manifest V3 Chrome extension — no build step, no package manager, no test framework, no linter. Load as unpacked in Chrome Dev mode.

## Commands

- **Run/develop**: Load the repo folder as unpacked in `chrome://extensions`. No build, no `npm` commands.
- **Debug extraction**: Popup → Debug → Capture Current Profile / Preview Extraction / Golden Profile Compare.
- **Test extraction accuracy**: Compare content.js output against `fixtures/profiles/*.json` ground truth. No automated test runner exists.
- **Pack**: `zip -r release.zip . -x '*.git*' 'fixtures/*' '*.zip'` (or use Chrome's Pack Extension UI).

## Architecture

| Layer | File | Role |
|---|---|---|
| Background SW | `background.js` | Notion API calls, credential storage (chrome.storage.local), message router |
| Content script | `content.js` | DOM extraction + button injection (Shadow DOM) + toasts (Shadow DOM) |
| Popup | `popup/` | Settings (token/DB ID/property map), debug tools |
| Golden corpus | `fixtures/profiles/` | Ground-truth JSON files for extraction validation |

- The content script uses a **tiered multi-selector extraction** strategy because LinkedIn frequently changes DOM classes.
- **Photo extraction**: Tier 0 (person-SVG figure) is the gold standard; all other tiers are fallbacks. srcset is preferred over src for high-res. The `shrink_` dimension in the URL is upgraded to `800_800` but query-string signature is never modified.
- **Button injection**: first tries native placement in the profile action bar (`tryInjectNativeButton`). Falls back to a floating button in **isolated Shadow DOM** (`#lin-to-notion-shadow-host`).
- **Toasts** use isolated Shadow DOM (`#lin-to-notion-toast-shadow-host`). Both button and toast Shadow DOM styles are inlined in `content.js`; `content.css` styles only apply to the native (non-shadow) button variant.
- **SPA handling**: 13 staggered retries during `init()` (50ms–6500ms), plus a `MutationObserver`, `popstate` listener, `visibilitychange` listener, a safety interval (18 × 2800ms), and a 15s late safety net.
- Notion API version: `2022-06-28` in `background.js:7`.
- Default property map: Name → Title, Job Title → Rich Text, Organisation → Rich Text, LinkedIn → URL, Profile Photo → URL/Files.
- `useProfilePhotoAsIcon` defaults to `true`. The icon upload is a 3-step flow (download from LinkedIn → create Notion file upload → PUT binary). LinkedIn frequently blocks the download, triggering a fallback to external-URL icon.
- `CLEAR_SETTINGS` only clears `notionToken`, `databaseId`, and `useProfilePhotoAsIcon` — it preserves `propertyMap`.
- `chrome.runtime` messages: `SAVE_PROFILE`, `TEST_CONNECTION`, `GET_SETTINGS`, `SAVE_SETTINGS`, `CLEAR_SETTINGS`, `CAPTURE_PROFILE`, `PREVIEW_EXTRACTION`.

## Known issues

- **README.md** has unresolved merge conflict markers (`<<<<<<< HEAD` / `=======` / `>>>>>>> f76180e` at lines 1 and 154) — resolve on next edit.
- **melissa.json** extraction fails — jobTitle and organisation are empty strings (profile renders without visible experience card DOM structure).
- `homepage_url` in `manifest.json:7` points to a placeholder.

## Limitations

- No automated tests, CI, pre-commit hooks, or type checking.
- No Node.js dependency — pure browser APIs only.
- Any code change must be tested by reloading the extension in Chrome and visiting a real LinkedIn profile.
