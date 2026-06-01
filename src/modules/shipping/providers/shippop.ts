import { ApiError } from "../../../shared/errors/ApiError.js";

export type ShippopAddress = {
  name: string;
  address: string;
  district?: string | null;
  state?: string | null;
  province?: string | null;
  postcode: string;
  tel: string;
  email?: string | null;
};

export type ShippopParcel = {
  name: string;
  weight: number;
  width: number;
  length: number;
  height: number;
};

export type ShippopCreateShipmentInput = {
  email: string;
  orderNo: string;
  courierCode: string;
  from: ShippopAddress;
  to: ShippopAddress;
  parcel: ShippopParcel;
  products: Array<{
    product_code: string;
    name: string;
    price: number;
    amount: number;
    weight: number;
  }>;
  declaredValue: number;
  codAmount?: number;
  remark?: string | null;
};

export type ShippopQuoteInput = {
  from: ShippopAddress;
  to: ShippopAddress;
  parcel: ShippopParcel;
};

export type ShippopQuoteResult = {
  courierCode: string;
  courierName: string | null;
  price: number;
  raw: unknown;
};

export type ShippopShipmentResult = {
  purchaseId: number | null;
  shippopTrackingCode: string;
  courierTrackingCode: string | null;
  courierCode: string;
  shipmentStatus: string;
  trackingUrl: string;
  labelUrl: string | null;
  raw: unknown;
};

const DEFAULT_DEV_URL = "https://mkpservice.shippop.dev";
const DEFAULT_PROD_URL = "https://mkpservice.shippop.com";

function getBaseUrl() {
  const configured = process.env.SHIPPOP_BASE_URL?.trim();
  if (configured) return configured.replace(/\/$/, "");
  return process.env.SHIPPOP_MODE === "production" ? DEFAULT_PROD_URL : DEFAULT_DEV_URL;
}

function getApiKey() {
  const apiKey = process.env.SHIPPOP_API_KEY?.trim();
  if (!apiKey) throw new ApiError(400, "ยังไม่ได้ตั้งค่า SHIPPOP_API_KEY");
  return apiKey;
}

function getEmail(inputEmail: string) {
  const email = process.env.SHIPPOP_EMAIL?.trim() || inputEmail?.trim();
  if (!email) throw new ApiError(400, "ยังไม่ได้ตั้งค่า SHIPPOP_EMAIL หรืออีเมลร้านค้า");
  return email;
}

function normalizePhone(value: string) {
  return value.replace(/\D/g, "").slice(0, 12);
}

function toShippopAddress(address: ShippopAddress) {
  return {
    province: address.province ?? "",
    state: address.state ?? "",
    district: address.district ?? "",
    postcode: address.postcode,
    address: address.address,
    name: address.name,
    tel: normalizePhone(address.tel),
    email: address.email ?? "",
  };
}

function trackingUrl(trackingCode: string) {
  return `https://www.shippop.com/tracking/?tracking_code=${encodeURIComponent(trackingCode)}`;
}

function labelUrl(trackingCode: string) {
  return `${getBaseUrl()}/label_tracking_code/?tracking_code=${encodeURIComponent(trackingCode)}`;
}

async function postShippop<T>(path: string, payload: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${getBaseUrl()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: getApiKey(),
      ...payload,
    }),
  });

  const raw = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(502, "เรียก SHIPPOP API ไม่สำเร็จ");
  if (raw?.status === false) {
    const message = raw?.message || raw?.error || raw?.notice || "SHIPPOP ปฏิเสธรายการ";
    throw new ApiError(400, Array.isArray(message) ? message.join(", ") : String(message));
  }

  return raw as T;
}

function firstDataObject(raw: unknown): Record<string, unknown> {
  const data = (raw as { data?: unknown })?.data;
  if (!data || typeof data !== "object") return {};
  if (Array.isArray(data)) return (data[0] as Record<string, unknown>) ?? {};

  const values = Object.values(data as Record<string, unknown>);
  return (values[0] as Record<string, unknown>) ?? {};
}

function firstConfirmObject(raw: unknown): Record<string, unknown> {
  const result = (raw as { result?: unknown })?.result;
  if (!result || typeof result !== "object") return {};
  if (Array.isArray(result)) return (result[0] as Record<string, unknown>) ?? {};

  const values = Object.values(result as Record<string, unknown>);
  return (values[0] as Record<string, unknown>) ?? {};
}

function buildMockResult(input: ShippopCreateShipmentInput): ShippopShipmentResult {
  const digits = input.orderNo.replace(/\D/g, "").slice(-9).padStart(9, "0");
  const shippopTrackingCode = `SP${digits}`;
  const courierTrackingCode = `${input.courierCode}${digits}`;

  return {
    purchaseId: Number(`9${digits.slice(-6)}`),
    shippopTrackingCode,
    courierTrackingCode,
    courierCode: input.courierCode,
    shipmentStatus: "booking",
    trackingUrl: trackingUrl(shippopTrackingCode),
    labelUrl: labelUrl(shippopTrackingCode),
    raw: {
      mock: true,
      note: "SHIPPOP_MOCK=true ใช้ทดสอบ flow บน localhost โดยยังไม่ยิง SHIPPOP จริง",
    },
  };
}

function toNumber(value: unknown): number | null {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

function readQuoteRows(raw: unknown): Record<string, unknown>[] {
  const data = (raw as { data?: unknown })?.data;
  if (!data || typeof data !== "object") return [];
  if (Array.isArray(data)) return data.filter((row): row is Record<string, unknown> => Boolean(row && typeof row === "object"));
  return Object.values(data as Record<string, unknown>).filter((row): row is Record<string, unknown> => Boolean(row && typeof row === "object"));
}

function buildMockQuotes(input: ShippopQuoteInput): ShippopQuoteResult[] {
  const weightKg = Math.max(Math.ceil(input.parcel.weight / 1000), 1);
  const origin = Number(input.from.postcode.slice(0, 2));
  const destination = Number(input.to.postcode.slice(0, 2));
  const zoneFactor = Number.isFinite(origin) && Number.isFinite(destination) && origin !== destination ? 12 : 0;

  return [
    { courierCode: "FLE", courierName: "Flash Express", price: 35 + weightKg * 8 + zoneFactor, raw: { mock: true } },
    { courierCode: "KRYX", courierName: "KEX Exclusive", price: 45 + weightKg * 10 + zoneFactor, raw: { mock: true } },
    { courierCode: "EMST", courierName: "ไปรษณีย์ไทย EMS", price: 40 + weightKg * 9 + zoneFactor, raw: { mock: true } },
  ];
}

export async function quoteShippopRates(input: ShippopQuoteInput): Promise<ShippopQuoteResult[]> {
  if (process.env.SHIPPOP_MOCK === "true") return buildMockQuotes(input);

  // SHIPPOP official flow starts with GET PRICE before booking. The endpoint returns only available couriers,
  // so checkout can rely on this price list instead of maintaining our own rate table as the source of truth.
  const raw = await postShippop<Record<string, unknown>>("/pricelist/", {
    from: toShippopAddress(input.from),
    to: toShippopAddress(input.to),
    parcel: input.parcel,
  });

  return readQuoteRows(raw)
    .flatMap((row): ShippopQuoteResult[] => {
      const courierCode = String(row.courier_code ?? row.courierCode ?? row.code ?? "").trim().toUpperCase();
      const price = toNumber(row.price ?? row.total_price ?? row.price_total);
      if (!courierCode || price == null) return [];

      return [{
        courierCode,
        courierName: row.courier_name ? String(row.courier_name) : row.name ? String(row.name) : null,
        price,
        raw: row,
      }];
    });
}

export async function createShippopShipment(input: ShippopCreateShipmentInput): Promise<ShippopShipmentResult> {
  const courierCode = input.courierCode.trim().toUpperCase();
  if (!courierCode) throw new ApiError(400, "ไม่พบรหัสขนส่งของ SHIPPOP");

  if (process.env.SHIPPOP_MOCK === "true") {
    return buildMockResult({ ...input, courierCode });
  }

  const email = getEmail(input.email);

  // SHIPPOP flow: booking ก่อนเพื่อสร้าง purchase_id และ SP tracking code จากนั้น confirm เพื่อส่งรายการเข้าขนส่งจริง
  const booking = await postShippop<Record<string, unknown>>("/booking/", {
    email,
    force_confirm: 0,
    data: [
      {
        from: toShippopAddress(input.from),
        to: toShippopAddress(input.to),
        parcel: input.parcel,
        product: input.products,
        courier_code: courierCode,
        remark: input.remark ?? `Order ${input.orderNo}`,
        cod_amount: input.codAmount ?? 0,
        declared_value: Math.max(input.declaredValue, 0),
        meta: {
          ref_no_1: input.orderNo,
        },
      },
    ],
  });

  const bookingItem = firstDataObject(booking);
  const purchaseId = Number((booking as { purchase_id?: unknown }).purchase_id);
  const bookingStatus = bookingItem.status;
  if (bookingStatus === false) {
    throw new ApiError(400, String(bookingItem.message ?? "SHIPPOP booking ไม่สำเร็จ"));
  }
  if (!Number.isFinite(purchaseId)) throw new ApiError(400, "SHIPPOP ไม่ส่ง purchase_id กลับมา");

  const confirm = await postShippop<Record<string, unknown>>("/confirm/", {
    purchase_id: purchaseId,
  });
  const confirmItem = firstConfirmObject(confirm);
  if (confirmItem.status === false) {
    throw new ApiError(400, String(confirmItem.message ?? "SHIPPOP confirm ไม่สำเร็จ"));
  }

  const shippopTrackingCode = String(confirmItem.tracking_code ?? bookingItem.tracking_code ?? "");
  if (!shippopTrackingCode) throw new ApiError(400, "SHIPPOP ไม่ส่ง tracking_code กลับมา");

  const courierTrackingCode = confirmItem.courier_tracking_code ?? bookingItem.courier_tracking_code ?? null;

  return {
    purchaseId,
    shippopTrackingCode,
    courierTrackingCode: courierTrackingCode ? String(courierTrackingCode) : null,
    courierCode: String(confirmItem.courier_code ?? bookingItem.courier_code ?? courierCode),
    shipmentStatus: "booking",
    trackingUrl: trackingUrl(shippopTrackingCode),
    labelUrl: labelUrl(shippopTrackingCode),
    raw: { booking, confirm },
  };
}
