import { describe, expect, it } from "vitest";
import vector from "../fixtures/receipt-permit-v1.json";
import { receiptPermitMichelsonArgument, receiptPayloadMichelson } from "./michelson-argument";
import { parseReceiptPayload } from "./model";

describe("receipt Michelson invocation argument", () => {
  it("renders the exact right-combed permit without an address, amount, or entrypoint default", () => {
    const payload = parseReceiptPayload(vector.payload);
    const argument = receiptPermitMichelsonArgument({ payload, payloadHash: vector.payloadHash, signature: vector.signature });
    expect(argument).toContain(`Pair (${receiptPayloadMichelson(payload)})`);
    expect(argument).toContain(`0x${vector.payloadHash}`);
    expect(argument).toContain(JSON.stringify(vector.signature));
    expect(argument).toContain(JSON.stringify(vector.payload.destination));
    expect(argument).toContain(JSON.stringify("submit_receipt"));
    expect(argument).not.toMatch(/--entrypoint|--amount|wallet|secret|private/i);
  });
});
