import { useRef } from "react";
import { useTranslation } from "react-i18next";

import { useNamesFit } from "../../hooks/useNamesFit";

import type { Gate, PhaseOutline } from "../../types";
import { dashParts } from "./model";

/** A sentence whose "——" never starts a line (see `dashParts`). */
export function DashText({ text }: { text: string }) {
  const [a, nw, b] = dashParts(text);
  if (nw === "") return <>{text}</>;
  return (
    <>
      {a}
      <span className="tp-nw">{nw}</span>
      {b}
    </>
  );
}

/**
 * One exit gate as a mark (spec 60, template list): a hollow square for a gate
 * the engine checks, a hollow circle for one a person confirms. Never
 * coloured — a template has nothing that passed or failed yet; the shape is the
 * whole signal, and the kind is in the tooltip (invariant 9(a)).
 */
export function GateMark({ kind, className }: { kind: Gate["kind"]; className?: string }) {
  const { t } = useTranslation();
  return (
    <i
      className={`tp-mk${kind === "manual_confirm" ? " ci" : ""}${className ? ` ${className}` : ""}`}
      title={t(`tpl.gateKinds.${kind}`)}
    />
  );
}

/**
 * C140's band on a template card: one cell per phase with its name, the
 * phase's exit gates as marks underneath. The light that walks it is CSS
 * (`.tp-band.go`); the list decides when (`bandRun` in ./motion).
 *
 * Phrasing content only — it sits inside the card's button.
 */
export default function TemplateBand({ phases }: { phases: PhaseOutline[] }) {
  const { t } = useTranslation();
  const titles = phases.map((p) => (p.title.trim() === "" ? t("tpl.untitledPhase") : p.title));
  // Names whole or numbers, never a cut name (F17, D158 ③); see useNamesFit.
  const ref = useRef<HTMLSpanElement>(null);
  const named = useNamesFit(ref, titles, ".tp-cell", ".tp-cell b");
  return (
    <span
      ref={ref}
      className={`tp-band${named ? " tp-band--named" : ""}`}
      style={{ ["--n" as string]: phases.length }}
      role="img"
      aria-label={t("tpl.bandAria", { n: phases.length, names: titles.join(t("tpl.listSep")) })}
    >
      <i className="tp-band-beam" />
      {phases.map((p, k) => (
        <span key={k} className="tp-cell" style={{ ["--k" as string]: k }} title={titles[k]}>
          <i className="tp-cell-lt" />
          <b>{named ? titles[k] : k + 1}</b>
          <span className="tp-mks">
            {p.gates.map((g, gi) => (
              <GateMark key={gi} kind={g} />
            ))}
          </span>
        </span>
      ))}
    </span>
  );
}
