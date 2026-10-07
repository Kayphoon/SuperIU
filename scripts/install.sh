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
#   SUPERIU_WORKSPACE     The workspace to probe for an already running daemon.
#                         When set it is the ONLY candidate probed, so an
#                         explicitly named workspace is never overridden by a
#                         daemon found elsewhere. When unset the installer probes
#                         $HOME/.superiu/workspace (the layout the desktop app
#                         provisions), then the current directory, then $HOME.
#
# Upgrades: re-running the script replaces the installed binary in place. A
# daemon that is found running from this install is stopped before the atomic
# swap and started again with its own workspace afterwards; when nothing is
# running, the binary is simply swapped.
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
#
# The daemon is not necessarily discoverable from the installer's cwd: a
# systemd unit starts it with WorkingDirectory=%h, i.e. $HOME. So probe the
# candidates below in order and use the first one that reports a live daemon.
probe_workspace() {
  # Sets restart_candidate (the path that answered) and restart_workspace
  # (the workspace reported by the daemon, or the probed path on older binaries
  # that do not report it) and returns 0 when "$1" has a live daemon.
  probed="$1"
  [ -n "$probed" ] || return 1
  probed_out="$("$target" status --workspace "$probed" 2>/dev/null || printf '')"
  case "$probed_out" in
    *'"running":true'*) ;;
    *) return 1 ;;
  esac
  restart_candidate="$probed"
  restart_workspace="$(printf '%s' "$probed_out" | sed -n 's/.*"workspace":"\([^"]*\)".*/\1/p')"
  # Older binaries omit "workspace" from status: fall back to the path that
  # just answered, so the restart still targets the right directory.
  [ -n "$restart_workspace" ] || restart_workspace="$probed"
  return 0
}

restart_workspace=""
restart_candidate=""
restart_port=""
restart_host=""
restart_token=""
if [ -x "$target" ]; then
  # An explicit $SUPERIU_WORKSPACE is authoritative: when it is set it is probed
  # on its own, so a workspace the caller named is never overridden by a daemon
  # found somewhere else. Otherwise the desktop-provisioned layout goes first —
  # packages/desktop/src/remote/bootstrap.ts starts its daemon with
  # `--workspace "$HOME/.superiu/workspace"` — then the installer's own cwd, then
  # $HOME (a systemd unit starts the daemon with WorkingDirectory=%h). Empty
  # candidates are skipped, and once a live daemon is found the remaining
  # candidates are not probed at all.
  if [ -n "${SUPERIU_WORKSPACE:-}" ]; then
    set -- "${SUPERIU_WORKSPACE}"
  elif [ -n "${HOME:-}" ]; then
    set -- "${HOME}/.superiu/workspace" "$(pwd)" "${HOME}"
  else
    set -- "$(pwd)"
  fi

  for candidate in "$@"; do
    if probe_workspace "$candidate"; then
      echo "Found running server (workspace $restart_workspace)"
      # Capture the daemon's identity BEFORE stopping it: `stop` removes
      # `<workspace>/.superiu/server.json` on shutdown (commandStop's own
      # removeState, and the daemon's SIGTERM handler), so reading the file
      # after the stop would find nothing and the restart would mint a fresh
      # token on the default port. `port` is a JSON number, hence the unquoted
      # pattern; the file is pretty-printed, hence the ` *` after each colon.
      restart_state="$restart_workspace/.superiu/server.json"
      restart_port="$(sed -n 's/.*"port": *\([0-9]*\).*/\1/p' "$restart_state" 2>/dev/null || printf '')"
      restart_host="$(sed -n 's/.*"host": *"\([^"]*\)".*/\1/p' "$restart_state" 2>/dev/null || printf '')"
      restart_token="$(sed -n 's/.*"token": *"\([^"]*\)".*/\1/p' "$restart_state" 2>/dev/null || printf '')"
      echo "Stopping running server before upgrade"
      "$target" stop --workspace "$restart_candidate" >/dev/null 2>&1 || true
      break
    fi
  done
fi

# Atomic swap so a crash mid-install can never leave a truncated binary.
mv -f "$tmp" "$target"
trap - EXIT INT TERM

version_out="$("$target" version 2>/dev/null || printf '')"
installed_version="$(printf '%s' "$version_out" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')"
[ -n "$installed_version" ] || installed_version="unknown"

echo "Installed $BINARY_NAME $installed_version -> $target"

if [ -n "$restart_workspace" ]; then
  # Prefer the user service manager when a `superiu-server` unit exists: the
  # unit owns the process, so restarting it keeps the unit intact. Respawning
  # the binary detached instead would leave the unit's own main process dead,
  # and the service manager would consider the unit broken.
  #
  # Only the unit's *existence* selects this path. `is-active` would be wrong:
  # it is false for a daemon started by hand that a unit merely describes.
  if command -v systemctl >/dev/null 2>&1 && systemctl --user cat superiu-server >/dev/null 2>&1; then
    systemctl --user restart superiu-server || true
  else
    # Restore the identity the daemon had before the swap. Without it the new
    # daemon mints a fresh gateway token (invalidating already-paired clients
    # and any ~/.superiu/env value) and falls back to the default port, which
    # may already be taken.
    #
    # The values were captured from the state file BEFORE the daemon was
    # stopped above, because `stop` removes `<workspace>/.superiu/server.json`.
    # A value the file did not carry — an older binary, an unreadable file — is
    # simply omitted rather than passed empty, so the restart still happens with
    # the previous behaviour instead of failing under `set -e` after the binary
    # has already been swapped.
    set -- start --workspace "$restart_workspace"
    if [ -n "$restart_port" ]; then
      set -- "$@" --port "$restart_port"
    fi
    if [ -n "$restart_host" ]; then
      set -- "$@" --host "$restart_host"
    fi
    if [ -n "$restart_token" ]; then
      set -- "$@" --token "$restart_token"
    fi

    # nohup plus full fd redirection is the POSIX stand-in for disown: the child
    # keeps running after this shell exits. For the systemd unit the restart is
    # additionally covered by Restart=on-failure.
    nohup "$target" "$@" >/dev/null 2>&1 &
  fi

  # Confirm the daemon actually came back instead of reporting success blindly.
  # A plain status probe is used here so the confirmed workspace stays exactly
  # the one the daemon was started with.
  restart_attempt=0
  restart_confirmed=""
  while [ "$restart_attempt" -lt 5 ]; do
    restart_attempt=$((restart_attempt + 1))
    sleep 1
    restart_out="$("$target" status --workspace "$restart_workspace" 2>/dev/null || printf '')"
    case "$restart_out" in
      *'"running":true'*)
        restart_confirmed="yes"
        break
        ;;
    esac
  done

  if [ -n "$restart_confirmed" ]; then
    echo "Restarted server in $restart_workspace"
  else
    echo "warning: the server did not report as running in $restart_workspace after upgrade" >&2
    echo "         the binary was installed, but start it manually with:" >&2
    echo "           $target start --workspace $restart_workspace" >&2
    echo "         (a systemd unit will retry on its own via Restart=on-failure)" >&2
  fi
else
  echo "Start it with: $target start"
fi
