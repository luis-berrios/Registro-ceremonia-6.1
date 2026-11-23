/* ============================================================
   TELEPROMPTER - Lógica para el rol Maestro de Ceremonia
   Entrega 1: karaoke + voz + salvavidas + navegación táctil
   Sin expansión de {{...}} todavía (eso es Entrega 2)
   ============================================================ */

(function() {
  'use strict';

  // ---------- Estado ----------
  let palabras = [];
  let idxActual = 0;
  let modoEscucha = false;
  let recognition = null;
  let speedFactor = 1;
  let fontSize = 40;
  let modoEstricto = true;
  let eventosSinAvance = 0;
  const UMBRAL_SALVAVIDAS = 4;
  const VENTANA_SALVAVIDAS = 10;
  let autoScroll = true;
  let textoLibretoActual = '';
  let ceremoniaIniciada = false;

  // ---------- Elementos ----------
  const vista       = document.getElementById('vista-maestro');
  const toolbar     = document.getElementById('tp-toolbar');
  const reader      = document.getElementById('tp-reader');
  const script      = document.getElementById('tp-script');
  const statusEl    = document.getElementById('tp-status');
  const btnStart    = document.getElementById('tp-btn-start');
  const btnStop     = document.getElementById('tp-btn-stop');
  const btnPrev     = document.getElementById('tp-btn-prev');
  const btnNext     = document.getElementById('tp-btn-next');
  const btnIniciar  = document.getElementById('tp-btn-iniciar');
  const btnFull     = document.getElementById('tp-btn-full');
  const btnFontUp   = document.getElementById('tp-btn-font-up');
  const btnFontDown = document.getElementById('tp-btn-font-down');
  const speedInput  = document.getElementById('tp-speed');
  const modoCheck   = document.getElementById('tp-modo-estricto');
  const btnCargar   = document.getElementById('tp-btn-cargar');
  const inputFile   = document.getElementById('tp-file-input');

  if (!vista) return; // Si no existe la vista, no inicializar

  // ---------- Utilidades ----------
  const STOPWORDS = new Set(['eh','em','mm','uh','ah','y','o','a','de','la','el','en','un','una']);

  function normaliza(s) {
    return s.toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
      .replace(/[^a-z0-9ñ ]/g,'')
      .trim();
  }

  function levenshtein(a, b) {
    const m = a.length, n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        dp[i][j] = a[i-1] === b[j-1]
          ? dp[i-1][j-1]
          : 1 + Math.min(dp[i-1][j-1], dp[i-1][j], dp[i][j-1]);
      }
    }
    return dp[m][n];
  }

  function coincide(tok, ref) {
    if (tok === ref) return true;
    if (!tok || !ref) return false;
    const dist = levenshtein(tok, ref);
    if (ref.length <= 3) return dist === 0;
    if (ref.length <= 5) return dist <= 1;
    return dist <= 2;
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }

  // ---------- Construcción del texto ----------
  // Entrega 1: respetamos las marcas ((NO LEER: ...)) como bloques grises
  // que se saltan en el karaoke.
  function construirPalabras(texto) {
    const limpio = texto.replace(/\r\n/g, '\n').trim();
    palabras = [];

    // Separar el texto en segmentos: normales y NO LEER
    // Buscamos ((NO LEER: ... )) o ((NO LEER ... ))
    const regex = /\(\(\s*NO\s*LEER\s*:?\s*([\s\S]*?)\)\)/gi;
    let ultimoIndex = 0;
    let match;
    const segmentos = []; // {tipo: 'normal'|'noleer', texto}

    while ((match = regex.exec(limpio)) !== null) {
      if (match.index > ultimoIndex) {
        segmentos.push({ tipo: 'normal', texto: limpio.slice(ultimoIndex, match.index) });
      }
      segmentos.push({ tipo: 'noleer', texto: match[1].trim() });
      ultimoIndex = regex.lastIndex;
    }
    if (ultimoIndex < limpio.length) {
      segmentos.push({ tipo: 'normal', texto: limpio.slice(ultimoIndex) });
    }

    // Procesar cada segmento
    let primeraPalabra = true;
    for (const seg of segmentos) {
      if (seg.tipo === 'noleer') {
        // Bloque NO LEER: una sola "palabra" especial, no se lee
        palabras.push({
          texto: seg.texto,
          estado: 'noleer',
          saltoAntes: !primeraPalabra,
          esNoLeer: true
        });
        primeraPalabra = false;
        continue;
      }

      // Segmento normal: dividir por líneas para conservar saltos
      const lineas = seg.texto.split('\n');
      for (let l = 0; l < lineas.length; l++) {
        const palabrasLinea = lineas[l].trim().split(/\s+/).filter(Boolean);
        for (let w = 0; w < palabrasLinea.length; w++) {
          palabras.push({
            texto: palabrasLinea[w],
            estado: 'pendiente',
            saltoAntes: (w === 0 && !primeraPalabra) ? true : false,
            esNoLeer: false
          });
          primeraPalabra = false;
        }
      }
    }

    // Marcar estados iniciales
    idxActual = 0;
    // Avanzar al primer elemento que no sea NO LEER
    while (idxActual < palabras.length && palabras[idxActual].esNoLeer) idxActual++;
    for (let i = 0; i < palabras.length; i++) {
      if (palabras[i].esNoLeer) {
        palabras[i].estado = 'noleer';
      } else if (i < idxActual) {
        palabras[i].estado = 'leido';
      } else if (i === idxActual) {
        palabras[i].estado = 'actual';
      } else {
        palabras[i].estado = 'pendiente';
      }
    }
    eventosSinAvance = 0;
    render();
  }

  function render() {
    if (palabras.length === 0) {
      script.innerHTML = '<div style="color:#888;font-size:18px;">Carga un libreto con el botón 📂 Cargar libreto</div>';
      return;
    }
    const parts = [];
    for (let i = 0; i < palabras.length; i++) {
      const p = palabras[i];
      if (p.saltoAntes) parts.push('<span class="tp-linebreak"></span>');
      if (p.esNoLeer) {
        parts.push(`<span class="tp-noleer" data-i="${i}">${escapeHtml(p.texto)}</span>`);
      } else {
        parts.push(`<span class="${p.estado}" data-i="${i}">${escapeHtml(p.texto)}</span>`);
      }
    }
    script.innerHTML = parts.join(' ');
    requestAnimationFrame(() => {
      if (autoScroll) scrollAlActual(false);
    });
  }

  function scrollAlActual(suave = true) {
    const el = script.querySelector('.tp-actual');
    if (!el) return;
    const readerRect = reader.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const offsetDentro = elRect.top - readerRect.top + reader.scrollTop;
    const target = offsetDentro - (reader.clientHeight / 2) + (elRect.height / 2);
    reader.scrollTo({ top: target * speedFactor, behavior: suave ? 'smooth' : 'auto' });
  }

  let scrollTimeout = null;
  reader.addEventListener('scroll', () => {
    if (!autoScroll) {
      clearTimeout(scrollTimeout);
      scrollTimeout = setTimeout(() => { autoScroll = true; }, 2000);
    }
  });

  // ---------- Navegación ----------
  function esNoLeer(i) { return palabras[i] && palabras[i].esNoLeer; }

  function siguienteIdxNoNoLeer(desde) {
    let i = desde;
    while (i < palabras.length && esNoLeer(i)) i++;
    return i;
  }
  function anteriorIdxNoNoLeer(desde) {
    let i = desde;
    while (i >= 0 && esNoLeer(i)) i--;
    return i;
  }

  function irA(nuevoIdx, mantenerAutoScroll = true) {
    if (palabras.length === 0) return;
    nuevoIdx = Math.max(0, Math.min(palabras.length - 1, nuevoIdx));
    // Si cae en NO LEER, saltar al siguiente
    if (esNoLeer(nuevoIdx)) nuevoIdx = siguienteIdxNoNoLeer(nuevoIdx);
    if (nuevoIdx >= palabras.length) nuevoIdx = anteriorIdxNoNoLeer(palabras.length - 1);
    if (nuevoIdx < 0) return;

    for (let i = 0; i < palabras.length; i++) {
      if (palabras[i].esNoLeer) { palabras[i].estado = 'noleer'; continue; }
      palabras[i].estado = i < nuevoIdx ? 'leido'
                         : i === nuevoIdx ? 'actual'
                         : 'pendiente';
    }
    idxActual = nuevoIdx;
    eventosSinAvance = 0;
    autoScroll = mantenerAutoScroll;
    render();
  }

  function siguiente() {
    const idx = siguienteIdxNoNoLeer(idxActual + 1);
    if (idx < palabras.length) irA(idx);
  }
  function anterior() {
    const idx = anteriorIdxNoNoLeer(idxActual - 1);
    if (idx >= 0) irA(idx);
  }

  function avanzarKaraoke(nuevoIdxActual) {
    if (nuevoIdxActual <= idxActual) return;
    if (nuevoIdxActual >= palabras.length) { irA(anteriorIdxNoNoLeer(palabras.length - 1)); return; }
    irA(nuevoIdxActual);
  }

  // ---------- Tocar palabra/línea ----------
  script.addEventListener('click', (ev) => {
    const span = ev.target.closest('span[data-i]');
    if (!span) return;
    const i = parseInt(span.dataset.i);
    if (isNaN(i) || esNoLeer(i)) return;
    irA(i, true);
    setStatus('📍 Reposicionado');
  });

  // ---------- Modos de avance ----------
  function calcularAvanceEstricto(tokens) {
    if (tokens.length === 0) return -1;
    if (idxActual >= palabras.length - 1) return -1;
    const actualNorm = normaliza(palabras[idxActual].texto);
    for (let start = 0; start < Math.min(tokens.length, 3); start++) {
      const tok = tokens[start];
      if (STOPWORDS.has(tok) && tok.length <= 2) continue;
      if (coincide(tok, actualNorm)) {
        const sigLibreto = idxActual + 1 < palabras.length
          ? normaliza(palabras[idxActual + 1].texto) : null;
        const sigToken = tokens[start + 1];
        if (sigLibreto && sigToken && coincide(sigToken, sigLibreto)) {
          let avance = 1, j = start + 1, k = idxActual + 1;
          while (j < tokens.length && k < palabras.length
                 && !esNoLeer(k)
                 && coincide(tokens[j], normaliza(palabras[k].texto))) {
            avance++; j++; k++;
          }
          return idxActual + avance;
        }
        return idxActual + 1;
      }
      const sigLibreto = idxActual + 1 < palabras.length
        ? normaliza(palabras[idxActual + 1].texto) : null;
      if (sigLibreto && coincide(tok, sigLibreto)) {
        const sigToken = tokens[start + 1];
        const subLibreto = idxActual + 2 < palabras.length
          ? normaliza(palabras[idxActual + 2].texto) : null;
        if (sigToken && subLibreto && coincide(sigToken, subLibreto)) {
          return idxActual + 2;
        }
      }
    }
    return -1;
  }

  function calcularSalvavidas(tokens) {
    if (tokens.length === 0) return -1;
    const limite = Math.min(palabras.length, idxActual + VENTANA_SALVAVIDAS);
    for (let i = idxActual + 1; i < limite; i++) {
      if (esNoLeer(i)) continue;
      const refNorm = normaliza(palabras[i].texto);
      for (let t = 0; t < tokens.length; t++) {
        if (STOPWORDS.has(tokens[t]) && tokens[t].length <= 2) continue;
        if (!coincide(tokens[t], refNorm)) continue;
        const sigRef = i + 1 < palabras.length ? normaliza(palabras[i + 1].texto) : null;
        const sigTok = tokens[t + 1];
        if (sigRef && sigTok && coincide(sigTok, sigRef)) return i + 1;
      }
    }
    return -1;
  }

  function calcularAvanceTolerante(tokens) {
    if (tokens.length === 0) return -1;
    const limite = Math.min(palabras.length, idxActual + 10);
    let cursor = idxActual, ultimo = -1, confirmadas = 0;
    for (const tok of tokens) {
      if (STOPWORDS.has(tok) && tok.length <= 2) continue;
      let encontrado = -1;
      for (let i = cursor; i < limite; i++) {
        if (esNoLeer(i)) continue;
        if (coincide(tok, normaliza(palabras[i].texto))) { encontrado = i; break; }
      }
      if (encontrado !== -1) { ultimo = encontrado; cursor = encontrado + 1; confirmadas++; }
    }
    if (confirmadas < 2) return -1;
    return ultimo === -1 ? -1 : ultimo + 1;
  }

  // ---------- Reconocimiento de voz ----------
  function initRecognition() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      setStatus('Este navegador no soporta reconocimiento de voz. Usa Chrome/Edge.', 'err');
      return null;
    }
    const r = new SR();
    r.lang = 'es-CL';
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;

    r.onresult = (event) => {
      let texto = '';
      for (let i = 0; i < event.results.length; i++) {
        texto += ' ' + event.results[i][0].transcript;
      }
      const tokens = normaliza(texto).split(/\s+/).filter(Boolean);
      if (tokens.length === 0) return;
      const recientes = tokens.slice(-8);
      const idxAntes = idxActual;

      if (modoEstricto) {
        let proximo = calcularAvanceEstricto(recientes);
        if (proximo === -1) {
          eventosSinAvance++;
          if (eventosSinAvance >= UMBRAL_SALVAVIDAS) {
            proximo = calcularSalvavidas(recientes);
            if (proximo !== -1) { eventosSinAvance = 0; setStatus('🛟 Salvavidas', 'on'); }
          }
        } else { eventosSinAvance = 0; }
        if (proximo > idxActual) avanzarKaraoke(proximo);
      } else {
        const proximo = calcularAvanceTolerante(recientes);
        if (proximo > idxActual) avanzarKaraoke(proximo);
      }
      if (idxActual > idxAntes) eventosSinAvance = 0;
      if (idxActual === idxAntes) setStatus('🎙 ' + texto.slice(-45), 'on');
    };

    r.onerror = (e) => {
      setStatus('Error de voz: ' + e.error, 'err');
      if (e.error === 'not-allowed') { alert('Permiso de micrófono denegado.'); detener(); }
    };
    r.onend = () => { if (modoEscucha) { try { r.start(); } catch(_) {} } };
    return r;
  }

  function iniciar() {
    if (modoEscucha || palabras.length === 0) return;
    if (!recognition) recognition = initRecognition();
    if (!recognition) return;
    modoEscucha = true;
    eventosSinAvance = 0;
    autoScroll = true;
    try { recognition.start(); } catch(_) {}
    btnStart.disabled = true;
    btnStop.disabled = false;
    setStatus('🎙 Escuchando…', 'on');
  }

  function detener() {
    modoEscucha = false;
    if (recognition) { try { recognition.stop(); } catch(_) {} }
    btnStart.disabled = false;
    btnStop.disabled = true;
    setStatus('Detenido');
  }

  function setStatus(msg, cls = '') {
    if (!statusEl) return;
    statusEl.textContent = msg;
    statusEl.className = cls;
  }

  // ---------- Carga de libreto ----------
  function cargarTextoLibreto(texto, nombre) {
    textoLibretoActual = texto;
    construirPalabras(texto);
    // Guardar en Firebase para que el Maestro lo reciba
    if (window.firebase && window.database) {
      window.database.ref('libreto').set({
        texto: texto,
        nombreArchivo: nombre || 'libreto.txt',
        timestamp: Date.now()
      }).catch(err => console.error('Error guardando libreto:', err));
    }
    // Guardar en localStorage como respaldo
    try {
      localStorage.setItem('tp_libreto_texto', texto);
      localStorage.setItem('tp_libreto_nombre', nombre || '');
    } catch(_) {}
    setStatus('Libreto cargado: ' + (nombre || 'sin nombre'));
  }

  // ---------- Firebase: escuchar libreto ----------
  function escucharLibretoFirebase() {
    if (!window.firebase || !window.database) return;
    window.database.ref('libreto').on('value', (snap) => {
      const data = snap.val();
      if (data && data.texto && data.texto !== textoLibretoActual) {
        textoLibretoActual = data.texto;
        construirPalabras(data.texto);
        setStatus('Libreto actualizado desde Firebase');
      }
    });
  }

  // ---------- Botón Iniciar ceremonia ----------
  function actualizarBotonIniciar() {
    if (!btnIniciar) return;
    if (ceremoniaIniciada) {
      btnIniciar.textContent = '✅ Ceremonia iniciada';
      btnIniciar.classList.add('iniciada');
      btnIniciar.disabled = true;
    } else {
      btnIniciar.textContent = '▶ Iniciar ceremonia';
      btnIniciar.classList.remove('iniciada');
      btnIniciar.disabled = false;
    }
  }

  function iniciarCeremonia() {
    if (ceremoniaIniciada) return;
    if (!confirm('¿Marcar el inicio de la ceremonia?\nA partir de ahora, los estudiantes que lleguen se considerarán atrasados.')) return;
    ceremoniaIniciada = true;
    actualizarBotonIniciar();
    if (window.firebase && window.database) {
      window.database.ref('inicioCeremonia').set({
        modo: 'boton',
        iniciadaEn: Date.now()
      }).catch(err => console.error(err));
    }
    try { localStorage.setItem('tp_ceremonia_iniciada', '1'); } catch(_) {}
    setStatus('✅ Ceremonia iniciada a las ' + new Date().toLocaleTimeString('es-CL'));
  }

  // ---------- Mostrar/ocultar vista ----------
  function mostrarVista() {
    vista.classList.add('activa');
    // Cargar libreto desde localStorage o Firebase
    try {
      const texto = localStorage.getItem('tp_libreto_texto');
      const nombre = localStorage.getItem('tp_libreto_nombre');
      if (texto) {
        textoLibretoActual = texto;
        construirPalabras(texto);
      }
    } catch(_) {}
    try {
      if (localStorage.getItem('tp_ceremonia_iniciada') === '1') {
        ceremoniaIniciada = true;
        actualizarBotonIniciar();
      }
    } catch(_) {}
    escucharLibretoFirebase();
  }

  function ocultarVista() {
    vista.classList.remove('activa');
    detener();
  }

  // ---------- Event listeners ----------
  btnStart.onclick = iniciar;
  btnStop.onclick = detener;
  btnPrev.onclick = anterior;
  btnNext.onclick = siguiente;
  btnIniciar.onclick = iniciarCeremonia;

  btnFull.onclick = () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
    else document.exitFullscreen?.();
  };

  btnFontUp.onclick = () => {
    fontSize = Math.min(120, fontSize + 4);
    script.style.fontSize = fontSize + 'px';
    setTimeout(() => { if (autoScroll) scrollAlActual(false); }, 30);
  };
  btnFontDown.onclick = () => {
    fontSize = Math.max(16, fontSize - 4);
    script.style.fontSize = fontSize + 'px';
    setTimeout(() => { if (autoScroll) scrollAlActual(false); }, 30);
  };

  speedInput.oninput = (e) => { speedFactor = parseFloat(e.target.value); };
  modoCheck.onchange = (e) => {
    modoEstricto = e.target.checked;
    eventosSinAvance = 0;
    setStatus(modoEstricto ? 'Modo estricto' : 'Modo tolerante');
  };

  btnCargar.onclick = () => inputFile.click();

  inputFile.addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const nombre = f.name.toLowerCase();

    if (nombre.endsWith('.docx')) {
      if (typeof mammoth === 'undefined') {
        alert('Mammoth.js no cargado. Revisa la conexión.');
        return;
      }
      try {
        const arrayBuffer = await f.arrayBuffer();
        const result = await mammoth.convertToHtml({ arrayBuffer });
        const cont = document.createElement('div');
        cont.innerHTML = result.value || '';
        const lineas = [];
        Array.from(cont.children).forEach(el => {
          const tag = el.tagName.toLowerCase();
          if (tag === 'table') {
            el.querySelectorAll('tr').forEach(tr => {
              const celdas = Array.from(tr.querySelectorAll('th, td'))
                .map(c => (c.textContent || '').replace(/\s+/g,' ').trim())
                .filter(Boolean);
              if (celdas.length) lineas.push(celdas.join(' — '));
            });
            lineas.push('');
          } else if (tag === 'ul' || tag === 'ol') {
            el.querySelectorAll('li').forEach(li => {
              const t = (li.textContent || '').replace(/\s+/g,' ').trim();
              if (t) lineas.push(t);
            });
            lineas.push('');
          } else {
            const t = (el.textContent || '').replace(/\s+/g,' ').trim();
            if (t) { lineas.push(t); lineas.push(''); }
          }
        });
        const texto = lineas.join('\n').replace(/\n{3,}/g,'\n\n').trim();
        cargarTextoLibreto(texto, f.name);
      } catch (err) {
        console.error(err);
        alert('Error al leer .docx: ' + err.message);
      }
      return;
    }

    if (nombre.endsWith('.doc')) {
      alert('El formato .doc antiguo no es compatible. Guarda como .docx o .txt.');
      return;
    }

    const reader2 = new FileReader();
    reader2.onload = () => cargarTextoLibreto(reader2.result, f.name);
    reader2.readAsText(f, 'UTF-8');
  });

  document.addEventListener('keydown', (e) => {
    if (!vista.classList.contains('activa')) return;
    if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
    if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') {
      e.preventDefault(); siguiente();
    } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
      e.preventDefault(); anterior();
    } else if (e.key === 'Home') {
      e.preventDefault(); irA(0);
    } else if (e.key === 'End') {
      e.preventDefault(); irA(anteriorIdxNoNoLeer(palabras.length - 1));
    }
  });

  window.addEventListener('resize', () => { if (autoScroll) scrollAlActual(false); });

  // ---------- API pública para el Index.html ----------
  window.Teleprompter = {
    mostrar: mostrarVista,
    ocultar: ocultarVista,
    cargarTexto: cargarTextoLibreto
  };

})();