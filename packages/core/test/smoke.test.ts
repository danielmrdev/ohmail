import { describe, it, expect } from "vitest";
import { CORE_VERSION } from "../src/index.js";

describe("smoke", () => {
  it("exposes a version constant", () => {
    expect(CORE_VERSION).toBe("0.0.0");
  });
});
