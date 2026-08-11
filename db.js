// db.js — IndexedDB access, shared by background.js and digest.js (same extension origin).
// Schema v3: store "posts", key = post id (snowflake, string).
// The read field is 0/1 (booleans are not valid IndexedDB index keys).
// `accounts` is the list of X user ids whose timeline captured the post
// (multiEntry index; rows from before v2 have no accounts field until adopted).
// v3 migrates the v1/v2 "tweets" store -> "posts" and renames the record fields
// retweet_count/is_retweet/retweet_of -> repost_count/is_repost/repost_of.

const DB_NAME = 'x-digest';
const DB_VERSION = 4;
const STORE = 'posts';
const EVENTS = 'events'; // v4: clustered event groups (one record per real-world event)

// Fields the capture pipeline must never overwrite (user state / LLM pipeline results)
const PROTECTED_FIELDS = [
  'read',
  'captured_at',
  'category',      // LLM tier: 'full' | 'summary' | 'other'
  'theme',         // 1-3 word theme label
  'summary',       // one-line or detailed summary in the output language
  'event',         // structured event { name, date, time, venue, status } or null
  'translation',   // on-demand full translation
  'processed_at',  // timestamp of the LLM pipeline run
  'event_hidden',  // legacy per-post hide (v4 migrates flags to the event group)
  'event_group_id',// v4: the event group this post's event belongs to
];

let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const upgradeTx = req.transaction; // active versionchange transaction

      // Fresh install: create the posts store directly.
      if (!db.objectStoreNames.contains('tweets') && !db.objectStoreNames.contains(STORE)) {
        createStore(db);
      } else if (db.objectStoreNames.contains('tweets') && !db.objectStoreNames.contains(STORE)) {
        // v1/v2 -> v3: copy the old "tweets" store into "posts", renaming the
        // retweet_* fields, then drop the old store.
        const posts = createStore(db);
        const oldStore = upgradeTx.objectStore('tweets');
        oldStore.openCursor().onsuccess = (e) => {
          const cursor = e.target.result;
          if (cursor) {
            posts.put(renameLegacyFields(cursor.value));
            cursor.continue();
          } else {
            db.deleteObjectStore('tweets');
          }
        };
      }
      // v3 -> v4 (and fresh installs): the event-groups store. Empty; populated
      // lazily by ensureEventGroups() + the clustering pipeline.
      if (!db.objectStoreNames.contains(EVENTS)) createEventsStore(db);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function createStore(db) {
  const store = db.createObjectStore(STORE, { keyPath: 'id' });
  store.createIndex('created_at', 'created_at');
  store.createIndex('read', 'read');
  store.createIndex('screen_name', 'screen_name');
  store.createIndex('accounts', 'accounts', { multiEntry: true });
  return store;
}

// Event group: { id, account, date, name, venue, time, status, description,
//                flag: 'pinned'|'hidden'|null, post_ids: [id], updated_at }
function createEventsStore(db) {
  const s = db.createObjectStore(EVENTS, { keyPath: 'id' });
  s.createIndex('date', 'date');
  s.createIndex('account', 'account');
  return s;
}

function renameLegacyFields(rec) {
  const m = { ...rec };
  if ('retweet_count' in m) { m.repost_count = m.retweet_count; delete m.retweet_count; }
  if ('is_retweet' in m) { m.is_repost = m.is_retweet; delete m.is_retweet; }
  if ('retweet_of' in m) { m.repost_of = m.retweet_of; delete m.retweet_of; }
  return m;
}

function tx(db, mode) {
  return db.transaction(STORE, mode).objectStore(STORE);
}

/**
 * Insert or update a batch of posts captured under `accountId`.
 * - New post: read=0, captured_at=now, accounts=[accountId].
 * - Existing post: refresh counters, favorited, text, media… while preserving
 *   protected fields (read, captured_at, LLM fields) and accumulating accounts.
 * `opts.updateOnly` (used for refresh-on-browse): update EXISTING posts only —
 * never insert — and DON'T re-tag accounts (a mere view shouldn't pull a post
 * into another account's digest). Returns { added, updated }.
 */
export async function putPosts(posts, accountId, opts = {}) {
  const updateOnly = !!opts.updateOnly;
  const db = await openDB();
  const now = Date.now();
  let added = 0;
  let updated = 0;

  await new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite');
    const store = transaction.objectStore(STORE);

    for (const t of posts) {
      if (!t || !t.id) continue;
      const getReq = store.get(t.id);
      getReq.onsuccess = () => {
        const existing = getReq.result;
        if (existing) {
          const merged = { ...existing, ...t, updated_at: now };
          for (const f of PROTECTED_FIELDS) {
            if (existing[f] !== undefined) merged[f] = existing[f];
          }
          // Never downgrade a timeline-level entry to a nested one
          if (existing.nested === false) merged.nested = false;
          if (updateOnly) {
            merged.accounts = existing.accounts; // refresh-only: leave attribution untouched
            // ...and never PROMOTE a nested reference record either. A quoted post
            // (or a repost's original) is stored nested and hidden; viewing it on
            // its own page returns it at top level, which would otherwise flip
            // `nested` to false and make it appear in the digest as a brand-new
            // unanalyzed post. A refresh must never change what the digest SHOWS —
            // only the home feed or an explicit like may do that.
            merged.nested = existing.nested;
          } else {
            const accounts = new Set(existing.accounts || []);
            if (accountId) accounts.add(accountId);
            merged.accounts = [...accounts];
          }
          store.put(merged);
          updated++;
        } else if (!updateOnly) {
          store.put({
            ...t,
            read: 0,
            captured_at: now,
            updated_at: now,
            accounts: accountId ? [accountId] : [],
          });
          added++;
        }
        // updateOnly && !existing → skip (never insert)
      };
    }
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });

  return { added, updated };
}

const belongsTo = (t, accountId) =>
  !accountId || (t.accounts || []).includes(accountId);

export async function getAllPosts() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = tx(db, 'readonly').getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

/** Restore records verbatim (import/backup): put each by id, overwriting. */
export async function bulkPut(records) {
  const db = await openDB();
  const valid = (records || []).filter((r) => r && r.id);
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite');
    const store = transaction.objectStore(STORE);
    for (const r of valid) store.put(r);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  return valid.length;
}

/** Unread timeline entries belonging to any of `accountIds` (for the badge). */
export async function countUnread(accountIds) {
  // Count only timeline entries: nested records (quoted posts / repost
  // originals kept as reference data) are not shown in the digest list.
  const ids = new Set(accountIds || []);
  if (ids.size === 0) return 0;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    let n = 0;
    const cursorReq = tx(db, 'readonly').index('read').openCursor(IDBKeyRange.only(0));
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor) {
        resolve(n);
        return;
      }
      const t = cursor.value;
      if (!t.nested && (t.accounts || []).some((a) => ids.has(a))) n++;
      cursor.continue();
    };
    cursorReq.onerror = () => reject(cursorReq.error);
  });
}

/**
 * Mark as read all of `accountId`'s posts with created_at <= threshold
 * (all accounts when accountId is falsy). Returns the ids actually flipped.
 */
export async function markReadUpTo(threshold, accountId) {
  const db = await openDB();
  const ids = []; // the posts actually flipped (for undo)
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite');
    const index = transaction.objectStore(STORE).index('read');
    const cursorReq = index.openCursor(IDBKeyRange.only(0));
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor) return;
      const t = cursor.value;
      if (t.created_at <= threshold && belongsTo(t, accountId)) {
        t.read = 1;
        cursor.update(t);
        ids.push(t.id);
      }
      cursor.continue();
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  return ids;
}

/**
 * Read-modify-write a single record by id. `mutate(record)` mutates it in place
 * and its return value is what the promise resolves with (e.g. the new state).
 * Resolves null if the record doesn't exist.
 */
async function updateRecord(id, mutate) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite');
    const store = transaction.objectStore(STORE);
    const getReq = store.get(id);
    let result = null;
    getReq.onsuccess = () => {
      const rec = getReq.result;
      if (!rec) return;
      result = mutate(rec);
      store.put(rec);
    };
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error);
  });
}

/** Toggle a post's read state. Returns the new state (0/1). */
export async function toggleRead(id) {
  return updateRecord(id, (t) => (t.read = t.read ? 0 : 1));
}

/**
 * Reflect a like/unlike observed natively on x.com onto an EXISTING post
 * (no-op if we don't have it — nothing is inserted, so no duplicate rows).
 * Optimistic count nudge; the exact count self-corrects on the next capture.
 * Returns true if the state changed, false if already in that state, null if absent.
 */
export async function applyLike(id, on) {
  return updateRecord(id, (t) => {
    if (!!t.favorited === !!on) return false;
    t.favorited = !!on;
    t.favorite_count = Math.max(0, (t.favorite_count || 0) + (on ? 1 : -1));
    return true;
  });
}

/**
 * Restore fields in one transaction (for undo). `updates`: [{id, field, value,
 * store?}] — `store` is 'posts' (default) or 'events', so undo spans both.
 */
export async function applyFieldUpdates(updates) {
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE, EVENTS], 'readwrite');
    for (const u of updates) {
      const store = transaction.objectStore(u.store === 'events' ? EVENTS : STORE);
      const getReq = store.get(u.id);
      getReq.onsuccess = () => {
        const rec = getReq.result;
        if (!rec) return;
        rec[u.field] = u.value;
        store.put(rec);
      };
    }
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  return updates.length;
}

// ---------------------------------------------------------------------------
// Event groups (v4)
// ---------------------------------------------------------------------------

let idSeq = 0;
const newGroupId = () => `g${Date.now().toString(36)}${(idSeq++).toString(36)}`;

export async function getEvents() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(EVENTS, 'readonly').objectStore(EVENTS).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

export async function putEvents(groups) {
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const t = db.transaction(EVENTS, 'readwrite');
    const store = t.objectStore(EVENTS);
    for (const g of groups) if (g && g.id) store.put(g);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export async function deleteEvents(ids) {
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const t = db.transaction(EVENTS, 'readwrite');
    const store = t.objectStore(EVENTS);
    for (const id of ids) store.delete(id);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

/** Set a group's flag ('pinned' | 'hidden' | null). Returns the previous flag. */
export async function setEventFlag(id, flag) {
  let prev = null;
  await updateRecordIn(EVENTS, id, (g) => {
    prev = g.flag ?? null;
    g.flag = flag;
  });
  return prev;
}

// updateRecord, but on an arbitrary store.
async function updateRecordIn(storeName, id, mutate) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, 'readwrite');
    const store = t.objectStore(storeName);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const rec = getReq.result;
      if (!rec) return;
      mutate(rec);
      store.put(rec);
    };
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

/**
 * Create a singleton event group for every upcoming (`date >= todayISO`) event
 * post of `accountId` that isn't grouped yet. Cheap (no LLM), idempotent — used
 * for the v3->v4 backfill and to seed newly-extracted events before clustering.
 * Legacy per-post `event_hidden` seeds the group's flag. Returns created count.
 */
export async function ensureEventGroups(todayISO, accountId) {
  const [all, events] = await Promise.all([getAllPosts(), getEvents()]);
  const grouped = new Set(events.map((e) => e.id));
  const newGroups = [];
  const postUpdates = [];
  for (const t of all) {
    if (t.nested || !(t.accounts || []).includes(accountId)) continue;
    if (!t.event || !t.event.date) continue;
    // Multi-day events stay "current" until their end date (falls back to start).
    if ((t.event.end_date || t.event.date) < todayISO) continue;
    if (t.event_group_id && grouped.has(t.event_group_id)) continue; // already grouped
    const id = newGroupId();
    newGroups.push({
      id,
      account: accountId,
      date: t.event.date,
      end_date: t.event.end_date || t.event.date,
      name: t.event.name,
      venue: t.event.venue || null,
      time: t.event.time || null,
      status: t.event.status || 'scheduled',
      description: t.summary || '',
      flag: t.event_hidden ? 'hidden' : null,
      post_ids: [t.id],
      updated_at: Date.now(),
    });
    postUpdates.push({ id: t.id, field: 'event_group_id', value: id });
  }
  if (newGroups.length) {
    await putEvents(newGroups);
    await applyFieldUpdates(postUpdates);
  }
  return newGroups.length;
}

/**
 * Mark as unread all of `accountId`'s posts with created_at >= threshold
 * (all accounts when accountId is falsy). Returns the ids actually flipped.
 */
export async function markUnreadSince(threshold, accountId) {
  const db = await openDB();
  const ids = [];
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite');
    const index = transaction.objectStore(STORE).index('read');
    const cursorReq = index.openCursor(IDBKeyRange.only(1));
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor) return;
      const t = cursor.value;
      if (t.created_at >= threshold && belongsTo(t, accountId)) {
        t.read = 0;
        cursor.update(t);
        ids.push(t.id);
      }
      cursor.continue();
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  return ids;
}

/**
 * Clear LLM analysis for a subset of `accountId`'s already-analyzed posts so the
 * next run re-analyzes them (removes processed_at + the LLM outputs; keeps read
 * state and on-demand translation). Options narrow the subset:
 *   - onlyOther: only tier-3 "other" posts (category === 'other')
 *   - onlyUnread: only unread posts
 *   - onlyEvents: only posts that produced an event (cheap way to re-extract just
 *     event posts, e.g. to backfill a new field like end_date)
 *   - onlyIds: a Set of post ids — an explicit selection (the search-filtered
 *     "re-analyze matching posts" action), useful for A/B-ing a prompt change on
 *     a handful of posts instead of the whole digest
 * Returns the number of rows cleared.
 */
export async function clearAnalysis(
  accountId,
  { onlyOther = false, onlyUnread = false, onlyEvents = false, onlyIds = null } = {},
) {
  const db = await openDB();
  let n = 0;
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite');
    const cursorReq = transaction.objectStore(STORE).openCursor();
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor) return;
      const t = cursor.value;
      const match =
        t.processed_at &&
        belongsTo(t, accountId) &&
        (!onlyOther || t.category === 'other') &&
        (!onlyUnread || !t.read) &&
        (!onlyEvents || !!t.event) &&
        (!onlyIds || onlyIds.has(t.id));
      if (match) {
        delete t.processed_at;
        delete t.category;
        delete t.theme;
        delete t.summary;
        delete t.event;
        delete t.event_group_id; // re-group from scratch; groupEvents prunes the orphan
        cursor.update(t);
        n++;
      }
      cursor.continue();
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  return n;
}

/** Number of rows not yet attributed to any account (pre-v2 captures). */
export async function countUntagged() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    let n = 0;
    const cursorReq = tx(db, 'readonly').openCursor();
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor) {
        resolve(n);
        return;
      }
      if (!cursor.value.accounts || cursor.value.accounts.length === 0) n++;
      cursor.continue();
    };
    cursorReq.onerror = () => reject(cursorReq.error);
  });
}

/** Attribute all untagged rows (pre-v2 captures) to `accountId`. Returns the count. */
export async function assignUntagged(accountId) {
  if (!accountId) return 0;
  const db = await openDB();
  let n = 0;
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite');
    const cursorReq = transaction.objectStore(STORE).openCursor();
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor) return;
      const t = cursor.value;
      if (!t.accounts || t.accounts.length === 0) {
        t.accounts = [accountId];
        cursor.update(t);
        n++;
      }
      cursor.continue();
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  return n;
}

/**
 * Merge LLM pipeline results into existing records.
 * `results` is a Map or plain object: post id -> partial fields
 * (category, theme, summary, event, translation, processed_at).
 * Unknown ids are silently skipped.
 */
export async function saveLLMResults(results) {
  const entries =
    results instanceof Map ? [...results.entries()] : Object.entries(results);
  if (entries.length === 0) return 0;
  const db = await openDB();
  let n = 0;
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite');
    const store = transaction.objectStore(STORE);
    for (const [id, fields] of entries) {
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const existing = getReq.result;
        if (!existing) return;
        store.put({ ...existing, ...fields });
        n++;
      };
    }
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  return n;
}
