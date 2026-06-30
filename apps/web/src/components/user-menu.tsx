import { Link, useNavigate } from "@tanstack/react-router";
import { useTheme } from "next-themes";

import { InitialsAvatar } from "@/components/auth/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { authClient } from "@/lib/auth-client";
import { tAuth } from "@/lib/auth-strings";
import { useLocaleStore } from "@/lib/locale-store";

import { Button } from "./ui/button";
import { Skeleton } from "./ui/skeleton";

// The user menu: an initials-avatar trigger carrying an accessible name (the
// member's name/email) that opens profile / settings / theme / language /
// sign-out, each operable. The initials derive locale-aware from the session's
// given_name/family_name with a defined fallback. Signed-out renders the Sign In
// link (unchanged).
export default function UserMenu() {
  const navigate = useNavigate();
  const { data: session, isPending } = authClient.useSession();
  const locale = useLocaleStore((state) => state.locale);
  const toggleLocale = useLocaleStore((state) => state.toggleLocale);
  const { resolvedTheme, setTheme } = useTheme();

  if (isPending) {
    return <Skeleton className="h-9 w-24" />;
  }

  if (!session) {
    return (
      <Link to="/login">
        <Button variant="outline">Sign In</Button>
      </Link>
    );
  }

  const user = session.user as {
    name?: string;
    email?: string;
    given_name?: string;
    family_name?: string;
  };
  const identityLabel = user.name || user.email || "Account";
  // The trigger name carries the member's identity AND the role of the control,
  // so it is both non-empty and discoverable as the account menu.
  const accessibleName = `${identityLabel} account menu`;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={accessibleName}
        render={<Button size="icon" variant="ghost" />}
      >
        <InitialsAvatar
          email={user.email}
          family_name={user.family_name}
          given_name={user.given_name}
          locale={locale}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="bg-card">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{identityLabel}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => navigate({ to: "/dashboard" })}>
            Profile
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => navigate({ to: "/settings/security" })}
          >
            Settings
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() =>
              setTheme(resolvedTheme === "dark" ? "light" : "dark")
            }
          >
            {tAuth(locale, "auth.theme.toggle")}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={toggleLocale}>
            {tAuth(locale, "auth.language.toggle")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => {
              authClient.signOut({
                fetchOptions: {
                  onSuccess: () => {
                    navigate({ to: "/" });
                  },
                },
              });
            }}
            variant="destructive"
          >
            Sign Out
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
