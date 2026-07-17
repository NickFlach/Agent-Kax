import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import { z } from "zod";
import router from "./routes";
import { logger } from "./lib/logger";
import { authMiddleware } from "./middlewares/authMiddleware";

const app: Express = express();

// Behind the Replit shared proxy: trust the first X-Forwarded-For hop
// so req.ip reflects the real client. Without this every visitor
// shares the proxy's address and per-IP rate limiting (auth-email.ts)
// would throttle everyone together.
app.set("trust proxy", 1);

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
  // Constellation dashboards read identity-scoped endpoints (e.g. the
  // observatory wallet card calling GET /api/ledger/my with a Bearer token).
  "https://observatory.ninja-portal.com",
  "https://radio.ninja-portal.com",
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

// Global error handler. Express 5 forwards async route rejections here, so
// route handlers no longer need ad-hoc try/catch to avoid hanging sockets.
// Zod validation failures collapse to a single 400 with a field-level path
// so the client doesn't see a generic 500.
app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  if (res.headersSent) {
    return;
  }
  if (err instanceof z.ZodError) {
    const issues = err.issues.map((i) => ({
      path: i.path.join("."),
      message: i.message,
    }));
    res.status(400).json({ error: "Invalid request", issues });
    return;
  }
  req.log.error({ err }, "Unhandled route error");
  res.status(500).json({ error: "Internal server error" });
});

export default app;
