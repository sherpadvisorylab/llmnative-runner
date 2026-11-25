import { builtinModules } from 'node:module';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import pkg from './package.json';

// The library: client and steps (browser and Node), ui (React), setup (Node). Dependencies and peers external.
const externalPackages = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
]);

const external = (id: string) => {
    if (id.startsWith('node:') || builtinModules.includes(id)) return true;
    return [...externalPackages].some((name) => id === name || id.startsWith(`${name}/`)) || id === 'react/jsx-runtime';
};

export default defineConfig({
    define: { __RUNNER_VERSION__: JSON.stringify(pkg.version) },
    build: {
        target: 'baseline-widely-available',
        lib: {
            entry: {
                client: resolve(__dirname, 'src/client/index.ts'),
                ui: resolve(__dirname, 'src/ui/index.ts'),
                setup: resolve(__dirname, 'src/setup/index.ts'),
                steps: resolve(__dirname, 'src/setup/steps.ts'),
            },
            formats: ['es', 'cjs'],
            fileName: (format, entryName) => (format === 'es' ? `${entryName}.mjs` : `${entryName}.js`),
        },
        rolldownOptions: { external },
        sourcemap: true,
        emptyOutDir: false,
    },
});
