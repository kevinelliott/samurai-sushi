import { blake2b } from "@noble/hashes/blake2b";
import { b58DecodeAddress, b58DecodeAndCheckPrefix, PrefixV2 } from "@taquito/utils";
import type { ReceiptPayloadV1 } from "./model";

const PACK_PREFIX = 0x05;
const MICHELINE_INT = 0x00;
const MICHELINE_STRING = 0x01;
const MICHELINE_PRIM_TWO_ARGS = 0x07;
const MICHELINE_BYTES = 0x0a;
const PRIM_PAIR = 0x07;

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function u32(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) throw new Error("Micheline length is out of range.");
  return Uint8Array.of((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
}

function zarithNatural(value: bigint): Uint8Array {
  if (value < 0n) throw new Error("Micheline natural number cannot be negative.");
  const bytes: number[] = [];
  let remaining = value;
  let first = Number(remaining & 0x3fn);
  remaining >>= 6n;
  if (remaining !== 0n) first |= 0x80;
  bytes.push(first);
  while (remaining !== 0n) {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining !== 0n) byte |= 0x80;
    bytes.push(byte);
  }
  return Uint8Array.from(bytes);
}

function intNode(value: string | number): Uint8Array {
  return concat(Uint8Array.of(MICHELINE_INT), zarithNatural(BigInt(value)));
}

function stringNode(value: string): Uint8Array {
  const bytes = new TextEncoder().encode(value);
  return concat(Uint8Array.of(MICHELINE_STRING), u32(bytes.byteLength), bytes);
}

function bytesNode(value: Uint8Array): Uint8Array {
  return concat(Uint8Array.of(MICHELINE_BYTES), u32(value.byteLength), value);
}

function pairNode(left: Uint8Array, right: Uint8Array): Uint8Array {
  return concat(Uint8Array.of(MICHELINE_PRIM_TWO_ARGS, PRIM_PAIR), left, right);
}

function rightComb(values: readonly Uint8Array[]): Uint8Array {
  if (values.length < 2) throw new Error("Receipt payload must contain a Michelson pair.");
  let result = pairNode(values[values.length - 2]!, values[values.length - 1]!);
  for (let index = values.length - 3; index >= 0; index -= 1) result = pairNode(values[index]!, result);
  return result;
}

function hex32(value: string): Uint8Array {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("Expected 32 lowercase hexadecimal bytes.");
  return Uint8Array.from(Buffer.from(value, "hex"));
}

/** Exact right-combed Michelson PACK bytes mirrored by the SmartPy payload layout. */
export function packReceiptPayload(payload: ReceiptPayloadV1): Uint8Array {
  const [chainBytes] = b58DecodeAndCheckPrefix(payload.chainId, [PrefixV2.ChainID] as const);
  const values = [
    stringNode(payload.domain),
    intNode(payload.schemaVersion),
    bytesNode(chainBytes),
    bytesNode(b58DecodeAddress(payload.owner, "array")),
    bytesNode(b58DecodeAddress(payload.source, "array")),
    bytesNode(b58DecodeAddress(payload.destination, "array")),
    stringNode(payload.entrypoint),
    intNode(payload.attachedMutez),
    bytesNode(hex32(payload.serviceCommitment)),
    stringNode(payload.contentVersion),
    bytesNode(hex32(payload.nonce)),
    intNode(payload.issuedAt),
    intNode(payload.expiry),
    bytesNode(hex32(payload.deploymentManifestHash)),
    stringNode(payload.issuerKeyId),
    intNode(payload.issuerPolicyVersion),
  ];
  return concat(Uint8Array.of(PACK_PREFIX), rightComb(values));
}

export function hashReceiptPayload(payload: ReceiptPayloadV1): string {
  return Buffer.from(blake2b(packReceiptPayload(payload), { dkLen: 32 })).toString("hex");
}

export function receiptPayloadPackedHex(payload: ReceiptPayloadV1): string {
  return Buffer.from(packReceiptPayload(payload)).toString("hex");
}
