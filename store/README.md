# Store assets (not part of the extension)

Everything here is used to **generate Chrome Web Store listing images**. None of it
ships in the extension — the loadable extension is the code at the repo root
(`manifest.json`, `background.js`, `constants.js`, `content.js`, `popup.*`, `modal.css`, `icons/`).

## Contents

| File | Purpose |
|------|---------|
| `screenshots.html` | 5-frame mockup kit (1280×800 each) for the listing screenshots |
| `promo-tile.html` | Source for the 440×280 small promotional tile |
| `marquee.html` | Source for the 1400×560 marquee promotional tile |
| `promo-tile-440x280.png` | Rendered small promo tile (search-result card) |
| `marquee-1400x560.png` | Rendered marquee tile |
| `prep_screenshots.py` | Converts any image to the store spec (1280×800, 24-bit PNG, no alpha) |
| `demo/index.html` | Local test page for trying the extension / capturing clean screenshots |

## Regenerating an image from HTML

```sh
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --disable-gpu --hide-scrollbars \
  --force-device-scale-factor=1 --window-size=440,280 \
  --screenshot=out.png "file://$PWD/promo-tile.html"
```

Match `--window-size` to the target size (1400×560 for the marquee, 1280×800 for a
screenshot frame). Store screenshots must be **1280×800 or 640×400, 24-bit PNG (no alpha)**.
