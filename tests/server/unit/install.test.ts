// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8').replace(/\r\n/g, '\n');

describe('the installer', () => {
    it('writes the same compose file the repository has', () => {
        const script = read('install/install.sh');
        const embedded = /<<'COMPOSE'\n([\s\S]*?)\nCOMPOSE\n/.exec(script)?.[1];
        expect(embedded?.trim()).toBe(read('install/compose.yaml').trim());
    });

    it('installs the version of the package', () => {
        const version = JSON.parse(read('package.json')).version as string;
        expect(read('install/install.sh')).toContain(`VERSION="${version}"`);
        expect(read('install/coolify.yaml')).toContain(`llmnative-runner:${version}`);
    });

    it('is read whole before it runs: piped into sh, no command can swallow the rest of it', () => {
        const script = read('install/install.sh');
        expect(script.trimEnd().endsWith('main "$@" </dev/null')).toBe(true);
        expect(script).toMatch(/\nmain\(\) \{\n/);
        for (const line of script.split('\n').filter((text) => /docker compose (exec|pull|up)/.test(text))) expect(line).toContain('</dev/null');
    });
});
