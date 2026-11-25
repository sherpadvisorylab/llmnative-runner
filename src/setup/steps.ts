// @llmnative/runner/steps — how a runner is installed, said once: the requirements, the command, the steps of the
// guide and what the installer prints. The installer over SSH (`/setup`), the command line and the guide of the UI
// all read it, so they never drift apart. Pure: browser and Node.

/** Set by the build from package.json. */
declare const __RUNNER_VERSION__: string;

/** The release these steps install: the version of this package (images and package share it). */
export const RUNNER_VERSION: string = typeof __RUNNER_VERSION__ === 'string' ? __RUNNER_VERSION__ : '0.0.0';
export const RUNNER_REPOSITORY = 'sherpadvisorylab/llmnative-runner';

export const RUNNER_REQUIREMENTS = {
    systems: ['Ubuntu 22.04 or newer', 'Debian 12 or newer'],
    architectures: ['x86_64', 'arm64'],
    cpus: 2,
    memoryGb: 4,
    diskGb: 20,
    ports: [22, 80, 443],
} as const;

/** The domain of a runner: a host name of its own (`runner.example.com`), pointed at the VPS. */
export const DOMAIN_PATTERN = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export const isDomain = (value: string) => DOMAIN_PATTERN.test(value.trim().toLowerCase());

export const installScriptUrl = (version = RUNNER_VERSION) => `https://github.com/${RUNNER_REPOSITORY}/releases/download/v${version}/install.sh`;
export const checksumUrl = (version = RUNNER_VERSION) => `${installScriptUrl(version)}.sha256`;

export type InstallOptions = { domain: string; version?: string; maxChats?: number };

/** The arguments of install.sh, each quoted for a shell. */
export function installArguments({ domain, maxChats }: InstallOptions): string[] {
    const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
    return ['--domain', quote(domain.trim().toLowerCase()), ...(maxChats ? ['--max-chats', String(maxChats)] : [])];
}

/** The command to paste on the VPS (as root, or with sudo). */
export function installCommand(options: InstallOptions): string {
    return `curl -fsSL ${installScriptUrl(options.version)} | sudo sh -s -- ${installArguments(options).join(' ')}`;
}

/** The same, for who checks the script before running it. */
export function verifiedInstallCommands(options: InstallOptions): string[] {
    const version = options.version ?? RUNNER_VERSION;
    return [
        `curl -fsSLO ${installScriptUrl(version)}`,
        `curl -fsSL ${checksumUrl(version)} | sha256sum -c -`,
        `sudo sh install.sh ${installArguments(options).join(' ')}`,
    ];
}

/** The steps of the guide, in order; `check` says what the guide can verify by itself at that step. */
export const GUIDE_STEPS = [
    { id: 'server' },
    { id: 'dns', check: 'dns' },
    { id: 'access' },
    { id: 'install' },
    { id: 'pair', check: 'health' },
] as const;
export type GuideStepId = (typeof GUIDE_STEPS)[number]['id'];

/** What install.sh prints for a machine to read: `RUNNER_URL=…`, `PAIRING_CODE=…`, `RUNNER_ERROR=…`. */
export function parseInstallOutput(text: string): { url?: string; pairingCode?: string; error?: string } {
    const value = (name: string) => new RegExp(`^${name}=(.+)$`, 'm').exec(text)?.[1]?.trim();
    const url = value('RUNNER_URL');
    const pairingCode = value('PAIRING_CODE');
    const error = value('RUNNER_ERROR');
    return { ...(url ? { url } : {}), ...(pairingCode ? { pairingCode } : {}), ...(error ? { error } : {}) };
}

/** The steps install.sh announces (`STEP=<id>`), for a progress shown while it runs. */
export const INSTALL_PHASES = ['check', 'docker', 'files', 'start', 'agent', 'health', 'pair', 'tls', 'done'] as const;
export type InstallPhase = (typeof INSTALL_PHASES)[number];
export const phaseOf = (line: string): InstallPhase | undefined => {
    const match = /^STEP=([a-z]+)$/.exec(line.trim());
    return match && (INSTALL_PHASES as readonly string[]).includes(match[1]) ? match[1] as InstallPhase : undefined;
};

/**
 * The addresses a domain points to, asked over DNS-over-HTTPS (no DNS from a browser otherwise). `resolver`: a
 * service that answers `application/dns-json` (by default Cloudflare's; any other can be given).
 */
export async function lookupDomain(domain: string, options: { fetch?: typeof fetch; resolver?: string } = {}): Promise<string[]> {
    const resolver = options.resolver ?? 'https://cloudflare-dns.com/dns-query';
    const ask = async (type: 'A' | 'AAAA') => {
        const response = await (options.fetch ?? fetch)(`${resolver}?name=${encodeURIComponent(domain)}&type=${type}`, { headers: { accept: 'application/dns-json' } });
        if (!response.ok) return [];
        const data = await response.json() as { Answer?: Array<{ type: number; data: string }> };
        return (data.Answer ?? []).filter((answer) => answer.type === (type === 'A' ? 1 : 28)).map((answer) => answer.data);
    };
    const [v4, v6] = await Promise.all([ask('A'), ask('AAAA')]);
    return [...v4, ...v6];
}

/** Whether a runner answers at its address, over HTTPS: its version, or why not. */
export async function checkRunner(url: string, fetchImpl: typeof fetch = fetch): Promise<{ ok: true; version: string } | { ok: false; reason: 'unreachable' | 'not-a-runner' }> {
    try {
        const response = await fetchImpl(`${url.replace(/\/+$/, '')}/health`);
        if (!response.ok) return { ok: false, reason: 'not-a-runner' };
        const data = await response.json() as { ok?: boolean; version?: string };
        return data.ok && typeof data.version === 'string' ? { ok: true, version: data.version } : { ok: false, reason: 'not-a-runner' };
    } catch {
        return { ok: false, reason: 'unreachable' };
    }
}
