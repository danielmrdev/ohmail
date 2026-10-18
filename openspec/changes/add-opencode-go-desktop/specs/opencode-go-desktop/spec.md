# OpenCode Go Desktop Specification

## Purpose

Define conditional OpenCode Go support for existing standalone-desktop screening, classification, and reviewable reply drafts. Preserve existing providers, mail-safety boundaries, and automation consent.

This is a requirements document, not implementation approval. It authorizes no application edits, credential access, provider calls, allowance use, mail-data transfer, account changes, commits, or publication. Runtime requirements below apply only after the gates and explicit implementation approval.

## Requirements

### Requirement: Evidence gates and separate approval

Application changes and release MUST remain blocked until G1–G4 evidence is recorded, dated provider contracts are revalidated, and the user explicitly approves implementation. Evidence MUST establish:

- **G1 — permission:** Written OpenCode clarification permits personal non-coding mail screening, classification, drafts, automatic/background operation, and end-user-owned keys, resolving coding-agent policy and Terms restrictions.
- **G2 — verification:** A confirmed non-inference contract accepts the intended credential/scopes and proves authenticated workspace and Go entitlement, with documented failure semantics. No response fields or privileged scopes are assumed.
- **G3 — billing:** Current account-control documentation and the user's confirmation establish that `Use balance / Extra usage` and applicable `Auto-reload / Auto-recharge` rules are disabled for subscription-only use. This does not authorize account inspection or changes.
- **G4 — compatibility and privacy:** At least one exact Go model has accepted privacy terms and synthetic evidence for all three operations, exact schemas, final-content extraction, reasoning controls, output bounds, non-streaming behavior, refusals, and truncation.

Credential use and live allowance consumption MUST require separate permission after G1, including synthetic G4 checks. Planning approval MUST NOT substitute for that permission or implementation approval. G1 refusal MUST stop the feature; an unsolved G2 or failed G4 MUST stop work for a readiness/design review rather than a workaround.

#### Scenario: Gates or implementation approval are missing

- GIVEN any gate lacks evidence, or all gates pass but implementation approval is absent
- WHEN the next phase is considered
- THEN application changes and release remain blocked, and no credential use or live check is inferred from this plan.

### Requirement: Additive provider configuration

The provider discriminator MUST be `opencode-go`. Public settings, settings writes, and persisted settings MUST use the quoted block key `"opencode-go"`. The block MUST retain independent `classifyModel` and `draftModel` settings, public `hasKey`, and encrypted-storage `keyEnc`/`keyVersion` semantics. Store version MUST remain 1, with additive member-wise defaults for old files. Loading or migrating settings MUST preserve existing provider selection, settings, and keys; migrations MUST NOT automatically select Go.

#### Scenario: Load existing version-1 settings

- GIVEN an existing settings file without a Go block, including existing hosted-provider keys
- WHEN the new settings shape is loaded and saved
- THEN missing members receive additive defaults, version remains 1, existing settings/envelopes survive, and Go is not automatically selected.

#### Scenario: Preserve independent task models

- GIVEN separately approved classification and drafting model choices
- WHEN one Go model setting changes
- THEN the other setting remains independent and the matching `"opencode-go"` block is written.

### Requirement: Isolated encrypted credentials and lifecycle

Go MUST use only its explicitly supplied dedicated OpenCode key, never another vendor's key. Blank or omitted key writes MUST retain the matching stored envelope. Selecting None MUST retain all envelopes; Forget MUST remove all stored hosted-provider envelopes, including inactive Go keys. Go MUST refuse secret storage without a durable install key and preserve existing encryption, mode-0600 atomic storage, and no-plaintext guarantees.

Keys MUST enter only through the existing engine bridge request body. They MUST NOT enter native-command arguments, environment/CLI lookup, status responses, logs, or plaintext storage. Status MUST expose only the existing non-secret key-presence semantics.

#### Scenario: Switch provider, select None, and Forget

- GIVEN distinct Go, OpenAI, and Anthropic envelopes
- WHEN providers are switched, a blank key is saved, None is selected, and then Forget is invoked
- THEN each provider uses only its matching envelope, blank input and None retain envelopes, and Forget deletes all envelopes without deleting mail or install keys.

#### Scenario: Durable encryption is unavailable

- GIVEN no durable install key
- WHEN a Go secret is submitted for storage
- THEN storage is refused and neither a plaintext secret nor a usable saved envelope is created.

### Requirement: Non-inference verification and honest readiness

Save, status, startup, rendering, and Verify MUST NOT run inference, including synthetic completions. `GET /local/ai` MUST remain local; `POST /local/ai/verify` and Save's automatic verification MUST use only an approved G2 non-inference contract. Settings changes MUST discard prior verification. Go availability and `probe.ok` MUST remain false until authenticated entitlement and approved-model checks succeed.

Public `GET /models` success MUST NOT authenticate credentials or prove entitlement, quota, or readiness. Failed per-model GETs MUST NOT provide such evidence. Console `GET /console/api/v2/config` MUST remain only a candidate until G2 confirms its contract. The existing catalogue probe MUST NOT be reused with its invalid Go assumptions. A quota-consuming Verify or configured-but-unverified readiness mode MUST require a revised, explicitly approved specification.

#### Scenario: A public catalogue is reachable

- GIVEN public model listing returns 200 and a per-model GET for a documented model returns 404, without authenticated entitlement evidence
- WHEN Save or Verify checks Go
- THEN Go remains unavailable, no key/subscription verification is claimed, and no completion is sent to resolve the uncertainty.

#### Scenario: Lifecycle actions do not consume allowance

- GIVEN mocked provider networking and existing verification state
- WHEN status, startup, render, Save, or Verify runs, including a settings change
- THEN no inference request occurs, status stays local, and changed settings cannot retain prior verification.

### Requirement: Fixed destination and honest client identity

Go inference MUST use only `https://opencode.ai/inference/go/v1/chat/completions`, Bearer authentication with its own key, the existing bounded deadline, and redirect refusal. Arbitrary hosted URLs, alternate inference routes, SDKs, OAuth, CLI credential reuse, browser networking, and new native commands or permissions MUST NOT be introduced. OpenAI's pinned destination MUST remain unchanged. Non-inference verification destinations MUST be approved through G2, not assumed here.

Requests MUST identify Ohmail with its own honest User-Agent and MUST NOT impersonate coding traffic. Session identifiers, if used under the approved provider semantics, MUST be opaque random identifiers for independent logical operations, stable across permitted retries, and unrelated to sender, account, message ID, subject, snippet, or other mailbox data.

#### Scenario: Inspect requests and refuse a redirect

- GIVEN a Go request with a distinctive key and mailbox context, and a redirect response
- WHEN mocked HTTP requests and diagnostics are inspected
- THEN inference targets only the fixed URL with the Go key and honest identity, session identifiers contain no mail-derived data, and no redirect is followed.

### Requirement: Small independently approved model subset

Selectable Go models MUST be a small explicitly reviewed subset of exact IDs, currently documented for Go Chat Completions and reported by the Go catalogue. Each model MUST independently pass G4. `glm-5.3-flash` and `kimi-k3` are candidates only; neither is an approved default. Future task defaults MUST be explicitly approved. Model names, Zen entries, and metadata alone MUST NOT establish compatibility or entitlement.

Responses, Messages, Gemini, undocumented legacy entries, Contributor models, and different-policy free variants MUST be excluded from version one. Runtime models.dev fetching, automatic substitution, and unfiltered catalogue exposure MUST NOT occur.

#### Scenario: Configured model is outside the approved subset

- GIVEN a public catalogue containing unapproved or other-protocol IDs, or a configured ID no longer meeting the approved checks
- WHEN models are offered or an operation is requested
- THEN selectors expose only the approved intersection and unsupported execution is declined without choosing another model or protocol.

### Requirement: Unchanged shared mail-input safety

Classification, screening, and drafting MUST reuse existing shared prompts, schemas, serializers, redaction, sensitivity sinks, and result coercers without changing their policies. Screening MUST use the screening question, not alias classification. Shared input rejection MUST occur before HTTP and MUST remain a neutral decline where existing behavior requires it.

#### Scenario: Compare operations and reject unsafe context

- GIVEN valid classification/screening/drafting fixtures and fixtures rejected by existing sensitive/extra-field checks
- WHEN each Go operation prepares its request
- THEN valid requests preserve the corresponding shared prompt/schema/serializer, screening uses its distinct question, and rejected inputs make no HTTP request.

### Requirement: Strict final structured output

Go MUST accept only final answer content that is strict JSON conforming to the unchanged task schema. It MUST preserve G4-approved schema enforcement, final-answer extraction, non-streaming behavior, and reasoning/token bounds. Reasoning text MUST NOT become answer content. Refusals, truncation, malformed or reasoning-only output, unsafe/extra fields, and schema failures MUST fail closed without a successful routing decision, suggestion, or stored draft.

The Go adapter MUST locally validate parsed final output before calling unchanged result coercers, using the shared schema declarations for required keys, primitive types, finite numbers, destination enums, and forbidden extra fields. Provider-side schema controls or normalization by coercers alone MUST NOT count as validation. The transport MUST NOT salvage JSON from arbitrary prose, silently drop schema controls or output caps, or copy OpenAI-specific parameter retries without evidence.

#### Scenario: Valid final content is separate from reasoning

- GIVEN an approved model returns a complete schema-valid final JSON answer with separate reasoning text
- WHEN the task response is validated
- THEN only final answer content reaches the unchanged result coercer, and reasoning does not affect the result.

#### Scenario: Provider output is unusable

- GIVEN mocked refused, truncated, malformed, reasoning-only, prose-wrapped and unsafe responses, plus valid JSON with missing, wrong-type or extra fields
- WHEN classification, screening, or drafting consumes a response
- THEN no successful action or stored draft is produced, and no weaker-schema retry is sent.

### Requirement: Existing execution ports and consent

The request classifier MUST preserve `screen`; `classifierForCycle()` MUST remain classify-only without `screen`. The existing automatic-suggestion fallback at that seam MUST NOT be repaired by this change. Existing routing, automation opt-ins, and draft review MUST remain unchanged. Selecting or verifying Go MUST NOT enable automation, and Go MUST NOT auto-send mail.

#### Scenario: Use request screening and a background cycle

- GIVEN Go is approved and ready, with existing automation preferences
- WHEN request screening, a background classification cycle, and draft generation run
- THEN request screening uses `screen`, the cycle retains its existing classify-only behavior, preferences remain unchanged, and drafts require review without sending.

### Requirement: Safe errors without fallback or speculative billing claims

Go failures MUST expose only safe provider/status/category information, never raw provider bodies that may echo secrets or mail. Auth, quota, network, server, invalid-response, and timeout failures MUST NOT trigger endpoint, provider, model, or data-policy fallback. Auth/quota failures MUST NOT be automatically retried. Account overage or recharge settings MUST NOT be changed automatically.

Unknown quota/reset semantics MUST remain unknown. HTTP 402 or 429 alone MUST NOT be presented as a proven subscription-exhaustion condition, known reset time, or guaranteed transient failure.

#### Scenario: Provider rejects or fails an operation

- GIVEN mocked 401, 403, 402, 429, 5xx, invalid responses, and timeouts, with bodies containing sentinel secrets/mail
- WHEN Go reports failure
- THEN diagnostics remain safe, no alternate destination/model/vendor is called, auth/quota failures are not automatically retried, billing settings are untouched, and unsupported reset claims are absent.

### Requirement: Existing background fault cooldown

Repeated Go background faults MUST use the existing fault gate, cooldown, withholding, and rules-only degradation. Existing sensitivity/model declines MUST retain their neutral semantics. This feature MUST NOT rewrite the sync pipeline or permanently stall sync after the existing fault gate trips.

#### Scenario: Repeated failures degrade through the existing gate

- GIVEN a background cycle experiencing repeated Go faults and separate neutral-decline fixtures
- WHEN existing fault thresholds are reached
- THEN faults trigger the existing cooldown/rules-only behavior, neutral declines do not become faults, and sync continues under the existing policy.

### Requirement: Serial Go Screener execution

Go MUST use one Screener lane: `lanesFor("opencode-go")` MUST equal 1. Other vendors' lane policies MUST remain unchanged. Existing chunk bounds, cancellation/stop limits, cached suggestions, and idempotency MUST remain unchanged.

#### Scenario: Run a Go Screener batch

- GIVEN multiple pending Screener chunks and existing other-vendor lane fixtures
- WHEN a batch runs or is cancelled
- THEN Go has at most one active lane, existing bounds/cache/idempotency behavior is preserved, and other vendors retain their current concurrency.

### Requirement: One shared setup form with vendor-bound input

Settings and onboarding MUST share the existing form and bridge, expose OpenCode Go as a separate choice, and offer only approved task models. Typed keys MUST remain bound to their vendor; switching vendors MUST clear unsubmitted key input. Forget MUST remain visible when only an inactive Go key exists. Settings and verification results MUST propagate to onboarding/settings/Screener availability without stale UI state.

English and German catalogues MUST have matching structure and equivalent disclosures. Setup MUST use documented explicit-key instructions, not embedded sign-in, account creation, automatic import, or new external-link shell capabilities.

#### Scenario: Switch vendors with a typed or retained Go key

- GIVEN onboarding or settings with an unsubmitted Go key, or only an inactive stored Go key
- WHEN another vendor is selected or retained keys are displayed
- THEN typed input is cleared and never submitted to that vendor, Forget remains available for the stored key, and both locales reflect engine state consistently.

### Requirement: Honest data destination and account-side billing disclosure

The engine MUST report `contentGoesTo: "opencode-go"` for Go; the UI MUST NOT map it to OpenAI, local processing, null, or absence. Setup/status copy MUST name `opencode.ai`, disclose selected upstream processing of supplied context, and explain approved-model-specific privacy limits without universal no-training/retention claims.

Copy MUST explain Go allowance consumption, possible server-side Extra usage spending from Console balance, the G3 account controls, and the absence of a client-enforced subscription-only billing guarantee. Subscription renewal MUST remain distinct from optional overage/recharge. Client-side fallback refusal MUST NOT be presented as a server-side spending cap.

#### Scenario: Review Go disclosures in both locales

- GIVEN Go engine status and the approved model/privacy and billing evidence
- WHEN English or German setup/status is rendered
- THEN the explicit Go destination and upstream processing are visible, allowance/overage/account-control limits are accurate, and no universal privacy or client-side billing guarantee is claimed.

### Requirement: Desktop-only boundary and honest acceptance evidence

The phone MUST remain no-AI and unable to infer or store keys, even if shared types require additive defaults. Self-host behavior MUST remain unchanged, and the host-client bundle MUST expose no desktop-local provider surface. The webview MUST remain offline with zero network requests; no Rust/CSP/native-permission expansion, dependency/lockfile change, or database migration is part of this feature. A protected guard rejection MUST stop work, not justify weakening the guard.

Acceptance MUST cover mocked transport/manager/form/lane safety, existing-provider regressions, typecheck deltas, bundle scans, and zero-network smoke. New form tests MUST mount the real shared form through a demonstrated working test-only rig; failures before feature assertions MUST NOT count as Go coverage or expected feature RED evidence. Existing production/harness repairs MUST require separate approval. Evidence MUST retain the design's failed pre-implementation engine typecheck and desktop baseline of 57 passed / 28 failed / 85 tests. Unrun builds/full-suite/packaged checks MUST NOT be claimed passing; unrelated fixes, ambient-any shims, and hidden baseline failures MUST NOT manufacture acceptance. Live acceptance MUST require separate permission and synthetic inputs, not real mailbox data.

#### Scenario: Review platform boundaries and verification results

- GIVEN phone/shared-type fixtures, desktop/host artifacts, webview smoke, and recorded pre-implementation failures
- WHEN acceptance evidence is reviewed after an approved implementation
- THEN phone/self-host isolation and zero webview networking are demonstrated, existing providers remain unchanged, and new results are distinguished from baseline failures and unrun checks without unrelated repairs.
