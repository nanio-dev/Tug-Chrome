import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../shared/styles.css";
import { ManagerApp } from "./ManagerApp";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ManagerApp initialView="overview" />
  </StrictMode>,
);
