import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import adminRouter from "./admin";
import artifactsRouter from "./artifacts";
import dropsRouter from "./drops";
import agentsRouter from "./agents";
import harvesterRouter from "./harvester";
import storefrontRouter from "./storefront";
import dashboardRouter from "./dashboard";
import shareRouter from "./share";
import webhooksRouter from "./webhooks";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(adminRouter);
router.use(artifactsRouter);
router.use(dropsRouter);
router.use(agentsRouter);
router.use(harvesterRouter);
router.use(storefrontRouter);
router.use(dashboardRouter);
router.use(shareRouter);
router.use(webhooksRouter);

export default router;
