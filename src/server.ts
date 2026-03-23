import "dotenv/config";
import express from "express";
import path from "node:path";
import { articlesRouter } from "./routes/articles.routes.js";
import { webDescriptionRouter } from "./routes/webDescription.routes.js";

const app = express();
app.use(express.json({ limit: "2mb" }));
app.get("/", (_req, res) => {
  res.sendFile(path.resolve("public/dashboard.html"));
});
app.use(express.static("public"));

app.get("/health", (_req, res) => res.json({ ok: true }));
app.use("/api/articles", articlesRouter);
app.use("/api/web-description", webDescriptionRouter);
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = err instanceof Error ? err.message : "Unexpected server error";
  console.error(err);
  res.status(500).json({ error: message });
});

const port = Number(process.env.PORT || 3005);
app.listen(port, () => {
  console.log(`API running on :${port}`);
});
