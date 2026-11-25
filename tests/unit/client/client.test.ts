import { describe, expect, it, vi } from 'vitest';
import { RunnerClient, RunnerError, forwardToRunner, noCreditUntil } from '../../../src/client';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('RunnerClient', () => {
    it('sends the key, the tenant and the person; gives back the JSON', async () => {
        const fetch = vi.fn(async () => json(200, { providers: [] }));
        const client = new RunnerClient({ url: 'https://runner.test/', key: 'rk_platform_x', tenant: 'acme', user: 'ana', fetch });
        expect(await client.models()).toEqual({ providers: [] });
        expect(fetch).toHaveBeenCalledWith('https://runner.test/v1/models', expect.objectContaining({
            method: 'GET',
            headers: { authorization: 'Bearer rk_platform_x', 'x-runner-tenant': 'acme', 'x-runner-user': 'ana' },
        }));
        await client.as({ user: 'bob' }).models();
        expect((fetch.mock.calls[1] as unknown as [string, { headers: Record<string, string> }])[1].headers['x-runner-user']).toBe('bob');
    });

    it('an error of the runner is a RunnerError with its code and reset', async () => {
        const client = new RunnerClient({ url: 'https://runner.test', fetch: async () => json(409, { error: 'no-credit', until: '2026-11-25T15:00:00.000Z' }) });
        const failure = await client.complete({ provider: 'claude-code', model: 'sonnet', prompt: 'hi' }).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(RunnerError);
        expect(failure).toMatchObject({ status: 409, code: 'no-credit', until: '2026-11-25T15:00:00.000Z' });
    });

    it('reads the reply of a chat as events, pings left out, lines split anywhere', async () => {
        const lines = ['{"type":"text","text":"Hi"}\n{"type":"pi', 'ng"}\n{"type":"error","message":"no-credit:2026-11-25T15:00:00.000Z"}\n'];
        const body = new ReadableStream({ start(controller) { for (const line of lines) controller.enqueue(new TextEncoder().encode(line)); controller.close(); } });
        const client = new RunnerClient({ url: 'https://runner.test', fetch: async () => new Response(body, { status: 200 }) });
        const events = [];
        for await (const event of client.chats.send('abcdef01', { text: 'hello', model: { provider: 'claude-code', model: 'sonnet' } })) events.push(event);
        expect(events).toEqual([{ type: 'text', text: 'Hi' }, { type: 'error', message: 'no-credit:2026-11-25T15:00:00.000Z' }]);
        expect(noCreditUntil(events[1])).toBe('2026-11-25T15:00:00.000Z');
    });
});

describe('forwardToRunner', () => {
    it('forwards the routes of a person with the key and the person of the host, whatever the browser sent', async () => {
        const fetch = vi.fn(async () => json(200, { ok: true }));
        const request = new Request('https://cms.test/api/runner/v1/complete?x=1', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: 'Bearer stolen', 'x-runner-user': 'someone-else' },
            body: JSON.stringify({ prompt: 'hi' }),
        });
        const response = await forwardToRunner(request, '/v1/complete', { url: 'https://runner.test', key: 'rk_tenant', user: 'ana' }, fetch);
        expect(response.status).toBe(200);
        const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit & { headers: Record<string, string> }];
        expect(url).toBe('https://runner.test/v1/complete?x=1');
        expect(init.headers).toEqual({ authorization: 'Bearer rk_tenant', 'x-runner-user': 'ana', 'content-type': 'application/json' });
    });

    it('never forwards the routes of a platform or the console', async () => {
        const fetch = vi.fn(async () => json(200, {}));
        for (const path of ['/v1/platform/status', '/v1/admin/pairing', '/v1/pair', '/console/', '/v1/internal/acme/chats/abcdef01/tool']) {
            const response = await forwardToRunner(new Request(`https://cms.test${path}`), path, { url: 'https://runner.test', key: 'k', user: 'ana' }, fetch);
            expect(response.status).toBe(404);
        }
        expect(fetch).not.toHaveBeenCalled();
    });
});
