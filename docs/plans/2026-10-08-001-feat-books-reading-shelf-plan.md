---
title: "feat: Add a books page fed by Marginalia"
type: feat
status: active
date: 2026-10-08
---

# Add a Books Page Fed by Marginalia

## Overview

Show the books Dan is reading and has read on danshipper.com, plus the passages he chooses to publish, in the spirit of Patrick Collison's bookshelf. The list is not kept in this repo. It comes from Marginalia, Dan's reading library, which is the one place he maintains it.

## Problem Frame

Dan's reading lives in Marginalia: photographed pages, marked passages, the books they belong to. Almost all of it is private. He wants a public shelf on his personal site that stays current without a second list to maintain, and that can never show more than he has published.

The site is static HTML with no client JavaScript and is built for answer engines, so the shelf has to be in the HTML at build time, not fetched in the browser.

## Requirements Trace

- R1. `/books` lists books being read now, then books by year read, then published passages. Each section is left out when empty.
- R2. The home page shows at most four books in a Reading section after Selected writing, with a link to `/books`.
- R3. Only what Marginalia's public endpoint returns can appear: public books and published passages. No notes, page photos, unpublished text, or credentials enter the repo or the built site.
- R4. Passages are verbatim. Nothing in the build may alter a character of a quote.
- R5. A passage Dan withdraws must not be republished by a stale copy.
- R6. The page follows the site's existing conventions: plain HTML and CSS, zero dependencies, zero client JavaScript, the `ul.ledger` idiom, existing colour tokens, one h1, canonical, meta description, JSON-LD.
- R7. An empty shelf is not advertised: no home section, footer link, sitemap entry, or llms.txt entry.

## Scope Boundaries

- No per-book pages, no cover wall, no links to bookshops.
- No page images or "see the page" crops.
- Book subtitles and reading statuses other than "reading" are carried in the data but not shown.
- The intro sentence on `/books` is Dan's to write. The page ships with a marked comment where it goes and shows nothing there until he fills it.
- The rebuild trigger (Marginalia calling a Vercel deploy hook when the public revision changes) is configured outside this repo.
- The legacy `/books-ive-read-recently` page (2013–2015) is untouched; `/books` links to it as the older list.

## Context & Research

### Relevant Code and Patterns

- `scripts/build.mjs` already fetches at build time with a cache (`mirrorAssets`) and injects lists into `site/` shells through HTML-comment placeholders.
- `site/press/index.html` is the shell `/books` follows: crumb, h1, generated sections of `ul.ledger` by year, JSON-LD `ItemList`.
- `site/styles.css` loads one font file, Signifier Light. There is no italic, so a book title is marked by colour (`--strong`), the way all emphasis on the site is.
- `.talk-grid` and `.talk-placeholder` are the precedent for a small image grid with a typeset stand-in.

### The Data Contract

`GET /public/shelf.json` on Marginalia returns `{schema: 1, generated_at, revision, books[], quotes[]}`. Books carry id, slug, title, subtitle, authors, status, started, finished, year_published, isbn13, cover, favorite, note (always null). Quotes carry id, book_id, text, page, published_at. `revision` is the sha256 of `{books, quotes}`. Covers of public books are served at `/public/covers/<book_id>.jpg`.

## Key Technical Decisions

- **Fetch at build time, keep a committed copy.** `content/books.json` is the production endpoint's answer, saved by local builds when the revision changes. A shelf read from any other address (`MARGINALIA_SHELF_URL`) is never saved: a local Marginalia can hold test publishes. It makes offline builds work and makes every change to the public shelf a reviewable diff.
- **Fail the build on Vercel when the shelf cannot be fetched or does not validate.** Falling back to the committed copy there could republish a withdrawn passage. `BOOKS_OFFLINE=1` is the deliberate override (only the value `1`). Local builds fall back with a warning.
- **Validate strictly, by hand.** Exact keys, enums, id formats, partial ISO dates, plain text, covers only at the endpoint's own address. An unknown key or a non-null note fails the shelf: nothing the site does not know how to show reaches a public page or the committed copy.
- **Never transform quote text.** Quotes are escaped with a strict escaper (`&`, `<`, `>`, `"`), never passed through `decode()`, and injected with `replace(marker, () => html)` so `$` sequences in a quote are not read as replacement patterns. Each quote is the single text node of its `<blockquote>`, with `white-space: pre-wrap` for its own line breaks and spacing, so `check.mjs` can compare it byte for byte.
- **Mirror covers, content-addressed.** Covers are fetched on every live build (the shelf carries no hash to tell a replaced cover from a kept one), copied to `dist/books/covers/<id>-<sha1>.jpg`, and sized from the JPEG itself. Gitignored `.books-cache/` keeps the last copy for builds from the snapshot. Pages load nothing from Marginalia, and the cover path can be cached forever. Only covers the page shows (Reading now) are mirrored. A missing cover is typeset, not fatal.
- **An empty shelf still builds `/books`.** The redirects from `/reading` and `/library` are static, so the target must always exist. The empty page says the shelf is not published, is `noindex`, and is linked from nowhere (R7).
- **`/reading` and `/library` redirect temporarily.** They are conveniences, not moved content; a permanent redirect would be cached by browsers if Dan later wants either path for something else.
- **Home rows are reading-now first, then most recently read.** Books with no date never appear on the home page; there is no honest way to choose four of them. Paused and abandoned books do not appear there either, and the favorite mark is left to `/books`, where it is explained.

## Open Questions

### Resolved During Planning

- Covers in the ledger: no. The ledger is text, as on Collison's page; covers appear only under Reading now.
- Where the favorite mark is explained: a footnote in the page footer, shown only when a favorite exists.

### Deferred to Dan

- The intro sentence.
- Whether "Undated" is the right heading for books with no reading date.
- Whether paused and abandoned books should be labelled as such.
- Whether subtitles should show.

## Implementation Units

- [x] **Unit 1: Load and validate the shelf**

  **Goal:** Get the public shelf into the build safely.

  **Requirements:** R3, R5

  **Files:**
  - Create: `scripts/shelf.mjs`, `content/books.json`
  - Modify: `scripts/build.mjs`, `.gitignore`

  **Approach:** `loadShelf()` fetches `MARGINALIA_SHELF_URL` with an 8-second timeout before `dist/` is touched, validates with `validateShelf()`, and applies the local and Vercel failure rules above. `BOOKS_PREVIEW` reads a local file for design work and is refused on Vercel.

  **Test scenarios:**
  - Happy path: the live endpoint builds and updates `content/books.json` only when the revision changes.
  - Error path: an unreachable endpoint warns locally and exits 1 with `VERCEL=1`.
  - Error path: a shelf with an extra key, a note, an unknown status, an orphan quote, a cover on another host, or markup in a quote is refused.

- [x] **Unit 2: Build `/books` and the home section**

  **Goal:** Render the shelf in the site's own idiom.

  **Requirements:** R1, R2, R4, R6, R7

  **Files:**
  - Create: `site/books/index.html`
  - Modify: `scripts/build.mjs`, `site/index.html`, `site/styles.css`, `site/llms.txt`, `vercel.json`

  **Approach:** Placeholders in the books shell for head, reading now, ledger, passages, and footnotes. Year sections reuse `ul.ledger` with the month in the gutter. Passages are `figure > blockquote + figcaption` with a mono citation. Sitemap, llms.txt, llms-full.txt, and `dist/books.json` follow the same has-books rule.

  **Test scenarios:**
  - Happy path: a shelf with reading, dated, and undated books and passages renders all four sections.
  - Edge case: an empty shelf renders the plain notice, `noindex`, and no links to `/books` anywhere.
  - Edge case: a shelf of only undated books renders one flush list with no heading.
  - Edge case: a quote containing `$&`, `&amp;`, quotation marks, and angle brackets renders literally.

- [x] **Unit 3: Verify what was built**

  **Goal:** Make the privacy and verbatim rules checkable.

  **Requirements:** R3, R4, R7

  **Files:**
  - Modify: `scripts/check.mjs`

  **Approach:** Fail on leftover placeholders in any text file, on any mention of the Marginalia host in `dist/`, on an invalid `content/books.json` or one whose revision does not hash to its contents, on any passage whose blockquote is not the shelf text byte for byte, on images without local source, alt, width, and height, on a redirect that hides a built page, and on a shelf that is listed when empty or unlisted when not. Warn on long passages. `--live` compares the built revision with the endpoint.

- [ ] **Unit 4: Publish**

  **Goal:** Ship once Dan has written the intro and published his first books.

  **Requirements:** R1, R5

  **Dependencies:** Units 1–3; Dan's review of this branch

  **Approach:** Merge, confirm the Vercel build fetches the shelf, check `/books`, `/reading`, and `/library` on production, and connect Marginalia's deploy hook so a change to the public shelf rebuilds the site.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Marginalia is down when an unrelated change needs to deploy | `BOOKS_OFFLINE=1` deploys from the committed copy; the previous deploy stays live meanwhile. |
| A contract change in Marginalia fails every site build | Intended: the strict validator fails closed. The fix is a deliberate change to `scripts/shelf.mjs`. |
| Long published passages raise a copyright question | `check.mjs` warns above 1,000 characters a passage and 3,000 a book; the decision stays with Dan. |
| A preview shelf built from private data is deployed by mistake | `BOOKS_PREVIEW` is refused on Vercel, never written to `content/`, and `check.mjs` reports when `dist/` was not built from the committed shelf. |

## Sources & References

- Related code: `scripts/build.mjs`, `scripts/check.mjs`, `scripts/shelf.mjs`, `site/books/index.html`, `site/styles.css`
- Reference: Patrick Collison's bookshelf, `https://patrickcollison.com/bookshelf`

## Update, 2026-10-10

Dan saw the first preview and changed the brief. What is different from the plan above:

- **The shelf fills itself.** Marginalia now lists every book it is sure Dan read (schema 2: each book carries `first_photo` and `last_photo` as months, and `quotes`), unless he makes one private. Nobody marks books public one by one, and there are no reading statuses to lean on.
- **Every book is dated, and every year is shown.** A book is listed under the month of Dan's most recent photo of it (or its finished date when he gave one). There is no "Undated" section: the shelf promises a date for every book and the build refuses a shelf that breaks the promise. The page runs from the newest year to the oldest that has a book.
- **Year by year, on one page.** A row of years with counts at the top; year headings that stay at the top of the window, each with links to the year above, the year below and the row of years. One page rather than a page per year: the list is the content, it stays at one address and searchable in the page, and with lazy covers it costs little. "Reading now" became "Lately" (the four most recently photographed books), because the page no longer knows what is being read, only what was photographed.
- **Covers and Bookshop links** (both were out of scope above). Every row has its cover or a stand-in of the same size, and links to Bookshop.org by a search for title and author; see `bookshopUrl` in `scripts/shelf.mjs` for why not the ISBN, and for the one place an affiliate id would go.
- **A line under the title** says the list is created and maintained automatically by Claude and ChatGPT. It replaces the intro that was left for Dan to write.
- **No passages for now** (R1 and R4 are parked, not dropped). The build shows none, whatever the shelf carries; the snapshot keeps the `quotes` field.
- **Staying current** no longer depends on a deploy hook: `.github/workflows/books-shelf.yml` commits a new snapshot when the shelf's revision changes, and the push deploys. The hook path remains.

## Update, 2026-10-10 (after review): the shelf is never committed

The repository is public, so a committed `content/books.json` would have kept, forever, every book later made private, and its commit times would have dated each photo far more finely than the month the shelf gives. What changed:

- **No committed copy.** `content/books.json` is gone (and gitignored). The repository holds `content/books.revision`: the shelf's revision, one line. The workflow commits only that, with a message that says only "Reading shelf changed". Local builds keep the last fetched shelf in `.books-cache/` (gitignored); Vercel has no fallback copy and never deploys from an old shelf.
- **An empty shelf after one with books is refused** by the build and by the refresh until it is accepted on purpose (the workflow's `allow_empty` input), so a Marginalia deployed with its switch off cannot empty `/books` by accident.
- **"Make private" at once** is the deploy hook's job (Marginalia calls it whenever its public shelf changes, now also right after a book is made private in the app); the schedule is the backstop.
- **Bookshop links**: title and author, except a book first published before 1928 (title alone: the author's name brings up study guides), with bracketed edition notes left out.
- **Page**: the home section is "Books, lately" (not "Reading"); year-index links are named "2026, 28 books"; the year steps are plain links with a finger's room, not fifteen nav landmarks; author and month text on `/books` is a grey that passes AA; the JSON-LD no longer claims "is reading" or lists the photographed edition's ISBN.

