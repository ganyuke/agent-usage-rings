# AI Usage Meters

![GNOME Shell 46–50](https://img.shields.io/badge/GNOME%20Shell-46--50-blue)

Put pretty double-circles in your GNOME top bar so you can watch your weekly usage for Claude, Codex, and Cursor disappear in seconds from the comforts of your GNOME desktop.

Combines [Claude Code Usage](https://github.com/Haletran/claude-usage-extension) by Haletran and its Codex-flavoured fork [Codex Usage](https://github.com/kevinpita/codex-usage-extension) by Kevin Pita back into one extension. Plus Cursor, thanks to the similar-family [AI Usage](https://github.com/byte4day/AI-Usage-Extension) by byte4day. Design and burn estimates originate from Codex Usage, which was inspired by [ClaudeCodeUsage](https://github.com/dvdstelt/ClaudeCodeUsage) by Dennis van der Stelt.

**Disclaimer: This extension is not affiliated with, funded by, or associated with Anthropic, OpenAI or Anysphere (Cursor).**

<img width="1920" height="1080" alt="GNOME Desktop with AI Usage Meters" src="https://github.com/user-attachments/assets/7001d413-8623-40c6-9586-b94827c6fac2" />

## Features

- See both weekly and 5-hour usage at a glance with a compact, colored double circle in the top bar.
- Estimate your usage in detail, with green, orange, and red colors and percentages so you'll know when you're burning through usage too quickly.
- Pop open the service's menu to see each limit, when it resets, how fast you're using it, and per-model limits (if applicable).

The colored double circle is the standard display (but it can be configured if you want!). The outer circle is the 5-hour usage and inner circle the weekly usage. The percentage is the 5-hour usage. This can be changed to always show the weekly usage or choose which percentage is closer to running out.

Cursor is a little different from Claude Code and Codex since it has a monthly plan. Cursor's circles are split into first-party models (outer ring) and API models (inner ring). On-demand spending also appears as a bar if you have on-demand enabled.

## Usage

AI Usage Meters uses your Claude Code, Codex, and Cursor IDE (or the `cursor-agent` CLI, if the IDE is not available) credentials to poll your usage data. You must be signed into these tools beforehand for this extension to work. Once you are signed in, use the refresh button in the service's panel to populate your usage data.

- If you moved where Claude Code, Codex or Cursor keeps its files, choose that folder in the service's Settings tab.
- Your sign-in may expire if you are not currently using the app (which tends to be a problem with Claude Code!). Opening it again usually fixes this.
- Codex requires a ChatGPT account to poll usage data (API keys do not provide usage data).

AI Usage Meters do not cache or store your credentials. Each check looks up your credentials on the spot.

If you need to proxy your connection, you can set your proxy in the General tab of the Settings window.

## Requirements

- GNOME Shell 46 to 50, including Fedora 44
- Logged-in Claude Code, Codex, or Cursor
- `python3` to parse the Cursor IDE credentials

## Installation

### From a release

Download `ai-usage-meters@planet.nextcolor.org.shell-extension.zip` from the [latest release](https://github.com/ganyuke/ai-usage-meters/releases/latest), then install it:

```bash
gnome-extensions install --force ai-usage-meters@planet.nextcolor.org.shell-extension.zip
```

Log out and back in, then enable the extension:

```bash
gnome-extensions enable ai-usage-meters@planet.nextcolor.org
```

### Manual installation

> [!WARNING]
> Make sure you save your work before you run the command below.

From the repository folder:

```bash
./scripts/install.sh
```

This installs AI Usage Meters and logs you out, so save your work first. After logging back in, enable the extension:

```bash
gnome-extensions enable ai-usage-meters@planet.nextcolor.org
```

## Network activity

AI Usage Meters makes outbound connections to the following hosts:

- Claude: `api.anthropic.com`
- Codex: `chatgpt.com`
- Cursor: `cursor.com`

These connections are made as part of usage data checks, occuring every few minutes. These are also sent on demand, such as opening the service's menu. Usage checks are never sent for hidden services. Credentials are sent to their associated service and that exact service only as part of this extension's normal operation.

No other connections are intended to made. No outbound tracking is included in this extension.
