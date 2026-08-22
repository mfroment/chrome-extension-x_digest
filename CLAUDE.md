# X Digest — project context

Chrome extension (MV3) that turns the user's X (Twitter) timeline into a local reading
digest. The extension is generic: each account's themes are user-configured in
natural language, and nothing about any particular subject is hard-coded — treat the
themes as opaque, user-supplied text. Lexicon: "X"/"post" everywhere in our code (functions
`postCard`/`putPosts`/`getAllPosts`, IndexedDB store `posts`, record fields
`repost_count`/`is_repost`/`repost_of`, messages `XD_POSTS`/`postId`). Only X's
OWN literal API identifiers keep their names, so the code still matches X's network
responses: GraphQL ops `FavoriteTweet`/`UnfavoriteTweet`, request var `tweet_id`,
response fields `note_tweet`/`retweeted_status_result`/`TweetWithVisibilityResults`
and the source `lg.retweet_count`. (Full tweet→post rename + DB v3 migration done
2026-07-14.) This file carries over the full context so any Claude Code session can continue.

## Who this is for

Someone who follows enough accounts that the timeline is hard to keep up with
(hundreds of posts/day) and likes a meaningful share of what they read — valuing
the social reciprocity that builds, so liking must stay easy and **always
human-decided, never automated or LLM-decided**.

Posts fall into 3 treatment tiers (theme definitions are user-configurable in
natural language, see LLM pipeline below):
1. Full-detail themes — the highest-priority topics that must not be missed, where
   key info is sometimes only on an attached image (→ structured extraction + image
   vision)
2. Summary themes — other topics the user cares about, worth a one-line summary
3. Everything else — a one-line summary plus a short theme chip

## Pain points being solved

- X's timeline makes catching up after a day away painful (finding the last-read
  post, scrolling backwards, posts moving/disappearing due to replies/deletes/reposts)
- Translating posts one by one is too slow

## Architecture (agreed in design conversation)

1. **Capture**: content script in MAIN world hooks fetch/XHR on x.com, intercepts
   `HomeLatestTimeline` / `HomeTimeline` GraphQL responses, extracts Post objects
   recursively, relays via postMessage → content script (isolated) → service worker
   → IndexedDB. Dedup by post ID; re-captures refresh counters but never overwrite
   user state (`read`) or future LLM fields (`category`, `summary`, `translation` —
   see PROTECTED_FIELDS in db.js).
2. **LLM pipeline** (step 2, NOT built yet): Anthropic API called directly from the
   extension (user has a Claude API key, stored locally in extension settings).
   - Settings page: API key, LLM output language (default: the **browser's locale
     language**), and the theme configuration below — all user-editable, nothing
     hard-coded.
   - Themes are configured as **natural-language descriptions** in two lists:
     - *Full-detail themes* → structured extraction in the output language (date,
       venue, event name, cancellation/postponement) + vision on attached images
       (often the only source of date/venue).
     - *Summary themes* → one-line summary in the output language.
   - Classification against these theme descriptions in batches of ~50 posts
     (Haiku-class model); optional free keyword pre-filter (user-chosen terms,
     dates…).
   - Everything else (tier 3 "other"): a one-line summary too, plus the 1–3 word
     theme chip (2026-07-14: previously only high-affinity authors got a summary
     and the rest got theme-only, gated by a per-author like rate + optimistic
     bonus; that gating was removed — Haiku is cheap enough to summarize all
     tier-3, ~0.03¢/post. `computeAuthorScores` and the `likeThreshold`/
     `likeBonus` settings were fully removed in v0.5.3, along with their
     settings-page fields and the `clamp` helper).
   - Full translation and image analysis always available on demand (per-post
     button), regardless of tier.
3. **Digest UI** (step 1 built as raw view; step 2 adds sections): upcoming events
   sorted by date pinned on top (they stay visible until their date, like an agenda),
   then reports, then type 3 collapsed. Read/unread per post, "read up to here"
   action, red "you were here" reading line at the read/unread boundary.
4. **Sync + likes** (step 3, NOT built yet):
   - "Sync" button in the digest: opens/reuses an x.com tab, auto-scrolls the
     Following timeline, stops when it reaches an already-known post ID, notifies.
   - Like from the digest: digest sends a message to the extension, which performs
     the like on x.com using the user's existing session. Human clicks only.
   - User is aware this technically strays from X ToS; keep behavior human-paced
     and low-volume (on-demand only, no background polling).

## Multi-account (v0.3, built on top of step 2)

Digests are **per X account, opt-in** (2026-07-13 requirement):
- `content.js` detects the logged-in account (twid cookie -> user id, profile
  nav link -> handle) and tags every capture batch.
- `background.js` auto-registers unseen accounts in the `accounts` registry
  (chrome.storage.local), **disabled by default**; captures from disabled
  accounts are dropped (nothing stored). Badge counts enabled accounts only.
- Global settings: API key, model, output language. Per-account: enabled flag +
  digest criteria (full-detail / summary theme lists).
- DB v2: `accounts` array on each post (multiEntry index; ids of the viewing
  accounts that captured it), read/unread actions and the pipeline scoped by
  account. Author like-rates are computed per viewing account.
- Settings page lists seen accounts with a toggle + criteria editor; enabling
  an account offers to adopt pre-v2 untagged rows. Digest topbar has an account
  selector (hidden when only one account is enabled).
- IMPORTANT consequence: after the v0.3 update the user must enable their
  account in settings, or capture silently stores nothing.

## Like + bookmark from digest (v0.4.x, first half of step 3)

- ♥ like and 🔖 bookmark on each card are TOGGLES (v0.4.3): click flips state
  via FavoriteTweet/UnfavoriteTweet and CreateBookmark/DeleteBookmark. One API
  request per human click, nothing automated. `on` (target state) is sent in
  the XD_LIKE/XD_BOOKMARK message; a no-op result (e.g. unliking something not
  liked) counts as success. `favorited`/`bookmarked` and favorite_count are
  updated optimistically and persisted.
- interceptor.js sniffs the public web-app bearer token from X's own requests
  (fetch + XHR setRequestHeader, once per page load) -> content.js (XD_AUTH,
  account-tagged) -> stored in chrome.storage.local `xAuth[accountId]`.
- background.js `xMutation`: checks the twid cookie so the ACTIVE x.com session
  matches the digest account (refuses otherwise), sends the GraphQL mutation
  with session cookies + ct0 csrf. Used by `likePost` (FavoriteTweet) and
  `bookmarkTweet` (CreateBookmark, v0.4.1 — 🔖 button, `bookmarked` field now
  captured from lg.bookmarked). "already favorited/bookmarked" treated as ok.
- Bookmark-from-digest was REMOVED (v0.4.12) as not achievable. Investigation:
  the id (aoDbu3RHznuiSkQ9aNM67Q, from X's own request URL) and the body (X's
  captured native body is the minimal {variables:{tweet_id},queryId}) are both
  correct, and running the request from an x.com page's MAIN world (so it has the
  x.com Origin/Referer) STILL returned an empty-body 404 — while FavoriteTweet
  returns 200 through the identical path. Conclusion: X gates CreateBookmark
  behind a per-request signed header (x-client-transaction-id) that only its own
  obfuscated client can generate; it can't be reproduced/replayed from an
  extension. Like/unlike are unaffected (X doesn't enforce it there) and run via
  a direct service-worker fetch (no open-tab requirement). The 🔖 button, the
  XD_BOOKMARK path, bookmarkTweet, and the page-fetch relay were all removed;
  USED_OPS harvesting is now just FavoriteTweet/UnfavoriteTweet. If revisiting,
  the only route is generating a valid x-client-transaction-id (fragile,
  reverse-engineered, breaks on X updates) — deliberately not pursued.
- GraphQL operation ids are SELF-HEALING: interceptor.js harvests opName->queryId
  (a) from live /i/api/graphql/<id>/<Op> URLs and (b) by scanning X's JS bundles
  (PerformanceObserver re-scans lazily-loaded chunks, so bookmark-module ops are
  caught when that chunk loads — e.g. on visiting the Bookmarks page). Stored in
  chrome.storage.local `xOps`; xMutation prefers harvested ids. CRITICAL (v0.4.6):
  bundle pairing must match `queryId` and `operationName` as ADJACENT keys of the
  same object (regex alternation for both key orders) — an earlier proximity-window
  approach mis-paired each op with a neighbour's id (e.g. CreateBookmark got
  CreateHighlight's id → 404). Only FavoriteTweet has a hardcoded fallback (it also
  harvests early from the timeline bundle); the other three mutations must be
  harvested, so a wrong guessed id is never sent. On a 404 the stored id is dropped
  (forgetOp) and onInstalled clears `xOps` so old buggy ids are relearned.
- Manifest: added "cookies" permission + x.com host permission (v0.4.0).

## Sync auto-scroll (v0.7.0, second half of step 3)

"🔄 Sync" in the digest topbar drives x.com to fetch newer posts, stopping when
it reaches what we already have. Capture stays passive (interceptor); Sync only
automates the scrolling.
- Stop threshold is a TIMESTAMP FLOOR (`frontier`). `background.startSync`:
  guards the twid cookie matches the account, then computes the floor:
  `floorTs` (a one-shot UI override, see below) if given, else the PERSISTED
  per-account `syncBoundary` (chrome.storage) minus `SYNC_MARGIN_MS`(5min) of
  overlap. The boundary is deliberately NOT the current global max, so casual
  browsing between syncs can't plant a recent post that plugs the gap; it only
  advances (to the new global max) when a sync finishes caught-up or end-of-feed
  (`handleSyncDone`), never on a cap/abort. `seedBoundary` sets it to `Date.now()`
  the first time the digest is opened for an account (`XD_SYNC_SEED`, sent from
  digest init + account switch) — like X, you start "current." Then focuses/opens
  a VISIBLE x.com tab on `/home`, waits for load, `tabs.sendMessage(XD_SYNC_START
  {frontier})`. Driver in `content.js` `runSync`: clicks the 2nd home tab
  (Following = chronological, by position so it's locale-independent), scrolls
  `window.scrollBy(0, innerHeight*2)` on a 1.5s tick (pacing from x_feed_search).
- Override: right-click Sync -> `syncMenu` (oldest unread post — the
  reading-driven floor, shown with its timestamp and omitted when nothing is
  unread; then back 6h/24h; or a
  `syncDatePicker` datetime-local popover, interpreted in LOCAL time) -> passes
  `floorTs` to force a further-back run. After it completes, the boundary
  re-advances so the next default sync is incremental again.
- Stop signals (sortIndex was investigated and DROPPED — a per-feed ordinal
  anchored to generation time, not comparable across sessions; see git history):
  (a) caught-up = last `OLD_RUN`(25) captured posts ALL `<= frontier` (created_at
  is stable; bumped-thread replies stay newer than the floor so they don't stop
  us early); (b) end-of-feed = `STALL_TICKS`(4) scrolls with nothing new WHILE
  PARKED AT THE BOTTOM (an empty tick only counts as stall when
  `scrollY+innerHeight >= scrollHeight-200` — otherwise we're just traversing the
  tall already-loaded first page, which used to trip a naive stall counter and
  stop after ~2 scrolls); needs `sawCapture` first, else `WARMUP_SCROLLS`(10)
  before a benign `no-new` (already current / feed never paginated);
  (c) SEATBELT caps 300s / 300 scrolls — pure anti-runaway, not the real stop.
- Hard guard: `interceptor.ship` now tags each batch with its `op`
  (HomeLatestTimeline vs HomeTimeline); the driver aborts if it sees For You
  (`HomeTimeline`) — Sync must never run on the For You feed.
- Driver reports `XD_SYNC_PROGRESS`/`XD_SYNC_DONE` via runtime.sendMessage (reach
  both the SW -> updateBadge, and the digest -> reload + show net new count,
  computed as a post-count delta around the run). Manifest: added "tabs"
  permission (focus/query the sync tab) in v0.7.0.
- Tab behavior: ALWAYS opens a fresh x.com tab on /home (never hijacks a tab the
  user is reading); the driver then selects the Following/Latest feed. On finish,
  the overlay's Stop button becomes "Cancel autoclose" and the tab closes after a
  5s countdown (`startAutoClose` -> `XD_SYNC_CLOSE_TAB` -> `chrome.tabs.remove`),
  cancellable. On-page overlay lives in `content.js` (fixed pill, top-right).

## Backup, cleanup, tests (v0.8.1)

- Data backup: Settings has Export/Import (`settings.js` exportData/importData ->
  `db.bulkPut`). Export = JSON of posts + accounts registry + non-secret global
  settings (API key deliberately excluded). Import overwrites posts by id, merges
  accounts (backup wins), restores non-secret settings. IndexedDB is
  origin-scoped (extension-private) and has no other backup, hence this.
- DB: `toggleRead`/`toggleEventHidden` now share a generic `updateRecord(id, fn)`.
- Removed capture fields never read anywhere: `quote_count`, `bookmarked`
  (bookmark feature is gone), post `lang`.
- Tests: `test/extract.test.mjs` (`npm test` -> `node --test`) runs the real
  `interceptor.js` in a `vm` sandbox with fake browser globals against a sample
  timeline payload; asserts extraction (entity decode, repost fields,
  TweetWithVisibilityResults unwrap) + the timeline op-name URL filter. No deps,
  no build; guards OUR parsing regressions (not X format changes). `package.json`
  is dev-only tooling — Chrome ignores it.

## Event clustering + pinning (v0.9.0, DB v4)

Events became first-class objects so duplicates (same event announced by several
accounts, worded differently) collapse into one, and flags attach to the event.
- DB v4: new `events` store, one record per real-world event
  `{ id, account, date, name, venue, time, status, description, flag, post_ids[],
  updated_at }` (`flag` = 'pinned'|'hidden'|null). Posts gain `event_group_id`.
  Migration just creates the (empty) store; groups are built lazily.
- `ensureEventGroups(todayISO, accountId)` (db.js, no LLM, idempotent): singleton
  group per ungrouped upcoming event; legacy per-post `event_hidden` seeds the
  group flag. Runs on digest load + account switch (so the Events tab is populated
  immediately, incl. legacy events pre-first-Analyze) and at the start of the
  clustering step.
- Clustering runs as the final step of `runPipeline` (skipped for `onlyIds` reply
  re-analysis; runs even when nothing new to extract → backfills legacy on first
  Analyze). `pipeline.groupEvents`: reconcile/prune orphan groups → one
  `llm.clusterEvents` call (groups events within ±1 day, fuzzy name/venue, keyed
  by integer index, safety-net keeps any the model dropped) → merge duplicate
  groups keeping a flagged member as survivor (pinned>hidden>first) → one
  `llm.mergeEventDescription` call per multi-post group.
- Events tab renders GROUPS from the store: date order, pinned-first within a
  date + highlighted; 📌 pin / 🙈 hide toggles (mutually exclusive) per group;
  links to ALL source posts; "Unhidden only" OFF reveals hidden. Flags go through
  `db.setEventFlag`; undo covers them via `applyFieldUpdates` (now takes a
  per-update `store`, 'posts' default or 'events').
- `clearAnalysis` also clears `event_group_id`; groupEvents prunes the orphaned
  group on the next run (keeps re-analyze consistent).
- Multi-day events (v0.9.1): extraction captures `end_date` (start `date` + last
  day; = start for single-day). An event stays "current" until `(end_date||date) <
  today` but sorts/shows on its START date; clustering keeps the widest range.
  `fmtEventRange` renders "14–16 Aug" / "14 Aug – 3 Sep". Forward-looking: existing
  events gain `end_date` only when re-analyzed.
- Clustering robustness + event-posts re-analyze (v0.9.2–0.9.4): grouping now
  detects its own end-of-task (the "Grouping events" progress no longer hangs
  after real work is done) and runs even when there is no NEW raw event post to
  extract (so a fresh Analyze still re-clusters/backfills). New re-analyze scope
  "↻ Re-analyze event posts only" (first item in the right-click ✨ Analyze menu,
  with a live count): `clearAnalysis({ onlyEvents: true })` wipes analysis +
  `event_group_id` for just the posts whose extraction produced an event
  (`t.event` set — the handful of tier-1 announcements), re-extracts only those
  (cheap way to backfill `end_date`/future event fields), then re-clusters; the
  thousands of tier-3 posts are untouched.

## Dead X media: text-only fallback + placeholder (v0.11.7)

A full-detail post failed every Analyze run with `API 400: Unable to download
the file` — the media had been deleted from X (broken on the card AND on x.com),
and the Messages API downloads image URLs SERVER-SIDE, so an unfetchable URL
failed the whole call and the post stayed unprocessed forever, retrying and
failing on each run.
- `llm.js`: `extractFull` and `translatePost` build their content via a local
  `call(withImages)` and retry ONCE without images when the error matches
  `IMAGE_UNFETCHABLE` (`unable to download|failed to download/fetch`). Any other
  API error still propagates. A text-only analysis beats none.
- The degradation is NOT silent: `extractFull` returns `images_unavailable: true`,
  `pipeline` persists it (added to `PROTECTED_FIELDS`) and pushes
  `images unavailable, analyzed from text only` into the run's `errors`, which
  reach the console and the status element's `title`. This matters because a
  flyer often carries the only date/venue, so such an extraction can be thinner
  than a real full-detail one.
- `digest.js`/`digest.css`: an `error` listener on each thumbnail swaps the
  browser's broken-image icon for a `.media-gone` placeholder ("Image/Video no
  longer available"), same 130px height so the card doesn't reflow, and drops the
  `href` (it pointed at the same dead URL). Render-time, so it fixes already-
  captured dead media with no re-capture.
- DEBUGGING NOTE: pipeline errors already surface in two places — `console.warn`
  on the digest page and the pipeline status element's tooltip. The prefix names
  the stage: `classification:` / `summaries:` / `extraction (<post id>):`.
  Classification and summaries fail in BATCHES (50 / 30), so a single failing
  post points at extraction. `tier:none` finds the never-analyzed posts, and
  right-click the search box → "↻ Re-analyze N matching posts" re-runs just them.

## Cleanup pass + control styling (v0.11.2)

- `db.js`: six functions (`countUnread`, `markReadUpTo`, `markUnreadSince`,
  `clearAnalysis`, `countUntagged`, `assignUntagged`) were the same cursor walk
  copy-pasted with a different predicate. They now share `walkPosts(visit, opts)`
  — `visit(record)` returns true to mean "matched", the record is written back
  when the walk is writable, and matching ids are collected. `READ(0|1)` is the
  shorthand for scanning the `read` index. Count-only callers pass
  `collect: false` so the badge refresh doesn't build a throwaway id array.
  Export surface and every predicate are unchanged (verified by diffing exports
  and re-deriving each predicate).
- `digest.js`: `moreDaysBtn`/`morePastDatesBtn` were identical apart from a noun
  and which counter they bump — now one `moreDatesBtn(n, noun, onMore)`.
  `dayHeader`/`pastDateHeader` were deliberately LEFT separate: they render
  different content (read count + conditional foldability vs event count), and
  merging them would need more parameters than the duplication costs.
- Topbar controls now read in three weights: filter toggles (`.filter-btn`,
  pill, filled when pressed) < sort switch (`.sort-btn`, ghost) < actions (plain
  `.btn`, unchanged). The sort label carries its direction: `↓ Oldest first` /
  `↑ Newest first` via the shared `sortLabel(asc)`.

## Windowed rendering + folding regression fix (v0.11.5)

Untoggling "Unread only" (or having "Analyzed only" on) froze the page on a large
DB. Two causes, both now fixed:
- **Regression (mine, v0.11.2):** the `folding` condition had grown
  `&& !analyzedOnly()`, copied from `unreadOnly` without thinking it through.
  Under Unread-only a fully-read day CANNOT exist, so folding is meaningless
  there — but nearly every post is analyzed, so under Analyzed-only fully-read
  days very much still exist and must still collapse. Gating on it left every
  old read day expanded: ~6300 cards ≈ 190k DOM nodes. Folding now depends only
  on `!unreadOnly() && !searchEl.value.trim()`.
- **Structural (BACKLOG §1 item 3): DOM windowing.** `render()` now emits at most
  `renderLimit` posts (`RENDER_CHUNK` = 150) and appends a `.render-more`
  sentinel; `moreObserver` (IntersectionObserver, 800px margin) extends the
  window as it nears the viewport, and the sentinel is clickable as a fallback.
  `updateStats` still reports the FULL filtered count, not the rendered subset.
  `jumpToPost` grows the read-day limit AND the window together, bounded by a
  guard so an unreachable target can't spin.
  Folding remains the cheaper lever — windowing is the backstop for the cases it
  can't help (one huge partially-read day, or a filter matching thousands within
  a single day).
- Date headers now show the YEAR when the date isn't in the current year, via a
  shared `dateLabel()` used by both the timeline day separator and the past-event
  date header — an old entry no longer reads as if it were recent.
- **Folding now applies UNDER a filter too** (it used to be suppressed whenever a
  query was active). The day grouping in `render()` has always run on the
  FILTERED `items`, so this needed no new machinery: `d.allRead` and the header
  count already describe that day's MATCHES, and unfolding reveals only those. A
  filter therefore narrows what sits inside each date instead of flattening the
  dates into one long list. Only Unread-only still suppresses folding (a
  fully-read day cannot exist there). `filtering()` (query OR Analyzed-only —
  NOT Unread-only, which never reaches it) only changes WORDING: the fold count
  reads `N matching` rather than `N read`, and the reveal button becomes
  `+ show N older matching dates`.
  The staggered `READ_DAY_LIMITS` limit applies under a filter exactly as it does
  without one. It was briefly skipped there on the theory that hiding whole dates
  buries matches behind a second disclosure — wrong: incremental drill-down is
  wanted under a filter just as much, and skipping it dumped every past date on
  screen at once (reported 2026-08-17 with a screenshot). Keep the limit.
- **`▸ Unfold all dates below`** (`foldAllBtn`, `.fold-all`) bulk-opens every
  foldable date in view. It anchors immediately before the FIRST FOLDABLE date
  header — foldable, not folded, so the button doesn't move when the state flips —
  which is where the folded region starts in both sort orders (oldest-first puts
  the read days at the top, newest-first at the bottom). Under oldest-first the
  `more-days` button is inserted at `frag.firstChild` AFTER this one is placed, so
  the order comes out `+ show N older read dates` → `▸ Unfold all dates below` →
  dates. It's a TOGGLE (`▾ Fold all dates below` once nothing is folded), because
  re-folding 200 dates one header at a time isn't a thing anyone should have to
  do. Safe on a huge DB: `renderLimit` still caps what reaches the DOM. Absent
  when truncation stopped the loop before any foldable date (nothing to act on
  yet).
  INVARIANT: every class `render()` inserts must appear in its opening
  `listEl.querySelectorAll(...)` cleanup — `.thread, .day-sep, .reading-line,
  .more-days, .render-more, .fold-all` is currently the complete set. `.fold-all`
  was missed when it was added, so each render appended another copy and the
  Refresh button visibly stacked them (same report). Add a node type, add it there.
- **Reveal state resets on a filter CLEAR, not on every filter EDIT** — the two
  halves mean different things:
  - `unfoldedDays` + `readDayLimitIdx` are CHOICES (the user clicked to unwrap a
    day), so editing a query must not silently re-wrap them. Unwrap a date, refine
    the query, and it stays open on the narrower set.
  - `renderLimit` is a SCROLLING ARTIFACT that regrows on its own, so it always
    rewinds — carrying a window inflated by earlier scrolling into a freshly
    filtered set re-creates the freeze windowing exists to prevent.
  Two entry points enforce it, and a filter handler must never call bare
  `render()`/`renderEvents()`: `refilter()` (edit — window only) and
  `refilterFresh()` (clear — `resetFolding()`, which rewinds the window too),
  plus `refilterEventsFresh()`. Assignments: search × / Escape / backspacing the
  box to empty → fresh (an empty box is no filter, so how it emptied doesn't
  matter); editing a non-empty query → edit; SORT → edit (it reorders the same
  set, so re-wrapping days would be gratuitous); Unread-only / Analyzed-only and
  the Events "Unhidden only" → fresh (unchanged shipped behaviour). Events have
  no render window, so an events-search edit is a plain `renderEvents()`; that
  box has no × , so an emptied field is its clear.
  Everything that is NOT a filter change (Analyze, Refresh, mark-read, thread
  expand, the window-growth observer) still calls `render()` directly — those
  must PRESERVE fold and scroll state, which is what the v0.10.1 scroll anchoring
  is for. The rule is "filter change → `refilter*()`, everything else →
  `render()`", never "always reset".

## Search query language (v0.11.0)

The timeline search box is now a query language, not a substring match — the
volume of incoming posts made plain text search insufficient for filtering.
Syntax deliberately follows the `field:value` convention shared by GitHub / X /
Gmail so it transfers (the user's original proposal of a bare `>10` was dropped
in favour of `likes:>10` for that reason).
- Grammar (recursive descent in digest.js): implicit AND between terms, explicit
  `AND`/`OR`, parentheses, `-`/`NOT` negation, `"quoted phrases"`.
- Terms: bare word (matches the whole hay — text, author, summary, theme, event
  name/venue), `"quoted"`, `@handle`, `likes:`/`replies:`/
  `reposts:` with `> >= < <= =` (bare number = equals), `is:read|unread|repost|
  reply|liked`, `has:media|link`, `tier:full|summary|other|none` (`none` = not
  analyzed yet, i.e. the red-bordered cards). Deliberately ONE spelling per
  operator — no `from:`/`author:`/`category:` synonyms and no `main|side|off`
  tier aliases, so the vocabulary is exactly what the docs list.
- **`"quotes"` search the post BODY only** — never the summary/author/theme.
  That distinction is the whole point of the quoting rule; `body` and `hay` are
  separate fields on the per-post `queryContext`.
- Counts AND `is:liked` come from the ORIGINAL on a repost (`orig || t`), matching
  what the card displays (the ♥ reflects the original's state). Use `-is:liked`
  for the inverse rather than an `is:unliked` term — one spelling per operator.
- A query that doesn't parse (unbalanced parens mid-typing, stray operator)
  returns `null` from `compileQuery` and the caller falls back to a plain
  substring match — the box never breaks while you type.
- `queryPredicate` memoizes the last compiled query since `render()` runs often.
- The **Unread only** button stays a separate silent toggle ANDed on top (the
  user explicitly chose not to have it clutter the box), even though `is:unread`
  also exists as a term. `focusExceptionId` now bypasses the whole query, not
  just the unread filter, so a jumped-to post always shows.
- BEHAVIOUR CHANGE: an unquoted multi-word query used to be a literal phrase and
  is now an AND of words. Quotes restore the old behaviour.
- The header stat ALWAYS reads `N of M posts` — filtered or not, so the readout
  never changes shape and the first number is always "what I'm looking at".
  `render()` passes `items.length` to `updateStats(shown)`, so N reflects the
  query AND both toggles, and is exactly the set the right-click bulk actions
  operate on. `unread` / `to analyze` stay GLOBAL (they match the toolbar badge).
- **Analyzed only** (`#only-analyzed`) is a second silent toggle built exactly
  like Unread only — aria-pressed + `bd-only-analyzed` in localStorage, ANDed on
  top of the query, `focusExceptionId` bypasses it, it suppresses read-day
  folding, and it has its own empty-state message. It hides posts with no
  `processed_at` (the red-bordered cards); `tier:none` is the query-language
  expression of its inverse.
- Syntax is documented in Settings → "Search syntax" and in the search box's
  `title` tooltip. The Events tab search is unchanged (still substring).

## Fix: refresh-on-browse could PROMOTE a nested post (v0.10.12)

Symptom: opening a quoted post on X (via "Open on X" → clicking the quote) made
that post — and others around it — appear in the digest as new unanalyzed posts,
without ever being liked. That contradicts the stated rule (home feed or explicit
like are the only ways in).
- Cause: a quoted post / repost original is stored as a `nested` reference record
  (present but never rendered). Viewing it on its own page returns it at TOP level
  (`nested: false`), and `putPosts`' `{...existing, ...t}` merge let that overwrite
  the stored `nested: true` — `nested` is NOT in PROTECTED_FIELDS. The old guard
  `if (existing.nested === false) merged.nested = false` only blocked the OPPOSITE
  direction (visible → nested).
- So `updateOnly` blocked INSERTS but not PROMOTIONS, and a promotion is an insert
  as far as the digest is concerned. The promoted post also shows as unanalyzed,
  because the pipeline skips nested records — hence the red "not analyzed" border.
- Fix: in `updateOnly` mode `merged.nested = existing.nested` — a refresh may
  never change what the digest SHOWS, only counts/liked-state. Liking still
  promotes (handleObservedLike → handlePosts, not updateOnly), which is intended:
  explicitly liking a quoted post should pull it into the digest.
- Not retroactively repairable: an already-promoted record is indistinguishable
  from a legitimately captured one, so existing strays stay until marked read.

## Output-language adherence in prompts (v0.10.11)

Summaries occasionally came back in the post's own language, or in an unrelated
one. Diagnosis: POSITION. The language was stated once at the TOP of the system
prompt, but the last thing the model reads before generating is a wall of
foreign-language post text — recency pulls it toward the source language. The
model is `claude-haiku-4-5`, the weakest tier for instruction adherence, and it
does NOT support the `effort` parameter, so prompt structure is the only lever
(a bigger model was explicitly ruled out on cost).
- `languageRule(lang)` is appended at the END of every prompt producing
  user-facing prose: `classifyBatch`, `summarizeBatch`, `extractFull`,
  `translatePost`, `mergeEventDescription`. It says posts usually are NOT in the
  output language, that this is expected, and that a third language is never
  right — while allowing proper nouns to keep their original spelling.
- Schemas became functions of `lang` (`summarizeSchema`, `extractSchema`) so
  per-field `description`s name the target language — present at generation time,
  not only in the system prompt.
- `summarizeBatch` emits a `lang` field BEFORE `summary` (structured outputs are
  generated in schema order): the model states the language, then writes it —
  self-conditioning, plus an exact-match signal. Items it flags as off-language
  are re-run ONCE via `summarizeBatch(..., { retry: false })` on just those posts,
  where the rule isn't competing with 30 posts of source text.
- `clusterEvents` deliberately has NO languageRule (comment in place so it isn't
  "fixed" later): its canonical event names/venues must stay in the ORIGINAL
  script or they stop matching the posts — the whole point of that call.
- Evaluate a prompt change with the search context menu's "↻ Re-analyze N
  matching posts" (v0.10.10) over the same selection before and after.

## Re-analyze the search selection (v0.10.10)

Right-clicking the search box now offers "↻ Re-analyze N matching posts" beside
the existing mark-read item. The point is A/B-ing prompt changes: re-run the
pipeline over a handful of posts instead of the whole digest.
- `db.clearAnalysis` gained an `onlyIds` option (a Set) alongside the existing
  onlyOther/onlyUnread/onlyEvents scopes.
- `digest.reanalyzePosts(posts, label)` confirms, clears just those ids, reloads
  (so the pipeline sees them unprocessed), then `runPipeline(..., { onlyIds })`.
- The selection is `visiblePosts()` — exactly what the search shows, so the
  Unread-only toggle narrows it too. Read posts are included (unlike the
  mark-read item, which only lists unread ones).
- CAVEAT: a targeted run skips event CLUSTERING (`runPipeline` only clusters on a
  full run). Event posts in the selection are re-extracted and come back as
  singleton groups via `ensureEventGroups` on load; the next full ✨ Analyze
  re-clusters them.

## Mark-unread via right-click + undo labels + shortcut help (v0.10.9)

- The inline "Mark unread from [date] [Apply]" control is GONE from the subbar.
  It now lives behind a right-click on the **unread count** in the header
  (`.unread-stat`, dotted-underline affordance) → "⏱ Mark unread from date/time…".
- `syncDatePicker` was generalized into `datePickerPopover(x, y, defaultTs,
  actionLabel, onPick)`, shared by "Sync back to date/time…" and mark-unread, so
  both time-travel prompts are literally the same component.
- Undo semantics were already right and are unchanged: `markUnreadSince` cursors
  the `read` index at 1, so it only flips posts that were READ and returns just
  those ids — undo restores exactly them, never touching already-unread posts.
- Undo LABELS are now self-describing (they carry the count AND how the action was
  done), because several actions used to render identically as "mark N read":
  `mark 42 posts read up to 27/07 10:06`, `mark 12 posts read matching "@handle"`,
  `mark 30 posts unread from 26/07 08:00`, `pin event "…"`. `updateUndoBtn` drops
  its old "(N)" suffix since the label carries it.
- Undo covers ONLY read-state changes and event flags (5 `pushUndo` sites).
  Sync / Analyze / Refresh deliberately have none.
- Settings gained a **"Right-click shortcuts"** section: a table of every
  right-click affordance (author, 🔁 reposter, ✓ read check, search box, unread
  count, ✨ Analyze, 🔄 Sync, event source links). Keep it in sync when adding a
  new context menu.

## Standalone-reply indication (v0.10.7)

X routinely surfaces replies as top-level timeline posts; those now read as
replies at a glance. No extra data needed — `reply_to`
(`legacy.in_reply_to_status_id_str`) is already captured on every post.
- `cardIndent(t, depth)` = `depth * 5` (thread nesting, unchanged) **plus**
  `REPLY_INDENT`(18px) when a reply is rendered at top level (`depth === 0 &&
  t.reply_to`). Applied as `margin-left`, so the normal spacing between
  independent posts is untouched (the `.thread` last-child margins still apply).
- `applyReplyStyle(card, t, depth)` (used by BOTH `postCard` and `collapsedCard`,
  replacing their duplicated depth-margin lines) adds `.is-reply` + a `↳`
  `replyArrow()` absolutely positioned in the gutter the indent opens up.
  Nested thread replies (`depth > 0`) DON'T get the arrow — they already read as
  replies from their nesting.
- The arrow's tooltip names the parent's author when we captured it, and clicking
  jumps to that post (`jumpToPost`); `stopPropagation` keeps it from expanding a
  collapsed row. The jump is offered ONLY when the parent is `reachable` — present,
  `!nested`, and `mine()` — because `byId` also holds nested records (quoted /
  repost originals) that never render, so those clicks would silently do nothing.
  Otherwise the arrow stays a plain (still tooltipped) marker.

## Collapsed-repost reposter label (v0.10.6)

Collapsed repost cards now show the reposter's name (light gray `.reposter-mini`,
with a `›` separator) before the original poster (bold `.who-mini`) — e.g.
`🔁 Reposter › Poster`. Both are right-clickable: the reposter name (and the 🔁)
filter to the reposter (`authorMenu(t.screen_name)`), the poster name to the
original author (`authorMenu(content.screen_name)`). The reposter label truncates
first (max-width 40%, flex-shrink) so the bold poster stays visible.

## Translation Markdown rendering (v0.10.5)

Translations were stored/shown as raw text, so the Markdown the model emits
(`#`/`##` headings, `**bold**`, `-` bullets, `---` rules — e.g. the per-image
transcription section) appeared literally. `renderMarkdownInto()` (digest.js) now
renders a lightweight, XSS-SAFE subset into the `.llm-translation` box: all text
goes in via `textContent`/`createTextNode` — never `innerHTML` — so nothing in
the model output can inject markup. Headings require the `# ` space, so
`#hashtags` stay plain text. Fixes existing translations too (render-time, no
re-translate needed). CSS: `.md-h`/`.md-p`/`.md-ul`/`hr` under `.llm-translation`
(pre-wrap dropped — blocks handle layout).
- Emoji handling: the translate prompt now says to copy emojis verbatim (don't
  replace an emoji with a word/description), and the renderer strips stray U+FFFD
  `�` (a model occasionally emits one for a mangled emoji). Existing translations
  lose the `�` at render; the emoji itself returns on a re-translate.

## Browse-refresh + reposter filter + mark-filtered-read (v0.10.4)

- **#1 Refresh-on-browse:** counts + liked-state now refresh for a post viewed
  ANYWHERE (detail page, profile, search, list, bookmarks) **if it's already in
  the digest** — update-only, never inserts. interceptor `REFRESH_OPS`
  (`TweetDetail|UserTweets|UserTweetsAndReplies|SearchTimeline|
  ListLatestTweetsTimeline|Bookmarks|Likes|CommunityTweetsTimeline`) →
  `__xDigestRefresh` → content `XD_POSTS_REFRESH` → background `refreshCounts` →
  `putPosts(posts, null, { updateOnly })`. `updateOnly` updates EXISTING rows only
  and does NOT re-tag `accounts` (a mere view shouldn't pull a post into a digest).
  SHIP_OPS (home) still store wholesale; likes still insert-on-like. Net: a post
  on the timeline OR liked OR already in the digest gets refreshed; anything else
  is ignored. Never advances `syncBoundary`.
- **#2 Reposter filter:** right-click a repost's 🔁 marker / "Reposted by …" line
  → filters the timeline to the REPOSTER (their own posts AND their reposts) via
  `authorMenu(t.screen_name)`. The search hay already matches `@reposter` for both
  a repost (its `screen_name` IS the reposter) and their authored posts.
- **#3 Mark filtered read:** right-click the search box WHILE searching → "✓ Mark
  N matching posts read" (all unread in `visiblePosts()`), undoable via `pushUndo`.
  No-op on an empty query (keeps the native paste menu), so it can't mark the whole
  timeline read by accident.

## Robust event-duplicate merging (v0.10.3)

`pipeline.groupEvents` now runs a DETERMINISTIC merge pass before the LLM, so the
obvious duplicates the model misses are collapsed reliably.
- `deterministicClusters`: union-find over the account's upcoming event groups.
  Two groups are the same event when they share the EXACT start date AND either
  their VENUE keys match (same place, names worded differently) OR their NAME keys
  match with a COMPATIBLE venue (same event, one entry missing the venue).
  Requiring venue-compatibility for a name-only match guards two generically-named
  events at different venues.
  - Keys are normalized twice: a Latin key (diacritics/macrons stripped,
    non-alphanumerics removed, so a macron'd romanization equals its plain form)
    and a CJK key (kana + ideographs). Matching is EXACT, never substrings.
  - Transitive, so three entries chain together when one pair shares the CJK
    spelling and another shares the romanization, even though no single pair
    matches in both scripts.
  - Deliberately EXACT-date, not ±1: with union-find, a ±1 window chains a venue's
    events across consecutive days into one mega-cluster (this regressed once —
    events "vanished" because they were folded into a single group). The ±1
    fuzziness and multi-day "day 2" posts are left to the LLM pass, which reasons
    instead of chaining.
  - Merging keeps the WIDEST `end_date` across members, so a multi-day event isn't
    collapsed onto a single day (and so stays "current" until it really ends).
- Shared `applyClusters(clusters, byId, postsById, sink)` is used by BOTH the
  deterministic pass and the LLM pass (the LLM handles the genuinely fuzzy/
  paraphrased cases on the survivors). Deterministic clusters carry only
  `memberIds` (the survivor keeps its own fields); LLM clusters also carry
  canonical name/venue/date/... which then win.
- Flag priority on merge (`mergeFlag`/`pickSurvivor`): pinned > UNHIDDEN > hidden
  — a merged group is hidden ONLY if every member was hidden, so hiding some but
  not all duplicates leaves the result visible.
- `llm.clusterEvents` prompt tightened: same date + same venue (across scripts and
  transliterations, or a venue-type word like "Hall"/"Park" added or dropped) =
  the same event even when names differ; keep two entries separate ONLY when name
  AND venue both differ.
- Reprocess EXISTING duplicates via right-click ✨ Analyze → "Re-analyze event
  posts only" (clears `event_group_id` → fresh singletons → both passes re-run).
  The `clustered` short-circuit is unchanged, so a normal Analyze still spends a
  clustering call only when a fresh group exists.
- KNOWN limitation (unchanged): extraction is one `event` per post, so a single
  post describing MULTIPLE distinct events still contributes only one. Merging
  keys on event attributes (date/name/venue), not post identity, so multi-event
  posts don't corrupt merges.
- Past-events view: with Events "Unhidden only" OFF, the tab now also lists PAST
  events (agenda stays upcoming-only when ON). Past events render FOLDED by date
  (`buildPastEvents`/`pastDateHeader`), showing the most-recent `EVENT_PAST_LIMITS`
  = [5,15,35,85,∞] dates with a staggered "＋ show older past dates" button —
  mirroring the Timeline's read-day folding (reuses the `day-sep`/`more-days` CSS).
  `eventRow` was extracted so the agenda and the past section share row rendering;
  `resetEventFolding()` runs on the Unhidden toggle + account switch. The event
  data was never lost — the Events filter was just upcoming-only before.

## Native-like capture + like-gated detail-page storage (v0.10.2)

Browsing x.com keeps liked-state and counts fresh with NO extra API calls — it
only parses X's own traffic (same passive posture as capture).
- Two op classes in interceptor.js: `SHIP_OPS` (HomeLatestTimeline / HomeTimeline)
  are stored WHOLESALE as before — that's your feed, everything is recorded.
  `CAPTURE_OPS` additionally includes `TweetDetail` (a post's conversation view),
  but those posts are only CACHED (`recordCache`, id→record, bounded 1000),
  NEVER stored on their own — the replies below a post are usually noise.
  `handleResponse` caches every parsed post and ships only SHIP_OPS batches.
- Native like/unlike: interceptor watches the FavoriteTweet/UnfavoriteTweet
  mutation X sends on click (`noteLikeAction`, on a 2xx/ok response) → posts
  `__xDigestLike {id, on, post}` (`post` = the cached full record if we've seen
  it) → content.js adds the account → `XD_LIKE_OBSERVED` → background
  `handleObservedLike`:
  - LIKE with a record → `handlePosts([{...post, favorited:true, count+1}])`
    (insert-or-update, respects the account-enabled gate) so the explicitly liked
    post — even a reply not otherwise stored — ENTERS the digest.
  - unlike, or a like with no cached record → `db.applyLike(id, on)` (UPDATE-ONLY;
    no-op if absent). Nothing unrelated is ever inserted.
  So home browsing records everything; detail-page browsing records ONLY what you
  explicitly like. Dedup is by id → never duplicated. The optimistic count
  self-corrects on the next real capture. The digest's OWN ♥ runs from the service
  worker (not the page), so it doesn't re-trigger this path.
- Does NOT advance `syncBoundary` — only a completed Sync does — so browsing
  refreshes/records without moving the "last synced" marker or plugging the gap.

## Digest navigation + scroll UX (v0.10.1)

Reading-position polish, mostly around the Events→Timeline jump.
- Events "View post" (`bindEventPostButton`): LEFT-click jumps to the post in the
  Timeline (`jumpToPost` → reveals its folded/limit-hidden day, then `focusPost`
  centres + flashes, re-centring a few times as lazy media settle). It NO LONGER
  opens X on a miss. RIGHT-click → a "Open in X" context item (`xPostUrl`:
  handle-based, or the id-only `x.com/i/status/<id>` fallback).
- Per-tab scroll memory (`tabScroll`): each tab keeps its own scroll (the window
  scroll is shared), so bouncing to a Timeline post and back to Events doesn't
  drag Events to the Timeline's position. Restored in `setTab`.
- Scroll ANCHORING in `render()` (`scrollAnchor`/`restoreScroll`): anchors to the
  timeline post nearest the viewport centre (`elementFromPoint(...).closest('[data-id]')`)
  and `scrollBy`s the delta after rebuild, so re-renders (Analyze, Refresh,
  mark-read, Unread-only toggle) keep the viewed post fixed instead of jumping.
  Falls back to the raw offset (Events tab / no anchor). F5 resets to top (fine).
- "Unread only" single-post exception (`focusExceptionId`): jumping to a READ post
  keeps the filter ON but shows just that one post (filter: `!t.read || id ===
  focusExceptionId`). One id, overwritten per jump; cleared by Analyze, the
  Refresh button and sort change; gone on F5. Deliberately NOT cleared by
  mark-read/undo/thread-expand (avoids brittle catch-all clearing).
- Settings Export filename now carries a full local datetime
  (`x-digest-backup-YYYY-MM-DD_HH-MM-SS.json`) via `localTimestamp()`.

## Generalization + privacy pass (v0.10.0)

Made the extension subject-neutral and open-ended for any user (it had grown a
few niche assumptions and personal traces baked into defaults, prompts and docs).
- `CRITERIA_DEFAULTS` (defaults.js) reworded to neutral boilerplate that seeds a
  newly enabled account and is meant to be replaced in Settings — no hard-coded
  topic, region or language. Only NEW accounts are seeded; existing per-account
  `fullThemes`/`summaryThemes` in storage are untouched (they win via the
  `{...CRITERIA_DEFAULTS, ...account}` merge), so current configs keep working.
- Output language now defaults to the **browser locale**, not a hard-coded value.
  `GLOBAL_DEFAULTS.language` is `''` (unset); `defaultLocaleLanguage()` resolves
  the browser UI language to its English display name via
  `chrome.i18n.getUILanguage()` + `Intl.DisplayNames`, falling back to "English".
  `loadGlobal()` fills an unset language with it, so all consumers (digest
  translate, pipeline, settings) get a real value; a previously STORED language
  still wins (existing configs unchanged). Settings shows the stored value with
  the locale default as a placeholder — leave it blank to track the locale.
- LLM prompts (llm.js) de-specified: removed language-specific biasing hints and
  examples from classify/summarize/extract/translate/cluster (they no longer
  assume any particular content language); they now say "which may be in any
  language" / "original language/script".
- Docs scrubbed of persona/interest/native-language details (README, this file).
  Codebase convention is now: subject-neutral, no assumptions hard-coded.
- Internal identifiers de-branded too: runtime message types use the `XD_*`
  prefix across background/content/digest/settings, and the MAIN↔isolated world
  postMessage markers use `__xDigest*` (interceptor.js ↔ content.js). All are
  ephemeral chrome.runtime / postMessage types (senders+receivers renamed
  together; no persisted state).
- IndexedDB database name is `x-digest` (db.js `DB_NAME`); the store schema and
  version (v4) are unchanged.

## Read-day folding + per-tab controls + Events hide (v0.8.0)

Performance + UX pass on the digest (the digest renders every visible post into
the DOM — no virtualization; cost scales with displayed count, so folding is the
main lever).
- Timeline: fully-read days FOLD under their date header (▸/▾, click to toggle).
  Only the 5 most-recent read days show folded; older ones collapse behind a
  `+ show N older read dates` button (`more-days`) that grows the limit in steps
  `READ_DAY_LIMITS = [5,15,35,85,∞]`. Folded read days render 1 node instead of
  N cards. `render()` now groups items into days; folds only on the plain
  timeline (NOT while searching, NOT in Unread-only, NOT on Events). `unfoldedDays`
  + `readDayLimitIdx` reset on load / account switch / Unread-only toggle
  (`resetFolding`). Search is data-level (filters `all`), so folded posts stay
  searchable — folding is suppressed when a query is active.
- Lazy avatars: `avatarObserver` (IntersectionObserver, 300px margin) sets
  `img.src` from `dataset.src` on scroll-in; `disconnect()` at each render start.
  (Media thumbnails were already `loading=lazy`.)
- Toolbars are per-tab: `#timeline-controls` (search / Unread-only / sort) vs
  `#events-controls` (event search / Unhidden-only / sort) swap in `setTab`, which
  now also calls `render()`. Events controls have their own state (eventSortAsc,
  `eventUnhiddenOnly` via aria-pressed, `bd-event-*` localStorage) and re-render
  only the events list.
- Events: each row has a 🙈/🙉 Hide toggle -> `db.toggleEventHidden` (new
  `event_hidden` field, added to PROTECTED_FIELDS). Past events are ALWAYS hidden
  (date < today); "Unhidden only" ON also hides `event_hidden` ones; OFF reveals
  them (upcoming only) so you can un-hide. Event search matches name/venue/time/
  date/summary/handle.

## Reply threads (v0.6.0)

Clicking the 💬 on a post expands its **captured** replies inline, recursively.
- Capture: `interceptor.js` now stores `reply_to = legacy.in_reply_to_status_id_str`.
  No DB migration (new record field; back-filled onto existing posts on
  re-capture via the `{...existing, ...t}` merge in `putPosts`).
- IMPORTANT limitation: we only have replies X itself delivered into the home
  timeline (conversation modules — self-threads, replies by followed accounts),
  never the full reply tree. So `💬 6` may reveal fewer than 6, or none. The
  icon is only a toggle when ≥1 reply was actually captured; otherwise it's the
  plain count. Threading is forward-looking (needs re-capture to populate links).
- `digest.js`: `childrenById` (built per render from `reply_to`, cycle-guarded),
  `threadOpen` set, `appendThread` renders a post + its open subtree into one
  `.thread` block. Cards inside a thread have `margin-bottom:0` (only the last
  keeps its natural margin); each reply level indents 5px (inline margin-left).
  Replies ALSO remain normal top-level cards (user choice: "keep in list AND
  nest", like X) — the existing unread filter still hides read ones.
- Auto-analysis: expanding a thread runs the pipeline on just the revealed,
  not-yet-analyzed replies via `runPipeline(..., { onlyIds })` (new opt in
  `pipeline.js`); `threadOpen` persists across the reload so it stays open.
- Reposts deliberately excluded (their wrapper id has no captured children).

## Step 2 reference (LLM pipeline) — built v0.2, live-validated since

Step 2 files (all vanilla JS ES modules, no build step):
- `settings.html/css/js` + `defaults.js` — options page: API key, model
  (default `claude-haiku-4-5`), output language (default: browser locale via
  `defaultLocaleLanguage()`), natural-language theme lists (full-detail /
  summary). Stored in
  chrome.storage.local.
- `llm.js` — raw-fetch Claude Messages API client (host_permissions handles
  CORS): `classifyBatch` (structured outputs, 50/batch), `summarizeBatch`
  (30/batch), `extractFull` (per-post, sends photo URLs as image blocks for
  flyer reading, returns detailed summary + structured event or null),
  `translatePost` (on demand, includes images). One retry on 429/5xx.
- `pipeline.js` — orchestration run from the digest page: classification ->
  tier routing (full -> per-post extraction; summary AND other -> one-line
  summary since 2026-07-14), incremental saves so an interrupted run resumes.
  Posts are marked with `processed_at`; failed ones stay unprocessed for retry.
- `db.js` — added `markUnreadSince(ts)`, `saveLLMResults(map)`; PROTECTED_FIELDS
  now covers category/theme/summary/event/translation/processed_at.
- `digest` v2 — "📅 Events" agenda in a separate sub-tab (Timeline | Events,
  count on the tab label, detailed summary under each event; event.date >=
  today, deduped, stays until date passes, cancelled/postponed badged;
  "View post" switches back to the timeline tab and scrolls to the source);
  reading order toggle (default **oldest first**); tier-3 ("other") posts
  render as collapsed two-line cards (header: theme chip + author + ♥ like +
  time + read ✓; summary/gist on the line below), click to expand;
  ✨ Analyze button runs the pipeline with progress + confirm dialog
  (right-click → context menu with 5 scopes: event-posts-only (t.event set — the
  cheap way to re-extract just event posts, e.g. to backfill end_date) / all /
  off-theme (tier-3 'other') / unread / unread off-theme. Each calls
  clearAnalysis(account,{onlyOther,onlyUnread,onlyEvents}) to wipe
  processed_at/category/theme/summary/event/event_group_id for that subset,
  then runs analyze — which ALWAYS also processes never-analyzed posts);
  per-post Translate button; "Mark unread from <datetime>" control (marks
  everything newer than the timestamp unread).

Live-validated (real API key, real captured posts): classification against the
configured themes, one-line summaries, event extraction with image reading, and
clustering all run in daily use. Prompt/threshold tuning is ongoing rather than a
one-off task — recent examples: the v0.10.3 deterministic merge rules and the
v0.10.5 "copy emojis verbatim" translate rule.

## Step 1 (v0.1) reference

- `manifest.json` — MV3, no special permissions
- `interceptor.js` — MAIN-world network hook + recursive Post extraction
  (handles note_tweet long text, TweetWithVisibilityResults, retweet wrapper →
  original link, quoted posts, media incl. video variants, t.co URL expansion,
  `nested` flag for posts found inside other posts)
- `content.js` — postMessage relay to service worker
- `db.js` — IndexedDB (db `x-digest`, store `posts` since v3; key = post id;
  `read` is 0/1 because booleans are not valid index keys). v3 `openDB` migrates
  the old `tweets` store -> `posts` and renames retweet_* record fields -> repost_*.
- `background.js` — storage, unread badge, digest tab management
- `digest.html/css/js` — raw reading view: day separators, repost/quote rendering,
  media thumbnails, counters, liked state, search (works in any language, CJK
  included), unread filter, reading line
- Live capture validated on x.com (2026-07-13): badge count, digest rendering
  (multilingual/CJK text, video thumbnails, expanded t.co links, counts) all confirmed
  against the real home timeline. If capture ever breaks after an X update, the
  GraphQL operation names in the `OPS` regex (interceptor.js) are the first thing
  to check (DevTools > Network > filter "graphql").

## Conventions

- Everything in the codebase (code comments, UI strings, README, manifest) is
  written in **English only**, and stays subject-neutral — no assumptions about
  any particular topic, region, or language are hard-coded, so the extension is
  usable by anyone. LLM *output* (translations, summaries, extracted event
  fields) defaults to the **browser's locale language** and is a user setting on
  the settings page, never hard-coded.
- **Dates are ISO, times are 24-hour**: `2026-08-10 15:55`. Two SEPARATE layers,
  which look identical today and must not be merged:
  - *Display* — `fmtDate()` / `fmtDateTime()` (digest.js, `fmt*` like the other
    formatters): card timestamps, undo labels, sync overlay + menu, event dates
    and ranges. Presentation only, restyle freely. Two readability exceptions
    live here: `dateLabel()` keeps long-form SECTION TITLES for the timeline's
    day separators ("Friday 24 August", year appended outside the current year),
    and `fmtEventDate` prefixes the short weekday ("Sat 2025-09-13") because an
    agenda entry is easier to place when you can see it lands on a weekend.
  - *Data* — `isoDate()` is the canonical date KEY: `event.date`/`end_date` are
    stored as these strings and compared against `todayISO` for what's upcoming.
    Restyling it would silently break event grouping and every stored record, so
    it has exactly two callers, both key comparisons. Same for `exportedAt`
    (`toISOString()`, full ISO 8601) and the export filename's `localTimestamp()`.
  Both display helpers build from LOCAL components, never `toISOString()` (UTC —
  wrong day either side of midnight), and nothing user-facing uses
  `toLocaleString`, whose browser-default locale can render 12-hour AM/PM.
- Vanilla JS, ES modules, no build step, no external dependencies.
- Everything stays local; the only planned network egress is the Anthropic API
  (step 2) and X itself.

## Roadmap

- [x] Validate live capture on x.com (step 1 acceptance) — done 2026-07-13
- [x] Step 2 built 2026-07-13: settings page, batch classification against
      configured themes, author like-rate scores with optimistic prior,
      structured event extraction with flyer vision, digest sections,
      oldest-first reading order, mark-unread-since-timestamp
- [x] Multi-account opt-in (v0.3, 2026-07-13): per-account digest enablement +
      criteria, account-tagged captures, scoped digest/badge/pipeline
- [x] Validate step 2 live — done: the pipeline has run against real captured
      posts with a real API key (classification, summaries, event extraction with
      image reading, clustering). Prompt/threshold tuning stays ongoing as output
      quality issues surface (e.g. the v0.10.3 merge rules, v0.10.5 emoji rule)
- [x] Like-from-digest (v0.4, 2026-07-14): ♥ button on cards, FavoriteTweet
      via session cookies + captured bearer, active-account safety check
- [x] Step 3 remainder (v0.7.0): Sync auto-scroll, stopping on a created_at
      frontier (sortIndex investigated + dropped as session-dependent)
- [x] Stale like/count refresh (v0.10.2 + v0.10.4, 2026-07-27) — first declined
      2026-07-18 as refresh-on-scroll (extra API calls = automated view-triggered
      polling, our highest ToS risk), then SOLVED DIFFERENTLY with no extra
      requests: passive native-like capture + refresh-on-browse for posts already
      in the digest. Rule to keep: parse X's own traffic only, never add requests
      or scrape the DOM. See BACKLOG.md §4.
- [ ] Later ideas: timestamp-based lookup of posts (snowflake IDs encode creation
      time)
- [x] Generalization + privacy pass (v0.10.0, 2026-07-19): neutral default
      themes, browser-locale default output language, subject-neutral prompts/docs,
      and de-branding of internal identifiers (runtime message types now `XD_*`,
      IndexedDB named `x-digest`). Existing configs and captured posts preserved.
- [x] Event-merge robustness + past-events view (v0.10.3): deterministic
      same-event merge (name/venue keys, Latin+CJK, union-find) before the LLM
      pass; unhidden-wins flag priority; Events tab lists past events (folded by
      date, staggered "show older") when "Unhidden only" is off
- [x] Digest UX pass (v0.10.1, v0.10.5–v0.10.7): Events→Timeline jump with scroll
      anchoring + per-tab scroll memory; Markdown-rendered translations (XSS-safe)
      + emoji handling; reposter shown on collapsed reposts; standalone replies
      indented with a ↳ gutter arrow (click → parent); uniform 10px post spacing
- [ ] Deferred work + scaling concerns tracked in `BACKLOG.md` (HIGH: whole-DB-
      in-memory has a ~months horizon at ~500 posts/day → windowed data loading)
