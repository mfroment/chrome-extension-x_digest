// Smoke test for the capture path (interceptor.js).
//
// interceptor.js is a browser MAIN-world script, not a module, so we run it
// verbatim inside a Node `vm` sandbox with fake browser globals, then drive its
// fetch hook with a saved sample of X's timeline JSON and check what it would
// post back to the content script. This exercises the REAL extraction code with
// zero changes to the shipped file.
//
// What it guards: regressions in OUR parsing (entity decode, retweet fields,
// TweetWithVisibilityResults unwrap, the timeline op-name URL filter).
// What it can't guard: X changing its response shape — only live capture shows that.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, '..', 'interceptor.js'), 'utf8');

// --- a minimal but realistic HomeLatestTimeline payload -------------------
const user = (sn) => ({
  rest_id: `u_${sn}`,
  core: { screen_name: sn, name: sn.toUpperCase() },
  legacy: {},
  avatar: { image_url: `https://img/${sn}` },
});
const tweet = (id, sn, text) => ({
  rest_id: id,
  core: { user_results: { result: user(sn) } },
  legacy: {
    full_text: text,
    created_at: 'Wed Oct 10 20:19:24 +0000 2018',
    favorite_count: 5,
    retweet_count: 2,
    reply_count: 1,
    favorited: false,
    entities: {},
    extended_entities: {},
  },
});
const SAMPLE = {
  data: {
    home: {
      home_timeline_urt: {
        instructions: [
          {
            type: 'TimelineAddEntries',
            entries: [
              {
                entryId: 'tweet-111',
                sortIndex: '200',
                content: {
                  entryType: 'TimelineTimelineItem',
                  itemContent: { itemType: 'TimelineTweet', tweet_results: { result: tweet('111', 'alice', 'A &amp; B') } },
                },
              },
              {
                entryId: 'tweet-222',
                sortIndex: '199',
                content: {
                  entryType: 'TimelineTimelineItem',
                  // wrapped in TweetWithVisibilityResults — must be unwrapped
                  itemContent: {
                    itemType: 'TimelineTweet',
                    tweet_results: { result: { __typename: 'TweetWithVisibilityResults', tweet: tweet('222', 'bob', 'plain') } },
                  },
                },
              },
            ],
          },
        ],
      },
    },
  },
};

// Run interceptor.js in a sandbox; return the fake window + captured messages.
function loadInterceptor(sample) {
  const posted = [];
  const win = {
    location: { origin: 'https://x.com' },
    addEventListener() {},
    postMessage(m) { posted.push(m); },
    // the "real" fetch the interceptor wraps; returns a Response-like object
    fetch: () => Promise.resolve({ clone: () => ({ json: () => Promise.resolve(sample) }) }),
  };
  function XHR() {}
  XHR.prototype = { setRequestHeader() {}, open() {}, send() {}, addEventListener() {} };
  const sandbox = {
    window: win,
    XMLHttpRequest: XHR,
    performance: { getEntriesByType: () => [] },
    PerformanceObserver: function () { this.observe = () => {}; },
    console: { log() {}, debug() {}, warn() {}, error() {} },
    setTimeout: () => 0,
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox); // wraps win.fetch
  return { win, posted };
}

async function capture(url, sample = SAMPLE) {
  const { win, posted } = loadInterceptor(sample);
  win.fetch(url, {});
  await new Promise((r) => setImmediate(r)); // flush the resp.json().then(ship) chain
  return posted.filter((m) => m && m.__xDigest === true);
}

test('extracts posts from a HomeLatestTimeline response', async () => {
  const batches = await capture('https://x.com/i/api/graphql/abc/HomeLatestTimeline');
  assert.equal(batches.length, 1, 'one batch shipped');
  const posts = batches[0].posts;
  assert.equal(posts.length, 2, 'both tweets extracted');

  const byId = Object.fromEntries(posts.map((p) => [p.id, p]));
  assert.ok(byId['111'] && byId['222'], 'ids 111 and 222 present');
  assert.equal(byId['111'].text, 'A & B', 'HTML entities decoded');
  assert.equal(byId['111'].screen_name, 'alice');
  assert.equal(byId['111'].repost_count, 2, 'retweet_count -> repost_count');
  assert.equal(byId['222'].text, 'plain', 'TweetWithVisibilityResults unwrapped');
  assert.equal(batches[0].op, 'HomeLatestTimeline', 'batch tagged with its op');
});

test('op-name filter: ignores non-timeline GraphQL requests', async () => {
  const batches = await capture('https://x.com/i/api/graphql/abc/UserByScreenName');
  assert.equal(batches.length, 0, 'no timeline batch shipped for a non-timeline op');
});
