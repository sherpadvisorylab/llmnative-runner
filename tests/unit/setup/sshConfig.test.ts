import { describe, expect, it } from 'vitest';
import { sshConfigFor } from '../../../src/setup';

const CONFIG = `Host github.com
  User git
  IdentityFile ~/.ssh/id_github
Host codemegreen 161.97.140.94
    User codemegreen
    IdentityFile ~/.ssh/codemegreen
Host 10.0.*
  User admin
  IdentityFile ~/.ssh/lan
Host *
  IdentityFile ~/.ssh/id_ed25519
`;

describe('the key of a host in ~/.ssh/config', () => {
    it('takes the user and the keys of the blocks that match, in order', () => {
        expect(sshConfigFor(CONFIG, '161.97.140.94')).toEqual({ user: 'codemegreen', identityFiles: ['~/.ssh/codemegreen', '~/.ssh/id_ed25519'] });
        expect(sshConfigFor(CONFIG, '10.0.3.4')).toEqual({ user: 'admin', identityFiles: ['~/.ssh/lan', '~/.ssh/id_ed25519'] });
        expect(sshConfigFor(CONFIG, '203.0.113.9')).toEqual({ identityFiles: ['~/.ssh/id_ed25519'] });
    });
});
