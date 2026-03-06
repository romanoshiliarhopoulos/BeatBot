import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "./index.css";
import App from "./App.tsx";
import { AuthProvider } from "./contexts/AuthContext";
import { FolderProvider } from "./contexts/FolderContext";
import { MixProvider } from "./contexts/MixContext";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 60_000 } },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <FolderProvider>
          <MixProvider>
            <App />
          </MixProvider>
        </FolderProvider>
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
);
