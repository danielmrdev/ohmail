# OpenCode Go desktop design

## Status and context

**Conditional design, not implementation-ready.** Read [proposal](proposal.md), its G1–G4 gates, and [research](../../../docs/research/opencode-go.md) first. No application files are changed by this plan.

Baseline revision: `a09be04c7986917bf989529768d3ad7935b8640d`. OpenCode findings checked 2026-10-15. Refresh moving provider contracts before implementation.

## Decisions

### 1. Separate provider and credentials

Use discriminator **`opencode-go`**. Use the same quoted key **`"opencode-go"`** for the public settings block, write block, and persisted block. This matches existing `settings[provider]` access; a camelCase-only block would break it.

Extend the existing hosted settings shape: `classifyModel`, `draftModel`, and public `hasKey`; encrypted storage retains `keyEnc`/`keyVersion`. Keep store version **1**, with additive member-wise defaults for old files. Existing providers and their encrypted keys are preserved.

Explicit provider selection must choose the matching envelope. Replace two-provider ternaries with explicit branches at the affected seams; do not introduce a generic configurable proxy. Blank/omitted keys retain the stored envelope. Choosing None keeps envelopes; Forget removes all of them. Reject storing Go secrets without a durable install key, just as for other hosted providers.

The credential enters through the existing engine bridge request body, never native-command arguments, environment lookup, CLI files, status responses, logs, or saved plaintext.

### 2. Dedicated fixed-destination transport

Add `apps/sidecar/src/ai-opencode-go.ts` implementing existing `AiTransport`: `classify`, `screen`, `draft`, `probe`.

Documented Go inference base: **`https://opencode.ai/inference/go/v1`**; first-version inference uses only `/chat/completions`. Do not use the ordinary `/inference/v1` or legacy `/zen` route as fallback.

Use platform fetch, the existing deadline helper, Bearer auth, and `redirect: "error"`. No SDK, user-supplied hosted URL, OAuth, browser networking, Tauri permission, or new native command is needed. Keep OpenAI's pinned destination unchanged. Prefer a small dedicated adapter over a broad rewrite of working transports; share a private helper only if real duplication warrants it and existing-provider tests prove no behavior change.

Use an honest application-specific User-Agent. Subject to G1 clarification, an opaque random session identifier may represent each independent logical operation; retries retain that identifier. Never derive it from sender, account, message ID, subject, snippet, or other mailbox data. Do not simulate coding traffic.

### 3. Small model subset, not an unfiltered catalogue

The public Go list mixes protocols and does not establish entitlement, structured-output support, or privacy policy. Intersect it with a small reviewed set of exact IDs; never infer capabilities from model names or Zen entries.

Candidates for G4: `glm-5.3-flash` and `kimi-k3`. Both are documented as Chat Completions models with no-training/0-day retention claims at research time; metadata marks structured output, not proof of Ohmail's exact schema compatibility. If GLM passes, prefer it as the initial default for both tasks. Add Kimi only if independently validated. If neither passes, stop and revise this design.

Keep classification/drafting settings independent even when their initial default is the same. Selectors list only approved, currently documented Go IDs reported by the Go catalogue. Exclude Responses, Messages, Gemini, undocumented legacy entries, Contributor models, and different-policy free variants in version one. No runtime models.dev fetch or automatic model substitution.

Preserve shared prompts, schemas, serializers, sensitivity sinks, and result coercers from `packages/core/src/{classify-prompt,draft-prompt}.ts`. Do not copy or change mail policy. In particular, `screen` uses the screening question, not an alias to `classify`.

Reasoning text is not final answer content. G4 must establish strict schema controls, final-content extraction, non-streaming behavior, token caps, and refusal/truncation handling. Do not silently drop schema enforcement, strip arbitrary prose to salvage JSON, remove output caps, or copy OpenAI-specific parameter retries without evidence. Invalid output must not become a successful routing decision or stored draft.

Validate parsed final output **locally in the Go adapter before calling the unchanged result coercers**. Those coercers normalize malformed fields and ignore extras; copying OpenAI's parse-then-coerce pattern would not satisfy this design. Validate required keys, primitive types, finite numeric values, destination enums and forbidden extra fields against the shared schema declarations. Implement only the small schema subset these flat responses use, reusing an existing validator if suitable; no duplicated schemas, dependency, or general validation framework. Tests must include syntactically valid JSON with missing, wrong-type and extra fields, not only JSON parse failures.

### 4. Verification is a hard unresolved boundary

Existing `probeKeyedCatalogue` assumes authenticated listing and working per-model GETs. **Do not reuse it unchanged for Go.**

Keep `GET /local/ai`, Save, and `POST /local/ai/verify` free of inference. Save currently invokes verification automatically, so even a synthetic completion there would silently consume allowance.

G2 must identify the exact non-inference auth/entitlement response, required credential scopes, and failure semantics. The documented Console config endpoint is only a candidate. Only after that evidence is recorded may the Go probe combine authenticated entitlement evidence with public-catalogue/model-subset checks. Do not invent response fields, equate catalogue success with a valid key, or add privileged scopes speculatively.

Until G2 is solved, `probe.ok`/availability must not become true for Go. Do not work around this by changing the meaning of availability for every provider. If an explicit quota-consuming test or a configured-but-unverified mode becomes necessary, obtain approval for a revised spec and route/cost/UI design first.

### 5. Existing execution and failure behavior

Continue using the manager's existing request ports, background fault gate, and engine wiring. Status reads remain local. Settings changes discard prior verification. Go failures must not send mail, enable automation, or cause a vendor/model fallback.

Preserve the request classifier's `screen` method. Preserve the deliberate absence of `screen` on `classifierForCycle()`; its current automatic-suggestion fallback is not repaired by this change.

For inference errors, expose only safe provider/status/category information. Never log or display raw provider error bodies that may echo credentials or mail. Verify 401/403, 402, 429, server faults, invalid responses, and timeouts with mocked fetch. An unknown 402/429 must not be described as a known quota/reset condition; use an honest actionable message instead. Do not automatically retry quota/auth failures or request another endpoint. Repeated background faults use the existing cooldown and rules-only degradation; do not rewrite the sync pipeline.

Go uses **one Screener lane** initially. `lanesFor("opencode-go")` must remain 1; Anthropic/OpenAI retain their current policy. Existing chunk bounds, cancellation limits, cached suggestions, idempotency and automation opt-ins remain unchanged.

### 6. Billing and privacy copy are part of correctness

Display OpenCode Go as a separate choice in the same onboarding/settings form. Name `opencode.ai` as the destination and explain that selected upstream providers also process the supplied context. The engine reports a new explicit `contentGoesTo: "opencode-go"` value; do not map it to OpenAI, local processing, null, or absence.

Explain that calls consume Go allowance and that server-side Extra usage can spend Console balance. Subscription-only behavior requires the account controls in G3; Ohmail cannot promise a client-enforced billing cap. Do not enable Extra usage or Auto-recharge, choose a paid fallback, or claim all Go models have identical retention.

A dedicated key must be entered explicitly. Do not add account creation, embedded sign-in, automatic key import, or new external-link shell capabilities. Supply setup instructions in documentation instead. English and German catalogues must stay structurally aligned.

## File map

| File | Planned responsibility |
| --- | --- |
| `apps/sidecar/src/ai-opencode-go.ts` (new) | Fixed Go transport, bounded model subset and G2-approved probe. |
| `apps/sidecar/src/ai-provider.ts` | Provider/keyed unions, runtime allow-list, defaults, additive storage, sealing/decryption, block selection, transport selection, status and destination disclosure. Audit every two-provider fallback. |
| `apps/desktop/src/local-ai.ts` | Mirror discriminator, settings/write/destination types and Go-specific unavailable wording where needed. Preserve existing bridge routes. |
| `apps/desktop/src/AiProviderForm.tsx` | Compile-coupled keyed types/predicate, complete label/host maps and safe explicit key/model writes move with the desktop union in Phase 2. Visible choice, model display and disclosure finish in Phase 3. |
| `apps/desktop/src/local-suggest-run.ts` | Preserve intentional serial Go policy; do not generalize hosted providers to four lanes. Change production code only if necessary. |
| `apps/webapp/messages/{en,de}.json` | Go choice, key/setup, consumption and destination copy; unchanged policy for other providers. |
| `apps/sidecar/src/phone/ai-provider.ts` | Add default settings shape only if required by shared types; still no inference or credential storage. |
| `apps/desktop/test/opencode-go-transport.test.ts` (new) | Mocked HTTP protocol, model/probe, redaction, output, failure and fixed-destination tests. |
| `apps/desktop/test/local-ai-opencode-go.test.ts` (new) | Real manager with fake key provider, temporary store and injected fetch; persistence, credential separation, gate and background degradation tests. |
| `apps/desktop/test/opencode-go-form.test.tsx` (new) | Passing test-only mount rig around the real shared form/current UI providers and bridge mocks; Go behavior must reach assertions, not fail during mounting. |
| Existing desktop AI/form/onboarding/lane tests | Additive typed fixtures and Go assertions only where a working harness is demonstrated; preserve baseline failures, other providers and mock-factory conventions. |
| `apps/desktop/README.md` and root `README.md` | Approved models, API-key setup, data destination, account-side billing controls, limits of verification. |

No engine feature wiring rewrite is expected. Existing consumers are `engine.ts` request dependencies, hello capability and cycle ports. No self-host feature, Rust/CSP change, database migration, dependency or lockfile change is planned. If a protected build guard rejects the new provider, stop and report; do not weaken it.

## Verification Notes

- V1: Pin every Go request to the approved destination, use only its own key, refuse redirects, and prove no secret/raw mail enters logs or status.
- V2: Save, status, startup/render and Verify must not run inference; public catalogue success must not prove credentials or entitlement.
- V3: Old settings load additively; vendor switching/None/Forget and missing durable keys preserve existing semantics and provider isolation.
- V4: All three AI operations reuse shared safety/prompt boundaries; invalid, refused, truncated or reasoning-only output must not create a successful action.
- V5: Quota/auth/network failures cause no paid/model fallback; background sync degrades through its existing fault gate; Go concurrency stays serial.
- V6: UI/setup tell the truth about OpenCode/upstream data, account-side overages, compatible model subset, and settings/onboarding state updates.
- V7: Phone remains no-AI; host-client bundle retains no desktop-local provider surface; webview smoke makes zero network requests.
- V8: Existing providers do not regress; baseline failures are recorded rather than hidden, broadly repaired, or called passing.

## Baseline verification observed during planning

No dependencies installed, credentials read, authenticated requests, or inference calls performed. No application edits were made.

- Root `node_modules/.bin/tsc` is absent. Desktop-local TypeScript is available.
- Engine typecheck via `mise exec node@22.23.1 -- apps/desktop/node_modules/.bin/tsc --noEmit -p tsconfig.engine.json` failed before implementation: missing declarations for `nodemailer`, `mailparser`, `sanitize-html`, plus related IMAP/parser diagnostics. Do not solve with ambient-any shims or unrelated dependency changes in this feature.
- Three-file desktop baseline on Node 22: **57 passed, 28 failed / 85 tests**. `local-suggest-lanes.test.ts` passed all 13. `desktop-ai.test.ts` failed 17/21 and `desktop-ai-verdict.test.tsx` failed 11/51 with `Element type is invalid: expected a string (for built-in components) or a class/function (for composite components) but got: undefined.` Cause not diagnosed.
- Builds, artifact scans, full UI typecheck, full suite and packaged app were not run. Existing sidecar test files referenced by comments are not present in this checkout.
- Future form acceptance depends on proving a working test-only mount rig using current UI exports/providers and the real shared form. A failure before Go assertions is not a valid feature RED test or coverage. If that rig cannot pass without repairing existing production/harness code, stop for separate repair approval; do not quietly absorb the repair into this provider.

## Rollout and rollback

No feature is shipped while G1–G4 remain unresolved. After a separately approved implementation, selecting Go remains explicit; no migration selects it automatically. The user can select a previous provider or None; Forget removes all stored provider keys.

Older builds fall back to no provider for an unknown discriminator, but an older build that rewrites the settings file may discard the unknown Go block. Do not claim lossless downgrade preservation. Revert code only with authorization; do not delete mail, install keys or account settings as a rollback procedure.

## Planning review record

Independent verification-coverage review found all V1–V8 notes routed into phase success criteria. Independent actionability review identified three gaps: compile-coupled form changes, local output validation before coercion, and a passing form-test rig. All three were corrected in design/spec/tasks and confirmed resolved in a focused follow-up. This reviews the conditional plan, not an implementation.

Local documentation checks cover links, whitespace and Given/When/Then structure. OpenSpec CLI is not installed, so no CLI schema-validation result is claimed. G1–G4 and separate implementation approval remain outstanding.
