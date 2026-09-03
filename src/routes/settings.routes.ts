import { Router } from "express";
import {
  getWarehouseSettings,
  updateWarehouseSettings,
  getShippingConfig,
  updateShippingConfig,
} from "../controllers/settings.controller";
import { authMiddleware } from "../middleware/auth.middleware";
import { adminOrStaff } from "../middleware/staffPermission.middleware";
import { validate } from "../middleware/validate.middleware";
import { updateWarehouseSettingsSchema, updateShippingConfigSchema } from "../schemas/settings.schema";

const router = Router();

// Warehouse location
router.get("/warehouse", authMiddleware, adminOrStaff("SETTINGS_VIEW"), getWarehouseSettings);
router.put("/warehouse", authMiddleware, adminOrStaff("SETTINGS_EDIT"), validate(updateWarehouseSettingsSchema), updateWarehouseSettings);

// Shipping rate configuration
router.get("/shipping-config", authMiddleware, adminOrStaff("SETTINGS_VIEW"), getShippingConfig);
router.put("/shipping-config", authMiddleware, adminOrStaff("SETTINGS_EDIT"), validate(updateShippingConfigSchema), updateShippingConfig);

export default router;
