import { z } from 'zod';

/**
 * Request-level spend guardrail caps
 */
export const MAX_MESSAGES = 128;
export const MAX_MESSAGE_CONTENT_LENGTH = 262_144;
export const MAX_IMAGE_DATA_URL_LENGTH = 1_572_864;
export const DEFAULT_MAX_TOKENS_CEILING = 32_768;

/**
 * Chat message role schema
 */
export const chatMessageRoleSchema = z.enum(['system', 'user', 'assistant', 'tool']);

const chatMessageContentPartSchema = z.object({
  type: z.enum(['text', 'image_url']),
  text: z.string().max(MAX_MESSAGE_CONTENT_LENGTH).optional(),
  image_url: z.object({
    url: z.string().min(1).max(MAX_IMAGE_DATA_URL_LENGTH),
    detail: z.string().optional()
  }).optional()
});

/**
 * Chat message schema
 */
export const chatMessageSchema = z.object({
  role: chatMessageRoleSchema,
  content: z.union([
    z.string().min(1, 'Message content cannot be empty').max(MAX_MESSAGE_CONTENT_LENGTH),
    z.array(chatMessageContentPartSchema).min(1),
    z.null()
  ])
}).passthrough();

/**
 * Chat completion request schema factory
 */
export function createChatCompletionRequestSchema(
  maxTokensCeiling: number = DEFAULT_MAX_TOKENS_CEILING
) {
  return z.object({
    model: z.string().optional(),
    messages: z.array(chatMessageSchema)
      .min(1, 'At least one message is required')
      .max(MAX_MESSAGES, `Too many messages: maximum is ${MAX_MESSAGES}`),
    temperature: z.number().min(0).max(2).optional(),
    max_tokens: z.number().int().positive()
      .max(maxTokensCeiling, `max_tokens exceeds the ceiling of ${maxTokensCeiling}`)
      .optional(),
    top_p: z.number().min(0).max(1).optional(),
    stream: z.boolean().optional().default(false)
  }).passthrough();
}

/**
 * Chat completion request schema with default guardrail caps
 */
export const chatCompletionRequestSchema = createChatCompletionRequestSchema();

/**
 * Extract type from schema
 */
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ChatCompletionRequest = z.infer<typeof chatCompletionRequestSchema>;
