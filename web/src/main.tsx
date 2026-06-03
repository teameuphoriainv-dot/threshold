import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { SpacetimeDBProvider } from "spacetimedb/react";
import { connectionBuilder } from "./spacetime";
import { Game } from "./Game";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SpacetimeDBProvider connectionBuilder={connectionBuilder()}>
      <Game />
    </SpacetimeDBProvider>
  </StrictMode>
);
