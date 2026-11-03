// CharaVault Provider - character source backed by charavault.net, ported and expanded from
// AdamsGH's CharaVault PR (Sillyanonymous/SillyTavern-CharacterLibrary#18).

import { ProviderBase } from '/modules/providers/provider-interface.js';
import { LorebookView } from '/modules/providers/lorebook-view.js';
import { importFromPng, nullOnMiss, parseProviderUrl, slugify } from '/modules/providers/provider-utils.js';
import charavaultBrowseView, { openCvPreview } from './charavault-browse.js';
import { charavaultLorebooks } from './charavault-lorebooks.js';
import {
    cvThumbUrl,
    cvCardUrl,
    cvFullPath,
    splitCvPath,
    isValidCvPath,
    cvMetadataCache,
    fetchCvCards,
    fetchCvCardDetail,
    fetchCvCardPngBuffer,
    fetchCvThumbBuffer,
    resolveCvCharacterBook,
    buildCvCharacterCard,
} from './charavault-api.js';

let api = null;

// Cached raw entry from the last fetchLinkStats() - reused by getCachedLinkNode() for "View on"
let _cachedLinkNode = null;

const charavaultLorebookView = new LorebookView(charavaultLorebooks);

class CharaVaultProvider extends ProviderBase {
    constructor() {
        super();
        charavaultBrowseView.provider = this;
    }

    // ── Identity ────────────────────────────────────────────

    get id() { return 'charavault'; }

    get browseView() { return charavaultBrowseView; }

    get lorebookView() { return charavaultLorebookView; }

    get linkStatFields() {
        return {
            stat1: { icon: 'fa-solid fa-star', label: 'Avg Rating' },
            stat2: { icon: 'fa-solid fa-cloud-arrow-down', label: 'Downloads' },
            stat3: { icon: 'fa-solid fa-coins', label: 'Tokens' },
        };
    }

    // ── Lifecycle ───────────────────────────────────────────

    async init(coreAPI) {
        await super.init(coreAPI);
        api = coreAPI;
        // Expose the import function for anything driving the preview modal by hand
        if (typeof globalThis.window !== 'undefined') {
            globalThis.window.cvImportCharacter = (fullPath, hitData, options) =>
                this.importCharacter(fullPath, hitData, options);
        }
    }

    // ── Character Linking ───────────────────────────────────

    readLink(ns) {
        const fullPath = ns?.fullPath || ns?.full_path || ns?.id;
        if (!fullPath || !isValidCvPath(fullPath)) return null;
        return { id: String(fullPath), fullPath: String(fullPath), linkedAt: ns.linkedAt || null };
    }

    writeLink(linkInfo, existing = {}) {
        const fullPath = linkInfo.fullPath || linkInfo.id || existing.full_path || existing.fullPath;
        return { ...existing, id: fullPath, full_path: fullPath, fullPath };
    }

    getCharacterUrl(linkInfo) {
        const fp = String(linkInfo?.fullPath || linkInfo?.id || '');
        if (!isValidCvPath(fp)) return null;
        const { folder, file } = splitCvPath(fp);
        if (!file) return null;
        return cvCardUrl(folder, file);
    }

    // ── In-App Preview ───────────────────────────────────────

    async buildPreviewObject(char, linkInfo) {
        const fullPath = linkInfo?.fullPath || linkInfo?.id;
        if (!fullPath || !isValidCvPath(fullPath)) return null;

        // the link modal's stats fetch already answered this entry; reuse it only if it matches fullPath
        const cachedMatches = _cachedLinkNode
            && cvFullPath(_cachedLinkNode.folder, _cachedLinkNode.file) === String(fullPath);
        const detail = (cachedMatches ? { entry: _cachedLinkNode } : null)
            || await fetchCvCardDetail(String(fullPath));
        const entry = detail?.entry || {};
        const { folder, file } = splitCvPath(String(fullPath));
        return {
            ...entry,
            fullPath: String(fullPath),
            folder,
            file,
            name: entry.name || char?.name || 'Unknown',
            creator: entry.creator || char?.data?.creator || '',
        };
    }

    openPreview(previewChar) {
        return openCvPreview(previewChar);
    }

    // ── Local Import Enrichment ──────────────────────────────

    localImportInfo(link) {
        return {
            providerId: 'charavault',
            charId: link.id || link.fullPath,
            fullPath: link.fullPath,
            hasGallery: false,
            avatarUrl: this.getResultAvatarUrl({ fullPath: link.fullPath }),
        };
    }

    // ── Remote Data ─────────────────────────────────────────

    async fetchMetadata(fullPath) {
        if (!fullPath) return null;
        try {
            const detail = await fetchCvCardDetail(String(fullPath));
            return detail?.entry || null;
        } catch (e) {
            api?.debugLog?.('[CharaVaultProvider] fetchMetadata:', e?.message || e);
            return null;
        }
    }

    async fetchRemoteCard(linkInfo) {
        const fullPath = linkInfo?.fullPath || linkInfo?.id;
        if (!fullPath || !isValidCvPath(fullPath)) return null;
        // nullOnMiss: a definitive 404/410 answers null (Removed/Private in the update check);
        // anything else throws so a live card is never misreported
        return nullOnMiss(async () => {
            const detail = await fetchCvCardDetail(String(fullPath), { strict: true });
            const missing = [];
            const characterBook = await resolveCvCharacterBook(String(fullPath), detail, { missing });
            const card = buildCvCharacterCard(detail, String(fullPath), null, characterBook);
            if (missing.length) card._lorebookUnread = true;
            card._listingName = this.getListingName(detail?.entry);
            return card;
        });
    }

    async fetchLorebook(linkInfo) {
        const fullPath = linkInfo?.fullPath || linkInfo?.id;
        if (!fullPath) return null;
        try {
            const detail = await fetchCvCardDetail(String(fullPath));
            return (await resolveCvCharacterBook(String(fullPath), detail)) || null;
        } catch (e) {
            api?.debugLog?.('[CharaVaultProvider] fetchLorebook:', e?.message || e);
            return null;
        }
    }

    async fetchLinkStats(linkInfo) {
        const fullPath = linkInfo?.fullPath || linkInfo?.id;
        if (!fullPath) return null;
        try {
            const detail = await fetchCvCardDetail(String(fullPath));
            const entry = detail?.entry;
            if (!entry) return null;
            _cachedLinkNode = entry;
            return {
                stat1: entry.avg_rating ? Number(entry.avg_rating.toFixed(1)) : 0,
                stat2: entry.download_count || 0,
                stat3: entry.token_count || 0,
            };
        } catch (e) {
            api?.debugLog?.('[CharaVaultProvider] fetchLinkStats:', e?.message || e);
            return null;
        }
    }

    getCachedLinkNode() { return _cachedLinkNode; }

    clearCachedLinkNode() { _cachedLinkNode = null; }

    // ── URL Handling ────────────────────────────────────────

    parseUrl(url) {
        const u = parseProviderUrl(url);
        if (!u) return null;
        // Paths: /cards/{folder}/{file}, /cards/preview/... , /cards/thumb/... , /cards/download/...
        const match = u.pathname.match(/\/cards(?:\/(?:preview|thumb|download))?\/([^/]+)\/(.+)/);
        if (!match) return null;
        try {
            const fp = cvFullPath(decodeURIComponent(match[1]), decodeURIComponent(match[2]));
            return isValidCvPath(fp) ? fp : null;
        } catch {
            return null;
        }
    }

    // ── Bulk Linking ────────────────────────────────────────

    async searchForBulkLink(name, creator) {
        try {
            const results = [];

            // Creator-filtered search first when available (most precise)
            if (creator && String(creator).trim()) {
                const creatorData = await fetchCvCards({
                    creator: String(creator).trim(),
                    q: name,
                    limit: 20,
                    sort: 'most_downloaded',
                });
                for (const r of (creatorData?.results || [])) {
                    r.fullPath = cvFullPath(r.folder, r.file);
                    results.push(this._normalizeSearchResult(r));
                }
                if (results.length > 0) return results;
            }

            // Name-only fallback
            const data = await fetchCvCards({ q: name, limit: 15, sort: 'most_downloaded' });
            for (const r of (data?.results || [])) {
                r.fullPath = cvFullPath(r.folder, r.file);
                if (!results.some(x => x.fullPath === r.fullPath)) {
                    results.push(this._normalizeSearchResult(r));
                }
            }
            return results;
        } catch (e) {
            api?.debugLog?.('[CharaVaultProvider] searchForBulkLink:', e?.message || e);
            return [];
        }
    }

    getResultAvatarUrl(result) {
        const fp = result?.fullPath || '';
        const slash = fp.indexOf('/');
        if (slash < 0) return '';
        return cvThumbUrl(fp.slice(0, slash), fp.slice(slash + 1));
    }

    // ── Import Pipeline ─────────────────────────────────────

    /**
     * Import a character from CharaVault by fullPath ("cards/File_123.png").
     * The CDN PNG carries the embedded V2 card; the detail API's full_metadata and the
     * linked lorebook are merged in, then the card is re-embedded and imported.
     */
    async importCharacter(fullPath, hitData, options = {}) {
        try {
            if (!fullPath) throw new Error('No CharaVault path given');
            const detail = await fetchCvCardDetail(fullPath, { strict: true });
            if (!detail) throw new Error('Could not fetch character metadata');

            // hitData is the browse-list row: it carries has_lorebook, which the detail
            // entry lacks; { missing } collects what the linked lorebook fetch could not get
            const missing = [];
            const characterBook = await resolveCvCharacterBook(fullPath, detail, { missing });
            const characterCard = buildCvCharacterCard(detail, fullPath, hitData, characterBook);
            this.setLinkInfo(characterCard, {
                id: fullPath,
                fullPath,
                pageName: this.getListingName(detail.entry || hitData),
            });

            const characterName = characterCard.data?.name
                || String(fullPath).split('/').pop().replace(/\.png$/i, '')
                || 'Character';

            const { folder, file } = splitCvPath(fullPath);
            let imageBuffer = null;

            // Full PNG download first (it embeds the card file itself)
            try {
                imageBuffer = await fetchCvCardPngBuffer(folder, file);
            } catch (e) {
                api?.debugLog?.('[CharaVaultProvider] PNG download:', e?.message || e);
            }

            // Thumbnail fallback when the download route refused
            if (!imageBuffer) {
                try {
                    imageBuffer = await fetchCvThumbBuffer(folder, file);
                } catch (e) {
                    api?.debugLog?.('[CharaVaultProvider] thumb fallback:', e?.message || e);
                }
            }

            if (!imageBuffer) missing.push('its picture');

            // The cached detail is pre-import state; never let a later view read it as current
            cvMetadataCache.delete(fullPath);

            return await importFromPng({
                source: 'charavault',
                onExisting: options.onExisting,
                characterCard,
                imageBuffer,
                fileName: 'cv_' + slugify(characterName) + '.png',
                characterName,
                hasGallery: false,
                providerCharId: fullPath,
                fullPath,
                avatarUrl: cvThumbUrl(folder, file),
                missing,
                api: api || this._coreAPI,
            });
        } catch (e) {
            api?.debugLog?.('[CharaVaultProvider] importCharacter:', e?.message || e);
            return { success: false, error: e?.message || String(e) };
        }
    }

    // ── Import Duplicate Detection ──────────────────────────

    async searchForImportMatch(name, creator) {
        if (!name) return null;
        try {
            const results = await this.searchForBulkLink(name, creator || '');
            if (results.length === 0) return null;
            const norm = String(name).toLowerCase().trim();
            const exact = results.find(r => String(r.name || '').toLowerCase().trim() === norm);
            const hit = exact || results[0];
            return { id: hit.fullPath, fullPath: hit.fullPath, hasGallery: false };
        } catch (e) {
            api?.debugLog?.('[CharaVaultProvider] searchForImportMatch:', e?.message || e);
            return null;
        }
    }

    // ── Private ─────────────────────────────────────────────

    _normalizeSearchResult(r) {
        return {
            id: r.fullPath,
            fullPath: r.fullPath,
            name: r.name || r.file || '',
            avatarUrl: cvThumbUrl(r.folder || String(r.fullPath).split('/')[0], r.file || String(r.fullPath).split('/').pop()),
            rating: r.avg_rating || 0,
            starCount: r.rating_count || 0,
            description: r.description_preview || '',
            tagline: (r.tags || []).slice(0, 4).join(', '),
            nTokens: r.token_count || 0,
        };
    }
}

const charavaultProvider = new CharaVaultProvider();

export default charavaultProvider;
