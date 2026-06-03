function normalizeToken(input: string | null | undefined) {
  return String(input || "").trim().toUpperCase();
}

export function isSameAsSku(productName: string | null | undefined, amazonSku?: string | null, temuSkuId?: string | null) {
  const name = normalizeToken(productName);
  if (!name) return false;
  const amazon = normalizeToken(amazonSku);
  const temu = normalizeToken(temuSkuId);
  return (amazon && name === amazon) || (temu && name === temu);
}

export function resolveDescriptiveProductName(input: {
  productName?: string | null;
  amazonSku?: string | null;
  temuSkuId?: string | null;
  descriptionBySku?: Map<string, string>;
}) {
  const rawName = String(input.productName || "").trim();
  const amazon = normalizeToken(input.amazonSku);
  const temu = normalizeToken(input.temuSkuId);
  const sku = amazon || temu;
  const fallbackDesc =
    (amazon && input.descriptionBySku?.get(amazon)) || (temu && input.descriptionBySku?.get(temu)) || "";

  if (rawName && !isSameAsSku(rawName, amazon, temu)) return rawName;
  if (fallbackDesc) return fallbackDesc;
  if (rawName) return rawName;
  if (sku) return sku;
  return "Unnamed product";
}
