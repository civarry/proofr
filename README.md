# Proofr: Private AI Proofreader & Rewriter

Proofread, rewrite in any tone, and translate text on any web page. Proofr is a Chrome extension (Manifest V3) with no account and no Proofr servers.

## How it runs

- **On-device (default when available):** Chrome's built-in AI (Gemini Nano). Your text never leaves your computer. This needs desktop Chrome with built-in AI support and enough disk and memory to download the model. Many machines can't run it.
- **Cloud (bring your own key):** if on-device isn't available, or you pick the Cloud engine, Proofr calls the provider you choose with your own API key: Groq, OpenAI, OpenRouter, Google Gemini, Mistral, DeepSeek, Together AI, or any OpenAI-compatible endpoint. The request goes straight from your browser to that provider.
- **Local server (no key):** Ollama, LM Studio, or a custom endpoint on your own computer or network. Proofr asks once for access to that address. A free Groq key takes about a minute to get at [console.groq.com/keys](https://console.groq.com/keys).

The engine setting (Auto, On-device, Cloud) is in the side panel. Auto uses on-device first and falls back to your cloud key.

## Features

- **Modes:** Proofread, Professional, Friendly, Concise, Plain English, Summarize, LinkedIn, Marketing, Executive, Academic, News, Translate
- **Translate:** English, Spanish, French, German, and Japanese on-device. With a cloud key, also Filipino, Chinese (Simplified and Traditional), Korean, Portuguese, Italian, Vietnamese, Indonesian, Arabic, Hindi, and Thai.
- **On any page:** select text, then right-click → Proofr → pick a mode, or press Alt+Shift+P to proofread it (rebind at `chrome://extensions/shortcuts`). In editable fields the selection is replaced in place, and Ctrl/Cmd+Z undoes it. Elsewhere the result opens in a dialog with a Copy button.
- **Side panel:** click the toolbar icon to paste or type text, pick a mode with `/`, and keep a local history of results. If your Chrome can run on-device AI but hasn't downloaded the model yet, the panel has a one-time setup button.
- **Hover actions (off by default):** turn on "Hover actions" in Settings → On web pages. Chrome asks once for permission to read pages, since hover needs to run on every site. Hover any paragraph for Summarize, Plain English, and Translate. With a cloud key there is also an "Ask about this…" box for a freeform instruction. Results open in a dialog; the page text is never changed.

## Privacy

Proofr does not run servers, collect data, or track you. Settings, history, and usage counts stay in your browser, and API keys are stored on this device only (not synced). Proofr only reads a page when you right-click, use the shortcut, or turn on hover actions. See the [privacy policy](https://civarry.github.io/proofr/privacy.html).

## Install (development)

1. Clone this repo
2. Open `chrome://extensions`, enable **Developer mode**
3. Click **Load unpacked** and select this folder

## Testing

The browser tests load a copy of the extension in Chrome for Testing through [puppeteer](https://pptr.dev). The repo has no `package.json`, so point `PUPPETEER` at puppeteer's ESM entry from any install (`.../node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js`).

```sh
# On-device language handling, with a stubbed Prompt API (no browser needed)
node test/device-langs.mjs

# Cloud call handling: cut-off answers, retired models, model picking, keyless local servers (no browser needed)
node test/cloud-call.mjs

# UI end-to-end: welcome tab, key save, side panel, rating ask, translate,
# in-place replace + undo, hover permission, setup errors
PUPPETEER=/path/to/puppeteer.js NO_SHOTS=1 node test/e2e-ui.mjs

# Success paths against a local OpenAI-compatible mock provider
PUPPETEER=/path/to/puppeteer.js node test/e2e-mock.mjs

# The real manifest with no site access granted (what a fresh install has)
PUPPETEER=/path/to/puppeteer.js node test/e2e-shipped.mjs

# Update from the published 1.2.4 to the packaged zip (run store/package.sh first)
PUPPETEER=/path/to/puppeteer.js node test/e2e-upgrade.mjs
```

Each script exits non-zero if any check fails. On macOS, Chrome stops painting while the display sleeps or the screen is locked, and the browser tests time out. Run `caffeinate -u -t 600 &` first for a sleeping display; a locked screen has to be unlocked.

`test/run_injection.mjs` is a live prompt-injection check against Groq and needs a real key: `GROQ_API_KEY=... node test/run_injection.mjs`.

## What's new in 1.3.0

- Side panel replaces the popup. On first install a setup tab explains whether on-device AI works on your computer and, if not, how to connect a free Groq key.
- No access to any website by default. Proofr reaches a page only when you use it there. Updating from 1.2.4 gives back the old "all websites" access unless you turn on hover actions.
- Shortcut is now Alt+Shift+P (proofread), changeable at chrome://extensions/shortcuts. Replacing text in a text box can be undone with Ctrl/Cmd+Z.
- API keys are stored on this computer only. If you used Proofr on several computers signed in to the same Chrome profile, re-enter your key on the others.
- Groq's old default model was retired; the new default is `openai/gpt-oss-120b`, and Proofr moves off a retired model automatically.

## Packaging

`sh store/package.sh` builds `store/proofr-<version>.zip` for the Chrome Web Store from an explicit file list, and fails if the manifest or pages reference a file that isn't in the list.
