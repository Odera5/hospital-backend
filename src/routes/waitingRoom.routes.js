import express from "express";
import { verifyToken } from "../middleware/verifyToken.js";
import { enforceSubscriptionState } from "../middleware/subscriptionStateGuard.js";
import {
  getWaitingList,
  getWaitingSummary,
  createWaitingEntry,
  updateWaitingEntry,
  deleteWaitingEntry,
} from "../controllers/waitingRoomController.js";

const router = express.Router();
router.use(verifyToken);
router.use(enforceSubscriptionState({ allowAdminReadOnly: true }));

router.get("/summary", getWaitingSummary);
router.get("/", getWaitingList);
router.post("/", createWaitingEntry);
router.put("/:id", updateWaitingEntry);
router.delete("/:id", deleteWaitingEntry);

export default router;
