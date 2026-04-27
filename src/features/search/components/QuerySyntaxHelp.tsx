import { useEffect, useRef, useState } from "react";
import { HelpCircle } from "lucide-react";

const OPERATORS: Array<{ name: string; example: string; gloss: string }> = [
  { name: "kind:", example: "kind:note", gloss: "Restrict to one or more node kinds" },
  { name: "kind: (multi)", example: "kind:note,url", gloss: "Comma-separated values" },
  { name: "mount:", example: "mount:<uuid>", gloss: "Limit to nodes inside a mount" },
];

/**
 * The ``?`` icon in the Cmd+K palette's input row. Clicking it opens
 * a small popover listing the inline operators with one example each.
 *
 * No autocomplete (R5 / Cmd+K palette UX decision in the origin doc).
 * The popover is decoration only — the parser tolerates invalid
 * tokens by falling them through as plain text per R6.
 */
export function QuerySyntaxHelp() {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(event: MouseEvent) {
      const target = event.target as Node | null;
      if (
        target &&
        !buttonRef.current?.contains(target) &&
        !popoverRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    }
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  return (
    <div className="search-help">
      <button
        ref={buttonRef}
        type="button"
        className="search-help-toggle"
        aria-label="Show query syntax help"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={(event) => {
          event.stopPropagation();
          setOpen((prev) => !prev);
        }}
      >
        <HelpCircle size={14} aria-hidden="true" />
      </button>
      {open ? (
        <div
          ref={popoverRef}
          role="dialog"
          aria-label="Search syntax"
          className="search-help-popover"
        >
          <p className="search-help-eyebrow">Filter operators</p>
          <ul className="search-help-list">
            {OPERATORS.map((op) => (
              <li key={op.example}>
                <code className="search-help-token">{op.example}</code>
                <span className="search-help-gloss">{op.gloss}</span>
              </li>
            ))}
          </ul>
          <p className="search-help-footer">
            Invalid tokens fall through as plain text — no syntax error.
          </p>
        </div>
      ) : null}
    </div>
  );
}
