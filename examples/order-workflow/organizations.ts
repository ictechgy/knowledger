/** The three fictional organizations used by the local Fabric development network. */
export const DEVELOPMENT_ORGANIZATIONS = [
  { org_id: 'SalesMSP', key_id: 'person-sales-owner', subject: 'dev-sales-owner', domain: 'sales', peer_port: 17051, channel_id: 'kcl-demo' },
  { org_id: 'FulfillmentMSP', key_id: 'person-fulfillment-owner', subject: 'dev-fulfillment-owner', domain: 'fulfillment', peer_port: 18051, channel_id: 'kcl-demo' },
  { org_id: 'SettlementMSP', key_id: 'person-settlement-owner', subject: 'dev-settlement-owner', domain: 'settlement', peer_port: 19051, channel_id: 'kcl-demo' },
] as const;

for (const organization of DEVELOPMENT_ORGANIZATIONS) Object.freeze(organization);
Object.freeze(DEVELOPMENT_ORGANIZATIONS);

export type DevelopmentOrganization = typeof DEVELOPMENT_ORGANIZATIONS[number];
export type DevelopmentOrganizationId = DevelopmentOrganization['org_id'];

const ORGANIZATION_IDS = new Set<DevelopmentOrganizationId>(DEVELOPMENT_ORGANIZATIONS.map(({ org_id }) => org_id));

/** Resolve only the public, fixed development organization descriptors. */
export function getDevelopmentOrganization(value: unknown): DevelopmentOrganization {
  const id = typeof value === 'string'
    ? value
    : value && typeof value === 'object' && 'org_id' in value && typeof value.org_id === 'string'
      ? value.org_id
      : undefined;
  if (!id || !ORGANIZATION_IDS.has(id as DevelopmentOrganizationId)) throw new Error('Unknown development organization');
  const organization = DEVELOPMENT_ORGANIZATIONS.find(candidate => candidate.org_id === id)!;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (keys.join('\0') !== ['channel_id', 'domain', 'key_id', 'org_id', 'peer_port', 'subject'].join('\0')
      || record.domain !== organization.domain || record.key_id !== organization.key_id
      || record.org_id !== organization.org_id || record.peer_port !== organization.peer_port || record.channel_id !== organization.channel_id
      || record.subject !== organization.subject) throw new Error('Unknown development organization');
  }
  return organization;
}
