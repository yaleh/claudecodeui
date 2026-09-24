import assert from 'node:assert/strict';

import { fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import { afterAll, beforeEach, test, vi } from 'vitest';

import VoiceSettingsTab from '@/modules/settings/tabs/VoiceSettingsTab';
import { resetVoiceConfig } from '@/shared/voiceConfig';

/**
 * AC-142: the settings form's recognition-service select and the credential fields it renders.
 *
 * TWO READINGS, both about the settings document rather than about the form's markup for its own
 * sake. The first is that WHICH BOXES EXIST follows the selected provider's own declaration: the
 * payloads below are fabricated — no registered provider's id appears in this file — so a form
 * that rendered a set of its own, or one keyed off a known id, cannot pass. The second is that the
 * document the form SENDS still carries every field of the provider slot, which is the hazard this
 * whole change closes: the settings are saved as one whole document, so a field the client does not
 * carry is a field the next save deletes on the server.
 *
 * WHAT THE FABRICATED DECLARATION CAN AND CANNOT VARY, said plainly because the boundary is real:
 * the IDS, the labels and which of the three SLOTS a declaration fills are the test's to invent,
 * while the field NAMES have to be names the client stores — the storage is one document with fixed
 * columns, and the form refuses to render an input whose edits `updateVoiceConfig` would drop
 * (`isVoiceConfigField`; the `delta-asr` case below is that refusal, read as an absence). A payload
 * naming an unknown field is therefore not an untested case but an asserted one.
 */

const voice = vi.hoisted(() => ({
  health: vi.fn(),
  config: vi.fn(),
  saveConfig: vi.fn(),
}));

vi.mock('@/shared/api', () => ({ api: { voice }, authenticatedFetch: vi.fn() }));

// The form's enable switch and the language are not what either reading is about; the provider list
// comes from the mocked `api.voice.health` below, which is the seam under test.
vi.mock('@/shared/context/UiPreferencesContext', () => ({
  useUiPreferences: () => ({ voiceEnabled: true }),
  useSetUiPreference: () => () => {},
}));

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal() as object),
  useTranslation: () => ({
    t: (key: string, options?: { provider?: string }) => (options?.provider ? `${key}:${options.provider}` : key),
  }),
}));

const ok = (data: unknown) => Promise.resolve({ ok: true, json: async () => data });

/** The empty document the server answers the form's hydration with: nothing stored yet. */
const EMPTY_SERVER_DOCUMENT = {
  baseUrl: '',
  apiKey: '',
  sttModel: '',
  ttsModel: '',
  ttsVoice: '',
  ttsFormat: '',
};

type Row = {
  id: string;
  label: string;
  configured: boolean;
  credentialFields?: { endpointField: string; apiKeyField: string; modelField?: string };
};

/**
 * The provider declarations each case is rendered from.
 *
 * `alpha-asr` fills all three slots, `beta-asr` leaves the model out (the same provider shape
 * without a per-user model to choose), `gamma-asr` declares nothing at all — the shared backend's
 * shape — and `delta-asr` declares fields this client does not store.
 */
const ALPHA_DECLARATION = {
  endpointField: 'dashscopeEndpoint',
  apiKeyField: 'dashscopeApiKey',
  modelField: 'dashscopeModel',
};
const BETA_DECLARATION = { endpointField: 'dashscopeEndpoint', apiKeyField: 'dashscopeApiKey' };
const DELTA_DECLARATION = { endpointField: 'gammaEndpoint', apiKeyField: 'gammaKey' };

const row = (id: string, label: string, credentialFields?: Row['credentialFields']): Row => ({
  id,
  label,
  configured: true,
  ...(credentialFields ? { credentialFields } : {}),
});

/** The inputs the form rendered for a provider's own fields, by the name each one edits. */
const renderedFields = (view: ReturnType<typeof render>): string[] => {
  const section = view.queryByTestId('voice-provider-fields');
  if (!section) {
    return [];
  }
  return Array.from(section.querySelectorAll('input')).map((input) => (input as HTMLInputElement).name);
};

const renderedField = (view: ReturnType<typeof render>, name: string): HTMLInputElement => {
  const section = view.getByTestId('voice-provider-fields');
  const input = Array.from(section.querySelectorAll('input')).find((node) => (node as HTMLInputElement).name === name);
  assert.ok(input, `no rendered input is named ${name}`);
  return input as HTMLInputElement;
};

/** The select the provider is chosen with, named by the stored field it edits. */
const providerSelect = (view: ReturnType<typeof render>): HTMLSelectElement =>
  view.container.querySelector('select[name="providerId"]') as HTMLSelectElement;

/** How many cases this file's run has executed, printed once at the end as the criterion's reading. */
let cases = 0;

beforeEach(() => {
  cases += 1;
  voice.health.mockReset();
  voice.config.mockReset();
  voice.saveConfig.mockReset();
  // The settings module is a singleton for the whole tab, so a case that typed into it would
  // otherwise leave its values in the next case's document. Resetting it re-hydrates from the
  // mocked server, which is what makes every case start from the same (empty) document.
  resetVoiceConfig();
  voice.config.mockImplementation(() => ok({ ...EMPTY_SERVER_DOCUMENT }));
  voice.saveConfig.mockImplementation(() => ok({ ...EMPTY_SERVER_DOCUMENT }));
});

afterAll(() => {
  console.log(`cases=${cases}`);
});

test('the rendered fields are the selected provider\'s own declaration, and only those', async () => {
  voice.health.mockImplementation(() => ok({
    configured: true,
    provider: 'alpha-asr',
    providers: [row('alpha-asr', 'Alpha ASR', ALPHA_DECLARATION), row('beta-asr', 'Beta ASR', BETA_DECLARATION)],
  }));

  const view = render(<VoiceSettingsTab />);

  // The select's options are the payload's rows, label and all — not ids this file invented for
  // the form to have chosen from.
  await waitFor(() => assert.equal(providerSelect(view).options.length, 2));
  assert.deepStrictEqual(
    Array.from(providerSelect(view).options).map((option) => option.textContent),
    ['Alpha ASR', 'Beta ASR'],
  );

  // A declaration's own names, in its own slots: the three the payload declared and no others. The
  // legacy shared-backend fields are rendered elsewhere on the page (they are what a provider
  // reached through the deployment's backend uses), which is exactly why the reading is scoped to
  // this section rather than to every input on the page.
  await waitFor(() => assert.deepStrictEqual(renderedFields(view), [
    ALPHA_DECLARATION.endpointField,
    ALPHA_DECLARATION.apiKeyField,
    ALPHA_DECLARATION.modelField,
  ]));
  const shared = view.container.querySelectorAll('input[name="baseUrl"], input[name="apiKey"]');
  assert.equal(shared.length, 2, 'the shared backend fields are still rendered beside the declared ones');
  assert.equal(renderedField(view, ALPHA_DECLARATION.apiKeyField).type, 'password');

  // SWAPPING THE SELECTION SWAPS THE FILED SET, from a second declaration in the same payload:
  // `beta-asr` declares no model, so its model box goes away rather than staying behind as a field
  // the server would never read for that provider.
  fireEvent.change(providerSelect(view), { target: { value: 'beta-asr' } });
  await waitFor(() => assert.deepStrictEqual(renderedFields(view), [
    BETA_DECLARATION.endpointField,
    BETA_DECLARATION.apiKeyField,
  ]));

  // ...and a provider that declares nothing gets no declared section at all, which is the shape
  // every provider reached through the deployment's backend has.
  voice.health.mockImplementation(() => ok({
    configured: true,
    provider: 'gamma-asr',
    providers: [row('gamma-asr', 'Gamma ASR')],
  }));
  view.unmount();
  const sharedOnly = render(<VoiceSettingsTab />);
  await waitFor(() => assert.equal(providerSelect(sharedOnly).value, 'gamma-asr'));
  assert.equal(sharedOnly.queryByTestId('voice-provider-fields'), null);
  assert.deepStrictEqual(renderedFields(sharedOnly), []);
  assert.ok(sharedOnly.container.querySelector('input[name="baseUrl"]'));

  // ...and a declaration naming a field this build does not store renders nothing rather than an
  // input whose edits the whole-document save would drop.
  voice.health.mockImplementation(() => ok({
    configured: true,
    provider: 'delta-asr',
    providers: [row('delta-asr', 'Delta ASR', DELTA_DECLARATION)],
  }));
  sharedOnly.unmount();
  const future = render(<VoiceSettingsTab />);
  await waitFor(() => assert.equal(providerSelect(future).value, 'delta-asr'));
  assert.equal(future.queryByTestId('voice-provider-fields'), null);
});

test('editing a declared field sends a document carrying every new field, the key in plain text', async () => {
  voice.health.mockImplementation(() => ok({
    configured: true,
    provider: 'alpha-asr',
    // Two rows of the same shape, so the case can make the selection a real one: the point of the
    // reading is that a user's choice reaches the document, and a form left on the row it happened
    // to render first would never have made one.
    providers: [row('alpha-asr', 'Alpha ASR', ALPHA_DECLARATION), row('beta-asr', 'Beta ASR', ALPHA_DECLARATION)],
  }));

  const view = render(<VoiceSettingsTab />);
  await waitFor(() => assert.deepStrictEqual(renderedFields(view), [
    ALPHA_DECLARATION.endpointField,
    ALPHA_DECLARATION.apiKeyField,
    ALPHA_DECLARATION.modelField,
  ]));

  fireEvent.change(providerSelect(view), { target: { value: 'beta-asr' } });
  await waitFor(() => assert.equal(providerSelect(view).value, 'beta-asr'));

  const SENTINEL_KEY = 'sk-alpha-sentinel-9d21';
  fireEvent.change(renderedField(view, ALPHA_DECLARATION.endpointField), { target: { value: 'https://workspace.example/api' } });
  fireEvent.change(renderedField(view, ALPHA_DECLARATION.apiKeyField), { target: { value: SENTINEL_KEY } });
  fireEvent.change(renderedField(view, ALPHA_DECLARATION.modelField), { target: { value: 'model-x' } });

  // The save is debounced (one request for a burst of typing), so the document is read off the
  // request the form really made rather than off the module's own state.
  await waitFor(
    () => assert.ok(voice.saveConfig.mock.calls.length > 0, 'the form never sent the settings document'),
    { timeout: 4_000 },
  );
  const sent = voice.saveConfig.mock.calls[voice.saveConfig.mock.calls.length - 1][0] as Record<string, unknown>;

  assert.equal(sent.providerId, 'beta-asr');
  assert.equal(sent[ALPHA_DECLARATION.endpointField], 'https://workspace.example/api');
  assert.equal(sent[ALPHA_DECLARATION.apiKeyField], SENTINEL_KEY, 'the key the user typed goes out as typed');
  assert.equal(sent[ALPHA_DECLARATION.modelField], 'model-x');
  // The six the document already had are still in it: the point of the reading is that the new
  // fields did not displace them (and that a later save cannot delete them by omission).
  for (const field of ['baseUrl', 'apiKey', 'sttModel', 'ttsModel', 'ttsVoice', 'ttsFormat']) {
    assert.ok(field in sent, `${field} is missing from the saved document`);
  }
  console.log(
    `[settings] saved document: providerId=${String(sent.providerId)}`
      + ` fields=${Object.keys(sent).length} keyShape=${SENTINEL_KEY.length}/${SENTINEL_KEY.slice(0, 3)}`,
  );
});
