// Reads each service's existing sign-in from its folder and fetches usage.
// Nothing is stored: the token is read fresh on every refresh and kept only
// for the length of the request.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup';

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Soup.Session.prototype, 'send_and_read_async');
Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

export const FIVE_HOURS = 5 * 3600;
export const SEVEN_DAYS = 7 * 24 * 3600;

const CLAUDE_USAGE_API = 'https://api.anthropic.com/api/oauth/usage';
const CODEX_USAGE_API = 'https://chatgpt.com/backend-api/wham/usage';
const CODEX_RESETS_API = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits';

// Used when a 429 has no usable Retry-After header.
const DEFAULT_RETRY_AFTER = 10 * 60;
const MAX_RETRY_AFTER = 2 * 3600;

// kind is one of: signed-out, expired, api-key, network, server, rate-limited.
// retryAfter (seconds) is set for rate-limited.
export class UsageError extends Error {
    constructor(kind, detail = '', retryAfter = 0) {
        super(detail ? `${kind}: ${detail}` : kind);
        this.kind = kind;
        this.retryAfter = retryAfter;
    }
}

// Retry-After is either delay-seconds or an HTTP date.
function retryAfterSeconds(message) {
    const value = message.response_headers.get_one('Retry-After')?.trim();
    let seconds = NaN;
    if (value && /^\d+$/.test(value))
        seconds = parseInt(value, 10);
    else if (value)
        seconds = (Date.parse(value) - Date.now()) / 1000;
    if (!Number.isFinite(seconds) || seconds <= 0)
        return DEFAULT_RETRY_AFTER;
    return Math.min(MAX_RETRY_AFTER, Math.ceil(seconds));
}

export function isCancelled(e) {
    return e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

function percent(value) {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.min(100, Math.max(0, value))
        : 0;
}

async function readJson(folder, name, cancellable) {
    const file = Gio.File.new_for_path(GLib.build_filenamev([folder, name]));
    let contents;
    try {
        [contents] = await file.load_contents_async(cancellable);
    } catch (e) {
        if (isCancelled(e))
            throw e;
        throw new UsageError('signed-out', e.message);
    }
    try {
        return JSON.parse(new TextDecoder().decode(contents));
    } catch {
        throw new UsageError('signed-out', `${name} is not valid JSON`);
    }
}

async function getJson(session, message, cancellable) {
    let bytes;
    try {
        bytes = await session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable);
    } catch (e) {
        if (isCancelled(e))
            throw e;
        throw new UsageError('network', e.message);
    }
    const status = message.get_status();
    if (status === 401 || status === 403)
        throw new UsageError('expired', `HTTP ${status}`);
    if (status === 429)
        throw new UsageError('rate-limited', `HTTP ${status}`, retryAfterSeconds(message));
    if (status !== 200)
        throw new UsageError('server', `HTTP ${status}`);
    try {
        return JSON.parse(new TextDecoder().decode(bytes.get_data()));
    } catch {
        throw new UsageError('server', 'response is not valid JSON');
    }
}

// ---- Claude -------------------------------------------------------------

function claudeTier(oauth) {
    const text = `${oauth.subscriptionType ?? ''} ${oauth.rateLimitTier ?? ''}`.toLowerCase();
    if (text.includes('max')) {
        if (text.includes('20x'))
            return 'MAX X20';
        if (text.includes('5x'))
            return 'MAX X5';
        return 'MAX';
    }
    for (const [key, label] of [['enterprise', 'ENT'], ['team', 'TEAM'], ['pro', 'PRO'], ['free', 'FREE']]) {
        if (text.includes(key))
            return label;
    }
    return null;
}

function claudeWindow(w) {
    return {utilization: percent(w?.utilization), resets_at: w?.resets_at ?? null};
}

async function loadClaude(folder, session, cancellable) {
    const creds = await readJson(folder, '.credentials.json', cancellable);
    const oauth = creds.claudeAiOauth;
    if (!oauth?.accessToken)
        throw new UsageError('signed-out', 'no accessToken');

    const message = Soup.Message.new('GET', CLAUDE_USAGE_API);
    message.request_headers.append('Authorization', `Bearer ${oauth.accessToken}`);
    message.request_headers.append('anthropic-beta', 'oauth-2025-04-20');
    const data = await getJson(session, message, cancellable);

    const perModel = [['seven_day_opus', 'Opus'], ['seven_day_sonnet', 'Sonnet']]
        .filter(([key]) => data[key])
        .map(([key, name]) => ({
            name,
            windows: [{label: 'Weekly limit', win: claudeWindow(data[key]), total: SEVEN_DAYS}],
        }));

    return {
        tier: claudeTier(oauth),
        primary: claudeWindow(data.five_hour),
        secondary: claudeWindow(data.seven_day),
        additional: perModel,
        resets: null,
    };
}

// ---- Codex --------------------------------------------------------------

function codexTier(value) {
    const normalized = `${value ?? ''}`.toLowerCase().replace(/[\s_-]/g, '');
    if (!normalized)
        return null;
    const known = [
        ['prolite', 'PRO X5'],
        ['pro', 'PRO X20'],
        ['plus', 'PLUS'],
        ['free', 'FREE'],
        ['team', 'TEAM'],
        ['business', 'BUSINESS'],
        ['enterprise', 'ENT'],
        ['edu', 'EDU'],
    ];
    for (const [key, label] of known) {
        if (normalized.includes(key))
            return label;
    }
    return `${value}`.toUpperCase();
}

// Codex reports a reset time even for a window that hasn't started, set a
// full window length from now. Drop it so the menu says "Not used yet".
function codexWindow(w, total) {
    if (!w)
        return null;
    const utilization = percent(w.used_percent);
    const notStarted = w.reset_at && utilization === 0 &&
        w.reset_at - Date.now() / 1000 >= total - 60;
    return {
        utilization,
        resets_at: w.reset_at && !notStarted ? new Date(w.reset_at * 1000).toISOString() : null,
    };
}

function codexMessage(url, tokens) {
    const message = Soup.Message.new('GET', url);
    message.request_headers.append('Authorization', `Bearer ${tokens.access_token}`);
    message.request_headers.append('User-Agent', 'codex-cli');
    if (tokens.account_id)
        message.request_headers.append('ChatGPT-Account-Id', tokens.account_id);
    return message;
}

async function loadCodex(folder, session, cancellable) {
    const auth = await readJson(folder, 'auth.json', cancellable);
    const tokens = auth.tokens ?? auth;
    if (!tokens?.access_token)
        throw new UsageError(auth.OPENAI_API_KEY ? 'api-key' : 'signed-out', 'no access_token');

    const data = await getJson(session, codexMessage(CODEX_USAGE_API, tokens), cancellable);
    const rl = data.rate_limit;
    if (!rl)
        throw new UsageError('server', 'no rate_limit in response');

    const usage = {
        tier: codexTier(data.plan_type ?? rl.plan ?? rl.subscription_type ?? rl.rate_limit_tier ?? rl.tier),
        primary: codexWindow(rl.primary_window, FIVE_HOURS) ?? {utilization: 0, resets_at: null},
        secondary: codexWindow(rl.secondary_window, SEVEN_DAYS) ?? {utilization: 0, resets_at: null},
        additional: (data.additional_rate_limits ?? [])
            .filter(entry => entry?.rate_limit)
            .map(entry => ({
                name: `${entry.limit_name ?? 'Other'}`,
                windows: [
                    {label: '5-hour limit', win: codexWindow(entry.rate_limit.primary_window, FIVE_HOURS), total: FIVE_HOURS},
                    {label: 'Weekly limit', win: codexWindow(entry.rate_limit.secondary_window, SEVEN_DAYS), total: SEVEN_DAYS},
                ].filter(w => w.win),
            })),
        resets: {count: data.rate_limit_reset_credits?.available_count ?? 0, details: []},
    };

    if (usage.resets.count > 0) {
        try {
            const credits = await getJson(session, codexMessage(CODEX_RESETS_API, tokens), cancellable);
            usage.resets.details = (credits.credits ?? [])
                .filter(credit => credit?.status === 'available')
                .map(credit => ({title: credit.title || 'Full reset', expiresAt: credit.expires_at ?? null}));
        } catch (e) {
            if (isCancelled(e))
                throw e;
            // The count alone is still worth showing.
            console.error(`AI Usage: Codex reset details failed: ${e.message}`);
        }
    }
    return usage;
}

// ---- Cursor -------------------------------------------------------------

// The endpoint Cursor's own dashboard reads. Private, so it may change.
const CURSOR_USAGE_API = 'https://cursor.com/api/usage-summary';

// The IDE keeps its sign-in in a SQLite database. GJS can't read SQLite, so
// ask the Python that desktop distributions ship. Read-only, path as argv.
const CURSOR_READ_TOKEN = `
import pathlib, sqlite3, sys
db = sqlite3.connect(pathlib.Path(sys.argv[1]).as_uri() + '?mode=ro', uri=True)
row = db.execute("SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken'").fetchone()
value = row[0] if row else ''
print(value.decode() if isinstance(value, bytes) else value)
`;

async function cursorIdeToken(folder, cancellable) {
    const db = GLib.build_filenamev([folder, 'User', 'globalStorage', 'state.vscdb']);
    if (!GLib.file_test(db, GLib.FileTest.EXISTS))
        return null;
    try {
        const proc = Gio.Subprocess.new(['python3', '-c', CURSOR_READ_TOKEN, db],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        const [stdout] = await proc.communicate_utf8_async(null, cancellable);
        return proc.get_successful() ? stdout.trim() || null : null;
    } catch (e) {
        if (isCancelled(e))
            throw e;
        console.error(`AI Usage: can't read the Cursor sign-in (is python3 installed?): ${e.message}`);
        return null;
    }
}

// cursor-agent, the CLI, keeps its own sign-in as plain JSON.
async function cursorCliToken(cancellable) {
    const folder = GLib.build_filenamev([GLib.get_user_config_dir(), 'cursor']);
    try {
        const auth = await readJson(folder, 'auth.json', cancellable);
        return auth.accessToken ?? auth.access_token ?? null;
    } catch (e) {
        if (isCancelled(e))
            throw e;
        return null;
    }
}

// The cookie wants the user ID, which is the last part of the token's
// "sub" claim ("auth0|user_…").
function cursorUserId(token) {
    try {
        let part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
        part += '='.repeat((4 - part.length % 4) % 4);
        const claims = JSON.parse(new TextDecoder().decode(GLib.base64_decode(part)));
        return `${claims.sub ?? ''}`.split('|').pop() || null;
    } catch {
        return null;
    }
}

function cursorTier(value) {
    const normalized = `${value ?? ''}`.toLowerCase().replace(/[\s-]/g, '_');
    if (!normalized)
        return null;
    const known = {
        free: 'HOBBY',
        free_trial: 'TRIAL',
        pro: 'PRO',
        pro_plus: 'PRO+',
        ultra: 'ULTRA',
        team: 'TEAMS',
        business: 'TEAMS',
        enterprise: 'ENT',
    };
    return known[normalized] ?? normalized.replace(/_/g, ' ').toUpperCase();
}

// Plan pools are the dashboard percentages. used/limit is included spend in
// cents against the dollar cap, and that ratio sits at 100% once the cap is
// reached even while the other pool still has room.
function cursorPoolPercent(pool, key) {
    const value = pool?.[key];
    return typeof value === 'number' && Number.isFinite(value) ? percent(value) : null;
}

// Team accounts often have no plan object. The same two pools show up as
// "You've used 42% of your included … usage".
function cursorMessagePercent(message) {
    const match = typeof message === 'string' ? message.match(/(\d+(?:\.\d+)?)%/) : null;
    return match ? percent(Number(match[1])) : null;
}

// On-demand used and limit are cents of the spending limit you set.
function cursorSpendPercent(pool) {
    if (typeof pool?.used === 'number' && pool.limit > 0)
        return percent((pool.used / pool.limit) * 100);
    return null;
}

async function loadCursor(folder, session, cancellable) {
    const token = await cursorIdeToken(folder, cancellable) ?? await cursorCliToken(cancellable);
    if (!token)
        throw new UsageError('signed-out', 'no accessToken');
    const userId = cursorUserId(token);
    if (!userId)
        throw new UsageError('expired', 'no user ID in token');

    const message = Soup.Message.new('GET', CURSOR_USAGE_API);
    message.request_headers.append('Cookie', `WorkosCursorSessionToken=${userId}%3A%3A${token}`);
    message.request_headers.append('Origin', 'https://cursor.com');
    message.request_headers.append('Referer', 'https://cursor.com/dashboard');
    const data = await getJson(session, message, cancellable);

    const individual = data.individualUsage ?? {};
    const pools = individual.plan ?? individual.overall;
    const start = Date.parse(data.billingCycleStart);
    const end = Date.parse(data.billingCycleEnd);
    const total = Number.isFinite(start) && end > start ? (end - start) / 1000 : 30 * 24 * 3600;
    const resetsAt = Number.isFinite(end) ? new Date(end).toISOString() : null;
    const month = utilization => ({utilization, resets_at: resetsAt, total});

    // Cursor Models (auto) and Other Models (api). A plan with only the first
    // pool, such as Start, leaves the second unset. Without a plan object,
    // both display messages have to parse or this isn't a team snapshot.
    let auto = cursorPoolPercent(pools, 'autoPercentUsed');
    let api = cursorPoolPercent(pools, 'apiPercentUsed');
    if (auto === null && api === null) {
        const autoMsg = cursorMessagePercent(data.autoModelSelectedDisplayMessage);
        const apiMsg = cursorMessagePercent(data.namedModelSelectedDisplayMessage);
        if (autoMsg !== null && apiMsg !== null) {
            auto = autoMsg;
            api = apiMsg;
        }
    }
    if (auto === null) {
        if (!data.isUnlimited)
            throw new UsageError('server', 'no plan usage in response');
        auto = 0;
    }

    const additional = [];
    const onDemand = individual.onDemand ?? data.teamUsage?.onDemand;
    const spend = onDemand?.enabled ? cursorSpendPercent(onDemand) : null;
    if (spend !== null) {
        additional.push({
            name: 'On-demand',
            windows: [{label: 'Spending limit', win: month(spend), total}],
        });
    }

    return {
        tier: cursorTier(data.membershipType),
        primary: month(auto),
        secondary: api === null ? null : month(api),
        additional,
        resets: null,
    };
}

export const LOADERS = {
    claude: loadClaude,
    codex: loadCodex,
    cursor: loadCursor,
};
