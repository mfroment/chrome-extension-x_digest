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
- Override: right-click Sync -> `syncMenu` (presets: back 24h/3d/7d, or a
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

## Current state — step 2 built (v0.2), NOT yet validated with live API calls

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

Immediate next task: validate step 2 live (real API key, real captured posts),
check classification quality against the theme descriptions, extraction quality
on real flyers, and tune batch sizes / prompts as needed.

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
- [ ] Validate step 2 live (real API key + captured posts); tune prompts,
      batch sizes, theme descriptions based on classification quality
- [x] Like-from-digest (v0.4, 2026-07-14): ♥ button on cards, FavoriteTweet
      via session cookies + captured bearer, active-account safety check
- [x] Step 3 remainder (v0.7.0): Sync auto-scroll, stopping on a created_at
      frontier (sortIndex investigated + dropped as session-dependent)
- [~] Stale like/count refresh — DECIDED AGAINST (2026-07-18, user: "I can live
      with stale likes"). Auto-refresh-on-scroll is automated view-triggered
      polling = highest ToS risk vs our human-paced posture; counts already
      refresh for free when posts reappear via Sync/browse (`putPosts` merges
      favorite_count, not a PROTECTED_FIELD); and a single-tweet read may hit the
      same x-client-transaction-id 404 that killed bookmarks. Only defensible
      revisit: a per-post ↻ button (one request per human click, 5-min guard),
      validate the read works first. See BACKLOG.md.
- [ ] Later ideas: timestamp-based lookup of posts (snowflake IDs encode creation
      time)
- [x] Generalization + privacy pass (v0.10.0, 2026-07-19): neutral default
      themes, browser-locale default output language, subject-neutral prompts/docs,
      and de-branding of internal identifiers (runtime message types now `XD_*`,
      IndexedDB named `x-digest`). Existing configs and captured posts preserved.
- [ ] Deferred work + scaling concerns tracked in `BACKLOG.md` (HIGH: whole-DB-
      in-memory has a ~months horizon at ~500 posts/day → windowed data loading)
