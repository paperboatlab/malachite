// Malachite's page: the kit's styles, then the app's own (client/app.css), then the app.
import "@paperboatlab/ui/tokens.css";
import "@paperboatlab/ui/ui.css";
import "./app.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";

document.documentElement.dataset.app = "malachite";
createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
