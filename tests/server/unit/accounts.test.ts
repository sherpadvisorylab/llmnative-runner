// @vitest-environment node
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountsRegistry, keysOf } from '../../../server/src/accounts.ts';
import { ClaudeAccounts } from '../../../server/src/claudeAccounts.ts';
import { connectedAccounts } from '../../../server/src/providers.ts';

const TOKEN = (n: number) => `sk-ant-oat01-${String(n).repeat(30)}`;
const registry = () => new AccountsRegistry(mkdtempSync(join(tmpdir(), 'runner-')), (file) => new ClaudeAccounts(file, () => {
    throw new Error('no CLI in tests');
}));

describe('accounts by scope', () => {
    it('a person sees only their own accounts; the tenant has its own', () => {
        const accounts = registry();
        accounts.of({ tenant: 'acme', user: 'ana' }).claude.set('a1', TOKEN(1), 'Max of Ana');
        accounts.of({ tenant: 'acme', user: 'bob' }).addKey('opencode-go', 'go-key-of-bob-123');
        accounts.of({ tenant: 'acme' }).claude.set('t1', TOKEN(2));
        expect(accounts.of({ tenant: 'acme', user: 'ana' }).list()).toEqual([expect.objectContaining({ provider: 'claude-code', id: 'a1', label: 'Max of Ana', scope: 'user' })]);
        expect(accounts.of({ tenant: 'acme', user: 'bob' }).list().map((a) => a.provider)).toEqual(['opencode-go']);
        expect(accounts.of({ tenant: 'acme' }).list().map((a) => a.scope)).toEqual(['tenant']);
        // Never a secret in what is listed.
        expect(JSON.stringify(accounts.of({ tenant: 'acme', user: 'ana' }).list())).not.toContain('sk-ant');
    });

    it('a request runs with the accounts of the person first, then those of the tenant', () => {
        const accounts = registry();
        accounts.of({ tenant: 'acme', user: 'ana' }).claude.set('a1', TOKEN(1));
        accounts.of({ tenant: 'acme' }).claude.set('t1', TOKEN(2));
        const keys = accounts.keysFor({ tenant: 'acme', user: 'ana' });
        expect(keys.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN(1));
        expect(keys.env.CLAUDE_CODE_OAUTH_TOKEN__2).toBe(TOKEN(2));
        expect(connectedAccounts(keys.env, keys.accounts)['claude-code'].map((a) => a.id)).toEqual(['u:a1', 't:t1']);
        // Bob has none of his own: only the tenant's. Another tenant: nothing.
        expect(accounts.keysFor({ tenant: 'acme', user: 'bob' }).accounts['claude-code']).toEqual([{ id: 't:t1' }]);
        expect(accounts.keysFor({ tenant: 'other', user: 'ana' }).accounts).toEqual({});
    });

    it('keeps the order given, refuses keys that are not keys, removes', () => {
        const accounts = registry();
        const mine = accounts.of({ tenant: 'acme', user: 'ana' });
        const first = mine.addKey('opencode-go', 'first-key-123')!;
        const second = mine.addKey('opencode-go', 'second-key-456')!;
        expect(mine.addKey('opencode-go', 'short')).toBeUndefined();
        expect(mine.addKey('claude-code', 'x'.repeat(20))).toBeUndefined();
        expect(mine.setOrder('opencode-go', [second.id, first.id])).toBe(true);
        expect(mine.setOrder('opencode-go', ['nope'])).toBe(false);
        expect(keysOf([mine]).env.OPENCODE_GO_API_KEY).toBe('second-key-456');
        expect(mine.remove('opencode-go', second.id)).toBe(true);
        expect(mine.list().map((a) => a.id)).toEqual([first.id]);
    });

    it('a Claude sign-in asked twice at once gives the same page, with one CLI (the page of a person in strict mode)', async () => {
        const started: Array<{ stdout: PassThrough; killed: boolean }> = [];
        const claude = new ClaudeAccounts(join(mkdtempSync(join(tmpdir(), 'runner-')), 'claude.json'), () => {
            const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), killed: false, kill(this: EventEmitter & { killed: boolean }) { this.killed = true; this.emit('exit', null); return true; } });
            started.push(child);
            setTimeout(() => child.stdout.write('sign in: https://claude.com/cai/oauth/authorize?code=true&state=abc \n'), 10);
            return child as unknown as ChildProcess;
        });
        const [first, second] = await Promise.all([claude.start(), claude.start()]);
        expect(first).toEqual({ url: 'https://claude.com/cai/oauth/authorize?code=true&state=abc' });
        expect(second).toEqual(first);
        expect(started).toHaveLength(1);
        expect(started[0].killed).toBe(false);
    });
});

