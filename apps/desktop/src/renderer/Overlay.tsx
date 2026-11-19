import type { VoiceStateName } from "@jarvis/shared";
import { useEffect, useState } from "react";
import { VOICE_LABELS } from "./state.js";

/** Always-on-top voice indicator. The main process decides when this window is visible. */
export function Overlay() {
  const [voice, setVoice] = useState<{ state: VoiceStateName; micOpen: boolean }>({ state: "idle", micOpen: false });

  useEffect(
    () =>
      window.jarvis.onMessage((m) => {
        if (m.type === "voice.state") setVoice({ state: m.state, micOpen: m.micOpen });
      }),
    [],
  );

  return (
    <div className={`overlay ${voice.state}`} role="status" aria-live="polite">
      <span className={`mic ${voice.micOpen ? "open" : ""}`} aria-hidden="true" />
      <span className="overlay-label">{voice.micOpen ? "Micrófono abierto" : VOICE_LABELS[voice.state]}</span>
      <span className="bars" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
    </div>
  );
}
