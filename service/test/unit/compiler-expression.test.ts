import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  compileExpression,
  xpathLiteral,
} from '../../src/compiler/expression.js';
import { CompileError } from '../../src/compiler/types.js';

const identity = (reference: string): string => reference;
const compile = (source: string): string =>
  compileExpression(source, identity).xpath;
const rejects = (source: string, code = 'EXPRESSION_SYNTAX'): void => {
  assert.throws(
    () => compile(source),
    (error: unknown) => {
      assert.ok(error instanceof CompileError);
      assert.equal(error.message, code);
      assert.equal(error.code, code);
      assert.equal(error.name, 'CompileError');
      return true;
    },
  );
};

void test('expression parser preserves XPath precedence and left associativity', () => {
  assert.equal(
    compile('1 + 2 * 3 - 8 div 4 mod 2'),
    '((1 + (2 * 3)) - ((8 div 4) mod 2))',
  );
  assert.equal(
    compile('1 = 2 or 3 <= 4 and 5 != 6'),
    '((1 = 2) or ((3 <= 4) and (5 != 6)))',
  );
  assert.equal(compile('1 = 2 < 3'), '(1 = (2 < 3))');
  assert.equal(compile('9 - 3 - 1'), '((9 - 3) - 1)');
  assert.equal(compile('-(1 + 2) * -3'), '((-(1 + 2)) * (-3))');
  assert.equal(compile('((1))'), '1');
  assert.equal(compile('4--2'), '(4 - (-2))');
});

void test('expression output is deterministic across legal whitespace and numeric spellings', () => {
  assert.equal(compile(' \n\t0001.00 + .50\r * 2. '), '(1 + (0.5 * 2))');
  assert.equal(compile('1+0.5*2'), compile(' 1 + 0.50 * 02 '));
  assert.equal(compile('0000.000'), '0');
  assert.equal(
    compile('0.00000000000000000000000001'),
    '0.00000000000000000000000001',
  );
  rejects('9'.repeat(309));
  for (const value of [
    'NaN',
    'Infinity',
    '1e2',
    '0x10',
    '+1',
    '1.2.3',
    '1 2',
    '1\u00a0+2',
  ])
    rejects(value);
});

void test('references use one resolver contract and preserve first-use dependencies', () => {
  const seen: string[] = [];
  const result = compileExpression(
    '${a.b-c} + /data/a.b-c + ../a.b-c + ../../group/q + ./q + . + ${a.b-c}',
    (value) => {
      seen.push(value);
      return value === 'a.b-c' ? '/data/a.b-c' : value;
    },
  );
  assert.deepEqual(result.references, [
    'a.b-c',
    '/data/a.b-c',
    '../a.b-c',
    '../../group/q',
    './q',
    '.',
  ]);
  assert.deepEqual(seen, [...result.references, 'a.b-c']);
  assert.equal(
    result.xpath,
    '((((((/data/a.b-c + /data/a.b-c) + ../a.b-c) + ../../group/q) + ./q) + .) + /data/a.b-c)',
  );
  assert.equal(
    compile('/data/one-two - /data/one.two'),
    '(/data/one-two - /data/one.two)',
  );
  assert.equal(compile('/data/a-1*2'), '(/data/a-1 * 2)');
  assert.equal(compile('${_private}'), '_private');
  assert.equal(compile('/data/or + /data/and'), '(/data/or + /data/and)');
});

void test('node paths reject unsupported traversal, wildcards, malformed names and external roots', () => {
  for (const value of [
    '/data',
    '/other/a',
    '/data/',
    '/data//a',
    '//data/a',
    '/data/a/',
    '/data/a/../b',
    '/data/a/./b',
    '/data/1bad',
    '/data/*',
    '../',
    '..',
    './',
    '.../a',
    './1bad',
    '../a//b',
    '../a/@id',
    '../a[1]',
    '${}',
    '${ bad}',
    '${bad }',
    '${a/b}',
    '${a:b}',
    '${a',
    '${a}}',
    '${1bad}',
    'bare_name',
    'a/b',
    'child::a',
    '/data/a::b',
    '/data/@id',
    '/data/a | /data/b',
    '/data/a[true()]',
    'https://example.invalid/a',
  ])
    rejects(value);
});

void test('XPath strings preserve quote contents and never interpret backslash or template syntax', () => {
  assert.equal(compile(`"can't"`), '"can\'t"');
  assert.equal(compile(`'say "yes"'`), `'say "yes"'`);
  assert.equal(
    compile("'\\n\\p{L}${secret} <xml> & [1] /data/q'"),
    "'\\n\\p{L}${secret} <xml> & [1] /data/q'",
  );
  assert.equal(compile("'first\nsecond'"), "'first\nsecond'");
  assert.deepEqual(compileExpression("'${secret}'", identity).references, []);
  assert.equal(compile("''"), "''");
  assert.equal(compile('""'), "''");
  rejects("'unterminated");
  rejects('"unterminated');
  rejects("'can\\'t'");
  rejects("'a''b'");
});

void test('xpathLiteral safely represents both quote types without changing data', () => {
  assert.equal(xpathLiteral(''), "''");
  assert.equal(xpathLiteral('plain'), "'plain'");
  assert.equal(xpathLiteral("isn't"), '"isn\'t"');
  assert.equal(xpathLiteral('"yes"'), `'"yes"'`);
  const value = `'"both"'`;
  const literal = xpathLiteral(value);
  assert.equal(literal, `concat('', "'", '"both"', "'", '')`);
  assert.equal(compile(literal), literal);
  assert.equal(xpathLiteral('x\\n'), "'x\\n'");
});

void test('allowlisted ODK functions have bounded exact arities', () => {
  for (const expression of [
    'true()',
    'false()',
    'not(true())',
    'boolean(1)',
    'string(1)',
    'number(1)',
    "string-length('a')",
    "normalize-space(' a ')",
    "concat('a')",
    "concat('a', 'b', 'c')",
    "selected('a b', 'b')",
    "regex(., '^([0-9]+)$')",
    "contains('ab', 'a')",
    "starts-with('ab', 'a')",
    "ends-with('ab', 'b')",
    "substr('abc', 1)",
    "substr('abc', 1, 2)",
    "substring-before('a-b', '-')",
    "substring-after('a-b', '-')",
    'round(1.5)',
    'round(1.555, 2)',
    'today()',
    'now()',
    'date(1)',
    "decimal-date-time('2020-01-01')",
    "if(true(), 'yes', 'no')",
    "coalesce('', 'fallback')",
  ])
    assert.ok(compile(expression));
  for (const expression of [
    'true(1)',
    'false(1)',
    'not()',
    'not(1,2)',
    'boolean()',
    'string()',
    'number()',
    'string-length()',
    'normalize-space(1,2)',
    'concat()',
    'selected(1)',
    'regex(1)',
    'contains(1,2,3)',
    'starts-with(1)',
    'ends-with(1)',
    'substr(1)',
    'substr(1,2,3,4)',
    'substring-before(1)',
    'substring-after(1)',
    'round()',
    'round(1,2,3)',
    'today(1)',
    'now(1)',
    'date()',
    'decimal-date-time()',
    'if(1,2)',
    'coalesce(1)',
    'substring(1,2)',
    'floor(1)',
    'ceiling(1)',
  ])
    rejects(expression);
});

void test('implicit normalize-space context goes through resolution and dependency tracking', () => {
  assert.deepEqual(
    compileExpression('normalize-space() = normalize-space(.)', (value) => {
      assert.equal(value, '.');
      return '/data/value';
    }),
    {
      xpath: '(normalize-space(/data/value) = normalize-space(/data/value))',
      references: ['.'],
    },
  );
});

void test('unknown functions, executable input and malformed delimiters fail without source echo', () => {
  for (const source of [
    'secretFunction()',
    'constructor()',
    'toString()',
    'eval("secret")',
    'process.exit()',
    'instance("secret")',
    'document("https://secret.invalid")',
    'random()',
    'jr:choice-name(., "secret")',
    '(1',
    '1)',
    '()',
    '1,2',
    'if(,1,2)',
    'if(1,,2)',
    'if(1,2,)',
    'if(1,2,3,)',
    '1 +',
    '* 1',
    '1 && 2',
    '1 || 2',
    'true() /data/a',
    '1;secret()',
    '1 == 1',
    '1 => 2',
    '1 (: secret :) + 2',
    '1 "or" 2',
    '1 "+" 2',
    '1 ${or} 2',
    "true(')'",
    "not'('1')'",
  ])
    rejects(source);
  const marker = 'SYNTHETIC_SECRET_DO_NOT_ECHO';
  assert.throws(
    () => compile(`unknown('${marker}')`),
    (error: unknown) => {
      assert.ok(error instanceof CompileError);
      assert.ok(!JSON.stringify(error).includes(marker));
      assert.ok(!String(error.stack).includes(marker));
      return true;
    },
  );
});

void test('parser enforces source, token and syntactic depth bounds without a stack overflow', () => {
  assert.equal(compile(`'${'a'.repeat(4094)}'`).length, 4096);
  rejects(`'${'a'.repeat(4095)}'`, 'EXPRESSION_LIMIT');
  assert.ok(compile(Array.from({ length: 256 }, () => '1').join('+')));
  rejects(Array.from({ length: 257 }, () => '1').join('+'), 'EXPRESSION_LIMIT');
  assert.equal(compile(`${'('.repeat(32)}1${')'.repeat(32)}`), '1');
  rejects(`${'('.repeat(33)}1${')'.repeat(33)}`, 'EXPRESSION_LIMIT');
  assert.ok(compile(`${'-'.repeat(32)}1`));
  rejects(`${'-'.repeat(33)}1`, 'EXPRESSION_LIMIT');
  assert.ok(compile(`${'not('.repeat(32)}1${')'.repeat(32)}`));
  rejects(`${'not('.repeat(33)}1${')'.repeat(33)}`, 'EXPRESSION_LIMIT');
  rejects(`${'('.repeat(2000)}1${')'.repeat(2000)}`, 'EXPRESSION_LIMIT');
});

void test('resolver owns semantic errors and is never invoked for literal contents', () => {
  assert.equal(
    compileExpression("'${a} /data/b .'", () => {
      throw new Error('unexpected resolution');
    }).xpath,
    "'${a} /data/b .'",
  );
  assert.throws(
    () =>
      compileExpression('${missing}', () => {
        throw new CompileError('REFERENCE_UNKNOWN');
      }),
    { code: 'REFERENCE_UNKNOWN' },
  );
});
