#!/bin/sh
# SPDX-FileCopyrightText: 2026 ganyuke
# SPDX-License-Identifier: GPL-2.0-or-later

set -eu

cd "$(dirname "$0")/.."

PACKAGE=$(jq -r '.name' src/metadata.json)
VERSION=$(jq -r '."version-name" // .version' src/metadata.json)
BUG_ADDRESS="https://github.com/ganyuke/agent-usage-rings/issues"
YEAR=$(date +%Y)

xgettext --language=JavaScript --from-code=UTF-8 --keyword=_ \
    --files-from=po/POTFILES.in \
    --package-name="$PACKAGE" \
    --package-version="$VERSION" \
    --msgid-bugs-address="$BUG_ADDRESS" \
    --output=po/agent-usage-rings.pot

awk -v pkg="$PACKAGE" -v year="$YEAR" '
/^# SOME DESCRIPTIVE TITLE/ {
    print "# Translation template for " pkg "."
    next
}
/^# Copyright \(C\)/ {
    print "# Copyright (c) 2026 Baptiste-Pasquier (claude-usage-extension)"
    print "# Copyright (c) 2026 Kevin Pita (codex-usage-extension)"
    print "# Copyright (c) 2026 byte4day (AI-Usage-Extension)"
    print "# Copyright (c) " year " ganyuke (" pkg ")"
    next
}
/^# FIRST AUTHOR/ {
    next
}
{ print }
' po/agent-usage-rings.pot > po/agent-usage-rings.pot.tmp && mv po/agent-usage-rings.pot.tmp po/agent-usage-rings.pot
