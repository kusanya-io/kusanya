import assert from 'node:assert/strict';
import test from 'node:test';
import { LifecycleError } from './scratch-lifecycle.mjs';
import { classifyVerificationException } from './verification-error-classifier.mjs';

const coded = (code, message = 'private fixture value') =>
  Object.assign(new Error(message), { code });

test('classifies bounded infrastructure failures through fixed labels', () => {
  for (const code of ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'ABORT_ERR'])
    assert.equal(classifyVerificationException(coded(code)), 'timeout');
  for (const code of ['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'EPIPE'])
    assert.equal(classifyVerificationException(coded(code)), 'network');
  for (const code of ['ENOENT', 'EACCES', 'ENOSPC', 'EROFS'])
    assert.equal(classifyVerificationException(coded(code)), 'filesystem');
  assert.equal(
    classifyVerificationException(coded('ERR_CHILD_PROCESS_STDIO_MAXBUFFER')),
    'process',
  );
});

test('uses bounded messages and nested native causes without printing either', () => {
  assert.equal(
    classifyVerificationException(
      new TypeError('fetch failed', { cause: coded('ENOTFOUND') }),
    ),
    'network',
  );
  assert.equal(
    classifyVerificationException(new Error('operation timed out privately')),
    'timeout',
  );
  assert.equal(
    classifyVerificationException(new Error(`${'x'.repeat(1_025)} timeout`)),
    'unexpected-error',
  );
  const cyclic = new Error('private');
  cyclic.cause = cyclic;
  assert.equal(classifyVerificationException(cyclic), 'unexpected-error');
  assert.equal(
    classifyVerificationException(
      new LifecycleError('CLEANUP_FAILED', {
        cause: coded('ECONNRESET', 'private cleanup endpoint'),
      }),
    ),
    'network',
  );
});

test('distinguishes program errors without reflecting private messages', () => {
  assert.equal(classifyVerificationException(new TypeError('private')), 'type');
  assert.equal(
    classifyVerificationException(new RangeError('private')),
    'range',
  );
  assert.equal(
    classifyVerificationException(new SyntaxError('private')),
    'syntax',
  );
  const assertion = new Error('private');
  assertion.name = 'AssertionError';
  assert.equal(classifyVerificationException(assertion), 'assertion');
  assert.equal(
    classifyVerificationException(new Error('private')),
    'unexpected-error',
  );
  assert.equal(classifyVerificationException('private'), 'non-error');
});

test('never invokes accessors, proxies or coercion while classifying', () => {
  let invoked = 0;
  const hostile = new Error('private');
  Object.defineProperties(hostile, {
    code: {
      get() {
        invoked += 1;
        return 'ENOTFOUND';
      },
    },
    cause: {
      get() {
        invoked += 1;
        return coded('ETIMEDOUT');
      },
    },
  });
  assert.equal(classifyVerificationException(hostile), 'unexpected-error');
  assert.equal(invoked, 0);

  const proxied = new Proxy(new Error('private'), {
    get() {
      invoked += 1;
      return 'ENOTFOUND';
    },
    getOwnPropertyDescriptor() {
      invoked += 1;
      return undefined;
    },
    getPrototypeOf() {
      invoked += 1;
      return Error.prototype;
    },
  });
  assert.equal(classifyVerificationException(proxied), 'unrecognized');
  assert.equal(invoked, 0);
});
