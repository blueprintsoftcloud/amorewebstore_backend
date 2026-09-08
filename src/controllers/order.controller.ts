import { Request, Response } from "express";
import crypto from "crypto";
import { User, Order, Cart, Product, PaymentLog, StaffProfile, Role, OrderStatus, NotificationType } from "../models/mongoose";
import razorpay from "../config/razorpay";
import { calculateShippingWithConfig } from "../services/shipping.service";
import { env } from "../config/env";
import logger from "../utils/logger";
import { orderStatusEmailPayload, orderConfirmationEmailPayload } from "../config/mailer";
import { createAuditLog } from "../utils/auditLog";
import { getWarehouseCoords, getShippingConfigFromDB } from "../utils/warehouseSettings";
import { getAdminRecipients, getAdminAndStaffRecipients } from "../utils/notificationRecipients";
import { sendEmail } from "../services/email.service";
import { sendNotification } from "../services/notification.service";
import { restoreStock, checkLowStock } from "../services/inventory.service";
import { syncProductFromVariants } from "../utils/productVariant";
import { uploadToCloudinary } from "../config/cloudinary";

// ── Notification Helper ───────────────────────────────────────────────────────
/**
 * Fan-out: send one notification per recipient, in-process/fire-and-forget —
 * `_req` is kept only for call-site signature stability, it's no longer used here.
 */
const notifyUsers = async (
  _req: Request,
  orderId: string,
  message: string,
  type: NotificationType,
  actorId: string,
  recipientIds: string[],
): Promise<void> => {
  for (const recipientId of recipientIds) {
    try {
      await sendNotification({ message, orderId, type, triggeredById: actorId, recipientId });
    } catch (err) {
      logger.warn(`notifyUser ${recipientId} error`, err);
    }
  }
};

// ── Stock Helper ───────────────────────────────────────────────────────────────
// Deduction stays synchronous/inline — it's the atomic "reject the order if stock
// is insufficient" check and must complete before the API responds. Only the
// non-blocking low-stock alert that follows a successful deduction is queued.
//
// `client` defaults to the global `prisma` bridge but should be the transaction-bound
// `tx` passed into a `prisma.$transaction(async (tx) => {...})` callback whenever this
// runs alongside other writes that must succeed or fail together (order creation,
// coupon usage, payment log) — see placeOrder/placeOrderPOD/placeAdminOrder below.
const deductStock = async (
  items: Array<{ productId: string; variantId?: string | null; quantity: number }>,
  client: typeof prisma = prisma,
) => {
  for (const item of items) {
    // Variant-carrying items deduct from the variant's OWN stock, not the product's —
    // Product.stock is meaningless once a product has ProductVariant rows (see
    // mongoose.ts's ProductVariant comment); only variant-less products still use it.
    const result = item.variantId
      ? await client.productVariant.updateMany({
          where: { id: item.variantId, stock: { gte: item.quantity } },
          data: { stock: { decrement: item.quantity } },
        })
      : await client.product.updateMany({
          where: { id: item.productId, stock: { gte: item.quantity } },
          data: { stock: { decrement: item.quantity } },
        });
    if (result.count === 0) {
      throw new Error(`Insufficient stock for product ${item.productId}`);
    }
    // A variant purchase just changed the variant's stock, not Product.stock directly —
    // resync so the low-stock check right below (and every other blind Product.stock
    // reader: category/admin filters, dashboard widget) sees this sale immediately
    // instead of going stale until an admin happens to touch Manage Variants again.
    if (item.variantId) {
      await syncProductFromVariants(item.productId, client);
    }
  }
  try {
    await checkLowStock({ productIds: items.map((i) => i.productId) });
  } catch (err) {
    logger.warn("checkLowStock error", err);
  }
};

// A cart item that carries a variant is only ever purchasable up to THAT variant's
// stock — Product.stock is irrelevant once the product has variant rows. Used
// everywhere a cart item's available quantity needs checking (preCheckout, placeOrder,
// placeOrderPOD).
const itemStock = (item: any): number => (item.variant ? item.variant.stock : item.product.stock);
const itemPrice = (item: any): number => {
  const base = item.variant?.priceOverride ?? item.product.price;
  // A variant's own discount (e.g. a promo on just the 50ml bottle) wins over the
  // product-level one — see mongoose.ts's ProductVariant discountOverride.
  const discount = item.variant?.discountOverride ?? item.product.discount;
  if (!discount || discount <= 0) return base;
  const raw = base * (1 - discount / 100);
  const round = Math.round(raw);
  const maxRoundingArtifact = Number.isInteger(base) ? Math.max(0.05, base * 0.00006) : 0.02;
  return Math.abs(raw - round) <= maxRoundingArtifact ? round : Math.round(raw * 100) / 100;
};

// GET /api/orders/pre-checkout  (authenticated)
export const preCheckout = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const cart = await prisma.cart.findUnique({
      where: { userId },
      include: { items: { include: { product: true, variant: true } } },
    });

    if (!cart || cart.items.length === 0) {
      return res.status(400).json({ message: "Cart is empty" });
    }

    const validItems = cart.items.filter((i: any) => itemStock(i) >= i.quantity);
    const outOfStock = cart.items.length - validItems.length;

    if (validItems.length === 0) {
      return res
        .status(400)
        .json({
          message: "All items in your cart are currently out of stock.",
        });
    }

    if (outOfStock > 0) {
      // Remove out-of-stock items from cart
      const staleIds = cart.items
        .filter((i: any) => itemStock(i) < i.quantity)
        .map((i: any) => i.id);
      await prisma.cartItem.deleteMany({ where: { id: { in: staleIds } } });
      return res
        .status(200)
        .json({
          message:
            "Some items were out of stock and removed. Proceeding with available items.",
          redirect: true,
        });
    }

    res
      .status(200)
      .json({ message: "Proceed to address selection", redirect: true });
  } catch (err: any) {
    logger.error("preCheckout error", err);
    res.status(500).json({ message: "Server error" });
  }
};

// POST /api/orders/place  (authenticated) — online payment
export const placeOrder = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { couponId, buyNowProductId } = req.body as { couponId?: string; buyNowProductId?: string };

    const cart = await prisma.cart.findUnique({
      where: { userId },
      include: { items: { include: { product: true, variant: true } } },
    });
    const address = await prisma.address.findFirst({
      where: { userId, isDefault: true },
    });

    if (!cart || cart.items.length === 0)
      return res.status(400).json({ message: "Cart is empty" });
    if (!address)
      return res.status(400).json({ message: "Delivery address missing" });

    // When Buy Now is used, only process the specified product
    const eligibleItems = buyNowProductId
      ? cart.items.filter((i: any) => i.product.id === buyNowProductId)
      : cart.items;

    if (eligibleItems.length === 0)
      return res.status(400).json({ message: "Product not found in cart" });

    // Build order items + subtotal
    let subtotal = 0;
    const orderItems = eligibleItems.map((item: any) => {
      const price = itemPrice(item);
      subtotal += price * item.quantity;
      return {
        productId: item.product.id,
        variantId: item.variantId ?? null,
        quantity: item.quantity,
        price: price,
      };
    });

    // Recalculate shipping server-side (security: never trust client)
    // If WAREHOUSE_SETTINGS feature is disabled by Super Admin → free shipping.
    // There's no standalone FeatureFlag model (see review.controller.ts's
    // isReviewsEnabled for the full explanation) — this used to call
    // prisma.featureFlag.findUnique(...), which threw on every checkout. Reads from
    // the generic AppSetting store instead, same as every other admin-togglable
    // setting in this app.
    const warehouseFlag = await prisma.appSetting.findUnique({ where: { key: "WAREHOUSE_SETTINGS_ENABLED" } });
    const warehouseFeatureEnabled = !warehouseFlag || (warehouseFlag.value !== false && warehouseFlag.value !== "false");
    let shippingCharge: number;
    if (warehouseFeatureEnabled) {
      const [warehouse, shippingConfig] = await Promise.all([getWarehouseCoords(), getShippingConfigFromDB()]);
      shippingCharge = (await calculateShippingWithConfig(
        address.latitude ?? 0,
        address.longitude ?? 0,
        address.country,
        address.state,
        address.city ?? "",
        address.zipCode ?? "",
        shippingConfig,
        warehouse.lat,
        warehouse.lng,
      )).shippingCharge;
    } else {
      shippingCharge = 0; // Warehouse Settings disabled → free shipping
    }

    // ── Coupon validation (server-side re-check for security) ─────────────
    let discountAmount = 0;
    let resolvedCouponId: string | undefined;

    if (couponId) {
      const coupon = await prisma.coupon.findUnique({ where: { id: couponId } });
      if (coupon && coupon.isActive && (!coupon.expiresAt || new Date(coupon.expiresAt).getTime() > Date.now()) && (coupon.maxUses === null || coupon.usedCount < coupon.maxUses) && subtotal >= coupon.minOrderAmount) {
        discountAmount = coupon.discountType === "PERCENTAGE"
          ? Math.round((subtotal * coupon.discountValue) / 100)
          : Math.min(coupon.discountValue, subtotal);
        resolvedCouponId = coupon.id;
      }
    }

    const finalAmount = Math.max(subtotal + shippingCharge - discountAmount, 0);

    // Create Razorpay order
    const rzpOrder = await razorpay.orders.create({
      amount: Math.round(finalAmount * 100), // paise
      currency: "INR",
      receipt: `receipt_${Date.now()}`,
    });

    // Order + coupon usage + stock deduction + payment log succeed or fail together —
    // a partial write here (e.g. order created but stock not deducted) would sell stock
    // that was never actually reserved. Razorpay order creation happens before the
    // transaction because it's an external, non-transactional side effect: if the DB
    // transaction below fails, the Razorpay order is simply never referenced by any
    // persisted Order (a harmless orphan on Razorpay's side, not a data-integrity issue).
    const order = await prisma.$transaction(async (tx: typeof prisma) => {
      const created = await tx.order.create({
        data: {
          userId,
          totalAmount: subtotal,
          shippingCharge,
          discountAmount,
          taxAmount: 0,
          finalAmount,
          paymentMethod: "ONLINE",
          paymentStatus: "PENDING",
          orderStatus: "PROCESSING",
          razorpayOrderId: rzpOrder.id,
          couponId: resolvedCouponId,
          shippingAddress: {
            fullAddress: address.fullAddress,
            city: address.city,
            state: address.state,
            zipCode: address.zipCode,
            country: address.country,
          },
          items: { create: orderItems },
        },
      });

      if (resolvedCouponId) {
        await tx.coupon.update({ where: { id: resolvedCouponId }, data: { usedCount: { increment: 1 } } });
      }

      await deductStock(orderItems, tx);

      await tx.paymentLog.create({
        data: {
          orderId: created.id,
          userId,
          event: "ORDER_CREATED",
          razorpayOrderId: rzpOrder.id,
          paymentMethod: "ONLINE",
          paymentStatus: "PENDING",
          amount: finalAmount,
          gatewayResponse: { razorpayOrderId: rzpOrder.id, currency: rzpOrder.currency, receipt: rzpOrder.receipt },
          signatureValid: null,
          ipAddress: req.ip ?? null,
        },
      });

      return created;
    });

    res.status(200).json({ order, rzpOrder, razorpay_key_id: env.RAZORPAY_KEY_ID });
  } catch (err: any) {
    logger.error("placeOrder error", err);
    res
      .status(500)
      .json({ message: "Error initiating order", error: err.message });
  }
};

// POST /api/orders/verify  (authenticated)
export const verifyPayment = async (req: Request, res: Response) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, buyNowProductId } =
      req.body as { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string; buyNowProductId?: string };
    const userId = req.user!.id;

    const body = `${razorpay_order_id}|${razorpay_payment_id}`;
    const expectedSignature = crypto
      .createHmac("sha256", env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest("hex");

    const order = await prisma.order.findFirst({
      where: { razorpayOrderId: razorpay_order_id },
    });
    if (!order) return res.status(404).json({ message: "Order not found" });

    const shortId = order.id.slice(-6);

    // Idempotency guard: Razorpay commonly delivers both a server-side webhook AND a
    // frontend redirect callback for the same payment (by design — belt and suspenders
    // against either one failing to arrive), and a user double-tapping "confirm" or a
    // frontend retry-on-timeout can trigger this endpoint twice too. Without this check,
    // a second call for an already-PAID order re-runs the entire success path: a second
    // PaymentLog row, a second cart-clear, duplicate customer/admin notifications, and a
    // duplicate confirmation email. Confirmed live via fault-injection testing — calling
    // this twice with an identical valid signature produced 2 PaymentLog rows before this fix.
    if (order.paymentStatus === "PAID") {
      return res.status(200).json({ message: "Success", order });
    }

    if (expectedSignature === razorpay_signature) {
      // Payment confirmation, its log entry, and clearing the cart must succeed or fail
      // together — a payment marked PAID with no PaymentLog record (or vice versa) is
      // exactly the kind of partial write a financial event can't tolerate.
      //
      // The `paymentStatus: { not: "PAID" }` guard makes this a compare-and-swap: if two
      // concurrent calls for the same order both pass the isPAID check above (a genuine
      // race, not just sequential duplicates), only ONE of them actually matches this
      // update and runs the side effects below — the other gets `updatedOrder === null`
      // and short-circuits to the idempotent-success response, never double-processing.
      const updated = await prisma.$transaction(async (tx: typeof prisma) => {
        const updatedOrder = await tx.order.update({
          where: { id: order.id, paymentStatus: { not: "PAID" } },
          data: {
            paymentStatus: "PAID",
            orderStatus: "CONFIRMED",
            razorpayPaymentId: razorpay_payment_id,
            razorpaySignature: razorpay_signature,
          },
        });
        if (!updatedOrder) return null; // lost the race — another call already processed this payment

        await tx.paymentLog.create({
          data: {
            orderId: order.id,
            userId,
            event: "PAYMENT_SUCCESS",
            razorpayOrderId: razorpay_order_id,
            razorpayPaymentId: razorpay_payment_id,
            razorpaySignature: razorpay_signature,
            paymentMethod: "ONLINE",
            paymentStatus: "PAID",
            amount: order.finalAmount,
            signatureValid: true,
            gatewayResponse: { razorpayOrderId: razorpay_order_id, razorpayPaymentId: razorpay_payment_id },
            ipAddress: req.ip ?? null,
          },
        });

        // Clear only the bought item (Buy Now) or the entire cart (regular checkout)
        if (buyNowProductId) {
          await tx.cartItem.deleteMany({ where: { cart: { userId }, productId: buyNowProductId } });
        } else {
          await tx.cart.deleteMany({ where: { userId } });
        }

        return updatedOrder;
      });

      if (!updated) {
        // Lost the race to a concurrent call for the same payment — it already ran the
        // notifications/email side effects, so this call is done: report success without
        // repeating them.
        const current = await prisma.order.findUnique({ where: { id: order.id } });
        return res.status(200).json({ message: "Success", order: current });
      }

      res.status(200).json({ message: "Success", order: updated });

      // Payment is already confirmed and committed at this point — notifications and
      // the confirmation email are best-effort (each already caught/logged on its own
      // below), so they run after the response instead of adding an SMTP round-trip
      // to the "Processing…" spinner the customer is staring at post-payment.
      void (async () => {
        try {
          const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { username: true, email: true },
          });
          const adminIds = await getAdminRecipients();
          const orderRecipients = await getAdminAndStaffRecipients("ORDER_VIEW");
          await notifyUsers(req, order.id, `New Order from ${user!.username}: ₹${order.finalAmount}`, "NEW_ORDER", userId, orderRecipients);
          await notifyUsers(req, order.id, `Payment Confirmed: Order #${shortId} by ${user!.username}`, "PAYMENT_SUCCESS", userId, adminIds);
          await notifyUsers(req, order.id, `Success! Payment confirmed for order #${shortId}`, "PAYMENT_SUCCESS", userId, [userId]);

          if (user?.email) {
            try {
              await sendEmail({
                to: user.email,
                toName: user.username,
                ...orderConfirmationEmailPayload(shortId, user.username, updated.finalAmount.toFixed(2), "ONLINE"),
              });
              logger.info(`Order confirmation email sent for ${user.email}`);
            } catch (emailErr) {
              logger.error("Order confirmation email failed", emailErr);
            }
          }
        } catch (bgErr) {
          logger.error("verifyPayment post-response notify/email error", bgErr);
        }
      })();
      return;
    } else {
      await prisma.$transaction(async (tx: typeof prisma) => {
        await tx.order.update({
          where: { id: order.id },
          data: { paymentStatus: "FAILED" },
        });

        await tx.paymentLog.create({
          data: {
            orderId: order.id,
            userId,
            event: "PAYMENT_FAILED",
            razorpayOrderId: razorpay_order_id,
            razorpayPaymentId: razorpay_payment_id,
            razorpaySignature: razorpay_signature,
            paymentMethod: "ONLINE",
            paymentStatus: "FAILED",
            amount: order.finalAmount,
            signatureValid: false,
            gatewayResponse: { razorpayOrderId: razorpay_order_id, razorpayPaymentId: razorpay_payment_id, reason: "signature_mismatch" },
            ipAddress: req.ip ?? null,
          },
        });
      });

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { username: true },
      });
      const adminIds = await getAdminRecipients();
      await notifyUsers(req, order.id, `ALERT: Payment Failed for ${user!.username} (#${shortId})`, "PAYMENT_FAILED", userId, adminIds);
      await notifyUsers(req, order.id, `Payment failed for order #${shortId}. Please contact support.`, "PAYMENT_FAILED", userId, [userId]);
      return res.status(400).json({ message: "Payment verification failed" });
    }
  } catch (err: any) {
    logger.error("verifyPayment error", err);
    res.status(500).json({ message: "Verification Error" });
  }
};

// POST /api/orders/place-pod  (authenticated) — Pay on Delivery
export const placeOrderPOD = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { couponId, buyNowProductId } = req.body as { couponId?: string; buyNowProductId?: string };

    const cart = await prisma.cart.findUnique({
      where: { userId },
      include: { items: { include: { product: true, variant: true } } },
    });
    const address = await prisma.address.findFirst({
      where: { userId, isDefault: true },
    });

    if (!cart || cart.items.length === 0)
      return res.status(400).json({ message: "Cart is empty" });
    if (!address)
      return res.status(400).json({ message: "Delivery address missing" });

    if (address.country !== "India") {
      return res
        .status(400)
        .json({
          message: "Pay on Delivery is not available for international orders.",
        });
    }

    // When Buy Now is used, only process the specified product
    const eligibleItems = buyNowProductId
      ? cart.items.filter((i: any) => i.product.id === buyNowProductId)
      : cart.items;

    if (eligibleItems.length === 0)
      return res.status(400).json({ message: "Product not found in cart" });

    let subtotal = 0;
    const orderItems = eligibleItems.map((item: any) => {
      const price = itemPrice(item);
      subtotal += price * item.quantity;
      return {
        productId: item.product.id,
        variantId: item.variantId ?? null,
        quantity: item.quantity,
        price: price,
      };
    });

    // If WAREHOUSE_SETTINGS feature is disabled by Super Admin → free shipping
    // (see the identical block above for why this reads AppSetting, not featureFlag)
    const warehouseFlagPOD = await prisma.appSetting.findUnique({ where: { key: "WAREHOUSE_SETTINGS_ENABLED" } });
    const warehouseFeatureEnabledPOD = !warehouseFlagPOD || (warehouseFlagPOD.value !== false && warehouseFlagPOD.value !== "false");
    let shippingCharge: number;
    if (warehouseFeatureEnabledPOD) {
      const [warehouse, shippingConfig] = await Promise.all([getWarehouseCoords(), getShippingConfigFromDB()]);
      shippingCharge = (await calculateShippingWithConfig(
        address.latitude ?? 0,
        address.longitude ?? 0,
        address.country,
        address.state,
        address.city ?? "",
        address.zipCode ?? "",
        shippingConfig,
        warehouse.lat,
        warehouse.lng,
      )).shippingCharge;
    } else {
      shippingCharge = 0; // Warehouse Settings disabled → free shipping
    }

    // ── Coupon validation (server-side re-check for security) ─────────────
    let discountAmount = 0;
    let resolvedCouponId: string | undefined;

    if (couponId) {
      const coupon = await prisma.coupon.findUnique({ where: { id: couponId } });
      if (coupon && coupon.isActive && (!coupon.expiresAt || new Date(coupon.expiresAt).getTime() > Date.now()) && (coupon.maxUses === null || coupon.usedCount < coupon.maxUses) && subtotal >= coupon.minOrderAmount) {
        discountAmount = coupon.discountType === "PERCENTAGE"
          ? Math.round((subtotal * coupon.discountValue) / 100)
          : Math.min(coupon.discountValue, subtotal);
        resolvedCouponId = coupon.id;
      }
    }

    const finalAmount = Math.max(subtotal + shippingCharge - discountAmount, 0);

    // Order + coupon usage + stock deduction + cart clear + payment log all succeed or
    // fail together (see placeOrder above for why).
    const order = await prisma.$transaction(async (tx: typeof prisma) => {
      const created = await tx.order.create({
        data: {
          userId,
          totalAmount: subtotal,
          shippingCharge,
          discountAmount,
          taxAmount: 0,
          finalAmount,
          paymentMethod: "POD",
          paymentStatus: "PENDING",
          orderStatus: "CONFIRMED",
          couponId: resolvedCouponId,
          shippingAddress: {
            fullAddress: address.fullAddress,
            city: address.city,
            state: address.state,
            zipCode: address.zipCode,
            country: address.country,
          },
          items: { create: orderItems },
        },
      });

      if (resolvedCouponId) {
        await tx.coupon.update({ where: { id: resolvedCouponId }, data: { usedCount: { increment: 1 } } });
      }

      await deductStock(orderItems, tx);

      // Clear only the bought item (Buy Now) or the entire cart (regular checkout)
      if (buyNowProductId) {
        await tx.cartItem.deleteMany({ where: { cart: { userId }, productId: buyNowProductId } });
      } else {
        await tx.cart.deleteMany({ where: { userId } });
      }

      await tx.paymentLog.create({
        data: {
          orderId: created.id,
          userId,
          event: "ORDER_POD",
          paymentMethod: "POD",
          paymentStatus: "PENDING",
          amount: finalAmount,
          signatureValid: null,
          gatewayResponse: { note: "Pay on Delivery — no gateway transaction" },
          ipAddress: req.ip ?? null,
        },
      });

      return created;
    });

    res.status(200).json({ message: "Order placed successfully via POD", order });

    // Order is already committed at this point — notifications and the confirmation
    // email are best-effort (each already caught/logged on its own below), so they
    // run after the response instead of adding their round-trip time to checkout.
    void (async () => {
      try {
        const user = await prisma.user.findUnique({
          where: { id: userId },
          select: { username: true, email: true },
        });
        const shortId = order.id.slice(-6);
        const orderRecipients = await getAdminAndStaffRecipients("ORDER_VIEW");
        await notifyUsers(req, order.id, `New POD Order from ${user!.username}: ₹${finalAmount}`, "NEW_ORDER", userId, orderRecipients);
        await notifyUsers(req, order.id, `Your POD order #${shortId} has been confirmed! Pay on delivery.`, "NEW_ORDER", userId, [userId]);

        if (user?.email) {
          try {
            await sendEmail({
              to: user.email,
              toName: user.username,
              ...orderConfirmationEmailPayload(shortId, user.username, finalAmount.toFixed(2), "POD"),
            });
            logger.info(`POD order confirmation email sent for ${user.email}`);
          } catch (emailErr) {
            logger.error("POD order confirmation email failed", emailErr);
          }
        }
      } catch (bgErr) {
        logger.error("placeOrderPOD post-response notify/email error", bgErr);
      }
    })();
  } catch (err: any) {
    logger.error("placeOrderPOD error", err);
    res
      .status(500)
      .json({ message: "Error placing POD order", error: err.message });
  }
};

// POST /api/orders/placeOrderQR  (authenticated — customer pays via QR & submits UTR / screenshot)
export const placeOrderQR = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { couponId, buyNowProductId, transactionId } = req.body as {
      couponId?: string;
      buyNowProductId?: string;
      transactionId?: string;
    };
    const rawTxId = transactionId?.trim() ? transactionId.trim().replace(/[\s-]/g, "") : undefined;
    let trimmedTxId: string | undefined;

    if (rawTxId) {
      const isUtr = /^\d{12}$/.test(rawTxId);
      const isAlphaRef = /^[a-zA-Z0-9_-]{10,35}$/.test(rawTxId);
      if (!isUtr && !isAlphaRef) {
        res.status(400).json({
          message:
            "Invalid Transaction ID / UTR. Must be a 12-digit numeric UTR or a valid 10-35 character UPI reference ID.",
        });
        return;
      }
      trimmedTxId = rawTxId;
    }

    let screenshotUrl: string | undefined;

    if (req.file) {
      screenshotUrl = await uploadToCloudinary(req.file.buffer, "payment_receipts");
    }

    if (!trimmedTxId && !screenshotUrl) {
      res.status(400).json({
        message: "Please enter your 12-digit UTR or upload a payment screenshot.",
      });
      return;
    }

    const [address, cart] = await Promise.all([
      prisma.address.findFirst({ where: { userId, isDefault: true } }),
      prisma.cart.findUnique({
        where: { userId },
        include: {
          items: {
            include: {
              product: true,
              variant: true,
            },
          },
        },
      }),
    ]);

    if (!address) {
      res.status(400).json({ message: "Default address not found" });
      return;
    }

    if (!cart || cart.items.length === 0) {
      res.status(400).json({ message: "Cart is empty" });
      return;
    }

    const eligibleItems = buyNowProductId
      ? cart.items.filter((i: any) => i.product.id === buyNowProductId)
      : cart.items;

    if (eligibleItems.length === 0) {
      res.status(400).json({ message: "Product not found in cart" });
      return;
    }

    let subtotal = 0;
    const orderItems = eligibleItems.map((item: any) => {
      const price = itemPrice(item);
      subtotal += price * item.quantity;
      return {
        productId: item.product.id,
        variantId: item.variantId ?? null,
        quantity: item.quantity,
        price: price,
      };
    });

    const warehouseFlagQR = await prisma.appSetting.findUnique({ where: { key: "WAREHOUSE_SETTINGS_ENABLED" } });
    const warehouseFeatureEnabledQR = !warehouseFlagQR || (warehouseFlagQR.value !== false && warehouseFlagQR.value !== "false");
    let shippingCharge: number;
    if (warehouseFeatureEnabledQR) {
      const [warehouse, shippingConfig] = await Promise.all([getWarehouseCoords(), getShippingConfigFromDB()]);
      shippingCharge = (await calculateShippingWithConfig(
        address.latitude ?? 0,
        address.longitude ?? 0,
        address.country,
        address.state,
        address.city ?? "",
        address.zipCode ?? "",
        shippingConfig,
        warehouse.lat,
        warehouse.lng,
      )).shippingCharge;
    } else {
      shippingCharge = 0;
    }

    let discountAmount = 0;
    let resolvedCouponId: string | undefined;

    if (couponId) {
      const coupon = await prisma.coupon.findUnique({ where: { id: couponId } });
      if (coupon && coupon.isActive && (!coupon.expiresAt || new Date(coupon.expiresAt).getTime() > Date.now()) && (coupon.maxUses === null || coupon.usedCount < coupon.maxUses) && subtotal >= coupon.minOrderAmount) {
        discountAmount = coupon.discountType === "PERCENTAGE"
          ? Math.round((subtotal * coupon.discountValue) / 100)
          : Math.min(coupon.discountValue, subtotal);
        resolvedCouponId = coupon.id;
      }
    }

    const finalAmount = Math.max(subtotal + shippingCharge - discountAmount, 0);

    const order = await prisma.$transaction(async (tx: typeof prisma) => {
      const created = await tx.order.create({
        data: {
          userId,
          totalAmount: subtotal,
          shippingCharge,
          discountAmount,
          taxAmount: 0,
          finalAmount,
          paymentMethod: "QR",
          paymentStatus: "PAID",
          orderStatus: "PROCESSING",
          transactionId: trimmedTxId,
          paymentScreenshot: screenshotUrl,
          couponId: resolvedCouponId,
          shippingAddress: {
            fullAddress: address.fullAddress,
            city: address.city,
            state: address.state,
            zipCode: address.zipCode,
            country: address.country,
          },
          items: { create: orderItems },
        },
      });

      if (resolvedCouponId) {
        await tx.coupon.update({ where: { id: resolvedCouponId }, data: { usedCount: { increment: 1 } } });
      }

      await deductStock(orderItems, tx);

      if (buyNowProductId) {
        await tx.cartItem.deleteMany({ where: { cart: { userId }, productId: buyNowProductId } });
      } else {
        await tx.cart.deleteMany({ where: { userId } });
      }

      await tx.paymentLog.create({
        data: {
          orderId: created.id,
          userId,
          event: "ORDER_QR",
          paymentMethod: "QR",
          paymentStatus: "PAID",
          amount: finalAmount,
          transactionId: trimmedTxId,
          paymentScreenshot: screenshotUrl,
          signatureValid: null,
          notes: trimmedTxId ? `UTR: ${trimmedTxId}` : "Payment screenshot attached",
          gatewayResponse: {
            transactionId: trimmedTxId,
            paymentScreenshot: screenshotUrl,
            note: "Paid via QR code — pending admin verification",
          },
          ipAddress: req.ip ?? null,
        },
      });

      return created;
    });

    res.status(200).json({ message: "Order placed successfully via QR", order });

    void (async () => {
      try {
        const user = await prisma.user.findUnique({
          where: { id: userId },
          select: { username: true, email: true },
        });
        const shortId = order.id.slice(-6);
        const orderRecipients = await getAdminAndStaffRecipients("ORDER_VIEW");
        await notifyUsers(req, order.id, `New QR Order from ${user!.username}: ₹${finalAmount}`, "NEW_ORDER", userId, orderRecipients);
        await notifyUsers(req, order.id, `Your QR payment order #${shortId} has been submitted! Awaiting verification.`, "NEW_ORDER", userId, [userId]);

        if (user?.email) {
          try {
            await sendEmail({
              to: user.email,
              toName: user.username,
              ...orderConfirmationEmailPayload(shortId, user.username, finalAmount.toFixed(2), "ONLINE"),
            });
            logger.info(`QR order confirmation email sent for ${user.email}`);
          } catch (emailErr) {
            logger.error("QR order confirmation email failed", emailErr);
          }
        }
      } catch (bgErr) {
        logger.error("placeOrderQR post-response notify/email error", bgErr);
      }
    })();
  } catch (err: any) {
    logger.error("placeOrderQR error", err);
    res.status(500).json({ message: "Error placing QR order", error: err.message });
  }
};

// POST /api/orders/cancel/:id  (authenticated)
export const cancelOrder = async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const userId = req.user!.id;

    const order = await prisma.order.findUnique({
      where: { id },
      include: { items: true },
    });

    if (!order) {
      return res.status(404).json({ message: "Order not found." });
    }

    // Ownership: customers can only cancel their own orders
    if (order.userId !== userId) {
      return res.status(403).json({ message: "Forbidden." });
    }

    // Only allow cancellation of orders still in PROCESSING state.
    // PROCESSING = online payment not yet completed.
    // CONFIRMED / SHIPPED = order is active — contact admin to cancel.
    if (order.orderStatus !== "PROCESSING") {
      return res.status(400).json({
        message:
          order.orderStatus === "CANCELLED"
            ? "This order is already cancelled."
            : "Only orders awaiting payment can be self-cancelled. Please contact support to cancel a confirmed or shipped order.",
      });
    }

    // Compare-and-swap the status transition itself: only proceed (and only enqueue the
    // stock restore) if this call is the one that actually moves PROCESSING → CANCELLED.
    // Without this, two concurrent cancel calls for the same order (double-click, two
    // open tabs) would both pass the read-check above and both enqueue a restore job —
    // the worker-level guard in inventory.worker.ts's restoreStock() would still stop
    // the double-restore, but this stops the redundant job from ever being queued.
    const cancelled = await prisma.order.update({
      where: { id, orderStatus: "PROCESSING" },
      data: { orderStatus: "CANCELLED" },
    });
    if (!cancelled) {
      return res.status(400).json({ message: "This order was already updated by another request." });
    }

    // Restore stock (fire-and-forget — not correctness-blocking for this response)
    await restoreStock({
      orderId: id,
      items: order.items.map((item: any) => ({ productId: item.productId, variantId: item.variantId ?? null, quantity: item.quantity })),
    });

    await prisma.paymentLog.create({
      data: {
        orderId: id,
        userId: order.userId,
        event: "ORDER_CANCELLED",
        paymentMethod: order.paymentMethod,
        paymentStatus: order.paymentStatus,
        amount: order.finalAmount,
        gatewayResponse: { cancelledBy: userId, self: true },
        signatureValid: null,
        ipAddress: req.ip ?? null,
      },
    });

    res.status(200).json({ message: "Order cancelled and stock restored" });
  } catch (err: any) {
    logger.error("cancelOrder error", err);
    res.status(500).json({ message: "Cancel error" });
  }
};

// PATCH /api/orders/:id/refund  (admin/staff — ORDER_UPDATE)
// Storra has no live payment-gateway refund integration — this doesn't move any money
// itself. It's a paper-trail action for an admin who already refunded the customer
// outside the system (Razorpay dashboard, bank transfer) to record that it happened,
// since paymentStatus otherwise stays stuck on "PAID" forever even after the order
// itself is CANCELLED — leaving Customer Payment History showing a cancelled order as
// still-paid with no way to know a refund is owed or was already handled.
export const refundOrder = async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const adminId = req.user!.id;
    const { note } = (req.body ?? {}) as { note?: string };

    const order = await prisma.order.findUnique({ where: { id } });
    if (!order) return res.status(404).json({ message: "Order not found" });
    if (order.paymentStatus !== "PAID") {
      return res.status(400).json({ message: "Only a PAID order's payment can be marked as refunded" });
    }
    if (order.orderStatus !== "CANCELLED") {
      return res.status(400).json({ message: "Cancel the order before recording a refund" });
    }

    // Compare-and-swap, same reasoning as cancelOrder/updateStatus above — a
    // double-click shouldn't create two PaymentLog rows for the same refund.
    // Both writes share one transaction so a failure creating the PaymentLog
    // (e.g. a validation error) rolls the status flip back too, instead of
    // leaving the order stuck on REFUNDED with no log to show for it.
    const updated = await prisma.$transaction(async (tx: typeof prisma) => {
      const result = await tx.order.update({
        where: { id, paymentStatus: "PAID" },
        data: { paymentStatus: "REFUNDED" },
      });
      if (!result) return null;

      await tx.paymentLog.create({
        data: {
          orderId: id,
          userId: order.userId,
          event: "REFUND_RECORDED",
          paymentMethod: order.paymentMethod,
          paymentStatus: "REFUNDED",
          amount: order.finalAmount,
          notes: note?.trim() || undefined,
          gatewayResponse: { recordedBy: adminId },
          signatureValid: null,
          ipAddress: req.ip ?? null,
        },
      });

      return result;
    });
    if (!updated) {
      return res.status(400).json({ message: "This order's payment was already updated by another request." });
    }

    await createAuditLog({
      req,
      action: "RECORD_REFUND",
      entity: "Order",
      entityId: id,
      details: { amount: order.finalAmount, note: note?.trim() || undefined },
    });

    res.status(200).json({ message: "Refund recorded", order: updated });
  } catch (err: any) {
    logger.error("refundOrder error", err);
    res.status(500).json({ message: "Error recording refund" });
  }
};

// GET /api/orders/my-orders?page=1&limit=10  (authenticated)
export const getOrders = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { page = "1", limit = "10" } = req.query as Record<string, string | undefined>;

    const pageSize = Math.min(Math.max(parseInt(limit ?? "10") || 10, 1), 50);
    const skip = (Math.max(parseInt(page ?? "1") || 1, 1) - 1) * pageSize;

    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where: { userId },
        include: {
          items: {
            include: {
              product: {
                select: { id: true, name: true, image: true, price: true },
              },
              // Which size/color/storage/etc. was actually purchased — see
              // mongoose.ts's ProductVariant. Absent (null) for a plain-SKU item.
              variant: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: pageSize,
      }),
      prisma.order.count({ where: { userId } }),
    ]);

    res.status(200).json({
      message: "Orders Fetched successfully",
      order: orders,
      pagination: {
        total,
        page: Math.max(parseInt(page ?? "1") || 1, 1),
        limit: pageSize,
        totalPages: Math.ceil(total / pageSize),
      },
    });
  } catch (err: any) {
    logger.error("getOrders error", err);
    res.status(500).json({ message: "Error in fetching orders" });
  }
};

// GET /api/orders/admin?page=1&limit=20&status=  (admin)
export const getOrdersForAdmin = async (req: Request, res: Response) => {
  try {
    const { page = "1", limit = "20", status } = req.query as Record<string, string | undefined>;

    const pageSize = Math.min(Math.max(parseInt(limit ?? "20") || 20, 1), 100);
    const skip = (Math.max(parseInt(page ?? "1") || 1, 1) - 1) * pageSize;
    const where = status ? { orderStatus: status.toUpperCase() as OrderStatus } : {};

    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where,
        include: {
          user: { select: { id: true, username: true, email: true, phone: true } },
          items: {
            include: {
              product: {
                select: { id: true, name: true, price: true, image: true },
              },
              // See getOrders's identical include — which option was purchased.
              variant: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: pageSize,
      }),
      prisma.order.count({ where }),
    ]);

    res.status(200).json({
      message: "Orders fetched for Admin",
      order: orders,
      pagination: {
        total,
        page: Math.max(parseInt(page ?? "1") || 1, 1),
        limit: pageSize,
        totalPages: Math.ceil(total / pageSize),
      },
    });
  } catch (err: any) {
    logger.error("getOrdersForAdmin error", err);
    res.status(500).json({ message: "Error in fetching Orders for admin" });
  }
};

// GET /api/order/stats  (admin) — summary metrics for the Order Management header cards.
// Computed via aggregation over every order, not derived from getOrdersForAdmin's paginated
// (and hard-capped at 100) list — the metrics cards previously reduced over whatever page
// of orders happened to be loaded, which silently undercounts the moment there are more
// orders than the page size. Same ORDER_VIEW gate as /order/all, so anyone who can see the
// order table can see accurate totals for it.
export const getOrderStats = async (_req: Request, res: Response) => {
  try {
    const [facet] = await Order.aggregate([
      {
        $facet: {
          totalCount: [{ $count: "n" }],
          byStatus: [{ $group: { _id: "$orderStatus", count: { $sum: 1 } } }],
          // "Gross income" is realized revenue — only orders actually paid for, not the
          // face value of every order including cancelled/pending ones.
          paidRevenue: [{ $match: { paymentStatus: "PAID" } }, { $group: { _id: null, sum: { $sum: "$finalAmount" } } }],
          totalOrderValue: [{ $group: { _id: null, sum: { $sum: "$finalAmount" } } }],
        },
      },
    ]);

    const byStatus = new Map((facet?.byStatus ?? []).map((r: any) => [r._id as string, r.count as number]));

    res.status(200).json({
      totalOrders: facet?.totalCount?.[0]?.n ?? 0,
      paidRevenue: facet?.paidRevenue?.[0]?.sum ?? 0,
      totalOrderValue: facet?.totalOrderValue?.[0]?.sum ?? 0,
      processing: byStatus.get("PROCESSING") ?? 0,
      confirmed: byStatus.get("CONFIRMED") ?? 0,
      shipped: byStatus.get("SHIPPED") ?? 0,
      delivered: byStatus.get("DELIVERED") ?? 0,
      cancelled: byStatus.get("CANCELLED") ?? 0,
    });
  } catch (err: any) {
    logger.error("getOrderStats error", err);
    res.status(500).json({ message: "Error fetching order stats" });
  }
};

// PUT /api/orders/update-status/:id  (admin)
export const updateStatus = async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const {
      orderStatus,
      deliveryPartnerId,
      newDeliveryPartnerName,
      noDeliveryPartner,
      trackingId,
      trackingLink,
      shippingNote,
    } = req.body as {
      orderStatus: OrderStatus;
      deliveryPartnerId?: string;
      newDeliveryPartnerName?: string;
      noDeliveryPartner?: boolean;
      trackingId?: string;
      trackingLink?: string;
      shippingNote?: string;
    };
    const adminId = req.user!.id;

    const order = await prisma.order.findUnique({
      where: { id },
      include: { items: true },
    });
    if (!order) return res.status(404).json({ message: "Order not found" });

    // DELIVERED is terminal (same as CANCELLED) and can only be reached from SHIPPED —
    // mirrors the frontend's chip-disabling in AdminOrderManagement.tsx, enforced here
    // too since this endpoint is reachable directly, not just through that UI.
    if (order.orderStatus === "DELIVERED" || order.orderStatus === "CANCELLED") {
      return res.status(400).json({ message: `Order #${id.slice(-6)} is already ${order.orderStatus.toLowerCase()} — no further status change is allowed.` });
    }
    if (orderStatus === "DELIVERED" && order.orderStatus !== "SHIPPED") {
      return res.status(400).json({ message: "An order must be marked SHIPPED before it can be marked DELIVERED." });
    }

    // Resolving the courier before the order update means a bad delivery-partner
    // reference never gets past this point — validate.middleware already guarantees
    // one of {deliveryPartnerId, newDeliveryPartnerName} or noDeliveryPartner is present
    // when orderStatus is SHIPPED.
    let shippingData: Record<string, unknown> = {};
    let shippingInfo: { partnerName?: string; trackingId?: string; trackingLink?: string; note?: string } | undefined;
    if (orderStatus === "SHIPPED" && noDeliveryPartner) {
      // Manual/self-delivery — no courier, no tracking ID; just an optional free-text note.
      shippingData = {
        shippingNote: shippingNote || undefined,
        shippedAt: new Date(),
      };
      if (shippingNote) shippingInfo = { note: shippingNote };
    } else if (orderStatus === "SHIPPED") {
      let partner;
      if (newDeliveryPartnerName) {
        partner = await prisma.deliveryPartner.findFirst({ where: { name: newDeliveryPartnerName.trim() } });
        if (!partner) {
          try {
            partner = await prisma.deliveryPartner.create({
              data: { name: newDeliveryPartnerName.trim() },
            });
          } catch (err: any) {
            if (err?.code !== 11000) throw err;
            partner = await prisma.deliveryPartner.findFirst({ where: { name: newDeliveryPartnerName.trim() } });
          }
        }
      } else if (deliveryPartnerId) {
        partner = await prisma.deliveryPartner.findUnique({ where: { id: deliveryPartnerId } });
      }
      if (!partner) {
        return res.status(400).json({ message: "Delivery partner not found" });
      }

      shippingData = {
        deliveryPartnerId: partner.id,
        deliveryPartnerName: partner.name,
        trackingId,
        trackingLink: trackingLink || undefined,
        shippedAt: new Date(),
      };
      shippingInfo = { partnerName: partner.name, trackingId: trackingId!, trackingLink: trackingLink || undefined };
    }

    // Compare-and-swap: only the call that actually transitions the order into
    // CANCELLED enqueues the stock restore — closes the same double-submit race as
    // cancelOrder() above (an admin double-clicking "cancel", or two open tabs).
    let updated;
    if (orderStatus === "CANCELLED") {
      updated = await prisma.order.update({
        where: { id, orderStatus: { not: "CANCELLED" } },
        data: { orderStatus },
      });
      if (!updated) {
        return res.status(400).json({ message: "This order was already cancelled." });
      }
      await restoreStock({
        orderId: id,
        items: order.items.map((item: any) => ({ productId: item.productId, variantId: item.variantId ?? null, quantity: item.quantity })),
      });
      await prisma.paymentLog.create({
        data: {
          orderId: id,
          userId: order.userId,
          event: "ORDER_CANCELLED",
          paymentMethod: order.paymentMethod,
          paymentStatus: order.paymentStatus,
          amount: order.finalAmount,
          gatewayResponse: { cancelledBy: adminId, self: false },
          signatureValid: null,
          ipAddress: req.ip ?? null,
        },
      });
    } else {
      updated = await prisma.order.update({
        where: { id },
        data: { orderStatus, ...shippingData },
      });
    }

    const admin = await prisma.user.findUnique({
      where: { id: adminId },
      select: { username: true },
    });
    const shortId = id.slice(-6);

    const adminIds = await getAdminRecipients();
    await notifyUsers(req, id, `Admin ${admin!.username} updated Order #${shortId} to ${orderStatus}`, "ORDER_UPDATE", adminId, adminIds);
    await notifyUsers(req, id, `Your order #${shortId} status has been updated to: ${orderStatus}`, "ORDER_UPDATE", adminId, [order.userId]);

    // Send order-status email to customer
    try {
      const customer = await prisma.user.findUnique({
        where: { id: order.userId },
        select: { email: true, username: true },
      });
      if (customer?.email) {
        await sendEmail({
          to: customer.email,
          toName: customer.username,
          ...orderStatusEmailPayload(shortId, orderStatus, customer.username, shippingInfo),
        });
        logger.info(`Order status email sent for ${customer.email} for order ${shortId}`);
      }
    } catch (emailErr) {
      logger.error("Order status email failed", emailErr);
    }

    await createAuditLog({
      req,
      action: "UPDATE_ORDER_STATUS",
      entity: "Order",
      entityId: id,
      details: { from: order.orderStatus, to: orderStatus, shortId },
    });

    res
      .status(200)
      .json({
        message: `Order status updated to ${orderStatus} Successfully`,
        order: updated,
      });
  } catch (err: any) {
    logger.error("updateStatus error", err);
    res.status(500).json({ message: "Error in Updating order status" });
  }
};

// GET /api/orders/my-transactions?page=1&limit=10  (authenticated customer)
export const getMyTransactions = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { page = "1", limit = "10" } = req.query as Record<string, string | undefined>;

    const pageSize = Math.min(Math.max(parseInt(limit ?? "10") || 10, 1), 50);
    const skip = (Math.max(parseInt(page ?? "1") || 1, 1) - 1) * pageSize;

    const [transactions, total] = await Promise.all([
      prisma.order.findMany({
        where: { userId },
        select: {
          id: true,
          createdAt: true,
          paymentMethod: true,
          paymentStatus: true,
          orderStatus: true,
          totalAmount: true,
          shippingCharge: true,
          discountAmount: true,
          finalAmount: true,
          razorpayPaymentId: true,
          razorpayOrderId: true,
          coupon: { select: { code: true } },
          items: {
            include: {
              product: { select: { id: true, name: true, image: true } },
            },
          },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: pageSize,
      }),
      prisma.order.count({ where: { userId } }),
    ]);

    res.status(200).json({
      transactions,
      pagination: {
        total,
        page: Math.max(parseInt(page ?? "1") || 1, 1),
        limit: pageSize,
        totalPages: Math.ceil(total / pageSize),
      },
    });
  } catch (err: any) {
    logger.error("getMyTransactions error", err);
    res.status(500).json({ message: "Error fetching transaction history" });
  }
};

// GET /api/orders/customer-transactions?page=1&limit=20&search=&paymentStatus=&paymentMethod=  (admin/staff)
export const getCustomerTransactions = async (req: Request, res: Response) => {
  try {
    const {
      page = "1",
      limit = "20",
      search,
      paymentStatus,
      paymentMethod,
    } = req.query as Record<string, string | undefined>;

    const pageSize = Math.min(Math.max(parseInt(limit ?? "20") || 20, 1), 100);
    const skip = (Math.max(parseInt(page ?? "1") || 1, 1) - 1) * pageSize;

    const where: any = {};
    if (paymentStatus) where.paymentStatus = paymentStatus.toUpperCase();
    if (paymentMethod) where.paymentMethod = paymentMethod.toUpperCase();
    if (search) {
      where.user = {
        OR: [
          { username: { contains: search, mode: "insensitive" } },
          { email: { contains: search, mode: "insensitive" } },
        ],
      };
    }

    const [rawTransactions, total] = await Promise.all([
      prisma.order.findMany({
        where,
        select: {
          id: true,
          userId: true,
          createdAt: true,
          paymentMethod: true,
          paymentStatus: true,
          orderStatus: true,
          totalAmount: true,
          shippingCharge: true,
          discountAmount: true,
          finalAmount: true,
          razorpayPaymentId: true,
          razorpayOrderId: true,
          coupon: { select: { code: true } },
          user: { select: { id: true, username: true, email: true, phone: true } },
          items: {
            include: {
              product: { select: { id: true, name: true, image: true } },
            },
          },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: pageSize,
      }),
      prisma.order.count({ where }),
    ]);

    // Prisma MongoDB relations can return null when the referenced user document
    // has a schema mismatch or a data validation issue. Fall back to a direct
    // Mongoose lookup for any order whose Prisma user relation resolved to null.
    const missingUserIds = rawTransactions
      .filter((tx: typeof rawTransactions[0]) => !tx.user)
      .map((tx: typeof rawTransactions[0]) => tx.userId);

    const fallbackMap: Record<string, { id: string; username: string; email: string | null; phone: string | null }> = {};
    if (missingUserIds.length > 0) {
      const mongooseUsers = await User.find({ _id: { $in: missingUserIds } })
        .select("_id username email phone")
        .lean();
      for (const mu of mongooseUsers as any[]) {
        fallbackMap[mu._id.toString()] = {
          id: mu._id.toString(),
          username: mu.username,
          email: mu.email ?? null,
          phone: mu.phone ?? null,
        };
      }
    }

    const transactions = rawTransactions.map((tx: typeof rawTransactions[0]) => ({
      ...tx,
      user: tx.user ?? fallbackMap[tx.userId] ?? null,
    }));

    res.status(200).json({
      transactions,
      pagination: {
        total,
        page: Math.max(parseInt(page ?? "1") || 1, 1),
        limit: pageSize,
        totalPages: Math.ceil(total / pageSize),
      },
    });
  } catch (err: any) {
    logger.error("getCustomerTransactions error", err);
    res.status(500).json({ message: "Error fetching customer transactions" });
  }
};

// GET /api/orders/:id  — customer (own order) or admin/staff (any order)
export const getOrderById = async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const requestingUser = req.user!;

    const order = await prisma.order.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, username: true, email: true, phone: true } },
        items: {
          include: {
            product: { select: { id: true, name: true, image: true, price: true, code: true } },
            // See getOrders's identical include — which option was purchased.
            variant: true,
          },
        },
        coupon: { select: { code: true, discountType: true, discountValue: true } },
      },
    });

    if (!order) return res.status(404).json({ message: "Order not found" });

    // Customers may only fetch their own orders
    if (
      requestingUser.role !== Role.ADMIN &&
      requestingUser.role !== Role.SUPER_ADMIN &&
      requestingUser.role !== Role.STAFF &&
      order.userId !== requestingUser.id
    ) {
      return res.status(403).json({ message: "Not authorised" });
    }

    res.status(200).json({ order });
  } catch (err: any) {
    logger.error("getOrderById error", err);
    res.status(500).json({ message: "Error fetching order" });
  }
};

// ─── Admin Place Order on Behalf of Customer ──────────────────────────────────

// GET /api/orders/admin-order/search-customers?q=   (admin / super-admin)
// Search existing customers by name, phone, or email.
export const searchCustomersForOrder = async (req: Request, res: Response) => {
  try {
    const q = (req.query.q as string | undefined)?.trim() ?? "";
    if (!q) return res.json({ customers: [] });

    const customers = await prisma.user.findMany({
      where: {
        role: "CUSTOMER",
        OR: [
          { username: { contains: q, mode: "insensitive" } },
          { email:    { contains: q, mode: "insensitive" } },
          { phone:    { contains: q, mode: "insensitive" } },
        ],
      },
      select: { id: true, username: true, email: true, phone: true },
      take: 10,
    });
    res.json({ customers });
  } catch (err: any) {
    logger.error("searchCustomersForOrder error", err);
    res.status(500).json({ message: "Search failed" });
  }
};

// GET /api/orders/admin-order/products?search=&page=1  (admin / super-admin)
// Returns active products with stock info for product picker.
export const getProductsForAdminOrder = async (req: Request, res: Response) => {
  try {
    const { search = "", page = "1", limit = "20" } = req.query as Record<string, string | undefined>;
    const pageSize = Math.min(Math.max(parseInt(limit ?? "20") || 20, 1), 100);
    const skip = (Math.max(parseInt(page ?? "1") || 1, 1) - 1) * pageSize;
    const where = {
      isActive: true,
      stock: { gt: 0 },
      ...(search ? { name: { contains: search as string, mode: "insensitive" as const } } : {}),
    };
    const [products, total] = await Promise.all([
      prisma.product.findMany({
        where,
        select: {
          id: true, name: true, code: true, image: true, price: true, stock: true,
          category: { select: { id: true, name: true } },
        },
        orderBy: { name: "asc" },
        skip,
        take: pageSize,
      }),
      prisma.product.count({ where }),
    ]);

    // A product with active variants can't actually be sold as its bare self — an
    // admin picking it at the counter needs the same Storage/Color choice a customer
    // would make on the storefront (see cart.controller.ts's cartAdd, which already
    // rejects a variant-less add for these). Attach each product's active variants so
    // the picker can require one, same contract as the rest of the app.
    const productIds = products.map((p: any) => p.id);
    const variants = productIds.length
      ? await prisma.productVariant.findMany({
          where: { productId: { in: productIds }, isActive: true },
          orderBy: { createdAt: "asc" },
        })
      : [];
    const variantsByProduct = new Map<string, any[]>();
    for (const v of variants) {
      const key = String(v.productId);
      const bucket = variantsByProduct.get(key);
      if (bucket) bucket.push(v);
      else variantsByProduct.set(key, [v]);
    }
    const productsWithVariants = products.map((p: any) => ({
      ...p,
      variants: variantsByProduct.get(p.id) ?? [],
    }));

    res.json({ products: productsWithVariants, pagination: { total, page: Math.max(parseInt(page ?? "1") || 1, 1), limit: pageSize, totalPages: Math.ceil(total / pageSize) } });
  } catch (err: any) {
    logger.error("getProductsForAdminOrder error", err);
    res.status(500).json({ message: "Failed to fetch products" });
  }
};

// POST /api/orders/admin-order/place   (admin / super-admin)
// Body: {
//   customerId?:   string,          // existing CUSTOMER id
//   newCustomer?:  { username, phone, email? }, // create new if no customerId
//   items:         [{ productId, quantity }],
//   address:       { fullAddress, city, state, zipCode, country },
//   paymentMethod: "CASH" | "POD",
//   paymentNote?:  string,           // e.g. UPI ref, receipt no, etc.
// }
export const placeAdminOrder = async (req: Request, res: Response) => {
  try {
    const adminId = req.user!.id;
    const {
      customerId,
      newCustomer,
      items,
      address,
      paymentMethod = "CASH",
      paymentNote,
      couponId,
    } = req.body as {
      customerId?: string;
      newCustomer?: { username: string; phone: string; email?: string };
      items: Array<{ productId: string; variantId?: string | null; quantity: number }>;
      address: { fullAddress: string; city: string; state: string; zipCode: string; country: string };
      paymentMethod: "CASH" | "POD";
      paymentNote?: string;
      couponId?: string;
    };

    // ── 1. Resolve customer ──────────────────────────────────────────────────
    let customer: { id: string; username: string; email: string | null };

    if (customerId) {
      const existing = await prisma.user.findUnique({
        where: { id: customerId },
        select: { id: true, username: true, email: true, role: true },
      });
      if (!existing || existing.role !== "CUSTOMER") {
        return res.status(404).json({ message: "Customer not found" });
      }
      customer = existing;
    } else if (newCustomer) {
      if (!newCustomer.username?.trim() || !newCustomer.phone?.trim()) {
        return res.status(400).json({ message: "Name and phone are required for a new customer" });
      }
      // Check if phone already exists
      const phoneExists = await prisma.user.findUnique({ where: { phone: newCustomer.phone } });
      if (phoneExists) {
        return res.status(400).json({ message: "A customer with this phone number already exists. Use existing customer search." });
      }
      const created = await prisma.user.create({
        data: {
          username: newCustomer.username.trim(),
          phone: newCustomer.phone.trim(),
          email: newCustomer.email?.trim().toLowerCase() || null,
          role: "CUSTOMER",
          isVerified: true,
        },
        select: { id: true, username: true, email: true },
      });
      customer = created;
    } else {
      return res.status(400).json({ message: "Provide either customerId or newCustomer details" });
    }

    // ── 2. Validate + price items ────────────────────────────────────────────
    if (!items?.length) return res.status(400).json({ message: "At least one item is required" });

    const productIds = items.map((i: any) => i.productId);
    const products = await prisma.product.findMany({
      where: { id: { in: productIds }, isActive: true },
      select: { id: true, name: true, price: true, stock: true },
    });

    const productMap = Object.fromEntries(products.map((p: any) => [p.id, p]));

    // Items that name a variantId (admin picking a specific size/color at the counter,
    // same as a customer would on the storefront) get their stock/price resolved from
    // that variant instead of the bare product — see ProductVariant in mongoose.ts.
    const variantIds = items.map((i: any) => i.variantId).filter(Boolean);
    const variants = variantIds.length
      ? await prisma.productVariant.findMany({ where: { id: { in: variantIds } } })
      : [];
    const variantMap = Object.fromEntries(variants.map((v: any) => [v.id, v]));

    let subtotal = 0;
    const orderItems: Array<{ productId: string; variantId?: string | null; quantity: number; price: number }> = [];

    for (const item of items) {
      const product = productMap[item.productId];
      if (!product) return res.status(400).json({ message: `Product ${item.productId} not found or inactive` });

      const variant = item.variantId ? variantMap[item.variantId] : null;
      if (item.variantId && !variant) {
        return res.status(400).json({ message: `Selected variant not found for "${product.name}"` });
      }
      const availableStock = variant ? variant.stock : product.stock;
      if (availableStock < item.quantity) {
        return res.status(400).json({ message: `Insufficient stock for "${product.name}" (available: ${availableStock})` });
      }
      // Same effective-price rule as the cart-based flows (placeOrder/placeOrderPOD) —
      // variant priceOverride/discountOverride win over the product's own, see itemPrice.
      const price = itemPrice({ product, variant });
      subtotal += price * item.quantity;
      orderItems.push({ productId: item.productId, variantId: item.variantId ?? null, quantity: item.quantity, price });
    }

    // ── Coupon validation (server-side re-check, same as placeOrder/placeOrderPOD) ──
    let discountAmount = 0;
    let resolvedCouponId: string | undefined;

    if (couponId) {
      const coupon = await prisma.coupon.findUnique({ where: { id: couponId } });
      if (coupon && coupon.isActive && (!coupon.expiresAt || new Date(coupon.expiresAt).getTime() > Date.now()) && (coupon.maxUses === null || coupon.usedCount < coupon.maxUses) && subtotal >= coupon.minOrderAmount) {
        discountAmount = coupon.discountType === "PERCENTAGE"
          ? Math.round((subtotal * coupon.discountValue) / 100)
          : Math.min(coupon.discountValue, subtotal);
        resolvedCouponId = coupon.id;
      }
    }

    const finalAmount = Math.max(subtotal - discountAmount, 0); // No shipping for admin orders (cash counter sales)

    // ── 3-5. Create order + deduct stock + payment log — succeed or fail together ──
    const order = await prisma.$transaction(async (tx: typeof prisma) => {
      const created = await tx.order.create({
        data: {
          userId: customer.id,
          placedByAdminId: adminId,
          totalAmount: subtotal,
          shippingCharge: 0,
          discountAmount,
          taxAmount: 0,
          finalAmount,
          paymentMethod: paymentMethod as "CASH" | "POD",
          paymentStatus: paymentMethod === "CASH" ? "PAID" : "PENDING",
          orderStatus: "CONFIRMED",
          couponId: resolvedCouponId,
          shippingAddress: {
            fullAddress: address.fullAddress,
            city: address.city,
            state: address.state,
            zipCode: address.zipCode,
            country: address.country || "India",
          },
          items: { create: orderItems },
        },
      });

      if (resolvedCouponId) {
        await tx.coupon.update({ where: { id: resolvedCouponId }, data: { usedCount: { increment: 1 } } });
      }

      await deductStock(orderItems, tx);

      await tx.paymentLog.create({
        data: {
          orderId: created.id,
          userId: customer.id,
          event: "ADMIN_ORDER_PLACED",
          paymentMethod: paymentMethod as "CASH" | "POD",
          paymentStatus: paymentMethod === "CASH" ? "PAID" : "PENDING",
          amount: finalAmount,
          gatewayResponse: {
            placedByAdmin: adminId,
            note: paymentNote ?? (paymentMethod === "CASH" ? "Cash collected at counter" : "Pay on delivery"),
          },
          signatureValid: null,
          ipAddress: req.ip ?? null,
        },
      });

      return created;
    });

    // ── 6. Notifications ─────────────────────────────────────────────────────
    const shortId = order.id.slice(-6);
    const admin = await prisma.user.findUnique({ where: { id: adminId }, select: { username: true } });
    const adminRecipients = await getAdminRecipients();
    await notifyUsers(req, order.id, `Admin Order #${shortId} placed by ${admin!.username} for ${customer.username}`, "NEW_ORDER", adminId, adminRecipients);

    // ── 7. Confirmation email ────────────────────────────────────────────────
    if (customer.email) {
      try {
        await sendEmail({
          to: customer.email,
          toName: customer.username,
          ...orderConfirmationEmailPayload(shortId, customer.username, finalAmount.toFixed(2), paymentMethod === "CASH" ? "ONLINE" : "POD"),
        });
        logger.info(`Admin-order confirmation email sent for ${customer.email}`);
      } catch (emailErr) {
        logger.warn("Admin-order confirmation email failed", emailErr);
      }
    }

    // ── 8. Audit log ─────────────────────────────────────────────────────────
    await createAuditLog({
      req,
      action: "ADMIN_PLACE_ORDER",
      entity: "Order",
      entityId: order.id,
      details: { customerId: customer.id, customerName: customer.username, paymentMethod, paymentNote, finalAmount },
    });

    res.status(201).json({
      message: "Order placed successfully",
      order: { id: order.id, shortId, finalAmount, paymentMethod, orderStatus: order.orderStatus },
      customer: { id: customer.id, username: customer.username, email: customer.email },
    });
  } catch (err: any) {
    logger.error("placeAdminOrder error", err);
    res.status(500).json({ message: "Failed to place order", error: err.message });
  }
};
