import { useState } from "react";

import { Button } from "./ui/button";

type Language = "en" | "fr";

// FR · EN language toggle, rendered strictly as a text affordance — never a flag
// glyph (a flag conflates language with nationality). This is a pre-auth,
// per-device visual choice only: the live string switch and the account-level
// locale persistence are layered on later, so the affordance carries no i18n
// side effect yet.
export default function LanguageToggle() {
  const [language, setLanguage] = useState<Language>("en");

  return (
    <Button
      aria-label="Language"
      onClick={() => setLanguage((current) => (current === "en" ? "fr" : "en"))}
      size="sm"
      type="button"
      variant="ghost"
    >
      <span className={language === "fr" ? "font-semibold" : "opacity-60"}>
        FR
      </span>
      <span aria-hidden="true">·</span>
      <span className={language === "en" ? "font-semibold" : "opacity-60"}>
        EN
      </span>
    </Button>
  );
}
