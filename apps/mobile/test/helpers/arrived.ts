/**
 * WAIT FOR THE ANSWER, NOT FOR A CLOCK. A fixed settle before an arrival assertion went red on a
 * loaded host while the server was still answering. A wait ends the moment its condition holds;
 * the bound only decides when an answer that never came is reported, by name. `CASE_MS` sits
 * above every wait a case makes, so a red is that sentence and never vitest's bare "timed out".
 * An ABSENCE cannot be waited for: it is read over a short window after the arrivals are in.
 */
export const ARRIVAL_MS = 5_000;
export const CASE_MS = 4 * ARRIVAL_MS;

export async function arrived(what: string, holds: () => boolean, last: () => string = () => ""): Promise<void> {
  const deadline = Date.now() + ARRIVAL_MS;
  while (!holds()) {
    if (Date.now() >= deadline) {
      const seen = last();
      throw new Error(`${what} never arrived within ${ARRIVAL_MS} ms${seen ? ` (last seen: ${seen})` : ""}`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}
