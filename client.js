/**
 * dsh-cronops — browser half.
 *
 * Registers the plugin's locale dictionaries, contributes a row to the shell's
 * sidebar panel list (`sidebar.panellist`) and a page to the layout's keyed
 * `main` slot, then renders three tabs with the same structure as the SSH
 * plugin:
 *
 *   1. 主机 (panels)        — panel connections, mirroring the SSH host
 *                             manager: list, add, edit, delete, test, set
 *                             default. The products themselves (names, credential
 *                             fields, scope order) come from the host's `kinds`
 *                             metadata, not from this file.
 *   2. 环境变量 (envs)      — list / search / create / edit / delete / enable /
 *                             disable environment variables.
 *   3. 定时任务 (crons)     — list / search / paged view / run / stop / enable /
 *                             disable / delete / log / create / edit, with a
 *                             schedule preview.
 *
 * Everything talks to `/api/dsh-cronops/*` (the host half). Data never comes
 * from anywhere else, and secrets are write-only: the store never returns them.
 *
 * Styling: one owned <style> element registered in `apply` and removed on
 * dispose, with class names under the `dq-` prefix and colors taken only from
 * the host's `--dsw-alias-*` theme tokens.
 */

window.__ModuleLoader__.load({
  id: 'dsh-cronops',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } = React

    /** Route family base path (must match lib/protocol.js). */
    const API_BASE = '/api/dsh-cronops'

    /** Stable id shared by the sidebar row and the main-slot key. */
    const PANEL_ID = 'cronops'

    /** Locale namespace this plugin owns. */
    const NS = 'dsh-cronops'

    // ------------------------------------------------------------- locales

    /**
     * Locale dictionaries are declared as `[key, value]` pairs and built with
     * `Object.fromEntries`. A repeated key inside an object literal is silently
     * collapsed by the parser, which leaves no runtime trace at all; keeping the
     * pair list is what lets `auditDictionaries()` still see it and warn.
     */
    const DICTS = []

    /** Build one dictionary and remember its pair list for the audit. */
    function defineDict(name, pairs) {
      const dict = Object.fromEntries(pairs)
      DICTS.push({ name, pairs, dict })
      return dict
    }

    const zh = defineDict('zh', [
      ['entry.label', '定时面板'],
      ['entry.tooltip', '青龙 / 呆呆面板控制台'],
      ['panel.title', '定时面板'],
      ['panel.back', '返回会话'],
      ['tab.panels', '主机'],
      ['tab.envs', '环境变量'],
      ['tab.crons', '定时任务'],
      ['common.loading', '加载中…'],
      ['common.refresh', '刷新'],
      ['common.close', '关闭'],
      ['common.cancel', '取消'],
      ['common.save', '保存'],
      ['common.delete', '删除'],
      ['common.edit', '编辑'],
      ['common.create', '新增'],
      ['common.search', '搜索'],
      ['common.none', '-'],
      ['current.panel', '当前面板：{alias} · {url}'],
      ['common.enabled', '启用'],
      ['common.disabled', '禁用'],
      ['common.running', '运行中'],
      ['common.idle', '空闲'],
      ['common.confirmDelete', '确定删除「{name}」？'],
      ['error.noPanel', '尚未配置面板。请先在「主机」页签新增一个（青龙填 client_id / client_secret，呆呆填 app_key / app_secret）。'],
      ['error.generic', '操作失败'],
      ['notice.triggered', '已向面板提交触发请求（不代表脚本已执行完成）。'],
      ['notice.saved', '已保存。'],
      ['panels.empty', '尚未配置面板。点击「新增面板」填写面板地址与应用凭据。'],
      ['panels.scopes.unknown', '未测试（点「测试」获取）'],
      ['panels.scopes.hint', '只读探测；写权限与该资源同 scope'],
      ['panels.scopes.title', '权限'],
      ['panels.scopes.testedAt', '测试于 {time}'],
      ['panels.col.scopes', '权限'],
      ['panels.status.untested', '未测试'],
      ['scope.envs', '环境变量'],
      ['scope.crons', '定时任务'],
      ['scope.tasks', '定时任务'],
      ['scope.subscriptions', '订阅'],
      ['scope.configs', '配置文件'],
      ['scope.scripts', '脚本'],
      ['scope.logs', '日志'],
      ['scope.dependencies', '依赖'],
      ['scope.dashboard', '仪表盘'],
      ['scope.system', '系统信息'],
      ['scope.backup', '备份'],
      ['scope.state.ok', '有权限'],
      ['scope.state.forbidden', '无权限'],
      ['scope.state.error', '探测失败'],
      ['scope.state.timeout', '超时'],
      ['scope.state.public', '公开'],
      ['scope.state.na', '不适用'],
      ['panels.add', '新增面板'],
      ['panels.testAll', '测试全部'],
      ['panels.col.alias', '别名'],
      ['panels.col.kind', '类型'],
      ['panels.col.url', '面板地址'],
      ['panels.col.auth', '凭据'],
      ['panels.col.status', '状态'],
      ['panels.col.actions', '操作'],
      ['panels.test', '测试'],
      ['panels.testing', '测试中…'],
      ['panels.testAlling', '测试中…'],
      ['panels.setDefault', '设为默认'],
      ['panels.default', '默认'],
      ['panels.deleteConfirm', '删除面板「{alias}」？'],
      ['panels.auth.open', '应用凭据'],
      ['panels.auth.token', '令牌'],
      ['panels.status.ok', '正常'],
      ['panels.status.required', '凭据无效'],
      ['panels.status.forbidden', '权限不足'],
      ['panels.status.failed', '连接失败'],
      ['panels.status.unknown', '未测试'],
      ['panels.form.create', '新增面板'],
      ['panels.form.edit', '编辑面板「{alias}」'],
      ['panels.form.alias', '别名（唯一标识）'],
      ['panels.kind', '面板类型'],
      ['panels.kind.qinglong', '青龙面板'],
      ['panels.kind.daidai', '呆呆面板'],
      ['panels.form.appKey', 'app_key'],
      ['panels.form.appSecret', 'app_secret'],
      ['panels.field.appKey', 'app_key'],
      ['panels.field.appSecret', 'app_secret'],
      ['panels.field.clientId', 'client_id'],
      ['panels.field.clientSecret', 'client_secret'],
      ['envs.col.group', '分组'],
      ['envs.important', '重要'],
      ['panels.form.baseUrl', '面板地址'],
      ['panels.form.authKind', '凭据类型'],
      ['panels.form.clientId', 'client_id'],
      ['panels.form.clientSecret', 'client_secret'],
      ['panels.form.token', '访问令牌'],
      ['panels.form.keepSecret', '留空表示沿用已保存的密钥'],
      ['panels.form.timeoutMs', '请求超时（毫秒，可留空）'],
      ['panels.form.insecureTls', '跳过 TLS 证书校验（自签证书）'],
      ['panels.form.description', '备注（可留空）'],
      ['envs.search', '搜索变量名或值'],
      ['envs.add', '新增变量'],
      ['envs.col.name', '名称'],
      ['envs.col.value', '值'],
      ['envs.col.remarks', '备注'],
      ['envs.col.status', '状态'],
      ['envs.col.actions', '操作'],
      ['envs.empty', '没有环境变量。'],
      ['envs.reveal', '显示'],
      ['envs.hide', '隐藏'],
      ['envs.deleteConfirm', '删除 {count} 个环境变量？'],
      ['envs.form.create', '新增环境变量'],
      ['envs.form.edit', '编辑环境变量「{name}」'],
      ['envs.form.name', '变量名'],
      ['envs.form.nameHint', '以字母或下划线开头，只能包含字母、数字和下划线'],
      ['envs.form.value', '变量值'],
      ['envs.form.remarks', '备注（可留空）'],
      ['envs.form.labels', '标签（逗号分隔）'],
      ['crons.search', '搜索任务名或命令'],
      ['crons.add', '新增任务'],
      ['crons.col.name', '名称'],
      ['crons.col.command', '命令'],
      ['crons.col.schedule', '定时规则'],
      ['crons.col.status', '状态'],
      ['crons.col.last', '上次运行'],
      ['crons.col.actions', '操作'],
      ['crons.empty', '没有定时任务。'],
      ['crons.run', '运行'],
      ['crons.stop', '停止'],
      ['crons.log', '日志'],
      ['crons.autoRefresh', '自动刷新'],
      ['crons.deleteConfirm', '删除 {count} 个定时任务？'],
      ['crons.total', '共 {total} 条'],
      ['crons.prev', '上一页'],
      ['crons.next', '下一页'],
      ['crons.page', '第 {page} / {pages} 页'],
      ['crons.form.create', '新增定时任务'],
      ['crons.form.edit', '编辑任务「{name}」'],
      ['crons.form.name', '任务名称'],
      ['crons.form.command', '命令（如 task demo.js）'],
      ['crons.form.schedule', '定时规则（5/6 字段或 @daily 等宏）'],
      ['crons.form.labels', '标签（逗号分隔）'],
      ['crons.form.taskBefore', '前置命令（可留空）'],
      ['crons.form.taskAfter', '后置命令（可留空）'],
      ['crons.form.workDir', '工作目录（可留空）'],
      ['crons.form.multi', '允许同一任务多实例并行'],
      ['crons.form.preview', '未来触发'],
      ['crons.form.previewEmpty', '填写定时规则后显示未来触发时间'],
      ['log.title', '任务日志「{name}」'],
      ['log.empty', '暂无日志内容。'],
      ['log.status', '日志状态'],
      ['log.truncated', '（已截断，仅显示尾部）'],
    ])

    const en = defineDict('en', [
      ['entry.label', 'Panels'],
      ['entry.tooltip', 'Qinglong / Daidai panel console'],
      ['panel.title', 'Task panels'],
      ['panel.back', 'Back to conversation'],
      ['tab.panels', 'Hosts'],
      ['tab.envs', 'Environment'],
      ['tab.crons', 'Scheduled tasks'],
      ['common.loading', 'Loading…'],
      ['common.refresh', 'Refresh'],
      ['common.close', 'Close'],
      ['common.cancel', 'Cancel'],
      ['common.save', 'Save'],
      ['common.delete', 'Delete'],
      ['common.edit', 'Edit'],
      ['common.create', 'New'],
      ['common.search', 'Search'],
      ['common.none', '-'],
      ['current.panel', 'Panel: {alias} · {url}'],
      ['common.enabled', 'Enabled'],
      ['common.disabled', 'Disabled'],
      ['common.running', 'Running'],
      ['common.idle', 'Idle'],
      ['common.confirmDelete', 'Delete "{name}"?'],
      ['error.noPanel', 'No panel configured yet. Add one in the Hosts tab (Qinglong takes client_id / client_secret, Daidai takes app_key / app_secret).'],
      ['error.generic', 'Request failed'],
      ['notice.triggered', 'The panel accepted the trigger request (this does not mean the script finished).'],
      ['notice.saved', 'Saved.'],
      ['panels.empty', 'No panel configured. Use "New panel" to add a base URL and application credentials.'],
      ['panels.scopes.unknown', 'Not tested yet (use Test)'],
      ['panels.scopes.hint', 'Read probe only; writes use the same scope'],
      ['panels.scopes.title', 'Scopes'],
      ['panels.scopes.testedAt', 'Tested {time}'],
      ['panels.col.scopes', 'Scopes'],
      ['panels.status.untested', 'Not tested'],
      ['scope.envs', 'Environment'],
      ['scope.crons', 'Tasks'],
      ['scope.tasks', 'Tasks'],
      ['scope.subscriptions', 'Subscriptions'],
      ['scope.configs', 'Config files'],
      ['scope.scripts', 'Scripts'],
      ['scope.logs', 'Logs'],
      ['scope.dependencies', 'Dependencies'],
      ['scope.dashboard', 'Dashboard'],
      ['scope.system', 'System'],
      ['scope.backup', 'Backups'],
      ['scope.state.ok', 'granted'],
      ['scope.state.forbidden', 'missing'],
      ['scope.state.error', 'probe failed'],
      ['scope.state.timeout', 'timed out'],
      ['scope.state.public', 'public'],
      ['scope.state.na', 'n/a'],
      ['panels.add', 'New panel'],
      ['panels.testAll', 'Test all'],
      ['panels.col.alias', 'Alias'],
      ['panels.col.kind', 'Type'],
      ['panels.col.url', 'Base URL'],
      ['panels.col.auth', 'Credential'],
      ['panels.col.status', 'Status'],
      ['panels.col.actions', 'Actions'],
      ['panels.test', 'Test'],
      ['panels.testing', 'Testing…'],
      ['panels.testAlling', 'Testing…'],
      ['panels.setDefault', 'Set default'],
      ['panels.default', 'default'],
      ['panels.deleteConfirm', 'Delete panel "{alias}"?'],
      ['panels.auth.open', 'App credential'],
      ['panels.auth.token', 'Token'],
      ['panels.status.ok', 'OK'],
      ['panels.status.required', 'Credential rejected'],
      ['panels.status.forbidden', 'Scope missing'],
      ['panels.status.failed', 'Unreachable'],
      ['panels.status.unknown', 'Not tested'],
      ['panels.form.create', 'New panel'],
      ['panels.form.edit', 'Edit panel "{alias}"'],
      ['panels.form.alias', 'Alias (unique id)'],
      ['panels.kind', 'Panel type'],
      ['panels.kind.qinglong', 'Qinglong'],
      ['panels.kind.daidai', 'Daidai'],
      ['panels.form.appKey', 'app_key'],
      ['panels.form.appSecret', 'app_secret'],
      ['panels.field.appKey', 'app_key'],
      ['panels.field.appSecret', 'app_secret'],
      ['panels.field.clientId', 'client_id'],
      ['panels.field.clientSecret', 'client_secret'],
      ['envs.col.group', 'Group'],
      ['envs.important', 'important'],
      ['panels.form.baseUrl', 'Base URL'],
      ['panels.form.authKind', 'Credential type'],
      ['panels.form.clientId', 'client_id'],
      ['panels.form.clientSecret', 'client_secret'],
      ['panels.form.token', 'Access token'],
      ['panels.form.keepSecret', 'Leave empty to keep the saved secret'],
      ['panels.form.timeoutMs', 'Request timeout in ms (optional)'],
      ['panels.form.insecureTls', 'Skip TLS certificate verification (self-signed)'],
      ['panels.form.description', 'Note (optional)'],
      ['envs.search', 'Search name or value'],
      ['envs.add', 'New variable'],
      ['envs.col.name', 'Name'],
      ['envs.col.value', 'Value'],
      ['envs.col.remarks', 'Remarks'],
      ['envs.col.status', 'Status'],
      ['envs.col.actions', 'Actions'],
      ['envs.empty', 'No environment variables.'],
      ['envs.reveal', 'Show'],
      ['envs.hide', 'Hide'],
      ['envs.deleteConfirm', 'Delete {count} environment variable(s)?'],
      ['envs.form.create', 'New environment variable'],
      ['envs.form.edit', 'Edit variable "{name}"'],
      ['envs.form.name', 'Name'],
      ['envs.form.nameHint', 'Start with a letter or underscore; letters, digits and underscores only'],
      ['envs.form.value', 'Value'],
      ['envs.form.remarks', 'Remarks (optional)'],
      ['envs.form.labels', 'Labels (comma separated)'],
      ['crons.search', 'Search name or command'],
      ['crons.add', 'New task'],
      ['crons.col.name', 'Name'],
      ['crons.col.command', 'Command'],
      ['crons.col.schedule', 'Schedule'],
      ['crons.col.status', 'Status'],
      ['crons.col.last', 'Last run'],
      ['crons.col.actions', 'Actions'],
      ['crons.empty', 'No scheduled tasks.'],
      ['crons.run', 'Run'],
      ['crons.stop', 'Stop'],
      ['crons.log', 'Log'],
      ['crons.autoRefresh', 'Auto refresh'],
      ['crons.deleteConfirm', 'Delete {count} scheduled task(s)?'],
      ['crons.total', '{total} total'],
      ['crons.prev', 'Previous'],
      ['crons.next', 'Next'],
      ['crons.page', 'Page {page} / {pages}'],
      ['crons.form.create', 'New scheduled task'],
      ['crons.form.edit', 'Edit task "{name}"'],
      ['crons.form.name', 'Task name'],
      ['crons.form.command', 'Command (for example task demo.js)'],
      ['crons.form.schedule', 'Schedule (5/6 fields or a macro such as @daily)'],
      ['crons.form.labels', 'Labels (comma separated)'],
      ['crons.form.taskBefore', 'Before command (optional)'],
      ['crons.form.taskAfter', 'After command (optional)'],
      ['crons.form.workDir', 'Working directory (optional)'],
      ['crons.form.multi', 'Allow multiple instances of this task'],
      ['crons.form.preview', 'Next triggers'],
      ['crons.form.previewEmpty', 'Enter a schedule to preview its next triggers'],
      ['log.title', 'Task log "{name}"'],
      ['log.empty', 'No log content yet.'],
      ['log.status', 'Log status'],
      ['log.truncated', '(truncated, tail only)'],
    ])

    /**
     * Module-level dictionary self-check. A repeated key never reaches runtime
     * as a duplicate (the object collapses it), so the pair lists kept by
     * `defineDict` are compared instead. Warnings only: a bad dictionary string
     * must never keep the plugin from loading.
     */
    function auditDictionaries() {
      for (const { name, pairs, dict } of DICTS) {
        const seen = new Set()
        const duplicated = []
        for (const [key] of pairs) {
          if (seen.has(key)) duplicated.push(key)
          else seen.add(key)
        }
        const keys = Object.keys(dict)
        if (duplicated.length > 0) {
          console.warn(`[dsh-cronops] i18n "${name}": duplicate key(s) ${duplicated.map(key => `"${key}"`).join(', ')} — only the last entry wins`)
        }
        if (keys.length !== seen.size) {
          console.warn(`[dsh-cronops] i18n "${name}": ${pairs.length} entries collapsed into ${keys.length} keys`)
        }
      }
    }

    try {
      auditDictionaries()
    } catch (failure) {
      console.warn('[dsh-cronops] i18n audit skipped:', failure)
    }

    /** Interpolate `{name}` placeholders. */
    function interpolate(dict, key, values) {
      const text = dict[key] ?? key
      if (values === undefined) return text
      return text.replace(/\{(\w+)\}/g, (_match, name) => {
        const value = values[name]
        return value === undefined ? `{${name}}` : String(value)
      })
    }

    /** Document-language fallback, used before the locale service is wired. */
    function fallbackTranslate(key, values) {
      const lang = typeof document !== 'undefined' ? (document.documentElement.lang || 'zh') : 'zh'
      return interpolate(lang.toLowerCase().startsWith('en') ? en : zh, key, values)
    }

    let runtimeTranslate = fallbackTranslate

    /** Translate a key in the active language. */
    function tt(key, values) {
      try {
        return runtimeTranslate(key, values)
      } catch {
        return fallbackTranslate(key, values)
      }
    }

    // ------------------------------------------------------------ panel kinds

    /**
     * Built-in panel-kind metadata, used only when the host response carries no
     * `kinds` (an older host). It mirrors what the host sends today, so the form
     * keeps working unchanged until the host half ships the new field.
     */
    const FALLBACK_KINDS = [
      {
        kind: 'qinglong',
        label: '青龙',
        authKind: 'open',
        credentialFields: [
          { key: 'appKey', i18nKey: 'panels.field.clientId', secret: false },
          { key: 'appSecret', i18nKey: 'panels.field.clientSecret', secret: true },
        ],
        scopeOrder: ['envs', 'crons', 'subscriptions', 'configs', 'scripts', 'logs', 'dependencies', 'system', 'dashboard'],
        ignoredScopes: [],
        supportsWorkDir: true,
      },
      {
        kind: 'daidai',
        label: '呆呆',
        authKind: 'open',
        credentialFields: [
          { key: 'appKey', i18nKey: 'panels.field.appKey', secret: false },
          { key: 'appSecret', i18nKey: 'panels.field.appSecret', secret: true },
        ],
        scopeOrder: ['tasks', 'envs', 'logs', 'scripts', 'subscriptions', 'system', 'backup'],
        ignoredScopes: ['notifications'],
        supportsWorkDir: false,
      },
    ]

    /** The host kind list, or the built-in fallback when it is missing/empty. */
    function normalizeKinds(value) {
      if (!Array.isArray(value)) return FALLBACK_KINDS
      const usable = value.filter(entry => entry !== null && typeof entry === 'object'
        && typeof entry.kind === 'string' && entry.kind !== '')
      return usable.length === 0 ? FALLBACK_KINDS : usable
    }

    /**
     * The credential shape a product needs. `open` is a key/secret pair the
     * host exchanges for a token; `token` is a token pasted in from the panel.
     */
    function kindAuthKind(kinds, kind) {
      return kindMeta(kinds, kind).authKind === 'token' ? 'token' : 'open'
    }

    /** Label of the single-token box: the product's own name for it, if it has one. */
    function tokenLabel(kinds, kind) {
      const field = kindAuthKind(kinds, kind) === 'token' ? kindFields(kinds, kind)[0] : undefined
      return field === undefined ? tt('panels.form.token') : fieldLabel(field)
    }

    /** Metadata of one kind; an unknown kind still yields a usable empty shell. */
    function kindMeta(kinds, kind) {
      const list = Array.isArray(kinds) && kinds.length > 0 ? kinds : FALLBACK_KINDS
      const found = list.find(entry => entry !== null && typeof entry === 'object' && entry.kind === kind)
      if (found !== undefined) return found
      const name = typeof kind === 'string' ? kind : ''
      return {
        kind: name,
        label: name,
        credentialFields: [],
        scopeOrder: [],
        ignoredScopes: [],
        supportsWorkDir: false,
      }
    }

    /** First configured kind: the default for a brand-new panel. */
    function defaultKind(kinds) {
      const list = Array.isArray(kinds) && kinds.length > 0 ? kinds : FALLBACK_KINDS
      return typeof list[0].kind === 'string' ? list[0].kind : ''
    }

    /** `tt` with a literal fallback for a key the dictionary may not carry. */
    function ttOr(key, literal) {
      if (typeof key !== 'string' || key === '') return literal
      const text = tt(key)
      return typeof text === 'string' && text !== '' && text !== key ? text : literal
    }

    /** Kind label: dictionary key `panels.kind.<kind>`, else the host label. */
    function kindLabel(kinds, kind) {
      if (typeof kind !== 'string' || kind === '') return ''
      return ttOr('panels.kind.' + kind, kindMeta(kinds, kind).label ?? kind)
    }

    /** `appKey` -> `app_key`: keeps the old mono placeholder look. */
    function fieldPlaceholder(field) {
      return typeof field.key === 'string' ? field.key.replace(/([A-Z])/g, '_$1').toLowerCase() : ''
    }

    /** Credential fields of a kind, as the host described them. */
    function kindFields(kinds, kind) {
      const fields = kindMeta(kinds, kind).credentialFields
      return Array.isArray(fields)
        ? fields.filter(field => field !== null && typeof field === 'object'
          && typeof field.key === 'string' && field.key !== '')
        : []
    }

    /** Field label: literal `label`, else its i18n key, else the field name. */
    function fieldLabel(field) {
      if (typeof field.label === 'string' && field.label !== '') return field.label
      return ttOr(field.i18nKey, fieldPlaceholder(field))
    }

    /** Scope badge order for a kind. */
    function kindScopeOrder(kinds, kind) {
      const order = kindMeta(kinds, kind).scopeOrder
      return Array.isArray(order) ? order.filter(name => typeof name === 'string' && name !== '') : []
    }

    /** Scopes a kind never displays. */
    function kindIgnoredScopes(kinds, kind) {
      const ignored = kindMeta(kinds, kind).ignoredScopes
      return Array.isArray(ignored) ? ignored.filter(name => typeof name === 'string' && name !== '') : []
    }

    /** Whether the kind's cron form shows the work_dir field. */
    function kindSupportsWorkDir(kinds, kind) {
      return kindMeta(kinds, kind).supportsWorkDir === true
    }

    // ----------------------------------------------------------------- api

    /** Encode a query object, dropping empty values. */
    function query(params) {
      const search = new URLSearchParams()
      for (const [key, value] of Object.entries(params ?? {})) {
        if (value === undefined || value === null || value === '') continue
        search.set(key, String(value))
      }
      const text = search.toString()
      return text === '' ? '' : '?' + text
    }

    /** Page size for the scheduled-task table. */
    const CRON_PAGE_SIZE = 20

    /**
     * One resource read bound to one component. It refetches when a key in
     * `deps` changes or when the caller asks for `reload()` (loading state) or
     * `refresh()` (silent, for polling). `select` narrows the payload into the
     * shape the component renders.
     * @param load - () => Promise<payload>; the newest closure wins.
     * @param select - payload => value.
     * @param deps - refetch keys.
     */
    function useLoader(load, select, deps) {
      const [value, setValue] = useState(undefined)
      const [state, setState] = useState({ loading: true, error: '' })
      const latest = useRef({ load, select })
      latest.current = { load, select }
      const generation = useRef(0)
      const run = useCallback(silent => {
        const id = ++generation.current
        if (silent !== true) setState(current => ({ ...current, loading: true, error: '' }))
        return latest.current.load()
          .then(payload => {
            if (generation.current === id) setValue(latest.current.select(payload))
          })
          .catch(failure => {
            if (generation.current !== id || silent === true) return
            setValue(undefined)
            setState({ loading: false, error: errorText(failure) })
          })
          .finally(() => {
            if (generation.current === id && silent !== true) setState(current => ({ ...current, loading: false }))
          })
      }, [])
      useEffect(() => {
        void run(false)
        // Latest load/select are read through a ref, so only the keys refetch.
      }, deps)
      useEffect(() => () => { generation.current += 1 }, [])
      return {
        value,
        loading: state.loading,
        error: state.error,
        reload: useCallback(() => run(false), [run]),
        refresh: useCallback(() => run(true), [run]),
      }
    }

    /** One message string out of a thrown value. */
    const errorText = failure => (failure instanceof Error ? failure.message : String(failure))

    /** One JSON round trip against the host route family. */
    async function request(path, options = {}) {
      const init = {
        method: options.method ?? 'GET',
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      }
      if (options.body !== undefined) {
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(options.body)
      }
      let response
      try {
        response = await fetch(path + query(options.query), init)
      } catch (error) {
        throw new Error('无法连接 dsh 宿主（' + errorText(error) + '）')
      }
      const text = await response.text()
      let payload
      try {
        payload = text === '' ? {} : JSON.parse(text)
      } catch {
        throw new Error(`HTTP ${response.status}: ${text.slice(0, 160)}`)
      }
      if (!response.ok) {
        throw new Error(typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`)
      }
      return payload
    }

    /** The host route family, one method per operation. */
    /** Panel-catalogue route, used by five verbs. */
    const PANELS_PATH = API_BASE + '/panels'

    const api = {
      panels: () => request(PANELS_PATH),
      createPanel: payload => request(PANELS_PATH, { method: 'POST', body: payload }),
      updatePanel: (alias, payload) => request(PANELS_PATH, { method: 'PATCH', query: { alias }, body: payload }),
      deletePanel: alias => request(PANELS_PATH, { method: 'DELETE', query: { alias } }),
      setDefaultPanel: alias => request(API_BASE + '/panels/default', { method: 'POST', body: { alias } }),
      test: (alias, refresh) => request(API_BASE + '/test', { method: 'POST', body: { alias, ...(refresh === true ? { refresh: true } : {}) } }),
      envs: (alias, searchValue) => request(API_BASE + '/envs', { query: { alias, searchValue } }),
      createEnvs: (alias, envs) => request(API_BASE + '/envs', { method: 'POST', body: { alias, envs } }),
      updateEnv: (alias, env) => request(API_BASE + '/envs', { method: 'PATCH', body: { alias, env } }),
      deleteEnvs: (alias, ids) => request(API_BASE + '/envs', { method: 'DELETE', body: { alias, ids } }),
      envsAction: (alias, action, ids) => request(API_BASE + '/envs/action', { method: 'POST', body: { alias, action, ids } }),
      crons: (alias, extra) => request(API_BASE + '/crons', { query: { alias, ...extra } }),
      cron: (alias, id) => request(API_BASE + '/crons/item', { query: { alias, id } }),
      createCron: (alias, cron) => request(API_BASE + '/crons', { method: 'POST', body: { alias, cron } }),
      updateCron: (alias, id, patch) => request(API_BASE + '/crons', { method: 'PATCH', body: { alias, id, patch } }),
      deleteCrons: (alias, ids) => request(API_BASE + '/crons', { method: 'DELETE', body: { alias, ids } }),
      cronsAction: (alias, action, ids) => request(API_BASE + '/crons/action', { method: 'POST', body: { alias, action, ids } }),
      cronLog: (alias, id, extra) => request(API_BASE + '/crons/log', { query: { alias, id, ...extra } }),
      preview: (alias, schedule) => request(API_BASE + '/crons/preview', { query: { alias, schedule } }),
    }

    // ---------------------------------------------------------- formatting

    /** Format a panel timestamp (unix seconds, ms, or a date string). */
    function fmtTime(value) {
      if (value === undefined || value === null || value === '') return tt('common.none')
      let ms
      if (typeof value === 'number') ms = value > 1e12 ? value : value * 1000
      else if (typeof value === 'string' && /^\d+$/.test(value)) ms = Number(value) > 1e12 ? Number(value) : Number(value) * 1000
      else ms = Date.parse(value)
      if (!Number.isFinite(ms) || ms <= 0) return tt('common.none')
      try {
        return new Date(ms).toLocaleString()
      } catch {
        return tt('common.none')
      }
    }

    /** Whether an environment row is disabled (status 1). */
    function envDisabled(env) {
      return env.status === 1 || env.status === '1' || env.isDisabled === 1 || env.isDisabled === true
    }

    /** Cron status label (0 running, 1 idle, 2 disabled, 3 queued). */
    function cronStatusText(cron) {
      const status = Number(cron.status)
      if (cron.isDisabled === 1 || cron.isDisabled === true || status === 2) return tt('common.disabled')
      if (status === 0) return tt('common.running')
      if (status === 3) return tt('common.running')
      return tt('common.idle')
    }

    /** Split a comma separated label list. */
    function splitLabels(text) {
      return String(text ?? '').split(',').map(item => item.trim()).filter(item => item !== '')
    }

    // ---------------------------------------------------------- controller

    /**
     * Panel view state, kept outside React because the layout unmounts a
     * keyed page whenever another sidebar row is selected: local state would
     * lose the active tab and the chosen panel on every switch.
     * @param selectPanel - layout navigation face (null returns the column to
     *   the conversation); a shell without it is a no-op.
     */
    function createController(selectPanel) {
      const listeners = new Set()
      // `panels`, `alias` and `revision` live here so the header picker and the
      // two data tabs read ONE source of truth. A panel list loaded anywhere
      // (dialog save, delete, dropdown open) updates every consumer at once,
      // and `revision` is what a tab keys its refetch on.
      let state = { tab: 'panels', alias: '', notice: undefined, panels: [], defaultAlias: '', revision: 0 }
      let snapshot = { ...state }
      const commit = () => {
        snapshot = { ...state }
        for (const listener of [...listeners]) listener()
      }
      const signatureOf = list => list.map(panel => `${panel.alias}:${panel.isDefault === true ? 1 : 0}`).join('|')
      return {
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        getSnapshot() {
          return snapshot
        },
        setTab(tab) {
          if (state.tab === tab) return
          state.tab = tab
          commit()
        },
        setPanels(panels, defaultAlias) {
          const changed = signatureOf(state.panels) !== signatureOf(panels)
          state.panels = panels
          state.defaultAlias = defaultAlias ?? ''
          if (changed) state.revision += 1
          commit()
        },
        selectAlias(alias) {
          if (state.alias === alias) return
          state.alias = alias
          state.revision += 1
          commit()
        },
        /** Force every data tab to refetch (same alias, new content). */
        touch() {
          state.revision += 1
          commit()
        },
        notice(kind, text) {
          state.notice = { kind, text, id: Date.now() }
          commit()
        },
        clearNotice() {
          if (state.notice === undefined) return
          state.notice = undefined
          commit()
        },
        back() {
          try {
            selectPanel(null)
          } catch {
            // A shell without the navigation face keeps what it was showing.
          }
        },
      }
    }

    // ----------------------------------------------------------------- css

    const STYLE_ID = 'dsh-cronops-style'

    const CSS = `
.dq-view{display:flex;flex-direction:column;min-height:0;height:100%;min-width:0;overflow:hidden;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px}
.dq-header{display:flex;align-items:center;gap:8px;padding:10px 16px;border-bottom:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap}
.dq-back{display:inline-flex;align-items:center;gap:4px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;padding:3px 8px;border-radius:6px;cursor:pointer}
.dq-back:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dq-title{font-size:14px;font-weight:600;margin:0 4px 0 0}
.dq-spacer{flex:1}
.dq-select{font:inherit;font-size:12px;padding:3px 6px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.dq-pill{display:inline-flex;align-items:center;gap:4px;font-size:11px;line-height:1;padding:4px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dq-pill[data-kind="ok"]{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.dq-pill[data-kind="warn"]{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.dq-pill[data-kind="error"]{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.dq-tabs{display:flex;gap:2px;padding:0 16px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dq-tab{border:0;background:transparent;font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary);padding:8px 12px;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px}
.dq-tab:hover{color:var(--dsw-alias-label-primary)}
.dq-tab[data-active]{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-brand-primary);font-weight:600}
.dq-content{display:flex;flex-direction:column;gap:12px;padding:14px 16px;min-height:0;min-width:0;flex:1;overflow:auto}
.dq-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dq-input{font:inherit;font-size:12px;padding:5px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);min-width:0}
.dq-input:focus{outline:1px solid var(--dsw-alias-brand-primary);outline-offset:0}
.dq-input[data-grow]{flex:1;min-width:180px}
.dq-textarea{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;min-height:64px;resize:vertical}
.dq-btn{display:inline-flex;align-items:center;gap:4px;font:inherit;font-size:12px;padding:4px 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;white-space:nowrap}
.dq-btn:hover{background:var(--dsw-alias-bg-layer-2)}
.dq-btn:disabled{opacity:.5;cursor:default}
.dq-btn[data-variant="primary"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.dq-btn[data-variant="danger"]{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.dq-btn[data-variant="ghost"]{border-color:transparent;color:var(--dsw-alias-label-secondary)}
.dq-linkBtn{border:0;background:transparent;color:var(--dsw-alias-brand-primary);font:inherit;font-size:12px;cursor:pointer;padding:0 4px}
.dq-linkBtn:hover{text-decoration:underline}
.dq-danger{color:var(--dsw-alias-state-error-primary)}
.dq-tableWrap{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;overflow:auto;max-width:100%;background:var(--dsw-alias-bg-layer-1)}
.dq-table{width:100%;max-width:100%;table-layout:fixed;border-collapse:collapse;font-size:12px}
.dq-table th{position:sticky;top:0;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);text-align:left;font-weight:500;padding:7px 10px;white-space:nowrap;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dq-table td{padding:7px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);vertical-align:top;overflow-wrap:anywhere;word-break:break-word}
.dq-table tr:last-child td{border-bottom:0}
.dq-table tbody tr:hover{background:var(--dsw-alias-bg-layer-2)}
.dq-cellName{font-weight:500}
.dq-cellMuted{color:var(--dsw-alias-label-secondary)}
.dq-cellWrap{overflow-wrap:anywhere;word-break:break-word;white-space:pre-wrap;max-width:100%}
.dq-cellEllipsis{display:block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dq-rowBusy{opacity:.55}
.dq-cellScroll{max-height:8em;overflow:auto}
.dq-where{font-size:11px;color:var(--dsw-alias-label-secondary);max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dq-chips{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px;min-width:0}
.dq-chip{font-size:10px;line-height:1;padding:3px 6px;border-radius:4px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dq-chip[data-kind="ok"]{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.dq-chip[data-kind="warn"]{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.dq-chip[data-kind="error"]{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.dq-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;white-space:pre-wrap;word-break:break-all}
.dq-clip{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block;vertical-align:bottom}
.dq-actions{display:flex;gap:2px;flex-wrap:wrap}
.dq-empty{padding:24px;text-align:center;color:var(--dsw-alias-label-secondary);border:1px dashed var(--dsw-alias-border-l2);border-radius:8px}
.dq-error{padding:8px 10px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:6px;color:var(--dsw-alias-state-error-primary);font-size:12px;white-space:pre-wrap}
.dq-notice{display:flex;align-items:flex-start;gap:8px;padding:8px 10px;border-radius:6px;font-size:12px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
.dq-notice[data-kind="ok"]{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
.dq-notice[data-kind="error"]{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.dq-noticeText{flex:1;color:inherit;white-space:pre-wrap}
.dq-badge{font-size:10px;padding:1px 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);margin-left:6px}
.dq-backdrop{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;padding:24px;background:color-mix(in srgb, var(--dsw-alias-bg-base) 55%, transparent)}
.dq-dialog{width:min(560px,100%);max-height:min(80vh,720px);display:flex;flex-direction:column;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;box-shadow:0 16px 40px color-mix(in srgb, var(--dsw-alias-bg-base) 45%, transparent)}
.dq-dialogHead{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dq-dialogTitle{margin:0;font-size:13px;font-weight:600;flex:1}
.dq-dialogBody{display:flex;flex-direction:column;gap:10px;padding:14px;overflow:auto}
.dq-dialogFoot{display:flex;justify-content:flex-end;gap:8px;padding:12px 14px;border-top:1px solid var(--dsw-alias-border-l1)}
.dq-field{display:flex;flex-direction:column;gap:4px}
.dq-fieldLabel{font-size:11px;color:var(--dsw-alias-label-secondary)}
.dq-hint{font-size:11px;color:var(--dsw-alias-label-secondary)}
.dq-check{display:flex;align-items:center;gap:6px;font-size:12px}
.dq-pager{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-secondary);font-size:12px}
.dq-log{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.5;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:10px;max-height:52vh;overflow:auto;white-space:pre-wrap;word-break:break-word}
.dq-grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
@media (max-width:640px){.dq-grid2{grid-template-columns:1fr}}
.dq-loading{color:var(--dsw-alias-label-secondary);font-size:12px}
`

    // ------------------------------------------------------------ ui atoms

    /** A labelled form row. */
    function Field(props) {
      return h('label', { className: 'dq-field' },
        h('span', { className: 'dq-fieldLabel' }, props.label),
        props.children,
        props.hint === undefined ? null : h('span', { className: 'dq-hint' }, props.hint))
    }

    /** Text/password input with the panel look. */
    function Input(props) {
      const { grow, ...rest } = props
      return h('input', { ...rest, className: 'dq-input', 'data-grow': grow === true ? '' : undefined })
    }

    /** One button. */
    function Button(props) {
      const { variant, ...rest } = props
      return h('button', { ...rest, type: rest.type ?? 'button', className: 'dq-btn', 'data-variant': variant })
    }

    /** A status pill. */
    function Pill({ kind, children }) {
      return h('span', { className: 'dq-pill', 'data-kind': kind }, children)
    }

    /** Modal dialog with Escape and backdrop dismissal. */
    function Dialog({ title, onClose, children, footer }) {
      useEffect(() => {
        const onKey = event => {
          if (event.key === 'Escape') onClose()
        }
        document.addEventListener('keydown', onKey)
        return () => { document.removeEventListener('keydown', onKey) }
      }, [onClose])
      return h('div', {
        className: 'dq-backdrop',
        onMouseDown: event => { if (event.target === event.currentTarget) onClose() },
      },
      h('div', { className: 'dq-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
        h('div', { className: 'dq-dialogHead' },
          h('h3', { className: 'dq-dialogTitle' }, title),
          h(Button, { variant: 'ghost', onClick: onClose, 'aria-label': tt('common.close') }, '×')),
        h('div', { className: 'dq-dialogBody' }, children),
        footer === undefined ? null : h('div', { className: 'dq-dialogFoot' }, footer)))
    }

    /** One inline failure banner. */
    function ErrorBanner({ text, onRetry }) {
      if (text === undefined || text === null || text === '') return null
      return h('div', { className: 'dq-error' }, text,
        onRetry === undefined ? null : h('div', { style: { marginTop: 6 } },
          h(Button, { variant: 'ghost', onClick: onRetry }, tt('common.refresh'))))
    }

    /** One success/failure notice. */
    function Notice({ notice, onClose }) {
      // Success feedback is transient (the table already shows the result);
      // a failure must stay visible until the user dismisses it. The effect
      // keys on the notice object, not on `onClose`, so a re-render cannot
      // restart the timer.
      useEffect(() => {
        if (notice === undefined || notice === null || notice.kind !== 'ok') return undefined
        const timer = setTimeout(() => { onClose() }, 2500)
        return () => clearTimeout(timer)
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [notice])
      if (notice === undefined || notice === null) return null
      return h('div', { className: 'dq-notice', 'data-kind': notice.kind },
        h('span', { className: 'dq-noticeText' }, notice.text),
        h(Button, { variant: 'ghost', onClick: onClose, 'aria-label': tt('common.close') }, '×'))
    }

    // ---------------------------------------------------------- panels tab

    /** Panel create/edit dialog. */
    function PanelDialog(props) {
      const editing = props.panel !== undefined
      const kinds = normalizeKinds(props.kinds)
      const [alias, setAlias] = useState(editing ? props.panel.alias : '')
      const [kind, setKind] = useState(editing ? props.panel.kind : defaultKind(kinds))
      const [baseUrl, setBaseUrl] = useState(editing ? props.panel.baseUrl : 'http://')
      const [authKind, setAuthKind] = useState(() => (editing
        ? (props.panel.auth?.kind ?? kindAuthKind(kinds, props.panel.kind))
        : kindAuthKind(kinds, defaultKind(kinds))))
      // Credentials are keyed by the metadata's `credentialFields[].key`, so the
      // submitted auth object follows the host contract instead of one hardcoded
      // appKey/appSecret pair. The secret is write-only: the store never returns
      // it, so an edit always starts with an empty secret box.
      const [credentials, setCredentials] = useState(() => {
        const seed = {}
        for (const field of kindFields(kinds, editing ? props.panel.kind : defaultKind(kinds))) {
          const saved = editing && props.panel.auth?.kind === 'open' ? props.panel.auth[field.key] : undefined
          seed[field.key] = typeof saved === 'string' ? saved : ''
        }
        return seed
      })
      const [token, setToken] = useState('')
      const [timeoutMs, setTimeoutMs] = useState(editing && props.panel.timeoutMs !== undefined ? String(props.panel.timeoutMs) : '')
      const [insecureTls, setInsecureTls] = useState(editing ? props.panel.insecureTls === true : false)
      const [description, setDescription] = useState(editing ? (props.panel.description ?? '') : '')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')

      const save = async () => {
        setBusy(true)
        setError('')
        try {
          const payload = {
            kind,
            baseUrl,
            insecureTls,
            description,
          }
          if (timeoutMs.trim() !== '') payload.timeoutMs = Number(timeoutMs)
          if (!editing) payload.alias = alias.trim()
          if (authKind === 'open') {
            const fields = kindFields(kinds, kind)
            const values = fields.map(field => ({ field, value: String(credentials[field.key] ?? '').trim() }))
            if (values.some(item => item.value !== '')) {
              // The secret is write-only, so an edit that keeps it leaves the box
              // empty; any other blank field is a half-filled credential.
              if (editing && values.some(item => item.value === '')) {
                throw new Error(tt('panels.form.keepSecret'))
              }
              const auth = { kind: 'open' }
              for (const item of values) auth[item.field.key] = item.value
              payload.auth = auth
            } else if (!editing) {
              throw new Error(`${values.map(item => fieldLabel(item.field)).join(' / ')} 不能为空`)
            }
          } else {
            if (token.trim() !== '') payload.auth = { kind: 'token', token: token.trim() }
            else if (!editing) throw new Error(tt('panels.form.token') + ' 不能为空')
          }
          if (editing) await props.api.updatePanel(props.panel.alias, payload)
          else await props.api.createPanel(payload)
          await props.onSaved()
        } catch (failure) {
          setError(errorText(failure))
        } finally {
          setBusy(false)
        }
      }

      return h(Dialog, {
        title: editing ? tt('panels.form.edit', { alias: props.panel.alias }) : tt('panels.form.create'),
        onClose: props.onClose,
        footer: [
          h(Button, { key: 'cancel', onClick: props.onClose }, tt('common.cancel')),
          h(Button, { key: 'save', variant: 'primary', disabled: busy, onClick: save }, busy ? tt('common.loading') : tt('common.save')),
        ],
      },
      error === '' ? null : h(ErrorBanner, { text: error }),
      h(Field, { label: tt('panels.form.alias') },
        h(Input, { value: alias, disabled: editing, placeholder: 'ql', onChange: event => setAlias(event.target.value) })),
      h(Field, { label: tt('panels.kind') },
        h('select', {
          className: 'dq-select',
          value: kind,
          onChange: event => {
            const next = event.target.value
            setKind(next)
            // Credential *shape* is a product property too, not a constant.
            setAuthKind(kindAuthKind(kinds, next))
            // Switching product changes the credential fields: keep whatever the
            // user already typed under a key the new product also uses.
            setCredentials(current => {
              const seed = {}
              for (const field of kindFields(kinds, next)) seed[field.key] = current[field.key] ?? ''
              return seed
            })
          },
        },
        kinds.map(entry => h('option', { key: entry.kind, value: entry.kind }, kindLabel(kinds, entry.kind))))),
      h(Field, { label: tt('panels.form.baseUrl'), hint: '例如 http://panel-host:5700' },
        h(Input, { value: baseUrl, placeholder: 'http://host:5700', onChange: event => setBaseUrl(event.target.value) })),
      h(Field, { label: tt('panels.form.authKind') },
        h('select', {
          className: 'dq-select',
          value: authKind,
          onChange: event => setAuthKind(event.target.value),
        },
        h('option', { value: 'open' }, tt('panels.auth.open')),
        h('option', { value: 'token' }, tt('panels.auth.token')))),
      authKind === 'open'
        ? h(React.Fragment, null,
          kindFields(kinds, kind).map(field => h(Field, {
            key: field.key,
            label: fieldLabel(field),
            hint: editing && field.secret === true ? tt('panels.form.keepSecret') : undefined,
          },
          h(Input, {
            type: field.secret === true ? 'password' : undefined,
            value: credentials[field.key] ?? '',
            placeholder: fieldPlaceholder(field),
            onChange: event => setCredentials(current => ({ ...current, [field.key]: event.target.value })),
          }))))
        : h(Field, { label: tokenLabel(kinds, kind), hint: editing ? tt('panels.form.keepSecret') : undefined },
          h(Input, { type: 'password', value: token, placeholder: 'token', onChange: event => setToken(event.target.value) })),
      h('div', { className: 'dq-grid2' },
        h(Field, { label: tt('panels.form.timeoutMs') },
          h(Input, { value: timeoutMs, inputMode: 'numeric', placeholder: '15000', onChange: event => setTimeoutMs(event.target.value) })),
        h(Field, { label: tt('panels.form.description') },
          h(Input, { value: description, onChange: event => setDescription(event.target.value) }))),
      h('label', { className: 'dq-check' },
        h('input', { type: 'checkbox', checked: insecureTls, onChange: event => setInsecureTls(event.target.checked) }),
        tt('panels.form.insecureTls')))
    }

    /** The hosts tab: panel connections. */
    function PanelsTab({ panels, api, reload, notice, testOne, testAll, testingAlias, testingAll, kinds }) {
      const [dialog, setDialog] = useState(undefined)

      const remove = async panel => {
        if (!window.confirm(tt('panels.deleteConfirm', { alias: panel.alias }))) return
        try {
          await api.deletePanel(panel.alias)
          await reload({ dropAlias: panel.alias })
        } catch (failure) {
          notice('error', errorText(failure))
        }
      }
      const makeDefault = async panel => {
        try {
          await api.setDefaultPanel(panel.alias)
          await reload()
        } catch (failure) {
          notice('error', errorText(failure))
        }
      }

      /** Connection state of one row. */
      /** Row status from the persisted probe (no live query). */
      const rowState = result => {
        if (result === undefined) return { kind: 'unknown', label: tt('panels.status.untested') }
        if (result.reachable !== true) return { kind: 'error', label: tt('panels.status.failed') }
        if (result.auth === 'ok') return { kind: 'ok', label: tt('panels.status.ok') }
        if (result.auth === 'forbidden') return { kind: 'warn', label: tt('panels.status.forbidden') }
        return { kind: 'warn', label: tt('panels.status.required') }
      }

      /** Scope chips (Chinese labels) from the persisted probe. */
      const scopeChips = (test, kind) => {
        const scopes = test?.scopes
        if (typeof scopes !== 'object' || scopes === null) {
          return h('div', { className: 'dq-cellMuted' }, tt('panels.scopes.unknown'))
        }
        // Badge order and the hidden set come from the host's kind metadata, so a
        // product that reports a scope this build has never heard of still gets a
        // sensible position instead of a leading one.
        const order = kindScopeOrder(kinds, kind)
        const states = {
          ok: ['ok', '✓'],
          public: ['ok', '✓'],
          forbidden: ['warn', '✗'],
          timeout: ['warn', '⏱'],
          error: ['error', '?'],
          'n/a': ['unknown', '–'],
        }
        // Preferred order, then any extra scope the panel reports: a new scope
        // must never disappear silently. `ignoredScopes` is where a kind names the
        // scopes its driver still reports but the UI must hide (a scope that only
        // accepts user tokens, say, always answers 403 for an app credential).
        const ignored = kindIgnoredScopes(kinds, kind)
        const ordered = [
          ...order,
          ...Object.keys(scopes).filter(name => !order.includes(name) && !ignored.includes(name)),
        ]
        return h('div', {
          className: 'dq-chips',
          title: `${tt('panels.scopes.hint')}${test?.at === undefined ? '' : ' · ' + tt('panels.scopes.testedAt', { time: fmtTime(test.at) })}`,
        },
        ordered.map(name => {
          const value = scopes[name]
          const missing = value === undefined
          const [tone, mark] = missing ? ['unknown', '–'] : (states[value] ?? ['error', '?'])
          const stateText = missing || value === 'n/a'
            ? tt('scope.state.na')
            : value === 'ok' ? tt('scope.state.ok')
              : value === 'public' ? tt('scope.state.public')
                : value === 'forbidden' ? tt('scope.state.forbidden')
                  : value === 'timeout' ? tt('scope.state.timeout')
                    : tt('scope.state.error')
          return h('span', {
            key: name,
            className: 'dq-chip',
            'data-kind': tone,
            title: `${tt('panels.scopes.title')} · ${tt('scope.' + name)}: ${stateText}`,
          }, `${tt('scope.' + name)} ${mark}`)
        }))
      }

      const rowsView = panels.map(panel => {
        const test = panel.test
        const state = rowState(test)
        const versionSuffix = test?.version === undefined ? '' : ' · ' + test.version
        return h('tr', { key: panel.alias },
          h('td', null,
            h('span', { className: 'dq-cellName' }, panel.alias),
            panel.isDefault ? h('span', { className: 'dq-badge' }, tt('panels.default')) : null),
          h('td', { className: 'dq-cellMuted' }, kindLabel(kinds, panel.kind)),
          h('td', { className: 'dq-mono dq-cellEllipsis', title: panel.baseUrl }, panel.baseUrl),
          h('td', null, scopeChips(test, panel.kind)),
          h('td', null,
            h(Pill, { kind: state.kind }, state.label + versionSuffix),
            test?.message === undefined
              ? null
              : h('div', { className: 'dq-cellMuted dq-cellEllipsis', style: { marginTop: 4 }, title: test.message }, test.message)),
          h('td', null, h('div', { className: 'dq-actions' },
            h(Button, {
              variant: 'ghost',
              disabled: testingAll || testingAlias !== '',
              onClick: () => testOne(panel.alias),
            }, testingAlias === panel.alias ? tt('panels.testing') : tt('panels.test')),
            h(Button, { variant: 'ghost', onClick: () => setDialog({ mode: 'edit', panel }) }, tt('common.edit')),
            panel.isDefault ? null : h(Button, { variant: 'ghost', onClick: () => makeDefault(panel) }, tt('panels.setDefault')),
            h(Button, { variant: 'danger', onClick: () => remove(panel) }, tt('common.delete')))))
      })

      const table = h('div', { className: 'dq-tableWrap' },
        h('table', { className: 'dq-table dq-tablePanels' },
          h('colgroup', null,
            h('col', { style: { width: 104 } }),
            h('col', { style: { width: 92 } }),
            h('col', { style: { width: 160 } }),
            h('col', { style: { width: 292 } }),
            h('col', { style: { width: 172 } }),
            h('col', { style: { width: 220 } })),
          h('thead', null,
            h('tr', null,
              h('th', null, tt('panels.col.alias')),
              h('th', null, tt('panels.col.kind')),
              h('th', null, tt('panels.col.url')),
              h('th', null, tt('panels.col.scopes')),
              h('th', null, tt('panels.col.status')),
              h('th', null, tt('panels.col.actions')))),
          h('tbody', null, rowsView)))

      const toolbar = h('div', { className: 'dq-toolbar' },
        h(Button, { variant: 'primary', onClick: () => setDialog({ mode: 'create' }) }, tt('panels.add')),
        panels.length === 0 ? null : h(Button, {
          disabled: testingAll || testingAlias !== '',
          onClick: testAll,
        }, testingAll ? tt('panels.testAlling') : tt('panels.testAll')),
        h('span', { className: 'dq-spacer' }),
        h(Button, { variant: 'ghost', onClick: () => reload() }, tt('common.refresh')))

      const editor = dialog === undefined
        ? null
        : h(PanelDialog, {
          api,
          kinds,
          panel: dialog.mode === 'edit' ? dialog.panel : undefined,
          onClose: () => setDialog(undefined),
          onSaved: async created => {
            setDialog(undefined)
            // Selecting the saved panel is what makes the header picker and the
            // data tabs agree right after a create.
            await reload(typeof created?.alias === 'string' ? { selectAlias: created.alias } : {})
          },
        })

      return h(React.Fragment, null,
        toolbar,
        panels.length === 0 ? h('div', { className: 'dq-empty' }, tt('panels.empty')) : table,
        editor)
    }

    // ------------------------------------------------------------ envs tab

    /** Environment-variable create/edit dialog. */
    function EnvDialog(props) {
      const editing = props.env !== undefined
      const [name, setName] = useState(editing ? (props.env.name ?? '') : '')
      const [value, setValue] = useState(editing ? (props.env.value ?? '') : '')
      const [remarks, setRemarks] = useState(editing ? (props.env.remarks ?? '') : '')
      const [labels, setLabels] = useState(editing && Array.isArray(props.env.labels) ? props.env.labels.join(', ') : '')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')

      const save = async () => {
        setBusy(true)
        setError('')
        try {
          const labelList = splitLabels(labels)
          if (editing) {
            await props.api.updateEnv(props.alias, {
              id: props.env.id,
              patch: { name: name.trim(), value, remarks, labels: labelList },
            })
          } else {
            await props.api.createEnvs(props.alias, [{
              name: name.trim(),
              value,
              remarks,
              labels: labelList,
            }])
          }
          await props.onSaved()
        } catch (failure) {
          setError(errorText(failure))
        } finally {
          setBusy(false)
        }
      }

      return h(Dialog, {
        title: editing ? tt('envs.form.edit', { name: props.env.name ?? '' }) : tt('envs.form.create'),
        onClose: props.onClose,
        footer: [
          h(Button, { key: 'c', onClick: props.onClose }, tt('common.cancel')),
          h(Button, { key: 's', variant: 'primary', disabled: busy, onClick: save }, busy ? tt('common.loading') : tt('common.save')),
        ],
      },
      error === '' ? null : h(ErrorBanner, { text: error }),
      h(Field, { label: tt('envs.form.name'), hint: tt('envs.form.nameHint') },
        h(Input, { value: name, onChange: event => setName(event.target.value), placeholder: 'JD_COOKIE' })),
      h(Field, { label: tt('envs.form.value') },
        h('textarea', { className: 'dq-input dq-textarea', value, onChange: event => setValue(event.target.value) })),
      h(Field, { label: tt('envs.form.remarks') },
        h(Input, { value: remarks, onChange: event => setRemarks(event.target.value) })),
      h(Field, { label: tt('envs.form.labels') },
        h(Input, { value: labels, onChange: event => setLabels(event.target.value), placeholder: 'demo, prod' })))
    }

    /** The environment-variable tab. */
    function EnvsTab({ alias, api, notice, revision, panels, kinds }) {
      const [search, setSearch] = useState('')
      const [selected, setSelected] = useState([])
      const [dialog, setDialog] = useState(undefined)

      // alias + revision are the refetch keys: switching the header picker or
      // reloading the panel list both land here as a changed primitive.
      const load = useCallback(() => api.envs(alias, search), [api, alias, search])
      const { value, loading, error, reload } = useLoader(
        load,
        payload => (Array.isArray(payload.envs) ? payload.envs : []),
        [alias, revision, api, search],
      )
      const rows = value ?? []
      // A panel switch clears the selection; the loader does not own that.
      useEffect(() => { setSelected([]) }, [alias, revision])

      const toggleSelected = id => {
        setSelected(current => (current.includes(id) ? current.filter(item => item !== id) : [...current, id]))
      }

      const act = async (action, ids) => {
        if (ids.length === 0) return
        try {
          await api.envsAction(alias, action, ids)
          setSelected([])
          await reload()
        } catch (failure) {
          notice('error', errorText(failure))
        }
      }

      const remove = async ids => {
        if (ids.length === 0) return
        if (!window.confirm(tt('envs.deleteConfirm', { count: ids.length }))) return
        try {
          await api.deleteEnvs(alias, ids)
          setSelected([])
          await reload()
        } catch (failure) {
          notice('error', errorText(failure))
        }
      }

      const rowsView = rows.map(row => {
        const value = String(row.value ?? '')
        const disabled = envDisabled(row)
        const valueCell = h('td', null,
          h('div', { className: 'dq-mono dq-cellWrap dq-cellScroll', title: value }, value === '' ? '—' : value))
        const actions = h('div', { className: 'dq-actions' },
          h(Button, { variant: 'ghost', onClick: () => setDialog({ mode: 'edit', env: row }) }, tt('common.edit')),
          h(Button, { variant: 'ghost', onClick: () => act(disabled ? 'enable' : 'disable', [row.id]) },
            disabled ? tt('common.enabled') : tt('common.disabled')),
          h(Button, { variant: 'danger', onClick: () => remove([row.id]) }, tt('common.delete')))
        return h('tr', { key: String(row.id) },
          h('td', null, h('input', {
            type: 'checkbox',
            checked: selected.includes(row.id),
            onChange: () => toggleSelected(row.id),
          })),
          h('td', { className: 'dq-cellName dq-cellWrap' },
            row.name ?? '',
            row.important === true
              ? h('span', { className: 'dq-badge' }, tt('envs.important'))
              : null,
            typeof row.group === 'string' && row.group !== ''
              ? h('div', { className: 'dq-cellMuted dq-cellWrap' }, `${tt('envs.col.group')}: ${row.group}`)
              : null),
          valueCell,
          h('td', { className: 'dq-cellMuted dq-cellWrap' }, row.remarks ?? ''),
          h('td', null, h(Pill, { kind: disabled ? 'warn' : 'ok' },
            disabled ? tt('common.disabled') : tt('common.enabled'))),
          h('td', null, actions))
      })

      const headerCell = h('th', { style: { width: 28 } },
        h('input', {
          type: 'checkbox',
          checked: rows.length > 0 && selected.length === rows.length,
          onChange: event => setSelected(event.target.checked ? rows.map(row => row.id) : []),
        }))

      const table = h('div', { className: 'dq-tableWrap' },
        h('table', { className: 'dq-table dq-tableEnvs' },
          h('colgroup', null,
            h('col', { style: { width: 28 } }),
            h('col', { style: { width: 168 } }),
            h('col', null),
            h('col', { style: { width: 150 } }),
            h('col', { style: { width: 84 } }),
            h('col', { style: { width: 196 } })),
          h('thead', null,
            h('tr', null,
              headerCell,
              h('th', null, tt('envs.col.name')),
              h('th', null, tt('envs.col.value')),
              h('th', null, tt('envs.col.remarks')),
              h('th', null, tt('envs.col.status')),
              h('th', null, tt('envs.col.actions')))),
          h('tbody', null, rowsView)))

      const currentPanel = panels.find(panel => panel.alias === alias)
      const where = h('div', { className: 'dq-where' },
        tt('current.panel', { alias, url: currentPanel?.baseUrl ?? '' }),
        currentPanel === undefined
          ? null
          : h('span', { className: 'dq-badge' }, kindLabel(kinds, currentPanel.kind)))

      const toolbar = h('div', { className: 'dq-toolbar' },
        where,
        h('span', { className: 'dq-spacer' }),
        h(Input, {
          value: search,
          placeholder: tt('envs.search'),
          onChange: event => setSearch(event.target.value),
          onKeyDown: event => { if (event.key === 'Enter') void reload() },
        }),
        h(Button, { onClick: () => reload() }, tt('common.search')),
        h(Button, { variant: 'primary', onClick: () => setDialog({ mode: 'create' }) }, tt('envs.add')),
        h(Button, { disabled: selected.length === 0, onClick: () => act('enable', selected) }, tt('common.enabled')),
        h(Button, { disabled: selected.length === 0, onClick: () => act('disable', selected) }, tt('common.disabled')),
        h(Button, { variant: 'danger', disabled: selected.length === 0, onClick: () => remove(selected) }, tt('common.delete')),
        h(Button, { variant: 'ghost', onClick: () => reload() }, tt('common.refresh')))

      const body = loading && rows.length === 0
        ? h('div', { className: 'dq-loading' }, tt('common.loading'))
        : rows.length === 0
          ? h('div', { className: 'dq-empty' }, tt('envs.empty'))
          : table

      const editor = dialog === undefined
        ? null
        : h(EnvDialog, {
          api,
          alias,
          env: dialog.mode === 'edit' ? dialog.env : undefined,
          onClose: () => setDialog(undefined),
          onSaved: async () => { setDialog(undefined); await reload() },
        })

      return h(React.Fragment, null,
        toolbar,
        h(ErrorBanner, { text: error, onRetry: reload }),
        body,
        editor)
    }

    // ----------------------------------------------------------- crons tab

    /** Schedule preview block inside the cron dialog. */
    function SchedulePreview({ alias, api, schedule }) {
      const [state, setState] = useState({ loading: false, times: [], error: '' })
      useEffect(() => {
        if (schedule.trim() === '') {
          setState({ loading: false, times: [], error: '' })
          return undefined
        }
        let alive = true
        setState(current => ({ ...current, loading: true, error: '' }))
        const timer = setTimeout(async () => {
          try {
            const payload = await api.preview(alias, schedule.trim())
            if (!alive) return
            const times = Array.isArray(payload.preview?.times) ? payload.preview.times : []
            setState({ loading: false, times, error: '' })
          } catch (failure) {
            if (!alive) return
            setState({ loading: false, times: [], error: errorText(failure) })
          }
        }, 350)
        return () => { alive = false; clearTimeout(timer) }
      }, [alias, api, schedule])

      if (schedule.trim() === '') return h('div', { className: 'dq-hint' }, tt('crons.form.previewEmpty'))
      if (state.error !== '') return h('div', { className: 'dq-hint dq-danger' }, state.error)
      if (state.loading) return h('div', { className: 'dq-hint' }, tt('common.loading'))
      if (state.times.length === 0) return h('div', { className: 'dq-hint' }, tt('common.none'))
      return h('div', { className: 'dq-hint dq-mono' }, state.times.map(time => fmtTime(time)).join('\n'))
    }

    /** Scheduled-task create/edit dialog. */
    function CronDialog(props) {
      const editing = props.cron !== undefined
      const [name, setName] = useState(editing ? (props.cron.name ?? '') : '')
      const [command, setCommand] = useState(editing ? (props.cron.command ?? '') : 'task ')
      const [schedule, setSchedule] = useState(editing ? (props.cron.schedule ?? '') : '0 0 * * *')
      const [labels, setLabels] = useState(editing && Array.isArray(props.cron.labels) ? props.cron.labels.join(', ') : '')
      const [taskBefore, setTaskBefore] = useState(editing ? (props.cron.task_before ?? '') : '')
      const [taskAfter, setTaskAfter] = useState(editing ? (props.cron.task_after ?? '') : '')
      const [workDir, setWorkDir] = useState(editing ? (props.cron.work_dir ?? '') : '')
      const [multi, setMulti] = useState(editing ? Number(props.cron.allow_multiple_instances) === 1 : false)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')

      const save = async () => {
        setBusy(true)
        setError('')
        try {
          const payload = {
            name: name.trim(),
            command: command.trim(),
            schedule: schedule.trim(),
            labels: splitLabels(labels),
            task_before: taskBefore,
            task_after: taskAfter,
            work_dir: workDir,
            allow_multiple_instances: multi ? 1 : 0,
          }
          if (editing) await props.api.updateCron(props.alias, props.cron.id, payload)
          else await props.api.createCron(props.alias, payload)
          await props.onSaved()
        } catch (failure) {
          setError(errorText(failure))
        } finally {
          setBusy(false)
        }
      }

      return h(Dialog, {
        title: editing ? tt('crons.form.edit', { name: props.cron.name ?? '' }) : tt('crons.form.create'),
        onClose: props.onClose,
        footer: [
          h(Button, { key: 'c', onClick: props.onClose }, tt('common.cancel')),
          h(Button, { key: 's', variant: 'primary', disabled: busy, onClick: save }, busy ? tt('common.loading') : tt('common.save')),
        ],
      },
      error === '' ? null : h(ErrorBanner, { text: error }),
      h(Field, { label: tt('crons.form.name') },
        h(Input, { value: name, onChange: event => setName(event.target.value) })),
      h(Field, { label: tt('crons.form.command') },
        h(Input, { value: command, onChange: event => setCommand(event.target.value), placeholder: 'task demo.js' })),
      h(Field, { label: tt('crons.form.schedule') },
        h(Input, { value: schedule, onChange: event => setSchedule(event.target.value), placeholder: '0 0 * * *' })),
      h(Field, { label: tt('crons.form.preview') },
        h(SchedulePreview, { alias: props.alias, api: props.api, schedule })),
      h(Field, { label: tt('crons.form.labels') },
        h(Input, { value: labels, onChange: event => setLabels(event.target.value) })),
      h('div', { className: 'dq-grid2' },
        h(Field, { label: tt('crons.form.taskBefore') },
          h(Input, { value: taskBefore, onChange: event => setTaskBefore(event.target.value) })),
        h(Field, { label: tt('crons.form.taskAfter') },
          h(Input, { value: taskAfter, onChange: event => setTaskAfter(event.target.value) }))),
      kindSupportsWorkDir(props.kinds, props.kind) ? h(Field, { label: tt('crons.form.workDir') },
        h(Input, { value: workDir, onChange: event => setWorkDir(event.target.value) })) : null,
      h('label', { className: 'dq-check' },
        h('input', { type: 'checkbox', checked: multi, onChange: event => setMulti(event.target.checked) }),
        tt('crons.form.multi')))
    }

    /** Task log dialog. */
    function LogDialog({ api, alias, cron, onClose }) {
      const [content, setContent] = useState('')
      const [meta, setMeta] = useState({})
      const [loading, setLoading] = useState(false)
      const [error, setError] = useState('')
      const [auto, setAuto] = useState(true)

      const load = useCallback(async () => {
        setLoading(true)
        setError('')
        try {
          const payload = await api.cronLog(alias, cron.id, { limit: 262144 })
          setContent(typeof payload.content === 'string' ? payload.content : '')
          setMeta({ status: payload.logStatus, total: payload.total, truncated: payload.truncated })
        } catch (failure) {
          setError(errorText(failure))
        } finally {
          setLoading(false)
        }
      }, [api, alias, cron.id])

      useEffect(() => { void load() }, [load])

      // A running task keeps writing to its log; follow it while the drawer is
      // open unless the user switches the switch off.
      useEffect(() => {
        if (!auto) return undefined
        const timer = setInterval(() => { void load() }, 3000)
        return () => clearInterval(timer)
      }, [auto, load])

      return h(Dialog, {
        title: tt('log.title', { name: cron.name ?? cron.id }),
        onClose,
        footer: [
          meta.status === undefined ? null : h('span', { key: 'm', className: 'dq-hint', style: { marginRight: 'auto' } },
            `${tt('log.status')}: ${meta.status}`),
          h(Button, { key: 'r', onClick: load, disabled: loading }, tt('common.refresh')),
          h(Button, { key: 'c', variant: 'primary', onClick: onClose }, tt('common.close')),
        ],
      },
      h(ErrorBanner, { text: error, onRetry: load }),
      h('label', { className: 'dq-check' },
        h('input', { type: 'checkbox', checked: auto, onChange: event => setAuto(event.target.checked) }),
        tt('crons.autoRefresh')),
      meta.truncated === true ? h('div', { className: 'dq-hint' }, tt('log.truncated')) : null,
      h('div', { className: 'dq-log' }, content === '' ? tt('log.empty') : content))
    }

    /** The scheduled-task tab. */
    function CronsTab({ alias, api, notice, revision, panels, kinds }) {
      const [page, setPage] = useState(1)
      const [search, setSearch] = useState('')
      const [dialog, setDialog] = useState(undefined)
      const [logCron, setLogCron] = useState(undefined)
      /** rowId -> true while that row's action is in flight */
      const [pending, setPending] = useState({})
      const polling = useRef(false)

      useEffect(() => { setPage(1) }, [alias])

      const load = useCallback(
        () => api.crons(alias, { searchValue: search, page, size: CRON_PAGE_SIZE }),
        [api, alias, search, page],
      )
      const { value, loading, error, reload, refresh } = useLoader(
        load,
        payload => ({
          rows: Array.isArray(payload.rows) ? payload.rows : [],
          total: typeof payload.total === 'number' ? payload.total : undefined,
        }),
        [alias, revision, api, search, page],
      )
      const rows = value?.rows ?? []
      const total = value?.total

      /** Mark the affected rows busy for the whole request + refresh window. */
      const withPending = async (ids, body) => {
        const marks = {}
        for (const id of ids) marks[id] = true
        setPending(current => ({ ...current, ...marks }))
        try {
          await body()
        } finally {
          setPending(current => {
            const next = { ...current }
            for (const id of ids) delete next[id]
            return next
          })
        }
      }

      const act = (action, ids) => withPending(ids, async () => {
        try {
          await api.cronsAction(alias, action, ids)
          // Only "accepted a trigger" is worth saying: stop/enable/disable are
          // visible in the status column (and the 5 s poll), so no toast.
          if (action === 'run') notice('ok', tt('notice.triggered'))
          await reload()
        } catch (failure) {
          notice('error', errorText(failure))
        }
      })

      const remove = async ids => {
        if (!window.confirm(tt('crons.deleteConfirm', { count: ids.length }))) return
        await withPending(ids, async () => {
          try {
            await api.deleteCrons(alias, ids)
            await reload()
          } catch (failure) {
            notice('error', errorText(failure))
          }
        })
      }

      // Keep task states (running / queued / idle) in sync while the tab is
      // open: a silent 5 s poll, skipped for a hidden page and never stacked.
      useEffect(() => {
        const timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
          if (polling.current) return
          polling.current = true
          void refresh()
            .catch(() => { /* a poll failure must not disturb the view */ })
            .finally(() => { polling.current = false })
        }, 5000)
        return () => {
          clearInterval(timer)
          polling.current = false
        }
      }, [alias, api, search, page])

      const rowsView = rows.map(row => {
        const disabled = row.isDisabled === 1 || row.isDisabled === true || Number(row.status) === 2
        const running = Number(row.status) === 0 || Number(row.status) === 3
        const command = h('span', { className: 'dq-mono dq-clip', title: String(row.command ?? '') }, row.command ?? '')
        const busy = pending[row.id] === true
        const actions = h('div', { className: 'dq-actions' },
          h(Button, { variant: 'ghost', disabled: busy, onClick: () => act('run', [row.id]) }, tt('crons.run')),
          h(Button, { variant: 'ghost', disabled: busy, onClick: () => act('stop', [row.id]) }, tt('crons.stop')),
          h(Button, { variant: 'ghost', disabled: busy, onClick: () => act(disabled ? 'enable' : 'disable', [row.id]) },
            disabled ? tt('common.enabled') : tt('common.disabled')),
          h(Button, { variant: 'ghost', onClick: () => setLogCron(row) }, tt('crons.log')),
          h(Button, { variant: 'ghost', disabled: busy, onClick: () => setDialog({ mode: 'edit', cron: row }) }, tt('common.edit')),
          h(Button, { variant: 'danger', disabled: busy, onClick: () => remove([row.id]) }, tt('common.delete')))
        return h('tr', { key: String(row.id), className: busy ? 'dq-rowBusy' : undefined },
          h('td', null,
            h('span', { className: 'dq-cellName dq-cellWrap' }, row.name ?? ''),
            h('div', { className: 'dq-cellMuted' }, '#' + String(row.id ?? '-'))),
          h('td', null, command),
          h('td', { className: 'dq-mono dq-cellWrap' }, row.schedule ?? ''),
          h('td', null, h(Pill, { kind: disabled ? 'warn' : (running ? 'ok' : 'unknown') }, cronStatusText(row))),
          h('td', { className: 'dq-cellMuted' }, fmtTime(row.last_execution_time ?? row.last_running_time)),
          h('td', null, actions))
      })

      const table = h('div', { className: 'dq-tableWrap' },
        h('table', { className: 'dq-table dq-tableCrons' },
          h('colgroup', null,
            h('col', { style: { width: 168 } }),
            h('col', null),
            h('col', { style: { width: 150 } }),
            h('col', { style: { width: 84 } }),
            h('col', { style: { width: 132 } }),
            h('col', { style: { width: 300 } })),
          h('thead', null,
            h('tr', null,
              h('th', null, tt('crons.col.name')),
              h('th', null, tt('crons.col.command')),
              h('th', null, tt('crons.col.schedule')),
              h('th', null, tt('crons.col.status')),
              h('th', null, tt('crons.col.last')),
              h('th', null, tt('crons.col.actions')))),
          h('tbody', null, rowsView)))

      const pages = total === undefined ? undefined : Math.max(1, Math.ceil(total / CRON_PAGE_SIZE))
      const pager = h('span', { className: 'dq-pager' },
        total === undefined ? tt('common.none') : tt('crons.total', { total }),
        h(Button, { disabled: page <= 1, onClick: () => setPage(page - 1) }, tt('crons.prev')),
        h('span', null, pages === undefined ? String(page) : tt('crons.page', { page, pages })),
        h(Button, { disabled: pages !== undefined && page >= pages, onClick: () => setPage(page + 1) }, tt('crons.next')))

      const currentPanel = panels.find(panel => panel.alias === alias)
      const where = h('div', { className: 'dq-where' },
        tt('current.panel', { alias, url: currentPanel?.baseUrl ?? '' }),
        currentPanel === undefined
          ? null
          : h('span', { className: 'dq-badge' }, kindLabel(kinds, currentPanel.kind)))

      const toolbar = h('div', { className: 'dq-toolbar' },
        where,
        h('span', { className: 'dq-spacer' }),
        h(Input, {
          value: search,
          placeholder: tt('crons.search'),
          onChange: event => { setSearch(event.target.value); setPage(1) },
          onKeyDown: event => { if (event.key === 'Enter') void reload() },
        }),
        h(Button, { onClick: () => reload() }, tt('common.search')),
        h(Button, { variant: 'primary', onClick: () => setDialog({ mode: 'create' }) }, tt('crons.add')),
        pager,
        h(Button, { variant: 'ghost', onClick: () => reload() }, tt('common.refresh')))

      const body = loading && rows.length === 0
        ? h('div', { className: 'dq-loading' }, tt('common.loading'))
        : rows.length === 0
          ? h('div', { className: 'dq-empty' }, tt('crons.empty'))
          : table

      const editor = dialog === undefined
        ? null
        : h(CronDialog, {
          api,
          alias,
          kinds,
          kind: currentPanel?.kind,
          cron: dialog.mode === 'edit' ? dialog.cron : undefined,
          onClose: () => setDialog(undefined),
          onSaved: async () => { setDialog(undefined); await reload() },
        })

      const logView = logCron === undefined
        ? null
        : h(LogDialog, {
          api,
          alias,
          cron: logCron,
          onClose: () => setLogCron(undefined),
        })

      return h(React.Fragment, null,
        toolbar,
        h(ErrorBanner, { text: error, onRetry: reload }),
        body,
        editor,
        logView)
    }

    // --------------------------------------------------------------- page

    /** The sidebar glyph (the shell owns the row geometry and label). */
    function QinglongIcon({ size }) {
      return h('svg', {
        viewBox: '0 0 16 16',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.4,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'data-dsh-panel-entry': PANEL_ID,
        'aria-hidden': 'true',
      },
      h('rect', { x: 1.75, y: 2.75, width: 12.5, height: 10.5, rx: 2.2 }),
      h('path', { d: 'M4.4 10.6c1.7 1 3.3-.8 2.6-2.2-.5-1.1-2-1.3-2.5-.2' }),
      h('path', { d: 'M8.6 5.4h3.5M8.6 7.9h3.5' }))
    }

    /** Panel selection + connection state. */
    function Header({ controller, panels, alias, onAlias, onListRefresh, testResult }) {
      const kind = testResult === undefined ? 'unknown'
        : testResult.reachable !== true ? 'error'
          : testResult.auth === 'ok' ? 'ok'
            : testResult.auth === 'forbidden' ? 'warn' : 'warn'
      const label = testResult === undefined ? tt('panels.status.unknown')
        : testResult.reachable !== true ? tt('panels.status.failed')
          : testResult.auth === 'ok' ? tt('panels.status.ok')
            : testResult.auth === 'forbidden' ? tt('panels.status.forbidden')
              : tt('panels.status.required')
      return h('div', { className: 'dq-header' },
        h('button', {
          type: 'button',
          className: 'dq-back',
          'data-dsh-center-view-back': '',
          onClick: () => controller.back(),
        }, h('span', { 'aria-hidden': 'true' }, '‹'), h('span', null, tt('panel.back'))),
        h('h2', { className: 'dq-title' }, tt('panel.title')),
        panels.length === 0
          ? null
          : h('select', {
            className: 'dq-select',
            value: alias,
            'aria-label': tt('tab.panels'),
            // Opening the picker refreshes the list, so a panel added anywhere
            // else (agent tool, another tab, curl) shows up without a reload.
            onMouseDown: () => onListRefresh(),
            onFocus: () => onListRefresh(),
            onChange: event => onAlias(event.target.value),
          }, panels.map(panel => h('option', { key: panel.alias, value: panel.alias },
            panel.isDefault ? `${panel.alias} (${tt('panels.default')})` : panel.alias))),
        panels.length === 0 ? null : h(Pill, { kind },
          label + (testResult?.version === undefined ? '' : ` · ${testResult.version}`)),
        h('span', { className: 'dq-spacer' }))
    }

    /** The panel page: header, tab bar, notices, active tab. */
    function Page({ controller, api }) {
      const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
      const panels = snapshot.panels
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState('')
      const [testingAlias, setTestingAlias] = useState('')
      const [testingAll, setTestingAll] = useState(false)
      const [listBusy, setListBusy] = useState(false)
      // Product catalogue as the host describes it (`GET .../panels` → kinds).
      // Everything the form shows per product — credential fields, scope order,
      // whether a cron carries a work_dir — is read from here.
      const [kinds, setKinds] = useState(FALLBACK_KINDS)

      /**
       * Reload the panel list into the shared controller state.
       * @param options.selectAlias - select this alias after the reload (create).
       * @param options.dropAlias - drop this selection if it is still current (delete).
       */
      const loadPanels = useCallback(async (options = {}) => {
        setLoading(true)
        setListBusy(true)
        setError('')
        try {
          const payload = await api.panels()
          const list = Array.isArray(payload.panels) ? payload.panels : []
          setKinds(normalizeKinds(payload.kinds))
          controller.setPanels(list, payload.defaultPanel)
          const current = controller.getSnapshot()
          if (typeof options.selectAlias === 'string' && options.selectAlias !== '') {
            controller.selectAlias(options.selectAlias)
          } else if (typeof options.dropAlias === 'string' && current.alias === options.dropAlias) {
            const preferred = list.find(panel => panel.isDefault === true) ?? list[0]
            controller.selectAlias(preferred === undefined ? '' : preferred.alias)
          } else if (current.alias === '' && list.length > 0) {
            const preferred = list.find(panel => panel.isDefault === true) ?? list[0]
            controller.selectAlias(preferred.alias)
          }
        } catch (failure) {
          setError(errorText(failure))
        } finally {
          setLoading(false)
          setListBusy(false)
        }
      }, [api, controller])

      useEffect(() => { void loadPanels() }, [loadPanels])

      // The effective alias: the selected one while it still exists, else the
      // default panel, else the first configured panel.
      const alias = useMemo(() => {
        if (snapshot.alias !== '' && panels.some(panel => panel.alias === snapshot.alias)) return snapshot.alias
        if (panels.length === 0) return ''
        const preferred = panels.find(panel => panel.isDefault === true)
        return (preferred ?? panels[0]).alias
      }, [snapshot.alias, panels])

      /** Status pill data for the selected panel, from its persisted probe. */
      const testResult = useMemo(() => {
        if (alias === '') return undefined
        const panel = panels.find(candidate => candidate.alias === alias)
        return panel?.test
      }, [alias, panels])

      /**
       * Probe one panel (the only thing that queries the panel), then reload the
       * list so the persisted result renders everywhere.
       */
      const testOne = useCallback(async target => {
        if (target === '') return
        setTestingAlias(target)
        try {
          await api.test(target, true)
          // Reload before releasing the button: when it re-enables, the table
          // already shows the freshly persisted probe.
          await loadPanels()
        } catch (failure) {
          controller.notice('error', errorText(failure))
        } finally {
          setTestingAlias('')
        }
      }, [api, loadPanels, controller])

      const testAll = useCallback(async () => {
        setTestingAll(true)
        try {
          for (const panel of panels) await api.test(panel.alias, true)
          await loadPanels()
        } catch (failure) {
          controller.notice('error', errorText(failure))
        } finally {
          setTestingAll(false)
        }
      }, [panels, api, loadPanels, controller])

      const notice = (kind, text) => controller.notice(kind, text)
      const selectAlias = value => {
        controller.selectAlias(value)
        // A selection made here must reach the data tabs even when the value
        // equals the previous one (e.g. re-picking after an external change).
        controller.touch()
      }

      const header = h(Header, {
        controller,
        panels,
        alias,
        onAlias: selectAlias,
        onListRefresh: () => { if (listBusy !== true) void loadPanels() },
        testResult,
      })

      const tabDefs = [['panels', 'tab.panels'], ['envs', 'tab.envs'], ['crons', 'tab.crons']]
      const tabBar = h('div', { className: 'dq-tabs', role: 'tablist' },
        tabDefs.map(([id, key]) => h('button', {
          key: id,
          type: 'button',
          role: 'tab',
          className: 'dq-tab',
          'aria-selected': snapshot.tab === id,
          'data-active': snapshot.tab === id ? '' : undefined,
          onClick: () => controller.setTab(id),
        }, tt(key))))

      const empty = h('div', { className: 'dq-empty' }, tt('error.noPanel'))
      const active = snapshot.tab === 'panels'
        ? h(PanelsTab, {
          panels,
          kinds,
          api,
          reload: loadPanels,
          notice,
          testOne,
          testAll,
          testingAlias,
          testingAll,
        })
        : alias === ''
          ? empty
          : snapshot.tab === 'envs'
            ? h(EnvsTab, { alias, api, notice, revision: snapshot.revision, panels, kinds })
            : h(CronsTab, { alias, api, notice, revision: snapshot.revision, panels, kinds })

      const loadingHint = loading && panels.length === 0
        ? h('div', { className: 'dq-loading' }, tt('common.loading'))
        : null

      return h('div', { className: 'dq-view', 'data-dsh-plugin': 'cronops', 'data-dsh-cronops-view': '' },
        header,
        tabBar,
        h('div', { className: 'dq-content' },
          h(Notice, { notice: snapshot.notice, onClose: () => controller.clearNotice() }),
          h(ErrorBanner, { text: error, onRetry: () => loadPanels() }),
          loadingHint,
          active))
    }

    // ---------------------------------------------------------------- apply

    /** Register the dictionaries, the sidebar row and the page. */
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => {
          try {
            return ctx.locale.register(NS, { zh, en })
          } catch {
            return () => {}
          }
        }, 'dsh-cronops: dictionaries')

        try {
          runtimeTranslate = ctx.locale.bind(NS)
        } catch {
          runtimeTranslate = fallbackTranslate
        }

        const selectPanel = panelId => {
          try {
            const layout = ctx.get?.('layout')
            layout?.selectPanel?.(panelId)
          } catch {
            // A shell without the navigation face keeps what it was showing.
          }
        }
        const controller = createController(selectPanel)
        const disposers = []

        ctx.effect(() => {
          const style = document.createElement('style')
          style.id = STYLE_ID
          style.textContent = CSS
          document.head.appendChild(style)
          return () => { style.remove() }
        }, 'dsh-cronops: styles')

        try {
          disposers.push(ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 45,
            label: () => tt('entry.label'),
          }, QinglongIcon)))

          disposers.push(ctx.slots.inject('main', () => ctx.slots.register({
            name: 'main',
            key: PANEL_ID,
          }, props => h(Page, { ...props, controller, api }))))
        } catch (failure) {
          // Registration failures degrade the panel, never the GUI.
          console.warn('[dsh-cronops] panel registration failed:', failure)
        }

        ctx.effect(() => () => {
          for (const dispose of disposers.splice(0)) dispose()
        }, 'dsh-cronops: ui mounts')
      },
    }
  },
})
