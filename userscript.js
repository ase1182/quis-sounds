// ==UserScript==
// @name         CPA Web Questions: 正解/不正解サウンド
// @namespace    https://cpa-web-questions.app/
// @version      1.8.0
// @description  正解時にピンポン音、不正解時にブッブー音を鳴らし、Spaceキーで次の問題へ進みます。
// @match        https://cpa-web-questions.app/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(() => {
  'use strict';

  // ▼ここに使いたい音源URLを設定（未設定ならWebAudioのビープ音を使用）
  const CORRECT_SOUND_URL = 'https://raw.githubusercontent.com/ase1182/quis-sounds/main/correct.mp3';
  const WRONG_SOUND_URL = 'https://raw.githubusercontent.com/ase1182/quis-sounds/main/wrong.mp3';

  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const ctx = AudioCtx ? new AudioCtx() : null;
  const DEBUG = false;

  let lastPlayedAt = 0;
  let pendingAnswer = null;
  let resolvedQuestionId = null;
  let lastNextAt = 0;
  let lastAnswerHotkeyAt = 0;
  const MARK_COMPARE_DELAY_MS = 1200;

  const correctAudio = CORRECT_SOUND_URL ? new Audio(CORRECT_SOUND_URL) : null;
  const wrongAudio = WRONG_SOUND_URL ? new Audio(WRONG_SOUND_URL) : null;
  if (correctAudio) correctAudio.preload = 'auto';
  if (wrongAudio) wrongAudio.preload = 'auto';

  function log(...args) {
    if (DEBUG) console.log('[CPA sound]', ...args);
  }

  function currentQuestionId() {
    const m = location.pathname.match(/\/question\/(\d+)/);
    return m ? m[1] : '';
  }

  function ensureUnlocked() {
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
  }

  function beep(freq, durationMs, type = 'sine', gainValue = 0.14, when = 0) {
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    osc.connect(gain);
    gain.connect(ctx.destination);
    const start = ctx.currentTime + when;
    const end = start + durationMs / 1000;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(gainValue, start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);
    osc.start(start);
    osc.stop(end + 0.02);
  }

  function playAudio(audio, onFail) {
    if (!audio) return false;
    try {
      audio.currentTime = 0;
      const maybePromise = audio.play();
      if (maybePromise && typeof maybePromise.catch === 'function') {
        maybePromise.catch(() => {
          if (onFail) onFail();
        });
      }
      return true;
    } catch (_) {
      if (onFail) onFail();
      return false;
    }
  }

  function fallbackCorrectBeep() {
    beep(1046, 130, 'sine', 0.13, 0);
    beep(1396, 170, 'sine', 0.13, 0.15);
  }

  function fallbackWrongBeep() {
    beep(220, 150, 'square', 0.14, 0);
    beep(175, 210, 'square', 0.14, 0.18);
  }

  function playCorrect() {
    if (playAudio(correctAudio, fallbackCorrectBeep)) return;
    fallbackCorrectBeep();
  }

  function playWrong() {
    if (playAudio(wrongAudio, fallbackWrongBeep)) return;
    fallbackWrongBeep();
  }

  function playOnce(state) {
    const now = Date.now();
    if (now - lastPlayedAt < 1200) return;
    ensureUnlocked();
    if (state === 'correct') playCorrect();
    if (state === 'wrong') playWrong();
    lastPlayedAt = now;
  }

  function normalizeMark(text) {
    const t = (text || '').replace(/\s+/g, '');
    if (/[〇○◯]/.test(t)) return 'o';
    if (/[✕✖×xX]/.test(t)) return 'x';
    return '';
  }

  function extractMarkFromElement(el) {
    if (!el) return '';
    const blob = [
      el.innerText,
      el.textContent,
      el.getAttribute?.('aria-label'),
      el.getAttribute?.('title'),
    ].filter(Boolean).join(' ');
    return normalizeMark(blob);
  }

  function isAnswerButton(el) {
    if (!el) return false;
    const mark = extractMarkFromElement(el);
    if (!mark) return false;

    const clickable = el.closest('button, [role="button"], label');
    if (!clickable) return false;

    const plain = ((clickable.innerText || clickable.textContent || '').replace(/\s+/g, ''));
    if (!/[〇○◯✕✖×xX]/.test(plain)) return false;

    const context = ((clickable.innerText) || '').trim();
    if (/次の問題|出題除外|分からないので答えを見る|過去問|管理会計論/.test(context)) return false;

    return true;
  }

  function findAnswerClickTarget(start) {
    let el = start;
    for (let i = 0; i < 6 && el; i += 1) {
      if (el.nodeType === 1 && isAnswerButton(el)) return el.closest('button, [role="button"], label') || el;
      el = el.parentElement;
    }
    return null;
  }

  function extractResultMarkFromNode(node) {
    if (!node) return '';
    if (node.nodeType === Node.TEXT_NODE) return normalizeMark(node.textContent || '');
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    return extractMarkFromElement(node);
  }

  function tryResolveFromMutation(mutations) {
    if (!pendingAnswer) return;
    const qid = currentQuestionId();
    if (!qid || qid !== pendingAnswer.questionId) return;
    if (resolvedQuestionId === qid) return;
    if (Date.now() - pendingAnswer.at > 8000) {
      pendingAnswer = null;
      return;
    }

    for (const mutation of mutations) {
      const candidates = [mutation.target, ...mutation.addedNodes];
      for (const n of candidates) {
        const txt = (n.textContent || '').trim();

        // 1) まず明示テキスト判定
        if (/不正解|incorrect/i.test(txt)) {
          playOnce('wrong');
          resolvedQuestionId = qid;
          pendingAnswer = null;
          return;
        }
        if (/正解|correct/i.test(txt)) {
          playOnce('correct');
          resolvedQuestionId = qid;
          pendingAnswer = null;
          return;
        }

        // 2) 押下直後は記号比較を遅延させ、まず明示テキスト判定を待つ（誤判定防止）
        if (Date.now() - pendingAnswer.at < MARK_COMPARE_DELAY_MS) continue;

        // 3) ユーザー要望: 押した記号と、回答後に下部に表示される記号を比較
        const nodeEl = n && n.nodeType === Node.ELEMENT_NODE ? n : n?.parentElement;
        const clickable = nodeEl?.closest?.('button, [role="button"], label');
        if (clickable && isAnswerButton(clickable)) continue;

        const displayedMark = extractResultMarkFromNode(n);
        if (!displayedMark || !pendingAnswer.selected) continue;

        const result = displayedMark === pendingAnswer.selected ? 'correct' : 'wrong';
        playOnce(result);
        resolvedQuestionId = qid;
        pendingAnswer = null;
        return;
      }
    }
  }

  function detectFlashVerdict() {
    const selectors = ['[role="alert"]', '[aria-live]', '.toast', '.snackbar', '.alert', '.notification', 'body'];
    for (const sel of selectors) {
      const nodes = sel === 'body' ? [document.body] : Array.from(document.querySelectorAll(sel));
      for (const n of nodes) {
        const t = (n?.innerText || n?.textContent || '').trim();
        if (!t) continue;
        if (/不正解|incorrect/i.test(t)) return 'wrong';
        if (/正解|correct/i.test(t)) return 'correct';
      }
    }
    return '';
  }

  function startFlashVerdictWatch() {
    if (!pendingAnswer) return;
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      if (!pendingAnswer || tries > 25) {
        clearInterval(timer);
        return;
      }
      const verdict = detectFlashVerdict();
      if (verdict) {
        playOnce(verdict);
        resolvedQuestionId = pendingAnswer.questionId;
        pendingAnswer = null;
        clearInterval(timer);
      }
    }, 80);
  }

  function findNextQuestionButton() {
    const labels = ['次の問題', '次へ', 'next'];
    const candidates = Array.from(document.querySelectorAll('button, [role="button"], a, input[type="button"], input[type="submit"]'));
    for (const el of candidates) {
      const text = ((el.innerText || el.textContent || el.value || '') + '').trim();
      if (!text) continue;
      if (labels.some((label) => text.includes(label))) return el;
    }
    return null;
  }


  function isVisible(el) {
    if (!el || !(el instanceof Element)) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) return false;
    return rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
  }

  function findAnswerButtonByMark(mark) {
    const selectors = 'button, [role="button"], label, [tabindex]';
    const candidates = Array.from(document.querySelectorAll(selectors));

    // 1) 既存ロジックで見つかる場合を優先
    for (const el of candidates) {
      if (!isAnswerButton(el)) continue;
      if (extractMarkFromElement(el) !== mark) continue;
      return el.closest('button, [role="button"], label, [tabindex]') || el;
    }

    // 2) テキストが取りづらいUI向け: 「分からないので答えを見る」と同じ行の左側ボタン群を探索
    const revealBtn = candidates.find((el) => /分からないので答えを見る/.test((el.innerText || el.textContent || '').trim()));
    if (revealBtn) {
      const row = revealBtn.closest('div, section, article') || revealBtn.parentElement || document.body;
      const rowButtons = Array.from(row.querySelectorAll('button, [role="button"], [tabindex]')).filter(isVisible);

      // 記号が取れる場合
      for (const el of rowButtons) {
        const detected = extractMarkFromElement(el);
        if (detected === mark) return el;
      }

      // 記号が取れない場合: revealボタンより左にある小〜中サイズのボタンを左→右順に採用
      const revealRect = revealBtn.getBoundingClientRect();
      const leftButtons = rowButtons
        .filter((el) => {
          if (el === revealBtn) return false;
          const r = el.getBoundingClientRect();
          if (r.right >= revealRect.left) return false;
          if (r.width > 220 || r.height > 120) return false;
          return true;
        })
        .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);

      if (leftButtons.length >= 2) {
        return mark === 'o' ? leftButtons[0] : leftButtons[1];
      }
      if (leftButtons.length === 1) {
        return leftButtons[0];
      }
    }

    return null;
  }

  function triggerAnswerByMark(mark) {
    const qid = currentQuestionId();
    if (!qid) return false;

    const btn = findAnswerButtonByMark(mark);
    if (!btn) return false;

    pendingAnswer = { questionId: qid, selected: mark, at: Date.now() };
    btn.click();
    startFlashVerdictWatch();
    return true;
  }

  function shouldIgnoreKeydown(event) {
    if (event.defaultPrevented || event.repeat || event.isComposing) return true;
    const target = event.target;
    if (!target || !(target instanceof Element)) return false;
    if (target.closest('input, textarea, [contenteditable="true"], [role="textbox"]')) return true;
    return false;
  }

  function tryGoNextQuestionByShortcut(event) {
    if (event.code !== 'Space' && event.key !== ' ') return;
    if (shouldIgnoreKeydown(event)) return;

    const now = Date.now();
    if (now - lastNextAt < 400) return;

    const nextBtn = findNextQuestionButton();
    if (!nextBtn) return;

    event.preventDefault();
    event.stopPropagation();
    ensureUnlocked();
    nextBtn.click();
    lastNextAt = now;
    log('next question via Space key');
  }

  function tryAnswerByHotkey(event) {
    const key = (event.key || '').toLowerCase();
    if (key !== 'f' && key !== 'j') return false;
    if (shouldIgnoreKeydown(event)) return true;

    const now = Date.now();
    if (now - lastAnswerHotkeyAt < 250) return true;

    const mark = key === 'f' ? 'o' : 'x';
    const clicked = triggerAnswerByMark(mark);
    if (!clicked) return true;

    event.preventDefault();
    event.stopPropagation();
    ensureUnlocked();
    lastAnswerHotkeyAt = now;
    log('answer by hotkey', key, mark);
    return true;
  }

  function handleKeydown(event) {
    if (tryAnswerByHotkey(event)) return;
    tryGoNextQuestionByShortcut(event);
  }

  function installClickWatcher() {
    document.addEventListener('click', (event) => {
      ensureUnlocked();
      const target = findAnswerClickTarget(event.target);
      if (!target) return;
      const selected = extractMarkFromElement(target);
      if (!selected) return;
      const qid = currentQuestionId();
      if (!qid) return;
      pendingAnswer = { questionId: qid, selected, at: Date.now() };
      log('answer clicked', pendingAnswer);
      // startFlashVerdictWatch(); // 判定テキストの誤検知対策で無効化
    }, true);
  }

  function installMutationWatcher() {
    const observer = new MutationObserver((mutations) => {
      tryResolveFromMutation(mutations);
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'aria-label'],
    });
  }

  function installGlobalVerdictWatcher() {
    const observer = new MutationObserver((mutations) => {
      if (!pendingAnswer) return;
      const qid = currentQuestionId();
      if (!qid || qid !== pendingAnswer.questionId) return;
      if (resolvedQuestionId === qid) return;

      for (const mutation of mutations) {
        const nodes = [mutation.target, ...mutation.addedNodes];
        for (const n of nodes) {
          const t = (n?.textContent || '').trim();
          if (!t) continue;
          if (/^不正解$/.test(t) || /\bincorrect\b/i.test(t)) {
            playOnce('wrong');
            resolvedQuestionId = qid;
            pendingAnswer = null;
            return;
          }
          if (/^正解$/.test(t) || /\bcorrect\b/i.test(t)) {
            playOnce('correct');
            resolvedQuestionId = qid;
            pendingAnswer = null;
            return;
          }
        }
      }
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  function installWhenReady() {
    const start = () => {
      if (!document.documentElement || !document.body) return setTimeout(start, 50);
      installClickWatcher();
      installMutationWatcher();
      // installGlobalVerdictWatcher(); // 誤検知が多いため無効化
      window.addEventListener('keydown', handleKeydown, true);
      log('watchers installed');
    };
    start();
  }

  ['pointerdown', 'keydown', 'touchstart', 'click'].forEach((eventName) => {
    window.addEventListener(eventName, ensureUnlocked, { passive: true });
  });

  installWhenReady();
})();
