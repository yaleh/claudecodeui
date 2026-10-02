import { useTranslation } from 'react-i18next';
import { memo, useCallback, useMemo, useState } from 'react';
import type { Dispatch, Ref, RefObject, SetStateAction } from 'react';

import type { ChatMessage,
  Project,
  ProjectSession,
  LLMProvider,
  ProviderModelActions,
  ProviderModelsDefinition,
  SessionActivity } from '@/shared/types';
import { RESIDENT_PENDING_MESSAGE_TYPE } from '@/modules/chat/hooks/useChatMessages';
import { getIntrinsicMessageKey } from '@/modules/chat/utils/messageKeys';
import { groupWorkSegments, isWorkSegment } from '@/modules/chat/utils/workSegments';
import { useLazyRowObserver } from '@/modules/chat/hooks/useLazyRowObserver';
import { useDeviceSettings } from '@/shared/hooks/useDeviceSettings';
import LazyMessageRow from '@/modules/chat/transcript/LazyMessageRow';
import MessageComponent from '@/modules/chat/transcript/MessageComponent';
import PendingResidentMessage from '@/modules/chat/transcript/PendingResidentMessage';
import ProviderSelectionEmptyState from '@/modules/chat/transcript/ProviderSelectionEmptyState';
import WorkSegmentRecord from '@/modules/chat/transcript/WorkSegmentRecord';
import LoadAllMessagesOverlay from '@/modules/chat/transcript/LoadAllMessagesOverlay';
import ChatExportMenu from '@/modules/chat/transcript/ChatExportMenu';
import ResidentStatusBar from '@/modules/chat/transcript/ResidentStatusBar';
import ActivityIndicator from '@/modules/chat/composer/ActivityIndicator';

/**
 * How many of the newest rows mount with real content on the first commit,
 * before the lazy-row observer has had a chance to report what is actually
 * near the viewport. Covers a bit more than one screen of typical rows.
 */
const INITIAL_MOUNTED_TAIL_ROWS = 30;

/**
 * The default for `onToggleResident`, for a render that supplies no toggler.
 *
 * Stable rather than inline, so a render that omits the prop does not hand the switch a new
 * function on every commit. The empty state's switch draws either way — this only makes it inert.
 */
const noopResidentToggle = () => {};

type ChatMessagesPaneProps = {
  scrollContainerRef: RefObject<HTMLDivElement>;
  /**
   * Attaches the content column — the box that grows when the last row gets
   * taller without a new row arriving — to chat's content-growth follow.
   */
  scrollContentRef: Ref<HTMLDivElement>;
  onWheel: () => void;
  onTouchMove: () => void;
  isLoadingSessionMessages: boolean;
  /** True while the viewed session has an active provider run in flight. */
  isProcessing?: boolean;
  /** True while ChatComposer's floating activity/stop tab is rendered above the input. */
  hasActivityIndicator?: boolean;
  /**
   * The running turn's activity, drawn below `md` as an in-flow status line at
   * the end of the message list. Passed rather than re-derived: the pane already
   * receives `hasActivityIndicator` for its bottom padding, and this is the same
   * turn's data, not a second account of it.
   */
  activity?: SessionActivity | null;
  chatMessages: ChatMessage[];
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  provider: LLMProvider;
  setProvider: (provider: LLMProvider) => void;
  textareaRef: RefObject<HTMLTextAreaElement>;
  providerModels: Record<LLMProvider, string>;
  setProviderModel: (provider: LLMProvider, model: string) => void;
  providerModelCatalog: Partial<Record<LLMProvider, ProviderModelsDefinition>>;
  providerModelActions: ProviderModelActions;
  providerModelsLoading: boolean;
  tasksEnabled: boolean;
  isTaskMasterInstalled: boolean | null;
  onShowAllTasks?: (() => void) | null;
  setInput: Dispatch<SetStateAction<string>>;
  /**
   * Whether the selected provider can hold a resident session; the empty state's switch is drawn
   * only when it can.
   *
   * Optional, and absent means "cannot": a caller that does not know the capability matrix cannot
   * claim it, and offering a switch for a provider that may refuse the mode would promise an action
   * the server would not keep. The app's own caller always knows — it reads the same matrix — so this
   * default exists for a standalone render, the way `sessionId`'s does on the composer.
   */
  canRunResident?: boolean;
  /** Whether the next send is meant to be resident, lifted to ChatInterface so both switch homes share one value. */
  residentEnabled?: boolean;
  /** Flips `residentEnabled`; the composer's own switch is the other caller. */
  onToggleResident?: () => void;
  isLoadingMoreMessages: boolean;
  hasMoreMessages: boolean;
  totalMessages: number;
  sessionMessagesCount: number;
  visibleMessageCount: number;
  visibleMessages: ChatMessage[];
  loadEarlierMessages: () => void;
  loadAllMessages: () => void;
  allMessagesLoaded: boolean;
  isLoadingAllMessages: boolean;
  loadAllJustFinished: boolean;
  showLoadAllOverlay: boolean;
  createDiff: any;
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onShowSettings?: () => void;
  onGrantToolPermission: (suggestion: { entry: string; toolName: string }) => { success: boolean };
  showRawParameters?: boolean;
  showThinking?: boolean;
  selectedProject: Project;
  /**
   * Asks the resident process holding this message to take it back. Absent
   * hides the affordance rather than drawing one that would do nothing.
   */
  onWithdrawResidentCommand?: (message: ChatMessage) => void;
  /** Loads an already-sent message back into the composer; absent when the provider cannot re-run from a point. */
  onEditMessage?: (message: ChatMessage) => void;
  /** Branches the conversation into a new session ending at a message. */
  onForkFromMessage?: (message: ChatMessage) => void;
  /** Fetches the whole transcript for an export, which otherwise only sees the loaded page. */
  onLoadFullTranscript?: () => Promise<ChatMessage[]>;
};

/**
 * Rendered by chat's ChatInterface as the scrolling transcript: the message
 * list and tool groups, the export menu, the provider empty state and the
 * load-all-history overlay.
 */
function ChatMessagesPane({
  scrollContainerRef,
  scrollContentRef,
  onWheel,
  onTouchMove,
  isLoadingSessionMessages,
  isProcessing = false,
  hasActivityIndicator = false,
  activity = null,
  chatMessages,
  selectedSession,
  currentSessionId,
  provider,
  setProvider,
  textareaRef,
  providerModels,
  setProviderModel,
  providerModelCatalog,
  providerModelActions,
  providerModelsLoading,
  tasksEnabled,
  isTaskMasterInstalled,
  onShowAllTasks,
  setInput,
  canRunResident = false,
  residentEnabled = false,
  onToggleResident = noopResidentToggle,
  isLoadingMoreMessages,
  hasMoreMessages,
  totalMessages,
  sessionMessagesCount,
  visibleMessageCount,
  visibleMessages,
  loadEarlierMessages,
  loadAllMessages,
  allMessagesLoaded,
  isLoadingAllMessages,
  loadAllJustFinished,
  showLoadAllOverlay,
  createDiff,
  onWithdrawResidentCommand,
  onEditMessage,
  onForkFromMessage,
  onLoadFullTranscript,
  onFileOpen,
  onShowSettings,
  onGrantToolPermission,
  showRawParameters,
  showThinking,
  selectedProject,
}: ChatMessagesPaneProps) {
  const { t } = useTranslation('chat');
  // The same `md` (768px) signal ChatComposer reads for the tab it draws, so the
  // pane's status line and the composer's tab can never both be on screen or
  // both be absent: one breakpoint decides which surface carries the turn.
  const { isMobile } = useDeviceSettings();
  const lazyRows = useLazyRowObserver(scrollContainerRef);
  const groupedVisibleMessages = useMemo(
    () => groupWorkSegments(visibleMessages),
    [visibleMessages],
  );

  // Which work segments are open, keyed by the segment's anchor key. Held here —
  // in the pane's own React state — and not inside `WorkSegmentRecord`, whose
  // instances unmount whenever their `LazyMessageRow` scrolls out of the viewport:
  // an open segment has to stay open when its row leaves and comes back, while a
  // fresh pane mount has to start from nothing. State in either wrong place fails
  // one of those two readings (module scope survives the remount; the record's own
  // state dies with the row), which is why the empty set lives at exactly this
  // level and nowhere shorter- or longer-lived.
  const [expandedSegmentKeys, setExpandedSegmentKeys] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );

  const toggleSegment = useCallback((segmentKey: string, next: boolean) => {
    setExpandedSegmentKeys((current) => {
      const updated = new Set(current);
      if (next) {
        updated.add(segmentKey);
      } else {
        updated.delete(segmentKey);
      }
      return updated;
    });
  }, []);

  // Stable, deterministic keys for the messages rendered this pass.
  //
  // A server refresh can replace source records with equivalent new objects, so
  // object identity is not a durable React key across pagination or hydration.
  // Deriving keys from this render's ordered messages (intrinsic key,
  // disambiguated by occurrence index on collision) preserves existing DOM
  // nodes and component state when older history is prepended.
  const messageKeyMap = useMemo(() => {
    const keys = new WeakMap<ChatMessage, string>();
    const occurrences = new Map<string, number>();
    const assign = (message: ChatMessage) => {
      const intrinsicKey = getIntrinsicMessageKey(message) ?? 'message-generated';
      const seen = occurrences.get(intrinsicKey) ?? 0;
      occurrences.set(intrinsicKey, seen + 1);
      keys.set(message, seen === 0 ? intrinsicKey : `${intrinsicKey}__${seen}`);
    };
    for (const item of groupedVisibleMessages) {
      if (isWorkSegment(item)) {
        item.messages.forEach(assign);
      } else {
        assign(item);
      }
    }
    return keys;
  }, [groupedVisibleMessages]);

  const getMessageKey = useCallback(
    (message: ChatMessage) =>
      messageKeyMap.get(message) ?? getIntrinsicMessageKey(message) ?? 'message-generated',
    [messageKeyMap],
  );

  // The transcript row that precedes each message, repaired for the segment path.
  //
  // `MessageComponent` reads it only to decide whether a row is visually grouped
  // with the one above it. Rows a segment absorbed must keep the same predecessor
  // they had as free rows — the member before them, or the row before the segment
  // for its first member — so a member's own shape is the same inside a segment as
  // out of one.
  const prevMessageFor = useMemo(() => {
    const predecessors = new WeakMap<ChatMessage, ChatMessage | null>();
    let previous: ChatMessage | null = null;
    for (const item of groupedVisibleMessages) {
      if (isWorkSegment(item)) {
        for (const member of item.messages) {
          predecessors.set(member, previous);
          previous = member;
        }
      } else {
        predecessors.set(item, previous);
        previous = item;
      }
    }
    return predecessors;
  }, [groupedVisibleMessages]);

  // Below `md` the running turn is drawn in the message flow, so nothing has to
  // be kept clear for a floating tab and the pane keeps its ordinary bottom
  // space. From `md` up the tab still hangs over the last message, so the space
  // it was always given is still reserved — same value as before this change.
  const paneBottomPadding = hasActivityIndicator && !isMobile ? 'pb-12 md:pb-14' : 'pb-3 sm:pb-4';

  return (
    // The resident process's status sits on a row of its own, *above* the scroll
    // container rather than inside it. Inside was the wrong side of the box
    // boundary: `.chat-messages-pane` is `overflow-y-auto`, so anything in it is
    // clipped to the pane and scrolls with the transcript, and a bar that wrapped
    // onto a second line pushed the first turn down by its own height while its
    // sticky box could still come to rest over the row starting underneath it.
    // Outside the scroll box the two cannot overlap at all: the row takes its
    // height from the bar and the transcript begins below wherever that ends.
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Drawn for every session, and removed by `empty:hidden` on every session
          whose bar renders itself away (anything not stored `resident`), so a
          non-resident transcript reserves no row of its own — the same bargain
          the wrapper made when it lived inside the pane. */}
      <div className="pointer-events-none flex justify-start pt-3 empty:hidden sm:px-4 sm:pt-4">
        <ResidentStatusBar
          sessionId={currentSessionId ?? selectedSession?.id ?? null}
          t={t}
        />
      </div>
      <div
        ref={scrollContainerRef}
        // Focusable so the pane itself can be scrolled from the keyboard. A wheel
        // and a touch drag are delivered to whatever is under the pointer, but
        // PageUp and the arrow keys act on the element that has focus — without
        // this the browser scrolls the document instead, the pane reports no
        // `scroll` at all, and a keyboard gesture is invisible to the intent
        // machinery that keeps a transcript the user took over where they put it.
        // -1 rather than 0: the pane joins no tab order, it is only focusable.
        tabIndex={-1}
        onWheel={onWheel}
        onTouchMove={onTouchMove}
        className={`chat-messages-pane relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden pt-3 sm:pt-4 ${paneBottomPadding}`}
      >
        {chatMessages.length > 0 && (
          <div className="pointer-events-none sticky right-4 top-3 z-10 mb-2 flex justify-end sm:px-4">
            <div className="pointer-events-auto">
              <ChatExportMenu
                messages={chatMessages}
                sessionTitle={selectedSession?.summary || selectedSession?.title}
                provider={provider}
                selectedProject={selectedProject}
                createDiff={createDiff}
                onLoadFullTranscript={onLoadFullTranscript}
              />
            </div>
          </div>
        )}
        {/* Always rendered, so the follow's observer is attached for the empty and
            loading states too and never has to be re-attached mid-session. */}
        <div
          ref={scrollContentRef}
          className="mx-auto w-full max-w-[54.25rem] space-y-3 px-4 sm:space-y-4"
        >
        {(isLoadingSessionMessages || isProcessing) && chatMessages.length === 0 ? (
          <div className="mt-8 text-center text-gray-500 dark:text-gray-400">
            <div className="flex items-center justify-center space-x-2">
              <div className="h-4 w-4 animate-spin rounded-full border-b-2 border-gray-400" />
              <p>{t('session.loading.sessionMessages')}</p>
            </div>
          </div>
        ) : chatMessages.length === 0 ? (
          <ProviderSelectionEmptyState
            selectedSession={selectedSession}
            currentSessionId={currentSessionId}
            provider={provider}
            setProvider={setProvider}
            textareaRef={textareaRef}
            providerModels={providerModels}
            setProviderModel={setProviderModel}
            providerModelCatalog={providerModelCatalog}
            providerModelActions={providerModelActions}
            providerModelsLoading={providerModelsLoading}
            tasksEnabled={tasksEnabled}
            isTaskMasterInstalled={isTaskMasterInstalled}
            onShowAllTasks={onShowAllTasks}
            setInput={setInput}
            canRunResident={canRunResident}
            residentEnabled={residentEnabled}
            onToggleResident={onToggleResident}
          />
        ) : (
          <>
            {/* Loading indicator for older messages (hide when load-all is active) */}
            {isLoadingMoreMessages && !isLoadingAllMessages && !allMessagesLoaded && (
              <div className="py-3 text-center text-gray-500 dark:text-gray-400">
                <div className="flex items-center justify-center space-x-2">
                  <div className="h-4 w-4 animate-spin rounded-full border-b-2 border-gray-400" />
                  <p className="text-sm">{t('session.loading.olderMessages')}</p>
                </div>
              </div>
            )}

            {/* Indicator showing there are more messages to load (hide when all loaded) */}
            {hasMoreMessages && !isLoadingMoreMessages && !allMessagesLoaded && (
              <div className="border-b border-gray-200 py-2 text-center text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
                {totalMessages > 0 && (
                  <span>
                    {t('session.messages.showingOf', { shown: sessionMessagesCount, total: totalMessages })}{' '}
                    <span className="text-xs">{t('session.messages.scrollToLoad')}</span>
                  </span>
                )}
              </div>
            )}

            <LoadAllMessagesOverlay
              showLoadAllOverlay={showLoadAllOverlay}
              isLoadingAllMessages={isLoadingAllMessages}
              loadAllJustFinished={loadAllJustFinished}
              totalMessages={totalMessages}
              onLoadAllMessages={loadAllMessages}
            />

            {/* Legacy message count indicator (for non-paginated view) */}
            {!hasMoreMessages && chatMessages.length > visibleMessageCount && (
              <div className="border-b border-gray-200 py-2 text-center text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
                {t('session.messages.showingLast', { count: visibleMessageCount, total: chatMessages.length })} |
                <button className="ml-1 text-blue-600 underline hover:text-blue-700" onClick={loadEarlierMessages}>
                  {t('session.messages.loadEarlier')}
                </button>
                {' | '}
                <button
                  className="text-blue-600 underline hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
                  onClick={loadAllMessages}
                >
                  {t('session.messages.loadAll')}
                </button>
              </div>
            )}

            {groupedVisibleMessages.map((item, index) => {
              // Rows near the tail mount their content on first commit so the
              // initial scroll-to-bottom measures real heights; older rows
              // start as placeholders and mount when scrolled toward.
              const initiallyNearViewport = index >= groupedVisibleMessages.length - INITIAL_MOUNTED_TAIL_ROWS;

              // One run of adjacent work rows. Drawn as a single collapsible
              // record inside a LazyMessageRow, so the whole run — header and
              // members together — leaves and returns as one row. The pane wraps
              // it in an addressable `data-work-segment-key` box whose value is
              // the same anchor key as the React key, which is also the
              // timestamp the lazy row publishes as its placeholder anchor.
              if (isWorkSegment(item)) {
                const segmentKey = item.key ?? getMessageKey(item.messages[0]);
                const anchorTimestamp = item.messages[0]?.timestamp;

                return (
                  <LazyMessageRow
                    key={segmentKey}
                    lazyRows={lazyRows}
                    timestamp={anchorTimestamp}
                    initiallyNearViewport={initiallyNearViewport}
                  >
                    <div data-work-segment-key={segmentKey}>
                      <WorkSegmentRecord
                        segment={item}
                        expanded={expandedSegmentKeys.has(segmentKey)}
                        onToggle={(next) => toggleSegment(segmentKey, next)}
                        renderMember={(message) => (
                          <MessageComponent
                            message={message}
                            prevMessage={prevMessageFor.get(message) ?? null}
                            createDiff={createDiff}
                            onFileOpen={onFileOpen}
                            onShowSettings={onShowSettings}
                            onGrantToolPermission={onGrantToolPermission}
                            showRawParameters={showRawParameters}
                            showThinking={showThinking}
                            selectedProject={selectedProject}
                            provider={provider}
                            onEditMessage={onEditMessage}
                            onForkFromMessage={onForkFromMessage}
                          />
                        )}
                      />
                    </div>
                  </LazyMessageRow>
                );
              }

              // A message a resident process is holding. Its own component,
              // because it is not a turn: it has a state the host keeps
              // updating, an action no other row has, and — in two of its three
              // states — no message to draw at all.
              if (item.type === RESIDENT_PENDING_MESSAGE_TYPE) {
                return (
                  <LazyMessageRow
                    key={getMessageKey(item)}
                    lazyRows={lazyRows}
                    timestamp={item.timestamp}
                    initiallyNearViewport={initiallyNearViewport}
                  >
                    <PendingResidentMessage
                      message={item}
                      onWithdraw={onWithdrawResidentCommand}
                    />
                  </LazyMessageRow>
                );
              }

              return (
                <LazyMessageRow
                  key={getMessageKey(item)}
                  lazyRows={lazyRows}
                  timestamp={item.timestamp}
                  initiallyNearViewport={initiallyNearViewport}
                >
                  <MessageComponent
                    message={item}
                    prevMessage={prevMessageFor.get(item) ?? null}
                    createDiff={createDiff}
                    onFileOpen={onFileOpen}
                    onShowSettings={onShowSettings}
                    onGrantToolPermission={onGrantToolPermission}
                    showRawParameters={showRawParameters}
                    showThinking={showThinking}
                    selectedProject={selectedProject}
                    provider={provider}
                    onEditMessage={onEditMessage}
                    onForkFromMessage={onForkFromMessage}
                  />
                </LazyMessageRow>
              );
            })}
          </>
        )}

        {/*
          The running turn's status, in the message flow and after the last row, so
          it scrolls with the transcript and never covers a message. It is the only
          activity surface below `md` — the composer draws no tab there — and it
          carries no Stop, because the composer's submit button is already the one
          stop entry on that layout.

          Mounted for the whole time the pane is, with `activity` set to null while
          the turn is over or a permission request has taken over the status: the
          component owns the exit animation, and unmounting it here would cut that
          animation short and pop the row out instead of collapsing it.

          Inside the content column on purpose — that is the box the transcript's
          content-growth follow observes, so the row appearing and its elapsed
          reading widening are growth the follow answers for free, under the same
          "the user has not scrolled away" gate as every other growth.
        */}
        {isMobile && (
          <ActivityIndicator
            activity={hasActivityIndicator ? activity : null}
            variant="inline"
          />
        )}
        </div>
      </div>
    </div>
  );
}

export default memo(ChatMessagesPane);
