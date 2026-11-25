import React, { useState } from 'react';
import { ActionButton, Alert, Badge, Code, Form, LoadingButton, String as TextInput } from '@llmnative/react';
import { RUNNER_REQUIREMENTS, checkRunner, installCommand, isDomain, lookupDomain, verifiedInstallCommands } from '../setup/steps';
import { fill, textsFor, type RunnerUiTexts } from './texts';

// The guide to install a runner by hand, for who never did it: a VPS, the domain (checked), entering the VPS, the
// command (with the domain filled in), and the pairing code at the end (the runner checked). The steps and the
// command come from steps.ts, the same the installer runs.

export type InstallGuideProps = {
    locale?: string;
    texts?: Partial<RunnerUiTexts>;
    /** The pairing code given back, with the address of the runner: the host connects it. */
    onPair: (input: { url: string; code: string }) => Promise<void>;
    /** How a domain is looked up; by default DNS-over-HTTPS. */
    lookup?: (domain: string) => Promise<string[]>;
    /** How the runner is checked; by default its /health. */
    check?: typeof checkRunner;
    version?: string;
};

function Step({ title, children, done }: { title: string; children: React.ReactNode; done?: boolean }) {
    return (
        <section className="flex flex-col gap-2 border-l-2 border-border pl-4">
            <h4 className="flex items-center gap-2 text-sm font-semibold">
                {title}
                {done && <Badge variant="success">✓</Badge>}
            </h4>
            {children}
        </section>
    );
}

export function InstallGuide({ locale, texts, onPair, lookup = (domain) => lookupDomain(domain), check = checkRunner, version }: InstallGuideProps) {
    const t = textsFor(locale, texts);
    const [domain, setDomain] = useState('');
    const [dns, setDns] = useState<{ ips: string[] } | null>(null);
    const [health, setHealth] = useState<{ ok: boolean; text: string } | null>(null);
    const [code, setCode] = useState('');
    const [showVerified, setShowVerified] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const valid = isDomain(domain);
    const url = `https://${domain.trim().toLowerCase()}`;
    const r = RUNNER_REQUIREMENTS;

    return (
        <div className="flex flex-col gap-5">
            <Step title={t.guideServerTitle}>
                <p className="text-sm">{fill(t.guideServer, { systems: r.systems.join(', '), cpus: r.cpus, memory: r.memoryGb, disk: r.diskGb, ports: r.ports.join(', ') })}</p>
            </Step>
            <Step title={t.guideDnsTitle} done={!!dns?.ips.length}>
                <p className="text-sm">{t.guideDns}</p>
                <Form appearance="empty" showNotice={false} onSubmit={() => false}>
                    <TextInput name="domain" label={t.guideDomain} placeholder="runner.example.com" autoComplete="off" onChange={({ value }) => { setDomain(String(value ?? '')); setDns(null); setHealth(null); }} />
                </Form>
                <div className="flex flex-wrap items-center gap-2">
                    <LoadingButton label={t.guideCheckDns} variant="outline-secondary" disabled={!valid} onClick={async () => setDns({ ips: await lookup(domain.trim().toLowerCase()).catch(() => []) })} />
                    {dns && (dns.ips.length ? <Alert variant="success" appearance="text">{fill(t.guideDnsOk, { ips: dns.ips.join(', ') })}</Alert> : <Alert variant="warning" appearance="text">{t.guideDnsMissing}</Alert>)}
                </div>
            </Step>
            <Step title={t.guideAccessTitle}>
                <p className="text-sm">{t.guideAccess}</p>
            </Step>
            <Step title={t.guideInstallTitle}>
                <p className="text-sm">{t.guideInstall}</p>
                <Code language="bash" showCopy>{installCommand({ domain: valid ? domain : 'runner.example.com', ...(version ? { version } : {}) })}</Code>
                <div>
                    <ActionButton label={t.guideVerified} variant="link" onClick={() => setShowVerified((shown) => !shown)} />
                </div>
                {showVerified && <Code language="bash" showCopy>{verifiedInstallCommands({ domain: valid ? domain : 'runner.example.com', ...(version ? { version } : {}) }).join('\n')}</Code>}
            </Step>
            <Step title={t.guidePairTitle} done={health?.ok}>
                <p className="text-sm">{t.guidePair}</p>
                <Form appearance="empty" showNotice={false} onSubmit={() => false}>
                    <TextInput name="code" label={t.addCode} placeholder="ABCD-EFGH" autoComplete="off" onChange={({ value }) => setCode(String(value ?? ''))} />
                </Form>
                {health && <Alert variant={health.ok ? 'success' : 'warning'} appearance="text">{health.text}</Alert>}
                {error && <Alert variant="danger">{error}</Alert>}
                <div className="flex flex-wrap gap-2">
                    <LoadingButton
                        label={t.guideCheckHealth}
                        variant="outline-secondary"
                        disabled={!valid}
                        onClick={async () => {
                            const result = await check(url);
                            setHealth(result.ok ? { ok: true, text: fill(t.guideHealthOk, { version: result.version, url }) } : { ok: false, text: fill(t.guideHealthKo, { url }) });
                        }}
                    />
                    <LoadingButton
                        label={t.addConnect}
                        variant="primary"
                        disabled={!valid || code.trim().length < 8}
                        onClick={async () => {
                            try {
                                setError(null);
                                await onPair({ url, code: code.trim() });
                            } catch (failure) {
                                setError(fill(t.error, { error: (failure as Error).message }));
                            }
                        }}
                    />
                </div>
            </Step>
            <Step title={t.guideTroubleTitle}>
                <p className="text-sm text-muted-foreground">{t.guideTrouble}</p>
            </Step>
        </div>
    );
}
