# 待会吃什么

两个人一起定「今天吃什么」的 PWA。

**在线使用**：https://reotho123-pixel.github.io/chishenme/

## 分享给朋友 / 给另一台手机用

这个应用**不含任何数据** —— 就是一个网页。任何人打开上面的网址，看到的是**全新的空白状态**
（没有你的菜单、没有你的食材、没有你的忌口设置）。你的记录一条都不会被看到。

### 双人同步怎么配（每台手机各做一次）

两台手机要共享数据，需要一个**私有**仓库当数据库。仓库已经建好了：`chishenme-data`。

**第一步：建 token（每个使用者各建一个）**

1. 打开 https://github.com/settings/personal-access-tokens/new
2. 名称随意（如 `chishenme-me` / `chishenme-her`），过期时间选最长
3. **Repository access** → Only select repositories → 只勾 **`chishenme-data`**
4. **Permissions** → Repository permissions → **Contents: Read and write**
5. 生成，复制那串 `github_pat_...`

> ⚠️ 只授权 `chishenme-data` 这一个仓库。不要勾别的，也不要用你的主 token。

**第二步：在应用里配对**

1. 打开 https://reotho123-pixel.github.io/chishenme/（建议先「添加到主屏幕」）
2. 进「我的」→ 同步 → 粘贴 token → 点「保存并测试连接」
3. 用户名和仓库名会**自动识别**，不用手填
4. 在「这台手机是谁」里选自己（我 / 小美）

两台手机各做一次，之后打开就自动同步了。

### 为什么两人要用不同的 token

GitHub 会记录是谁改的数据，应用用它显示「上次更新：今天 18:30 · 小美」这类信息。
而且哪天要撤销某个人的访问，各撤各的不会互相影响。

## 仓库结构

| 仓库 | 可见性 | 放什么 |
| --- | --- | --- |
| `chishenme` | **公开** | 网页代码（免费账号只有公开仓库能用 Pages） |
| `chishenme-data` | **私有** | 双人共享数据（菜单、食材、忌口、历史） |

> ⚠️ **不要把 `chishenme` 改成私有** —— 免费账号的私有仓库**不能用 GitHub Pages**，改了网页就打不开了。
> 这就是要把「网页」和「数据」拆成两个仓库的原因。

## 同步协议要点

- 投票文件按 `menu/votes/{会话id}-{是谁}.json` **拆分**，两人各写各的 —— 物理上不可能冲突
- 其余文件（config / pantry / menu / session / history）低频写，用 sha 乐观锁，冲突时重拉再试
- 合并规则：历史求并集去重、菜单取「已做过」的一方、冰箱最后写入胜、会话状态单向推进
- 等待对方投票时每 15 秒拉一次，页面切后台立即暂停，最长 10 分钟（省 API 配额）

## 本地开发

无构建步骤，用任意静态服务器指向本目录即可：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ..\serve-chishenme.ps1
# 打开 http://127.0.0.1:8776/
```

**注意**：直接双击 `index.html`（`file://`）打不开 —— 浏览器会拦截 `fetch('data/*.json')`。必须走 http。

### 跑算法自测

打开 http://127.0.0.1:8776/test-core.html —— 79 项断言，覆盖日期工具、忌口过滤、食材匹配、
候选池、去重降权、加权抽样、投票判定、采购清单、格式化、边界情况。改 `core.js` 后请重跑。

## 重新部署

```powershell
$env:GH_TOKEN = 'ghp_xxxx'   # 需要 repo 权限
powershell -NoProfile -ExecutionPolicy Bypass -File _deploy.ps1
```

可重复运行。改代码后记得把 `sw.js` 的 `CACHE` 版本号 +1，已安装用户才会拿到新版。

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

## 菜库硬约束

设计时定死（改数据前请先看 PRD §7.2.1）：

- 不收粥、不收汤、不收肠粉、不收糕类
- 器具只有锅 / 蒸笼 / 空气炸锅 / 电饭煲四种
- 全部不辣（粤菜广府+潮汕+客家，闽菜闽南+福州）
- 无「难」级菜品
- 不含生蚝与苦瓜（家里有人忌口）
- 过敏原分 12 类，贝类细分为 `oyster 蚝类` / `clam 蛤类` / `scallop 扇贝类`
  —— 这样只忌生蚝不会误杀姜葱炒花蛤和白灼虾

## 已知限制

- 菜品编辑的食材输入用 prompt 填写食材 id（如 `tomato`），没有做可视化选择器
- 常备调料管理、口味档案编辑用的是简化交互（prompt），未做完整表单页
- 菜库搜索点击后弹出 prompt 输入，未做内联搜索框
- 同步是「拉取 + 推送」模式，不是实时推送；等待对方投票时靠 15 秒轮询
