# LinkedIn → Notion Chrome Extension

Save LinkedIn profiles (and company pages) to a Notion database with one click.

## Features

- **Profiles** — extracts name, job title, organisation, location, about, profile photo
- **Company pages** — extracts company name, tagline, logo, location
- **AI correction** — optionally use xAI Grok to fix misidentified job titles and company names
- **Custom property mapping** — map extracted fields to any Notion column names
- **Profile photo as page icon** — sets the LinkedIn photo/logo as the Notion page icon
- SPA-friendly (works with LinkedIn's client-side navigation)

## Installation

### Chrome Web Store (Recommended)

1. Install from the [Chrome Web Store](https://chromewebstore.google.com/detail/oiaacjjghffkmnehnmoljfhlppbcfcmp)
2. Click **Add to Chrome**.
3. Pin the extension if desired.

### Developer Mode (Unpacked)

1. Clone or download this repo.
2. Open Chrome → `chrome://extensions`
3. Enable **Developer mode** (top right).
4. Click **Load unpacked** and select the folder.
5. Pin the extension if desired.

## Notion Setup

### 1. Create an Internal Integration

1. Go to [notion.so/my-integrations](https://www.notion.so/my-integrations).
2. Click **+ New integration**, name it (e.g. "LinkedIn Saver"), pick your workspace, submit.
3. Copy the **Internal Integration Token** (starts with `ntn_`).

### 2. Create a Database with These Properties

| Column Name   | Type      | Example Value          |
|---------------|-----------|------------------------|
| Name          | Title     | Dwight Lazarus         |
| Job Title     | Rich Text | Director at Spotify    |
| Organisation  | Rich Text | Spotify                |
| LinkedIn      | URL       | https://linkedin.com/... |
| Profile Photo | URL or Files & media | (photo URL) |

You can use **any column names you like** — configure them in the extension popup under Advanced: Custom Property Names.

### 3. Share the Database

1. Open the database in Notion.
2. Click **⋯** → **Connections** → add your integration.

### 4. Get the Database ID

Open the database in your browser. The URL has a 32-character hex string after the workspace name:

```
https://www.notion.so/workspace/0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d?v=...
```

That hex string is your **Database ID**.

## Configuration

1. Click the extension icon.
2. Expand **🔑 API Settings** and paste your:
   - Notion Integration Token
   - Database ID
3. Click **Save Settings**, then **Test Connection**.

Optional — expand **🔧 Advanced: Custom Property Names** if your database uses different column names than the defaults.

### AI Correction (Optional)

1. Get an xAI API key from [console.x.ai](https://console.x.ai).
2. Paste it into the **xAI API Key** field in API Settings and save.
3. On each save, Grok will correct misidentified job titles and company names before writing to Notion.

## Usage

- Open a LinkedIn profile (`linkedin.com/in/...`) or company page (`linkedin.com/company/...`).
- A blue **Save to Notion** button appears (bottom-right or in the profile actions area).
- Click it. Success/failure toasts appear.
- For profiles with an xAI key configured, Grok corrects the extraction before saving.

## Troubleshooting

**Button doesn't appear**
- Refresh the page. LinkedIn is a heavy SPA; the button may take a few seconds.
- Make sure you're on a real profile (`/in/username`) or company (`/company/name`) page.

**Save fails with 400**
- Your property names don't match the database. Click **Test Connection** in the popup to see which columns are missing, then fix the Advanced Property Names.

**401 / 403**
- The token is wrong or the integration hasn't been invited to the specific database.

**AI Correction not working**
- Verify your xAI key is saved in API Settings.
- Check the console (`Ctrl+Shift+J`) for `[LinkedIn→Notion] Grok` messages.

## Project Structure

```
├── manifest.json       # Extension manifest (MV3)
├── background.js       # Service worker — Notion API, Grok, credential storage
├── content.js          # Injected on LinkedIn pages — extraction, button, toasts
├── content.css         # Button/toast styles
├── popup/
│   ├── popup.html      # Settings UI
│   ├── popup.js        # Popup logic
│   └── popup.css       # Popup styles
├── icons/              # Extension icons
└── README.md
```

## Privacy

- Your Notion token, Database ID, and xAI key are stored only in `chrome.storage.local` (never synced, never sent anywhere).
- The extension communicates only with `api.notion.com` and `api.x.ai` (if configured).
- No analytics, no telemetry, no third-party servers.

## License

MIT
