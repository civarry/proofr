#!/bin/sh
# Builds the Chrome Web Store upload zip from an explicit list of shipped
# files, so nothing else in the repo (research, store assets, old zips) ends up
# in the package. Fails if any file the manifest or pages reference is missing.
set -eu
cd "$(dirname "$0")/.."

FILES="manifest.json background.js constants.js content.js dom-scan.js hover-assist.js modal.css sidepanel.html sidepanel.js icons/icon16.png icons/icon32.png icons/icon48.png icons/icon128.png"

for f in $FILES; do
  [ -f "$f" ] || { echo "missing: $f" >&2; exit 1; }
done

# Every local file the extension loads must be in the list above.
refs=$(grep -ohE "'[a-z-]+\.(js|css)'|\"[a-z-]+\.(js|css|html)\"|src=\"[a-z-]+\.js\"" manifest.json background.js sidepanel.html \
  | tr -d "'\"" | sed 's/^src=//' | sort -u)
for r in $refs; do
  case " $FILES " in *" $r "*) ;; *) echo "referenced but not packaged: $r" >&2; exit 1 ;; esac
done

version=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' manifest.json)
out="store/proofr-$version.zip"
rm -f "$out"
zip -q -X "$out" $FILES
echo "$out"
unzip -l "$out" | tail -n +4 | sed '$d' | sed '$d'
