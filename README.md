# danshipper.com

Dan Shipper's personal site. Plain HTML + CSS, no framework, built for humans and answer engines.

## Structure

- `site/` — hand-authored pages (home, press shell, books shell), styles, fonts, robots/llms/favicon
- `content/` — data: `writing.json` (selected essays), `timeline.json`, `press.json` (coverage list), `facts.json` (verified bio facts + sources), `books.revision` (one line: the revision of the reading shelf the site last noticed — written by the scheduled refresh, never by hand; the shelf itself is never committed), `wp-*.json` (scraped WordPress export), `wp-assets/` (mirrored legacy images)
- `scripts/build.mjs` — assembles `dist/`: injects lists into pages, fetches the reading shelf and builds `/books`, regenerates all ~109 legacy blog posts at their original URLs, builds the archive index, sitemap, and llms-full.txt
- `scripts/shelf.mjs` — the reading shelf's address, the rules a shelf must pass, the date a book is listed under, and where a title links (Bookshop.org); shared by build, check and refresh
- `scripts/refresh-shelf.mjs` — records the shelf's new revision in `content/books.revision` when it changes (run by `.github/workflows/books-shelf.yml`)
- `scripts/check.mjs` — verifier: internal links, curated external links, JSON-LD validity, one-h1 rule, leftover placeholders, and the shelf: every book on `/books` under its year with its cover and its Bookshop link, no passage anywhere, no copy of the shelf tracked by git (`--external` for the full link sweep, `--live` to compare with what the shelf serves now)
- `scripts/og-card.html` — source for `site/og.png` (screenshot at 1200×630)

## Develop

```sh
node scripts/build.mjs     # build dist/
node scripts/check.mjs     # verify (add --external for link sweep)
python3 -m http.server 4173 --directory dist
```

## Books

`/books` and the home page's "Books, lately" section come from Marginalia, Dan's reading library, which publishes one public file (its address is in `scripts/shelf.mjs`): the books it is sure he read, each with the months of his first and most recent photo of it, and any passages he chose to publish. Nothing else leaves it, and nothing about books is edited in this repo. To change what shows, change it in Marginalia (a book can be made private there).

**The shelf is never committed.** This repository is public and its history is forever: a committed copy would keep every book Dan later makes private, and its commit times would say to the hour when each book appeared (the shelf itself only ever gives a month). The repository holds `content/books.revision`, one line with the shelf's revision (a hash), and nothing else of it. `.gitignore` lists `content/books.json` and `.books-cache/`, and the check fails if a copy of the shelf is tracked.

What the page is:

- One sentence under the title says the list is created and maintained automatically by Claude and ChatGPT. It is in `site/books/index.html`.
- A row of years with counts, then "Lately" (the four books photographed most recently, this month or last; nobody marks a book as being read, so neither the page nor the home page claims to know), then one section for every year that has a book, newest first. A book is listed under the date in `listedOn` (`scripts/shelf.mjs`): when Dan finished it if he said so, otherwise the month of his most recent photo of it. Every book on the shelf has a date; the build refuses a shelf with one that does not, so there is no "Undated".
- It is all one page, on purpose: the list is the content, so it sits at one address, can be searched in the page, and is whole without script (there is none). Year headings stay at the top of the window while their books scroll, with links to the year above, the year below, and back to the row of years. `/books#y2024` goes to a year.
- Every book has its cover beside its title, or a typeset stand-in of the same size when the shelf has no cover for it. Covers in the lists are lazy-loaded.
- Every book links to Bookshop.org. `bookshopUrl` in `scripts/shelf.mjs` builds the link and says what was tried: a search for title and author (the title alone for a book first published before 1928, where the author's name brings up study guides instead of the book), never the ISBN (an ISBN link is a 404 for any edition Bookshop does not stock). There is no affiliate id yet; that function is the one place to add it.
- No passages, for now. The shelf may carry passages Dan published; the build shows none of them, `dist/books.json` leaves them out, and the check fails if any passage text turns up in `dist/`. The shelf's format still carries them, so they can return.

How it is built:

- Every build fetches the shelf, checks it strictly (an unknown field or a private note fails it), and mirrors the covers into `dist/books/covers/` under content-hashed names. Pages load nothing from Marginalia. For the year lists it asks the shelf for each cover's smallest copy (`?size=thumb`); the build reports how many of those came back larger than a thumb.
- On Vercel, a failed fetch or check fails the build, and the last good deploy stays live. A stale copy could show a book Dan has since made private, so there is no way to deploy from an old shelf.
- Locally, the last shelf fetched from the production endpoint is kept in `.books-cache/` (gitignored), and a build that cannot reach the shelf warns and uses that copy.
- An empty shelf still builds `/books`, but it is marked noindex and left out of the home page, sitemap, and llms.txt.
- **A shelf that had books and suddenly has none is not built.** That is either Dan taking the whole list down or Marginalia deployed with its switch off by mistake, and the two look the same from here. The build (and the refresh) stop, and the last deploy stays live, until the empty shelf is accepted on purpose: Actions → Books shelf → Run workflow → `allow_empty`. That records the empty revision and redeploys. One book made private needs none of this.

How it stays current:

- `.github/workflows/books-shelf.yml` runs three times an hour (and on demand: Actions → Books shelf → Run workflow). It fetches the shelf, and when its `revision` differs from the one in `content/books.revision` it commits the new revision to `main`. That push is what makes Vercel deploy; the Vercel build then reads the live shelf itself.
- It uses only the repository's own `GITHUB_TOKEN` and no other secret. It commits `content/books.revision` and nothing else (any other change in its working tree, or a file that is not a single hash, stops the job), with a commit message that says only that the shelf changed. A shelf that does not validate fails the run and commits nothing; a shelf that cannot be reached is a warning, and the next run tries again.
- GitHub pauses scheduled workflows in a repository with no activity for 60 days, and can run them late. So the schedule is the backstop, not the way a book that was made private leaves the site.
- **For "make private" to reach the site at once**, give Marginalia a Vercel deploy hook (its `VERCEL_DEPLOY_HOOK_URL` secret): it calls the hook the moment its public shelf changes, and the build reads the live shelf. Create the hook in Vercel (Project → Settings → Git → Deploy Hooks, branch `main`) and set it with `wrangler secret put VERCEL_DEPLOY_HOOK_URL` in the Marginalia repo. Without it, a change waits for the next scheduled run.

| Variable | Effect |
| --- | --- |
| `MARGINALIA_SHELF_URL` | Where the shelf is (defaults to the production endpoint). A build from anywhere else remembers nothing of that shelf |
| `BOOKS_OFFLINE=1` | Build from the copy in `.books-cache/`, fetch nothing: covers that are not in the local cache are typeset. Local only (Vercel has no copy, on purpose). Only the value `1` turns it on |
| `BOOKS_PREVIEW=<file>` | Build from a local shelf file, covers in `covers/` beside it. For design work only: refused on Vercel, and never kept. Keep the file outside the repo |
| `ALLOW_EMPTY=1` | For `scripts/refresh-shelf.mjs` only (the workflow's `allow_empty` input sets it): record the revision of an empty shelf after one with books |

## Deploy

Hosted on Vercel (`vercel.json` holds redirects from old WordPress paths). Push to main → auto-deploy, or `vercel --prod`.

## Editing content

Change the JSON in `content/` (or the HTML in `site/`), rebuild, push. The exception is `content/books.revision`, which only the scheduled refresh writes (see Books). The legacy archive (2011–2016 posts) is preserved verbatim — don't edit those posts, they're historical record.
