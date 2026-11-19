import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { Overlay } from "./Overlay.js";
import "./styles.css";

// The same bundle serves the main window and the voice overlay (loaded with #overlay).
const isOverlay = window.location.hash === "#overlay";
if (isOverlay) document.documentElement.classList.add("is-overlay");

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(<StrictMode>{isOverlay ? <Overlay /> : <App />}</StrictMode>);
}
