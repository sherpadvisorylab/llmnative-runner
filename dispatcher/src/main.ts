import { ConfigError, readLegacyCompany, readMachineConfig, type CompanyConfig, type MachineConfig } from './config.ts';
import { containerStats, designHost, designKit, dockerRunner, ownNetwork, type DesignKit } from './docker.ts';
import { designSlots } from './designs.ts';
import { adminToken, dockerImages, ownImage } from './images.ts';
import { memoryBackup } from './backup.ts';
import { hostname } from 'node:os';
import { createRunnerServer } from './server.ts';
import { Tenants, machineLimit, moveOrganizationsData, readAllCompanyFiles, removeSentCompany, writeSentCompany } from './tenants.ts';

// The dispatcher of a runner: the organizations of ORGANIZATIONS_DIR (each with its own .env), their webhooks
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
    // The data of a runner older than 0.15, in the folder of before: moved before anything reads it.
    if (moveOrganizationsData(machine.dataDir)) log('data moved', { from: `${machine.dataDir}/companies`, to: `${machine.dataDir}/organizations` });

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
        stats: (names) => containerStats(names),
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

    // The images the runner uses: those of its settings and the one of its own container.
    const own = await ownImage(hostname());
    const images = dockerImages({ registry: machine.registry, services: machine.imageServices, inUse: async () => [machine.image, ...machine.design.images, ...(own ? [own] : [])] });
    const server = createRunnerServer(tenants, {
        legacy: legacy?.id,
        log,
        designs: kits,
        version: machine.version,
        admin: {
            token: () => adminToken(machine.adminTokenFile),
            images,
            registry: machine.registry,
            services: machine.imageServices,
            // The backup of the memory: a throwaway container of its own image (sh and tar are there), or alpine.
            memory: memoryBackup({ dir: machine.backupDir, image: own ?? 'alpine:3.20' }),
            // The .env the studio sends: loaded at once, not at the next half minute.
            organizations: {
                list: () => readAllCompanyFiles(machine).map((file) => ({
                    id: file.id,
                    sent: file.sent,
                    active: !!tenants.get(file.id),
                    ...(tenants.problems.has(file.id) ? { problem: tenants.problems.get(file.id) } : {}),
                })),
                write: (id, text) => {
                    const written = writeSentCompany(machine, id, text);
                    void start();
                    return written;
                },
                remove: (id) => {
                    const removed = removeSentCompany(machine, id);
                    if (removed) void start();
                    return removed;
                },
            },
        },
    });
    server.listen(machine.port, async () => {
        log('server listening', { version: machine.version, admin: !!adminToken(machine.adminTokenFile), port: machine.port, image: machine.image, maxParallel: machine.maxParallel, organizationsDir: machine.companiesDir, designKits: kits.map((kit) => kit.kit), designNetwork: network ?? 'published on 127.0.0.1' });
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
