/**
 * Setup-check banner for the dashboard pages.
 * Call mvSetupCheck(authFetch) after sign-in; it fills <div id="setup-check">.
 * Red = sales will be missing from the ad results. Yellow = could not check.
 */
(function () {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const css = `
#setup-check{margin:0 0 1rem;font-size:15px}
#setup-check .sc-box{border-radius:8px;padding:.7rem .9rem}
#setup-check .sc-red{background:#fef2f2;border:1px solid #ef4444;color:#7f1d1d}
#setup-check .sc-yellow{background:#fffbeb;border:1px solid #f59e0b;color:#78350f}
#setup-check .sc-ok{background:#f0fdf4;border:1px solid #22c55e;color:#14532d;padding:.4rem .9rem}
#setup-check ul{margin:.4rem 0 0 1.1rem;padding:0}
#setup-check li{margin:.25rem 0}
#setup-check .sc-where{display:block;font-size:13px;opacity:.8;word-break:break-word}
#setup-check button{margin-left:.6rem;font-size:13px;padding:.15rem .5rem;cursor:pointer}
@media (prefers-color-scheme: dark){
  #setup-check .sc-red{background:#3b1414;color:#fecaca}
  #setup-check .sc-yellow{background:#3a2a0a;color:#fde68a}
  #setup-check .sc-ok{background:#0f2a18;color:#bbf7d0}
}`;
  function render(el, data, fetchFn) {
    const probs = data?.problems || [];
    const red = probs.filter((p) => p.level === 'red');
    const yellow = probs.filter((p) => p.level !== 'red');
    const when = data?.checkedAt ? new Date(data.checkedAt).toLocaleString() : '';
    const btn = '<button type="button" id="sc-run">Check now</button>';
    const list = (arr) => '<ul>' + arr.map((p) => `<li>${esc(p.what)}${p.where ? `<span class="sc-where">${esc(p.where)}</span>` : ''}</li>`).join('') + '</ul>';
    let html = '';
    if (red.length) {
      html += `<div class="sc-box sc-red"><strong>⚠ Tracking problem: ${red.length} thing${red.length === 1 ? '' : 's'} to fix</strong> · checked ${esc(when)}${btn}${list(red)}</div>`;
    }
    if (yellow.length) {
      html += `<div class="sc-box sc-yellow" style="margin-top:${red.length ? '.5rem' : '0'}"><strong>Could not check ${yellow.length} thing${yellow.length === 1 ? '' : 's'}</strong>${red.length ? '' : ' · checked ' + esc(when) + btn}${list(yellow)}</div>`;
    }
    if (!html) {
      const n = (data?.ads || []).length, pg = (data?.pages || []).filter((p) => !p.skipped).length;
      html = `<div class="sc-box sc-ok">✓ Tracking OK: ${n} active ad${n === 1 ? '' : 's'} and ${pg} sales page${pg === 1 ? '' : 's'} are tagged · checked ${esc(when)}${btn}</div>`;
    }
    el.innerHTML = html;
    const b = document.getElementById('sc-run');
    if (b) b.addEventListener('click', () => load(el, fetchFn, true));
  }
  async function load(el, fetchFn, fresh) {
    const b = document.getElementById('sc-run');
    if (b) { b.disabled = true; b.textContent = 'Checking…'; }
    try {
      const res = await fetchFn('/api/setup-check' + (fresh ? '?fresh=1' : ''));
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.status);
      render(el, data, fetchFn);
    } catch (err) {
      el.innerHTML = `<div class="sc-box sc-yellow">Setup check could not run: ${esc(err.message)}</div>`;
    }
  }
  window.mvSetupCheck = function (fetchFn) {
    const el = document.getElementById('setup-check');
    if (!el) return;
    if (!document.getElementById('sc-style')) {
      const st = document.createElement('style'); st.id = 'sc-style'; st.textContent = css; document.head.appendChild(st);
    }
    load(el, fetchFn, false);
  };
})();
