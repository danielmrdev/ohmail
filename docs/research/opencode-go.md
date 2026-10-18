# OpenCode Go support in Ohmail: research and eligibility check

Checked **2026-10-15** against official OpenCode documentation, public unauthenticated model-list endpoints, and first-party source snapshots.

## Result and scope

**Hold: permission for Ohmail's non-coding workload is not established.** Go supports third-party **coding agents**, not only OpenCode, but its documented client policy calls for typical coding-agent traffic. This is not permission for mail classification, screening, or drafting. The Terms also contain automation restrictions that need explicit clarification. Technical API access does not resolve either issue. [G], [T]

Scope: **desktop only**, covering all existing AI functions: Screener suggestions, message classification/routing, and reply drafts. No self-hosted or mobile changes. This document contains findings and prerequisites, not an implementation plan or OpenSpec proposal.

No account access, local credential reads, authenticated requests, inference requests, dependency installs, or application changes were performed. Only public documentation/source GETs and unauthenticated catalogue/metadata GETs were used.

Evidence labels:

- **Verified:** a statement in an identified primary source, or a public response observed on the check date. Published claims are not an independent service audit.
- **Unknown:** not established by the permitted research; do not substitute assumptions.
- **Implication:** a constraint or recommendation, not an implemented change.

## Permission: release blocker

**Verified:** [Go's “Where can I use it?” section][G] describes OpenCode and other coding agents producing similar requests. It asks clients to send typical coding-agent traffic, identify themselves with their own `User-Agent`, and send a stable `x-opencode-session` per conversation. Traffic is monitored for abuse. Third-party agents are explicitly supported; there is no OpenCode-only requirement. The broader “any agent” marketing on the [Go landing page][GL] does not explicitly authorize non-coding apps.

**Verified:** the [Terms of Use][T], effective **2026-08-15**, cover the website, inference product, and hosted service. They restrict use to the subscriber's own internal use; prohibit purposes not reasonably intended by OpenCode; restrict automatic/programmatic extraction of data or Output; and prohibit auto-responders and processes running or activated while the user is not logged in. These clauses are broader than the published API examples. Their application to normal API consumption is unclear, but cannot be ignored. The hosted service is not licensed merely by the CLI's open-source licence.

**Unknown:** permission for a personal desktop mail client's user-triggered screening/drafts, background classification, automatic suggestions, and processing correspondents' personal data. An editable draft is not necessarily an auto-responder, but that distinction alone does not authorize the other workloads. Zen also remains subject to the Terms; switching endpoints is not a permission workaround.

**Prerequisite:** obtain written confirmation from OpenCode (`help@anoma.ly`, the contact in the Terms) covering those exact functions, background operation, end-user-owned subscriptions/keys, and the quoted policy conflicts. If coding-agent-only scope is confirmed, Go is unsuitable for this feature. Do not impersonate OpenCode, fabricate coding sessions, or disguise mail as coding traffic.

## Subscription and authentication

| Question | Verified finding / limit |
| --- | --- |
| Subscription | Go is **$10/month**; Go Plus is **$40/month**, with higher limits. Both expose the documented Go lineup. Go workspaces must have a single member and cannot invite members. [G] |
| Direct-app credential | Go's setup says subscribe in Console, copy an **OpenCode API key**, and paste it into `/connect`. Direct applications do not need to invoke the CLI. No evidence of a mandatory special Go-only key format or separate upstream-provider credential. [G] |
| Wire authentication | Current inference docs specify `Authorization: Bearer <token>`. Console integration keys are workspace-bound service-account keys; the documented example prefix is `oc_sk_`. This is documentation, not a complete validation grammar or proof that every legacy key has that prefix. [A], [I] |
| Dedicated Ohmail key | A separate revocable, inference-only key would isolate access, if Console permits it for the subscriber's single-member Go workspace. Exact service-account/Go eligibility was not checked in an account. [A], [G] |
| OAuth | Current Console docs also publish an OAuth device flow for other CLIs, workspace-bound tokens, and rotating refresh tokens. Current OpenCode source implements that flow. Thus “OpenCode has no OAuth” would be false. Go's own setup still documents API-key entry; a supported third-party desktop OAuth path with Go entitlement needs confirmation. [A], [C] |
| CLI credential reuse | Unnecessary for direct API-key calls. No local credential files were inspected. No supported Ohmail credential-import contract was established; CLI login success would not prove permission for mail workloads. |

**Implication:** the least-assumption future option is an explicitly supplied OpenCode key with its own fixed destination, not borrowing an OpenAI/Anthropic key or silently reading an OpenCode installation. This remains conditional on workload permission.

## Base URL, protocols, and a free catalogue probe

**Verified:** Go's documented shared base is **`https://opencode.ai/inference/go/v1`**. Zen/pay-as-you-go uses **`https://opencode.ai/inference/v1`**. Go documents separate model-specific API families: [G], [Z]

| Go path appended to the base | Protocol |
| --- | --- |
| `/chat/completions` | OpenAI-compatible Chat Completions |
| `/responses` | OpenAI Responses |
| `/messages` | Anthropic-compatible Messages |
| `/models/<model-id>:generateContent` or `:streamGenerateContent` | Gemini; the model table gives the `/models/<model-id>` prefix. [I] |

Do not send every Go model to Chat Completions. General inference docs also publish protocol-explicit routes such as `/inference/openai/v1/chat/completions`; the Go model table and models.dev provider identify the shared Go base above. [I], [M]

**Legacy route:** `https://opencode.ai/zen/go/v1` still has official compatibility routes. The pinned proxy source forwards its chat, responses, messages, model-list, and usage routes to the new inference service. It explicitly delegates authentication, availability, and billing to that service. This does not prove all old and new paths are interchangeable. [P]

### Observed public GETs

No `Authorization`, cookies, or API keys were sent. Observed at approximately **09:13 UTC on 2026-10-15**, with model-detail checks at **09:19 UTC**; requests used `User-Agent: Ohmail-public-research/1.0`.

| URL | Observed result |
| --- | --- |
| `https://opencode.ai/inference/go/v1/models` | HTTP **200**, JSON, 37 entries |
| `https://opencode.ai/zen/go/v1/models` | HTTP **200**, same 37 IDs |
| `https://opencode.ai/inference/v1/models` | HTTP **200**, public pay-as-you-go catalogue |
| `https://opencode.ai/inference/go/v1/models/list` | HTTP **404**, empty body |
| `https://opencode.ai/inference/go/v1/models/kimi-k3` | HTTP **404**, empty body |
| `https://opencode.ai/zen/go/v1/models/kimi-k3` | HTTP **404**, HTML route-not-found page |

The documented list operation is **GET `/models`**, not a literal `/models/list`. Go docs show an unauthenticated `curl` for it. Observed response shape was `{"object":"list","data":[{"id":"…","object":"model","created":…, "owned_by":"opencode"}]}`. Despite the documentation's reference to metadata, the observed items did not identify protocol, reasoning support, JSON-schema support, account entitlement, remaining quota, or privacy policy. [G]

**Important:** no-auth HTTP 200 establishes that the catalogue is **public**. Invalid-key behavior was not tested; sending no key is already sufficient to disprove “listing authenticates.” The two detail-route checks above failed even for a documented, currently listed model. No general Go `GET /models/{id}` metadata contract was found; Gemini's POST generation routes are not model-detail GETs.

**Credential verification remains unsolved for Go in Ohmail.** A public list cannot validate a key, paid subscription, usable model, or balance. Ohmail's existing probe assumes an authenticated list plus per-model GETs; both assumptions fail here. **Save/Verify must remain non-inference operations**, not even a free/test completion. Catalogue reachability/membership must not become “key verified” or “subscription ready.” [L2]

Console does document authenticated `GET https://opencode.ai/console/api/v2/config`, returning workspace providers, including Go. This is a possible non-inference auth-check candidate, not a validated Go verification contract: compatibility with existing subscriber keys, entitlement interpretation, and quota/readiness semantics need confirmation. No authenticated request was made. [A]

## Exact Go model IDs and Zen distinction

The pinned Go endpoint table documents **32 IDs**, all present in the observed Go list. The landing page's “31 models” count is already inconsistent. Treat source/live disagreement as a gate, not as proof of extra entitlement. The following is the complete documented Go lineup on the check date; Go Plus changes allowances, not this list. [G], [GL]

| Exact model IDs | Go protocol | Same exact ID documented in Zen? |
| --- | --- | --- |
| `glm-5.2`, `glm-5.3`, `glm-5.3-flash` | Chat Completions | Yes |
| `kimi-k2.6`, `kimi-k2.7-code`, `kimi-k3` | Chat Completions | Yes |
| `deepseek-v4.1-flash`, `deepseek-v4-pro` | Chat Completions | Yes |
| `longcat-2.0`, `hy3`, `hy4-preview`, `space-bunny` | Chat Completions | No |
| `mimo-v2.5`, `mimo-v2.5-pro`, `mimo-v2.6-flash`, `mimo-v2.6-pro` | Chat Completions | No |
| `longcat-2.5-preview-free`, `step-5-preview-free`, `cat-jam-free` | Chat Completions | Yes; limited-time free models |
| `grok-4.6`, `grok-4.7`, `gpt-5.6-luna`, `gpt-6-luna` | Responses | Yes |
| `muse-spark-1.2-contributor`, `muse-spark-1.3-contributor` | Responses | No |
| `claude-haiku-5-5`, `minimax-m2.7`, `minimax-m3`, `qwen3.8-flash`, `qwen3.8-max` | Messages | Yes |
| `qwen3.7-plus` | Messages | Yes in docs, absent from observed Zen list |
| `gemini-4-argon-contributor` | Gemini | No |

“Not documented in Zen” is not proof that an undocumented alias could never work. Conversely, even the same ID can use a different protocol: Zen documents `minimax-m2.7`, `minimax-m3`, and `qwen3.8-max` under Chat Completions, while Go documents them under Messages. [G], [Z]

Five additional IDs appeared in Go's public list but not its current endpoint/allowance table: **`glm-5.1`, `minimax-m2.5`, `omen-alpha`, `qwen3.6-plus`, `qwen3.7-max`**. Their current included usage, protocol, and suitability are **unverified**. models.dev also retains deprecated entries; catalogue presence is not a subscription guarantee. [M]

Zen offers additional IDs such as `claude-sonnet-4-6`, `claude-opus-4-6`, and `gpt-5.4`; these are not documented Go inclusions. Contributor, ordinary, and `-free` variants are distinct IDs and may have different privacy terms. Never infer that a Go subscription covers the full Zen catalogue. [Z]

## Reasoning, content, and structured responses

**Verified metadata, not verified inference:** models.dev's Go provider defaults to `@ai-sdk/openai-compatible`, with per-model Anthropic/OpenAI/Google overrides matching the Go documentation. Several Chat Completions models explicitly identify `reasoning_content` as separate from answer content. Examples include GLM, Kimi, and DeepSeek entries. [M], [MK], [MD]

The resolved public [models.dev catalogue][MJ] marks `structured_output: true` for examples including `glm-5.3-flash`, `kimi-k3`, `deepseek-v4.1-flash`, `qwen3.8-max`, and `gpt-6-luna`. Other models, including `minimax-m2.7` and `kimi-k2.6`, do not publish that flag. Absence means **unknown**, not proven unsupported. [MQ]

**Unknown / implement-time gate:** end-to-end acceptance and enforcement of Ohmail's exact strict JSON schemas, `response_format`/JSON mode, reasoning controls, temperature, output-token parameters, refusals, truncation, and non-streaming responses for any selected Go model. Metadata does not guarantee OpenAI's exact `json_schema` envelope or `strict: true` semantics across providers. No authenticated compatibility test was run.

**Implication:** Ohmail's current OpenAI transport extracts `choices[0].message.content`, parses JSON, and sends strict named `response_format` schemas for all three AI functions. Reasoning must not be substituted for the answer or interpreted as mail-routing JSON. A compatible model must preserve validated final content; unsupported schema controls must not silently weaken that contract. Responses, Messages, and Gemini need their own response shapes. No default Go model is approved by this research. [L1]

## Limits, errors, and accidental spending

**Verified:** Go documents token-priced allowances, with model-dependent monthly dollar-equivalent limits; 5-hour usage is 20% and weekly usage 50% of the monthly allowance. Examples: Go `glm-5.3-flash` has a $60 monthly allowance, `kimi-k3` $15, and `deepseek-v4.1-flash` $80; Go Plus raises these limits. These are not cash credits or guaranteed request counts. Request estimates assume large cached coding contexts and should not be applied to independent mail messages. Do not assume model allowances are independent balances that can be summed. Limits may change. [G]

**Verified overage:** when **Use balance** is enabled and Console credits are available, Go falls back automatically to pay-as-you-go balance after its included limits. Newer billing docs call the control **Extra usage** on Overview. This is server-side billing behavior, not a client-selected alternate model. [G], [B]

**Separate charge risk:** Zen/model docs describe automatic balance reload ($20 when below $5), with configurable amount or disabling. Newer billing docs instead describe configurable **Auto-recharge** rules. Fees/default descriptions also differ between those pages. Do not promise a universal current default without checking the user's Console settings. Monthly spend limits do not necessarily prevent a credit-card top-up. [Z], [B]

**Prerequisite for subscription-only operation:** the user must disable **Use balance / Extra usage** and remove/disable **Auto-reload / Auto-recharge** rules, then confirm the result. Keep Go subscription renewal distinct: it remains a recurring charge until cancelled. No documented request flag was found that guarantees “subscription only”; refusing client-side provider fallback alone cannot enforce that promise. No account settings were read or changed. [T], [G], [B]

| Error area | Grounded evidence / unknown |
| --- | --- |
| Key/session rejection | Console docs specify HTTP `401` for missing/invalid/expired/revoked credentials and `403` for workspace/permission errors. These are not an exhaustive Go inference error contract. [A] |
| Paid balance exhausted | Billing docs specify HTTP `402` and `Upstream request failed: Insufficient account funds`. Invoiced credit limits/overdue invoices can also produce `402`. This does not establish the code for subscription-quota exhaustion. [B] |
| Legacy proxy unavailable | Pinned source emits HTTP `503`, `error.type: api_error`; it translates downstream `404` to `400` on legacy routes. [P] |
| Go quota/rate exhaustion | Exact status, error codes/body, reset headers, `Retry-After`, concurrent-request limits, and requests-per-minute limits were not established in current Go docs or the public compatibility source. Do not invent OpenAI-style `insufficient_quota` or assume every `429` is transient. |

**Implication:** surface exhausted allowance, exhausted credits, authorization failure, and transient failure separately when a supported contract is available. Never automatically switch Go to Zen, a different paid provider, or a free model with different data terms.

## Privacy and mail data

**Verified published Go policy, not a blanket ZDR promise:** [G]

| Go model group | Training / retention stated by OpenCode |
| --- | --- |
| GLM, Kimi, LongCat, MiMo, Qwen, MiniMax, Hy, `space-bunny`, `longcat-2.5-preview-free`, `step-5-preview-free` | No training; 0-day retention |
| `deepseek-v4.1-flash`, `deepseek-v4-pro` | No training; 0 days under a monthly renewed agreement, currently valid through **2026-10-31** |
| Grok 4.6/4.7, GPT Luna variants, Claude Haiku 5.5 | No training; **30-day retention** |
| `cat-jam-free` | No training; **30-day retention**; regional restrictions |
| Gemini Argon Contributor, Muse Spark Contributor variants | Prompts/completions may train Google/Meta models; **not ZDR**; Meta variants also have regional restrictions |

The [Privacy Policy][PR], effective **2026-03-06**, describes AI prompts/conversations as passed upstream and not stored by OpenCode. It separately collects account, payment, device/IP and related personal data, with retention for business/legal needs rather than a fixed universal duration. The [Terms][T] permit content use for service/safety purposes and improvement for unpaid accounts, and defer upstream retention to model providers. A paid Go subscription must not be presented as a universal no-training guarantee, particularly for Contributor or free fallback variants.

Residency claims are also inconsistent: the Zen landing page says US, while model docs say US and EU; neither establishes a selectable EU-only Go region or mail-specific DPA. **Unknown:** applicable processor/subprocessor terms, region controls, and sufficient contractual safeguards for the intended mailbox data. Preserve existing redaction/data minimization, and do not put message bodies, addresses, or subjects into session IDs or logs. [Z], [PR], [L1]

## Minimal desktop implications and prerequisites

Local code checked at Ohmail revision `a09be04c7986917bf989529768d3ad7935b8640d`:

- [The OpenAI transport][L1] deliberately fixes its secret-bearing destination to `https://api.openai.com`, refuses redirects, and uses strict JSON schemas. A base-URL setting is not a safe shortcut for a new keyed provider.
- [The shared catalogue probe][L2] treats listing as authentication and then fetches each model by ID. Public Go listing cannot establish equivalent readiness.
- The same desktop transport boundary covers classification, screening, and drafting. Any future approval must cover **all three**, including automatic/background use, without weakening redaction or result validation. Self-hosted/mobile work remains out of scope. [L1], [L2]

Focused gates before design or implementation:

1. **Permission first:** written authorization for the exact non-coding/background mail workloads, resolving the coding-agent policy and Terms restrictions. Stop if refused.
2. **Auth and billing contract:** confirm Go-compatible per-app credential issuance, a non-billable entitlement check, exact quota/error/reset semantics, and a reliable subscription-only spending configuration.
3. **Model/data decision:** choose only documented eligible IDs with accepted retention/training/residency terms; resolve catalogue discrepancies and the time-limited DeepSeek agreement before using them.
4. **Compatibility evidence:** after permission and separate approval for credential use/possible charges, verify selected models against all existing mail schemas, reasoning/content separation, refusal/truncation handling, and all three AI functions. These tests are future prerequisites, not performed work.

No implementation plan, OpenSpec, or application code was created.

## Primary sources and revision notes

Live documentation can change independently of source. OpenCode source links below pin default-branch (`dev`) snapshot **`4397ee44d038a5f17bf6ac161431673d93e563b5`** (2026-10-15); this does not assert the deployed service runs that exact commit. models.dev links pin **`5ad99719fd79075d1afb5aa99a30f80c7e1f7eb5`** (2026-10-15). Public API observations are dated above, not permanent availability promises.

[G]: https://opencode.ai/v2/docs/console/go/
[GL]: https://opencode.ai/go
[Z]: https://opencode.ai/v2/docs/console/models/
[T]: https://opencode.ai/legal/terms-of-service
[PR]: https://opencode.ai/legal/privacy-policy
[A]: https://opencode.ai/v2/docs/console/api/
[I]: https://opencode.ai/v2/docs/console/api/inference/
[B]: https://opencode.ai/v2/docs/console/billing/
[C]: https://github.com/anomalyco/opencode/blob/4397ee44d038a5f17bf6ac161431673d93e563b5/packages/core/src/plugin/provider/opencode.ts#L105-L160
[P]: https://github.com/anomalyco/opencode/blob/4397ee44d038a5f17bf6ac161431673d93e563b5/packages/console/app/src/lib/inference-proxy.ts
[M]: https://github.com/anomalyco/models.dev/blob/5ad99719fd79075d1afb5aa99a30f80c7e1f7eb5/providers/opencode-go/provider.toml
[MK]: https://github.com/anomalyco/models.dev/blob/5ad99719fd79075d1afb5aa99a30f80c7e1f7eb5/providers/opencode-go/models/kimi-k3.toml
[MD]: https://github.com/anomalyco/models.dev/blob/5ad99719fd79075d1afb5aa99a30f80c7e1f7eb5/providers/opencode-go/models/deepseek-v4.1-flash.toml
[MQ]: https://github.com/anomalyco/models.dev/blob/5ad99719fd79075d1afb5aa99a30f80c7e1f7eb5/providers/opencode-go/models/qwen3.8-max.toml
[MJ]: https://models.dev/api.json
[L1]: ../../apps/sidecar/src/ai-openai.ts
[L2]: ../../apps/sidecar/src/ai-transport.ts

Pinned documentation/policy source: [Go](https://github.com/anomalyco/opencode/blob/4397ee44d038a5f17bf6ac161431673d93e563b5/services/www/src/docs/content/console/go.mdx), [models/Zen](https://github.com/anomalyco/opencode/blob/4397ee44d038a5f17bf6ac161431673d93e563b5/services/www/src/docs/content/console/models.mdx), [API/auth](https://github.com/anomalyco/opencode/blob/4397ee44d038a5f17bf6ac161431673d93e563b5/services/www/src/docs/content/console/api/index.mdx), [inference](https://github.com/anomalyco/opencode/blob/4397ee44d038a5f17bf6ac161431673d93e563b5/services/www/src/docs/content/console/api/inference.mdx), [billing](https://github.com/anomalyco/opencode/blob/4397ee44d038a5f17bf6ac161431673d93e563b5/services/www/src/docs/content/console/billing.mdx), [Terms](https://github.com/anomalyco/opencode/blob/4397ee44d038a5f17bf6ac161431673d93e563b5/packages/console/app/src/routes/legal/terms-of-service/index.tsx), [Privacy](https://github.com/anomalyco/opencode/blob/4397ee44d038a5f17bf6ac161431673d93e563b5/packages/console/app/src/routes/legal/privacy-policy/index.tsx).
