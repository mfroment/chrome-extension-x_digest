// settings.js — options page. Global settings (API key, model, language) +
// per-X-account digest enablement and criteria. Stored in chrome.storage.local.

import {
  GLOBAL_DEFAULTS,
  CRITERIA_DEFAULTS,
  loadGlobal,
  loadAccounts,
  saveAccounts,
  defaultLocaleLanguage,
} from './defaults.js';
import { countUntagged, assignUntagged, getAllPosts, bulkPut } from './db.js';

const $ = (id) => document.getElementById(id);
const listEl = $('accounts-list');

let accounts = {}; // registry, mutated by the form then saved

async function load() {
  const global = await loadGlobal();
  $('api-key').value = global.apiKey;
  $('model').value = global.model;
  // Show the raw stored language (blank if unset) with the browser-locale
  // default as a placeholder, so leaving it blank tracks the locale.
  const { language: storedLanguage } = await chrome.storage.local.get({ language: '' });
  $('language').value = storedLanguage;
  $('language').placeholder = defaultLocaleLanguage();

  accounts = await loadAccounts();
  renderAccounts();
}

function renderAccounts() {
  listEl.textContent = '';
  const ids = Object.keys(accounts);
  $('no-accounts').hidden = ids.length > 0;

  for (const id of ids) {
    const acc = { ...CRITERIA_DEFAULTS, ...accounts[id] };
    const card = document.createElement('div');
    card.className = 'account';
    card.dataset.id = id;

    const head = document.createElement('label');
    head.className = 'account-head';
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'acc-enabled';
    check.checked = !!acc.enabled;
    const title = document.createElement('span');
    title.className = 'account-title';
    title.textContent = acc.handle ? `@${acc.handle}` : `id ${id}`;
    const state = document.createElement('span');
    state.className = 'account-state';
    state.textContent = check.checked ? 'digest enabled' : 'digest off';
    head.append(check, title, state);
    card.appendChild(head);

    const body = document.createElement('div');
    body.className = 'account-body';
    body.hidden = !check.checked;
    body.innerHTML = `
      <label>Full detail themes — structured extraction, flyer image reading</label>
      <textarea class="acc-full" rows="4"></textarea>
      <label>Summary themes — one-line summary</label>
      <textarea class="acc-summary" rows="3"></textarea>`;
    body.querySelector('.acc-full').value = acc.fullThemes;
    body.querySelector('.acc-summary').value = acc.summaryThemes;
    card.appendChild(body);

    check.addEventListener('change', () => {
      body.hidden = !check.checked;
      state.textContent = check.checked ? 'digest enabled' : 'digest off';
    });

    listEl.appendChild(card);
  }
}

async function save() {
  const global = {
    apiKey: $('api-key').value.trim(),
    model: $('model').value.trim() || GLOBAL_DEFAULTS.model,
    language: $('language').value.trim(), // blank = follow the browser locale
  };
  await chrome.storage.local.set(global);

  const newlyEnabled = [];
  for (const card of listEl.querySelectorAll('.account')) {
    const id = card.dataset.id;
    const wasEnabled = !!accounts[id].enabled;
    const enabled = card.querySelector('.acc-enabled').checked;
    accounts[id] = {
      ...accounts[id],
      enabled,
      fullThemes: card.querySelector('.acc-full').value.trim(),
      summaryThemes: card.querySelector('.acc-summary').value.trim(),
    };
    if (enabled && !wasEnabled) newlyEnabled.push(id);
  }
  await saveAccounts(accounts);

  // Offer to adopt pre-multi-account captures into a newly enabled account
  for (const id of newlyEnabled) {
    const untagged = await countUntagged();
    if (untagged === 0) break;
    const label = accounts[id].handle ? `@${accounts[id].handle}` : `id ${id}`;
    if (confirm(`${untagged} previously captured posts are not attributed to any account. Assign them to ${label}?`)) {
      await assignUntagged(id);
    }
  }

  chrome.runtime.sendMessage({ type: 'XD_REFRESH_BADGE' }).catch(() => {});
  const status = $('status');
  status.textContent = 'Saved.';
  setTimeout(() => (status.textContent = ''), 2000);
}

$('save').addEventListener('click', save);
$('toggle-key').addEventListener('click', () => {
  const input = $('api-key');
  const isPassword = input.type === 'password';
  input.type = isPassword ? 'text' : 'password';
  $('toggle-key').textContent = isPassword ? 'Hide' : 'Show';
});

// ---------------------------------------------------------------------------
// Data backup: export/import a JSON of posts + accounts + non-secret settings.
// ---------------------------------------------------------------------------

const dataStatus = (msg) => ($('data-status').textContent = msg);

// Filesystem-safe local datetime for filenames, e.g. "2026-07-19_14-30-52"
// (colons from ISO time aren't allowed in filenames on Windows).
function localTimestamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`
  );
}

async function exportData() {
  const [posts, accountsReg, global] = await Promise.all([
    getAllPosts(),
    loadAccounts(),
    loadGlobal(),
  ]);
  const { apiKey, ...globalSafe } = global; // never export the API key
  const payload = {
    format: 'x-digest-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    global: globalSafe,
    accounts: accountsReg,
    posts,
  };
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(payload)], { type: 'application/json' }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = `x-digest-backup-${localTimestamp()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  dataStatus(`Exported ${posts.length} posts.`);
}

async function importData(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    dataStatus('That file is not valid JSON.');
    return;
  }
  if (data.format !== 'x-digest-backup' || !Array.isArray(data.posts)) {
    dataStatus('That is not an X Digest backup file.');
    return;
  }
  if (
    !confirm(
      `Import ${data.posts.length} posts from this backup?\n` +
        'Posts with the same id will be overwritten. Your API key is left untouched.',
    )
  ) {
    return;
  }
  const n = await bulkPut(data.posts);
  if (data.accounts && typeof data.accounts === 'object') {
    const existing = await loadAccounts();
    await saveAccounts({ ...existing, ...data.accounts }); // backup wins per account
  }
  if (data.global && typeof data.global === 'object') {
    const { apiKey, ...safe } = data.global; // never restore/clobber the API key
    await chrome.storage.local.set(safe);
  }
  chrome.runtime.sendMessage({ type: 'XD_REFRESH_BADGE' }).catch(() => {});
  dataStatus(`Imported ${n} posts. Reload any open digest to see them.`);
  load(); // refresh the accounts list
}

$('export-data').addEventListener('click', () => exportData().catch((e) => dataStatus(`Export failed: ${e.message}`)));
$('import-data').addEventListener('click', () => $('import-file').click());
$('import-file').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) importData(file).catch((err) => dataStatus(`Import failed: ${err.message}`));
  e.target.value = ''; // allow re-importing the same file
});

load();
