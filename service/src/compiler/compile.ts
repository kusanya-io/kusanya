/** Compile a bounded definition to XML only. No evaluation, I/O, publication or authorization. */
import { prepareForm } from './prepare.js';
import { renderXForm } from './render.js';
import { CompileError, type CompileResult } from './types.js';

export function compileForm(input: unknown): CompileResult {
  const prepared = prepareForm(input);
  if (!prepared.ok) return prepared;
  try {
    const xml = renderXForm(prepared.graph, prepared.logic, prepared.counts);
    if (xml.length > 2_000_000) throw new CompileError('OUTPUT_LIMIT');
    return {
      ok: true,
      xml,
      validation: 'structural-only',
      warnings: prepared.warnings,
    };
  } catch (error) {
    if (error instanceof CompileError)
      return {
        ok: false,
        diagnostics: [
          {
            code: error.code,
            location: `questions[${prepared.graph.nodes.at(-1)!.index}]`,
          },
        ],
      };
    throw error;
  }
}
