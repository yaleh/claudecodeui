import assert from 'node:assert/strict';

import { act, fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, test, vi } from 'vitest';

import ModelsContent from '@/modules/settings/tabs/agents-settings/sections/content/ModelsContent';

/** AC-026: saving a model never submits an unedited secret value nor overwrites fields the form did not edit. */

const providers = vi.hoisted(() => ({
  models: vi.fn(),
  modelEnvStatus: vi.fn(),
  createModel: vi.fn(),
  updateModel: vi.fn(),
  deleteModel: vi.fn(),
}));
vi.mock('@/shared/api', () => ({ api: { providers }, authenticatedFetch: vi.fn() }));

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string, options?: { name?: string }) => (options?.name ? `${key}:${options.name}` : key) }),
}));
// The chat barrel drags in the whole chat UI; the settings tests need only the panel.
vi.mock('@/modules/chat', async () => ({
  ModelLibraryPanel: (await import('@/modules/chat/modals/ModelLibraryPanel')).default,
}));

const ok = (data: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => data });
const catalog = {
  OPTIONS: [{
    value: 'gw-model', label: 'Gateway Model', recordId: 7, isCustom: true,
    config: { env: [
      { key: 'ANTHROPIC_AUTH_TOKEN', kind: 'secret', isSet: true },
      { key: 'FOO', kind: 'value', value: 'bar' },
    ] },
  }],
  DEFAULT: 'x',
};

beforeEach(() => {
  Object.values(providers).forEach((mock) => mock.mockReset());
  providers.models.mockImplementation(() => ok({ success: true, data: { models: catalog } }));
  providers.modelEnvStatus.mockImplementation(() => ok({ success: true, data: { status: {} } }));
  providers.updateModel.mockImplementation(() => ok({ success: true, data: { model: catalog.OPTIONS[0], models: catalog } }));
});

const openEditor = async () => {
  const view = render(<ModelsContent agent="claude" />);
  await waitFor(() => assert.ok(view.getByText('Gateway Model')));
  fireEvent.click(view.getByLabelText('Edit Gateway Model'));
  return view;
};

test('renaming without touching env sends no config at all', async () => {
  const view = await openEditor();
  fireEvent.change(view.getByDisplayValue('Gateway Model'), { target: { value: 'Renamed' } });
  await act(async () => { fireEvent.click(view.getByText('Save changes')); });

  const [, , body] = providers.updateModel.mock.calls[0];
  assert.deepStrictEqual(body, { model: 'Renamed', id: 'gw-model' });
});

test('editing another row keeps the stored secret without a value; replacing sends only the new value', async () => {
  const view = await openEditor();
  fireEvent.change(view.getByDisplayValue('bar'), { target: { value: 'baz' } });
  await act(async () => { fireEvent.click(view.getByText('Save changes')); });

  let body = providers.updateModel.mock.calls[0][2];
  assert.deepStrictEqual(body.config.env, [
    { key: 'ANTHROPIC_AUTH_TOKEN', kind: 'secret' },
    { key: 'FOO', kind: 'value', value: 'baz' },
  ]);
  assert.equal(JSON.stringify(body).includes('isSet'), false);

  fireEvent.click(view.getByLabelText('Edit Gateway Model'));
  fireEvent.change(view.getByLabelText('modelLibrary.env.secretValue'), { target: { value: 'new-secret' } });
  await act(async () => { fireEvent.click(view.getByText('Save changes')); });
  body = providers.updateModel.mock.calls[1][2];
  assert.deepStrictEqual(body.config.env[0], { key: 'ANTHROPIC_AUTH_TOKEN', kind: 'secret', value: 'new-secret' });
});
