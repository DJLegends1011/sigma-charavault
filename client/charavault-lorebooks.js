import { cvThumbUrl, fetchCvLorebooks, fetchCvLorebookDetail, normalizeCvCharacterBook } from './charavault-api.js';
import { finiteOrNull, pageHasMore } from '/modules/providers/provider-utils.js';

export function normalizeCvLorebook(lb) {
    const file = String(lb?.file || '');
    const id = String(lb?.id ?? '');
    return {
        id,
        key: id,
        name: lb?.name || 'Untitled',
        creator: lb?.creator || 'Unknown',
        description: lb?.description || '',
        tagline: lb?.keywords ? 'Keywords: ' + String(lb.keywords).slice(0, 140) : '',
        cover: /\.png$/i.test(file) && !/\.lorebook\.json$/i.test(file) ? cvThumbUrl(lb.folder || 'cards', lb.file) : '',
        entryCount: finiteOrNull(lb?.entry_count),
        tokenEstimate: finiteOrNull(lb?.token_count),
        wordCount: null,
        tags: Array.isArray(lb?.topics) && lb.topics.length ? lb.topics : lb?.keywords ? String(lb.keywords).split(',').map(s => s.trim()).filter(Boolean).slice(0, 8) : [],
        nsfw: Boolean(lb?.nsfw),
        createdAt: lb?.indexed_at || null,
        stats: { stars: finiteOrNull(lb?.star_count) },
        url: 'https://charavault.net/lorebooks',
        // Never expose server-side disk paths (/mnt/...) as the shelf provenance path
        path: (lb?.folder && lb?.file) ? `${lb.folder}/${lb.file}` : id,
        raw: lb,
    };
}

export const charavaultLorebooks = {
    sortOptions: [
        { value: 'default', label: 'Default (A-Z)' },
        { value: 'entries_desc', label: 'Most Entries (page)' },
        { value: 'tokens_desc', label: 'Most Tokens (page)' },
        { value: 'newest', label: 'Newest (page)' },
    ],
    defaultSort: 'default',
    // the character view's own switch, as Chub's lorebooks share chubNsfw
    nsfw: { setting: 'ext:charavault:nsfw' },
    async fetchPage({ query = '', sort = 'default', nsfw = false, page = 1, limit = 48, signal } = {}) {
        const data = await fetchCvLorebooks({ q: query, nsfw: nsfw ? null : false, limit, offset: (page - 1) * limit, sort, signal });
        const hits = (Array.isArray(data?.lorebooks) ? data.lorebooks : []).map(normalizeCvLorebook);
        const total = finiteOrNull(data?.total);
        return { hits, hasMore: pageHasMore(total, page * limit, hits.length, limit), total };
    },
    async fetchBook(hit) {
        const detail = await fetchCvLorebookDetail(hit.id);
        const book = normalizeCvCharacterBook(detail, hit.name);
        if (!Array.isArray(book?.entries) || book.entries.length === 0) throw new Error('this lorebook carries no entries');
        return { book, name: book.name || hit.name };
    },
};
