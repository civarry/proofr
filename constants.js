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
  { id: 'tldr',         name: 'Summarize',     desc: 'The key point, condensed' },
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
  tldr: '<path d="M4 6.5h16"/><path d="M6.5 12h11"/><path d="M9 17.5h6"/>',
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

// Translate isn't limited to the on-device set: a cloud provider can handle any
// language. On-device covers SR_LANGUAGES only; everything else here needs a
// cloud provider key (see SR_isOnDeviceLanguage).
const SR_LANGUAGES_FULL = [
  ...SR_LANGUAGES,
  { code: 'tl', name: 'Filipino (Tagalog)' },
  { code: 'zh', name: 'Chinese (Simplified)' },
  { code: 'zh-TW', name: 'Chinese (Traditional)' },
  { code: 'ko', name: 'Korean' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'it', name: 'Italian' },
  { code: 'vi', name: 'Vietnamese' },
  { code: 'id', name: 'Indonesian' },
  { code: 'ar', name: 'Arabic' },
  { code: 'hi', name: 'Hindi' },
  { code: 'th', name: 'Thai' },
];

function SR_fullLangName(code) {
  const lang = SR_LANGUAGES_FULL.find(l => l.code === code);
  return lang ? lang.name : code;
}

const SR_ON_DEVICE_LANG_CODES = new Set(SR_LANGUAGES.map(l => l.code));
function SR_isOnDeviceLanguage(code) {
  return SR_ON_DEVICE_LANG_CODES.has(code);
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
  tldr: `Summarize the following text in 1-3 short sentences that capture only the essential point or key takeaway. Compress aggressively — this is not a light trim like a "concise" rewrite, it's a genuine summary. Drop supporting detail, examples, and preamble. Keep only what someone would need to know if this summary were the only part they read.`,
  executive: `Condense the following text into an executive summary. Focus on key points, business impact, and actionable insights. Structure for quick scanning by decision-makers.`,
  news: `Rewrite the following text as a fast, punchy news update. Use very short sentences. Get straight to the facts with no filler. Prioritize urgency and impact, like breaking news headlines. Each sentence should deliver one fact quickly.`,
};

function SR_buildPrompt(text, tone, targetLang) {
  let baseInstruction;
  if (tone === 'translate') {
    const lang = SR_fullLangName(targetLang || 'en');
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
- If the text has line breaks between separate paragraphs or points, keep that same paragraph structure in the output (one blank line between paragraphs) unless the tone specifically calls for condensing them into fewer, denser paragraphs
- Output ONLY the final rewritten text
- Do NOT include markdown, code blocks, lists, headers, or explanations
- Return plain text only, no extra formatting

Final rewritten text:`;
}

function SR_getTemperature(tone, boost = 0) {
  const temperatures = {
    grammar: 0.2,
    friendly: 0.7,
    professional: 0.3,
    short: 0.4,
    linkedin: 0.7,
    academic: 0.3,
    marketing: 0.8,
    simple: 0.4,
    tldr: 0.3,
    executive: 0.5,
    news: 0.3,
    translate: 0.2,
  };
  return Math.min(1, (temperatures[tone] || 0.5) + boost);
}

// Listing reviews page, used by the one-time rate prompt (content.js, sidepanel.js).
const SR_REVIEWS_URL = 'https://chromewebstore.google.com/detail/dfhooimjbdefdbabhppgloclhkjolhfg/reviews';

// === Cloud providers ===
// Every preset speaks the same OpenAI-compatible /chat/completions shape; only
// the base URL, key, and model differ. A different wire format (Anthropic)
// would need its own function, not a preset here.
// Base URLs and key pages are from each provider's own docs (checked 2026-10-19).
// cors: the API answers a chrome-extension:// preflight (checked with curl), so
// no host permission is needed. keyless: a local server that ignores keys.
// defaultModel null means "pick from the provider's /models list".
const SR_CLOUD_SERVICES = [
  // llama-3.3-70b-versatile was shut down 2026-08-16; gpt-oss-120b is Groq's named replacement.
  { id: 'groq', name: 'Groq', baseURL: 'https://api.groq.com/openai/v1', keyURL: 'https://console.groq.com/keys', keyless: false, cors: true, defaultModel: 'openai/gpt-oss-120b', note: 'Free tier, fast.' },
  // shortcut: gpt-4o-mini shuts down 2027-01-14; its named replacement (gpt-6-luna) is a reasoning
  // model whose temperature/top_p/max_tokens support is undocumented. Switch once verified.
  { id: 'openai', name: 'OpenAI', baseURL: 'https://api.openai.com/v1', keyURL: 'https://platform.openai.com/api-keys', keyless: false, cors: true, defaultModel: 'gpt-4o-mini', note: 'Paid.' },
  // gpt-oss-120b on OpenRouter accepts temperature/top_p/max_tokens/reasoning_effort (model page);
  // openai/gpt-4o-mini there routes to the same 2027-01-14 shutdown.
  { id: 'openrouter', name: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1', keyURL: 'https://openrouter.ai/keys', keyless: false, cors: true, defaultModel: 'openai/gpt-oss-120b', note: 'Many models behind one key.' },
  // gemini-3.8-flash is the model the OpenAI-compatibility docs use; Gemini 3 always thinks (see SR_callCloud).
  { id: 'gemini', name: 'Google Gemini', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', keyURL: 'https://aistudio.google.com/apikey', keyless: false, cors: true, defaultModel: 'gemini-3.8-flash', note: 'Free tier.' },
  { id: 'mistral', name: 'Mistral', baseURL: 'https://api.mistral.ai/v1', keyURL: 'https://console.mistral.ai', keyless: false, cors: true, defaultModel: null, note: 'Create a key under API Keys.' },
  { id: 'deepseek', name: 'DeepSeek', baseURL: 'https://api.deepseek.com', keyURL: 'https://platform.deepseek.com/api_keys', keyless: false, cors: true, defaultModel: 'deepseek-flash', note: 'Paid.' },
  { id: 'together', name: 'Together AI', baseURL: 'https://api.together.ai/v1', keyURL: 'https://api.together.ai/settings/projects/~current/api-keys', keyless: false, cors: true, defaultModel: null, note: 'Open models.' },
  { id: 'ollama', name: 'Ollama', baseURL: 'http://localhost:11434/v1', keyURL: '', keyless: true, cors: false, defaultModel: null, note: 'Runs on this computer.' },
  { id: 'lmstudio', name: 'LM Studio', baseURL: 'http://localhost:1234/v1', keyURL: '', keyless: true, cors: false, defaultModel: null, note: 'Runs on this computer. Start its server first.' },
  { id: 'custom', name: 'Custom', baseURL: '', keyURL: '', keyless: false, cors: false, defaultModel: null, note: 'Any OpenAI-compatible endpoint.' },
];

function SR_cloudServiceMeta(id) {
  return SR_CLOUD_SERVICES.find((s) => s.id === id) || SR_CLOUD_SERVICES[0];
}

// This computer or the user's own network: loopback, the RFC 1918 ranges,
// link-local, and mDNS .local names (same idea as lasso's KeysRegistry).
// A server there needs no key, so a custom local endpoint counts as keyless.
function SR_isLocalURL(url) {
  let host;
  try { host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, ''); } catch (_) { return false; }
  if (host === 'localhost' || host.endsWith('.local') || host === '::1' || host === '0.0.0.0') return true;
  if (/^(fc|fd)[0-9a-f]{2}:|^fe80:/.test(host)) return true;
  const ip = host.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (!ip) return false;
  const [a, b] = [Number(ip[1]), Number(ip[2])];
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
}

// cfg: { id, baseURL, apiKey, model, keyless? }. A key is optional for local servers.
function SR_providerKeyOK(cfg) {
  return !!cfg && (!!cfg.apiKey || !!cfg.keyless || SR_isLocalURL(cfg.baseURL));
}

function SR_providerReady(cfg) {
  return SR_providerKeyOK(cfg) && !!cfg.baseURL && !!cfg.model;
}

// Presets whose API doesn't send CORS headers to extensions (local servers,
// custom endpoints) need host access to their origin, requested on Save.
function SR_needsHostAccess(id) {
  return !SR_cloudServiceMeta(id).cors;
}

function SR_authHeaders(apiKey) {
  return apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {};
}

// Tolerates a base URL that already includes /chat/completions or a trailing slash.
function SR_chatCompletionsURL(base) {
  let s = (base || '').trim();
  while (s.endsWith('/')) s = s.slice(0, -1);
  if (s.endsWith('/chat/completions')) s = s.slice(0, -'/chat/completions'.length);
  return `${s}/chat/completions`;
}

// Same tolerance, for the /models endpoint used to live-validate a saved key.
function SR_modelsURL(base) {
  let s = (base || '').trim();
  while (s.endsWith('/')) s = s.slice(0, -1);
  if (s.endsWith('/chat/completions')) s = s.slice(0, -'/chat/completions'.length);
  if (s.endsWith('/models')) return s;
  return `${s}/models`;
}

// Drops non-chat models (embeddings, audio, image, moderation) so a browsed
// list stays useful — same exclusion set as lasso's OpenAICompatibleProvider.
function SR_chatModels(ids) {
  const exclude = ['embed', 'whisper', 'tts', 'dall-e', 'dalle', 'moderation', 'audio', 'image', 'rerank', 'stable-diffusion', 'flux'];
  return ids.filter((id) => {
    const lower = String(id).toLowerCase();
    return !exclude.some((x) => lower.includes(x));
  }).sort();
}

// Fallbacks, in order, when the saved/default model isn't in a provider's
// /models list (providers retire models; see the Groq default above).
// Only models known to accept the request shape SR_callCloud sends.
const SR_MODEL_PREFERENCES = {
  groq: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'],
  openai: ['gpt-4o-mini', 'gpt-4.1-mini'],
  openrouter: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'openai/gpt-4o-mini'],
};

// Picks a model from `ids` (a provider's /models list): the service default if
// it's still listed, else the first listed preference. Returns null when none
// is listed, so the caller keeps what it had and the user gets the honest
// "model no longer available" error rather than an arbitrary model that may
// reject our parameters. Presets with no default (custom, local servers, and
// providers we haven't verified a model on) take the first listed chat model.
function SR_pickAvailableModel(serviceId, ids) {
  const chat = SR_chatModels(ids || []);
  const prefs = [SR_cloudServiceMeta(serviceId).defaultModel, ...(SR_MODEL_PREFERENCES[serviceId] || [])];
  const preferred = prefs.find((m) => m && chat.includes(m));
  if (preferred) return preferred;
  return SR_cloudServiceMeta(serviceId).defaultModel ? null : (chat[0] || null);
}

// Lists the models a provider's {baseURL}/models actually advertises for the
// saved key — lets Settings offer a real, current list instead of asking the
// user to already know an exact model id. Throws a human-readable error
// rather than silently returning empty, since a browse action should explain
// why nothing showed up (no key yet, bad key, unreachable endpoint).
async function SR_availableModels(provider) {
  if (!SR_providerKeyOK(provider)) throw new Error('Save an API key first.');
  if (!provider.baseURL) throw new Error('Set a base URL first.');

  const res = await fetch(SR_modelsURL(provider.baseURL), { headers: SR_authHeaders(provider.apiKey) });
  if (!res.ok) throw new Error(`${provider.displayName} rejected the request (${res.status}).`);

  const data = await res.json();
  const ids = (Array.isArray(data.data) ? data.data : []).map((m) => m && m.id).filter(Boolean);
  return SR_chatModels(ids);
}

// Soft pre-check only — the real validation is the live call each provider's
// Settings save already makes against {baseURL}/models. Groq/OpenAI keys have
// a recognizable prefix; OpenRouter/Custom don't, so just a length sanity check.
function SR_isValidApiKey(apiKey, serviceId) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) return false;
  if (serviceId === 'groq') return apiKey.startsWith('gsk_') && apiKey.length >= 40;
  if (serviceId === 'openai') return apiKey.startsWith('sk-') && apiKey.length >= 20;
  return apiKey.length >= 10;
}

// === Ask AI: freeform instruction on a specific block (hover popover) ===
// Cloud key only, by design: a freeform instruction benefits from a bigger
// model. Skips the on-device path entirely rather than
// solving output-language declaration for an arbitrary, unstructured instruction.
function SR_buildAskPrompt(text, instruction) {
  return `You are an expert writing assistant. Apply this instruction to the text: ${instruction}

Text:
"""
${text}
"""

Output ONLY the result. No commentary, no markdown, no explanations.

Result:`;
}

// `provider`: { baseURL, apiKey, model, displayName }
async function SR_askCloud(provider, text, instruction, temperatureBoost = 0) {
  return SR_callCloud(provider, SR_buildAskPrompt(text, instruction), Math.min(1, 0.5 + temperatureBoost), 1200);
}

// Calls the configured cloud provider and returns the rewritten text, throwing
// a human-readable Error on failure.
async function SR_rewrite(provider, text, tone, targetLang, temperatureBoost = 0) {
  return SR_callCloud(provider, SR_buildPrompt(text, tone, targetLang), SR_getTemperature(tone, temperatureBoost), 1000);
}

// Shared request path for SR_rewrite / SR_askCloud — same wire shape, only the
// prompt/temperature/max_tokens differ per caller.
async function SR_callCloud(provider, prompt, temperature, maxTokens) {
  if (!SR_providerKeyOK(provider)) {
    throw new Error(`No API key set. Add your ${provider?.displayName || 'cloud'} API key to get started.`);
  }
  if (!provider.model) {
    throw new Error(`No model set for ${provider.displayName}. Add one in settings.`);
  }

  // gpt-oss models reason before answering, and those tokens count against the
  // output budget; other providers may reject an unknown reasoning_effort param.
  // shortcut: Gemini 3 can't turn thinking off and its docs map 'low' to a small budget, but
  // whether thinking counts against max_tokens is undocumented; check with a live key.
  const reasoning = /gpt-oss|gemini/i.test(provider.model);
  if (reasoning) maxTokens += 1000;
  // Without a deadline a stalled provider hangs the modal forever. Scales with
  // maxTokens so a long answer on a slow model isn't cut off.
  const timeoutMs = 20000 + maxTokens * 10;
  let response;
  try {
    response = await fetch(SR_chatCompletionsURL(provider.baseURL), {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        ...SR_authHeaders(provider.apiKey),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: provider.model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens,
        temperature,
        top_p: 0.9,
        stream: false,
        ...(reasoning ? { reasoning_effort: 'low' } : {}),
      }),
    });
  } catch (err) {
    if (err && err.name === 'TimeoutError') {
      throw new Error(`${provider.displayName} didn't respond in ${Math.round(timeoutMs / 1000)}s. Try again, or select less text.`);
    }
    throw new Error(`Couldn't reach ${provider.displayName}. Check your connection and try again.`);
  }

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    const err = errorData.error || {};
    const modelGone = response.status === 404
      || ['model_not_found', 'model_decommissioned'].includes(err.code)
      || /decommission|model.*(not found|does not exist|not available)/i.test(err.message || '');
    if (modelGone && (response.status === 400 || response.status === 404)) {
      throw new Error(`Your model ${provider.model} is no longer available. Open Settings → Model and pick another (the search button lists current ones).`);
    }
    if (response.status === 401) {
      throw new Error('Your API key was rejected. Check it in settings.');
    } else if (response.status === 429) {
      throw new Error(`${provider.displayName} is rate-limiting you. Give it a moment and try again.`);
    } else if (response.status === 400) {
      throw new Error(errorData.error?.message || `${provider.displayName} could not process that request.`);
    }
    throw new Error(`${provider.displayName} request failed (${response.status}). Try again shortly.`);
  }

  const data = await response.json().catch(() => null); // body can time out mid-stream too
  if (!data || !data.choices || !data.choices[0] || !data.choices[0].message) {
    throw new Error(`Got an unexpected response from ${provider.displayName}. Try again.`);
  }
  // Never return a cut-off answer: on an editable field it would replace the user's text.
  if (data.choices[0].finish_reason === 'length') {
    throw new Error('The answer was cut off before it finished. Try a shorter selection.');
  }
  // A reasoning model can spend the whole budget thinking and return no answer.
  const content = (data.choices[0].message.content || '').trim();
  if (!content) throw new Error(`${provider.displayName} returned an empty answer. Try again, or select less text.`);
  return content;
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
      // English only: "can the model run at all". Checking every language would
      // mark the whole engine unavailable on a build missing one of them;
      // SR_rewriteOnDevice handles per-language support.
      return await LM.availability({
        expectedInputs: [{ type: 'text', languages: ['en'] }],
        expectedOutputs: [{ type: 'text', languages: ['en'] }],
      });
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

async function SR_rewriteOnDevice(text, tone, onStatus, targetLang, temperatureBoost = 0) {
  const LM = SR_deviceModel();
  if (!LM) throw new Error('On-device AI is not available on this device.');

  if ((text || '').length > SR_DEVICE_MAX_CHARS) {
    throw new Error(
      `That selection is too long for the on-device model (${text.length.toLocaleString()} characters, ` +
      `limit ${SR_DEVICE_MAX_CHARS.toLocaleString()}). Add a cloud provider key for long text, or select less.`
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
  const inputLanguages = SR_LANGUAGES.map((l) => l.code);
  const outputLanguage = (tone === 'translate' && targetLang) ? targetLang : 'en';
  const baseOpts = {
    monitor,
    expectedInputs: [{ type: 'text', languages: inputLanguages }],
    expectedOutputs: [{ type: 'text', languages: [outputLanguage] }],
  };

  // Some builds reject the temperature/topK pair; some ship fewer input
  // languages than the docs list (CfT 155 accepts only en/es/ja). Fall back
  // step by step, always keeping the output language.
  const attempts = [
    { ...baseOpts, temperature: SR_getTemperature(tone, temperatureBoost), topK: 8 },
    baseOpts,
    { ...baseOpts, expectedInputs: [{ type: 'text', languages: ['en'] }] },
  ];
  let session;
  let lastError;
  for (const opts of attempts) {
    try { session = await LM.create(opts); break; } catch (err) { lastError = err; }
  }
  if (!session) {
    if (lastError && lastError.name === 'NotSupportedError' && outputLanguage !== 'en') {
      throw new Error(`${SR_fullLangName(outputLanguage)} isn't supported by Chrome's on-device model here. Add a cloud provider key to translate into it.`);
    }
    throw lastError || new Error('Could not start the on-device model.');
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
        throw new Error('The on-device model took too long and was stopped. Try a shorter selection, or add a cloud provider key for long text.');
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
// opts: { provider: {baseURL,apiKey,model,displayName}, engine: 'auto'|'device'|'cloud', targetLang, onStatus, temperatureBoost }
// Returns { text, provider }.
async function SR_rewriteAuto(text, tone, opts = {}) {
  const engine = opts.engine || 'auto';
  const boost = opts.temperatureBoost || 0;
  const hasProvider = SR_providerReady(opts.provider);
  // Nano can only output the five on-device languages; send other translate targets to the cloud.
  const deviceLang = tone !== 'translate' || SR_isOnDeviceLanguage(opts.targetLang || 'en');
  const wantDevice = engine === 'device' || (engine === 'auto' && deviceLang && await SR_deviceReady());

  if (wantDevice) {
    try {
      const out = await SR_rewriteOnDevice(text, tone, opts.onStatus, opts.targetLang, boost);
      return { text: out, provider: 'device' };
    } catch (err) {
      // Forced on-device, or nothing to fall back to → surface the error.
      if (engine === 'device' || !hasProvider) throw err;
      // Auto with a cloud provider configured → fall through to it.
    }
  }
  return { text: await SR_rewrite(opts.provider, text, tone, opts.targetLang, boost), provider: opts.provider.id };
}

// 'device' → "On-device"; any cloud service id → its friendly name (falls
// back to Custom's generic label for an unrecognized id).
function SR_providerDisplayLabel(providerId) {
  if (providerId === 'device') return 'On-device';
  return SR_cloudServiceMeta(providerId).name;
}

if (typeof self !== 'undefined') {
  self.SR_TONES = SR_TONES;
  self.SR_getTone = SR_getTone;
  self.SR_getToneName = SR_getToneName;
  self.SR_iconFor = SR_iconFor;
  self.SR_LOGO_SVG = SR_LOGO_SVG;
  self.SR_LANGUAGES = SR_LANGUAGES;
  self.SR_langName = SR_langName;
  self.SR_LANGUAGES_FULL = SR_LANGUAGES_FULL;
  self.SR_fullLangName = SR_fullLangName;
  self.SR_isOnDeviceLanguage = SR_isOnDeviceLanguage;
  self.SR_buildPrompt = SR_buildPrompt;
  self.SR_getTemperature = SR_getTemperature;
  self.SR_isValidApiKey = SR_isValidApiKey;
  self.SR_CLOUD_SERVICES = SR_CLOUD_SERVICES;
  self.SR_cloudServiceMeta = SR_cloudServiceMeta;
  self.SR_isLocalURL = SR_isLocalURL;
  self.SR_providerReady = SR_providerReady;
  self.SR_needsHostAccess = SR_needsHostAccess;
  self.SR_pickAvailableModel = SR_pickAvailableModel;
  self.SR_REVIEWS_URL = SR_REVIEWS_URL;
  self.SR_chatCompletionsURL = SR_chatCompletionsURL;
  self.SR_modelsURL = SR_modelsURL;
  self.SR_chatModels = SR_chatModels;
  self.SR_availableModels = SR_availableModels;
  self.SR_providerDisplayLabel = SR_providerDisplayLabel;
  self.SR_buildAskPrompt = SR_buildAskPrompt;
  self.SR_askCloud = SR_askCloud;
  self.SR_rewrite = SR_rewrite;
  self.SR_callCloud = SR_callCloud;
  self.SR_deviceAvailability = SR_deviceAvailability;
  self.SR_deviceReady = SR_deviceReady;
  self.SR_rewriteOnDevice = SR_rewriteOnDevice;
  self.SR_rewriteAuto = SR_rewriteAuto;
}
