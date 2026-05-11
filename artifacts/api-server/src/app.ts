import express, { type Express } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { authMiddleware } from "./middlewares/authMiddleware";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
// CORS — credentialed requests must come from a known allow-list.
// Previously this was `origin: true` which reflects ANY origin AND ships
// credentials, which is a textbook open-redirect / CSRF chain. Now we
// match against the KAX_CORS_ALLOWLIST env var (comma-separated) plus a
// few sensible defaults; unknown origins fall through to a no-cors
// response (the browser blocks them).
const corsAllowlistEnv = process.env["KAX_CORS_ALLOWLIST"] || "";
const corsAllowlist = new Set([
  ...corsAllowlistEnv.split(",").map((s) => s.trim()).filter(Boolean),
  "https://kax.ninja-portal.com",
  "https://openclawcity.ai",
  "http://localhost:3000",
  "http://localhost:5173",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:5173",
]);
app.use(
  cors({
    credentials: true,
    origin(origin, callback) {
      // Allow same-origin / curl / server-to-server (no Origin header).
      if (!origin) return callback(null, true);
      if (corsAllowlist.has(origin)) return callback(null, true);
      // Unknown origin — silently disallow credentials by returning false.
      // cors() will then omit Access-Control-Allow-Origin and the browser
      // blocks the request.
      return callback(null, false);
    },
  }),
);
app.use(cookieParser());
app.use((req, res, next) => {
  if (req.path.startsWith("/api/webhooks/")) {
    next();
    return;
  }
  express.json()(req, res, next);
});
app.use((req, res, next) => {
  if (req.path.startsWith("/api/webhooks/")) {
    next();
    return;
  }
  express.urlencoded({ extended: true })(req, res, next);
});
app.use(authMiddleware);

app.get(/^\/storefront(\/.*)?$/, (req, res) => {
  const rest = req.params[0] ?? "";
  const numericMatch = rest.match(/^\/(\d+)(\/?.*)$/);
  const target = numericMatch
    ? `/s/kannaka/drops/${numericMatch[1]}${numericMatch[2] ?? ""}`
    : `/s/kannaka${rest}`;
  res.redirect(301, target);
});

app.use("/api", router);

export default app;
