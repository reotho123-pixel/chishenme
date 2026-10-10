/* ============================================================
   待会吃什么 · 同步层（GitHub 私有仓库当数据库）
   协议见 PRD §8。核心设计：
     · 投票文件按 votes/{sessionId}-{uid}.json 拆分，两人各写各的
       —— 物理上消除并发写冲突，这是整个同步能保持简单的原因
     · 其余文件低频写，用 sha 乐观锁 + 合并规则
   ============================================================ */
(function (root) {
  'use strict';

  var API = 'https://api.github.com';
  var DIR = 'menu';

  /* ---------- 基础请求 ---------- */

  function headers(token) {
    return {
      'Authorization': 'Bearer ' + token,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    };
  }

  // 返回 { ok, status, data, error }
  function request(method, path, token, body) {
    var url = path.indexOf('http') === 0 ? path : API + path;
    var opts = { method: method, headers: headers(token) };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return fetch(url, opts).then(function (res) {
      return res.text().then(function (txt) {
        var data = null;
        try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = txt; }
        if (!res.ok) {
          return { ok: false, status: res.status, data: data, error: describeError(res.status, data) };
        }
        return { ok: true, status: res.status, data: data };
      });
    }).catch(function (e) {
      return { ok: false, status: 0, error: '网络不可用', netError: true, raw: e };
    });
  }

  function describeError(status, data) {
    var msg = data && data.message ? '（' + data.message + '）' : '';
    if (status === 401) return 'Token 无效或已过期' + msg;
    if (status === 403) {
      if (data && /rate limit/i.test(data.message || '')) return '请求太频繁，稍后自动重试';
      return 'Token 缺少写入权限' + msg;
    }
    if (status === 404) return '仓库或路径找不到' + msg;
    if (status === 409 || status === 422) return '内容冲突，将自动合并重试' + msg;
    return '请求失败（HTTP ' + status + '）' + msg;
  }

  /* ---------- 身份识别（C 方案：只填 token） ---------- */

  /**
   * 用 token 自动识别用户名与数据仓库。
   * 返回 { ok, owner, repo, candidates, error }
   */
  function identify(token, preferRepo) {
    preferRepo = preferRepo || 'chishenme-data';
    return request('GET', '/user', token).then(function (u) {
      if (!u.ok) return { ok: false, error: u.error, status: u.status };
      var owner = u.data.login;

      // 探测候选仓库
      return request('GET', '/user/repos?per_page=100&sort=updated', token).then(function (rs) {
        if (!rs.ok) return { ok: false, owner: owner, error: rs.error, status: rs.status };
        var list = Array.isArray(rs.data) ? rs.data : [];
        // 优先精确匹配，其次所有 *-data / chishenme* 仓库
        var exact = list.filter(function (r) { return r.name === preferRepo; });
        var loose = list.filter(function (r) {
          return r.name !== preferRepo && /^(chishenme|menu|data)/i.test(r.name);
        });
        var candidates = exact.concat(loose).map(function (r) {
          return { name: r.name, private: r.private, owner: owner, full: r.full_name };
        });
        return {
          ok: true,
          owner: owner,
          repo: candidates.length ? candidates[0].name : preferRepo,
          candidates: candidates,
          exact: exact.length > 0
        };
      });
    });
  }

  /* ---------- 读写单个文件 ---------- */

  function b64encode(str) {
    // 正确处理中文：先转 UTF-8 字节再 base64
    var bytes = new TextEncoder().encode(str);
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  function b64decode(b64) {
    var bin = atob(String(b64).replace(/\s/g, ''));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  // 读一个文件：{ ok, data, sha } | { ok:true, missing:true }
  function readFile(cfg, name) {
    var path = '/repos/' + cfg.owner + '/' + cfg.repo + '/contents/' + DIR + '/' + name +
               '?ref=' + encodeURIComponent(cfg.branch || 'main') + '&t=' + Date.now();
    return request('GET', path, cfg.token).then(function (r) {
      if (!r.ok) {
        if (r.status === 404) return { ok: true, missing: true };
        return r;
      }
      var content = r.data && r.data.content ? b64decode(r.data.content) : '';
      var parsed = null;
      try { parsed = content ? JSON.parse(content) : null; } catch (e) { parsed = null; }
      return { ok: true, data: parsed, sha: r.data.sha, corrupt: content && !parsed };
    });
  }

  // 写一个文件：{ ok, sha } | { ok:false, conflict:true }
  function writeFile(cfg, name, obj, sha, message) {
    var path = '/repos/' + cfg.owner + '/' + cfg.repo + '/contents/' + DIR + '/' + name;
    var body = {
      message: message || ('update ' + name),
      content: b64encode(JSON.stringify(obj, null, 2)),
      branch: cfg.branch || 'main'
    };
    if (sha) body.sha = sha;
    return request('PUT', path, cfg.token, body).then(function (r) {
      if (!r.ok) {
        if (r.status === 409 || r.status === 422) return { ok: false, conflict: true, status: r.status };
        return r;
      }
      return { ok: true, sha: r.data && r.data.content ? r.data.content.sha : null };
    });
  }

  /* ---------- 投票文件（各写各的，永不冲突） ---------- */

  function voteFileName(sessionId, uid) { return 'votes/' + sessionId + '-' + uid + '.json'; }

  function readVote(cfg, sessionId, uid) {
    return readFile(cfg, voteFileName(sessionId, uid));
  }

  function writeVote(cfg, sessionId, uid, voteObj) {
    var name = voteFileName(sessionId, uid);
    // 先取 sha（若已存在）；投票文件理论上只写一次
    return readFile(cfg, name).then(function (r) {
      var sha = r.ok && !r.missing ? r.sha : null;
      return writeFile(cfg, name, voteObj, sha, 'vote ' + sessionId + ' ' + uid);
    });
  }

  /* ---------- 目录列举（拉取用） ---------- */

  function listDir(cfg, sub) {
    var path = '/repos/' + cfg.owner + '/' + cfg.repo + '/contents/' + DIR +
               (sub ? '/' + sub : '') + '?ref=' + encodeURIComponent(cfg.branch || 'main') + '&t=' + Date.now();
    return request('GET', path, cfg.token).then(function (r) {
      if (!r.ok) {
        if (r.status === 404) return { ok: true, items: [] };
        return r;
      }
      var items = Array.isArray(r.data) ? r.data : [];
      return {
        ok: true,
        items: items.map(function (x) {
          return { name: x.name, path: x.path, sha: x.sha, type: x.type, size: x.size };
        })
      };
    });
  }

  /* ---------- 合并规则（PRD §8.4） ---------- */

  // 历史：按 recipeId+date 去重求并集，保留最近 200 条
  function mergeDoneLog(local, remote) {
    var seen = {}, out = [];
    function push(list) {
      (list || []).forEach(function (x) {
        var k = x.recipeId + '@' + x.date;
        if (seen[k]) return;
        seen[k] = 1;
        out.push(x);
      });
    }
    push(local); push(remote);
    out.sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; });
    return out.slice(0, 200);
  }

  // 今晚菜单：按 recipeId+date 并集；同项取 done=true 的一方；超 48h 丢弃
  function mergeTonight(local, remote, todayStr) {
    var map = {};
    function push(list) {
      (list || []).forEach(function (x) {
        var k = x.recipeId + '@' + x.date;
        if (!map[k]) { map[k] = x; return; }
        var cur = map[k];
        if (x.done && !cur.done) map[k] = x;
      });
    }
    push(local); push(remote);
    var out = [];
    Object.keys(map).forEach(function (k) {
      var x = map[k];
      if (daysBetween(x.date, todayStr) > 2 && !x.done) return;   // 超 48h 未做 → 丢弃
      out.push(x);
    });
    return out;
  }

  function daysBetween(a, b) {
    function p(s) { var q = String(s).split('-'); return new Date(+q[0], +q[1] - 1, +q[2]); }
    return Math.round((p(b) - p(a)) / 86400000);
  }

  // 自定义菜：按 id 并集（本地优先）
  function mergeCustomRecipes(local, remote) {
    var map = {};
    (remote || []).forEach(function (r) { map[r.id] = r; });
    (local || []).forEach(function (r) { map[r.id] = r; });
    return Object.keys(map).map(function (k) { return map[k]; });
  }

  // 覆盖：按 recipeId 并集（本地优先）
  function mergeOverrides(local, remote) {
    var out = {};
    var k;
    for (k in remote) if (Object.prototype.hasOwnProperty.call(remote, k)) out[k] = remote[k];
    for (k in local) if (Object.prototype.hasOwnProperty.call(local, k)) out[k] = local[k];
    return out;
  }

  // 会话：状态单向推进 voting → revealed；同状态取 createdAt 更早的
  function mergeSession(local, remote) {
    if (!local) return remote || null;
    if (!remote) return local;
    var rank = { voting: 0, revealed: 1 };
    var lr = rank[local.status] === undefined ? 0 : rank[local.status];
    var rr = rank[remote.status] === undefined ? 0 : rank[remote.status];
    if (rr > lr) return remote;
    if (lr > rr) return local;
    return (local.createdAt || '') <= (remote.createdAt || '') ? local : remote;
  }

  /* ---------- 全量拉取 ---------- */

  /**
   * 拉取远端全部数据，与本地合并。
   * 返回 { ok, merged, remote, error }
   */
  function pull(cfg, localState, todayStr) {
    var names = ['config.json', 'pantry.json', 'menu.json', 'session.json', 'history.json'];
    var results = {};

    return names.reduce(function (chain, name) {
      return chain.then(function () {
        return readFile(cfg, name).then(function (r) {
          if (!r.ok) { results[name] = { error: r.error, status: r.status }; return; }
          results[name] = r.missing ? { missing: true } : { data: r.data, sha: r.sha };
        });
      });
    }, Promise.resolve()).then(function () {
      var merged = JSON.parse(JSON.stringify(localState));
      var touched = false;

      // config.json: members / customRecipes / recipeOverrides / defaultConditions
      var cf = results['config.json'];
      if (cf && cf.data) {
        var rc = cf.data;
        if (rc.customRecipes) {
          merged.customRecipes = mergeCustomRecipes(merged.customRecipes, rc.customRecipes);
          touched = true;
        }
        if (rc.recipeOverrides) {
          merged.recipeOverrides = mergeOverrides(merged.recipeOverrides, rc.recipeOverrides);
          touched = true;
        }
        if (rc.members) {
          // 成员档案：按 updatedAt 取新的；没有 updatedAt 就保留本地
          ['a', 'b'].forEach(function (k) {
            var lm = merged.members[k], rm = rc.members[k];
            if (!rm) return;
            if (!lm) { merged.members[k] = rm; touched = true; return; }
            var lt = lm.updatedAt || '', rt = rm.updatedAt || '';
            if (rt && rt > lt) { merged.members[k] = rm; touched = true; }
          });
        }
        if (rc.stapleRemoved) {
          var set = {};
          merged.stapleRemoved.concat(rc.stapleRemoved).forEach(function (x) { set[x] = 1; });
          merged.stapleRemoved = Object.keys(set);
          touched = true;
        }
      }

      // pantry.json: 最后写入胜
      var pf = results['pantry.json'];
      if (pf && pf.data) {
        var lp = merged.pantry || {}, rp = pf.data;
        if (!lp.updatedAt || (rp.updatedAt && rp.updatedAt > lp.updatedAt)) {
          merged.pantry = rp; touched = true;
        }
      }

      // menu.json
      var mf = results['menu.json'];
      if (mf && mf.data && Array.isArray(mf.data.tonight)) {
        var before = JSON.stringify(merged.tonight);
        merged.tonight = mergeTonight(merged.tonight, mf.data.tonight, todayStr);
        if (JSON.stringify(merged.tonight) !== before) touched = true;
      }

      // session.json
      var sf = results['session.json'];
      if (sf && sf.data) {
        var before2 = JSON.stringify(merged.session);
        merged.session = mergeSession(merged.session, sf.data.session || null);
        if (JSON.stringify(merged.session) !== before2) touched = true;
      }

      // history.json
      var hf = results['history.json'];
      if (hf && hf.data && Array.isArray(hf.data.doneLog)) {
        var before3 = JSON.stringify(merged.doneLog);
        merged.doneLog = mergeDoneLog(merged.doneLog, hf.data.doneLog);
        if (JSON.stringify(merged.doneLog) !== before3) touched = true;
      }

      return {
        ok: true,
        merged: merged,
        touched: touched,
        raw: results,
        shas: {
          config: results['config.json'] && results['config.json'].sha,
          pantry: results['pantry.json'] && results['pantry.json'].sha,
          menu: results['menu.json'] && results['menu.json'].sha,
          session: results['session.json'] && results['session.json'].sha,
          history: results['history.json'] && results['history.json'].sha
        }
      };
    });
  }

  /* ---------- 推送 ---------- */

  /**
   * 推送本地状态到远端。冲突时重拉一次再试。
   */
  function push(cfg, state, shas, todayStr) {
    var steps = [
      { name: 'config.json', body: {
          members: state.members,
          customRecipes: state.customRecipes,
          recipeOverrides: state.recipeOverrides,
          stapleRemoved: state.stapleRemoved,
          defaultConditions: state.defaultConditions,
          updatedAt: new Date().toISOString()
        }, shaKey: 'config' },
      { name: 'pantry.json', body: state.pantry, shaKey: 'pantry' },
      { name: 'menu.json', body: { tonight: state.tonight, updatedAt: new Date().toISOString() }, shaKey: 'menu' },
      { name: 'session.json', body: { session: state.session, updatedAt: new Date().toISOString() }, shaKey: 'session' },
      { name: 'history.json', body: { doneLog: state.doneLog, updatedAt: new Date().toISOString() }, shaKey: 'history' }
    ];

    var newShas = {};
    var errors = [];

    return steps.reduce(function (chain, step) {
      return chain.then(function () {
        var sha = shas ? shas[step.shaKey] : null;
        return writeFile(cfg, step.name, step.body, sha, 'sync ' + step.name).then(function (r) {
          if (r.ok) { newShas[step.shaKey] = r.sha; return; }
          if (r.conflict) {
            // 冲突：重新读 sha 再写一次
            return readFile(cfg, step.name).then(function (rr) {
              var sha2 = rr.ok && !rr.missing ? rr.sha : null;
              return writeFile(cfg, step.name, step.body, sha2, 'sync ' + step.name + ' (retry)').then(function (r2) {
                if (r2.ok) newShas[step.shaKey] = r2.sha;
                else errors.push(step.name + ': ' + (r2.error || '写入失败'));
              });
            });
          }
          errors.push(step.name + ': ' + (r.error || '写入失败'));
        });
      });
    }, Promise.resolve()).then(function () {
      return { ok: errors.length === 0, shas: newShas, errors: errors };
    });
  }

  /* ---------- 测试连接（P11 的四步流程） ---------- */

  /**
   * 依次验证：token → 仓库 → 写权限 → 初始化
   * onStep(i, label, state) 用来在界面上显示进度
   */
  function testConnection(token, preferRepo, onStep) {
    var cfg = { token: token, owner: null, repo: null, branch: 'main' };
    var steps = [];

    function step(i, label, state, extra) {
      steps.push({ label: label, state: state, extra: extra });
      if (onStep) onStep(i, label, state, extra);
    }

    step(0, '验证 Token…', 'running');
    return request('GET', '/user', token).then(function (u) {
      if (!u.ok) { step(0, '验证 Token…', 'fail', u.error); return { ok: false, steps: steps, error: u.error, status: u.status }; }
      cfg.owner = u.data.login;
      step(0, '验证 Token…', 'ok', cfg.owner);

      step(1, '识别数据仓库…', 'running');
      return identify(token, preferRepo).then(function (id) {
        if (!id.ok) { step(1, '识别数据仓库…', 'fail', id.error); return { ok: false, steps: steps, error: id.error, status: id.status }; }
        cfg.repo = id.repo;
        var exact = id.exact;
        step(1, '识别数据仓库…', exact ? 'ok' : 'warn',
             exact ? (id.owner + ' / ' + id.repo) : '未找到 ' + preferRepo + '，将使用 ' + id.repo);
        return { cfg: cfg, id: id };
      });
    }).then(function (r) {
      if (!r || !r.cfg) return r;
      var id = r.id;

      step(2, '检查仓库…', 'running');
      return request('GET', '/repos/' + cfg.owner + '/' + cfg.repo, token).then(function (rp) {
        if (!rp.ok) {
          step(2, '检查仓库…', 'fail', rp.status === 404 ? '找不到仓库 ' + cfg.repo + '，请手动填写仓库名' : rp.error);
          return { ok: false, steps: steps, error: rp.error, status: rp.status, cfg: cfg, needRepo: true, candidates: id.candidates };
        }
        step(2, '检查仓库…', 'ok', 'private=' + rp.data.private);

        step(3, '检查写入权限…', 'running');
        var pingName = 'votes/.ping-' + Date.now() + '.json';
        return writeFile(cfg, pingName, { t: Date.now() }, null, 'ping').then(function (w) {
          if (!w.ok) {
            step(3, '检查写入权限…', 'fail',
                 w.status === 403 ? 'Token 缺少 Contents 写入权限，请重新生成并勾选 Read and write' : (w.error || '写入失败'));
            return { ok: false, steps: steps, error: w.error, status: w.status, cfg: cfg };
          }
          step(3, '检查写入权限…', 'ok');

          step(4, '初始化数据…', 'running');
          return readFile(cfg, 'config.json').then(function (cf) {
            if (cf.ok && !cf.missing) { step(4, '初始化数据…', 'ok', '已存在'); return { ok: true, steps: steps, cfg: cfg }; }
            return writeFile(cfg, 'config.json', {
              members: null, customRecipes: [], recipeOverrides: {}, stapleRemoved: [],
              createdAt: new Date().toISOString()
            }, null, 'init config').then(function () {
              step(4, '初始化数据…', 'ok', '已创建');
              return { ok: true, steps: steps, cfg: cfg };
            });
          });
        });
      });
    }).catch(function (e) {
      return { ok: false, steps: steps, error: '出错了：' + (e && e.message ? e.message : e) };
    });
  }

  var api = {
    identify: identify,
    readFile: readFile,
    writeFile: writeFile,
    readVote: readVote,
    writeVote: writeVote,
    voteFileName: voteFileName,
    listDir: listDir,
    pull: pull,
    push: push,
    testConnection: testConnection,
    mergeDoneLog: mergeDoneLog,
    mergeTonight: mergeTonight,
    mergeCustomRecipes: mergeCustomRecipes,
    mergeOverrides: mergeOverrides,
    mergeSession: mergeSession,
    b64encode: b64encode,
    b64decode: b64decode,
    describeError: describeError
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ChishenmeSync = api;
})(typeof window !== 'undefined' ? window : globalThis);
