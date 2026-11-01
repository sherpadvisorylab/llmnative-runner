import type { Workflow } from './workflow.ts';

// A person's answer on GitHub: a comment on an issue waiting for a person sends it back to the agent
// that asked, with the answer. The same rule as `node .playbook/playbook.mjs resume`, which the
// orchestrator of the IDE runs.

const MARKER = /<!-- playbook (\{[^\n]*?\}) -->/;

/** The moves the comments record: who works on the issue changes with each. A note of a person is not one. */
const MOVES = ['leave', 'limit', 'handoff', 'claim', 'split', 'open', 'report', 'close', 'turn-failed', 'conflict'];

export type IssueComment = { body?: string | null; user?: { login?: string; type?: string } | null };

const markerOf = (body: string | null | undefined): { event?: string; [key: string]: unknown } | null => {
    const data = MARKER.exec(body ?? '')?.[1];
    if (!data) return null;
    try {
        return JSON.parse(data) as { event?: string };
    } catch {
        return null;
    }
};

/** Whether a new comment may be an answer: a person's plain comment, or a note of a person from the studio. */
export function maybeAnswer(comment: IssueComment): boolean {
    const marker = markerOf(comment.body);
    if (marker) return marker.event === 'note';
    return comment.user?.type !== 'Bot';
}

/**
 * Who asked a person, from the comments of an issue: the agent of its last move, when that move left
 * it to a person through a route that does not end the path (or past a limit); and the answers written
 * after it. No agent: a person put it there, or it was finished work handed over.
 */
export function answerOf(workflow: Pick<Workflow, 'human' | 'answered'>, comments: IssueComment[]): { asker: string | null; answers: IssueComment[] } {
    let asker: string | null = null;
    let last = -1;
    comments.forEach((comment, index) => {
        const move = markerOf(comment.body);
        if (!move || !MOVES.includes(move.event ?? '')) return;
        last = index;
        if (move.event === 'leave') {
            asker = move.to === workflow.human && !(workflow.answered?.finalRoutes ?? []).includes(String(move.route)) ? String(move.agent) : null;
        } else if (move.event === 'limit') {
            asker = move.agent === 'dispatcher' ? (move.of ? String(move.of) : null) : String(move.agent);
        } else if (move.event !== 'turn-failed') {
            asker = null;
        }
    });
    const answers = comments.slice(last + 1).filter((comment) => maybeAnswer(comment));
    return { asker, answers };
}

/** The comment that hands an answered issue back: a person's move (the counts start again), their answer quoted. */
export function answeredComment(workflow: Pick<Workflow, 'statusPrefix' | 'answered' | 'agents'>, by: string, to: string, answers: IssueComment[]): string {
    const status = workflow.answered!.status;
    const quoted = answers
        .map((comment) => (comment.body ?? '').replace(MARKER, '').trim())
        .filter(Boolean)
        .join('\n\n')
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n');
    const marker = `<!-- playbook ${JSON.stringify({ event: 'handoff', by, to, status, from: 'comment' })} -->`;
    return `${marker}\n**@${by}** → **${workflow.agents[to]?.name ?? to}** · ${workflow.statusPrefix}${status} · answered on GitHub\n\n${quoted}`;
}
