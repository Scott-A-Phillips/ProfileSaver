/**
 * LinkedIn to Notion - Background Service Worker (Manifest V3)
 * Handles all Notion API communication. Never expose tokens to content scripts.
 */

const NOTION_API_BASE = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28'; // Stable, widely supported. Update if needed.

/**
 * Retrieve stored Notion credentials and property mapping.
 */
async function getCredentials() {
  const { notionToken, databaseId, propertyMap, useProfilePhotoAsIcon, xaiApiKey } = await chrome.storage.local.get([
    'notionToken', 
    'databaseId', 
    'propertyMap',
    'useProfilePhotoAsIcon',
    'xaiApiKey'
  ]);
  return { 
    notionToken, 
    databaseId,
    propertyMap: propertyMap || getDefaultPropertyMap(),
    useProfilePhotoAsIcon: useProfilePhotoAsIcon !== false,
    xaiApiKey
  };
}

function getDefaultPropertyMap() {
  return {
    name: "Name",
    headline: "Job Title",
    company: "Organisation",
    profileUrl: "LinkedIn",
    profilePicture: "Profile Photo"   // Can be mapped to a URL or Files & media property
  };
}

/**
 * Build a minimal rich_text array for Notion properties/blocks.
 */
function makeRichText(content, maxLength = 1800) {
  if (!content) return [];
  const text = String(content).slice(0, maxLength).trim();
  if (!text) return [];
  return [{ text: { content: text } }];
}

/**
 * Create a paragraph block containing a hyperlink.
 */
/**
 * Convert a value we prepared (as rich_text / url / title) into the correct format
 * based on the actual property type in the user's Notion database.
 */
function convertToNotionPropertyFormat(naiveValue, actualPropDef) {
  if (!actualPropDef || !naiveValue) return naiveValue;

  const targetType = actualPropDef.type;

  // Extract raw string value from our naive format
  let rawValue = '';
  if (naiveValue.title?.[0]?.text?.content) {
    rawValue = naiveValue.title[0].text.content;
  } else if (naiveValue.rich_text?.[0]?.text?.content) {
    rawValue = naiveValue.rich_text[0].text.content;
  } else if (typeof naiveValue.url === 'string') {
    rawValue = naiveValue.url;
  } else {
    return naiveValue;
  }

  if (!rawValue) return naiveValue;

  switch (targetType) {
    case 'title':
      return { title: makeRichText(rawValue) };
    case 'rich_text':
      return { rich_text: makeRichText(rawValue) };
    case 'select':
      return { select: { name: rawValue } };
    case 'multi_select': {
      // Split on common separators (comma, semicolon, bullet, newline)
      const names = rawValue.split(/[,;•\n]+/).map(s => s.trim()).filter(Boolean);
      return { multi_select: names.map(name => ({ name })) };
    }
    case 'url':
      return { url: rawValue };
    case 'files':
      // If we already prepared a files array, use it. Otherwise treat the value as an external URL.
      if (naiveValue && Array.isArray(naiveValue.files)) {
        return naiveValue;
      }
      return {
        files: [
          {
            name: "LinkedIn Profile Photo",
            external: { url: rawValue }
          }
        ]
      };
    case 'rich_text':
    case 'text':  // Some older databases use 'text'
      // If this is the Profile Photo mapping and we have a URL, just store the URL as text
      // (since the user created it as a text field). This is not ideal for images but prevents errors.
      if (rawValue.startsWith('http')) {
        return { rich_text: makeRichText(rawValue) };
      }
      return { rich_text: makeRichText(rawValue) };
    default:
      console.warn(`[LinkedIn→Notion] Property type "${targetType}" not auto-convertible. Skipping or falling back.`);
      return null;
  }
}

/**
 * Build the Notion page properties + children from extracted profile data.
 * Uses user-configured property names from propertyMap for flexibility.
 */
function buildNotionPayload(profile) {
  const map = profile.propertyMap || getDefaultPropertyMap();
  
  const properties = {
    [map.name]: {
      title: makeRichText(profile.fullName || 'LinkedIn Profile')
    }
  };

  if (profile.headline && map.headline) {
    properties[map.headline] = { rich_text: makeRichText(profile.headline) };
  }
  if (profile.currentCompany && map.company) {
    properties[map.company] = { rich_text: makeRichText(profile.currentCompany) };
  }
  if (profile.profileUrl && map.profileUrl) {
    properties[map.profileUrl] = { url: profile.profileUrl };
  }

  // Profile picture handling - adapt to whatever property type the user has mapped
  if (profile.profilePictureUrl && map.profilePicture) {
    // We will decide the format based on the actual property type during schema validation.
    // For now, prepare it in a way that works for files or url.
    properties[map.profilePicture] = {
      // This will be converted properly in convertToNotionPropertyFormat based on the real type
      // If the property is Files & media → sent as file
      // If url → sent as url
      // If text/rich_text → sent as the URL text (graceful fallback)
      files: [
        {
          name: "LinkedIn Profile Photo",
          external: {
            url: profile.profilePictureUrl
          }
        }
      ]
    };
  }

  return {
    parent: { database_id: profile.databaseId || '' }, // Will be overridden by caller
    properties
  };
}

/**
 * Make an authenticated request to the Notion API.
 */
async function notionRequest(endpoint, options = {}) {
  const { notionToken } = await getCredentials();
  if (!notionToken) {
    throw new Error('Notion API token is not configured. Open the extension popup to set it.');
  }

  const url = `${NOTION_API_BASE}${endpoint}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${notionToken}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });

  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch (_) { json = { raw: text }; }

  if (!res.ok) {
    const msg = json?.message || json?.error || `Notion API error (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    err.body = json;
    throw err;
  }

  return json;
}

/**
 * Fetch an image from a URL and upload it to Notion using the file upload API.
 * Returns the uploaded file object (with .id) that can be used in page icons or properties.
 */
async function uploadImageToNotionAsFile(imageUrl, suggestedFileName = 'profile-photo.jpg') {
  const { notionToken } = await getCredentials();
  if (!notionToken) {
    throw new Error('No Notion token available for image upload');
  }

  // Step 1: Download the image (LinkedIn images are often strict with fetchers)
  let imageResponse;
  try {
    imageResponse = await fetch(imageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.linkedin.com/',
        'Origin': 'https://www.linkedin.com'
      }
    });
  } catch (fetchErr) {
    throw new Error(`Network error downloading LinkedIn image: ${fetchErr.message}`);
  }

  if (!imageResponse.ok) {
    throw new Error(`Failed to download image from LinkedIn: HTTP ${imageResponse.status} ${imageResponse.statusText}`);
  }

  const imageBlob = await imageResponse.blob();
  const fileSize = imageBlob.size;
  const contentType = imageBlob.type || 'image/jpeg';

  // Determine a reasonable filename
  let fileName = suggestedFileName;
  if (imageUrl.includes('.png')) fileName = suggestedFileName.replace('.jpg', '.png');
  else if (imageUrl.includes('.webp')) fileName = suggestedFileName.replace('.jpg', '.webp');

  // Step 2: Create a file upload in Notion
  const createUploadRes = await notionRequest('/file_uploads', {
    method: 'POST',
    body: JSON.stringify({
      file: {
        file_name: fileName,
        file_size: fileSize
      }
    })
  });

  const uploadUrl = createUploadRes?.upload_url;
  const fileObject = createUploadRes?.file;

  if (!uploadUrl || !fileObject?.id) {
    throw new Error('Failed to initialize Notion file upload');
  }

  // Step 3: Upload the actual binary content to the provided upload URL
  const uploadResponse = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(fileSize)
    },
    body: imageBlob
  });

  if (!uploadResponse.ok) {
    const errorText = await uploadResponse.text();
    throw new Error(`Failed to upload file content to Notion: ${uploadResponse.status} ${errorText}`);
  }

  // The fileObject from the first response should now be ready to use
  return fileObject;
}

/**
 * Create a new page in the configured database.
 */
async function createNotionPage(profileData) {
  const { notionToken, databaseId, propertyMap, useProfilePhotoAsIcon } = await getCredentials();

  if (!notionToken) {
    return { success: false, error: 'Notion token missing. Open extension popup and save your token.' };
  }
  if (!databaseId) {
    return { success: false, error: 'Database ID missing. Open extension popup and enter your Notion database ID.' };
  }

  // Attach the user's property mapping so buildNotionPayload can use custom names
  const dataWithMap = { ...profileData, propertyMap };
  const payload = buildNotionPayload(dataWithMap);
  payload.parent = { database_id: databaseId };

  // Make saves resilient: only send properties that actually exist in the user's database.
  // This prevents hard failures when optional fields (About, Experience, etc.) are not present.
  try {
    const db = await notionRequest(`/databases/${databaseId}`, { method: 'GET' });
    const existingProps = db.properties || {};

    const originalProps = payload.properties || {};
    const safeProps = {};
    const skipped = [];

    for (const [propName, naiveValue] of Object.entries(originalProps)) {
      const propDef = existingProps[propName];
      if (propDef) {
        const converted = convertToNotionPropertyFormat(naiveValue, propDef);
        if (converted) {
          safeProps[propName] = converted;
        } else {
          skipped.push(propName);
        }
      } else {
        skipped.push(propName);
      }
    }

    if (skipped.length > 0) {
      console.warn('[LinkedIn→Notion] Skipping properties (missing or incompatible type):', skipped);
    }

    payload.properties = safeProps;

    // The title property (mapped name) is mandatory. Fail early with a helpful message if it's missing.
    const map = dataWithMap.propertyMap || getDefaultPropertyMap();
    const titlePropName = map.name;
    if (!safeProps[titlePropName]) {
      return {
        success: false,
        error: `The title property "${titlePropName}" does not exist in your database. Open the extension popup, click "Test Connection", and fix your custom property mapping.`
      };
    }
  } catch (schemaErr) {
    // Schema pre-check failed (e.g. permissions, network, rate limit).
    // Fall back to a minimal safe payload so the save doesn't completely die on missing optional properties.
    console.warn('[LinkedIn→Notion] Schema pre-check failed, using minimal safe payload. Reason:', schemaErr.message);

    const map = dataWithMap.propertyMap || getDefaultPropertyMap();
    const minimalProps = {};

    // Always try to send at least the title
    if (payload.properties[map.name]) {
      minimalProps[map.name] = payload.properties[map.name];
    }
    // Send a couple of very common/safe fields if they exist in the original payload
    if (payload.properties[map.profileUrl]) minimalProps[map.profileUrl] = payload.properties[map.profileUrl];
    if (payload.properties[map.headline]) minimalProps[map.headline] = payload.properties[map.headline];
    if (payload.properties[map.profilePicture]) minimalProps[map.profilePicture] = payload.properties[map.profilePicture];

    payload.properties = minimalProps;
  }

  // Set page icon to the LinkedIn profile photo (upload for reliability)
  let iconUploadWarning = null;

  if (useProfilePhotoAsIcon && profileData.profilePictureUrl) {
    console.log('[LinkedIn→Notion] Attempting to upload profile photo for page icon...');

    try {
      const uploadedFile = await uploadImageToNotionAsFile(
        profileData.profilePictureUrl,
        'profile-photo.jpg'
      );

      if (uploadedFile && uploadedFile.id) {
        payload.icon = {
          type: "file",
          file: {
            file_id: uploadedFile.id
          }
        };
        console.log('[LinkedIn→Notion] Successfully uploaded profile photo and set as page icon. File ID:', uploadedFile.id);
      } else {
        console.warn('[LinkedIn→Notion] Photo upload succeeded but no file reference returned. Skipping icon.');
      }
    } catch (uploadErr) {
      console.error('[LinkedIn→Notion] Failed to upload profile photo for icon:', uploadErr.message, uploadErr);

      // Fallback: If we couldn't download/upload the image (very common with LinkedIn),
      // try setting the icon using the external URL as a best-effort.
      // This sometimes works and is better than no custom icon at all.
      if (profileData.profilePictureUrl) {
        console.log('[LinkedIn→Notion] Falling back to external URL for page icon due to LinkedIn blocking the download');
        payload.icon = {
          type: "external",
          external: {
            url: profileData.profilePictureUrl
          }
        };
        iconUploadWarning = `LinkedIn blocked photo download for reliable icon. Using external image as best-effort (may not always load). Note: Your "Profile Photo" property is currently a text field — change it to "Files & media" in Notion for the image to display properly.`;
      } else {
        iconUploadWarning = `Profile photo icon upload failed: ${uploadErr.message}. Using default Notion icon instead.`;
      }
    }
  } else {
    console.log('[LinkedIn→Notion] Not setting page icon. useProfilePhotoAsIcon=', useProfilePhotoAsIcon, 'profilePictureUrl present=', !!profileData.profilePictureUrl);
  }

  try {
    const created = await notionRequest('/pages', {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    const pageUrl = created?.url || `https://www.notion.so/${created?.id?.replace(/-/g, '')}`;

    const result = { success: true, url: pageUrl, pageId: created?.id };
    if (iconUploadWarning) {
      result.warning = iconUploadWarning;
    }
    return result;
  } catch (err) {
    console.error('[LinkedIn→Notion] createNotionPage failed:', err);

    let friendly = err.message || 'Unknown Notion error';

    if (err.status === 401 || err.status === 403) {
      friendly = 'Notion authentication failed. Check your token and that the integration has access to the database.';
    } else if (err.status === 404) {
      friendly = 'Database not found. Verify the Database ID and that the integration is invited to the database.';
    } else if (err.status === 400) {
      friendly = `Bad request to Notion. This is usually a property mapping problem. Open the popup → Test Connection and review your Advanced custom property names. Details: ${err.message}`;
    } else if (err.status === 429) {
      friendly = 'Notion rate limit hit. Please wait a moment and try again.';
    }

    return { success: false, error: friendly };
  }
}

/**
 * Test that the token works and the database is accessible.
 * Optionally validates that the user's configured properties exist.
 */
async function testNotionConnection(databaseIdOverride, mapOverride = null) {
  const { notionToken, databaseId, propertyMap } = await getCredentials();
  const dbId = databaseIdOverride || databaseId;
  const map = mapOverride || propertyMap || getDefaultPropertyMap();

  if (!notionToken) {
    return { success: false, error: 'No Notion token saved.' };
  }
  if (!dbId) {
    return { success: false, error: 'No Database ID provided.' };
  }

  try {
    const db = await notionRequest(`/databases/${dbId}`, { method: 'GET' });
    
    const dbTitle = db?.title?.[0]?.plain_text || db?.title || 'Untitled Database';
    const existingProps = db.properties || {};
    const propNames = Object.keys(existingProps);

    // Check mapped properties (we now auto-convert most types)
    const fieldsToCheck = ['name', 'headline', 'company', 'profileUrl'];
    const missing = [];
    const actualTypes = [];

    for (const key of fieldsToCheck) {
      const userPropName = map[key];
      if (!userPropName) continue;

      const prop = existingProps[userPropName];
      if (!prop) {
        missing.push(userPropName);
      } else {
        actualTypes.push(`${userPropName} (${prop.type})`);
      }
    }

    const schemaOk = missing.length === 0;

    return {
      success: true,
      databaseTitle: dbTitle,
      url: db?.url,
      schemaOk,
      missingProperties: missing,
      actualPropertyTypes: actualTypes,
      availableProperties: propNames.slice(0, 15)
    };
  } catch (err) {
    console.error('[LinkedIn→Notion] testNotionConnection failed:', err);
    let friendly = err.message || 'Connection test failed.';
    if (err.status === 401 || err.status === 403) {
      friendly = 'Authentication failed or integration lacks access. Re-check token and database sharing settings.';
    } else if (err.status === 404) {
      friendly = 'Database not found. Make sure you copied the correct Database ID (the long ID in the URL) and shared it with your integration.';
    }
    return { success: false, error: friendly };
  }
}

/**
 * Message handler from content script and popup.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // --- Grok AI correction ---
  if (message.action === 'CORRECT_WITH_GROK') {
    (async () => {
      try {
        const { xaiApiKey } = await getCredentials();
        if (!xaiApiKey) {
          sendResponse({ success: false, error: 'No xAI API key saved. Add it in the extension popup.' });
          return;
        }

        const { profile, pageText } = message;

        const system = 'You are an assistant that corrects LinkedIn profile data extraction. Given the raw page content and the extraction results, fix any errors in the extracted fields. Respond ONLY with a JSON object containing: name (string), headline (string), organisation (string). Use empty strings for unknown fields.';

        const userMsg = `Raw page content:\n${(pageText || '').slice(0, 6000)}\n\nCurrent extraction:\nName: ${profile.fullName || ''}\nJob Title: ${profile.headline || ''}\nOrganisation: ${profile.currentCompany || ''}\n\nCorrect the extraction based on the raw page content. Respond with only JSON.`;

        const resp = await fetch('https://api.x.ai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${xaiApiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: 'grok-2',
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: userMsg }
            ],
            temperature: 0.1,
            max_tokens: 300
          })
        });

        if (!resp.ok) {
          const errText = await resp.text();
          sendResponse({ success: false, error: `xAI API error (${resp.status}): ${errText}` });
          return;
        }

        const data = await resp.json();
        const raw = data?.choices?.[0]?.message?.content || '';
        const jsonMatch = raw.match(/\{.*\}/s);
        if (!jsonMatch) {
          sendResponse({ success: false, error: 'Grok did not return valid JSON', raw });
          return;
        }

        const corrected = JSON.parse(jsonMatch[0]);
        sendResponse({
          success: true,
          corrected: {
            fullName: corrected.name || '',
            headline: corrected.headline || '',
            currentCompany: corrected.organisation || ''
          },
          raw
        });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  if (message.action === 'SAVE_PROFILE') {
    (async () => {
      const result = await createNotionPage(message.profile);
      sendResponse(result);
    })();
    return true; // keep channel open for async
  }

  if (message.action === 'TEST_CONNECTION') {
    (async () => {
      const result = await testNotionConnection(message.databaseId, message.propertyMap || null);
      sendResponse(result);
    })();
    return true;
  }

  if (message.action === 'GET_SETTINGS') {
    (async () => {
      const creds = await getCredentials();
      sendResponse({ success: true, ...creds });
    })();
    return true;
  }

  if (message.action === 'SAVE_SETTINGS') {
    (async () => {
      const { token, databaseId, propertyMap, useProfilePhotoAsIcon, xaiApiKey } = message;
      const toSave = {
        notionToken: (token || '').trim(),
        databaseId: (databaseId || '').trim()
      };
      if (propertyMap) {
        toSave.propertyMap = propertyMap;
      }
      if (typeof useProfilePhotoAsIcon === 'boolean') {
        toSave.useProfilePhotoAsIcon = useProfilePhotoAsIcon;
      }
      if (typeof xaiApiKey === 'string') {
        toSave.xaiApiKey = xaiApiKey.trim() || '';
        console.log('[LinkedIn→Notion] Saving xAI key, length:', toSave.xaiApiKey.length);
      }
      await chrome.storage.local.set(toSave);
      sendResponse({ success: true });
    })();
    return true;
  }

  if (message.action === 'CLEAR_SETTINGS') {
    (async () => {
      await chrome.storage.local.remove(['notionToken', 'databaseId', 'useProfilePhotoAsIcon', 'xaiApiKey']);
      sendResponse({ success: true });
    })();
    return true;
  }

  // --- Debug / Corpus tools: forward to the active LinkedIn tab's content script ---
  if (message.action === 'CAPTURE_PROFILE' || message.action === 'PREVIEW_EXTRACTION') {
    (async () => {
      try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const tab = tabs && tabs[0];
        if (!tab || !tab.id) {
          sendResponse({ success: false, error: 'No active tab found' });
          return;
        }
        if (!/linkedin\.com\/(in|company)\//.test(tab.url || '')) {
          sendResponse({ success: false, error: 'Active tab is not a LinkedIn profile or company page' });
          return;
        }
        const responseFromContent = await chrome.tabs.sendMessage(tab.id, { action: message.action });
        sendResponse(responseFromContent || { success: false, error: 'No response from content script' });
      } catch (err) {
        sendResponse({ success: false, error: 'Could not reach content script on this tab. Try refreshing the LinkedIn page.' });
      }
    })();
    return true; // keep channel open for async
  }
});

// Optional: keep service worker alive a bit longer on Notion calls if needed (MV3 is event-driven, fine for this use case).
console.log('[LinkedIn→Notion] Background service worker loaded.');
