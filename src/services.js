// SPDX-FileCopyrightText: 2026 ganyuke
// SPDX-License-Identifier: GPL-2.0-or-later

import GLib from 'gi://GLib';

export const EXTENSION_NAME = 'Agent Usage Rings';

export function getServices(_) {
    return [
        {
            id: 'claude',
            name: 'Claude',
            app: 'Claude Code',
            planExamples: 'MAX X20 or PRO',
            limits: [_('5-hour limit'), _('Weekly limit')],
            extraLimits: [_('Show per-model limits'), _('Some plans have separate limits for specific models')],
            usageUrl: 'https://claude.ai/settings/usage',
            defaultFolder: () => GLib.getenv('CLAUDE_CONFIG_DIR') ||
            GLib.build_filenamev([GLib.get_home_dir(), '.claude']),
        },
        {
            id: 'codex',
            name: 'Codex',
            app: 'Codex',
            planExamples: 'PRO X20 or PLUS',
            limits: [_('5-hour limit'), _('Weekly limit')],
            extraLimits: [_('Show per-model limits'), _('Some plans have separate limits for specific models')],
            usageUrl: 'https://chatgpt.com/codex/settings/usage',
            defaultFolder: () => GLib.getenv('CODEX_HOME') ||
            GLib.build_filenamev([GLib.get_home_dir(), '.codex']),
        },
        {
            id: 'cursor',
            name: 'Cursor',
            app: 'Cursor',
            planExamples: 'PRO or ULTRA',
            limits: [_('Cursor Models'), _('Other Models')],
            extraLimits: [_('Show on-demand spending'), _('The spending limit you set after included usage runs out')],
            usageUrl: 'https://cursor.com/dashboard?tab=usage',
            defaultFolder: () => GLib.build_filenamev([GLib.get_user_config_dir(), 'Cursor']),
        },
    ];
}

export function serviceFolder(service, settings) {
    const custom = settings.get_string('folder').trim();
    return custom || service.defaultFolder();
}

export function tildePath(path) {
    const home = GLib.get_home_dir();
    return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}
