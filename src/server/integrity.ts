import { diagramProblems } from '../shared/diagram/patch.ts';
import type { Model } from '../shared/model.ts';

/**
 * Graph problems a schema cannot catch: duplicate ids, references to missing
 * elements, data references to non-data elements, containment cycles, and
 * diagrams that are inconsistent in themselves or link to nothing.
 * Returns one readable line per problem; empty when the model is consistent.
 */
export function integrityProblems(model: Model): string[] {
  const problems: string[] = [];
  const elements = new Map<string, Model['elements'][number]>();
  for (const collection of ['elements', 'relations', 'flows', 'diagrams'] as const) {
    const seen = new Set<string>();
    for (const item of model[collection]) {
      if (seen.has(item.id)) problems.push(`duplicate ${collection.slice(0, -1)} id \`${item.id}\``);
      seen.add(item.id);
    }
  }
  for (const element of model.elements) if (!elements.has(element.id)) elements.set(element.id, element);
  const isData = (id: string) => elements.get(id)?.kind === 'data';

  for (const element of model.elements) {
    if (element.parentId !== undefined && !elements.has(element.parentId)) {
      problems.push(`element \`${element.id}\`: unknown parent \`${element.parentId}\``);
    }
    const noteIds = new Set<string>();
    for (const note of element.notes) {
      if (noteIds.has(note.id)) problems.push(`element \`${element.id}\`: duplicate note id \`${note.id}\``);
      noteIds.add(note.id);
    }
    for (const field of element.fields) {
      if (field.ref && !isData(field.ref)) problems.push(`element \`${element.id}\` field \`${field.name}\`: ref \`${field.ref}\` is not a data structure`);
    }
  }

  const reported = new Set<string>();
  for (const element of model.elements) {
    const chain = [element.id];
    let parentId = element.parentId;
    while (parentId && elements.has(parentId)) {
      if (chain.includes(parentId)) {
        const cycle = chain.slice(chain.indexOf(parentId));
        if (!cycle.some((id) => reported.has(id))) {
          cycle.forEach((id) => reported.add(id));
          problems.push(`containment cycle: ${[...cycle, parentId].map((id) => `\`${id}\``).join(' → ')}`);
        }
        break;
      }
      chain.push(parentId);
      parentId = elements.get(parentId)!.parentId;
    }
  }

  const endpoints = (where: string, from: string, to: string) => {
    if (!elements.has(from)) problems.push(`${where}: unknown element \`${from}\` in \`from\``);
    if (!elements.has(to)) problems.push(`${where}: unknown element \`${to}\` in \`to\``);
  };
  const dataIds = (where: string, ids: string[]) => {
    for (const id of ids) if (!isData(id)) problems.push(`${where}: data id \`${id}\` is not a data structure`);
  };
  for (const relation of model.relations) {
    endpoints(`relation \`${relation.id}\``, relation.from, relation.to);
    dataIds(`relation \`${relation.id}\``, relation.dataIds);
  }
  for (const flow of model.flows) {
    flow.steps.forEach((step, i) => {
      endpoints(`flow \`${flow.id}\` step ${i + 1}`, step.from, step.to);
      dataIds(`flow \`${flow.id}\` step ${i + 1}`, step.dataIds);
    });
  }
  for (const diagram of model.diagrams) problems.push(...diagramProblems(diagram, model));
  return problems;
}
