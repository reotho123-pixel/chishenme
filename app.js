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
    render();
    setTimeout(function () {
      if (S.toast && Date.now() - S.toast.at >= 2800) { S.toast = null; render(); }
    }, 3000);
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

  function navHTML(active) {
    var items = [['today', '今天'], ['library', '菜库'], ['pantry', '食材'], ['me', '我的']];
    return '<div class="nav-outer">' + items.map(function (it) {
      return '<div class="nav-i' + (it[0] === active ? ' on' : '') + '" data-tab="' + it[0] + '">' + it[1] + '</div>';
    }).join('') + '</div>';
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

    // 顶部：日期吊牌 + 问候 + 三心
    h += '<div class="top">';
    h += '<div class="tagdate"><div class="string"></div><div class="body">' +
         '<div class="hole"></div>' +
         '<div class="d1">' + (new Date().getMonth() + 1) + '月' + new Date().getDate() + '日</div>' +
         '<div class="d2">周' + ['日','一','二','三','四','五','六'][new Date().getDay()] + '</div>' +
         '</div></div>';
    h += '<div class="hi-wrap"><div class="hi">' + C.greeting() + '</div>' +
         '<div class="hearts3"><i>♥</i><i>♥</i><i>♥</i></div></div>';
    h += '</div>';

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
    h += '<div class="h2">' + condSummary(st.lastConditions) + '</div>';
    h += '<div class="bignum"><span class="n">' + poolCount(st.lastConditions) + '</span><span class="u">道可选</span></div>';
    h += '<div class="heart-arc"><i>♥</i><i>♥</i><i>♥</i><i>♥</i><i>♥</i></div>';
    h += '<div class="btn-main" data-act="random">开 始</div>';
    h += '<div class="hero-alt">' +
         '<div class="alt" data-act="pick-self">自己挑一道</div>' +
         '<div class="alt" data-act="find-by-pantry">按食材找菜</div>' +
         '</div>';
    h += '</div></div>';

    // 快捷方章
    h += '<div class="quick">';
    h += '<div class="qi pink" data-act="go-library"><span class="ic">📖</span><span class="lb">挑一道</span></div>';
    h += '<div class="qi grey" data-tab="pantry"><span class="ic">🧺</span><span class="lb">按食材</span></div>';
    var shop = C.buildShoppingList(menu, st, S.ingIndex, S.recipeById);
    h += '<div class="qi pink" data-act="go-shopping"><span class="ic">📝</span><span class="lb">采购清单</span>' +
         (shop.total ? '<span class="dot">' + shop.total + '</span>' : '') + '</div>';
    h += '<div class="qi black" data-act="go-recent"><span class="ic">🕘</span><span class="lb">最近做过</span></div>';
    h += '</div>';

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

  function condSummary(c) {
    var parts = [];
    if (c.maxMinutes) parts.push(c.maxMinutes + ' 分钟内');
    parts.push('不辣');
    if (c.excludeDays) parts.push('排除最近 ' + c.excludeDays + ' 天');
    return parts.slice(0, 3).join(' · ');
  }

  function poolCount(c) {
    var p = C.buildPool(c, S.recipes, S.state, S.ingIndex, { today: today() });
    return p.afterDietCount;
  }

  function renderRandomSheet(expanded) {
    var c = S.state.lastConditions;
    var p = C.buildPool(c, S.recipes, S.state, S.ingIndex, { today: today() });
    var h = '';
    if (!expanded) {
      h += '<div class="sheet-top"><div class="grip"></div><div class="st">随机选菜</div></div>';
      h += '<div class="card plain"><div class="cbg"></div><div class="cbody" data-act="expand-cond" style="padding:13px 14px">' +
           '<div style="display:flex;align-items:center;gap:9px"><div style="flex:1">' +
           '<div style="font-size:12.5px;font-weight:900;color:#111;line-height:1.6">' + condSummary(c) + '</div>' +
           '<div style="font-size:10.5px;font-weight:700;color:#8A8A8A;margin-top:4px">点这行可以调详细条件</div>' +
           '</div><span style="font-size:15px;color:#111">⌄</span></div></div></div>';
      h += '<div class="feedback"><span class="fn">' + p.afterDietCount + '</span><div>' +
           '<div class="ft">道菜符合条件</div><div class="fs">' +
           (p.afterDietCount >= c.count ? '够抽 ' + c.count + ' 道' : '抽不满 ' + c.count + ' 道') +
           '</div></div></div>';
      if (p.notes.length) {
        h += '<div class="note-mini">' + p.notes.map(function (n) { return esc(n.text); }).join('<br>') + '</div>';
      }
      h += '<div class="btn-main" data-act="do-draw">🎲 抽 ' + c.count + ' 道</div>';
      h += '<div class="btn-sub" data-act="expand-cond">调整条件 ⌄</div>';
    } else {
      h += '<div class="sheet-top"><div class="grip"></div><div class="st">调整条件</div></div>';
      h += condPanel(c, p);
      h += '<div class="feedback"><span class="fn">' + p.afterDietCount + '</span><div>' +
           '<div class="ft">道菜符合条件</div><div class="fs">' +
           (p.afterDietCount >= c.count ? '够抽 ' + c.count + ' 道' : '抽不满 ' + c.count + ' 道，建议放宽条件') +
           '</div></div></div>';
      h += '<div class="btn-main" data-act="do-draw">🎲 抽 ' + c.count + ' 道</div>';
      h += '<div class="btn-sub" data-act="save-default">保存为默认</div>';
    }
    return sheet(h);
  }

  function condPanel(c, p) {
    function pills(field, opts, multi) {
      return '<span class="pills">' + opts.map(function (o) {
        var on = multi ? (c[field] || []).indexOf(o.v) !== -1 : c[field] === o.v;
        return '<span class="pill' + (on ? ' on' : '') + '" data-cond="' + field + '" data-val="' + o.v + '" data-multi="' + (multi ? 1 : 0) + '">' + o.t + '</span>';
      }).join('') + '</span>';
    }
    function sw(field, label) {
      return '<div class="frow"><span class="fl">' + label + '</span>' +
             '<span class="sw' + (c[field] ? ' on' : '') + '" style="margin-left:auto" data-cond-sw="' + field + '"><i></i></span></div>';
    }
    var h = '';
    h += '<div class="card"><div class="cbody"><div class="chead"><span class="nm">吃什么</span></div>';
    h += '<div class="frow" style="align-items:flex-start;flex-direction:column;gap:9px"><span class="fl" style="flex:none">餐次</span>' +
         pills('meal', [{v:'auto',t:'自动'},{v:'breakfast',t:'早'},{v:'lunch',t:'午'},{v:'dinner',t:'晚'}], false) + '</div>';
    h += '<div class="frow" style="align-items:flex-start;flex-direction:column;gap:9px"><span class="fl" style="flex:none">角色（可多选）</span>' +
         pills('roles', [{v:'main',t:'主菜'},{v:'side',t:'配菜'},{v:'staple',t:'主食'},{v:'breakfast',t:'早餐'}], true) + '</div>';
    h += '</div></div>';

    h += '<div class="card"><div class="cbody"><div class="chead"><span class="nm">限制</span></div>';
    h += '<div class="frow" style="align-items:flex-start;flex-direction:column;gap:9px"><span class="fl" style="flex:none">我家有的器具</span>' +
         pills('tools', [{v:'wok',t:'锅'},{v:'steamer',t:'蒸笼'},{v:'airfryer',t:'空气炸锅'},{v:'ricecooker',t:'电饭煲'}], true) + '</div>';
    h += '<div class="frow" style="align-items:flex-start;flex-direction:column;gap:9px"><span class="fl" style="flex:none">耗时上限</span>' +
         pills('maxMinutes', [{v:15,t:'15 分'},{v:30,t:'30 分'},{v:45,t:'45 分'},{v:0,t:'不限'}], false) + '</div>';
    h += sw('cheapOnly', '只看便宜的');
    h += sw('easyOnly', '只要简单的');
    h += sw('healthyFirst', '健康优先');
    h += '</div></div>';

    h += '<div class="card"><div class="cbody"><div class="chead"><span class="nm">去重与范围</span></div>';
    h += '<div class="frow" style="align-items:flex-start;flex-direction:column;gap:9px"><span class="fl" style="flex:none">排除最近做过</span>' +
         pills('excludeDays', [{v:3,t:'3 天'},{v:7,t:'7 天'},{v:14,t:'14 天'},{v:0,t:'不排除'}], false) + '</div>';
    h += sw('pantryOnly', '只用家里有的');
    h += '<div class="frow"><span class="fl">关键词</span>' +
         '<span class="input sm' + (c.keyword ? '' : ' ph') + '" style="margin-left:auto;width:150px" data-cond-input="keyword">' +
         (c.keyword ? esc(c.keyword) : '如「鸡」') + '</span></div>';
    h += '<div class="frow" style="align-items:flex-start;flex-direction:column;gap:9px"><span class="fl" style="flex:none">候选数量</span>' +
         pills('count', [{v:3,t:'3'},{v:4,t:'4'},{v:5,t:'5'}], false) + '</div>';
    h += '</div></div>';
    return h;
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
    for (var i = 0; i < shown.length; i++) {
      var r = shown[i];
      var conf = C.recipeConflicts(r, S.state, S.ingIndex);
      var last = C.lastDoneDate(r.id, S.state);
      h += '<div class="rrow"' + (conf.length ? ' style="opacity:.55"' : '') + ' data-act="open-recipe" data-id="' + r.id + '">' +
           '<span class="b">' + r.emoji + '</span><div class="tx">' +
           '<div class="n1">' + esc(r.name) + (r.builtin ? '' : ' <span style="font-size:10px;color:#8A8A8A">自定义</span>') + '</div>' +
           '<div class="n2">' + metaLine(r) + (conf.length ? ' · <span style="color:#B33A16">' + esc(confReason(conf)) + '</span>' : '') + '</div>' +
           '<div class="dots5">' + dots5(r.healthy) + '</div></div>' +
           (last ? '<span class="was">' + C.fmtRelativeDate(last) + '做过</span>' : '') +
           '</div>';
    }
    if (!shown.length) {
      h += '<div class="card plain"><div class="cbg"></div><div class="cbody" style="text-align:center;padding:20px">' +
           '<div style="font-size:13px;font-weight:800;color:#111">没有符合条件的菜</div></div></div>';
    }
    if (hiddenCount) {
      h += '<div class="btn-sub" data-act="toggle-blocked">' +
           (S.view.params && S.view.params.showBlocked ? '隐藏忌口冲突的菜' : '显示被隐藏的 ' + hiddenCount + ' 道') + '</div>';
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
    var last = C.lastDoneDate(r.id, S.state);
    var times = (S.state.doneLog || []).filter(function (x) { return x.recipeId === r.id; }).length;

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

    // 标签
    if (r.tags && r.tags.length) {
      h += '<div class="chips" style="margin-top:2px">' + r.tags.map(function (t) {
        return '<span class="chip">' + esc(t) + '</span>';
      }).join('') + '</div>';
    }

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

    if (r.tip) {
      h += '<div class="tipbox"><b>小提示</b><br>' + esc(r.tip) + '</div>';
    }

    h += '<div class="srow"><span class="si">🕘</span><div>' +
         '<div class="sn">' + (times ? '做过 ' + times + ' 次' : '还没做过') + '</div>' +
         '<div class="sd">' + (last ? '上次是 ' + C.fmtRelativeDate(last) : '第一次做的话，加油') + '</div>' +
         '</div></div>';

    if (tonightActive().length < 3 && !tonightActive().some(function (x) { return x.recipeId === r.id; })) {
      h += '<div class="btn-main" data-act="decide" data-id="' + r.id + '">今 晚 就 做 它</div>';
    } else if (tonightActive().some(function (x) { return x.recipeId === r.id; })) {
      h += '<div class="btn-sub" style="opacity:.6">已在今晚菜单里</div>';
    } else {
      h += '<div class="btn-sub" style="opacity:.6">今晚菜单已满（3 道）</div>';
    }

    h += '<div class="ops" style="gap:10px">';
    h += '<span style="flex:1;text-align:center;padding:11px 0" data-act="add-shopping" data-id="' + r.id + '">加进清单</span>';
    h += '<span style="flex:1;text-align:center;padding:11px 0" data-act="edit-recipe" data-id="' + r.id + '">编辑</span>';
    h += '</div>';
    h += navHTML('library');
    return h;
  }

  /* ---------- 渲染：P8 菜品编辑 ---------- */

  function renderRecipeForm() {
    var id = S.view.params.id;
    var r = id ? recipe(id) : null;
    var isNew = !r;
    var EMOJIS = ['🍅','🥦','🥒','🍳','🍜','🍚','🥘','🍲','🥗','🍗','🥩','🐟','🦐','🥚','🍆','🥕','🌽','🥔','🍄','🥬','🍤','🍞','🥟','🍛','🍝','🍢','🍣','🍱','🥞','🧇','🥪','🌮','🌯','🥙','🍕','🍔','🍟','🧀','🍠','🎃'];
    var cur = r || { name: '', emoji: '🍽', meals: ['dinner'], role: 'main', minutes: 20, cost: 1, difficulty: 1, spicy: 0, healthy: 4, tools: ['wok'], tags: [], ingredients: [], tip: '' };

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

    h += '<div class="card"><div class="cbody"><div class="chead"><span class="nm">分类与规格</span></div>';
    h += '<div class="frow" style="align-items:flex-start;flex-direction:column;gap:9px"><span class="fl" style="flex:none">餐次</span>' +
         '<span class="pills">' + [['breakfast','早'],['lunch','午'],['dinner','晚']].map(function (m) {
           return '<span class="pill' + (cur.meals.indexOf(m[0]) !== -1 ? ' on' : '') + '" data-form-meal="' + m[0] + '">' + m[1] + '</span>';
         }).join('') + '</span></div>';
    h += '<div class="frow" style="align-items:flex-start;flex-direction:column;gap:9px"><span class="fl" style="flex:none">角色</span>' +
         '<span class="pills">' + [['main','主菜'],['side','配菜'],['staple','主食'],['breakfast','早餐']].map(function (m) {
           return '<span class="pill' + (cur.role === m[0] ? ' on' : '') + '" data-form-role="' + m[0] + '">' + m[1] + '</span>';
         }).join('') + '</span></div>';
    h += '<div class="frow" style="align-items:flex-start;flex-direction:column;gap:9px"><span class="fl" style="flex:none">器具</span>' +
         '<span class="pills">' + [['wok','锅'],['steamer','蒸笼'],['airfryer','空气炸锅'],['ricecooker','电饭煲']].map(function (m) {
           var on = cur.tools.indexOf(m[0]) !== -1;
           return '<span class="pill' + (on ? ' on' : ' dis') + '" data-form-tool="' + m[0] + '">' + m[1] + '</span>';
         }).join('') + '</span></div>';
    h += '<div class="frow"><span class="fl">耗时</span>' +
         '<span class="input sm" style="margin-left:auto;width:78px;text-align:center" data-form="minutes">' + cur.minutes + '</span>' +
         '<span style="font-size:11.5px;font-weight:700;color:#7A7A7A">分钟</span></div>';
    h += '<div class="frow" style="align-items:flex-start;flex-direction:column;gap:9px"><span class="fl" style="flex:none">成本</span>' +
         '<span class="pills">' + [[1,'¥ 便宜'],[2,'¥¥ 一般'],[3,'¥¥¥ 稍贵']].map(function (m) {
           return '<span class="pill' + (cur.cost === m[0] ? ' on' : '') + '" data-form-cost="' + m[0] + '">' + m[1] + '</span>';
         }).join('') + '</span></div>';
    h += '<div class="frow" style="align-items:flex-start;flex-direction:column;gap:9px"><span class="fl" style="flex:none">难度</span>' +
         '<span class="pills">' + [[1,'简单'],[2,'中等']].map(function (m) {
           return '<span class="pill' + (cur.difficulty === m[0] ? ' on' : '') + '" data-form-diff="' + m[0] + '">' + m[1] + '</span>';
         }).join('') + '</span></div>';
    h += '<div class="frow" style="align-items:flex-start;flex-direction:column;gap:9px"><span class="fl" style="flex:none">辣度</span>' +
         '<span class="pills">' + [[0,'不辣'],[1,'微辣'],[2,'辣'],[3,'很辣']].map(function (m) {
           return '<span class="pill' + (cur.spicy === m[0] ? ' on' : '') + '" data-form-spicy="' + m[0] + '">' + m[1] + '</span>';
         }).join('') + '</span></div>';
    h += '<div class="frow"><span class="fl">健康度</span>' +
         '<span class="dotpick" style="margin-left:auto">' + [1,2,3,4,5].map(function (n) {
           return '<i class="' + (n <= cur.healthy ? 'on' : '') + '" data-form-healthy="' + n + '"></i>';
         }).join('') + '</span></div>';
    h += '</div></div>';

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
    var pantry = st.pantry.items || [];
    var all = C.allRecipes(S.recipes, st);
    var canDo = [], missOne = [];
    for (var i = 0; i < all.length; i++) {
      var r = all[i];
      if (C.recipeConflicts(r, st, S.ingIndex).length) continue;
      var m = C.recipeMissing(r, st, S.ingIndex);
      if (m.canCook) canDo.push(r);
      else if (m.missing.length <= 2) missOne.push({ r: r, miss: m.missing });
    }
    var shop = C.buildShoppingList(tonightActive(), st, S.ingIndex, S.recipeById);
    var pct = Math.min(100, Math.round(pantry.length / 24 * 100));

    var h = '<div class="bar"><div><div class="ttl">食材</div>' +
            '<div class="sub2">' + (st.pantry.updatedAt ? '上次更新：' + C.fmtRelativeDate(st.pantry.updatedAt.slice(0,10)) + (st.pantry.updatedBy ? ' · ' + esc(memberName(st.pantry.updatedBy)) : '') : '还没勾选过') + '</div></div></div>';

    h += '<div class="card plain"><div class="cbg"></div><div class="cbody">' +
         '<div class="batt-wrap"><div class="batt"><div class="shell">' +
         '<div class="fill" style="width:' + Math.max(6, pct) + '%"></div></div><div class="cap"></div></div>' +
         '<div><div class="batt-lb">冰箱存货</div></div>' +
         '<div class="batt-num">' + pantry.length + ' 样</div></div></div></div>';

    h += '<div class="sec"><span class="t">家里现在有</span><span class="h">♡</span></div>';
    // 按分类列出常用食材；每类限量，避免一次铺满上百个 chip
    var common = S.ingredients.filter(function (g) { return !g.staple; });
    var byCat = {};
    common.forEach(function (g) {
      if (!byCat[g.category]) byCat[g.category] = [];
      byCat[g.category].push(g);
    });
    // 已勾选的排前面，方便确认
    Object.keys(byCat).forEach(function (cat) {
      byCat[cat].sort(function (x, y) {
        var ox = pantry.indexOf(x.id) !== -1 ? 0 : 1;
        var oy = pantry.indexOf(y.id) !== -1 ? 0 : 1;
        return ox - oy;
      });
    });
    var order = ['vegetable','protein','seafood','soy','staple','fruit','dry','condiment'];
    var PER_CAT = 8;
    var expanded = S.view && S.view.params && S.view.params.allPantry;
    h += '<div class="chips">';
    order.forEach(function (cat) {
      if (!byCat[cat]) return;
      var list = expanded ? byCat[cat] : byCat[cat].slice(0, PER_CAT);
      list.forEach(function (g) {
        var on = pantry.indexOf(g.id) !== -1;
        h += '<span class="chip' + (on ? ' on' : '') + '" data-pantry="' + g.id + '">' + esc(g.name) + '</span>';
      });
    });
    h += '</div>';
    if (!expanded) {
      var totalCommon = common.length;
      h += '<div class="btn-sub" data-act="expand-pantry">展开全部 ' + totalCommon + ' 种食材</div>';
    } else {
      h += '<div class="btn-sub" data-act="collapse-pantry">收起</div>';
    }

    // 能做这些菜
    var canDoLabel = pantry.length ? '能做这些菜' : '加点食材就能做';
    h += '<div class="sec" style="margin-top:6px"><span class="t">' + canDoLabel + '</span>' +
         (canDo.length || missOne.length ? '<span class="count-tag">' + (canDo.length + missOne.length) + ' 道</span>' : '') + '</div>';
    if (!pantry.length) {
      h += '<div class="note-mini">点亮上面的食材，这里就会列出你能做的菜。</div>';
    }

    for (var a = 0; a < Math.min(canDo.length, 8); a++) {
      var r1 = canDo[a];
      h += '<div class="cando"><span class="b">' + r1.emoji + '</span><div>' +
           '<div class="n">' + esc(r1.name) + '</div><div class="m">' + C.fmtMinutes(r1.minutes) + ' · 食材全齐</div></div>' +
           '<span class="go" data-act="decide" data-id="' + r1.id + '">做它</span></div>';
    }
    for (var b = 0; b < Math.min(missOne.length, 6); b++) {
      var mm = missOne[b];
      h += '<div class="cando miss"><span class="b">' + mm.r.emoji + '</span><div>' +
           '<div class="n">' + esc(mm.r.name) + '</div>' +
           '<div class="m">' + C.fmtMinutes(mm.r.minutes) + ' · <span class="lack">缺：' +
           esc(mm.miss.map(function (x) { return x.name; }).join('、')) + '</span></div></div>' +
           '<span class="go" data-act="open-recipe" data-id="' + mm.r.id + '">看看</span></div>';
    }
    if (!canDo.length && !missOne.length) {
      h += '<div class="note-mini">还没有勾选食材，或菜库太小。点上面的食材点亮家里有的。</div>';
    }

    // 采购清单入口（竖吊牌）
    h += '<div style="display:flex;gap:12px;align-items:stretch;margin-top:6px">';
    h += '<div class="vtag"><div class="s"></div><div class="b"><div class="h">♥</div>' +
         '<div class="l1">采购<br>清单</div><div class="l2">' + shop.total + ' 样</div></div></div>';
    h += '<div class="card plain" style="flex:1"><div class="cbg"></div>' +
         '<div class="cbody" style="display:flex;flex-direction:column;justify-content:center">' +
         '<div style="font-size:13.5px;font-weight:900;color:#111">' + (shop.total ? '还没买' : '清单是空的') + '</div>' +
         '<div style="font-size:11px;font-weight:700;color:#8A8A8A;margin-top:5px">' +
         (shop.total ? esc(shop.toBuy.slice(0, 3).map(function (x) { return x.name; }).join(' · ')) : '定好今晚的菜会自动列出') + '</div>' +
         '<div class="ops" style="margin-top:11px"><span class="pri" data-act="go-shopping">去看清单</span></div>' +
         '</div></div></div>';

    h += navHTML('pantry');
    return h;
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

    h += '<div class="sec" style="margin-top:2px"><span class="t">选菜偏好</span></div>';
    h += '<div class="srow" data-act="expand-cond"><span class="si">🎲</span><div>' +
         '<div class="sn">默认条件</div><div class="sd">' + condSummary(st.defaultConditions) + '</div></div><span class="sa">›</span></div>';
    h += '<div class="srow" data-act="edit-staple"><span class="si">🧂</span><div>' +
         '<div class="sn">常备调料</div><div class="sd">' + S.ingredients.filter(function (g) { return g.staple; }).length + ' 项 · 默认视为家里有</div></div><span class="sa">›</span></div>';

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

  function promptInput(label, cur, opts) {
    var v = prompt(label, cur || '');
    return v;
  }

  /* ---------- 同步：动作实现 ---------- */

  function doInputToken() {
    var cur = getToken();
    var v = prompt('粘贴 GitHub Access Token\n（fine-grained，只授权 chishenme-data，Contents: Read and write）', cur || '');
    if (v === null) return;
    v = v.trim();
    setToken(v);
    render();
    if (v) toast('Token 已保存，点「保存并测试连接」验证');
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
    if (!confirm('断开后这台手机不再同步，本机数据会保留。\n\n确定？')) return;
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

  /* ---------- 弹层包装 ---------- */
  function sheet(inner) {
    return '<div class="sheet-mask" data-act="close-sheet"><div class="sheet" data-stop="1">' + inner + '</div></div>';
  }

  /* ---------- 主渲染 ---------- */
  function render() {
    var app = document.getElementById('app');
    var h = '';
    if (S.view && S.view.name === 'vote') h = renderVote();
    else if (S.view && S.view.name === 'reveal') h = renderReveal();
    else if (S.view && S.view.name === 'recipe') h = renderRecipe();
    else if (S.view && S.view.name === 'recipeForm') h = renderRecipeForm();
    else if (S.view && S.view.name === 'shopping') h = renderShopping();
    else if (S.view && S.view.name === 'random') h = renderRandomSheet(!!S.view.params.expanded);
    else if (S.view && S.view.name === 'sync') h = renderSync();
    else if (S.tab === 'library') h = renderLibrary();
    else if (S.tab === 'pantry') h = renderPantry();
    else if (S.tab === 'me') h = renderMe();
    else h = renderToday();

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
    app.innerHTML = '<div class="phone"><div class="scr">' + h + '</div></div>';
  }

  /* ---------- 事件 ---------- */
  function onClick(e) {
    var t = e.target;
    // 找到最近的带 data-act 的元素
    var node = t;
    var act = null, data = {};
    while (node && node !== document.body) {
      if (node.dataset && node.dataset.act) {
        act = node.dataset.act;
        data = node.dataset;
        break;
      }
      // 投票按钮
      if (node.dataset && node.dataset.vote) {
        setVote(node.dataset.id, node.dataset.vote);
        return;
      }
      node = node.parentElement;
    }
    if (!act) {
      // tab 切换
      var tn = t;
      while (tn && tn !== document.body) {
        if (tn.dataset && tn.dataset.tab) { S.tab = tn.dataset.tab; S.view = null; render(); return; }
        if (tn.dataset && tn.dataset.cond) { setCond(tn.dataset.cond, tn.dataset.val, tn.dataset.multi === '1'); return; }
        if (tn.dataset && tn.dataset.condSw) { toggleCond(tn.dataset.condSw); return; }
        if (tn.dataset && tn.dataset.pantry) { togglePantry(tn.dataset.pantry); return; }
        if (tn.dataset && tn.dataset.check) { toggleCheck(tn.dataset.check); return; }
        tn = tn.parentElement;
      }
      return;
    }
    if (node.dataset && node.dataset.stop) { /* sheet 内部，不关 */ }

    switch (act) {
      case 'back': S.view = null; render(); break;
      case 'close-sheet': if (e.target === node) { S.view = null; render(); } break;
      case 'random':
        S.view = { name: 'random', params: { expanded: false } }; render(); break;
      case 'expand-cond':
        S.view = { name: 'random', params: { expanded: true } }; render(); break;
      case 'save-default':
        S.state.defaultConditions = JSON.parse(JSON.stringify(S.state.lastConditions));
        save(); toast('已保存为默认条件'); break;
      case 'do-draw': doDraw(); break;
      case 'pick-self':
        S.tab = 'library'; S.view = null; render(); toast('点任意菜即定今晚做'); break;
      case 'find-by-pantry':
        S.tab = 'pantry'; S.view = null; render(); break;
      case 'go-library': S.tab = 'library'; S.view = null; render(); break;
      case 'go-shopping': S.view = { name: 'shopping' }; render(); break;
      case 'go-recent': S.tab = 'me'; S.view = null; render(); break;
      case 'open-recipe': S.view = { name: 'recipe', params: { id: data.id } }; render(); break;
      case 'edit-recipe': S.view = { name: 'recipeForm', params: { id: data.id } }; render(); break;
      case 'new-recipe': S.view = { name: 'recipeForm', params: {} }; render(); break;
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
      case 'clear-search': S.view = null; S.tab = 'library'; render(); break;
      case 'focus-search': {
        var q = prompt('搜索菜名或食材', '');
        if (q !== null) { S.view = { name: 'library', params: { q: q } }; S.tab = 'library'; render(); }
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
      case 'sync-setup': S.view = { name: 'sync', params: {} }; render(); break;
      case 'sync-connect': doSyncConnect(); break;
      case 'sync-now': doPull().then(function () { return doPush(); }).then(function () { setSyncStatus('ok', '已同步'); }); break;
      case 'sync-disconnect': doSyncDisconnect(); break;
      case 'toggle-adv': S.view = { name: 'sync', params: { adv: !(S.view.params && S.view.params.adv) } }; render(); break;
      case 'input-token': doInputToken(); break;
      case 'input-owner': {
        var v1 = promptInput('GitHub 用户名', (S.state.settings.sync || {}).owner || '');
        if (v1 !== null && v1.trim()) {
          var sc1 = S.state.settings.sync || { enabled: false, repo: 'chishenme-data', branch: 'main' };
          sc1.owner = v1.trim(); saveSyncCfg(sc1);
        }
        render(); break;
      }
      case 'input-repo': {
        var v2 = promptInput('数据仓库名', (S.state.settings.sync || {}).repo || 'chishenme-data');
        if (v2 !== null && v2.trim()) {
          var sc2 = S.state.settings.sync || { enabled: false, owner: '', branch: 'main' };
          sc2.repo = v2.trim(); saveSyncCfg(sc2);
        }
        render(); break;
      }
      case 'input-branch': {
        var v3 = promptInput('分支', (S.state.settings.sync || {}).branch || 'main');
        if (v3 !== null && v3.trim()) {
          var sc3 = S.state.settings.sync || { enabled: false, owner: '', repo: 'chishenme-data' };
          sc3.branch = v3.trim(); saveSyncCfg(sc3);
        }
        render(); break;
      }
      case 'set-me': {
        S.state.me = data.id; save(); render();
        toast('这台手机是「' + memberName(data.id) + '」');
        break;
      }
      case 'edit-member': editMember(data.id); break;
      case 'edit-staple': toast('常备调料管理：下一版接入'); break;
      case 'toast-action': if (S.toast && S.toast.action) S.toast.action(); S.toast = null; render(); break;
      case 'save-recipe': saveRecipeForm(); break;
      case 'add-ing': addIngredientPrompt(); break;
      case 'reset-recipe': resetRecipe(data.id); break;
      case 'delete-recipe': deleteRecipe(data.id); break;
      default: break;
    }
  }

  /* ---------- 动作实现 ---------- */

  function setCond(field, val, multi) {
    var c = S.state.lastConditions;
    var numFields = { maxMinutes: 1, excludeDays: 1, count: 1 };
    if (multi) {
      var arr = c[field] || [];
      var v = String(val);
      var idx = arr.indexOf(v);
      if (idx === -1) arr.push(v); else arr.splice(idx, 1);
      c[field] = arr;
    } else {
      c[field] = numFields[field] ? Number(val) : val;
    }
    save();
    render();
  }

  function toggleCond(field) {
    var c = S.state.lastConditions;
    c[field] = !c[field];
    save();
    render();
  }

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
        try {
          var obj = JSON.parse(rd.result);
          if (!obj || !obj.members) throw new Error('缺 members');
          if (!confirm('导入将覆盖当前全部数据，确定继续？')) return;
          S.state = migrate(obj);
          save();
          toast('导入成功');
        } catch (e) {
          alert('文件格式不正确，请选择「待会吃什么」导出的备份文件');
        }
      };
      rd.readAsText(f);
    };
    input.click();
  }

  function doClear() {
    if (!confirm('清空后所有菜单、历史、忌口设置都会删除，且无法恢复。\n\n确定要继续吗？')) return;
    if (!confirm('再确认一次：真的要清空所有数据吗？')) return;
    S.state = C.defaultState();
    save();
    S.view = null; S.tab = 'today';
    toast('已清空');
  }

  function editMember(key) {
    var m = S.state.members[key];
    var name = prompt('名字', m.name);
    if (name === null) return;
    var emoji = prompt('头像 emoji（如 🙂 🌸 🐱 🐻 🍀 ⭐）', m.emoji || '🙂');
    if (emoji === null) return;
    var dislikes = prompt('忌口食材的 id，用逗号分隔\n（例：cilantro 香菜、bitter-melon 苦瓜）', (m.dislikes || []).join(','));
    if (dislikes === null) return;
    var allergies = prompt('过敏原，用逗号分隔\n（可选：egg 蛋 / crustacean 甲壳类 / oyster 蚝类 / clam 蛤类 / fish 鱼 / peanut 花生 / gluten 麸质 / dairy 奶 / soy 大豆 / sesame 芝麻）', (m.allergies || []).join(','));
    if (allergies === null) return;
    m.name = name.trim() || m.name;
    m.emoji = emoji.trim() || m.emoji;
    m.dislikes = dislikes.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    m.allergies = allergies.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    save();
    toast('已保存');
  }

  function addIngredientPrompt() {
    var id = prompt('食材 id（如 tomato 番茄 / egg 鸡蛋 / scallion 葱）\n可到「菜库」搜菜名查看用法', '');
    if (id === null) return;
    id = id.trim();
    if (!id) return;
    if (!S.ingIndex.byId[id]) { alert('没有这个食材 id。可用示例：tomato / egg / scallion / tofu / pork-mince / shiitake'); return; }
    var amount = prompt('用量（如 2 个 / 适量）', '适量');
    if (amount === null) return;
    S._formIngredients = S._formIngredients || null;
    // 直接把表单食材暂存在 state 里（简化处理：写入临时草稿）
    var draft = S._draft || (S._draft = {});
    draft.ingredients = draft.ingredients || [];
    draft.ingredients.push({ id: id, amount: amount.trim() || '适量' });
    toast('已添加 ' + S.ingIndex.byId[id].name);
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
    if (!confirm('恢复成内置菜的原样？你做的修改会丢失。')) return;
    delete S.state.recipeOverrides[id];
    save();
    toast('已恢复默认');
    render();
  }

  function deleteRecipe(id) {
    var r = recipe(id);
    if (!r) return;
    var times = (S.state.doneLog || []).filter(function (x) { return x.recipeId === id; }).length;
    if (!confirm('删除「' + r.name + '」？\n\n' + (times ? '这道菜的 ' + times + ' 次历史记录会一并删除，' : '') + '无法恢复。')) return;
    S.state.customRecipes = S.state.customRecipes.filter(function (x) { return x.id !== id; });
    S.state.doneLog = S.state.doneLog.filter(function (x) { return x.recipeId !== id; });
    S.state.tonight = S.state.tonight.filter(function (x) { return x.recipeId !== id; });
    save();
    toast('已删除');
    S.view = null; S.tab = 'library';
    render();
  }

  /* ---------- 启动 ---------- */
  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    if (location.protocol === 'file:') return;
    // boot() 可能在 load 之后才跑，所以不能无条件等 load 事件
    function doRegister() {
      navigator.serviceWorker.register('sw.js').then(function (reg) {
        reg.addEventListener('updatefound', function () {
          var sw = reg.installing;
          if (!sw) return;
          sw.addEventListener('statechange', function () {
            if (sw.state === 'installed' && navigator.serviceWorker.controller) {
              toast('有新版本了，下次打开生效');
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
      registerSW();

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

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
