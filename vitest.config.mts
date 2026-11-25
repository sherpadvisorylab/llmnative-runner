import { defineConfig } from 'vitest/config';
import pkg from './package.json';

export default defineConfig({
    define: { __RUNNER_VERSION__: JSON.stringify(pkg.version) },
    test: {
        environment: 'happy-dom',
        globals: true,
        setupFiles: ['./tests/setup.ts'],
        include: ['tests/**/*.{test,spec}.{ts,tsx}'],
    },
});
