import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decodeSubmissionXml,
  SubmissionXmlError,
} from '../../src/submission/submission-xml.js';

const instanceId = 'uuid:123e4567-e89b-12d3-a456-426614174000';
const valid = (body = '<answer>yes</answer>') =>
  `<?xml version="1.0" encoding="UTF-8"?>` +
  `<data id="form_key" version="7">${body}` +
  `<meta><instanceID>${instanceId}</instanceID></meta></data>`;
const bytes = (value: string) => new TextEncoder().encode(value);

void test('submission XML identity preserves bytes and reads the ODK metadata', () => {
  const xml = valid(
    '<group><repeat><answer><![CDATA[yes]]></answer></repeat></group>',
  );
  const source = bytes(xml);
  const decoded = decodeSubmissionXml(source);
  assert.equal(decoded.formKey, 'form_key');
  assert.equal(decoded.formVersion, 7);
  assert.equal(decoded.instanceId, instanceId);
  assert.deepEqual(decoded.bytes, source);
  assert.notEqual(decoded.bytes, source);
  assert.ok(Object.isFrozen(decoded));
});

void test('submission XML refuses active content and ambiguous identity', () => {
  const invalid = [
    `<!DOCTYPE data [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>${valid()}`,
    valid().replace(
      '<answer>yes</answer>',
      '<!-- hidden --><answer>yes</answer>',
    ),
    valid().replace(
      '<answer>yes</answer>',
      '<?unsafe value?><answer>yes</answer>',
    ),
    valid().replace(
      '</data>',
      `<meta><instanceID>${instanceId}</instanceID></meta></data>`,
    ),
    valid()
      .replace('<meta>', '<group><meta>')
      .replace('</meta>', '</meta></group>'),
    valid().replace('id="form_key"', 'id="bad key"'),
    valid().replace('version="7"', 'version="0"'),
    valid().replace(instanceId, 'uuid:not-a-uuid'),
    '<data id="form_key" version="1"><answer>yes</answer></data>',
    '<data id="form_key" version="1"></data><other/>',
  ];
  for (const xml of invalid)
    assert.throws(
      () => decodeSubmissionXml(bytes(xml)),
      (error: unknown) =>
        error instanceof SubmissionXmlError &&
        error.code === 'SUBMISSION_XML_SHAPE',
    );
});

void test('submission XML applies byte, node and depth bounds', () => {
  assert.throws(
    () => decodeSubmissionXml(bytes('x'.repeat(5_242_881))),
    /SUBMISSION_XML_INPUT/,
  );
  assert.throws(
    () => decodeSubmissionXml(bytes(valid('<x/>'.repeat(10_001)))),
    /SUBMISSION_XML_SHAPE/,
  );
  const deep = `${'<g>'.repeat(64)}value${'</g>'.repeat(64)}`;
  assert.throws(
    () => decodeSubmissionXml(bytes(valid(deep))),
    /SUBMISSION_XML_SHAPE/,
  );
});

void test('submission XML input type is explicit and accessors are never invoked', () => {
  for (const value of [null, undefined, new Uint8Array(), {}, [], valid()])
    assert.throws(() => decodeSubmissionXml(value), /SUBMISSION_XML_INPUT/);
  let reads = 0;
  const hostile = Object.defineProperty({}, 'toString', {
    get() {
      reads++;
      throw new Error('must not run');
    },
  });
  assert.throws(() => decodeSubmissionXml(hostile), /SUBMISSION_XML_INPUT/);
  assert.throws(
    () => decodeSubmissionXml(new Uint8Array([0xc3, 0x28])),
    /SUBMISSION_XML_INPUT/,
  );
  assert.equal(reads, 0);
});
