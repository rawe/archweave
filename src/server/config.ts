import path from 'node:path';

export interface Config {
  repoDir: string;
  dataDir: string;
  hostRepoPath?: string;
  port: number;
  host: string;
  /** Extra hostnames accepted in the Host header besides localhost names and `host`. */
  allowedHosts: string[];
  /** Directory of the built web UI; absent means "look in the default places". */
  webDir?: string;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Config {
  const repoDir = path.resolve(env.ARCHWEAVE_REPO_DIR || process.cwd());
  return {
    repoDir,
    dataDir: path.resolve(repoDir, env.ARCHWEAVE_DATA_DIR || '.archweave'),
    hostRepoPath: env.ARCHWEAVE_HOST_REPO_PATH || undefined,
    port: env.PORT ? Number(env.PORT) : 4317,
    host: env.HOST || '127.0.0.1',
    allowedHosts: (env.ARCHWEAVE_ALLOWED_HOSTS ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
    webDir: env.ARCHWEAVE_WEB_DIR ? path.resolve(env.ARCHWEAVE_WEB_DIR) : undefined,
  };
}
