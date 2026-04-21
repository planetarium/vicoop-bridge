import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildAuthorizeUrl, exchangeCode, type GoogleConfig } from './google-oauth.js';

const cfg: GoogleConfig = {
  clientId: 'test-client-id.apps.googleusercontent.com',
  clientSecret: 'test-client-secret',
  redirectUri: 'https://bridge.example.com/oauth/google/callback',
};

describe('buildAuthorizeUrl', () => {
  it('builds a URL pointing at accounts.google.com with required params', () => {
    const url = new URL(buildAuthorizeUrl(cfg, 'state-abc'));

    assert.equal(url.host, 'accounts.google.com');
    assert.equal(url.searchParams.get('client_id'), cfg.clientId);
    assert.equal(url.searchParams.get('redirect_uri'), cfg.redirectUri);
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('state'), 'state-abc');
  });

  it('requests openid, email, and profile scopes', () => {
    const url = new URL(buildAuthorizeUrl(cfg, 'state-xyz'));
    const scope = url.searchParams.get('scope') ?? '';
    const scopes = scope.split(/\s+/);
    assert.ok(scopes.includes('openid'), `expected 'openid' scope, got: ${scope}`);
    assert.ok(scopes.includes('email'), `expected 'email' scope, got: ${scope}`);
    assert.ok(scopes.includes('profile'), `expected 'profile' scope, got: ${scope}`);
  });

  it('passes state through verbatim and uses prompt=select_account', () => {
    const oddState = 'v1.abc:def/ghi+jkl=mno';
    const url = new URL(buildAuthorizeUrl(cfg, oddState));
    assert.equal(url.searchParams.get('state'), oddState);
    assert.equal(url.searchParams.get('prompt'), 'select_account');
  });
});

describe('exchangeCode', () => {
  it('throws on invalid code (cannot exchange with Google)', async (t) => {
    if (process.env.SKIP_NETWORK_TESTS === '1') {
      t.skip('SKIP_NETWORK_TESTS=1 set');
      return;
    }

    let threw = false;
    try {
      await exchangeCode(cfg, 'not-a-real-code');
    } catch (err) {
      threw = true;
      assert.ok(err instanceof Error);
      // Must not leak the raw code back in the error message.
      assert.ok(
        !String(err.message).includes('not-a-real-code'),
        `error message leaked raw code: ${err.message}`,
      );
    }
    assert.ok(threw, 'expected exchangeCode to throw for invalid code');
  });
});
