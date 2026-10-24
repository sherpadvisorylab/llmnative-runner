import { ConfigError, readLegacyCompany, readMachineConfig, type CompanyConfig, type MachineConfig } from './config.ts';
import { designHost, designKit, dockerRunner, ownNetwork, type DesignKit } from './docker.ts';
import { designSlots } from './designs.ts';
import { hostname } from 'node:os';
import { createRunnerServer } from './server.ts';
import { Tenants, machineLimit } from './tenants.ts';

// The dispatcher of a runner: the companies of its folder (each with its own .env), their webhooks
// and studios on PORT under their path, the reconciliation of each at start and every
// RECONCILE_MINUTES, and the turns of every company within MAX_PARALLEL for the machine. The design
// sessions of the companies run next to it, within DESIGN_MAX_SESSIONS, paused when left alone.

/** How often the folder of the companies is read again (a company added, changed or removed). */
const SYNC_MS = 30_000;
/** How often the design sessions left alone are paused. */
const SWEEP_MS = 60_000;

const log = (line: string, details?: Record<string, unknown>) => console.log(JSON.stringify({ at: new Date().toISOString(), msg: line, ...details }));

async function main() {
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
    // The sessions join the network of the dispatcher, to be reached by name.
    const network = machine.design.network ?? await ownNetwork(hostname());
    const slots = designSlots(machine.design.maxSessions);
    // The design agents of this runner, one per image its compose names: each kit from the labels of its image.
    const kits = (await Promise.all(machine.design.images.map((image) => designKit(image)))).filter((kit): kit is DesignKit => !!kit);
    const tenants = new Tenants({
        machine,
        // Each company its own runner of turns: its turns carry its App id, so a restart clears its own only.
        runTurn: (config) => {
            const docker = dockerRunner({ image: machine.image, memory: machine.memory, network: machine.network, owner: `app-${config.appId}` });
            return (spec) => limit(() => docker.runTurn(spec));
        },
        designHost: (config) => designHost({ memory: machine.design.memory, network, owner: `app-${config.appId}` }),
        designSlots: slots,
        designKits: Object.fromEntries(kits.map((kit) => [kit.kit, { image: kit.image, command: kit.command }])),
    }, legacy ? [legacy] : []);

    const start = async (fresh = false) => {
        for (const tenant of tenants.sync()) {
            tenant.log(fresh ? 'company loaded' : 'company added or changed', { webhook: !!tenant.config.webhookSecret, studio: !!tenant.config.studioToken, maxParallel: tenant.config.maxParallel, agentEnv: Object.keys(tenant.config.agentEnv) });
            await dockerRunner({ image: machine.image, owner: `app-${tenant.config.appId}` }).cleanUp();
            void tenant.dispatcher.reconcile();
        }
        for (const [id, problem] of tenants.problems) log('company skipped', { company: id, problem });
    };

    const server = createRunnerServer(tenants, { legacy: legacy?.id, log, designs: kits });
    server.listen(machine.port, async () => {
        log('runner listening', { port: machine.port, image: machine.image, maxParallel: machine.maxParallel, companiesDir: machine.companiesDir, designKits: kits.map((kit) => kit.kit), designNetwork: network ?? 'published on 127.0.0.1' });
        await start(true);
        setInterval(() => void start(), SYNC_MS).unref();
        setInterval(() => { for (const tenant of tenants.all()) void tenant.dispatcher.reconcile(); }, machine.reconcileMinutes * 60_000).unref();
        setInterval(() => { for (const tenant of tenants.all()) void tenant.designs.sweep().catch((error: Error) => tenant.log('design sweep failed', { error: error.message })); }, SWEEP_MS).unref();
    });

    const stop = () => {
        log('stopping');
        server.close();
        process.exit(0);
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
}

void main();
