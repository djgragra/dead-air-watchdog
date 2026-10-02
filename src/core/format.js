// Formatting helpers (pure).

const LOCALES = { en: 'en-GB', it: 'it-IT', es: 'es-ES' };

export function localeFor(lang) {
  return LOCALES[lang] || LOCALES.en;
}

// 3725000 -> "1h 02m 05s"; 42000 -> "42s"; 0 -> "0s"
export function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const p = (n) => String(n).padStart(2, '0');
  if (h) return `${h}h ${p(m)}m ${p(s)}s`;
  if (m) return `${m}m ${p(s)}s`;
  return `${s}s`;
}

// 24-hour, seconds included: broadcast logs are read at the second.
export function formatDateTime(ts, lang = 'en') {
  return new Date(ts).toLocaleString(localeFor(lang), { hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function formatDb(db) {
  if (db === null || db === undefined || !Number.isFinite(db)) return '—';
  return (Math.round(db * 10) / 10).toFixed(1);
}
