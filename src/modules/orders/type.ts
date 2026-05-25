export type CreateOrderInput = {
    u_id: number;
    locb_id: number;
    co_code?: string | null;
    shipping_sc_id?: number | null;
};

export type OrderItemDTO = {
    oi_id: number;
    or_id: number;
    p_id: number;
    pv_id: number;
    sku: string | null;
    product_name: string;
    variant_name: string | null;
    unit_price: number;
    discount_amount: number;
    qty: number;
    line_total: number;
    cost_snapshot: number;
    created_at: string;
};

export type OrderDTO = {
    or_id: number;
    order_no: string;
    u_id: number;
    cart_id: number;
    co_id: number | null;
    s_id: number | null;
    status: string;
    subtotal: number;
    discount_total: number;
    shipping_fee: number;
    grand_total: number;
    coupon_code: string | null;
    shipping_name: string;
    shipping_phone: string;
    shipping_address: string;
    remark: string | null;
    created_at: string;
    update_at: string;
};

export type OrderDetailDTO = OrderDTO & {
    items: OrderItemDTO[];
};
