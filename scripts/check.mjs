#!/usr/bin/env node
// Verify dist/: internal link integrity, curated external links, JSON-LD validity,
// one-h1 rule, meta presence, and the reading shelf (every book of the shelf is on
// /books under its year, with its cover and its link to Bookshop.org; no passage is
// anywhere on the site). Archive-content outbound links are report-only.
// Usage: node scripts/check.mjs [--external] [--live]
//   --live  also compare the shelf that was built with what Marginalia serves right now

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SHELF_URL, SHELF_HOSTS, validateShelf, listedOn, bookshopUrl, revisionOf } from "./shelf.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const CHECK_EXTERNAL = process.argv.includes("--external");
const CHECK_LIVE = process.argv.includes("--live");

const htmlFiles = [];
const textFiles = []; // everything a reader or crawler can open as text
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".html")) htmlFiles.push(p);
    if (/\.(html|txt|xml|json)$/.test(e.name)) textFiles.push(p);
  }
})(DIST);

const errors = [];
const warnings = [];
const externalCurated = new Set();
const externalArchive = new Set();

// redirects defined in vercel.json count as valid internal targets
const vercelConf = JSON.parse(fs.readFileSync(path.join(ROOT, "vercel.json"), "utf8"));
const redirectSources = new Set((vercelConf.redirects || []).map(r => r.source.replace(/\/:path\*$/, "")));

const existsInternal = href => {
  const clean = href.split("#")[0].split("?")[0];
  if (!clean || clean === "/") return true;
  const rel = clean.replace(/^\//, "").replace(/\/$/, "");
  if (redirectSources.has("/" + rel.split("/")[0])) return true;
  return (
    fs.existsSync(path.join(DIST, rel)) ||
    fs.existsSync(path.join(DIST, rel, "index.html")) ||
    fs.existsSync(path.join(DIST, rel + ".html"))
  );
};

for (const file of htmlFiles) {
  const relFile = path.relative(DIST, file);
  const isCurated = ["index.html", "press/index.html", "archive/index.html", "books/index.html"].includes(relFile);
  const html = fs.readFileSync(file, "utf8");

  // h1 count
  const h1s = (html.match(/<h1[\s>]/g) || []).length;
  if (h1s !== 1) errors.push(`${relFile}: ${h1s} <h1> elements (want exactly 1)`);

  // title/meta/canonical
  if (!/<title>[^<]+<\/title>/.test(html)) errors.push(`${relFile}: missing <title>`);
  if (!/<meta name="description"/.test(html)) errors.push(`${relFile}: missing meta description`);
  if (!/<link rel="canonical"/.test(html)) errors.push(`${relFile}: missing canonical`);

  // JSON-LD validity
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try { JSON.parse(m[1]); }
    catch (e) { errors.push(`${relFile}: invalid JSON-LD (${e.message})`); }
  }

  // links
  for (const m of html.matchAll(/(?:href|src)=["']([^"']+)["']/g)) {
    const url = m[1];
    if (url.startsWith("mailto:") || url.startsWith("#") || url.startsWith("data:")) continue;
    if (url.startsWith("//")) { (isCurated ? externalCurated : externalArchive).add("https:" + url); continue; }
    if (url.startsWith("http://") || url.startsWith("https://")) {
      if (/danshipper\.com/.test(url) && !url.includes("wp-content")) continue; // canonical self-refs
      (isCurated ? externalCurated : externalArchive).add(url);
    } else {
      if (!existsInternal(url)) errors.push(`${relFile}: broken internal link ${url}`);
    }
  }
}

// a redirect wins over a file on Vercel, so one must never sit on top of a built page
for (const src of redirectSources) {
  const rel = src.replace(/^\//, "");
  if (fs.existsSync(path.join(DIST, rel, "index.html")) || fs.existsSync(path.join(DIST, rel + ".html"))) {
    errors.push(`vercel.json: redirect ${src} hides a built page`);
  }
}

// a build marker that was never filled in (a renamed or misspelled placeholder fails silently otherwise)
for (const file of textFiles) {
  const text = fs.readFileSync(file, "utf8");
  const rel = path.relative(DIST, file);
  for (const m of new Set(text.match(/<!--[A-Z][A-Z0-9_]*-->/g) || [])) errors.push(`${rel}: leftover placeholder ${m}`);
  // pages load nothing from Marginalia and do not point readers at it
  if (SHELF_HOSTS.some(h => text.includes(h))) errors.push(`${rel}: mentions the Marginalia host`);
}

// ---------- reading shelf ----------
const readJSON = f => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
const read = rel => (fs.existsSync(path.join(DIST, rel)) ? fs.readFileSync(path.join(DIST, rel), "utf8") : "");
const built = readJSON(path.join(DIST, "books.json"));               // the shelf as this dist/ lists it
// The shelf the build read, passages and all (outside dist/, gitignored). Used only when
// it is the one this dist/ was built from.
const builtFrom = readJSON(path.join(ROOT, ".books-cache", "built-from.json"));
const source = builtFrom && built && builtFrom.revision === built.revision ? builtFrom : null;
const booksHtml = read("books/index.html");

// The shelf is never committed (the repository is public and its history is forever):
// only its revision is, as one line.
const tracked = (() => { try { return execFileSync("git", ["ls-files", "content", ".books-cache"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean); } catch { return []; } })();
for (const f of tracked) if (/books\.json$|^\.books-cache\//.test(f)) errors.push(`${f}: a copy of the reading shelf is tracked by git (only content/books.revision may be)`);
const recorded = fs.existsSync(path.join(ROOT, "content", "books.revision")) ? fs.readFileSync(path.join(ROOT, "content", "books.revision"), "utf8") : null;
if (recorded === null) errors.push("content/books.revision: missing (it records the shelf's revision; scripts/refresh-shelf.mjs writes it)");
else if (!/^[0-9a-f]{64}\n$/.test(recorded)) errors.push("content/books.revision: must be one line, a sha256");
if (source && revisionOf(source) !== source.revision) errors.push(".books-cache/built-from.json: revision does not match its contents");

const mirroredCover = b => new RegExp(`^https://danshipper\\.com/books/covers/${b.id}-[0-9a-f]{8}\\.jpg$`).test(b.cover.url);
const builtErrs = built ? validateShelf(built, mirroredCover) : [];
if (!built || !booksHtml) errors.push("dist/books.json or dist/books/index.html: missing (run the build)");
else if (builtErrs.length) builtErrs.forEach(e => errors.push(`dist/books.json: ${e}`));
else {
  // Escaped here on its own terms, not with the build's function.
  const escaped = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  // No passages, for now: none on the page, and none of the shelf's published text in
  // any file a reader or crawler can open.
  if (/<blockquote|class="passage"|id="passages"/.test(booksHtml)) errors.push("books/index.html: shows passages (the page lists books only, for now)");
  if (built.quotes.length) errors.push("dist/books.json: carries passages (the built shelf lists books only, for now)");
  if (!source) warnings.push("the shelf this dist/ was built from is not at hand (.books-cache/built-from.json): passage text was not looked for");
  for (const q of source?.quotes || []) {
    const text = String(q.text || "");
    const probes = [text, escaped(text), ...text.split("\n")].filter(t => t.length >= 40);
    for (const file of textFiles) {
      const body = fs.readFileSync(file, "utf8");
      if (probes.some(t => body.includes(t))) errors.push(`${path.relative(DIST, file)}: carries the text of passage ${q.id}`);
    }
  }

  // it lists the books of the shelf it was built from and nothing else
  const sansCover = s => JSON.stringify([...s.books].map(b => ({ ...b, cover: null, quotes: 0 })).sort((a, b) => a.id.localeCompare(b.id)));
  if (source && sansCover(built) !== sansCover(source)) errors.push("dist/books.json: not the books of the shelf it was built from");

  // Every book is on the page once, under the year of its date, linked to Bookshop.org, with
  // a cover of the row's size or a stand-in. Every year from the newest to the oldest that has
  // a book has its section and its entry in the row of years; nothing is "undated".
  const sections = new Map(); // year -> html of its section
  for (const m of booksHtml.matchAll(/<section class="year" id="y(\d{4})"[^>]*>([\s\S]*?)<\/section>/g)) sections.set(m[1], m[2]);
  const wantYears = [...new Set(built.books.map(b => listedOn(b).slice(0, 4)))].sort().reverse();
  if (JSON.stringify([...sections.keys()]) !== JSON.stringify(wantYears)) errors.push(`books/index.html: year sections are ${[...sections.keys()].join(" ")}, the shelf's years are ${wantYears.join(" ")} (newest first)`);
  if (/Undated/i.test(booksHtml)) errors.push('books/index.html: has an "Undated" section');
  const indexed = [...(booksHtml.match(/<nav class="years"[\s\S]*?<\/nav>/) || [""])[0].matchAll(/<a href="#y(\d{4})" aria-label="\1, [\d,]+ books?">\1<span>(\d+)<\/span><\/a>/g)].map(m => `${m[1]}:${m[2]}`);
  const wantIndex = wantYears.map(y => `${y}:${built.books.filter(b => listedOn(b).slice(0, 4) === y).length}`);
  if (wantYears.length > 1 && JSON.stringify(indexed) !== JSON.stringify(wantIndex)) errors.push("books/index.html: the row of years does not match the books (each year once, with its count, newest first)");
  for (const [year, html] of sections) {
    const rows = (html.match(/<li>/g) || []).length;
    const want = built.books.filter(b => listedOn(b).slice(0, 4) === year).length;
    if (rows !== want) errors.push(`books/index.html: ${year} lists ${rows} books, the shelf has ${want}`);
    for (const m of html.matchAll(/<img\b[^>]*>/g)) if (!/ loading="lazy"/.test(m[0]) || !/ decoding="async"/.test(m[0])) errors.push(`books/index.html: a cover in ${year} is not lazy: ${m[0]}`);
  }
  for (const b of built.books) {
    const row = `<a class="book" href="${escaped(bookshopUrl(b))}"><span class="cover">`;
    const year = listedOn(b).slice(0, 4);
    const html = sections.get(year) || "";
    const at = html.indexOf(`<cite>${escaped(b.title)}</cite>`);
    if (at < 0) { errors.push(`books/index.html: ${b.id} is on the shelf but not under ${year}`); continue; }
    const li = html.slice(html.lastIndexOf("<li>", at), at);
    if (!li.includes(row)) errors.push(`books/index.html: ${b.id} is not linked to Bookshop.org`);
    if (b.cover ? !li.includes(`<img src="${b.cover.url.replace("https://danshipper.com", "")}"`) : !li.includes('<span class="typeset"')) errors.push(`books/index.html: ${b.id} has neither its cover nor a stand-in`);
  }
  for (const m of booksHtml.matchAll(/href="(https?:\/\/bookshop\.org\/[^"]*)"/g)) {
    if (!/^https:\/\/bookshop\.org\/(search\?keywords=[^&"]+)?$/.test(m[1])) errors.push(`books/index.html: unexpected Bookshop link ${m[1]}`);
  }
  // covers are local files with their size declared; nothing is hotlinked
  for (const m of booksHtml.matchAll(/<img\b[^>]*>/g)) {
    const img = m[0];
    if (!/ src="\/books\/covers\/[^"]+"/.test(img)) errors.push(`books/index.html: image is not a mirrored cover: ${img}`);
    else if (!fs.existsSync(path.join(DIST, img.match(/ src="\/([^"]+)"/)[1]))) errors.push(`books/index.html: cover file is missing: ${img}`);
    if (!/ alt="[^"]*"/.test(img) || !/ width="\d+"/.test(img) || !/ height="\d+"/.test(img)) errors.push(`books/index.html: image lacks alt, width or height: ${img}`);
  }
  // the page says, where a reader sees it first, how the list is made
  const lede = (booksHtml.match(/<h1>[\s\S]*?<\/h1>\s*<p class="lede">([\s\S]*?)<\/p>/) || [])[1] || "";
  if (!/automatically/.test(lede) || !/Claude/.test(lede) || !/ChatGPT/.test(lede)) errors.push("books/index.html: the line under the title does not say the list is made automatically by Claude and ChatGPT");

  // an empty shelf is linked from nowhere and asks not to be indexed; a shelf with books is listed everywhere
  const listed = {
    "sitemap.xml": read("sitemap.xml").includes("<loc>https://danshipper.com/books</loc>"),
    "index.html": read("index.html").includes('href="/books"'),
    "llms.txt": read("llms.txt").includes("https://danshipper.com/books)"),
    "books/index.html (indexable)": !booksHtml.includes('name="robots" content="noindex"'),
  };
  const want = built.books.length > 0;
  for (const [where, is] of Object.entries(listed)) {
    if (is !== want) errors.push(`${where}: ${want ? "the shelf has books but is not listed here" : "lists the shelf, which is empty"}`);
  }
  const homeRows = (read("index.html").split('<section id="reading"')[1] || "").split("</section>")[0].match(/<li>/g) || [];
  if (homeRows.length > 4) errors.push(`index.html: ${homeRows.length} books in the books section (at most 4)`);
  if (/<h2[^>]*>Reading<\/h2>/.test(read("index.html"))) errors.push('index.html: the books section is titled "Reading" (the shelf knows when a book was photographed, not that it is being read)');

  if (CHECK_LIVE) {
    try {
      const res = await fetch(SHELF_URL, { cache: "no-store", signal: AbortSignal.timeout(8000) });
      const live = await res.json();
      if (live.revision !== built.revision) errors.push("dist/books.json: Marginalia now serves a different shelf (rebuild)");
      if (recorded !== null && live.revision !== recorded.trim()) warnings.push("content/books.revision is not the revision Marginalia serves now (the Books shelf workflow records it; a deploy reads the live shelf either way)");
    } catch (e) { errors.push(`--live: could not reach the shelf (${e.message})`); }
  }
  console.log(`shelf: ${built.books.length} books in ${wantYears.length} years, revision ${built.revision.slice(0, 12)}`);
  warnings.forEach(w => console.log("  warn " + w));
}

console.log(`pages checked: ${htmlFiles.length}`);
console.log(`structural errors: ${errors.length}`);
errors.forEach(e => console.log("  ERROR " + e));

// Domains that block scripted clients but are confirmed live in real browsers.
const BOT_WALLED = ["inc.com", "axios.com", "bigthink.com", "entrepreneur.com", "linkedin.com", "x.com", "twitter.com", "finance.yahoo.com", "newyorker.com", "nytimes.com"];
const isBotWalled = url => BOT_WALLED.some(d => new URL(url).hostname.endsWith(d));

if (CHECK_EXTERNAL) {
  const head = async url => {
    const opts = { redirect: "follow", signal: AbortSignal.timeout(15000), headers: { "user-agent": "Mozilla/5.0 (Macintosh) link-check/1.0" } };
    try {
      let res = await fetch(url, { ...opts, method: "HEAD" });
      if ([403, 405, 501].includes(res.status)) res = await fetch(url, { ...opts, method: "GET" });
      return res.status;
    } catch (e) { return `ERR ${e.name}`; }
  };
  const runPool = async (urls, label, fatal) => {
    const list = [...urls];
    const bad = [];
    const workers = Array.from({ length: 8 }, async () => {
      while (list.length) {
        const u = list.shift();
        const s = await head(u);
        const ok = (typeof s === "number" && s < 400) || isBotWalled(u);
        if (!ok) bad.push(`${s} ${u}`);
      }
    });
    await Promise.all(workers);
    console.log(`${label}: ${urls.size} checked, ${bad.length} bad`);
    bad.sort().forEach(b => console.log(`  ${fatal ? "ERROR" : "warn"} ${b}`));
    if (fatal) errors.push(...bad.map(b => `external: ${b}`));
    else warnings.push(...bad);
  };
  await runPool(externalCurated, "curated external links", true);
  await runPool(externalArchive, "archive-content external links (report-only)", false);
}

console.log(errors.length ? `\nFAIL: ${errors.length} errors` : "\nPASS");
process.exit(errors.length ? 1 : 0);
