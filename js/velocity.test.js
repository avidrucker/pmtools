// Unit tests for the velocity wrapper's fetchTitle seam (#46). Run: node --test js
//
// fetchTitle delegates to a host provider's issueTitle; the provider is
// injectable so we can test it with a canned/throwing stand-in instead of
// shelling out to `gh`. The stand-in is a tiny object, not a mock framework.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { fetchTitle } = require('./velocity');

test('fetchTitle returns the provider-supplied title (canned provider)', () => {
  const provider = { issueTitle: (n) => `Title for #${n}` };
  assert.equal(fetchTitle(42, provider), 'Title for #42');
});

test('fetchTitle returns null when the provider throws (best-effort)', () => {
  const provider = { issueTitle: () => { throw new Error('gh offline'); } };
  assert.equal(fetchTitle(42, provider), null);
});

test('fetchTitle returns null when the provider yields null (offline/not found)', () => {
  const provider = { issueTitle: () => null };
  assert.equal(fetchTitle(42, provider), null);
});
