import { Inject, Injectable, OnModuleInit, Optional } from '@nestjs/common';
import { ImageStatus, ProductRecord } from '../interfaces/scraping.types';
import { ADMITTED_HOUSES, findDomainRule } from '../domain/domain-rules';
import { extractCompatibilityFromHtml, extractProductsFromHtml } from '../domain/domain-html';
import { fetchHtml } from '../domain/http-client';
import { mergeCompatibleBrands, parsePriceNumber } from '../domain/product-quality';
import { inferVehicleBrands, resolveVehicleBrandFilterId } from '../domain/vehicle-brands';
import { PostgresService } from '../jobs/postgres.service';
import { ImageRelayService } from '../../image-relay/image-relay.service';

export interface StoredProduct extends Omit<ProductRecord, 'price'> {
  price?: number;
  id: string;
  site: string;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
}

type InventoryRow = {
  id: string;
  site: string;
  product: ProductRecord;
  created_at: string;
  updated_at: string;
  last_seen_at: string;
};

type CompatibilityRefreshRow = {
  id: string;
  source_url: string;
  product: ProductRecord;
};

export interface InventoryQueryFilters {
  site?: string;
  search?: string;
  priceState?: string;
  availability?: string;
  priceOrder?: string;
  vehicleBrand?: string;
  /** Freeze membership/order for long export jobs. ISO timestamp. */
  snapshotBefore?: string;
}

export interface InventoryQueryPagination {
  limit?: number;
  offset?: number;
}

export interface InventoryStats {
  total: number;
  bySite: Array<{
    site: string;
    siteLabel: string;
    total: number;
  }>;
}

export interface VehicleBrandInventoryStats {
  id: string;
  label: string;
  total: number;
}

export interface ExistingLinksRefreshProgress {
  site: string;
  status: 'success' | 'error';
  stage: 'starting' | 'crawling' | 'done' | 'error';
  timeWorkingMs: number;
  quantityScrapped: number;
  pagesUsedForExtract: number;
  rawProducts: number;
  normalizedProducts: number;
  message?: string;
}

export type ExistingLinksRefreshReporter = (progress: ExistingLinksRefreshProgress) => Promise<void> | void;

@Injectable()
export class InventoryStoreService implements OnModuleInit {
  private readonly upsertChunkSize = 100;
  private readonly vehicleBrandBackfillChunkSize = 500;

  constructor(@Inject(PostgresService) private readonly postgresService: PostgresService, @Optional() private readonly imageRelayService?: ImageRelayService) {}

  async onModuleInit(): Promise<void> {
    await this.postgresService.ensureCatalogTables();
    await this.backfillVehicleBrandRelations();
  }

  async upsertSiteProducts(site: string, products: ProductRecord[], runAt: string) {
    let created = 0;
    let updated = 0;

    const payloadBySourceUrl = new Map<string, {
      id: string;
      site: string;
      sourceUrl: string;
      product: string;
      searchText: string;
      vehicleBrands: ReturnType<typeof inferVehicleBrands>;
    }>();

    products
      .map((product) => {
        const vehicleBrands = inferVehicleBrands(product);
        const enrichedProduct: ProductRecord = {
          ...product,
          compatibleBrands: vehicleBrands.map((brand) => brand.label),
        };
        const sourceUrl = canonicalProductUrl(enrichedProduct.sourceUrl);
        if (!sourceUrl) {
          return undefined;
        }

        return {
          id: `url|${sourceUrl}`,
          site,
          sourceUrl,
          product: JSON.stringify(enrichedProduct),
          searchText: buildProductSearchText(enrichedProduct),
          vehicleBrands,
        };
      })
      .filter((item): item is { id: string; site: string; sourceUrl: string; product: string; searchText: string; vehicleBrands: ReturnType<typeof inferVehicleBrands> } => Boolean(item))
      .forEach((item) => payloadBySourceUrl.set(item.sourceUrl, item));

    const payload = Array.from(payloadBySourceUrl.values());

    for (let index = 0; index < payload.length; index += this.upsertChunkSize) {
      const chunk = payload.slice(index, index + this.upsertChunkSize);
      const upserted = await this.postgresService.query<{ id: string; sourceUrl: string; created: boolean }>(
        `
        INSERT INTO scraping_inventory (id, site, source_url, product, search_text, created_at, updated_at, last_seen_at)
        SELECT item.id, item.site, item.source_url, item.product::jsonb, item.search_text, $1::timestamptz, $1::timestamptz, $1::timestamptz
        FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[]) AS item(id, site, source_url, product, search_text)
        ON CONFLICT (source_url)
        DO UPDATE SET
          site = EXCLUDED.site,
          product = EXCLUDED.product,
          search_text = EXCLUDED.search_text,
          updated_at = EXCLUDED.updated_at,
          last_seen_at = EXCLUDED.last_seen_at
        RETURNING id, source_url AS "sourceUrl", (xmax = 0) AS created
        `,
        [
          runAt,
          chunk.map((item) => item.id),
          chunk.map((item) => item.site),
          chunk.map((item) => item.sourceUrl),
          chunk.map((item) => item.product),
          chunk.map((item) => item.searchText),
        ],
      );

      for (const row of upserted.rows) {
        if (row.created) {
          created += 1;
        } else {
          updated += 1;
        }
      }

      const brandsBySourceUrl = new Map(chunk.map((item) => [item.sourceUrl, item.vehicleBrands]));
      await this.syncVehicleBrandRelations(
        upserted.rows.map((row) => ({
          id: row.id,
          vehicleBrands: brandsBySourceUrl.get(row.sourceUrl) ?? [],
        })),
      );
      await Promise.all(upserted.rows.map((row) => {
        const item = chunk.find((candidate) => candidate.sourceUrl === row.sourceUrl);
        return item ? this.imageRelayService?.enqueueForInventory(row.id, item.site, JSON.parse(item.product) as ProductRecord) : 0;
      }));
    }

    const totalForSite = await this.countBySite(site);
    return { created, updated, totalForSite };
  }

  async getAll(): Promise<StoredProduct[]> {
    return this.getFiltered();
  }

  async getBySite(site: string): Promise<StoredProduct[]> {
    return this.getFiltered({ site });
  }

  async getFiltered(filters: InventoryQueryFilters = {}): Promise<StoredProduct[]> {
    const { sql, params } = buildInventoryQuery(filters);
    const rows = await this.postgresService.query<InventoryRow>(
      sql,
      params,
    );
    return this.enrichImageAssets(rows.rows);
  }

  async getFilteredPage(filters: InventoryQueryFilters = {}, pagination: InventoryQueryPagination = {}): Promise<StoredProduct[]> {
    const { sql, params } = buildInventoryQuery(filters, pagination);
    const rows = await this.postgresService.query<InventoryRow>(sql, params);
    return this.enrichImageAssets(rows.rows);
  }

  private async enrichImageAssets(rows: InventoryRow[]): Promise<StoredProduct[]> {
    if (rows.length === 0) return [];
    const assets = await this.postgresService.query<{ inventory_id: string; asset_id: string }>(
      'SELECT DISTINCT ON (inventory_id) inventory_id, id AS asset_id FROM image_assets WHERE inventory_id = ANY($1::text[]) ORDER BY inventory_id, created_at',
      [rows.map((row) => row.id)],
    );
    const assetByInventoryId = new Map<string, string>();
    for (const asset of assets.rows) {
      assetByInventoryId.set(asset.inventory_id, asset.asset_id);
    }

    const products: StoredProduct[] = [];
    for (const row of rows) {
      const assetId = assetByInventoryId.get(row.id);
      if (!assetId) {
        products.push(mapInventoryRow(row));
        continue;
      }

      products.push(mapInventoryRow({
        ...row,
        product: {
          ...row.product,
          sourceImageUrl: row.product.sourceImageUrl ?? row.product.imageUrl,
          imageUrl: `/api/image-assets/${assetId}`,
          imageUrls: [`/api/image-assets/${assetId}`],
          imageStatus: ImageStatus.Completed,
        },
      }));
    }
    return products;
  }

  async countAll(): Promise<number> {
    const result = await this.postgresService.query<{ total: string }>('SELECT COUNT(*)::text AS total FROM scraping_inventory');
    return Number(result.rows[0]?.total ?? 0);
  }

  async countBySite(site: string): Promise<number> {
    const result = await this.postgresService.query<{ total: string }>(
      'SELECT COUNT(*)::text AS total FROM scraping_inventory WHERE site = $1',
      [site],
    );
    return Number(result.rows[0]?.total ?? 0);
  }

  async refreshCompatibility(site?: string) {
    const pending = await this.postgresService.query<CompatibilityRefreshRow>(
      `
      SELECT id, source_url, product
      FROM scraping_inventory
      WHERE source_url IS NOT NULL
        AND ($1::text IS NULL OR site ILIKE '%' || $1 || '%')
        AND (
          NOT (product ? 'compatibleModels')
          OR jsonb_array_length(COALESCE(product->'compatibleModels', '[]'::jsonb)) = 0
          OR NOT (product ? 'compatibleVersions')
          OR jsonb_array_length(COALESCE(product->'compatibleVersions', '[]'::jsonb)) = 0
        )
      ORDER BY updated_at DESC
      `,
      [site?.trim() || null],
    );

    let enriched = 0;
    let failed = 0;
    const relationItems: Array<{ id: string; vehicleBrands: ReturnType<typeof inferVehicleBrands> }> = [];

    for (let index = 0; index < pending.rows.length; index += 8) {
      const batch = pending.rows.slice(index, index + 8);
      const results = await Promise.all(batch.map(async (row) => {
        try {
          const response = await fetchHtml(row.source_url);
          const compatibility = extractCompatibilityFromHtml(response.body);
          if (!compatibility.compatibleModels?.length && !compatibility.compatibleVersions?.length) {
            return undefined;
          }

          const product: ProductRecord = {
            ...row.product,
            compatibleBrands: mergeCompatibleBrands(row.product.compatibleBrands, compatibility.compatibleBrands),
            compatibleVehicles: mergeTextValues(row.product.compatibleVehicles, compatibility.compatibleVehicles),
            compatibleModels: mergeTextValues(row.product.compatibleModels, compatibility.compatibleModels),
            compatibleVersions: mergeTextValues(row.product.compatibleVersions, compatibility.compatibleVersions),
          };
          return { row, product, vehicleBrands: inferVehicleBrands(product) };
        } catch {
          return null;
        }
      }));

      for (const result of results) {
        if (result === null) {
          failed += 1;
          continue;
        }
        if (!result) continue;

        await this.postgresService.query(
          `
          UPDATE scraping_inventory
          SET product = $2::jsonb,
              search_text = $3,
              updated_at = NOW()
          WHERE id = $1
          `,
          [result.row.id, JSON.stringify(result.product), buildProductSearchText(result.product)],
        );
        relationItems.push({ id: result.row.id, vehicleBrands: result.vehicleBrands });
        enriched += 1;
      }
    }

    if (relationItems.length > 0) {
      await this.syncVehicleBrandRelations(relationItems);
    }

    return { scanned: pending.rows.length, enriched, failed };
  }

  async refreshExistingLinks(site: string, onProgress?: ExistingLinksRefreshReporter) {
    const normalizedSite = site.trim();
    const startedAt = Date.now();
    const pending = await this.postgresService.query<CompatibilityRefreshRow>(
      `
      SELECT id, source_url, product
      FROM scraping_inventory
      WHERE source_url IS NOT NULL
        AND site ILIKE '%' || $1 || '%'
      ORDER BY updated_at DESC
      `,
      [normalizedSite],
    );

    await onProgress?.({
      site: normalizedSite,
      status: 'success',
      stage: 'starting',
      timeWorkingMs: 0,
      quantityScrapped: 0,
      pagesUsedForExtract: pending.rows.length,
      rawProducts: pending.rows.length,
      normalizedProducts: 0,
    });

    let refreshed = 0;
    let failed = 0;
    const relationItems: Array<{ id: string; vehicleBrands: ReturnType<typeof inferVehicleBrands> }> = [];

    for (let index = 0; index < pending.rows.length; index += 4) {
      const batch = pending.rows.slice(index, index + 4);
      const results = await Promise.all(batch.map(async (row) => {
        try {
          const response = await fetchHtml(row.source_url);
          const rule = findDomainRule(row.source_url);
          const detail = rule
            ? extractProductsFromHtml(response.body, response.finalUrl, 'domain', rule)
                .find((item) => canonicalProductUrl(item.sourceUrl) === canonicalProductUrl(row.source_url))
            : undefined;
          const compatibility = extractCompatibilityFromHtml(response.body);
          const product: ProductRecord = {
            ...row.product,
            ...(detail ?? {}),
            sourceUrl: row.source_url,
            compatibleBrands: mergeCompatibleBrands(row.product.compatibleBrands, compatibility.compatibleBrands),
            compatibleVehicles: mergeTextValues(row.product.compatibleVehicles, compatibility.compatibleVehicles),
            compatibleModels: mergeTextValues(row.product.compatibleModels, compatibility.compatibleModels),
            compatibleVersions: mergeTextValues(row.product.compatibleVersions, compatibility.compatibleVersions),
          };
          const changed = Boolean(detail)
            || Boolean(compatibility.compatibleModels?.length)
            || Boolean(compatibility.compatibleVersions?.length);
          return changed ? { row, product, vehicleBrands: inferVehicleBrands(product) } : undefined;
        } catch {
          return null;
        }
      }));

      for (const result of results) {
        if (result === null) {
          failed += 1;
          continue;
        }
        if (!result) continue;

        await this.postgresService.query(
          `
          UPDATE scraping_inventory
          SET product = $2::jsonb,
              search_text = $3,
              updated_at = NOW()
          WHERE id = $1
          `,
          [result.row.id, JSON.stringify(result.product), buildProductSearchText(result.product)],
        );
        relationItems.push({ id: result.row.id, vehicleBrands: result.vehicleBrands });
        refreshed += 1;
      }

      await onProgress?.({
        site: normalizedSite,
        status: 'success',
        stage: 'crawling',
        timeWorkingMs: Date.now() - startedAt,
        quantityScrapped: refreshed,
        pagesUsedForExtract: pending.rows.length,
        rawProducts: index + batch.length,
        normalizedProducts: refreshed,
        message: `Procesados ${index + batch.length} de ${pending.rows.length}`,
      });
    }

    if (relationItems.length > 0) {
      await this.syncVehicleBrandRelations(relationItems);
    }

    await onProgress?.({
      site: normalizedSite,
      status: failed > 0 ? 'error' : 'success',
      stage: failed > 0 ? 'error' : 'done',
      timeWorkingMs: Date.now() - startedAt,
      quantityScrapped: refreshed,
      pagesUsedForExtract: pending.rows.length,
      rawProducts: pending.rows.length,
      normalizedProducts: refreshed,
      message: failed > 0 ? `Finalizado con ${failed} errores` : 'Finalizado',
    });

    return { site: normalizedSite, scanned: pending.rows.length, refreshed, failed };
  }

  async getStats(): Promise<InventoryStats> {
    const siteLabels = new Map<string, string>();
    for (const house of ADMITTED_HOUSES) {
      siteLabels.set(house.id, house.label);
      siteLabels.set(normalizeSiteAlias(house.label), house.label);
      siteLabels.set(house.canonicalHostname, house.label);
      for (const hostname of house.hostnames) {
        siteLabels.set(hostname, house.label);
      }
    }

    const [total, bySite] = await Promise.all([
      this.countAll(),
      this.postgresService.query<{ site: string; total: string }>(`
        SELECT
          regexp_replace(
            split_part(
              replace(replace(lower(site), 'https://', ''), 'http://', ''),
              '/',
              1
            ),
            '^www\\.',
            ''
          ) AS site,
          COUNT(*)::text AS total
        FROM scraping_inventory
        GROUP BY 1
        ORDER BY COUNT(*) DESC, site ASC
      `),
    ]);

    return {
      total,
      bySite: bySite.rows.map((row) => ({
        site: row.site,
        siteLabel: siteLabels.get(normalizeStatsSiteKey(row.site)) ?? normalizeStatsSiteKey(row.site),
        total: Number(row.total ?? 0),
      })),
    };
  }

  async countFiltered(filters: InventoryQueryFilters = {}): Promise<number> {
    const { sql, params } = buildInventoryCountQuery(filters);
    const result = await this.postgresService.query<{ total: string }>(sql, params);
    return Number(result.rows[0]?.total ?? 0);
  }

  async getVehicleBrandStats(filters: InventoryQueryFilters = {}): Promise<VehicleBrandInventoryStats[]> {
    const filtersWithoutVehicleBrand = { ...filters, vehicleBrand: undefined };
    const { whereClause, params } = buildInventoryConditions(filtersWithoutVehicleBrand);
    const result = await this.postgresService.query<{ id: string; label: string; total: string }>(`
      SELECT
        brand.id,
        brand.label,
        COUNT(link.inventory_id)::text AS total
      FROM vehicle_brands brand
      LEFT JOIN scraping_inventory_vehicle_brands link
        ON link.brand_id = brand.id
      LEFT JOIN scraping_inventory
        ON scraping_inventory.id = link.inventory_id
      WHERE brand.active = TRUE
        ${whereClause ? `AND ${whereClause.slice('WHERE '.length)}` : ''}
      GROUP BY brand.id, brand.label
      ORDER BY brand.label ASC
    `, params);

    return result.rows.map((row) => ({
      id: row.id,
      label: row.label,
      total: Number(row.total ?? 0),
    }));
  }

  private async syncVehicleBrandRelations(items: Array<{ id: string; vehicleBrands: ReturnType<typeof inferVehicleBrands> }>): Promise<void> {
    const brands = new Map(items.flatMap((item) => item.vehicleBrands).map((brand) => [brand.id, brand.label]));
    if (brands.size > 0) {
      await this.postgresService.query(
        `
        INSERT INTO vehicle_brands (id, label, active)
        SELECT item.id, item.label, TRUE
        FROM unnest($1::text[], $2::text[]) AS item(id, label)
        ON CONFLICT (id)
        DO UPDATE SET label = EXCLUDED.label,
                      active = TRUE
        `,
        [Array.from(brands.keys()), Array.from(brands.values())],
      );
    }

    const inventoryIds = items.map((item) => item.id);
    await this.postgresService.query(
      'DELETE FROM scraping_inventory_vehicle_brands WHERE inventory_id = ANY($1::text[])',
      [inventoryIds],
    );

    const rows = items.flatMap((item) =>
      item.vehicleBrands.map((brand) => ({
        inventoryId: item.id,
        brandId: brand.id,
        confidence: brand.confidence,
        evidence: brand.evidence ?? null,
      })),
    );

    if (rows.length === 0) {
      return;
    }

    await this.postgresService.query(
      `
      INSERT INTO scraping_inventory_vehicle_brands (inventory_id, brand_id, confidence, evidence)
      SELECT item.inventory_id, item.brand_id, item.confidence, item.evidence
      FROM unnest($1::text[], $2::text[], $3::text[], $4::text[]) AS item(inventory_id, brand_id, confidence, evidence)
      ON CONFLICT (inventory_id, brand_id)
      DO UPDATE SET confidence = EXCLUDED.confidence,
                    evidence = EXCLUDED.evidence
      `,
      [
        rows.map((row) => row.inventoryId),
        rows.map((row) => row.brandId),
        rows.map((row) => row.confidence),
        rows.map((row) => row.evidence),
      ],
    );
  }

  private async backfillVehicleBrandRelations(): Promise<void> {
    while (true) {
      const pending = await this.postgresService.query<{ id: string; product: ProductRecord }>(
        `
        SELECT inventory.id, inventory.product
        FROM scraping_inventory inventory
        WHERE NOT EXISTS (
          SELECT 1
          FROM scraping_inventory_vehicle_brands vehicle_brand_link
          WHERE vehicle_brand_link.inventory_id = inventory.id
        )
        ORDER BY inventory.updated_at DESC
        LIMIT $1
        `,
        [this.vehicleBrandBackfillChunkSize],
      );

      if (pending.rows.length === 0) {
        return;
      }

      const items = pending.rows.map((row) => {
        const vehicleBrands = inferVehicleBrands(row.product);
        const enrichedProduct: ProductRecord = {
          ...row.product,
          compatibleBrands: vehicleBrands.map((brand) => brand.label),
        };
        return {
          id: row.id,
          product: JSON.stringify(enrichedProduct),
          vehicleBrands,
        };
      });

      await this.postgresService.query(
        `
        UPDATE scraping_inventory inventory
        SET product = item.product::jsonb
        FROM unnest($1::text[], $2::text[]) AS item(id, product)
        WHERE inventory.id = item.id
        `,
        [items.map((item) => item.id), items.map((item) => item.product)],
      );
      await this.syncVehicleBrandRelations(items);
    }
  }
}

function mapInventoryRow(row: InventoryRow): StoredProduct {
  const { price, ...product } = row.product;

  return {
    ...product,
    price: parsePriceNumber(price),
    id: row.id,
    site: row.site,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSeenAt: row.last_seen_at,
  };
}

function canonicalProductUrl(value?: string): string | undefined {
  if (!value?.trim()) {
    return undefined;
  }

  try {
    const url = new URL(value.trim());
    if (!/^https?:$/.test(url.protocol)) {
      return undefined;
    }

    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    url.hash = '';
    url.pathname = url.pathname === '/' ? '/' : url.pathname.replace(/\/+$/, '');
    return url.toString().replace(/\/$/, '').toLowerCase();
  } catch {
    return undefined;
  }
}

function normalizeStatsSiteKey(value: string): string {
  return value.trim().toLowerCase().replace(/^www\./, '');
}

function buildInventoryQuery(filters: InventoryQueryFilters, pagination: InventoryQueryPagination = {}) {
  const { whereClause, params } = buildInventoryConditions(filters);
  const limit = normalizeLimit(pagination.limit);
  const offset = normalizeOffset(pagination.offset);
  const orderBy = buildOrderByClause(filters.priceOrder, Boolean(normalizeSnapshotBefore(filters.snapshotBefore)));
  const orderedByPrice = isPriceOrder(filters.priceOrder);

  if (limit !== undefined) {
    params.push(limit);
  }

  if (offset !== undefined) {
    params.push(offset);
  }

  return {
    sql: orderedByPrice
      ? `
      WITH inventory_rows AS (
        SELECT
          id,
          site,
          product,
          created_at,
          updated_at,
          last_seen_at,
          ${normalizedPriceSqlExpression()} AS price_sort
        FROM scraping_inventory
        ${whereClause}
      )
      SELECT id, site, product, created_at, updated_at, last_seen_at
      FROM inventory_rows
      ORDER BY ${orderBy}
      ${limit !== undefined ? `LIMIT $${params.length - (offset !== undefined ? 1 : 0)}` : ''}
      ${offset !== undefined ? `OFFSET $${params.length}` : ''}
    `
      : `
      SELECT id, site, product, created_at, updated_at, last_seen_at
      FROM scraping_inventory
      ${whereClause}
      ORDER BY ${orderBy}
      ${limit !== undefined ? `LIMIT $${params.length - (offset !== undefined ? 1 : 0)}` : ''}
      ${offset !== undefined ? `OFFSET $${params.length}` : ''}
    `,
    params,
  };
}

function normalizedPriceSqlExpression(): string {
  const value = "BTRIM(product->>'price')";

  return `NULLIF(
    CASE
      WHEN ${value} ~ '^[0-9.,]+,[0-9]{1,2}$' AND ${value} ~ '\\.'
        THEN REPLACE(REPLACE(${value}, '.', ''), ',', '.')
      WHEN ${value} ~ '^[0-9.,]+\\.[0-9]{1,2}$' AND ${value} ~ ','
        THEN REPLACE(${value}, ',', '')
      WHEN ${value} ~ '^[0-9]+,[0-9]{1,2}$'
        THEN REPLACE(${value}, ',', '.')
      WHEN ${value} ~ '^[0-9]+\\.[0-9]{1,2}$'
        THEN ${value}
      WHEN ${value} ~ '^[0-9]{1,3}(\\.[0-9]{3})+$'
        THEN REPLACE(${value}, '.', '')
      WHEN ${value} ~ '^[0-9]{1,3}(,[0-9]{3})+$'
        THEN REPLACE(${value}, ',', '')
      ELSE NULLIF(REGEXP_REPLACE(${value}, '[^0-9]', '', 'g'), '')
    END,
    ''
  )::numeric`;
}

function buildInventoryCountQuery(filters: InventoryQueryFilters) {
  const { whereClause, params } = buildInventoryConditions(filters);

  return {
    sql: `
      SELECT COUNT(*)::text AS total
      FROM scraping_inventory
      ${whereClause}
    `,
    params,
  };
}

function buildInventoryConditions(filters: InventoryQueryFilters) {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.site?.trim()) {
    const matchedHosts = resolveInventorySiteHosts(filters.site.trim());
    if (!matchedHosts.length) {
      conditions.push('FALSE');
    } else {
      params.push(matchedHosts);
      conditions.push(`${normalizedInventorySiteHostExpression()} = ANY($${params.length}::text[])`);
    }
  }

  const search = filters.search?.trim();
  if (search) {
    const tokens = normalizeSearchTokens(search);
    if (tokens.length) {
      for (const token of tokens) {
        params.push(`%${token.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`);
        conditions.push(`search_text LIKE $${params.length} ESCAPE '\\'`);
      }
    }
  }

  const priceState = normalizeState(filters.priceState);
  if (priceState === 'with-price') {
    conditions.push(`COALESCE(NULLIF(BTRIM(product->>'price'), ''), '') <> ''`);
  } else if (priceState === 'without-price') {
    conditions.push(`COALESCE(NULLIF(BTRIM(product->>'price'), ''), '') = ''`);
  }

  const availability = normalizeState(filters.availability);
  if (availability === 'available') {
    conditions.push(`
      LOWER(COALESCE(product->>'availability', '')) IN ('in_stock', 'in stock', 'available', 'available now')
    `);
  } else if (availability === 'unavailable') {
    conditions.push(`
      LOWER(COALESCE(product->>'availability', '')) IN ('out_of_stock', 'out of stock', 'unavailable', 'agotado', 'sin stock')
    `);
  } else if (availability === 'unknown') {
    conditions.push(`
      COALESCE(NULLIF(BTRIM(LOWER(product->>'availability')), ''), 'unknown') = 'unknown'
    `);
  }

  const snapshotBefore = normalizeSnapshotBefore(filters.snapshotBefore);
  if (snapshotBefore) {
    params.push(snapshotBefore);
    conditions.push(`created_at <= $${params.length}::timestamptz`);
  }

  const vehicleBrand = resolveVehicleBrandFilterId(filters.vehicleBrand);
  if (vehicleBrand) {
    params.push(vehicleBrand);
    conditions.push(`
      EXISTS (
        SELECT 1
        FROM scraping_inventory_vehicle_brands vehicle_brand_link
        WHERE vehicle_brand_link.inventory_id = scraping_inventory.id
          AND vehicle_brand_link.brand_id = $${params.length}
      )
    `);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  return { whereClause, params };
}

function normalizeSnapshotBefore(value?: string): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function normalizeState(value?: string): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : undefined;
}

function resolveInventorySiteHosts(site: string): string[] {
  const normalizedInput = normalizeSiteAlias(site);
  const matchedHouse = ADMITTED_HOUSES.find((house) =>
    getInventorySiteAliases(house).some((alias) => normalizeSiteAlias(alias) === normalizedInput),
  );

  if (matchedHouse) {
    return Array.from(
      new Set([matchedHouse.canonicalHostname, ...matchedHouse.hostnames].map((alias) => normalizeSiteHost(alias)).filter(Boolean)),
    );
  }

  const normalizedHost = normalizeSiteHost(site);
  return normalizedHost ? [normalizedHost] : [];
}

function getInventorySiteAliases(house: (typeof ADMITTED_HOUSES)[number]): string[] {
  return [house.id, house.label, house.canonicalHostname, ...house.hostnames];
}

function normalizedInventorySiteHostExpression(): string {
  return `
    regexp_replace(
      split_part(
        replace(replace(lower(site), 'https://', ''), 'http://', ''),
        '/',
        1
      ),
      '^www\\.',
      ''
    )
  `;
}

function normalizeSiteHost(site: string): string {
  try {
    return new URL(site).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return site
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .split('/')[0];
  }
}

function normalizeSiteAlias(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '')
    .replace(/[^a-z0-9]+/g, '');
}

function buildOrderByClause(priceOrder?: string, stableSnapshot = false): string {
  const normalized = priceOrder?.trim().toLowerCase();
  if (normalized === 'asc') {
    return stableSnapshot
      ? `price_sort ASC NULLS LAST, created_at DESC, id ASC`
      : `price_sort ASC NULLS LAST, updated_at DESC, id ASC`;
  }

  if (normalized === 'desc') {
    return stableSnapshot
      ? `price_sort DESC NULLS LAST, created_at DESC, id ASC`
      : `price_sort DESC NULLS LAST, updated_at DESC, id ASC`;
  }

  return stableSnapshot ? `created_at DESC, id ASC` : `updated_at DESC, id ASC`;
}

function isPriceOrder(priceOrder?: string): boolean {
  const normalized = priceOrder?.trim().toLowerCase();
  return normalized === 'asc' || normalized === 'desc';
}

function normalizeSearchTokens(search: string): string[] {
  return search
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .map((token) =>
      token
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/([a-z])\1+/g, '$1')
        .trim(),
    )
    .filter((token) => token.length >= 2);
}

function buildProductSearchText(product: ProductRecord): string {
  return [
    product.productName,
    product.sku,
    product.brand,
    product.category,
    product.description,
    product.compatibleVehicles?.join(' '),
    product.compatibleModels?.join(' '),
    product.compatibleVersions?.join(' '),
    product.compatibleBrands?.join(' '),
    Object.values(product.attributes ?? {}).join(' '),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/([a-z])\1+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function mergeTextValues(previous?: string[], current?: string[]): string[] | undefined {
  const values = new Map<string, string>();
  for (const value of [...(previous ?? []), ...(current ?? [])]) {
    const cleaned = value?.trim();
    if (cleaned) values.set(cleaned.toLowerCase(), cleaned);
  }
  return values.size > 0 ? Array.from(values.values()) : undefined;
}

function normalizeLimit(value?: number): number | undefined {
  if (!Number.isFinite(value ?? NaN)) {
    return undefined;
  }

  const normalized = Math.max(1, Math.min(Math.trunc(value as number), 200));
  return normalized;
}

function normalizeOffset(value?: number): number | undefined {
  if (!Number.isFinite(value ?? NaN)) {
    return undefined;
  }

  return Math.max(0, Math.trunc(value as number));
}

function normalizeSnapshotBefore(value?: string): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function normalizeState(value?: string): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : undefined;
}

function resolveInventorySiteHosts(site: string): string[] {
  const normalizedInput = normalizeSiteAlias(site);
  const matchedHouse = ADMITTED_HOUSES.find((house) =>
    getInventorySiteAliases(house).some((alias) => normalizeSiteAlias(alias) === normalizedInput),
  );

  if (matchedHouse) {
    return Array.from(
      new Set([matchedHouse.canonicalHostname, ...matchedHouse.hostnames].map((alias) => normalizeSiteHost(alias)).filter(Boolean)),
    );
  }

  const normalizedHost = normalizeSiteHost(site);
  return normalizedHost ? [normalizedHost] : [];
}

function getInventorySiteAliases(house: (typeof ADMITTED_HOUSES)[number]): string[] {
  return [house.id, house.label, house.canonicalHostname, ...house.hostnames];
}

function normalizedInventorySiteHostExpression(): string {
  return `
    regexp_replace(
      split_part(
        replace(replace(lower(site), 'https://', ''), 'http://', ''),
        '/',
        1
      ),
      '^www\\.',
      ''
    )
  `;
}

function normalizeSiteHost(site: string): string {
  try {
    return new URL(site).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return site
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .split('/')[0];
  }
}

function normalizeSiteAlias(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '')
    .replace(/[^a-z0-9]+/g, '');
}

function buildOrderByClause(priceOrder?: string, stableSnapshot = false): string {
  const normalized = priceOrder?.trim().toLowerCase();
  if (normalized === 'asc') {
    return stableSnapshot
      ? `price_sort ASC NULLS LAST, created_at DESC, id ASC`
      : `price_sort ASC NULLS LAST, updated_at DESC, id ASC`;
  }

  if (normalized === 'desc') {
    return stableSnapshot
      ? `price_sort DESC NULLS LAST, created_at DESC, id ASC`
      : `price_sort DESC NULLS LAST, updated_at DESC, id ASC`;
  }

  return stableSnapshot ? `created_at DESC, id ASC` : `updated_at DESC, id ASC`;
}

function isPriceOrder(priceOrder?: string): boolean {
  const normalized = priceOrder?.trim().toLowerCase();
  return normalized === 'asc' || normalized === 'desc';
}

function normalizeSearchTokens(search: string): string[] {
  return search
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .map((token) =>
      token
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/([a-z])\1+/g, '$1')
        .trim(),
    )
    .filter((token) => token.length >= 2);
}

function buildProductSearchText(product: ProductRecord): string {
  return [
    product.productName,
    product.sku,
    product.brand,
    product.category,
    product.description,
    product.compatibleVehicles?.join(' '),
    product.compatibleModels?.join(' '),
    product.compatibleVersions?.join(' '),
    product.compatibleBrands?.join(' '),
    Object.values(product.attributes ?? {}).join(' '),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/([a-z])\1+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function mergeTextValues(previous?: string[], current?: string[]): string[] | undefined {
  const values = new Map<string, string>();
  for (const value of [...(previous ?? []), ...(current ?? [])]) {
    const cleaned = value?.trim();
    if (cleaned) values.set(cleaned.toLowerCase(), cleaned);
  }
  return values.size > 0 ? Array.from(values.values()) : undefined;
}

function normalizeLimit(value?: number): number | undefined {
  if (!Number.isFinite(value ?? NaN)) {
    return undefined;
  }

  const normalized = Math.max(1, Math.min(Math.trunc(value as number), 200));
  return normalized;
}

function normalizeOffset(value?: number): number | undefined {
  if (!Number.isFinite(value ?? NaN)) {
    return undefined;
  }

  return Math.max(0, Math.trunc(value as number));
}
