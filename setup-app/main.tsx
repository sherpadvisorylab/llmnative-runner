import React from 'react';
import { createRoot } from 'react-dom/client';
import { DataProvider, I18nProvider, MockDataProvider } from '@llmnative/react';
import '@llmnative/react/dist/index.css';
import { MemoryRouter } from 'react-router-dom';
import type { RunnerStatus } from '../src/client';
import type { InstallPhase } from '../src/setup/steps';
import { RunnersSettings, type RunnerEntry, type RunnerFleet, type RunnerPairingStart, type RunnerPairingState } from '../src/ui';

// The page of `npx @llmnative/runner setup`: the same screens a platform shows to add runners, its backend the
// command itself on this computer (SSH from here, the platform keys in ~/.llmnative-runner, 0600). The token in the
// address keeps other pages of the browser from calling it.

const token = new URLSearchParams(window.location.hash.slice(1)).get('token') ?? '';
const locale = navigator.language;

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`/api${path}`, {
        method,
        headers: { 'x-setup-token': token, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const data = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) throw new Error(data.error ?? `http ${response.status}`);
    return data as T;
}

const fleet: RunnerFleet = {
    localKeys: true,
    list: async () => (await api<{ runners: RunnerEntry[] }>('GET', '/runners')).runners,
    add: async (input) => (await api<{ runner: RunnerEntry }>('POST', '/runners', input)).runner,
    update: async (id, patch) => { await api('PATCH', `/runners/${encodeURIComponent(id)}`, patch); },
    remove: async (id) => { await api('DELETE', `/runners/${encodeURIComponent(id)}`); },
    status: (id) => api<RunnerStatus>('GET', `/runners/${encodeURIComponent(id)}/status`),
    startPairing: (input) => api<RunnerPairingStart>('POST', '/pairings', input),
    pairingStatus: (id) => api<RunnerPairingState>('GET', `/pairings/${encodeURIComponent(id)}`),
    // The installation as it goes: one JSON line per line the installer prints, then its end.
    install: async (input, onProgress) => {
        const response = await fetch('/api/install', { method: 'POST', headers: { 'x-setup-token': token, 'content-type': 'application/json' }, body: JSON.stringify(input) });
        if (!response.ok || !response.body) throw new Error((await response.json().catch(() => ({ error: `http ${response.status}` })) as { error: string }).error);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
            const { done, value } = await reader.read();
            buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
            const lines = buffer.split('\n');
            buffer = done ? '' : lines.pop() ?? '';
            for (const line of lines) {
                if (!line.trim()) continue;
                const event = JSON.parse(line) as { type: 'line'; line: string; phase?: InstallPhase } | { type: 'done'; runner: RunnerEntry } | { type: 'error'; message: string; code?: string };
                if (event.type === 'line') onProgress({ line: event.line, ...(event.phase ? { phase: event.phase } : {}) });
                else if (event.type === 'done') return event.runner;
                else throw new Error(event.code ? `${event.code}: ${event.message}` : event.message);
            }
            if (done) throw new Error('the installation ended without an answer');
        }
    },
};

createRoot(document.getElementById('root')!).render(
    <MemoryRouter>
        <DataProvider registry={{ default: new MockDataProvider() }} defaultKey="default">
            <I18nProvider>
                <div className="mx-auto max-w-4xl p-4">
                    <RunnersSettings fleet={fleet} locale={locale} />
                </div>
            </I18nProvider>
        </DataProvider>
    </MemoryRouter>,
);
