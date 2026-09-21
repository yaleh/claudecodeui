import { useTranslation } from 'react-i18next';
import { Play, Square } from 'lucide-react';

import { Button } from '@/shared/ui';
import type { VoiceClip, VoiceClipPlayState, VoiceClipSlot, VoiceClipTrack } from '@/shared/types';

type VoiceClipButtonProps = {
  clips: VoiceClipSlot;
  state: VoiceClipPlayState;
  onToggle: (track: VoiceClipTrack) => void;
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
 * The four names a replay control announces, one pair per track.
 *
 * Named rather than assembled from the track at the call site: the accessible name is what the two
 * controls are told apart by — by a screen reader, and by a test that has no other way to say which
 * one it means — so the names are chosen here, once, where the translation keys can be read.
 */
const TRACK_LABELS = {
  original: { idle: 'voice.replayOriginal', active: 'voice.stopReplayOriginal' },
  trimmed: { idle: 'voice.replayTrimmed', active: 'voice.stopReplayTrimmed' },
} as const;

/**
 * One track's replay control: an icon, how long that audio is, and how many bytes it carries.
 *
 * Both numbers are shown because the two controls are read against each other — that is the whole
 * point of keeping the pair — and they disagree in direction: the trimmed audio is the shorter one
 * and, being PCM rather than the recorder's opus, the larger one. `data-clip-url` is the blob this
 * control would play, published so a test can compare the two sources rather than infer them.
 */
function ClipReplay({
  track,
  clip,
  state,
  onToggle,
}: {
  track: VoiceClipTrack;
  clip: VoiceClip;
  state: VoiceClipPlayState[VoiceClipTrack];
  onToggle: (track: VoiceClipTrack) => void;
}) {
  const { t } = useTranslation('chat');
  const isActive = state !== 'idle';

  // One label, read by both the tooltip and the accessible name, so the announced
  // name cannot drift from the visible one. Mirrors VoiceInputButton's mic.
  const label = t(TRACK_LABELS[track][isActive ? 'active' : 'idle']);

  return (
    <Button
      type="button"
      variant="ghost"
      onClick={(e) => {
        e.preventDefault();
        onToggle(track);
      }}
      className="h-8 shrink-0 gap-1.5 rounded-lg px-2 text-xs text-muted-foreground"
      title={label}
      aria-label={label}
      data-clip-url={clip.url}
    >
      {isActive ? <Square className="h-3 w-3" /> : <Play className="h-3 w-3" />}
      <span className="font-medium tabular-nums text-foreground">{formatDuration(clip.meta.durationMs)}</span>
      <span className="hidden text-muted-foreground/70 sm:inline">{formatBytes(clip.meta.bytes)}</span>
    </Button>
  );
}

/**
 * Rendered by chat's ChatComposer immediately right of the microphone, and only
 * while a recording is in the slot. Replays the last thing the user said — and, when
 * the trim applied, the upload that was made of it, so the two can be heard against
 * each other.
 *
 * The trimmed control is absent rather than disabled when there is no trimmed audio
 * (`fallback` in the trim reading): a second control over the recording's own bytes
 * would claim a trim the run never made.
 *
 * Ghost styling on purpose: `TokenUsageSummary` next to it is a bordered pill, and
 * two bordered pills in a row read as the same kind of thing — but one is the
 * previous message and the other is session state.
 */
export default function VoiceClipButton({ clips, state, onToggle }: VoiceClipButtonProps) {
  return (
    <>
      <ClipReplay track="original" clip={clips.original} state={state.original} onToggle={onToggle} />
      {clips.trimmed && (
        <ClipReplay track="trimmed" clip={clips.trimmed} state={state.trimmed} onToggle={onToggle} />
      )}
    </>
  );
}
