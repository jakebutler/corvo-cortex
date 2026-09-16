# Corvo Cortex Model Routing, Credit Policy, and Recommender Plan

**Date:** 2026-06-28  
**Status:** Draft plan of record  
**Primary clients:** FreshProof and lower-db  
**Scope:** Planning only. No implementation has started.

## Problem Statement

Corvo Cortex already routes inference requests, but its routing model is not rich enough for Corvo Labs' real provider estate. The current system has two routing paths: legacy model-family routing across direct providers, and Kinisi-specific header routing that only knows about Fireworks and OpenRouter. It also tracks provider balances, but it cannot express entitlement policy, provider reservations, no-paid-spend guarantees, model-family subscription rules, or benchmark-backed task recommendations.

FreshProof and lower-db need Cortex to become a no-paid-dollar inference control plane that can:

- Route requests through the best available subscription, credit, or quota-backed provider.
- Preserve provider-specific credits for provider-specific features.
- Use PioneerAI's monthly quota as overflow before any paid API spend.
- Recommend models by task using a weighted blend of Corvo primary evals and secondary benchmark sources.
- Store prompts, responses, scores, and provenance so routing decisions are auditable.

## Solution

Build a unified routing and recommendation system around four deep modules:

1. **Provider Registry:** Defines providers, models, capabilities, modalities, restrictions, and callable transport.
2. **Credit and Entitlement Manager:** Knows what can be used without paid spend, how quotas reset, and when a route must be rejected.
3. **Routing Decision Engine:** Turns request intent, client overrides, model availability, credits, reservations, and health into an ordered route plan.
4. **Model Intelligence Corpus and Recommender:** Stores benchmark evidence and returns task classification plus a top-5 model list with scores and reasoning.

The existing adapters, circuit breaker, credit ledger, model catalog, and telemetry should be reused, but provider and routing policy should move out of hardcoded branch logic.

## Locked Requirements

- FreshProof and lower-db are the first client apps.
- Cortex must not intentionally spend paid provider dollars.
- PioneerAI's `$1500/month` quota is the overflow lane after subscriptions and credits.
- PioneerAI quota resets monthly and requests fail when quota is exceeded.
- OpenAI/Codex and Anthropic are both API and subscription-backed.
- Coding-specific Codex and Claude model use can route through subscription-backed lanes.
- Images, STT, embeddings, and similar modality APIs must route through API-backed lanes.
- PioneerAI, Fireworks, and Z.ai have API credentials.
- Any GLM-family model routes through Z.ai when available.
- OpenRouter is last resort, even when it appears better on price/performance, unless the requested model is unavailable anywhere else.
- OpenRouter may not be used after its credits are exhausted if that would incur paid spend.
- DigitalOcean Serverless Inference credits must not be used for OpenAI, Anthropic, Fal, or Arcee models.
- Fireworks credits are reserved for training/fine-tuning and fine-tuned model inference.
- General Fireworks inference is out of the default v1 routing pool.
- Client apps can request provider/model overrides, but server policy still blocks paid spend and reserved-credit violations.
- The recommender should optimize for cost plus quality.
- The recommender should include scores, not just qualitative reasoning.
- The research corpus should store prompts and responses.
- No current provider/data residency restriction is required.
- Cloudflare AI Gateway may be used for gateway controls, but not Cloudflare-paid inference.

## Task Taxonomy

Artificial Analysis public methodology and API coverage are useful secondary sources, especially for broad model intelligence, speed, pricing, coding, agentic, and scientific reasoning comparisons.

Base taxonomy for Cortex v1:

- `general_intelligence`: broad instruction following, reasoning, factuality.
- `coding`: code generation, code review, debugging, migration, Codex/Claude coding routes.
- `agentic_tool_use`: multi-step tasks, tool calling, planning, browser/API workflows.
- `scientific_reasoning`: GPQA-like scientific/technical reasoning.
- `claim_extraction`: FreshProof/lower-db extraction-only tasks.
- `evidence_policy`: evidence sufficiency, source-of-record judgment, source quality, claim atomization.
- `json_schema_repair`: strict JSON, schema conformance, malformed output recovery.
- `long_context_synthesis`: article/document synthesis, cross-source comparison.
- `summarization_editorial`: digest, article, and product-copy summarization.
- `multimodal_generation`: image generation and other generated media.
- `speech_audio`: STT/TTS/audio endpoints.
- `embeddings_retrieval`: embeddings, reranking, retrieval support.

Task classes must remain extensible. Artificial Analysis categories should seed the taxonomy, not constrain FreshProof/lower-db domain-specific classes.

## Provider Policy

### OpenAI and Codex

- Use subscription-backed coding lanes for Codex/coding tasks where callable.
- Use API-backed lanes for embeddings, STT, images, and non-subscription-only modalities.
- API use requires configured free credit or explicit zero-paid entitlement.
- Paid API spend is disallowed.

### Anthropic

- Use subscription-backed Claude coding lanes for coding tasks where callable.
- Use API-backed Anthropic lanes only when entitlement/credits are available.
- Paid API spend is disallowed.

### Z.ai

- GLM-family requests route through Z.ai by default.
- Z.ai provider concurrency limits remain a first-class policy input.
- If Z.ai quota/credits fail and the same model is available nowhere else without paid spend, return a policy failure rather than spending paid dollars.

### PioneerAI

- Monthly quota-backed overflow lane.
- Use after direct subscriptions/credits unless a task/model policy explicitly prefers Pioneer.
- Quota state should be tracked monthly and hard-fail once exhausted.
- Live model IDs must be validated against the live catalog before benchmark/routing use because prior FreshProof runs showed doc aliases and serving IDs can differ.

### DigitalOcean Serverless Inference

- Eligible only for models covered by the Serverless Inference credit.
- Exclude OpenAI, Anthropic, Fal, and Arcee models from DigitalOcean credit routing.
- Use as a low-cost/free-credit lane for supported models and task classes.

### Fireworks

- Reserve for training/fine-tuning and fine-tuned model inference.
- Do not use for generic inference in v1 routing.
- Maintain capability metadata for model training, LoRA/fine-tune deployment, and fine-tuned model inference.

### OpenRouter

- Last resort only.
- Eligible when the requested model is unavailable through direct/subscription/quota-backed providers.
- Eligible only while OpenRouter credits remain.
- If OpenRouter credits are exhausted, routes that would spend paid dollars must be rejected.

## Routing Semantics

Routing should evaluate hard constraints first, then rank eligible routes.

Hard constraints:

- No paid spend.
- Provider/model availability.
- Provider reservation rules.
- Client provider/model allow/block overrides.
- Modality support.
- Credit/quota balance.
- Provider health and circuit state.
- Concurrency caps.

Ranking factors:

- Cost using available credits/subscription/quota.
- Task-specific quality score.
- Freshness and authority of evidence.
- Latency and throughput.
- Client preference and override strength.
- Fallback safety.

Override semantics:

- `prefer`: client preference affects ranking only.
- `force_model`: client can require a model, but Cortex chooses an eligible provider.
- `force_provider`: client can require a provider only if policy permits.
- `strict`: if client constraints eliminate all eligible no-paid routes, return an error instead of silently falling back.

## Recommender API

### Endpoint

`POST /v1/recommendations`

### Request Shape

```json
{
  "queries": [
    {
      "id": "optional-client-id",
      "messages": [{ "role": "user", "content": "..." }],
      "taskHint": "claim_extraction",
      "constraints": {
        "modality": "text",
        "maxLatencyMs": 10000,
        "requireNoPaidSpend": true,
        "providerAllow": ["pioneer", "z-ai"],
        "providerBlock": ["openrouter"]
      }
    }
  ],
  "topK": 5,
  "includeScores": true,
  "includeEvidence": true
}
```

### Response Shape

```json
{
  "object": "recommendation.list",
  "data": [
    {
      "queryId": "optional-client-id",
      "classification": {
        "taskClass": "claim_extraction",
        "confidence": 0.84,
        "secondaryClasses": ["json_schema_repair"]
      },
      "recommendations": [
        {
          "rank": 1,
          "model": "gpt-5-nano",
          "providerCandidates": ["pioneer"],
          "score": 0.91,
          "qualityScore": 0.98,
          "costScore": 1.0,
          "latencyScore": 0.65,
          "evidenceConfidence": 0.72,
          "reasoning": [
            "Best current FreshProof evidence-policy score among completed Pioneer runs.",
            "Eligible under no-paid-spend policy through Pioneer quota."
          ],
          "evidence": [
            {
              "source": "corvo_primary_eval",
              "artifact": "docs/operations/lowerdb-evidence-pipeline/evals/2026-06-03-pioneer-expanded-model-sweep-report.md",
              "metric": "agreement",
              "value": "44/45"
            }
          ]
        }
      ],
      "policyWarnings": []
    }
  ]
}
```

## Model Intelligence Corpus

Use Cloudflare free services conservatively:

- **D1:** structured model, task, benchmark, score, and provenance records.
- **R2:** prompt/response artifacts, raw run outputs, and large traces.
- **KV:** small config snapshots and cached lookup maps only.
- **Durable Objects:** hot counters, monthly quota ledgers, rate limits, and provider locks.
- **AI Gateway:** optional upstream proxy for analytics, caching, rate limits, and spend limits; Cortex still owns credentials and no-paid routing policy.

Suggested D1 tables:

- `providers`
- `provider_entitlements`
- `provider_credit_snapshots`
- `models`
- `model_provider_availability`
- `model_capabilities`
- `task_classes`
- `benchmark_sources`
- `benchmark_runs`
- `benchmark_cases`
- `benchmark_results`
- `prompt_response_artifacts`
- `recommendation_feedback`
- `route_decisions`

Suggested artifact fields:

- `artifactId`
- `sourceType`: `corvo_primary_eval | artificial_analysis | swe_bench | hugging_face | vendor_catalog | manual_note`
- `authorityLevel`: `human_decision | derived_human_gold | llm_adjudicated_control | synthetic_control | pending_human_review | draft_scaffold | benchmark_secondary | catalog_only`
- `taskClass`
- `model`
- `provider`
- `repo`
- `repoCommit`
- `dirtySnapshot`
- `absolutePath`
- `policyVersion`
- `promptVariant`
- `servingModelId`
- `promptHash`
- `responseHash`
- `promptR2Key`
- `responseR2Key`
- `scores`
- `sampleCount`
- `labelStatus`
- `splitMembership`
- `usedAsFewShot`
- `createdAt`
- `observedAt`
- `expiresAt`

Do not merge task-specific label enums. Claim extraction labels include `accept`, `edit`, `split`, `no_claim`, `ambiguous`, and `reject`. Evidence-routing labels include `keep_blocked`, `request_source_of_record`, `split_into_atoms`, and related evidence-policy resolutions.

## FreshProof and lower-db Import Shortlist

These artifacts are the initial import candidates. The corpus must preserve authority level rather than flattening every artifact into equal benchmark data.

### Highest Authority

- `/Volumes/rexy/GitHub/freshproof/docs/operations/lowerdb-evidence-pipeline/eval-criteria.md`
  - Type: methodology and promotion criteria.
  - Task classes: `evidence_policy`, `claim_extraction`, `json_schema_repair`.
  - Import use: task definitions, gate thresholds, score semantics.

- `/Volumes/rexy/GitHub/freshproof/docs/operations/lowerdb-evidence-pipeline/baselines/2026-05-25-post-atom-source-apply/review-pack/human-review-gold-labels.jsonl`
  - Type: 45-row human-gold evidence-policy labels.
  - Task classes: `evidence_policy`, source-of-record judgment, atomization.
  - Import use: benchmark cases and gold labels.
  - Authority caveat: `goldResolution` is reviewer-derived from decisions, notes, and overrides. Store as `derived_human_gold`, with raw human decisions preserved separately.

- `/Volumes/rexy/GitHub/freshproof/docs/operations/lowerdb-evidence-pipeline/baselines/2026-05-25-post-atom-source-apply/review-pack/human-decisions.jsonl`
  - Type: raw human review decisions.
  - Task classes: `evidence_policy`, source-of-record judgment, atomization.
  - Import use: `human_decision` source rows for the derived gold labels.

- `/Volumes/rexy/GitHub/freshproof/docs/operations/lowerdb-evidence-pipeline/baselines/2026-05-25-post-atom-source-apply/review-pack/comparison-reference.jsonl`
  - Type: original proposal/reference comparison rows.
  - Import use: row context and baseline proposal metadata.

- `/Volumes/rexy/GitHub/freshproof/docs/operations/lowerdb-evidence-pipeline/baselines/2026-05-25-post-atom-source-apply/review-pack/human-review-gold-summary.md`
  - Type: summary of 45 human decisions, failure modes, and validation state.
  - Import use: benchmark run metadata.

- `/Volumes/rexy/GitHub/freshproof/docs/operations/lowerdb-evidence-pipeline/baselines/2026-05-25-post-atom-source-apply/review-pack/automated-reviewer-v2-eval-summary.md`
  - Type: deterministic reviewer calibration against the 45-row gold set.
  - Import use: baseline evaluator performance, not model performance.

### Model Performance Evidence

- `/Volumes/rexy/GitHub/freshproof/docs/operations/lowerdb-evidence-pipeline/evals/2026-06-03-pioneer-expanded-model-sweep-report.md`
  - Type: Pioneer-only 45-claim model sweep.
  - Task classes: `evidence_resolution_routing`, structured review-gated judgment.
  - Import use: model benchmark results with in-sample caveat.
  - Notable scores: `Qwen/Qwen3-1.7B-Base` 45/45 prior best, `gpt-5-nano` 44/45, `qwen3.6-flash` 41/45, `claude-opus-4-7` 39/45, `gpt-5-mini` 38/45.
  - Authority caveat: in-sample few-shot calibration. Do not treat as final promotion evidence without held-out validation.

- `/Volumes/rexy/GitHub/freshproof/docs/operations/lowerdb-evidence-pipeline/evals/2026-06-03-pioneer-model-catalog-correction.md`
  - Type: Pioneer serving-ID correction note.
  - Import use: provider catalog caveats and alias normalization.

- `/Volumes/rexy/GitHub/freshproof/docs/operations/lowerdb-evidence-pipeline/evals/2026-06-02-*` and `2026-06-03-*` per-model summary folders
  - Type: per-model smoke/full-run rows and summaries.
  - Import use: raw model-run evidence after dedupe by task, prompt variant, dataset, and provider.

- `/Volumes/rexy/GitHub/freshproof/docs/operations/lowerdb-evidence-pipeline/evals/2026-06-02-new-20-validation-set/`
  - Type: held-out 20-row validation pack.
  - Task classes: `evidence_resolution_routing`.
  - Import use: pending validation cases only.
  - Authority caveat: current score summary is pending human review; import as `pending_human_review`, not model-ranking evidence.

### Claim Extraction Controls

- `/Volumes/rexy/GitHub/freshproof/docs/operations/lowerdb-evidence-pipeline/claim-extraction-v2/2026-06-03-initial-gold-review/README.md`
  - Type: sentence-scoped claim extraction review pack definition.
  - Authority caveat: planned human review shape, not itself labels.

- `/Volumes/rexy/GitHub/freshproof/docs/operations/lowerdb-evidence-pipeline/claim-extraction-v2/2026-06-03-initial-gold-review/llm-adjudicated-decisions.jsonl`
  - Type: LLM-adjudicated extraction controls.
  - Authority caveat: not human gold.
  - Import use: weak/medium confidence controls, excluded from human-gold scoring.

- `/Volumes/rexy/GitHub/freshproof/docs/operations/lowerdb-evidence-pipeline/claim-extraction-v2/2026-06-03-initial-gold-review/adjudication-report.md`
  - Type: summary of LLM-adjudicated controls.
  - Import use: methodology and unresolved-row counts.

- `/Volumes/rexy/GitHub/freshproof/docs/operations/lowerdb-evidence-pipeline/claim-extraction-v2/2026-06-03-initial-gold-review/human-review-required.jsonl`
  - Type: unresolved rows requiring human review.
  - Import use: review queue only, not benchmark labels.

### Baselines and Synthetic Controls

- `/Volumes/rexy/GitHub/freshproof/docs/operations/lowerdb-evidence-pipeline/baselines/2026-05-25-post-atom-source-apply/`
  - Type: frozen FreshProof-owned evidence baseline.
  - Import use: `evidence-policy.json`, `evidence-controls.jsonl`, `blocker-report.jsonl`, `baseline-blockers.jsonl`, `evidence-proposals.jsonl`, and `eval-loop/promotion-report.json`.
  - Authority caveat: high methodology/control value, but proposals are review-gated and should not be imported as accepted clears.

- `/Volumes/rexy/GitHub/freshproof/evals/datasets/evidence-policy-synthetic.json`
  - Type: synthetic deterministic controls.
  - Task classes: `evidence_policy`, edge-case regression testing.
  - Import use: taxonomy and regression fixtures, not model recommendation.

- `/Volumes/rexy/GitHub/freshproof/docs/operations/lowerdb-evidence-pipeline/evals/2026-05-27-synthetic-policy-eval/`
  - Type: synthetic policy eval outputs.
  - Import use: deterministic control evidence only.

- `/Volumes/rexy/GitHub/freshproof/evals/datasets/claim-extraction-corpus.json`
  - Type: claim-extraction benchmark scaffold.
  - Authority caveat: low performance authority. Current corpus is small/draft; import schema and methodology, not decisive ranking data.

- `/Volumes/rexy/GitHub/freshproof/evals/prompts/`
  - Type: claim-extraction prompt definitions.
  - Import use: prompt provenance and task examples.

- `/Volumes/rexy/GitHub/freshproof/evals/evaluators/`
  - Type: evaluator definitions.
  - Import use: scoring semantics and reproducibility context.

- `/Volumes/rexy/GitHub/freshproof/docs/experiments/raw-results/`
  - Type: raw experiment results.
  - Authority caveat: import only after dedupe and authority classification.

### Lower-db Source Artifacts

- `/Volumes/rexy/GitHub/lower-db/docs/claim-ledger-content-verification-architecture.md`
  - Type: architecture and terminology.
  - Import use: task taxonomy and domain vocabulary.

- `/Volumes/rexy/GitHub/lower-db/docs/operations/claim-source-corpus.md`
  - Type: source corpus operations.
  - Import use: evidence/source-quality task semantics.

- `/Volumes/rexy/GitHub/lower-db/agent-team/config/models.json`
  - Type: local model configuration.
  - Import use: historical model inventory only; verify before using as current routing truth.

- `/Volumes/rexy/GitHub/lower-db/agent-team/prompts/*.md`
  - Type: task prompt definitions.
  - Import use: task class examples and prompt-response artifact grouping.

- `/Volumes/rexy/GitHub/lower-db/src/lib/claim-ledger/extraction-v2-eval.ts`
  - Type: eval implementation reference.
  - Import use: schema and task semantics only.

- `/Volumes/rexy/GitHub/lower-db/src/lib/freshproof/head-to-head-eval.ts`
  - Type: FreshProof comparison/export implementation reference.
  - Import use: export schema context only.

- `/Volumes/rexy/GitHub/lower-db/scripts/export-freshproof-head-to-head-evals.ts`
  - Type: export script reference.
  - Import use: export-shape context only.

Do not import lower-db `.worktrees/*` artifacts as authoritative until the root checkout has a current source-of-truth note pointing to that worktree output. Prefer FreshProof's copied `docs/operations/lowerdb-evidence-pipeline/` artifacts for canonical evidence-policy import. The current lower-db root has methodology and export-shape references, but no canonical persisted eval corpus comparable to FreshProof's review packs.

## Implementation Slices

### Slice 0: Hardening Before New Routing

- Upgrade vulnerable dependencies, especially Hono.
- Update `setup-secrets` for all configured providers.
- Replace fixed seed API keys with generated or operator-supplied keys.
- Restrict production CORS with `ALLOWED_ORIGINS`.
- Add a no-paid-spend invariant test suite.
- Add Durable Object or AI Gateway-backed rate/spend limiting for inference endpoints.

Acceptance criteria:

- `npm audit --omit=dev` passes or documented exceptions are accepted.
- `npm run type-check` passes.
- `npm run test:unit` passes.
- No seed script writes a fixed live-looking API key.
- Paid-spend routes fail closed in tests.

### Slice 1: Provider Registry

- Add provider IDs: `openai`, `openai-codex-subscription`, `anthropic`, `anthropic-claude-subscription`, `z-ai`, `pioneer`, `digitalocean-serverless`, `fireworks`, `openrouter`.
- Normalize provider families separately from transport adapter IDs.
- Add model capability metadata: modalities, coding support, fine-tune support, context length, weight openness, excluded brands, and provider-specific serving IDs.
- Keep existing provider adapters thin.

Acceptance criteria:

- Registry can answer "which providers can serve this model without paid spend?"
- DigitalOcean excludes OpenAI, Anthropic, Fal, and Arcee models.
- Fireworks generic inference is excluded unless model is a fine-tuned Fireworks deployment.

### Slice 2: Credit and Entitlement Manager

- Extend credit ledgers from simple provider balances into monthly entitlement snapshots.
- Track reset policy, reserve policy, balance/quota source, and paid-spend disabled state.
- Keep OpenRouter live credit sync.
- Add Pioneer monthly quota model.
- Add manual/admin balance updates for providers without balance APIs.

Acceptance criteria:

- Exhausted Pioneer quota blocks overflow.
- Exhausted OpenRouter credits block last-resort routes.
- Fireworks credits are not consumed by generic inference.
- Monthly reset metadata is visible through admin endpoints.

### Slice 3: Unified Routing Decision Engine

- Replace direct use of legacy `determineProvider` in new flows with policy evaluation.
- Keep legacy behavior behind compatibility tests until migrated.
- Produce route plans containing candidates, policy reasons, rejected candidates, and fallback status.
- Support client overrides without violating no-paid-spend or reservation rules.

Acceptance criteria:

- GLM routes prefer Z.ai.
- OpenRouter loses to every eligible direct/quota route.
- Pioneer handles overflow before paid spend.
- Client force-provider/model overrides fail closed when they violate policy.

### Slice 4: Research Corpus Storage

- Add D1 schema for structured benchmark records.
- Add R2 keys for prompt/response payloads and large raw traces.
- Add import jobs for FreshProof/lower-db artifacts.
- Add authority-level preservation.

Acceptance criteria:

- Human-gold, LLM-adjudicated, benchmark-secondary, and catalog-only evidence remain distinguishable.
- Prompts and responses are stored with hashes and provenance.
- Duplicate model runs are deduped by dataset, prompt variant, model, provider, and run date.

### Slice 5: Model Recommender API

- Add `/v1/recommendations`.
- Classify task from query batch plus optional hints.
- Return top 5 models with scores, provider candidates, reasoning, and evidence links.
- Include policy warnings for unavailable or override-blocked routes.

Acceptance criteria:

- FreshProof claim extraction requests produce claim-extraction-specific recommendations.
- Evidence-policy requests cite the Pioneer sweep and human-gold corpus where relevant.
- Scores are included and explainable.
- Recommender can run without making live inference calls.

### Slice 6: AI Gateway Integration

- Evaluate whether Cloudflare AI Gateway should wrap upstream provider calls for analytics, caching, rate limits, and spend limits.
- Do not route through Cloudflare-paid inference.
- Preserve Cortex-owned provider policy and credentials.

Acceptance criteria:

- AI Gateway can be disabled without changing routing decisions.
- Gateway spend limits act as a second guardrail, not the source of truth.

## User Stories

1. As a FreshProof pipeline, I want Cortex to recommend models for claim extraction so that extraction quality improves without uncontrolled provider spend.
2. As a lower-db evidence workflow, I want Cortex to route evidence-policy judgments to models with proven source-of-record performance so that review-gated decisions improve.
3. As an operator, I want no-paid-spend enforcement so that provider balances cannot be drained into paid API usage.
4. As an operator, I want Fireworks reserved for fine-tuning and fine-tuned model inference so that specialized credits are not wasted on generic chat.
5. As an operator, I want OpenRouter used only as last resort so that versatile credits are preserved.
6. As an operator, I want PioneerAI overflow before paid spend so that monthly quota absorbs demand spikes.
7. As a client app, I want to request a specific provider or model so that product workflows can choose known-good routes.
8. As a client app, I want override failures to be explicit so that I can distinguish policy rejection from provider failure.
9. As a researcher, I want prompts and responses stored with scores so that model recommendations can be audited.
10. As a researcher, I want human-gold and LLM-adjudicated artifacts separated so that weak labels are not promoted as gold.
11. As an admin, I want to update credits and entitlements regularly so that route policy reflects current balances.
12. As an admin, I want automatic balance sync where possible so that manual ledger updates are minimized.
13. As an admin, I want all model-serving aliases verified before live sweeps so that stale provider docs do not cause failed runs.
14. As a developer, I want routing logic in a deep module so that adding providers does not require editing route handlers.
15. As a developer, I want fixture-backed policy tests so that no-paid-spend and provider reservation rules cannot regress.

## Testing Decisions

- Test routing at the decision-engine boundary, not by asserting every internal branch.
- Use fake provider catalogs and fake ledgers for deterministic route tests.
- Add invariant tests for no paid spend, OpenRouter-last, Fireworks-reserved, DigitalOcean exclusions, GLM-to-Z.ai, and Pioneer overflow.
- Add import tests for each authority level.
- Add recommender tests from fixture corpus rows.
- Keep live provider catalog sync and benchmark runs outside CI.
- Keep secrets in environment/process scope only.

## Out of Scope for V1

- Letting Cortex intentionally spend paid API dollars.
- Cloudflare-paid inference.
- Fully automated provider balance sync for every provider.
- Production model default changes in FreshProof/lower-db.
- Human review UI work beyond importing existing artifacts.
- Public MCP interface for recommendations.
- Multi-tenant billing.
- Data residency enforcement.

## Open Questions

- How should rate limits be shaped: per API key, app, user, task class, provider, monthly budget bucket, or a combination?
- Which subscription-backed coding routes are callable by Cortex today versus operator/CLI-only?
- What is the exact PioneerAI balance/quota API, if any?
- What DigitalOcean Serverless Inference catalog endpoint should be treated as source of truth for credit-eligible models?
- What retention policy should apply to stored prompts and responses?
- Should client overrides be available to all clients or only admin-approved clients?

## References

- Artificial Analysis API: https://artificialanalysis.ai/api-reference
- Artificial Analysis intelligence benchmarking methodology: https://artificialanalysis.ai/methodology/intelligence-benchmarking
- Cloudflare AI Gateway spend limits: https://developers.cloudflare.com/ai-gateway/features/spend-limits/
- Fireworks fine-tuning docs: https://docs.fireworks.ai/fine-tuning/fine-tuning-models
- Fireworks LoRA deployment docs: https://docs.fireworks.ai/fine-tuning/deploying-loras
