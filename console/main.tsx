import React, { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Card, DataProvider, Form, I18nProvider, LoadingButton, MockDataProvider, Password } from '@llmnative/react';
import { MemoryRouter } from 'react-router-dom';
import '@llmnative/react/dist/index.css';
import { RunnerClient } from '../src/client';
import { RunnerConsole } from '../src/ui/RunnerConsole';
import { textsFor } from '../src/ui/texts';

// The console the runner serves at /console: signed in with the admin token of the machine, kept for this tab only.

const STORAGE = 'llmnative-runner-admin';
const locale = navigator.language;
const t = textsFor(locale);

const read = () => {
    try {
        return sessionStorage.getItem(STORAGE) ?? '';
    } catch {
        return '';
    }
};

function Console() {
    const [token, setToken] = useState(read);
    const [typed, setTyped] = useState('');
    const [error, setError] = useState('');
    const client = useMemo(() => (token ? new RunnerClient({ url: window.location.origin, key: token }) : null), [token]);
    const signOut = () => {
        try { sessionStorage.removeItem(STORAGE); } catch { /* nothing kept */ }
        setToken('');
    };
    if (client) return <RunnerConsole client={client} locale={locale} onSignOut={signOut} />;
    return (
        <div className="mx-auto max-w-md p-4 pt-16">
            <Card title={t.consoleTitle}>
                <Form appearance="empty" showNotice={false} onSubmit={() => false}>
                    <Password name="token" label={t.consoleToken} feedback={t.consoleTokenHint} autoComplete="off" onChange={({ value }) => setTyped(String(value ?? ''))} />
                </Form>
                {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
                <div className="mt-3">
                    <LoadingButton
                        label={t.consoleSignIn}
                        variant="primary"
                        disabled={typed.trim().length < 32}
                        onClick={async () => {
                            const candidate = new RunnerClient({ url: window.location.origin, key: typed.trim() });
                            try {
                                await candidate.platform.status();
                                try { sessionStorage.setItem(STORAGE, typed.trim()); } catch { /* this tab only */ }
                                setToken(typed.trim());
                            } catch {
                                setError(t.error.replace('{error}', 'bad token'));
                            }
                        }}
                    />
                </div>
            </Card>
        </div>
    );
}

// The fields of the framework read the route and a data provider: the console has one page and keeps no data.
createRoot(document.getElementById('root')!).render(
    <MemoryRouter>
        <DataProvider registry={{ default: new MockDataProvider() }} defaultKey="default">
            <I18nProvider>
                <Console />
            </I18nProvider>
        </DataProvider>
    </MemoryRouter>,
);
