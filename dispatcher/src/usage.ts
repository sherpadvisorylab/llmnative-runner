import type { GitHubApi } from './github.ts';

// What a turn cost, as the agent prints it at its end (runner/agent/usage.mjs), kept on the issue: a
// line added to the comment of the turn (the exit of the agent, or its failure), with the numbers in a
// hidden marker the studio sums. On GitHub the history of an issue stays with it.

/**
 * `github`: the requests the command of the workflow made to GitHub in the turn. `contextStart` and
 * `contextEnd`: the tokens the model read for the first and for the last reply of the turn.
 */
export type TurnUsage = { model?: string; input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number; cost: number; replies: number; seconds?: number; github?: number; contextStart?: number; contextEnd?: number };

const LINE = /^\[playbook-agent\] usage (\{.*\})\s*$/m;
const MOVE = /<!-- playbook (\{[^\n]*?\}) -->/;
export const USAGE_MARKER = /<!-- playbook-usage (\{[^\n]*?\}) -->/;

/** The usage the agent printed, if it did. */
export function usageOfOutput(output: string): TurnUsage | null {
    const match = LINE.exec(output);
    if (!match) return null;
    try {
        const usage = JSON.parse(match[1]) as TurnUsage;
        return typeof usage.input === 'number' && typeof usage.cost === 'number' ? usage : null;
    } catch {
        return null;
    }
}

const thousands = (count: number) => (count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count));

/** The line a person reads under the comment of the turn, and its marker. */
export function usageNote(usage: TurnUsage): string {
    const parts = [
        ...(usage.seconds !== undefined ? [`${Math.max(1, Math.round(usage.seconds / 60))} min`] : []),
        ...(usage.model ? [usage.model] : []),
        `${thousands(usage.input + usage.cacheRead + usage.cacheWrite)} in`,
        `${thousands(usage.output + usage.reasoning)} out`,
        `$${usage.cost.toFixed(4)}`,
        ...(usage.github ? [`${usage.github} GitHub`] : []),
        ...(usage.contextStart && usage.contextEnd ? [`context ${thousands(usage.contextStart)} → ${thousands(usage.contextEnd)}`] : []),
    ];
    return `<!-- playbook-usage ${JSON.stringify(usage)} -->\n<sub>${parts.join(' · ')}</sub>`;
}

/**
 * Adds the usage of a turn to its comment: the last one since the turn started that records a move of
 * that agent (its exit, its split, its report, its failure or the limit that stopped it). False when
 * there is none.
 */
export async function noteUsage(github: GitHubApi, repository: string, number: number, agent: string, since: string, usage: TurnUsage): Promise<boolean> {
    const comments = await github.request<Array<{ id: number; body?: string }>>('GET', `/repos/${repository}/issues/${number}/comments?since=${encodeURIComponent(since)}&per_page=100`);
    const mine = [...comments].reverse().find((comment) => {
        const data = MOVE.exec(comment.body ?? '')?.[1];
        if (!data || USAGE_MARKER.test(comment.body ?? '')) return false;
        try {
            const move = JSON.parse(data) as { agent?: string; of?: string };
            return move.agent === agent || move.of === agent;
        } catch {
            return false;
        }
    });
    if (!mine) return false;
    await github.request('PATCH', `/repos/${repository}/issues/comments/${mine.id}`, { body: `${mine.body ?? ''}\n\n${usageNote(usage)}` });
    return true;
}
