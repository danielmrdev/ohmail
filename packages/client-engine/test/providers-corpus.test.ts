import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { portMeansImplicitTls, providerById } from "../src/providers.js";

/**
 * ONE providers.ts BRANCH PER CORPUS PROVIDER, with a recorded server behind it. The corpus is the
 * core replay's (`probe-shapes.mjs` writes it); every shape in it records the endpoint it dialled.
 */
const CORPUS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../core/test/adapters/provider-shapes");
interface Shape {
  provider: string;
  presetId: string;
  source: { kind: string };
  endpoint: { host: string; port: number; tls: "implicit" | "starttls" | "none" } | null;
}
const shapeOf = (name: string): Shape => JSON.parse(readFileSync(join(CORPUS_DIR, `${name}.shape.json`), "utf8")) as Shape;

const BRANCHES: Record<string, string> = {
  greenmail: "the generic entry: portMeansImplicitTls over the recorded port",
  dovecot: "the generic entry: portMeansImplicitTls over the recorded port",
  infomaniak: "the infomaniak preset's IMAP endpoint",
  gmail: "the gmail preset's IMAP endpoint",
};

describe("providers.ts against the recorded provider shapes", () => {
  const names = readdirSync(CORPUS_DIR).filter((f) => f.endsWith(".shape.json")).map((f) => f.replace(/\.shape\.json$/, "")).sort();

  it("every corpus shape names the providers.ts branch it covers", () => {
    expect(names).toEqual(Object.keys(BRANCHES).sort());
    for (const n of names) expect(providerById(shapeOf(n).presetId).id, `${n}: presetId is not a preset`).toBe(shapeOf(n).presetId);
  });

  it("every corpus shape is a recording and names the endpoint it dialled", () => {
    expect(names.filter((n) => shapeOf(n).endpoint === null || shapeOf(n).source.kind !== "recorded")).toEqual([]);
  });

  for (const n of Object.keys(BRANCHES)) {
    const shape = shapeOf(n);
    it(`${n}: ${BRANCHES[n]}`, () => {
      const preset = providerById(shape.presetId);
      if (shape.endpoint === null) throw new Error(`${n}: no recorded endpoint`);
      expect(portMeansImplicitTls(shape.endpoint.port)).toBe(shape.endpoint.tls === "implicit");
      if (preset.manual) {
        expect(shape.endpoint.host).toBe("loopback");
        return;
      }
      expect(shape.endpoint).toEqual({
        host: preset.imap.host, port: preset.imap.port, tls: preset.imap.secure ? "implicit" : "starttls",
      });
    });
  }
});
