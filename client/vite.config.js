import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The built dashboard lives at /app/ (the public home page is at /).
// While developing (npm run dev on :5173) it stays at the root as before.
export default defineConfig(({ command }) => ({
  plugins: [react()],
  base: command === "build" ? "/app/" : "/",
  server: { port: 5173 }
}));
