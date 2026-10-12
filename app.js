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

  // 底部导航用标记包起来，render() 会把它抽出来放进固定的 nav-dock
  var NAV_MARK = '<!--__NAV__-->';

  // 弹层同理：抽出来放进固定的 .sheet-host。
  // 放在 .scr 里会被整页重渲染顺带重建 —— 那会打断打字、还会让入场动画重播（看起来"一直在跳"）。
  var SHEET_MARK = '<!--__SHEET__-->';

  // 中文输入法正在拼字。拼字期间不能去动 input.value，否则候选会被打断。
  var ingComposing = false;

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

    h += '<div class="sec"><span class="t">家里现在有</span><span class="h">♡</span>' +
         (pantry.length ? '<span class="count-tag">' + pantry.length + ' 样</span>' : '') + '</div>';

    // 搜索添加（主入口）
    h += '<div class="search" data-act="open-ing-picker">' +
         '<span class="mag">＋</span>' +
         '<span class="ph">搜索添加食材…</span>' +
         '<span class="st">🔍</span>' +
         '</div>';

    // 已添加的食材：直接列出，点一下即移除
    if (!pantry.length) {
      h += '<div class="note-mini" style="text-align:center;padding:12px 0">' +
           '还没添加食材。<br>点上面的搜索框，输入「番茄」「鸡蛋」就能加进来。</div>';
    } else {
      // 按分类分组展示已添加的，方便一眼扫过
      var haveByCat = {};
      pantry.forEach(function (id) {
        var g = S.ingIndex.byId[id];
        if (!g) return;
        if (!haveByCat[g.category]) haveByCat[g.category] = [];
        haveByCat[g.category].push(g);
      });
      var catOrder = ['vegetable','protein','seafood','soy','staple','fruit','dry','condiment','other'];
      h += '<div class="have-groups">';
      catOrder.forEach(function (cat) {
        var list = haveByCat[cat];
        if (!list || !list.length) return;
        h += '<div class="have-row">' +
             '<span class="have-cat">' + (C.CATEGORY_LABEL[cat] || '其他') + '</span>' +
             '<span class="chips" style="flex:1">' +
             list.map(function (g) {
               return '<span class="chip on" data-pantry="' + g.id + '" title="点一下移除">' + esc(g.name) + '</span>';
             }).join('') +
             '</span></div>';
      });
      h += '</div>';
      h += '<div class="note-mini" style="text-align:center">点食材可以移除</div>';
    }

    // 能做这些菜
    var canDoLabel = pantry.length ? '能做这些菜' : '加点食材就能做';
    h += '<div class="sec" style="margin-top:6px"><span class="t">' + canDoLabel + '</span>' +
         (canDo.length || missOne.length ? '<span class="count-tag">' + (canDo.length + missOne.length) + ' 道</span>' : '') + '</div>';
    if (!pantry.length) {
      h += '<div class="note-mini">上面添加食材后，这里会列出你能做的菜。</div>';
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
      h += '<div class="note-mini">上面添加食材后，这里会列出你能做的菜。</div>';
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
    h += '<div class="filters" data-pk="filters">' + pkFiltersInner(p) + '</div>';
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

  function toggleDraftMeal(m) {
    if (!S._draft) return;
    var arr = S._draft.meals || [];
    var i = arr.indexOf(m);
    if (i === -1) {
      arr.push(m);
    } else {
      if (arr.length === 1) { toast('至少留一个餐次'); return; }
      arr.splice(i, 1);
    }
    S._draft.meals = arr;
    render();
  }

  function toggleDraftTool(t) {
    if (!S._draft) return;
    var arr = S._draft.tools || [];
    var i = arr.indexOf(t);
    if (i === -1) arr.push(t); else arr.splice(i, 1);
    S._draft.tools = arr;
    render();
  }

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

  /* ---------- 主渲染 ---------- */
  /**
   * @param {boolean} animateNav 仅切换底部 Tab 时传 true；
   *   其余渲染（勾选、重绘、进二级页）都不该让胶囊"滑"，直接落位即可。
   */
  function render(animateNav) {
    var app = document.getElementById('app');
    var h = '';
    if (S.view && S.view.name === 'vote') h = renderVote();
    else if (S.view && S.view.name === 'reveal') h = renderReveal();
    else if (S.view && S.view.name === 'recipe') h = renderRecipe();
    else if (S.view && S.view.name === 'recipeForm') h = renderRecipeForm();
    else if (S.view && S.view.name === 'shopping') h = renderShopping();
    else if (S.view && S.view.name === 'random') h = renderRandomSheet(!!S.view.params.expanded);
    else if (S.view && S.view.name === 'sync') h = renderSync();
    else if (S.view && S.view.name === 'ingPicker') h = renderIngredientPicker(S._pick);
    else if (S.view && S.view.name === 'askInput') h = renderAskInput();
    else if (S.view && S.view.name === 'syncConfirm') h = renderSyncConfirm();
    else if (S.view && S.view.name === 'confirm') h = renderConfirm();
    else if (S.view && S.view.name === 'memberEdit') h = renderMemberEdit();
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
    scr.innerHTML = h;
    if (keepScroll > 0) scr.scrollTop = keepScroll;

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
        if (d.cond) { setCond(d.cond, d.val, d.multi === '1'); return; }
        if (d.condSw) { toggleCond(d.condSw); return; }
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
        if (d.formMeal) { toggleDraftMeal(d.formMeal); return; }
        if (d.formRole) { setDraft('role', d.formRole); return; }
        if (d.formTool) { toggleDraftTool(d.formTool); return; }
        if (d.formCost) { setDraft('cost', Number(d.formCost)); return; }
        if (d.formDiff) { setDraft('difficulty', Number(d.formDiff)); return; }
        if (d.formSpicy) { setDraft('spicy', Number(d.formSpicy)); return; }
        if (d.formHealthy) { setDraft('healthy', Number(d.formHealthy)); return; }
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
        S.view = { name: 'random', params: { expanded: false } }; render(); break;
      case 'expand-cond':
        S.view = { name: 'random', params: { expanded: true } }; render(); break;
      case 'save-default':
        S.state.defaultConditions = JSON.parse(JSON.stringify(S.state.lastConditions));
        save(); toast('已保存为默认条件'); break;
      case 'do-draw': doDraw(); break;
      case 'pick-self':
        S.tab = 'library'; S.view = null; S._restoreScrollTop = 0;
        render(); toast('点任意菜即定今晚做'); break;
      case 'find-by-pantry':
        S.tab = 'pantry'; S.view = null; S._restoreScrollTop = 0; render(); break;
      case 'go-library': S.tab = 'library'; S.view = null; S._restoreScrollTop = 0; render(); break;
      case 'go-shopping': S.view = { name: 'shopping' }; S._restoreScrollTop = 0; render(); break;
      case 'go-recent': S.tab = 'me'; S.view = null; S._restoreScrollTop = 0; render(); break;
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
      case 'edit-staple': toast('常备调料管理：下一版接入'); break;
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
        S.state.customRecipes = S.state.customRecipes.filter(function (x) { return x.id !== id; });
        S.state.doneLog = S.state.doneLog.filter(function (x) { return x.recipeId !== id; });
        S.state.tonight = S.state.tonight.filter(function (x) { return x.recipeId !== id; });
        save();
        S._confirm = null;
        S.view = null; S.tab = 'library';
        render();
        toast('已删除');
      }
    });
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
      // 食材搜索用真实 input 元素（prompt 会被部分浏览器拦掉）
      document.addEventListener('input', function (e) {
        var t = e.target;
        if (t && t.dataset) {
          if (t.dataset.ingInput) onIngInput(t.value);
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
      });
      document.addEventListener('compositionend', function (e) {
        if (e.target && e.target.dataset && e.target.dataset.ingInput) {
          ingComposing = false;
          onIngInput(e.target.value);
        }
      });
      // 回车收起键盘
      document.addEventListener('keydown', function (e) {
        var t = e.target;
        if (t && t.dataset && t.dataset.ingInput && e.key === 'Enter') {
          e.preventDefault();
          t.blur();
        }
      });
      registerSW();

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

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
