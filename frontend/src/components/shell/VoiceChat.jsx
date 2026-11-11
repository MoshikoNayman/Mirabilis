// Hands-free voice chat panel. Presentational only: ChatApp owns speech
// recognition, the send/stream loop and text-to-speech.
'use client';

import { Modal, IconButton, SegmentedControl } from '../ui/primitives';
import { FlowerMark } from '../ui/StatusOrb';

const PHASE_LABEL = {
  idle: 'Tap the orb to talk',
  listening: 'Listening...',
  thinking: 'Thinking...',
  speaking: 'Speaking...'
};

// Monochrome X to match the line-icon set.
function CloseGlyph({ size = 16 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

export default function VoiceChat({
  open,
  onClose,
  phase = 'idle',
  interimText = '',
  replyText = '',
  gender = 'female',
  onGenderChange,
  onOrbTap,
  srSupported = true,
  note = '',
  // A pending agent approval, shown here because this panel covers the composer.
  children = null
}) {
  const waiting = Boolean(children);
  const label = waiting ? 'Waiting for your approval' : (PHASE_LABEL[phase] || PHASE_LABEL.idle);
  const orbPhase = srSupported ? phase : 'idle';

  return (
    <Modal open={open} onClose={onClose} align="center" className="max-w-[560px]" labelledBy="voice-chat-title">
      <div className="au-chrome au-hairline au-elev-3 relative flex max-h-[calc(100vh-2rem)] flex-col overflow-hidden rounded-[var(--r-xl)]">
        <div
          className="flex items-center justify-between gap-2 border-b px-4 py-3"
          style={{ borderColor: 'var(--hairline)' }}
        >
          <span
            id="voice-chat-title"
            className="text-[length:var(--text-sm)] font-medium text-[color:var(--text-main)]"
          >
            Voice chat
          </span>
          <IconButton size="sm" label="End voice chat" onClick={onClose}>
            <CloseGlyph size={16} />
          </IconButton>
        </div>

        {/* Scrolls on short windows, so an approval card never pushes the controls off screen. */}
        <div className="au-scroll flex min-h-0 flex-col items-center gap-5 overflow-y-auto px-6 py-8">
          <button
            type="button"
            data-voice-orb=""
            onClick={onOrbTap}
            disabled={!srSupported}
            aria-label={srSupported ? 'Tap to talk' : 'Speech recognition unavailable'}
            title={srSupported ? label : 'Speech recognition unavailable'}
            className="au-focus relative inline-flex shrink-0 items-center justify-center rounded-full transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
            style={{ width: 180, height: 180 }}
          >
            <span
              className="absolute inset-0 rounded-full"
              aria-hidden="true"
              style={{
                boxShadow:
                  'inset 0 0 0 1px var(--hairline), 0 0 0 6px color-mix(in srgb, var(--accent) 12%, transparent), var(--shadow-2)'
              }}
            />
            <span className="vc-orb inline-flex items-center justify-center" data-phase={orbPhase}>
              <FlowerMark size={140} variant="accent" />
            </span>
          </button>

          <p
            role="status"
            aria-live="polite"
            className="text-[length:var(--text-lg)] font-medium text-[color:var(--text-main)]"
          >
            {srSupported ? label : 'Voice input unavailable'}
          </p>

          <div className="flex min-h-[2.5rem] w-full flex-col items-center gap-2 text-center">
            {interimText ? (
              <p className="text-[length:var(--text-md)] text-[color:var(--text-main)]">
                {interimText}
              </p>
            ) : (
              <p className="text-[length:var(--text-sm)] text-[color:var(--text-muted)]">
                {srSupported
                  ? 'Speak naturally - it listens, replies, then listens again.'
                  : 'Voice input needs a browser with speech recognition (Chrome/Safari). You can still type in chat and have replies read aloud.'}
              </p>
            )}

            {/* Latest reply, shown while and after speaking */}
            {replyText && !waiting ? (
              <p className="au-scroll mt-1 max-h-[22vh] w-full overflow-y-auto whitespace-pre-wrap rounded-[var(--r-md)] bg-[color:var(--hairline)] px-3 py-2 text-left text-[length:var(--text-sm)] text-[color:var(--text-main)]">
                {replyText}
              </p>
            ) : null}
          </div>

          {note ? (
            <p className="text-[length:var(--text-2xs)] text-[color:var(--text-muted)]">{note}</p>
          ) : null}

          {waiting ? <div className="w-full text-left">{children}</div> : null}
        </div>

        <div
          className="flex items-center justify-between gap-3 border-t px-4 py-3"
          style={{ borderColor: 'var(--hairline)' }}
        >
          <div className="flex items-center gap-2">
            <span className="text-[length:var(--text-2xs)] text-[color:var(--text-muted)]">Voice</span>
            <SegmentedControl
              size="sm"
              value={gender}
              onChange={(v) => onGenderChange?.(v)}
              options={[
                { value: 'female', label: 'Female' },
                { value: 'male', label: 'Male' }
              ]}
            />
          </div>
          <button
            type="button"
            onClick={onClose}
            className="au-focus inline-flex h-7 items-center gap-1.5 rounded-[var(--r-pill)] px-3 text-[length:var(--text-2xs)] font-medium text-rose-500 transition hover:bg-rose-500/10"
          >
            <CloseGlyph size={13} />
            End
          </button>
        </div>
      </div>
    </Modal>
  );
}
