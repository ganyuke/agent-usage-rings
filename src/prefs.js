// SPDX-FileCopyrightText: 2026 ganyuke
// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {getServices, serviceFolder, tildePath} from './services.js';

function comboRow(settings, key, title, subtitle, options) {
    const row = new Adw.ComboRow({
        title,
        subtitle,
        model: Gtk.StringList.new(options.map(([, label]) => label)),
    });
    const sync = () => {
        const index = options.findIndex(([value]) => value === settings.get_string(key));
        row.set_selected(Math.max(0, index));
    };
    sync();
    settings.connect(`changed::${key}`, sync);
    row.connect('notify::selected', () => {
        const value = options[row.get_selected()]?.[0];
        if (value && value !== settings.get_string(key))
            settings.set_string(key, value);
    });
    return row;
}

function switchRow(settings, key, title, subtitle) {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function group(title, description, rows) {
    const g = new Adw.PreferencesGroup({title, description});
    rows.forEach(row => g.add(row));
    return g;
}

export default class AgentUsageRingsPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const main = this.getSettings();
        window.set_default_size(640, 780);

        // Lets the tabs use the service icons that ship with the extension.
        Gtk.IconTheme.get_for_display(Gdk.Display.get_default())
            .add_search_path(`${this.path}/icons`);

        for (const service of getServices(_))
            window.add(this._servicePage(window, service, this.getSettings(`${main.schema_id}.${service.id}`)));
        window.add(this._generalPage(main));

        // A menu's Settings button sets prefs-page to its service.
        const showRequestedPage = () => {
            const page = main.get_string('prefs-page');
            if (page)
                window.set_visible_page_name(page);
        };
        showRequestedPage();
        const id = main.connect('changed::prefs-page', showRequestedPage);
        window.connect('close-request', () => {
            main.disconnect(id);
            return false;
        });
    }

    _servicePage(window, service, settings) {
        const page = new Adw.PreferencesPage({
            name: service.id,
            title: service.name,
            icon_name: `${service.id}`,
        });

        page.add(group(_('Sign-in'), _('Select the folder containing your %s credentials. These will be used to fetch your usage data from the %s API.').format(service.app, service.name), [
            this._folderRow(window, service, settings),
        ]));

        page.add(group(_('Top bar'), null, [
            switchRow(settings, 'show-in-panel', _('Show in top bar'), _("Turn this off if you don't use %s").format(service.name)),
            ...this._limitRows(service, settings),
            comboRow(settings, 'usage-display', _('Count'), _('Show how much you used or how much is left'), [
                ['used', _('Used')],
                ['remaining', _('Left')],
            ]),
            switchRow(settings, 'show-tier', _('Show your plan'), _('For example %s').format(service.planExamples)),
            switchRow(settings, 'show-icon', _('Show icon'), null),
            comboRow(settings, 'icon-style', _('Icon color'), null, [
                ['color', _('Color')],
                ['monochrome', _('White')],
            ]),
        ]));

        page.add(group(_('Menu'), null, [
            switchRow(settings, 'show-additional-limits', ...service.extraLimits),
        ]));

        return page;
    }

    // Rings and "follows" only make sense with two limits to choose from.
    _limitRows(service, settings) {
        if (service.limits.length === 1) {
            return [comboRow(settings, 'display-mode', _('Style'), null, [
                ['ring', _('Ring + %')],
                ['text', _('Percentage')],
                ['bar', _('Bar')],
                ['both', _('Bar + %')],
            ])];
        }
        return [
            comboRow(settings, 'display-mode', _('Style'),
                _('Outer ring %s, inner ring %s').format(service.limits[0], service.limits[1]), [
                    ['rings', _('Double ring + %')],
                    ['rings-only', _('Double ring')],
                    ['ring', _('Ring + %')],
                    ['text', _('Percentage')],
                    ['bar', _('Bar')],
                    ['both', _('Bar + %')],
                ]),
            comboRow(settings, 'panel-window', _('Percentage follows'), _('Which limit the number and single ring show'), [
                ['primary', service.limits[0]],
                ['secondary', service.limits[1]],
                ['max', _('Closest to running out')],
            ]),
        ];
    }

    _folderRow(window, service, settings) {
        const row = new Adw.ActionRow({title: _('%s folder').format(service.app), use_markup: false});
        const reset = new Gtk.Button({
            icon_name: 'edit-undo-symbolic',
            tooltip_text: _('Use the usual folder'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        const choose = new Gtk.Button({label: _('Choose…'), valign: Gtk.Align.CENTER});
        row.add_suffix(reset);
        row.add_suffix(choose);

        const sync = () => {
            row.subtitle = tildePath(serviceFolder(service, settings));
            reset.visible = settings.get_string('folder') !== '';
        };
        sync();
        settings.connect('changed::folder', sync);

        reset.connect('clicked', () => settings.reset('folder'));
        const pick = initialFolder => {
            const dialog = new Gtk.FileDialog({
                title: _('Choose your %s folder').format(service.app),
                initial_folder: initialFolder,
            });

            dialog.select_folder(window, null, (source, result) => {
                try {
                    const folder = source.select_folder_finish(result);
                    const path = folder.get_path();

                    // Picking the default folder again resets/clears the setting
                    settings.set_string('folder', path === service.defaultFolder() ? '' : path ?? '');
                } catch (e) {
                    if (!e.matches(Gtk.DialogError, Gtk.DialogError.DISMISSED))
                        console.error('Failed to select folder:', e);
                }
            });
        };

        choose.connect('clicked', () => {
            // prevent Nautilus from complaining about the initial folder not existing
            const current = Gio.File.new_for_path(serviceFolder(service, settings));
            current.query_info_async('standard::type', Gio.FileQueryInfoFlags.NONE,
                GLib.PRIORITY_DEFAULT, null, (file, result) => {
                    try {
                        file.query_info_finish(result);
                        pick(current);
                    } catch {
                        pick(null);
                    }
                });
        });
        return row;
    }

    _generalPage(main) {
        const page = new Adw.PreferencesPage({
            name: 'general',
            title: _('General'),
            icon_name: 'preferences-system-symbolic',
        });

        const refresh = new Adw.SpinRow({
            title: _('Check every'),
            subtitle: _('Seconds between usage checks. Opening a menu always checks immediately.'),
            adjustment: new Gtk.Adjustment({lower: 30, upper: 3600, step_increment: 30, page_increment: 300}),
        });
        main.bind('refresh-interval', refresh, 'value', Gio.SettingsBindFlags.DEFAULT);
        page.add(group(_('Updates'), null, [refresh]));

        const proxy = new Adw.EntryRow({title: _('Proxy'), show_apply_button: true});
        proxy.set_text(main.get_string('proxy-url'));
        proxy.connect('apply', () => main.set_string('proxy-url', proxy.get_text().trim()));
        page.add(group(_('Network'),
            _('Leave empty unless your network needs a proxy, for example %s').replace('%s', 'http://localhost:11809'),
            [proxy]));
        return page;
    }
}
