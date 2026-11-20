import type { PermissionRequest } from "@jarvis/shared";
import { describe, expect, it } from "vitest";
import { MAX_DETAIL_LINES, clampDetail, dialogSteps } from "./confirm-dialog.js";

const req = (over: Partial<PermissionRequest> = {}): PermissionRequest => ({
  type: "permission.request",
  requestId: "r1",
  server: "projects",
  tool: "write_file",
  risk: "confirm",
  title: "Escribir notas/a.md",
  detail: "+ hola",
  confirmations: 1,
  expiresAt: "2026-11-20T10:02:00Z",
  ...over,
});

describe("confirmation dialogs", () => {
  it("asks once for confirm-class actions, showing the Core's preview", () => {
    const steps = dialogSteps(req());
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ message: "Escribir notas/a.md", buttons: ["Permitir", "Rechazar"] });
    expect(steps[0]?.detail).toContain("projects → write_file");
    expect(steps[0]?.detail).toContain("+ hola");
  });

  it("asks twice for destructive actions", () => {
    const steps = dialogSteps(req({ risk: "destructive", confirmations: 2, title: "Borrar notas/a.md" }));
    expect(steps.map((s) => s.buttons[0])).toEqual(["Continuar", "Sí, hacerlo"]);
    expect(steps[1]?.message).toBe("¿Seguro? Borrar notas/a.md");
  });

  it("clamps long previews", () => {
    const long = Array.from({ length: 100 }, (_, i) => `+ línea ${i}`).join("\n");
    const out = clampDetail(long);
    expect(out.split("\n")).toHaveLength(MAX_DETAIL_LINES + 1);
    expect(out).toMatch(/la vista sigue/);
    expect(clampDetail("x".repeat(5_000)).length).toBeLessThan(3_100);
  });
});
