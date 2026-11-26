// @vitest-environment node
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error plain JS of the command line
import { startSetupServer } from '../../../bin/setup-server.mjs';

// The local page of `npx @llmnative/runner setup` (needs `npm run build` for its files).

const servers: Array<{ close: () => void }> = [];
afterEach(() => { for (const server of servers.splice(0)) server.close(); });

describe('the setup page on this computer', () => {
    it('answers only with the token of its address, and keeps no runner until one is added', async () => {
        const file = join(mkdtempSync(join(tmpdir(), 'setup-')), 'fleet.json');
        const { address, token, server } = await startSetupServer({ file });
        servers.push(server);
        const base = address.split('/#')[0];
        expect(address).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#token=/);
        expect((await fetch(`${base}/api/runners`)).status).toBe(401);
        const listed = await fetch(`${base}/api/runners`, { headers: { 'x-setup-token': token } });
        expect(await listed.json()).toEqual({ runners: [] });
        // A wrong address is refused before anything is kept.
        const refused = await fetch(`${base}/api/runners`, { method: 'POST', headers: { 'x-setup-token': token, 'content-type': 'application/json' }, body: JSON.stringify({ url: 'not a url', code: 'ABCD-EFGH' }) });
        expect(refused.status).toBe(400);
        expect(() => statSync(file)).toThrow();
    });
});
