import { useTranslation } from 'react-i18next';
import { Play, Square } from 'lucide-react';

import { Button } from '@/shared/ui';
import type { VoiceClip, VoicePlayState } from '@/shared/types';

type VoiceClipButtonProps = {
  clip: VoiceClip;
  state: VoicePlayState;
  onToggle: () => void;
};

/** `M:SS`, which is all the pill has room for; the recorder's sub-second precision is not shown. */
const formatDuration = (durationMs: number) => {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}:${String(totalSeconds % 60).padStart(2, '0')}`;
};

/** Recording size, rounded to a single unit — the exact byte count is never what the user is reading for. */
const formatBytes = (bytes: number) => {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
};

/**
 * Rendered by chat's ChatComposer immediately right of the microphone, and only
 * while a recording is in the slot. Replays the last thing the user said.
 *
 * Ghost styling on purpose: `TokenUsageSummary` next to it is a bordered pill, and
 * two bordered pills in a row read as the same kind of thing — but one is the
 * previous message and the other is session state.
 */
export default function VoiceClipButton({ clip, state, onToggle }: VoiceClipButtonProps) {
  const { t } = useTranslation('chat');
  const isActive = state !== 'idle';

  // One label, read by both the tooltip and the accessible name, so the announced
  // name cannot drift from the visible one. Mirrors VoiceInputButton's mic.
  const label = isActive ? t('voice.stopPlayback') : t('voice.playRecording');

  return (
    <Button
      type="button"
      variant="ghost"
      onClick={(e) => {
        e.preventDefault();
        onToggle();
      }}
      className="h-8 shrink-0 gap-1.5 rounded-lg px-2 text-xs text-muted-foreground"
      title={label}
      aria-label={label}
    >
      {isActive ? <Square className="h-3 w-3" /> : <Play className="h-3 w-3" />}
      <span className="font-medium tabular-nums text-foreground">{formatDuration(clip.meta.durationMs)}</span>
      <span className="hidden text-muted-foreground/70 sm:inline">{formatBytes(clip.meta.bytes)}</span>
    </Button>
  );
}
