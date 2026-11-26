#!/usr/bin/env bash
# Builds the ADG RMM release bundle that install.sh downloads.
#
# Run it on Linux x86_64 (a Linux machine, WSL, the Docker command below, or the GitHub Actions workflow), from a
# checkout of this repository (the web app is in frontend/):
#
#   install/build-release.sh --version 1.4.0 [--agents DIR] [--out DIR] [--publish]
#
# On Windows, without WSL, in Docker:
#   docker run --rm -v "<this repo>:/src" -v "<output>:/out" node:22-bookworm \
#     bash /src/install/build-release.sh --backend /src --out /out --version 1.4.0
#
# What goes in (everything is taken from the committed code, not from uncommitted changes):
#   backend/        compiled API, Prisma schema and migrations, production node_modules
#   frontend/       the web app as a self-contained server
#   runtime/bin/node  a pinned Node.js, so the install needs nothing from the system
#   agent-packages/ the Windows and Linux agents, if --agents is given (windows/, linux/, each with version.json)
#   tools/ docker/  the installer's helpers
#
# Output (in --out): adgrmm-linux-x64.tar.gz, SHA256SUMS, version.txt, install.sh
set -Eeuo pipefail

ADG_NODE_VERSION="${ADG_NODE_VERSION:-22.19.0}"
NODE_VERSION="$ADG_NODE_VERSION"
# Replaced with the real address when the bundle is installed. See install.sh (apply_placeholders).
PUBLIC_PLACEHOLDER="adg-public-url.invalid"
COOKIE_PLACEHOLDER="adg-cookie-placeholder"
INTERNAL_BACKEND="http://adg-backend:3001"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_REPO="$(cd "$HERE/.." && pwd)"
AGENTS=""
OUT="$PWD/release-out"
VERSION=""
REF="HEAD"
PUBLISH=0
REPO_SLUG="${ADG_REPO:-adgsaas/adgrmm}"

usage() { sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }
while [ $# -gt 0 ]; do
    case "$1" in
        --backend) BACKEND_REPO="$(cd "$2" && pwd)"; shift 2 ;;
        --agents) AGENTS="$(cd "$2" && pwd)"; shift 2 ;;
        --out) mkdir -p "$2" && OUT="$(cd "$2" && pwd)"; shift 2 ;;
        --version) VERSION="$2"; shift 2 ;;
        --ref) REF="$2"; shift 2 ;;
        --publish) PUBLISH=1; shift ;;
        -h|--help) usage 0 ;;
        *) echo "Unknown option: $1" >&2; usage 2 ;;
    esac
done

[ "$(uname -s)" = "Linux" ] || { echo "Build on Linux (see the header of this script for the Docker command)." >&2; exit 1; }
[ "$(uname -m)" = "x86_64" ] || { echo "The bundle is for x86_64 Linux; this machine is $(uname -m)." >&2; exit 1; }
for c in git node npm curl tar xz sha256sum; do command -v "$c" >/dev/null 2>&1 || { echo "Missing tool: $c" >&2; exit 1; }; done

# git refuses repositories owned by someone else (a mounted folder in Docker, for example).
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0='*'

if [ -z "$VERSION" ]; then
    VERSION="$(git -C "$BACKEND_REPO" describe --tags --abbrev=0 2>/dev/null | sed 's/^v//' || true)"
    [ -n "$VERSION" ] || VERSION="0.0.0-$(date -u +%Y%m%d)-$(git -C "$BACKEND_REPO" rev-parse --short "$REF")"
fi
BACKEND_SHA="$(git -C "$BACKEND_REPO" rev-parse --short "$REF")"
FRONTEND_SHA="$BACKEND_SHA"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
STAGE="$WORK/adgrmm"
mkdir -p "$STAGE"/{backend,frontend,runtime/bin,tools,docker,agent-packages}
say() { printf '\n==> %s\n' "$*"; }

# ------------------------------------------------------------------ backend
say "Backend $BACKEND_SHA"
mkdir -p "$WORK/backend-src"
git -C "$BACKEND_REPO" archive "$REF" backend | tar -x -C "$WORK/backend-src"
(
    cd "$WORK/backend-src/backend"
    npm ci --no-audit --no-fund
    npx prisma generate
    npx tsc -p tsconfig.json
    PRISMA_VERSION="$(node -p "require('./node_modules/prisma/package.json').version")"
    npm prune --omit=dev --no-audit --no-fund
    # The migration step needs the Prisma command line tool, which is a development dependency.
    npm install --no-save --no-audit --no-fund "prisma@$PRISMA_VERSION"
    # Regenerating after the prune puts the generated client back where it was removed from.
    npx prisma generate
    test -x node_modules/.bin/prisma
)
cp -a "$WORK/backend-src/backend/"{dist,prisma,package.json,package-lock.json,node_modules} "$STAGE/backend/"
[ -d "$WORK/backend-src/backend/scripts" ] && cp -a "$WORK/backend-src/backend/scripts" "$STAGE/backend/"
mkdir -p "$STAGE/backend/public/uploads"

# ------------------------------------------------------------------ web app
say "Web app $FRONTEND_SHA"
mkdir -p "$WORK/web-src"
git -C "$BACKEND_REPO" archive "$REF" frontend | tar -x -C "$WORK/web-src"
(
    cd "$WORK/web-src/frontend"
    npm ci --no-audit --no-fund
    NEXT_TELEMETRY_DISABLED=1 NODE_ENV=production ADG_STANDALONE=1 \
        NEXT_PUBLIC_API_BASE="https://$PUBLIC_PLACEHOLDER" \
        NEXT_PUBLIC_WS_BASE="wss://$PUBLIC_PLACEHOLDER/ws" \
        NEXT_PUBLIC_AUTH_COOKIE_NAME="$COOKIE_PLACEHOLDER" \
        BACKEND_INTERNAL_URL="$INTERNAL_BACKEND" \
        npx next build
    test -f .next/standalone/server.js || { echo "The web app did not produce a standalone server." >&2; exit 1; }
    mkdir -p .next/standalone/.next
    cp -a .next/static .next/standalone/.next/static
    [ -d public ] && cp -a public .next/standalone/public
)
cp -a "$WORK/web-src/frontend/.next/standalone/." "$STAGE/frontend/"

# ------------------------------------------------------------------ Node.js
say "Node.js $NODE_VERSION"
NODE_TAR="node-v$NODE_VERSION-linux-x64.tar.xz"
curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/$NODE_TAR" -o "$WORK/$NODE_TAR"
curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" -o "$WORK/SHASUMS256.txt"
(cd "$WORK" && grep " $NODE_TAR\$" SHASUMS256.txt | sha256sum -c -)
tar -xJf "$WORK/$NODE_TAR" -C "$WORK" "node-v$NODE_VERSION-linux-x64/bin/node" "node-v$NODE_VERSION-linux-x64/LICENSE"
cp "$WORK/node-v$NODE_VERSION-linux-x64/bin/node" "$STAGE/runtime/bin/node"
cp "$WORK/node-v$NODE_VERSION-linux-x64/LICENSE" "$STAGE/runtime/LICENSE-node"

# ------------------------------------------------------------------ helpers, agents, version
say "Installer files"
cp -a "$HERE/tools/." "$STAGE/tools/"
cp -a "$HERE/docker/." "$STAGE/docker/"
cp "$HERE/install.sh" "$STAGE/install.sh"
if [ -n "$AGENTS" ]; then
    for os in windows linux; do
        [ -d "$AGENTS/$os" ] || { echo "WARNING: no $os agent package in $AGENTS" >&2; continue; }
        mkdir -p "$STAGE/agent-packages/$os"
        cp -a "$AGENTS/$os/." "$STAGE/agent-packages/$os/"
    done
else
    echo "NOTE: no --agents given; the bundle carries no agent packages." >&2
    rm -rf "$STAGE/agent-packages"
fi
printf '%s\n' "$VERSION" > "$STAGE/VERSION"
cat > "$STAGE/BUILD-INFO" <<EOF
version=$VERSION
backend=$BACKEND_SHA
frontend=$FRONTEND_SHA
node=$NODE_VERSION
built=$(date -u +%Y-%m-%dT%H:%M:%SZ)
public_placeholder=$PUBLIC_PLACEHOLDER
cookie_placeholder=$COOKIE_PLACEHOLDER
internal_backend=$INTERNAL_BACKEND
EOF

# ------------------------------------------------------------------ pack
say "Packing"
mkdir -p "$OUT"
tar -C "$WORK" -czf "$OUT/adgrmm-linux-x64.tar.gz" adgrmm
cp "$HERE/install.sh" "$OUT/install.sh"
printf '%s\n' "$VERSION" > "$OUT/version.txt"
(cd "$OUT" && sha256sum adgrmm-linux-x64.tar.gz install.sh version.txt > SHA256SUMS)
ls -lh "$OUT"
echo
echo "Built ADG RMM $VERSION (backend $BACKEND_SHA, web app $FRONTEND_SHA) in $OUT"

if [ "$PUBLISH" = 1 ]; then
    command -v gh >/dev/null 2>&1 || { echo "--publish needs the GitHub CLI (gh)." >&2; exit 1; }
    gh release create "v$VERSION" --repo "$REPO_SLUG" --title "ADG RMM $VERSION" --generate-notes \
        "$OUT/adgrmm-linux-x64.tar.gz" "$OUT/SHA256SUMS" "$OUT/version.txt" "$OUT/install.sh"
fi
