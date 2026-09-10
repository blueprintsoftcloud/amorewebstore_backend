import { Request, Response } from "express";
import { Address } from "../models/mongoose";
import { calculateShippingWithConfig } from "../services/shipping.service";
import { getWarehouseCoords, getShippingConfigFromDB } from "../utils/warehouseSettings";
import logger from "../utils/logger";
import NodeGeocoder from "node-geocoder";

const geocoder = NodeGeocoder({ provider: "openstreetmap" });

/**
 * Cleans the street address by removing duplicated city, state, zipCode, and country from the end.
 */
const cleanStreetAddress = (
  fullAddress: string,
  city: string,
  state: string,
  zipCode: string,
  country: string
): string => {
  let clean = fullAddress || "";
  
  const termsToRemove = [
    country,
    zipCode,
    state,
    city
  ].filter(Boolean);

  for (const term of termsToRemove) {
    const escapedTerm = term.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
    const regex = new RegExp(`[,\\s]*${escapedTerm}\\b`, 'gi');
    clean = clean.replace(regex, '');
  }

  // Trim any trailing commas, periods, spaces
  clean = clean.replace(/[,.\s]+$/, '').trim();
  
  return clean || fullAddress;
};

// POST /api/address/save-geo  (authenticated)
export const saveLocationAndGetShipping = async (req: Request, res: Response) => {
  try {
    const { latitude, longitude } = req.body;
    const userId = req.user!.id;

    if (latitude === undefined || longitude === undefined || latitude === null || longitude === null) {
      return res.status(400).json({ message: "latitude and longitude are required" });
    }

    const geoResponse = await geocoder.reverse({ lat: latitude, lon: longitude });
    if (!geoResponse.length) {
      return res.status(400).json({ message: "Address not found for these coordinates" });
    }
    const data = geoResponse[0];

    const [warehouse, config] = await Promise.all([getWarehouseCoords(), getShippingConfigFromDB()]);
    const shippingResult = await calculateShippingWithConfig(
      latitude, longitude, data.country ?? "", data.state ?? "", data.city ?? "", data.zipcode ?? "", config, warehouse.lat, warehouse.lng,
    );
    const shippingCharge = shippingResult.shippingCharge;
    const distanceKm = shippingResult.distanceKm;

    const existingDefault = await Address.findOne({ userId, isDefault: true });
    const cityVal = data.city ?? "";
    const stateVal = data.state ?? "";
    const zipCodeVal = data.zipcode ?? "";
    const countryVal = data.country ?? "India";
    const addressData = {
      userId,
      fullAddress: cleanStreetAddress(data.formattedAddress ?? "", cityVal, stateVal, zipCodeVal, countryVal),
      city: cityVal,
      state: stateVal,
      country: countryVal,
      zipCode: zipCodeVal,
      latitude,
      longitude,
      isDefault: true,
    };
    const address = existingDefault
      ? await Address.findByIdAndUpdate(existingDefault.id, addressData, { new: true })
      : await Address.create(addressData);

    res.status(200).json({ address, distance: distanceKm.toFixed(2) + " KM", shippingCharge });
  } catch (err: any) {
    logger.error("saveLocationAndGetShipping error", err);
    res.status(500).json({ error: err.message });
  }
};

// POST /api/address/save-manual  (authenticated)
export const saveManualAddress = async (req: Request, res: Response) => {
  try {
    const { fullAddress, city, state, zipCode, country = "India" } = req.body;
    const userId = req.user!.id;

    if (!fullAddress || !city || !zipCode) {
      return res.status(400).json({ message: "fullAddress, city, and zipCode are required" });
    }

    const [warehouse, config] = await Promise.all([getWarehouseCoords(), getShippingConfigFromDB()]);
    const shippingCharge = (await calculateShippingWithConfig(0, 0, country, state ?? "", city ?? "", zipCode, config, warehouse.lat, warehouse.lng)).shippingCharge;

    const existingDefault = await Address.findOne({ userId, isDefault: true });
    const addressData = {
      userId, fullAddress, city, state: state ?? "", country, zipCode,
      latitude: null, longitude: null, isDefault: true,
    };
    const address = existingDefault
      ? await Address.findByIdAndUpdate(existingDefault.id, addressData, { new: true })
      : await Address.create(addressData);

    res.status(200).json({ address, shippingCharge });
  } catch (err: any) {
    logger.error("saveManualAddress error", err);
    res.status(500).json({ error: err.message });
  }
};

// GET /api/address/default  (authenticated)
export const getDefaultAddress = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const address = await Address.findOne({ userId, isDefault: true });
    res.json({ address: address ?? null });
  } catch (err: any) {
    logger.error("getDefaultAddress error", err);
    res.status(500).json({ error: err.message });
  }
};

// POST /api/address/preview-shipping  (authenticated)
// Returns shipping estimate WITHOUT saving to DB — used by the delivery preview modal.
export const previewShipping = async (req: Request, res: Response) => {
  try {
    const { latitude, longitude, manual, state: manualState, city: manualCity } = req.body;

    const [warehouse, config] = await Promise.all([getWarehouseCoords(), getShippingConfigFromDB()]);

    // Manual mode — no GPS, use provided state/city/zipCode for rate lookup
    if (manual) {
      const result = await calculateShippingWithConfig(0, 0, "India", manualState ?? "", manualCity ?? "", req.body.zipCode ?? "", config, warehouse.lat, warehouse.lng);
      return res.json({ ...result, free: false });
    }

    if (latitude === undefined || longitude === undefined) {
      return res.status(400).json({ message: "latitude and longitude required for GPS preview" });
    }

    let state = "";
    let country = "India";
    let fullAddress = "";
    let city = "";
    let zipCode = "";
    try {
      const geo = await geocoder.reverse({ lat: latitude, lon: longitude });
      if (geo.length) {
        state = geo[0].state ?? "";
        country = geo[0].country ?? "India";
        city = geo[0].city ?? "";
        zipCode = geo[0].zipcode ?? "";
        fullAddress = cleanStreetAddress(geo[0].formattedAddress ?? "", city, state, zipCode, country);
      }
    } catch { /* geocoding failed — proceed with empty state */ }

    if (!state && typeof req.body.state === "string") state = req.body.state.trim();
    if (!city && typeof req.body.city === "string") city = req.body.city.trim();
    if (!zipCode && typeof req.body.zipCode === "string") zipCode = req.body.zipCode.trim();

    const result = await calculateShippingWithConfig(latitude, longitude, country, state, city, zipCode, config, warehouse.lat, warehouse.lng);
    return res.json({ ...result, address: fullAddress, city, state, country, zipCode, lat: latitude, lng: longitude, free: false });
  } catch (err: any) {
    logger.error("previewShipping error", err);
    res.status(500).json({ error: err.message });
  }
};
