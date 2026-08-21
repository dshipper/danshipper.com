---
title: "feat: Add Platformer interview to press coverage"
type: feat
status: active
date: 2026-08-21
---

# Add Platformer Interview to Press Coverage

## Overview

Add the August 20, 2026 Platformer interview with Dan Shipper to the personal site's structured press collection and promote it on the homepage.

## Problem Frame

The Platformer interview is published but absent from Dan's personal site. The site already has one structured source for press coverage, and new major interviews should follow that existing path so the homepage, full press page, metadata, and answer-engine output stay aligned.

## Requirements Trace

- R1. Add the verified Platformer headline, URL, outlet, date, interview type, and a factual summary.
- R2. Make the interview the newest entry on the full press page and a homepage press highlight.
- R3. Preserve the site's current press rendering and metadata behavior.
- R4. Publish the change and verify the production pages.

## Scope Boundaries

- Do not redesign the press section or change its item limit.
- Do not edit the Platformer article or add unverified claims beyond its public metadata.
- Do not modify historical press entries.

## Context & Research

### Relevant Code and Patterns

- `content/press.json` is the canonical source for press items and uses reverse-chronological records with `highlight` controlling homepage inclusion.
- `scripts/build.mjs` filters valid items, renders up to 14 homepage highlights, sorts the full press page by date, and emits press metadata.
- `scripts/check.mjs` validates generated structure, metadata, JSON-LD, and links across the built site.
- Recent commits such as `Add Axios coverage` and `Add Wall Street Journal coverage` establish the direct content-update pattern.

### Institutional Learnings

- No repository-local `docs/solutions/` knowledge base exists. Prior site work establishes that a successful build must be followed by a visible-page check and live production verification.

### External References

- Platformer article: `https://www.platformer.news/every-dan-shipper-interview-ai-writing/`

## Key Technical Decisions

- Store the interview only in `content/press.json`: the existing build already propagates this source to every relevant surface.
- Set `highlight: true`: this is a major named interview and should appear with other prominent press on the homepage.
- Use the article's displayed date, August 20, 2026: its machine timestamp crosses midnight UTC, while the public page explicitly displays August 20.

## Open Questions

### Resolved During Planning

- Placement: press coverage, because the site already categorizes comparable interviews there.
- Publication date: August 20, based on the article's visible date.

### Deferred to Implementation

- None.

## Implementation Units

- [x] **Unit 1: Add the verified press record**

  **Goal:** Represent the Platformer interview in the canonical press source.

  **Requirements:** R1, R2, R3

  **Dependencies:** None

  **Files:**
  - Modify: `content/press.json`
  - Test: `scripts/check.mjs`

  **Approach:** Add the new record first in the reverse-chronological list, advance `compiled_at`, use the established interview schema, and enable homepage highlighting.

  **Patterns to follow:** The Axios, Wall Street Journal, Lenny's Podcast, and Mixergy entries in `content/press.json`.

  **Test scenarios:**
  - Happy path: build the site with the new valid item and confirm it appears first on `/press/` under 2026.
  - Integration: confirm the highlighted item appears first in the homepage Press section and in press-page JSON-LD.
  - Error path: run the structural verifier and confirm the new URL and generated markup introduce no validation errors.

  **Verification:** The generated homepage and press page both contain the exact Platformer headline and destination URL, and the site verifier passes.

- [ ] **Unit 2: Verify and publish the rendered site**

  **Goal:** Ensure the entry is visibly correct and available on production.

  **Requirements:** R2, R4

  **Dependencies:** Unit 1

  **Files:**
  - Verify: `dist/index.html`
  - Verify: `dist/press/index.html`
  - Test: `scripts/check.mjs`

  **Approach:** Rebuild generated output, inspect both affected routes in a browser, publish through the repository's main-branch deployment flow, and reopen production to verify the deployed content.

  **Patterns to follow:** The deployment flow documented in `README.md` and prior press coverage commits.

  **Test scenarios:**
  - Happy path: the homepage shows Platformer first among highlighted press items.
  - Happy path: `/press/` shows Platformer first under 2026.
  - Integration: the production deployment serves the new headline and external URL after the main-branch push.

  **Verification:** Local build and structural checks pass, visible browser checks pass, and the production homepage and press page both expose the new interview.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| UTC metadata could shift the article to August 21 | Use the date displayed to readers on Platformer: August 20. |
| A successful push may not trigger deployment | Verify production after push and deploy directly only if production remains stale. |
| The external article could be bot-walled | Verify the public page and destination in a real browser rather than relying only on automated link checks. |

## Documentation / Operational Notes

- No user-facing documentation changes are needed.
- `dist/` is generated output and should be rebuilt for verification but not treated as the canonical source.

## Sources & References

- Related code: `content/press.json`, `scripts/build.mjs`, `scripts/check.mjs`
- Repository workflow: `README.md`
- External article: `https://www.platformer.news/every-dan-shipper-interview-ai-writing/`
