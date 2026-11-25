import { describe, expect, it } from 'vitest';
import pkg from '../../../package.json';
import { RUNNER_VERSION, checkRunner, installCommand, isDomain, lookupDomain, parseInstallOutput, phaseOf, verifiedInstallCommands } from '../../../src/setup/steps';
import { remoteInstallCommand } from '../../../src/setup';

describe('the steps of an installation', () => {
    it('install the version of the package, with the domain quoted for a shell', () => {
        expect(RUNNER_VERSION).toBe(pkg.version);
        expect(installCommand({ domain: 'Runner.Example.com' })).toBe(
            `curl -fsSL https://github.com/sherpadvisorylab/llmnative-runner/releases/download/v${pkg.version}/install.sh | sudo sh -s -- --domain 'runner.example.com'`,
        );
        expect(verifiedInstallCommands({ domain: 'runner.example.com', version: '1.2.3' })[1]).toContain('v1.2.3/install.sh.sha256');
        expect(remoteInstallCommand({ domain: 'runner.example.com', root: false })).toContain('| sudo -n sh -s --');
        expect(remoteInstallCommand({ domain: 'runner.example.com', root: true })).toContain('| sh -s --');
    });

    it('accepts host names of their own only', () => {
        expect(isDomain('runner.example.com')).toBe(true);
        expect(isDomain('runner')).toBe(false);
        expect(isDomain("x.com'; rm -rf /")).toBe(false);
        expect(isDomain('https://runner.example.com')).toBe(false);
    });

    it('reads what the installer prints for a machine', () => {
        const output = 'STEP=check\n==> Checking\nRUNNER_URL=https://runner.example.com\nPAIRING_CODE=ABCD-EFGH\n';
        expect(parseInstallOutput(output)).toEqual({ url: 'https://runner.example.com', pairingCode: 'ABCD-EFGH' });
        expect(parseInstallOutput('RUNNER_ERROR=port-busy\n')).toEqual({ error: 'port-busy' });
        expect(phaseOf('STEP=docker')).toBe('docker');
        expect(phaseOf('STEP=nope')).toBeUndefined();
    });

    it('looks a domain up over DNS-over-HTTPS and checks a runner by its health', async () => {
        const fetch = async (url: string | URL | Request) => {
            const address = String(url);
            if (address.includes('type=A&') || address.endsWith('type=A')) return new Response(JSON.stringify({ Answer: [{ type: 1, data: '203.0.113.10' }] }));
            if (address.includes('type=AAAA')) return new Response(JSON.stringify({}));
            return new Response(JSON.stringify({ ok: true, version: '1.0.0' }));
        };
        expect(await lookupDomain('runner.example.com', { fetch: fetch as typeof globalThis.fetch })).toEqual(['203.0.113.10']);
        expect(await checkRunner('https://runner.example.com', fetch as typeof globalThis.fetch)).toEqual({ ok: true, version: '1.0.0' });
        expect(await checkRunner('https://x', async () => { throw new Error('down'); })).toEqual({ ok: false, reason: 'unreachable' });
    });
});
