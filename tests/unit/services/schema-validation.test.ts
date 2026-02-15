import { describe, expect, it } from 'vitest';
import {
  buildStrictSchemaContext,
  validateStrictSchemaPayload
} from '../../../src/services/schema-validation';

describe('schema validation', () => {
  it('disables strict mode when response_format.json_schema is missing', () => {
    const context = buildStrictSchemaContext({
      model: 'gpt-5-mini',
      messages: [{ role: 'user', content: 'hello' }]
    });

    expect(context.enabled).toBe(false);
  });

  it('enables strict mode when response_format.json_schema.schema exists', () => {
    const context = buildStrictSchemaContext({
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'week_blueprint',
          schema: {
            type: 'object',
            required: ['weeks'],
            properties: {
              weeks: {
                type: 'array',
                minItems: 1
              }
            }
          }
        }
      }
    });

    expect(context.enabled).toBe(true);
    expect(context.schema).toBeDefined();
  });

  it('validates object payloads against caller schema', () => {
    const context = buildStrictSchemaContext({
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'week_blueprint',
          schema: {
            type: 'object',
            required: ['weeks'],
            properties: {
              weeks: {
                type: 'array',
                items: { type: 'object' }
              }
            }
          }
        }
      }
    });

    const valid = validateStrictSchemaPayload({ weeks: [{ id: 1 }] }, context);
    expect(valid.valid).toBe(true);

    const invalid = validateStrictSchemaPayload({ data: [] }, context);
    expect(invalid.valid).toBe(false);
  });

  it('validates json-string payloads and fails invalid json', () => {
    const context = buildStrictSchemaContext({
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'week_blueprint',
          schema: {
            type: 'object',
            required: ['weeks'],
            properties: {
              weeks: {
                type: 'array',
                minItems: 1
              }
            }
          }
        }
      }
    });

    const valid = validateStrictSchemaPayload('{"weeks":[{"id":1}]}', context);
    expect(valid.valid).toBe(true);

    const invalidJson = validateStrictSchemaPayload('not-json', context);
    expect(invalidJson.valid).toBe(false);
    expect(invalidJson.reason).toBe('schema_invalid');
  });
});
