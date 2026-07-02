// One-click GDPR data-export panel.
//
// A SINGLE export action — no multi-step wizard: one click asks the server for a
// machine-readable dump of the signed-in subject's OWN records (the server scopes
// it to the session subject; the client never supplies a subject id) and offers it
// as a download. The export-ready confirmation is announced through a POLITE live
// region (`aria-live="polite"` / role="status"), so a screen reader hears it
// without a focus steal. Every visible string is locale-keyed (EN/FR) via the
// hand-rolled `data-rights-strings` catalog — no untranslated literal on the
// surface.
//
// The network call is an INJECTED seam (`onExport`) so the panel is a pure,
// testable renderer; the route wires the real tRPC client call to the gatekeeper
// Worker surface.

import { useState } from "react";

import {
  type DataRightsKey,
  type Locale,
  tDataRights,
} from "@/lib/data-rights-strings";

type ExportPhase = "idle" | "pending" | "ready" | "error";

export interface DataExportPanelProps {
  readonly locale: Locale;
  // The export seam: resolves the machine-readable bundle (any JSON-serializable
  // shape). Injected so the panel renders/tests without a live backend.
  readonly onExport: () => Promise<unknown>;
}

const EXPORT_FILENAME = "my-data-export.json";

// Build a self-contained download href for the bundle. A `data:` URL needs no
// `URL.createObjectURL`, so the download works the same in the browser and in the
// test environment.
const toDownloadHref = (bundle: unknown): string =>
  `data:application/json;charset=utf-8,${encodeURIComponent(
    JSON.stringify(bundle, null, 2)
  )}`;

export function DataExportPanel({ locale, onExport }: DataExportPanelProps) {
  const [phase, setPhase] = useState<ExportPhase>("idle");
  const [href, setHref] = useState<string | null>(null);

  const t = (key: DataRightsKey): string => tDataRights(locale, key);

  const handleExport = async () => {
    setPhase("pending");
    setHref(null);
    try {
      const bundle = await onExport();
      setHref(toDownloadHref(bundle));
      setPhase("ready");
    } catch {
      setPhase("error");
    }
  };

  return (
    <section aria-labelledby="data-export-heading" className="space-y-3">
      <h2 className="font-semibold text-lg" id="data-export-heading">
        {t("dataRights.export.heading")}
      </h2>
      <p
        className="block text-muted-foreground text-sm"
        id="data-export-description"
      >
        {t("dataRights.export.description")}
      </p>
      <button
        aria-describedby="data-export-description"
        className="inline-flex items-center rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground text-sm disabled:opacity-60"
        disabled={phase === "pending"}
        id="data-export-action"
        onClick={handleExport}
        type="button"
      >
        {phase === "pending"
          ? t("dataRights.export.pending")
          : t("dataRights.export.action")}
      </button>
      {/* The POLITE live region: the export-ready confirmation (with its download
          link) and any error are announced here without stealing focus. Empty
          otherwise, so the announcement fires only on a state change. */}
      <div
        aria-live="polite"
        className="min-h-6 text-sm"
        data-testid="data-export-status"
        role="status"
      >
        {phase === "ready" && href ? (
          <span className="flex items-center gap-2">
            <span>{t("dataRights.export.ready")}</span>
            <a
              className="font-medium underline"
              download={EXPORT_FILENAME}
              href={href}
            >
              {t("dataRights.export.download")}
            </a>
          </span>
        ) : null}
        {phase === "error" ? (
          <span className="text-destructive">
            {t("dataRights.export.error")}
          </span>
        ) : null}
      </div>
    </section>
  );
}
