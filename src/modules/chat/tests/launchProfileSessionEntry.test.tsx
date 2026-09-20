import assert from 'node:assert/strict';

import { act, fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, test, vi } from 'vitest';

import LaunchProfileSelect from '@/modules/chat/composer/LaunchProfileSelect';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { resetChatDrafts } from '@/shared/chatDrafts';
import type { PermissionMode, Project } from '@/shared/types';

/**
 * AC-010: the session entry lets the user pick a launch profile, and the real send path puts its id
 * on `chat.send`. With no pick the field is absent so the server resolves a profile itself.
 */

const PROJECT: Project = { projectId: 'project-1', displayName: 'Project One', fullPath: '/tmp/project-one' };

vi.mock('@/shared/api', () => {
  const okJson = (data: unknown) => Promise.resolve({ ok: true, json: async () => data });
  return {
    authenticatedFetch: (url: string) =>
      okJson(url === '/api/launch-profiles' ? { profiles: [{ id: 'p-1', name: 'Alpha' }, { id: 'p-2', name: 'Beta' }] } : {}),
    api: {
      user: {
        drafts: () => okJson({ success: true, drafts: [] }),
        saveDraft: () => okJson({ success: true }),
        deleteDraft: () => okJson({ success: true }),
        preferences: () => okJson({ success: true, preferences: {} }),
        savePreferences: () => okJson({ success: true, preferences: {} }),
      },
      commands: { list: () => okJson({ success: true, commands: [] }) },
      files: { search: () => okJson({ success: true, files: [] }) },
    },
  };
});

const sent: Array<Record<string, unknown>> = [];

// Wires the real composer hook to the real select, the same way ChatInterface wires ChatComposer.
function Harness() {
  const composer = useChatComposerState({
    selectedProject: PROJECT,
    selectedSession: { id: 'session-a' },
    currentSessionId: 'session-a',
    provider: 'claude',
    permissionMode: 'default',
    cyclePermissionMode: () => undefined,
    resolvePermissionModeForProvider: () => 'default' as PermissionMode,
    currentProviderModel: 'test-model',
    currentProviderEffort: 'medium',
    isLoading: false,
    canAbortSession: false,
    tokenBudget: null,
    sendMessage: (message: Record<string, unknown>) => { sent.push(message); },
    scrollToBottom: () => undefined,
    addMessage: () => undefined,
    setIsUserScrolledUp: () => undefined,
    setPendingPermissionRequests: () => undefined,
  } as Parameters<typeof useChatComposerState>[0]);

  return (
    <div>
      <LaunchProfileSelect value={composer.launchProfileId} onChange={composer.setLaunchProfileId} />
      <button type="button" onClick={() => composer.setInput('hello')}>type</button>
      <button type="button" onClick={(event) => composer.handleSubmit(event)}>send</button>
    </div>
  );
}

const sendHello = async (view: ReturnType<typeof render>) => {
  await act(async () => { fireEvent.click(view.getByText('type')); });
  await act(async () => { fireEvent.click(view.getByText('send')); });
  await waitFor(() => assert.equal(sent.length, 1));
  return sent[0];
};

beforeEach(() => {
  sent.length = 0;
  localStorage.clear();
  resetChatDrafts();
});

test('the selected profile id is sent on chat.send', async () => {
  const view = render(<Harness />);
  const select = await view.findByLabelText('Launch profile');
  await view.findByText('Beta');
  await act(async () => { fireEvent.change(select, { target: { value: 'p-2' } }); });

  const message = await sendHello(view);
  assert.equal(message.type, 'chat.send');
  assert.equal(message.launchProfileId, 'p-2');
});

test('without a pick chat.send carries no launchProfileId', async () => {
  const view = render(<Harness />);
  await view.findByLabelText('Launch profile');

  const message = await sendHello(view);
  assert.equal(message.type, 'chat.send');
  assert.equal('launchProfileId' in message, false);
});
