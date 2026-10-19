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
- **On any page:** select text, then right-click → Proofr → pick a mode, or press Alt+Shift+P (Option+Shift+P on a Mac) to proofread it (rebind at `chrome://extensions/shortcuts`). In editable fields the selection is replaced in place, and Ctrl/Cmd+Z undoes it. Elsewhere the result opens in a dialog with a Copy button. Proofread results in the dialog mark each change (removed words struck through, added words highlighted), with a toggle back to plain text. Click a change to put just that one back to your original words; Copy and Replace use what you kept. On-device answers appear as they are written. While an in-place rewrite runs, a small note next to the field shows progress (seconds, or a percentage for Proofread) with a Stop button; Esc also stops it while focus is still in that field. The same note then becomes the confirmation, with Review (the same view, and "Apply to text box" puts back only the changes you kept) and an Undo button, for editors where Ctrl/Cmd+Z doesn't reach the change. It stays while the pointer is over it. Alt+Shift+R (Option+Shift+R on a Mac) opens Review for the last change on the page, after the note has gone. If you moved to another box before the result came back, nothing is pasted until you click Apply. Errors from the model offer Try again, and a cloud alternative when on-device AI failed. Each result says where the text went and which model answered: "On this computer · Gemini Nano", "On your computer or network · <model>" (a local server), or "Sent to <provider> · <model>". With Coach mode on, a Proofread with nothing to fix shows the usual small toast.
- **Change guard:** a Proofread is not pasted in if it changed more than half the words (in text of 6 words or more), or removed a number, a likely name, a hedge like "maybe" or "I think", or added or removed a negation like "not". It opens in the dialog instead, with the reason and a "Replace anyway" button. The 50% line is the 95th percentile of how much human correctors changed in the [JFLEG](https://github.com/keisks/jfleg) corpus.
- **Side panel:** click the toolbar icon to paste or type text, pick a mode with `/`, and keep a local history of results. If your Chrome can run on-device AI but hasn't downloaded the model yet, the panel has a one-time setup button.
- **Progress tab:** the side panel's Progress tab shows your mistakes per 100 words this week with an 8-week chart, how you write (the share of each kind of fix, and how it shifted from 4 weeks before), a weekly focus, and the words you're working on. Each word has a strip of its last 6 appearances: a ring when Proofr fixed it, a filled dot when you wrote it right (at most one a day). Writing it right on 3 different days in a row, with no fix for 14 days, masters it, and the toast after that proofread says so. Only your own writing counts: a text box or the side panel, never text selected on a page. It is built from corrected word pairs and word counts kept on this computer, never your sentences, and can be turned off in Settings. A Proofread the change guard flagged is not learned from. "Get writing tips" sends only that word list to your AI, shows only tips that name your own words, and asks once per list.
- **Your patterns:** habits read from your own repeated fixes ("You leave out apostrophes in contractions", "You mix up your and you're"), shown only once your fixes support one, so each person's Progress tab reads differently. A mistake is only taught after it repeats, so one wrong fix by the AI never becomes a lesson.
- **Practice:** two-minute rounds of sentences built on this computer from your own common mistakes, checked locally with the rule for anything missed.
- **Coach mode (off by default):** Proofread marks the spots in your text box instead of fixing them. "I'll fix them" returns you to the box; "Show fixes" opens the usual diff with Apply to text box.
- **Small models learn from a big one:** on-device Nano, local servers (Ollama, LM Studio) and small cloud models (about 14B parameters or less) get a couple of worked examples per task, written and checked by a strong model, including one that treats an instruction inside the text as text. Big models skip them and their cost. `store/distill.mjs` measures the examples on a real small model against a big model's answers, and only replaces them with a set that scores better than both the shipped examples and none: `GROQ_API_KEY=... node store/distill.mjs grammar`.
- **Cost on your key:** instructions are about 240 tokens per request, and the answer budget fits the text, so a short fix can't run away and a long one isn't cut off.
- **Prompt-injection defenses:** the text you select is sent inside a tag with a random id that page text can't close, with a rule before and after it saying it is data, not instructions. Cloud calls send the rules as a separate system message. A reply that repeats Proofr's instructions is refused and never pasted.
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

# Proofread word diff: round trips, change count, size cap (no browser needed)
node test/diff.mjs

# Proofread change guard: normal fixes pass, meaning changes are caught (no browser needed)
node test/guard.mjs

# Writing insights: which corrected word pairs are kept (no names, numbers, links or phrases), counts, practice (no browser needed)
node test/insights.mjs

# Learning: six simulated writers over 8 weeks get habits, focus, rules and practice that fit them,
# never the model's one-off wrong fixes, and nothing stored beyond corrected words (no browser needed)
node test/learning-sim.mjs

# Prompt-injection defenses: fencing, rules around the text, system/user split, leaked replies refused (no browser needed)
node test/injection.mjs

# Cost on your own key: instruction size, answer budget per request, tips grounded in your words (no browser needed)
node test/efficiency.mjs

# Teacher examples: which models get them, how they're sent, and that each passes the live checks (no browser needed)
node test/distill.mjs

# HTML escaping: every helper escapes quotes, so a model id or answer can't break out of an attribute (no browser needed)
node test/escape.mjs

# Cloud call handling: cut-off answers, retired models, model picking, keyless local servers (no browser needed)
node test/cloud-call.mjs

# One design system: type scale, corner radii, shared palette, AA text contrast
node test/design-tokens.mjs

# UI end-to-end: welcome tab, key save, side panel, rating ask, translate,
# in-place replace + undo, hover permission, setup errors, Progress, Practice,
# Coach mode, and an injected reply never reaching the page
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
- Shortcut is now Alt+Shift+P, or Option+Shift+P on a Mac. It proofreads the selection, or the whole text box when nothing is selected. Change it from Proofr's settings, which opens chrome://extensions/shortcuts. Replacing text in a text box can be undone with Ctrl/Cmd+Z.
- API keys are stored on this computer only. If you used Proofr on several computers signed in to the same Chrome profile, re-enter your key on the others.
- Groq's old default model was retired; the new default is `openai/gpt-oss-120b`, and Proofr moves off a retired model automatically.

## Packaging

`sh store/package.sh` builds `store/proofr-<version>.zip` for the Chrome Web Store from an explicit file list, and fails if the manifest or pages reference a file that isn't in the list.
