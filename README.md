# X Digest

Chrome extension (MV3) that captures posts from your X timeline as you scroll,
stores them locally (IndexedDB), and presents them in a reading digest with
read / unread states, per-account themes, LLM summaries and event extraction.
Everything stays local; the only network egress is X itself and the Anthropic
API (for the optional analysis).

## Installation

1. Open `chrome://extensions`
2. Enable **Developer mode** (toggle at the top right)
3. Click **Load unpacked** and select this folder
4. Pin the icon to the toolbar

## First run

1. Open `x.com` while logged in and scroll the **Following** timeline once —
   this registers your account with the extension.
2. Open **Settings** (⚙ in the digest, or the extension's options): paste your
   Claude API key, set the output language, **enable your account** and review
   its themes. Digests are off by default until an account is enabled.
3. Browse x.com and scroll: posts are captured automatically (the badge counts
   unread posts). Click the icon to open the digest.
4. In the digest, hit **✨ Analyze** to classify posts, summarize them and
   extract upcoming events.

## What the digest does

- **Timeline** tab: posts in reading order (oldest first by default), day
  separators, a red "you were here" line at the read/unread boundary, search
  (works in any language, CJK included), unread filter, "Read up to here",
  per-post Translate (Markdown-rendered, reads attached images too).
  Fully-read days fold under their date; replies shown as standalone posts are
  indented with a ↳ arrow; captured replies expand inline from 💬.
- **📅 Events** tab: events extracted from announcements and clustered so the
  same event announced by several accounts collapses into one entry. Sorted by
  date, multi-day ranges supported, cancelled/postponed badged, 📌 pin / 🙈 hide
  per event. Turn "Unhidden only" off to browse past events (folded by date).
- **🔄 Sync**: opens a fresh x.com tab and scrolls the Following timeline until
  it reaches what you already have. Right-click it to sync further back.
- Per-post **♥ like**, performed on X with your own session (human clicks only —
  nothing automated). Liking on x.com directly is picked up too, and counts
  refresh for posts already in the digest as you browse — all by reading X's own
  responses, never by making extra API calls.
- **Undo** (Ctrl/⌘+Z) covers mark-read, "read up to here", and event pin/hide.
  Right-click the search box while filtering to mark all matching posts read.
- Themes are configured per X account in Settings, as natural-language
  descriptions of the topics you want. API key, model and output language are
  shared across accounts. Settings also has JSON **Export / Import** for backup.

## Troubleshooting

**Nothing is captured.** Check that your account is enabled in Settings. X may
also have renamed its GraphQL operations: in DevTools > Network, filter
`graphql`, scroll, and spot the operation name in the request URLs (after the
hash, e.g. `.../abc123/HomeLatestTimeline`); adjust the `SHIP_OPS` / `REFRESH_OPS`
constants at the top of `interceptor.js`, then reload the extension and the X page.

**Likes fail.** Make sure x.com is logged into the same account as the digest,
and that you have scrolled x.com at least once since the last extension reload
(that captures the session token). Operation ids are re-learned automatically
from X's own traffic; the only hardcoded fallback is `OPS_FALLBACK` in
`background.js`.

**The badge counter doesn't move.** Reload the extension (`chrome://extensions` >
↻ icon) then reload the X tab (the interceptor installs at page load).

## Data

Everything is local: the extension's IndexedDB (database `x-digest`, store
`posts`) and chrome.storage.local (settings, per-account config, session
token). Removing the extension removes the data. Nothing is sent anywhere except
X and the Anthropic API.

## License

Licensed under the **GNU General Public License v3.0** — see [LICENSE](LICENSE).

Copyright (c) 2026 mfroment
