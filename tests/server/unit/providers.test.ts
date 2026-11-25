// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { EXHAUSTED_MS, candidateEnv, outOfCredit } from '../../../server/src/providers.ts';

describe('the credit of an account', () => {
    const now = Date.parse('2026-11-25T10:00:00Z');

    it('reads the reset of a Claude subscription, else waits an hour', () => {
        expect(outOfCredit('Claude AI usage limit reached|1895600000', now)).toBe(1895600000 * 1000);
        expect(outOfCredit('You have hit your limit · resets 3:20pm (UTC)', now)).toBe(Date.parse('2026-11-25T15:20:00Z'));
        expect(outOfCredit('insufficient_quota', now)).toBe(now + EXHAUSTED_MS);
        expect(outOfCredit('rate limited, retry', now)).toBeUndefined();
    });

    it('gives a harness only the key of the account it runs with', () => {
        const env = candidateEnv({ provider: 'claude-code', model: 'sonnet', name: 'sonnet', account: { index: 2, id: 't:x' } }, 'high', { CLAUDE_CODE_OAUTH_TOKEN: 'one', CLAUDE_CODE_OAUTH_TOKEN__2: 'two' });
        expect(env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'two', RUNNER_ENGINE: 'claude-code', RUNNER_MODEL: 'sonnet', RUNNER_EFFORT: 'high' });
    });
});
