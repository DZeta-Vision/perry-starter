#!/usr/bin/env node
// WCAG-AA contrast gate (RUNNABLE NOW, BLOCKING).
//
// Parses apps/web/src/index.css, extracts the load-bearing design-token pairs in
// BOTH themes (:root = light, .dark = dark), resolves each oklch() color to sRGB,
// computes the WCAG 2.x contrast ratio, prints the measured ratio for every pair
// (the measured ratio is recorded), and EXITS NON-ZERO if any
// required pair is below its threshold.
//
// Dependency-free and deterministic. Implements the full colour pipeline here:
//   oklch (L, C, H)  ->  OKLab  ->  linear sRGB  ->  gamma sRGB  ->  relative
//   luminance  ->  WCAG contrast ratio.
//
// Thresholds (the accessibility floor):
//   - primary <-> primary-foreground            >= 4.5:1  (text on the brand fill)
//   - primary-as-link <-> background            >= 4.5:1  (teal used as a link/active colour)
//   - focus-ring (ring) <-> background           >= 3:1   (non-text UI / focus indicator, WCAG 1.4.11)
//
// Source of truth for tokens: apps/web/src/index.css.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const CSS_PATH = resolve(REPO_ROOT, "apps/web/src/index.css");

const TEXT_CONTRAST_MIN = 4.5; // WCAG 1.4.3 AA, normal text
const UI_CONTRAST_MIN = 3.0; // WCAG 1.4.11 AA, non-text / focus indicator
const RATIO_PRECISION = 2;

// --- colour pipeline -------------------------------------------------------

// sRGB transfer function (linear -> gamma-encoded channel, 0..1).
const linearToGamma = (channel) => {
  const LINEAR_THRESHOLD = 0.003_130_8;
  const GAMMA_SLOPE = 12.92;
  const GAMMA_SCALE = 1.055;
  const GAMMA_EXP = 1 / 2.4;
  const GAMMA_OFFSET = 0.055;
  if (channel <= LINEAR_THRESHOLD) {
    return channel * GAMMA_SLOPE;
  }
  return GAMMA_SCALE * channel ** GAMMA_EXP - GAMMA_OFFSET;
};

// gamma-encoded sRGB channel (0..1) -> linear-light channel (0..1).
const gammaToLinear = (channel) => {
  const GAMMA_THRESHOLD = 0.040_45;
  const GAMMA_SLOPE = 12.92;
  const GAMMA_SCALE = 1.055;
  const GAMMA_OFFSET = 0.055;
  const GAMMA_EXP = 2.4;
  if (channel <= GAMMA_THRESHOLD) {
    return channel / GAMMA_SLOPE;
  }
  return ((channel + GAMMA_OFFSET) / GAMMA_SCALE) ** GAMMA_EXP;
};

const clamp01 = (value) => Math.min(1, Math.max(0, value));

// OKLCH (L 0..1, C, H degrees) -> OKLab -> linear sRGB (r,g,b 0..1, unclamped).
const oklchToLinearSrgb = (lightness, chroma, hueDeg) => {
  const hueRad = (hueDeg * Math.PI) / 180;
  const aLab = chroma * Math.cos(hueRad);
  const bLab = chroma * Math.sin(hueRad);

  // OKLab -> LMS' (cube roots), per Björn Ottosson's reference matrices.
  const lPrime = lightness + 0.396_337_777_4 * aLab + 0.215_803_757_3 * bLab;
  const mPrime = lightness - 0.105_561_345_8 * aLab - 0.063_854_172_8 * bLab;
  const sPrime = lightness - 0.089_484_177_5 * aLab - 1.291_485_548 * bLab;

  const lLms = lPrime ** 3;
  const mLms = mPrime ** 3;
  const sLms = sPrime ** 3;

  const r =
    4.076_741_662_1 * lLms - 3.307_711_591_3 * mLms + 0.230_969_929_2 * sLms;
  const g =
    -1.268_438_004_6 * lLms + 2.609_757_401_1 * mLms - 0.341_319_396_5 * sLms;
  const b =
    -0.004_196_086_3 * lLms - 0.703_418_614_7 * mLms + 1.707_614_701 * sLms;

  return { r, g, b };
};

// Relative luminance (WCAG 2.x) from gamma-encoded sRGB channels (0..1).
const relativeLuminance = ({ r, g, b }) => {
  const rLin = gammaToLinear(r);
  const gLin = gammaToLinear(g);
  const bLin = gammaToLinear(b);
  return 0.2126 * rLin + 0.7152 * gLin + 0.0722 * bLin;
};

// Full resolve: oklch token -> gamma-encoded, gamut-clamped sRGB (0..1).
const oklchToSrgb = ({ l, c, h }) => {
  const linear = oklchToLinearSrgb(l, c, h);
  return {
    r: clamp01(linearToGamma(clamp01(linear.r))),
    g: clamp01(linearToGamma(clamp01(linear.g))),
    b: clamp01(linearToGamma(clamp01(linear.b))),
  };
};

const contrastRatio = (colorA, colorB) => {
  const lumA = relativeLuminance(colorA);
  const lumB = relativeLuminance(colorB);
  const lighter = Math.max(lumA, lumB);
  const darker = Math.min(lumA, lumB);
  const WCAG_FLARE = 0.05;
  return (lighter + WCAG_FLARE) / (darker + WCAG_FLARE);
};

// --- CSS token parsing -----------------------------------------------------

// Match `oklch( L C H )` with optional alpha (alpha ignored; tokens here are opaque).
const OKLCH_RE =
  /oklch\(\s*([\d.]+%?)\s+([\d.]+%?)\s+([\d.]+%?)\s*(?:\/\s*[\d.]+%?\s*)?\)/i;

const WHITESPACE_RE = /\s/;

const parseNumberOrPercent = (raw, percentBase) => {
  if (raw.endsWith("%")) {
    return (Number.parseFloat(raw) / 100) * percentBase;
  }
  return Number.parseFloat(raw);
};

const parseOklch = (value) => {
  const match = value.match(OKLCH_RE);
  if (!match) {
    return null;
  }
  const PERCENT_HUE_BASE = 360;
  return {
    l: parseNumberOrPercent(match[1], 1),
    c: parseNumberOrPercent(match[2], 0.4),
    h: parseNumberOrPercent(match[3], PERCENT_HUE_BASE),
  };
};

// Find where `selector` heads a rule block: the selector text followed (after
// optional whitespace) by `{`. Plain indexOf is wrong — `.dark` also appears
// inside `@custom-variant dark (&:is(.dark *))`, which must NOT be matched.
const findBlockStart = (css, selector) => {
  let from = 0;
  for (;;) {
    const idx = css.indexOf(selector, from);
    if (idx === -1) {
      return -1;
    }
    let cursor = idx + selector.length;
    while (cursor < css.length && WHITESPACE_RE.test(css[cursor])) {
      cursor++;
    }
    if (css[cursor] === "{") {
      return cursor;
    }
    from = idx + selector.length;
  }
};

// Extract the `:root { ... }` and `.dark { ... }` blocks and pull their
// `--token: value;` declarations into a flat map per theme.
const extractBlock = (css, selector) => {
  const braceStart = findBlockStart(css, selector);
  if (braceStart === -1) {
    return null;
  }
  let depth = 0;
  let end = -1;
  for (let i = braceStart; i < css.length; i++) {
    if (css[i] === "{") {
      depth++;
    } else if (css[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) {
    return null;
  }
  return css.slice(braceStart + 1, end);
};

const TOKEN_DECL_RE = /(--[\w-]+)\s*:\s*([^;]+);/g;

const parseTokens = (block) => {
  const tokens = new Map();
  let match = TOKEN_DECL_RE.exec(block);
  while (match !== null) {
    tokens.set(match[1].trim(), match[2].trim());
    match = TOKEN_DECL_RE.exec(block);
  }
  return tokens;
};

const resolveToken = (tokens, name) => {
  const raw = tokens.get(name);
  if (raw === undefined) {
    return null;
  }
  return parseOklch(raw);
};

// --- gate ------------------------------------------------------------------

// Required pairs. `tokens` are token names resolved per-theme; `min` is the
// WCAG threshold the measured ratio must meet or exceed.
const REQUIRED_PAIRS = [
  {
    label: "primary <-> primary-foreground",
    fg: "--primary-foreground",
    bg: "--primary",
    min: TEXT_CONTRAST_MIN,
  },
  {
    label: "primary-as-link <-> background",
    fg: "--primary",
    bg: "--background",
    min: TEXT_CONTRAST_MIN,
  },
  {
    label: "focus-ring (ring) <-> background",
    fg: "--ring",
    bg: "--background",
    min: UI_CONTRAST_MIN,
  },
];

const evaluatePair = (themeName, tokens, pair) => {
  const fg = resolveToken(tokens, pair.fg);
  const bg = resolveToken(tokens, pair.bg);
  if (fg === null || bg === null) {
    const missing = [fg === null ? pair.fg : null, bg === null ? pair.bg : null]
      .filter(Boolean)
      .join(", ");
    return {
      ok: false,
      ratio: null,
      message: `[${themeName}] ${pair.label}: UNRESOLVED token(s): ${missing}`,
    };
  }
  const ratio = contrastRatio(oklchToSrgb(fg), oklchToSrgb(bg));
  const ratioStr = `${ratio.toFixed(RATIO_PRECISION)}:1`;
  const ok = ratio >= pair.min;
  const verdict = ok ? "PASS" : "FAIL";
  return {
    ok,
    ratio,
    message: `[${themeName}] ${pair.label}: ${ratioStr} (min ${pair.min}:1) ${verdict}`,
  };
};

const main = () => {
  let css;
  try {
    css = readFileSync(CSS_PATH, "utf8");
  } catch (error) {
    process.stderr.write(
      `contrast-gate: cannot read token source ${CSS_PATH}: ${error.message}\n`
    );
    process.exit(1);
    return;
  }

  const themes = [
    { name: "light", selector: ":root" },
    { name: "dark", selector: ".dark" },
  ];

  process.stdout.write("WCAG-AA contrast gate — measured ratios:\n");

  let failures = 0;
  let evaluated = 0;

  for (const theme of themes) {
    const block = extractBlock(css, theme.selector);
    if (block === null) {
      process.stderr.write(
        `contrast-gate: theme block "${theme.selector}" not found in ${CSS_PATH}\n`
      );
      failures++;
      continue;
    }
    const tokens = parseTokens(block);
    for (const pair of REQUIRED_PAIRS) {
      const result = evaluatePair(theme.name, tokens, pair);
      process.stdout.write(`  ${result.message}\n`);
      evaluated++;
      if (!result.ok) {
        failures++;
      }
    }
  }

  if (evaluated === 0) {
    process.stderr.write(
      "contrast-gate: no pairs evaluated — token source empty or unparseable (vacuous gate refused)\n"
    );
    process.exit(1);
    return;
  }

  if (failures > 0) {
    process.stderr.write(
      `\ncontrast-gate: FAILED — ${failures} pair(s) below threshold.\n`
    );
    process.exit(1);
    return;
  }

  process.stdout.write(
    `\ncontrast-gate: PASSED — ${evaluated} pair(s) meet WCAG-AA thresholds.\n`
  );
};

main();
