// Intentionally-bad fixture for the tier-boundary guard self-test. It imports a
// CONCRETE seam implementation (the *.cloud entrypoint) directly — the leak the
// guard must flag (application/UI code may import only the seam interface).
// Excluded from typecheck and the build; never imported by real code.
import { documentsData } from "@perry-starter/data/documents.cloud";

export const leaked = documentsData;
