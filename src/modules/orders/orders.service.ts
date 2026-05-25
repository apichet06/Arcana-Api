import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { pool } from "../../db/pool.js";
import { ApiError } from "../../shared/errors/ApiError.js";
import type { CreateOrderInput, OrderDetailDTO, OrderDTO, OrderItemDTO } from "./type.js";
import * as couponService from "../coupons/coupon.service.js";
import * as shippingService from "../shipping/shipping.service.js";
import type { CalculateResult } from "../shipping/shipping.type.js";

function roundMoney(value: number): number {
    return Math.round(value * 100) / 100;
}

type CheckoutCartItemRow = RowDataPacket & {
    ci_id: number;
    pv_id: number;
    qty: number;
    unit_price: number;
    discount_amount: number;
    line_total: number;
    pv_sku: string | null;
    pv_cost: number;
    weight_g: number | null;
    length_cm: number | null;
    width_cm: number | null;
    height_cm: number | null;
    p_id: number;
    st_id: number;
    p_name: string | null;
    variant_label: string | null;
};

type CheckoutAddressRow = RowDataPacket & {
    locb_recipient_name: string;
    locb_phone: string;
    locb_address: string;
    zip_code: string;
};

// สร้างเลข order รายวัน และ lock running ล่าสุดใน transaction เพื่อกันเลขซ้ำ
async function generateOrderNo(conn: PoolConnection): Promise<string> {
    const now = new Date();
    const yyyymmdd =
        now.getFullYear().toString() +
        String(now.getMonth() + 1).padStart(2, "0") +
        String(now.getDate()).padStart(2, "0");

    const prefix = `ORD${yyyymmdd}-`;
    const [rows] = await conn.query<(RowDataPacket & { order_no: string })[]>(
        "SELECT order_no FROM Orders WHERE order_no LIKE ? ORDER BY order_no DESC LIMIT 1 FOR UPDATE",
        [`${prefix}%`]
    );

    const lastNo = rows[0]?.order_no;
    const lastRunning = lastNo ? Number(lastNo.split("-")[1]) : 0;
    const nextRunning = Number.isFinite(lastRunning) ? lastRunning + 1 : 1;

    return `${prefix}${String(nextRunning).padStart(5, "0")}`;
}

// ใช้ select ชุดเดียวกันทั้ง detail และผลลัพธ์หลัง checkout เพื่อไม่ให้ response field เพี้ยนกัน
const orderSelectSql = `
    SELECT
        or_id,
        order_no,
        u_id,
        cart_id,
        co_id,
        s_id,
        status,
        subtotal,
        discount_total,
        shipping_fee,
        grand_total,
        coupon_code,
        shipping_name,
        shipping_phone,
        shipping_address,
        remark,
        created_at,
        update_at
    FROM Orders
`;

async function getActiveCartId(conn: PoolConnection, uId: number): Promise<number> {
    const [cartRows] = await conn.query<(RowDataPacket & { cart_id: number })[]>(
        "SELECT cart_id FROM Carts WHERE u_id = ? AND status = 'active' LIMIT 1",
        [uId]
    );
    const cart = cartRows[0];
    if (!cart) throw new ApiError(400, "ไม่มีสินค้าในตะกร้า");
    return cart.cart_id;
}

async function getCheckoutCartItems(conn: PoolConnection, cartId: number): Promise<CheckoutCartItemRow[]> {
    const [cartItems] = await conn.query<CheckoutCartItemRow[]>(
        `SELECT
            ci.ci_id,
            ci.pv_id,
            ci.qty,
            ci.unit_price,
            ci.discount_amount,
            ci.line_total,
            pv.pv_sku,
            COALESCE(pv.pv_cost, 0) AS pv_cost,
            pv.weight_g,
            pv.length_cm,
            pv.width_cm,
            pv.height_cm,
            p.p_id,
            p.st_id,
            pl.p_name,
            GROUP_CONCAT(
                DISTINCT CONCAT(ot.otype_name, ': ', poi.poi_value)
                ORDER BY po.otype_id, poi.poi_id
                SEPARATOR ' | '
            ) AS variant_label
        FROM Cart_items ci
        INNER JOIN ProductVariants pv ON pv.pv_id = ci.pv_id
        INNER JOIN Products p ON p.p_id = pv.p_id
        LEFT JOIN ProductLangs pl ON pl.p_id = p.p_id AND pl.lg_code = 'th'
        LEFT JOIN VariantOptionItems voi ON voi.pv_id = pv.pv_id
        LEFT JOIN ProductOptionItems poi ON poi.poi_id = voi.poi_id
        LEFT JOIN ProductOptions po ON po.potn_id = poi.potn_id
        LEFT JOIN OptionTypes ot ON ot.otype_id = po.otype_id
        WHERE ci.cart_id = ?
          AND COALESCE(ci.is_selected, 1) = 1
        GROUP BY ci.ci_id, ci.pv_id, ci.qty, ci.unit_price, ci.discount_amount,
                 ci.line_total, pv.pv_sku, pv.pv_cost, pv.weight_g, pv.length_cm,
                 pv.width_cm, pv.height_cm, p.p_id, p.st_id, pl.p_name`,
        [cartId]
    );

    if (!cartItems.length) throw new ApiError(400, "ไม่มีสินค้าในตะกร้าที่เลือกไว้");
    return cartItems;
}

async function getCheckoutAddress(conn: PoolConnection, uId: number, locbId: number): Promise<CheckoutAddressRow> {
    const [locRows] = await conn.query<CheckoutAddressRow[]>(
        "SELECT locb_recipient_name, locb_phone, locb_address, zip_code FROM Locations_buyer WHERE locb_id = ? AND u_id = ? LIMIT 1",
        [locbId, uId]
    );
    const loc = locRows[0];
    if (!loc) throw new ApiError(404, "ไม่พบที่อยู่จัดส่ง");
    return loc;
}

function buildShippingPackage(items: CheckoutCartItemRow[]) {
    const weightG = items.reduce((sum, item) => {
        return sum + Math.max(Number(item.weight_g ?? 0), 0) * Number(item.qty);
    }, 0);

    const volumeCm3 = items.reduce((sum, item) => {
        const length = Number(item.length_cm ?? 0);
        const width = Number(item.width_cm ?? 0);
        const height = Number(item.height_cm ?? 0);
        const itemVolume = length > 0 && width > 0 && height > 0 ? length * width * height : 0;
        return sum + itemVolume * Number(item.qty);
    }, 0);

    return {
        weight_g: Math.max(Math.ceil(weightG), 1),
        volume_cm3: volumeCm3 > 0 ? Math.ceil(volumeCm3) : undefined,
    };
}

async function calculateCheckoutShippingOptions(
    loc: Pick<CheckoutAddressRow, "zip_code">,
    items: CheckoutCartItemRow[]
): Promise<CalculateResult[]> {
    const shippingPackage = buildShippingPackage(items);
    return shippingService.calculateShipping({
        postcode: loc.zip_code,
        weight_g: shippingPackage.weight_g,
        ...(shippingPackage.volume_cm3 !== undefined ? { volume_cm3: shippingPackage.volume_cm3 } : {}),
    });
}

function pickShippingOption(options: CalculateResult[], shippingScId?: number | null): CalculateResult {
    const availableOptions = options.filter((option) => option.price != null);
    if (!availableOptions.length) {
        throw new ApiError(400, "ยังไม่มีอัตราค่าส่งที่ใช้ได้สำหรับที่อยู่นี้");
    }

    const selected = shippingScId
        ? availableOptions.find((option) => option.sc_id === shippingScId)
        : null;

    if (shippingScId && !selected) {
        throw new ApiError(400, "ขนส่งที่เลือกยังไม่พร้อมใช้งานสำหรับที่อยู่นี้");
    }

    return selected ?? availableOptions.sort((a, b) => Number(a.price) - Number(b.price))[0]!;
}

export async function getCheckoutShippingOptions(input: {
    u_id: number;
    locb_id: number;
}): Promise<CalculateResult[]> {
    const conn = await pool.getConnection();
    try {
        const cartId = await getActiveCartId(conn, input.u_id);
        const [items, loc] = await Promise.all([
            getCheckoutCartItems(conn, cartId),
            getCheckoutAddress(conn, input.u_id, input.locb_id),
        ]);

        return calculateCheckoutShippingOptions(loc, items);
    } finally {
        conn.release();
    }
}

export async function createOrder(input: CreateOrderInput): Promise<OrderDetailDTO> {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        // ดึง active cart
        const cartId = await getActiveCartId(conn, input.u_id);

        // ดึง cart items พร้อมข้อมูลสินค้า
        const cartItems = await getCheckoutCartItems(conn, cartId);

        // ดึง shipping address
        const loc = await getCheckoutAddress(conn, input.u_id, input.locb_id);

        // subtotal มาจาก line_total หลังหัก discount ระดับ variant/product แล้ว
        const subtotal = roundMoney(cartItems.reduce((sum, i) => sum + Number(i.line_total), 0));
        const shippingOptions = await calculateCheckoutShippingOptions(loc, cartItems);
        const shippingOption = pickShippingOption(shippingOptions, input.shipping_sc_id);
        const shippingFee = Number(shippingOption.price ?? 0);

        // ถ้ามี co_code ให้ validate ใน transaction เดียวกับ order เพื่อให้ยอดและ used_count สอดคล้องกัน
        const couponResult = input.co_code
            ? await couponService.validateCouponForCheckout(conn, {
                u_id: input.u_id,
                co_code: input.co_code,
            })
            : null;

        const discountTotal = couponResult?.discount_amount ?? 0;
        const grandTotal = roundMoney(subtotal + shippingFee - discountTotal);
        const orderNo = await generateOrderNo(conn);
        // ตอนนี้ order เก็บร้านหลักจาก item แรก ถ้าอนาคตรองรับ multi-shop cart อาจต้องแตก order ตามร้าน
        const primaryStoreId = Number(cartItems[0]?.st_id ?? 0) || null;

        // สร้าง order
        const [orderRes] = await conn.query<ResultSetHeader>(
            "INSERT INTO Orders SET ?",
            [{
                order_no: orderNo,
                u_id: input.u_id,
                cart_id: cartId,
                co_id: couponResult?.coupon.co_id ?? null,
                s_id: primaryStoreId,
                status: "pending",
                subtotal,
                discount_total: discountTotal,
                shipping_fee: shippingFee,
                grand_total: grandTotal,
                coupon_code: couponResult?.coupon.co_code ?? null,
                shipping_name: loc.locb_recipient_name,
                shipping_phone: loc.locb_phone,
                shipping_address: loc.locb_address,
                remark: null,
                created_at: new Date(),
                update_at: new Date(),
            }]
        );
        const orId = orderRes.insertId;

        // สร้าง order items แบบ snapshot เพื่อเก็บราคา/ชื่อ/ต้นทุน ณ วันที่สั่งซื้อ
        for (const item of cartItems) {
            await conn.query<ResultSetHeader>(
                "INSERT INTO Order_items SET ?",
                [{
                    or_id: orId,
                    p_id: item.p_id,
                    pv_id: item.pv_id,
                    sku: item.pv_sku ?? null,
                    product_name: item.p_name ?? "",
                    variant_name: item.variant_label ?? null,
                    unit_price: Number(item.unit_price),
                    discount_amount: Number(item.discount_amount),
                    qty: item.qty,
                    line_total: Number(item.line_total),
                    cost_snapshot: Number(item.pv_cost),
                    created_at: new Date(),
                }]
            );
        }

        if (couponResult) {
            // บันทึกประวัติใช้คูปองและ mark UserCoupons เป็น used ใน transaction เดียวกับ order
            await couponService.redeemCouponForCheckout(conn, {
                u_id: input.u_id,
                or_id: orId,
                co_id: couponResult.coupon.co_id,
                co_code_snapshot: couponResult.coupon.co_code,
                subtotal_amount: couponResult.subtotal_amount,
                discount_amount: couponResult.discount_amount,
            });
        }

        // ปิด cart หลัง insert order และ redeem coupon สำเร็จทั้งหมด
        await conn.query(
            "UPDATE Carts SET status = 'checked_out', updated_at = ? WHERE cart_id = ?",
            [new Date(), cartId]
        );

        await conn.commit();

        // ดึง order ที่สร้างพร้อม items กลับมา
        const [orderRows] = await conn.query<(RowDataPacket & OrderDTO)[]>(
            `${orderSelectSql} WHERE or_id = ?`,
            [orId]
        );

        const [itemRows] = await conn.query<(RowDataPacket & OrderItemDTO)[]>(
            "SELECT oi_id, or_id, p_id, pv_id, sku, product_name, variant_name, unit_price, discount_amount, qty, line_total, cost_snapshot, created_at FROM Order_items WHERE or_id = ?",
            [orId]
        );

        return { ...orderRows[0]!, items: itemRows };
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

export async function getOrders(u_id: number): Promise<(OrderDTO & { item_count: number })[]> {
    const [rows] = await pool.query<(RowDataPacket & OrderDTO & { item_count: number })[]>(
        `SELECT
            o.or_id, o.order_no, o.u_id, o.cart_id, o.co_id, o.s_id,
            o.status, o.subtotal, o.discount_total, o.shipping_fee,
            o.grand_total, o.coupon_code,
            o.shipping_name, o.shipping_phone, o.shipping_address,
            o.remark, o.created_at, o.update_at,
            COUNT(oi.oi_id) AS item_count
        FROM Orders o
        LEFT JOIN Order_items oi ON oi.or_id = o.or_id
        WHERE o.u_id = ?
        GROUP BY o.or_id
        ORDER BY o.created_at DESC`,
        [u_id]
    );
    return rows;
}

export async function getOrderById(or_id: number, u_id: number): Promise<OrderDetailDTO | null> {
    const [orderRows] = await pool.query<(RowDataPacket & OrderDTO)[]>(
        `${orderSelectSql} WHERE or_id = ? AND u_id = ? LIMIT 1`,
        [or_id, u_id]
    );

    if (!orderRows[0]) return null;

    const [itemRows] = await pool.query<(RowDataPacket & OrderItemDTO)[]>(
        "SELECT oi_id, or_id, p_id, pv_id, sku, product_name, variant_name, unit_price, discount_amount, qty, line_total, cost_snapshot, created_at FROM Order_items WHERE or_id = ?",
        [or_id]
    );

    return { ...orderRows[0], items: itemRows };
}
