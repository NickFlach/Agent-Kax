import { Router, type IRouter } from "express";
import healthRouter from "./health";
import artifactsRouter from "./artifacts";
import dropsRouter from "./drops";
import harvesterRouter from "./harvester";
import storefrontRouter from "./storefront";
import dashboardRouter from "./dashboard";
import shareRouter from "./share";

const router: IRouter = Router();

router.use(healthRouter);
router.use(artifactsRouter);
router.use(dropsRouter);
router.use(harvesterRouter);
router.use(storefrontRouter);
router.use(dashboardRouter);
router.use(shareRouter);

export default router;
