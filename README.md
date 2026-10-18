# Proofr: Private AI Proofreader & Rewriter

Proofread, rewrite in any tone, and translate text on any web page. Proofr is a Chrome extension (Manifest V3) with no account and no Proofr servers.

## How it runs

- **On-device (default when available):** Chrome's built-in AI (Gemini Nano). Your text never leaves your computer. This needs desktop Chrome with built-in AI support and enough disk and memory to download the model. Many machines can't run it.
- **Cloud (bring your own key):** if on-device isn't available, or you pick the Cloud engine, Proofr calls Groq, OpenAI, OpenRouter, or any OpenAI-compatible endpoint with your own API key. The request goes straight from your browser to that provider. A free Groq key takes about a minute to get at [console.groq.com/keys](https://console.groq.com/keys).

The engine setting (Auto, On-device, Cloud) is in the side panel. Auto uses on-device first and falls back to your cloud key.

## Features

- **Modes:** Proofread, Professional, Friendly, Concise, Plain English, Summarize, LinkedIn, Marketing, Executive, Academic, News, Translate
- **Translate:** English, Spanish, French, German, and Japanese on-device. With a cloud key, also Filipino, Chinese (Simplified and Traditional), Korean, Portuguese, Italian, Vietnamese, Indonesian, Arabic, Hindi, and Thai.
- **On any page:** select text, then right-click → Proofr → pick a mode. Or press Ctrl/Cmd+Shift+R for a quick Professional rewrite. In editable fields the selection is replaced in place; elsewhere the result opens in a dialog with a Copy button.
- **Side panel:** click the toolbar icon to paste or type text, pick a mode with `/`, and keep a local history of results.
- **Full-page translate:** right-click a page → "Translate this page (Proofr)".
- **Hover actions (off by default):** turn on "Hover actions" in Settings → On web pages. Hover any paragraph for Summarize, Plain English, Translate, More… (every mode), and an "Ask about this…" box for a freeform instruction (needs a cloud key). Results open in a dialog; the page text is never changed.

## Privacy

Proofr does not run servers, collect data, or track you. Settings, API keys, history, and usage counts stay in your browser. See the [privacy policy](https://civarry.github.io/proofr/privacy.html).

## Install (development)

1. Clone this repo
2. Open `chrome://extensions`, enable **Developer mode**
3. Click **Load unpacked** and select this folder
