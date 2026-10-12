(function(){
  var root = document.documentElement;
  var saved = null; try{ saved = localStorage.getItem('fwc-lang') }catch(e){}
  if(saved !== 'zh' && saved !== 'en') saved = null;
  var lang = saved || ((navigator.language||'').toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en');
  function setLang(l){
    lang = l;
    root.classList.remove('lang-zh','lang-en'); root.classList.add('lang-'+l);
    root.lang = l === 'zh' ? 'zh-Hant' : 'en';
    document.title = l === 'zh' ? 'Friends with Claude 說明' : 'Friends with Claude guide';
    try{ localStorage.setItem('fwc-lang', l) }catch(e){}
    render();
  }
  document.getElementById('langbtn').addEventListener('click', function(){ setLang(lang === 'zh' ? 'en' : 'zh') });

  // 和外掛裡的清單一致（mod/hooks/taxonomy.ts）
  var A = {zh:['寫功能','修錯誤','整理程式','寫測試','查資料','學新東西','寫文件','做設計','規劃','分析資料','安裝設定','審查','在忙'],
           en:['Building features','Fixing bugs','Refactoring','Writing tests','Researching','Learning','Writing','Designing','Planning','Analyzing data','Setting up','Reviewing','Working']};
  var S = {zh:['網站','App','後端','遊戲','AI 代理','自動化','資料','文件','課業','開發環境','創作','其他'],
           en:['a website','an app','a backend','a game','an AI agent','automation','data','a document','coursework','dev environment','creative work','other']};
  // 示範面板輪流換的動態：[動作, 對象, 狀態, 幾分鐘前]
  var bob = [[1,0,'w',2],[0,1,'w',6],[3,1,'w',1],[8,4,'w',4]];
  var cat = [[5,8,'i',12],[9,6,'w',3],[4,4,'i',20],[2,2,'w',1]];
  var k = 0;
  function line(x){ var a=A[lang][x[0]], s=x[1]===11?'':S[lang][x[1]]; return s ? a+' · '+s : a }
  function meta(x){
    if(lang==='zh') return (x[2]==='w'?'工作中':'閒置')+' · '+x[3]+' 分鐘前開始';
    return (x[2]==='w'?'Working':'Idle')+' · started '+x[3]+' min ago';
  }
  function ring(ids, st){ ids.forEach(function(id){ document.getElementById(id).classList.toggle('idle', st==='i') }) }
  function render(){
    var b = bob[k % bob.length], c = cat[k % cat.length];
    document.getElementById('aa').textContent = line(b); document.getElementById('ma').textContent = meta(b);
    document.getElementById('ab').textContent = line(c); document.getElementById('mb').textContent = meta(c);
    ring(['fa','ia'], b[2]); ring(['fb','ib'], c[2]);
    document.getElementById('online').textContent = '2'; // 好友在線數不含自己；Bob、Cat 都在線（閒置也算在線）
    ['actions','subjects'].forEach(function(id){
      var list = id==='actions' ? A[lang] : S[lang], el = document.getElementById(id);
      el.textContent = '';
      list.forEach(function(t){ var s=document.createElement('span'); s.textContent=t; el.appendChild(s) });
    });
  }
  setLang(lang);
  setInterval(function(){
    var acts = [document.getElementById('aa'), document.getElementById('ab')];
    acts.forEach(function(e){ e.classList.add('swap') });
    setTimeout(function(){ k++; render(); acts.forEach(function(e){ e.classList.remove('swap') }) }, 350);
  }, 3800);

  // data-copy-en：英文介面複製英文那段（給 Claude 的話中英各一份）
  document.querySelectorAll('[data-copy]').forEach(function(btn){
    btn.addEventListener('click', function(){
      var id = (lang === 'en' && btn.getAttribute('data-copy-en')) || btn.getAttribute('data-copy');
      var el = document.getElementById(id);
      var label = btn.innerHTML;
      function done(){ btn.textContent = lang==='zh' ? '已複製' : 'Copied'; setTimeout(function(){ btn.innerHTML = label }, 1600) }
      function fallback(){ var r=document.createRange(); r.selectNodeContents(el); var s=getSelection(); s.removeAllRanges(); s.addRange(r) }
      try{ navigator.clipboard.writeText(el.textContent).then(done, fallback) }catch(e){ fallback() }
    });
  });
})();
