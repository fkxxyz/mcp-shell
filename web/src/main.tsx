import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ActivityProvider } from "./features/activity/ActivityProvider";
import { queryClient } from "./app/query-client";
import { router } from "./app/router";
import "./styles/tokens.css";
import "./styles/globals.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ActivityProvider>
        <RouterProvider router={router} />
      </ActivityProvider>
    </QueryClientProvider>
  </StrictMode>,
);
