import { describe, expect, it } from "vitest";
import {
  PORTABLE_RECOVERY_PUBLIC_FAILURE,
  PortableRecoveryError,
  portableRecoveryPublicFailure,
} from "./errors";

describe("portable recovery public error boundary", () => {
  it("collapses existence, integrity, key, expiry, and replay details to one non-oracular response", () => {
    for (const error of [
      new PortableRecoveryError("RECOVERY_INVALID"),
      new PortableRecoveryError("RECOVERY_INVALID"),
      new PortableRecoveryError("RECOVERY_EXPIRED"),
      new PortableRecoveryError("RECOVERY_ALREADY_CONSUMED"),
      new Error("key identity, export id, tag, and subject must remain private"),
    ]) {
      expect(portableRecoveryPublicFailure(error)).toBe(PORTABLE_RECOVERY_PUBLIC_FAILURE);
    }
    expect(JSON.stringify(PORTABLE_RECOVERY_PUBLIC_FAILURE)).not.toMatch(/identity|export|tag|subject|version/u);
  });
});
