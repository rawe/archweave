import pkg from '../../package.json' with { type: 'json' };

/**
 * The server version: `ARCHWEAVE_VERSION` when set (the Docker image sets it from its build arg),
 * else the version in package.json, which esbuild inlines into the bundle.
 */
export function serverVersion(env: NodeJS.ProcessEnv = process.env): string {
  return env.ARCHWEAVE_VERSION?.trim() || pkg.version;
}

export const PACKAGE_VERSION: string = pkg.version;
