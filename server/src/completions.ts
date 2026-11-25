import { randomBytes } from 'node:crypto';
import type { ChatHost, Keys } from './chats.ts';
import { OPENCODE_GO } from './accounts.ts';
import { CLAUDE_CODE, accountKey, candidateEnv, connectedAccounts, outOfCredit, type Candidate } from './providers.ts';

// One answer with a subscription (Claude Code or OpenCode Go): the prompt in, the text out. No tool: a short-lived
// container of the image of the harnesses, removed at once. It runs with the accounts of the person (when the client
// says who asks), then those of the tenant, in their order; one out of credit is skipped until its reset.

export const COMPLETION_PROVIDERS = [CLAUDE_CODE, OPENCODE_GO] as const;
export type CompletionProvider = (typeof COMPLETION_PROVIDERS)[number];
/** The models of Claude Code a client names: its aliases (a full id of a Claude model is taken too). */
export const CLAUDE_CODE_MODELS = ['haiku', 'sonnet', 'opus'] as const;
/**
 * The models of OpenCode Go a client names (bare, as `opencode-go/<model>` too): those its subscription serves (the
 * list of the OpenCode Go provider of @llmnative/react).
 */
export const OPENCODE_GO_MODELS = [
    'kimi-k3', 'kimi-k3.1-pro', 'glm-5.3', 'glm-5.3-flash', 'deepseek-v4.1-flash', 'deepseek-v4-pro',
    'qwen3.8-max', 'qwen3.8-flash', 'minimax-m3', 'claude-haiku-5-5', 'gemini-4-argon',
] as const;
const MODEL_PATTERN = /^[a-z0-9][a-z0-9.:/_-]{1,80}$/;
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export const COMPLETION_PROMPT_MAX = 200_000;
/** How long an answer may take. */
export const COMPLETION_TIMEOUT_MS = 5 * 60_000;
/** Answers at once for one tenant: the others are told to come back. */
export const COMPLETION_PARALLEL = 2;
/** Where the prompt is written in the container: a prompt of some hundred KB fits no variable. */
const PROMPT_FILE = '/tmp/runner-prompt.txt';
/** A prompt this long goes to opencode as its message; a longer one as a file it reads (one argument is at most 128 KB). */
const OPENCODE_ARGUMENT_MAX = 100_000;
/** Every tool of Claude Code: it only answers text. */
const NO_TOOLS = 'Edit Write NotebookEdit Bash WebFetch WebSearch Read Glob Grep Task';
/** opencode without tools that change or run anything, and without MCP servers. */
const OPENCODE_CONFIG = JSON.stringify({ permission: { edit: 'deny', bash: 'deny', webfetch: 'deny' } });

export type CompletionRequest = { provider: CompletionProvider; model: string; prompt: string; effort?: (typeof EFFORTS)[number] };
export type CompletionAnswer = { text: string; usage?: { inputTokens: number; outputTokens: number } };

export class CompletionError extends Error {
    readonly status: number;
    /** For `no-credit`: when the first account may have some again. */
    readonly until?: string;

    constructor(message: 'invalid' | 'no-provider' | 'no-credit' | 'busy' | 'failed' | 'timeout', status: number, until?: number) {
        super(message);
        this.status = status;
        if (until) this.until = new Date(until).toISOString();
    }
}

/** The model of OpenCode Go as opencode takes it: `opencode-go/<model>`. */
const opencodeModel = (model: string) => (model.startsWith(`${OPENCODE_GO}/`) ? model : `${OPENCODE_GO}/${model}`);

/** The request of a client, checked: undefined when it is not one. */
export function completionRequestOf(body: unknown): CompletionRequest | undefined {
    const value = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const { provider, prompt, model, effort } = value;
    if (typeof provider !== 'string' || !(COMPLETION_PROVIDERS as readonly string[]).includes(provider)) return undefined;
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > COMPLETION_PROMPT_MAX) return undefined;
    if (typeof model !== 'string' || !MODEL_PATTERN.test(model) || model.includes('..')) return undefined;
    if (provider === CLAUDE_CODE && !(CLAUDE_CODE_MODELS as readonly string[]).includes(model) && !/^claude-[a-z0-9.-]+$/.test(model)) return undefined;
    if (effort !== undefined && !(EFFORTS as readonly unknown[]).includes(effort)) return undefined;
    return { provider: provider as CompletionProvider, prompt, model, ...(effort ? { effort: effort as CompletionRequest['effort'] } : {}) };
}

/** Claude Code once, on the prompt in its file (else in RUNNER_PROMPT), every tool refused, the subscription only. */
export function completionScript(fromFile: boolean): string {
    const input = fromFile ? `cat ${PROMPT_FILE}` : `printf '%s' "$RUNNER_PROMPT"`;
    return `cd /tmp && ${input} | env -u ANTHROPIC_API_KEY -u RUNNER_PROMPT DISABLE_AUTOUPDATER=1 claude -p --output-format stream-json --verbose --model "$RUNNER_MODEL"\${RUNNER_EFFORT:+ --effort "$RUNNER_EFFORT"} --disallowedTools ${NO_TOOLS}`;
}

/**
 * opencode once with OpenCode Go, without tools nor MCP: the prompt as its message (from its file when it is
 * written there), or the file attached when the prompt is too long for one argument.
 */
export function opencodeCompletionScript(fromFile: boolean, attach: boolean): string {
    const message = !fromFile ? '"$RUNNER_PROMPT"' : attach ? `-f ${PROMPT_FILE} "Answer the request in the attached file."` : `"$(cat ${PROMPT_FILE})"`;
    return `cd /tmp && env -u RUNNER_PROMPT opencode run --model "$RUNNER_MODEL"\${RUNNER_VARIANT:+ --variant "$RUNNER_VARIANT"} ${message}`;
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

/** The colours and moves of a terminal, out of a text. */
const ESCAPES = /\u001b\][^\u0007]*\u0007|\u001b\[[0-?]*[ -/]*[@-~]|\u001b[()][0-9A-Za-z]|\u001b[@-_]|\r/g;

/** The text opencode printed: its colours out, the lines of its mode (`> build`) left out. */
export function opencodeTextOf(output: string): string {
    return output.replace(ESCAPES, '').split('\n').filter((line) => !/^\s*>\s*(build|plan)\b/.test(line)).join('\n').trim();
}

export type CompletionDeps = {
    tenant: string;
    image: string;
    host: ChatHost;
    /** The keys an answer for this person runs with (theirs first, then the tenant's). */
    keys: (user?: string) => Keys;
    log: (line: string, details?: Record<string, unknown>) => void;
    /** The accounts out of credit (`provider#account`), shared with the chats. */
    credit?: { exhausted: (key: string) => boolean; spent: (key: string, until: number) => void; until?: (key: string) => number | undefined };
    now?: () => number;
    timeoutMs?: number;
    parallel?: number;
};

/** The models a person can use now, per provider: those with an account, and whether each is a subscription. */
export function offerOf(keys: Keys, exhausted: (key: string) => boolean = () => false) {
    const connected = connectedAccounts(keys.env, keys.accounts);
    return COMPLETION_PROVIDERS.map((id) => {
        const accounts = connected[id] ?? [];
        return {
            id,
            models: id === CLAUDE_CODE ? [...CLAUDE_CODE_MODELS] : [...OPENCODE_GO_MODELS],
            accounts: accounts.length,
            available: accounts.filter((account) => !exhausted(accountKey(id, account))).length,
        };
    });
}

/** The answers of one tenant. */
export class ServerCompletions {
    private running = 0;
    private readonly now: () => number;
    private readonly deps: CompletionDeps;

    constructor(deps: CompletionDeps) {
        this.deps = deps;
        this.now = deps.now ?? (() => Date.now());
    }

    get load(): number {
        return this.running;
    }

    async complete(request: CompletionRequest, who: { key: string; user?: string }): Promise<CompletionAnswer> {
        const { env, accounts } = this.deps.keys(who.user);
        const all = connectedAccounts(env, accounts)[request.provider] ?? [];
        if (!all.length) throw new CompletionError('no-provider', 409);
        // Its accounts in their order, those out of credit left out: the next one when one runs out.
        const usable = all.filter((account) => !this.deps.credit?.exhausted(accountKey(request.provider, account)));
        if (!usable.length) {
            const resets = all.map((account) => this.deps.credit?.until?.(accountKey(request.provider, account)) ?? 0).filter(Boolean);
            throw new CompletionError('no-credit', 409, resets.length ? Math.min(...resets) : undefined);
        }
        if (this.running >= (this.deps.parallel ?? COMPLETION_PARALLEL)) throw new CompletionError('busy', 429);
        this.running += 1;
        const container = `runner-complete-${this.deps.tenant}-${randomBytes(4).toString('hex')}`;
        const began = this.now();
        const claude = request.provider === CLAUDE_CODE;
        const model = claude ? request.model : opencodeModel(request.model);
        let lastUntil: number | undefined;
        try {
            await this.deps.host.start(container, this.deps.image, this.deps.tenant).catch(() => {
                throw new CompletionError('failed', 502);
            });
            const fromFile = !!this.deps.host.write;
            if (fromFile) await this.deps.host.write!(container, PROMPT_FILE, Buffer.from(request.prompt, 'utf8')).catch(() => {
                throw new CompletionError('failed', 502);
            });
            const script = claude ? completionScript(fromFile) : opencodeCompletionScript(fromFile, Buffer.byteLength(request.prompt, 'utf8') > OPENCODE_ARGUMENT_MAX);
            for (const account of usable) {
                const candidate: Candidate = { provider: request.provider, model, name: model, account };
                const keys = candidateEnv(candidate, claude ? request.effort : undefined, env);
                let output = '';
                let timedOut = false;
                const timer = setTimeout(() => {
                    timedOut = true;
                    void this.deps.host.interrupt?.(container);
                }, this.deps.timeoutMs ?? COMPLETION_TIMEOUT_MS);
                const variables = { ...keys, ...(claude ? {} : { OPENCODE_CONFIG_CONTENT: OPENCODE_CONFIG }), ...(fromFile ? {} : { RUNNER_PROMPT: request.prompt }) };
                const code = await this.deps.host.exec(container, script, variables, (chunk) => {
                    output = (output + chunk).slice(-2_000_000);
                }).finally(() => clearTimeout(timer));
                const seconds = Math.round((this.now() - began) / 1000);
                // Never the prompt nor the answer nor the key: which key, which model, how it went, how long.
                this.deps.log('completion', { tenant: this.deps.tenant, key: who.key, ...(who.user ? { user: who.user } : {}), provider: request.provider, model, seconds, code, account: account.id, ...(timedOut ? { timeout: true } : {}) });
                if (timedOut) throw new CompletionError('timeout', 504);
                if (claude) {
                    const result = completionResultOf(output);
                    if (result?.ok) return result.answer;
                    const until = outOfCredit(result && !result.ok ? `${output}\n${result.message}` : output, this.now());
                    if (until !== undefined) {
                        // Out of credit: this account skipped (by the chats too) until it may have some again; the next one.
                        this.deps.credit?.spent(accountKey(request.provider, account), until);
                        lastUntil = lastUntil === undefined ? until : Math.min(lastUntil, until);
                        continue;
                    }
                    throw new CompletionError('failed', 502);
                }
                const text = opencodeTextOf(output);
                if (code === 0 && text) return { text };
                const until = outOfCredit(output, this.now());
                if (until !== undefined) {
                    this.deps.credit?.spent(accountKey(request.provider, account), until);
                    lastUntil = lastUntil === undefined ? until : Math.min(lastUntil, until);
                    continue;
                }
                throw new CompletionError('failed', 502);
            }
            throw new CompletionError('no-credit', 409, lastUntil);
        } finally {
            this.running -= 1;
            await this.deps.host.remove(container).catch(() => undefined);
        }
    }
}
