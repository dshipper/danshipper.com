#!/usr/bin/env node
// Verify dist/: internal link integrity, curated external links, JSON-LD validity,
// one-h1 rule, meta presence. Archive-content outbound links are report-only.
// Usage: node scripts/check.mjs [--external]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const CHECK_EXTERNAL = process.argv.includes("--external");

const htmlFiles = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".html")) htmlFiles.push(p);
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
  const isCurated = ["index.html", "press/index.html", "archive/index.html"].includes(relFile);
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

console.log(`pages checked: ${htmlFiles.length}`);
console.log(`structural errors: ${errors.length}`);
errors.forEach(e => console.log("  ERROR " + e));

// Domains that block scripted clients but are confirmed live in real browsers.
const BOT_WALLED = ["inc.com", "axios.com", "bigthink.com", "entrepreneur.com", "linkedin.com", "x.com", "twitter.com", "finance.yahoo.com"];
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
