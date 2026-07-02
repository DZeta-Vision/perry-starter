// Structural guard: every admin route is un-escapable by construction — it routes
// its entry decision through the ONE shared server-side checkpoint, never an
// inline per-route role check. Used by admin-checkpoint.gate.test.ts and its
// mutation twin (test files must not import one another, so the shared logic lives
// here).

export interface RouteSource {
  readonly path: string;
  readonly text: string;
}

// An admin page is a route whose path begins with `/admin`.
const ADMIN_ROUTE_RE = /createFileRoute\(\s*["']\/admin/;
export const isAdminRoute = (text: string): boolean =>
  ADMIN_ROUTE_RE.test(text);

// The single shared checkpoint every admin route must invoke.
const CHECKPOINT_CALL_RE = /assertAdminAccess\s*\(/;
const BEFORE_LOAD_RE = /beforeLoad\s*:/;

// An admin route is guarded iff its `beforeLoad` invokes the shared checkpoint. A
// route with no `beforeLoad`, or one that inlines its own role decision instead of
// delegating to the shared checkpoint, is UNGUARDED (escapable). Returns one path
// per unguarded admin route; empty means every admin route is guarded.
export const findUnguardedAdminRoutes = (
  sources: readonly RouteSource[]
): string[] => {
  const unguarded: string[] = [];
  for (const source of sources) {
    if (!isAdminRoute(source.text)) {
      continue;
    }
    const guarded =
      BEFORE_LOAD_RE.test(source.text) && CHECKPOINT_CALL_RE.test(source.text);
    if (!guarded) {
      unguarded.push(source.path);
    }
  }
  return unguarded;
};
