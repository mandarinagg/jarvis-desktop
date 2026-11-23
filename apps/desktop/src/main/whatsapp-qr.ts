/**
 * Linking WhatsApp from the desktop app (ADR-029). The main process asks in a native dialog and
 * shows the QR in its own window: no preload, no JavaScript, a CSP that only allows the inline
 * SVG. The QR never reaches the renderer, which displays model output.
 */
import qrcode from "qrcode-generator";
import type { DialogStep } from "./confirm-dialog.js";

export function whatsappDialog(action: "link" | "unlink"): DialogStep {
  if (action === "unlink") {
    return {
      title: "Desvincular WhatsApp",
      message: "¿Desvincular a Jarvis de tu WhatsApp?",
      detail: "Se cierra la sesión en WhatsApp y se borra de esta PC. Para volver a usarlo hay que escanear un QR nuevo.",
      buttons: ["Desvincular", "Cancelar"],
    };
  }
  return {
    title: "Vincular WhatsApp",
    message: "¿Vincular Jarvis a tu WhatsApp?",
    detail: [
      "Jarvis queda como un dispositivo vinculado de tu cuenta, igual que WhatsApp Web.",
      "",
      "• Solo lee y responde tu chat «Mensaje a mí mismo». Los mensajes de los demás chats le llegan a la PC, pero se descartan sin guardarse.",
      "• Lo que pida confirmación se aprueba en esta PC, nunca desde el chat.",
      "• Usa un cliente no oficial (Baileys): WhatsApp podría restringir tu número.",
      "",
      "Después escaneá el QR desde WhatsApp → Dispositivos vinculados → Vincular un dispositivo.",
    ].join("\n"),
    buttons: ["Vincular", "Cancelar"],
  };
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The QR window's page. `qr` comes from WhatsApp through the Core: only encoded, never markup. */
export function qrPage(qr: string): string {
  const code = qrcode(0, "M");
  code.addData(qr);
  code.make();
  const svg = code.createSvgTag({ cellSize: 6, margin: 4, scalable: true });
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<title>Vincular WhatsApp</title>
<style>
  html,body{margin:0;background:#1a2230;color:#e8edf4;font:14px system-ui,sans-serif;text-align:center}
  main{padding:16px}
  .qr{background:#fff;border-radius:8px;padding:8px;width:280px;height:280px;margin:0 auto}
  .qr svg{width:100%;height:100%}
  p{margin:12px 8px;line-height:1.4}
  small{color:#9fb0c6}
</style></head>
<body><main>
  <div class="qr" role="img" aria-label="Código QR para vincular WhatsApp">${svg}</div>
  <p>WhatsApp → <b>Dispositivos vinculados</b> → <b>Vincular un dispositivo</b>, y escaneá este código.</p>
  <small>${escapeHtml("El código cambia cada pocos segundos. Esta ventana se cierra sola al vincular.")}</small>
</main></body></html>`;
}
