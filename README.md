# Proofr: Private AI Proofreader & Rewriter

Proofread, rewrite in any tone, and translate text on any web page. Proofr is a Chrome extension (Manifest V3) with no account and no Proofr servers.

## How it runs

- **On-device (default when available):** Chrome's built-in AI (Gemini Nano). Your text never leaves your computer. This needs desktop Chrome with built-in AI support and enough disk and memory to download the model. Many machines can't run it.
- **Cloud (bring your own key):** if on-device isn't available, or you pick the Cloud engine, Proofr calls the provider you choose with your own API key: Groq, OpenAI, OpenRouter, Google Gemini, Mistral, DeepSeek, Together AI, or any OpenAI-compatible endpoint. The request goes straight from your browser to that provider. You can add as many custom endpoints as you need (Settings → AI provider → Add custom endpoint…). Each has its own name, base URL, key, and model, and appears by that name in the provider menus. An endpoint's name, URL, and key are one form with one Save, which checks the server first and saves nothing if it can't connect (a rename alone saves without a check); Cancel puts the fields back, and Remove asks once before deleting the endpoint and its key. Picking a provider or a model saves at once.
- **Local server (no key):** Ollama, LM Studio, or a custom endpoint on your own computer or network. Proofr asks once for access to that address. A free Groq key takes about a minute to get at [console.groq.com/keys](https://console.groq.com/keys).

The engine setting (Auto, On-device, Cloud) is in the side panel. Auto uses on-device first and falls back to your cloud key.

## Features

- **Modes:** Proofread (including unnecessary whitespace, a sentence split by blank lines, and hidden characters from copied AI text such as zero-width and no-break spaces, which the result counts), Professional, Friendly, Concise, Plain English, Summarize, LinkedIn, Marketing, Executive, Academic, News, Translate
- **Translate:** English, Spanish, French, German, and Japanese on-device. With a cloud key, also Filipino, Chinese (Simplified and Traditional), Korean, Portuguese, Italian, Vietnamese, Indonesian, Arabic, Hindi, and Thai.
- **On any page:** select text, then right-click → Proofr → pick a mode, or press Alt+Shift+P (Option+Shift+P on a Mac) to proofread it (rebind at `chrome://extensions/shortcuts`). In editable fields the selection is replaced in place, and Ctrl/Cmd+Z undoes it. Elsewhere the result opens in a dialog with a Copy button. Proofread results in the dialog mark each change (removed words struck through, added words highlighted), with a toggle back to plain text. Click a change to put just that one back to your original words; Copy and Replace use what you kept. On-device answers appear as they are written. While an in-place rewrite runs, a small note next to the field shows progress (seconds, or a percentage for Proofread) with a Stop button; Esc also stops it while focus is still in that field. The same note then becomes the confirmation, with Review (the same view, and "Apply to text box" puts back only the changes you kept) and an Undo button, for editors where Ctrl/Cmd+Z doesn't reach the change. It stays while the pointer is over it. Alt+Shift+R (Option+Shift+R on a Mac) opens Review for the last change on the page, after the note has gone. If you moved to another box before the result came back, nothing is pasted until you click Apply. Errors from the model offer Try again, and a cloud alternative when on-device AI failed. Each result says where the text went and which model answered: "On this computer · Gemini Nano", "On your computer or network · <model>" (a local server), or "Sent to <provider> · <model>". With Coach mode on, a Proofread with nothing to fix shows the usual small toast.
- **Change guard:** a Proofread is not pasted in if it changed more than half the words (in text of 6 words or more), or removed a number, a likely name, a hedge like "maybe" or "I think", or added or removed a negation like "not". It opens in the dialog instead, with the reason and a "Replace anyway" button. The 50% line is the 95th percentile of how much human correctors changed in the [JFLEG](https://github.com/keisks/jfleg) corpus.
- **Side panel:** click the toolbar icon to paste or type text, pick a mode with `/`, and keep a local history of results. Each result shows its length in characters, counted the same way as the limit under the text box. Settings → Appearance picks Auto (your computer's light or dark setting, the default), Light, or Dark; it applies at once to the side panel, the welcome tab, and Proofr's dialog and notes on web pages. If your Chrome can run on-device AI but hasn't downloaded the model yet, the panel has a one-time setup button.
- **Progress tab:** three cards. The first says in plain words how your mistake rate changed, comparing this week with the oldest of the last 8 weeks that had at least 200 words ("38% fewer mistakes than 7 weeks ago", "About 1 in every 125 words this week, down from 1 in 80"), with a small chart once two weeks are rated (before that, a bar counting this week's words toward 200), how many words you've mastered and are practicing, and the Practice button. The second names your main writing habit, with one example and at most one more. The third lists your words: each has a meter of right uses since its last fix (3 needed), and tapping it shows the fix, its rule and your last 6 times (fixed or right). Writing a word right on 3 different days, with no fix for 14 days, masters it ("Mastered in 10 days" while it waits), and the toast after that proofread says so. Sentence-start capitals and punctuation aren't listed; "I" and days of the week are. Only your own writing counts: a text box or the side panel, never text selected on a page. It is built from corrected word pairs and word counts kept on this computer, never your sentences, and can be turned off in Settings. A Proofread the change guard flagged is not learned from. "Get AI tips" makes one request with up to 6 of those words (nothing else) to your AI and shows a tip inside each word's row, only when the tip is about that word and quotes only words you wrote. The tips stay until a new word joins the list, which the card says ("Refresh AI tips"); a word the AI wrote no usable tip for can be asked for on its own ("Get tips for 2 more", only those words are sent), and "Write new tips" asks again for all of them.
- **Your patterns:** habits read from your own repeated fixes ("You leave out apostrophes in contractions", "You mix up your and you're"), shown only once your fixes support one, so each person's Progress tab reads differently. A mistake is only taught after it repeats, so one wrong fix by the AI never becomes a lesson.
- **Practice:** a short game from your own repeated mistakes. The start screen shows how many of your words need practice (never the words themselves, which are the answers) and three modes; the last one used is focused: **Quick** asks up to 10 words, one question each, then shows your score; **Mix-ups** asks only classic confusions (its/it's, their/they're/there, your/you're, then/than, a/an, was/were), and is the one mode open before you have practicable words of your own; **Keep going** asks every word you're working on until each is right twice this session, stops at a checkpoint every 10 answers ("10 more" or "Done for now", with that stretch's score and your best run), and ends by itself when nothing is left to practice. With fewer than 4 words of your own, Quick and Keep going top the round up to 6 with those classic mix-ups; your own words always come first, and mix-ups keep their own practice levels and never count toward Progress. No timer, no daily streak, no XP. A run of 5 or 10 in a row gets a bigger pop, a word that levels up says so in the feedback ("receive: level 3, spot it yourself."), and the summary shows "New best" when your best run beats your stored record. Optional sounds (Settings, off by default): a soft chime for right and a low tone for wrong, made on this computer with Web Audio, no audio files. Each word has a level that rises after 2 right in a row and drops after a miss: 1, pick the fix from two choices (the fix and your own mistake); 2, from three (adds one real near-miss); 3, tap the mistake in the sentence; 4, type the word (case only counts for capitals; curly and straight apostrophes are the same). It aims at about 4 in 5 right: over 90% of your last 10 answers serves the next word one level up, under 65% one level down. A missed word comes back 3-5 questions later with a different sentence, and first again next round. Feedback with the rule appears right under the answer. With two choices the right one is never in the same place 3 times running; with three, never twice. Questions come from your own AI (on-device first, else your provider) while "Learn from my proofreads" is on: only your words are sent, each with a topic from a built-in list (a work email, cooking dinner, and so on) so sentences vary. The AI writes one plain sentence using the word; code finds the word, makes the blank, builds the choices, and checks the sentence, then your normal Proofread checks it and any sentence it would change is dropped. On-device that is 4 sentences a refill, one request each; a provider gets 8 in one request plus one Proofread call for the batch (at most 40 provider calls a day; on-device has no cap). About 5 questions wait on this computer so a round starts at once, with built-in sentences when none are ready. Every question has one clearly right choice: each built-in sentence fits its word and none of the other choices ("they ___ already left" for have, never "I wrote ___ in the email"), and a word without one (form/from: both are real words) waits for an AI sentence, asking the next word meanwhile, or sits the round out when no AI is available. A sentence you've seen never comes back: Proofr remembers a short fingerprint of each one, not its text. Practice keeps per-word right/wrong counts and levels on this computer and never counts toward mastery; only real writing does. Keys 1-3 answer, Enter checks or continues, Esc closes; motion is off with reduce-motion.
- **Coach mode (off by default):** Proofread marks the spots in your text box instead of fixing them. "I'll fix them" returns you to the box; "Show fixes" opens the usual diff with Apply to text box.
- **Small models learn from a big one:** on-device Nano, local servers (Ollama, LM Studio) and small cloud models (about 14B parameters or less) get a couple of worked examples per task, written and checked by a strong model, including one that treats an instruction inside the text as text. Big models skip them and their cost. `store/distill.mjs` measures the examples on a real small model against a big model's answers, and only replaces them with a set that scores better than both the shipped examples and none: `GROQ_API_KEY=... node store/distill.mjs grammar`.
- **On-device speed:** Proofr follows Google's guidance for the Prompt API: each mode's rules and examples go into one base session, and every request runs on a clone of it, so Gemini Nano doesn't re-read them each time. After an on-device proofread the background stays warm for 5 minutes. Translation uses Chrome's Translator (39 languages on-device, versus 5 for Gemini Nano) when its language pack is there; the side panel can download a pack on your click. The same text, mode and model twice answers at once, on-device or cloud (Try again always asks again). Every call into Chrome's AI has a time limit, so a stalled call falls back instead of hanging. Measured with real Gemini Nano in Chrome 155 (`test/nano-bench.html`): each proofread after the first is 45% faster (807 → 447 ms median) with the first words on screen 64% sooner (570 → 208 ms); the first one in a session is 22% slower, because it builds the base. The Summarizer API is not used: it dropped numbers from summaries in testing.
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

# Rating ask: shown after 10 successful results, once more after "Not now", never after "Rate it" (no browser needed)
node test/rating.mjs

# Practice game: tappable words and answer choices built from your own mistakes (no browser needed)
node test/practice-play.mjs

# Practice questions from your AI: the prompts and examples, parsing, the code and Proofread checks, never repeating, levels, the daily budget (no browser needed)
node test/practice-engine.mjs

# Teacher examples: which models get them, how they're sent, and that each passes the live checks (no browser needed)
node test/distill.mjs

# HTML escaping: every helper escapes quotes, so a model id or answer can't break out of an attribute (no browser needed)
node test/escape.mjs

# On-device work, old code against new: sessions created, characters re-read per request, cache, Translator, stalls (no browser needed)
node test/device-perf.mjs

# Cloud call handling: cut-off answers, retired models, model picking, keyless local servers, custom endpoints (no browser needed)
node test/cloud-call.mjs

# Right-click menu: overlapping rebuilds (install + startup) leave one copy of each item (no browser needed)
node test/context-menu.mjs

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

# The background stays warm after an on-device proofread (with a control that proves an idle one is stopped)
PUPPETEER=/path/to/puppeteer.js node test/e2e-warm.mjs

# Update from the published 1.2.4 to the packaged zip (run store/package.sh first)
PUPPETEER=/path/to/puppeteer.js node test/e2e-upgrade.mjs
```

Each script exits non-zero if any check fails. On macOS, Chrome stops painting while the display sleeps or the screen is locked, and the browser tests time out. Run `caffeinate -u -t 600 &` first for a sleeping display; a locked screen has to be unlocked.

`test/nano-bench.html` measures real Gemini Nano in your own Chrome: load the extension unpacked, open `chrome-extension://<id>/test/nano-bench.html` (or serve the repo on localhost and open it there), and press Run. It compares the previous on-device path with the current one and copies the results as JSON.

`test/run_injection.mjs` is a live prompt-injection check against Groq and needs a real key: `GROQ_API_KEY=... node test/run_injection.mjs`.

## What's new in 1.3.1

- Practice is a short game: pick the fix, tap the mistake, or type the word, with each word's level rising as you get it right. Three modes: Quick (10 questions), Keep going (with a checkpoint every 10), and Mix-ups (classic confusions like its/it's).
- Questions are written by your own AI around your words, checked by your Proofread, and never repeated. Every question has one clearly right answer.
- The Progress tab is three cards: how your mistake rate changed, your main habit, and your words, each with a meter toward mastery and its AI tip inside the row.
- AI tips can be asked for again: only for words without one, or fresh wording for all.
- The rating ask comes after 10 successful results, in the side panel and on pages alike (pages used to ask after 5). "Rate it" ends it; "Not now" asks once more 30 rewrites later, as "No thanks", and that is the last time. Chrome doesn't tell extensions who rated, so clicking "Rate it" is what counts.

## What's new in 1.3.0

- Side panel replaces the popup. On first install a setup tab explains whether on-device AI works on your computer and, if not, how to connect a free Groq key.
- No access to any website by default. Proofr reaches a page only when you use it there. Updating from 1.2.4 gives back the old "all websites" access unless you turn on hover actions.
- Shortcut is now Alt+Shift+P, or Option+Shift+P on a Mac. It proofreads the selection, or the whole text box when nothing is selected. Change it from Proofr's settings, which opens chrome://extensions/shortcuts. Replacing text in a text box can be undone with Ctrl/Cmd+Z.
- API keys are stored on this computer only. If you used Proofr on several computers signed in to the same Chrome profile, re-enter your key on the others.
- Groq's old default model was retired; the new default is `openai/gpt-oss-120b`, and Proofr moves off a retired model automatically.

## Packaging

`sh store/package.sh` builds `store/proofr-<version>.zip` for the Chrome Web Store from an explicit file list, and fails if the manifest or pages reference a file that isn't in the list.
