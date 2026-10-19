import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";

/** Engine and types hold the live game store. A hot swap leaves the old store
 *  running beside the new one, so the map and the panel disagree. Reload instead. */
function reloadEngine(): Plugin {
  return {
    name: "reload-engine",
    apply: "serve",
    handleHotUpdate(ctx) {
      const file = ctx.file.replace(/\\/g, "/");
      if (!file.includes("/src/engine/") && !file.includes("/src/types/")) return;
      ctx.server.ws.send({ type: "full-reload" });
      return [];
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  server: {
    host: "::",
    port: 3000,
  },
  plugins: [react(), mode === "development" && componentTagger(), reloadEngine()].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
}));
