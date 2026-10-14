import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import App from "./App";
import "./styles.css";

const configured = import.meta.env.VITE_CONVEX_URL;
if (!configured) {
  throw new Error("Нет VITE_CONVEX_URL. Запустите npx convex dev.");
}

const convexUrl = new URL(configured);
const pageHost = window.location.hostname;
if (pageHost !== "localhost" && pageHost !== "127.0.0.1") {
  convexUrl.hostname = pageHost;
}
const address = convexUrl.toString().replace(/\/$/, "");

const convex = new ConvexReactClient(address);
const root = document.getElementById("root");
if (!root) throw new Error("Нет #root");

createRoot(root).render(
  <StrictMode>
    <ConvexProvider client={convex}>
      <App />
    </ConvexProvider>
  </StrictMode>,
);
