#!/bin/sh
# distill installer
#
#   curl -fsSL https://raw.githubusercontent.com/mtrbls/distill/main/install.sh | sh
#
# Downloads the matching distill binary from GitHub Releases, verifies
# the checksum, installs to ~/.distill/bin/distill, registers the
# Claude Code plugin, and exits. No npm, no Node, no Bun required at
# install or runtime.
#
# Environment:
#   DISTILL_PREFIX   install dir (default: $HOME/.distill)
#   DISTILL_VERSION  pinned version (default: latest)
#   DISTILL_REPO     GitHub owner/repo (default: mtrbls/distill)
#
# Telemetry:
#   nothing is emitted until you run `distill connect` (the OTLP
#   receiver is auth-gated). counts + durations only, never content.
#   opt out even then:
#     sh -s -- --no-telemetry  |  distill telemetry off  |  DO_NOT_TRACK=1

set -eu

REPO="${DISTILL_REPO:-mtrbls/distill}"
PREFIX="${DISTILL_PREFIX:-$HOME/.distill}"
VERSION="${DISTILL_VERSION:-latest}"

NO_TELEMETRY=0
for arg in "$@"; do
  case "$arg" in
    --no-telemetry) NO_TELEMETRY=1 ;;
  esac
done

BIN_DIR="$PREFIX/bin"
BIN_PATH="$BIN_DIR/distill"

# --- helpers -----------------------------------------------------------------

err() { printf "distill installer: error: %s\n" "$*" >&2; exit 1; }
info() { printf "distill: %s\n" "$*"; }

need() { command -v "$1" >/dev/null 2>&1 || err "missing dependency: $1"; }

detect_platform() {
  uname_s="$(uname -s)"
  uname_m="$(uname -m)"
  case "$uname_s" in
    Darwin) os="darwin" ;;
    Linux)  os="linux" ;;
    MINGW*|MSYS*|CYGWIN*) err "Windows is not supported. Use WSL or run install inside a Linux container." ;;
    *) err "unsupported OS: $uname_s" ;;
  esac
  case "$uname_m" in
    arm64|aarch64) arch="arm64" ;;
    x86_64|amd64)  arch="amd64" ;;
    *) err "unsupported arch: $uname_m" ;;
  esac
  printf "%s-%s" "$os" "$arch"
}

resolve_version() {
  if [ "$VERSION" != "latest" ]; then
    echo "$VERSION"
    return
  fi
  # Use the GitHub API's redirect for /releases/latest to find the tag.
  # Fall back to grepping the redirect URL if jq isn't available.
  redirect_url="$(curl -fsSLI -o /dev/null -w '%{url_effective}' \
    "https://github.com/$REPO/releases/latest" 2>/dev/null || true)"
  if [ -z "$redirect_url" ]; then
    err "could not resolve latest version from GitHub. Set DISTILL_VERSION to a tag."
  fi
  printf "%s" "${redirect_url##*/tag/}"
}

# --- main --------------------------------------------------------------------

need curl
need uname
need mkdir
need mv
need chmod

platform="$(detect_platform)"
info "platform: $platform"

resolved_version="$(resolve_version)"
info "version:  $resolved_version"

asset="distill-$platform"
asset_url="https://github.com/$REPO/releases/download/$resolved_version/$asset"
checksum_url="https://github.com/$REPO/releases/download/$resolved_version/SHA256SUMS"

mkdir -p "$BIN_DIR"

# Download binary
tmp_bin="$(mktemp 2>/dev/null || mktemp -t distill)"
trap 'rm -f "$tmp_bin"' EXIT INT TERM
info "downloading $asset_url"
if ! curl -fsSL --proto '=https' --tlsv1.2 -o "$tmp_bin" "$asset_url"; then
  err "download failed. Check that the release exists at https://github.com/$REPO/releases/tag/$resolved_version"
fi

# Verify checksum if SHA256SUMS is available
tmp_sums="$(mktemp 2>/dev/null || mktemp -t distill-sums)"
trap 'rm -f "$tmp_bin" "$tmp_sums"' EXIT INT TERM
if curl -fsSL --proto '=https' --tlsv1.2 -o "$tmp_sums" "$checksum_url" 2>/dev/null; then
  info "verifying checksum"
  if command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$tmp_bin" | awk '{print $1}')"
  elif command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$tmp_bin" | awk '{print $1}')"
  else
    info "shasum/sha256sum not available, skipping checksum verification"
    actual=""
  fi
  if [ -n "$actual" ]; then
    expected="$(grep "  $asset\$" "$tmp_sums" | awk '{print $1}' || true)"
    if [ -z "$expected" ]; then
      info "no checksum entry for $asset in SHA256SUMS, skipping verification"
    elif [ "$actual" != "$expected" ]; then
      err "checksum mismatch for $asset (got $actual, expected $expected)"
    fi
  fi
  rm -f "$tmp_sums"
else
  info "no SHA256SUMS published, skipping checksum verification"
fi

chmod +x "$tmp_bin"
mv "$tmp_bin" "$BIN_PATH"
info "installed to $BIN_PATH"

# Register Claude Code plugin (and conditionally disable telemetry)
info "registering Claude Code plugin"
if [ "$NO_TELEMETRY" = "1" ]; then
  "$BIN_PATH" install --no-telemetry || err "plugin registration failed. Retry: $BIN_PATH install"
else
  "$BIN_PATH" install || err "plugin registration failed. Retry: $BIN_PATH install"
fi

# First-run probe: surface a real skill from the user's own sessions
"$BIN_PATH" probe || true

# PATH advice
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    printf "\n"
    printf "distill is installed but $BIN_DIR is not on your PATH.\n"
    printf "Add this line to your shell rc (.zshrc / .bashrc):\n\n"
    printf "  export PATH=\"%s:\$PATH\"\n\n" "$BIN_DIR"
    ;;
esac

cat <<'EOF'

Next:
  - Restart Claude Code so the plugin hooks activate.
  - Run `distill upskill` to analyze your recent sessions now.
  - Run `distill status` to see your skills and state.

EOF
