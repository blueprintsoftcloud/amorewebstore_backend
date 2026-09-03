import { Request, Response } from "express";
import { AppSetting } from "../models/mongoose";
import logger from "../utils/logger";
import { createAuditLog } from "../utils/auditLog";
import { env } from "../config/env";

// Default warehouse coords (from .env / hard-coded fallback)
const DEFAULT_WAREHOUSE_LAT = parseFloat(env.WAREHOUSE_LAT) || 9.9312;
const DEFAULT_WAREHOUSE_LNG = parseFloat(env.WAREHOUSE_LNG) || 76.2673;

// ── GET /api/settings/warehouse  (admin / super-admin) ────────────────────────
export const getWarehouseSettings = async (req: Request, res: Response) => {
  try {
    const [latSetting, lngSetting, nameSetting] = await Promise.all([
      prisma.appSetting.findUnique({ where: { key: "WAREHOUSE_LAT" } }),
      prisma.appSetting.findUnique({ where: { key: "WAREHOUSE_LNG" } }),
      prisma.appSetting.findUnique({ where: { key: "WAREHOUSE_NAME" } }),
    ]);

    res.status(200).json({
      lat: latSetting ? parseFloat(latSetting.value) : DEFAULT_WAREHOUSE_LAT,
      lng: lngSetting ? parseFloat(lngSetting.value) : DEFAULT_WAREHOUSE_LNG,
      name: nameSetting?.value ?? "Main Warehouse",
    });
  } catch (err: any) {
    logger.error("getWarehouseSettings error", err);
    res.status(500).json({ message: "Failed to fetch warehouse settings" });
  }
};

// ── PUT /api/settings/warehouse  (super-admin only) ───────────────────────────
export const updateWarehouseSettings = async (req: Request, res: Response) => {
  try {
    const { lat, lng, name } = req.body as { lat?: number; lng?: number; name?: string };

    if (lat === undefined || lng === undefined) {
      return res.status(400).json({ message: "lat and lng are required" });
    }

    const latNum = parseFloat(String(lat));
    const lngNum = parseFloat(String(lng));

    if (isNaN(latNum) || latNum < -90 || latNum > 90) {
      return res.status(400).json({ message: "lat must be a number between -90 and 90" });
    }
    if (isNaN(lngNum) || lngNum < -180 || lngNum > 180) {
      return res.status(400).json({ message: "lng must be a number between -180 and 180" });
    }

    await Promise.all([
      prisma.appSetting.upsert({
        where: { key: "WAREHOUSE_LAT" },
        update: { value: String(latNum) },
        create: { key: "WAREHOUSE_LAT", value: String(latNum) },
      }),
      prisma.appSetting.upsert({
        where: { key: "WAREHOUSE_LNG" },
        update: { value: String(lngNum) },
        create: { key: "WAREHOUSE_LNG", value: String(lngNum) },
      }),
      name !== undefined
        ? prisma.appSetting.upsert({
          where: { key: "WAREHOUSE_NAME" },
          update: { value: name },
          create: { key: "WAREHOUSE_NAME", value: name },
        })
        : Promise.resolve(),
    ]);

    await createAuditLog({
      req,
      action: "UPDATE_WAREHOUSE_SETTINGS",
      entity: "AppSetting",
      details: { lat: latNum, lng: lngNum, name },
    });

    res.status(200).json({
      message: "Warehouse settings updated",
      lat: latNum,
      lng: lngNum,
      name: name ?? "Main Warehouse",
    });
  } catch (err: any) {
    logger.error("updateWarehouseSettings error", err);
    res.status(500).json({ message: "Failed to update warehouse settings" });
  }
};

// ── Shipping Configuration ────────────────────────────────────────────────────────────

const SHIPPING_DEFAULTS: Record<string, string> = {
  SHIPPING_SAME_STATE_PER_KM: "5",
  SHIPPING_SAME_STATE_FREE_KM: "10",
  SHIPPING_NO_LOCATION_FLAT: "50",
  SHIPPING_STATE_RATES: JSON.stringify({ Kerala: 50 }),
  SHIPPING_DISTRICT_RATES: JSON.stringify({}),
};

// GET /api/settings/shipping-config  (admin / super-admin)
export const getShippingConfig = async (req: Request, res: Response) => {
  try {
    const keys = Object.keys(SHIPPING_DEFAULTS);
    const settings = await prisma.appSetting.findMany({ where: { key: { in: keys } } });
    const map: Record<string, any> = {};
    for (const s of settings) map[s.key] = s.value;

    let stateRates: Record<string, number> = { Kerala: 50 };
    if (map["SHIPPING_STATE_RATES"]) {
      try {
        stateRates = typeof map["SHIPPING_STATE_RATES"] === "string"
          ? JSON.parse(map["SHIPPING_STATE_RATES"])
          : map["SHIPPING_STATE_RATES"];
      } catch (e) {
        logger.error("Failed to parse state rates map", e);
      }
    }

    let districtRates: Record<string, Record<string, number>> = {};
    if (map["SHIPPING_DISTRICT_RATES"]) {
      try {
        districtRates = typeof map["SHIPPING_DISTRICT_RATES"] === "string"
          ? JSON.parse(map["SHIPPING_DISTRICT_RATES"])
          : map["SHIPPING_DISTRICT_RATES"];
      } catch (e) {
        logger.error("Failed to parse district rates map", e);
      }
    }

    res.json({
      sameStatePerKmRate: Number(map["SHIPPING_SAME_STATE_PER_KM"] ?? 5),
      sameStateFreeKmThreshold: Number(map["SHIPPING_SAME_STATE_FREE_KM"] ?? 10),
      noLocationFlatRate: Number(map["SHIPPING_NO_LOCATION_FLAT"] ?? 50),
      stateRates,
      districtRates,
    });
  } catch (err: any) {
    logger.error("getShippingConfig error", err);
    res.status(500).json({ message: "Failed to fetch shipping config" });
  }
};

// PUT /api/settings/shipping-config  (admin / super-admin)
export const updateShippingConfig = async (req: Request, res: Response) => {
  try {
    const {
      sameStatePerKmRate,
      sameStateFreeKmThreshold,
      noLocationFlatRate,
      stateRates,
      districtRates,
    } = req.body;
    const entries: Record<string, any> = {};
    if (sameStatePerKmRate !== undefined) entries["SHIPPING_SAME_STATE_PER_KM"] = String(Number(sameStatePerKmRate));
    if (sameStateFreeKmThreshold !== undefined) entries["SHIPPING_SAME_STATE_FREE_KM"] = String(Number(sameStateFreeKmThreshold));
    if (noLocationFlatRate !== undefined) entries["SHIPPING_NO_LOCATION_FLAT"] = String(Number(noLocationFlatRate));
    if (stateRates !== undefined) {
      entries["SHIPPING_STATE_RATES"] = typeof stateRates === "string" ? stateRates : JSON.stringify(stateRates);
    }
    if (districtRates !== undefined) {
      entries["SHIPPING_DISTRICT_RATES"] = typeof districtRates === "string" ? districtRates : JSON.stringify(districtRates);
    }

    await Promise.all(
      Object.entries(entries).map(([key, value]) =>
        prisma.appSetting.upsert({
          where: { key },
          update: { value },
          create: { key, value },
        })
      )
    );

    // Clean up/delete old settings keys entirely
    const oldKeys = [
      "SHIPPING_SAME_STATE",
      "SHIPPING_OTHER_STATE_FLAT",
      "SHIPPING_SAME_STATE_BASE",
      "SHIPPING_MANUAL_FLAT",
    ];
    await prisma.appSetting.deleteMany({
      where: { key: { in: oldKeys } }
    });

    await createAuditLog({ req, action: "UPDATE_SHIPPING_CONFIG", entity: "AppSetting", details: req.body });
    res.json({ message: "Shipping configuration updated" });
  } catch (err: any) {
    logger.error("updateShippingConfig error", err);
    res.status(500).json({ message: "Failed to update shipping config" });
  }
};
