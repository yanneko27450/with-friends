(function () {
  var root = document.documentElement;
  var saved = null; try { saved = localStorage.getItem('fwc-lang') } catch (e) {}
  if (saved !== 'zh' && saved !== 'en') saved = null;
  var lang = saved || ((navigator.language || '').toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en');

  // 和外掛裡的清單一致（mod/hooks/taxonomy.ts）
  var A = { zh: ['寫功能', '修錯誤', '整理程式', '寫測試', '查資料', '學新東西', '寫文件', '做設計', '規劃', '分析資料', '安裝設定', '審查', '在忙'],
            en: ['Building features', 'Fixing bugs', 'Refactoring', 'Writing tests', 'Researching', 'Learning', 'Writing', 'Designing', 'Planning', 'Analyzing data', 'Setting up', 'Reviewing', 'Working'] };
  var S = { zh: ['網站', 'App', '後端', '遊戲', 'AI 代理', '自動化', '資料', '文件', '課業', '開發環境', '創作', '其他'],
            en: ['a website', 'an app', 'a backend', 'a game', 'an AI agent', 'automation', 'data', 'a document', 'coursework', 'dev environment', 'creative work', 'other'] };
  // 示範面板：[動作, 對象, 工作中/閒置, 幾分鐘前]
  var bob = [[1, 0, 'w', 2], [0, 1, 'w', 6], [3, 1, 'w', 1], [8, 4, 'w', 4]];
  var cat = [[5, 8, 'i', 12], [9, 6, 'w', 3], [4, 4, 'i', 20], [2, 2, 'w', 1]];
  var k = 0;
  function $(id) { return document.getElementById(id) }
  function line(x) { var a = A[lang][x[0]], s = x[1] === 11 ? '' : S[lang][x[1]]; return s ? a + ' · ' + s : a }
  function meta(x) {
    if (lang === 'zh') return (x[2] === 'w' ? '工作中' : '閒置') + ' · ' + x[3] + ' 分鐘前開始';
    return (x[2] === 'w' ? 'Working' : 'Idle') + ' · started ' + x[3] + ' min ago';
  }
  function render() {
    var b = bob[k % bob.length], c = cat[k % cat.length];
    $('aa').textContent = line(b); $('ma').textContent = meta(b);
    $('ab').textContent = line(c); $('mb').textContent = meta(c);
    ['actions', 'subjects'].forEach(function (id) {
      var list = id === 'actions' ? A[lang] : S[lang], el = $(id);
      el.textContent = '';
      list.forEach(function (t) { var s = document.createElement('span'); s.textContent = t; el.appendChild(s) });
    });
  }
  function setLang(l) {
    lang = l;
    root.classList.remove('lang-zh', 'lang-en'); root.classList.add('lang-' + l);
    root.lang = l === 'zh' ? 'zh-Hant' : 'en';
    document.title = l === 'zh' ? 'Friends with Claude 說明' : 'Friends with Claude guide';
    $('say-zh').hidden = l !== 'zh'; $('say-en').hidden = l !== 'en';
    try { localStorage.setItem('fwc-lang', l) } catch (e) {}
    render();
  }
  $('langbtn').addEventListener('click', function () { setLang(lang === 'zh' ? 'en' : 'zh') });
  setLang(lang);

  // 減少動態的人不輪播
  var still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!still) setInterval(function () { k++; render() }, 4000);

  // 複製：英文介面複製英文那段
  document.querySelectorAll('[data-copy]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var id = (lang === 'en' && btn.getAttribute('data-copy-en')) || btn.getAttribute('data-copy');
      var el = $(id);
      if (!btn._label) btn._label = btn.innerHTML;
      function done() { btn.textContent = lang === 'zh' ? '已複製' : 'Copied'; clearTimeout(btn._t); btn._t = setTimeout(function () { btn.innerHTML = btn._label }, 1600) }
      function fallback() { var r = document.createRange(); r.selectNodeContents(el); var s = getSelection(); s.removeAllRanges(); s.addRange(r) }
      try { navigator.clipboard.writeText(el.textContent).then(done, fallback) } catch (e) { fallback() }
    });
  });

  // 現況：從同一個網址讀安裝清單與 /health；讀不到就保留頁面上寫的版本
  function relayText(ok) {
    $('relay').innerHTML = '';
    var zh = document.createElement('span'), en = document.createElement('span');
    zh.className = 'zh'; en.className = 'en';
    zh.textContent = ok ? '中繼正常運作' : '中繼狀態：讀不到';
    en.textContent = ok ? 'Relay is up' : 'Relay status unavailable';
    $('relay').appendChild(zh); $('relay').appendChild(en);
    $('relaydot').className = ok ? 'dot' : 'dot amber';
  }
  if (location.protocol === 'https:' || location.hostname === '127.0.0.1' || location.hostname === 'localhost') {
    fetch('/health', { cache: 'no-store' }).then(function (r) { return r.json() })
      .then(function (j) { relayText(!!(j && j.ok)) }, function () { relayText(false) });
    fetch('/marketplace.json', { cache: 'no-store' }).then(function (r) { return r.json() }).then(function (j) {
      var v = j && j.plugins && j.plugins[0] && j.plugins[0].version;
      if (typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v)) { $('ver').textContent = v; $('ver2').textContent = v; $('ver3').textContent = v }
    }, function () {});
  } else relayText(false);
})();
