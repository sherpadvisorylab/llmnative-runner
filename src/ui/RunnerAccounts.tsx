import React, { useCallback, useEffect, useState } from 'react';
import { ActionButton, Alert, Badge, Card, ConnectionBoard, ConnectionList, Form, LoadingButton, Modal, Password, Select, String as TextInput } from '@llmnative/react';
import { RUNNER_KEY_PROVIDERS, RunnerError, type RunnerAccount, type RunnerClient, type RunnerProvider } from '../client';
import { fill, textsFor, type RunnerUiTexts } from './texts';

// The accounts of a scope on the runner: the subscriptions of the person ("My subscriptions"), or of a tenant. As the
// connections of the framework (CR-157 of @llmnative/react): a box per provider (Claude Code, OpenCode Go and, for a
// tenant, the providers by use opencode runs on the runner) with how many accounts it has; its modal lists them in the
// order they are used (when one runs out of credit the next takes the turn), with their state and their name (the
// email of the account), and adds one its own way: the sign-in of Anthropic (a link, then the code it shows; or a
// token of `claude setup-token`) for Claude, an API key for the others.
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
    const [accounts, setAccounts] = useState<RunnerAccount[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    // The provider whose modal is open, and whether a modal of the list (rename, revoke) is over it.
    const [open, setOpenState] = useState<RunnerProvider | null>(null);
    const [stacked, setStacked] = useState(false);
    const setOpen = (provider: RunnerProvider | null) => {
        setOpenState(provider);
        onStack?.(provider !== null);
    };

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
    const of = (provider: RunnerProvider) => (accounts ?? []).filter((account) => account.provider === provider);
    const describe = (provider: RunnerProvider) => (provider === 'claude-code' ? t.boxClaudeCode : provider === 'opencode-go' ? t.boxOpencodeGo : fill(t.boxByUse, { provider: nameOf(provider) }));

    return (
        <Card title={scope === 'user' ? t.accountsTitleUser : t.accountsTitleTenant} loading={accounts === null} loaderMinHeight={120}>
            <div className="flex flex-col gap-4">
                <p className="text-sm text-muted-foreground">{scope === 'user' ? t.accountsIntroUser : t.accountsIntroTenant}</p>
                {error && <Alert variant="danger">{fill(t.error, { error })}</Alert>}
                {accounts && (
                    <ConnectionBoard
                        items={offered.map((provider) => {
                            const list = of(provider);
                            const out = list.filter((account) => account.noCreditUntil);
                            return {
                                id: provider,
                                label: nameOf(provider),
                                description: describe(provider),
                                icon: provider === 'claude-code' ? 'user' : 'key-round',
                                group: SUBSCRIPTIONS.includes(provider) ? 'subscription' as const : 'usage' as const,
                                count: list.length,
                                // Out of credit when all its accounts are: until the first comes back.
                                status: list.length > 0 && out.length === list.length
                                    ? <Badge variant="warning">{fill(t.accountsNoCredit, { at: timeOf(out.map((account) => account.noCreditUntil!).sort()[0]) })}</Badge>
                                    : undefined,
                            };
                        })}
                        titles={{ subscription: t.groupSubscriptions, usage: t.groupUsage }}
                        onOpen={(id) => setOpen(id as RunnerProvider)}
                    />
                )}
                <p className="text-xs text-muted-foreground">{t.termsNote}</p>
            </div>
            {open && accounts && (
                <Modal title={nameOf(open)} position="right" size="lg" stackedBehind={stacked} onClose={() => setOpen(null)} footer={<ActionButton variant="link" label={t.close} onClick={() => setOpen(null)} />}>
                    <ProviderAccounts
                        client={client}
                        t={t}
                        provider={open}
                        accounts={of(open)}
                        onChanged={changed}
                        onStack={setStacked}
                        extra={renderProvider?.(open, of(open))}
                    />
                </Modal>
            )}
        </Card>
    );
}

/** The accounts of one provider, in the order they are used, as `ConnectionList`; added with its own way in. */
function ProviderAccounts({ client, t, provider, accounts, onChanged, onStack, extra }: {
    client: RunnerClient;
    t: RunnerUiTexts;
    provider: RunnerProvider;
    accounts: RunnerAccount[];
    onChanged: (list?: RunnerAccount[]) => Promise<void>;
    onStack: (open: boolean) => void;
    extra?: React.ReactNode;
}) {
    const [error, setError] = useState<string | null>(null);
    const failed = (failure: unknown) => setError(fill(t.error, { error: failure instanceof RunnerError ? failure.code : String(failure) }));
    const accountOf = (id: string) => accounts.find((account) => account.id === id)!;
    return (
        <div className="flex flex-col gap-5">
            <p className="text-sm text-muted-foreground">{provider === 'claude-code' ? t.boxClaudeCode : provider === 'opencode-go' ? t.boxOpencodeGo : fill(t.boxByUse, { provider: nameOf(provider) })}</p>
            {error && <Alert variant="danger">{error}</Alert>}
            <ConnectionList
                items={accounts.map((account) => ({
                    id: account.id,
                    label: account.label,
                    icon: account.provider === 'claude-code' ? 'user' : 'key-round',
                    meta: fill(t.accountsAddedOn, { date: dateOf(account.at) }),
                    exhaustedUntil: account.noCreditUntil,
                }))}
                title={fill(t.accountsSection, { name: nameOf(provider), count: String(accounts.length) })}
                emptyText={t.accountsEmpty}
                unnamed={t.accountsUnnamed}
                orderHint={t.accountsOrderHint}
                addLabel={provider === 'claude-code' ? t.accountsAdd : t.keyConnect}
                onStack={onStack}
                onReorder={(ids) => client.accounts.order(provider, ids).then((list) => onChanged(list), failed)}
                onRename={async (id, label) => { await onChanged(await client.accounts.rename(provider, id, label)); }}
                onRemove={async (id) => {
                    await client.accounts.remove(accountOf(id).provider, id).catch(failed);
                    await onChanged();
                }}
                renderAdd={(done) => (provider === 'claude-code'
                    ? <ClaudeSignIn client={client} t={t} others={accounts.length} onDone={async () => { done(); await onChanged(); }} onCancel={done} />
                    : <ProviderKey client={client} t={t} providers={[provider as Exclude<RunnerProvider, 'claude-code'>]} onDone={async () => { done(); await onChanged(); }} onCancel={done} />)}
            />
            {extra}
        </div>
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
