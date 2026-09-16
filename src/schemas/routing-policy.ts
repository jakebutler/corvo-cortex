import { z } from 'zod';
import {
  routingProviderSchema,
  routingStageSchema,
  routingStrategySchema
} from './routing-hints';

const modelProfileKeySchema = z.enum([
  'fast_json_model',
  'balanced_json_model',
  'quality_json_model',
  'safe_json_model'
]);

const routePolicyEntrySchema = z.object({
  provider: routingProviderSchema,
  modelProfile: modelProfileKeySchema
});

const stageStrategyMapSchema = z.object({
  speed: z.array(routePolicyEntrySchema).optional(),
  balanced: z.array(routePolicyEntrySchema).optional(),
  quality: z.array(routePolicyEntrySchema).optional()
});

export const routingPolicySchema = z.object({
  version: z.string().min(1),
  enabled: z.boolean(),
  modelProfiles: z.record(modelProfileKeySchema, z.string().min(1)),
  /**
   * Policy-level model allowlist: exact ids or trailing-* prefix globs.
   * ['*'] allows everything; omitted allows everything; [] allows nothing.
   * Applies to client-pinned models (x-kinisi-model / body model).
   */
  allowedModels: z.array(z.string().min(1)).optional(),
  /**
   * When false, a client-pinned model outside allowedModels is rejected (403).
   * When true/undefined, a pinned model outside the allowlist silently falls
   * back to the policy's model profile.
   */
  allowClientModelPinning: z.boolean().optional(),
  matrix: z.record(routingStageSchema, stageStrategyMapSchema),
  hedge: z.object({
    week_n_speed: z.boolean(),
    week_1_speed: z.boolean(),
    delayMs: z.number().int().positive()
  }),
  retryPolicies: z.record(routingStrategySchema, z.object({
    maxRetries: z.number().int().nonnegative(),
    baseDelayMs: z.number().int().nonnegative(),
    maxDelayMs: z.number().int().nonnegative()
  })),
  latencyBudgetsMs: z.record(routingStageSchema, z.number().int().positive())
});

export type ModelProfileKey = z.infer<typeof modelProfileKeySchema>;
export type RoutePolicyEntry = z.infer<typeof routePolicyEntrySchema>;
export type RoutingPolicy = z.infer<typeof routingPolicySchema>;
