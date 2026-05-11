import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import authWalletRouter from "./auth-wallet";
import authAgentRouter from "./auth-agent";
import adminRouter from "./admin";
import artifactsRouter from "./artifacts";
import dropsRouter from "./drops";
import agentsRouter from "./agents";
import agentStorefrontRouter from "./agent-storefront";
import harvesterRouter from "./harvester";
import storefrontRouter from "./storefront";
import dashboardRouter from "./dashboard";
import shareRouter from "./share";
import webhooksRouter from "./webhooks";
import partnerEventsRouter from "./partner-events";
import nftRouter from "./nft";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(authWalletRouter);
router.use(authAgentRouter);
router.use(adminRouter);
router.use(artifactsRouter);
router.use(dropsRouter);
router.use(agentsRouter);
router.use(agentStorefrontRouter);
router.use(harvesterRouter);
router.use(storefrontRouter);
router.use(dashboardRouter);
router.use(shareRouter);
router.use(webhooksRouter);
router.use(partnerEventsRouter);
router.use(nftRouter);

export default router;
