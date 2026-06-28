import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// Modal depth is capped at one level: a Dialog never opens over another Dialog
// (modal stacks more than one deep are banned everywhere). This is the static
// source guard; the runtime single-[role=dialog] assertion is a deferred-blocking
// axe-on-boot leg that lands once apps/web boots headlessly in CI.
//
// Static heuristic: track combined nesting depth of <Dialog>/<AlertDialog> ROOT
// elements (sub-parts like <DialogContent> and the Base-UI primitive aliases in
// dialog.tsx are NOT matched). Depth >= 2 anywhere is a violation.

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..");
const WEB_SRC = resolve(REPO_ROOT, "apps", "web", "src");

const read = (path: string): string => readFileSync(path, "utf8");

// Strip self-closing modal roots first so an unmatched open cannot inflate depth.
const SELF_CLOSING_MODAL_RE = /<(?:Dialog|AlertDialog)(?![A-Za-z])[^>]*\/>/g;
// Match a modal ROOT open `<Dialog`/`<AlertDialog` or close `</Dialog>` — the
// negative lookahead rejects `<DialogContent`, `<DialogTrigger`, etc.
const MODAL_TOKEN_RE = /<\/?(?:Dialog|AlertDialog)(?![A-Za-z])/g;

const maxModalDepth = (source: string): number => {
  const cleaned = source.replace(SELF_CLOSING_MODAL_RE, "");
  let depth = 0;
  let max = 0;
  for (const match of cleaned.matchAll(MODAL_TOKEN_RE)) {
    if (match[0].startsWith("</")) {
      depth = Math.max(0, depth - 1);
    } else {
      depth++;
      if (depth > max) {
        max = depth;
      }
    }
  }
  return max;
};

const collectTsx = (dir: string, out: string[]): void => {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // The conformance dir holds fixtures/strings that mention <Dialog> in tests.
      if (entry.name !== "node_modules" && entry.name !== "conformance") {
        collectTsx(full, out);
      }
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".tsx") &&
      !entry.name.endsWith(".test.tsx")
    ) {
      out.push(full);
    }
  }
};

describe("modal depth is capped at one level across apps/web/src", () => {
  test("no .tsx renders a Dialog/AlertDialog root nested inside another modal's subtree", () => {
    const files: string[] = [];
    collectTsx(WEB_SRC, files);
    const offenders: string[] = [];
    for (const file of files) {
      if (maxModalDepth(read(file)) >= 2) {
        offenders.push(file.slice(REPO_ROOT.length + 1));
      }
    }
    expect(offenders).toEqual([]);
  });
});
