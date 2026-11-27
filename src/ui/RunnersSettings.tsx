import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ActionButton, Alert, Badge, Card, Form, LoadingButton, Modal, ModalYesNo, Password, Select, String as TextInput, Switch, TextArea } from '@llmnative/react';
import type { RunnerStatus } from '../client';
import type { InstallPhase } from '../setup/steps';
import { InstallGuide } from './InstallGuide';
import { fill, textsFor, type RunnerUiTexts } from './texts';

// The runners of a platform (a CMS, a studio), outside its tenants: the list with their state, adding one (installed
// for you over SSH, by hand with the guide, or already installed), the default for new tenants, draining, and which
// runner each tenant uses. The platform keeps the keys in its backend: this page only goes through `fleet`.

export type RunnerEntry = { id: string; name: string; url: string; isDefault?: boolean; draining?: boolean };

export type RunnerPairingStart = { id: string; code: string; approveUrl: string; expiresAt: string };
export type RunnerPairingState = { status: 'pending' | 'denied' | 'expired' } | { status: 'approved'; runner: RunnerEntry };

export type RunnerSshAccess = { host: string; port?: number; username: string; privateKey?: string; password?: string };

/** What the platform does for this page, in its backend (where the platform keys are). */
export interface RunnerFleet {
    list(): Promise<RunnerEntry[]>;
    /** Connects a runner: with a pairing code (the backend pairs and keeps the platform key), or a key made before. */
    add(input: { name: string; url: string; code?: string; key?: string }): Promise<RunnerEntry>;
    update(id: string, patch: Partial<Pick<RunnerEntry, 'name' | 'isDefault' | 'draining'>>): Promise<void>;
    remove(id: string): Promise<void>;
    status(id: string): Promise<RunnerStatus>;
    /** Installs and connects a runner over SSH (`@llmnative/runner/setup` in the backend); none: only by hand. */
    install?(input: { name: string; domain: string; access: RunnerSshAccess }, onProgress: (progress: { line: string; phase?: InstallPhase }) => void): Promise<RunnerEntry>;
    /**
     * Connects a runner already installed by asking it (device flow): the backend asks the runner and keeps the
     * secret of the request, the person approves on the runner (`approveUrl`, the same `code` on both sides).
     * None: only with a pairing code.
     */
    startPairing?(input: { name: string; url: string }): Promise<RunnerPairingStart>;
    /** How the request is going; approved, the runner connected. */
    pairingStatus?(id: string): Promise<RunnerPairingState>;
    /** The backend runs on the computer of the person (`npx @llmnative/runner setup`): it can use its SSH keys. */
    localKeys?: boolean;
    /** The tenants of the platform and their runner; none: no distribution on this page. */
    tenants?: {
        list(): Promise<Array<{ id: string; name: string; runnerId?: string }>>;
        assign(tenantId: string, runnerId: string): Promise<void>;
    };
}

export type RunnersSettingsProps = { fleet: RunnerFleet; locale?: string; texts?: Partial<RunnerUiTexts> };

type Row = RunnerEntry & { status?: RunnerStatus | null };

export function RunnersSettings({ fleet, locale, texts }: RunnersSettingsProps) {
    const t = textsFor(locale, texts);
    const [rows, setRows] = useState<Row[] | null>(null);
    const [tenants, setTenants] = useState<Array<{ id: string; name: string; runnerId?: string }> | null>(null);
    const [adding, setAdding] = useState(false);
    const [removing, setRemoving] = useState<Row | null>(null);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            const list = await fleet.list();
            setRows(list);
            const statuses = await Promise.all(list.map((entry) => fleet.status(entry.id).catch(() => null)));
            setRows(list.map((entry, index) => ({ ...entry, status: statuses[index] })));
            if (fleet.tenants) setTenants(await fleet.tenants.list());
        } catch (failure) {
            setError(fill(t.error, { error: (failure as Error).message }));
            setRows([]);
        }
    }, [fleet, t]);

    useEffect(() => {
        void load();
    }, [load]);

    const update = async (id: string, patch: Partial<RunnerEntry>) => {
        await fleet.update(id, patch);
        await load();
    };

    return (
        <div className="flex flex-col gap-4">
            <Card
                header={(
                    <div className="flex flex-wrap items-center gap-2">
                        <h3 className="flex-1 text-base font-semibold">{t.runnersTitle}</h3>
                        <ActionButton icon="plus" label={t.runnersAdd} variant="primary" onClick={() => setAdding(true)} />
                    </div>
                )}
                loading={rows === null}
                loaderMinHeight={120}
            >
                <div className="flex flex-col gap-3">
                    <p className="text-sm text-muted-foreground">{t.runnersIntro}</p>
                    {error && <Alert variant="danger">{error}</Alert>}
                    {rows?.length === 0 && <p className="text-sm text-muted-foreground">{t.runnersEmpty}</p>}
                    {rows?.map((row) => (
                        <div key={row.id} className="flex flex-col gap-2 rounded-md border border-border p-3">
                            <div className="flex flex-wrap items-center gap-2">
                                <span className="font-medium">{row.name}</span>
                                <span className="text-xs text-muted-foreground">{row.url}</span>
                                {row.status === null && <Badge variant="danger">{t.runnersUnreachable}</Badge>}
                                {row.status && <Badge variant="secondary">{fill(t.runnersVersion, { version: row.status.version })}</Badge>}
                                {row.status && <Badge variant="info">{fill(t.runnersLoad, { chats: row.status.load.chats, max: row.status.load.maxChats })}</Badge>}
                                {row.status && <Badge variant="light">{fill(t.runnersTenants, { count: row.status.tenants.length })}</Badge>}
                                <div className="ml-auto">
                                    <ActionButton icon="trash" label={t.runnersRemove} variant="outline-danger" onClick={() => setRemoving(row)} />
                                </div>
                            </div>
                            <Form appearance="empty" showNotice={false} onSubmit={() => false} defaultValues={{ isDefault: row.isDefault ? 'true' : '', draining: row.draining ? 'true' : '' }}>
                                <div className="flex flex-wrap gap-4">
                                    <Switch name="isDefault" label={t.runnersDefault} valueChecked="true" onChange={({ value }) => void update(row.id, { isDefault: !!value })} />
                                    <Switch name="draining" label={t.runnersDraining} valueChecked="true" onChange={({ value }) => void update(row.id, { draining: !!value })} />
                                </div>
                            </Form>
                        </div>
                    ))}
                </div>
            </Card>
            {fleet.tenants && rows && rows.length > 0 && (
                <Card title={t.distributionTitle} loading={tenants === null} loaderMinHeight={80}>
                    <div className="flex flex-col gap-2">
                        <p className="text-sm text-muted-foreground">{t.distributionIntro}</p>
                        <Form appearance="empty" showNotice={false} onSubmit={() => false} defaultValues={Object.fromEntries((tenants ?? []).map((tenant) => [`runner_${tenant.id}`, tenant.runnerId ?? '']))}>
                            {(tenants ?? []).map((tenant) => (
                                <div key={tenant.id} className="flex flex-wrap items-center gap-2">
                                    <span className="min-w-40 flex-1 text-sm">{tenant.name}</span>
                                    <Select
                                        name={`runner_${tenant.id}`}
                                        title={t.distributionRunner}
                                        placeholderOption={{ label: t.distributionNone, value: '' }}
                                        options={rows.map((row) => ({ label: row.name, value: row.id }))}
                                        onChange={({ value }) => {
                                            if (value) void fleet.tenants!.assign(tenant.id, String(value)).then(load);
                                        }}
                                    />
                                </div>
                            ))}
                        </Form>
                    </div>
                </Card>
            )}
            {adding && <AddRunner fleet={fleet} t={t} locale={locale} onClose={() => setAdding(false)} onAdded={async () => { setAdding(false); await load(); }} />}
            {removing && (
                <ModalYesNo title={t.runnersRemove} danger onClose={() => setRemoving(null)} onYes={async () => { await fleet.remove(removing.id).catch((failure: Error) => setError(fill(t.error, { error: failure.message }))); setRemoving(null); await load(); return true; }}>
                    {fill(t.runnersRemoveConfirm, { name: removing.name })}
                </ModalYesNo>
            )}
        </div>
    );
}

type Mode = 'choose' | 'automatic' | 'guided' | 'existing';

/** The buttons of a step, in the footer of the modal (on the right, as the other modals). */
function Actions({ target, children }: { target: HTMLElement | null; children: React.ReactNode }) {
    return target ? createPortal(children, target) : null;
}

/** The name of a runner: its address, until the platform lets people rename it. */
const hostOf = (url: string) => {
    try {
        return new URL(url).hostname;
    } catch {
        return url;
    }
};

/** Adding a runner: the three ways, in one modal. */
export function AddRunner({ fleet, t, locale, onClose, onAdded, position }: { fleet: RunnerFleet; t: RunnerUiTexts; locale?: string; onClose: () => void; onAdded: (entry: RunnerEntry) => void | Promise<void>; /** Where the modal opens: centered (default) or on the right, over another. */ position?: 'center' | 'right' }) {
    const [mode, setMode] = useState<Mode>('choose');
    const [error, setError] = useState<string | null>(null);
    const [footer, setFooter] = useState<HTMLDivElement | null>(null);
    const fail = useCallback((failure: unknown) => setError(fill(t.error, { error: (failure as Error).message })), [t]);
    return (
        <Modal
            title={t.addTitle}
            {...(position === 'right' ? { position: 'right' as const } : {})}
            size="lg"
            onClose={onClose}
            footer={mode === 'choose' || mode === 'guided' ? false : <div ref={setFooter} className="flex w-full flex-wrap items-center justify-end gap-3" />}
        >
            <div className="flex flex-col gap-4">
                {error && <Alert variant="danger">{error}</Alert>}
                {mode === 'choose' && (
                    <div className="grid gap-3 sm:grid-cols-3">
                        {fleet.install && <Choice title={t.addAutomatic} hint={t.addAutomaticHint} onClick={() => setMode('automatic')} />}
                        <Choice title={t.addGuided} hint={t.addGuidedHint} onClick={() => setMode('guided')} />
                        <Choice title={t.addExisting} hint={t.addExistingHint} onClick={() => setMode('existing')} />
                    </div>
                )}
                {mode !== 'choose' && (
                    <div>
                        <ActionButton icon="arrow-left" label={t.addBack} variant="link" onClick={() => { setMode('choose'); setError(null); }} />
                    </div>
                )}
                {mode === 'automatic' && fleet.install && (
                    <AutomaticInstall t={t} footer={footer} localKeys={!!fleet.localKeys} install={(domain, access, onProgress) => fleet.install!({ name: domain, domain, access }, onProgress)} onDone={onAdded} onError={fail} />
                )}
                {mode === 'guided' && (
                    <InstallGuide locale={locale} texts={t} onPair={async ({ url, code }) => { await onAdded(await fleet.add({ name: hostOf(url), url, code })); }} />
                )}
                {mode === 'existing' && (
                    <ExistingRunner
                        t={t}
                        footer={footer}
                        pairing={fleet.startPairing && fleet.pairingStatus ? { start: fleet.startPairing.bind(fleet), status: fleet.pairingStatus.bind(fleet) } : undefined}
                        onAdded={onAdded}
                        onError={fail}
                        onClearError={() => setError(null)}
                        onConnect={async (url, code) => { try { await onAdded(await fleet.add({ name: hostOf(url), url, code })); } catch (failure) { fail(failure); } }}
                    />
                )}
            </div>
        </Modal>
    );
}

function Choice({ title, hint, onClick }: { title: string; hint: string; onClick: () => void }) {
    return (
        <button type="button" onClick={onClick} className="rounded-lg border border-border p-4 text-left transition-colors hover:border-primary hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <span className="block font-medium">{title}</span>
            <span className="mt-1 block text-sm text-muted-foreground">{hint}</span>
        </button>
    );
}

type Pairing = { start: NonNullable<RunnerFleet['startPairing']>; status: NonNullable<RunnerFleet['pairingStatus']> };

const addressOf = (url: string) => (/^https?:\/\//.test(url.trim()) ? url.trim() : `https://${url.trim()}`).replace(/\/+$/, '');
const timeOf = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

/** Polls that may fail in a row before the page says so: one call lost (a cold start, the network) is not an error. */
const POLL_FAILURES = 5;

/** A runner already installed: its address, then the approval on the runner (or a pairing code, the old way). */
function ExistingRunner({ t, footer, pairing, onAdded, onError, onClearError, onConnect }: {
    t: RunnerUiTexts;
    footer: HTMLElement | null;
    pairing?: Pairing;
    onAdded: (entry: RunnerEntry) => void | Promise<void>;
    onError: (failure: unknown) => void;
    onClearError: () => void;
    onConnect: (url: string, code: string) => Promise<void>;
}) {
    const [url, setUrl] = useState('');
    const [code, setCode] = useState('');
    const [withCode, setWithCode] = useState(!pairing);
    const [request, setRequest] = useState<RunnerPairingStart | null>(null);
    const [ended, setEnded] = useState<'denied' | 'expired' | null>(null);

    // While a request waits: asking how it goes every two seconds, until approved, refused or expired.
    useEffect(() => {
        if (!request || !pairing) return undefined;
        let stopped = false;
        let failures = 0;
        let timer: ReturnType<typeof setTimeout>;
        const ask = async () => {
            try {
                const state = await pairing.status(request.id);
                failures = 0;
                if (stopped) return;
                if (state.status === 'approved') {
                    await onAdded(state.runner);
                    return;
                }
                if (state.status !== 'pending') {
                    setEnded(state.status);
                    setRequest(null);
                    return;
                }
            } catch (failure) {
                failures += 1;
                if (!stopped && failures >= POLL_FAILURES) onError(failure);
            }
            if (!stopped) timer = setTimeout(() => void ask(), 2000);
        };
        timer = setTimeout(() => void ask(), 2000);
        return () => {
            stopped = true;
            clearTimeout(timer);
        };
    }, [request, pairing, onAdded, onError]);

    if (request) {
        return (
            <div className="flex flex-col gap-3">
                <h4 className="font-semibold">{t.pairWaitingTitle}</h4>
                <p className="text-sm text-muted-foreground">{t.pairWaitingHint}</p>
                <div className="rounded-lg border border-border p-4 text-center font-mono text-3xl font-semibold tracking-widest">{request.code}</div>
                <p className="text-sm text-muted-foreground">{fill(t.pairWaiting, { at: timeOf(request.expiresAt) })}</p>
                <Actions target={footer}>
                    <ActionButton icon="external-link" label={t.pairOpen} variant="primary" onClick={() => window.open(request.approveUrl, '_blank', 'noopener')} />
                </Actions>
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-3">
            {ended && <Alert variant={ended === 'denied' ? 'danger' : 'warning'}>{ended === 'denied' ? t.pairDenied : t.pairExpired}</Alert>}
            <Form appearance="empty" showNotice={false} onSubmit={() => false} defaultValues={{ url, code }}>
                <TextInput name="url" label={t.addUrl} placeholder="https://runner.example.com" onChange={({ value }) => setUrl(String(value ?? ''))} />
                {withCode && <TextInput name="code" label={t.addCode} placeholder="ABCD-EFGH" autoComplete="off" onChange={({ value }) => setCode(String(value ?? ''))} />}
            </Form>
            <Actions target={footer}>
                {pairing && <ActionButton label={withCode ? t.pairWithApproval : t.pairWithCode} variant="link" onClick={() => setWithCode((was) => !was)} />}
                {withCode
                    ? <LoadingButton label={t.addConnect} variant="primary" disabled={!url.trim() || code.trim().length < 8} onClick={() => onConnect(addressOf(url), code.trim())} />
                    : (
                        <LoadingButton
                            label={ended ? t.pairAgain : t.pairNext}
                            variant="primary"
                            disabled={!url.trim()}
                            onClick={async () => {
                                setEnded(null);
                                onClearError();
                                try {
                                    const address = addressOf(url);
                                    setRequest(await pairing!.start({ name: hostOf(address), url: address }));
                                } catch (failure) {
                                    onError(failure);
                                }
                            }}
                        />
                    )}
            </Actions>
        </div>
    );
}

const PHASES: InstallPhase[] = ['check', 'docker', 'files', 'start', 'agent', 'health', 'pair', 'tls', 'done'];

function AutomaticInstall({ t, footer, localKeys, install, onDone, onError }: {
    t: RunnerUiTexts;
    footer: HTMLElement | null;
    localKeys: boolean;
    install: (domain: string, access: RunnerSshAccess, onProgress: (progress: { line: string; phase?: InstallPhase }) => void) => Promise<RunnerEntry>;
    onDone: (entry: RunnerEntry) => void | Promise<void>;
    onError: (failure: unknown) => void;
}) {
    const [values, setValues] = useState({ host: '', port: '22', username: localKeys ? '' : 'root', auth: localKeys ? 'local' : 'key', privateKey: '', password: '', domain: '' });
    const [log, setLog] = useState<string[]>([]);
    const [phase, setPhase] = useState<InstallPhase | null>(null);
    const [running, setRunning] = useState(false);
    const set = (name: keyof typeof values) => ({ value }: { value?: unknown }) => setValues((all) => ({ ...all, [name]: String(value ?? '') }));
    const ready = values.host.trim() && values.domain.trim() && (values.auth === 'local' || values.username.trim()) && (values.auth === 'local' || (values.auth === 'key' ? values.privateKey.trim() : values.password));
    return (
        <div className="flex flex-col gap-3">
            {!running && (
                <Form appearance="empty" showNotice={false} onSubmit={() => false} defaultValues={values}>
                    <TextInput name="domain" label={t.guideDomain} placeholder="runner.example.com" onChange={set('domain')} />
                    <div className="grid gap-3 sm:grid-cols-3">
                        <TextInput name="host" label={t.addHost} placeholder="203.0.113.10" onChange={set('host')} />
                        <TextInput name="port" label={t.addPort} onChange={set('port')} />
                        <TextInput name="username" label={t.addUser} onChange={set('username')} />
                    </div>
                    <Select name="auth" label={t.addAuth} options={[...(localKeys ? [{ label: t.addLocalKey, value: 'local' }] : []), { label: t.addKey, value: 'key' }, { label: t.addPassword, value: 'password' }]} onChange={set('auth')} />
                    {values.auth === 'local' && <p className="text-xs text-muted-foreground">{t.addLocalKeyHint}</p>}
                    {values.auth === 'local' ? null : values.auth === 'key'
                        ? <TextArea name="privateKey" label={t.addKey} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" onChange={set('privateKey')} />
                        : <Password name="password" label={t.addPassword} autoComplete="off" onChange={set('password')} />}
                </Form>
            )}
            <p className="text-xs text-muted-foreground">{t.addCredentialsNote}</p>
            {running && (
                <div className="flex flex-wrap gap-1">
                    {PHASES.map((name) => <Badge key={name} variant={phase === name ? 'primary' : PHASES.indexOf(name) < PHASES.indexOf(phase ?? 'check') ? 'success' : 'light'}>{name}</Badge>)}
                </div>
            )}
            {log.length > 0 && <pre className="max-h-64 overflow-auto rounded-md bg-muted p-2 text-xs">{log.slice(-200).join('\n')}</pre>}
            <Actions target={footer}>
                <LoadingButton
                    label={running ? t.addInstalling : t.addInstall}
                    variant="primary"
                    disabled={!ready || running}
                    onClick={async () => {
                        setRunning(true);
                        setLog([]);
                        try {
                            const entry = await install(values.domain.trim().toLowerCase(), {
                                host: values.host.trim(),
                                port: Number(values.port) || 22,
                                username: values.username.trim(),
                                ...(values.auth === 'key' ? { privateKey: values.privateKey } : values.auth === 'password' ? { password: values.password } : {}),
                            }, ({ line, phase: next }) => {
                                if (next) setPhase(next);
                                if (!/^[A-Z_]+=/.test(line)) setLog((all) => [...all, line]);
                            });
                            await onDone(entry);
                        } catch (failure) {
                            onError(failure);
                        } finally {
                            setRunning(false);
                        }
                    }}
                />
            </Actions>
        </div>
    );
}
