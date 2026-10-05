#!/bin/sh
# SuperIU headless server installer.
#
# POSIX sh only (dash, ash, bash-as-sh): no bashisms. Safe under `set -eu`,
# never requires root, and is idempotent — re-running upgrades in place.
#
# Environment:
#   SUPERIU_RELEASE_BASE  Release download base URL.
#                         Default: https://github.com/Kayphoon/SuperIU/releases/latest/download
#                         Keep this default in sync with REPO_SLUG in
#                         packages/desktop/src/constants.ts (install.sh cannot
#                         import TS).
#   SUPERIU_VERSION       Pin a release tag (e.g. 0.1.0). Prefixes the asset URL
#                         with /download/v<version> instead of /latest/download.
set -eu

RELEASE_BASE="${SUPERIU_RELEASE_BASE:-https://github.com/Kayphoon/SuperIU/releases/latest/download}"
INSTALL_DIR="${HOME}/.superiu/bin"
BINARY_NAME="superiu-server"

# --- preflight: OS / arch / downloader -------------------------------------

os_name="$(uname -s)"
case "$os_name" in
  Linux) ;;
  *)
    echo "error: unsupported OS '$os_name'. This installer only supports Linux." >&2
    exit 1
    ;;
esac

machine="$(uname -m)"
case "$machine" in
  x86_64 | amd64) asset="superiu-server-linux-x64" ;;
  aarch64 | arm64) asset="superiu-server-linux-arm64" ;;
  *)
    echo "error: unsupported architecture '$machine'. Supported: x86_64, aarch64/arm64." >&2
    exit 1
    ;;
esac

if command -v curl >/dev/null 2>&1; then
  downloader="curl"
elif command -v wget >/dev/null 2>&1; then
  downloader="wget"
else
  echo "error: neither curl nor wget is available; cannot download the server binary." >&2
  exit 1
fi

# --- resolve download URL ---------------------------------------------------

base="${RELEASE_BASE%/}"
if [ -n "${SUPERIU_VERSION:-}" ]; then
  # Strip a leading "v" so both `0.1.0` and `v0.1.0` produce one tag form.
  version="${SUPERIU_VERSION#v}"
  # Swap the trailing `latest/download` (or a trailing `download`) segment for
  # the pinned tag's `download/v<version>`, matching the GitHub Releases layout:
  #   .../releases/latest/download  ->  .../releases/download/v0.1.0
  case "$base" in
    */latest/download) base="${base%/latest/download}/download" ;;
  esac
  url="${base%/}/v${version}/${asset}"
else
  url="${base}/${asset}"
fi

# --- install ----------------------------------------------------------------

mkdir -p "$INSTALL_DIR"

tmp="$(mktemp "${TMPDIR:-/tmp}/superiu-server.XXXXXX")"
cleanup() {
  rm -f "$tmp"
}
trap cleanup EXIT INT TERM

echo "Downloading $asset"
echo "  from $url"

case "$downloader" in
  curl)
    if ! curl -fL --retry 3 --connect-timeout 30 -o "$tmp" "$url"; then
      echo "error: download failed: $url" >&2
      exit 1
    fi
    ;;
  wget)
    if ! wget -q -O "$tmp" "$url"; then
      echo "error: download failed: $url" >&2
      exit 1
    fi
    ;;
esac

chmod +x "$tmp"

target="$INSTALL_DIR/$BINARY_NAME"

# If a daemon is running from the current install, stop it before swapping the
# binary, then bring it back up. A failure to detect a running server is not
# fatal: the swap is still attempted.
restart_workspace=""
if [ -x "$target" ]; then
  if status_out="$("$target" status 2>/dev/null)"; then
    case "$status_out" in
      *'"running":true'*)
        # Reuse the workspace the running daemon reported, if any, on restart.
        restart_workspace="$(printf '%s' "$status_out" | sed -n 's/.*"workspace":"\([^"]*\)".*/\1/p')"
        echo "Stopping running server before upgrade"
        "$target" stop >/dev/null 2>&1 || true
        ;;
    esac
  fi
fi

# Atomic swap so a crash mid-install can never leave a truncated binary.
mv -f "$tmp" "$target"
trap - EXIT INT TERM

version_out="$("$target" version 2>/dev/null || printf '')"
installed_version="$(printf '%s' "$version_out" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')"
[ -n "$installed_version" ] || installed_version="unknown"

echo "Installed $BINARY_NAME $installed_version -> $target"

if [ -n "$restart_workspace" ]; then
  "$target" start --workspace "$restart_workspace" >/dev/null 2>&1 &
  echo "Restarted server in $restart_workspace"
else
  echo "Start it with: $target start"
fi
