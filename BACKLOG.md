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

## 4. Stale like/counts — RESOLVED (differently) in v0.10.2 / v0.10.4

Originally declined on 2026-07-18 ("I can live with stale likes") because the
proposal was **refresh-on-scroll via extra API calls** — automated, view-triggered
polling, the highest-ToS-risk shape versus our human-paced posture, and possibly
404-gated by the same `x-client-transaction-id` header that killed bookmarks.

Revisited 2026-07-27 and solved **without any extra requests**, so the objection
no longer applies:

- **v0.10.2** — native like/unlike captured passively: the interceptor watches the
  `FavoriteTweet`/`UnfavoriteTweet` mutation X itself sends on click, and reflects
  `favorited` + an optimistic ±1 count. Liking a not-yet-stored post records it
  (with its cached content); an unlike, or a like with no cached record, is
  update-only.
- **v0.10.4** — refresh-on-browse: `REFRESH_OPS` (detail page, profile, search,
  list, bookmarks…) refresh counts/liked-state for posts **already in the digest**.
  Update-only — never inserts, never re-tags accounts, never advances
  `syncBoundary`.

**The rule that made it acceptable, worth keeping for future requests: parse X's
own traffic only — no extra API calls, no DOM scraping.** A per-post ↻ button
(one request per human click) remains the only shape we'd consider if a true
on-demand read were ever needed, and it would still need the single-post read
validated first.
