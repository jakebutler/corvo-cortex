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

  it('rejects nested-quantifier patterns at compile time without executing them', () => {
    const evilInput = `${'a'.repeat(100_000)}b`;
    const startedAt = Date.now();

    const context = buildStrictSchemaContext({
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'evil',
          schema: {
            type: 'object',
            required: ['value'],
            properties: {
              value: { type: 'string', pattern: '(a+)+$' }
            }
          }
        }
      }
    });

    expect(context.compileError).toBeDefined();
    expect(context.compileError).toContain('nested quantifier');

    const result = validateStrictSchemaPayload({ value: evilInput }, context);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('schema_invalid');

    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeLessThan(250);
  });

  it('rejects patterns that are too long or syntactically invalid', () => {
    const tooLong = buildStrictSchemaContext({
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'long-pattern',
          schema: { type: 'object', properties: { v: { type: 'string', pattern: 'a'.repeat(257) } } }
        }
      }
    });
    expect(tooLong.compileError).toContain('maximum length');

    const invalid = buildStrictSchemaContext({
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'bad-pattern',
          schema: { type: 'object', properties: { v: { type: 'string', pattern: 'a(' } } }
        }
      }
    });
    expect(invalid.compileError).toContain('not a valid regular expression');
  });

  it('does not retain schemas across requests (no unbounded caller-keyed cache)', () => {
    for (let i = 0; i < 5_000; i++) {
      const context = buildStrictSchemaContext({
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: `schema-${i}`,
            schema: {
              type: 'object',
              required: [`field_${i}`],
              properties: { [`field_${i}`]: { type: 'string' } }
            }
          }
        }
      });

      expect(context.compileError).toBeUndefined();
      const result = validateStrictSchemaPayload({ [`field_${i}`]: 'x' }, context);
      expect(result.valid).toBe(true);
    }
  });

  it('rejects unknown type values at request time (fail-closed)', () => {
    const context = buildStrictSchemaContext({
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'typo',
          schema: { type: 'object', properties: { v: { type: 'strng' } } }
        }
      }
    });

    expect(context.compileError).toBeDefined();
    expect(context.compileError).toContain("unsupported type 'strng'");
  });

  it('rejects unsupported JSON Schema keywords loudly', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['$ref', { type: 'object', $ref: '#/definitions/x' }],
      ['not', { not: { type: 'string' } }],
      ['patternProperties', { type: 'object', patternProperties: { '^x': { type: 'string' } } }],
      ['multipleOf', { type: 'number', multipleOf: 2 }],
      ['uniqueItems', { type: 'array', uniqueItems: true }],
      ['format', { type: 'string', format: 'date-time' }]
    ];

    for (const [keyword, schema] of cases) {
      const context = buildStrictSchemaContext({
        response_format: { type: 'json_schema', json_schema: { name: 'kw', schema } }
      });
      expect(context.compileError, `expected rejection for ${keyword}`).toBeDefined();
      expect(context.compileError).toContain(`'${keyword}'`);
    }
  });

  it('matches enum and const objects key-order-independently', () => {
    const enumContext = buildStrictSchemaContext({
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'enum-obj',
          schema: { enum: [{ a: 1, b: 2 }] }
        }
      }
    });

    expect(validateStrictSchemaPayload({ b: 2, a: 1 }, enumContext).valid).toBe(true);
    expect(validateStrictSchemaPayload({ a: 1, b: 3 }, enumContext).valid).toBe(false);

    const constContext = buildStrictSchemaContext({
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'const-obj',
          schema: { const: { x: 'y', z: 4 } }
        }
      }
    });

    expect(validateStrictSchemaPayload({ z: 4, x: 'y' }, constContext).valid).toBe(true);
  });

  it('returns schema_invalid instead of crashing on payload nesting beyond the depth limit', () => {
    const context = buildStrictSchemaContext({
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'deep',
          schema: { type: 'object' }
        }
      }
    });

    let deepPayload: unknown = 'leaf';
    for (let i = 0; i < 200; i++) {
      deepPayload = { nested: deepPayload };
    }

    const result = validateStrictSchemaPayload(deepPayload, context);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('schema_invalid');
    expect(result.message).toContain('maximum nesting depth');
  });

  it('still validates supported schemas including combinators', () => {
    const context = buildStrictSchemaContext({
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'combinators',
          schema: {
            type: 'object',
            required: ['mode'],
            properties: {
              mode: { anyOf: [{ type: 'string' }, { type: 'number' }] },
              tags: { type: 'array', items: { type: 'string', pattern: '^[a-z]+$' } }
            },
            additionalProperties: false
          }
        }
      }
    });

    expect(validateStrictSchemaPayload({ mode: 'fast', tags: ['alpha'] }, context).valid).toBe(true);
    expect(validateStrictSchemaPayload({ mode: true }, context).valid).toBe(false);
    expect(validateStrictSchemaPayload({ mode: 'fast', extra: 1 }, context).valid).toBe(false);
  });
});
