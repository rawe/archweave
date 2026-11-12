import type { Element } from '../../shared/model.ts';

export const PROMPTS: { label: string; build: (el: Element) => string }[] = [
  {
    label: 'Explain',
    build: (el) => `Explain how ${el.name} (ArchWeave id \`${el.id}\`) works: its responsibility, the code behind it and how it talks to its neighbors. Use get_element for the details.`,
  },
  {
    label: 'Investigate',
    build: (el) => `Investigate ${el.name} (ArchWeave id \`${el.id}\`). Check that its code links, relations and summary still match the code, fix the model where they drift and tell me what you found.`,
  },
  {
    label: 'Change…',
    build: (el) => `Change ${el.name} (ArchWeave id \`${el.id}\`) so that `,
  },
  {
    label: 'Implement',
    build: (el) => `Implement ${el.name} (ArchWeave id \`${el.id}\`) as designed in ArchWeave, then mark it built and add code links.`,
  },
];
