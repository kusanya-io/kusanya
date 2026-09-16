/** Internal shared preparation. Never expose its author-bearing graph as collector output. */
import { buildGraph, decodeDefinition, scopedReference } from './definition.js';
import { compileExpression, xpathLiteral } from './expression.js';
import type { RenderLogic } from './render.js';
import {
  CompileError,
  isAnswerable,
  isContainer,
  type DefinitionGraph,
  type Diagnostic,
  type QuestionNode,
  type SkipRuleDefinition,
} from './types.js';

export type PreparationResult =
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] }
  | {
      readonly ok: true;
      /** Internal source graph includes author-only fields; render explicit allowlists. */
      readonly graph: DefinitionGraph;
      readonly logic: Map<string, RenderLogic>;
      readonly counts: readonly {
        readonly path: string;
        readonly value: string;
      }[];
      readonly warnings: readonly Diagnostic[];
    };
const numeric = (node: QuestionNode): boolean =>
  ['integer', 'decimal'].includes(node.definition.type);
const textual = (node: QuestionNode): boolean =>
  ['text', 'text_long', 'barcode', 'reference'].includes(node.definition.type);
const and = (values: readonly string[]): string =>
  values.map((value) => `(${value})`).join(' and ');
const plainDecimal = /^-?(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/;
function decimalUnits(value: string): bigint {
  const [whole, fraction = ''] = value.replace(/^-/, '').split('.');
  return (
    BigInt(`${whole}${fraction.padEnd(6, '0')}`) *
    (value.startsWith('-') ? -1n : 1n)
  );
}

/** Validate and compile logic once for trusted in-process renderers. No I/O or evaluation. */
export function prepareForm(input: unknown): PreparationResult {
  let location = 'definition';
  const at = (path: string): void => {
    location = path;
  };
  try {
    const definition = decodeDefinition(input, at);
    const graph = buildGraph(definition, at);
    const logic = new Map<string, RenderLogic>();
    const dependencies = new Map<string, Set<string>>();
    const warnings: Diagnostic[] = [];
    const counts: { path: string; value: string }[] = [];
    const paths = new Map(graph.nodes.map((node) => [node.path, node]));
    for (const node of graph.nodes) {
      logic.set(node.definition.name, {});
      dependencies.set(node.definition.name, new Set());
    }
    const depend = (target: QuestionNode, source: QuestionNode): void => {
      dependencies.get(target.definition.name)!.add(source.definition.name);
    };
    function resolve(
      target: QuestionNode,
      reference: string,
      dependency: boolean,
    ): string {
      let source: QuestionNode | undefined;
      if (reference === '.') source = target;
      else if (reference.startsWith('/')) source = paths.get(reference);
      else if (reference.startsWith('./') || reference.startsWith('../')) {
        const parts = target.path.split('/');
        for (const part of reference.split('/')) {
          if (part === '..') parts.pop();
          else if (part !== '.') parts.push(part);
        }
        source = paths.get(parts.join('/'));
      } else source = graph.byName.get(reference);
      if (!source || !isAnswerable(source.definition.type))
        throw new CompileError('EXPRESSION_REFERENCE');
      if (dependency) depend(target, source);
      return source === target ? '.' : scopedReference(target, source);
    }
    function expression(
      node: QuestionNode,
      source: string,
      dependency: boolean,
    ): string {
      const compiled = compileExpression(source, (reference) =>
        resolve(node, reference, dependency),
      ).xpath;
      if (compiled.length > 32768) throw new CompileError('EXPRESSION_LIMIT');
      return compiled;
    }
    function decimal(value: string): string {
      if (
        !plainDecimal.test(value) ||
        value.length > 24 ||
        !Number.isFinite(Number(value)) ||
        Math.abs(Number(value)) > 1e12
      )
        throw new CompileError('SKIP_NUMERIC_VALUE');
      // Keep the authored decimal spelling; do not round it through Number().
      return value;
    }
    function skip(
      rule: SkipRuleDefinition,
      source: QuestionNode,
      target: QuestionNode,
    ): string {
      const reference = scopedReference(target, source);
      depend(target, source);
      const answered = `string-length(${reference}) > 0`;
      if (rule.operator === 'answered') {
        if (rule.value !== undefined || rule.valueTo !== undefined)
          throw new CompileError('SKIP_OPERANDS');
        return answered;
      }
      if (
        rule.value === undefined ||
        rule.value.length === 0 ||
        (rule.operator === 'in_range'
          ? rule.valueTo === undefined
          : rule.valueTo !== undefined)
      )
        throw new CompileError('SKIP_OPERANDS');
      let condition: string;
      switch (rule.operator) {
        case 'is':
        case 'is_not': {
          if (source.definition.type === 'select_multiple')
            throw new CompileError('SKIP_OPERATOR_TYPE');
          if (
            !textual(source) &&
            !numeric(source) &&
            source.definition.type !== 'select_one'
          )
            throw new CompileError('SKIP_OPERATOR_TYPE');
          const value = numeric(source)
            ? decimal(rule.value)
            : xpathLiteral(rule.value);
          if (
            source.definition.type === 'select_one' &&
            !graph.lists
              .get(source.definition.choiceList!)!
              .choices.some((choice) => choice.value === rule.value)
          )
            throw new CompileError('SKIP_CHOICE_VALUE');
          condition = `${reference} ${rule.operator === 'is' ? '=' : '!='} ${value}`;
          break;
        }
        case 'less_than':
        case 'greater_than':
        case 'in_range': {
          if (!numeric(source)) throw new CompileError('SKIP_OPERATOR_TYPE');
          const value = decimal(rule.value);
          if (rule.operator === 'in_range') {
            const upper = decimal(rule.valueTo!);
            if (decimalUnits(value) > decimalUnits(upper))
              throw new CompileError('SKIP_RANGE_ORDER');
            condition = and([
              `${reference} >= ${value}`,
              `${reference} <= ${upper}`,
            ]);
          } else
            condition = `${reference} ${rule.operator === 'less_than' ? '<' : '>'} ${value}`;
          break;
        }
        case 'contains': {
          if (source.definition.type === 'select_multiple') {
            if (
              !graph.lists
                .get(source.definition.choiceList!)!
                .choices.some((choice) => choice.value === rule.value)
            )
              throw new CompileError('SKIP_CHOICE_VALUE');
            condition = `selected(${reference}, ${xpathLiteral(rule.value)})`;
          } else if (textual(source))
            condition = `contains(${reference}, ${xpathLiteral(rule.value)})`;
          else throw new CompileError('SKIP_OPERATOR_TYPE');
          break;
        }
      }
      return and([answered, condition]);
    }

    for (const node of graph.nodes) {
      at(`questions[${node.index}]`);
      const question = node.definition;
      const compiled = logic.get(question.name)!;
      const container = isContainer(question.type);
      const select =
        question.type === 'select_one' || question.type === 'select_multiple';
      if (question.type === 'end') throw new CompileError('UNSUPPORTED_END');
      if (
        question.samePage ||
        question.repeatAsTable ||
        question.cascadeLevel !== undefined ||
        question.requireLivePhoto ||
        question.mediaMaxSeconds !== undefined ||
        question.prefillSource ||
        question.validationScript
      )
        throw new CompileError('UNSUPPORTED_QUESTION_OPTION');
      if (
        question.appearance &&
        !(
          (question.type === 'text_long' &&
            question.appearance === 'multiline') ||
          (question.type === 'signature' &&
            question.appearance === 'signature') ||
          (select && question.appearance === 'minimal') ||
          (question.type === 'section' &&
            question.appearance === 'field-list' &&
            node.children.every((child) => !isContainer(child.definition.type)))
        )
      )
        throw new CompileError('UNSUPPORTED_APPEARANCE');
      if (
        !question.hidden &&
        question.type !== 'calculate' &&
        !question.label?.trim()
      )
        throw new CompileError('QUESTION_LABEL');
      if (
        container &&
        (node.children.length === 0 ||
          question.required ||
          question.readOnly ||
          question.hidden ||
          question.defaultValue !== undefined ||
          question.calculation ||
          question.constraint ||
          question.regex ||
          question.minimum !== undefined ||
          question.maximum !== undefined)
      )
        throw new CompileError('CONTAINER_OPTIONS');
      if (
        question.type === 'note' &&
        (question.required ||
          question.defaultValue !== undefined ||
          question.calculation ||
          question.constraint ||
          question.regex ||
          question.minimum !== undefined ||
          question.maximum !== undefined)
      )
        throw new CompileError('NOTE_OPTIONS');
      if (question.type === 'calculate' && !question.calculation)
        throw new CompileError('CALCULATION_REQUIRED');
      if (
        select
          ? !question.choiceList ||
            !graph.lists.get(question.choiceList)?.choices.length
          : question.choiceList !== undefined
      )
        throw new CompileError('QUESTION_CHOICES');
      if (
        question.type !== 'repeat' &&
        [
          question.repeatMode,
          question.repeatCount,
          question.repeatSourceQuestion,
          question.repeatMax,
        ].some((value) => value !== undefined)
      )
        throw new CompileError('REPEAT_OPTIONS');
      if (
        (question.minimum !== undefined || question.maximum !== undefined) &&
        !numeric(node)
      )
        throw new CompileError('BOUND_TYPE');
      for (const bound of [question.minimum, question.maximum]) {
        if (
          bound !== undefined &&
          (!plainDecimal.test(String(bound)) ||
            (question.type === 'integer' &&
              (!Number.isInteger(bound) ||
                bound < -2147483648 ||
                bound > 2147483647)))
        )
          throw new CompileError('BOUND_PRECISION');
      }
      if (
        question.minimum !== undefined &&
        question.maximum !== undefined &&
        question.minimum > question.maximum
      )
        throw new CompileError('BOUND_ORDER');
      if (question.regex && !textual(node))
        throw new CompileError('REGEX_TYPE');
      if (question.regex && question.regex.length > 4096)
        throw new CompileError('EXPRESSION_LIMIT');
      if (question.defaultValue !== undefined) {
        if (question.calculation)
          throw new CompileError('DEFAULT_CALCULATION_CONFLICT');
        if (question.defaultValue !== '') {
          if (numeric(node)) {
            const value = decimal(question.defaultValue);
            if (
              (question.type === 'integer' &&
                (!/^-?[0-9]+$/.test(value) ||
                  Number(value) < -2147483648 ||
                  Number(value) > 2147483647)) ||
              (question.minimum !== undefined &&
                decimalUnits(value) < decimalUnits(String(question.minimum))) ||
              (question.maximum !== undefined &&
                decimalUnits(value) > decimalUnits(String(question.maximum)))
            )
              throw new CompileError('DEFAULT_VALUE');
          } else if (select) {
            const chosen =
              question.type === 'select_multiple'
                ? question.defaultValue.split(' ')
                : [question.defaultValue];
            const choices = graph.lists.get(question.choiceList!)!.choices;
            if (
              new Set(chosen).size !== chosen.length ||
              chosen.some(
                (value) => !choices.some((choice) => choice.value === value),
              )
            )
              throw new CompileError('DEFAULT_VALUE');
          } else if (!textual(node))
            throw new CompileError('UNSUPPORTED_DEFAULT');
        }
      }
      if (
        (question.hidden ||
          question.readOnly ||
          question.type === 'reference') &&
        question.required &&
        !question.defaultValue &&
        !question.calculation
      )
        throw new CompileError('HIDDEN_REQUIRED');
      if (question.calculation)
        compiled.calculation = expression(node, question.calculation, true);
      if (question.relevant)
        compiled.relevant = expression(node, question.relevant, true);
      const constraints: string[] = [];
      if (question.constraint)
        constraints.push(expression(node, question.constraint, false));
      if (question.regex)
        constraints.push(`regex(., ${xpathLiteral(question.regex)})`);
      if (question.minimum !== undefined)
        constraints.push(`. >= ${question.minimum}`);
      if (question.maximum !== undefined)
        constraints.push(`. <= ${question.maximum}`);
      if (constraints.length) compiled.constraint = and(constraints);
    }

    for (const node of graph.nodes.filter(
      (entry) => entry.definition.type === 'repeat',
    )) {
      at(`questions[${node.index}]`);
      const question = node.definition;
      const compiled = logic.get(question.name)!;
      if (question.repeatMode === 'fixed') {
        if (
          !question.repeatCount ||
          question.repeatSourceQuestion !== undefined ||
          question.repeatCount > 1000 ||
          (question.repeatMax !== undefined &&
            question.repeatMax < question.repeatCount)
        )
          throw new CompileError('REPEAT_OPTIONS');
        const path = `${node.parent?.path ?? '/data'}/_ksny_count_${question.name}`;
        counts.push({ path, value: String(question.repeatCount) });
        // Repeat count is evaluated in the repeat context; explicit sibling helper.
        compiled.repeatCountPath = node.repeats.length
          ? `../_ksny_count_${question.name}`
          : path;
      } else if (question.repeatMode === 'from_answer') {
        const source = graph.byName.get(question.repeatSourceQuestion ?? '');
        if (
          !source ||
          source.definition.type !== 'integer' ||
          question.repeatCount !== undefined
        )
          throw new CompileError('REPEAT_SOURCE');
        if (source.path.startsWith(`${node.path}/`))
          throw new CompileError('REPEAT_SOURCE_INSIDE');
        if (question.repeatMax !== undefined && question.repeatMax > 1000)
          throw new CompileError('REPEAT_OPTIONS');
        const ceiling = question.repeatMax ?? 1000;
        if (
          (source.definition.minimum !== undefined &&
            source.definition.minimum > ceiling) ||
          (source.definition.maximum !== undefined &&
            source.definition.maximum < 0) ||
          (source.definition.defaultValue !== undefined &&
            source.definition.defaultValue !== '' &&
            (Number(source.definition.defaultValue) < 0 ||
              Number(source.definition.defaultValue) > ceiling))
        )
          throw new CompileError('REPEAT_SOURCE_BOUNDS');
        compiled.repeatCountPath = scopedReference(node, source);
        depend(node, source);
        const sourceLogic = logic.get(source.definition.name)!;
        sourceLogic.constraint = and([
          ...(sourceLogic.constraint ? [sourceLogic.constraint] : []),
          '. >= 0',
          `. <= ${question.repeatMax ?? 1000}`,
        ]);
        warnings.push({ code: 'DYNAMIC_REPEAT_RETAINS_INSTANCES', location });
      } else if (question.repeatMode === 'open') {
        if (
          question.repeatCount !== undefined ||
          question.repeatSourceQuestion !== undefined ||
          question.repeatMax !== undefined
        )
          throw new CompileError('UNSUPPORTED_OPEN_REPEAT_LIMIT');
      } else throw new CompileError('REPEAT_OPTIONS');
    }

    const rulesByTarget = new Map<
      string,
      { rule: SkipRuleDefinition; condition: string }[]
    >();
    for (const [index, rule] of definition.skipRules.entries()) {
      at(`skipRules[${index}]`);
      const target = graph.byName.get(rule.question);
      const source = graph.byName.get(rule.sourceQuestion);
      if (
        !target ||
        !source ||
        source === target ||
        !isAnswerable(source.definition.type)
      )
        throw new CompileError('SKIP_SOURCE');
      const group = rulesByTarget.get(rule.question) ?? [];
      if (
        group.some(
          (entry) =>
            entry.rule.join !== rule.join || entry.rule.action !== rule.action,
        )
      )
        throw new CompileError('SKIP_POLICY_CONFLICT');
      group.push({ rule, condition: skip(rule, source, target) });
      rulesByTarget.set(rule.question, group);
    }
    for (const [name, rules] of rulesByTarget) {
      // Rule record order is not semantic; sort generated conditions for stable bytes.
      const conditions = rules.map((entry) => `(${entry.condition})`).sort();
      const joined = conditions.join(
        rules[0]!.rule.join === 'all' ? ' and ' : ' or ',
      );
      const result =
        rules[0]!.rule.action === 'hide' ? `not(${joined})` : joined;
      const compiled = logic.get(name)!;
      compiled.relevant = compiled.relevant
        ? and([compiled.relevant, result])
        : result;
    }
    // Parent relevance/count controls its descendants; include inherited edges.
    for (const node of graph.nodes) {
      let ancestor = node.parent;
      while (ancestor) {
        const ancestorLogic = logic.get(ancestor.definition.name)!;
        if (ancestorLogic.relevant || ancestorLogic.repeatCountPath)
          depend(node, ancestor);
        ancestor = ancestor.parent;
      }
    }
    const state = new Map<string, 'visiting' | 'done'>();
    function visit(name: string): void {
      if (state.get(name) === 'visiting')
        throw new CompileError('DEPENDENCY_CYCLE');
      if (state.get(name) === 'done') return;
      state.set(name, 'visiting');
      for (const dependency of dependencies.get(name)!) visit(dependency);
      state.set(name, 'done');
    }
    for (const node of graph.nodes) {
      at(`questions[${node.index}]`);
      visit(node.definition.name);
    }
    // Bound expanded output BEFORE rendering: reused choice lists are repeated per control.
    let outputBudget = 4096 + definition.form.title.length * 6;
    for (const node of graph.nodes) {
      at(`questions[${node.index}]`);
      const question = node.definition;
      const compiled = logic.get(question.name)!;
      outputBudget +=
        2048 +
        node.path.length * 12 +
        [
          question.label,
          question.hint,
          question.defaultValue,
          question.constraintMessage,
          compiled.constraint,
          compiled.calculation,
          compiled.relevant,
          compiled.repeatCountPath,
        ].reduce<number>((total, value) => total + (value?.length ?? 0) * 6, 0);
      if (question.choiceList)
        for (const choice of graph.lists.get(question.choiceList)!.choices)
          outputBudget += 256 + (choice.label.length + choice.value.length) * 6;
      if (outputBudget > 2_000_000) throw new CompileError('OUTPUT_LIMIT');
    }
    return { ok: true, graph, logic, counts, warnings };
  } catch (error) {
    if (error instanceof CompileError)
      return { ok: false, diagnostics: [{ code: error.code, location }] };
    throw error;
  }
}
