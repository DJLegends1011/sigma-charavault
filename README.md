# CharaVault for Project Σ

**Browse and search [CharaVault](https://charavault.net) inside [Project Σ](https://github.com/Sillyanonymous/ProjectSigma), and import its characters and lorebooks with one click.** It shows up in the Online tab like Σ's other sources. Ported and expanded from [AdamsGH's PR #18](https://github.com/Sillyanonymous/SillyTavern-CharacterLibrary/pull/18) to Character Library.

> Made by a community member, not the Σ team. Read "What it reads, writes and sends" below before you install.

## What it does

- **Browse and search characters** by keyword, creator or tags (tags are suggested as you type), or show only cards with a lorebook. Hide cards you already own or probably own, include NSFW or keep it SFW (one switch, shared with the Lorebooks shelf), and choose from 10 sort orders.
- **Preview** shows the rating and vote count, token and download counts, the model tier the creator recommends, the card's prompt sections, alternate greetings, and **Visually Similar**: other cards with a near-identical picture.
- **Lorebooks come along.** Importing a character (or checking it for updates) also brings in the lorebooks linked to it, and the preview has an **Import to Shelf** button for each one.
- **A Lorebooks view** to browse, search and preview CharaVault's standalone lorebooks and put them on your Lorebook Shelf.
- **No outside proxy needed.** Requests, thumbnails and card downloads go through Σ's own server, because CharaVault doesn't let a web page load them directly.

## Install

1. In Σ, open **Settings > Extensions**, paste `https://github.com/DJLegends1011/sigma-charavault` and press **Install**, or download the zip from [Releases](https://github.com/DJLegends1011/sigma-charavault/releases) and use **Install from a File**.
2. Restart Σ (it has a server half), then turn **CharaVault** on.
3. Optional: under **Settings > Online > CharaVault**, enter your CharaVault email and an **App Password** (`cv_...`) for 18+ cards, unblurred thumbnails, higher rate limits and card downloads.

If CharaVault is blocked where you live, the **Advanced** drawer in the same place takes a Gateway URL, CDN URL and key for a self-hosted relay such as [AdamsGH/charlib-proxy](https://github.com/AdamsGH/charlib-proxy). Leave it empty otherwise.

## What it reads, writes and sends

**It has a server half** (code that runs on the computer hosting Σ). It passes your requests on to CharaVault and logs in for you.

**Sends, and where:**
- **To charavault.net,** through the server half: your searches, filters and page numbers, preview and download requests, and thumbnail requests.
- **If you entered an App Password,** your email and App Password go to CharaVault's login (`/api/auth/login`), and later requests carry the session CharaVault hands back.
- **If you set a Gateway,** all of the above goes to that gateway instead, with your gateway key.
- Nothing is sent anywhere else, and nothing is sent to the extension's author.

**Writes:**
- Characters and lorebooks you import, through Σ's normal import.
- Its own settings: email, App Password, gateway fields and the NSFW switch. They are kept in Σ's settings like any other extension setting; clear the fields to remove them.

**Reads:** its own settings, and your library (for the "owned" and "possible match" filters).

Turning it off stops it. It does not remove characters or lorebooks you already imported.

## Licence

GPL-3.0, see [LICENSE](LICENSE).

## Tests

```bash
node --test test/*.test.mjs
```
