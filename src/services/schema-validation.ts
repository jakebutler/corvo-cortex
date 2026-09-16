import type { RouteFailureReason } from './route-executor';

const MAX_SCHEMA_DEPTH = 64;
const MAX_PATTERN_LENGTH = 256;

const SUPPORTED_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

const UNSUPPORTED_KEYWORDS = [
  '$ref',
  '$defs',
  'definitions',
  'not',
  'if',
  'then',
  'else',
  'patternProperties',
  'multipleOf',
  'uniqueItems',
  'minProperties',
  'maxProperties',
  'contains',
  'propertyNames',
  'dependencies',
  'dependentSchemas',
  'dependentRequired',
  'format'
];

const NESTED_QUANTIFIER_TEST = /\((?:[^()\\]|\\.)*[+*]\s*\)\s*[+*{]/;

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

  const problems = lintSchemaForStrictSupport(schema);
  if (problems.length > 0) {
    return {
      enabled: true,
      schema,
      compileError: problems.slice(0, 5).join('; ')
    };
  }

  return {
    enabled: true,
    schema
  };
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

  if (measureDepth(parseResult.parsed) > MAX_SCHEMA_DEPTH) {
    return {
      valid: false,
      reason: 'schema_invalid',
      message: `Payload exceeds maximum nesting depth of ${MAX_SCHEMA_DEPTH}`
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
  path: string,
  depth = 0
): string[] {
  const errors: string[] = [];

  if (depth > MAX_SCHEMA_DEPTH) {
    errors.push(`${path} exceeds maximum nesting depth of ${MAX_SCHEMA_DEPTH}`);
    return errors;
  }

  if (schema.anyOf && Array.isArray(schema.anyOf)) {
    const anyOfValid = schema.anyOf.some((subSchema) => {
      if (!isPlainObject(subSchema)) return false;
      return validateJsonSchema(value, subSchema, path, depth + 1).length === 0;
    });
    if (!anyOfValid) {
      errors.push(`${path} failed anyOf validation`);
      return errors;
    }
  }

  if (schema.allOf && Array.isArray(schema.allOf)) {
    for (const subSchema of schema.allOf) {
      if (!isPlainObject(subSchema)) continue;
      errors.push(...validateJsonSchema(value, subSchema, path, depth + 1));
      if (errors.length > 0) return errors;
    }
  }

  if (schema.oneOf && Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((subSchema) => {
      if (!isPlainObject(subSchema)) return false;
      return validateJsonSchema(value, subSchema, path, depth + 1).length === 0;
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
          `${path}/${key}`,
          depth + 1
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
        errors.push(...validateJsonSchema(value[i], schema.items, `${path}/${i}`, depth + 1));
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
      return false;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null) return false;
  if (typeof left !== typeof right) return false;

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.length !== right.length) return false;
    return left.every((item, index) => {
      // nosemgrep: javascript.lang.security.audit.object-injection.object-injection
      // eslint-disable-next-line security/detect-object-injection
      return deepEqual(item, right[index]);
    });
  }

  if (typeof left === 'object') {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord);
    const rightKeys = Object.keys(rightRecord);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key) => {
      // nosemgrep: javascript.lang.security.audit.object-injection.object-injection
      // eslint-disable-next-line security/detect-object-injection
      const leftValue = leftRecord[key];
      if (!Object.prototype.hasOwnProperty.call(rightRecord, key)) return false;
      // nosemgrep: javascript.lang.security.audit.object-injection.object-injection
      // eslint-disable-next-line security/detect-object-injection
      return deepEqual(leftValue, rightRecord[key]);
    });
  }

  return false;
}

function lintSchemaForStrictSupport(schema: Record<string, unknown>): string[] {
  const problems: string[] = [];
  lintSchemaNode(schema, '$', problems, 0);
  return problems;
}

function lintSchemaNode(
  schema: Record<string, unknown>,
  path: string,
  problems: string[],
  depth: number
): void {
  if (depth > MAX_SCHEMA_DEPTH) {
    problems.push(`${path} exceeds maximum schema nesting depth of ${MAX_SCHEMA_DEPTH}`);
    return;
  }

  for (const keyword of UNSUPPORTED_KEYWORDS) {
    if (Object.prototype.hasOwnProperty.call(schema, keyword)) {
      problems.push(`${path} uses unsupported keyword '${keyword}'`);
    }
  }

  if (schema.type !== undefined) {
    const typeEntries = Array.isArray(schema.type) ? schema.type : [schema.type];
    for (const entry of typeEntries) {
      if (typeof entry !== 'string' || !SUPPORTED_TYPES.has(entry)) {
        problems.push(`${path} uses unsupported type '${String(entry)}'`);
      }
    }
  }

  if (typeof schema.pattern === 'string') {
    problems.push(...lintPattern(schema.pattern, path));
  }

  const properties = isPlainObject(schema.properties) ? schema.properties : undefined;
  if (properties) {
    for (const [key, childSchema] of Object.entries(properties)) {
      if (!isPlainObject(childSchema)) continue;
      lintSchemaNode(childSchema, `${path}/${key}`, problems, depth + 1);
    }
  }

  if (isPlainObject(schema.additionalProperties)) {
    lintSchemaNode(schema.additionalProperties, `${path}/additionalProperties`, problems, depth + 1);
  }

  if (isPlainObject(schema.items)) {
    lintSchemaNode(schema.items, `${path}/items`, problems, depth + 1);
  }

  for (const combinator of ['anyOf', 'allOf', 'oneOf']) {
    // nosemgrep: javascript.lang.security.audit.object-injection.object-injection
    // eslint-disable-next-line security/detect-object-injection
    const branch = schema[combinator];
    if (!Array.isArray(branch)) continue;
    for (let i = 0; i < branch.length; i++) {
      // nosemgrep: javascript.lang.security.audit.object-injection.object-injection
      // eslint-disable-next-line security/detect-object-injection
      const subSchema = branch[i];
      if (!isPlainObject(subSchema)) continue;
      lintSchemaNode(subSchema, `${path}/${combinator}/${i}`, problems, depth + 1);
    }
  }
}

function measureDepth(value: unknown): number {
  if (Array.isArray(value)) {
    let max = 0;
    for (const item of value) {
      max = Math.max(max, measureDepth(item));
    }
    return max + 1;
  }

  if (isPlainObject(value)) {
    let max = 0;
    for (const child of Object.values(value)) {
      max = Math.max(max, measureDepth(child));
    }
    return max + 1;
  }

  return 0;
}

function lintPattern(pattern: string, path: string): string[] {  const problems: string[] = [];

  if (pattern.length > MAX_PATTERN_LENGTH) {
    problems.push(`${path} pattern exceeds maximum length of ${MAX_PATTERN_LENGTH} characters`);
    return problems;
  }

  try {
    // nosemgrep: javascript.lang.security.audit.non-literal-regexp.non-literal-regexp
    // eslint-disable-next-line security/detect-non-literal-regexp
    new RegExp(pattern);
  } catch {
    problems.push(`${path} pattern is not a valid regular expression`);
    return problems;
  }

  if (NESTED_QUANTIFIER_TEST.test(pattern)) {
    problems.push(`${path} pattern uses a nested quantifier which risks catastrophic backtracking`);
  }

  return problems;
}
