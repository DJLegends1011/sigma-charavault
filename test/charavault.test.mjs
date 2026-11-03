// End-to-end verification of the CharaVault Project Σ extension (server proxy + security guards +
// client provider, browse view, preview modal, similar widget, linked lorebook merge, ST world
// format conversion, and LorebookView adapter) over a real startSigma server and session.page().
//     node --test test/charavault.test.mjs

import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const kitPath = [
    // SIGMA_DIR=~/ProjectSigma-main for checkouts that sit elsewhere (e.g. a git worktree)
    process.env.SIGMA_DIR && path.resolve(process.env.SIGMA_DIR, 'tools/extension-kit/index.mjs'),
    path.resolve(here, '../../../../ProjectSigma-main/tools/extension-kit/index.mjs'),
    path.resolve(here, '../../../../../ProjectSigma-main/tools/extension-kit/index.mjs'),
].find(p => fs.existsSync(p));

// Allow test server to reach our local mock upstream unless a test explicitly turns it off
process.env.CL_ALLOW_PRIVATE_FETCH = 'true';

const { startSigma, basePng } = await import(pathToFileURL(kitPath).href);
const pngCardPath = path.resolve(path.dirname(kitPath), '../../server/lib/png-card.js');
const { writeCardChunks, readCardChunks } = await import(pathToFileURL(pngCardPath).href);
const { resolveCvBases, assertSafeUpstreamUrl, forgetCvSessions } = await import(pathToFileURL(path.join(here, '../server/index.js')).href);

// ---- Mock CharaVault upstream server (verifies headers, query params, auth, redirects, and CORP)
const upstreamRequests = [];
let failTagsSearchOnce = false;
let tags5xxRemaining = 0;
let failRatingMode = false;
let failLinkedLorebooksMode = false;
let thumbReturnHtmlMode = false;
let thumbReturn503Mode = false;
let redirectTargetUrl = null;
const loginAttempts = [];
let sessionCounter = 0;
let revokeSessionOnce = false;
const favoritePaths = new Set();

const MOCK_CARDS = [
    {
        file: 'Adley_5412114.png',
        folder: 'cards',
        path: '/mnt/sde2/CharacterCards/chub/cards/Adley_5412114.png',
        name: 'Adley',
        creator: 'novelist_one',
        tags: ['Fantasy', 'Adventure', 'Female', 'chub'],
        nsfw: false,
        nsfw_reasons: [],
        description_preview: 'A ranger patrolling the northern border.',
        first_mes_preview: 'State your business, traveler.',
        indexed_at: '2026-02-10T12:00:00.000000',
        content_hash: 'abc123hash',
        image_hash: 'def456imghash',
        avg_rating: 4.5,
        rating_count: 12,
        download_count: 340,
        token_count: 1420,
        recommended_tier: 2,
        card_style: 'roleplay',
        has_lorebook: true,
    },
    {
        file: 'Venti_0075.png',
        folder: 'sakura_cards',
        path: 'sakura_cards/Venti_0075.png',
        name: 'Agent 0075',
        creator: 'spy_master',
        tags: ['Espionage', 'Mystery'],
        nsfw: true,
        nsfw_reasons: ['violence'],
        description_preview: 'Secret agent in a neon metropolis.',
        first_mes_preview: 'The wind whispers secrets.',
        indexed_at: '2026-02-11T15:30:00.000000',
        content_hash: '789xyzhash',
        image_hash: '',
        avg_rating: 4.8,
        rating_count: 5,
        download_count: 89,
        token_count: 2100,
        recommended_tier: 3,
        card_style: 'creative_writing',
        has_lorebook: false,
    },
];

// Two cards sharing one name, as charavault.net has (the archive keeps both copies)
const TWIN_CARDS = [
    { file: 'd81_Twin Sensei.card.png', folder: 'janitorai', name: 'Twin Sensei', creator: 'Unknown', tags: [], nsfw: false, description_preview: 'first copy' },
    { file: 'Twin Sensei_0f1e.png', folder: 'cards', name: 'Twin Sensei', creator: 'sensei_maker', tags: [], nsfw: false, description_preview: 'second copy' },
];

const MOCK_LOREBOOKS = [
    {
        id: 101,
        file_path: '/mnt/sde2/CharacterCards/chub/cards/Adley_5412114.png',
        file: 'Adley.lorebook.json',
        folder: 'cards',
        name: 'Northern Border Lore',
        creator: 'novelist_one',
        description: 'World lore for the northern borderlands.',
        topics: ['Fantasy', 'Borderlands'],
        entry_count: 2,
        token_count: 640,
        keywords: 'watchtower, frostwood, rangers',
        star_count: 19,
        nsfw: 0,
        indexed_at: '2026-02-12T00:00:00.000000',
        source: 'linked',
    },
    {
        id: 102,
        file_path: '/mnt/sde2/CharacterCards/chub/cards/Adley_5412114.png',
        file: 'Adley_embedded.lorebook.json',
        folder: 'cards',
        name: 'Embedded Duplicate',
        creator: 'novelist_one',
        description: 'Indexed copy of embedded book.',
        topics: ['Fantasy'],
        entry_count: 1,
        token_count: 120,
        keywords: 'adley',
        star_count: 2,
        nsfw: 0,
        indexed_at: '2026-02-09T00:00:00.000000',
        source: 'embedded',
    },
    {
        id: 103,
        file_path: '/mnt/sde2/CharacterCards/worlds/SillyWorld.json',
        file: 'SillyWorld.lorebook.json',
        folder: 'worlds',
        name: 'SillyTavern World Book',
        creator: 'world_builder',
        description: 'Native SillyTavern world format lorebook.',
        topics: ['Worldbuilding'],
        entry_count: 5,
        token_count: 1200,
        keywords: 'citadel, mage',
        star_count: 33,
        nsfw: 1,
        indexed_at: '2026-02-15T00:00:00.000000',
        source: 'standalone',
    },
];

// Secondary server to test cross-host redirect blocking
const evilRedirectRequests = [];
const evilServer = http.createServer((req, res) => {
    evilRedirectRequests.push({ url: req.url, headers: { ...req.headers } });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ stolen: true }));
});

const mockUpstream = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    upstreamRequests.push({
        method: req.method,
        pathname: u.pathname,
        searchParams: Object.fromEntries(u.searchParams.entries()),
        headers: { ...req.headers },
    });

    if (redirectTargetUrl) {
        res.writeHead(302, { Location: redirectTargetUrl });
        res.end();
        return;
    }

    // Enforce browser-like User-Agent just like real charavault.net
    if (!String(req.headers['user-agent'] || '').includes('Mozilla/5.0')) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ detail: 'Automated access not permitted' }));
        return;
    }

    // Simulate charavault.net's hostile Cross-Origin-Resource-Policy header
    res.setHeader('Cross-Origin-Resource-Policy', 'same-site');

    if (u.pathname === '/api/auth/login' && req.method === 'POST') {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        let body = {};
        try { body = JSON.parse(raw); } catch { /* bad body */ }
        loginAttempts.push(body);
        if (body.email === 'me@example.com' && body.password === 'cv_good_app_pw') {
            sessionCounter += 1;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, token: 'sess_' + sessionCounter, user: { display_name: 'Tester', nsfw_verified: true } }));
            return;
        }
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ detail: 'Invalid email or password' }));
        return;
    }

    if (revokeSessionOnce && u.pathname === '/api/cards' && req.headers.authorization === 'Bearer sess_1') {
        revokeSessionOnce = false;
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ detail: 'Not authenticated' }));
        return;
    }

    if (u.pathname === '/favicon.ico') {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(basePng);
        return;
    }

    if (u.pathname.startsWith('/cards/thumb/')) {
        if (thumbReturnHtmlMode) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<script>alert(1)</script>');
            return;
        }
        if (thumbReturn503Mode) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ detail: 'Service unavailable' }));
            return;
        }
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(basePng);
        return;
    }

    if (u.pathname.startsWith('/api/cards/download/')) {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(basePng);
        return;
    }

    if (u.pathname === '/api/cards' && (u.searchParams.get('q') || '').toLowerCase() === 'twin sensei') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ total: TWIN_CARDS.length, limit: 48, offset: 0, results: TWIN_CARDS }));
        return;
    }

    if (u.pathname === '/api/cards') {
        let list = [...MOCK_CARDS];
        const q = (u.searchParams.get('q') || '').toLowerCase();
        const creator = (u.searchParams.get('creator') || '').toLowerCase();
        const nsfw = u.searchParams.get('nsfw');
        const hasBook = u.searchParams.get('has_book');
        const tags = (u.searchParams.get('tags') || '').split(',').filter(Boolean);
        const excludeTags = (u.searchParams.get('exclude_tags') || '').split(',').map(s => s.toLowerCase()).filter(Boolean);

        if (q) list = list.filter(c => c.name.toLowerCase().includes(q) || c.description_preview.toLowerCase().includes(q));
        if (creator) list = list.filter(c => c.creator.toLowerCase() === creator);
        if (nsfw === 'false') list = list.filter(c => !c.nsfw);
        if (nsfw === 'true') list = list.filter(c => c.nsfw);
        if (hasBook === 'true') list = list.filter(c => c.has_lorebook);
        if (hasBook === 'false') list = list.filter(c => !c.has_lorebook);
        if (tags.length) list = list.filter(c => tags.every(t => c.tags.includes(t)));
        if (excludeTags.length) list = list.filter(c => !c.tags.some(t => excludeTags.includes(t.toLowerCase())));

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ total: list.length, limit: 48, offset: 0, results: list }));
        return;
    }

    if (u.pathname === '/api/favorites' || u.pathname === '/api/favorites/check') {
        // the account's own list: a session is required, as on charavault.net
        if (!/^Bearer sess_\d+$/.test(String(req.headers.authorization || ''))) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ detail: 'Not authenticated' }));
            return;
        }
        const p = u.searchParams.get('path');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (u.pathname === '/api/favorites/check') {
            res.end(JSON.stringify({ is_favorite: favoritePaths.has(p) }));
        } else if (req.method === 'POST') {
            favoritePaths.add(p);
            res.end(JSON.stringify({ favorited: true }));
        } else if (req.method === 'DELETE') {
            favoritePaths.delete(p);
            res.end(JSON.stringify({ favorited: false }));
        } else {
            const cards = MOCK_CARDS.filter(c => favoritePaths.has(`${c.folder}/${c.file}`));
            res.end(JSON.stringify({ total: cards.length, cards }));
        }
        return;
    }

    if (u.pathname === '/api/cards/revisions') {
        const revisions = u.searchParams.get('path') === 'cards/Adley_5412114.png' ? [
            { id: 11, rev: 1, status: 'superseded', message: '', created_at: '2026-01-02T00:00:00', decided_at: '2026-01-03T00:00:00' },
            { id: 12, rev: 2, status: 'live', message: 'Fixed the greeting', created_at: '2026-02-01T00:00:00', decided_at: '2026-02-02T00:00:00' },
            { id: 13, rev: 3, status: 'pending', message: 'Not reviewed yet', created_at: '2026-03-01T00:00:00', decided_at: null },
        ] : [];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ revisions }));
        return;
    }

    if (u.pathname === '/api/cards/revision-file') {
        if (u.searchParams.get('path') !== 'cards/Adley_5412114.png' || u.searchParams.get('id') !== '11') {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ detail: 'Revision not found' }));
            return;
        }
        // r1 is a flat V1 card, as old uploads often are
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(writeCardChunks(basePng, { name: 'Adley', description: 'The first Adley.', first_mes: 'Halt.' }));
        return;
    }

    if (u.pathname === '/api/cards/rating') {
        if (failRatingMode) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ detail: 'Rating DB error' }));
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ avg_rating: 4.7, rating_count: 15, user_rating: null }));
        return;
    }

    if (u.pathname === '/api/cards/similar') {
        const p = u.searchParams.get('path') || '';
        if (p.includes('Venti_0075')) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ detail: 'Source card not found' }));
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            source: { path: p, name: 'Adley', folder: 'cards', file: 'Adley_5412114.png' },
            similar_count: 1,
            similar: [
                {
                    path: 'sakura_cards/Venti_0075.png',
                    folder: 'sakura_cards',
                    file: 'Venti_0075.png',
                    name: 'Agent 0075',
                    creator: 'spy_master',
                    nsfw: true,
                    score: 88.4,
                    reasons: ['visual hash (88%)'],
                },
            ],
        }));
        return;
    }

    const lorebooksMatch = u.pathname.match(/^\/api\/cards\/([^/]+)\/([^/]+)\/lorebooks$/);
    if (lorebooksMatch) {
        if (failLinkedLorebooksMode) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ detail: 'Lorebooks upstream down' }));
            return;
        }
        const folder = decodeURIComponent(lorebooksMatch[1]);
        const file = decodeURIComponent(lorebooksMatch[2]);
        if (folder === 'cards' && file === 'Adley_5412114.png') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                card_name: 'Adley',
                lorebooks: [
                    { id: 101, name: 'Northern Border Lore', creator: 'novelist_one', entry_count: 2, token_count: 640, source: 'linked' },
                    { id: 102, name: 'Embedded Duplicate', creator: 'novelist_one', entry_count: 1, token_count: 120, source: 'embedded' },
                ],
            }));
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ card_name: file, lorebooks: [] }));
        return;
    }

    const detailMatch = u.pathname.match(/^\/api\/cards\/([^/]+)\/([^/]+)$/);
    if (detailMatch) {
        const folder = decodeURIComponent(detailMatch[1]);
        const file = decodeURIComponent(detailMatch[2]);
        const found = MOCK_CARDS.find(c => c.folder === folder && c.file === file);
        if (folder === 'nsfwaichat' && file === '2B_flat.png') {
            // a V1 card: charavault answers its fields flat, with no { spec, data } wrapper
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                entry: { folder, file, name: '2B', creator: '', tags: ['Female'], nsfw: false, description_preview: 'Created by Yorha' },
                full_metadata: {
                    name: '2B',
                    description: 'Created by Yorha, to fight in the 14 machine war.',
                    personality: '',
                    scenario: '2B finds a human, wounded and malnourished.',
                    first_mes: '*I change your bandages again.*',
                    mes_example: '{{random_user_1}}: Hello, 2B!',
                    creator_notes: '2B finds you, a human, wounded.',
                    tags: ['Female'],
                },
                recommendations: null,
            }));
            return;
        }
        if (!found) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ detail: 'Card not found' }));
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            entry: { ...found },
            full_metadata: {
                spec: 'chara_card_v2',
                spec_version: '2.0',
                data: {
                    name: found.name,
                    description: `${found.name} full character definition.`,
                    personality: 'Steadfast and observant.',
                    scenario: 'At the northern watchtower.',
                    first_mes: found.first_mes_preview,
                    mes_example: '<START>\n{{user}}: Hi\n{{char}}: Hello.',
                    creator_notes: 'Created for testing CharaVault.',
                    system_prompt: '',
                    post_history_instructions: '',
                    alternate_greetings: ['Greeting Two', 'Greeting Three'],
                    tags: found.tags,
                    creator: found.creator,
                    character_version: '1.0',
                    character_book: found.has_lorebook ? {
                        name: 'Embedded Adley Lore',
                        entries: [
                            { id: 1, keys: ['adley'], comment: 'Adley Bio', content: 'Adley is a border ranger.', enabled: true, insertion_order: 10 },
                        ],
                    } : undefined,
                    extensions: {
                        // Foreign provider namespace from a reupload — should be stripped on build!
                        chub: { id: 99999, full_path: 'someone/adley' },
                        depth_prompt: { depth: 4, prompt: 'Stay in character.' },
                    },
                },
            },
            recommendations: {
                tier_label: 'Moderate',
                tier_description: 'Recommended 13B+ or modern 8B model.',
                suggested_preset: 'Roleplay',
                token_count: found.token_count,
            },
        }));
        return;
    }

    if (u.pathname === '/api/tags/search') {
        if (failTagsSearchOnce) {
            failTagsSearchOnce = false;
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ detail: 'Not found' }));
            return;
        }
        const q = (u.searchParams.get('q') || '').toLowerCase();
        const all = [['Fantasy', 1200], ['Adventure', 800], ['Espionage', 350], ['Female', 5000]];
        const filtered = q ? all.filter(([t]) => t.toLowerCase().includes(q)) : all;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ tags: filtered }));
        return;
    }

    if (u.pathname === '/api/tags') {
        if (tags5xxRemaining > 0) {
            tags5xxRemaining--;
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ detail: 'Temporary error' }));
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ tags: [['Fantasy', 1200], ['FallbackTag', 42]] }));
        return;
    }

    if (u.pathname === '/api/lorebooks') {
        const q = (u.searchParams.get('q') || '').toLowerCase();
        const nsfw = u.searchParams.get('nsfw');
        let list = [...MOCK_LOREBOOKS];
        if (q) list = list.filter(lb => lb.name.toLowerCase().includes(q) || lb.keywords.toLowerCase().includes(q));
        if (nsfw === 'false') list = list.filter(lb => !lb.nsfw);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ total: list.length, limit: 48, offset: 0, count: list.length, lorebooks: list }));
        return;
    }

    const lbDetailMatch = u.pathname.match(/^\/api\/lorebooks\/(\d+)$/);
    if (lbDetailMatch) {
        const id = Number(lbDetailMatch[1]);
        const found = MOCK_LOREBOOKS.find(l => l.id === id);
        if (!found) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ detail: 'Lorebook not found' }));
            return;
        }
        if (id === 103) {
            // Native SillyTavern world-format fixture (object-keyed entries, numeric position=4 @depth, depth=2, caseSensitive=true, sticky=3)
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                ...found,
                full_data: {
                    name: found.name,
                    entries: {
                        0: {
                            uid: 7,
                            key: ['citadel', 'high tower'],
                            keysecondary: ['mage'],
                            comment: 'Citadel Rule',
                            content: 'Injected at depth 2.',
                            constant: false,
                            selective: true,
                            order: 55,
                            disable: false,
                            position: 4,
                            depth: 2,
                            probability: 75,
                            useProbability: true,
                            selectiveLogic: 2,
                            caseSensitive: true,
                            sticky: 3,
                        },
                    },
                },
            }));
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            ...found,
            content: {
                name: found.name,
                description: found.description,
                scan_depth: 4,
                token_budget: 640,
                recursive_scanning: true,
                extensions: {},
                entries: [
                    {
                        id: 1,
                        name: 'Frostwood Watchtower',
                        comment: 'Frostwood Watchtower',
                        keys: ['watchtower', 'frostwood'],
                        secondary_keys: [],
                        content: 'The Frostwood Watchtower guards the northern pass.',
                        enabled: true,
                        insertion_order: 20,
                        constant: false,
                        selective: true,
                        position: 'before_char',
                        probability: 90,
                        selectiveLogic: 1,
                        extensions: { depth: 4 },
                    },
                ],
            },
        }));
        return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ detail: 'Unhandled mock route: ' + u.pathname }));
});

await new Promise(resolve => mockUpstream.listen(0, '127.0.0.1', resolve));
await new Promise(resolve => evilServer.listen(0, '127.0.0.1', resolve));
const mockBase = `http://127.0.0.1:${mockUpstream.address().port}`;
const evilBase = `http://localhost:${evilServer.address().port}`;

const sigma = await startSigma({ prefix: 'charavault-test', extensions: [path.join(here, '..')] });
let page = null;

after(async () => {
    try { page?.close(); } catch { /* ignore */ }
    await sigma.close();
    await new Promise(resolve => mockUpstream.close(resolve));
    await new Promise(resolve => evilServer.close(resolve));
});

const me = sigma.session;
const cvExt = me.ext('charavault');
await me.enable('charavault', true);

beforeEach(async () => {
    process.env.CL_ALLOW_PRIVATE_FETCH = 'true';
    failTagsSearchOnce = false;
    tags5xxRemaining = 0;
    failRatingMode = false;
    failLinkedLorebooksMode = false;
    thumbReturnHtmlMode = false;
    thumbReturn503Mode = false;
    redirectTargetUrl = null;
    upstreamRequests.length = 0;
    evilRedirectRequests.length = 0;
    await me.api('/settings', 'PATCH', {
        'ext:charavault:gatewayUrl': `${mockBase}/api`,
        'ext:charavault:gatewayCdnUrl': mockBase,
        'ext:charavault:appPassword': '',
        'ext:charavault:email': '',
        'ext:charavault:gatewayKey': '',
    });
    loginAttempts.length = 0;
    sessionCounter = 0;
    revokeSessionOnce = false;
    forgetCvSessions();
});

test('app password login: email + cv_ token log in once, the session rides as Bearer, a 401 logs in again, and /auth/check reports it', async () => {
    // no email: no login, no Authorization
    await me.api('/settings', 'PATCH', { 'ext:charavault:appPassword': 'cv_good_app_pw' });
    await cvExt('/cards?nsfw=true');
    assert.equal(loginAttempts.length, 0);
    assert.equal(upstreamRequests.at(-1).headers.authorization, undefined);
    assert.equal(upstreamRequests.at(-1).headers['x-app-password'], undefined, 'the raw app password is never sent to the API');

    // the checkmark with the wrong password says why
    const bad = await me.api('/ext/charavault/auth/check', 'POST', { email: 'me@example.com', appPassword: 'cv_wrong' });
    assert.equal(bad.body.ok, false);
    assert.match(bad.body.error, /Invalid email or password/);
    const notApp = await me.api('/ext/charavault/auth/check', 'POST', { email: 'me@example.com', appPassword: 'hunter2' });
    assert.equal(notApp.body.ok, false);
    assert.match(notApp.body.error, /App Password/);

    // saved email + app password: one login, then every request carries the session
    await me.api('/settings', 'PATCH', { 'ext:charavault:email': 'me@example.com' });
    const good = await me.api('/ext/charavault/auth/check', 'POST', {});
    assert.equal(good.body.ok, true);
    assert.equal(good.body.name, 'Tester');
    assert.equal(good.body.nsfwVerified, true);
    const loginsAfterCheck = loginAttempts.length;
    await cvExt('/cards?nsfw=true');
    await cvExt('/cards?nsfw=false');
    assert.equal(loginAttempts.length, loginsAfterCheck, 'the checked session is reused');
    assert.equal(upstreamRequests.at(-1).headers.authorization, 'Bearer sess_' + sessionCounter);

    // the same-host CDN thumbnail gets the session too (unblurred NSFW thumbs)
    await me.apiRequest('/ext/charavault/thumb/cards/Adley_5412114.png');
    assert.equal(upstreamRequests.at(-1).headers.authorization, 'Bearer sess_' + sessionCounter);

    // a revoked session (the cached sess_1 now answers 401): one re-login and a retry
    const loginsBefore = loginAttempts.length;
    revokeSessionOnce = true;
    const retried = await cvExt('/cards');
    assert.equal(retried.status, 200);
    assert.equal(loginAttempts.length, loginsBefore + 1, 'exactly one re-login');
    assert.equal(upstreamRequests.at(-1).headers.authorization, 'Bearer sess_' + sessionCounter);
    assert.notEqual(upstreamRequests.at(-1).headers.authorization, 'Bearer sess_1');
});

test('account status and favorites: the status names the login, favorites need it, and add/remove round-trip', async () => {
    favoritePaths.clear();
    // no login saved
    let status = await cvExt('/auth/status');
    assert.equal(status.status, 200);
    assert.deepEqual(status.body, { configured: false, loggedIn: false });
    assert.equal((await cvExt('/favorites')).status, 401, 'favorites without a login answer CharaVault\'s 401');

    // a working login
    await me.api('/settings', 'PATCH', { 'ext:charavault:email': 'me@example.com', 'ext:charavault:appPassword': 'cv_good_app_pw' });
    status = await cvExt('/auth/status');
    assert.equal(status.body.loggedIn, true);
    assert.equal(status.body.name, 'Tester');
    assert.equal(status.body.nsfwVerified, true);

    const adley = encodeURIComponent('cards/Adley_5412114.png');
    assert.equal((await cvExt('/favorites/check?path=' + adley)).body.is_favorite, false);
    const added = await cvExt('/favorites?path=' + adley, 'POST');
    assert.equal(added.status, 200);
    assert.equal(added.body.favorited, true);
    assert.equal(upstreamRequests.at(-1).method, 'POST');
    assert.equal(upstreamRequests.at(-1).searchParams.path, 'cards/Adley_5412114.png');
    assert.equal((await cvExt('/favorites/check?path=' + adley)).body.is_favorite, true);
    const list = await cvExt('/favorites?limit=48&offset=0');
    assert.equal(list.body.total, 1);
    assert.equal(list.body.cards[0].name, 'Adley');
    const removed = await cvExt('/favorites?path=' + adley, 'DELETE');
    assert.equal(removed.body.favorited, false);
    assert.equal(upstreamRequests.at(-1).method, 'DELETE');
    assert.equal((await cvExt('/favorites?path=' + encodeURIComponent('../auth/me'), 'POST')).status, 400, 'a traversal path never reaches CharaVault');

    // a wrong app password: configured, not logged in, and why
    forgetCvSessions();
    await me.api('/settings', 'PATCH', { 'ext:charavault:appPassword': 'cv_wrong' });
    status = await cvExt('/auth/status');
    assert.equal(status.body.configured, true);
    assert.equal(status.body.loggedIn, false);
    assert.equal(status.body.error, 'Invalid email or password');
});

test('server proxy routes forward queries, attach User-Agent & auth headers, strip CORP, and set sandbox CSP', async () => {
    // 1. Unit check for resolveCvBases derivation (/v1/cv -> /v1/cv-cdn, /api stripping, CDN override)
    const mockCtx = (map) => ({ setting: (_db, k) => map[k] || '' });
    assert.deepEqual(resolveCvBases({}, mockCtx({})), {
        apiBase: 'https://charavault.net/api',
        cdnBase: 'https://charavault.net',
    });
    assert.deepEqual(resolveCvBases({}, mockCtx({ gatewayUrl: 'https://proxy.example.com/v1/cv/' })), {
        apiBase: 'https://proxy.example.com/v1/cv',
        cdnBase: 'https://proxy.example.com/v1/cv-cdn',
    });
    assert.deepEqual(resolveCvBases({}, mockCtx({ gatewayUrl: 'https://proxy.example.com/api' })), {
        apiBase: 'https://proxy.example.com/api',
        cdnBase: 'https://proxy.example.com',
    });
    assert.deepEqual(resolveCvBases({}, mockCtx({ gatewayUrl: 'https://proxy.example.com/v1/cv', gatewayCdnUrl: 'https://cdn.example.com/' })), {
        apiBase: 'https://proxy.example.com/v1/cv',
        cdnBase: 'https://cdn.example.com',
    });

    // 2. Cards search
    const cardsRes = await cvExt('/cards?q=Adley&nsfw=false&sort=most_downloaded&limit=10');
    assert.equal(cardsRes.status, 200);
    assert.equal(cardsRes.body.total, 1);
    assert.equal(cardsRes.body.results[0].name, 'Adley');
    assert.ok(upstreamRequests.at(-1).headers['user-agent'].includes('Mozilla/5.0'));

    // 2b. Version history routes: the path rides encoded as one value, ids are digits, traversal is refused
    const revs = await cvExt('/cards/revisions?path=' + encodeURIComponent('cards/Adley_5412114.png'));
    assert.equal(revs.status, 200);
    assert.equal(revs.body.revisions.length, 3);
    assert.equal(upstreamRequests.at(-1).searchParams.path, 'cards/Adley_5412114.png');
    assert.equal((await cvExt('/cards/revisions?path=' + encodeURIComponent('../auth/me'))).status, 400);
    assert.equal((await cvExt('/cards/revision-file?path=' + encodeURIComponent('cards/Adley_5412114.png') + '&id=1;drop')).status, 400);

    // 3. Detail route preserves recommendations
    const detailRes = await cvExt('/cards/detail?folder=cards&file=Adley_5412114.png');
    assert.equal(detailRes.status, 200);
    assert.equal(detailRes.body.entry.name, 'Adley');
    assert.equal(detailRes.body.recommendations.tier_label, 'Moderate');

    // 4. Thumbnail, download, and favicon routes set CORP: same-origin, CSP: sandbox, and never send credentials to CDN
    await me.api('/settings', 'PATCH', {
        'ext:charavault:appPassword': 'cv_secret_app_pw',
        'ext:charavault:gatewayKey': 'gw_secret_token',
    });
    const thumbRaw = await me.apiRequest('/ext/charavault/thumb/cards/Adley_5412114.png');
    assert.equal(thumbRaw.status, 200);
    assert.equal(thumbRaw.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.equal(thumbRaw.headers.get('content-security-policy'), 'sandbox');
    assert.equal(thumbRaw.headers.get('cache-control'), 'private, max-age=604800');
    const thumbUpstreamReq = upstreamRequests.at(-1);
    assert.equal(thumbUpstreamReq.headers['x-app-password'], undefined, 'CDN thumb route must not receive X-App-Password');
    assert.equal(thumbUpstreamReq.headers.authorization, undefined, 'CDN thumb route must not receive Authorization');

    const dlRaw = await me.apiRequest('/ext/charavault/cards/download/cards/Adley_5412114.png');
    assert.equal(dlRaw.status, 200);
    assert.equal(dlRaw.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.equal(dlRaw.headers.get('content-security-policy'), 'sandbox');
    const dlUpstreamReq = upstreamRequests.at(-1);
    assert.equal(dlUpstreamReq.headers['x-app-password'], 'cv_secret_app_pw');
    assert.equal(dlUpstreamReq.headers.authorization, 'Bearer gw_secret_token');

    const favRaw = await me.apiRequest('/ext/charavault/favicon.ico');
    assert.equal(favRaw.status, 200);
    assert.equal(favRaw.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.equal(favRaw.headers.get('content-security-policy'), 'sandbox');

    // 5. Tags search, fallback to /api/tags, and 3-attempt retry on 5xx
    const tagsRes = await cvExt('/tags?q=fan&limit=10');
    assert.equal(tagsRes.status, 200);
    assert.deepEqual(tagsRes.body.tags, [['Fantasy', 1200]]);

    failTagsSearchOnce = true;
    tags5xxRemaining = 2; // first 2 /api/tags attempts return 503, 3rd succeeds
    const fallbackTagsRes = await cvExt('/tags?q=Fallback&limit=10');
    assert.equal(fallbackTagsRes.status, 200);
    assert.deepEqual(fallbackTagsRes.body.tags, [['FallbackTag', 42]]);
    assert.equal(tags5xxRemaining, 0, 'all retry attempts should have been consumed before succeeding');

    // 6. Lorebooks sorting (entries_desc vs tokens_desc vs newest)
    const lbEntries = await cvExt('/lorebooks?sort=entries_desc');
    assert.equal(lbEntries.status, 200);
    assert.deepEqual(lbEntries.body.lorebooks.map(l => l.id), [103, 101, 102]);
});

test('security guards: SSRF loopback/metadata rejection, off-host redirect blocking, path traversal rejection, and image Content-Type enforcement', async () => {
    // 1. SSRF protection when CL_ALLOW_PRIVATE_FETCH is disabled
    process.env.CL_ALLOW_PRIVATE_FETCH = 'false';
    await assert.rejects(() => assertSafeUpstreamUrl('http://127.0.0.1:8080/api/cards'), /private or loopback/);
    await assert.rejects(() => assertSafeUpstreamUrl('http://169.254.169.254/latest/meta-data/'), /private or loopback/);
    await assert.rejects(() => assertSafeUpstreamUrl('http://localhost:7788/api'), /blocked/);
    await assert.rejects(() => assertSafeUpstreamUrl('http://[::1]:7788/api'), /private or loopback/);
    await assert.rejects(() => assertSafeUpstreamUrl('http://charavault.net/api', { multiUser: true }), /HTTPS/);

    const ssrfRes = await cvExt('/cards');
    assert.equal(ssrfRes.status, 403, 'loopback gatewayUrl must be blocked with 403 when private fetch is off');
    process.env.CL_ALLOW_PRIVATE_FETCH = 'true';

    // 2. Off-host redirect blocking (prevents leaking X-App-Password to a redirect target)
    await me.api('/settings', 'PATCH', {
        'ext:charavault:appPassword': 'cv_super_secret_do_not_leak',
    });
    redirectTargetUrl = `${evilBase}/steal`;
    const redirRes = await cvExt('/cards');
    assert.equal(redirRes.status, 502, 'cross-host redirect must be refused with 502');
    assert.equal(evilRedirectRequests.length, 0, 'redirect target must never be contacted');
    redirectTargetUrl = null;

    // 3. Path traversal rejection on server routes
    const trav1 = await cvExt('/cards/detail?folder=..&file=auth');
    assert.equal(trav1.status, 400);
    const trav2 = await cvExt('/cards/detail?folder=cards&file=..%2Fauth');
    assert.equal(trav2.status, 400);
    const trav3 = await cvExt('/cards/rating?path=cards/../auth');
    assert.equal(trav3.status, 400);
    const trav4 = await cvExt('/lorebooks/not-a-number');
    assert.equal(trav4.status, 400);

    // 4. HTML disguised as thumbnail is rejected with 502, and 503 thumbnail is never cached for a week
    thumbReturnHtmlMode = true;
    const htmlThumb = await me.apiRequest('/ext/charavault/thumb/cards/Adley_5412114.png');
    assert.equal(htmlThumb.status, 502);
    thumbReturnHtmlMode = false;

    thumbReturn503Mode = true;
    const errThumb = await me.apiRequest('/ext/charavault/thumb/cards/Adley_5412114.png');
    assert.equal(errThumb.status, 503);
    assert.equal(errThumb.headers.get('cache-control'), 'no-store');
    thumbReturn503Mode = false;
});

test('client extension boots, renders settings & preview modal (with failed rating/lorebooks resilience), imports character, and preserves SillyTavern world lorebook fields', async () => {
    page = await me.page();
    page.CoreAPI.applyTagAliases = (tags) => tags;
    page.CoreAPI.embedCharacterDataInPng = (buf, card) => writeCardChunks(Buffer.from(buf), card);
    page.CoreAPI.findCharacterMediaUrls = () => [];
    page.CoreAPI.ensureExtractorsLoaded = async () => {};
    page.CoreAPI.findCharacterGalleryUrls = () => [];
    page.CoreAPI.extractCharacterDataFromPng = (buf) => {
        const found = readCardChunks(Buffer.from(buf));
        return found ? (found.v3 || found.v2) : null;
    };
    await page.boot();
    // the app's on(id, event, handler) (library.js), which CoreAPI.onElement calls: without it
    // every button the browse view wires by id would be inert here
    globalThis.window.onElement = (id, event, handler) => {
        const el = page.document.getElementById(id);
        if (!el) return false;
        el.addEventListener(event, handler);
        return true;
    };

    // 1. Verify global handle, host registration log, and provider manifest registration
    assert.deepEqual(page.log.providersIn, ['charavault']);
    assert.deepEqual(page.log.injected, ['charavault']);
    const handle = globalThis.window.__SIGMA_CHARAVAULT__;
    assert.ok(handle, '__SIGMA_CHARAVAULT__ handle should be mounted');
    assert.equal(handle.version, '1.0.0');
    const provider = handle.provider;
    assert.equal(provider.id, 'charavault');
    assert.ok(globalThis.window.PROVIDER_MANIFEST.charavault);

    // 2. Verify Settings > Online > CharaVault section renders & persists
    const settingsSlot = page.document.createElement('div');
    page.document.body.appendChild(settingsSlot);
    handle.renderSettings(settingsSlot);
    const pwInput = page.document.getElementById('settingsCharavaultAppPassword');
    const gwDetails = page.document.getElementById('cvGatewayAdvanced');
    const eyeBtn = page.document.getElementById('toggleCharavaultAppPasswordVisibility');
    assert.ok(pwInput, 'App Password input should be rendered');
    assert.ok(gwDetails, 'Gateway <details> drawer should be rendered');
    assert.equal(gwDetails.hasAttribute('open'), true, 'Gateway <details> should auto-open when gatewayUrl is configured');
    assert.equal(pwInput.type, 'password');
    eyeBtn.click();
    assert.equal(pwInput.type, 'text', 'Eye button should toggle password input to text');

    // 3. Verify URL parsing & traversal defense on client
    assert.equal(provider.canHandleUrl('https://charavault.net/cards/preview/cards/Adley_5412114.png'), true);
    assert.equal(provider.parseUrl('https://charavault.net/cards/preview/cards/Adley_5412114.png'), 'cards/Adley_5412114.png');
    assert.equal(provider.parseUrl('https://charavault.net/cards/preview/../auth'), null, 'parseUrl must reject .. traversal');
    assert.equal(provider.parseUrl('https://charavault.net/cards/preview/cards/%E0%A4%A'), null, 'parseUrl must not throw on malformed percent-encoding');
    assert.equal(provider.readLink({ id: '../auth' }), null, 'readLink must reject traversal paths in crafted cards');
    // charavault.net has no per-card page: the link is the card file URL, and it must read back as the same card
    const cardLink = provider.getCharacterUrl({ fullPath: 'janitorai/d81_Hayami The Sensei.card.png' });
    assert.equal(cardLink, 'https://charavault.net/cards/janitorai/d81_Hayami%20The%20Sensei.card.png');
    assert.equal(provider.parseUrl(cardLink), 'janitorai/d81_Hayami The Sensei.card.png', 'getCharacterUrl must round-trip through parseUrl');

    // 4. Verify remote card & linked lorebook resolution + transient failure handling (_lorebookUnread)
    const remoteCard = await provider.fetchRemoteCard({ fullPath: 'cards/Adley_5412114.png' });
    assert.ok(remoteCard);
    assert.equal(remoteCard.data.name, 'Adley');
    assert.equal(remoteCard.data.extensions.chub, undefined, 'foreign chub namespace should be stripped');
    assert.equal(remoteCard.data.extensions.depth_prompt?.depth, 4, 'non-provider extensions should be preserved');
    assert.equal(remoteCard.data.character_book?.entries?.length, 2);
    assert.equal(remoteCard._lorebookUnread, undefined);

    // When linked lorebooks endpoint fails transiently (502), fetchRemoteCard marks _lorebookUnread = true
    failLinkedLorebooksMode = true;
    const partialRemoteCard = await provider.fetchRemoteCard({ fullPath: 'cards/Adley_5412114.png' });
    assert.equal(partialRemoteCard._lorebookUnread, true, 'transient linked lorebook error must mark _lorebookUnread');
    failLinkedLorebooksMode = false;

    // 404 card returns null via nullOnMiss
    const missingRemote = await provider.fetchRemoteCard({ fullPath: 'cards/NonExistent_999.png' });
    assert.equal(missingRemote, null);

    // 5. Verify BrowseView DOM & openCvPreview resilience when rating or lorebooks fail (H4 regression check)
    const viewWrapper = page.document.createElement('div');
    viewWrapper.innerHTML = handle.browseView.renderFilterBar() + handle.browseView.renderView() + handle.browseView.renderModals();
    page.document.body.appendChild(viewWrapper);
    handle.browseView.init();

    failRatingMode = true;
    failLinkedLorebooksMode = true;
    await provider.openPreview({ ...MOCK_CARDS[0], fullPath: 'cards/Adley_5412114.png' });
    const modal = page.document.getElementById('cvCharModal');
    assert.equal(modal.classList.contains('hidden'), false, 'Preview modal should open');
    const tierLabel = page.document.getElementById('cvCharTierLabel');
    assert.equal(tierLabel.textContent, 'Moderate', 'Detail & recommendations must still render even when rating & lorebooks endpoints fail');
    failRatingMode = false;
    failLinkedLorebooksMode = false;
    // the section reads "Description", like every other provider, not the PR's "Character Definition"
    assert.equal(page.document.querySelector('[data-section="cvCharDescription"]').dataset.label, 'Description');
    handle.browseView.closePreview();

    // 5b. A flat V1 full_metadata (no { data } wrapper) still fills every field, and the
    // creator's notes are the notes, not the description preview
    await provider.openPreview({ folder: 'nsfwaichat', file: '2B_flat.png', name: '2B', description_preview: 'Created by Yorha', fullPath: 'nsfwaichat/2B_flat.png' });
    await new Promise(r => setTimeout(r, 50));
    for (const id of ['cvCharDescriptionSection', 'cvCharScenarioSection', 'cvCharFirstMsgSection', 'cvCharExamplesSection']) {
        assert.equal(page.document.getElementById(id).hidden, false, `${id} must show for a flat V1 card`);
    }
    assert.equal(page.document.getElementById('cvCharPersonalitySection').hidden, true, 'an empty personality stays hidden');
    const flatCard = await provider.fetchRemoteCard({ fullPath: 'nsfwaichat/2B_flat.png' });
    assert.equal(flatCard.data.description, 'Created by Yorha, to fight in the 14 machine war.');
    assert.equal(flatCard.data.creator_notes, '2B finds you, a human, wounded.');
    assert.equal(flatCard.data.mes_example, '{{random_user_1}}: Hello, 2B!');
    handle.browseView.closePreview();

    // 6. Verify full character import into Project Σ library
    const importRes = await provider.importCharacter('cards/Adley_5412114.png', MOCK_CARDS[0]);
    assert.equal(importRes.success, true, `importCharacter failed: ${importRes.error}`);
    assert.equal(importRes.characterName, 'Adley');

    const charResp = await me.api(`/characters/${importRes.id}`);
    assert.equal(charResp.status, 200);
    assert.equal(charResp.body.card.data.name, 'Adley');
    assert.equal(charResp.body.card.data.character_book.entries.length, 2);

    // 7. Verify Visually Similar API handling (no_path when path is omitted, match when path is given, no_hash on 404)
    const { fetchCvSimilar } = await import(pathToFileURL(path.join(here, '../client/charavault-api.js')).href);
    const simNoPath = await fetchCvSimilar({ folder: 'cards', file: 'Adley_5412114.png' });
    assert.equal(simNoPath.ok, false);
    assert.equal(simNoPath.reason, 'no_path', 'fetchCvSimilar must require entry.path and not fall back to folder/file');

    const simOk = await fetchCvSimilar({ path: '/mnt/sde2/CharacterCards/chub/cards/Adley_5412114.png', folder: 'cards', file: 'Adley_5412114.png' });
    assert.equal(simOk.ok, true);
    assert.equal(simOk.results.length, 1);
    assert.equal(simOk.results[0].name, 'Agent 0075');

    const simNoHash = await fetchCvSimilar({ path: 'sakura_cards/Venti_0075.png', folder: 'sakura_cards', file: 'Venti_0075.png' });
    assert.equal(simNoHash.ok, false);
    assert.equal(simNoHash.reason, 'no_hash');

    // 8. Verify LorebookView adapter + SillyTavern world-format preservation (M4 & L9)
    const lorebookAdapter = provider.lorebookView.adapter;
    const lbPage = await lorebookAdapter.fetchPage({ query: '', sort: 'entries_desc', nsfw: true, page: 1, limit: 48 });
    assert.equal(lbPage.hits.length, 3);
    assert.equal(lbPage.hits[0].id, '103');
    assert.equal(lbPage.hits[0].path, 'worlds/SillyWorld.lorebook.json', 'normalizeCvLorebook must not leak upstream /mnt/... disk paths');

    const worldFetched = await lorebookAdapter.fetchBook(lbPage.hits[0]);
    const entry0 = worldFetched.book.entries[0];
    assert.equal(entry0.comment, 'Citadel Rule');
    assert.equal(entry0.position, 'after_char');
    assert.equal(entry0.extensions.position, 4, 'numeric @depth position (4) must be preserved in extensions.position');
    assert.equal(entry0.extensions.depth, 2, 'world depth (2) must be preserved in extensions.depth');
    assert.equal(entry0.extensions.probability, 75);
    assert.equal(entry0.extensions.useProbability, true);
    assert.equal(entry0.extensions.selectiveLogic, 2);
    assert.equal(entry0.extensions.case_sensitive, true, 'caseSensitive must map to extensions.case_sensitive');
    assert.equal(entry0.extensions.sticky, 3, 'sticky must be preserved in extensions.sticky');

    // 9. A PNG downloaded from charavault.net and imported as a file links itself (enrichUnlinkedImport)
    const v1 = (name, creator) => ({ data: { name, creator, extensions: {} } });
    const byFile = await provider.enrichLocalImport(v1('Twin Sensei', ''), 'd81_Twin Sensei.card (1).png');
    assert.equal(byFile?.providerInfo.fullPath, 'janitorai/d81_Twin Sensei.card.png', 'the download file name picks the right one of two same-named cards, even with a browser (1) suffix');
    assert.equal(byFile.cardData.data.extensions.charavault.fullPath, 'janitorai/d81_Twin Sensei.card.png');
    assert.equal(provider.getLinkInfo(byFile.cardData)?.fullPath, 'janitorai/d81_Twin Sensei.card.png', 'the written link reads back');
    const byCreator = await provider.enrichLocalImport(v1('Twin Sensei', 'Sensei_Maker'), 'renamed.png');
    assert.equal(byCreator?.providerInfo.fullPath, 'cards/Twin Sensei_0f1e.png', 'a unique name + creator match links without the file name');
    assert.equal(await provider.enrichLocalImport(v1('Twin Sensei', 'Unknown'), 'renamed.png'), null, 'the archive placeholder creator "Unknown" is no proof');
    assert.equal(await provider.enrichLocalImport(v1('Twin Sensei', ''), 'renamed.png'), null, 'a name alone never links');
    assert.equal(await provider.enrichLocalImport(v1('', 'x'), 'd81_Twin Sensei.card.png'), null);
    const already = { data: { name: 'Adley', extensions: { charavault: { id: 'cards/Adley_5412114.png', fullPath: 'cards/Adley_5412114.png' } } } };
    assert.equal((await provider.enrichLocalImport(already, 'x.png'))?.providerInfo.fullPath, 'cards/Adley_5412114.png', 'an already-linked card keeps its link');

    // 10. Version history: approved revisions only, newest first, and an old revision's card as flat fields
    assert.equal(provider.supportsVersionHistory, true);
    const versions = await provider.fetchVersionList({ fullPath: 'cards/Adley_5412114.png' });
    assert.deepEqual(versions.map(v => v.ref), ['r2-12', 'r1-11'], 'pending revisions are not part of the history');
    assert.equal(versions[0].message, 'Fixed the greeting (current)');
    assert.equal(versions[1].message, 'First upload');
    assert.deepEqual(await provider.fetchVersionList({ fullPath: 'cards/Venti_0075.png' }), []);
    const r1 = await provider.fetchVersionData({ fullPath: 'cards/Adley_5412114.png' }, 'r1-11');
    assert.equal(r1.description, 'The first Adley.', 'a flat V1 revision answers its fields');
    assert.equal(r1.first_mes, 'Halt.');
    assert.equal(await provider.fetchVersionData({ fullPath: 'cards/Adley_5412114.png' }, 'r9-99'), null, 'a refused revision answers null');
    assert.equal(await provider.fetchVersionData({ fullPath: 'cards/Adley_5412114.png' }, '../x'), null);

    // 11. Account bar + favorites, through the real browse DOM
    const waitFor = async (check, what) => {
        for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(r => setTimeout(r, 10)); }
        assert.fail(`timed out waiting for ${what} (last toasts: ${JSON.stringify(page.log.toasts.slice(-2))})`);
    };
    const $ = (id) => page.document.getElementById(id);
    favoritePaths.clear();
    // logged out: the bar offers the login, Favorites stays hidden
    await handle.refreshAccount();
    assert.equal($('cvAccountLabel').textContent, 'Log in for 18+ cards & favorites');
    assert.equal($('cvFavoritesBtn').hidden, true);
    assert.equal(provider.isAuthenticated, false);
    // log in: the server reads its settings, the page its own (typed into Settings like a user would)
    await me.api('/settings', 'PATCH', { 'ext:charavault:email': 'me@example.com', 'ext:charavault:appPassword': 'cv_good_app_pw' });
    for (const [id, value] of [['settingsCharavaultEmail', 'me@example.com'], ['settingsCharavaultAppPassword', 'cv_good_app_pw']]) {
        $(id).value = value;
        $(id).dispatchEvent(new Event('change'));
    }
    assert.equal(provider.isAuthenticated, true);
    await handle.refreshAccount();
    assert.equal($('cvAccountLabel').textContent, 'Logged in as Tester');
    assert.equal($('cvAccountBtn').dataset.state, 'in');
    assert.equal($('cvFavoritesBtn').hidden, false);

    // the preview's heart: shown, reads CharaVault's state, and toggles it
    await provider.openPreview({ ...MOCK_CARDS[0], fullPath: 'cards/Adley_5412114.png' });
    assert.equal($('cvFavBtn').hidden, false);
    await waitFor(() => $('cvFavBtn').dataset.fav === 'false', 'the favorite check');
    $('cvFavBtn').click();
    await waitFor(() => $('cvFavBtn').dataset.fav === 'true', 'the favorite to be added');
    assert.ok(favoritePaths.has('cards/Adley_5412114.png'));
    handle.browseView.closePreview();

    // Favorites mode: the grid is the account's list
    $('cvFavoritesBtn').click();
    assert.equal($('cvFavoritesBtn').getAttribute('aria-pressed'), 'true');
    await waitFor(() => $('cvGrid').querySelectorAll('.browse-card').length === 1, 'the favorites grid');
    assert.equal($('cvGrid').querySelector('.browse-card').dataset.fullPath, 'cards/Adley_5412114.png');
    // un-favoriting from the preview takes the card out of the favorites grid
    await provider.openPreview({ ...MOCK_CARDS[0], fullPath: 'cards/Adley_5412114.png' });
    await waitFor(() => $('cvFavBtn').dataset.fav === 'true', 'the favorite check');
    $('cvFavBtn').click();
    await waitFor(() => $('cvFavBtn').dataset.fav === 'false', 'the favorite to be removed');
    assert.equal($('cvGrid').querySelectorAll('.browse-card').length, 0);
    handle.browseView.closePreview();

    // logging out leaves Favorites
    await me.api('/settings', 'PATCH', { 'ext:charavault:email': '', 'ext:charavault:appPassword': '' });
    $('settingsCharavaultAppPassword').value = '';
    $('settingsCharavaultAppPassword').dispatchEvent(new Event('change'));
    await handle.refreshAccount();
    assert.equal($('cvFavoritesBtn').hidden, true);
    assert.equal($('cvFavoritesBtn').getAttribute('aria-pressed'), 'false', 'a lost login switches Favorites off');
    await waitFor(() => $('cvGrid').querySelectorAll('.browse-card').length > 0, 'the catalog grid to come back');
});
