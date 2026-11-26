import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import pkg from './package.json';

// The page of `npx @llmnative/runner setup`: the screens to add runners, served on localhost by bin/runner.mjs.
export default defineConfig({
    define: { __RUNNER_VERSION__: JSON.stringify(pkg.version) },
    root: resolve(__dirname, 'setup-app'),
    base: './',
    build: {
        outDir: resolve(__dirname, 'dist/setup-app'),
        emptyOutDir: true,
        target: 'baseline-widely-available',
    },
});
