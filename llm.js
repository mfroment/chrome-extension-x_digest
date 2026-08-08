// llm.js — Claude API calls (classification, summaries, event extraction, translation).
// Raw fetch, no SDK: the project has no build step and no dependencies.
// CORS is handled by the api.anthropic.com host permission in the manifest.

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

/**
 * Low-level Messages API call with one retry on rate-limit / server errors.
 * Returns the parsed response body.
 */
async function apiCall(settings, body, { retries = 1 } = {}) {
  if (!settings.apiKey) throw new Error('No API key configured (see Settings).');
  for (let attempt = 0; ; attempt++) {
    const resp = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': settings.apiKey,
        'anthropic-version': API_VERSION,
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
    });
    if (resp.ok) return resp.json();

    const retryable = resp.status === 429 || resp.status >= 500;
    if (retryable && attempt < retries) {
      const after = parseInt(resp.headers.get('retry-after') || '5', 10);
      await sleep(Math.min(after, 30) * 1000);
      continue;
    }
    const err = await resp.json().catch(() => null);
    throw new Error(`API ${resp.status}: ${err?.error?.message || resp.statusText}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Extract the text of the first text block; throws on refusal/truncation. */
function firstText(response) {
  if (response.stop_reason === 'refusal') throw new Error('The model refused the request.');
  const block = (response.content || []).find((b) => b.type === 'text');
  if (!block) throw new Error('Empty model response.');
  if (response.stop_reason === 'max_tokens') {
    throw new Error('Response truncated (max_tokens) — try a smaller batch.');
  }
  return block.text;
}

// ---------------------------------------------------------------------------
// Classification (batch)
// ---------------------------------------------------------------------------

/**
 * The output-language rule, repeated at the END of every system prompt.
 * The posts themselves are the last thing the model reads before generating, so
 * a language instruction stated only once (at the top) loses out to the pull of
 * the source language — which is how summaries end up in the post's language, or
 * occasionally in some unrelated one. Restating it last is the single biggest
 * lever; the per-field schema descriptions below reinforce it at generation time.
 */
const languageRule = (lang) =>
  `\n\nOUTPUT LANGUAGE — this overrides everything above.\n` +
  `Write ALL output in ${lang}. The posts are usually NOT in ${lang}; that is ` +
  `expected and does not change the output language. Never mirror the language ` +
  `or script of the post, and never use a third language: even when a post is ` +
  `entirely in another language, your output is still written in ${lang}. ` +
  `Proper nouns (event, place and person names) may keep their original spelling.`;

// Posts are keyed by a small integer index (i), not their snowflake id:
// a 19-digit id exceeds JS/JSON safe-integer range, and the model tends to
// echo it back as a rounded number that no longer matches. The index is
// mapped back to the real id on our side.
const CLASSIFY_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          i: { type: 'integer' },
          tier: { type: 'string', enum: ['full', 'summary', 'other'] },
          theme: { type: 'string' },
        },
        required: ['i', 'tier', 'theme'],
        additionalProperties: false,
      },
    },
  },
  required: ['results'],
  additionalProperties: false,
};

/**
 * Classify a batch of posts against the user-configured theme lists.
 * `posts`: [{ id, author, text }]. Returns Map id -> { tier, theme }.
 */
export async function classifyBatch(settings, posts) {
  const system =
    'You classify posts from an X (Twitter) timeline (which may be in any language) into treatment tiers.\n\n' +
    'Tier "full" — posts matching any of these themes:\n' +
    settings.fullThemes +
    '\n\nTier "summary" — posts matching any of these themes:\n' +
    settings.summaryThemes +
    '\n\nTier "other" — everything else.\n\n' +
    'For EVERY post, also provide a short 1-3 word theme label describing its topic.\n' +
    'Return exactly one result per input post, echoing its "i" value. Do not skip any.' +
    languageRule(settings.language) +
    `\nThe theme label in particular must be TRANSLATED into ${settings.language}, ` +
    "not copied from the post's own wording.";

  const response = await apiCall(settings, {
    model: settings.model,
    max_tokens: 8000,
    system,
    output_config: { format: { type: 'json_schema', schema: CLASSIFY_SCHEMA } },
    messages: [
      {
        role: 'user',
        content: JSON.stringify(
          posts.map((t, i) => ({ i, author: t.author, text: t.text })),
        ),
      },
    ],
  });

  const parsed = JSON.parse(firstText(response));
  const map = new Map();
  for (const r of parsed.results || []) {
    const t = posts[r.i];
    if (t) map.set(t.id, { tier: r.tier, theme: r.theme });
  }
  return map;
}

// ---------------------------------------------------------------------------
// One-line summaries (batch)
// ---------------------------------------------------------------------------

// Keyed by integer index (see note on CLASSIFY_SCHEMA).
// `lang` is deliberately listed BEFORE `summary`: structured outputs are emitted
// in schema order, so the model states the language it is about to write in and
// then writes it — a self-conditioning step that measurably steadies adherence.
// It also gives us an exact-match signal to retry on (see summarizeBatch).
const summarizeSchema = (lang) => ({
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          i: { type: 'integer' },
          lang: {
            type: 'string',
            description:
              `Exactly "${lang}" if the summary below is written in ${lang}; ` +
              'otherwise the name of the language you actually used.',
          },
          summary: {
            type: 'string',
            description: `One short sentence, written in ${lang}.`,
          },
        },
        required: ['i', 'lang', 'summary'],
        additionalProperties: false,
      },
    },
  },
  required: ['results'],
  additionalProperties: false,
});

/**
 * One-line summaries for a batch of posts, in the output language.
 * `posts`: [{ id, author, text }]. Returns Map id -> summary.
 */
export async function summarizeBatch(settings, posts, { retry = true } = {}) {
  const lang = settings.language;
  const system =
    `You summarize X posts (which may be in any language) in ${lang}. ` +
    'For each post, write ONE short sentence capturing the essential content — ' +
    'who/what/when/where when relevant. Keep proper nouns (event names, places) ' +
    'as-is with a reading or translation if helpful. ' +
    'Return exactly one result per input post, echoing its "i" value. Do not skip any.' +
    languageRule(lang);

  const response = await apiCall(settings, {
    model: settings.model,
    max_tokens: 8000,
    system,
    output_config: { format: { type: 'json_schema', schema: summarizeSchema(lang) } },
    messages: [
      {
        role: 'user',
        content: JSON.stringify(
          posts.map((t, i) => ({ i, author: t.author, text: t.text })),
        ),
      },
    ],
  });

  const parsed = JSON.parse(firstText(response));
  const map = new Map();
  const wrongLang = []; // posts the model itself flagged as off-language
  for (const r of parsed.results || []) {
    const t = posts[r.i];
    if (!t) continue;
    if (retry && r.lang && r.lang.trim().toLowerCase() !== lang.trim().toLowerCase()) {
      wrongLang.push(t);
      continue;
    }
    map.set(t.id, r.summary);
  }

  // One re-run for the stragglers only — a small batch of the offending posts,
  // where the language rule isn't competing with 30 posts of source text.
  if (wrongLang.length) {
    try {
      const redone = await summarizeBatch(settings, wrongLang, { retry: false });
      for (const [id, summary] of redone) map.set(id, summary);
    } catch (e) {
      /* keep going: these posts stay unprocessed and retry on the next run */
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Full-detail extraction (per post, with flyer images)
// ---------------------------------------------------------------------------

const extractSchema = (lang) => ({
  type: 'object',
  properties: {
    summary: {
      type: 'string',
      description: `2-4 sentence summary, written in ${lang} whatever the post's language.`,
    },
    event: {
      anyOf: [
        {
          type: 'object',
          properties: {
            name: { type: 'string' },
            date: { anyOf: [{ type: 'string' }, { type: 'null' }] },
            end_date: { anyOf: [{ type: 'string' }, { type: 'null' }] },
            time: { anyOf: [{ type: 'string' }, { type: 'null' }] },
            venue: { anyOf: [{ type: 'string' }, { type: 'null' }] },
            status: {
              type: 'string',
              enum: ['scheduled', 'cancelled', 'postponed', 'unknown'],
            },
          },
          required: ['name', 'date', 'end_date', 'time', 'venue', 'status'],
          additionalProperties: false,
        },
        { type: 'null' },
      ],
    },
  },
  required: ['summary', 'event'],
  additionalProperties: false,
});

/**
 * Detailed extraction for a full-detail post: reads attached images (flyers
 * often carry the only date/venue info) and returns a detailed summary plus
 * a structured event when the post announces one.
 * `post`: { id, author, text, created_at, images: [url] }.
 * Returns { summary, event|null }.
 */
export async function extractFull(settings, post) {
  const postedOn = new Date(post.created_at).toISOString().slice(0, 10);
  const system =
    `You analyze X posts (which may be in any language) that matched the reader's "full detail" themes, in ${settings.language}.\n` +
    `Full-detail themes:\n${settings.fullThemes}\n\n` +
    `The post was published on ${postedOn} — use that to resolve dates without a year.\n\n` +
    'Write a detailed but compact summary (2-4 sentences) covering everything useful in the ' +
    'post and any attached images: dates, times, venue, access, program/lineup, notable ' +
    'details, cancellation/postponement notices. Read the attached images carefully — ' +
    'flyers/posters often contain the only date/venue information.\n\n' +
    'If the post announces a specific upcoming event, also fill in the event object. ' +
    'date = start day (YYYY-MM-DD); end_date = last day (YYYY-MM-DD) — set it equal to ' +
    'date for a single-day event, or the final day for a multi-day one (e.g. a 3-day or ' +
    'month-long event). Use null for a field that is genuinely unknown. If it is a ' +
    'report about a past event or not an announcement, set event to null.' +
    languageRule(settings.language) +
    '\nThe event\'s name and venue are the exception: keep them as written in the ' +
    'post (optionally adding a reading or translation in parentheses). Everything ' +
    `else you write, the summary above all, is in ${settings.language}.`;

  const content = [];
  for (const url of (post.images || []).slice(0, 4)) {
    content.push({ type: 'image', source: { type: 'url', url } });
  }
  content.push({ type: 'text', text: `@${post.author}:\n${post.text}` });

  const response = await apiCall(settings, {
    model: settings.model,
    max_tokens: 2000,
    system,
    output_config: { format: { type: 'json_schema', schema: extractSchema(settings.language) } },
    messages: [{ role: 'user', content }],
  });

  return JSON.parse(firstText(response));
}

// ---------------------------------------------------------------------------
// On-demand translation (per post, includes image reading)
// ---------------------------------------------------------------------------

/**
 * Full translation of a post into the output language. If images are attached,
 * also transcribes/translates the key information they contain.
 * Returns plain text.
 */
export async function translatePost(settings, post) {
  const system =
    `Translate the X post into ${settings.language}, faithfully and completely. ` +
    'Keep proper nouns with their original writing plus a translation/reading in parentheses ' +
    'when helpful. Copy any emoji from the original exactly as-is; never replace an emoji ' +
    'with a word or description. If images are attached and contain text (flyers, posters, ' +
    'schedules), add a section transcribing their key information in the target language.' +
    languageRule(settings.language);

  const content = [];
  for (const url of (post.images || []).slice(0, 4)) {
    content.push({ type: 'image', source: { type: 'url', url } });
  }
  content.push({ type: 'text', text: `@${post.author}:\n${post.text}` });

  const response = await apiCall(settings, {
    model: settings.model,
    max_tokens: 2000,
    system,
    messages: [{ role: 'user', content }],
  });

  return firstText(response).trim();
}

// ---------------------------------------------------------------------------
// Event clustering: group announcements that refer to the SAME real-world event
// ---------------------------------------------------------------------------

const CLUSTER_SCHEMA = {
  type: 'object',
  properties: {
    clusters: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          members: { type: 'array', items: { type: 'integer' } },
          name: { type: 'string' },
          venue: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          time: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          date: { type: 'string' },
          end_date: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          status: { type: 'string', enum: ['scheduled', 'cancelled', 'postponed', 'unknown'] },
        },
        required: ['members', 'name', 'venue', 'time', 'date', 'end_date', 'status'],
        additionalProperties: false,
      },
    },
  },
  required: ['clusters'],
  additionalProperties: false,
};

/**
 * Cluster event groups that refer to the same real-world event. `groups`:
 * [{ id, date, name, venue, time }] (keyed to the model by integer index).
 * Returns [{ memberIds: [id], name, venue, time, date, status }].
 */
export async function clusterEvents(settings, groups) {
  if (groups.length < 2) {
    return groups.map((g) => ({
      memberIds: [g.id],
      name: g.name,
      venue: g.venue ?? null,
      time: g.time ?? null,
      date: g.date,
      end_date: g.end_date ?? null,
      status: g.status || 'scheduled',
    }));
  }

  // NOTE: deliberately NO languageRule here. Clustering emits canonical event
  // names and venues, which must stay in their ORIGINAL language/script so they
  // still match the posts (and each other) — forcing them into the output
  // language would break the very matching this call exists to do.
  const system =
    'You group event announcements that refer to the SAME real-world event. A ' +
    'single event is often announced by several accounts that emphasize different ' +
    'things and write the name/venue very differently (different scripts, ' +
    'romanizations, translations, extra parentheticals, or a venue-type word such ' +
    'as "Hall", "Park" or "Center" added or dropped). Match on MEANING + date + ' +
    'place, NOT exact strings:\n' +
    '- Same date (±1 day) AND same venue → the SAME event, EVEN IF the names differ ' +
    '(one may stress a sub-name or organizer, another only the generic event type). ' +
    'Treat different scripts and transliterations of a venue as the same place.\n' +
    '- Same date AND same event name → the SAME event even if one entry omits the venue.\n' +
    '- Keep two entries separate ONLY when they have a DIFFERENT name AND a DIFFERENT place.\n' +
    'Return clusters covering EVERY input: each index appears in exactly one cluster.\n' +
    'For each cluster give: members (the indices), a canonical name (prefer the clearest, ' +
    'most complete; keep the name in its original language/script if there is one), venue, time, date ' +
    '(YYYY-MM-DD start), end_date (YYYY-MM-DD last day; the WIDEST range the members ' +
    'report, or equal to date for single-day), and status.';

  const response = await apiCall(settings, {
    model: settings.model,
    max_tokens: 8000,
    system,
    output_config: { format: { type: 'json_schema', schema: CLUSTER_SCHEMA } },
    messages: [
      {
        role: 'user',
        content: JSON.stringify(
          groups.map((g, i) => ({
            i,
            date: g.date,
            end_date: g.end_date,
            name: g.name,
            venue: g.venue,
            time: g.time,
          })),
        ),
      },
    ],
  });

  const parsed = JSON.parse(firstText(response));
  const out = [];
  const covered = new Set();
  for (const c of parsed.clusters || []) {
    const memberIds = (c.members || []).map((i) => groups[i]?.id).filter(Boolean);
    if (!memberIds.length) continue;
    memberIds.forEach((id) => covered.add(id));
    out.push({
      memberIds,
      name: c.name,
      venue: c.venue ?? null,
      time: c.time ?? null,
      date: c.date,
      end_date: c.end_date ?? null,
      status: c.status || 'scheduled',
    });
  }
  // Safety net: never drop an event the model forgot — keep it as its own cluster.
  for (const g of groups) {
    if (!covered.has(g.id)) {
      out.push({
        memberIds: [g.id],
        name: g.name,
        venue: g.venue ?? null,
        time: g.time ?? null,
        date: g.date,
        end_date: g.end_date ?? null,
        status: g.status || 'scheduled',
      });
    }
  }
  return out;
}

/** Merge several announcements of one event into a single concise description. */
export async function mergeEventDescription(settings, name, summaries) {
  const texts = summaries.filter(Boolean);
  if (texts.length <= 1) return texts[0] || '';
  const system =
    `Merge these announcements of the same event ("${name}") into ONE concise ` +
    `description in ${settings.language}, 2-4 sentences, combining all concrete details ` +
    '(dates, times, venue, access, program/lineup, cancellation) without repetition. ' +
    'Keep proper nouns.' +
    languageRule(settings.language);
  const response = await apiCall(settings, {
    model: settings.model,
    max_tokens: 900,
    system,
    messages: [{ role: 'user', content: texts.join('\n---\n') }],
  });
  return firstText(response).trim();
}
