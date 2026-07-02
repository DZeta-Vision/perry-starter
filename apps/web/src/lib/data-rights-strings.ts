// Data-rights FR/EN string catalog (the GDPR self-service surface).
//
// The full Lingui runtime + the live FR string-switch land with the i18n floor in
// a later epic; this module is the data-rights keyed subset the settings surface
// needs NOW — the export heading/description/action and the export-lifecycle
// announcements, each in EN and FR. Keys mirror the eventual `dataRights.*` Lingui
// namespace so the later migration is a catalog swap, not a rewrite. Resolution is
// a pure lookup with an EN fallback — never throwing on an unknown locale/key.

export type Locale = "en" | "fr";

// The keys this catalog resolves. Every user-visible string on the data-rights
// surface MUST come through one of these — no untranslated literal on the surface.
export type DataRightsKey =
  | "dataRights.title"
  | "dataRights.export.heading"
  | "dataRights.export.description"
  | "dataRights.export.action"
  | "dataRights.export.pending"
  | "dataRights.export.ready"
  | "dataRights.export.download"
  | "dataRights.export.error";

// The full key set (single-sourced), so a conformance gate can assert EN/FR parity
// without re-listing the keys.
export const DATA_RIGHTS_KEYS: readonly DataRightsKey[] = [
  "dataRights.title",
  "dataRights.export.heading",
  "dataRights.export.description",
  "dataRights.export.action",
  "dataRights.export.pending",
  "dataRights.export.ready",
  "dataRights.export.download",
  "dataRights.export.error",
];

const EN: Record<DataRightsKey, string> = {
  "dataRights.title": "Your data",
  "dataRights.export.heading": "Export your data",
  "dataRights.export.description":
    "Download a machine-readable copy of the data linked to your account. The export includes only your own records.",
  "dataRights.export.action": "Export my data",
  "dataRights.export.pending": "Preparing your export…",
  "dataRights.export.ready": "Your export is ready.",
  "dataRights.export.download": "Download the file",
  "dataRights.export.error":
    "We couldn't prepare your export. Please try again.",
};

// FR copy — deliberately fuller wording (the FR strings run noticeably longer than
// EN, exercising the no-truncation layout budget).
const FR: Record<DataRightsKey, string> = {
  "dataRights.title": "Vos données",
  "dataRights.export.heading": "Exporter vos données",
  "dataRights.export.description":
    "Téléchargez une copie lisible par machine des données liées à votre compte. L'export ne contient que vos propres enregistrements.",
  "dataRights.export.action": "Exporter mes données",
  "dataRights.export.pending": "Préparation de votre export en cours…",
  "dataRights.export.ready": "Votre export est prêt.",
  "dataRights.export.download": "Télécharger le fichier",
  "dataRights.export.error":
    "Nous n'avons pas pu préparer votre export. Veuillez réessayer.",
};

export const dataRightsCatalog: Record<
  Locale,
  Record<DataRightsKey, string>
> = {
  en: EN,
  fr: FR,
};

// Resolve a key under a locale, falling back to EN then the key itself — never
// throwing on an unknown locale/key.
export const tDataRights = (locale: Locale, key: DataRightsKey): string =>
  dataRightsCatalog[locale]?.[key] ?? EN[key] ?? key;
