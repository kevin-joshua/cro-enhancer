require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const cheerio = require('cheerio');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const rateLimit = require('express-rate-limit');
const NodeCache = require('node-cache');

const app = express();
const PORT = process.env.PORT || 3000;
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Cache scraped pages for 10 minutes so repeat runs on the same URL skip scraping
const scrapeCache = new NodeCache({ stdTTL: 600 });

// ─── Middleware ────────────────────────────────────────────────────────────────

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'static')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'static', 'index.html'));
});

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  message: { error: 'Too many requests. Please wait a few minutes.' }
});
app.use('/api/', limiter);

// ─── Helpers ───────────────────────────────────────────────────────────────────

// Generates a robust, stable CSS selector for a cheerio element
function buildSelector($, el) {
  const tag = el.name;
  if (!tag) return ''; // Fallback for invalid elements

  const id = $(el).attr('id');
  if (id && !id.includes(':') && !id.includes('.')) return `#${id}`;

  let classStr = '';
  const classes = $(el).attr('class');
  if (classes) {
    // Only use safe alphanumeric class names
    const safeClasses = classes.trim().split(/\s+/).filter(c => /^[a-zA-Z0-9_-]+$/.test(c));
    if (safeClasses.length > 0) {
      classStr = '.' + safeClasses.slice(0, 2).join('.');
    }
  }

  // Try to make it unique by walking up one parent level
  const parent = $(el).parent();
  const parentTag = parent[0]?.name;
  
  let parentStr = '';
  if (parentTag) {
    const parentId = parent.attr('id');
    const parentClass = parent.attr('class');
    
    if (parentId && !parentId.includes(':') && !parentId.includes('.')) {
      parentStr = `#${parentId}`;
    } else if (parentClass) {
      const safeParentClasses = parentClass.trim().split(/\s+/).filter(c => /^[a-zA-Z0-9_-]+$/.test(c));
      if (safeParentClasses.length > 0) {
        parentStr = `${parentTag}.${safeParentClasses[0]}`;
      } else {
        parentStr = parentTag;
      }
    } else {
      parentStr = parentTag;
    }
  }

  const base = parentStr ? `${parentStr} > ${tag}${classStr}` : `${tag}${classStr}`;

  try {
    // If multiple elements match, add :nth-of-type
    const matches = $(base);
    if (matches.length > 1) {
      const index = matches.index(el) + 1;
      return `${base}:nth-of-type(${index})`;
    }
    return base;
  } catch (err) {
    // If the constructed selector is invalid css-select syntax, fallback to basic tag
    return tag;
  }
}

function validateText(text) {
  if (!text || typeof text !== 'string') return false;
  const t = text.trim();
  if (t.length === 0 || t.length > 500) return false;
  // Reject if it looks like HTML/code leaked in
  if (/<[a-z][\s\S]*>/i.test(t)) return false;
  return true;
}

// ─── Stage 1: CRO Brief ────────────────────────────────────────────────────────
// Takes the ad creative and returns a structured CRO intent document

async function generateCROBrief(adText, adImageBase64, focusAreas) {
  console.log('[Stage 1] Generating CRO brief...');

  const systemPrompt = `You are a senior CRO strategist. Given an ad creative, extract the core intent and produce a precise brief that will guide landing page optimisation.

Return ONLY valid JSON. No markdown, no explanation.

Schema:
{
  "adHeadline": "the core promise or hook of the ad in one sentence",
  "audience": "who this ad is targeting",
  "offer": "what is being offered or the main value proposition",
  "painPoint": "what problem or desire the ad addresses",
  "tone": "the tone of the ad e.g. urgent, aspirational, conversational",
  "focusDirectives": {
    "headline": "what the landing page headline should communicate to match this ad",
    "subheadline": "what subheadlines should say to support the headline",
    "hero copy": "what the hero section copy should emphasise",
    "body copy": "what the general body text should convey",
    "benefits / features": "how to present product benefits and features to match the ad",
    "CTA": "what the CTA should say and what urgency or incentive to add",
    "offer": "how to present the offer/pricing to match ad expectations",
    "trust signals": "what kind of social proof would reinforce this ad's claims",
    "faq": "what specific objections or questions should be addressed",
    "form labels": "how to adapt form labels or buttons for better conversions",
    "navigation": "how to adjust navigation links to guide intent",
    "footer": "what the footer copy should emphasise for reassurance"
  }
}

Only include keys in focusDirectives that are in the requested focusAreas list.`;

  const parts = [];

  if (adImageBase64) {
    const matches = adImageBase64.match(/^data:([A-Za-z-+/]+);base64,(.+)$/);
    if (!matches) throw new Error('Invalid image format');
    parts.push({
      inlineData: { mimeType: matches[1], data: matches[2] }
    });
  }

  parts.push({
    text: `Ad Creative: ${adText || '(see image above)'}
Focus Areas requested: ${focusAreas.join(', ')}

Generate the CRO brief.`
  });

  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-pro",
    systemInstruction: systemPrompt
  });

  const response = await model.generateContent({
    contents: [{ role: 'user', parts }],
    generationConfig: {
      temperature: 0,
      responseMimeType: "application/json"
    }
  });

  const raw = response.response.text().trim();
  try {
    return JSON.parse(raw);
  } catch {
    // Strip accidental markdown fences if present
    const clean = raw.replace(/^```json\s*/i, '').replace(/\s*```$/, '');
    return JSON.parse(clean);
  }
}

// ─── Stage 2: Scraping ─────────────────────────────────────────────────────────
// Extracts a structured inventory of meaningful, editable elements from the HTML.
// Each item has a selector, current text, and semantic type.

function scrapeInventory(html, focusAreas) {
  console.log('[Stage 2] Scraping element inventory...');
  const $ = cheerio.load(html);
  const inventory = [];

  // Map focus areas to the tags we care about for each
  const tagMap = {
    headline: ['h1', 'h2'],
    subheadline: ['h3', 'h4', 'h5', 'h6'],
    'hero copy': ['h3', 'h4', 'p', 'span'],
    'body copy': ['p', 'span', 'div', 'li'],
    'benefits / features': ['li', 'p', 'h3', 'h4', 'div'],
    CTA: ['button', 'a'],
    offer: ['p', 'span', 'div', 'li'],
    'trust signals': ['p', 'span', 'blockquote', 'li'],
    faq: ['h3', 'h4', 'p', 'div', 'summary', 'details', 'li'],
    'form labels': ['label', 'button'],
    navigation: ['a', 'span', 'button', 'li'],
    footer: ['p', 'a', 'span', 'li']
  };

  // Keyword patterns that help identify offer/trust/CTA elements by content
  const offerPatterns = /\$|€|£|price|plan|free|discount|save|off|per month|per year|trial|buy|purchase|get started/i;
  const trustPatterns = /review|rating|stars|customers|trusted|guarantee|certified|award|featured in|as seen|testimonials/i;
  const ctaPatterns = /^(get|start|try|sign up|join|buy|order|book|claim|download|learn|see|explore|discover|subscribe)/i;
  const faqPatterns = /\?|how|what|why|when|where|who/i;

  const seen = new Set();

  focusAreas.forEach(area => {
    const tags = tagMap[area] || [];
    tags.forEach(tag => {
      $(tag).each((i, el) => {
        const text = $(el).text().trim().replace(/\s+/g, ' ');

        // Skip empty, very short (nav links, labels), or very long (entire sections) text
        if (!text || text.length < 3 || text.length > 500) return;

        // Handle structural exclusions
        const inHeaderNavFooter = $(el).closest('nav, footer, header').length;
        if (inHeaderNavFooter && !['navigation', 'footer', 'CTA', 'trust signals'].includes(area)) return;
        
        const inScripts = $(el).closest('script, style, noscript').length;
        if (inScripts) return;

        // De-duplicate by text content
        if (seen.has(text)) return;

        // For CTA area, only keep elements that look like CTAs
        if (area === 'CTA' && !ctaPatterns.test(text) && !['button', 'a'].includes(el.name)) return;

        // For offer area, only keep elements that mention pricing/offer language
        if (area === 'offer' && !offerPatterns.test(text)) return;

        // For trust signals, only keep elements with social proof language
        if (area === 'trust signals' && !trustPatterns.test(text)) return;
        
        // For FAQ area, look for question marks or question words
        if (area === 'faq' && !faqPatterns.test(text) && !['summary', 'details'].includes(el.name)) return;

        seen.add(text);
        const selector = buildSelector($, el);

        inventory.push({
          selector,
          text,
          type: area,
          tag
        });
      });
    });
  });

  console.log(`[Stage 2] Found ${inventory.length} candidate elements.`);
  return inventory;
}

// ─── Stage 3: Element Selection ────────────────────────────────────────────────
// The LLM picks which elements from the inventory are worth changing,
// with a reason for each. It cannot invent selectors.

async function selectElements(croBrief, inventory, focusAreas) {
  console.log('[Stage 3] Selecting elements to change...');

  const systemPrompt = `You are a CRO expert. Given a CRO brief and an inventory of page elements, select which elements should be rewritten to better match the ad.

Rules:
- You MUST ALWAYS select the main 'headline' and 'hero copy' elements for rewriting, as updating the hero section is mandatory to match the ad.
- For other elements, only select them if the current text is meaningfully misaligned with the brief.
- Return a maximum of 20 elements total
- Return ONLY valid JSON, no markdown, no explanation

Schema:
[
  {
    "selector": "exact selector from inventory",
    "currentText": "exact text from inventory",
    "type": "type from inventory",
    "reason": "one sentence explaining why this needs changing"
  }
]`;

  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-pro",
    systemInstruction: systemPrompt
  });

  const prompt = `CRO Brief:
${JSON.stringify(croBrief, null, 2)}

Requested focus areas: ${focusAreas.join(', ')}

Element Inventory:
${JSON.stringify(inventory, null, 2)}

Select elements to rewrite.`;

  const response = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0,
      responseMimeType: "application/json"
    }
  });

  const raw = response.response.text().trim();
  let selected;
  try {
    selected = JSON.parse(raw);
  } catch {
    const clean = raw.replace(/^```json\s*/i, '').replace(/\s*```$/, '');
    selected = JSON.parse(clean);
  }

  // Validate: every returned selector must exist in our inventory
  const validSelectors = new Set(inventory.map(i => i.selector));
  let validated = selected.filter(item => {
    if (!validSelectors.has(item.selector)) {
      console.warn(`[Stage 3] Hallucinated selector dropped: ${item.selector}`);
      return false;
    }
    return true;
  });

  // Programmatic fallback: ensure at least one headline and one hero copy are selected
  const hasHeadline = validated.some(el => el.type === 'headline');
  const hasHeroCopy = validated.some(el => el.type === 'hero copy');

  if (!hasHeadline) {
    const topHeadline = inventory.find(el => el.type === 'headline');
    if (topHeadline) {
      console.log(`[Stage 3] Manually injecting top headline to ensure hero section modification.`);
      validated.unshift({ 
        selector: topHeadline.selector, 
        currentText: topHeadline.text, 
        type: topHeadline.type, 
        reason: "Mandatory hero section optimization." 
      });
    }
  }

  if (!hasHeroCopy) {
    const topHeroCopy = inventory.find(el => el.type === 'hero copy');
    if (topHeroCopy) {
      console.log(`[Stage 3] Manually injecting top hero copy to ensure hero section modification.`);
      // Insert right after the headline if possible
      validated.splice(1, 0, { 
        selector: topHeroCopy.selector, 
        currentText: topHeroCopy.text, 
        type: topHeroCopy.type, 
        reason: "Mandatory hero section optimization." 
      });
    }
  }

  console.log(`[Stage 3] Selected ${validated.length} elements after validation.`);
  return validated;
}

// ─── Stage 4: Copywriting ──────────────────────────────────────────────────────
// For each selected element, generate new copy.
// Runs in parallel. Each call is tightly scoped.

async function rewriteElements(selectedElements, croBrief, adText, adImageBase64) {
  console.log(`[Stage 4] Rewriting ${selectedElements.length} elements...`);

  const systemPrompt = `You are an elite CRO strategist and direct-response copywriter. Your task is to perform a GLOBAL rewrite of a landing page's copy to match a specific ad's intent.

You are receiving ALL the elements that need to be rewritten at once. You MUST write a cohesive, persuasive narrative across the entire page, not just independent sentences.

CRITICAL RULES FOR REWRITING:

1. ROLE-BASED MESSAGING (Each element has a specific job):
   - 'headline' -> Introduce the core pain point or the biggest promise. Make it punchy.
   - 'subheadline' -> Expand the value proposition and explain "how" it works.
   - 'hero copy' -> Provide specific details, context, or transition into the product.
   - 'body copy' & 'benefits / features' -> Reinforce specific, varied benefits. Detail the features.
   - 'CTA' -> Drive urgent, relevant action.
   - 'trust signals' -> Provide reassurance, social proof, or risk reversal.
   - 'faq' / 'form labels' / 'navigation' / 'footer' -> Stay clear, neutral, and concise. Only minor tweaks.

2. DISTRIBUTE THE MESSAGE (ANTI-REPETITION):
   - NEVER repeat the same phrase, hook, or sentence across multiple elements (e.g., do not say "Stop juggling apps" in both the headline and the body).
   - Spread ideas out. If the headline hits the pain, the subheadline should hit the solution.
   - Use varied vocabulary and phrasing while keeping the same core theme. Every element must add NEW information or a NEW angle.

3. CONSTRAINTS:
   - Match the tone described in the brief.
   - Keep each rewrite roughly the same length as the original (within 50% longer or shorter).
   - Do not invent specific claims, numbers, or guarantees not present in the ad.
   - Preserve any brand names or product names from the original text.
   - Output ONLY the new text string. No quotes, no markdown, no HTML tags.

Return ONLY valid JSON. No markdown, no explanation.

Schema:
[
  {
    "selector": "exact selector from input",
    "before": "exact original text",
    "after": "the new rewritten text"
  }
]`;

  try {
    const parts = [];
    if (adImageBase64) {
      const matches = adImageBase64.match(/^data:([A-Za-z-+/]+);base64,(.+)$/);
      if (matches) {
        parts.push({
          inlineData: { mimeType: matches[1], data: matches[2] }
        });
      }
    }

    // Map selected elements and include directives
    const elementsToRewrite = selectedElements.map(el => ({
      selector: el.selector,
      role: el.type, // explicitly name it "role" so the LLM links it to the prompt rules
      directive: croBrief.focusDirectives?.[el.type] || '',
      currentText: el.currentText,
      reasonToChange: el.reason // clear naming
    }));

    parts.push({
      text: `Ad: ${adText || '(see image)'}
Ad tone: ${croBrief.tone}
Core offer: ${croBrief.offer}
Target audience: ${croBrief.audience}

Elements to rewrite:
${JSON.stringify(elementsToRewrite, null, 2)}

Provide the rewrites as JSON.`
    });

    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      systemInstruction: systemPrompt
    });

    const response = await model.generateContent({
      contents: [{ role: 'user', parts }],
      generationConfig: {
        temperature: 0.4,
        responseMimeType: "application/json"
      }
    });

    const raw = response.response.text().trim();
    let parsedRewrites;
    try {
      parsedRewrites = JSON.parse(raw);
    } catch {
      const clean = raw.replace(/^```json\s*/i, '').replace(/\s*```$/, '');
      parsedRewrites = JSON.parse(clean);
    }

    // Merge and validate results
    const validRewrites = parsedRewrites.map(rewrite => {
      const originalElement = selectedElements.find(el => el.selector === rewrite.selector);
      if (!originalElement) return null;

      // Validate output
      if (!validateText(rewrite.after)) {
        console.warn(`[Stage 4] Invalid output for selector ${rewrite.selector}, keeping original.`);
        return null;
      }
      
      if (rewrite.after === originalElement.currentText) {
        console.log(`[Stage 4] No change for ${rewrite.selector}, skipping.`);
        return null;
      }

      return {
        selector: originalElement.selector,
        before: originalElement.currentText,
        after: rewrite.after,
        element: originalElement.type,
        reason: originalElement.reason
      };
    }).filter(Boolean);

    return validRewrites;
  } catch (err) {
    console.error(`[Stage 4] Rewrite failed:`, err.message);
    return [];
  }
}

// ─── Apply Changes ─────────────────────────────────────────────────────────────
// Uses cheerio DOM manipulation — never string.replace()

function applyChanges(html, changes) {
  console.log(`[Apply] Applying ${changes.length} changes to HTML...`);
  const $ = cheerio.load(html);

  changes.forEach(change => {
    try {
      const matches = $(change.selector);
      if (matches.length === 0) {
        console.warn(`[Apply] Selector not found in HTML: ${change.selector}`);
        return;
      }
      // Only update the first match to avoid unintended bulk changes
      matches.first().text(change.after);
      console.log(`[Apply] Updated: ${change.selector}`);
    } catch (err) {
      console.warn(`[Apply] Failed to apply change for ${change.selector}:`, err.message);
    }
  });

  return $.html();
}

// ─── Routes ────────────────────────────────────────────────────────────────────

// Fetch HTML (bypasses browser CORS)
app.post('/api/fetch-html', async (req, res) => {
  const { url } = req.body;
  if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
    return res.status(400).json({ error: 'A valid URL is required.' });
  }

  // Check cache first
  const cached = scrapeCache.get(url);
  if (cached) {
    console.log(`[Fetch] Cache hit for ${url}`);
    return res.json({ html: cached, cached: true });
  }

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      },
      signal: AbortSignal.timeout(10000) // 10s timeout
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const html = await response.text();

    // Inject base tag so relative resources load in the iframe
    const baseUrl = new URL(url).origin;
    const htmlWithBase = html.replace(/<head>/i, `<head>\n  <base href="${baseUrl}/">`);

    scrapeCache.set(url, htmlWithBase);
    res.json({ html: htmlWithBase });
  } catch (err) {
    console.error('[Fetch] Error:', err.message);
    res.status(500).json({ error: 'Could not fetch the page. The site may be blocking requests.' });
  }
});

// Phase 1: Analyze Page & Suggest Elements
app.post('/api/analyze', async (req, res) => {
  const { adText, adImage, landingPageHtml, focusAreas } = req.body;

  // Input validation
  if (!landingPageHtml || typeof landingPageHtml !== 'string') {
    return res.status(400).json({ error: 'Landing page HTML is required.' });
  }
  if (!adText && !adImage) {
    return res.status(400).json({ error: 'Ad text or image is required.' });
  }
  if (!focusAreas || focusAreas.length === 0) {
    return res.status(400).json({ error: 'At least one focus area is required.' });
  }
  if (landingPageHtml.length > 2_000_000) {
    return res.status(400).json({ error: 'HTML is too large (max 2MB).' });
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`[Phase 1] Starting analysis`);
  console.log(`[Phase 1] Focus areas: ${focusAreas.join(', ')}`);

  try {
    const croBrief = await generateCROBrief(adText, adImage, focusAreas);
    console.log('[Phase 1] Brief generated.');

    // We can't stream progress back easily over a standard POST request without SSE,
    // but the analysis is fast enough now that we just return the final payload.
    const inventory = scrapeInventory(landingPageHtml, focusAreas);
    if (inventory.length === 0) {
      return res.status(422).json({
        error: 'No editable elements found for the selected focus areas. Try different focus areas or check the HTML.'
      });
    }

    const suggestedElements = await selectElements(croBrief, inventory, focusAreas);

    res.json({
      analysis: croBrief,
      elements: suggestedElements,
      inventoryCount: inventory.length
    });

  } catch (err) {
    console.error('[Phase 1] Fatal error:', err);
    res.status(500).json({ error: 'Analysis failed. Please try again.' });
  }
});

// Phase 2: Rewrite Selected Elements
app.post('/api/rewrite', async (req, res) => {
  const { adText, adImage, landingPageHtml, croBrief, selectedElements } = req.body;

  if (!landingPageHtml || !croBrief || !selectedElements || selectedElements.length === 0) {
    return res.status(400).json({ error: 'Missing required data for rewrite phase.' });
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`[Phase 2] Starting rewrite for ${selectedElements.length} elements`);

  try {
    const changes = await rewriteElements(selectedElements, croBrief, adText, adImage);
    
    if (changes.length === 0) {
      return res.json({
        changes: [],
        html: landingPageHtml,
        message: 'Rewrites were generated but did not pass quality validation. No changes applied.'
      });
    }

    const finalHtml = applyChanges(landingPageHtml, changes);
    console.log(`[Phase 2] Done. ${changes.length} changes applied.`);

    res.json({
      changes,
      html: finalHtml
    });

  } catch (err) {
    console.error('[Phase 2] Fatal error:', err);
    res.status(500).json({ error: 'Rewriting failed. Please try again.' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});