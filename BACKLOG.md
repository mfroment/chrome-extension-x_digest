# X Digest — deferred work / known concerns

Pending items we've explicitly decided NOT to do yet, so they aren't lost.

## 1. Scaling: the whole DB is held in memory (HIGH — real horizon)

`digest.js load()` calls `db.getAllPosts()` and keeps every post for the account
in the `all` array for the page's lifetime; every `render()` scans it.

- At the primary user's rate (~500 posts/day ≈ ~180k/year), this has a
  **months-not-years horizon**: around ~50–70k posts, `getAllPosts()` + holding
  it all starts to slow the digest *open* (memory + `getAll` latency).
- Read-day folding (v0.8.0) + lazy avatars only bound the **DOM**, not the data.
  Plain DOM windowing (deferred) also only bounds the DOM.

Priority order when we revisit (for this growth curve):
1. **Windowed data loading** — load only a recent window (e.g. last 30–60 days)
   into `all`; query older ranges from IndexedDB on demand ("load older").
   Bounds memory *and* `getAll` time, and subsumes DOM windowing. Needs a
   date-indexed query path in `db.js` and a rework of `load()`/`render()`.
2. **Retention / pruning** — optionally delete or archive old *read* posts so the
   IndexedDB store itself doesn't grow unbounded. Consider an export/backup first
   (data is local-only; pruning is destructive).
3. **DOM windowing** — render only ~150 cards near the viewport, append on scroll
   (sentinel). Smaller concern once #1 is in; still useful for a single huge
   unread day. Fits oldest-first reading (window grows downward).

## 2. Small pending cleanups

- **Remove the sync diagnostic log**: `console.log('[X Digest sync]', …)` in
  `content.js` `runSync` — kept while validating Sync; drop once it's trusted.
- **Event groups are single-account** (v0.9.0): a post's `event_group_id` is one
  field, so if the SAME post is enabled under two accounts its event only shows
  in whichever account grouped it first. Fine for the single-account user; revisit
  if multi-account event viewing is needed.
- **Large clustering call**: `clusterEvents` sends all upcoming groups in one call
  (bounded by Haiku output). If a season ever has hundreds of upcoming events,
  batch by month/date-window.

(Done in v0.8.1: sync-tab auto-close, dead capture fields removed, DB toggle
refactor, data export/import — see CLAUDE.md.)

## 3. Nice-to-haves surfaced in the 2026-07 review (not committed)

- Keyboard navigation (j/k move, r read, l like) — big for a daily reading tool.
- "Mark day read" action on unread day headers (pairs with folding).
- LLM cost: merge classify+summarize into one pass, and/or prompt-cache the
  identical system prompts, to cut input tokens.
- More smoke tests: extraction + op-name filter are covered (`test/`); the
  DOM-dependent seams (`cellInnerDiv`, tab-position clicking, the Sync stop
  logic) are not — they'd need a headless-browser harness.

## 4. Decided AGAINST (kept here so we don't re-open it by accident)

- **Refresh stale like/reply/repost counts on scroll-into-view** (raised
  2026-07-18, declined — user: "I can live with stale likes"). Reasons:
  1. Auto-refresh-as-posts-scroll is **automated, view-triggered polling** — the
     browser (not a human) decides to hit X. That's the highest-ToS-risk category
     vs. our standing posture (human-paced, low-volume, on-demand, no background
     polling); a long read session could fire hundreds of `TweetResultByRestId`
     reads even with a 5-min-per-post limiter. Reads more like scraping than a
     human clicking ♥.
  2. **Counts already refresh for free, ToS-safely**: whenever a post reappears
     in a captured timeline (Sync or normal browsing), `putPosts` merges the
     fresh `favorite_count`/reply/repost counts — they are NOT PROTECTED_FIELDS.
  3. **May not even work**: a single-tweet read could be gated behind the same
     `x-client-transaction-id` signed header that killed the bookmark feature
     (likes slipped through; reads might not).
  Only defensible revisit if ever wanted: a **per-post ↻ button** — one request
  per human click (same posture as the like button), 5-min guard — and validate
  the single-tweet read actually returns 200 before wiring it broadly.
