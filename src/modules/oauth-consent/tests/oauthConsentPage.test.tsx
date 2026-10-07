import assert from 'node:assert/strict';

import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import i18next from 'i18next';
import React from 'react';
import { initReactI18next } from 'react-i18next';
import { beforeEach, describe, test, vi } from 'vitest';

import OAuthConsentRoute from '@/modules/oauth-consent/OAuthConsentRoute';
import { useOAuthConsent } from '@/modules/oauth-consent/hooks/useOAuthConsent';
import { ApiRequestError } from '@/shared/api';
import enConsent from '@/modules/i18n/locales/en/consent.json';
import type { OAuthConsentContext } from '@/shared/types';

/**
 * The consent page's decision logic and its render, against a stubbed transport.
 *
 * This is the half a browser probe cannot pin cheaply: that the pinned read
 * scope is the ONLY pre-checked box and a write scope never arrives checked,
 * that the submitted decision carries exactly the ticks the user made (empty on
 * Deny), and that a request the server refused renders an error face with NO
 * Allow button — the property that keeps a refused request unapprovable. Which
 * cookies, redirects and HTTP statuses really produce those states, and that the
 * granted scopes really reach a live token, is the e2e criterion's job.
 *
 * The real translations are loaded (not a stub `t`) so a missing key would render
 * as its own namespaced path and the assertions below would see it.
 */

const SEARCH =
  '?client_id=client-1&redirect_uri=http%3A%2F%2F127.0.0.1%3A8765%2Fcallback'
  + '&state=state-1&code_challenge=challenge-1&code_challenge_method=S256';

const { contextMock, decideMock, locationRef } = vi.hoisted(() => ({
  contextMock: vi.fn(),
  decideMock: vi.fn(),
  locationRef: {
    search:
      '?client_id=client-1&redirect_uri=http%3A%2F%2F127.0.0.1%3A8765%2Fcallback'
      + '&state=state-1&code_challenge=challenge-1&code_challenge_method=S256',
  },
}));

vi.mock('@/shared/api', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    api: { oauthConsent: { context: contextMock, decide: decideMock } },
  };
});

vi.mock('@/modules/auth', () => ({ useAuth: () => ({ user: { username: 'ada' } }) }));

vi.mock('react-router-dom', () => ({ useLocation: () => locationRef }));

await i18next.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  ns: ['consent'],
  defaultNS: 'consent',
  resources: { en: { consent: enConsent } },
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

const CONSENT_CONTEXT: OAuthConsentContext = {
  clientName: 'ChatGPT',
  callbackHost: '127.0.0.1:8765',
  redirectUri: 'http://127.0.0.1:8765/callback',
  scopes: [
    { scope: 'cloudcli:read', description: 'read', required: true, writable: false },
    { scope: 'cloudcli:session:send', description: 'send', required: false, writable: true },
    { scope: 'cloudcli:session:create', description: 'create', required: false, writable: true },
    { scope: 'cloudcli:session:control', description: 'control', required: false, writable: true },
    { scope: 'cloudcli:approve', description: 'approve', required: false, writable: true },
    { scope: 'cloudcli:navigate', description: 'navigate', required: false, writable: true },
  ],
  state: 'state-1',
};

/** A Response-shaped object; the hook reads only `ok`, `status` and `json()`. */
const okJson = (data: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => data });

beforeEach(() => {
  contextMock.mockReset();
  decideMock.mockReset();
  locationRef.search = SEARCH;
});

describe('useOAuthConsent', () => {
  test('loads the context and pins exactly the required read scope', async () => {
    contextMock.mockReturnValue(okJson(CONSENT_CONTEXT));
    const { result } = renderHook(() => useOAuthConsent(SEARCH, vi.fn()));

    await waitFor(() => assert.equal(result.current.phase, 'ready'));
    assert.deepEqual(result.current.selectedScopes, ['cloudcli:read']);
    assert.equal(result.current.hasWriteSelection, false);
    assert.equal(result.current.context?.clientName, 'ChatGPT');
  });

  test('a ticked write scope turns on the risk warning and is submitted with Allow', async () => {
    contextMock.mockReturnValue(okJson(CONSENT_CONTEXT));
    decideMock.mockReturnValue(okJson({ redirectTo: 'http://127.0.0.1:8765/callback?code=abc&state=state-1' }));
    const navigate = vi.fn();
    const { result } = renderHook(() => useOAuthConsent(SEARCH, navigate));
    await waitFor(() => assert.equal(result.current.phase, 'ready'));

    act(() => result.current.toggleScope('cloudcli:navigate', true));
    assert.equal(result.current.hasWriteSelection, true);

    await act(async () => result.current.decide('allow'));
    const decision = decideMock.mock.calls[0][0] as { scopes: string[]; action: string };
    assert.equal(decision.action, 'allow');
    assert.deepEqual([...decision.scopes].sort(), ['cloudcli:navigate', 'cloudcli:read'].sort());
    assert.equal(navigate.mock.calls[0][0], 'http://127.0.0.1:8765/callback?code=abc&state=state-1');
  });

  test('Deny submits no scopes and still navigates to the callback', async () => {
    contextMock.mockReturnValue(okJson(CONSENT_CONTEXT));
    decideMock.mockReturnValue(okJson({ redirectTo: 'http://127.0.0.1:8765/callback?error=access_denied&state=state-1' }));
    const navigate = vi.fn();
    const { result } = renderHook(() => useOAuthConsent(SEARCH, navigate));
    await waitFor(() => assert.equal(result.current.phase, 'ready'));

    act(() => result.current.toggleScope('cloudcli:navigate', true));
    await act(async () => result.current.decide('deny'));

    const decision = decideMock.mock.calls[0][0] as { scopes: string[]; action: string };
    assert.equal(decision.action, 'deny');
    assert.deepEqual(decision.scopes, []);
    assert.equal(navigate.mock.calls[0][0], 'http://127.0.0.1:8765/callback?error=access_denied&state=state-1');
  });

  test('a link with no client_id never reaches the server and reports missing-request', async () => {
    const { result } = renderHook(() => useOAuthConsent('?redirect_uri=http%3A%2F%2F127.0.0.1%2Fcb', vi.fn()));
    await waitFor(() => assert.equal(result.current.phase, 'error'));
    assert.equal(result.current.error?.kind, 'missing-request');
    assert.equal(contextMock.mock.calls.length, 0);
  });

  test('a 401 from the context endpoint is the unauthorized face, not a generic error', async () => {
    contextMock.mockRejectedValue(new ApiRequestError('Unauthorized', { status: 401 }));
    const { result } = renderHook(() => useOAuthConsent(SEARCH, vi.fn()));
    await waitFor(() => assert.equal(result.current.phase, 'unauthorized'));
    assert.equal(result.current.error?.kind, 'unauthorized');
  });
});

describe('OAuthConsentRoute', () => {
  test('renders the client, the callback host and six scopes with only the read box checked and disabled', async () => {
    contextMock.mockReturnValue(okJson(CONSENT_CONTEXT));
    render(<OAuthConsentRoute />);

    await waitFor(() => assert.ok(screen.queryByTestId('consent-allow')));
    assert.equal(screen.getByTestId('consent-client-name').textContent, 'ChatGPT');
    assert.equal(screen.getByTestId('consent-callback-host').textContent, '127.0.0.1:8765');

    const rows = screen.getAllByTestId('consent-scope');
    assert.equal(rows.length, 6);
    const boxes = screen.getAllByTestId('consent-scope-checkbox') as HTMLInputElement[];
    assert.deepEqual(boxes.map((box) => box.checked), [true, false, false, false, false, false]);
    assert.deepEqual(boxes.map((box) => box.disabled), [true, false, false, false, false, false]);
    // No write scope is ticked, so the risk warning is absent until one is.
    assert.equal(screen.queryByTestId('consent-write-warning'), null);
  });

  test('ticking a write scope reveals the risk warning', async () => {
    contextMock.mockReturnValue(okJson(CONSENT_CONTEXT));
    render(<OAuthConsentRoute />);
    await waitFor(() => assert.ok(screen.queryByTestId('consent-allow')));

    const navigateRow = screen
      .getAllByTestId('consent-scope')
      .find((row) => row.getAttribute('data-scope') === 'cloudcli:navigate');
    assert.ok(navigateRow);
    const box = navigateRow.querySelector('input') as HTMLInputElement;
    await act(async () => box.click());

    await waitFor(() => assert.ok(screen.queryByTestId('consent-write-warning')));
  });

  test('a refused request shows the error face and offers no Allow button', async () => {
    contextMock.mockRejectedValue(
      new ApiRequestError('redirect_uri is not registered for this client', { status: 400 }),
    );
    render(<OAuthConsentRoute />);

    await waitFor(() => assert.ok(screen.queryByTestId('consent-error')));
    assert.equal(screen.queryByTestId('consent-allow'), null);
    assert.equal(screen.queryByTestId('consent-deny'), null);
    assert.ok(screen.getByTestId('consent-error-message').textContent?.trim());
  });
});
