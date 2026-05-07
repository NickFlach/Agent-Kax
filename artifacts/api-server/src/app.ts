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
app.use(cors({ credentials: true, origin: true }));
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
