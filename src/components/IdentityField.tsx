import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";

import InfoTip from "./InfoTip";
import { motionOff } from "../lib/fx";

/**
 * Which remembered identities the list offers for what is in the field (spec
 * 40, C292): all of them while the field is empty or holds exactly one of them
 * (the value it opens with is a past name, and that must not narrow the list
 * to itself), otherwise the ones containing what was typed, case-insensitive.
 */
export function identityMatches(options: string[], value: string): string[] {
  const v = value.trim().toLowerCase();
  if (v === "" || options.some((o) => o.toLowerCase() === v)) return options;
  return options.filter((o) => o.toLowerCase().includes(v));
}

/**
 * The agent-identity field of both launch bars (D63; spec 40, the identity suggestions section,
 * D156 ②): free text with the names used before, drawn by the page rather than
 * the engine's `<datalist>` so the list follows the theme and looks the same on
 * WebView2 and WKWebView.
 *
 * A combobox in the ARIA sense (list autocomplete). Its keys — ↑ ↓ Enter Esc —
 * are handled here and stop here (invariant 12): Esc folding this list must
 * not also close whatever page or dialog it sits in. Tab folds it and is let
 * through.
 *
 * Free text on purpose, as before: there is no registry of identities to pick
 * from, a name is whatever an agent reports (D63), so the list only remembers.
 */
export default function IdentityField({
  id,
  value,
  onChange,
  options,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  /** Remembered names, most recent first (`prefs.recentIdentities`). */
  options: string[];
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(-1);
  /** Kept mounted through the exit so it can fade (C292). */
  const [shown, setShown] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const items = identityMatches(options, value);
  const listId = `${id}-list`;
  const optId = (i: number) => `${id}-opt-${i}`;
  const expanded = open && items.length > 0;

  useLayoutEffect(() => {
    if (expanded) {
      setShown(true);
      return;
    }
    if (!shown) return;
    const el = listRef.current;
    if (el === null || motionOff()) {
      setShown(false);
      return;
    }
    const anim = el.animate(
      [
        { opacity: 1, transform: "none" },
        { opacity: 0, transform: "translateY(-4px)" },
      ],
      { duration: 140, easing: "ease-in", fill: "forwards" },
    );
    let live = true;
    void anim.finished.then(
      () => live && setShown(false),
      () => undefined,
    );
    return () => {
      live = false;
      anim.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);

  // The highlight follows the list: typing can shrink it under the index.
  useEffect(() => {
    if (hi >= items.length) setHi(items.length - 1);
  }, [items.length, hi]);

  function openAt(from: "click" | "key") {
    if (options.length === 0) return;
    const at = items.findIndex((o) => o === value.trim());
    setHi(at >= 0 ? at : from === "key" ? 0 : -1);
    setOpen(true);
  }

  function pick(name: string) {
    onChange(name);
    setOpen(false);
    inputRef.current?.focus();
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Tab") {
      setOpen(false);
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      if (!expanded) {
        openAt("key");
        return;
      }
      const n = items.length;
      setHi((i) => (e.key === "ArrowDown" ? (i + 1) % n : (i - 1 + n) % n));
      return;
    }
    if (!expanded) return;
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      if (hi >= 0 && hi < items.length) pick(items[hi]);
      else setOpen(false);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    }
  }

  return (
    <span className="idf">
      <label htmlFor={id}>{t("term.identityLabel")}</label>
      <span className="idf-wrap">
        <input
          ref={inputRef}
          id={id}
          className="idf-input"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={expanded}
          aria-controls={listId}
          aria-activedescendant={expanded && hi >= 0 ? optId(hi) : undefined}
          autoComplete="off"
          spellCheck={false}
          maxLength={64}
          value={value}
          placeholder={t("term.identityPlaceholder")}
          onChange={(e) => {
            onChange(e.target.value);
            setHi(-1);
            setOpen(identityMatches(options, e.target.value).length > 0);
          }}
          onClick={() => (expanded ? undefined : openAt("click"))}
          onKeyDown={onKey}
          onBlur={() => setOpen(false)}
        />
        {shown && (
          <ul
            ref={listRef}
            id={listId}
            className="idf-list"
            role="listbox"
            aria-label={t("term.identityLabel")}
          >
            {items.map((name, i) => (
              <li
                key={name}
                id={optId(i)}
                role="option"
                aria-selected={i === hi}
                className={`idf-opt${i === hi ? " on" : ""}`}
                onPointerDown={(e) => e.preventDefault()}
                onPointerEnter={() => setHi(i)}
                onClick={() => pick(name)}
              >
                {name}
              </li>
            ))}
          </ul>
        )}
      </span>
      <InfoTip label={t("term.identityHintLabel")}>{t("term.identityHint")}</InfoTip>
    </span>
  );
}
