import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "./index.css";
import App from "./App.tsx";
import { AuthProvider } from "./contexts/AuthContext";
import { FolderProvider } from "./contexts/FolderContext";
import { MixProvider } from "./contexts/MixContext";

// Clear performance measures in development mode to prevent Aw, Snap! crashes 
// from React DevTools tracking thousands of rapid UI updates (e.g., playhead animation)
if (import.meta.env.DEV) {
  setInterval(() => {
    performance.clearMarks();
    performance.clearMeasures();
  }, 10000); // Clears the performance timeline every 10 seconds
}

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
