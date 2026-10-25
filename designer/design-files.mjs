#!/usr/bin/env node
// The documents a design session wrote: every file added or changed in the clone, as JSON on stdout
// ({ files: [{ path, content, status: new | modified }], skipped: [why] }), for the dispatcher to put in the pull request. Text
// files only; deletions and the tooling folders are left out. Exit code 1 with a message on stderr
// when the documents are too large.
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const REPO = '/work/repo';
const MAX_FILE = 1024 * 1024;
const MAX_TOTAL = 5 * 1024 * 1024;
const SKIP = /^(\.git|\.opencode|\.claude|\.agents|_bmad|node_modules)\//;
// The folders a kit writes its documents to (PLAYBOOK_DESIGN_OUTPUTS, space separated); none: anywhere.
const OUTPUTS = (process.env.PLAYBOOK_DESIGN_OUTPUTS ?? '').split(/\s+/).filter(Boolean).map((folder) => folder.replace(/\/+$/, '') + '/');

const status = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: REPO, encoding: 'utf8' });
const entries = status.split('\0').filter(Boolean);
const files = [];
const skipped = [];
let total = 0;
for (let index = 0; index < entries.length; index += 1) {
    const code = entries[index].slice(0, 2);
    const path = entries[index].slice(3);
    // A rename is followed by its old path.
    if (code.startsWith('R') || code.startsWith('C')) index += 1;
    if (code.includes('D') || SKIP.test(path) || (OUTPUTS.length && !OUTPUTS.some((folder) => path.startsWith(folder)))) continue;
    const full = join(REPO, path);
    const size = statSync(full).size;
    if (size > MAX_FILE) {
        skipped.push(`${path}: larger than ${MAX_FILE} bytes`);
        continue;
    }
    const content = readFileSync(full);
    // Text only: a NUL byte means a binary file.
    if (content.includes(0)) {
        skipped.push(`${path}: not a text file`);
        continue;
    }
    total += size;
    if (total > MAX_TOTAL) {
        process.stderr.write(`the documents are larger than ${MAX_TOTAL} bytes\n`);
        process.exit(1);
    }
    files.push({ path, content: content.toString('utf8'), status: code === '??' || code.includes('A') ? 'new' : 'modified' });
}
process.stdout.write(JSON.stringify({ files, skipped }));
