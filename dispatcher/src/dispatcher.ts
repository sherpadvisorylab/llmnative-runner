import type { GitHubApi } from './github.ts';
import type { RunTurn } from './docker.ts';
import { readWorkflow, workOf, type Workflow } from './workflow.ts';
import { OutputBuffer } from './output.ts';
import { answerOf, answeredComment, interruptedClaim, maybeAnswer, type IssueComment } from './answers.ts';
import { noteUsage, usageOfOutput, type TurnUsage } from './usage.ts';
import { knowledgeKeeper, type IssueState } from './knowledge.ts';
import { billedMinutes, failingLines, failureReport, gateVerdict, pendingGate, type GateComment, type RunJob, type WorkflowRun } from './ciGate.ts';
import { BYTES_PER_LINE, VALUATION_MODEL, VALUE_MARKER, agentSecondsOf, eslocOf, valuationComment, valuationOf, type PullFile } from './valuation.ts';

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
    /** CRs of a repository with their pull request open at once (MAX_CHANGES): 1, one change in flight. */
    maxChanges?: number;
}

export interface FailureStore {
    get(key: string): number;
    set(key: string, failures: number): void;
}

export type Log = (line: string, details?: Record<string, unknown>) => void;

/** A turn of an issue as it is kept: its agent, when it started, how long, how it ended. */
export type KeptTurn = { agent: string; startedAt: string; seconds: number; code: number; moved: boolean };

export interface TurnLog {
    /** Keeps what a turn printed, with its secrets masked; with the turn, also on its own, to be read again. */
    write(key: string, text: string, turn?: KeptTurn): void;
    /** The turns of an issue kept, oldest first, without their lines. */
    list?(key: string): Array<KeptTurn & { id: string; lineCount: number; cut: boolean }>;
    /** One turn kept, with its lines. */
    read?(key: string, id: string): (KeptTurn & { id: string; lineCount: number; cut: boolean; lines: string[] }) | null;
}

type Issue = {
    number: number;
    state: string;
    created_at: string;
    node_id?: string;
    comments?: number;
    pull_request?: unknown;
    labels: Array<string | { name?: string }>;
};

/** `rank`: the priority of its repository; `priority`: its own (the Priority of the board). */
type Candidate = { repository: string; number: number; agent: string; rank: number; priority: number; created: number };

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
export type TurnRecord = { repository: string; issue: number; agent: string; startedAt: string; seconds: number; code: number; moved: boolean; usage?: TurnUsage };

/** What the container of a turn takes now: CPU (percent of one core), memory and its limit, in bytes. */
export type TurnStats = { cpu: number; memory: number; limit: number };
type Running = { repository: string; issue: number; agent: string; startedAt?: string; name?: string };

/** The size of each repository in equivalent source lines, and the CRs already valued in it. */
export interface SizeStore {
    get(repository: string): { size?: number; valued: number[]; model?: number };
    set(repository: string, value: { size?: number; valued: number[]; model?: number }): void;
}


const RECENT_TURNS = 100;
/** Outputs kept for the studio: the turns running, and the last ones that ended. */
const KEPT_OUTPUTS = 30;
/** How often new lines go out together, in ms. */
const OUTPUT_EVERY = 500;

const PRIORITY: Record<string, number> = { high: 0, normal: 1, low: 2 };
/** The most of a spec put in the body of an Action (an issue takes 65536 characters in all). */
const SPEC_MAX = 50_000;
const MARKER = (data: object) => `<!-- playbook ${JSON.stringify(data)} -->`;
/** When GitHub has not yet worked out whether a pull request merges: looked at again after this. */
const CONFLICTS_AGAIN_MS = 60_000;
/** While an item waits at the CI gate, its repository is looked at again after this. */
const GATE_AGAIN_MS = 60_000;
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
    /** The repositories whose pull requests are looked at again shortly (GitHub was still working out whether they merge). */
    private readonly conflictsAgain = new Set<string>();
    private readonly gatesAgain = new Set<string>();
    lastReconcile?: string;

    private readonly sizes?: SizeStore;
    private readonly measure?: (names: string[]) => Promise<Record<string, TurnStats>>;
    private readonly fetchMemory: typeof fetch;

    constructor(deps: { github: GitHubApi; runTurn: RunTurn; failures: FailureStore; options: DispatcherOptions; log: Log; turnLog: TurnLog; now?: () => number; mask?: (text: string) => string; sizes?: SizeStore; stats?: (names: string[]) => Promise<Record<string, TurnStats>>; fetchMemory?: typeof fetch }) {
        this.fetchMemory = deps.fetchMemory ?? fetch;
        this.sizes = deps.sizes;
        this.measure = deps.stats;
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

    /** The turns of an issue kept on the machine, oldest first, without their lines. */
    turnsOf(repository: string, issue: number) {
        return this.turnLog.list?.(issueKey(repository, issue)) ?? [];
    }

    /** One turn of an issue kept on the machine, with its lines. */
    turnOf(repository: string, issue: number, id: string) {
        return this.turnLog.read?.(issueKey(repository, issue), id) ?? null;
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
            // Two events of the same issue a moment apart: the other may have started its turn while
            // this one read GitHub. One turn per issue, never two containers of the same name.
            if (this.running.has(key)) return;
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
        // The changes in flight: the agent that starts the code of a CR waits while `maxChanges` other
        // CRs have their pull request open (a merge, a push, looks at the repository again). A CR whose
        // pull request is open is in flight already and always goes on: otherwise CRs past the limit
        // (the limit lowered, two started together) would wait for each other forever.
        if (workflow.agents[needs].opensPullRequests) {
            const inFlight = await this.changesInFlight(repository);
            if (!inFlight.includes(number) && inFlight.length >= (this.options.maxChanges ?? 1)) return null;
        }
        return { repository, number, agent: needs, rank: PRIORITY[workflow.priority] ?? PRIORITY.normal, priority: await this.priorityOf(issue), created: Date.parse(issue.created_at) };
    }

    /** The CRs of the repository with their pull request open (`playbook/issue-<n>`). */
    private async changesInFlight(repository: string): Promise<number[]> {
        const pulls = await this.github.request<Array<{ head?: { ref?: string } }>>('GET', `/repos/${repository}/pulls?state=open&per_page=100`).catch(() => []);
        return pulls
            .map((pull) => Number(/^playbook\/issue-(\d+)$/.exec(pull.head?.ref ?? '')?.[1]))
            .filter((other) => other > 0);
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
            // The project of higher priority first, then the Priority of the issue, then the oldest.
            const next = [...this.queued.values()].sort((a, b) => a.rank - b.rank || a.priority - b.priority || a.created - b.created)[0]!;
            const key = issueKey(next.repository, next.number);
            this.queued.delete(key);
            if (this.running.has(key)) continue;
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
            const name = `playbook-${repository.replace(/[^A-Za-z0-9_.-]/g, '-')}-${number}`;
            this.running.set(key, { repository, issue: number, agent, startedAt: this.at(), name });
            this.log('turn started', { issue: key, agent });
            this.announce({ type: 'turn-started', at: this.at(), repository, issue: number, agent });
            const output = this.follow(repository, number, agent, new Date(started).toISOString());
            const result = await this.runTurn({
                onOutput: output.onOutput,
                name,
                timeout: this.options.turnTimeout,
                env: {
                    ...this.options.agentEnv,
                    PLAYBOOK_AGENT: settings.opencodeAgent,
                    PLAYBOOK_ISSUE: String(number),
                    PLAYBOOK_TIMEOUT: String(this.options.turnTimeout),
                    PLAYBOOK_BRANCH: workflow.workBranch,
                    GITHUB_REPOSITORY: repository,
                    GITHUB_TOKEN: token,
                    // Run by Claude Code (with the subscription of the organization): the engine and how much it reasons.
                    ...(settings.engine === 'claude-code' ? { PLAYBOOK_ENGINE: 'claude-code', ...(settings.effort ? { PLAYBOOK_EFFORT: settings.effort } : {}) } : {}),
                },
            });
            const seconds = Math.round((this.now() - started) / 1000);
            const after = await this.github.request<Issue>('GET', `/repos/${repository}/issues/${number}`).catch((error: Error) => {
                // Its output is kept all the same.
                this.turnLog.write(key, result.output);
                throw error;
            });
            const moved = after.state !== 'open' || workOf(workflow, after.labels).needs !== agent;
            this.turnLog.write(key, result.output, { agent, startedAt: new Date(started).toISOString(), seconds, code: result.code, moved });
            this.log('turn ended', { issue: key, agent, code: result.code, seconds, moved });
            output.end({ code: result.code, seconds, moved });
            const usage = usageOfOutput(result.output);
            this.turns.unshift({ repository, issue: number, agent, startedAt: new Date(started).toISOString(), seconds, code: result.code, moved, ...(usage ? { usage: { ...usage, seconds } } : {}) });
            this.turns.splice(RECENT_TURNS);
            this.announce({ type: 'turn-ended', at: this.at(), repository, issue: number, agent, code: result.code, seconds, moved });
            if (moved) this.failures.set(key, 0);
            else await this.failed(workflow, repository, number, agent, result.code, result.output);
            // What it cost, on the comment of the turn (its exit, or its failure): kept with the issue.
            if (usage) {
                await noteUsage(this.github, repository, number, agent, new Date(started - 1000).toISOString(), { ...usage, seconds })
                    .catch((error) => this.log('usage not noted', { issue: key, error: (error as Error).message }));
            }
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
            body: `${MARKER({ event: 'limit', agent: 'dispatcher', of: agent })}\n**Dispatcher** → **Human** · ${workflow.statusPrefix}${workflow.blocked} · ${failures} turns of **${name}** failed in a row, the last because ${why}. A person looks at it, then hands it back with \`${workflow.needsPrefix}${agent}\`.\n\n\`\`\`\n${tail}\n\`\`\``,
        });
        this.log('issue handed to a person', { issue: key, agent, failures });
        this.announce({ type: 'handed', at: this.at(), repository, issue: number, agent, failures });
    }

    /**
     * A new comment on an issue: when a person answered one waiting for a person, it goes back to the
     * agent that asked, with their answer, and gets its turn. Never throws.
     */
    async answered(repository: string, number: number, comment: IssueComment): Promise<void> {
        const key = issueKey(repository, number);
        try {
            if (!maybeAnswer(comment)) return;
            const workflow = await this.workflowOf(repository, true);
            if (!workflow?.answered) return;
            const base = `/repos/${repository}/issues/${number}`;
            const issue = await this.github.request<Issue>('GET', base);
            if (issue.state !== 'open' || issue.pull_request || workOf(workflow, issue.labels).needs !== workflow.human) return;
            const comments: IssueComment[] = [];
            for (let page = 1; ; page += 1) {
                const batch = await this.github.request<IssueComment[]>('GET', `${base}/comments?per_page=100&page=${page}`);
                comments.push(...batch);
                if (batch.length < 100) break;
            }
            const { asker, answers } = answerOf(workflow, comments);
            if (!asker || !workflow.agents[asker] || !answers.length) return;
            const by = answers.at(-1)!.user?.login || 'someone';
            const { names } = workOf(workflow, issue.labels);
            for (const label of names.filter((name) => name.startsWith(workflow.needsPrefix) || name.startsWith(workflow.statusPrefix))) {
                await this.github.request('DELETE', `${base}/labels/${encodeURIComponent(label)}`).catch(() => undefined);
            }
            await this.github.request('POST', `${base}/labels`, { labels: [workflow.needsPrefix + asker, workflow.statusPrefix + workflow.answered.status] });
            await this.github.request('POST', `${base}/comments`, { body: answeredComment(workflow, by, asker, answers) });
            this.log('answer handed back', { issue: key, agent: asker, by });
            this.announce({ type: 'issue', at: this.at(), repository, issue: number, action: 'answered' });
            await this.consider(repository, number, true);
        } catch (error) {
            this.log('could not hand an answer back', { issue: key, error: (error as Error).message });
        }
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

    /**
     * The sources merged in sources/: one Action (an Epic) each for the agent of the Source channel, with
     * its `needs:` and `status:` labels, unless one with the same title exists already. Nothing when the
     * workflow has no Source channel.
     */
    async openSources(repository: string, folders: string[]): Promise<number[]> {
        const opened: number[] = [];
        try {
            const workflow = await this.workflowOf(repository, true);
            if (!workflow?.sources || !workflow.agents[workflow.sources.to]) {
                if (folders.length) this.log('sources merged, no Source channel in the workflow', { repository, sources: folders });
                return opened;
            }
            const status = `${workflow.statusPrefix}${workflow.sources.status}`;
            // The Actions of the sources already opened, whatever their status now (split, blocked,
            // closed): by title, among every issue of the repository.
            const known = new Set<string>();
            for (let page = 1; page <= 20; page += 1) {
                const batch = await this.github.request<Array<{ title: string; pull_request?: unknown }>>('GET', `/repos/${repository}/issues?state=all&per_page=100&page=${page}`);
                for (const issue of batch) if (!issue.pull_request && issue.title.startsWith('Source: ')) known.add(issue.title);
                if (batch.length < 100) break;
            }
            for (const folder of folders) {
                const title = `Source: ${folder}`;
                if (known.has(title)) continue;
                known.add(title);
                const specs = await this.specsOf(repository, folder);
                const body = [
                    `A source was merged in \`${folder}\`. Digest it: the activities it holds, and the knowledge it settles proposed in the memory, each with its source.`,
                    // The spec a design session wrote with to-spec: the issue Matt's method publishes, here.
                    ...specs.flatMap((spec) => ['', `## Spec: \`${spec.path}\``, '', spec.content]),
                    '',
                    MARKER({ source: folder }),
                ].join('\n');
                const labels = [`${workflow.needsPrefix}${workflow.sources.to}`, status];
                // An Action is an Epic; an organization without issue types gets the issue all the same.
                const issue = await this.github.request<{ number: number }>('POST', `/repos/${repository}/issues`, { title, body, labels, type: 'Epic' })
                    .catch(() => this.github.request<{ number: number }>('POST', `/repos/${repository}/issues`, { title, body, labels }));
                opened.push(issue.number);
                this.log('source opened', { repository, source: folder, issue: issue.number });
                this.announce({ type: 'issue', at: new Date().toISOString(), repository, issue: issue.number, action: 'source' });
            }
        } catch (error) {
            this.log('sources could not be opened', { repository, sources: folders, error: (error as Error).message });
        }
        return opened;
    }

    /**
     * The specs in a source (`.scratch/<feature>/spec.md`, the issue tracker as local markdown of
     * mattpocock/skills), each cut to fit in the body of an issue.
     */
    private async specsOf(repository: string, folder: string): Promise<Array<{ path: string; content: string }>> {
        const path = (value: string) => value.split('/').map(encodeURIComponent).join('/');
        const features = await this.github.request<Array<{ type: string; path: string }>>('GET', `/repos/${repository}/contents/${path(`${folder}/.scratch`)}`).catch(() => []);
        const specs: Array<{ path: string; content: string }> = [];
        for (const feature of (Array.isArray(features) ? features : []).filter((entry) => entry.type === 'dir')) {
            const file = await this.github.request<{ content?: string; encoding?: string }>('GET', `/repos/${repository}/contents/${path(`${feature.path}/spec.md`)}`).catch(() => undefined);
            if (!file?.content || file.encoding !== 'base64') continue;
            const content = Buffer.from(file.content, 'base64').toString('utf8');
            specs.push({ path: `${feature.path}/spec.md`, content: content.length > SPEC_MAX ? `${content.slice(0, SPEC_MAX)}\n\n_(cut here: the whole spec is in the file)_` : content });
        }
        return specs;
    }

    /**
     * The pull requests of the CRs (`playbook/issue-<n>`) that no longer merge into the working branch,
     * another change merged first: each CR goes to whoever the workflow says solves conflicts, with the
     * status for it, unless it is there already, a person has it or its turn is running. GitHub works
     * out whether a pull request merges after a push: one still unknown is looked at again in a minute.
     */
    async conflicts(repository: string, workflow: Workflow): Promise<number[]> {
        const sent: number[] = [];
        const settings = workflow.conflicts;
        if (!settings) return sent;
        const to = settings.to === workflow.human || workflow.agents[settings.to] ? settings.to : workflow.human;
        let unknown = false;
        const pulls = await this.github.request<Array<{ number: number; head?: { ref?: string }; base?: { ref?: string } }>>('GET', `/repos/${repository}/pulls?state=open&per_page=100`).catch(() => []);
        for (const pull of pulls) {
            const number = Number(/^playbook\/issue-(\d+)$/.exec(pull.head?.ref ?? '')?.[1]);
            if (!number || pull.base?.ref !== workflow.workBranch) continue;
            const key = issueKey(repository, number);
            try {
                const detail = await this.github.request<{ mergeable: boolean | null; mergeable_state?: string }>('GET', `/repos/${repository}/pulls/${pull.number}`);
                if (detail.mergeable === null) {
                    unknown = true;
                    continue;
                }
                if (detail.mergeable || detail.mergeable_state !== 'dirty' || this.running.has(key)) continue;
                const base = `/repos/${repository}/issues/${number}`;
                const issue = await this.github.request<Issue>('GET', base);
                const { needs, status, names } = workOf(workflow, issue.labels);
                if (issue.state !== 'open' || status === settings.status || needs === workflow.human) continue;
                for (const label of names.filter((name) => name.startsWith(workflow.needsPrefix) || name.startsWith(workflow.statusPrefix))) {
                    await this.github.request('DELETE', `${base}/labels/${encodeURIComponent(label)}`).catch(() => undefined);
                }
                await this.github.request('POST', `${base}/labels`, { labels: [workflow.needsPrefix + to, workflow.statusPrefix + settings.status] });
                const name = to === workflow.human ? 'Human' : workflow.agents[to]?.name ?? to;
                await this.github.request('POST', `${base}/comments`, {
                    body: `${MARKER({ event: 'conflict', agent: 'dispatcher', to, status: settings.status, pull: pull.number, ...(needs ? { from: needs } : {}) })}\n`
                        + `**Dispatcher** → **${name}** · ${workflow.statusPrefix}${settings.status} · conflicts\n\n`
                        + `The pull request #${pull.number} no longer merges into \`${workflow.workBranch}\`: another change merged first. `
                        + `Merge \`${workflow.workBranch}\` into \`${pull.head?.ref}\`, solve the conflicts keeping both changes, run the tests again and push, then leave as usual${needs ? ` (it was with ${workflow.agents[needs]?.name ?? needs})` : ''}.`,
                });
                sent.push(number);
                this.log('conflicts handed over', { issue: key, pull: pull.number, to });
                this.announce({ type: 'issue', at: this.at(), repository, issue: number, action: 'conflicts' });
            } catch (error) {
                this.log('could not look at a pull request', { issue: key, pull: pull.number, error: (error as Error).message });
            }
        }
        if (unknown && !this.conflictsAgain.has(repository)) {
            this.conflictsAgain.add(repository);
            setTimeout(() => {
                this.conflictsAgain.delete(repository);
                void this.reconcileRepository(repository);
            }, CONFLICTS_AGAIN_MS).unref?.();
        }
        return sent;
    }

    /**
     * The items waiting at the CI gate (`needs:ci`): the runs of Actions on the commit each was handed over
     * with decide where it goes. On to the agent of its route when they passed (or the repository has no
     * Actions), back to the agent that left with the status of a failed CI and what failed, to a person
     * past the time the CI may take. While any waits, the repository is looked at again every minute.
     * Returns the items moved.
     */
    async ciGates(repository: string, workflow: Workflow): Promise<number[]> {
        const moved: number[] = [];
        const ci = workflow.ci;
        if (!ci) return moved;
        const waiting = await this.github.request<Issue[]>('GET', `/repos/${repository}/issues?state=open&labels=${encodeURIComponent(workflow.needsPrefix + ci.needs)}&per_page=100`).catch(() => [] as Issue[]);
        let pending = false;
        let workflows: number | undefined;
        for (const issue of waiting.filter((candidate) => !candidate.pull_request)) {
            const key = issueKey(repository, issue.number);
            try {
                const base = `/repos/${repository}/issues/${issue.number}`;
                const last = Math.max(1, Math.ceil((typeof issue.comments === 'number' ? issue.comments : 0) / 100));
                const comments: GateComment[] = [];
                for (const page of last > 1 ? [last - 1, last] : [last]) comments.push(...await this.github.request<GateComment[]>('GET', `${base}/comments?per_page=100&page=${page}`));
                const gate = pendingGate(comments);
                // Put there by a person, not by a route: nothing to wait for, a person decides.
                if (!gate) continue;
                const route = ci.routes[gate.route] ?? { from: gate.from, to: gate.to, status: gate.status };
                const runs = (await this.github.request<{ workflow_runs?: WorkflowRun[] }>('GET', `/repos/${repository}/actions/runs?head_sha=${gate.sha}&per_page=50`)).workflow_runs ?? [];
                if (!runs.length && workflows === undefined) workflows = (await this.github.request<{ total_count?: number }>('GET', `/repos/${repository}/actions/workflows?per_page=1`).catch(() => ({ total_count: 0 }))).total_count ?? 0;
                const verdict = gateVerdict(runs, workflows ?? 1, this.now() - gate.at, ci.timeoutMinutes);
                if (verdict === 'wait') {
                    pending = true;
                    continue;
                }
                const jobs: RunJob[] = [];
                for (const run of runs) jobs.push(...((await this.github.request<{ jobs?: RunJob[] }>('GET', `/repos/${repository}/actions/runs/${run.id}/jobs?per_page=100`).catch(() => ({ jobs: [] }))).jobs ?? []));
                const minutes = billedMinutes(jobs);
                const short = gate.sha.slice(0, 7);
                const runLinks = runs.map((run) => `[${run.name ?? 'run'}](${run.html_url})`).join(', ');
                const fromName = workflow.agents[route.from]?.name ?? route.from;
                const toName = route.to === 'closed' ? 'Closed' : workflow.agents[route.to]?.name ?? route.to;
                let needs: string;
                let status: string;
                let body: string;
                if (verdict === 'passed' || verdict === 'none') {
                    needs = route.to === 'closed' ? 'none' : route.to;
                    status = route.status;
                    body = verdict === 'none'
                        ? `**CI** → **${toName}** · ${workflow.statusPrefix}${status} · no CI in this repository: the gate passes.`
                        : `**CI** → **${toName}** · ${workflow.statusPrefix}${status} · passed on ${short} (${minutes} min)${runLinks ? ` · ${runLinks}` : ''}`;
                } else if (verdict === 'failed') {
                    needs = route.from;
                    status = ci.failed;
                    const failed: Array<{ job: RunJob; lines: string[] }> = [];
                    for (const job of jobs.filter((candidate) => candidate.conclusion && !['success', 'skipped', 'neutral'].includes(candidate.conclusion)).slice(0, 3)) {
                        const log = this.github.text ? await this.github.text(`/repos/${repository}/actions/jobs/${job.id}/logs`).catch(() => '') : '';
                        failed.push({ job, lines: log ? failingLines(log) : [] });
                    }
                    body = `**CI** → **${fromName}** · ${workflow.statusPrefix}${status} · failed on ${short} (${minutes} min)${runLinks ? ` · ${runLinks}` : ''}

${failureReport(failed)}`;
                } else {
                    needs = workflow.human;
                    status = workflow.blocked;
                    body = `**CI** → **Human** · ${workflow.statusPrefix}${status} · no result of the CI on ${short} in ${ci.timeoutMinutes} minutes${runLinks ? ` · ${runLinks}` : ''}. Check that GitHub Actions runs on the pull requests of this repository, then hand it back to ${fromName}.`;
                }
                const fresh = await this.github.request<Issue>('GET', base);
                // Moved meanwhile by a person: theirs to decide.
                if (fresh.state !== 'open' || workOf(workflow, fresh.labels).needs !== ci.needs) continue;
                for (const label of workOf(workflow, fresh.labels).names.filter((name) => name.startsWith(workflow.needsPrefix) || name.startsWith(workflow.statusPrefix))) {
                    await this.github.request('DELETE', `${base}/labels/${encodeURIComponent(label)}`).catch(() => undefined);
                }
                await this.github.request('POST', `${base}/labels`, { labels: [workflow.needsPrefix + needs, workflow.statusPrefix + status] });
                await this.github.request('POST', `${base}/comments`, {
                    body: `${MARKER({ event: 'gate', agent: 'dispatcher', route: gate.route, result: verdict, to: needs, status, sha: gate.sha, minutes })}
${body}`,
                });
                if (needs === 'none') await this.github.request('PATCH', base, { state: 'closed', state_reason: 'completed' });
                moved.push(issue.number);
                this.log('ci gate settled', { issue: key, verdict, minutes, to: needs });
                this.announce({ type: 'issue', at: this.at(), repository, issue: issue.number, action: `ci-${verdict}` });
            } catch (error) {
                pending = true;
                this.log('could not look at the CI of an item', { issue: key, error: (error as Error).message });
            }
        }
        if (pending && !this.gatesAgain.has(repository)) {
            this.gatesAgain.add(repository);
            setTimeout(() => {
                this.gatesAgain.delete(repository);
                void this.reconcileRepository(repository);
            }, GATE_AGAIN_MS).unref?.();
        }
        return moved;
    }

    /** What the container of the running turn of an issue takes now, measured when asked; null when none runs. */
    async statsOf(repository: string, issue: number): Promise<TurnStats | null> {
        const turn = this.running.get(issueKey(repository, issue));
        if (!turn?.name || !this.measure) return null;
        try {
            return (await this.measure([turn.name]))[turn.name] ?? null;
        } catch {
            return null;
        }
    }

    /**
     * The human-equivalent effort of a closed CR, written on it once: its merged pull request
     * (`playbook/issue-<n>`) measured in equivalent source lines, against the size of the project
     * before it (the first time read from the bytes of its languages, less this CR) and the hours its
     * agents worked. Nothing without a merged pull request. Never throws.
     */
    async valuate(repository: string, number: number): Promise<boolean> {
        if (!this.sizes) return false;
        const known = this.sizes.get(repository);
        if (known.valued.includes(number)) return false;
        const done = (size = known.size) => this.sizes!.set(repository, { ...(size !== undefined ? { size } : {}), valued: [...known.valued, number].slice(-2000), model: VALUATION_MODEL });
        try {
            const base = `/repos/${repository}/issues/${number}`;
            const issue = await this.github.request<Issue & { closed_at?: string }>('GET', base);
            if (issue.state !== 'closed') return false;
            const comments: Array<{ body?: string | null; created_at?: string }> = [];
            for (let page = 1; page <= 10; page += 1) {
                const batch = await this.github.request<Array<{ body?: string | null; created_at?: string }>>('GET', `${base}/comments?per_page=100&page=${page}`);
                comments.push(...batch);
                if (batch.length < 100) break;
            }
            // Valued already: again only with an older model, on the same comment and the same size before it.
            const valued = comments.find((comment) => VALUE_MARKER.test(comment.body ?? '')) as { id?: number; body?: string | null } | undefined;
            let previous: { model?: number; sizeBefore?: number } | undefined;
            if (valued) {
                try {
                    previous = JSON.parse(VALUE_MARKER.exec(valued.body ?? '')![1]);
                } catch {
                    previous = {};
                }
                if ((previous?.model ?? 1) >= VALUATION_MODEL || !valued.id) {
                    done();
                    return false;
                }
            }
            const owner = repository.split('/')[0];
            const pulls = await this.github.request<Array<{ number: number; merged_at?: string | null }>>('GET', `/repos/${repository}/pulls?state=closed&head=${encodeURIComponent(`${owner}:playbook/issue-${number}`)}&per_page=10`);
            const pull = pulls.find((candidate) => candidate.merged_at);
            if (!pull) {
                done();
                return false;
            }
            const files: PullFile[] = [];
            for (let page = 1; page <= 30; page += 1) {
                const batch = await this.github.request<PullFile[]>('GET', `/repos/${repository}/pulls/${pull.number}/files?per_page=100&page=${page}`);
                files.push(...batch);
                if (batch.length < 100) break;
            }
            let before = previous?.sizeBefore ?? known.size;
            if (before === undefined) {
                // The first CR valued: the project as it is now, less this CR.
                const languages = await this.github.request<Record<string, number>>('GET', `/repos/${repository}/languages`).catch(() => ({} as Record<string, number>));
                const lines = Object.values(languages).reduce((total, bytes) => total + bytes, 0) / BYTES_PER_LINE;
                before = Math.max(0, Math.round(lines - eslocOf(files).esloc));
            }
            const value = valuationOf(pull.number, before, files, agentSecondsOf(comments));
            if (valued?.id) {
                await this.github.request('PATCH', `/repos/${repository}/issues/comments/${valued.id}`, { body: valuationComment(value) });
                done();
            } else {
                await this.github.request('POST', `${base}/comments`, { body: valuationComment(value) });
                done(value.sizeAfter);
            }
            this.log('CR valued', { issue: issueKey(repository, number), pull: pull.number, esloc: value.esloc, cocomoHours: value.cocomoHours, agentHours: value.agentHours });
            this.announce({ type: 'issue', at: this.at(), repository, issue: number, action: 'valued' });
            return true;
        } catch (error) {
            this.log('could not value a CR', { issue: issueKey(repository, number), error: (error as Error).message });
            return false;
        }
    }

    /** The CRs closed in the last week not valued yet, in the order they closed (the size of the project grows with each). */
    /**
     * The knowledge of the repository follows its CRs: the proposals of a CR closed done in force, those
     * of one discarded refused, those digested from a design source in force (in the memory of the
     * company, under the repository; nothing without a memory).
     */
    private async settleKnowledge(repository: string, tag?: string): Promise<void> {
        let memory: { url?: string; apiKey?: string } | undefined;
        try {
            memory = JSON.parse(this.options.agentEnv.PLAYBOOK_MEMORY ?? '');
        } catch {
            return;
        }
        if (!memory?.url || !memory.apiKey) return;
        const stateOf = async (number: number): Promise<IssueState | undefined> => {
            const issue = await this.github.request<{ state: string; state_reason?: string | null }>('GET', `/repos/${repository}/issues/${number}`).catch(() => undefined);
            if (!issue) return undefined;
            return issue.state !== 'closed' ? 'open' : issue.state_reason === 'not_planned' ? 'discarded' : 'done';
        };
        try {
            const { confirmed, rejected } = await knowledgeKeeper({ url: memory.url, apiKey: memory.apiKey }, this.fetchMemory).settle(tag || repository.toLowerCase().replace('/', ':'), stateOf);
            if (confirmed.length || rejected.length) this.log('knowledge settled', { repository, confirmed: confirmed.length, rejected: rejected.length });
        } catch (error) {
            this.log('knowledge not settled', { repository, error: (error as Error).message });
        }
    }

    private async valuateClosed(repository: string): Promise<void> {
        if (!this.sizes) return;
        const since = new Date(this.now() - 7 * 86_400_000).toISOString();
        const closed = await this.github.request<Array<Issue & { closed_at?: string }>>('GET', `/repos/${repository}/issues?state=closed&since=${encodeURIComponent(since)}&per_page=100`).catch(() => []);
        // A new model: the CRs valued with the older one are looked at again.
        const stored = this.sizes.get(repository);
        if ((stored.model ?? 1) < VALUATION_MODEL) this.sizes.set(repository, { ...stored, valued: [], model: VALUATION_MODEL });
        const valued = this.sizes.get(repository).valued;
        const todo = closed
            .filter((issue) => !issue.pull_request && issue.closed_at && !valued.includes(issue.number))
            .sort((a, b) => Date.parse(a.closed_at!) - Date.parse(b.closed_at!));
        for (const issue of todo) await this.valuate(repository, issue.number);
    }

    /**
     * An issue claimed by a turn that stopped without ending (the dispatcher restarted and removed it):
     * back to the status it had before the claim, with a comment, so nobody reads it as at work. The
     * reconciliation then starts the turn again.
     */
    private async resumeInterrupted(repository: string, workflow: Workflow, issue: Issue): Promise<void> {
        const key = issueKey(repository, issue.number);
        const { needs, status } = workOf(workflow, issue.labels);
        if (!needs || this.running.has(key) || this.queued.has(key)) return;
        const agent = workflow.agents[needs];
        if (!agent || status !== (agent.claim ?? `in-${needs}`)) return;
        try {
            const base = `/repos/${repository}/issues/${issue.number}`;
            // The last two pages of the comments: the claim and the move before it.
            const last = Math.max(1, Math.ceil((typeof issue.comments === 'number' ? issue.comments : 0) / 100));
            const comments: IssueComment[] = [];
            for (const page of last > 1 ? [last - 1, last] : [last]) comments.push(...await this.github.request<IssueComment[]>('GET', `${base}/comments?per_page=100&page=${page}`));
            const interrupted = interruptedClaim(needs, comments);
            if (!interrupted || this.running.has(key)) return;
            if (interrupted.from && interrupted.from !== status) {
                await this.github.request('DELETE', `${base}/labels/${encodeURIComponent(workflow.statusPrefix + status)}`).catch(() => undefined);
                await this.github.request('POST', `${base}/labels`, { labels: [workflow.statusPrefix + interrupted.from] });
            }
            const back = interrupted.from && interrupted.from !== status ? ` It goes back to ${workflow.statusPrefix}${interrupted.from}` : ' It';
            await this.github.request('POST', `${base}/comments`, {
                body: `${MARKER({ event: 'interrupted', agent: needs, ...(interrupted.from ? { status: interrupted.from } : {}) })}
The turn of **${agent.name}** stopped without ending (the dispatcher restarted).${back} runs again when a worker is free.`,
            });
            this.log('interrupted turn resumed', { issue: key, agent: needs, status: interrupted.from });
        } catch (error) {
            this.log('interrupted turn not resumed', { issue: key, error: (error as Error).message });
        }
    }

    async reconcileRepository(repository: string): Promise<void> {
        try {
            const workflow = await this.workflowOf(repository, true);
            if (!workflow || workflow.paused) return;
            await this.conflicts(repository, workflow);
            await this.ciGates(repository, workflow);
            await this.valuateClosed(repository);
            await this.settleKnowledge(repository, workflow.knowledgeTag);
            for (let page = 1; ; page += 1) {
                const issues = await this.github.request<Issue[]>('GET', `/repos/${repository}/issues?state=open&per_page=100&page=${page}`);
                for (const issue of issues) {
                    const { needs } = workOf(workflow, issue.labels);
                    if (issue.pull_request || !needs || !workflow.agents[needs]) continue;
                    await this.resumeInterrupted(repository, workflow, issue);
                    await this.consider(repository, issue.number);
                }
                if (issues.length < 100) break;
            }
        } catch (error) {
            this.log('reconciliation of a repository failed', { repository, error: (error as Error).message });
        }
    }
}
