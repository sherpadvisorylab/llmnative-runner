import type { GitHubApi, TokenPermissions } from './github.ts';

// The workflow of a repository as the package of the studio wrote it: `.playbook/dispatch.json` on the
// working branch, and `.playbook/state.yaml` for the pause.

export const DISPATCH_FILE = '.playbook/dispatch.json';
export const STATE_FILE = '.playbook/state.yaml';
/** Where the package goes when the default branch is not the working branch. */
const FALLBACK_BRANCH = 'develop';

export interface Workflow {
    workflow: string;
    version: number;
    workBranch: string;
    needsPrefix: string;
    statusPrefix: string;
    human: string;
    blocked: string;
    /** `opensPullRequests`: it waits while another CR of the repository has its pull request open. */
    /** `engine`: `claude-code` for an agent run by Claude Code (absent: opencode), with its `effort`. */
    agents: Record<string, { name: string; opencodeAgent: string; permissions: TokenPermissions; opensPullRequests?: boolean; claim?: string; engine?: 'claude-code'; effort?: string }>;
    /** Where a source merged in sources/ goes (the Source channel), when the workflow has it. */
    sources?: { to: string; status: string };
    /** A person's comment on an issue waiting for one: back to the agent that asked, with this status; not after a route that ends the path. */
    answered?: { status: string; finalRoutes: string[] };
    /** An item whose pull request no longer merges into the working branch: to `to` (an agent or the human), with this status. */
    conflicts?: { status: string; to: string };
    /** The tag of the memory that holds the knowledge of the repository, when it is not its name. */
    knowledgeTag?: string;
    /** The CI gate: the routes through it, the status of a failed CI, the minutes it may take. */
    ci?: { needs: string; failed: string; timeoutMinutes: number; routes: Record<string, { from: string; to: string; status: string }> };
    paused: boolean;
    /** The rank of the repository among the others of the company (`.playbook/state.yaml`): `normal` when not set. */
    priority: 'high' | 'normal' | 'low';
}

async function fileOf(github: GitHubApi, repository: string, path: string, ref: string): Promise<string | null> {
    try {
        const file = await github.request<{ content: string }>('GET', `/repos/${repository}/contents/${path}?ref=${encodeURIComponent(ref)}`);
        return Buffer.from(file.content, 'base64').toString('utf8');
    } catch (error) {
        if ((error as { status?: number }).status === 404) return null;
        throw error;
    }
}

/** The workflow a repository runs, or null when it runs none. */
export async function readWorkflow(github: GitHubApi, repository: string): Promise<Workflow | null> {
    const { default_branch: defaultBranch } = await github.request<{ default_branch: string }>('GET', `/repos/${repository}`);
    for (const branch of [...new Set([defaultBranch, FALLBACK_BRANCH])]) {
        const text = await fileOf(github, repository, DISPATCH_FILE, branch);
        if (text === null) continue;
        const config = JSON.parse(text) as Omit<Workflow, 'paused'>;
        if (!config.agents || typeof config.agents !== 'object') return null;
        const state = await fileOf(github, repository, STATE_FILE, config.workBranch || branch);
        const priority = /^\s*priority:\s*(high|normal|low)\s*$/m.exec(state ?? '')?.[1] as Workflow['priority'] | undefined;
        return { ...config, workBranch: config.workBranch || branch, paused: /^\s*paused:\s*true\s*$/m.test(state ?? ''), priority: priority ?? 'normal' };
    }
    return null;
}

/** Who works on an issue now, from its labels. */
export function workOf(workflow: Pick<Workflow, 'needsPrefix' | 'statusPrefix'>, labels: Array<string | { name?: string }>) {
    const names = labels.map((label) => (typeof label === 'string' ? label : label.name ?? ''));
    const pick = (prefix: string) => names.find((name) => name.startsWith(prefix))?.slice(prefix.length);
    return { needs: pick(workflow.needsPrefix), status: pick(workflow.statusPrefix), names };
}
