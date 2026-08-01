import { describe, expect, it } from "vitest";
import { assertApprovedRuntimeState, RuntimePinError, validateRuntimePin } from "./runtime-pin";

const pin = validateRuntimePin({
  schemaVersion: 1,
  repository: "../project-crypt-tezos-localnet",
  revision: "aca4dce5f7b3d43271562565ff06ee7810a4a25b",
  profileEntrypoint: "scripts/profile.mjs",
});

describe("shared runtime pin", () => {
  it("accepts the exact clean runtime", () => {
    expect(() => assertApprovedRuntimeState(pin, { revision: pin.revision, porcelain: "" })).not.toThrow();
  });

  it("rejects an unapproved runtime revision", () => {
    expect(() =>
      assertApprovedRuntimeState(pin, { revision: "0".repeat(40), porcelain: "" }),
    ).toThrowError(RuntimePinError);
  });

  it("rejects a dirty shared runtime", () => {
    expect(() =>
      assertApprovedRuntimeState(pin, { revision: pin.revision, porcelain: " M scripts/profile.mjs" }),
    ).toThrowError(RuntimePinError);
  });

  it("rejects a path outside one direct sibling repository", () => {
    expect(() => validateRuntimePin({ ...pin, repository: "../../elsewhere" })).toThrowError(
      RuntimePinError,
    );
  });
});
