import { describe, expect, it } from "vitest";

// `?raw` for the same reason boot.test.ts reads index.html that way: both
// facts below are wiring, not a module. One is a callback handed to a
// component, the other a `key` on a JSX block — there is nothing a unit test
// can call, so they are held to the source that states them.
import app from "./App.tsx?raw";

describe("changing project keeps the page", () => {
  it("re-homes you only when the action was entering or leaving a project", () => {
    // The shape this replaced: `setView(s.workspace ? "dashboard" : "projects")`
    // on every status change. Open, create, switch and close all funnel
    // through applyStatus, and the result cannot tell them apart — a switch
    // ends with a workspace open exactly like an arrival does. So switching
    // from A's task list to B threw you to B's dashboard, and the way back to
    // the list you were reading was a second click every time.
    const body = /const applyStatus = useCallback\(([\s\S]*?)\n  \}, \[\]\);/.exec(app)?.[1];
    expect(body, "applyStatus is gone or was reshaped").toBeDefined();
    // Guarded, and guarded on the entry case specifically. Inverted, the two
    // landings swap: switching would go to the dashboard and actually opening
    // a project would leave you on whatever page the last one was showing.
    const guard = /if \(action === "(\w+)"\) setView\(/.exec(body ?? "");
    expect(guard, "applyStatus moves the view unconditionally again").not.toBeNull();
    expect(guard?.[1]).toBe("enter");
  });

  it("has the switcher report a switch and the projects home an entry", () => {
    // One funnel, two callers, opposite answers — and each is one token away
    // from the other. Hand the switcher the default and this whole change is
    // undone with nothing failing anywhere; hand the projects home the switch
    // landing and clicking a project card leaves you on the list you clicked
    // it from, with only the sidebar name to say anything happened.
    expect(app, "the sidebar switcher is back on the entry landing").toContain(
      "onSwitched={applySwitched}",
    );
    expect(app, "opening a project from the home no longer enters it").toContain(
      "onLoaded={applyStatus}",
    );
    expect(app).toMatch(
      /applySwitched = useCallback\(\s*\(s: SystemStatus\) => applyStatus\(s, "switch"\)/,
    );
  });
});

describe("a workspace view cannot outlive its project", () => {
  it("renders every workspace-scoped view inside a block keyed by the root", () => {
    // Keeping the page across a switch is what made this load-bearing. While
    // every switch landed on the dashboard, the view you had been on was
    // unmounted on the way and its state went with it. Now it stays mounted,
    // and these views hold more than a stale list: Specs holds the selected
    // spec's id *and its rendered body*, Inbox the opened envelope, Tools the
    // last doctor report. Unkeyed, the page shows one project's content under
    // another project's name.
    const open = app.indexOf("{workspaceLoaded && (");
    expect(open, "the workspace view block is gone").toBeGreaterThanOrEqual(0);
    const close = app.indexOf("</Fragment>", open);
    expect(close, "the workspace view block is no longer a Fragment").toBeGreaterThan(open);
    expect(app.slice(open, close), "the workspace view block lost its root key").toContain(
      "<Fragment key={wsRoot",
    );

    // And the block has to hold all of them. The list comes from VIEW_SCOPE
    // rather than being restated here: that Record is complete by compiler
    // rule, so a workspace view added outside the keyed block fails this test
    // instead of quietly opting out of the guarantee (D63's lesson).
    const scope = /const VIEW_SCOPE: Record<View, "app" \| "workspace"> = \{([\s\S]*?)\n\};/.exec(
      app,
    )?.[1];
    expect(scope, "VIEW_SCOPE is gone or was reshaped").toBeDefined();
    const views = [...(scope ?? "").matchAll(/^\s*(\w+): "workspace",/gm)].map((m) => m[1]);
    // A scope block that stopped matching would pass an empty loop.
    expect(views.length, "read no workspace-scoped views out of VIEW_SCOPE").toBeGreaterThan(8);
    for (const view of views) {
      const at = app.indexOf(`{view === "${view}" &&`);
      expect(at, `no render site for the ${view} view`).toBeGreaterThan(0);
      expect(at, `the ${view} view renders outside the keyed block`).toBeGreaterThan(open);
      expect(at, `the ${view} view renders outside the keyed block`).toBeLessThan(close);
    }
  });
});
