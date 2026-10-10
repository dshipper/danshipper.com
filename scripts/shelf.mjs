// The public reading shelf: where it comes from, what a valid one looks like, when a
// book is listed, and where its title links. Shared by build.mjs (fetches it),
// check.mjs (re-checks what was built) and refresh-shelf.mjs (notices that it changed).
// The shelf is the only thing this site reads from Marginalia, Dan's private
// reading library, and it carries only what is public there: the books Marginalia is
// sure he read (unless he made one private) and the passages he published.
//
// The shelf itself is never committed. This repository is public, and its history is
// forever: a committed copy would keep every book Dan later makes private, and say to
// the hour when each one appeared. What is committed is content/books.revision: the
// shelf's revision (a hash) and nothing else.

import crypto from "node:crypto";

const PUBLISHED_URL = "https://marginalia.everything-cloudflare.workers.dev/public/shelf.json";
export const SHELF_URL = process.env.MARGINALIA_SHELF_URL || PUBLISHED_URL;
// Only the published endpoint's answer is remembered (the revision in content/, a copy in
// .books-cache/). A shelf read from anywhere else (a local Marginalia, a test server)
// builds dist/ and stops there.
export const SHELF_IS_PUBLISHED = SHELF_URL === PUBLISHED_URL;
// Hosts no built page may mention.
export const SHELF_HOSTS = [...new Set([PUBLISHED_URL, SHELF_URL].map(u => new URL(u).host))];

// A shelf's revision is the hash of its books and passages, so the revision of a shelf
// with nothing on it is always this one.
export const revisionOf = shelf => crypto.createHash("sha256").update(JSON.stringify({ books: shelf.books, quotes: shelf.quotes, lately: shelf.lately })).digest("hex");
export const EMPTY_REVISION = revisionOf({ books: [], quotes: [], lately: [] });

// A shelf with books does not turn into an empty one by itself. If the endpoint answers
// with no books while the recorded revision is of a shelf that had some, that is either
// Dan taking the whole list down on purpose or Marginalia deployed with its switch off
// by mistake, and from here the two look the same. So an empty shelf is only accepted
// once the empty revision has been recorded on purpose (the workflow's "allow_empty").
export const emptiedUnasked = (shelf, recorded) => shelf.books.length === 0 && !!recorded && recorded !== EMPTY_REVISION;

// A cover is only ever fetched from the endpoint's own host, at the book's own address.
const coverAt = url => b => b.cover.url === new URL(`/public/covers/${b.id}.jpg`, url).href;
export const sourceCover = coverAt(SHELF_URL);
export const publishedCover = coverAt(PUBLISHED_URL);

// A list of several hundred covers asks for the smallest copy the shelf serves.
export const thumbOf = coverUrl => `${coverUrl}?size=thumb`;

// The date a book is listed under: when Dan finished it if he said so, otherwise the month
// of his most recent photo of it, otherwise when he started. Every book on the shelf has one.
export const listedOn = b => b.finished || b.last_photo || b.started;

// Each title links to the book at Bookshop.org, which pays independent bookshops.
// Checked in a browser, 2026-10-10 (Bookshop turns scripts away, so a build cannot test
// a link; the forms were tried by hand):
//   /search?keywords=<words>   always answers. It ranks titles that contain the words, so:
//                              - title and author finds a modern book first ("Atomic Habits
//                                James Clear"), where the title alone is often too common
//                                ("Paul", "Range", "Scale");
//                              - for a classic the author's name does harm: "Les Misérables
//                                Victor Hugo" returns study guides whose TITLES name Hugo, and
//                                not the novel; "Les Misérables" alone returns the novel first
//                                (the same for "War and Peace"). So a book first published
//                                before 1928 is searched by its title alone;
//                              - an edition note in brackets ("Big Magic (deluxe)") matches
//                                nothing, so it is left out of the words.
//   /book/<isbn13>             goes straight to that edition, but is a 404 for any edition
//                              Bookshop does not stock, and the shelf's ISBN is the edition
//                              Dan photographed, often an e-book or one out of print (2 of 6
//                              tried were 404s). Searching for the ISBN finds nothing at all.
// So every book gets a search link: it never dead-ends.
// THE ONE PLACE FOR AN AFFILIATE ID: Dan has none here yet. When he does, put it below;
// Bookshop's affiliate links take the form /a/<id>/<isbn13>, which has the same 404 problem
// as /book/<isbn13>, so check how Bookshop wants a search link credited before changing
// what bookshopUrl returns.
export const BOOKSHOP_AFFILIATE_ID = "";
const searchTitle = t => t.replace(/\s*[([][^)\]]*[)\]]\s*/g, " ").replace(/\s+/g, " ").trim() || t;
export const bookshopUrl = b => {
  const classic = Number.isInteger(b.year_published) && b.year_published < 1928;
  const words = [searchTitle(b.title), classic ? "" : b.authors[0] || ""].join(" ").trim();
  return `https://bookshop.org/search?keywords=${encodeURIComponent(words).replace(/%20/g, "+")}`;
};

const STATUSES = ["unknown", "reading", "finished", "paused", "abandoned"];
const BOOK_KEYS = ["id", "slug", "title", "subtitle", "authors", "status", "started", "finished", "first_photo", "last_photo", "year_published", "isbn13", "cover", "favorite", "note", "quotes"];
const QUOTE_KEYS = ["id", "book_id", "text", "page", "published_at"];
const DATE = /^\d{4}(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?)?$/; // may be partial: YYYY or YYYY-MM
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/; // a photo's date is only ever a month
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const TAG = /<\/?[a-zA-Z][^>]*>/;

// One line of plain text: no markup, no control characters.
const line = s => typeof s === "string" && s.trim() !== "" && !TAG.test(s) && !/[\u0000-\u001f\u007f]/.test(s);
// Quote text may also break lines (and carry a tab).
const prose = s => typeof s === "string" && s.trim() !== "" && !TAG.test(s) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s);
const sameKeys = (o, keys) => o && typeof o === "object" && !Array.isArray(o)
  && Object.keys(o).length === keys.length && keys.every(k => k in o);

// Returns a list of problems; empty means valid. Strict on purpose: an unknown key
// or a book note is refused rather than passed through, so nothing the site does
// not know how to show can reach a public page.
// coverOk(book) says whether a cover's URL is where it has to be: the endpoint's own
// address for a fetched shelf, the mirrored copy for the one in dist/.
export function validateShelf(shelf, coverOk) {
  const errs = [];
  if (!sameKeys(shelf, ["schema", "generated_at", "revision", "lately", "books", "quotes"])) return ["not a shelf: want exactly schema, generated_at, revision, lately, books, quotes"];
  // `lately`: the ids of the books that may be featured, each one a book of this shelf.
  if (!Array.isArray(shelf.lately) || !Array.isArray(shelf.books) || shelf.lately.some(id => typeof id !== "string" || !shelf.books.some(b => b && b.id === id))) return ["lately is not a list of ids of books on this shelf"];
  if (shelf.schema !== 2) errs.push(`schema ${JSON.stringify(shelf.schema)} (this site reads schema 2)`);
  if (!DATETIME.test(shelf.generated_at)) errs.push("generated_at is not an ISO timestamp");
  if (!/^[0-9a-f]{64}$/.test(shelf.revision)) errs.push("revision is not a sha256");
  if (!Array.isArray(shelf.books) || !Array.isArray(shelf.quotes)) return [...errs, "books and quotes must be lists"];

  const ids = new Set(), slugs = new Set();
  for (const [i, b] of shelf.books.entries()) {
    const at = `books[${i}]${b && typeof b.id === "string" ? ` ${b.id}` : ""}`;
    if (!sameKeys(b, BOOK_KEYS)) { errs.push(`${at}: keys differ from the contract`); continue; }
    if (!/^bk_[0-9a-f]{12}$/.test(b.id) || ids.has(b.id)) errs.push(`${at}: bad or repeated id`);
    if (typeof b.slug !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(b.slug) || slugs.has(b.slug)) errs.push(`${at}: bad or repeated slug`);
    ids.add(b.id); slugs.add(b.slug);
    if (!line(b.title)) errs.push(`${at}: title is not one line of plain text`);
    if (b.subtitle !== null && !line(b.subtitle)) errs.push(`${at}: subtitle is not one line of plain text`);
    if (!Array.isArray(b.authors) || !b.authors.every(line)) errs.push(`${at}: authors must be a list of plain names`);
    if (!STATUSES.includes(b.status)) errs.push(`${at}: unknown status`);
    for (const k of ["started", "finished"]) if (b[k] !== null && !DATE.test(b[k])) errs.push(`${at}: ${k} is not YYYY, YYYY-MM or YYYY-MM-DD`);
    for (const k of ["first_photo", "last_photo"]) if (b[k] !== null && !MONTH.test(b[k])) errs.push(`${at}: ${k} is not a month (YYYY-MM)`);
    if ((b.first_photo === null) !== (b.last_photo === null) || (b.first_photo !== null && b.first_photo > b.last_photo)) errs.push(`${at}: first_photo and last_photo do not make a range`);
    // the page has no place for a book without a date, and the shelf promises there is none
    if (!listedOn(b)) errs.push(`${at}: has no date at all (no photo month, no finished or started date)`);
    if (!Number.isInteger(b.quotes) || b.quotes < 0) errs.push(`${at}: quotes is not a count`);
    if (b.year_published !== null && !Number.isInteger(b.year_published)) errs.push(`${at}: year_published is not a year`);
    if (b.isbn13 !== null && !/^\d{13}$/.test(b.isbn13)) errs.push(`${at}: isbn13 is not 13 digits`);
    if (b.cover !== null && !(sameKeys(b.cover, ["url", "width", "height"]) && typeof b.cover.url === "string" && coverOk(b)
      && Number.isInteger(b.cover.width) && b.cover.width > 0 && Number.isInteger(b.cover.height) && b.cover.height > 0)) errs.push(`${at}: cover is not {url, width, height} at the expected address`);
    if (typeof b.favorite !== "boolean") errs.push(`${at}: favorite is not true or false`);
    if (b.note !== null) errs.push(`${at}: carries a note (book notes are private; this site refuses them)`);
  }

  const qids = new Set();
  for (const [i, q] of shelf.quotes.entries()) {
    const at = `quotes[${i}]${q && typeof q.id === "string" ? ` ${q.id}` : ""}`;
    if (!sameKeys(q, QUOTE_KEYS)) { errs.push(`${at}: keys differ from the contract`); continue; }
    if (!/^ps_[0-9a-f]{16}$/.test(q.id) || qids.has(q.id)) errs.push(`${at}: bad or repeated id`);
    qids.add(q.id);
    if (!ids.has(q.book_id)) errs.push(`${at}: its book is not on the shelf`);
    if (!prose(q.text)) errs.push(`${at}: text is not plain text`);
    if (q.page !== null && !(line(q.page) && q.page.length <= 80)) errs.push(`${at}: page is not a short plain label`);
    if (!DATETIME.test(q.published_at)) errs.push(`${at}: published_at is not an ISO timestamp`);
  }
  // each book says how many of its passages are published, and that is how many there are
  for (const [i, b] of shelf.books.entries()) {
    if (b && Number.isInteger(b.quotes) && b.quotes !== shelf.quotes.filter(q => q && q.book_id === b.id).length) errs.push(`books[${i}] ${b.id}: says ${b.quotes} quotes, the shelf carries ${shelf.quotes.filter(q => q && q.book_id === b.id).length}`);
  }
  return errs;
}
