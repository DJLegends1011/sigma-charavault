# CharaVault for Project Σ (`sigma-charavault`)

Online character and lorebook provider for [Project Σ](https://github.com/Sillyanonymous/SillyTavern-CharacterLibrary) backed by [CharaVault](https://charavault.net), ported and expanded from [AdamsGH's PR #18](https://github.com/Sillyanonymous/SillyTavern-CharacterLibrary/pull/18).

## Features

- **Characters Browse & Search**: Search by keyword, filter by creator, filter by multi-tag typeahead (`/api/tags/search`), filter by lorebook presence (`Any` / `Has lorebook` / `No lorebook`), library filters (`Hide Owned Characters`, `Hide Possible Matches`), 3-state NSFW filter (`SFW Only` / `NSFW Only` / `NSFW + SFW`), and 10 sort modes.
- **Rich Character Preview Modal**: Live rating & vote count, token count, download count, model tier recommendations (`recommended_tier` / `recommendations`), collapsible V2 prompt sections, alternate greetings, and **Visually Similar** image-hash discovery (`/api/cards/similar`).
- **Full Lorebook Integration**:
  - **Character-Linked Lorebooks**: Automatically resolves and merges linked lorebooks on character import and update checks (`resolveCvCharacterBook` / `fetchLorebook`), plus 1-click **Import to Shelf** buttons inside the character preview modal.
  - **Standalone Lorebooks Switcher (`LorebookView`)**: Browse, search, preview entries, and import standalone lorebooks from CharaVault's `/api/lorebooks` catalog directly onto your Lorebook Shelf.
- **Server-Side Proxy & CORS/CORP Bypass (`server/index.js`)**: Routes API calls, thumbnails, favicons, and card PNG downloads through `/api/ext/charavault/*` with a browser User-Agent and stripped `Cross-Origin-Resource-Policy: same-site` headers so CharaVault works out of the box without an external proxy container.
- **Authentication & Optional Gateway Relay (`Settings > Online > CharaVault`)**:
  - **App Password (`cv_...`)**: Optional CharaVault app password for higher rate limits, 18+ NSFW access, and card downloads.
  - **Advanced Gateway Override (optional)**: Optional custom `Gateway URL`, `Gateway CDN URL`, and `Gateway Key` tucked inside an `Advanced` drawer for users relaying through a self-hosted proxy (such as [`AdamsGH/charlib-proxy`](https://github.com/AdamsGH/charlib-proxy)) in geo-blocked regions.

## Testing

```bash
node --test test/*.test.mjs
```
