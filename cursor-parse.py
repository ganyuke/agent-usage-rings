# SPDX-FileCopyrightText: 2026 ganyuke
# SPDX-License-Identifier: GPL-2.0-or-later

# parse the cursor ide's sign-in from its SQLite database with Python
# since GJS doesn't have SQLite support
import pathlib, sqlite3, sys
db = sqlite3.connect(pathlib.Path(sys.argv[1]).as_uri() + '?mode=ro', uri=True)
row = db.execute("SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken'").fetchone()
value = row[0] if row else ''
print(value.decode() if isinstance(value, bytes) else value)
