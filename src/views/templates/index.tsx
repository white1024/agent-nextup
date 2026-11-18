import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useTranslation } from "react-i18next";

import { api, errorMessage } from "../../api";
import ConfirmDanger from "../../components/ConfirmDanger";
import EmptyState from "../../components/EmptyState";
import ErrorBar from "../../components/ErrorBar";
import FlashBar from "../../components/FlashBar";
import { IconPlus, IconX } from "../../components/icons";
import { useFlash } from "../../hooks";
import { shortTemplateDescription } from "../../lib/format";
import { motionOff } from "../../lib/fx";
import type { TemplateSummary, WorkflowTemplate } from "../../types";
import TemplateEditor, { type EditorMode } from "./Editor";
import {
  bandOff,
  bandRun,
  cardSpots,
  closeEditorFx,
  openEditorFx,
  slideCards,
  transitionBusy,
} from "./motion";
import TemplateBand, { DashText } from "./TemplateBand";

interface EditorSession {
  mode: EditorMode;
  template: WorkflowTemplate;
  /** The card it opened from — where it closes back into; `null` for "New
   *  template". A copy keeps its source's. */
  from: string | null;
  /** Bumps with every session. It keys the editor, so "New from this" mounts a
   *  fresh one: the draft is read once on mount, and the old unkeyed editor
   *  kept the built-in's draft (no "(copy)", the built-in id) after the swap. */
  seq: number;
  /** "New from this" plays C149 on the fresh editor. */
  entering?: "copy";
}

const mainEl = () => document.querySelector<HTMLElement>("main.content");

/**
 * Machine-level template catalog as an app view (D51 — promoted out of
 * Settings): every template as a card; opening one lands in the full-page
 * editor (read-only for built-ins). Writes still go through core
 * (`save_custom_template`), which owns validation and the built-in-id
 * rejection.
 *
 * D153 (spec 60): each card carries its phases as a band (C140, a light walks
 * one card at a time), and a card grows into the editor and back (C141).
 */
export default function TemplatesHome() {
  const { t } = useTranslation();
  // `null` until the first read resolves (D65) — the built-ins make a truly
  // empty catalog near-impossible, so what this really prevents is the blank
  // card grid that flashed on every entry to the view.
  const [templates, setTemplates] = useState<TemplateSummary[] | null>(null);
  const [session, setSession] = useState<EditorSession | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<TemplateSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The cards rise in with the page only the first time; coming back from the
  // editor is C141's job, and a second entrance would fight it.
  const [enter, setEnter] = useState(true);
  const { flash, showFlash } = useFlash(3000);
  const seq = useRef(0);
  const grid = useRef<HTMLUListElement>(null);
  const opening = useRef(false);
  const dialogOpen = useRef(false);
  dialogOpen.current = confirmDelete !== null;

  const reload = useCallback(async () => {
    try {
      setTemplates(await api.listTemplates());
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // C140 (R2): one card at a time walks its band; the first 1.2 s after the
  // list is up, then each after the last one finished plus 1.1 s. Waits while
  // a transition or a dialog is on screen. Reduced motion: none.
  const listUp = session === null && templates !== null && templates.length > 0;
  useEffect(() => {
    if (!listUp || motionOff()) return;
    let timer = 0;
    let i = 0;
    const tick = () => {
      if (transitionBusy() || dialogOpen.current) {
        timer = window.setTimeout(tick, 1200);
        return;
      }
      const cards = [...(grid.current?.querySelectorAll(":scope > [data-tpl]") ?? [])];
      if (cards.length === 0) return;
      const ms = bandRun(cards[i % cards.length]);
      i += 1;
      timer = window.setTimeout(tick, ms + 1100);
    };
    timer = window.setTimeout(tick, 1200);
    return () => window.clearTimeout(timer);
  }, [listUp, templates]);

  const cardOf = (id: string | null) =>
    id === null ? null : (grid.current?.querySelector<HTMLElement>(`[data-tpl="${CSS.escape(id)}"]`) ?? null);

  function blankTemplate(): WorkflowTemplate {
    return {
      id: "",
      name: "",
      description: "",
      domainHint: "",
      phases: [{ id: "phase-1", title: "", description: "", aiInstructions: [], exitGates: [] }],
    };
  }

  // The body is read before anything moves: the frame grows into an editor
  // that has its content (invariant 10), and a failed read grows nothing.
  async function openCard(tpl: TemplateSummary, card: HTMLElement | null) {
    if (opening.current || transitionBusy()) return;
    opening.current = true;
    setError(null);
    try {
      const body = await api.getTemplate(tpl.id);
      openEditorFx({
        main: mainEl(),
        source: card,
        swap: () =>
          flushSync(() =>
            setSession({
              mode: tpl.source === "built_in" ? "view" : "edit",
              template: body,
              from: tpl.id,
              seq: ++seq.current,
            }),
          ),
      });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      opening.current = false;
    }
  }

  function openBlank() {
    if (transitionBusy()) return;
    setError(null);
    openEditorFx({
      main: mainEl(),
      source: null,
      swap: () =>
        flushSync(() =>
          setSession({ mode: "create", template: blankTemplate(), from: null, seq: ++seq.current }),
        ),
    });
  }

  /**
   * Back to the list (C141 backwards), or — with `saved` — the end of C147:
   * the editor closes into the saved template's card. A new template first
   * renders the list without itself, so the other cards can be seen sliding
   * aside to make room.
   */
  function closeEditor(saved?: { list: TemplateSummary[]; id: string }) {
    const s = session;
    if (s === null) return;
    const known = (id: string | null) => id !== null && (templates ?? []).some((x) => x.id === id);
    const target = saved?.id ?? s.from;
    const isNew = saved !== undefined && !known(saved.id);
    setEnter(false);
    void closeEditorFx({
      main: mainEl(),
      sink: saved === undefined && !known(s.from),
      target: () => cardOf(target),
      swap: () => {
        let before: Map<string, { x: number; y: number }> | null = null;
        if (isNew && templates !== null) {
          flushSync(() => setSession(null));
          before = cardSpots(grid.current);
        }
        flushSync(() => {
          setSession(null);
          if (saved !== undefined) setTemplates(saved.list);
        });
        return before;
      },
    }).then(() => {
      if (saved === undefined) return;
      showFlash(t("tpl.saved"));
      bandRun(cardOf(saved.id));
    });
  }

  // C151: the dialog sinks, the card's band goes dark from its last cell,
  // the card fades, and the rest slide up into its place.
  async function removeTemplate() {
    const victim = confirmDelete;
    if (victim === null) return;
    setError(null);
    setDeleting(true);
    try {
      const list = await api.deleteCustomTemplate(victim.id);
      const card = cardOf(victim.id);
      setConfirmDelete(null);
      setDeleting(false);
      await bandOff(card);
      const before = cardSpots(grid.current);
      flushSync(() => setTemplates(list));
      slideCards(grid.current, before);
      showFlash(t("tpl.deleted"));
    } catch (e) {
      setError(errorMessage(e));
      setDeleting(false);
    }
  }

  if (session !== null) {
    return (
      <TemplateEditor
        key={session.seq}
        mode={session.mode}
        template={session.template}
        entering={session.entering}
        existingIds={(templates ?? []).map((tpl) => tpl.id)}
        onSaved={(list, id) => closeEditor({ list, id })}
        onClose={() => closeEditor()}
        onCopy={(base) =>
          setSession({
            mode: "create",
            template: { ...base, id: "", name: `${base.name}${t("tpl.copySuffix")}` },
            from: session.from,
            seq: ++seq.current,
            entering: "copy",
          })
        }
      />
    );
  }

  return (
    <div className={`view tp tp-list${enter ? " enter" : " tp-quiet"}`}>
      <header className="view-header">
        <div className="vh-main">
          <h1>{t("tpl.heading")}</h1>
          <p className="view-sub">{t("tpl.subtitle")}</p>
        </div>
        <div className="header-actions">
          <button className="btn btn-primary" onClick={openBlank}>
            <IconPlus size={14} /> {t("tpl.newBlank")}
          </button>
        </div>
      </header>

      <ErrorBar error={confirmDelete === null ? error : null} />
      <FlashBar message={flash} />

      {templates !== null && templates.length === 0 && (
        <section className="panel tp-empty">
          <span className="tp-empty-track" aria-hidden="true">
            <i />
            <i />
          </span>
          <EmptyState title={t("tpl.empty")} hint={t("tpl.emptyHint")} className="tp-empty-t" />
        </section>
      )}

      {templates !== null && templates.length > 0 && (
        <>
          {/* Describes the list below, not the page (D89). */}
          <p className="section-hint tp-hint">
            <DashText text={t("tpl.listHint")} />
          </p>
          <ul
            className="tp-grid"
            ref={grid}
            onPointerOver={(e) => {
              if (transitionBusy()) return;
              const c = (e.target as Element).closest("[data-tpl]");
              if (c !== null && !c.contains(e.relatedTarget as Node | null)) bandRun(c);
            }}
          >
            {templates.map((tpl, j) => (
              <li key={tpl.id} className="tp-card panel" data-tpl={tpl.id} style={{ ["--j" as string]: j }}>
                <button
                  className="tp-card-open"
                  title={tpl.name}
                  onClick={(e) => void openCard(tpl, e.currentTarget.closest("li"))}
                >
                  <span className="tp-card-h">
                    <b>{tpl.name}</b>
                    <span className="chip">{tpl.source === "custom" ? t("tpl.custom") : t("tpl.builtIn")}</span>
                  </span>
                  {/* The phase chain is the band above; what is left of the description
                      leaves the id room (F30). The tooltip keeps the whole sentence. */}
                  <span className="tp-card-m" title={tpl.description || undefined}>
                    {shortTemplateDescription(tpl.description)}
                    {shortTemplateDescription(tpl.description) !== "" && " · "}
                    <code>{tpl.id}</code>
                  </span>
                  <TemplateBand phases={tpl.phases} />
                </button>
                {tpl.source === "custom" && (
                  <button
                    className="btn btn-ghost btn-icon tp-card-x danger-trigger"
                    title={t("tpl.deleteHeading")}
                    aria-label={t("tpl.deleteAria", { name: tpl.name })}
                    onClick={() => {
                      setError(null);
                      setConfirmDelete(tpl);
                    }}
                  >
                    <IconX size={13} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      {confirmDelete !== null && (
        <ConfirmDanger
          heading={t("tpl.deleteHeading")}
          body={t("tpl.deleteBody", { name: confirmDelete.name })}
          confirmLabel={t("common.delete")}
          busy={deleting}
          error={error}
          onConfirm={() => void removeTemplate()}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}
