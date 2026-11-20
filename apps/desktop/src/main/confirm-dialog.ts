/**
 * Owner confirmations in the desktop app (ADR-018). They are native dialogs shown by the main
 * process, never by the renderer: the renderer displays model output, so it is not trusted to say
 * "yes". Destructive actions get a second dialog whose default button is "Cancelar".
 */
import type { PermissionRequest } from "@jarvis/shared";

export interface DialogStep {
  title: string;
  message: string;
  detail: string;
  buttons: [string, string]; // [approve, cancel]
}

/** Native message boxes are not scrollable: keep the preview readable. */
export const MAX_DETAIL_LINES = 40;
export const MAX_DETAIL_CHARS = 3_000;

export function clampDetail(detail: string): string {
  let lines = detail.split("\n");
  let cut = false;
  if (lines.length > MAX_DETAIL_LINES) {
    lines = lines.slice(0, MAX_DETAIL_LINES);
    cut = true;
  }
  let text = lines.join("\n");
  if (text.length > MAX_DETAIL_CHARS) {
    text = text.slice(0, MAX_DETAIL_CHARS);
    cut = true;
  }
  return cut ? `${text}\n[… la vista sigue: el cambio completo es más largo]` : text;
}

const RISK_LABEL: Record<PermissionRequest["risk"], string> = {
  read: "Lectura",
  prepare: "Preparación",
  confirm: "Acción con confirmación",
  destructive: "Acción destructiva",
  forbidden: "Acción prohibida",
};

export function dialogSteps(req: PermissionRequest): DialogStep[] {
  const first: DialogStep = {
    title: "Jarvis pide permiso",
    message: req.title,
    detail: `${RISK_LABEL[req.risk]} · ${req.server} → ${req.tool}\n\n${clampDetail(req.detail)}`,
    buttons: req.confirmations === 2 ? ["Continuar", "Cancelar"] : ["Permitir", "Rechazar"],
  };
  if (req.confirmations === 1) return [first];
  return [
    first,
    {
      title: "Confirmá de nuevo",
      message: `¿Seguro? ${req.title}`,
      detail: "Esto no se puede deshacer desde Jarvis.",
      buttons: ["Sí, hacerlo", "Cancelar"],
    },
  ];
}
