// Personal-organization provisioning performed at account creation.
//
// An earlier story stood up the session-RESOLUTION seam (given a user, derive its active
// org); this module is the REAL provisioning that actually creates the org + the
// owner membership rows, wired into the better-auth `databaseHooks.user.create
// .after` hook in ./index. Every self-registered member gets a personal
// organization and is its org-structural `owner` (DISTINCT from the GLOBAL
// app-authz role `member` — two orthogonal namespaces). The org id matches
// the `seedActiveOrganization` convention so the session's `activeOrganizationId`
// resolves to a REAL row, never a dangling reference.

// The org-structural role of an organization's creator — NOT a GLOBAL app role.
export const PERSONAL_ORG_OWNER_ROLE = "owner";

// The deterministic personal-org id for a user. Single-sourced so the row created
// here and the active org seeded onto the session are the SAME id (non-dangling).
export const personalOrgIdFor = (userId: string): string =>
  `org-personal-${userId}`;

export interface PersonalOrgRecord {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
}

export interface PersonalOrgMembership {
  readonly organizationId: string;
  readonly role: string;
  readonly userId: string;
}

// The minimal store the provisioning writes through — the better-auth adapter in
// production, an in-memory store in tests. Both create the SAME two rows.
export interface PersonalOrgStore {
  createMembership: (membership: PersonalOrgMembership) => Promise<void> | void;
  createOrganization: (organization: PersonalOrgRecord) => Promise<void> | void;
}

export interface ProvisionedPersonalOrg {
  readonly membership: PersonalOrgMembership;
  readonly organization: PersonalOrgRecord;
}

export const buildPersonalOrg = (user: {
  readonly id: string;
  readonly given_name?: string;
}): ProvisionedPersonalOrg => {
  const id = personalOrgIdFor(user.id);
  const ownerName =
    user.given_name && user.given_name.length > 0
      ? user.given_name
      : "Personal";
  const organization: PersonalOrgRecord = {
    id,
    name: `${ownerName} Workspace`,
    slug: `personal-${user.id}`,
  };
  const membership: PersonalOrgMembership = {
    organizationId: id,
    role: PERSONAL_ORG_OWNER_ROLE,
    userId: user.id,
  };
  return { membership, organization };
};

// Provision the personal org: create the organization row and the owner
// membership row through the given store. Returns the rows so the caller can
// resolve the (now non-dangling) active org.
export const provisionPersonalOrg = async (
  user: { readonly id: string; readonly given_name?: string },
  store: PersonalOrgStore
): Promise<ProvisionedPersonalOrg> => {
  const provisioned = buildPersonalOrg(user);
  await store.createOrganization(provisioned.organization);
  await store.createMembership(provisioned.membership);
  return provisioned;
};
