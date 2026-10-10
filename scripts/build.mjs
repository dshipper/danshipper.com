#!/usr/bin/env node
// Build danshipper.com: site/ + content/*.json -> dist/
// No dependencies. Node 18+.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { SHELF_URL, SHELF_IS_PUBLISHED, sourceCover, publishedCover, validateShelf, listedOn, bookshopUrl, thumbOf, emptiedUnasked, revisionOf } from "./shelf.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE = path.join(ROOT, "site");
const DIST = path.join(ROOT, "dist");
const CONTENT = path.join(ROOT, "content");
const ASSET_CACHE = path.join(CONTENT, "wp-assets");
const COVER_CACHE = path.join(ROOT, ".books-cache", "covers");
const ORIGIN = "https://danshipper.com";
const ON_VERCEL = !!process.env.VERCEL;

const readJSON = (f, fallback = null) => {
  try { return JSON.parse(fs.readFileSync(path.join(CONTENT, f), "utf8")); }
  catch { return fallback; }
};

// ---------- load content ----------
const posts = [
  ...(readJSON("wp-posts-1.json", [])),
  ...(readJSON("wp-posts-2.json", [])),
].filter(p => p.status === "publish" || p.status === undefined);

const wpPages = readJSON("wp-pages.json", []);
const KEEP_PAGES = new Set(["what-is-distilled-thinking", "books-ive-read-recently"]);
const keptPages = wpPages.filter(p => KEEP_PAGES.has(p.slug));

const writing = readJSON("writing.json");
const timeline = readJSON("timeline.json");
const press = readJSON("press.json"); // may be null until research lands

// ---------- helpers ----------
const esc = s => String(s)
  .replace(/&(?![a-zA-Z#0-9]+;)/g, "&amp;")
  .replace(/</g, "&lt;").replace(/>/g, "&gt;");
const attr = s => esc(s).replace(/"/g, "&quot;");
const decode = s => String(s)
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&nbsp;/g, " ").replace(/&#8217;|&rsquo;/g, "’")
  .replace(/&#8216;|&lsquo;/g, "‘").replace(/&#8220;|&ldquo;/g, "“")
  .replace(/&#8221;|&rdquo;/g, "”").replace(/&#8211;|&ndash;/g, "–")
  .replace(/&#8212;|&mdash;/g, "—").replace(/&#038;/g, "&").replace(/&#8230;|&hellip;/g, "…");

// Text from the reading shelf is shown exactly as written: escape everything, decode nothing.
const escText = s => String(s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const fmtMonthYear = iso => {
  const m = String(iso).match(/^(\d{4})-(\d{2})/);
  return m ? `${MONTHS[+m[2] - 1]} ${m[1]}` : String(iso);
};
const fmtDay = iso => `${+String(iso).slice(8, 10)} ${fmtMonthYear(iso)}`;
const yearOf = iso => String(iso).slice(0, 4);

const writeFile = (p, body) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
};

// ---------- asset mirroring ----------
// Old posts reference images on danshipper.com (wp-content/...). Those die with
// WPEngine, so mirror them into the repo and rewrite URLs to be relative.
const assetRefs = new Set();
const collectAssets = html => {
  const re = /https?:\/\/(?:www\.)?danshipper\.com(\/wp-content\/uploads\/[^\s"'<>)]+)/g;
  for (const m of html.matchAll(re)) assetRefs.add(m[1]);
  const rel = /(?:src|href)=["'](\/wp-content\/uploads\/[^"']+)["']/g;
  for (const m of html.matchAll(rel)) assetRefs.add(m[1]);
  return html;
};
const rewriteAssets = html => html
  .replace(/https?:\/\/(?:www\.)?danshipper\.com(\/wp-content\/uploads\/[^\s"'<>)]+)/g, "$1");

async function mirrorAssets() {
  const refs = [...assetRefs];
  let downloaded = 0, cached = 0, failed = [];
  const queue = [...refs];
  const workers = Array.from({ length: 6 }, async () => {
    while (queue.length) {
      const ref = queue.shift();
      const localPath = path.join(ASSET_CACHE, ref.split("?")[0]);
      if (fs.existsSync(localPath) && fs.statSync(localPath).size > 0) { cached++; continue; }
      try {
        const res = await fetch(ORIGIN + ref, { redirect: "follow" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        writeFile(localPath, buf);
        downloaded++;
      } catch (e) {
        failed.push(`${ref} (${e.message})`);
      }
    }
  });
  await Promise.all(workers);
  return { total: refs.length, downloaded, cached, failed };
}

// ---------- reading shelf ----------
// The books come from Marginalia, Dan's private reading library, through one public
// endpoint that carries only what is public there. Every deploy reads it live. Nothing
// of it is committed (this repository is public and its history is forever: see
// shelf.mjs); the repository holds only content/books.revision, the shelf's revision,
// which .github/workflows/books-shelf.yml updates when the shelf changes, and that commit
// is what redeploys the site. A local build keeps the last shelf it fetched in
// .books-cache/ (gitignored) so it can run without the network.
// The shelf may also carry passages Dan published; this site shows none of them for now.
//   BOOKS_OFFLINE=1       build from the copy in .books-cache/ and fetch nothing (only "1"
//                         counts; a machine that never fetched the shelf has no copy)
//   BOOKS_PREVIEW=<file>  build from a local shelf file, covers in covers/ beside it
//                         (for design work; refused on Vercel, never kept)
const SHELF_CACHE = path.join(ROOT, ".books-cache", "shelf.json");
const BUILT_FROM = path.join(ROOT, ".books-cache", "built-from.json"); // the shelf this dist/ was built from, for check.mjs
const recordedRevision = () => { try { return fs.readFileSync(path.join(CONTENT, "books.revision"), "utf8").trim() || null; } catch { return null; } };

async function loadShelf() {
  const valid = (shelf, from, coverOk = sourceCover) => {
    const errs = validateShelf(shelf, coverOk);
    if (errs.length) throw new Error(`${from} is not a valid shelf:\n  ${errs.slice(0, 10).join("\n  ")}`);
    return shelf;
  };
  const cached = () => {
    if (!fs.existsSync(SHELF_CACHE)) throw new Error("there is no copy of the shelf on this machine (.books-cache/shelf.json is written by a build that reached it)");
    return valid(JSON.parse(fs.readFileSync(SHELF_CACHE, "utf8")), ".books-cache/shelf.json", publishedCover);
  };

  if (process.env.BOOKS_PREVIEW) {
    if (ON_VERCEL) throw new Error("BOOKS_PREVIEW is for local design work and must not be set on Vercel");
    console.warn(`WARN: PREVIEW shelf from ${process.env.BOOKS_PREVIEW} — this dist/ is not for deploy`);
    return { shelf: valid(JSON.parse(fs.readFileSync(process.env.BOOKS_PREVIEW, "utf8")), "BOOKS_PREVIEW"), source: "preview" };
  }
  if (process.env.BOOKS_OFFLINE === "1") {
    console.warn("WARN: BOOKS_OFFLINE — shelf from .books-cache/, which may be behind what Dan has published or withdrawn");
    return { shelf: cached(), source: "snapshot" };
  }
  let shelf;
  try {
    const res = await fetch(SHELF_URL, { cache: "no-store", signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    shelf = valid(await res.json(), SHELF_URL);
  } catch (e) {
    // A stale copy could list a book Dan has since made private, so a deploy stops here
    // and the last good one stays live.
    if (ON_VERCEL) throw new Error(`could not load the reading shelf: ${e.message}`);
    if (fs.existsSync(SHELF_CACHE)) {
      console.warn(`WARN: could not load the reading shelf: ${e.message}\n      using the copy in .books-cache/ instead`);
      return { shelf: cached(), source: "snapshot" };
    }
    // A machine that has never reached the shelf can still build the rest of the site.
    console.warn(`WARN: could not load the reading shelf: ${e.message}\n      and there is no copy on this machine: building WITHOUT books — this dist/ is not for deploy`);
    const none = { books: [], quotes: [], lately: [] };
    return { shelf: { schema: 2, generated_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"), revision: revisionOf(none), ...none }, source: "none" };
  }
  // A shelf that had books and now has none: not built, here or on Vercel, until the empty
  // revision has been recorded on purpose (see emptiedUnasked in shelf.mjs).
  if (SHELF_IS_PUBLISHED && emptiedUnasked(shelf, recordedRevision())) {
    throw new Error("the reading shelf is empty, but the revision recorded in content/books.revision is of a shelf with books.\n"
      + "If the list was taken down on purpose: Actions → Books shelf → Run workflow with allow_empty, which records the empty shelf and redeploys.\n"
      + "If not: Marginalia is answering with nothing (its PUBLIC_BOOKS switch?). The last deploy stays live meanwhile.");
  }
  // Only the published endpoint's answer is kept (a local Marginalia can hold test publishes).
  if (!ON_VERCEL) {
    if (!SHELF_IS_PUBLISHED) console.warn("WARN: MARGINALIA_SHELF_URL is set — nothing is remembered from this shelf");
    else writeFile(SHELF_CACHE, JSON.stringify(shelf, null, 2) + "\n");
  }
  return { shelf, source: "live" };
}

// Width and height read from the JPEG itself, so <img> attributes describe the file served.
const jpegSize = buf => {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  for (let i = 2; i + 9 < buf.length; i += 2 + buf.readUInt16BE(i + 2)) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
    }
  }
  return null;
};

// Covers are copied into the site so no page loads anything from Marginalia, and
// published under a content hash, so /books/covers/ can be cached forever. Two sizes:
// every book's cover as a thumb for the year lists (the smallest copy the shelf
// serves: several hundred of them are on one page), and the small cover of the few
// books in the row at the top. A live build always refetches them (the shelf carries
// no hash to tell a replaced or withdrawn cover from a kept one) and leaves a copy in
// .books-cache/ (gitignored) for builds from the snapshot. A cover that cannot be had
// is not fatal: the page typesets a stand-in.
async function mirrorCovers(books, featured, source) {
  const preview = source === "preview";
  const dir = preview ? path.join(path.dirname(process.env.BOOKS_PREVIEW), "covers") : COVER_CACHE;
  const covers = new Map(); // book id -> { thumb?, small? }, each { src, width, height }
  const failed = [];
  const fetched = async url => {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return Buffer.from(await res.arrayBuffer());
      } catch (e) {
        if (attempt >= 1) throw e; // one more try: several hundred requests go out in a row
      }
    }
  };
  const queue = [
    ...books.filter(b => b.cover).map(b => ({ b, size: "thumb" })),
    ...featured.filter(b => b.cover).map(b => ({ b, size: "small" })),
  ];
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (queue.length) {
      const { b, size } = queue.shift();
      // a preview keeps one file per book; the cache keeps both sizes
      const cached = path.join(dir, size === "thumb" && !preview ? `${b.id}.t.jpg` : `${b.id}.jpg`);
      try {
        let buf;
        if (source === "live") buf = await fetched(size === "thumb" ? thumbOf(b.cover.url) : b.cover.url);
        else if (fs.existsSync(cached)) buf = fs.readFileSync(cached);
        else throw new Error("not in the cache");
        const dims = jpegSize(buf);
        if (!dims) throw new Error("not a JPEG");
        if (source === "live") writeFile(cached, buf);
        const name = `${b.id}-${crypto.createHash("sha1").update(buf).digest("hex").slice(0, 8)}.jpg`;
        writeFile(path.join(DIST, "books", "covers", name), buf);
        if (!covers.has(b.id)) covers.set(b.id, {});
        covers.get(b.id)[size] = { src: `/books/covers/${name}`, ...dims };
      } catch (e) {
        failed.push(`${b.id} ${size} (${e.message})`);
      }
    }
  }));
  return { covers, failed };
}

// Loaded before dist/ is touched: if a deploy has to stop, it stops with nothing half-built.
const { shelf, source: shelfSource } = await loadShelf().catch(e => {
  console.error(`ERROR: ${e.message}`);
  process.exit(1);
});

// ---------- page shell for archive ----------
const shell = ({ title, description, canonicalPath, dateLabel, bodyHtml, isPage }) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — Dan Shipper</title>
<meta name="description" content="${attr(description)}">
<link rel="canonical" href="${ORIGIN}${canonicalPath}">
<link rel="stylesheet" href="/styles.css">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<meta property="og:type" content="article">
<meta property="og:title" content="${attr(title)}">
<meta property="og:url" content="${ORIGIN}${canonicalPath}">
<meta property="og:image" content="${ORIGIN}/og.png">
<meta name="twitter:card" content="summary">
</head>
<body>
<main>
  <nav class="crumb"><a href="/">← Dan Shipper</a> · <a href="/archive">Archive</a></nav>
  <article class="archived">
    <p class="archive-note">${isPage ? "From the old site" : `From the blog archive · ${dateLabel}`}</p>
    <h1>${title}</h1>
    ${bodyHtml}
  </article>
  <footer>
    <p>This post is preserved from Dan's old blog (2010–2016). <a href="/">Here's what he's doing now</a>.</p>
  </footer>
</main>
</body>
</html>
`;

const stripTags = h => decode(String(h).replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
const excerptOf = p => {
  const e = stripTags(p.excerpt?.rendered || "").slice(0, 155);
  return e || `From Dan Shipper's blog archive, ${fmtMonthYear(p.date)}.`;
};

// ---------- build ----------
fs.rmSync(DIST, { recursive: true, force: true });
fs.cpSync(SITE, DIST, { recursive: true });

// 1) archive post pages
const urls = []; // {loc, lastmod}
const postEntries = [];
for (const p of posts) {
  const slug = p.slug;
  const title = decode(p.title?.rendered || slug);
  let html = p.content?.rendered || "";
  collectAssets(html);
  html = rewriteAssets(html);
  const page = shell({
    title,
    description: excerptOf(p),
    canonicalPath: `/${slug}`,
    dateLabel: fmtMonthYear(p.date),
    bodyHtml: html,
    isPage: false,
  });
  writeFile(path.join(DIST, slug, "index.html"), page);
  urls.push({ loc: `/${slug}`, lastmod: String(p.date).slice(0, 10) });
  postEntries.push({ slug, title, date: p.date });
}

// 2) kept WP pages
for (const p of keptPages) {
  const slug = p.slug;
  const title = decode(p.title?.rendered || slug);
  let html = p.content?.rendered || "";
  collectAssets(html);
  html = rewriteAssets(html);
  writeFile(path.join(DIST, slug, "index.html"), shell({
    title,
    description: excerptOf(p),
    canonicalPath: `/${slug}`,
    dateLabel: "",
    bodyHtml: html,
    isPage: true,
  }));
  urls.push({ loc: `/${slug}`, lastmod: String(p.modified || p.date).slice(0, 10) });
}

// 3) archive index, grouped by year, newest first
postEntries.sort((a, b) => String(b.date).localeCompare(String(a.date)));
const byYear = new Map();
for (const e of postEntries) {
  const y = yearOf(e.date);
  if (!byYear.has(y)) byYear.set(y, []);
  byYear.get(y).push(e);
}
const archiveSections = [...byYear.entries()].map(([year, entries]) => `
  <section>
    <h2>${year}</h2>
    <ul class="ledger">
${entries.map(e => `      <li><span class="when">${fmtMonthYear(e.date)}</span><span class="what"><a href="/${e.slug}">${esc(e.title)}</a></span></li>`).join("\n")}
    </ul>
  </section>`).join("\n");

writeFile(path.join(DIST, "archive", "index.html"), `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Blog archive, 2010–2016 — Dan Shipper</title>
<meta name="description" content="The complete archive of Dan Shipper's startup blog: ${postEntries.length} posts written from a Penn dorm room while bootstrapping and selling a company, 2010–2016.">
<link rel="canonical" href="${ORIGIN}/archive">
<link rel="stylesheet" href="/styles.css">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<meta property="og:type" content="website">
<meta property="og:title" content="Blog archive, 2010–2016 — Dan Shipper">
<meta property="og:url" content="${ORIGIN}/archive">
<meta property="og:image" content="${ORIGIN}/og.png">
</head>
<body>
<main>
  <nav class="crumb"><a href="/">← Dan Shipper</a></nav>
  <h1>The old blog</h1>
  <p class="lede">${postEntries.length} posts, 2010–2016: building and selling a startup from a dorm room, in public. Preserved as written—links may have rotted, opinions may have improved.</p>
${archiveSections}
  <footer>
    <p><a href="/">Home</a> · <a href="/press">Press</a></p>
  </footer>
</main>
</body>
</html>
`);
urls.push({ loc: "/archive", lastmod: "2026-06-06" });

// 4) inject home-page lists
let home = fs.readFileSync(path.join(DIST, "index.html"), "utf8");

if (writing?.essays) {
  home = home.replace("<!--WRITING_LIST-->", writing.essays.map(e =>
    `<li><span class="when">${fmtMonthYear(e.date)}</span><span class="what"><a href="${attr(e.url)}">${esc(e.title)}</a></span></li>`
  ).join("\n      "));
}
if (writing?.podcast?.notable_episodes) {
  home = home.replace("<!--PODCAST_LIST-->", writing.podcast.notable_episodes.map(e =>
    `<li><span class="when">${fmtMonthYear(e.date)}</span><span class="what"><a href="${attr(e.url)}">${esc(e.title)}</a><span class="note">${esc(e.note)}</span></span></li>`
  ).join("\n      "));
}
if (timeline?.items) {
  home = home.replace("<!--TIMELINE_LIST-->", timeline.items.map(t => {
    let body = esc(t.what);
    if (t.link && t.link_text && t.what.includes(t.link_text)) {
      body = body.replace(esc(t.link_text), `<a href="${attr(t.link)}">${esc(t.link_text)}</a>`);
    } else if (t.link) {
      body = `<a href="${attr(t.link)}">${body}</a>`;
    }
    return `<li><span class="when">${esc(t.when)}</span><span class="what">${body}</span></li>`;
  }).join("\n      "));
}

const pressItems = (press?.items || []).filter(i => i.url_ok !== false);
if (pressItems.length) {
  const highlights = pressItems.filter(i => i.highlight).slice(0, 14);
  home = home.replace("<!--PRESS_HIGHLIGHTS-->", highlights.map(i =>
    `<li><span class="when">${esc(yearOf(i.date))}</span><span class="what"><span class="outlet"><span class="m-when" aria-hidden="true">${esc(yearOf(i.date))} · </span>${esc(i.outlet)}</span><a href="${attr(i.url)}">${esc(i.title)}</a></span></li>`
  ).join("\n      "));
} else {
  home = home.replace("<!--PRESS_HIGHLIGHTS-->", `<li><span class="when">—</span><span class="what">Press list compiling…</span></li>`);
  console.warn("WARN: content/press.json missing or empty — homepage press section is a placeholder");
}

// The shelf in the order it is listed: newest first. Every book has a date (the shelf
// promises it and validateShelf checks): when Dan finished it if he said so, otherwise
// the month of his most recent photo of it. Marginalia already sends the books newest
// first, by the day; the sort here is stable, so that order survives within a month.
// Shelf text goes in through a function: a "$" in a replacement string is a pattern.
const books = [...shelf.books].sort((a, b) => listedOn(b).slice(0, 7).localeCompare(listedOn(a).slice(0, 7)));
const hasShelf = books.length > 0; // an empty shelf is linked from nowhere
const monthOf = b => (/^\d{4}-\d{2}/.test(listedOn(b)) ? listedOn(b).slice(0, 7) : "");
const byline = b => escText(b.authors.join(", "));

// "Lately": nobody marks a book as being read; what is known is when Dan last
// photographed it. So the row at the top is the books photographed this month or last
// (as of the shelf's own date), with any he did mark "reading" first. Four of them: one
// row of covers, then the list, which is the page.
const shelfMonth = shelf.generated_at.slice(0, 7);
const monthBefore = ym => { const [y, m] = ym.split("-").map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`; };
const recent = b => b.last_photo !== null && b.last_photo >= monthBefore(shelfMonth);
// Which books may be featured at all (here and on the home page) is the shelf's to say:
// `lately` lists them. A book that is not in it keeps its place in its month's list and
// is simply never featured. (A shelf without the list features by date alone.)
const featurable = Array.isArray(shelf.lately) ? new Set(shelf.lately) : null;
const mayFeature = b => !featurable || featurable.has(b.id);
const lately = [...books.filter(b => b.status === "reading"), ...books.filter(b => b.status !== "reading" && recent(b))].filter(mayFeature).slice(0, 4);

const FAV = `<span class="fav" title="A favorite">*</span>`;

// Home: the four most recent books, under the same name as on /books ("Lately": the
// page knows when a book was last photographed, not whether it is being read). A book set
// aside is left out, and the favorite mark is explained only on /books, so neither shows
// here. The marker's own blank line goes with it: with no books the home page is byte for
// byte what it was.
const homeBooks = [...books.filter(b => b.status === "reading"), ...books.filter(b => !["reading", "paused", "abandoned"].includes(b.status))].filter(mayFeature).slice(0, 4);
const homeRow = b =>
  `<li><span class="when">${b.status === "reading" ? "Now" : fmtMonthYear(listedOn(b))}</span><span class="what"><cite>${escText(b.title)}</cite>${b.authors.length ? `<span class="note">${byline(b)}</span>` : ""}</span></li>`;
home = home.replace(/[ \t]*<!--READING_SECTION-->\n*/, () => homeBooks.length ? `  <section id="reading" aria-labelledby="reading-heading">
    <h2 id="reading-heading">Books, lately</h2>
    <ul class="ledger">
      ${homeBooks.map(homeRow).join("\n      ")}
    </ul>
    <p class="small" style="margin-top:1rem">The rest of the shelf is on the <a href="/books">books page</a>.</p>
  </section>

` : "");
home = home.replace("<!--BOOKS_LINK-->", () => hasShelf ? `<a href="/books">Books</a> · ` : "");
fs.writeFileSync(path.join(DIST, "index.html"), home);

// 5) press page
let pressPage = fs.readFileSync(path.join(DIST, "press", "index.html"), "utf8");
if (pressItems.length) {
  const byY = new Map();
  const sorted = [...pressItems].sort((a, b) => String(b.date).localeCompare(String(a.date)));
  for (const i of sorted) {
    const y = yearOf(i.date);
    if (!byY.has(y)) byY.set(y, []);
    byY.get(y).push(i);
  }
  const sections = [...byY.entries()].map(([year, items]) => `
  <section>
    <h2>${year}</h2>
    <ul class="ledger press">
${items.map(i => `      <li><span class="when">${esc(fmtMonthYear(i.date))}</span><span class="what"><span class="outlet"><span class="m-when" aria-hidden="true">${esc(fmtMonthYear(i.date))} · </span>${esc(i.outlet)}</span><a href="${attr(i.url)}">${esc(i.title)}</a></span></li>`).join("\n")}
    </ul>
  </section>`).join("\n");
  pressPage = pressPage.replace("<!--PRESS_LIST-->", sections);
  const jsonld = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    "name": "Press coverage of Dan Shipper",
    "itemListElement": sorted.slice(0, 50).map((i, idx) => ({
      "@type": "ListItem", "position": idx + 1,
      "item": { "@type": "Article", "headline": decode(i.title), "url": i.url, "publisher": { "@type": "Organization", "name": i.outlet } }
    })),
  };
  pressPage = pressPage.replace("<!--PRESS_JSONLD-->", `<script type="application/ld+json">\n${JSON.stringify(jsonld, null, 1)}\n</script>`);
} else {
  pressPage = pressPage.replace("<!--PRESS_LIST-->", "<p>Press list is being compiled.</p>").replace("<!--PRESS_JSONLD-->", "");
}
fs.writeFileSync(path.join(DIST, "press", "index.html"), pressPage);
urls.push({ loc: "/press", lastmod: "2026-06-06" });
urls.push({ loc: "/", lastmod: "2026-06-06" });

// 6) books page: one line on where the list comes from, a row of years to jump by,
// the books photographed lately (with covers), then every year that has books, newest
// first, each book with its cover and a link to Bookshop.org. All of it is on one page:
// the list is the content, so it is at one address, findable in the page, and whole
// without script. An empty shelf still gets a page, so /books and the redirects to it
// never 404, but it says so plainly, asks not to be indexed, and stays out of the home
// page, sitemap and llms.txt. Passages are not shown, whatever the shelf carries.
const coverReport = await mirrorCovers(books, lately, shelfSource);
const { covers } = coverReport;
const plural = (n, one) => `${n.toLocaleString("en-US")} ${one}${n === 1 ? "" : "s"}`;

// A book with no cover gets a stand-in of the same size: the first letter of its title.
const initial = b => escText((b.title.replace(/^(the|an?)\s+/i, "").match(/[\p{L}\p{N}]/u) || ["·"])[0].toUpperCase());
// One link per book, around its cover, title and author: the whole row goes to Bookshop.
const linked = (b, inner) => `<a class="book" href="${attr(bookshopUrl(b))}">${inner}</a>`;
const titled = b => `<cite>${escText(b.title)}</cite>${b.favorite ? FAV : ""}`;

const latelySection = lately.length ? `
  <section id="lately">
    <h2>Lately</h2>
    <ul class="shelf">
${lately.map(b => {
  const c = covers.get(b.id)?.small;
  const cover = c
    ? `<img src="${c.src}" alt="" width="${c.width}" height="${c.height}" decoding="async">`
    : `<span class="typeset" aria-hidden="true"><span>${escText(b.title)}</span><small>${byline(b)}</small></span>`;
  return `      <li>${linked(b, `<span class="cover">${cover}</span>${titled(b)}${b.authors.length ? `<span class="by">${byline(b)}</span>` : ""}`)}</li>`;
}).join("\n")}
    </ul>
  </section>` : "";

// One section per year, newest first, down to the oldest year that has a book. The
// gutter names the month once, where it starts; a date that is only a year leaves it
// empty.
const booksByYear = new Map();
for (const b of books) {
  const y = yearOf(listedOn(b));
  if (!booksByYear.has(y)) booksByYear.set(y, []);
  booksByYear.get(y).push(b);
}
const years = [...booksByYear.keys()]; // newest first, like the books
const bookRow = (b, when) => {
  const c = covers.get(b.id)?.thumb;
  const cover = c
    ? `<img src="${c.src}" alt="" width="${c.width}" height="${c.height}" loading="lazy" decoding="async">`
    : `<span class="typeset" aria-hidden="true">${initial(b)}</span>`;
  return `<li><span class="when">${when}</span>${linked(b, `<span class="cover">${cover}</span><span class="what">${titled(b)}${b.authors.length ? `<span class="note">${byline(b)}</span>` : ""}</span>`)}</li>`;
};
const yearSection = (year, i) => {
  const list = booksByYear.get(year);
  const newer = years[i - 1], older = years[i + 1];
  const step = [
    ...(newer ? [`<a href="#y${newer}" aria-label="Up to ${newer}">↑ ${newer}</a>`] : []),
    ...(older ? [`<a href="#y${older}" aria-label="Down to ${older}">${older} ↓</a>`] : []),
    `<a href="#years" aria-label="All years (from ${year})">All years</a>`,
  ].join("");
  return `
  <section class="year" id="y${year}" aria-labelledby="h${year}">
    <div class="year-head"><h2 id="h${year}">${year}</h2><span class="n">${plural(list.length, "book")}</span><span class="step">${step}</span></div>
    <ul class="ledger books">
${list.map((b, n) => {
  const m = monthOf(b);
  return "      " + bookRow(b, m && (n === 0 || monthOf(list[n - 1]) !== m) ? MONTHS[+m.slice(5) - 1] : "");
}).join("\n")}
    </ul>
  </section>`;
};
const yearIndex = years.length > 1 ? `
  <nav class="years" id="years" aria-label="Jump to a year">
${years.map(y => `    <a href="#y${y}" aria-label="${y}, ${plural(booksByYear.get(y).length, "book")}">${y}<span>${booksByYear.get(y).length}</span></a>`).join("\n")}
  </nav>` : "";
const listSections = years.map(yearSection).join("\n");
const summary = hasShelf
  ? `<p class="small">${plural(books.length, "book")}${years.length > 1 ? `, ${years[years.length - 1]}–${years[0]}` : ""}, each under the month I last photographed it. Titles link to <a href="https://bookshop.org/">Bookshop.org</a>, which supports independent bookshops.</p>`
  : "";

const booksJsonld = {
  "@context": "https://schema.org",
  "@type": "ItemList",
  "name": "Dan Shipper's reading shelf",
  "description": "Books Dan Shipper has photographed while reading, by the month of the most recent photo. The list is created and maintained automatically by Claude and ChatGPT.",
  "numberOfItems": books.length,
  "itemListElement": books.map((b, idx) => ({
    "@type": "ListItem", "position": idx + 1,
    "item": { "@type": "Book", "name": b.title, ...(b.authors.length ? { "author": b.authors.map(a => ({ "@type": "Person", "name": a })) } : {}) }
  })),
};
const footnotes = [
  ...(books.some(b => b.favorite) ? [`<p>${FAV} A favorite.</p>`] : []),
  ...(hasShelf ? [`<p>The shelf as of ${fmtDay(shelf.generated_at)}.</p>`] : []),
].join("\n    ");

let booksPage = fs.readFileSync(path.join(DIST, "books", "index.html"), "utf8");
booksPage = booksPage
  .replace("<!--BOOKS_HEAD-->", () => hasShelf
    ? `<script type="application/ld+json">\n${JSON.stringify(booksJsonld).replace(/</g, "\\u003c")}\n</script>`
    : `<meta name="robots" content="noindex">`)
  .replace("<!--BOOKS_SUMMARY-->", () => summary)
  .replace("<!--BOOKS_YEARS-->", () => yearIndex)
  .replace("<!--BOOKS_LATELY-->", () => latelySection)
  .replace("<!--BOOKS_LIST-->", () => hasShelf ? listSections : "<p>This shelf has not been published yet.</p>")
  .replace("<!--BOOKS_FOOTNOTES-->", () => footnotes);
fs.writeFileSync(path.join(DIST, "books", "index.html"), booksPage);

// The shelf as built, for agents and for check.mjs: the books as listed, covers pointing
// at the mirrored thumbs. No passages: this site publishes none for now.
fs.writeFileSync(path.join(DIST, "books.json"), JSON.stringify({
  ...shelf,
  books: books.map(b => {
    const c = covers.get(b.id)?.thumb;
    return { ...b, cover: c ? { url: ORIGIN + c.src, width: c.width, height: c.height } : null, quotes: 0 };
  }),
  quotes: [],
}, null, 2) + "\n");

// ...and, outside dist/, the shelf it was built from, passages and all: check.mjs looks
// for their text in everything that was built. Gitignored, like every copy of the shelf.
writeFile(BUILT_FROM, JSON.stringify(shelf) + "\n");

const llms = fs.readFileSync(path.join(DIST, "llms.txt"), "utf8").replace("<!--BOOKS_PAGE-->\n", () => hasShelf
  ? `- [Books](${ORIGIN}/books): the books Dan has been reading, year by year since ${years[years.length - 1]}, from the photos he takes of them; the list is created and maintained automatically by Claude and ChatGPT\n` : "");
fs.writeFileSync(path.join(DIST, "llms.txt"), llms);
if (hasShelf) urls.push({ loc: "/books", lastmod: shelf.generated_at.slice(0, 10) });

// 7) sitemap
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url><loc>${ORIGIN}${u.loc}</loc><lastmod>${u.lastmod}</lastmod></url>`).join("\n")}
</urlset>
`;
fs.writeFileSync(path.join(DIST, "sitemap.xml"), sitemap);

// 8) llms-full.txt — the whole site as one markdown file for AI crawlers
const bookLine = b =>
  `- ${b.title}${b.authors.length ? ` — ${b.authors.join(", ")}` : ""} (${fmtMonthYear(listedOn(b))})${b.favorite ? " — a favorite" : ""}`;
const llmsFull = [
  llms,
  "\n## Selected writing (full list)\n",
  ...(writing?.essays || []).map(e => `- [${decode(e.title)}](${e.url}) (${e.date})`),
  "\n## Notable The Every Podcast episodes\n",
  ...(writing?.podcast?.notable_episodes || []).map(e => `- [${decode(e.title)}](${e.url}) (${e.date}) — ${e.note}`),
  "\n## Timeline\n",
  ...(timeline?.items || []).map(t => `- ${t.when}: ${t.what}`),
  "\n## Press coverage\n",
  ...pressItems.map(i => `- ${i.date} — ${i.outlet}: [${decode(i.title)}](${i.url})`),
  ...(hasShelf ? [
    "\n## Books\n",
    "Created and maintained automatically by Claude and ChatGPT from the photos Dan takes of what he is reading. Each book is listed under the month of his most recent photo of it.\n",
    ...years.flatMap(y => [`\n### ${y}\n`, ...booksByYear.get(y).map(bookLine)]),
  ] : []),
  "\n## Blog archive (2010–2016)\n",
  ...postEntries.map(e => `- ${String(e.date).slice(0, 10)} — [${decode(e.title)}](${ORIGIN}/${e.slug})`),
].join("\n");
fs.writeFileSync(path.join(DIST, "llms-full.txt"), llmsFull);

// 9) mirror wp assets into dist
const assetReport = await mirrorAssets();
if (fs.existsSync(ASSET_CACHE)) {
  fs.cpSync(ASSET_CACHE, DIST, { recursive: true });
}

// 10) cache-bust the stylesheet everywhere (browsers cache /styles.css across deploys)
const cssHash = crypto.createHash("sha1").update(fs.readFileSync(path.join(DIST, "styles.css"))).digest("hex").slice(0, 8);
(function bust(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) bust(p);
    else if (e.name.endsWith(".html")) {
      const h = fs.readFileSync(p, "utf8");
      fs.writeFileSync(p, h.replace(/href="\/styles\.css"/g, `href="/styles.css?v=${cssHash}"`));
    }
  }
})(DIST);

// ---------- report ----------
console.log(`posts: ${postEntries.length} archive pages`);
console.log(`pages kept: ${keptPages.map(p => p.slug).join(", ") || "none"}`);
console.log(`press items: ${pressItems.length}${press ? "" : " (press.json missing)"}`);
const wideThumbs = [...covers.values()].filter(c => c.thumb && c.thumb.width > 200).length;
console.log(`shelf (${shelfSource}): ${books.length} books in ${years.length} years (${years[years.length - 1] ?? "–"}–${years[0] ?? "–"}), ${lately.length} lately, ${covers.size} of ${books.filter(b => b.cover).length} covers mirrored, ${books.filter(b => !b.cover).length} books have none${shelf.quotes.length ? `, ${shelf.quotes.length} published passages not shown` : ""}${hasShelf ? "" : " — nothing published, /books is unlisted"}`);
if (wideThumbs) console.log(`  ${wideThumbs} list covers are wider than 200px: the shelf has no thumb for them yet and served its 400px copy`);
if (coverReport.failed.length) console.log("  covers typeset instead:\n  " + coverReport.failed.join("\n  "));
console.log(`sitemap: ${urls.length} urls`);
console.log(`assets: ${assetReport.total} referenced, ${assetReport.downloaded} downloaded, ${assetReport.cached} cached, ${assetReport.failed.length} failed`);
if (assetReport.failed.length) console.log("  failed:\n  " + assetReport.failed.join("\n  "));
console.log("dist ready.");
