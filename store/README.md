# Store assets (not part of the extension)

Everything here is used to **generate Chrome Web Store listing images**. None of it
ships in the extension — the loadable extension is the code at the repo root
(`manifest.json`, the `.js`/`.css`/`.html` files next to it, and `icons/`).

## Contents

| File | Purpose |
|------|---------|
| `capture.mjs` | Captures the real 1.3.0 UI (against a local mock provider) into `captures/` |
| `screenshots.html` | The 5 listing frames (1280×800 each), built around those captures |
| `render.mjs` | Renders the frames and writes store-ready PNGs to `../store-screenshots/` |
| `promo-tile.html` | Source for the 440×280 small promotional tile |
| `marquee.html` | Source for the 1400×560 marquee promotional tile |
| `promo-tile-440x280.png` | Rendered small promo tile (search-result card) |
| `marquee-1400x560.png` | Rendered marquee tile |
| `prep_screenshots.py` | Converts any image to the store spec (1280×800, 24-bit PNG, no alpha) |
| `demo/index.html` | Local test page for trying the extension / capturing clean screenshots |

## Regenerating the store screenshots

```sh
export PUPPETEER=/path/to/node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js
node store/capture.mjs   # needs an unlocked screen: Chrome can't paint while macOS is locked
node store/render.mjs    # works any time (chrome-headless-shell)
```

The right-click frame shows a replica of Chrome's context menu (the native menu can't be captured); its item titles come from `constants.js`, the same list `background.js` builds the menu from.

## Regenerating an image from HTML

```sh
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --disable-gpu --hide-scrollbars \
  --force-device-scale-factor=1 --window-size=440,280 \
  --screenshot=out.png "file://$PWD/promo-tile.html"
```

Match `--window-size` to the target size (1400×560 for the marquee, 1280×800 for a
screenshot frame). Store screenshots must be **1280×800 or 640×400, 24-bit PNG (no alpha)**.
