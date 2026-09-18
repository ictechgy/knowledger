import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { startSigningService, type SigningService } from "../../infra/fabric/signing-service.ts";

export const DEVELOPMENT_SIGNING_KEY_IDS = [
  "person-sales-owner",
  "person-fulfillment-owner",
  "person-settlement-owner",
] as const;

export type DevelopmentSigningKeyId = typeof DEVELOPMENT_SIGNING_KEY_IDS[number];

const approvedIdentities: Record<DevelopmentSigningKeyId, { domain: string; org_id: string }> = {
  "person-sales-owner": { domain: "sales.kcl.test", org_id: "SalesMSP" },
  "person-fulfillment-owner": { domain: "fulfillment.kcl.test", org_id: "FulfillmentMSP" },
  "person-settlement-owner": { domain: "settlement.kcl.test", org_id: "SettlementMSP" },
};

function selectedKeyIds(value: readonly string[] | undefined): readonly DevelopmentSigningKeyId[] {
  const ids = value === undefined ? DEVELOPMENT_SIGNING_KEY_IDS : value;
  if (!Array.isArray(ids) || ids.length === 0 || new Set(ids).size !== ids.length || ids.some((id) => !DEVELOPMENT_SIGNING_KEY_IDS.includes(id))) {
    throw new TypeError("Signing key allowlist must contain unique approved identity IDs");
  }
  return Object.freeze([...ids]) as DevelopmentSigningKeyId[];
}

function references(keyIds: readonly DevelopmentSigningKeyId[]) {
  const root = resolve(fileURLToPath(new URL("../../.data/fabric-smoke/crypto", import.meta.url)));
  return keyIds.map((keyId) => {
    const domain = approvedIdentities[keyId].domain;
    const user = `User1@${domain}`;
    const msp = resolve(root, "peerOrganizations", domain, "users", user, "msp");
    const keyDir = resolve(msp, "keystore");
    let keyFiles;
    try { keyFiles = readdirSync(keyDir, { withFileTypes: true }).filter((entry) => entry.isFile() && /^.+_sk$/u.test(entry.name)); }
    catch { throw new Error("Approved development signing key is unavailable"); }
    if (keyFiles.length !== 1) throw new Error("Approved development signing key is unavailable");
    return {
      key_id: keyId,
      certificate_path: resolve(msp, "signcerts", `${user}-cert.pem`),
      private_key_path: resolve(keyDir, keyFiles[0].name),
      org_id: approvedIdentities[keyId].org_id,
      // Development keys exercise the enforced boundary: unattested signing is
      // refused rather than merely unlogged.
      require_attestation: true,
    };
  });
}

export async function startDevelopmentSigningService(options: { socketPath: string; keyIds?: readonly string[]; auditLogPath?: string }): Promise<SigningService> {
  // Every development key requires attestation, so the evidence sink is not
  // optional: callers may choose the path, otherwise the service keeps its
  // audit log beside the socket in its own mode-700 directory.
  const auditLogPath = options.auditLogPath ?? join(dirname(options.socketPath), "signing-audit", "audit.jsonl");
  return startSigningService({ socketPath: options.socketPath, keys: references(selectedKeyIds(options.keyIds)), auditLogPath });
}
