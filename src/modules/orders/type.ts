export type CreateOrderInput = {
    u_id: number;
    locb_id: number;
    co_code?: string | null;
    shipping_sc_id?: number | null;
};

export type CheckoutOrderInput = CreateOrderInput & {
    payment_method: "card" | "promptpay";
    omise_token?: string;
    omise_source?: string;
    saved_payment_method_id?: number;
    save_card?: boolean;
};

export type OrderItemDTO = {
    oi_id: number;
    or_id: number;
    p_id: number;
    pv_id: number;
    sku: string | null;
    image_url?: string | null;
    product_name: string;
    variant_name: string | null;
    unit_price: number;
    discount_amount: number;
    qty: number;
    line_total: number;
    cost_snapshot: number;
    st_id?: number;
    st_company_name?: string | null;
    created_at: string;
};

export type OrderShipmentItemDTO = {
    osi_id: number;
    os_id: number;
    oi_id: number;
    pv_id: number;
    sku: string | null;
    product_name: string;
    variant_name: string | null;
    qty: number;
};

export type OrderShipmentDTO = {
    os_id: number;
    or_id: number;
    loc_id: number;
    shipment_no: string;
    status: string;
    tracking_no?: string | null;
    tracking_url?: string | null;
    label_url?: string | null;
    sender_name: string;
    sender_phone?: string | null;
    sender_email?: string | null;
    sender_address: string;
    sender_zip_code?: string | null;
    sender_province_name?: string | null;
    sender_district_name?: string | null;
    sender_subdistrict_name?: string | null;
    recipient_name: string;
    recipient_phone?: string | null;
    recipient_address: string;
    recipient_zip_code?: string | null;
    recipient_province_name?: string | null;
    recipient_district_name?: string | null;
    recipient_subdistrict_name?: string | null;
    item_count: number;
    total_qty: number;
    items?: OrderShipmentItemDTO[];
};

export type OrderDTO = {
    or_id: number;
    order_no: string;
    u_id: number;
    cart_id: number;
    co_id: number | null;
    st_id: number;
    st_company_name?: string | null;
    s_id: number | null;
    status: string;
    status_code?: string | null;
    status_label?: string | null;
    refund_status?: "pending" | "succeeded" | "failed" | null;
    refund_id?: number | null;
    refund_amount?: number | null;
    refund_remark?: string | null;
    refund_updated_at?: string | null;
    subtotal: number;
    discount_total: number;
    shipping_fee: number;
    shipping_sc_id?: number | null;
    shipping_carrier_code?: string | null;
    shipping_carrier_name?: string | null;
    shipping_zone_code?: string | null;
    tracking_no?: string | null;
    tracking_url?: string | null;
    label_url?: string | null;
    tracking_url_template?: string | null;
    shipment_status?: string | null;
    grand_total: number;
    coupon_code: string | null;
    shipping_name: string;
    shipping_phone: string;
    shipping_address: string;
    shipping_zip_code?: string | null;
    shipping_province_name?: string | null;
    shipping_district_name?: string | null;
    shipping_subdistrict_name?: string | null;
    remark: string | null;
    payment_expires_at?: string | null;
    created_at: string;
    update_at: string;
};

export type AdminOrderDTO = OrderDTO & {
    customer_name: string;
    item_count: number;
};

export type AdminOrderSummaryDTO = {
    today_sales: number;
    new_orders: number;
    pending_orders: number;
    packing_orders: number;
    shipped_orders: number;
    coupon_discount_total: number;
};

export type OrderDetailDTO = OrderDTO & {
    items: OrderItemDTO[];
    shipments?: OrderShipmentDTO[];
};
