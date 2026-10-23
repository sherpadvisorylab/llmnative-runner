import type { GitHubApi } from './github.ts';
import type { RunTurn } from './docker.ts';
import { readWorkflow, workOf, type Workflow } from './workflow.ts';
import { OutputBuffer } from './output.ts';

// The dispatcher: an issue whose `needs:` label is an agent of the workflow of its repository gets a
// turn of that agent, one container. One turn per issue at a time, at most `maxParallel` at once,
// the highest Priority first and then the oldest. A turn that ends with the issue still on the same
// agent failed; after `failuresToBlock` failures in a row the issue goes to a person, blocked.

export interface DispatcherOptions {
    maxParallel: number;
    /** Seconds of a turn (PLAYBOOK_TIMEOUT of the agent). */
    turnTimeout: number;
    failuresToBlock: number;
    /** Variables handed to every turn: the keys of the model providers, the memory. */
    agentEnv: Record<string, string>;
    /** How long the workflow of a repository is trusted before it is read again, in ms. */
    workflowTtl?: number;
}

export interface FailureStore {
    get(key: string): number;
    set(key: string, failures: number): void;
}

export type Log = (line: string, details?: Record<string, unknown>) => void;

export interface TurnLog {
    /** Keeps what a turn printed, with its secrets masked. */
    write(key: string, text: string): void;
}

type Issue = {
    number: number;
    state: string;
    created_at: string;
    node_id?: string;
    pull_request?: unknown;
    labels: Array<string | { name?: string }>;
};

type Candidate = { repository: string; number: number; agent: string; priority: number; created: number };

/** What happens, as it happens: for the studio, through `/events`. */
export type LiveEvent =
    | { type: 'queued'; at: string; repository: string; issue: number; agent: string }
    | { type: 'turn-started'; at: string; repository: string; issue: number; agent: string }
    | { type: 'turn-ended'; at: string; repository: string; issue: number; agent: string; code: number; seconds: number; moved: boolean }
    | { type: 'handed'; at: string; repository: string; issue: number; agent: string; failures: number }
    | { type: 'issue'; at: string; repository: string; issue?: number; action: string }
    | { type: 'turn-output'; at: string; repository: string; issue: number; agent: string; lines: string[] };

/** What a turn printed so far, cleaned and masked: while it runs, and after it ended until the next one. */
export type TurnOutput = { repository: string; issue: number; agent: string; startedAt: string; lines: string[]; ended?: { code: number; seconds: number; moved: boolean } };

/** A turn that ran, kept for the studio: the last ones only. */
export type TurnRecord = { repository: string; issue: number; agent: string; startedAt: string; seconds: number; code: number; moved: boolean };

type Running = { repository: string; issue: number; agent: string; startedAt?: string };

const RECENT_TURNS = 100;
/** Outputs kept for the studio: the turns running, and the last ones that ended. */
const KEPT_OUTPUTS = 30;
/** How often new lines go out together, in ms. */
const OUTPUT_EVERY = 500;

const PRIORITY: Record<string, number> = { high: 0, normal: 1, low: 2 };
const MARKER = (data: object) => `<!-- playbook ${JSON.stringify(data)} -->`;
export const issueKey = (repository: string, number: number) => `${repository}#${number}`;

export class Dispatcher {
    private readonly running = new Map<string, Running>();
    private readonly listeners = new Set<(event: LiveEvent) => void>();
    private readonly turns: TurnRecord[] = [];
    private readonly outputs = new Map<string, { record: Omit<TurnOutput, 'lines'>; buffer: OutputBuffer }>();
    private readonly mask: (text: string) => string;
    private readonly queued = new Map<string, Candidate>();
    private readonly workflows = new Map<string, { at: number; workflow: Workflow | null }>();
    private readonly github: GitHubApi;
    private readonly runTurn: RunTurn;
    private readonly failures: FailureStore;
    private readonly options: DispatcherOptions;
    private readonly log: Log;
    private readonly turnLog: TurnLog;
    private readonly now: () => number;
    /** Resolves when no turn is running and none is waiting: for tests and a graceful stop. */
    private idle: Array<() => void> = [];
    lastReconcile?: string;

    constructor(deps: { github: GitHubApi; runTurn: RunTurn; failures: FailureStore; options: DispatcherOptions; log: Log; turnLog: TurnLog; now?: () => number; mask?: (text: string) => string }) {
        this.mask = deps.mask ?? ((text) => text);
        this.github = deps.github;
        this.runTurn = deps.runTurn;
        this.failures = deps.failures;
        this.options = deps.options;
        this.log = deps.log;
        this.turnLog = deps.turnLog;
        this.now = deps.now ?? (() => Date.now());
    }

    /** Turns running and waiting, and the last turns: what the studio shows as it is now. */
    get state() {
        return {
            running: [...this.running.values()],
            queued: [...this.queued.values()].map(({ repository, number, agent, priority }) => ({ repository, issue: number, agent, priority })),
            turns: [...this.turns],
            lastReconcile: this.lastReconcile,
        };
    }

    /** Listens to what happens; returns how to stop. */
    onEvent(listener: (event: LiveEvent) => void): () => void {
        this.listeners.add(listener);
        return () => void this.listeners.delete(listener);
    }

    /** Tells the listeners; an event from outside (the webhook) goes through here too. */
    announce(event: LiveEvent): void {
        for (const listener of this.listeners) {
            try {
                listener(event);
            } catch {
                // A listener that fails never stops the dispatcher.
            }
        }
    }

    /** What the turn of an issue printed: the running one, or the last one. */
    outputOf(repository: string, issue: number): TurnOutput | null {
        const kept = this.outputs.get(issueKey(repository, issue));
        return kept ? { ...kept.record, lines: kept.buffer.tail } : null;
    }

    /** Collects the output of a turn and sends its new lines every half second. */
    private follow(repository: string, issue: number, agent: string, startedAt: string) {
        const key = issueKey(repository, issue);
        const buffer = new OutputBuffer();
        const kept = { record: { repository, issue, agent, startedAt } as Omit<TurnOutput, 'lines'>, buffer };
        this.outputs.delete(key);
        this.outputs.set(key, kept);
        while (this.outputs.size > KEPT_OUTPUTS) this.outputs.delete(this.outputs.keys().next().value!);
        let pending: string[] = [];
        let timer: ReturnType<typeof setTimeout> | undefined;
        const flush = () => {
            timer = undefined;
            if (!pending.length) return;
            const lines = pending;
            pending = [];
            this.announce({ type: 'turn-output', at: this.at(), repository, issue, agent, lines });
        };
        return {
            onOutput: (chunk: string) => {
                pending.push(...buffer.add(this.mask(chunk)).map((line) => this.mask(line)));
                if (!timer) timer = setTimeout(flush, OUTPUT_EVERY);
            },
            end: (ended: { code: number; seconds: number; moved: boolean }) => {
                clearTimeout(timer);
                flush();
                kept.record = { ...kept.record, ended };
            },
        };
    }

    private at(): string {
        return new Date(this.now()).toISOString();
    }

    /** The workflow of a repository, read again after a while or when asked to. */
    async workflowOf(repository: string, fresh = false): Promise<Workflow | null> {
        const known = this.workflows.get(repository);
        if (!fresh && known && this.now() - known.at < (this.options.workflowTtl ?? 60_000)) return known.workflow;
        const workflow = await readWorkflow(this.github, repository);
        this.workflows.set(repository, { at: this.now(), workflow });
        return workflow;
    }

    /** Whether the issue gets a turn now; queues it when it does. Never throws. */
    async consider(repository: string, number: number, fresh = false): Promise<void> {
        const key = issueKey(repository, number);
        if (this.running.has(key)) return;
        try {
            const candidate = await this.candidate(repository, number, fresh);
            if (!candidate) {
                this.queued.delete(key);
                return;
            }
            if (!this.queued.has(key)) this.announce({ type: 'queued', at: this.at(), repository, issue: number, agent: candidate.agent });
            this.queued.set(key, candidate);
            this.pump();
        } catch (error) {
            this.log('could not consider the issue', { issue: key, error: (error as Error).message });
        }
    }

    private async candidate(repository: string, number: number, fresh: boolean): Promise<Candidate | null> {
        const workflow = await this.workflowOf(repository, fresh);
        if (!workflow || workflow.paused) return null;
        const issue = await this.github.request<Issue>('GET', `/repos/${repository}/issues/${number}`);
        if (issue.state !== 'open' || issue.pull_request) return null;
        const { needs } = workOf(workflow, issue.labels);
        if (!needs || !workflow.agents[needs]) return null;
        // An issue waits for the issues it is blocked by.
        const blockers = await this.github.request<{ state: string }[]>('GET', `/repos/${repository}/issues/${number}/dependencies/blocked_by`).catch(() => []);
        if (blockers.some((blocker) => blocker.state === 'open')) return null;
        return { repository, number, agent: needs, priority: await this.priorityOf(issue), created: Date.parse(issue.created_at) };
    }

    /** The Priority of the issue on its board; normal when it has none or it cannot be read. */
    private async priorityOf(issue: Issue): Promise<number> {
        if (!issue.node_id) return PRIORITY.normal;
        try {
            const data = await this.github.graphql<{ node: { projectItems: { nodes: { fieldValueByName: { name?: string } | null }[] } } }>(
                'query($id:ID!){node(id:$id){... on Issue{projectItems(first:5){nodes{fieldValueByName(name:"Priority"){... on ProjectV2ItemFieldSingleSelectValue{name}}}}}}}',
                { id: issue.node_id },
            );
            const names = data.node.projectItems.nodes.map((item) => item.fieldValueByName?.name?.toLowerCase()).filter((name): name is string => !!name && name in PRIORITY);
            return names.length ? Math.min(...names.map((name) => PRIORITY[name])) : PRIORITY.normal;
        } catch {
            return PRIORITY.normal;
        }
    }

    /** Starts the waiting turns while there is room, best first. */
    private pump(): void {
        while (this.running.size < this.options.maxParallel && this.queued.size) {
            const next = [...this.queued.values()].sort((a, b) => a.priority - b.priority || a.created - b.created)[0];
            const key = issueKey(next.repository, next.number);
            this.queued.delete(key);
            this.running.set(key, { repository: next.repository, issue: next.number, agent: next.agent });
            void this.turn(next).finally(() => {
                this.running.delete(key);
                // The labels it changed came while it ran: look at the issue again for the next agent.
                void this.consider(next.repository, next.number).finally(() => {
                    this.pump();
                    if (!this.running.size && !this.queued.size) for (const done of this.idle.splice(0)) done();
                });
            });
        }
    }

    /** Resolves once nothing runs and nothing waits. */
    settled(): Promise<void> {
        if (!this.running.size && !this.queued.size) return Promise.resolve();
        return new Promise((resolve) => this.idle.push(resolve));
    }

    private async turn(candidate: Candidate): Promise<void> {
        const { repository, number, agent } = candidate;
        const key = issueKey(repository, number);
        try {
            const workflow = await this.workflowOf(repository, true);
            const issue = await this.github.request<Issue>('GET', `/repos/${repository}/issues/${number}`);
            // Someone moved it while it waited.
            if (!workflow || workflow.paused || issue.state !== 'open' || workOf(workflow, issue.labels).needs !== agent || !workflow.agents[agent]) return;
            const settings = workflow.agents[agent];
            const token = await this.github.turnToken(repository, settings.permissions);
            const started = this.now();
            this.running.set(key, { repository, issue: number, agent, startedAt: this.at() });
            this.log('turn started', { issue: key, agent });
            this.announce({ type: 'turn-started', at: this.at(), repository, issue: number, agent });
            const output = this.follow(repository, number, agent, new Date(started).toISOString());
            const result = await this.runTurn({
                onOutput: output.onOutput,
                name: `playbook-${repository.replace(/[^A-Za-z0-9_.-]/g, '-')}-${number}`,
                timeout: this.options.turnTimeout,
                env: {
                    ...this.options.agentEnv,
                    PLAYBOOK_AGENT: settings.opencodeAgent,
                    PLAYBOOK_ISSUE: String(number),
                    PLAYBOOK_TIMEOUT: String(this.options.turnTimeout),
                    PLAYBOOK_BRANCH: workflow.workBranch,
                    GITHUB_REPOSITORY: repository,
                    GITHUB_TOKEN: token,
                },
            });
            const seconds = Math.round((this.now() - started) / 1000);
            this.turnLog.write(key, result.output);
            const after = await this.github.request<Issue>('GET', `/repos/${repository}/issues/${number}`);
            const moved = after.state !== 'open' || workOf(workflow, after.labels).needs !== agent;
            this.log('turn ended', { issue: key, agent, code: result.code, seconds, moved });
            output.end({ code: result.code, seconds, moved });
            this.turns.unshift({ repository, issue: number, agent, startedAt: new Date(started).toISOString(), seconds, code: result.code, moved });
            this.turns.splice(RECENT_TURNS);
            this.announce({ type: 'turn-ended', at: this.at(), repository, issue: number, agent, code: result.code, seconds, moved });
            if (moved) {
                this.failures.set(key, 0);
                return;
            }
            await this.failed(workflow, repository, number, agent, result.code, result.output);
        } catch (error) {
            this.log('turn could not run', { issue: key, agent, error: (error as Error).message });
        }
    }

    /** A turn that left the issue where it was: a comment, and past the limit a person takes it. */
    private async failed(workflow: Workflow, repository: string, number: number, agent: string, code: number, output: string): Promise<void> {
        const key = issueKey(repository, number);
        const failures = this.failures.get(key) + 1;
        const why = code === 124 ? 'it ran out of time' : code === 0 ? 'it ended without leaving the issue' : `it stopped with exit code ${code}`;
        const tail = output.trim().split('\n').slice(-15).join('\n');
        const name = workflow.agents[agent]?.name ?? agent;
        const base = `/repos/${repository}/issues/${number}`;
        if (failures < this.options.failuresToBlock) {
            this.failures.set(key, failures);
            await this.github.request('POST', `${base}/comments`, {
                body: `${MARKER({ event: 'turn-failed', agent })}\nThe turn of **${name}** failed: ${why}. It runs again (${failures}/${this.options.failuresToBlock}).\n\n\`\`\`\n${tail}\n\`\`\``,
            });
            return;
        }
        this.failures.set(key, 0);
        const { names } = workOf(workflow, (await this.github.request<Issue>('GET', base)).labels);
        for (const label of names.filter((name) => name.startsWith(workflow.needsPrefix) || name.startsWith(workflow.statusPrefix))) {
            await this.github.request('DELETE', `${base}/labels/${encodeURIComponent(label)}`).catch(() => undefined);
        }
        await this.github.request('POST', `${base}/labels`, { labels: [workflow.needsPrefix + workflow.human, workflow.statusPrefix + workflow.blocked] });
        await this.github.request('POST', `${base}/comments`, {
            body: `${MARKER({ event: 'limit', agent: 'dispatcher' })}\n**Dispatcher** → **Human** · ${workflow.statusPrefix}${workflow.blocked} · ${failures} turns of **${name}** failed in a row, the last because ${why}. A person looks at it, then hands it back with \`${workflow.needsPrefix}${agent}\`.\n\n\`\`\`\n${tail}\n\`\`\``,
        });
        this.log('issue handed to a person', { issue: key, agent, failures });
        this.announce({ type: 'handed', at: this.at(), repository, issue: number, agent, failures });
    }

    /** Every open issue that needs an agent, in every repository of the installation. */
    async reconcile(): Promise<void> {
        try {
            const repositories: string[] = [];
            for (let page = 1; ; page += 1) {
                const body = await this.github.request<{ repositories: { full_name: string; archived?: boolean }[] }>('GET', `/installation/repositories?per_page=100&page=${page}`);
                repositories.push(...body.repositories.filter((repository) => !repository.archived).map((repository) => repository.full_name));
                if (body.repositories.length < 100) break;
            }
            for (const repository of repositories) await this.reconcileRepository(repository);
            this.lastReconcile = new Date(this.now()).toISOString();
        } catch (error) {
            this.log('reconciliation failed', { error: (error as Error).message });
        }
    }

    async reconcileRepository(repository: string): Promise<void> {
        try {
            const workflow = await this.workflowOf(repository, true);
            if (!workflow || workflow.paused) return;
            for (let page = 1; ; page += 1) {
                const issues = await this.github.request<Issue[]>('GET', `/repos/${repository}/issues?state=open&per_page=100&page=${page}`);
                for (const issue of issues) {
                    const { needs } = workOf(workflow, issue.labels);
                    if (!issue.pull_request && needs && workflow.agents[needs]) await this.consider(repository, issue.number);
                }
                if (issues.length < 100) break;
            }
        } catch (error) {
            this.log('reconciliation of a repository failed', { repository, error: (error as Error).message });
        }
    }
}
