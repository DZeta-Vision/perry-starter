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
