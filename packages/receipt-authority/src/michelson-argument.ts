import type { ReceiptPayloadV1, ReceiptPermitV1 } from "./model";

function quote(value: string): string {
  return JSON.stringify(value);
}

function rightComb(values: readonly string[]): string {
  if (values.length < 2) throw new Error("Michelson receipt record requires a pair.");
  let result = `Pair ${values.at(-2)!} ${values.at(-1)!}`;
  for (let index = values.length - 3; index >= 0; index -= 1) result = `Pair ${values[index]!} (${result})`;
  return result;
}

export function receiptPayloadMichelson(payload: ReceiptPayloadV1): string {
  return rightComb([
    quote(payload.domain),
    payload.schemaVersion.toString(),
    quote(payload.chainId),
    quote(payload.owner),
    quote(payload.source),
    quote(payload.destination),
    quote(payload.entrypoint),
    payload.attachedMutez,
    `0x${payload.serviceCommitment}`,
    quote(payload.contentVersion),
    `0x${payload.nonce}`,
    payload.issuedAt,
    payload.expiry,
    `0x${payload.deploymentManifestHash}`,
    quote(payload.issuerKeyId),
    payload.issuerPolicyVersion,
  ]);
}

export function receiptPermitMichelsonArgument(permit: ReceiptPermitV1): string {
  return `Pair (${receiptPayloadMichelson(permit.payload)}) (Pair 0x${permit.payloadHash} ${quote(permit.signature)})`;
}
