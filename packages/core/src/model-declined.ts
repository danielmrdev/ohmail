/**
 * A MODEL THAT ANSWERED WITHOUT ANSWERING: a safety refusal (`stop_reason: "refusal"`, HTTP 200
 * with no content) or an answer cut off at `max_tokens`. It speaks for the one request that drew
 * it and says nothing about the provider, so every caller treats it as that message's outcome —
 * routed without AI, skipped, refunded, said — and never as a fault: asking again about the same
 * bytes tends to draw the same answer. A leaf outside `ai/`, so mail-half code names it by class.
 */
export class ModelDeclinedError extends Error {
  override readonly name = "ModelDeclinedError";
  constructor(
    /** Anthropic's own `stop_reason`. */
    readonly stopReason: "refusal" | "max_tokens",
    /** `stop_details.category` for a refusal (`cyber`, `general_harms`, …), else `null`. */
    readonly refusalCategory: string | null,
  ) {
    super(stopReason === "refusal"
      ? `the model declined this request${refusalCategory ? ` (${refusalCategory})` : ""}`
      : "the model's answer was cut off at max_tokens");
  }
}

/** A refusal's `stop_details.category`, or `null` (absent, unnamed, or not a refusal's shape). */
export function refusalCategoryOf(stopDetails: unknown): string | null {
  const category = (stopDetails as { category?: unknown } | null | undefined)?.category;
  return typeof category === "string" ? category : null;
}

/** The decline a response's stop reason states, or `null` for an answer that may be read. */
export function declineOf(stopReason: unknown, stopDetails: unknown): ModelDeclinedError | null {
  if (stopReason === "refusal") return new ModelDeclinedError("refusal", refusalCategoryOf(stopDetails));
  if (stopReason === "max_tokens") return new ModelDeclinedError("max_tokens", null);
  return null;
}
