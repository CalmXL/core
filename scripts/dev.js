// @ts-check

// Using esbuild for faster dev builds.
// 采用 esbuild 来加快开发阶段的构建速度。
// We are still using Rollup for production builds because it generates
// smaller files and provides better tree-shaking.
// 我们再生产阶段仍然使用 rollup 打包，因为其生成的文件更小并且支持更好的 tree-shaking

import esbuild from 'esbuild'
import fs from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { parseArgs } from 'node:util'
import { polyfillNode } from 'esbuild-plugin-polyfill-node'

/**
 * import.meta ES Module 中的一种特殊对象，用于提供模块本身相关的元数据。
 *  url: 获取当前模块的 URL。浏览器环境中这会当前模块的绝对 URL 地址，而在 node 环境中，会提供当前模块的文件路径。
 */
// import.meta.url // => file:///Users/xulei/core/scripts/dev.js
const require = createRequire(import.meta.url)

/**
 * fileURLToPath：
 *    用于将文件 URL 转换为文件路径。他通常用于将 file:// 开头的 URL 转换为本地文件路径。
 *
 * dirname: 获取当前文件所在目录的路径
 */

// fileURLToPath => /Users/xulei/core/scripts/dev.js
// dirname => /Users/xulei/core/scripts
const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * paresArgs: Nodejs 19 版本中引入，用于简化命令行参数。
 *  params:
 *    allowPositionals: 用于控制是否允许接卸位置参数，即没有指定选项名称的参数。
 *    options: 定义命令行选项，并未每个选项指定类型短选项、默认值等。
 *
 * return:
 *    values: 包含解析后的选项参数，通过 options 定义的
 *    positionals: 位置参数的数组
 */
const {
  values: { format: rawFormat, prod, inline: inlineDeps },
  positionals,
} = parseArgs({
  allowPositionals: true,
  options: {
    format: {
      type: 'string',
      short: 'f',
      default: 'global',
    },
    prod: {
      type: 'boolean',
      short: 'p',
      default: false,
    },
    inline: {
      type: 'boolean',
      short: 'i',
      default: false,
    },
  },
})

const format = rawFormat || 'global'
const targets = positionals.length ? positionals : ['vue']

// resolve output
const outputFormat = format.startsWith('global')
  ? 'iife'
  : format === 'cjs'
    ? 'cjs'
    : 'esm'

const postfix = format.endsWith('-runtime')
  ? `runtime.${format.replace(/-runtime$/, '')}`
  : format

const privatePackages = fs.readdirSync('packages-private')

for (const target of targets) {
  const pkgBase = privatePackages.includes(target)
    ? `packages-private`
    : `packages`
  const pkgBasePath = `../${pkgBase}/${target}`
  const pkg = require(`${pkgBasePath}/package.json`)
  const outfile = resolve(
    __dirname,
    `${pkgBasePath}/dist/${
      target === 'vue-compat' ? `vue` : target
    }.${postfix}.${prod ? `prod.` : ``}js`,
  ) // 定义输出的文件路径

  /**
   *  relative: 计算 参数之间的相对路径
   *    process.cwd(): 返回当前进程的工作目录: /Users/xulei/core
   *    outfile:  '/Users/xulei/core/packages/vue/dist/vue.global.js'
   *    relativeOutfile: 'packages/vue/dist/vue.global.js'
   */
  const relativeOutfile = relative(process.cwd(), outfile)

  // resolve externals 解析拓展
  // TODO this logic is largely duplicated from rollup.config.js
  /** @type {string[]} */
  let external = []
  if (!inlineDeps) {
    // cjs & esm-bundler: external all deps
    if (format === 'cjs' || format.includes('esm-bundler')) {
      external = [
        ...external,
        ...Object.keys(pkg.dependencies || {}),
        ...Object.keys(pkg.peerDependencies || {}),
        // for @vue/compiler-sfc / server-renderer
        'path',
        'url',
        'stream',
      ]
    }

    if (target === 'compiler-sfc') {
      const consolidatePkgPath = require.resolve(
        '@vue/consolidate/package.json',
        {
          paths: [resolve(__dirname, `../packages/${target}/`)],
        },
      )
      const consolidateDeps = Object.keys(
        require(consolidatePkgPath).devDependencies,
      )
      external = [
        ...external,
        ...consolidateDeps,
        'fs',
        'vm',
        'crypto',
        'react-dom/server',
        'teacup/lib/express',
        'arc-templates/dist/es5',
        'then-pug',
        'then-jade',
      ]
    }
  }
  /** @type {Array<import('esbuild').Plugin>} */
  const plugins = [
    {
      name: 'log-rebuild',
      setup(build) {
        build.onEnd(() => {
          console.log(`built: ${relativeOutfile}`)
        })
      },
    },
  ]

  if (format !== 'cjs' && pkg.buildOptions?.enableNonBrowserBranches) {
    plugins.push(polyfillNode())
  }

  /**
   * esbuild.context: 用于设置构建的上下文，更灵活的控制构建过程。
   *
   * - entryPoints:  入口文件
   * - outfile: 输出文件路径
   * - bundle: 打包成一个文件
   * - external: 外部依赖防止被打包
   * - sourcemap: 生成源映射
   * - format: 输出的模块格式
   * - globalName: 全局名称
   * - platform: 构建平台
   * - plugins: 插件数组
   * - define: 用于定义全局常量
   */
  esbuild
    .context({
      entryPoints: [resolve(__dirname, `${pkgBasePath}/src/index.ts`)],
      outfile,
      bundle: true,
      external,
      sourcemap: true,
      format: outputFormat,
      globalName: pkg.buildOptions?.name,
      platform: format === 'cjs' ? 'node' : 'browser',
      plugins,
      define: {
        __COMMIT__: `"dev"`,
        __VERSION__: `"${pkg.version}"`,
        __DEV__: prod ? `false` : `true`,
        __TEST__: `false`,
        __BROWSER__: String(
          format !== 'cjs' && !pkg.buildOptions?.enableNonBrowserBranches,
        ),
        __GLOBAL__: String(format === 'global'),
        __ESM_BUNDLER__: String(format.includes('esm-bundler')),
        __ESM_BROWSER__: String(format.includes('esm-browser')),
        __CJS__: String(format === 'cjs'),
        __SSR__: String(format !== 'global'),
        __COMPAT__: String(target === 'vue-compat'),
        __FEATURE_SUSPENSE__: `true`,
        __FEATURE_OPTIONS_API__: `true`,
        __FEATURE_PROD_DEVTOOLS__: `false`,
        __FEATURE_PROD_HYDRATION_MISMATCH_DETAILS__: `true`,
      },
    })
    // ctx.watch 启动监听模式，在开发环境下实时构建
    .then(ctx => ctx.watch())
}
