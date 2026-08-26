import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  buildYokomitsuCatalogSearchBody,
  buildYokomitsuCategorySearchBody,
  calculateYokomitsuTotalPages,
  createEmptyYokomitsuCheckpoint,
  discoverYokomitsuCategoriesFromHtml,
  mergeYokomitsuProduct,
  parseYokomitsuScrapeArgs,
  runYokomitsuFullCatalog,
  sanitizeYokomitsuCheckpoint,
  yokomitsuProductDedupKey,
  type YokomitsuCategoryRef,
} from './yokomitsu-full';
import {
  YOKOMITSU_FRONT_COOKIE_NAME,
  extractYokomitsuProductDetailFromHtml,
  YOKOMITSU_LOGIN_URL,
  YOKOMITSU_SEARCH_ENDPOINT,
} from './yokomitsu';
import type { ProductRecord } from '../interfaces/scraping.types';
import {
  YOKOMITSU_HTTP_LOGIN_URL,
  YOKOMITSU_PROCESS_LOGIN_ENDPOINT,
  type YokomitsuHttpClient,
  type YokomitsuHttpResponse,
} from './yokomitsu-auth';

test('Yokomitsu full arma busqueda vacia global con register=12 page base 1 view=grid', () => {
  assert.equal(buildYokomitsuCatalogSearchBody(), [
    'id_category=',
    'id_subcategory=',
    'id_subsubcategory=',
    'option_filter=',
    'search=',
    'order=',
    'register=12',
    'page=1',
    'view=grid',
  ].join('&'));
});

test('Yokomitsu full calcula paginas completas incluyendo 170 / 12 => 15', () => {
  assert.equal(calculateYokomitsuTotalPages(170, 12), 15);
  assert.equal(calculateYokomitsuTotalPages(24, 12), 2);
  assert.equal(calculateYokomitsuTotalPages(25, 12), 3);
});

test('Yokomitsu full descubre categorias jerarquicas y URLs /productos sanitizadas', () => {
  const categories = discoverYokomitsuCategoriesFromHtml(categoryMenuHtml());

  assert.equal(categories.length, 4);
  assert.ok(categories.some((category) => category.id_category === '10'));
  assert.ok(categories.some((category) => category.id_category === '10' && category.id_subcategory === '20'));
  assert.ok(categories.some((category) => category.id_category === '10' && category.id_subcategory === '20' && category.id_subsubcategory === '30'));
  assert.ok(categories.some((category) => category.id_subsubcategory === '999' && category.url?.includes('/productos/toyota/corolla/999/cremallera')));
});

test('Yokomitsu full descarta nombres de categoria invalidos tipo hoja de calculo', () => {
  const categories = discoverYokomitsuCategoriesFromHtml(`
    <nav>
      <a data-id_category="10">#N/A</a>
      <a data-id_category="11">#N/A (Did not find value '6115522201' in VLOOKUP evaluation.)</a>
      <a data-id_category="12">Dirección</a>
    </nav>
  `);

  assert.equal(categories.find((category) => category.id_category === '10')?.name, undefined);
  assert.equal(categories.find((category) => category.id_category === '11')?.name, undefined);
  assert.equal(categories.find((category) => category.id_category === '12')?.name, 'Dirección');
});

test('Yokomitsu full combina IDs correctos para load-data-search.php', () => {
  const body = buildYokomitsuCategorySearchBody({
    key: 'cat:10|sub:20|subsub:30|opt:40',
    id_category: '10',
    id_subcategory: '20',
    id_subsubcategory: '30',
    option_filter: '40',
    level: 'subsubcategory',
  }, 3, 12);
  const params = new URLSearchParams(body);

  assert.equal(params.get('id_category'), '10');
  assert.equal(params.get('id_subcategory'), '20');
  assert.equal(params.get('id_subsubcategory'), '30');
  assert.equal(params.get('option_filter'), '40');
  assert.equal(params.get('register'), '12');
  assert.equal(params.get('page'), '3');
  assert.equal(params.get('view'), 'grid');
});

test('Yokomitsu full recorre categorias, pagina independiente y no limita a 5 productos', async () => {
  const output: unknown[] = [];
  const client = createFakeFullClient({
    homeHtml: categoryMenuHtml(),
    totals: {
      [leafKey('10')]: 0,
      [leafKey('10', '20')]: 0,
      [leafKey('10', '20', '30')]: 13,
      [leafKey(undefined, undefined, '999')]: 1,
    },
    pages: {
      [leafKey('10', '20', '30')]: {
        1: Array.from({ length: 12 }, (_, index) => ({ sku: `YK-${String(index + 1).padStart(3, '0')}`, name: `Producto ${index + 1}` })),
        2: [{ sku: 'YK-013', name: 'Producto 13' }],
      },
      [leafKey(undefined, undefined, '999')]: {
        1: [{ sku: 'YK-999', name: 'Producto 999' }],
      },
    },
  });

  const result = await runYokomitsuFullCatalog(client, {
    credentials: sanitizedCredentials(),
    outputProduct: async (product) => { output.push(product); },
    retryDelayMs: 0,
  });

  assert.equal(result.emptySearchReturnedGlobalCatalog, false);
  assert.equal(result.discoveryMethod, 'category-tree');
  assert.equal(result.categoriesDiscovered, 1);
  assert.equal(result.subcategoriesDiscovered, 1);
  assert.equal(result.leafCategoriesProcessed, 4);
  assert.equal(result.pagesProcessed, 5);
  assert.equal(result.urlsDiscovered, 14);
  assert.equal(result.uniqueProducts, 14);
  assert.equal(result.validProducts, 14);
  assert.equal(output.length, 14);
  assert.deepEqual(result.limitations, []);
  assert.equal(client.searchRequests.filter((request) => request.id_subsubcategory === '30').length, 2);
  const largest = result.categoryCoverage.find((category) => category.key === leafKey('10', '20', '30'));
  assert.ok(largest);
  assert.equal(largest.numberRegister, 13);
  assert.equal(largest.totalPages, 2);
  assert.equal(largest.pagesProcessed, 2);
  assert.equal(largest.urlsExtracted, 13);
  assert.equal(largest.newUrls, 13);
  assert.equal(largest.duplicateUrls, 0);
});

test('Yokomitsu full procesa categorias sin productos sin fallar', async () => {
  const client = createFakeFullClient({
    homeHtml: '<nav><a data-id_category="77" href="/v2/productos/sin-productos">Sin productos</a></nav>',
    totals: { [leafKey('77')]: 0 },
    pages: { [leafKey('77')]: { 1: [] } },
  });

  const result = await runYokomitsuFullCatalog(client, {
    credentials: sanitizedCredentials(),
    retryDelayMs: 0,
  });

  assert.equal(result.leafCategoriesProcessed, 1);
  assert.equal(result.pagesProcessed, 1);
  assert.equal(result.validProducts, 0);
  assert.deepEqual(result.limitations, []);
});

test('Yokomitsu full deduplica globalmente varias categorias con mismo SKU', async () => {
  const output: unknown[] = [];
  const client = createFakeFullClient({
    homeHtml: `
      <a data-id_category="10">Categoria A</a>
      <a data-id_category="11">Categoria B</a>
    `,
    totals: {
      [leafKey('10')]: 1,
      [leafKey('11')]: 1,
    },
    pages: {
      [leafKey('10')]: { 1: [{ sku: 'YK-DUP', name: 'Producto duplicado A' }] },
      [leafKey('11')]: { 1: [{ sku: 'YK-DUP', name: 'Producto duplicado B' }] },
    },
  });

  const result = await runYokomitsuFullCatalog(client, {
    credentials: sanitizedCredentials(),
    outputProduct: async (product) => { output.push(product); },
    retryDelayMs: 0,
  });

  assert.equal(result.urlsDiscovered, 1);
  assert.equal(result.duplicates, 1);
  assert.equal(output.length, 1);
  const duplicatedCategory = result.categoryCoverage.find((category) => category.key === leafKey('11'));
  assert.equal(duplicatedCategory?.urlsExtracted, 1);
  assert.equal(duplicatedCategory?.newUrls, 0);
  assert.equal(duplicatedCategory?.duplicateUrls, 1);
});

test('Yokomitsu full informa limitacion si una categoria falla y continua las demas', async () => {
  const client = createFakeFullClient({
    homeHtml: `
      <a data-id_category="10">Categoria OK</a>
      <a data-id_category="11">Categoria falla</a>
    `,
    totals: { [leafKey('10')]: 1 },
    pages: { [leafKey('10')]: { 1: [{ sku: 'YK-OK', name: 'Producto OK' }] } },
    failCategoryKeys: new Set([leafKey('11')]),
  });

  const result = await runYokomitsuFullCatalog(client, {
    credentials: sanitizedCredentials(),
    retryDelayMs: 0,
  });

  assert.equal(result.validProducts, 1);
  assert.equal(result.failedCategories.length, 1);
  assert.ok(result.limitations.some((limitation) => /categories failed/.test(limitation)));
  assert.ok(result.limitations.some((limitation) => /remain unprocessed/.test(limitation)));
});

test('Yokomitsu full retoma por checkpoint categorias, paginas y fichas', async () => {
  const output: unknown[] = [];
  const checkpoint = sanitizeYokomitsuCheckpoint({
    ...createEmptyYokomitsuCheckpoint('2026-08-18T00:00:00.000Z'),
    discoveryMethod: 'category-tree',
    discoveredCategories: [{
      key: leafKey('10'),
      id_category: '10',
      level: 'category',
    }],
    completedPages: [`${leafKey('10')}:page:1`],
    discoveredProducts: [{
      sourceUrl: 'https://www.yokomitsuparts.com.uy/v2/producto-detalle/modelo/YK-001/producto-1',
      sku: 'YK-001',
    }],
  });
  const client = createFakeFullClient({
    homeHtml: '<a data-id_category="10">Categoria</a>',
    totals: { [leafKey('10')]: 1 },
    pages: { [leafKey('10')]: { 1: [{ sku: 'YK-001', name: 'Producto 1' }] } },
  });

  const result = await runYokomitsuFullCatalog(client, {
    credentials: sanitizedCredentials(),
    checkpoint,
    outputProduct: async (product) => { output.push(product); },
    retryDelayMs: 0,
  });

  assert.equal(client.searchRequests.length, 1);
  assert.equal(result.validProducts, 1);
  assert.equal(output.length, 1);
});

test('Yokomitsu full sanitiza checkpoint sin secretos', () => {
  const checkpoint = sanitizeYokomitsuCheckpoint({
    ...createEmptyYokomitsuCheckpoint('2026-08-18T00:00:00.000Z'),
    discoveredCategories: [
      { key: leafKey('10'), id_category: '10', level: 'category' },
      { key: 'cookie:YOKOMITSU_FRONT=SECRET', id_category: '1', level: 'category' },
    ],
    discoveredProducts: [
      { sourceUrl: 'https://www.yokomitsuparts.com.uy/v2/producto-detalle/a?x=1', sku: 'YK-001' },
      { sourceUrl: 'cookie:YOKOMITSU_FRONT=SECRET', sku: 'SECRET' },
    ],
    processedProductKeys: [
      'url:https://www.yokomitsuparts.com.uy/v2/producto-detalle/a',
      'auth_token=SECRET',
    ],
  });

  assert.deepEqual(checkpoint.discoveredCategories, [{
    key: leafKey('10'),
    name: undefined,
    url: undefined,
    id_category: '10',
    id_subcategory: undefined,
    id_subsubcategory: undefined,
    option_filter: undefined,
    level: 'category',
  }]);
  assert.deepEqual(checkpoint.processedProductKeys, ['url:https://www.yokomitsuparts.com.uy/v2/producto-detalle/a']);
  assert.deepEqual(checkpoint.discoveredProducts, [
    { sourceUrl: 'https://www.yokomitsuparts.com.uy/v2/producto-detalle/a', sku: 'YK-001' },
  ]);
});

test('Yokomitsu full deduplica por URL canonica y SKU', () => {
  assert.equal(yokomitsuProductDedupKey({
    productName: 'A',
    sourceUrl: 'https://www.yokomitsuparts.com.uy/v2/producto-detalle/m/1/a?x=1#top',
    provider: 'Yokomitsu',
    extractedAt: '2026-08-18T00:00:00.000Z',
  }), 'url:https://www.yokomitsuparts.com.uy/v2/producto-detalle/m/1/a');
  assert.equal(yokomitsuProductDedupKey({
    productName: 'A',
    sku: ' yk-001 ',
    provider: 'Yokomitsu',
    extractedAt: '2026-08-18T00:00:00.000Z',
  }), 'sku:YK-001');
});

test('Yokomitsu scrape CLI parsea --output con valor separado y con igual', () => {
  assert.equal(parseYokomitsuScrapeArgs(['--output', './tmp/file.jsonl']).get('output'), './tmp/file.jsonl');
  assert.equal(parseYokomitsuScrapeArgs(['--output=./tmp/file.jsonl']).get('output'), './tmp/file.jsonl');
  assert.equal(parseYokomitsuScrapeArgs(['--headed', '--output', './tmp/file.jsonl']).get('headed'), 'true');
  assert.notEqual(parseYokomitsuScrapeArgs(['--output', './tmp/file.jsonl']).get('output'), 'true');
});

test('Yokomitsu merge final elimina contenido-no-disponible heredado del listing si la ficha no tiene foto real', () => {
  const sourceUrl = 'https://yokomitsuparts.com.uy/v2/producto-detalle/rio/53098/frente-rio-2012-2016';
  const listing = yokomitsuListing({
    productName: 'FRENTE',
    sourceUrl,
    sku: '3136501333',
    brand: 'KIA',
    imageUrl: 'https://www.yokomitsuparts.com.uy/v2/images/contenido-no-disponible.jpg',
    imageUrls: ['https://www.yokomitsuparts.com.uy/v2/images/contenido-no-disponible.jpg'],
  });
  const detail = extractYokomitsuProductDetailFromHtml(`
    <html>
      <head>
        <title>FRENTE RIO '2012-2016' - YOKOMITSU</title>
        <meta property="og:title" content="FRENTE RIO '2012-2016'">
        <meta property="og:image" content="/v2/images/contenido-no-disponible.jpg">
      </head>
      <body>
        <article class="producto-detalle" data-codprod="3136501333">
          <h1>FRENTE</h1>
          <h2>FRENTE RIO '2012-2016'</h2>
          <div>CONTENIDO NO DISPONIBLE</div>
          <img src="/v2/images/contenido-no-disponible.jpg">
          <img src="/v2/images/logo-yokomitsu.png">
          <img src="/v2/images/icon-fono.svg">
          <span>Cód. Yokomitsu: 3136501333</span>
          <span>Marca KIA Modelo RIO</span>
          <strong class="precio">$3.406 +IVA</strong>
        </article>
      </body>
    </html>
  `, sourceUrl);
  assert.ok(detail);
  assert.equal(detail.imageUrl, undefined);
  assert.equal(detail.imageUrls, undefined);

  const finalProduct = mergeYokomitsuProduct(listing, detail);

  assert.equal(finalProduct.productName, "FRENTE RIO '2012-2016'");
  assert.equal(finalProduct.imageUrl, undefined);
  assert.equal(finalProduct.imageUrls, undefined);
  assert.equal(finalProduct.sku, '3136501333');
  assert.deepEqual(finalProduct.compatibleBrands, ['KIA']);
  assert.deepEqual(finalProduct.compatibleModels, ['RIO']);
});

test('Yokomitsu merge final conserva productsGalleries embebidas en HTML escapado de la ficha', () => {
  const sourceUrl = 'https://yokomitsuparts.com.uy/v2/producto-detalle/rio/47930/paragolpe-delantero-hatchback-rio-2012-2014';
  const listing = yokomitsuListing({
    productName: 'PARAGOLPE DELANTERO',
    sourceUrl,
    sku: '3136502934',
    brand: 'KIA',
    imageUrl: 'https://www.yokomitsuparts.com.uy/v2/images/contenido-no-disponible.jpg',
    imageUrls: ['https://www.yokomitsuparts.com.uy/v2/images/contenido-no-disponible.jpg'],
  });
  const detail = extractYokomitsuProductDetailFromHtml(`
    <html>
      <head>
        <title>PARAGOLPE DELANTERO HATCHBACK RIO '2012-2014' - YOKOMITSU</title>
        <meta property="og:title" content="PARAGOLPE DELANTERO HATCHBACK RIO '2012-2014'">
      </head>
      <body>
        <article class="producto-detalle" data-codprod="3136502934">
          <h1>PARAGOLPE DELANTERO</h1>
          <h2>PARAGOLPE DELANTERO HATCHBACK RIO '2012-2014'</h2>
          <script>
            window.productGallery = [
              "\\/v2\\/upload\\/productsGalleries\\/img\\/CRKI112012.jpg",
              "\\/v2\\/upload\\/productsGalleries\\/img\\/CRKI112012_1.jpg",
              "\\/v2\\/upload\\/productsGalleries\\/img\\/CRKI112012_2.jpg"
            ];
          </script>
          <img src="/v2/images/contenido-no-disponible.jpg">
          <span>Cód. Yokomitsu: 3136502934</span>
          <span>Marca KIA Modelo RIO</span>
          <strong class="precio">$9.221 +IVA</strong>
        </article>
      </body>
    </html>
  `, sourceUrl);
  assert.ok(detail);
  assert.equal(detail.imageUrl, 'https://www.yokomitsuparts.com.uy/v2/upload/productsGalleries/img/CRKI112012.jpg');
  assert.deepEqual(detail.imageUrls, [
    'https://www.yokomitsuparts.com.uy/v2/upload/productsGalleries/img/CRKI112012.jpg',
    'https://www.yokomitsuparts.com.uy/v2/upload/productsGalleries/img/CRKI112012_1.jpg',
    'https://www.yokomitsuparts.com.uy/v2/upload/productsGalleries/img/CRKI112012_2.jpg',
  ]);

  const finalProduct = mergeYokomitsuProduct(listing, detail);

  assert.equal(finalProduct.productName, "PARAGOLPE DELANTERO HATCHBACK RIO '2012-2014'");
  assert.equal(finalProduct.imageUrl, 'https://www.yokomitsuparts.com.uy/v2/upload/productsGalleries/img/CRKI112012.jpg');
  assert.deepEqual(finalProduct.imageUrls, [
    'https://www.yokomitsuparts.com.uy/v2/upload/productsGalleries/img/CRKI112012.jpg',
    'https://www.yokomitsuparts.com.uy/v2/upload/productsGalleries/img/CRKI112012_1.jpg',
    'https://www.yokomitsuparts.com.uy/v2/upload/productsGalleries/img/CRKI112012_2.jpg',
  ]);
  assert.equal(finalProduct.imageUrls.some((url) => /contenido-no-disponible|logo|icon/i.test(url)), false);
});

test('Yokomitsu merge final conserva SKU marca y compatibilidad del listing si el detail no los aporta', () => {
  const sourceUrl = 'https://yokomitsuparts.com.uy/v2/producto-detalle/rio/47930/paragolpe-delantero-hatchback-rio-2012-2014';
  const listing = yokomitsuListing({
    productName: 'PARAGOLPE DELANTERO HATCHBACK RIO 2012-2014',
    sourceUrl,
    sku: '3136502934',
    brand: 'KIA',
    compatibleBrands: ['Kia'],
    compatibleModels: ['RIO'],
    attributes: {
      vehicleBrand: 'KIA',
      vehicleModel: 'RIO',
    },
  });
  const detail = extractYokomitsuProductDetailFromHtml(`
    <html>
      <head>
        <title>PARAGOLPE DELANTERO HATCHBACK RIO '2012-2014' - YOKOMITSU</title>
      </head>
      <body>
        <article class="producto-detalle">
          <h1>ver detalle</h1>
          <h2>PARAGOLPE DELANTERO HATCHBACK RIO '2012-2014'</h2>
          <img src="/v2/upload/productsGalleries/img/CRKI112012.jpg">
          <strong class="precio">$9.221 +IVA</strong>
        </article>
      </body>
    </html>
  `, sourceUrl);
  assert.ok(detail);
  assert.equal(detail.sku, undefined);
  assert.equal(detail.brand, undefined);
  assert.equal(detail.compatibleBrands?.length ?? 0, 0);
  assert.equal(detail.compatibleModels?.length ?? 0, 0);

  const finalProduct = mergeYokomitsuProduct(listing, detail);

  assert.equal(finalProduct.productName, "PARAGOLPE DELANTERO HATCHBACK RIO '2012-2014'");
  assert.equal(finalProduct.sku, '3136502934');
  assert.equal(finalProduct.brand, 'KIA');
  assert.deepEqual(finalProduct.compatibleBrands, ['KIA']);
  assert.deepEqual(finalProduct.compatibleModels, ['RIO']);
  assert.equal(finalProduct.imageUrl, 'https://www.yokomitsuparts.com.uy/v2/upload/productsGalleries/img/CRKI112012.jpg');
});

test('Yokomitsu merge final no persiste Ver detalle y usa el slug si no hay titulo util', () => {
  const sourceUrl = 'https://www.yokomitsuparts.com.uy/v2/producto-detalle/picanto/43606/puntero-izquierdo-ctr-picanto-2012-';
  const listing = yokomitsuListing({
    productName: 'ver detalle',
    sourceUrl,
    attributes: {
      referencia: '56820-1Y500',
      procedencia: 'COREA',
    },
  });

  const finalProduct = mergeYokomitsuProduct(listing, undefined);

  assert.equal(finalProduct.productName, 'PUNTERO IZQUIERDO CTR PICANTO 2012-');
  assert.equal(finalProduct.imageUrl, undefined);
  assert.equal(finalProduct.imageUrls, undefined);
  assert.equal(finalProduct.attributes?.referencia, '56820-1Y500');
});

test('Yokomitsu merge final usa compatibilidad limpia del detalle y descarta listing contaminado', () => {
  const sourceUrl = 'https://www.yokomitsuparts.com.uy/v2/producto-detalle/2008/222/paragolpe-delantero-s-sensor-2008-2021-';
  const listing = yokomitsuListing({
    productName: 'ver detalle',
    sourceUrl,
    brand: "PEUGEOT PARAGOLPE DELANTERO S/SENSOR 2008 '2021-",
    compatibleBrands: ["PEUGEOT PARAGOLPE DELANTERO S/SENSOR 2008 '2021-"],
    compatibleModels: ["PARAGOLPE DELANTERO S/SENSOR 2008 '2021-"],
    attributes: {
      vehicleBrand: "PEUGEOT PARAGOLPE DELANTERO S/SENSOR 2008 '2021-",
      vehicleModel: "PARAGOLPE DELANTERO S/SENSOR 2008 '2021-",
    },
  });
  const detail = extractYokomitsuProductDetailFromHtml(`
    <article class="producto-detalle" data-codprod="YK-PEUGEOT">
      <h1>PARAGOLPE DELANTERO S/SENSOR 2008 '2021-</h1>
      <span>Cód. Yokomitsu: YK-PEUGEOT</span>
      <span>Marca: PEUGEOT PARAGOLPE DELANTERO S/SENSOR 2008 '2021-</span>
      <span>Modelo: 2008</span>
      <strong class="precio">$1.700 +IVA</strong>
    </article>
  `, sourceUrl);
  assert.ok(detail);

  const finalProduct = mergeYokomitsuProduct(listing, detail);

  assert.equal(finalProduct.productName, 'PARAGOLPE DELANTERO S/SENSOR 2008 2021-');
  assert.equal(finalProduct.brand, 'PEUGEOT');
  assert.deepEqual(finalProduct.compatibleBrands, ['PEUGEOT']);
  assert.deepEqual(finalProduct.compatibleModels, ['2008']);
  assert.equal(finalProduct.compatibleModels?.some((model) => /PARAGOLPE/i.test(model)), false);
});

interface FakeFullOptions {
  homeHtml: string;
  totals: Record<string, number>;
  pages: Record<string, Record<number, Array<{ sku: string; name: string }>>>;
  failCategoryKeys?: Set<string>;
}

interface FakeFullClient extends YokomitsuHttpClient {
  searchRequests: Array<{ id_category?: string; id_subcategory?: string; id_subsubcategory?: string; page: number }>;
  loginPosts: number;
}

function createFakeFullClient(options: FakeFullOptions): FakeFullClient {
  let hasCookie = false;
  let loginPosts = 0;
  const searchRequests: FakeFullClient['searchRequests'] = [];
  const client: FakeFullClient = {
    searchRequests,
    get loginPosts() { return loginPosts; },
    get: async (url) => {
      if (url === YOKOMITSU_HTTP_LOGIN_URL) {
        hasCookie = true;
        return response(url, loginHtml(), { 'set-cookie': `${YOKOMITSU_FRONT_COOKIE_NAME}=REDACTED; Path=/; Secure` });
      }
      if (url === YOKOMITSU_LOGIN_URL) return response(url, portalHtml(options.homeHtml));
      return response(url, detailHtml(url));
    },
    post: async (url, body) => {
      if (url === YOKOMITSU_PROCESS_LOGIN_ENDPOINT) {
        loginPosts += 1;
        return response(url, '{"error":false,"message":"success"}');
      }
      if (url !== YOKOMITSU_SEARCH_ENDPOINT) throw new Error(`unexpected POST ${url}`);
      assert.equal(hasCookie, true);
      const params = new URLSearchParams(body);
      const request = {
        id_category: params.get('id_category') || undefined,
        id_subcategory: params.get('id_subcategory') || undefined,
        id_subsubcategory: params.get('id_subsubcategory') || undefined,
        page: Number(params.get('page') ?? '1'),
      };
      searchRequests.push(request);
      const key = leafKey(request.id_category, request.id_subcategory, request.id_subsubcategory);
      if (options.failCategoryKeys?.has(key)) return response(url, '<html>not json</html>');
      return response(url, searchJson(options.totals[key] ?? 0, options.pages[key]?.[request.page] ?? []));
    },
    getCookieNames: async () => hasCookie ? [YOKOMITSU_FRONT_COOKIE_NAME] : [],
    clearSession: async () => {
      hasCookie = false;
    },
  };
  return client;
}

function categoryMenuHtml(): string {
  return `
    <nav class="catalogo">
      <a data-id_category="10" href="/v2/productos/direccion">Dirección</a>
      <a data-id_category="10" data-id_subcategory="20" href="/v2/productos/direccion/cremalleras">Cremalleras</a>
      <a data-id_category="10" data-id_subcategory="20" data-id_subsubcategory="30" href="/v2/productos/direccion/cremalleras/hidraulicas">Hidráulicas</a>
      <a href="/v2/productos/toyota/corolla/999/cremallera">Toyota Corolla</a>
    </nav>
  `;
}

function sanitizedCredentials() {
  return { username: 'SANITIZED_RUT', password: 'SANITIZED_PASSWORD' };
}

function yokomitsuListing(patch: Partial<ProductRecord>): ProductRecord {
  return {
    provider: 'Yokomitsu',
    extractedAt: '2026-08-21T00:00:00.000Z',
    ...patch,
  };
}

function leafKey(id_category?: string, id_subcategory?: string, id_subsubcategory?: string): string {
  return [
    `cat:${id_category ?? ''}`,
    `sub:${id_subcategory ?? ''}`,
    `subsub:${id_subsubcategory ?? ''}`,
    'opt:',
  ].join('|');
}

function response(
  url: string,
  body: string,
  headers: Record<string, string | string[] | undefined> = {},
  status = 200,
): YokomitsuHttpResponse {
  return { url, status, headers, body };
}

function loginHtml(): string {
  return '<form id="formLogin"><input name="rut"><input type="password" name="password"><input type="hidden" name="auth_token" value="SANITIZED_AUTH_TOKEN"></form>';
}

function portalHtml(menu: string): string {
  return `<section class="catalogo"><article class="producto">Portal</article>${menu}</section>`;
}

function searchJson(total: number, products: Array<{ sku: string; name: string }>): string {
  return JSON.stringify({
    error: false,
    number_register: total,
    data: products.map((product) => `
      <article class="producto" data-codprod="${product.sku}">
        <a href="/v2/producto-detalle/modelo/${encodeURIComponent(product.name)}/${product.sku}/${product.name.toLowerCase().replace(/\s+/g, '-')}">${product.name}</a>
        <span>Cód. Yokomitsu: ${product.sku}</span>
        <span class="precio">$3.406 +IVA</span>
      </article>
    `).join(''),
    pagination: '',
    text_pagination: '',
  });
}

function detailHtml(url: string): string {
  const sku = url.match(/(YK-[A-Z0-9-]+)/)?.[1] ?? 'YK-DETAIL';
  return `
    <article class="producto" data-codprod="${sku}">
      <h1>Detalle ${sku}</h1>
      <span>Cód. Yokomitsu: ${sku}</span>
      <span>OEM: OEM-${sku}</span>
      <span>Procedencia: CHINA</span>
      <span>Stock Crítico</span>
      <span class="precio">$9.221 +IVA</span>
      <img src="/imagenes/${sku}.jpg">
    </article>
  `;
}
