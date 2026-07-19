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
  per-post Translate.
- **📅 Events** tab: upcoming events extracted from announcements, sorted by
  date, kept until their date passes, cancelled/postponed badged.
- Per-post **♥ like**, performed on X with your own session (human clicks only —
  nothing automated).
- Themes are configured per X account in Settings, as natural-language
  descriptions of the topics you want. API key, model and output language are
  shared across accounts.

## Troubleshooting

**Nothing is captured.** Check that your account is enabled in Settings. X may
also have renamed its GraphQL operations: in DevTools > Network, filter
`graphql`, scroll, and spot the operation name in the request URLs (after the
hash, e.g. `.../abc123/HomeLatestTimeline`); adjust the `OPS` constant at the
top of `interceptor.js`, then reload the extension and the X page.

**Likes/bookmarks fail.** Make sure x.com is logged into the same account as the
digest, and that you have scrolled x.com at least once since the last extension
reload (that captures the session token). If they 404, X may have changed its
operation ids — see `FAVORITE_QUERY_ID` / `BOOKMARK_QUERY_ID` in `background.js`.

**The badge counter doesn't move.** Reload the extension (`chrome://extensions` >
↻ icon) then reload the X tab (the interceptor installs at page load).

## Data

Everything is local: the extension's IndexedDB (database `x-digest`, store
`posts`) and chrome.storage.local (settings, per-account config, session
token). Removing the extension removes the data. Nothing is sent anywhere except
X and the Anthropic API.
