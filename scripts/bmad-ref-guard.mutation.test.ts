/// <reference types="node" />
// Anti-vacuous twin for the BMAD-reference guard. The gate promises that ZERO
// planning ids survive in committed code. This twin feeds known-bad input to the
// REAL guard and asserts it goes red — so the "clean" verdict can never pass
// vacuously. It also asserts the self-tooling exemption is NARROW (a planted ref
// in a product file still reddens) and that a clean file is NOT flagged.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const GUARD = join(HERE, "bmad-ref-guard.mjs");

const runGuard = (args: string[]) => {
  try {
    const stdout = execFileSync("node", [GUARD, ...args], {
      cwd: REPO_ROOT,
      stdio: "pipe",
    }).toString();
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    const err = error as { status?: number; stdout?: Buffer; stderr?: Buffer };
    return {
      code: err.status ?? 1,
      stdout: (err.stdout ?? Buffer.from("")).toString(),
      stderr: (err.stderr ?? Buffer.from("")).toString(),
    };
  }
};

const withTree = (run: (dir: string) => void) => {
  const dir = mkdtempSync(join(tmpdir(), "bmad-guard-mut-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const AD_21_REF = /AD-21/;

describe("the BMAD-reference guard genuinely reddens on planted ids", () => {
  test("a product file referencing decision + requirement + story ids is caught", () => {
    withTree((dir) => {
      const file = join(dir, "packages", "x", "src", "leak.ts");
      mkdirSync(dirname(file), { recursive: true });
      // A comment a developer might paste straight out of a planning doc.
      writeFileSync(
        file,
        "// the no-plaintext floor per the decision; the runtime switch lands later\nexport const leak = 1;\n"
      );
      // Append the banned ids via fromCharCode so this twin's own SOURCE stays
      // clean for the guard's self-scan, yet the fixture on disk carries them.
      const dash = String.fromCharCode(45);
      const planted = `// ${`AD${dash}21`} and ${`FR${dash}47`} for ${"Story"} 2.6\n`;
      writeFileSync(file, planted, { flag: "a" });
      const result = runGuard(["--root", dir]);
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(AD_21_REF);
    });
  });

  test("every banned pattern family is individually detected", () => {
    const dash = String.fromCharCode(45);
    const refs = [
      `AD${dash}1`,
      `FR${dash}2`,
      `NFR${dash}3`,
      `E2${dash}R01`,
      "Story 1.2",
      "AC7",
    ];
    for (const ref of refs) {
      withTree((dir) => {
        const file = join(dir, "a.ts");
        writeFileSync(file, `// note: ${ref}\nexport const a = 1;\n`);
        expect(runGuard(["--root", dir]).code).toBe(1);
      });
    }
  });

  test("a genuinely clean file is NOT flagged (not always-red)", () => {
    withTree((dir) => {
      const file = join(dir, "ok.ts");
      writeFileSync(
        file,
        "// the cloud gatekeeper resolves the session and mints the token\nexport const ok = true;\n"
      );
      expect(runGuard(["--root", dir]).code).toBe(0);
    });
  });
});
