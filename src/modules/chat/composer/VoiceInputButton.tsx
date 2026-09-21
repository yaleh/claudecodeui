import { useTranslation } from 'react-i18next';
import { Mic, Square, Loader2 } from 'lucide-react';

import { PromptInputButton } from '@/modules/chat/composer/PromptInput';
import type { VoiceInputState } from '@/shared/types';

type Props = {
  state: VoiceInputState;
  onToggle: () => void;
  errorMsg?: string | null;
};

// Rendered by chat's ChatComposer next to the send button.
// Push-to-talk mic button (presentational). Recording state and the stop-and-send action
// are owned by the composer so the main Send button can drive them too. This button just
// starts recording and, while recording, stops and drops the transcript into the input box.
export default function VoiceInputButton({ state, onToggle, errorMsg }: Props) {
  const { t } = useTranslation('chat');

  const icon =
    state === 'recording' ? (
      <Square className="text-red-500" />
    ) : state === 'transcribing' ? (
      <Loader2 className="animate-spin" />
    ) : (
      <Mic />
    );

  // One label, read by both the tooltip and the accessible name. The tooltip is a
  // self-drawn layer: it is not announced, so the button needs `aria-label` too, and
  // two separate expressions would let the announced name drift from the visible one.
  const label = state === 'recording' ? t('voice.stopRecording') : t('voice.input');

  return (
    <span className="relative inline-flex">
      {errorMsg && (
        <span className="absolute bottom-full left-1/2 mb-1 -translate-x-1/2 whitespace-nowrap rounded bg-red-600 px-2 py-1 text-xs text-white shadow-lg">
          {errorMsg}
        </span>
      )}
      <PromptInputButton
        tooltip={{ content: label }}
        aria-label={label}
        onClick={(e: { preventDefault: () => void }) => {
          e.preventDefault();
          onToggle();
        }}
      >
        {icon}
      </PromptInputButton>
    </span>
  );
}
