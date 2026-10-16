/* ============================================================
   待会吃什么 · 应用外壳（状态管理 + 路由 + 渲染）
   依赖 core.js（window.ChishenmeCore）
   ============================================================ */
(function () {
  'use strict';
  var C = window.ChishenmeCore;
  var LS_KEY = 'chishenme-v1';
  var LS_TOKEN = 'chishenme-token';

  /* ---------- 状态 ---------- */
  var S = {
    state: null,
    ingredients: null,
    recipes: null,
    ingIndex: null,
    recipeById: {},
    tab: 'today',
    view: null,          // { name, params }
    pool: null,          // 上一次抽菜结果
    toast: null
  };

  // 写入本机 + 顺手安排一次静默同步推送（同步未配置时什么都不做）
  function save() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(S.state));
    } catch (e) {
      console.warn('保存失败', e);
    }
    if (S.syncReady && typeof pushSoon === 'function') pushSoon();
  }

  function load() {
    var raw = null;
    try { raw = localStorage.getItem(LS_KEY); } catch (e) {}
    if (!raw) { S.state = C.defaultState(); save(); return; }
    try {
      var parsed = JSON.parse(raw);
      S.state = migrate(parsed);
    } catch (e) {
      console.warn('数据损坏，已重置', e);
      S.state = C.defaultState();
      save();
    }
  }

  function migrate(st) {
    var def = C.defaultState();
    for (var k in def) {
      if (!Object.prototype.hasOwnProperty.call(def, k)) continue;
      if (st[k] === undefined || st[k] === null) st[k] = def[k];
    }
    if (!st.members || !st.members.a || !st.members.b) st.members = def.members;
    if (!st.pantry) st.pantry = def.pantry;
    if (!st.defaultConditions) st.defaultConditions = C.defaultConditions();
    if (!st.lastConditions) st.lastConditions = C.defaultConditions();
    if (!st.customRecipes) st.customRecipes = [];
    if (!st.recipeOverrides) st.recipeOverrides = {};
    if (!st.tonight) st.tonight = [];
    if (!st.doneLog) st.doneLog = [];
    if (!st.stapleRemoved) st.stapleRemoved = [];
    return st;
  }

  /* ---------- 工具 ---------- */
  function el(html) {
    var d = document.createElement('div');
    d.innerHTML = html.trim();
    return d.firstChild;
  }
  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function recipe(id) { return S.recipeById[id]; }
  function today() { return C.dateStr(); }
  function me() { return S.state.me; }
  function partner() { return S.state.me === 'a' ? 'b' : 'a'; }
  function memberName(key) { return (S.state.members[key] || {}).name || key; }

  function toast(msg, actionLabel, action) {
    S.toast = { msg: msg, actionLabel: actionLabel, action: action, at: Date.now() };
    // 带「撤销」的提示要留久一点 —— 3 秒来不及看清再点中
    var life = action ? 6000 : 2800;
    S.toast.life = life;
    render();
    setTimeout(function () {
      if (S.toast && Date.now() - S.toast.at >= life) { S.toast = null; render(); }
    }, life + 200);
  }

  /* ---------- 今晚菜单 ---------- */
  function tonightActive() {
    var t = today();
    return (S.state.tonight || []).filter(function (x) {
      // 超过 48 小时且未标记做过的自动丢弃
      var age = C.daysBetween(x.date, t);
      if (age > 2 && !x.done) return false;
      // 已做过的，跨天就移除
      if (x.done && x.date !== t) return false;
      return age <= 2;
    });
  }

  function cleanupTonight() {
    var before = (S.state.tonight || []).length;
    S.state.tonight = tonightActive();
    if (S.state.tonight.length !== before) save();
  }

  function addTonight(recipeId) {
    var t = today();
    var exists = (S.state.tonight || []).some(function (x) { return x.recipeId === recipeId && x.date === t; });
    if (exists) return false;
    if (S.state.tonight.length >= 3) return false;
    S.state.tonight.push({
      recipeId: recipeId, date: t,
      decidedAt: new Date().toISOString(), decidedBy: me(),
      done: false, doneAt: null
    });
    save();
    return true;
  }

  function markDone(recipeId) {
    var t = today();
    var item = S.state.tonight.filter(function (x) { return x.recipeId === recipeId && x.date === t; })[0];
    if (!item) return;
    item.done = true;
    item.doneAt = new Date().toISOString();
    S.state.doneLog.unshift({ recipeId: recipeId, date: t, by: me() });
    if (S.state.doneLog.length > 200) S.state.doneLog.length = 200;
    save();
  }

  function undoDone(recipeId) {
    var t = today();
    var item = S.state.tonight.filter(function (x) { return x.recipeId === recipeId && x.date === t; })[0];
    if (item) { item.done = false; item.doneAt = null; }
    S.state.doneLog = S.state.doneLog.filter(function (x) {
      return !(x.recipeId === recipeId && x.date === t);
    });
    save();
  }

  function removeTonight(recipeId) {
    S.state.tonight = S.state.tonight.filter(function (x) { return x.recipeId !== recipeId; });
    save();
  }

  /* ---------- 最近做过 ---------- */
  function recentDone(n) {
    var log = (S.state.doneLog || []).slice();
    log.sort(function (a, b) { return a.date < b.date ? 1 : -1; });
    var seen = {}, out = [];
    for (var i = 0; i < log.length && out.length < n; i++) {
      if (seen[log[i].recipeId]) continue;
      seen[log[i].recipeId] = 1;
      out.push(log[i]);
    }
    return out;
  }

  /* ---------- 会话（投票） ---------- */
  function newSession(candidates) {
    var sid = 's-' + today().replace(/-/g, '') + '-' + Math.floor(Date.now() / 1000);
    S.state.session = {
      id: sid, date: today(), candidates: candidates.slice(),
      createdBy: me(), createdAt: new Date().toISOString(),
      status: 'voting', myVote: null, mySubmittedAt: null
    };
    save();
    return S.state.session;
  }

  function sessionExpired() {
    var s = S.state.session;
    return !!(s && s.date !== today());
  }

  function clearSession() { S.state.session = null; save(); }

  /* ---------- 渲染：公共片段 ---------- */

  // 底部导航用标记包起来，render() 会把它抽出来放进固定的 nav-dock
  var NAV_MARK = '<!--__NAV__-->';

  // 弹层同理：抽出来放进固定的 .sheet-host。
  // 放在 .scr 里会被整页重渲染顺带重建 —— 那会打断打字、还会让入场动画重播（看起来"一直在跳"）。
  var SHEET_MARK = '<!--__SHEET__-->';

  // 中文输入法正在拼字。拼字期间不能去动 input.value，否则候选会被打断。
  var ingComposing = false;
  // 食材页（Tab）自己的搜索词与拼字标志。和弹层分开：
  // 两者可以同时存在（弹层从食材页里开出来），共用一个会互相踩。
  var pantryComposing = false;

  // 弹层"身份"：相同就不重建 DOM。
  // 只给带输入框的弹层签名 —— 它们的输入框节点必须活着。
  // 其余弹层（确认、随机）内容依赖状态，每次重绘一遍最省心，也没有焦点可丢。
  function sheetSig() {
    var v = S.view;
    if (!v) return '';
    if (v.name === 'ingPicker') return 'ingPicker:' + (S._pickSeq || 0);
    if (v.name === 'askInput') return 'askInput:' + (S._askSeq || 0);
    return '';
  }

  function navHTML(active) {
    var items = [['today', '今天'], ['library', '菜库'], ['pantry', '食材'], ['me', '我的']];
    return NAV_MARK +
           '<div class="nav-outer">' +
             '<span class="nav-pill"></span>' +
             items.map(function (it) {
               return '<div class="nav-i' + (it[0] === active ? ' on' : '') + '" data-tab="' + it[0] + '">' + it[1] + '</div>';
             }).join('') +
           '</div>' +
           NAV_MARK;
  }

  /**
   * 把滑动胶囊对齐到当前选中的 Tab。
   * animate=false 时（首次渲染 / 布局变化）直接落位，不做过渡。
   */
  function syncNavPill(animate) {
    var outer = document.querySelector('.nav-dock .nav-outer');
    if (!outer) return;
    var pill = outer.querySelector('.nav-pill');
    var on = outer.querySelector('.nav-i.on');
    if (!pill || !on) return;

    var or = outer.getBoundingClientRect();
    var nr = on.getBoundingClientRect();
    var w = nr.width, h = nr.height;
    // absolute 定位的原点是 padding box（边框内侧），
    // 而 getBoundingClientRect 给的是 border box —— 要减掉边框宽度，否则整体偏移。
    var x = nr.left - or.left - outer.clientLeft;
    var y = nr.top - or.top - outer.clientTop;

    // 只在「首次落位」或「明确不带动画」时瞬时到位；
    // 其余情况（切换 Tab）让 CSS 过渡把它滑过去。
    var first = pill.dataset.placed !== '1';
    if (first || !animate) {
      pill.style.transition = 'none';
      pill.style.width = w + 'px';
      pill.style.height = h + 'px';
      pill.style.transform = 'translate(' + x + 'px,' + y + 'px)';
      // 强制回流后再恢复过渡，否则这次的 none 会被下一次覆盖掉
      void pill.offsetWidth;
      pill.style.transition = '';
      pill.dataset.placed = '1';
      return;
    }

    pill.style.width = w + 'px';
    pill.style.height = h + 'px';
    pill.style.transform = 'translate(' + x + 'px,' + y + 'px)';
  }

  function stars(n, total) {
    total = total || 5;
    var s = '';
    for (var i = 0; i < total; i++) s += '<i class="' + (i < n ? '' : 'off') + '"></i>';
    return '<span class="circles">' + s + '</span>';
  }

  function healthDots(n) {
    var s = '';
    for (var i = 0; i < 5; i++) s += '<i class="' + (i < n ? '' : 'off') + '"></i>';
    return '<span class="circles">' + s + '</span>';
  }

  function metaLine(r) {
    return C.fmtMinutes(r.minutes) + ' · ' + C.fmtCost(r.cost) + ' · ' + C.fmtDifficulty(r.difficulty);
  }

  /* ---------- 渲染：P1 今天 ---------- */

  function renderToday() {
    var st = S.state;
    var t = today();
    var menu = tonightActive();
    var sess = st.session;
    var h = '';

    // 顶部原来的「日期吊牌 + 问候 + 三心」已去掉：整块装饰挤在卡片上方，
    // 让主卡到不了顶。现在直接从会话横幅 / 主卡开始。

    // 会话横幅（双气泡）
    if (sess && !sessionExpired()) {
      var mySubmitted = !!sess.mySubmittedAt;
      h += '<div class="bubbles">';
      if (!mySubmitted) {
        h += '<div class="bub black"><div class="t1">🗳 今晚选菜 · 还差你</div>' +
             '<div class="hearts-row"><i>♥</i><i>♥</i><i>♥</i></div><div class="tail"></div></div>' +
             '<div class="bub grey"><div class="t2">有 ' + sess.candidates.length + ' 道候选等你选</div>' +
             '<div class="dots3"><i></i><i></i><i></i></div><div class="tail"></div></div>' +
             '<div class="goto" data-act="vote">去投票</div>';
      } else {
        h += '<div class="bub black"><div class="t1">🗳 今晚选菜 · 已投 <span>1/2</span></div>' +
             '<div class="hearts-row"><i>♥</i><i>♥</i><i>♥</i></div><div class="tail"></div></div>' +
             '<div class="bub grey"><div class="t2">等 TA 投完就能揭晓</div>' +
             '<div class="dots3"><i></i><i></i><i></i></div><div class="tail"></div></div>' +
             '<div class="goto" data-act="vote">看结果</div>';
      }
      h += '</div>';
    }

    // 随机选菜主卡
    h += '<div class="hero">';
    h += '<div class="hero-bg"></div>';
    h += '<div class="hero-card">';
    h += '<div class="hero-dots"></div>';
    h += '<div class="tape-black"></div>';
    h += '<div class="pill-tag">今晚</div>';
    h += '<span class="spark" style="left:16px;top:64px;font-size:15px">✦</span>';
    h += '<span class="spark" style="right:22px;bottom:88px;font-size:13px">✦</span>';
    h += '<div class="dice-wrap"><div class="dice">🎲</div></div>';
    h += '<div class="h1">随机选菜</div>';
    // 「30 分钟内 · 不辣 · 排除最近 7 天」这行条件和下面的「N 道可选」都已按
    // 用户要求删除：筛选偏好这个功能整块不要了，就不该再露出任何条件文案。
    h += '<div class="heart-arc"><i>♥</i><i>♥</i><i>♥</i><i>♥</i><i>♥</i></div>';
    h += '<div class="btn-main" data-act="random">开 始</div>';
    // 三个次级入口都收进主卡（原来下面还单独有一排快捷按钮，功能重复，已删）
    var shop = C.buildShoppingList(menu, st, S.ingIndex, S.recipeById);
    h += '<div class="hero-alt">' +
         '<div class="alt" data-act="pick-self">自己挑一道</div>' +
         '<div class="alt" data-act="find-by-pantry">按食材找菜</div>' +
         '<div class="alt" data-act="go-shopping">采购清单' +
         (shop.total ? '<span class="alt-dot">' + shop.total + '</span>' : '') +
         '</div>' +
         '</div>';
    h += '</div></div>';

    // （原先卡片下方那排快捷方章「挑一道 / 按食材 / 采购清单」已删除：
    //   前两个和卡里的按钮重复，采购清单也一并移到卡里了。）

    // 今晚菜单
    h += '<div class="sec" style="margin-top:4px"><span class="t">今晚菜单</span><span class="h">♡</span>' +
         (menu.length ? '<span class="count-tag">' + menu.length + ' 道</span>' : '') + '</div>';

    if (!menu.length) {
      h += '<div class="card plain"><div class="cbg"></div><div class="cbody" style="text-align:center;padding:20px 16px">' +
           '<div style="font-size:13px;font-weight:800;color:#111;margin-bottom:6px">还没定今晚吃什么</div>' +
           '<div style="font-size:11.5px;font-weight:700;color:#8A8A8A;line-height:1.7">点上面的「开始」抽几道，<br>或者自己挑一道</div>' +
           '</div></div>';
    } else {
      for (var i = 0; i < menu.length; i++) {
        h += dishCard(menu[i]);
      }
      if (menu.length < 3) {
        h += '<div class="add" data-act="random">+ 再加一道</div>';
      } else {
        h += '<div class="add" style="opacity:.5">今晚菜单已满（3 道）</div>';
      }
    }

    // 最近做过
    var rec = recentDone(5);
    if (rec.length) {
      h += '<div class="sec" style="margin-top:6px"><span class="t">最近做过</span><span class="h">♡</span></div>';
      h += '<div class="dark-card"><div class="gloss"></div>';
      h += '<div class="dc-head"><div class="cloud-orbit">' +
           '<svg class="ring" viewBox="0 0 80 34"><ellipse cx="40" cy="17" rx="38" ry="14"/></svg>' +
           '<span class="sp" style="left:8px;top:4px">✦</span>' +
           '<svg class="cloud" width="60" height="38" viewBox="0 0 64 42" fill="#F7C8D4">' +
           '<circle cx="19" cy="27" r="11"/><circle cx="33" cy="19" r="14"/><circle cx="47" cy="27" r="10"/>' +
           '<rect x="19" y="27" width="28" height="11" rx="5.5"/></svg></div>';
      h += '<div class="txt"><div class="hnum"><span class="n">' + rec.length + '</span><span class="u">道 · 最近做过</span></div>' +
           '<div class="arc"><i>♥</i><i>♥</i><i>♥</i><i>♥</i><i>♥</i></div></div></div>';
      for (var j = 0; j < rec.length; j++) {
        var r2 = recipe(rec[j].recipeId);
        if (!r2) continue;
        h += '<div class="dc-row" data-act="open-recipe" data-id="' + r2.id + '">' +
             '<span class="e">' + r2.emoji + '</span><span class="nm">' + esc(r2.name) + '</span>' +
             '<span class="tm">' + C.fmtRelativeDate(rec[j].date, t) + '</span></div>';
      }
      h += '</div>';
    }

    h += navHTML('today');
    return h;
  }

  function dishCard(item) {
    var r = recipe(item.recipeId);
    if (!r) return '';
    var miss = C.recipeMissing(r, S.state, S.ingIndex);
    var h = '<div class="note-card">';
    h += '<div class="note-bg"></div><div class="note-body">';
    h += '<div class="tp"></div>';
    h += '<div class="note-head" data-act="open-recipe" data-id="' + r.id + '">' +
         '<span class="badge">' + r.emoji + '</span>' +
         '<span class="nm">' + esc(r.name) + '</span>' +
         '<span class="mt">' + metaLine(r) + '</span></div>';
    h += '<div class="circles" style="margin-bottom:11px"><span class="cl">健康</span>' +
         healthDots(r.healthy).replace('<span class="circles">', '').replace('</span>', '') + '</div>';
    h += '<hr class="dash">';
    if (miss.canCook) {
      h += '<div class="ready"><span>✓</span><span>食材都齐了</span></div>';
    } else {
      var names = miss.missing.slice(0, 3).map(function (x) { return x.name; }).join('、');
      var more = miss.missing.length > 3 ? ' 等 ' + miss.missing.length + ' 样' : '';
      h += '<div class="buy-mini">需要买：' + esc(names) + more + '</div>';
    }
    h += '<div class="ops">';
    h += '<span class="pri" data-act="go-shopping">看清单</span>';
    if (item.done) {
      h += '<span data-act="undo-done" data-id="' + r.id + '">撤销已做</span>';
    } else {
      h += '<span data-act="done" data-id="' + r.id + '">做过了</span>';
    }
    h += '<span data-act="remove-tonight" data-id="' + r.id + '">移出</span>';
    h += '</div>';
    h += '<div class="fold"></div>';
    h += '</div></div>';
    return h;
  }

  /* ---------- 渲染：P5 随机选菜（弹层） ---------- */

  // condSummary / poolCount 已随「筛选偏好」整块功能删除：
  // 条件文案和「N 道可选」都不再展示了，没有调用方。

  function renderRandomSheet(expanded) {
    var c = S.state.lastConditions;
    var p = C.buildPool(c, S.recipes, S.state, S.ingIndex, { today: today() });
    var h = '';
    h += '<div class="sheet-top"><div class="grip"></div><div class="st">随机选菜</div></div>';
    // 这里原来还有两块内容，都按用户要求删掉了：
    //   1. 一行条件文案（「30 分钟内 · 不辣 · 排除最近 7 天」）
    //   2. 「N 道菜符合条件 / 够抽 N 道」那块 feedback
    // 筛选偏好功能整块不要了，就不该再露出条件或数量。
    // 只剩抽菜这一个动作。
    if (p.notes.length) {
      h += '<div class="note-mini">' + p.notes.map(function (n) { return esc(n.text); }).join('<br>') + '</div>';
    }
    h += '<div class="btn-main" data-act="do-draw">🎲 抽 ' + c.count + ' 道</div>';
    return sheet(h);
  }

  /* ---------- 渲染：P6 投票 / 揭晓 ---------- */

  function renderVote() {
    var sess = S.state.session;
    var h = '';
    h += '<div class="bar"><div class="back" data-act="back">←</div><div>' +
         '<div class="ttl">今晚选菜</div><div class="sub2">' +
         (sess ? sess.candidates.length + ' 道候选' : '') + '</div></div></div>';

    if (!sess || sessionExpired()) {
      h += '<div class="card plain"><div class="cbg"></div><div class="cbody" style="text-align:center;padding:22px 16px">' +
           '<div style="font-size:13.5px;font-weight:900;color:#111;margin-bottom:8px">这次选菜已过期</div>' +
           '<div style="font-size:11.5px;font-weight:700;color:#8A8A8A;line-height:1.7;margin-bottom:14px">选菜只在当天有效，跨零点就作废了</div>' +
           '<div class="btn-main" data-act="random">重新选一次</div></div></div>';
      h += navHTML('today');
      return h;
    }

    // 状态 1：我还没投
    if (!sess.mySubmittedAt) {
      h += '<div class="bubbles"><div class="bub black"><div class="t1">每道都选一个</div>' +
           '<div class="hearts-row"><i>♥</i><i>♥</i><i>♥</i></div><div class="tail"></div></div>' +
           '<div class="bub grey"><div class="t2">对方看不到你的选择</div>' +
           '<div class="dots3"><i></i><i></i><i></i></div><div class="tail"></div></div></div>';

      var pending = 0;
      for (var i = 0; i < sess.candidates.length; i++) {
        var r = recipe(sess.candidates[i]);
        if (!r) continue;
        var my = (sess.myVote || {})[r.id];
        if (!my) pending++;
        h += '<div class="note-card"><div class="note-bg"></div><div class="note-body">';
        h += '<div class="note-head"><span class="badge">' + r.emoji + '</span>' +
             '<span class="nm">' + esc(r.name) + '</span>' +
             '<span class="mt">' + metaLine(r) + '</span></div>';
        h += '<div class="circles" style="margin-bottom:10px"><span class="cl">健康</span>' +
             healthDots(r.healthy).replace('<span class="circles">', '').replace('</span>', '') + '</div>';
        h += '<div class="vote-row" data-vote-for="' + r.id + '">' +
             voteBtn(r.id, 'want', '想吃', my) +
             voteBtn(r.id, 'ok', '都行', my) +
             voteBtn(r.id, 'no', '不吃', my) +
             '</div>';
        h += '</div></div>';
      }
      h += '<div class="feedback"><span class="fn">' + pending + '</span><div>' +
           '<div class="ft">道还没选</div><div class="fs">' +
           (pending ? '选完就能提交' : '可以提交了') + '</div></div></div>';
      h += '<div class="btn-main' + (pending ? ' dis' : '') + '" data-act="submit-vote">提 交</div>';
      h += '<div class="btn-sub" data-act="cancel-session">取消这次投票</div>';
      h += navHTML('today');
      return h;
    }

    // 状态 2：我投了，等对方
    h += '<div class="sec"><span class="t">我的选择</span></div>';
    for (var j = 0; j < sess.candidates.length; j++) {
      var r2 = recipe(sess.candidates[j]);
      if (!r2) continue;
      var v = (sess.myVote || {})[r2.id];
      var vt = v === 'want' ? '想吃' : v === 'ok' ? '都行' : v === 'no' ? '不吃' : '—';
      h += '<div class="rrow"><span class="b">' + r2.emoji + '</span>' +
           '<div class="tx"><div class="n1">' + esc(r2.name) + '</div>' +
           '<div class="n2">' + metaLine(r2) + '</div></div>' +
           '<span class="was">' + vt + '</span></div>';
    }
    h += '<div class="bubbles" style="margin-top:6px"><div class="bub black"><div class="t1">等 ' + esc(memberName(partner())) + ' 投票…</div>' +
         '<div class="hearts-row"><i>♥</i><i>♥</i><i>♥</i></div><div class="tail"></div></div></div>';
    if (syncOn()) {
      h += '<div class="btn-main" data-act="check-partner">刷 新 看 看</div>';
      h += '<div class="note-mini" style="text-align:center">页面在前台时每 15 秒自动刷新一次</div>';
    } else {
      h += '<div class="btn-main" data-act="reveal-sim">看看结果</div>';
      h += '<div class="note-mini" style="text-align:center">还没配置同步，现在是单人模式</div>';
    }
    h += '<div class="btn-sub" data-act="pick-direct">不等了，我直接选</div>';
    h += '<div class="btn-sub" data-act="cancel-session">取消这次投票</div>';
    h += navHTML('today');
    return h;
  }

  function voteBtn(recipeId, val, label, cur) {
    var on = cur === val;
    return '<span class="vbtn' + (on ? ' on' : '') + (val === 'no' ? ' no' : '') + '" ' +
           'data-vote="' + val + '" data-id="' + recipeId + '">' + label + '</span>';
  }

  function renderReveal() {
    var sess = S.state.session;
    if (!sess) { S.view = null; return renderToday(); }
    var votesA = sess.myVote || {};
    // 单机模式：没有同步配置时走降级展示
    var solo = !syncOn();
    var votesB = solo ? {} : (sess.partnerVote || {});

    var h = '<div class="bar"><div class="back" data-act="back">←</div><div>' +
            '<div class="ttl">今晚选菜</div><div class="sub2">结果</div></div></div>';

    var g;
    if (solo) {
      // 单机：直接列出候选供选择
      h += '<div class="bubbles"><div class="bub black"><div class="t1">单人模式</div>' +
           '<div class="hearts-row"><i>♥</i><i>♥</i><i>♥</i></div><div class="tail"></div></div>' +
           '<div class="bub grey"><div class="t2">还没配置同步，直接从候选里挑</div>' +
           '<div class="dots3"><i></i><i></i><i></i></div><div class="tail"></div></div></div>';
      h += '<div class="sec"><span class="t">候选</span></div>';
      for (var i = 0; i < sess.candidates.length; i++) {
        var r = recipe(sess.candidates[i]);
        if (!r) continue;
        h += '<div class="res"><div class="rb"></div><div class="rbody" data-act="decide" data-id="' + r.id + '">' +
             '<span class="badge">' + r.emoji + '</span><div>' +
             '<div class="rn">' + esc(r.name) + '</div><div class="rm">' + metaLine(r) + '</div></div>' +
             '<span class="crown">›</span></div></div>';
      }
      h += navHTML('today');
      return h;
    }

    // 两人都投完了：分组
    var va = {}, vb = {};
    for (var k = 0; k < sess.candidates.length; k++) {
      var id = sess.candidates[k];
      va[id] = (sess.myVote || {})[id];
      vb[id] = (sess.partnerVote || {})[id] || 'ok';
    }
    g = C.groupVotes(sess.candidates, va, vb);

    h += '<div class="cloud"><svg viewBox="0 0 200 200"><path d="M170 100 A 17 17 0 0 1 160.6 135 A 17 17 0 0 1 135 160.6 A 17 17 0 0 1 100 170 A 17 17 0 0 1 65 160.6 A 17 17 0 0 1 39.4 135 A 17 17 0 0 1 30 100 A 17 17 0 0 1 39.4 65 A 17 17 0 0 1 65 39.4 A 17 17 0 0 1 100 30 A 17 17 0 0 1 135 39.4 A 17 17 0 0 1 160.6 65 A 17 17 0 0 1 170 100 Z" fill="#141414"/></svg>' +
         '<div class="ct">' + (g.want.length ? '你们都想吃' : g.ok.length ? '没人反对' : '这次没定下来') +
         '<span class="sm">从 ' + sess.candidates.length + ' 道里挑出 ' + g.want.length + ' 道</span>' +
         '<span class="ht">♥</span></div></div>';

    var pick = g.want.length ? g.want[0] : (g.ok.length ? C.pickFromOk(g.ok, S.recipeById) : null);

    if (g.want.length) {
      h += '<div class="grp-t"><span class="gt">🎉 你们都想吃</span><span class="gc">' + g.want.length + ' 道</span></div>';
      for (var a = 0; a < g.want.length; a++) h += resultRow(g.want[a], va, vb, true, g.want[a] === pick);
    }
    if (g.ok.length) {
      h += '<div class="grp-t"><span class="gt">都还行 · 没人反对</span><span class="gc">' + g.ok.length + ' 道</span></div>';
      for (var b = 0; b < g.ok.length; b++) h += resultRow(g.ok[b], va, vb, false, g.ok[b] === pick);
    }
    if (g.no.length) {
      h += '<div class="grp-t mut"><span class="gt">有人不想吃 · 已排除</span><span class="gc">' + g.no.length + ' 道</span></div>';
      for (var c = 0; c < g.no.length; c++) h += resultRow(g.no[c], va, vb, false, false, true);
    }

    if (pick) {
      var pr = recipe(pick);
      h += '<div class="btn-main" data-act="decide" data-id="' + pick + '">' +
           (g.want.length ? '就 做 它' : '就定这道') + '</div>';
      if (!g.want.length && pr) {
        h += '<div class="note-mini" style="text-align:center">没有两人都想吃的，随机定了「' + esc(pr.name) + '」</div>';
      }
      h += '<div class="btn-sub" data-act="random">重新抽一批</div>';
    } else {
      h += '<div class="note-mini" style="text-align:center">这次没有共同选项，试试放宽条件</div>';
      h += '<div class="btn-main" data-act="random">重新抽一批</div>';
    }
    h += navHTML('today');
    return h;
  }

  function resultRow(id, va, vb, win, isPick, mut) {
    var r = recipe(id);
    if (!r) return '';
    function chip(v, who) {
      var t = v === 'want' ? '想吃' : v === 'ok' ? '都行' : '不吃';
      var cls = v === 'want' ? ' want' : v === 'no' ? ' no' : '';
      return '<span class="vchip' + cls + '">' + who + ' ' + t + '</span>';
    }
    return '<div class="res' + (win ? ' win' : '') + (mut ? ' mut' : '') + '">' +
      '<div class="rb"></div><div class="rbody" data-act="open-recipe" data-id="' + id + '">' +
      '<span class="badge">' + r.emoji + '</span><div>' +
      '<div class="rn">' + esc(r.name) + '</div><div class="rm">' + metaLine(r) + '</div>' +
      '<div class="votes">' + chip(va[id], '你') + chip(vb[id], esc(memberName(partner()))) + '</div>' +
      '</div>' + (isPick ? '<span class="crown">👑</span>' : '') + '</div></div>';
  }

  /* ---------- 渲染：P2 菜库 ---------- */

  function renderLibrary() {
    var q = (S.view && S.view.params && S.view.params.q) || '';
    var all = C.allRecipes(S.recipes, S.state);
    var list = all.filter(function (r) {
      if (!q) return true;
      var hay = r.name + ' ' + (r.tags || []).join(' ');
      for (var i = 0; i < r.ingredients.length; i++) {
        var ing = S.ingIndex.byId[r.ingredients[i].id];
        if (ing) hay += ' ' + ing.name + ' ' + (ing.alias || []).join(' ');
      }
      return hay.toLowerCase().indexOf(q.toLowerCase()) !== -1;
    });
    // 统计被忌口过滤的
    var blocked = all.filter(function (r) { return C.recipeConflicts(r, S.state, S.ingIndex).length > 0; });
    var visible = list.filter(function (r) { return C.recipeConflicts(r, S.state, S.ingIndex).length === 0; });
    var hiddenCount = list.length - visible.length;

    var h = '<div class="bar"><div><div class="ttl">菜库</div>' +
            '<div class="sub2">内置 ' + S.recipes.length + ' 道 · 共 ' + all.length + ' 道</div></div>' +
            '<div class="right"><span class="btn-sm" data-act="new-recipe">+ 加菜</span></div></div>';

    h += '<div class="search" data-act="focus-search"><span class="mag">🔍</span>' +
         '<span class="ph">' + (q ? esc(q) : '搜菜名或食材…') + '</span><span class="st">★</span></div>';
    if (q) h += '<div class="btn-sub" data-act="clear-search">清除搜索「' + esc(q) + '」</div>';

    h += '<div class="psub">符合条件 ' + visible.length + ' 道' +
         (hiddenCount ? ' · 已隐藏 ' + hiddenCount + ' 道忌口冲突' : '') + '</div>';

    var shown = S.view && S.view.params && S.view.params.showBlocked ? list : visible;
    // 有进行中的投票会话时，每道菜多一个「加入投票」——不必先抽签，
    // 直接把自己想吃的菜塞进候选里。
    var sess = S.state.session;
    var voting = !!(sess && !sessionExpired() && sess.status === 'voting' && !sess.mySubmittedAt);
    var cands = voting ? sess.candidates : [];
    for (var i = 0; i < shown.length; i++) {
      var r = shown[i];
      var conf = C.recipeConflicts(r, S.state, S.ingIndex);
      var last = C.lastDoneDate(r.id, S.state);
      var inVote = cands.indexOf(r.id) !== -1;
      // 外层 .rrow-wrap 负责"滑动露出删除按钮"：
      //   .rrow-del 固定贴在右侧（不跟着滑），.rrow 盖在它上面左右移动。
      h += '<div class="rrow-wrap"' + (conf.length ? ' style="opacity:.55"' : '') + '>' +
           '<span class="rrow-del" data-act="swipe-del" data-id="' + r.id + '">删除</span>' +
           '<div class="rrow" data-act="open-recipe" data-id="' + r.id + '">' +
           '<span class="b">' + r.emoji + '</span><div class="tx">' +
           '<div class="n1">' + esc(r.name) + (r.builtin ? '' : ' <span style="font-size:10px;color:#8A8A8A">自定义</span>') + '</div>' +
           '<div class="n2">' + metaLine(r) + (conf.length ? ' · <span style="color:#B33A16">' + esc(confReason(conf)) + '</span>' : '') + '</div>' +
           '<div class="dots5">' + dots5(r.healthy) + '</div></div>' +
           (voting
             ? '<span class="vote-add' + (inVote ? ' on' : '') + '" data-act="toggle-candidate" data-id="' + r.id + '">' +
               (inVote ? '已在投票' : '加入投票') + '</span>'
             : (last ? '<span class="was">' + C.fmtRelativeDate(last) + '做过</span>' : '')) +
           '</div></div>';
    }
    if (!shown.length) {
      h += '<div class="card plain"><div class="cbg"></div><div class="cbody" style="text-align:center;padding:20px">' +
           '<div style="font-size:13px;font-weight:800;color:#111">没有符合条件的菜</div></div></div>';
    }
    if (hiddenCount) {
      // 注意：S.view 这里可能为 null（从底部 Tab 进来时 onClick 会先把它清空），
      // 裸访问 S.view.params 会抛异常、整页渲染中断、停在上一屏不切换。
      var showBlocked = !!(S.view && S.view.params && S.view.params.showBlocked);
      h += '<div class="btn-sub" data-act="toggle-blocked">' +
           (showBlocked ? '隐藏忌口冲突的菜' : '显示被隐藏的 ' + hiddenCount + ' 道') + '</div>';
    }
    h += navHTML('library');
    return h;
  }

  function dots5(n) {
    var s = '';
    for (var i = 0; i < 5; i++) s += '<i class="' + (i < n ? '' : 'off') + '"></i>';
    return s;
  }

  function confReason(conf) {
    var c = conf[0];
    if (c.type === 'allergy') return '含' + c.ingName + ' · ' + c.member + '过敏';
    if (c.type === 'dislike') return '含' + c.ingName + ' · ' + c.member + '不吃';
    if (c.type === 'spicy') return '辣度超出上限';
    return '忌口冲突';
  }

  /* ---------- 渲染：P7 菜品详情 ---------- */

  function renderRecipe() {
    var id = S.view.params.id;
    var r = recipe(id);
    if (!r) { S.view = null; return renderToday(); }
    var conf = C.recipeConflicts(r, S.state, S.ingIndex);
    var miss = C.recipeMissing(r, S.state, S.ingIndex);

    var h = '<div class="bar"><div class="back" data-act="back">←</div><div><div class="ttl">菜品详情</div></div></div>';
    h += '<div class="det-hero"><div class="dots"></div>' +
         '<span class="spark" style="left:16px;top:16px;font-size:14px">✦</span>' +
         '<span class="spark" style="right:18px;bottom:20px;font-size:12px">✧</span>' +
         '<div class="bigin">' + r.emoji + '</div>' +
         '<div class="dn">' + esc(r.name) + '</div>' +
         '<div class="dm">' + metaLine(r) + ' · ' + C.fmtSpicy(r.spicy) + '</div>' +
         '<div class="arc"><i>♥</i><i>♥</i><i>♥</i><i>♥</i><i>♥</i></div></div>';

    if (conf.length) {
      h += '<div class="warn"><span class="wi">⚠️</span><span class="wt">' + esc(confReason(conf)) + '</span></div>';
    }

    // 标签 / 小提示 / 「还没做过」统计行 / 加进清单 / 编辑 都已按用户要求删除。
    // 这一页现在只剩：菜品信息 + 食材清单 + 「今晚就做它」。

    // 食材
    h += '<div class="sec"><span class="t">食材</span><span class="count-tag">' + r.ingredients.length + ' 样</span></div>';
    h += '<div class="card plain"><div class="cbg"></div><div class="cbody" style="padding:12px 14px">';
    for (var i = 0; i < r.ingredients.length; i++) {
      var it = r.ingredients[i];
      var ing = S.ingIndex.byId[it.id];
      if (!ing) continue;
      var isMissing = miss.missing.some(function (x) { return x.id === it.id; });
      var staple = C.isStaple(ing, S.state.stapleRemoved);
      var note = isMissing ? '' : (staple ? '常备' : '家里有');
      h += '<div class="lrow"><span class="cb' + (isMissing ? '' : ' done') + '"></span>' +
           '<span class="bn">' + esc(ing.name) + '</span>' +
           '<span class="ba">' + esc(it.amount) + (note ? ' · ' + note : '') + '</span></div>';
    }
    h += '</div></div>';

    if (tonightActive().length < 3 && !tonightActive().some(function (x) { return x.recipeId === r.id; })) {
      h += '<div class="btn-main" data-act="decide" data-id="' + r.id + '">今 晚 就 做 它</div>';
    } else if (tonightActive().some(function (x) { return x.recipeId === r.id; })) {
      h += '<div class="btn-sub" style="opacity:.6">已在今晚菜单里</div>';
    } else {
      h += '<div class="btn-sub" style="opacity:.6">今晚菜单已满（3 道）</div>';
    }

    h += navHTML('library');
    return h;
  }

  /* ---------- 渲染：P8 菜品编辑 ---------- */

  function renderRecipeForm() {
    var id = S.view.params.id;
    var r = id ? recipe(id) : null;
    var isNew = !r;
    var EMOJIS = ['🍅','🥦','🥒','🍳','🍜','🍚','🥘','🍲','🥗','🍗','🥩','🐟','🦐','🥚','🍆','🥕','🌽','🥔','🍄','🥬','🍤','🍞','🥟','🍛','🍝','🍢','🍣','🍱','🥞','🧇','🥪','🌮','🌯','🥙','🍕','🍔','🍟','🧀','🍠','🎃'];
    var base = r || { name: '', emoji: '🍽', meals: ['dinner'], role: 'main', minutes: 20, cost: 1, difficulty: 1, spicy: 0, healthy: 4, tools: ['wok'], tags: [], ingredients: [], tip: '' };

    // 草稿：编辑不再直接改原对象，先攒在 _draft 里，保存时才写回
    if (!S._draft || S._draftFor !== (id || '__new__')) {
      S._draft = JSON.parse(JSON.stringify(base));
      S._draftFor = id || '__new__';
      S._formParams = S.view.params;
    }
    var cur = S._draft;

    var h = '<div class="bar"><div class="back" data-act="back">←</div><div>' +
            '<div class="ttl">' + (isNew ? '新建菜品' : '编辑菜品') + '</div>' +
            '<div class="sub2">' + (isNew ? '填完就能加进菜库' : (r.builtin ? '内置菜' : '自定义菜')) + '</div></div></div>';

    h += '<div class="card"><div class="cbody"><div class="chead"><span class="nm">基本信息</span></div>';
    h += '<div class="frow"><span class="fl">菜名</span>' +
         '<span class="input" style="margin-left:auto;width:170px" data-form="name">' + esc(cur.name) + '</span></div>';
    h += '<div class="frow" style="align-items:flex-start;flex-direction:column;gap:9px"><span class="fl" style="flex:none">图标</span>' +
         '<div class="emogrid" style="width:100%">' + EMOJIS.slice(0, 16).map(function (e) {
           return '<span class="emo' + (cur.emoji === e ? ' on' : '') + '" data-form-emoji="' + e + '">' + e + '</span>';
         }).join('') + '</div></div>';
    h += '</div></div>';

    h += '</div></div>';

    // 「分类与规格」整张卡片已按用户要求删除（餐次 / 角色 / 器具 / 耗时 / 成本 /
    // 难度 / 辣度 / 健康度）。相关字段仍留在数据里，取菜池等逻辑照旧读它们，
    // 只是不再让用户手改 —— 删掉的只是这个表单入口和它的点击处理。
    // 耗时仍展示在菜品行上（metaLine 读 r.minutes），所以新菜用 base 里的默认值。

    // 食材
    h += '<div class="sec"><span class="t">食材</span><span class="count-tag">' + cur.ingredients.length + ' 样</span></div>';
    h += '<div class="card"><div class="cbody" style="padding:10px 14px">';
    for (var i = 0; i < cur.ingredients.length; i++) {
      var it = cur.ingredients[i];
      var ing = S.ingIndex.byId[it.id];
      h += '<div class="ing"><span class="drag">≡</span>' +
           '<span class="ib">🥄</span>' +
           '<span class="in">' + esc(ing ? ing.name : it.id) + '</span>' +
           '<span class="ia">' + esc(it.amount) + '</span>' +
           '<span class="ix" data-form-del-ing="' + i + '">✕</span></div>';
    }
    h += '<div class="ops" style="margin-top:12px"><span class="pri" data-act="add-ing">+ 添加食材</span></div>';
    h += '</div></div>';

    h += '<div class="note-mini">过敏原由食材自动识别，不可手动改。</div>';

    h += '<div class="card"><div class="cbody"><div class="chead"><span class="nm">小提示</span><span class="mt">可选</span></div>' +
         '<div class="input' + (cur.tip ? '' : ' ph') + '" style="width:100%" data-form="tip">' + (cur.tip ? esc(cur.tip) : '一句话小提示') + '</div>' +
         '</div></div>';

    h += '<div class="btn-main" data-act="save-recipe">' + (isNew ? '创 建 菜 品' : '保 存') + '</div>';
    if (!isNew && r.builtin && r._overridden) {
      h += '<div class="btn-sub" data-act="reset-recipe">恢复默认</div>';
    }
    if (!isNew && !r.builtin) {
      h += '<div class="btn-danger" data-act="delete-recipe" data-id="' + r.id + '">删除这道菜</div>';
    }
    h += '<div class="btn-sub" data-act="back">取消</div>';
    h += navHTML('library');
    return h;
  }

  /* ---------- 渲染：P3 食材 ---------- */

  function renderPantry() {
    var st = S.state;
    var q = (S._pantryQ || '').trim();

    var h = '<div class="bar"><div><div class="ttl">食材</div>' +
            '<div class="sub2">输入食材，看它能做什么菜</div></div></div>';

    // 唯一的交互：一个真实的搜索框。
    // 用户要的是"自己打字输入食材 → 搜索 → 下面出现所有能做的菜"，
    // 所以这一页不再有冰箱存货 / 分类勾选 / 能做这些菜那些区块。
    h += '<label class="search pantry-search">' +
         '<span class="mag">🔍</span>' +
         '<input type="search" data-pantry-input="1" autocomplete="off" ' +
         'autocorrect="off" autocapitalize="off" spellcheck="false" ' +
         'placeholder="输入食材，如「番茄」「鸡蛋」" value="' + esc(q) + '">' +
         (q ? '<span class="st" data-act="clear-pantry-search">✕</span>' : '') +
         '</label>';

    // 没输入时 pantryResultsInner 返回的是引导语，不显示任何菜 —— 
    // 用户明确要求「搜索框下面的都可以去掉」，只有搜索了才出结果。
    h += '<div data-pantry-results="1">' + pantryResultsInner(q) + '</div>';
    h += navHTML('pantry');
    return h;
  }

  /**
   * 搜索结果：这个食材能做的菜。
   * 单独抽出来是为了让输入时只重画结果区、输入框节点原地不动
   * （和食材弹层同一套办法，见 paintIngPicker 的注释）。
   */
  function pantryResultsInner(q) {
    if (!q) {
      return '<div class="note-mini" style="text-align:center;padding:26px 0;line-height:1.9">' +
             '在上面输入一种食材<br>就能看到所有用得上它的菜</div>';
    }
    var hits = searchIngredients(q, {});
    // 命中多个时按"名字正好等于输入"优先
    var exact = hits.filter(function (g) {
      return g.name === q || (g.alias || []).indexOf(q) !== -1;
    })[0];
    var h = '';

    if (!hits.length) {
      h += '<div class="card plain"><div class="cbg"></div>' +
           '<div class="cbody" style="text-align:center;padding:20px">' +
           '<div style="font-size:13px;font-weight:800;color:#111">没找到「' + esc(q) + '」</div>' +
           '<div style="font-size:11.5px;font-weight:700;color:#8A8A8A;margin-top:6px">换个说法试试，比如「西红柿」或「土豆」</div>' +
           '</div></div>';
      return h;
    }

    var target = exact || hits[0];
    h += dishesForIngredientHTML(target);
    if (!exact && hits.length > 1) {
      h += '<div class="sec"><span class="t">相近的食材</span></div>';
      h += '<div class="chips">' + hits.slice(0, 10).map(function (g) {
        return '<span class="chip" data-act="pantry-pick" data-id="' + g.id + '">' + esc(g.name) + '</span>';
      }).join('') + '</div>';
    }
    return h;
  }

  function dishesForIngredientHTML(g) {
    var dishes = dishesUsingIngredient(g.id);
    var cookable = dishes.filter(function (d) { return d.canCook; });
    var h = '<div class="ing-dishes">';
    h += '<div class="idh">' +
         '<span class="t">' + esc(g.name) + ' 能做的菜</span>' +
         '<span class="c">' + dishes.length + ' 道</span>' +
         (cookable.length ? '<span class="u">家里能做 ' + cookable.length + ' 道</span>' : '') +
         '</div>';
    if (!dishes.length) {
      h += '<div class="note-mini" style="text-align:center;padding:10px 0">' +
           '菜库里还没有用「' + esc(g.name) + '」的菜</div>';
    } else {
      dishes.forEach(function (d) {
        var r = d.recipe;
        h += '<div class="dish-mini" data-act="open-recipe" data-id="' + r.id + '">' +
             '<span class="b">' + r.emoji + '</span>' +
             '<div><div class="n">' + esc(r.name) +
             (d.canCook ? ' <span class="need" style="color:#1F6B41;background:#E4F4E9">家里能做</span>' : '') +
             '</div>' +
             '<div class="m">' + C.fmtMinutes(r.minutes) + ' · ' + C.fmtCost(r.cost) +
             (d.missing.length ? ' · 还缺 ' + d.missing.length + ' 样' : '') +
             '</div></div>' +
             '<span class="go">›</span></div>';
      });
    }
    h += '</div>';
    return h;
  }

  /**
   * 只重画结果区，输入框不动。
   * 和 paintIngPicker 同一个理由：整块 innerHTML 重建会换掉输入框节点、
   * 焦点和输入法组合一起丢，表现就是"打不了字"。
   */
  function paintPantry() {
    var scr = document.querySelector('.phone .scr');
    if (!scr) return false;
    // S.tab 在弹层打开时仍是 'pantry'，所以这一条判断的就是"底下那页是不是食材页"
    if (S.tab !== 'pantry') return false;
    var q = (S._pantryQ || '').trim();

    // 输入框：正在打字时以 DOM 为准，不写回（免得打断输入法）
    var input = scr.querySelector('[data-pantry-input]');
    if (input) {
      if (document.activeElement === input) {
        if (!pantryComposing) S._pantryQ = input.value;
      } else if (!pantryComposing && input.value !== (S._pantryQ || '')) {
        input.value = S._pantryQ || '';
      }
    }

    // 清除按钮的出现/消失：只有这一小块要跟着 q 变
    var box = scr.querySelector('.pantry-search');
    if (box) {
      var hasClear = !!box.querySelector('[data-act="clear-pantry-search"]');
      if (q && !hasClear) {
        box.insertAdjacentHTML('beforeend', '<span class="st" data-act="clear-pantry-search">✕</span>');
      } else if (!q && hasClear) {
        box.removeChild(box.querySelector('[data-act="clear-pantry-search"]'));
      }
    }

    // 结果区整块替换（没有输入框在里面，安全）
    var res = scr.querySelector('[data-pantry-results]');
    if (res) {
      var html = q ? pantryResultsInner(q) : '<div class="note-mini" style="text-align:center;padding:26px 0;line-height:1.9">在上面输入一种食材<br>就能看到所有用得上它的菜</div>';
      if (res.innerHTML !== html) res.innerHTML = html;
    }
    return true;
  }

  /* ---------- 渲染：P9 采购清单 ---------- */

  function renderShopping() {
    var menu = tonightActive();
    var shop = C.buildShoppingList(menu, S.state, S.ingIndex, S.recipeById);
    var checked = S.state.checklistChecked || [];

    var h = '<div class="bar"><div class="back" data-act="back">←</div><div><div class="ttl">采购清单</div></div></div>';

    h += '<div class="pl-tag"><div class="hole"></div>' +
         '<div class="t1">' + (menu.length ? '今晚要做 ' + menu.length + ' 道菜' : '还没有定今晚的菜') + '</div>' +
         '<div class="t2">' + esc(menu.map(function (x) { var r = recipe(x.recipeId); return r ? r.name : ''; }).filter(Boolean).join(' · ')) + '</div>' +
         '<div class="barcode"></div></div>';

    if (!menu.length) {
      h += '<div class="btn-main" data-act="random">去 选 菜</div>';
      h += navHTML('today');
      return h;
    }

    h += '<div class="psub">共 ' + shop.total + ' 样 · 已买 ' + shop.toBuy.filter(function (x) { return checked.indexOf(x.id) !== -1; }).length + ' 样</div>';

    var catOrder = ['vegetable','protein','seafood','soy','staple','dry','fruit','condiment','other'];
    catOrder.forEach(function (cat) {
      var items = shop.toBuyByCat[cat];
      if (!items || !items.length) return;
      h += '<div class="sec"><span class="t">' + C.CATEGORY_LABEL[cat] + '</span>' +
           '<span class="count-tag">' + items.length + ' 样</span></div>';
      h += '<div class="card plain"><div class="cbg"></div><div class="cbody" style="padding:12px 14px">';
      items.forEach(function (it) {
        var isDone = checked.indexOf(it.id) !== -1;
        h += '<div class="lrow" data-check="' + it.id + '">' +
             '<span class="cb' + (isDone ? ' done' : '') + '"></span>' +
             '<span class="bn' + (isDone ? ' gone' : '') + '">' + esc(it.name) + '</span>' +
             '<span class="ba">' + esc(it.amounts.join(' + ')) + '</span></div>';
      });
      h += '</div></div>';
    });

    if (shop.have.length) {
      h += '<div class="sec"><span class="t">家里已有</span><span class="count-tag">' + shop.have.length + ' 样</span></div>';
      h += '<div class="card plain"><div class="cbg"></div><div class="cbody" style="padding:12px 14px">';
      shop.have.forEach(function (it) {
        h += '<div class="lrow"><span class="cb" style="border-color:#BFBFBF"></span>' +
             '<span class="bn" style="color:#8A8A8A">' + esc(it.name) + '</span>' +
             '<span class="ba">' + (it.staple ? '常备' : esc(it.amount || '')) + '</span></div>';
      });
      h += '</div></div>';
    }

    if (!shop.total) {
      h += '<div class="ready" style="padding:14px;font-size:13px"><span>✓</span><span>食材都齐了，直接开做</span></div>';
    }

    h += '<div class="ops" style="gap:10px;margin-top:6px">' +
         '<span class="pri" style="flex:1;text-align:center;padding:11px 0" data-act="copy-list">复制清单</span>' +
         '<span style="flex:1;text-align:center;padding:11px 0" data-act="bought-to-pantry">已买加入家里</span>' +
         '</div>';
    h += navHTML('today');
    return h;
  }

  /* ---------- 渲染：P4 我的 ---------- */

  function renderMe() {
    var st = S.state;
    var sync = st.settings && st.settings.sync;
    var h = '<div class="bar"><div><div class="ttl">我的</div></div></div>';

    h += '<div class="sec"><span class="t">我们</span></div>';
    h += '<div style="display:flex;gap:12px">';
    ['a','b'].forEach(function (k) {
      var m = st.members[k];
      var isMe = st.me === k;
      h += '<div class="mcard' + (isMe ? ' me' : '') + '" data-act="edit-member" data-id="' + k + '">' +
           (isMe ? '<span class="flag">这台手机</span>' : '') +
           '<div class="av">' + (m.emoji || '🙂') + '</div>' +
           '<div class="mn">' + esc(m.name) + '</div>' +
           '<div class="md">' + memberDietSummary(m) + '</div></div>';
    });
    h += '</div>';

    // 「选菜偏好」整块（含"默认条件"入口）已按用户要求删除。
    // 选菜条件不再让用户调整，所以这里没有可设置的东西了。
    // 「常备调料」入口此前也已删除。数据层的 staple 逻辑仍保留：
    // 它决定"家里有"的判定，删掉的只是设置入口。

    h += '<div class="sec" style="margin-top:2px"><span class="t">同步</span></div>';
    if (sync) {
      h += '<div class="srow"><span class="dot-live"></span><div>' +
           '<div class="sn">已连接</div><div class="sd">' + esc(sync.owner) + ' / ' + esc(sync.repo) + '</div></div><span class="sa">›</span></div>';
    } else {
      h += '<div class="srow" data-act="sync-setup"><span class="si" style="background:#E4E4E4">○</span><div>' +
           '<div class="sn">未连接</div><div class="sd">点此配置双人同步（只填一个 token）</div></div><span class="sa">›</span></div>';
    }

    h += '<div class="sec" style="margin-top:2px"><span class="t">数据</span></div>';
    h += '<div class="srow" data-act="export"><span class="si">📤</span><div>' +
         '<div class="sn">导出备份</div><div class="sd">生成 JSON 存到手机</div></div><span class="sa">›</span></div>';
    h += '<div class="srow" data-act="import"><span class="si">📥</span><div>' +
         '<div class="sn">导入备份</div><div class="sd">从 JSON 恢复</div></div><span class="sa">›</span></div>';
    h += '<div class="srow" data-act="clear"><span class="si" style="background:#E4E4E4">🗑</span><div>' +
         '<div class="sn" style="color:#B33A16">清空所有数据</div><div class="sd">需二次确认</div></div><span class="sa">›</span></div>';

    h += '<div class="tipbox">数据只存在本机浏览器，不经过任何第三方服务器。换手机前请先导出备份。</div>';
    h += '<div class="note-mini" style="text-align:center;margin-top:4px">待会吃什么 · v1.0</div>';
    h += navHTML('me');
    return h;
  }

  function memberDietSummary(m) {
    var parts = [];
    if ((m.allergies || []).length) parts.push('过敏 ' + m.allergies.length + ' 项');
    if ((m.dislikes || []).length) parts.push('忌口 ' + m.dislikes.length + ' 项');
    if (!parts.length) parts.push('无特殊忌口');
    return parts.join(' · ');
  }

  /* ---------- 同步：配置读写 ---------- */
  var Sync = window.ChishenmeSync;

  function getToken() {
    try { return localStorage.getItem(LS_TOKEN) || ''; } catch (e) { return ''; }
  }
  function setToken(t) {
    try { if (t) localStorage.setItem(LS_TOKEN, t); else localStorage.removeItem(LS_TOKEN); } catch (e) {}
  }
  function syncCfg() {
    var s = S.state.settings && S.state.settings.sync;
    var tok = getToken();
    if (!s || !s.enabled || !tok) return null;
    return { token: tok, owner: s.owner, repo: s.repo, branch: s.branch || 'main' };
  }
  function syncOn() { return !!syncCfg(); }

  function saveSyncCfg(cfg) {
    if (!S.state.settings) S.state.settings = {};
    S.state.settings.sync = cfg;
    save();
  }

  // 同步状态提示（顶部细条）
  var syncStatus = null;   // { level: 'ok'|'warn'|'err', text, at }
  function setSyncStatus(level, text) {
    syncStatus = { level: level, text: text, at: Date.now() };
    render();
    setTimeout(function () {
      if (syncStatus && Date.now() - syncStatus.at >= 4000) { syncStatus = null; render(); }
    }, 4200);
  }

  /* ---------- 同步：拉取 / 推送 ---------- */

  var syncBusy = false;

  function doPull(opts) {
    opts = opts || {};
    var cfg = syncCfg();
    if (!cfg || syncBusy) return Promise.resolve(false);
    syncBusy = true;
    return Sync.pull(cfg, S.state, today()).then(function (r) {
      syncBusy = false;
      if (!r.ok) {
        if (!opts.silent) setSyncStatus('err', r.error || '同步失败，数据已存本机');
        return false;
      }
      if (r.touched) {
        // 用合并结果替换本地（但保留本机的 me / settings）
        var me = S.state.me, st = S.state.settings;
        S.state = r.merged;
        S.state.me = me;
        S.state.settings = st;
        S._remoteShas = r.shas;
        save();
        render();
      } else {
        S._remoteShas = r.shas;
      }
      if (!S.state.settings.sync) S.state.settings.sync = {};
      S.state.settings.sync.lastSyncedAt = new Date().toISOString();
      save();
      if (!opts.silent && r.touched) setSyncStatus('ok', '已同步');
      return true;
    }).catch(function (e) {
      syncBusy = false;
      if (!opts.silent) setSyncStatus('err', '同步失败，数据已存本机');
      return false;
    });
  }

  function doPush(opts) {
    opts = opts || {};
    var cfg = syncCfg();
    if (!cfg || syncBusy) return Promise.resolve(false);
    syncBusy = true;
    return Sync.push(cfg, S.state, S._remoteShas, today()).then(function (r) {
      syncBusy = false;
      if (r.ok) {
        S._remoteShas = Object.assign({}, S._remoteShas, r.shas);
        if (!S.state.settings.sync) S.state.settings.sync = {};
        S.state.settings.sync.lastSyncedAt = new Date().toISOString();
        save();
      } else {
        if (!opts.silent) setSyncStatus('err', (r.errors && r.errors[0]) || '同步失败，数据已存本机');
      }
      return r.ok;
    }).catch(function () {
      syncBusy = false;
      return false;
    });
  }

  // 写操作后推一把（静默）
  function pushSoon() {
    if (!syncOn()) return;
    clearTimeout(S._pushTimer);
    S._pushTimer = setTimeout(function () { doPush({ silent: true }); }, 1200);
  }

  /* ---------- 渲染：P11 配对与同步 ---------- */

  function renderSync() {
    var st = S.state.settings && S.state.settings.sync;
    var connected = !!(st && st.enabled);
    var tok = getToken();
    var showAdv = S.view.params && S.view.params.adv;
    var h = '';

    h += '<div class="bar"><div class="back" data-act="back">←</div><div>' +
         '<div class="ttl">配对与同步</div>' +
         '<div class="sub2">' + (connected ? '两台手机共用一个私有仓库' : '只填一个 token 就行') + '</div></div></div>';

    if (connected) {
      h += '<div class="card plain"><div class="cbg"></div><div class="cbody">' +
           '<div style="display:flex;align-items:center;gap:9px">' +
           '<span class="dot-live"></span>' +
           '<div><div style="font-size:13.5px;font-weight:900;color:#111">已连接</div>' +
           '<div style="font-size:11px;font-weight:700;color:#8A8A8A;margin-top:3px">' +
           esc(st.owner) + ' / ' + esc(st.repo) + '</div></div>' +
           '<div style="margin-left:auto;font-size:10.5px;font-weight:700;color:#8A8A8A">' +
           (st.lastSyncedAt ? C.fmtRelativeDate(st.lastSyncedAt.slice(0,10)) + '同步' : '') + '</div>' +
           '</div></div></div>';
      h += '<div class="btn-main" data-act="sync-now">立 即 同 步</div>';
    }

    // token 输入（未连接时的主输入）
    h += '<div class="card"><div class="cbody"><div class="chead"><span class="nm">' +
         (connected ? 'Token' : '粘贴 Access Token') + '</span>' +
         (connected ? '<span class="mt">已保存</span>' : '') + '</div>';
    h += '<div class="input' + (tok ? '' : ' ph') + '" style="width:100%;font-size:11.5px;word-break:break-all" ' +
         'data-act="input-token">' + (tok ? esc(maskToken(tok)) : 'ghp_… 或 github_pat_…') + '</div>';
    if (!connected) {
      h += '<div class="note-mini" style="margin-top:9px">只做一件事：把 token 粘进来，用户名和仓库名自动识别。</div>';
    }
    h += '</div></div>';

    // 测试连接进度
    if (S._syncSteps && S._syncSteps.length) {
      h += '<div class="card plain"><div class="cbg"></div><div class="cbody" style="padding:12px 14px">';
      S._syncSteps.forEach(function (s) {
        var icon = s.state === 'ok' ? '✓' : s.state === 'fail' ? '✕' : s.state === 'warn' ? '!' : '…';
        var color = s.state === 'ok' ? '#2F9E63' : s.state === 'fail' ? '#B33A16' : s.state === 'warn' ? '#B37A16' : '#8A8A8A';
        h += '<div class="lrow" style="padding:6px 0">' +
             '<span style="font-weight:900;color:' + color + ';width:14px">' + icon + '</span>' +
             '<span class="bn" style="font-size:12px">' + esc(s.label) + '</span>' +
             '<span class="ba">' + esc(s.extra || '') + '</span></div>';
      });
      h += '</div></div>';
    }

    if (!connected) {
      h += '<div class="btn-main" data-act="sync-connect">保 存 并 测 试 连 接</div>';
      h += '<div class="btn-sub" data-act="toggle-adv">' + (showAdv ? '收起高级设置' : '高级设置（一般不用动）') + '</div>';
    } else {
      h += '<div class="btn-sub" data-act="toggle-adv">' + (showAdv ? '收起高级设置' : '高级设置') + '</div>';
    }

    if (showAdv) {
      var owner = (st && st.owner) || '';
      var repo = (st && st.repo) || 'chishenme-data';
      h += '<div class="card"><div class="cbody"><div class="chead"><span class="nm">高级设置</span></div>';
      h += '<div class="frow"><span class="fl">用户名</span>' +
           '<span class="input sm" style="margin-left:auto;width:170px" data-act="input-owner">' +
           (owner ? esc(owner) : '自动识别') + '</span></div>';
      h += '<div class="frow"><span class="fl">数据仓库</span>' +
           '<span class="input sm" style="margin-left:auto;width:170px" data-act="input-repo">' + esc(repo) + '</span></div>';
      h += '<div class="frow"><span class="fl">分支</span>' +
           '<span class="input sm" style="margin-left:auto;width:170px" data-act="input-branch">' +
           esc((st && st.branch) || 'main') + '</span></div>';
      h += '</div></div>';
    }

    // 这台手机是谁
    h += '<div class="card"><div class="cbody"><div class="chead"><span class="nm">这台手机是谁</span></div>';
    h += '<div style="display:flex;gap:10px">';
    ['a','b'].forEach(function (k) {
      var m = S.state.members[k];
      var on = S.state.me === k;
      h += '<div class="mcard' + (on ? ' me' : '') + '" data-act="set-me" data-id="' + k + '" style="padding:11px 8px">' +
           '<div class="av" style="font-size:22px;margin-bottom:6px">' + (m.emoji || '🙂') + '</div>' +
           '<div class="mn" style="font-size:12.5px">' + esc(m.name) + '</div></div>';
    });
    h += '</div></div></div>';

    if (!connected) {
      h += '<div class="tipbox"><b>Token 怎么来？</b><br>' +
           '1. 打开 GitHub 的 fine-grained token 创建页<br>' +
           '2. 只授权 <b>chishenme-data</b> 这一个仓库<br>' +
           '3. 权限选 <b>Contents: Read and write</b><br>' +
           '4. 生成后复制，粘贴到上面</div>';
      h += '<div class="note-mini">不配置也能用，只是没有双人投票和同步。<br>' +
           'Token 只存在这台手机上，不会同步、不会写进导出的备份文件。</div>';
    } else {
      h += '<div class="btn-danger" data-act="sync-disconnect">断开同步（保留本机数据）</div>';
    }

    h += navHTML('me');
    return h;
  }

  function maskToken(t) {
    if (!t) return '';
    if (t.length <= 12) return t.slice(0, 4) + '…';
    return t.slice(0, 8) + '…' + t.slice(-4);
  }

  // 通用内联输入弹层：prompt 在 WebView/内置浏览器里会被静默拦截（返回 null 且不显示），
  // 所以这里不再返回值，改为打开弹层，用户点「确定」后走 opts.onOk(裁剪后的值)
  function promptInput(label, cur, opts) {
    opts = opts || {};
    S._askInput = {
      label: label || '',
      value: cur || '',
      ph: opts.placeholder || '',
      onOk: opts.onOk || null,
      back: S.view ? { name: S.view.name, params: S.view.params } : null
    };
    // 每次都是新的一次询问：换签名，逼 render() 重建弹层（否则会沿用上一个输入框里的旧值）
    S._askSeq = (S._askSeq || 0) + 1;
    S.view = { name: 'askInput', params: {} };
    render();
  }

  // 内联输入弹层（替代 prompt 的所有用法）
  function renderAskInput() {
    var ask = S._askInput || { label: '', value: '', ph: '' };
    var lines = String(ask.label || '').split('\n');
    var sub = '';
    for (var i = 1; i < lines.length; i++) { if (sub) sub += '<br>'; sub += esc(lines[i]); }
    var h = '';
    h += '<div class="sheet-top"><div class="grip"></div>' +
         '<div class="st">' + esc(lines[0] || '') + '</div>' +
         (sub ? '<div class="st-sub">' + sub + '</div>' : '') + '</div>';
    // 真·输入框（prompt 会被浏览器拦，这里必须用内联 input，写法同食材选择器）
    h += '<label class="search">' +
         '<span class="mag">🔑</span>' +
         '<input type="text" data-ask-input="1" autocomplete="off" autocorrect="off" ' +
         'autocapitalize="off" spellcheck="false" placeholder="' + esc(ask.ph || '') + '" ' +
         'style="user-select:text;-webkit-user-select:text" value="' + esc(ask.value) + '">' +
         '</label>';
    h += '<div class="btn-main" data-act="ask-input-ok">确 定</div>';
    h += '<div class="btn-sub" data-act="ask-input-cancel">取消</div>';
    return sheet(h);
  }

  // 断开同步的二次确认弹层（替代 confirm；破坏性操作必须二次确认，只是换成内联弹层）
  function renderSyncConfirm() {
    var h = '';
    h += '<div class="sheet-top"><div class="grip"></div><div class="st">断开同步</div></div>';
    h += '<div class="note-mini" style="text-align:center;font-size:12px;color:#111;line-height:1.9">' +
         '断开后这台手机不再同步，本机数据会保留。<br><br>确定？</div>';
    h += '<div class="btn-danger" data-act="sync-disconnect-ok">断 开</div>';
    h += '<div class="btn-sub" data-act="sync-disconnect-no">取消</div>';
    return sheet(h);
  }

  /* ---------- 同步：动作实现 ---------- */

  function doInputToken() {
    promptInput('粘贴 GitHub Access Token\n（fine-grained，只授权 chishenme-data，Contents: Read and write）',
                getToken(), { placeholder: 'ghp_… 或 github_pat_…', onOk: function (v) {
      setToken(v);
      render();
      if (v) toast('Token 已保存，点「保存并测试连接」验证');
    } });
  }

  function doSyncConnect() {
    var tok = getToken();
    if (!tok) { toast('请先粘贴 token'); return; }
    S._syncSteps = [];
    render();
    var prefer = (S.state.settings.sync && S.state.settings.sync.repo) || 'chishenme-data';

    Sync.testConnection(tok, prefer, function (i, label, state, extra) {
      S._syncSteps = S._syncSteps || [];
      S._syncSteps[i] = { label: label, state: state, extra: extra };
      render();
    }).then(function (r) {
      if (!r.ok) {
        // 识别失败但可能是仓库名不对 → 展开高级设置让用户手填
        S.view = { name: 'sync', params: { adv: true } };
        render();
        toast(r.error || '连接失败');
        return;
      }
      var cfg = r.cfg;
      saveSyncCfg({
        enabled: true, owner: cfg.owner, repo: cfg.repo, branch: cfg.branch || 'main',
        lastSyncedAt: new Date().toISOString()
      });
      S._syncSteps = null;
      S.view = { name: 'sync', params: {} };
      render();
      toast('连接成功：' + cfg.owner + ' / ' + cfg.repo);
      // 首次连接：先拉一次远端
      doPull({ silent: true }).then(function () { doPush({ silent: true }); });
    }).catch(function (e) {
      S._syncSteps = null;
      render();
      toast('连接失败：' + (e && e.message ? e.message : e));
    });
  }

  function doSyncDisconnect() {
    // 内联二次确认替代 confirm（confirm 在 WebView 里被拦，返回 null 且不显示）
    S._syncConfirmBack = S.view ? { name: S.view.name, params: S.view.params } : null;
    S.view = { name: 'syncConfirm', params: {} };
    render();
  }

  // 用户在确认弹层里点了「断 开」才真正执行
  function doSyncDisconnectConfirm() {
    setToken('');
    if (S.state.settings) S.state.settings.sync = null;
    S._remoteShas = null;
    save();
    S.view = { name: 'sync', params: {} };
    render();
    toast('已断开，数据仍在本机');
  }

  // 投票提交：写入自己的投票文件（各写各的，物理上不冲突）
  function pushMyVote() {
    var cfg = syncCfg();
    var sess = S.state.session;
    if (!cfg || !sess) return Promise.resolve(false);
    return Sync.writeVote(cfg, sess.id, me(), {
      sessionId: sess.id, uid: me(),
      votes: sess.myVote || {},
      submittedAt: new Date().toISOString()
    }).then(function (r) {
      if (!r.ok) setSyncStatus('err', '投票上传失败，稍后自动重试');
      return r.ok;
    });
  }

  // 拉取对方投票，够了就揭晓
  function checkPartnerVote(opts) {
    opts = opts || {};
    var cfg = syncCfg();
    var sess = S.state.session;
    if (!cfg || !sess) return Promise.resolve(false);
    var other = partner();
    return Sync.readVote(cfg, sess.id, other).then(function (r) {
      if (!r.ok || r.missing || !r.data) return false;
      sess.partnerVote = r.data.votes || {};
      sess.status = 'revealed';
      save();
      if (S.view && S.view.name === 'vote') { S.view = { name: 'reveal' }; }
      render();
      toast('对方投完了，看看结果');
      return true;
    });
  }

  /* ---------- 同步：轮询（P6 等待对方时） ---------- */

  var pollTimer = null, pollStart = 0;
  var POLL_MS = 15000, POLL_MAX_MS = 10 * 60 * 1000;

  function startPolling() {
    stopPolling();
    if (!syncOn()) return;
    pollStart = Date.now();
    pollTimer = setInterval(function () {
      // 页面不可见 / 超时 / 已不在等待状态 → 停
      if (document.hidden || Date.now() - pollStart > POLL_MAX_MS) { stopPolling(); return; }
      var sess = S.state.session;
      if (!sess || !sess.mySubmittedAt || sess.partnerVote) { stopPolling(); return; }
      checkPartnerVote({ silent: true });
    }, POLL_MS);
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  // 页面重新可见时拉一次（PRD §8.5）
  function onVisible() {
    if (document.hidden) { stopPolling(); return; }
    if (!syncOn()) return;
    var last = (S.state.settings.sync || {}).lastSyncedAt;
    if (!last || Date.now() - new Date(last).getTime() > 30000) doPull({ silent: true });
    var sess = S.state.session;
    if (sess && sess.mySubmittedAt && !sess.partnerVote) {
      checkPartnerVote({ silent: true });
      startPolling();
    }
  }

  /* ---------- 食材选择器（可搜索，P3 / P8 共用） ---------- */

  // 常买的食材排前面，避免默认列表全被蔬菜占满
  var COMMON_FIRST = [
    'egg', 'tomato', 'pork', 'pork-mince', 'chicken-breast', 'chicken-wing', 'chicken-leg',
    'tofu', 'potato', 'wawacai', 'corn', 'scallion', 'garlic', 'ginger', 'rice', 'cooked-rice',
    'noodle', 'flour', 'shrimp', 'shrimp-meat', 'beef', 'sea-bass', 'sole-fish',
    'broccoli', 'cabbage', 'carrot', 'white-radish', 'shiitake', 'cucumber', 'eggplant', 'lettuce'
  ];

  // 食材搜索：名字、别名都匹配
  function searchIngredients(q, opts) {
    opts = opts || {};
    var kw = String(q || '').trim().toLowerCase();
    var list = S.ingredients.filter(function (g) {
      if (opts.excludeStaple && g.staple) return false;
      if (opts.onlyStaple && !g.staple) return false;
      if (!kw) return true;
      var hay = g.name + ' ' + (g.alias || []).join(' ');
      return hay.toLowerCase().indexOf(kw) !== -1;
    });
    if (kw) {
      // 搜索时按匹配质量排序：名字开头命中的排前，短的排前
      list.sort(function (a, b) {
        var an = a.name.toLowerCase(), bn = b.name.toLowerCase();
        var as = an.indexOf(kw) === 0 ? 0 : an.indexOf(kw) > -1 ? 1 : 2;
        var bs = bn.indexOf(kw) === 0 ? 0 : bn.indexOf(kw) > -1 ? 1 : 2;
        if (as !== bs) return as - bs;
        return a.name.length - b.name.length;
      });
    } else {
      // 无搜索词：常买的排前面
      var rank = {};
      COMMON_FIRST.forEach(function (id, i) { rank[id] = i; });
      list.sort(function (a, b) {
        var ar = rank[a.id] === undefined ? 999 : rank[a.id];
        var br = rank[b.id] === undefined ? 999 : rank[b.id];
        return ar - br;
      });
    }
    return list;
  }

  /**
   * 某个食材能做的菜（本地计算，不需要联网）。
   * 返回按「能做的程度」排序：家里能做的排前，其次缺得少的。
   */
  function dishesUsingIngredient(ingId, opts) {
    opts = opts || {};
    var all = C.allRecipes(S.recipes, S.state);
    var out = [];
    all.forEach(function (r) {
      var uses = r.ingredients.some(function (x) { return x.id === ingId; });
      if (!uses) return;
      if (C.recipeConflicts(r, S.state, S.ingIndex).length) return;   // 忌口的不推荐
      var miss = C.recipeMissing(r, S.state, S.ingIndex);
      out.push({
        recipe: r,
        missing: miss.missing,
        canCook: miss.canCook,
        // 除了这个食材之外还缺几样
        missOthers: miss.missing.filter(function (x) { return x.id !== ingId; }).length
      });
    });
    out.sort(function (a, b) {
      if (a.canCook !== b.canCook) return a.canCook ? -1 : 1;
      if (a.missOthers !== b.missOthers) return a.missOthers - b.missOthers;
      return (a.recipe.minutes || 99) - (b.recipe.minutes || 99);
    });
    return out;
  }

  /**
   * 渲染食材选择弹层
   * params: { q, cat, sel: [ids], mode, title, field }
   *
   * 弹层内部拆成若干 data-pk 区块：初次整块渲染，之后打字/点选只更新区块
   * （见 refreshIngPicker）。输入框节点必须一直活着 —— 重建它就会丢焦点、
   * 断开中文输入法的候选，界面看起来就是"一直在跳"。
   */
  function renderIngredientPicker(p) {
    p = p || {};
    var h = '';
    h += '<div class="sheet-top" data-pk="top">' + pkTopInner(p) + '</div>';

    // 真·输入框（prompt 会被浏览器拦，这里必须用内联 input）
    h += '<label class="search">' +
         '<span class="mag">🔍</span>' +
         '<input type="search" data-ing-input="1" autocomplete="off" ' +
         'autocorrect="off" autocapitalize="off" spellcheck="false" ' +
         'placeholder="搜食材名，如「番茄」「鸡蛋」" value="' + esc(p.q || '') + '">' +
         '<span data-pk="mag">' + pkMagInner(p.q || '') + '</span>' +
         '</label>';

    h += '<div data-pk="chips">' + pkChipsInner(p) + '</div>';
    // 分类筛选单独加一个标题：这一排「蔬菜 / 肉蛋 / 水产…」和上面已选的食材 chip
    // 外观接近，用户分不清哪个是分类、哪个是自己选的东西。加标题 + 换配色区分。
    h += '<div class="filter-block">' +
         '<div class="fb-lb">按分类看</div>' +
         '<div class="filters" data-pk="filters">' + pkFiltersInner(p) + '</div>' +
         '</div>';
    h += '<div data-pk="body">' + pkBodyInner(p) + '</div>';
    h += '<div data-pk="foot">' + pkFootInner(p) + '</div>';
    return sheet(h);
  }

  function pkTopInner(p) {
    var sel = p.sel || [];
    return '<div class="grip"></div>' +
           '<div class="st">' + esc(p.title || '添加食材') + '</div>' +
           '<div class="st-sub">' + (sel.length ? '已选 ' + sel.length + ' 样' : '搜索或直接点选') + '</div>';
  }

  function pkMagInner(q) {
    return q ? '<span class="st" data-act="clear-ing-search">✕</span>'
             : '<span class="st">★</span>';
  }

  // 已选 chips（可点删）
  function pkChipsInner(p) {
    var sel = p.sel || [];
    if (!sel.length) return '';
    var h = '<div class="chips" style="margin-top:-2px">';
    sel.forEach(function (id) {
      var g = S.ingIndex.byId[id];
      if (!g) return;
      h += '<span class="chip on" data-ing-toggle="' + id + '">' + esc(g.name) + ' ✕</span>';
    });
    return h + '</div>';
  }

  var PK_CATS = [['all','全部'],['vegetable','蔬菜'],['protein','肉蛋'],['seafood','水产'],
                 ['soy','豆制品'],['staple','主食'],['dry','干货'],['fruit','水果'],['condiment','调料']];

  function pkFiltersInner(p) {
    var cat = p.cat || 'all';
    return PK_CATS.map(function (c) {
      return '<span class="fchip' + (cat === c[0] ? ' on' : '') +
             '" data-ing-cat="' + c[0] + '">' + c[1] + '</span>';
    }).join('');
  }

  // 结果区：命中食材就展开「能做这些菜」，否则给食材列表
  function pkBodyInner(p) {
    p = p || {};
    var q = p.q || '';
    var cat = p.cat || 'all';
    var sel = p.sel || [];
    var mode = p.mode || 'pantry';

    var list = searchIngredients(q, { excludeStaple: true });
    if (cat !== 'all') {
      list = list.filter(function (g) { return g.category === cat; });
    }
    // 没搜索词时：已选的排前面
    if (!q) {
      list = list.slice().sort(function (a, b) {
        var ao = sel.indexOf(a.id) !== -1 ? 0 : 1;
        var bo = sel.indexOf(b.id) !== -1 ? 0 : 1;
        if (ao !== bo) return ao - bo;
        return 0;
      });
    }

    var h = '';

    // ---- 搜索结果：先给「能做这些菜」，再给食材列表 ----
    if (q) {
      // 命中唯一食材时，直接展开它能做的菜
      var exact = list.filter(function (g) {
        return g.name === q || (g.alias || []).indexOf(q) !== -1;
      })[0];

      if (exact) {
        var dishes = dishesUsingIngredient(exact.id);
        var cookable = dishes.filter(function (d) { return d.canCook; });
        h += '<div class="ing-dishes">';
        h += '<div class="idh">' +
             '<span class="t">' + esc(exact.name) + ' 能做的菜</span>' +
             '<span class="c">' + dishes.length + ' 道</span>' +
             '<span class="u">' + (cookable.length ? '现在能做 ' + cookable.length + ' 道' : '') + '</span>' +
             '</div>';
        if (!dishes.length) {
          h += '<div class="note-mini" style="text-align:center;padding:10px 0">' +
               '菜库里还没有用「' + esc(exact.name) + '」的菜</div>';
        } else {
          dishes.slice(0, 12).forEach(function (d) {
            var r = d.recipe;
            h += '<div class="dish-mini" data-ing-dish="' + r.id + '">' +
                 '<span class="b">' + r.emoji + '</span>' +
                 '<div><div class="n">' + esc(r.name) +
                 (d.canCook ? ' <span class="need" style="color:#1F6B41;background:#E4F4E9">家里能做</span>' : '') +
                 '</div>' +
                 '<div class="m">' + C.fmtMinutes(r.minutes) + ' · ' + C.fmtCost(r.cost) +
                 (d.missing.length ? ' · 还缺 ' + d.missing.length + ' 样' : '') +
                 '</div></div>' +
                 '<span class="go">›</span></div>';
          });
          if (dishes.length > 12) {
            h += '<div class="note-mini" style="text-align:center">还有 ' + (dishes.length - 12) + ' 道</div>';
          }
        }
        h += '</div>';
        var addLabel = mode === 'pantry'
          ? '把「' + esc(exact.name) + '」加进家里有'
          : mode === 'form'
            ? '把「' + esc(exact.name) + '」加入菜品'
            : '选中「' + esc(exact.name) + '」';
        h += '<div class="btn-sub" data-act="add-this-ing" data-id="' + exact.id + '">' +
             addLabel + '</div>';
        h += '<div class="sec" style="margin-top:4px"><span class="t">其他食材</span></div>';
      }

      // 模糊匹配的食材列表
      var MAX = 24;
      var shown = list.slice(0, MAX);
      if (!shown.length) {
        h += '<div class="note-mini" style="text-align:center;padding:18px 0">' +
             '没找到「' + esc(q) + '」<br><span style="font-size:10px">试试别的写法，比如「西红柿」或「番茄」</span></div>';
      } else {
        h += '<div class="chips">';
        shown.forEach(function (g) {
          var on = sel.indexOf(g.id) !== -1;
          h += '<span class="chip' + (on ? ' on' : '') + '" data-ing-toggle="' + g.id + '">' + esc(g.name) + '</span>';
        });
        h += '</div>';
        if (list.length > MAX) {
          h += '<div class="note-mini" style="text-align:center">还有 ' + (list.length - MAX) +
               ' 种，继续输入可以缩小范围</div>';
        }
      }
    } else {
      // 无搜索词时的列表。
      // 忌口/过敏要能选到非常用食材（香菜、苦瓜、内脏…），所以这个模式不截断；
      // 食材页只会往里加东西，给常用 24 个就够，避免一屏铺满。
      var cap = (mode === 'memberField') ? list.length : 24;
      var shown2 = list.slice(0, cap);
      h += '<div class="chips">';
      shown2.forEach(function (g) {
        var on = sel.indexOf(g.id) !== -1;
        h += '<span class="chip' + (on ? ' on' : '') + '" data-ing-toggle="' + g.id + '">' + esc(g.name) + '</span>';
      });
      h += '</div>';
      if (list.length > cap) {
        h += '<div class="note-mini" style="text-align:center">还有 ' + (list.length - cap) +
             ' 种，输个关键词更快找到</div>';
      }
    }
    return h;
  }

  function pkFootInner(p) {
    var mode = p.mode || 'pantry';
    var sel = p.sel || [];
    var h = '';
    if (mode === 'pantry') {
      h += '<div class="btn-main" data-act="ing-done">完 成（' + sel.length + ' 样）</div>';
    } else if (mode === 'form') {
      h += '<div class="btn-main" data-act="ing-done">加 入 菜 品</div>';
    } else if (mode === 'memberField') {
      h += '<div class="btn-main" data-act="ing-done">确 定（已选 ' + sel.length + ' 样）</div>';
    } else if (mode === 'diet') {
      h += '<div class="btn-main" data-act="ing-done">确 定</div>';
    }
    h += '<div class="btn-sub" data-act="close-sheet">取消</div>';
    return h;
  }

  /* ---------- 菜品编辑：草稿操作 ---------- */

  function setDraft(key, val) {
    if (!S._draft) return;
    S._draft[key] = val;
    render();
  }

  // toggleDraftMeal / toggleDraftTool 已随「分类与规格」卡片一起删除：
  // 餐次和器具不再让用户手改，没有调用方了。

  function delDraftIng(idx) {
    if (!S._draft || !S._draft.ingredients) return;
    S._draft.ingredients.splice(idx, 1);
    render();
  }

  function editDraftField(field) {
    if (!S._draft) return;
    if (field === 'name') {
      promptInput('菜名', S._draft.name || '', { onOk: function (v) {
        if (!v.trim()) { toast('菜名不能为空'); return; }
        S._draft.name = v.trim();
        render();
      } });
      return;
    } else if (field === 'minutes') {
      promptInput('耗时（分钟，1–240）', String(S._draft.minutes || 20), { onOk: function (v) {
        var n = parseInt(v, 10);
        if (!n || n < 1 || n > 240) { toast('请输入 1–240 之间的整数'); return; }
        S._draft.minutes = n;
        render();
      } });
      return;
    } else if (field === 'tip') {
      promptInput('小提示（可留空）', S._draft.tip || '', { onOk: function (v) {
        S._draft.tip = v.trim();
        render();
      } });
      return;
    }
    render();
  }

  /* ---------- 食材选择器：动作 ---------- */

  function toggleIngPick(id) {
    var p = S._pick;
    if (!p) return;
    var i = p.sel.indexOf(id);
    if (i === -1) p.sel.push(id); else p.sel.splice(i, 1);
    // 食材页模式：实时写入本机（关掉弹层也算已保存）
    if (p.mode === 'pantry') {
      S.state.pantry.items = p.sel.slice();
      S.state.pantry.updatedAt = new Date().toISOString();
      S.state.pantry.updatedBy = me();
      save();
    }
    // 所有模式都只重绘弹层内部：
    // 走整页 render() 会把弹层连根换掉，选中状态看起来"没了"
    refreshIngPicker();
  }

  function setIngCat(cat) {
    if (!S._pick) return;
    S._pick.cat = cat;
    refreshIngPicker();
  }

  // 搜索输入：写回数据 + 局部重绘（不整页渲染，输入框才不会失焦）
  function onIngInput(val) {
    if (!S._pick) return;
    // 拼字中途（拼音还没变成汉字）先不动：此时 val 是 "fanqie" 这种中间态，
    // 拿去过滤只会闪出「没找到」。等 compositionend 提交了再走一次。
    if (ingComposing) return;
    S._pick.q = val;
    refreshIngPicker();
  }

  // 食材页（Tab）的搜索输入。和上面的弹层同一个套路：
  // 写回状态 + 只重画结果区，输入框节点保持不动。
  function onPantryInput(val) {
    if (pantryComposing) return;
    S._pantryQ = val;
    paintPantry();
  }

  /**
   * 重画食材弹层内部各区块，输入框节点原地不动。
   *
   * 这是打字能用的关键 —— 早先的实现在每次按键时 innerHTML 重建整个弹层，
   * 输入框被换成新节点，焦点和输入法组合一起丢，表现为"完全打不了字、界面一直在跳"。
   * 现在输入框是独立的一块，周围区块随便换都不影响它。
   */
  function paintIngPicker() {
    var sheetEl = document.querySelector('.sheet-host .sheet');
    if (!sheetEl || !S._pick) return false;

    var p = S._pick;

    // 输入框：用户正在里面打字时，以 DOM 为准（不写回，免得打断输入法）；
    // 否则以数据为准（比如点了「清除搜索」）。
    var input = sheetEl.querySelector('[data-ing-input]');
    if (input) {
      if (document.activeElement === input) {
        if (!ingComposing) p.q = input.value;
      } else if (!ingComposing && input.value !== (p.q || '')) {
        input.value = p.q || '';
      }
    }

    var regions = {
      top: pkTopInner(p),
      mag: pkMagInner(p.q || ''),
      chips: pkChipsInner(p),
      filters: pkFiltersInner(p),
      body: pkBodyInner(p),
      foot: pkFootInner(p)
    };
    Object.keys(regions).forEach(function (k) {
      var el = sheetEl.querySelector('[data-pk="' + k + '"]');
      if (!el) return;
      if (el.innerHTML !== regions[k]) el.innerHTML = regions[k];
    });
    return true;
  }

  function refreshIngPicker() {
    // 弹层不在（比如刚好被关掉）就退回整页渲染兜底
    if (!paintIngPicker()) render();
  }

  // 「把某食材加进家里有」
  function addThisIngredient(id) {
    var p = S._pick;
    if (!p) return;
    if (p.sel.indexOf(id) === -1) p.sel.push(id);
    if (p.mode === 'pantry') {
      S.state.pantry.items = p.sel.slice();
      S.state.pantry.updatedAt = new Date().toISOString();
      S.state.pantry.updatedBy = me();
      save();
    }
    var g = S.ingIndex.byId[id];
    toast('已加「' + (g ? g.name : id) + '」');
    refreshIngPicker();
  }

  /* ---------- 弹层包装 ---------- */
  function sheet(inner) {
    return SHEET_MARK +
           '<div class="sheet-mask" data-act="close-sheet"><div class="sheet" data-stop="1">' +
           inner + '</div></div>' +
           SHEET_MARK;
  }

  /* ---------- Trigger Morph：弹层从被点的按钮形变展开 ----------
     点任意按钮开弹层时，面板从**那颗按钮的形状**长出来，而不是从屏幕底部滑上来。
     这样能说明「面板是我点的地方来的」。

     两个必须做对的地方：
       1. 起点实时量按钮的 getBoundingClientRect()（宽高都要）—— 按钮宽度随文案变，
          硬编码会让面板从错误的尺寸开始长。
       2. 圆角与尺寸一起插值：胶囊 999px → 面板圆角。只变尺寸不变圆角会像"方块长大"。

     用 Web Animations API 而不是 CSS transition：需要能取消、能反向、能拿到 finished。 */
  var _morphSrc = null;        // 触发这次展开的那颗按钮的矩形

  // 事件委托里拿不到"哪个按钮被点"，在捕获阶段记下来。
  //
  // ⚠️ 记矩形而不是元素：onClick 处理完会 render()，scr.innerHTML 被整块换掉，
  // 那颗按钮节点当场就脱离了文档（isConnected=false）。等动画开始时再去量，
  // 拿到的是空矩形，形变会静默不播。pointerdown 时量好最稳 —— 那一刻
  // 布局还没变，而且 pointerdown 和 click 之间不会发生重渲染。
  document.addEventListener('pointerdown', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var el = t.closest('[data-act],[data-tab]');
    if (!el) { _morphSrc = null; return; }
    var r = el.getBoundingClientRect();
    _morphSrc = { left: r.left, top: r.top, width: r.width, height: r.height };
  }, true);

  function morphOpen(host) {
    var mask = host.querySelector('.sheet-mask');
    var sheetEl = host.querySelector('.sheet');
    var br = _morphSrc;
    _morphSrc = null;

    // 用户关了动效、或者没记到触发源（例如页面刷新后直接进二级页）→ 用原来的滑入
    if (!mask || !sheetEl || !br || !sheetEl.animate) return;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    // 按钮已经滚出屏幕 / 尺寸为 0 → 别从一个看不见的地方长出来
    if (!br.width || !br.height) return;
    // 触发源不在视口里（例如用户滚到底部点了按钮、随后页面又回到顶部）：
    // 从屏幕外的位置长出来会看到面板"从外面飞进来"，比直接滑入更奇怪。此时退回滑入。
    var vh = window.innerHeight || 0;
    var vw = window.innerWidth || 0;
    if (br.top > vh || br.left > vw || br.top + br.height < 0 || br.left + br.width < 0) return;

    // 面板最终位置：此刻它已在 DOM 里（mask 是 fixed + flex-end，面板贴底）
    var tr = sheetEl.getBoundingClientRect();
    if (!tr.width || !tr.height) return;

    var dx = br.left - tr.left;
    var dy = br.top - tr.top;

    // 面板自己的入场动画（CSS 的 slideUp）让位给形变，否则两个动画打架
    sheetEl.style.animation = 'none';

    var dur = 520;
    var ease = 'cubic-bezier(.22,.9,.24,1)';
    var a1 = sheetEl.animate([
      { transform: 'translate(' + dx + 'px,' + dy + 'px)',
        width: br.width + 'px', height: br.height + 'px',
        borderRadius: '999px', opacity: .55 },
      { transform: 'translate(0,0)',
        width: tr.width + 'px', height: tr.height + 'px',
        borderRadius: '24px', opacity: 1 }
    ], { duration: dur, easing: ease, fill: 'both' });

    // 内容延到 60% 才淡入 —— 早了文字会被拉伸变形
    var inner = sheetEl.querySelector('.sheet-top') || sheetEl.firstElementChild;
    if (inner) {
      inner.animate([
        { opacity: 0, transform: 'translateY(12px)' },
        { opacity: 0, transform: 'translateY(12px)', offset: .6 },
        { opacity: 1, transform: 'translateY(0)' }
      ], { duration: dur, easing: 'ease-out', fill: 'both' });
    }
    mask.animate([{ opacity: 0 }, { opacity: 1 }],
      { duration: dur, easing: 'ease-out', fill: 'both' });

    // 动画结束把 fill 撤掉，否则面板会一直停在动画最后一帧（改尺寸会错位）
    var restored = false;
    function restore() {
      if (restored) return;
      restored = true;
      try { a1.cancel(); } catch (err) {}
      sheetEl.style.animation = '';
    }
    a1.finished.then(restore).catch(restore);
    // 兜底：动画被中途取消 / 暂停（finished 永不 resolve）时也要还原，
    // 否则那颗面板会一直带着"动画最后一帧"的几何，后续改尺寸就错位。
    setTimeout(restore, dur + 120);
  }

  /**
   * 二级页面的形变展开。
   *
   * 和弹层同一个意思，但二级页面是整屏内容，不能去动 .scr 的宽高
   * （它是 flex:1 的滚动容器，动画宽高会把内容挤变形）。
   * 所以改用 clip-path 从一个等于按钮矩形的窗口扩到整屏 ——
   * 视觉上同样是"从我点的那颗按钮长出来"，但不碰布局。
   */
  function morphPage(scr) {
    var br = _morphSrc;
    _morphSrc = null;
    if (!br || !scr || !scr.animate) return;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    var sr = scr.getBoundingClientRect();
    if (!br.width || !br.height || !sr.width || !sr.height) return;

    // 按钮矩形换算成 .scr 坐标系里的四条内缩边
    var top = Math.max(0, br.top - sr.top);
    var left = Math.max(0, br.left - sr.left);
    var right = Math.max(0, sr.right - (br.left + br.width));
    var bottom = Math.max(0, sr.bottom - (br.top + br.height));

    var a = scr.animate([
      { clipPath: 'inset(' + top + 'px ' + right + 'px ' + bottom + 'px ' + left + 'px round 16px)',
        opacity: .55 },
      { clipPath: 'inset(0px 0px 0px 0px round 0px)', opacity: 1 }
    ], { duration: 520, easing: 'cubic-bezier(.22,.9,.24,1)', fill: 'both' });
    a.finished.then(function () { try { a.cancel(); } catch (e) {} }).catch(function () {});
  }

  /* ---------- 主渲染 ---------- */
  /**
   * @param {boolean} animateNav 仅切换底部 Tab 时传 true；
   *   其余渲染（勾选、重绘、进二级页）都不该让胶囊"滑"，直接落位即可。
   */
  /**
   * 这几个视图本身就是"浮层"，渲染结果只有一张弹层。
   *
   * 它们出现时如果直接把结果写进 .scr，底层页面就被清空了 ——
   * 用户看到的就是"点一下按钮，背景全空"。所以下面 render() 会：
   *   1. 把弹层之前那一页重新画在底层（S._baseView / S._baseTab）
   *   2. 再把这层弹层叠上去
   * 弹层关掉后 S.view 变回 null，底层那一页自然还在。
   */
  var SHEET_VIEWS = { random: 1, askInput: 1, syncConfirm: 1, confirm: 1, ingPicker: 1 };

  /** 按给定的视图/标签页画一页（不含任何"浮层"叠加逻辑）。 */
  function renderPage(view, tab) {
    if (view && view.name === 'vote') return renderVote();
    if (view && view.name === 'reveal') return renderReveal();
    if (view && view.name === 'recipe') return renderRecipe();
    if (view && view.name === 'recipeForm') return renderRecipeForm();
    if (view && view.name === 'shopping') return renderShopping();
    if (view && view.name === 'random') return renderRandomSheet(!!view.params.expanded);
    if (view && view.name === 'sync') return renderSync();
    if (view && view.name === 'ingPicker') return renderIngredientPicker(S._pick);
    if (view && view.name === 'askInput') return renderAskInput();
    if (view && view.name === 'syncConfirm') return renderSyncConfirm();
    if (view && view.name === 'confirm') return renderConfirm();
    if (view && view.name === 'memberEdit') return renderMemberEdit();
    if (tab === 'library') return renderLibrary();
    if (tab === 'pantry') return renderPantry();
    if (tab === 'me') return renderMe();
    return renderToday();
  }

  function render(animateNav) {
    var app = document.getElementById('app');

    var isSheet = !!(S.view && SHEET_VIEWS[S.view.name]);
    if (!isSheet) {
      // 记下"弹层底下应该是哪一页"，等弹层出现时照着它重画
      S._baseView = S.view ? { name: S.view.name, params: S.view.params } : null;
      S._baseTab = S.tab;
    }

    var h;
    if (isSheet) {
      h = renderPage(S._baseView, S._baseTab || S.tab);   // 底层页面（保持可见）
      h += renderPage(S.view, S.tab);                    // 叠在上面的弹层
    } else {
      h = renderPage(S.view, S.tab);
    }

    // 同步状态细条
    if (syncStatus) {
      var cls = syncStatus.level === 'err' ? ' err' : syncStatus.level === 'warn' ? ' warn' : '';
      h = '<div class="sync-bar' + cls + '">' + esc(syncStatus.text) + '</div>' + h;
    }

    if (S.toast) {
      h += '<div class="toast">' + esc(S.toast.msg) +
           (S.toast.actionLabel ? '<span class="ta" data-act="toast-action">' + esc(S.toast.actionLabel) + '</span>' : '') +
           '</div>';
    }

    // 内容与底部导航分离：导航固定在 nav-dock，不随内容滚动
    var navHTMLPart = '';
    var activeTab = null;
    var parts = h.split(NAV_MARK);
    if (parts.length >= 3) {
      navHTMLPart = parts[1];
      h = parts[0] + parts.slice(2).join('');
      // 从生成好的导航里读出当前高亮项，避免另开一个变量走神
      var mm = navHTMLPart.match(/nav-i on" data-tab="([^"]+)"/);
      activeTab = mm ? mm[1] : null;
    }

    // 弹层同样抽出来，放进固定的 .sheet-host（不在 .scr 里，就不会被重渲染带走）
    var sheetHTMLPart = '';
    var sparts = h.split(SHEET_MARK);
    if (sparts.length >= 3) {
      sheetHTMLPart = sparts[1];
      h = sparts[0] + sparts.slice(2).join('');
    }

    // 保留滚动位置：勾选食材、切条件会重渲染，但不能把页面弹回顶部
    var oldScr = app.querySelector('.scr');
    var keepScroll = oldScr ? oldScr.scrollTop : 0;
    if (S._restoreScrollTop !== undefined) {
      // 显式要求：回到顶部（如切换 Tab / 进入二级页）
      keepScroll = S._restoreScrollTop;
      S._restoreScrollTop = undefined;
    }

    // ---- 结构复用 ----
    // 底部导航节点必须**保持同一个 DOM 元素**，否则 sliding pill 每次都是新节点、
    // 没有"上一个位置"可滑。所以只在首次构建外壳，之后只换内容。
    var shell = app.querySelector('.phone');
    var scr = shell ? shell.querySelector('.scr') : null;
    var dock = shell ? shell.querySelector('.nav-dock') : null;
    var host = app.querySelector('.sheet-host');

    if (!shell || !scr) {
      // 首次（或结构丢失）：整块建出来
      app.innerHTML = '<div class="phone"><div class="scr"></div></div>';
      shell = app.querySelector('.phone');
      scr = shell.querySelector('.scr');
      dock = null;
      host = null;
    }

    var needDock = !!navHTMLPart;
    if (needDock && !dock) {
      dock = document.createElement('div');
      dock.className = 'nav-dock';
      dock.innerHTML = navHTMLPart;
      shell.appendChild(dock);
    } else if (!needDock && dock) {
      dock.parentNode.removeChild(dock);
      dock = null;
    }

    // 内容
    var wasEmpty = !scr.firstChild;
    var prevView = scr.dataset.view || '';
    scr.innerHTML = h;
    if (keepScroll > 0) scr.scrollTop = keepScroll;
    // 进了二级页面（弹层之外的整屏页）→ 从刚点的按钮形变展开。
    // ⚠️ 有弹层时不做：弹层自己会形变（morphOpen），两者都去消费同一个
    //    按钮矩形，先跑的那个会把它清掉，后跑的就静默不播了。
    //    弹层优先 —— 它才是用户"点的那颗按钮"最直接的反馈。
    var nowView = (S.view && S.view.name) || ('tab:' + S.tab);
    if (!wasEmpty && nowView !== prevView && S.view && S.view.name && !sheetHTMLPart) {
      morphPage(scr);
    }
    scr.dataset.view = nowView;

    // ---- 弹层：独立宿主，不参与 .scr 的重建 ----
    if (!host) {
      host = document.createElement('div');
      host.className = 'sheet-host';
      app.appendChild(host);
    }
    var sig = sheetSig();
    if (!sheetHTMLPart) {
      // 没有弹层了：宿主清空（下次重进会走重建分支）
      if (host.firstChild) host.innerHTML = '';
      host.dataset.sig = '';
    } else if (sig && host.dataset.sig === sig && host.firstChild) {
      // 同一个带输入的弹层 → 不动它的 DOM，只把状态变化画进各区块。
      // 输入框、光标、输入法候选全都活着，这就是能正常打字的原因。
      paintIngPicker();
    } else {
      host.innerHTML = sheetHTMLPart;
      host.dataset.sig = sig;
      // 整块重建后要把输入框内容同步回来（例如「清除搜索」后再进）
      var hi = host.querySelector('[data-ing-input]');
      if (hi && S._pick) hi.value = S._pick.q || '';
      // 弹层刚建出来：从刚才点的那颗按钮形变展开（Trigger Morph）
      morphOpen(host);
    }

    // 导航选中态：只改 class，不重建节点
    if (dock) {
      var navOuter = dock.querySelector('.nav-outer');
      if (navOuter && activeTab) {
        var cur = navOuter.querySelector('.nav-i.on');
        if (cur && cur.dataset.tab !== activeTab) cur.classList.remove('on');
        var want = navOuter.querySelector('.nav-i[data-tab="' + activeTab + '"]');
        if (want) want.classList.add('on');
      }
      syncNavPill(animateNav);
    }
  }

  /* ---------- 滑动手势 ----------
     两个需求共用一个判定：
       · 子页面右滑返回（页面级）
       · 菜库卡片左滑删除（卡片级）

     用 pointer 事件而不是 touch 事件：桌面端用鼠标拖也能测，
     而且 iOS 上 pointer 事件与滚动配合正常。

     判定要点：
       · 先看方向 —— 横向位移要明显大于纵向，否则是在上下滚页面，不该抢
       · 卡片级的手势在 pointerdown 时就把行"锁"住，避免中途被滚动抢走
       · 不碰 touchend/touchmove 的 preventDefault（会吃掉 click，见 lockZoom 的注释） */

  var SWIPE_MIN = 46;        // 触发返回/删除的最小横向位移（px）
  var SWIPE_DIR = 1.6;       // 横向要大于纵向的多少倍才算横向滑动

  /** 返回上一级：和点左上角「←」完全同一条路径。 */
  function goBack() {
    if (!S.view || !S.view.name) return false;
    // 弹层有各自的关闭方式，不走"返回上一页"
    if (SHEET_VIEWS[S.view.name]) return false;
    S.view = null;
    render();
    return true;
  }

  // ---- 子页面右滑返回 ----
  var _pg = null;
  function onPageSwipeStart(e) {
    // 只在二级页面生效（有返回箭头的那些），弹层自己有关闭方式
    if (!S.view || !S.view.name) { _pg = null; return; }
    if (SHEET_VIEWS[S.view.name]) { _pg = null; return; }
    // 从屏幕最左边 40px 内起手才算"返回手势"，避免和别的手势打架
    if (e.clientX > 40) { _pg = null; return; }
    _pg = { x0: e.clientX, y0: e.clientY, locked: false, done: false };
  }
  function onPageSwipeMove(e) {
    if (!_pg || _pg.done) return;
    var dx = e.clientX - _pg.x0;
    var dy = e.clientY - _pg.y0;
    if (!_pg.locked) {
      // 还判断不出方向：横向不够明显就先不动，让页面正常滚动
      if (Math.abs(dx) < 12 && Math.abs(dy) < 12) return;
      if (Math.abs(dx) < Math.abs(dy) * SWIPE_DIR) { _pg = null; return; }
      _pg.locked = true;
    }
    if (dx >= SWIPE_MIN) {
      _pg.done = true;
      _pg = null;
      goBack();
    }
  }
  function onPageSwipeEnd() { _pg = null; }

  // ---- 菜库卡片左滑：露出「删除」按钮 ----
  // 拉过临界值就停在"打开"位置（露出删除按钮），而不是直接删掉 ——
  // 删除必须由用户点那个红色按钮才发生，避免误删。
  var _cd = null;
  var DEL_W = 88;          // .rrow-del 的宽度，和 CSS 保持一致
  var DEL_OPEN = 70;       // 拉过这么多就吸附到"打开"状态

  function onCardSwipeStart(e) {
    var row = e.target && e.target.closest ? e.target.closest('.rrow') : null;
    if (!row) { _cd = null; return; }
    // 投票按钮和删除按钮本身是点击交互，不参与滑动手势
    if (e.target.closest('[data-act="toggle-candidate"]')) { _cd = null; return; }
    if (e.target.closest('[data-act="swipe-del"]')) { _cd = null; return; }
    // 一次只允许一行展开：先把别的收回去
    closeAllSwipeRows(row);
    _cd = { row: row, x0: e.clientX, y0: e.clientY, locked: false, done: false, dx: 0,
            startOffset: row.dataset.offset ? Number(row.dataset.offset) : 0 };
  }

  function onCardSwipeMove(e) {
    if (!_cd || _cd.done) return;
    var dx = e.clientX - _cd.x0;
    var dy = e.clientY - _cd.y0;
    if (!_cd.locked) {
      if (Math.abs(dx) < 12 && Math.abs(dy) < 12) return;
      // 横向（且不是明显向右）才接管；否则让页面正常滚动
      if (Math.abs(dx) < Math.abs(dy) * SWIPE_DIR) { _cd = null; return; }
      _cd.locked = true;
      _cd.row.style.transition = 'none';
    }
    // 跟手位移：从当前偏移继续，夹在 [-DEL_W, 0]
    var shift = _cd.startOffset + dx;
    if (shift > 0) shift = 0;
    if (shift < -DEL_W) shift = -DEL_W;
    _cd.dx = shift;
    _cd.row.style.transform = 'translateX(' + shift + 'px)';
    e.preventDefault();
  }

  function onCardSwipeEnd() {
    if (!_cd) return;
    var row = _cd.row, dx = _cd.dx, locked = _cd.locked;
    _cd = null;
    if (!locked) return;
    row.style.transition = 'transform .22s cubic-bezier(.22,.9,.24,1)';
    // 吸附：拉过一半就停在打开位，否则弹回
    if (dx <= -DEL_OPEN) {
      row.style.transform = 'translateX(' + (-DEL_W) + 'px)';
      row.dataset.offset = String(-DEL_W);
    } else {
      row.style.transform = '';
      row.dataset.offset = '0';
    }
  }

  /** 把除了 keep 之外所有已展开的行收回原位。 */
  function closeAllSwipeRows(keep) {
    var open = document.querySelectorAll('.rrow[data-offset]');
    for (var i = 0; i < open.length; i++) {
      var r = open[i];
      if (r === keep) continue;
      if (r.dataset.offset === '0') continue;
      r.style.transition = 'transform .22s cubic-bezier(.22,.9,.24,1)';
      r.style.transform = '';
      r.dataset.offset = '0';
    }
  }

  /* ---------- 事件 ---------- */
  function onClick(e) {
    var t = e.target;

    // 先处理「无 data-act 但有专门标记」的元素。
    // 注意顺序：这些元素可能嵌在 .sheet-mask[data-act=close-sheet] 里，
    // 若先走 data-act 分支会被误判成「点遮罩 → 关弹层」。
    var special = t;
    while (special && special !== document.body) {
      var d = special.dataset;
      if (d) {
        if (d.tab) {
          S.tab = d.tab; S.view = null;
          S._restoreScrollTop = 0;   // 切 Tab 回到顶部
          render(true); return;      // 只有切 Tab 才让胶囊滑
        }
        if (d.vote) { setVote(d.id, d.vote); return; }
        // d.cond / d.condSw 已随「调整条件」面板删除（不再有这些元素）
        if (d.pantry) { togglePantry(d.pantry); return; }
        if (d.check) { toggleCheck(d.check); return; }
        if (d.ingToggle) { toggleIngPick(d.ingToggle); return; }
        if (d.ingCat) { setIngCat(d.ingCat); return; }
        if (d.ingDish) {
          var pkd = S._pick;
          if (pkd && pkd.mode === 'pantry') {
            S.state.pantry.items = pkd.sel.slice();
            S.state.pantry.updatedAt = new Date().toISOString();
            S.state.pantry.updatedBy = me();
            save();
          }
          S._pick = null;
          S.view = { name: 'recipe', params: { id: d.ingDish } };
          S._restoreScrollTop = 0;
          render(); return;
        }
        if (d.formEmoji) { setDraft('emoji', d.formEmoji); return; }
        // 成员档案编辑
        if (d.memberEmoji) {
          if (S._memberDraft) S._memberDraft.emoji = d.memberEmoji;
          render(); return;
        }
        if (d.memberDel) {
          var parts = String(d.memberDel).split(':');
          var fld = parts[0], iid = parts.slice(1).join(':');
          if (S._memberDraft) {
            var arr = String(S._memberDraft[fld] || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
            var ix = arr.indexOf(iid);
            if (ix !== -1) arr.splice(ix, 1);
            S._memberDraft[fld] = arr.join(',');
          }
          render(); return;
        }
        // 分类与规格那张卡片已删，对应的 formMeal / formRole / formTool /
        // formCost / formDiff / formSpicy / formHealthy 处理一并去掉。
        if (d.formDelIng !== undefined) { delDraftIng(Number(d.formDelIng)); return; }
        if (d.form) { editDraftField(d.form); return; }
      }
      // 遇到带 data-act 的祖先就停，交给下面的分支处理
      if (d && d.act) break;
      special = special.parentElement;
    }

    // 找到最近的带 data-act 的元素
    var node = t;
    var act = null, data = {};
    while (node && node !== document.body) {
      if (node.dataset && node.dataset.act) {
        act = node.dataset.act;
        data = node.dataset;
        break;
      }
      node = node.parentElement;
    }
    if (!act) return;

    switch (act) {
      case 'back': S.view = null; render(); break;

      /* ---- 内联输入弹层（替代 prompt） ---- */
      case 'ask-input-ok': {
        var ask = S._askInput;
        var val = '';
        var inp = document.querySelector('[data-ask-input]');
        if (inp) val = inp.value;
        S._askInput = null;
        S.view = (ask && ask.back) || null;
        // 先渲染回到原页面，再执行回调（回调里通常还会自己 render/save）
        render();
        if (ask && typeof ask.onOk === 'function') ask.onOk(String(val || ''));
        break;
      }
      case 'ask-input-cancel': {
        var ask2 = S._askInput;
        S._askInput = null;
        S.view = (ask2 && ask2.back) || null;
        render();
        break;
      }

      /* ---- 内联确认弹层（替代 confirm） ---- */
      case 'confirm-ok': {
        var cf = S._confirm;
        S._confirm = null;
        if (cf && typeof cf.onOk === 'function') cf.onOk();
        else { S.view = (cf && cf.back) || null; render(); }
        break;
      }
      case 'confirm-cancel': {
        var cf2 = S._confirm;
        S._confirm = null;
        S.view = (cf2 && cf2.back) || null;
        render();
        break;
      }

      /* ---- 成员档案编辑 ---- */
      case 'member-edit-back':
        S._memberDraft = null; S._memberEditKey = null;
        S.view = null; S.tab = 'me';
        render(); break;
      case 'member-edit-save':
        saveMemberEdit(); break;
      case 'member-add': {
        // 复用食材选择器，选完写回草稿
        var field = data.field;
        S._pick = {
          mode: 'memberField', q: '', cat: 'all', title: field === 'allergies' ? '选择过敏食材' : '选择不吃的食材',
          sel: String((S._memberDraft || {})[field] || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean),
          field: field
        };
        S._pickSeq = (S._pickSeq || 0) + 1;
        S.view = { name: 'ingPicker', params: {} };
        render(); break;
      }

      case 'sync-disconnect-ok':
        doSyncDisconnectConfirm(); break;
      case 'sync-disconnect-no':
        S.view = S._syncConfirmBack || { name: 'sync', params: {} };
        S._syncConfirmBack = null;
        render(); break;

      case 'close-sheet':
        // 点遮罩关弹层；输入/确认弹层要回到打开前的页面，其余弹层维持原行为
        if (e.target === node) {
          if (S.view && S.view.name === 'askInput') {
            S.view = (S._askInput && S._askInput.back) || null;
            S._askInput = null;
          } else if (S.view && S.view.name === 'syncConfirm') {
            S.view = S._syncConfirmBack || { name: 'sync', params: {} };
            S._syncConfirmBack = null;
          } else {
            S.view = null;
          }
          render();
        }
        break;
      case 'random':
        S.view = { name: 'random', params: {} }; render(); break;
      // expand-cond / save-default 已随「调整条件」面板一起删除（用户不需要筛选偏好）。
      // 条件本身仍有默认值（state.defaultConditions），只是不再让用户手改。
      case 'do-draw': doDraw(); break;
      case 'pick-self':
        S.tab = 'library'; S.view = null; S._restoreScrollTop = 0;
        render(); toast('点任意菜即定今晚做'); break;
      case 'find-by-pantry':
        S.tab = 'pantry'; S.view = null; S._restoreScrollTop = 0; render(); break;
      case 'go-shopping': S.view = { name: 'shopping' }; S._restoreScrollTop = 0; render(); break;
      // go-recent 已删（那排快捷按钮一起去掉了；「最近做过」列表仍在今天页）
      case 'open-recipe': S.view = { name: 'recipe', params: { id: data.id } }; S._restoreScrollTop = 0; render(); break;
      case 'edit-recipe': S.view = { name: 'recipeForm', params: { id: data.id } }; S._restoreScrollTop = 0; render(); break;
      case 'new-recipe': S.view = { name: 'recipeForm', params: {} }; S._restoreScrollTop = 0; render(); break;
      case 'done': markDone(data.id); toast('已记下「' + (recipe(data.id) || {}).name + '」', '撤销', function () { undoDone(data.id); }); break;
      case 'undo-done': undoDone(data.id); render(); break;
      case 'remove-tonight': removeTonight(data.id); render(); break;
      case 'decide': decide(data.id); break;
      case 'add-shopping': toast('已加入采购清单'); break;
      case 'toggle-blocked':
        S.view = { name: null }; S.tab = 'library';
        S.view = { name: 'library', params: { showBlocked: !(S.view && S.view.params && S.view.params.showBlocked) } };
        render(); break;
      case 'expand-pantry':
        S.tab = 'pantry';
        S.view = { name: 'pantry', params: { allPantry: true } };
        render(); break;
      case 'collapse-pantry':
        S.view = null; S.tab = 'pantry'; render(); break;

      /* ---- 食材选择器 ---- */
      case 'open-ing-picker': {
        // 从食材页打开：已选 = 当前 pantry，改动实时写入
        S._pick = { mode: 'pantry', q: '', cat: 'all',
                    sel: (S.state.pantry.items || []).slice(),
                    restore: { tab: 'pantry' } };
        S._pickSeq = (S._pickSeq || 0) + 1;   // 新的一次打开：换签名，重建输入框
        S.view = { name: 'ingPicker', params: {} };
        render(); break;
      }
      case 'clear-ing-search': {
        S._pick.q = '';
        // 输入框节点是长期的，清数据的同时必须把它自己的值也清掉
        var ci = document.querySelector('.sheet-host [data-ing-input]');
        if (ci) ci.value = '';
        refreshIngPicker(); break;
      }

      /* ---- 食材页（Tab）自己的搜索框 ---- */
      case 'swipe-del': {
        // 左滑露出的红色删除按钮
        var dr = recipe(data.id);
        doRemoveRecipe(data.id);
        render();
        // 撤销：把菜放回菜库（内置菜就是从 removedRecipes 名单里拿掉）
        toast('已删除「' + (dr ? dr.name : '') + '」', '撤销', function () {
          undoRemoveRecipe(data.id);
          render();
          toast('已恢复「' + (dr ? dr.name : '') + '」');
        });
        break;
      }
      case 'toggle-candidate': {
        // 菜库里点「加入投票 / 已在投票」：把这道菜加进/移出当前候选
        var vs = S.state.session;
        if (!vs || sessionExpired() || vs.status !== 'voting') {
          toast('没有进行中的投票');
          break;
        }
        var idx = vs.candidates.indexOf(data.id);
        var rn = recipe(data.id);
        if (idx === -1) {
          if (vs.candidates.length >= 8) { toast('候选最多 8 道'); break; }
          vs.candidates.push(data.id);
          toast('已加入投票：' + (rn ? rn.name : ''));
        } else {
          vs.candidates.splice(idx, 1);
          // 把自己对这道菜的投票一起清掉，否则提交时会带上已移除的菜
          if (vs.myVote) delete vs.myVote[data.id];
          toast('已移出投票：' + (rn ? rn.name : ''));
        }
        save();
        render();
        break;
      }
      case 'clear-pantry-search': {
        S._pantryQ = '';
        // 和上面同理：输入框节点是长期的，清数据时要把它自己的值也清掉
        var pi = document.querySelector('.scr [data-pantry-input]');
        if (pi) pi.value = '';
        paintPantry(); break;
      }
      case 'pantry-pick': {
        // 点「相近的食材」里的某个 → 直接把搜索词换成它
        var pg = S.ingIndex.byId[data.id];
        if (pg) {
          S._pantryQ = pg.name;
          var pi2 = document.querySelector('.scr [data-pantry-input]');
          if (pi2) pi2.value = pg.name;
          paintPantry();
        }
        break;
      }
      case 'add-this-ing':
        addThisIngredient(data.id); break;
      case 'ing-dish': {
        // 点搜索结果里的菜 → 看详情（先把已选写入，避免丢改动）
        var pk0 = S._pick;
        if (pk0 && pk0.mode === 'pantry') {
          S.state.pantry.items = pk0.sel.slice();
          S.state.pantry.updatedAt = new Date().toISOString();
          S.state.pantry.updatedBy = me();
          save();
        }
        S._pick = null;
        S.view = { name: 'recipe', params: { id: data.id } };
        S._restoreScrollTop = 0;
        render(); break;
      }
      case 'ing-done': {
        var pk = S._pick;
        if (pk.mode === 'pantry') {
          S.state.pantry.items = pk.sel.slice();
          S.state.pantry.updatedAt = new Date().toISOString();
          S.state.pantry.updatedBy = me();
          save();
          S._pick = null;
          S.view = null; S.tab = 'pantry';
          toast('家里有 ' + pk.sel.length + ' 样食材');
        } else if (pk.mode === 'form') {
          // 追加到菜品表单的食材草稿
          var d = S._draft || (S._draft = {});
          d.ingredients = d.ingredients || [];
          pk.sel.forEach(function (id) {
            if (!d.ingredients.some(function (x) { return x.id === id; })) {
              d.ingredients.push({ id: id, amount: '适量' });
            }
          });
          S._pick = null;
          S.view = { name: 'recipeForm', params: S._formParams || {} };
          toast('加了 ' + pk.sel.length + ' 样食材');
        } else if (pk.mode === 'memberField') {
          // 写回成员档案草稿的那个字段
          if (S._memberDraft) S._memberDraft[pk.field] = pk.sel.join(',');
          S._pick = null;
          S.view = { name: 'memberEdit' };
          toast('选了 ' + pk.sel.length + ' 样');
        } else {
          S._pick = null;
          S.view = null; S.tab = 'pantry';
        }
        render(); break;
      }
      case 'clear-search': S.view = null; S.tab = 'library'; render(); break;
      case 'focus-search': {
        promptInput('搜索菜名或食材', '', { onOk: function (v) {
          S.view = { name: 'library', params: { q: v } }; S.tab = 'library'; render();
        } });
        break;
      }
      case 'submit-vote': submitVote(); break;
      case 'check-partner': checkPartnerVote().then(function (found) { if (!found) toast('对方还没投'); }); break;
      case 'cancel-session': clearSession(); pushSoon(); toast('已取消这次投票'); break;
      case 'reveal-sim':
        // 单机演示：把对方票按「都行」填充后揭晓
        if (S.state.session) {
          S.state.session.partnerVote = {};
          S.state.session.candidates.forEach(function (id) { S.state.session.partnerVote[id] = 'ok'; });
          save();
        }
        S.view = { name: 'reveal' }; render(); break;
      case 'pick-direct':
        S.view = { name: 'reveal' }; render(); break;
      case 'vote': S.view = { name: 'vote' }; render(); break;
      case 'copy-list': copyList(); break;
      case 'bought-to-pantry': boughtToPantry(); break;
      case 'export': doExport(); break;
      case 'import': doImport(); break;
      case 'clear': doClear(); break;
      case 'sync-setup': S.view = { name: 'sync', params: {} }; S._restoreScrollTop = 0; render(); break;
      case 'sync-connect': doSyncConnect(); break;
      case 'sync-now': doPull().then(function () { return doPush(); }).then(function () { setSyncStatus('ok', '已同步'); }); break;
      case 'sync-disconnect': doSyncDisconnect(); break;
      case 'toggle-adv': S.view = { name: 'sync', params: { adv: !(S.view.params && S.view.params.adv) } }; render(); break;
      case 'input-token': doInputToken(); break;
      case 'input-owner': {
        // promptInput 是回调式，不再是返回值式
        promptInput('GitHub 用户名', (S.state.settings.sync || {}).owner || '', {
          placeholder: '自动识别',
          onOk: function (v) {
            if (!v.trim()) return;
            var sc1 = S.state.settings.sync || { enabled: false, repo: 'chishenme-data', branch: 'main' };
            sc1.owner = v.trim();
            saveSyncCfg(sc1);
            S.view = { name: 'sync', params: { adv: true } };
            render();
          }
        });
        break;
      }
      case 'input-repo': {
        promptInput('数据仓库名', (S.state.settings.sync || {}).repo || 'chishenme-data', {
          placeholder: 'chishenme-data',
          onOk: function (v) {
            if (!v.trim()) return;
            var sc2 = S.state.settings.sync || { enabled: false, owner: '', branch: 'main' };
            sc2.repo = v.trim();
            saveSyncCfg(sc2);
            S.view = { name: 'sync', params: { adv: true } };
            render();
          }
        });
        break;
      }
      case 'input-branch': {
        promptInput('分支', (S.state.settings.sync || {}).branch || 'main', {
          placeholder: 'main',
          onOk: function (v) {
            if (!v.trim()) return;
            var sc3 = S.state.settings.sync || { enabled: false, owner: '', repo: 'chishenme-data' };
            sc3.branch = v.trim();
            saveSyncCfg(sc3);
            S.view = { name: 'sync', params: { adv: true } };
            render();
          }
        });
        break;
      }
      case 'set-me': {
        S.state.me = data.id; save(); render();
        toast('这台手机是「' + memberName(data.id) + '」');
        break;
      }
      case 'edit-member': {
        // 打开成员档案编辑页（替代原来四连 prompt）
        var mk = data.id;
        var mm = S.state.members[mk] || {};
        S._memberEditKey = mk;
        S._memberDraft = {
          name: mm.name || '',
          emoji: mm.emoji || '🙂',
          dislikes: (mm.dislikes || []).join(','),
          allergies: (mm.allergies || []).join(',')
        };
        S.view = { name: 'memberEdit' };
        S._restoreScrollTop = 0;
        render(); break;
      }
      case 'toast-action': if (S.toast && S.toast.action) S.toast.action(); S.toast = null; render(); break;
      case 'save-recipe': saveRecipeForm(); break;
      case 'add-ing': {
        // 用食材选择器，不再让用户手输 id
        S._pick = {
          mode: 'form', q: '', cat: 'all',
          sel: (S._draft && S._draft.ingredients ? S._draft.ingredients.map(function (x) { return x.id; }) : []),
          title: '添加食材'
        };
        S._formParams = S.view.params;
        S._pickSeq = (S._pickSeq || 0) + 1;
        S.view = { name: 'ingPicker', params: {} };
        render(); break;
      }
      case 'reset-recipe': resetRecipe(data.id); break;
      case 'delete-recipe': deleteRecipe(data.id); break;
      default: break;
    }
  }

  /* ---------- 动作实现 ---------- */

  // setCond / toggleCond 已随「调整条件」面板删除：没有调用方了。
  // 选菜条件现在只读（state.lastConditions 用默认值建好后就固定）。

  function doDraw() {
    var c = S.state.lastConditions;
    var p = C.buildPool(c, S.recipes, S.state, S.ingIndex, { today: today() });
    if (!p.pool.length) { toast('没有符合条件的菜，先放宽条件'); return; }
    var picked = C.weightedPick(p.pool, c.count, c, S.state, S.ingIndex, { today: today() });
    if (!picked.length) { toast('抽不出菜，先放宽条件'); return; }
    newSession(picked.map(function (r) { return r.id; }));
    S.view = { name: 'vote' };
    render();
  }

  function setVote(id, val) {
    var s = S.state.session;
    if (!s || s.mySubmittedAt) return;
    if (!s.myVote) s.myVote = {};
    s.myVote[id] = val;
    save();
    render();
  }

  function submitVote() {
    var s = S.state.session;
    if (!s) return;
    var pending = s.candidates.filter(function (id) { return !(s.myVote || {})[id]; });
    if (pending.length) { toast('还有 ' + pending.length + ' 道没选'); return; }
    s.mySubmittedAt = new Date().toISOString();
    save();

    var solo = !syncOn();
    if (solo) {
      // 单机模式：直接进揭晓（对方票按「都行」填充，便于单人使用）
      s.partnerVote = {};
      s.candidates.forEach(function (id) { s.partnerVote[id] = 'ok'; });
      s.status = 'revealed';
      save();
      S.view = { name: 'reveal' };
      render();
      return;
    }

    // 双人模式：上传自己的投票，然后等对方
    render();
    pushMyVote().then(function () {
      render();
      // 顺手看看对方投了没（可能他先投了）
      checkPartnerVote();
    });
  }

  function decide(id) {
    var r = recipe(id);
    if (!r) return;
    if (tonightActive().length >= 3) { toast('今晚菜单已满（3 道）'); return; }
    if (addTonight(id)) {
      clearSession();
      S.view = null; S.tab = 'today';
      toast('今晚吃「' + r.name + '」');
    } else {
      toast('这道菜已经在今晚菜单里了');
    }
  }

  function togglePantry(id) {
    var arr = S.state.pantry.items;
    var i = arr.indexOf(id);
    if (i === -1) arr.push(id); else arr.splice(i, 1);
    S.state.pantry.updatedAt = new Date().toISOString();
    S.state.pantry.updatedBy = me();
    save();
    render();
  }

  function toggleCheck(id) {
    if (!S.state.checklistChecked) S.state.checklistChecked = [];
    var arr = S.state.checklistChecked;
    var i = arr.indexOf(id);
    if (i === -1) arr.push(id); else arr.splice(i, 1);
    save();
    render();
  }

  function copyList() {
    var menu = tonightActive();
    var shop = C.buildShoppingList(menu, S.state, S.ingIndex, S.recipeById);
    var lines = [];
    lines.push('今晚做：' + menu.map(function (x) { var r = recipe(x.recipeId); return r ? r.name : ''; }).filter(Boolean).join('、'));
    lines.push('');
    var order = ['vegetable','protein','seafood','soy','staple','dry','fruit','condiment','other'];
    order.forEach(function (cat) {
      var items = shop.toBuyByCat[cat];
      if (!items || !items.length) return;
      lines.push(C.CATEGORY_LABEL[cat]);
      items.forEach(function (it) { lines.push('- ' + it.name + ' ' + it.amounts.join(' + ')); });
      lines.push('');
    });
    var text = lines.join('\n');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast('清单已复制'); }, function () { fallbackCopy(text); });
    } else fallbackCopy(text);
  }

  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast('清单已复制'); }
    catch (e) { toast('复制失败，请长按选择'); }
    document.body.removeChild(ta);
  }

  function boughtToPantry() {
    var checked = S.state.checklistChecked || [];
    if (!checked.length) { toast('还没有勾选已买的'); return; }
    checked.forEach(function (id) {
      if (S.state.pantry.items.indexOf(id) === -1) S.state.pantry.items.push(id);
    });
    S.state.pantry.updatedAt = new Date().toISOString();
    S.state.pantry.updatedBy = me();
    var n = checked.length;
    S.state.checklistChecked = [];
    save();
    toast('已把 ' + n + ' 样加入「家里有」');
  }

  function doExport() {
    var data = JSON.parse(JSON.stringify(S.state));
    data.exportedAt = new Date().toISOString();
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '待会吃什么-备份-' + today() + '.json';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    S.state.settings.lastBackupAt = new Date().toISOString();
    save();
    toast('已导出备份');
  }

  function doImport() {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = function () {
      var f = input.files && input.files[0];
      if (!f) return;
      var rd = new FileReader();
      rd.onload = function () {
        var obj = null;
        try {
          obj = JSON.parse(rd.result);
          if (!obj || !obj.members) throw new Error('缺 members');
        } catch (e) {
          toast('文件格式不正确，请选择「待会吃什么」导出的备份文件');
          return;
        }
        // 二次确认用内联层
        askConfirm({
          title: '导入备份',
          body: '导入将覆盖当前全部数据，确定继续？',
          okLabel: '导 入',
          danger: true,
          onOk: function () {
            S.state = migrate(obj);
            save();
            S.view = null; S.tab = 'today';
            render();
            toast('导入成功');
          }
        });
      };
      rd.readAsText(f);
    };
    input.click();
  }

  function doClear() {
    // 清空是破坏性操作，保留两级确认（原来靠两个 confirm，现在都是内联层）
    askConfirm({
      title: '清空所有数据',
      body: '清空后所有菜单、历史、忌口设置都会删除，且无法恢复。\n\n确定要继续吗？',
      okLabel: '继 续',
      danger: true,
      onOk: function () {
        // 第二级
        S._confirm = null;
        askConfirm({
          title: '再确认一次',
          body: '真的要清空所有数据吗？',
          okLabel: '确认清空',
          danger: true,
          onOk: function () {
            S.state = C.defaultState();
            save();
            S._confirm = null;
            S.view = null; S.tab = 'today';
            render();
            toast('已清空');
          }
        });
      }
    });
  }

  /**
   * 成员档案编辑器（内联页，替代原来「名字 → 头像 → 忌口 → 过敏原」四连 prompt）。
   * 原来四个 prompt 串在一个回调链里，任一被拦（返回 null）整条链就断，什么都存不下。
   */
  function renderMemberEdit() {
    var key = S._memberEditKey;
    var m = (S.state.members || {})[key] || {};
    var d = S._memberDraft || { name: '', emoji: '🙂', dislikes: '', allergies: '' };
    var EMOJIS = ['🙂','🌸','🐱','🐻','🍀','⭐','🌙','🍎','🐧','🐰','🌿','☀️'];

    var h = '';
    h += '<div class="bar"><div class="back" data-act="member-edit-back">←</div><div>' +
         '<div class="ttl">编辑资料</div>' +
         '<div class="sub2">' + (key === S.state.me ? '这台手机的使用者' : '对方') + '</div></div></div>';

    h += '<div class="card"><div class="cbody"><div class="chead"><span class="nm">名字</span></div>';
    h += '<div class="frow"><span class="fl">叫法</span>' +
         '<input class="input" style="margin-left:auto;width:170px" data-member-field="name" ' +
         'maxlength="6" value="' + esc(d.name) + '" placeholder="1–6 个字"></div>';
    h += '</div></div>';

    h += '<div class="card"><div class="cbody"><div class="chead"><span class="nm">头像</span></div>';
    h += '<div class="emogrid" style="width:100%;grid-template-columns:repeat(6,1fr)">' +
         EMOJIS.map(function (e) {
           return '<span class="emo' + (d.emoji === e ? ' on' : '') + '" data-member-emoji="' + e + '">' + e + '</span>';
         }).join('') + '</div>';
    h += '</div></div>';

    h += '<div class="card"><div class="cbody"><div class="chead"><span class="nm">忌口与过敏</span>' +
         '<span class="mt">按食材填</span></div>';
    h += '<div class="note-mini" style="padding:0 0 9px">点下面的按钮从食材库里选，比手打名字可靠。</div>';
    h += '<div class="frow" style="align-items:flex-start;flex-direction:column;gap:9px">' +
         '<span class="fl" style="flex:none">🙅 不吃</span>' +
         memberChips(d.dislikes, 'dislikes', '不吃') + '</div>';
    h += '<div class="frow" style="align-items:flex-start;flex-direction:column;gap:9px">' +
         '<span class="fl" style="flex:none">🚨 过敏</span>' +
         memberChips(d.allergies, 'allergies', '过敏') + '</div>';
    h += '</div></div>';

    h += '<div class="note-mini">忌口和过敏的菜不会出现在随机结果里。过敏永远过滤，不吃可以临时放宽。</div>';

    h += '<div class="btn-main" data-act="member-edit-save">保 存</div>';
    h += '<div class="btn-sub" data-act="member-edit-back">取消</div>';
    return h;
  }

  // 已选的忌口/过敏食材 chips + 「添加」按钮
  function memberChips(csv, field, label) {
    var ids = String(csv || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    var h = '<span class="chips">';
    ids.forEach(function (id) {
      var g = S.ingIndex.byId[id];
      h += '<span class="chip on" data-member-del="' + field + ':' + esc(id) + '">' +
           esc(g ? g.name : id) + ' ✕</span>';
    });
    h += '<span class="chip" data-act="member-add" data-field="' + field + '">＋ 添加</span>';
    h += '</span>';
    return h;
  }

  function saveMemberEdit() {
    var key = S._memberEditKey;
    var d = S._memberDraft;
    if (!key || !d) return;
    var m = S.state.members[key];
    if (!m) return;
    var name = String(d.name || '').trim();
    if (!name) { toast('名字不能为空'); return; }
    m.name = name;
    m.emoji = d.emoji || m.emoji;
    m.dislikes = String(d.dislikes || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    m.allergies = String(d.allergies || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    save();
    S._memberDraft = null; S._memberEditKey = null;
    S.view = null; S.tab = 'me';
    render();
    toast('已保存');
  }

  /**
   * 通用内联确认层（替代 confirm）。
   * confirm 在 WebView/内置浏览器里会被静默拦截（返回 null 且不显示），
   * 用它的破坏性操作（清空、导入、删除）会变成「点了没反应」。
   * 用法：askConfirm({ title, body, okLabel, danger, onOk })
   */
  function askConfirm(opts) {
    opts = opts || {};
    S._confirm = {
      title: opts.title || '确定吗？',
      body: opts.body || '',
      okLabel: opts.okLabel || '确 定',
      cancelLabel: opts.cancelLabel || '取消',
      danger: !!opts.danger,
      onOk: opts.onOk || null,
      back: S.view ? { name: S.view.name, params: S.view.params } : null
    };
    S.view = { name: 'confirm' };
    render();
  }

  function renderConfirm() {
    var c = S._confirm || { title: '', body: '', okLabel: '确 定' };
    var h = '';
    h += '<div class="sheet-top"><div class="grip"></div>' +
         '<div class="st">' + esc(c.title) + '</div></div>';
    if (c.body) {
      h += '<div class="note-mini" style="text-align:center;font-size:12px;color:#111;line-height:1.9">' +
           c.body.split('\n').map(esc).join('<br>') + '</div>';
    }
    h += '<div class="' + (c.danger ? 'btn-danger' : 'btn-main') + '" data-act="confirm-ok">' +
         esc(c.okLabel) + '</div>';
    h += '<div class="btn-sub" data-act="confirm-cancel">' + esc(c.cancelLabel) + '</div>';
    return sheet(h);
  }

  function saveRecipeForm() {
    var draft = S._draft || {};
    var isNew = !S.view.params.id;
    var id = S.view.params.id;
    if (isNew) {
      if (!draft.name) { toast('请填写菜名'); return; }
      if (!draft.ingredients || !draft.ingredients.length) { toast('至少添加 1 个食材'); return; }
      var nid = 'my' + Date.now();
      S.state.customRecipes.push({
        id: nid, name: draft.name, emoji: draft.emoji || '🍽',
        meals: draft.meals || ['dinner'], role: draft.role || 'main',
        minutes: draft.minutes || 20, cost: draft.cost || 1,
        difficulty: draft.difficulty || 1, spicy: draft.spicy || 0,
        healthy: draft.healthy || 4, tools: draft.tools || ['wok'],
        tags: draft.tags || [], ingredients: draft.ingredients,
        tip: draft.tip || ''
      });
      S._draft = null;
      save();
      toast('菜品已创建');
      S.view = { name: 'recipe', params: { id: nid } };
      render();
    } else {
      var r = recipe(id);
      if (!r) return;
      if (r.builtin) {
        var ov = S.state.recipeOverrides[id] || {};
        for (var k in draft) if (Object.prototype.hasOwnProperty.call(draft, k)) ov[k] = draft[k];
        S.state.recipeOverrides[id] = ov;
      } else {
        var target = S.state.customRecipes.filter(function (x) { return x.id === id; })[0];
        if (target) for (var k2 in draft) if (Object.prototype.hasOwnProperty.call(draft, k2)) target[k2] = draft[k2];
      }
      S._draft = null;
      save();
      toast('已保存');
      S.view = { name: 'recipe', params: { id: id } };
      render();
    }
  }

  function resetRecipe(id) {
    askConfirm({
      title: '恢复默认',
      body: '恢复成内置菜的原样？你做的修改会丢失。',
      okLabel: '恢 复',
      danger: true,
      onOk: function () {
        delete S.state.recipeOverrides[id];
        save();
        S._confirm = null;
        S.view = { name: 'recipe', params: { id: id } };
        render();
        toast('已恢复默认');
      }
    });
  }

  function deleteRecipe(id) {
    var r = recipe(id);
    if (!r) return;
    var times = (S.state.doneLog || []).filter(function (x) { return x.recipeId === id; }).length;
    askConfirm({
      title: '删除「' + r.name + '」？',
      body: (times ? '这道菜的 ' + times + ' 次历史记录会一并删除，' : '') + '无法恢复。',
      okLabel: '删 除',
      danger: true,
      onOk: function () {
        doRemoveRecipe(id);
        S._confirm = null;
        S.view = null; S.tab = 'library';
        render();
        toast('已删除「' + r.name + '」');
      }
    });
  }

  /**
   * 真正把一道菜从菜库里去掉（内置菜和自定义菜都支持）。
   *
   * 内置菜来自 recipes.json，删不掉源文件，所以记进 state.removedRecipes，
   * core.allRecipes() 会按这张名单把它们过滤掉。
   * 自定义菜直接从 customRecipes 里移除，同时也记一笔（免得它出现在别处的旧数据里）。
   *
   * 返回一份快照，供「撤销」把这道菜连历史一起放回去。
   */
  var _lastRemoval = null;

  function doRemoveRecipe(id) {
    if (!id) return null;
    if (!S.state.removedRecipes) S.state.removedRecipes = [];
    // 快照：撤销时要用。删掉的东西不止菜本身 —— 历史记录和"今晚菜单"
    // 里相关联的条目也一起清了，所以必须把它们也存下来才能真的还原。
    var snap = {
      id: id,
      custom: (S.state.customRecipes || []).filter(function (x) { return x.id === id; }),
      doneLog: (S.state.doneLog || []).filter(function (x) { return x.recipeId === id; }),
      tonight: (S.state.tonight || []).filter(function (x) { return x.recipeId === id; }),
      candidates: (S.state.session && S.state.session.candidates)
        ? S.state.session.candidates.slice() : null
    };
    _lastRemoval = snap;

    if (S.state.removedRecipes.indexOf(id) === -1) S.state.removedRecipes.push(id);
    S.state.customRecipes = (S.state.customRecipes || []).filter(function (x) { return x.id !== id; });
    S.state.doneLog = (S.state.doneLog || []).filter(function (x) { return x.recipeId !== id; });
    S.state.tonight = (S.state.tonight || []).filter(function (x) { return x.recipeId !== id; });
    if (S.state.session && S.state.session.candidates) {
      S.state.session.candidates = S.state.session.candidates.filter(function (x) { return x !== id; });
    }
    save();
    return snap;
  }

  /** 撤销一次删除：把菜、历史记录、今晚菜单一起放回去。 */
  function undoRemoveRecipe(id) {
    if (!id) return;
    S.state.removedRecipes = (S.state.removedRecipes || []).filter(function (x) { return x !== id; });
    var snap = (_lastRemoval && _lastRemoval.id === id) ? _lastRemoval : null;
    if (snap) {
      // 自定义菜放回 customRecipes
      if (snap.custom && snap.custom.length) {
        S.state.customRecipes = (S.state.customRecipes || []).concat(snap.custom);
      }
      // 历史记录和今晚菜单按原样并回去
      if (snap.doneLog && snap.doneLog.length) {
        S.state.doneLog = (S.state.doneLog || []).concat(snap.doneLog);
      }
      if (snap.tonight && snap.tonight.length) {
        S.state.tonight = (S.state.tonight || []).concat(snap.tonight);
      }
      // 投票候选恢复原顺序
      if (snap.candidates && S.state.session) {
        S.state.session.candidates = snap.candidates;
      }
      _lastRemoval = null;
    }
    save();
  }

  /* ---------- 启动 ---------- */
  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    if (location.protocol === 'file:') return;

    // 新版本装好后自动重载一次，让用户立刻用上新的。
    // 否则用户会一直跑旧代码，报的 bug 其实早就修好了（这坑踩过好几次）。
    // 但正打字的时候不能刷，会把人正在输入的内容冲掉。
    var reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (reloading) return;
      var ae = document.activeElement;
      var typing = ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA');
      var sheetOpen = !!document.querySelector('.sheet-host .sheet');
      if (typing || sheetOpen) return;   // 让用户先把这一步做完
      reloading = true;
      location.reload();
    });

    // boot() 可能在 load 之后才跑，所以不能无条件等 load 事件
    function doRegister() {
      navigator.serviceWorker.register('sw.js').then(function (reg) {
        // 每次打开都查一下有没有新版
        reg.update().catch(function () {});
        reg.addEventListener('updatefound', function () {
          var sw = reg.installing;
          if (!sw) return;
          sw.addEventListener('statechange', function () {
            // installed + 已有 controller = 这是更新（不是首次安装）
            if (sw.state === 'installed' && navigator.serviceWorker.controller) {
              // 让新 SW 立刻接管，上面的 controllerchange 会负责重载
              sw.postMessage('skipWaiting');
            }
          });
        });
      }).catch(function (e) {
        console.warn('SW 注册失败（离线功能不可用）', e);
      });
    }
    if (document.readyState === 'complete') doRegister();
    else window.addEventListener('load', doRegister);
  }

  /* 禁掉双指捏合缩放。
     加进主屏后如果还能捏小，露出的就是白色背景，看着像网页而不是 App。
     viewport 里的 user-scalable=no 在 iOS 上基本被忽略，所以这层拦截才算数：
       - gesturestart / gesturechange / gestureend 是 iOS Safari 专有事件
       - touchmove 里判断多指兜底（某些 WebView 不发 gesture 事件）
     注意两件事：
       1. 双击放大交给 CSS 的 touch-action:manipulation，**不能**在 touchend 里
          preventDefault —— 那会把后续 click 一起吃掉，所有按钮都点不动。
       2. iOS「辅助功能 → 缩放」的三指手势是系统级，网页拦不住也不该拦。 */
  function lockZoom() {
    ['gesturestart', 'gesturechange', 'gestureend'].forEach(function (ev) {
      document.addEventListener(ev, function (e) { e.preventDefault(); }, { passive: false });
    });
    // 多指触摸时直接不让它走（单指照常滚动，别误伤）
    document.addEventListener('touchmove', function (e) {
      if (e.touches && e.touches.length > 1) e.preventDefault();
    }, { passive: false });
  }

  function boot() {
    Promise.all([
      fetch('data/ingredients.json').then(function (r) { return r.json(); }),
      fetch('data/recipes.json').then(function (r) { return r.json(); })
    ]).then(function (res) {
      S.ingredients = res[0].ingredients;
      S.recipes = res[1].recipes;
      S.ingIndex = C.buildIngredientIndex(S.ingredients);
      S.recipes.forEach(function (r) { S.recipeById[r.id] = r; });
      load();
      cleanupTonight();
      render();
      document.addEventListener('click', onClick);
      // 食材搜索用真实 input 元素（prompt 会被部分浏览器拦掉）
      document.addEventListener('input', function (e) {
        var t = e.target;
        if (t && t.dataset) {
          if (t.dataset.ingInput) onIngInput(t.value);
          if (t.dataset.pantryInput) onPantryInput(t.value);
          // 成员档案编辑页的名字输入：写回草稿，不重渲染（避免输入时失焦）
          if (t.dataset.memberField === 'name' && S._memberDraft) {
            S._memberDraft.name = t.value;
          }
        }
      });
      // 中文输入法拼字期间不要碰 input.value / 不要重画那些区块之外的东西。
      // 拼字中重画列表会把候选词打断，用户感觉就是"打不了字"。
      document.addEventListener('compositionstart', function (e) {
        if (e.target && e.target.dataset && e.target.dataset.ingInput) ingComposing = true;
        if (e.target && e.target.dataset && e.target.dataset.pantryInput) pantryComposing = true;
      });
      document.addEventListener('compositionend', function (e) {
        if (e.target && e.target.dataset && e.target.dataset.ingInput) {
          ingComposing = false;
          onIngInput(e.target.value);
        }
        if (e.target && e.target.dataset && e.target.dataset.pantryInput) {
          pantryComposing = false;
          onPantryInput(e.target.value);
        }
      });
      // 回车收起键盘（食材页那个搜索框也一样）
      document.addEventListener('keydown', function (e) {
        var t = e.target;
        if (t && t.dataset && (t.dataset.ingInput || t.dataset.pantryInput) && e.key === 'Enter') {
          e.preventDefault();
          t.blur();
        }
      });
      registerSW();

      // ---- 滑动手势：子页面右滑返回 + 菜库卡片左滑删除 ----
      // pointerdown 记起点、pointermove 判定方向、pointerup 收尾。
      // 用捕获阶段监听，保证在滚动容器的默认行为之前拿到事件。
      document.addEventListener('pointerdown', onPageSwipeStart, true);
      document.addEventListener('pointermove', onPageSwipeMove, { capture: true, passive: false });
      document.addEventListener('pointerup', onPageSwipeEnd, true);
      document.addEventListener('pointercancel', onPageSwipeEnd, true);

      document.addEventListener('pointerdown', onCardSwipeStart, true);
      document.addEventListener('pointermove', onCardSwipeMove, { capture: true, passive: false });
      document.addEventListener('pointerup', onCardSwipeEnd, true);
      document.addEventListener('pointercancel', onCardSwipeEnd, true);

      // 视口变化（横竖屏切换、桌面端拉伸）后胶囊必须重新量尺寸对齐
      var reflowT = null;
      function onResize() {
        clearTimeout(reflowT);
        reflowT = setTimeout(function () { syncNavPill(false); }, 80);
      }
      window.addEventListener('resize', onResize);
      window.addEventListener('orientationchange', onResize);
      // 导航节点是 render() 里懒创建的，由那边的 ResizeObserver 兜底尺寸变化

      // 同步：启动时拉一次，并在页面重新可见时刷新
      S.syncReady = true;
      if (syncOn()) {
        doPull({ silent: true }).then(function () {
          var sess = S.state.session;
          if (sess && sess.mySubmittedAt && !sess.partnerVote) {
            checkPartnerVote({ silent: true });
            startPolling();
          }
        });
      }
      document.addEventListener('visibilitychange', onVisible);
      window.addEventListener('beforeunload', function () {
        // 关页面前尽量把改动推上去
        if (syncOn() && !syncBusy) doPush({ silent: true });
      });
    }).catch(function (e) {
      document.getElementById('app').innerHTML =
        '<div style="padding:40px;text-align:center;font-family:sans-serif">' +
        '<div style="font-size:15px;font-weight:800;margin-bottom:10px">数据加载失败</div>' +
        '<div style="font-size:12px;color:#888">' + esc(e.message) + '</div></div>';
    });
  }

  // 缩放锁要在页面一可交互就生效，不能等数据加载完（那时候用户已经在捏了）
  lockZoom();

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
