import { useTranslation } from 'react-i18next';

/**
 * The disclosure a user must read before a session is allowed to become
 * resident, and the checkbox that records that they read it.
 *
 * Rendered by chat's `ChatComposer` under the resident toggle. The sidebar's
 * conversion item draws the same block from the same `chat` i18n keys rather
 * than importing this component: a feature module may not deep-import another
 * module's components, and the two entry points have to say the same thing.
 *
 * Controlled rather than stateful — whether the box is ticked is what decides
 * whether the caller's send or convert action is allowed, so the caller owns it.
 */
type ResidentConsentNoticeProps = {
  /** True once the user has ticked "I understand". */
  acknowledged: boolean;
  onAcknowledgedChange: (acknowledged: boolean) => void;
};

export default function ResidentConsentNotice({
  acknowledged,
  onAcknowledgedChange,
}: ResidentConsentNoticeProps) {
  const { t } = useTranslation('chat');

  return (
    <div
      data-slot="resident-consent-notice"
      role="group"
      aria-label={t('resident.notice.title')}
      className="rounded-xl border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs leading-5"
    >
      <p className="font-medium text-foreground">{t('resident.notice.title')}</p>
      <p className="mt-1 text-muted-foreground">{t('resident.notice.bypass')}</p>
      <p className="mt-1 text-muted-foreground">{t('resident.notice.trustBoundary')}</p>
      <label className="mt-2 flex items-center gap-2 text-foreground">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(event) => onAcknowledgedChange(event.target.checked)}
          aria-label={t('resident.notice.acknowledge')}
          className="h-4 w-4 accent-primary"
        />
        <span>{t('resident.notice.acknowledge')}</span>
      </label>
    </div>
  );
}

/**
 * The resident intent of the next send, held at module scope.
 *
 * The control that produces the intent lives in `ChatComposer`; the send that has
 * to act on it — a lifecycle-mode write between the session row being allocated
 * and the first `chat.send` — lives in `useChatComposerState`. The two meet in
 * `ChatInterface`, which is outside this task's file set, so the hand-off is a
 * module-level one-shot: the composer records the intent on submit and the send
 * path consumes it, clearing it as it reads. An intent no send ever consumes
 * (a draft queued behind a running turn) is dropped by the next send rather than
 * applied to a later, unrelated one.
 */
let pendingResidentIntent = false;

export function setPendingResidentIntent(enabled: boolean): void {
  pendingResidentIntent = enabled;
}

export function consumePendingResidentIntent(): boolean {
  const intent = pendingResidentIntent;
  pendingResidentIntent = false;
  return intent;
}
