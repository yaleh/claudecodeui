import { useTranslation } from 'react-i18next';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ChangeEvent,
  ClipboardEvent,
  FormEvent,
  KeyboardEvent,
  MouseEvent,
  ReactNode,
  RefObject,
  TouchEvent,
} from 'react';
import { PaperclipIcon, MessageSquareIcon, XIcon, Loader2, ArrowUpIcon, PencilIcon } from 'lucide-react';

import { useVoiceInput } from '@/modules/chat/hooks/useVoiceInput';
import { useVoiceAvailable } from '@/modules/chat/hooks/useVoiceAvailable';
import { useSendOnEnter } from '@/modules/chat/hooks/useSendOnEnter';
import { useComposerCompactTier } from '@/modules/chat/hooks/useComposerCompactTier';
import { useDeviceSettings } from '@/shared/hooks/useDeviceSettings';
import { loadProjectIdentifiers } from '@/shared/projectIdentifiers';
import { isVoiceDebugEnabled } from '@/shared/voiceDebug';
import type { QueuedDraft, ScheduledMessage, SlashCommand,SessionActivity,PendingPermissionRequest,PermissionMode,ProviderModelOption,VoiceFailureReport } from '@/shared/types';
import {
  PromptInput,
  PromptInputHeader,
  PromptInputBody,
  PromptInputTextarea,
  PromptInputFooter,
  PromptInputTools,
  PromptInputButton,
  PromptInputSubmit,
} from '@/modules/chat/composer/PromptInput';
import CommandMenu from '@/modules/chat/composer/CommandMenu';
import ActivityIndicator from '@/modules/chat/composer/ActivityIndicator';
import ComposerAttachment from '@/modules/chat/composer/ComposerAttachment';
import VoiceInputButton, { VoiceFailureNotice } from '@/modules/chat/composer/VoiceInputButton';
import VoiceUploadButton from '@/modules/chat/composer/VoiceUploadButton';
import VoiceClipButton from '@/modules/chat/composer/VoiceClipButton';
import PermissionRequestsBanner from '@/modules/chat/composer/PermissionRequestsBanner';
import TokenUsageSummary from '@/modules/chat/composer/TokenUsageSummary';
import QueuedMessageCard from '@/modules/chat/composer/QueuedMessageCard';
import { ScheduleMessagePopover } from '@/modules/chat/composer/ScheduleMessagePopover';
import { ScheduledMessageList } from '@/modules/chat/composer/ScheduledMessageList';
import ComposerModelMenu from '@/modules/chat/composer/ComposerModelMenu';
import ComposerPermissionMenu from '@/modules/chat/composer/ComposerPermissionMenu';
import ComposerMobileMoreMenu from '@/modules/chat/composer/ComposerMobileMoreMenu';

type MentionableFile = {
  name: string;
  path: string;
};

/**
 * Hands a node to a ref, whichever of React's shapes it is.
 *
 * Needed because two refs have to reach the same element: the composer's box is measured by
 * `useComposerCompactTier`, and the form it sits on already carries react-dropzone's root ref —
 * spread onto the form as part of `getRootProps()`, where a plain `ref=` beside the spread would be
 * replaced by it. One callback ref can serve both, but it has to write to a ref it did not create,
 * and a ref of unknown shape is either a function or an object with `current`.
 */
const assignRef = <T,>(ref: unknown, node: T | null) => {
  if (typeof ref === 'function') {
    (ref as (value: T | null) => void)(node);
  } else if (ref && typeof ref === 'object') {
    (ref as { current: T | null }).current = node;
  }
};

type ChatComposerProps = {
  pendingPermissionRequests: PendingPermissionRequest[];
  handlePermissionDecision: (
    requestIds: string | string[],
    decision: { allow?: boolean; message?: string; rememberEntry?: string | null; updatedInput?: unknown },
  ) => void;
  handleGrantToolPermission: (suggestion: { entry: string; toolName: string }) => { success: boolean };
  activity: SessionActivity | null;
  isLoading: boolean;
  onAbortSession: () => void;
  permissionMode: PermissionMode;
  availablePermissionModes: PermissionMode[];
  onSelectPermissionMode: (mode: PermissionMode) => void;
  providerLabel: string;
  effort: string;
  availableEffortOptions: NonNullable<ProviderModelOption['effort']>['values'];
  onSelectEffort: (effort: string) => void;
  model: string;
  availableModelOptions: ProviderModelOption[];
  onSelectModel: (model: string) => void;
  modelsLoading: boolean;
  tokenBudget: Record<string, unknown> | null;
  onShowTokenUsage: () => void;
  slashCommandsCount: number;
  onToggleCommandMenu: () => void;
  hasInput: boolean;
  onClearInput: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement> | MouseEvent<HTMLButtonElement> | TouchEvent<HTMLButtonElement>) => void;
  isDragActive: boolean;
  queuedDraft: QueuedDraft | null;
  /** Set while the composer is replacing an already-sent message. */
  isEditingSentMessage: boolean;
  onCancelEditMessage: () => void;
  /** Messages waiting to be sent to this session later. */
  scheduledMessages: ScheduledMessage[];
  onScheduleMessage: (scheduledFor: Date) => void;
  onCancelScheduledMessage: (id: string) => void;
  onEditQueuedDraft: () => void;
  onDeleteQueuedDraft: () => void;
  attachedFiles: File[];
  onRemoveAttachment: (index: number) => void;
  fileErrors: Map<string, string>;
  showFileDropdown: boolean;
  filteredFiles: MentionableFile[];
  selectedFileIndex: number;
  onSelectFile: (file: MentionableFile) => void;
  filteredCommands: SlashCommand[];
  selectedCommandIndex: number;
  onCommandSelect: (command: SlashCommand, index: number, isHover: boolean) => void;
  onCloseCommandMenu: () => void;
  isCommandMenuOpen: boolean;
  frequentCommands: SlashCommand[];
  getRootProps: (...args: unknown[]) => Record<string, unknown>;
  getInputProps: (...args: unknown[]) => Record<string, unknown>;
  openAttachmentPicker: () => void;
  inputHighlightRef: RefObject<HTMLDivElement>;
  renderInputWithMentions: (text: string) => ReactNode;
  textareaRef: RefObject<HTMLTextAreaElement>;
  input: string;
  onVoiceTranscript?: (text: string, send?: boolean) => void;
  /** Draft scope of the open chat; a change drops the recorded clip, which belongs to the chat it was recorded in. */
  scope: string | null;
  /**
   * The open project, whose file tree supplies the names a transcript gets repaired against.
   * Required rather than optional so a caller that forgets it is a type error instead of a
   * silently repair-less composer; `null` is the honest "no project open" value.
   */
  projectId: string | null;
  /** False while the composer is off screen (another workspace tab): it then stops audio it can no longer offer a control for. */
  isActive: boolean;
  onInputChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  onTextareaClick: (event: MouseEvent<HTMLTextAreaElement>) => void;
  onTextareaKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onTextareaPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  onTextareaScrollSync: (target: HTMLTextAreaElement) => void;
  onTextareaInput: (event: FormEvent<HTMLTextAreaElement>) => void;
  isInputFocused?: boolean;
  onInputFocusChange?: (focused: boolean) => void;
  placeholder: string;
  isTextareaExpanded: boolean;
  sendByCtrlEnter?: boolean;
};

/**
 * Rendered by chat's ChatInterface as the whole input area: textarea, pending
 * attachments, queued message, permission banner, voice input and the
 * model/permission popovers that drive the next turn.
 */
export default function ChatComposer({
  pendingPermissionRequests,
  handlePermissionDecision,
  handleGrantToolPermission,
  activity,
  isLoading,
  onAbortSession,
  permissionMode,
  availablePermissionModes,
  onSelectPermissionMode,
  providerLabel,
  effort,
  availableEffortOptions,
  onSelectEffort,
  model,
  availableModelOptions,
  onSelectModel,
  modelsLoading,
  tokenBudget,
  onShowTokenUsage,
  slashCommandsCount,
  onToggleCommandMenu,
  hasInput,
  onClearInput,
  onSubmit,
  isDragActive,
  queuedDraft,
  isEditingSentMessage,
  onCancelEditMessage,
  scheduledMessages,
  onScheduleMessage,
  onCancelScheduledMessage,
  onEditQueuedDraft,
  onDeleteQueuedDraft,
  attachedFiles,
  onRemoveAttachment,
  fileErrors,
  showFileDropdown,
  filteredFiles,
  selectedFileIndex,
  onSelectFile,
  filteredCommands,
  selectedCommandIndex,
  onCommandSelect,
  onCloseCommandMenu,
  isCommandMenuOpen,
  frequentCommands,
  getRootProps,
  getInputProps,
  openAttachmentPicker,
  inputHighlightRef,
  renderInputWithMentions,
  textareaRef,
  input,
  onVoiceTranscript,
  scope,
  projectId,
  isActive,
  onInputChange,
  onTextareaClick,
  onTextareaKeyDown,
  onTextareaPaste,
  onTextareaScrollSync,
  onTextareaInput,
  isInputFocused = false,
  onInputFocusChange,
  placeholder,
  isTextareaExpanded,
  sendByCtrlEnter,
}: ChatComposerProps) {
  const { t } = useTranslation('chat');
  // Same resolution the keydown uses, so the hint below cannot describe a key that does
  // something else on this device.
  const { sendOnEnter, touchOnly } = useSendOnEnter(sendByCtrlEnter);
  // The window rule, read through the same hook the rest of the app uses for `md`. It stays the
  // whole answer below the breakpoint and for the status tab below; the footer's arrangement also
  // reads the box's own width, which is `isCompactTier` underneath.
  const { isMobile } = useDeviceSettings();
  // Drives the footer's layout branch below, and the replay row with it. Narrower than the desktop
  // arrangement needs is what it means, and the box can be that narrow inside a window that is not:
  // `md` (768px) is a rule of its own — the `sm` (640px) boundary this group used to switch on gave
  // the 640–767px band a third arrangement — but it is not the only signal, because the sidebar
  // takes 288px and more out of the box while the window stays wide. See the hook for the width.
  const { containerRef, isCompactTier } = useComposerCompactTier();
  // The dropzone's own root ref comes back out of its root props and is re-attached beside the
  // tier hook's: the props are spread onto the form, so a `ref=` written next to the spread is
  // silently replaced by the one inside it — which is how this hook's box went unmeasured. Both
  // refs want the same element, and both are load-bearing (the dropzone's reaches its
  // document-level containment checks), so the node is handed to them from one callback.
  const { ref: dropzoneFormRef, ...dropzoneFormProps } = getRootProps();
  const attachForm = useCallback((node: HTMLFormElement | null) => {
    containerRef.current = node;
    assignRef(dropzoneFormRef, node);
  }, [containerRef, dropzoneFormRef]);
  const fileDropdownRef = useRef<HTMLDivElement | null>(null);
  const selectedFileRef = useRef<HTMLDivElement | null>(null);
  const commandMenuPosition = useMemo(() => {
    if (!isCommandMenuOpen) {
      return { top: 0, left: 16, bottom: 90 };
    }
    const textareaRect = textareaRef.current?.getBoundingClientRect();
    return {
      top: textareaRect ? Math.max(16, textareaRect.top - 316) : 0,
      left: textareaRect ? textareaRect.left : 16,
      bottom: textareaRect ? window.innerHeight - textareaRect.top + 8 : 90,
    };
  }, [isCommandMenuOpen, textareaRef]);

  useEffect(() => {
    const dropdown = fileDropdownRef.current;
    const selectedFile = selectedFileRef.current;
    if (!showFileDropdown || !dropdown || !selectedFile) {
      return;
    }

    const itemTop = selectedFile.offsetTop;
    const itemBottom = itemTop + selectedFile.offsetHeight;
    const visibleTop = dropdown.scrollTop;
    const visibleBottom = visibleTop + dropdown.clientHeight;

    if (itemTop < visibleTop) {
      dropdown.scrollTop = itemTop;
    } else if (itemBottom > visibleBottom) {
      dropdown.scrollTop = itemBottom - dropdown.clientHeight;
    }
  }, [selectedFileIndex, showFileDropdown]);

  // Detect if the AskUserQuestion interactive panel is active
  const hasQuestionPanel = pendingPermissionRequests.some(
    (r) => r.toolName === 'AskUserQuestion'
  );

  // Voice state is hosted here (not in the mic button) so the main Send button can stop
  // recording and send the transcript in one tap, the way the mic button drops it in the box.
  const voiceAvailable = useVoiceAvailable();
  // The last voice failure, held as the REPORT the chain produced rather than as a sentence: which
  // sentence a refusal gets is the user's language's answer, and this component does not know the
  // language any better than the button that renders it — both read the same translator.
  //
  // It stays until the user dismisses it or starts the next recording. The four-second timer that used
  // to clear it was the defect this surface was filed for: a notice that disappears on its own takes
  // the one thing the user needs — the sentence, and the codes behind it — away while they are still
  // reading it.
  const [voiceFailure, setVoiceFailure] = useState<VoiceFailureReport | null>(null);
  const handleVoiceError = useCallback((failure: VoiceFailureReport) => {
    setVoiceFailure(failure);
  }, []);
  const dismissVoiceFailure = useCallback(() => setVoiceFailure(null), []);
  const noopTranscript = useCallback(() => {}, []);
  // The names the transcript is repaired against. Fetched once per project (the module
  // memoises the request) and held as state so the repair sees the list on the next
  // dictation rather than on the next render. A project whose tree cannot be listed
  // resolves to `[]`, which the hook treats as "repair nothing".
  const [identifierCandidates, setIdentifierCandidates] = useState<readonly string[]>([]);
  useEffect(() => {
    let current = true;
    void loadProjectIdentifiers(projectId).then((names) => {
      if (current) setIdentifierCandidates(names);
    });
    return () => {
      current = false;
    };
  }, [projectId]);
  // The question panel replaces the whole footer, so a clip playing behind it would have
  // no visible control to stop it; folding it into `isActive` reuses the same stop path
  // rather than adding a second effect for the same rule.
  const {
    state: voiceState,
    toggle: voiceToggle,
    stop: voiceStop,
    transcribeFile,
    clipSlot,
    clipPlayState,
    toggleClipPlayback,
  } = useVoiceInput(
    onVoiceTranscript ?? noopTranscript,
    handleVoiceError,
    { scope, isActive: isActive && !hasQuestionPanel, candidates: identifierCandidates },
  );
  const isRecording = voiceState === 'recording';
  const isTranscribing = voiceState === 'transcribing';
  // Starting the next recording is the user answering the last failure, so it dismisses the notice.
  // Wrapped here rather than inside the button because the failing attempt's message is the
  // composer's state: the button renders what it is handed and owns no memory of the last failure.
  const handleVoiceToggle = useCallback(() => {
    setVoiceFailure(null);
    voiceToggle();
  }, [voiceToggle]);

  // Hide the thinking/status bar while any permission request is pending
  const hasPendingPermissions = pendingPermissionRequests.length > 0;
  const hasActivityIndicator = Boolean(activity && !hasPendingPermissions);

  const hasQueuedDraft = Boolean(queuedDraft);
  const canQueueDraft = isLoading && Boolean(input.trim() || attachedFiles.length > 0);
  // Every sentence this hint can print names a keyboard key — Enter, Shift+Enter, Ctrl+Enter — and a
  // soft keyboard has none of them, so there is no wording that would be true on a touch-only device.
  // Such a device is given no hint at all rather than the wrong one: the button is the only way out
  // (the queued state included, where the button has become the queue arrow), and tapping it is the
  // universal convention, so the sentence would be describing what the user already assumes.
  const submitHint = canQueueDraft
    ? hasQueuedDraft
      ? t('input.hintText.updateQueued', { defaultValue: 'Enter to update queued message' })
      : t('input.hintText.queue', { defaultValue: 'Enter to queue your next message' })
    : sendOnEnter
      ? t('input.hintText.enter')
      : t('input.hintText.ctrlEnter');
  const submitAriaLabel = canQueueDraft
    ? hasQueuedDraft
      ? t('input.queue.update', { defaultValue: 'Update queued message' })
      : t('input.queue.sendNext', { defaultValue: 'Queue next message' })
    : isLoading
      ? t('input.stop')
      : t('input.send');

  return (
    <div className="chat-composer-shell relative flex-shrink-0 px-2 pb-2 pt-0 sm:px-4 sm:pb-4 md:px-4 md:pb-6">
      {/*
        The tab is the `md`-and-up surface: it hangs over the top edge of the input
        and, being out of flow, over the last of the transcript. Below `md` it is
        not rendered at all — the pane draws the same status in the message flow
        instead (see ChatMessagesPane), and the composer's submit button is the
        only stop entry, so the single-entry rule holds without a second control
        to hide.
      */}
      {!hasPendingPermissions && !isMobile && (
        <div className="pointer-events-none absolute bottom-full left-1/2 z-10 w-[calc(100%-1rem)] max-w-[54.25rem] -translate-x-1/2 translate-y-px bg-transparent sm:w-[calc(100%-2rem)]">
          <ActivityIndicator activity={activity} onAbort={onAbortSession} isInputFocused={isInputFocused} />
        </div>
      )}

      {/*
        The failure notice, drawn from the shell rather than from inside the mic button that raised it.

        The mic lives in the form's footer, and the form is `relative overflow-hidden` so the textarea's
        highlight layer can be clipped to its rounded corners — a notice anchored to the button and drawn
        above it therefore leaves the form's box and is clipped, which puts its close control out of a
        pointer's reach. This layer is a sibling of the form for the same reason the activity indicator
        above is one, and `VoiceFailureNotice` carries the reading that made the placement necessary.
      */}
      {voiceFailure !== null && (
        <VoiceFailureNotice failure={voiceFailure} onDismiss={dismissVoiceFailure} />
      )}

      {pendingPermissionRequests.length > 0 && (
        <div className="mx-auto mb-3 max-w-[54.25rem]">
          <PermissionRequestsBanner
            pendingPermissionRequests={pendingPermissionRequests}
            handlePermissionDecision={handlePermissionDecision}
            handleGrantToolPermission={handleGrantToolPermission}
          />
        </div>
      )}

      <ScheduledMessageList
        scheduledMessages={scheduledMessages}
        onCancel={onCancelScheduledMessage}
      />

      {isEditingSentMessage && (
        <div className="mx-auto mb-2 flex max-w-[54.25rem] items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-foreground">
          <PencilIcon className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
          <span className="min-w-0 flex-1">
            {t('composer.editing.title')}
            {' — '}
            <span className="text-muted-foreground">{t('composer.editing.filesNotReverted')}</span>
          </span>
          <button
            type="button"
            onClick={onCancelEditMessage}
            className="shrink-0 rounded-md px-2 py-1 font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {t('composer.editing.cancel')}
          </button>
        </div>
      )}

      {queuedDraft && (
        <QueuedMessageCard
          content={queuedDraft.content}
          attachmentCount={
            queuedDraft.uploadedAttachments?.length ?? queuedDraft.attachments.length
          }
          onEdit={onEditQueuedDraft}
          onDelete={onDeleteQueuedDraft}
        />
      )}

      {!hasQuestionPanel && <div className="relative mx-auto max-w-[54.25rem]">
        {showFileDropdown && filteredFiles.length > 0 && (
          <div
            ref={fileDropdownRef}
            className="absolute bottom-full left-0 right-0 z-50 mb-2 max-h-48 overflow-y-auto rounded-xl border border-border/50 bg-card/95 shadow-lg backdrop-blur-md"
          >
            {filteredFiles.map((file, index) => (
              <div
                key={file.path}
                ref={index === selectedFileIndex ? selectedFileRef : undefined}
                className={`cursor-pointer touch-manipulation border-b border-border/30 px-4 py-3 last:border-b-0 ${
                  index === selectedFileIndex
                    ? 'bg-primary/8 text-primary'
                    : 'text-foreground hover:bg-accent/50'
                }`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onSelectFile(file);
                }}
              >
                <div className="text-sm font-medium">{file.name}</div>
                <div className="font-mono text-xs text-muted-foreground">{file.path}</div>
              </div>
            ))}
          </div>
        )}

        <CommandMenu
          commands={filteredCommands}
          selectedIndex={selectedCommandIndex}
          onSelect={onCommandSelect}
          onClose={onCloseCommandMenu}
          position={commandMenuPosition}
          isOpen={isCommandMenuOpen}
          frequentCommands={frequentCommands}
        />

        <PromptInput
          onSubmit={onSubmit as (event: FormEvent<HTMLFormElement>) => void}
          status={isLoading ? 'streaming' : 'ready'}
          className={[
            isTextareaExpanded ? 'chat-input-expanded' : '',
            // Only the tab squares the input's top corners off; below `md` there
            // is no tab sitting there, so the box keeps its own rounding.
            hasActivityIndicator && !isMobile ? 'rounded-t-none' : '',
          ].filter(Boolean).join(' ')}
          {...dropzoneFormProps}
          ref={attachForm}
        >
          {isDragActive && (
            <div className="absolute inset-0 z-50 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary/50 bg-primary/15">
              <div className="rounded-xl border border-border/30 bg-card p-4 shadow-lg">
                <svg className="mx-auto mb-2 h-8 w-8 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
                  />
                </svg>
                <p className="text-sm font-medium">Drop files here</p>
              </div>
            </div>
          )}

          {attachedFiles.length > 0 && (
            <PromptInputHeader>
              <div className="rounded-xl bg-muted/40 p-2">
                <div className="flex flex-wrap gap-2">
                  {attachedFiles.map((file, index) => (
                    <ComposerAttachment
                      key={`${file.name}-${file.lastModified}-${index}`}
                      file={file}
                      onRemove={() => onRemoveAttachment(index)}
                      error={fileErrors.get(file.name)}
                    />
                  ))}
                </div>
              </div>
            </PromptInputHeader>
          )}

          <input {...getInputProps()} />

          <PromptInputBody>
            <div ref={inputHighlightRef} aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden rounded-xl">
              <div className="chat-input-placeholder block w-full whitespace-pre-wrap break-words px-4 py-2 text-sm leading-6 text-transparent">
                {renderInputWithMentions(input)}
              </div>
            </div>

            <PromptInputTextarea
              ref={textareaRef}
              dir="auto"
              value={input}
              onChange={onInputChange}
              onClick={onTextareaClick}
              onKeyDown={onTextareaKeyDown}
              onPaste={onTextareaPaste}
              onScroll={(event) => onTextareaScrollSync(event.target as HTMLTextAreaElement)}
              onFocus={() => onInputFocusChange?.(true)}
              onBlur={() => onInputFocusChange?.(false)}
              onInput={onTextareaInput}
              placeholder={placeholder}
            />
        </PromptInputBody>

        {/*
          On the compact tier the replay pair gets a row of its own between the box and the footer.

          It has nowhere to live inside the compact footer — that row is exactly the six controls that
          send a message and may not wrap — so without this the arrival of a recording is what pushed
          the footer into a second line. The row exists only while `clipSlot` holds something (a clip
          only exists because the mic produced one), and it is the row that grows and shrinks: the
          footer's own height and position are the same with a recording as without one. It may wrap
          *between* its two tracks, which is the move the footer is forbidden, not this row.

          One renderer, not two: the pair is drawn here on the compact tier and in the tools group on
          the wide one, off the same `clipSlot`/`clipPlayState` the hook owns, so exactly one set of
          replay controls is ever on screen — and therefore exactly one set in the accessibility tree.
        */}
        {clipSlot && isCompactTier && (
          <div
            data-slot="prompt-input-clip-row"
            className="flex flex-wrap items-center gap-1 px-3 py-0.5"
          >
            <VoiceClipButton clips={clipSlot} state={clipPlayState} onToggle={toggleClipPlayback} />
          </div>
        )}

        {/*
          On the compact tier the row must never wrap: the six controls that
          send a message stay reachable without hunting, so both groups are
          `shrink-0` and the box is `flex-nowrap`. On the wide tier the previous
          wrapping row is kept exactly as it was.

          On the wide tier the *left group* may take a second line of its own, which is
          what `flex-wrap` here buys. The box's own `flex-wrap` only decides where the
          two groups go; it cannot break a group, and a group whose children may not
          shrink (the replay pair declares `shrink-0`, and an icon button cannot go
          below its own icon) then pushes the box's content past its edge instead of
          moving down. Measured with the window at 768 and the sidebar open — the box
          445px wide — one recording's pair in this group read
          `scrollWidth 470 / clientWidth 445`: 25px of content the box would have
          scrolled sideways, invisible without a horizontal scroll gesture. That box is
          narrower than `COMPACT_TIER_WIDTH_PX`, so the compact tier now takes it and
          the wrap never arises; and because the same measurement decides the boxed-in
          wide window (a 1024px window with the sidebar open leaves a 701px box, at
          which the pair wrapped too), the arrangement follows the box rather than the
          window. Wrapping the group is still the move the wide tier makes if a box
          between the threshold and the crossing ever reaches it, and it leaves every
          reading that has no pair to fit on one line: a recording only ever arrives
          because the mic produced one, and the two groups' placement, the 93px height
          and the 1280 footer are unchanged without it.
        */}
        <PromptInputFooter className={isCompactTier ? 'flex-nowrap' : 'flex-wrap gap-y-1'}>
          <PromptInputTools className={isCompactTier ? 'shrink-0' : 'min-w-0 flex-wrap'}>
            <PromptInputButton
              tooltip={{ content: t('input.attachFiles') }}
              onClick={openAttachmentPicker}
              aria-label={t('input.attachFiles')}
            >
              <PaperclipIcon />
            </PromptInputButton>

            {onVoiceTranscript && voiceAvailable && (
              <VoiceInputButton
                state={voiceState}
                onToggle={handleVoiceToggle}
              />
            )}

            {/*
              The voice path's other entry, and only while the debug switch asks for it: an install
              that never sets `?voiceDebug=1` renders the same composer it always has. Beside the mic
              because it is the same chain — the file goes where the recording goes.
            */}
            {onVoiceTranscript && voiceAvailable && isVoiceDebugEnabled() && (
              <VoiceUploadButton state={voiceState} onSelectFile={transcribeFile} />
            )}

            {/*
              Right of the mic: a clip only exists because the mic produced it. On the wide tier it
              stays here, where it has always been. On the compact tier this row is exactly the six
              controls that send a message and may not wrap, so the pair goes to a row of its own
              instead — see the clip row between the box and the footer.
            */}
            {clipSlot && !isCompactTier && (
              <VoiceClipButton clips={clipSlot} state={clipPlayState} onToggle={toggleClipPlayback} />
            )}

            {isCompactTier ? (
              // The three controls below move behind one entry on the compact tier;
              // that entry is the only addition to this row, so the row stays six wide.
              <ComposerMobileMoreMenu
                tokenBudget={tokenBudget}
                onShowTokenUsage={onShowTokenUsage}
                slashCommandsCount={slashCommandsCount}
                onToggleCommandMenu={onToggleCommandMenu}
                canSchedule={Boolean(input.trim())}
                onScheduleMessage={onScheduleMessage}
              />
            ) : (
              <>
                <TokenUsageSummary usage={tokenBudget} onClick={onShowTokenUsage} />

                <PromptInputButton
                  tooltip={{ content: t('input.showAllCommands') }}
                  onClick={onToggleCommandMenu}
                  className="relative"
                  aria-label={t('input.showAllCommands')}
                >
                  <MessageSquareIcon />
                  {slashCommandsCount > 0 && (
                    <span
                      className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground"
                    >
                      {slashCommandsCount}
                    </span>
                  )}
                </PromptInputButton>

                {/*
                  Wide tier only. The compact row is exactly the six primary controls,
                  so a seventh that appears with text would either wrap it or push
                  send off the edge — the one thing that row may not do.
                */}
                {hasInput && (
                  <PromptInputButton
                    tooltip={{ content: t('input.clearInput', { defaultValue: 'Clear input' }) }}
                    onClick={onClearInput}
                    className="hidden sm:flex"
                    aria-label={t('input.clearInput', { defaultValue: 'Clear input' })}
                  >
                    <XIcon />
                  </PromptInputButton>
                )}
              </>
            )}

          </PromptInputTools>

          <div className="ml-auto flex shrink-0 items-center gap-1.5 md:gap-2">
            {/*
              The schedule entry's desktop placement: on the compact tier it lives in the "more"
              menu instead, which is why it is not part of the six the compact row keeps.
            */}
            {!isCompactTier && (
              <ScheduleMessagePopover
                disabled={!input.trim()}
                onSchedule={onScheduleMessage}
              />
            )}

            <ComposerModelMenu
              effort={effort}
              effortOptions={availableEffortOptions}
              onSelectEffort={onSelectEffort}
              model={model}
              modelOptions={availableModelOptions}
              onSelectModel={onSelectModel}
              modelsLoading={modelsLoading}
            />

            <ComposerPermissionMenu
              permissionMode={permissionMode}
              permissionModes={availablePermissionModes}
              onSelectPermissionMode={onSelectPermissionMode}
              providerLabel={providerLabel}
            />

            <PromptInputSubmit
              onClick={
                canQueueDraft
                  ? (e: MouseEvent<HTMLButtonElement>) => {
                      e.preventDefault();
                      onSubmit(e);
                    }
                  : isLoading
                    ? onAbortSession
                    : isRecording
                      ? (e: MouseEvent<HTMLButtonElement>) => {
                          e.preventDefault();
                          voiceStop({ send: true });
                        }
                      : undefined
              }
              disabled={
                isLoading
                  ? false
                  : isRecording
                    ? false
                    : isTranscribing
                      ? true
                      : !input.trim() && attachedFiles.length === 0
              }
              aria-label={submitAriaLabel}
              title={submitAriaLabel}
              className="h-10 w-10 sm:h-10 sm:w-10"
            >
              {isTranscribing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : canQueueDraft ? (
                <ArrowUpIcon className="h-4 w-4" />
              ) : undefined}
            </PromptInputSubmit>
          </div>

          {/*
            `basis-full` puts this line on a row of its own, so it costs the composer a whole
            `leading-4` line plus the footer's `gap-y-1` — 20px on the one class of device with the
            least vertical room to spare. A touch-only device therefore hides it at EVERY width:
            `hidden lg:block` alone would hand a ≥1024px tablet (landscape iPad, Surface) the
            keyboard wording, whose Shift a soft keyboard does not have. A keyboard device keeps the
            narrower behaviour it always had — hidden below lg, visible from lg up.
          */}
          <div
            className={`order-last basis-full px-2 text-center text-xs leading-4 text-muted-foreground/50 transition-opacity duration-200 ${touchOnly ? 'hidden' : 'hidden lg:block'} ${
              input.trim() && !canQueueDraft ? 'opacity-0' : 'opacity-100'
            }`}
          >
            {submitHint}
          </div>
        </PromptInputFooter>
      </PromptInput>
      </div>}
    </div>
  );
}
