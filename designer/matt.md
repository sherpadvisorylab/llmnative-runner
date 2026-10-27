
## Agent skills

### Issue tracker

Issues and specs live as local markdown files under `.scratch/` in the repository. See
`/home/agent/.config/opencode/matt/agents/issue-tracker.md`.

### Triage labels

The five canonical roles, each label string equal to its name. See
`/home/agent/.config/opencode/matt/agents/triage-labels.md`.

### Domain docs

Single-context. See `/home/agent/.config/opencode/matt/agents/domain.md`.

## The flow of a Matt session in Playbook

1. The session starts with `grill-with-docs` on the topic.
2. When the grilling is over (the decision tree is resolved and the person agrees you are aligned),
   ask with the `question` tool whether to write the spec now: "Write the spec now (Recommended)"
   and "Not yet". When the person says yes, read
   `/home/agent/.config/opencode/skills/to-spec/SKILL.md` and follow it as written.
3. When the spec is written, tell the person in a few lines what it holds and that the next step is
   "Finish and open the PR", which puts the glossary, the ADRs, the spec and the conversation in a
   pull request for the analyst.
4. `to-tickets` runs only when the person asks for it (`/to-tickets`).
