import { CompileError } from './types.js';

const MAX_SOURCE = 4096;
const MAX_TOKENS = 512;
const MAX_DEPTH = 32;
const nameStart = /^[A-Za-z_]$/;
const namePart = /^[A-Za-z0-9_.-]$/;
const fullName = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

// Deliberate subset of https://getodk.github.io/xforms-spec/#xpath-functions.
// ODK uses substr (zero-based), not XPath's substring. No instance(), predicates,
// extension functions, runtime JavaScript, or network/data access is supported.
const functions = new Map<string, readonly [number, number]>([
  ['true', [0, 0]],
  ['false', [0, 0]],
  ['not', [1, 1]],
  ['boolean', [1, 1]],
  ['string', [1, 1]],
  ['number', [1, 1]],
  ['string-length', [1, 1]],
  ['normalize-space', [0, 1]],
  ['concat', [1, MAX_TOKENS]],
  ['selected', [2, 2]],
  ['regex', [2, 2]],
  ['contains', [2, 2]],
  ['starts-with', [2, 2]],
  ['ends-with', [2, 2]],
  ['substr', [2, 3]],
  ['substring-before', [2, 2]],
  ['substring-after', [2, 2]],
  ['round', [1, 2]],
  ['today', [0, 0]],
  ['now', [0, 0]],
  ['date', [1, 1]],
  ['decimal-date-time', [1, 1]],
  ['if', [3, 3]],
  ['coalesce', [2, 2]],
]);
const precedence = new Map<string, number>([
  ['or', 1],
  ['and', 2],
  ['=', 3],
  ['!=', 3],
  ['<', 4],
  ['<=', 4],
  ['>', 4],
  ['>=', 4],
  ['+', 5],
  ['-', 5],
  ['*', 6],
  ['div', 6],
  ['mod', 6],
]);

type TokenKind = 'literal' | 'number' | 'reference' | 'name' | 'symbol';
interface Token {
  kind: TokenKind;
  value: string;
}

function syntax(): never {
  throw new CompileError('EXPRESSION_SYNTAX');
}
function limit(): never {
  throw new CompileError('EXPRESSION_LIMIT');
}

/** XPath has no backslash escapes. Quote as data, including both quote kinds. */
export function xpathLiteral(value: string): string {
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  return `concat(${value
    .split("'")
    .map((part) => `'${part}'`)
    .join(', "\'", ')})`;
}

function canonicalNumber(value: string): string {
  if (!Number.isFinite(Number(value))) syntax();
  const [integer = '', fraction = ''] = value.split('.');
  const whole = integer.replace(/^0+/, '') || '0';
  const decimal = fraction.replace(/0+$/, '');
  return decimal ? `${whole}.${decimal}` : whole;
}

/** Every loop consumes input; neither user expressions nor regexes are executed. */
function tokenize(source: string): Token[] {
  if (typeof source !== 'string') syntax();
  if (source.length > MAX_SOURCE) limit();
  const tokens: Token[] = [];
  let index = 0;
  const add = (kind: TokenKind, value: string): void => {
    tokens.push({ kind, value });
    if (tokens.length > MAX_TOKENS) limit();
  };
  const readName = (): string => {
    const start = index;
    if (!nameStart.test(source[index] ?? '')) syntax();
    index += 1;
    while (index < source.length && namePart.test(source[index] ?? ''))
      index += 1;
    return source.slice(start, index);
  };

  while (index < source.length) {
    const character = source[index];
    if (character === undefined) syntax();
    if (/^[ \t\r\n]$/.test(character)) {
      index += 1;
      continue;
    }
    if (character === "'" || character === '"') {
      const start = ++index;
      while (index < source.length && source[index] !== character) index += 1;
      if (index === source.length) syntax();
      add('literal', source.slice(start, index));
      index += 1;
      continue;
    }
    if (source.startsWith('${', index)) {
      const start = index + 2;
      const end = source.indexOf('}', start);
      if (end === -1) syntax();
      const reference = source.slice(start, end);
      if (!fullName.test(reference)) syntax();
      add('reference', reference);
      index = end + 1;
      continue;
    }
    if (
      character === '/' ||
      source.startsWith('./', index) ||
      source.startsWith('../', index)
    ) {
      const start = index;
      if (character === '/') {
        if (!source.startsWith('/data/', index)) syntax();
        index += 6;
      } else if (source.startsWith('./', index)) {
        index += 2;
      } else {
        while (source.startsWith('../', index)) index += 3;
      }
      readName();
      while (source[index] === '/') {
        index += 1;
        readName();
      }
      add('reference', source.slice(start, index));
      continue;
    }
    if (
      /^[0-9]$/.test(character) ||
      (character === '.' && /^[0-9]$/.test(source[index + 1] ?? ''))
    ) {
      const start = index;
      while (/^[0-9]$/.test(source[index] ?? '')) index += 1;
      if (source[index] === '.') {
        index += 1;
        while (/^[0-9]$/.test(source[index] ?? '')) index += 1;
      }
      add('number', canonicalNumber(source.slice(start, index)));
      continue;
    }
    if (character === '.') {
      add('reference', '.');
      index += 1;
      continue;
    }
    if (nameStart.test(character)) {
      add('name', readName());
      continue;
    }
    const pair = source.slice(index, index + 2);
    if (pair === '!=' || pair === '<=' || pair === '>=') {
      add('symbol', pair);
      index += 2;
      continue;
    }
    if ('(),=<>+-*'.includes(character)) {
      add('symbol', character);
      index += 1;
      continue;
    }
    syntax();
  }
  return tokens;
}

class Parser {
  private index = 0;
  private readonly references = new Set<string>();

  constructor(
    private readonly tokens: readonly Token[],
    private readonly resolve: (reference: string) => string,
  ) {}

  compile(): { xpath: string; references: readonly string[] } {
    const xpath = this.expression(1, 0);
    if (this.index !== this.tokens.length) syntax();
    return { xpath, references: [...this.references] };
  }

  private take(value: string): boolean {
    const token = this.tokens[this.index];
    if (token?.kind !== 'symbol' || token.value !== value) return false;
    this.index += 1;
    return true;
  }

  private reference(value: string): string {
    this.references.add(value);
    return this.resolve(value);
  }

  private expression(minimum: number, depth: number): string {
    if (depth > MAX_DEPTH) limit();
    let left = this.primary(depth);
    // Left-associative chains are iterative, so source length cannot create an
    // unbounded call stack. Right recursion is bounded by the precedence table.
    while (this.index < this.tokens.length) {
      const token = this.tokens[this.index];
      const rank =
        token?.kind === 'symbol' || token?.kind === 'name'
          ? precedence.get(token.value)
          : undefined;
      if (token === undefined || rank === undefined || rank < minimum) break;
      this.index += 1;
      const right = this.expression(rank + 1, depth);
      left = `(${left} ${token.value} ${right})`;
    }
    return left;
  }

  private primary(depth: number): string {
    if (depth > MAX_DEPTH) limit();
    const token = this.tokens[this.index++];
    if (token === undefined) syntax();
    if (token.kind === 'literal') return xpathLiteral(token.value);
    if (token.kind === 'number') return token.value;
    if (token.kind === 'reference') return this.reference(token.value);
    if (token.value === '-') return `(-${this.primary(depth + 1)})`;
    if (token.value === '(') {
      const expression = this.expression(1, depth + 1);
      if (!this.take(')')) syntax();
      return expression;
    }
    if (token.kind !== 'name' || !this.take('(')) syntax();
    const arity = functions.get(token.value);
    if (arity === undefined) syntax();
    const args: string[] = [];
    if (!this.take(')')) {
      do {
        args.push(this.expression(1, depth + 1));
      } while (this.take(','));
      if (!this.take(')')) syntax();
    }
    if (args.length < arity[0] || args.length > arity[1]) syntax();
    // The sole implicit-context function in this subset must pass context through
    // the same caller-owned resolution/dependency policy as an explicit dot.
    if (token.value === 'normalize-space' && args.length === 0)
      args.push(this.reference('.'));
    return `${token.value}(${args.join(', ')})`;
  }
}

/** Resolve only model references; the caller owns repeat scope and dependency rules. */
export function compileExpression(
  source: string,
  resolve: (reference: string) => string,
): { xpath: string; references: readonly string[] } {
  return new Parser(tokenize(source), resolve).compile();
}
