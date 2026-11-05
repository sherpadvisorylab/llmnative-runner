// Which provider runs a turn (docs/playbook-model.md §8.6). The package names, per agent, its models in
// order and every provider of the runner that serves each (dispatch.json); the organization connects
// providers and may put them in its order (PLAYBOOK_PROVIDER_ORDER). A turn runs the first model on the
// first provider of that order with a key (or the token of Claude Code) and with credit: one that ran out
// is skipped until it may have some again, and the turn goes on with the next.

/** A way to run a model: the provider of Brain, what its engine is given, the variant of opencode. */
export type Offer = { provider: string; model: string; variant?: string };
export type AgentModel = { name: string; offers: Offer[] };
/** An account of a provider: the n-th (from 1) keys of the turns (`<VAR>`, `<VAR>__2`…), its id and label. */
export type Account = { index: number; id: string; label?: string };
/** One try of a turn: the model by name, where it runs and with which account. */
export type Candidate = Offer & { name: string; account: Account };

export const CLAUDE_CODE = 'claude-code';

/** What a provider needs in the environment of the turns to be connected (all of them). */
const NEEDS: Record<string, string[]> = {
    [CLAUDE_CODE]: ['CLAUDE_CODE_OAUTH_TOKEN'],
    opencode: ['OPENCODE_API_KEY'],
    'opencode-go': ['OPENCODE_GO_API_KEY'],
    anthropic: ['ANTHROPIC_API_KEY'],
    openai: ['OPENAI_API_KEY'],
    gemini: ['GEMINI_API_KEY'],
    openrouter: ['OPENROUTER_API_KEY'],
    deepseek: ['DEEPSEEK_API_KEY'],
    mistral: ['MISTRAL_API_KEY'],
    groq: ['GROQ_API_KEY'],
    glm: ['ZHIPU_API_KEY'],
    cloudflare: ['CLOUDFLARE_API_KEY', 'CLOUDFLARE_ACCOUNT_ID'],
};

/** The variable of the n-th account (from 1): the first under its name, the others with `__2`, `__3`… */
const variable = (name: string, index: number) => (index > 1 ? `${name}__${index}` : name);

/**
 * The accounts of each provider the organization connected, in its order: those whose keys are among the
 * variables of its turns. `listed`: their ids and labels (PLAYBOOK_ACCOUNTS); without it, by position.
 */
export function connectedAccounts(env: Record<string, string>, listed: Record<string, Array<{ id: string; label?: string }>> = {}): Record<string, Account[]> {
    const accounts: Record<string, Account[]> = {};
    for (const [provider, names] of Object.entries(NEEDS)) {
        const found: Account[] = [];
        for (let index = 1; index <= 20 && names.every((name) => env[variable(name, index)]); index += 1) {
            const known = listed[provider]?.[index - 1];
            found.push({ index, id: known?.id ?? String(index), ...(known?.label ? { label: known.label } : {}) });
        }
        if (found.length) accounts[provider] = found;
    }
    return accounts;
}

/** The providers the organization connected: those with an account. */
export const connectedProviders = (env: Record<string, string>): string[] => Object.keys(connectedAccounts(env));

/** What a provider out of credit is known by: the provider and its account. */
export const accountKey = (provider: string, account: Pick<Account, 'id'>) => `${provider}#${account.id}`;

/**
 * The tries of a turn, in order: each model of the agent (first the preferred) on each provider that serves
 * it, in the order of the organization (those it does not name after, in the order of the package), and on
 * each provider each of its accounts in its order; those out of credit left out. The order of the
 * providers never depends on their accounts.
 */
export function candidates(models: readonly AgentModel[], accounts: Record<string, Account[]>, order: readonly string[] = [], exhausted: (key: string) => boolean = () => false): Candidate[] {
    const position = (provider: string) => {
        const at = order.indexOf(provider);
        return at < 0 ? order.length : at;
    };
    return models.flatMap(({ name, offers }) => offers
        .map((offer, index) => ({ offer, index }))
        .filter(({ offer }) => accounts[offer.provider]?.length)
        .sort((a, b) => position(a.offer.provider) - position(b.offer.provider) || a.index - b.index)
        .flatMap(({ offer }) => accounts[offer.provider]
            .filter((account) => !exhausted(accountKey(offer.provider, account)))
            .map((account) => ({ ...offer, name, account }))));
}

/**
 * The variables of a turn on a try: the keys of the other accounts left out, those of its account under the
 * names opencode and Claude Code read, the engine, its model, how much it reasons.
 */
export function candidateEnv(candidate: Candidate, effort: string | undefined, env: Record<string, string>): Record<string, string> {
    const own = Object.fromEntries((NEEDS[candidate.provider] ?? []).map((name) => [name, env[variable(name, candidate.account.index)]]).filter(([, value]) => value));
    const keys = { ...Object.fromEntries(Object.entries(env).filter(([name]) => !/__\d+$/.test(name))), ...own };
    if (candidate.provider === CLAUDE_CODE) return { ...keys, PLAYBOOK_ENGINE: CLAUDE_CODE, PLAYBOOK_MODEL: candidate.model, ...(effort ? { PLAYBOOK_EFFORT: effort } : {}) };
    return { ...keys, PLAYBOOK_MODEL: candidate.model, ...(candidate.variant ? { PLAYBOOK_VARIANT: candidate.variant } : {}) };
}

/** What a person reads of a try: the provider and, when it has several or a label, its account. */
export const candidateName = (candidate: Pick<Candidate, 'provider' | 'account'>) =>
    (candidate.account.label ? `${candidate.provider} (${candidate.account.label})` : candidate.account.index > 1 ? `${candidate.provider} #${candidate.account.index}` : candidate.provider);

/** How long a provider out of credit is skipped when it does not say when it has some again. */
export const EXHAUSTED_MS = 60 * 60_000;

/**
 * What says a provider has no credit left (a balance, a quota, the limit of a subscription), never a rate
 * limit, which passes by itself. Read only at the end of what a turn printed: what an agent reads in its
 * work (code about billing) comes before.
 */
const OUT_OF_CREDIT = [
    /credit balance is too low/i,
    /insufficient[_ ](?:credits?|balance|quota|funds)/i,
    /exceeded your current quota/i,
    /requires more credits/i,
    /payment required/i,
    /out of (?:credits?|tokens)/i,
    /(?:usage|monthly|weekly|daily|session|5-hour|five-hour) limit (?:reached|exceeded|hit)/i,
    /you(?:'ve| have) (?:hit|reached) your (?:usage |session |weekly )?limit/i,
    /claude ai usage limit reached/i,
];

/**
 * When a turn that left its issue where it was failed because its provider ran out of credit: until when
 * to skip it (the reset Claude prints, else an hour); undefined for any other failure.
 */
export function outOfCredit(output: string, now: number): number | undefined {
    const tail = output.trim().split('\n').slice(-40).join('\n');
    if (!OUT_OF_CREDIT.some((pattern) => pattern.test(tail))) return undefined;
    // Claude Code: "Claude AI usage limit reached|1767225600" (seconds).
    const reset = /usage limit reached\|(\d{10})/i.exec(tail);
    const at = reset ? Number(reset[1]) * 1000 : NaN;
    return at > now ? at : now + EXHAUSTED_MS;
}
