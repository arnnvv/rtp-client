import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { HlsComp } from "./Hls";
import { Switch, Route } from "wouter";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Root not found");
}

createRoot(rootElement).render(
  <StrictMode>
    <Switch>
      <Route path="/" component={App} />
      <Route path="/watch" component={HlsComp} />
    </Switch>
  </StrictMode>,
);
