import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import pkg from './package.json';

// The console the runner serves at /console: one page, built into dist/console and copied in its image.
export default defineConfig({
    define: { __RUNNER_VERSION__: JSON.stringify(pkg.version) },
    root: resolve(__dirname, 'console'),
    base: '/console/',
    build: {
        outDir: resolve(__dirname, 'dist/console'),
        emptyOutDir: true,
        target: 'baseline-widely-available',
    },
    server: {
        // `npm run console:dev` against a runner on this machine.
        proxy: { '/v1': 'http://127.0.0.1:8080', '/health': 'http://127.0.0.1:8080' },
    },
});
