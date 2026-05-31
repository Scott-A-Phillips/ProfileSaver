# LinkedIn to Notion Chrome Extension

A clean, modern Manifest V3 Chrome extension that lets you save LinkedIn profiles to a Notion database with one click.

## Features

- Detects LinkedIn profile pages (`/in/*`) and injects a **"Save to Notion"** button (floating + native placement attempts).
- Extracts: full name, headline, current company, location, LinkedIn URL, about summary, and experience highlights.
- Creates a rich Notion page inside your chosen database with:
  - Structured properties (Name, Headline, Company, Location, Profile URL, About, Experience)
  - Formatted page content (headings + paragraphs + bullet list for experience)
- Popup UI for securely storing your Notion Integration Token + Database ID.
- "Test Connection" button to validate credentials and database access.
- Proper error messages, loading states, and dismissible toasts.
- SPA-friendly (works with LinkedIn's client-side navigation).

## Project Structure

```
linkedin-notion-extension/
├── manifest.json
├── background.js          # Service worker – Notion API calls & credential storage
├── content.js             # Injected on profile pages – extraction + button + toasts
├── content.css
├── popup/
│   ├── popup.html
│   ├── popup.js
│   └── popup.css
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── README.md
└── .gitignore
```

## Installation (Load Unpacked)

1. Clone or download this folder.
2. Open Chrome → `chrome://extensions`
3. Enable **Developer mode** (top right).
4. Click **Load unpacked** and select the `linkedin-notion-extension` folder.
5. Pin the extension if desired.

## Notion Setup (Required)

### 1. Create an Internal Integration
1. Go to [https://www.notion.so/my-integrations](https://www.notion.so/my-integrations).
2. Click **+ New integration**.
3. Name it (e.g., "LinkedIn Profile Saver"), choose your workspace, and click **Submit**.
4. On the next screen, copy the **Internal Integration Token** (starts with `ntn_`).

### 2. Create / Prepare a Database
Recommended property names and types (the extension sends these keys):

| Property Name   | Type          | Notes                              |
|-----------------|---------------|------------------------------------|
| Name            | Title         | Required by Notion                 |
| Headline        | Rich Text     |                                    |
| Company         | Rich Text     |                                    |
| Location        | Rich Text     |                                    |
| Profile URL     | URL           |                                    |
| About           | Rich Text     | Long text is fine (also added to page body) |
| Experience      | Rich Text     | Highlights joined with bullets     |

You can name them differently — just remember to update `background.js` if you change the keys.

### 3. Share the Database with Your Integration
1. Open the database in Notion.
2. Click the **⋯** menu → **Connections**.
3. Find and select your integration (it must have "Insert content" permissions).

### 4. Get the Database ID
Open the database in your browser. The URL looks like:

```
https://www.notion.so/workspace/0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d?v=...
```

The long hex string (`0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d`) **is** your Database ID. Copy it.

### 5. Configure the Extension
1. Click the extension icon → popup opens.
2. Paste the **token** and **Database ID**.
3. Click **Save Settings**.
4. Click **Test Connection** — you should see a success message with the database title.

## Usage

1. Navigate to any LinkedIn profile (`linkedin.com/in/...`).
2. After the page settles, a blue **"Save to Notion"** button appears (bottom-right or inside the profile actions).
3. Click it.
4. Watch the toast notifications. On success you’ll get a quick link to open the new Notion page.

The saved page will contain:
- All extracted fields as database properties
- A nicely formatted "About" section + "Experience Highlights" with bullets

## Troubleshooting

**"Notion token missing" or 401/403 errors**
- Re-check that you copied the full `ntn_...` token.
- Verify the integration was invited to the specific database (not just the workspace).

**"Database not found" or 404**
- Make sure you copied the correct Database ID (32 hex chars).
- For very new databases using the 2025+ multi-source model, you may need the **Data Source ID** instead of the classic Database ID. You can get it via the Notion API or by inspecting the page.

**Button doesn't appear**
- Hard refresh the LinkedIn profile (`Ctrl+Shift+R`).
- Make sure you're on a real `/in/username` page (not company pages or feed).
- Toggle the extension off/on in `chrome://extensions`.

**Properties not matching / bad request 400**
- The first time you save, the extension expects the property names listed above (or you can edit `background.js` → `buildNotionPayload`).
- After changing your database schema, test the connection again.

**Rate limits**
- Notion has generous but real limits. Wait 30–60 seconds if you hit 429.

## Development Notes

- Pure vanilla JS — no build step required.
- All Notion API calls happen in the service worker (`background.js`) for security.
- Credentials are stored in `chrome.storage.local` (never synced, never leaves your machine).
- Content script uses defensive, multi-selector extraction because LinkedIn frequently changes DOM classes.
- To update the Notion API version, edit `NOTION_VERSION` in `background.js`.

## Privacy & Security

- Your Notion token and Database ID live only in your browser's local storage.
- The extension never phones home.
- Only communicates with `api.notion.com` and the page you are viewing.

## Roadmap / Ideas for Future Versions

- Option to update existing page instead of always creating new (dedup by Profile URL).
- Support for saving posts / articles in addition to profiles.
- Custom property mapping UI.
- Export saved profiles as CSV/JSON.
- Dark mode for popup.

## License

MIT — feel free to fork, improve, and redistribute.

---

Made for people who want their LinkedIn network in their own second brain.
