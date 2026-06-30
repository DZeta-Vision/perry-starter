import { Building01Icon, UnfoldMoreIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import { Button } from "./ui/button";

export interface OrgSummary {
  readonly id: string;
  readonly name: string;
}

// The org switcher: a DropdownMenu whose trigger carries an accessible name and
// shows the ACTIVE organization's name + avatar. Opening it lists the member's
// organizations; selecting another re-scopes the surface — the active-org
// indicator updates (a switcher that never re-scopes would leave it unchanged).
// The active org is held locally here (the worker re-scopes server-side on the
// real switch); seeded from props so it renders in the authenticated chrome and
// is exercisable in tests.
export default function OrgSwitcher({
  organizations,
  defaultActiveId,
}: {
  organizations: readonly OrgSummary[];
  defaultActiveId?: string;
}) {
  const [activeId, setActiveId] = useState(
    defaultActiveId ?? organizations[0]?.id
  );
  const active =
    organizations.find((org) => org.id === activeId) ?? organizations[0];

  if (!active) {
    return null;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Switch organization"
        render={<Button variant="outline" />}
      >
        <HugeiconsIcon aria-hidden="true" icon={Building01Icon} />
        <span data-active-org>{active.name}</span>
        <HugeiconsIcon aria-hidden="true" icon={UnfoldMoreIcon} />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="bg-card">
        {organizations.map((org) => (
          <DropdownMenuItem key={org.id} onClick={() => setActiveId(org.id)}>
            {org.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
