import { describe, expect, it } from "vitest";
import { parseRendererMessage, WhatsAppRequest } from "./bridge.js";
import { qrPage, whatsappDialog } from "./whatsapp-qr.js";

describe("whatsapp in the desktop app (ADR-029)", () => {
  it("the renderer may read the status but never link or unlink by itself", () => {
    expect(parseRendererMessage({ type: "whatsapp.get", id: "1" })?.type).toBe("whatsapp.get");
    expect(parseRendererMessage({ type: "whatsapp.link", id: "1" })).toBeUndefined();
    expect(parseRendererMessage({ type: "whatsapp.unlink", id: "1" })).toBeUndefined();
    expect(WhatsAppRequest.safeParse("link").success).toBe(true);
    expect(WhatsAppRequest.safeParse("send").success).toBe(false);
  });

  it("the QR page carries the code as an SVG only, under a CSP with no scripts", () => {
    const html = qrPage('2@abc<script>alert(1)</script>,xyz');
    expect(html).toContain("default-src 'none'");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("alert(1)");
    expect(html).toContain("<svg");
  });

  it("the link dialog states the risks; Cancel is the second button", () => {
    const d = whatsappDialog("link");
    expect(d.detail).toMatch(/Mensaje a mí mismo/);
    expect(d.detail).toMatch(/no oficial/);
    expect(d.detail).toMatch(/en esta PC/);
    expect(d.buttons[1]).toBe("Cancelar");
    expect(whatsappDialog("unlink").buttons).toEqual(["Desvincular", "Cancelar"]);
  });
});
