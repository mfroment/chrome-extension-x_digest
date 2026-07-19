// defaults.js — settings shapes and storage helpers, shared by the settings
// page, the digest and the service worker.
//
// Global settings (one per install): API key, model, output language.
// Per-X-account settings: enabled flag + digest criteria. Accounts are
// auto-registered when posts arrive from them, DISABLED by default —
// nothing is captured for an account until the user enables it.

export const GLOBAL_DEFAULTS = {
  apiKey: '',
  model: 'claude-haiku-4-5',
  language: '', // empty = follow the browser locale (resolved in loadGlobal)
};

// Human-readable name of the browser's UI language — its English display name,
// used as the default output language when the user has not set one. Falls back
// to 'English' if the locale or Intl.DisplayNames is unavailable.
export function defaultLocaleLanguage() {
  let loc = 'en';
  try {
    loc =
      (typeof chrome !== 'undefined' && chrome.i18n && chrome.i18n.getUILanguage
        ? chrome.i18n.getUILanguage()
        : '') ||
      (typeof navigator !== 'undefined' && navigator.language) ||
      'en';
  } catch { /* ignore */ }
  const primary = String(loc).split('-')[0] || 'en';
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'language' }).of(primary);
    if (name && name.toLowerCase() !== primary) {
      return name.charAt(0).toUpperCase() + name.slice(1);
    }
  } catch { /* ignore */ }
  return 'English';
}

// Neutral boilerplate criteria seeded onto a newly enabled account. These are
// starting-point examples meant to be replaced in Settings with the user's own
// topics, described in natural language (one theme per line).
export const CRITERIA_DEFAULTS = {
  fullThemes:
    'Announcements of upcoming events you follow closely: dates, venues, schedules, and key details that may only appear on an attached image (including cancellations or postponements)\n' +
    'Detailed reports on topics you want to track in full',
  summaryThemes:
    'Other posts on the subjects you care about that are worth a one-line summary',
};

export async function loadGlobal() {
  const global = await chrome.storage.local.get(GLOBAL_DEFAULTS);
  // A previously stored language wins (existing configs keep working); only an
  // unset language falls back to the browser locale.
  if (!global.language) global.language = defaultLocaleLanguage();
  return global;
}

/**
 * Accounts registry:
 * { [xUserId]: { handle, enabled, fullThemes, summaryThemes } }
 */
export async function loadAccounts() {
  const { accounts } = await chrome.storage.local.get({ accounts: {} });
  return accounts;
}

export async function saveAccounts(accounts) {
  await chrome.storage.local.set({ accounts });
}

/** Full pipeline config for one account: global settings + its criteria. */
export function accountConfig(global, account) {
  return { ...CRITERIA_DEFAULTS, ...global, ...account };
}
