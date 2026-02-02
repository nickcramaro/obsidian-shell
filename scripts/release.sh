#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(node -p "require('$ROOT/manifest.json').version")"
TAG="${1:-$VERSION}"
STAGING="$ROOT/.release-staging"
PLUGIN_ID="claude-shell"

echo "==> Building plugin v${VERSION} (tag: ${TAG})"

# ── 1. Build ────────────────────────────────────────────────────────────
(cd "$ROOT" && npm run build)

# ── 2. Assemble staging directory ────────────────────────────────────────
rm -rf "$STAGING"
mkdir -p "$STAGING/$PLUGIN_ID"

# Plugin files
cp "$ROOT/main.js"       "$STAGING/$PLUGIN_ID/"
cp "$ROOT/manifest.json" "$STAGING/$PLUGIN_ID/"
cp "$ROOT/styles.css"    "$STAGING/$PLUGIN_ID/"

# Minimal node-pty subtree (macOS arm64)
NPT="$ROOT/node_modules/node-pty"
DEST="$STAGING/$PLUGIN_ID/node_modules/node-pty"

mkdir -p "$DEST/lib" "$DEST/build/Release"

cp "$NPT/package.json" "$DEST/"

# JS runtime files
for f in index.js terminal.js unixTerminal.js utils.js eventEmitter2.js interfaces.js types.js; do
  cp "$NPT/lib/$f" "$DEST/lib/"
done

# Native binary + spawn helper
cp "$NPT/build/Release/pty.node"     "$DEST/build/Release/"
cp "$NPT/build/Release/spawn-helper" "$DEST/build/Release/"

# ── 3. Verify binary architecture ───────────────────────────────────────
ARCH_INFO="$(file "$DEST/build/Release/pty.node")"
echo "==> Binary: $ARCH_INFO"

if ! echo "$ARCH_INFO" | grep -q "arm64"; then
  echo "ERROR: pty.node is not arm64. Rebuild with 'npm run postinstall' first."
  exit 1
fi

# ── 4. Create zip for manual install ────────────────────────────────────
ZIP="$ROOT/${PLUGIN_ID}-${TAG}-macos-arm64.zip"
rm -f "$ZIP"
(cd "$STAGING" && zip -r "$ZIP" "$PLUGIN_ID")
echo "==> Zip: $ZIP"

# ── 5. Upload to GitHub release ─────────────────────────────────────────
if ! command -v gh &>/dev/null; then
  echo "WARNING: gh CLI not found — skipping GitHub upload."
  echo "  Install with: brew install gh"
  echo "  Then re-run, or upload manually."
  exit 0
fi

# Create the release if it doesn't exist yet
if ! gh release view "$TAG" --repo nickcramaro/claude-shell &>/dev/null; then
  echo "==> Creating GitHub release ${TAG}"
  gh release create "$TAG" \
    --repo nickcramaro/claude-shell \
    --title "$TAG" \
    --generate-notes
fi

echo "==> Uploading assets to release ${TAG}"
gh release upload "$TAG" \
  --repo nickcramaro/claude-shell \
  --clobber \
  "$STAGING/$PLUGIN_ID/main.js" \
  "$STAGING/$PLUGIN_ID/manifest.json" \
  "$STAGING/$PLUGIN_ID/styles.css" \
  "$ZIP"

echo "==> Done! Release ${TAG} updated."
echo "  https://github.com/nickcramaro/claude-shell/releases/tag/${TAG}"

# Cleanup
rm -rf "$STAGING"
