import { z } from 'zod';

export const routingStageSchema = z.enum(['week_1', 'week_n', 'refine_week_1']);
export const routingStrategySchema = z.enum(['speed', 'balanced', 'quality']);
export const routingProviderSchema = z.enum(['fireworks', 'openrouter']);
export const requestPrioritySchema = z.enum(['low', 'normal', 'high']);
export const requestRoleSchema = z.enum(['primary', 'hedge', 'fallback']);
