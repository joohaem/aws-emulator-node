import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import pkg from '../package.json' with { type: 'json' };
import { bindingFileName, bindingPath } from './binding.js';

/** `https://github.com/<owner>/<repo>/releases/download/v<version>` */
export function releaseBaseUrl(
  version: string = pkg.version,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.SEOKJU_NA_AWS_EMULATOR_NODE_DOWNLOAD_BASE_URL;
  if (override != null) {
    return override.replace(/\/+$/, '');
  }
  const repo = pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, '');
  return `${repo}/releases/download/v${version}`;
}

export interface InstallOptions {
  version?: string;
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
}

/**
 * Download this platform's binary from the GitHub release of `version` into
 * {@link bindingPath}. Does nothing if it is already there. The file is written next to its
 * destination and renamed into place, so a crashed download never leaves a partial binary.
 *
 * @returns The installed binary's path
 */
export async function install(options: InstallOptions = {}): Promise<string> {
  const { version = pkg.version, env = process.env, log = console.log } = options;
  const destination = bindingPath(version, env);
  if (existsSync(destination)) {
    log(`${pkg.name}: native binding already installed at ${destination}`);
    return destination;
  }

  const url = `${releaseBaseUrl(version, env)}/${bindingFileName()}`;
  log(`${pkg.name}: downloading ${url}`);
  await mkdir(path.dirname(destination), { recursive: true });
  const partial = `${destination}.${process.pid}.download`;
  try {
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    const file = createWriteStream(partial);
    await pipeline(Readable.fromWeb(response.body as never), file);

    const expected = Number(response.headers.get('content-length'));
    if (expected > 0 && file.bytesWritten !== expected) {
      throw new Error(`truncated download: got ${file.bytesWritten} of ${expected} bytes`);
    }
    await rename(partial, destination);
  } catch (error) {
    await rm(partial, { force: true });
    throw new Error(`${pkg.name}: failed to download ${url}: ${(error as Error).message}`, {
      cause: error,
    });
  }
  log(`${pkg.name}: installed native binding at ${destination}`);
  return destination;
}
