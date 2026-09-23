/** Synthetic test bridge, not an Enketo server or a collector-facing application. */
import { transform } from 'enketo-transformer/web';
import { Form } from 'enketo-core';

window.kusanyaLoad = async (xform, instanceStr) => {
  const transformed = await transform({ xform, markdown: false });
  // Input is exclusively compiler-generated synthetic fixtures, never user HTML.
  document.body.innerHTML = `<main>${transformed.form}</main><footer>Powered by Enketo</footer>`;
  const form = new Form(document.querySelector('form'), {
    modelStr: transformed.model,
    instanceStr,
    // A draft reload is NOT an edit of an already-submitted record (new revision ID).
    submitted: false,
  });
  const errors = form.init();
  window.kusanyaForm = form;
  return errors;
};

window.kusanyaSnapshot = (kind) => {
  const xml = window.kusanyaForm.getDataStr();
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  if (doc.querySelector('parsererror'))
    throw new Error('Malformed engine instance');
  const parent = kind === 'nested' ? 'families' : 'households';
  const child = kind === 'nested' ? 'members' : 'people';
  const fixed = kind === 'nested' ? 'checks' : 'root_counted';
  const parents = [...doc.documentElement.children].filter(
    (el) => el.localName === parent,
  );
  return {
    xml,
    counts: parents.map((el) => el.querySelectorAll(child).length),
    secondaryCounts: parents.map((el) => el.querySelectorAll(fixed).length),
    domCounts: [
      ...document.querySelectorAll(`.or-repeat[name="/data/${parent}"]`),
    ].map((el) => el.querySelectorAll(`.or-repeat[name$="/${child}"]`).length),
    answers: parents.map((el) =>
      [
        ...el.querySelectorAll(
          kind === 'nested'
            ? 'member_name,check_note'
            : 'person_note,root_note',
        ),
      ].map((n) => n.textContent),
    ),
    onceCount: doc.querySelectorAll(
      kind === 'nested' ? 'once_note' : 'root_count',
    ).length,
    onceValue: doc.querySelector(kind === 'nested' ? 'once_note' : 'root_count')
      ?.textContent,
    instanceIds: [...doc.documentElement.children]
      .filter((el) => el.localName === 'meta' && !el.namespaceURI)
      .flatMap((meta) =>
        [...meta.children].filter(
          (el) => el.localName === 'instanceID' && !el.namespaceURI,
        ),
      )
      .map((el) => el.textContent),
    authorNoteLeaked:
      document.body.textContent.includes('RUNTIME_AUTHOR_ONLY_SENTINEL') ||
      xml.includes('RUNTIME_AUTHOR_ONLY_SENTINEL'),
  };
};
