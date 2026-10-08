#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 ganyuke
# SPDX-License-Identifier: GPL-2.0-or-later

set -euo pipefail

logout=true
for arg in "$@"; do
	case "$arg" in
		--no-logout) logout=false ;;
		*) echo "Usage: $0 [--no-logout]"; exit 1 ;;
	esac
done

cd "$(dirname "$0")/.." # navigate to the repository root
repo_dir="$(pwd)"
target_dir="$HOME/.local/share/gnome-shell/extensions/ai-usage-meters@planet.nextcolor.org"

if [ "$repo_dir" = "$target_dir" ]; then
	echo "Run this from your copy of the repository, not from the installed extension folder"
	exit 1
fi

rm -rf "$target_dir"
mkdir -p "$(dirname "$target_dir")"
cp -rT "$repo_dir" "$target_dir"
rm -rf "$target_dir/.git"
glib-compile-schemas "$target_dir/schemas"

if [ "$logout" = false ]; then
	echo "Installed. Test it now with: dbus-run-session gnome-shell --devkit"
	echo "Your desktop keeps the old version until you log out and back in."
	exit 0
fi

echo "Installed. Logging out so GNOME picks up the new version."
gnome-session-quit --no-prompt
