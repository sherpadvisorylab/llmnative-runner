import { randomBytes } from 'node:crypto';
import type { ChatHost } from './chats.ts';
import { CLAUDE_CODE, accountKey, candidateEnv, connectedAccounts, outOfCredit, type Candidate } from './providers.ts';

// One answer of Claude Code with the subscription of an organization, for a project other than its studio (a
// CRM and its agents): the prompt in, the text out. No repository, no tool: a short-lived container of the chat
// image, removed at once. The project reaches it with the completion token of the organization (its .env,
// DISPATCHER_COMPLETION_TOKEN), sent by the studio.

/** The models a project names: the aliases of Claude Code, or a full id of a Claude model. */
export const COMPLETION_MODELS = ['haiku', 'sonnet', 'opus'] as const;
const MODEL_PATTERN = /^[a-z0-9][a-z0-9.\-]{1,60}$/;
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export const COMPLETION_PROMPT_MAX = 200_000;
/** How long an answer may take. */
export const COMPLETION_TIMEOUT_MS = 5 * 60_000;
/** Answers at once for one organization: the others are told to come back. */
export const COMPLETION_PARALLEL = 2;
/** Where the prompt is written in the container: a prompt of some hundred KB fits no variable. */
const PROMPT_FILE = '/tmp/playbook-prompt.txt';
/** Every tool of Claude Code: it only answers text. */
const NO_TOOLS = 'Edit Write NotebookEdit Bash WebFetch WebSearch Read Glob Grep Task';

export type CompletionRequest = { prompt: string; model: string; effort?: (typeof EFFORTS)[number] };
export type CompletionAnswer = { text: string; usage?: { inputTokens: number; outputTokens: number } };

export class CompletionError extends Error {
    readonly status: number;

    constructor(message: 'invalid' | 'no-provider' | 'no-credit' | 'busy' | 'failed' | 'timeout', status: number) {
        super(message);
        this.status = status;
    }
}

/** The request of a project, checked: undefined when it is not one. */
export function completionRequestOf(body: unknown): CompletionRequest | undefined {
    const value = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const { prompt, model, effort } = value;
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > COMPLETION_PROMPT_MAX) return undefined;
    if (typeof model !== 'string' || !MODEL_PATTERN.test(model)) return undefined;
    if (!(COMPLETION_MODELS as readonly string[]).includes(model) && !model.startsWith('claude-')) return undefined;
    if (effort !== undefined && !(EFFORTS as readonly unknown[]).includes(effort)) return undefined;
    return { prompt, model, ...(effort ? { effort: effort as CompletionRequest['effort'] } : {}) };
}

/** Claude Code once, on the prompt in its file (else in PLAYBOOK_PROMPT), every tool refused, the subscription only. */
export function completionScript(fromFile: boolean): string {
    const input = fromFile ? `cat ${PROMPT_FILE}` : `printf '%s' "$PLAYBOOK_PROMPT"`;
    return `cd /tmp && ${input} | env -u ANTHROPIC_API_KEY -u PLAYBOOK_PROMPT DISABLE_AUTOUPDATER=1 claude -p --output-format stream-json --verbose --model "$PLAYBOOK_MODEL"\${PLAYBOOK_EFFORT:+ --effort "$PLAYBOOK_EFFORT"} --disallowedTools ${NO_TOOLS}`;
}

/** The answer in the stream-json of Claude Code: its result event, with the tokens it used. */
export function completionResultOf(output: string): { ok: true; answer: CompletionAnswer } | { ok: false; message: string } | undefined {
    let found: { ok: true; answer: CompletionAnswer } | { ok: false; message: string } | undefined;
    for (const line of output.split('\n')) {
        if (!line.startsWith('{')) continue;
        let event: Record<string, unknown>;
        try {
            event = JSON.parse(line) as Record<string, unknown>;
        } catch {
            continue;
        }
        if (event.type !== 'result') continue;
        if (event.is_error || typeof event.result !== 'string') {
            found = { ok: false, message: typeof event.result === 'string' ? event.result : String(event.subtype ?? 'error') };
            continue;
        }
        const usage = event.usage as Record<string, unknown> | undefined;
        const number = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
        found = {
            ok: true,
            answer: {
                text: event.result,
                ...(usage ? {
                    usage: {
                        inputTokens: number(usage.input_tokens) + number(usage.cache_creation_input_tokens) + number(usage.cache_read_input_tokens),
                        outputTokens: number(usage.output_tokens),
                    },
                } : {}),
            },
        };
    }
    return found;
}

export type CompletionDeps = {
    company: string;
    owner: string;
    image: string;
    host: ChatHost;
    /** The keys of the turns and the accounts of each provider, as the dispatcher has them now. */
    keys: () => { env: Record<string, string>; accounts: Record<string, Array<{ id: string; label?: string }>> };
    log: (line: string, details?: Record<string, unknown>) => void;
    /** The accounts out of credit (`provider#account`), shared with the turns and the chats. */
    credit?: { exhausted: (key: string) => boolean; spent: (key: string, until: number) => void };
    now?: () => number;
    timeoutMs?: number;
    parallel?: number;
};

/** The answers of Claude Code of one organization for its other projects. */
export class ServerCompletions {
    private running = 0;
    private readonly now: () => number;
    private readonly deps: CompletionDeps;

    constructor(deps: CompletionDeps) {
        this.deps = deps;
        this.now = deps.now ?? (() => Date.now());
    }

    /** Its connected subscriptions of Claude: how many. */
    accounts(): number {
        const { env, accounts } = this.deps.keys();
        return (connectedAccounts(env, accounts)[CLAUDE_CODE] ?? []).length;
    }

    async complete(request: CompletionRequest): Promise<CompletionAnswer> {
        const { env, accounts } = this.deps.keys();
        const all = connectedAccounts(env, accounts)[CLAUDE_CODE] ?? [];
        if (!all.length) throw new CompletionError('no-provider', 409);
        // Its accounts in their order, those out of credit left out: the next one when one runs out.
        const usable = all.filter((account) => !this.deps.credit?.exhausted(accountKey(CLAUDE_CODE, account)));
        if (!usable.length) throw new CompletionError('no-credit', 409);
        if (this.running >= (this.deps.parallel ?? COMPLETION_PARALLEL)) throw new CompletionError('busy', 429);
        this.running += 1;
        const container = `playbook-complete-${this.deps.company}-${randomBytes(4).toString('hex')}`;
        const began = this.now();
        try {
            await this.deps.host.start(container, this.deps.image, this.deps.owner).catch(() => { throw new CompletionError('failed', 502); });
            const fromFile = !!this.deps.host.write;
            if (fromFile) await this.deps.host.write!(container, PROMPT_FILE, Buffer.from(request.prompt, 'utf8')).catch(() => { throw new CompletionError('failed', 502); });
            for (const account of usable) {
                const candidate: Candidate = { provider: CLAUDE_CODE, model: request.model, name: request.model, account };
                const keys = candidateEnv(candidate, request.effort, env);
                let output = '';
                let timedOut = false;
                const timer = setTimeout(() => {
                    timedOut = true;
                    void this.deps.host.interrupt?.(container);
                }, this.deps.timeoutMs ?? COMPLETION_TIMEOUT_MS);
                const code = await this.deps.host.exec(container, completionScript(fromFile), { ...keys, ...(fromFile ? {} : { PLAYBOOK_PROMPT: request.prompt }) }, (chunk) => {
                    output = (output + chunk).slice(-2_000_000);
                }).finally(() => clearTimeout(timer));
                const result = completionResultOf(output);
                const seconds = Math.round((this.now() - began) / 1000);
                // Never the prompt nor the answer: who, which model, how it went, how long.
                this.deps.log('completion', { company: this.deps.company, model: request.model, seconds, code, account: account.id, ...(timedOut ? { timeout: true } : {}) });
                if (timedOut) throw new CompletionError('timeout', 504);
                if (result?.ok) return result.answer;
                const until = outOfCredit(result && !result.ok ? `${output}\n${result.message}` : output, this.now());
                if (until !== undefined) {
                    // Out of credit: this account skipped (by the turns too) until it may have some again; the next one.
                    this.deps.credit?.spent(accountKey(CLAUDE_CODE, account), until);
                    continue;
                }
                throw new CompletionError('failed', 502);
            }
            throw new CompletionError('no-credit', 409);
        } finally {
            this.running -= 1;
            await this.deps.host.remove(container).catch(() => undefined);
        }
    }
}

