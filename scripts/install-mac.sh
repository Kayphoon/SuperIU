#!/bin/sh
# SuperIU macOS App installer & updater.
#
# POSIX sh (dash, zsh, bash) compatible.
# Safe under `set -eu`, downloads the latest SuperIU.app release,
# strips macOS Gatekeeper quarantine, installs to /Applications,
# and refreshes LaunchServices.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Kayphoon/SuperIU/master/scripts/install-mac.sh | sh
#
# Environment variables:
#   SUPERIU_RELEASE_BASE  Override release base URL (default: GitHub releases/latest/download)
#   SUPERIU_INSTALL_DIR   Target install directory (default: /Applications)

set -eu

REPO_SLUG="Kayphoon/SuperIU"
APP_NAME="SuperIU"
INSTALL_DIR="${SUPERIU_INSTALL_DIR:-/Applications}"
TARGET_APP="${INSTALL_DIR}/${APP_NAME}.app"

# --- 1. Preflight check ----------------------------------------------------

os_name="$(uname -s)"
if [ "$os_name" != "Darwin" ]; then
  echo "错误: 本安装脚本仅支持 macOS (Darwin)，当前系统为: $os_name" >&2
  exit 1
fi

arch="$(uname -m)"
case "$arch" in
  arm64 | aarch64)
    ARCH_KEY="arm64"
    ;;
  x86_64 | amd64)
    ARCH_KEY="x64"
    ;;
  *)
    echo "错误: 不支持的架构 '$arch'，仅支持 arm64 与 x86_64。" >&2
    exit 1
    ;;
esac

if ! command -v curl >/dev/null 2>&1; then
  echo "错误: 系统中未找到 curl 命令。" >&2
  exit 1
fi

# --- 2. Determine download URL ---------------------------------------------

echo "==> 正在查询 ${APP_NAME} 最新发布版本..."

API_BASE="https://api.github.com/repos/${REPO_SLUG}"
RELEASE_BASE="${SUPERIU_RELEASE_BASE:-https://github.com/${REPO_SLUG}/releases/latest/download}"

# The highest version across ALL channels must win. GitHub's /releases/latest
# only returns the newest STABLE (non-prerelease) tag, which silently hides
# newer rolling builds published on the `latest` prerelease channel; the list
# endpoint returns every release, newest-first, including prereleases.
RELEASES_JSON="$(curl -fsSL "${API_BASE}/releases?per_page=30" 2>/dev/null || true)"
RELEASE_JSON=""
if [ -z "$RELEASES_JSON" ]; then
  # Fallback to the single-release endpoint (previous behavior).
  RELEASE_JSON="$(curl -fsSL "${API_BASE}/releases/latest" 2>/dev/null || true)"
fi

# pick_best_zip <json> -> highest-versioned mac zip URL for the target arch.
# Preference: arch-specific match first, then any mac zip. The version is read
# from the asset filename (SuperIU-N.N.N-mac-<arch>.zip) and compared with
# `sort -V`; assets without an embedded version sort last.
pick_best_zip() {
  _json="$1"
  _urls="$(printf '%s' "$_json" | grep -o 'https://[^" ]*\.zip' | grep 'mac' || true)"
  if [ -z "$_urls" ]; then
    return 0
  fi
  _arch_urls="$(printf '%s\n' "$_urls" | grep "mac-${ARCH_KEY}\.zip" || true)"
  if [ -z "$_arch_urls" ]; then
    _arch_urls="$_urls"
  fi
  printf '%s\n' "$_arch_urls" |
    awk -F/ '{ v = "0.0.0"; if (match($NF, /[0-9]+\.[0-9]+\.[0-9]+/)) v = substr($NF, RSTART, RLENGTH); print v "\t" $0 }' |
    sort -k1,1 -V |
    tail -n 1 |
    cut -f 2
}

DOWNLOAD_URL=""
if [ -n "$RELEASES_JSON" ]; then
  DOWNLOAD_URL="$(pick_best_zip "$RELEASES_JSON")"
fi
if [ -z "$DOWNLOAD_URL" ] && [ -n "$RELEASE_JSON" ]; then
  DOWNLOAD_URL="$(pick_best_zip "$RELEASE_JSON")"
fi

REMOTE_VERSION=""
if [ -n "$DOWNLOAD_URL" ]; then
  REMOTE_VERSION="$(printf '%s' "${DOWNLOAD_URL##*/}" | sed -n 's/.*\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\).*/\1/p' || true)"
fi
if [ -z "$REMOTE_VERSION" ]; then
  # No version in the filename: fall back to a release tag. The rolling
  # channel's tag is literally "latest" (not a version), so pick the newest
  # tag that actually looks like a version.
  _TAG_JSON="$RELEASES_JSON"
  if [ -z "$_TAG_JSON" ]; then
    _TAG_JSON="$RELEASE_JSON"
  fi
  if [ -n "$_TAG_JSON" ]; then
    REMOTE_VERSION="$(printf '%s' "$_TAG_JSON" | grep -o '"tag_name": *"v\?[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*"' | head -n 1 | sed 's/.*"v*\([^"]*\)".*/\1/' || true)"
  fi
fi

CURRENT_VERSION=""
if [ -d "$TARGET_APP" ]; then
  CURRENT_VERSION="$(defaults read "$TARGET_APP/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null || true)"
fi

FORCE_INSTALL="${FORCE:-0}"
if [ "$FORCE_INSTALL" != "1" ] && [ -n "$CURRENT_VERSION" ] && [ -n "$REMOTE_VERSION" ] && [ "$CURRENT_VERSION" = "$REMOTE_VERSION" ]; then
  echo "✅ ${APP_NAME} 当前已是最新版本 (v${CURRENT_VERSION})，无需重复下载。"
  echo "提示: 如需强制重新安装，可指定 FORCE=1，例如: curl -fsSL ... | FORCE=1 sh"
  exit 0
fi

if [ -n "$CURRENT_VERSION" ] && [ -n "$REMOTE_VERSION" ]; then
  echo "==> 检测到新版本: v${CURRENT_VERSION} -> v${REMOTE_VERSION}"
elif [ -n "$REMOTE_VERSION" ]; then
  echo "==> 准备安装版本: v${REMOTE_VERSION}"
fi

if [ -z "$DOWNLOAD_URL" ]; then
  if [ -n "${SUPERIU_RELEASE_BASE:-}" ]; then
    # Explicit custom base: it may serve unversioned asset names.
    DOWNLOAD_URL="${RELEASE_BASE}/${APP_NAME}-mac-${ARCH_KEY}.zip"
  else
    echo "错误: 无法从 GitHub API 获取 ${APP_NAME} 的下载地址（可能被限流或网络不可达）。" >&2
    echo "请稍后重试；若使用自定义镜像，可设置 SUPERIU_RELEASE_BASE 指向可用的 Release 下载地址。" >&2
    exit 1
  fi
fi

# --- 3. Download & Unpack ---------------------------------------------------

TMP_DIR="$(mktemp -d -t superiu-install-XXXXXX)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT INT TERM

ZIP_FILE="${TMP_DIR}/superiu.zip"

echo "==> 正在下载: $DOWNLOAD_URL ..."
if ! curl -fL --progress-bar "$DOWNLOAD_URL" -o "$ZIP_FILE"; then
  echo "错误: 下载失败，请检查网络或 Release 资源。" >&2
  exit 1
fi

echo "==> 正在解压..."
/usr/bin/ditto -x -k "$ZIP_FILE" "$TMP_DIR"

EXTRACTED_APP="${TMP_DIR}/${APP_NAME}.app"
if [ ! -d "$EXTRACTED_APP" ]; then
  # In case the zip had a subfolder
  FOUND_APP="$(find "$TMP_DIR" -name "${APP_NAME}.app" -maxdepth 3 | head -n 1 || true)"
  if [ -n "$FOUND_APP" ] && [ -d "$FOUND_APP" ]; then
    EXTRACTED_APP="$FOUND_APP"
  else
    echo "错误: 压缩包内未找到 ${APP_NAME}.app" >&2
    exit 1
  fi
fi

# --- 4. Install & Strip Quarantine -----------------------------------------

echo "==> 正在安装到 ${TARGET_APP} ..."
mkdir -p "$INSTALL_DIR"
# Clean conflicting legacy dev bundle in ~/Applications if installing to /Applications
if [ "$INSTALL_DIR" = "/Applications" ] && [ -d "$HOME/Applications/${APP_NAME}.app" ]; then
  echo "==> 清理旧的本地开发版冲突 (~/Applications/${APP_NAME}.app) ..."
  rm -rf "$HOME/Applications/${APP_NAME}.app"
fi
rm -rf "$TARGET_APP"
/usr/bin/ditto "$EXTRACTED_APP" "$TARGET_APP"

echo "==> 清除系统隔离标记 (Gatekeeper Quarantine)..."
/usr/bin/xattr -cr "$TARGET_APP" 2>/dev/null || true

echo "==> 注册 Spotlight 与 LaunchServices..."
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$TARGET_APP" 2>/dev/null || true

# --- 5. Done ---------------------------------------------------------------

echo ""
echo "🎉 ${APP_NAME} 安装/更新成功！"
echo "已安装至: ${TARGET_APP}"
echo ""

if [ -t 1 ]; then
  echo "正在启动 ${APP_NAME}..."
  open "$TARGET_APP" || true
fi
