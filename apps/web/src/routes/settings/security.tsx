import { createFileRoute } from "@tanstack/react-router";

import DeviceList, { type DeviceSession } from "@/components/device-list";
import OrgSwitcher, { type OrgSummary } from "@/components/org-switcher";

export const Route = createFileRoute("/settings/security")({
  component: RouteComponent,
});

// Placeholder org + device data. The real organization list and the per-device
// session list are served by the worker data layer (later epics); this seeds the
// authenticated-chrome surface so the org switcher and the per-device last-used
// rows render and are exercisable.
const ORGS: readonly OrgSummary[] = [
  { id: "org-personal", name: "Personal Workspace" },
  { id: "org-acme", name: "Acme Inc" },
];

const DEVICES: readonly DeviceSession[] = [
  {
    id: "device-current",
    label: "This device",
    lastUsedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
  },
  {
    id: "device-phone",
    label: "iPhone",
    lastUsedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
  },
];

function RouteComponent() {
  return (
    <div className="mx-auto w-full max-w-2xl space-y-8 p-6">
      <section>
        <h1 className="mb-4 font-bold text-2xl">Security</h1>
        <OrgSwitcher organizations={ORGS} />
      </section>
      <section>
        <h2 className="mb-4 font-semibold text-lg">Devices</h2>
        <DeviceList devices={DEVICES} />
      </section>
    </div>
  );
}
