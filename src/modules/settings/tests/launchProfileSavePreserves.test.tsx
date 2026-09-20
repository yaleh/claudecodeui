import assert from 'node:assert/strict';

import { act, fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, test, vi } from 'vitest';

import LaunchProfilesSettingsTab from '@/modules/settings/tabs/launch-profiles-settings/LaunchProfilesSettingsTab';

/** AC-019: saving an existing profile never submits fields the form did not edit. */

const authenticatedFetch = vi.hoisted(() => vi.fn());
vi.mock('@/shared/api', () => ({ authenticatedFetch }));

const ok = (data: unknown) => Promise.resolve({ ok: true, json: async () => data });
const existing = {
  id: 'p-1',
  name: 'Alpha',
  provider: 'claude',
  description: 'keep me',
  deployment: 'direct',
  isDefault: true,
  sortOrder: 3,
  config: { defaultModel: 'm1', baseUrl: 'https://gw.test', env: { FOO: 'bar' } },
};

beforeEach(() => {
  authenticatedFetch.mockReset();
  authenticatedFetch.mockImplementation((_url: string, options?: { method?: string }) =>
    options?.method === 'PUT' ? ok({ ...existing, name: 'Alpha 2' }) : ok({ profiles: [existing] }));
});

test('PUT body omits isDefault/deployment/description/sortOrder and keeps unedited config keys', async () => {
  const view = render(<LaunchProfilesSettingsTab />);
  await waitFor(() => assert.ok(view.getByDisplayValue('Alpha')));
  fireEvent.change(view.getByDisplayValue('Alpha'), { target: { value: 'Alpha 2' } });
  await act(async () => { fireEvent.click(view.getByRole('button', { name: 'launchProfiles.save' })); });

  await waitFor(() => {
    const put = authenticatedFetch.mock.calls.find(([, options]) => options?.method === 'PUT');
    assert.ok(put);
    const body = JSON.parse(put[1].body);
    for (const key of ['isDefault', 'deployment', 'description', 'sortOrder']) {
      assert.equal(key in body, false, key);
    }
    assert.equal(body.name, 'Alpha 2');
    assert.deepStrictEqual(body.config.env, { FOO: 'bar' });
    assert.equal(body.config.baseUrl, 'https://gw.test');
  });
});
