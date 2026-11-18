/* 北海道旅遊日語 300 — app logic (zero-build, vanilla JS) */
(function () {
  'use strict';

  if (typeof VOCAB_DATA === 'undefined' || !Array.isArray(VOCAB_DATA)) {
    document.body.insertAdjacentHTML('afterbegin', '<p style="padding:16px;color:#c8372d">無法載入單字資料（data.js）。</p>');
    return;
  }

  const DATA = VOCAB_DATA;
  const TOTAL = DATA.length;
  const byId = new Map(DATA.map(w => [w.id, w]));
  const $ = sel => document.querySelector(sel);

  // ---------- Categories ----------
  const CATS = [];
  DATA.forEach(w => {
    let c = CATS.find(x => x.id === w.categoryId);
    if (!c) CATS.push(c = { id: w.categoryId, name: w.category, count: 0 });
    c.count++;
  });
  CATS.sort((a, b) => a.id - b.id);

  // ---------- Persistent state ----------
  const STORE_KEY = 'hokkaido-jp300:v1';
  const DEFAULTS = {
    mastered: [], starred: [],
    rate: 0.7, autoSpeak: true, showKanji: false, showRomaji: false,
    shuffle: true, blind: false, listenOnly: false,
    mode: 'card', cat: 0, status: 'all',
  };

  function loadState() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch (e) { saved = {}; }
    const s = Object.assign({}, DEFAULTS, saved);
    s.mastered = new Set(Array.isArray(s.mastered) ? s.mastered.filter(id => byId.has(id)) : []);
    s.starred = new Set(Array.isArray(s.starred) ? s.starred.filter(id => byId.has(id)) : []);
    if (![0.7, 1].includes(s.rate)) s.rate = DEFAULTS.rate;
    if (!['card', 'list', 'quiz'].includes(s.mode)) s.mode = 'card';
    if (!['all', 'star', 'learning', 'mastered'].includes(s.status)) s.status = 'all';
    if (s.cat !== 0 && !CATS.some(c => c.id === s.cat)) s.cat = 0;
    s.query = '';
    return s;
  }

  const state = loadState();

  function saveState() {
    const { query, ...rest } = state;
    const out = Object.assign({}, rest, { mastered: [...state.mastered], starred: [...state.starred] });
    try { localStorage.setItem(STORE_KEY, JSON.stringify(out)); } catch (e) { /* private mode / quota */ }
  }

  // ---------- Helpers ----------
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toHira = s => s.replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));
  const norm = s => toHira(String(s).toLowerCase()).replace(/[\s・／/]+/g, '');

  function shuffled(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // Search haystack per word (katakana folded to hiragana, spaces removed)
  const HAY = new Map(DATA.map(w => [w.id, [w.kana, w.kanji, w.romaji, w.zh].map(norm).join('\u0001')]));

  // Colour-mark special kana (dakuten, handakuten, sokuon, small kana, long vowel)
  const MARKS = {};
  'がぎぐげござじずぜぞだぢづでどばびぶべぼガギグゲゴザジズゼゾダヂヅデドバビブベボヴ'.split('').forEach(c => MARKS[c] = 'daku');
  'ぱぴぷぺぽパピプペポ'.split('').forEach(c => MARKS[c] = 'han');
  'っッ'.split('').forEach(c => MARKS[c] = 'soku');
  'ゃゅょャュョぁぃぅぇぉァィゥェォ'.split('').forEach(c => MARKS[c] = 'you');
  MARKS['ー'] = 'long';
  const markKana = s => Array.from(s).map(c => MARKS[c] ? `<span class="m-${MARKS[c]}">${esc(c)}</span>` : esc(c)).join('');

  function kanaSize(kana) {
    const n = Array.from(kana).length;
    if (n <= 3) return 'clamp(3.4rem, 18vw, 4.6rem)';
    if (n <= 5) return 'clamp(2.8rem, 14vw, 3.8rem)';
    if (n <= 7) return 'clamp(2.2rem, 10.5vw, 3.2rem)';
    if (n <= 9) return 'clamp(1.8rem, 8.4vw, 2.7rem)';
    return 'clamp(1.5rem, 7vw, 2.3rem)';
  }

  let toastTimer;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
  }

  // ---------- TTS (Web Speech API) ----------
  const TTS = {
    supported: 'speechSynthesis' in window && typeof window.SpeechSynthesisUtterance === 'function',
    voice: null,
    unlocked: false,
    activeBtn: null,

    init() {
      if (!this.supported) {
        document.body.classList.add('no-tts');
        showNotice('⚠️ 此瀏覽器不支援語音朗讀，單字卡與測驗仍可正常使用。建議改用最新版 Safari（iPhone）或 Chrome（Android）。');
        return;
      }
      const pick = () => this.pickVoice();
      pick();
      if (typeof speechSynthesis.addEventListener === 'function') speechSynthesis.addEventListener('voiceschanged', pick);
      else speechSynthesis.onvoiceschanged = pick;
      setTimeout(() => { pick(); this.checkJapanese(); }, 1500);

      // iOS / Android: audio must be unlocked by a user gesture
      const unlock = () => this.unlock();
      ['touchend', 'pointerdown', 'keydown', 'click'].forEach(ev =>
        document.addEventListener(ev, unlock, { capture: true, passive: true }));
    },

    pickVoice() {
      const voices = speechSynthesis.getVoices() || [];
      const ja = voices.filter(v => /^ja([-_]|$)/i.test(v.lang));
      if (!ja.length) return;
      const prefs = [/kyoko/i, /otoya/i, /google.*(日本語|japanese)/i, /o-ren|hattori/i, /nanami|keita/i, /haruka|ayumi|ichiro|sayaka/i];
      let chosen = null;
      for (const re of prefs) {
        chosen = ja.find(v => re.test(v.name) && /enhanced|premium/i.test(v.name)) || ja.find(v => re.test(v.name));
        if (chosen) break;
      }
      this.voice = chosen || ja.find(v => v.localService) || ja[0];
      hideNotice();
    },

    checkJapanese() {
      const voices = speechSynthesis.getVoices() || [];
      if (voices.length && !this.voice) {
        showNotice('ℹ️ 找不到日語語音，發音可能不正確。iPhone：設定 › 輔助使用 › 朗讀內容 › 聲音 › 日本語；Android：設定 › 文字轉語音 › 安裝日語語音資料。');
      }
    },

    unlock() {
      if (this.unlocked || !this.supported) return;
      this.unlocked = true;
      try {
        const u = new SpeechSynthesisUtterance(' ');
        u.volume = 0;
        u.lang = 'ja-JP';
        speechSynthesis.speak(u);
      } catch (e) { /* ignore */ }
    },

    // Always pass the kana field, never kanji, for correct readings.
    speak(kana, btn) {
      if (!this.supported) { toast('此裝置不支援語音朗讀'); return; }
      try {
        speechSynthesis.cancel();
        if (speechSynthesis.paused) speechSynthesis.resume();
        const u = new SpeechSynthesisUtterance(kana);
        u.lang = 'ja-JP';
        if (this.voice) u.voice = this.voice;
        u.rate = state.rate;
        u.pitch = 1;
        this.setActive(btn || null);
        u.onend = u.onerror = () => { if (this.activeBtn === btn) this.setActive(null); };
        speechSynthesis.speak(u);
      } catch (e) {
        toast('語音播放失敗，請再試一次');
      }
    },

    setActive(btn) {
      if (this.activeBtn) this.activeBtn.classList.remove('speaking');
      this.activeBtn = btn;
      if (btn) btn.classList.add('speaking');
    },
  };

  function showNotice(html) {
    const n = $('#ttsNotice');
    n.innerHTML = html + ' <button type="button" aria-label="關閉提示">知道了</button>';
    n.hidden = false;
    n.querySelector('button').onclick = () => { n.hidden = true; };
  }
  function hideNotice() { $('#ttsNotice').hidden = true; }

  // ---------- Filtering ----------
  function statusOk(w, status) {
    switch (status) {
      case 'star': return state.starred.has(w.id);
      case 'learning': return !state.mastered.has(w.id);
      case 'mastered': return state.mastered.has(w.id);
      default: return true;
    }
  }

  function scope() { // category + search (before status filter)
    const q = norm(state.query);
    return DATA.filter(w => (!state.cat || w.categoryId === state.cat) && (!q || HAY.get(w.id).includes(q)));
  }
  const filtered = () => scope().filter(w => statusOk(w, state.status));

  // ---------- Deck (flashcard order, shared with list) ----------
  let deck = [];
  let idx = 0;

  function rebuildDeck() {
    const ids = filtered().map(w => w.id);
    deck = state.shuffle ? shuffled(ids) : ids;
    idx = 0;
  }
  const current = () => (deck.length ? byId.get(deck[idx]) : null);

  // ---------- Header / filters rendering ----------
  function renderProgress() {
    const n = state.mastered.size;
    $('#progressFill').style.width = (n / TOTAL * 100).toFixed(1) + '%';
    $('#progressText').textContent = `已熟記 ${n} / ${TOTAL}`;
    $('#progressBar').setAttribute('aria-valuenow', n);
    $('#progressBar').setAttribute('aria-valuemax', TOTAL);
  }

  function renderTopControls() {
    document.querySelectorAll('[data-rate]').forEach(b =>
      b.setAttribute('aria-pressed', String(Number(b.dataset.rate) === state.rate)));
    $('#shuffleBtn').setAttribute('aria-pressed', String(state.shuffle));
    $('#optKanji').checked = state.showKanji;
    $('#optRomaji').checked = state.showRomaji;
    $('#optAuto').checked = state.autoSpeak;
    $('#optBlind').checked = state.blind;
    $('#optListen').checked = state.listenOnly;
  }

  function renderCats() {
    const items = [{ id: 0, label: '全部', count: TOTAL }]
      .concat(CATS.map(c => ({ id: c.id, label: `${c.id}. ${c.name}`, count: c.count })));
    $('#catBar').innerHTML = items.map(c =>
      `<button type="button" class="chip" data-cat="${c.id}" aria-pressed="${state.cat === c.id}">${esc(c.label)} <span class="count">(${c.count})</span></button>`
    ).join('');
  }

  function renderStatus() {
    const sc = scope();
    const counts = {
      all: sc.length,
      star: sc.filter(w => state.starred.has(w.id)).length,
      learning: sc.filter(w => !state.mastered.has(w.id)).length,
      mastered: sc.filter(w => state.mastered.has(w.id)).length,
    };
    const items = [['all', '全部狀態'], ['star', '⭐ 收藏/不熟'], ['learning', '📖 尚未熟記'], ['mastered', '✅ 已熟記']];
    $('#statusBar').innerHTML = items.map(([k, label]) =>
      `<button type="button" class="chip" data-status="${k}" aria-pressed="${state.status === k}">${label} <span class="count">${counts[k]}</span></button>`
    ).join('');
  }

  function emptyMessage() {
    if (state.query) return `找不到符合「${esc(state.query)}」的單字`;
    if (state.status === 'star') return '還沒有收藏的單字<br>在卡片或列表上點 ☆ 加入收藏';
    if (state.status === 'mastered') return '這個分類還沒有已熟記的單字，加油！';
    if (state.status === 'learning') return '🎉 這個分類全部熟記了！';
    return '沒有單字';
  }

  // ---------- Mode A: Flashcard ----------
  const cardEl = $('#card');
  const dragEl = $('#cardDrag');

  function starBtn(w) {
    const on = state.starred.has(w.id);
    return `<button type="button" class="star-btn" data-act="star" data-star="${w.id}" aria-pressed="${on}" aria-label="${on ? '取消收藏' : '加入收藏'}">${on ? '★' : '☆'}</button>`;
  }

  function setFlipped(on, instant) {
    if (instant) {
      cardEl.classList.add('no-anim');
      cardEl.classList.toggle('flipped', on);
      void cardEl.offsetWidth; // force reflow
      cardEl.classList.remove('no-anim');
    } else {
      cardEl.classList.toggle('flipped', on);
    }
    cardEl.setAttribute('aria-label', on ? '卡片背面，點擊翻回正面' : '卡片正面，點擊翻面');
  }

  function renderCard() {
    const w = current();
    const empty = $('#cardEmpty');
    const hasCards = !!w;
    cardEl.hidden = !hasCards;
    empty.hidden = hasCards;
    ['#btnPrev', '#btnAgain', '#btnKnow', '#btnNext'].forEach(s => { $(s).disabled = !hasCards; });
    if (!w) {
      empty.innerHTML = emptyMessage();
      $('#cardCount').textContent = '';
      return;
    }
    setFlipped(false, true);
    const done = state.mastered.has(w.id);
    const top = `<div class="face-top">
        <span class="tag">${esc(w.category)}</span>
        ${done ? '<span class="tag done">✅ 已熟記</span>' : ''}
        <span class="spacer"></span>
        <span class="card-id">#${w.id}</span>
        ${starBtn(w)}
      </div>`;

    $('#cardFront').innerHTML = `${top}
      <div class="front-main">
        <div class="kana-big" lang="ja" style="--kana-size:${kanaSize(w.kana)}">${esc(w.kana)}</div>
        ${state.showKanji && w.kanji ? `<div class="hint-kanji" lang="ja">${esc(w.kanji)}</div>` : ''}
        ${state.showRomaji ? `<div class="hint-romaji">${esc(w.romaji)}</div>` : ''}
      </div>
      <div class="face-bottom">
        <button type="button" class="speak-big" data-act="speak" aria-label="播放發音">🔊</button>
      </div>`;

    $('#cardBack').innerHTML = `${top}
      <div class="back-main">
        <div class="back-kana" lang="ja">${markKana(w.kana)}</div>
        ${w.kanji ? `<div class="back-kanji" lang="ja">${esc(w.kanji)}</div>` : ''}
        <div class="back-romaji">${esc(w.romaji)}</div>
        <div class="back-zh">${esc(w.zh)}</div>
        <div class="note-box"><b>💡 發音重點</b>　${markKana(w.note)}</div>
      </div>
      <div class="face-bottom">
        <button type="button" class="speak-big" data-act="speak" aria-label="播放發音">🔊</button>
      </div>`;

    $('#cardCount').textContent = `第 ${idx + 1} / ${deck.length} 張`;
  }

  function animateEnter(dir) {
    dragEl.classList.remove('enter-next', 'enter-prev');
    void dragEl.offsetWidth;
    dragEl.classList.add(dir > 0 ? 'enter-next' : 'enter-prev');
  }
  dragEl.addEventListener('animationend', () => dragEl.classList.remove('enter-next', 'enter-prev'));

  function speakCurrent(btn) {
    const w = current();
    if (w) TTS.speak(w.kana, btn);
  }

  function step(dir) {
    if (!deck.length) return;
    let next = idx + dir;
    if (next >= deck.length) {
      if (state.shuffle) deck = shuffled(deck);
      next = 0;
      toast('🎉 本輪完成！重新開始' + (state.shuffle ? '（已重新洗牌）' : ''));
    } else if (next < 0) {
      next = deck.length - 1;
    }
    idx = next;
    renderCard();
    animateEnter(dir);
    if (state.autoSpeak) speakCurrent();
  }

  function flip() {
    if (!current()) return;
    const on = !cardEl.classList.contains('flipped');
    setFlipped(on);
    if (on && state.autoSpeak) speakCurrent();
  }

  function markAgain() {
    const w = current();
    if (!w) return;
    const wasDone = state.mastered.delete(w.id);
    saveState();
    // Move this card a few positions later so it comes back soon.
    if (deck.length > 1) {
      deck.splice(idx, 1);
      deck.splice(Math.min(idx + 3, deck.length), 0, w.id);
      if (idx >= deck.length) idx = 0;
    }
    afterProgressChange();
    renderCard();
    animateEnter(1);
    toast(wasDone ? '已移出熟記，稍後再出現' : '稍後會再出現這張');
    if (state.autoSpeak) speakCurrent();
  }

  function markKnown() {
    const w = current();
    if (!w) return;
    state.mastered.add(w.id);
    saveState();
    afterProgressChange();
    if (state.status === 'learning') {
      // Card no longer belongs in this filter: drop it from the deck.
      deck.splice(idx, 1);
      if (idx >= deck.length) idx = 0;
      renderCard();
      if (deck.length) { animateEnter(1); if (state.autoSpeak) speakCurrent(); }
    } else {
      step(1);
    }
  }

  function afterProgressChange() {
    renderProgress();
    renderStatus();
  }

  function toggleStar(id) {
    const on = !state.starred.has(id);
    if (on) state.starred.add(id); else state.starred.delete(id);
    saveState();
    document.querySelectorAll(`[data-star="${id}"]`).forEach(b => {
      if (b.classList.contains('star-btn')) {
        b.textContent = on ? '★' : '☆';
        b.setAttribute('aria-label', on ? '取消收藏' : '加入收藏');
      } else {
        b.textContent = on ? '⭐ 已加入收藏' : '☆ 加入收藏';
      }
      b.setAttribute('aria-pressed', String(on));
    });
    renderStatus();
    toast(on ? '⭐ 已加入收藏' : '已取消收藏');
  }

  // Card clicks (flip / speak / star)
  let suppressClick = false;
  cardEl.addEventListener('click', e => {
    if (suppressClick) { suppressClick = false; return; }
    const act = e.target.closest('[data-act]');
    if (act) {
      e.stopPropagation();
      if (act.dataset.act === 'speak') speakCurrent(act);
      else if (act.dataset.act === 'star') toggleStar(Number(act.dataset.star));
      return;
    }
    flip();
  });

  // Touch swipe
  (function setupSwipe() {
    const stage = $('#cardStage');
    let sx = 0, sy = 0, tracking = false, horizontal = null;
    stage.addEventListener('touchstart', e => {
      if (e.touches.length !== 1) return;
      sx = e.touches[0].clientX; sy = e.touches[0].clientY;
      tracking = true; horizontal = null;
    }, { passive: true });
    stage.addEventListener('touchmove', e => {
      if (!tracking) return;
      const dx = e.touches[0].clientX - sx, dy = e.touches[0].clientY - sy;
      if (horizontal === null && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) horizontal = Math.abs(dx) > Math.abs(dy);
      if (horizontal) dragEl.style.transform = `translateX(${dx}px) rotate(${dx / 30}deg)`;
    }, { passive: true });
    const end = e => {
      if (!tracking) return;
      tracking = false;
      dragEl.style.transform = '';
      const t = e.changedTouches && e.changedTouches[0];
      if (!t || !horizontal) return;
      const dx = t.clientX - sx;
      if (Math.abs(dx) > 60) {
        suppressClick = true;
        setTimeout(() => { suppressClick = false; }, 400);
        step(dx < 0 ? 1 : -1);
      }
    };
    stage.addEventListener('touchend', end);
    stage.addEventListener('touchcancel', () => { tracking = false; dragEl.style.transform = ''; });
  })();

  $('#btnPrev').onclick = () => step(-1);
  $('#btnNext').onclick = () => step(1);
  $('#btnAgain').onclick = markAgain;
  $('#btnKnow').onclick = markKnown;

  // ---------- Mode B: List ----------
  const listEl = $('#wordList');

  function renderList() {
    const words = deck.map(id => byId.get(id));
    $('#listCount').textContent = `共 ${words.length} 個單字`;
    listEl.classList.toggle('blind', state.blind);
    if (!words.length) {
      listEl.innerHTML = `<li class="empty">${emptyMessage()}</li>`;
      return;
    }
    listEl.innerHTML = words.map(w => `
      <li class="row${state.mastered.has(w.id) ? ' is-done' : ''}" data-id="${w.id}">
        <div class="row-main">
          <div class="row-kana" lang="ja">${esc(w.kana)}</div>
          <div class="row-sub">
            ${w.kanji ? `<span class="mask" lang="ja">${esc(w.kanji)}</span>` : ''}
            <span class="mask">${esc(w.romaji)}</span>
          </div>
          <div class="row-zh mask">${esc(w.zh)}</div>
        </div>
        ${starBtn(w)}
        <button type="button" class="speak-btn" data-act="speak" aria-label="播放 ${esc(w.kana)}">🔊</button>
      </li>`).join('');
  }

  listEl.addEventListener('click', e => {
    const row = e.target.closest('.row');
    if (!row) return;
    const w = byId.get(Number(row.dataset.id));
    const act = e.target.closest('[data-act]');
    if (act && act.dataset.act === 'speak') { TTS.speak(w.kana, act); return; }
    if (act && act.dataset.act === 'star') { toggleStar(w.id); return; }
    if (state.blind) row.classList.toggle('revealed');
    else TTS.speak(w.kana, row.querySelector('.speak-btn'));
  });

  // ---------- Mode C: Quiz ----------
  const quiz = { cur: null, answered: false, right: 0, total: 0, lastId: null };

  function pickDistractors(w, n) {
    const seen = new Set([w.zh]);
    const out = [];
    const sources = [shuffled(DATA.filter(x => x.categoryId === w.categoryId)), shuffled(DATA)];
    for (const src of sources) {
      for (const x of src) {
        if (out.length >= n) return out;
        if (x.id !== w.id && x.kana !== w.kana && !seen.has(x.zh)) { seen.add(x.zh); out.push(x); }
      }
    }
    return out;
  }

  function renderQuizScore() {
    const pct = quiz.total ? Math.round(quiz.right / quiz.total * 100) : 0;
    $('#quizScore').textContent = `答對 ${quiz.right} / ${quiz.total}` + (quiz.total ? `（${pct}%）` : '');
  }

  function renderQuizPrompt() {
    const p = $('#quizPrompt');
    const w = quiz.cur;
    if (!w) return;
    if (state.listenOnly && !quiz.answered) {
      p.className = 'quiz-prompt listen';
      p.textContent = '🎧 仔細聽，選出正確的意思';
    } else {
      p.className = 'quiz-prompt jp';
      p.style.setProperty('--kana-size', kanaSize(w.kana));
      p.innerHTML = quiz.answered ? markKana(w.kana) : esc(w.kana);
    }
  }

  function newQuestion(speak) {
    const pool = filtered();
    const fb = $('#quizFeedback');
    fb.hidden = true;
    $('#quizNext').hidden = true;
    if (!pool.length) {
      quiz.cur = null;
      $('#quizPrompt').className = 'quiz-prompt listen';
      $('#quizPrompt').innerHTML = emptyMessage();
      $('#quizOptions').innerHTML = '';
      $('#quizPlay').hidden = true;
      return;
    }
    $('#quizPlay').hidden = false;
    let w = pool[Math.floor(Math.random() * pool.length)];
    if (pool.length > 1) while (w.id === quiz.lastId) w = pool[Math.floor(Math.random() * pool.length)];
    quiz.cur = w;
    quiz.lastId = w.id;
    quiz.answered = false;
    const opts = shuffled([w].concat(pickDistractors(w, 3)));
    $('#quizOptions').innerHTML = opts.map(o =>
      `<button type="button" class="opt" data-id="${o.id}">${esc(o.zh)}</button>`).join('');
    renderQuizPrompt();
    if (speak !== false) TTS.speak(w.kana, $('#quizPlay'));
  }

  function answer(btn) {
    if (quiz.answered || !quiz.cur) return;
    const w = quiz.cur;
    const ok = Number(btn.dataset.id) === w.id;
    quiz.answered = true;
    quiz.total++;
    if (ok) quiz.right++;
    document.querySelectorAll('#quizOptions .opt').forEach(b => {
      b.disabled = true;
      if (Number(b.dataset.id) === w.id) b.classList.add('correct');
    });
    if (!ok) btn.classList.add('wrong');
    renderQuizScore();
    renderQuizPrompt();

    const fb = $('#quizFeedback');
    const starred = state.starred.has(w.id);
    const wordLine = `<div class="fb-word" lang="ja">${markKana(w.kana)}${w.kanji ? `<span class="muted">（${esc(w.kanji)}）</span>` : ''}</div>
      <div>${esc(w.romaji)} — <b>${esc(w.zh)}</b></div>`;
    fb.className = 'quiz-feedback ' + (ok ? 'ok' : 'ng');
    fb.innerHTML = ok
      ? `<div class="fb-title">⭕ 正確！</div>${wordLine}`
      : `<div class="fb-title">❌ 答錯了</div>${wordLine}
         <div style="margin-top:6px">💡 發音重點：${markKana(w.note)}</div>
         <div class="fb-actions">
           <button type="button" class="small-btn" data-star="${w.id}" aria-pressed="${starred}">${starred ? '⭐ 已加入收藏' : '☆ 加入收藏'}</button>
           <button type="button" class="small-btn" data-act="replay">🔊 再聽一次</button>
         </div>`;
    fb.hidden = false;
    $('#quizNext').hidden = false;
    if (state.listenOnly || !ok) TTS.speak(w.kana);
  }

  $('#quizOptions').addEventListener('click', e => {
    const b = e.target.closest('.opt');
    if (b) answer(b);
  });
  $('#quizFeedback').addEventListener('click', e => {
    const s = e.target.closest('[data-star]');
    if (s) { toggleStar(Number(s.dataset.star)); return; }
    if (e.target.closest('[data-act="replay"]') && quiz.cur) TTS.speak(quiz.cur.kana);
  });
  $('#quizPlay').onclick = e => { if (quiz.cur) TTS.speak(quiz.cur.kana, e.currentTarget); };
  $('#quizNext').onclick = () => newQuestion();

  // ---------- Mode switching ----------
  function setMode(mode, fromUser) {
    state.mode = mode;
    saveState();
    document.querySelectorAll('.tabbar [data-mode]').forEach(b =>
      b.setAttribute('aria-selected', String(b.dataset.mode === mode)));
    $('#view-card').hidden = mode !== 'card';
    $('#view-list').hidden = mode !== 'list';
    $('#view-quiz').hidden = mode !== 'quiz';
    if (mode === 'card') renderCard();
    if (mode === 'list') renderList();
    if (mode === 'quiz') { renderQuizScore(); if (!quiz.cur || quiz.answered) newQuestion(!!fromUser); else renderQuizPrompt(); }
  }

  // Re-render whatever depends on the filtered set.
  function onFilterChange() {
    rebuildDeck();
    renderCats();
    renderStatus();
    if (state.mode === 'card') renderCard();
    if (state.mode === 'list') renderList();
    if (state.mode === 'quiz') newQuestion(false);
  }

  // ---------- Wiring ----------
  $('#catBar').addEventListener('click', e => {
    const b = e.target.closest('[data-cat]');
    if (!b) return;
    state.cat = Number(b.dataset.cat);
    saveState();
    onFilterChange();
  });

  $('#statusBar').addEventListener('click', e => {
    const b = e.target.closest('[data-status]');
    if (!b) return;
    state.status = b.dataset.status;
    saveState();
    onFilterChange();
  });

  let searchTimer;
  $('#search').addEventListener('input', e => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.query = e.target.value.trim(); onFilterChange(); }, 150);
  });

  document.querySelectorAll('[data-rate]').forEach(b => b.addEventListener('click', () => {
    state.rate = Number(b.dataset.rate);
    saveState();
    renderTopControls();
    toast(state.rate < 1 ? '🐢 慢速 0.7x：適合聽清濁音與促音' : '正常語速 1.0x');
    if (state.mode === 'card') speakCurrent();
  }));

  $('#shuffleBtn').onclick = () => {
    state.shuffle = !state.shuffle;
    saveState();
    renderTopControls();
    onFilterChange();
    toast(state.shuffle ? '🔀 已亂序：打破 50 音順序' : '已恢復編號順序');
  };

  $('#optKanji').onchange = e => { state.showKanji = e.target.checked; saveState(); renderCard(); };
  $('#optRomaji').onchange = e => { state.showRomaji = e.target.checked; saveState(); renderCard(); };
  $('#optAuto').onchange = e => { state.autoSpeak = e.target.checked; saveState(); };
  $('#optBlind').onchange = e => { state.blind = e.target.checked; saveState(); renderList(); };
  $('#optListen').onchange = e => { state.listenOnly = e.target.checked; saveState(); renderQuizPrompt(); };

  document.querySelectorAll('.tabbar [data-mode]').forEach(b =>
    b.addEventListener('click', () => { setMode(b.dataset.mode, true); window.scrollTo({ top: 0 }); }));

  // Cheat sheet dialog
  const dlg = $('#cheatDialog');
  $('#cheatBtn').onclick = () => {
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
  };
  const closeDlg = () => { if (typeof dlg.close === 'function') dlg.close(); else dlg.removeAttribute('open'); };
  $('#cheatClose').onclick = closeDlg;
  dlg.addEventListener('click', e => { if (e.target === dlg) closeDlg(); }); // backdrop tap

  // Reset progress
  $('#resetBtn').onclick = () => {
    if (!window.confirm('確定要重置學習進度嗎？\n「已熟記」與「⭐ 收藏」清單都會被清空，無法復原。')) return;
    state.mastered.clear();
    state.starred.clear();
    quiz.right = quiz.total = 0;
    saveState();
    renderProgress();
    renderQuizScore();
    onFilterChange();
    toast('已重置學習進度');
  };

  // Keyboard shortcuts (desktop)
  document.addEventListener('keydown', e => {
    if (state.mode !== 'card' || dlg.open) return;
    if (e.target.closest('input, textarea, select')) return;
    if (e.key === 'ArrowRight') step(1);
    else if (e.key === 'ArrowLeft') step(-1);
    else if ((e.key === ' ' || e.key === 'Enter') && !e.target.closest('button, label')) { e.preventDefault(); flip(); }
    else if (e.key.toLowerCase() === 'p') speakCurrent();
  });

  // ---------- Boot ----------
  TTS.init();
  renderTopControls();
  renderProgress();
  rebuildDeck();
  renderCats();
  renderStatus();
  setMode(state.mode, false);
})();
