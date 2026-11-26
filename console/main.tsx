import React, { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Card, DataProvider, Form, I18nProvider, LoadingButton, MockDataProvider, Password, Switch } from '@llmnative/react';
import { MemoryRouter } from 'react-router-dom';
import '@llmnative/react/dist/index.css';
import { RunnerClient } from '../src/client';
import { RunnerConsole } from '../src/ui/RunnerConsole';
import { textsFor } from '../src/ui/texts';

// The console the runner serves at /console: signed in with the admin token of the machine, kept for this tab or,
// when the person asks, on this browser (a platform sends people here to approve its request: `?approve=<code>`).

const STORAGE = 'llmnative-runner-admin';
const locale = navigator.language;
const t = textsFor(locale);

const approve = new URLSearchParams(window.location.search).get('approve') ?? undefined;

const read = () => {
    try {
        return sessionStorage.getItem(STORAGE) ?? localStorage.getItem(STORAGE) ?? '';
    } catch {
        return '';
    }
};

const keep = (token: string, remember: boolean) => {
    try {
        sessionStorage.setItem(STORAGE, token);
        if (remember) localStorage.setItem(STORAGE, token);
    } catch {
        // Nothing kept: asked again next time.
    }
};

function Console() {
    const [token, setToken] = useState(read);
    const [typed, setTyped] = useState('');
    const [error, setError] = useState('');
    const [remember, setRemember] = useState(true);
    const client = useMemo(() => (token ? new RunnerClient({ url: window.location.origin, key: token }) : null), [token]);
    const signOut = () => {
        try { sessionStorage.removeItem(STORAGE); localStorage.removeItem(STORAGE); } catch { /* nothing kept */ }
        setToken('');
    };
    if (client) return <RunnerConsole client={client} locale={locale} onSignOut={signOut} {...(approve ? { approve } : {})} />;
    return (
        <div className="mx-auto max-w-md p-4 pt-16">
            <Card title={t.consoleTitle}>
                <Form appearance="empty" showNotice={false} onSubmit={() => false} defaultValues={{ remember: 'true' }}>
                    <Password name="token" label={t.consoleToken} feedback={t.consoleTokenHint} autoComplete="off" onChange={({ value }) => setTyped(String(value ?? ''))} />
                    <Switch name="remember" label={t.consoleRemember} valueChecked="true" onChange={({ value }) => setRemember(!!value)} />
                </Form>
                {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
                <div className="mt-3">
                    <LoadingButton
                        label={t.consoleSignIn}
                        variant="primary"
                        onClick={async () => {
                            // A password manager fills the field without typing: read it as it is.
                            const value = (typed || document.querySelector<HTMLInputElement>('input[name="token"]')?.value || '').trim();
                            if (!value) return setError(t.error.replace('{error}', 'bad token'));
                            const candidate = new RunnerClient({ url: window.location.origin, key: value });
                            try {
                                await candidate.platform.status();
                                keep(value, remember);
                                setToken(value);
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
