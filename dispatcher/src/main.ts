import { ConfigError, readLegacyCompany, readMachineConfig, type CompanyConfig, type MachineConfig } from './config.ts';
import { dockerRunner } from './docker.ts';
import { createRunnerServer } from './server.ts';
import { Tenants, machineLimit } from './tenants.ts';

// The dispatcher of a runner: the companies of its folder (each with its own .env), their webhooks
// and studios on PORT under their path, the reconciliation of each at start and every
// RECONCILE_MINUTES, and the turns of every company within MAX_PARALLEL for the machine.

/** How often the folder of the companies is read again (a company added, changed or removed). */
const SYNC_MS = 30_000;

const log = (line: string, details?: Record<string, unknown>) => console.log(JSON.stringify({ at: new Date().toISOString(), msg: line, ...details }));

function main() {
    let machine: MachineConfig;
    let legacy: CompanyConfig | null;
    try {
        machine = readMachineConfig();
        legacy = readLegacyCompany();
    } catch (error) {
        if (error instanceof ConfigError) {
            console.error(`[dispatcher] ${error.message}`);
            process.exit(64);
        }
        throw error;
    }

    const limit = machineLimit(machine.maxParallel);
    const tenants = new Tenants({
        machine,
        // Each company its own runner of turns: its turns carry its App id, so a restart clears its own only.
        runTurn: (config) => {
            const docker = dockerRunner({ image: machine.image, memory: machine.memory, network: machine.network, owner: `app-${config.appId}` });
            return (spec) => limit(() => docker.runTurn(spec));
        },
    }, legacy ? [legacy] : []);

    const start = async (fresh = false) => {
        for (const tenant of tenants.sync()) {
            tenant.log(fresh ? 'company loaded' : 'company added or changed', { webhook: !!tenant.config.webhookSecret, studio: !!tenant.config.studioToken, maxParallel: tenant.config.maxParallel, agentEnv: Object.keys(tenant.config.agentEnv) });
            await dockerRunner({ image: machine.image, owner: `app-${tenant.config.appId}` }).cleanUp();
            void tenant.dispatcher.reconcile();
        }
        for (const [id, problem] of tenants.problems) log('company skipped', { company: id, problem });
    };

    const server = createRunnerServer(tenants, { legacy: legacy?.id, log });
    server.listen(machine.port, async () => {
        log('runner listening', { port: machine.port, image: machine.image, maxParallel: machine.maxParallel, companiesDir: machine.companiesDir });
        await start(true);
        setInterval(() => void start(), SYNC_MS).unref();
        setInterval(() => { for (const tenant of tenants.all()) void tenant.dispatcher.reconcile(); }, machine.reconcileMinutes * 60_000).unref();
    });

    const stop = () => {
        log('stopping');
        server.close();
        process.exit(0);
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
}

main();
