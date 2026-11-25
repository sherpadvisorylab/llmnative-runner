import React, { useCallback, useEffect, useState } from 'react';
import { ActionButton, Alert, Badge, Card, Form, LoadingButton, ModalYesNo, Password, String as TextInput } from '@llmnative/react';
import { RunnerError, type RunnerAccount, type RunnerClient } from '../client';
import { fill, textsFor, type RunnerUiTexts } from './texts';

// The accounts of a scope on the runner: the subscriptions of the person ("My subscriptions"), or of a tenant in the
// console. Claude is connected with the sign-in of Anthropic (a link, then the code it shows); OpenCode Go with a key.
// Tokens never reach the browser: the runner keeps them.

export type RunnerAccountsProps = {
    /** A client for this scope: through the backend of the host for a person, with the admin token in the console. */
    client: RunnerClient;
    scope: 'user' | 'tenant';
    locale?: string;
    texts?: Partial<RunnerUiTexts>;
    /** Called after an account was added or removed (the host refreshes its list of models). */
    onChange?: (accounts: RunnerAccount[]) => void;
};

const PROVIDER_NAMES: Record<string, string> = { 'claude-code': 'Claude Code', 'opencode-go': 'OpenCode Go', opencode: 'OpenCode Zen' };

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function RunnerAccounts({ client, scope, locale, texts, onChange }: RunnerAccountsProps) {
    const t = textsFor(locale, texts);
    const [accounts, setAccounts] = useState<RunnerAccount[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [adding, setAdding] = useState<'claude' | 'opencode' | null>(null);
    const [removing, setRemoving] = useState<RunnerAccount | null>(null);

    const load = useCallback(async () => {
        try {
            const { accounts: list } = await client.accounts.list();
            setAccounts(list);
            setError(null);
            return list;
        } catch (failure) {
            setError(failure instanceof RunnerError ? failure.code : String(failure));
            setAccounts([]);
            return [];
        }
    }, [client]);

    useEffect(() => {
        void load();
    }, [load]);

    const changed = async () => {
        setAdding(null);
        const list = await load();
        onChange?.(list);
    };

    return (
        <Card title={scope === 'user' ? t.accountsTitleUser : t.accountsTitleTenant} loading={accounts === null} loaderMinHeight={120}>
            <div className="flex flex-col gap-3">
                <p className="text-sm text-muted-foreground">{scope === 'user' ? t.accountsIntroUser : t.accountsIntroTenant}</p>
                {error && <Alert variant="danger">{fill(t.error, { error })}</Alert>}
                {accounts?.length === 0 && !error && <p className="text-sm text-muted-foreground">{t.accountsEmpty}</p>}
                {accounts?.map((account) => (
                    <div key={`${account.provider}/${account.id}`} className="flex flex-wrap items-center gap-2 rounded-md border border-border p-3">
                        <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                                <span className="font-medium">{account.label ?? PROVIDER_NAMES[account.provider] ?? account.provider}</span>
                                <Badge variant="secondary">{PROVIDER_NAMES[account.provider] ?? account.provider}</Badge>
                                {account.noCreditUntil && <Badge variant="warning">{fill(t.accountsNoCredit, { at: when(account.noCreditUntil) })}</Badge>}
                            </div>
                            <p className="text-xs text-muted-foreground">{fill(t.accountsConnected, { at: when(account.at) })}</p>
                        </div>
                        <ActionButton icon="unlink" label={t.accountsRemove} variant="outline-danger" onClick={() => setRemoving(account)} />
                    </div>
                ))}
                {adding === 'claude' && <ClaudeSignIn client={client} t={t} onDone={changed} onCancel={() => setAdding(null)} />}
                {adding === 'opencode' && <OpenCodeKey client={client} t={t} onDone={changed} onCancel={() => setAdding(null)} />}
                {!adding && (
                    <div className="flex flex-wrap gap-2">
                        <ActionButton icon="plus" label={t.claudeConnect} variant="primary" onClick={() => setAdding('claude')} />
                        <ActionButton icon="plus" label={t.opencodeConnect} variant="outline-secondary" onClick={() => setAdding('opencode')} />
                    </div>
                )}
                <p className="text-xs text-muted-foreground">{t.termsNote}</p>
            </div>
            {removing && (
                <ModalYesNo
                    title={t.accountsRemove}
                    danger
                    onClose={() => setRemoving(null)}
                    onYes={async () => {
                        await client.accounts.remove(removing.provider, removing.id).catch(() => false);
                        setRemoving(null);
                        await changed();
                        return true;
                    }}
                >
                    {fill(t.accountsRemoveConfirm, { name: removing.label ?? PROVIDER_NAMES[removing.provider] ?? removing.provider })}
                </ModalYesNo>
            )}
        </Card>
    );
}

function ClaudeSignIn({ client, t, onDone, onCancel }: { client: RunnerClient; t: RunnerUiTexts; onDone: () => void; onCancel: () => void }) {
    const [url, setUrl] = useState<string | null>(null);
    const [code, setCode] = useState('');
    const [label, setLabel] = useState('');
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let gone = false;
        client.accounts.startClaudeLogin().then(({ url: link }) => !gone && setUrl(link)).catch(() => !gone && setError(t.claudeNoLink));
        return () => {
            gone = true;
        };
    }, [client, t]);

    return (
        <div className="flex flex-col gap-3 rounded-md border border-border p-3">
            {error && <Alert variant="danger">{error}</Alert>}
            <p className="text-sm">{t.claudeStep1}</p>
            <div>
                <ActionButton icon="external-link" label={t.claudeOpen} variant="primary" disabled={!url} onClick={() => url && window.open(url, '_blank', 'noopener,noreferrer')} />
            </div>
            <p className="text-sm">{t.claudeStep2}</p>
            <Form appearance="empty" showNotice={false} onSubmit={() => false}>
                <TextInput name="code" label={t.claudeCode} autoComplete="off" onChange={({ value }) => setCode(String(value ?? ''))} />
                <TextInput name="label" label={t.claudeLabel} placeholder={t.claudeLabelPlaceholder} onChange={({ value }) => setLabel(String(value ?? ''))} />
            </Form>
            <div className="flex gap-2">
                <LoadingButton
                    label={t.claudeFinish}
                    variant="primary"
                    disabled={!url || !code.trim()}
                    onClick={async () => {
                        try {
                            await client.accounts.finishClaudeLogin(code.trim(), label.trim() || undefined);
                            onDone();
                        } catch (failure) {
                            setError(failure instanceof RunnerError && failure.code === 'refused' ? t.claudeRefused : fill(t.error, { error: failure instanceof RunnerError ? failure.code : String(failure) }));
                        }
                    }}
                />
                <ActionButton label={t.cancel} variant="outline-secondary" onClick={onCancel} />
            </div>
        </div>
    );
}

function OpenCodeKey({ client, t, onDone, onCancel }: { client: RunnerClient; t: RunnerUiTexts; onDone: () => void; onCancel: () => void }) {
    const [key, setKey] = useState('');
    const [label, setLabel] = useState('');
    const [error, setError] = useState<string | null>(null);
    return (
        <div className="flex flex-col gap-3 rounded-md border border-border p-3">
            {error && <Alert variant="danger">{error}</Alert>}
            <Form appearance="empty" showNotice={false} onSubmit={() => false}>
                <Password name="key" label={t.opencodeKey} autoComplete="off" onChange={({ value }) => setKey(String(value ?? ''))} />
                <TextInput name="label" label={t.claudeLabel} onChange={({ value }) => setLabel(String(value ?? ''))} />
            </Form>
            <div className="flex gap-2">
                <LoadingButton
                    label={t.opencodeAdd}
                    variant="primary"
                    disabled={!key.trim()}
                    onClick={async () => {
                        try {
                            await client.accounts.addKey('opencode-go', key.trim(), label.trim() || undefined);
                            onDone();
                        } catch (failure) {
                            setError(fill(t.error, { error: failure instanceof RunnerError ? failure.code : String(failure) }));
                        }
                    }}
                />
                <ActionButton label={t.cancel} variant="outline-secondary" onClick={onCancel} />
            </div>
        </div>
    );
}
