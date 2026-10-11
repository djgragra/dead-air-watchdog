// Email recipients: one text field, several addresses.
export const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
export const MAX_RECIPIENTS = 20;

// Accepts a text ("a@x.org, b@y.org; c@z.org") or a list. Returns the valid, unique addresses
// (the first spelling is kept, uniqueness ignores case) and the ones that were left out.
export function parseAddresses(input) {
  const parts = (Array.isArray(input) ? input : [input]).flatMap((v) => String(v ?? '').split(/[\s,;]+/)).filter(Boolean);
  const seen = new Set();
  const valid = [];
  const dropped = [];
  for (const p of parts) {
    const key = p.toLowerCase();
    if (!EMAIL_RE.test(p) || seen.has(key) || valid.length >= MAX_RECIPIENTS) dropped.push(p);
    else {
      seen.add(key);
      valid.push(p);
    }
  }
  return { valid, dropped };
}
