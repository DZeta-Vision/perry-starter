// A polite, form-level error summary. It lives in an `aria-live="polite"` /
// role="status" region so a screen reader ANNOUNCES the message without stealing
// focus, and it is state-driven: with no error the region renders empty (so the
// announcement fires only when an error is present, never always-on). The copy is
// always the GENERIC neutral message — it never reveals account existence/state.
export function ErrorSummary({
  message,
  id,
}: {
  readonly message?: string;
  readonly id?: string;
}) {
  return (
    <div
      aria-live="polite"
      className="min-h-5 text-destructive text-xs"
      id={id}
      role="status"
    >
      {message ?? ""}
    </div>
  );
}
