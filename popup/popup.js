/**
 * LinkedIn to Notion - Popup Script
 * Handles settings UI, saving credentials, and connection testing.
 */

const $ = (id) => document.getElementById(id);

function showStatus(message, isError = false) {
  const banner = $('status-banner');
  const text = $('status-text');

  text.textContent = message;
  banner.className = `status-banner ${isError ? 'error' : 'success'}`;
  banner.classList.remove('hidden');

  // Auto-hide success messages
  if (!isError) {
    setTimeout(() => {
      banner.classList.add('hidden');
    }, 3800);
  }
}

function hideStatus() {
  $('status-banner').classList.add('hidden');
}

async function loadCurrentSettings() {
  try {
    const res = await chrome.runtime.sendMessage({ action: 'GET_SETTINGS' });
    if (res && res.success) {
      if (res.notionToken) $('notion-token').value = res.notionToken;
      if (res.databaseId) $('database-id').value = res.databaseId;
      if (res.xaiApiKey) $('xai-key').value = res.xaiApiKey;

      // Load custom property map or use defaults
      const map = res.propertyMap || {};
      $('map-name').value = map.name || 'Name';
      $('map-headline').value = map.headline || 'Job Title';
      $('map-company').value = map.company || 'Organisation';
      $('map-profileUrl').value = map.profileUrl || 'LinkedIn';
      $('map-profilePicture').value = map.profilePicture || 'Profile Photo';

      // Load page icon preference (default true)
      const useAsIcon = res.useProfilePhotoAsIcon;
      $('use-photo-as-icon').checked = useAsIcon !== false;
    }
  } catch (e) {
    console.warn('Could not load settings:', e);
  }
}

async function saveSettings() {
  const token = $('notion-token').value.trim();
  const databaseId = $('database-id').value.trim();
  const xaiApiKey = $('xai-key').value.trim();

  if (!token) {
    showStatus('Please enter your Notion Integration Token.', true);
    $('notion-token').focus();
    return;
  }
  if (!databaseId) {
    showStatus('Please enter your Notion Database ID.', true);
    $('database-id').focus();
    return;
  }

  // Basic validation hints
  if (!token.startsWith('ntn_') && !token.startsWith('secret_')) {
    showStatus('Warning: Token should usually start with "ntn_" (new format) or "secret_".', true);
  }

  const propertyMap = getCurrentPropertyMap();
  const useProfilePhotoAsIcon = $('use-photo-as-icon').checked;

  try {
    const res = await chrome.runtime.sendMessage({
      action: 'SAVE_SETTINGS',
      token,
      databaseId,
      propertyMap,
      useProfilePhotoAsIcon,
      xaiApiKey
    });

    if (res && res.success) {
      showStatus('✅ Settings saved successfully.');
    } else {
      showStatus('Failed to save settings.', true);
    }
  } catch (err) {
    showStatus('Error saving settings: ' + (err.message || err), true);
  }
}

function getCurrentPropertyMap() {
  return {
    name: $('map-name').value.trim() || 'Name',
    headline: $('map-headline').value.trim() || 'Job Title',
    company: $('map-company').value.trim() || 'Organisation',
    profileUrl: $('map-profileUrl').value.trim() || 'LinkedIn',
    profilePicture: $('map-profilePicture').value.trim() || 'Profile Photo'
  };
}

async function testConnection() {
  const tokenInput = $('notion-token').value.trim();
  const dbInput = $('database-id').value.trim();

  if (!tokenInput && !dbInput) {
    showStatus('Enter token and Database ID first, then test.', true);
    return;
  }

  const originalText = $('test-btn').textContent;
  $('test-btn').disabled = true;
  $('test-btn').textContent = 'Testing...';

  try {
    const propertyMap = getCurrentPropertyMap();

    const res = await chrome.runtime.sendMessage({
      action: 'TEST_CONNECTION',
      databaseId: dbInput || undefined,
      propertyMap: getCurrentPropertyMap(),   // allow testing unsaved mapping
    });

    if (res.success) {
      const title = res.databaseTitle ? `“${res.databaseTitle}”` : 'your database';
      
      let msg = `✅ Connected to ${title}.`;
      
      if (res.schemaOk === false || (res.missingProperties && res.missingProperties.length > 0)) {
        msg += ' Schema issues detected:';
        if (res.missingProperties?.length) {
          msg += `\nMissing: ${res.missingProperties.join(', ')}`;
        }
        if (res.actualPropertyTypes?.length) {
          msg += `\n\nYour mapped columns have these types:\n${res.actualPropertyTypes.join('\n')}`;
        }
        if (res.availableProperties?.length) {
          msg += `\n\nOther properties in this database:\n${res.availableProperties.join(', ')}`;
        }
        showStatus(msg, true);
      } else {
        if (res.actualPropertyTypes?.length) {
          msg += `\n\nMapped columns: ${res.actualPropertyTypes.join(' • ')}`;
        }
        showStatus(msg);
      }
    } else {
      showStatus(res.error || 'Connection failed. Check token and database permissions.', true);
    }
  } catch (err) {
    showStatus('Test failed: ' + (err.message || err), true);
  } finally {
    $('test-btn').disabled = false;
    $('test-btn').textContent = originalText;
  }
}

async function clearSettings() {
  if (!confirm('Clear saved Notion token and Database ID?')) return;

  try {
    await chrome.runtime.sendMessage({ action: 'CLEAR_SETTINGS' });
    $('notion-token').value = '';
    $('database-id').value = '';
    $('xai-key').value = '';
    $('use-photo-as-icon').checked = true; // reset to default
    showStatus('Credentials cleared from this browser.');
  } catch (err) {
    showStatus('Failed to clear: ' + (err.message || err), true);
  }
}

function setupEventListeners() {
  $('save-btn').addEventListener('click', saveSettings);
  $('test-btn').addEventListener('click', testConnection);
  $('clear-btn').addEventListener('click', clearSettings);

  // Reset property mapping to defaults
  const resetBtn = $('reset-map-btn');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      $('map-name').value = 'Name';
      $('map-headline').value = 'Job Title';
      $('map-company').value = 'Organisation';
      $('map-profileUrl').value = 'LinkedIn';
      $('map-profilePicture').value = 'Profile Photo';
      showStatus('Property names reset to defaults.');
    });
  }

  // Allow Enter key to save
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (document.activeElement.id === 'notion-token' || document.activeElement.id === 'database-id')) {
      saveSettings();
    }
  });

  // Quick hint when user pastes a full Notion DB URL into the ID field
  $('database-id').addEventListener('paste', (e) => {
    setTimeout(() => {
      const val = e.target.value;
      // Extract ID if they pasted a full URL
      const match = val.match(/[0-9a-f]{32}/i);
      if (match && val.includes('notion.so')) {
        e.target.value = match[0];
        showStatus('Extracted Database ID from URL.');
      }
    }, 10);
  });

  // --- Debug / Corpus tools ---
  setupDebugTools();
}

async function initPopup() {
  await loadCurrentSettings();
  setupEventListeners();

  // Show a friendly message if nothing is configured yet
  const tokenField = $('notion-token');
  setTimeout(() => {
    if (!tokenField.value) {
      // Don't spam, just leave the placeholder visible
    }
  }, 600);

  // Keyboard accessibility: focus first empty field
  if (!tokenField.value) {
    tokenField.focus();
  } else {
    $('database-id').focus();
  }
}

document.addEventListener('DOMContentLoaded', initPopup);

/* ========================= Debug / Golden Profile Tools ========================= */

let lastCapturedData = null; // holds the full capture result so we can build final JSON

function setupDebugTools() {
  const captureBtn = $('capture-btn');
  const previewBtn = $('preview-btn');
  const captureResults = $('capture-results');
  const previewResults = $('preview-results');
  const copyJsonBtn = $('copy-json-btn');

  if (captureBtn) {
    captureBtn.addEventListener('click', async () => {
      captureResults.classList.add('hidden');
      previewResults.classList.add('hidden');

      captureBtn.disabled = true;
      captureBtn.textContent = 'Capturing...';

      try {
        const res = await chrome.runtime.sendMessage({ action: 'CAPTURE_PROFILE' });

        if (!res || !res.success) {
          showStatus('Capture failed: ' + (res?.error || 'Unknown error'), true);
          return;
        }

        lastCapturedData = res.data;

        // Prefill ground truth using the extractor output (user only corrects)
        if ($('gt-name')) $('gt-name').value = lastCapturedData.extractionAtCapture?.name || '';
        if ($('gt-jobTitle')) $('gt-jobTitle').value = lastCapturedData.extractionAtCapture?.jobTitle || '';
        if ($('gt-organisation')) $('gt-organisation').value = lastCapturedData.extractionAtCapture?.organisation || '';

        captureResults.classList.remove('hidden');

        const photoInfo = lastCapturedData.extractionAtCapture?.profilePictureUrl 
          ? `Photo detected: ${lastCapturedData.extractionAtCapture.profilePictureUrl.substring(0, 80)}...`
          : 'No profile photo detected on this page.';

        $('capture-status').textContent = `Captured from current tab. ${photoInfo} Please review and correct the Ground Truth values above.`;

      } catch (err) {
        showStatus('Capture failed: ' + (err.message || err), true);
      } finally {
        captureBtn.disabled = false;
        captureBtn.textContent = 'Capture Current Profile';
      }
    });
  }

  if (copyJsonBtn) {
    copyJsonBtn.addEventListener('click', () => {
      if (!lastCapturedData) {
        $('capture-status').textContent = 'Nothing captured yet.';
        return;
      }

      // Build final golden profile object, using user-corrected ground truth
      const finalProfile = {
        id: generateProfileId(),
        url: lastCapturedData.url,
        capturedAt: lastCapturedData.capturedAt,
        documentTitle: lastCapturedData.documentTitle,
        groundTruth: {
          name: $('gt-name')?.value.trim() || lastCapturedData.extractionAtCapture?.name || '',
          jobTitle: $('gt-jobTitle')?.value.trim() || lastCapturedData.extractionAtCapture?.jobTitle || '',
          organisation: $('gt-organisation')?.value.trim() || lastCapturedData.extractionAtCapture?.organisation || ''
        },
        raw: lastCapturedData.raw,
        extractionAtCapture: lastCapturedData.extractionAtCapture,
        notes: ''
      };

      const json = JSON.stringify(finalProfile, null, 2);
      navigator.clipboard.writeText(json).then(() => {
        $('capture-status').textContent = 'JSON copied to clipboard! Paste into fixtures/profiles/your-name-YYYY-MM-DD.json';
        setTimeout(() => {
          if ($('capture-status')) $('capture-status').textContent = '';
        }, 4500);
      }).catch(() => {
        // Fallback: show in a prompt
        prompt('Copy this JSON and save as a new file in fixtures/profiles/', json);
      });
    });
  }

  if (previewBtn) {
    previewBtn.addEventListener('click', async () => {
      captureResults.classList.add('hidden');
      previewResults.classList.add('hidden');

      previewBtn.disabled = true;
      previewBtn.textContent = 'Running...';

      try {
        const res = await chrome.runtime.sendMessage({ action: 'PREVIEW_EXTRACTION' });

        if (!res || !res.success) {
          $('preview-status').textContent = 'Preview failed: ' + (res?.error || 'Unknown');
          previewResults.classList.remove('hidden');
          return;
        }

        const p = res.profile || {};
        const pageText = res.pageText || '';
        let photoHtml = '';
        if (p.profilePictureUrl) {
          photoHtml = `
            <div style="margin: 4px 0;">
              <strong>Profile Photo:</strong> 
              <a href="${escapeHtml(p.profilePictureUrl)}" target="_blank" style="color:#0a66c2; word-break: break-all;">${escapeHtml(p.profilePictureUrl)}</a>
            </div>
          `;

          // Show debug info if the extractor provided it (very useful for diagnosing wrong photos)
          if (p.profilePictureDebug) {
            const d = p.profilePictureDebug;
            photoHtml += `
              <div style="font-size: 10px; color: #666; margin-left: 12px; line-height: 1.3;">
                <strong>source:</strong> ${escapeHtml(d.sourceTier || 'unknown')}<br>
                alt: "${escapeHtml(d.chosenAlt || '(empty)')}"<br>
                timestamp: ${d.parsedTimestamp || 'n/a'}<br>
                in person-svg figure: ${d.wasInPersonFigure ? 'yes' : 'no'} | in main container: ${d.wasInMainContainer ? 'yes' : 'no'}<br>
                ${d.chosenSrcsetSnippet ? `<span style="font-family:monospace; font-size:9px; word-break:break-all;">srcset: ${escapeHtml(d.chosenSrcsetSnippet)}</span><br>` : ''}
              </div>
            `;
          }
        } else {
          photoHtml = `<div><strong>Profile Photo:</strong> <span style="color:#dc2626;">Not detected</span></div>`;
        }
        const html = `
          <div><strong>Name:</strong> ${escapeHtml(p.fullName || '(empty)')}</div>
          <div><strong>Job Title:</strong> ${escapeHtml(p.headline || '(empty)')}</div>
          <div><strong>Organisation:</strong> ${escapeHtml(p.currentCompany || '(empty)')}</div>
          ${photoHtml}
          ${p._debug ? `<div style="margin-top:4px; font-size:10px; color:#888;"><strong>Debug:</strong> firstExp=${p._debug.firstExpFound}, tag=${p._debug.firstExpTag}, headlineSource=${p._debug.headlineSource}, companySource=${p._debug.companySource}</div>` : ''}
          <div style="margin-top:6px; font-size:11px; color:#666;">
            Extracted via current logic. Add a golden profile + improve strategies for better reliability.
          </div>
        `;
        $('preview-output').innerHTML = html;
        $('preview-status').textContent = 'This is what the extension would currently extract on this tab.';
        previewResults.classList.remove('hidden');

        // Show Grok correction button if xAI key is configured
        const grokBtn = $('grok-correct-btn');
        const grokResults = $('grok-results');
        grokResults.style.display = 'none';
        grokResults.innerHTML = '';
        try {
          const settings = await chrome.runtime.sendMessage({ action: 'GET_SETTINGS' });
          console.log('[LinkedIn→Notion] GET_SETTINGS response:', settings);
          if (settings?.xaiApiKey) {
            console.log('[LinkedIn→Notion] xAI key found, showing Grok button');
            grokBtn.style.display = 'inline-block';
            grokBtn.onclick = () => runGrokCorrection(p, pageText);
          } else {
            grokBtn.style.display = 'none';
          }
        } catch (_) { grokBtn.style.display = 'none'; }

      } catch (err) {
        $('preview-status').textContent = 'Preview failed: ' + (err.message || err);
        previewResults.classList.remove('hidden');
      } finally {
        previewBtn.disabled = false;
        previewBtn.textContent = 'Preview Extraction';
      }
    });
  }

  // Golden profile comparison for mismatch highlighting
  const compareBtn = $('compare-golden-btn');
  if (compareBtn) {
    compareBtn.addEventListener('click', async () => {
      const textarea = $('golden-json');
      const resultsDiv = $('compare-results');
      const statusDiv = $('compare-status');

      resultsDiv.style.display = 'none';
      statusDiv.textContent = '';

      let golden;
      try {
        golden = JSON.parse(textarea.value.trim());
      } catch (e) {
        statusDiv.textContent = 'Invalid JSON. Please paste the full contents of a fixtures/profiles/*.json file.';
        return;
      }

      const gt = golden.groundTruth || {};

      compareBtn.disabled = true;
      compareBtn.textContent = 'Comparing...';

      try {
        const res = await chrome.runtime.sendMessage({ action: 'PREVIEW_EXTRACTION' });

        if (!res || !res.success) {
          statusDiv.textContent = 'Could not get current extraction: ' + (res?.error || 'Unknown error');
          return;
        }

        const extracted = res.profile || {};

        const fields = [
          { key: 'fullName', label: 'Name', gtKey: 'name' },
          { key: 'headline', label: 'Job Title', gtKey: 'jobTitle' },
          { key: 'currentCompany', label: 'Organisation', gtKey: 'organisation' },
          { key: 'profilePictureUrl', label: 'Profile Photo', gtKey: 'profilePictureUrl' }
        ];

        let html = '<table style="width:100%; font-size:12px; border-collapse: collapse;">';
        html += '<tr style="background:#f1f5f9;"><th style="text-align:left;padding:4px;border:1px solid #ddd;">Field</th><th style="text-align:left;padding:4px;border:1px solid #ddd;">Extracted</th><th style="text-align:left;padding:4px;border:1px solid #ddd;">Ground Truth</th><th style="padding:4px;border:1px solid #ddd;">Match</th></tr>';

        fields.forEach(f => {
          const extVal = (extracted[f.key] || '').trim();
          const gtVal = (gt[f.gtKey] || '').trim();
          const match = extVal.toLowerCase() === gtVal.toLowerCase() && extVal !== '';
          const matchHtml = match 
            ? '<span style="color:#16a34a;font-weight:600;">✅ Match</span>' 
            : '<span style="color:#dc2626;font-weight:600;">❌ Mismatch</span>';

          html += `<tr>
            <td style="padding:4px;border:1px solid #ddd;font-weight:500;">${f.label}</td>
            <td style="padding:4px;border:1px solid #ddd;">${escapeHtml(extVal || '(empty)')}</td>
            <td style="padding:4px;border:1px solid #ddd;">${escapeHtml(gtVal || '(empty)')}</td>
            <td style="padding:4px;border:1px solid #ddd;text-align:center;">${matchHtml}</td>
          </tr>`;
        });

        html += '</table>';

        if (golden.url && extracted.profileUrl) {
          const urlMatch = golden.url.includes(extracted.profileUrl.split('/').pop().split('?')[0]);
          html += `<div style="margin-top:6px;font-size:11px;">Profile URL in golden: ${escapeHtml(golden.url)} ${urlMatch ? '✅' : ''}</div>`;
        }

        resultsDiv.innerHTML = html;
        resultsDiv.style.display = 'block';
        statusDiv.textContent = 'Comparison complete. Green = good extraction on this profile.';

      } catch (err) {
        statusDiv.textContent = 'Comparison failed: ' + (err.message || err);
      } finally {
        compareBtn.disabled = false;
        compareBtn.textContent = 'Compare with Current Tab';
      }
    });
  }
}

async function runGrokCorrection(profile, pageText) {
  const grokBtn = $('grok-correct-btn');
  const grokResults = $('grok-results');
  grokBtn.disabled = true;
  grokBtn.textContent = 'Correcting with Grok...';
  grokResults.style.display = 'block';
  grokResults.innerHTML = '<div style="font-size:11px;color:#666;">Contacting xAI API...</div>';

  try {
    const res = await chrome.runtime.sendMessage({
      action: 'CORRECT_WITH_GROK',
      profile,
      pageText
    });

    if (!res || !res.success) {
      grokResults.innerHTML = `<div style="color:#dc2626;font-size:11px;">Grok correction failed: ${escapeHtml(res?.error || 'Unknown')}</div>`;
      return;
    }

    const c = res.corrected || {};
    const changed = (c.headline && c.headline !== profile.headline) || (c.currentCompany && c.currentCompany !== profile.currentCompany);

    let html = '<div style="border-top:1px solid #ddd;padding-top:6px;margin-top:6px;">';
    html += '<div style="font-weight:600;font-size:11px;margin-bottom:4px;">Grok-Corrected Values</div>';

    const row = (label, heuristic, corrected) => {
      const h = escapeHtml(heuristic || '(empty)');
      const c2 = escapeHtml(corrected || '(empty)');
      const diff = h !== c2;
      if (!diff && !corrected) return '';
      return `<div style="font-size:11px;margin:2px 0;display:flex;gap:8px;">
        <span style="min-width:70px;font-weight:500;">${label}:</span>
        <span style="color:#888;text-decoration:${diff ? 'line-through' : 'none'};">${h}</span>
        ${diff ? `<span style="color:#16a34a;font-weight:600;">→ ${c2}</span>` : `<span>${c2}</span>`}
      </div>`;
    };

    html += row('Name', profile.fullName, c.fullName);
    html += row('Job Title', profile.headline, c.headline);
    html += row('Organisation', profile.currentCompany, c.currentCompany);

    if (!changed) {
      html += '<div style="font-size:10px;color:#888;margin-top:4px;">Grok agrees with heuristic extraction — no corrections.</div>';
    }

    html += '</div>';
    grokResults.innerHTML = html;
  } catch (err) {
    grokResults.innerHTML = `<div style="color:#dc2626;font-size:11px;">Grok correction failed: ${escapeHtml(err.message || err)}</div>`;
  } finally {
    grokBtn.disabled = false;
    grokBtn.textContent = 'Correct with Grok';
  }
}

function generateProfileId() {
  const date = new Date().toISOString().slice(0, 10);
  const rand = Math.random().toString(36).substring(2, 7);
  return `profile-${date}-${rand}`;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[m]);
}

// Optional: expose for console debugging
window.LINKEDIN_NOTION_DEBUG = { lastCapturedData: () => lastCapturedData };

