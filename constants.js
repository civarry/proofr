// === Shared Smart Rewrite core ===
// Loaded by the popup, the background service worker (via importScripts),
// and the content script. Single source of truth for tones + the Groq call
// so the tone list and prompt never drift between surfaces.

const SR_TONES = [
  { id: 'grammar',      name: 'Proofread',     desc: 'Fix grammar & spelling, keep your voice' },
  { id: 'professional', name: 'Professional',  desc: 'Formal and business-ready' },
  { id: 'friendly',     name: 'Friendly',      desc: 'Warm and approachable' },
  { id: 'short',        name: 'Concise',       desc: 'Trimmed to the essentials' },
  { id: 'simple',       name: 'Plain English', desc: 'Simple words, short lines' },
  { id: 'linkedin',     name: 'LinkedIn',      desc: 'Achievement-focused post' },
  { id: 'marketing',    name: 'Marketing',     desc: 'Persuasive, benefit-led' },
  { id: 'executive',    name: 'Executive',     desc: 'Brief for decision-makers' },
  { id: 'academic',     name: 'Academic',      desc: 'Scholarly and precise' },
  { id: 'news',         name: 'News',          desc: 'Punchy, factual, no filler' },
  { id: 'translate',    name: 'Translate',     desc: 'Into another language' },
];

function SR_getTone(id) {
  return SR_TONES.find(t => t.id === id) || SR_TONES[0];
}

function SR_getToneName(id) {
  const tone = SR_TONES.find(t => t.id === id);
  return tone ? tone.name : (id ? id.charAt(0).toUpperCase() + id.slice(1) : '');
}

// Line icons (Material-style, inline SVG using currentColor) — no emoji.
const SR_ICON_PATHS = {
  grammar: '<path d="M5 11 9 15 15.5 7.5"/><path d="M4 19 Q5.4 17 6.8 19 T9.6 19 T12.4 19 T15.2 19 T18 19"/>',
  professional: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5.5A2.5 2.5 0 0 1 10.5 3h3A2.5 2.5 0 0 1 16 5.5V7"/><path d="M3 12.5h18"/>',
  friendly: '<circle cx="12" cy="12" r="8.5"/><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0"/><path d="M9 9.5h.01"/><path d="M15 9.5h.01"/>',
  short: '<path d="M13 2.5 5 13.5h6l-1 8 8-11h-6l1-8z"/>',
  simple: '<path d="M12 6.5C10.5 5.2 8 4.5 5 4.5V18c3 0 5.5.7 7 2 1.5-1.3 4-2 7-2V4.5c-3 0-5.5.7-7 2z"/><path d="M12 6.5V20"/>',
  linkedin: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="11" r="1.8"/><path d="M5.7 15.5c.4-1.3 1.4-2 2.8-2s2.4.7 2.8 2"/><path d="M14 10h4"/><path d="M14 13h3"/>',
  marketing: '<path d="M4 9.5v5a1 1 0 0 0 1 1h2.5L14 19.5V4.5L7.5 8.5H5a1 1 0 0 0-1 1z"/><path d="M17.5 8.5a4 4 0 0 1 0 7"/>',
  executive: '<path d="M4 20h16"/><rect x="6" y="11.5" width="2.8" height="6.5" rx="0.5"/><rect x="10.6" y="7.5" width="2.8" height="10.5" rx="0.5"/><rect x="15.2" y="4" width="2.8" height="14" rx="0.5"/>',
  academic: '<path d="M12 4 2.5 8.5 12 13l9.5-4.5L12 4z"/><path d="M6 10.5V15c0 1.4 2.7 2.8 6 2.8s6-1.4 6-2.8v-4.5"/><path d="M21.5 8.5v5"/>',
  news: '<path d="M4 5h13v14a1.5 1.5 0 0 1-1.5 1.5H5.5A1.5 1.5 0 0 1 4 19V5z"/><path d="M17 8.5h2.5A1.5 1.5 0 0 1 21 10v9a1.5 1.5 0 0 1-1.5 1.5"/><path d="M7 9h6"/><path d="M7 12.5h7"/><path d="M7 16h7"/>',
  translate: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path d="M12 3.5c2.5 2.4 2.5 14.6 0 17-2.5-2.4-2.5-14.6 0-17z"/>',
};

function SR_iconFor(id) {
  const inner = SR_ICON_PATHS[id];
  if (!inner) return '';
  return `<svg class="sr-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}

// Brand mark: text lines being edited by a pen — "rewrite". Drawn in currentColor.
const SR_LOGO_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="4.5" y1="7.5" x2="13.5" y2="7.5"/><line x1="4.5" y1="11.5" x2="10.5" y2="11.5"/><line x1="4.5" y1="15.5" x2="8.5" y2="15.5"/><path d="M18.4 8 20 9.6l-5.3 5.3-2.1.5.5-2.1L18.4 8z"/></svg>';

// Translate targets. These five are supported by both Groq and Chrome's on-device model.
const SR_LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Spanish' },
  { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' },
  { code: 'ja', name: 'Japanese' },
];

function SR_langName(code) {
  const lang = SR_LANGUAGES.find(l => l.code === code);
  return lang ? lang.name : 'English';
}

const SR_TONE_INSTRUCTIONS = {
  grammar: `Correct only the grammar, spelling, and punctuation of the following text. Preserve the author's original wording, voice, tone, and writing style as closely as possible — do NOT rephrase, reword, simplify, or change the meaning. Make the smallest edits necessary for it to be correct. If the text is already correct, return it unchanged.`,
  friendly: `Rewrite the following text in a warm, approachable, and conversational tone. Use inclusive language, contractions, and positive phrasing. Keep the meaning intact while making it more engaging and personable.`,
  professional: `Rewrite the following text in a formal, polished, and business-appropriate tone. Use precise language, avoid colloquialisms, and structure logically while preserving important information.`,
  short: `Rewrite the following text concisely and directly. Eliminate redundancy and verbose expressions while keeping clarity and impact.`,
  linkedin: `Rewrite the following text in an engaging, achievement-focused LinkedIn style. Use power words, metrics, and industry buzzwords. Highlight impact and results while staying credible.`,
  academic: `Rewrite the following text in a scholarly, analytical academic style. Use formal language, precise terminology, and a logical flow. Ensure rigor and clarity for academic content.`,
  marketing: `Convert the following text into persuasive marketing copy. Use calls-to-action, emotional triggers, and customer benefits. Emphasize value and create urgency while maintaining professionalism.`,
  simple: `Simplify the following text using basic English and short sentences. Avoid jargon and complex words. Make it clear and accessible for everyone.`,
  executive: `Condense the following text into an executive summary. Focus on key points, business impact, and actionable insights. Structure for quick scanning by decision-makers.`,
  news: `Rewrite the following text as a fast, punchy news update. Use very short sentences. Get straight to the facts with no filler. Prioritize urgency and impact, like breaking news headlines. Each sentence should deliver one fact quickly.`,
};

function SR_buildPrompt(text, tone, targetLang) {
  let baseInstruction;
  if (tone === 'translate') {
    const lang = SR_langName(targetLang || 'en');
    baseInstruction = `Translate the following text into ${lang}. Output only the translation, with no commentary or notes. Preserve the original meaning, tone, and nuance as closely as possible. If the text is already in ${lang}, refine it so it reads naturally.`;
  } else {
    baseInstruction = SR_TONE_INSTRUCTIONS[tone] || SR_TONE_INSTRUCTIONS.friendly;
  }

  return `You are an expert writing assistant. ${baseInstruction}

Text to process:
"""
${text}
"""

Process:
1. Rewrite the text according to the tone instruction.
2. Internally review for clarity, tone consistency, grammar, and readability.
3. Quietly refine once or twice if needed to improve quality.
4. Return only the final polished version.

Output requirements:
- Preserve all facts and key points
- Maintain the requested tone consistently
- Keep the same general length unless tone requires otherwise
- Ensure grammatical correctness and readability
- Output ONLY the final rewritten text
- Do NOT include markdown, code blocks, lists, headers, or explanations
- Return plain text only, no extra formatting

Final rewritten text:`;
}

function SR_getTemperature(tone) {
  const temperatures = {
    grammar: 0.2,
    friendly: 0.7,
    professional: 0.3,
    short: 0.4,
    linkedin: 0.7,
    academic: 0.3,
    marketing: 0.8,
    simple: 0.4,
    executive: 0.5,
    news: 0.3,
    translate: 0.2,
  };
  return temperatures[tone] || 0.5;
}

function SR_isValidApiKey(apiKey) {
  return typeof apiKey === 'string' && apiKey.startsWith('gsk_') && apiKey.length >= 40;
}

// Calls Groq and returns the rewritten text, throwing a human-readable Error on failure.
async function SR_rewrite(apiKey, text, tone, targetLang) {
  if (!apiKey) {
    throw new Error('No API key set. Add your Groq API key to get started.');
  }
  if (!SR_isValidApiKey(apiKey)) {
    throw new Error('That API key looks off — it should start with "gsk_".');
  }

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: SR_buildPrompt(text, tone, targetLang) }],
      max_tokens: 1000,
      temperature: SR_getTemperature(tone),
      top_p: 0.9,
      frequency_penalty: 0.1,
      presence_penalty: 0.1,
      stream: false,
    }),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    if (response.status === 401) {
      throw new Error('Your API key was rejected. Check it in settings.');
    } else if (response.status === 429) {
      throw new Error('Groq is rate-limiting you. Give it a moment and try again.');
    } else if (response.status === 400) {
      throw new Error(errorData.error?.message || 'Groq could not process that request.');
    }
    throw new Error(`Groq request failed (${response.status}). Try again shortly.`);
  }

  const data = await response.json();
  if (!data.choices || !data.choices[0] || !data.choices[0].message) {
    throw new Error('Got an unexpected response from Groq. Try again.');
  }
  return data.choices[0].message.content.trim();
}

// === On-device AI (Chrome built-in, Gemini Nano — no API key needed) ===
// Uses the Prompt API. Exposed as the global `LanguageModel` in recent Chrome;
// falls back to the legacy `ai.languageModel` shape where present.
function SR_deviceModel() {
  try {
    if (typeof LanguageModel !== 'undefined' && LanguageModel) return LanguageModel;
  } catch (_) { /* not defined */ }
  if (typeof self !== 'undefined') {
    if (self.LanguageModel) return self.LanguageModel;
    if (self.ai && self.ai.languageModel) return self.ai.languageModel;
  }
  return null;
}

// Returns 'available' | 'downloadable' | 'downloading' | 'unavailable'.
async function SR_deviceAvailability() {
  const LM = SR_deviceModel();
  if (!LM) return 'unavailable';
  try {
    if (typeof LM.availability === 'function') {
      return await LM.availability();
    }
    // Legacy: ai.languageModel.capabilities() → { available: 'readily'|'after-download'|'no' }
    if (typeof LM.capabilities === 'function') {
      const cap = await LM.capabilities();
      return { readily: 'available', 'after-download': 'downloadable', no: 'unavailable' }[cap?.available] || 'unavailable';
    }
  } catch (_) { /* treat as unavailable */ }
  return 'unavailable';
}

// True when the device model can be used (now, or after a one-time download).
async function SR_deviceReady() {
  const a = await SR_deviceAvailability();
  return a === 'available' || a === 'downloadable' || a === 'downloading';
}

// Gemini Nano has a small context window; oversized input can stall prompt()
// indefinitely. Cap input length and time out the call so it fails fast instead
// of hanging. On the "auto" engine with a Groq key, this throw triggers the
// cloud fallback in SR_rewriteAuto; otherwise the user gets a clear error.
const SR_DEVICE_MAX_CHARS = 4000;
const SR_DEVICE_TIMEOUT_MS = 45000;

async function SR_rewriteOnDevice(text, tone, onStatus, targetLang) {
  const LM = SR_deviceModel();
  if (!LM) throw new Error('On-device AI is not available on this device.');

  if ((text || '').length > SR_DEVICE_MAX_CHARS) {
    throw new Error(
      `That selection is too long for the on-device model (${text.length.toLocaleString()} characters, ` +
      `limit ${SR_DEVICE_MAX_CHARS.toLocaleString()}). Add a Groq key for long text, or select less.`
    );
  }

  const monitor = (m) => {
    if (m && typeof m.addEventListener === 'function') {
      m.addEventListener('downloadprogress', (e) => {
        const pct = Math.round((e.loaded || 0) * 100);
        onStatus && onStatus(`Setting up the on-device model… ${pct}%`);
      });
    }
  };

  // Recent Chrome requires the languages up front for safety attestation, and the
  // OUTPUT must be a single supported code (an array of several is rejected).
  // Input can be any of the supported set; output is the translate target, else English.
  const inputLanguages = ['en', 'es', 'fr', 'de', 'ja'];
  const outputLanguage = (tone === 'translate' && targetLang) ? targetLang : 'en';
  const baseOpts = {
    monitor,
    expectedInputs: [{ type: 'text', languages: inputLanguages }],
    expectedOutputs: [{ type: 'text', languages: [outputLanguage] }],
  };

  let session;
  try {
    session = await LM.create({ ...baseOpts, temperature: SR_getTemperature(tone), topK: 8 });
  } catch (_) {
    // Some builds reject the temperature/topK pair — retry, but KEEP the language declaration.
    session = await LM.create(baseOpts);
  }

  try {
    // Race the prompt against a timeout, and try to abort the underlying work so
    // a stalled model can't leave the UI spinning forever.
    const controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        try { controller && controller.abort(); } catch (_) { /* ignore */ }
        reject(new Error('device-timeout'));
      }, SR_DEVICE_TIMEOUT_MS);
    });

    let out;
    try {
      const promptText = SR_buildPrompt(text, tone, targetLang);
      const run = controller
        ? session.prompt(promptText, { signal: controller.signal })
        : session.prompt(promptText);
      out = await Promise.race([run, timeout]);
    } catch (err) {
      if (err && err.message === 'device-timeout') {
        throw new Error('The on-device model took too long and was stopped. Try a shorter selection, or add a Groq key for long text.');
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    const trimmed = (out || '').trim();
    if (!trimmed) throw new Error('The on-device model returned nothing. Try again.');
    return trimmed;
  } finally {
    try { session.destroy && session.destroy(); } catch (_) { /* ignore */ }
  }
}

// Rewrite via the chosen engine.
// opts: { apiKey, engine: 'auto'|'device'|'groq', targetLang, onStatus }
// Returns { text, provider }.
async function SR_rewriteAuto(text, tone, opts = {}) {
  const engine = opts.engine || 'auto';
  const wantDevice = engine === 'device' || (engine === 'auto' && await SR_deviceReady());

  if (wantDevice) {
    try {
      const out = await SR_rewriteOnDevice(text, tone, opts.onStatus, opts.targetLang);
      return { text: out, provider: 'device' };
    } catch (err) {
      // Forced on-device, or nothing to fall back to → surface the error.
      if (engine === 'device' || !opts.apiKey) throw err;
      // Auto with a key available → fall through to Groq.
    }
  }
  return { text: await SR_rewrite(opts.apiKey, text, tone, opts.targetLang), provider: 'groq' };
}

// Expose for service-worker (importScripts) and content-script isolated world.
if (typeof self !== 'undefined') {
  self.SR_TONES = SR_TONES;
  self.SR_getTone = SR_getTone;
  self.SR_getToneName = SR_getToneName;
  self.SR_iconFor = SR_iconFor;
  self.SR_LOGO_SVG = SR_LOGO_SVG;
  self.SR_LANGUAGES = SR_LANGUAGES;
  self.SR_langName = SR_langName;
  self.SR_buildPrompt = SR_buildPrompt;
  self.SR_getTemperature = SR_getTemperature;
  self.SR_isValidApiKey = SR_isValidApiKey;
  self.SR_rewrite = SR_rewrite;
  self.SR_deviceAvailability = SR_deviceAvailability;
  self.SR_deviceReady = SR_deviceReady;
  self.SR_rewriteOnDevice = SR_rewriteOnDevice;
  self.SR_rewriteAuto = SR_rewriteAuto;
}
