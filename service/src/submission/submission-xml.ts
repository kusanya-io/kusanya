/** Strict, bounded extraction of trusted routing metadata from an ODK instance. */
import { SaxesParser, type SaxesTagPlain } from 'saxes';
import { types } from 'node:util';

const maximumXmlBytes = 5_242_880;
const maximumNodes = 10_000;
const maximumDepth = 64;
const maximumText = 5_000_000;
const formKeyPattern = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;
const positiveIntegerPattern = /^[1-9][0-9]{0,9}$/;
const instanceIdPattern =
  /^uuid:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type SubmissionXmlFailureCode =
  'SUBMISSION_XML_INPUT' | 'SUBMISSION_XML_SHAPE';

export class SubmissionXmlError extends Error {
  constructor(readonly code: SubmissionXmlFailureCode) {
    super(code);
    this.name = 'SubmissionXmlError';
  }
}

export interface SubmissionXmlIdentity {
  readonly formKey: string;
  readonly formVersion: number;
  readonly instanceId: string;
  readonly bytes: Uint8Array;
}

const localName = (name: string): string => name.split(':').at(-1)!;

/**
 * Decode only routing identity. Answer interpretation remains the Apex engine's
 * responsibility; this parser never normalizes or rewrites the stored bytes.
 */
export function decodeSubmissionXml(value: unknown): SubmissionXmlIdentity {
  if (!(value instanceof Uint8Array) || types.isProxy(value))
    throw new SubmissionXmlError('SUBMISSION_XML_INPUT');
  const bytes = new Uint8Array(value);
  if (bytes.length === 0 || bytes.length > maximumXmlBytes)
    throw new SubmissionXmlError('SUBMISSION_XML_INPUT');
  let xml: string;
  try {
    xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new SubmissionXmlError('SUBMISSION_XML_INPUT');
  }

  const stack: string[] = [];
  let formKey: string | undefined;
  let formVersion: number | undefined;
  let instanceId: string | undefined;
  let instanceText = '';
  let collectingInstance = false;
  let nodes = 0;
  let textLength = 0;
  let roots = 0;
  const refuse = (): never => {
    throw new SubmissionXmlError('SUBMISSION_XML_SHAPE');
  };
  const parser = new SaxesParser({ xmlns: false, position: false });
  parser.on('doctype', refuse);
  parser.on('comment', refuse);
  parser.on('processinginstruction', refuse);
  parser.on('opentag', (tag: SaxesTagPlain) => {
    nodes++;
    if (nodes > maximumNodes || stack.length >= maximumDepth) refuse();
    const name = localName(tag.name);
    if (stack.length === 0) {
      roots++;
      if (roots !== 1) refuse();
      const id = tag.attributes.id;
      const version = tag.attributes.version;
      if (
        typeof id !== 'string' ||
        !formKeyPattern.test(id) ||
        typeof version !== 'string' ||
        !positiveIntegerPattern.test(version)
      )
        refuse();
      formKey = id;
      formVersion = Number(version);
      if (!Number.isSafeInteger(formVersion) || formVersion > 2_147_483_647)
        refuse();
    } else if (
      name === 'instanceID' &&
      localName(stack.at(-1)!) === 'meta' &&
      stack.length === 2
    ) {
      if (instanceId !== undefined || collectingInstance) refuse();
      if (Object.keys(tag.attributes).length !== 0) refuse();
      collectingInstance = true;
      instanceText = '';
    }
    stack.push(tag.name);
  });
  const appendText = (text: string): void => {
    textLength += text.length;
    if (textLength > maximumText) refuse();
    if (collectingInstance) {
      instanceText += text;
      if (instanceText.length > 255) refuse();
    }
  };
  parser.on('text', appendText);
  parser.on('cdata', appendText);
  parser.on('closetag', (tag) => {
    if (stack.pop() !== tag.name) refuse();
    if (collectingInstance && localName(tag.name) === 'instanceID') {
      const candidate = instanceText.trim();
      if (!instanceIdPattern.test(candidate)) refuse();
      instanceId = candidate.toLowerCase();
      collectingInstance = false;
    }
  });
  try {
    parser.write(xml).close();
  } catch (error) {
    if (error instanceof SubmissionXmlError) throw error;
    throw new SubmissionXmlError('SUBMISSION_XML_SHAPE');
  }
  if (
    stack.length !== 0 ||
    roots !== 1 ||
    formKey === undefined ||
    formVersion === undefined ||
    instanceId === undefined ||
    collectingInstance
  )
    refuse();
  return Object.freeze({
    formKey: formKey!,
    formVersion: formVersion!,
    instanceId: instanceId!,
    bytes: new Uint8Array(bytes),
  });
}
