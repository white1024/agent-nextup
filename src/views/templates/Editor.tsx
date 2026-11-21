import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useTranslation } from "react-i18next";

import { api, errorMessage } from "../../api";
import ConfirmDanger from "../../components/ConfirmDanger";
import ErrorBar from "../../components/ErrorBar";
import { IconArrowRight, IconPlus, IconWarn, IconX } from "../../components/icons";
import Scramble from "../../components/Scramble";
import { centreOf, fx, motionOff } from "../../lib/fx";
import { EASE_OUT } from "../../lib/listMotion";
import type { Gate, TemplateSummary, WorkflowPhase, WorkflowTemplate } from "../../types";
import { failedPhaseId, instructionLines, ongoingOrNone } from "./model";
import { splitAroundCount } from "../../lib/format";
import { offsetIn, runRail } from "./motion";
import { DashText, GateMark } from "./TemplateBand";

/** How the editor was entered: decides id mutability and read-only-ness. */
export type EditorMode = "create" | "edit" | "view";

const GATE_KINDS: Gate["kind"][] = [
  "min_tasks",
  "min_decisions",
  "all_tasks_done",
  "no_blocked_tasks",
  "artifact_exists",
  "manual_confirm",
  "doctor_clean",
];

/** Mirror of core's `validate_custom_id` — inline feedback only, core still owns the rule. */
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const wait = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
const pad = (i: number) => String(i + 1).padStart(2, "0");

function defaultGate(kind: Gate["kind"]): Gate {
  switch (kind) {
    case "min_tasks":
      return { kind, count: 1 };
    case "min_decisions":
      return { kind, count: 1 };
    case "artifact_exists":
      return { kind, path: "" };
    case "manual_confirm":
      return { kind, prompt: "" };
    default:
      return { kind } as Gate;
  }
}

/** Template id derived from the name (D44 folder-name convention): ascii
 *  slug when the name yields one, unique against the catalog either way.
 *  CJK-only names fall back to a neutral base — the field stays editable. */
function deriveTemplateId(name: string, taken: Set<string>): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 58)
    .replace(/-+$/g, "");
  const base = slug === "" ? "custom" : slug;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Smallest phase-N not already used — reorders never renumber. */
function nextPhaseId(phases: WorkflowPhase[]): string {
  const used = new Set(phases.map((p) => p.id));
  for (let n = 1; ; n++) {
    const candidate = `phase-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** Trim fields and drop empty instruction lines; core validates the rest. */
function normalized(t: WorkflowTemplate): WorkflowTemplate {
  return {
    ...t,
    id: t.id.trim(),
    name: t.name.trim(),
    description: t.description.trim(),
    domainHint: t.domainHint.trim(),
    phases: t.phases.map((p) => ({
      ...p,
      id: p.id.trim(),
      title: p.title.trim(),
      description: p.description.trim(),
      aiInstructions: instructionLines(p.aiInstructions),
    })),
    ongoingInstructions: ongoingOrNone(instructionLines(t.ongoingInstructions ?? [])),
  };
}

interface Props {
  mode: EditorMode;
  template: WorkflowTemplate;
  /** "New from this" just swapped a built-in for its copy: play C149. */
  entering?: "copy";
  /** Every catalog id (built-in + custom) — id derivation and collision checks. */
  existingIds: string[];
  /** Save succeeded; the fresh summaries ride along so the list needs no refetch. */
  onSaved: (list: TemplateSummary[], id: string) => void;
  onClose: () => void;
  /** View mode's "New from this" — parent restarts the editor in create mode. */
  onCopy: (base: WorkflowTemplate) => void;
}

/**
 * Full-page master-detail template editor (D51): basics on top, phase rail on
 * the left, the selected phase's detail on the right. Built-ins render the
 * same page read-only.
 *
 * D153 (spec 60): the rail is a track with a station per phase and the exit
 * gates as marks on the track below it (C142); a light sits on the selected
 * station and a hairline joins its tile to the detail (C143 slides them);
 * moves slide the tiles (C144); the gate picker and a new gate land with
 * motion (C145 / C146); saving runs a light down the track (C147 / C148).
 *
 * Phases carry a key that never changes for the life of the editor (`keys`,
 * parallel to `draft.phases`): sliding a tile to its new place needs to know
 * which tile is which after a reorder, and an index cannot say.
 */
export default function TemplateEditor({
  mode,
  template,
  entering,
  existingIds,
  onSaved,
  onClose,
  onCopy,
}: Props) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<WorkflowTemplate>(template);
  const [keys, setKeys] = useState<number[]>(() => template.phases.map((_, i) => i));
  const nextKey = useRef(template.phases.length);
  // The rail's selection moves at once; the detail follows after it has
  // faded (C143), so for 130 ms the two differ.
  const [selKey, setSelKey] = useState(0);
  const [viewKey, setViewKey] = useState(0);
  const [idTouched, setIdTouched] = useState(false);
  const [pickingGate, setPickingGate] = useState(false);
  const [addBack, setAddBack] = useState(false);
  const [dropGate, setDropGate] = useState<{ key: number; gi: number } | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [saving, setSaving] = useState(false);
  const [charging, setCharging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [badKey, setBadKey] = useState<number | null>(null);
  const copying = entering === "copy" && !motionOff();
  const modeText = mode === "create" ? t("tpl.editorCreate") : mode === "edit" ? t("tpl.editorEdit") : t("tpl.editorView");
  // C149 starts from the words the built-in's editor had, then settles.
  const [modeFrom, setModeFrom] = useState<string | null>(() => (copying ? t("tpl.editorView") : null));
  const [ghostChip, setGhostChip] = useState(copying);
  const initialJson = useRef(JSON.stringify(template));

  const viewRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLElement>(null);
  const detailRef = useRef<HTMLElement>(null);
  const dtRef = useRef<HTMLDivElement>(null);
  const ltRef = useRef<HTMLElement>(null);
  const linkRef = useRef<HTMLElement>(null);
  const aiRef = useRef<HTMLTextAreaElement>(null);
  const ongoingRef = useRef<HTMLTextAreaElement>(null);
  const mounted = useRef(true);
  const swapToken = useRef(0);
  const slideNext = useRef(false);
  const lastLt = useRef<number | null>(null);
  const lastLink = useRef<number | null>(null);
  const dropTimer = useRef(0);
  // What the async handlers read after an await: the render they started in
  // may be several renders old by then.
  const latest = useRef({ draft, keys, selKey, viewKey });
  latest.current = { draft, keys, selKey, viewKey };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      window.clearTimeout(dropTimer.current);
    };
  }, []);

  const readOnly = mode === "view";
  const taken = useMemo(() => new Set(existingIds), [existingIds]);
  const dirty = JSON.stringify(draft) !== initialJson.current;
  const n = draft.phases.length;
  const selIndex = Math.max(0, keys.indexOf(selKey));
  const viewIndex = Math.max(0, keys.indexOf(viewKey));

  const patch = (changes: Partial<WorkflowTemplate>) => setDraft({ ...draft, ...changes });
  const patchPhase = (i: number, changes: Partial<WorkflowPhase>) =>
    patch({ phases: draft.phases.map((p, pi) => (pi === i ? { ...p, ...changes } : p)) });
  const patchGate = (i: number, gi: number, gate: Gate) =>
    patchPhase(i, {
      exitGates: draft.phases[i].exitGates.map((g, ggi) => (ggi === gi ? gate : g)),
    });

  function setName(name: string) {
    // Until the id field is touched the id tracks the name (create mode only).
    if (mode === "create" && !idTouched) {
      patch({ name, id: name.trim() === "" ? "" : deriveTemplateId(name, taken) });
    } else {
      patch({ name });
    }
  }

  // ── C142 / C143: the light on the selected station, the hairline across ──
  // Measured by layout offsets (motion.ts `offsetIn`), so a tile still
  // sliding reads where it is going. Re-measured after every render — typing
  // does not move anything, so that costs one read — and when the page
  // resizes; it slides only when the selection or the rail itself changed.
  function place(slide: boolean) {
    const body = bodyRef.current;
    const rail = railRef.current;
    const det = detailRef.current;
    const lt = ltRef.current;
    const link = linkRef.current;
    if (body === null || rail === null || det === null || lt === null || link === null) return;
    const it = rail.querySelectorAll<HTMLElement>(".tp-it")[selIndex];
    const ph = it?.querySelector<HTMLElement>(".tp-ph");
    const sn = it?.querySelector<HTMLElement>(".tp-stn");
    if (!ph || !sn) return;
    const move = slide && !motionOff();
    const so = offsetIn(sn, rail);
    const ly = Math.round(so.y + sn.offsetHeight / 2);
    lt.style.left = `${Math.round(so.x + sn.offsetWidth / 2)}px`;
    lt.style.top = `${ly}px`;
    if (move && lastLt.current !== null && lastLt.current !== ly) {
      lt.animate([{ transform: `translateY(${lastLt.current - ly}px)` }, { transform: "none" }], {
        duration: 380,
        easing: EASE_OUT,
      });
    }
    lastLt.current = ly;
    // Side by side only: in one column there is nothing to join.
    const side = det.offsetLeft >= rail.offsetLeft + rail.offsetWidth - 1;
    link.style.display = side ? "" : "none";
    if (!side) {
      lastLink.current = null;
      return;
    }
    const po = offsetIn(ph, body);
    const x = po.x + ph.offsetWidth;
    const y = Math.round(po.y + ph.offsetHeight / 2);
    Object.assign(link.style, { left: `${x}px`, width: `${Math.max(0, det.offsetLeft - x)}px`, top: `${y}px` });
    if (move && lastLink.current !== null && lastLink.current !== y) {
      link.animate([{ transform: `translateY(${lastLink.current - y}px)` }, { transform: "none" }], {
        duration: 380,
        easing: EASE_OUT,
      });
    }
    lastLink.current = y;
  }

  // The observer outlives renders; it calls whichever `place` is current.
  const placeRef = useRef(place);
  placeRef.current = place;

  useLayoutEffect(() => {
    place(slideNext.current);
    slideNext.current = false;
  });

  useEffect(() => {
    const body = bodyRef.current;
    if (body === null) return;
    const ro = new ResizeObserver(() => placeRef.current(false));
    ro.observe(body);
    void document.fonts?.ready.then(() => {
      if (mounted.current) placeRef.current(false);
    });
    return () => ro.disconnect();
  }, []);

  // The AI instructions grow with their content (built-ins show all of it,
  // with no scrollbar inside the box).
  const aiText = draft.phases[viewIndex]?.aiInstructions.join("\n") ?? "";
  useLayoutEffect(() => {
    const ta = aiRef.current;
    if (ta === null) return;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight + 2}px`;
  }, [aiText, viewKey]);
  const ongoingText = (draft.ongoingInstructions ?? []).join("\n");
  useLayoutEffect(() => {
    const ta = ongoingRef.current;
    if (ta === null) return;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight + 2}px`;
  }, [ongoingText]);

  // ── C149: "New from this" lands on a fresh editor ──────────────────────────
  useLayoutEffect(() => {
    if (!copying) return;
    setModeFrom(null);
    const root = viewRef.current;
    const rail = railRef.current;
    if (root === null) return;
    if (rail !== null) {
      const scan = document.createElement("i");
      scan.className = "tp-scan";
      scan.setAttribute("aria-hidden", "true");
      rail.appendChild(scan);
      const a = scan.animate(
        [
          { transform: "translateY(-90px)", opacity: 1 },
          { transform: `translateY(${rail.clientHeight}px)`, opacity: 0.7 },
        ],
        { duration: 820, easing: "cubic-bezier(.45,0,.25,1)", fill: "forwards" },
      );
      a.finished.then(
        () => scan.remove(),
        () => scan.remove(),
      );
    }
    root.querySelectorAll(".tp-in").forEach((f, k) =>
      f.animate([{ opacity: 0 }, { opacity: 1, offset: 0.35 }, { opacity: 0 }], {
        duration: 1000,
        delay: 160 + k * 45,
        easing: "ease-out",
        pseudoElement: "::after",
      }),
    );
    root.querySelectorAll(".header-actions .btn").forEach((b, k) =>
      b.animate(
        [
          { opacity: 0, transform: "translateY(4px)" },
          { opacity: 1, transform: "none" },
        ],
        { duration: 320, delay: 240 + k * 70, easing: EASE_OUT, fill: "backwards" },
      ),
    );
    // Mount only: it is the arrival of this editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── C143: the detail fades out, swaps, fades in; the panel stays put ──────
  function showDetail(key: number) {
    const dt = dtRef.current;
    if (dt === null || motionOff()) {
      setViewKey(key);
      return;
    }
    const token = ++swapToken.current;
    const out = dt.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 130, easing: "ease-in", fill: "forwards" });
    out.finished.then(
      () => {
        if (token !== swapToken.current || !mounted.current) return;
        flushSync(() => setViewKey(key));
        out.cancel();
        dt.animate(
          [
            { opacity: 0, transform: "translateY(6px)" },
            { opacity: 1, transform: "none" },
          ],
          { duration: 240, easing: EASE_OUT, fill: "backwards" },
        );
      },
      () => undefined,
    );
  }

  function select(key: number) {
    if (key === selKey) return;
    slideNext.current = true;
    setSelKey(key);
    showDetail(key);
  }

  // ── C144: tiles slide to their new place, numbers settle ─────────────────
  const tileTops = () => {
    const out = new Map<string, number>();
    const rail = railRef.current;
    if (rail === null) return out;
    const top = rail.getBoundingClientRect().top;
    for (const el of rail.querySelectorAll<HTMLElement>(".tp-it")) {
      out.set(el.dataset.key ?? "", el.getBoundingClientRect().top - top);
    }
    return out;
  };

  function slideTiles(before: Map<string, number>) {
    const rail = railRef.current;
    if (rail === null || motionOff()) return;
    const top = rail.getBoundingClientRect().top;
    for (const el of rail.querySelectorAll<HTMLElement>(".tp-it")) {
      const was = before.get(el.dataset.key ?? "");
      if (was === undefined) continue;
      const dy = Math.round(was - (el.getBoundingClientRect().top - top));
      if (dy === 0) continue;
      el.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], {
        duration: 420,
        easing: "cubic-bezier(.2,.9,.25,1)",
      });
    }
  }

  const movePhase = (i: number, delta: number) => {
    const j = i + delta;
    if (j < 0 || j >= n) return;
    const before = tileTops();
    const phases = [...draft.phases];
    [phases[i], phases[j]] = [phases[j], phases[i]];
    const ks = [...keys];
    [ks[i], ks[j]] = [ks[j], ks[i]];
    slideNext.current = true;
    flushSync(() => {
      setDraft({ ...draft, phases });
      setKeys(ks);
    });
    slideTiles(before);
  };

  async function removePhase(i: number) {
    if (n === 1) return;
    const key = keys[i];
    const tile = railRef.current?.querySelector<HTMLElement>(`.tp-it[data-key="${key}"]`) ?? null;
    if (tile !== null && !motionOff()) {
      tile.style.pointerEvents = "none";
      await tile
        .animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, easing: "ease-in", fill: "forwards" })
        .finished.catch(() => undefined);
    }
    if (!mounted.current) return;
    const cur = latest.current;
    const at = cur.keys.indexOf(key);
    if (at < 0 || cur.keys.length === 1) return;
    const ks = cur.keys.filter((k) => k !== key);
    const nextSel = cur.selKey === key ? ks[Math.min(at, ks.length - 1)] : cur.selKey;
    const before = tileTops();
    slideNext.current = true;
    flushSync(() => {
      setDraft({ ...cur.draft, phases: cur.draft.phases.filter((_, k) => k !== at) });
      setKeys(ks);
      setSelKey(nextSel);
    });
    slideTiles(before);
    if (cur.viewKey === key) showDetail(nextSel);
  }

  function addPhase() {
    const key = nextKey.current++;
    const phase: WorkflowPhase = {
      id: nextPhaseId(draft.phases),
      title: "",
      description: "",
      aiInstructions: [],
      exitGates: [],
    };
    slideNext.current = true;
    flushSync(() => {
      setDraft({ ...draft, phases: [...draft.phases, phase] });
      setKeys([...keys, key]);
      setSelKey(key);
      setPickingGate(false);
    });
    const tile = railRef.current?.querySelector<HTMLElement>(`.tp-it[data-key="${key}"]`);
    if (tile && !motionOff()) {
      tile.animate([{ transform: "scaleY(0)" }, { transform: "scaleY(1)" }], {
        duration: 360,
        easing: EASE_OUT,
        pseudoElement: "::before",
      });
      tile.querySelectorAll(":scope > .tp-st, :scope > .tp-seg").forEach((x, k) =>
        x.animate(
          [
            { opacity: 0, transform: "translateY(-12px)" },
            { opacity: 1, transform: "none" },
          ],
          { duration: 420, delay: 140 + k * 60, easing: EASE_OUT, fill: "backwards" },
        ),
      );
    }
    showDetail(key);
  }

  // ── C145 / C146: gates ───────────────────────────────────────────────────
  function openPick() {
    setAddBack(false);
    setPickingGate(true);
  }

  function closePick() {
    setPickingGate(false);
    setAddBack(true);
  }

  function pickGate(kind: Gate["kind"]) {
    const key = viewKey;
    const p = draft.phases[viewIndex];
    const gi = p.exitGates.length;
    flushSync(() => {
      patchPhase(viewIndex, { exitGates: [...p.exitGates, defaultGate(kind)] });
      setPickingGate(false);
      setAddBack(true);
      setDropGate({ key, gi });
    });
    window.clearTimeout(dropTimer.current);
    dropTimer.current = window.setTimeout(() => {
      if (mounted.current) setDropGate(null);
    }, 900);
    if (motionOff()) return;
    // A short light from the new card's mark to the new mark on the track.
    window.setTimeout(() => {
      const a = dtRef.current?.querySelector(`.tp-gate[data-gate="${gi}"] .tp-mk`);
      const b = railRef.current?.querySelectorAll(`.tp-it[data-key="${key}"] .tp-seg .tp-mk`)[gi];
      if (a?.isConnected && b !== undefined) {
        fx.beam(centreOf(a), centreOf(b), { dur: 540, bend: 0.22, width: 2, trail: 0.4 });
      }
    }, 420);
  }

  async function removeGate(gi: number) {
    const key = viewKey;
    const card = dtRef.current?.querySelector<HTMLElement>(`.tp-gate[data-gate="${gi}"]`) ?? null;
    const mark = railRef.current?.querySelectorAll<HTMLElement>(`.tp-it[data-key="${key}"] .tp-seg .tp-mk`)[gi];
    const anims: Animation[] = [];
    if (card !== null && !motionOff()) {
      if (mark !== undefined) anims.push(mark.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 220, fill: "forwards" }));
      const a = card.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 220, easing: "ease-in", fill: "forwards" });
      anims.push(a);
      await a.finished.catch(() => undefined);
    }
    if (!mounted.current) return;
    const cur = latest.current;
    const at = cur.keys.indexOf(key);
    if (at < 0) return;
    flushSync(() =>
      setDraft({
        ...cur.draft,
        phases: cur.draft.phases.map((p, k) =>
          k === at ? { ...p, exitGates: p.exitGates.filter((_, g) => g !== gi) } : p,
        ),
      }),
    );
    // Gates are keyed by position, so the faded node now shows the next gate.
    for (const a of anims) a.cancel();
  }

  // ── Validation ───────────────────────────────────────────────────────────
  const trimmedId = draft.id.trim();
  const idInvalid = trimmedId !== "" && !ID_RE.test(trimmedId);
  const idTaken = mode === "create" && taken.has(trimmedId);
  const phaseIdCounts = new Map<string, number>();
  for (const p of draft.phases) {
    const id = p.id.trim();
    phaseIdCounts.set(id, (phaseIdCounts.get(id) ?? 0) + 1);
  }
  const canSave =
    trimmedId !== "" &&
    !idInvalid &&
    !idTaken &&
    draft.name.trim() !== "" &&
    draft.phases.length > 0 &&
    draft.phases.every(
      (p) => p.id.trim() !== "" && p.title.trim() !== "" && phaseIdCounts.get(p.id.trim()) === 1,
    );

  // ── C147 / C148: save ────────────────────────────────────────────────────
  // Deliberately *not* on `useGuardedMutation`, and not an oversight: there is
  // no `finally` here, because on success `onSaved` unmounts this editor and
  // leaving `saving` true is what keeps the button from flashing back to
  // clickable on the way out. The hook always clears its flag. Nothing is lost
  // by staying: `saveCustomTemplate` upserts by id, so a repeated call is
  // idempotent and needs no gate.
  //
  // The ring charges while core is asked (at least its 440 ms); then a light
  // runs down the track — all the way when the save went through, to the
  // phase core named when it did not.
  async function save() {
    const body = normalized(draft);
    setError(null);
    setBadKey(null);
    setSaving(true);
    setCharging(!motionOff());
    const t0 = performance.now();
    let list: TemplateSummary[] | null = null;
    let failure: unknown = null;
    try {
      list = await api.saveCustomTemplate(body);
    } catch (e) {
      failure = e;
    }
    if (!motionOff()) await wait(Math.max(0, 440 - (performance.now() - t0)));
    if (!mounted.current) return;
    if (list !== null) {
      await runRail(railRef.current, n - 1, true);
      if (mounted.current) onSaved(list, body.id);
      return;
    }
    const message = errorMessage(failure);
    const pid = failedPhaseId(message);
    const at = pid === null ? -1 : body.phases.findIndex((p) => p.id === pid);
    await runRail(railRef.current, Math.max(0, at), false);
    if (!mounted.current) return;
    setError(message);
    setBadKey(at < 0 ? null : latest.current.keys[at] ?? null);
    setSaving(false);
    setCharging(false);
  }

  function requestClose() {
    if (!readOnly && dirty) setConfirmDiscard(true);
    else onClose();
  }

  const phase = draft.phases[viewIndex] ?? draft.phases[0];
  const phaseIdDup = phase.id.trim() !== "" && (phaseIdCounts.get(phase.id.trim()) ?? 0) > 1;
  const [countBefore, countAfter] = splitAroundCount((x) => t("tpl.gateCountShort", { n: x }));

  return (
    <div className="view tp tp-ed" data-tp-mode={mode} ref={viewRef}>
      <header className="view-header">
        <div className="vh-main">
          <h1 className="tp-h1">
            <span className="tp-mode">
              <Scramble value={modeFrom ?? modeText} durationMs={640} />
            </span>
            {draft.name.trim() !== "" && <span className="tp-name">{draft.name}</span>}
            {readOnly && <span className="chip tp-badge">{t("tpl.builtIn")}</span>}
            {ghostChip && (
              <span className="chip tp-badge tp-badge-out" aria-hidden="true" onAnimationEnd={() => setGhostChip(false)}>
                {t("tpl.builtIn")}
              </span>
            )}
          </h1>
          <p className="view-sub">
            <DashText text={readOnly ? t("tpl.viewHint") : t("tpl.editorHint")} />
          </p>
        </div>
        <div className="header-actions">
          {readOnly ? (
            <>
              <button className="btn" onClick={onClose}>
                {t("tpl.back")}
              </button>
              <button className="btn btn-primary" onClick={() => onCopy(draft)}>
                {t("tpl.newFromThis")}
              </button>
            </>
          ) : (
            <>
              <button className="btn" onClick={requestClose}>
                {t("common.cancel")}
              </button>
              <button
                className={`btn btn-primary tp-save${charging ? " charging" : ""}`}
                disabled={!canSave || saving}
                onClick={() => void save()}
              >
                <i className="tp-ring" aria-hidden="true" />
                {t("tpl.save")}
              </button>
            </>
          )}
        </div>
      </header>

      <ErrorBar error={error} />

      <section className="panel tp-meta">
        <label className="tp-f">
          <span className="tp-l">{t("tpl.name")}</span>
          <span className="tp-in">
            <input
              value={draft.name}
              disabled={readOnly}
              autoFocus={mode === "create" && entering !== "copy"}
              onChange={(e) => setName(e.target.value)}
            />
          </span>
        </label>
        <label className="tp-f">
          <span className="tp-l">{t("tpl.id")}</span>
          <span className="tp-in">
            <input
              className="tp-mono"
              value={draft.id}
              disabled={mode !== "create"}
              onChange={(e) => {
                setIdTouched(true);
                patch({ id: e.target.value });
              }}
              placeholder="my-flow-v1"
            />
          </span>
          {mode === "create" && (
            <span className={`tp-sub${idInvalid || idTaken ? " bad" : ""}`}>
              {idInvalid ? t("tpl.idInvalid") : idTaken ? t("tpl.idTaken") : t("tpl.idHint")}
            </span>
          )}
        </label>
        <label className="tp-f tp-f-desc">
          <span className="tp-l">{t("tpl.desc")}</span>
          <span className="tp-in">
            <input
              value={draft.description}
              disabled={readOnly}
              placeholder={readOnly ? undefined : t("tpl.descPlaceholder")}
              onChange={(e) => patch({ description: e.target.value })}
            />
          </span>
        </label>
      </section>

      <div className="tp-body" ref={bodyRef}>
        <aside className="panel tp-rail" ref={railRef} aria-label={t("tpl.phases")}>
          <div className="tp-rail-h">{t("tpl.phases")}</div>
          <ol className="tp-phs">
            {draft.phases.map((p, i) => {
              const key = keys[i];
              const on = i === selIndex;
              const blank = p.title.trim() === "";
              const bad = key === badKey;
              return (
                <li
                  key={key}
                  data-key={key}
                  className={`tp-it${on ? " on" : ""}${blank ? " blank" : ""}${bad ? " bad" : ""}`}
                >
                  <div className="tp-st">
                    <i className="tp-stn" />
                    <button
                      className="tp-ph"
                      aria-current={on ? "step" : undefined}
                      onClick={() => select(key)}
                    >
                      <i className="tp-ph-lt" />
                      <span className="tp-tn">
                        <Scramble value={pad(i)} durationMs={440} />
                      </span>
                      <b>{blank ? t("tpl.untitledPhase") : p.title}</b>
                      {bad && (
                        <span className="tp-warn" aria-hidden="true">
                          <IconWarn size={13} />
                        </span>
                      )}
                    </button>
                    {!readOnly && (
                      <span className="tp-ph-acts">
                        <button
                          className="btn btn-ghost btn-icon"
                          disabled={i === 0}
                          title={t("tpl.moveUp")}
                          aria-label={t("tpl.moveUp")}
                          onClick={() => movePhase(i, -1)}
                        >
                          ↑
                        </button>
                        <button
                          className="btn btn-ghost btn-icon"
                          disabled={i === n - 1}
                          title={t("tpl.moveDown")}
                          aria-label={t("tpl.moveDown")}
                          onClick={() => movePhase(i, 1)}
                        >
                          ↓
                        </button>
                        <button
                          className="btn btn-ghost btn-icon"
                          disabled={n === 1}
                          title={t("tpl.removePhase")}
                          aria-label={t("tpl.removePhase")}
                          onClick={() => void removePhase(i)}
                        >
                          <IconX size={12} />
                        </button>
                      </span>
                    )}
                  </div>
                  <div className="tp-seg">
                    <span className="tp-seg-mks">
                      {p.exitGates.map((g, gi) => (
                        <GateMark
                          key={gi}
                          kind={g.kind}
                          className={dropGate?.key === key && dropGate.gi === gi ? "pop" : undefined}
                        />
                      ))}
                    </span>
                    {p.exitGates.length > 0 && (
                      <span className="tp-seg-n">
                        {countBefore}
                        <span className="tp-seg-num">
                          <Scramble value={p.exitGates.length} durationMs={520} />
                        </span>
                        {countAfter}
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
          <i className="tp-rail-lt" aria-hidden="true" ref={ltRef} />
          {!readOnly && (
            <button className="btn btn-ghost btn-small tp-add-ph" onClick={addPhase}>
              <IconPlus size={13} /> {t("tpl.addPhase")}
            </button>
          )}
        </aside>

        <section className="panel tp-detail" ref={detailRef} aria-label={phase.title.trim() || t("tpl.untitledPhase")}>
          <div className="tp-dt" ref={dtRef}>
            <div className="tp-two">
              <label className="tp-f">
                <span className="tp-l">{t("tpl.phaseTitle")}</span>
                <span className="tp-in">
                  <input
                    value={phase.title}
                    disabled={readOnly}
                    onChange={(e) => patchPhase(viewIndex, { title: e.target.value })}
                  />
                </span>
              </label>
              <label className="tp-f">
                <span className="tp-l">{t("tpl.phaseId")}</span>
                <span className="tp-in">
                  <input
                    className="tp-mono"
                    value={phase.id}
                    disabled={readOnly}
                    onChange={(e) => patchPhase(viewIndex, { id: e.target.value })}
                  />
                </span>
                {!readOnly && (
                  <span className={`tp-sub${phaseIdDup ? " bad" : ""}`}>
                    {phaseIdDup ? t("tpl.phaseIdDup") : t("tpl.phaseIdHint")}
                  </span>
                )}
              </label>
            </div>
            <label className="tp-f">
              <span className="tp-l">{t("tpl.phaseDesc")}</span>
              <span className="tp-in">
                <input
                  value={phase.description}
                  disabled={readOnly}
                  onChange={(e) => patchPhase(viewIndex, { description: e.target.value })}
                />
              </span>
            </label>
            <label className="tp-f">
              <span className="tp-l">{t("tpl.aiInstructions")}</span>
              <span className="tp-in">
                <textarea
                  ref={aiRef}
                  rows={4}
                  value={phase.aiInstructions.join("\n")}
                  disabled={readOnly}
                  placeholder={readOnly ? undefined : t("tpl.aiInstructionsHint")}
                  onChange={(e) => patchPhase(viewIndex, { aiInstructions: e.target.value.split("\n") })}
                />
              </span>
            </label>

            <div className="tp-gates">
              <div className="tp-gates-h">
                <span className="tp-l">{t("tpl.gates")}</span>
                <span className="tp-sub">{t("tpl.gatesHint")}</span>
              </div>
              <div className="tp-gbody">
                {phase.exitGates.length === 0 && !pickingGate && (
                  <div className="tp-gempty">
                    <DashText text={t("tpl.gatesEmpty")} />
                  </div>
                )}
                {phase.exitGates.length > 0 && (
                  <div className="tp-gl">
                    {phase.exitGates.map((g, gi) => (
                      <div
                        className={`tp-gate${dropGate?.key === viewKey && dropGate.gi === gi ? " drop" : ""}`}
                        key={gi}
                        data-gate={gi}
                      >
                        <div className="tp-gate-h">
                          <GateMark kind={g.kind} />
                          <b>{t(`tpl.gateKinds.${g.kind}`)}</b>
                          {!readOnly && (
                            <button
                              className="btn btn-ghost btn-icon"
                              title={t("tpl.removeGate")}
                              aria-label={t("tpl.removeGate")}
                              onClick={() => void removeGate(gi)}
                            >
                              <IconX size={12} />
                            </button>
                          )}
                        </div>
                        <div className="tp-gate-d">{t(`tpl.gateDesc.${g.kind}`)}</div>
                        {(g.kind === "min_tasks" || g.kind === "min_decisions") && (
                          <label className="tp-f tp-gp">
                            <span className="tp-l">{t("tpl.gateCount")}</span>
                            <span className="tp-in mini">
                              <input
                                type="number"
                                min={1}
                                value={g.count}
                                disabled={readOnly}
                                onChange={(e) =>
                                  patchGate(viewIndex, gi, {
                                    ...g,
                                    count: Math.max(1, Math.floor(Number(e.target.value) || 1)),
                                  })
                                }
                              />
                            </span>
                          </label>
                        )}
                        {g.kind === "artifact_exists" && (
                          <label className="tp-f tp-gp">
                            <span className="tp-l">{t("tpl.gatePath")}</span>
                            <span className="tp-in">
                              <input
                                className="tp-mono"
                                value={g.path}
                                disabled={readOnly}
                                placeholder="artifacts/report.md"
                                onChange={(e) => patchGate(viewIndex, gi, { ...g, path: e.target.value })}
                              />
                            </span>
                          </label>
                        )}
                        {g.kind === "manual_confirm" && (
                          <label className="tp-f tp-gp">
                            <span className="tp-l">{t("tpl.gatePrompt")}</span>
                            <span className="tp-in">
                              <input
                                value={g.prompt}
                                disabled={readOnly}
                                placeholder={readOnly ? undefined : t("tpl.gatePromptPlaceholder")}
                                onChange={(e) => patchGate(viewIndex, gi, { ...g, prompt: e.target.value })}
                              />
                            </span>
                          </label>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {!readOnly && !pickingGate && (
                  <div className="tp-addg">
                    <button className={`btn btn-ghost btn-small${addBack ? " tp-back-in" : ""}`} onClick={openPick}>
                      <IconPlus size={13} /> {t("tpl.addGate")}
                    </button>
                  </div>
                )}
                {!readOnly && pickingGate && (
                  <div className="tp-pick">
                    <div className="tp-gates-h">
                      <span className="tp-l">{t("tpl.gatePickTitle")}</span>
                      <button className="btn btn-ghost btn-small" onClick={closePick}>
                        {t("common.cancel")}
                      </button>
                    </div>
                    <div className="tp-pick-g">
                      {GATE_KINDS.map((kind, j) => (
                        <button
                          key={kind}
                          className="tp-pk"
                          style={{ ["--j" as string]: j }}
                          onClick={() => pickGate(kind)}
                        >
                          <GateMark kind={kind} />
                          <span>
                            <b>
                              {t(`tpl.gateKinds.${kind}`)} <IconArrowRight size={12} />
                            </b>
                            <small>{t(`tpl.gateDesc.${kind}`)}</small>
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </section>
        <i className="tp-link" aria-hidden="true" ref={linkRef} />
      </div>

      {/* D171 ⑧: the template's other way to run. Empty = staged only; an
          emptied field drops the list so the draft matches a template that
          never had one. */}
      <section className="panel tp-ongoing">
        <label className="tp-f">
          <span className="tp-l">{t("tpl.ongoing")}</span>
          <span className="tp-in">
            <textarea
              ref={ongoingRef}
              rows={4}
              value={ongoingText}
              disabled={readOnly}
              placeholder={readOnly ? undefined : t("tpl.ongoingPlaceholder")}
              onChange={(e) =>
                patch({ ongoingInstructions: e.target.value === "" ? undefined : e.target.value.split("\n") })
              }
            />
          </span>
          <span className="tp-sub">
            {!readOnly
              ? t("tpl.ongoingHint")
              : ongoingText === ""
                ? t("tpl.ongoingNone")
                : t("tpl.ongoingViewHint")}
          </span>
        </label>
      </section>

      {confirmDiscard && (
        <ConfirmDanger
          heading={t("tpl.discardHeading")}
          body={t("tpl.discardBody")}
          confirmLabel={t("tpl.discardAction")}
          cancelLabel={t("tpl.keepEditing")}
          onConfirm={() => {
            setConfirmDiscard(false);
            onClose();
          }}
          onCancel={() => setConfirmDiscard(false)}
        />
      )}
    </div>
  );
}
