import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { InventoryStoreService } from './inventory-store.service';
import type { ProductRecord } from '../interfaces/scraping.types';

test('getStats agrupa por host base y no por url completa', async () => {
  const queries: string[] = [];

  const service = new InventoryStoreService({
    async query(sql: string) {
      queries.push(sql);

      if (/SELECT COUNT\(\*\)::text AS total FROM scraping_inventory$/i.test(sql.trim())) {
        return { rows: [{ total: '5' }] } as never;
      }

      return {
        rows: [
          { site: 'www.chaparei.com', total: '3' },
          { site: 'www.selvir.com.uy', total: '2' },
        ],
      } as never;
    },
  } as never);

  const stats = await service.getStats();

  assert.equal(stats.total, 5);
  assert.deepEqual(stats.bySite, [
    { site: 'www.chaparei.com', siteLabel: 'Chaparei', total: 3 },
    { site: 'www.selvir.com.uy', siteLabel: 'Selvir', total: 2 },
  ]);
  assert.ok(queries.some((sql) => sql.includes('split_part')));
  assert.ok(queries.some((sql) => sql.includes("replace(replace(lower(site), 'https://', ''), 'http://', '')")));
});

test('getFilteredPage limita el resultado a 200 y aplica offset', async () => {
  let capturedSql = '';
  let capturedParams: unknown[] = [];

  const service = new InventoryStoreService({
    async query(sql: string, params?: unknown[]) {
      capturedSql = sql;
      capturedParams = params ?? [];
      return { rows: [] } as never;
    },
  } as never);

  await service.getFilteredPage({}, { limit: 500, offset: 15 });

  assert.ok(capturedSql.includes('LIMIT $1'));
  assert.ok(capturedSql.includes('OFFSET $2'));
  assert.deepEqual(capturedParams, [200, 15]);
});

test('getFilteredPage congela membresia y orden con snapshotBefore', async () => {
  let capturedSql = '';
  let capturedParams: unknown[] = [];

  const service = new InventoryStoreService({
    async query(sql: string, params?: unknown[]) {
      capturedSql = sql;
      capturedParams = params ?? [];
      return { rows: [] } as never;
    },
  } as never);

  await service.getFilteredPage(
    { site: 'Selvir', snapshotBefore: '2026-10-09T17:00:00.000Z' },
    { limit: 200, offset: 400 },
  );

  assert.ok(capturedSql.includes('created_at <= $2::timestamptz'));
  assert.ok(capturedSql.includes('ORDER BY created_at DESC, id ASC'));
  assert.ok(capturedSql.includes('LIMIT $3'));
  assert.ok(capturedSql.includes('OFFSET $4'));
  assert.deepEqual(capturedParams, [
    ['selvir.com.uy'],
    '2026-10-09T17:00:00.000Z',
    200,
    400,
  ]);
});

test('getFilteredPage usa id como desempate aun sin snapshot', async () => {
  let capturedSql = '';

  const service = new InventoryStoreService({
    async query(sql: string) {
      capturedSql = sql;
      return { rows: [] } as never;
    },
  } as never);

  await service.getFilteredPage({}, { limit: 20 });

  assert.ok(capturedSql.includes('ORDER BY updated_at DESC, id ASC'));
});

test('getFilteredPage busca sobre el texto materializado', async () => {
  let capturedSql = '';
  const service = new InventoryStoreService({
    async query(sql: string) {
      capturedSql = sql;
      return { rows: [] } as never;
    },
  } as never);

  await service.getFilteredPage({ search: 'Volkswagen Gol' }, { limit: 20 });

  assert.ok(capturedSql.includes('search_text LIKE'));
  assert.ok(!capturedSql.includes('regexp_replace('));
});

test('getFilteredPage devuelve el precio como numero normalizado', async () => {
  const service = new InventoryStoreService({
    async query() {
      return {
        rows: [{
          id: 'url|https://familcar.com/producto/1017',
          site: 'https://www.familcar.com/',
          product: {
            productName: 'ENGRANAJE',
            price: '1.290',
            currency: 'UYU',
            sourceUrl: 'https://www.familcar.com/producto/1017',
            extractedAt: new Date().toISOString(),
            provider: 'domain',
          },
          created_at: '2026-08-10T00:00:00.000Z',
          updated_at: '2026-08-10T00:00:00.000Z',
          last_seen_at: '2026-08-10T00:00:00.000Z',
        }],
      } as never;
    },
  } as never);

  const products = await service.getFilteredPage({}, { limit: 1 });

  assert.equal(products[0]?.price, 1290);
  assert.equal(typeof products[0]?.price, 'number');
});

test('getFilteredPage ordena usando la misma normalizacion de precios', async () => {
  let capturedSql = '';
  const service = new InventoryStoreService({
    async query(sql: string) {
      capturedSql = sql;
      return { rows: [] } as never;
    },
  } as never);

  await service.getFilteredPage({ priceOrder: 'asc' }, { limit: 20 });

  assert.ok(capturedSql.includes('AS price_sort'));
  assert.ok(capturedSql.includes("REPLACE(REPLACE(BTRIM(product->>'price'), '.', ''), ',', '.')"));
  assert.ok(capturedSql.includes('price_sort ASC NULLS LAST'));
});

test('getFilteredPage normaliza el filtro por sitio sin depender de www', async () => {
  let capturedSql = '';
  let capturedParams: unknown[] = [];

  const service = new InventoryStoreService({
    async query(sql: string, params?: unknown[]) {
      capturedSql = sql;
      capturedParams = params ?? [];
      return { rows: [] } as never;
    },
  } as never);

  await service.getFilteredPage({ site: 'selvir.com.uy' }, {});

  assert.ok(capturedSql.includes('ANY($1::text[])'));
  assert.deepEqual(capturedParams, [['selvir.com.uy']]);
});

test('getFilteredPage acepta nombre visible de la casa como filtro', async () => {
  let capturedParams: unknown[] = [];

  const service = new InventoryStoreService({
    async query(_sql: string, params?: unknown[]) {
      capturedParams = params ?? [];
      return { rows: [] } as never;
    },
  } as never);

  await service.getFilteredPage({ site: 'Selvir' }, {});

  assert.deepEqual(capturedParams, [['selvir.com.uy']]);
});

test('getFilteredPage filtra por marca vehicular con tabla relacional', async () => {
  let capturedSql = '';
  let capturedParams: unknown[] = [];

  const service = new InventoryStoreService({
    async query(sql: string, params?: unknown[]) {
      capturedSql = sql;
      capturedParams = params ?? [];
      return { rows: [] } as never;
    },
  } as never);

  await service.getFilteredPage({ vehicleBrand: 'VW' }, {});

  assert.ok(capturedSql.includes('scraping_inventory_vehicle_brands'));
  assert.ok(capturedSql.includes('vehicle_brand_link.brand_id = $1'));
  assert.deepEqual(capturedParams, ['volkswagen']);
});

test('getVehicleBrandStats recalcula cantidades dentro de la casa seleccionada', async () => {
  let capturedSql = '';
  let capturedParams: unknown[] = [];

  const service = new InventoryStoreService({
    async query(sql: string, params?: unknown[]) {
      capturedSql = sql;
      capturedParams = params ?? [];
      return { rows: [{ id: 'fiat', label: 'Fiat', total: '3' }] } as never;
    },
  } as never);

  const stats = await service.getVehicleBrandStats({ site: 'Selvir' });

  assert.deepEqual(stats, [{ id: 'fiat', label: 'Fiat', total: 3 }]);
  assert.ok(capturedSql.includes('LEFT JOIN scraping_inventory'));
  assert.ok(capturedSql.includes('regexp_replace'));
  assert.deepEqual(capturedParams, [['selvir.com.uy']]);
});

test('upsertSiteProducts persiste compatibleBrands y sincroniza relaciones', async () => {
  const queries: Array<{ sql: string; params: unknown[] }> = [];

  const service = new InventoryStoreService({
    async query(sql: string, params: unknown[] = []) {
      queries.push({ sql, params });

      if (/INSERT INTO scraping_inventory/i.test(sql)) {
        return {
          rows: [{
            id: 'url|https://selvir.com.uy/product/amortiguador-demo',
            sourceUrl: 'https://selvir.com.uy/product/amortiguador-demo',
            created: true,
          }],
        } as never;
      }

      if (/SELECT COUNT\(\*\)::text AS total FROM scraping_inventory WHERE site = \$1/i.test(sql)) {
        return { rows: [{ total: '1' }] } as never;
      }

      return { rows: [] } as never;
    },
  } as never);

  const result = await service.upsertSiteProducts('https://www.selvir.com.uy/suspension/', [
    {
      productName: 'AMORTIGUADOR DEL CITROEN-PEUGEOT',
      price: '1234',
      compatibleModels: ['C3'],
      compatibleVersions: ['1.6 2010-2015'],
      sourceUrl: 'https://www.selvir.com.uy/product/amortiguador-demo/',
      extractedAt: new Date().toISOString(),
      provider: 'domain',
    },
    {
      productName: 'AMORTIGUADOR DEL CITROEN-PEUGEOT ACTUALIZADO',
      price: '1234',
      compatibleModels: ['C3'],
      compatibleVersions: ['1.6 2010-2015'],
      sourceUrl: 'https://selvir.com.uy/product/amortiguador-demo',
      extractedAt: new Date().toISOString(),
      provider: 'domain',
    },
  ], new Date().toISOString());

  assert.deepEqual(result, { created: 1, updated: 0, totalForSite: 1 });

  const inventoryInsert = queries.find((query) => /INSERT INTO scraping_inventory/i.test(query.sql));
  assert.ok(inventoryInsert);
  assert.equal((inventoryInsert.params[2] as string[]).length, 1);
  assert.deepEqual(inventoryInsert.params[3], ['https://selvir.com.uy/product/amortiguador-demo']);
  const productJson = JSON.parse((inventoryInsert.params[4] as string[])[0]) as {
    compatibleBrands?: string[];
    compatibleModels?: string[];
    compatibleVersions?: string[];
  };
  assert.deepEqual(productJson.compatibleBrands, ['Citroen', 'Peugeot']);
  assert.deepEqual(productJson.compatibleModels, ['C3']);
  assert.deepEqual(productJson.compatibleVersions, ['1.6 2010-2015']);
  assert.ok((inventoryInsert.params[5] as string[])[0].includes('amortiguador'));

  const relationDelete = queries.find((query) => /DELETE FROM scraping_inventory_vehicle_brands/i.test(query.sql));
  assert.ok(relationDelete);

  const relationInsert = queries.find((query) => /INSERT INTO scraping_inventory_vehicle_brands/i.test(query.sql));
  assert.ok(relationInsert);
  assert.deepEqual(relationInsert.params[1], ['citroen', 'peugeot']);
});

test('upsertSiteProducts actualiza search_text para encontrar un SKU incorporado sin duplicar', async () => {
  const rows = new Map<string, {
    id: string;
    site: string;
    sourceUrl: string;
    product: ProductRecord;
    searchText: string;
  }>();
  let inventoryUpsertSql = '';

  const service = new InventoryStoreService({
    async query(sql: string, params: unknown[] = []) {
      if (/INSERT INTO scraping_inventory\s*\(/i.test(sql)) {
        inventoryUpsertSql = sql;
        const ids = params[1] as string[];
        const sites = params[2] as string[];
        const sourceUrls = params[3] as string[];
        const products = params[4] as string[];
        const searchTexts = params[5] as string[];

        return {
          rows: sourceUrls.map((sourceUrl, index) => {
            const existing = rows.get(sourceUrl);
            const id = existing?.id ?? ids[index];
            rows.set(sourceUrl, {
              id,
              site: sites[index],
              sourceUrl,
              product: JSON.parse(products[index]) as ProductRecord,
              searchText: /search_text\s*=\s*EXCLUDED\.search_text/i.test(sql)
                ? searchTexts[index]
                : existing?.searchText ?? searchTexts[index],
            });
            return { id, sourceUrl, created: !existing };
          }),
        } as never;
      }

      if (/SELECT COUNT\(\*\)::text AS total FROM scraping_inventory WHERE site = \$1/i.test(sql)) {
        const site = params[0];
        return {
          rows: [{
            total: String(Array.from(rows.values()).filter((row) => row.site === site).length),
          }],
        } as never;
      }

      if (/SELECT id, site, product, created_at, updated_at, last_seen_at\s+FROM scraping_inventory/i.test(sql)) {
        const searchToken = (params.find((param) => typeof param === 'string' && param.includes('168662')) as string | undefined)
          ?.replaceAll('%', '');
        const matches = Array.from(rows.values())
          .filter((row) => !searchToken || row.searchText.includes(searchToken))
          .map((row) => ({
            id: row.id,
            site: row.site,
            product: row.product,
            created_at: '2026-08-06T00:00:00.000Z',
            updated_at: '2026-08-06T00:00:00.000Z',
            last_seen_at: '2026-08-06T00:00:00.000Z',
          }));
        return { rows: matches } as never;
      }

      return { rows: [] } as never;
    },
  } as never);

  const sourceUrl = 'https://www.yaguaron.com.uy/catalogo/juego-4-tazas-rueda-15-8-rayos-agile-montana_168662_168662';
  const extractedAt = '2026-08-06T00:00:00.000Z';

  await service.upsertSiteProducts('https://www.yaguaron.com.uy/', [{
    productName: 'JUEGO 4 TAZAS RUEDA 15 8 RAYOS AGILE MONTANA',
    sourceUrl,
    extractedAt,
    provider: 'domain',
  }], extractedAt);

  const result = await service.upsertSiteProducts('https://www.yaguaron.com.uy/', [{
    productName: 'JUEGO 4 TAZAS RUEDA 15 8 RAYOS AGILE MONTANA',
    sku: '168662',
    sourceUrl,
    extractedAt,
    provider: 'domain',
  }], extractedAt);

  const found = await service.getFilteredPage({ search: '168662' }, { limit: 20 });

  assert.match(inventoryUpsertSql, /search_text\s*=\s*EXCLUDED\.search_text/i);
  assert.deepEqual(result, { created: 0, updated: 1, totalForSite: 1 });
  assert.equal(rows.size, 1);
  assert.equal(found.length, 1);
  assert.equal(found[0].sku, '168662');
});

test('upsertSiteProducts registra marcas explícitas nuevas antes de relacionarlas', async () => {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const service = new InventoryStoreService({
    async query(sql: string, params: unknown[] = []) {
      queries.push({ sql, params });
      if (/INSERT INTO scraping_inventory/i.test(sql)) {
        return { rows: [{ id: 'url|https://example.com/aeolus', sourceUrl: 'https://example.com/aeolus', created: true }] } as never;
      }
      if (/SELECT COUNT/i.test(sql)) {
        return { rows: [{ total: '1' }] } as never;
      }
      return { rows: [] } as never;
    },
  } as never);

  await service.upsertSiteProducts('https://larrique.com.uy/repuestos-autopartes/1', [{
    productName: 'Repuesto AEOLUS',
    price: '100',
    sourceUrl: 'https://example.com/aeolus',
    compatibleBrands: ['AEOLUS'],
    extractedAt: new Date().toISOString(),
    provider: 'domain',
  }], new Date().toISOString());

  const brandUpsert = queries.find((query) => /INSERT INTO vehicle_brands/i.test(query.sql));
  assert.ok(brandUpsert);
  assert.deepEqual(brandUpsert.params, [['aeolus'], ['AEOLUS']]);
  const relationInsert = queries.find((query) => /INSERT INTO scraping_inventory_vehicle_brands/i.test(query.sql));
  assert.deepEqual(relationInsert?.params[1], ['aeolus']);
});

test('onModuleInit rellena marcas relacionales para inventario existente', async () => {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  let pendingServed = false;

  const service = new InventoryStoreService({
    async ensureCatalogTables() {
      queries.push({ sql: 'ensureCatalogTables', params: [] });
    },
    async query(sql: string, params: unknown[] = []) {
      queries.push({ sql, params });

      if (/SELECT inventory.id, inventory.product/i.test(sql)) {
        if (pendingServed) {
          return { rows: [] } as never;
        }
        pendingServed = true;
        return {
          rows: [{
            id: 'existing-fiat',
            product: {
              productName: 'HORQUILLA ARRANQUE FI',
              sourceUrl: 'https://example.com/fiat',
              extractedAt: new Date().toISOString(),
              provider: 'domain',
            },
          }],
        } as never;
      }

      return { rows: [] } as never;
    },
  } as never);

  await service.onModuleInit();

  const productUpdate = queries.find((query) => /UPDATE scraping_inventory inventory/i.test(query.sql));
  assert.ok(productUpdate);
  const updatedProduct = JSON.parse((productUpdate.params[1] as string[])[0]) as ProductRecord;
  assert.deepEqual(updatedProduct.compatibleBrands, ['Fiat']);

  const relationInsert = queries.find((query) => /INSERT INTO scraping_inventory_vehicle_brands/i.test(query.sql));
  assert.ok(relationInsert);
  assert.deepEqual(relationInsert.params[1], ['fiat']);
});
