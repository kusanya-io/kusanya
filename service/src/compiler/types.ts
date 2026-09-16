/** Portable, in-memory authoring input. No Salesforce identifiers or persistence. */
export const questionTypes = [
  'section',
  'repeat',
  'note',
  'text',
  'text_long',
  'integer',
  'decimal',
  'select_one',
  'select_multiple',
  'date',
  'time',
  'datetime',
  'geopoint',
  'geotrace',
  'geoshape',
  'photo',
  'signature',
  'audio',
  'video',
  'file',
  'barcode',
  'calculate',
  'reference',
  'end',
] as const;
export type QuestionType = (typeof questionTypes)[number];

export interface QuestionDefinition {
  name: string;
  parent?: string;
  order: number;
  type: QuestionType;
  label?: string;
  hint?: string;
  /** Author-only: never included in compiler output or diagnostics. */
  authorNotes?: string;
  required?: boolean;
  readOnly?: boolean;
  hidden?: boolean;
  defaultValue?: string;
  calculation?: string;
  constraint?: string;
  constraintMessage?: string;
  regex?: string;
  regexExample?: string;
  minimum?: number;
  maximum?: number;
  relevant?: string;
  appearance?: string;
  choiceList?: string;
  repeatMode?: 'fixed' | 'from_answer' | 'open';
  repeatCount?: number;
  repeatSourceQuestion?: string;
  repeatMax?: number;
  // Recognized, but non-default values fail explicitly in the first compiler.
  samePage?: boolean;
  repeatAsTable?: boolean;
  cascadeLevel?: number;
  requireLivePhoto?: boolean;
  mediaMaxSeconds?: number;
  prefillSource?: string;
  validationScript?: string;
}

export interface ChoiceDefinition {
  value: string;
  label: string;
  order: number;
  filterValue?: string;
  score?: number;
}
export interface ChoiceListDefinition {
  name: string;
  choices: ChoiceDefinition[];
}
export interface SkipRuleDefinition {
  question: string;
  sourceQuestion: string;
  operator:
    | 'answered'
    | 'is'
    | 'is_not'
    | 'less_than'
    | 'greater_than'
    | 'in_range'
    | 'contains';
  value?: string;
  valueTo?: string;
  join: 'all' | 'any';
  action: 'show' | 'hide';
}
export interface FormDefinition {
  schemaVersion: 1;
  form: { key: string; title: string; version: number };
  questions: QuestionDefinition[];
  choiceLists: ChoiceListDefinition[];
  skipRules: SkipRuleDefinition[];
}
export interface Diagnostic {
  readonly code: string;
  /** Structural input location only; never echoes supplied values. */
  readonly location: string;
}
export type CompileResult =
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] }
  | {
      readonly ok: true;
      readonly xml: string;
      readonly validation: 'structural-only';
      readonly warnings: readonly Diagnostic[];
    };

/** Internal model; only the renderer's explicit allowlist may enter XML. */
export interface QuestionNode {
  definition: QuestionDefinition;
  index: number;
  path: string;
  parent: QuestionNode | undefined;
  children: QuestionNode[];
  /** Enclosing repeats, excluding this node even if it is a repeat. */
  repeats: string[];
}
export interface DefinitionGraph {
  definition: FormDefinition;
  nodes: QuestionNode[];
  roots: QuestionNode[];
  byName: Map<string, QuestionNode>;
  lists: Map<string, ChoiceListDefinition>;
}

export class CompileError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'CompileError';
  }
}

export const isContainer = (type: QuestionType): boolean =>
  type === 'section' || type === 'repeat';
export const isAnswerable = (type: QuestionType): boolean =>
  !isContainer(type) && type !== 'note' && type !== 'end';
