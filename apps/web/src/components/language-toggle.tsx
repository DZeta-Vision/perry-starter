import { tAuth } from "@/lib/auth-strings";
import { useLocaleStore } from "@/lib/locale-store";

import { Button } from "./ui/button";

// FR · EN language toggle, rendered strictly as a text affordance — never a flag
// glyph (a flag conflates language with nationality). It writes through the
// per-device locale store so every auth surface resolves its copy under the
// active locale. The live account-level locale persistence + the full runtime
// string-switch land in Epic 7; this is the auth-scope, per-device seam.
export default function LanguageToggle() {
  const locale = useLocaleStore((state) => state.locale);
  const toggleLocale = useLocaleStore((state) => state.toggleLocale);

  return (
    <Button
      aria-label={tAuth(locale, "auth.language.toggle")}
      onClick={toggleLocale}
      size="sm"
      type="button"
      variant="ghost"
    >
      <span className={locale === "fr" ? "font-semibold" : "opacity-60"}>
        FR
      </span>
      <span aria-hidden="true">·</span>
      <span className={locale === "en" ? "font-semibold" : "opacity-60"}>
        EN
      </span>
    </Button>
  );
}
