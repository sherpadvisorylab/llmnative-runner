import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActionButton, Alert, Badge, Card, Code, DescriptionList, Form, LoadingButton, ModalYesNo, String as TextInput } from '@llmnative/react';
import { RunnerError, type RunnerClient, type RunnerKey, type RunnerPairingRequestView, type RunnerStatus, type RunnerTenant } from '../client';
import { RunnerAccounts } from './RunnerAccounts';
import { fill, textsFor, type RunnerUiTexts } from './texts';

// The console of one runner, with its admin token: its state, a pairing code to connect a platform, its tenants with
// their keys and accounts. What a runner without any platform needs to be used on its own.

/** `approve`: the code of the request a platform sent the person here for (`/console/?approve=ABCD-EFGH`). */
export type RunnerConsoleProps = { client: RunnerClient; locale?: string; texts?: Partial<RunnerUiTexts>; onSignOut?: () => void; approve?: string };

const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });

export function RunnerConsole({ client, locale, texts, onSignOut, approve }: RunnerConsoleProps) {
    const t = textsFor(locale, texts);
    const [status, setStatus] = useState<RunnerStatus | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [pairing, setPairing] = useState<{ code: string; expiresAt: string } | null>(null);
    const [newTenant, setNewTenant] = useState({ id: '', name: '' });
    const [shownKey, setShownKey] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            setStatus(await client.platform.status());
            setError(null);
        } catch (failure) {
            setError(fill(t.error, { error: failure instanceof RunnerError ? failure.code : String(failure) }));
        }
    }, [client, t]);

    useEffect(() => {
        void load();
    }, [load]);

    return (
        <div className="mx-auto flex max-w-4xl flex-col gap-4 p-4">
            <div className="flex items-center gap-2">
                <h1 className="flex-1 text-xl font-semibold">{t.consoleTitle}</h1>
                {onSignOut && <ActionButton icon="log-out" label={t.consoleSignOut} variant="outline-secondary" onClick={onSignOut} />}
            </div>
            {error && <Alert variant="danger">{error}</Alert>}
            <PairingRequests client={client} t={t} approve={approve} onAnswered={load} />
            <Card title={t.consoleStatus} loading={!status && !error} loaderMinHeight={100}>
                {status && (
                    <DescriptionList items={[
                        { label: 'Version', value: status.version },
                        { label: 'URL', value: status.url },
                        { label: 'Chats', value: `${status.load.chats} / ${status.load.maxChats}` },
                        { label: 'Machine', value: fill(t.consoleMachine, { memory: gb(status.machine.availableBytes), total: gb(status.machine.totalBytes), cpus: status.machine.cpus }) },
                        { label: 'Agent', value: status.agentImage },
                    ]} />
                )}
            </Card>
            <Card title={t.consolePairing}>
                <div className="flex flex-col gap-2">
                    <p className="text-sm text-muted-foreground">{t.consolePairingHint}</p>
                    {pairing && <Code showCopy>{pairing.code}</Code>}
                    {pairing && <p className="text-xs text-muted-foreground">{fill(t.consoleCode, { code: pairing.code, at: when(pairing.expiresAt) })}</p>}
                    <div>
                        <LoadingButton label={t.consoleNewCode} variant="outline-primary" onClick={async () => setPairing(await client.createPairing())} />
                    </div>
                </div>
            </Card>
            <Card title={t.consoleTenants}>
                <div className="flex flex-col gap-3">
                    {shownKey && <Alert variant="warning" onClose={() => setShownKey(null)}><span className="break-all">{fill(t.consoleKeyShown, { key: shownKey })}</span></Alert>}
                    {status?.tenants.map((tenant) => <TenantRow key={tenant.id} client={client} tenant={tenant} t={t} locale={locale} onKey={setShownKey} onChange={load} />)}
                    <Form appearance="empty" showNotice={false} onSubmit={() => false}>
                        <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                            <TextInput name="tenantId" label={t.consoleTenantId} placeholder="acme" onChange={({ value }) => setNewTenant((all) => ({ ...all, id: String(value ?? '') }))} />
                            <TextInput name="tenantName" label={t.consoleTenantName} placeholder="Acme" onChange={({ value }) => setNewTenant((all) => ({ ...all, name: String(value ?? '') }))} />
                            <LoadingButton
                                label={t.consoleCreate}
                                variant="primary"
                                disabled={!/^[a-z0-9][a-z0-9-]{0,62}$/.test(newTenant.id)}
                                onClick={async () => {
                                    try {
                                        const made = await client.platform.createTenant(newTenant.id, { name: newTenant.name || undefined });
                                        if (made.key) setShownKey(made.key);
                                        await load();
                                    } catch (failure) {
                                        setError(fill(t.error, { error: failure instanceof RunnerError ? failure.code : String(failure) }));
                                    }
                                }}
                            />
                        </div>
                    </Form>
                </div>
            </Card>
        </div>
    );
}

function TenantRow({ client, tenant, t, locale, onKey, onChange }: { client: RunnerClient; tenant: RunnerTenant; t: RunnerUiTexts; locale?: string; onKey: (key: string) => void; onChange: () => Promise<void> }) {
    const [open, setOpen] = useState(false);
    const [keys, setKeys] = useState<RunnerKey[] | null>(null);
    const [removing, setRemoving] = useState(false);
    const scoped = useMemo(() => client.as({ tenant: tenant.id }), [client, tenant.id]);
    const loadKeys = useCallback(async () => setKeys(await client.platform.keys(tenant.id)), [client, tenant.id]);
    useEffect(() => {
        if (open) void loadKeys();
    }, [open, loadKeys]);
    return (
        <div className="rounded-md border border-border p-3">
            <div className="flex flex-wrap items-center gap-2">
                <button type="button" className="flex-1 text-left font-medium" onClick={() => setOpen((was) => !was)}>{tenant.name} <span className="text-xs text-muted-foreground">({tenant.id})</span></button>
                {tenant.usersWithAccounts !== undefined && <Badge variant="light">{tenant.usersWithAccounts} 👤</Badge>}
                <ActionButton icon="trash" label={t.consoleRemoveTenant} variant="outline-danger" onClick={() => setRemoving(true)} />
            </div>
            {open && (
                <div className="mt-3 flex flex-col gap-3">
                    <h4 className="text-sm font-semibold">{t.consoleKeys}</h4>
                    {keys?.map((key) => (
                        <div key={key.id} className="flex flex-wrap items-center gap-2 text-sm">
                            <span className="flex-1">{key.name}</span>
                            {key.permissions.map((permission) => <Badge key={permission} variant="info">{permission}</Badge>)}
                            <ActionButton label={t.consoleRevoke} variant="outline-danger" onClick={async () => { await client.platform.revokeKey(tenant.id, key.id); await loadKeys(); }} />
                        </div>
                    ))}
                    <div>
                        <LoadingButton label={t.consoleNewKey} variant="outline-secondary" onClick={async () => { const made = await client.platform.createKey(tenant.id, { name: 'console', permissions: ['complete', 'chat', 'chat:tools', 'accounts', 'act-as-user'] }); onKey(made.key); await loadKeys(); }} />
                    </div>
                    <h4 className="text-sm font-semibold">{t.consoleAccounts}</h4>
                    <RunnerAccounts client={scoped} scope="tenant" locale={locale} texts={t} />
                </div>
            )}
            {removing && (
                <ModalYesNo title={t.consoleRemoveTenant} danger onClose={() => setRemoving(false)} onYes={async () => { await client.platform.removeTenant(tenant.id); setRemoving(false); await onChange(); return true; }}>
                    {fill(t.consoleRemoveTenantConfirm, { name: tenant.name })}
                </ModalYesNo>
            )}
        </div>
    );
}

const normal = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** The platforms asking to connect: approve or refuse, the one the person was sent for first. */
function PairingRequests({ client, t, approve, onAnswered }: { client: RunnerClient; t: RunnerUiTexts; approve?: string; onAnswered: () => Promise<void> }) {
    const [requests, setRequests] = useState<RunnerPairingRequestView[] | null>(null);
    const [notice, setNotice] = useState<{ variant: 'success' | 'info'; text: string } | null>(null);
    const load = useCallback(async () => {
        try {
            const listed = await client.pairingRequests();
            const wanted = approve ? normal(approve) : '';
            setRequests([...listed].sort((a, b) => Number(normal(b.code) === wanted) - Number(normal(a.code) === wanted)));
        } catch {
            setRequests([]);
        }
    }, [client, approve]);
    useEffect(() => {
        void load();
        const timer = setInterval(() => void load(), 5000);
        return () => clearInterval(timer);
    }, [load]);
    if (!approve && !requests?.length && !notice) return null;
    return (
        <Card title={t.consoleRequests} loading={requests === null} loaderMinHeight={80}>
            <div className="flex flex-col gap-3">
                <p className="text-sm text-muted-foreground">{t.consoleRequestsHint}</p>
                {notice && <Alert variant={notice.variant}>{notice.text}</Alert>}
                {requests?.length === 0 && !notice && <p className="text-sm text-muted-foreground">{t.consoleRequestsEmpty}</p>}
                {requests?.map((request) => {
                    const match = !!approve && normal(request.code) === normal(approve);
                    const answer = async (yes: boolean) => {
                        const answered = await client.answerPairing(request.code, yes);
                        setNotice(yes ? { variant: 'success', text: fill(t.consoleApproved, { name: answered.name }) } : { variant: 'info', text: t.consoleDenied });
                        await load();
                        await onAnswered();
                    };
                    return (
                        <div key={request.code} className={`flex flex-col gap-2 rounded-md border p-3 ${match ? 'border-primary' : 'border-border'}`}>
                            {match && <Badge variant="primary">{t.consoleRequestMatch}</Badge>}
                            <div className="font-mono text-2xl font-semibold tracking-widest">{request.code}</div>
                            <p className="text-sm">{fill(t.consoleRequestFrom, { name: request.name, from: request.from ?? '?', at: when(request.createdAt) })}</p>
                            <div className="flex flex-wrap gap-2">
                                <LoadingButton label={t.consoleApprove} variant="primary" onClick={() => answer(true)} />
                                <LoadingButton label={t.consoleDeny} variant="outline-danger" onClick={() => answer(false)} />
                            </div>
                        </div>
                    );
                })}
            </div>
        </Card>
    );
}
