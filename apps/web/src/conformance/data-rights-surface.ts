// Pure guards for the GDPR data-rights surface conformance gate.
//
// They assert the shipped export surface is (1) fully translated — every catalog
// key present and non-empty in BOTH locales, so no untranslated string reaches the
// surface, (2) a genuine ONE-CLICK affordance — a single export control, never a
// multi-step wizard, and (3) accessible — the confirmation rides a POLITE live
// region. Kept pure (source string + catalog in, verdict out) so the mutation twin
// can feed known-bad input and prove each check reddens.

import type { Locale } from "@/lib/data-rights-strings";

// Flag every `${locale}:${key}` that is missing or empty in either locale of the
// catalog — the untranslated-string surface. Empty means fully translated.
export const missingTranslations = (
  catalog: Record<Locale, Record<string, string>>
): readonly string[] => {
  const locales = Object.keys(catalog) as Locale[];
  const keys = new Set<string>();
  for (const locale of locales) {
    for (const key of Object.keys(catalog[locale])) {
      keys.add(key);
    }
  }
  const missing: string[] = [];
  for (const locale of locales) {
    for (const key of keys) {
      const value = catalog[locale][key];
      if (value === undefined || value.trim() === "") {
        missing.push(`${locale}:${key}`);
      }
    }
  }
  return missing;
};

// Markers of a multi-step erasure/export WIZARD — the anti-pattern a one-click
// affordance must NOT be.
const WIZARD_RE = /\b(?:wizard|multi-step|step\s*\d|next step|step one)\b/i;
const BUTTON_OPEN_RE = /<button\b/g;
const LINE_COMMENT_RE = /\/\/[^\n]*/g;
const BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//g;

// Strip JS/JSX comments so the guard scans only the RENDERED markup — a prose
// comment (e.g. one that mentions a "wizard" it forbids) never trips the check.
const stripComments = (source: string): string =>
  source.replace(BLOCK_COMMENT_RE, "").replace(LINE_COMMENT_RE, "");

// True iff the surface exposes EXACTLY ONE export button and no wizard markers —
// a single click, no multi-step flow.
export const hasSingleOneClickExport = (source: string): boolean => {
  const markup = stripComments(source);
  const buttonCount = (markup.match(BUTTON_OPEN_RE) ?? []).length;
  return buttonCount === 1 && !WIZARD_RE.test(markup);
};

const ARIA_LIVE_POLITE_RE = /aria-live=["']polite["']/;
const ROLE_STATUS_RE = /role=["']status["']/;

// True iff the surface carries a POLITE live region (`aria-live="polite"` on a
// `role="status"` region), so the export confirmation is announced without a focus
// steal.
export const hasPoliteLiveRegion = (source: string): boolean =>
  ARIA_LIVE_POLITE_RE.test(source) && ROLE_STATUS_RE.test(source);
