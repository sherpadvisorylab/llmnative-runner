// What the work of the agents on a CR would have taken a person, written on the CR when it closes:
// the equivalent source lines of its merged pull request (ESLOC: new lines whole, modified lines a
// share, tests a share) at the pace of a developer on a CR already analysed and designed, plus a share
// for analysis, review and test; against the hours the agents worked. COCOMO on the size of the
// project (the effort of the CR is the effort of the project after it less the effort before it) and
// function points by backfiring stay beside it as references: they count a whole lifecycle
// (requirements, documents, management), several times what a specified CR takes. The parameters are
// starting values, to be tuned against the corrections of people.

/** The version of the model: a CR valued with an older one is valued again, its comment updated. */
export const VALUATION_MODEL = 2;

export interface ValuationParams {
    /** COCOMO: effort (person-months) = a × KSLOC^b. */
    a: number;
    b: number;
    hoursPerMonth: number;
    /** The share of a modified line, of a line of tests, against a new line of product code. */
    modified: number;
    test: number;
    /** Function points: source lines per point (backfiring), hours of a person per point. */
    locPerFp: number;
    hoursPerFp: number;
    /** The estimate: equivalent lines a developer writes in an hour on a specified CR, and the share added for analysis, review and test. */
    linesPerHour: number;
    overhead: number;
}

export const VALUATION_DEFAULTS: ValuationParams = { a: 2.4, b: 1.05, hoursPerMonth: 152, modified: 0.5, test: 0.5, locPerFp: 50, hoursPerFp: 10, linesPerHour: 25, overhead: 0.3 };

/** The average length of a source line, to read the size of a repository from its bytes per language. */
export const BYTES_PER_LINE = 35;

export type PullFile = { filename: string; additions: number; deletions: number; status?: string };

/** Files that are not written work: lock files, generated and built files, the package of the workflow. */
const IGNORED = [
    /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|composer\.lock|Gemfile\.lock|poetry\.lock|Cargo\.lock|go\.sum)$/,
    /(^|\/)(dist|build|out|coverage|node_modules|vendor|\.next|\.nuxt)\//,
    /(^|\/)\.(playbook|opencode)\//,
    /\.(min\.(js|css)|map|snap|lock|svg|png|jpe?g|gif|ico|pdf|woff2?)$/,
];
const TESTS = /(^|\/)(tests?|__tests__|spec|e2e)\/|\.(test|spec)\.[cm]?[jt]sx?$/;

export const countedFile = (path: string) => !IGNORED.some((pattern) => pattern.test(path));
export const testFile = (path: string) => TESTS.test(path);

/** The equivalent source lines of the files of a pull request: product and tests apart, each weighted. */
export function eslocOf(files: readonly PullFile[], params: ValuationParams = VALUATION_DEFAULTS) {
    let product = 0;
    let tests = 0;
    let added = 0;
    let modified = 0;
    let counted = 0;
    for (const file of files) {
        if (!countedFile(file.filename)) continue;
        counted += 1;
        // A line removed and one added in its place is a modified line; the rest added is new.
        const changed = Math.min(file.additions, file.deletions);
        const fresh = file.additions - changed;
        added += fresh;
        modified += changed;
        const lines = fresh + changed * params.modified;
        if (testFile(file.filename)) tests += lines * params.test;
        else product += lines;
    }
    return { product: Math.round(product), tests: Math.round(tests), esloc: Math.round(product + tests), added, modified, files: counted };
}

/** COCOMO: the hours of a person for a project of `size` equivalent source lines. */
export const cocomoHours = (size: number, params: ValuationParams = VALUATION_DEFAULTS) =>
    params.a * Math.pow(Math.max(0, size) / 1000, params.b) * params.hoursPerMonth;

const MARKER = /<!-- playbook (\{[^\n]*?\}) -->/;
const USAGE = /<!-- playbook-usage (\{[^\n]*?\}) -->/;
export const VALUE_MARKER = /<!-- playbook-value (\{[^\n]*?\}) -->/;

/**
 * The seconds the agents worked on an issue: each turn as the dispatcher measured it (the usage on its
 * comment), else from its claim to the move that followed.
 */
export function agentSecondsOf(comments: ReadonlyArray<{ body?: string | null; created_at?: string }>): number {
    let seconds = 0;
    const claims = new Map<string, number>();
    for (const comment of comments) {
        const body = comment.body ?? '';
        const usage = USAGE.exec(body)?.[1];
        let move: { event?: string; agent?: string } = {};
        try {
            move = JSON.parse(MARKER.exec(body)?.[1] ?? '{}');
        } catch {
            // Not a move.
        }
        const at = comment.created_at ? Date.parse(comment.created_at) : NaN;
        if (move.event === 'claim' && move.agent && !Number.isNaN(at)) {
            claims.set(move.agent, at);
            continue;
        }
        let measured: number | undefined;
        try {
            measured = usage ? (JSON.parse(usage) as { seconds?: number }).seconds : undefined;
        } catch {
            measured = undefined;
        }
        if (move.event === 'interrupted') {
            if (move.agent) claims.delete(move.agent);
            continue;
        }
        if (typeof measured === 'number') seconds += measured;
        else if (move.event && move.event !== 'claim' && move.agent && claims.has(move.agent) && !Number.isNaN(at)) seconds += Math.max(0, (at - claims.get(move.agent)!) / 1000);
        if (move.agent) claims.delete(move.agent);
    }
    return Math.round(seconds);
}

export interface Valuation {
    model: number;
    pull: number;
    esloc: number;
    product: number;
    tests: number;
    files: number;
    sizeBefore: number;
    sizeAfter: number;
    /** Hours of a person on this CR: its lines at the pace of a developer, plus analysis, review and test. */
    hours: number;
    /** References, for a whole lifecycle: COCOMO on the growth of the project, function points on the code of the CR. */
    cocomoHours: number;
    fpHours: number;
    functionPoints: number;
    agentHours: number;
    /** How many times faster than a person: its hours over the hours of the agents. */
    speedup?: number;
}

const round = (value: number, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;

/** The valuation of a CR: the size of the project before it, the files of its pull request, the seconds of its agents. */
export function valuationOf(pull: number, sizeBefore: number, files: readonly PullFile[], agentSeconds: number, params: ValuationParams = VALUATION_DEFAULTS): Valuation {
    const lines = eslocOf(files, params);
    const sizeAfter = sizeBefore + lines.esloc;
    const cocomo = cocomoHours(sizeAfter, params) - cocomoHours(sizeBefore, params);
    const functionPoints = lines.esloc / params.locPerFp;
    const agentHours = agentSeconds / 3600;
    const hours = (lines.esloc / params.linesPerHour) * (1 + params.overhead);
    return {
        model: VALUATION_MODEL,
        pull,
        esloc: lines.esloc,
        product: lines.product,
        tests: lines.tests,
        files: lines.files,
        sizeBefore,
        sizeAfter,
        hours: round(hours),
        cocomoHours: round(cocomo),
        fpHours: round(functionPoints * params.hoursPerFp),
        functionPoints: round(functionPoints),
        agentHours: round(agentHours, 2),
        ...(agentHours > 0 ? { speedup: round(hours / agentHours) } : {}),
    };
}

/** The comment of the valuation: what a person reads, and the numbers in a hidden marker for the studio. */
export function valuationComment(value: Valuation): string {
    const hours = (count: number) => `${count.toLocaleString('en-US', { maximumFractionDigits: 1 })} h`;
    return [
        `<!-- playbook-value ${JSON.stringify(value)} -->`,
        `**Human-equivalent effort** · ${hours(value.hours)} of a person · agents ${hours(value.agentHours)}${value.speedup ? ` · ×${value.speedup} faster` : ''}`,
        '',
        `| | |`,
        `|---|---|`,
        `| Pull request | #${value.pull}, ${value.files} files counted (lock, generated and workflow files left out) |`,
        `| Equivalent source lines | ${value.esloc} (product ${value.product}, tests ${value.tests}: new lines whole, modified lines and tests a share) |`,
        `| A person | ${hours(value.hours)}: ${VALUATION_DEFAULTS.linesPerHour} equivalent lines an hour, plus ${Math.round(VALUATION_DEFAULTS.overhead * 100)}% for analysis, review and test |`,
        `| Size of the project | ${value.sizeBefore} → ${value.sizeAfter} equivalent lines |`,
        `| COCOMO (reference) | ${hours(value.cocomoHours)}: the project after this CR less before it, a whole lifecycle |`,
        `| Function points (reference) | ${value.functionPoints} points, ${hours(value.fpHours)}, a whole lifecycle |`,
        `| Agents | ${hours(value.agentHours)} of turns |`,
        '',
        '<sub>Starting values of the models, to be tuned: a correction of the hours on this CR is welcome.</sub>',
    ].join('\n');
}
