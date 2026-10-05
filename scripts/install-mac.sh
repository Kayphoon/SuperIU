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

RELEASE_JSON="$(curl -fsSL "https://api.github.com/repos/${REPO_SLUG}/releases/latest" 2>/dev/null || true)"

DOWNLOAD_URL=""
if [ -n "$RELEASE_JSON" ]; then
  # Prefer zip matching mac and the target arch
  DOWNLOAD_URL="$(printf '%s' "$RELEASE_JSON" | grep -o 'https://[^" ]*mac[^" ]*'"$ARCH_KEY"'[^" ]*\.zip' | head -n 1 || true)"
  if [ -z "$DOWNLOAD_URL" ]; then
    DOWNLOAD_URL="$(printf '%s' "$RELEASE_JSON" | grep -o 'https://[^" ]*mac[^" ]*\.zip' | head -n 1 || true)"
  fi
  if [ -z "$DOWNLOAD_URL" ]; then
    DOWNLOAD_URL="$(printf '%s' "$RELEASE_JSON" | grep -o 'https://[^" ]*\.zip' | head -n 1 || true)"
  fi
fi

# Fallback if GitHub API is rate-limited or fails
if [ -z "$DOWNLOAD_URL" ]; then
  RELEASE_BASE="${SUPERIU_RELEASE_BASE:-https://github.com/${REPO_SLUG}/releases/latest/download}"
  DOWNLOAD_URL="${RELEASE_BASE}/${APP_NAME}-mac-${ARCH_KEY}.zip"
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
