// background.js — service worker (module).
// Receives account-tagged posts from the content script, auto-registers
// unknown accounts (disabled by default), stores posts only for enabled
// accounts, keeps the badge scoped to enabled accounts, opens the digest.

import { putPosts, countUnread, getAllPosts, applyLike } from './db.js';
import { CRITERIA_DEFAULTS, loadAccounts, saveAccounts } from './defaults.js';

const DIGEST_URL = chrome.runtime.getURL('digest.html');

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'XD_POSTS' && Array.isArray(msg.posts)) {
    handlePosts(msg.posts, msg.account)
      .then((result) => sendResponse(result))
      .catch((e) => sendResponse({ error: String(e) }));
    return true; // async response
  }
  if (msg?.type === 'XD_AUTH' && msg.account?.id) {
    storeAuth(msg.account.id, msg.bearer).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg?.type === 'XD_OP' && msg.opName && msg.queryId) {
    storeOp(msg.opName, msg.queryId).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg?.type === 'XD_OP_BODY' && msg.opName && msg.body) {
    storeOpBody(msg.opName, msg.body).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg?.type === 'XD_LIKE' && msg.postId && msg.accountId) {
    likePost(msg.postId, msg.accountId, msg.on)
      .then((result) => sendResponse(result))
      .catch((e) => sendResponse({ error: e?.message || String(e) }));
    return true;
  }
  if (msg?.type === 'XD_LIKE_OBSERVED' && msg.id) {
    handleObservedLike(msg)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg?.type === 'XD_POSTS_REFRESH' && Array.isArray(msg.posts)) {
    refreshCounts(msg.posts)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg?.type === 'XD_REFRESH_BADGE') {
    updateBadge().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg?.type === 'XD_SYNC' && msg.accountId) {
    startSync(msg.accountId, msg.floorTs)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ error: e?.message || String(e) }));
    return true;
  }
  if (msg?.type === 'XD_SYNC_DONE') {
    handleSyncDone(msg.reason);
    return;
  }
  if (msg?.type === 'XD_SYNC_CLOSE_TAB' && sender.tab?.id) {
    chrome.tabs.remove(sender.tab.id).catch(() => {});
    return;
  }
  if (msg?.type === 'XD_SYNC_SEED' && msg.accountId) {
    seedBoundary(msg.accountId).then(() => sendResponse({ ok: true }));
    return true;
  }
});

// ---------------------------------------------------------------------------
// Sync: open/focus a visible x.com tab on Following/Latest and let the content
// script auto-scroll it until it reaches posts we already have. Capture itself
// is the usual passive path; this only kicks off the scroll driver.
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let activeSync = null; // { accountId } while a sync runs, so we can advance its boundary

const SYNC_MARGIN_MS = 5 * 60 * 1000; // re-scan this far past the boundary for overlap

async function startSync(accountId, floorTs) {
  // The feed we scroll belongs to whoever is logged in on x.com — make sure
  // that's the account we're syncing, or captures would land elsewhere.
  const twid = await getCookie('twid');
  const activeId = twid ? decodeURIComponent(twid).match(/u=(\d+)/)?.[1] : null;
  if (!activeId) throw new Error('Not logged in on x.com.');
  if (activeId !== accountId) {
    throw new Error('x.com is logged into a different account than the digest.');
  }

  // Stop at a timestamp floor. Default = the persisted last-sync boundary minus
  // a small overlap margin (seeded to when the digest was first opened for this
  // account). `floorTs`, when given, is a one-shot UI override to force a sync
  // further back. The boundary is NOT the current newest post, so casual
  // browsing between syncs can't plant a recent post that plugs the interval.
  const boundary = await getSyncBoundary(accountId);
  const frontier = floorTs
    ? floorTs
    : boundary
      ? Math.max(0, boundary - SYNC_MARGIN_MS)
      : 0;
  const tab = await openFollowingTab();
  activeSync = { accountId };
  // Content script may be a beat behind the load event; retry the kick once.
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'XD_SYNC_START', frontier });
  } catch (e) {
    await sleep(1500);
    await chrome.tabs.sendMessage(tab.id, { type: 'XD_SYNC_START', frontier });
  }
  return { ok: true, tabId: tab.id, frontier };
}

// Advance the persisted boundary only when the sync reached contiguous
// already-known territory (caught-up) or the end of what X serves (end-of-feed).
// On a cap/abort we leave it, so the next sync retries the unfilled interval.
async function handleSyncDone(reason) {
  const acct = activeSync?.accountId;
  activeSync = null;
  if (acct && (reason === 'caught-up' || reason === 'end-of-feed')) {
    await setSyncBoundary(acct, await accountFrontier(acct));
  }
  await updateBadge();
}

async function getSyncBoundary(accountId) {
  const { syncBoundary = {} } = await chrome.storage.local.get({ syncBoundary: {} });
  return syncBoundary[accountId] || 0;
}

// The first time the digest is opened for an account (no boundary yet), seed the
// boundary to "now" — like X, you start current and future syncs fetch forward.
async function seedBoundary(accountId) {
  const { syncBoundary = {} } = await chrome.storage.local.get({ syncBoundary: {} });
  if (syncBoundary[accountId] == null) {
    syncBoundary[accountId] = Date.now();
    await chrome.storage.local.set({ syncBoundary });
  }
}

async function setSyncBoundary(accountId, ts) {
  const { syncBoundary = {} } = await chrome.storage.local.get({ syncBoundary: {} });
  syncBoundary[accountId] = ts;
  await chrome.storage.local.set({ syncBoundary });
}

/** Newest created_at among this account's captured (non-nested) posts. */
async function accountFrontier(accountId) {
  const all = await getAllPosts();
  let max = 0;
  for (const p of all) {
    if (p.nested || !(p.accounts || []).includes(accountId)) continue;
    if (p.created_at > max) max = p.created_at;
  }
  return max;
}

/** Always open a FRESH x.com tab on Home — never hijack a tab the user is on.
 *  The driver then selects the Following (Latest) feed. */
async function openFollowingTab() {
  const tab = await chrome.tabs.create({ url: 'https://x.com/home', active: true });
  await waitForTabComplete(tab.id);
  await sleep(1500); // let X's SPA render the timeline + tab bar
  return tab;
}

function waitForTabComplete(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.get(tabId).then((t) => {
      if (t && t.status === 'complete') return resolve();
      const listener = (id, info) => {
        if (id === tabId && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
  });
}

// ---------------------------------------------------------------------------
// Like / unlike from the digest (human clicks only, one request per click).
// Uses the browser's own x.com session cookies + the captured bearer token.
// (Bookmark was dropped: X gates CreateBookmark behind a client-signed header
// the extension can't reproduce; see CLAUDE.md.)
// ---------------------------------------------------------------------------

// Fallback op id for FavoriteTweet only (confirmed correct, and harvested early
// from the timeline bundle anyway). The other mutations are learned from X's JS
// bundles (interceptor harvest); we deliberately ship no guessed fallback for
// them, so a wrong id can never be used — an unlearned op asks the user to load
// it once (e.g. open the Bookmarks page) rather than failing with a 404.
const OPS_FALLBACK = {
  FavoriteTweet: 'lI07N6Otwv1PhnEgXILM7A',
};

async function storeAuth(accountId, bearer) {
  const { xAuth = {} } = await chrome.storage.local.get({ xAuth: {} });
  xAuth[accountId] = { bearer, at: Date.now() };
  await chrome.storage.local.set({ xAuth });
}

async function storeOp(opName, queryId) {
  const { xOps = {} } = await chrome.storage.local.get({ xOps: {} });
  if (xOps[opName] === queryId) return;
  xOps[opName] = queryId;
  await chrome.storage.local.set({ xOps });
  console.debug('[X Digest] stored op', opName, '=', queryId);
}

/** Remember the exact request body X used for a mutation (to replay it). */
async function storeOpBody(opName, body) {
  const { xOpBodies = {} } = await chrome.storage.local.get({ xOpBodies: {} });
  if (xOpBodies[opName] === body) return;
  xOpBodies[opName] = body;
  await chrome.storage.local.set({ xOpBodies });
  console.debug('[X Digest] stored op body', opName);
}

/**
 * Build the request body for a mutation. Prefer replaying X's real captured
 * body (swapping only the post id), so fields like `features`/`dark_request`
 * are preserved; fall back to a minimal body if none captured yet.
 */
async function buildBody(opName, postId, queryId) {
  const { xOpBodies = {} } = await chrome.storage.local.get({ xOpBodies: {} });
  const tmpl = xOpBodies[opName];
  if (tmpl) {
    try {
      const obj = JSON.parse(tmpl);
      if (obj.variables && typeof obj.variables === 'object') {
        obj.variables.tweet_id = postId;
      }
      obj.queryId = queryId;
      return JSON.stringify(obj);
    } catch (e) {
      /* fall through to minimal body */
    }
  }
  return JSON.stringify({ variables: { tweet_id: postId }, queryId });
}

/** Prefer a harvested queryId for this operation, else the hardcoded fallback. */
async function resolveQueryId(opName) {
  const { xOps = {} } = await chrome.storage.local.get({ xOps: {} });
  return xOps[opName] || OPS_FALLBACK[opName];
}

/** Drop a stored (wrong) queryId so it can be relearned. */
async function forgetOp(opName) {
  const { xOps = {} } = await chrome.storage.local.get({ xOps: {} });
  if (xOps[opName] !== undefined) {
    delete xOps[opName];
    await chrome.storage.local.set({ xOps });
  }
}

async function getCookie(name) {
  const c = await chrome.cookies.get({ url: 'https://x.com', name });
  return c?.value || null;
}

/**
 * Perform one X GraphQL mutation as `accountId`, using the browser session.
 * The queryId is resolved from harvested live ids (falling back to `fallbackId`).
 * `alreadyPattern` downgrades the "duplicate action" error to a success.
 */
async function xMutation(accountId, opName, variables, okPattern) {
  const { xAuth = {} } = await chrome.storage.local.get({ xAuth: {} });
  const bearer = xAuth[accountId]?.bearer;
  if (!bearer) {
    throw new Error('No X session captured yet — open x.com and scroll once, then retry.');
  }

  // The action is performed by whoever is logged in on x.com: make sure that
  // matches the digest account, or it would come from the wrong account.
  const twid = await getCookie('twid');
  const activeId = twid ? decodeURIComponent(twid).match(/u=(\d+)/)?.[1] : null;
  if (!activeId) throw new Error('Not logged in on x.com.');
  if (activeId !== accountId) {
    throw new Error('x.com is currently logged into a different account.');
  }

  const ct0 = await getCookie('ct0');
  if (!ct0) throw new Error('Missing csrf cookie (ct0) — reload x.com.');

  const queryId = await resolveQueryId(opName);
  if (!queryId) {
    throw new Error(
      `${opName} id unknown — do this action once natively on x.com so the extension can learn it.`,
    );
  }
  const body = await buildBody(opName, variables.tweet_id, queryId);
  const resp = await fetch(`https://x.com/i/api/graphql/${queryId}/${opName}`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      authorization: bearer,
      'x-csrf-token': ct0,
      'x-twitter-auth-type': 'OAuth2Session',
      'x-twitter-active-user': 'yes',
    },
    body,
  });
  const raw = await resp.text();
  let json = null;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    /* non-JSON response */
  }
  if (resp.ok && json?.data && !json.errors) return { ok: true };
  const message = json?.errors?.[0]?.message || `HTTP ${resp.status}`;
  // A no-op (e.g. un-liking something not liked) is a success for a toggle.
  if (okPattern.test(message)) return { ok: true, already: true };
  if (resp.status === 404) {
    await forgetOp(opName);
    throw new Error(`${opName} is not permitted via the API from this extension.`);
  }
  throw new Error(message);
}

function likePost(postId, accountId, on) {
  return on
    ? xMutation(accountId, 'FavoriteTweet', { tweet_id: postId }, /already favorited/i)
    : xMutation(accountId, 'UnfavoriteTweet', { tweet_id: postId }, /not.*(favorited|found)/i);
}

// A native like/unlike observed on x.com. Explicitly LIKING records the post
// with its full content (insert-or-update via handlePosts, which respects the
// account-enabled gate) so it enters the digest. Everything else — an unlike, or
// a like we have no cached record for — only updates the stored post in place
// and inserts nothing, so browsing never pulls unrelated posts into the digest.
async function handleObservedLike({ id, on, post, account }) {
  if (on && post && post.id === id && account?.id) {
    const rec = {
      ...post,
      favorited: true,
      favorite_count: Math.max(0, (post.favorite_count || 0) + 1),
    };
    return handlePosts([rec], account);
  }
  const changed = await applyLike(id, !!on);
  return { ok: true, changed };
}

// Refresh counts/liked-state of posts ALREADY stored (viewed on a detail page,
// profile, search, …). Update-only — never inserts, never re-tags accounts — so
// browsing can't pull unrelated posts into the digest. Notifies an open digest
// only when something actually changed.
async function refreshCounts(posts) {
  const { updated } = await putPosts(posts, null, { updateOnly: true });
  if (updated > 0) {
    chrome.runtime.sendMessage({ type: 'XD_STORED', added: 0, updated }).catch(() => {});
  }
  return { updated };
}

async function handlePosts(posts, account) {
  if (!account?.id) return { dropped: 'no account' };

  // Register unseen accounts so they appear in settings — disabled by default.
  const accounts = await loadAccounts();
  let entry = accounts[account.id];
  let dirty = false;
  if (!entry) {
    // Seed criteria from legacy top-level settings if present (pre-multi-account)
    const legacy = await chrome.storage.local.get(CRITERIA_DEFAULTS);
    entry = { handle: account.handle, enabled: false, ...legacy };
    accounts[account.id] = entry;
    dirty = true;
  }
  if (account.handle && entry.handle !== account.handle) {
    entry.handle = account.handle;
    dirty = true;
  }
  if (dirty) await saveAccounts(accounts);

  if (!entry.enabled) return { dropped: 'account disabled' };

  const { added, updated } = await putPosts(posts, account.id);
  await updateBadge();
  if (added > 0 || updated > 0) {
    // Notify the digest if it is open (silent failure otherwise)
    chrome.runtime
      .sendMessage({ type: 'XD_STORED', added, updated, account: account.id })
      .catch(() => {});
  }
  return { added, updated };
}

async function updateBadge() {
  try {
    const accounts = await loadAccounts();
    const enabledIds = Object.keys(accounts).filter((id) => accounts[id].enabled);
    const unread = await countUnread(enabledIds);
    await chrome.action.setBadgeBackgroundColor({ color: '#1B2A4A' });
    await chrome.action.setBadgeText({
      text: unread > 0 ? (unread > 999 ? '999+' : String(unread)) : '',
    });
  } catch (e) {
    /* silent */
  }
}

// Icon click: focus an already-open digest, otherwise open one.
chrome.action.onClicked.addListener(async () => {
  const tabs = await chrome.tabs.query({ url: DIGEST_URL });
  if (tabs.length > 0) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    await chrome.windows.update(tabs[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: DIGEST_URL });
  }
});

// Keep the badge current on browser startup / install
chrome.runtime.onStartup?.addListener(updateBadge);
chrome.runtime.onInstalled.addListener(() => {
  // Drop operation ids/bodies harvested by older logic; they are relearned from
  // real X requests / bundles on the next x.com load.
  chrome.storage.local.remove(['xOps', 'xOpBodies']);
  updateBadge();
});
