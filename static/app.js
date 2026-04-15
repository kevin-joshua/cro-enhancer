document.addEventListener('DOMContentLoaded', () => {

  // ── Elements ────────────────────────────────────────────────────────────────
  const adTextInput      = document.getElementById('adText');
  const adImageInput     = document.getElementById('adImage');
  const dropZone         = document.getElementById('dropZone');
  const imageFileName    = document.getElementById('imageFileName');
  const clearImageBtn    = document.getElementById('clearImageBtn');

  const lpUrlInput       = document.getElementById('lpUrl');
  const fetchHtmlBtn     = document.getElementById('fetchHtmlBtn');
  const fetchStatus      = document.getElementById('fetchStatus');
  const lpHtmlInput      = document.getElementById('lpHtml');

  const analyzeBtn       = document.getElementById('analyzeBtn');
  const optimizeBtn      = document.getElementById('optimizeBtn');
  const errorMsg         = document.getElementById('errorMsg');

  const tabBtns          = document.querySelectorAll('.tab-btn');
  const tabContents      = document.querySelectorAll('.tab-content');
  const emptyState       = document.getElementById('emptyState');
  const loadingOverlay   = document.getElementById('loadingOverlay');
  const loadingTitle     = document.getElementById('loadingTitle');
  const progressLog      = document.getElementById('progressLog');

  const previewFrame     = document.getElementById('previewFrame');

  const elementsList     = document.getElementById('elementsList');
  const analysisSection  = document.getElementById('analysisSection');
  const analysisHeadline = document.getElementById('analysisHeadline');
  const analysisAudience = document.getElementById('analysisAudience');
  const analysisOffer    = document.getElementById('analysisOffer');
  const analysisTone     = document.getElementById('analysisTone');
  const analysisPain     = document.getElementById('analysisPain');
  const changesList      = document.getElementById('changesList');
  const changeCountBadge = document.getElementById('changeCountBadge');

  const rawHtmlOutput    = document.getElementById('rawHtmlOutput');
  const copyCodeBtn      = document.getElementById('copyCodeBtn');

  // ── State ───────────────────────────────────────────────────────────────────
  let adImageBase64 = null;
  let currentBrief = null;
  let currentSuggestedElements = [];
  let currentHtmlInput = '';
  let currentAdText = '';

  // ── File Upload ─────────────────────────────────────────────────────────────
  adImageInput.addEventListener('change', handleFileSelect);

  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    if (e.dataTransfer.files?.[0]) {
      adImageInput.files = e.dataTransfer.files;
      handleFileSelect({ target: adImageInput });
    }
  });

  function handleFileSelect(e) {
    const file = e.target.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) return showError('Please select an image file.');
    if (file.size > 5 * 1024 * 1024) return showError('Image must be under 5MB.');

    const reader = new FileReader();
    reader.onload = (evt) => {
      adImageBase64 = evt.target.result;
      imageFileName.textContent = file.name;
      imageFileName.classList.remove('hidden');
      clearImageBtn.classList.remove('hidden');
      adTextInput.value = '';
      adTextInput.placeholder = 'Image uploaded — text input disabled';
      adTextInput.disabled = true;
    };
    reader.readAsDataURL(file);
  }

  clearImageBtn?.addEventListener('click', () => {
    adImageBase64 = null;
    adImageInput.value = '';
    imageFileName.classList.add('hidden');
    clearImageBtn.classList.add('hidden');
    adTextInput.disabled = false;
    adTextInput.placeholder = 'Paste the text of your ad here...';
  });

  adTextInput.addEventListener('input', () => {
    if (adTextInput.value.trim()) {
      adImageBase64 = null;
      adImageInput.value = '';
      imageFileName.classList.add('hidden');
      clearImageBtn?.classList.add('hidden');
    }
  });

  // ── URL Fetch ────────────────────────────────────────────────────────────────
  async function fetchHtml(url) {
    if (!url) return;
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      fetchStatus.textContent = 'URL must start with http:// or https://';
      fetchStatus.className = 'text-xs mt-1 text-amber-500';
      return;
    }

    fetchStatus.textContent = 'Fetching...';
    fetchStatus.className = 'text-xs mt-1 text-slate-500';
    fetchHtmlBtn.disabled = true;

    try {
      const res = await fetch('/api/fetch-html', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to fetch');

      lpHtmlInput.value = data.html;
      fetchStatus.textContent = data.cached ? 'Loaded from cache.' : 'HTML fetched successfully.';
      fetchStatus.className = 'text-xs mt-1 text-green-500';
    } catch (err) {
      fetchStatus.textContent = err.message;
      fetchStatus.className = 'text-xs mt-1 text-red-500';
    } finally {
      fetchHtmlBtn.disabled = false;
    }
  }

  let fetchDebounce;
  lpUrlInput.addEventListener('input', () => {
    clearTimeout(fetchDebounce);
    fetchDebounce = setTimeout(() => fetchHtml(lpUrlInput.value.trim()), 900);
  });

  fetchHtmlBtn.addEventListener('click', () => {
    clearTimeout(fetchDebounce);
    fetchHtml(lpUrlInput.value.trim());
  });

  // ── Tabs ─────────────────────────────────────────────────────────────────────
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      tabBtns.forEach(b => {
        b.classList.remove('active', 'border-indigo-500', 'text-indigo-600');
        b.classList.add('border-transparent', 'text-slate-500');
      });
      tabContents.forEach(c => c.classList.add('hidden'));
      btn.classList.add('active', 'border-indigo-500', 'text-indigo-600');
      btn.classList.remove('border-transparent', 'text-slate-500');
      document.getElementById(btn.dataset.target).classList.remove('hidden');

      // Clear the notification badge if they click the Change Log tab
      if (btn.dataset.target === 'log-tab' && !changeCountBadge.classList.contains('hidden')) {
        // Optionally, you can add a fade-out effect here, or just let it remain visible
        // as a persistent count. We'll leave it visible as a counter.
      }
    });
  });

  function showTabs() {
    emptyState.classList.add('hidden');
    tabBtns[0].click();
  }

  // ── Copy code ─────────────────────────────────────────────────────────────────
  copyCodeBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(rawHtmlOutput.value);
    } catch {
      rawHtmlOutput.select();
      document.execCommand('copy');
    }
    const orig = copyCodeBtn.innerHTML;
    copyCodeBtn.innerHTML = '<i class="fa-solid fa-check"></i> Copied!';
    copyCodeBtn.classList.replace('bg-slate-700', 'bg-green-600');
    setTimeout(() => {
      copyCodeBtn.innerHTML = orig;
      copyCodeBtn.classList.replace('bg-green-600', 'bg-slate-700');
    }, 2000);
  });

  // ── Loading state logic ───────────────────────────────────────────────────────
  function addLogMessage(msg, isSuccess = false) {
    const el = document.createElement('div');
    el.className = `flex items-start gap-2 animate-[fadeIn_0.3s_ease-out] ${isSuccess ? 'text-green-600 font-medium' : 'text-slate-600'}`;
    el.innerHTML = `
      <span class="text-slate-400 select-none opacity-50 shrink-0">&gt;</span>
      <span>${escapeHtml(msg)}</span>
    `;
    progressLog.appendChild(el);
    progressLog.scrollTop = progressLog.scrollHeight;
  }

  function clearLogs() {
    progressLog.innerHTML = '';
  }

  // ── Main Generate (Phase 1: Analyze) ────────────────────────────────────────
  analyzeBtn.addEventListener('click', async () => {
    currentAdText = adTextInput.value.trim();
    currentHtmlInput = lpHtmlInput.value.trim();
    const focusAreas = ['headline', 'subheadline', 'hero copy', 'body copy', 'benefits / features', 'CTA', 'offer', 'trust signals', 'faq', 'form labels', 'navigation', 'footer'];

    errorMsg.classList.add('hidden');

    if (!currentAdText && !adImageBase64) return showError('Provide ad text or upload an image.');
    if (!currentHtmlInput) return showError('Provide the landing page HTML.');

    analyzeBtn.disabled = true;
    analyzeBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Analyzing...';
    
    loadingTitle.textContent = 'Analyzing Context...';
    clearLogs();
    loadingOverlay.classList.remove('hidden');
    emptyState.classList.add('hidden');
    tabContents.forEach(c => c.classList.add('hidden'));

    try {
      addLogMessage('Generating CRO brief from ad creative...');
      
      // We simulate the sequence of backend events visually for the user
      // since true SSE/streaming requires a backend rewrite
      setTimeout(() => addLogMessage('Scraping landing page elements...'), 3500);
      setTimeout(() => addLogMessage('Filtering focus areas & matching patterns...'), 4500);
      setTimeout(() => addLogMessage('AI selecting the highest impact elements...'), 6000);
      
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adText: currentAdText, adImage: adImageBase64, landingPageHtml: currentHtmlInput, focusAreas })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Analysis failed.');

      currentBrief = data.analysis;
      currentSuggestedElements = data.elements || [];
      
      renderAnalysis(data);
      renderElementsList();
      
      // Automatically switch to the elements tab
      const elementsTabBtn = Array.from(tabBtns).find(b => b.dataset.target === 'elements-tab');
      if (elementsTabBtn) elementsTabBtn.click();
      emptyState.classList.add('hidden');

    } catch (err) {
      showError(err.message);
      emptyState.classList.remove('hidden');
    } finally {
      analyzeBtn.disabled = false;
      analyzeBtn.innerHTML = '<i class="fa-solid fa-magnifying-glass"></i> Analyze Elements';
      loadingOverlay.classList.add('hidden');
    }
  });

  // ── Phase 2: Optimize Selected ────────────────────────────────────────────────
  optimizeBtn.addEventListener('click', async () => {
    // Get selected elements
    const selectedCheckboxes = document.querySelectorAll('.element-checkbox:checked');
    if (selectedCheckboxes.length === 0) {
      return showError('Select at least one element to rewrite.');
    }
    
    errorMsg.classList.add('hidden');

    const selectedIndices = Array.from(selectedCheckboxes).map(cb => parseInt(cb.value, 10));
    const selectedElements = currentSuggestedElements.filter((_, i) => selectedIndices.includes(i));

    optimizeBtn.disabled = true;
    optimizeBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Generating...';
    
    loadingTitle.textContent = 'Generating Rewrites...';
    clearLogs();
    loadingOverlay.classList.remove('hidden');

    try {
      addLogMessage(`Sending ${selectedElements.length} elements to Gemini...`);

      setTimeout(() => addLogMessage('Crafting cohesive messaging...'), 3000);
      setTimeout(() => addLogMessage('Applying changes to HTML...'), 6000);

      const res = await fetch('/api/rewrite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          adText: currentAdText,
          adImage: adImageBase64,
          landingPageHtml: currentHtmlInput,
          croBrief: currentBrief,
          selectedElements
        })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Rewriting failed.');

      renderOutput(data);
      
      // Switch to preview tab
      const previewTabBtn = Array.from(tabBtns).find(b => b.dataset.target === 'preview-tab');
      if (previewTabBtn) previewTabBtn.click();

    } catch (err) {
      showError(err.message);
    } finally {
      optimizeBtn.disabled = false;
      optimizeBtn.innerHTML = '<i class="fa-solid fa-bolt"></i> Generate Rewrites';
      loadingOverlay.classList.add('hidden');
    }
  });

  // ── Render Analysis & Elements ────────────────────────────────────────────────
  function renderAnalysis(data) {
    if (data.analysis) {
      analysisSection.classList.remove('hidden');
      analysisHeadline.textContent = data.analysis.adHeadline || 'N/A';
      analysisAudience.textContent = data.analysis.audience || 'N/A';
      analysisOffer.textContent    = data.analysis.offer     || 'N/A';
      if (analysisTone) analysisTone.textContent = data.analysis.tone || 'N/A';
      if (analysisPain) analysisPain.textContent = data.analysis.painPoint || 'N/A';
    }
  }

  function renderElementsList() {
    elementsList.innerHTML = '';
    
    if (currentSuggestedElements.length === 0) {
      elementsList.innerHTML = '<p class="text-sm text-slate-500 italic">No elements were suggested for optimization. The page may already be well-aligned, or try selecting different focus areas.</p>';
      optimizeBtn.classList.add('hidden');
      return;
    }

    optimizeBtn.classList.remove('hidden');

    currentSuggestedElements.forEach((el, index) => {
      const div = document.createElement('div');
      div.className = 'border border-slate-200 rounded-lg p-4 flex gap-3 hover:bg-slate-50 transition-colors';
      
      div.innerHTML = `
        <div class="pt-1">
          <input type="checkbox" id="el-${index}" value="${index}" class="element-checkbox w-4 h-4 text-indigo-600 border-slate-300 rounded cursor-pointer" checked>
        </div>
        <div class="flex-1">
          <label for="el-${index}" class="cursor-pointer block">
            <div class="flex items-center gap-2 mb-1">
              <span class="text-xs font-semibold uppercase tracking-wider text-slate-500">${escapeHtml(el.type)}</span>
              <span class="text-[10px] font-mono bg-slate-100 text-slate-500 px-2 py-0.5 rounded">${escapeHtml(el.tag || el.selector)}</span>
            </div>
            <div class="text-sm text-slate-800 mb-2 font-medium">"${escapeHtml(el.currentText)}"</div>
            <div class="text-xs text-indigo-600 bg-indigo-50 px-2 py-1 rounded inline-block">
              <i class="fa-solid fa-robot mr-1"></i> ${escapeHtml(el.reason)}
            </div>
          </label>
        </div>
      `;
      elementsList.appendChild(div);
    });
  }

  // ── Render Output ─────────────────────────────────────────────────────────────
  function renderOutput(data) {
    if (data.html) {
      previewFrame.srcdoc = data.html;
      rawHtmlOutput.value = data.html;
    }

    changesList.innerHTML = '';
    
    // Reset badge
    changeCountBadge.classList.add('hidden');
    changeCountBadge.textContent = '0';

    if (data.message) {
      changesList.innerHTML = `<p class="text-sm text-slate-500 italic">${escapeHtml(data.message)}</p>`;
      return;
    }

    if (!data.changes || data.changes.length === 0) {
      changesList.innerHTML = '<p class="text-sm text-slate-500 italic">No changes were applied.</p>';
      return;
    }

    // Update badge
    changeCountBadge.textContent = data.changes.length.toString();
    changeCountBadge.classList.remove('hidden');

    data.changes.forEach(change => {
      const el = document.createElement('div');
      el.className = 'border border-slate-200 rounded-lg overflow-hidden';
      el.innerHTML = `
        <div class="bg-slate-50 px-4 py-2 border-b border-slate-200 flex justify-between items-center flex-wrap gap-2">
          <span class="text-xs font-mono text-slate-600">${escapeHtml(change.selector || change.element)}</span>
          <span class="text-xs text-indigo-600 bg-indigo-50 px-2 py-1 rounded-full">${escapeHtml(change.reason)}</span>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2">
          <div class="p-4 border-b md:border-b-0 md:border-r border-slate-200 bg-red-50/30">
            <div class="text-xs text-red-500 font-semibold mb-2 uppercase tracking-wider">Before</div>
            <div class="text-sm text-slate-600 line-through">${escapeHtml(change.before)}</div>
          </div>
          <div class="p-4 bg-green-50/30">
            <div class="text-xs text-green-600 font-semibold mb-2 uppercase tracking-wider">After</div>
            <div class="text-sm text-slate-800">${escapeHtml(change.after)}</div>
          </div>
        </div>
      `;
      changesList.appendChild(el);
    });
  }

  function showError(msg) {
    errorMsg.textContent = msg;
    errorMsg.classList.remove('hidden');
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
});