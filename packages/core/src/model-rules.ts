/**
 * WHAT EACH MODEL'S API ACCEPTS: how it turns thinking off and whether it takes
 * `output_config.effort`. The shapes do not travel between models — `disabled` is a 400 on Sonnet
 * 5.5 and Opus 5.5, `between_tools` a 400 on every model but Sonnet 5.5, and Haiku 4.5 refuses
 * `effort` — so a builder reads the row of the model it is about to call. The hosted builders refuse
 * a model with no row; the own-key client keeps its old request for one. A leaf outside `ai/`, so
 * the desktop's own-key client reads this table too. `MODEL_PRICES_USD_PER_MTOK` keys the same ids.
 */

/** The `thinking` value that turns thinking off. Both are accepted only at effort `high` or below. */
export type ThinkingOff = { readonly type: "disabled" } | { readonly type: "between_tools" };

export interface ModelRequestRules {
  /** `null` when the model cannot turn thinking off: the field is omitted and effort is the lever. */
  readonly thinkingOff: ThinkingOff | null;
  /** Whether the model takes `output_config.effort`. */
  readonly effort: boolean;
}

export const MODEL_REQUEST_RULES: Readonly<Record<string, ModelRequestRules>> = {
  "claude-haiku-4-5": { thinkingOff: { type: "disabled" }, effort: false },
  "claude-haiku-4-5-20251001": { thinkingOff: { type: "disabled" }, effort: false },
  "claude-sonnet-5": { thinkingOff: { type: "disabled" }, effort: true },
  "claude-opus-5": { thinkingOff: { type: "disabled" }, effort: true },
  "claude-haiku-5-5": { thinkingOff: { type: "disabled" }, effort: true },
  "claude-sonnet-5-5": { thinkingOff: { type: "between_tools" }, effort: true },
  "claude-opus-5-5": { thinkingOff: null, effort: true },
};

/** A model no builder can shape a request for, refused before the request exists. */
export class ModelRuleRefusal extends Error {
  override readonly name = "ModelRuleRefusal";
  constructor(readonly model: string, readonly reason: "no_rules" | "thinking_stays_on") {
    super(reason === "no_rules"
      ? `ai: no request rules for model "${model}" — add its row to MODEL_REQUEST_RULES`
      : `ai: model "${model}" cannot turn thinking off, and this call is sized for thinking off`);
  }
}

/** The row for `model`, or `null`. Own keys only, so `constructor` is a missing row, not a prototype. */
export function knownRequestRules(model: string): ModelRequestRules | null {
  return Object.prototype.hasOwnProperty.call(MODEL_REQUEST_RULES, model) ? MODEL_REQUEST_RULES[model]! : null;
}

/** The row for `model`, refused by name when the table has none. */
export function requestRulesFor(model: string): ModelRequestRules {
  const rules = knownRequestRules(model);
  if (rules === null) throw new ModelRuleRefusal(model, "no_rules");
  return rules;
}

/**
 * The `thinking` value for a call whose `max_tokens` assumes thinking is off. A model that cannot
 * turn it off is refused rather than sent a request its budget does not cover.
 */
export function thinkingOffFor(model: string): ThinkingOff {
  const off = requestRulesFor(model).thinkingOff;
  if (off === null) throw new ModelRuleRefusal(model, "thinking_stays_on");
  return { ...off };
}
