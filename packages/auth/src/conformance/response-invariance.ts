// Single-sourced detectors for the cross-surface response-invariance gate.
//
// The gate and its mutation twin BOTH import these, so the twin proves the GATE's
// own checker reddens on a revealing surface (not a hand-copied replica). The
// checks: (1) every pre-auth surface response canonicalizes byte-identically to
// the ONE neutral envelope across the email matrix, and (2) no response body leaks
// an existence/state token (EMAIL_NOT_VERIFIED / already / not-found / etc.).

export interface SurfaceResponse {
  readonly body: unknown;
  readonly headers: Readonly<Record<string, string>>;
  readonly status: number;
}

// The five-state pre-auth email matrix.
export const EMAIL_MATRIX = [
  "registered",
  "unregistered",
  "verified",
  "unverified",
  "pending",
] as const;

// Deterministic serialization: lowercase + sort headers so the comparison is over
// status + body + the header SET, order-independent.
export const canonicalize = (response: SurfaceResponse): string => {
  const headerEntries = Object.entries(response.headers)
    .map(([key, value]) => [key.toLowerCase(), value] as const)
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify({
    body: response.body,
    headers: headerEntries,
    status: response.status,
  });
};

export const allByteIdentical = (
  responses: readonly SurfaceResponse[]
): boolean => {
  if (responses.length === 0) {
    return false; // a vacuous (empty) matrix must not pass
  }
  const first = canonicalize(responses[0] as SurfaceResponse);
  return responses.every((response) => canonicalize(response) === first);
};

const LEAK_TOKENS = [
  "EMAIL_NOT_VERIFIED",
  "ALREADY",
  "NOT FOUND",
  "UNREGISTERED",
  "EXISTS",
];

// Scan a value for a leaked existence/state token.
export const revealsExistenceOrState = (value: unknown): boolean => {
  const serialized = JSON.stringify(value ?? null).toUpperCase();
  return LEAK_TOKENS.some((token) => serialized.includes(token));
};
