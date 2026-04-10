
export type ProductShopDTO = {
    p_id: number
    p_isActive: boolean
    name: string
    title: string
    ip_image_url: string | null
    min_price: number
    max_price: number
    discount: number
    c_id: number
    ctl_id: number
    ctl_name: string
    b_id: number
    b_name: string
    has_price_range: 0 | 1
    tags: {
        ptag_id: number
        ptag_name: string
    }[]
}


export type ProductTagDTO = {
    ptag_id: number;
    ptag_name: string;
};

export type ProductShopDetailDTO = {
    p_id: number;
    p_isActive: number;
    p_description: string;
    st_id: number;
    name: string;
    cl_name: string;
    ps_name: string;
    title: string;
    c_id: number;
    ctl_id: number;
    ctl_name: string;
    b_id: number;
    b_name: string;
    st_company_name: string;
    st_image: string;
    min_price: number;
    max_price: number;
    discount: number;
    has_price_range: number;
    thumbnail: string | null;
    tags: ProductTagDTO[];
};

export type ProductImageDTO = {
    ip_id: number;
    ip_image_url: string;
    is_primary: number | null;
};

export type ProductVariantDTO = {
    pv_id: number;
    pv_sku: string;
    pv_cost: number;
    pv_price: number;
    discount: number;
    is_default: number;
    image_url: string | null;
    weight_g: number;
    length_cm: number;
    width_cm: number;
    height_cm: number;
    unit_id: number;
    unit_name: string | null;
    on_hand: number;
    reserved_qty: number;
    variant_label: string | null;
};

export type ProductOptionItemDTO = {
    poi_id: number;
    poi_value: string;
};

export type ProductOptionGroupDTO = {
    potn_id: number;
    otype_id: number;
    otype_code: string;
    otype_name: string;
    items: ProductOptionItemDTO[];
};

export type InventoryStoreDTO = {
    InventoryStore: string;
};

export type LandignPageNamgeDTO = {
    lp_id: number
    lp_title: string
    lp_imag_url: string
    lp_slug: string
    p_id: number
    lg_code: string
    st_id: number
};



export type ProductShopByIdResponse = {
    product: ProductShopDetailDTO;
    images: ProductImageDTO[];
    variants: ProductVariantDTO[];
    options: ProductOptionGroupDTO[];
    InventoryStore: InventoryStoreDTO[];
    landingPage: LandignPageNamgeDTO[];
};

