// Auth-scope FR/EN string catalog (the initial auth subset).
//
// The full Lingui runtime + the live FR string-switch land later;
// this module is the auth-scope keyed subset the auth surfaces need NOW: the
// generic anti-enumeration error copy, the per-code treatment copy keyed by
// `auth.error.<CODE>`, and the form labels/placeholders/actions — each in EN and
// FR. Keys mirror the Lingui `auth.*` namespace so the later full-runtime migration is a
// catalog swap, not a rewrite. Resolution is a pure lookup with an EN fallback.
//
// SECURITY: every error message is GENERIC. None confirms or denies that an
// account exists or its verification state — the registered and unregistered
// cases resolve the SAME copy, foreclosing account enumeration.

import type { AuthErrorCode } from "./auth-error";

export type Locale = "en" | "fr";

// The keys this catalog resolves. The `auth.error.<CODE>` keys cover the eight
// state-machine codes; the rest are the form/surface copy.
type AuthStringKey =
  | "auth.error.generic"
  | "auth.neutral.maybeSent"
  | `auth.error.${AuthErrorCode}`
  | "auth.signIn.title"
  | "auth.signIn.submit"
  | "auth.signIn.switch"
  | "auth.signUp.title"
  | "auth.signUp.submit"
  | "auth.signUp.switch"
  | "auth.reset.title"
  | "auth.reset.submit"
  | "auth.change.title"
  | "auth.change.submit"
  | "auth.field.email.label"
  | "auth.field.email.placeholder"
  | "auth.field.password.label"
  | "auth.field.password.placeholder"
  | "auth.field.newPassword.label"
  | "auth.field.newPassword.placeholder"
  | "auth.field.name.label"
  | "auth.field.name.placeholder"
  | "auth.reveal.show"
  | "auth.reveal.hide"
  | "auth.theme.toggle"
  | "auth.language.toggle"
  | "auth.verify.resend"
  | "auth.locked.action"
  | "auth.twoFactor.codeLabel"
  | "auth.forward.backToSignIn";

const EN: Record<AuthStringKey, string> = {
  "auth.error.generic":
    "We couldn't complete that request. Check your details and try again.",
  "auth.neutral.maybeSent":
    "If that account can receive it, a link is on the way. Check your inbox.",
  "auth.error.UNAUTHORIZED": "Please sign in to continue.",
  "auth.error.SESSION_EXPIRED": "Your session ended. Please sign in again.",
  "auth.error.EMAIL_NOT_VERIFIED":
    "Confirm your email address to continue. Check your inbox for the link.",
  "auth.error.PASSWORD_CHANGE_REQUIRED":
    "Set a new password to continue. This step can't be skipped.",
  "auth.error.TWO_FACTOR_REQUIRED":
    "An extra verification step is needed to continue.",
  "auth.error.STEP_UP_REQUIRED":
    "Please confirm it's you to continue with this action.",
  "auth.error.ACCOUNT_LOCKED":
    "Access is temporarily unavailable. Complete the check below to continue.",
  "auth.error.FORBIDDEN": "You don't have access to this.",
  "auth.signIn.title": "Welcome back",
  "auth.signIn.submit": "Sign in",
  "auth.signIn.switch": "Need an account? Sign up",
  "auth.signUp.title": "Create account",
  "auth.signUp.submit": "Sign up",
  "auth.signUp.switch": "Already have an account? Sign in",
  "auth.reset.title": "Reset your password",
  "auth.reset.submit": "Send reset link",
  "auth.change.title": "Change your password",
  "auth.change.submit": "Update password",
  "auth.field.email.label": "Email",
  "auth.field.email.placeholder": "you@example.com",
  "auth.field.password.label": "Password",
  "auth.field.password.placeholder": "Your password",
  "auth.field.newPassword.label": "New password",
  "auth.field.newPassword.placeholder": "Choose a new password",
  "auth.field.name.label": "Name",
  "auth.field.name.placeholder": "Your name",
  "auth.reveal.show": "Show password",
  "auth.reveal.hide": "Hide password",
  "auth.theme.toggle": "Toggle theme",
  "auth.language.toggle": "Language",
  "auth.verify.resend": "Resend the link",
  "auth.locked.action": "Continue",
  "auth.twoFactor.codeLabel": "Authentication code",
  "auth.forward.backToSignIn": "Back to sign in",
};

// FR copy — deliberately fuller wording (the FR strings run noticeably longer
// than EN, exercising the +35% no-truncation layout budget).
const FR: Record<AuthStringKey, string> = {
  "auth.error.generic":
    "Nous n'avons pas pu traiter votre demande. Vérifiez vos informations puis réessayez.",
  "auth.neutral.maybeSent":
    "Si ce compte peut le recevoir, un lien est en route. Consultez votre boîte de réception.",
  "auth.error.UNAUTHORIZED": "Veuillez vous connecter pour continuer.",
  "auth.error.SESSION_EXPIRED":
    "Votre session a pris fin. Veuillez vous reconnecter pour continuer.",
  "auth.error.EMAIL_NOT_VERIFIED":
    "Confirmez votre adresse e-mail pour continuer. Consultez votre boîte de réception pour le lien.",
  "auth.error.PASSWORD_CHANGE_REQUIRED":
    "Définissez un nouveau mot de passe pour continuer. Cette étape ne peut pas être ignorée.",
  "auth.error.TWO_FACTOR_REQUIRED":
    "Une étape de vérification supplémentaire est nécessaire pour continuer.",
  "auth.error.STEP_UP_REQUIRED":
    "Veuillez confirmer votre identité pour poursuivre cette action.",
  "auth.error.ACCOUNT_LOCKED":
    "L'accès est temporairement indisponible. Effectuez la vérification ci-dessous pour continuer.",
  "auth.error.FORBIDDEN": "Vous n'avez pas accès à cette ressource.",
  "auth.signIn.title": "Content de vous revoir",
  "auth.signIn.submit": "Se connecter",
  "auth.signIn.switch": "Besoin d'un compte ? Inscrivez-vous",
  "auth.signUp.title": "Créer un compte",
  "auth.signUp.submit": "S'inscrire",
  "auth.signUp.switch": "Vous avez déjà un compte ? Connectez-vous",
  "auth.reset.title": "Réinitialiser votre mot de passe",
  "auth.reset.submit": "Envoyer le lien de réinitialisation",
  "auth.change.title": "Modifier votre mot de passe",
  "auth.change.submit": "Mettre à jour le mot de passe",
  "auth.field.email.label": "Adresse e-mail",
  "auth.field.email.placeholder": "vous@exemple.com",
  "auth.field.password.label": "Mot de passe",
  "auth.field.password.placeholder": "Votre mot de passe",
  "auth.field.newPassword.label": "Nouveau mot de passe",
  "auth.field.newPassword.placeholder": "Choisissez un nouveau mot de passe",
  "auth.field.name.label": "Nom",
  "auth.field.name.placeholder": "Votre nom",
  "auth.reveal.show": "Afficher le mot de passe",
  "auth.reveal.hide": "Masquer le mot de passe",
  "auth.theme.toggle": "Changer le thème",
  "auth.language.toggle": "Langue",
  "auth.verify.resend": "Renvoyer le lien",
  "auth.locked.action": "Continuer",
  "auth.twoFactor.codeLabel": "Code d'authentification",
  "auth.forward.backToSignIn": "Retour à la connexion",
};

const CATALOG: Record<Locale, Record<AuthStringKey, string>> = {
  en: EN,
  fr: FR,
};

// Resolve a key under a locale, falling back to EN then the key itself — never
// throwing on an unknown locale/key (unlike Lingui's `i18n._`).
export const tAuth = (locale: Locale, key: AuthStringKey): string =>
  CATALOG[locale]?.[key] ?? EN[key] ?? key;

// The Lingui key for a code's treatment copy (`auth.error.<CODE>`).
export const authErrorKey = (
  code: AuthErrorCode
): `auth.error.${AuthErrorCode}` => `auth.error.${code}`;

export type { AuthStringKey };
