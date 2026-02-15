import type { RouteFailureReason } from './route-executor';

const schemaCache = new Map<string, Record<string, unknown>>();

export interface StrictSchemaContext {
  enabled: boolean;
  schema?: Record<string, unknown>;
  compileError?: string;
}

export interface StrictSchemaValidationResult {
  valid: boolean;
  reason?: RouteFailureReason;
  message?: string;
  parsed?: unknown;
}

export function buildStrictSchemaContext(body: unknown): StrictSchemaContext {
  const schema = extractCallerJsonSchema(body);
  if (!schema) {
    return { enabled: false };
  }

  try {
    const cacheKey = JSON.stringify(schema);
    if (!schemaCache.has(cacheKey)) {
      schemaCache.set(cacheKey, schema);
    }

    return {
      enabled: true,
      schema: schemaCache.get(cacheKey)
    };
  } catch (error) {
    return {
      enabled: true,
      schema,
      compileError: error instanceof Error ? error.message : 'Failed to cache schema'
    };
  }
}

export function validateStrictSchemaPayload(
  payload: unknown,
  context: StrictSchemaContext
): StrictSchemaValidationResult {
  if (!context.enabled) {
    return { valid: true, parsed: payload };
  }

  if (context.compileError || !context.schema) {
    return {
      valid: false,
      reason: 'schema_invalid',
      message: context.compileError || 'Schema unavailable'
    };
  }

  const parseResult = normalizeJsonPayload(payload);
  if (!parseResult.valid) {
    return {
      valid: false,
      reason: 'schema_invalid',
      message: parseResult.message
    };
  }

  const errors = validateJsonSchema(parseResult.parsed, context.schema, '$');
  if (errors.length === 0) {
    return {
      valid: true,
      parsed: parseResult.parsed
    };
  }

  return {
    valid: false,
    reason: 'schema_invalid',
    message: errors.slice(0, 5).join('; ')
  };
}

export function extractSchemaValidationPayload(response: unknown): unknown {
  if (!response || typeof response !== 'object') {
    return response;
  }

  const responseRecord = response as {
    choices?: Array<{ message?: { content?: unknown } }>;
  };

  const firstContent = responseRecord.choices?.[0]?.message?.content;
  if (firstContent === undefined) {
    return response;
  }

  return firstContent;
}

function extractCallerJsonSchema(body: unknown): Record<string, unknown> | undefined {
  if (!body || typeof body !== 'object') {
    return undefined;
  }

  const bodyRecord = body as {
    response_format?: {
      type?: string;
      json_schema?: {
        schema?: unknown;
      };
    };
  };

  const responseFormat = bodyRecord.response_format;
  if (!responseFormat || responseFormat.type !== 'json_schema') {
    return undefined;
  }

  const schema = responseFormat.json_schema?.schema;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return undefined;
  }

  return schema as Record<string, unknown>;
}

function normalizeJsonPayload(payload: unknown): { valid: true; parsed: unknown } | { valid: false; message: string } {
  if (typeof payload === 'string') {
    try {
      return {
        valid: true,
        parsed: JSON.parse(payload)
      };
    } catch {
      return {
        valid: false,
        message: 'Payload is not valid JSON'
      };
    }
  }

  return {
    valid: true,
    parsed: payload
  };
}

function validateJsonSchema(
  value: unknown,
  schema: Record<string, unknown>,
  path: string
): string[] {
  const errors: string[] = [];

  if (schema.anyOf && Array.isArray(schema.anyOf)) {
    const anyOfValid = schema.anyOf.some((subSchema) => {
      if (!isPlainObject(subSchema)) return false;
      return validateJsonSchema(value, subSchema, path).length === 0;
    });
    if (!anyOfValid) {
      errors.push(`${path} failed anyOf validation`);
      return errors;
    }
  }

  if (schema.allOf && Array.isArray(schema.allOf)) {
    for (const subSchema of schema.allOf) {
      if (!isPlainObject(subSchema)) continue;
      errors.push(...validateJsonSchema(value, subSchema, path));
      if (errors.length > 0) return errors;
    }
  }

  if (schema.oneOf && Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((subSchema) => {
      if (!isPlainObject(subSchema)) return false;
      return validateJsonSchema(value, subSchema, path).length === 0;
    }).length;
    if (matches !== 1) {
      errors.push(`${path} failed oneOf validation`);
      return errors;
    }
  }

  if (schema.enum && Array.isArray(schema.enum)) {
    const enumMatch = schema.enum.some((candidate) => deepEqual(candidate, value));
    if (!enumMatch) {
      errors.push(`${path} must be one of enum values`);
      return errors;
    }
  }

  if (Object.prototype.hasOwnProperty.call(schema, 'const')) {
    if (!deepEqual(schema.const, value)) {
      errors.push(`${path} must match const value`);
      return errors;
    }
  }

  const typeCheck = validateType(value, schema.type);
  if (!typeCheck.valid) {
    errors.push(`${path} ${typeCheck.message}`);
    return errors;
  }

  if (isPlainObject(value)) {
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (typeof key !== 'string') continue;
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        errors.push(`${path}/${key} is required`);
        return errors;
      }
    }

    const properties = isPlainObject(schema.properties) ? schema.properties : undefined;
    if (properties) {
      for (const [key, childSchema] of Object.entries(properties)) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        if (!isPlainObject(childSchema)) continue;

        // nosemgrep: javascript.lang.security.audit.object-injection.object-injection
        // eslint-disable-next-line security/detect-object-injection
        const propertyValue = (value as Record<string, unknown>)[key];
        errors.push(...validateJsonSchema(
          propertyValue,
          childSchema,
          `${path}/${key}`
        ));

        if (errors.length > 0) {
          return errors;
        }
      }
    }

    if (schema.additionalProperties === false && properties) {
      const allowed = new Set(Object.keys(properties));
      for (const key of Object.keys(value)) {
        if (!allowed.has(key)) {
          errors.push(`${path}/${key} is not allowed`);
          return errors;
        }
      }
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      errors.push(`${path} requires at least ${schema.minItems} items`);
      return errors;
    }

    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      errors.push(`${path} allows at most ${schema.maxItems} items`);
      return errors;
    }

    if (isPlainObject(schema.items)) {
      for (let i = 0; i < value.length; i++) {
        // nosemgrep: javascript.lang.security.audit.object-injection.object-injection
        // eslint-disable-next-line security/detect-object-injection
        errors.push(...validateJsonSchema(value[i], schema.items, `${path}/${i}`));
        if (errors.length > 0) {
          return errors;
        }
      }
    }
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      errors.push(`${path} requires minimum length ${schema.minLength}`);
      return errors;
    }

    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      errors.push(`${path} exceeds maximum length ${schema.maxLength}`);
      return errors;
    }

    if (typeof schema.pattern === 'string') {
      // nosemgrep: javascript.lang.security.audit.non-literal-regexp.non-literal-regexp
      // eslint-disable-next-line security/detect-non-literal-regexp
      const pattern = new RegExp(schema.pattern);
      if (!pattern.test(value)) {
        errors.push(`${path} does not match required pattern`);
        return errors;
      }
    }
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      errors.push(`${path} must be >= ${schema.minimum}`);
      return errors;
    }

    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      errors.push(`${path} must be <= ${schema.maximum}`);
      return errors;
    }

    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) {
      errors.push(`${path} must be > ${schema.exclusiveMinimum}`);
      return errors;
    }

    if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) {
      errors.push(`${path} must be < ${schema.exclusiveMaximum}`);
      return errors;
    }
  }

  return errors;
}

function validateType(value: unknown, typeDef: unknown): { valid: true } | { valid: false; message: string } {
  if (!typeDef) {
    return { valid: true };
  }

  const allowedTypes = Array.isArray(typeDef) ? typeDef : [typeDef];
  const normalizedTypes = allowedTypes.filter((entry): entry is string => typeof entry === 'string');
  if (normalizedTypes.length === 0) {
    return { valid: true };
  }

  const valid = normalizedTypes.some((allowedType) => matchesType(value, allowedType));
  if (valid) {
    return { valid: true };
  }

  return {
    valid: false,
    message: `must be of type ${normalizedTypes.join('|')}`
  };
}

function matchesType(value: unknown, typeName: string): boolean {
  switch (typeName) {
    case 'object':
      return isPlainObject(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      return true;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
