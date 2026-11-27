import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DataProvider, I18nProvider, MockDataProvider } from '@llmnative/react';
import { MemoryRouter } from 'react-router-dom';
import { RunnerClient, type RunnerAccount } from '../../../src/client';
import { InstallGuide, RunnerAccounts, RunnersSettings, type RunnerFleet } from '../../../src/ui';

const wrap = ({ children }: { children: React.ReactNode }) => (
    <MemoryRouter>
        <DataProvider registry={{ default: new MockDataProvider() }} defaultKey="default">
            <I18nProvider>{children}</I18nProvider>
        </DataProvider>
    </MemoryRouter>
);
afterEach(cleanup);

function fakeClient(accounts: RunnerAccount[]) {
    const client = new RunnerClient({ url: 'https://cms.test/runner' });
    let list = [...accounts];
    vi.spyOn(client.accounts, 'list').mockImplementation(async () => ({ scope: 'user', accounts: list }));
    vi.spyOn(client.accounts, 'addKey').mockImplementation(async (provider, _key, label) => {
        const account: RunnerAccount = { provider, id: 'new', at: '2026-11-25T10:00:00Z', scope: 'user', ...(label ? { label } : {}) };
        list = [...list, account];
        return account;
    });
    vi.spyOn(client.accounts, 'rename').mockImplementation(async (provider, id, label) => {
        list = list.map((account) => (account.provider === provider && account.id === id ? { ...account, label } : account));
        return list;
    });
    vi.spyOn(client.accounts, 'order').mockImplementation(async (provider, ids) => {
        const mine = ids.map((id) => list.find((account) => account.provider === provider && account.id === id)!);
        list = [...list.filter((account) => account.provider !== provider), ...mine];
        return list;
    });
    return client;
}

const CLAUDE = (id: string, label?: string, extra: Partial<RunnerAccount> = {}): RunnerAccount => ({ provider: 'claude-code', id, at: '2026-11-20T10:00:00Z', scope: 'tenant', ...(label ? { label } : {}), ...extra });

describe('My subscriptions', () => {
    it('one section per subscription: the accounts in their order, with their state, and an OpenCode Go key added', async () => {
        const client = fakeClient([CLAUDE('a1', 'ana@example.com', { noCreditUntil: '2026-11-25T15:00:00Z' }), CLAUDE('a2')]);
        const onChange = vi.fn();
        render(<RunnerAccounts client={client} scope="user" onChange={onChange} />, { wrapper: wrap });
        expect(await screen.findByText('Claude Code (2)')).toBeTruthy();
        expect(screen.getByText('OpenCode Go (0)')).toBeTruthy();
        expect(screen.getByText('ana@example.com')).toBeTruthy();
        expect(screen.getByText('Account 2')).toBeTruthy();
        expect(screen.getByText(/Limit reached/)).toBeTruthy();
        expect(screen.getByText('Available')).toBeTruthy();
        expect(screen.getByText(/They are used in this order/)).toBeTruthy();
        // OpenCode Go: its own button, a key and a name.
        const addButtons = screen.getAllByText('Add subscription');
        await act(async () => { fireEvent.click(addButtons[1]); });
        fireEvent.change(document.querySelector('input[name="key"]') as HTMLInputElement, { target: { value: 'go-key-123456' } });
        fireEvent.change(document.querySelector('input[name="label"]') as HTMLInputElement, { target: { value: 'team@example.com' } });
        await act(async () => { fireEvent.click(screen.getByText('Add')); });
        await waitFor(() => expect(client.accounts.addKey).toHaveBeenCalledWith('opencode-go', 'go-key-123456', 'team@example.com'));
        await waitFor(() => expect(onChange).toHaveBeenCalled());
        expect(await screen.findByText('OpenCode Go (1)')).toBeTruthy();
    });

    it('renames an account with the email of the account', async () => {
        const client = fakeClient([CLAUDE('a1')]);
        render(<RunnerAccounts client={client} scope="tenant" />, { wrapper: wrap });
        const rename = await screen.findByLabelText('Rename Account 1');
        await act(async () => { fireEvent.click(rename); });
        const input = await waitFor(() => {
            const found = document.querySelector('input[name="label"]');
            if (!found) throw new Error('no name field');
            return found as HTMLInputElement;
        });
        fireEvent.change(input, { target: { value: 'ana@example.com' } });
        await act(async () => { fireEvent.click(screen.getByText('Save')); });
        await waitFor(() => expect(client.accounts.rename).toHaveBeenCalledWith('claude-code', 'a1', 'ana@example.com'));
        expect(await screen.findByText('ana@example.com')).toBeTruthy();
    });

    it('a second Claude account is added with the warning on personal subscriptions', async () => {
        const client = fakeClient([CLAUDE('a1', 'ana@example.com')]);
        vi.spyOn(client.accounts, 'startClaudeLogin').mockResolvedValue({ url: 'https://claude.ai/oauth' });
        render(<RunnerAccounts client={client} scope="tenant" providers={['claude-code']} />, { wrapper: wrap });
        const add = await screen.findByText('Add subscription');
        await act(async () => { fireEvent.click(add); });
        expect(await screen.findByText(/Pro and Max are personal subscriptions/)).toBeTruthy();
        expect(screen.queryByText(/OpenCode Go/)).toBeNull();
    });

    it('shows what the host gives under a subscription', async () => {
        render(<RunnerAccounts client={fakeClient([CLAUDE('a1')])} scope="tenant" providers={['claude-code', 'opencode-go']} renderProvider={(provider, accounts) => <p>defaults of {provider}: {accounts.length}</p>} />, { wrapper: wrap });
        expect(await screen.findByText('defaults of claude-code: 1')).toBeTruthy();
        expect(screen.getByText('defaults of opencode-go: 0')).toBeTruthy();
    });

    it('a tenant adds the API key of a provider by use, chosen in the list', async () => {
        const client = fakeClient([]);
        render(<RunnerAccounts client={client} scope="tenant" />, { wrapper: wrap });
        await screen.findByText(/API keys of the providers by use/);
        await act(async () => { fireEvent.click(screen.getByText('Add a key')); });
        const input = await waitFor(() => {
            const found = document.querySelector('input[name="key"]');
            if (!found) throw new Error(`no key field: ${document.body.textContent}`);
            return found as HTMLInputElement;
        });
        fireEvent.change(input, { target: { value: 'zen-key-123456' } });
        await act(async () => { fireEvent.click(screen.getByText('Add')); });
        await waitFor(() => expect(client.accounts.addKey).toHaveBeenCalledWith('opencode', 'zen-key-123456', undefined));
    });

    it('speaks Italian when asked', async () => {
        render(<RunnerAccounts client={fakeClient([])} scope="user" locale="it-IT" />, { wrapper: wrap });
        expect(await screen.findByText('I miei abbonamenti')).toBeTruthy();
        expect(screen.getAllByText('Nessun abbonamento collegato.').length).toBe(2);
        expect(screen.getAllByText('Aggiungi abbonamento').length).toBe(2);
    });
});

describe('the install guide', () => {
    it('fills the command with the domain, checks it, and pairs with the code', async () => {
        const onPair = vi.fn(async () => {});
        render(<InstallGuide onPair={onPair} lookup={async () => ['203.0.113.10']} check={async () => ({ ok: true, version: '1.0.0' })} />, { wrapper: wrap });
        fireEvent.change(document.querySelector('input[name="domain"]')!, { target: { value: 'runner.acme.com' } });
        expect(await screen.findByText(/--domain 'runner\.acme\.com'/)).toBeTruthy();
        await act(async () => { fireEvent.click(screen.getByText('Check')); });
        expect(await screen.findByText('The domain points to 203.0.113.10.')).toBeTruthy();
        fireEvent.change(document.querySelector('input[name="code"]')!, { target: { value: 'ABCD-EFGH' } });
        await act(async () => { fireEvent.click(screen.getByText('Connect')); });
        expect(onPair).toHaveBeenCalledWith({ url: 'https://runner.acme.com', code: 'ABCD-EFGH' });
    });
});

describe('the runners of a platform', () => {
    it('lists the runners with their state, and offers the three ways to add one', async () => {
        const fleet: RunnerFleet = {
            list: async () => [{ id: 'eu1', name: 'Runner EU', url: 'https://eu1.test', isDefault: true }, { id: 'us1', name: 'Runner US', url: 'https://us1.test' }],
            add: vi.fn(),
            update: vi.fn(async () => {}),
            remove: vi.fn(async () => {}),
            status: async (id) => {
                if (id === 'us1') throw new Error('down');
                return { version: '1.0.0', agentImage: 'agent', load: { chats: 2, answering: 1, completions: 0, maxChats: 6 }, machine: { totalBytes: 8e9, availableBytes: 4e9, cpus: 4 }, tenants: [{ id: 'acme', name: 'Acme', createdAt: '' }] };
            },
            install: vi.fn(),
        };
        render(<RunnersSettings fleet={fleet} />, { wrapper: wrap });
        expect(await screen.findByText('Runner EU')).toBeTruthy();
        expect(await screen.findByText('2 of 6 chats')).toBeTruthy();
        expect(await screen.findByText('Not reachable')).toBeTruthy();
        fireEvent.click(screen.getByText('Add a runner'));
        expect(await screen.findByText('Install it for me')).toBeTruthy();
        expect(screen.getByText('Guide me')).toBeTruthy();
        expect(screen.getByText('It is already installed')).toBeTruthy();
    });
});

describe('connecting a runner already installed', () => {
    it('asks the runner, shows the code to approve there, and connects when it is approved', async () => {
        const runner = { id: 'r1', name: 'VPS', url: 'https://vps.test' };
        let approved = false;
        const fleet: RunnerFleet = {
            list: async () => [],
            add: vi.fn(),
            update: vi.fn(async () => {}),
            remove: vi.fn(async () => {}),
            status: vi.fn(),
            startPairing: vi.fn(async () => ({ id: 'p1', code: 'K7QM-2XPA', approveUrl: 'https://vps.test/console/?approve=K7QM-2XPA', expiresAt: new Date(Date.now() + 600_000).toISOString() })),
            pairingStatus: vi.fn(async () => (approved ? { status: 'approved' as const, runner } : { status: 'pending' as const })),
        };
        const open = vi.spyOn(window, 'open').mockImplementation(() => null);
        vi.useFakeTimers({ shouldAdvanceTime: true });
        try {
            render(<RunnersSettings fleet={fleet} />, { wrapper: wrap });
            fireEvent.click(await screen.findByText('Add a runner'));
            fireEvent.click(await screen.findByText('It is already installed'));
            expect(document.querySelector('input[name="code"]')).toBeNull();
            fireEvent.change(document.querySelector('input[name="url"]')!, { target: { value: 'vps.test' } });
            await act(async () => { fireEvent.click(screen.getByText('Continue')); });
            expect(fleet.startPairing).toHaveBeenCalledWith({ name: 'vps.test', url: 'https://vps.test' });
            expect(await screen.findByText('K7QM-2XPA')).toBeTruthy();
            fireEvent.click(screen.getByText('Open the runner to approve'));
            expect(open).toHaveBeenCalledWith('https://vps.test/console/?approve=K7QM-2XPA', '_blank', 'noopener');
            await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
            expect(fleet.pairingStatus).toHaveBeenCalledWith('p1');
            approved = true;
            await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
            await vi.waitFor(() => expect(screen.queryByText('K7QM-2XPA')).toBeNull());
        } finally {
            vi.useRealTimers();
            open.mockRestore();
        }
    });
});
