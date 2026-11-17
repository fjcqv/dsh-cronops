# dsh-cronops

DSH 的定时面板控制台：侧边栏（菜单栏）多一个「定时面板」入口，点开后是中栏的一个自有页面，用面板自己的 **OpenAPI 应用凭据**连接并管理它。支持两款面板：

| 面板 | 版本 | 接口 | 凭据 | 页面能力 |
|---|---|---|---|---|
| **青龙面板** Qinglong | 2.x（实测 2.24.0） | `/open/*` + Bearer（30 天） | `client_id` / `client_secret` | 环境变量、定时任务 |
| **呆呆面板** Daidai | 3.x（实测 3.4.4） | `/api/v1/*` + Bearer（24 小时） | `app_key` / `app_secret` | 环境变量（含分组/重要）、定时任务 |

仓库：<https://github.com/fjcqv/dsh-cronops> · License: Apache-2.0

页面有三个页签：

1. **主机** —— 面板连接管理：列表、新增、编辑、删除、测试连接、设为默认；新增时选「青龙 / 呆呆」，凭据字段随之切换。
2. **环境变量** —— 列表 / 搜索 / 新建 / 编辑 / 删除 / 启用 / 禁用（含批量）；呆呆额外显示「分组」与「重要」。
3. **定时任务** —— 列表 / 搜索 / 分页 / 运行 / 停止 / 启用 / 禁用 / 删除 / 查看日志 / 新建 / 编辑，定时规则输入时实时预览未来触发时间。

订阅、配置文件、脚本、日志、依赖、系统信息、仪表盘**不在页面里**，由智能体工具 `qinglong_api` 完成（青龙 `/open/*`、呆呆 `/api/v1/*`）。

## 安装

```bash
# 1) 从本地目录安装（插件管理器统一走这一步）
#    plugin_manager: { action: "install_bundle", target: "/abs/path/to/dsh-cronops" }

# 2) 或者装在别处时先 clone，再把绝对路径交给上面那条
git clone git@github.com:fjcqv/dsh-cronops.git
```

也可以作为 pnpm 依赖加入 profile（`dsh plugin --profile web add github:fjcqv/dsh-cronops`），随后在「插件管理 → Bundles」里启用 `dsh-cronops`。

安装后需要**刷新一次 Web 页面**：浏览器半（`client.js`）随模块清单加载，刷新后侧边栏出现「定时面板」。宿主半（路由、工具）即时生效。

## 面板侧准备

**青龙**：系统设置 → 应用设置 → 新建应用，勾选 `envs`、`crons`（其余按需：`subscriptions`、`configs`、`scripts`、`logs`、`dependencies`、`system`、`dashboard`），复制 `client_id` / `client_secret`。

**呆呆**：Open API 页面 → 新建应用，记下 `app_key` / `app_secret`（密钥只显示一次），勾选权限范围 `tasks`、`envs`（其余按需：`logs`、`scripts`、`subscriptions`、`system`、`backup`）。通知渠道接口只认面板用户令牌，所以不参与权限探测；要读渠道列表可以把凭据类型换成「令牌」并贴管理员 JWT。

两款面板都可以改用「凭据类型 = 令牌」，直接粘贴一个已有 token（青龙的 30 天令牌、呆呆的 24 小时令牌或登录令牌）。

## 页面行为要点

**主机页签**

- 列顺序 `别名 / 面板地址 / 权限 / 状态 / 操作`；不显示凭据（凭据只在编辑对话框里），地址列定宽单行省略并带 `title` 全文。
- 行内操作只有 测试 / 编辑 / 设为默认 / 删除；选面板用页头下拉，下拉展开时会重新拉一次列表，别处（agent 工具、curl）新增的面板也能立刻看到。
- 新增面板后自动选中它；删除当前面板会回落到默认面板。

**权限与状态**

- 点「测试 / 测试全部」才真正探测，结果**落库**到 store 的 `panel.test`（`at / reachable / version / auth / message / scopes`）；页面加载与切换面板只读这份结果，不再每次查询。改 `kind / baseUrl / auth / insecureTls / timeoutMs` 会自动清空旧结果。
- 权限用中文名展示：青龙 `环境变量 / 定时任务 / 订阅 / 配置文件 / 脚本 / 日志 / 依赖 / 仪表盘 / 系统信息`，呆呆 `定时任务 / 环境变量 / 日志 / 脚本 / 订阅 / 系统信息 / 备份`；状态词 `有权限 ✓ / 无权限 ✗ / 探测失败 ? / 不适用 –`。面板多报出的新 scope 也会追加显示。
- 探测方式：对每个业务资源发一次只读请求，200 记有权限、403 记无权限（两款面板都没有「列出我的 scope」接口）。青龙探测 9 项，呆呆 7 项。

**反馈与刷新**

- 主机「测试 / 测试全部」运行期间按钮禁用并显示「测试中…」，完成后先刷新表格再恢复。
- 定时任务页每 5 秒静默轮询一次（页面隐藏时停、请求不叠加），行内动作在途时该行按钮禁用并淡化，所以「运行中 → 空闲」会自动同步。
- 日志抽屉默认每 3 秒自动刷新，可勾选关闭；手动「刷新」始终可用。
- 只有「已向面板提交触发请求」这一条成功提示（2.5 秒自动消失，强调受理触发 ≠ 执行完成）；启停、删除、保存用表格状态反馈，不弹提示；失败提示常驻，需手动关闭。

**表格与数据**

- 切换面板立即让「环境变量」「定时任务」重新拉取（取数键是 `alias + revision` 两个原始值），工具条左侧常驻「当前面板：alias · url + 类型徽标」。
- 环境变量值直接展示（等宽、可换行、可选中）并可一键复制；呆呆对「像凭据」的变量会在服务端遮蔽。
- 三张表都是 `table-layout: fixed` + 固定列宽，长值只在自己的单元格里换行/滚动，不会撑破页面。
- 状态词表统一：青龙 `0运行/1空闲/2禁用/3排队`，呆呆 `0禁用/0.5排队/1启用/2运行中`，驱动层归一后 UI 只认一套。

## 数据与安全

- 面板连接存 `$DSH_HOME/dsh-cronops.json`（默认 `~/.dsh/dsh-cronops.json`），权限 `0600`，tmp + rename 原子写；文件损坏时旁置 `.corrupt-<时间戳>` 并从空列表启动。
- `appSecret` / token 明文只存在这个用户私有文件里，**永不返回给浏览器或 agent**：接口只投影 `appKey`、`hasSecret`。
- `/api/dsh-cronops/*` 全部走本机回环栅栏（socket 回环 + Host 回环 + 无转发头 + 同源标记）；经反代访问需在 profile 行配置 `allowProxiedRequests: true`。
- 写操作真实修改面板；运行任务只代表面板受理了触发，不代表脚本执行完成。

## 插件配置（可选，写在 profile 行里）

本插件不导出 `Config` schema，「插件管理」里没有单独设置页；需要改默认行为时在 `cordis.patch.yml` 给这一行加 config：

```yaml
- id: cronops
  name: dsh-cronops
  config:
    enabled: true              # 总开关：路由 + 工具 + 提示段
    announceToAgent: false     # 向 agent 注入插件能力说明
    requestTimeoutMs: 15000    # 单次请求面板的超时（1000–120000）
    allowProxiedRequests: false
```

## 智能体工具

| 工具 | 作用 |
|---|---|
| `qinglong_panels` | `list` 列面板 / `test` 探活（连通性、版本、凭据与 scope 状态） |
| `qinglong_envs` | `list` / `create` / `update` / `delete` / `enable` / `disable` |
| `qinglong_crons` | `list` / `get` / `create` / `update` / `run` / `stop` / `enable` / `disable` / `delete` / `log` / `preview` |
| `qinglong_api` | 通用桥：青龙 `/open/*`、呆呆 `/api/v1/*` |

`qinglong_api` 拒绝：青龙 `/open/apps`、`/open/auth`、`/open/user`、`/open/update`；呆呆 `open-api`、`users`、`auth`、`mcp`（凭据、账号、备份与面板更新都不交给模型）。

## 接口对照（驱动实际使用的部分）

| 用途 | 青龙 | 呆呆 |
|---|---|---|
| 取令牌 | `GET /open/auth/token?client_id=&client_secret=` → `{data:{token,expiration}}` | `POST /api/v1/open-api/token` `{app_key,app_secret}` → `{data:{access_token,expires_in}}` |
| 探活/版本 | `GET /open/system` | `GET /api/v1/version`、`/api/v1/health` |
| 环境变量 | `GET /open/envs?searchValue=`、`POST /open/envs`（数组）、`PUT /open/envs`（须 id/name/value）、`DELETE /open/envs`、`PUT /open/envs/enable\|disable` | `GET /envs?keyword=&page=&page_size=`、`POST /envs`（数组）、`PUT /envs/:id`（部分字段）、`DELETE /envs/batch`、`PUT /envs/batch/enable\|disable` |
| 定时任务 | `GET /open/crons`、`GET /open/crons/:id`、`POST/PUT/DELETE /open/crons`、`PUT /open/crons/run\|stop\|enable\|disable`、`GET /open/crons/:id/log`、`GET /open/crons/preview` | `GET /tasks`（无 `/:id`，详情由列表扫描）、`POST /tasks`、`PUT/DELETE /tasks/:id`、`PUT /tasks/:id/run\|stop\|enable\|disable`、`POST /tasks/batch/run`（≤10 自动分批）、`GET /tasks/:id/latest-log`、`POST /tasks/cron/parse` |
| 错误语义 | HTTP 200 + `{code,message}` | HTTP 状态码 + `{error}` |

更新语义：青龙的 `PUT` 不做读后合并（env 须带 `id/name/value`、cron 须带 `command/schedule`），驱动先 `GET` 再合并；呆呆接受部分字段更新，直接 PATCH。

## 验证

```bash
node scripts/selftest.mjs        # 主机半：两种面板的 mock + 全部路由/错误分支（84 项断言）
node scripts/check-tools.mjs     # 工具输出契约（宿主真实 JSON Schema 校验器，63 项断言）
node scripts/mock-qinglong.mjs 5799   # 假青龙（client_id=mock-client / mock-secret）
node scripts/mock-daidai.mjs 5798     # 假呆呆（app_key=dd-key / dd-secret）
```

`scripts/` 只用于验证，不参与运行时。`check-tools.mjs` 会 import 本机 dsh 安装目录里的校验器（路径写死，换机器时改一下 import 路径）。

真实面板也验证过：青龙 **2.24.0** 探活 9 个 scope 全 `ok`；呆呆 **3.4.4** 探活 7 个 scope 全 `ok`，`cron/parse` 返回真实的下 5 次触发时间，并跑过一次可逆写闭环（环境变量 建→改→禁用→删，任务 建→改→运行→读 `latest-log`→删，通用桥读 `/scripts` 成功、`/open-api` 被拒）。

## 目录

```
index.js            宿主半：装配 store / engine / routes / tools / 提示段
lib/engine.js       面板驱动门面（按 kind 分派）
lib/store.js        面板连接存储（0600、原子写、探测结果落库）
lib/qinglong.js     青龙驱动（/open、client_id/secret、token 缓存、scope 探测）
lib/daidai.js       呆呆驱动（/api/v1、app_key/secret、字段与状态归一）
lib/routes.js       /api/dsh-cronops 路由族
lib/tools.js        4 个 agent 工具（纯对象定义，无 SDK 依赖）
lib/protocol.js     共享常量与两套拒访名单
lib/loopback.js     回环信任栅栏
lib/http.js         有界 JSON 读写
client.js           浏览器半：菜单栏行、三页签、类型/凭据表单、样式、i18n
scripts/            mock 面板 + 自测 + 工具契约检查
locale/{zh,en}.json 插件管理页展示文案
icon.svg            插件图标
```
