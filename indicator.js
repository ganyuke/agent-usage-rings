import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import Cairo from 'cairo';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';

import {FIVE_HOURS, SEVEN_DAYS, LOADERS, UsageError, isCancelled} from './usage.js';
import {serviceFolder, tildePath} from './services.js';

const RING_SIZE = 18;
const RING_WIDTH = 3;
const DOUBLE_RING_SIZE = 20;
const DOUBLE_RING_WIDTH = 2.5;
const DOUBLE_RING_GAP = 1.5;
const SHELL_MAJOR = parseInt(Config.PACKAGE_VERSION.split('.')[0], 10);
const SIGN_IN_PROBLEMS = ['signed-out', 'expired', 'api-key'];
// Opening the menu refreshes only if the last try is older than this.
const MENU_REFRESH_GAP = 60;

// St.BoxLayout:vertical is deprecated since GNOME 48 in favour of :orientation,
// which does not exist on 46/47.
function verticalBox(params = {}) {
    return SHELL_MAJOR >= 48
        ? {...params, orientation: Clutter.Orientation.VERTICAL}
        : {...params, vertical: true};
}

function monotonicSeconds() {
    return GLib.get_monotonic_time() / 1e6;
}

function nowSeconds() {
    return Date.now() / 1000;
}

// "14:40" for today, "Sep 29 14:40" for older times.
function clockTime(dt) {
    const today = GLib.DateTime.new_now_local();
    const sameDay = dt.get_year() === today.get_year() && dt.get_day_of_year() === today.get_day_of_year();
    return dt.format(sameDay ? '%H:%M' : '%b %-d %H:%M');
}

function severity(util) {
    if (util >= 90)
        return 'usage-critical';
    if (util >= 75)
        return 'usage-high';
    return 'usage-low';
}

function severityRgb(util) {
    if (util >= 90)
        return [0.88, 0.11, 0.14];
    if (util >= 75)
        return [1.0, 0.47, 0.0];
    return [0.2, 0.82, 0.48];
}

// Theme node colors are 0-255 on GNOME 47+ (Cogl.Color) and 0-1 before.
function colorRgb(c) {
    const scale = Math.max(c.red, c.green, c.blue) > 1 ? 255 : 1;
    return [c.red / scale, c.green / scale, c.blue / scale];
}

function humanDuration(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    if (s < 60)
        return `${s}s`;
    const mins = Math.round(s / 60);
    if (mins < 60)
        return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24)
        return `${hrs}h ${mins % 60}m`;
    const days = Math.floor(hrs / 24);
    return `${days}d ${hrs % 24}h`;
}

function secondsUntil(iso) {
    const target = Date.parse(iso ?? '');
    return Number.isNaN(target) ? null : (target - Date.now()) / 1000;
}

function resetCaption(iso) {
    const left = secondsUntil(iso);
    if (left === null)
        return '';
    return left <= 0 ? 'Resetting now' : `Resets in ${humanDuration(left)}`;
}

function expiresCaption(iso) {
    const left = secondsUntil(iso);
    if (left === null)
        return '';
    return left <= 0 ? 'Expired' : `Expires in ${humanDuration(left)}`;
}

// Usage extrapolated to the end of the window at the current pace.
// Ignored for the first 5% of a window, where the pace is too noisy.
function projectedUtil(util, resetsAt, totalSeconds) {
    const remaining = secondsUntil(resetsAt);
    if (remaining === null || remaining <= 0 || !totalSeconds)
        return util;
    const elapsed = totalSeconds - remaining;
    if (elapsed <= 0 || elapsed / totalSeconds < 0.05)
        return util;
    return Math.max(util, (util * totalSeconds) / elapsed);
}

// A limit can give its length (Cursor's billing month). Claude and Codex
// don't, so their two limits fall back to 5 hours and a week.
function windowTotal(win, fallback) {
    return win?.total ?? fallback;
}

function exhaustSeconds(util, resetsAt, totalSeconds) {
    const remaining = secondsUntil(resetsAt);
    if (remaining === null || remaining <= 0 || !totalSeconds || util <= 0)
        return null;
    const elapsed = totalSeconds - remaining;
    if (elapsed <= 0 || elapsed / totalSeconds < 0.05)
        return null;
    const toExhaust = (elapsed * (100 - util)) / util;
    return toExhaust > 0 && toExhaust < remaining ? toExhaust : null;
}

class Meter {
    constructor(name) {
        this.root = new St.BoxLayout(verticalBox({style_class: 'aiu-meter'}));

        const row = new St.BoxLayout({style_class: 'aiu-meter-row'});
        this._name = new St.Label({text: name, style_class: 'aiu-meter-name', x_expand: true});
        this._pct = new St.Label({text: '…', style_class: 'aiu-meter-pct'});
        row.add_child(this._name);
        row.add_child(this._pct);

        this._bar = new LevelBar({style_class: 'aiu-level'});

        this._caption = new St.Label({text: '', style_class: 'aiu-caption'});
        this._note = new St.Label({text: '', style_class: 'aiu-note'});
        this._note.clutter_text.line_wrap = true;
        this._note.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        this._note.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;

        this.root.add_child(row);
        this.root.add_child(this._bar);
        this.root.add_child(this._caption);
        this.root.add_child(this._note);
    }

    setValue({util, colorUtil, pctText, caption, note}) {
        this._pct.text = pctText;
        this._bar.setValue({util, colorUtil});
        this._caption.text = caption ?? '';
        this._caption.visible = !!caption;
        this._note.text = note?.text ?? '';
        this._note.visible = !!note?.text;
        this._note.style_class = note?.warn ? 'aiu-note aiu-note-warn' : 'aiu-note';
    }

    setMuted() {
        this._pct.text = '–';
        this._bar.setValue(null);
        this._caption.visible = false;
        this._note.visible = false;
    }
}

const Ring = GObject.registerClass(
class Ring extends St.DrawingArea {
    _init() {
        super._init({
            style_class: 'aiu-ring',
            width: RING_SIZE,
            height: RING_SIZE,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._value = null;
    }

    // value is {util, colorUtil} or null when unknown.
    setValue(value) {
        this._value = value;
        this.queue_repaint();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        const radius = Math.min(w, h) / 2 - RING_WIDTH / 2;
        drawRing(cr, this, w / 2, h / 2, radius, RING_WIDTH, this._value);
        cr.$dispose();
    }
});

// Two concentric rings: outer is the first limit, inner the second.
const DoubleRing = GObject.registerClass(
class DoubleRing extends St.DrawingArea {
    _init() {
        super._init({
            style_class: 'aiu-rings',
            width: DOUBLE_RING_SIZE,
            height: DOUBLE_RING_SIZE,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._values = [null, null];
    }

    setValues(outer, inner) {
        this._values = [outer, inner];
        this.queue_repaint();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        const outer = Math.min(w, h) / 2 - DOUBLE_RING_WIDTH / 2;
        const radii = [outer, outer - DOUBLE_RING_WIDTH - DOUBLE_RING_GAP];
        this._values.forEach((value, i) =>
            drawRing(cr, this, w / 2, h / 2, radii[i], DOUBLE_RING_WIDTH, value));
        cr.$dispose();
    }
});

function drawRing(cr, actor, cx, cy, radius, width, value) {
    const start = -Math.PI / 2;
    const [fr, fg, fb] = colorRgb(actor.get_theme_node().get_foreground_color());
    cr.setLineWidth(width);
    cr.setLineCap(Cairo.LineCap.ROUND);

    cr.setSourceRGBA(fr, fg, fb, 0.22);
    cr.arc(cx, cy, radius, 0, 2 * Math.PI);
    cr.stroke();

    const util = value ? Math.max(0, Math.min(100, value.util)) : 0;
    if (util > 0) {
        const [r, g, b] = severityRgb(value.colorUtil ?? util);
        cr.setSourceRGBA(r, g, b, 1);
        cr.arc(cx, cy, radius, start, start + (util / 100) * 2 * Math.PI);
        cr.stroke();
    }
}

// A rounded bar filled to its allocated width, so 100% always reaches the end
// whatever the menu width or display scale.
const LevelBar = GObject.registerClass(
class LevelBar extends St.DrawingArea {
    _init(params) {
        super._init(params);
        this._value = null;
    }

    // value is {util, colorUtil} or null when unknown.
    setValue(value) {
        this._value = value;
        this.queue_repaint();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        const [fr, fg, fb] = colorRgb(this.get_theme_node().get_foreground_color());
        barPath(cr, w, h);
        cr.setSourceRGBA(fr, fg, fb, 0.22);
        cr.fill();

        const util = this._value ? Math.max(0, Math.min(100, this._value.util)) : 0;
        if (util > 0) {
            const [r, g, b] = severityRgb(this._value.colorUtil ?? util);
            // Never narrower than its rounded ends.
            barPath(cr, Math.max(h, (util / 100) * w), h);
            cr.setSourceRGBA(r, g, b, 1);
            cr.fill();
        }
        cr.$dispose();
    }
});

function barPath(cr, w, h) {
    const r = h / 2;
    cr.newPath();
    cr.arc(r, r, r, Math.PI / 2, 3 * Math.PI / 2);
    cr.arc(w - r, r, r, -Math.PI / 2, Math.PI / 2);
    cr.closePath();
}

export const UsageIndicator = GObject.registerClass(
class UsageIndicator extends PanelMenu.Button {
    _init(service, {path, settings, mainSettings, openPreferences}) {
        super._init(0.0, `${service.name} Usage`);

        this._service = service;
        this._oneLimit = service.limits.length === 1;
        this._load = LOADERS[service.id];
        this._settings = settings;
        this._main = mainSettings;
        this._openPreferences = openPreferences;
        this._iconFile = Gio.icon_new_for_string(GLib.build_filenamev([path, 'icons', `ai-usage-${service.id}.png`]));
        this._linkIcon = Gio.icon_new_for_string(GLib.build_filenamev([path, 'icons', 'external-link-symbolic.svg']));
        this._cancellable = new Gio.Cancellable();
        this._session = this._createSession();
        this._usage = null;
        this._updatedAt = null;
        this._triedAt = null;
        this._problem = null;
        this._lastTry = -Infinity;
        this._timerId = 0;
        this._countdownId = 0;

        this._buildPanel();
        this._buildMenu();

        this._settings.connectObject('changed', (_s, key) => {
            if (key === 'paused-until' || key === 'last-usage')
                return;
            if (key === 'show-icon' || key === 'icon-style')
                this._updateIcon();
            else if (key === 'folder')
                this.refresh();
            else
                this._renderAll();
        }, this);
        this._main.connectObject('changed', (_s, key) => {
            if (key === 'refresh-interval') {
                this._startTimer();
            } else if (key === 'proxy-url') {
                // A different route may not be rate limited.
                this._settings.set_int64('paused-until', 0);
                this._session.abort();
                this._session = this._createSession();
                this.refresh();
            }
        }, this);
        this.menu.connectObject('open-state-changed', (_menu, open) => {
            // After a sign-in problem, always check: the person may have just fixed it.
            if (open && (SIGN_IN_PROBLEMS.includes(this._problem) ||
                         monotonicSeconds() - this._lastTry >= MENU_REFRESH_GAP))
                this.refresh();
        }, this);

        this._updateIcon();
        this._restoreUsage();
        if (this._pausedUntil() > nowSeconds())
            this.showProblem('rate-limited');
        else
            this._renderAll();
        this.refresh();
        this._startTimer();
    }

    // ---- building -------------------------------------------------------

    _buildPanel() {
        const box = new St.BoxLayout({style_class: 'aiu-panel'});
        this._icon = new St.Icon({
            gicon: this._iconFile,
            style_class: 'aiu-panel-icon',
            icon_size: 16,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._ring = new Ring();
        this._rings = new DoubleRing();
        this._panelBar = new LevelBar({style_class: 'aiu-panel-bar', y_align: Clutter.ActorAlign.CENTER});
        this._panelPct = new St.Label({text: '…', style_class: 'aiu-panel-pct', y_align: Clutter.ActorAlign.CENTER});
        this._panelTier = new St.Label({text: '', style_class: 'aiu-panel-tier', y_align: Clutter.ActorAlign.CENTER});

        for (const child of [this._icon, this._ring, this._rings, this._panelBar, this._panelPct, this._panelTier])
            box.add_child(child);
        this.add_child(box);
    }

    _buildMenu() {
        // Header: service, how it's signed in, and the plan.
        const headerItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false, style_class: 'aiu-header aiu-info'});
        headerItem.add_child(new St.Icon({
            gicon: this._iconFile,
            style_class: 'aiu-logo',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        const titles = new St.BoxLayout(verticalBox({x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
        // The plan pill sits on the name's line, not centered on both lines.
        const titleRow = new St.BoxLayout({style_class: 'aiu-title-row'});
        titleRow.add_child(new St.Label({
            text: this._service.name,
            style_class: 'aiu-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._tierPill = new St.Label({style_class: 'aiu-pill', y_align: Clutter.ActorAlign.CENTER});
        titleRow.add_child(this._tierPill);
        titles.add_child(titleRow);
        this._subtitle = new St.Label({text: '', style_class: 'aiu-subtitle'});
        titles.add_child(this._subtitle);
        headerItem.add_child(titles);
        this.menu.addMenuItem(headerItem);

        const contentItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false, style_class: 'aiu-info'});
        const root = new St.BoxLayout(verticalBox({style_class: 'aiu-popup', x_expand: true}));
        contentItem.add_child(root);
        this.menu.addMenuItem(contentItem);

        this._problemBox = new St.BoxLayout(verticalBox({style_class: 'aiu-problem'}));
        this._problemText = new St.Label({style_class: 'aiu-problem-text'});
        this._problemHint = new St.Label({style_class: 'aiu-problem-hint'});
        for (const label of [this._problemText, this._problemHint]) {
            label.clutter_text.line_wrap = true;
            label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            this._problemBox.add_child(label);
        }
        root.add_child(this._problemBox);

        this._limitsBox = new St.BoxLayout(verticalBox());
        this._fiveHourMeter = new Meter(this._service.limits[0]);
        this._weeklyMeter = new Meter(this._service.limits[1] ?? '');
        this._weeklyMeter.root.visible = !this._oneLimit;
        this._limitsBox.add_child(this._fiveHourMeter.root);
        this._limitsBox.add_child(this._weeklyMeter.root);
        root.add_child(this._limitsBox);

        this._additionalBox = new St.BoxLayout(verticalBox());
        root.add_child(this._additionalBox);

        this._resetsBox = new St.BoxLayout(verticalBox());
        this._resetsBox.add_child(new St.Label({text: 'Saved resets', style_class: 'aiu-heading'}));
        this._resetList = new St.BoxLayout(verticalBox({style_class: 'aiu-reset-list'}));
        this._resetsBox.add_child(this._resetList);
        root.add_child(this._resetsBox);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Adwaita has no external-link icon (libadwaita bundles its own), so
        // ship one. The -symbolic.svg name makes St recolor it like menu text.
        const openUsage = new PopupMenu.PopupMenuItem('See Full Usage');
        openUsage.label.x_expand = true;
        openUsage.add_child(new St.Icon({
            gicon: this._linkIcon,
            style_class: 'popup-menu-icon',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        openUsage.connect('activate', () =>
            Gio.AppInfo.launch_default_for_uri(this._service.usageUrl, null));
        this.menu.addMenuItem(openUsage);

        // Footer in the style of the quick settings: status on the left,
        // round icon buttons on the right.
        const footerItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false, style_class: 'aiu-footer aiu-info'});
        this._updatedLabel = new St.Label({
            style_class: 'aiu-updated',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        footerItem.add_child(this._updatedLabel);
        const iconButton = (iconName, accessibleName, onClicked) => {
            const button = new St.Button({
                style_class: 'icon-button aiu-icon-button',
                child: new St.Icon({icon_name: iconName}),
                accessible_name: accessibleName,
                can_focus: true,
                track_hover: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            button.connect('clicked', onClicked);
            footerItem.add_child(button);
        };
        iconButton('view-refresh-symbolic', 'Refresh', () => this.refresh());
        iconButton('emblem-system-symbolic', 'Settings', () => {
            this.menu.close();
            this._openPreferences(this._service.id);
        });
        this.menu.addMenuItem(footerItem);
    }

    _updateIcon() {
        this._icon.visible = this._settings.get_boolean('show-icon');
        const mono = this._settings.get_string('icon-style') === 'monochrome';
        const hasEffect = this._icon.get_effect('mono-desaturate') !== null;
        if (mono && !hasEffect) {
            this._icon.add_effect(new Clutter.DesaturateEffect({factor: 1.0, name: 'mono-desaturate'}));
            const brightness = new Clutter.BrightnessContrastEffect({name: 'mono-brightness'});
            brightness.set_brightness_full(1, 1, 1);
            this._icon.add_effect(brightness);
        } else if (!mono && hasEffect) {
            this._icon.remove_effect_by_name('mono-desaturate');
            this._icon.remove_effect_by_name('mono-brightness');
        }
    }

    // ---- fetching -------------------------------------------------------

    _createSession() {
        const session = new Soup.Session();
        const proxy = this._main.get_string('proxy-url').trim();
        if (proxy)
            session.set_proxy_resolver(Gio.SimpleProxyResolver.new(proxy, null));
        return session;
    }

    _startTimer() {
        if (this._timerId)
            GLib.source_remove(this._timerId);
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
            Math.max(10, this._main.get_int('refresh-interval')), () => {
                this.refresh();
                return GLib.SOURCE_CONTINUE;
            });
    }

    async refresh() {
        if (this._refreshing) {
            // Settings changed mid-refresh, so run once more when this one ends.
            this._refreshAgain = true;
            return;
        }
        // Asking again while rate limited only extends the wait.
        if (nowSeconds() < this._pausedUntil())
            return;
        this._refreshing = true;
        this._refreshAgain = false;
        this._lastTry = monotonicSeconds();
        this._renderFooter();
        try {
            this.showUsage(await this._load(serviceFolder(this._service, this._settings), this._session, this._cancellable));
        } catch (e) {
            if (isCancelled(e))
                return;
            if (!(e instanceof UsageError))
                console.error(`AI Usage: ${this._service.name} refresh failed: ${e.message}`);
            if (e instanceof UsageError && e.kind === 'rate-limited')
                this._settings.set_int64('paused-until', Math.ceil(nowSeconds() + e.retryAfter));
            this.showProblem(e instanceof UsageError ? e.kind : 'server');
        } finally {
            this._refreshing = false;
            if (!this._cancellable.is_cancelled())
                this._renderFooter();
            if (this._refreshAgain && !this._cancellable.is_cancelled())
                this.refresh();
        }
    }

    // Unix seconds. No requests go out before this (set by a 429). Kept in
    // settings so a new login doesn't ask again straight away.
    _pausedUntil() {
        return this._settings.get_int64('paused-until');
    }

    // The last numbers are kept in settings so they can be shown, marked out
    // of date, after a new login while the service is unreachable.
    _restoreUsage() {
        try {
            const saved = JSON.parse(this._settings.get_string('last-usage') || 'null');
            if (saved?.usage && saved.updatedAt) {
                this._usage = saved.usage;
                this._updatedAt = GLib.DateTime.new_from_unix_local(saved.updatedAt);
            }
        } catch (e) {
            console.error(`AI Usage: ignoring saved ${this._service.name} usage: ${e.message}`);
        }
    }

    // Public so the test harness can feed in sample data.
    showUsage(usage) {
        this._usage = usage;
        this._updatedAt = GLib.DateTime.new_now_local();
        this._problem = null;
        this._settings.set_string('last-usage', JSON.stringify({usage, updatedAt: this._updatedAt.to_unix()}));
        this._renderAll();
    }

    showProblem(kind) {
        // A temporary problem keeps the last numbers on screen.
        if (SIGN_IN_PROBLEMS.includes(kind)) {
            this._usage = null;
            this._updatedAt = null;
            this._settings.set_string('last-usage', '');
        }
        this._triedAt = GLib.DateTime.new_now_local();
        this._problem = kind;
        this._renderAll();
    }

    // ---- rendering ------------------------------------------------------

    _problemCopy(kind) {
        const {name, app} = this._service;
        const folder = tildePath(serviceFolder(this._service, this._settings));
        switch (kind) {
        case 'signed-out':
            return {
                text: `Open ${app} and sign in to see your usage here.`,
                hint: `Looking for your sign-in in ${folder}. You can pick a different folder in Settings.`,
            };
        case 'expired':
            return {
                text: `Your ${app} sign-in has expired. Open ${app} to refresh it.`,
                hint: `${app} refreshes it on its own while you use it.`,
            };
        case 'api-key':
            return {
                text: `${app} is signed in with an API key, which has no plan limits to show.`,
                hint: `Sign in to ${app} with your ChatGPT account to see them here.`,
            };
        case 'rate-limited': {
            const until = this._pausedUntil();
            const at = until > nowSeconds() ? ` at ${clockTime(GLib.DateTime.new_from_unix_local(until))}` : ' soon';
            return {
                text: `${name} asked to check less often. Trying again${at}.`,
                hint: this._usage ? 'Showing your last numbers until then.' : '',
            };
        }
        case 'network':
            return {text: `Can't reach ${name} right now. Trying again soon.`, hint: ''};
        default:
            return {text: `${name} didn't send your usage this time. Trying again soon.`, hint: ''};
        }
    }

    _renderAll() {
        const usage = this._usage;
        const signInProblem = SIGN_IN_PROBLEMS.includes(this._problem);

        if (this._problem === 'api-key')
            this._subtitle.text = 'Signed in with an API key';
        else
            this._subtitle.text = signInProblem ? 'Not signed in' : `Signed in through ${this._service.app}`;
        // Empty bars add nothing until there's a sign-in to read.
        this._limitsBox.visible = !signInProblem;
        this._tierPill.text = usage?.tier ?? '';
        this._tierPill.visible = !!usage?.tier;

        this._problemBox.visible = !!this._problem;
        if (this._problem) {
            const copy = this._problemCopy(this._problem);
            this._problemText.text = copy.text;
            this._problemHint.text = copy.hint;
            this._problemHint.visible = !!copy.hint;
        }

        if (usage) {
            this._applyWindow(this._fiveHourMeter, usage.primary, windowTotal(usage.primary, FIVE_HOURS));
            this._applyWindow(this._weeklyMeter, usage.secondary, windowTotal(usage.secondary, SEVEN_DAYS));
            // A plan with one pool, such as Cursor Start, has no second limit.
            this._weeklyMeter.root.visible = !this._oneLimit && !!usage.secondary;
        } else {
            this._fiveHourMeter.setMuted();
            this._weeklyMeter.setMuted();
            this._weeklyMeter.root.visible = !this._oneLimit;
        }
        this._renderAdditional(usage);
        this._renderResets(usage);
        this._renderPanel(usage, signInProblem);
        this._renderFooter();
        this._scheduleCountdown();
    }

    _renderFooter() {
        const stale = !!this._usage && !!this._problem;
        this._updatedLabel.style_class = stale ? 'aiu-updated aiu-updated-stale' : 'aiu-updated';
        if (this._refreshing)
            this._updatedLabel.text = 'Updating…';
        else if (stale)
            this._updatedLabel.text = `Out of date, from ${clockTime(this._updatedAt)}`;
        else if (this._usage)
            this._updatedLabel.text = `Updated ${clockTime(this._updatedAt)}`;
        else if (this._triedAt)
            this._updatedLabel.text = `Tried at ${clockTime(this._triedAt)}`;
        else
            this._updatedLabel.text = 'Loading…';
    }

    _renderAdditional(usage) {
        this._additionalBox.destroy_all_children();
        const limits = usage?.additional ?? [];
        this._additionalBox.visible = limits.length > 0 && this._settings.get_boolean('show-additional-limits');
        if (!this._additionalBox.visible)
            return;
        for (const limit of limits) {
            this._additionalBox.add_child(new St.Label({text: limit.name, style_class: 'aiu-heading'}));
            for (const {label, win, total} of limit.windows) {
                const meter = new Meter(label);
                this._applyWindow(meter, win, total);
                this._additionalBox.add_child(meter.root);
            }
        }
    }

    _renderResets(usage) {
        this._resetsBox.visible = !!usage?.resets;
        if (!usage?.resets)
            return;
        this._resetList.destroy_all_children();
        const {count, details} = usage.resets;
        const addRow = (name, value) => {
            const row = new St.BoxLayout({style_class: 'aiu-reset-row'});
            row.add_child(new St.Label({text: name, style_class: 'aiu-reset-name', x_expand: true}));
            row.add_child(new St.Label({text: value, style_class: 'aiu-reset-time'}));
            this._resetList.add_child(row);
        };
        if (!count)
            this._resetList.add_child(new St.Label({text: 'None right now', style_class: 'aiu-reset-empty'}));
        else if (details.length === 0)
            addRow('Resets you can use', `${count}`);
        else
            details.forEach(d => addRow(d.title, expiresCaption(d.expiresAt)));
    }

    _showRemaining() {
        return this._settings.get_string('usage-display') === 'remaining';
    }

    _applyWindow(meter, win, totalSeconds) {
        if (!win) {
            meter.setMuted();
            return;
        }
        const util = win.utilization;
        const proj = projectedUtil(util, win.resets_at, totalSeconds);
        const shown = this._showRemaining() ? 100 - util : util;
        const caption = win.resets_at ? resetCaption(win.resets_at) : (util > 0 ? '' : 'Not used yet');

        let note = null;
        const exhaust = exhaustSeconds(util, win.resets_at, totalSeconds);
        if (exhaust !== null) {
            note = {text: `At this pace you'll run out in about ${humanDuration(exhaust)}`, warn: true};
        } else if (util < 100 && Math.round(proj) > Math.round(util)) {
            let text = `At this pace you'll reach about ${Math.min(100, Math.round(proj))}% by the reset`;
            if (proj > 0 && proj < 75) {
                const room = 100 / proj;
                text += `, so you have room for about ${room >= 10 ? Math.round(room) : room.toFixed(1)}x more`;
            }
            note = {text, warn: severity(proj) !== 'usage-low'};
        }

        meter.setValue({
            util,
            colorUtil: proj,
            pctText: `${Math.round(shown)}% ${this._showRemaining() ? 'left' : 'used'}`,
            caption,
            note,
        });
    }

    _ringValue(win, totalSeconds) {
        return win ? {util: win.utilization, colorUtil: projectedUtil(win.utilization, win.resets_at, totalSeconds)} : null;
    }

    _panelWindow(usage) {
        const primary = {win: usage.primary, total: windowTotal(usage.primary, FIVE_HOURS)};
        const secondary = {win: usage.secondary, total: windowTotal(usage.secondary, SEVEN_DAYS)};
        if (this._oneLimit || !usage.secondary)
            return primary;
        switch (this._settings.get_string('panel-window')) {
        case 'secondary':
            return secondary;
        case 'max': {
            const p = projectedUtil(usage.primary?.utilization ?? -1, usage.primary?.resets_at, primary.total);
            const s = projectedUtil(usage.secondary?.utilization ?? -1, usage.secondary?.resets_at, secondary.total);
            return s > p ? secondary : primary;
        }
        default:
            return primary;
        }
    }

    _renderPanel(usage, signInProblem) {
        let mode = this._settings.get_string('display-mode');
        // With one limit there's no inner ring to show.
        const single = this._oneLimit || (usage && !usage.secondary);
        if (single && mode.startsWith('rings'))
            mode = mode === 'rings' ? 'ring' : 'ring-only';
        this._ring.visible = mode === 'ring' || mode === 'ring-only';
        this._rings.visible = mode === 'rings' || mode === 'rings-only';
        this._panelBar.visible = mode === 'bar' || mode === 'both';
        this._panelPct.visible = !['bar', 'rings-only', 'ring-only'].includes(mode) || !!this._problem;
        this._panelTier.text = usage?.tier ?? '';
        this._panelTier.visible = !!usage?.tier && this._settings.get_boolean('show-tier');

        if (!usage) {
            this._panelPct.text = signInProblem ? 'Sign in' : (this._problem ? '!' : '…');
            this._panelPct.style_class = this._problem ? 'aiu-panel-pct usage-high' : 'aiu-panel-pct';
            this._ring.setValue(null);
            this._rings.setValues(null, null);
            this._panelBar.setValue(null);
            return;
        }

        this._rings.setValues(this._ringValue(usage.primary, windowTotal(usage.primary, FIVE_HOURS)),
            this._ringValue(usage.secondary, windowTotal(usage.secondary, SEVEN_DAYS)));
        const {win, total} = this._panelWindow(usage);
        const value = this._ringValue(win, total);
        this._ring.setValue(value);
        this._panelBar.setValue(value);
        if (value) {
            const shown = this._showRemaining() ? 100 - value.util : value.util;
            this._panelPct.text = `${Math.round(shown)}%`;
            this._panelPct.style_class = `aiu-panel-pct ${severity(value.colorUtil)}`;
        } else {
            this._panelPct.text = '–';
            this._panelPct.style_class = 'aiu-panel-pct';
        }
    }

    // Keeps "Resets in …" captions current between refreshes.
    _scheduleCountdown() {
        if (this._countdownId) {
            GLib.source_remove(this._countdownId);
            this._countdownId = 0;
        }
        const soonest = [this._usage?.primary, this._usage?.secondary]
            .map(w => secondsUntil(w?.resets_at))
            .filter(s => s !== null && s > 0)
            .sort((a, b) => a - b)[0];
        if (soonest === undefined)
            return;
        this._countdownId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, soonest < 90 ? 1 : 30, () => {
            this._countdownId = 0;
            this._renderAll();
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        this._cancellable.cancel();
        if (this._timerId)
            GLib.source_remove(this._timerId);
        if (this._countdownId)
            GLib.source_remove(this._countdownId);
        this._timerId = this._countdownId = 0;
        this._settings.disconnectObject(this);
        this._main.disconnectObject(this);
        this.menu.disconnectObject(this);
        this._session?.abort();
        this._session = null;
        super.destroy();
    }
});
