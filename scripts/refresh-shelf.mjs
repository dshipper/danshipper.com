#!/usr/bin/env node
// Notice that the reading shelf changed. Fetches the public shelf and, when its revision
// differs from the one recorded in content/books.revision, records the new one. That one
// line is all that is ever written: the shelf itself is never committed (this repository
// is public and its history is forever; see shelf.mjs). Run by
// .github/workflows/books-shelf.yml a few times an hour: the commit of a new revision to
// main is what makes Vercel rebuild the site, and that build reads the live shelf itself
// (and stops if it cannot), so this script only has to notice a change.
// Usage: node scripts/refresh-shelf.mjs
//   ALLOW_EMPTY=1  accept a shelf that had books and now has none (Dan took the list down)
//   exit 0  nothing changed, or the new revision was recorded (see the last line it prints),
//           or the shelf could not be reached or is older than this site reads (a warning;
//           the next run tries again)
//   exit 1  the shelf answered with something that is not a valid shelf, or went from books
//           to none without ALLOW_EMPTY: nothing is written
// With GITHUB_OUTPUT set (in a workflow) it also reports changed and revision.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SHELF_URL, SHELF_IS_PUBLISHED, publishedCover, validateShelf, revisionOf, emptiedUnasked } from "./shelf.mjs";

const RECORD = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "content", "books.revision");
const report = out => {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(out).map(([k, v]) => `${k}=${v}\n`).join(""));
};
const unchanged = why => {
  console.log(why);
  report({ changed: false });
  process.exit(0);
};

// Only the published endpoint's revision is ever recorded, exactly as for the build.
if (!SHELF_IS_PUBLISHED) {
  console.error("ERROR: MARGINALIA_SHELF_URL is set. The recorded revision is only ever the published shelf's.");
  process.exit(1);
}

let shelf;
try {
  const res = await fetch(SHELF_URL, { cache: "no-store", signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  shelf = await res.json();
} catch (e) {
  unchanged(`::warning::could not reach the reading shelf (${e.message}); content/books.revision is left as it is`);
}

// A shelf from before this site's format (Marginalia not deployed yet): wait for it.
if (Number.isInteger(shelf?.schema) && shelf.schema < 2) unchanged(`::warning::the reading shelf is schema ${shelf.schema}, older than this site reads; waiting for Marginalia`);

const errs = validateShelf(shelf, publishedCover);
if (!errs.length && revisionOf(shelf) !== shelf.revision) errs.push("revision is not the hash of the books and passages");
if (errs.length) {
  console.error(`ERROR: the shelf is not valid, nothing written:\n  ${errs.slice(0, 10).join("\n  ")}`);
  process.exit(1);
}

let recorded = null;
try { recorded = fs.readFileSync(RECORD, "utf8").trim() || null; } catch { /* never recorded: record it */ }
if (recorded === shelf.revision) unchanged(`unchanged: revision ${shelf.revision.slice(0, 12)}`);

if (emptiedUnasked(shelf, recorded) && process.env.ALLOW_EMPTY !== "1") {
  console.error("ERROR: the shelf had books and now has none. Nothing written, and the site keeps its last deploy.\n"
    + "  If Dan took the list down on purpose, run this workflow by hand with allow_empty.\n"
    + "  If not, Marginalia is answering with nothing (its PUBLIC_BOOKS switch?).");
  process.exit(1);
}

fs.writeFileSync(RECORD, shelf.revision + "\n");
console.log(`changed: revision ${shelf.revision.slice(0, 12)} recorded`);
report({ changed: true, revision: shelf.revision.slice(0, 12) });
