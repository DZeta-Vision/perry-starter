import { useState } from "react";

import { Button } from "./ui/button";

export interface DeviceSession {
  readonly id: string;
  readonly label: string;
  // An ISO-8601 timestamp of the device's last activity.
  readonly lastUsedAt: string;
}

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const relativeFormatter = new Intl.RelativeTimeFormat("en", {
  numeric: "auto",
});

// Human relative phrasing ("2 hours ago") alongside the machine time. Falls back
// to the raw value if the timestamp is unparseable, so the row never renders
// empty.
const relativeLastUsed = (iso: string): string => {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) {
    return iso;
  }
  const deltaMs = then - Date.now();
  const absMs = Math.abs(deltaMs);
  if (absMs >= DAY_MS) {
    return relativeFormatter.format(Math.round(deltaMs / DAY_MS), "day");
  }
  if (absMs >= HOUR_MS) {
    return relativeFormatter.format(Math.round(deltaMs / HOUR_MS), "hour");
  }
  if (absMs >= MINUTE_MS) {
    return relativeFormatter.format(Math.round(deltaMs / MINUTE_MS), "minute");
  }
  return relativeFormatter.format(Math.round(deltaMs / SECOND_MS), "second");
};

// The per-device last-used list. Each row shows a relative-phrasing last-used
// indicator alongside an absolute machine-readable <time datetime> (ISO-8601) and
// a per-device revoke control. Revoking marks the row revoked (and disables it),
// so the change is observable. Last-used is a LOCAL-only indicator (no remote
// telemetry); the real session revoke is wired to the worker via onRevoke.
export default function DeviceList({
  devices,
  onRevoke,
}: {
  devices: readonly DeviceSession[];
  onRevoke?: (id: string) => void;
}) {
  const [revoked, setRevoked] = useState<readonly string[]>([]);

  return (
    <ul className="space-y-2">
      {devices.map((device) => {
        const isRevoked = revoked.includes(device.id);
        return (
          <li
            className="flex items-center justify-between border border-border p-3"
            data-device-row
            data-revoked={isRevoked || undefined}
            key={device.id}
          >
            <div className="text-sm">
              <span className="font-medium">{device.label}</span>{" "}
              <span className="text-muted-foreground">
                last used{" "}
                <time dateTime={device.lastUsedAt}>
                  {relativeLastUsed(device.lastUsedAt)}
                </time>
              </span>
            </div>
            <Button
              aria-label={`Revoke ${device.label}`}
              disabled={isRevoked}
              onClick={() => {
                setRevoked((current) => [...current, device.id]);
                onRevoke?.(device.id);
              }}
              type="button"
              variant="destructive"
            >
              {isRevoked ? "Revoked" : "Revoke"}
            </Button>
          </li>
        );
      })}
    </ul>
  );
}
