import React, { useCallback, useEffect, useState } from 'react';
import { ActionButton, Alert, Badge, Card, Form, LoadingButton, Modal, ModalYesNo, Password, Select, SortableList, String as TextInput } from '@llmnative/react';
import { RUNNER_KEY_PROVIDERS, RunnerError, type RunnerAccount, type RunnerClient, type RunnerProvider } from '../client';
import { fill, textsFor, type RunnerUiTexts } from './texts';

// The accounts of a scope on the runner: the subscriptions of the person ("My subscriptions"), or of a tenant. One
// section per subscription (Claude Code, OpenCode Go), each with several accounts in the order they are used (when
// one runs out of credit the next takes the turn), their state, their name (the email of the account), and the way
// to add one: the sign-in of Anthropic (a link, then the code it shows; or a token of `claude setup-token`) for
// Claude, a key for OpenCode Go. For a tenant, the API keys of the providers by use opencode runs on the runner too.
// Tokens never reach the browser: the runner keeps them.

export type RunnerAccountsProps = {
    /** A client for this scope: through the backend of the host for a person, with the admin token in the console. */
    client: RunnerClient;
    scope: 'user' | 'tenant';
    locale?: string;
    texts?: Partial<RunnerUiTexts>;
    /** Called after an account was added, removed, renamed or moved (the host refreshes its list of models). */
    onChange?: (accounts: RunnerAccount[]) => void;
    /** What can be added here: default the subscriptions and, for a tenant, the API keys of the providers by use too. */
    providers?: RunnerProvider[];
    /** What the host shows under the accounts of a subscription, e.g. the model its chats start with. */
    renderProvider?: (provider: RunnerProvider, accounts: RunnerAccount[]) => React.ReactNode;
    /** Called when a modal of its own opens over the page (true) and closes: the host dims the one below. */
    onStack?: (open: boolean) => void;
};

const PROVIDER_NAMES: Record<string, string> = {
    'claude-code': 'Claude Code', 'opencode-go': 'OpenCode Go', opencode: 'OpenCode Zen',
    anthropic: 'Anthropic', openai: 'OpenAI', gemini: 'Gemini', mistral: 'Mistral', deepseek: 'DeepSeek', openrouter: 'OpenRouter',
};
/** The subscriptions, each a section of its own. */
const SUBSCRIPTIONS: RunnerProvider[] = ['claude-code', 'opencode-go'];
const nameOf = (provider: string) => PROVIDER_NAMES[provider] ?? provider;

const dateOf = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });
const timeOf = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });

export function RunnerAccounts({ client, scope, locale, texts, onChange, providers, renderProvider, onStack }: RunnerAccountsProps) {
    const t = textsFor(locale, texts);
    const offered = providers ?? (scope === 'tenant' ? [...SUBSCRIPTIONS, 'opencode' as const, ...RUNNER_KEY_PROVIDERS] : SUBSCRIPTIONS);
    const subscriptions = SUBSCRIPTIONS.filter((id) => offered.includes(id));
    const byUse = offered.filter((id): id is Exclude<RunnerProvider, 'claude-code'> => !SUBSCRIPTIONS.includes(id));
    const [accounts, setAccounts] = useState<RunnerAccount[] | null>(null);
    const [error, setError] = useState<string | null>(null);

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

    const changed = async (list?: RunnerAccount[]) => {
        const next = list ?? await load();
        if (list) setAccounts(list);
        onChange?.(next);
    };

    return (
        <Card title={scope === 'user' ? t.accountsTitleUser : t.accountsTitleTenant} loading={accounts === null} loaderMinHeight={120}>
            <div className="flex flex-col gap-6">
                <p className="text-sm text-muted-foreground">{scope === 'user' ? t.accountsIntroUser : t.accountsIntroTenant}</p>
                {error && <Alert variant="danger">{fill(t.error, { error })}</Alert>}
                {accounts && subscriptions.map((provider) => (
                    <ProviderSection
                        key={provider}
                        client={client}
                        t={t}
                        provider={provider}
                        accounts={accounts.filter((account) => account.provider === provider)}
                        onChanged={changed}
                        onStack={onStack}
                        extra={renderProvider?.(provider, accounts.filter((account) => account.provider === provider))}
                    />
                ))}
                {accounts && byUse.length > 0 && (
                    <ProviderSection
                        client={client}
                        t={t}
                        provider={byUse}
                        accounts={accounts.filter((account) => byUse.includes(account.provider as Exclude<RunnerProvider, 'claude-code'>))}
                        onChanged={changed}
                        onStack={onStack}
                    />
                )}
                <p className="text-xs text-muted-foreground">{t.termsNote}</p>
            </div>
        </Card>
    );
}

/** The accounts of one subscription (or of the providers by use, `provider` a list), in their order. */
function ProviderSection({ client, t, provider, accounts, onChanged, onStack, extra }: {
    client: RunnerClient;
    t: RunnerUiTexts;
    provider: RunnerProvider | Array<Exclude<RunnerProvider, 'claude-code'>>;
    accounts: RunnerAccount[];
    onChanged: (list?: RunnerAccount[]) => Promise<void>;
    onStack?: (open: boolean) => void;
    extra?: React.ReactNode;
}) {
    const single = typeof provider === 'string' ? provider : undefined;
    const title = single ? fill(t.accountsSection, { name: nameOf(single), count: String(accounts.length) }) : fill(t.accountsByUse, { count: String(accounts.length) });
    const [adding, setAdding] = useState(false);
    const [renaming, setRenamingState] = useState<RunnerAccount | null>(null);
    const setRenaming = (account: RunnerAccount | null) => {
        setRenamingState(account);
        onStack?.(account !== null);
    };
    const [removing, setRemoving] = useState<RunnerAccount | null>(null);
    const [error, setError] = useState<string | null>(null);
    const label = (account: RunnerAccount, index: number) => account.label || fill(t.accountsUnnamed, { n: String(index + 1) });
    const failed = (failure: unknown) => setError(fill(t.error, { error: failure instanceof RunnerError ? failure.code : String(failure) }));

    return (
        <section className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <h5 className="text-sm font-semibold">{title}</h5>
                {!adding && (
                    <ActionButton
                        icon="plus"
                        variant="outline-primary"
                        label={single ? t.accountsAdd : t.keyConnect}
                        onClick={() => { setError(null); setAdding(true); }}
                    />
                )}
            </div>
            {error && <Alert variant="danger">{error}</Alert>}
            <SortableList
                items={accounts}
                getKey={(account) => `${account.provider}/${account.id}`}
                label={title}
                numbered={!!single && accounts.length > 1}
                disabled={!single}
                emptyState={<p className="text-sm text-muted-foreground">{t.accountsEmpty}</p>}
                onReorder={(next) => {
                    if (!single) return;
                    client.accounts.order(single, next.map((account) => account.id)).then((list) => onChanged(list), failed);
                }}
                renderItem={(account, index) => ({
                    icon: account.provider === 'claude-code' ? 'user' : 'key',
                    title: label(account, index),
                    meta: [single ? undefined : nameOf(account.provider), fill(t.accountsAddedOn, { date: dateOf(account.at) })].filter(Boolean).join(' · '),
                    badge: account.noCreditUntil
                        ? <Badge variant="warning">{fill(t.accountsNoCredit, { at: timeOf(account.noCreditUntil) })}</Badge>
                        : <Badge variant="success">{t.accountsAvailable}</Badge>,
                    trailing: (
                        <div className="flex items-center gap-1">
                            <ActionButton icon="pencil" variant="link" ariaLabel={fill(t.accountsRenameAria, { name: label(account, index) })} onClick={() => setRenaming(account)} />
                            <ActionButton icon="trash-2" variant="link" ariaLabel={fill(t.accountsRemoveAria, { name: label(account, index) })} onClick={() => setRemoving(account)} />
                        </div>
                    ),
                })}
            />
            {single && accounts.length > 1 && <p className="text-xs text-muted-foreground">{t.accountsOrderHint}</p>}
            {adding && (single === 'claude-code'
                ? <ClaudeSignIn client={client} t={t} others={accounts.length} onDone={async () => { setAdding(false); await onChanged(); }} onCancel={() => setAdding(false)} />
                : <ProviderKey client={client} t={t} providers={single ? [single as Exclude<RunnerProvider, 'claude-code'>] : provider as Array<Exclude<RunnerProvider, 'claude-code'>>} onDone={async () => { setAdding(false); await onChanged(); }} onCancel={() => setAdding(false)} />)}
            {extra}
            {renaming && <RenameAccount client={client} t={t} account={renaming} onClose={() => setRenaming(null)} onDone={async (list) => { setRenaming(null); await onChanged(list); }} />}
            {removing && (
                <ModalYesNo
                    title={t.accountsRemove}
                    danger
                    onClose={() => setRemoving(null)}
                    onYes={async () => {
                        await client.accounts.remove(removing.provider, removing.id).catch(() => false);
                        setRemoving(null);
                        await onChanged();
                        return true;
                    }}
                >
                    {fill(t.accountsRemoveConfirm, { name: removing.label ?? nameOf(removing.provider) })}
                </ModalYesNo>
            )}
        </section>
    );
}

function RenameAccount({ client, t, account, onClose, onDone }: { client: RunnerClient; t: RunnerUiTexts; account: RunnerAccount; onClose: () => void; onDone: (list: RunnerAccount[]) => Promise<void> }) {
    const [name, setName] = useState(account.label ?? '');
    const [error, setError] = useState<string | null>(null);
    return (
        <Modal
            title={t.accountsRenameTitle}
            position="right"
            size="sm"
            onClose={onClose}
            footer={(
                <>
                    <ActionButton variant="link" label={t.cancel} onClick={onClose} />
                    <LoadingButton
                        variant="primary"
                        label={t.accountsSave}
                        onClick={async () => {
                            try {
                                await onDone(await client.accounts.rename(account.provider, account.id, name.trim()));
                            } catch (failure) {
                                setError(fill(t.error, { error: failure instanceof RunnerError ? failure.code : String(failure) }));
                            }
                        }}
                    />
                </>
            )}
        >
            {error && <Alert variant="danger">{error}</Alert>}
            <Form appearance="empty" showNotice={false} defaultValues={{ label: account.label ?? '' }} onSubmit={() => false}>
                <TextInput name="label" label={t.accountsName} placeholder={t.claudeLabelPlaceholder} onChange={({ value }) => setName(String(value ?? ''))} />
            </Form>
        </Modal>
    );
}

function ClaudeSignIn({ client, t, others, onDone, onCancel }: { client: RunnerClient; t: RunnerUiTexts; others: number; onDone: () => void; onCancel: () => void }) {
    const [manual, setManual] = useState(false);
    const [url, setUrl] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);
    const [code, setCode] = useState('');
    const [token, setToken] = useState('');
    const [label, setLabel] = useState('');
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (manual) return undefined;
        let gone = false;
        client.accounts.startClaudeLogin().then(({ url: link }) => !gone && setUrl(link)).catch(() => !gone && setError(t.claudeNoLink));
        return () => {
            gone = true;
        };
    }, [client, t, manual]);

    const finish = async () => {
        setError(null);
        try {
            if (manual) await client.accounts.addClaudeToken(token.trim(), label.trim() || undefined);
            else await client.accounts.finishClaudeLogin(code.trim(), label.trim() || undefined);
            onDone();
        } catch (failure) {
            const refused = failure instanceof RunnerError && failure.code === 'refused';
            setError(refused ? t.claudeRefused : fill(t.error, { error: failure instanceof RunnerError ? failure.code : String(failure) }));
            // A refused code ends the sign-in on the runner: a new one gives a new link.
            if (refused && !manual) {
                setUrl(null);
                setCopied(false);
                client.accounts.startClaudeLogin().then(({ url: link }) => setUrl(link)).catch(() => setError(t.claudeNoLink));
            }
        }
    };

    return (
        <Card headerClassName="px-4 py-3" bodyClassName="flex flex-col gap-3" header={<span className="text-sm font-medium">{t.claudeConnect}</span>}>
            {others > 0 && <Alert variant="warning">{t.claudeMultiWarning}</Alert>}
            {error && <Alert variant="danger">{error}</Alert>}
            {!manual ? (
                <>
                    <p className="text-sm">{t.claudeStep1}</p>
                    <div className="grid grid-cols-2 gap-2">
                        <ActionButton icon="external-link" variant="outline-primary" className="w-full justify-center whitespace-nowrap" label={t.claudeOpen} disabled={!url} onClick={() => url && window.open(url, '_blank', 'noopener,noreferrer')} />
                        <ActionButton
                            icon={copied ? 'check' : 'copy'}
                            variant="outline-secondary"
                            className="w-full justify-center whitespace-nowrap"
                            label={copied ? t.claudeCopied : t.claudeCopy}
                            disabled={!url}
                            onClick={() => { if (url) void navigator.clipboard?.writeText(url).then(() => setCopied(true), () => setCopied(false)); }}
                        />
                    </div>
                    <p className="text-sm">{t.claudeStep2}</p>
                </>
            ) : (
                <p className="text-sm">{t.claudeTokenIntro}</p>
            )}
            <Form appearance="empty" showNotice={false} onSubmit={() => false}>
                {manual
                    ? <Password name="token" label={t.claudeToken} placeholder="sk-ant-oat01-…" autoComplete="off" onChange={({ value }) => setToken(String(value ?? ''))} />
                    : <TextInput name="code" label={t.claudeCode} autoComplete="off" onChange={({ value }) => setCode(String(value ?? ''))} />}
                <TextInput name="label" label={t.accountsName} placeholder={t.claudeLabelPlaceholder} onChange={({ value }) => setLabel(String(value ?? ''))} />
            </Form>
            <ActionButton
                variant="link"
                className="h-auto self-start p-0 text-xs"
                label={manual ? t.claudeBackToLogin : t.claudeManual}
                onClick={() => { setManual(!manual); setError(null); }}
            />
            <div className="flex flex-wrap justify-end gap-2">
                <ActionButton label={t.cancel} variant="link" onClick={onCancel} />
                <LoadingButton label={t.claudeFinish} variant="primary" disabled={manual ? !token.trim() : !url || !code.trim()} onClick={finish} />
            </div>
        </Card>
    );
}

function ProviderKey({ client, t, providers, onDone, onCancel }: { client: RunnerClient; t: RunnerUiTexts; providers: Array<Exclude<RunnerProvider, 'claude-code'>>; onDone: () => void; onCancel: () => void }) {
    const [provider, setProvider] = useState(providers[0]);
    const [key, setKey] = useState('');
    const [label, setLabel] = useState('');
    const [error, setError] = useState<string | null>(null);
    return (
        <Card headerClassName="px-4 py-3" bodyClassName="flex flex-col gap-3" header={<span className="text-sm font-medium">{providers.length === 1 ? fill(t.keyAddOf, { provider: nameOf(providers[0]) }) : t.keyConnect}</span>}>
            {error && <Alert variant="danger">{error}</Alert>}
            <Form appearance="empty" showNotice={false} onSubmit={() => false}>
                {providers.length > 1 && (
                    <Select name="provider" label={t.keyProvider} defaultValue={provider} options={providers.map((id) => ({ label: nameOf(id), value: id }))} onChange={({ value }) => setProvider(String(value ?? providers[0]) as typeof provider)} />
                )}
                <Password name="key" label={fill(t.keyLabel, { provider: nameOf(provider) })} autoComplete="off" onChange={({ value }) => setKey(String(value ?? ''))} />
                <TextInput name="label" label={t.accountsName} onChange={({ value }) => setLabel(String(value ?? ''))} />
            </Form>
            <div className="flex flex-wrap justify-end gap-2">
                <ActionButton label={t.cancel} variant="link" onClick={onCancel} />
                <LoadingButton
                    label={t.opencodeAdd}
                    variant="primary"
                    disabled={!key.trim()}
                    onClick={async () => {
                        try {
                            await client.accounts.addKey(provider, key.trim(), label.trim() || undefined);
                            onDone();
                        } catch (failure) {
                            setError(fill(t.error, { error: failure instanceof RunnerError ? failure.code : String(failure) }));
                        }
                    }}
                />
            </div>
        </Card>
    );
}
