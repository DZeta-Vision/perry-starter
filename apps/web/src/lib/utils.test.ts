import { expect, test } from "vitest";
import { cn } from "./utils";

// Harness smoke test — proves the "web" Vitest project (jsdom + v8 coverage)
// runs against real apps/web code. Real coverage arrives via TD → ATDD.
test("cn merges class names and de-dupes conflicting tailwind utilities", () => {
  expect(cn("px-2", "px-4")).toBe("px-4");
  expect(cn("text-sm", false, "font-bold")).toBe("text-sm font-bold");
});
