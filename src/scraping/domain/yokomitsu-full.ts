import type { ProductRecord } from '../interfaces/scraping.types';
import { parse, type HTMLElement } from 'node-html-parser';
import {
  authenticateYokomitsuHttpSession,
  isYokomitsuSessionExpiredResponse,
  type YokomitsuCredentials,
  type YokomitsuHttpClient,
  type YokomitsuHttpResponse,
} from './yokomitsu-auth';
import {
  extractYokomitsuProductDetailFromHtml,
  parseYokomitsuSearchResponseFull,
  YOKOMITSU_BASE_URL,
  YOKOMITSU_LOGIN_URL,
  YOKOMITSU_SEARCH_ENDPOINT,
  type YokomitsuSearchRequest,
} from './yokomitsu';

export const YOKOMITSU_FULL_REGISTER = 12;
export const YOKOMITSU_FULL_VIEW = 'grid';

export interface YokomitsuFullScrapeOptions {
  credentials: YokomitsuCredentials;
  outputProduct?: (product: ProductRecord) => Promise<void>;
  checkpoint?: YokomitsuFullCheckpoint;
  onCheckpoint?: (checkpoint: YokomitsuFullCheckpoint) => Promise<void>;
  onProgress?: (progress: YokomitsuFullProgress) => void;
  register?: number;
  concurrency?: number;
  retries?: number;
  retryDelayMs?: number;
  requestTimeoutMs?: number;
  now?: () => string;
}

export interface YokomitsuFullProgress {
  categoriesDiscovered: number;
  subcategoriesDiscovered: number;
  leafCategoriesProcessed: number;
  pagesProcessed: number;
  totalPages?: number;
  urlsDiscovered: number;
  uniqueProducts: number;
  productsProcessed: number;
  validProducts: number;
  duplicates: number;
  errors: number;
  sessionRenewed: boolean;
  elapsedMs: number;
}

export interface YokomitsuCategoryRef {
  key: string;
  name?: string;
  url?: string;
  id_category?: string;
  id_subcategory?: string;
  id_subsubcategory?: string;
  option_filter?: string;
  level: 'category' | 'subcategory' | 'subsubcategory' | 'leaf';
}

export interface YokomitsuFailedCategory {
  key: string;
  reason: string;
}

export interface YokomitsuCategoryCoverage {
  key: string;
  name?: string;
  numberRegister: number;
  totalPages: number;
  pagesProcessed: number;
  urlsExtracted: number;
  newUrls: number;
  duplicateUrls: number;
}

export interface YokomitsuFullCheckpoint {
  version: 1;
  discoveryMethod?: YokomitsuDiscoveryMethod;
  completedPages: string[];
  processedCategoryKeys: string[];
  discoveredCategories: YokomitsuCategoryRef[];
  discoveredProducts: Array<{ sourceUrl?: string; sku?: string }>;
  processedProductKeys: string[];
  counters: {
    categoriesDiscovered: number;
    subcategoriesDiscovered: number;
    leafCategoriesProcessed: number;
    pagesProcessed: number;
    productsProcessed: number;
    validProducts: number;
    duplicates: number;
    errors: number;
  };
  failedCategories: YokomitsuFailedCategory[];
  updatedAt: string;
}

export type YokomitsuDiscoveryMethod = 'category-tree';

export interface YokomitsuFullScrapeResult {
  discoveryMethod?: YokomitsuDiscoveryMethod;
  emptySearchReturnedGlobalCatalog: false;
  categoriesDiscovered: number;
  subcategoriesDiscovered: number;
  leafCategoriesProcessed: number;
  totalResults?: number;
  pageSize: number;
  totalPages?: number;
  pagesProcessed: number;
  urlsDiscovered: number;
  uniqueProducts: number;
  productsProcessed: number;
  validProducts: number;
  duplicates: number;
  errors: number;
  sessionRenewed: boolean;
  checkpoint: YokomitsuFullCheckpoint;
  failedCategories: YokomitsuFailedCategory[];
  categoryCoverage: YokomitsuCategoryCoverage[];
  limitations: string[];
}

interface DiscoveredProduct {
  key: string;
  listing: ProductRecord;
}

interface CatalogPage {
  category: YokomitsuCategoryRef;
  page: number;
  response: YokomitsuHttpResponse;
}

export function createEmptyYokomitsuCheckpoint(now = new Date().toISOString()): YokomitsuFullCheckpoint {
  return {
    version: 1,
    completedPages: [],
    processedCategoryKeys: [],
    discoveredCategories: [],
    discoveredProducts: [],
    processedProductKeys: [],
    counters: {
      categoriesDiscovered: 0,
      subcategoriesDiscovered: 0,
      leafCategoriesProcessed: 0,
      pagesProcessed: 0,
      productsProcessed: 0,
      validProducts: 0,
      duplicates: 0,
      errors: 0,
    },
    failedCategories: [],
    updatedAt: now,
  };
}

export function buildYokomitsuCatalogSearchBody(input: Partial<YokomitsuSearchRequest> = {}): string {
  return new URLSearchParams({
    id_category: input.id_category ?? '',
    id_subcategory: input.id_subcategory ?? '',
    id_subsubcategory: input.id_subsubcategory ?? '',
    option_filter: input.option_filter ?? '',
    search: input.search ?? '',
    order: input.order ?? '',
    register: String(input.register ?? YOKOMITSU_FULL_REGISTER),
    page: String(input.page ?? 1),
    view: input.view ?? YOKOMITSU_FULL_VIEW,
  }).toString();
}

export function buildYokomitsuCategorySearchBody(category: YokomitsuCategoryRef, page: number, register = YOKOMITSU_FULL_REGISTER): string {
  return buildYokomitsuCatalogSearchBody({
    id_category: category.id_category,
    id_subcategory: category.id_subcategory,
    id_subsubcategory: category.id_subsubcategory,
    option_filter: category.option_filter,
    search: '',
    order: '',
    register,
    page,
    view: YOKOMITSU_FULL_VIEW,
  });
}

export function parseYokomitsuScrapeArgs(values: string[]): Map<string, string> {
  const parsed = new Map<string, string>();
  for (let index = 0; index < values.length; index += 1) {
    const arg = values[index];
    if (!arg.startsWith('--')) continue;
    const withoutPrefix = arg.replace(/^--/, '');
    const equalsIndex = withoutPrefix.indexOf('=');
    if (equalsIndex >= 0) {
      parsed.set(withoutPrefix.slice(0, equalsIndex), withoutPrefix.slice(equalsIndex + 1));
      continue;
    }
    const next = values[index + 1];
    if (next && !next.startsWith('--')) {
      parsed.set(withoutPrefix, next);
      index += 1;
      continue;
    }
    parsed.set(withoutPrefix, 'true');
  }
  return parsed;
}

export function calculateYokomitsuTotalPages(totalResults: number | undefined, pageSize: number): number | undefined {
  return totalResults && pageSize > 0 ? Math.ceil(totalResults / pageSize) : undefined;
}

export function yokomitsuProductDedupKey(product: ProductRecord): string | undefined {
  const canonicalUrl = canonicalYokomitsuUrl(product.sourceUrl);
  if (canonicalUrl) return `url:${canonicalUrl}`;
  if (product.sku) return `sku:${product.sku.trim().toUpperCase()}`;
  return undefined;
}

export function discoverYokomitsuCategoriesFromHtml(html: string, baseUrl = YOKOMITSU_BASE_URL): YokomitsuCategoryRef[] {
  const root = parse(html);
  const discovered = new Map<string, YokomitsuCategoryRef>();

  for (const element of root.querySelectorAll('a[href], option[value], [data-id_category], [data-id-category], [data-category], [data-id_subcategory], [data-id-subcategory], [data-subcategory], [data-id_subsubcategory], [data-id-subsubcategory], [data-subsubcategory]')) {
    const direct = categoryFromElement(element, baseUrl);
    if (direct) discovered.set(direct.key, direct);
  }

  for (const match of html.matchAll(/load-data-search\.php[^"'`<>{}]*/gi)) {
    const query = match[0].split('?')[1];
    if (!query) continue;
    const ref = categoryFromParams(new URLSearchParams(query));
    if (ref) discovered.set(ref.key, ref);
  }

  return Array.from(discovered.values())
    .filter(hasCategorySearchSignal)
    .sort((left, right) => left.key.localeCompare(right.key));
}

export function sanitizeYokomitsuCheckpoint(checkpoint: YokomitsuFullCheckpoint): YokomitsuFullCheckpoint {
  return {
    version: 1,
    discoveryMethod: checkpoint.discoveryMethod,
    completedPages: Array.from(new Set(checkpoint.completedPages ?? []))
      .filter((key) => !containsSecretMarker(key))
      .sort(),
    processedCategoryKeys: Array.from(new Set(checkpoint.processedCategoryKeys ?? []))
      .filter((key) => !containsSecretMarker(key))
      .sort(),
    discoveredCategories: sanitizeCategories(checkpoint.discoveredCategories ?? []),
    discoveredProducts: sanitizeDiscoveredProducts(checkpoint.discoveredProducts ?? []),
    processedProductKeys: Array.from(new Set(checkpoint.processedProductKeys ?? []))
      .filter((key) => !containsSecretMarker(key))
      .sort(),
    counters: {
      categoriesDiscovered: checkpoint.counters?.categoriesDiscovered ?? 0,
      subcategoriesDiscovered: checkpoint.counters?.subcategoriesDiscovered ?? 0,
      leafCategoriesProcessed: checkpoint.counters?.leafCategoriesProcessed ?? 0,
      pagesProcessed: checkpoint.counters?.pagesProcessed ?? 0,
      productsProcessed: checkpoint.counters?.productsProcessed ?? 0,
      validProducts: checkpoint.counters?.validProducts ?? 0,
      duplicates: checkpoint.counters?.duplicates ?? 0,
      errors: checkpoint.counters?.errors ?? 0,
    },
    failedCategories: sanitizeFailedCategories(checkpoint.failedCategories ?? []),
    updatedAt: checkpoint.updatedAt,
  };
}

export async function runYokomitsuFullCatalog(
  client: YokomitsuHttpClient,
  options: YokomitsuFullScrapeOptions,
): Promise<YokomitsuFullScrapeResult> {
  const startedAt = Date.now();
  const now = options.now ?? (() => new Date().toISOString());
  const checkpoint = sanitizeYokomitsuCheckpoint(options.checkpoint ?? createEmptyYokomitsuCheckpoint(now()));
  const completedPages = new Set(checkpoint.completedPages);
  const processedCategoryKeys = new Set(checkpoint.processedCategoryKeys);
  const processedKeys = new Set(checkpoint.processedProductKeys);
  const discoveredKeys = new Set<string>();
  const discoveredUrls = new Set<string>();
  const discoveredSkus = new Set<string>();
  const discoveredProducts: DiscoveredProduct[] = hydrateDiscoveredProducts(checkpoint);
  for (const product of discoveredProducts) {
    discoveredKeys.add(product.key);
    const canonicalUrl = canonicalYokomitsuUrl(product.listing.sourceUrl);
    if (canonicalUrl) discoveredUrls.add(`url:${canonicalUrl}`);
    if (product.listing.sku) discoveredSkus.add(`sku:${product.listing.sku.trim().toUpperCase()}`);
  }
  const pageSize = options.register ?? YOKOMITSU_FULL_REGISTER;
  const concurrency = clampInteger(options.concurrency ?? 3, 1, 4);
  const retries = options.retries ?? 2;
  const retryDelayMs = options.retryDelayMs ?? 750;
  const limitations: string[] = [];
  const categoryCoverage: YokomitsuCategoryCoverage[] = [];
  let sessionRenewed = false;
  let totalResults = 0;
  let totalPages = 0;

  const login = async () => {
    const result = await authenticateYokomitsuHttpSession(client, options.credentials);
    if (!result.authenticated) throw new Error(result.error ?? 'Yokomitsu login failed');
  };

  const requestHome = async (): Promise<YokomitsuHttpResponse> => requestWithRetry(
    async () => client.get(YOKOMITSU_LOGIN_URL, { accept: 'text/html,application/xhtml+xml' }),
    { retries, retryDelayMs, isRetryable: (response) => response.status === 429 || response.status >= 500 },
  );

  const getAuthenticatedHome = async (): Promise<YokomitsuHttpResponse> => {
    let response = await requestHome();
    if (isYokomitsuSessionExpiredResponse(response) && !sessionRenewed) {
      sessionRenewed = true;
      await login();
      response = await requestHome();
    }
    if (isYokomitsuSessionExpiredResponse(response)) throw new Error('Yokomitsu session expired during category discovery');
    return response;
  };

  const postCatalog = async (category: YokomitsuCategoryRef, page: number): Promise<YokomitsuHttpResponse> => {
    const body = buildYokomitsuCategorySearchBody(category, page, pageSize);
    return requestWithRetry(async () => client.post(YOKOMITSU_SEARCH_ENDPOINT, body, {
      accept: 'application/json, text/javascript, */*; q=0.01',
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'x-requested-with': 'XMLHttpRequest',
    }), {
      retries,
      retryDelayMs,
      isRetryable: (response) => response.status === 429 || response.status >= 500,
    });
  };

  const getDetail = async (url: string): Promise<YokomitsuHttpResponse> => requestWithRetry(
    async () => client.get(url, { accept: 'text/html,application/xhtml+xml' }),
    { retries, retryDelayMs, isRetryable: (response) => response.status === 429 || response.status >= 500 },
  );

  const catalogWithSession = async (category: YokomitsuCategoryRef, page: number): Promise<CatalogPage> => {
    let response = await postCatalog(category, page);
    if (isYokomitsuSessionExpiredResponse(response) && !sessionRenewed) {
      sessionRenewed = true;
      await login();
      response = await postCatalog(category, page);
    }
    if (isYokomitsuSessionExpiredResponse(response)) throw new Error('Yokomitsu session expired during catalog pagination');
    return { category, page, response };
  };

  const detailWithSession = async (url: string): Promise<YokomitsuHttpResponse> => {
    let response = await getDetail(url);
    if (isYokomitsuSessionExpiredResponse(response) && !sessionRenewed) {
      sessionRenewed = true;
      await login();
      response = await getDetail(url);
    }
    if (isYokomitsuSessionExpiredResponse(response)) throw new Error('Yokomitsu session expired during product detail fetch');
    return response;
  };

  console.log('production-yokomitsu stage=auth-start');
  await login();
  console.log('production-yokomitsu stage=auth-ok');

  console.log('production-yokomitsu stage=home-start');
  const home = await getAuthenticatedHome();
  console.log(`production-yokomitsu stage=home-ok status=${home.status} bodyLength=${home.body.length}`);
  const discoveredCategories = mergeCategories(checkpoint.discoveredCategories, discoverYokomitsuCategoriesFromHtml(home.body, YOKOMITSU_BASE_URL));
  console.log(`production-yokomitsu stage=discovery-ok categories=${discoveredCategories.length}`);
  checkpoint.discoveryMethod = 'category-tree';
  checkpoint.discoveredCategories = discoveredCategories;
  checkpoint.counters.categoriesDiscovered = countCategories(discoveredCategories);
  checkpoint.counters.subcategoriesDiscovered = countSubcategories(discoveredCategories);
  await saveCheckpoint();

  if (discoveredCategories.length === 0) {
    limitations.push('no category IDs were discovered from authenticated portal HTML');
    return finalize();
  }

  for (const category of discoveredCategories) {
    if (processedCategoryKeys.has(category.key)) continue;
    try {
      const coverage: YokomitsuCategoryCoverage = {
        key: category.key,
        name: category.name,
        numberRegister: 0,
        totalPages: 0,
        pagesProcessed: 0,
        urlsExtracted: 0,
        newUrls: 0,
        duplicateUrls: 0,
      };
      categoryCoverage.push(coverage);
      console.log(`production-yokomitsu stage=category-start name=${category.name} key=${category.key}`);
      const firstPage = await catalogWithSession(category, 1);
      console.log(`production-yokomitsu stage=category-response name=${category.name} status=${firstPage.response.status} bodyLength=${firstPage.response.body.length}`);
      const firstSummary = parseYokomitsuSearchResponseFull(firstPage.response.body, { ...category, page: 1, register: pageSize, view: YOKOMITSU_FULL_VIEW }, YOKOMITSU_BASE_URL);
      if (!firstSummary) {
        checkpoint.counters.errors += 1;
        addFailedCategory(category, 'invalid catalog JSON response');
        continue;
      }

      const categoryTotalResults = firstSummary.numberRegister ?? firstSummary.products.length;
      const categoryTotalPages = calculateYokomitsuTotalPages(categoryTotalResults, pageSize) ?? (firstSummary.products.length > 0 ? 1 : 0);
      coverage.numberRegister = categoryTotalResults;
      coverage.totalPages = categoryTotalPages;
      totalResults += categoryTotalResults;
      totalPages += categoryTotalPages;
      addCoverage(coverage, collectProducts(firstSummary.products));
      await markPageCompleted(category, 1);
      coverage.pagesProcessed += 1;

      for (let page = 2; page <= categoryTotalPages; page += 1) {
        if (completedPages.has(pageKey(category, page))) continue;
        const pageResult = await catalogWithSession(category, page);
        const summary = parseYokomitsuSearchResponseFull(pageResult.response.body, { ...category, page, register: pageSize, view: YOKOMITSU_FULL_VIEW }, YOKOMITSU_BASE_URL);
        if (!summary) {
          checkpoint.counters.errors += 1;
          addFailedCategory(category, `invalid catalog JSON response on page ${page}`);
          continue;
        }
        if (summary.products.length === 0) {
          await markPageCompleted(category, page);
          coverage.pagesProcessed += 1;
          break;
        }
        addCoverage(coverage, collectProducts(summary.products));
        await markPageCompleted(category, page);
        coverage.pagesProcessed += 1;
      }

      processedCategoryKeys.add(category.key);
      checkpoint.processedCategoryKeys = Array.from(processedCategoryKeys);
      checkpoint.counters.leafCategoriesProcessed = processedCategoryKeys.size;
      await saveCheckpoint();
    } catch (error) {
      checkpoint.counters.errors += 1;
      addFailedCategory(category, error instanceof Error ? error.message : 'category failed');
      await saveCheckpoint();
    }
  }

  await runPool(discoveredProducts, concurrency, async (entry) => {
    if (processedKeys.has(entry.key)) {
      checkpoint.counters.duplicates += 1;
      return;
    }
    try {
      const sourceUrl = entry.listing.sourceUrl;
      console.log(`production-yokomitsu product-start key=${entry.key} url=${sourceUrl ?? 'none'}`);
      const detail = sourceUrl ? await detailWithSession(sourceUrl) : undefined;
      console.log(`production-yokomitsu product-detail key=${entry.key} status=${detail?.status ?? 'none'} bodyLength=${detail?.body.length ?? 0}`);
      const detailProduct = detail && sourceUrl
        ? extractYokomitsuProductDetailFromHtml(detail.body, sourceUrl, YOKOMITSU_BASE_URL)
        : undefined;
      const product = mergeYokomitsuProduct(entry.listing, detailProduct);
      checkpoint.counters.productsProcessed += 1;
      console.log(`production-yokomitsu product-done key=${entry.key} processed=${checkpoint.counters.productsProcessed} valid=${checkpoint.counters.validProducts}`);
      if (isValidYokomitsuProduct(product)) {
        checkpoint.counters.validProducts += 1;
        await options.outputProduct?.(product);
      console.log(`production-yokomitsu product-output-done key=${entry.key}`);
      } else {
        checkpoint.counters.errors += 1;
      }
      processedKeys.add(entry.key);
      checkpoint.processedProductKeys = Array.from(processedKeys);
      await saveCheckpoint();
    console.log(`production-yokomitsu product-checkpoint-done key=${entry.key}`);
      reportProgress(totalPages, startedAt, discoveredKeys.size, sessionRenewed, options.onProgress, checkpoint);
    } catch {
      checkpoint.counters.errors += 1;
      await saveCheckpoint();
    }
  });

  console.log('production-yokomitsu runpool-completed');

  if (checkpoint.failedCategories.length > 0) {
    limitations.push(`${checkpoint.failedCategories.length} categories failed and require retry`);
  }
  if (processedCategoryKeys.size < discoveredCategories.length) {
    limitations.push(`${discoveredCategories.length - processedCategoryKeys.size} discovered categories remain unprocessed`);
  }

  return finalize(totalResults, totalPages);

  function collectProducts(products: ProductRecord[]): { extracted: number; fresh: number; duplicates: number } {
    const stats = { extracted: products.length, fresh: 0, duplicates: 0 };
    for (const product of products) {
      const key = yokomitsuProductDedupKey(product);
      if (!key) {
        checkpoint.counters.errors += 1;
        continue;
      }
      const canonicalUrl = canonicalYokomitsuUrl(product.sourceUrl);
      const urlKey = canonicalUrl ? `url:${canonicalUrl}` : undefined;
      const skuKey = product.sku ? `sku:${product.sku.trim().toUpperCase()}` : undefined;
      if (discoveredKeys.has(key)
        || (urlKey && discoveredUrls.has(urlKey))
        || (skuKey && discoveredSkus.has(skuKey))) {
        checkpoint.counters.duplicates += 1;
        stats.duplicates += 1;
        continue;
      }
      discoveredKeys.add(key);
      stats.fresh += 1;
      if (urlKey) discoveredUrls.add(urlKey);
      if (skuKey) discoveredSkus.add(skuKey);
      discoveredProducts.push({ key, listing: product });
      checkpoint.discoveredProducts = sanitizeDiscoveredProducts([
        ...(checkpoint.discoveredProducts ?? []),
        { sourceUrl: product.sourceUrl, sku: product.sku },
      ]);
    }
    return stats;
  }

  async function markPageCompleted(category: YokomitsuCategoryRef, page: number): Promise<void> {
    const key = pageKey(category, page);
    if (!completedPages.has(key)) {
      completedPages.add(key);
      checkpoint.completedPages = Array.from(completedPages);
      checkpoint.counters.pagesProcessed += 1;
      await saveCheckpoint();
      reportProgress(totalPages, startedAt, discoveredKeys.size, sessionRenewed, options.onProgress, checkpoint);
    }
  }

  function addFailedCategory(category: YokomitsuCategoryRef, reason: string): void {
    checkpoint.failedCategories = sanitizeFailedCategories([
      ...checkpoint.failedCategories,
      { key: category.key, reason },
    ]);
  }

  async function saveCheckpoint(): Promise<void> {
    checkpoint.updatedAt = now();
    await options.onCheckpoint?.(sanitizeYokomitsuCheckpoint(checkpoint));
  }

  function finalize(finalTotalResults = totalResults, finalTotalPages = totalPages): YokomitsuFullScrapeResult {
    const safeCheckpoint = sanitizeYokomitsuCheckpoint(checkpoint);
    return {
      discoveryMethod: checkpoint.discoveryMethod,
      emptySearchReturnedGlobalCatalog: false,
      categoriesDiscovered: safeCheckpoint.counters.categoriesDiscovered,
      subcategoriesDiscovered: safeCheckpoint.counters.subcategoriesDiscovered,
      leafCategoriesProcessed: safeCheckpoint.counters.leafCategoriesProcessed,
      totalResults: finalTotalResults || undefined,
      pageSize,
      totalPages: finalTotalPages || undefined,
      pagesProcessed: safeCheckpoint.counters.pagesProcessed,
      urlsDiscovered: discoveredKeys.size,
      uniqueProducts: discoveredKeys.size,
      productsProcessed: safeCheckpoint.counters.productsProcessed,
      validProducts: safeCheckpoint.counters.validProducts,
      duplicates: safeCheckpoint.counters.duplicates,
      errors: safeCheckpoint.counters.errors,
      sessionRenewed,
      checkpoint: safeCheckpoint,
      failedCategories: safeCheckpoint.failedCategories,
      categoryCoverage: categoryCoverage
        .map((coverage) => ({ ...coverage }))
        .sort((left, right) => (right.numberRegister - right.urlsExtracted) - (left.numberRegister - left.urlsExtracted)),
      limitations,
    };
  }
}

function addCoverage(
  coverage: YokomitsuCategoryCoverage,
  delta: { extracted: number; fresh: number; duplicates: number },
): void {
  coverage.urlsExtracted += delta.extracted;
  coverage.newUrls += delta.fresh;
  coverage.duplicateUrls += delta.duplicates;
}

async function requestWithRetry(
  request: () => Promise<YokomitsuHttpResponse>,
  options: { retries: number; retryDelayMs: number; isRetryable: (response: YokomitsuHttpResponse) => boolean },
): Promise<YokomitsuHttpResponse> {
  let attempt = 0;
  let lastError: unknown;
  while (attempt <= options.retries) {
    try {
      const response = await request();
      if (!options.isRetryable(response) || attempt === options.retries) return response;
    } catch (error) {
      lastError = error;
      if (attempt === options.retries) throw error;
    }
    attempt += 1;
    await delay(options.retryDelayMs * attempt);
  }
  throw lastError instanceof Error ? lastError : new Error('Yokomitsu request failed');
}

async function runPool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index];
      index += 1;
      await worker(item);
    }
  });
  await Promise.all(workers);
}

function categoryFromElement(element: HTMLElement, baseUrl: string): YokomitsuCategoryRef | undefined {
  const href = element.getAttribute('href');
  const value = element.getAttribute('value');
  const attrs = attributeText(element);
  const text = cleanNodeText(element);
  const params = new URLSearchParams();

  for (const [param, patterns] of [
    ['id_category', [/data-id_category=["']?(\d+)/i, /data-id-category=["']?(\d+)/i, /data-category=["']?(\d+)/i, /id_category[=:]\s*["']?(\d+)/i]],
    ['id_subcategory', [/data-id_subcategory=["']?(\d+)/i, /data-id-subcategory=["']?(\d+)/i, /data-subcategory=["']?(\d+)/i, /id_subcategory[=:]\s*["']?(\d+)/i]],
    ['id_subsubcategory', [/data-id_subsubcategory=["']?(\d+)/i, /data-id-subsubcategory=["']?(\d+)/i, /data-subsubcategory=["']?(\d+)/i, /id_subsubcategory[=:]\s*["']?(\d+)/i]],
    ['option_filter', [/data-option_filter=["']?(\d+)/i, /data-option-filter=["']?(\d+)/i, /option_filter[=:]\s*["']?(\d+)/i]],
  ] as const) {
    const found = patterns.map((pattern) => attrs.match(pattern)?.[1]).find(Boolean);
    if (found) params.set(param, found);
  }

  if (value && /^\d+$/.test(value)) {
    const name = (element.getAttribute('name') ?? element.parentNode?.getAttribute?.('name') ?? '').toLowerCase();
    if (name.includes('subsub')) params.set('id_subsubcategory', value);
    else if (name.includes('sub')) params.set('id_subcategory', value);
    else if (name.includes('categor')) params.set('id_category', value);
  }

  if (href) {
    try {
      const url = new URL(href, baseUrl);
      for (const key of ['id_category', 'id_subcategory', 'id_subsubcategory', 'option_filter']) {
        const param = url.searchParams.get(key);
        if (param) params.set(key, param);
      }
      const productPath = url.pathname.match(/\/productos\/([^/]+)\/([^/]+)\/(\d+)\/([^/?#]+)/i);
      if (productPath && !params.get('id_subsubcategory')) {
        params.set('id_subsubcategory', productPath[3]);
        return categoryFromParams(params, text || decodeURIComponent(productPath[2]), url.toString(), 'subsubcategory');
      }
      return categoryFromParams(params, text, url.toString());
    } catch {
      return categoryFromParams(params, text);
    }
  }

  return categoryFromParams(params, text);
}

function categoryFromParams(
  params: URLSearchParams,
  name?: string,
  url?: string,
  forcedLevel?: YokomitsuCategoryRef['level'],
): YokomitsuCategoryRef | undefined {
  const id_category = cleanParam(params.get('id_category'));
  const id_subcategory = cleanParam(params.get('id_subcategory'));
  const id_subsubcategory = cleanParam(params.get('id_subsubcategory'));
  const option_filter = cleanParam(params.get('option_filter'));
  if (!id_category && !id_subcategory && !id_subsubcategory && !option_filter) return undefined;
  const level = forcedLevel
    ?? (id_subsubcategory ? 'subsubcategory' : id_subcategory ? 'subcategory' : id_category ? 'category' : 'leaf');
  const ref = {
    key: categoryKey({ id_category, id_subcategory, id_subsubcategory, option_filter }),
    name: sanitizeCategoryName(name),
    url: sanitizeCategoryUrl(url),
    id_category,
    id_subcategory,
    id_subsubcategory,
    option_filter,
    level,
  };
  return ref.key ? ref : undefined;
}

function mergeCategories(...groups: YokomitsuCategoryRef[][]): YokomitsuCategoryRef[] {
  const merged = new Map<string, YokomitsuCategoryRef>();
  for (const group of groups) {
    for (const category of sanitizeCategories(group)) {
      merged.set(category.key, { ...merged.get(category.key), ...category });
    }
  }
  return Array.from(merged.values()).sort((left, right) => left.key.localeCompare(right.key));
}

function sanitizeCategories(categories: YokomitsuCategoryRef[]): YokomitsuCategoryRef[] {
  const seen = new Set<string>();
  const safe: YokomitsuCategoryRef[] = [];
  for (const category of categories) {
    if (containsSecretMarker(JSON.stringify(category))) continue;
    const normalized: YokomitsuCategoryRef = {
      key: categoryKey(category),
      name: sanitizeCategoryName(category.name),
      url: sanitizeCategoryUrl(category.url),
      id_category: cleanParam(category.id_category),
      id_subcategory: cleanParam(category.id_subcategory),
      id_subsubcategory: cleanParam(category.id_subsubcategory),
      option_filter: cleanParam(category.option_filter),
      level: category.level,
    };
    if (!normalized.key || seen.has(normalized.key) || containsSecretMarker(JSON.stringify(normalized))) continue;
    seen.add(normalized.key);
    safe.push(normalized);
  }
  return safe;
}

function sanitizeFailedCategories(values: YokomitsuFailedCategory[]): YokomitsuFailedCategory[] {
  const seen = new Set<string>();
  const safe: YokomitsuFailedCategory[] = [];
  for (const value of values) {
    const key = value.key?.trim();
    if (!key || containsSecretMarker(key) || seen.has(key)) continue;
    seen.add(key);
    safe.push({ key, reason: containsSecretMarker(value.reason) ? '[REDACTED]' : value.reason.slice(0, 160) });
  }
  return safe;
}

function hasCategorySearchSignal(category: YokomitsuCategoryRef): boolean {
  return Boolean(category.id_category || category.id_subcategory || category.id_subsubcategory || category.option_filter);
}

function pageKey(category: YokomitsuCategoryRef, page: number): string {
  return `${category.key}:page:${page}`;
}

function categoryKey(input: Partial<YokomitsuCategoryRef>): string {
  return [
    `cat:${input.id_category ?? ''}`,
    `sub:${input.id_subcategory ?? ''}`,
    `subsub:${input.id_subsubcategory ?? ''}`,
    `opt:${input.option_filter ?? ''}`,
  ].join('|');
}

function countCategories(categories: YokomitsuCategoryRef[]): number {
  return new Set(categories.map((category) => category.id_category).filter(Boolean)).size;
}

function countSubcategories(categories: YokomitsuCategoryRef[]): number {
  return new Set(categories
    .filter((category) => category.id_subcategory)
    .map((category) => [category.id_category, category.id_subcategory].filter(Boolean).join(':'))).size;
}

function mergeYokomitsuProduct(listing: ProductRecord, detail?: ProductRecord): ProductRecord {
  if (!detail) return listing;
  return {
    ...listing,
    ...detail,
    attributes: {
      ...(listing.attributes ?? {}),
      ...(detail.attributes ?? {}),
    },
    imageUrls: uniqueStrings([...(listing.imageUrls ?? []), listing.imageUrl, ...(detail.imageUrls ?? []), detail.imageUrl]),
    imageUrl: detail.imageUrl ?? listing.imageUrl,
    sourceUrl: detail.sourceUrl ?? listing.sourceUrl,
    provider: 'Yokomitsu',
    extractedAt: detail.extractedAt || listing.extractedAt,
  };
}

function isValidYokomitsuProduct(product: ProductRecord): boolean {
  return Boolean(product.sourceUrl || product.sku) && Boolean(product.productName || product.sku);
}

function canonicalYokomitsuUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    url.hash = '';
    url.search = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return undefined;
  }
}

function reportProgress(
  totalPages: number | undefined,
  startedAt: number,
  urlsDiscovered: number,
  sessionRenewed: boolean,
  onProgress: ((progress: YokomitsuFullProgress) => void) | undefined,
  checkpoint: YokomitsuFullCheckpoint,
): void {
  onProgress?.({
    categoriesDiscovered: checkpoint.counters.categoriesDiscovered,
    subcategoriesDiscovered: checkpoint.counters.subcategoriesDiscovered,
    leafCategoriesProcessed: checkpoint.counters.leafCategoriesProcessed,
    pagesProcessed: checkpoint.counters.pagesProcessed,
    totalPages,
    urlsDiscovered,
    uniqueProducts: urlsDiscovered,
    productsProcessed: checkpoint.counters.productsProcessed,
    validProducts: checkpoint.counters.validProducts,
    duplicates: checkpoint.counters.duplicates,
    errors: checkpoint.counters.errors,
    sessionRenewed,
    elapsedMs: Date.now() - startedAt,
  });
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function uniqueStrings(values: Array<string | undefined>): string[] | undefined {
  const unique = Array.from(new Set(values.filter((value): value is string => Boolean(value))));
  return unique.length > 0 ? unique : undefined;
}

function hydrateDiscoveredProducts(checkpoint: YokomitsuFullCheckpoint): DiscoveredProduct[] {
  return sanitizeDiscoveredProducts(checkpoint.discoveredProducts ?? [])
    .map((ref) => {
      const listing: ProductRecord = {
        sourceUrl: ref.sourceUrl,
        sku: ref.sku,
        provider: 'Yokomitsu',
        extractedAt: checkpoint.updatedAt,
      };
      const key = yokomitsuProductDedupKey(listing);
      return key ? { key, listing } : undefined;
    })
    .filter((value): value is DiscoveredProduct => Boolean(value));
}

function sanitizeDiscoveredProducts(values: Array<{ sourceUrl?: string; sku?: string }>): Array<{ sourceUrl?: string; sku?: string }> {
  const seen = new Set<string>();
  const safe: Array<{ sourceUrl?: string; sku?: string }> = [];
  for (const value of values) {
    const sourceUrl = canonicalYokomitsuUrl(value.sourceUrl);
    const sku = value.sku?.trim();
    if (!sourceUrl && !sku) continue;
    if ([sourceUrl, sku].filter(Boolean).join(' ').match(secretPattern())) continue;
    const key = sourceUrl ? `url:${sourceUrl}` : `sku:${sku?.toUpperCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    safe.push({ sourceUrl, sku });
  }
  return safe;
}

function attributeText(element: HTMLElement): string {
  return element.rawAttrs ?? '';
}

function cleanNodeText(element: HTMLElement): string | undefined {
  return sanitizeCategoryName(element.structuredText || element.text);
}

function cleanParam(value: string | undefined | null): string | undefined {
  const cleaned = value?.trim();
  return cleaned && /^\d+$/.test(cleaned) ? cleaned : undefined;
}

function sanitizeCategoryName(value: string | undefined): string | undefined {
  const cleaned = value?.replace(/\s+/g, ' ').trim();
  if (!cleaned || containsSecretMarker(cleaned)) return undefined;
  return cleaned.slice(0, 120);
}

function sanitizeCategoryUrl(value: string | undefined): string | undefined {
  if (!value || containsSecretMarker(value)) return undefined;
  try {
    const url = new URL(value, YOKOMITSU_BASE_URL);
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}

function containsSecretMarker(value: string | undefined): boolean {
  return Boolean(value && secretPattern().test(value));
}

function secretPattern(): RegExp {
  return /cookie|authorization|password|auth_token|token|rut|YOKOMITSU_FRONT=|bearer|session/i;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}





