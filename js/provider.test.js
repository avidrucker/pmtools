// Provider-seam parity tests (#40). node:test, mirrors py/test_provider.py.
//
// The two ports must expose the same provider surface. This pins issueTitle on
// both providers so the asymmetry #40 fixed (py lacked issue_title) cannot
// silently return.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { GitHubProvider, GitLabProvider } = require('./provider');

test('GitHubProvider exposes issueTitle (parity with py issue_title)', () => {
  assert.strictEqual(typeof new GitHubProvider().issueTitle, 'function');
});

test('GitLabProvider stubs issueTitle (throws not-implemented)', () => {
  assert.throws(() => new GitLabProvider().issueTitle(123), /not yet implemented/);
});
