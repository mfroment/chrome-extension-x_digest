// content.js — isolated world. Relays posts extracted by interceptor.js
// (postMessage from the page context) to the extension's service worker,
// tagged with the logged-in X account they were captured under.

/**
 * Identify the logged-in X account.
 * - user id: `twid` cookie (u%3D<id>), present on all logged-in pages
 * - handle: profile link in the left navigation, when the DOM has it
 * Returns { id, handle|null } or null when logged out.
 */
function detectAccount() {
  const m = document.cookie.match(/(?:^|;\s*)twid=u%3D(\d+)/);
  if (!m) return null;
  const link = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
  const handle = link?.getAttribute('href')?.replace(/^\//, '') || null;
  return { id: m[1], handle };
}

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (event.origin !== window.location.origin) return;
  const data = event.data;
  if (!data) return;

  if (data.__xDigestAuth === true && typeof data.bearer === 'string') {
    const account = detectAccount();
    if (!account) return;
    chrome.runtime
      .sendMessage({ type: 'XD_AUTH', bearer: data.bearer, account })
      .catch(() => {});
    return;
  }

  if (data.__xDigestOp === true && data.opName && data.queryId) {
    chrome.runtime
      .sendMessage({ type: 'XD_OP', opName: data.opName, queryId: data.queryId })
      .catch(() => {});
    return;
  }

  if (data.__xDigestOpBody === true && data.opName && data.body) {
    chrome.runtime
      .sendMessage({ type: 'XD_OP_BODY', opName: data.opName, body: data.body })
      .catch(() => {});
    return;
  }

  if (data.__xDigest !== true || !Array.isArray(data.posts)) return;

  const account = detectAccount();
  if (!account) return; // logged out: nothing to attribute the capture to

  if (syncState.active) noteSyncCapture(data.posts, data.op);

  chrome.runtime
    .sendMessage({ type: 'XD_POSTS', posts: data.posts, account })
    .catch(() => {
      // The service worker may be waking up; the occasional error is benign —
      // posts will be recaptured on the next scroll (dedup by ID).
    });
});

// ---------------------------------------------------------------------------
// Sync driver: auto-scroll the Following/Latest feed until we reach posts we
// already have, then stop. Triggered by XD_SYNC_START (tabs.sendMessage from the
// service worker). Capture stays passive (interceptor + the relay above); this
// only drives the scroll and decides when to stop, from the timestamps of what
// streams past vs. the `frontier` (newest post the digest already holds).
// ---------------------------------------------------------------------------

const SYNC = {
  TICK_MS: 1500,     // pause between scrolls (human-paced)
  // The meaningful stop is the timestamp floor (`frontier`); these are just a
  // generous anti-runaway seatbelt that should almost never fire.
  MAX_MS: 300000,    // hard cap on total run time (5 min)
  MAX_SCROLLS: 300,  // hard cap on scroll count
  OLD_RUN: 25,       // stop once the last N captured posts are all <= frontier
  STALL_TICKS: 6,    // this many "stuck" ticks (can't scroll AND nothing new) = X's hard limit
};

const syncState = { active: false };
let syncOverlay = null;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function noteSyncCapture(posts, op) {
  const s = syncState;
  if (op) s.lastOp = op; // 'HomeLatestTimeline' (Following) | 'HomeTimeline' (For You)
  for (const p of posts) {
    if (p.nested) continue;
    if (!s.seen.has(p.id)) {
      s.seen.add(p.id);
      s.newThisTick++;
      s.newTotal++;
    }
    s.recent.push(p.created_at || 0); // rolling window of arrival-order timestamps
    if (s.recent.length > SYNC.OLD_RUN) s.recent.shift();
  }
}

function selectFollowingTab() {
  // Home has two top tabs: "For you" (0) and "Following" (1). Click the second
  // to select the chronological feed — by position, so it's locale-independent.
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  if (tabs.length >= 2 && tabs[1].getAttribute('aria-selected') !== 'true') {
    tabs[1].click();
  }
}

// Scroll toward the bottom of the loaded feed. Scrolling the last timeline cell
// into view bubbles to whatever the real scroll container is (X sometimes uses
// an inner scroller, so window.scrollBy alone can be a no-op) and reliably
// pushes X to paginate. Falls back to window scroll if no cells are present yet.
function scrollStep() {
  const cells = document.querySelectorAll('[data-testid="cellInnerDiv"]');
  const last = cells[cells.length - 1];
  if (last) last.scrollIntoView({ block: 'end' }); // to the bottom of rendered posts
  else window.scrollBy(0, window.innerHeight * 2); // no cells yet: fall back to window scroll
  return cells.length;
}

function syncSend(type, extra) {
  chrome.runtime.sendMessage({ type, newTotal: syncState.newTotal, ...extra }).catch(() => {});
}

const AUTOCLOSE_SECS = 5;
const OVERLAY_FONT = '600 13px -apple-system, system-ui, sans-serif';

function endSync(reason, error) {
  if (syncState.ending) return; // idempotent: the Stop click and the loop can race
  syncState.ending = true;
  syncState.active = false;
  syncSend('XD_SYNC_DONE', { reason, error: error || null });
  startAutoClose(reason, error); // then count down and close this tab (cancellable)
}

// On-page overlay on the x.com tab: "Syncing…" + a button that Stops during the
// run and becomes "Cancel autoclose" once it finishes.
function showSyncOverlay() {
  if (syncOverlay) return;
  const box = document.createElement('div');
  Object.assign(box.style, {
    position: 'fixed', top: '12px', right: '12px', zIndex: '2147483647',
    display: 'flex', alignItems: 'center', gap: '10px',
    background: '#1b2a4a', color: '#fff', font: OVERLAY_FONT,
    padding: '8px 8px 8px 14px', borderRadius: '999px',
    boxShadow: '0 4px 16px rgba(0, 0, 0, 0.35)',
  });
  const label = document.createElement('span');
  label.textContent = '🔄 Syncing…';
  const btn = document.createElement('button');
  btn.textContent = 'Stop';
  Object.assign(btn.style, {
    background: '#d4382e', color: '#fff', border: 'none', font: OVERLAY_FONT,
    borderRadius: '999px', padding: '5px 14px', cursor: 'pointer',
  });
  btn.addEventListener('click', onSyncButton);
  box.append(label, btn);
  (document.body || document.documentElement).appendChild(box);
  syncOverlay = { box, label, btn, phase: 'running', timer: null };
}

function onSyncButton() {
  if (!syncOverlay) return;
  if (syncOverlay.phase === 'running') {
    endSync('stopped');
  } else {
    clearTimeout(syncOverlay.timer); // cancel the autoclose, keep the tab
    hideSyncOverlay();
  }
}

// Count down and ask the SW to close this tab, unless the user cancels.
function startAutoClose(reason, error) {
  if (!syncOverlay) return;
  syncOverlay.phase = 'closing';
  syncOverlay.btn.textContent = 'Cancel autoclose';
  syncOverlay.btn.style.background = '#5a6784';
  const head = error ? '⚠︎ Sync stopped' : reason === 'stopped' ? '■ Stopped' : '✓ Synced';
  let secs = AUTOCLOSE_SECS;
  const tick = () => {
    if (!syncOverlay) return;
    if (secs <= 0) {
      chrome.runtime.sendMessage({ type: 'XD_SYNC_CLOSE_TAB' }).catch(() => {});
      return;
    }
    syncOverlay.label.textContent = `${head} — closing tab in ${secs}s`;
    secs -= 1;
    syncOverlay.timer = setTimeout(tick, 1000);
  };
  tick();
}

function hideSyncOverlay() {
  if (syncOverlay) {
    clearTimeout(syncOverlay.timer);
    syncOverlay.box.remove();
    syncOverlay = null;
  }
}

async function runSync(frontier) {
  if (syncState.active) return;
  Object.assign(syncState, {
    active: true,
    ending: false,
    seen: new Set(),
    recent: [],
    newThisTick: 0,
    newTotal: 0,
    lastOp: null,
    frontier: frontier || 0,
  });

  showSyncOverlay();
  selectFollowingTab();
  await wait(SYNC.TICK_MS);

  const started = Date.now();
  let scrolls = 0;
  let stall = 0;
  let sawCapture = false;
  let lastY = -1;

  while (syncState.active) {
    syncState.newThisTick = 0;
    const cellCount = scrollStep();
    await wait(SYNC.TICK_MS);
    if (!syncState.active) return; // Stop pressed mid-tick: bail without another scroll
    scrolls++;

    // Hard guard: never sync the For You feed. If scrolling is fetching
    // HomeTimeline, we're on the wrong tab — stop and tell the user.
    if (syncState.lastOp === 'HomeTimeline') {
      endSync('not-following', 'Open the Following (Latest) tab, then Sync again.');
      return;
    }

    if (syncState.newTotal > 0) sawCapture = true;

    // Progress = we managed to scroll further this tick. X paginates in big,
    // infrequent bursts, so "no new posts" alone isn't stuck — as long as we can
    // still scroll down through loaded posts we keep going. Only a run of ticks
    // where we CAN'T scroll further AND nothing new loads (parked at the true
    // bottom, feed not extending) ends the run.
    const y = window.scrollY;
    const progressed = y > lastY + 50;
    lastY = y;
    stall = syncState.newThisTick > 0 || progressed ? 0 : stall + 1;

    syncSend('XD_SYNC_PROGRESS');
    console.log('[X Digest sync]', {
      scrolls,
      cells: cellCount,
      y: Math.round(y),
      newThisTick: syncState.newThisTick,
      newTotal: syncState.newTotal,
      stall,
      op: syncState.lastOp,
    });

    // Caught up: a full window of recent captures at/older than the frontier.
    if (
      syncState.frontier > 0 &&
      syncState.recent.length >= SYNC.OLD_RUN &&
      syncState.recent.every((ts) => ts <= syncState.frontier)
    ) {
      endSync('caught-up');
      return;
    }
    // Parked at the bottom with nothing extending it: end of feed if we captured
    // anything, otherwise benign "already current / never paginated".
    if (stall >= SYNC.STALL_TICKS) {
      endSync(sawCapture ? 'end-of-feed' : 'no-new');
      return;
    }
    // Safety caps.
    if (scrolls >= SYNC.MAX_SCROLLS || Date.now() - started > SYNC.MAX_MS) {
      endSync('cap');
      return;
    }
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'XD_SYNC_START') runSync(msg.frontier);
});
