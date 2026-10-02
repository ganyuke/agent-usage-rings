# AI Usage Meters

![GNOME Shell 46–50](https://img.shields.io/badge/GNOME%20Shell-46--50-blue)

See how much of your Claude, Codex and Cursor limits you've used, right from the GNOME top bar.

Brings together [Claude Code Usage](https://github.com/Haletran/claude-usage-extension) by Haletran and [Codex Usage](https://github.com/kevinpita/codex-usage-extension) by Kevin Pita in one extension.

<img width="1920" height="1080" alt="GNOME Desktop with AI Usage Meters" src="https://github.com/user-attachments/assets/7001d413-8623-40c6-9586-b94827c6fac2" />

## What you get

- A button in the top bar for each of Claude, Codex and Cursor, each with its own limits. Hide the ones you don't use in Settings.
- A double ring on each button. For Claude and Codex the outer ring is your 5-hour limit and the inner ring is your weekly limit. For Cursor the outer ring is Cursor Models and the inner ring is Other Models.
- Colors that warn you early. A ring turns orange or red when your current pace will run you out before the limit resets, not just when you're already close.
- A menu with each limit, when it resets, how fast you're using it, and per-model limits when your plan has them. Cursor also shows on-demand spending when you've set a limit.
- One settings window with a tab for each service and a General tab. The settings button in each menu opens the right tab.

## Signing in

AI Usage uses the sign-in you already have in Claude Code, Codex and Cursor. There's nothing extra to sign in to.

- If a menu says to sign in, open Claude Code, Codex or Cursor and sign in there. The menu picks it up at the next check.
- If you moved where Claude Code, Codex or Cursor keeps its files, choose that folder in the service's Settings tab.
- Your sign-in expires after a while if you don't use the app. Opening it again refreshes it.
- Codex needs a ChatGPT account sign-in. An API key sign-in has no plan limits to show.
- Cursor works with the Cursor editor or the `cursor-agent` command line tool, whichever you're signed in to.

AI Usage doesn't keep a copy of your sign-in. It reads it each time it checks your usage.

## Requirements

- GNOME Shell 46 to 50, including Fedora 44
- Claude Code, Codex or Cursor, signed in
- Python 3 for Cursor's editor sign-in. Most desktops already have it.

## Installation

From the repository folder:

```bash
./update
```

This installs AI Usage and logs you out, so save your work first. After logging back in, turn it on:

```bash
gnome-extensions enable ai-usage@ganyuke.github.io
```

If you used the separate Claude Code Usage or Codex Usage extensions before, turn those off so you don't get two buttons for the same service.

## Network activity

AI Usage only talks to the services you use, and only to ask for your usage:

- Claude: `api.anthropic.com`
- Codex: `chatgpt.com`
- Cursor: `cursor.com`

It checks every few minutes, when you open a menu, and never for services you've hidden. Your sign-in goes only to the service it belongs to. Nothing is sent anywhere else, and there's no tracking. If you use a proxy, set it in the General tab.

## Disclaimer

This extension is not affiliated with, funded by, or associated with Anthropic, OpenAI or Anysphere (Cursor).
