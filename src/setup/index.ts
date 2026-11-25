// @llmnative/runner/setup — installs a runner on a VPS over SSH, for Node: the command line
// (`npx @llmnative/runner install`) and the backend of a host (a Cloud Function, the server of a studio). It runs the
// same install.sh a person pastes by hand (steps.ts), streams what it prints, and reads the address and the pairing
// code at its end. The SSH credentials are used for this connection only and never kept.

import { Client, type ConnectConfig } from 'ssh2';
import { RunnerClient } from '../client';
import { installArguments, installScriptUrl, parseInstallOutput, phaseOf, type InstallOptions, type InstallPhase } from './steps';

export * from './steps';

export type SshTarget = {
    host: string;
    port?: number;
    username: string;
    /** A private key (PEM/OpenSSH), or a password. */
    privateKey?: string;
    passphrase?: string;
    password?: string;
    /**
     * The fingerprint the server must have (`SHA256:…`, as `ssh-keygen -lf` prints it); none: the first one is taken
     * and given back in the result, to be kept for the next time.
     */
    hostFingerprint?: string;
};

export type InstallProgress = { line: string; phase?: InstallPhase };

export type InstallResult = { url: string; pairingCode: string; hostFingerprint: string };

export class InstallError extends Error {
    readonly code: string;
    readonly output: string;

    constructor(code: string, message: string, output = '') {
        super(message);
        this.name = 'InstallError';
        this.code = code;
        this.output = output;
    }
}

/** The command run on the VPS: the script of the release, with sudo unless the user is root. */
export function remoteInstallCommand(options: InstallOptions & { root: boolean }): string {
    const run = options.root ? 'sh' : 'sudo -n sh';
    return `curl -fsSL ${installScriptUrl(options.version)} | ${run} -s -- ${installArguments(options).join(' ')}`;
}

/** Installs a runner over SSH; `onProgress` gets every line it prints (and the phase when one starts). */
export function installOverSsh(target: SshTarget, options: InstallOptions & { onProgress?: (progress: InstallProgress) => void; timeoutMs?: number }): Promise<InstallResult> {
    return new Promise((resolve, reject) => {
        const connection = new Client();
        let fingerprint = '';
        let output = '';
        let settled = false;
        const finish = (error?: InstallError, result?: InstallResult) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            connection.end();
            if (error) reject(error);
            else resolve(result!);
        };
        const timer = setTimeout(() => finish(new InstallError('timeout', 'the installation took too long', output)), options.timeoutMs ?? 20 * 60_000);
        const config: ConnectConfig = {
            host: target.host,
            port: target.port ?? 22,
            username: target.username,
            readyTimeout: 30_000,
            ...(target.privateKey ? { privateKey: target.privateKey, ...(target.passphrase ? { passphrase: target.passphrase } : {}) } : {}),
            ...(target.password ? { password: target.password } : {}),
            hostHash: 'sha256',
            hostVerifier: (hash: string) => {
                // ssh2 gives the hash in hex: shown as OpenSSH does (SHA256:<base64>).
                fingerprint = `SHA256:${Buffer.from(hash, 'hex').toString('base64').replace(/=+$/, '')}`;
                return !target.hostFingerprint || target.hostFingerprint === fingerprint;
            },
        };
        connection.on('error', (error: Error & { level?: string }) => {
            const code = /authentication/i.test(error.message) ? 'ssh-auth' : /verif/i.test(error.message) ? 'ssh-host-key' : 'ssh-connect';
            finish(new InstallError(code, error.message, output));
        });
        connection.on('ready', () => {
            const root = target.username === 'root';
            connection.exec(remoteInstallCommand({ ...options, root }), (error, stream) => {
                if (error) return finish(new InstallError('ssh-exec', error.message, output));
                let pending = '';
                const read = (chunk: Buffer) => {
                    const text = chunk.toString('utf8');
                    output = (output + text).slice(-200_000);
                    pending += text;
                    const lines = pending.split('\n');
                    pending = lines.pop() ?? '';
                    for (const line of lines) {
                        // The pairing code is for the result, not for a log that may be kept.
                        const shown = line.replace(/^(PAIRING_CODE=).+$/, '$1…').replace(/(Pairing code:\s+)\S+/, '$1…');
                        options.onProgress?.({ line: shown, ...(phaseOf(line) ? { phase: phaseOf(line) } : {}) });
                    }
                };
                stream.on('data', read);
                stream.stderr.on('data', read);
                stream.on('close', (code: number | null) => {
                    const parsed = parseInstallOutput(output);
                    if (code === 0 && parsed.url && parsed.pairingCode) return finish(undefined, { url: parsed.url, pairingCode: parsed.pairingCode, hostFingerprint: fingerprint });
                    if (!root && /sudo: a password is required|sudo: a terminal is required/.test(output)) return finish(new InstallError('sudo', 'the user needs sudo without a password, or connect as root', output));
                    finish(new InstallError(parsed.error ?? 'install', `the installer ended with ${code ?? 'no code'}`, output));
                });
            });
        });
        connection.connect(config);
    });
}

/** Installs and pairs at once: the platform key, seen once, to keep in the backend of the host. */
export async function installAndPair(target: SshTarget, options: InstallOptions & { name?: string; onProgress?: (progress: InstallProgress) => void; fetch?: typeof fetch }) {
    const installed = await installOverSsh(target, options);
    const paired = await new RunnerClient({ url: installed.url, ...(options.fetch ? { fetch: options.fetch } : {}) }).pair(installed.pairingCode, options.name);
    return { url: installed.url, hostFingerprint: installed.hostFingerprint, platformKey: paired.key, version: paired.version };
}
