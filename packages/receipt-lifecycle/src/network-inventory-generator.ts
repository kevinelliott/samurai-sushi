export interface RegisteredReceiptNetworkCandidate {
  readonly profile: string;
  readonly chainId: string;
  readonly networkLabelRef: string;
  readonly deploymentManifestHash: string;
}

const NON_PRODUCTION_POLICY = Object.freeze({
  localnet: Object.freeze({ chainId: "NetXtJqPyJGB6Pc", networkLabelRef: "network.localnet-rehearsal" }),
  shadownet: Object.freeze({ chainId: "NetXsqzbfFenSTS", networkLabelRef: "network.shadownet" }),
} as const);

/** Build-time assertion used by generated inventory modules; profile support alone grants no deployment capability. */
export function assertGeneratedRegisteredReceiptNetworkInventory<const T extends readonly RegisteredReceiptNetworkCandidate[]>(inventory: T): T {
  const profiles = new Set<string>();
  const chains = new Set<string>();
  const labels = new Set<string>();
  for (const candidate of inventory) {
    if (candidate.profile === "mainnet" || !(candidate.profile in NON_PRODUCTION_POLICY)) throw new TypeError("Registered receipt profile is unknown or production.");
    const policy = NON_PRODUCTION_POLICY[candidate.profile as keyof typeof NON_PRODUCTION_POLICY];
    if (candidate.chainId !== policy.chainId || candidate.networkLabelRef !== policy.networkLabelRef
      || !/^[0-9a-f]{64}$/.test(candidate.deploymentManifestHash)) {
      throw new TypeError("Registered receipt profile, chain, label, or manifest tuple is invalid.");
    }
    if (profiles.has(candidate.profile) || chains.has(candidate.chainId) || labels.has(candidate.networkLabelRef)) {
      throw new TypeError("Registered receipt network inventory contains a duplicate mapping.");
    }
    profiles.add(candidate.profile);
    chains.add(candidate.chainId);
    labels.add(candidate.networkLabelRef);
  }
  return inventory;
}
