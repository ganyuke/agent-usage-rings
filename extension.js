import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {SERVICES} from './services.js';
import {UsageIndicator} from './indicator.js';

// One extension, one top bar button per service.
export default class AiUsageExtension extends Extension {
    enable() {
        this._main = this.getSettings();
        this._indicators = new Map();
        this._serviceSettings = SERVICES.map(service => {
            const settings = this.getSettings(`${this._main.schema_id}.${service.id}`);
            settings.connectObject('changed::show-in-panel', () => this._sync(service, settings), this);
            this._sync(service, settings);
            return settings;
        });
    }

    disable() {
        for (const settings of this._serviceSettings)
            settings.disconnectObject(this);
        for (const indicator of this._indicators.values())
            indicator.destroy();
        this._indicators = null;
        this._serviceSettings = null;
        this._main = null;
    }

    _sync(service, settings) {
        const wanted = settings.get_boolean('show-in-panel');
        const existing = this._indicators.get(service.id);
        if (wanted && !existing) {
            const indicator = new UsageIndicator(service, {
                path: this.path,
                settings,
                mainSettings: this._main,
                openPreferences: page => this._openPreferences(page),
            });
            this._indicators.set(service.id, indicator);
            Main.panel.addToStatusArea(`${this.uuid}-${service.id}`, indicator);
        } else if (!wanted && existing) {
            existing.destroy();
            this._indicators.delete(service.id);
        }
    }

    // The settings window watches prefs-page and switches to that tab,
    // even when it's already open. Clearing it first makes a repeat click
    // on the same service still count as a change.
    _openPreferences(page) {
        this._main.set_string('prefs-page', '');
        this._main.set_string('prefs-page', page);

        // GNOME refuses a second settings window while one is open, so bring
        // ours forward instead. It has already switched tabs above.
        const open = global.get_window_actors()
            .map(actor => actor.meta_window)
            .find(w => w.get_wm_class() === 'org.gnome.Shell.Extensions' &&
                w.get_title() === this.metadata.name);
        if (open)
            Main.activateWindow(open);
        else
            this.openPreferences();
    }
}
