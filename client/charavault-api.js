import CoreAPI from '/modules/core-api.js';
import { readJsonClassified, httpFailureError } from '/modules/providers/provider-utils.js';

export const CV_SORTS = Object.freeze([
    { value: 'most_downloaded', label: 'Most Downloaded' },
    { value: 'top_rated', label: 'Top Rated' },
    { value: 'newest', label: 'Newest' },
    { value: 'oldest', label: 'Oldest' },
    { value: 'name_asc', label: 'Name A-Z' },
    { value: 'name_desc', label: 'Name Z-A' },
    { value: 'creator_asc', label: 'Creator A-Z' },
    { value: 'token_count_desc', label: 'Most Tokens' },
    { value: 'token_count_asc', label: 'Fewest Tokens' },
    { value: 'most_commented', label: 'Most Commented' },
].map(Object.freeze));

const FOLDER_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidCvSegment(file) {
    if (typeof file !== 'string') return false;
    const s = file.trim();
    if (!s || s.length > 255 || s === '.' || s === '..') return false;
    if (/[\\/\0]/.test(s) || s.includes('..')) return false;
    return true;
}

export function isValidCvPath(fullPath) {
    const raw = String(fullPath || '').trim();
    if (!raw || raw.startsWith('/') || raw.includes('\\') || raw.includes('\0')) return false;
    const parts = raw.split('/');
    if (parts.length === 1) return isValidCvSegment(parts[0]);
    if (parts.length === 2) return FOLDER_RE.test(parts[0]) && isValidCvSegment(parts[1]);
    return false;
}

let dependencies = {};
export function initCvApi(deps = {}) {
    dependencies = deps;
    cvMetadataCache.clear();
}
export function getCvApiBase() { return '/ext/charavault'; }
// Credentials stay on the server; apiRequest supplies the Project Σ session.
export function getCvHeaders() { return { Accept: 'application/json' }; }
function serverUrl(p) { return typeof CoreAPI?.serverUrl === 'function' ? CoreAPI.serverUrl(p) : p; }
// `a` keys the browser cache to the login state: thumbnails cached blurred while logged out must not stick
function cvAuthTag() {
    const get = dependencies.getSetting;
    if (typeof get !== 'function') return '0';
    return get('email') && get('appPassword') ? '1' : '0';
}
export function cvThumbUrl(folder, file) { return serverUrl('/api/ext/charavault/thumb/' + encodeURIComponent(folder) + '/' + encodeURIComponent(file) + '?a=' + cvAuthTag()); }
// charavault.net has no page per card (cards open in a popup on its homepage), so a card's link is its PNG:
// /cards/<folder>/<file> serves the card file, parseUrl() reads it back, and 18+ cards need a logged-in browser
export function cvCardUrl(folder, file) { return 'https://charavault.net/cards/' + encodeURIComponent(folder) + '/' + encodeURIComponent(file); }
export function cvFullPath(folder, file) { return `${folder}/${file}`; }
export function splitCvPath(fullPath) {
    const path = String(fullPath || '');
    const slash = path.indexOf('/');
    return slash < 0 ? { folder: 'cards', file: path } : { folder: path.slice(0, slash), file: path.slice(slash + 1) };
}
export const cvMetadataCache = new Map();
const CV_METADATA_CACHE_MAX = 20;
const CV_CACHE_TTL = 10 * 60 * 1000;

function paramsQuery(params) {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) qs.set(key, Array.isArray(value) ? value.join(',') : String(value));
    }
    return qs.toString();
}
function request(path, signal = null, accept = null) {
    const api = dependencies.CoreAPI || CoreAPI;
    const apiRequest = dependencies.apiRequest || api.apiRequest?.bind(api);
    const headers = accept ? { ...getCvHeaders(), Accept: accept } : getCvHeaders();
    if (typeof apiRequest !== 'function') throw new Error('Project Σ apiRequest is unavailable');
    return apiRequest(getCvApiBase() + path, 'GET', null, { headers, signal });
}
async function requestJson(path, signal) { return readJsonClassified(await request(path, signal)); }

/**
 * CharaVault's full_metadata arrives in two shapes: a V2/V3 card ({spec, data:{...}}) or a flat
 * V1 card whose fields sit at the top level (e.g. nsfwaichat/2B). Always answer { data: {...} }.
 */
export function normalizeCvFullMetadata(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data)) return raw;
    return { spec: raw.spec || 'chara_card_v1', data: raw };
}

/**
 * Check CharaVault credentials. Uses the typed values when given, the saved ones otherwise.
 * Answers { ok, name, nsfwVerified, error }.
 */
export async function checkCvLogin({ email, appPassword } = {}) {
    const api = dependencies.CoreAPI || CoreAPI;
    const apiRequest = dependencies.apiRequest || api.apiRequest?.bind(api);
    if (typeof apiRequest !== 'function') throw new Error('Project Σ apiRequest is unavailable');
    const body = {};
    if (email) body.email = email;
    if (appPassword) body.appPassword = appPassword;
    const resp = await apiRequest(getCvApiBase() + '/auth/check', 'POST', body, { headers: { Accept: 'application/json' } });
    let data = null;
    try { data = await resp.json(); } catch { /* fall through */ }
    if (!data || typeof data !== 'object') return { ok: false, error: `HTTP ${resp.status}` };
    return data;
}
export async function fetchCvCardPngBuffer(folder, file, { signal = null } = {}) {
    const resp = await request('/cards/download/' + encodeURIComponent(folder) + '/' + encodeURIComponent(file), signal, 'image/png,image/*,*/*;q=0.8');
    if (!resp.ok) return null;
    return await resp.arrayBuffer();
}
export async function fetchCvThumbBuffer(folder, file, { signal = null } = {}) {
    const resp = await request('/thumb/' + encodeURIComponent(folder) + '/' + encodeURIComponent(file), signal, 'image/webp,image/png,image/*,*/*;q=0.8');
    if (!resp.ok) return null;
    return await resp.arrayBuffer();
}
export async function fetchCvCards(params = {}) {
    const { signal = null, ...query } = params;
    return requestJson('/cards?' + paramsQuery(query), signal);
}
export async function fetchCvCardDetail(fullPath, { strict = false, signal = null } = {}) {
    if (signal?.aborted) throw signal.reason || new DOMException('Cancelled', 'AbortError');
    if (!isValidCvPath(fullPath)) {
        if (strict) throw new Error('Invalid CharaVault card path');
        return null;
    }
    const cached = cvMetadataCache.get(fullPath);
    if (cached) {
        const entry = cached.value ? cached.value : cached;
        const fresh = !cached.time || (Date.now() - cached.time < CV_CACHE_TTL);
        if (fresh) return entry;
        cvMetadataCache.delete(fullPath);
    }
    try {
        const data = await requestJson('/cards/detail?' + paramsQuery(splitCvPath(fullPath)), signal);
        const detail = { entry: data.entry || null, fullMetadata: normalizeCvFullMetadata(data.full_metadata), recommendations: data.recommendations || null };
        while (cvMetadataCache.size >= CV_METADATA_CACHE_MAX) {
            const firstKey = cvMetadataCache.keys().next().value;
            cvMetadataCache.delete(firstKey);
        }
        cvMetadataCache.set(fullPath, { value: detail, time: Date.now() });
        return detail;
    } catch (error) {
        if (strict || signal?.aborted || error?.name === 'AbortError') throw error;
        return null;
    }
}
export async function fetchCvRating(fullPath, { strict = false, signal = null } = {}) {
    try {
        return await requestJson('/cards/rating?path=' + encodeURIComponent(fullPath), signal);
    } catch (error) {
        if (strict || signal?.aborted || error?.name === 'AbortError') throw error;
        return null;
    }
}
export async function fetchCvLinkedLorebooks(fullPath, { strict = false, signal = null } = {}) {
    try {
        return await requestJson('/cards/lorebooks?' + paramsQuery(splitCvPath(fullPath)), signal);
    } catch (error) {
        if (strict || signal?.aborted || error?.name === 'AbortError') throw error;
        return null;
    }
}
export async function fetchCvSimilar(target, threshold = 20, { signal = null } = {}) {
    const input = typeof target === 'string' ? { path: target } : target || {};
    // CharaVault's /api/cards/similar requires the entry.path value (diskPath), not a synthetic folder/file fallback
    const path = String(input.path || '').trim();
    if (!path) return { ok: false, reason: 'no_path', results: [] };
    try {
        const response = await request('/cards/similar?' + paramsQuery({ path, folder: input.folder, file: input.file, threshold }), signal);
        if (response.status === 404) {
            return { ok: false, reason: 'no_hash', results: [] };
        }
        if (!response.ok) {
            const text = await response.text().catch(() => '');
            const noHash = /no[_\s-]?hash|(?:hash.*(?:missing|not found|unavailable))|(?:source card not found)|(?:no.*hash)/i.test(text);
            return { ok: false, reason: noHash ? 'no_hash' : 'http', status: response.status, error: httpFailureError(response.status, text), results: [] };
        }
        const data = await readJsonClassified(response);
        if (data.reason === 'no_hash' || data.no_hash || /no[_\s-]?hash|no.*hash/i.test(String(data.error || data.message || ''))) {
            return { ok: false, reason: 'no_hash', results: [] };
        }
        if (data.ok === false || data.error) return { ok: false, reason: 'error', error: data.error || data.reason, results: [] };
        const results = data.similar || data.results || (Array.isArray(data) ? data : []);
        return { ok: true, results: Array.isArray(results) ? results : [] };
    } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') throw error;
        return { ok: false, reason: 'error', error, results: [] };
    }
}
export async function fetchCvTags(query = '', limit = 100, { signal = null } = {}) {
    const data = await requestJson('/tags?' + paramsQuery({ q: query, limit }), signal);
    const tags = data?.tags || [];
    if (Array.isArray(tags)) return tags.map(tag => Array.isArray(tag) ? [String(tag[0]), Number(tag[1]) || 0] : typeof tag === 'object' && tag ? [String(tag.name ?? tag.tag ?? ''), Number(tag.count) || 0] : [String(tag), 0]);
    return Object.entries(tags).map(([name, count]) => [name, Number(count) || 0]);
}
export async function fetchCvLorebooks({ q = '', topics = '', creator = '', nsfw = false, limit = 48, offset = 0, sort = 'default', signal = null } = {}) {
    return requestJson('/lorebooks?' + paramsQuery({ q, topics, creator, nsfw, limit, offset, sort }), signal);
}
export async function fetchCvLorebookDetail(id, { signal = null } = {}) {
    return requestJson('/lorebooks/' + encodeURIComponent(id), signal);
}

const objectOrEmpty = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const keyArray = value => Array.isArray(value) ? value.map(String) : typeof value === 'string' ? value.split(',').map(s => s.trim()).filter(Boolean) : [];
const finiteNumber = (value, fallback) => value !== null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : fallback;

// Map both V2 character_book entries and SillyTavern world-format entries cleanly so convertCharacterBookToNative preserves all fields
const WORLD_TO_EXT_MAP = [
    ['vectorized', 'vectorized'],
    ['selectiveLogic', 'selectiveLogic'],
    ['ignoreBudget', 'ignore_budget'],
    ['excludeRecursion', 'exclude_recursion'],
    ['preventRecursion', 'prevent_recursion'],
    ['matchPersonaDescription', 'match_persona_description'],
    ['matchCharacterDescription', 'match_character_description'],
    ['matchCharacterPersonality', 'match_character_personality'],
    ['matchCharacterDepthPrompt', 'match_character_depth_prompt'],
    ['matchScenario', 'match_scenario'],
    ['matchCreatorNotes', 'match_creator_notes'],
    ['delayUntilRecursion', 'delay_until_recursion'],
    ['probability', 'probability'],
    ['useProbability', 'useProbability'],
    ['depth', 'depth'],
    ['outletName', 'outlet_name'],
    ['group', 'group'],
    ['groupOverride', 'group_override'],
    ['groupWeight', 'group_weight'],
    ['scanDepth', 'scan_depth'],
    ['caseSensitive', 'case_sensitive'],
    ['matchWholeWords', 'match_whole_words'],
    ['useGroupScoring', 'use_group_scoring'],
    ['automationId', 'automation_id'],
    ['role', 'role'],
    ['sticky', 'sticky'],
    ['cooldown', 'cooldown'],
    ['delay', 'delay'],
    ['triggers', 'triggers'],
    ['displayIndex', 'display_index'],
];

export function normalizeCvCharacterBook(rawBook, fallbackName = '') {
    let book = rawBook?.content || rawBook?.full_data || rawBook?.book || rawBook;
    if (typeof book === 'string') {
        try { book = JSON.parse(book); } catch { book = {}; }
    }
    book = objectOrEmpty(book);
    const source = Array.isArray(book.entries) ? book.entries : Object.values(objectOrEmpty(book.entries));
    return {
        name: String(book.name || fallbackName || ''),
        description: String(book.description || ''),
        scan_depth: finiteNumber(book.scan_depth ?? book.scanDepth, 2),
        token_budget: finiteNumber(book.token_budget ?? book.tokenBudget, 512),
        recursive_scanning: Boolean(book.recursive_scanning ?? book.recursiveScanning ?? false),
        extensions: { ...objectOrEmpty(book.extensions) },
        entries: source.filter(e => e && typeof e === 'object').map((entry, i) => {
            const rawExt = objectOrEmpty(entry.extensions);
            const extensions = { ...rawExt };
            for (const [worldKey, extKey] of WORLD_TO_EXT_MAP) {
                if (extensions[extKey] === undefined && entry[worldKey] !== undefined) {
                    extensions[extKey] = entry[worldKey];
                }
            }
            if (extensions.probability === undefined) extensions.probability = 100;
            if (extensions.selectiveLogic === undefined) extensions.selectiveLogic = 0;

            let v2Position = 'before_char';
            if (typeof entry.position === 'number' && Number.isFinite(entry.position)) {
                if (extensions.position === undefined) extensions.position = entry.position;
                v2Position = entry.position === 0 ? 'before_char' : 'after_char';
            } else if (entry.position === 'after_char') {
                v2Position = 'after_char';
                if (extensions.position === undefined) extensions.position = 1;
            } else if (entry.position === 'before_char' || entry.position === '' || entry.position == null) {
                v2Position = 'before_char';
                if (extensions.position === undefined) extensions.position = 0;
            }

            return {
                ...entry,
                id: finiteNumber(entry.id ?? entry.uid, i + 1),
                keys: keyArray(entry.keys ?? entry.key),
                secondary_keys: keyArray(entry.secondary_keys ?? entry.keysecondary),
                comment: String(entry.comment ?? entry.name ?? ''),
                name: String(entry.name ?? entry.comment ?? ''),
                content: String(entry.content ?? ''),
                constant: Boolean(entry.constant),
                selective: entry.selective !== undefined ? Boolean(entry.selective) : true,
                insertion_order: finiteNumber(entry.insertion_order ?? entry.order, i),
                enabled: entry.enabled !== undefined ? Boolean(entry.enabled) : !entry.disable,
                position: v2Position,
                extensions,
            };
        }),
    };
}
export async function resolveCvCharacterBook(fullPath, detail, { missing = null } = {}) {
    const addMissing = (item) => {
        if (Array.isArray(missing) && !missing.includes(item)) missing.push(item);
    };
    const embedded = detail?.fullMetadata?.data?.character_book ? normalizeCvCharacterBook(detail.fullMetadata.data.character_book, detail?.entry?.name) : undefined;
    const entries = [...(embedded?.entries || [])];
    let firstLinked;
    let linked;
    try { linked = await fetchCvLinkedLorebooks(fullPath, { strict: true }); }
    catch (err) {
        if (err?.status !== 404 && (detail?.entry?.has_lorebook || detail?.has_lorebook)) {
            addMissing('its linked lorebook');
        }
    }
    for (const lb of linked?.lorebooks || []) {
        if (lb.source === 'embedded' && embedded?.entries?.length > 0) continue;
        try {
            const book = normalizeCvCharacterBook(await fetchCvLorebookDetail(lb.id), lb.name || detail?.entry?.name);
            firstLinked ||= book;
            entries.push(...book.entries.map(e => ({ ...e, extensions: { ...e.extensions, linked: true, embedded: false } })));
        } catch {
            if (lb.source !== 'embedded') addMissing('its linked lorebook');
        }
    }
    return entries.length ? { ...(embedded || firstLinked), entries: entries.map((e, i) => ({ ...e, id: i + 1 })) } : undefined;
}
export function stripForeignProviderNamespaces(card) {
    const extensions = card?.data?.extensions;
    if (!extensions || typeof extensions !== 'object') return card;
    const providers = new Set(['chub', 'janitorai', 'jannyai', 'chartavern', 'pygmalion', 'wyvern', 'datacat', 'botbooru', 'risu-realm']);
    const manifest = globalThis.window?.PROVIDER_MANIFEST || {};
    for (const [key, row] of Object.entries(manifest)) {
        providers.add(key);
        if (row?.extNamespace) providers.add(row.extNamespace);
        if (row?.id) providers.add(row.id);
    }
    for (const key of providers) if (key !== 'charavault') delete extensions[key];
    return card;
}
export function buildCvCharacterCard(detail, fullPath, searchEntry = null, characterBook = undefined) {
    const entry = detail?.entry || searchEntry || {};
    const metaData = objectOrEmpty(detail?.fullMetadata?.data);
    const name = String(metaData.name || entry.name || searchEntry?.name || 'Untitled');
    const card = {
        spec: 'chara_card_v2', spec_version: '2.0',
        data: {
            ...metaData,
            name,
            description: metaData.description ?? entry.description ?? '',
            personality: metaData.personality ?? entry.personality ?? '',
            scenario: metaData.scenario ?? entry.scenario ?? '',
            first_mes: metaData.first_mes ?? entry.first_mes ?? '',
            mes_example: metaData.mes_example ?? entry.mes_example ?? '',
            creator_notes: metaData.creator_notes ?? entry.creator_notes ?? '',
            system_prompt: metaData.system_prompt ?? '',
            post_history_instructions: metaData.post_history_instructions ?? '',
            alternate_greetings: Array.isArray(metaData.alternate_greetings) ? [...metaData.alternate_greetings] : [],
            tags: Array.isArray(metaData.tags) ? [...metaData.tags] : Array.isArray(entry.tags) ? [...entry.tags] : [],
            creator: metaData.creator || entry.creator || '',
            character_version: metaData.character_version || '',
            extensions: { ...objectOrEmpty(metaData.extensions) },
            character_book: characterBook || (metaData.character_book ? normalizeCvCharacterBook(metaData.character_book, name) : undefined),
        },
    };
    stripForeignProviderNamespaces(card);
    card.data.extensions.charavault = {
        id: fullPath, full_path: fullPath, fullPath,
        content_hash: entry.content_hash || '',
        avg_rating: entry.avg_rating || 0,
        rating_count: entry.rating_count || 0,
        download_count: entry.download_count ?? searchEntry?.download_count ?? 0,
        has_lorebook: Boolean((searchEntry?.has_lorebook ?? entry.has_lorebook) || characterBook?.entries?.length),
        card_style: entry.card_style ?? searchEntry?.card_style ?? null,
        recommended_tier: entry.recommended_tier ?? searchEntry?.recommended_tier ?? null,
        linkedAt: new Date().toISOString(),
    };
    return card;
}
