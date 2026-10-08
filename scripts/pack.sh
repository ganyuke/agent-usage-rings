#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 ganyuke
# SPDX-License-Identifier: GPL-2.0-or-later

set -euo pipefail

cd "$(dirname "$0")/.." # navigate to the repository root
uuid="$(sed -n 's/.*"uuid": *"\([^"]*\)".*/\1/p' src/metadata.json)"
zip_file="$(pwd)/dist/$uuid.shell-extension.zip"

mkdir -p dist
rm -f "$zip_file"
(cd src && zip -qr "$zip_file" . -x schemas/gschemas.compiled)
zip -qj "$zip_file" LICENSE LICENSE.upstream

echo "Created dist/$uuid.shell-extension.zip"
echo "Upload it at https://extensions.gnome.org/upload/ or install it with:"
echo "  gnome-extensions install --force dist/$uuid.shell-extension.zip"
