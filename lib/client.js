
/**
 * dsh-toolbox —— 浏览器半边。
 *
 * ## 它解决什么
 *
 * 设置面板的左侧导航是 \`settings.section\` 槽位账本的投影：每个插件注册一个
 * 一级页，插件一多，导航就被十几个"一年点两次"的页面挤满。DSH 没有提供
 * 「把别人的页收进分组」的公开扩展点（槽位声明即渲染授权，声明者唯一），
 * 所以这里用两条受控的机制做「收纳」：
 *
 *   1) 侧栏折叠：给 SlotRegistry.prototype.entries 套一层过滤器，只在
 *      key === 'settings.section' 时剔除"已收纳"的 id。导航读的就是
 *      entries()，于是这些页从侧栏消失；renderSlot 走的是 entriesOfSlot()，
 *      不受影响。
 *   2) 原位展开：工具箱自己的条目声明子槽位 \`toolbox.page\`，展开某个页时
 *      把那个页原本的组件连同它的 locale / inject / store 席位一起重新注册
 *      进子槽位，再 renderSlot 出来。props 全由槽位框架按原样组装，
 *      不伪造、不越权（声明者就是工具箱自己）。
 *
 * 两条机制都带注释、都可逆（fiber 卸载时还原原型、释放子槽位注册）。
 *
 * ## 边界
 *
 * - 只折叠"从导航消失"，页面的注册本身不动：插件热重载/卸载后账本一变，
 *   这里跟着重算。
 * - 若某个页自己声明了子槽位（目前第三方插件里没有），不能重复声明，
 *   展开时会显示一行"暂不能内嵌"而不是崩掉。
 * - 折叠的页若正好是当前打开的那一页，内容仍会留在面板里，但侧栏不再有
 *   它的高亮项——点一下别的导航即可。
 *
 * @module dsh-toolbox/client
 */
window.__ModuleLoader__.load({
  id: "dsh-toolbox",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require("react");
    const h = React.createElement;
    const useState = React.useState;
    const useEffect = React.useEffect;
    const useSyncExternalStore = React.useSyncExternalStore;
    const useRef = React.useRef;
    const useCallback = React.useCallback;
    const memo = typeof React.memo === "function" ? React.memo : function (component) { return component; };

    const SECTION_ID = "toolbox";
    const PAGE_SLOT = "toolbox.page";
    const STORAGE_KEY = "dsh-toolbox.prefs.v1";
    const SECTION_ORDER = 16;
    const SECTION_LABEL = "工具箱";
    const HOST_OWNER = { close: function () {} };
    const CORE_IDS = ["account", "general", "models", "plugins"];
    const NUDGE_PREFIX = "__toolbox_nudge_";

    // ================================================================
    //  状态总线：偏好、展开集、槽位快照共用一个版本号
    // ================================================================
    let revision = 0;
    // 工具箱页完成一次渲染就 +1：用来检测"推了账本版本但外壳没有级联渲染"的宿主实现漂移。
    let renderCount = 0;
    const bus = new Set();

    function bump() {
      revision += 1;
      for (const listener of Array.from(bus)) {
        try {
          listener();
        } catch (_) {
          /* 单个订阅者出错不拖垮别人 */
        }
      }
    }

    function subscribe(listener) {
      bus.add(listener);
      return function () {
        bus.delete(listener);
      };
    }

    function getRevision() {
      return revision;
    }

    // ================================================================
    //  偏好：mode = 'auto' | 'manual'，overrides[id] = 强制收纳/放回
    // ================================================================
    function readPrefs() {
      const doc = { mode: "auto", overrides: {} };
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (!raw) return doc;
        const parsed = JSON.parse(raw);
        if (parsed && parsed.mode === "manual") doc.mode = "manual";
        if (parsed && parsed.overrides && typeof parsed.overrides === "object") {
          for (const key of Object.keys(parsed.overrides)) {
            if (typeof parsed.overrides[key] === "boolean") doc.overrides[key] = parsed.overrides[key];
          }
        }
      } catch (_) {
        /* 存储不可用就用默认值 */
      }
      return doc;
    }

    let prefs = readPrefs();

    // 偏好版本号：savePrefs 递增，折叠集合/过滤器缓存据此失效。
    let prefsEpoch = 0;

    function savePrefs(next) {
      prefs = next;
      prefsEpoch += 1;
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch (_) {
        /* 存不下就只在本次会话生效 */
      }
      // 注意：这里不 bump()。折叠状态变化必然会推账本版本，外壳重算 rows 时会
      // 连带重渲染当前打开的工具箱页；少这一次同步渲染，一次切换只渲染一轮。
    }

    function isCore(id) {
      return CORE_IDS.indexOf(id) >= 0;
    }

    /** 判定一个设置页是否应被收进工具箱。 */
    function isFolded(id) {
      if (!id || id === SECTION_ID) return false;
      if (prefs.overrides[id] === true) return true;
      if (prefs.overrides[id] === false) return false;
      if (isCore(id)) return false;
      return prefs.mode === "auto";
    }

    // ================================================================
    //  槽位读取
    // ================================================================
    /**
     * 过滤器装好之后指向"原实现"，这样工具箱自己（以及折叠判定）永远能看到
     * 全部页，而不会被自己的过滤器绕进去。
     */
    let readRaw = null;

    // 账本数组在两次 mutation 之间是同一个引用（SlotCore.entries 的性质），
    // 所以拿引用当缓存键：一次账本变化只扫描、排序、解析 label 一次。
    let sectionsLedger = null;
    let sectionsLocale = -1;
    let sectionsVersion = -1;
    let sectionsValue = null;
    const EMPTY_SECTIONS = [];

    function canMarkDirty(ctx) {
      try {
        const core = ctx && ctx.slots ? ctx.slots._core : null;
        return !!(
          core &&
          typeof core.markDirty === "function" &&
          core.records &&
          typeof core.records.get === "function" &&
          core.records.get("settings.section")
        );
      } catch (_) {
        return false;
      }
    }

    function slotVersion(ctx) {
      try {
        return ctx.slots.getVersion("settings.section");
      } catch (_) {
        return -1;
      }
    }

    function localeRevision(ctx) {
      try {
        const locale = ctx && ctx.locale;
        if (!locale || typeof locale.getSnapshot !== "function") return 0;
        const snapshot = locale.getSnapshot();
        return snapshot && typeof snapshot.revision === "number" ? snapshot.revision : 0;
      } catch (_) {
        return 0;
      }
    }

    function resolveLabel(label, fallback) {
      try {
        if (typeof label === "function") {
          const text = label();
          return typeof text === "string" && text ? text : fallback;
        }
        if (typeof label === "string" && label) return label;
      } catch (_) {
        /* 标签 thunk 出错就用 id 顶上 */
      }
      return fallback;
    }

    /**
     * 读出当前账本里所有可收纳的设置页（不含工具箱自己）。
     * 缓存键 = 账本数组引用（过滤器传入）+ locale 版本；渲染路径先用 slots 版本号
     * 判断"账本没动"，命中时不调 entries()，也不重排/重取 label。
     */
    function readSections(ctx, listHint) {
      const locale = localeRevision(ctx);
      const version = slotVersion(ctx);
      let list = listHint || null;
      if (!list) {
        if (sectionsValue && version >= 0 && version === sectionsVersion && locale === sectionsLocale) {
          return sectionsValue;
        }
        try {
          list = readRaw ? readRaw("settings.section") : ctx.slots.entries("settings.section");
        } catch (_) {
          list = null;
        }
      }
      if (!list) return EMPTY_SECTIONS;
      if (list === sectionsLedger && locale === sectionsLocale) {
        sectionsVersion = version;
        return sectionsValue;
      }
      const out = [];
      for (const entry of list) {
        const options = entry && entry.options ? entry.options : {};
        const id = typeof options.id === "string" ? options.id : "";
        if (!id || id === SECTION_ID || id.indexOf(NUDGE_PREFIX) === 0) continue;
        out.push({
          id: id,
          order: typeof options.order === "number" ? options.order : 0,
          label: resolveLabel(options.label, id),
          source: typeof entry.registrant === "string" ? entry.registrant : "",
          entry: entry,
        });
      }
      out.sort(function (a, b) {
        return a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      });
      sectionsLedger = list;
      sectionsLocale = locale;
      sectionsVersion = version;
      sectionsValue = out;
      return out;
    }

    // 折叠集合只依赖页面列表与偏好；两者都没变时复用同一个 Set（过滤器与渲染共用）。
    let foldedSections = null;
    let foldedEpoch = -1;
    let foldedValue = null;

    function foldedSet(sections) {
      if (sections === foldedSections && prefsEpoch === foldedEpoch) return foldedValue;
      const set = new Set();
      for (const section of sections) {
        if (isFolded(section.id)) set.add(section.id);
      }
      foldedSections = sections;
      foldedEpoch = prefsEpoch;
      foldedValue = set;
      return set;
    }

    // ================================================================
    //  侧栏折叠：包一层 entries()
    // ================================================================
    function installNavFilter(ctx) {
      const slots = ctx.slots;

      // entries 在 SlotRegistry.prototype 上；ctx.slots 可能是绑定了 ctx 的
      // 派生对象，所以沿原型链找真正持有 entries 的那一层。
      let proto = null;
      let node = slots;
      for (let depth = 0; depth < 8 && node; depth += 1) {
        const next = Object.getPrototypeOf(node);
        if (!next) break;
        if (Object.prototype.hasOwnProperty.call(next, "entries")) {
          proto = next;
          break;
        }
        node = next;
      }
      if (!proto) return null;

      const original = proto.entries;
      readRaw = function (key) {
        return original.call(slots, key);
      };

      let cacheSrc = null;
      let cacheHidden = null;
      let cacheOut = null;

      function filteredEntries(key) {
        const list = original.call(this, key);
        if (key !== "settings.section") return list;

        let hidden = null;
        try {
          hidden = foldedSet(readSections(ctx, list));
        } catch (_) {
          return list;
        }
        if (!hidden || hidden.size === 0) return list;

        // 同一个账本快照 + 同一份折叠集 => 返回同一个数组（uSES 的稳定引用契约）。
        if (cacheSrc === list && cacheHidden === hidden) return cacheOut;

        const out = [];
        for (const entry of list) {
          const id = entry && entry.options ? entry.options.id : undefined;
          if (typeof id === "string" && (hidden.has(id) || id.indexOf(NUDGE_PREFIX) === 0)) continue;
          out.push(entry);
        }
        cacheSrc = list;
        cacheHidden = hidden;
        cacheOut = out;
        return out;
      }

      proto.entries = filteredEntries;
      return function () {
        if (proto.entries === filteredEntries) proto.entries = original;
        readRaw = null;
        sectionsLedger = null;
        sectionsVersion = -1;
        sectionsValue = null;
        foldedSections = null;
        foldedValue = null;
      };
    }

    /**
     * 让外壳重算导航：设置面板的 rows 按 getVersion('settings.section') 缓存。
     * 首选 SlotRegistry 内部 SlotCore 的 markDirty：只推版本号、不动账本、不分配条目；
     * 内部字段缺失（宿主升级改名）时退回"注册+立刻释放占位条目"的兼容路径。
     */
    function nudgeLedger(ctx) {
      try {
        const core = ctx && ctx.slots ? ctx.slots._core : null;
        if (
          core &&
          typeof core.markDirty === "function" &&
          core.records &&
          typeof core.records.get === "function"
        ) {
          const record = core.records.get("settings.section");
          if (record) {
            core.markDirty("settings.section", record);
            return true;
          }
        }
      } catch (_) {
        /* 落到下面的兼容路径 */
      }
      try {
        const id = NUDGE_PREFIX + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const dispose = ctx.slots.register(
          {
            name: "settings.section",
            id: id,
            order: 9999,
            label: function () {
              return "";
            },
          },
          function Nudge() {
            return null;
          },
        );
        dispose();
        return true;
      } catch (_) {
        /* 只是推一下版本号，失败不影响折叠本身 */
        return false;
      }
    }

    /**
     * 推账本版本并安排一次自愈检查。
     * 正常路径：外壳 rows 重算（settings-general SettingsRoot -> SettingsPanel -> renderSlot）
     * 会级联重渲染当前工具箱页，savePrefs 因此不再自己 bump()，一次切换只渲染一轮。
     * 但这条级联依赖"设置面板/内容区没有被 memo 包住"这一实现细节；若宿主以后拆开，
     * 宏任务里发现本页没重渲染就补一次 bump，功能不会因优化而静默失效。
     */
    function pushLedgerChange(ctx) {
      if (!nudgeLedger(ctx)) {
        bump();
        return;
      }
      const expected = renderCount + 1;
      setTimeout(function () {
        if (renderCount < expected) bump();
      }, 0);
    }

    // ================================================================
    //  原位展开：把被收纳页的组件重挂进 toolbox.page
    // ================================================================
    const hosted = new Map();

    function hostSection(ctx, section) {
      if (hosted.has(section.id)) return null;
      const entry = section.entry;
      try {
        if (!entry || entry.children !== undefined) {
          throw new Error("这个页声明了子槽位，不能重复声明");
        }
        const options = {
          name: PAGE_SLOT,
          id: section.id,
          order: section.order,
        };
        if (typeof entry.locale === "string") options.locale = entry.locale;
        if (typeof entry.inject === "function") options.inject = entry.inject;
        if (entry.store !== undefined) options.store = entry.store;
        const dispose = ctx.slots.register(options, entry.component);
        hosted.set(section.id, dispose);
        return null;
      } catch (error) {
        hosted.set(section.id, function () {});
        return String(error && error.message ? error.message : error);
      }
    }

    function unhostSection(id) {
      const dispose = hosted.get(id);
      hosted.delete(id);
      if (typeof dispose === "function") {
        try {
          dispose();
        } catch (_) {
          /* 幂等释放 */
        }
      }
    }

    // ================================================================
    //  样式
    // ================================================================
    const CSS = [
      ".dshtb{display:flex;flex-direction:column;gap:14px;padding:2px 24px 28px;max-width:780px;color:inherit;font:inherit}",
      ".dshtb-title{font-size:16px;font-weight:600;margin:0}",
      ".dshtb-sub{margin:0;font-size:12px;line-height:1.65;opacity:.62}",
      ".dshtb-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 12px;border:1px solid color-mix(in oklab,currentColor 15%,transparent);border-radius:10px;background:color-mix(in oklab,currentColor 4%,transparent)}",
      ".dshtb-spacer{flex:1 1 auto}",
      ".dshtb-switch{display:inline-flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;user-select:none}",
      ".dshtb-btn{font:inherit;font-size:12px;line-height:1;padding:7px 10px;border-radius:8px;border:1px solid color-mix(in oklab,currentColor 20%,transparent);background:transparent;color:inherit;cursor:pointer}",
      ".dshtb-btn:hover{background:color-mix(in oklab,currentColor 8%,transparent)}",
      ".dshtb-list{display:flex;flex-direction:column;gap:8px}",
      ".dshtb-card{border:1px solid color-mix(in oklab,currentColor 15%,transparent);border-radius:10px;overflow:hidden}",
      ".dshtb-card-open{background:color-mix(in oklab,currentColor 3%,transparent)}",
      ".dshtb-row{display:flex;align-items:center;gap:8px;padding:8px 10px}",
      ".dshtb-head{flex:1 1 auto;display:flex;align-items:center;gap:8px;min-width:0;padding:0;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}",
      ".dshtb-head[disabled]{cursor:default}",
      ".dshtb-caret{width:12px;flex:0 0 12px;opacity:.55;font-size:11px}",
      ".dshtb-label{font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".dshtb-id{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;opacity:.45;white-space:nowrap}",
      ".dshtb-badge{font-size:10px;padding:2px 6px;border-radius:999px;border:1px solid color-mix(in oklab,currentColor 20%,transparent);opacity:.7}",
      ".dshtb-toggle{flex:0 0 auto;font:inherit;font-size:12px;padding:6px 10px;border-radius:999px;border:1px solid color-mix(in oklab,currentColor 20%,transparent);background:transparent;color:inherit;cursor:pointer}",
      ".dshtb-toggle-on{background:color-mix(in oklab,var(--dsh-accent,#4f6bff) 16%,transparent);border-color:color-mix(in oklab,var(--dsh-accent,#4f6bff) 45%,transparent)}",
      ".dshtb-body{border-top:1px solid color-mix(in oklab,currentColor 10%,transparent);padding:12px}",
      ".dshtb-hosted{min-height:24px}",
      ".dshtb-warn{font-size:12px;line-height:1.6;color:#d9534f}",
      ".dshtb-empty{font-size:13px;opacity:.55;padding:10px 0}",
      ".dshtb-diag{font-size:12px;opacity:.72}",
      ".dshtb-diag summary{cursor:pointer}",
      ".dshtb-diag pre{white-space:pre-wrap;word-break:break-word;margin:6px 0 0;font-size:11px;line-height:1.5}",
    ].join("\n");

    // ================================================================
    //  图标（settings.section.icon 的 inline 贡献）
    // ================================================================
    function ToolboxIcon(props) {
      const size = typeof props.size === "number" ? props.size : 16;
      return h(
        "svg",
        {
          width: size,
          height: size,
          viewBox: "0 0 16 16",
          fill: "none",
          "aria-hidden": "true",
          focusable: "false",
        },
        h("rect", { x: 2.2, y: 5.4, width: 11.6, height: 8.4, rx: 1.7, stroke: "currentColor", strokeWidth: 1.3 }),
        h("path", { d: "M2.2 8.5h11.6", stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round" }),
        h("path", {
          d: "M6.1 5.4V4.3c0-.6.5-1.1 1.1-1.1h1.6c.6 0 1.1.5 1.1 1.1v1.1",
          stroke: "currentColor",
          strokeWidth: 1.3,
          strokeLinecap: "round",
        }),
        h("circle", { cx: 5.5, cy: 10.9, r: 0.85, fill: "currentColor" }),
        h("circle", { cx: 10.5, cy: 10.9, r: 0.85, fill: "currentColor" }),
      );
    }

    // ================================================================
    //  界面
    // ================================================================
    const expanded = new Set();

    function toggleExpanded(id) {
      if (expanded.has(id)) expanded.delete(id);
      else expanded.add(id);
      bump();
    }

    function setMode(mode, ctx) {
      if (prefs.mode === mode) return;
      // 模式切换会让所有页的可见性变化，旧的展开态失去意义，清掉避免再次收纳时自动展开。
      expanded.clear();
      savePrefs({ mode: mode, overrides: prefs.overrides });
      pushLedgerChange(ctx);
    }

    function setFolded(id, folded, ctx) {
      if (isFolded(id) === folded) return;
      const overrides = Object.assign({}, prefs.overrides);
      overrides[id] = folded;
      savePrefs({ mode: prefs.mode, overrides: overrides });
      // 两个方向都清展开态：放回侧栏后不应该在下次收纳时自动展开。
      expanded.delete(id);
      pushLedgerChange(ctx);
    }

    function foldAll(ctx) {
      const overrides = Object.assign({}, prefs.overrides);
      let changed = false;
      for (const section of readSections(ctx)) {
        if (overrides[section.id] !== true) {
          overrides[section.id] = true;
          changed = true;
        }
      }
      if (!changed) return;
      savePrefs({ mode: prefs.mode, overrides: overrides });
      pushLedgerChange(ctx);
    }

    function unfoldAll(ctx) {
      const hadOverrides = Object.keys(prefs.overrides).length > 0;
      const modeChange = prefs.mode !== "manual";
      let changed = false;
      if (modeChange || hadOverrides) {
        savePrefs({ mode: "manual", overrides: {} });
        changed = true;
      }
      if (expanded.size > 0) {
        expanded.clear();
        changed = true;
      }
      if (hosted.size > 0) {
        for (const id of Array.from(hosted.keys())) unhostSection(id);
        changed = true;
      }
      if (!changed) return;
      // 账本没变（只清了展开态）时不需要推版本，局部重渲染即可。
      if (modeChange || hadOverrides) {
        pushLedgerChange(ctx);
      } else {
        bump();
      }
    }

    /** 展开后的卡片：把"原页组件"挂进 toolbox.page 再渲染出来。
     *  memo：卡片列表重渲染（别的行折叠/展开、偏好变化）时不要连带重建已展开的页。 */
    const SectionHost = memo(function SectionHost(props) {
      const section = props.section;
      const ctx = props.ctx;
      const [failure, setFailure] = useState(null);

      useEffect(
        function () {
          let cancelled = false;
          const error = hostSection(ctx, section);
          if (!cancelled) setFailure(error);
          return function () {
            cancelled = true;
            unhostSection(section.id);
          };
        },
        [section.id, section.entry],
      );

      if (failure !== null) {
        return h("div", { className: "dshtb-warn" }, "这个页暂不能内嵌：" + failure);
      }
      return h("div", { className: "dshtb-hosted" }, props.renderHosted(section.id));
    }, function sameSectionHost(prev, next) {
      // 包对象可能因账本/locale 变化重建；只要原条目没换、locale 没变，就不要重渲染宿主页。
      return (
        prev.ctx === next.ctx &&
        prev.renderHosted === next.renderHosted &&
        prev.localeRev === next.localeRev &&
        prev.section.id === next.section.id &&
        prev.section.entry === next.section.entry
      );
    });

    function ToolboxSection(props) {
      renderCount += 1;
      useSyncExternalStore(subscribe, getRevision, getRevision);

      const api = props.api;
      const ctx = api.ctx();
      // renderSlot 每次渲染可能是新函数；用 ref 固定住宿主传入的那一份，
      // 让 SectionHost 的 props 保持稳定，memo 才挡得住无关重渲染。
      const renderSlotRef = useRef(props.renderSlot);
      renderSlotRef.current = props.renderSlot;
      const renderHosted = useCallback(function (id) {
        return renderSlotRef.current(PAGE_SLOT, HOST_OWNER, { only: id });
      }, []);

      const sections = readSections(ctx);
      const folded = foldedSet(sections);
      const filteredCount = sections.length - folded.size;
      const localeRev = localeRevision(ctx);

      // 插件热重载/启停会改账本：跟着刷新列表。
      // 版本号推送（markDirty）不会换账本数组，这种情况不重渲染工具箱。
      useEffect(function () {
        let lastRaw = null;
        try {
          lastRaw = readRaw ? readRaw("settings.section") : ctx.slots.entries("settings.section");
        } catch (_) {
          lastRaw = null;
        }
        const off = ctx.slots.subscribe("settings.section", function () {
          let now = null;
          try {
            now = readRaw ? readRaw("settings.section") : ctx.slots.entries("settings.section");
          } catch (_) {
            now = null;
          }
          if (now === lastRaw) return;
          lastRaw = now;
          bump();
        });
        let offLocale = null;
        try {
          if (ctx.locale && typeof ctx.locale.subscribe === "function") {
            offLocale = ctx.locale.subscribe(function () {
              bump();
            });
          }
        } catch (_) {
          offLocale = null;
        }
        return function () {
          off();
          if (typeof offLocale === "function") offLocale();
        };
      }, [ctx]);

      // 已经不存在的页不要留着展开态（先用 Set 收敛，避免 expanded x sections 的平方扫描）。
      if (expanded.size > 0) {
        const aliveIds = new Set();
        for (const section of sections) aliveIds.add(section.id);
        for (const id of Array.from(expanded)) {
          if (!aliveIds.has(id)) expanded.delete(id);
        }
      }

      const cards = sections.map(function (section) {
        const isFoldedNow = folded.has(section.id);
        const isOpen = isFoldedNow && expanded.has(section.id);
        return h(
          "div",
          { key: section.id, className: isOpen ? "dshtb-card dshtb-card-open" : "dshtb-card" },
          h(
            "div",
            { className: "dshtb-row" },
            h(
              "button",
              {
                type: "button",
                className: "dshtb-head",
                disabled: !isFoldedNow,
                title: isFoldedNow ? "点开/收起这一页" : "这一页在侧栏，先收进工具箱才能展开",
                onClick: function () {
                  if (isFoldedNow) toggleExpanded(section.id);
                },
              },
              h("span", { className: "dshtb-caret" }, isFoldedNow ? (isOpen ? "▾" : "▸") : "·"),
              h("span", { className: "dshtb-label" }, section.label),
              h("span", { className: "dshtb-id" }, section.id),
              isCore(section.id) ? h("span", { className: "dshtb-badge" }, "核心") : null,
            ),
            h(
              "button",
              {
                type: "button",
                className: isFoldedNow ? "dshtb-toggle dshtb-toggle-on" : "dshtb-toggle",
                title: isFoldedNow ? "放回设置侧栏" : "收进工具箱",
                onClick: function () {
                  setFolded(section.id, !isFoldedNow, ctx);
                },
              },
              isFoldedNow ? "已收纳" : "在侧栏",
            ),
          ),
          isOpen
            ? h(
                "div",
                { className: "dshtb-body" },
                h(SectionHost, {
                  section: section,
                  ctx: ctx,
                  localeRev: localeRev,
                  renderHosted: renderHosted,
                }),
              )
            : null,
        );
      });

      const diagnostics = [
        "侧栏过滤器：" + (api.filterInstalled() ? "已安装" : "未安装（折叠不会生效）"),
        "版本推送：" + (canMarkDirty(ctx) ? "markDirty（不写账本）" : "占位条目回退"),
        "模式：" + (prefs.mode === "auto" ? "自动（收纳第三方页）" : "手动"),
        "设置页：" + sections.length + " 个，已收纳 " + folded.size + " 个，侧栏保留 " + filteredCount + " 个",
        "展开中：" + (expanded.size ? Array.from(expanded).join(", ") : "无"),
      ];

      return h(
        "div",
        { className: "dshtb" },
        h(
          "div",
          { className: "dshtb-headline" },
          h("h2", { className: "dshtb-title" }, SECTION_LABEL),
          h(
            "p",
            { className: "dshtb-sub" },
            "不常改动的插件设置收在这里：侧栏只留核心页，需要时点开对应条目原地展开。折叠只影响导航，页面的配置与插件本身照常工作。",
          ),
        ),
        h(
          "div",
          { className: "dshtb-toolbar" },
          h(
            "label",
            { className: "dshtb-switch" },
            h("input", {
              type: "checkbox",
              checked: prefs.mode === "auto",
              onChange: function (event) {
                setMode(event.target.checked ? "auto" : "manual", ctx);
              },
            }),
            h("span", null, "自动收纳第三方插件页"),
          ),
          h("span", { className: "dshtb-spacer" }),
          h(
            "button",
            {
              type: "button",
              className: "dshtb-btn",
              onClick: function () {
                foldAll(ctx);
              },
            },
            "全部收纳",
          ),
          h(
            "button",
            {
              type: "button",
              className: "dshtb-btn",
              onClick: function () {
                unfoldAll(ctx);
              },
            },
            "全部放回",
          ),
        ),
        sections.length === 0
          ? h("div", { className: "dshtb-empty" }, "还没读到任何设置页（槽位账本为空或还没加载完）。")
          : h("div", { className: "dshtb-list" }, cards),
        h(
          "details",
          { className: "dshtb-diag" },
          h("summary", null, "诊断"),
          h("pre", null, diagnostics.join("\n")),
        ),
      );
    }

    // ================================================================
    //  挂载
    // ================================================================
    let applied = false;

    function apply(ctx) {
      if (applied) return;
      applied = true;

      if (!ctx || !ctx.slots) {
        try {
          console.warn("[dsh-toolbox] ctx.slots 不可用，工具箱未挂载");
        } catch (_) {}
        applied = false;
        return;
      }

      let disposeFilter = null;
      try {
        disposeFilter = installNavFilter(ctx);
      } catch (error) {
        disposeFilter = null;
        try {
          console.warn("[dsh-toolbox] 侧栏过滤器安装失败：", error);
        } catch (_) {}
      }

      const style = document.createElement("style");
      style.setAttribute("data-dsh-toolbox", "");
      style.textContent = CSS;
      document.head.appendChild(style);

      const api = {
        ctx: function () {
          return ctx;
        },
        filterInstalled: function () {
          return typeof disposeFilter === "function";
        },
      };

      let disposeSection = null;
      let disposeIcon = null;

      ctx.effect(
        function () {
          return function () {
            for (const id of Array.from(hosted.keys())) unhostSection(id);
            if (typeof disposeSection === "function") {
              try { disposeSection(); } catch (_) {}
              disposeSection = null;
            }
            if (typeof disposeIcon === "function") {
              try { disposeIcon(); } catch (_) {}
              disposeIcon = null;
            }
            if (disposeFilter) {
              disposeFilter();
              disposeFilter = null;
            }
            if (style.parentNode) style.parentNode.removeChild(style);
            applied = false;
          };
        },
        "dsh-toolbox: teardown",
      );

      ctx.slots.inject("settings.section", function () {
        disposeSection = ctx.slots.register(
          {
            name: "settings.section",
            id: SECTION_ID,
            order: SECTION_ORDER,
            label: function () {
              return SECTION_LABEL;
            },
            children: {
              "toolbox.page": {
                kind: "list",
                scope: "root",
              },
            },
            inject: function () {
              return { api: api };
            },
          },
          ToolboxSection,
        );
      });

      ctx.slots.inject("settings.section.icon", function () {
        disposeIcon = ctx.slots.register(
          {
            name: "settings.section.icon",
            id: SECTION_ID,
            order: SECTION_ORDER,
            label: function () {
              return SECTION_LABEL;
            },
          },
          ToolboxIcon,
        );
      });
    }

    const inject = ["slots", "locale"];

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});