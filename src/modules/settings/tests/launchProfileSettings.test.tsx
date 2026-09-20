import assert from 'node:assert/strict';

import { act, fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, test, vi } from 'vitest';

import LaunchProfilesSettingsTab from '@/modules/settings/tabs/launch-profiles-settings/LaunchProfilesSettingsTab';

/** AC-010: the Profiles tab lists every profile and saves an edit with PUT /api/launch-profiles/:id. */

const authenticatedFetch = vi.hoisted(() => vi.fn());
vi.mock('@/shared/api', () => ({ authenticatedFetch }));

const ok = (data: unknown) => Promise.resolve({ ok: true, json: async () => data });

beforeEach(() => {
  authenticatedFetch.mockReset();
  authenticatedFetch.mockImplementation((_url: string, options?: { method?: string }) =>
    options?.method === 'PUT'
      ? ok({})
      : ok({ profiles: [{ id: 'p-1', name: 'Alpha', model: 'm1', credentialRef: 'cred-a' }, { id: 'p-2', name: 'Beta', model: 'm2' }] }));
});

test('lists every profile and PUTs the edited fields', async () => {
  const view = render(<LaunchProfilesSettingsTab />);

  await waitFor(() => {
    assert.ok(view.getByDisplayValue('Alpha'));
    assert.ok(view.getByDisplayValue('Beta'));
  });
  // Credentials show as a reference name only.
  assert.ok(view.getByText('cred-a'));

  fireEvent.change(view.getByDisplayValue('Beta'), { target: { value: 'Beta renamed' } });
  const saveButtons = view.getAllByRole('button');
  await act(async () => { fireEvent.click(saveButtons[1]); });

  await waitFor(() => {
    const put = authenticatedFetch.mock.calls.find(([, options]) => options?.method === 'PUT');
    assert.ok(put);
    assert.equal(put[0], '/api/launch-profiles/p-2');
    assert.deepEqual(JSON.parse(put[1].body), { name: 'Beta renamed', model: 'm2' });
  });
});
