#!/bin/sh
# Uploads the packaged zip to the Chrome Web Store as a new draft and,
# with --submit, submits it for review. Uses the Chrome Web Store API with
# gcloud application-default credentials that include the Web Store scope:
#
#   gcloud auth application-default login \
#     --scopes=https://www.googleapis.com/auth/chromewebstore,https://www.googleapis.com/auth/cloud-platform
#
# usage: sh store/publish.sh            (upload only; check the draft, then)
#        sh store/publish.sh --submit   (upload, then submit for review)
set -eu
cd "$(dirname "$0")/.."

ITEM_ID="dfhooimjbdefdbabhppgloclhkjolhfg"
PROJECT="${CWS_QUOTA_PROJECT:-pihole-vm-42394}"
API="https://www.googleapis.com"

sh store/package.sh >/dev/null
version=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' manifest.json)
zip="store/proofr-$version.zip"

token=$(gcloud auth application-default print-access-token 2>/dev/null) || {
  echo "No Web Store sign-in yet. Run the gcloud login in this file's header first." >&2
  exit 1
}

echo "Uploading $zip (version $version)…"
upload=$(curl -sS -X PUT -T "$zip" \
  -H "Authorization: Bearer $token" -H "x-goog-user-project: $PROJECT" -H "x-goog-api-version: 2" \
  "$API/upload/chromewebstore/v1.1/items/$ITEM_ID")
echo "$upload"
echo "$upload" | grep -q '"uploadState": *"SUCCESS"' || { echo "Upload did not succeed; nothing submitted." >&2; exit 1; }

if [ "${1:-}" = "--submit" ]; then
  echo "Submitting for review…"
  curl -sS -X POST -H "Content-Length: 0" \
    -H "Authorization: Bearer $token" -H "x-goog-user-project: $PROJECT" -H "x-goog-api-version: 2" \
    "$API/chromewebstore/v1.1/items/$ITEM_ID/publish"
  echo
else
  echo "Uploaded as a draft. Update the listing text and screenshots in the dashboard, then run: sh store/publish.sh --submit"
fi
