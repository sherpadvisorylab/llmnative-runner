// @vitest-environment node
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRunnerServer } from '../../../server/src/api.ts';
import type { ChatHost } from '../../../server/src/chats.ts';
import { ClaudeAccounts } from '../../../server/src/claudeAccounts.ts';
import { readConfig } from '../../../server/src/config.ts';
import { Runtime } from '../../../server/src/runtime.ts';

// The API end to end over HTTP, the containers of the harnesses faked: what each one is given, and what it prints.

const TOKEN = (n: number) => `sk-ant-oat01-${String(n).repeat(30)}`;

type Exec = { container: string; script: string; env: Record<string, string> };

type Answer = (exec: Exec) => { output: string; code?: number } | Promise<{ output: string; code?: number }>;

function fakeHost(answer: Answer) {
    const execs: Exec[] = [];
    const containers = new Set<string>();
    const host: ChatHost = {
        async start(name) { containers.add(name); },
        async exec(container, script, env, onOutput) {
            const exec = { container, script, env };
            execs.push(exec);
            const { output, code = 0 } = await answer(exec);
            onOutput(output);
            return code;
        },
        async remove(name) { containers.delete(name); },
        async write() {},
        async interrupt() {},
    };
    return { host, execs, containers };
}

const claudeResult = (text: string) => `${JSON.stringify({ type: 'result', result: text, usage: { input_tokens: 10, output_tokens: 5 } })}\n`;

const servers: Array<{ close: () => void }> = [];
afterEach(() => { for (const server of servers.splice(0)) server.close(); });

async function start(answer: Answer = () => ({ output: claudeResult('hello') })) {
    const dataDir = mkdtempSync(join(tmpdir(), 'runner-'));
    const fake = fakeHost(answer);
    const lines: Array<Record<string, unknown>> = [];
    const runtime = new Runtime({
        config: readConfig({ DATA_DIR: dataDir, RUNNER_VERSION: '1.0.0', CONSOLE_DIR: '' }),
        host: fake.host,
        log: (msg, details) => lines.push({ msg, ...details }),
        claude: (file) => new ClaudeAccounts(file, () => { throw new Error('no CLI'); }),
        toolsBase: 'http://runner:8080',
    });
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
        try { json = JSON.parse(text); } catch { /* NDJSON or text */ }
        return { status: response.status, json, text };
    };
    // A platform paired, a tenant with its default key.
    const { json: pairing } = await call('POST', '/v1/admin/pairing', { key: (runtime as any).adminToken });
    const { json: paired } = await call('POST', '/v1/pair', { body: { code: pairing.code, name: 'cms' } });
    const { json: made } = await call('POST', '/v1/platform/tenants', { key: paired.key, body: { id: 'acme', name: 'Acme' } });
    return { runtime, call, fake, lines, platformKey: paired.key as string, tenantKey: made.key as string, adminToken: (runtime as any).adminToken as string };
}

describe('the runner over HTTP', () => {
    it('health is public; everything else needs a key', async () => {
        const { call } = await start();
        expect((await call('GET', '/health')).json).toMatchObject({ ok: true, version: '1.0.0' });
        expect((await call('GET', '/v1/info')).status).toBe(401);
        expect((await call('GET', '/v1/info', { key: 'rk_wrongwrongwrongwrongwrong' })).status).toBe(401);
    });

    it('pairing gives a platform key that manages tenants; a project key cannot', async () => {
        const { call, platformKey, tenantKey } = await start();
        expect(tenantKey).toMatch(/^rk_/);
        const status = await call('GET', '/v1/platform/status', { key: platformKey });
        expect(status.json.tenants.map((t: { id: string }) => t.id)).toEqual(['acme']);
        expect((await call('GET', '/v1/platform/status', { key: tenantKey })).status).toBe(403);
        expect((await call('POST', '/v1/admin/pairing', { key: platformKey })).status).toBe(403);
    });

    it('a platform asks to connect, the admin approves in the console, the platform gets its key', async () => {
        const { call, adminToken } = await start();
        const asked = await call('POST', '/v1/pair/requests', { body: { name: 'llmnative-cms' } });
        expect(asked.status).toBe(201);
        expect(asked.json.approveUrl).toContain(`/console/?approve=${asked.json.code}`);
        expect((await call('POST', '/v1/pair/requests/poll', { body: { request: asked.json.request } })).json).toEqual({ status: 'pending' });
        // Only the admin sees and answers the requests.
        expect((await call('GET', '/v1/admin/pairing/requests')).status).toBe(401);
        const listed = await call('GET', '/v1/admin/pairing/requests', { key: adminToken });
        expect(listed.json.requests.map((request: { code: string }) => request.code)).toEqual([asked.json.code]);
        expect(JSON.stringify(listed.json)).not.toContain(asked.json.request);
        expect((await call('POST', `/v1/admin/pairing/requests/${asked.json.code}/approve`, { key: adminToken })).status).toBe(200);
        const polled = await call('POST', '/v1/pair/requests/poll', { body: { request: asked.json.request } });
        expect(polled.json).toMatchObject({ status: 'approved', record: { kind: 'platform', name: 'llmnative-cms' } });
        expect((await call('GET', '/v1/platform/status', { key: polled.json.key })).status).toBe(200);
        expect((await call('POST', '/v1/pair/requests/poll', { body: { request: asked.json.request } })).json).toEqual({ status: 'expired' });
    });

    it('a platform of a project sees, makes and reaches only the tenants of its project', async () => {
        const { call, adminToken, platformKey } = await start();
        // Two projects on one runner, each paired with its project: by code, and by asking.
        const { json: code } = await call('POST', '/v1/admin/pairing', { key: adminToken });
        const crm = (await call('POST', '/v1/pair', { body: { code: code.code, name: 'crm', project: 'crm' } })).json;
        expect(crm.record).toMatchObject({ kind: 'platform', project: 'crm' });
        const asked = (await call('POST', '/v1/pair/requests', { body: { name: 'cms', project: 'cms' } })).json;
        const waiting = (await call('GET', '/v1/admin/pairing/requests', { key: adminToken })).json.requests;
        expect(waiting).toEqual([expect.objectContaining({ code: asked.code, project: 'cms' })]);
        await call('POST', `/v1/admin/pairing/requests/${asked.code}/approve`, { key: adminToken });
        const cms = (await call('POST', '/v1/pair/requests/poll', { body: { request: asked.request } })).json;
        expect(cms.record.project).toBe('cms');
        expect((await call('POST', '/v1/pair/requests', { body: { name: 'x', project: 'has-hyphen' } })).status).toBe(400);

        // Its own tenants: <project> and <project>-<tenant>; another's is refused when made, missing otherwise.
        expect((await call('POST', '/v1/platform/tenants', { key: crm.key, body: { id: 'crm-consuletica' } })).status).toBe(201);
        const cmsTenant = (await call('POST', '/v1/platform/tenants', { key: cms.key, body: { id: 'cms-acme' } })).json;
        expect((await call('POST', '/v1/platform/tenants', { key: crm.key, body: { id: 'cms-other' } })).status).toBe(403);
        expect((await call('POST', '/v1/platform/tenants', { key: crm.key, body: { id: 'crmx' } })).status).toBe(403);
        expect((await call('GET', '/v1/platform/tenants', { key: crm.key })).json.tenants.map((t: { id: string }) => t.id)).toEqual(['crm-consuletica']);
        const status = (await call('GET', '/v1/platform/status', { key: crm.key })).json;
        expect([status.project, status.tenants.map((t: { id: string }) => t.id)]).toEqual(['crm', ['crm-consuletica']]);
        expect((await call('DELETE', '/v1/platform/tenants/cms-acme', { key: crm.key })).status).toBe(404);
        expect((await call('GET', '/v1/platform/tenants/cms-acme/keys', { key: crm.key })).status).toBe(404);
        expect((await call('POST', '/v1/platform/tenants/cms-acme/keys', { key: crm.key, body: {} })).status).toBe(404);
        expect((await call('GET', '/v1/accounts', { key: crm.key, headers: { 'x-runner-tenant': 'cms-acme' } })).status).toBe(404);
        expect((await call('GET', '/v1/accounts', { key: cms.key, headers: { 'x-runner-tenant': 'cms-acme' } })).status).toBe(200);
        expect((await call('GET', '/v1/info', { key: cmsTenant.key })).json.tenant).toBe('cms-acme');

        // Platform keys: a project sees and revokes only those of its project.
        expect((await call('GET', '/v1/platform/keys', { key: crm.key })).json.keys.map((k: { name: string }) => k.name)).toEqual(['crm']);
        expect((await call('DELETE', `/v1/platform/keys/${cms.record.id}`, { key: crm.key })).status).toBe(404);

        // A key without a project (before 1.2) sees every tenant, until the admin gives it one.
        expect((await call('GET', '/v1/platform/tenants', { key: platformKey })).json.tenants.map((t: { id: string }) => t.id).sort()).toEqual(['acme', 'cms-acme', 'crm-consuletica']);
        const legacy = (await call('GET', '/v1/platform/keys', { key: adminToken })).json.keys.find((k: { name: string }) => k.name === 'cms');
        expect((await call('PUT', `/v1/admin/keys/${legacy.id}/project`, { key: platformKey, body: { project: 'cms' } })).status).toBe(403);
        expect((await call('PUT', `/v1/admin/keys/${legacy.id}/project`, { key: adminToken, body: { project: 'cms' } })).json.record.project).toBe('cms');
        expect((await call('GET', '/v1/platform/tenants', { key: platformKey })).json.tenants.map((t: { id: string }) => t.id)).toEqual(['cms-acme']);
        expect((await call('PUT', `/v1/admin/keys/${legacy.id}/project`, { key: adminToken, body: { project: null } })).json.record.project).toBeUndefined();
    });

    it('each person has their own subscriptions: used for them only, never listed to others', async () => {
        const { call, tenantKey, fake } = await start();
        const ana = { key: tenantKey, headers: { 'x-runner-user': 'ana' } };
        const bob = { key: tenantKey, headers: { 'x-runner-user': 'bob' } };
        const added = await call('POST', '/v1/accounts/claude-code', { ...ana, body: { token: TOKEN(1), label: 'Max' } });
        expect(added.status).toBe(201);
        expect(added.json.account).toMatchObject({ provider: 'claude-code', label: 'Max', scope: 'user' });
        expect(added.text).not.toContain('sk-ant');
        expect((await call('GET', '/v1/accounts', bob)).json.accounts).toEqual([]);
        // Bob has no subscription and the tenant none: nothing to run with.
        expect((await call('POST', '/v1/complete', { ...bob, body: { provider: 'claude-code', model: 'sonnet', prompt: 'hi' } })).json).toEqual({ error: 'no-provider' });
        const answer = await call('POST', '/v1/complete', { ...ana, body: { provider: 'claude-code', model: 'sonnet', prompt: 'hi' } });
        expect(answer.json).toEqual({ text: 'hello', usage: { inputTokens: 10, outputTokens: 5 } });
        expect(fake.execs.at(-1)!.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN(1));
        const models = await call('GET', '/v1/models', ana);
        expect(models.json.providers.find((p: { id: string }) => p.id === 'claude-code')).toMatchObject({ accounts: 1, yours: 1, tenant: 0, available: 1 });
    });

    it('a person without their own subscription uses those of the tenant', async () => {
        const { call, tenantKey, platformKey, fake } = await start();
        // The tenant account added by the platform (or the console) for the tenant itself.
        const tenantScope = { key: platformKey, headers: { 'x-runner-tenant': 'acme' } };
        expect((await call('POST', '/v1/accounts/claude-code', { ...tenantScope, body: { token: TOKEN(2) } })).status).toBe(201);
        await call('POST', '/v1/complete', { key: tenantKey, headers: { 'x-runner-user': 'bob' }, body: { provider: 'claude-code', model: 'sonnet', prompt: 'hi' } });
        expect(fake.execs.at(-1)!.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN(2));
    });

    it('a project key needs its permissions: acting for a person, the accounts of the tenant', async () => {
        const { call, platformKey } = await start();
        const { json } = await call('POST', '/v1/platform/tenants/acme/keys', { key: platformKey, body: { name: 'crm', permissions: ['complete'] } });
        const limited = json.key as string;
        expect((await call('GET', '/v1/models', { key: limited, headers: { 'x-runner-user': 'ana' } })).status).toBe(403);
        expect((await call('GET', '/v1/accounts', { key: limited })).status).toBe(403);
        expect((await call('POST', '/v1/chats', { key: limited, body: { id: 'abcdef01' } })).status).toBe(403);
    });

    it('an account out of credit is skipped for the next one, and said with its reset when none is left', async () => {
        let calls = 0;
        const { call, tenantKey, platformKey } = await start(() => {
            calls += 1;
            return calls === 1 ? { output: `${JSON.stringify({ type: 'result', is_error: true, result: 'Claude AI usage limit reached|1895600000' })}\n`, code: 1 } : { output: claudeResult('from the second') };
        });
        const ana = { key: tenantKey, headers: { 'x-runner-user': 'ana' } };
        await call('POST', '/v1/accounts/claude-code', { ...ana, body: { token: TOKEN(1) } });
        await call('POST', '/v1/accounts/claude-code', { key: platformKey, headers: { 'x-runner-tenant': 'acme' }, body: { token: TOKEN(2) } });
        expect((await call('POST', '/v1/complete', { ...ana, body: { provider: 'claude-code', model: 'sonnet', prompt: 'hi' } })).json.text).toBe('from the second');
        const listed = await call('GET', '/v1/accounts', ana);
        expect(listed.json.accounts[0].noCreditUntil).toBe(new Date(1895600000 * 1000).toISOString());
    });

    it('a chat belongs to its person: replies stream as JSON lines, others cannot reach it', async () => {
        const { call, tenantKey } = await start(() => ({
            output: [
                JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi ' } } }),
                JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Ana' } } }),
                JSON.stringify({ type: 'result', result: 'Hi Ana' }),
                '',
            ].join('\n'),
        }));
        const ana = { key: tenantKey, headers: { 'x-runner-user': 'ana' } };
        await call('POST', '/v1/accounts/claude-code', { ...ana, body: { token: TOKEN(1) } });
        expect((await call('POST', '/v1/chats', { ...ana, body: { id: 'abcdef01', tools: [{ name: 'read_page', description: 'Reads', inputSchema: { type: 'object' } }] } })).status).toBe(201);
        const reply = await call('POST', '/v1/chats/abcdef01/messages', { ...ana, body: { text: 'hello', model: { provider: 'claude-code', model: 'sonnet' } } });
        const events = reply.text.trim().split('\n').map((line) => JSON.parse(line));
        expect(events).toEqual([{ type: 'text', text: 'Hi ' }, { type: 'text', text: 'Ana' }, { type: 'done' }]);
        expect((await call('POST', '/v1/chats/abcdef01/messages', { key: tenantKey, headers: { 'x-runner-user': 'bob' }, body: { text: 'hi', model: { provider: 'claude-code', model: 'sonnet' } } })).status).toBe(404);
        expect((await call('DELETE', '/v1/chats/abcdef01', ana)).json).toEqual({ closed: true });
    });

    it('a call of a tool from the container reaches the client with the reply, and its answer goes back', async () => {
        const holder: { runtime?: Runtime; result?: unknown } = {};
        const ctx = await start(async (exec) => {
            // The MCP server of the container calls the tool with the token of the chat it was given.
            const mcp = JSON.parse(exec.env.RUNNER_MCP);
            const { RUNNER_TOOLS_TOKEN: token, RUNNER_TOOLS_URL: url } = mcp.mcpServers.tools.env;
            expect(url).toBe('http://runner:8080/v1/internal/acme/chats/abcdef02/tool');
            holder.result = await holder.runtime!.tenant('acme')!.chats.callTool('abcdef02', token, 'read_page', { url: '/home' });
            return { output: claudeResult('done') };
        });
        holder.runtime = ctx.runtime;
        const { call, tenantKey, runtime } = ctx;
        const ana = { key: tenantKey, headers: { 'x-runner-user': 'ana' } };
        await call('POST', '/v1/accounts/claude-code', { ...ana, body: { token: TOKEN(1) } });
        await call('POST', '/v1/chats', { ...ana, body: { id: 'abcdef02', tools: [{ name: 'read_page', description: 'Reads', inputSchema: { type: 'object' } }] } });
        const events: Array<{ type: string; id?: string; name?: string }> = [];
        await runtime.tenant('acme')!.chats.send('abcdef02', 'hello', { provider: 'claude-code', model: 'sonnet' }, (event) => {
            events.push(event as never);
            // The client runs the tool and answers over HTTP; another person could not.
            if (event.type === 'tool-call') {
                void call('POST', `/v1/chats/abcdef02/calls/${event.id}`, { key: tenantKey, headers: { 'x-runner-user': 'bob' }, body: { result: 'not yours' } })
                    .then((refused) => {
                        expect(refused.status).toBe(404);
                        return call('POST', `/v1/chats/abcdef02/calls/${event.id}`, { ...ana, body: { result: '<h1>Home</h1>' } });
                    });
            }
        });
        expect(events[0]).toMatchObject({ type: 'tool-call', name: 'read_page', input: { url: '/home' } });
        expect(holder.result).toEqual({ result: '<h1>Home</h1>' });
        expect(events.at(-1)).toEqual({ type: 'done' });
        expect((await call('POST', '/v1/internal/acme/chats/abcdef02/tool', { body: { name: 'read_page', input: {} }, headers: { 'x-chat-token': 'nope' } })).status).toBe(401);
    });

    it('never writes a token, a prompt or an answer in its log', async () => {
        const { call, tenantKey, lines } = await start();
        const ana = { key: tenantKey, headers: { 'x-runner-user': 'ana' } };
        await call('POST', '/v1/accounts/claude-code', { ...ana, body: { token: TOKEN(1) } });
        await call('POST', '/v1/complete', { ...ana, body: { provider: 'claude-code', model: 'sonnet', prompt: 'secret prompt' } });
        const all = JSON.stringify(lines);
        expect(all).not.toContain('sk-ant');
        expect(all).not.toContain('secret prompt');
        expect(all).not.toContain('hello');
        expect(all).not.toContain(tenantKey);
    });

    it('removing a tenant takes its keys and its people with it', async () => {
        const { call, platformKey, tenantKey } = await start();
        expect((await call('DELETE', '/v1/platform/tenants/acme', { key: platformKey })).json).toEqual({ removed: true });
        expect((await call('GET', '/v1/info', { key: tenantKey })).status).toBe(401);
    });
});
