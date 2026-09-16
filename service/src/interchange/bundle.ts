/** Bounded authoring JSON only. Contains author annotations; never collector content. */
import { types } from 'node:util';
import { compileForm } from '../compiler/compile.js';
import { prepareForm } from '../compiler/prepare.js';
import {
  CompileError,
  type Diagnostic,
  type FormDefinition,
} from '../compiler/types.js';
import {
  decodePrintMappings,
  type PrintMappingBundle,
} from '../print/mappings.js';

export interface AuthoringBundle {
  schemaVersion: 1;
  kind: 'kusanya-authoring';
  definition: FormDefinition;
  mappings: PrintMappingBundle;
}

export type AuthoringBundleResult =
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] }
  | {
      readonly ok: true;
      readonly bundle: AuthoringBundle;
      readonly json: string;
      readonly audience: 'authoring-only';
      readonly validation: 'structural-only';
      readonly warnings: readonly Diagnostic[];
    };

type Data = null | boolean | number | string | Data[] | DataRecord;
interface DataRecord {
  [key: string]: Data;
}
const maxJson = 4_000_000;
const maxNodes = 100_000;
const maxDepth = 64;
const maxText = 2_000_000;
const forbidden = new Set(['__proto__', 'constructor', 'prototype']);
const compare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

class Budget {
  private nodes = 0;
  private text = 0;

  node(depth: number): void {
    if (++this.nodes > maxNodes || depth > maxDepth)
      throw new CompileError('BUNDLE_INPUT_LIMIT');
  }

  string(value: string): void {
    this.text += value.length;
    if (this.text > maxText) throw new CompileError('BUNDLE_INPUT_LIMIT');
  }

  key(value: string, depth: number): void {
    this.node(depth);
    this.string(value);
    if (forbidden.has(value)) throw new CompileError('BUNDLE_INPUT_SHAPE');
  }
}

/** Inspect descriptors, not values via property access, before taking a detached copy. */
function snapshot(input: unknown): Data {
  const budget = new Budget();
  const active = new Set<object>();
  function visit(value: unknown, depth: number): Data {
    budget.node(depth);
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      budget.string(value);
      return value;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value))
        throw new CompileError('BUNDLE_INPUT_NUMBER');
      // JSON has one portable zero; only numeric -0 is normalized, never strings.
      return Object.is(value, -0) ? 0 : value;
    }
    if (typeof value !== 'object' || types.isProxy(value) || active.has(value))
      throw new CompileError('BUNDLE_INPUT_SHAPE');
    const array = Array.isArray(value);
    const prototype: unknown = Object.getPrototypeOf(value);
    if (
      array
        ? prototype !== Array.prototype
        : prototype !== Object.prototype && prototype !== null
    )
      throw new CompileError('BUNDLE_INPUT_SHAPE');
    const keys = Reflect.ownKeys(value);
    if (keys.length > maxNodes) throw new CompileError('BUNDLE_INPUT_LIMIT');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    active.add(value);
    try {
      if (array) {
        const length = (value as unknown[]).length;
        if (length > maxNodes) throw new CompileError('BUNDLE_INPUT_LIMIT');
        if (keys.length !== length + 1)
          throw new CompileError('BUNDLE_INPUT_SHAPE');
        const result: Data[] = [];
        for (let index = 0; index < length; index++) {
          const property = descriptors[String(index)];
          if (
            !property ||
            !Object.hasOwn(property, 'value') ||
            !property.enumerable
          )
            throw new CompileError('BUNDLE_INPUT_SHAPE');
          result.push(visit(property.value as unknown, depth + 1));
        }
        return result;
      }
      const result = Object.create(null) as DataRecord;
      for (const key of keys) {
        if (typeof key !== 'string')
          throw new CompileError('BUNDLE_INPUT_SHAPE');
        budget.key(key, depth + 1);
        const property = descriptors[key]!;
        if (!Object.hasOwn(property, 'value') || !property.enumerable)
          throw new CompileError('BUNDLE_INPUT_SHAPE');
        result[key] = visit(property.value as unknown, depth + 1);
      }
      return result;
    } finally {
      active.delete(value);
    }
  }
  return visit(input, 0);
}

/** Exact decimal spelling, without allocating a BigInt or expanding exponents. */
function normalizedDecimal(token: string): string {
  const negative = token.startsWith('-');
  const unsigned = negative ? token.slice(1) : token;
  const [mantissa, exponentText] = unsigned.split(/[eE]/);
  const point = mantissa!.indexOf('.');
  const fractionLength = point === -1 ? 0 : mantissa!.length - point - 1;
  const significant = mantissa!.replace('.', '').replace(/^0+/, '');
  // All zero spellings, including -0 and zero with a huge exponent, are zero.
  if (!significant) return '0';
  // A backward scan avoids an unanchored /0+$/ search over a long run of
  // zeroes followed by a nonzero digit in an attacker-controlled token.
  let end = significant.length;
  while (significant[end - 1] === '0') end--;
  const digits = significant.slice(0, end);
  const exponent =
    Number(exponentText ?? '0') -
    fractionLength +
    significant.length -
    digits.length;
  if (!Number.isSafeInteger(exponent))
    throw new CompileError('BUNDLE_INPUT_NUMBER');
  return `${negative ? '-' : ''}${digits}e${exponent}`;
}

/** Parse exactly JSON, detecting decoded duplicate keys before any overwrite. */
function parseJson(source: string): Data {
  const budget = new Budget();
  let position = 0;
  const syntax = (): never => {
    throw new CompileError('BUNDLE_JSON_SYNTAX');
  };
  function whitespace(): void {
    while (' \t\r\n'.includes(source[position] ?? '\0')) position++;
  }
  function string(): string {
    const start = position;
    if (source[position++] !== '"') syntax();
    while (position < source.length) {
      const code = source.charCodeAt(position++);
      if (code === 34) {
        // The scanner checked the grammar; JSON.parse only decodes this one string.
        const result = JSON.parse(source.slice(start, position)) as string;
        budget.string(result);
        return result;
      }
      if (code < 32) syntax();
      if (code === 92) {
        const escape = source[position++];
        if (escape === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(source.slice(position, position + 4)))
            syntax();
          position += 4;
        } else if (!escape || !'"\\/bfnrt'.includes(escape)) syntax();
      }
    }
    return syntax();
  }
  function value(depth: number): Data {
    budget.node(depth);
    whitespace();
    const first = source[position];
    if (first === '"') return string();
    if (first === '{') {
      position++;
      const result = Object.create(null) as DataRecord;
      whitespace();
      if (source[position] === '}') {
        position++;
        return result;
      }
      for (;;) {
        const key = string();
        // string() already charged the decoded key's text units.
        budget.node(depth + 1);
        if (forbidden.has(key)) throw new CompileError('BUNDLE_INPUT_SHAPE');
        if (Object.hasOwn(result, key))
          throw new CompileError('BUNDLE_DUPLICATE_KEY');
        whitespace();
        if (source[position++] !== ':') syntax();
        result[key] = value(depth + 1);
        whitespace();
        const separator = source[position++];
        if (separator === '}') return result;
        if (separator !== ',') syntax();
        whitespace();
      }
    }
    if (first === '[') {
      position++;
      const result: Data[] = [];
      whitespace();
      if (source[position] === ']') {
        position++;
        return result;
      }
      for (;;) {
        result.push(value(depth + 1));
        whitespace();
        const separator = source[position++];
        if (separator === ']') return result;
        if (separator !== ',') syntax();
      }
    }
    for (const [literal, decoded] of [
      ['true', true],
      ['false', false],
      ['null', null],
    ] as const) {
      if (source.startsWith(literal, position)) {
        position += literal.length;
        return decoded;
      }
    }
    // No search or backtracking over arbitrary text: scan the numeric token once.
    const start = position;
    if (source[position] === '-') position++;
    if (source[position] === '0') position++;
    else {
      if (!/[1-9]/.test(source[position] ?? '')) return syntax();
      while (/[0-9]/.test(source[position] ?? '')) position++;
    }
    if (source[position] === '.') {
      position++;
      if (!/[0-9]/.test(source[position] ?? '')) syntax();
      while (/[0-9]/.test(source[position] ?? '')) position++;
    }
    if (source[position] === 'e' || source[position] === 'E') {
      position++;
      if (source[position] === '+' || source[position] === '-') position++;
      if (!/[0-9]/.test(source[position] ?? '')) syntax();
      while (/[0-9]/.test(source[position] ?? '')) position++;
    }
    const token = source.slice(start, position);
    const decoded = Number(token);
    if (!Number.isFinite(decoded))
      throw new CompileError('BUNDLE_INPUT_NUMBER');
    // JSON Number conversion must not silently round authored decimal bounds or
    // underflow them to zero. Equivalent spellings (0.10, 1.00e0) remain valid.
    if (normalizedDecimal(token) !== normalizedDecimal(String(decoded)))
      throw new CompileError('BUNDLE_INPUT_NUMBER');
    return Object.is(decoded, -0) ? 0 : decoded;
  }
  const result = value(0);
  whitespace();
  if (position !== source.length) syntax();
  return result;
}

/** Own-key sorting is binary, never locale-dependent. Input is detached validated data. */
function canonicalJson(value: unknown): string {
  const pieces: string[] = [];
  let length = 0;
  function put(text: string): void {
    length += text.length;
    if (length > maxJson) throw new CompileError('BUNDLE_OUTPUT_LIMIT');
    pieces.push(text);
  }
  function write(item: unknown): void {
    if (item === null || typeof item !== 'object') {
      put(JSON.stringify(item));
      return;
    }
    if (Array.isArray(item)) {
      put('[');
      for (const [index, entry] of item.entries()) {
        if (index) put(',');
        write(entry);
      }
      put(']');
      return;
    }
    const record = item as Record<string, unknown>;
    put('{');
    for (const [index, key] of Object.keys(record).sort(compare).entries()) {
      if (index) put(',');
      put(`${JSON.stringify(key)}:`);
      write(record[key]);
    }
    put('}');
  }
  write(value);
  return pieces.join('');
}

function failure(error: unknown, location = 'bundle'): AuthoringBundleResult {
  if (!(error instanceof CompileError)) throw error;
  return { ok: false, diagnostics: [{ code: error.code, location }] };
}

function bundleFromData(
  form: unknown,
  mappings: unknown,
): AuthoringBundleResult {
  const prepared = prepareForm(form);
  if (!prepared.ok) return prepared;
  let location = 'mappings';
  try {
    const decoded = decodePrintMappings(mappings, prepared.graph, (path) => {
      location = path;
    });
    const definition: FormDefinition = {
      ...prepared.graph.definition,
      questions: prepared.graph.nodes.map((node) => node.definition),
      choiceLists: [...prepared.graph.definition.choiceLists]
        .sort((a, b) => compare(a.name, b.name))
        .map((list) => ({
          ...list,
          choices: [...list.choices].sort(
            (a, b) => a.order - b.order || compare(a.value, b.value),
          ),
        })),
      // Complete canonical records distinguish absent operands from empty strings.
      skipRules: [...prepared.graph.definition.skipRules].sort((a, b) =>
        compare(canonicalJson(a), canonicalJson(b)),
      ),
    };
    const compiled = compileForm(definition);
    if (!compiled.ok) return compiled;
    const bundle: AuthoringBundle = {
      schemaVersion: 1,
      kind: 'kusanya-authoring',
      definition,
      mappings: {
        schemaVersion: 1,
        mappings: decoded.mappings
          .sort((a, b) => a.order - b.order || compare(a.key, b.key))
          .map((mapping) => ({
            ...mapping,
            fields: mapping.fields.sort(
              (a, b) =>
                compare(
                  a.targetField.toLowerCase(),
                  b.targetField.toLowerCase(),
                ) || compare(a.targetField, b.targetField),
            ),
          })),
      },
    };
    location = 'bundle';
    const json = canonicalJson(bundle);
    return {
      ok: true,
      bundle,
      json,
      audience: 'authoring-only',
      validation: 'structural-only',
      warnings: compiled.warnings,
    };
  } catch (error) {
    return failure(error, location);
  }
}

/** Export only the currently compilable portable authoring subset, without I/O. */
export function exportAuthoringBundle(
  formInput: unknown,
  mappingInput: unknown,
): AuthoringBundleResult {
  try {
    // Charge exactly the same envelope nodes/strings as import, so an export
    // accepted at a budget boundary remains importable without increasing limits.
    const data = snapshot({
      schemaVersion: 1,
      kind: 'kusanya-authoring',
      definition: formInput,
      mappings: mappingInput,
    }) as DataRecord;
    return bundleFromData(data.definition, data.mappings);
  } catch (error) {
    return failure(error);
  }
}

/** Accept a bounded strict JSON string, never a live object or evaluator input. */
export function importAuthoringBundle(json: unknown): AuthoringBundleResult {
  try {
    if (typeof json !== 'string') throw new CompileError('BUNDLE_JSON_TYPE');
    if (json.length > maxJson) throw new CompileError('BUNDLE_INPUT_LIMIT');
    const root = parseJson(json);
    if (
      root === null ||
      typeof root !== 'object' ||
      Array.isArray(root) ||
      Object.keys(root).length !== 4 ||
      !['schemaVersion', 'kind', 'definition', 'mappings'].every((key) =>
        Object.hasOwn(root, key),
      )
    )
      throw new CompileError('BUNDLE_INPUT_SHAPE');
    if (root.schemaVersion !== 1 || root.kind !== 'kusanya-authoring')
      throw new CompileError('BUNDLE_SCHEMA_VERSION');
    return bundleFromData(root.definition, root.mappings);
  } catch (error) {
    return failure(error);
  }
}
