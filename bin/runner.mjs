#!/usr/bin/env node
// npx @llmnative/runner <command>
//   install --host <ip> --domain <runner.example.com> [--user root] [--key ~/.ssh/id_ed25519 | --password] [--port 22]
//           [--version 1.0.0] [--fingerprint SHA256:…] [--pair]
//   guide   --domain <runner.example.com>      the commands to run by hand on the VPS
//   pair    --url <https://runner…> --code <ABCD-EFGH>   a platform key (printed once)
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { installOverSsh, installCommand, verifiedInstallCommands, isDomain, RUNNER_VERSION, RUNNER_REQUIREMENTS } from '../dist/setup.mjs';
import { RunnerClient } from '../dist/client.mjs';

const [command, ...rest] = process.argv.slice(2);
const flags = {};
for (let index = 0; index < rest.length; index += 1) {
    const name = rest[index].replace(/^--/, '');
    const next = rest[index + 1];
    if (next === undefined || next.startsWith('--')) flags[name] = true;
    else { flags[name] = next; index += 1; }
}
const fail = (message) => { console.error(`error: ${message}`); process.exit(1); };
const ask = (question, hidden = false) => new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    if (hidden) rl._writeToOutput = () => {};
    rl.question(question, (answer) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(answer); });
});

async function main() {
    if (command === 'guide') {
        if (!isDomain(String(flags.domain ?? ''))) fail('--domain runner.example.com is required');
        console.log(`Runner ${RUNNER_VERSION}: a VPS with ${RUNNER_REQUIREMENTS.systems.join(' or ')}, ${RUNNER_REQUIREMENTS.cpus} cores, ${RUNNER_REQUIREMENTS.memoryGb} GB, ports ${RUNNER_REQUIREMENTS.ports.join(', ')} open.`);
        console.log(`1. Point ${flags.domain} (record A) to the address of the VPS.`);
        console.log('2. On the VPS, as root or with sudo:\n');
        console.log(`   ${installCommand({ domain: String(flags.domain) })}\n`);
        console.log('   or, checking the script first:\n');
        for (const line of verifiedInstallCommands({ domain: String(flags.domain) })) console.log(`   ${line}`);
        console.log('\n3. Paste the pairing code it prints where you connect the runner.');
        return;
    }
    if (command === 'pair') {
        if (!flags.url || !flags.code) fail('--url and --code are required');
        const paired = await new RunnerClient({ url: String(flags.url) }).pair(String(flags.code), typeof flags.name === 'string' ? flags.name : 'cli');
        console.log(`Platform key (shown once, keep it safe):\n${paired.key}`);
        return;
    }
    if (command === 'install') {
        const domain = String(flags.domain ?? '');
        if (!flags.host) fail('--host is required');
        if (!isDomain(domain)) fail('--domain runner.example.com is required');
        const keyFile = typeof flags.key === 'string' ? flags.key.replace(/^~/, homedir()) : undefined;
        const password = flags.password ? (typeof flags.password === 'string' ? flags.password : await ask('SSH password: ', true)) : undefined;
        const privateKey = keyFile ? readFileSync(keyFile, 'utf8') : (!password ? readDefaultKey() : undefined);
        if (!privateKey && !password) fail('no SSH key found: give --key <file> or --password');
        const result = await installOverSsh({
            host: String(flags.host),
            port: flags.port ? Number(flags.port) : 22,
            username: typeof flags.user === 'string' ? flags.user : 'root',
            ...(privateKey ? { privateKey } : {}),
            ...(password ? { password } : {}),
            ...(typeof flags.fingerprint === 'string' ? { hostFingerprint: flags.fingerprint } : {}),
        }, {
            domain,
            ...(typeof flags.version === 'string' ? { version: flags.version } : {}),
            onProgress: ({ line }) => { if (!/^[A-Z_]+=/.test(line)) console.log(line); },
        });
        console.log(`\nHost key of the VPS: ${result.hostFingerprint}`);
        if (flags.pair) {
            const paired = await new RunnerClient({ url: result.url }).pair(result.pairingCode, 'cli');
            console.log(`Platform key (shown once, keep it safe):\n${paired.key}`);
        } else {
            console.log(`Address: ${result.url}\nPairing code: ${result.pairingCode} (valid 15 minutes, once)`);
        }
        return;
    }
    console.log('usage: npx @llmnative/runner install --host <ip> --domain <runner.example.com> [--user root] [--key <file> | --password] [--pair]');
    console.log('       npx @llmnative/runner guide --domain <runner.example.com>');
    console.log('       npx @llmnative/runner pair --url <https://runner…> --code <ABCD-EFGH>');
    process.exit(command ? 64 : 0);
}

function readDefaultKey() {
    for (const name of ['id_ed25519', 'id_ecdsa', 'id_rsa']) {
        try { return readFileSync(`${homedir()}/.ssh/${name}`, 'utf8'); } catch { /* next */ }
    }
    return undefined;
}

main().catch((error) => fail(`${error.code ? `${error.code}: ` : ''}${error.message}`));
