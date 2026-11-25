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
