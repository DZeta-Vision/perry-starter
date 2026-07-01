// Loaded by the "web" Vitest project (see root vitest.config.ts).
// Provides jest-dom matchers (toBeInTheDocument, toHaveAttribute, …) for
// @testing-library/react component tests.
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, vi } from "vitest";

// Vitest globals are not enabled, so @testing-library/react's automatic
// per-test unmount does not register itself; do it explicitly so rendered DOM
// does not accumulate across tests in a file. next-themes writes the resolved
// theme to <html> (class + colorScheme) and persists it to localStorage, so
// reset both as well — otherwise a theme set in one test leaks into the next.
afterEach(() => {
  cleanup();
  document.documentElement.className = "";
  document.documentElement.style.colorScheme = "";
  localStorage.clear();
});

// jsdom does not implement matchMedia; next-themes reads it for the system
// theme. Default to "light" so components that resolve the system preference
// mount cleanly.
if (!window.matchMedia) {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}

// jsdom has no layout engine, so every element reports offsetWidth/offsetHeight
// as 0. @tanstack/react-virtual measures its scroll viewport from those offsets
// and renders an EMPTY window when the viewport measures 0 — so a virtualized
// list would materialize no rows under jsdom. Give elements a non-zero offset
// size and a no-op ResizeObserver so virtualized lists materialize a real
// window in component tests (text/role-query tests are unaffected — jest-dom's
// visibility check does not read offsets).
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {
      return;
    }
    unobserve() {
      return;
    }
    disconnect() {
      return;
    }
  } as unknown as typeof ResizeObserver;
}
const OFFSET_SIZES = [
  ["offsetHeight", 600],
  ["offsetWidth", 800],
] as const;
for (const [prop, value] of OFFSET_SIZES) {
  // jsdom already defines these as getters returning 0; redefine unconditionally.
  Object.defineProperty(HTMLElement.prototype, prop, {
    configurable: true,
    get() {
      return value;
    },
  });
}

// Component tests render shell chrome without a RouterProvider; stub the router
// primitives so a component can be unit-tested in isolation (real navigation is
// covered by the e2e suite).
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    Link: ({ children }: { children?: ReactNode }) => children,
    useNavigate: () => () => undefined,
  };
});
