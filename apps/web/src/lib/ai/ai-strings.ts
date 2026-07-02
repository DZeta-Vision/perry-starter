// AI-surface FR/EN string catalog (the assistant's own fixed UI copy).
//
// The full Lingui runtime lands with the i18n floor later; this module is the
// keyed subset the assistant surface needs NOW: the typing/stop/unavailable
// controls and the per-code terminal-error copy keyed by `ai.error.<CODE>`. Keys
// mirror the future Lingui `ai.*` namespace so the migration is a catalog swap,
// not a rewrite. Resolution is a pure lookup with an EN fallback — never throws.

import type { Locale } from "../auth-strings";

// The stable provider-agnostic terminal code the whole surface degrades to.
export const ASSISTANT_UNAVAILABLE_CODE = "ASSISTANT_UNAVAILABLE";

type AiStringKey =
  | "ai.chat.title"
  | "ai.chat.placeholder"
  | "ai.chat.send"
  | "ai.chat.typing"
  | "ai.chat.stop"
  | "ai.chat.stopped"
  | "ai.chat.empty"
  | "ai.chat.liveRegionLabel"
  | "ai.provenance.cloud"
  | `ai.error.${string}`;

const EN: Record<string, string> = {
  "ai.chat.title": "Assistant",
  "ai.chat.placeholder": "Ask anything about your documents…",
  "ai.chat.send": "Send",
  "ai.chat.typing": "Thinking…",
  "ai.chat.stop": "Stop",
  "ai.chat.stopped": "Stopped. You can edit the partial reply or ask again.",
  "ai.chat.empty": "Nothing here yet. Ask your first question.",
  "ai.chat.liveRegionLabel": "Assistant reply",
  "ai.provenance.cloud": "via cloud",
  "ai.error.ASSISTANT_UNAVAILABLE":
    "The assistant is unavailable right now. Your work is unaffected — try again in a moment.",
};

const FR: Record<string, string> = {
  "ai.chat.title": "Assistant",
  "ai.chat.placeholder": "Posez une question sur vos documents…",
  "ai.chat.send": "Envoyer",
  "ai.chat.typing": "Réflexion en cours…",
  "ai.chat.stop": "Arrêter",
  "ai.chat.stopped":
    "Arrêté. Vous pouvez modifier la réponse partielle ou poser une nouvelle question.",
  "ai.chat.empty": "Rien pour le moment. Posez votre première question.",
  "ai.chat.liveRegionLabel": "Réponse de l'assistant",
  "ai.provenance.cloud": "via le cloud",
  "ai.error.ASSISTANT_UNAVAILABLE":
    "L'assistant est momentanément indisponible. Votre travail n'est pas affecté — réessayez dans un instant.",
};

const CATALOG: Record<Locale, Record<string, string>> = { en: EN, fr: FR };

// Resolve a key under a locale, falling back to EN then the key itself.
export const tAi = (locale: Locale, key: AiStringKey): string =>
  CATALOG[locale]?.[key] ?? EN[key] ?? key;

// The keyed copy for a normalized terminal error code (`ai.error.<CODE>`); an
// unknown code falls back to the generic unavailable line, never a raw code.
export const aiErrorText = (locale: Locale, code: string): string => {
  const key = `ai.error.${code}` as const;
  const catalog = CATALOG[locale] ?? EN;
  return catalog[key] ?? EN[key] ?? EN["ai.error.ASSISTANT_UNAVAILABLE"];
};

export type { AiStringKey };
