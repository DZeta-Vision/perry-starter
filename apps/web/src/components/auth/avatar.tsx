import { avatarInitials, type InitialsInput } from "@/lib/initials";
import { cn } from "@/lib/utils";

// A locale-aware initials avatar. The initials derive from the session's
// given_name/family_name with a defined fallback (email initial, then a sentinel)
// so it is never blank. The glyph itself is aria-hidden — the accessible name is
// owned by the surrounding trigger/control — and the derived initials are exposed
// via `data-avatar-initials` for the chrome's coverage.
export function InitialsAvatar({
  className,
  ...identity
}: InitialsInput & { className?: string }) {
  const initials = avatarInitials(identity);
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex size-6 items-center justify-center rounded-full bg-primary font-medium text-[10px] text-primary-foreground",
        className
      )}
      data-avatar-initials={initials}
    >
      {initials}
    </span>
  );
}
