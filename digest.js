// digest.js — reading view. Step 2: LLM-enriched digest
// (events section, summaries, theme labels, on-demand translation).

import {
  getAllPosts,
  markReadUpTo,
  markUnreadSince,
  toggleRead,
  getEvents,
  setEventFlag,
  ensureEventGroups,
  applyFieldUpdates,
  saveLLMResults,
  clearAnalysis,
} from './db.js';
import { loadGlobal, loadAccounts, accountConfig } from './defaults.js';
import { runPipeline } from './pipeline.js';
import { translatePost } from './llm.js';

const listEl = document.getElementById('list');
const emptyEl = document.getElementById('empty');
const statsEl = document.getElementById('stats');
const searchEl = document.getElementById('search');
const onlyUnreadEl = document.getElementById('only-unread');
// "Unread only" is a toggle button; state lives in aria-pressed.
const unreadOnly = () => onlyUnreadEl.getAttribute('aria-pressed') === 'true';
function setUnreadOnly(on) {
  onlyUnreadEl.setAttribute('aria-pressed', on ? 'true' : 'false');
  localStorage.setItem('bd-only-unread', on ? '1' : '');
}
const sortOrderEl = document.getElementById('sort-order');
const eventsEl = document.getElementById('events');
const eventsListEl = document.getElementById('events-list');
const eventsEmptyEl = document.getElementById('events-empty');
const pipelineStatusEl = document.getElementById('pipeline-status');
const tabTimelineEl = document.getElementById('tab-timeline');
const tabEventsEl = document.getElementById('tab-events');

let activeTab = 'timeline'; // 'timeline' | 'events'
// Each tab remembers its own scroll position. The window scroll is shared, so
// without this, jumping to a post deep in the Timeline and switching back to
// Events would leave Events scrolled to that same deep position.
const tabScroll = { timeline: 0, events: 0 };

function setTab(tab) {
  if (tab !== activeTab) tabScroll[activeTab] = window.scrollY; // remember where we were
  activeTab = tab;
  localStorage.setItem('bd-tab', tab);
  tabTimelineEl.classList.toggle('active', tab === 'timeline');
  tabEventsEl.classList.toggle('active', tab === 'events');
  listEl.hidden = tab !== 'timeline';
  eventsEl.hidden = tab !== 'events';
  document.getElementById('timeline-controls').hidden = tab !== 'timeline';
  document.getElementById('events-controls').hidden = tab !== 'events';
  render(); // folding depends on the active tab
  window.scrollTo(0, tabScroll[tab] || 0); // restore the destination tab's position
}

let all = [];          // all records (every account; filtered at render time)
let byId = new Map();  // id -> record
let eventGroups = [];  // clustered event groups (from the `events` store)
let sortAsc = true;    // oldest first (reading order)
const expanded = new Set();   // ids of manually expanded "other"-tier cards
const threadOpen = new Set(); // ids whose captured replies are expanded inline
// The last post jumped to (Events "View post"), shown even while "Unread only"
// is on WITHOUT turning the filter off. Just one id, overwritten on the next
// jump. Cleared explicitly by Analyze, the Refresh button and sort change; gone
// on page reload (F5). Not touched by mark-read / undo / thread-expand, so those
// don't disturb it. At most one read post lingers in the unread list — benign.
let focusExceptionId = null;
let childrenById = new Map(); // parent id -> captured reply records (built per render)

// Fully-read days fold under their date. Show the 5 most-recent read days; the
// "+" button reveals more in steps. State resets on load / Unread-only toggle.
const READ_DAY_LIMITS = [5, 15, 35, 85, Infinity];
let readDayLimitIdx = 0;
const unfoldedDays = new Set(); // dayKeys of read days the user manually expanded
function resetFolding() {
  readDayLimitIdx = 0;
  unfoldedDays.clear();
}

// Events tab has its own search / sort / "unhidden only", independent of the timeline.
const eventSearchEl = document.getElementById('event-search');
const eventUnhiddenEl = document.getElementById('event-unhidden-only');
const eventSortEl = document.getElementById('event-sort-order');
let eventSortAsc = true;
const eventUnhiddenOnly = () => eventUnhiddenEl.getAttribute('aria-pressed') === 'true';

// Past events are shown only when "Unhidden only" is OFF, folded by date with the
// same staggered "show older" limit as the Timeline's read days.
const EVENT_PAST_LIMITS = [5, 15, 35, 85, Infinity];
let eventPastLimitIdx = 0;
const eventUnfoldedDates = new Set(); // past event dates the user manually expanded
function resetEventFolding() {
  eventPastLimitIdx = 0;
  eventUnfoldedDates.clear();
}

// Lazy-load avatar images only when their card scrolls into view.
const avatarObserver = new IntersectionObserver(
  (entries, obs) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const img = e.target;
      if (img.dataset.src) {
        img.src = img.dataset.src;
        delete img.dataset.src;
      }
      obs.unobserve(img);
    }
  },
  { rootMargin: '300px' },
);

let accounts = {};           // registry from settings
let selectedAccount = null;  // X user id whose digest is displayed
const accountEl = document.getElementById('account');

/** Does this record belong to the selected account's digest? */
const mine = (t) => !!selectedAccount && (t.accounts || []).includes(selectedAccount);

async function initAccounts() {
  accounts = await loadAccounts();
  const enabledIds = Object.keys(accounts).filter((id) => accounts[id].enabled);
  accountEl.textContent = '';
  for (const id of enabledIds) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = accounts[id].handle ? `@${accounts[id].handle}` : `id ${id}`;
    accountEl.appendChild(opt);
  }
  // Show the account switcher whenever an account is enabled (not only when 2+),
  // so it's always visible which digest you're viewing and how to switch.
  accountEl.hidden = enabledIds.length < 1;
  const saved = localStorage.getItem('bd-account');
  selectedAccount = enabledIds.includes(saved) ? saved : enabledIds[0] || null;
  if (selectedAccount) {
    accountEl.value = selectedAccount;
    seedSyncBoundary(selectedAccount); // establish the sync baseline on first open
  }
}

// On first open for an account, ask the SW to seed its sync boundary to "now".
function seedSyncBoundary(accountId) {
  chrome.runtime.sendMessage({ type: 'XD_SYNC_SEED', accountId }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Undo for mark-read / mark-unread / hide actions. Each records the exact
// { id, field, previous value } changes it made, so bulk actions restore ONLY
// the posts they actually flipped (not ones already in that state).
// ---------------------------------------------------------------------------
const undoStack = [];
const undoBtn = document.getElementById('undo');

function pushUndo(label, changes) {
  if (!changes.length) return;
  undoStack.push({ label, changes });
  if (undoStack.length > 30) undoStack.shift();
  updateUndoBtn();
}
function updateUndoBtn() {
  const last = undoStack[undoStack.length - 1];
  undoBtn.hidden = !last;
  if (last) undoBtn.title = `Undo: ${last.label} (${last.changes.length}) — Ctrl/⌘+Z`;
}
async function undoLast() {
  const entry = undoStack.pop();
  if (!entry) return;
  await applyFieldUpdates(entry.changes);
  updateUndoBtn();
  await load(); // reload + re-render (covers both the timeline and events)
}

// ---------------------------------------------------------------------------
// Loading + rendering
// ---------------------------------------------------------------------------

async function load() {
  all = await getAllPosts();
  // Legacy records (captured before entity decoding in interceptor.js) still
  // hold &amp;/&lt;/&gt; in their text; decode for display and search.
  for (const t of all) t.text = decodeEntities(t.text);
  byId = new Map(all.map((t) => [t.id, t]));
  await refreshEventGroups();
  resetFolding();
  render();
}

// Cheap (no-LLM) singleton backfill so the Events tab is populated immediately —
// including legacy events right after the v4 upgrade, before any Analyze. The
// LLM clustering that merges duplicates runs during Analyze.
async function refreshEventGroups() {
  if (selectedAccount) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    await ensureEventGroups(isoDate(d), selectedAccount);
  }
  eventGroups = await getEvents();
}

function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function visiblePosts() {
  // "nested" entries (quoted post / repost original) are not timeline entries:
  // they serve as reference data for rendering.
  let items = all.filter((t) => !t.nested && mine(t));
  items.sort((a, b) => (sortAsc ? a.created_at - b.created_at : b.created_at - a.created_at));

  const q = searchEl.value.trim().toLowerCase();
  if (q) {
    items = items.filter((t) => {
      const orig = t.repost_of ? byId.get(t.repost_of) : null;
      const quoted = t.quoted_id ? byId.get(t.quoted_id) : null;
      const hay = [
        t.text,
        t.author_name,
        t.screen_name,
        `@${t.screen_name}`, // so a "@handle" query matches the poster/reposter
        t.summary,
        t.theme,
        t.event?.name,
        t.event?.venue,
        orig?.text,
        orig?.author_name,
        orig?.screen_name, // repost: also match the ORIGINAL author (works when collapsed)
        orig ? `@${orig.screen_name}` : null,
        quoted?.text,
      ]
        .filter(Boolean)
        .join('\n')
        .toLowerCase();
      return hay.includes(q);
    });
  }
  if (unreadOnly()) items = items.filter((t) => !t.read || t.id === focusExceptionId);
  return items;
}

// Right-click an author's name -> menu to filter the timeline to their posts and
// reposts by populating the search with their @handle (the search hay above
// matches @handle against poster, reposter, and a repost's original author).
function authorMenu(e, screenName) {
  e.preventDefault();
  e.stopPropagation();
  showContextMenu(e.clientX, e.clientY, [
    { label: `🔍 Search "@${screenName}"`, onClick: () => filterByAuthor(screenName) },
  ]);
}
function filterByAuthor(screenName) {
  searchEl.value = `@${screenName}`;
  localStorage.setItem('bd-search', searchEl.value);
  updateSearchClear();
  render();
}

// Index captured replies by their parent id (same account, non-nested, and the
// parent must itself be a captured post). Cheap enough to rebuild each render.
function buildThreadIndex() {
  childrenById = new Map();
  for (const t of all) {
    if (t.nested || !mine(t) || !t.reply_to) continue;
    const parent = byId.get(t.reply_to);
    if (!parent || parent.nested || !mine(parent)) continue;
    if (!childrenById.has(t.reply_to)) childrenById.set(t.reply_to, []);
    childrenById.get(t.reply_to).push(t);
  }
  for (const arr of childrenById.values()) {
    arr.sort((a, b) => a.created_at - b.created_at); // oldest-first within a thread
  }
}

// Append a post's card and, when its thread is open, its replies recursively.
// `depth` drives the left indent; `seen` guards against reply-to cycles.
function appendThread(container, t, depth, seen) {
  if (seen.has(t.id)) return;
  seen.add(t.id);
  const card =
    t.category === 'other' && !expanded.has(t.id)
      ? collapsedCard(t, depth)
      : postCard(t, depth);
  container.appendChild(card);
  if (threadOpen.has(t.id)) {
    for (const child of childrenById.get(t.id) || []) {
      appendThread(container, child, depth + 1, seen);
    }
  }
}

// Keep the reading position stable across re-renders: anchor to the timeline
// post nearest the viewport centre, so content changing above it (new posts,
// filter or analysis changes) doesn't shift what you're reading. Falls back to
// the raw scroll offset when there's nothing to anchor to (e.g. the Events tab).
function scrollAnchor() {
  if (activeTab === 'timeline') {
    const el = document
      .elementFromPoint(window.innerWidth / 2, window.innerHeight / 2)
      ?.closest('[data-id]');
    if (el && listEl.contains(el)) {
      return { id: el.dataset.id, top: el.getBoundingClientRect().top };
    }
  }
  return { y: window.scrollY };
}

function restoreScroll(a) {
  if (a.id) {
    const el = listEl.querySelector(`[data-id="${CSS.escape(a.id)}"]`);
    if (el) return window.scrollBy(0, el.getBoundingClientRect().top - a.top);
  }
  if (typeof a.y === 'number') window.scrollTo(0, a.y);
}

function render() {
  buildThreadIndex();
  const items = visiblePosts();
  const anchor = scrollAnchor();

  listEl
    .querySelectorAll('.thread, .day-sep, .reading-line, .more-days')
    .forEach((n) => n.remove());
  avatarObserver.disconnect(); // drop observations on the cards we just removed
  emptyEl.style.display = items.length === 0 ? '' : 'none';
  if (items.length === 0) {
    if (!selectedAccount) {
      emptyEl.innerHTML =
        '<p><strong>No X account has digests enabled.</strong></p>' +
        '<p>Open Settings (⚙ above), enable your account, then browse x.com to capture posts.</p>';
    } else if (searchEl.value.trim()) {
      emptyEl.innerHTML = '<p><strong>No posts match your search.</strong></p>';
    } else if (unreadOnly()) {
      emptyEl.innerHTML = "<p><strong>No unread posts.</strong></p><p>You're all caught up.</p>";
    } else {
      emptyEl.innerHTML =
        '<p><strong>No posts captured yet.</strong></p>' +
        '<p>Open <a href="https://x.com/home" target="_blank" rel="noopener">x.com</a> on the ' +
        '"Following" tab and scroll, or hit 🔄 Sync.</p>';
    }
  }

  // Group the already-sorted posts into days.
  const days = [];
  for (const t of items) {
    const key = dayKey(t.created_at);
    let d = days.length ? days[days.length - 1] : null;
    if (!d || d.key !== key) {
      d = { key, ts: t.created_at, posts: [], allRead: true };
      days.push(d);
    }
    d.posts.push(t);
    if (!t.read) d.allRead = false;
  }

  // Fold fully-read days on the plain timeline view only (not while searching,
  // not in Unread-only, not on Events). Hide read days beyond the current limit.
  const folding = activeTab === 'timeline' && !unreadOnly() && !searchEl.value.trim();
  const hiddenKeys = new Set();
  if (folding) {
    const readDays = days.filter((d) => d.allRead);
    const limit = READ_DAY_LIMITS[readDayLimitIdx];
    if (readDays.length > limit) {
      const keep = new Set(
        readDays
          .slice()
          .sort((a, b) => b.ts - a.ts)
          .slice(0, limit)
          .map((d) => d.key),
      );
      for (const d of readDays) if (!keep.has(d.key)) hiddenKeys.add(d.key);
    }
  }

  const frag = document.createDocumentFragment();
  let readingLinePlaced = false;
  let prevRead = null; // read-state of the previous rendered post (folded/hidden days count as read)

  for (const d of days) {
    if (hiddenKeys.has(d.key)) {
      prevRead = true;
      continue;
    }
    const folded = folding && d.allRead && !unfoldedDays.has(d.key);
    frag.appendChild(dayHeader(d, folded, folding && d.allRead));
    if (folded) {
      prevRead = true;
      continue;
    }
    for (const t of d.posts) {
      // Reading line at the read/unread boundary (asc: first unread after read;
      // desc: first read after unread).
      const boundary = sortAsc ? !t.read && prevRead === true : t.read && prevRead === false;
      if (!readingLinePlaced && boundary) {
        frag.appendChild(readingLine());
        readingLinePlaced = true;
      }
      const thread = document.createElement('div');
      thread.className = 'thread';
      appendThread(thread, t, 0, new Set());
      frag.appendChild(thread);
      prevRead = !!t.read;
    }
  }

  // "+" to reveal more folded read days — before the earliest shown date
  // (top when oldest-first, bottom when newest-first).
  if (hiddenKeys.size > 0) {
    const btn = moreDaysBtn(hiddenKeys.size);
    if (sortAsc) frag.insertBefore(btn, frag.firstChild);
    else frag.appendChild(btn);
  }

  listEl.appendChild(frag);
  restoreScroll(anchor);
  renderEvents();
  updateStats();
}

// A date separator. When `foldable`, it shows a ▸/▾ arrow + read count and
// toggles that day's folded state on click.
function dayHeader(day, folded, foldable) {
  const el = document.createElement('div');
  el.className = 'day-sep' + (foldable ? ' foldable' : '');
  const mid = document.createElement('span');
  mid.className = 'day-sep-mid';
  const label = new Date(day.ts).toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
  if (foldable) {
    const arrow = document.createElement('span');
    arrow.className = 'fold-arrow';
    arrow.textContent = folded ? '▸' : '▾';
    const name = document.createElement('span');
    name.textContent = label;
    const count = document.createElement('span');
    count.className = 'day-count';
    count.textContent = `${day.posts.length} read`;
    mid.append(arrow, name, count);
    el.addEventListener('click', () => {
      if (unfoldedDays.has(day.key)) unfoldedDays.delete(day.key);
      else unfoldedDays.add(day.key);
      render();
    });
  } else {
    mid.textContent = label;
  }
  el.appendChild(mid);
  return el;
}

function moreDaysBtn(n) {
  const el = document.createElement('button');
  el.className = 'more-days';
  el.textContent = `+ show ${n} older read date${n > 1 ? 's' : ''}`;
  el.addEventListener('click', () => {
    if (readDayLimitIdx < READ_DAY_LIMITS.length - 1) readDayLimitIdx++;
    render();
  });
  return el;
}

function updateStats() {
  const timeline = all.filter((t) => !t.nested && mine(t));
  const unread = timeline.filter((t) => !t.read).length;
  const pending = timeline.filter((t) => !t.processed_at).length;
  statsEl.textContent =
    `${timeline.length} posts · ${unread} unread` +
    (pending > 0 ? ` · ${pending} to analyze` : '');
  const analyzeBtn = document.getElementById('analyze');
  if (analyzeBtn) {
    analyzeBtn.textContent = pending > 0 ? `✨ Analyze (${pending})` : '✨ Analyze';
    analyzeBtn.classList.toggle('has-pending', pending > 0);
  }
  document.title = unread > 0 ? `(${unread}) X Digest` : 'X Digest';
  chrome.runtime.sendMessage({ type: 'XD_REFRESH_BADGE' }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Upcoming events section (agenda: events stay visible until their date)
// ---------------------------------------------------------------------------

function renderEvents() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayISO = isoDate(today);

  const q = eventSearchEl.value.trim().toLowerCase();
  const showHidden = !eventUnhiddenOnly(); // "Unhidden only" OFF reveals hidden groups

  let groups = eventGroups.filter(
    (g) =>
      g.account === selectedAccount &&
      // "Unhidden only" ON = the agenda: current (until the END date passes),
      // non-hidden events. OFF reveals everything, including PAST events (folded
      // below) and hidden ones.
      (showHidden || ((g.end_date || g.date) >= todayISO && g.flag !== 'hidden')),
  );
  if (q) {
    groups = groups.filter((g) => {
      const handles = (g.post_ids || []).map((pid) => byId.get(pid)?.screen_name);
      return [g.name, g.venue, g.time, g.date, g.description, ...handles]
        .filter(Boolean)
        .join('\n')
        .toLowerCase()
        .includes(q);
    });
  }
  // Date order (per the sort toggle); within a date, pinned events first.
  groups.sort((a, b) => {
    if (a.date !== b.date) return (a.date < b.date ? -1 : 1) * (eventSortAsc ? 1 : -1);
    return (a.flag === 'pinned' ? 0 : 1) - (b.flag === 'pinned' ? 0 : 1);
  });

  const isPast = (g) => (g.end_date || g.date) < todayISO;
  const upcoming = groups.filter((g) => !isPast(g));
  const past = groups.filter(isPast);

  eventsListEl.textContent = '';
  const upcomingFrag = document.createDocumentFragment();
  for (const g of upcoming) upcomingFrag.appendChild(eventRow(g));
  const pastFrag = past.length ? buildPastEvents(past) : null;

  const frag = document.createDocumentFragment();
  // Oldest-first: past (older) above the agenda; newest-first: agenda above past.
  if (eventSortAsc) {
    if (pastFrag) frag.appendChild(pastFrag);
    frag.appendChild(upcomingFrag);
  } else {
    frag.appendChild(upcomingFrag);
    if (pastFrag) frag.appendChild(pastFrag);
  }
  eventsListEl.appendChild(frag);

  eventsEmptyEl.hidden = upcoming.length + past.length > 0;
  // The tab count is the agenda (upcoming) size, as before — past is history.
  tabEventsEl.textContent = upcoming.length > 0 ? `📅 Events (${upcoming.length})` : '📅 Events';
}

// One event group rendered as a row (shared by the agenda and the past section).
function eventRow(g) {
  const row = document.createElement('div');
  row.className =
    'event-row' +
    (g.status === 'cancelled' || g.status === 'postponed' ? ' event-warn' : '') +
    (g.flag === 'pinned' ? ' event-pinned' : '') +
    (g.flag === 'hidden' ? ' event-hidden' : '');

  const date = document.createElement('div');
  date.className = 'event-date';
  date.textContent = fmtEventRange(g.date, g.end_date);

  const body = document.createElement('div');
  body.className = 'event-body';
  const title = document.createElement('div');
  title.className = 'event-name';
  title.textContent = g.name;
  if (g.status === 'cancelled' || g.status === 'postponed') {
    const badge = document.createElement('span');
    badge.className = 'event-badge';
    badge.textContent = g.status === 'cancelled' ? 'CANCELLED' : 'POSTPONED';
    title.appendChild(badge);
  }
  const meta = document.createElement('div');
  meta.className = 'event-meta';
  meta.textContent = [g.time, g.venue].filter(Boolean).join(' · ');
  body.append(title, meta);
  if (g.description) {
    const detail = document.createElement('div');
    detail.className = 'event-detail';
    detail.textContent = g.description;
    body.appendChild(detail);
  }
  body.appendChild(eventSources(g));

  const actions = document.createElement('div');
  actions.className = 'event-actions';
  actions.append(
    flagBtn(g, 'pinned', '📌', 'Pin — plan to attend'),
    flagBtn(g, 'hidden', '🙈', 'Hide this event'),
  );

  row.append(date, body, actions);
  return row;
}

// Past events (already date-sorted): grouped by date, each date folded by default,
// showing only the most-recent EVENT_PAST_LIMITS[idx] dates with a staggered
// "show older" button — mirroring the Timeline's read-day folding.
function buildPastEvents(past) {
  const frag = document.createDocumentFragment();

  const dates = [];
  for (const g of past) {
    let d = dates.length ? dates[dates.length - 1] : null;
    if (!d || d.key !== g.date) {
      d = { key: g.date, events: [] };
      dates.push(d);
    }
    d.events.push(g);
  }

  // Keep the most-recent N past dates (closest to today); collapse the rest.
  const limit = EVENT_PAST_LIMITS[eventPastLimitIdx];
  const recent = new Set(
    dates
      .slice()
      .sort((a, b) => (a.key < b.key ? 1 : -1))
      .slice(0, limit)
      .map((d) => d.key),
  );
  const hiddenCount = dates.length - recent.size;

  const label = document.createElement('div');
  label.className = 'event-past-label';
  label.textContent = 'Past events';
  frag.appendChild(label);

  for (const d of dates) {
    if (!recent.has(d.key)) continue;
    const folded = !eventUnfoldedDates.has(d.key);
    frag.appendChild(pastDateHeader(d, folded));
    if (!folded) for (const g of d.events) frag.appendChild(eventRow(g));
  }

  if (hiddenCount > 0) {
    const btn = morePastDatesBtn(hiddenCount);
    // Older dates sit at the far (oldest) end: just after the label when
    // oldest-first, at the very bottom when newest-first.
    if (eventSortAsc) frag.insertBefore(btn, frag.childNodes[1] || null);
    else frag.appendChild(btn);
  }
  return frag;
}

// A foldable date header for the past-events section (▸/▾ + event count).
function pastDateHeader(d, folded) {
  const el = document.createElement('div');
  el.className = 'day-sep foldable';
  const mid = document.createElement('span');
  mid.className = 'day-sep-mid';
  const arrow = document.createElement('span');
  arrow.className = 'fold-arrow';
  arrow.textContent = folded ? '▸' : '▾';
  const name = document.createElement('span');
  name.textContent = new Date(`${d.key}T00:00:00`).toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
  const count = document.createElement('span');
  count.className = 'day-count';
  count.textContent = `${d.events.length} event${d.events.length > 1 ? 's' : ''}`;
  mid.append(arrow, name, count);
  el.addEventListener('click', () => {
    if (eventUnfoldedDates.has(d.key)) eventUnfoldedDates.delete(d.key);
    else eventUnfoldedDates.add(d.key);
    renderEvents();
  });
  el.appendChild(mid);
  return el;
}

function morePastDatesBtn(n) {
  const el = document.createElement('button');
  el.className = 'more-days';
  el.textContent = `+ show ${n} older past date${n > 1 ? 's' : ''}`;
  el.addEventListener('click', () => {
    if (eventPastLimitIdx < EVENT_PAST_LIMITS.length - 1) eventPastLimitIdx++;
    renderEvents();
  });
  return el;
}

// Link(s) to every source post backing an event group.
function eventSources(g) {
  const wrap = document.createElement('div');
  wrap.className = 'event-sources';
  const ids = (g.post_ids || []).filter(Boolean);
  if (ids.length <= 1) {
    const b = document.createElement('button');
    b.className = 'action';
    b.textContent = 'View post';
    b.title = 'View post (right-click to open in X)';
    bindEventPostButton(b, ids[0]);
    wrap.appendChild(b);
  } else {
    const label = document.createElement('span');
    label.className = 'src-label';
    label.textContent = `${ids.length} posts:`;
    wrap.appendChild(label);
    ids.forEach((pid, i) => {
      const b = document.createElement('button');
      b.className = 'action src-link';
      b.textContent = String(i + 1);
      b.title = 'View this post (right-click to open in X)';
      bindEventPostButton(b, pid);
      wrap.appendChild(b);
    });
  }
  return wrap;
}

// Pin / hide toggle on an event group (mutually exclusive; clears if re-clicked).
function flagBtn(g, flag, icon, title) {
  const b = document.createElement('button');
  const active = g.flag === flag;
  b.className = `event-flag ${active ? 'active' : ''}`;
  b.textContent = icon;
  b.title = active ? `Remove — ${title}` : title;
  b.addEventListener('click', async () => {
    const prev = g.flag ?? null;
    const next = active ? null : flag;
    await setEventFlag(g.id, next);
    g.flag = next;
    const label = next === 'pinned' ? 'pin event' : next === 'hidden' ? 'hide event' : 'unflag event';
    pushUndo(label, [{ store: 'events', id: g.id, field: 'flag', value: prev }]);
    renderEvents();
  });
  return b;
}

// Wire an Events-tab source-post button: left-click jumps to the post in the
// timeline (never opens X); right-click offers "Open in X".
function bindEventPostButton(b, pid) {
  b.addEventListener('click', () => {
    if (pid) jumpToPost(pid);
  });
  b.addEventListener('contextmenu', (e) => {
    if (!pid) return;
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, [
      { label: 'Open in X', onClick: () => window.open(xPostUrl(pid), '_blank', 'noopener') },
    ]);
  });
}

// X URL for a post id — handle-based when we have the record, else the id-only
// URL X resolves on its own.
function xPostUrl(pid) {
  const t = byId.get(pid);
  return t ? postUrl(t) : `https://x.com/i/status/${pid}`;
}

function jumpToPost(id) {
  expanded.add(id);
  // Show this one post even if "Unread only" is on, without turning the filter off.
  focusExceptionId = id;
  // Reveal the target's day if it's folded (fully-read day collapsed to a header).
  const t = byId.get(id);
  if (t) unfoldedDays.add(dayKey(t.created_at));
  setTab('timeline');
  render();
  // If the day is still hidden behind the read-day limit, grow the limit until
  // the target actually renders (or we run out of days to reveal).
  while (
    !listEl.querySelector(`[data-id="${CSS.escape(id)}"]`) &&
    readDayLimitIdx < READ_DAY_LIMITS.length - 1
  ) {
    readDayLimitIdx++;
    render();
  }
  focusPost(id);
}

// Center a rendered post and flash it. Re-centers a few times as lazy-loaded
// avatars/media above it load and shift the layout, so it settles ON the target.
function focusPost(id) {
  const el = listEl.querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (!el) return;
  const center = () => el.scrollIntoView({ block: 'center' }); // instant
  center();
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1600);
  [80, 200, 400, 700].forEach((ms) => setTimeout(center, ms));
}

// ---------------------------------------------------------------------------
// Element construction
// ---------------------------------------------------------------------------

function readingLine() {
  const el = document.createElement('div');
  el.className = 'reading-line';
  el.textContent = 'you were here';
  return el;
}

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

// Tier is shown via card background (see .tier-* in digest.css), not a badge.

// The ✨ summary box shared by full and collapsed cards: the sparkle marker,
// then the category chip in front for off-topic posts, then the one-line
// summary text.
function summaryBox(t) {
  const box = document.createElement('div');
  box.className = 'llm-summary';

  const spark = document.createElement('span');
  spark.className = 'spark';
  spark.textContent = '✨';
  box.appendChild(spark);

  if (t.category === 'other' && t.theme) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = t.theme;
    box.appendChild(chip);
  }

  const body = document.createElement('span');
  body.className = 'summary-text';
  body.textContent = t.summary;
  box.appendChild(body);
  return box;
}

/**
 * Compact card for tier-3 ("other") posts; click to expand. Two lines:
 * a header (author · like · time · read) and the ✨ summary box below.
 */
function collapsedCard(t, depth = 0) {
  const orig = t.repost_of ? byId.get(t.repost_of) : null;
  const content = orig || t;

  const row = document.createElement('div');
  row.className = `post-collapsed tier-${t.category} ${t.read ? 'read' : 'unread'}`;
  row.dataset.id = t.id;
  row.title = 'Click to expand';
  if (depth > 0) row.style.marginLeft = `${depth * 5}px`;

  const head = document.createElement('div');
  head.className = 'collapsed-head';

  // Repost marker (same signal as full cards, compact): 🔁 with the reposter
  // in the tooltip. The author shown is the original author (content).
  let repost = null;
  if (orig) {
    repost = document.createElement('span');
    repost.className = 'rt-mini';
    repost.textContent = '🔁';
    repost.title = `Reposted by ${t.author_name} (@${t.screen_name}) · right-click to filter to this reposter`;
    // Right-click the repost marker -> filter to the REPOSTER's posts + reposts.
    repost.addEventListener('contextmenu', (ev) => authorMenu(ev, t.screen_name));
  }

  const who = document.createElement('span');
  who.className = 'who-mini';
  who.textContent = content.author_name;
  who.title = 'Right-click to filter to this author';
  who.addEventListener('contextmenu', (ev) => authorMenu(ev, content.screen_name));

  const replyBtn = (childrenById.get(t.id) || []).length ? replyControl(t, content) : null;
  head.append(
    ...(repost ? [repost] : []),
    who,
    ...(replyBtn ? [replyBtn] : []),
    metaCluster(t, content),
  );

  let body;
  if (t.summary) {
    body = summaryBox(t);
  } else {
    body = document.createElement('div');
    body.className = 'gist';
    body.textContent = content.text.replace(/\s+/g, ' ').slice(0, 200);
  }

  row.append(head, body);
  row.addEventListener('click', () => {
    expanded.add(t.id);
    render();
  });
  return row;
}

// Right-aligned metadata cluster (timestamp · like · read check) shared by full
// and collapsed cards, so the three columns line up at identical offsets from
// the right edge. `content` is the post whose like state/count is shown (the
// original for a repost). stopPropagation keeps a like click from expanding a
// collapsed row (harmless on full cards, which have no click handler).
function metaCluster(t, content) {
  const meta = document.createElement('div');
  meta.className = 'meta';

  const when = document.createElement('span');
  when.className = 'when';
  when.textContent = fmtTime(t.created_at);

  const likeBtn = document.createElement('button');
  likeBtn.className = `count like-btn ${content.favorited ? 'liked' : ''}`;
  likeBtn.textContent = `${content.favorite_count} ${content.favorited ? '♥' : '♡'}`;
  likeBtn.title = content.favorited ? 'Unlike on X' : 'Like on X';
  likeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    like(content, likeBtn);
  });

  meta.append(when, likeBtn, readCheck(t));
  return meta;
}

// The 💬 reply affordance. When the post has captured replies it becomes a
// toggle that expands/collapses them; otherwise it's the plain reply count.
// `content` is the count source (the original for a repost). reply_count is X's
// own total, which can exceed the number of replies we actually captured.
function replyControl(t, content) {
  const kids = childrenById.get(t.id) || [];
  if (kids.length === 0) {
    const s = document.createElement('span');
    s.className = 'count';
    s.textContent = `💬 ${content.reply_count}`;
    return s;
  }
  const open = threadOpen.has(t.id);
  const btn = document.createElement('button');
  btn.className = `count reply-toggle ${open ? 'open' : ''}`;
  btn.textContent = `${open ? '▾' : '▸'} 💬 ${content.reply_count}`;
  btn.title = open
    ? 'Hide replies'
    : `Show ${kids.length} captured repl${kids.length > 1 ? 'ies' : 'y'}`;
  btn.addEventListener('click', (e) => {
    e.stopPropagation(); // don't also toggle a collapsed row's expand
    toggleThread(t);
  });
  return btn;
}

// Lightweight, XSS-safe Markdown renderer for LLM translations (headings, bold,
// bullet lists, rules). All text goes in via textContent — never innerHTML — so
// nothing in the model output can inject markup. Anything it doesn't recognize
// (incl. #hashtags, which lack the "# " space) renders as plain text.
function appendInline(el, text) {
  for (const part of String(text).split(/(\*\*[^*]+\*\*)/g)) {
    if (/^\*\*[^*]+\*\*$/.test(part)) {
      const s = document.createElement('strong');
      s.textContent = part.slice(2, -2);
      el.appendChild(s);
    } else if (part) {
      el.appendChild(document.createTextNode(part));
    }
  }
}
function renderMarkdownInto(container, md) {
  let list = null;
  // Drop stray U+FFFD replacement chars (a model occasionally emits one for an
  // emoji it mangled) so they don't show as "�".
  for (const raw of String(md || '').replace(/�/g, '').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    const heading = line.match(/^(#{1,6})\s+(.*)$/); // "# " (a hashtag has no space)
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      if (!list) {
        list = document.createElement('ul');
        list.className = 'md-ul';
        container.appendChild(list);
      }
      const li = document.createElement('li');
      appendInline(li, bullet[1]);
      list.appendChild(li);
      continue;
    }
    list = null;
    if (heading) {
      const el = document.createElement('div');
      el.className = 'md-h';
      appendInline(el, heading[2]);
      container.appendChild(el);
    } else if (/^\s*---+\s*$/.test(line)) {
      container.appendChild(document.createElement('hr'));
    } else if (line.trim() !== '') {
      const p = document.createElement('div');
      p.className = 'md-p';
      appendInline(p, line);
      container.appendChild(p);
    }
    // blank line -> paragraph gap via block margins
  }
}

function postCard(t, depth = 0) {
  // For a repost, show the original's content if we captured it
  const orig = t.repost_of ? byId.get(t.repost_of) : null;
  const content = orig || t;
  const quoted = content.quoted_id ? byId.get(content.quoted_id) : null;

  const card = document.createElement('article');
  card.className = `post tier-${t.category || 'none'} ${t.read ? 'read' : 'unread'}`;
  card.dataset.id = t.id;
  if (depth > 0) card.style.marginLeft = `${depth * 5}px`;

  if (orig) {
    const note = document.createElement('div');
    note.className = 'rt-note';
    note.textContent = `🔁 Reposted by ${t.author_name} (@${t.screen_name})`;
    note.title = 'Right-click to filter to this reposter';
    // Right-click the repost line -> filter to the REPOSTER's posts + reposts.
    note.addEventListener('contextmenu', (ev) => authorMenu(ev, t.screen_name));
    card.appendChild(note);
  }

  // Header: avatar, author, date (the theme chip for off-topic posts now lives
  // in the summary box below, and the tier is shown via the card background).
  const head = document.createElement('div');
  head.className = 'post-head';
  const avatar = document.createElement('img');
  avatar.className = 'avatar';
  avatar.alt = '';
  if (content.avatar) {
    avatar.dataset.src = content.avatar; // lazy: loaded when scrolled into view
    avatarObserver.observe(avatar);
  }
  const who = document.createElement('div');
  who.className = 'who';
  who.innerHTML = `<span class="name">${esc(content.author_name)}</span><span class="handle">@${esc(content.screen_name)}</span>`;
  who.title = 'Right-click to filter to this author';
  who.addEventListener('contextmenu', (ev) => authorMenu(ev, content.screen_name));
  head.append(avatar, who);
  head.appendChild(metaCluster(t, content)); // timestamp · like · read check
  card.appendChild(head);

  // LLM enrichment: event line + summary
  if (t.event) {
    const evEl = document.createElement('div');
    evEl.className = `llm-event ${t.event.status === 'cancelled' || t.event.status === 'postponed' ? 'warn' : ''}`;
    evEl.textContent =
      `📅 ${t.event.name}` +
      (t.event.date ? ` — ${fmtEventDate(t.event.date)}` : '') +
      (t.event.time ? ` ${t.event.time}` : '') +
      (t.event.venue ? ` · ${t.event.venue}` : '') +
      (t.event.status === 'cancelled' ? ' — CANCELLED' : '') +
      (t.event.status === 'postponed' ? ' — POSTPONED' : '');
    card.appendChild(evEl);
  }
  if (t.summary) {
    card.appendChild(summaryBox(t));
  }

  // Text
  const textEl = document.createElement('div');
  textEl.className = 'post-text';
  textEl.innerHTML = richText(content);
  card.appendChild(textEl);

  // Translation block (if already fetched) — rendered as lightweight Markdown.
  if (t.translation) {
    const trEl = document.createElement('div');
    trEl.className = 'llm-translation';
    renderMarkdownInto(trEl, t.translation);
    card.appendChild(trEl);
  }

  // Quoted post
  if (quoted) {
    const qEl = document.createElement('div');
    qEl.className = 'quoted';
    qEl.innerHTML = `<div class="who-inline">${esc(quoted.author_name)} @${esc(quoted.screen_name)}</div><div class="post-text">${richText(quoted)}</div>`;
    card.appendChild(qEl);
  }

  // Media
  const mediaList = (content.media || []).filter((m) => m.url);
  if (mediaList.length > 0) {
    const mediaEl = document.createElement('div');
    mediaEl.className = 'media';
    for (const m of mediaList) {
      const a = document.createElement('a');
      a.href = m.type === 'photo' ? `${m.url}?name=large` : postUrl(content);
      a.target = '_blank';
      a.rel = 'noopener';
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.src = `${m.url}?name=small`;
      img.alt = m.type;
      a.appendChild(img);
      if (m.type !== 'photo') {
        const play = document.createElement('span');
        play.className = 'play';
        play.textContent = '▶';
        a.appendChild(play);
      }
      mediaEl.appendChild(a);
    }
    card.appendChild(mediaEl);
  }

  // Footer, left to right: replies/reposts (left) · translate (center) ·
  // Open on X (right). Like now lives in the header.
  const foot = document.createElement('div');
  foot.className = 'post-foot';

  const counts = document.createElement('span');
  counts.className = 'counts-mid';
  const reposts = document.createElement('span');
  reposts.className = 'count';
  reposts.textContent = `🔁 ${content.repost_count}`;
  counts.append(replyControl(t, content), reposts);

  const btnTranslate = document.createElement('button');
  btnTranslate.className = `count translate-btn ${t.translation ? 'translated' : ''}`;
  btnTranslate.textContent = '🌐';
  btnTranslate.title =
    (t.translation ? 'Re-translate' : 'Translate') + ' (reads attached images too)';
  btnTranslate.addEventListener('click', () => translate(t, content, btnTranslate));

  const linkX = document.createElement('a');
  linkX.className = 'action';
  linkX.href = postUrl(content);
  linkX.target = '_blank';
  linkX.rel = 'noopener';
  linkX.textContent = 'Open on X ↗';

  foot.append(counts, spacer(), btnTranslate, spacer(), linkX);
  card.appendChild(foot);
  return card;
}

function spacer() {
  const s = document.createElement('span');
  s.className = 'spacer';
  return s;
}

/**
 * The ✓ read control shared by collapsed rows and full cards.
 * Left-click toggles this post's read state; right-click opens a context menu
 * with "Read up to here" (mark this post and all older ones as read).
 */
function readCheck(t) {
  const check = document.createElement('button');
  check.className = 'collapsed-check';
  check.textContent = '✓';
  check.title = (t.read ? 'Mark unread' : 'Mark read') + ' · right-click for more';
  check.addEventListener('click', async (e) => {
    e.stopPropagation(); // don't expand a collapsed row
    const prev = t.read ? 1 : 0;
    await toggleRead(t.id);
    pushUndo(prev ? 'mark unread' : 'mark read', [{ id: t.id, field: 'read', value: prev }]);
    await load();
  });
  check.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showContextMenu(e.clientX, e.clientY, [
      {
        label: '✓ Read up to here',
        onClick: async () => {
          const ids = await markReadUpTo(t.created_at, selectedAccount);
          pushUndo(
            `mark ${ids.length} read`,
            ids.map((id) => ({ id, field: 'read', value: 0 })),
          );
          await load();
        },
      },
    ]);
  });
  return check;
}

// ---------------------------------------------------------------------------
// Lightweight context menu (used by the ✓ read control)
// ---------------------------------------------------------------------------

let ctxMenuEl = null;

function showContextMenu(x, y, items) {
  hideContextMenu();
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  for (const it of items) {
    if (it.header) {
      const h = document.createElement('div');
      h.className = 'ctx-header';
      h.textContent = it.label;
      menu.appendChild(h);
      continue;
    }
    const b = document.createElement('button');
    b.className = 'ctx-item';
    b.textContent = it.label;
    b.addEventListener('click', async () => {
      hideContextMenu();
      await it.onClick();
    });
    menu.appendChild(b);
  }
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  document.body.appendChild(menu);
  ctxMenuEl = menu;
  // Keep it on screen
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = `${x - rect.width}px`;
  if (rect.bottom > window.innerHeight) menu.style.top = `${y - rect.height}px`;
}

function hideContextMenu() {
  if (ctxMenuEl) {
    ctxMenuEl.remove();
    ctxMenuEl = null;
  }
}

document.addEventListener('click', hideContextMenu);
document.addEventListener('scroll', hideContextMenu, true);

// ---------------------------------------------------------------------------
// LLM actions
// ---------------------------------------------------------------------------

async function like(content, btn) {
  const on = !content.favorited; // toggle target
  btn.disabled = true;
  try {
    const resp = await chrome.runtime.sendMessage({
      type: 'XD_LIKE',
      postId: content.id,
      accountId: selectedAccount,
      on,
    });
    if (!resp || resp.error) throw new Error(resp?.error || 'No response');
    content.favorited = on;
    const delta = resp.already ? 0 : on ? 1 : -1;
    content.favorite_count = Math.max(0, (content.favorite_count || 0) + delta);
    await saveLLMResults(
      new Map([
        [content.id, { favorited: on, favorite_count: content.favorite_count }],
      ]),
    );
    render();
  } catch (e) {
    btn.disabled = false;
    btn.title = e.message;
    pipelineStatusEl.textContent = `Like failed: ${e.message}`;
  }
}

async function translate(t, content, btn) {
  const settings = await loadGlobal();
  if (!settings.apiKey) {
    chrome.runtime.openOptionsPage();
    return;
  }
  btn.disabled = true;
  btn.textContent = '⏳';
  try {
    const translation = await translatePost(settings, {
      id: content.id,
      author: content.screen_name,
      text: content.text,
      created_at: content.created_at,
      images: (content.media || [])
        .filter((m) => m.type === 'photo' && m.url)
        .map((m) => m.url),
    });
    await saveLLMResults(new Map([[t.id, { translation }]]));
    t.translation = translation;
    render();
  } catch (e) {
    btn.textContent = '🌐';
    btn.title = `Translation failed: ${e.message}`;
    btn.disabled = false;
  }
}

/**
 * Re-analyze a subset of this account's already-analyzed posts (per `opts`),
 * plus every post that was never analyzed (the pipeline always picks those up).
 * opts: { onlyOther, onlyUnread }.
 */
async function reanalyze(opts) {
  if (!selectedAccount) {
    pipelineStatusEl.textContent = 'No account enabled.';
    return;
  }
  focusExceptionId = null; // Analyze drops the jumped-to exception
  const global = await loadGlobal();
  if (!global.apiKey) {
    chrome.runtime.openOptionsPage();
    return;
  }
  const redo = clearedCount(opts);
  const fresh = all.filter((t) => !t.nested && mine(t) && !t.processed_at).length;
  const total = redo + fresh;
  if (total === 0) {
    pipelineStatusEl.textContent = 'Nothing to analyze.';
    return;
  }
  if (
    !confirm(
      `Re-analyze ${redo} already-analyzed post(s)` +
        (fresh ? ` and analyze ${fresh} new one(s)` : '') +
        ` — ${total} total. This re-spends API tokens. Continue?`,
    )
  ) {
    return;
  }
  await clearAnalysis(selectedAccount, opts);
  await load();
  await analyze({ skipConfirm: true });
}

/** How many already-analyzed posts a given re-analyze option would redo. */
function clearedCount({ onlyOther = false, onlyUnread = false, onlyEvents = false } = {}) {
  return all.filter(
    (t) =>
      !t.nested &&
      mine(t) &&
      t.processed_at &&
      (!onlyOther || t.category === 'other') &&
      (!onlyUnread || !t.read) &&
      (!onlyEvents || !!t.event),
  ).length;
}

async function analyze({ skipConfirm = false } = {}) {
  const global = await loadGlobal();
  if (!global.apiKey) {
    chrome.runtime.openOptionsPage();
    return;
  }
  if (!selectedAccount) {
    pipelineStatusEl.textContent = 'No account enabled.';
    return;
  }
  const config = accountConfig(global, accounts[selectedAccount]);
  const pending = all.filter((t) => !t.nested && mine(t) && !t.processed_at).length;
  // pending === 0 still runs the pipeline: it re-groups events (and backfills
  // legacy events on the first Analyze after the v4 upgrade). Only confirm when
  // there are actually posts to extract.
  if (pending > 0 && !skipConfirm &&
      !confirm(`Analyze ${pending} posts with the Claude API (${config.model})?`)) {
    return;
  }

  const btn = document.getElementById('analyze');
  btn.disabled = true;
  try {
    const result = await runPipeline(config, selectedAccount, (msg) => {
      pipelineStatusEl.textContent = msg;
    });
    if (result.errors?.length > 0) {
      console.warn('[X Digest] pipeline errors:', result.errors);
      pipelineStatusEl.title = result.errors.join('\n');
    }
  } catch (e) {
    pipelineStatusEl.textContent = `Pipeline failed: ${e.message}`;
  } finally {
    btn.disabled = false;
    await load();
  }
}

// Expand/collapse a post's captured replies. On expand, any revealed reply that
// hasn't been analyzed yet is run through the pipeline (restricted to those
// ids); threadOpen persists across the reload so the thread stays open.
async function toggleThread(t) {
  if (threadOpen.has(t.id)) {
    threadOpen.delete(t.id);
    render();
    return;
  }
  threadOpen.add(t.id);
  render(); // reveal immediately; unanalyzed replies render raw until analyzed

  const pending = (childrenById.get(t.id) || [])
    .filter((k) => !k.processed_at)
    .map((k) => k.id);
  if (pending.length === 0) return;

  const global = await loadGlobal();
  if (!global.apiKey || !selectedAccount) return; // no key: leave replies raw
  const config = accountConfig(global, accounts[selectedAccount]);
  try {
    await runPipeline(
      config,
      selectedAccount,
      (msg) => {
        pipelineStatusEl.textContent = msg;
      },
      { onlyIds: new Set(pending) },
    );
  } catch (e) {
    pipelineStatusEl.textContent = `Reply analysis failed: ${e.message}`;
  } finally {
    await load();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function postUrl(t) {
  return `https://x.com/${t.screen_name}/status/${t.id}`;
}

function fmtTime(ts) {
  return new Date(ts).toLocaleString('en-GB', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function fmtEventDate(iso) {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

// Single day -> "Fri 14 Aug"; multi-day -> "14–16 Aug" / "14 Aug – 3 Sep".
function fmtEventRange(start, end) {
  if (!end || end === start) return fmtEventDate(start);
  const s = new Date(`${start}T00:00:00`);
  const e = new Date(`${end}T00:00:00`);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return fmtEventDate(start);
  const sameMonth = s.getFullYear() === e.getFullYear() && s.getMonth() === e.getMonth();
  if (sameMonth) {
    return `${s.getDate()}–${e.getDate()} ${e.toLocaleDateString('en-GB', { month: 'short' })}`;
  }
  const opt = { day: 'numeric', month: 'short' };
  return `${s.toLocaleDateString('en-GB', opt)} – ${e.toLocaleDateString('en-GB', opt)}`;
}

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Rich text: escapes HTML, strips media t.co links,
 * replaces remaining t.co links with their readable, clickable URL.
 */
function richText(t) {
  let html = esc(t.text);
  for (const short of t.media_short_urls || []) {
    html = html.replaceAll(esc(short), '');
  }
  for (const u of t.urls || []) {
    if (!u.short) continue;
    const anchor = `<a href="${esc(u.expanded || u.short)}" target="_blank" rel="noopener">${esc(u.display || u.expanded || u.short)}</a>`;
    html = html.replaceAll(esc(u.short), anchor);
  }
  return html.trim();
}

// ---------------------------------------------------------------------------
// Global events
// ---------------------------------------------------------------------------

let reloadTimer = null;
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'XD_STORED') {
    // Batch capture bursts during scrolling
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(load, 800);
  }
  if (msg?.type === 'XD_SYNC_PROGRESS') {
    pipelineStatusEl.textContent = 'Syncing…';
  }
  if (msg?.type === 'XD_SYNC_DONE') {
    finishSync(msg);
  }
});

// ---------------------------------------------------------------------------
// Sync: drive x.com from the service worker, then report the net new posts.
// ---------------------------------------------------------------------------

let syncStartCount = null;
const syncBtn = document.getElementById('sync');

// `floorTs` (optional) overrides the default stop: force the sync back to this
// timestamp instead of the last-sync boundary. Set from the right-click menu.
async function startSync(floorTs) {
  if (!selectedAccount) {
    pipelineStatusEl.textContent = 'Enable an account first (Settings).';
    return;
  }
  syncStartCount = all.filter((t) => !t.nested && mine(t)).length;
  syncBtn.disabled = true;
  pipelineStatusEl.textContent = floorTs
    ? `Sync: opening x.com (back to ${new Date(floorTs).toLocaleString()})…`
    : 'Sync: opening x.com…';
  try {
    const r = await chrome.runtime.sendMessage({
      type: 'XD_SYNC',
      accountId: selectedAccount,
      floorTs: floorTs || undefined,
    });
    if (r?.error) {
      pipelineStatusEl.textContent = `Sync failed: ${r.error}`;
      syncBtn.disabled = false;
    }
  } catch (e) {
    pipelineStatusEl.textContent = `Sync failed: ${e.message}`;
    syncBtn.disabled = false;
  }
}

// Right-click Sync: presets + a custom date/time to force a further-back sync.
// The persisted "caught up to" timestamp for this account (0 if unset). Seeded
// to the first-digest-open time; only advanced by a completed Sync.
async function readSyncBoundary(accountId) {
  const { syncBoundary = {} } = await chrome.storage.local.get({ syncBoundary: {} });
  return syncBoundary[accountId] || 0;
}

async function syncMenu(x, y) {
  const day = 86400000;
  const now = Date.now();
  const boundary = await readSyncBoundary(selectedAccount);
  const label = boundary ? new Date(boundary).toLocaleString() : 'not set';
  showContextMenu(x, y, [
    { header: true, label: `Synced up to: ${label}` },
    { label: '🔄 Sync back 24 hours', onClick: () => startSync(now - day) },
    { label: '🔄 Sync back 3 days', onClick: () => startSync(now - 3 * day) },
    { label: '🔄 Sync back 7 days', onClick: () => startSync(now - 7 * day) },
    { label: '⏱ Sync back to date/time…', onClick: () => syncDatePicker(x, y, boundary) },
  ]);
}

// Small popover with a datetime-local input (interpreted in local time, as X does).
function syncDatePicker(x, y, defaultTs) {
  hideContextMenu();
  const box = document.createElement('div');
  box.className = 'ctx-menu date-pop';
  box.style.left = `${x}px`;
  box.style.top = `${y}px`;

  const input = document.createElement('input');
  input.type = 'datetime-local';
  // Default to the sync boundary (falls back to 1 day ago if somehow unset).
  const d = new Date(defaultTs || Date.now() - 86400000);
  const pad = (n) => String(n).padStart(2, '0');
  input.value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

  const go = document.createElement('button');
  go.className = 'btn';
  go.textContent = 'Sync from here';
  go.addEventListener('click', () => {
    const ts = input.value ? new Date(input.value).getTime() : NaN;
    box.remove();
    if (!Number.isNaN(ts)) startSync(ts);
  });

  box.append(input, go);
  box.addEventListener('click', (e) => e.stopPropagation()); // don't self-dismiss
  document.body.appendChild(box);
  input.focus();

  // Dismiss on an outside click (deferred so the opening click doesn't count).
  setTimeout(() => {
    const dismiss = (e) => {
      if (!box.contains(e.target)) {
        box.remove();
        document.removeEventListener('click', dismiss);
      }
    };
    document.addEventListener('click', dismiss);
  }, 0);
}

async function finishSync(msg) {
  syncBtn.disabled = false;
  await load();
  if (msg.error) {
    pipelineStatusEl.textContent = `Sync: ${msg.error}`;
    return;
  }
  const now = all.filter((t) => !t.nested && mine(t)).length;
  const added = Math.max(0, now - (syncStartCount ?? now));
  const reasonLabel =
    {
      'caught-up': 'caught up',
      'end-of-feed': 'reached the feed end',
      'no-new': 'already up to date',
      stopped: 'stopped',
      cap: 'hit the safety limit',
    }[msg.reason] || msg.reason;
  pipelineStatusEl.textContent = `Sync done — ${added} new post${added === 1 ? '' : 's'} (${reasonLabel}).`;
}

syncBtn.addEventListener('click', () => startSync());
syncBtn.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  syncMenu(e.clientX, e.clientY);
});

// Pick up settings changes (accounts enabled/disabled, criteria edits) live
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.accounts) {
    initAccounts().then(load);
  }
});

const searchClearEl = document.getElementById('search-clear');
function updateSearchClear() {
  searchClearEl.hidden = !searchEl.value;
}
searchEl.addEventListener('input', () => {
  localStorage.setItem('bd-search', searchEl.value);
  updateSearchClear();
  render();
});
searchEl.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && searchEl.value) {
    e.preventDefault();
    clearSearch();
  }
});
// Right-click the search box WHILE searching -> mark every matching (unread) post
// as read in one undoable action. With no query the native menu (paste, …) is
// left alone, so this can't mark the whole timeline read by accident.
searchEl.addEventListener('contextmenu', (e) => {
  if (!searchEl.value.trim()) return;
  const unread = visiblePosts().filter((t) => !t.read);
  if (!unread.length) return;
  e.preventDefault();
  const n = unread.length;
  showContextMenu(e.clientX, e.clientY, [
    {
      label: `✓ Mark ${n} matching post${n > 1 ? 's' : ''} read`,
      onClick: async () => {
        const ids = unread.map((t) => t.id);
        await applyFieldUpdates(ids.map((id) => ({ id, field: 'read', value: 1 })));
        pushUndo(
          `mark ${n} read`,
          ids.map((id) => ({ id, field: 'read', value: 0 })),
        );
        await load();
      },
    },
  ]);
});
searchClearEl.addEventListener('click', () => {
  clearSearch();
  searchEl.focus();
});
function clearSearch() {
  searchEl.value = '';
  localStorage.setItem('bd-search', '');
  updateSearchClear();
  render();
}
onlyUnreadEl.addEventListener('click', () => {
  setUnreadOnly(!unreadOnly());
  resetFolding(); // "reset when clicking Unread only"
  render();
});
sortOrderEl.addEventListener('click', () => {
  sortAsc = !sortAsc;
  localStorage.setItem('bd-sort-asc', sortAsc ? '1' : '');
  sortOrderEl.textContent = sortAsc ? 'Oldest first' : 'Newest first';
  focusExceptionId = null; // sort change drops the jumped-to exception
  render();
});

// Events-tab controls (own state; re-render just the events list).
eventSearchEl.addEventListener('input', () => {
  localStorage.setItem('bd-event-search', eventSearchEl.value);
  renderEvents();
});
eventUnhiddenEl.addEventListener('click', () => {
  const on = !eventUnhiddenOnly();
  eventUnhiddenEl.setAttribute('aria-pressed', on ? 'true' : 'false');
  localStorage.setItem('bd-event-unhidden', on ? '1' : '');
  resetEventFolding(); // start the past section collapsed each time it's revealed
  renderEvents();
});
eventSortEl.addEventListener('click', () => {
  eventSortAsc = !eventSortAsc;
  localStorage.setItem('bd-event-sort-asc', eventSortAsc ? '1' : '');
  eventSortEl.textContent = eventSortAsc ? 'Oldest first' : 'Newest first';
  renderEvents();
});
document.getElementById('refresh').addEventListener('click', () => {
  focusExceptionId = null; // the Refresh button drops the jumped-to exception
  load();
});
document.getElementById('analyze').addEventListener('click', () => analyze());
document.getElementById('analyze').addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (!selectedAccount) return;
  // "Off-theme" = tier-3 "other" posts (matched neither full-detail nor summary
  // themes). Counts show how many already-analyzed posts each option would redo.
  showContextMenu(e.clientX, e.clientY, [
    {
      label: `↻ Re-analyze event posts only (${clearedCount({ onlyEvents: true })})`,
      onClick: () => reanalyze({ onlyEvents: true }),
    },
    {
      label: `↻ Re-analyze all posts (${clearedCount()})`,
      onClick: () => reanalyze({}),
    },
    {
      label: `↻ Re-analyze off-theme posts (${clearedCount({ onlyOther: true })})`,
      onClick: () => reanalyze({ onlyOther: true }),
    },
    {
      label: `↻ Re-analyze unread posts (${clearedCount({ onlyUnread: true })})`,
      onClick: () => reanalyze({ onlyUnread: true }),
    },
    {
      label: `↻ Re-analyze unread off-theme posts (${clearedCount({ onlyOther: true, onlyUnread: true })})`,
      onClick: () => reanalyze({ onlyOther: true, onlyUnread: true }),
    },
  ]);
});
document.getElementById('open-settings').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});
document.getElementById('unread-since-btn').addEventListener('click', async () => {
  const value = document.getElementById('unread-since').value;
  if (!value) return;
  const ts = new Date(value).getTime();
  if (Number.isNaN(ts)) return;
  const ids = await markUnreadSince(ts, selectedAccount);
  pushUndo(`mark ${ids.length} unread`, ids.map((id) => ({ id, field: 'read', value: 1 })));
  pipelineStatusEl.textContent = `${ids.length} posts marked unread.`;
  await load();
});

undoBtn.addEventListener('click', undoLast);
document.addEventListener('keydown', (e) => {
  // Ctrl/⌘+Z undoes the last mark action, unless the user is editing a field.
  const tag = document.activeElement?.tagName;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && tag !== 'INPUT' && tag !== 'TEXTAREA') {
    e.preventDefault();
    undoLast();
  }
});

tabTimelineEl.addEventListener('click', () => setTab('timeline'));
tabEventsEl.addEventListener('click', () => setTab('events'));

accountEl.addEventListener('change', async () => {
  selectedAccount = accountEl.value;
  localStorage.setItem('bd-account', selectedAccount);
  seedSyncBoundary(selectedAccount);
  expanded.clear();
  resetFolding();
  resetEventFolding();
  undoStack.length = 0;
  updateUndoBtn();
  await refreshEventGroups(); // ensure/singleton-backfill for the newly selected account
  render();
});

// Restore UI state
searchEl.value = localStorage.getItem('bd-search') || '';
updateSearchClear();
setUnreadOnly(localStorage.getItem('bd-only-unread') === '1');
sortAsc = (localStorage.getItem('bd-sort-asc') ?? '1') === '1';
sortOrderEl.textContent = sortAsc ? 'Oldest first' : 'Newest first';

eventSearchEl.value = localStorage.getItem('bd-event-search') || '';
if (localStorage.getItem('bd-event-unhidden') !== null) {
  eventUnhiddenEl.setAttribute(
    'aria-pressed',
    localStorage.getItem('bd-event-unhidden') === '1' ? 'true' : 'false',
  );
}
eventSortAsc = (localStorage.getItem('bd-event-sort-asc') ?? '1') === '1';
eventSortEl.textContent = eventSortAsc ? 'Oldest first' : 'Newest first';

setTab(localStorage.getItem('bd-tab') === 'events' ? 'events' : 'timeline');

initAccounts().then(load);
