import assert from 'node:assert/strict';

import { fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import { afterAll, beforeEach, test, vi } from 'vitest';

// THE REGISTRY BEFORE THE ADAPTER, and the order of these two lines is load-bearing rather than
// cosmetic. This seam's modules form one import cycle — each adapter reads `declaredAcceptsMime` back
// out of the registry — so whichever of the two is EVALUATED first starts the cycle, and a module
// that enters through an ADAPTER reads the registry's bindings while they are still in their temporal
// dead zone. Declaring the registry first is what guarantees it is evaluated first. The last case
// below needs both: it renders the form from the rows the deployment really publishes, so the
// provider under test is derived from the registry rather than named in this file.
import { listProviders } from '@shared/asr/asrRegistry';
import { installSensevoiceEngine } from '@shared/asr/list/sensevoice-local/sensevoice-local.asr-provider';
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
    // Every interpolation the call supplied, not just `provider`. The last case below reads a build
    // id the form put on screen, and a mock that interpolated one option would make that value
    // unreachable through the translation — leaving the case to assert the key was called rather
    // than that the deployment's build reached the page.
    t: (key: string, options?: Record<string, unknown>) => {
      if (!options) return key;
      const fields = Object.entries(options).map(([name, value]) => `${name}=${String(value)}`);
      return `${key}:${fields.join(',')}`;
    },
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
  credentialFields?: { endpointField: string; apiKeyField: string; modelField?: string; defaultModel?: string };
  /**
   * The third declaration a row can carry, and the one the last case is about: what a provider says
   * about its OWN ability to run. Absent for every fabricated row above, which is the shape the
   * remote providers publish — see `readVoiceProviderOptions` for why absence and "unavailable" are
   * different readings rather than the same one spelled twice.
   */
  runtime?: { available: true; state: string; buildId: string } | { available: false; state: string; reason: string };
};

/**
 * The provider declarations each case is rendered from.
 *
 * `alpha-asr` fills all three slots, `beta-asr` leaves the model out (the same provider shape
 * without a per-user model to choose), `gamma-asr` declares nothing at all — the shared backend's
 * shape — and `delta-asr` declares fields this client does not store.
 *
 * WHY THE NAMES ARE THE DEPLOYMENT'S OWN FIELD NAMES and not the ones a reader might expect for a
 * provider-shaped payload: a declaration maps three SLOTS onto names the client stores, so every
 * name here has to be one of those or the form renders nothing (the `delta-asr` case is that
 * refusal, asserted rather than assumed — see the file comment above). The slots are filled with
 * `baseUrl`/`apiKey`/`sttModel` because those are the names this client stores that mean an
 * address, a key and a model — and because the settings module carries no provider's name
 * anywhere, this file included: a reading that needed one provider's literal in the module would
 * be red on a rule the module itself is held to. The slot, not the name, is what the form reads
 * either way, which is exactly what the swap below exercises.
 */
const ALPHA_DECLARATION = {
  endpointField: 'baseUrl',
  apiKeyField: 'apiKey',
  modelField: 'sttModel',
};
const BETA_DECLARATION = { endpointField: 'baseUrl', apiKeyField: 'apiKey' };
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
  // Scoped by EXCLUDING the declared section rather than by name alone: a declaration maps its
  // slots onto stored names, and the names this case declares are two the shared block also
  // renders — so `input[name="baseUrl"]` alone would count both copies and the reading would be
  // about the page's total rather than about the shared block's own two.
  const shared = Array.from(
    view.container.querySelectorAll('input[name="baseUrl"], input[name="apiKey"]'),
  ).filter((input) => !input.closest('[data-testid="voice-provider-fields"]'));
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

test('an empty model box shows the declared default as its placeholder, and falls back to the generic text without one', async () => {
  const withDefault = { ...ALPHA_DECLARATION, defaultModel: 'alpha-default-model' };
  voice.health.mockImplementation(() => ok({
    configured: true,
    provider: 'alpha-asr',
    providers: [row('alpha-asr', 'Alpha ASR', withDefault)],
  }));

  const view = render(<VoiceSettingsTab />);
  await waitFor(() => assert.ok(renderedFields(view).includes(ALPHA_DECLARATION.modelField)));
  // What a blank box will do is on screen: the provider's own default model, not a generic word.
  assert.equal(renderedField(view, ALPHA_DECLARATION.modelField).placeholder, 'alpha-default-model');

  // A provider that declares no default keeps the generic placeholder, so the box is never bare.
  voice.health.mockImplementation(() => ok({
    configured: true,
    provider: 'alpha-asr',
    providers: [row('alpha-asr', 'Alpha ASR', ALPHA_DECLARATION)],
  }));
  view.unmount();
  const plain = render(<VoiceSettingsTab />);
  await waitFor(() => assert.ok(renderedFields(plain).includes(ALPHA_DECLARATION.modelField)));
  assert.notEqual(renderedField(plain, ALPHA_DECLARATION.modelField).placeholder, 'alpha-default-model');
  assert.notEqual(renderedField(plain, ALPHA_DECLARATION.modelField).placeholder, '');
});

test('the provider that runs on this server shows no credential field of its own, says what it is, and saves', async () => {
  // THE EMPTY DOCUMENT IS WHAT MAKES THE SELECTION REAL. `useVoiceConfig` hydrates from the mocked
  // server, so `providerId` starts empty and the form falls back to the FIRST row — which is why the
  // remote recogniser is listed first here and the local one second. Selecting the local one is then
  // a change the form has to record, rather than a value it happened to render.
  //
  // BOTH ROWS COME FROM THE DEPLOYMENT'S OWN REGISTRY, and neither id is written in this file. The
  // case is about the recogniser this build ships, so inventing a row for it would prove something
  // about a payload nobody serves; taking the rows from `listProviders()` means a rename or a
  // second local engine moves the case with it. The fabricated rows in the cases above are still what
  // holds the FORM to its rule — this case is about the deployment, and they are about the form.
  const adapters = listProviders();
  const engineAdapter = adapters.find((adapter) => adapter.runtime !== undefined);
  const remoteAdapter = adapters.find((adapter) => adapter.credentials !== undefined);
  assert.ok(engineAdapter, 'the registry publishes no provider with a runtime reading');
  assert.ok(remoteAdapter, 'the registry publishes no provider with credential fields');
  assert.equal(
    adapters.filter((adapter) => adapter.runtime !== undefined).length,
    1,
    'more than one provider declares a runtime, so "the local one" would be ambiguous here',
  );

  // The engine is installed exactly as the composition root installs one, and reports the state a
  // healthy deployment is in. A build id is a fixture because this case reads it off the PAGE, so it
  // has to be a value the case chose: an assertion against a build id read from the same registry the
  // page read it from would pass whatever the two agreed on.
  const BUILD_ID = 'build-under-test-8f31';
  installSensevoiceEngine({
    status: () => ({ available: true, state: 'ready', buildId: BUILD_ID }),
    ensureReady: () => Promise.resolve({ available: true, state: 'ready', buildId: BUILD_ID }),
    transcribe: () => Promise.reject(new Error('this case never transcribes')),
  });

  try {
    voice.health.mockImplementation(() => ok({
      configured: true,
      provider: remoteAdapter.id,
      providers: [
        { id: remoteAdapter.id, label: remoteAdapter.id, configured: true, credentialFields: remoteAdapter.credentials },
        { id: engineAdapter.id, label: engineAdapter.id, configured: true, runtime: engineAdapter.runtime?.() },
      ],
    }));

    const view = render(<VoiceSettingsTab />);
    await waitFor(() => assert.equal(providerSelect(view).options.length, 2));

    // THE POSITIVE CONTROL FIRST: the remote provider's declaration IS rendered, so the absence the
    // next reading finds cannot be a form that renders nothing for anybody.
    await waitFor(() => assert.ok(renderedFields(view).length > 0));
    assert.equal(renderedFields(view).length, 3, 'the remote declaration declares three fields');

    fireEvent.change(providerSelect(view), { target: { value: engineAdapter.id } });
    await waitFor(() => assert.equal(providerSelect(view).value, engineAdapter.id));

    // THE READING THE CRITERION NAMES: no credential field of its own — not an empty input, not a
    // disabled one, and not the declared section at all — because this recogniser declares no
    // credential fields. The block the remote provider filled is gone rather than blanked.
    assert.equal(view.queryByTestId('voice-provider-fields'), null);
    assert.deepStrictEqual(renderedFields(view), []);

    // What stands in its place says what this provider is and which build is deployed. That is the
    // copy this change adds: a user who selects a recogniser that needs no key has to be able to read
    // that from the page rather than infer it from an absent box.
    const runtime = view.getByTestId('voice-provider-runtime');
    assert.match(runtime.textContent ?? '', new RegExp(`provider=${engineAdapter.id}`));
    assert.match(runtime.textContent ?? '', new RegExp(`buildId=${BUILD_ID}`));

    // AND IT SAVES: the choice reaches the document the server is sent. The form writes the same
    // whole document here as in the case above — the point is that a provider with no fields of its
    // own is still a provider the user can select and keep.
    await waitFor(
      () => assert.ok(voice.saveConfig.mock.calls.length > 0, 'selecting the local provider saved nothing'),
      { timeout: 4_000 },
    );
    const sent = voice.saveConfig.mock.calls[voice.saveConfig.mock.calls.length - 1][0] as Record<string, unknown>;
    assert.equal(sent.providerId, engineAdapter.id);
    for (const field of ['baseUrl', 'apiKey', 'sttModel', 'ttsModel', 'ttsVoice', 'ttsFormat']) {
      assert.ok(field in sent, `${field} is missing from the saved document`);
    }

    console.log(
      `[settings] local provider: id=${engineAdapter.id} buildId=${BUILD_ID}`
        + ` declaredFields=${renderedFields(view).length} saved=providerId:${String(sent.providerId)}`,
    );
  } finally {
    // The engine is a module-level singleton in the adapter, so a case that installs one has to take
    // it away again: the next file to read `runtime()` would otherwise be handed this fixture.
    installSensevoiceEngine(null);
  }
});
