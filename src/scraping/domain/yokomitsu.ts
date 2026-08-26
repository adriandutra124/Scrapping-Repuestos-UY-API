import type { ProductRecord } from '../interfaces/scraping.types';
import { parse, type HTMLElement } from 'node-html-parser';
import { cleanText } from './product-quality';

export const YOKOMITSU_LOGIN_URL = 'https://www.yokomitsuparts.com.uy/v2/home';
export const YOKOMITSU_LEGACY_LOGIN_URL = 'https://yokomitsuparts.com.uy/v2/login';
export const YOKOMITSU_BASE_URL = 'https://www.yokomitsuparts.com.uy/v2/';
export const YOKOMITSU_SEARCH_ENDPOINT = 'https://www.yokomitsuparts.com.uy/v2/ajax/load-data-search.php';
export const YOKOMITSU_FRONT_COOKIE_NAME = 'YOKOMITSU_FRONT';
export const YOKOMITSU_MAX_DIAGNOSTIC_PRODUCTS = 5;

const SENSITIVE_HEADER_PATTERN = /^(authorization|cookie|set-cookie|x-csrf-token|x-xsrf-token)$/i;
const SENSITIVE_KEY_PATTERN = /(rut|user|username|usuario|login|pass|password|passwd|pwd|token|jwt|bearer|authorization|cookie|session|csrf|xsrf|secret)/i;
const CATALOG_URL_HINT = /(catalog|catalogo|producto|productos|repuesto|repuestos|articulo|articulos|stock|precio|precios|marca|marcas|modelo|modelos|search|buscar|busqueda|familia|categoria)/i;
const KNOWN_LABELS = [
  'Cod. Yokomitsu',
  'C\u00f3d. Yokomitsu',
  'Codigo Yokomitsu',
  'C\u00f3digo Yokomitsu',
  'SKU',
  'Codigo',
  'C\u00f3digo',
  'Marca Vehiculo',
  'Marca Veh\u00edculo',
  'Vehiculo Marca',
  'Veh\u00edculo Marca',
  'Marca',
  'Modelo Vehiculo',
  'Modelo Veh\u00edculo',
  'Modelo',
  'OEM',
  'Referencia',
  'Ref',
  'Procedencia',
  'Precio',
  'Proxima llegada',
  'Pr\u00f3xima llegada',
  'Categoria',
  'Categor\u00eda',
  'Rubro',
  'Producto',
  'Descripcion',
  'Descripci\u00f3n',
  'Stock',
  'Estado',
  'Disponibilidad',
];
const KNOWN_STATUS_PATTERN = /(?:stock\s+cr[i\u00ed]tico|sin\s+stock|agotado|no\s+disponible)/i;
const MAX_DETAIL_DESCRIPTION_LENGTH = 2_000;
const DESCRIPTION_CONTAMINATION_PATTERN = /function\s*\(|\$\.ajax|<script|<\/script|<style|<\/style|\.css\b|recaptcha|grecaptcha|navbar|footer|menu/i;
const UI_IMAGE_PATTERN = /(?:^|[-_/])(?:icon|logo|logotipo|fono|phone|whatsapp|facebook|instagram|loading|loader|spinner|ajax-loader|background|bg|fondo|banner|slider|recaptcha|captcha|sprite|placeholder|sin-?imagen|no-?image|contenido-no-disponible|lightbox)(?:[-_.]|$)/i;
const PRODUCT_IMAGE_PATH_PATTERN = /(?:producto|productos|product|products|yokomitsu|repuesto|repuestos|catalogo|catalog|imagenes|images|img|foto|fotos|upload|uploads)/i;
const PRODUCT_IMAGE_DYNAMIC_PATH_PATTERN = /(?:image|imagen|img|foto|photo|picture|thumb|thumbnail)/i;
const YOKOMITSU_DETAIL_GALLERY_PATH_PATTERN = /\/(?:v2\/)?upload\/productsgalleries\//i;
const INVALID_CATEGORY_PATTERN = /^(?:#N\/A|#VALUE!|#REF!|#DIV\/0!|#ERROR!)(?:\b|\s|\(|$)/i;
const INVALID_YOKOMITSU_VALUE_PATTERN = /^(?:#N\/A|#VALUE!|#REF!|#DIV\/0!|#ERROR!)(?:\b|\s|\(|$)|did not find value .* in vlookup evaluation/i;
const YOKOMITSU_PART_DESCRIPTION_PATTERN = /\b(?:amortiguador|bastidor|bomba|capot|careta|cerradura|cremallera|defensa|deposito|dep[o\u00f3]sito|espejo|espolon|espol[o\u00f3]n|faro|frente|guardabarro|llave|manija|optico|[o\u00f3]ptico|palanca|paragolpe|puntero|radiador|rejilla|se[ñn]alero|soporte|tapa|terminal|travesa[ñn]o|zocalo|z[o\u00f3]calo)\b/i;
const YOKOMITSU_KNOWN_VEHICLE_BRANDS = [
  'ALFA ROMEO',
  'CHEVROLET',
  'CITROEN',
  'DAIHATSU',
  'DONGFENG',
  'FIAT',
  'FORD',
  'GREAT WALL',
  'HONDA',
  'HYUNDAI',
  'ISUZU',
  'JAC',
  'JETOUR',
  'KIA',
  'LAND ROVER',
  'MAZDA',
  'MERCEDES BENZ',
  'MITSUBISHI',
  'NISSAN',
  'PEUGEOT',
  'RENAULT',
  'SSANGYONG',
  'SUBARU',
  'SUZUKI',
  'TOYOTA',
  'VOLKSWAGEN',
  'VW',
].sort((left, right) => right.length - left.length);

type JsonRecord = Record<string, unknown>;

export interface YokomitsuNetworkCall {
  method: string;
  url: string;
  resourceType?: string;
  status?: number;
  contentType?: string;
  requestBody?: unknown;
  responseShape?: unknown;
}

export interface YokomitsuFieldAvailability {
  productName: boolean;
  sourceUrl: boolean;
  sku: boolean;
  referencia: boolean;
  brand: boolean;
  price: boolean;
  currency: boolean;
  stock: boolean;
  availability: boolean;
  description: boolean;
  imageUrl: boolean;
  imageUrls: boolean;
  category: boolean;
  vehicleBrand: boolean;
  vehicleModel: boolean;
  compatibleBrands: boolean;
  compatibleModels: boolean;
}

export interface YokomitsuDiagnosticReport {
  site: 'yokomitsu';
  loginUrl: string;
  status: 'success' | 'missing-env' | 'blocked' | 'login-failed' | 'error';
  authenticated: boolean;
  reachedPortal: boolean;
  login: {
    method?: string;
    endpoint?: string;
    fieldNames: string[];
    usesSessionCookie: boolean;
    usesJwt: boolean;
    usesBearerToken: boolean;
    usesLocalStorage: boolean;
    usesRefreshToken: boolean;
    sessionCookieNames: string[];
    observedCatalogSearchAuth?: {
      usesSessionCookie: boolean;
      cookieNames: string[];
      usesBearerToken: boolean;
      authorizationHeaderObserved: boolean;
    };
  };
  catalogApiCandidates: YokomitsuNetworkCall[];
  pagination: {
    observedParams: string[];
    observedFields: string[];
  };
  approximateProductCount?: number;
  pricesMayDependOnAuthenticatedUser?: boolean;
  captchaDetected: boolean;
  twoFactorDetected: boolean;
  restrictions: string[];
  samples: ProductRecord[];
  fieldsAvailable: YokomitsuFieldAvailability;
  notes: string[];
  extractedAt: string;
}

export interface YokomitsuCaptchaSignal {
  tagName: string;
  id?: string;
  className?: string;
  title?: string;
  src?: string;
  text?: string;
  visible: boolean;
}

export interface YokomitsuPortalSignals {
  currentUrl: string;
  hasPasswordInput: boolean;
  portalElementCount: number;
  authenticatedCatalogResponses: number;
  hasYokomitsuFrontCookie?: boolean;
}

export interface YokomitsuSessionResources {
  context?: {
    clearCookies?: () => Promise<unknown>;
    close?: () => Promise<unknown>;
  };
  browser?: {
    close?: () => Promise<unknown>;
  };
}

export interface YokomitsuSearchRequest {
  id_category?: string;
  id_subcategory?: string;
  id_subsubcategory?: string;
  option_filter?: string;
  search?: string;
  order?: string;
  register?: number;
  page: number;
  view?: string;
}

export interface YokomitsuSearchResponseSummary {
  error?: unknown;
  numberRegister?: number;
  pageSize?: number;
  currentPage: number;
  totalPages?: number;
  textPagination?: string;
  products: ProductRecord[];
}

export function normalizeYokomitsuPrice(value?: string): string | undefined {
  const cleaned = cleanText(value);
  if (!cleaned) return undefined;

  const numeric = cleaned
    .replace(/(?:US\$|\$U|\$|UYU|USD)/gi, '')
    .replace(/\s+/g, '')
    .match(/\d[\d.,]*/)?.[0];
  if (!numeric) return undefined;

  const decimalComma = numeric.match(/^(.*),(\d{1,2})$/);
  if (decimalComma) {
    return `${decimalComma[1].replace(/\./g, '')}.${decimalComma[2]}`;
  }

  if (/^\d{1,3}(?:\.\d{3})+$/.test(numeric)) {
    return numeric.replace(/\./g, '');
  }

  return numeric.replace(',', '.');
}

export function hasVisibleYokomitsuCaptchaChallenge(signals: YokomitsuCaptchaSignal[]): boolean {
  return signals.some((signal) => {
    const evidence = [signal.id, signal.className, signal.title, signal.src, signal.text].filter(Boolean).join(' ');
    const captchaLike = /captcha|recaptcha|hcaptcha|g-recaptcha|cf-turnstile|challenge/i.test(evidence);
    const interactiveTag = /^(iframe|textarea|input|button|div)$/i.test(signal.tagName);
    return signal.visible && captchaLike && interactiveTag;
  });
}

export function hasReachedYokomitsuPortal(signals: YokomitsuPortalSignals): boolean {
  if (signals.hasPasswordInput) return false;
  return signals.portalElementCount > 0
    || signals.authenticatedCatalogResponses > 0
    || signals.hasYokomitsuFrontCookie === true;
}

export function hasYokomitsuManualLoginTimedOut(startedAtMs: number, nowMs: number, timeoutMs: number): boolean {
  return nowMs - startedAtMs >= timeoutMs;
}

export async function closeYokomitsuSessionResources(resources: YokomitsuSessionResources): Promise<void> {
  try {
    await resources.context?.clearCookies?.();
  } finally {
    try {
      await resources.context?.close?.();
    } finally {
      await resources.browser?.close?.();
    }
  }
}

export function inferYokomitsuCurrency(value?: string, explicit?: unknown): string | undefined {
  const explicitText = asText(explicit)?.toUpperCase();
  if (explicitText === 'UYU' || explicitText === 'USD') return explicitText;
  if (!value) return undefined;
  if (/US\$|USD/i.test(value)) return 'USD';
  if (/\$U|UYU|\$/i.test(value)) return 'UYU';
  return undefined;
}

export function isLikelyYokomitsuCatalogUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return normalizeHostname(url.hostname) === 'yokomitsuparts.com.uy'
      && (isYokomitsuSearchEndpoint(value) || CATALOG_URL_HINT.test(`${url.pathname}${url.search}`));
  } catch {
    return false;
  }
}

export function isYokomitsuSearchEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return normalizeHostname(url.hostname) === 'yokomitsuparts.com.uy'
      && /\/v2\/ajax\/load-data-search\.php$/i.test(url.pathname);
  } catch {
    return false;
  }
}

export function sanitizeUrl(value: string): string {
  try {
    const url = new URL(value);
    for (const key of Array.from(url.searchParams.keys())) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        url.searchParams.set(key, '[REDACTED]');
      }
    }
    return url.toString();
  } catch {
    return value.replace(/(authorization|cookie|auth_token|token|password|pass|rut)=([^&\s]+)/gi, '$1=[REDACTED]');
  }
}

export function sanitizeHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string | string[] | undefined> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key,
      SENSITIVE_HEADER_PATTERN.test(key) ? '[REDACTED]' : value,
    ]),
  );
}

export function extractCookieNames(cookieHeader: string | undefined): string[] {
  if (!cookieHeader) return [];
  return uniqueStrings(cookieHeader
    .split(';')
    .map((part) => cleanText(part.split('=')[0]))
    .filter((name): name is string => Boolean(name)));
}

export function summarizeYokomitsuSearchAuth(headers: Record<string, string | undefined>): {
  usesSessionCookie: boolean;
  cookieNames: string[];
  usesBearerToken: boolean;
  authorizationHeaderObserved: boolean;
} {
  const cookieNames = extractCookieNames(headers.cookie);
  const authorization = cleanText(headers.authorization);
  return {
    usesSessionCookie: cookieNames.includes(YOKOMITSU_FRONT_COOKIE_NAME),
    cookieNames: cookieNames.filter((name) => name === YOKOMITSU_FRONT_COOKIE_NAME),
    usesBearerToken: Boolean(authorization && /^bearer\s+/i.test(authorization)),
    authorizationHeaderObserved: Boolean(authorization),
  };
}

export function sanitizeRequestBody(body: string | null | undefined): unknown {
  if (!body) return undefined;
  const trimmed = body.trim();
  if (!trimmed) return undefined;

  try {
    return sanitizeJson(JSON.parse(trimmed));
  } catch {
    const params = new URLSearchParams(trimmed);
    if (Array.from(params.keys()).length > 0) {
      return Object.fromEntries(Array.from(params.keys()).map((key) => [
        key,
        SENSITIVE_KEY_PATTERN.test(key) ? '[REDACTED]' : '[VALUE]',
      ]));
    }
    return '[NON_JSON_BODY_REDACTED]';
  }
}

export function extractFieldNamesFromBody(body: string | null | undefined): string[] {
  if (!body) return [];
  try {
    const parsed = JSON.parse(body);
    return collectKeys(parsed);
  } catch {
    const params = new URLSearchParams(body);
    return Array.from(new Set(Array.from(params.keys())));
  }
}

export function summarizeJsonShape(value: unknown): unknown {
  if (Array.isArray(value)) {
    return {
      type: 'array',
      length: value.length,
      itemKeys: collectKeys(value[0]).slice(0, 40),
    };
  }
  if (!isRecord(value)) return { type: typeof value };
  return {
    type: 'object',
    keys: Object.keys(value).slice(0, 40),
    arrayFields: Object.entries(value)
      .filter(([, child]) => Array.isArray(child))
      .map(([key, child]) => ({ key, length: (child as unknown[]).length, itemKeys: collectKeys((child as unknown[])[0]).slice(0, 30) })),
  };
}

export function extractYokomitsuProductsFromJson(value: unknown, baseUrl = YOKOMITSU_BASE_URL): ProductRecord[] {
  const searchProducts = extractYokomitsuSearchProducts(value, baseUrl);
  if (searchProducts.length > 0) return searchProducts;

  return findProductArrays(value)
    .flatMap((record) => normalizeYokomitsuProduct(record, baseUrl))
    .slice(0, YOKOMITSU_MAX_DIAGNOSTIC_PRODUCTS);
}

export function parseYokomitsuSearchRequestBody(body: string | null | undefined): YokomitsuSearchRequest {
  const params = new URLSearchParams(body ?? '');
  return {
    id_category: cleanText(params.get('id_category') ?? undefined),
    id_subcategory: cleanText(params.get('id_subcategory') ?? undefined),
    id_subsubcategory: cleanText(params.get('id_subsubcategory') ?? undefined),
    option_filter: cleanText(params.get('option_filter') ?? undefined),
    search: cleanText(params.get('search') ?? undefined),
    order: cleanText(params.get('order') ?? undefined),
    register: positiveNumber(params.get('register') ?? undefined),
    page: positiveNumber(params.get('page') ?? undefined) ?? 1,
    view: cleanText(params.get('view') ?? undefined),
  };
}

export function parseYokomitsuSearchResponse(
  body: string,
  request: YokomitsuSearchRequest = { page: 1 },
  baseUrl = YOKOMITSU_BASE_URL,
  maxProducts = YOKOMITSU_MAX_DIAGNOSTIC_PRODUCTS,
): YokomitsuSearchResponseSummary | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;

  const numberRegister = positiveNumber(parsed.number_register) ?? positiveNumber(parsed.numberRegister);
  const pageSize = request.register;
  const currentPage = request.page || 1;
  return {
    error: parsed.error,
    numberRegister,
    pageSize,
    currentPage,
    totalPages: numberRegister && pageSize ? Math.ceil(numberRegister / pageSize) : undefined,
    textPagination: asText(parsed.text_pagination),
    products: extractYokomitsuSearchProducts(parsed, baseUrl, maxProducts),
  };
}

export function parseYokomitsuSearchResponseFull(
  body: string,
  request: YokomitsuSearchRequest = { page: 1 },
  baseUrl = YOKOMITSU_BASE_URL,
): YokomitsuSearchResponseSummary | undefined {
  return parseYokomitsuSearchResponse(body, request, baseUrl, Number.POSITIVE_INFINITY);
}

export function inferYokomitsuFieldsAvailable(products: ProductRecord[]): YokomitsuFieldAvailability {
  const has = (predicate: (product: ProductRecord) => unknown) => products.some((product) => Boolean(predicate(product)));
  return {
    productName: has((product) => product.productName),
    sourceUrl: has((product) => product.sourceUrl),
    sku: has((product) => product.sku),
    referencia: has((product) => product.attributes?.referencia),
    brand: has((product) => product.brand),
    price: has((product) => product.price),
    currency: has((product) => product.currency),
    stock: has((product) => product.stock),
    availability: has((product) => product.availability),
    description: has((product) => product.description),
    imageUrl: has((product) => product.imageUrl),
    imageUrls: has((product) => product.imageUrls?.length),
    category: has((product) => product.category),
    vehicleBrand: has((product) => product.attributes?.vehicleBrand),
    vehicleModel: has((product) => product.attributes?.vehicleModel),
    compatibleBrands: has((product) => product.compatibleBrands?.length),
    compatibleModels: has((product) => product.compatibleModels?.length),
  };
}

export function inferApproximateProductCount(value: unknown): number | undefined {
  const candidates = collectCountCandidates(value);
  return candidates.length > 0 ? Math.max(...candidates) : undefined;
}

export function inferPaginationFromCalls(calls: YokomitsuNetworkCall[]): { observedParams: string[]; observedFields: string[] } {
  const params = new Set<string>();
  const fields = new Set<string>();
  for (const call of calls) {
    try {
      const url = new URL(call.url);
      for (const key of url.searchParams.keys()) {
        if (/page|pagina|pag|offset|limit|size|per_page|desde|hasta|start|length/i.test(key)) params.add(key);
      }
    } catch { /* ignore invalid URLs */ }
    for (const key of collectShapeKeys(call.responseShape)) {
      if (/page|pagina|pag|offset|limit|total|count|pages|records|draw|start|length/i.test(key)) fields.add(key);
    }
  }
  return { observedParams: Array.from(params).sort(), observedFields: Array.from(fields).sort() };
}

function normalizeYokomitsuProduct(record: JsonRecord, baseUrl: string): ProductRecord[] {
  const sku = firstText(record, ['sku', 'codigo', 'code', 'cod_articulo', 'codArticulo', 'id_producto', 'idProducto', 'referencia']);
  const rawPrice = firstText(record, ['price', 'precio', 'precioVenta', 'precio_venta', 'importe', 'monto']);
  const sourceUrl = normalizeUrl(firstText(record, ['sourceUrl', 'url', 'link', 'href', 'permalink']), baseUrl)[0]
    ?? (sku ? new URL(`producto/${encodeURIComponent(sku)}`, baseUrl).toString() : baseUrl);
  const productName = sanitizeYokomitsuProductName(firstText(record, ['productName', 'name', 'nombre', 'descripcion', 'description', 'detalle', 'articulo']))
    ?? deriveYokomitsuProductNameFromSourceUrl(sourceUrl);
  if (!productName && !sku) return [];

  const imageUrls = uniqueStrings([
    firstText(record, ['imageUrl', 'imagen', 'image', 'foto', 'urlImagen']),
    ...arrayTexts(record, ['imageUrls', 'imagenes', 'images', 'fotos']),
  ].flatMap((value) => normalizeUrl(value, baseUrl)));
  const stock = firstText(record, ['stock', 'existencia', 'cantidad', 'disponible']);
  const vehicleBrand = firstText(record, ['vehicleBrand', 'marcaVehiculo', 'marca_vehiculo', 'marcaAuto', 'marca']);
  const vehicleModel = firstText(record, ['vehicleModel', 'modeloVehiculo', 'modelo_vehiculo', 'modeloAuto', 'modelo']);
  const referencia = firstText(record, ['referencia', 'reference', 'ref', 'oem']);

  return [{
    productName,
    sourceUrl,
    sku,
    brand: firstText(record, ['brand', 'marcaProducto', 'marca_producto', 'fabricante']),
    price: normalizeYokomitsuPrice(rawPrice),
    currency: inferYokomitsuCurrency(rawPrice, firstText(record, ['currency', 'moneda'])),
    stock,
    availability: inferAvailability(record, stock),
    description: firstText(record, ['description', 'descripcionLarga', 'detalle', 'observaciones']),
    imageUrl: imageUrls[0],
    imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
    category: firstText(record, ['category', 'categoria', 'familia', 'rubro']),
    compatibleBrands: arrayTexts(record, ['compatibleBrands', 'marcasCompatibles', 'marcas']),
    compatibleModels: arrayTexts(record, ['compatibleModels', 'modelosCompatibles', 'modelos']),
    attributes: compactAttributes({ referencia, vehicleBrand, vehicleModel }),
    provider: 'Yokomitsu',
    extractedAt: new Date().toISOString(),
  }];
}

function extractYokomitsuSearchProducts(value: unknown, baseUrl: string, maxProducts = YOKOMITSU_MAX_DIAGNOSTIC_PRODUCTS): ProductRecord[] {
  if (!isRecord(value) || typeof value.data !== 'string') return [];
  return extractYokomitsuProductsFromHtml(value.data, baseUrl, maxProducts);
}

export function extractYokomitsuProductsFromHtml(
  html: string,
  baseUrl: string,
  maxProducts = YOKOMITSU_MAX_DIAGNOSTIC_PRODUCTS,
): ProductRecord[] {
  const root = parse(html);
  const cards = collectProductCards(root);
  const products = cards.flatMap((card) => normalizeYokomitsuHtmlProduct(card, baseUrl));
  return Number.isFinite(maxProducts) ? products.slice(0, maxProducts) : products;
}

export function extractYokomitsuProductDetailFromHtml(html: string, sourceUrl: string, baseUrl = YOKOMITSU_BASE_URL): ProductRecord | undefined {
  const root = parse(html);
  const detailRoot = selectYokomitsuDetailContainer(root);
  const product = normalizeYokomitsuHtmlProduct(detailRoot, baseUrl, { detail: true, documentRoot: root })[0];
  if (!product) return undefined;
  return {
    ...product,
    productName: product.productName ?? deriveYokomitsuProductNameFromSourceUrl(sourceUrl),
    sourceUrl,
    imageUrls: product.imageUrls && product.imageUrls.length > 0 ? product.imageUrls : product.imageUrl ? [product.imageUrl] : undefined,
  };
}

export function filterYokomitsuDetailGalleryImageUrls(values: Array<string | undefined>): string[] {
  return uniqueStrings(values.filter((value): value is string => Boolean(value)).filter(isYokomitsuDetailGalleryImageUrl));
}

function collectProductCards(root: HTMLElement): HTMLElement[] {
  const preciseSelectors = [
    '[data-codprod]',
    '[data-product]',
    'article.producto',
    'article.product',
    '.product-item',
    '.item-product',
  ];
  for (const selector of preciseSelectors) {
    const cards = uniqueElements(root.querySelectorAll(selector).filter(looksLikeYokomitsuProductElement));
    if (cards.length > 0) return cards;
  }

  const cardsFromLinks = uniqueElements(root.querySelectorAll('a[href*="producto-detalle"]')
    .map(closestYokomitsuProductCard)
    .filter((element): element is HTMLElement => Boolean(element))
    .filter(looksLikeYokomitsuProductElement));
  if (cardsFromLinks.length > 0) return cardsFromLinks;

  const broadSelectors = ['.producto', '.product', 'article', 'tr', 'li'];
  for (const selector of broadSelectors) {
    const cards = uniqueElements(root.querySelectorAll(selector)
      .filter((element) => element.querySelector('a[href*="producto-detalle"]') !== null)
      .filter(looksLikeYokomitsuProductElement));
    if (cards.length > 0) return cards;
  }

  return looksLikeYokomitsuProductElement(root) ? [root] : [];
}

function looksLikeYokomitsuProductElement(element: HTMLElement): boolean {
  const text = elementText(element) ?? '';
  const hrefs = element.querySelectorAll('a[href]').map((link) => link.getAttribute('href') ?? '').join(' ');
  return /producto-detalle|cod\.?\s*yokomitsu|c[o\u00f3]digo|sku|oem|precio|\$\s*\d/i.test(`${text} ${hrefs}`);
}

function normalizeYokomitsuHtmlProduct(card: HTMLElement, baseUrl: string, options: { detail?: boolean; documentRoot?: HTMLElement } = {}): ProductRecord[] {
  const text = elementText(card) ?? '';
  const sourceUrl = firstNormalizedAttribute(card, [
    'a[href*="producto-detalle"]',
    'a[href*="producto"]',
    'a[href]',
  ], 'href', baseUrl);
  const productName = sanitizeYokomitsuProductName(selectYokomitsuProductName(card, options.documentRoot, Boolean(options.detail))
    ?? labelValue(text, ['Producto', 'Descripcion', 'Descripci\u00f3n']))
    ?? deriveYokomitsuProductNameFromSourceUrl(sourceUrl);
  const sku = cleanText(card.getAttribute('data-codprod'))
    ?? labeledValue(card, ['Cod. Yokomitsu', 'C\u00f3d. Yokomitsu', 'Codigo Yokomitsu', 'C\u00f3digo Yokomitsu', 'SKU', 'Codigo', 'C\u00f3digo']);
  const offerPriceHeading = card.querySelector('#prices-product .precio-oferta h2');
  const offerPriceHtml = offerPriceHeading?.innerHTML
    ?.replace(/<span\b[^>]*>.*?<\/span>/gis, ' ')
    .replace(/<[^>]+>/g, ' ');
  const offerCurrentPrice = cleanText(offerPriceHtml)
    ?.match(/(?:US\$|\$U|\$|UYU|USD)\s*\d[\d.,]*/i)?.[0];

  const rawPrice = offerCurrentPrice
    ?? firstElementText(card, ['#prices-product h3', '#prices-product > h2', '#prices-product h2', '.price', '.precio', '[class*="price"]', '[class*="precio"]'])
    ?? text.match(/(?:US\$|\$U|\$|UYU|USD)\s*\d[\d.,]*(?:\s*\+?\s*IVA)?/i)?.[0];
  const imageUrls = extractYokomitsuProductImageUrls(card, baseUrl, Boolean(options.detail), options.documentRoot);
  const referencia = labeledValue(card, ['OEM', 'Referencia', 'Ref']);
  const visibleBrand = sanitizeYokomitsuVehicleBrand(labeledValue(card, ['Marca']));
  const vehicleBrand = sanitizeYokomitsuVehicleBrand(labeledValue(card, ['Marca Vehiculo', 'Marca Veh\u00edculo', 'Vehiculo Marca', 'Veh\u00edculo Marca']))
    ?? visibleBrand;
  const vehicleModel = sanitizeYokomitsuVehicleModel(labeledValue(card, ['Modelo', 'Modelo Vehiculo', 'Modelo Veh\u00edculo']));
  const proximaLlegada = labeledValue(card, ['Proxima llegada', 'Pr\u00f3xima llegada']);
  const procedencia = labeledValue(card, ['Procedencia']);
  const availability = inferVisibleAvailability(text);
  const stockStatus = availability;
  const compatibleBrands = uniqueStrings([vehicleBrand]);
  const compatibleModels = uniqueStrings([vehicleModel]);

  if (!productName && !sku) return [];

  return [{
    productName,
    sourceUrl: sourceUrl ?? baseUrl,
    sku,
    brand: visibleBrand,
    price: normalizeYokomitsuPrice(rawPrice),
    currency: inferYokomitsuCurrency(rawPrice),
    availability,
    description: options.detail ? extractYokomitsuDetailDescription(card) : undefined,
    imageUrl: imageUrls[0],
    imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
    category: sanitizeYokomitsuCategoryValue(labeledValue(card, ['Categoria', 'Categor\u00eda', 'Rubro'])),
    compatibleBrands,
    compatibleModels,
    attributes: compactAttributes({ referencia, vehicleBrand, vehicleModel, proximaLlegada, procedencia, stockStatus }),
    provider: 'Yokomitsu',
    extractedAt: new Date().toISOString(),
  }];
}

function selectYokomitsuDetailContainer(root: HTMLElement): HTMLElement {
  const selectors = [
    '[data-codprod]',
    '.producto-detalle',
    '.detalle-producto',
    '.product-detail',
    '.single-product',
    '#producto-detalle',
    '#product-detail',
    'main article',
    'article',
  ];
  for (const selector of selectors) {
    const candidates = root.querySelectorAll(selector).filter(looksLikeYokomitsuProductElement);
    if (candidates.length > 0) return smallestTextContainer(candidates);
  }

  const fromDetailLink = root.querySelectorAll('a[href*="producto-detalle"]')
    .map(closestYokomitsuProductCard)
    .filter((element): element is HTMLElement => Boolean(element))
    .filter(looksLikeYokomitsuProductElement);
  if (fromDetailLink.length > 0) return smallestTextContainer(fromDetailLink);

  return root;
}

function smallestTextContainer(candidates: HTMLElement[]): HTMLElement {
  return candidates
    .map((element) => ({ element, textLength: elementText(element)?.length ?? Number.MAX_SAFE_INTEGER }))
    .sort((left, right) => left.textLength - right.textLength)[0].element;
}

function closestYokomitsuProductCard(element: HTMLElement): HTMLElement | undefined {
  let current: HTMLElement | undefined = element;
  let best: HTMLElement | undefined;
  while (current) {
    const text = elementText(current) ?? '';
    if (looksLikeYokomitsuProductElement(current) && text.length <= 3_000) best = current;
    const parent: unknown = current.parentNode;
    current = isHtmlElementLike(parent) ? parent : undefined;
  }
  return best;
}

function selectYokomitsuProductName(card: HTMLElement, documentRoot: HTMLElement | undefined, detail: boolean): string | undefined {
  if (!detail) {
    return firstElementText(card, [
      '.product-title',
      '.producto-titulo',
      '.nombre',
      '.name',
      '.descripcion',
      'h1',
      'h2',
      'h3',
      'h4',
      'a[href*="producto-detalle"]',
      'a[href*="producto"]',
    ]);
  }

  const candidates = collectYokomitsuDetailNameCandidates(card, documentRoot);
  if (candidates.length === 0) return undefined;

  const base = firstElementText(card, ['h1', 'h2', '.product-title', '.producto-titulo', '.nombre', '.name'])
    ?? candidates[0];
  return candidates
    .map((candidate, index) => ({
      candidate,
      score: scoreYokomitsuProductNameCandidate(candidate, base, index),
    }))
    .sort((left, right) => right.score - left.score)[0].candidate;
}

function collectYokomitsuDetailNameCandidates(card: HTMLElement, documentRoot: HTMLElement | undefined): string[] {
  const selectorCandidates = [
    '.producto-detalle .nombre',
    '.producto-detalle .name',
    '.producto-detalle .descripcion',
    '.product-detail .name',
    '.product-detail .description',
    '.detalle-producto .nombre',
    '.detalle-producto .descripcion',
    '[class*="producto"] [class*="nombre"]',
    '[class*="producto"] [class*="descripcion"]',
    '[class*="product"] [class*="name"]',
    '[class*="product"] [class*="description"]',
    '[class*="tag"]',
    '.tag',
    'h1',
    'h2',
    'h3',
  ].flatMap((selector) => card.querySelectorAll(selector).flatMap(productNameTextsFromElement).map(elementText));

  const smallTextCandidates = card.querySelectorAll('span, li, p, div, a')
    .flatMap(productNameTextsFromElement)
    .map(elementText)
    .filter((text) => {
      const length = text?.length ?? 0;
      return length >= 8 && length <= 180 && /[A-Z0-9]/.test(text ?? '');
    });

  const metaCandidates = documentRoot ? [
    documentRoot.querySelector('meta[property="og:title"]')?.getAttribute('content'),
    documentRoot.querySelector('meta[name="og:title"]')?.getAttribute('content'),
    documentRoot.querySelector('title')?.text,
  ] : [];

  return uniqueStrings([...selectorCandidates, ...smallTextCandidates, ...metaCandidates]
    .map(sanitizeYokomitsuProductNameCandidate)
    .filter((candidate): candidate is string => {
      if (!candidate) return false;
      return isLikelyYokomitsuProductNameCandidate(candidate);
    }));
}

function productNameTextsFromElement(element: HTMLElement): HTMLElement[] {
  const childElements = element.querySelectorAll('*');
  if (childElements.length === 0) return [element];
  const leafChildren = childElements.filter((child) => child.querySelectorAll('*').length === 0);
  return leafChildren.length > 0 ? leafChildren : [element];
}

function sanitizeYokomitsuProductNameCandidate(value: string | undefined): string | undefined {
  return sanitizeYokomitsuProductName(value);
}

export function sanitizeYokomitsuProductName(value: string | undefined): string | undefined {
  const text = cleanText(value)
    ?.replace(/\s*-\s*YOKOMITSU\s*$/i, '')
    .replace(/\s*[\u2013-]\s*yokomitsuparts\.com\.uy\s*$/i, '')
    .replace(/['\u2019](?=(?:19|20)\d{2}\s*-\s*(?:$|\D))/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return undefined;
  if (INVALID_YOKOMITSU_VALUE_PATTERN.test(text)) return undefined;
  if (!isLikelyYokomitsuProductNameCandidate(text)) return undefined;
  return text;
}

export function sanitizeYokomitsuVehicleBrand(value: string | undefined): string | undefined {
  const cleaned = cleanText(value)
    ?.replace(/\bmarca\b\s*:?\s*/i, '')
    .trim();
  if (!cleaned || INVALID_YOKOMITSU_VALUE_PATTERN.test(cleaned)) return undefined;

  const known = extractKnownYokomitsuVehicleBrand(cleaned);
  if (known) return known;

  if (YOKOMITSU_PART_DESCRIPTION_PATTERN.test(cleaned)) return undefined;
  if (/\bmodelo\b/i.test(cleaned)) return undefined;
  if (cleaned.length > 40 || cleaned.split(/\s+/).length > 4) return undefined;
  return cleaned;
}

export function sanitizeYokomitsuVehicleModel(value: string | undefined): string | undefined {
  const cleaned = cleanText(value)
    ?.replace(/\bmodelo\b\s*:?\s*/i, '')
    .trim();
  if (!cleaned || INVALID_YOKOMITSU_VALUE_PATTERN.test(cleaned)) return undefined;
  if (/^(?:no\s+tiene|n\/a|sin\s+datos)$/i.test(cleaned)) return undefined;
  if (YOKOMITSU_PART_DESCRIPTION_PATTERN.test(cleaned)) return undefined;
  if (extractKnownYokomitsuVehicleBrand(cleaned) === cleaned.toUpperCase()) return undefined;
  if (cleaned.length > 45 || cleaned.split(/\s+/).length > 4) return undefined;
  return cleaned;
}

function extractKnownYokomitsuVehicleBrand(value: string): string | undefined {
  const normalized = normalizeComparableText(value);
  for (const brand of YOKOMITSU_KNOWN_VEHICLE_BRANDS) {
    const normalizedBrand = normalizeComparableText(brand);
    if (normalized === normalizedBrand || normalized.startsWith(`${normalizedBrand} `)) {
      return brand === 'VW' ? 'VOLKSWAGEN' : brand;
    }
  }
  return undefined;
}

export function deriveYokomitsuProductNameFromSourceUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value, YOKOMITSU_BASE_URL);
    const parts = url.pathname.split('/').filter(Boolean);
    const detailIndex = parts.findIndex((part) => part.toLowerCase() === 'producto-detalle');
    const slug = detailIndex >= 0 ? parts[detailIndex + 3] : parts.at(-1);
    if (!slug || /^\d+$/.test(slug)) return undefined;
    const decoded = decodeURIComponent(slug)
      .replace(/(\d)-(?=\d|$)/g, '$1YOKOMITSUYEARDASHTOKEN')
      .replace(/[-_]+/g, ' ')
      .replace(/YOKOMITSUYEARDASHTOKEN/g, '-')
      .replace(/\s+/g, ' ')
      .trim();
    return sanitizeYokomitsuProductName(decoded.toUpperCase());
  } catch {
    return undefined;
  }
}

function isLikelyYokomitsuProductNameCandidate(value: string): boolean {
  if (/^(?:inicio|home|catalogo|categor[ií]as?|productos?|ver\s+detalle|ver\s+producto|detalle|comprar|consultar|stock|precio|marca|modelo|procedencia|oem|tags?)$/i.test(value)) {
    return false;
  }
  if (/^(?:marca|modelo|procedencia|oem|c[oó]d\.?\s*yokomitsu|sku|precio|stock|tags?)\b/i.test(value)) return false;
  if (/function\s*\(|\$\.ajax|recaptcha|grecaptcha|cookie|login|password|navbar|footer/i.test(value)) return false;
  if (value.length < 4 || value.length > 180) return false;
  return /[A-ZÁÉÍÓÚÑ0-9]/.test(value);
}

function scoreYokomitsuProductNameCandidate(candidate: string, base: string | undefined, index: number): number {
  const normalizedCandidate = normalizeComparableText(candidate);
  const normalizedBase = normalizeComparableText(base ?? '');
  let score = Math.max(0, 100 - index);

  if (normalizedBase && normalizedCandidate === normalizedBase) score += 30;
  if (normalizedBase && normalizedCandidate.startsWith(normalizedBase) && normalizedCandidate.length > normalizedBase.length) score += 140;
  if (normalizedBase && normalizedCandidate.includes(normalizedBase) && normalizedCandidate.length > normalizedBase.length) score += 90;

  const extraWords = normalizedBase
    ? normalizedCandidate.split(' ').filter((word) => word && !normalizedBase.split(' ').includes(word)).length
    : normalizedCandidate.split(' ').length;
  score += Math.min(extraWords, 12) * 8;

  if (/\b(?:19|20)\d{2}(?:\s*[-/]\s*(?:\d{2,4})?)?/i.test(candidate)) score += 55;
  if (/\b(?:derecho|izquierdo|delantero|trasero|hatchback|sedan|c\/|s\/|c\s*\/|s\s*\/|con|sin|rejilla|rotula|agj|agujero|agujeros|manual|electrico|eléctrico)\b/i.test(candidate)) score += 45;
  if (/\b(?:rio|soluto|accent|corolla|sentra|corsa|hilux|sail|onix|hb20|tucson|sportage|cerato|picanto)\b/i.test(candidate)) score += 35;
  if (/^[A-ZÁÉÍÓÚÑ0-9\s/'./-]+$/.test(candidate)) score += 10;
  if (/^(?:marca|modelo|procedencia|oem|c[oó]d\.?\s*yokomitsu)\b/i.test(candidate)) score -= 200;

  return score;
}

function extractYokomitsuDetailDescription(card: HTMLElement): string | undefined {
  const selectors = [
    '.descripcion-producto',
    '.product-description',
    '.description',
    '.descripcion',
    '#descripcion',
    '#description',
    '[class*="descripcion"]',
    '[class*="description"]',
  ];
  for (const selector of selectors) {
    for (const element of card.querySelectorAll(selector)) {
      const text = sanitizeYokomitsuDescription(elementText(element));
      if (text) return text;
    }
  }
  const labeled = sanitizeYokomitsuDescription(labelValue(elementText(card) ?? '', ['Descripcion', 'Descripci\u00f3n']));
  return labeled;
}

function sanitizeYokomitsuDescription(value: string | undefined): string | undefined {
  const text = cleanText(value);
  if (!text) return undefined;
  if (text.length > MAX_DETAIL_DESCRIPTION_LENGTH) return undefined;
  if (DESCRIPTION_CONTAMINATION_PATTERN.test(text)) return undefined;
  return text;
}

function extractYokomitsuProductImageUrls(card: HTMLElement, baseUrl: string, detail: boolean, documentRoot?: HTMLElement): string[] {
  if (detail) {
    return collectYokomitsuDetailGalleryUrls(documentRoot ?? card, baseUrl);
  }

  const galleryRoots = detail
    ? card.querySelectorAll('.galeria, .gallery, .product-gallery, .producto-galeria, [class*="galer"], [class*="gallery"], .carousel, .slider')
    : [];
  const roots = galleryRoots.length > 0 ? galleryRoots : [card];
  const candidates = roots.flatMap((root) => [
    ...root.querySelectorAll('[style], [data-bg], [data-background], [data-background-image], [data-image], [data-full], [data-large], [data-large-image]')
      .flatMap((element) => elementImageCandidates(element)),
    ...root.querySelectorAll('img, source').flatMap((image) => imageAttributeCandidates(image)),
    ...root.querySelectorAll('a[href]').map((link) => link.getAttribute('href')),
  ]);
  const galleryUrls = uniqueStrings(candidates
    .flatMap((value) => normalizeUrl(value ? cleanText(value) : undefined, baseUrl))
    .filter(isAllowedYokomitsuProductImageUrl));
  return galleryUrls;
}

function collectYokomitsuDetailGalleryUrls(root: HTMLElement, baseUrl: string): string[] {
  const html = root.toString();
  const unescapedHtml = html.replace(/\\\//g, '/');
  const rawCandidates = [
    ...root.querySelectorAll('[href], [src], [srcset], [data-src], [data-srcset], [data-zoom-image], [data-image], [data-full], [data-large], [data-large-image], [data-background-image], [style]')
      .flatMap((element) => [
        element.getAttribute('href'),
        ...imageAttributeCandidates(element),
        ...elementImageCandidates(element),
      ]),
    ...Array.from(html.matchAll(/(?:https?:\/\/[^"'()<>\s]+|\/(?:v2\/)?upload\/productsGalleries\/[^"'()<>\s]+)/gi))
      .map((match) => match[0]),
    ...Array.from(unescapedHtml.matchAll(/(?:https?:\/\/[^"'()<>\s]+|\/(?:v2\/)?upload\/productsGalleries\/[^"'()<>\s]+)/gi))
      .map((match) => match[0]),
  ];

  return uniqueStrings(rawCandidates
    .flatMap((value) => normalizeUrl(value ? cleanText(value) : undefined, baseUrl))
    .filter(isYokomitsuDetailGalleryImageUrl));
}

function isAllowedYokomitsuProductImageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const path = decodeURIComponent(url.pathname).toLowerCase();
    if (UI_IMAGE_PATTERN.test(path)) return false;
    if (!PRODUCT_IMAGE_PATH_PATTERN.test(path)) return false;
    if (/\.(?:png|jpe?g|webp)(?:$|\?)/i.test(path)) return true;
    return PRODUCT_IMAGE_DYNAMIC_PATH_PATTERN.test(path) && url.search.length > 0;
  } catch {
    return false;
  }
}

function isYokomitsuDetailGalleryImageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const path = decodeURIComponent(url.pathname).toLowerCase();
    if (!YOKOMITSU_DETAIL_GALLERY_PATH_PATTERN.test(path)) return false;
    if (UI_IMAGE_PATTERN.test(path)) return false;
    return /\.(?:png|jpe?g|webp)(?:$|\?)/i.test(path);
  } catch {
    return false;
  }
}

function imageAttributeCandidates(element: HTMLElement): Array<string | undefined> {
  return [
    element.getAttribute('src'),
    element.getAttribute('data-src'),
    element.getAttribute('data-original'),
    element.getAttribute('data-lazy'),
    element.getAttribute('data-zoom-image'),
    element.getAttribute('data-image'),
    element.getAttribute('data-full'),
    element.getAttribute('data-large'),
    element.getAttribute('data-large-image'),
    ...parseSrcsetCandidates(element.getAttribute('srcset')),
    ...parseSrcsetCandidates(element.getAttribute('data-srcset')),
  ];
}

function elementImageCandidates(element: HTMLElement): Array<string | undefined> {
  return [
    element.getAttribute('data-bg'),
    element.getAttribute('data-background'),
    element.getAttribute('data-background-image'),
    element.getAttribute('data-image'),
    element.getAttribute('data-full'),
    element.getAttribute('data-large'),
    element.getAttribute('data-large-image'),
    ...extractCssUrlCandidates(element.getAttribute('style')),
  ];
}

function extractCssUrlCandidates(value: string | undefined | null): string[] {
  const raw = value ?? '';
  const matches = raw.matchAll(/url\((['"]?)(.*?)\1\)/gi);
  return Array.from(matches)
    .map((match) => cleanText(match[2]))
    .filter((candidate): candidate is string => Boolean(candidate));
}

function parseSrcsetCandidates(value: string | undefined | null): string[] {
  const raw = cleanText(value ?? undefined);
  if (!raw) return [];
  return raw
    .split(',')
    .map((candidate) => cleanText(candidate.trim().split(/\s+/)[0]))
    .filter((candidate): candidate is string => Boolean(candidate));
}

function sanitizeYokomitsuCategoryValue(value: string | undefined): string | undefined {
  const cleaned = cleanText(value);
  if (!cleaned) return undefined;
  if (INVALID_CATEGORY_PATTERN.test(cleaned)) return undefined;
  if (/did not find value .* in vlookup evaluation/i.test(cleaned)) return undefined;
  return cleaned;
}

function uniqueElements(values: HTMLElement[]): HTMLElement[] {
  return Array.from(new Set(values));
}

function isHtmlElementLike(value: unknown): value is HTMLElement {
  return Boolean(value && typeof value === 'object' && 'querySelectorAll' in value && 'text' in value);
}

function labelValue(text: string, labels: string[], allowLooseLabels = false): string | undefined {
  const prepared = text.replace(/\s+/g, ' ').trim();
  if (!prepared) return undefined;

  for (const label of labels) {
    const value = readBoundedLabelValue(prepared, label, allowLooseLabels);
    if (value) return value;
  }
  return undefined;
}

function labeledValue(root: HTMLElement, labels: string[]): string | undefined {
  const smallNodes = root.querySelectorAll('span, li, p, div, td, th, strong, b')
    .filter((element) => (elementText(element)?.length ?? Number.MAX_SAFE_INTEGER) <= 250);
  for (const element of smallNodes) {
    const text = elementText(element);
    if (!text) continue;
    const value = labelValue(text, labels, true);
    if (value) return value;
  }
  return labelValue(elementText(root) ?? '', labels);
}

function readBoundedLabelValue(text: string, label: string, allowLooseLabels: boolean): string | undefined {
  const labelMatch = (allowLooseLabels ? labelBoundaryPattern(label) : labelReadPattern(label)).exec(text);
  if (!labelMatch) return undefined;

  const valueStart = labelMatch.index + labelMatch[0].length;
  const rest = text.slice(valueStart);
  const boundaryIndex = firstKnownBoundaryIndex(rest);
  const rawValue = boundaryIndex === undefined ? rest : rest.slice(0, boundaryIndex);
  const value = cleanText(rawValue);
  return isValidLabeledValue(value) ? value : undefined;
}

function firstKnownBoundaryIndex(value: string): number | undefined {
  const boundaries = [
    ...KNOWN_LABELS.map(labelBoundaryPattern),
    /(?:US\$|\$U|\$|UYU|USD)\s*\d/i,
    /Comprar\b/i,
    new RegExp(KNOWN_STATUS_PATTERN.source, 'i'),
  ]
    .map((pattern) => pattern.exec(value))
    .filter((match): match is RegExpExecArray => Boolean(match))
    .map((match) => match.index)
    .filter((index) => index >= 0);

  return boundaries.length > 0 ? Math.min(...boundaries) : undefined;
}

function isValidLabeledValue(value: string | undefined): value is string {
  if (!value) return false;
  if (KNOWN_STATUS_PATTERN.test(value)) return false;
  return !KNOWN_LABELS.some((label) => new RegExp(`^${escapeRegex(label)}:?$`, 'i').test(value));
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function labelBoundaryPattern(label: string): RegExp {
  return new RegExp(`(?:^|\\s)${escapeRegex(label)}(?:\\s*:\\s*|\\s+(?=\\S))`, 'i');
}

function labelReadPattern(label: string): RegExp {
  return new RegExp(`(?:^|\\s)${escapeRegex(label)}\\s*:\\s*|^${escapeRegex(label)}\\s+(?=\\S)`, 'i');
}

function firstElementText(root: HTMLElement, selectors: string[]): string | undefined {
  for (const selector of selectors) {
    const element = root.querySelector(selector);
    const text = element ? elementText(element) : undefined;
    if (text) return text;
  }
  return undefined;
}

function elementText(element: HTMLElement): string | undefined {
  return cleanText(element.structuredText || element.text);
}

function firstNormalizedAttribute(root: HTMLElement, selectors: string[], attribute: string, baseUrl: string): string | undefined {
  for (const selector of selectors) {
    const raw = cleanText(root.querySelector(selector)?.getAttribute(attribute) ?? undefined);
    const url = normalizeUrl(raw, baseUrl)[0];
    if (url) return url;
  }
  return undefined;
}

function findProductArrays(value: unknown): JsonRecord[] {
  if (Array.isArray(value)) {
    const records = value.filter(isRecord);
    if (records.some(looksLikeProductRecord)) return records;
    return value.flatMap(findProductArrays);
  }
  if (!isRecord(value)) return [];
  return Object.values(value).flatMap(findProductArrays);
}

function looksLikeProductRecord(record: JsonRecord): boolean {
  const keys = Object.keys(record).map((key) => key.toLowerCase());
  return keys.some((key) => ['sku', 'codigo', 'cod_articulo', 'nombre', 'descripcion', 'precio', 'stock'].includes(key));
}

function inferAvailability(record: JsonRecord, stock?: string): string | undefined {
  const raw = firstText(record, ['availability', 'disponibilidad', 'estado']);
  if (raw) return raw;
  if (!stock) return undefined;
  const numericStock = Number(stock.replace(',', '.'));
  if (Number.isFinite(numericStock)) return numericStock > 0 ? 'in_stock' : 'out_of_stock';
  return /sin stock|agotado|no disponible/i.test(stock) ? 'out_of_stock' : 'in_stock';
}

function inferVisibleAvailability(text: string): string | undefined {
  const status = cleanText(text.match(/stock\s+cr[i\u00ed]tico/i)?.[0]);
  if (status) return 'Stock Cr\u00edtico';
  if (/(?:sin stock|agotado|no disponible)/i.test(text)) return 'out_of_stock';
  return undefined;
}

function sanitizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeJson);
  if (!isRecord(value)) return value === undefined ? undefined : '[VALUE]';
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    SENSITIVE_KEY_PATTERN.test(key) ? '[REDACTED]' : sanitizeJson(child),
  ]));
}

function collectKeys(value: unknown): string[] {
  const keys = new Set<string>();
  const visit = (child: unknown) => {
    if (Array.isArray(child)) {
      child.slice(0, 5).forEach(visit);
      return;
    }
    if (!isRecord(child)) return;
    Object.entries(child).forEach(([key, nested]) => {
      keys.add(key);
      if (keys.size < 100) visit(nested);
    });
  };
  visit(value);
  return Array.from(keys);
}

function collectShapeKeys(value: unknown): string[] {
  if (!isRecord(value)) return collectKeys(value);
  const direct = collectKeys(value);
  const listed = ['keys', 'itemKeys', 'arrayFields'].flatMap((key) => {
    const child = value[key];
    if (Array.isArray(child)) {
      return child.flatMap((entry) => typeof entry === 'string' ? [entry] : collectShapeKeys(entry));
    }
    return [];
  });
  return Array.from(new Set([...direct, ...listed]));
}

function collectCountCandidates(value: unknown): number[] {
  if (Array.isArray(value)) return value.flatMap(collectCountCandidates);
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([key, child]) => {
    const nested = collectCountCandidates(child);
    if (/total|count|cantidad|records|filtered/i.test(key) && (typeof child === 'number' || typeof child === 'string')) {
      const parsed = Number(String(child).replace(/\D/g, ''));
      return Number.isFinite(parsed) && parsed > 0 ? [parsed, ...nested] : nested;
    }
    return nested;
  });
}

function positiveNumber(value: unknown): number | undefined {
  const parsed = Number(String(value ?? '').replace(/[^\d]/g, ''));
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function firstText(record: JsonRecord, keys: string[]): string | undefined {
  const normalized = keys.map(normalizeKey);
  for (const [key, value] of Object.entries(record)) {
    if (normalized.includes(normalizeKey(key))) {
      const text = asText(value);
      if (text) return text;
    }
  }
  return undefined;
}

function arrayTexts(record: JsonRecord, keys: string[]): string[] {
  const normalized = keys.map(normalizeKey);
  const values: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (!normalized.includes(normalizeKey(key))) continue;
    if (Array.isArray(value)) values.push(...value.map(asText).filter((item): item is string => Boolean(item)));
    else {
      const text = asText(value);
      if (text) values.push(...text.split(/[,;|]+/).map((part) => cleanText(part)).filter((item): item is string => Boolean(item)));
    }
  }
  return uniqueStrings(values);
}

function normalizeUrl(value: string | undefined, baseUrl: string): string[] {
  if (!value) return [];
  try {
    const url = new URL(value, baseUrl);
    return /^https?:$/i.test(url.protocol) ? [sanitizeUrl(url.toString())] : [];
  } catch {
    return [];
  }
}

function asText(value: unknown): string | undefined {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? cleanText(String(value)) : undefined;
}

function normalizeKey(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/gi, '').toLowerCase();
}

function normalizeComparableText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function normalizeHostname(value: string): string {
  return value.trim().toLowerCase().replace(/^www\./, '');
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}

function compactAttributes(values: Record<string, string | undefined>): Record<string, string> | undefined {
  const entries = Object.entries(values).filter((entry): entry is [string, string] => Boolean(entry[1]));
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}



