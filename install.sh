#!/bin/sh

set -e

REPO="cheikh2shift/chrome-mcp"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/bin}"
BINARY_NAME="chrome-mcp"

if [ -n "$1" ]; then
    VERSION="$1"
else
    VERSION="latest"
fi

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "$ARCH" in
    x86_64)
        ARCH="amd64"
        ;;
    aarch64|arm64)
        ARCH="arm64"
        ;;
    *)
        echo "Unsupported architecture: $ARCH"
        exit 1
        ;;
esac

case "$OS" in
    darwin)
        OS="darwin"
        ;;
    linux)
        OS="linux"
        ;;
    mingw*|msys*|cygwin*)
        OS="windows"
        ;;
    *)
        echo "Unsupported OS: $OS"
        exit 1
        ;;
esac

FILENAME="${BINARY_NAME}-${OS}-${ARCH}.tar.gz"
EXTENSION_FILE="chrome-mcp-extension.zip"

if [ "$VERSION" = "latest" ]; then
    TAG_DATA=$(curl -sL "https://api.github.com/repos/${REPO}/releases/latest")
    VERSION=$(echo "$TAG_DATA" | grep '"tag_name"' | sed 's/.*"v\?\([^"]*\)".*/\1/')
    if [ -z "$VERSION" ]; then
        echo "Failed to get latest release version"
        exit 1
    fi
fi

VERSION_TAG="$VERSION"
if ! echo "$VERSION" | grep -q "^v"; then
    VERSION_TAG="v${VERSION}"
fi

URL="https://github.com/${REPO}/releases/download/${VERSION_TAG}/${FILENAME}"
EXTENSION_URL="https://github.com/${REPO}/releases/download/${VERSION_TAG}/${EXTENSION_FILE}"

echo "Downloading chrome-mcp v${VERSION} for ${OS}/${ARCH}..."

curl -sSL -o "${FILENAME}" "$URL"

if command -v sha256sum >/dev/null 2>&1; then
    CHECKSUM_URL="https://github.com/${REPO}/releases/download/${VERSION_TAG}/${FILENAME}.sha256"
    echo "Verifying checksum..."
    curl -sSL "$CHECKSUM_URL" | sha256sum -c --status - || echo "Checksum verification skipped (not available)"
fi

tar -xzf "${FILENAME}"
EXTRACTED_BINARY="${BINARY_NAME}-${OS}-${ARCH}"
rm -f "${FILENAME}"
chmod +x "${EXTRACTED_BINARY}"
mv "${EXTRACTED_BINARY}" "${BINARY_NAME}"

mkdir -p "$INSTALL_DIR"

if [ -w "$INSTALL_DIR" ]; then
    mv "${BINARY_NAME}" "${INSTALL_DIR}/${BINARY_NAME}"
    echo "Installed to ${INSTALL_DIR}/${BINARY_NAME}"
    echo ""
    echo "Version: $("${INSTALL_DIR}/${BINARY_NAME}" --version 2>/dev/null || echo "Run ${BINARY_NAME} --version to check")"
else
    echo "Cannot write to ${INSTALL_DIR}, installed to current directory"
    echo "Move it manually: mv ${BINARY_NAME} ${INSTALL_DIR}/"
fi

echo ""
echo "Downloading Chrome extension..."
EXTENSION_DIR="${HOME}/chrome-mcp-extension"
mkdir -p "$EXTENSION_DIR"

if curl -sSL -o "${EXTENSION_DIR}/${EXTENSION_FILE}" "$EXTENSION_URL"; then
    echo "Extension downloaded to ${EXTENSION_DIR}/${EXTENSION_FILE}"
    
    EXTRACTED_DIR="${EXTENSION_DIR}/extension-${VERSION}"
    mkdir -p "$EXTRACTED_DIR"
    if unzip -q -o "${EXTENSION_DIR}/${EXTENSION_FILE}" -d "$EXTRACTED_DIR" 2>/dev/null; then
        echo "Extension extracted to ${EXTRACTED_DIR}"
    fi
    
    echo ""
    echo "To install the extension:"
    echo "1. Open Chrome and go to chrome://extensions/"
    echo "2. Enable 'Developer mode' (top right)"
    echo "3. Click 'Load unpacked' and select: ${EXTRACTED_DIR}"
else
    echo "Failed to download extension"
fi

echo ""
echo "Setup complete!"
