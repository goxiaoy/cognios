/**
 * CogniOS logo mark — concentric "knowledge node" with a cursor dot.
 * A hollow ink-stroke C (the knowledge ring) cradles a filled
 * terracotta core (the OS cursor), bridged by a thin accent arc
 * that reads as a synapse. Strokes use ``currentColor`` for the
 * outer ring so the mark inherits the ink color of its container;
 * the synapse + core honor the ``--accent`` token directly so the
 * mark follows accent tweaks/dark mode.
 *
 * Sized at 28px by default to sit at x-height with the serif
 * "CogniOS" wordmark in the sidebar lockup.
 */
export function CogniLogo({
  size = 28,
  className,
  "aria-hidden": ariaHidden,
}: {
  size?: number;
  className?: string;
  "aria-hidden"?: boolean;
}) {
  return (
    <svg
      aria-hidden={ariaHidden}
      aria-label={ariaHidden ? undefined : "CogniOS"}
      className={className}
      fill="none"
      height={size}
      role={ariaHidden ? undefined : "img"}
      viewBox="0 0 32 32"
      width={size}
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Outer hollow C — knowledge ring, opens to the right */}
      <path
        d="M 26 9 A 11 11 0 1 0 26 23"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="2.4"
      />
      {/* Inner synapse arc — small accent stroke connecting ring to core */}
      <path
        d="M 22 11.5 A 6.5 6.5 0 0 0 12 16"
        fill="none"
        opacity="0.95"
        stroke="var(--accent)"
        strokeLinecap="round"
        strokeWidth="2.2"
      />
      {/* Core node — the "OS" cursor */}
      <circle cx="22" cy="20" fill="var(--accent)" r="3.4" />
      {/* Tiny inner highlight on core to feel like a node, not a bullet */}
      <circle
        cx="22"
        cy="20"
        fill="var(--panel, #fff)"
        opacity="0.55"
        r="1.1"
      />
    </svg>
  );
}
