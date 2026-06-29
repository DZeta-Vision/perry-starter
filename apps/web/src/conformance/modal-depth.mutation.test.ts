import { describe, expect, test } from "vitest";

// Proves the modal-depth guard reddens on a nested <Dialog><Dialog/></Dialog>
// fixture, with a single-depth control that stays green. Detector logic is
// re-declared locally (mutation twins never import the gate file).

const SELF_CLOSING_MODAL_RE = /<(?:Dialog|AlertDialog)(?![A-Za-z])[^>]*\/>/g;
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

const SINGLE_DEPTH = `
  <Dialog>
    <DialogTrigger>Open</DialogTrigger>
    <DialogContent>
      <DialogTitle>Confirm</DialogTitle>
    </DialogContent>
  </Dialog>
`;

const NESTED = `
  <Dialog>
    <DialogContent>
      <Dialog>
        <DialogContent>banned modal stack</DialogContent>
      </Dialog>
    </DialogContent>
  </Dialog>
`;

describe("the modal-depth guard reddens on a nested Dialog (single-depth control stays green)", () => {
  test("a nested <Dialog><Dialog/></Dialog> fixture exceeds depth 1; a single Dialog does not", () => {
    expect(maxModalDepth(SINGLE_DEPTH)).toBe(1);
    expect(maxModalDepth(NESTED)).toBeGreaterThanOrEqual(2);
  });
});
