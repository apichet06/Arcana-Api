import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { pool } from "../../db/pool.js";
import { ApiError } from "../../shared/errors/ApiError.js";
import type { AdminOrderDTO, AdminOrderSummaryDTO, CheckoutOrderInput, CreateOrderInput, OrderDetailDTO, OrderDTO, OrderItemDTO, OrderShipmentDTO, OrderShipmentItemDTO } from "./type.js";
import * as couponService from "../coupons/coupon.service.js";
import * as shippingService from "../shipping/shipping.service.js";
import type { CalculateResult } from "../shipping/shipping.type.js";
import { chargeAndRecordPayment } from "../payments/payment.service.js";
import { createOmiseRefund } from "../payments/payment.service.js";
import type { PaymentResultDTO } from "../payments/payment.type.js";
import { createShippopShipment } from "../shipping/providers/shippop.js";
import { getIO } from "../../socket/socket.js";
import * as notificationService from "../notifications/notification.service.js";
import type { NotificationPriority } from "../notifications/type.js";
import {
    ensureInventoryReservationTable,
    releaseReservationsForOrders,
    reserveInventoryForOrderItems,
    type InventoryReservationItem,
} from "../inventory/inventory-reservation.service.js";
import {
    BUYER_CANCELLABLE_STATUS_CODES,
    getOrderStatusId,
    type OrderStatusCode,
    setOrdersStatus,
    toLegacyOrderStatus,
} from "./order-status.service.js";

const REFUND_REQUESTABLE_STATUS_CODES: OrderStatusCode[] = ["CONFIRMED", "PROCESSING", "PACKED"];
const ADMIN_STATUS_TRANSITIONS: Record<string, OrderStatusCode> = {
    CONFIRMED: "PROCESSING",
    PROCESSING: "PACKED",
    PACKED: "READY_TO_SHIP",
};

let orderShipmentLabelColumnReady: Promise<void> | null = null;
let orderShipmentTablesReady: Promise<void> | null = null;

function roundMoney(value: number): number {
    return Math.round(value * 100) / 100;
}

async function ensureOrderShipmentLabelColumn(): Promise<void> {
    orderShipmentLabelColumnReady ??= pool.query<(RowDataPacket & { column_name: string })[]>(
        `SELECT COLUMN_NAME AS column_name
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = 'Orders'
           AND COLUMN_NAME = 'label_url'`
    )
        .then(async ([columns]) => {
            if (columns.length === 0) {
                // SHIPPOP ส่ง label URL กลับมาหลัง confirm; เก็บแยกจาก tracking_url เพื่อใช้พิมพ์ใบปะหน้ากล่องโดยตรง
                await pool.query("ALTER TABLE Orders ADD COLUMN label_url TEXT NULL AFTER tracking_url");
            }
        })
        .then(() => undefined);

    return orderShipmentLabelColumnReady;
}

async function ensureOrderShipmentTables(): Promise<void> {
    orderShipmentTablesReady ??= (async () => {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS Order_shipments (
                os_id INT NOT NULL AUTO_INCREMENT,
                or_id INT NOT NULL,
                loc_id INT NOT NULL,
                shipment_no VARCHAR(80) NOT NULL,
                status VARCHAR(40) NOT NULL DEFAULT 'planned',
                tracking_no VARCHAR(120) NULL,
                tracking_url TEXT NULL,
                label_url TEXT NULL,
                sender_name VARCHAR(255) NOT NULL,
                sender_phone VARCHAR(60) NULL,
                sender_email VARCHAR(255) NULL,
                sender_address TEXT NOT NULL,
                sender_zip_code VARCHAR(20) NULL,
                sender_province_name VARCHAR(255) NULL,
                sender_district_name VARCHAR(255) NULL,
                sender_subdistrict_name VARCHAR(255) NULL,
                recipient_name VARCHAR(255) NOT NULL,
                recipient_phone VARCHAR(60) NULL,
                recipient_address TEXT NOT NULL,
                recipient_zip_code VARCHAR(20) NULL,
                recipient_province_name VARCHAR(255) NULL,
                recipient_district_name VARCHAR(255) NULL,
                recipient_subdistrict_name VARCHAR(255) NULL,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                PRIMARY KEY (os_id),
                UNIQUE KEY uq_order_shipments_order_location (or_id, loc_id),
                KEY idx_order_shipments_order (or_id),
                KEY idx_order_shipments_location (loc_id)
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS Order_shipment_items (
                osi_id INT NOT NULL AUTO_INCREMENT,
                os_id INT NOT NULL,
                or_id INT NOT NULL,
                oi_id INT NOT NULL,
                pv_id INT NOT NULL,
                qty INT NOT NULL,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (osi_id),
                UNIQUE KEY uq_order_shipment_items_line (os_id, oi_id, pv_id),
                KEY idx_order_shipment_items_order (or_id),
                KEY idx_order_shipment_items_item (oi_id)
            )
        `);
    })();

    return orderShipmentTablesReady;
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
    province_name: string | null;
    district_name: string | null;
    subdistrict_name: string | null;
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
        o.or_id,
        o.order_no,
        o.u_id,
        o.cart_id,
        o.co_id,
        o.st_id,
        st.st_company_name,
        o.s_id,
        o.status,
        os.s_code AS status_code,
        osl.s_name AS status_label,
        latest_refund.refund_id AS refund_id,
        latest_refund.amount AS refund_amount,
        latest_refund.remark AS refund_remark,
        latest_refund.updated_at AS refund_updated_at,
        latest_refund.status AS refund_status,
        o.subtotal,
        o.discount_total,
        o.shipping_fee,
        o.shipping_sc_id,
        sc.sc_code AS shipping_carrier_code,
        sc.sc_name AS shipping_carrier_name,
        o.shipping_zone_code,
        o.tracking_no,
        o.tracking_url,
        o.label_url,
        sc.tracking_url_template,
        o.shipment_status,
        o.grand_total,
        o.coupon_code,
        o.shipping_name,
        o.shipping_phone,
        o.shipping_address,
        lb.zip_code AS shipping_zip_code,
        prov.name_in_thai AS shipping_province_name,
        dist.name_in_thai AS shipping_district_name,
        subdist.name_in_thai AS shipping_subdistrict_name,
        o.remark,
        o.payment_expires_at,
        o.created_at,
        o.update_at
    FROM Orders o
    LEFT JOIN Store st ON st.st_id = o.st_id
    LEFT JOIN Shipping_carriers sc ON sc.sc_id = o.shipping_sc_id
    LEFT JOIN Status os ON os.s_id = o.s_id
    LEFT JOIN StatusLangs osl ON osl.s_id = os.s_id AND osl.lg_code = ?
    LEFT JOIN Locations_buyer lb
        ON lb.u_id = o.u_id
       AND lb.locb_recipient_name = o.shipping_name
       AND lb.locb_phone = o.shipping_phone
       AND lb.locb_address = o.shipping_address
    LEFT JOIN Provinces prov ON prov.id = lb.provinces_id
    LEFT JOIN Districts dist ON dist.id = lb.districts_id
    LEFT JOIN Subdistricts subdist ON subdist.id = lb.subdistricts_id
    LEFT JOIN (
        SELECT r1.or_id, r1.refund_id, r1.amount, r1.status, r1.remark, r1.updated_at
        FROM Refunds r1
        INNER JOIN (
            SELECT or_id, MAX(refund_id) AS refund_id
            FROM Refunds
            GROUP BY or_id
        ) latest ON latest.refund_id = r1.refund_id
    ) latest_refund ON latest_refund.or_id = o.or_id
`;

const orderItemsSelectSql = `
    SELECT
        oi.oi_id, oi.or_id, oi.p_id, oi.pv_id, oi.sku,
        COALESCE(pv.image_url, ip.ip_image_url) AS image_url,
        COALESCE(pl.p_name, oi.product_name) AS product_name,
        oi.variant_name, oi.unit_price,
        oi.discount_amount, oi.qty, oi.line_total, oi.cost_snapshot,
        p.st_id, s.st_company_name, oi.created_at
    FROM Order_items oi
    LEFT JOIN Products p ON p.p_id = oi.p_id
    LEFT JOIN ProductVariants pv ON pv.pv_id = oi.pv_id
    LEFT JOIN ImageProduct ip ON ip.p_id = oi.p_id AND ip.is_primary = 1
    LEFT JOIN ProductLangs pl ON pl.p_id = oi.p_id AND pl.lg_code = ?
    LEFT JOIN Store s ON s.st_id = p.st_id
`;

const ADMIN_ALL_STORE_ID = 1;
const PAYMENT_EXPIRE_MINUTES = Number(process.env.ORDER_PAYMENT_EXPIRE_MINUTES ?? 15);
let expirationJobStarted = false;

type AdminOrderDetailDTO = AdminOrderDTO & {
    items: OrderItemDTO[];
    shipments?: OrderShipmentDTO[];
};

type OrderNotificationEvent =
    | "order:created"
    | "order:paid"
    | "order:status_updated"
    | "order:tracking_updated"
    | "order:refund_requested"
    | "order:refund_approved"
    | "order:refund_rejected"
    | "order:cancelled"
    | "order:payment_expired";

type OrderNotificationTarget = "STORE" | "USER";

type OrderNotificationOptions = {
    event: OrderNotificationEvent;
    order: Partial<OrderDTO> & {
        or_id: number;
        order_no: string;
        st_id: number;
        u_id?: number;
    };
    title: string;
    message: string;
    priority?: NotificationPriority;
    targets?: OrderNotificationTarget[];
    actor?: "buyer" | "admin" | "system";
    actionUrl?: string;
};

const statusLabelByCode: Record<string, string> = {
    PENDING: "รอชำระเงิน",
    CONFIRMED: "ชำระเงินแล้ว",
    PROCESSING: "กำลังเตรียมสินค้า",
    PACKED: "แพ็กสินค้าแล้ว",
    READY_TO_SHIP: "พร้อมจัดส่ง",
    CANCELLED: "ยกเลิก",
    REFUNDED: "คืนเงินแล้ว",
};

function getOrderStatusLabel(order: Partial<OrderDTO>) {
    const statusCode = order.status_code ?? "";
    return order.status_label || statusLabelByCode[statusCode] || statusCode || order.status || "-";
}

function getStoreOrderActionUrl(order: Pick<OrderDTO, "or_id">) {
    return `/dashboard/orders?order_id=${order.or_id}`;
}

function getBuyerOrderActionUrl(order: Pick<OrderDTO, "or_id">) {
    return `/arcana/account/orders?order_id=${order.or_id}`;
}

function buildOrderEventPayload(options: OrderNotificationOptions) {
    const { event, order, title, message, actor = "system" } = options;

    return {
        event,
        actor,
        title,
        message,
        created_at: new Date(),
        order: {
            or_id: order.or_id,
            order_no: order.order_no,
            st_id: order.st_id,
            u_id: order.u_id,
            status: order.status,
            status_code: order.status_code,
            status_label: order.status_label,
            grand_total: order.grand_total,
            tracking_no: order.tracking_no,
            tracking_url: order.tracking_url,
            refund_status: order.refund_status,
        },
    };
}

async function createOrderNotification(target: OrderNotificationTarget, options: OrderNotificationOptions) {
    const { order, event, title, message, priority = "NORMAL" } = options;
    const targetId = target === "STORE" ? Number(order.st_id) : Number(order.u_id);
    if (!targetId) return;

    await notificationService.CreateNotification({
        target_type: target,
        target_id: targetId,
        type: event,
        title,
        message,
        action_url: options.actionUrl ?? (target === "STORE" ? getStoreOrderActionUrl(order) : getBuyerOrderActionUrl(order)),
        ref_type: "ORDER",
        ref_id: order.or_id,
        priority,
    });
}

async function notifyOrderEvent(options: OrderNotificationOptions) {
    const targets = options.targets ?? ["STORE", "USER"];
    const payload = buildOrderEventPayload(options);

    try {
        // บันทึก notification ลงฐานข้อมูลก่อน เพื่อให้ผู้ใช้ที่ offline กลับมาเห็นย้อนหลังได้
        // CreateNotification จะ emit notification:new ไปยัง room เป้าหมายให้อยู่แล้ว
        for (const target of targets) {
            try {
                await createOrderNotification(target, options);
            } catch (error) {
                // ถ้า notification ราย target ใดล้มเหลว ให้ target อื่นและ realtime event ยังเดินต่อได้
                console.warn(`[orders] create notification ${options.event} for ${target} failed:`, error);
            }
        }

        // Emit realtime event เพิ่มอีกชั้นสำหรับหน้า orders/dashboard ที่อยาก update state ทันที
        // ใช้ทั้ง event เฉพาะและ order:changed เพื่อให้ frontend เลือก subscribe ได้ง่าย
        const io = getIO();
        io.to(`STORE_${options.order.st_id}`).emit(options.event, payload);
        io.to(`STORE_${options.order.st_id}`).emit("order:changed", payload);
        if (options.order.u_id) {
            io.to(`USER_${options.order.u_id}`).emit(options.event, payload);
            io.to(`USER_${options.order.u_id}`).emit("order:changed", payload);
        }
    } catch (error) {
        // ห้ามให้ notification/socket ทำให้ order action ที่ commit แล้วล้มเหลว
        console.warn(`[orders] notify ${options.event} failed:`, error);
    }
}

async function notifyManyOrderEvents(orders: OrderNotificationOptions[]) {
    for (const orderNotification of orders) {
        await notifyOrderEvent(orderNotification);
    }
}

function buildPaymentExpiresAt(): Date {
    const minutes = Number.isFinite(PAYMENT_EXPIRE_MINUTES) && PAYMENT_EXPIRE_MINUTES > 0
        ? PAYMENT_EXPIRE_MINUTES
        : 15;
    return new Date(Date.now() + minutes * 60 * 1000);
}

async function getOrderItems(orIds: number[], lg_code = "th"): Promise<Map<number, OrderItemDTO[]>> {
    const itemMap = new Map<number, OrderItemDTO[]>();
    if (!orIds.length) return itemMap;

    const [itemRows] = await pool.query<(RowDataPacket & OrderItemDTO)[]>(
        `${orderItemsSelectSql} WHERE oi.or_id IN (?) ORDER BY oi.oi_id ASC`,
        [lg_code, orIds]
    );

    for (const item of itemRows) {
        const orderId = Number(item.or_id);
        itemMap.set(orderId, [...(itemMap.get(orderId) ?? []), item]);
    }

    return itemMap;
}

async function createShipmentGroupsForOrders(conn: PoolConnection, orderIds: number[]): Promise<void> {
    if (!orderIds.length) return;
    await ensureOrderShipmentTables();

    const [existingRows] = await conn.query<(RowDataPacket & { cnt: number })[]>(
        "SELECT COUNT(*) AS cnt FROM Order_shipments WHERE or_id IN (?)",
        [orderIds]
    );
    if (Number(existingRows[0]?.cnt ?? 0) > 0) return;

    const [shipmentRows] = await conn.query<(RowDataPacket & {
        or_id: number;
        order_no: string;
        st_id: number;
        loc_id: number;
        st_company_name: string | null;
        st_phone: string | null;
        st_email: string | null;
        loc_address: string | null;
        loc_zip_code: string | null;
        sender_province_name: string | null;
        sender_district_name: string | null;
        sender_subdistrict_name: string | null;
        recipient_name: string;
        recipient_phone: string | null;
        recipient_address: string;
        recipient_zip_code: string | null;
        recipient_province_name: string | null;
        recipient_district_name: string | null;
        recipient_subdistrict_name: string | null;
        total_qty: number;
    })[]>(
        `SELECT
            o.or_id,
            o.order_no,
            o.st_id,
            inv.loc_id,
            st.st_company_name,
            st.st_phone,
            st.st_email,
            loc.loc_address,
            loc.zip_code AS loc_zip_code,
            sender_prov.name_in_thai AS sender_province_name,
            sender_dist.name_in_thai AS sender_district_name,
            sender_subdist.name_in_thai AS sender_subdistrict_name,
            o.shipping_name AS recipient_name,
            o.shipping_phone AS recipient_phone,
            o.shipping_address AS recipient_address,
            lb.zip_code AS recipient_zip_code,
            recipient_prov.name_in_thai AS recipient_province_name,
            recipient_dist.name_in_thai AS recipient_district_name,
            recipient_subdist.name_in_thai AS recipient_subdistrict_name,
            SUM(oir.qty_reserved) AS total_qty
         FROM Order_inventory_reservations oir
         INNER JOIN Inventorys inv ON inv.inv_id = oir.inv_id
         INNER JOIN Orders o ON o.or_id = oir.or_id
         LEFT JOIN Store st ON st.st_id = o.st_id
         LEFT JOIN Locations loc ON loc.loc_id = inv.loc_id
         LEFT JOIN Provinces sender_prov ON sender_prov.id = loc.Provinces_id
         LEFT JOIN Districts sender_dist ON sender_dist.id = loc.Districts_id
         LEFT JOIN Subdistricts sender_subdist ON sender_subdist.id = loc.Subdistricts_id
         LEFT JOIN Locations_buyer lb
            ON lb.u_id = o.u_id
           AND lb.locb_recipient_name = o.shipping_name
           AND lb.locb_phone = o.shipping_phone
           AND lb.locb_address = o.shipping_address
         LEFT JOIN Provinces recipient_prov ON recipient_prov.id = lb.provinces_id
         LEFT JOIN Districts recipient_dist ON recipient_dist.id = lb.districts_id
         LEFT JOIN Subdistricts recipient_subdist ON recipient_subdist.id = lb.subdistricts_id
         WHERE oir.or_id IN (?)
         GROUP BY
            o.or_id, o.order_no, o.st_id, inv.loc_id, st.st_company_name, st.st_phone, st.st_email,
            loc.loc_address, loc.zip_code, sender_prov.name_in_thai, sender_dist.name_in_thai,
            sender_subdist.name_in_thai, o.shipping_name, o.shipping_phone, o.shipping_address,
            lb.zip_code, recipient_prov.name_in_thai, recipient_dist.name_in_thai,
            recipient_subdist.name_in_thai
         ORDER BY o.or_id ASC, inv.loc_id ASC`,
        [orderIds]
    );

    if (!shipmentRows.length) return;

    const shipmentIdByOrderLocation = new Map<string, number>();
    const runningByOrder = new Map<number, number>();

    for (const row of shipmentRows) {
        if (!row.loc_address || !row.loc_zip_code) {
            throw new ApiError(400, "คลังที่ถูกจอง stock ยังไม่มีที่อยู่ผู้ส่งครบถ้วน");
        }

        const orderId = Number(row.or_id);
        const running = (runningByOrder.get(orderId) ?? 0) + 1;
        runningByOrder.set(orderId, running);

        // Snapshot ผู้ส่ง/ผู้รับ ณ ตอนสร้าง order เพื่อให้ label เก่าไม่เปลี่ยนตามการแก้ที่อยู่คลังหรือที่อยู่ลูกค้าในอนาคต
        const [result] = await conn.query<ResultSetHeader>(
            "INSERT INTO Order_shipments SET ?",
            [{
                or_id: orderId,
                loc_id: row.loc_id,
                shipment_no: `${row.order_no}-S${String(running).padStart(2, "0")}`,
                status: "planned",
                sender_name: row.st_company_name ?? `Store #${row.st_id}`,
                sender_phone: row.st_phone,
                sender_email: row.st_email,
                sender_address: row.loc_address,
                sender_zip_code: row.loc_zip_code,
                sender_province_name: row.sender_province_name,
                sender_district_name: row.sender_district_name,
                sender_subdistrict_name: row.sender_subdistrict_name,
                recipient_name: row.recipient_name,
                recipient_phone: row.recipient_phone,
                recipient_address: row.recipient_address,
                recipient_zip_code: row.recipient_zip_code,
                recipient_province_name: row.recipient_province_name,
                recipient_district_name: row.recipient_district_name,
                recipient_subdistrict_name: row.recipient_subdistrict_name,
                created_at: new Date(),
                updated_at: new Date(),
            }]
        );

        shipmentIdByOrderLocation.set(`${orderId}:${Number(row.loc_id)}`, result.insertId);
    }

    const [itemRows] = await conn.query<(RowDataPacket & {
        or_id: number;
        loc_id: number;
        oi_id: number;
        pv_id: number;
        qty: number;
    })[]>(
        `SELECT
            oir.or_id,
            inv.loc_id,
            oir.oi_id,
            oir.pv_id,
            SUM(oir.qty_reserved) AS qty
         FROM Order_inventory_reservations oir
         INNER JOIN Inventorys inv ON inv.inv_id = oir.inv_id
         WHERE oir.or_id IN (?)
         GROUP BY oir.or_id, inv.loc_id, oir.oi_id, oir.pv_id
         ORDER BY oir.or_id ASC, inv.loc_id ASC, oir.oi_id ASC`,
        [orderIds]
    );

    for (const item of itemRows) {
        const shipmentId = shipmentIdByOrderLocation.get(`${Number(item.or_id)}:${Number(item.loc_id)}`);
        if (!shipmentId) continue;

        await conn.query(
            "INSERT INTO Order_shipment_items SET ?",
            [{
                os_id: shipmentId,
                or_id: item.or_id,
                oi_id: item.oi_id,
                pv_id: item.pv_id,
                qty: item.qty,
                created_at: new Date(),
            }]
        );
    }
}

async function getOrderShipments(orderIds: number[]): Promise<Map<number, OrderShipmentDTO[]>> {
    await ensureOrderShipmentTables();

    const shipmentMap = new Map<number, OrderShipmentDTO[]>();
    if (!orderIds.length) return shipmentMap;

    const [shipmentRows] = await pool.query<(RowDataPacket & OrderShipmentDTO)[]>(
        `SELECT
            os.os_id,
            os.or_id,
            os.loc_id,
            os.shipment_no,
            os.status,
            os.tracking_no,
            os.tracking_url,
            os.label_url,
            os.sender_name,
            os.sender_phone,
            os.sender_email,
            os.sender_address,
            os.sender_zip_code,
            os.sender_province_name,
            os.sender_district_name,
            os.sender_subdistrict_name,
            os.recipient_name,
            os.recipient_phone,
            os.recipient_address,
            os.recipient_zip_code,
            os.recipient_province_name,
            os.recipient_district_name,
            os.recipient_subdistrict_name,
            COUNT(osi.osi_id) AS item_count,
            COALESCE(SUM(osi.qty), 0) AS total_qty
         FROM Order_shipments os
         LEFT JOIN Order_shipment_items osi ON osi.os_id = os.os_id
         WHERE os.or_id IN (?)
         GROUP BY os.os_id
         ORDER BY os.or_id ASC, os.os_id ASC`,
        [orderIds]
    );

    const [itemRows] = await pool.query<(RowDataPacket & OrderShipmentItemDTO)[]>(
        `SELECT
            osi.osi_id,
            osi.os_id,
            osi.oi_id,
            osi.pv_id,
            oi.sku,
            oi.product_name,
            oi.variant_name,
            osi.qty
         FROM Order_shipment_items osi
         INNER JOIN Order_items oi ON oi.oi_id = osi.oi_id
         WHERE osi.or_id IN (?)
         ORDER BY osi.os_id ASC, osi.osi_id ASC`,
        [orderIds]
    );

    const itemsByShipment = new Map<number, OrderShipmentItemDTO[]>();
    for (const item of itemRows) {
        const shipmentId = Number(item.os_id);
        itemsByShipment.set(shipmentId, [...(itemsByShipment.get(shipmentId) ?? []), item]);
    }

    for (const shipment of shipmentRows) {
        const orderId = Number(shipment.or_id);
        const enriched = {
            ...shipment,
            item_count: Number(shipment.item_count ?? 0),
            total_qty: Number(shipment.total_qty ?? 0),
            items: itemsByShipment.get(Number(shipment.os_id)) ?? [],
        };
        shipmentMap.set(orderId, [...(shipmentMap.get(orderId) ?? []), enriched]);
    }

    return shipmentMap;
}

async function restoreCouponUsageForCancelledOrder(conn: PoolConnection, order: OrderDTO): Promise<void> {
    if (!order.co_id) return;

    await conn.query(
        "DELETE FROM CouponRedemptions WHERE or_id = ? AND co_id = ? AND u_id = ?",
        [order.or_id, order.co_id, order.u_id]
    );

    await conn.query(
        "UPDATE Coupon SET used_count = GREATEST(used_count - 1, 0), update_at = ? WHERE co_id = ?",
        [new Date(), order.co_id]
    );

    await conn.query(
        `UPDATE UserCoupons
         SET status = 'claimed',
             used_at = NULL,
             or_id = NULL
         WHERE co_id = ?
           AND u_id = ?
           AND or_id = ?
           AND status = 'used'`,
        [order.co_id, order.u_id, order.or_id]
    );
}

async function getActiveCartId(conn: PoolConnection, uId: number): Promise<number> {
    const [cartRows] = await conn.query<(RowDataPacket & { cart_id: number })[]>(
        "SELECT cart_id FROM Carts WHERE u_id = ? AND status = 'active' ORDER BY cart_id DESC LIMIT 1",
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
          AND ci.is_selected = 1
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
        `SELECT
            lb.locb_recipient_name,
            lb.locb_phone,
            lb.locb_address,
            lb.zip_code,
            p.name_in_thai AS province_name,
            d.name_in_thai AS district_name,
            s.name_in_thai AS subdistrict_name
         FROM Locations_buyer lb
         LEFT JOIN Provinces p ON p.id = lb.provinces_id
         LEFT JOIN Districts d ON d.id = lb.districts_id
         LEFT JOIN Subdistricts s ON s.id = lb.subdistricts_id
         WHERE lb.locb_id = ? AND lb.u_id = ?
         LIMIT 1`,
        [locbId, uId]
    );
    const loc = locRows[0];
    if (!loc) throw new ApiError(404, "ไม่พบที่อยู่จัดส่ง");
    return loc;
}

async function getCouponStoreId(conn: PoolConnection, coCode: string): Promise<number> {
    const [rows] = await conn.query<(RowDataPacket & { st_id: number })[]>(
        "SELECT st_id FROM Coupon WHERE co_code = ? LIMIT 1",
        [coCode]
    );
    const coupon = rows[0];
    if (!coupon) throw new ApiError(404, "ไม่พบคูปอง");
    return Number(coupon.st_id);
}

function groupCartItemsByStore(items: CheckoutCartItemRow[]): Map<number, CheckoutCartItemRow[]> {
    const groups = new Map<number, CheckoutCartItemRow[]>();
    for (const item of items) {
        const storeId = Number(item.st_id);
        if (!storeId) throw new ApiError(400, "สินค้าในตะกร้าไม่มีข้อมูลร้านค้า");
        groups.set(storeId, [...(groups.get(storeId) ?? []), item]);
    }
    return groups;
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

type CheckoutShippingQuoteGroup = {
    loc_id: number;
    origin_postcode: string;
    items: CheckoutCartItemRow[];
};

async function buildCheckoutShippingQuoteGroups(
    conn: PoolConnection,
    items: CheckoutCartItemRow[]
): Promise<CheckoutShippingQuoteGroup[]> {
    const groups = new Map<number, CheckoutShippingQuoteGroup>();

    for (const item of items) {
        let need = Number(item.qty);

        const [inventoryRows] = await conn.query<(RowDataPacket & {
            inv_id: number;
            loc_id: number;
            on_hand: number;
            reserved_qty: number;
            origin_postcode: string | null;
        })[]>(
            `SELECT
                inv.inv_id,
                inv.loc_id,
                inv.on_hand,
                inv.reserved_qty,
                loc.zip_code AS origin_postcode
             FROM Inventorys inv
             LEFT JOIN Locations loc ON loc.loc_id = inv.loc_id
             WHERE inv.pv_id = ?
             ORDER BY inv.inv_id ASC`,
            [item.pv_id]
        );

        for (const row of inventoryRows) {
            if (need <= 0) break;

            const available = Math.max(Number(row.on_hand) - Number(row.reserved_qty), 0);
            const quoteQty = Math.min(need, available);
            if (quoteQty <= 0) continue;

            if (!row.origin_postcode) {
                throw new ApiError(400, "คลังที่มีสินค้าอยู่ยังไม่มีรหัสไปรษณีย์สำหรับคำนวณค่าส่ง");
            }

            const group = groups.get(Number(row.loc_id)) ?? {
                loc_id: Number(row.loc_id),
                origin_postcode: row.origin_postcode,
                items: [],
            };

            // Quote ต้องใช้จำนวนตามคลังที่คาดว่าจะหยิบจริง ไม่ใช่ qty เต็มของ order item ทุกครั้ง
            group.items.push({ ...item, qty: quoteQty } as CheckoutCartItemRow);
            groups.set(Number(row.loc_id), group);
            need -= quoteQty;
        }

        if (need > 0) {
            throw new ApiError(409, `สินค้า ${item.p_name ?? item.pv_id} มีจำนวนไม่พอสำหรับคำนวณค่าส่ง`);
        }
    }

    return Array.from(groups.values());
}

async function calculateCheckoutShippingOptions(
    conn: PoolConnection,
    loc: Pick<CheckoutAddressRow, "zip_code">,
    items: CheckoutCartItemRow[]
): Promise<CalculateResult[]> {
    const quoteGroups = await buildCheckoutShippingQuoteGroups(conn, items);
    const groupOptions = await Promise.all(
        quoteGroups.map((group) => {
            const shippingPackage = buildShippingPackage(group.items);
            return shippingService.calculateShipping({
                postcode: loc.zip_code,
                origin_postcode: group.origin_postcode,
                weight_g: shippingPackage.weight_g,
                ...(shippingPackage.volume_cm3 !== undefined ? { volume_cm3: shippingPackage.volume_cm3 } : {}),
            });
        })
    );

    // หนึ่งร้านอาจถูกหยิบจากหลายคลัง จึงรวมราคาต่อ carrier ให้เป็นราคาที่ลูกค้าเห็นใน checkout
    return mergeStoreShippingOptions(groupOptions);
}

function mergeStoreShippingOptions(storeOptions: CalculateResult[][]): CalculateResult[] {
    if (!storeOptions.length) return [];

    const firstOptions = storeOptions[0] ?? [];
    return firstOptions
        .map((first) => {
            const matched = storeOptions.map((options) => options.find((option) => option.sc_id === first.sc_id));
            if (matched.some((option) => !option || option.price == null)) return { ...first, price: null };

            const totalPrice = matched.reduce((sum, option) => sum + Number(option!.price), 0);
            const billedWeight = matched.reduce((sum, option) => sum + Number(option?.billed_weight_g ?? 0), 0);
            const zoneCodes = Array.from(new Set(matched.map((option) => option?.zone_code).filter(Boolean)));

            return {
                ...first,
                price: roundMoney(totalPrice),
                billed_weight_g: billedWeight,
                zone_code: zoneCodes.join(", "),
            };
        })
        .filter((option) => option.is_active);
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

        const storeGroups = Array.from(groupCartItemsByStore(items).values());
        const storeOptions = await Promise.all(
            storeGroups.map((storeItems) => calculateCheckoutShippingOptions(conn, loc, storeItems))
        );

        return mergeStoreShippingOptions(storeOptions);
    } finally {
        conn.release();
    }
}

export async function createOrder(input: CreateOrderInput): Promise<OrderDetailDTO[]> {
    await ensureInventoryReservationTable();
    await ensureOrderShipmentLabelColumn();
    await ensureOrderShipmentTables();

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        // ดึง active cart
        const cartId = await getActiveCartId(conn, input.u_id);

        // ดึง cart items พร้อมข้อมูลสินค้า
        const cartItems = await getCheckoutCartItems(conn, cartId);

        // ดึง shipping address
        const loc = await getCheckoutAddress(conn, input.u_id, input.locb_id);

        const storeGroups = Array.from(groupCartItemsByStore(cartItems).entries());
        const pendingStatusId = await getOrderStatusId(conn, "PENDING");
        const couponStoreId = input.co_code ? await getCouponStoreId(conn, input.co_code) : null;
        if (couponStoreId && !storeGroups.some(([storeId]) => storeId === couponStoreId)) {
            throw new ApiError(400, "คูปองนี้ใช้กับสินค้าในตะกร้าที่เลือกไว้ไม่ได้");
        }
        const createdOrderIds: number[] = [];
        const reservationItems: InventoryReservationItem[] = [];

        for (const [storeId, storeItems] of storeGroups) {
            const subtotal = roundMoney(storeItems.reduce((sum, i) => sum + Number(i.line_total), 0));
            const shippingOptions = await calculateCheckoutShippingOptions(conn, loc, storeItems);
            const shippingOption = pickShippingOption(shippingOptions, input.shipping_sc_id);
            const shippingFee = Number(shippingOption.price ?? 0);

            const couponResult = input.co_code && couponStoreId === storeId
                ? await couponService.validateCouponForCheckout(conn, {
                    u_id: input.u_id,
                    co_code: input.co_code,
                    st_id: storeId,
                })
                : null;

            const discountTotal = couponResult?.discount_amount ?? 0;
            const grandTotal = roundMoney(subtotal + shippingFee - discountTotal);
            const orderNo = await generateOrderNo(conn);

            const [orderRes] = await conn.query<ResultSetHeader>(
                "INSERT INTO Orders SET ?",
                [{
                    order_no: orderNo,
                    u_id: input.u_id,
                    cart_id: cartId,
                    co_id: couponResult?.coupon.co_id ?? null,
                    st_id: storeId,
                    s_id: pendingStatusId,
                    status: toLegacyOrderStatus("PENDING"),
                    subtotal,
                    discount_total: discountTotal,
                    shipping_fee: shippingFee,
                    // Snapshot carrier choice on the order; without this we cannot reliably show
                    // which shipping provider the buyer selected after checkout.
                    shipping_sc_id: shippingOption.sc_id,
                    shipping_zone_code: shippingOption.zone_code ?? null,
                    grand_total: grandTotal,
                    coupon_code: couponResult?.coupon.co_code ?? null,
                    shipping_name: loc.locb_recipient_name,
                    shipping_phone: loc.locb_phone,
                    shipping_address: loc.locb_address,
                    remark: null,
                    payment_expires_at: buildPaymentExpiresAt(),
                    created_at: new Date(),
                    update_at: new Date(),
                }]
            );
            const orId = orderRes.insertId;
            createdOrderIds.push(orId);

            for (const item of storeItems) {
                const [itemRes] = await conn.query<ResultSetHeader>(
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

                reservationItems.push({
                    or_id: orId,
                    oi_id: itemRes.insertId,
                    pv_id: item.pv_id,
                    qty: item.qty,
                    order_no: orderNo,
                });
            }

            if (couponResult) {
                await couponService.redeemCouponForCheckout(conn, {
                    u_id: input.u_id,
                    or_id: orId,
                    co_id: couponResult.coupon.co_id,
                    co_code_snapshot: couponResult.coupon.co_code,
                    subtotal_amount: couponResult.subtotal_amount,
                    discount_amount: couponResult.discount_amount,
                });
            }
        }

        // สร้าง order pending แล้วต้องกัน stock ทันที เพื่อไม่ให้ลูกค้าคนอื่นซื้อเกิน available_qty
        await reserveInventoryForOrderItems(conn, reservationItems);
        await createShipmentGroupsForOrders(conn, createdOrderIds);

        // เอาออกเฉพาะรายการที่ถูกเลือกไปสร้าง order แล้ว รายการที่ไม่เลือกต้องอยู่ใน cart ต่อ
        await conn.query(
            "DELETE FROM Cart_items WHERE cart_id = ? AND is_selected = 1",
            [cartId]
        );

        const [remainingRows] = await conn.query<(RowDataPacket & { cnt: number })[]>(
            "SELECT COUNT(*) AS cnt FROM Cart_items WHERE cart_id = ?",
            [cartId]
        );

        await conn.query(
            "UPDATE Carts SET status = ?, updated_at = ? WHERE cart_id = ?",
            [Number(remainingRows[0]?.cnt ?? 0) > 0 ? "active" : "checked_out", new Date(), cartId]
        );

        await conn.commit();

        const orders: OrderDetailDTO[] = [];
        const shipmentMap = await getOrderShipments(createdOrderIds);
        for (const orId of createdOrderIds) {
            const [orderRows] = await conn.query<(RowDataPacket & OrderDTO)[]>(
                `${orderSelectSql} WHERE o.or_id = ?`,
                ["th", orId]
            );

            const [itemRows] = await conn.query<(RowDataPacket & OrderItemDTO)[]>(
                `${orderItemsSelectSql} WHERE oi.or_id = ? ORDER BY oi.oi_id ASC`,
                ["th", orId]
            );

            orders.push({ ...orderRows[0]!, items: itemRows, shipments: shipmentMap.get(orId) ?? [] });
        }

        await notifyManyOrderEvents(orders.map((order) => ({
            event: "order:created",
            order,
            actor: "buyer",
            targets: ["STORE"],
            title: "มีคำสั่งซื้อใหม่",
            message: `คำสั่งซื้อ ${order.order_no} รอชำระเงิน ยอด ${Number(order.grand_total).toLocaleString("th-TH")} บาท`,
            priority: "HIGH",
        })));

        return orders;
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

export async function checkoutOrder(input: CheckoutOrderInput): Promise<{ orders: OrderDetailDTO[]; payment: PaymentResultDTO }> {
    await ensureInventoryReservationTable();
    await ensureOrderShipmentLabelColumn();
    await ensureOrderShipmentTables();

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        // Checkout แบบจ่ายเงินใน transaction เดียว:
        // ถ้าบัตรถูกปฏิเสธ transaction จะ rollback ทำให้ไม่เกิด order และ cart ยังอยู่เหมือนเดิม
        const cartId = await getActiveCartId(conn, input.u_id);
        const cartItems = await getCheckoutCartItems(conn, cartId);
        const loc = await getCheckoutAddress(conn, input.u_id, input.locb_id);

        const storeGroups = Array.from(groupCartItemsByStore(cartItems).entries());
        const pendingStatusId = await getOrderStatusId(conn, "PENDING");
        const couponStoreId = input.co_code ? await getCouponStoreId(conn, input.co_code) : null;
        if (couponStoreId && !storeGroups.some(([storeId]) => storeId === couponStoreId)) {
            throw new ApiError(400, "คูปองนี้ใช้กับสินค้าในตะกร้าที่เลือกไว้ไม่ได้");
        }

        const createdOrderIds: number[] = [];
        const reservationItems: InventoryReservationItem[] = [];

        for (const [storeId, storeItems] of storeGroups) {
            const subtotal = roundMoney(storeItems.reduce((sum, i) => sum + Number(i.line_total), 0));
            const shippingOptions = await calculateCheckoutShippingOptions(conn, loc, storeItems);
            const shippingOption = pickShippingOption(shippingOptions, input.shipping_sc_id);
            const shippingFee = Number(shippingOption.price ?? 0);

            const couponResult = input.co_code && couponStoreId === storeId
                ? await couponService.validateCouponForCheckout(conn, {
                    u_id: input.u_id,
                    co_code: input.co_code,
                    st_id: storeId,
                })
                : null;

            const discountTotal = couponResult?.discount_amount ?? 0;
            const grandTotal = roundMoney(subtotal + shippingFee - discountTotal);
            const orderNo = await generateOrderNo(conn);

            const [orderRes] = await conn.query<ResultSetHeader>(
                "INSERT INTO Orders SET ?",
                [{
                    order_no: orderNo,
                    u_id: input.u_id,
                    cart_id: cartId,
                    co_id: couponResult?.coupon.co_id ?? null,
                    st_id: storeId,
                    s_id: pendingStatusId,
                    status: toLegacyOrderStatus("PENDING"),
                    subtotal,
                    discount_total: discountTotal,
                    shipping_fee: shippingFee,
                    // Snapshot carrier choice on the order; without this we cannot reliably show
                    // which shipping provider the buyer selected after checkout.
                    shipping_sc_id: shippingOption.sc_id,
                    shipping_zone_code: shippingOption.zone_code ?? null,
                    grand_total: grandTotal,
                    coupon_code: couponResult?.coupon.co_code ?? null,
                    shipping_name: loc.locb_recipient_name,
                    shipping_phone: loc.locb_phone,
                    shipping_address: loc.locb_address,
                    remark: null,
                    payment_expires_at: buildPaymentExpiresAt(),
                    created_at: new Date(),
                    update_at: new Date(),
                }]
            );
            const orId = orderRes.insertId;
            createdOrderIds.push(orId);

            for (const item of storeItems) {
                const [itemRes] = await conn.query<ResultSetHeader>(
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

                reservationItems.push({
                    or_id: orId,
                    oi_id: itemRes.insertId,
                    pv_id: item.pv_id,
                    qty: item.qty,
                    order_no: orderNo,
                });
            }

            if (couponResult) {
                await couponService.redeemCouponForCheckout(conn, {
                    u_id: input.u_id,
                    or_id: orId,
                    co_id: couponResult.coupon.co_id,
                    co_code_snapshot: couponResult.coupon.co_code,
                    subtotal_amount: couponResult.subtotal_amount,
                    discount_amount: couponResult.discount_amount,
                });
            }
        }

        // PromptPay จะยังเป็น pending หลังได้ QR จึงต้อง reserve ไว้ตั้งแต่ก่อนส่งไปชำระเงิน
        await reserveInventoryForOrderItems(conn, reservationItems);
        await createShipmentGroupsForOrders(conn, createdOrderIds);

        const [orderRows] = await conn.query<(RowDataPacket & Pick<OrderDTO, "or_id" | "order_no" | "grand_total">)[]>(
            "SELECT or_id, order_no, grand_total FROM Orders WHERE or_id IN (?) ORDER BY or_id ASC",
            [createdOrderIds]
        );

        const payment = await chargeAndRecordPayment(conn, {
            u_id: input.u_id,
            payment_method: input.payment_method,
            ...(input.omise_token ? { omise_token: input.omise_token } : {}),
            ...(input.omise_source ? { omise_source: input.omise_source } : {}),
            ...(input.saved_payment_method_id ? { saved_payment_method_id: input.saved_payment_method_id } : {}),
            ...(input.save_card ? { save_card: true } : {}),
            ...(input.payment_method === "card" ? { throwOnFailed: true } : {}),
            orders: orderRows.map((order) => ({
                or_id: Number(order.or_id),
                order_no: String(order.order_no),
                grand_total: Number(order.grand_total),
            })),
        });

        if (payment.payment_status === "failed") {
            throw new ApiError(400, "ชำระเงินไม่สำเร็จ กรุณาลองใหม่อีกครั้ง");
        }

        // ลบ cart เฉพาะหลัง payment step ผ่านแล้วเท่านั้น
        await conn.query(
            "DELETE FROM Cart_items WHERE cart_id = ? AND is_selected = 1",
            [cartId]
        );

        const [remainingRows] = await conn.query<(RowDataPacket & { cnt: number })[]>(
            "SELECT COUNT(*) AS cnt FROM Cart_items WHERE cart_id = ?",
            [cartId]
        );

        await conn.query(
            "UPDATE Carts SET status = ?, updated_at = ? WHERE cart_id = ?",
            [Number(remainingRows[0]?.cnt ?? 0) > 0 ? "active" : "checked_out", new Date(), cartId]
        );

        await conn.commit();

        const orders: OrderDetailDTO[] = [];
        const shipmentMap = await getOrderShipments(createdOrderIds);
        for (const orId of createdOrderIds) {
            const [finalOrderRows] = await conn.query<(RowDataPacket & OrderDTO)[]>(
                `${orderSelectSql} WHERE o.or_id = ?`,
                ["th", orId]
            );

            const [itemRows] = await conn.query<(RowDataPacket & OrderItemDTO)[]>(
                `${orderItemsSelectSql} WHERE oi.or_id = ? ORDER BY oi.oi_id ASC`,
                ["th", orId]
            );

            orders.push({ ...finalOrderRows[0]!, items: itemRows, shipments: shipmentMap.get(orId) ?? [] });
        }

        await notifyManyOrderEvents(orders.map((order) => {
            const isPaid = payment.payment_status === "paid";
            return {
                event: isPaid ? "order:paid" : "order:created",
                order,
                actor: "buyer",
                targets: ["STORE"],
                title: isPaid ? "ชำระเงินสำเร็จ" : "มีคำสั่งซื้อใหม่",
                message: isPaid
                    ? `คำสั่งซื้อ ${order.order_no} ชำระเงินแล้ว ยอด ${Number(order.grand_total).toLocaleString("th-TH")} บาท`
                    : `คำสั่งซื้อ ${order.order_no} รอชำระเงิน ยอด ${Number(order.grand_total).toLocaleString("th-TH")} บาท`,
                priority: isPaid ? "HIGH" : "NORMAL",
            } satisfies OrderNotificationOptions;
        }));

        return { orders, payment };
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

export async function getOrders(u_id: number, lg_code = "th"): Promise<(OrderDTO & { item_count: number; items: OrderItemDTO[] })[]> {
    await ensureOrderShipmentLabelColumn();

    const [rows] = await pool.query<(RowDataPacket & OrderDTO & { item_count: number })[]>(
        `SELECT
            o.or_id, o.order_no, o.u_id, o.cart_id, o.co_id, o.st_id, o.s_id,
            s.st_company_name,
            o.status, os.s_code AS status_code, osl.s_name AS status_label,
            latest_refund.refund_id AS refund_id,
            latest_refund.amount AS refund_amount,
            latest_refund.remark AS refund_remark,
            latest_refund.updated_at AS refund_updated_at,
            latest_refund.status AS refund_status,
            o.subtotal, o.discount_total, o.shipping_fee,
            o.shipping_sc_id,
            sc.sc_code AS shipping_carrier_code,
            sc.sc_name AS shipping_carrier_name,
            o.shipping_zone_code,
            o.tracking_no,
            o.tracking_url,
            o.label_url,
            sc.tracking_url_template,
            o.shipment_status,
            o.grand_total, o.coupon_code,
            o.shipping_name, o.shipping_phone, o.shipping_address,
            lb.zip_code AS shipping_zip_code,
            prov.name_in_thai AS shipping_province_name,
            dist.name_in_thai AS shipping_district_name,
            subdist.name_in_thai AS shipping_subdistrict_name,
            o.remark, o.payment_expires_at, o.created_at, o.update_at,
            COUNT(oi.oi_id) AS item_count
        FROM Orders o
        LEFT JOIN Store s ON s.st_id = o.st_id
        LEFT JOIN Shipping_carriers sc ON sc.sc_id = o.shipping_sc_id
        LEFT JOIN Status os ON os.s_id = o.s_id
        LEFT JOIN StatusLangs osl ON osl.s_id = os.s_id AND osl.lg_code = ?
        LEFT JOIN Locations_buyer lb
            ON lb.u_id = o.u_id
           AND lb.locb_recipient_name = o.shipping_name
           AND lb.locb_phone = o.shipping_phone
           AND lb.locb_address = o.shipping_address
        LEFT JOIN Provinces prov ON prov.id = lb.provinces_id
        LEFT JOIN Districts dist ON dist.id = lb.districts_id
        LEFT JOIN Subdistricts subdist ON subdist.id = lb.subdistricts_id
        LEFT JOIN (
            SELECT r1.or_id, r1.refund_id, r1.amount, r1.status, r1.remark, r1.updated_at
            FROM Refunds r1
            INNER JOIN (
                SELECT or_id, MAX(refund_id) AS refund_id
                FROM Refunds
                GROUP BY or_id
            ) latest ON latest.refund_id = r1.refund_id
        ) latest_refund ON latest_refund.or_id = o.or_id
        LEFT JOIN Order_items oi ON oi.or_id = o.or_id
        WHERE o.u_id = ?
        GROUP BY o.or_id
        ORDER BY o.created_at DESC`,
        [lg_code, u_id]
    );
    const itemMap = await getOrderItems(rows.map((order) => Number(order.or_id)), lg_code);
    return rows.map((order) => ({
        ...order,
        items: itemMap.get(Number(order.or_id)) ?? [],
    }));
}

export async function adminGetOrders(st_id: number): Promise<AdminOrderDTO[]> {
    await ensureOrderShipmentLabelColumn();

    const params: number[] = [];
    const storeSql = st_id === ADMIN_ALL_STORE_ID ? "" : "WHERE o.st_id = ?";
    if (storeSql) params.push(st_id);

    const [rows] = await pool.query<(RowDataPacket & AdminOrderDTO)[]>(
        `SELECT
            o.or_id, o.order_no, o.u_id, o.cart_id, o.co_id, o.st_id, o.s_id,
            s.st_company_name,
            COALESCE(NULLIF(u.u_username, ''), o.shipping_name, CONCAT('Customer #', o.u_id)) AS customer_name,
            o.status, os.s_code AS status_code, osl.s_name AS status_label,
            latest_refund.refund_id AS refund_id,
            latest_refund.amount AS refund_amount,
            latest_refund.remark AS refund_remark,
            latest_refund.updated_at AS refund_updated_at,
            latest_refund.status AS refund_status,
            o.subtotal, o.discount_total, o.shipping_fee,
            o.shipping_sc_id,
            sc.sc_code AS shipping_carrier_code,
            sc.sc_name AS shipping_carrier_name,
            o.shipping_zone_code,
            o.tracking_no,
            o.tracking_url,
            o.label_url,
            sc.tracking_url_template,
            o.shipment_status,
            o.grand_total, o.coupon_code,
            o.shipping_name, o.shipping_phone, o.shipping_address,
            lb.zip_code AS shipping_zip_code,
            prov.name_in_thai AS shipping_province_name,
            dist.name_in_thai AS shipping_district_name,
            subdist.name_in_thai AS shipping_subdistrict_name,
            o.remark, o.payment_expires_at, o.created_at, o.update_at,
            COUNT(oi.oi_id) AS item_count
        FROM Orders o
        LEFT JOIN Store s ON s.st_id = o.st_id
        LEFT JOIN Shipping_carriers sc ON sc.sc_id = o.shipping_sc_id
        LEFT JOIN Status os ON os.s_id = o.s_id
        LEFT JOIN StatusLangs osl ON osl.s_id = os.s_id AND osl.lg_code = 'th'
        LEFT JOIN (
            SELECT r1.or_id, r1.refund_id, r1.amount, r1.status, r1.remark, r1.updated_at
            FROM Refunds r1
            INNER JOIN (
                SELECT or_id, MAX(refund_id) AS refund_id
                FROM Refunds
                GROUP BY or_id
            ) latest ON latest.refund_id = r1.refund_id
        ) latest_refund ON latest_refund.or_id = o.or_id
        LEFT JOIN Users u ON u.u_id = o.u_id
        LEFT JOIN Locations_buyer lb
            ON lb.u_id = o.u_id
           AND lb.locb_recipient_name = o.shipping_name
           AND lb.locb_phone = o.shipping_phone
           AND lb.locb_address = o.shipping_address
        LEFT JOIN Provinces prov ON prov.id = lb.provinces_id
        LEFT JOIN Districts dist ON dist.id = lb.districts_id
        LEFT JOIN Subdistricts subdist ON subdist.id = lb.subdistricts_id
        LEFT JOIN Order_items oi ON oi.or_id = o.or_id
        ${storeSql}
        GROUP BY o.or_id
        ORDER BY o.created_at DESC`,
        params
    );

    return rows;
}

export async function adminGetOrderSummary(st_id: number): Promise<AdminOrderSummaryDTO> {
    const params: number[] = [];
    const storeSql = st_id === ADMIN_ALL_STORE_ID ? "" : "WHERE st_id = ?";
    if (storeSql) params.push(st_id);

    const [rows] = await pool.query<(RowDataPacket & AdminOrderSummaryDTO)[]>(
        `SELECT
            COALESCE(SUM(CASE
                WHEN DATE(o.created_at) = CURDATE()
                     AND os.s_code IN ('CONFIRMED', 'PROCESSING', 'PACKED', 'READY_TO_SHIP')
                THEN o.grand_total ELSE 0
            END), 0) AS today_sales,
            COALESCE(SUM(CASE WHEN DATE(o.created_at) = CURDATE() THEN 1 ELSE 0 END), 0) AS new_orders,
            COALESCE(SUM(CASE WHEN os.s_code = 'CONFIRMED' THEN 1 ELSE 0 END), 0) AS pending_orders,
            COALESCE(SUM(CASE WHEN os.s_code IN ('PROCESSING', 'PACKED') THEN 1 ELSE 0 END), 0) AS packing_orders,
            COALESCE(SUM(CASE WHEN os.s_code = 'READY_TO_SHIP' THEN 1 ELSE 0 END), 0) AS shipped_orders,
            COALESCE(SUM(o.discount_total), 0) AS coupon_discount_total
        FROM Orders o
        LEFT JOIN Status os ON os.s_id = o.s_id
        ${storeSql ? "WHERE o.st_id = ?" : ""}`,
        params
    );

    const summary = rows[0];
    return {
        today_sales: Number(summary?.today_sales ?? 0),
        new_orders: Number(summary?.new_orders ?? 0),
        pending_orders: Number(summary?.pending_orders ?? 0),
        packing_orders: Number(summary?.packing_orders ?? 0),
        shipped_orders: Number(summary?.shipped_orders ?? 0),
        coupon_discount_total: Number(summary?.coupon_discount_total ?? 0),
    };
}

export async function adminGetOrderById(or_id: number, st_id: number): Promise<AdminOrderDetailDTO | null> {
    await ensureOrderShipmentLabelColumn();
    await ensureOrderShipmentTables();

    const params = st_id === ADMIN_ALL_STORE_ID ? [or_id] : [or_id, st_id];
    const storeSql = st_id === ADMIN_ALL_STORE_ID ? "" : "AND o.st_id = ?";

    const [orderRows] = await pool.query<(RowDataPacket & AdminOrderDTO)[]>(
        `SELECT
            o.or_id, o.order_no, o.u_id, o.cart_id, o.co_id, o.st_id, o.s_id,
            s.st_company_name,
            COALESCE(NULLIF(u.u_username, ''), o.shipping_name, CONCAT('Customer #', o.u_id)) AS customer_name,
            o.status, os.s_code AS status_code, osl.s_name AS status_label,
            latest_refund.refund_id AS refund_id,
            latest_refund.amount AS refund_amount,
            latest_refund.remark AS refund_remark,
            latest_refund.updated_at AS refund_updated_at,
            latest_refund.status AS refund_status,
            o.subtotal, o.discount_total, o.shipping_fee,
            o.shipping_sc_id,
            sc.sc_code AS shipping_carrier_code,
            sc.sc_name AS shipping_carrier_name,
            o.shipping_zone_code,
            o.tracking_no,
            o.tracking_url,
            o.label_url,
            sc.tracking_url_template,
            o.shipment_status,
            o.grand_total, o.coupon_code,
            o.shipping_name, o.shipping_phone, o.shipping_address,
            lb.zip_code AS shipping_zip_code,
            prov.name_in_thai AS shipping_province_name,
            dist.name_in_thai AS shipping_district_name,
            subdist.name_in_thai AS shipping_subdistrict_name,
            o.remark, o.payment_expires_at, o.created_at, o.update_at,
            COUNT(oi.oi_id) AS item_count
        FROM Orders o
        LEFT JOIN Store s ON s.st_id = o.st_id
        LEFT JOIN Shipping_carriers sc ON sc.sc_id = o.shipping_sc_id
        LEFT JOIN Status os ON os.s_id = o.s_id
        LEFT JOIN StatusLangs osl ON osl.s_id = os.s_id AND osl.lg_code = 'th'
        LEFT JOIN (
            SELECT r1.or_id, r1.refund_id, r1.amount, r1.status, r1.remark, r1.updated_at
            FROM Refunds r1
            INNER JOIN (
                SELECT or_id, MAX(refund_id) AS refund_id
                FROM Refunds
                GROUP BY or_id
            ) latest ON latest.refund_id = r1.refund_id
        ) latest_refund ON latest_refund.or_id = o.or_id
        LEFT JOIN Users u ON u.u_id = o.u_id
        LEFT JOIN Locations_buyer lb
            ON lb.u_id = o.u_id
           AND lb.locb_recipient_name = o.shipping_name
           AND lb.locb_phone = o.shipping_phone
           AND lb.locb_address = o.shipping_address
        LEFT JOIN Provinces prov ON prov.id = lb.provinces_id
        LEFT JOIN Districts dist ON dist.id = lb.districts_id
        LEFT JOIN Subdistricts subdist ON subdist.id = lb.subdistricts_id
        LEFT JOIN Order_items oi ON oi.or_id = o.or_id
        WHERE o.or_id = ?
        ${storeSql}
        GROUP BY o.or_id
        LIMIT 1`,
        params
    );

    const order = orderRows[0];
    if (!order) return null;

    const [itemRows] = await pool.query<(RowDataPacket & OrderItemDTO)[]>(
        `${orderItemsSelectSql} WHERE oi.or_id = ? ORDER BY oi.oi_id ASC`,
        ["th", or_id]
    );

    const shipmentMap = await getOrderShipments([or_id]);
    return { ...order, items: itemRows, shipments: shipmentMap.get(or_id) ?? [] };
}

export async function getOrderById(or_id: number, u_id: number, lg_code = "th"): Promise<OrderDetailDTO | null> {
    await ensureOrderShipmentLabelColumn();
    await ensureOrderShipmentTables();

    const [orderRows] = await pool.query<(RowDataPacket & OrderDTO)[]>(
        `${orderSelectSql} WHERE o.or_id = ? AND o.u_id = ? LIMIT 1`,
        [lg_code, or_id, u_id]
    );

    if (!orderRows[0]) return null;

    const [itemRows] = await pool.query<(RowDataPacket & OrderItemDTO)[]>(
        `${orderItemsSelectSql} WHERE oi.or_id = ? ORDER BY oi.oi_id ASC`,
        [lg_code, or_id]
    );

    const shipmentMap = await getOrderShipments([or_id]);
    return { ...orderRows[0], items: itemRows, shipments: shipmentMap.get(or_id) ?? [] };
}

export async function cancelOrder(or_id: number, u_id: number, reason: string, lg_code = "th"): Promise<OrderDetailDTO> {
    await ensureInventoryReservationTable();
    await ensureOrderShipmentLabelColumn();

    const conn = await pool.getConnection();

    try {
        await conn.beginTransaction();

        const [orderRows] = await conn.query<(RowDataPacket & OrderDTO)[]>(
            `${orderSelectSql} WHERE o.or_id = ? AND o.u_id = ? LIMIT 1 FOR UPDATE`,
            [lg_code, or_id, u_id]
        );

        const order = orderRows[0];
        if (!order) throw new ApiError(404, "ไม่พบ order");
        if (!BUYER_CANCELLABLE_STATUS_CODES.includes(order.status_code as OrderStatusCode)) {
            throw new ApiError(400, "คำสั่งซื้อนี้ไม่สามารถยกเลิกได้แล้ว");
        }

        await setOrdersStatus(conn, [or_id], "CANCELLED", {
            remark: `Cancel reason: ${reason}`,
            whereUserId: u_id,
        });

        // ยกเลิก order pending แล้วต้องปล่อย stock ที่เคยกันไว้กลับเป็น available_qty
        await releaseReservationsForOrders(conn, [or_id]);
        await restoreCouponUsageForCancelledOrder(conn, order);
        await conn.commit();

        const cancelledOrder = await getOrderById(or_id, u_id, lg_code);
        if (!cancelledOrder) throw new ApiError(404, "ไม่พบ order");

        await notifyOrderEvent({
            event: "order:cancelled",
            order: cancelledOrder,
            actor: "buyer",
            targets: ["STORE"],
            title: "ลูกค้ายกเลิกคำสั่งซื้อ",
            message: `คำสั่งซื้อ ${cancelledOrder.order_no} ถูกยกเลิก เหตุผล: ${reason}`,
            priority: "HIGH",
        });

        return cancelledOrder;
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

export async function requestRefund(or_id: number, u_id: number, reason: string, lg_code = "th"): Promise<OrderDetailDTO> {
    await ensureOrderShipmentLabelColumn();

    const conn = await pool.getConnection();

    try {
        await conn.beginTransaction();

        const [orderRows] = await conn.query<(RowDataPacket & OrderDTO)[]>(
            `${orderSelectSql} WHERE o.or_id = ? AND o.u_id = ? LIMIT 1 FOR UPDATE`,
            [lg_code, or_id, u_id]
        );

        const order = orderRows[0];
        if (!order) throw new ApiError(404, "ไม่พบ order");
        const statusCode = order.status_code as OrderStatusCode;
        if (!REFUND_REQUESTABLE_STATUS_CODES.includes(statusCode)) {
            throw new ApiError(400, "คำสั่งซื้อนี้ยังไม่สามารถขอคืนเงินได้");
        }

        // buyer ทำได้แค่สร้าง request pending เท่านั้น
        // การเรียก Omise refund จริงควรอยู่ในฝั่งร้าน/admin หลังตรวจสอบคำขอแล้ว
        const [existingRefunds] = await conn.query<(RowDataPacket & { refund_id: number; status: string })[]>(
            "SELECT refund_id, status FROM Refunds WHERE or_id = ? AND status IN ('pending', 'succeeded') ORDER BY refund_id DESC LIMIT 1 FOR UPDATE",
            [or_id]
        );
        if (existingRefunds[0]) {
            throw new ApiError(409, "คำสั่งซื้อนี้มีคำขอคืนเงินอยู่แล้ว");
        }

        const [paymentRows] = await conn.query<(RowDataPacket & { payment_ref: string | null })[]>(
            `SELECT p.payment_ref
             FROM Payments p
             INNER JOIN Payment_orders po ON po.pay_id = p.pay_id
             WHERE po.or_id = ?
               AND p.payment_status = 'paid'
             ORDER BY p.pay_id DESC
             LIMIT 1`,
            [or_id]
        );
        const paymentRef = paymentRows[0]?.payment_ref ?? null;
        if (!paymentRef) {
            throw new ApiError(400, "ไม่พบ reference การชำระเงินสำหรับคืนเงิน");
        }

        const [refundRes] = await conn.query<ResultSetHeader>(
            `INSERT INTO Refunds
                (or_id, payment_ref, amount, status, remark, created_at, updated_at)
             VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
            [or_id, paymentRef, Number(order.grand_total).toFixed(2), reason, new Date(), new Date()]
        );

        const [itemRows] = await conn.query<(RowDataPacket & OrderItemDTO)[]>(
            `${orderItemsSelectSql} WHERE oi.or_id = ? ORDER BY oi.oi_id ASC`,
            [lg_code, or_id]
        );

        if (itemRows.length > 0) {
            const refundItems = itemRows.map((item) => [
                refundRes.insertId,
                item.oi_id,
                item.qty,
                Number(item.line_total).toFixed(2),
                new Date(),
            ]);

            await conn.query(
                "INSERT INTO Refund_items (refund_id, oi_id, qty, amount, created_at) VALUES ?",
                [refundItems]
            );
        }

        await conn.commit();

        const updatedOrder = await getOrderById(or_id, u_id, lg_code);
        if (!updatedOrder) throw new ApiError(404, "ไม่พบ order");

        await notifyOrderEvent({
            event: "order:refund_requested",
            order: updatedOrder,
            actor: "buyer",
            targets: ["STORE"],
            title: "มีคำขอคืนเงิน",
            message: `ลูกค้าขอคืนเงินคำสั่งซื้อ ${updatedOrder.order_no} เหตุผล: ${reason}`,
            priority: "URGENT",
        });

        return updatedOrder;
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

export async function approveRefundRequest(or_id: number, st_id: number, note = ""): Promise<AdminOrderDetailDTO> {
    const conn = await pool.getConnection();

    try {
        await conn.beginTransaction();

        const storeSql = st_id === ADMIN_ALL_STORE_ID ? "" : "AND o.st_id = ?";
        const params = st_id === ADMIN_ALL_STORE_ID ? [or_id] : [or_id, st_id];

        const [rows] = await conn.query<(RowDataPacket & {
            or_id: number;
            order_no: string;
            payment_ref: string | null;
            refund_id: number;
            amount: number;
            refund_status: string;
        })[]>(
            `SELECT o.or_id, o.order_no, p.payment_ref, r.refund_id, r.amount, r.status AS refund_status
             FROM Orders o
             INNER JOIN Refunds r ON r.or_id = o.or_id
             INNER JOIN Payment_orders po ON po.or_id = o.or_id
             INNER JOIN Payments p ON p.pay_id = po.pay_id
             WHERE o.or_id = ?
               ${storeSql}
               AND r.status = 'pending'
               AND p.payment_status = 'paid'
             ORDER BY r.refund_id DESC, p.pay_id DESC
             LIMIT 1
             FOR UPDATE`,
            params
        );

        const refund = rows[0];
        if (!refund) throw new ApiError(404, "ไม่พบคำขอคืนเงินที่รอดำเนินการ");
        if (!refund.payment_ref) throw new ApiError(400, "ไม่พบ payment reference สำหรับคืนเงิน");

        const omiseRefund = await createOmiseRefund({
            chargeId: refund.payment_ref,
            amount: Number(refund.amount),
            metadata: {
                order_id: String(refund.or_id),
                order_no: refund.order_no,
                refund_id: String(refund.refund_id),
            },
        });

        const remark = [note.trim(), omiseRefund.id ? `Omise refund: ${omiseRefund.id}` : null]
            .filter(Boolean)
            .join(" | ");

        await conn.query(
            "UPDATE Refunds SET status = 'succeeded', remark = ?, updated_at = ? WHERE refund_id = ?",
            [remark || "Approved refund", new Date(), refund.refund_id]
        );

        await setOrdersStatus(conn, [or_id], "REFUNDED", {
            remark: remark || "Refund approved",
        });

        await conn.commit();

        const order = await adminGetOrderById(or_id, st_id);
        if (!order) throw new ApiError(404, "ไม่พบ order");

        await notifyOrderEvent({
            event: "order:refund_approved",
            order,
            actor: "admin",
            targets: ["USER", "STORE"],
            title: "อนุมัติคืนเงินแล้ว",
            message: `คำสั่งซื้อ ${order.order_no} ได้รับการอนุมัติคืนเงินแล้ว`,
            priority: "HIGH",
        });

        return order;
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

export async function adminUpdateOrderStatus(
    or_id: number,
    st_id: number,
    statusCode: OrderStatusCode,
    note = ""
): Promise<AdminOrderDetailDTO> {
    await ensureOrderShipmentLabelColumn();

    const conn = await pool.getConnection();

    try {
        await conn.beginTransaction();

        const storeSql = st_id === ADMIN_ALL_STORE_ID ? "" : "AND o.st_id = ?";
        const params = st_id === ADMIN_ALL_STORE_ID ? [or_id] : [or_id, st_id];

        const [rows] = await conn.query<(RowDataPacket & {
            or_id: number;
            order_no: string;
            status_code: string | null;
            refund_status: string | null;
        })[]>(
            `SELECT o.or_id, o.order_no, os.s_code AS status_code, latest_refund.status AS refund_status
             FROM Orders o
             LEFT JOIN Status os ON os.s_id = o.s_id
             LEFT JOIN (
                SELECT r1.or_id, r1.status
                FROM Refunds r1
                INNER JOIN (
                    SELECT or_id, MAX(refund_id) AS refund_id
                    FROM Refunds
                    GROUP BY or_id
                ) latest ON latest.refund_id = r1.refund_id
             ) latest_refund ON latest_refund.or_id = o.or_id
             WHERE o.or_id = ?
               ${storeSql}
             LIMIT 1
             FOR UPDATE`,
            params
        );

        const order = rows[0];
        if (!order) throw new ApiError(404, "ไม่พบ order");
        if (order.refund_status === "pending") {
            throw new ApiError(400, "คำสั่งซื้อนี้มีคำขอคืนเงินรอตรวจสอบ กรุณาดำเนินการคำขอคืนเงินก่อน");
        }

        const currentCode = order.status_code ?? "";
        const allowedNext = ADMIN_STATUS_TRANSITIONS[currentCode];
        if (allowedNext !== statusCode) {
            throw new ApiError(400, `ไม่สามารถเปลี่ยนสถานะจาก ${currentCode || "-"} เป็น ${statusCode} ได้`);
        }

        await setOrdersStatus(conn, [or_id], statusCode, {
            remark: note.trim() || `Admin changed status to ${statusCode}`,
        });

        if (statusCode === "READY_TO_SHIP") {
            await createShipmentForOrder(conn, or_id, st_id);
        }

        await conn.commit();

        const updated = await adminGetOrderById(or_id, st_id);
        if (!updated) throw new ApiError(404, "ไม่พบ order");

        await notifyOrderEvent({
            event: "order:status_updated",
            order: updated,
            actor: "admin",
            targets: ["USER"],
            title: "อัปเดตสถานะคำสั่งซื้อ",
            message: `คำสั่งซื้อ ${updated.order_no} เปลี่ยนสถานะเป็น ${getOrderStatusLabel(updated)}`,
            priority: statusCode === "READY_TO_SHIP" ? "HIGH" : "NORMAL",
        });

        return updated;
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

function buildTrackingUrl(template: string | null | undefined, trackingNo: string): string | null {
    if (!template?.trim()) return null;

    // Phase 2: ยังไม่ยิง API ขนส่งจริง แต่ใช้ template ของ carrier เพื่อสร้างลิงก์ tracking ให้อัตโนมัติ
    // รองรับ placeholder หลัก {tracking_no}; ถ้า admin ใส่ URL ที่ไม่มี placeholder จะต่อเลขพัสดุท้าย URL ให้
    const trimmed = template.trim();
    if (trimmed.includes("{tracking_no}")) {
        return trimmed.replaceAll("{tracking_no}", encodeURIComponent(trackingNo));
    }

    const separator = trimmed.endsWith("/") ? "" : "/";
    return `${trimmed}${separator}${encodeURIComponent(trackingNo)}`;
}

function positiveEnvNumber(name: string, fallback: number): number {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function createShipmentForOrder(
    conn: PoolConnection,
    or_id: number,
    st_id: number
): Promise<void> {
    await ensureOrderShipmentTables();

    const storeSql = st_id === ADMIN_ALL_STORE_ID ? "" : "AND o.st_id = ?";
    const params = st_id === ADMIN_ALL_STORE_ID ? [or_id] : [or_id, st_id];

    const [rows] = await conn.query<(RowDataPacket & {
        or_id: number;
        order_no: string;
        st_id: number;
        st_company_name: string | null;
        st_phone: string | null;
        st_email: string | null;
        status_code: string | null;
        shipping_name: string;
        shipping_phone: string;
        shipping_address: string;
        shipping_zip_code: string | null;
        shipping_province_name: string | null;
        shipping_district_name: string | null;
        shipping_subdistrict_name: string | null;
        grand_total: number;
        item_count: number;
        shipping_carrier_code: string | null;
        tracking_no: string | null;
        sender_address: string | null;
        sender_zip_code: string | null;
        sender_province_name: string | null;
        sender_district_name: string | null;
        sender_subdistrict_name: string | null;
    })[]>(
        `SELECT
            o.or_id,
            o.order_no,
            o.st_id,
            st.st_company_name,
            st.st_phone,
            st.st_email,
            os.s_code AS status_code,
            o.shipping_name,
            o.shipping_phone,
            o.shipping_address,
            lb.zip_code AS shipping_zip_code,
            prov.name_in_thai AS shipping_province_name,
            dist.name_in_thai AS shipping_district_name,
            subdist.name_in_thai AS shipping_subdistrict_name,
            o.grand_total,
            COUNT(oi.oi_id) AS item_count,
            sc.sc_code AS shipping_carrier_code,
            o.tracking_no,
            loc.loc_address AS sender_address,
            loc.zip_code AS sender_zip_code,
            sender_prov.name_in_thai AS sender_province_name,
            sender_dist.name_in_thai AS sender_district_name,
            sender_subdist.name_in_thai AS sender_subdistrict_name
         FROM Orders o
         LEFT JOIN Store st ON st.st_id = o.st_id
         LEFT JOIN Status os ON os.s_id = o.s_id
         LEFT JOIN Shipping_carriers sc ON sc.sc_id = o.shipping_sc_id
         LEFT JOIN Order_items oi ON oi.or_id = o.or_id
         LEFT JOIN Locations_buyer lb
            ON lb.u_id = o.u_id
           AND lb.locb_recipient_name = o.shipping_name
           AND lb.locb_phone = o.shipping_phone
           AND lb.locb_address = o.shipping_address
         LEFT JOIN Provinces prov ON prov.id = lb.provinces_id
         LEFT JOIN Districts dist ON dist.id = lb.districts_id
         LEFT JOIN Subdistricts subdist ON subdist.id = lb.subdistricts_id
         LEFT JOIN Locations loc ON loc.st_id = o.st_id AND loc.is_default = 1
         LEFT JOIN Provinces sender_prov ON sender_prov.id = loc.Provinces_id
         LEFT JOIN Districts sender_dist ON sender_dist.id = loc.Districts_id
         LEFT JOIN Subdistricts sender_subdist ON sender_subdist.id = loc.Subdistricts_id
         WHERE o.or_id = ?
           ${storeSql}
         GROUP BY o.or_id
         LIMIT 1
         FOR UPDATE`,
        params
    );

    const order = rows[0];
    if (!order) throw new ApiError(404, "ไม่พบ order");
    if (order.status_code !== "READY_TO_SHIP") {
        throw new ApiError(400, "สร้าง shipment ได้หลังเปลี่ยนสถานะเป็น READY_TO_SHIP เท่านั้น");
    }
    if (!order.shipping_carrier_code) throw new ApiError(400, "คำสั่งซื้อนี้ยังไม่มีข้อมูลขนส่ง");
    if (order.tracking_no) throw new ApiError(400, "คำสั่งซื้อนี้มีเลขพัสดุแล้ว");

    if (!order.shipping_zip_code) {
        throw new ApiError(400, "คำสั่งซื้อนี้ไม่มีรหัสไปรษณีย์ผู้รับสำหรับสร้าง shipment");
    }

    let [shipmentRows] = await conn.query<(RowDataPacket & {
        os_id: number;
        shipment_no: string;
        sender_name: string;
        sender_phone: string | null;
        sender_email: string | null;
        sender_address: string;
        sender_zip_code: string | null;
        sender_province_name: string | null;
        sender_district_name: string | null;
        sender_subdistrict_name: string | null;
        recipient_name: string;
        recipient_phone: string | null;
        recipient_address: string;
        recipient_zip_code: string | null;
        recipient_province_name: string | null;
        recipient_district_name: string | null;
        recipient_subdistrict_name: string | null;
    })[]>(
        `SELECT
            os_id,
            shipment_no,
            sender_name,
            sender_phone,
            sender_email,
            sender_address,
            sender_zip_code,
            sender_province_name,
            sender_district_name,
            sender_subdistrict_name,
            recipient_name,
            recipient_phone,
            recipient_address,
            recipient_zip_code,
            recipient_province_name,
            recipient_district_name,
            recipient_subdistrict_name
         FROM Order_shipments
         WHERE or_id = ?
         ORDER BY os_id ASC
         FOR UPDATE`,
        [or_id]
    );

    if (!shipmentRows.length) {
        await createShipmentGroupsForOrders(conn, [or_id]);
        [shipmentRows] = await conn.query<typeof shipmentRows>(
            `SELECT
                os_id,
                shipment_no,
                sender_name,
                sender_phone,
                sender_email,
                sender_address,
                sender_zip_code,
                sender_province_name,
                sender_district_name,
                sender_subdistrict_name,
                recipient_name,
                recipient_phone,
                recipient_address,
                recipient_zip_code,
                recipient_province_name,
                recipient_district_name,
                recipient_subdistrict_name
             FROM Order_shipments
             WHERE or_id = ?
             ORDER BY os_id ASC
             FOR UPDATE`,
            [or_id]
        );
    }

    if (!shipmentRows.length) {
        throw new ApiError(400, "คำสั่งซื้อนี้ยังไม่มีข้อมูล shipment ตามคลังที่ถูกตัด stock");
    }

    const trackingNos: string[] = [];
    const trackingUrls: string[] = [];
    const labelUrls: string[] = [];
    const statuses: string[] = [];

    for (const shipment of shipmentRows) {
        if (!shipment.sender_address || !shipment.sender_zip_code) {
            throw new ApiError(400, `Shipment ${shipment.shipment_no} ยังไม่มีที่อยู่ผู้ส่งครบถ้วน`);
        }
        if (!shipment.recipient_zip_code) {
            throw new ApiError(400, `Shipment ${shipment.shipment_no} ยังไม่มีรหัสไปรษณีย์ผู้รับ`);
        }

        const [itemRows] = await conn.query<(RowDataPacket & {
            sku: string | null;
            product_name: string;
            qty: number;
            unit_price: number;
        })[]>(
            `SELECT
                oi.sku,
                oi.product_name,
                osi.qty,
                oi.unit_price
             FROM Order_shipment_items osi
             INNER JOIN Order_items oi ON oi.oi_id = osi.oi_id
             WHERE osi.os_id = ?
             ORDER BY osi.osi_id ASC`,
            [shipment.os_id]
        );

        const firstItemName = itemRows[0]?.product_name ?? shipment.shipment_no;
        const totalQty = itemRows.reduce((sum, item) => sum + Number(item.qty ?? 0), 0);

        const result = await createShippopShipment({
            email: shipment.sender_email ?? order.st_email ?? "",
            orderNo: shipment.shipment_no,
            courierCode: order.shipping_carrier_code,
            from: {
                name: shipment.sender_name,
                address: shipment.sender_address,
                district: shipment.sender_subdistrict_name,
                state: shipment.sender_district_name,
                province: shipment.sender_province_name,
                postcode: shipment.sender_zip_code,
                tel: shipment.sender_phone ?? order.st_phone ?? "",
                email: shipment.sender_email ?? order.st_email,
            },
            to: {
                name: shipment.recipient_name,
                address: shipment.recipient_address,
                district: shipment.recipient_subdistrict_name,
                state: shipment.recipient_district_name,
                province: shipment.recipient_province_name,
                postcode: shipment.recipient_zip_code,
                tel: shipment.recipient_phone ?? order.shipping_phone,
            },
            parcel: {
                name: firstItemName,
                weight: positiveEnvNumber("SHIPPOP_DEFAULT_WEIGHT_G", 1000),
                width: positiveEnvNumber("SHIPPOP_DEFAULT_WIDTH_CM", 20),
                length: positiveEnvNumber("SHIPPOP_DEFAULT_LENGTH_CM", 30),
                height: positiveEnvNumber("SHIPPOP_DEFAULT_HEIGHT_CM", 10),
            },
            products: itemRows.map((item, index) => ({
                product_code: item.sku ?? `${shipment.shipment_no}-${index + 1}`,
                name: item.product_name,
                price: Number(item.unit_price ?? 0),
                amount: Number(item.qty ?? 1),
                weight: positiveEnvNumber("SHIPPOP_DEFAULT_ITEM_WEIGHT_G", 500),
            })),
            declaredValue: Number(order.grand_total ?? 0),
            remark: `Order ${order.order_no} / ${shipment.shipment_no} (${Math.max(totalQty, 1)} items)`,
        });

        await conn.query(
            `UPDATE Order_shipments
             SET tracking_no = ?,
                 tracking_url = ?,
                 label_url = ?,
                 status = ?,
                 updated_at = ?
             WHERE os_id = ?`,
            [result.shippopTrackingCode, result.trackingUrl, result.labelUrl, result.shipmentStatus, new Date(), shipment.os_id]
        );

        trackingNos.push(result.shippopTrackingCode);
        if (result.trackingUrl) trackingUrls.push(result.trackingUrl);
        if (result.labelUrl) labelUrls.push(result.labelUrl);
        if (result.shipmentStatus) statuses.push(result.shipmentStatus);
    }

    // Order-level tracking ยังเก็บไว้เพื่อ compatibility กับหน้ารายการเดิม ส่วนข้อมูลจริงรายกล่องอยู่ที่ Order_shipments
    await conn.query(
        `UPDATE Orders
         SET tracking_no = ?,
             tracking_url = ?,
             label_url = ?,
             shipment_status = ?,
             update_at = ?
         WHERE or_id = ?`,
        [
            trackingNos.join(", "),
            trackingUrls[0] ?? null,
            labelUrls[0] ?? null,
            Array.from(new Set(statuses)).join(", ") || "label_created",
            new Date(),
            or_id,
        ]
    );
}

export async function adminUpdateOrderTracking(
    or_id: number,
    st_id: number,
    trackingNoInput: string
): Promise<AdminOrderDetailDTO> {
    await ensureOrderShipmentTables();

    const trackingNo = trackingNoInput.trim();
    if (trackingNo.length < 3) throw new ApiError(400, "กรุณาระบุเลขพัสดุ");

    const conn = await pool.getConnection();

    try {
        await conn.beginTransaction();

        const storeSql = st_id === ADMIN_ALL_STORE_ID ? "" : "AND o.st_id = ?";
        const params = st_id === ADMIN_ALL_STORE_ID ? [or_id] : [or_id, st_id];

        const [rows] = await conn.query<(RowDataPacket & {
            or_id: number;
            tracking_url_template: string | null;
        })[]>(
            `SELECT o.or_id, sc.tracking_url_template
             FROM Orders o
             LEFT JOIN Shipping_carriers sc ON sc.sc_id = o.shipping_sc_id
             WHERE o.or_id = ?
               ${storeSql}
             LIMIT 1
             FOR UPDATE`,
            params
        );

        const order = rows[0];
        if (!order) throw new ApiError(404, "ไม่พบ order");

        const trackingUrl = buildTrackingUrl(order.tracking_url_template, trackingNo);

        await conn.query(
            `UPDATE Orders
             SET tracking_no = ?,
                 tracking_url = ?,
                 shipment_status = COALESCE(NULLIF(shipment_status, ''), 'label_created'),
                 update_at = ?
             WHERE or_id = ?`,
            [trackingNo, trackingUrl, new Date(), or_id]
        );

        // ถ้า order มี shipment เดียว ให้เลขพัสดุที่แก้ด้วยมือ sync ลงกล่องนั้นด้วย
        // แต่ถ้ามีหลาย shipment จะไม่เดา เพราะแต่ละคลังควรมีเลขพัสดุแยกกัน
        const [shipmentCountRows] = await conn.query<(RowDataPacket & { cnt: number })[]>(
            "SELECT COUNT(*) AS cnt FROM Order_shipments WHERE or_id = ?",
            [or_id]
        );
        if (Number(shipmentCountRows[0]?.cnt ?? 0) === 1) {
            await conn.query(
                `UPDATE Order_shipments
                 SET tracking_no = ?,
                     tracking_url = ?,
                     status = COALESCE(NULLIF(status, ''), 'label_created'),
                     updated_at = ?
                 WHERE or_id = ?`,
                [trackingNo, trackingUrl, new Date(), or_id]
            );
        }

        await conn.commit();

        const updated = await adminGetOrderById(or_id, st_id);
        if (!updated) throw new ApiError(404, "ไม่พบ order");

        await notifyOrderEvent({
            event: "order:tracking_updated",
            order: updated,
            actor: "admin",
            targets: ["USER"],
            title: "อัปเดตเลขพัสดุ",
            message: `คำสั่งซื้อ ${updated.order_no} มีเลขพัสดุ ${updated.tracking_no ?? trackingNo}`,
            priority: "HIGH",
        });

        return updated;
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

export async function adminCreateOrderShipment(
    or_id: number,
    st_id: number
): Promise<AdminOrderDetailDTO> {
    await ensureOrderShipmentLabelColumn();
    await ensureOrderShipmentTables();

    const conn = await pool.getConnection();

    try {
        await conn.beginTransaction();

        const storeSql = st_id === ADMIN_ALL_STORE_ID ? "" : "AND o.st_id = ?";
        const params = st_id === ADMIN_ALL_STORE_ID ? [or_id] : [or_id, st_id];

        const [rows] = await conn.query<(RowDataPacket & {
            or_id: number;
            status_code: string | null;
            refund_status: string | null;
        })[]>(
            `SELECT o.or_id, os.s_code AS status_code, latest_refund.status AS refund_status
             FROM Orders o
             LEFT JOIN Status os ON os.s_id = o.s_id
             LEFT JOIN (
                SELECT r1.or_id, r1.status
                FROM Refunds r1
                INNER JOIN (
                    SELECT or_id, MAX(refund_id) AS refund_id
                    FROM Refunds
                    GROUP BY or_id
                ) latest ON latest.refund_id = r1.refund_id
             ) latest_refund ON latest_refund.or_id = o.or_id
             WHERE o.or_id = ?
               ${storeSql}
             LIMIT 1
             FOR UPDATE`,
            params
        );

        const order = rows[0];
        if (!order) throw new ApiError(404, "ไม่พบ order");
        if (order.refund_status === "pending") {
            throw new ApiError(400, "คำสั่งซื้อนี้มีคำขอคืนเงินรอตรวจสอบ กรุณาดำเนินการคำขอคืนเงินก่อน");
        }
        if (order.status_code !== "PACKED") {
            throw new ApiError(400, "สร้าง shipment ได้จากสถานะ PACKED เท่านั้น");
        }

        await setOrdersStatus(conn, [or_id], "READY_TO_SHIP", {
            remark: "Admin marked order ready to ship and shipment was created",
        });

        await createShipmentForOrder(conn, or_id, st_id);

        await conn.commit();

        const updated = await adminGetOrderById(or_id, st_id);
        if (!updated) throw new ApiError(404, "ไม่พบ order");

        await notifyOrderEvent({
            event: "order:status_updated",
            order: updated,
            actor: "admin",
            targets: ["USER"],
            title: "คำสั่งซื้อพร้อมจัดส่ง",
            message: `คำสั่งซื้อ ${updated.order_no} พร้อมจัดส่งแล้ว${updated.tracking_no ? ` เลขพัสดุ ${updated.tracking_no}` : ""}`,
            priority: "HIGH",
        });

        return updated;
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

export async function rejectRefundRequest(or_id: number, st_id: number, note: string): Promise<AdminOrderDetailDTO> {
    if (note.trim().length < 3) throw new ApiError(400, "กรุณาระบุเหตุผลในการปฏิเสธคำขอคืนเงิน");

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        const storeSql = st_id === ADMIN_ALL_STORE_ID ? "" : "AND o.st_id = ?";
        const params = st_id === ADMIN_ALL_STORE_ID ? [or_id] : [or_id, st_id];

        const [rows] = await conn.query<(RowDataPacket & { refund_id: number })[]>(
            `SELECT r.refund_id
             FROM Orders o
             INNER JOIN Refunds r ON r.or_id = o.or_id
             WHERE o.or_id = ?
               ${storeSql}
               AND r.status = 'pending'
             ORDER BY r.refund_id DESC
             LIMIT 1
             FOR UPDATE`,
            params
        );

        const refund = rows[0];
        if (!refund) throw new ApiError(404, "ไม่พบคำขอคืนเงินที่รอดำเนินการ");

        await conn.query(
            "UPDATE Refunds SET status = 'failed', remark = ?, updated_at = ? WHERE refund_id = ?",
            [note.trim(), new Date(), refund.refund_id]
        );

        await conn.commit();

        const order = await adminGetOrderById(or_id, st_id);
        if (!order) throw new ApiError(404, "ไม่พบ order");

        await notifyOrderEvent({
            event: "order:refund_rejected",
            order,
            actor: "admin",
            targets: ["USER", "STORE"],
            title: "คำขอคืนเงินไม่ผ่านการอนุมัติ",
            message: `คำขอคืนเงินคำสั่งซื้อ ${order.order_no} ไม่ผ่านการอนุมัติ เหตุผล: ${note.trim()}`,
            priority: "HIGH",
        });

        return order;
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

export async function expirePendingPaymentOrders(limit = 50): Promise<number> {
    await ensureInventoryReservationTable();
    await ensureOrderShipmentLabelColumn();

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        const [expiredOrders] = await conn.query<(RowDataPacket & OrderDTO)[]>(
            `${orderSelectSql}
             WHERE os.s_code = 'PENDING'
               AND o.payment_expires_at IS NOT NULL
               AND o.payment_expires_at <= NOW()
             ORDER BY o.payment_expires_at ASC
             LIMIT ?
             FOR UPDATE`,
            ["th", limit]
        );

        const orderIds = expiredOrders.map((order) => Number(order.or_id));
        if (orderIds.length === 0) {
            await conn.commit();
            return 0;
        }

        // หมดเวลาชำระเงินแล้ว: ปิด order pending และคืน stock ที่เคย reserve ไว้
        await setOrdersStatus(conn, orderIds, "CANCELLED", { remark: "Payment expired" });

        await releaseReservationsForOrders(conn, orderIds);
        for (const order of expiredOrders) {
            await restoreCouponUsageForCancelledOrder(conn, order);
        }

        await conn.commit();

        await notifyManyOrderEvents(expiredOrders.map((order) => ({
            event: "order:payment_expired",
            order: {
                ...order,
                status_code: "CANCELLED",
                status_label: statusLabelByCode.CANCELLED ?? "ยกเลิก",
                status: toLegacyOrderStatus("CANCELLED"),
            },
            actor: "system",
            targets: ["STORE", "USER"],
            title: "คำสั่งซื้อหมดเวลาชำระเงิน",
            message: `คำสั่งซื้อ ${order.order_no} ถูกยกเลิกอัตโนมัติเนื่องจากหมดเวลาชำระเงิน`,
            priority: "NORMAL",
        })));

        return orderIds.length;
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

export function startPaymentExpirationJob(intervalMs = 60_000): void {
    if (expirationJobStarted) return;
    expirationJobStarted = true;

    const run = async () => {
        try {
            const expiredCount = await expirePendingPaymentOrders();
            if (expiredCount > 0) {
                console.log(`[orders] expired ${expiredCount} pending payment order(s)`);
            }
        } catch (err) {
            console.error("[orders] expire pending payments failed:", err);
        }
    };

    // รันทันทีตอน API เริ่ม และวนซ้ำเพื่อคืน reserved_qty ของ order ที่เลยเวลาจ่าย
    void run();
    setInterval(() => { void run(); }, intervalMs);
}
