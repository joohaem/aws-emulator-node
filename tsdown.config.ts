import { defineConfig } from 'tsdown';

export default defineConfig({
  // `install` is loaded by scripts/postinstall.mjs to fetch the native binding.
  entry: ['lib/index.ts', 'lib/install.ts'],
  format: ['cjs', 'esm'],
  platform: 'node',
  target: 'node24',
  clean: true,
  dts: true,
  // `import.meta.dirname` in the CommonJS build.
  shims: true,
  // The native binding is not shipped in the tarball (too large): it is downloaded from
  // GitHub Releases during postinstall. See lib/binding.ts.
  attw: {
    profile: 'node16',
  },
});
