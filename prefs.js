import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {SERVICES, serviceFolder, tildePath} from './services.js';

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

export default class AiUsagePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const main = this.getSettings();
        window.set_default_size(640, 780);

        // Lets the tabs use the service icons that ship with the extension.
        Gtk.IconTheme.get_for_display(Gdk.Display.get_default())
            .add_search_path(`${this.path}/icons`);

        for (const service of SERVICES)
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
            icon_name: `ai-usage-${service.id}`,
        });

        page.add(group('Sign-in', `Uses your ${service.app} sign-in. Pick a different folder only if you moved it.`, [
            this._folderRow(window, service, settings),
        ]));

        page.add(group('Top bar', null, [
            switchRow(settings, 'show-in-panel', 'Show in top bar', `Turn this off if you don't use ${service.name}`),
            ...this._limitRows(service, settings),
            comboRow(settings, 'usage-display', 'Count', 'Show how much you used or how much is left', [
                ['used', 'Used'],
                ['remaining', 'Left'],
            ]),
            switchRow(settings, 'show-tier', 'Show your plan', `For example ${service.planExamples}`),
            switchRow(settings, 'show-icon', 'Show icon', null),
            comboRow(settings, 'icon-style', 'Icon color', null, [
                ['color', 'Color'],
                ['monochrome', 'White'],
            ]),
        ]));

        page.add(group('Menu', null, [
            switchRow(settings, 'show-additional-limits', ...service.extraLimits),
        ]));

        return page;
    }

    // Rings and "follows" only make sense with two limits to choose from.
    _limitRows(service, settings) {
        if (service.limits.length === 1) {
            return [comboRow(settings, 'display-mode', 'Style', null, [
                ['ring', 'Ring + %'],
                ['text', 'Percentage'],
                ['bar', 'Bar'],
                ['both', 'Bar + %'],
            ])];
        }
        return [
            comboRow(settings, 'display-mode', 'Style',
                `Outer ring ${service.limits[0]}, inner ring ${service.limits[1]}`, [
                ['rings', 'Double ring + %'],
                ['rings-only', 'Double ring'],
                ['ring', 'Ring + %'],
                ['text', 'Percentage'],
                ['bar', 'Bar'],
                ['both', 'Bar + %'],
            ]),
            comboRow(settings, 'panel-window', 'Percentage follows', 'Which limit the number and single ring show', [
                ['primary', service.limits[0]],
                ['secondary', service.limits[1]],
                ['max', 'Closest to running out'],
            ]),
        ];
    }

    _folderRow(window, service, settings) {
        const row = new Adw.ActionRow({title: `${service.app} folder`, use_markup: false});
        const reset = new Gtk.Button({
            icon_name: 'edit-undo-symbolic',
            tooltip_text: 'Use the usual folder',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        const choose = new Gtk.Button({label: 'Choose…', valign: Gtk.Align.CENTER});
        row.add_suffix(reset);
        row.add_suffix(choose);

        const sync = () => {
            row.subtitle = tildePath(serviceFolder(service, settings));
            reset.visible = settings.get_string('folder') !== '';
        };
        sync();
        settings.connect('changed::folder', sync);

        reset.connect('clicked', () => settings.reset('folder'));
        choose.connect('clicked', () => {
            const dialog = new Gtk.FileDialog({
                title: `Choose your ${service.app} folder`,
                initial_folder: Gio.File.new_for_path(serviceFolder(service, settings)),
            });
            dialog.select_folder(window, null, (_dialog, result) => {
                try {
                    const folder = dialog.select_folder_finish(result);
                    const path = folder?.get_path();
                    // Picking the usual folder again goes back to following it.
                    settings.set_string('folder', path === service.defaultFolder() ? '' : path ?? '');
                } catch {
                    // Dismissed.
                }
            });
        });
        return row;
    }

    _generalPage(main) {
        const page = new Adw.PreferencesPage({
            name: 'general',
            title: 'General',
            icon_name: 'preferences-system-symbolic',
        });

        const refresh = new Adw.SpinRow({
            title: 'Check every',
            subtitle: 'Seconds between usage checks. Opening a menu always checks right away.',
            adjustment: new Gtk.Adjustment({lower: 30, upper: 3600, step_increment: 30, page_increment: 300}),
        });
        main.bind('refresh-interval', refresh, 'value', Gio.SettingsBindFlags.DEFAULT);
        page.add(group('Updates', null, [refresh]));

        const proxy = new Adw.EntryRow({title: 'Proxy', show_apply_button: true});
        proxy.set_text(main.get_string('proxy-url'));
        proxy.connect('apply', () => main.set_string('proxy-url', proxy.get_text().trim()));
        page.add(group('Network',
            'Leave empty unless your network needs a proxy, for example http://localhost:11809', [proxy]));
        return page;
    }
}
