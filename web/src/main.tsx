import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { loadRuntime } from "./config";
import App from "./App";
import "./styles.css";
const root = createRoot(document.getElementById("root")!);
root.render(
  <main className="boot">
    <h1>taskboard</h1>
    <p role="status">Loading verified deployment…</p>
  </main>,
);
loadRuntime()
  .then((runtime) =>
    root.render(
      <StrictMode>
        <App runtime={runtime} />
      </StrictMode>,
    ),
  )
  .catch((e) =>
    root.render(
      <main className="boot">
        <h1>Unable to load Taskboard</h1>
        <p role="alert">{e.message}</p>
        <button onClick={() => location.reload()}>Reload deployment</button>
      </main>,
    ),
  );
