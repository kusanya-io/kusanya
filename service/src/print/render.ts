/** Reviewer-only HTML from bounded definitions. No I/O, scripts, publication or authorization. */
import { createHash } from 'node:crypto';
import { prepareForm } from '../compiler/prepare.js';
import { renderXForm } from '../compiler/render.js';
import {
  CompileError,
  type Diagnostic,
  type QuestionNode,
} from '../compiler/types.js';
import {
  decodePrintMappings,
  type PrintFieldMapping,
  type PrintMapping,
} from './mappings.js';
import { printStyles } from './styles.js';

export type PrintViewResult =
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] }
  | {
      readonly ok: true;
      readonly html: string;
      readonly audience: 'reviewer-only';
      readonly validation: 'structural-only';
      readonly warnings: readonly Diagnostic[];
    };

const maxOutput = 4_000_000;
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
function escape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('\r', '&#13;');
}
const literal = (value: string): string =>
  `<span class="literal">${escape(value)}</span>`;
const code = (value: string): string =>
  `<code class="literal">${escape(value)}</code>`;
const yesNo = (value: boolean | undefined): string => (value ? 'Yes' : 'No');
const readonly = (node: QuestionNode): boolean =>
  Boolean(node.definition.readOnly) ||
  ['reference', 'calculate', 'note'].includes(node.definition.type);

/** Both inputs are required snapshots. The mapping summary is NOT an executable mapping contract. */
export function renderPrintView(
  formInput: unknown,
  mappingInput: unknown,
): PrintViewResult {
  const prepared = prepareForm(formInput);
  if (!prepared.ok) return prepared;
  const { graph, logic, counts, warnings } = prepared;
  let location = 'print';
  try {
    // Retain compileForm's final XML-size gate as well as the shared preflight limit.
    const xml = renderXForm(graph, logic, counts);
    if (xml.length > 2_000_000) throw new CompileError('OUTPUT_LIMIT');
    const bundle = decodePrintMappings(mappingInput, graph, (path) => {
      location = path;
    });
    location = 'print';
    const mappings = [...bundle.mappings].sort(
      (a, b) => a.order - b.order || compare(a.key, b.key),
    );
    const questionIds = new Map(
      graph.nodes.map((node, index) => [
        node.definition.name,
        `q-${index + 1}`,
      ]),
    );
    const mappingIds = new Map(
      mappings.map((mapping, index) => [mapping.key, `m-${index + 1}`]),
    );
    const assignments = new Map<
      string,
      { mapping: PrintMapping; field: PrintFieldMapping }[]
    >();
    const fieldsFor = (mapping: PrintMapping): PrintFieldMapping[] =>
      [...mapping.fields].sort(
        (a, b) =>
          compare(a.targetField.toLowerCase(), b.targetField.toLowerCase()) ||
          compare(a.targetField, b.targetField),
      );
    for (const mapping of mappings) {
      for (const field of fieldsFor(mapping)) {
        if (field.sourceKind !== 'question') continue;
        const values = assignments.get(field.question) ?? [];
        values.push({ mapping, field });
        assignments.set(field.question, values);
      }
    }
    const chunks: string[] = [];
    let units = 0;
    const put = (value: string): void => {
      units += value.length + 1;
      if (units > maxOutput) throw new CompileError('PRINT_OUTPUT_LIMIT');
      chunks.push(value);
    };
    const detail = (label: string, value: string, asCode = false): void => {
      put(
        `<dt>${escape(label)}</dt><dd>${asCode ? code(value) : literal(value)}</dd>`,
      );
    };
    const questionLink = (name: string): string =>
      `<a href="#${questionIds.get(name)!}">${code(name)}</a>`;
    const mappingLink = (key: string): string =>
      `<a href="#${mappingIds.get(key)!}">${code(key)}</a>`;
    const hash = createHash('sha256').update(xml).digest('hex');
    const styleHash = createHash('sha256').update(printStyles).digest('base64');
    const csp = `default-src 'none'; script-src 'none'; style-src 'sha256-${styleHash}'; base-uri 'none'; form-action 'none'; object-src 'none'`;
    put('<!doctype html>');
    put('<html lang="en"><head><meta charset="utf-8">');
    put(`<meta http-equiv="Content-Security-Policy" content="${escape(csp)}">`);
    put(
      '<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer">',
    );
    put(
      `<title>${escape(graph.definition.form.title)} — Kusanya reviewer print view</title>`,
    );
    put(`<style>${printStyles}</style></head><body><main>`);
    put('<header><div class="eyebrow">Kusanya / definition review</div>');
    put(`<h1>${literal(graph.definition.form.title)}</h1>`);
    put('<dl class="summary">');
    detail('Form key', graph.definition.form.key, true);
    detail('Version', String(graph.definition.form.version));
    detail(
      'Contents',
      `${graph.nodes.length} question nodes; ${mappings.length} supplied mapping summaries`,
    );
    detail('Compiled XForm SHA-256 (not a publication signature)', hash, true);
    put('</dl></header>');
    put(
      '<aside class="notice" aria-label="Review limitations"><h2>Reviewer-only • not publication approval</h2>',
    );
    put(
      '<p>This document includes author annotations and hidden/calculated questions. Do not distribute it to collectors or respondents.</p>',
    );
    put(
      '<p>The XForm is structurally checked only. Target existence, field types, permissions, picklist matches, record types, mapping answer scopes and mapping execution are not validated here. Mapping information is the supplied snapshot, not a live Salesforce read.</p>',
    );
    put(
      '<p class="screen-only">Use your browser’s Print command. No form answers can be entered or submitted from this document.</p></aside>',
    );

    const warningEntries = warnings
      .map((warning) => {
        const match = /^questions\[(\d+)\]$/.exec(warning.location);
        return {
          code: warning.code,
          context: match
            ? graph.nodes.find((node) => node.index === Number(match[1]))!.path
            : warning.location,
        };
      })
      .sort((a, b) => compare(a.context, b.context) || compare(a.code, b.code));
    if (warningEntries.length) {
      put(
        '<section class="notice" aria-label="Compiler warnings"><h2>Compiler warnings — review required</h2><ul>',
      );
      for (const warning of warningEntries) {
        put(`<li>${code(warning.context)}: ${code(warning.code)}`);
        if (warning.code === 'DYNAMIC_REPEAT_CLIENT_SPECIFIC')
          put(
            '<p>Count reduction is client-specific: JavaRosa retains existing instances; the Enketo probe removes trailing answered rows. Final counts and data retention are not equivalent. A publication/ingestion rule remains required.</p>',
          );
        put('</li>');
      }
      put('</ul></section>');
    }

    put(
      '<nav aria-label="Question index"><h2>Question index</h2><ol class="contents">',
    );
    for (const node of graph.nodes)
      put(
        `<li>${questionLink(node.definition.name)} <span class="muted">(${escape(node.definition.type)})</span></li>`,
      );
    put(
      '</ol></nav><section aria-labelledby="questions-heading"><h2 id="questions-heading">Question-by-question review</h2>',
    );
    for (const [index, node] of graph.nodes.entries()) {
      const question = node.definition;
      const compiled = logic.get(question.name)!;
      const container =
        question.type === 'section' || question.type === 'repeat';
      put(
        `<article id="q-${index + 1}" class="question${container ? ' container' : ''}" aria-labelledby="q-title-${index + 1}">`,
      );
      put(
        `<h3 id="q-title-${index + 1}"><span class="number">${index + 1}.</span>${code(question.name)}<span class="type">${escape(question.type)}</span></h3>`,
      );
      put(
        `<p class="label">${question.label === undefined ? '<em>No visible label supplied</em>' : literal(question.label)}</p>`,
      );
      put('<dl>');
      detail('Instance path', node.path, true);
      detail(
        'Placement',
        node.repeats.length
          ? `Inside repeat(s): ${node.repeats.join(' / ')}`
          : 'Outside all repeats (once per form)',
      );
      detail('Parent', node.parent?.definition.name ?? 'Form root', true);
      if (container)
        detail(
          'Container',
          question.type === 'repeat'
            ? 'Child questions repeat; this is not an answer field.'
            : 'Groups child questions; does not add repetition itself.',
        );
      detail('Collector Hint', question.hint ?? 'None supplied');
      detail('Required', yesNo(question.required));
      detail('Read-only in XForm', yesNo(readonly(node)));
      detail(
        'Collector control omitted',
        yesNo(question.hidden || question.type === 'calculate'),
      );
      detail(
        'Default',
        question.defaultValue === undefined
          ? 'Not set'
          : question.defaultValue === ''
            ? 'Empty string'
            : question.defaultValue,
      );
      detail(
        'Compiled local relevance',
        compiled.relevant ??
          'No local condition; parent conditions still apply.',
        Boolean(compiled.relevant),
      );
      const ancestors: QuestionNode[] = [];
      for (let parent = node.parent; parent; parent = parent.parent)
        ancestors.unshift(parent);
      const relevantParents = ancestors.filter(
        (parent) => logic.get(parent.definition.name)?.relevant,
      );
      if (!relevantParents.length) detail('Parent relevance', 'None');
      else {
        put(
          '<dt>Parent relevance (evaluated at each parent, not this question)</dt><dd><ul>',
        );
        for (const parent of relevantParents)
          put(
            `<li>${code(parent.path)}: ${code(logic.get(parent.definition.name)!.relevant!)}</li>`,
          );
        put('</ul></dd>');
      }
      detail(
        'Compiled constraint',
        compiled.constraint ?? 'None',
        Boolean(compiled.constraint),
      );
      if (compiled.constraint && question.constraintMessage !== undefined)
        detail('Constraint message', question.constraintMessage);
      detail(
        'Compiled calculation',
        compiled.calculation ?? 'None',
        Boolean(compiled.calculation),
      );
      const appearance =
        question.type === 'signature'
          ? 'signature'
          : (question.appearance ??
            (question.type === 'text_long' ? 'multiline' : undefined));
      if (appearance) detail('Appearance', appearance, true);
      if (question.type === 'repeat') {
        detail('Repeat mode', question.repeatMode!);
        detail(
          'Requested count',
          question.repeatMode === 'fixed'
            ? String(question.repeatCount)
            : question.repeatMode === 'from_answer'
              ? `From ${question.repeatSourceQuestion}; generated repeat bounds 0–${question.repeatMax ?? 1000}. Source constraints also apply.`
              : 'Collector-controlled; no generated count',
        );
        if (compiled.repeatCountPath)
          detail(
            'Compiled jr:count (repeat context)',
            compiled.repeatCountPath,
            true,
          );
      }
      put('</dl>');
      if (question.choiceList !== undefined) {
        put(
          `<table><caption>Choices — ${code(question.choiceList)}</caption><thead><tr><th scope="col" class="value">Stored value</th><th scope="col">Collector label</th></tr></thead><tbody>`,
        );
        const choices = [...graph.lists.get(question.choiceList)!.choices].sort(
          (a, b) => a.order - b.order || compare(a.value, b.value),
        );
        for (const choice of choices)
          put(
            `<tr><td>${code(choice.value)}</td><td>${literal(choice.label)}</td></tr>`,
          );
        put('</tbody></table>');
      }
      put('<h4>Mapped fields — supplied configuration only</h4>');
      const fields = assignments.get(question.name) ?? [];
      if (!fields.length)
        put('<p class="muted">No supplied question-to-field assignment.</p>');
      else {
        put('<ul>');
        for (const { mapping, field } of fields)
          put(
            `<li>${code(`${mapping.targetObject}.${field.targetField}`)} — mapping ${mappingLink(mapping.key)} (${escape(mapping.kind)}); transform ${code(field.transform ?? 'none')}</li>`,
          );
        put('</ul>');
      }
      if (
        question.authorNotes !== undefined ||
        question.regexExample !== undefined
      ) {
        put(
          '<aside class="author" aria-label="Author-only annotations"><h4>Author-only annotations — never collector help</h4><dl>',
        );
        if (question.authorNotes !== undefined)
          detail('Author Notes', question.authorNotes);
        if (question.regexExample !== undefined)
          detail('Regex example (not an executed test)', question.regexExample);
        put('</dl></aside>');
      }
      put('</article>');
    }
    put(
      '</section><section aria-labelledby="mapping-heading"><h2 id="mapping-heading">Mapping configuration summary</h2>',
    );
    put(
      '<p>These are review annotations, not verified write instructions. No records are created, transformed or resolved. Saved match-status flags are not accepted as proof of compatibility.</p>',
    );
    if (!mappings.length) put('<p>No mapping summaries were supplied.</p>');
    for (const [index, mapping] of mappings.entries()) {
      put(
        `<article class="mapping" id="m-${index + 1}"><h3>${code(mapping.key)}<span class="type">${escape(mapping.kind)}</span></h3><dl>`,
      );
      if (mapping.label !== undefined) detail('Mapping label', mapping.label);
      detail('Order', String(mapping.order));
      detail('Target object', mapping.targetObject, true);
      detail(
        'Record type DeveloperName',
        mapping.recordType ?? 'No explicit override',
        mapping.recordType !== undefined,
      );
      if (mapping.repeatQuestion) {
        put(
          `<dt>Repeat question</dt><dd>${questionLink(mapping.repeatQuestion)}</dd>`,
        );
      }
      if (mapping.parentMapping)
        put(
          `<dt>Parent mapping and lookup</dt><dd>${mappingLink(mapping.parentMapping)} via ${code(mapping.parentLookupField!)}</dd>`,
        );
      for (const [label, value] of [
        ['Reference matching field', mapping.matchingField],
        ['Upsert external-ID field', mapping.upsertExternalIdField],
        ['Collector stamp field (not executed)', mapping.collectorField],
        ['Submission stamp field (not executed)', mapping.submissionField],
      ] as const)
        if (value !== undefined) detail(label, value, true);
      put('</dl>');
      if (!mapping.fields.length)
        put('<p>No field assignments supplied for this mapping.</p>');
      else {
        put(
          '<table><caption>Field assignments</caption><thead><tr><th scope="col">Target field</th><th scope="col">Source</th><th scope="col">Transform (not executed)</th></tr></thead><tbody>',
        );
        for (const field of fieldsFor(mapping)) {
          let source: string;
          if (field.sourceKind === 'question')
            source = `Question ${questionLink(field.question)}`;
          else
            source =
              field.constantValue === null
                ? 'Blank constant (null in supplied snapshot)'
                : field.constantValue === ''
                  ? 'Empty-string constant'
                  : `Literal constant: ${literal(field.constantValue)}`;
          put(
            `<tr><td>${code(field.targetField)}</td><td>${source}</td><td>${code(field.transform ?? 'none')}</td></tr>`,
          );
        }
        put('</tbody></table>');
      }
      put('</article>');
    }
    put(
      '</section><footer>End of reviewer-only definition snapshot. This is not a collector form, an answer record, a live permission check or a publication approval.</footer></main></body></html>',
    );
    return {
      ok: true,
      html: `${chunks.join('\n')}\n`,
      audience: 'reviewer-only',
      validation: 'structural-only',
      warnings,
    };
  } catch (error) {
    if (error instanceof CompileError)
      return { ok: false, diagnostics: [{ code: error.code, location }] };
    throw error;
  }
}
