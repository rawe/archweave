import hljs from 'highlight.js/lib/common';

const BY_EXTENSION: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  md: 'markdown',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'xml',
  xml: 'xml',
  svg: 'xml',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  sql: 'sql',
  graphql: 'graphql',
  gql: 'graphql',
  lua: 'lua',
  pl: 'perl',
  r: 'r',
  dockerfile: 'dockerfile',
  makefile: 'makefile',
};

export function languageFor(path: string, hint?: string): string | undefined {
  if (hint && hljs.getLanguage(hint)) return hint;
  const name = path.split('/').pop()?.toLowerCase() ?? '';
  if (name === 'dockerfile') return hljs.getLanguage('dockerfile') ? 'dockerfile' : undefined;
  if (name === 'makefile') return hljs.getLanguage('makefile') ? 'makefile' : undefined;
  const ext = name.includes('.') ? name.split('.').pop()! : '';
  const lang = BY_EXTENSION[ext];
  return lang && hljs.getLanguage(lang) ? lang : undefined;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Highlighted HTML, one string per source line, with spans closed and reopened at line breaks. */
export function highlightLines(content: string, language?: string): string[] {
  const html = language && content.length < 400_000 ? hljs.highlight(content, { language, ignoreIllegals: true }).value : escapeHtml(content);
  const lines: string[] = [];
  const open: string[] = [];
  let line = '';
  const re = /(<span[^>]*>)|(<\/span>)|(\n)|([^<\n]+)|(<)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m[1]) {
      open.push(m[1]);
      line += m[1];
    } else if (m[2]) {
      open.pop();
      line += m[2];
    } else if (m[3]) {
      line += '</span>'.repeat(open.length);
      lines.push(line);
      line = open.join('');
    } else line += m[0];
  }
  lines.push(line);
  return lines;
}
