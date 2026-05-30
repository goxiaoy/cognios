import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from "react";
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight, X } from "lucide-react";

interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
  disabledReason?: string | null;
}

export function AppSelect({
  label,
  options,
  value,
  onChange,
  className = "",
}: {
  label: string;
  options: SelectOption[];
  value: string;
  onChange(value: string): void;
  className?: string;
}) {
  const id = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(() =>
    initialActiveIndex(options, value)
  );
  const selected = options.find((option) => option.value === value) ?? options[0];

  useDismissOnOutside(rootRef, () => setOpen(false));

  useEffect(() => {
    if (!open) return;
    setActiveIndex(initialActiveIndex(options, value));
  }, [open, options, value]);

  function choose(option: SelectOption) {
    if (option.disabled) return;
    onChange(option.value);
    setOpen(false);
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key === "Escape") {
      setOpen(false);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((index) => {
        const delta = event.key === "ArrowDown" ? 1 : -1;
        return nextEnabledIndex(options, index, delta);
      });
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (open) {
        choose(options[activeIndex] ?? selected);
      } else {
        setOpen(true);
      }
    }
  }

  return (
    <div ref={rootRef} className={`app-select ${className}`.trim()}>
      <button
        type="button"
        className="app-select-button"
        aria-label={`${label}: ${selected?.label ?? ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((next) => !next)}
        onKeyDown={handleKeyDown}
      >
        <span className="app-select-label">{label}</span>
        <span className="app-select-value">{selected?.label}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open ? (
        <div id={id} className="app-select-menu" role="listbox" aria-label={label}>
          {options.map((option, index) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              aria-disabled={option.disabled || undefined}
              className={`app-select-option${index === activeIndex ? " is-active" : ""}${option.disabled ? " is-disabled" : ""}`}
              title={option.disabledReason ?? undefined}
              onMouseEnter={() => {
                if (!option.disabled) setActiveIndex(index);
              }}
              onClick={() => choose(option)}
            >
              <span>{option.label}</span>
              {option.disabledReason ? (
                <span className="app-select-option-reason">{option.disabledReason}</span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function initialActiveIndex(options: SelectOption[], value: string): number {
  const selectedIndex = options.findIndex((option) => option.value === value);
  if (selectedIndex >= 0 && !options[selectedIndex]?.disabled) return selectedIndex;
  const firstEnabled = options.findIndex((option) => !option.disabled);
  return Math.max(0, firstEnabled);
}

function nextEnabledIndex(
  options: SelectOption[],
  currentIndex: number,
  delta: 1 | -1
): number {
  if (options.length === 0 || options.every((option) => option.disabled)) {
    return Math.max(0, currentIndex);
  }
  let index = currentIndex;
  for (let checked = 0; checked < options.length; checked += 1) {
    index = (index + delta + options.length) % options.length;
    if (!options[index]?.disabled) return index;
  }
  return Math.max(0, currentIndex);
}

export function AppDatePicker({
  label,
  placeholder,
  value,
  onChange,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange(value: string): void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [visibleMonth, setVisibleMonth] = useState(() => monthStart(parseDate(value) ?? new Date()));
  const selectedDate = parseDate(value);
  const weeks = useMemo(() => calendarWeeks(visibleMonth), [visibleMonth]);

  useDismissOnOutside(rootRef, () => setOpen(false));

  useEffect(() => {
    if (!open || !selectedDate) return;
    setVisibleMonth(monthStart(selectedDate));
  }, [open, selectedDate?.getTime()]);

  function choose(date: Date) {
    onChange(formatDateValue(date));
    setOpen(false);
  }

  function moveMonth(delta: number) {
    setVisibleMonth((month) => new Date(month.getFullYear(), month.getMonth() + delta, 1));
  }

  return (
    <div ref={rootRef} className="app-date-picker">
      <button
        type="button"
        className={`app-date-button${value ? " has-value" : ""}`}
        aria-label={`${label}: ${value || placeholder}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((next) => !next)}
      >
        <CalendarDays size={14} aria-hidden="true" />
        <span>{value || placeholder}</span>
      </button>
      {value ? (
        <button
          type="button"
          className="app-date-clear"
          aria-label={`Clear ${label}`}
          onClick={() => onChange("")}
        >
          <X size={12} aria-hidden="true" />
        </button>
      ) : null}
      {open ? (
        <div className="app-calendar" role="dialog" aria-label={label}>
          <header className="app-calendar-header">
            <button type="button" aria-label="Previous month" onClick={() => moveMonth(-1)}>
              <ChevronLeft size={14} aria-hidden="true" />
            </button>
            <span>{formatMonthLabel(visibleMonth)}</span>
            <button type="button" aria-label="Next month" onClick={() => moveMonth(1)}>
              <ChevronRight size={14} aria-hidden="true" />
            </button>
          </header>
          <div className="app-calendar-grid" aria-hidden="true">
            {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((day) => (
              <span key={day} className="app-calendar-weekday">
                {day}
              </span>
            ))}
          </div>
          <div className="app-calendar-grid">
            {weeks.flat().map((date) => {
              const outside = date.getMonth() !== visibleMonth.getMonth();
              const selected = selectedDate ? sameDay(date, selectedDate) : false;
              return (
                <button
                  key={formatDateValue(date)}
                  type="button"
                  className={`app-calendar-day${outside ? " is-outside" : ""}${selected ? " is-selected" : ""}`}
                  aria-label={formatDateValue(date)}
                  aria-pressed={selected}
                  onClick={() => choose(date)}
                >
                  {date.getDate()}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function useDismissOnOutside(
  rootRef: RefObject<HTMLElement | null>,
  onDismiss: () => void
) {
  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      const root = rootRef.current;
      if (!root || root.contains(event.target as Node)) return;
      onDismiss();
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onDismiss();
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onDismiss, rootRef]);
}

function parseDate(value: string): Date | null {
  if (!value) return null;
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return null;
  return new Date(year, month - 1, day);
}

function monthStart(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function calendarWeeks(month: Date): Date[][] {
  const first = monthStart(month);
  const cursor = new Date(first);
  cursor.setDate(first.getDate() - first.getDay());
  const weeks: Date[][] = [];
  for (let week = 0; week < 6; week += 1) {
    const days: Date[] = [];
    for (let day = 0; day < 7; day += 1) {
      days.push(new Date(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push(days);
  }
  return weeks;
}

function formatDateValue(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatMonthLabel(date: Date): string {
  return new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(date);
}

function sameDay(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}
