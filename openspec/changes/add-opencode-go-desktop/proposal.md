# Add OpenCode Go to standalone desktop

## Status

**Conditional plan; blocked before application changes.** The user approved desktop-only scope and continuing with a conditional plan on 2026-10-15. This is not approval to implement, use credentials, spend allowance, send mail data, contact OpenCode, commit, or publish.

Repository baseline: `a09be04c7986917bf989529768d3ad7935b8640d`.

## Why

Allow a person to use their own OpenCode Go subscription for Ohmail's existing AI functions: Screener suggestions, unresolved-message classification, and reviewable reply drafts. This is a distinct subscription provider, not an OpenAI API key, a CLI integration, or unrestricted Zen/pay-as-you-go access.

Primary-source findings and dated limitations: [research](../../../docs/research/opencode-go.md).

## Scope and decisions

- Standalone desktop engine and its shared onboarding/settings form only.
- A separate `opencode-go` provider with an explicitly supplied, encrypted OpenCode key.
- Preserve separate classification and drafting model settings and all existing routing, redaction, consent, and draft-review policies.
- First version supports only a small, explicitly validated Chat Completions model subset. Do not expose the entire public Go catalogue.
- No automatic switch to Zen, another provider, another model, or a different data policy.
- Preserve existing automation preferences; selecting Go does not enable automation.
- Go Screener batches remain serial initially; no assumption about supported concurrency.

## Non-goals

Codex/OpenAI sign-in; OpenCode OAuth or CLI credential import; self-host configuration; mobile inference; new AI features; Responses/Messages/Gemini transports; quota dashboards; arbitrary hosted base URLs; unrelated refactors or baseline-test repairs.

A phone stub may need an additive settings-shape update solely to preserve compilation. It must remain incapable of inference.

## Blocking gates

| Gate | Required evidence before proceeding |
| --- | --- |
| G1 — workload permission | Written clarification from OpenCode covering personal mail screening, classification, drafts, automatic/background operation, and end-user-owned keys. Resolve the coding-agent traffic policy and Terms restrictions. Stop if this workload is refused. Do not impersonate a coding client. |
| G2 — honest non-inference verification | A documented and confirmed contract accepting the intended Go credential and proving the necessary workspace/Go entitlement without inference. Public `GET /models` does not authenticate; observed per-model GETs return 404. Console `GET /console/api/v2/config` is only a candidate, not an approved solution. If no suitable contract exists, stop and request a readiness redesign. |
| G3 — billing boundary | Document current account controls and the user's confirmation that `Use balance / Extra usage` and applicable `Auto-reload / Auto-recharge` rules are disabled for subscription-only operation. No account inspection/change is authorized. Client-side fallback refusal alone cannot prevent server-side extra charges. |
| G4 — model/data compatibility | Select documented Go models with accepted privacy terms and prove their exact structured-output and reasoning/token behavior with synthetic inputs. Real credential use or allowance consumption requires separate approval after G1. No model is approved yet. |

The model candidates are `glm-5.3-flash` and `kimi-k3`, not committed defaults or a promise of eligibility. Revalidate dated documentation before any implementation. Unknown quota status/reset semantics must remain unknown until evidenced.

## Capabilities

### New Capabilities

- `opencode-go-desktop`: Conditional Go provider configuration, non-billable verification, safe execution of existing desktop AI operations, and honest billing/data disclosure.

### Modified Capabilities

None defined in canonical OpenSpec yet. Existing providers must remain behaviorally unchanged.

## Deliverables and handoff

- [Requirements](specs/opencode-go-desktop/spec.md)
- [Design and verification notes](design.md)
- [Dependency-ordered implementation tasks](tasks.md)

Next agent starts with G1–G4, records evidence and obtains explicit implementation approval. It must not treat these planning files as permission to cross a gate.
