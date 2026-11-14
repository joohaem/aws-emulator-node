#!/usr/bin/env node
import { existsSync } from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');

// Skip for this root repository
if (existsSync(path.join(root, 'Cargo.toml'))) {
  process.exit(0);
}

if (process.env.SEOKJU_NA_AWS_EMULATOR_NODE_SKIP_DOWNLOAD) {
  console.log('"SEOKJU_NA_AWS_EMULATOR_NODE_SKIP_DOWNLOAD" is set; skipping the native binding download');
  process.exit(0);
}

const installScript = path.join(root, 'dist', 'install.mjs');
const { install } = await import(installScript);
try {
  await install();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
