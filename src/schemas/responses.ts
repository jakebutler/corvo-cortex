import { z } from 'zod';

export const responsesRequestSchema = (maxTokensCeiling: number) => z.object({
  model: z.string().min(1, 'Model is required'),
  input: z.union([
    z.string(),
    z.array(z.record(z.unknown()))
  ], { message: 'input must be a string or an array of items' }),
  stream: z.boolean().optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  max_output_tokens: z.number().int().positive()
    .max(maxTokensCeiling, `max_output_tokens exceeds the ceiling of ${maxTokensCeiling}`)
    .optional()
});

export type ResponsesRequest = z.infer<ReturnType<typeof responsesRequestSchema>>;
