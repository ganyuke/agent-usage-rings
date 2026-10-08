#!/bin/sh
# SPDX-FileCopyrightText: 2026 ganyuke
# SPDX-License-Identifier: GPL-2.0-or-later

set -eu

cd "$(dirname "$0")/.."

PACKAGE=$(jq -r '.name' metadata.json)
VERSION=$(jq -r '."version-name" // .version' metadata.json)
BUG_ADDRESS="https://github.com/ganyuke/ai-usage-meters/issues"
YEAR=$(date +%Y)

xgettext --language=JavaScript --from-code=UTF-8 --keyword=_ \
    --files-from=po/POTFILES.in \
    --package-name="$PACKAGE" \
    --package-version="$VERSION" \
    --msgid-bugs-address="$BUG_ADDRESS" \
    --output=po/ai-usage-meters.pot

awk -v pkg="$PACKAGE" -v year="$YEAR" '
/^# SOME DESCRIPTIVE TITLE/ {
    print "# Translation template for " pkg "."
    next
}
/^# Copyright \(C\)/ {
    print "# Copyright (c) 2026 Baptiste-Pasquier (claude-usage-extension)"
    print "# Copyright (c) 2026 Kevin Pita (codex-usage-extension)"
    print "# Copyright (c) " year " ganyuke (" pkg ")"
    next
}
/^# FIRST AUTHOR/ {
    next
}
{ print }
' po/ai-usage-meters.pot > po/ai-usage-meters.pot.tmp && mv po/ai-usage-meters.pot.tmp po/ai-usage-meters.pot
