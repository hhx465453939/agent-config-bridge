/**
 * Browser half of `dsh-market-links`.
 *
 * What it adds:
 *   - one row in the left sidebar ("插件市场");
 *   - the panel that row opens: the community DSH plugin markets, grouped,
 *     each one a link that opens in the system browser.
 *
 * Why a panel and not an expanding tree under the button: the sidebar exposes
 * `sidebar.panellist` (one row per feature) and `main` (the panel keyed by that
 * row's id); it deliberately has no slot for nesting extra rows under a button.
 * A panel is the shape the shell supports, and it leaves room to show each
 * market's description and its install command.
 *
 * Opening a market: ordinary `<a target="_blank">`. The Electron main window
 * installs `setWindowOpenHandler` that hands http(s) URLs to the OS browser
 * (`shell.openExternal`) and denies an in-app window, so the click leaves DSH.
 *
 * The market list is data, not logic: add an entry to MARKETS to add a site.
 * Every URL below was checked reachable on 2026-11-14.
 */

window.__ModuleLoader__.load({
  id: 'dsh-market-links',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Sidebar row id; also the key of the `main` panel slot. */
    const PANEL_ID = 'market-links';
    const PANEL_LABEL = '插件市场';

    /** Grouped directory list. `note` is one line: what this site is good at. */
    const GROUPS = [
      {
        title: '聚合目录站（浏览器里逛）',
        lead: '收录量最大的一批站，带搜索和分类；点开就是它们的网页。',
        sites: [
          {
            name: 'DSH Market · dshplugin.io',
            url: 'https://dshplugin.io',
            note: '3,700+ 条，分类浏览，每条带现成的 dsh plugin add 命令',
          },
          {
            name: 'DSH Plugin Directory · dshplugin.dev',
            url: 'https://dshplugin.dev',
            note: '1,100+ 条，来源是官方仓库 + GitHub topic，每天刷新',
          },
          {
            name: 'DSH 1024Store · deepseek1024.com',
            url: 'https://deepseek1024.com',
            note: '站点自报 11,000+，有排行榜和免费 API',
          },
          {
            name: 'MyDSH 插件大全 · mydsh.dev/plugins',
            url: 'https://mydsh.dev/plugins',
            note: '每个插件有 AI 中文总结，支持一句话描述需求搜索',
          },
          {
            name: 'DSH 插件商店 · dsh.deepseek404.com',
            url: 'https://dsh.deepseek404.com',
            note: '中文界面，标注每个插件的安装参考和是否已验证',
          },
          {
            name: 'DSH Plugin Market · dsh-plugin.org',
            url: 'https://dsh-plugin.org',
            note: '中文/英文混排，分类 + 安装命令',
          },
          {
            name: 'dshfind · 插件超市',
            url: 'https://dshfind.com',
            note: '编辑器精选 Top Picks，另有学习社区',
          },
          {
            name: 'DeepSeek Harness 生态页 · deepseekdocs.com',
            url: 'https://deepseekdocs.com/ecosystem',
            note: '按 star 排序的全量清单，适合看头部项目',
          },
        ],
      },
      {
        title: 'GitHub 权威入口（源头）',
        lead: '插件作者发布的原始仓库；上面那些站点基本都是从这里抓的。',
        sites: [
          {
            name: 'GitHub topic: dsh-plugin',
            url: 'https://github.com/topics/dsh-plugin',
            note: '官方 README 让作者打的标签，新插件最先出现在这里',
          },
          {
            name: 'GitHub topic: deepseek-harness-plugin',
            url: 'https://github.com/topics/deepseek-harness-plugin',
            note: '第二个活跃标签，覆盖一部分没打 dsh-plugin 的仓库',
          },
          {
            name: 'awesome-dsh-plugin',
            url: 'https://github.com/awesome-dsh-plugin/awesome-dsh-plugin',
            note: '社区最大清单（约 1.5k 条），一个插件一个 YAML，定时扫失效链接',
          },
          {
            name: 'awesome-deepseek-harness-plugins',
            url: 'https://github.com/imsai-sh/awesome-deepseek-harness-plugins',
            note: '自称 11,000+，带格式校验和免费搜索 API',
          },
          {
            name: 'awesome-deepseek-harness',
            url: 'https://github.com/0xsline/awesome-deepseek-harness',
            note: '按用途分类的生态总览：基础设施 / UI / 记忆 / 多 agent',
          },
          {
            name: 'GitHub 组织: dsh-plugins',
            url: 'https://github.com/dsh-plugins',
            note: '含 dsh-plugin-market（结构化 plugins.json）等市场仓库',
          },
        ],
      },
      {
        title: '装进 DSH 里用的市场',
        lead: '想在界面里直接搜索/安装/更新，而不是复制命令，用这一类。',
        sites: [
          {
            name: 'dsh-market（可视化市场）',
            url: 'https://github.com/dsh-market/dsh-market',
            note: '装好后在插件页出现「Plugin Market」标签页，可搜索、安装、更新、卸载',
          },
          {
            name: 'DSH-Plugins-Marketplace',
            url: 'https://github.com/bradeGithub/DSH-Plugins-Marketplace',
            note: '一键浏览/安装/更新整个 dsh-plugin topic 的插件',
          },
        ],
      },
    ];

    /** How to install once a plugin is chosen. Kept accurate for this host. */
    const COMMANDS = [
      { cmd: 'dsh plugin --profile web add <包名>', note: '命令行装到 web profile；名字可换成 github:作者/仓库' },
      { cmd: 'dsh plugin --profile web remove <包名>', note: '卸载' },
      { cmd: 'dsh plugin --profile web update <包名>', note: '升级' },
    ];

    const STYLES = `
      .dshml-root {
        box-sizing: border-box;
        height: 100%;
        overflow: auto;
        padding: 28px clamp(16px, 4vw, 48px) 48px;
        color: inherit;
        font-size: 14px;
        line-height: 1.6;
      }
      .dshml-head { max-width: 920px; margin: 0 auto 22px; }
      .dshml-head h1 { font-size: 20px; font-weight: 600; margin: 0 0 6px; }
      .dshml-head p { margin: 0; opacity: .72; }
      .dshml-group { max-width: 920px; margin: 0 auto 22px; }
      .dshml-group > h2 { font-size: 14px; font-weight: 600; margin: 0 0 2px; }
      .dshml-group > p { margin: 0 0 10px; opacity: .62; font-size: 13px; }
      .dshml-list {
        display: grid;
        gap: 8px;
        grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
        margin: 0;
        padding: 0;
        list-style: none;
      }
      .dshml-site {
        display: block;
        height: 100%;
        box-sizing: border-box;
        padding: 10px 12px;
        border-radius: 10px;
        border: 1px solid color-mix(in srgb, currentColor 16%, transparent);
        background: color-mix(in srgb, currentColor 3%, transparent);
        color: inherit;
        text-decoration: none;
        transition: background .12s ease, border-color .12s ease;
      }
      .dshml-site:hover,
      .dshml-site:focus-visible {
        background: color-mix(in srgb, currentColor 7%, transparent);
        border-color: color-mix(in srgb, currentColor 32%, transparent);
        outline: none;
      }
      .dshml-site strong { display: block; font-weight: 600; font-size: 13.5px; }
      .dshml-site span { display: block; margin-top: 2px; font-size: 12.5px; opacity: .68; }
      .dshml-site em {
        display: block;
        margin-top: 6px;
        font-size: 11.5px;
        font-style: normal;
        opacity: .45;
        word-break: break-all;
      }
      .dshml-help {
        max-width: 920px;
        margin: 0 auto;
        padding: 14px 16px;
        border-radius: 10px;
        border: 1px solid color-mix(in srgb, currentColor 16%, transparent);
      }
      .dshml-help h2 { font-size: 14px; font-weight: 600; margin: 0 0 8px; }
      .dshml-cmd { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: center; margin: 0 0 6px; }
      .dshml-cmd code {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 12.5px;
        padding: 6px 8px;
        border-radius: 7px;
        background: color-mix(in srgb, currentColor 6%, transparent);
        overflow: auto;
        white-space: nowrap;
      }
      .dshml-cmd button {
        font: inherit;
        font-size: 12px;
        padding: 5px 10px;
        border-radius: 7px;
        border: 1px solid color-mix(in srgb, currentColor 24%, transparent);
        background: transparent;
        color: inherit;
        cursor: pointer;
      }
      .dshml-cmd button:hover { background: color-mix(in srgb, currentColor 8%, transparent); }
      .dshml-help ul { margin: 10px 0 0; padding-left: 18px; font-size: 12.5px; opacity: .72; }
      .dshml-help li { margin: 3px 0; }
    `;

    /** Storefront glyph; the sidebar renders this at 16 (wide) or 18px (rail). */
    function MarketIcon({ size = 16 }) {
      return h('svg', {
        viewBox: '0 0 16 16',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.3,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        style: { display: 'block' },
      }, [
        h('path', { key: 'awning', d: 'M2.2 6.2h11.6' }),
        h('path', { key: 'roof', d: 'M3.4 6.2 4.2 3h7.6l.8 3.2' }),
        h('path', { key: 'body', d: 'M4.1 6.2v6.6h7.8V6.2' }),
        h('path', { key: 'door', d: 'M6.6 12.8V9.4h2.8v3.4' }),
      ]);
    }

    /** Copy-to-clipboard button; silently degrades when the API is unavailable. */
    function CopyCommand({ cmd }) {
      const [copied, setCopied] = React.useState(false);
      const copy = React.useCallback(() => {
        const done = () => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1400);
        };
        try {
          navigator.clipboard.writeText(cmd).then(done, () => {});
        } catch {
          /* older clients: no clipboard */
        }
      }, [cmd]);
      return h('div', { className: 'dshml-cmd' },
        h('code', null, cmd),
        h('button', { type: 'button', onClick: copy }, copied ? '已复制' : '复制'));
    }

    /** The panel the sidebar row opens. */
    function MarketPanel() {
      return h('div', { className: 'dshml-root' },
        h('style', null, STYLES),
        h('header', { className: 'dshml-head' },
          h('h1', null, '插件市场'),
          h('p', null, '点任意站点会在系统浏览器里打开。挑好插件后，把包名或仓库地址发我，我在会话里帮你装、停用或卸载。')),
        ...GROUPS.map((group) => h('section', { className: 'dshml-group', key: group.title },
          h('h2', null, group.title),
          h('p', null, group.lead),
          h('ul', { className: 'dshml-list' },
            ...group.sites.map((site) => h('li', { key: site.url },
              h('a', {
                className: 'dshml-site',
                href: site.url,
                target: '_blank',
                rel: 'noopener noreferrer',
                title: site.url,
              },
              h('strong', null, site.name),
              h('span', null, site.note),
              h('em', null, site.url))))))),
        h('section', { className: 'dshml-help' },
          h('h2', null, '选定之后怎么装'),
          ...COMMANDS.map((row) => h(CopyCommand, { key: row.cmd, cmd: row.cmd })),
          h('ul', null,
            h('li', null, '桌面端（当前这个应用）：侧栏「插件」页 → 添加插件 → 填包名；桌面 profile 由应用独占，CLI 改不了它。'),
            h('li', null, '在会话里跟我说：把包名 / github:作者/仓库 发我，我用 plugin_manager 装，装完提醒你重载页面。'),
            h('li', null, '上面这些站点都只是目录：它们不保证收录的插件能装，装之前先看一眼仓库的 README 和最近提交。'))));
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // Sidebar row. The label is the visible text and the collapsed tooltip.
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 30,
          label: PANEL_LABEL,
        }, MarketIcon));

        // The panel selected by that row's id.
        ctx.slots.inject('main', function* () {
          yield ctx.slots.register({ name: 'main', key: PANEL_ID }, MarketPanel);
        });
      },
    };
  },
});
