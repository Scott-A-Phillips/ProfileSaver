/**
 * LinkedIn to Notion - Content Script
 * Runs on linkedin.com/* pages.
 * - Detects profile and company pages
 * - Extracts structured data (name, headline, company, location, about, experience)
 * - Injects a "Save to Notion" button (floating + attempts native placement)
 * - Shows success/error toasts
 * - Communicates with background service worker for Notion API calls
 */

(() => {
  const BUTTON_ID = 'lin-to-notion-btn';
  const SHADOW_HOST_ID = 'lin-to-notion-shadow-host';
  const TOAST_SHADOW_HOST_ID = 'lin-to-notion-toast-shadow-host';
  const TOAST_CONTAINER_ID = 'lin-to-notion-toast-container';

  function isExtensionContextValid() {
    try {
      return !!(chrome && chrome.runtime && chrome.runtime.id);
    } catch (_) {
      return false;
    }
  }

  function hasExistingButton() {
    return !!document.getElementById(BUTTON_ID) || !!document.getElementById(SHADOW_HOST_ID);
  }

  function hasExistingToastHost() {
    return !!document.getElementById(TOAST_SHADOW_HOST_ID);
  }

  let lastExtracted = null;
  let injectionObserver = null;
  let safetyInterval = null;
  let toastShadowHost = null;

  /* --------------------------- Utility helpers --------------------------- */

  function cleanText(str) {
    if (!str) return '';
    return str.replace(/\s+/g, ' ').trim().slice(0, 2000);
  }

  function queryText(selectors, maxLen = 500) {
    const list = Array.isArray(selectors) ? selectors : [selectors];
    for (const sel of list) {
      try {
        const el = document.querySelector(sel);
        if (el && el.innerText) {
          const t = cleanText(el.innerText);
          if (t) return t.slice(0, maxLen);
        }
      } catch (_) {}
    }
    return '';
  }

  function getMultipleTexts(selectors, limit = 20) {
    const results = [];
    const list = Array.isArray(selectors) ? selectors : [selectors];
    for (const sel of list) {
      try {
        const nodes = document.querySelectorAll(sel);
        nodes.forEach(n => {
          const t = cleanText(n.innerText || n.textContent);
          if (t && results.length < limit) results.push(t);
        });
      } catch (_) {}
    }
    return results;
  }

  /* ----------------------- Profile data extraction ----------------------- */

  function extractProfileData() {
    const url = window.location.href.split('?')[0];

    // Route company pages to their own extractor
    if (url.includes('linkedin.com/company/')) {
      return extractCompanyData();
    }

    // NAME - LinkedIn changes the DOM frequently; be very defensive here.
    // We try reliable sources (title + meta) first because h1 selectors are fragile.
    let fullName = '';

    // 1. Try document.title - usually the most reliable signal
    try {
      let t = document.title || '';
      // Handle both " - " and " | " separators, and strip LinkedIn suffix
      t = t.replace(/(\s*[|-]\s*LinkedIn.*)$/i, '').trim();
      const namePart = t.split(/\s*[-|]\s*/)[0].trim();
      if (namePart && namePart.length > 2 && namePart.length < 60) {
        fullName = namePart;
      }
    } catch (_) {}

    // 2. Try Open Graph title meta (often clean)
    if (!fullName || fullName.length < 3) {
      try {
        const og = document.querySelector('meta[property="og:title"]');
        if (og) {
          let t = og.getAttribute('content') || '';
          t = t.replace(/(\s*[|-]\s*LinkedIn.*)$/i, '').trim();
          const namePart = t.split(/\s*[-|]\s*/)[0].trim();
          if (namePart && namePart.length > 2 && namePart.length < 60) {
            fullName = namePart;
          }
        }
      } catch (_) {}
    }

    // 3. DOM-based attempts (h1 + aria-hidden) - only if title sources failed
    if (!fullName || fullName.length < 3) {
      fullName = queryText([
        'h1.break-words',
        'h1.text-heading-xlarge',
        'h1.inline',
        'h1.inline.t-24',
        '.pv-top-card h1',
        '.pv-top-card .ph5 h1',
        '.ph5 h1',
        'h1[data-locale-target="fullName"]',
        '.pv-text-details__left-panel h1',
        '[data-test-id="profile-name"] h1',
        'div[data-test-id="profile-name"]'
      ], 120) || '';
    }

    // 4. Aria-hidden spans inside the main h1 (common LinkedIn pattern)
    if (!fullName || fullName.length < 3) {
      try {
        const header = document.querySelector('.pv-top-card, .scaffold-layout-top-card, .ph5, main');
        if (header) {
          const h1 = header.querySelector('h1');
          if (h1) {
            const spans = h1.querySelectorAll('span[aria-hidden="true"]');
            if (spans.length > 0) {
              const parts = Array.from(spans)
                .map(s => cleanText(s.innerText || s.textContent))
                .filter(Boolean);
              const combined = cleanText(parts.join(' '));
              if (combined.length > 2 && combined.length < 70) {
                fullName = combined;
              }
            }
            if (!fullName || fullName.length < 3) {
              const t = cleanText(h1.innerText || h1.textContent);
              if (t && t.length > 2 && t.length < 70) fullName = t;
            }
          }
        }
      } catch (_) {}
    }

    // 5. Broad DOM scan as last resort before giving up
    if (!fullName || fullName.length < 3) {
      try {
        const candidates = document.querySelectorAll('h1, .text-heading-xlarge, .text-body-xlarge');
        for (const el of candidates) {
          const t = cleanText(el.innerText || el.textContent);
          if (t && t.length > 3 && t.length < 60 && /^[A-Z]/.test(t) && !t.includes(' at ') && !/premium|open to|follow|connect|linkedin/i.test(t)) {
            fullName = t;
            break;
          }
        }
      } catch (_) {}
    }

    if (!fullName || fullName.length < 3) {
      fullName = 'LinkedIn Profile';
    }

    // HEADLINE and CURRENT COMPANY (Job Title / Organisation) are the two fields
    // the user cares about most. Declare both early to avoid TDZ issues in the
    // defensive extraction blocks below.
    let headline = queryText([
      '.pv-top-card__headline',
      '[data-test-id="profile-headline"]',
      'div[data-test-id="profile-headline"]',
      'div[data-test-id*="headline"]',
      '.pv-top-card .ph5 .text-body-medium',
      '.ph5 .text-body-medium',
      '.text-body-medium.t-black--light.break-words',
      'h2.break-words.t-black--light',
      '.text-body-medium.break-words'
    ], 300);

    let currentCompany = '';

    // NOTE: The previous loose broad top-card scan for headline has been removed from here.
    // It was the main source of About-section text (and other long bio noise) leaking into Job Title.
    // Experience-derived extraction (below) now runs first and takes precedence.
    // A much stricter low-priority version of the broad scan is inserted later as a final fallback.

    // === High priority: Extract current Job Title and Organisation directly from first experience ===
    // This is the most reliable source for the fields the user cares about most.
    // Always attempt this (experience data takes precedence over generic headline selectors).
    // Inner isRole checks + !headline guards ensure we only set clean role/company data.
    if (true) {
      try {
        // Very aggressive selectors for the first/current experience entry
        let firstExp = document.querySelector(
          '#experience ~ .pvs-list__container .pvs-list__item, ' +
          'section#experience .pvs-list__item, ' +
          '[data-test-id*="experience-item"], ' +
          'div[data-test-id*="experience"] .pvs-list__item, ' +
          '.pvs-list__item--experience, ' +
          'div.pvs-list__item--experience, ' +
          'li.pvs-list__item, ' +
          '.artdeco-list__item, ' +
          'ul.pvs-list > li, ' +
          'section#experience ul > li, ' +
          'div#experience ~ div ul.pvs-list > li, ' +
          'li[data-test-id*="experience"], ' +
          'div.pvs-entity, ' +
          '#experience ~ div li, ' +
          'div[id*="experience"] li, ' +
          '#experience ~ * [class*="pvs-list"] > *'
        );

        // Fallback: grab the first list item or entity inside the experience section
        if (!firstExp) {
          const expContainer = document.querySelector('#experience, section[id*="experience"], div[id*="experience"]');
          if (expContainer) {
            firstExp = expContainer.querySelector(
              'li, .pvs-list__item, [data-test-id*="experience"], .artdeco-list__item, .pvs-entity, [class*="entity"]'
            );
          }
        }

        if (firstExp) {
          const blockText = cleanText(firstExp.innerText || firstExp.textContent);
          let lines = blockText.split('\n').map(l => cleanText(l)).filter(l => l.length > 2);

          if (lines.length >= 1) {
            // Strict filtered scan (same predicate as nuclear) + immediate following-line company pairing.
            for (let i = 0; i < Math.min(lines.length, 8); i++) {
              const line = lines[i];
              const isRole = line.length > 4 && line.length < 80 &&
                             !/^\d/.test(line) &&
                             !/linkedin/i.test(line) &&
                             !line.includes('·') &&
                             !line.includes('#') &&
                             !/Full-time|Part-time|Contract|Intern|Freelance|logo|more|show|see|view|expand|…|\.{3}/i.test(line) &&
                             !/^\d{4}|Present|present|20[0-9]{2}/i.test(line) &&
                             !line.includes('  ') &&
                             !/^As /i.test(line) &&
                             !/directs|led|responsible for|core areas|managed|oversaw/i.test(line) &&
                             !/\b(team|project|event|festival|diwali|hackathon|teamified|services?)\b/i.test(line) &&
                             !line.includes('http') && !line.includes('www.') && !/skill|top skill/i.test(line) &&
                             !/^\s*experience\s*$/i.test(line) && !/^\s*(about|skills?|featured|education|licenses?)\s*$/i.test(line) &&
               !/:$/.test(line) && !/key contributions?|responsibilities?|achievements?|projects?|highlights/i.test(line);

              if (isRole && !headline) {
                // Strip leading bullet markers from role text
                headline = line.replace(/^[-•]\s+/, '').trim();

                // Pair with the company line that follows this role (most reliable)
                for (let j = i + 1; j < Math.min(lines.length, i + 8); j++) {
                  const next = lines[j];
                  if (next.length > 2 && next.length < 70 && !/^\d{4}|Present|yr|yrs|mo|mos/i.test(next) && !next.includes('•') && !/:$/.test(next) && !/key contributions?|responsibilities?|achievements?|projects?|highlights/i.test(next) && !/^[-•]\s/.test(next)) {
                    if (next.includes('·')) {
                      const comp = next.split('·')[0].trim();
                      if (comp.length > 2 && comp.length < 70 && !currentCompany) {
                        currentCompany = comp;
                      }
                    } else if (!currentCompany && next.length > 3 && !/logo|Full-time|Part-time|more/i.test(next)) {
                      currentCompany = next;
                    }
                    if (currentCompany) break;
                  }
                }
                break;
              }
            }

            // Fallback · scan for company inside this block (if pairing didn't catch it)
            if (!currentCompany) {
              for (let i = 0; i < Math.min(lines.length, 6); i++) {
                const line = lines[i];
                if (line.includes('·') && !/logo/i.test(line)) {
                  const comp = line.split('·')[0].trim();
                  if (comp.length > 2 && comp.length < 70) {
                    currentCompany = comp;
                    break;
                  }
                }
              }
            }
          }
        }
      } catch (_) {}
    }

    // Nuclear text-based fallback for Job Title (headline) and Organisation.
    // We strongly prefer to anchor on the actual Experience *section* in the DOM
    // (via #experience or similar) rather than the first occurrence of the word
    // "Experience" anywhere in body.innerText. The latter often grabs noise from
    // Activity, recommendations, "Share your experience", event posts, hashtags, etc.
    // Only if we cannot find a real experience container do we fall back to the
    // global scan. Both this path and the high-priority DOM path above now use
    // identical strict filtering + role+company pairing.
    if (!headline || !currentCompany) {
      try {
        // 1. Best: locate the real Experience section or its list container
        let expContainer = document.querySelector(
          '#experience, section#experience, [id*="experience"], ' +
          'section[data-section="experience"], div[data-test-id*="experience"]'
        );
        if (!expContainer) {
          expContainer = document.querySelector(
            '#experience ~ .pvs-list__container, section#experience ~ * .pvs-list, ' +
            '[id*="experience"] ~ .pvs-list, .pvs-list__container'
          );
        }

        let chunk = '';
        if (expContainer) {
          chunk = (expContainer.innerText || expContainer.textContent || '').slice(0, 2200);
        } else {
          // 2. Much better last-resort: find actual "Experience" heading elements in the DOM
          // instead of blind string search on body text (which grabs noise from About, Skills, etc.)
          try {
            const headings = Array.from(document.querySelectorAll('h1, h2, h3, [role="heading"], div[aria-label], span[aria-label]'));
            const expHeading = headings.find(h => {
              const txt = (h.innerText || h.textContent || '').trim().toLowerCase();
              return txt === 'experience' || txt === 'experience ' || txt.startsWith('experience');
            });
            if (expHeading) {
              // Take the parent section or the next few siblings' text
              let parent = expHeading.closest('section') || expHeading.parentElement?.parentElement || expHeading.parentElement;
              if (parent) {
                chunk = (parent.innerText || parent.textContent || '').slice(0, 2200);
              } else {
                // Fallback to following siblings
                let sibling = expHeading.nextElementSibling;
                let collected = '';
                let count = 0;
                while (sibling && count < 5) {
                  collected += (sibling.innerText || sibling.textContent || '') + '\n';
                  sibling = sibling.nextElementSibling;
                  count++;
                }
                chunk = collected.slice(0, 2200);
              }
            }
          } catch (_) {}

          // Ultimate crude fallback (rarely used now)
          if (!chunk) {
            const bodyText = document.body.innerText || document.body.textContent || '';
            const expIndex = bodyText.toLowerCase().indexOf('experience');
            if (expIndex !== -1) {
              chunk = bodyText.substring(expIndex, expIndex + 1800);
            }
          }
        }

        if (chunk) {
          const lines = chunk.split('\n').map(l => cleanText(l)).filter(l => l.length > 2);

          // Pick first good role-like line. Then immediately look at the following
          // 1-3 lines for the associated company (· line preferred, then plausible next line).
          for (let i = 0; i < Math.min(lines.length, 10); i++) {
            const line = lines[i];

            const isRole = line.length > 4 && line.length < 80 &&
                           !/^\d/.test(line) &&
                           !/linkedin/i.test(line) &&
                           !line.includes('·') &&
                           !line.includes('#') &&
                           !/Full-time|Part-time|Contract|Intern|Freelance|logo|more|show|see|view|expand|…|\.{3}/i.test(line) &&
                           !/^\d{4}|Present|present|20[0-9]{2}/i.test(line) &&
                           !line.includes('  ') &&
                           !/^As /i.test(line) &&
                           !/directs|led|responsible for|core areas|managed|oversaw/i.test(line) &&
                           !/\b(team|project|event|festival|diwali|hackathon|teamified|services?)\b/i.test(line) &&
                           !line.includes('http') && !line.includes('www.') && !/skill|top skill/i.test(line) &&
                           !/^\s*experience\s*$/i.test(line) && !/^\s*(about|skills?|featured|education|licenses?)\s*$/i.test(line) &&
               !/:$/.test(line) && !/key contributions?|responsibilities?|achievements?|projects?|highlights/i.test(line);

            if (isRole && !headline) {
              // Strip leading bullet markers from role text
              headline = line.replace(/^[-•]\s+/, '').trim();

              // Pair with the company line that follows this role (most reliable)
              for (let j = i + 1; j < Math.min(lines.length, i + 8); j++) {
                const next = lines[j];
                if (next.length > 2 && next.length < 70 && !/^\d{4}|Present|yr|yrs|mo|mos/i.test(next) && !next.includes('•') && !/:$/.test(next) && !/key contributions?|responsibilities?|achievements?|projects?|highlights/i.test(next) && !/^[-•]\s/.test(next)) {
                  if (next.includes('·')) {
                    const comp = next.split('·')[0].trim();
                    if (comp.length > 2 && comp.length < 70 && !currentCompany) {
                      currentCompany = comp;
                    }
                  } else if (!currentCompany && next.length > 3 && !/logo|Full-time|Part-time|more/i.test(next)) {
                    currentCompany = next;
                  }
                  if (currentCompany) break;
                }
              }
              break;
            }
          }

          // Independent · scan as additional fallback for company (if role-pairing didn't catch it)
          if (!currentCompany) {
            for (let i = 0; i < Math.min(lines.length, 10); i++) {
              const line = lines[i];
              if (line.includes('·') && !/logo/i.test(line)) {
                const comp = line.split('·')[0].trim();
                if (comp.length > 2 && comp.length < 70) {
                  currentCompany = comp;
                  break;
                }
              }
            }
          }
        }
      } catch (_) {}
    }

    // Final sanity: if headline still looks like obvious UI junk ("...more", "services", etc.)
    // despite all the filters, clear it so the document.title fallbacks below can still win.
    if (headline) {
      const hLower = headline.toLowerCase();
      if (hLower.includes('more') || hLower.includes('show') || hLower.includes('...') ||
          hLower.includes('…') || /^\s*(services?|solutions?|consulting)\s*$/i.test(headline) ||
          headline.length < 4) {
        headline = '';
      }
    }

    // Fallback for profiles without a traditional Experience section (common for consultants, founders, freelancers)
    // Scan early prominent text for role + company patterns (e.g. "CEO + Founder", "Founder at Company")

    // Clear obviously bad headlines that leaked from section headings or About-section text
    if (headline && /^\s*(experience|about|skills?|featured|education|licenses?)\s*$/i.test(headline)) {
      headline = '';
    }
    if (headline && (headline.includes('core expertise') || headline.includes('My core') || headline.includes('about me') || /^I\s[a-z]/.test(headline))) {
      headline = '';
    }

    if (!headline || !currentCompany) {
      try {
        const main = document.querySelector('main, .scaffold-layout, #about, [data-section="summary"], .pv-top-card') || document.body;
        const text = cleanText(main.innerText || main.textContent);
        const lines = text.split('\n').map(l => cleanText(l)).filter(l => l.length > 4 && l.length < 120);

        for (let i = 0; i < Math.min(lines.length, 25); i++) {
          const line = lines[i];
          if (/CEO|Founder|Principal|Director|Consultant|Owner|Head of/i.test(line) &&
              !/http|www\.|\.com|skill|top skill|more|services/i.test(line)) {

            if (line.includes(' at ')) {
              const parts = line.split(/\s+at\s+/i);
              if (!headline && parts[0]) headline = cleanText(parts[0]);
              if (!currentCompany && parts[1]) currentCompany = cleanText(parts[1]);
            } else if (line.includes(' + ') || line.includes(' and ')) {
              // Common for independent founders/consultants: "CEO + Founder" — keep as role
              if (!headline) headline = line;
            } else if (!headline) {
              headline = line;
            }
            if (headline && currentCompany) break;
          }
        }
      } catch (_) {}
    }

    // Very low-priority broad top-card scan (last-resort fallback only).
    // Extremely restricted compared to the old version: short length, no sentence punctuation,
    // no common About/bio openers. This prevents long About-section paragraphs from ever
    // becoming the Job Title.
    if (!headline || headline.length < 5) {
      try {
        const top = document.querySelector('.pv-top-card, .ph5 .pv-top-card, .scaffold-layout-top-card');
        if (top) {
          // Prefer known headline containers; avoid blanket div/span/p that can reach the About section
          const candidates = top.querySelectorAll(
            '.pv-top-card__headline, .text-body-medium.break-words, h2.break-words, [data-test-id*="headline"]'
          );
          let best = '';
          candidates.forEach(el => {
            const t = cleanText(el.innerText || el.textContent);
            // Very strict: short, title-case-ish, no periods/questions, no bio verbs or openers
            const looksLikeTitle = t.length > 5 && t.length < 120 &&
                                   !t.includes('.') && !t.includes('?') && !t.includes('!') &&
                                   !/^I\s|^I'm|^As\s|^Passionate|^Experienced|^Helping|^Building|^Leading/i.test(t) &&
                                   !/responsible|led|managed|oversaw|directs|core areas/i.test(t) &&
                                   !/\b(more|show|services?|solutions?)\b/i.test(t);
            if (looksLikeTitle && t.length > best.length) {
              best = t;
            }
          });
          if (best) headline = best;
        }
      } catch (_) {}
    }

    // Strong fallback from document.title for Job Title (and Organisation)
    try {
      let title = document.title || '';
      title = title.replace(/\s*[|-]\s*LinkedIn.*$/i, '').trim();

      const parts = title.split(/\s*[-|]\s*/);
      if (parts.length >= 2) {
        let afterName = cleanText(parts[1]);

        // Safety: never use LinkedIn as headline
        if (/^linkedin$/i.test(afterName) || /linkedin/i.test(afterName)) {
          afterName = '';
        }

        if (afterName.length > 2) {
          if (afterName.includes(' at ')) {
            const [possibleTitle, possibleOrg] = afterName.split(' at ');
            if (!headline && possibleTitle) {
              headline = cleanText(possibleTitle);
            }
            if (!currentCompany && possibleOrg) {
              currentCompany = cleanText(possibleOrg);
            }
          } else if (!headline) {
            // Pure job title case
            headline = afterName;
          }
        }
      }

      // Last-chance title fallback for Job Title if still empty
      if (!headline || headline.length < 3) {
        let cleanTitle = document.title.replace(/\s*[|-]\s*LinkedIn.*$/i, '').trim();
        const tparts = cleanTitle.split(/\s*[-|]\s*/);
        if (tparts.length >= 2) {
          let candidate = cleanText(tparts[1]);
          if (candidate.includes(' at ')) {
            candidate = cleanText(candidate.split(' at ')[0]);
          }
          if (candidate.length > 2 && !/linkedin/i.test(candidate)) {
            headline = candidate;
          }
        }
      }
    } catch (_) {}

    // LOCATION - selectors + broad top area scan
    let location = queryText([
      '.text-body-small.inline.t-black--light.break-words',
      '.pv-top-card .ph5 .text-body-small.inline',
      '.pv-top-card__location',
      '.text-body-small.t-black--light.break-words',
      '[data-test-id*="location"]',
      'span.text-body-small.inline.t-black--light'
    ], 200);

    if (!location || location.length < 3) {
      try {
        const top = document.querySelector('.pv-top-card, .ph5, .scaffold-layout-top-card, main');
        if (top) {
          const candidates = top.querySelectorAll('span, div');
          candidates.forEach(el => {
            const t = cleanText(el.innerText || el.textContent);
            // Heuristic for location: contains comma or looks like "City, Country"
            if (t.length > 4 && t.length < 80 && /[A-Za-z].*,/.test(t) && t.length > (location?.length || 0)) {
              location = t;
            }
          });
        }
      } catch (_) {}
    }

    // CURRENT COMPANY (best effort) - significantly hardened
    // (let currentCompany declared early near headline to prevent TDZ ReferenceErrors)
    if (headline && headline.includes(' at ')) {
      currentCompany = cleanText(headline.split(' at ').pop()).slice(0, 120);
    }

    // Try to find current company directly in the top card area
    if (!currentCompany) {
      try {
        const top = document.querySelector('.pv-top-card, .ph5, .scaffold-layout-top-card');
        if (top) {
          const candidates = top.querySelectorAll(
            '[data-test-id*="company"], .text-body-small.t-black--light.break-words, .pv-top-card__headline + *'
          );
          for (const el of candidates) {
            const t = cleanText(el.innerText || el.textContent);
            if (t && t.length > 2 && t.length < 80 && !t.includes('@') && !t.includes(',') &&
                !t.includes('http') && !t.includes('www.') && !/skill|top skill|featured|license|certif/i.test(t)) {
              currentCompany = t;
              break;
            }
          }
        }
      } catch (_) {}
    }

    // Strong pass: Extract company from the very first experience entry (most reliable on modern profiles)
    if (!currentCompany) {
      try {
        const firstExpItem = document.querySelector(
          '#experience ~ .pvs-list__container .pvs-list__item, ' +
          'section#experience .pvs-list__item, ' +
          '[data-test-id="experience-item"], ' +
          '.pvs-list__item--experience, ' +
          'div[data-test-id*="experience"] .pvs-list__item, ' +
          'div.pvs-list__item--experience'
        );
        if (firstExpItem) {
          // Get all visible text from the first experience block
          const allText = cleanText(firstExpItem.innerText || firstExpItem.textContent);
          const lines = allText.split('\n').map(l => cleanText(l)).filter(l => l.length > 2);

          // Very permissive: take the longest plausible company-like line from the first experience block
          let bestCompany = '';
          for (let i = 0; i < Math.min(lines.length, 8); i++) {
            const line = lines[i];
            if (line.length > 3 && line.length < 80 && !/\d{4}|Present|present|yr|yrs|mo|mos/i.test(line) && !line.includes('•') &&
                !line.includes('http') && !line.includes('www.') && !/skill|top skill|featured/i.test(line)) {
              if (line.length > bestCompany.length) {
                bestCompany = line;
              }
            }
          }
          if (bestCompany) currentCompany = bestCompany;

          // Removed the previous blind "second line" fallback as it was frequently picking
          // date/tenure lines instead of company names.


          // Additional targeted selectors for company name inside experience item
          if (!currentCompany) {
            const companyEl = firstExpItem.querySelector(
              '[data-test-id*="company"], .pvs-entity__subtitle, span[aria-hidden="true"]'
            );
            if (companyEl) {
              const t = cleanText(companyEl.innerText || companyEl.textContent);
              if (t && t.length > 2 && t.length < 80) {
                currentCompany = t;
              }
            }
          }
        }
      } catch (_) {}
    }

    // ABOUT SECTION - very flaky across LinkedIn versions
    let about = queryText([
      '#about + * .inline-show-more-text__text-full',
      '#about ~ div .break-words',
      'section[data-section="summary"] .break-words',
      '[data-testid="about-section"] .inline-show-more-text',
      '.pv-about-section .pv-about__summary-text',
      '#about ~ .pvs-list__container .pvs-list__item .inline-show-more-text'
    ], 2500);

    // If still empty, try scanning for "About" heading and taking next visible text block
    if (!about) {
      try {
        const aboutHeadings = Array.from(document.querySelectorAll('h2, .pvs-header__title'))
          .filter(h => /about/i.test(h.innerText || ''));
        if (aboutHeadings.length) {
          const container = aboutHeadings[0].closest('section') || aboutHeadings[0].parentElement?.parentElement;
          if (container) {
            const textEl = container.querySelector('.break-words, .inline-show-more-text, p');
            if (textEl) about = cleanText(textEl.innerText).slice(0, 2500);
          }
        }
      } catch (_) {}
    }

    // EXPERIENCE HIGHLIGHTS (top 5 entries)
    const experience = [];
    try {
      // Modern LinkedIn experience list items — expanded selectors
      const expItems = document.querySelectorAll([
        '#experience ~ .pvs-list__container .pvs-list__item',
        '#experience + * .pvs-list__item',
        'section#experience .pvs-list__item',
        '.pvs-list__item--experience',
        '[data-test-id="experience-item"]',
        'div[data-test-id*="experience"] .pvs-list__item'
      ].join(','));

      expItems.forEach((item, idx) => {
        if (idx >= 5) return;

        // Use the full visible text of the experience block (more robust to DOM changes)
        const blockText = cleanText(item.innerText || item.textContent);
        if (blockText.length > 10) {
          // Split into logical lines and clean
          const lines = blockText.split('\n').map(l => cleanText(l)).filter(l => l.length > 2);
          if (lines.length > 0) {
            // Take first 3-4 meaningful lines as a compact highlight
            const entry = lines.slice(0, 4).join(' • ');
            if (entry.length > 8) experience.push(entry);
          }
        }
      });
    } catch (_) {}

    // Fallback experience extraction if above failed
    if (experience.length === 0) {
      const fallback = getMultipleTexts('#experience ~ * .pvs-list__item .break-words, .experience-item', 5);
      fallback.forEach(t => {
        if (t.length > 8 && experience.length < 5) experience.push(t);
      });
    }

    // Try to improve currentCompany from first experience if still empty
    if (!currentCompany && experience.length > 0) {
      const first = experience[0];
      // Try several ways to pull the company out of the first experience line
      const match = first.match(/•\s*([^•]+?)\s*•/);
      if (match) {
        currentCompany = cleanText(match[1]).slice(0, 120);
      } else {
        // Fallback: take the second "word group" if it looks like a company
        const parts = first.split('•').map(p => cleanText(p)).filter(Boolean);
        if (parts.length >= 2) {
          const possibleCompany = parts[1];
          if (possibleCompany.length > 2 && possibleCompany.length < 60) {
            currentCompany = possibleCompany;
          }
        }
      }
    }

    // Last resort: parse company from document.title if still missing
    if (!currentCompany) {
      try {
        const title = document.title || '';
        if (title.includes(' at ')) {
          const parts = title.split(' at ');
          if (parts.length > 1) {
            const afterAt = cleanText(parts[1].split(/ [|-] /)[0]);
            if (afterAt && afterAt.length > 2 && afterAt.length < 60) {
              currentCompany = afterAt;
            }
          }
        }
      } catch (_) {}
    }

    // Very last broad fallback for Job Title (headline) - only if still empty
    if (!headline || headline.length < 3) {
      try {
        // Try the cleaned title one more time for the full second part
        let title = document.title || '';
        title = title.replace(/\s*[|-]\s*LinkedIn.*$/i, '').trim();
        const parts = title.split(/ [-|] /);
        if (parts.length >= 2) {
          let candidate = cleanText(parts[1]);
          if (candidate.includes(' at ')) candidate = candidate.split(' at ')[0];
          candidate = cleanText(candidate);
          if (candidate.length > 2 && !/linkedin/i.test(candidate)) {
            headline = candidate;
          }
        }
      } catch (_) {}
    }

    // Nuclear last resort for Job Title: aggressively parse the title for anything between name and LinkedIn/company
    if (!headline || headline.length < 3) {
      try {
        let title = document.title || '';
        // Remove name (everything before first major separator)
        const firstSep = title.search(/ [-|] /);
        if (firstSep > 3) {
          let rest = title.substring(firstSep + 1);
          rest = rest.replace(/\s*[|-]\s*LinkedIn.*$/i, '').trim();
          // Prefer text before " at " if present
          if (rest.includes(' at ')) rest = rest.split(' at ')[0];
          rest = cleanText(rest);
          if (rest.length > 2 && !/linkedin/i.test(rest)) {
            headline = rest;
          }
        }
      } catch (_) {}
    }

    // Profile picture (best effort, high-res if possible)
    // The ONLY reliable way to distinguish the official headshot from posted images,
    // "Featured" photos, About section images, etc. is the presence of the LinkedIn
    // person placeholder SVG (id^="person-") inside the same <figure> (or tight photo
    // wrapper) as the real <img>. Posted content never includes that SVG.
    let profilePictureUrl = '';
    // These must be declared in the outer scope (not inside try) so the photoDebug
    // construction after the catch block can always see them without ReferenceError.
    let img = null;
    let photoTier = 'none';
    let chosenImgForDebug = null;

    try {
      // === Tier 0 (STRICT): The person-SVG figure is the gold standard marker ===
      // User-supplied ground truth: the official headshot lives in a <figure> that
      // contains BOTH <svg id="person-accent-N" ...> (placeholder) AND the real profile
      // <img> (often with crop_800_800 in its srcset, while .src may be a small scale_ version).
      // We deliberately ignore ALL other images on the page when this structure is present.
      const personSvgs = Array.from(document.querySelectorAll('svg[id^="person-"]'));
      let bestPersonFigureCandidate = null;
      let bestFigureScore = -1;

      for (const svg of personSvgs) {
        const fig = svg.closest('figure');
        if (!fig) continue;

        // Score figures: prefer ones that contain at least one qualifying profile photo img
        // (in src, srcset or data-src) and that are reasonably large in the layout.
        const figImgs = Array.from(fig.querySelectorAll('img'));
        let hasQualifyingImg = false;
        let figLargestDim = 0;

        figImgs.forEach(i => {
          const urls = ((i.getAttribute('src') || '') + ' ' + (i.getAttribute('srcset') || '') + ' ' + (i.getAttribute('data-src') || '')).toLowerCase();
          if (/licdn\.com\/dms\/image|profile-displayphoto/.test(urls)) {
            hasQualifyingImg = true;
          }
          const nw = i.naturalWidth || 0;
          const nh = i.naturalHeight || 0;
          if (nw + nh > figLargestDim) figLargestDim = nw + nh;
        });

        let score = 0;
        if (hasQualifyingImg) score += 100000;
        score += Math.min(figLargestDim, 2000); // larger rendered photo wins
        // Prefer figures that are direct children of known top-card photo wrappers
        if (fig.closest('.pv-top-card__photo, .pv-top-card-profile-picture, [data-test-id*="profile-photo"]')) {
          score += 50000;
        }

        if (score > bestFigureScore) {
          bestFigureScore = score;
          bestPersonFigureCandidate = fig;
        }
      }

      if (bestPersonFigureCandidate) {
        // Now collect EVERY img inside this trusted figure whose URLs mention the LinkedIn image CDN.
        // This is deliberately broader than before because the high-res version is frequently only
        // present in `srcset` (e.g. crop_800_800 entry) while the `src` may be a tiny scale_100 placeholder.
        const figureImgs = Array.from(bestPersonFigureCandidate.querySelectorAll('img'));
        const qualifying = [];

        figureImgs.forEach(candidate => {
          const src = candidate.getAttribute('src') || '';
          const srcset = candidate.getAttribute('srcset') || '';
          const dataSrc = candidate.getAttribute('data-src') || '';
          const allUrls = src + ' ' + srcset + ' ' + dataSrc;

          if (!/licdn\.com\/dms\/image|profile-displayphoto/i.test(allUrls)) return;

          // Compute a strong preference for the highest-quality variant we can see in this element
          let score = 100000; // base for being inside the person-SVG figure (extremely strong signal)

          const alt = (candidate.getAttribute('alt') || '').toLowerCase();
          if (alt.includes('profile photo')) score += 30000;
          const nameLower = (fullName || '').toLowerCase();
          if (nameLower && alt.includes(nameLower)) score += 25000;

          // Timestamp recency (higher = better, newer signatures)
          const tsMatch = allUrls.match(/\/0\/(\d+)/);
          if (tsMatch) score += parseInt(tsMatch[1]) / 25000;

          // Size preference from URL or srcset (crop_800_800 or shrink_800_800 wins)
          const sizeMatches = allUrls.matchAll(/shrink_(\d+)_(\d+)|crop_(\d+)_(\d+)/g);
          for (const m of sizeMatches) {
            const w = parseInt(m[1] || m[3] || '0', 10);
            const h = parseInt(m[2] || m[4] || '0', 10);
            score += (w + h) * 2;
          }

          // Natural size if the browser has already loaded it
          const natural = (candidate.naturalWidth || 0) + (candidate.naturalHeight || 0);
          score += natural * 0.5;

          // Slight penalty for obviously tiny images (avatars in lists etc.)
          if ((candidate.naturalWidth || 0) < 120 || (candidate.naturalHeight || 0) < 120) score -= 30000;

          qualifying.push({ el: candidate, score, src, srcset });
        });

        if (qualifying.length > 0) {
          qualifying.sort((a, b) => b.score - a.score);
          img = qualifying[0].el;
          chosenImgForDebug = img;
          photoTier = 'person-svg-figure';
        }
      }

      // If Tier 0 found nothing (some profiles use different photo markup without the person SVG),
      // fall back to the container-based heuristics. These are intentionally lower priority.

      // === Tier 1: Strongly prefer the official main profile photo in its dedicated container ===
      // This is by far the most reliable signal when the person-SVG marker is absent.
      if (!img) {
        const mainPhotoContainerSelectors = [
          '.pv-top-card__photo',
          '.pv-top-card-profile-picture',
          '[data-test-id*="profile-photo"]',
          'button[aria-label*="Photo"]'
        ];

        for (const selector of mainPhotoContainerSelectors) {
          const container = document.querySelector(selector);
          if (container) {
            const imgs = container.querySelectorAll('img[src*="licdn.com/dms/image"], img[src*="profile-displayphoto"]');
            let bestInContainer = null;
            let bestScore = -1;

            imgs.forEach(imgEl => {
              const src = imgEl.getAttribute('src') || '';
              let score = 100000;

              if (src.includes('profile-displayphoto')) score += 20000;

              const tsMatch = src.match(/\/0\/(\d+)/);
              if (tsMatch) score += parseInt(tsMatch[1]) / 30000;

              const sizeMatch = src.match(/shrink_(\d+)_(\d+)/);
              if (sizeMatch) score += parseInt(sizeMatch[1]) * 5 + parseInt(sizeMatch[2]);

              const natural = (imgEl.naturalWidth || 0) + (imgEl.naturalHeight || 0);
              score += natural;

              const alt = (imgEl.getAttribute('alt') || '').toLowerCase();
              if (alt.includes('profile photo')) score += 30000;
              const nameLower = (fullName || '').toLowerCase();
              if (nameLower && alt.includes(nameLower)) score += 25000;

              if (score > bestScore) {
                bestScore = score;
                bestInContainer = imgEl;
              }
            });

            if (bestInContainer) {
              img = bestInContainer;
              chosenImgForDebug = img;
              photoTier = 'main-photo-container';
              break;
            }
          }
        }
      }

      // === Tier 2: Careful fallback — only if Tier 1 completely failed ===
      // Be extremely strict here to avoid posted images.
      if (!img) {
        const headerArea = document.querySelector('.pv-top-card, .ph5, .scaffold-layout-top-card');
        if (headerArea) {
          const candidates = headerArea.querySelectorAll(
            '.pv-top-card__photo img, ' +
            '.pv-top-card-profile-picture img, ' +
            '[data-test-id*="profile-photo"] img, ' +
            'button[aria-label*="Photo"] img'
          );

          let best = null;
          let bestScore = -1;

          candidates.forEach(candidate => {
            const src = candidate.getAttribute('src') || '';
            if (!src) return;

            const alt = (candidate.getAttribute('alt') || '').toLowerCase();
            let score = 0;

            if (alt.includes('profile photo')) score += 20000;
            if (src.includes('profile-displayphoto')) score += 10000;

            const tsMatch = src.match(/\/0\/(\d+)/);
            if (tsMatch) score += parseInt(tsMatch[1]) / 40000;

            const sizeMatch = src.match(/shrink_(\d+)_(\d+)/);
            if (sizeMatch) score += parseInt(sizeMatch[1]) * 3 + parseInt(sizeMatch[2]);

            const natural = (candidate.naturalWidth || 0) + (candidate.naturalHeight || 0);
            score += natural;

            if ((candidate.naturalWidth || 0) < 150 || (candidate.naturalHeight || 0) < 150) score -= 50000;

            if (score > bestScore) {
              bestScore = score;
              best = candidate;
            }
          });

          if (best) {
            img = best;
            chosenImgForDebug = img;
            photoTier = 'header-area-strict';
          }
        }
      }

      // === Tier 3: Very last resort (rarely used) ===
      // Only broad search the whole page if we still have nothing, and be very strict.
      if (!img) {
        const allCandidates = document.querySelectorAll('img[src*="licdn.com/dms/image"], img[src*="profile-displayphoto"]');
        let best = null;
        let bestScore = -1;

        allCandidates.forEach(candidate => {
          const src = candidate.getAttribute('src') || '';
          const alt = (candidate.getAttribute('alt') || '').toLowerCase();

          if (!alt.includes('profile photo')) return;

          let score = 0;
          if (src.includes('profile-displayphoto')) score += 5000;

          const tsMatch = src.match(/\/0\/(\d+)/);
          if (tsMatch) score += parseInt(tsMatch[1]) / 80000;

          const sizeMatch = src.match(/shrink_(\d+)_(\d+)/);
          if (sizeMatch) score += parseInt(sizeMatch[1]) + parseInt(sizeMatch[2]);

          const natural = (candidate.naturalWidth || 0) + (candidate.naturalHeight || 0);
          score += natural * 0.1;

          if ((candidate.naturalWidth || 0) < 150 || (candidate.naturalHeight || 0) < 150) score -= 20000;

          if (score > bestScore) {
            bestScore = score;
            best = candidate;
          }
        });

        if (best) {
          img = best;
          chosenImgForDebug = img;
          photoTier = 'broad-strict-alt';
        }
      }

      if (img) {
        let src = img.getAttribute('src') || img.getAttribute('data-src') || '';

        // Prefer largest / highest-quality entry from srcset (the one with biggest width descriptor).
        // This is the key place that must return the *current* signed URL (with valid e/v/t params).
        const srcset = img.getAttribute('srcset');
        if (srcset) {
          const entries = srcset.split(',').map(s => s.trim());
          let largest = '';
          let largestW = 0;
          for (const entry of entries) {
            const [url, size] = entry.split(/\s+/);
            const w = size ? parseInt(size) : 0;
            if (w > largestW && url && url.startsWith('http')) {
              largestW = w;
              largest = url;
            }
          }
          if (largest) src = largest;
        }

        // Use the URL as-is from LinkedIn. The srcset already provides the best signed size.
        // Never modify the path — LinkedIn's CDN uses the t= query parameter as an HMAC over
        // the entire path, so any rewrite (e.g. shrink_400_400 → shrink_800_800) would
        // invalidate the signature and produce "Invalid t query string" errors.
        console.debug('[LinkedIn→Notion] Profile photo URL:', src);

        if (src && src.startsWith('https://')) {
          profilePictureUrl = src;
        }
      }

      // Fallback: if we have a URL but no chosenImgForDebug yet, use the final img element
      if (profilePictureUrl && !chosenImgForDebug && img) {
        chosenImgForDebug = img;
      }
    } catch (_) {}

    // Always build rich debug info when we have a photo URL. This is critical for the
    // Capture/Preview/Compare tools and for adding new golden profiles when things go wrong.
    const debugImg = chosenImgForDebug;
    const photoDebug = (profilePictureUrl && debugImg) ? {
      sourceTier: photoTier || 'unknown',
      chosenAlt: debugImg.getAttribute('alt') || '',
      chosenSrcSnippet: (debugImg.getAttribute('src') || '').substring(0, 160),
      chosenSrcsetSnippet: (() => {
        const ss = debugImg.getAttribute('srcset') || '';
        return ss ? ss.substring(0, 200) + (ss.length > 200 ? '...' : '') : '';
      })(),
      parsedTimestamp: (() => {
        const urls = (debugImg.getAttribute('src') || '') + ' ' + (debugImg.getAttribute('srcset') || '');
        const m = urls.match(/\/0\/(\d+)/);
        return m ? m[1] : null;
      })(),
      wasInPersonFigure: /person-svg-figure/.test(photoTier || ''),
      wasInMainContainer: !!debugImg.closest('.pv-top-card__photo, .pv-top-card-profile-picture, [data-test-id*="profile-photo"]')
    } : null;

    const profile = {
      fullName: cleanText(fullName),
      headline: cleanText(headline),
      currentCompany: cleanText(currentCompany),
      location: cleanText(location),
      profileUrl: url,
      profilePictureUrl,
      profilePictureDebug: photoDebug,   // only used by Debug → Preview tool
      about: cleanText(about),
      experience: experience.slice(0, 6),
      savedAt: new Date().toISOString()
    };

    lastExtracted = profile;
    return profile;
  }

  /* ----------------------- Company page extraction ----------------------- */

  function extractCompanyData() {
    const url = window.location.href.split('?')[0];

    let companyName = queryText([
      '.org-top-card-primary-phone__title',
      '.org-top-card-summary__title',
      '.org-top-card-summary-info__title',
      '[data-test-id="company-name"]',
      'h1.org-top-card-title',
      '.org-top-card__primary-phone h1',
      'h1'
    ], 200);

    if (!companyName || companyName.length < 2) {
      try {
        const title = document.title || '';
        const clean = title.replace(/\s*[|-]\s*LinkedIn.*$/i, '').trim();
        if (clean && clean.length > 2 && clean.length < 100) {
          companyName = cleanText(clean.split(/\s*[-|]\s*/)[0]);
        }
      } catch (_) {}
    }

    let tagline = queryText([
      '.org-top-card-summary__tagline',
      '.org-top-card__tagline',
      '[data-test-id="company-tagline"]',
      '.org-top-card-summary-info__tagline'
    ], 500);

    let about = queryText([
      '#about ~ * .break-words',
      '[data-test-id="about-section"] p',
      '.org-about-company-module__description p'
    ], 2500);

    let location = queryText([
      '[data-test-id="company-location"]',
      '.org-top-card-summary-info__location',
      '.org-about-company-module__headquarters'
    ], 200);

    let logoUrl = '';
    try {
      // Multi-tier logo extraction (same approach as profile photo)
      let logo = null;

      // Tier 1: Specific company logo containers
      const logoSels = [
        '.org-top-card-primary-phone__logo img',
        '.org-top-card-summary__logo img',
        '.org-top-card__logo img',
        'img[data-test-id="company-logo"]',
        '.org-about-company-module__company-logo img',
        '.org-top-card__profile-photo img',
        '.org-top-card__image img'
      ];
      for (const sel of logoSels) {
        const el = document.querySelector(sel);
        if (el) { logo = el; break; }
      }

      // Tier 2: Top card area — find LinkedIn CDN images that look like logos
      if (!logo) {
        const topCard = document.querySelector(
          '.org-top-card, ' +
          '.org-top-card-primary-phone, ' +
          '[data-test-id="company-top-card"], ' +
          '.scaffold-layout-top-card, ' +
          'main'
        );
        if (topCard) {
          const candidates = topCard.querySelectorAll('img[src*="licdn.com"], img[src*="media.licdn"]');
          for (const candidate of candidates) {
            const alt = (candidate.getAttribute('alt') || '').toLowerCase();
            if (alt.includes('logo') || (companyName && alt.includes(companyName.toLowerCase().slice(0, 10)))) {
              logo = candidate;
              break;
            }
          }
          if (!logo && candidates.length > 0) {
            // First LinkedIn CDN image in the top card is almost always the logo
            logo = candidates[0];
          }
        }
      }

      // Tier 3: Broad scan — any img with the company name in alt text
      if (!logo) {
        const allImgs = document.querySelectorAll('img[alt*="logo"], img[alt*="Logo"]');
        for (const candidate of allImgs) {
          const src = candidate.getAttribute('src') || candidate.getAttribute('data-src') || '';
          if (src.includes('licdn.com') || src.includes('media.licdn')) {
            logo = candidate;
            break;
          }
        }
      }

      if (logo) {
        // Prefer srcset for the highest resolution
        let src = logo.getAttribute('src') || logo.getAttribute('data-src') || '';
        const srcset = logo.getAttribute('srcset');
        if (srcset) {
          const entries = srcset.split(',').map(s => s.trim());
          let largest = '';
          let largestW = 0;
          for (const entry of entries) {
            const [url, size] = entry.split(/\s+/);
            const w = size ? parseInt(size) : 0;
            if (w > largestW && url && url.startsWith('http')) {
              largestW = w;
              largest = url;
            }
          }
          if (largest) src = largest;
        }
        if (src && src.startsWith('https://')) {
          logoUrl = src;
        }
      }
    } catch (_) {}

    const profile = {
      fullName: cleanText(companyName) || 'LinkedIn Company',
      headline: '',
      currentCompany: cleanText(companyName) || '',
      location: cleanText(location),
      profileUrl: url,
      profilePictureUrl: logoUrl,
      profilePictureDebug: null,
      about: cleanText(about) || cleanText(tagline),
      experience: [],
      savedAt: new Date().toISOString()
    };

    lastExtracted = profile;
    return profile;
  }

  function looksLikeRealProfile() {
    const url = location.href;

    // The manifest restricts this script to linkedin.com/* pages.
    if (url.includes('linkedin.com/in/') || url.includes('linkedin.com/company/')) {
      return true;
    }

    // Last-resort broad DOM check (covers some edge SPA render states)
    if (document.querySelector('h1, main, .scaffold-layout, .pv-top-card, .org-top-card')) {
      return true;
    }

    return false;
  }

  /* --------------------------- Button injection --------------------------- */

  function createSaveButton() {
    const btn = document.createElement('button');
    btn.id = BUTTON_ID;
    btn.type = 'button';
    btn.className = 'lin-notion-btn';
    btn.innerHTML = `
      <span class="lin-icon">📥</span>
      <span class="lin-label">Save to Notion</span>
    `;

    btn.addEventListener('click', handleSaveClick);
    return btn;
  }

  function injectFloatingButton() {
    if (document.getElementById(SHADOW_HOST_ID)) return;

    const host = document.createElement('div');
    host.id = SHADOW_HOST_ID;
    Object.assign(host.style, {
      position: 'fixed',
      bottom: window.innerWidth < 600 ? '12px' : '24px',
      right: window.innerWidth < 600 ? '12px' : '24px',
      zIndex: '2147483647',
    });

    const shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
      .lin-notion-btn {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 10px 18px;
        background: #0a66c2;
        color: #fff;
        border: none;
        border-radius: 24px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, sans-serif;
        font-size: 14px;
        font-weight: 600;
        line-height: 1;
        box-shadow: 0 4px 12px rgba(10, 102, 194, 0.35), 0 1px 3px rgba(0, 0, 0, 0.1);
        cursor: pointer;
        transition: transform 0.15s ease, box-shadow 0.15s ease, background 0.15s ease;
        user-select: none;
        -webkit-font-smoothing: antialiased;
      }
      .lin-notion-btn:hover {
        background: #004182;
        transform: translateY(-1px);
        box-shadow: 0 6px 16px rgba(10, 102, 194, 0.4);
      }
      .lin-notion-btn:active {
        transform: translateY(0);
        box-shadow: 0 2px 8px rgba(10, 102, 194, 0.3);
      }
      .lin-notion-btn:disabled {
        opacity: 0.75;
        cursor: progress;
        transform: none;
      }
      .lin-notion-btn .lin-icon {
        font-size: 15px;
        line-height: 1;
      }
      .lin-notion-btn .lin-label {
        white-space: nowrap;
      }
    `;

    const btn = document.createElement('button');
    btn.id = BUTTON_ID; // Keep ID on the actual button for potential external access
    btn.type = 'button';
    btn.className = 'lin-notion-btn';
    btn.innerHTML = `
      <span class="lin-icon">📥</span>
      <span class="lin-label">Save to Notion</span>
    `;

    btn.addEventListener('click', handleSaveClick);

    shadow.appendChild(style);
    shadow.appendChild(btn);

    document.body.appendChild(host);
  }

  function tryInjectNativeButton() {
    // Best-effort: look for the top profile action bar (Message / Connect area)
    const actionContainers = [
      '.pv-top-card__actions',
      '.ph5 .pv-top-card__actions',
      '.pv-top-card .pvs-profile-actions',
      '[data-test-id="profile-actions"]'
    ];

    for (const sel of actionContainers) {
      const container = document.querySelector(sel);
      if (container && !container.querySelector(`#${BUTTON_ID}`)) {
        const btn = createSaveButton();
        btn.classList.add('lin-notion-btn-native');
        // Insert at the end of the action row
        container.appendChild(btn);
        return true;
      }
    }
    return false;
  }

  function removeExistingButton() {
    // Remove floating button shadow host
    const shadowHost = document.getElementById(SHADOW_HOST_ID);
    if (shadowHost) shadowHost.remove();

    // Remove toast shadow host (full isolation)
    const toastHost = document.getElementById(TOAST_SHADOW_HOST_ID);
    if (toastHost) toastHost.remove();
    toastShadowHost = null;

    // Remove native button (if present)
    const old = document.getElementById(BUTTON_ID);
    if (old) old.remove();
  }

  function injectButtonIfNeeded() {
    if (!looksLikeRealProfile()) {
      return;
    }

    removeExistingButton();

    const injectedNative = tryInjectNativeButton();
    if (!injectedNative) {
      injectFloatingButton();
    }
  }

  /* ------------------------------ Toasts (Shadow DOM isolated) ------------------------------ */

  function ensureToastContainer() {
    // Reuse existing shadow host + inner container if present
    if (toastShadowHost && toastShadowHost.shadowRoot) {
      const existing = toastShadowHost.shadowRoot.getElementById(TOAST_CONTAINER_ID);
      if (existing) return existing;
    }

    // Create dedicated shadow host for toasts (completely isolated from LinkedIn React)
    toastShadowHost = document.createElement('div');
    toastShadowHost.id = TOAST_SHADOW_HOST_ID;
    Object.assign(toastShadowHost.style, {
      position: 'fixed',
      bottom: window.innerWidth < 600 ? '66px' : '78px',
      right: window.innerWidth < 600 ? '16px' : '24px',
      zIndex: '2147483646',
      pointerEvents: 'none'
    });

    const shadow = toastShadowHost.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
      .lin-toast-container {
        display: flex;
        flex-direction: column;
        gap: 10px;
        pointer-events: none;
      }
      .lin-toast {
        pointer-events: auto;
        min-width: 260px;
        max-width: 380px;
        background: #1f2937;
        color: #f9fafb;
        border-radius: 10px;
        box-shadow: 0 10px 25px -5px rgb(0 0 0 / 0.15), 0 8px 10px -6px rgb(0 0 0 / 0.1);
        overflow: hidden;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 14px;
        animation: lin-toast-in 0.22s cubic-bezier(0.32, 0.72, 0, 1);
      }
      .lin-toast--success {
        background: #064e3b;
        border-left: 4px solid #10b981;
      }
      .lin-toast--error {
        background: #4c1d1d;
        border-left: 4px solid #ef4444;
      }
      .lin-toast--info {
        background: #1e3a5f;
        border-left: 4px solid #3b82f6;
      }
      .lin-toast-content {
        padding: 13px 16px;
        display: flex;
        align-items: center;
        gap: 9px;
      }
      .lin-toast-icon {
        font-size: 16px;
        flex-shrink: 0;
      }
      .lin-toast-text {
        line-height: 1.35;
      }
      @keyframes lin-toast-in {
        from {
          opacity: 0;
          transform: translateY(12px) scale(0.985);
        }
        to {
          opacity: 1;
          transform: translateY(0) scale(1);
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .lin-toast { animation: none !important; transition: none !important; }
      }
      @media (max-width: 480px) {
        .lin-toast {
          max-width: none;
        }
      }
    `;

    const container = document.createElement('div');
    container.id = TOAST_CONTAINER_ID;
    container.className = 'lin-toast-container';

    shadow.appendChild(style);
    shadow.appendChild(container);

    document.body.appendChild(toastShadowHost);

    return container;
  }

  function showToast(message, type = 'success', timeout = 5200) {
    const container = ensureToastContainer();

    const toast = document.createElement('div');
    toast.className = `lin-toast lin-toast--${type}`;
    toast.innerHTML = `
      <div class="lin-toast-content">
        <span class="lin-toast-icon">${type === 'success' ? '✅' : type === 'error' ? '⚠️' : 'ℹ️'}</span>
        <span class="lin-toast-text">${message}</span>
      </div>
    `;

    container.appendChild(toast);

    // Click to dismiss early
    toast.addEventListener('click', () => {
      toast.style.transition = 'opacity 0.15s ease';
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 120);
    });

    if (timeout > 0) {
      setTimeout(() => {
        if (toast.parentNode) {
          toast.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
          toast.style.opacity = '0';
          toast.style.transform = 'translateY(8px)';
          setTimeout(() => toast.remove(), 160);
        }
      }, timeout);
    }
  }

  /* ------------------------- Save handler ------------------------- */

  async function handleSaveClick(e) {
    e.preventDefault();
    const btn = e.currentTarget;
    if (!btn) return;

    const originalHTML = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="lin-icon">⏳</span><span class="lin-label">Saving…</span>`;

    try {
      const profile = extractProfileData();

      if (!isExtensionContextValid()) {
        throw new Error('Extension context invalidated');
      }

      // Send to background worker (has the Notion token)
      const response = await chrome.runtime.sendMessage({
        action: 'SAVE_PROFILE',
        profile
      });

      if (response && response.success) {
        btn.innerHTML = `<span class="lin-icon">✅</span><span class="lin-label">Saved!</span>`;
        showToast('Profile saved to Notion successfully!', 'success');

        // Show warning if the photo icon upload failed (common with LinkedIn images)
        if (response.warning) {
          setTimeout(() => {
            // Use 'info' style because this is an expected LinkedIn limitation, not a hard error
            showToast(response.warning, 'info', 12000);
          }, 1200);
        }

        // Show link if available (in a second toast)
        if (response.url) {
          setTimeout(() => {
            const linkToast = document.createElement('div');
            linkToast.className = 'lin-toast lin-toast--info';
            linkToast.innerHTML = `
              <div class="lin-toast-content">
                <span>Open in Notion</span>
                <a href="${response.url}" target="_blank" rel="noopener" style="color:#0a66c2; text-decoration:underline; margin-left:6px;">View page →</a>
              </div>`;
            const c = ensureToastContainer();
            c.appendChild(linkToast);
            setTimeout(() => linkToast.remove(), 6500);
          }, 650);
        }
      } else {
        const errMsg = (response && response.error) || 'Unknown error while saving to Notion.';
        showToast(errMsg, 'error', 8000);
        btn.innerHTML = `<span class="lin-icon">❌</span><span class="lin-label">Failed</span>`;
      }
    } catch (err) {
      const msg = (err && err.message) || '';
      console.error('[LinkedIn→Notion] Save failed:', err);

      if (msg.includes('Extension context invalidated') || msg.includes('context invalidated')) {
        showToast('Extension was reloaded. Please refresh this LinkedIn page.', 'error', 8000);
        // Clean up our UI since the context is dead
        removeExistingButton();
      } else {
        showToast('Could not communicate with extension. Reload the page and try again.', 'error');
      }
      btn.innerHTML = `<span class="lin-icon">⚠️</span><span class="lin-label">Error</span>`;
    }

    // Restore button state after short delay
    setTimeout(() => {
      if (btn && btn.parentNode) {
        btn.disabled = false;
        btn.innerHTML = originalHTML;
      }
    }, 1850);
  }

  /* ---------------------- SPA navigation handling ---------------------- */

  function setupObservers() {
    if (injectionObserver) injectionObserver.disconnect();
    if (safetyInterval) clearInterval(safetyInterval);

    injectionObserver = new MutationObserver(() => {
      if (!isExtensionContextValid()) return;
      if (!hasExistingButton() && looksLikeRealProfile()) {
        injectButtonIfNeeded();
      }
    });

    injectionObserver.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true
    });

    // Safety net during the first ~50s (catches late React hydration / route changes)
    // Slightly gentler than before to reduce noise on already-hydrated pages.
    let safetyCount = 0;
    safetyInterval = setInterval(() => {
      if (!isExtensionContextValid()) {
        clearInterval(safetyInterval);
        return;
      }
      safetyCount++;
      if (safetyCount > 18) {
        clearInterval(safetyInterval);
        return;
      }
      if (!hasExistingButton() && looksLikeRealProfile()) {
        injectButtonIfNeeded();
      }
    }, 2800);

    window.addEventListener('popstate', () => {
      setTimeout(injectButtonIfNeeded, 300);
      setTimeout(injectButtonIfNeeded, 900);
    }, { passive: true });

    document.addEventListener('visibilitychange', () => {
      if (!isExtensionContextValid()) return;
      if (!document.hidden && looksLikeRealProfile() && !hasExistingButton()) {
        injectButtonIfNeeded();
      }
    });
  }

  /* --------------------------- Debug / Corpus Capture Tools --------------------------- */

  /**
   * Collects rich raw data from the page + runs the current extractor.
   * Designed to feed the Golden Profiles corpus in fixtures/profiles/
   */
  function captureProfileForDebug() {
    const url = window.location.href.split('?')[0];
    const documentTitle = document.title || '';

    // --- Top card area (name + headline region) ---
    let topCardText = '';
    try {
      const top = document.querySelector('.pv-top-card, .ph5, .scaffold-layout-top-card');
      if (top) {
        topCardText = cleanText(top.innerText || top.textContent).slice(0, 800);
      }
    } catch (_) {}

    // --- First experience card (best structural source) ---
    let firstExperienceCard = { lines: [], structuralHints: {} };
    try {
      const selectors = [
        '#experience ~ .pvs-list__container .pvs-list__item',
        'section#experience .pvs-list__item',
        '[data-test-id*="experience-item"]',
        '.pvs-list__item--experience',
        'div.pvs-list__item--experience'
      ];
      let card = null;
      for (const sel of selectors) {
        card = document.querySelector(sel);
        if (card) {
          firstExperienceCard.structuralHints.matchedSelector = sel;
          break;
        }
      }
      if (!card) {
        const expSection = document.querySelector('#experience, section[id*="experience"]');
        if (expSection) {
          card = expSection.querySelector('li, .pvs-list__item, [data-test-id*="experience"]');
          firstExperienceCard.structuralHints.matchedSelector = 'fallback-in-experience-section';
        }
      }
      if (card) {
        const raw = cleanText(card.innerText || card.textContent);
        firstExperienceCard.lines = raw.split('\n').map(l => cleanText(l)).filter(l => l.length > 1).slice(0, 12);
        firstExperienceCard.structuralHints.hasPvsListItem = !!card.className.includes('pvs-list');
      }
    } catch (_) {}

    // --- Experience section text (the nuclear path input, but better scoped) ---
    let experienceSectionText = '';
    try {
      let container = document.querySelector('#experience, section#experience, [id*="experience"]');
      if (!container) {
        container = document.querySelector('#experience ~ .pvs-list__container, section#experience ~ * .pvs-list');
      }
      if (container) {
        experienceSectionText = cleanText(container.innerText || container.textContent).slice(0, 2200);
      } else {
        // Much better fallback: look for actual "Experience" heading elements
        try {
          const headings = Array.from(document.querySelectorAll('h1, h2, h3, [role="heading"], div[aria-label], span[aria-label]'));
          const expHeading = headings.find(h => {
            const txt = (h.innerText || h.textContent || '').trim().toLowerCase();
            return txt === 'experience' || txt === 'experience ' || txt.startsWith('experience');
          });
          if (expHeading) {
            let parent = expHeading.closest('section') || expHeading.parentElement?.parentElement || expHeading.parentElement;
            if (parent) {
              experienceSectionText = cleanText(parent.innerText || parent.textContent).slice(0, 2200);
            } else {
              let sibling = expHeading.nextElementSibling;
              let collected = '';
              let count = 0;
              while (sibling && count < 5) {
                collected += (sibling.innerText || sibling.textContent || '') + '\n';
                sibling = sibling.nextElementSibling;
                count++;
              }
              experienceSectionText = cleanText(collected).slice(0, 2200);
            }
          }
        } catch (_) {}

        // Ultimate fallback
        if (!experienceSectionText) {
          const bodyText = document.body.innerText || '';
          const idx = bodyText.toLowerCase().indexOf('experience');
          if (idx !== -1) {
            experienceSectionText = cleanText(bodyText.substring(idx, idx + 1800));
          }
        }
      }
    } catch (_) {}

    // Run the normal extractor so we can prefill ground truth
    const extracted = extractProfileData();

    return {
      url,
      documentTitle,
      capturedAt: new Date().toISOString(),
      raw: {
        topCard: { text: topCardText },
        firstExperienceCard,
        experienceSectionText,
        profilePictureUrl: extracted.profilePictureUrl || ''   // captured for corpus debugging (uses the improved primary photo selector)
      },
      extractionAtCapture: {
        name: extracted.fullName,
        jobTitle: extracted.headline,
        organisation: extracted.currentCompany,
        profilePictureUrl: extracted.profilePictureUrl || '',
        sources: {
          // For now we record the final values; later we can make strategies report their source
          jobTitle: 'current-extractor',
          organisation: 'current-extractor'
        }
      }
    };
  }

  /* --------------------------- Initialization (aggressive) --------------------------- */

  function init() {
    if (!isExtensionContextValid()) {
      // Context is dead (extension was reloaded). Button injection will still attempt,
      // but Save will cleanly tell the user to refresh the page.
      console.warn('[LinkedIn→Notion] Extension context is invalid. Button may still appear, but saving will require a page refresh.');
    }

    const url = window.location.href;
    if (!/linkedin\.com\/(in|company)\//.test(url)) return;

    // Ultra-early + staggered retries to beat LinkedIn's heavy React rendering
    setTimeout(() => {
      if (!isExtensionContextValid()) return;
      if (looksLikeRealProfile() && !hasExistingButton()) {
        injectButtonIfNeeded();
      }
    }, 50);

    const earlyDelays = [120, 240, 400, 650, 950, 1300, 1750, 2300, 3000, 3900, 5000, 6500];

    earlyDelays.forEach((delay) => {
      setTimeout(() => {
        if (!isExtensionContextValid()) return;
        if (!hasExistingButton()) {
          injectButtonIfNeeded();
        }
      }, delay);
    });

    setupObservers();

    // Very late safety net (handles very slow hydration or SPA soft-nav)
    setTimeout(() => {
      if (!isExtensionContextValid()) return;
      if (!hasExistingButton() && looksLikeRealProfile()) {
        injectButtonIfNeeded();
      }
    }, 15000);
  }

  // Start
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  /* --------------------------- Message listener for popup tools --------------------------- */

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'CAPTURE_PROFILE') {
      try {
        const data = captureProfileForDebug();
        sendResponse({ success: true, data });
      } catch (err) {
        sendResponse({ success: false, error: String(err) });
      }
      return true; // async response
    }

    if (message.action === 'PREVIEW_EXTRACTION') {
      try {
        const profile = extractProfileData();
        sendResponse({ success: true, profile });
      } catch (err) {
        sendResponse({ success: false, error: String(err) });
      }
      return true;
    }

    // Unknown action — do nothing (don't keep channel open)
    return false;
  });
})();
