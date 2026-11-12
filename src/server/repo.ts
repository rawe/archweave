import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const MAX_FILE_BYTES = 1024 * 1024;
const LIST_TTL_MS = 5000;
const WALK_LIMIT = 50_000;
const SKIPPED_DIRS = new Set(['node_modules', '.git', 'dist', 'build']);

export class PathError extends Error {}

export interface FileContent {
  path: string;
  exists: boolean;
  content?: string;
  lineCount?: number;
  language?: string;
  truncated?: boolean;
  binary?: boolean;
}

export interface FileInfo {
  absolute: string;
  isFile: boolean;
  mtimeMs: number;
  size: number;
}

/** Read-only access to the modeled repository, confined to its real path and never inside `.git`. */
export class Repo {
  readonly root: string;
  private listCache?: { at: number; files: Promise<string[]> };

  constructor(
    root: string,
    private hostPath?: string,
  ) {
    this.root = fs.realpathSync(root);
  }

  get name(): string {
    return path.basename(this.hostPath || this.root);
  }

  /**
   * Normalizes user or agent input to a repo-relative forward-slash path.
   * Accepts "./x", backslashes, and absolute paths under the repository (or its host path).
   */
  normalize(input: string): string {
    let p = input.trim().replace(/\\/g, '/');
    for (const base of [this.root, this.hostPath].filter(Boolean) as string[]) {
      const prefix = base.replace(/\\/g, '/').replace(/\/+$/, '');
      if (p === prefix) return '';
      if (p.startsWith(`${prefix}/`)) p = p.slice(prefix.length + 1);
    }
    if (path.posix.isAbsolute(p) || /^[a-zA-Z]:\//.test(p)) throw new PathError(`${input} is outside the repository`);
    const normalized = path.posix.normalize(p).replace(/^(\.\/)+/, '').replace(/\/+$/, '');
    if (normalized === '..' || normalized.startsWith('../')) throw new PathError(`${input} is outside the repository`);
    if (normalized === '.git' || normalized.startsWith('.git/') || normalized.includes('/.git/') || normalized.endsWith('/.git')) {
      throw new PathError(`${input} is inside .git`);
    }
    return normalized === '.' ? '' : normalized;
  }

  /** Resolves a repo-relative path to a real absolute path inside the repository, or undefined when it does not exist. */
  async resolve(relative: string): Promise<string | undefined> {
    const normalized = this.normalize(relative);
    let real: string;
    try {
      real = await fsp.realpath(path.join(this.root, normalized));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return undefined;
      throw error;
    }
    return this.confine(relative, real);
  }

  private confine(relative: string, real: string): string {
    const inside = path.relative(this.root, real);
    if (inside.startsWith('..') || path.isAbsolute(inside)) throw new PathError(`${relative} resolves outside the repository`);
    if (inside.split(path.sep).includes('.git')) throw new PathError(`${relative} is inside .git`);
    return real;
  }

  /** Synchronous `resolve`, for the store's write path. */
  resolveSync(relative: string): string | undefined {
    const normalized = this.normalize(relative);
    let real: string;
    try {
      real = fs.realpathSync(path.join(this.root, normalized));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return undefined;
      throw error;
    }
    return this.confine(relative, real);
  }

  /** Synchronous `info`. */
  infoSync(relative: string): FileInfo | undefined {
    const absolute = this.resolveSync(relative);
    if (!absolute) return undefined;
    const stat = fs.statSync(absolute);
    return { absolute, isFile: stat.isFile(), mtimeMs: stat.mtimeMs, size: stat.size };
  }

  async info(relative: string): Promise<FileInfo | undefined> {
    const absolute = await this.resolve(relative);
    if (!absolute) return undefined;
    const stat = await fsp.stat(absolute);
    return { absolute, isFile: stat.isFile(), mtimeMs: stat.mtimeMs, size: stat.size };
  }

  async readFile(relative: string): Promise<FileContent> {
    const normalized = this.normalize(relative);
    const info = await this.info(normalized);
    if (!info || !info.isFile) return { path: normalized, exists: false };
    const handle = await fsp.open(info.absolute, 'r');
    let buffer: Buffer;
    try {
      const length = Math.min(info.size, MAX_FILE_BYTES);
      buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, 0);
    } finally {
      await handle.close();
    }
    if (buffer.subarray(0, 8000).includes(0)) return { path: normalized, exists: true, binary: true };
    const truncated = info.size > MAX_FILE_BYTES;
    let content = buffer.toString('utf8');
    if (truncated) content = content.slice(0, content.lastIndexOf('\n') + 1);
    return {
      path: normalized,
      exists: true,
      content,
      lineCount: countLines(content),
      language: languageOf(normalized),
      ...(truncated ? { truncated } : {}),
    };
  }

  /** All files in the repository, from `git ls-files` when possible. Cached briefly. */
  listFiles(): Promise<string[]> {
    if (this.listCache && Date.now() - this.listCache.at < LIST_TTL_MS) return this.listCache.files;
    const files = this.gitFiles().then((git) => git ?? this.walk());
    files.catch(() => (this.listCache = undefined));
    this.listCache = { at: Date.now(), files };
    return files;
  }

  async searchFiles(query: string, limit = 50): Promise<string[]> {
    const files = await this.listFiles();
    const q = query.trim().toLowerCase();
    if (!q) return files.slice(0, limit);
    return files
      .map((file) => ({ file, score: fuzzyScore(q, file.toLowerCase()) }))
      .filter((m) => m.score > 0)
      .sort((a, b) => b.score - a.score || a.file.length - b.file.length || (a.file < b.file ? -1 : 1))
      .slice(0, limit)
      .map((m) => m.file);
  }

  private async gitFiles(): Promise<string[] | undefined> {
    if (!fs.existsSync(path.join(this.root, '.git'))) return undefined;
    try {
      const { stdout } = await run('git', ['-c', 'safe.directory=*', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
        cwd: this.root,
        maxBuffer: 64 * 1024 * 1024,
      });
      const files = stdout.split('\0').filter(Boolean);
      return [...new Set(files)].sort();
    } catch {
      return undefined;
    }
  }

  private async walk(): Promise<string[]> {
    const out: string[] = [];
    const visit = async (dir: string): Promise<void> => {
      if (out.length >= WALK_LIMIT) return;
      let entries: fs.Dirent[];
      try {
        entries = await fsp.readdir(path.join(this.root, dir), { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const relative = dir ? `${dir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (SKIPPED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
          await visit(relative);
        } else if (entry.isFile()) {
          out.push(relative);
          if (out.length >= WALK_LIMIT) return;
        }
      }
    };
    await visit('');
    return out.sort();
  }
}

export function countLines(content: string): number {
  if (!content) return 0;
  const lines = content.split('\n').length;
  return content.endsWith('\n') ? lines - 1 : lines;
}

/** Subsequence match with bonuses for matches in the file name, consecutive runs and segment starts. 0 = no match. */
function fuzzyScore(query: string, target: string): number {
  const baseStart = target.lastIndexOf('/') + 1;
  if (target.includes(query)) {
    const at = target.lastIndexOf(query);
    return 1000 + (at >= baseStart ? 500 : 0) - target.length;
  }
  let score = 0;
  let ti = 0;
  let streak = 0;
  for (const ch of query) {
    if (ch === ' ') continue;
    const found = target.indexOf(ch, ti);
    if (found < 0) return 0;
    streak = found === ti ? streak + 1 : 0;
    score += 1 + streak * 2 + (found >= baseStart ? 2 : 0) + (found === 0 || '/._-'.includes(target[found - 1]!) ? 3 : 0);
    ti = found + 1;
  }
  return score;
}

const LANGUAGES: Record<string, string> = {
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
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  scala: 'scala',
  cs: 'csharp',
  fs: 'fsharp',
  php: 'php',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  hpp: 'cpp',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'xml',
  xml: 'xml',
  svg: 'xml',
  vue: 'xml',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  sql: 'sql',
  graphql: 'graphql',
  gql: 'graphql',
  proto: 'protobuf',
  dart: 'dart',
  ex: 'elixir',
  exs: 'elixir',
  erl: 'erlang',
  lua: 'lua',
  r: 'r',
  tf: 'hcl',
  hcl: 'hcl',
};

export function languageOf(file: string): string | undefined {
  const base = path.posix.basename(file).toLowerCase();
  if (base === 'dockerfile' || base.endsWith('.dockerfile')) return 'dockerfile';
  if (base === 'makefile') return 'makefile';
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1) : '';
  return LANGUAGES[ext];
}
