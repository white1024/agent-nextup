import { useEffect, useLayoutEffect, useRef, useState, type ComponentType } from "react";
import { useTranslation } from "react-i18next";

import ErrorBar from "../../components/ErrorBar";
import type { IconProps } from "../../components/icons";
import { motionOff } from "../../lib/fx";
import HubOrbit, { type HubHandle } from "../../components/HubOrbit";

type EntryKind = "open" | "wizard" | "adopt" | "import";

interface Entry {
  kind: EntryKind;
  icon: ComponentType<IconProps>;
  title: string;
  desc: string;
}

/** The welcome's order: initializing is the second port, right after opening. */
const ORDER: EntryKind[] = ["open", "wizard", "adopt", "import"];

/** When the wires may first be drawn: after the ports have risen (spec 20 §5). */
const WIRES_AFTER_MS = 1700;

/**
 * First run (spec 20 §5, D46): no project registered yet. The four entries as
 * ports under a small hub, each wired to the orb; pointing at one draws its
 * wire (C20). Only shown when the registry was read and came back empty
 * (invariant 10) — never while it is still loading.
 */
export default function Welcome({
  entries,
  error,
  onEntry,
}: {
  entries: Entry[];
  error: string | null;
  onEntry: (kind: EntryKind) => void;
}) {
  const { t } = useTranslation();
  const wel = useRef<HTMLDivElement>(null);
  const hub = useRef<HubHandle>(null);
  const [paths, setPaths] = useState<string[]>([]);
  const [hot, setHot] = useState<number | null>(null);
  const [ready, setReady] = useState(false);
  const ports = ORDER.map((k) => entries.find((e) => e.kind === k)).filter(
    (e): e is Entry => e !== undefined,
  );

  useEffect(() => {
    const id = window.setTimeout(() => setReady(true), motionOff() ? 0 : WIRES_AFTER_MS);
    return () => window.clearTimeout(id);
  }, []);

  // The wires run from just under the orb to the top middle of each port, and
  // are re-laid whenever the page changes size (the ports go 4 → 2 columns).
  useLayoutEffect(() => {
    const el = wel.current;
    if (el === null || !ready || motionOff()) return;
    const lay = () => {
      const w = el.getBoundingClientRect();
      const orb = hub.current?.orb()?.getBoundingClientRect();
      if (!orb) return;
      const x0 = orb.left + orb.width / 2 - w.left;
      const y0 = orb.top + orb.height / 2 - w.top + 22;
      setPaths(
        [...el.querySelectorAll<HTMLElement>(".port")].map((p) => {
          const r = p.getBoundingClientRect();
          const x1 = r.left + r.width / 2 - w.left;
          const y1 = r.top - w.top;
          const my = (y0 + y1) / 2;
          return `M${x0.toFixed(1)} ${y0.toFixed(1)} C ${x0.toFixed(1)} ${my.toFixed(1)}, ${x1.toFixed(1)} ${my.toFixed(1)}, ${x1.toFixed(1)} ${y1.toFixed(1)}`;
        }),
      );
    };
    lay();
    const ro = new ResizeObserver(lay);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ready]);

  function heat(i: number | null) {
    setHot(i);
    if (i !== null) hub.current?.pulse();
  }

  return (
    <div className="view view--welcome ov-enter" ref={wel}>
      <svg className="wires" aria-hidden="true">
        {paths.map((d, i) => (
          <Wire key={`${i}:${d}`} d={d} hot={hot === i} />
        ))}
      </svg>
      <h1 className="wel-title">
        <Letters text={t("welcome.title")} />
      </h1>
      <p className="wel-sub">{t("welcome.subtitle")}</p>
      <div className="wel-hub">
        <HubOrbit ref={hub} sessions={[]} small />
      </div>
      <ErrorBar error={error} className="wel-err" />
      <div className="ports">
        {ports.map(({ kind, icon: Icon, title, desc }, j) => (
          <button
            key={kind}
            className={`port${kind === "wizard" ? " pri" : ""}`}
            style={{ ["--j" as string]: j }}
            onClick={() => onEntry(kind)}
            onPointerEnter={() => heat(j)}
            onPointerLeave={() => heat(null)}
            onFocus={() => heat(j)}
            onBlur={() => heat(null)}
          >
            <span className="pi">
              <Icon size={18} />
            </span>
            <b>{title}</b>
            <span>{desc}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** One wire; drawing it hot measures its length so the stroke can grow along it (C20). */
function Wire({ d, hot }: { d: string; hot: boolean }) {
  const ref = useRef<SVGPathElement>(null);
  useLayoutEffect(() => {
    const p = ref.current;
    if (p !== null) p.style.setProperty("--len", p.getTotalLength().toFixed(1));
  }, [d]);
  return <path ref={ref} d={d} className={hot ? "hot" : undefined} />;
}

/**
 * The title, one span per character for the entry (spec 20 §5). Latin words
 * stay in one unbreakable group: a span per letter lets the browser wrap
 * between any two of them, which is how "Agent NextUp" broke mid-word at 520.
 */
function Letters({ text }: { text: string }) {
  let k = 0;
  const parts = text.split(/(\s+)/);
  return (
    <>
      {parts.map((part, i) => {
        if (/^\s+$/.test(part)) return <span key={i}>{part}</span>;
        const latin = /^[\x21-\x7e]+$/.test(part);
        const chars = [...part].map((ch) => (
          <span key={k} className="ch" style={{ ["--k" as string]: k++ }}>
            {ch}
          </span>
        ));
        return latin ? (
          <span key={i} className="ch-word">
            {chars}
          </span>
        ) : (
          <span key={i}>{chars}</span>
        );
      })}
    </>
  );
}
