import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  closeYokomitsuSessionResources,
  extractCookieNames,
  extractFieldNamesFromBody,
  extractYokomitsuProductDetailFromHtml,
  extractYokomitsuProductsFromJson,
  hasReachedYokomitsuPortal,
  hasVisibleYokomitsuCaptchaChallenge,
  hasYokomitsuManualLoginTimedOut,
  inferApproximateProductCount,
  inferPaginationFromCalls,
  inferYokomitsuFieldsAvailable,
  isLikelyYokomitsuCatalogUrl,
  isYokomitsuSearchEndpoint,
  normalizeYokomitsuPrice,
  parseYokomitsuSearchRequestBody,
  parseYokomitsuSearchResponse,
  parseYokomitsuSearchResponseFull,
  sanitizeHeaders,
  sanitizeRequestBody,
  sanitizeUrl,
  summarizeJsonShape,
  summarizeYokomitsuSearchAuth,
  YOKOMITSU_FRONT_COOKIE_NAME,
  YOKOMITSU_LEGACY_LOGIN_URL,
  YOKOMITSU_LOGIN_URL,
  YOKOMITSU_SEARCH_ENDPOINT,
} from './yokomitsu';
import {
  authenticateYokomitsuHttpSession,
  buildYokomitsuLoginForm,
  extractSetCookieNames,
  extractYokomitsuAuthTokenFromHtml,
  fetchYokomitsuCatalogWithSession,
  isYokomitsuSessionExpiredResponse,
  parseYokomitsuLoginResponse,
  withYokomitsuHttpSession,
  YOKOMITSU_HTTP_LOGIN_URL,
  YOKOMITSU_PROCESS_LOGIN_ENDPOINT,
  type YokomitsuHttpClient,
  type YokomitsuHttpResponse,
} from './yokomitsu-auth';

test('Yokomitsu normaliza precios uruguayos sin afectar otros proveedores', () => {
  assert.equal(normalizeYokomitsuPrice('$ 1.234'), '1234');
  assert.equal(normalizeYokomitsuPrice('UYU 12.345'), '12345');
  assert.equal(normalizeYokomitsuPrice('$U 1.234,50'), '1234.50');
  assert.equal(normalizeYokomitsuPrice('123,45'), '123.45');
  assert.equal(normalizeYokomitsuPrice('$3.406 +IVA'), '3406');
  assert.equal(normalizeYokomitsuPrice('$9.221 +IVA'), '9221');
});

test('Yokomitsu redacta credenciales, cookies y tokens en requests', () => {
  assert.equal(
    sanitizeUrl('https://www.yokomitsuparts.com.uy/v2/api/catalogo?token=abc&page=2'),
    'https://www.yokomitsuparts.com.uy/v2/api/catalogo?token=%5BREDACTED%5D&page=2',
  );
  assert.deepEqual(sanitizeHeaders({
    authorization: 'Bearer secret',
    cookie: 'session=secret',
    'set-cookie': 'session=secret',
    accept: 'application/json',
  }), {
    authorization: '[REDACTED]',
    cookie: '[REDACTED]',
    'set-cookie': '[REDACTED]',
    accept: 'application/json',
  });
  assert.deepEqual(sanitizeRequestBody('usuario=demo&password=secret&empresa=abc'), {
    usuario: '[REDACTED]',
    password: '[REDACTED]',
    empresa: '[VALUE]',
  });
  assert.deepEqual(sanitizeRequestBody('rut=123456&auth_token=SANITIZED_AUTH_TOKEN&password=secret&remember=0'), {
    rut: '[REDACTED]',
    auth_token: '[REDACTED]',
    password: '[REDACTED]',
    remember: '[VALUE]',
  });
  assert.deepEqual(extractFieldNamesFromBody('usuario=demo&password=secret'), ['usuario', 'password']);
});

test('Yokomitsu extrae auth_token hidden y nombres de Set-Cookie sin valores', () => {
  const fixture = readYokomitsuLoginFixture();
  assert.equal(extractYokomitsuAuthTokenFromHtml(fixture.loginHtml), 'SANITIZED_AUTH_TOKEN');
  assert.equal(extractYokomitsuAuthTokenFromHtml(fixture.loginHtmlWithoutToken), undefined);
  assert.deepEqual(extractSetCookieNames({
    'set-cookie': `${YOKOMITSU_FRONT_COOKIE_NAME}=REDACTED; Path=/; Secure`,
  }), [YOKOMITSU_FRONT_COOKIE_NAME]);
});

test('Yokomitsu arma login HTTP con campos reales y redaccion segura', () => {
  const form = buildYokomitsuLoginForm({
    username: 'SANITIZED_RUT',
    password: 'SANITIZED_PASSWORD',
  }, 'SANITIZED_AUTH_TOKEN');

  assert.deepEqual(Array.from(form.keys()), ['rut', 'office', 'password', 'remember', 'auth_token']);
  assert.equal(form.get('office'), '0');
  assert.equal(form.get('remember'), '0');
  assert.deepEqual(sanitizeRequestBody(form.toString()), {
    rut: '[REDACTED]',
    office: '[VALUE]',
    password: '[REDACTED]',
    remember: '[VALUE]',
    auth_token: '[REDACTED]',
  });
});

test('Yokomitsu interpreta respuestas success y error de process-login.php', () => {
  const fixture = readYokomitsuLoginFixture();
  assert.deepEqual(parseYokomitsuLoginResponse(fixture.loginSuccess), {
    success: true,
    message: 'success',
    error: false,
  });
  assert.deepEqual(parseYokomitsuLoginResponse('{"error":false,"message":"success-cart"}'), {
    success: true,
    message: 'success-cart',
    error: false,
  });
  assert.deepEqual(parseYokomitsuLoginResponse(fixture.loginError), {
    success: false,
    message: 'invalid credentials',
    error: true,
  });
});

test('Yokomitsu login HTTP reutiliza YOKOMITSU_FRONT y valida home autenticado', async () => {
  const fixture = readYokomitsuLoginFixture();
  const calls: Array<{ method: string; url: string; body?: string }> = [];
  const client = createFakeYokomitsuClient(calls, [
    response(YOKOMITSU_HTTP_LOGIN_URL, fixture.loginHtml, {
      'set-cookie': `${YOKOMITSU_FRONT_COOKIE_NAME}=REDACTED; Path=/; Secure`,
    }),
    response(YOKOMITSU_PROCESS_LOGIN_ENDPOINT, fixture.loginSuccess),
    response(YOKOMITSU_LOGIN_URL, fixture.portalHtml),
  ]);

  const result = await authenticateYokomitsuHttpSession(client, {
    username: 'SANITIZED_RUT',
    password: 'SANITIZED_PASSWORD',
  });

  assert.equal(result.authenticated, true);
  assert.equal(result.method, 'POST');
  assert.equal(result.endpoint, YOKOMITSU_PROCESS_LOGIN_ENDPOINT);
  assert.deepEqual(result.fieldNames, ['rut', 'office', 'password', 'remember', 'auth_token']);
  assert.equal(result.usesSessionCookie, true);
  assert.deepEqual(result.sessionCookieNames, [YOKOMITSU_FRONT_COOKIE_NAME]);
  assert.equal(result.usesBearerToken, false);
  assert.equal(result.authorizationHeaderObserved, false);
  assert.deepEqual(calls.map((call) => `${call.method} ${call.url}`), [
    `GET ${YOKOMITSU_HTTP_LOGIN_URL}`,
    `POST ${YOKOMITSU_PROCESS_LOGIN_ENDPOINT}`,
    `GET ${YOKOMITSU_LOGIN_URL}`,
  ]);
  assert.deepEqual(sanitizeRequestBody(calls[1].body), {
    rut: '[REDACTED]',
    office: '[VALUE]',
    password: '[REDACTED]',
    remember: '[VALUE]',
    auth_token: '[REDACTED]',
  });
});

test('Yokomitsu login HTTP falla claramente si auth_token falta o el login responde error', async () => {
  const fixture = readYokomitsuLoginFixture();
  const missingToken = await authenticateYokomitsuHttpSession(createFakeYokomitsuClient([], [
    response(YOKOMITSU_HTTP_LOGIN_URL, fixture.loginHtmlWithoutToken, {
      'set-cookie': `${YOKOMITSU_FRONT_COOKIE_NAME}=REDACTED; Path=/; Secure`,
    }),
  ]), {
    username: 'SANITIZED_RUT',
    password: 'SANITIZED_PASSWORD',
  });
  assert.equal(missingToken.authenticated, false);
  assert.match(missingToken.error ?? '', /auth_token missing/);

  const rejected = await authenticateYokomitsuHttpSession(createFakeYokomitsuClient([], [
    response(YOKOMITSU_HTTP_LOGIN_URL, fixture.loginHtml, {
      'set-cookie': `${YOKOMITSU_FRONT_COOKIE_NAME}=REDACTED; Path=/; Secure`,
    }),
    response(YOKOMITSU_PROCESS_LOGIN_ENDPOINT, fixture.loginError),
  ]), {
    username: 'SANITIZED_RUT',
    password: 'SANITIZED_PASSWORD',
  });
  assert.equal(rejected.authenticated, false);
  assert.match(rejected.error ?? '', /login rejected/);
});

test('Yokomitsu detecta sesion vencida por redirect, HTML de login o home no autenticado', () => {
  const fixture = readYokomitsuLoginFixture();
  assert.equal(isYokomitsuSessionExpiredResponse(response('https://www.yokomitsuparts.com.uy/v2/login', fixture.expiredHtml)), true);
  assert.equal(isYokomitsuSessionExpiredResponse(response(YOKOMITSU_SEARCH_ENDPOINT, '', {
    location: '/v2/login',
  }, 302)), true);
  assert.equal(isYokomitsuSessionExpiredResponse(response(YOKOMITSU_SEARCH_ENDPOINT, fixture.expiredHtml)), true);
  assert.equal(isYokomitsuSessionExpiredResponse(response(YOKOMITSU_SEARCH_ENDPOINT, '{"error":false,"data":"<article></article>"}')), false);
});

test('Yokomitsu re-login controlado ocurre como maximo una vez por ejecucion', async () => {
  const fixture = readYokomitsuLoginFixture();
  const calls: Array<{ method: string; url: string; body?: string }> = [];
  const client = createFakeYokomitsuClient(calls, [
    response(YOKOMITSU_HTTP_LOGIN_URL, fixture.loginHtml, { 'set-cookie': `${YOKOMITSU_FRONT_COOKIE_NAME}=REDACTED; Path=/; Secure` }),
    response(YOKOMITSU_PROCESS_LOGIN_ENDPOINT, fixture.loginSuccess),
    response(YOKOMITSU_LOGIN_URL, fixture.portalHtml),
    response(YOKOMITSU_SEARCH_ENDPOINT, fixture.expiredHtml),
    response(YOKOMITSU_HTTP_LOGIN_URL, fixture.loginHtml, { 'set-cookie': `${YOKOMITSU_FRONT_COOKIE_NAME}=REDACTED; Path=/; Secure` }),
    response(YOKOMITSU_PROCESS_LOGIN_ENDPOINT, fixture.loginSuccess),
    response(YOKOMITSU_LOGIN_URL, fixture.portalHtml),
    response(YOKOMITSU_SEARCH_ENDPOINT, fixture.expiredHtml),
  ]);

  const result = await fetchYokomitsuCatalogWithSession(client, {
    body: 'search=CREMALLERA&register=12&view=grid',
    credentials: {
      username: 'SANITIZED_RUT',
      password: 'SANITIZED_PASSWORD',
    },
    maxRelogins: 1,
  });

  assert.equal(result.loginAttempts, 2);
  assert.equal(result.relogins, 1);
  assert.equal(result.sessionExpired, true);
  assert.equal(calls.filter((call) => call.url === YOKOMITSU_PROCESS_LOGIN_ENDPOINT).length, 2);
  assert.equal(calls.filter((call) => call.url === YOKOMITSU_SEARCH_ENDPOINT).length, 2);
});

test('Yokomitsu limpia la sesion HTTP en finally', async () => {
  const fixture = readYokomitsuLoginFixture();
  const calls: Array<{ method: string; url: string; body?: string }> = [];
  const client = createFakeYokomitsuClient(calls, [
    response(YOKOMITSU_HTTP_LOGIN_URL, fixture.loginHtml, { 'set-cookie': `${YOKOMITSU_FRONT_COOKIE_NAME}=REDACTED; Path=/; Secure` }),
    response(YOKOMITSU_PROCESS_LOGIN_ENDPOINT, fixture.loginSuccess),
    response(YOKOMITSU_LOGIN_URL, fixture.portalHtml),
  ]);

  await assert.rejects(() => clientWithSessionCleanup(client, async () => {
    throw new Error('diagnostic failed after login');
  }), /diagnostic failed/);
  assert.equal(calls.at(-1)?.method, 'CLEAR');
});

test('Yokomitsu resume autenticacion observada del buscador sin valores sensibles', () => {
  const auth = summarizeYokomitsuSearchAuth({
    cookie: `${YOKOMITSU_FRONT_COOKIE_NAME}=redacted; other_cookie=redacted`,
    'x-requested-with': 'XMLHttpRequest',
    'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
  });

  assert.equal(auth.usesSessionCookie, true);
  assert.deepEqual(auth.cookieNames, [YOKOMITSU_FRONT_COOKIE_NAME]);
  assert.equal(auth.authorizationHeaderObserved, false);
  assert.equal(auth.usesBearerToken, false);
  assert.deepEqual(extractCookieNames(`${YOKOMITSU_FRONT_COOKIE_NAME}=redacted; analytics=redacted`), [
    YOKOMITSU_FRONT_COOKIE_NAME,
    'analytics',
  ]);
});

test('Yokomitsu extrae muestra desde JSON sanitizado de catalogo', () => {
  const body = {
    total: 1234,
    page: 1,
    data: [{
      codigo: 'YK-001',
      nombre: 'Filtro de aceite',
      marcaProducto: 'Marca Demo',
      precio: '1.234,50',
      moneda: 'UYU',
      stock: '7',
      referencia: 'REF-001',
      categoria: 'Filtros',
      marcaVehiculo: 'Toyota',
      modeloVehiculo: 'Corolla',
      imagen: '/img/filtro.jpg',
    }],
  };

  const products = extractYokomitsuProductsFromJson(body, 'https://www.yokomitsuparts.com.uy/v2/');
  assert.equal(products.length, 1);
  assert.equal(products[0].provider, 'Yokomitsu');
  assert.equal(products[0].productName, 'Filtro de aceite');
  assert.equal(products[0].sku, 'YK-001');
  assert.equal(products[0].price, '1234.50');
  assert.equal(products[0].currency, 'UYU');
  assert.equal(products[0].availability, 'in_stock');
  assert.equal(products[0].attributes?.referencia, 'REF-001');
  assert.equal(products[0].attributes?.vehicleBrand, 'Toyota');
  assert.equal(products[0].attributes?.vehicleModel, 'Corolla');
  assert.equal(products[0].imageUrl, 'https://www.yokomitsuparts.com.uy/img/filtro.jpg');
  assert.equal(inferApproximateProductCount(body), 1234);
});

test('Yokomitsu clasifica load-data-search.php como endpoint de catalogo y busqueda', () => {
  assert.equal(isYokomitsuSearchEndpoint('https://www.yokomitsuparts.com.uy/v2/ajax/load-data-search.php'), true);
  assert.equal(isLikelyYokomitsuCatalogUrl('https://www.yokomitsuparts.com.uy/v2/ajax/load-data-search.php'), true);
});

test('Yokomitsu interpreta requests de busqueda con pagina base uno y grilla', () => {
  const initial = parseYokomitsuSearchRequestBody('search=CREMALLERA&register=12');
  const page2 = parseYokomitsuSearchRequestBody('search=CREMALLERA&register=12&page=2&view=grid');
  const page3 = parseYokomitsuSearchRequestBody('search=CREMALLERA&register=12&page=3&view=grid');

  assert.equal(initial.page, 1);
  assert.equal(initial.register, 12);
  assert.equal(page2.page, 2);
  assert.equal(page2.register, 12);
  assert.equal(page2.view, 'grid');
  assert.equal(page3.page, 3);
  assert.equal(page3.register, 12);
  assert.equal(page3.view, 'grid');
});

test('Yokomitsu parsea JSON servido como text/html y calcula paginacion confirmada', () => {
  const request = parseYokomitsuSearchRequestBody('search=CREMALLERA&register=12&view=grid');
  const summary = parseYokomitsuSearchResponse(readYokomitsuFixture('search-page-1.json'), request);

  assert.ok(summary);
  assert.equal(summary.numberRegister, 170);
  assert.equal(summary.pageSize, 12);
  assert.equal(summary.currentPage, 1);
  assert.equal(summary.totalPages, 15);
  assert.equal(summary.textPagination, 'Visualizaci\u00f3n de 1 a 12 registros');
});

test('Yokomitsu respeta page=2 y page=3 en respuestas sanitizadas', () => {
  const page2 = parseYokomitsuSearchResponse(
    readYokomitsuFixture('search-page-2.json'),
    parseYokomitsuSearchRequestBody('search=CREMALLERA&register=12&page=2&view=grid'),
  );
  const page3 = parseYokomitsuSearchResponse(
    readYokomitsuFixture('search-page-3.json'),
    parseYokomitsuSearchRequestBody('search=CREMALLERA&register=12&page=3&view=grid'),
  );

  assert.equal(page2?.currentPage, 2);
  assert.equal(page2?.pageSize, 12);
  assert.equal(page2?.totalPages, 15);
  assert.equal(page3?.currentPage, 3);
  assert.equal(page3?.pageSize, 12);
  assert.equal(page3?.totalPages, 15);
});

test('Yokomitsu extrae productos desde data HTML sin asumir stock por Comprar', () => {
  const products = extractYokomitsuProductsFromJson(JSON.parse(readYokomitsuFixture('search-page-1.json')));

  assert.equal(products.length, 2);
  assert.equal(products[0].productName, 'Cremallera direccion Toyota Corolla');
  assert.equal(products[0].sourceUrl, 'https://www.yokomitsuparts.com.uy/v2/producto-detalle/toyota-corolla/1001/cremallera-direccion');
  assert.equal(products[0].sku, 'YK-001');
  assert.equal(products[0].brand, 'DemoBrand');
  assert.equal(products[0].attributes?.referencia, 'OEM-001');
  assert.equal(products[0].attributes?.vehicleModel, 'Corolla');
  assert.equal(products[0].attributes?.proximaLlegada, '20 dias');
  assert.equal(products[0].attributes?.procedencia, 'JP');
  assert.equal(products[0].price, '3406');
  assert.equal(products[0].currency, 'UYU');
  assert.equal(products[0].imageUrl, 'https://www.yokomitsuparts.com.uy/v2/img/yokomitsu/yok-001.jpg');
  assert.equal(products[0].availability, 'Stock Cr\u00edtico');
  assert.equal(products[0].attributes?.stockStatus, 'Stock Cr\u00edtico');
  assert.equal(products[0].stock, undefined);
  assert.equal(products[1].price, '9221');
  assert.equal(products[1].availability, 'out_of_stock');
  assert.equal(products[1].attributes?.stockStatus, 'out_of_stock');
  assert.equal(products[1].stock, undefined);
});

test('Yokomitsu extrae todas las cards aunque el listado tenga muchos elementos de menu', () => {
  const menu = Array.from({ length: 40 }, (_, index) => `<li>Menu global ${index + 1}</li>`).join('');
  const data = `
    <ul class="menu">${menu}</ul>
    <section class="resultados">
      ${Array.from({ length: 12 }, (_, index) => `
        <article class="producto" data-codprod="YK-LIST-${index + 1}">
          <a href="/v2/producto-detalle/demo/${index + 1}/producto-${index + 1}"><h3>Producto listado ${index + 1}</h3></a>
          <span>C\u00f3d. Yokomitsu: YK-LIST-${index + 1}</span>
          <strong class="precio">$3.406 +IVA</strong>
        </article>
      `).join('')}
    </section>
  `;

  const products = extractYokomitsuProductsFromJson({ number_register: 12, data });

  assert.equal(products.length, 5);
  const full = parseYokomitsuSearchResponseFull(JSON.stringify({ number_register: 12, data }), parseYokomitsuSearchRequestBody('register=12'));
  assert.equal(full?.products.length, 12);
});

test('Yokomitsu detalle no contamina descripcion ni imagenes con assets globales', () => {
  const product = extractYokomitsuProductDetailFromHtml(`
    <html>
      <head>
        <style>.menu { display: block; }</style>
        <script>function globalMenu(){ $.ajax('/v2/ajax/menu.php'); }</script>
      </head>
      <body>
        <nav>Inicio Catalogo Ofertas Contacto</nav>
        <img src="/images/icon-fono.svg">
        <main>
          <article class="producto-detalle" data-codprod="YK-DETAIL-1">
            <h1>Cremallera direccion Toyota Corolla</h1>
            <div class="product-gallery">
              <img src="/v2/upload/productsGalleries/img/yok-detail-1.jpg">
              <img data-zoom-image="/v2/upload/productsGalleries/img/yok-detail-1-alt.webp">
              <img src="/images/loading.gif">
            </div>
            <section class="descripcion-producto">Cremallera hidraulica nueva para aplicacion sanitizada.</section>
            <span>C\u00f3d. Yokomitsu: YK-DETAIL-1</span>
            <span>Marca: DemoBrand</span>
            <span>Modelo: Corolla</span>
            <span>OEM: OEM-DETAIL-1</span>
            <span>Procedencia: CHINA</span>
            <span>Stock Cr\u00edtico</span>
            <strong class="precio">$9.221 +IVA</strong>
          </article>
        </main>
        <footer>Texto global del menu que no pertenece a la ficha</footer>
      </body>
    </html>
  `, 'https://www.yokomitsuparts.com.uy/v2/producto-detalle/demo/1/cremallera');

  assert.ok(product);
  assert.equal(product.productName, 'Cremallera direccion Toyota Corolla');
  assert.equal(product.sku, 'YK-DETAIL-1');
  assert.equal(product.brand, 'DemoBrand');
  assert.equal(product.price, '9221');
  assert.equal(product.currency, 'UYU');
  assert.equal(product.availability, 'Stock Cr\u00edtico');
  assert.equal(product.description, 'Cremallera hidraulica nueva para aplicacion sanitizada.');
  assert.equal(product.description?.includes('function('), false);
  assert.equal(product.description?.includes('$.ajax'), false);
  assert.equal(product.description?.includes('<script'), false);
  assert.equal(product.description?.includes('Texto global del menu'), false);
  assert.equal(product.imageUrl, 'https://www.yokomitsuparts.com.uy/v2/upload/productsGalleries/img/yok-detail-1.jpg');
  assert.deepEqual(product.imageUrls, [
    'https://www.yokomitsuparts.com.uy/v2/upload/productsGalleries/img/yok-detail-1.jpg',
    'https://www.yokomitsuparts.com.uy/v2/upload/productsGalleries/img/yok-detail-1-alt.webp',
  ]);
  assert.equal(product.category, undefined);
  assert.deepEqual(product.compatibleBrands, ['DemoBrand']);
  assert.deepEqual(product.compatibleModels, ['Corolla']);
});

test('Yokomitsu detalle descarta descripcion contaminada y assets de interfaz', () => {
  const product = extractYokomitsuProductDetailFromHtml(`
    <article class="producto-detalle" data-codprod="YK-DETAIL-EMPTY">
      <h1>Pieza sin descripcion real</h1>
      <img src="/images/logo.png">
      <img src="/images/icon-fono.svg">
      <img src="/v2/images/contenido-no-disponible.jpg">
      <div class="descripcion">function init(){ $.ajax('/x'); } Menu global Catalogo Contacto</div>
      <span>C\u00f3d. Yokomitsu: YK-DETAIL-EMPTY</span>
      <strong class="precio">$3.406 +IVA</strong>
    </article>
  `, 'https://www.yokomitsuparts.com.uy/v2/producto-detalle/demo/2/pieza');

  assert.ok(product);
  assert.equal(product.description, undefined);
  assert.equal(product.imageUrl, undefined);
  assert.equal(product.imageUrls, undefined);
  assert.equal(product.sku, 'YK-DETAIL-EMPTY');
  assert.equal(product.price, '3406');
});

test('Yokomitsu ficha con varias productsGalleries usa solo galeria real y conserva orden', () => {
  const product = extractYokomitsuProductDetailFromHtml(`
    <html>
      <head>
        <meta property="og:image" content="/v2/upload/productsGalleries/img/CRKI111201_2.jpg">
        <meta property="og:image" content="/v2/images/logotipo-empresa.png">
      </head>
      <body>
        <img src="/v2/images/logo.png">
        <article class="producto-detalle" data-codprod="YK-IMG-1">
          <h1>PARAGOLPE DELANTERO</h1>
          <div class="tags">
            <span>PARAGOLPE DELANTERO C/REJILLA S/ AGJ SOLUTO '2021-</span>
            <span>PARAGOLPE DELANTERO</span>
          </div>
          <picture class="product-gallery">
            <source srcset="/v2/upload/productsGalleries/img/CRKI111201.jpg 400w, /v2/upload/productsGalleries/img/CRKI111201_1.jpg 1200w">
            <img
              src="/v2/images/placeholder.png"
              data-srcset="/v2/upload/productsGalleries/img/CRKI111201_2.jpg 1x, /v2/upload/productsGalleries/img/CRKI111201_2.jpg 2x"
              data-zoom-image="/v2/upload/productsGalleries/img/CRKI111201_1.jpg">
          </picture>
          <span>C\u00f3d. Yokomitsu: YK-IMG-1</span>
          <span>Marca KIA Modelo SOLUTO</span>
          <strong class="precio">$3.406 +IVA</strong>
        </article>
      </body>
    </html>
  `, 'https://www.yokomitsuparts.com.uy/v2/producto-detalle/kia/soluto/3/paragolpe-delantero');

  assert.ok(product);
  assert.equal(product.productName, 'PARAGOLPE DELANTERO C/REJILLA S/ AGJ SOLUTO 2021-');
  assert.equal(product.imageUrl, 'https://www.yokomitsuparts.com.uy/v2/upload/productsGalleries/img/CRKI111201.jpg');
  assert.deepEqual(product.imageUrls, [
    'https://www.yokomitsuparts.com.uy/v2/upload/productsGalleries/img/CRKI111201.jpg',
    'https://www.yokomitsuparts.com.uy/v2/upload/productsGalleries/img/CRKI111201_1.jpg',
    'https://www.yokomitsuparts.com.uy/v2/upload/productsGalleries/img/CRKI111201_2.jpg',
  ]);
  assert.equal(product.imageUrls?.some((url) => /logo|placeholder|logotipo/i.test(url)), false);
});

test('Yokomitsu ficha sin foto real no guarda contenido-no-disponible como imagen', () => {
  const product = extractYokomitsuProductDetailFromHtml(`
    <html>
      <head>
        <meta property="og:image" content="/v2/images/contenido-no-disponible.jpg">
      </head>
      <body>
        <article class="producto-detalle" data-codprod="YK-NO-IMG-1">
          <h1>FRENTE RIO 2012-2016</h1>
          <div class="contenido">CONTENIDO NO DISPONIBLE</div>
          <img src="/v2/images/contenido-no-disponible.jpg">
          <img src="/v2/images/icon-fono.svg">
          <img src="/v2/images/logo-yokomitsu.png">
          <div style="background-image: url('/v2/images/fondo-home.jpg')"></div>
          <script>grecaptcha.execute('LOGIN')</script>
          <span>C\u00f3d. Yokomitsu: YK-NO-IMG-1</span>
          <strong class="precio">$1.234 +IVA</strong>
        </article>
      </body>
    </html>
  `, 'https://www.yokomitsuparts.com.uy/v2/producto-detalle/kia/rio/4/frente-rio');

  assert.ok(product);
  assert.equal(product.productName, 'FRENTE RIO 2012-2016');
  assert.equal(product.imageUrl, undefined);
  assert.equal(product.imageUrls, undefined);
});

test('Yokomitsu detalle no acepta imagenes genericas fuera de productsGalleries', () => {
  const product = extractYokomitsuProductDetailFromHtml(`
    <html>
      <body>
        <article class="producto-detalle" data-codprod="YK-BG-1">
          <h1>Producto con imagenes diferidas</h1>
          <div class="galeria">
            <a href="/v2/producto-detalle/demo/7/no-es-imagen">Ficha</a>
            <div class="slide" data-background-image="/v2/upload/productos/img/soluto-frente.jpg"></div>
            <div class="thumb" style="background-image: url('/v2/upload/productsGalleries/img/soluto-lateral.webp')"></div>
            <img data-image="/v2/ajax/product-image.php?id=123">
            <img src="/images/icon-fono.svg">
            <img src="/v2/images/loading.gif">
          </div>
          <span>C\u00f3d. Yokomitsu: YK-BG-1</span>
          <strong class="precio">$3.406 +IVA</strong>
        </article>
      </body>
    </html>
  `, 'https://www.yokomitsuparts.com.uy/v2/producto-detalle/demo/7/imagenes-diferidas');

  assert.ok(product);
  assert.equal(product.imageUrl, 'https://www.yokomitsuparts.com.uy/v2/upload/productsGalleries/img/soluto-lateral.webp');
  assert.deepEqual(product.imageUrls, [
    'https://www.yokomitsuparts.com.uy/v2/upload/productsGalleries/img/soluto-lateral.webp',
  ]);
  assert.equal(product.imageUrls?.some((url) => /icon|loading|producto-detalle/i.test(url)), false);
});

test('Yokomitsu selecciona titulo especifico relacionado y no el H1 generico', () => {
  const product = extractYokomitsuProductDetailFromHtml(`
    <html>
      <head><title>PARAGOLPE DELANTERO - YOKOMITSU</title></head>
      <body>
        <article class="producto-detalle" data-codprod="YK-TITLE-1">
          <h1>PARAGOLPE DELANTERO</h1>
          <section class="informacion-producto">
            <h2>PARAGOLPE DELANTERO C/REJILLA S/ AGJ SOLUTO '2021-</h2>
          </section>
          <div class="tags">
            <span>PARAGOLPE DELANTERO C/REJILLA S/ AGJ SOLUTO '2021-</span>
            <span>PARAGOLPE DELANTERO</span>
          </div>
          <span>C\u00f3d. Yokomitsu: YK-TITLE-1</span>
          <span>Marca KIA Modelo SOLUTO</span>
          <strong class="precio">$9.221 +IVA</strong>
        </article>
      </body>
    </html>
  `, 'https://www.yokomitsuparts.com.uy/v2/producto-detalle/kia/soluto/9/paragolpe');

  assert.ok(product);
  assert.equal(product.productName, 'PARAGOLPE DELANTERO C/REJILLA S/ AGJ SOLUTO 2021-');
  assert.equal(product.brand, 'KIA');
  assert.deepEqual(product.compatibleBrands, ['KIA']);
  assert.deepEqual(product.compatibleModels, ['SOLUTO']);
});

test('Yokomitsu prefiere BASTIDOR DERECHO C/ROTULA RIO 2018- sobre BASTIDOR', () => {
  const product = extractYokomitsuProductDetailFromHtml(`
    <article class="producto-detalle" data-codprod="YK-TITLE-2">
      <h1>BASTIDOR</h1>
      <ul class="tags">
        <li>BASTIDOR</li>
        <li>BASTIDOR DERECHO C/ROTULA RIO 2018-</li>
      </ul>
      <span>C\u00f3d. Yokomitsu: YK-TITLE-2</span>
      <span>Marca KIA Modelo RIO</span>
      <strong class="precio">$3.406 +IVA</strong>
    </article>
  `, 'https://www.yokomitsuparts.com.uy/v2/producto-detalle/kia/rio/10/bastidor');

  assert.ok(product);
  assert.equal(product.productName, 'BASTIDOR DERECHO C/ROTULA RIO 2018-');
});

test('Yokomitsu extrae Marca y Modelo visibles sin dos puntos como compatibilidad', () => {
  const products = extractYokomitsuProductsFromJson({
    data: `
      <article class="producto" data-codprod="YK-SOLUTO">
        <a href="/v2/producto-detalle/kia/soluto/88/pieza-soluto"><h3>Pieza para Soluto</h3></a>
        <span>C\u00f3d. Yokomitsu YK-SOLUTO</span>
        <span>Marca KIA Modelo SOLUTO</span>
        <span>Procedencia CHINA</span>
        <strong class="precio">$9.221 +IVA</strong>
      </article>
    `,
  });

  assert.equal(products.length, 1);
  assert.equal(products[0].sku, 'YK-SOLUTO');
  assert.equal(products[0].brand, 'KIA');
  assert.equal(products[0].attributes?.vehicleBrand, 'KIA');
  assert.equal(products[0].attributes?.vehicleModel, 'SOLUTO');
  assert.deepEqual(products[0].compatibleBrands, ['KIA']);
  assert.deepEqual(products[0].compatibleModels, ['SOLUTO']);
  assert.equal(products[0].attributes?.procedencia, 'CHINA');
});

test('Yokomitsu mantiene campos con dos puntos y publica compatibilidad vehicular', () => {
  const products = extractYokomitsuProductsFromJson({
    data: `
      <article class="producto" data-codprod="YK-COMPAT-1">
        <a href="/v2/producto-detalle/kia/rio/89/pieza-rio"><h3>Pieza para Rio</h3></a>
        <span>C\u00f3d. Yokomitsu: YK-COMPAT-1</span>
        <span>Marca: KIA</span>
        <span>Modelo: RIO</span>
        <strong class="precio">$3.406 +IVA</strong>
      </article>
    `,
  });

  assert.equal(products[0].brand, 'KIA');
  assert.deepEqual(products[0].compatibleBrands, ['KIA']);
  assert.deepEqual(products[0].compatibleModels, ['RIO']);
});

test('Yokomitsu limpia vehicleBrand contaminado con titulo largo de repuesto', () => {
  const cases = [
    ['PEUGEOT PARAGOLPE DELANTERO S/SENSOR 2008 2021-', '2008', 'PEUGEOT'],
    ['CHEVROLET LLAVE BAJO VOLANTE SEÑALERO Y LUCES CORSA', 'CORSA', 'CHEVROLET'],
    ['NISSAN CABLES PALANCA CAMBIO TIIDA 1.6', 'TIIDA 1.6', 'NISSAN'],
    ['TOYOTA CINTA AIRBAG HILUX REVO', 'HILUX REVO', 'TOYOTA'],
    ['HYUNDAI CINTA AIRBAG ACCENT', 'ACCENT', 'HYUNDAI'],
    ['SUZUKI ESPEJO CELERIO', 'CELERIO', 'SUZUKI'],
  ] as const;

  for (const [brandText, model, expectedBrand] of cases) {
    const product = extractYokomitsuProductDetailFromHtml(`
      <article class="producto-detalle" data-codprod="YK-${expectedBrand}">
        <h1>PIEZA REAL ${model}</h1>
        <span>Cód. Yokomitsu: YK-${expectedBrand}</span>
        <span>Marca: ${brandText}</span>
        <span>Modelo: ${model}</span>
        <strong class="precio">$1.234 +IVA</strong>
      </article>
    `, `https://www.yokomitsuparts.com.uy/v2/producto-detalle/${model.toLowerCase().replace(/\s+/g, '-')}/1/pieza-real`);

    assert.ok(product);
    assert.equal(product.brand, expectedBrand);
    assert.equal(product.attributes?.vehicleBrand, expectedBrand);
    assert.equal(product.attributes?.vehicleModel, model);
    assert.deepEqual(product.compatibleBrands, [expectedBrand]);
    assert.deepEqual(product.compatibleModels, [model]);
  }
});

test('Yokomitsu descarta #N/A y deriva nombre desde slug si la ficha viene contaminada', () => {
  const product = extractYokomitsuProductDetailFromHtml(`
    <article class="producto-detalle" data-codprod="YK-NA">
      <h1>#N/A (Did not find value '6115522201' in VLOOKUP evaluation.)</h1>
      <span>Cód. Yokomitsu: YK-NA</span>
      <span>Marca: #N/A ESPEJO EXTERIOR DERECHO</span>
      <span>Modelo: #N/A</span>
      <strong class="precio">$1.700 +IVA</strong>
    </article>
  `, 'https://www.yokomitsuparts.com.uy/v2/producto-detalle/celerio/123/espejo-exterior-derecho-celerio-2016-');

  assert.ok(product);
  assert.equal(product.productName, 'ESPEJO EXTERIOR DERECHO CELERIO 2016-');
  assert.equal(product.brand, undefined);
  assert.equal(product.attributes?.vehicleBrand, undefined);
  assert.equal(product.attributes?.vehicleModel, undefined);
  assert.equal(product.compatibleBrands?.length ?? 0, 0);
  assert.equal(product.compatibleModels?.length ?? 0, 0);
});

test('Yokomitsu no usa textos de accion como productName desde registros JSON', () => {
  const products = extractYokomitsuProductsFromJson({
    items: [{
      detalle: 'ver detalle',
      codigo: '3136502934',
      precio: '$9.221 +IVA',
      url: '/v2/producto-detalle/rio/47930/paragolpe-delantero-hatchback-rio-2012-2014',
    }],
  });

  assert.equal(products.length, 1);
  assert.equal(products[0].productName, 'PARAGOLPE DELANTERO HATCHBACK RIO 2012-2014');
  assert.equal(products[0].sku, '3136502934');
  assert.equal(products[0].sourceUrl, 'https://www.yokomitsuparts.com.uy/v2/producto-detalle/rio/47930/paragolpe-delantero-hatchback-rio-2012-2014');
});

test('Yokomitsu deriva nombre desde slug si la card solo expone Ver detalle', () => {
  const products = extractYokomitsuProductsFromJson({
    data: `
      <article class="producto">
        <a href="/v2/producto-detalle/picanto/43606/puntero-izquierdo-ctr-picanto-2012-">Ver detalle</a>
        <span>OEM: 56820-1Y500</span>
      </article>
    `,
  });

  assert.equal(products.length, 1);
  assert.equal(products[0].productName, 'PUNTERO IZQUIERDO CTR PICANTO 2012-');
  assert.equal(products[0].sourceUrl, 'https://www.yokomitsuparts.com.uy/v2/producto-detalle/picanto/43606/puntero-izquierdo-ctr-picanto-2012-');
});

test('Yokomitsu ignora categorias invalidas de formula sin borrar categorias legitimas', () => {
  const products = extractYokomitsuProductsFromJson({
    data: `
      <article class="producto" data-codprod="YK-CAT-1">
        <a href="/v2/producto-detalle/demo/5/categoria-invalida"><h3>Producto categoria invalida</h3></a>
        <span>C\u00f3d. Yokomitsu: YK-CAT-1</span>
        <span>Categor\u00eda: #N/A (Did not find value '6115522201' in VLOOKUP evaluation.)</span>
        <strong class="precio">$1.234 +IVA</strong>
      </article>
      <article class="producto" data-codprod="YK-CAT-2">
        <a href="/v2/producto-detalle/demo/6/categoria-valida"><h3>Producto categoria valida</h3></a>
        <span>C\u00f3d. Yokomitsu: YK-CAT-2</span>
        <span>Categor\u00eda: Direcci\u00f3n / Cremalleras</span>
        <strong class="precio">$1.234 +IVA</strong>
      </article>
    `,
  });

  assert.equal(products[0].category, undefined);
  assert.equal(products[1].category, 'Direcci\u00f3n / Cremalleras');
});

test('Yokomitsu corta campos etiquetados antes de otra etiqueta o estado', () => {
  const products = extractYokomitsuProductsFromJson(JSON.parse(readYokomitsuFixture('label-edge-cases.json')));

  assert.equal(products.length, 5);

  const withOem = products.find((product) => product.sku === 'YK-OEM-1');
  assert.equal(withOem?.attributes?.referencia, 'OEM-123');
  assert.equal(withOem?.attributes?.procedencia, 'CHINA');

  const emptyOem = products.find((product) => product.sku === 'YK-OEM-2');
  assert.equal(emptyOem?.attributes?.referencia, undefined);
  assert.equal(emptyOem?.attributes?.procedencia, 'CHINA');

  const critical = products.find((product) => product.sku === 'YK-STOCK-1');
  assert.equal(critical?.attributes?.procedencia, 'CHINA');
  assert.equal(critical?.availability, 'Stock Cr\u00edtico');
  assert.equal(critical?.attributes?.stockStatus, 'Stock Cr\u00edtico');
  assert.equal(critical?.stock, undefined);

  const procedenciaOnly = products.find((product) => product.sku === 'YK-PROC-1');
  assert.equal(procedenciaOnly?.attributes?.procedencia, 'BRASIL');
  assert.equal(procedenciaOnly?.availability, undefined);

  const emptyArrival = products.find((product) => product.sku === 'YK-ARR-1');
  assert.equal(emptyArrival?.attributes?.proximaLlegada, undefined);
  assert.equal(emptyArrival?.attributes?.procedencia, 'JAP\u00d3N');
});

test('Yokomitsu conserva completa proxima llegada antes de estado o etiqueta', () => {
  const data = `
    <article class="producto" data-codprod="YK-ARR-20-DIAS">
      <a href="/v2/producto-detalle/demo/arr-20-dias/llegada-stock"><h3>Pieza llegada stock</h3></a>
      <span>C\u00f3d. Yokomitsu: YK-ARR-20-DIAS</span>
      <span>Pr\u00f3xima llegada: 20 dias</span>
      <span>Stock Cr\u00edtico</span>
      <strong class="precio">$1.234 +IVA</strong>
    </article>
    <article class="producto" data-codprod="YK-ARR-20-DIAS-ACCENT">
      <a href="/v2/producto-detalle/demo/arr-20-dias-accent/llegada-stock"><h3>Pieza llegada con acento</h3></a>
      <span>C\u00f3d. Yokomitsu: YK-ARR-20-DIAS-ACCENT</span>
      <span>Pr\u00f3xima llegada: 20 d\u00edas</span>
      <span>Stock Cr\u00edtico</span>
      <strong class="precio">$1.234 +IVA</strong>
    </article>
    <article class="producto" data-codprod="YK-ARR-LABEL">
      <a href="/v2/producto-detalle/demo/arr-label/llegada-label"><h3>Pieza llegada etiqueta</h3></a>
      <span>C\u00f3d. Yokomitsu: YK-ARR-LABEL</span>
      <span>Pr\u00f3xima llegada: 45 dias</span>
      <span>Procedencia: CHINA</span>
      <strong class="precio">$1.234 +IVA</strong>
    </article>
    <article class="producto" data-codprod="YK-ARR-EMPTY">
      <a href="/v2/producto-detalle/demo/arr-empty/llegada-vacia"><h3>Pieza llegada vacia</h3></a>
      <span>C\u00f3d. Yokomitsu: YK-ARR-EMPTY</span>
      <span>Pr\u00f3xima llegada:</span>
      <span>Procedencia: BRASIL</span>
      <strong class="precio">$1.234 +IVA</strong>
    </article>
  `;
  const products = extractYokomitsuProductsFromJson({ number_register: 4, data });

  const beforeStatus = products.find((product) => product.sku === 'YK-ARR-20-DIAS');
  assert.equal(beforeStatus?.attributes?.proximaLlegada, '20 dias');
  assert.equal(beforeStatus?.availability, 'Stock Cr\u00edtico');
  assert.equal(beforeStatus?.attributes?.stockStatus, 'Stock Cr\u00edtico');

  const accented = products.find((product) => product.sku === 'YK-ARR-20-DIAS-ACCENT');
  assert.equal(accented?.attributes?.proximaLlegada, '20 d\u00edas');
  assert.equal(accented?.availability, 'Stock Cr\u00edtico');

  const beforeLabel = products.find((product) => product.sku === 'YK-ARR-LABEL');
  assert.equal(beforeLabel?.attributes?.proximaLlegada, '45 dias');
  assert.equal(beforeLabel?.attributes?.procedencia, 'CHINA');

  const empty = products.find((product) => product.sku === 'YK-ARR-EMPTY');
  assert.equal(empty?.attributes?.proximaLlegada, undefined);
  assert.equal(empty?.attributes?.procedencia, 'BRASIL');
});

test('Yokomitsu no elimina el ultimo caracter valido antes del boundary', () => {
  const data = `
    <article class="producto" data-codprod="YK-LAST-CHAR">
      <a href="/v2/producto-detalle/demo/last-char/llegada"><h3>Pieza ultimo caracter</h3></a>
      <span>C\u00f3d. Yokomitsu: YK-LAST-CHAR</span>
      <span>Pr\u00f3xima llegada: ABC123s</span>
      <span>Stock Cr\u00edtico</span>
      <strong class="precio">$1.234 +IVA</strong>
    </article>
  `;
  const products = extractYokomitsuProductsFromJson({ number_register: 1, data });

  assert.equal(products[0].attributes?.proximaLlegada, 'ABC123s');
  assert.equal(products[0].availability, 'Stock Cr\u00edtico');
});

test('Yokomitsu separa estados negativos de disponibilidad sin capturarlos como labels', () => {
  const data = ['Sin stock', 'Agotado', 'No disponible'].map((status, index) => `
    <article class="producto" data-codprod="YK-NEG-${index + 1}">
      <a href="/v2/producto-detalle/demo/neg-${index + 1}/estado-${index + 1}"><h3>Pieza ${status}</h3></a>
      <span>C\u00f3d. Yokomitsu: YK-NEG-${index + 1}</span>
      <span>Marca: DemoBrand</span>
      <span>Modelo: Demo ${index + 1}</span>
      <span>OEM:</span>
      <span>Procedencia: CHINA</span>
      <span>${status}</span>
      <strong class="precio">$1.234 +IVA</strong>
    </article>
  `).join('');
  const products = extractYokomitsuProductsFromJson({ number_register: 3, data });

  assert.equal(products.length, 3);
  for (const product of products) {
    assert.equal(product.attributes?.referencia, undefined);
    assert.equal(product.attributes?.procedencia, 'CHINA');
    assert.equal(product.availability, 'out_of_stock');
    assert.equal(product.attributes?.stockStatus, 'out_of_stock');
  }
});

test('Yokomitsu no usa etiquetas conocidas como valores de otros campos', () => {
  const products = extractYokomitsuProductsFromJson({
    data: `
      <article class="producto" data-codprod="YK-LABEL-1">
        <a href="/v2/producto-detalle/demo/label/contaminacion"><h3>Pieza etiquetas</h3></a>
        <span>C\u00f3d. Yokomitsu: YK-LABEL-1</span>
        <span>Marca:</span>
        <span>Modelo: Demo Label</span>
        <span>OEM:</span>
        <span>Procedencia:</span>
        <span>Stock Cr\u00edtico</span>
        <strong class="precio">$1.234 +IVA</strong>
      </article>
    `,
  });

  assert.equal(products.length, 1);
  assert.equal(products[0].brand, undefined);
  assert.equal(products[0].attributes?.referencia, undefined);
  assert.equal(products[0].attributes?.procedencia, undefined);
  assert.equal(products[0].availability, 'Stock Cr\u00edtico');
});

test('Yokomitsu resume shape, campos y paginacion sin guardar datos privados', () => {
  const shape = summarizeJsonShape({
    recordsTotal: 45,
    rows: [{ codigo: 'YK-001', nombre: 'Filtro', precio: '1.234' }],
  });
  const pagination = inferPaginationFromCalls([{
    method: 'GET',
    url: 'https://www.yokomitsuparts.com.uy/v2/api/catalogo?page=2&limit=20',
    responseShape: shape,
  }]);
  const fields = inferYokomitsuFieldsAvailable(extractYokomitsuProductsFromJson({
    rows: [{ codigo: 'YK-001', nombre: 'Filtro', precio: '1.234', stock: 0 }],
  }));

  assert.deepEqual(pagination.observedParams, ['limit', 'page']);
  assert.ok(pagination.observedFields.includes('recordsTotal'));
  assert.equal(fields.productName, true);
  assert.equal(fields.price, true);
  assert.equal(fields.stock, true);
  assert.equal(isLikelyYokomitsuCatalogUrl('https://www.yokomitsuparts.com.uy/v2/api/catalogo?page=1'), true);
  assert.equal(isLikelyYokomitsuCatalogUrl('https://example.com/v2/api/catalogo?page=1'), false);
});

test('Yokomitsu distingue CAPTCHA visible de scripts no visibles', () => {
  assert.equal(hasVisibleYokomitsuCaptchaChallenge([{
    tagName: 'iframe',
    title: 'reCAPTCHA',
    src: 'https://www.google.com/recaptcha/api2/anchor',
    visible: true,
  }]), true);

  assert.equal(hasVisibleYokomitsuCaptchaChallenge([{
    tagName: 'script',
    src: 'https://www.google.com/recaptcha/api.js',
    visible: false,
  }, {
    tagName: 'iframe',
    title: 'reCAPTCHA',
    src: 'https://www.google.com/recaptcha/api2/anchor',
    visible: false,
  }]), false);
});

test('Yokomitsu detecta ingreso manual exitoso sin leer credenciales', () => {
  assert.equal(hasReachedYokomitsuPortal({
    currentUrl: 'https://www.yokomitsuparts.com.uy/v2/catalogo',
    hasPasswordInput: false,
    portalElementCount: 1,
    authenticatedCatalogResponses: 0,
  }), true);

  assert.equal(hasReachedYokomitsuPortal({
    currentUrl: 'https://www.yokomitsuparts.com.uy/v2/login',
    hasPasswordInput: true,
    portalElementCount: 0,
    authenticatedCatalogResponses: 0,
  }), false);
});

test('Yokomitsu usa /v2/home canonico como entrada principal', () => {
  assert.equal(YOKOMITSU_LOGIN_URL, 'https://www.yokomitsuparts.com.uy/v2/home');
  assert.equal(YOKOMITSU_LEGACY_LOGIN_URL, 'https://yokomitsuparts.com.uy/v2/login');
  assert.notEqual(YOKOMITSU_LOGIN_URL, YOKOMITSU_LEGACY_LOGIN_URL);
});

test('Yokomitsu no asume autenticacion por estar en /v2/home si hay password', () => {
  assert.equal(hasReachedYokomitsuPortal({
    currentUrl: 'https://www.yokomitsuparts.com.uy/v2/home',
    hasPasswordInput: true,
    portalElementCount: 4,
    authenticatedCatalogResponses: 1,
    hasYokomitsuFrontCookie: true,
  }), false);
});

test('Yokomitsu acepta /v2/home autenticado por senales de portal o cookie', () => {
  assert.equal(hasReachedYokomitsuPortal({
    currentUrl: 'https://www.yokomitsuparts.com.uy/v2/home',
    hasPasswordInput: false,
    portalElementCount: 1,
    authenticatedCatalogResponses: 0,
  }), true);

  assert.equal(hasReachedYokomitsuPortal({
    currentUrl: 'https://www.yokomitsuparts.com.uy/v2/home',
    hasPasswordInput: false,
    portalElementCount: 0,
    authenticatedCatalogResponses: 0,
    hasYokomitsuFrontCookie: true,
  }), true);
});

test('Yokomitsu detecta timeout esperando login manual', () => {
  assert.equal(hasYokomitsuManualLoginTimedOut(1_000, 300_999, 300_000), false);
  assert.equal(hasYokomitsuManualLoginTimedOut(1_000, 301_000, 300_000), true);
});

test('Yokomitsu limita la muestra a cinco productos', () => {
  const products = extractYokomitsuProductsFromJson({
    data: Array.from({ length: 8 }, (_, index) => ({
      codigo: `YK-${index + 1}`,
      nombre: `Filtro ${index + 1}`,
      precio: '1.234',
    })),
  });

  assert.equal(products.length, 5);
  assert.equal(products[0].sku, 'YK-1');
  assert.equal(products[4].sku, 'YK-5');
});

test('Yokomitsu limita a cinco productos desde data HTML', () => {
  const data = Array.from({ length: 7 }, (_, index) => `
    <article class="producto" data-codprod="YK-${index + 1}">
      <a href="/v2/producto-detalle/demo/${index + 1}/pieza-${index + 1}"><h3>Pieza ${index + 1}</h3></a>
      <span>C\u00f3d. Yokomitsu: YK-${index + 1}</span>
      <strong class="precio">$1.234 +IVA</strong>
    </article>
  `).join('');
  const products = extractYokomitsuProductsFromJson({ number_register: 7, data });

  assert.equal(products.length, 5);
  assert.equal(products[0].sku, 'YK-1');
  assert.equal(products[4].sku, 'YK-5');
});

test('Yokomitsu cierra el contexto incluso si clearCookies falla', async () => {
  const calls: string[] = [];
  await assert.rejects(() => closeYokomitsuSessionResources({
    context: {
      clearCookies: async () => {
        calls.push('clearCookies');
        throw new Error('clear failed');
      },
      close: async () => {
        calls.push('context.close');
      },
    },
    browser: {
      close: async () => {
        calls.push('browser.close');
      },
    },
  }), /clear failed/);

  assert.deepEqual(calls, ['clearCookies', 'context.close', 'browser.close']);
});

function readYokomitsuFixture(name: string): string {
  return readFileSync(join(process.cwd(), 'src', 'scraping', 'domain', 'fixtures', 'yokomitsu', name), 'utf8');
}

function readYokomitsuLoginFixture(): Record<string, string> {
  return JSON.parse(readYokomitsuFixture('login-flow.json')) as Record<string, string>;
}

function response(
  url: string,
  body: string,
  headers: Record<string, string | string[] | undefined> = {},
  status = 200,
): YokomitsuHttpResponse {
  return { url, status, headers, body };
}

function createFakeYokomitsuClient(
  calls: Array<{ method: string; url: string; body?: string }>,
  responses: YokomitsuHttpResponse[],
): YokomitsuHttpClient {
  return {
    get: async (url) => {
      calls.push({ method: 'GET', url });
      const next = responses.shift();
      if (!next) throw new Error(`missing fake response for GET ${url}`);
      return next;
    },
    post: async (url, body) => {
      calls.push({ method: 'POST', url, body });
      const next = responses.shift();
      if (!next) throw new Error(`missing fake response for POST ${url}`);
      return next;
    },
    clearSession: async () => {
      calls.push({ method: 'CLEAR', url: 'session' });
    },
  };
}

async function clientWithSessionCleanup(
  client: YokomitsuHttpClient,
  callback: () => Promise<void>,
): Promise<void> {
  await withYokomitsuHttpSession(client, {
    username: 'SANITIZED_RUT',
    password: 'SANITIZED_PASSWORD',
  }, callback);
}
