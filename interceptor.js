// interceptor.js — runs in the MAIN world of x.com, before X's own code.
// Role: intercept responses from the timeline GraphQL endpoints,
// extract post objects, and forward them to the content script via postMessage.

(() => {
  'use strict';

  // GraphQL operations to intercept. If X renames its operations, adjust here
  // (DevTools > Network > filter "graphql" > find the operation name after the hash in the URL).
  // Responses we PARSE. HomeLatestTimeline (Following/Latest) and HomeTimeline
  // (For You) are stored wholesale — that's your feed. TweetDetail (a post's
  // conversation view) is only CACHED, never stored on its own: the replies
  // below a post are usually noise, so they stay out of the digest UNLESS you
  // explicitly like one — then noteLikeAction ships just that cached record.
  const SHIP_OPS = /\/i\/api\/graphql\/[^/]+\/(HomeLatestTimeline|HomeTimeline)/;
  const CAPTURE_OPS = /\/i\/api\/graphql\/[^/]+\/(HomeLatestTimeline|HomeTimeline|TweetDetail)/;

  const MARKER = '__xDigest';

  // ---------------------------------------------------------------------------
  // Extraction: recursive walk of the JSON looking for Tweet objects
  // (X's GraphQL type is still "Tweet"; our records are "posts").
  // ---------------------------------------------------------------------------

  function extractPosts(root) {
    const found = new Map(); // id -> record (dedup within a single response)

    function walk(node, insidePost) {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (const item of node) walk(item, insidePost);
        return;
      }
      // Some posts are wrapped in TweetWithVisibilityResults (X's type name)
      if (node.__typename === 'TweetWithVisibilityResults' && node.tweet) {
        walk(node.tweet, insidePost);
        return;
      }
      const isPost =
        node.rest_id &&
        node.legacy &&
        typeof node.legacy.full_text === 'string';

      if (isPost) {
        const rec = toRecord(node, insidePost);
        if (rec) {
          const prev = found.get(rec.id);
          // The same post can appear both at timeline level and nested
          // (quoted/reposted): keep the non-nested version if it exists.
          if (!prev || (prev.nested && !rec.nested)) found.set(rec.id, rec);
        }
        // Keep descending: a post can contain a quoted post or a repost's original
        for (const key of Object.keys(node)) walk(node[key], true);
        return;
      }
      for (const key of Object.keys(node)) walk(node[key], insidePost);
    }

    walk(root, false);
    return [...found.values()];
  }

  // X delivers post text with &, <, > HTML-escaped; store it decoded.
  // &amp; must be decoded last (e.g. "&amp;lt;" -> "&lt;").
  function decodeEntities(s) {
    return s
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
  }

  function toRecord(node, nested) {
    try {
      const lg = node.legacy;
      const userRes = node.core?.user_results?.result || {};
      const uLegacy = userRes.legacy || {};
      const uCore = userRes.core || {};

      const screenName = uCore.screen_name || uLegacy.screen_name || '';
      const authorName = uCore.name || uLegacy.name || screenName;

      // Full text: long posts live in note_tweet, otherwise legacy.full_text
      const text = decodeEntities(
        node.note_tweet?.note_tweet_results?.result?.text || lg.full_text || ''
      );

      // Media
      const mediaRaw = lg.extended_entities?.media || lg.entities?.media || [];
      const media = mediaRaw.map((m) => ({
        url: m.media_url_https || null,
        type: m.type || 'photo', // photo | video | animated_gif
        video:
          m.type !== 'photo'
            ? (m.video_info?.variants || [])
                .filter((v) => v.content_type === 'video/mp4')
                .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0]?.url || null
            : null,
      }));
      const mediaShortUrls = mediaRaw.map((m) => m.url).filter(Boolean);

      // Links (t.co -> real URL) for readable display in the digest
      const urls = (lg.entities?.urls || []).map((u) => ({
        short: u.url,
        expanded: u.expanded_url,
        display: u.display_url,
      }));

      const rtResult =
        lg.retweeted_status_result?.result?.tweet ||
        lg.retweeted_status_result?.result ||
        null;

      return {
        id: node.rest_id,
        text,
        screen_name: screenName,
        author_name: authorName,
        author_id: userRes.rest_id || lg.user_id_str || null,
        avatar:
          uLegacy.profile_image_url_https ||
          userRes.avatar?.image_url ||
          null,
        created_at: Date.parse(lg.created_at) || Date.now(),
        favorite_count: lg.favorite_count ?? 0,
        repost_count: lg.retweet_count ?? 0,
        reply_count: lg.reply_count ?? 0,
        favorited: !!lg.favorited,
        media,
        media_short_urls: mediaShortUrls,
        urls,
        is_repost: !!lg.retweeted_status_result,
        repost_of: rtResult?.rest_id || null,
        quoted_id: lg.quoted_status_id_str || null,
        reply_to: lg.in_reply_to_status_id_str || null, // parent post id, for threading
        nested: !!nested,
      };
    } catch (e) {
      return null;
    }
  }

  // Records seen in ANY parsed response, kept so a liked post can be stored with
  // its full content even when it came from a view we don't store wholesale
  // (a reply in TweetDetail). Bounded; oldest entries evicted first.
  const recordCache = new Map(); // id -> record
  const CACHE_CAP = 1000;
  function cacheRecord(rec) {
    if (!rec || !rec.id) return;
    recordCache.delete(rec.id); // refresh recency
    recordCache.set(rec.id, rec);
    if (recordCache.size > CACHE_CAP) {
      recordCache.delete(recordCache.keys().next().value); // evict oldest
    }
  }

  // Parse a captured response: cache every post it contains, and SHIP the batch
  // for wholesale storage only when it came from a home feed (SHIP_OPS). The `op`
  // tag (HomeLatestTimeline / HomeTimeline) lets Sync confirm it is on the
  // Following feed without depending on localized UI text.
  function handleResponse(json, url) {
    try {
      const posts = extractPosts(json);
      for (const p of posts) cacheRecord(p);
      const m = SHIP_OPS.exec(url || '');
      if (m && posts.length > 0) {
        window.postMessage({ [MARKER]: true, posts, op: m[1] }, window.location.origin);
      }
    } catch (e) {
      /* silent: never break the page */
    }
  }

  // ---------------------------------------------------------------------------
  // Session bearer token capture (needed for like-from-digest).
  // X's web app sends its public bearer token on every API request; we grab it
  // once per page load and hand it to the extension. Cookies (ct0/twid) are
  // read by the service worker directly — only the bearer lives in JS.
  // ---------------------------------------------------------------------------

  let bearerPosted = false;
  function noteBearer(value) {
    if (bearerPosted || !value || !/^Bearer /.test(value)) return;
    bearerPosted = true;
    window.postMessage(
      { __xDigestAuth: true, bearer: value },
      window.location.origin,
    );
  }

  function sniffHeaders(input, init) {
    try {
      const h = init?.headers || (input instanceof Request ? input.headers : null);
      if (!h) return;
      if (typeof h.get === 'function') noteBearer(h.get('authorization'));
      else noteBearer(h.authorization || h.Authorization);
    } catch (e) {
      /* silent */
    }
  }

  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    try {
      if (String(name).toLowerCase() === 'authorization') noteBearer(value);
    } catch (e) {
      /* silent */
    }
    return origSetHeader.call(this, name, value);
  };

  // ---------------------------------------------------------------------------
  // Operation-id harvest: learn opName -> queryId so like/bookmark keep working
  // when X rotates its ids (self-heals, no hardcoded id to maintain). Two sources:
  //  1. live traffic — X's GraphQL URLs are /i/api/graphql/<queryId>/<OpName>
  //     (only reveals ops that actually run in the page);
  //  2. X's JS bundles — scanned once on load, so ops that never appear in page
  //     traffic (e.g. bookmark mutations, which may run off the main thread) are
  //     still learned. Cross-origin bundles without CORS are skipped silently.
  // ---------------------------------------------------------------------------

  const GQL_OP = /\/i\/api\/graphql\/([^/]+)\/(\w+)/;

  // Only these mutations are used by the digest (like/unlike); ignore everything
  // else so we don't flood storage/console with irrelevant op ids.
  const USED_OPS = /^(FavoriteTweet|UnfavoriteTweet)$/;

  // Track how each op id was learned. A 'url' id comes from a REAL X request
  // (authoritative — it's literally the endpoint X hit); a 'bundle' id is parsed
  // from JS source and can be wrong (an op object may not list its own id
  // adjacently). URL ids therefore override bundle ids, never the reverse.
  const opSource = new Map(); // opName -> 'url' | 'bundle'

  function postOp(opName, queryId, source) {
    if (!opName || !queryId || !USED_OPS.test(opName)) return;
    const prev = opSource.get(opName);
    if (prev === 'url') return; // authoritative id already known
    if (prev === source) return; // same source, already sent
    opSource.set(opName, source);
    console.debug('[X Digest] learned op', opName, '=', queryId, `(${source})`);
    window.postMessage(
      { __xDigestOp: true, opName, queryId },
      window.location.origin,
    );
  }

  function noteOp(url) {
    try {
      const m = GQL_OP.exec(url || '');
      if (m) postOp(m[2], m[1], 'url'); // authoritative: real request URL
    } catch (e) {
      /* silent */
    }
  }

  // Capture the exact request BODY X sends for a used mutation, so the digest
  // can replay it verbatim (only swapping the post id). X's real body carries
  // fields (e.g. features/dark_request) that a minimal body omits — omitting
  // them makes the persisted-query request 404.
  function opNameIfUsed(url) {
    const m = GQL_OP.exec(url || '');
    return m && USED_OPS.test(m[2]) ? m[2] : null;
  }
  function captureBody(url, body) {
    try {
      const op = opNameIfUsed(url);
      if (!op || typeof body !== 'string' || !body) return;
      window.postMessage(
        { __xDigestOpBody: true, opName: op, body },
        window.location.origin,
      );
    } catch (e) {
      /* silent */
    }
  }

  // A like/unlike the user performed NATIVELY on x.com. We learn it from the
  // FavoriteTweet/UnfavoriteTweet mutation X sends on click (no request of our
  // own), and reflect it onto the stored post so the digest shows it after a
  // Refresh. Call only once the mutation has succeeded.
  function noteLikeAction(url, body) {
    try {
      const m = GQL_OP.exec(url || '');
      const op = m && m[2];
      if (op !== 'FavoriteTweet' && op !== 'UnfavoriteTweet') return;
      if (typeof body !== 'string' || !body) return;
      const id = JSON.parse(body)?.variables?.tweet_id;
      if (!id) return;
      // Include the full cached record (if we've seen it) so a liked reply that
      // isn't stored yet can be recorded with its content, not just its id.
      window.postMessage(
        {
          __xDigestLike: true,
          id: String(id),
          on: op === 'FavoriteTweet',
          post: recordCache.get(String(id)) || null,
        },
        window.location.origin,
      );
    } catch (e) {
      /* silent */
    }
  }

  const scannedUrls = new Set();
  async function scanBundle(url) {
    if (scannedUrls.has(url)) return;
    scannedUrls.add(url);
    try {
      const res = await fetch(url, { credentials: 'omit' });
      if (!res.ok) return;
      const txt = await res.text();
      if (txt.indexOf('operationName') === -1) return;
      // Pair queryId and operationName ONLY when they are adjacent keys of the
      // same object ({queryId:"..",operationName:".."} in either order). A
      // proximity window mis-pairs an op with a neighbour's id.
      const pairRe =
        /queryId:"([^"]+)",operationName:"(\w+)"|operationName:"(\w+)",queryId:"([^"]+)"/g;
      let m;
      while ((m = pairRe.exec(txt))) {
        if (m[2]) postOp(m[2], m[1], 'bundle');
        else postOp(m[3], m[4], 'bundle');
      }
    } catch (e) {
      /* CORS / network: skip this bundle */
    }
  }

  function isXBundle(u) {
    return /\.js(\?|$)/.test(u) && /(twimg\.com|x\.com)/.test(u);
  }

  async function harvestFromBundles() {
    try {
      const urls = performance
        .getEntriesByType('resource')
        .map((e) => e.name)
        .filter(isXBundle);
      for (const url of urls) await scanBundle(url);
    } catch (e) {
      /* silent */
    }
  }

  // Scan the bundles already loaded, then keep scanning new ones as X lazily
  // loads them (the bookmark module, for one, only loads on interaction — so a
  // one-time scan misses CreateBookmark/DeleteBookmark).
  setTimeout(harvestFromBundles, 3000);
  window.addEventListener('load', () => setTimeout(harvestFromBundles, 1000));
  try {
    const obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (isXBundle(e.name)) scanBundle(e.name);
      }
    });
    obs.observe({ type: 'resource', buffered: false });
  } catch (e) {
    /* PerformanceObserver unavailable: the timed scans still run */
  }

  // ---------------------------------------------------------------------------
  // Network hooks: fetch + XMLHttpRequest
  // ---------------------------------------------------------------------------

  const origFetch = window.fetch;
  window.fetch = function (...args) {
    const p = origFetch.apply(this, args);
    try {
      const input = args[0];
      const url = typeof input === 'string' ? input : input?.url || '';
      if (url.includes('/i/api/')) sniffHeaders(input, args[1]);
      if (url.includes('/i/api/graphql/')) {
        noteOp(url);
        const body = typeof args[1]?.body === 'string' ? args[1].body : null;
        if (body) {
          captureBody(url, body);
          // Native like/unlike: reflect it once the mutation actually succeeds.
          if (opNameIfUsed(url)) {
            p.then((resp) => resp.ok && noteLikeAction(url, body)).catch(() => {});
          }
        }
      }
      if (CAPTURE_OPS.test(url)) {
        p.then((resp) => {
          resp
            .clone()
            .json()
            .then((j) => handleResponse(j, url))
            .catch(() => {});
        }).catch(() => {});
      }
    } catch (e) {
      /* silent */
    }
    return p;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    try {
      if (typeof url === 'string' && url.includes('/i/api/graphql/')) {
        this.__bdUrl = url;
        noteOp(url);
      }
      if (typeof url === 'string' && CAPTURE_OPS.test(url)) {
        const capturedUrl = url;
        this.addEventListener('load', function () {
          try {
            handleResponse(JSON.parse(this.responseText), capturedUrl);
          } catch (e) {
            /* silent */
          }
        });
      }
    } catch (e) {
      /* silent */
    }
    return origOpen.call(this, method, url, ...rest);
  };

  const origXhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (body) {
    try {
      if (this.__bdUrl && typeof body === 'string') {
        captureBody(this.__bdUrl, body);
        // Native like/unlike over XHR: reflect it on a 2xx response.
        if (opNameIfUsed(this.__bdUrl)) {
          const url = this.__bdUrl;
          const b = body;
          this.addEventListener('load', function () {
            if (this.status >= 200 && this.status < 300) noteLikeAction(url, b);
          });
        }
      }
    } catch (e) {
      /* silent */
    }
    return origXhrSend.apply(this, arguments);
  };

  console.log('[X Digest] interceptor active');
})();
