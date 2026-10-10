# 待会吃什么

两个人一起定「今天吃什么」的 PWA。随机抽几道菜 → 两人各自投票 → 都通过就开做，顺手告诉你家里缺什么、要买什么。

**在线地址**：https://reotho123-pixel.github.io/chishenme/（部署后可用）

---

## 现在能做什么

| 功能 | 说明 |
| --- | --- |
| 🎲 随机选菜 | 按条件抽 4 道候选（默认：30 分钟内 · 不辣 · 排除最近 7 天） |
| 🗳 双人投票 | 每道菜选「想吃 / 都行 / 不吃」，提交前看不到对方选择 |
| 🎉 揭晓定菜 | 双方都想吃的直接定；没人反对的降级随机；有人否决的排除 |
| ☁️ 双人同步 | 两台手机共用一个 GitHub 私有仓库；配对只需粘一个 token |
| 📖 菜库 | 77 道内置粤闽家常菜，可按菜名或食材搜索 |
| 🔍 按食材找菜 | 勾选家里有的，列出「完全能做」和「差 1–2 样」的菜 |
| 📝 采购清单 | 把今晚要做的菜变成清单，标出家里缺什么，可复制 |
| 🙅 双人忌口 | 每人独立的过敏、忌口、辣度上限；冲突的菜自动过滤 |
| 🕘 避免重样 | 记录「做过了」，最近做过的菜随机时大幅降权 |
| 📱 离线可用 | 添加到主屏幕后断网也能用 |

未配置同步时，投票会自动降级为「从候选里挑一道」，单机也能完整使用。

---

## 数据

- `data/recipes.json` — 77 道菜，每道含食材用量、耗时、成本档、难度、辣度、健康度、器具、标签、小提示
- `data/ingredients.json` — 217 个食材，含别名、分类、常备调料标记、过敏原

菜库硬约束（设计时定死，改数据前请先看 PRD §7.2.1）：
不收粥、不收汤、不收肠粉、不收糕类、器具只有锅/蒸笼/空气炸锅/电饭煲、全部不辣、无「难」级、不含生蚝与苦瓜。

**过敏原分了 12 类**，其中贝类细分为 `oyster 蚝类`、`clam 蛤类`、`scallop 扇贝类`。
这样只忌口生蚝不会误杀姜葱炒花蛤和白灼虾——合并成一个 shellfish 会连带挡掉 5 道菜。

---

## 本地开发

无构建步骤。用仓库里的静态服务器起一下：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ..\serve-chishenme.ps1
# 打开 http://127.0.0.1:8776/
```

或者任意静态服务器指向本目录。**注意**：直接双击 `index.html`（`file://`）打不开——
浏览器会拦截 `fetch('data/*.json')`。必须走 http。

### 跑算法自测

打开 http://127.0.0.1:8776/test-core.html

79 项断言，覆盖日期工具、忌口过滤、食材匹配、候选池、去重降权、加权抽样、投票判定、采购清单、格式化、边界情况。
改 `core.js` 后请重跑一遍。

---

## 文件结构

```
index.html              外壳
style.css               全部样式（贴纸手账风：粉·黑·白 + 波点底 + 厚描边 + 硬投影）
core.js                 数据层：日期/过滤/匹配/抽样/投票/清单（纯函数，可独立测试）
sync.js                 同步层：GitHub Contents API、合并规则、配对识别、测试连接
app.js                  状态管理 + 路由 + 渲染
sw.js                   Service Worker（缓存名 chishenme-v2）
manifest.json           PWA 清单
icons/                  图标（180/192/512 + maskable）
data/recipes.json       77 道菜
data/ingredients.json   217 个食材
test-core.html          算法自测（79 项）
make-icons.ps1          重新生成图标
_deploy.ps1             一键部署（建仓库 + 上传 + 开 Pages）
PRD.md                  产品需求文档（14 章）
菜库清单-待审.md          菜库的人读版清单
```

**改代码后请把 `sw.js` 顶部的 `CACHE` 版本号 +1**，已安装用户才会拿到新版。

### 同步协议要点

- 投票文件按 `menu/votes/{会话id}-{是谁}.json` **拆分**，两人各写各的 —— 物理上不可能冲突
- 其余文件（config / pantry / menu / session / history）低频写，用 sha 乐观锁，冲突时重拉再试
- 合并规则：历史求并集去重、菜单取 `done=true` 的一方、冰箱最后写入胜、会话状态单向推进
- 等待对方投票时每 15 秒拉一次，页面切后台立即暂停，最长 10 分钟（省 API 配额）

---

## 部署到 GitHub Pages

**一条命令搞定**（会自动建两个仓库、上传代码、开启 Pages，可重复运行）：

```powershell
$env:GH_TOKEN = 'ghp_xxxx'
powershell -NoProfile -ExecutionPolicy Bypass -File _deploy.ps1
```

Token 需要能创建仓库的权限：classic token 勾 `repo` scope，或 fine-grained token 给 `Administration: Read and write`。

脚本会创建：

| 仓库 | 可见性 | 放什么 |
| --- | --- | --- |
| `chishenme` | **公开** | 网页代码（免费账号只有公开仓库能用 Pages） |
| `chishenme-data` | **私有** | 双人共享数据（同步用） |

**不要**把代码仓库改私有——免费账号的私有仓库不能用 Pages，网页会打不开。

首次部署后 Pages 需要 1–2 分钟生效。

### 之后配对（每台手机一次）

1. 建一个 fine-grained token，**只授权 `chishenme-data` 一个仓库**，权限选 `Contents: Read and write`
2. 打开 app → 我的 → 同步 → 粘贴 token → 保存并测试连接
3. 用户名和仓库名会自动识别，不用手填
4. 在「这台手机是谁」里选自己

两台手机各做一次，之后打开就自动同步。

---

## 已知限制

- 菜品编辑的食材输入用 prompt 填写食材 id（如 `tomato`），没有做可视化选择器
- 常备调料管理、口味档案编辑用的是简化交互（prompt），未做完整表单页
- 菜库搜索点击后弹出 prompt 输入，未做内联搜索框
- 同步是「拉取 + 推送」模式，不是实时推送；等待对方投票时靠 15 秒轮询
