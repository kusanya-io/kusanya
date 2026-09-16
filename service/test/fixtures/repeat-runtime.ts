/**
 * Synthetic inputs shared by compiler source tests and optional engine probes.
 * Compiling these fixtures does not establish Collect or Enketo behaviour.
 *
 * Runtime scenario: change the two outer instances' counts independently to 2
 * and 3, give their children distinct answers, save and reload, then decrease a
 * count. Each engine probe must report its actual count-reduction behaviour;
 * this module does not assume that either engine deletes or retains answers.
 */
import type { FormDefinition } from '../../src/compiler/types.js';
import { question, simpleForm } from './compiler.js';

export function nestedCountRuntimeForm(): FormDefinition {
  const form = simpleForm([
    question('once_note', {
      label: 'Once-only visit note',
      hint: 'Enter this note once for the whole form.',
      authorNotes: 'RUNTIME_AUTHOR_ONLY_SENTINEL',
      order: 1,
    }),
    question('families', {
      label: 'Synthetic family',
      type: 'repeat',
      repeatMode: 'fixed',
      repeatCount: 2,
      order: 2,
    }),
    question('member_count', {
      label: 'Number of members',
      hint: 'Use 2 for family 1 and 3 for family 2.',
      type: 'integer',
      parent: 'families',
      defaultValue: '0',
      minimum: 0,
      maximum: 3,
      order: 1,
    }),
    question('members', {
      label: 'Synthetic member',
      type: 'repeat',
      parent: 'families',
      repeatMode: 'from_answer',
      repeatSourceQuestion: 'member_count',
      repeatMax: 3,
      order: 2,
    }),
    question('member_name', {
      label: 'Synthetic member name',
      parent: 'members',
      hint: 'Use a distinct synthetic answer for each family and member.',
      authorNotes: 'RUNTIME_AUTHOR_ONLY_SENTINEL',
    }),
    question('checks', {
      label: 'Fixed check',
      type: 'repeat',
      parent: 'families',
      repeatMode: 'fixed',
      repeatCount: 3,
      order: 3,
    }),
    question('check_note', {
      label: 'Synthetic check note',
      parent: 'checks',
    }),
  ]);
  form.form = {
    key: 'synthetic_nested_count_runtime',
    title: 'Synthetic nested repeat count probe',
    version: 1,
  };
  return form;
}

export function sectionCountRuntimeForm(): FormDefinition {
  const form = simpleForm([
    question('root_count', {
      label: 'Once-only shared count',
      type: 'integer',
      defaultValue: '1',
      minimum: 0,
      maximum: 3,
      hint: 'This single answer controls a repeat inside each household.',
      authorNotes: 'RUNTIME_AUTHOR_ONLY_SENTINEL',
      order: 1,
    }),
    question('households', {
      label: 'Synthetic household',
      type: 'repeat',
      repeatMode: 'fixed',
      repeatCount: 2,
      order: 2,
    }),
    question('settings', {
      label: 'Household settings',
      type: 'section',
      parent: 'households',
      order: 1,
    }),
    question('member_limit', {
      label: 'Number of people',
      hint: 'Use 2 for household 1 and 3 for household 2.',
      type: 'integer',
      parent: 'settings',
      defaultValue: '0',
      minimum: 0,
      maximum: 3,
    }),
    question('survey', {
      label: 'Household survey',
      type: 'section',
      parent: 'households',
      order: 2,
    }),
    question('people', {
      label: 'Synthetic person',
      type: 'repeat',
      parent: 'survey',
      repeatMode: 'from_answer',
      repeatSourceQuestion: 'member_limit',
      repeatMax: 3,
    }),
    question('person_note', {
      label: 'Synthetic person note',
      parent: 'people',
      authorNotes: 'RUNTIME_AUTHOR_ONLY_SENTINEL',
    }),
    question('root_counted', {
      label: 'Shared-count observation',
      type: 'repeat',
      parent: 'households',
      repeatMode: 'from_answer',
      repeatSourceQuestion: 'root_count',
      repeatMax: 3,
      order: 3,
    }),
    question('root_note', {
      label: 'Synthetic observation note',
      parent: 'root_counted',
    }),
  ]);
  form.form = {
    key: 'synthetic_section_count_runtime',
    title: 'Synthetic section repeat count probe',
    version: 1,
  };
  return form;
}
