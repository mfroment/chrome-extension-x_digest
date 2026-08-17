# X Digest — deferred work / known concerns

Pending items we've explicitly decided NOT to do yet, so they aren't lost.

## Next big milestones (raised 2026-07-27, not started — sleeping on them)

Unnumbered on purpose: these are the headline items, well above the numbered
maintenance work below. **B is a near-prerequisite for A** (a phone is only
useful if it sees the same reading state), and B is the single most consequential
design decision in the project so far.

### A. Smartphone-friendly design

- **The topbar doesn't fit a narrow screen**: brand + account selector + stats +
  search + 2 toggles + 4 action buttons + a subbar with tabs and status.
  (v0.10.9 freed the subbar-left slot, which helps.)
- **Right-click has no touch equivalent**, and there are now EIGHT right-click
  affordances — the canonical list is the Settings → "Right-click shortcuts"
  table. Each needs a touch path: long-press → the same context menu is the
  obvious mapping, plus an overflow "⋯" menu for the topbar actions.
- **Hover-only information** also has no touch equivalent: the Undo tooltip (what
  will be reverted), the reply-arrow tooltip (parent author), card titles.
- Reading ergonomics: tap-target sizes, card density, and the fact that the
  digest renders every visible post (see §1 — a phone will hit that wall sooner).
- Capture on mobile is a separate question: the interceptor hooks x.com web
  traffic, which does not apply to the native X app.

### B. Sync the DB across devices

Breaks the "everything stays local" property that has been the backbone of the
privacy and ToS posture, so it deserves an explicit, deliberate decision rather
than an incremental slide. `chrome.storage.sync` is nowhere near big enough
(~100 KB), so this means real hosting.

Settle these BEFORE writing code:
1. **What syncs?** Everything (posts + media refs + LLM output), or only the
   small mutable layer — read state, event flags, `processed_at`/summaries?
   The latter is dramatically cheaper and less sensitive, and may be enough if
   each device captures its own posts.
2. **Is the phone read-only** or does it capture too? Read-only is much simpler
   and probably the right first version.
3. **Where does it live?** Self-hosted vs a managed backend. Affects cost, auth,
   and how much of the privacy posture survives.
4. **Conflict resolution.** Read/unread and flags are per-account and mostly
   last-write-wins, but "mark read up to" style bulk actions need care.
5. **Volume.** ~500 posts/day ≈ 180k/year (see §1). A sync design should assume
   the windowed-loading model rather than "the whole DB", or the two will fight.
6. **Privacy.** The posts are public, but *what you read and like* is not —
   consider encrypting at rest, and never syncing the API key.

## 1. Scaling: the whole DB is held in memory (HIGH — real horizon)

`digest.js load()` calls `db.getAllPosts()` and keeps every post for the account
in the `all` array for the page's lifetime; every `render()` scans it.

- At the primary user's rate (~500 posts/day ≈ ~180k/year), this has a
  **months-not-years horizon**: around ~50–70k posts, `getAllPosts()` + holding
  it all starts to slow the digest *open* (memory + `getAll` latency).
- Read-day folding (v0.8.0) + lazy avatars only bound the **DOM**, not the data.
  DOM windowing (built in v0.11.5, item 3 below) also only bounds the DOM.
- CALIBRATION (2026-08-17): the slowdown reported as "the DB has grown to the
  extent that untoggling Unread only has a huge performance impact" turned out to
  be a **v0.11.2 regression, not this item** — a stray `&& !analyzedOnly()` on the
  folding condition kept every fully-read day expanded (~6300 cards ≈ 190k DOM
  nodes). Fixed in v0.11.5. So there is NO measured evidence yet for the
  months-horizon estimate above; it remains an extrapolation from the posts/day
  rate. Before spending the rework in #1, MEASURE the real cost of
  `getAllPosts()` + `all` at the current row count — the acute symptom that
  motivated the urgency was a bug, and DOM-level fixes have since absorbed the
  rendering side.

Priority order when we revisit (for this growth curve):
1. **Windowed data loading** — load only a recent window (e.g. last 30–60 days)
   into `all`; query older ranges from IndexedDB on demand ("load older").
   Bounds memory *and* `getAll` time, and subsumes DOM windowing. Needs a
   date-indexed query path in `db.js` and a rework of `load()`/`render()`.
2. **Retention / pruning** — optionally delete or archive old *read* posts so the
   IndexedDB store itself doesn't grow unbounded. Consider an export/backup first
   (data is local-only; pruning is destructive).
3. ~~**DOM windowing**~~ — DONE in v0.11.5 (`RENDER_CHUNK` = 150 + a
   `.render-more` IntersectionObserver sentinel). Folding stays the cheaper lever;
   windowing is the backstop for what folding can't collapse (a single huge
   partially-read day, or a filter matching thousands within one date).

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
