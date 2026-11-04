import { types } from 'node:util';

const timeoutCodes = new Set([
  'ABORT_ERR',
  'ESOCKETTIMEDOUT',
  'ETIMEDOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
]);
const networkCodes = new Set([
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
]);
const filesystemCodes = new Set([
  'EACCES',
  'EDQUOT',
  'EEXIST',
  'EMFILE',
  'ENFILE',
  'ENOENT',
  'ENOSPC',
  'EPERM',
  'EROFS',
]);
const timeoutNames = new Set(['AbortError', 'TimeoutError']);
const assertionNames = new Set(['AssertionError']);
const typeNames = new Set(['TypeError']);
const rangeNames = new Set(['RangeError']);
const syntaxNames = new Set(['SyntaxError']);

function dataString(value, key) {
  let current = value;
  for (let depth = 0; depth < 4 && current !== null; depth += 1) {
    if (
      (typeof current !== 'object' && typeof current !== 'function') ||
      types.isProxy(current)
    )
      return undefined;
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(current, key);
    } catch {
      return undefined;
    }
    if (descriptor)
      return Object.hasOwn(descriptor, 'value') &&
        typeof descriptor.value === 'string' &&
        descriptor.value.length <= 1_024
        ? descriptor.value
        : undefined;
    try {
      current = Object.getPrototypeOf(current);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function ownData(value, key) {
  if (
    value === null ||
    (typeof value !== 'object' && typeof value !== 'function') ||
    types.isProxy(value)
  )
    return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, 'value')
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function facts(value) {
  const values = [];
  const seen = new Set();
  let current = value;
  for (let depth = 0; depth < 3; depth += 1) {
    if (
      !types.isNativeError(current) ||
      types.isProxy(current) ||
      seen.has(current)
    )
      break;
    seen.add(current);
    values.push({
      code: dataString(current, 'code'),
      message: dataString(current, 'message'),
      name: dataString(current, 'name'),
    });
    current = ownData(current, 'cause');
  }
  return values;
}

/** Return one fixed diagnostic label without exposing or coercing thrown data. */
export function classifyVerificationException(value) {
  if (types.isProxy(value)) return 'unrecognized';
  if (!types.isNativeError(value)) return 'non-error';
  const observed = facts(value);
  const hasCode = (codes) =>
    observed.some(({ code }) => typeof code === 'string' && codes.has(code));
  const hasName = (names) =>
    observed.some(({ name }) => typeof name === 'string' && names.has(name));
  const hasMessage = (pattern) =>
    observed.some(
      ({ message }) => typeof message === 'string' && pattern.test(message),
    );

  if (
    hasCode(timeoutCodes) ||
    hasName(timeoutNames) ||
    hasMessage(/\b(?:timed out|timeout)\b/i)
  )
    return 'timeout';
  if (
    hasCode(networkCodes) ||
    hasMessage(/\b(?:fetch failed|network unreachable|socket hang up)\b/i)
  )
    return 'network';
  if (
    hasCode(filesystemCodes) ||
    hasMessage(
      /\b(?:disk quota|no space left|no such file|permission denied|read-only file system)\b/i,
    )
  )
    return 'filesystem';
  if (
    observed.some(({ code }) => code?.startsWith('ERR_CHILD_PROCESS_')) ||
    hasMessage(/\b(?:child process|spawn failed)\b/i)
  )
    return 'process';
  if (hasName(assertionNames)) return 'assertion';
  if (hasName(typeNames)) return 'type';
  if (hasName(rangeNames)) return 'range';
  if (hasName(syntaxNames)) return 'syntax';
  return 'unexpected-error';
}
