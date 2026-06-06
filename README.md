# danshipper.com

Dan Shipper's personal site. Plain HTML + CSS, no framework, built for humans and answer engines.

## Structure

- `site/` — hand-authored pages (home, press shell), styles, fonts, robots/llms/favicon
- `content/` — data: `writing.json` (selected essays), `timeline.json`, `press.json` (coverage list), `facts.json` (verified bio facts + sources), `wp-*.json` (scraped WordPress export), `wp-assets/` (mirrored legacy images)
- `scripts/build.mjs` — assembles `dist/`: injects lists into pages, regenerates all ~109 legacy blog posts at their original URLs, builds the archive index, sitemap, and llms-full.txt
- `scripts/check.mjs` — verifier: internal links, curated external links, JSON-LD validity, one-h1 rule (`--external` for the full sweep)
- `scripts/og-card.html` — source for `site/og.png` (screenshot at 1200×630)

## Develop

```sh
node scripts/build.mjs     # build dist/
node scripts/check.mjs     # verify (add --external for link sweep)
python3 -m http.server 4173 --directory dist
```

## Deploy

Hosted on Vercel (`vercel.json` holds redirects from old WordPress paths). Push to main → auto-deploy, or `vercel --prod`.

## Editing content

Change the JSON in `content/` (or the HTML in `site/`), rebuild, push. The legacy archive (2011–2016 posts) is preserved verbatim — don't edit those posts, they're historical record.
