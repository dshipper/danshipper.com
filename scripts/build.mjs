#!/usr/bin/env node
// Build danshipper.com: site/ + content/*.json -> dist/
// No dependencies. Node 18+.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE = path.join(ROOT, "site");
const DIST = path.join(ROOT, "dist");
const CONTENT = path.join(ROOT, "content");
const ASSET_CACHE = path.join(CONTENT, "wp-assets");
const ORIGIN = "https://danshipper.com";

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

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const fmtMonthYear = iso => {
  const m = String(iso).match(/^(\d{4})-(\d{2})/);
  return m ? `${MONTHS[+m[2] - 1]} ${m[1]}` : String(iso);
};
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
${items.map(i => `      <li><span class="when">${esc(fmtMonthYear(i.date))}</span><span class="what"><span class="outlet"><span class="m-when" aria-hidden="true">${esc(fmtMonthYear(i.date))} · </span>${esc(i.outlet)}</span><a href="${attr(i.url)}">${esc(i.title)}</a>${i.note ? `<span class="note">${esc(i.note)}</span>` : ""}</span></li>`).join("\n")}
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

// 6) sitemap
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url><loc>${ORIGIN}${u.loc}</loc><lastmod>${u.lastmod}</lastmod></url>`).join("\n")}
</urlset>
`;
fs.writeFileSync(path.join(DIST, "sitemap.xml"), sitemap);

// 7) llms-full.txt — the whole site as one markdown file for AI crawlers
const llmsFull = [
  fs.readFileSync(path.join(SITE, "llms.txt"), "utf8"),
  "\n## Selected writing (full list)\n",
  ...(writing?.essays || []).map(e => `- [${decode(e.title)}](${e.url}) (${e.date})`),
  "\n## Notable AI & I episodes\n",
  ...(writing?.podcast?.notable_episodes || []).map(e => `- [${decode(e.title)}](${e.url}) (${e.date}) — ${e.note}`),
  "\n## Timeline\n",
  ...(timeline?.items || []).map(t => `- ${t.when}: ${t.what}`),
  "\n## Press coverage\n",
  ...pressItems.map(i => `- ${i.date} — ${i.outlet}: [${decode(i.title)}](${i.url})`),
  "\n## Blog archive (2010–2016)\n",
  ...postEntries.map(e => `- ${String(e.date).slice(0, 10)} — [${decode(e.title)}](${ORIGIN}/${e.slug})`),
].join("\n");
fs.writeFileSync(path.join(DIST, "llms-full.txt"), llmsFull);

// 8) mirror wp assets into dist
const assetReport = await mirrorAssets();
if (fs.existsSync(ASSET_CACHE)) {
  fs.cpSync(ASSET_CACHE, DIST, { recursive: true });
}

// 9) cache-bust the stylesheet everywhere (browsers cache /styles.css across deploys)
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
console.log(`sitemap: ${urls.length} urls`);
console.log(`assets: ${assetReport.total} referenced, ${assetReport.downloaded} downloaded, ${assetReport.cached} cached, ${assetReport.failed.length} failed`);
if (assetReport.failed.length) console.log("  failed:\n  " + assetReport.failed.join("\n  "));
console.log("dist ready.");
