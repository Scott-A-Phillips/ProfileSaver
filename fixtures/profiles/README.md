# Golden Profiles Corpus (for Extraction Development)

This directory holds real LinkedIn profile examples used to drive and validate the data extraction logic in `content.js`.

The goal is to move from fragile heuristic patching to **example-driven extraction**: we improve the code until it correctly extracts Job Title and Organisation (and Name) across all profiles in this corpus.

## Why This Exists
- LinkedIn's DOM changes frequently.
- Different profiles render the Experience section with varying timing and structure.
- Heuristics that work on one profile often break on another (e.g. pulling About text, junk from "Show more", wrong Experience chunks).
- Having a living set of real examples with ground truth makes improvements measurable and regressions visible.

## Schema (GoldenProfile)

Each file is a `.json` with the following structure:

```json
{
  "id": "unique-kebab-case-identifier-YYYY-MM-DD",
  "url": "https://www.linkedin.com/in/...",
  "capturedAt": "2026-04-12T14:30:00.000Z",
  "documentTitle": "Full document.title at capture time",
  "groundTruth": {
    "name": "Expected full name",
    "jobTitle": "Exact expected value for Job Title field in Notion",
    "organisation": "Exact expected value for Organisation field in Notion"
  },
  "raw": {
    "topCard": {
      "text": "Cleaned visible text from the top name + headline area"
    },
    "firstExperienceCard": {
      "lines": [
        "Chief AI & Governance Officer",
        "Breeple.ai · Full-time",
        "Jan 2025 - Present · 3 mos"
      ],
      "structuralHints": {
        "matchedSelector": "string describing what matched",
        "hasPvsListItem": true
      }
    },
    "experienceSectionText": "Large chunk of visible text starting from the Experience heading onward (first 2000 chars)"
  },
  "extractionAtCapture": {
    "name": "What the extractor returned at the moment of capture",
    "jobTitle": "...",
    "organisation": "...",
    "profilePictureUrl": "The URL the extractor picked for the official headshot (must have valid e/v/t signature)",
    "sources": {
      "jobTitle": "which strategy produced it (e.g. experience-dom, nuclear-text, title-parse, etc.)",
      "organisation": "same"
    }
  },
  "notes": "Optional free-text notes about rendering quirks, timing issues, etc."
}
```

### Required Fields for New Profiles
- `id`, `url` (or redacted), `capturedAt`, `groundTruth` (especially `jobTitle` and `organisation`), `raw`
- `extractionAtCapture` (including `profilePictureUrl` when testing photo extraction) is very useful when captured via the in-extension tool

**Profile photo note**: The authoritative signal for the official headshot is the `<figure>` containing both a `<svg id^="person-">` placeholder and the real `<img>` (with crop/shrink URLs in srcset). When adding profiles specifically to debug photos, include the correct current high-res URL (with valid `?e=...&t=...` signature) in your ground-truth notes or a top-level `profilePictureUrl` field. The Capture tool now records `profilePictureDebug.sourceTier` (look for `person-svg-figure`).

## How to Add a New Profile

1. Open the problematic LinkedIn profile in Chrome.
2. Open the extension popup.
3. Go to the **Debug / Extraction Tools** section (new in Advanced).
4. Click **Capture Current Profile**.
5. The tool will:
   - Collect raw regions from the page.
   - Run the current extractor.
   - Pre-fill the Ground Truth fields with the current extraction output.
6. Review / correct the **Ground Truth** (Job Title and Organisation are critical).
7. Click **Copy as JSON**.
8. Paste into a new file: `fixtures/profiles/your-descriptive-name-YYYY-MM-DD.json`
9. Commit + push (or share the file).

## Using the Corpus

- The **Preview Extraction** button in the popup shows detailed source + mismatch info when viewing a real page.
- Later we will add an automated validation script that runs the extractor against every file here and reports success rate + specific failures.

## Redaction Guidelines
- You may shorten or redact the URL.
- You may trim very long `experienceSectionText` or `topCard.text` if it contains sensitive information.
- Keep the critical Job Title / Organisation / first experience lines intact — they are the whole point.

## Current Status
This corpus is the single source of truth for what "correct" extraction looks like on real profiles.

**Profile photo extraction (2026-04+)**: The primary strategy is Tier 0 "person-svg-figure": locate any `svg[id^="person-"]`, take its closest `figure`, then pick the best `img` inside it whose src/srcset contains `licdn.com/dms/image` or `profile-displayphoto`. This structure is the only reliable way to exclude posted/Featured images. All other tiers are fallbacks. The popup Preview now shows `sourceTier` + srcset snippet for rapid diagnosis.

When making changes to extraction logic in `content.js`, the expectation is:
- All existing profiles in this folder should still pass (or improve).
- New hard profiles should be added to the corpus before or alongside the fix.

## Files
Add one `.json` file per distinct hard profile (or interesting rendering variation).
