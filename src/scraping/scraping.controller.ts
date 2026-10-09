import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Inject, NotFoundException, Param, Post, Query, UnauthorizedException } from '@nestjs/common';
import { CatalogScrapeRequestDto, DEFAULT_CATALOG_SITES, SingleSiteCatalogScrapeRequestDto } from './dto/catalog-request.dto';
import { CrawlRequestDto, DomainProviderConfigDto, ExtractRequestDto, JobIdParamDto, ScrapeRequestDto } from './dto/scrape-request.dto';
import { ADMITTED_HOUSES, findDomainRule } from './domain/domain-rules';
import { CatalogScrapingService } from './catalog-scraping.service';
import { JobQueueService, type ScrapingJob, type ScrapingJobSummary } from './jobs/job.queue';
import { type ScrapingOperationPayload } from './interfaces/scraping.types';
import { ScrapingService } from './scraping.service';

const INVENTORY_HOUSE_OPTIONS = ADMITTED_HOUSES.map((house) => ({
  id: house.id,
  label: house.label,
}));

const INVENTORY_HOUSE_LABELS: Record<string, string> = Object.fromEntries(
  ADMITTED_HOUSES.flatMap((house) => [
    [house.id, house.label],
    [house.label.toLowerCase(), house.label],
    [house.canonicalHostname, house.label],
    ...house.hostnames.map((hostname) => [hostname, house.label] as const),
  ]),
);

@Controller()
export class ScrapingController {
  constructor(
    @Inject(ScrapingService)
    private readonly scrapingService: ScrapingService,
    @Inject(JobQueueService)
    private readonly jobQueueService: JobQueueService,
    @Inject(CatalogScrapingService)
    private readonly catalogScrapingService: CatalogScrapingService,
  ) {}

  @Get('health')
  health() {
    return {
      status: 'ok',
      service: 'Scrapping-Repuestos-UY-API',
      mode: 'hybrid-provider',
    };
  }

  @Get('stats/data')
  statsData() {
    return this.catalogScrapingService.getStats();
  }

  @Post('scraping/scrape')
  async scrape(@Body() payload: ScrapeRequestDto, @Query() config: DomainProviderConfigDto) {
    if (config.async === 'true') {
      return this.jobQueueService.enqueue('scrape', {
        ...payload,
        providerOverride: config.provider,
      });
    }

    return this.scrapingService.scrape(payload, config.provider);
  }

  @Post('scraping/crawl')
  async crawl(@Body() payload: CrawlRequestDto, @Query() config: DomainProviderConfigDto) {
    if (config.async === 'true') {
      return this.jobQueueService.enqueue('crawl', {
        ...payload,
        providerOverride: config.provider,
      });
    }

    return this.scrapingService.crawl(payload, config.provider);
  }

  @Post('scraping/extract')
  async extract(@Body() payload: ExtractRequestDto, @Query() config: DomainProviderConfigDto) {
    if (config.async === 'true') {
      return this.jobQueueService.enqueue('extract', {
        ...payload,
        providerOverride: config.provider,
      });
    }

    return this.scrapingService.extract(payload, config.provider);
  }

  @Post('scraping/catalog/run')
  @HttpCode(202)
  async runCatalog(@Body() payload: CatalogScrapeRequestDto, @Query('exclude_sites') excludeSites?: string) {
    const job = await this.jobQueueService.enqueue('catalog-run', {
      ...payload,
      urls: resolveCatalogSites(payload.urls, excludeSites),
    } as unknown as ScrapingOperationPayload);
    return {
      message: 'Scraping encolado',
      jobId: job.id,
      status: job.status,
    };
  }

  @Post('scraping/inventory/refresh')
  @HttpCode(202)
  async refreshInventory(@Query('exclude_sites') excludeSites?: string) {
    const job = await this.jobQueueService.enqueue('catalog-run', {
      urls: resolveCatalogSites(undefined, excludeSites),
    } as unknown as ScrapingOperationPayload);

    return {
      message: 'Scraping encolado',
      jobId: job.id,
      status: job.status,
    };
  }

  @Post('scraping/inventory/reset')
  @HttpCode(200)
  async resetInventory() {
    return this.catalogScrapingService.resetCatalogData();
  }

  @Post('scraping/inventory/compatibility-refresh')
  @HttpCode(200)
  refreshInventoryCompatibility(@Query('site') site?: string) {
    return this.catalogScrapingService.refreshCompatibility(site);
  }

  @Post('scraping/inventory/refresh-existing-links')
  @HttpCode(202)
  async refreshExistingLinks(@Query('site') site?: string, @Headers('x-inventory-refresh-token') token?: string) {
    if (!site?.trim()) {
      throw new BadRequestException('site es obligatorio para refrescar links existentes');
    }
    const expectedToken = process.env.INVENTORY_REFRESH_TOKEN;
    if (process.env.NODE_ENV === 'production' && (!expectedToken || token !== expectedToken)) {
      throw new UnauthorizedException('Token de refresh invalido');
    }

    const job = await this.jobQueueService.enqueue('refresh-existing-links', { site: site.trim() });
    return {
      message: 'Refresh de links existentes encolado',
      jobId: job.id,
      status: job.status,
    };
  }

  @Post('scraping/quick-run')
  @HttpCode(202)
  quickRunSingleSite(@Body() payload: SingleSiteCatalogScrapeRequestDto) {
    return this.jobQueueService.enqueue('catalog-run', {
      urls: [payload.url],
      maxPagesPerSite: payload.maxPages,
      maxProductsPerSite: payload.maxProducts,
    } as unknown as ScrapingOperationPayload).then((job) => ({
      message: 'Scraping encolado',
      jobId: job.id,
      status: job.status,
    }));
  }

  @Post('start-scrapping-uy')
  @HttpCode(202)
  async startScrappingUy(@Body() payload: CatalogScrapeRequestDto, @Query('exclude_sites') excludeSites?: string) {
    const job = await this.jobQueueService.enqueue('catalog-run', {
      urls: resolveCatalogSites(payload.urls, excludeSites),
      maxPagesPerSite: payload.maxPagesPerSite,
      maxProductsPerSite: payload.maxProductsPerSite,
      siteConcurrency: payload.siteConcurrency,
    } as unknown as ScrapingOperationPayload);

    return {
      message: 'Scraping encolado',
      jobId: job.id,
      status: job.status,
    };
  }

  @Get('scraping/inventory')
  getInventory(
    @Query('site') site?: string,
    @Query('search') search?: string,
    @Query('priceState') priceState?: string,
    @Query('availability') availability?: string,
    @Query('priceOrder') priceOrder?: string,
    @Query('vehicleBrand') vehicleBrand?: string,
    @Query('snapshotBefore') snapshotBefore?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.catalogScrapingService.getCurrentInventory({
      site,
      search,
      priceState,
      availability,
      priceOrder,
      vehicleBrand,
      snapshotBefore,
    }, {
      limit: Number(limit),
      offset: Number(offset),
    });
  }

  @Get('scraping/inventory/vehicle-brands')
  getVehicleBrands(
    @Query('site') site?: string,
    @Query('search') search?: string,
    @Query('priceState') priceState?: string,
    @Query('availability') availability?: string,
  ) {
    return this.catalogScrapingService.getVehicleBrandStats({
      site,
      search,
      priceState,
      availability,
    });
  }

  @Get('scraping/runs')
  listRuns(@Query('limit') limit?: string) {
    const parsed = Number(limit);
    const normalized = Number.isFinite(parsed) ? parsed : undefined;
    return this.catalogScrapingService.listRuns(normalized);
  }

  @Get('scraping/runs/:runId')
  async getRunById(@Param('runId') runId: string) {
    const run = await this.catalogScrapingService.getRunById(runId);
    if (!run) {
      throw new NotFoundException('Run no encontrado');
    }

    return run;
  }

  @Get('scraping/jobs/:id')
  async getJob(@Param() params: JobIdParamDto) {
    const job = await this.jobQueueService.findById(params.id);

    if (!job) {
      throw new NotFoundException('Job no encontrado');
    }

    return buildPublicJobView(job);
  }
}

function buildPublicJobView(job: ScrapingJob) {
  const requestSites = normalizeJobSites(job.payload);
  const progress = normalizeJobProgress(job.summary?.progress, job.updatedAt);
  const progressSummary = progress
    ? {
        completedSites: progress.completedSites,
        totalSites: progress.totalSites,
        activeSite: progress.activeSite,
      }
    : undefined;

  return {
    id: job.id,
    task: job.task,
    status: job.status,
    provider: job.provider,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    request: {
      sites: requestSites,
      totalSites: requestSites.length,
      maxPagesPerSite: numberOrUndefined(job.payload.maxPagesPerSite),
      maxProductsPerSite: numberOrUndefined(job.payload.maxProductsPerSite),
      siteConcurrency: numberOrUndefined(job.payload.siteConcurrency),
    },
    progress: progress
      ? {
          ...progress,
          lastUpdateAt: progress.updatedAt,
          summary: progressSummary,
        }
      : undefined,
    counts: {
      sitesProcessed: progress?.completedSites ?? 0,
      activeSites: progress?.sites.filter((site) => site.status === 'processing').length ?? 0,
      totalProductsScraped: progress
        ? progress.sites.reduce((total, site) => total + (numberOrUndefined(site.quantityScrapped) ?? 0), 0)
        : 0,
    },
  };
}

function normalizeJobSites(payload: ScrapingOperationPayload) {
  const urls = Array.isArray(payload.urls)
    ? payload.urls
    : typeof payload.site === 'string'
      ? [payload.site]
      : [];
  return urls.map((url) => formatCatalogSite(url));
}

function normalizeJobProgress(progress: ScrapingJobSummary['progress'] | undefined, jobUpdatedAt: string) {
  if (!progress || typeof progress !== 'object') {
    return undefined;
  }

  const rawSites = (progress as { sites?: unknown[] }).sites;
  const sites = Array.isArray(rawSites)
    ? rawSites.filter((entry): entry is Record<string, unknown> & { site: string } => Boolean(entry) && typeof entry === 'object' && typeof (entry as { site?: unknown }).site === 'string')
    : [];

  if (sites.length === 0) {
    return undefined;
  }

  const normalizedSites = sites.map((site) => {
    const catalogSite = formatCatalogSite(site.site);
    const normalizedSite: Record<string, unknown> = {
      ...site,
      site: catalogSite.site,
    };

    if ('url' in catalogSite) {
      normalizedSite.url = catalogSite.url;
    } else {
      delete normalizedSite.url;
    }

    return normalizedSite as typeof site & { site: string };
  });
  const completedSites = normalizedSites.filter((site) => site.status === 'success' || site.status === 'error').length;
  const activeSite = normalizedSites.find((site) => site.status === 'processing')?.site;

  return {
    sites: normalizedSites,
    totalSites: normalizedSites.length,
    completedSites,
    activeSite,
    updatedAt: jobUpdatedAt,
  };
}

function formatCatalogSite(url: string) {
  const hostname = tryGetHostname(url);
  const rule = hostname ? findDomainRule(url) : undefined;
  const siteLabel = getCatalogSiteLabel(url, hostname, rule?.id);

  if (rule?.id === 'acesur') {
    return { site: siteLabel };
  }

  return {
    site: siteLabel,
    url,
  };
}

function getCatalogSiteLabel(url: string, hostname: string | undefined, ruleId: string | undefined): string {
  if (ruleId === 'acesur') {
    return 'Acesur (API)';
  }

  if (hostname && INVENTORY_HOUSE_LABELS[hostname]) {
    return INVENTORY_HOUSE_LABELS[hostname];
  }

  return hostname ?? url;
}

function tryGetHostname(value: string): string | undefined {
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
function renderInventoryPage(): string {
  return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="dark" />
    <title>Repuestos nuevos en Uruguay</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600;9..144,700&family=Manrope:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
    <style>
      :root {
        --bg: #08090d;
        --panel: rgba(15, 17, 24, 0.92);
        --panel-strong: #10141d;
        --line: rgba(255, 255, 255, 0.08);
        --line-strong: rgba(255, 255, 255, 0.12);
        --text: #f6f1ea;
        --muted: rgba(246, 241, 234, 0.72);
        --accent: #f2b84b;
        --accent-2: #7fd7c4;
        --danger: #ff8b7a;
        --success: #87e0ad;
        --shadow: 0 28px 90px rgba(0, 0, 0, 0.52);
      }

      * { box-sizing: border-box; }
      html, body { margin: 0; min-height: 100%; }
      body {
        font-family: 'Manrope', system-ui, sans-serif;
        color: var(--text);
        background:
          radial-gradient(circle at 20% 10%, rgba(242, 184, 75, 0.18), transparent 28%),
          radial-gradient(circle at 85% 15%, rgba(127, 215, 196, 0.14), transparent 25%),
          radial-gradient(circle at 50% 95%, rgba(255, 139, 122, 0.08), transparent 26%),
          linear-gradient(160deg, #050609 0%, #080b12 56%, #0d111a 100%);
        overflow-x: hidden;
      }
      .shell {
        min-height: 100vh;
        padding: 24px;
        position: relative;
      }
      .panel {
        width: 100%;
        max-width: none;
        border: 1px solid var(--line);
        border-radius: 26px;
        overflow: hidden;
        box-shadow: var(--shadow);
        background: linear-gradient(180deg, rgba(16, 20, 28, 0.96), rgba(8, 10, 15, 0.96));
      }
      .topbar {
        padding: 16px 20px 12px;
        border-bottom: 1px solid var(--line);
        display: grid;
        gap: 10px;
      }
      .title-row {
        display: flex;
        gap: 16px;
        align-items: end;
        justify-content: space-between;
        flex-wrap: wrap;
      }
      .nav-links {
        display: flex;
        gap: 10px;
        align-items: center;
        flex-wrap: wrap;
      }
      .nav-link {
        color: var(--text);
        text-decoration: none;
        border: 1px solid var(--line-strong);
        background: rgba(255,255,255,0.03);
        padding: 10px 14px;
        border-radius: 999px;
        font-size: 0.92rem;
        font-weight: 700;
      }
      .nav-link:hover {
        border-color: rgba(242,184,75,0.55);
        background: rgba(242,184,75,0.1);
      }
      h1 {
        margin: 0;
        font-family: 'Fraunces', Georgia, serif;
        font-size: clamp(1.8rem, 3vw, 2.8rem);
        letter-spacing: -0.05em;
        line-height: 0.95;
      }
      .main {
        min-width: 0;
        padding: 14px;
      }
      .card {
        border: 1px solid var(--line);
        background: var(--panel);
        border-radius: 20px;
        padding: 14px;
      }
      .table-toolbar {
        display: grid;
        gap: 12px;
        margin-bottom: 12px;
      }
      .search-field { display: grid; gap: 8px; }
      .filters-row {
        display: grid;
        grid-template-columns: 1.2fr 1fr;
        gap: 12px;
      }
      .field { display: grid; gap: 8px; }
      .field-label {
        display: block;
        color: var(--muted);
        text-transform: uppercase;
        font-size: 0.75rem;
        letter-spacing: 0.12em;
      }
      input, select {
        width: 100%;
        border: 1px solid var(--line-strong);
        background: var(--panel-strong);
        color: var(--text);
        border-radius: 14px;
        padding: 12px 14px;
        outline: none;
        font: inherit;
      }
      input::placeholder { color: rgba(246,241,234,0.42); }
      input:focus, select:focus {
        border-color: rgba(242,184,75,0.6);
        box-shadow: 0 0 0 3px rgba(242,184,75,0.12);
      }
      .table-card {
        position: relative;
        overflow: hidden;
      }
      .table-wrap {
        overflow: auto;
        max-height: calc(100vh - 196px);
      }
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: 0.92rem;
        table-layout: fixed;
      }
      thead th {
        position: sticky;
        top: 0;
        z-index: 1;
        background: #111621;
        border-bottom: 1px solid var(--line);
        text-align: left;
        padding: 14px 12px;
        white-space: nowrap;
      }
      tbody td {
        padding: 12px;
        border-bottom: 1px solid rgba(255,255,255,0.06);
        vertical-align: top;
      }
      thead th:first-child,
      tbody td:first-child {
        width: 56%;
      }
      thead th:nth-child(2),
      tbody td:nth-child(2) {
        width: 20%;
      }
      thead th:nth-child(3),
      tbody td:nth-child(3) {
        width: 24%;
      }
      tbody tr:hover { background: rgba(255,255,255,0.03); }
      .product-cell { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
      .product-title {
        display: -webkit-box;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 2;
        font-weight: 700;
        color: var(--text);
        text-decoration: none;
        overflow: hidden;
        word-break: break-word;
        line-height: 1.35;
      }
      .product-title:hover { text-decoration: underline; }
      .muted { color: var(--muted); }
      .right { text-align: right; white-space: nowrap; }
      .price-label {
        display: inline-block;
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .loader {
        position: absolute;
        inset: 0;
        display: none;
        align-items: center;
        justify-content: center;
        background: rgba(8, 10, 15, 0.7);
        backdrop-filter: blur(2px);
        z-index: 2;
      }
      .loader.is-visible { display: flex; }
      .loader-card {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 14px 16px;
        border-radius: 16px;
        background: #111621;
        border: 1px solid var(--line);
        box-shadow: 0 18px 40px rgba(0,0,0,0.28);
      }
      .loader-spinner {
        width: 18px;
        height: 18px;
        border-radius: 50%;
        border: 2px solid rgba(255,255,255,0.2);
        border-top-color: var(--accent);
        animation: spin 0.8s linear infinite;
      }
      .loader-text { font-weight: 700; }
      .empty { padding: 34px; text-align: center; color: var(--muted); }
      .table-tail {
        display: grid;
        gap: 8px;
        padding: 12px 4px 4px;
      }
      .load-more-status {
        min-height: 1.25rem;
        text-align: center;
        color: var(--muted);
        font-size: 0.9rem;
      }
      .scroll-sentinel { height: 1px; }
      .skeleton {
        position: relative;
        overflow: hidden;
        background: #17202d;
        border-radius: 8px;
        min-height: 14px;
      }
      .skeleton::after {
        content: '';
        position: absolute;
        inset: 0;
        transform: translateX(-100%);
        background: linear-gradient(90deg, transparent, rgba(255,255,255,0.08), transparent);
        animation: shimmer 1.1s infinite;
      }
      .skeleton.name { height: 15px; width: 74%; }
      .skeleton.sub { height: 11px; width: 48%; margin-top: 8px; }
      .skeleton.small { height: 12px; width: 72px; }
      .skeleton.price { height: 14px; width: 78px; margin-left: auto; }
      @keyframes spin { to { transform: rotate(360deg); } }
      @keyframes shimmer { 100% { transform: translateX(100%); } }
      @media (max-width: 1200px) {
        .filters-row { grid-template-columns: 1fr 1fr; }
      }
      @media (max-width: 640px) {
        .shell { padding: 12px; }
        .main { padding: 10px; }
        .table-wrap { max-height: calc(100vh - 300px); }
        .filters-row { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <section class="panel">
        <header class="topbar">
          <div class="title-row">
            <div>
              <h1>Repuestos nuevos en Uruguay</h1>
            </div>
            <nav class="nav-links" aria-label="Navegacion principal">
              <a class="nav-link" href="/stats">Estadisticas</a>
            </nav>
          </div>
        </header>

        <section class="main">
          <div class="card table-card">
            <div class="table-toolbar">
              <div class="search-field">
                <label class="field-label" for="search">Buscar productos</label>
                <input id="search" placeholder="Nombre, marca, categoria o descripcion" />
              </div>
              <div class="filters-row">
                <div class="field">
                  <label class="field-label" for="houseFilter">Casa</label>
                  <select id="houseFilter">
                    <option value="">Todas las casas</option>
                  </select>
                </div>
                <div class="field">
                  <label class="field-label" for="priceOrderFilter">Precio</label>
                  <select id="priceOrderFilter">
                    <option value="">Sin ordenar</option>
                    <option value="asc">Menor precio</option>
                    <option value="desc">Mayor precio</option>
                  </select>
                </div>
                <div class="field">
                  <label class="field-label" for="vehicleBrandFilter">Marca vehiculo</label>
                  <select id="vehicleBrandFilter">
                    <option value="">Todas las marcas</option>
                  </select>
                </div>
              </div>
            </div>
            <div id="loader" class="loader" aria-live="polite" aria-busy="true">
              <div class="loader-card">
                <div class="loader-spinner"></div>
                <div class="loader-text">Cargando inventario</div>
              </div>
            </div>
            <div class="table-wrap">
              <table>
                  <thead>
                    <tr>
                      <th>Producto</th>
                      <th class="right">Precio</th>
                      <th>Casa</th>
                    </tr>
                  </thead>
                  <tbody id="rows">
                    <tr><td colspan="3" class="empty">Cargando inventario...</td></tr>
                  </tbody>
                </table>
                <div class="table-tail">
                  <div id="loadMoreStatus" class="load-more-status" aria-live="polite"></div>
                  <div id="scrollSentinel" class="scroll-sentinel" aria-hidden="true"></div>
                </div>
              </div>
          </div>
        </section>
      </section>
    </main>

    <script>
      const HOUSE_OPTIONS = ${JSON.stringify(INVENTORY_HOUSE_OPTIONS)};
      const HOUSE_LABELS = ${JSON.stringify(INVENTORY_HOUSE_LABELS)};

      const state = {
        search: '',
        house: '',
        priceOrder: '',
        vehicleBrand: '',
      };

      const rows = document.getElementById('rows');
      const search = document.getElementById('search');
      const houseFilter = document.getElementById('houseFilter');
      const priceOrderFilter = document.getElementById('priceOrderFilter');
      const vehicleBrandFilter = document.getElementById('vehicleBrandFilter');
      const loader = document.getElementById('loader');
      const loadMoreStatus = document.getElementById('loadMoreStatus');
      const scrollSentinel = document.getElementById('scrollSentinel');
      const tableWrap = document.querySelector('.table-wrap');

      const PAGE_SIZE = 200;
      const SEARCH_DEBOUNCE_MS = 500;

      const inventory = {
        offset: 0,
        total: 0,
        hasMore: true,
        loading: false,
        requestId: 0,
      };

      let searchTimer;
      let inFlightController;
      let scrollObserver;
      let vehicleBrandRequestId = 0;

      search.addEventListener('input', () => {
        state.search = search.value;
        // La búsqueda cambia el universo de marcas disponibles.
        state.vehicleBrand = '';
        vehicleBrandFilter.value = '';
        queueLoadInventory();
      });
      houseFilter.addEventListener('change', () => {
        state.house = houseFilter.value;
        // La marca seleccionada pertenece al universo de la casa anterior.
        state.vehicleBrand = '';
        vehicleBrandFilter.value = '';
        resetAndLoadInventory();
      });
      priceOrderFilter.addEventListener('change', () => {
        state.priceOrder = priceOrderFilter.value;
        resetAndLoadInventory();
      });
      vehicleBrandFilter.addEventListener('change', () => {
        state.vehicleBrand = vehicleBrandFilter.value;
        resetAndLoadInventory();
      });

      function queueLoadInventory() {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(resetAndLoadInventory, SEARCH_DEBOUNCE_MS);
      }

      function setLoadMoreStatus(text = '') {
        loadMoreStatus.textContent = text;
        loadMoreStatus.hidden = !text;
      }

      function showLoader() {
        loader.classList.add('is-visible');
        rows.innerHTML = renderSkeletonRows();
      }

      function hideLoader() {
        loader.classList.remove('is-visible');
      }

      function escapeHtml(value) {
        return String(value ?? '')
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
          .replaceAll('"', '&quot;')
          .replaceAll("'", '&#39;');
      }

      function escapeAttr(value) {
        return escapeHtml(value).replaceAll(String.fromCharCode(96), '&#96;');
      }

      function normalizeHouseLabel(site) {
        try {
          const hostname = new URL(site).hostname.replace(/^www\./, '').toLowerCase();
          return HOUSE_LABELS[hostname] ?? hostname;
        } catch {
          const hostname = String(site ?? '').trim().toLowerCase().replace(/^www\./, '');
          return HOUSE_LABELS[hostname] ?? (hostname || '-');
        }
      }

      function renderHouseOptions() {
        const current = houseFilter.value;
        houseFilter.innerHTML = '<option value="">Todas las casas</option>' + HOUSE_OPTIONS.map((item) => '<option value="' + escapeHtml(item.id) + '">' + escapeHtml(item.label) + '</option>').join('');
        houseFilter.value = current;
      }

      async function renderVehicleBrandOptions() {
        const current = vehicleBrandFilter.value;
        const requestId = ++vehicleBrandRequestId;
        const params = new URLSearchParams();
        if (state.house) params.set('site', state.house);
        if (state.search.trim()) params.set('search', state.search.trim());
        try {
          const response = await fetch('/scraping/inventory/vehicle-brands?' + params.toString());
          if (!response.ok) throw new Error('No se pudieron cargar las marcas');
          const brands = await response.json();
          if (requestId !== vehicleBrandRequestId) return;
          vehicleBrandFilter.innerHTML = '<option value="">Todas las marcas</option>' + brands.map((item) => {
            const label = item.total ? item.label + ' (' + item.total + ')' : item.label;
            return '<option value="' + escapeHtml(item.id) + '">' + escapeHtml(label) + '</option>';
          }).join('');
          vehicleBrandFilter.value = brands.some((item) => item.id === current) ? current : '';
        } catch {
          if (requestId !== vehicleBrandRequestId) return;
          vehicleBrandFilter.innerHTML = '<option value="">Todas las marcas</option>';
        }
      }

      function formatPrice(value) {
        const text = String(value ?? '').trim();
        if (!text || text === '-') {
          return '-';
        }

        return '$ ' + text;
      }

      function renderRows(products) {
        if (!products.length) {
          return '<tr><td colspan="3" class="empty">No hay productos para mostrar</td></tr>';
        }

        return products.map((product) => {
          const productName = escapeHtml(product.productName || 'Sin nombre');
          const url = product.sourceUrl
            ? '<a class="product-title" href="' + escapeAttr(product.sourceUrl) + '" target="_blank" rel="noreferrer">' + productName + '</a>'
            : '<span class="product-title">' + productName + '</span>';
          const vehicleBrands = Array.isArray(product.compatibleBrands) && product.compatibleBrands.length
            ? '<div class="muted">' + escapeHtml(product.compatibleBrands.join(', ')) + '</div>'
            : '';
          const vehicleModels = Array.isArray(product.compatibleModels) && product.compatibleModels.length
            ? '<div class="muted">Modelos: ' + escapeHtml(product.compatibleModels.join(', ')) + '</div>'
            : '';
          const vehicleVersions = Array.isArray(product.compatibleVersions) && product.compatibleVersions.length
            ? '<div class="muted">Versiones: ' + escapeHtml(product.compatibleVersions.join(', ')) + '</div>'
            : '';
          return '<tr>' +
            '<td><div class="product-cell">' + url + (product.brand ? '<div class="muted">' + escapeHtml(product.brand) + '</div>' : '') + vehicleBrands + vehicleModels + vehicleVersions + '</div></td>' +
            '<td class="right"><span class="price-label">' + escapeHtml(formatPrice(product.price)) + '</span></td>' +
            '<td>' + escapeHtml(normalizeHouseLabel(product.site || '-')) + '</td>' +
          '</tr>';
        }).join('');
      }

      function renderSkeletonRows() {
        return Array.from({ length: 9 }).map(() => (
          '<tr>' +
            '<td><div class="skeleton name"></div><div class="skeleton sub"></div></td>' +
            '<td class="right"><div class="skeleton price"></div></td>' +
            '<td><div class="skeleton small"></div></td>' +
          '</tr>'
        )).join('');
      }

      function buildParams() {
        const params = new URLSearchParams();
        if (state.house) params.set('site', state.house);
        if (state.search.trim()) params.set('search', state.search.trim());
        if (state.priceOrder) params.set('priceOrder', state.priceOrder);
        if (state.vehicleBrand) params.set('vehicleBrand', state.vehicleBrand);
        params.set('limit', String(PAGE_SIZE));
        params.set('offset', String(inventory.offset));
        return params;
      }

      function setScrollObserverEnabled(enabled) {
        if (!scrollObserver && enabled) {
          scrollObserver = new IntersectionObserver((entries) => {
            if (entries.some((entry) => entry.isIntersecting)) {
              loadNextPage();
            }
          }, {
            root: tableWrap,
            rootMargin: '320px 0px',
            threshold: 0,
          });
        }

        if (!scrollObserver) {
          return;
        }

        scrollObserver.disconnect();
        if (enabled) {
          scrollObserver.observe(scrollSentinel);
        }
      }

      function abortPendingRequest() {
        if (inFlightController) {
          inFlightController.abort();
          inFlightController = undefined;
        }
      }

      function resetInventoryState() {
        inventory.offset = 0;
        inventory.total = 0;
        inventory.hasMore = true;
        setLoadMoreStatus('');
      }

      function resetAndLoadInventory() {
        clearTimeout(searchTimer);
        abortPendingRequest();
        resetInventoryState();
        void renderVehicleBrandOptions();
        rows.innerHTML = renderSkeletonRows();
        setScrollObserverEnabled(false);
        void loadNextPage(true);
      }

      async function loadNextPage(isReset = false) {
        if (inventory.loading || (!inventory.hasMore && !isReset)) {
          return;
        }

        inventory.loading = true;
        const requestId = ++inventory.requestId;
        const currentOffset = inventory.offset;

        if (isReset) {
          showLoader();
        } else {
          setLoadMoreStatus('Cargando mas productos...');
        }

        try {
          inFlightController = new AbortController();
          const response = await fetch('/scraping/inventory?' + buildParams().toString(), {
            signal: inFlightController.signal,
          });
          if (!response.ok) throw new Error('No se pudo leer el inventario');
          const data = await response.json();
          const products = Array.isArray(data.products) ? data.products : [];
          renderHouseOptions();

          if (requestId !== inventory.requestId) {
            return;
          }

          inventory.total = Number(data.total ?? inventory.total ?? 0);

          if (isReset || currentOffset === 0) {
            rows.innerHTML = '';
          }

          if (!products.length && currentOffset === 0) {
            rows.innerHTML = renderRows([]);
            inventory.offset = 0;
            inventory.hasMore = false;
            setLoadMoreStatus('');
            setScrollObserverEnabled(false);
            return;
          } else if (products.length) {
            rows.insertAdjacentHTML('beforeend', renderRows(products));
          }

          inventory.offset = currentOffset + products.length;
          inventory.hasMore = Boolean(data.hasMore ?? (products.length === PAGE_SIZE && inventory.offset < inventory.total));

          if (!products.length && currentOffset > 0) {
            inventory.hasMore = false;
          }

          if (inventory.hasMore) {
            setLoadMoreStatus('Desliza para cargar mas...');
            setScrollObserverEnabled(true);
          } else if (currentOffset > 0 && inventory.offset > 0) {
            setLoadMoreStatus('No hay mas productos para mostrar.');
            setScrollObserverEnabled(false);
          } else {
            setLoadMoreStatus('');
            setScrollObserverEnabled(false);
          }
        } catch (error) {
          if ((error && error.name) === 'AbortError') {
            return;
          }
          rows.innerHTML = '<tr><td colspan="3" class="empty">' + escapeHtml(error.message || 'Error al cargar inventario') + '</td></tr>';
          setLoadMoreStatus('');
        } finally {
          if (requestId === inventory.requestId) {
            hideLoader();
          }
          inventory.loading = false;
          inFlightController = undefined;
        }
      }

      renderHouseOptions();
      resetAndLoadInventory();
    </script>
  </body>
</html>`;
}

export function resolveCatalogSites(requestedUrls?: string[], excludeSites?: string): string[] {
  const sites = requestedUrls?.length ? requestedUrls : [...DEFAULT_CATALOG_SITES];
  const excludedSites = parseExcludedSites(excludeSites);

  if (!excludedSites.size) {
    return sites;
  }

  return sites.filter((siteUrl) => !isExcludedCatalogSite(siteUrl, excludedSites));
}

function parseExcludedSites(value?: string): Set<string> {
  return new Set(
    (value ?? '')
      .split(/[,\s]+/g)
      .map((entry) => normalizeSiteToken(entry))
      .filter(Boolean),
  );
}

function isExcludedCatalogSite(siteUrl: string, excludedSites: Set<string>): boolean {
  try {
    const rule = findDomainRule(siteUrl);
    const hostname = tryGetHostname(siteUrl);
    if (!hostname) {
      return false;
    }

    const aliases = new Set(
      [
        hostname,
        rule?.id,
        INVENTORY_HOUSE_LABELS[hostname]?.toLowerCase(),
      ].filter((value): value is string => Boolean(value)),
    );

    return Array.from(aliases).some((alias) => excludedSites.has(normalizeSiteToken(alias)));
  } catch {
    return false;
  }
}

function normalizeSiteToken(value: string): string {
  return value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
}

function renderStatsPage(): string {
  return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="dark" />
    <title>Estadisticas del inventario</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600;9..144,700&family=Manrope:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
    <style>
      :root {
        --panel: rgba(15, 17, 24, 0.92);
        --panel-strong: #10141d;
        --line: rgba(255, 255, 255, 0.08);
        --line-strong: rgba(255, 255, 255, 0.12);
        --text: #f6f1ea;
        --muted: rgba(246, 241, 234, 0.72);
        --accent: #f2b84b;
        --accent-2: #7fd7c4;
        --shadow: 0 28px 90px rgba(0, 0, 0, 0.52);
      }

      * { box-sizing: border-box; }
      html, body { margin: 0; min-height: 100%; }
      body {
        font-family: 'Manrope', system-ui, sans-serif;
        color: var(--text);
        background:
          radial-gradient(circle at 20% 10%, rgba(242, 184, 75, 0.18), transparent 28%),
          radial-gradient(circle at 85% 15%, rgba(127, 215, 196, 0.14), transparent 25%),
          linear-gradient(160deg, #050609 0%, #080b12 56%, #0d111a 100%);
        overflow-x: hidden;
      }
      .shell { min-height: 100vh; padding: 24px; }
      .panel {
        width: 100%;
        max-width: 1180px;
        margin: 0 auto;
        border: 1px solid var(--line);
        border-radius: 26px;
        overflow: hidden;
        box-shadow: var(--shadow);
        background: linear-gradient(180deg, rgba(16, 20, 28, 0.96), rgba(8, 10, 15, 0.96));
      }
      .topbar {
        padding: 16px 20px 12px;
        border-bottom: 1px solid var(--line);
      }
      .title-row {
        display: flex;
        gap: 16px;
        align-items: end;
        justify-content: space-between;
        flex-wrap: wrap;
      }
      .nav-links {
        display: flex;
        gap: 10px;
        align-items: center;
        flex-wrap: wrap;
      }
      .nav-link {
        color: var(--text);
        text-decoration: none;
        border: 1px solid var(--line-strong);
        background: rgba(255,255,255,0.03);
        padding: 10px 14px;
        border-radius: 999px;
        font-size: 0.92rem;
        font-weight: 700;
      }
      .nav-link:hover {
        border-color: rgba(242,184,75,0.55);
        background: rgba(242,184,75,0.1);
      }
      h1 {
        margin: 0;
        font-family: 'Fraunces', Georgia, serif;
        font-size: clamp(1.8rem, 3vw, 2.8rem);
        letter-spacing: -0.05em;
        line-height: 0.95;
      }
      .subtitle {
        margin: 8px 0 0;
        color: var(--muted);
        max-width: 72ch;
      }
      .main { padding: 14px; display: grid; gap: 14px; }
      .summary-grid {
        display: grid;
        gap: 14px;
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .card {
        border: 1px solid var(--line);
        background: var(--panel);
        border-radius: 20px;
        padding: 16px;
      }
      .metric-label {
        color: var(--muted);
        text-transform: uppercase;
        letter-spacing: 0.12em;
        font-size: 0.74rem;
      }
      .metric-value {
        margin-top: 8px;
        font-family: 'Fraunces', Georgia, serif;
        font-size: clamp(2rem, 6vw, 3.8rem);
        letter-spacing: -0.06em;
      }
      .metric-note {
        margin-top: 6px;
        color: var(--muted);
      }
      .site-list { display: grid; gap: 10px; }
      .site-item {
        display: grid;
        gap: 8px;
        grid-template-columns: minmax(0, 1fr) auto;
        align-items: center;
        padding: 14px 0;
        border-bottom: 1px solid rgba(255,255,255,0.06);
      }
      .site-item:last-child { border-bottom: 0; padding-bottom: 0; }
      .site-name { font-weight: 700; word-break: break-word; }
      .site-count { color: var(--accent); font-weight: 800; white-space: nowrap; }
      .bar {
        grid-column: 1 / -1;
        height: 8px;
        border-radius: 999px;
        background: rgba(255,255,255,0.06);
        overflow: hidden;
      }
      .bar > span {
        display: block;
        height: 100%;
        border-radius: inherit;
        background: linear-gradient(90deg, var(--accent), var(--accent-2));
      }
      .empty { padding: 24px 0 4px; color: var(--muted); }
      .status { color: var(--muted); font-size: 0.95rem; }
      .status.error { color: #ff8b7a; }
      code {
        background: rgba(255,255,255,0.06);
        padding: 0.18rem 0.35rem;
        border-radius: 6px;
      }
      @media (max-width: 820px) {
        .summary-grid { grid-template-columns: 1fr; }
      }
      @media (max-width: 640px) {
        .shell { padding: 12px; }
        .main { padding: 10px; }
        .site-item { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <section class="panel">
        <header class="topbar">
          <div class="title-row">
            <div>
              <h1>Estadisticas del inventario</h1>
              <p class="subtitle">Resumen rapido del total cargado y el corte por sitio. La pagina lee los datos desde <code>/stats/data</code>.</p>
            </div>
            <nav class="nav-links" aria-label="Navegacion principal">
              <a class="nav-link" href="/">Inventario</a>
              <a class="nav-link" href="/stats/data" target="_blank" rel="noreferrer">JSON</a>
            </nav>
          </div>
        </header>

        <section class="main">
          <section class="summary-grid">
            <article class="card">
              <div class="metric-label">Total inventario</div>
              <div id="totalValue" class="metric-value">-</div>
              <div class="metric-note">Productos persistidos en la base.</div>
            </article>
            <article class="card">
              <div class="metric-label">Sitios</div>
              <div id="siteCountValue" class="metric-value">-</div>
              <div class="metric-note">Cantidad de casas con productos cargados.</div>
            </article>
          </section>

          <section class="card">
            <div class="metric-label">Desglose por sitio</div>
            <div id="status" class="status">Cargando estadisticas...</div>
            <div id="siteList" class="site-list"></div>
          </section>
        </section>
      </section>
    </main>

    <script>
      const totalValue = document.getElementById('totalValue');
      const siteCountValue = document.getElementById('siteCountValue');
      const status = document.getElementById('status');
      const siteList = document.getElementById('siteList');
      const numberFormat = new Intl.NumberFormat('es-UY');

      function escapeHtml(value) {
        return String(value ?? '')
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
          .replaceAll('"', '&quot;')
          .replaceAll("'", '&#39;');
      }

      function normalizeSiteLabel(site) {
        const value = String(site ?? '').toLowerCase();
        if (value.includes('feyvi')) return 'Feyvi';
        if (value.includes('chaparei')) return 'Chaparei';
        if (value.includes('taxitor')) return 'Taxitor';
        if (value.includes('acesur')) return 'Acesur';
        if (value.includes('selvir')) return 'Selvir';
        if (value.includes('europarts')) return 'Europarts';
        try {
          return new URL(site).hostname.replace(/^www\\./, '');
        } catch {
          return String(site ?? '-');
        }
      }

      function renderStats(data) {
        const total = Number(data?.total ?? 0);
        const bySite = Array.isArray(data?.bySite) ? data.bySite : [];
        totalValue.textContent = numberFormat.format(total);
        siteCountValue.textContent = numberFormat.format(bySite.length);

        if (!bySite.length) {
          siteList.innerHTML = '<div class="empty">No hay datos cargados todavia.</div>';
          status.textContent = 'Sin resultados.';
          return;
        }

        const max = Math.max(...bySite.map((item) => Number(item?.total ?? 0)), 1);
        siteList.innerHTML = bySite.map((item) => {
          const site = item?.siteLabel || normalizeSiteLabel(item?.site);
          const count = Number(item?.total ?? 0);
          const width = Math.max(4, Math.round((count / max) * 100));
          return '<div class="site-item">' +
            '<div class="site-name">' + escapeHtml(site) + '</div>' +
            '<div class="site-count">' + escapeHtml(numberFormat.format(count)) + '</div>' +
            '<div class="bar" aria-hidden="true"><span style="width:' + width + '%"></span></div>' +
          '</div>';
        }).join('');
        status.textContent = 'Datos actualizados desde la base local.';
      }

      async function loadStats() {
        try {
          const response = await fetch('/stats/data');
          if (!response.ok) {
            throw new Error('No se pudieron leer las estadisticas');
          }
          const data = await response.json();
          renderStats(data);
        } catch (error) {
          status.textContent = error.message || 'Error al cargar estadisticas';
          status.classList.add('error');
          siteList.innerHTML = '';
          totalValue.textContent = '-';
          siteCountValue.textContent = '-';
        }
      }

      void loadStats();
    </script>
  </body>
</html>`;
}
