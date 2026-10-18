# OpenCode Go desktop implementation tasks

## Handoff contract

**Planning only; implementation blocked.** Read [proposal](proposal.md), [design](design.md), [requirements](specs/opencode-go-desktop/spec.md), then [research](../../../docs/research/opencode-go.md).

The user approved a conditional plan, not implementation. Do not install dependencies, inspect credentials, contact OpenCode, perform authenticated/inference calls, change account settings, commit or publish without separate approval. All tasks below are unchecked intentionally.

## Review Workload Forecast

| Field | Value |
| --- | --- |
| Estimated changed lines | 600–1000 including tests/docs; re-estimate after G1–G4. |
| 400-line budget risk | High |
| Chained PRs recommended | Yes, if publication is later requested. |
| Suggested split | Transport + tests → manager/wire plus compile-coupled form support + tests → visible UI/docs + integration tests. |
| Delivery strategy | ask-on-risk |
| Chain strategy | pending |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: pending
400-line budget risk: High

These are dependency-ordered local review units, not authorization to create branches, commits or PRs. Each unit must compile and retain existing-provider behavior. Split further if its actual review diff exceeds the agreed budget.

## Phase 0 — Resolve gates and approve implementation

- [ ] 0.1 Record OpenCode's G1 clarification covering the exact mail functions and background operation in `docs/research/opencode-go.md`. A human sends any consultation only after approval. Stop if use is refused.
- [ ] 0.2 Resolve G2: confirm non-inference credential type/scopes, exact authenticated entitlement endpoint/response and failures. The Console config endpoint is only a candidate. Save/Verify cannot spend allowance. If no safe contract exists, request a spec redesign instead of coding around it.
- [ ] 0.3 Resolve G3 with current billing documentation and the user's account-control confirmation. Do not read or change an account. Distinguish client no-fallback behavior from account-side Extra usage/Auto-recharge.
- [ ] 0.4 Resolve G4: refresh candidate model IDs/protocol/privacy claims and define the exact synthetic compatibility matrix. Any future authenticated checks require separate credential/quota-use approval after G1. Prove schema enforcement, final content, output caps, reasoning behavior, refusals and truncation. Approve at least one default or stop.
- [ ] 0.5 Update proposal/design/spec consistently with the resolved contracts. Obtain explicit implementation approval and agree review/delivery boundaries.
- [ ] 0.6 Reproduce the recorded baseline with the commands below. Establish focused transport/manager imports using existing desktop Vitest, without adding a runner/SDK. Prove a passing minimal test-only mount rig around the real shared form, current UI exports/providers and bridge mocks for `opencode-go-form.test.tsx`. If it needs existing production/harness repairs, stop for separate approval. Report baseline failures; mounting errors before Go assertions are not feature RED evidence.

### Success Criteria:
- G1–G4 evidence is recorded, not assumed; all implementation and credential-use approvals are explicit.
- Verification can distinguish credentials/entitlement from a public catalogue without any completion.
- At least one model and its exact privacy/schema/token contract are approved.
- Baseline failures are recorded; sidecar test imports and a real-form mount rig demonstrably work before Go behavior assertions are added. Any required existing-harness repair has separate approval.

## Phase 1 — Fixed Go transport and offline contract tests

Start: Phase 0 complete. Finish: independently tested transport exists but is not selected by any installation.

- [ ] 1.1 RED: add `apps/desktop/test/opencode-go-transport.test.ts` using injected fetch. Fail on missing Go transport, wrong base/credential, redirects, unrestricted model listing and use of inference in probe.
- [ ] 1.2 GREEN: add `apps/sidecar/src/ai-opencode-go.ts` with the approved Chat Completions model subset, fixed Go endpoint, G2 probe, honest client/session headers and all four `AiTransport` methods. No configurable hosted URL or unrelated OpenAI rewrite.
- [ ] 1.3 TRIANGULATE: add Go-local validation after JSON parse and before unchanged coercers, using shared schema declarations (required keys/types, finite numbers, enums and no extras). Test valid JSON with missing/wrong-type/extra fields as well as parse errors, classify versus screen schemas, draft serialization, unsafe-input refusal before HTTP, reasoning-only/refused/truncated output, timeouts, 401/403/402/429/5xx, unsupported models and no inference/provider/model fallback. Any approved retries retain their opaque logical-operation session.
- [ ] 1.4 REFACTOR: remove only duplication introduced by this unit; prove existing OpenAI/Anthropic/Ollama behavior is unchanged if any shared helper was touched.

### Success Criteria:
- V1: captured requests prove fixed Go destination, own-key-only Bearer auth, redirect refusal, opaque non-mail session IDs, and no secret/raw-mail logs or error/status leakage.
- V2: public-list-only success and invalid entitlement never verify Go; all probe requests are non-inference and use the approved G2 contract.
- V4: all three methods use shared prompts/serializers; Go-local validation before coercion rejects valid-JSON schema violations (missing, wrong-type and extra fields), malformed, reasoning-only, refused or truncated responses without successful routing/draft output.
- V5: auth/quota/network cases have bounded safe errors and no fallback request or speculative quota-reset claim.
- V8: any changed shared transport has explicit existing-provider regression coverage.

Rollback boundary: unwired transport/tests can be withdrawn without changing installed settings or mail.

## Phase 2 — Manager, wire types and compatibility

Start: Phase 1 passes. Finish: Go is safely selectable through the existing local engine API; no UI exposes an incomplete setup.

- [ ] 2.1 RED: add `apps/desktop/test/local-ai-opencode-go.test.ts` against the actual manager with a fake key provider, temporary data directory, captured diagnostics and injected fetch. Cover additive old-file loading, separate envelopes, saving/replacing/omitting keys, durable-key refusal, unavailable/probe transitions, None, Forget and restart.
- [ ] 2.2 GREEN: extend `apps/sidecar/src/ai-provider.ts` unions, keyed set, runtime allow-list, labels, defaults, storage/load/save/status paths, explicit block/transport selection and `contentGoesTo`. Keep version 1 and the quoted `"opencode-go"` block.
- [ ] 2.3 Extend `apps/desktop/src/local-ai.ts` mirrored contracts together with compile-coupled support in `AiProviderForm.tsx`: keyed type/predicate, complete vendor/host maps and explicit Go key/model write branches. Do not expose the visible Go option yet. Adjust `apps/sidecar/src/phone/ai-provider.ts` defaults only if required, retaining no-AI behavior. Update all concrete typed fixtures now, not in Phase 3.
- [ ] 2.4 TRIANGULATE: test key isolation across all three hosted providers; save clears/rechecks verification without inference; status is local; existing request `screen` and background classify-only ports remain distinct; repeated Go faults use existing withholding/rules-only behavior; model/sensitivity declines stay neutral.
- [ ] 2.5 REFACTOR: audit two-provider fallthroughs explicitly. Do not add TTL/revision protection, repair unrelated probe races or rewrite engine feature consumers as part of this feature.

### Success Criteria:
- V1/V3: persisted files and returned status contain no plaintext key; mode-0600 atomic storage, vendor isolation, old-file defaults, None/Forget and durable-key refusal match existing behavior.
- V2: save/status/startup introduce no completion; unproven Go credentials/entitlement cannot make features available.
- V4/V5: request screening and background fault/decline semantics remain intact; Go outage cannot silently select a paid vendor/model or permanently block sync after the existing fault gate trips.
- V7: phone stub remains unable to infer/store a key; engine consumers require no new self-host/mobile functionality.
- V8: engine/UI typechecks introduce no new diagnostics relative to the recorded baseline; the expanded desktop union compiles with complete form maps/types/branches in this same unit, and new focused manager tests pass.

Rollback boundary: no install auto-selects Go; restore a previous provider or None without deleting mailbox data. Document non-lossless older-build rewrites.

## Phase 3 — Shared setup UI, disclosures and regression verification

Start: Phase 2 passes. Finish: one complete desktop settings/onboarding flow exposes the approved provider.

- [ ] 3.1 RED: add `apps/desktop/test/opencode-go-form.test.tsx` using Phase 0's demonstrated passing rig and the real shared form. Cover Go selection/key isolation, approved-model pickers, verification failures/recovery, engine-driven destination, retained-key Forget and immediate status propagation. Extend `desktop-ai.test.ts`, `desktop-ai-verdict.test.tsx` and `desktop-first-run.test.tsx` only where their harness demonstrably reaches the assertions; retain their documented baseline failures separately.
- [ ] 3.2 GREEN: finish `apps/desktop/src/AiProviderForm.tsx` visible Go option, approved-model handling, status/disclosure and Forget condition on top of Phase 2's compile-safe support. Use the existing shared form and bridge; no sign-in/browser networking/new shell capabilities.
- [ ] 3.3 Update `apps/webapp/messages/en.json` and `de.json` together. Explain Go allowance, OpenCode/upstream content processing, limited compatible-model set and account-controlled overages. Do not claim subscription-only billing is client-enforced.
- [ ] 3.4 TRIANGULATE: extend `apps/desktop/test/local-suggest-lanes.test.ts` to pin Go to one lane, leaving other providers unchanged. Confirm Phase 2 updated typed fixtures in `desktop-switched-door-restores.test.tsx` and `ai-model-picker-matches-the-engine.test.tsx`; add behavior assertions only with working harnesses and obey `mock-factory-census.test.ts` conventions.
- [ ] 3.5 Update `apps/desktop/README.md` and root `README.md` for approved setup/model/data/billing contracts. No universal no-training/retention claim and no silent import of CLI credentials.
- [ ] 3.6 REFACTOR/VERIFY: run focused new/existing tests, engine/UI typechecks, both bundle builds/artifact scans and zero-network webview smoke. Keep pre-existing failures visible; do not change protected guards or add any-typed shims to manufacture green checks.
- [ ] 3.7 With separate permission only, perform synthetic live acceptance against each approved model and all three operations. Do not use real mailbox content or share keys. Record actual quota/billing/error observations without extrapolating guarantees.

### Success Criteria:
- V2/V6: selecting/saving/rendering/testing Go consumes no inference; UI never labels a public catalogue as credential verification and updates settings/onboarding/Screener availability immediately.
- V1/V3/V6: typed keys stay bound to their provider; switching clears the input; Forget remains available with only an inactive Go key; destination and billing copy match engine/account facts in both locales.
- V4/V5: existing automation toggles, draft review/no-send behavior, stored suggestions, chunk/stop bounds and explicitly serial Go lanes remain unchanged.
- V7: host-client artifact has no desktop-local provider surface and engine webview smoke records zero network requests; no new CSP/native permission is introduced.
- V8: focused new feature tests pass and reach real Go behavior through the demonstrated form rig; failures during mounting are not coverage. Existing-provider results, typecheck baseline deltas, bundle scans and any unrun/manual checks are documented honestly.

Rollback boundary: stop offering Go while preserving other providers; no account billing changes or key/mail-directory deletion.

## Verification commands

Use Node 22 and existing npm installations. Do not install or modify lockfiles as part of planning. Commands below are for the future approved implementation; Phase 0 records current blockers before calling them passing.

From repository root:

```sh
mise exec node@22.23.1 -- apps/desktop/node_modules/.bin/tsc --noEmit -p tsconfig.engine.json
```

From `apps/desktop`:

```sh
CI=true mise exec node@22.23.1 -- ./node_modules/.bin/vitest run test/opencode-go-transport.test.ts test/local-ai-opencode-go.test.ts test/opencode-go-form.test.tsx --maxWorkers=2 --minWorkers=1
CI=true mise exec node@22.23.1 -- ./node_modules/.bin/vitest run test/desktop-ai* test/ai-model-picker* test/local-suggest-lanes* test/desktop-first-run* test/desktop-switched-door-restores* test/desktop-messages* test/mock-factory-census* --maxWorkers=2 --minWorkers=1
mise exec node@22.23.1 -- npm run ui:typecheck
mise exec node@22.23.1 -- npm run ui:build:engine
mise exec node@22.23.1 -- npm run scan:engine
mise exec node@22.23.1 -- npm run smoke
mise exec node@22.23.1 -- npm run ui:build:host
mise exec node@22.23.1 -- npm run scan:host
```

The new test paths do not exist yet. Planning baseline actually ran only the three-file Vitest command recorded in design plus engine typecheck. Full build/packaging is not claimed. Consult root/desktop build instructions before any later packaged acceptance.
