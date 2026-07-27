// pipeline.js — LLM pipeline orchestration, run from the digest page.
// Flow: batch classification -> tier routing (full -> per-post extraction,
// everything else -> one-line summary) -> incremental saves to IndexedDB.

import {
  getAllPosts,
  saveLLMResults,
  getEvents,
  putEvents,
  deleteEvents,
  ensureEventGroups,
  applyFieldUpdates,
} from './db.js';
import {
  classifyBatch,
  summarizeBatch,
  extractFull,
  clusterEvents,
  mergeEventDescription,
} from './llm.js';

const CLASSIFY_BATCH = 50;
const SUMMARY_BATCH = 30;
const EXTRACT_CONCURRENCY = 2;

/**
 * Run the pipeline over `accountId`'s unprocessed timeline posts.
 * `settings` is the merged config for that account (global + criteria,
 * see accountConfig in defaults.js). `onProgress(text)` receives
 * human-readable status updates. `opts.onlyIds` (a Set) restricts the run to
 * those specific post ids (used to analyze just the replies revealed in a
 * thread); omit it to process every unprocessed post.
 * Returns { processed, full, summary, other, errors }.
 */
export async function runPipeline(settings, accountId, onProgress = () => {}, opts = {}) {
  const onlyIds = opts.onlyIds || null;
  const all = await getAllPosts();
  const byId = new Map(all.map((t) => [t.id, t]));
  const belongs = (t) => (t.accounts || []).includes(accountId);

  // For a repost, classify/summarize the original's content
  const contentOf = (t) => (t.repost_of && byId.get(t.repost_of)) || t;
  const toInput = (t) => {
    const c = contentOf(t);
    return {
      id: t.id,
      author: c.screen_name,
      text: c.text,
      created_at: c.created_at,
      images: (c.media || [])
        .filter((m) => m.type === 'photo' && m.url)
        .map((m) => m.url),
    };
  };

  const candidates = all.filter(
    (t) => !t.nested && belongs(t) && !t.processed_at && (!onlyIds || onlyIds.has(t.id)),
  );
  if (candidates.length === 0) {
    // Still (re)group events — this is what backfills legacy events on the first
    // Analyze after the v4 upgrade. Skipped for targeted reply re-analysis.
    const grouped = onlyIds ? null : await groupEvents(settings, accountId, onProgress);
    onProgress(
      !grouped
        ? 'Nothing new to analyze.'
        : grouped.error
          ? `Grouping failed: ${grouped.error}`
          : `Events grouped${grouped.merged ? ` — ${grouped.merged} merged` : ' (nothing to merge)'}.`,
    );
    return { processed: 0, full: 0, summary: 0, other: 0, errors: [], grouped };
  }

  const errors = [];
  const stats = { processed: 0, full: 0, summary: 0, other: 0 };
  const now = Date.now();

  // --- 1. Classification -----------------------------------------------
  const needSummary = []; // posts waiting for a one-line summary
  const needExtract = []; // posts waiting for full extraction

  for (const chunk of chunks(candidates, CLASSIFY_BATCH)) {
    onProgress(`Classifying… (${stats.processed}/${candidates.length})`);
    let results;
    try {
      results = await classifyBatch(settings, chunk.map(toInput));
    } catch (e) {
      errors.push(`classification: ${e.message}`);
      continue; // this chunk stays unprocessed; a re-run will retry it
    }

    for (const t of chunk) {
      const r = results.get(t.id);
      if (!r) {
        errors.push(`classification: no result for post ${t.id}`);
        continue;
      }
      const base = { category: r.tier, theme: r.theme };
      if (r.tier === 'full') {
        needExtract.push({ post: t, base });
      } else {
        // Both "summary" and "other" tiers get a one-line summary; the theme
        // chip (base.theme) still distinguishes tier-3 in the digest.
        needSummary.push({ post: t, base });
      }
    }
  }

  // --- 2. One-line summaries -------------------------------------------
  for (const chunk of chunks(needSummary, SUMMARY_BATCH)) {
    onProgress(`Summarizing… (${stats.processed}/${candidates.length})`);
    let results;
    try {
      results = await summarizeBatch(settings, chunk.map((x) => toInput(x.post)));
    } catch (e) {
      errors.push(`summaries: ${e.message}`);
      continue;
    }
    const done = new Map();
    for (const { post, base } of chunk) {
      const summary = results.get(post.id);
      if (summary === undefined) {
        errors.push(`summaries: no result for post ${post.id}`);
        continue;
      }
      done.set(post.id, { ...base, summary, processed_at: now });
      stats.summary++;
      stats.processed++;
    }
    await saveLLMResults(done);
  }

  // --- 3. Full-detail extraction (with flyer images) --------------------
  const queue = [...needExtract];
  const workers = Array.from({ length: EXTRACT_CONCURRENCY }, async () => {
    while (queue.length > 0) {
      const { post, base } = queue.shift();
      onProgress(`Extracting events… (${stats.processed}/${candidates.length})`);
      try {
        const { summary, event } = await extractFull(settings, toInput(post));
        await saveLLMResults(
          new Map([[post.id, { ...base, summary, event, processed_at: now }]]),
        );
        stats.full++;
        stats.processed++;
      } catch (e) {
        errors.push(`extraction (${post.id}): ${e.message}`);
      }
    }
  });
  await Promise.all(workers);

  // --- 4. Group/cluster events (one clustering call + a merge call per group
  // that gained members). Skipped for targeted reply re-analysis. -----------
  const grouped = onlyIds ? null : await groupEvents(settings, accountId, onProgress);

  onProgress(
    `Done: ${stats.processed} analyzed (${stats.full} full, ${stats.summary} summarized)` +
      `${grouped && grouped.merged ? `, ${grouped.merged} events merged` : ''}` +
      `${errors.length ? `, ${errors.length} errors` : ''}.`,
  );
  return { ...stats, errors, grouped };
}

// ---------------------------------------------------------------------------
// Event grouping: singleton backfill -> LLM cluster -> merge duplicate groups
// (preserving flags), with an LLM-merged description per multi-post group.
// ---------------------------------------------------------------------------
async function groupEvents(settings, accountId, onProgress) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayISO = isoDate(today);

  await ensureEventGroups(todayISO, accountId); // singletons for any ungrouped event

  const posts = await getAllPosts();
  const postsById = new Map(posts.map((t) => [t.id, t]));

  // Reconcile: drop orphan groups (no post still points to them — e.g. after a
  // re-analyze cleared the event) and trim post_ids to their backing posts.
  const raw = (await getEvents()).filter(
    (g) => g.account === accountId && (g.end_date || g.date) >= todayISO,
  );
  const groups = [];
  const orphanIds = [];
  const trimmed = [];
  for (const g of raw) {
    const backing = (g.post_ids || []).filter((pid) => postsById.get(pid)?.event_group_id === g.id);
    if (!backing.length) {
      orphanIds.push(g.id);
      continue;
    }
    if (backing.length !== (g.post_ids || []).length) {
      g.post_ids = backing;
      trimmed.push(g);
    }
    groups.push(g);
  }
  if (orphanIds.length) await deleteEvents(orphanIds);
  if (trimmed.length) await putEvents(trimmed);
  if (groups.length < 2) return { groups: groups.length, merged: 0 };

  // Only spend a clustering call when there's a group the previous pass hasn't
  // seen yet (`clustered` unset — a fresh singleton). Otherwise the settled set
  // is unchanged, so re-clustering would just cost calls and risk churn. A
  // re-analyze (which clears event_group_id -> new singletons) forces a redo.
  if (!groups.some((g) => !g.clustered)) return { groups: groups.length, merged: 0 };

  onProgress('Grouping events…');
  const byId = new Map(groups.map((g) => [g.id, g]));
  const sink = { toDelete: [], postUpdates: [], mergeJobs: [], merged: 0 };

  // Pass 1 — deterministic union-find: same date (±1) AND a matching name OR
  // venue key (Latin/CJK, exact after normalization). Robustly collapses the
  // duplicates the model misses (identical names in either script; the same
  // venue across transliterations even when the names differ).
  applyClusters(deterministicClusters(groups), byId, postsById, sink);

  // Pass 2 — LLM for the genuinely fuzzy cases (paraphrased names/venues), on the
  // remaining survivors. clusterEvents returns every input in exactly one cluster,
  // so this also marks leftover singletons evaluated.
  let error = null;
  const survivors = [...byId.values()];
  if (survivors.length >= 2) {
    try {
      applyClusters(await clusterEvents(settings, survivors), byId, postsById, sink);
    } catch (e) {
      error = e.message; // keep the deterministic merges; report the LLM failure
    }
  }
  // Anything neither pass touched (a lone singleton) is now evaluated too.
  for (const g of byId.values()) {
    if (!g.clustered) {
      g.clustered = true;
      g.updated_at = Date.now();
    }
  }

  // Persist the merged STRUCTURE first (post links, deletes, canonical fields +
  // clustered flags) so an interruption mid-description can't orphan posts.
  if (sink.postUpdates.length) await applyFieldUpdates(sink.postUpdates);
  if (sink.toDelete.length) await deleteEvents(sink.toDelete);
  await putEvents([...byId.values()]);

  // One LLM-merged description per merged survivor (deduped across both passes),
  // fetched concurrently WITH progress (a big first-pass backfill otherwise looks
  // hung).
  const jobs = [...new Map(sink.mergeJobs.map((j) => [j.survivor.id, j])).values()];
  let done = 0;
  const queue = [...jobs];
  const workers = Array.from({ length: 3 }, async () => {
    while (queue.length > 0) {
      const { survivor, summaries } = queue.shift();
      onProgress(`Merging events… (${(done += 1)}/${jobs.length})`);
      try {
        survivor.description = await mergeEventDescription(settings, survivor.name, summaries);
      } catch (e) {
        /* keep the survivor's existing description on failure */
      }
    }
  });
  await Promise.all(workers);
  if (jobs.length) await putEvents(jobs.map((j) => j.survivor)); // persist descriptions

  return { groups: byId.size, merged: sink.merged, ...(error ? { error } : {}) };
}

// Which record survives a merge. Prefer a pinned member (keep the pin), then any
// UNHIDDEN member, then the first — matching the flag priority below.
function pickSurvivor(members) {
  return (
    members.find((g) => g.flag === 'pinned') ||
    members.find((g) => (g.flag ?? null) === null) ||
    members[0]
  );
}
// Flag of the merged group: pinned wins, then UNHIDDEN wins over hidden — a group
// is only hidden when EVERY member was hidden (so hiding some but not all
// duplicates leaves the merge visible).
function mergeFlag(members) {
  if (members.some((g) => g.flag === 'pinned')) return 'pinned';
  if (members.some((g) => (g.flag ?? null) === null)) return null;
  return 'hidden';
}
// --- Deterministic duplicate detection --------------------------------------
// Normalize a name/venue into two comparable keys: a Latin key (lowercased,
// diacritics/macrons stripped, non-alphanumerics removed, so a macron'd or
// hyphenated romanization equals its plain spelling) and a CJK key (ideographs +
// kana only). We match on EXACT key equality, never substrings, so it stays safe.
function keyLatin(s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // combining diacritics (incl. macrons)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}
function keyCjk(s) {
  return (String(s || '').match(/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]+/g) || []).join('');
}
const eqKey = (x, y) => !!x && x === y;
const hasVenue = (g) => !!(keyLatin(g.venue) || keyCjk(g.venue));

// Two groups are the SAME real-world event when they share the EXACT start date
// AND either their venue keys match (same place, names worded differently) OR
// their name keys match with a compatible venue (same event, one entry omitting
// the venue; requiring venue-compatibility guards two generically-named events at
// DIFFERENT venues). We deliberately require the SAME
// start date rather than ±1: with union-find, ±1 would chain a venue's events
// across consecutive days into one mega-cluster. The ±1 fuzziness (and merging a
// multi-day event's "day 2" post) is left to the LLM pass, which won't chain.
function sameEvent(a, b) {
  if (!a.date || a.date !== b.date) return false;
  const venueMatch =
    eqKey(keyLatin(a.venue), keyLatin(b.venue)) || eqKey(keyCjk(a.venue), keyCjk(b.venue));
  if (venueMatch) return true;
  const nameMatch =
    eqKey(keyLatin(a.name), keyLatin(b.name)) || eqKey(keyCjk(a.name), keyCjk(b.name));
  return nameMatch && (!hasVenue(a) || !hasVenue(b));
}

// Union-find over the groups → clusters (as {memberIds}) of size > 1. Transitive,
// so A↔B (matching on the CJK key) and B↔C (matching on the Latin key) collapse
// A, B and C together even though no single pair matches in both scripts.
function deterministicClusters(groups) {
  const parent = groups.map((_, i) => i);
  const find = (x) => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]];
    return x;
  };
  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j < groups.length; j++) {
      if (sameEvent(groups[i], groups[j])) parent[find(i)] = find(j);
    }
  }
  const byRoot = new Map();
  groups.forEach((g, i) => {
    const r = find(i);
    (byRoot.get(r) || byRoot.set(r, []).get(r)).push(g);
  });
  return [...byRoot.values()]
    .filter((m) => m.length > 1)
    .map((m) => ({ memberIds: m.map((g) => g.id) }));
}

// Apply a list of clusters to the in-memory group map: pick a survivor, fold the
// others into it (union post_ids, flag priority), and record the side effects.
// Deterministic clusters carry only memberIds (survivor keeps its own fields);
// LLM clusters also carry canonical name/venue/date/... which then win.
function applyClusters(clusters, byId, postsById, sink) {
  for (const c of clusters) {
    const members = (c.memberIds || []).map((id) => byId.get(id)).filter(Boolean);
    if (!members.length) continue;
    const survivor = pickSurvivor(members);
    const others = members.filter((g) => g.id !== survivor.id);
    // Widest end date across members so a multi-day event stays "current" (and
    // isn't collapsed to a single day by whichever member became the survivor).
    const widestEnd = members
      .map((g) => g.end_date || g.date)
      .filter(Boolean)
      .sort()
      .pop();
    if (c.name) survivor.name = c.name;
    if (c.venue !== undefined) survivor.venue = c.venue ?? survivor.venue;
    if (c.time !== undefined) survivor.time = c.time ?? survivor.time;
    if (c.date) survivor.date = c.date;
    survivor.end_date = c.end_date || widestEnd || survivor.date;
    if (c.status) survivor.status = c.status;
    survivor.post_ids = [...new Set(members.flatMap((g) => g.post_ids || []))];
    survivor.flag = mergeFlag(members);
    survivor.clustered = true;
    survivor.updated_at = Date.now();
    if (others.length) {
      sink.merged += others.length;
      for (const pid of survivor.post_ids) {
        sink.postUpdates.push({ id: pid, field: 'event_group_id', value: survivor.id });
      }
      for (const g of others) {
        sink.toDelete.push(g.id);
        byId.delete(g.id);
      }
      const summaries = survivor.post_ids.map((pid) => postsById.get(pid)?.summary).filter(Boolean);
      sink.mergeJobs.push({ survivor, summaries });
    }
  }
}

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function* chunks(arr, size) {
  for (let i = 0; i < arr.length; i += size) yield arr.slice(i, i + size);
}
