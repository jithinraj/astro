import type {
	ComponentInstance,
	RewritePayload,
	RouteData,
	SSRLoadedRenderer,
	SSRResult,
} from '../../@types/astro.js';
import { getOutputDirectory } from '../../prerender/utils.js';
import { BEFORE_HYDRATION_SCRIPT_ID, PAGE_SCRIPT_ID } from '../../vite-plugin-scripts/index.js';
import type { SSRManifest } from '../app/types.js';
import { InvalidRewrite404, RewriteEncounteredAnError } from '../errors/errors-data.js';
import { AstroError } from '../errors/index.js';
import { routeIsFallback, routeIsRedirect } from '../redirects/helpers.js';
import { RedirectSinglePageBuiltModule } from '../redirects/index.js';
import { Pipeline } from '../render/index.js';
import {
	createAssetLink,
	createModuleScriptsSet,
	createStylesheetElementSet,
} from '../render/ssr-element.js';
import { DEFAULT_404_ROUTE } from '../routing/astro-designed-error-pages.js';
import { isServerLikeOutput } from '../util.js';
import { getOutDirWithinCwd } from './common.js';
import { type BuildInternals, cssOrder, getPageData, mergeInlineCss } from './internal.js';
import { ASTRO_PAGE_MODULE_ID, ASTRO_PAGE_RESOLVED_MODULE_ID } from './plugins/plugin-pages.js';
import { RESOLVED_SPLIT_MODULE_ID } from './plugins/plugin-ssr.js';
import { getPagesFromVirtualModulePageName, getVirtualModulePageName } from './plugins/util.js';
import type { PageBuildData, SinglePageBuiltModule, StaticBuildOptions } from './types.js';
import { i18nHasFallback } from './util.js';

/**
 * The build pipeline is responsible to gather the files emitted by the SSR build and generate the pages by executing these files.
 */
export class BuildPipeline extends Pipeline {
	#componentsInterner: WeakMap<RouteData, SinglePageBuiltModule> = new WeakMap<
		RouteData,
		SinglePageBuiltModule
	>();
	/**
	 * This cache is needed to map a single `RouteData` to its file path.
	 * @private
	 */
	#routesByFilePath: WeakMap<RouteData, string> = new WeakMap<RouteData, string>();

	get outFolder() {
		const ssr = isServerLikeOutput(this.settings.config);
		return ssr
			? this.settings.config.build.server
			: getOutDirWithinCwd(this.settings.config.outDir);
	}

	private constructor(
		readonly internals: BuildInternals,
		readonly manifest: SSRManifest,
		readonly options: StaticBuildOptions,
		readonly config = options.settings.config,
		readonly settings = options.settings
	) {
		const resolveCache = new Map<string, string>();
		async function resolve(specifier: string) {
			if (resolveCache.has(specifier)) {
				return resolveCache.get(specifier)!;
			}
			const hashedFilePath = manifest.entryModules[specifier];
			if (typeof hashedFilePath !== 'string' || hashedFilePath === '') {
				// If no "astro:scripts/before-hydration.js" script exists in the build,
				// then we can assume that no before-hydration scripts are needed.
				if (specifier === BEFORE_HYDRATION_SCRIPT_ID) {
					resolveCache.set(specifier, '');
					return '';
				}
				throw new Error(`Cannot find the built path for ${specifier}`);
			}
			const assetLink = createAssetLink(hashedFilePath, manifest.base, manifest.assetsPrefix);
			resolveCache.set(specifier, assetLink);
			return assetLink;
		}
		const serverLike = isServerLikeOutput(config);
		// We can skip streaming in SSG for performance as writing as strings are faster
		const streaming = serverLike;
		super(
			options.logger,
			manifest,
			options.mode,
			manifest.renderers,
			resolve,
			serverLike,
			streaming
		);
	}

	static create({
		internals,
		manifest,
		options,
	}: Pick<BuildPipeline, 'internals' | 'manifest' | 'options'>) {
		return new BuildPipeline(internals, manifest, options);
	}

	/**
	 * The SSR build emits two important files:
	 * - dist/server/manifest.mjs
	 * - dist/renderers.mjs
	 *
	 * These two files, put together, will be used to generate the pages.
	 *
	 * ## Errors
	 *
	 * It will throw errors if the previous files can't be found in the file system.
	 *
	 * @param staticBuildOptions
	 */
	static async retrieveManifest(
		staticBuildOptions: StaticBuildOptions,
		internals: BuildInternals
	): Promise<SSRManifest> {
		const config = staticBuildOptions.settings.config;
		const baseDirectory = getOutputDirectory(config);
		const manifestEntryUrl = new URL(
			`${internals.manifestFileName}?time=${Date.now()}`,
			baseDirectory
		);
		const { manifest } = await import(manifestEntryUrl.toString());
		if (!manifest) {
			throw new Error(
				"Astro couldn't find the emitted manifest. This is an internal error, please file an issue."
			);
		}

		const renderersEntryUrl = new URL(`renderers.mjs?time=${Date.now()}`, baseDirectory);
		const renderers = await import(renderersEntryUrl.toString());

		const middleware = await import(new URL('middleware.mjs', baseDirectory).toString())
			.then((mod) => mod.onRequest)
			// middleware.mjs is not emitted if there is no user middleware
			// in which case the import fails with ERR_MODULE_NOT_FOUND, and we fall back to a no-op middleware
			.catch(() => manifest.middleware);

		if (!renderers) {
			throw new Error(
				"Astro couldn't find the emitted renderers. This is an internal error, please file an issue."
			);
		}
		return {
			...manifest,
			renderers: renderers.renderers as SSRLoadedRenderer[],
			middleware,
		};
	}

	headElements(routeData: RouteData): Pick<SSRResult, 'scripts' | 'styles' | 'links'> {
		const {
			internals,
			manifest: { assetsPrefix, base },
			settings,
		} = this;
		const links = new Set<never>();
		const pageBuildData = getPageData(internals, routeData.route, routeData.component);
		const scripts = createModuleScriptsSet(
			pageBuildData?.hoistedScript ? [pageBuildData.hoistedScript] : [],
			base,
			assetsPrefix
		);
		const sortedCssAssets = pageBuildData?.styles
			.sort(cssOrder)
			.map(({ sheet }) => sheet)
			.reduce(mergeInlineCss, []);
		const styles = createStylesheetElementSet(sortedCssAssets ?? [], base, assetsPrefix);

		if (settings.scripts.some((script) => script.stage === 'page')) {
			const hashedFilePath = internals.entrySpecifierToBundleMap.get(PAGE_SCRIPT_ID);
			if (typeof hashedFilePath !== 'string') {
				throw new Error(`Cannot find the built path for ${PAGE_SCRIPT_ID}`);
			}
			const src = createAssetLink(hashedFilePath, base, assetsPrefix);
			scripts.add({
				props: { type: 'module', src },
				children: '',
			});
		}

		// Add all injected scripts to the page.
		for (const script of settings.scripts) {
			if (script.stage === 'head-inline') {
				scripts.add({
					props: {},
					children: script.content,
				});
			}
		}
		return { scripts, styles, links };
	}

	componentMetadata() {}

	/**
	 * It collects the routes to generate during the build.
	 * It returns a map of page information and their relative entry point as a string.
	 */
	retrieveRoutesToGenerate(): Map<PageBuildData, string> {
		const pages = new Map<PageBuildData, string>();

		for (const [virtualModulePageName, filePath] of this.internals.entrySpecifierToBundleMap) {
			// virtual pages can be emitted with different prefixes:
			// - the classic way are pages emitted with prefix ASTRO_PAGE_RESOLVED_MODULE_ID -> plugin-pages
			// - pages emitted using `functionPerRoute`, in this case pages are emitted with prefix RESOLVED_SPLIT_MODULE_ID
			if (
				virtualModulePageName.includes(ASTRO_PAGE_RESOLVED_MODULE_ID) ||
				virtualModulePageName.includes(RESOLVED_SPLIT_MODULE_ID)
			) {
				let pageDatas: PageBuildData[] = [];
				if (virtualModulePageName.includes(ASTRO_PAGE_RESOLVED_MODULE_ID)) {
					pageDatas.push(
						...getPagesFromVirtualModulePageName(
							this.internals,
							ASTRO_PAGE_RESOLVED_MODULE_ID,
							virtualModulePageName
						)
					);
				}
				if (virtualModulePageName.includes(RESOLVED_SPLIT_MODULE_ID)) {
					pageDatas.push(
						...getPagesFromVirtualModulePageName(
							this.internals,
							RESOLVED_SPLIT_MODULE_ID,
							virtualModulePageName
						)
					);
				}
				for (const pageData of pageDatas) {
					pages.set(pageData, filePath);
				}
			}
		}

		for (const pageData of this.internals.pagesByKeys.values()) {
			if (routeIsRedirect(pageData.route)) {
				pages.set(pageData, pageData.component);
			} else if (
				routeIsFallback(pageData.route) &&
				(i18nHasFallback(this.config) ||
					(routeIsFallback(pageData.route) && pageData.route.route === '/'))
			) {
				// The original component is transformed during the first build, so we have to retrieve
				// the actual `.mjs` that was created.
				// During the build, we transform the names of our pages with some weird name, and those weird names become the keys of a map.
				// The values of the map are the actual `.mjs` files that are generated during the build

				// Here, we take the component path and transform it in the virtual module name
				const moduleSpecifier = getVirtualModulePageName(ASTRO_PAGE_MODULE_ID, pageData.component);
				// We retrieve the original JS module
				const filePath = this.internals.entrySpecifierToBundleMap.get(moduleSpecifier);
				if (filePath) {
					// it exists, added it to pages to render, using the file path that we just retrieved
					pages.set(pageData, filePath);
				}
			}
		}

		for (const [buildData, filePath] of pages.entries()) {
			this.#routesByFilePath.set(buildData.route, filePath);
		}

		return pages;
	}

	async getComponentByRoute(routeData: RouteData): Promise<ComponentInstance> {
		if (this.#componentsInterner.has(routeData)) {
			// SAFETY: checked before
			const entry = this.#componentsInterner.get(routeData)!;
			return await entry.page();
		} else {
			// SAFETY: the pipeline calls `retrieveRoutesToGenerate`, which is in charge to fill the cache.
			const filePath = this.#routesByFilePath.get(routeData)!;
			const module = await this.retrieveSsrEntry(routeData, filePath);
			return module.page();
		}
	}

	async tryRewrite(
		payload: RewritePayload,
		request: Request,
		sourceRoute: RouteData
	): Promise<[RouteData, ComponentInstance]> {
		let foundRoute: RouteData | undefined;
		// options.manifest is the actual type that contains the information
		for (const route of this.options.manifest.routes) {
			let finalUrl: URL | undefined = undefined;

			if (payload instanceof URL) {
				finalUrl = payload;
			} else if (payload instanceof Request) {
				finalUrl = new URL(payload.url);
			} else {
				finalUrl = new URL(payload, new URL(request.url).origin);
			}

			if (route.pattern.test(decodeURI(finalUrl.pathname))) {
				foundRoute = route;
				break;
			} else if (finalUrl.pathname === '/404') {
				foundRoute = DEFAULT_404_ROUTE;
				break;
			}
		}
		if (foundRoute) {
			if (foundRoute.pathname === '/404') {
				const componentInstance = await this.rewriteKnownRoute(foundRoute.pathname, sourceRoute);
				return [foundRoute, componentInstance];
			} else {
				const componentInstance = await this.getComponentByRoute(foundRoute);
				return [foundRoute, componentInstance];
			}
		} else {
			throw new AstroError({
				...RewriteEncounteredAnError,
				message: RewriteEncounteredAnError.message(payload.toString()),
			});
		}
	}

	async retrieveSsrEntry(route: RouteData, filePath: string): Promise<SinglePageBuiltModule> {
		if (this.#componentsInterner.has(route)) {
			// SAFETY: it is checked inside the if
			return this.#componentsInterner.get(route)!;
		}
		let entry;
		if (routeIsRedirect(route)) {
			entry = await this.#getEntryForRedirectRoute(route, this.internals, this.outFolder);
		} else if (routeIsFallback(route)) {
			entry = await this.#getEntryForFallbackRoute(route, this.internals, this.outFolder);
		} else {
			const ssrEntryURLPage = createEntryURL(filePath, this.outFolder);
			entry = await import(ssrEntryURLPage.toString());
		}
		this.#componentsInterner.set(route, entry);
		return entry;
	}

	async #getEntryForFallbackRoute(
		route: RouteData,
		internals: BuildInternals,
		outFolder: URL
	): Promise<SinglePageBuiltModule> {
		if (route.type !== 'fallback') {
			throw new Error(`Expected a redirect route.`);
		}
		if (route.redirectRoute) {
			const filePath = getEntryFilePath(this.internals, route.redirectRoute);
			if (filePath) {
				const url = createEntryURL(filePath, outFolder);
				const ssrEntryPage: SinglePageBuiltModule = await import(url.toString());
				return ssrEntryPage;
			}
		}

		return RedirectSinglePageBuiltModule;
	}

	async #getEntryForRedirectRoute(
		route: RouteData,
		internals: BuildInternals,
		outFolder: URL
	): Promise<SinglePageBuiltModule> {
		if (route.type !== 'redirect') {
			throw new Error(`Expected a redirect route.`);
		}
		if (route.redirectRoute) {
			const filePath = getEntryFilePath(this.internals, route.redirectRoute);
			if (filePath) {
				const url = createEntryURL(filePath, outFolder);
				const ssrEntryPage: SinglePageBuiltModule = await import(url.toString());
				return ssrEntryPage;
			}
		}

		return RedirectSinglePageBuiltModule;
	}

	rewriteKnownRoute(_pathname: string, sourceRoute: RouteData): ComponentInstance {
		if (!isServerLikeOutput(this.config) || sourceRoute.prerender) {
			throw new AstroError(InvalidRewrite404);
		}
		throw new Error(`Unreachable, in SSG this route shouldn't be generated`);
	}
}

function createEntryURL(filePath: string, outFolder: URL) {
	return new URL('./' + filePath + `?time=${Date.now()}`, outFolder);
}

/**
 * For a given pageData, returns the entry file path—aka a resolved virtual module in our internals' specifiers.
 */
function getEntryFilePath(internals: BuildInternals, pageData: RouteData) {
	const id = '\x00' + getVirtualModulePageName(ASTRO_PAGE_MODULE_ID, pageData.component);
	return internals.entrySpecifierToBundleMap.get(id);
}
