/* ============================================================
   「待会吃什么」核心逻辑（数据层）
   这段代码会被内联进 index.html，这里先独立出来便于用脚本测试。
   ============================================================ */
(function (root) {
  'use strict';

  /* ---------- 日期工具（一律本地时区，禁止用 toISOString） ---------- */

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  // 返回 YYYY-MM-DD（本地时区）
  function dateStr(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function parseDate(s) {
    var p = String(s).split('-');
    return new Date(+p[0], +p[1] - 1, +p[2]);
  }

  // b - a，单位天（只算日期部分）
  function daysBetween(a, b) {
    var da = parseDate(a), db = parseDate(b);
    return Math.round((db - da) / 86400000);
  }

  function addDays(s, n) {
    var d = parseDate(s);
    d.setDate(d.getDate() + n);
    return dateStr(d);
  }

  // 按当前时间决定餐次：05:00-10:59 早，11:00-16:59 午，其余晚
  function mealByHour(d) {
    var h = (d || new Date()).getHours();
    if (h >= 5 && h < 11) return 'breakfast';
    if (h >= 11 && h < 17) return 'lunch';
    return 'dinner';
  }

  function greeting(d) {
    var h = (d || new Date()).getHours();
    if (h >= 5 && h < 11) return '早上好';
    if (h >= 11 && h < 17) return '中午好';
    return '晚上好';
  }

  /* ---------- 默认条件（PRD §5.5.2） ---------- */

  function defaultConditions() {
    return {
      meal: 'auto',
      roles: ['main', 'side'],
      tools: ['wok', 'steamer', 'airfryer', 'ricecooker'],
      maxMinutes: 30,
      cheapOnly: false,
      easyOnly: false,
      healthyFirst: true,
      spicyOverride: null,
      excludeDays: 7,
      pantryOnly: false,
      keyword: '',
      count: 4
    };
  }

  function defaultState() {
    return {
      version: 1,
      me: 'a',
      members: {
        a: { name: '我', emoji: '🙂', allergies: [], dislikes: [], maxSpicy: 0, preferTags: [] },
        b: { name: '小美', emoji: '🌸', allergies: [], dislikes: [], maxSpicy: 0, preferTags: [] }
      },
      pantry: { items: [], updatedAt: null, updatedBy: null },
      stapleRemoved: [],
      defaultConditions: defaultConditions(),
      lastConditions: defaultConditions(),
      customRecipes: [],
      recipeOverrides: {},
      tonight: [],
      doneLog: [],
      session: null,
      settings: { sync: null, lastBackupAt: null }
    };
  }

  /* ---------- 食材库索引 ---------- */

  function buildIngredientIndex(ingredients) {
    var byId = {};
    var searchIndex = [];
    for (var i = 0; i < ingredients.length; i++) {
      var ing = ingredients[i];
      byId[ing.id] = ing;
      var terms = [ing.name].concat(ing.alias || []);
      searchIndex.push({ id: ing.id, terms: terms });
    }
    return { byId: byId, searchIndex: searchIndex };
  }

  // 判断某个食材是否算「常备」（staple 且没被用户移除）
  function isStaple(ing, removedList) {
    if (!ing || !ing.staple) return false;
    return (removedList || []).indexOf(ing.id) === -1;
  }

  /* ---------- 忌口过滤（硬过滤，PRD §5.10.3） ---------- */

  // 返回冲突原因数组，空数组 = 无冲突
  function recipeConflicts(recipe, state, ingIndex) {
    var reasons = [];
    var members = state.members || {};
    var keys = Object.keys(members);

    for (var i = 0; i < recipe.ingredients.length; i++) {
      var item = recipe.ingredients[i];
      var ing = ingIndex.byId[item.id];
      if (!ing) continue;
      var allergens = ing.allergens || [];

      for (var k = 0; k < keys.length; k++) {
        var who = members[keys[k]];
        var label = who.name || keys[k];

        // 过敏（永不可覆盖）
        for (var a = 0; a < allergens.length; a++) {
          if ((who.allergies || []).indexOf(allergens[a]) !== -1) {
            reasons.push({ type: 'allergy', member: label, ingId: ing.id, ingName: ing.name, allergen: allergens[a] });
          }
        }
        // 不吃（硬过滤，可在菜库手动显示）
        if ((who.dislikes || []).indexOf(ing.id) !== -1) {
          reasons.push({ type: 'dislike', member: label, ingId: ing.id, ingName: ing.name });
        }
      }
    }

    // 辣度上限
    var spicyCap = null;
    for (var k2 = 0; k2 < keys.length; k2++) {
      var m = members[keys[k2]];
      var cap = (m.maxSpicy === undefined || m.maxSpicy === null) ? 3 : m.maxSpicy;
      spicyCap = (spicyCap === null) ? cap : Math.min(spicyCap, cap);
    }
    if (spicyCap !== null && recipe.spicy > spicyCap) {
      reasons.push({ type: 'spicy', need: recipe.spicy, cap: spicyCap });
    }
    return reasons;
  }

  /* ---------- 食材匹配（PRD §6.3） ---------- */

  function recipeMissing(recipe, state, ingIndex) {
    var pantry = (state.pantry && state.pantry.items) || [];
    var missing = [], have = [];
    for (var i = 0; i < recipe.ingredients.length; i++) {
      var item = recipe.ingredients[i];
      var ing = ingIndex.byId[item.id];
      if (!ing) continue;
      if (isStaple(ing, state.stapleRemoved)) { have.push({ id: item.id, amount: item.amount, staple: true }); continue; }
      if (pantry.indexOf(item.id) !== -1) { have.push({ id: item.id, amount: item.amount }); continue; }
      missing.push({ id: item.id, amount: item.amount, name: ing.name });
    }
    return { missing: missing, have: have, canCook: missing.length === 0 };
  }

  /* ---------- 历史（PRD §6.5） ---------- */

  // 某道菜最近一次做过的日期（无则 null）
  function lastDoneDate(recipeId, state) {
    var log = state.doneLog || [];
    var latest = null;
    for (var i = 0; i < log.length; i++) {
      if (log[i].recipeId !== recipeId) continue;
      if (!latest || log[i].date > latest) latest = log[i].date;
    }
    return latest;
  }

  function recentlyDone(recipeId, state, days, today) {
    if (!days) return false;
    var last = lastDoneDate(recipeId, state);
    if (!last) return false;
    return daysBetween(last, today || dateStr()) <= days;
  }

  /* ---------- 候选池生成（PRD §6.1） ---------- */

  // 合并内置菜 + 自定义菜 + 用户对内置菜的覆盖
  function allRecipes(builtin, state) {
    var out = [];
    var overrides = state.recipeOverrides || {};
    for (var i = 0; i < builtin.length; i++) {
      var r = builtin[i];
      var ov = overrides[r.id];
      if (ov) {
        var merged = {};
        for (var k in r) if (Object.prototype.hasOwnProperty.call(r, k)) merged[k] = r[k];
        for (var k2 in ov) if (Object.prototype.hasOwnProperty.call(ov, k2)) merged[k2] = ov[k2];
        merged.builtin = true;
        merged._overridden = true;
        out.push(merged);
      } else {
        var copy = {};
        for (var k3 in r) if (Object.prototype.hasOwnProperty.call(r, k3)) copy[k3] = r[k3];
        copy.builtin = true;
        out.push(copy);
      }
    }
    var custom = state.customRecipes || [];
    for (var j = 0; j < custom.length; j++) {
      var c = {};
      for (var k4 in custom[j]) if (Object.prototype.hasOwnProperty.call(custom[j], k4)) c[k4] = custom[j][k4];
      c.builtin = false;
      out.push(c);
    }
    return out;
  }

  /**
   * 生成候选池
   * @returns { recipes: [...], filtered: {byCondition, byDiet, byRecent}, notes: [...] }
   */
  function buildPool(cond, builtinRecipes, state, ingIndex, opts) {
    opts = opts || {};
    var today = opts.today || dateStr();
    var lockIds = opts.lockIds || null;  // 从「按食材找菜」进入时锁定候选集

    var recipes = allRecipes(builtinRecipes, state);
    var afterCond = [];
    var meal = cond.meal === 'auto' ? mealByHour(opts.now) : cond.meal;

    for (var i = 0; i < recipes.length; i++) {
      var r = recipes[i];

      if (lockIds && lockIds.indexOf(r.id) === -1) continue;

      // 1.1 餐次
      if (r.meals.indexOf(meal) === -1) continue;
      // 1.2 角色
      if (cond.roles && cond.roles.length && cond.roles.indexOf(r.role) === -1) continue;
      // 1.3 耗时
      if (cond.maxMinutes && r.minutes > cond.maxMinutes) continue;
      // 1.4 只看便宜
      if (cond.cheapOnly && r.cost !== 1) continue;
      // 1.5 只要简单
      if (cond.easyOnly && r.difficulty !== 1) continue;
      // 1.6 只用家里有的
      if (cond.pantryOnly) {
        var mm = recipeMissing(r, state, ingIndex);
        if (!mm.canCook) continue;
      }
      // 1.7 关键词（菜名 / 食材名 / 标签）
      if (cond.keyword) {
        var kw = String(cond.keyword).trim();
        if (kw) {
          var hay = r.name + ' ' + (r.tags || []).join(' ');
          for (var gi = 0; gi < r.ingredients.length; gi++) {
            var g = ingIndex.byId[r.ingredients[gi].id];
            if (g) hay += ' ' + g.name + ' ' + (g.alias || []).join(' ');
          }
          if (hay.toLowerCase().indexOf(kw.toLowerCase()) === -1) continue;
        }
      }
      // 1.8 器具
      if (cond.tools && cond.tools.length) {
        var tools = r.tools || [];
        var ok = true;
        for (var t = 0; t < tools.length; t++) {
          if (cond.tools.indexOf(tools[t]) === -1) { ok = false; break; }
        }
        if (!ok) continue;
      }

      afterCond.push(r);
    }

    // Step 2 忌口硬过滤
    var afterDiet = [];
    var dietBlocked = [];
    for (var j = 0; j < afterCond.length; j++) {
      var conflicts = recipeConflicts(afterCond[j], state, ingIndex);
      if (conflicts.length) dietBlocked.push({ recipe: afterCond[j], conflicts: conflicts });
      else afterDiet.push(afterCond[j]);
    }

    // Step 3 去重（软排除）
    var fresh = [], stale = [];
    for (var k = 0; k < afterDiet.length; k++) {
      if (recentlyDone(afterDiet[k].id, state, cond.excludeDays, today)) stale.push(afterDiet[k]);
      else fresh.push(afterDiet[k]);
    }
    var N = cond.count || 4;
    var pool, usedStale;
    if (fresh.length >= N) { pool = fresh.slice(); usedStale = false; }
    else { pool = fresh.concat(stale); usedStale = true; }

    return {
      pool: pool,
      freshCount: fresh.length,
      staleCount: stale.length,
      usedStale: usedStale,
      afterCondCount: afterCond.length,
      afterDietCount: afterDiet.length,
      dietBlocked: dietBlocked,
      meal: meal,
      notes: buildNotes(cond, afterCond.length, afterDiet.length, fresh.length, N)
    };
  }

  function buildNotes(cond, afterCondCount, afterDietCount, freshCount, N) {
    var notes = [];
    if (afterCondCount === 0) {
      notes.push({ level: 'error', text: '没有符合条件的菜' });
    } else if (afterDietCount === 0) {
      notes.push({ level: 'error', text: '符合条件 ' + afterCondCount + ' 道，但全被忌口过滤掉了' });
    } else if (afterDietCount < 10) {
      notes.push({ level: 'warn', text: '按当前忌口只剩 ' + afterDietCount + ' 道菜可选，去「我的」看看忌口设置是否太严' });
    }
    if (freshCount < N && afterDietCount >= N) {
      notes.push({ level: 'info', text: '符合条件的 ' + afterDietCount + ' 道里，只有 ' + freshCount + ' 道最近没做过；会少量放入做过的菜' });
    }
    if (freshCount === 0 && afterDietCount > 0) {
      notes.push({ level: 'info', text: '符合条件的菜最近都做过，已放宽去重' });
    }
    return notes;
  }

  /* ---------- 加权随机（PRD §6.1 Step 4） ---------- */

  function weightOf(recipe, cond, state, ingIndex, today) {
    var w = 100;
    if (cond.healthyFirst) {
      if (recipe.healthy >= 4) w *= 1.5;
      else if (recipe.healthy <= 2) w *= 0.6;
    }
    if (cond.cheapOnly && recipe.cost === 1) w *= 1.3;
    if (!lastDoneDate(recipe.id, state)) w *= 1.2;

    // 命中任一方的偏好标签
    var prefer = [];
    var members = state.members || {};
    for (var k in members) {
      if (!Object.prototype.hasOwnProperty.call(members, k)) continue;
      prefer = prefer.concat(members[k].preferTags || []);
    }
    if (prefer.length) {
      var tags = recipe.tags || [];
      for (var i = 0; i < tags.length; i++) {
        if (prefer.indexOf(tags[i]) !== -1) { w *= 1.3; break; }
      }
    }
    // 最近做过的降权
    if (recentlyDone(recipe.id, state, cond.excludeDays, today)) w *= 0.15;
    return w;
  }

  // 不放回加权抽样
  function weightedPick(pool, n, cond, state, ingIndex, opts) {
    opts = opts || {};
    var rnd = opts.rnd || Math.random;
    var today = opts.today || dateStr();
    var items = pool.map(function (r) {
      return { r: r, w: weightOf(r, cond, state, ingIndex, today) };
    });
    var out = [];
    var take = Math.min(n, items.length);
    for (var i = 0; i < take; i++) {
      var total = 0;
      for (var j = 0; j < items.length; j++) total += items[j].w;
      if (total <= 0) break;
      var roll = rnd() * total;
      var acc = 0, hit = items.length - 1;
      for (var k = 0; k < items.length; k++) {
        acc += items[k].w;
        if (roll <= acc) { hit = k; break; }
      }
      out.push(items[hit].r);
      items.splice(hit, 1);
    }
    return out;
  }

  /* ---------- 投票判定（PRD §6.2） ---------- */

  // 分组：want 双方都投想吃 / ok 无人反对 / no 有人不想吃
  function groupVotes(candidates, votesA, votesB) {
    var groups = { want: [], ok: [], no: [] };
    for (var i = 0; i < candidates.length; i++) {
      var id = candidates[i];
      var va = votesA[id], vb = votesB[id];
      if (va === 'no' || vb === 'no') groups.no.push(id);
      else if (va === 'want' && vb === 'want') groups.want.push(id);
      else groups.ok.push(id);
    }
    return groups;
  }

  // 「都还行」组内加权随机定一道（健康度高、耗时短的权重大）
  function pickFromOk(ids, recipeById, rnd) {
    rnd = rnd || Math.random;
    if (!ids.length) return null;
    var items = ids.map(function (id) {
      var r = recipeById[id] || {};
      var w = 100;
      w *= (1 + ((r.healthy || 3) - 3) * 0.25);
      if ((r.minutes || 30) <= 15) w *= 1.3;
      else if ((r.minutes || 30) >= 45) w *= 0.8;
      return { id: id, w: w };
    });
    var total = items.reduce(function (s, x) { return s + x.w; }, 0);
    var roll = rnd() * total, acc = 0;
    for (var i = 0; i < items.length; i++) {
      acc += items[i].w;
      if (roll <= acc) return items[i].id;
    }
    return items[items.length - 1].id;
  }

  /* ---------- 采购清单（PRD §5.9.2 / §6.6） ---------- */

  function buildShoppingList(tonight, state, ingIndex, recipeById) {
    var today = dateStr();
    var groups = {};   // ingId -> { id, name, amounts[], category, dishes[] }
    var haveSet = {};

    for (var i = 0; i < tonight.length; i++) {
      var item = tonight[i];
      if (daysBetween(item.date, today) > 1) continue;   // 超过 48 小时的不算
      var r = recipeById[item.recipeId];
      if (!r) continue;
      var mm = recipeMissing(r, state, ingIndex);
      var j;
      for (j = 0; j < mm.missing.length; j++) {
        var m = mm.missing[j];
        if (!groups[m.id]) {
          var ing = ingIndex.byId[m.id];
          groups[m.id] = { id: m.id, name: m.name, category: (ing && ing.category) || 'other', amounts: [], dishes: [] };
        }
        groups[m.id].amounts.push(m.amount);
        if (groups[m.id].dishes.indexOf(r.name) === -1) groups[m.id].dishes.push(r.name);
      }
      for (j = 0; j < mm.have.length; j++) {
        var h = mm.have[j];
        var ing2 = ingIndex.byId[h.id];
        haveSet[h.id] = { id: h.id, name: ing2 ? ing2.name : h.id, category: (ing2 && ing2.category) || 'other', staple: !!h.staple, amount: h.amount };
      }
    }

    var toBuy = Object.keys(groups).map(function (k) { return groups[k]; });
    var have = Object.keys(haveSet).map(function (k) { return haveSet[k]; });

    // 按分类分组
    function groupByCat(list) {
      var byCat = {};
      for (var i = 0; i < list.length; i++) {
        var c = list[i].category;
        if (!byCat[c]) byCat[c] = [];
        byCat[c].push(list[i]);
      }
      return byCat;
    }

    return {
      toBuy: toBuy,
      have: have,
      toBuyByCat: groupByCat(toBuy),
      haveByCat: groupByCat(have),
      total: toBuy.length,
      ready: toBuy.length === 0 && have.length > 0
    };
  }

  /* ---------- 数字与文本格式化（PRD §6.7） ---------- */

  function fmtMinutes(min) {
    if (min === null || min === undefined) return '—';
    if (min < 60) return min + ' 分钟';
    var h = Math.floor(min / 60), m = min % 60;
    return m === 0 ? h + ' 小时' : h + ' 小时 ' + m + ' 分';
  }

  function fmtCost(c) {
    return c === 1 ? '¥' : c === 2 ? '¥¥' : '¥¥¥';
  }

  function fmtDifficulty(d) {
    return d === 1 ? '简单' : d === 2 ? '中等' : '有点难';
  }

  function fmtSpicy(s) {
    return s === 0 ? '不辣' : new Array(s + 1).join('🌶️');
  }

  function fmtRelativeDate(dateS, today) {
    today = today || dateStr();
    var n = daysBetween(dateS, today);
    if (n === 0) return '今天';
    if (n === 1) return '昨天';
    if (n < 30) return n + ' 天前';
    var m = Math.floor(n / 30);
    return m + ' 个月前';
  }

  function fmtDateTitle(dateS) {
    var d = parseDate(dateS);
    var w = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 周' + w;
  }

  var CATEGORY_LABEL = {
    vegetable: '蔬菜', protein: '肉蛋', seafood: '水产', soy: '豆制品',
    staple: '主食', condiment: '调料', dry: '干货', fruit: '水果', other: '其他'
  };

  var ROLE_LABEL = { main: '主菜', side: '配菜', staple: '主食', breakfast: '早餐' };
  var MEAL_LABEL = { breakfast: '早', lunch: '午', dinner: '晚' };

  var ALLERGEN_LABEL = {
    egg: '蛋', crustacean: '甲壳类（虾蟹）', oyster: '蚝类', clam: '蛤类',
    scallop: '扇贝类', fish: '鱼', peanut: '花生', treenut: '坚果',
    gluten: '麸质', dairy: '奶', soy: '大豆', sesame: '芝麻'
  };

  var api = {
    // 日期
    dateStr: dateStr, parseDate: parseDate, daysBetween: daysBetween, addDays: addDays,
    mealByHour: mealByHour, greeting: greeting,
    // 状态
    defaultConditions: defaultConditions, defaultState: defaultState,
    // 食材
    buildIngredientIndex: buildIngredientIndex, isStaple: isStaple,
    // 过滤与匹配
    recipeConflicts: recipeConflicts, recipeMissing: recipeMissing,
    // 历史
    lastDoneDate: lastDoneDate, recentlyDone: recentlyDone,
    // 池与抽样
    allRecipes: allRecipes, buildPool: buildPool, weightOf: weightOf, weightedPick: weightedPick,
    // 投票
    groupVotes: groupVotes, pickFromOk: pickFromOk,
    // 清单
    buildShoppingList: buildShoppingList,
    // 格式化
    fmtMinutes: fmtMinutes, fmtCost: fmtCost, fmtDifficulty: fmtDifficulty,
    fmtSpicy: fmtSpicy, fmtRelativeDate: fmtRelativeDate, fmtDateTitle: fmtDateTitle,
    CATEGORY_LABEL: CATEGORY_LABEL, ROLE_LABEL: ROLE_LABEL, MEAL_LABEL: MEAL_LABEL,
    ALLERGEN_LABEL: ALLERGEN_LABEL
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ChishenmeCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
