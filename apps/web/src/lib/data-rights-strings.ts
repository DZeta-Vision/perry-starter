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
  | "dataRights.export.error"
  | "dataRights.erasure.heading"
  | "dataRights.erasure.description"
  | "dataRights.erasure.action"
  | "dataRights.erasure.confirmTitle"
  | "dataRights.erasure.confirmBody"
  | "dataRights.erasure.confirmCta"
  | "dataRights.erasure.cancel"
  | "dataRights.erasure.stepUpNotice"
  | "dataRights.erasure.pending"
  | "dataRights.erasure.requested"
  | "dataRights.erasure.error";

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
  "dataRights.erasure.heading",
  "dataRights.erasure.description",
  "dataRights.erasure.action",
  "dataRights.erasure.confirmTitle",
  "dataRights.erasure.confirmBody",
  "dataRights.erasure.confirmCta",
  "dataRights.erasure.cancel",
  "dataRights.erasure.stepUpNotice",
  "dataRights.erasure.pending",
  "dataRights.erasure.requested",
  "dataRights.erasure.error",
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
  "dataRights.erasure.heading": "Erase your account",
  "dataRights.erasure.description":
    "Request erasure of your account and personal data. Your account is deactivated and scheduled for permanent deletion; it stays recoverable until then.",
  "dataRights.erasure.action": "Request account erasure",
  "dataRights.erasure.confirmTitle": "Erase your account?",
  "dataRights.erasure.confirmBody":
    "This deactivates your account and schedules it for permanent deletion. It stays recoverable until the scheduled deletion runs. You will be asked to confirm your identity before it proceeds.",
  "dataRights.erasure.confirmCta": "Yes, request erasure",
  "dataRights.erasure.cancel": "Cancel",
  "dataRights.erasure.stepUpNotice":
    "Confirm your identity to complete the erasure request.",
  "dataRights.erasure.pending": "Recording your erasure request…",
  "dataRights.erasure.requested":
    "Your erasure request has been recorded. Your account is scheduled for deletion and stays recoverable until then.",
  "dataRights.erasure.error":
    "We couldn't record your erasure request. Please try again.",
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
  "dataRights.erasure.heading": "Effacer votre compte",
  "dataRights.erasure.description":
    "Demandez l'effacement de votre compte et de vos données personnelles. Votre compte est désactivé et programmé pour une suppression définitive ; il reste récupérable jusque-là.",
  "dataRights.erasure.action": "Demander l'effacement du compte",
  "dataRights.erasure.confirmTitle": "Effacer votre compte ?",
  "dataRights.erasure.confirmBody":
    "Cette action désactive votre compte et le programme pour une suppression définitive. Il reste récupérable jusqu'à l'exécution de la suppression programmée. Vous devrez confirmer votre identité avant que l'opération ne se poursuive.",
  "dataRights.erasure.confirmCta": "Oui, demander l'effacement",
  "dataRights.erasure.cancel": "Annuler",
  "dataRights.erasure.stepUpNotice":
    "Confirmez votre identité pour finaliser la demande d'effacement.",
  "dataRights.erasure.pending": "Enregistrement de votre demande d'effacement…",
  "dataRights.erasure.requested":
    "Votre demande d'effacement a été enregistrée. Votre compte est programmé pour suppression et reste récupérable jusque-là.",
  "dataRights.erasure.error":
    "Nous n'avons pas pu enregistrer votre demande d'effacement. Veuillez réessayer.",
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
