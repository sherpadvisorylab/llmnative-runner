// @vitest-environment node
import { mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRunnerServer } from '../../../server/src/api.ts';
import { ClaudeAccounts } from '../../../server/src/claudeAccounts.ts';
import { readConfig } from '../../../server/src/config.ts';
import { loadModules, startModules, type ModuleScope, type RunnerModule } from '../../../server/src/modules.ts';
import { Runtime } from '../../../server/src/runtime.ts';

// Modules of an image FROM llmnative-runner: routes for one tenant with a key, public hooks, the runner as it is.

const servers: Array<{ close: () => void }> = [];
afterEach(() => { for (const server of servers.splice(0)) server.close(); });

const fakeHost = { async start() {}, async exec() { return 0; }, async remove() {} };

function fakeModule() {
    const seen: Array<{ scope: ModuleScope; path: string; body: string }> = [];
    const removed: string[] = [];
    const encoder = new TextEncoder();
    const module: RunnerModule = {
        name: 'turns',
        async handle(request, scope, path) {
            if (path === '/missing') return undefined;
            seen.push({ scope, path, body: request.method === 'POST' ? await request.text() : '' });
            if (path === '/stream') {
                return new Response(new ReadableStream({
                    start(controller) {
                        controller.enqueue(encoder.encode('{"a":1}\n'));
                        controller.enqueue(encoder.encode('{"b":2}\n'));
                        controller.close();
                    },
                }), { headers: { 'content-type': 'application/x-ndjson' } });
            }
            return Response.json({ ok: true, tenant: scope.tenant });
        },
        async hook(request, path) {
            return path === '/github' ? Response.json({ hooked: request.headers.get('x-github-event') }) : undefined;
        },
        removeTenant(tenant) { removed.push(tenant); },
    };
    return { module, seen, removed };
}

async function start(module: RunnerModule) {
    const dataDir = mkdtempSync(join(tmpdir(), 'runner-modules-'));
    const runtime = new Runtime({
        config: readConfig({ DATA_DIR: dataDir, RUNNER_VERSION: '1.3.0', CONSOLE_DIR: '' }),
        host: fakeHost,
        log: () => undefined,
        claude: (file) => new ClaudeAccounts(file, () => { throw new Error('no CLI'); }),
    });
    runtime.modules = [module];
    const server = createRunnerServer(runtime);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = async (method: string, path: string, options: { key?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
        const response = await fetch(`${base}${path}`, {
            method,
            headers: { ...(options.key ? { authorization: `Bearer ${options.key}` } : {}), ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}), ...options.headers },
            ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        });
        const text = await response.text();
        let json: any = text;
        try { json = JSON.parse(text); } catch { /* a stream */ }
        return { status: response.status, json, text };
    };
    const admin = (runtime as any).adminToken as string;
    const code = (await call('POST', '/v1/admin/pairing', { key: admin })).json.code;
    const platform = (await call('POST', '/v1/pair', { body: { code, name: 'studio', project: 'playbook' } })).json.key as string;
    const made = (await call('POST', '/v1/platform/tenants', { key: platform, body: { id: 'playbook-acme' } })).json;
    return { runtime, call, platform, tenantKey: made.key as string };
}

describe('modules of the runner', () => {
    it('serve their routes for one tenant, with a key: a project key needs the permission modules', async () => {
        const fake = fakeModule();
        const { call, platform, tenantKey } = await start(fake.module);
        const tenant = { 'x-runner-tenant': 'playbook-acme' };
        expect((await call('GET', '/v1/modules/turns/state')).status).toBe(401);
        expect((await call('GET', '/v1/modules/turns/state', { key: tenantKey })).status).toBe(403);
        const asPlatform = await call('POST', '/v1/modules/turns/issues/12', { key: platform, headers: tenant, body: { go: true } });
        expect(asPlatform.json).toEqual({ ok: true, tenant: 'playbook-acme' });
        expect(fake.seen[0]).toEqual({ scope: { tenant: 'playbook-acme', caller: 'platform' }, path: '/issues/12', body: '{"go":true}' });
        expect((await call('GET', '/v1/modules/turns/state', { key: platform, headers: { 'x-runner-tenant': 'cms-acme' } })).status).toBe(404);
        expect((await call('GET', '/v1/modules/turns/missing', { key: platform, headers: tenant })).status).toBe(404);
        expect((await call('GET', '/v1/modules/other/x', { key: platform, headers: tenant })).status).toBe(404);
        expect((await call('GET', '/v1/modules/turns/stream', { key: platform, headers: tenant })).text).toBe('{"a":1}\n{"b":2}\n');
        const key = (await call('POST', '/v1/platform/tenants/playbook-acme/keys', { key: platform, body: { permissions: ['modules'] } })).json.key;
        expect((await call('GET', '/v1/modules/turns/state', { key })).json.tenant).toBe('playbook-acme');
        expect((await call('GET', '/v1/info', { key })).json.modules).toEqual(['turns']);
    });

    it('a hook is public, and the module hears when a tenant goes', async () => {
        const fake = fakeModule();
        const { call, platform } = await start(fake.module);
        expect((await call('POST', '/hooks/turns/github', { body: {}, headers: { 'x-github-event': 'issues' } })).json).toEqual({ hooked: 'issues' });
        expect((await call('POST', '/hooks/turns/other', { body: {} })).status).toBe(404);
        expect((await call('POST', '/hooks/nobody/github', { body: {} })).status).toBe(404);
        await call('DELETE', '/v1/platform/tenants/playbook-acme', { key: platform });
        expect(fake.removed).toEqual(['playbook-acme']);
    });

    it('are loaded from RUNNER_MODULES and started with a folder of their own; one that fails is left out', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'runner-module-file-'));
        writeFileSync(join(dir, 'good.mjs'), 'export default { name: "good", start(context) { globalThis.__moduleDir = context.dataDir; } };');
        writeFileSync(join(dir, 'bad.mjs'), 'export default { name: "bad", start() { throw new Error("no"); } };');
        writeFileSync(join(dir, 'nameless.mjs'), 'export default {};');
        const lines: string[] = [];
        const log = (line: string) => { lines.push(line); };
        const loaded = await loadModules([join(dir, 'good.mjs'), join(dir, 'bad.mjs'), join(dir, 'nameless.mjs'), join(dir, 'missing.mjs')], log);
        expect(loaded.map((module) => module.name)).toEqual(['good', 'bad']);
        const dataDir = mkdtempSync(join(tmpdir(), 'runner-module-data-'));
        const context = () => ({ config: readConfig({ DATA_DIR: dataDir }), log, host: fakeHost, tenants: () => [], keysFor: () => ({ env: {}, accounts: {} }), credit: () => undefined });
        const started = await startModules(loaded, context, dataDir, log);
        expect(started.map((module) => module.name)).toEqual(['good']);
        expect((globalThis as { __moduleDir?: string }).__moduleDir).toBe(join(dataDir, 'modules', 'good'));
        expect(lines.filter((line) => line.startsWith('module not'))).toHaveLength(3);
    });
});
