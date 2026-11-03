// CharaVaultBrowseView - CharaVault browse/search UI for the Online tab, ported and expanded
// from AdamsGH's CharaVault PR (Sillyanonymous/SillyTavern-CharacterLibrary#18) onto Project Σ's
// BrowseView lifecycle (loadInitial / resetSessionState / hasData / rerenderGrid / probeHits).

import {
    BrowseView, featureFilterState, renderFeatureFilterItems, countActiveFeatures,
    activeFeatureRows, featurePasses, applyTagsClamp, cardTagsHtml,
    libraryFeatureRows, libraryBadgeHtml, libraryCardClass, renderAltGreetingsList,
} from '/modules/providers/browse-view.js';
import CoreAPI from '/modules/core-api.js';
import { importBookToShelf } from '/modules/lorebook-shelf.js';
import {
    IMG_PLACEHOLDER, BROWSE_PURIFY_CONFIG, formatNumber, skeletonLines, deferRender, deferCall,
    isMobileMode, renderBrowseError,
} from '/modules/providers/provider-utils.js';
import {
    CV_SORTS,
    cvThumbUrl,
    cvPreviewPageUrl,
    cvFullPath,
    splitCvPath,
    fetchCvCards,
    fetchCvCardDetail,
    fetchCvRating,
    fetchCvLinkedLorebooks,
    fetchCvSimilar,
    fetchCvTags,
    fetchCvLorebookDetail,
    normalizeCvCharacterBook,
} from './charavault-api.js';

const {
    onElement: on,
    showToast,
    escapeHtml,
    safePurify,
    formatRichText,
    debugLog,
    debounce,
    renderCreatorNotesSecure,
    cleanupCreatorNotesContainer,
    renderSkeletonGrid,
} = CoreAPI;

// ========================================
// STATE
// ========================================

let cvCharacters = [];
let cvCurrentPage = 0;        // offset = cvCurrentPage * PAGE_SIZE
let cvHasMore = true;
let cvIsLoading = false;
let cvLoadToken = 0;
let cvCurrentSearch = '';
let cvCurrentCreator = '';    // creator filter (drives the banner)
let cvSortMode = 'most_downloaded';
let cvNsfwMode = 'sfw';       // 'sfw' | 'nsfw' | 'any' (persisted)
let cvLorebookMode = 'any';   // 'any' | 'with' | 'without'
let cvSelectedChar = null;
let cvTagFilters = new Set(); // tag names to include
let cvGridRenderedCount = 0;
let cvDetailToken = 0;        // generation counter for the preview's async fills

const PAGE_SIZE = 48;
// a page the client filters thinned is topped up from the next ones until it reaches this
const MIN_PAGE_FILL = 24;
const MAX_TAG_AUTO_FETCHES = 3;

// Popular tags cache (live tag search refetches into it)
let cvPopularTags = [];

// The extension's own settings facade (ctx.settings), handed over by the entry point
let cvSettings = null;

let view; // module-scoped BrowseView instance reference (set once in the constructor)

// The Library rows of the Features dropdown; the lorebook tri-state rides beside them as radios
const CV_FEATURE_FILTERS = [
    ...libraryFeatureRows('cv', () => view, isCharPossibleMatchObj),
];
const cvFeatureState = featureFilterState(CV_FEATURE_FILTERS);
const CV_FILTER_SECTIONS = [{ key: 'library', title: 'Library:' }];

/** The extension's settings facade (ctx.settings), read for the NSFW choice. */
export function setCvSettings(settings) {
    cvSettings = settings || null;
}

// ========================================
// LOCAL LIBRARY LOOKUP
// ========================================

function isCharPossibleMatchObj(hit) {
    if (view.isHitInLibrary(hit)) return false;
    return view.isCharPossibleMatch(hit?.name || '', hit?.creator || '');
}

/** Light a grid card as in-library after an import landed outside the lane's own heal. */
export function markCvCardImported(fullPath) {
    const grid = document.getElementById('cvGrid');
    if (!grid || !fullPath) return;
    const card = grid.querySelector(`[data-full-path="${CSS.escape(fullPath)}"]`);
    if (!card) return;
    card.classList.add('in-library');
    card.classList.remove('possible-library');
    let badgesEl = card.querySelector('.browse-feature-badges');
    if (!badgesEl) {
        const imgWrap = card.querySelector('.browse-card-image');
        if (imgWrap) {
            imgWrap.insertAdjacentHTML('beforeend', '<div class="browse-feature-badges"></div>');
            badgesEl = imgWrap.querySelector('.browse-feature-badges');
        }
    }
    if (badgesEl) {
        badgesEl.querySelector('.possible-library')?.remove();
        if (!badgesEl.querySelector('.in-library')) {
            badgesEl.insertAdjacentHTML('afterbegin', '<span class="browse-feature-badge in-library" title="In Your Library"><i class="fa-solid fa-check"></i></span>');
        }
    }
}

// ========================================
// CARD RENDERING
// ========================================

function createCvCard(char) {
    const name = char.name || 'Unknown';
    const creator = char.creator || '';
    const thumbUrl = cvThumbUrl(char.folder, char.file);
    const inLibrary = view.isHitInLibrary(char);
    const possibleTier = inLibrary ? null : view.getPossibleMatchTier(name, creator);

    const tagline = char.description_preview ? String(char.description_preview).slice(0, 200) : '';
    const tokenNum = Number(char.token_count) || 0;
    const tokens = tokenNum > 0 ? escapeHtml(String(formatNumber(tokenNum))) : '';
    const avgNum = Number(char.avg_rating) || 0;
    const rating = avgNum > 0 ? escapeHtml(avgNum.toFixed(1)) : '';
    const ratingCount = Math.max(0, Math.trunc(Number(char.rating_count) || 0));
    const dlNum = Number(char.download_count) || 0;
    const downloads = dlNum > 0 ? escapeHtml(String(formatNumber(dlNum))) : '';

    // indexed_at is when CV's crawler picked the card up: the only date the API exposes
    const parsedIdx = char.indexed_at ? new Date(char.indexed_at) : null;
    const indexedDate = parsedIdx && !Number.isNaN(parsedIdx.getTime()) ? escapeHtml(parsedIdx.toLocaleDateString()) : '';

    const badges = [view.importingBadge(char)];
    const libraryBadge = libraryBadgeHtml(inLibrary, possibleTier);
    if (libraryBadge) badges.push(libraryBadge);
    if (char.has_lorebook) {
        badges.push('<span class="browse-feature-badge" title="Has Lorebook"><i class="fa-solid fa-book"></i></span>');
    }

    return `
        <div class="${libraryCardClass(inLibrary, possibleTier)}" data-cv-path="${escapeHtml(char.fullPath || '')}" data-full-path="${escapeHtml(char.fullPath || '')}"${view.linkKeyAttr(char)} data-match-name="${escapeHtml(name)}"${tagline ? ` title="${escapeHtml(tagline)}"` : ''}>
            <div class="browse-card-image">
                <img data-src="${escapeHtml(thumbUrl)}" src="${IMG_PLACEHOLDER}" alt="${escapeHtml(name)}" decoding="async" fetchpriority="low" onerror="this.dataset.failed='1';this.src='/img/no-portrait.png'">
                ${char.nsfw ? '<span class="browse-nsfw-badge">NSFW</span>' : ''}
                ${badges.filter(Boolean).length ? `<div class="browse-feature-badges">${badges.join('')}</div>` : ''}
            </div>
            <div class="browse-card-body">
                <div class="browse-card-name">${escapeHtml(name)}</div>
                ${creator ? `<span class="browse-card-creator-link" data-author="${escapeHtml(creator)}" data-creator-name="${escapeHtml(creator)}" title="Click to see all characters by ${escapeHtml(creator)}">${escapeHtml(creator)}</span>` : ''}
                ${cardTagsHtml(char.tags || [])}
            </div>
            <div class="browse-card-footer">
                ${rating ? `<span class="browse-card-stat" title="${ratingCount} rating${ratingCount !== 1 ? 's' : ''}"><i class="fa-solid fa-star"></i> ${rating}</span>` : ''}
                ${tokens ? `<span class="browse-card-stat" title="Tokens"><i class="fa-solid fa-coins"></i> ${tokens}</span>` : ''}
                ${downloads ? `<span class="browse-card-stat" title="Downloads"><i class="fa-solid fa-cloud-arrow-down"></i> ${downloads}</span>` : ''}
                ${indexedDate ? `<span class="browse-card-date" title="Indexed"><i class="fa-solid fa-clock"></i> ${indexedDate}</span>` : ''}
            </div>
        </div>
    `;
}

// ========================================
// GRID RENDERING
// ========================================

function renderCvGrid(append = false) {
    const grid = document.getElementById('cvGrid');
    if (!grid) return;

    if (!append) {
        grid.innerHTML = '';
        cvGridRenderedCount = 0;
    }
    const startIdx = cvGridRenderedCount;
    grid.insertAdjacentHTML('beforeend', cvCharacters.slice(startIdx).map(createCvCard).join(''));
    cvGridRenderedCount = cvCharacters.length;

    if (typeof IntersectionObserver === 'function') {
        charavaultBrowseView.observeImages(grid);
    }
    charavaultBrowseView.updateLoadMoreVisibility('cvLoadMore', cvHasMore, cvCharacters.length > 0);
}

// ========================================
// SEARCH / LOAD
// ========================================

// the persistent exclude tags (Settings > Online > CharaVault) plus the Library rows, on the client
function passesClientFilters(hits, activeRows) {
    const exclude = view.persistentExcludeTags().map(t => String(t).toLowerCase());
    return (hits || []).filter(h => (!exclude.length || !(h.tags || []).some(t => exclude.includes(String(t).toLowerCase())))
        && (!activeRows.length || featurePasses(h, activeRows)));
}

function cvFetchOpts(pageIndex = cvCurrentPage) {
    // paramsQuery skips null/undefined but not empty strings, so empty filters are omitted here
    const opts = {
        q: cvCurrentSearch || null,
        creator: cvCurrentCreator || null,
        tags: cvTagFilters.size > 0 ? [...cvTagFilters].join(',') : null,
        // 'sfw' -> false, 'nsfw' -> true, 'any' -> null (param omitted)
        nsfw: cvNsfwMode === 'sfw' ? false : cvNsfwMode === 'nsfw' ? true : null,
        // 'with' -> true, 'without' -> false, 'any' -> null (param omitted)
        has_book: cvLorebookMode === 'with' ? true : cvLorebookMode === 'without' ? false : null,
        sort: cvSortMode,
        limit: PAGE_SIZE,
        offset: pageIndex * PAGE_SIZE,
    };
    const excludeTags = view.persistentExcludeTags().join(',');
    if (excludeTags) opts.exclude_tags = excludeTags;
    return opts;
}

async function fetchOneCvPage(pageIndex = cvCurrentPage) {
    const data = await fetchCvCards(cvFetchOpts(pageIndex));
    const raw = (data?.results || []).map(r => {
        if (!r.fullPath) r.fullPath = cvFullPath(r.folder, r.file);
        return r;
    });
    return { raw, total: typeof data?.total === 'number' ? data.total : null };
}

async function loadCvCharacters(append = false) {
    if (append && (cvIsLoading || !cvHasMore)) return;

    // Concurrency control: a stale response may never overwrite a newer one
    const thisToken = ++cvLoadToken;
    cvIsLoading = true;
    let pageIdx = append ? cvCurrentPage + 1 : 0;

    const grid = document.getElementById('cvGrid');
    const loadMoreBtn = document.getElementById('cvLoadMoreBtn');

    if (!append && grid) {
        renderSkeletonGrid(grid);
    }
    if (loadMoreBtn) {
        loadMoreBtn.disabled = true;
        loadMoreBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Loading...';
    }

    try {
        const { raw, total } = await fetchOneCvPage(pageIdx);
        if (thisToken !== cvLoadToken || !delegatesInitialized) return;

        await charavaultBrowseView.probeHits(raw);
        if (thisToken !== cvLoadToken || !delegatesInitialized) return;

        const activeRows = activeFeatureRows(CV_FEATURE_FILTERS, cvFeatureState);
        const clientFiltering = activeRows.length > 0 || view.persistentExcludeTags().length > 0;
        let hits = passesClientFilters(raw, activeRows);
        let lastRawLen = raw.length;
        let hasMore = total != null ? (pageIdx * PAGE_SIZE + lastRawLen) < total : lastRawLen === PAGE_SIZE;

        // Auto-fetch when client-side filters remove too many results
        let autoFetches = 0;
        while (clientFiltering && hasMore && hits.length < MIN_PAGE_FILL && autoFetches < MAX_TAG_AUTO_FETCHES && delegatesInitialized) {
            if (thisToken !== cvLoadToken) return;
            autoFetches++;
            const nextIdx = pageIdx + 1;
            const more = await fetchOneCvPage(nextIdx);
            if (thisToken !== cvLoadToken || !delegatesInitialized) return;
            await charavaultBrowseView.probeHits(more.raw);
            if (thisToken !== cvLoadToken || !delegatesInitialized) return;
            pageIdx = nextIdx;
            hits = hits.concat(passesClientFilters(more.raw, activeRows));
            lastRawLen = more.raw.length;
            hasMore = more.total != null ? (pageIdx * PAGE_SIZE + lastRawLen) < more.total : lastRawLen === PAGE_SIZE;
        }
        if (autoFetches > 0) {
            debugLog(`[CVBrowse] Auto-fetched ${autoFetches} extra page(s) to compensate for client-side filters`);
        }

        cvCurrentPage = pageIdx;
        if (append) {
            const seenPaths = new Set(cvCharacters.map(c => c.fullPath));
            cvCharacters = cvCharacters.concat(hits.filter(h => !h.fullPath || !seenPaths.has(h.fullPath)));
        } else {
            cvCharacters = hits;
        }
        cvHasMore = hasMore;

        renderCvGrid(append);

        if (!append && cvCharacters.length === 0 && grid) {
            grid.innerHTML = `
                <div class="browse-empty-state">
                    <i class="fa-solid fa-vault browse-empty-icon"></i>
                    <p class="u-mt-md">No characters found</p>
                </div>
            `;
        }

        debugLog('[CVBrowse] Loaded', hits.length, 'characters, page', cvCurrentPage, 'hasMore', cvHasMore);
    } catch (err) {
        if (thisToken !== cvLoadToken) return;
        console.error('[CVBrowse] Search error:', err);
        showToast(`CharaVault search failed: ${err.message}`, 'error');
        if (!append && grid) {
            renderBrowseError(grid, {
                provider: 'charavault',
                error: err,
                message: `Search failed: ${err.message}`,
                flags: { nsfw: cvNsfwMode },
                retry: () => charavaultBrowseView.reload({ force: true }),
            });
        }
        cvHasMore = false;
    } finally {
        if (thisToken === cvLoadToken) {
            cvIsLoading = false;
            if (loadMoreBtn) {
                loadMoreBtn.disabled = false;
                loadMoreBtn.innerHTML = '<i class="fa-solid fa-plus"></i> Load More';
            }
        }
    }
}

// ========================================
// CREATOR FILTER
// ========================================

function filterByCreator(creator) {
    if (!creator) return;
    cvCurrentCreator = creator;
    cvCurrentSearch = '';

    const searchInput = document.getElementById('cvSearchInput');
    if (searchInput) searchInput.value = '';
    document.getElementById('cvClearSearchBtn')?.classList.add('hidden');

    document.getElementById('cvCreatorBanner')?.classList.remove('hidden');
    const bannerName = document.getElementById('cvCreatorBannerName');
    if (bannerName) bannerName.textContent = creator;

    charavaultBrowseView.reload();
}

function clearCreatorFilter() {
    cvCurrentCreator = '';
    document.getElementById('cvCreatorBanner')?.classList.add('hidden');
    const input = document.getElementById('cvCreatorSearchInput');
    if (input) input.value = '';
    charavaultBrowseView.reload();
}

// ========================================
// SEARCH
// ========================================

function performCvSearch() {
    const input = document.getElementById('cvSearchInput');
    cvCurrentSearch = (input?.value || '').trim();
    // a typed search replaces the creator scope, so the banner leaves with it
    cvCurrentCreator = '';
    document.getElementById('cvCreatorBanner')?.classList.add('hidden');
    document.getElementById('cvClearSearchBtn')?.classList.toggle('hidden', !cvCurrentSearch);
    charavaultBrowseView.reload();
}

// ========================================
// NSFW TOGGLE (3-state)
// ========================================

function updateCvNsfwToggle() {
    const btn = document.getElementById('cvNsfwToggle');
    if (!btn) return;
    btn.classList.remove('nsfw-active', 'nsfw-any');
    const span = btn.querySelector('span');
    if (cvNsfwMode === 'nsfw') {
        btn.classList.add('nsfw-active');
        btn.title = 'Showing NSFW only - click to include SFW';
        if (span) span.textContent = 'NSFW Only';
    } else if (cvNsfwMode === 'any') {
        btn.classList.add('nsfw-any');
        btn.title = 'Showing NSFW and SFW - click for SFW only';
        if (span) span.textContent = 'NSFW + SFW';
    } else {
        btn.title = 'Showing SFW only - click for NSFW only';
        if (span) span.textContent = 'SFW Only';
    }
}

function cycleCvNsfwMode() {
    // sfw -> nsfw -> any -> sfw
    cvNsfwMode = cvNsfwMode === 'sfw' ? 'nsfw' : cvNsfwMode === 'nsfw' ? 'any' : 'sfw';
    cvSettings?.set('nsfw', cvNsfwMode);
}

// ========================================
// TAGS
// ========================================

// fetchCvTags answers [name, count] pairs or { tag, count } rows; one shape for the list either way
function normalizeCvTags(tags) {
    return (tags || []).map(t => Array.isArray(t)
        ? [String(t[0]), Number(t[1]) || 0]
        : [String(t?.tag ?? t?.name ?? ''), Number(t?.count) || 0]
    ).filter(([tag]) => tag);
}

async function loadCvTags(query = '') {
    const list = document.getElementById('cvTagsList');
    if (!list) return;
    if (!query) {
        list.innerHTML = '<div class="browse-tags-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading tags...</div>';
    }
    try {
        // live tag search: the API filters server-side, 100 rows back
        cvPopularTags = normalizeCvTags(await fetchCvTags(query, 100));
        renderCvTagsList();
    } catch (e) {
        debugLog('[CVBrowse] Failed to fetch tags:', e?.message || e);
        list.innerHTML = '<div class="browse-tags-empty">Could not load tags</div>';
    }
}

function renderCvTagsList() {
    const list = document.getElementById('cvTagsList');
    if (!list) return;

    const top = cvPopularTags.slice(0, 80);
    if (top.length === 0) {
        list.innerHTML = '<div class="browse-tags-empty">No matching tags</div>';
        return;
    }

    list.innerHTML = top.map(([tag, count]) =>
        `<button type="button" class="browse-tag-pill${cvTagFilters.has(tag) ? ' active' : ''}" data-tag="${escapeHtml(tag)}" title="${escapeHtml(tag)} (${formatNumber(count)})">${escapeHtml(tag)}</button>`
    ).join('');
}

function toggleCvTag(tag) {
    if (!tag) return;
    if (cvTagFilters.has(tag)) cvTagFilters.delete(tag);
    else cvTagFilters.add(tag);
    updateCvTagsBtn();
    renderCvTagsList();
    charavaultBrowseView.reload();
}

function updateCvTagsBtn() {
    const btn = document.getElementById('cvTagsBtn');
    const label = document.getElementById('cvTagsBtnLabel');
    if (!btn || !label) return;
    if (cvTagFilters.size > 0) {
        label.textContent = `Tags (${cvTagFilters.size})`;
        btn.classList.add('has-filters');
    } else {
        label.textContent = 'Tags';
        btn.classList.remove('has-filters');
    }
}

function updateCvFiltersBtn() {
    const btn = document.getElementById('cvFiltersBtn');
    if (!btn) return;
    const count = countActiveFeatures(CV_FEATURE_FILTERS, cvFeatureState) + (cvLorebookMode !== 'any' ? 1 : 0);
    btn.classList.toggle('has-filters', count > 0);
    const span = btn.querySelector('span');
    if (span) span.textContent = count > 0 ? `Features (${count})` : 'Features';
}

// ========================================
// PREVIEW MODAL
// ========================================

async function openCvPreview(char) {
    if (!char) return;
    cvSelectedChar = char;
    const modal = document.getElementById('cvCharModal');
    if (!modal) return;
    CoreAPI.resetBrowseSectionCollapseState?.(modal);

    const previewToken = ++cvDetailToken;
    const name = char.name || 'Unknown';
    const creator = char.creator || '';
    const { folder, file } = splitCvPath(char.fullPath || cvFullPath(char.folder || '', char.file || ''));

    // Header
    const avatar = document.getElementById('cvCharAvatar');
    if (avatar) BrowseView.setPreviewPortrait(avatar, cvThumbUrl(folder, file));
    const nameEl = document.getElementById('cvCharName');
    if (nameEl) nameEl.textContent = name;
    const creatorEl = document.getElementById('cvCharCreator');
    if (creatorEl) {
        creatorEl.textContent = creator || 'Unknown';
        creatorEl.dataset.creator = creator;
        creatorEl.title = creator ? `Click to see all characters by ${creator}` : '';
    }
    const openBtn = document.getElementById('cvOpenInBrowserBtn');
    if (openBtn) openBtn.href = cvPreviewPageUrl(folder, file);

    // Stats row: list-row values first; the parallel fetch refreshes them
    const ratingEl = document.getElementById('cvCharRating');
    if (ratingEl) ratingEl.textContent = char.avg_rating ? Number(char.avg_rating).toFixed(1) : '0.0';
    const ratingCountEl = document.getElementById('cvCharRatingCount');
    if (ratingCountEl) ratingCountEl.textContent = char.rating_count ? `(${formatNumber(char.rating_count)})` : '';
    const tokensEl = document.getElementById('cvCharTokens');
    if (tokensEl) tokensEl.textContent = char.token_count ? formatNumber(char.token_count) : '0';
    const downloadsStat = document.getElementById('cvCharDownloadsStat');
    const downloadsEl = document.getElementById('cvCharDownloads');
    if (downloadsStat) downloadsStat.hidden = !char.download_count;
    if (downloadsEl) downloadsEl.textContent = char.download_count ? formatNumber(char.download_count) : '0';

    const lorebookStat = document.getElementById('cvCharLorebookStat');
    const lorebookTextEl = document.getElementById('cvCharLorebookText');
    if (lorebookStat) {
        lorebookStat.hidden = !char.has_lorebook;
        if (lorebookTextEl) lorebookTextEl.textContent = 'Lorebook';
    }

    const nsfwStat = document.getElementById('cvCharNsfwStat');
    const nsfwReasonsEl = document.getElementById('cvCharNsfwReasons');
    if (nsfwStat) {
        const reasons = (char.nsfw_reasons || []).filter(Boolean);
        if (char.nsfw && reasons.length > 0) {
            nsfwStat.hidden = false;
            if (nsfwReasonsEl) nsfwReasonsEl.textContent = reasons.join(', ');
        } else {
            nsfwStat.hidden = true;
        }
    }

    // Model-tier recommendation box, filled from detail.recommendations
    document.getElementById('cvCharTierBox')?.setAttribute('hidden', '');
    document.getElementById('cvCharGreetingsStat')?.setAttribute('hidden', '');

    // Tags: the reader's persistent exclude tags never reach the preview either
    const tagsEl = document.getElementById('cvCharTags');
    if (tagsEl) {
        const excluded = view.persistentExcludeTags().map(t => String(t).toLowerCase());
        const shown = (char.tags || []).filter(t => !excluded.includes(String(t).toLowerCase()));
        tagsEl.innerHTML = shown.map(t => `<span class="browse-tag">${escapeHtml(t)}</span>`).join('');
        const schedule = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn) => setTimeout(fn, 0);
        schedule(() => {
            if (previewToken === cvDetailToken && globalThis.window) applyTagsClamp(tagsEl);
        });
    }

    // Creator notes: the list row's preview now, the detail's own text once it lands
    const notesSection = document.getElementById('cvCharCreatorNotesSection');
    const notesEl = document.getElementById('cvCharCreatorNotes');
    if (notesSection && notesEl) {
        cleanupCreatorNotesContainer?.(notesEl);
        const previewNotes = char.description_preview || '';
        if (previewNotes.trim()) {
            notesSection.hidden = false;
            if (!notesEl.querySelector('iframe')) notesEl.innerHTML = skeletonLines(3);
        } else {
            notesSection.hidden = true;
            notesEl.innerHTML = '';
        }
    }

    // Rich-text sections reset; skeletons land where a value is expected
    for (const sectionId of [
        'cvCharDescriptionSection', 'cvCharPersonalitySection', 'cvCharScenarioSection',
        'cvCharFirstMsgSection', 'cvCharExamplesSection', 'cvCharSystemPromptSection',
        'cvCharPostHistorySection',
    ]) {
        const section = document.getElementById(sectionId);
        if (section) {
            section.hidden = true;
            const body = section.querySelector('.scrolling-text');
            if (body) body.innerHTML = '';
        }
    }

    // Alternate greetings and linked lorebooks reset to idle
    renderAltGreetingsList('cv', [], name);
    renderCvLinkedBooks([]);

    // Visually Similar: opt-in via the Find Similar button, so it starts empty
    const simEl = document.getElementById('cvCharSimilar');
    if (simEl) simEl.innerHTML = '';
    const simCountEl = document.getElementById('cvCharSimilarCount');
    if (simCountEl) simCountEl.textContent = '';
    const simStatus = document.getElementById('cvSimilarStatus');
    if (simStatus) simStatus.textContent = '';
    const simBtn = document.getElementById('cvFindSimilarBtn');
    if (simBtn) {
        simBtn.disabled = false;
        simBtn.innerHTML = '<i class="fa-solid fa-magnifying-glass"></i> Find Similar';
    }

    // Import button state, kept in step with the library while the preview is open
    const restampImport = () => {
        const inLibraryNow = view.isHitInLibrary(char);
        view.stampImportButton(document.getElementById('cvDownloadBtn'), {
            inLibrary: inLibraryNow,
            possibleMatch: !inLibraryNow && !!view.getPossibleMatchTier(char.name || '', creator)?.show,
        });
    };
    restampImport();
    view.trackPreview(restampImport, char);

    modal.classList.remove('hidden');
    const charBody = modal.querySelector('.browse-char-body');
    if (charBody) charBody.scrollTop = 0;

    // Full metadata + live rating + linked lorebooks in parallel; each is best-effort
    let detail = null;
    let liveRating = null;
    let linkedLorebooks = null;
    try {
        [detail, liveRating, linkedLorebooks] = await Promise.all([
            char.fullPath ? fetchCvCardDetail(char.fullPath).catch(() => null) : null,
            char.fullPath ? fetchCvRating(char.fullPath).catch(() => null) : null,
            char.fullPath ? fetchCvLinkedLorebooks(char.fullPath).catch(() => null) : null,
        ]);
    } catch (e) {
        debugLog('[CVBrowse] openCvPreview parallel fetch error:', e?.message || e);
    }
    // Bail when another card (or a close) took the preview over while we fetched
    if (previewToken !== cvDetailToken || cvSelectedChar !== char) return;

    if (liveRating) {
        if (ratingEl) ratingEl.textContent = Number(liveRating.avg_rating || 0).toFixed(1);
        if (ratingCountEl) ratingCountEl.textContent = liveRating.rating_count ? `(${formatNumber(liveRating.rating_count)})` : '';
    }

    // Linked lorebooks show even when the list row's has_lorebook flag was missing
    const books = linkedLorebooks?.lorebooks || [];
    if (books.length > 0 && lorebookStat) {
        lorebookStat.hidden = false;
        if (lorebookTextEl) lorebookTextEl.textContent = `${books.length} lorebook${books.length === 1 ? '' : 's'}`;
    }
    renderCvLinkedBooks(books);

    // a non-strict miss answers { entry: null, ... }, so read the fields, not the wrapper
    if (!detail?.entry && !detail?.fullMetadata) {
        const descSection = document.getElementById('cvCharDescriptionSection');
        const descEl = document.getElementById('cvCharDescription');
        if (descSection && descEl) {
            descSection.hidden = false;
            descEl.innerHTML = '<p class="browse-status-note"><i class="fa-solid fa-triangle-exclamation"></i> Could not load this character\'s definition. It can still be imported with its card file.</p>';
        }
        return;
    }

    try {
        char._cvDetail = detail;
        const meta = detail.fullMetadata?.data || {};
        const entry = detail.entry || {};
        const recs = detail.recommendations || null;

        // Model-tier recommendation
        const tierBox = document.getElementById('cvCharTierBox');
        if (tierBox && recs && (recs.tier_label || recs.tier_description)) {
            tierBox.hidden = false;
            const tierLabel = document.getElementById('cvCharTierLabel');
            if (tierLabel) tierLabel.textContent = recs.tier_label || '';
            const tierDesc = document.getElementById('cvCharTierDesc');
            if (tierDesc) tierDesc.textContent = recs.tier_description || '';
            const tierPreset = document.getElementById('cvCharTierPreset');
            if (tierPreset) tierPreset.textContent = recs.suggested_preset ? `Preset: ${recs.suggested_preset}` : '';
        }

        // Live downloads from the detail entry (detail wins over the list row)
        if (downloadsStat && entry.download_count) {
            downloadsStat.hidden = false;
            if (downloadsEl) downloadsEl.textContent = formatNumber(entry.download_count);
        }

        // Creator's notes
        if (notesSection && notesEl) {
            cleanupCreatorNotesContainer?.(notesEl);
            const notes = meta.creator_notes || char.description_preview || '';
            if (String(notes).trim()) {
                notesSection.hidden = false;
                if (!notesEl.querySelector('iframe')) notesEl.innerHTML = skeletonLines(3);
                deferCall(notesEl, () => renderCreatorNotesSecure(notes, name, notesEl));
            } else {
                notesSection.hidden = true;
                notesEl.innerHTML = '';
            }
        }

        // Rich-text fields: skeleton now, sanitized render one per frame on screen
        const richField = (sectionId, value) => {
            const section = document.getElementById(sectionId);
            if (!section) return;
            const el = section.querySelector('.scrolling-text');
            if (value && String(value).trim()) {
                section.hidden = false;
                if (el) el.innerHTML = skeletonLines(3);
                if (el) deferRender(el, () => safePurify(formatRichText(value, name, true), BROWSE_PURIFY_CONFIG));
            } else {
                section.hidden = true;
                if (el) el.innerHTML = '';
            }
        };
        richField('cvCharDescriptionSection', meta.description);
        richField('cvCharPersonalitySection', meta.personality);
        richField('cvCharScenarioSection', meta.scenario);
        richField('cvCharFirstMsgSection', meta.first_mes);
        richField('cvCharExamplesSection', meta.mes_example);
        richField('cvCharSystemPromptSection', meta.system_prompt);
        richField('cvCharPostHistorySection', meta.post_history_instructions);

        // Alternate greetings (renderAltGreetingsList also fills the greetings stat)
        renderAltGreetingsList('cv', Array.isArray(meta.alternate_greetings) ? meta.alternate_greetings : [], name);
    } catch (e) {
        debugLog('[CVBrowse] openCvPreview detail render error:', e?.message || e);
    }
}

function renderCvLinkedBooks(books) {
    const section = document.getElementById('cvCharLinkedBooksSection');
    const list = document.getElementById('cvCharLinkedBooks');
    const count = document.getElementById('cvCharLinkedBooksCount');
    if (!section || !list) return;
    if (!books || books.length === 0) {
        section.hidden = true;
        list.innerHTML = '';
        if (count) count.textContent = '';
        return;
    }
    section.hidden = false;
    if (count) count.textContent = `(${books.length})`;
    list.innerHTML = books.map(b => {
        const id = escapeHtml(String(b.id ?? ''));
        const title = b.title || b.name || `Lorebook ${id || '?'}`;
        const metaBits = [];
        if (b.entry_count != null) metaBits.push(`${formatNumber(b.entry_count)} entries`);
        if (b.token_count != null) metaBits.push(`${formatNumber(b.token_count)} tokens`);
        return `
            <div class="cv-linked-book" data-lorebook-row="${id}">
                <i class="fa-solid fa-book"></i>
                <span class="cv-linked-book-title">${escapeHtml(title)}</span>
                <span class="cv-linked-book-meta">${escapeHtml(metaBits.join(' · '))}</span>
                <button type="button" class="glass-btn cv-import-linked-book-btn" data-lorebook-id="${id}" data-lorebook-name="${escapeHtml(title)}"><i class="fa-solid fa-download"></i> Import to Shelf</button>
            </div>
        `;
    }).join('');
}

function closeCvPreviewModal() {
    cvDetailToken++;
    BrowseView.closeAvatarViewer?.();
    CoreAPI.setBrowseAltGreetings?.(null);
    const notesEl = document.getElementById('cvCharCreatorNotes');
    if (notesEl) cleanupCreatorNotesContainer?.(notesEl);
    for (const id of [
        'cvCharCreatorNotes', 'cvCharDescription', 'cvCharPersonality', 'cvCharScenario',
        'cvCharFirstMsg', 'cvCharExamples', 'cvCharSystemPrompt', 'cvCharPostHistory',
        'cvCharAltGreetings', 'cvCharTags', 'cvCharLinkedBooks', 'cvCharSimilar',
    ]) {
        const el = document.getElementById(id);
        if (el) el.innerHTML = '';
    }
    document.getElementById('cvCharModal')?.classList.add('hidden');
    cvSelectedChar = null;
    view?.trackPreview(null);
}

/** The preview as the overlay stack sees it (the entry registers it through ctx.ui.addOverlay). */
export function isCvPreviewOpen() {
    return !document.getElementById('cvCharModal')?.classList.contains('hidden');
}

// ========================================
// VISUALLY SIMILAR (opt-in fetch)
// ========================================

async function loadCvSimilar({ path, folder, file, fullPath } = {}) {
    const simEl = document.getElementById('cvCharSimilar');
    const simCountEl = document.getElementById('cvCharSimilarCount');
    const simStatus = document.getElementById('cvSimilarStatus');
    const simBtn = document.getElementById('cvFindSimilarBtn');
    if (simBtn) {
        simBtn.disabled = true;
        simBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Searching...';
    }
    if (simStatus) simStatus.textContent = '';
    try {
        // capture the open card so a preview switch mid-fetch never renders stale results
        const callerFullPath = cvSelectedChar?.fullPath;
        const res = await fetchCvSimilar({ path, folder, file, fullPath });
        if (cvSelectedChar?.fullPath !== callerFullPath) return;
        if (!simEl) return;
        const results = res?.results || [];
        if (!res?.ok) {
            simEl.innerHTML = '';
            if (simCountEl) simCountEl.textContent = '';
            if (simStatus) {
                if (res?.reason === 'no_path' || res?.reason === 'no_hash') {
                    simStatus.textContent = 'This card has no image-hash entry on CharaVault, so visual similarity is unavailable.';
                } else if (res?.reason === 'http') {
                    simStatus.textContent = `Server returned HTTP ${res.status}.`;
                } else {
                    simStatus.textContent = `Error: ${res?.error || 'unknown'}`;
                }
            }
            return;
        }
        if (results.length === 0) {
            simEl.innerHTML = '';
            if (simCountEl) simCountEl.textContent = '';
            if (simStatus) simStatus.textContent = 'No visually similar cards found.';
            return;
        }
        if (simCountEl) simCountEl.textContent = `(${results.length})`;
        simEl.innerHTML = results.map(s => {
            const sFolder = s.folder || '';
            const sFile = s.file || '';
            const fp = cvFullPath(sFolder, sFile);
            const thumb = cvThumbUrl(sFolder, sFile);
            const sName = escapeHtml(s.name || sFile || 'Unknown');
            const sCreator = s.creator && s.creator !== 'Unknown'
                ? `<div class="cv-similar-card-creator">${escapeHtml(s.creator)}</div>`
                : '';
            const score = (typeof s.score === 'number')
                ? `<div class="cv-similar-card-score" title="Match score">${s.score.toFixed(0)}%</div>`
                : '';
            const reasons = Array.isArray(s.reasons) && s.reasons.length
                ? escapeHtml(s.reasons.join(', '))
                : '';
            const tooltip = reasons ? `${sName} — ${reasons}` : sName;
            return `<div class="cv-similar-card" data-full-path="${escapeHtml(fp)}" title="${tooltip}">
                <div class="cv-similar-card-thumb">
                    <img src="${escapeHtml(thumb)}" alt="${sName}" loading="lazy">
                    ${score}
                </div>
                <div class="cv-similar-card-name">${sName}</div>
                ${sCreator}
            </div>`;
        }).join('');
    } catch (e) {
        debugLog('[CVBrowse] loadCvSimilar error:', e);
        if (simStatus) simStatus.textContent = `Error: ${e?.message || e}`;
    } finally {
        const stillInDoc = simBtn && (typeof document.contains === 'function' ? document.contains(simBtn) : simBtn.isConnected !== false);
        if (stillInDoc) {
            simBtn.disabled = false;
            simBtn.innerHTML = '<i class="fa-solid fa-rotate"></i> Search again';
        }
    }
}

// ========================================
// IMPORT
// ========================================

async function importCvCharacter(char) {
    if (!char?.fullPath) return;
    await view.importFromPreview({
        button: document.getElementById('cvDownloadBtn'),
        hit: char,
        provider: 'charavault',
        id: char.fullPath,
        data: char,
        label: 'CharaVaultBrowse',
        closePreview: closeCvPreviewModal,
        probe: {
            name: char.name || '',
            creator: char.creator || '',
            fullPath: char.fullPath,
            providerId: 'charavault',
            externalId: char.fullPath,
        },
        dialog: {
            name: char.name || '',
            creator: char.creator || '',
            fullPath: char.fullPath,
            avatarUrl: cvThumbUrl(char.folder, char.file),
        },
    });
}

// ========================================
// EVENT WIRING
// ========================================

let delegatesInitialized = false;
let cvModalEventsAttached = false;

function initCvView() {
    cvNsfwMode = cvSettings?.get('nsfw') || 'sfw';
    if (delegatesInitialized) return;
    delegatesInitialized = true;

    const sortEl = document.getElementById('cvSortSelect');
    if (sortEl) {
        sortEl.value = cvSortMode;
        CoreAPI.initCustomSelect?.(sortEl);
    }

    // Grid delegation: creator link first, then the card itself
    const grid = document.getElementById('cvGrid');
    if (grid) {
        grid.addEventListener('click', (e) => {
            const creatorLink = e.target.closest('.browse-card-creator-link');
            if (creatorLink) {
                e.preventDefault();
                e.stopPropagation();
                const author = creatorLink.dataset.author || '';
                if (author) filterByCreator(author);
                return;
            }
            const card = e.target.closest('.browse-card');
            if (!card) return;
            const hit = cvCharacters.find(c => c.fullPath === card.dataset.cvPath);
            if (hit) openCvPreview(hit);
        });
    }

    // Search
    on('cvSearchInput', 'keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            performCvSearch();
        }
    });
    on('cvSearchInput', 'input', (e) => {
        document.getElementById('cvClearSearchBtn')?.classList.toggle('hidden', !e.target.value.trim());
    });
    on('cvSearchBtn', 'click', () => performCvSearch());
    on('cvClearSearchBtn', 'click', () => {
        const input = document.getElementById('cvSearchInput');
        if (input) input.value = '';
        document.getElementById('cvClearSearchBtn')?.classList.add('hidden');
        if (cvCurrentSearch) {
            cvCurrentSearch = '';
            charavaultBrowseView.reload();
        }
    });

    // Creator search
    on('cvCreatorSearchInput', 'keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            const val = document.getElementById('cvCreatorSearchInput')?.value.trim();
            if (val) filterByCreator(val);
        }
    });
    on('cvCreatorSearchBtn', 'click', () => {
        const val = document.getElementById('cvCreatorSearchInput')?.value.trim();
        if (val) filterByCreator(val);
    });
    on('cvClearCreatorBtn', 'click', () => clearCreatorFilter());

    // Load more
    on('cvLoadMoreBtn', 'click', () => charavaultBrowseView.reload({ append: true }));

    // NSFW 3-state toggle
    on('cvNsfwToggle', 'click', () => {
        cycleCvNsfwMode();
        updateCvNsfwToggle();
        charavaultBrowseView.reload();
    });
    updateCvNsfwToggle();

    // Sort
    on('cvSortSelect', 'change', (e) => {
        cvSortMode = e.target.value || cvSortMode;
        charavaultBrowseView.reload();
    });

    // Refresh
    on('refreshCvBtn', 'click', () => charavaultBrowseView.reload({ force: true }));

    // Tags dropdown, with live debounced server-side tag search
    const tagsDropdown = document.getElementById('cvTagsDropdown');
    const filtersDropdown = document.getElementById('cvFiltersDropdown');

    on('cvTagsBtn', 'click', (e) => {
        e.stopPropagation();
        CoreAPI.closeAllTopbarDropdowns?.('cvTagsDropdown');
        filtersDropdown?.classList.add('hidden');
        const wasHidden = tagsDropdown?.classList.contains('hidden');
        tagsDropdown?.classList.toggle('hidden');
        if (wasHidden && !document.getElementById('cvTagsSearchInput')?.value.trim()) loadCvTags('');
    });
    tagsDropdown?.addEventListener('click', (e) => e.stopPropagation());

    const tagSearchDebounced = debounce((val) => loadCvTags(val), 250);
    on('cvTagsSearchInput', 'input', (e) => tagSearchDebounced((e.target.value || '').trim()));

    on('cvTagsClearBtn', 'click', () => {
        cvTagFilters.clear();
        updateCvTagsBtn();
        const searchInput = document.getElementById('cvTagsSearchInput');
        if (searchInput) searchInput.value = '';
        loadCvTags('');
        charavaultBrowseView.reload();
    });

    const tagsList = document.getElementById('cvTagsList');
    tagsList?.addEventListener('click', (e) => {
        const pill = e.target.closest('.browse-tag-pill');
        if (pill) toggleCvTag(pill.dataset.tag);
    });

    // Features dropdown: the lorebook tri-state radios plus the shared Library rows
    on('cvFiltersBtn', 'click', (e) => {
        e.stopPropagation();
        CoreAPI.closeAllTopbarDropdowns?.('cvFiltersDropdown');
        tagsDropdown?.classList.add('hidden');
        filtersDropdown?.classList.toggle('hidden');
    });
    filtersDropdown?.addEventListener('click', (e) => e.stopPropagation());

    document.querySelectorAll('input[name="cvLorebookMode"]').forEach(input => {
        input.addEventListener('change', (e) => {
            if (!e.target.checked) return;
            cvLorebookMode = e.target.value;
            updateCvFiltersBtn();
            charavaultBrowseView.reload();
        });
    });

    charavaultBrowseView.wireFeatureFilters(CV_FEATURE_FILTERS, cvFeatureState, () => {
        charavaultBrowseView.reload();
    }, { badge: updateCvFiltersBtn });

    // Dropdown dismiss (document-level, released on deactivate)
    charavaultBrowseView._registerDropdownDismiss([
        { dropdownId: 'cvTagsDropdown', buttonId: 'cvTagsBtn' },
        { dropdownId: 'cvFiltersDropdown', buttonId: 'cvFiltersBtn' },
    ]);

    // Preview modal events (attached once: the modal DOM persists across provider switches)
    if (!cvModalEventsAttached) {
        cvModalEventsAttached = true;

        const modal = document.getElementById('cvCharModal');
        if (typeof MutationObserver === 'function') {
            BrowseView.wireTitleScroll?.(document.getElementById('cvCharName'), modal, modal?.querySelector('.browse-char-modal'));
        }

        on('cvCharClose', 'click', () => closeCvPreviewModal());
        modal?.addEventListener('click', (e) => {
            if (e.target === modal) closeCvPreviewModal();
        });

        const avatarImg = document.getElementById('cvCharAvatar');
        avatarImg?.addEventListener('click', (e) => {
            // on a phone the delegated tap opens the quick view instead
            if (isMobileMode()) return;
            e.stopPropagation();
            if (!avatarImg.src || avatarImg.src.endsWith('/img/no-portrait.png')) return;
            BrowseView.openAvatarViewer?.(avatarImg.src);
        });

        on('cvCharCreator', 'click', (e) => {
            e.preventDefault();
            const creator = e.target.dataset.creator || '';
            if (!creator) {
                showToast('No creator is listed for this character', 'info');
                return;
            }
            closeCvPreviewModal();
            filterByCreator(creator);
        });

        // Linked lorebook imports (delegated: the list is rebuilt per card)
        document.getElementById('cvCharLinkedBooks')?.addEventListener('click', async (e) => {
            const btn = e.target.closest('.cv-import-linked-book-btn');
            if (!btn || btn.dataset.busy) return;
            const id = btn.dataset.lorebookId;
            const name = btn.dataset.lorebookName || `Lorebook ${id}`;
            if (!id) return;
            btn.dataset.busy = '1';
            btn.disabled = true;
            const original = btn.innerHTML;
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Importing...';
            try {
                const detail = await fetchCvLorebookDetail(id);
                const book = normalizeCvCharacterBook(detail);
                const res = await importBookToShelf({
                    name,
                    book,
                    source: { provider: 'charavault', externalId: String(id) },
                    eventSource: 'lorebooks:charavault',
                });
                if (res) {
                    btn.innerHTML = '<i class="fa-solid fa-check"></i> On your shelf';
                    showToast(`Imported "${res.world}" (${res.entries} ${res.entries === 1 ? 'entry' : 'entries'})`, 'success');
                } else {
                    // importBookToShelf answers null after its own cancel/notice
                    btn.disabled = false;
                    btn.innerHTML = original;
                }
            } catch (err) {
                showToast(`Lorebook import failed: ${err?.message || err}`, 'error');
                btn.disabled = false;
                btn.innerHTML = original;
            } finally {
                delete btn.dataset.busy;
            }
        });

        // Modal-level delegation for the rest: similar-card clicks, Find Similar, Import
        modal?.addEventListener('click', async (e) => {
            // Similar card click: open that character's preview
            const simCard = e.target.closest('.cv-similar-card[data-full-path]');
            if (simCard) {
                const fp = simCard.dataset.fullPath;
                if (!fp) return;
                const known = cvCharacters.find(c => c.fullPath === fp);
                if (known) {
                    openCvPreview(known);
                } else {
                    // a synthetic char: openCvPreview fetches what it needs from the detail API
                    const { folder, file } = splitCvPath(fp);
                    openCvPreview({ fullPath: fp, folder, file, name: file.replace(/\.png$/i, '') });
                }
                return;
            }

            // Find Similar: opt-in /cards/similar fetch, keyed on the entry's disk path
            const findSimBtn = e.target.closest('#cvFindSimilarBtn');
            if (findSimBtn) {
                e.preventDefault();
                const char = cvSelectedChar;
                if (!char?.fullPath) return;
                let path = char.path || char._cvDetail?.entry?.path || null;
                if (!path) {
                    try {
                        const detail = await fetchCvCardDetail(char.fullPath);
                        path = detail?.entry?.path || null;
                    } catch { /* best-effort: the api layer reports the miss */ }
                }
                await loadCvSimilar({
                    path,
                    folder: char.folder,
                    file: char.file,
                    fullPath: char.fullPath,
                });
                return;
            }

            // Import
            const importBtn = e.target.closest('#cvDownloadBtn');
            if (importBtn) {
                e.preventDefault();
                if (cvSelectedChar) importCvCharacter(cvSelectedChar);
            }
        });
    }
}

// ========================================
// BROWSE VIEW CLASS
// ========================================

class CharaVaultBrowseView extends BrowseView {

    constructor(provider) {
        super(provider);
        this._preloadLimit = 72;
        view = this;
    }

    // the preview's nodes left with the provider: the next injection wires them again
    onModalsRemoved() {
        cvModalEventsAttached = false;
    }

    // ── Library Lookup contract ─────────────────────────────

    hitLinkKey(hit) {
        return hit?.fullPath || null;
    }

    hitMatchName(hit) {
        return { name: hit?.name || '', creator: hit?.creator || '' };
    }

    // ── Identifiers ─────────────────────────────────────────

    get previewModalId() { return 'cvCharModal'; }

    get mobileFilterIds() {
        return {
            sort: 'cvSortSelect',
            tags: 'cvTagsBtn',
            filters: 'cvFiltersBtn',
            nsfw: 'cvNsfwToggle',
            refresh: 'refreshCvBtn',
        };
    }

    getSettingsConfig() {
        const sorts = Array.isArray(CV_SORTS) ? CV_SORTS : [];
        return {
            browseSortOptions: sorts.map(s => ({ value: s.value, label: s.label })),
            followingSortOptions: [],
            viewModes: [],
        };
    }

    // ── Mobile search contract ──────────────────────────────

    getSearchModes() { return ['character', 'creator']; }

    getSearchInputId(mode) {
        return mode === 'creator' ? 'cvCreatorSearchInput' : 'cvSearchInput';
    }

    getSearchPlaceholder(mode) {
        return mode === 'creator' ? 'Creator name...' : 'Character name...';
    }

    // ── Filter Bar ──────────────────────────────────────────

    renderFilterBar() {
        const sorts = Array.isArray(CV_SORTS) ? CV_SORTS : [];
        return `
            <!-- Sort dropdown -->
            <div class="browse-sort-container">
                <select id="cvSortSelect" class="glass-select" title="Sort order">
                    ${sorts.map(s => `<option value="${escapeHtml(s.value)}"${s.icon ? ` data-icon="${escapeHtml(s.icon)}"` : ''}${s.value === cvSortMode ? ' selected' : ''}>${escapeHtml(s.label)}</option>`).join('')}
                </select>
            </div>

            <!-- Tag filters dropdown (live tag search) -->
            <div class="browse-tags-dropdown-container u-relative">
                <button id="cvTagsBtn" class="glass-btn" title="Filter by tags">
                    <i class="fa-solid fa-tags"></i> <span id="cvTagsBtnLabel">Tags</span>
                </button>
                <div id="cvTagsDropdown" class="dropdown-menu browse-tags-dropdown hidden">
                    <div class="browse-tags-search-row">
                        <input type="search" id="cvTagsSearchInput" placeholder="Search tags..." autocomplete="one-time-code">
                        <button id="cvTagsClearBtn" class="glass-btn icon-only" title="Clear tag filters">
                            <i class="fa-solid fa-rotate-left"></i>
                        </button>
                    </div>
                    <div class="browse-tags-list" id="cvTagsList">
                        <div class="browse-tags-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading tags...</div>
                    </div>
                </div>
            </div>

            <!-- Features: lorebook tri-state + library rows -->
            <div class="browse-more-filters u-relative">
                <button id="cvFiltersBtn" class="glass-btn" title="Feature filters">
                    <i class="fa-solid fa-sliders"></i> <span>Features</span>
                </button>
                <div id="cvFiltersDropdown" class="dropdown-menu browse-features-dropdown hidden">
                    <div class="dropdown-section-title">Lorebook</div>
                    <label class="filter-checkbox"><input type="radio" name="cvLorebookMode" value="any" checked> Any</label>
                    <label class="filter-checkbox"><input type="radio" name="cvLorebookMode" value="with"> <i class="fa-solid fa-book"></i> Has lorebook</label>
                    <label class="filter-checkbox"><input type="radio" name="cvLorebookMode" value="without"> <i class="fa-solid fa-book-skull"></i> No lorebook</label>
                    <hr class="browse-filter-divider">
                    ${renderFeatureFilterItems(CV_FILTER_SECTIONS, CV_FEATURE_FILTERS)}
                </div>
            </div>

            <!-- NSFW 3-state toggle -->
            <button id="cvNsfwToggle" class="glass-btn nsfw-toggle" title="Cycle NSFW filter (SFW only / NSFW only / Any)">
                <i class="fa-solid fa-shield-halved"></i> <span>SFW Only</span>
            </button>

            <!-- Refresh -->
            <button id="refreshCvBtn" class="glass-btn icon-only" title="Refresh">
                <i class="fa-solid fa-sync"></i>
            </button>
        `;
    }

    // ── Main View ───────────────────────────────────────────

    renderView() {
        return `
            <div id="cvBrowseSection" class="browse-section">
                <div class="browse-search-bar">
                    <div class="browse-search-input-wrapper">
                        <i class="fa-solid fa-search"></i>
                        <input type="search" id="cvSearchInput" placeholder="Search CharaVault characters..." autocomplete="one-time-code">
                        <button id="cvClearSearchBtn" class="browse-search-clear hidden" title="Clear search">
                            <i class="fa-solid fa-xmark"></i>
                        </button>
                        <button id="cvSearchBtn" class="browse-search-submit" aria-label="Search">
                            <i class="fa-solid fa-arrow-right"></i>
                        </button>
                    </div>
                    <div class="browse-creator-search">
                        <div class="browse-creator-search-wrapper">
                            <i class="fa-solid fa-user"></i>
                            <input type="search" id="cvCreatorSearchInput" placeholder="Filter by creator..." autocomplete="one-time-code">
                            <button id="cvCreatorSearchBtn" class="browse-search-submit" title="Filter by creator" aria-label="Filter by creator">
                                <i class="fa-solid fa-arrow-right"></i>
                            </button>
                        </div>
                    </div>
                </div>

                <!-- Creator banner (shown when filtering by creator) -->
                <div id="cvCreatorBanner" class="cv-creator-banner hidden">
                    <div class="cv-creator-banner-content">
                        <i class="fa-solid fa-user"></i>
                        <span>Showing characters by <strong id="cvCreatorBannerName"></strong></span>
                    </div>
                    <div class="cv-creator-banner-actions">
                        <button id="cvClearCreatorBtn" class="glass-btn icon-only" title="Clear creator filter">
                            <i class="fa-solid fa-times"></i>
                        </button>
                    </div>
                </div>

                <!-- Results grid -->
                <div id="cvGrid" class="browse-grid"></div>

                <!-- Load more -->
                <div class="browse-load-more" id="cvLoadMore" hidden>
                    <button id="cvLoadMoreBtn" class="glass-btn">
                        <i class="fa-solid fa-plus"></i> Load More
                    </button>
                </div>
            </div>
        `;
    }

    // ── Preview Modal ───────────────────────────────────────

    renderModals() {
        return `
    <div id="cvCharModal" class="modal-overlay hidden">
        <div class="modal-glass browse-char-modal">
            <div class="modal-header">
                <div class="browse-char-header-info">
                    <img id="cvCharAvatar" src="/img/no-portrait.png" alt="" class="browse-char-avatar">
                    <div>
                        <h2 id="cvCharName">Character Name</h2>
                        <p class="browse-char-meta">
                            by <a id="cvCharCreator" href="#" class="browse-meta-identity" title="Show all by this creator">Creator</a>
                        </p>
                    </div>
                </div>
                <div class="modal-controls">
                    <a id="cvOpenInBrowserBtn" href="#" target="_blank" rel="noopener" class="cl-btn cl-btn-secondary" title="Open on CharaVault">
                        <i class="fa-solid fa-external-link"></i> Open
                    </a>
                    <button id="cvDownloadBtn" class="cl-btn cl-btn-primary" title="Import into your library">
                        <i class="fa-solid fa-download"></i> Import
                    </button>
                    <button class="close-btn" id="cvCharClose">&times;</button>
                </div>
            </div>
            <div class="browse-char-body">
                <div class="cv-modal-stats">
                    <div class="cv-modal-stat" title="Average rating / vote count">
                        <i class="fa-solid fa-star"></i>
                        <span id="cvCharRating">0.0</span>
                        <span id="cvCharRatingCount" class="cv-modal-stat-sub"></span>
                    </div>
                    <div class="cv-modal-stat" title="Token count">
                        <i class="fa-solid fa-coins"></i>
                        <span id="cvCharTokens" class="cv-token-count">0</span> tokens
                    </div>
                    <div class="cv-modal-stat" id="cvCharDownloadsStat" hidden title="Total downloads on CharaVault">
                        <i class="fa-solid fa-cloud-arrow-down"></i>
                        <span id="cvCharDownloads">0</span>
                    </div>
                    <div class="cv-modal-stat" id="cvCharLorebookStat" hidden title="Linked lorebook(s)">
                        <i class="fa-solid fa-book"></i>
                        <span id="cvCharLorebookText">Lorebook</span>
                    </div>
                    <div class="cv-modal-stat" id="cvCharGreetingsStat" hidden title="Alternate greetings">
                        <i class="fa-solid fa-comment-dots"></i>
                        <span id="cvCharGreetingsCount">0</span> greetings
                    </div>
                    <div class="cv-modal-stat" id="cvCharNsfwStat" hidden title="NSFW reasons">
                        <i class="fa-solid fa-triangle-exclamation"></i>
                        <span id="cvCharNsfwReasons"></span>
                    </div>
                </div>
                <div class="cv-modal-tier" id="cvCharTierBox" hidden>
                    <i class="fa-solid fa-microchip"></i>
                    <div class="cv-modal-tier-text">
                        <strong id="cvCharTierLabel"></strong>
                        <span id="cvCharTierDesc"></span>
                        <span id="cvCharTierPreset" class="cv-modal-tier-preset"></span>
                    </div>
                </div>
                <div class="browse-char-tags" id="cvCharTags"></div>

                <!-- Creator's Notes -->
                <div class="browse-char-section" id="cvCharCreatorNotesSection" hidden>
                    <h3 class="browse-section-title" data-section="cvCharCreatorNotes" data-label="Creator's Notes" data-icon="fa-solid fa-feather-pointed" title="Click to expand">
                        <i class="fa-solid fa-feather-pointed"></i> Creator's Notes
                    </h3>
                    <div id="cvCharCreatorNotes" class="scrolling-text"></div>
                </div>

                <!-- Character Definition (V2 "description" - the prompt) -->
                <div class="browse-char-section" id="cvCharDescriptionSection" hidden>
                    <h3 class="browse-section-title" data-section="cvCharDescription" data-label="Character Definition" data-icon="fa-solid fa-scroll" title="Click to expand">
                        <i class="fa-solid fa-scroll"></i> Character Definition
                    </h3>
                    <div id="cvCharDescription" class="scrolling-text"></div>
                </div>

                <!-- Personality -->
                <div class="browse-char-section" id="cvCharPersonalitySection" hidden>
                    <h3 class="browse-section-title" data-section="cvCharPersonality" data-label="Personality" data-icon="fa-solid fa-brain" title="Click to expand">
                        <i class="fa-solid fa-brain"></i> Personality
                    </h3>
                    <div id="cvCharPersonality" class="scrolling-text"></div>
                </div>

                <!-- Scenario -->
                <div class="browse-char-section" id="cvCharScenarioSection" hidden>
                    <h3 class="browse-section-title" data-section="cvCharScenario" data-label="Scenario" data-icon="fa-solid fa-theater-masks" title="Click to expand">
                        <i class="fa-solid fa-theater-masks"></i> Scenario
                    </h3>
                    <div id="cvCharScenario" class="scrolling-text"></div>
                </div>

                <!-- First Message -->
                <div class="browse-char-section" id="cvCharFirstMsgSection" hidden>
                    <h3 class="browse-section-title" data-section="cvCharFirstMsg" data-label="First Message" data-icon="fa-solid fa-message" title="Click to expand">
                        <i class="fa-solid fa-message"></i> First Message
                    </h3>
                    <div id="cvCharFirstMsg" class="scrolling-text first-message-preview"></div>
                </div>

                <!-- Example Dialogs (collapsed by default: usually long) -->
                <div class="browse-char-section browse-section-collapsed" id="cvCharExamplesSection" hidden>
                    <h3 class="browse-section-title" data-section="cvCharExamples" data-label="Example Dialogs" data-icon="fa-solid fa-comments" title="Click to expand">
                        <i class="fa-solid fa-comments"></i> Example Dialogs
                        <span class="browse-section-inline-toggle" title="Toggle inline"><i class="fa-solid fa-chevron-down"></i></span>
                    </h3>
                    <div id="cvCharExamples" class="scrolling-text"></div>
                </div>

                <!-- System Prompt (only when present) -->
                <div class="browse-char-section browse-section-collapsed" id="cvCharSystemPromptSection" hidden>
                    <h3 class="browse-section-title" data-section="cvCharSystemPrompt" data-label="System Prompt" data-icon="fa-solid fa-gear" title="Click to expand">
                        <i class="fa-solid fa-gear"></i> System Prompt
                    </h3>
                    <div id="cvCharSystemPrompt" class="scrolling-text"></div>
                </div>

                <!-- Post-History Instructions (jailbreak slot) -->
                <div class="browse-char-section browse-section-collapsed" id="cvCharPostHistorySection" hidden>
                    <h3 class="browse-section-title" data-section="cvCharPostHistory" data-label="Post-History Instructions" data-icon="fa-solid fa-flag-checkered" title="Click to expand">
                        <i class="fa-solid fa-flag-checkered"></i> Post-History Instructions
                    </h3>
                    <div id="cvCharPostHistory" class="scrolling-text"></div>
                </div>

                <!-- Alternate Greetings -->
                <div class="browse-char-section" id="cvCharAltGreetingsSection" hidden>
                    <h3 class="browse-section-title" data-section="browseAltGreetings" data-label="Alternate Greetings" data-icon="fa-solid fa-comments" title="Click to expand">
                        <i class="fa-solid fa-comments"></i> Alternate Greetings <span class="browse-section-count" id="cvCharAltGreetingsCount"></span>
                    </h3>
                    <div id="cvCharAltGreetings" class="browse-alt-greetings-list"></div>
                </div>

                <!-- Linked Lorebooks (live) -->
                <div class="browse-char-section" id="cvCharLinkedBooksSection" hidden>
                    <h3 class="browse-section-title" data-section="cvCharLinkedBooks" data-label="Linked Lorebooks" data-icon="fa-solid fa-book" title="Click to expand">
                        <i class="fa-solid fa-book"></i> Linked Lorebooks
                        <span class="browse-section-count" id="cvCharLinkedBooksCount"></span>
                    </h3>
                    <div id="cvCharLinkedBooks" class="cv-linked-books-list"></div>
                </div>

                <!-- Visually Similar (visual hash, opt-in) -->
                <div class="browse-char-section" id="cvCharSimilarSection">
                    <h3 class="browse-section-title" data-section="cvCharSimilar" data-label="Visually Similar" data-icon="fa-solid fa-images" title="Click to expand">
                        <i class="fa-solid fa-images"></i> Visually Similar
                        <span class="browse-section-count" id="cvCharSimilarCount"></span>
                    </h3>
                    <div class="cv-similar-controls">
                        <button id="cvFindSimilarBtn" class="glass-btn cv-find-similar-btn" title="Find visually similar cards">
                            <i class="fa-solid fa-magnifying-glass"></i> Find Similar
                        </button>
                        <span id="cvSimilarStatus" class="cv-similar-status"></span>
                    </div>
                    <div id="cvCharSimilar" class="cv-similar-grid"></div>
                </div>
            </div>
        </div>
    </div>`;
    }

    // ── Lifecycle ───────────────────────────────────────────

    _getImageGridIds() {
        return ['cvGrid'];
    }

    canLoadMore() { return cvHasMore && !cvIsLoading; }

    init() {
        super.init();
        initCvView();
        const grid = document.getElementById('cvGrid');
        if (grid && typeof IntersectionObserver === 'function') this.observeImages(grid);
        // No initial load here: the base's migrated activation arm issues it (and builds the
        // library lookup first), once applyDefaults had its say.
    }

    applyDefaults(defaults) {
        super.applyDefaults(defaults);
        if (defaults?.sort) {
            const sorts = Array.isArray(CV_SORTS) ? CV_SORTS : [];
            if (sorts.some(s => s.value === defaults.sort)) {
                cvSortMode = defaults.sort;
                const el = document.getElementById('cvSortSelect');
                if (el) el.value = defaults.sort;
            }
        }
    }

    // ── The single-mode lifecycle ───────────────────────────

    resetSessionState() {
        cvCurrentSearch = '';
        cvCurrentCreator = '';
        cvCharacters = [];
        cvCurrentPage = 0;
        cvHasMore = true;
        cvIsLoading = false;
        cvGridRenderedCount = 0;
        cvSelectedChar = null;
        cvSortMode = 'most_downloaded';
        cvLorebookMode = 'any';
        cvTagFilters = new Set();
        for (const k of Object.keys(cvFeatureState)) cvFeatureState[k] = false;
        // a rebuilt DOM needs its listeners back even when deactivate() never ran
        delegatesInitialized = false;
        cvDetailToken++;
    }

    loadInitial(opts = {}) {
        return loadCvCharacters(!!opts.append);
    }

    hasData() { return cvCharacters.length > 0; }

    rerenderGrid() {
        cvGridRenderedCount = 0;
        renderCvGrid(false);
    }

    get gridElementId() { return 'cvGrid'; }

    onActivated(isReEntry) {
        if (isReEntry) delegatesInitialized = true;
    }

    closePreview() {
        closeCvPreviewModal();
    }

    deactivate() {
        cvDetailToken++;
        delegatesInitialized = false;
        super.deactivate();
    }
}

const charavaultBrowseView = new CharaVaultBrowseView(null);

export {
    openCvPreview,
    closeCvPreviewModal,
    loadCvCharacters,
};

export default charavaultBrowseView;
