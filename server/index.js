import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const DEFAULT_API_BASE = 'https://charavault.net/api';
const DEFAULT_CDN_BASE = 'https://charavault.net';

const MAX_JSON_BYTES = 10 * 1024 * 1024;   // 10 MB
const MAX_BINARY_BYTES = 50 * 1024 * 1024; // 50 MB
const REQUEST_TIMEOUT_MS = 30_000;

export const FOLDER_RE = /^[A-Za-z0-9_-]{1,64}$/;

const BLOCKED_HOSTNAMES = new Set([
    'localhost',
    'metadata.google.internal',
    'metadata.goog',
    'kubernetes.default',
    'kubernetes.default.svc',
]);
const BLOCKED_SUFFIXES = ['.local', '.localhost', '.internal'];

function httpError(statusCode, message) {
    const err = new Error(message);
    err.statusCode = statusCode;
    return err;
}

function isPrivateIPv4(ip) {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const [a, b, c] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a === 192 && b === 0 && c === 0) return true;
    if (a >= 224) return true;
    return false;
}

function ipv6Groups(ip) {
    let s = String(ip).toLowerCase().split('%')[0];
    const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
    if (dotted) {
        const [a, b, c, d] = dotted.slice(1).map(Number);
        s = `${s.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
    }
    const halves = s.split('::');
    if (halves.length > 2) return null;
    const head = halves[0] ? halves[0].split(':') : [];
    const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null;
    const parts = tail === null ? head : [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail];
    if (parts.length !== 8 || parts.some(p => !/^[0-9a-f]{1,4}$/.test(p))) return null;
    return parts.map(p => parseInt(p, 16));
}

function isPrivateIPv6(ip) {
    const g = ipv6Groups(ip);
    if (!g) return true;
    const isLoopbackOrUnspec = g.slice(0, 7).every(n => n === 0) && (g[7] === 0 || g[7] === 1);
    if (isLoopbackOrUnspec) return true;
    const zero = (from, to) => g.slice(from, to).every(n => n === 0);
    const v4 = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
    let embeddedV4 = null;
    if (zero(0, 5) && g[5] === 0xffff) embeddedV4 = v4(g[6], g[7]);
    else if (zero(0, 4) && g[4] === 0xffff && g[5] === 0) embeddedV4 = v4(g[6], g[7]);
    else if (zero(0, 6) && !isLoopbackOrUnspec) embeddedV4 = v4(g[6], g[7]);
    else if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) embeddedV4 = v4(g[6], g[7]);
    else if (g[0] === 0x2002) embeddedV4 = v4(g[1], g[2]);
    if (embeddedV4) return isPrivateIPv4(embeddedV4);
    if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return true;
    if ((g[0] & 0xfe00) === 0xfc00) return true;
    if ((g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0) return true;
    if ((g[0] & 0xff00) === 0xff00) return true;
    return false;
}

export function isPrivateAddress(ip) {
    const kind = net.isIP(ip);
    if (kind === 4) return isPrivateIPv4(ip);
    if (kind === 6) return isPrivateIPv6(ip);
    return true;
}

export async function assertSafeUpstreamUrl(urlStr, { multiUser = false } = {}) {
    let parsed;
    try {
        parsed = new URL(urlStr);
    } catch {
        throw httpError(400, 'Invalid upstream URL');
    }
    const allowPrivate = process.env.CL_ALLOW_PRIVATE_FETCH === 'true';
    if (multiUser && !allowPrivate && parsed.protocol !== 'https:') {
        throw httpError(403, 'Gateway URL must use HTTPS on a multi-user server');
    }
    if (!/^https?:$/.test(parsed.protocol)) {
        throw httpError(400, 'Gateway URL must use HTTP or HTTPS');
    }
    if (allowPrivate) return parsed;

    const name = String(parsed.hostname || '').toLowerCase().replace(/\.$/, '');
    if (!name) throw httpError(403, 'Gateway host is empty');
    const bare = name.startsWith('[') && name.endsWith(']') ? name.slice(1, -1) : name;
    if (net.isIP(bare)) {
        if (isPrivateAddress(bare)) throw httpError(403, 'Gateway URL resolves to a private or loopback address');
        return parsed;
    }
    if (BLOCKED_HOSTNAMES.has(bare) || BLOCKED_SUFFIXES.some(s => bare.endsWith(s))) {
        throw httpError(403, 'Gateway host is blocked');
    }
    if (bare === 'charavault.net' || bare === 'www.charavault.net') return parsed;

    let addrs;
    try {
        addrs = await dns.lookup(bare, { all: true, verbatim: true });
    } catch {
        throw httpError(403, 'Gateway host does not resolve');
    }
    if (!addrs.length || addrs.some(a => isPrivateAddress(a.address))) {
        throw httpError(403, 'Gateway URL resolves to a private or loopback address');
    }
    return parsed;
}

export function isValidFileSegment(file) {
    if (typeof file !== 'string') return false;
    const s = file.trim();
    if (!s || s.length > 255 || s === '.' || s === '..') return false;
    if (/[\\/\0]/.test(s) || s.includes('..')) return false;
    return true;
}

export function validateCardSegments(folder, file) {
    const f = String(folder || '').trim();
    const fn = String(file || '').trim();
    if (!FOLDER_RE.test(f) || !isValidFileSegment(fn)) {
        throw httpError(400, 'Invalid card folder or filename');
    }
    return { folder: f, file: fn };
}

export function resolveCvBases(req, ctx) {
    const gw = String(ctx.setting(req.db, 'gatewayUrl') || '').trim().replace(/\/+$/, '');
    const cdnGw = String(ctx.setting(req.db, 'gatewayCdnUrl') || '').trim().replace(/\/+$/, '');
    const apiBase = gw || DEFAULT_API_BASE;
    const cdnBase = cdnGw || (gw
        ? (gw.endsWith('/v1/cv') ? `${gw.slice(0, -6)}/v1/cv-cdn` : gw.endsWith('/api') ? gw.slice(0, -4) : gw)
        : DEFAULT_CDN_BASE);
    return { apiBase, cdnBase };
}

const cleanSecret = (v) => String(v || '').trim().replace(/^bearer\s+/i, '').trim();

export function readCredentials(req, ctx) {
    return {
        email: String(ctx.setting(req.db, 'email') || '').trim(),
        appPassword: cleanSecret(ctx.setting(req.db, 'appPassword')),
        gatewayKey: cleanSecret(ctx.setting(req.db, 'gatewayKey')),
    };
}

/**
 * CharaVault app passwords are not bearer tokens: the app logs in with POST /api/auth/login
 * ({email, password: cv_...}) and sends the session token it answers as Authorization: Bearer.
 * `sessionToken` is that login token; a gateway key (charlib-proxy) still rides as-is.
 */
export function buildUpstreamHeaders(req, ctx, accept = 'application/json', { includeAuth = true, sessionToken = null } = {}) {
    const headers = { 'User-Agent': USER_AGENT, Accept: accept, Referer: 'https://charavault.net/' };
    if (!includeAuth) return headers;
    const { appPassword, gatewayKey } = readCredentials(req, ctx);
    if (gatewayKey) {
        headers.Authorization = 'Bearer ' + gatewayKey;
        // charlib-proxy reads the user's app password from this header and logs in itself
        if (appPassword) headers['X-App-Password'] = appPassword;
    } else if (sessionToken) {
        headers.Authorization = 'Bearer ' + sessionToken;
    }
    return headers;
}

const LOGIN_RETRY_MS = 60 * 1000;
// per account: { fp, token, user, error, at }
const sessions = new Map();
const sessionKey = (req) => req?.userHandle || 'default';
export function forgetCvSessions() { sessions.clear(); }

function splitFullPath(folder, file, fullPath) {
    if (folder !== undefined && folder !== null && folder !== '' && file !== undefined && file !== null && file !== '') {
        return validateCardSegments(folder, file);
    }
    const raw = String(fullPath || '').trim();
    if (!raw || raw.startsWith('/') || raw.includes('\\') || raw.includes('\0')) {
        throw httpError(400, 'Invalid card path');
    }
    const parts = raw.split('/');
    if (parts.length === 1) return validateCardSegments('cards', parts[0]);
    if (parts.length === 2) return validateCardSegments(parts[0], parts[1]);
    throw httpError(400, 'Invalid card path');
}

function queryString(query, keys) {
    const qs = new URLSearchParams();
    for (const key of keys) {
        if (query[key] !== undefined && query[key] !== null && query[key] !== '') {
            qs.set(key, String(query[key]));
        }
    }
    return qs.toString();
}

export async function readBodyCapped(response, maxBytes) {
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
        await response.body?.cancel().catch(() => {});
        throw httpError(502, 'Upstream response too large');
    }
    if (!response.body) return Buffer.alloc(0);
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > maxBytes) {
                await reader.cancel().catch(() => {});
                throw httpError(502, 'Upstream response too large');
            }
            chunks.push(Buffer.from(value));
        }
    } finally {
        reader.releaseLock?.();
    }
    return Buffer.concat(chunks, total);
}

async function readTextCapped(response, maxBytes = MAX_JSON_BYTES) {
    const buf = await readBodyCapped(response, maxBytes);
    return new TextDecoder().decode(buf);
}

function makeSignal(res) {
    const ctrl = new AbortController();
    res?.once?.('close', () => {
        if (!res.writableEnded) ctrl.abort();
    });
    return {
        ctrl,
        signal: AbortSignal.any([ctrl.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    };
}

const FALLBACK_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect x="2" y="2" width="28" height="28" rx="6" fill="#26324a"/><rect x="7" y="7" width="18" height="18" rx="3" fill="none" stroke="#b8c9ef" stroke-width="2"/><circle cx="16" cy="16" r="5" fill="none" stroke="#b8c9ef" stroke-width="2"/><path d="M16 11v10m-5-5h10" stroke="#b8c9ef" stroke-width="2"/></svg>';

function setSafeHeaders(res) {
    res.set('Content-Security-Policy', 'sandbox');
    res.set('Cross-Origin-Resource-Policy', 'same-origin');
}

export function register(router, ctx) {
    const doFetch = (url, init) => (typeof ctx.helpers?.sameHostFetch === 'function'
        ? ctx.helpers.sameHostFetch(url, init)
        : fetch(url, { ...init, redirect: 'error' }));

    const route = (routePath, handler) => router.get(routePath, async (req, res) => {
        const { ctrl, signal } = makeSignal(res);
        req._cvSignal = signal;
        try {
            await handler(req, res);
        } catch (error) {
            if (ctrl.signal.aborted) return;
            const status = (error?.statusCode >= 400 && error?.statusCode < 600) ? error.statusCode : 502;
            setSafeHeaders(res);
            res.status(status).json({ error: error?.message || 'CharaVault upstream request failed' });
        }
    });

    // POST {apiBase}/auth/login with email + cv_ app password; answers { ok, token, user, status, error }
    const login = async (req, apiBase, email, appPassword, signal) => {
        const target = await assertSafeUpstreamUrl(apiBase + '/auth/login', { multiUser: !!ctx.multiUser });
        const response = await doFetch(target, {
            method: 'POST',
            headers: { ...buildUpstreamHeaders(req, ctx, 'application/json', { includeAuth: false }), 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password: appPassword }),
            signal,
        });
        const text = await readTextCapped(response, 256 * 1024);
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { /* not json */ }
        if (response.ok && data?.token) return { ok: true, token: String(data.token), user: data.user || null, status: response.status };
        const detail = typeof data?.detail === 'string' ? data.detail
            : data?.requires_2fa ? 'CharaVault asked for 2FA: use an App Password (cv_...), not your account password'
            : `HTTP ${response.status}`;
        return { ok: false, status: response.status, error: detail };
    };

    // the account's CharaVault session token, logging in once and on a 401 (force)
    const sessionFor = async (req, { force = false } = {}) => {
        const { email, appPassword, gatewayKey } = readCredentials(req, ctx);
        if (gatewayKey || !email || !appPassword) return null;
        const { apiBase } = resolveCvBases(req, ctx);
        const fp = crypto.createHash('sha256').update(apiBase + '\n' + email.toLowerCase() + '\n' + appPassword).digest('hex');
        const key = sessionKey(req);
        const cur = sessions.get(key);
        if (cur && cur.fp === fp && !force) {
            if (cur.token) return cur.token;
            if (Date.now() - cur.at < LOGIN_RETRY_MS) return null; // recent failure: browse anonymously
        }
        const result = await login(req, apiBase, email, appPassword, req._cvSignal).catch(error => ({ ok: false, error: error?.message || String(error) }));
        sessions.set(key, { fp, token: result.ok ? result.token : null, user: result.user || null, error: result.ok ? null : result.error, at: Date.now() });
        if (!result.ok) ctx.debugLog?.(req, 'CharaVault login failed:', result.error);
        return result.ok ? result.token : null;
    };

    const upstream = async (req, subPath, accept = 'application/json') => {
        const { apiBase } = resolveCvBases(req, ctx);
        const target = await assertSafeUpstreamUrl(apiBase + subPath, { multiUser: !!ctx.multiUser });
        const send = (sessionToken) => doFetch(target, {
            method: 'GET',
            headers: buildUpstreamHeaders(req, ctx, accept, { includeAuth: true, sessionToken }),
            signal: req._cvSignal,
        });
        const token = await sessionFor(req);
        const response = await send(token);
        if (response.status === 401 && token) {
            // the session was revoked or expired: log in again once
            await response.body?.cancel().catch(() => {});
            return send(await sessionFor(req, { force: true }));
        }
        return response;
    };

    const upstreamCdn = async (req, subPath, accept = 'image/webp,image/png,image/*,*/*;q=0.8') => {
        const { apiBase, cdnBase } = resolveCvBases(req, ctx);
        const target = await assertSafeUpstreamUrl(cdnBase + subPath, { multiUser: !!ctx.multiUser });
        // the session rides only to the API's own host (NSFW thumbnails are blurred without it),
        // never to a separately configured CDN host
        const sameHost = new URL(target).hostname === new URL(apiBase).hostname;
        const token = sameHost ? await sessionFor(req) : null;
        return doFetch(target, {
            method: 'GET',
            headers: buildUpstreamHeaders(req, ctx, accept, { includeAuth: !!token, sessionToken: token }),
            signal: req._cvSignal,
        });
    };

    const relayJson = async (res, response) => {
        const text = await readTextCapped(response, MAX_JSON_BYTES);
        setSafeHeaders(res);
        const ct = (response.headers.get('content-type') || '').toLowerCase();
        if (!response.ok && ct.includes('text/html')) {
            res.status(response.status).set('Content-Type', 'text/plain; charset=utf-8').send(text);
            return null;
        }
        let body;
        try {
            body = text ? JSON.parse(text) : {};
        } catch {
            if (!response.ok) {
                res.status(response.status).set('Content-Type', 'text/plain; charset=utf-8').send(text || `Upstream HTTP ${response.status}`);
                return null;
            }
            throw httpError(502, 'Upstream returned invalid JSON');
        }
        res.status(response.status).json(body);
        return body;
    };

    const cardPath = (req) => {
        const { folder, file } = splitFullPath(req.params?.folder ?? req.query.folder, req.params?.file ?? req.query.file, req.query.fullPath);
        return `${encodeURIComponent(folder)}/${encodeURIComponent(file)}`;
    };

    const detail = async (req, res) => {
        await relayJson(res, await upstream(req, '/cards/' + cardPath(req)));
    };
    const linked = async (req, res) => {
        await relayJson(res, await upstream(req, '/cards/' + cardPath(req) + '/lorebooks'));
    };
    // a card PNG (the current file or one revision of it): raster or octet-stream only, capped
    const relayCardImage = async (res, response) => {
        if (!response.ok) {
            res.set('Cache-Control', 'no-store');
            await relayJson(res, response);
            return;
        }
        const ct = (response.headers.get('content-type') || 'image/png').toLowerCase();
        if ((!ct.startsWith('image/') || ct.includes('svg')) && !ct.startsWith('application/octet-stream')) {
            throw httpError(502, 'Upstream did not return a card image');
        }
        const buf = await readBodyCapped(response, MAX_BINARY_BYTES);
        setSafeHeaders(res);
        res.status(200);
        res.set('Content-Type', ct.startsWith('image/') ? ct : 'image/png');
        res.send(buf);
    };
    const download = async (req, res) => {
        await relayCardImage(res, await upstream(req, '/cards/download/' + cardPath(req), 'image/png,image/*,*/*;q=0.8'));
    };
    // ?path=folder/file, the form charavault.net's own revision and favorite endpoints take
    const pathParam = (req) => {
        const { folder, file } = splitFullPath(undefined, undefined, req.query.path);
        return encodeURIComponent(`${folder}/${file}`);
    };
    const thumb =async (req, res) => {
        const response = await upstreamCdn(req, '/cards/thumb/' + cardPath(req));
        if (!response.ok) {
            res.set('Cache-Control', 'no-store');
            await relayJson(res, response);
            return;
        }
        const ct = (response.headers.get('content-type') || 'image/webp').toLowerCase();
        if (!ct.startsWith('image/') || ct.includes('svg')) {
            throw httpError(502, 'Upstream did not return a raster thumbnail');
        }
        const buf = await readBodyCapped(response, MAX_BINARY_BYTES);
        setSafeHeaders(res);
        res.status(200);
        res.set('Content-Type', ct);
        res.set('Cache-Control', 'private, max-age=604800');
        res.send(buf);
    };

    route('/cards', async (req, res) => {
        const qs = queryString(req.query, ['q', 'tags', 'exclude_tags', 'nsfw', 'creator', 'folder', 'has_book', 'token_min', 'token_max', 'sort', 'limit', 'offset']);
        await relayJson(res, await upstream(req, '/cards' + (qs ? `?${qs}` : '')));
    });
    route('/cards/rating', async (req, res) => {
        const p = String(req.query.path || '').trim();
        if (!p || p.includes('\0') || p.split('/').includes('..')) throw httpError(400, 'Invalid card path');
        await relayJson(res, await upstream(req, '/cards/rating?path=' + encodeURIComponent(p)));
    });
    route('/cards/similar', async (req, res) => {
        const p = String(req.query.path || '').trim();
        if (!p || p.includes('\0') || p.split('/').includes('..')) throw httpError(400, 'Invalid card path');
        const qs = queryString(req.query, ['path', 'folder', 'file', 'threshold']);
        await relayJson(res, await upstream(req, '/cards/similar?' + qs));
    });
    // version history: the card's revisions, and one revision's card PNG
    route('/cards/revisions', async (req, res) => {
        await relayJson(res, await upstream(req, '/cards/revisions?path=' + pathParam(req)));
    });
    route('/cards/revision-file', async (req, res) => {
        const id = String(req.query.id || '').trim();
        if (!/^\d{1,12}$/.test(id)) throw httpError(400, 'Invalid revision id');
        await relayCardImage(res, await upstream(req, `/cards/revision-file?path=${pathParam(req)}&id=${id}`, 'image/png,image/*,*/*;q=0.8'));
    });
    route('/cards/detail', detail);
    route('/cards/lorebooks', linked);
    route('/cards/download', download);
    route('/cards/download/:folder/:file', download);
    route('/cards/:folder/:file/lorebooks', linked);
    route('/cards/:folder/:file', detail);
    route('/thumb', thumb);
    route('/thumb/:folder/:file', thumb);
    route('/favicon.ico', async (req, res) => {
        try {
            const response = await upstreamCdn(req, '/favicon.ico', 'image/*,*/*;q=0.8');
            const ct = (response.headers.get('content-type') || 'image/x-icon').toLowerCase();
            if (response.ok && (ct.startsWith('image/') || ct === 'application/octet-stream') && !ct.includes('svg')) {
                const buf = await readBodyCapped(response, 1024 * 1024);
                setSafeHeaders(res);
                res.status(200);
                res.set('Content-Type', ct.startsWith('image/') ? ct : 'image/x-icon');
                res.set('Cache-Control', 'private, max-age=86400');
                return res.send(buf);
            }
        } catch { /* Fall back to local SVG vault icon when upstream favicon is unavailable */ }
        setSafeHeaders(res);
        res.status(200);
        res.set('Content-Type', 'image/svg+xml');
        res.set('Cache-Control', 'private, max-age=86400');
        res.send(FALLBACK_ICON);
    });
    route('/tags', async (req, res) => {
        const q = String(req.query.q || '').trim();
        const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || '100', 10) || 100));
        if (req.query.full !== '1') {
            try {
                const response = await upstream(req, `/tags/search?q=${encodeURIComponent(q)}&limit=${limit}`);
                if (response.ok) {
                    const text = await readTextCapped(response, MAX_JSON_BYTES);
                    const data = JSON.parse(text);
                    setSafeHeaders(res);
                    return res.status(200).json({ tags: data.tags || [] });
                }
                await response.body?.cancel().catch(() => {});
            } catch { /* Fall back to full /tags index */ }
        }
        let response;
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                response = await upstream(req, '/tags');
                if (response.status < 500 || attempt === 2) break;
                await response.body?.cancel().catch(() => {});
            } catch (error) {
                if (attempt === 2) throw error;
            }
        }
        if (!response.ok) {
            await relayJson(res, response);
            return;
        }
        const text = await readTextCapped(response, MAX_JSON_BYTES);
        let data;
        try { data = JSON.parse(text); } catch { throw httpError(502, 'Upstream returned invalid JSON'); }
        if (q && Array.isArray(data.tags)) {
            const needle = q.toLowerCase();
            data.tags = data.tags.filter(tag => String(Array.isArray(tag) ? tag[0] : tag?.name ?? tag).toLowerCase().includes(needle)).slice(0, limit);
        }
        setSafeHeaders(res);
        res.status(200).json(data);
    });
    route('/lorebooks', async (req, res) => {
        const qs = queryString(req.query, ['q', 'topics', 'creator', 'nsfw', 'limit', 'offset']);
        const response = await upstream(req, '/lorebooks' + (qs ? `?${qs}` : ''));
        if (!response.ok) {
            await relayJson(res, response);
            return;
        }
        const text = await readTextCapped(response, MAX_JSON_BYTES);
        let data;
        try { data = JSON.parse(text); } catch { throw httpError(502, 'Upstream returned invalid JSON'); }
        const sort = req.query.sort;
        if (Array.isArray(data.lorebooks) && ['entries_desc', 'tokens_desc', 'newest'].includes(sort)) {
            const value = sort === 'entries_desc'
                ? lb => Number(lb.entry_count) || 0
                : sort === 'tokens_desc'
                    ? lb => Number(lb.token_count) || 0
                    : lb => Date.parse(lb.indexed_at) || 0;
            data.lorebooks = [...data.lorebooks].sort((a, b) => value(b) - value(a));
        }
        setSafeHeaders(res);
        res.status(200).json(data);
    });
    route('/lorebooks/topics', async (req, res) => {
        await relayJson(res, await upstream(req, '/lorebooks/topics'));
    });
    route('/lorebooks/:id', async (req, res) => {
        const id = String(req.params.id || '').trim();
        if (!/^\d{1,12}$/.test(id)) throw httpError(400, 'Invalid lorebook id');
        await relayJson(res, await upstream(req, '/lorebooks/' + encodeURIComponent(id)));
    });

    // the settings checkmark: logs in with the typed (or saved) email + app password
    router.post('/auth/check', async (req, res) => {
        const { ctrl, signal } = makeSignal(res);
        setSafeHeaders(res);
        res.set('Cache-Control', 'no-store');
        try {
            const saved = readCredentials(req, ctx);
            const body = req.body && typeof req.body === 'object' ? req.body : {};
            const email = String(body.email ?? saved.email ?? '').trim().slice(0, 320);
            const appPassword = cleanSecret(body.appPassword ?? saved.appPassword).slice(0, 256);
            if (saved.gatewayKey) {
                return res.json({ ok: false, error: 'A gateway key is set: the gateway logs in for you, so there is nothing to check here' });
            }
            if (!email || !appPassword) return res.json({ ok: false, error: 'Enter your CharaVault email and an App Password (cv_...)' });
            if (!/^cv_/i.test(appPassword)) {
                return res.json({ ok: false, error: 'That is not an App Password: create one under Account > App Passwords (it starts with cv_)' });
            }
            const { apiBase } = resolveCvBases(req, ctx);
            const result = await login(req, apiBase, email, appPassword, signal);
            if (!result.ok) return res.json({ ok: false, status: result.status, error: result.error });
            // a check of the saved values primes the session the proxy uses
            if (email === saved.email && appPassword === saved.appPassword) {
                const fp = crypto.createHash('sha256').update(apiBase + '\n' + email.toLowerCase() + '\n' + appPassword).digest('hex');
                sessions.set(sessionKey(req), { fp, token: result.token, user: result.user, error: null, at: Date.now() });
            }
            const user = result.user || {};
            res.json({
                ok: true,
                name: String(user.display_name || user.username || email),
                nsfwVerified: !!user.nsfw_verified,
            });
        } catch (error) {
            if (ctrl.signal.aborted) return;
            res.json({ ok: false, error: error?.message || 'Could not reach CharaVault' });
        }
    });
}
