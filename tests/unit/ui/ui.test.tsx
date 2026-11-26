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
    return client;
}

describe('My subscriptions', () => {
    it('lists the accounts of the person with their limit, and adds an OpenCode Go key', async () => {
        const client = fakeClient([{ provider: 'claude-code', id: 'a1', label: 'Max of Ana', at: '2026-11-20T10:00:00Z', scope: 'user', noCreditUntil: '2026-11-25T15:00:00Z' }]);
        const onChange = vi.fn();
        render(<RunnerAccounts client={client} scope="user" onChange={onChange} />, { wrapper: wrap });
        expect(await screen.findByText('Max of Ana')).toBeTruthy();
        expect(screen.getByText(/Limit reached/)).toBeTruthy();
        fireEvent.click(screen.getByText('Add OpenCode Go'));
        const input = document.querySelector('input[name="key"]') as HTMLInputElement;
        fireEvent.change(input, { target: { value: 'go-key-123456' } });
        await act(async () => { fireEvent.click(screen.getByText('Add')); });
        await waitFor(() => expect(client.accounts.addKey).toHaveBeenCalledWith('opencode-go', 'go-key-123456', undefined));
        await waitFor(() => expect(onChange).toHaveBeenCalled());
    });

    it('a tenant adds the API key of a provider by use, chosen in the list', async () => {
        const client = fakeClient([]);
        render(<RunnerAccounts client={client} scope="tenant" />, { wrapper: wrap });
        await screen.findByText('No subscription connected.');
        await act(async () => { fireEvent.click(screen.getByText('Add a key')); });
        const input = await waitFor(() => {
            const found = document.querySelector('input[name="key"]');
            if (!found) throw new Error(`no key field: ${document.body.textContent}`);
            return found as HTMLInputElement;
        });
        fireEvent.change(input, { target: { value: 'go-key-123456' } });
        await act(async () => { fireEvent.click(screen.getByText('Add')); });
        await waitFor(() => expect(client.accounts.addKey).toHaveBeenCalledWith('opencode-go', 'go-key-123456', undefined));
    });

    it('speaks Italian when asked', async () => {
        render(<RunnerAccounts client={fakeClient([])} scope="user" locale="it-IT" />, { wrapper: wrap });
        expect(await screen.findByText('I miei abbonamenti')).toBeTruthy();
        expect(screen.getByText('Nessun abbonamento collegato.')).toBeTruthy();
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
